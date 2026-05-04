import { describe, expect, it, vi } from 'vitest';

import { GitHubCredentialsInjector } from '../github-credentials-injector.js';
import type { Sandbox } from '../providers/sandbox-provider.js';

interface WriteCall {
  path: string;
  content: string;
  mode?: number;
}

function createMockSandbox(opts?: { withWriteFile?: boolean; writeFails?: boolean }) {
  const writeCalls: WriteCall[] = [];
  const execCalls: { cmd: string; args: string[] }[] = [];
  const writeFn =
    (opts?.withWriteFile ?? true)
      ? vi.fn(async (path: string, content: string | Buffer, mode?: number) => {
          if (opts?.writeFails) throw new Error('disk full');
          writeCalls.push({
            path,
            content: typeof content === 'string' ? content : content.toString('utf8'),
            mode,
          });
        })
      : undefined;
  const sandbox = {
    id: 'sbx-1',
    codespaceId: 'cs-1',
    containerId: 'c-1',
    status: 'running' as const,
    exec: vi.fn(async (cmd: string, args: string[] = []) => {
      execCalls.push({ cmd, args });
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    execAsRoot: vi.fn(),
    createTmuxSession: vi.fn(),
    listTmuxSessions: vi.fn(),
    killTmuxSession: vi.fn(),
    sendKeysToTmux: vi.fn(),
    captureTmuxPane: vi.fn(),
    stop: vi.fn(),
    getMetrics: vi.fn(),
    touch: vi.fn(),
    getLastActivity: vi.fn(),
    writeFile: writeFn,
  } as unknown as Sandbox;
  return { sandbox, writeCalls, execCalls };
}

describe('GitHubCredentialsInjector', () => {
  it('writes ~/.git-credentials and ~/.config/gh/hosts.yml via writeFile and sets credential.helper via git config --global', async () => {
    const { sandbox, writeCalls, execCalls } = createMockSandbox();
    const injector = new GitHubCredentialsInjector();

    const result = await injector.inject(sandbox, {
      token: 'ghp_test_token_value',
      githubLogin: 'octocat',
    });

    expect(result.ok).toBe(true);
    // Only the two token-bearing files are written via writeFile; ~/.gitconfig
    // is no longer overwritten — credential.helper is set via git config --global.
    expect(writeCalls).toHaveLength(2);

    const credPath = writeCalls.find((c) => c.path.endsWith('/.git-credentials'));
    expect(credPath).toBeDefined();
    expect(credPath?.content).toBe('https://x-access-token:ghp_test_token_value@github.com\n');
    expect(credPath?.mode).toBe(0o600);

    const ghHosts = writeCalls.find((c) => c.path.endsWith('/.config/gh/hosts.yml'));
    expect(ghHosts).toBeDefined();
    expect(ghHosts?.content).toContain('oauth_token: ghp_test_token_value');
    expect(ghHosts?.content).toContain('user: octocat');
    expect(ghHosts?.mode).toBe(0o600);

    // ~/.gitconfig is NOT overwritten — would clobber image-baked settings.
    const gitconfig = writeCalls.find((c) => c.path.endsWith('/.gitconfig'));
    expect(gitconfig).toBeUndefined();

    // credential.helper=store is set via `git config --global` (idempotent,
    // preserves existing user config).
    const gitConfigCall = execCalls.find(
      (c) =>
        c.cmd === 'git' &&
        c.args.includes('config') &&
        c.args.includes('--global') &&
        c.args.includes('credential.helper')
    );
    expect(gitConfigCall).toBeDefined();
    expect(gitConfigCall?.args).toContain('store');

    // mkdir for ~/.config/gh must use mode 700 so the gh oauth_token is not
    // world-readable under a permissive sandbox umask.
    const mkdirCall = execCalls.find((c) => c.cmd === 'mkdir');
    expect(mkdirCall).toBeDefined();
    expect(mkdirCall?.args).toContain('-m');
    expect(mkdirCall?.args).toContain('700');
  });

  it('falls back to x-access-token when no githubLogin is provided', async () => {
    const { sandbox, writeCalls } = createMockSandbox();
    const injector = new GitHubCredentialsInjector();

    const result = await injector.inject(sandbox, { token: 'ghs_app_token' });

    expect(result.ok).toBe(true);
    const ghHosts = writeCalls.find((c) => c.path.endsWith('hosts.yml'));
    expect(ghHosts?.content).toContain('user: x-access-token');
  });

  it('refuses to inject and never calls exec for credential content when writeFile is missing', async () => {
    const { sandbox, execCalls } = createMockSandbox({ withWriteFile: false });
    const injector = new GitHubCredentialsInjector();

    const result = await injector.inject(sandbox, { token: 'ghp_secret' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('writeFile');
    }
    // Crucially, the token must never be passed to exec — that would put
    // it in argv and defeat the whole point of the file-based injection.
    for (const call of execCalls) {
      const joined = `${call.cmd} ${call.args.join(' ')}`;
      expect(joined).not.toContain('ghp_secret');
    }
  });

  it('returns error when writeFile throws', async () => {
    const { sandbox } = createMockSandbox({ writeFails: true });
    const injector = new GitHubCredentialsInjector();

    const result = await injector.inject(sandbox, { token: 'ghp_x' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SANDBOX_CREDENTIALS_INJECTION_FAILED');
    }
  });

  it('remove() rm -f the credential files but leaves .gitconfig alone', async () => {
    const { sandbox, execCalls } = createMockSandbox();
    const injector = new GitHubCredentialsInjector();

    const result = await injector.remove(sandbox);

    expect(result.ok).toBe(true);
    const rm = execCalls.find((c) => c.cmd === 'rm');
    expect(rm).toBeDefined();
    expect(rm?.args.some((a) => a.endsWith('/.git-credentials'))).toBe(true);
    expect(rm?.args.some((a) => a.endsWith('/hosts.yml'))).toBe(true);
    expect(rm?.args.some((a) => a.endsWith('/.gitconfig'))).toBe(false);
  });

  it('remove() targets the canonical user-home paths so prior tenant creds cannot leak', async () => {
    // codex P1: in shared/reused sandboxes, scrubbing must hit the same paths
    // that inject() writes to, otherwise a previous run's ~/.git-credentials
    // and ~/.config/gh/hosts.yml remain readable to the next tenant agent.
    const { sandbox: writeSandbox, writeCalls } = createMockSandbox();
    const writeInjector = new GitHubCredentialsInjector();
    await writeInjector.inject(writeSandbox, { token: 'ghs_prior_tenant_token' });
    const writePaths = new Set(writeCalls.map((w) => w.path));

    const { sandbox: rmSandbox, execCalls } = createMockSandbox();
    const rmInjector = new GitHubCredentialsInjector();
    await rmInjector.remove(rmSandbox);

    const rmCall = execCalls.find((c) => c.cmd === 'rm');
    const rmTargets = new Set(rmCall?.args.filter((a) => a.startsWith('/')) ?? []);

    // Every path inject() writes that contains the token MUST be a path
    // remove() rm's. .gitconfig has no token so it is exempt by design.
    for (const p of writePaths) {
      if (p.endsWith('/.gitconfig')) continue;
      expect(rmTargets.has(p)).toBe(true);
    }
  });
});
