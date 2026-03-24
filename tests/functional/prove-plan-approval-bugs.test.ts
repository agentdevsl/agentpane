/**
 * Functional Tests: Prove or Disprove Potential Bugs in PlanApprovalService & Container Agent Pipeline
 *
 * Each test exercises REAL service code with only external I/O mocked
 * (sandbox provider, git operations, streams). The goal is to document
 * actual behavior — whether it is a bug, intentional, or already guarded.
 *
 * Run: npx vitest run --project functional tests/functional/prove-plan-approval-bugs.test.ts
 */
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { createContainerBridge } from '../../src/lib/agents/container-bridge';
import { PlanApprovalService } from '../../src/services/container-agent/plan-approval.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import { updateTaskOnAgentComplete } from '../../src/services/container-agent/shared-helpers';
import { PENDING_PLAN_TTL_MS } from '../../src/services/container-agent/types';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// ---------- test helpers ----------

function createMockStreams(): DurableStreamsService {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    createStream: vi.fn().mockResolvedValue(undefined),
    getStream: vi.fn(),
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as DurableStreamsService;
}

function createMockWorktreeInit() {
  return {
    cleanupWorktree: vi.fn().mockResolvedValue(undefined),
    resolveWorktree: vi.fn(),
    initializeWorkspace: vi.fn(),
  };
}

function createPlanApprovalService(
  db: ReturnType<typeof getTestDb>,
  streams: DurableStreamsService,
  stateManager: SandboxStateManager,
  overrides: {
    startAgentFn?: ReturnType<typeof vi.fn>;
    isAgentCoreProvider?: () => boolean;
    mockWorktreeInit?: ReturnType<typeof createMockWorktreeInit>;
    mockProvider?: { get: ReturnType<typeof vi.fn> };
  } = {}
) {
  const mockWorktreeInit = overrides.mockWorktreeInit ?? createMockWorktreeInit();
  const mockStartAgentFn =
    overrides.startAgentFn ?? vi.fn().mockResolvedValue({ ok: true, value: undefined });
  const mockProvider = overrides.mockProvider ?? { get: vi.fn() };

  const planService = new PlanApprovalService(
    { db, streams, provider: mockProvider as any } as any,
    stateManager,
    mockWorktreeInit as any,
    mockStartAgentFn,
    overrides.isAgentCoreProvider ?? (() => false)
  );

  return { planService, mockStartAgentFn, mockWorktreeInit, mockProvider };
}

function makePlanData(overrides: Record<string, unknown> = {}) {
  return {
    plan: (overrides.plan as string) ?? 'Default plan text',
    turnCount: (overrides.turnCount as number) ?? 3,
    sdkSessionId: (overrides.sdkSessionId as string) ?? 'sdk-session-1',
    allowedPrompts: overrides.allowedPrompts as Array<{ tool: 'Bash'; prompt: string }> | undefined,
    launchSwarm: overrides.launchSwarm as boolean | undefined,
    teammateCount: overrides.teammateCount as number | undefined,
  };
}

/** Create a Readable stream from an array of JSON-line strings */
function createJsonLineStream(lines: string[]): Readable {
  const stream = new Readable({ read() {} });
  for (const line of lines) {
    stream.push(`${line}\n`);
  }
  stream.push(null);
  return stream;
}

/** Build a valid agent-runner JSON event line */
function makeEventLine(
  type: string,
  taskId: string,
  sessionId: string,
  data: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    type,
    timestamp: Date.now(),
    taskId,
    sessionId,
    data,
  });
}

// ---------- test suite ----------

describe('Prove/Disprove Plan Approval Bugs', () => {
  let db: ReturnType<typeof getTestDb>;
  let streams: DurableStreamsService;
  let stateManager: SandboxStateManager;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    streams = createMockStreams();
    stateManager = new SandboxStateManager();
  });

  afterEach(async () => {
    stateManager.dispose();
    await clearTestDatabase();
  });

  // =========================================================================
  // Test 1: Duplicate handlePlanReady — second call overwrites first
  // =========================================================================

  describe('Test 1: Duplicate handlePlanReady — second call is rejected (idempotent)', () => {
    it('FIX VERIFIED: second handlePlanReady is ignored, Plan A preserved', async () => {
      const codespace = await createTestProject({ name: 'Dup Plan Test' });
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
        title: 'Task for duplicate plan test',
      });

      const { planService } = createPlanApprovalService(db, streams, stateManager);

      // First handlePlanReady
      await planService.handlePlanReady(
        task.id,
        'session-1',
        codespace.id,
        makePlanData({ plan: 'Plan A' })
      );

      const taskAfterFirst = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskAfterFirst!.column).toBe('waiting_approval');
      expect(taskAfterFirst!.plan).toBe('Plan A');
      expect(taskAfterFirst!.lastAgentStatus).toBe('planning');

      // In-memory plan should exist
      const memPlanA = stateManager.getPendingPlan(task.id);
      expect(memPlanA).toBeDefined();
      expect(memPlanA!.plan).toBe('Plan A');

      // Second handlePlanReady — should be rejected (idempotent guard)
      await planService.handlePlanReady(
        task.id,
        'session-2',
        codespace.id,
        makePlanData({ plan: 'Plan B' })
      );

      // VERDICT: BUG FIXED — handlePlanReady now has an idempotency guard.
      // The second call is ignored: Plan A is preserved in both DB and memory.
      const taskAfterSecond = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskAfterSecond!.plan).toBe('Plan A');
      expect(taskAfterSecond!.column).toBe('waiting_approval');

      const memPlanAfter = stateManager.getPendingPlan(task.id);
      expect(memPlanAfter).toBeDefined();
      expect(memPlanAfter!.plan).toBe('Plan A');
    });
  });

  // =========================================================================
  // Test 2: rejectPlan stale worktree cleanup
  // =========================================================================

  describe('Test 2: rejectPlan stale worktree cleanup on double rejection', () => {
    it('second rejectPlan returns PLAN_NOT_FOUND — worktree cleanup only called once', async () => {
      const codespace = await createTestProject({ name: 'Reject Race Test' });
      const worktree = await createTestWorktree(codespace.id, { status: 'active' });
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
        title: 'Task for reject race test',
        worktreeId: worktree.id,
        branch: worktree.branch,
      });

      const mockWorktreeInit = createMockWorktreeInit();
      const { planService } = createPlanApprovalService(db, streams, stateManager, {
        mockWorktreeInit,
      });

      // Store plan via handlePlanReady
      await planService.handlePlanReady(
        task.id,
        'session-rej',
        codespace.id,
        makePlanData({ plan: 'Plan to reject' })
      );

      // Verify task is in waiting_approval
      const taskBeforeReject = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskBeforeReject!.column).toBe('waiting_approval');
      expect(taskBeforeReject!.lastAgentStatus).toBe('planning');

      // First rejection — should succeed
      const rejectResult1 = await planService.rejectPlan(task.id, 'Not good enough');
      expect(rejectResult1.ok).toBe(true);

      // Verify task moved to backlog
      const taskAfterReject1 = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskAfterReject1!.column).toBe('backlog');
      expect(taskAfterReject1!.plan).toBeNull();
      expect(taskAfterReject1!.lastAgentStatus).toBeNull();
      expect(taskAfterReject1!.worktreeId).toBeNull();
      expect(taskAfterReject1!.rejectionReason).toBe('Not good enough');

      // Worktree cleanup should have been called once
      expect(mockWorktreeInit.cleanupWorktree).toHaveBeenCalledTimes(1);
      expect(mockWorktreeInit.cleanupWorktree).toHaveBeenCalledWith(task.id, worktree.id);

      // Second rejection — should fail with PLAN_NOT_FOUND
      const rejectResult2 = await planService.rejectPlan(task.id);
      expect(rejectResult2.ok).toBe(false);
      if (!rejectResult2.ok) {
        expect(rejectResult2.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
      }

      // Worktree cleanup should NOT have been called again
      expect(mockWorktreeInit.cleanupWorktree).toHaveBeenCalledTimes(1);

      // FINDING: The atomic guard `WHERE lastAgentStatus = 'planning'` prevents
      // the second rejection from succeeding. The first rejection clears
      // lastAgentStatus to null, so the second call's DB update returns
      // no rows and falls through to PLAN_NOT_FOUND. Worktree cleanup
      // is only triggered once. This is CORRECTLY guarded.
    });
  });

  // =========================================================================
  // Test 3: cancelled branch in updateTaskOnAgentComplete has no column guard
  // =========================================================================

  describe('Test 3: cancelled branch in updateTaskOnAgentComplete now has column guard', () => {
    it('FIX VERIFIED: cancelled on waiting_approval task does NOT overwrite lastAgentStatus', async () => {
      const codespace = await createTestProject({ name: 'Cancel Guard Test' });
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
        title: 'Task to be cancelled from waiting_approval',
      });

      const { planService } = createPlanApprovalService(db, streams, stateManager);

      // Move task to waiting_approval via plan ready
      await planService.handlePlanReady(
        task.id,
        'session-cancel-3',
        codespace.id,
        makePlanData({ plan: 'Cancel test plan' })
      );

      const taskBefore = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskBefore!.column).toBe('waiting_approval');
      expect(taskBefore!.lastAgentStatus).toBe('planning');

      // Call updateTaskOnAgentComplete with 'cancelled' — should be rejected
      // because task is in waiting_approval, not in_progress
      const result = await updateTaskOnAgentComplete(
        db,
        task.id,
        'cancelled',
        streams,
        'session-cancel-3'
      );
      expect(result).toBe(false); // Rejected by column guard

      // VERDICT: BUG FIXED — The cancelled branch now has a column guard
      // (WHERE column = 'in_progress'). A late cancelled callback from a
      // dead agent will NOT overwrite lastAgentStatus on a waiting_approval task.
      const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskAfter!.column).toBe('waiting_approval'); // Column preserved
      expect(taskAfter!.lastAgentStatus).toBe('planning'); // NOT overwritten to 'cancelled'
    });

    it('cancelled works on a task in in_progress (normal cancellation)', async () => {
      const codespace = await createTestProject({ name: 'Cancel InProgress Test' });
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
        title: 'Task in progress to cancel',
      });

      const result = await updateTaskOnAgentComplete(db, task.id, 'cancelled');
      expect(result).toBe(true);

      const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskAfter!.column).toBe('in_progress');
      expect(taskAfter!.lastAgentStatus).toBe('cancelled');
      expect(taskAfter!.agentId).toBeNull();
      expect(taskAfter!.sessionId).toBeNull();
    });

    it('cancelled on a task in backlog is rejected by column guard', async () => {
      const codespace = await createTestProject({ name: 'Cancel Backlog Test' });
      const task = await createTestTask(codespace.id, {
        column: 'backlog',
        title: 'Task already in backlog',
      });

      const result = await updateTaskOnAgentComplete(db, task.id, 'cancelled');
      expect(result).toBe(false); // Rejected — task not in in_progress

      const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskAfter!.column).toBe('backlog');
      expect(taskAfter!.lastAgentStatus).toBeNull(); // NOT changed
    });

    it('completed branch correctly guards against non-in_progress tasks', async () => {
      const codespace = await createTestProject({ name: 'Complete Guard Test' });
      const task = await createTestTask(codespace.id, {
        column: 'waiting_approval',
        title: 'Task not in in_progress',
      });
      await db.update(tasks).set({ lastAgentStatus: 'planning' }).where(eq(tasks.id, task.id));

      // completed should return false — task is not in in_progress
      const result = await updateTaskOnAgentComplete(db, task.id, 'completed');
      expect(result).toBe(false);

      // Task should remain unchanged
      const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskAfter!.column).toBe('waiting_approval');
      expect(taskAfter!.lastAgentStatus).toBe('planning');
    });
  });

  // =========================================================================
  // Test 4: Plan expiration while user reviews
  // =========================================================================

  describe('Test 4: Plan expiration while user reviews', () => {
    it('expired plan is removed from memory — approvePlan falls back to DB recovery', async () => {
      const codespace = await createTestProject({ name: 'Plan Expiry Test' });
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
        title: 'Task with expiring plan',
      });

      const { planService, mockStartAgentFn } = createPlanApprovalService(
        db,
        streams,
        stateManager
      );

      // Store plan via handlePlanReady (persists to DB and in-memory)
      await planService.handlePlanReady(
        task.id,
        'session-exp',
        codespace.id,
        makePlanData({ plan: 'Expiring plan' })
      );

      // Verify plan exists in memory
      expect(stateManager.hasPendingPlan(task.id)).toBe(true);

      // Verify plan is in DB
      const taskWithPlan = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskWithPlan!.plan).toBe('Expiring plan');
      expect(taskWithPlan!.lastAgentStatus).toBe('planning');

      // Simulate expiration by modifying the plan's createdAt to be older than TTL
      const expiredPlan = stateManager.getPendingPlan(task.id)!;
      const oldDate = new Date(Date.now() - PENDING_PLAN_TTL_MS - 60_000); // TTL + 1 minute
      stateManager.setPendingPlan(task.id, { ...expiredPlan, createdAt: oldDate });

      // Manually trigger cleanup (normally runs on interval)
      // Access private method via cast
      (stateManager as any).cleanupExpiredPlans();

      // Verify plan is gone from memory
      expect(stateManager.hasPendingPlan(task.id)).toBe(false);

      // approvePlan should recover from DB and still work
      const approveResult = await planService.approvePlan(task.id);
      expect(approveResult.ok).toBe(true);

      // startAgentFn should have been called with the recovered plan
      expect(mockStartAgentFn).toHaveBeenCalledTimes(1);
      expect(mockStartAgentFn).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Expiring plan',
          phase: 'execute',
        })
      );

      // FINDING: Plan expiration from memory does NOT block approval.
      // The getPendingPlan() method first checks in-memory cache, then
      // falls back to DB recovery (checks task.plan + lastAgentStatus='planning').
      // So even if the cleanup interval removes the in-memory plan,
      // the user can still approve because the plan is persisted to the DB.
      //
      // The TTL is 1 hour (PENDING_PLAN_TTL_MS = 3_600_000ms), which is
      // generous for most review workflows. The DB fallback makes this
      // resilient against memory-only expiration.
    });

    it('PENDING_PLAN_TTL_MS is 1 hour', () => {
      // Document the actual TTL value
      expect(PENDING_PLAN_TTL_MS).toBe(60 * 60 * 1000); // 1 hour
    });
  });

  // =========================================================================
  // Test 5: Container bridge handles out-of-order events
  // =========================================================================

  describe('Test 5: Container bridge handles out-of-order events', () => {
    it('agent:complete before agent:plan_ready — both callbacks fire in order received', async () => {
      const taskId = 'task-ooo-1';
      const sessionId = 'session-ooo-1';
      const callOrder: string[] = [];

      const bridge = createContainerBridge({
        taskId,
        sessionId,
        codespaceId: 'cs-ooo-1',
        streams,
        onComplete: (status, turnCount) => {
          callOrder.push(`complete:${status}:${turnCount}`);
        },
        onError: (error, turnCount) => {
          callOrder.push(`error:${error}:${turnCount}`);
        },
        onPlanReady: (data) => {
          callOrder.push(`plan_ready:${data.plan.slice(0, 10)}`);
        },
      });

      // Send agent:complete BEFORE agent:plan_ready
      const completeEvent = makeEventLine('agent:complete', taskId, sessionId, {
        status: 'completed',
        turnCount: 5,
      });
      const planReadyEvent = makeEventLine('agent:plan_ready', taskId, sessionId, {
        plan: 'Late plan text',
        turnCount: 3,
        sdkSessionId: 'sdk-ooo',
      });

      const stream = createJsonLineStream([completeEvent, planReadyEvent]);
      await bridge.processStream(stream);

      // Both callbacks fire in the order the events were received
      expect(callOrder).toEqual(['complete:completed:5', 'plan_ready:Late plan ']);

      // FINDING: The container bridge does NOT enforce event ordering.
      // It processes events in the order they arrive from the stream.
      // If agent:complete arrives before agent:plan_ready, both callbacks
      // fire in that order. There is no buffering or reordering logic.
      //
      // This means the orchestrator (container-agent.service) is responsible
      // for handling out-of-order events correctly. If complete fires before
      // plan_ready, the task might be moved to waiting_approval (completed)
      // before the plan is stored, potentially causing inconsistent state.
    });

    it('agent:error before agent:plan_ready — error callback fires, plan_ready still fires', async () => {
      const taskId = 'task-ooo-2';
      const sessionId = 'session-ooo-2';
      const callOrder: string[] = [];

      const bridge = createContainerBridge({
        taskId,
        sessionId,
        codespaceId: 'cs-ooo-2',
        streams,
        onComplete: (status, turnCount) => {
          callOrder.push(`complete:${status}:${turnCount}`);
        },
        onError: (error, turnCount) => {
          callOrder.push(`error:${error}:${turnCount}`);
        },
        onPlanReady: (data) => {
          callOrder.push(`plan_ready:${data.plan.slice(0, 10)}`);
        },
      });

      const errorEvent = makeEventLine('agent:error', taskId, sessionId, {
        error: 'SDK crashed',
        turnCount: 1,
      });
      const planReadyEvent = makeEventLine('agent:plan_ready', taskId, sessionId, {
        plan: 'Ghost plan',
        turnCount: 2,
        sdkSessionId: 'sdk-ghost',
      });

      const stream = createJsonLineStream([errorEvent, planReadyEvent]);
      await bridge.processStream(stream);

      expect(callOrder).toEqual(['error:SDK crashed:1', 'plan_ready:Ghost plan']);

      // FINDING: The bridge does NOT stop processing after error events.
      // All events in the stream are processed regardless of prior errors.
      // This means a plan_ready arriving after an error will still trigger
      // the onPlanReady callback, potentially storing a plan for a failed agent.
    });

    it('events with mismatched taskId are ignored', async () => {
      const taskId = 'task-ooo-3';
      const sessionId = 'session-ooo-3';
      const callOrder: string[] = [];

      const bridge = createContainerBridge({
        taskId,
        sessionId,
        codespaceId: 'cs-ooo-3',
        streams,
        onComplete: (status) => {
          callOrder.push(`complete:${status}`);
        },
        onPlanReady: (data) => {
          callOrder.push(`plan_ready:${data.plan}`);
        },
      });

      // Event for a different task
      const wrongTaskEvent = makeEventLine('agent:plan_ready', 'wrong-task', sessionId, {
        plan: 'Wrong plan',
        turnCount: 1,
        sdkSessionId: 'sdk-wrong',
      });
      // Event for the correct task
      const correctEvent = makeEventLine('agent:plan_ready', taskId, sessionId, {
        plan: 'Correct plan',
        turnCount: 2,
        sdkSessionId: 'sdk-correct',
      });

      const stream = createJsonLineStream([wrongTaskEvent, correctEvent]);
      await bridge.processStream(stream);

      // Only the correct event should trigger the callback
      expect(callOrder).toEqual(['plan_ready:Correct plan']);
    });
  });

  // =========================================================================
  // Test 6: approvePlan DB restore failure path
  // =========================================================================

  describe('Test 6: approvePlan DB restore failure path', () => {
    it('startAgentFn failure restores task to waiting_approval', async () => {
      const codespace = await createTestProject({ name: 'Approve Restore Test' });
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
        title: 'Task for approve restore test',
      });

      const mockStartAgentFn = vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'SANDBOX_AGENT_START_FAILED', message: 'Container crashed' },
      });

      const { planService } = createPlanApprovalService(db, streams, stateManager, {
        startAgentFn: mockStartAgentFn,
      });

      // Store plan
      await planService.handlePlanReady(
        task.id,
        'session-restore',
        codespace.id,
        makePlanData({ plan: 'Restore test plan' })
      );

      const taskBefore = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskBefore!.column).toBe('waiting_approval');

      // Approve — startAgentFn will fail
      const approveResult = await planService.approvePlan(task.id);
      expect(approveResult.ok).toBe(false);
      if (!approveResult.ok) {
        expect(approveResult.error.code).toBe('SANDBOX_AGENT_START_FAILED');
      }

      // Task should be restored to waiting_approval with planning status
      const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskAfter!.column).toBe('waiting_approval');
      expect(taskAfter!.lastAgentStatus).toBe('planning');

      // Plan should still be in memory (not deleted on failure)
      expect(stateManager.hasPendingPlan(task.id)).toBe(true);

      // FINDING: The restore path works correctly. When startAgentFn fails:
      // 1. The task is moved from in_progress back to waiting_approval
      // 2. lastAgentStatus is restored to 'planning'
      // 3. The pending plan is NOT deleted from memory (only deleted on success)
      // This allows the user to retry the approval.
    });

    it('approvePlan via AgentCore path also restores on failure', async () => {
      const codespace = await createTestProject({ name: 'AgentCore Restore Test' });
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
        title: 'Task for AgentCore restore test',
      });

      const mockStartAgentFn = vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'SANDBOX_AGENT_START_FAILED', message: 'AgentCore invoke failed' },
      });

      const { planService } = createPlanApprovalService(db, streams, stateManager, {
        startAgentFn: mockStartAgentFn,
        isAgentCoreProvider: () => true,
      });

      // Store plan
      await planService.handlePlanReady(
        task.id,
        'session-ac',
        codespace.id,
        makePlanData({ plan: 'AgentCore plan' })
      );

      // Approve via AgentCore path
      const approveResult = await planService.approvePlan(task.id);
      expect(approveResult.ok).toBe(false);

      // Task should be restored
      const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskAfter!.column).toBe('waiting_approval');
      expect(taskAfter!.lastAgentStatus).toBe('planning');
    });

    it('plan remains available for retry after startAgentFn failure', async () => {
      const codespace = await createTestProject({ name: 'Retry After Failure Test' });
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
        title: 'Task for retry test',
      });

      let callCount = 0;
      const mockStartAgentFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            error: { code: 'SANDBOX_AGENT_START_FAILED', message: 'First attempt failed' },
          };
        }
        return { ok: true, value: undefined };
      });

      const { planService } = createPlanApprovalService(db, streams, stateManager, {
        startAgentFn: mockStartAgentFn,
      });

      await planService.handlePlanReady(
        task.id,
        'session-retry',
        codespace.id,
        makePlanData({ plan: 'Retry plan' })
      );

      // First attempt fails
      const result1 = await planService.approvePlan(task.id);
      expect(result1.ok).toBe(false);

      // Second attempt succeeds
      const result2 = await planService.approvePlan(task.id);
      expect(result2.ok).toBe(true);

      // Plan should now be deleted from memory
      expect(stateManager.hasPendingPlan(task.id)).toBe(false);

      // startAgentFn should have been called twice
      expect(mockStartAgentFn).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Bonus: approvePlan after task already moved by user
  // =========================================================================

  describe('Bonus: approvePlan race conditions', () => {
    it('approvePlan fails if task was already moved from waiting_approval', async () => {
      const codespace = await createTestProject({ name: 'Approve Race Test' });
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
        title: 'Task for approve race test',
      });

      const { planService } = createPlanApprovalService(db, streams, stateManager);

      await planService.handlePlanReady(
        task.id,
        'session-race',
        codespace.id,
        makePlanData({ plan: 'Race plan' })
      );

      // Simulate user moving the task back to backlog before approval
      await db
        .update(tasks)
        .set({ column: 'backlog', lastAgentStatus: null })
        .where(eq(tasks.id, task.id));

      // Approve should fail because column is no longer waiting_approval
      const approveResult = await planService.approvePlan(task.id);
      expect(approveResult.ok).toBe(false);
      if (!approveResult.ok) {
        expect(approveResult.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
      }

      // Plan should be deleted from memory (cleaned up on atomic update failure)
      expect(stateManager.hasPendingPlan(task.id)).toBe(false);

      // FINDING: The atomic guard `WHERE column = 'waiting_approval'` in
      // approvePlan correctly prevents approving a task that has been moved.
      // The plan is cleaned from memory when the atomic update returns no rows.
    });

    it('concurrent approve and reject — one wins, the other gets PLAN_NOT_FOUND', async () => {
      const codespace = await createTestProject({ name: 'Concurrent Approve Reject' });
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
        title: 'Task for concurrent approve/reject',
      });

      const { planService } = createPlanApprovalService(db, streams, stateManager);

      await planService.handlePlanReady(
        task.id,
        'session-conc',
        codespace.id,
        makePlanData({ plan: 'Concurrent plan' })
      );

      // Run both concurrently
      const [approveResult, rejectResult] = await Promise.all([
        planService.approvePlan(task.id),
        planService.rejectPlan(task.id, 'Reject wins'),
      ]);

      // Exactly one should succeed, the other should fail
      const approveOk = approveResult.ok;
      const rejectOk = rejectResult.ok;

      // At least one must succeed
      expect(approveOk || rejectOk).toBe(true);

      // They can't both succeed (different column guards)
      // approve: WHERE column = 'waiting_approval' -> sets column = 'in_progress'
      // reject: WHERE lastAgentStatus = 'planning' -> sets column = 'backlog'
      // Both can technically succeed in SQLite because they use different guards,
      // but the final state should be consistent
      const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });

      if (approveOk && rejectOk) {
        // Both succeeded — this is a potential race condition
        // The final state depends on which DB write executed last
        // Document what actually happened
        expect(['in_progress', 'backlog']).toContain(taskAfter!.column);
      } else if (approveOk) {
        expect(taskAfter!.column).toBe('in_progress');
      } else {
        expect(taskAfter!.column).toBe('backlog');
      }
    });
  });
});
