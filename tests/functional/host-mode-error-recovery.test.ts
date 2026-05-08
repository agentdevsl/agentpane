/**
 * Functional Test: Host-Mode Agent Error Recovery (arch29-W2-B / F03-06)
 *
 * Verifies that when the host-mode agent execution path throws mid-run, the
 * task does not stay stuck in `in_progress`. Per the regression in F03-06, the
 * existing catch block at `executeAgentExecution`/`executeAgentAsync` updates
 * `agentRuns` and `agents` rows but never moved the task column, leaving the
 * kanban board showing ghost tasks until the next server restart fired
 * `recoverOrphanedTasks`.
 *
 * Real-service rule (per CLAUDE.md "Functional Tests: Real Service Transitions"):
 * - Real `AgentExecutionService` exercised end-to-end via `start()`, which
 *   wires real `WorktreeService`/`SessionService` boundary mocks plus the real
 *   db row transitions.
 * - Only the Claude Agent SDK boundary (`runAgentPlanning` /
 *   `runAgentExecution`) is mocked — those mocks throw to simulate the
 *   regression's underlying conditions (SDK 401, network, codespace-lookup
 *   throw, etc.).
 *
 * Run separately: npx vitest run --project functional
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRuns, agents, sessionEvents, tasks } from '../../src/db/schema';
import { AgentExecutionService } from '../../src/services/agent/agent-execution.service';
import { SessionService } from '../../src/services/session.service';
import { TaskService } from '../../src/services/task.service';
import { WorktreeService } from '../../src/services/worktree.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import { createInMemoryStreams } from '../helpers/mocks';

// ---------- mocks ----------
//
// Only the SDK boundary is mocked (CLAUDE.md "external I/O boundaries").
// Each mock is per-test reassignable so each scenario can throw or resolve
// at a different point in the lifecycle.

const mockRunAgentPlanning = vi.fn();
const mockRunAgentExecution = vi.fn();
const mockHandleAgentError = vi.fn().mockReturnValue({ action: 'fail', reason: 'sdk_error' });

vi.mock('../../src/lib/agents/stream-handler.js', () => ({
  runAgentPlanning: (...args: unknown[]) => mockRunAgentPlanning(...args),
  runAgentExecution: (...args: unknown[]) => mockRunAgentExecution(...args),
}));

vi.mock('../../src/lib/agents/recovery.js', () => ({
  handleAgentError: (...args: unknown[]) => mockHandleAgentError(...args),
}));

vi.mock('../../src/services/settings.service.js', () => ({
  getGlobalDefaultModel: vi.fn().mockResolvedValue('claude-sonnet-4-6'),
  getAgentMaxRuntimeMs: vi.fn().mockResolvedValue(4 * 60 * 60 * 1000),
  DEFAULT_AGENT_MAX_RUNTIME_MS: 4 * 60 * 60 * 1000,
}));

// ---------- service wiring (boundary mocks per CLAUDE.md) ----------

function createMockCommandRunner() {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    execArgs: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  };
}

// ---------- test suite ----------

describe('Host-Mode Agent Error Recovery (arch29-W2-B / F03-06)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: AgentExecutionService;
  let sessionService: SessionService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();

    mockRunAgentPlanning.mockReset();
    mockRunAgentExecution.mockReset();
    mockHandleAgentError.mockReset();
    mockHandleAgentError.mockReturnValue({ action: 'fail', reason: 'sdk_error' });

    // Each test wires real services to the DB; only command execution, stream
    // transport, and the SDK/recovery boundaries are mocked.
  });

  afterEach(async () => {
    if (service) {
      service.stopAll();
    }
    sessionService?.destroy();
    // Allow pending async operations to settle after abort
    await new Promise((resolve) => setTimeout(resolve, 100));
    await clearTestDatabase();
  });

  /**
   * Helper: create the standard fixtures and an AgentExecutionService wired to
   * real DB-backed services. Returns the entity IDs and the service instance.
   */
  async function setupHostMode() {
    const codespace = await createTestProject({ id: 'cs-host-error' });
    const agent = await createTestAgent(codespace.id, {
      id: 'agent-host-error',
      status: 'idle',
    });
    const task = await createTestTask(codespace.id, {
      id: 'task-host-error',
      column: 'backlog',
      title: 'Host-mode error recovery task',
      skillId: 'test-skill',
      skillName: 'Test Skill',
    });

    const streams = createInMemoryStreams();
    sessionService = new SessionService(db as never, streams, {
      baseUrl: 'http://localhost:3000',
    });
    const worktreeService = new WorktreeService(db as never, createMockCommandRunner());
    const taskService = new TaskService(db as never, worktreeService);

    service = new AgentExecutionService(
      db as never,
      worktreeService,
      taskService,
      sessionService as never
    );

    return { codespace, agent, task };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F03-06 regression: planning-phase throw must revert task to backlog
  // ═══════════════════════════════════════════════════════════════════════

  it('planning-phase SDK throw reverts task from in_progress to backlog with lastAgentStatus=error', async () => {
    // Arrange — host-mode agent enters planning, SDK throws (simulating 401,
    // network failure, codespace-lookup throw mid-flight, etc.).
    mockRunAgentPlanning.mockRejectedValue(new Error('SDK 401: invalid api key'));

    const { agent, task } = await setupHostMode();

    // Act — real service.start() transitions task to in_progress, then fires
    // executeAgentAsync() in the background; the mocked SDK throw triggers the
    // catch path that we are asserting on.
    const startResult = await service.start(agent.id, task.id);
    expect(startResult.ok).toBe(true);

    // Wait for the catch path to update the task.
    await vi.waitFor(
      async () => {
        const updated = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
        // Without the fix: column stays 'in_progress' forever (ghost task).
        // With the fix: catch reverts column to 'backlog' so the task is
        // immediately retryable.
        expect(updated?.column).toBe('backlog');
      },
      { timeout: 5000 }
    );

    // Assert — full revert of side-effects and lastAgentStatus is 'error'.
    const final = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(final?.column).toBe('backlog');
    expect(final?.lastAgentStatus).toBe('error');
    expect(final?.agentId).toBeNull();
    expect(final?.sessionId).toBeNull();
    expect(final?.worktreeId).toBeNull();
    expect(final?.branch).toBeNull();
    expect(final?.plan).toBeNull();
    expect(final?.planOptions).toBeNull();

    // Agent status set to 'error' (recovery.action === 'fail').
    const finalAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(finalAgent?.status).toBe('error');

    // agentRuns row recorded with status='error' and the original error message.
    const runs = await db.query.agentRuns.findMany({ where: eq(agentRuns.taskId, task.id) });
    expect(runs.length).toBeGreaterThan(0);
    const lastRun = runs[runs.length - 1];
    expect(lastRun?.status).toBe('error');
    expect(lastRun?.errorMessage).toContain('SDK 401');
    expect(lastRun?.completedAt).toBeTruthy();

    const errorEvent = await db.query.sessionEvents.findFirst({
      where: eq(sessionEvents.type, 'agent:error'),
    });
    expect(errorEvent?.data).toMatchObject({
      agentId: agent.id,
      error: expect.stringContaining('SDK 401'),
    });

    // In-memory state cleared so the agent is re-startable.
    expect(service.isRunning(agent.id)).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // F03-06 regression: execution-phase throw must revert task to backlog
  // ═══════════════════════════════════════════════════════════════════════

  it('execution-phase SDK throw reverts task from in_progress to backlog with lastAgentStatus=error', async () => {
    // Arrange — planning succeeds, then resume() fires execution, which throws.
    // This tests the executeAgentExecution() catch path specifically.
    mockRunAgentPlanning.mockResolvedValue({
      status: 'planning',
      turnCount: 5,
      plan: 'Approved plan content',
      planOptions: { sdkSessionId: 'sdk-resume' },
      sdkSessionId: 'sdk-resume',
    });
    mockRunAgentExecution.mockRejectedValue(new Error('Worktree resolution failed mid-execution'));

    const { agent, task } = await setupHostMode();

    // Phase 1 — start kicks off planning, which (mocked) succeeds, leaving
    // task in waiting_approval and agent.status='planning'.
    const startResult = await service.start(agent.id, task.id);
    expect(startResult.ok).toBe(true);

    await vi.waitFor(async () => {
      const a = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
      expect(a?.status).toBe('planning');
    });

    // TEST-SETUP: Mid-flow setup — planning persists 'waiting_approval' on
    // the task. To exercise the execution-phase catch we need the task back
    // in 'in_progress' (which is what PlanApprovalService.approvePlan /
    // TaskService.approve do before resume() runs). The real plan-approve
    // path requires a sandbox container we don't have in this functional
    // test. For this test we use the real resume() path — it sets
    // agent.status='running' and fires executeAgentExecution() in the
    // background; the direct write is the precondition for resume().
    const plannedTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(plannedTask?.sessionId).toBeTruthy();
    expect(plannedTask?.worktreeId).toBeTruthy();

    await db
      .update(tasks)
      .set({
        column: 'in_progress',
        worktreeId: plannedTask?.worktreeId,
        sessionId: plannedTask?.sessionId,
        agentId: agent.id,
        plan: 'Approved plan content',
        planOptions: { sdkSessionId: 'sdk-resume' },
      })
      .where(eq(tasks.id, task.id));

    // Phase 2 — resume() triggers executeAgentExecution(), which (mocked) throws.
    const resumeResult = await service.resume(agent.id);
    expect(resumeResult.ok).toBe(true);

    // Wait for the execution-phase catch path to update the task.
    await vi.waitFor(
      async () => {
        const updated = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
        // Without the fix: column stays 'in_progress' forever.
        expect(updated?.column).toBe('backlog');
      },
      { timeout: 5000 }
    );

    // Assert — task reverted to backlog with lastAgentStatus='error'.
    const final = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(final?.column).toBe('backlog');
    expect(final?.lastAgentStatus).toBe('error');
    expect(final?.agentId).toBeNull();
    expect(final?.sessionId).toBeNull();
    expect(final?.worktreeId).toBeNull();
    expect(final?.branch).toBeNull();

    const runs = await db.query.agentRuns.findMany({ where: eq(agentRuns.taskId, task.id) });
    const lastRun = runs[runs.length - 1];
    expect(lastRun?.status).toBe('error');
    expect(lastRun?.errorMessage).toContain('Worktree resolution failed');

    const errorEvent = await db.query.sessionEvents.findFirst({
      where: eq(sessionEvents.type, 'agent:error'),
    });
    expect(errorEvent?.data).toMatchObject({ agentId: agent.id });

    expect(service.isRunning(agent.id)).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P0-6: host-mode happy path must complete through real services
  // ═══════════════════════════════════════════════════════════════════════

  it('host-mode start → planning succeeds → resume → execution completes', async () => {
    mockRunAgentPlanning.mockResolvedValue({
      status: 'planning',
      turnCount: 4,
      plan: 'Host-mode implementation plan',
      planOptions: { allowedPrompts: [{ tool: 'Bash', prompt: 'bun test' }] },
      sdkSessionId: 'sdk-host-happy',
    });
    mockRunAgentExecution.mockResolvedValue({
      status: 'completed',
      turnCount: 11,
    });

    const { agent, task } = await setupHostMode();

    const startResult = await service.start(agent.id, task.id);
    expect(startResult.ok).toBe(true);

    await vi.waitFor(async () => {
      const planned = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(planned?.column).toBe('waiting_approval');
      expect(planned?.lastAgentStatus).toBe('planning');
    });

    const planned = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(planned?.plan).toBe('Host-mode implementation plan');
    expect(planned?.sessionId).toBeTruthy();
    expect(planned?.worktreeId).toBeTruthy();
    expect((planned?.planOptions as { sdkSessionId?: string } | null)?.sdkSessionId).toBe(
      'sdk-host-happy'
    );

    const resumeResult = await service.resume(agent.id);
    expect(resumeResult.ok).toBe(true);

    await vi.waitFor(async () => {
      const finalAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
      expect(finalAgent?.status).toBe('idle');
    });

    expect(mockRunAgentExecution).toHaveBeenCalledOnce();
    const executionInput = mockRunAgentExecution.mock.calls[0]?.[0] as
      | { sdkSessionId?: string; prompt?: string }
      | undefined;
    expect(executionInput?.sdkSessionId).toBe('sdk-host-happy');
    expect(executionInput?.prompt).toContain('Host-mode implementation plan');

    const finalTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(finalTask?.column).toBe('waiting_approval');
    expect(finalTask?.completedAt).toBeTruthy();

    const runs = await db.query.agentRuns.findMany({ where: eq(agentRuns.taskId, task.id) });
    expect(runs.map((run) => run.status).sort()).toEqual(['completed', 'running']);
    expect(runs.at(-1)?.turnsUsed).toBe(11);
    expect(service.isRunning(agent.id)).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CAS guard: do not clobber a user-driven move
  // ═══════════════════════════════════════════════════════════════════════

  it('catch does not overwrite task column when user has already moved it elsewhere', async () => {
    // Arrange — planning will throw, but mid-flight we simulate a user
    // dragging the task to a different column. The CAS guard
    // `where column='in_progress'` must prevent the catch from clobbering it.
    let planningRejected = false;
    mockRunAgentPlanning.mockImplementation(async () => {
      // Wait briefly so the user-move below races with the catch.
      await new Promise((resolve) => setTimeout(resolve, 50));
      planningRejected = true;
      throw new Error('SDK boom');
    });

    const { agent, task } = await setupHostMode();

    const startResult = await service.start(agent.id, task.id);
    expect(startResult.ok).toBe(true);

    // Race: user moves task to waiting_approval before catch fires.
    // (TEST-SETUP: manual move simulating PlanApprovalService.handlePlanReady
    //  racing the SDK throw — direct DB write here is intentional to model the
    //  race precisely; CAS in production is the same shape we assert.)
    await db.update(tasks).set({ column: 'waiting_approval' }).where(eq(tasks.id, task.id));

    // Wait for the catch to fire.
    await vi.waitFor(() => expect(planningRejected).toBe(true), { timeout: 5000 });
    // Plus a small grace for the catch's task update.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Assert — column was NOT overwritten by the catch (CAS prevented it).
    const final = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(final?.column).toBe('waiting_approval');

    // Agent and run state still cleaned up.
    const finalAgent = await db.query.agents.findFirst({ where: eq(agents.id, agent.id) });
    expect(finalAgent?.status).toBe('error');
    expect(service.isRunning(agent.id)).toBe(false);
  });
});
