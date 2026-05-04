/**
 * arch29-W2-I (F04-12) — the K8s workspace initializer must not embed the
 * GitHub token in the clone-URL argv. The previous form
 * `https://x-access-token:${token}@github.com/...` is replaced with a
 * token-free public URL plus a per-invocation `-c http.extraHeader=...`
 * argument carrying the auth header (base64 of `x-access-token:TOKEN`).
 *
 * Red→green regression test:
 *   - WITHOUT fix: `git remote add origin <url>` argv contains
 *     `x-access-token:TOKEN_VALUE` substring.
 *   - WITH fix: NO call to `sandbox.exec('git', [...])` should have an arg
 *     containing the literal substring `x-access-token:` (and the token
 *     itself must not appear unencoded). The remote URL stored in
 *     `.git/config` MUST be the public form. The token may appear in the
 *     `-c http.extraHeader` argv during the single fetch call as the
 *     base64-encoded `Authorization: Basic <b64>` value.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/logging/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

interface ExecCall {
  cmd: string;
  args: string[];
}

function makeMockSandbox(): {
  sandbox: { exec: ReturnType<typeof vi.fn> };
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const sandbox = {
    exec: vi.fn(async (cmd: string, args: string[] = []) => {
      calls.push({ cmd, args: [...args] });
      // Mock the workspace-cloned check to return "not cloned"
      if (cmd === 'test' && args.includes('-d') && args.some((a) => a.endsWith('/.git'))) {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      // Default: success
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
  };
  return { sandbox, calls };
}

describe('arch29-W2-I (F04-12) — K8s git clone never puts token in URL argv', () => {
  it('initializeK8sWorkspace runs no git command containing x-access-token: substring', async () => {
    const { initializeK8sWorkspace } = await import(
      '../../src/lib/sandbox/k8s-workspace-initializer.js'
    );

    const { sandbox, calls } = makeMockSandbox();
    const SECRET_TOKEN = 'ghp_extremelysensitive_should_never_appear_in_argv_xxx';

    await initializeK8sWorkspace({
      sandbox,
      gitToken: {
        token: SECRET_TOKEN,
        owner: 'agentdevsl',
        repo: 'agentpane',
        type: 'app' as const,
      },
      taskTitle: 'fix-the-thing',
      taskId: 'task-abcd1234',
      baseBranch: 'main',
    });

    // Pull every git invocation argv we've recorded.
    const gitCalls = calls.filter((c) => c.cmd === 'git');
    expect(gitCalls.length).toBeGreaterThan(0);

    // Critical: NO argv element across every git call may contain
    // `x-access-token:` (the URL form leaks the token via /proc/<pid>/cmdline,
    // container audit logs, and any sibling tenant in shared-sandbox mode).
    for (const call of gitCalls) {
      for (const arg of call.args) {
        expect(arg).not.toContain('x-access-token:');
      }
    }

    // Critical: the raw token never appears literally either. The auth header
    // arg is base64-encoded so the plaintext token must not be present in argv.
    for (const call of gitCalls) {
      for (const arg of call.args) {
        expect(arg).not.toContain(SECRET_TOKEN);
      }
    }

    // The `git remote add origin <url>` call MUST use the token-free public
    // URL — that's what `git remote -v` will surface to any later command
    // (and any tenant in shared-sandbox mode).
    const remoteAddCall = gitCalls.find(
      (c) => c.args.includes('remote') && c.args.includes('add') && c.args.includes('origin')
    );
    expect(remoteAddCall).toBeDefined();
    const url = remoteAddCall?.args[remoteAddCall.args.length - 1];
    expect(url).toBe('https://github.com/agentdevsl/agentpane.git');

    // The `set-url origin` call (when present, used to overwrite a stale
    // tokenized URL from a prior run) MUST also use the token-free form.
    const setUrlCall = gitCalls.find(
      (c) => c.args.includes('remote') && c.args.includes('set-url') && c.args.includes('origin')
    );
    if (setUrlCall) {
      const setUrlArg = setUrlCall.args[setUrlCall.args.length - 1];
      expect(setUrlArg).toBe('https://github.com/agentdevsl/agentpane.git');
      expect(setUrlArg).not.toContain('x-access-token');
    }
  });

  it('the fetch call carries -c http.extraHeader with base64 auth header (token NOT in plaintext)', async () => {
    const { initializeK8sWorkspace } = await import(
      '../../src/lib/sandbox/k8s-workspace-initializer.js'
    );

    const { sandbox, calls } = makeMockSandbox();
    const SECRET_TOKEN = 'ghp_secret_pat_value_for_test_purposes';

    await initializeK8sWorkspace({
      sandbox,
      gitToken: {
        token: SECRET_TOKEN,
        owner: 'agentdevsl',
        repo: 'agentpane',
        type: 'app' as const,
      },
      taskTitle: 'feature-x',
      taskId: 'task-efgh5678',
      baseBranch: 'main',
    });

    // Find the fetch call(s).
    const gitCalls = calls.filter((c) => c.cmd === 'git');
    const fetchCalls = gitCalls.filter((c) => c.args.includes('fetch'));
    expect(fetchCalls.length).toBeGreaterThan(0);

    // Each fetch must carry `-c <extraHeader>` for auth.
    for (const fetchCall of fetchCalls) {
      const dashCIdx = fetchCall.args.indexOf('-c');
      expect(dashCIdx).toBeGreaterThanOrEqual(0);
      const cVal = fetchCall.args[dashCIdx + 1] ?? '';
      expect(cVal).toMatch(/^http\.extraHeader=Authorization:\s+Basic\s+/);
      // The plaintext token must NOT appear; only the b64-encoded form may.
      expect(cVal).not.toContain(SECRET_TOKEN);
      expect(cVal).not.toContain('x-access-token:');
    }
  });

  it('buildGitAuthHeaderArg encodes the token with x-access-token: prefix', async () => {
    const { buildGitAuthHeaderArg } = await import(
      '../../src/lib/sandbox/k8s-workspace-initializer.js'
    );
    const arg = buildGitAuthHeaderArg('ghp_test_token');
    // Expect the form `http.extraHeader=Authorization: Basic <b64>`.
    expect(arg).toMatch(/^http\.extraHeader=Authorization: Basic [A-Za-z0-9+/=]+$/);
    // Decode and check it's `x-access-token:ghp_test_token`.
    const b64 = arg.replace(/^http\.extraHeader=Authorization: Basic /, '');
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    expect(decoded).toBe('x-access-token:ghp_test_token');
    // The plaintext token IS in the b64-decoded value (that's the whole
    // point of the auth header) — but it is NOT visible as a literal
    // substring in the b64-encoded argv element.
    expect(arg).not.toContain('ghp_test_token');
    expect(arg).not.toContain('x-access-token:');
  });
});
