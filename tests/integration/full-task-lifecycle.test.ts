import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { TaskService } from '../../src/services/task.service';
import { createMockContainerAgent } from '../factories/container-agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const DIFF_FILES = [
  { path: 'src/index.ts', additions: 15, deletions: 3 },
  { path: 'src/utils.ts', additions: 8, deletions: 1 },
];

const DIFF_STATS = { filesChanged: 2, additions: 23, deletions: 4 };

function createMockWorktreeService() {
  return {
    getDiff: vi.fn().mockResolvedValue({
      ok: true,
      value: { files: DIFF_FILES, stats: DIFF_STATS },
    }),
    merge: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

describe('IT-002: Full Task Lifecycle', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('transitions backlog -> in_progress -> waiting_approval -> verified', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });
    const worktree = await createTestWorktree(codespace.id, { taskId: task.id });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);
    taskService.setContainerAgentService(createMockContainerAgent());

    // Step 1: backlog -> in_progress
    const moveResult = await taskService.moveColumn(task.id, 'in_progress');
    expect(moveResult.ok).toBe(true);
    if (!moveResult.ok) return;

    expect(moveResult.value.task.column).toBe('in_progress');
    expect(moveResult.value.task.startedAt).toBeTruthy();

    // Step 2: Simulate agent completing work — update task to waiting_approval with worktreeId
    await db
      .update(tasks)
      .set({
        column: 'waiting_approval',
        worktreeId: worktree.id,
        branch: worktree.branch,
        plan: 'Implementation plan here',
        lastAgentStatus: 'completed',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, task.id));

    // Step 3: waiting_approval -> verified via approve
    const approveResult = await taskService.approve(task.id, { approvedBy: 'test-user' });
    expect(approveResult.ok).toBe(true);
    if (!approveResult.ok) return;

    const approvedTask = approveResult.value;
    expect(approvedTask.column).toBe('verified');
    expect(approvedTask.approvedAt).toBeTruthy();
    expect(approvedTask.completedAt).toBeTruthy();
    expect(approvedTask.approvedBy).toBe('test-user');
    expect(approvedTask.diffSummary).toEqual(DIFF_STATS);

    // Verify worktree merge and remove were called
    expect(worktreeService.merge).toHaveBeenCalledWith(worktree.id);
    expect(worktreeService.remove).toHaveBeenCalledWith(worktree.id);
  });

  it('sets startedAt on first move to in_progress', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);
    taskService.setContainerAgentService(createMockContainerAgent());

    const result = await taskService.moveColumn(task.id, 'in_progress');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.task.startedAt).toBeTruthy();
    const startedAt = result.value.task.startedAt;
    expect(new Date(startedAt!).getTime()).toBeGreaterThan(0);
  });

  it('rejects invalid transition from backlog to verified', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);
    taskService.setContainerAgentService(createMockContainerAgent());

    const result = await taskService.moveColumn(task.id, 'verified');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('TASK_INVALID_TRANSITION');
  });

  it('rejects invalid transition from in_progress to verified', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);
    taskService.setContainerAgentService(createMockContainerAgent());

    const result = await taskService.moveColumn(task.id, 'verified');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('TASK_INVALID_TRANSITION');
  });
});
