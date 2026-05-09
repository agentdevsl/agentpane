/**
 * Functional Bug-Proving Tests for TaskService
 *
 * Each test exercises REAL service code against a real in-memory SQLite database
 * to PROVE or DISPROVE potential bugs. Only external I/O is mocked (sandbox
 * providers, git operations). The documented verdict for each test describes
 * whether the bug exists and its impact.
 *
 * Run: npx vitest run --project functional tests/functional/prove-task-service-bugs.test.ts
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessions, settings, tasks } from '../../src/db/schema';
import { updateTaskOnAgentComplete } from '../../src/services/container-agent/shared-helpers';
import { TaskService } from '../../src/services/task.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// ---------- helpers ----------

function createMockWorktreeService() {
  return {
    getDiff: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        files: [{ path: 'src/feature.ts', additions: 42, deletions: 5, status: 'modified' }],
        stats: { filesChanged: 1, additions: 42, deletions: 5 },
      },
    }),
    merge: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

function createMockContainerAgent(overrides: Record<string, unknown> = {}) {
  return {
    providerName: 'docker',
    startAgent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    stopAgent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    isAgentRunning: vi.fn().mockReturnValue(false),
    approvePlan: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    rejectPlan: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    ...overrides,
  };
}

async function enableSandbox(db: ReturnType<typeof getTestDb>) {
  // TEST-SETUP: settings are infrastructure config (no service API for seeding);
  // direct write is intentional. Upsert pattern avoids UNIQUE collisions when
  // leftover rows persist across tests (clearTestDatabase does not touch settings).
  try {
    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ enabled: true, mode: 'shared' }),
    });
  } catch {
    // Already exists — update instead
    await db
      .update(settings)
      .set({ value: JSON.stringify({ enabled: true, mode: 'shared' }) })
      .where(eq(settings.key, 'sandbox.defaults'));
  }
}

// ---------- test suite ----------

describe('Bug-Proving Tests: TaskService', () => {
  let db: ReturnType<typeof getTestDb>;
  let mockWorktreeService: ReturnType<typeof createMockWorktreeService>;
  let taskService: TaskService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    mockWorktreeService = createMockWorktreeService();
    taskService = new TaskService(db, mockWorktreeService);
  });

  afterEach(async () => {
    // Clean up settings too (clearTestDatabase does not delete settings)
    try {
      await db.delete(settings).where(eq(settings.key, 'sandbox.defaults'));
    } catch {
      // safe to ignore
    }
    await clearTestDatabase();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 1: Session created but agent fails — orphaned session
  // ═══════════════════════════════════════════════════════════════════════

  it('BUG PROBE: session persists in DB when agent fails to start (orphaned session)', async () => {
    // Setup: codespace + task + sandbox enabled
    const codespace = await createTestProject({
      name: 'Orphan Session Test',
      path: '/tmp/orphan-session-test',
    });

    const createResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Task that will fail agent start',
    });
    expect(createResult.ok).toBe(true);
    const taskId = createResult.ok ? createResult.value.id : '';

    // Mock: startAgent returns an error
    const mockAgent = createMockContainerAgent({
      startAgent: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'SANDBOX_START_FAILED', message: 'Docker daemon unavailable', status: 500 },
      }),
    });
    taskService.setContainerAgentService(mockAgent);

    await enableSandbox(db);

    // Act: move to in_progress — this creates session THEN triggers agent
    const moveResult = await taskService.moveColumn(taskId, 'in_progress');

    // Assert: move itself succeeded (task moved)
    expect(moveResult.ok).toBe(true);
    const moved = moveResult.ok ? moveResult.value : null;
    expect(moved!.task.column).toBe('backlog');
    expect(moved!.agentError).toContain('Docker daemon unavailable');

    // VERDICT: FIXED — The service now clears sessionId when reverting to backlog.
    // The task no longer references a session after agent-start failure, preventing
    // orphaned session references. The agentError message is returned to the
    // frontend so it can display the failure state.
    const sessionId = moved!.task.sessionId;
    expect(sessionId).toBeNull();

    // Verify the task in DB also has sessionId cleared
    const taskRow = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
    });
    expect(taskRow!.sessionId).toBeNull();
    expect(taskRow!.column).toBe('backlog');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 2: Concurrent task creates cause position collision
  // ═══════════════════════════════════════════════════════════════════════

  it('BUG PROBE: concurrent task creates may produce duplicate positions', async () => {
    const codespace = await createTestProject({
      name: 'Position Collision Test',
      path: '/tmp/position-collision-test',
    });

    // Act: create two tasks concurrently
    const [result1, result2] = await Promise.all([
      taskService.create({
        codespaceId: codespace.id,
        title: 'Concurrent Task A',
      }),
      taskService.create({
        codespaceId: codespace.id,
        title: 'Concurrent Task B',
      }),
    ]);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);

    // Query all backlog tasks and check positions
    const allTasks = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespace.id),
    });

    // FIXED: Position calculation is now wrapped in a db.transaction(), which
    // serializes the read-then-insert under production SQLite and PostgreSQL.
    //
    // Note: In this test environment, the better-sqlite3 monkey-patch for
    // async transaction support uses BEGIN DEFERRED, which does NOT serialize
    // concurrent reads. The race condition may still manifest in tests, but
    // is resolved in production where transactions properly serialize.
    //
    // We verify the concurrently created tasks persisted with unique positions.
    const concurrentTasks = allTasks.filter((task) =>
      ['Concurrent Task A', 'Concurrent Task B'].includes(task.title)
    );
    expect(concurrentTasks.length).toBe(2);
    const concurrentPositions = concurrentTasks.map((task) => task.position);
    expect(new Set(concurrentPositions).size).toBe(concurrentPositions.length);

    // Verify sequential creates always produce unique positions (the fix works
    // for the non-concurrent case, which is the common path):
    const seqResult1 = await taskService.create({
      codespaceId: codespace.id,
      title: 'Sequential Task C',
    });
    const seqResult2 = await taskService.create({
      codespaceId: codespace.id,
      title: 'Sequential Task D',
    });
    expect(seqResult1.ok).toBe(true);
    expect(seqResult2.ok).toBe(true);
    if (!seqResult1.ok || !seqResult2.ok) {
      throw new Error('Expected sequential task creation to succeed');
    }
    expect(seqResult1.value.position).not.toBe(seqResult2.value.position);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 3: Reorders preserve unique positions
  // ═══════════════════════════════════════════════════════════════════════

  it('BUG PROBE: reorder should shift neighboring tasks instead of creating duplicate positions', async () => {
    const codespace = await createTestProject({
      name: 'Reorder Conflict Test',
      path: '/tmp/reorder-conflict-test',
    });

    // Create 3 tasks at positions 0, 1, 2
    const t0 = await createTestTask(codespace.id, {
      title: 'Task 0',
      position: 0,
      column: 'backlog',
    });
    await createTestTask(codespace.id, {
      title: 'Task 1',
      position: 1,
      column: 'backlog',
    });
    await createTestTask(codespace.id, {
      title: 'Task 2',
      position: 2,
      column: 'backlog',
    });

    const reorderResult = await taskService.reorder(t0.id, 2);
    expect(reorderResult.ok).toBe(true);

    // Query final positions
    const finalTasks = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespace.id),
    });

    const positionMap = new Map(finalTasks.map((t) => [t.title, t.position]));

    // Desired behavior: moving Task 0 to the end shifts Task 1 and Task 2 up.
    expect(positionMap.get('Task 0')).toBe(2);
    expect(positionMap.get('Task 1')).toBe(0);
    expect(positionMap.get('Task 2')).toBe(1);

    const positions = finalTasks.map((t) => t.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect([...positions].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('BUG PROBE: same-column moveColumn should reorder instead of returning a no-op', async () => {
    const codespace = await createTestProject({
      name: 'Same Column Move Test',
      path: '/tmp/same-column-move-test',
    });

    const t0 = await createTestTask(codespace.id, {
      title: 'Move Task 0',
      position: 0,
      column: 'backlog',
    });
    await createTestTask(codespace.id, {
      title: 'Move Task 1',
      position: 1,
      column: 'backlog',
    });
    await createTestTask(codespace.id, {
      title: 'Move Task 2',
      position: 2,
      column: 'backlog',
    });

    const moveResult = await taskService.moveColumn(t0.id, 'backlog', 2);
    expect(moveResult.ok).toBe(true);

    const movedTasks = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespace.id),
    });
    const positionMap = new Map(movedTasks.map((t) => [t.title, t.position]));

    expect(positionMap.get('Move Task 0')).toBe(2);
    expect(positionMap.get('Move Task 1')).toBe(0);
    expect(positionMap.get('Move Task 2')).toBe(1);

    const positions = movedTasks.map((t) => t.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect([...positions].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('BUG PROBE: delete should compact positions in the source column', async () => {
    const codespace = await createTestProject({
      name: 'Delete Compact Test',
      path: '/tmp/delete-compact-test',
    });
    await createTestTask(codespace.id, { title: 'Delete Task 0', position: 0, column: 'backlog' });
    const deleted = await createTestTask(codespace.id, {
      title: 'Delete Task 1',
      position: 1,
      column: 'backlog',
    });
    await createTestTask(codespace.id, { title: 'Delete Task 2', position: 2, column: 'backlog' });

    const result = await taskService.delete(deleted.id);
    expect(result.ok).toBe(true);

    const remaining = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespace.id),
    });
    const positions = remaining.map((task) => task.position);
    expect([...positions].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it('BUG PROBE: cancelTask should append to backlog without duplicate positions', async () => {
    const codespace = await createTestProject({
      name: 'Cancel Compact Test',
      path: '/tmp/cancel-compact-test',
    });
    await createTestTask(codespace.id, {
      title: 'Cancel Backlog 0',
      position: 0,
      column: 'backlog',
    });
    await createTestTask(codespace.id, {
      title: 'Cancel Backlog 1',
      position: 1,
      column: 'backlog',
    });
    const cancelled = await createTestTask(codespace.id, {
      title: 'Cancel Waiting',
      position: 0,
      column: 'waiting_approval',
    });

    const result = await taskService.cancelTask(cancelled.id);
    expect(result.ok).toBe(true);

    const backlog = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespace.id),
    });
    const backlogPositions = backlog
      .filter((task) => task.column === 'backlog')
      .map((task) => task.position);
    expect([...backlogPositions].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('BUG PROBE: reject should append to backlog without duplicate positions', async () => {
    const codespace = await createTestProject({
      name: 'Reject Compact Test',
      path: '/tmp/reject-compact-test',
    });
    await createTestTask(codespace.id, {
      title: 'Reject Backlog 0',
      position: 0,
      column: 'backlog',
    });
    await createTestTask(codespace.id, {
      title: 'Reject Backlog 1',
      position: 1,
      column: 'backlog',
    });
    const rejectedTask = await createTestTask(codespace.id, {
      title: 'Reject Waiting',
      position: 0,
      column: 'waiting_approval',
    });

    const result = await taskService.reject(rejectedTask.id, { reason: 'needs changes' });
    expect(result.ok).toBe(true);

    const rows = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespace.id),
    });
    const backlogPositions = rows
      .filter((task) => task.column === 'backlog')
      .map((task) => task.position);
    expect([...backlogPositions].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('BUG PROBE: approve should compact waiting_approval and append to verified', async () => {
    const codespace = await createTestProject({
      name: 'Approve Compact Test',
      path: '/tmp/approve-compact-test',
    });
    const worktree = await createTestWorktree(codespace.id, { status: 'active' });
    const approvedTask = await createTestTask(codespace.id, {
      title: 'Approve Waiting 0',
      position: 0,
      column: 'waiting_approval',
      worktreeId: worktree.id,
      branch: worktree.branch,
    });
    await createTestTask(codespace.id, {
      title: 'Approve Waiting 1',
      position: 1,
      column: 'waiting_approval',
    });
    await createTestTask(codespace.id, {
      title: 'Existing Verified',
      position: 0,
      column: 'verified',
    });

    const result = await taskService.approve(approvedTask.id, {
      approvedBy: 'test-user',
      createMergeCommit: true,
    });
    expect(result.ok).toBe(true);

    const rows = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespace.id),
    });
    const waitingPositions = rows
      .filter((task) => task.column === 'waiting_approval')
      .map((task) => task.position);
    const verifiedPositions = rows
      .filter((task) => task.column === 'verified')
      .map((task) => task.position);
    expect([...waitingPositions].sort((a, b) => a - b)).toEqual([0]);
    expect([...verifiedPositions].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 4: stopAgent fails — task state not cleaned up
  // ═══════════════════════════════════════════════════════════════════════

  it('BUG PROBE: stopAgent failure leaves task with stale agentId', async () => {
    const codespace = await createTestProject({
      name: 'Stop Agent Fail Test',
      path: '/tmp/stop-agent-fail-test',
    });

    const agent = await createTestAgent(codespace.id, {
      status: 'running',
    });

    // TEST-SETUP: FK constraint needs a sessions row; the scenario under test
    // is `stopAgent` behaviour on an already-failing agent, not session
    // creation itself. Going through SessionService.create() would pull in
    // codespace/agent machinery we've already set up with explicit fixtures,
    // so the direct insert is the minimal-surface precondition.
    const testSessionId = 'test-session-stop';
    await db.insert(sessions).values({
      id: testSessionId,
      codespaceId: codespace.id,
      status: 'active',
      url: `/codespaces/${codespace.id}/sessions/${testSessionId}`,
      createdAt: new Date().toISOString(),
    });

    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      agentId: agent.id,
      sessionId: testSessionId,
    });

    // Mock: stopAgent returns an error
    const mockAgent = createMockContainerAgent({
      isAgentRunning: vi.fn().mockReturnValue(true),
      stopAgent: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'SANDBOX_STOP_FAILED', message: 'Container stop timed out', status: 500 },
      }),
    });
    taskService.setContainerAgentService(mockAgent);

    // Act: try to stop the agent
    const result = await taskService.stopAgent(task.id);

    // Assert: result is an error
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TASK_AGENT_STOP_FAILED');
    }

    // VERDICT: BUG FIXED — task state is cleaned up even when stopAgent fails.
    // The agentId and sessionId are cleared, and lastAgentStatus is set to 'error'
    // to indicate the stop failed. The task remains in in_progress but is no longer
    // stuck with a stale agent reference.
    const taskRow = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    expect(taskRow!.agentId).toBeNull(); // agentId cleaned up
    expect(taskRow!.sessionId).toBeTruthy(); // sessionId preserved for UI
    expect(taskRow!.lastAgentStatus).toBe('error'); // marked as error
    expect(taskRow!.column).toBe('in_progress');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 5: getDiff throws exception (not Result error)
  // ═══════════════════════════════════════════════════════════════════════

  it('FIX VERIFIED: getDiff catches worktreeService.getDiff throws and returns Result error', async () => {
    const codespace = await createTestProject({
      name: 'GetDiff Throw Test',
      path: '/tmp/getdiff-throw-test',
    });

    const worktree = await createTestWorktree(codespace.id, { status: 'active' });

    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      worktreeId: worktree.id,
      branch: worktree.branch,
    });

    // Mock: getDiff THROWS an exception (simulating unexpected filesystem error)
    mockWorktreeService.getDiff.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    // Act: call getDiff — after fix, it should return a Result error, not throw
    const result = await taskService.getDiff(task.id);

    // VERDICT: BUG FIXED — getDiff now wraps worktreeService.getDiff() in try/catch
    // and returns err(TaskErrors.NO_DIFF) instead of letting the exception propagate.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TASK_NO_DIFF');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 6: approve() when worktreeService.merge() throws
  // ═══════════════════════════════════════════════════════════════════════

  it('BUG PROBE: approve() crashes when merge throws, task stuck in waiting_approval', async () => {
    const codespace = await createTestProject({
      name: 'Approve Merge Throw Test',
      path: '/tmp/approve-merge-throw-test',
    });

    const worktree = await createTestWorktree(codespace.id, { status: 'active' });

    // Create task as running, then complete it through the real lifecycle helper.
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      worktreeId: worktree.id,
      branch: worktree.branch,
    });
    await updateTaskOnAgentComplete(db, task.id, 'completed');

    // Mock: merge THROWS (simulating git conflict explosion)
    mockWorktreeService.merge.mockRejectedValue(new Error('Merge conflict: cannot auto-merge'));

    // Act: call approve — does it crash or handle gracefully?
    let caughtError: Error | null = null;
    let result: Awaited<ReturnType<typeof taskService.approve>> | null = null;

    try {
      result = await taskService.approve(task.id, {
        approvedBy: 'test-user',
        createMergeCommit: true,
      });
    } catch (error) {
      caughtError = error as Error;
    }

    // VERDICT: BUG FIXED — approve() now catches merge throws and returns
    // a structured Result error instead of letting the exception propagate.
    // The caller gets a proper error with code 'WORKTREE_MERGE_FAILED'.
    expect(caughtError).toBeNull(); // no unhandled exception
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (!result!.ok) {
      expect(result!.error.code).toBe('WORKTREE_MERGE_FAILED');
      expect(result!.error.message).toBe('Merge conflict: cannot auto-merge');
    }

    // Verify task is still in waiting_approval (not corrupted)
    const taskRow = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    expect(taskRow!.column).toBe('waiting_approval');
    expect(taskRow!.approvedAt).toBeNull(); // approval never completed
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Test 7: reject() — does it check lastAgentStatus?
  // ═══════════════════════════════════════════════════════════════════════

  it('BUG PROBE: reject() allows rejection during planning phase without checking lastAgentStatus', async () => {
    const codespace = await createTestProject({
      name: 'Reject Planning Test',
      path: '/tmp/reject-planning-test',
    });

    // Create task in waiting_approval with lastAgentStatus=planning
    // This simulates a task where a plan was submitted but not yet executed
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
    });
    // TEST-SETUP: targets reject() behaviour for a task in waiting_approval
    // with `lastAgentStatus='planning'`. Driving this combo through
    // PlanApprovalService.handlePlanReady() requires a full agent + sandbox
    // harness; direct write is the minimal-surface precondition for the
    // reject() assertion (the bug claim under test).
    await db
      .update(tasks)
      .set({ lastAgentStatus: 'planning', plan: 'Some plan text' })
      .where(eq(tasks.id, task.id));

    // Act: call reject() — it should move task to backlog
    const result = await taskService.reject(task.id, {
      reason: 'Plan is incomplete',
    });

    // VERDICT: NOT A BUG (acceptable behavior).
    // reject() does NOT check lastAgentStatus — it only checks:
    //   1. task.column === 'waiting_approval'
    //   2. input.reason is valid (1-1000 chars)
    //
    // reject() moves a task from waiting_approval back to backlog.
    // Plan rejection is handled by a separate path:
    //   PlanApprovalService.rejectPlan() — also moves to backlog and clears plan.
    expect(result.ok).toBe(true);

    if (result.ok) {
      const rejected = result.value;
      expect(rejected.column).toBe('backlog');
      expect(rejected.rejectionCount).toBe(1);
      expect(rejected.rejectionReason).toBe('Plan is incomplete');
    }

    // Verify DB state — plan and lastAgentStatus are NOT cleared by reject()
    const taskRow = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    expect(taskRow!.column).toBe('backlog');
    expect(taskRow!.lastAgentStatus).toBe('planning'); // NOT cleared
    expect(taskRow!.plan).toBe('Some plan text'); // NOT cleared

    // Compare with approve(): approve() DOES check lastAgentStatus=planning
    // and returns PLAN_NOT_EXECUTED. reject() does NOT have this guard.
    // This asymmetry is a potential design concern but not a crash bug.
  });
});
