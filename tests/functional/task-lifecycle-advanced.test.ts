/**
 * Functional Tests: Advanced Task Lifecycle Scenarios
 *
 * Each test uses REAL service code for every state transition.
 * Only external I/O is mocked: sandbox providers, git operations, streams.
 *
 * Tests cover:
 * 1. Sandbox change detection during plan approval
 * 2. Plan recovery after server restart (getPendingPlan DB fallback)
 * 3. Race condition: approve then reject (reject fails)
 * 4. Race condition: reject then approve (approve fails)
 * 5. Merge conflict during approve preserves task state for retry
 *
 * Run: npx vitest run --project functional tests/functional/task-lifecycle-advanced.test.ts
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { PlanApprovalService } from '../../src/services/container-agent/plan-approval.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

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

function createMockWorktreeService() {
  return {
    getDiff: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        files: [
          { path: 'src/feature.ts', additions: 42, deletions: 5, status: 'modified' },
          { path: 'src/feature.test.ts', additions: 28, deletions: 0, status: 'added' },
        ],
        stats: { filesChanged: 2, additions: 70, deletions: 5 },
      },
    }),
    merge: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

// ---------- test suite ----------

describe('Advanced Task Lifecycle Scenarios', () => {
  let db: ReturnType<typeof getTestDb>;
  let streams: DurableStreamsService;
  let mockWorktreeService: ReturnType<typeof createMockWorktreeService>;
  let taskService: TaskService;
  let stateManager: SandboxStateManager;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    streams = createMockStreams();
    mockWorktreeService = createMockWorktreeService();
    taskService = new TaskService(db, mockWorktreeService);
    stateManager = new SandboxStateManager();
  });

  afterEach(async () => {
    stateManager.dispose();
    try {
      execRawSql('DELETE FROM settings');
    } catch {
      // Ignore if table doesn't exist
    }
    await clearTestDatabase();
  });

  // =========================================================================
  // Test 1: Sandbox change detection during plan approval
  // =========================================================================

  it('sandbox change detection during plan approval triggers fresh session', async () => {
    const codespace = await createTestProject({ name: 'Sandbox Change Test' });

    // Create task in in_progress (simulating agent already running)
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      title: 'Task with sandbox change',
    });

    const sessionId = 'session-sandbox-change';

    // Set up state manager with a running agent so handlePlanReady captures sandboxId
    stateManager.setRunningAgent(task.id, {
      taskId: task.id,
      sessionId,
      codespaceId: codespace.id,
      sandboxId: 'sandbox-original-123',
      bridge: {} as any,
      execResult: {} as any,
      stopFilePath: '/tmp/stop',
      startedAt: new Date(),
      stopRequested: false,
      phase: 'plan',
    });

    const mockWorktreeInit = {
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
      resolveWorktree: vi.fn(),
      initializeWorkspace: vi.fn(),
    };
    const mockStartAgentFn = vi.fn().mockResolvedValue({ ok: true, value: undefined });

    // provider.get() returns a DIFFERENT sandbox ID than what was stored during planning
    const mockProvider = {
      get: vi.fn().mockResolvedValue({ id: 'sandbox-new-456', codespaceId: codespace.id }),
    };

    const planService = new PlanApprovalService(
      { db, streams, provider: mockProvider as any },
      stateManager,
      mockWorktreeInit as any,
      mockStartAgentFn,
      () => false // not AgentCore -- use the container exec branch
    );

    // Store plan via real handlePlanReady (captures sandbox-original-123 from running agent)
    await planService.handlePlanReady(task.id, sessionId, codespace.id, {
      plan: 'Implementation plan for authentication',
      turnCount: 5,
      sdkSessionId: 'sdk-session-original',
    });

    // Verify plan was stored with the original sandbox ID
    const pendingPlan = stateManager.getPendingPlan(task.id);
    expect(pendingPlan).toBeTruthy();
    expect(pendingPlan!.sandboxId).toBe('sandbox-original-123');
    expect(pendingPlan!.sdkSessionId).toBe('sdk-session-original');

    // Call real approvePlan -- should detect sandbox change
    const approveResult = await planService.approvePlan(task.id);
    expect(approveResult.ok).toBe(true);

    // Verify: startAgentFn called with sdkSessionId: undefined (fresh session, not resuming)
    expect(mockStartAgentFn).toHaveBeenCalledOnce();
    const startInput = mockStartAgentFn.mock.calls[0][0];
    expect(startInput.sdkSessionId).toBeUndefined();
    expect(startInput.phase).toBe('execute');
    expect(startInput.prompt).toContain('Implementation plan for authentication');

    // Verify: streams.publish was called with 'container-agent:message' containing sandbox change warning
    const publishCalls = (streams.publish as ReturnType<typeof vi.fn>).mock.calls;
    const sandboxChangeMessage = publishCalls.find(
      (call: unknown[]) =>
        call[1] === 'container-agent:message' &&
        typeof call[2] === 'object' &&
        call[2] !== null &&
        (call[2] as Record<string, unknown>).content &&
        String((call[2] as Record<string, unknown>).content).includes('Sandbox container changed')
    );
    expect(sandboxChangeMessage).toBeTruthy();

    // Verify: task moved to in_progress for execution
    const executingTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(executingTask!.column).toBe('in_progress');
  });

  // =========================================================================
  // Test 2: Plan recovery after server restart (getPendingPlan DB fallback)
  // =========================================================================

  it('plan recovery after server restart via getPendingPlan DB fallback', async () => {
    const codespace = await createTestProject({ name: 'Server Restart Test' });

    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      title: 'Task surviving restart',
    });

    const sessionId = 'session-restart';

    const mockWorktreeInit = {
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
      resolveWorktree: vi.fn(),
      initializeWorkspace: vi.fn(),
    };
    const mockStartAgentFn = vi.fn().mockResolvedValue({ ok: true, value: undefined });

    const planService1 = new PlanApprovalService(
      { db, streams, provider: { get: vi.fn() } as any },
      stateManager,
      mockWorktreeInit as any,
      mockStartAgentFn,
      () => false
    );

    // Store plan via real handlePlanReady (persists to DB + in-memory)
    await planService1.handlePlanReady(task.id, sessionId, codespace.id, {
      plan: 'Comprehensive refactoring plan with 5 steps',
      turnCount: 8,
      sdkSessionId: 'sdk-session-restart',
      allowedPrompts: [{ tool: 'Bash', prompt: 'npm test' }],
    });

    // Verify plan is in memory
    expect(stateManager.hasPendingPlan(task.id)).toBe(true);

    // Verify plan persisted to DB
    const dbTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(dbTask!.plan).toContain('Comprehensive refactoring plan');
    expect(dbTask!.lastAgentStatus).toBe('planning');

    // --- Simulate server restart: create NEW SandboxStateManager (empty memory) ---
    const freshStateManager = new SandboxStateManager();

    // Verify the fresh state manager has NO plans in memory
    expect(freshStateManager.hasPendingPlan(task.id)).toBe(false);

    // Create a NEW PlanApprovalService with the fresh state manager
    const mockStartAgentFn2 = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const planService2 = new PlanApprovalService(
      { db, streams, provider: { get: vi.fn() } as any },
      freshStateManager,
      mockWorktreeInit as any,
      mockStartAgentFn2,
      () => false
    );

    // Call approvePlan -- should recover plan from DB
    const approveResult = await planService2.approvePlan(task.id);
    expect(approveResult.ok).toBe(true);

    // Verify: startAgentFn called with the correct plan text from DB
    expect(mockStartAgentFn2).toHaveBeenCalledOnce();
    const startInput = mockStartAgentFn2.mock.calls[0][0];
    expect(startInput.prompt).toContain('Comprehensive refactoring plan');
    expect(startInput.phase).toBe('execute');
    expect(startInput.sdkSessionId).toBe('sdk-session-restart');

    // Verify: task moved to in_progress for execution
    const executingTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(executingTask!.column).toBe('in_progress');

    // Clean up fresh state manager
    freshStateManager.dispose();
  });

  // =========================================================================
  // Test 3: Race condition fix -- approve then reject (reject fails)
  // =========================================================================

  it('race condition: approve then reject -- reject returns PLAN_NOT_FOUND', async () => {
    const codespace = await createTestProject({ name: 'Approve-Then-Reject Race' });

    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      title: 'Task for approve-reject race',
    });

    const sessionId = 'session-race-ar';

    const mockWorktreeInit = {
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
      resolveWorktree: vi.fn(),
      initializeWorkspace: vi.fn(),
    };
    const mockStartAgentFn = vi.fn().mockResolvedValue({ ok: true, value: undefined });

    const planService = new PlanApprovalService(
      { db, streams, provider: { get: vi.fn() } as any },
      stateManager,
      mockWorktreeInit as any,
      mockStartAgentFn,
      () => false
    );

    // Store plan via real handlePlanReady
    await planService.handlePlanReady(task.id, sessionId, codespace.id, {
      plan: 'Plan for race condition test',
      turnCount: 3,
      sdkSessionId: 'sdk-race-ar',
    });

    // Verify plan was stored
    const plannedTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(plannedTask!.column).toBe('waiting_approval');
    expect(plannedTask!.lastAgentStatus).toBe('planning');

    // Call real approvePlan -- succeeds, task goes to in_progress
    const approveResult = await planService.approvePlan(task.id);
    expect(approveResult.ok).toBe(true);
    expect(mockStartAgentFn).toHaveBeenCalledOnce();

    // Verify task is now in_progress with lastAgentStatus cleared (no longer 'planning')
    const approvedTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(approvedTask!.column).toBe('in_progress');
    expect(approvedTask!.lastAgentStatus).toBeNull();

    // Verify in-memory pending plan was cleared by approvePlan
    expect(stateManager.hasPendingPlan(task.id)).toBe(false);

    // Now call real rejectPlan on the same task --
    // The atomic WHERE guard (lastAgentStatus='planning') prevents the reject
    // from succeeding because approvePlan already cleared lastAgentStatus to null.
    const rejectResult = await planService.rejectPlan(task.id);

    // The reject fails because lastAgentStatus is no longer 'planning'
    expect(rejectResult.ok).toBe(false);

    // Task remains in_progress — the approval was NOT reverted
    const finalTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(finalTask!.column).toBe('in_progress');
    expect(finalTask!.plan).toBeTruthy();

    // Execution was started and not disrupted
    expect(mockStartAgentFn).toHaveBeenCalledOnce();
  });

  // =========================================================================
  // Test 4: Race condition fix -- reject then approve (approve fails)
  // =========================================================================

  it('race condition: reject then approve -- approve returns PLAN_NOT_FOUND', async () => {
    const codespace = await createTestProject({ name: 'Reject-Then-Approve Race' });

    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      title: 'Task for reject-approve race',
    });

    const sessionId = 'session-race-ra';

    const mockWorktreeInit = {
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
      resolveWorktree: vi.fn(),
      initializeWorkspace: vi.fn(),
    };
    const mockStartAgentFn = vi.fn().mockResolvedValue({ ok: true, value: undefined });

    const planService = new PlanApprovalService(
      { db, streams, provider: { get: vi.fn() } as any },
      stateManager,
      mockWorktreeInit as any,
      mockStartAgentFn,
      () => false
    );

    // Store plan via real handlePlanReady
    await planService.handlePlanReady(task.id, sessionId, codespace.id, {
      plan: 'Plan for reverse race test',
      turnCount: 4,
      sdkSessionId: 'sdk-race-ra',
    });

    expect(stateManager.hasPendingPlan(task.id)).toBe(true);

    // Call real rejectPlan -- succeeds, task goes to backlog, plan cleared
    const rejectResult = await planService.rejectPlan(task.id);
    expect(rejectResult.ok).toBe(true);

    // Verify task is in backlog with plan cleared
    const rejectedTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(rejectedTask!.column).toBe('backlog');
    expect(rejectedTask!.plan).toBeNull();
    expect(rejectedTask!.lastAgentStatus).toBeNull();

    // Verify in-memory plan was deleted
    expect(stateManager.hasPendingPlan(task.id)).toBe(false);

    // Now call real approvePlan -- should fail with PLAN_NOT_FOUND
    // because in-memory plan was deleted AND DB plan was cleared by rejectPlan
    const approveResult = await planService.approvePlan(task.id);
    expect(approveResult.ok).toBe(false);
    if (!approveResult.ok) {
      expect(approveResult.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
    }

    // Verify: task stays in backlog (not moved to in_progress)
    const finalTask = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(finalTask!.column).toBe('backlog');

    // Verify: startAgentFn NOT called
    expect(mockStartAgentFn).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test 5: Merge conflict during approve preserves task state for retry
  // =========================================================================

  it('merge conflict during approve preserves task state for retry', async () => {
    const codespace = await createTestProject({ name: 'Merge Conflict Test' });

    // Create task in waiting_approval with lastAgentStatus='completed'
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      title: 'Task with merge conflict',
    });
    // TEST-SETUP: this test targets `approve()` merge-failure handling and
    // needs lastAgentStatus='completed' as a precondition. Driving it via
    // updateTaskOnAgentComplete() would require also starting the agent
    // through moveColumn() + mocks, which pulls in the full lifecycle harness
    // and obscures the approve-only assertion. Direct write is intentional.
    await db.update(tasks).set({ lastAgentStatus: 'completed' }).where(eq(tasks.id, task.id));

    // Create worktree linked to the task
    const worktree = await createTestWorktree(codespace.id, {
      taskId: task.id,
      status: 'active',
    });

    // Link worktree to task
    await db
      .update(tasks)
      .set({ worktreeId: worktree.id, branch: worktree.branch })
      .where(eq(tasks.id, task.id));

    // Mock worktreeService.getDiff to return files with changes
    mockWorktreeService.getDiff.mockResolvedValue({
      ok: true,
      value: {
        files: [{ path: 'src/auth.ts', additions: 15, deletions: 3, status: 'modified' }],
        stats: { filesChanged: 1, additions: 15, deletions: 3 },
      },
    });

    // Mock worktreeService.merge to return merge conflict error
    mockWorktreeService.merge.mockResolvedValue({
      ok: false,
      error: {
        code: 'WORKTREE_MERGE_CONFLICT',
        message: 'Conflict in src/auth.ts',
        status: 409,
      },
    });

    // Call real taskService.approve() -- should return the merge error
    const approveResult = await taskService.approve(task.id, {
      approvedBy: 'reviewer',
      createMergeCommit: true,
    });

    // Verify: approve failed with the merge error
    expect(approveResult.ok).toBe(false);
    if (!approveResult.ok) {
      expect(approveResult.error.code).toBe('WORKTREE_MERGE_CONFLICT');
      expect(approveResult.error.message).toContain('Conflict in src/auth.ts');
    }

    // Verify: task is STILL in waiting_approval (NOT moved to verified)
    const taskAfterConflict = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskAfterConflict!.column).toBe('waiting_approval');

    // Verify: task.approvedAt is null (not set)
    expect(taskAfterConflict!.approvedAt).toBeNull();

    // Verify: worktreeService.remove was NOT called (worktree preserved for retry)
    expect(mockWorktreeService.remove).not.toHaveBeenCalled();

    // Verify: worktreeId is still linked (worktree preserved)
    expect(taskAfterConflict!.worktreeId).toBe(worktree.id);

    // --- Fix the mock and retry ---

    // Fix the mock to return success
    mockWorktreeService.merge.mockResolvedValue({ ok: true, value: undefined });

    // Reset getDiff to return the same diff (it was consumed once already)
    mockWorktreeService.getDiff.mockResolvedValue({
      ok: true,
      value: {
        files: [{ path: 'src/auth.ts', additions: 15, deletions: 3, status: 'modified' }],
        stats: { filesChanged: 1, additions: 15, deletions: 3 },
      },
    });

    // Call approve() again -- should succeed this time
    const retryResult = await taskService.approve(task.id, {
      approvedBy: 'reviewer',
      createMergeCommit: true,
    });

    expect(retryResult.ok).toBe(true);
    if (retryResult.ok) {
      expect(retryResult.value.column).toBe('verified');
      expect(retryResult.value.approvedAt).toBeTruthy();
      expect(retryResult.value.approvedBy).toBe('reviewer');
      expect(retryResult.value.completedAt).toBeTruthy();
      expect(retryResult.value.diffSummary).toEqual({
        filesChanged: 1,
        additions: 15,
        deletions: 3,
      });
    }

    // Verify: worktree operations were called on retry
    expect(mockWorktreeService.getDiff).toHaveBeenCalledWith(worktree.id);
    expect(mockWorktreeService.merge).toHaveBeenCalledWith(worktree.id);
    expect(mockWorktreeService.remove).toHaveBeenCalledWith(worktree.id);
  });
});
