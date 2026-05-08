/**
 * Integration tests for `k8s-workspace-initializer.ts`.
 *
 * Mirrors the existing unit tests at the integration project level so the
 * lines count toward combined integration+functional coverage. The sandbox
 * `exec`/`writeFile` boundary is mocked — no DB or real shell.
 *
 * IT-IDs: IT-1900 to IT-1929
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildGitAuthHeaderArg,
  initializeK8sWorkspace,
} from '../../src/lib/sandbox/k8s-workspace-initializer';
import type { ExecResult } from '../../src/lib/sandbox/types';

function createMockSandbox(opts?: { writeFile?: ReturnType<typeof vi.fn> }) {
  const execFn = vi.fn<(cmd: string, args?: string[]) => Promise<ExecResult>>();
  return {
    exec: execFn,
    writeFile: opts?.writeFile,
  };
}

const defaultOptions = {
  gitToken: { token: 'ghp_test123', owner: 'acme', repo: 'my-app', type: 'pat' as const },
  taskTitle: 'Fix login bug',
  taskId: 'task_abc123def456',
};

describe('initializeK8sWorkspace (integration)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('IT-1900: clones repo and creates worktree on fresh workspace', async () => {
    const sandbox = createMockSandbox();
    const ok = { exitCode: 0, stdout: '', stderr: '' };

    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }); // test -d /workspace/.git
    sandbox.exec.mockResolvedValueOnce(ok); // git init
    sandbox.exec.mockResolvedValueOnce(ok); // git config safe.directory
    sandbox.exec.mockResolvedValueOnce(ok); // git remote add origin
    sandbox.exec.mockResolvedValueOnce(ok); // git fetch
    sandbox.exec.mockResolvedValueOnce(ok); // git checkout -f origin/main
    sandbox.exec.mockResolvedValueOnce(ok); // git checkout -B main
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }); // test -d worktree
    sandbox.exec.mockResolvedValueOnce(ok); // mkdir -p .worktrees
    sandbox.exec.mockResolvedValueOnce(ok); // git worktree add -b

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });
    expect(result.worktreePath).toMatch(/^\/workspace\/.worktrees\//);
    expect(result.branch).toContain('fix-login-bug');
    expect(result.branch).toContain('task_a');
  });

  it('IT-1901: skips clone when workspace already cloned', async () => {
    const sandbox = createMockSandbox();
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // already cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }); // worktree not exist
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // mkdir
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // worktree add

    await initializeK8sWorkspace({ ...defaultOptions, sandbox });
    const cloneCalls = sandbox.exec.mock.calls.filter(
      ([cmd, args]) => cmd === 'git' && args?.[0] === 'clone'
    );
    expect(cloneCalls).toHaveLength(0);
  });

  it('IT-1902: retries worktree creation without -b when branch exists', async () => {
    const sandbox = createMockSandbox();
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }); // worktree not exist
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // mkdir
    sandbox.exec.mockResolvedValueOnce({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: branch already exists',
    });
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // retry success

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });
    expect(result.worktreePath).toMatch(/^\/workspace\/.worktrees\//);
    const worktreeCalls = sandbox.exec.mock.calls.filter(
      ([cmd, args]) => cmd === 'git' && args?.includes('worktree')
    );
    expect(worktreeCalls).toHaveLength(2);
    expect(worktreeCalls[1]?.[1]).not.toContain('-b');
  });

  it('IT-1903: never embeds the token in any git argv (token-free URL)', async () => {
    const sandbox = createMockSandbox();
    const ok = { exitCode: 0, stdout: '', stderr: '' };
    for (let i = 0; i < 10; i++) sandbox.exec.mockResolvedValueOnce(ok);
    // Override the test -d calls to return non-cloned + worktree-not-exist
    sandbox.exec.mockReset();
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce(ok);

    await initializeK8sWorkspace({ ...defaultOptions, sandbox });

    const gitCalls = sandbox.exec.mock.calls.filter(([cmd]) => cmd === 'git');
    for (const [, args] of gitCalls) {
      for (const arg of args ?? []) {
        expect(arg).not.toContain('x-access-token:');
        expect(arg).not.toContain('ghp_test123');
      }
    }
  });

  it('IT-1904: falls back to /workspace on clone failure', async () => {
    const sandbox = createMockSandbox();
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }); // not cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // git init
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // safe.directory
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // remote add
    sandbox.exec.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'not found' }); // fetch fails
    sandbox.exec.mockResolvedValueOnce({ exitCode: 128, stdout: '', stderr: 'not found' }); // fetch retry fails

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });
    expect(result.worktreePath).toBe('/workspace');
    expect(result.branch).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('IT-1905: falls back to /workspace on clone exception', async () => {
    const sandbox = createMockSandbox();
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    sandbox.exec.mockRejectedValueOnce(new Error('network timeout'));

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });
    expect(result.worktreePath).toBe('/workspace');
    expect(result.branch).toBeNull();
  });

  it('IT-1906: falls back to /workspace root when worktree creation fails twice', async () => {
    const sandbox = createMockSandbox();
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }); // not exist
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // mkdir
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'error' });
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'error' });

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });
    expect(result.worktreePath).toBe('/workspace');
    expect(result.branch).toBeNull();
  });

  it('IT-1907: reuses existing worktree directory', async () => {
    const sandbox = createMockSandbox();
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // worktree exists

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });
    expect(result.worktreePath).toMatch(/^\/workspace\/.worktrees\//);
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
  });

  it('IT-1908: uses existingBranch when provided', async () => {
    const sandbox = createMockSandbox();
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const result = await initializeK8sWorkspace({
      ...defaultOptions,
      sandbox,
      existingBranch: 'my-existing-branch',
    });
    expect(result.branch).toBe('my-existing-branch');
    expect(result.worktreePath).toBe('/workspace/.worktrees/my-existing-branch');
  });

  it('IT-1909: uses custom baseBranch for clone and worktree', async () => {
    const sandbox = createMockSandbox();
    const ok = { exitCode: 0, stdout: '', stderr: '' };
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    for (let i = 0; i < 6; i++) sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce(ok);

    await initializeK8sWorkspace({ ...defaultOptions, sandbox, baseBranch: 'develop' });
    const fetchCall = sandbox.exec.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && args?.includes('fetch')
    );
    expect(fetchCall![1]).toContain('develop');
  });

  it('IT-1910: falls back to /workspace when mkdir for worktrees fails', async () => {
    const sandbox = createMockSandbox();
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    sandbox.exec.mockRejectedValueOnce(new Error('permission denied'));

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });
    expect(result.worktreePath).toBe('/workspace');
  });

  it('IT-1911: handles isWorkspaceCloned check throwing (treats as not cloned)', async () => {
    const sandbox = createMockSandbox();
    const ok = { exitCode: 0, stdout: '', stderr: '' };
    sandbox.exec.mockRejectedValueOnce(new Error('exec failed'));
    for (let i = 0; i < 6; i++) sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce(ok);

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });
    expect(result.worktreePath).toMatch(/^\/workspace\/.worktrees\//);
  });

  it('IT-1912: rejects invalid owner/repo formats', async () => {
    const sandbox = createMockSandbox();
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }); // not cloned

    const result = await initializeK8sWorkspace({
      ...defaultOptions,
      gitToken: { token: 't', owner: 'bad/../escape', repo: 'r', type: 'pat' as const },
      sandbox,
    });
    expect(result.worktreePath).toBe('/workspace');
    expect(result.error).toContain('Invalid owner/repo format');
  });

  it('IT-1913: when sandbox has writeFile, uses credential.helper=store path (no http.extraHeader argv)', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const sandbox = createMockSandbox({ writeFile });
    const ok = { exitCode: 0, stdout: '', stderr: '' };
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    for (let i = 0; i < 6; i++) sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce(ok); // rm -f transient

    await initializeK8sWorkspace({ ...defaultOptions, sandbox });

    // writeFile was called with the transient credentials file
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/.agentpane-git-credentials-task_abc123def456'),
      expect.stringContaining('https://x-access-token:ghp_test123@github.com'),
      0o600
    );
    // The fetch command MUST use credential.helper=store (file-based) not http.extraHeader
    const fetchCall = sandbox.exec.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && args?.includes('fetch')
    );
    expect(fetchCall).toBeDefined();
    const args = fetchCall![1] ?? [];
    expect(args.some((a) => a.startsWith('credential.helper=store'))).toBe(true);
    expect(args.some((a) => a.startsWith('http.extraHeader='))).toBe(false);
    // rm -f transient file ran in finally
    const rmCall = sandbox.exec.mock.calls.find(([cmd]) => cmd === 'rm');
    expect(rmCall).toBeDefined();
  });

  it('IT-1914: writeFile failure falls back to argv-token (-c http.extraHeader)', async () => {
    const writeFile = vi.fn().mockRejectedValue(new Error('disk full'));
    const sandbox = createMockSandbox({ writeFile });
    const ok = { exitCode: 0, stdout: '', stderr: '' };
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    for (let i = 0; i < 6; i++) sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    sandbox.exec.mockResolvedValueOnce(ok);
    sandbox.exec.mockResolvedValueOnce(ok);

    await initializeK8sWorkspace({ ...defaultOptions, sandbox });
    const fetchCall = sandbox.exec.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && args?.includes('fetch')
    );
    const args = fetchCall![1] ?? [];
    expect(args.some((a) => a.startsWith('http.extraHeader='))).toBe(true);
  });

  it('IT-1915: sanitizes credential leaks in error messages from git fetch', async () => {
    const sandbox = createMockSandbox();
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // git init
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // safe.directory
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // remote add
    sandbox.exec.mockResolvedValueOnce({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: clone failed for x-access-token:secret123@github.com/foo/bar',
    });
    sandbox.exec.mockResolvedValueOnce({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: clone failed for x-access-token:secret123@github.com',
    });

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });
    expect(result.error).not.toContain('secret123');
    expect(result.error).toContain('[REDACTED]');
  });
});

describe('buildGitAuthHeaderArg', () => {
  it('IT-1920: returns -c flag value with base64 of x-access-token:TOKEN', () => {
    const arg = buildGitAuthHeaderArg('my-token');
    expect(arg.startsWith('http.extraHeader=Authorization: Basic ')).toBe(true);
    const b64 = arg.replace('http.extraHeader=Authorization: Basic ', '');
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    expect(decoded).toBe('x-access-token:my-token');
  });
});
