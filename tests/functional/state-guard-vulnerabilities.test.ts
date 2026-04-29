/**
 * Functional Tests: State Machine Guard Vulnerabilities
 *
 * Verifies that all state machine guards in the AgentPane task lifecycle
 * correctly reject invalid operations. These tests exercise REAL service code
 * with only external I/O mocked (sandbox provider, git operations, streams).
 *
 * Each test targets a specific vulnerability that was identified and fixed:
 * - approve() and moveColumn() reject plan-pending tasks (PLAN_NOT_EXECUTED)
 * - updateTaskOnAgentComplete() respects user-initiated column changes
 * - stopAgent() on non-running tasks does not corrupt state
 * - Concurrent plan approval/rejection race conditions
 *
 * Run: npx vitest run --project functional tests/functional/state-guard-vulnerabilities.test.ts
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings, tasks } from '../../src/db/schema';
import { PlanApprovalService } from '../../src/services/container-agent/plan-approval.service';
import { SandboxStateManager } from '../../src/services/container-agent/sandbox-state';
import {
  updateTaskOnAgentComplete,
  updateTaskOnAgentError,
} from '../../src/services/container-agent/shared-helpers';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import { TaskService } from '../../src/services/task.service';
import { createTestAgent } from '../factories/agent.factory';
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

function createMockContainerAgent() {
  return {
    providerName: 'docker',
    startAgent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    stopAgent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    isAgentRunning: vi.fn().mockReturnValue(false),
    approvePlan: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    rejectPlan: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

/**
 * TEST-SETUP: Enable sandbox defaults via direct settings insert.
 *
 * Settings are infrastructure configuration with no service API for seeding;
 * see CLAUDE.md §"Functional Tests: Real Service Transitions" — raw writes
 * for test infrastructure (as opposed to state transitions) are the allowed
 * form. Moving this through SettingsService would add a dependency chain
 * without improving coverage.
 */
async function enableSandboxDefaults(db: ReturnType<typeof getTestDb>): Promise<void> {
  await db.insert(settings).values({
    key: 'sandbox.defaults',
    value: JSON.stringify({ enabled: true, mode: 'shared' }),
  });
}

/**
 * TEST-SETUP: Force-set a task's `lastAgentStatus` after creation.
 *
 * Several guard tests need a task in `waiting_approval` with a specific
 * `lastAgentStatus` (e.g. 'planning', 'error', 'cancelled') as a
 * precondition. Driving it through `updateTaskOnAgentComplete()` would
 * require starting the agent via `moveColumn('in_progress')` first — that
 * pulls the full lifecycle harness into every guard test and obscures the
 * specific guard being asserted. The direct write is the minimal-surface
 * precondition.
 *
 * This helper centralises the pattern so the intent is explicit at each
 * call site (per CLAUDE.md §"Functional Tests: Real Service Transitions").
 */
async function setTaskLastAgentStatus(
  db: ReturnType<typeof getTestDb>,
  taskId: string,
  status: NonNullable<typeof tasks.$inferSelect.lastAgentStatus>
): Promise<void> {
  await db.update(tasks).set({ lastAgentStatus: status }).where(eq(tasks.id, taskId));
}

function createPlanApprovalService(
  db: ReturnType<typeof getTestDb>,
  streams: DurableStreamsService,
  stateManager: SandboxStateManager
) {
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
    mockStartAgentFn
  );

  return { planService, mockStartAgentFn, mockWorktreeInit };
}

// ---------- test suite ----------

describe('State Machine Guard Vulnerabilities', () => {
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
    // Clear settings table (not included in clearTestDatabase for SQLite)
    try {
      execRawSql('DELETE FROM settings');
    } catch {
      // Ignore if table doesn't exist
    }
    await clearTestDatabase();
  });

  // =========================================================================
  // Test 1: approve() rejects task with lastAgentStatus='planning'
  // =========================================================================

  it('approve() rejects task with lastAgentStatus=planning (PLAN_NOT_EXECUTED)', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 1' });

    // Create task and move to in_progress
    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Task with pending plan',
    });
    expect(createResult.ok).toBe(true);
    const taskId = createResult.ok ? createResult.value.id : '';

    // Set up container agent trigger so moveColumn works
    const mockContainerAgent = createMockContainerAgent();
    taskService.setContainerAgentService(mockContainerAgent);
    await enableSandboxDefaults(db);

    await taskService.moveColumn(taskId, 'in_progress');

    // Create worktree and wire up plan approval
    const worktree = await createTestWorktree(codespace.id, { taskId, status: 'active' });
    const { planService } = createPlanApprovalService(db, streams, stateManager);

    // Simulate plan ready via real PlanApprovalService.handlePlanReady
    await planService.handlePlanReady(taskId, 'session-guard-1', codespace.id, {
      plan: 'Implementation plan for the task',
      turnCount: 4,
      sdkSessionId: 'sdk-guard-1',
    });

    // Verify task is now in waiting_approval with lastAgentStatus='planning'
    const taskBefore = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskBefore!.column).toBe('waiting_approval');
    expect(taskBefore!.lastAgentStatus).toBe('planning');

    // Attach worktreeId so approve() would get past the NO_DIFF check if the guard wasn't there
    await db
      .update(tasks)
      .set({ worktreeId: worktree.id, branch: worktree.branch })
      .where(eq(tasks.id, taskId));

    // Call approve() — should fail with PLAN_NOT_EXECUTED
    const approveResult = await taskService.approve(taskId, { approvedBy: 'user' });
    expect(approveResult.ok).toBe(false);
    if (!approveResult.ok) {
      expect(approveResult.error.code).toBe('TASK_PLAN_NOT_EXECUTED');
    }

    // Verify task is still in waiting_approval (not moved to verified)
    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskAfter!.column).toBe('waiting_approval');
    expect(taskAfter!.lastAgentStatus).toBe('planning');

    // Verify worktree was NOT merged or removed
    expect(mockWorktreeService.merge).not.toHaveBeenCalled();
    expect(mockWorktreeService.remove).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test 2: moveColumn to verified rejects when lastAgentStatus='planning'
  // =========================================================================

  it('moveColumn to verified rejects when lastAgentStatus=planning', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 2' });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Task for Kanban drag test',
    });
    expect(createResult.ok).toBe(true);
    const taskId = createResult.ok ? createResult.value.id : '';

    // Move to in_progress
    const mockContainerAgent = createMockContainerAgent();
    taskService.setContainerAgentService(mockContainerAgent);
    await enableSandboxDefaults(db);
    await taskService.moveColumn(taskId, 'in_progress');

    // Simulate plan ready
    const { planService } = createPlanApprovalService(db, streams, stateManager);
    await planService.handlePlanReady(taskId, 'session-guard-2', codespace.id, {
      plan: 'Plan text for guard test 2',
      turnCount: 2,
      sdkSessionId: 'sdk-guard-2',
    });

    const taskBefore = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskBefore!.column).toBe('waiting_approval');
    expect(taskBefore!.lastAgentStatus).toBe('planning');

    // Try to move directly to verified (simulating Kanban drag)
    const moveResult = await taskService.moveColumn(taskId, 'verified');
    expect(moveResult.ok).toBe(false);
    if (!moveResult.ok) {
      expect(moveResult.error.code).toBe('TASK_PLAN_NOT_EXECUTED');
    }

    // Task should remain in waiting_approval
    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskAfter!.column).toBe('waiting_approval');
  });

  // =========================================================================
  // Test 3: approve() succeeds when lastAgentStatus='completed' (happy path)
  // =========================================================================

  it('approve() succeeds when lastAgentStatus=completed (happy path)', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 3' });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Completed task for approval',
    });
    expect(createResult.ok).toBe(true);
    const taskId = createResult.ok ? createResult.value.id : '';

    // Move through the full lifecycle: backlog -> in_progress -> agent completes -> waiting_approval
    const mockContainerAgent = createMockContainerAgent();
    taskService.setContainerAgentService(mockContainerAgent);
    await enableSandboxDefaults(db);
    await taskService.moveColumn(taskId, 'in_progress');

    // Simulate agent execution completion (not just planning)
    await updateTaskOnAgentComplete(db, taskId, 'completed');

    const taskAfterComplete = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskAfterComplete!.column).toBe('waiting_approval');
    expect(taskAfterComplete!.lastAgentStatus).toBe('completed');

    // Set up worktree for diff check
    const worktree = await createTestWorktree(codespace.id, { taskId, status: 'active' });
    await db
      .update(tasks)
      .set({ worktreeId: worktree.id, branch: worktree.branch })
      .where(eq(tasks.id, taskId));

    // Call approve() — should succeed
    const approveResult = await taskService.approve(taskId, { approvedBy: 'reviewer' });
    expect(approveResult.ok).toBe(true);
    if (approveResult.ok) {
      expect(approveResult.value.column).toBe('verified');
      expect(approveResult.value.approvedBy).toBe('reviewer');
      expect(approveResult.value.approvedAt).toBeTruthy();
      expect(approveResult.value.completedAt).toBeTruthy();
      expect(approveResult.value.diffSummary).toEqual({
        filesChanged: 2,
        additions: 70,
        deletions: 5,
      });
    }

    // Verify worktree operations were called
    expect(mockWorktreeService.getDiff).toHaveBeenCalledWith(worktree.id);
    expect(mockWorktreeService.merge).toHaveBeenCalledWith(worktree.id);
    expect(mockWorktreeService.remove).toHaveBeenCalledWith(worktree.id);
  });

  // =========================================================================
  // Test 4: moveColumn to verified succeeds when lastAgentStatus='completed'
  // =========================================================================

  it('moveColumn to verified succeeds when lastAgentStatus=completed', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 4' });

    // Create task directly in waiting_approval with completed status
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      title: 'Completed task for move test',
    });
    await setTaskLastAgentStatus(db, task.id, 'completed');

    // moveColumn to verified should succeed
    const moveResult = await taskService.moveColumn(task.id, 'verified');
    expect(moveResult.ok).toBe(true);
    if (moveResult.ok) {
      expect(moveResult.value.task.column).toBe('verified');
      expect(moveResult.value.task.completedAt).toBeTruthy();
    }
  });

  // =========================================================================
  // Test 5: approve() succeeds when lastAgentStatus='turn_limit'
  // =========================================================================

  it('approve() succeeds when lastAgentStatus=turn_limit', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 5' });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Turn-limited task',
    });
    expect(createResult.ok).toBe(true);
    const taskId = createResult.ok ? createResult.value.id : '';

    // Move to in_progress
    const mockContainerAgent = createMockContainerAgent();
    taskService.setContainerAgentService(mockContainerAgent);
    await enableSandboxDefaults(db);
    await taskService.moveColumn(taskId, 'in_progress');

    // Simulate agent hitting turn limit
    await updateTaskOnAgentComplete(db, taskId, 'turn_limit');

    const taskAfterLimit = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskAfterLimit!.column).toBe('waiting_approval');
    expect(taskAfterLimit!.lastAgentStatus).toBe('turn_limit');

    // Set up worktree
    const worktree = await createTestWorktree(codespace.id, { taskId, status: 'active' });
    await db
      .update(tasks)
      .set({ worktreeId: worktree.id, branch: worktree.branch })
      .where(eq(tasks.id, taskId));

    // approve() should succeed (turn_limit means agent ran but hit the limit)
    const approveResult = await taskService.approve(taskId, { approvedBy: 'reviewer' });
    expect(approveResult.ok).toBe(true);
    if (approveResult.ok) {
      expect(approveResult.value.column).toBe('verified');
      expect(approveResult.value.approvedBy).toBe('reviewer');
    }
  });

  // =========================================================================
  // Test 6: updateTaskOnAgentComplete() does not revert user cancellation
  // =========================================================================

  it('updateTaskOnAgentComplete() does not revert user cancellation', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 6' });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Task that user will cancel',
    });
    expect(createResult.ok).toBe(true);
    const taskId = createResult.ok ? createResult.value.id : '';

    // Move to in_progress
    const mockContainerAgent = createMockContainerAgent();
    taskService.setContainerAgentService(mockContainerAgent);
    await enableSandboxDefaults(db);
    await taskService.moveColumn(taskId, 'in_progress');

    // User moves task to backlog (cancellation) while agent is still running
    await taskService.moveColumn(taskId, 'backlog');

    const taskInBacklog = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskInBacklog!.column).toBe('backlog');

    // Now the agent completes (delayed callback)
    // This should NOT move the task from backlog to waiting_approval
    const result = await updateTaskOnAgentComplete(
      db,
      taskId,
      'completed',
      streams,
      'session-guard-6'
    );
    expect(result).toBe(false); // No rows updated — task was not in in_progress

    // Task should remain in backlog, NOT moved to waiting_approval
    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskAfter!.column).toBe('backlog');
    expect(taskAfter!.lastAgentStatus).not.toBe('completed');
  });

  // =========================================================================
  // Test 6b: updateTaskOnAgentComplete() with turn_limit does not revert
  // =========================================================================

  it('updateTaskOnAgentComplete() with turn_limit does not revert user cancellation', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 6b' });

    const task = await createTestTask(codespace.id, {
      column: 'backlog',
      title: 'Task cancelled before turn_limit callback',
    });

    // Agent completes with turn_limit, but task is already in backlog
    const result = await updateTaskOnAgentComplete(
      db,
      task.id,
      'turn_limit',
      streams,
      'session-guard-6b'
    );
    expect(result).toBe(false); // No rows updated — task was not in in_progress

    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskAfter!.column).toBe('backlog');
    expect(taskAfter!.lastAgentStatus).not.toBe('turn_limit');
  });

  // =========================================================================
  // Test 7: stopAgent() on task not in in_progress is handled gracefully
  // =========================================================================

  it('stopAgent() on task in waiting_approval with completed status does not corrupt lastAgentStatus', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 7' });

    // Create task in waiting_approval with lastAgentStatus='completed'
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      title: 'Completed task that stopAgent is called on',
    });
    await setTaskLastAgentStatus(db, task.id, 'completed');

    // Set up container agent service with no running agent
    const mockContainerAgent = createMockContainerAgent();
    mockContainerAgent.isAgentRunning.mockReturnValue(false);
    taskService.setContainerAgentService(mockContainerAgent);

    // Call stopAgent — should succeed gracefully
    const stopResult = await taskService.stopAgent(task.id);
    expect(stopResult.ok).toBe(true);

    // Verify task state. The task has no agentId, so the fallback path
    // should not write 'cancelled' to lastAgentStatus.
    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskAfter!.column).toBe('waiting_approval');
    // Without agentId the fallback branch is a no-op, so lastAgentStatus should remain 'completed'
    expect(taskAfter!.lastAgentStatus).toBe('completed');
  });

  // =========================================================================
  // Test 7b: stopAgent() on task with agentId still writes cancelled
  // =========================================================================

  it('stopAgent() on task with agentId writes cancelled (expected behavior for orphaned agents)', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 7b' });

    // Create a real agent record so the FK constraint is satisfied
    const agent = await createTestAgent(codespace.id, { name: 'Orphaned Agent' });

    // Create task with the agent reference (simulating orphaned agent reference)
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      title: 'Task with orphaned agent reference',
      agentId: agent.id,
    });

    const mockContainerAgent = createMockContainerAgent();
    mockContainerAgent.isAgentRunning.mockReturnValue(false);
    taskService.setContainerAgentService(mockContainerAgent);

    const stopResult = await taskService.stopAgent(task.id);
    expect(stopResult.ok).toBe(true);

    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    // With agentId present, the fallback path cleans up and sets cancelled
    expect(taskAfter!.agentId).toBeNull();
    expect(taskAfter!.sessionId).toBeNull();
    expect(taskAfter!.lastAgentStatus).toBe('cancelled');
  });

  // =========================================================================
  // Test 8: Concurrent plan approval and rejection
  // =========================================================================

  it('concurrent plan approval followed by rejection: reject is blocked by atomic guard', async () => {
    // After approvePlan(), lastAgentStatus is cleared from 'planning' to null atomically.
    // A concurrent rejectPlan checks lastAgentStatus='planning' in its WHERE clause,
    // so it correctly fails when the plan has already been approved.
    const codespace = await createTestProject({ name: 'Guard Test 8' });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Task for concurrent plan test',
    });
    expect(createResult.ok).toBe(true);
    const taskId = createResult.ok ? createResult.value.id : '';

    // Move to in_progress
    const mockContainerAgent = createMockContainerAgent();
    taskService.setContainerAgentService(mockContainerAgent);
    await enableSandboxDefaults(db);
    await taskService.moveColumn(taskId, 'in_progress');

    // Store plan via real PlanApprovalService
    const { planService, mockStartAgentFn } = createPlanApprovalService(db, streams, stateManager);
    await planService.handlePlanReady(taskId, 'session-guard-8', codespace.id, {
      plan: 'Plan for concurrent test',
      turnCount: 3,
      sdkSessionId: 'sdk-guard-8',
    });

    // Verify plan is stored
    expect(stateManager.hasPendingPlan(taskId)).toBe(true);
    const taskBefore = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskBefore!.column).toBe('waiting_approval');
    expect(taskBefore!.lastAgentStatus).toBe('planning');

    // Approve the plan — succeeds, clears pending plan from memory
    const approveResult = await planService.approvePlan(taskId);
    expect(approveResult.ok).toBe(true);
    expect(stateManager.hasPendingPlan(taskId)).toBe(false);
    expect(mockStartAgentFn).toHaveBeenCalledOnce();

    // Verify task is now in_progress with lastAgentStatus cleared (no longer 'planning')
    const taskAfterApprove = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskAfterApprove!.column).toBe('in_progress');
    // lastAgentStatus is cleared to null — this is the key fix for the race condition
    expect(taskAfterApprove!.lastAgentStatus).toBeNull();
    // Plan text is still in DB (for execution reference)
    expect(taskAfterApprove!.plan).toBeTruthy();

    // Concurrent reject is blocked by atomic WHERE guard (lastAgentStatus != 'planning')
    const rejectResult = await planService.rejectPlan(taskId);
    // rejectPlan fails because lastAgentStatus is no longer 'planning'
    expect(rejectResult.ok).toBe(false);

    // Task remains in_progress — the approval was NOT reverted
    const taskAfterReject = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskAfterReject!.column).toBe('in_progress');
    expect(taskAfterReject!.plan).toBeTruthy();
    expect(taskAfterReject!.lastAgentStatus).toBeNull();
  });

  // =========================================================================
  // Test 8b: Concurrent plan rejection followed by approval
  // =========================================================================

  it('concurrent plan rejection followed by approval returns PLAN_NOT_FOUND', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 8b' });

    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      title: 'Task for reverse concurrent test',
    });

    const { planService, mockStartAgentFn } = createPlanApprovalService(db, streams, stateManager);
    await planService.handlePlanReady(task.id, 'session-guard-8b', codespace.id, {
      plan: 'Plan for reverse concurrent test',
      turnCount: 2,
      sdkSessionId: 'sdk-guard-8b',
    });

    expect(stateManager.hasPendingPlan(task.id)).toBe(true);

    // Reject first — succeeds
    const rejectResult = await planService.rejectPlan(task.id, 'Bad plan');
    expect(rejectResult.ok).toBe(true);
    expect(stateManager.hasPendingPlan(task.id)).toBe(false);

    // Task moved to backlog with plan cleared
    const taskAfterReject = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskAfterReject!.column).toBe('backlog');
    expect(taskAfterReject!.plan).toBeNull();
    expect(taskAfterReject!.lastAgentStatus).toBeNull();

    // Now approve — should fail with PLAN_NOT_FOUND
    const approveResult = await planService.approvePlan(task.id);
    expect(approveResult.ok).toBe(false);
    if (!approveResult.ok) {
      expect(approveResult.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
    }

    // startAgentFn should NOT have been called
    expect(mockStartAgentFn).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test 9: moveColumn to in_progress from waiting_approval triggers new agent
  // =========================================================================

  it('moveColumn to in_progress from waiting_approval triggers new agent correctly', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 9' });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Task to re-plan after rejection',
    });
    expect(createResult.ok).toBe(true);
    const taskId = createResult.ok ? createResult.value.id : '';

    // Set up container agent
    const mockContainerAgent = createMockContainerAgent();
    taskService.setContainerAgentService(mockContainerAgent);
    await enableSandboxDefaults(db);

    // Move to in_progress (first run)
    await taskService.moveColumn(taskId, 'in_progress');
    expect(mockContainerAgent.startAgent).toHaveBeenCalledTimes(1);

    // Simulate agent completing and moving to waiting_approval
    await updateTaskOnAgentComplete(db, taskId, 'completed');
    const taskWaiting = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskWaiting!.column).toBe('waiting_approval');

    // Now the user moves it BACK to in_progress (re-plan / rejection path)
    // This is a valid transition: waiting_approval -> in_progress
    mockContainerAgent.startAgent.mockClear();
    const moveResult = await taskService.moveColumn(taskId, 'in_progress');
    expect(moveResult.ok).toBe(true);
    if (moveResult.ok) {
      expect(moveResult.value.task.column).toBe('in_progress');
      expect(moveResult.value.task.startedAt).toBeTruthy();
    }

    // Verify a new agent was triggered
    expect(mockContainerAgent.startAgent).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // Additional edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('moveColumn to verified is allowed when lastAgentStatus is null (no agent ever ran)', async () => {
      const codespace = await createTestProject({ name: 'Edge 1' });

      // Create task directly in waiting_approval with no lastAgentStatus
      // (simulating a manual workflow without agent execution)
      const task = await createTestTask(codespace.id, {
        column: 'waiting_approval',
        title: 'Manual task with no agent status',
      });

      const taskBefore = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
      expect(taskBefore!.lastAgentStatus).toBeNull();

      // moveColumn to verified should succeed (no planning guard triggered)
      const moveResult = await taskService.moveColumn(task.id, 'verified');
      expect(moveResult.ok).toBe(true);
      if (moveResult.ok) {
        expect(moveResult.value.task.column).toBe('verified');
      }
    });

    it('moveColumn to verified is allowed when lastAgentStatus=error', async () => {
      const codespace = await createTestProject({ name: 'Edge 2' });

      const task = await createTestTask(codespace.id, {
        column: 'waiting_approval',
        title: 'Task with error status',
      });
      await setTaskLastAgentStatus(db, task.id, 'error');

      const moveResult = await taskService.moveColumn(task.id, 'verified');
      expect(moveResult.ok).toBe(true);
      if (moveResult.ok) {
        expect(moveResult.value.task.column).toBe('verified');
      }
    });

    it('moveColumn to verified is allowed when lastAgentStatus=cancelled', async () => {
      const codespace = await createTestProject({ name: 'Edge 3' });

      const task = await createTestTask(codespace.id, {
        column: 'waiting_approval',
        title: 'Task with cancelled status',
      });
      await setTaskLastAgentStatus(db, task.id, 'cancelled');

      const moveResult = await taskService.moveColumn(task.id, 'verified');
      expect(moveResult.ok).toBe(true);
      if (moveResult.ok) {
        expect(moveResult.value.task.column).toBe('verified');
      }
    });

    it('moveColumn to backlog is allowed even when lastAgentStatus=planning', async () => {
      const codespace = await createTestProject({ name: 'Edge 4' });

      // The planning guard should only block verified, not backlog
      const task = await createTestTask(codespace.id, {
        column: 'waiting_approval',
        title: 'Task to abandon during planning',
      });
      await setTaskLastAgentStatus(db, task.id, 'planning');

      // Moving to backlog should still work (user abandoning the task)
      const moveResult = await taskService.moveColumn(task.id, 'backlog');
      expect(moveResult.ok).toBe(true);
      if (moveResult.ok) {
        expect(moveResult.value.task.column).toBe('backlog');
      }
    });

    it('moveColumn to in_progress is allowed when lastAgentStatus=planning', async () => {
      const codespace = await createTestProject({ name: 'Edge 5' });

      // The planning guard should only block verified, not in_progress
      // (user wants to restart the agent)
      const task = await createTestTask(codespace.id, {
        column: 'waiting_approval',
        title: 'Task to restart during planning',
      });
      await setTaskLastAgentStatus(db, task.id, 'planning');

      const moveResult = await taskService.moveColumn(task.id, 'in_progress');
      expect(moveResult.ok).toBe(true);
      if (moveResult.ok) {
        expect(moveResult.value.task.column).toBe('in_progress');
      }
    });

    it('approve() on task with lastAgentStatus=error still checks for diff', async () => {
      const codespace = await createTestProject({ name: 'Edge 6' });

      const task = await createTestTask(codespace.id, {
        column: 'waiting_approval',
        title: 'Error task without worktree',
      });
      await setTaskLastAgentStatus(db, task.id, 'error');

      // approve() should fail with NO_DIFF (no worktreeId)
      const approveResult = await taskService.approve(task.id, { approvedBy: 'user' });
      expect(approveResult.ok).toBe(false);
      if (!approveResult.ok) {
        expect(approveResult.error.code).toBe('TASK_NO_DIFF');
      }
    });

    it('approve() rejects when diff has zero changed files', async () => {
      const codespace = await createTestProject({ name: 'Edge 7' });
      const worktree = await createTestWorktree(codespace.id, { status: 'active' });

      const task = await createTestTask(codespace.id, {
        column: 'waiting_approval',
        title: 'Task with empty diff',
        worktreeId: worktree.id,
        branch: worktree.branch,
      });
      await setTaskLastAgentStatus(db, task.id, 'completed');

      // Mock getDiff to return zero changes
      mockWorktreeService.getDiff.mockResolvedValueOnce({
        ok: true,
        value: {
          files: [],
          stats: { filesChanged: 0, additions: 0, deletions: 0 },
        },
      });

      const approveResult = await taskService.approve(task.id, { approvedBy: 'user' });
      expect(approveResult.ok).toBe(false);
      if (!approveResult.ok) {
        expect(approveResult.error.code).toBe('TASK_NO_DIFF');
      }
    });
  });

  // =========================================================================
  // Test 10: Concurrent approve + reject with Promise.all
  // =========================================================================

  it('concurrent approve and reject — exactly one succeeds', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 10' });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Task for true concurrency test',
    });
    expect(createResult.ok).toBe(true);
    const taskId = createResult.ok ? createResult.value.id : '';

    // Move to in_progress
    const mockContainerAgent = createMockContainerAgent();
    taskService.setContainerAgentService(mockContainerAgent);
    await enableSandboxDefaults(db);
    await taskService.moveColumn(taskId, 'in_progress');

    // Store plan via real PlanApprovalService
    const { planService } = createPlanApprovalService(db, streams, stateManager);
    await planService.handlePlanReady(taskId, 'session-guard-10', codespace.id, {
      plan: 'Plan for concurrent approve+reject test',
      turnCount: 3,
      sdkSessionId: 'sdk-guard-10',
    });

    // Verify plan is stored and task is in waiting_approval
    expect(stateManager.hasPendingPlan(taskId)).toBe(true);
    const taskBefore = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskBefore!.column).toBe('waiting_approval');
    expect(taskBefore!.lastAgentStatus).toBe('planning');

    // Execute both simultaneously — exactly one should succeed
    const [approveResult, rejectResult] = await Promise.all([
      planService.approvePlan(taskId),
      planService.rejectPlan(taskId, 'Bad plan'),
    ]);

    const approveOk = approveResult.ok;
    const rejectOk = rejectResult.ok;

    // Exactly one must succeed, the other must fail
    expect(approveOk !== rejectOk).toBe(true);

    // Verify task is in a consistent final state
    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (approveOk) {
      // Approve won the race — task moved to in_progress for execution
      expect(taskAfter!.column).toBe('in_progress');
      expect(taskAfter!.lastAgentStatus).toBeNull();
      // Reject should have failed with PLAN_NOT_FOUND
      if (!rejectResult.ok) {
        expect(rejectResult.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
      }
    } else {
      // Reject won the race — task moved back to backlog
      expect(taskAfter!.column).toBe('backlog');
      expect(taskAfter!.plan).toBeNull();
      // Approve should have failed with PLAN_NOT_FOUND
      if (!approveResult.ok) {
        expect(approveResult.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
      }
    }

    // Plan should no longer be pending in either outcome
    expect(stateManager.hasPendingPlan(taskId)).toBe(false);
  });

  // =========================================================================
  // Test 11: updateTaskOnAgentError does NOT revert user cancellation
  // =========================================================================

  it('updateTaskOnAgentError does not overwrite user-cancelled task', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 11' });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Task that user cancels before agent error',
    });
    expect(createResult.ok).toBe(true);
    const taskId = createResult.ok ? createResult.value.id : '';

    // Move to in_progress
    const mockContainerAgent = createMockContainerAgent();
    taskService.setContainerAgentService(mockContainerAgent);
    await enableSandboxDefaults(db);
    await taskService.moveColumn(taskId, 'in_progress');

    // User moves task to backlog (cancellation)
    await taskService.moveColumn(taskId, 'backlog');
    const taskInBacklog = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskInBacklog!.column).toBe('backlog');

    // Agent encounters error after user already cancelled.
    // The column guard (eq(tasks.column, 'in_progress')) prevents overwriting
    // the task's state when it has been moved out of in_progress by the user.
    const result = await updateTaskOnAgentError(db, taskId, streams, 'session-guard-11');
    expect(result).toBe(false); // No-op: task is not in in_progress

    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    // Task remains in backlog — column is not changed
    expect(taskAfter!.column).toBe('backlog');
    // lastAgentStatus is NOT set to 'error' because the column guard prevented the update
    expect(taskAfter!.lastAgentStatus).not.toBe('error');
  });

  // =========================================================================
  // Test 12: Double-approve returns NOT_WAITING_APPROVAL
  // =========================================================================

  it('double approve — second call returns NOT_WAITING_APPROVAL', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 12' });

    // Create task in waiting_approval with completed status and a worktree
    const worktree = await createTestWorktree(codespace.id, { status: 'active' });
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      title: 'Task for double-approve test',
      worktreeId: worktree.id,
      branch: worktree.branch,
    });
    await setTaskLastAgentStatus(db, task.id, 'completed');

    // First approve — should succeed
    const first = await taskService.approve(task.id, { approvedBy: 'user1' });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.column).toBe('verified');
      expect(first.value.approvedBy).toBe('user1');
    }

    // Second approve — task is now in 'verified', not 'waiting_approval'
    // The NOT_WAITING_APPROVAL guard fires before the ALREADY_APPROVED check
    const second = await taskService.approve(task.id, { approvedBy: 'user2' });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('TASK_NOT_WAITING_APPROVAL');
    }

    // Task state unchanged by the second call
    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskAfter!.column).toBe('verified');
    expect(taskAfter!.approvedBy).toBe('user1');
  });

  // =========================================================================
  // Test 13: approve() succeeds even when worktree remove fails
  // =========================================================================

  it('approve() succeeds even when worktree remove fails (remove is best-effort)', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 13' });

    const worktree = await createTestWorktree(codespace.id, { status: 'active' });
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      title: 'Task for remove-failure test',
      worktreeId: worktree.id,
      branch: worktree.branch,
    });
    await setTaskLastAgentStatus(db, task.id, 'completed');

    // getDiff returns files, merge succeeds, but remove FAILS
    mockWorktreeService.remove.mockResolvedValueOnce({
      ok: false,
      error: { code: 'WORKTREE_REMOVE_FAILED', message: 'Permission denied', status: 500 },
    });

    // approve() should STILL succeed — the task moves to verified
    // The worktree.remove() return value is not checked in approve()
    const approveResult = await taskService.approve(task.id, { approvedBy: 'reviewer' });
    expect(approveResult.ok).toBe(true);
    if (approveResult.ok) {
      expect(approveResult.value.column).toBe('verified');
      expect(approveResult.value.approvedBy).toBe('reviewer');
      expect(approveResult.value.completedAt).toBeTruthy();
    }

    // Verify all worktree operations were called
    expect(mockWorktreeService.getDiff).toHaveBeenCalledWith(worktree.id);
    expect(mockWorktreeService.merge).toHaveBeenCalledWith(worktree.id);
    expect(mockWorktreeService.remove).toHaveBeenCalledWith(worktree.id);

    // This documents the current best-effort cleanup behavior:
    // The worktree is orphaned (remove failed) but approval is NOT blocked.
    // A future improvement could log this or schedule a retry.
    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(taskAfter!.column).toBe('verified');
  });

  // =========================================================================
  // Test 14: approvePlan() restores task state when startAgentFn fails
  // =========================================================================

  it('approvePlan() restores task to waiting_approval when execution start fails', async () => {
    const codespace = await createTestProject({ name: 'Guard Test 14' });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Task for startAgent failure rollback',
    });
    expect(createResult.ok).toBe(true);
    const taskId = createResult.ok ? createResult.value.id : '';

    // Move to in_progress
    const mockContainerAgent = createMockContainerAgent();
    taskService.setContainerAgentService(mockContainerAgent);
    await enableSandboxDefaults(db);
    await taskService.moveColumn(taskId, 'in_progress');

    // Create plan with a startAgentFn that FAILS
    const mockWorktreeInit = {
      cleanupWorktree: vi.fn().mockResolvedValue(undefined),
      resolveWorktree: vi.fn(),
      initializeWorkspace: vi.fn(),
    };
    const failingStartAgentFn = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'SANDBOX_AGENT_START_FAILED',
        message: 'Container failed to start',
        status: 500,
      },
    });

    const planService = new PlanApprovalService(
      { db, streams, provider: { get: vi.fn() } as any },
      stateManager,
      mockWorktreeInit as any,
      failingStartAgentFn
    );

    // Store plan via real handlePlanReady
    await planService.handlePlanReady(taskId, 'session-guard-14', codespace.id, {
      plan: 'Plan that will fail to execute',
      turnCount: 3,
      sdkSessionId: 'sdk-guard-14',
    });

    // Verify plan is stored and task is in waiting_approval
    expect(stateManager.hasPendingPlan(taskId)).toBe(true);
    const taskBefore = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskBefore!.column).toBe('waiting_approval');
    expect(taskBefore!.lastAgentStatus).toBe('planning');
    expect(taskBefore!.plan).toBeTruthy();

    // Attempt to approve — startAgentFn will fail
    const approveResult = await planService.approvePlan(taskId);
    expect(approveResult.ok).toBe(false);
    if (!approveResult.ok) {
      expect(approveResult.error.code).toBe('SANDBOX_AGENT_START_FAILED');
    }

    // startAgentFn was called
    expect(failingStartAgentFn).toHaveBeenCalledOnce();

    // Task state should be RESTORED to waiting_approval with planning status
    const taskAfter = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(taskAfter!.column).toBe('waiting_approval');
    expect(taskAfter!.lastAgentStatus).toBe('planning');

    // Plan data should still be in the DB (recoverable for retry)
    expect(taskAfter!.plan).toBeTruthy();
    expect(taskAfter!.plan).toBe('Plan that will fail to execute');

    // Pending plan should still be in memory (not deleted on failure)
    // because the plan was not consumed — only deleted on successful start
    expect(stateManager.hasPendingPlan(taskId)).toBe(true);
  });
});
