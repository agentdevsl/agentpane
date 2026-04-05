import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

function createMockWorktreeService() {
  return {
    getDiff: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        files: [{ path: 'test.ts', additions: 5, deletions: 1 }],
        stats: { filesChanged: 1, additions: 5, deletions: 1 },
      },
    }),
    merge: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

describe('IT-005: Task Rejection Cycle', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('reject increments rejectionCount and moves task to backlog', async () => {
    const codespace = await createTestProject();
    const worktree = await createTestWorktree(codespace.id);
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      worktreeId: worktree.id,
      branch: worktree.branch,
    });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);

    const result = await taskService.reject(task.id, { reason: 'Tests are failing' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.column).toBe('backlog');
    expect(result.value.rejectionCount).toBe(1);
    expect(result.value.rejectionReason).toBe('Tests are failing');
  });

  it('multiple rejection cycles increment rejectionCount correctly', async () => {
    const codespace = await createTestProject();
    const worktree = await createTestWorktree(codespace.id);
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      worktreeId: worktree.id,
      branch: worktree.branch,
    });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);

    // First rejection: waiting_approval -> backlog
    const reject1 = await taskService.reject(task.id, { reason: 'First issue' });
    expect(reject1.ok).toBe(true);
    if (!reject1.ok) return;

    expect(reject1.value.column).toBe('backlog');
    expect(reject1.value.rejectionCount).toBe(1);

    // Simulate agent resubmitting: backlog -> waiting_approval
    const move1 = await taskService.moveColumn(task.id, 'waiting_approval');
    expect(move1.ok).toBe(true);
    if (!move1.ok) return;

    expect(move1.value.task.column).toBe('waiting_approval');

    // Second rejection: waiting_approval -> backlog
    const reject2 = await taskService.reject(task.id, { reason: 'Second issue' });
    expect(reject2.ok).toBe(true);
    if (!reject2.ok) return;

    expect(reject2.value.column).toBe('backlog');
    expect(reject2.value.rejectionCount).toBe(2);
    expect(reject2.value.rejectionReason).toBe('Second issue');
  });

  it('reject fails for task not in waiting_approval', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);

    const result = await taskService.reject(task.id, { reason: 'Should fail' });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('TASK_NOT_WAITING_APPROVAL');
  });

  it('reject fails with empty reason', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'waiting_approval' });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);

    const result = await taskService.reject(task.id, { reason: '' });

    expect(result.ok).toBe(false);
  });

  it('moveColumn from backlog to in_progress works without affecting rejection state', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);

    const result = await taskService.moveColumn(task.id, 'in_progress');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify DB state: rejectionCount should remain 0
    const dbTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    expect(dbTask!.rejectionCount).toBe(0);
    expect(dbTask!.rejectionReason).toBeNull();
  });
});
