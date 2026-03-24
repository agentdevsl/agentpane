import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

function createMockWorktreeService() {
  return {
    getDiff: vi.fn(),
    merge: vi.fn(),
    remove: vi.fn(),
  };
}

describe('IT-027: Task Move No-Op (same column)', () => {
  let db: ReturnType<typeof getTestDb>;
  let taskService: TaskService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    taskService = new TaskService(db as any, createMockWorktreeService());
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('returns ok with same task when moving to current column (backlog)', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });

    const result = await taskService.moveColumn(task.id, 'backlog');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.column).toBe('backlog');
    expect(result.value.task.id).toBe(task.id);
  });

  it('does not include agentError on no-op move', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });

    const result = await taskService.moveColumn(task.id, 'backlog');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agentError).toBeUndefined();
  });

  it('does not update the task updatedAt on no-op move', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });
    const originalUpdatedAt = task.updatedAt;

    const result = await taskService.moveColumn(task.id, 'backlog');
    expect(result.ok).toBe(true);

    const dbTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    expect(dbTask!.updatedAt).toBe(originalUpdatedAt);
  });

  it('is a no-op for in_progress column', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'in_progress' });
    const originalUpdatedAt = task.updatedAt;

    const result = await taskService.moveColumn(task.id, 'in_progress');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.column).toBe('in_progress');

    const dbTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    expect(dbTask!.updatedAt).toBe(originalUpdatedAt);
  });

  it('is a no-op for waiting_approval column', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'waiting_approval' });

    const result = await taskService.moveColumn(task.id, 'waiting_approval');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.column).toBe('waiting_approval');
  });

  it('is a no-op for verified column', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'verified' });

    const result = await taskService.moveColumn(task.id, 'verified');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.column).toBe('verified');
  });

  it('is a no-op for queued column', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'queued' });

    const result = await taskService.moveColumn(task.id, 'queued');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.column).toBe('queued');
  });
});
