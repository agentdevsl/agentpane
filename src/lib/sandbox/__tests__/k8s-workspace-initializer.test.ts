import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeK8sWorkspace } from '../k8s-workspace-initializer.js';
import type { ExecResult } from '../types.js';

/**
 * Helper to create a mock sandbox with configurable exec responses.
 */
function createMockSandbox() {
  const execFn = vi.fn<(cmd: string, args?: string[]) => Promise<ExecResult>>();
  return { exec: execFn };
}

const defaultOptions = {
  gitToken: { token: 'ghp_test123', owner: 'acme', repo: 'my-app' },
  taskTitle: 'Fix login bug',
  taskId: 'task_abc123def456',
};

describe('initializeK8sWorkspace', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Suppress console output during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('clones repo and creates worktree on fresh workspace', async () => {
    const sandbox = createMockSandbox();
    const ok = { exitCode: 0, stdout: '', stderr: '' };

    // arch29-W2-I (F04-12): the remote URL is the public token-free form, so
    // there is NO `git remote set-url` call to strip a token after clone.
    // test -d /workspace/.git → not cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    // git init
    sandbox.exec.mockResolvedValueOnce(ok);
    // git config --global safe.directory
    sandbox.exec.mockResolvedValueOnce(ok);
    // git remote add origin (token-free URL)
    sandbox.exec.mockResolvedValueOnce(ok);
    // git -c http.extraHeader=... fetch --depth 1 origin main
    sandbox.exec.mockResolvedValueOnce(ok);
    // git checkout -f origin/main
    sandbox.exec.mockResolvedValueOnce(ok);
    // git checkout -B main
    sandbox.exec.mockResolvedValueOnce(ok);
    // git config credential.helper ''
    sandbox.exec.mockResolvedValueOnce(ok);
    // test -d worktree dir → does not exist
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    // mkdir -p /workspace/.worktrees
    sandbox.exec.mockResolvedValueOnce(ok);
    // git worktree add -b
    sandbox.exec.mockResolvedValueOnce(ok);

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });

    expect(result.worktreePath).toMatch(/^\/workspace\/.worktrees\//);
    expect(result.branch).toContain('fix-login-bug');
    expect(result.branch).toContain('task_a');
  });

  it('skips clone when workspace is already cloned', async () => {
    const sandbox = createMockSandbox();

    // test -d /workspace/.git → already cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    // test -d worktree dir → does not exist
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    // mkdir -p /workspace/.worktrees
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    // git worktree add -b
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });

    expect(result.worktreePath).toMatch(/^\/workspace\/.worktrees\//);
    // Should not have called git clone
    const cloneCalls = sandbox.exec.mock.calls.filter(
      ([cmd, args]) => cmd === 'git' && args?.[0] === 'clone'
    );
    expect(cloneCalls).toHaveLength(0);
  });

  it('retries worktree creation without -b when branch already exists', async () => {
    const sandbox = createMockSandbox();

    // test -d /workspace/.git → already cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    // test -d worktree dir → does not exist
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    // mkdir -p
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    // git worktree add -b → fails (branch exists)
    sandbox.exec.mockResolvedValueOnce({
      exitCode: 128,
      stdout: '',
      stderr: "fatal: a branch named 'fix-login-bug-task_a' already exists",
    });
    // git worktree add (without -b) → succeeds
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });

    expect(result.worktreePath).toMatch(/^\/workspace\/.worktrees\//);
    expect(result.branch).toBeTruthy();

    // Verify the retry call was without -b
    const worktreeAddCalls = sandbox.exec.mock.calls.filter(
      ([cmd, args]) => cmd === 'git' && args?.includes('worktree')
    );
    expect(worktreeAddCalls).toHaveLength(2);
    // Second call should NOT have -b
    expect(worktreeAddCalls[1]?.[1]).not.toContain('-b');
  });

  it('arch29-W2-I (F04-12): never embeds the token in any git argv', async () => {
    const sandbox = createMockSandbox();
    const ok = { exitCode: 0, stdout: '', stderr: '' };

    // arch29-W2-I (F04-12): the remote URL is now the public token-free form
    // and auth is supplied per-invocation via -c http.extraHeader=...
    // test -d /workspace/.git → not cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    // git init
    sandbox.exec.mockResolvedValueOnce(ok);
    // git config --global safe.directory
    sandbox.exec.mockResolvedValueOnce(ok);
    // git remote add origin (token-free URL)
    sandbox.exec.mockResolvedValueOnce(ok);
    // git -c http.extraHeader=... fetch --depth 1 origin main
    sandbox.exec.mockResolvedValueOnce(ok);
    // git checkout -f origin/main
    sandbox.exec.mockResolvedValueOnce(ok);
    // git checkout -B main
    sandbox.exec.mockResolvedValueOnce(ok);
    // git config credential.helper
    sandbox.exec.mockResolvedValueOnce(ok);
    // test -d worktree dir
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    // mkdir -p
    sandbox.exec.mockResolvedValueOnce(ok);
    // git worktree add -b
    sandbox.exec.mockResolvedValueOnce(ok);

    await initializeK8sWorkspace({ ...defaultOptions, sandbox });

    // No git command should ever carry the literal `x-access-token:` prefix
    // (the URL form leaks the token via /proc/<pid>/cmdline). The token is
    // never in the URL, so `git remote -v` after clone is safe.
    const gitCalls = sandbox.exec.mock.calls.filter(([cmd]) => cmd === 'git');
    for (const [, args] of gitCalls) {
      for (const arg of args ?? []) {
        expect(arg).not.toContain('x-access-token:');
        expect(arg).not.toContain('ghp_test123');
      }
    }

    // Remote add call should use the token-free public URL.
    const addCall = sandbox.exec.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && args?.includes('add') && args?.includes('origin')
    );
    expect(addCall).toBeTruthy();
    const addUrl = addCall![1]!.find((arg: string) => arg.includes('github.com'));
    expect(addUrl).toBe('https://github.com/acme/my-app.git');

    // Fetch should use -c http.extraHeader=... for auth.
    const fetchCall = sandbox.exec.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && args?.includes('fetch')
    );
    expect(fetchCall).toBeTruthy();
    const dashCIdx = fetchCall![1]!.indexOf('-c');
    expect(dashCIdx).toBeGreaterThanOrEqual(0);
    const cVal = fetchCall![1]![dashCIdx + 1] ?? '';
    expect(cVal).toMatch(/^http\.extraHeader=Authorization: Basic /);
    // The b64 value MUST decode to `x-access-token:TOKEN`, but the b64
    // string itself MUST NOT contain plaintext `x-access-token:`.
    expect(cVal).not.toContain('x-access-token:');

    // Credential helper should be disabled.
    const credCall = sandbox.exec.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && args?.includes('credential.helper')
    );
    expect(credCall).toBeTruthy();
  });

  it('falls back to /workspace on clone failure', async () => {
    const sandbox = createMockSandbox();

    // test -d /workspace/.git → not cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    // git clone → fails
    sandbox.exec.mockResolvedValueOnce({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: repository not found',
    });

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });

    expect(result.worktreePath).toBe('/workspace');
    expect(result.branch).toBeNull();
  });

  it('falls back to /workspace on clone exception', async () => {
    const sandbox = createMockSandbox();

    // test -d /workspace/.git → not cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    // git clone → throws
    sandbox.exec.mockRejectedValueOnce(new Error('network timeout'));

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });

    expect(result.worktreePath).toBe('/workspace');
    expect(result.branch).toBeNull();
  });

  it('falls back to /workspace root when worktree creation fails', async () => {
    const sandbox = createMockSandbox();

    // test -d /workspace/.git → already cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    // test -d worktree dir → does not exist
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    // mkdir -p
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    // git worktree add -b → fails
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'error' });
    // git worktree add (retry without -b) → also fails
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'error' });

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });

    expect(result.worktreePath).toBe('/workspace');
    expect(result.branch).toBeNull();
  });

  it('reuses existing worktree directory', async () => {
    const sandbox = createMockSandbox();

    // test -d /workspace/.git → already cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    // test -d worktree dir → already exists
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });

    expect(result.worktreePath).toMatch(/^\/workspace\/.worktrees\//);
    expect(result.branch).toBeTruthy();
    // Should NOT have called mkdir or git worktree add
    expect(sandbox.exec).toHaveBeenCalledTimes(2);
  });

  it('uses existingBranch when provided', async () => {
    const sandbox = createMockSandbox();

    // test -d /workspace/.git → already cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    // test -d worktree dir → does not exist
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    // mkdir -p
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    // git worktree add -b
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const result = await initializeK8sWorkspace({
      ...defaultOptions,
      sandbox,
      existingBranch: 'my-existing-branch',
    });

    expect(result.branch).toBe('my-existing-branch');
    expect(result.worktreePath).toBe('/workspace/.worktrees/my-existing-branch');
  });

  it('uses custom baseBranch for clone and worktree', async () => {
    const sandbox = createMockSandbox();
    const ok = { exitCode: 0, stdout: '', stderr: '' };

    // arch29-W2-I (F04-12): the URL no longer carries the token, so there is
    // no `set-url` step to strip a token after clone. The mock list is:
    // test -d /workspace/.git → not cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    // git init
    sandbox.exec.mockResolvedValueOnce(ok);
    // git config --global safe.directory
    sandbox.exec.mockResolvedValueOnce(ok);
    // git remote add origin (token-free)
    sandbox.exec.mockResolvedValueOnce(ok);
    // git -c http.extraHeader=... fetch --depth 1 origin develop
    sandbox.exec.mockResolvedValueOnce(ok);
    // git checkout -f origin/develop
    sandbox.exec.mockResolvedValueOnce(ok);
    // git checkout -B develop
    sandbox.exec.mockResolvedValueOnce(ok);
    // git config credential.helper
    sandbox.exec.mockResolvedValueOnce(ok);
    // test -d worktree dir
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    // mkdir -p
    sandbox.exec.mockResolvedValueOnce(ok);
    // git worktree add -b
    sandbox.exec.mockResolvedValueOnce(ok);

    await initializeK8sWorkspace({
      ...defaultOptions,
      sandbox,
      baseBranch: 'develop',
    });

    // Fetch should use 'develop' branch
    const fetchCall = sandbox.exec.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && args?.includes('fetch')
    );
    expect(fetchCall![1]).toContain('develop');

    // Worktree should use 'develop' as base
    const worktreeCall = sandbox.exec.mock.calls.find(
      ([cmd, args]) => cmd === 'git' && args?.includes('worktree')
    );
    expect(worktreeCall![1]).toContain('develop');
  });

  it('falls back to /workspace when mkdir for worktrees fails', async () => {
    const sandbox = createMockSandbox();

    // test -d /workspace/.git → already cloned
    sandbox.exec.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    // test -d worktree dir → does not exist
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    // mkdir -p → throws
    sandbox.exec.mockRejectedValueOnce(new Error('permission denied'));

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });

    expect(result.worktreePath).toBe('/workspace');
    expect(result.branch).toBeNull();
  });

  it('handles isWorkspaceCloned check throwing', async () => {
    const sandbox = createMockSandbox();
    const ok = { exitCode: 0, stdout: '', stderr: '' };

    // arch29-W2-I (F04-12): no `set-url` step (token never in URL).
    // test -d /workspace/.git → throws (isWorkspaceCloned)
    sandbox.exec.mockRejectedValueOnce(new Error('exec failed'));
    // Treated as "not cloned", so init+fetch flow follows:
    // git init
    sandbox.exec.mockResolvedValueOnce(ok);
    // git config --global safe.directory
    sandbox.exec.mockResolvedValueOnce(ok);
    // git remote add origin (token-free URL)
    sandbox.exec.mockResolvedValueOnce(ok);
    // git -c http.extraHeader=... fetch --depth 1 origin main
    sandbox.exec.mockResolvedValueOnce(ok);
    // git checkout -f origin/main
    sandbox.exec.mockResolvedValueOnce(ok);
    // git checkout -B main
    sandbox.exec.mockResolvedValueOnce(ok);
    // git config credential.helper
    sandbox.exec.mockResolvedValueOnce(ok);
    // test -d worktree dir → does not exist
    sandbox.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    // mkdir -p .worktrees
    sandbox.exec.mockResolvedValueOnce(ok);
    // git worktree add -b
    sandbox.exec.mockResolvedValueOnce(ok);

    const result = await initializeK8sWorkspace({ ...defaultOptions, sandbox });

    // Should still succeed (init+fetch + worktree)
    expect(result.worktreePath).toMatch(/^\/workspace\/.worktrees\//);
    expect(result.branch).toBeTruthy();
  });
});
