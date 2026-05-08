/**
 * Integration tests for `github-credentials-injector.ts`.
 *
 * Covers inject/remove paths plus the writeFile fail-closed guard. Mocks
 * the Sandbox interface — no DB or network.
 *
 * IT-IDs: IT-1860 to IT-1879
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubCredentialsInjector,
  GitHubCredentialsInjector,
} from '../../src/lib/sandbox/github-credentials-injector';

interface ExecCall {
  cmd: string;
  args: string[];
}

interface WriteCall {
  path: string;
  content: string | Buffer;
  mode?: number;
}

function createMockSandbox(opts?: {
  hasWriteFile?: boolean;
  writeFileThrows?: Error;
  mkdirExitCode?: number;
  configExitCode?: number;
  rmThrows?: Error;
  execThrows?: Error;
}) {
  const execCalls: ExecCall[] = [];
  const writeCalls: WriteCall[] = [];
  const sandbox: Record<string, unknown> = {
    id: 'sandbox-1',
    exec: vi.fn(async (cmd: string, args: string[] = []) => {
      execCalls.push({ cmd, args });
      if (opts?.execThrows) throw opts.execThrows;
      if (cmd === 'mkdir') {
        return {
          exitCode: opts?.mkdirExitCode ?? 0,
          stdout: '',
          stderr: opts?.mkdirExitCode !== 0 ? 'permission denied' : '',
        };
      }
      if (cmd === 'git') {
        return {
          exitCode: opts?.configExitCode ?? 0,
          stdout: '',
          stderr: opts?.configExitCode !== 0 ? 'gitconfig locked' : '',
        };
      }
      if (cmd === 'rm') {
        if (opts?.rmThrows) throw opts.rmThrows;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    writeFile:
      opts?.hasWriteFile === false
        ? undefined
        : vi.fn(async (path: string, content: string | Buffer, mode?: number) => {
            writeCalls.push({ path, content, mode });
            if (opts?.writeFileThrows) throw opts.writeFileThrows;
          }),
    execCalls,
    writeCalls,
  };
  return sandbox;
}

describe('GitHubCredentialsInjector.inject', () => {
  it('IT-1860: writes git-credentials and gh hosts.yml on success', async () => {
    const sandbox = createMockSandbox();
    const result = await new GitHubCredentialsInjector().inject(sandbox as never, {
      token: 'ghp_test',
      githubLogin: 'octocat',
    });
    expect(result.ok).toBe(true);

    const writeCalls = sandbox.writeCalls as WriteCall[];
    const credentialsCall = writeCalls.find((c) => c.path.endsWith('.git-credentials'));
    const hostsCall = writeCalls.find((c) => c.path.endsWith('hosts.yml'));
    expect(credentialsCall).toBeDefined();
    expect(hostsCall).toBeDefined();
    expect(credentialsCall!.mode).toBe(0o600);
    expect(hostsCall!.mode).toBe(0o600);
    expect(credentialsCall!.content).toContain('https://x-access-token:ghp_test@github.com');
    expect(hostsCall!.content).toContain('user: octocat');
    expect(hostsCall!.content).toContain('oauth_token: ghp_test');
  });

  it('IT-1861: defaults login to x-access-token when not provided', async () => {
    const sandbox = createMockSandbox();
    await new GitHubCredentialsInjector().inject(sandbox as never, { token: 'ghp_test' });
    const writeCalls = sandbox.writeCalls as WriteCall[];
    const hostsCall = writeCalls.find((c) => c.path.endsWith('hosts.yml'));
    expect(hostsCall!.content).toContain('user: x-access-token');
  });

  it('IT-1862: defaults login to x-access-token when login is empty/whitespace', async () => {
    const sandbox = createMockSandbox();
    await new GitHubCredentialsInjector().inject(sandbox as never, {
      token: 'ghp_test',
      githubLogin: '   ',
    });
    const writeCalls = sandbox.writeCalls as WriteCall[];
    const hostsCall = writeCalls.find((c) => c.path.endsWith('hosts.yml'));
    expect(hostsCall!.content).toContain('user: x-access-token');
  });

  it('IT-1863: configures git credential.helper=store after writing files', async () => {
    const sandbox = createMockSandbox();
    await new GitHubCredentialsInjector().inject(sandbox as never, { token: 'ghp_test' });
    const execCalls = sandbox.execCalls as ExecCall[];
    const gitConfig = execCalls.find((c) => c.cmd === 'git');
    expect(gitConfig).toBeDefined();
    expect(gitConfig!.args).toEqual(['config', '--global', 'credential.helper', 'store']);
  });

  it('IT-1864: fails closed when sandbox.writeFile is undefined', async () => {
    const sandbox = createMockSandbox({ hasWriteFile: false });
    const result = await new GitHubCredentialsInjector().inject(sandbox as never, {
      token: 'ghp_test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SANDBOX_CREDENTIALS_INJECTION_FAILED');
      expect(result.error.message).toContain('refusing to inject GitHub credentials via shell');
    }
  });

  it('IT-1865: returns CREDENTIALS_INJECTION_FAILED when mkdir fails', async () => {
    const sandbox = createMockSandbox({ mkdirExitCode: 1 });
    const result = await new GitHubCredentialsInjector().inject(sandbox as never, {
      token: 'ghp_test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Failed to create');
  });

  it('IT-1866: returns CREDENTIALS_INJECTION_FAILED when writeFile throws on git-credentials', async () => {
    const sandbox = createMockSandbox({ writeFileThrows: new Error('disk full') });
    const result = await new GitHubCredentialsInjector().inject(sandbox as never, {
      token: 'ghp_test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/Failed to write ~\/\.git-credentials/);
  });

  it('IT-1867: returns CREDENTIALS_INJECTION_FAILED when writeFile throws on hosts.yml', async () => {
    let count = 0;
    const sandbox: Record<string, unknown> = {
      id: 'sandbox-1',
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      writeFile: vi.fn(async () => {
        count++;
        if (count === 2) throw new Error('quota exceeded');
      }),
    };
    const result = await new GitHubCredentialsInjector().inject(sandbox as never, {
      token: 'ghp_test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toMatch(/Failed to write ~\/\.config\/gh\/hosts\.yml/);
  });

  it('IT-1868: returns CREDENTIALS_INJECTION_FAILED when git config exits non-zero', async () => {
    const sandbox = createMockSandbox({ configExitCode: 1 });
    const result = await new GitHubCredentialsInjector().inject(sandbox as never, {
      token: 'ghp_test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('credential.helper');
  });

  it('IT-1869: catches unexpected exceptions and surfaces them as injection failures', async () => {
    const sandbox: Record<string, unknown> = {
      id: 'sandbox-1',
      exec: vi.fn(async () => {
        throw new Error('socket lost');
      }),
      writeFile: vi.fn(async () => {}),
    };
    const result = await new GitHubCredentialsInjector().inject(sandbox as never, {
      token: 'ghp_test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('socket lost');
  });
});

describe('GitHubCredentialsInjector.remove', () => {
  it('IT-1870: rm -f against both credential files', async () => {
    const sandbox = createMockSandbox();
    const result = await new GitHubCredentialsInjector().remove(sandbox as never);
    expect(result.ok).toBe(true);
    const execCalls = sandbox.execCalls as ExecCall[];
    const rm = execCalls.find((c) => c.cmd === 'rm');
    expect(rm).toBeDefined();
    expect(rm!.args).toContain('-f');
    expect(rm!.args.some((a) => a.endsWith('.git-credentials'))).toBe(true);
    expect(rm!.args.some((a) => a.endsWith('hosts.yml'))).toBe(true);
  });

  it('IT-1871: returns CREDENTIALS_INJECTION_FAILED when rm throws', async () => {
    const sandbox = createMockSandbox({ rmThrows: new Error('container gone') });
    const result = await new GitHubCredentialsInjector().remove(sandbox as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('container gone');
  });
});

describe('createGitHubCredentialsInjector', () => {
  it('IT-1875: factory returns a fresh injector instance', () => {
    expect(createGitHubCredentialsInjector()).toBeInstanceOf(GitHubCredentialsInjector);
  });
});
