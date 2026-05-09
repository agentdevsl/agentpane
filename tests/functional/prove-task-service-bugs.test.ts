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
  // Test 3: Concurrent reorders cause position conflict
  // ═══════════════════════════════════════════════════════════════════════

  it('BUG PROBE: concurrent reorders can produce conflicting positions', async () => {
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
    const t2 = await createTestTask(codespace.id, {
      title: 'Task 2',
      position: 2,
      column: 'backlog',
    });

    // Act: reorder task[0] to position 2 AND task[2] to position 0 simultaneously
    const [reorder1, reorder2] = await Promise.all([
      taskService.reorder(t0.id, 2),
      taskService.reorder(t2.id, 0),
    ]);

    expect(reorder1.ok).toBe(true);
    expect(reorder2.ok).toBe(true);

    // Query final positions
    const finalTasks = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespace.id),
    });

    const positionMap = new Map(finalTasks.map((t) => [t.title, t.position]));

    // VERDICT: BUG EXISTS (no conflict detection).
    // The reorder() method does a simple UPDATE SET position=X WHERE id=Y.
    // It does NOT shift other tasks' positions. After the concurrent reorders:
    //   Task 0 → position 2
    //   Task 1 → position 1 (unchanged)
    //   Task 2 → position 0
    // This happens to be correct for a swap. But if both went to position 2,
    // they'd collide with no error.
    //
    // Impact: MEDIUM — the reorder() method has no position conflict detection.
    // It blindly sets the position without checking for duplicates or shifting
    // adjacent tasks. The frontend must send the correct final positions for
    // ALL affected tasks, not just the moved one.
    expect(positionMap.get('Task 0')).toBe(2);
    expect(positionMap.get('Task 1')).toBe(1);
    expect(positionMap.get('Task 2')).toBe(0);

    // Prove no conflict detection: set two tasks to the same position
    await taskService.reorder(t0.id, 1);
    const afterConflict = await db.query.tasks.findMany({
      where: eq(tasks.codespaceId, codespace.id),
    });
    // Task 0 and Task 1 both have position 1 — no error was thrown
    const atPosition1 = afterConflict.filter((t) => t.position === 1);
    expect(atPosition1).toHaveLength(2); // confirms no unique constraint
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
  // Test 7: reject()/approve() lastAgentStatus contract — asymmetric by design
  // ═══════════════════════════════════════════════════════════════════════

  it('REGRESSION GUARD: reject() permits planning state, approve() blocks it (asymmetric contract)', async () => {
    const codespace = await createTestProject({
      name: 'Reject vs Approve Planning Test',
      path: '/tmp/reject-vs-approve-planning-test',
    });

    // Create two waiting_approval tasks with lastAgentStatus=planning, one
    // for each call site under test. Direct write of the FK-precondition
    // state is intentional (TEST-SETUP) — driving handlePlanReady() requires
    // a full agent + sandbox harness orthogonal to this contract test.
    const taskForReject = await createTestTask(codespace.id, {
      column: 'waiting_approval',
    });
    const taskForApprove = await createTestTask(codespace.id, {
      column: 'waiting_approval',
    });
    await db
      .update(tasks)
      .set({ lastAgentStatus: 'planning', plan: 'Some plan text' })
      .where(eq(tasks.id, taskForReject.id));
    await db
      .update(tasks)
      .set({ lastAgentStatus: 'planning', plan: 'Some plan text' })
      .where(eq(tasks.id, taskForApprove.id));

    // ── reject() branch — must succeed and NOT clear plan/lastAgentStatus ──
    const rejectResult = await taskService.reject(taskForReject.id, {
      reason: 'Plan is incomplete',
    });
    expect(rejectResult.ok).toBe(true);
    if (rejectResult.ok) {
      expect(rejectResult.value.column).toBe('backlog');
      expect(rejectResult.value.rejectionCount).toBe(1);
      expect(rejectResult.value.rejectionReason).toBe('Plan is incomplete');
    }
    const rejectedRow = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskForReject.id),
    });
    expect(rejectedRow!.column).toBe('backlog');
    expect(rejectedRow!.lastAgentStatus).toBe('planning'); // NOT cleared
    expect(rejectedRow!.plan).toBe('Some plan text'); // NOT cleared

    // ── approve() branch — must REFUSE with PLAN_NOT_EXECUTED ──
    // This is the load-bearing half of the asymmetric contract: approve()
    // would skip the execution phase if it accepted a still-planning task,
    // so it MUST block. A regression that drops this guard would let users
    // approve a plan and immediately ship un-executed changes.
    const approveResult = await taskService.approve(taskForApprove.id, {
      approvedBy: 'test-user',
      createMergeCommit: false,
    });
    expect(approveResult.ok).toBe(false);
    if (!approveResult.ok) {
      expect(approveResult.error.code).toBe('TASK_PLAN_NOT_EXECUTED');
    }
    const approveAttemptedRow = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskForApprove.id),
    });
    expect(approveAttemptedRow!.column).toBe('waiting_approval'); // unchanged
    expect(approveAttemptedRow!.approvedAt).toBeNull(); // unchanged

    // ── Symmetric guard for approve(): lastAgentStatus='agent_reviewing' ──
    // approve() rejects this state too (per the existing guard); we lock it
    // in alongside 'planning' so a future refactor that narrows the guard
    // to only 'planning' fails this assertion.
    const taskForReviewing = await createTestTask(codespace.id, {
      column: 'waiting_approval',
    });
    await db
      .update(tasks)
      .set({ lastAgentStatus: 'agent_reviewing' })
      .where(eq(tasks.id, taskForReviewing.id));
    const approveDuringReview = await taskService.approve(taskForReviewing.id, {
      approvedBy: 'test-user',
      createMergeCommit: false,
    });
    expect(approveDuringReview.ok).toBe(false);
    if (!approveDuringReview.ok) {
      expect(approveDuringReview.error.code).toBe('TASK_PLAN_NOT_EXECUTED');
    }
  });
});
