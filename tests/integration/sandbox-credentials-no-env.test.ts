/**
 * arch29-W2-I (F04-07, F06-NEW-05) — sandbox credential injection drops the
 * `CLAUDE_OAUTH_TOKEN` env var entirely. The host writes
 * `~/.claude/.credentials.json` via `sandbox.writeFile()` (out-of-band) and
 * the agent-runner is expected to read that file directly.
 *
 * Red→green regression test:
 *   - WITHOUT fix: container exec env contains `CLAUDE_OAUTH_TOKEN: '<real token>'`
 *   - WITH fix: container exec env contains NO key matching /CLAUDE_OAUTH/
 *     and `sandbox.writeFile` is invoked with the SDK-compatible CLI shape.
 *
 * Strategy: instantiate `ContainerExecService` with mocked deps. The service's
 * `injectCredentialsBeforeExec` private method writes via `sandbox.writeFile`,
 * and `prepareContainerExec` builds the env. The env passed to `execStream`
 * must be free of any `CLAUDE_OAUTH_*` keys.
 */

import type { Readable, Writable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/logging/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

interface ExecStreamCall {
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface WriteFileCall {
  path: string;
  content: string;
  mode?: number;
}

function buildMockSandbox(): {
  sandbox: {
    id: string;
    codespaceId: string;
    containerId: string;
    status: 'running';
    exec: ReturnType<typeof vi.fn>;
    execStream: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    refreshStatus?: () => Promise<void>;
    [k: string]: unknown;
  };
  execStreamCalls: ExecStreamCall[];
  writeFileCalls: WriteFileCall[];
} {
  const execStreamCalls: ExecStreamCall[] = [];
  const writeFileCalls: WriteFileCall[] = [];
  const sandbox = {
    id: 'sb-1',
    codespaceId: 'cs-1',
    containerId: 'docker-c1',
    status: 'running' as const,
    exec: vi.fn(async () => ({ exitCode: 0, stdout: 'ready', stderr: '' })),
    execStream: vi.fn(async (opts: ExecStreamCall) => {
      execStreamCalls.push({
        cmd: opts.cmd,
        args: opts.args,
        env: opts.env ? { ...opts.env } : undefined,
        cwd: opts.cwd,
      });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      // Don't emit data; tests assert on env, not on output.
      return {
        stdout: stdout as unknown as Readable,
        stderr: stderr as unknown as Readable,
        wait: vi.fn(async () => ({ exitCode: 0 })),
        kill: vi.fn(async () => {
          stdout.end();
          stderr.end();
        }),
        // For agent-runner emulation: don't force-close so handlers can attach.
        stdin: undefined as unknown as Writable | undefined,
      };
    }),
    writeFile: vi.fn(async (path: string, content: string | Buffer, mode?: number) => {
      writeFileCalls.push({
        path,
        content: typeof content === 'string' ? content : content.toString('utf8'),
        mode,
      });
    }),
    refreshStatus: async () => {
      /* noop */
    },
    touch: vi.fn(),
    getLastActivity: vi.fn(() => new Date()),
    getMetrics: vi.fn(),
    stop: vi.fn(),
    execAsRoot: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    createTmuxSession: vi.fn(),
    listTmuxSessions: vi.fn(),
    killTmuxSession: vi.fn(),
    sendKeysToTmux: vi.fn(),
    captureTmuxPane: vi.fn(),
  };
  return { sandbox, execStreamCalls, writeFileCalls };
}

describe('arch29-W2-I — credentials never flow via env var; only via writeFile', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('injectCredentialsBeforeExec writes ~/.claude/.credentials.json via writeFile in CLI shape', async () => {
    const { ContainerExecService } = await import(
      '../../src/services/container-agent/container-exec.service.js'
    );

    const { sandbox, writeFileCalls } = buildMockSandbox();

    // Construct a near-empty service instance just to exercise the private
    // injection method via the public path. We use a typed cast to reach the
    // private method without re-implementing the full startAgent path.
    const svc = new ContainerExecService(
      // deps stub — only `streams` is touched by the private method indirectly
      {
        db: {} as never,
        provider: {} as never,
        streams: { publish: vi.fn(async () => undefined) } as never,
        apiKeyService: {} as never,
      } as never,
      {} as never, // SandboxStateManager
      {} as never, // WorktreeInitService
      vi.fn() as never, // onPlanReady
      vi.fn() as never // onAgentCompleteCallback
    );

    // Reach the private method via the unknown cast so we can target it
    // without round-tripping through startAgent (which needs DB fixtures).
    const result = await (
      svc as unknown as {
        injectCredentialsBeforeExec: (
          sandbox: unknown,
          oauthToken: string,
          oauthRefreshToken: string | null,
          oauthExpiresAtMs: number | null
        ) => Promise<{ ok: boolean; error?: { code: string; message: string } }>;
      }
    ).injectCredentialsBeforeExec(
      sandbox,
      'sk-ant-oat01-secret-token-xyz',
      'rt-deadbeef',
      Date.now() + 60_000
    );

    expect(result.ok).toBe(true);
    expect(writeFileCalls).toHaveLength(1);
    const call = writeFileCalls[0];
    expect(call?.path).toBe('/home/node/.claude/.credentials.json');
    expect(call?.mode).toBe(0o600);
    const parsed = JSON.parse(call?.content ?? '{}') as {
      claudeAiOauth?: { accessToken?: string; refreshToken?: string };
    };
    expect(parsed.claudeAiOauth?.accessToken).toBe('sk-ant-oat01-secret-token-xyz');
    expect(parsed.claudeAiOauth?.refreshToken).toBe('rt-deadbeef');
  });

  it('injectCredentialsBeforeExec FAILS CLOSED when sandbox lacks writeFile (no shell-exec fallback)', async () => {
    const { ContainerExecService } = await import(
      '../../src/services/container-agent/container-exec.service.js'
    );

    const { sandbox } = buildMockSandbox();
    // Strip writeFile to simulate a provider that hasn't been ported.
    (sandbox as Record<string, unknown>).writeFile = undefined;

    const svc = new ContainerExecService(
      {
        db: {} as never,
        provider: {} as never,
        streams: { publish: vi.fn(async () => undefined) } as never,
        apiKeyService: {} as never,
      } as never,
      {} as never,
      {} as never,
      vi.fn() as never,
      vi.fn() as never
    );

    const result = await (
      svc as unknown as {
        injectCredentialsBeforeExec: (
          sandbox: unknown,
          oauthToken: string,
          oauthRefreshToken: string | null,
          oauthExpiresAtMs: number | null
        ) => Promise<{ ok: boolean; error?: { code: string; message: string } }>;
      }
    ).injectCredentialsBeforeExec(sandbox, 'sk-ant-oat01-token', null, null);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Refuses to fall through to a shell-exec path that would put the
      // token in argv (the whole point of arch29-W2-I).
      expect(result.error?.code).toContain('CREDENTIALS_INJECTION_FAILED');
      expect(result.error?.message).toMatch(/writeFile/i);
    }
  });

  it('prepareContainerExec env carries NO CLAUDE_OAUTH_* keys', async () => {
    const { ContainerExecService } = await import(
      '../../src/services/container-agent/container-exec.service.js'
    );

    const svc = new ContainerExecService(
      {
        db: {} as never,
        provider: {} as never,
        streams: { publish: vi.fn(async () => undefined) } as never,
        apiKeyService: {} as never,
      } as never,
      {} as never,
      {} as never,
      vi.fn() as never,
      vi.fn() as never
    );

    const { env } = (
      svc as unknown as {
        prepareContainerExec: (params: {
          taskId: string;
          sessionId: string;
          codespaceId: string;
          phase: 'plan' | 'execute';
          sdkSessionId?: string;
          prompt: string;
          agentConfig: { model: string; maxTurns: number; allowedTools: string[] };
          worktreePath: string;
          stopFilePath: string;
        }) => { env: Record<string, string> };
      }
    ).prepareContainerExec({
      taskId: 'task-1',
      sessionId: 'sess-1',
      codespaceId: 'cs-1',
      phase: 'plan',
      prompt: 'do the thing',
      agentConfig: { model: 'claude-opus-4-5-20251101', maxTurns: 50, allowedTools: ['Bash'] },
      worktreePath: '/workspace',
      stopFilePath: '/tmp/.stop-task-1',
    });

    // Assert the env is free of every CLAUDE_OAUTH_* leak vector.
    const oauthKeys = Object.keys(env).filter((k) => k.startsWith('CLAUDE_OAUTH'));
    expect(oauthKeys).toEqual([]);
    // Sanity: the AGENT_* vars are still there.
    expect(env.AGENT_TASK_ID).toBe('task-1');
    expect(env.AGENT_PHASE).toBe('plan');
  });
});
