/**
 * F03-01 / F03-02: Functional test proving tool-use hooks are now wired.
 *
 * Before the W2-A fix, `AgentExecutionService.start()` never called
 * `createAgentHooks(...)`, so the whitelist + audit + streaming hook bundle
 * lived as dead infrastructure. The fix wires `installAgentHooks` into
 * `start()` and threads the registered pre/post hooks through both
 * `runAgentPlanning` and `runAgentExecution`.
 *
 * This test exercises **real service code**:
 *   - `AgentExecutionService.start()` (real, no mock)
 *   - `createAgentHooks` → `createToolWhitelistHook` (real)
 *   - The `canUseTool` callback registered with the SDK (real, intercepted
 *     via mocked `unstable_v2_createSession`)
 *
 * Only the Claude Agent SDK boundary is mocked — the test extracts the
 * `canUseTool` the host installed and invokes it directly to simulate the
 * SDK calling back before a tool runs.
 *
 * Failing-test (before fix): the agent runs with EMPTY pre-tool-use hook
 * arrays, so `canUseTool` returns `{behavior:'allow'}` for any tool — even
 * `Bash` when the agent's whitelist excludes it. The deny verdict is never
 * produced, the `tool:result{isError:true}` event is never emitted, and the
 * agent silently runs forbidden tools.
 *
 * Passing-test (after fix): the whitelist hook bundle is installed in the
 * service registry during `start()`, threaded into `runAgentPlanning`'s
 * `preToolUseHooks`, and the `canUseTool` returns `{behavior:'deny'}` for
 * `Bash` when the agent's `allowedTools` excludes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentExecutionService } from '../../src/services/agent/agent-execution.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// =============================================================================
// SDK boundary mock — intercept canUseTool installed by stream-handler
// =============================================================================

const capturedCanUseTool: { fn: ((...args: unknown[]) => unknown) | null } = { fn: null };

const mockSessionCreate = vi.hoisted(() => vi.fn());
const mockSessionResume = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: mockSessionCreate,
  unstable_v2_resumeSession: mockSessionResume,
}));

vi.mock('../../src/services/settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue('claude-sonnet-4-6'),
  getAgentMaxRuntimeMs: vi.fn().mockResolvedValue(4 * 60 * 60 * 1000),
  DEFAULT_AGENT_MAX_RUNTIME_MS: 4 * 60 * 60 * 1000,
}));

vi.mock('../../src/lib/utils/resolve-model.js', () => ({
  resolveModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
}));

const mockWorktreeService = {
  create: vi.fn(),
  remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
};

const mockSessionService = {
  create: vi.fn(),
  delete: vi.fn().mockResolvedValue({ ok: true, value: { deleted: true } }),
  publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 0 } }),
};

const mockTaskService = {
  moveColumn: vi.fn().mockResolvedValue({ ok: true }),
};

describe('F03-01 / F03-02: tool-deny hook wiring (functional)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: AgentExecutionService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    vi.clearAllMocks();
    capturedCanUseTool.fn = null;

    // The mock SDK session captures the canUseTool callback installed by
    // runAgentPlanning so the test can drive it. The stream is held open
    // (we never push messages) so the planning loop does not race the
    // assertions; the abort-controller path eventually closes it.
    const session = {
      send: vi.fn().mockResolvedValue(undefined),
      stream: vi.fn().mockImplementation(() => {
        return (async function* () {
          // Hold the stream open by yielding nothing and waiting forever.
          await new Promise(() => {});
        })();
      }),
      close: vi.fn(),
      sessionId: 'sdk-mock-session',
    };
    mockSessionCreate.mockImplementation((opts: Record<string, unknown>) => {
      capturedCanUseTool.fn = opts.canUseTool as (...args: unknown[]) => unknown;
      return session;
    });
    mockSessionResume.mockImplementation((_id: string, opts: Record<string, unknown>) => {
      capturedCanUseTool.fn = opts.canUseTool as (...args: unknown[]) => unknown;
      return session;
    });

    service = new AgentExecutionService(
      db as never,
      mockWorktreeService as never,
      mockTaskService as never,
      mockSessionService as never
    );
  });

  afterEach(async () => {
    // Stop any running agents to keep the planning fire-and-forget loop
    // from leaking timers across tests.
    service.stopAll();
    await clearTestDatabase();
  });

  // F03-01 + F03-02: the planning canUseTool MUST run pre-tool-use hooks and
  // emit a deny verdict for tools outside the agent's whitelist. Without the
  // service-registration wire-up, this assertion fails because the registered
  // pre-hook arrays are empty and canUseTool returns {behavior:'allow'} for
  // every tool name.
  it('denies a non-whitelisted Bash invocation during planning (TOOL_DENIED)', async () => {
    const codespace = await createTestProject({ maxConcurrentAgents: 3 });
    const agent = await createTestAgent(codespace.id, {
      status: 'idle',
      // Critical: Bash is NOT in the whitelist. The whitelist hook installed
      // via createAgentHooks during start() must produce a block verdict.
      config: { model: 'claude-sonnet-4-6', maxTurns: 50, allowedTools: ['Read', 'Glob'] },
    });
    const task = await createTestTask(codespace.id, { column: 'backlog' });
    const worktree = await createTestWorktree(codespace.id, { taskId: task.id });
    const session = await createTestSession(codespace.id, {
      taskId: task.id,
      agentId: agent.id,
    });
    mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
    mockSessionService.create.mockResolvedValue({
      ok: true,
      value: { ...session, presence: {} },
    });

    const startResult = await service.start(agent.id, task.id);
    expect(startResult.ok).toBe(true);

    // Wait for runAgentPlanning to install canUseTool on the SDK session.
    for (let i = 0; i < 200 && !capturedCanUseTool.fn; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(capturedCanUseTool.fn).not.toBeNull();

    // Simulate the SDK invoking canUseTool for a Bash command.
    const verdict = (await capturedCanUseTool.fn!(
      'Bash',
      { command: 'ls -la' },
      { toolUseID: 'tu-bash-deny' }
    )) as Record<string, unknown>;

    // After fix: deny verdict propagates through the registered whitelist hook.
    expect(verdict.behavior).toBe('deny');
    expect(typeof verdict.message).toBe('string');
    expect(verdict.message as string).toContain('Bash');
    expect(verdict.message as string).toContain('not allowed');

    // The deny path also emits a tool:result{isError:true, phase:'planning'}
    // event so the UI can surface the denial.
    const toolResultCall = mockSessionService.publish.mock.calls.find((call) => {
      const evt = call[1] as { type: string };
      return evt.type === 'tool:result';
    });
    expect(toolResultCall).toBeDefined();
    const evt = toolResultCall![1] as { data: Record<string, unknown> };
    expect(evt.data.isError).toBe(true);
    expect(evt.data.phase).toBe('planning');
    expect(typeof evt.data.output).toBe('string');
    expect(evt.data.output as string).toContain('Bash');
  });

  // F03-01 + F03-02: a whitelisted tool MUST flow through (allow verdict)
  // so non-blocked tools still execute. This proves the whitelist hook is
  // not over-blocking.
  it('allows a whitelisted Read invocation during planning', async () => {
    const codespace = await createTestProject({ maxConcurrentAgents: 3 });
    const agent = await createTestAgent(codespace.id, {
      status: 'idle',
      config: { model: 'claude-sonnet-4-6', maxTurns: 50, allowedTools: ['Read'] },
    });
    const task = await createTestTask(codespace.id, { column: 'backlog' });
    const worktree = await createTestWorktree(codespace.id, { taskId: task.id });
    const session = await createTestSession(codespace.id, {
      taskId: task.id,
      agentId: agent.id,
    });
    mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
    mockSessionService.create.mockResolvedValue({
      ok: true,
      value: { ...session, presence: {} },
    });

    const startResult = await service.start(agent.id, task.id);
    expect(startResult.ok).toBe(true);

    for (let i = 0; i < 200 && !capturedCanUseTool.fn; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(capturedCanUseTool.fn).not.toBeNull();

    const verdict = (await capturedCanUseTool.fn!(
      'Read',
      { file_path: '/etc/hostname' },
      { toolUseID: 'tu-read-allow' }
    )) as Record<string, unknown>;

    // Allow verdict (no deny) flows through.
    expect(verdict.behavior).toBe('allow');
    expect(verdict.toolUseID).toBe('tu-read-allow');
  });

  // F03-01: the open-gate sentinel ['*'] still allows everything (no
  // accidental over-blocking when the agent is configured permissively).
  it('allows any tool during planning when whitelist contains the * sentinel', async () => {
    const codespace = await createTestProject({ maxConcurrentAgents: 3 });
    const agent = await createTestAgent(codespace.id, {
      status: 'idle',
      config: { model: 'claude-sonnet-4-6', maxTurns: 50, allowedTools: ['*'] },
    });
    const task = await createTestTask(codespace.id, { column: 'backlog' });
    const worktree = await createTestWorktree(codespace.id, { taskId: task.id });
    const session = await createTestSession(codespace.id, {
      taskId: task.id,
      agentId: agent.id,
    });
    mockWorktreeService.create.mockResolvedValue({ ok: true, value: worktree });
    mockSessionService.create.mockResolvedValue({
      ok: true,
      value: { ...session, presence: {} },
    });

    await service.start(agent.id, task.id);

    for (let i = 0; i < 200 && !capturedCanUseTool.fn; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(capturedCanUseTool.fn).not.toBeNull();

    const verdict = (await capturedCanUseTool.fn!(
      'Bash',
      { command: 'echo hi' },
      { toolUseID: 'tu-bash-allow' }
    )) as Record<string, unknown>;

    expect(verdict.behavior).toBe('allow');
  });
});
