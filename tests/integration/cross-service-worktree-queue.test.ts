import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tasks, worktrees } from '../../src/db/schema';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('Cross-Service: Worktree & Queue (IT-181 to IT-182)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-181: worktree full lifecycle: active → diff data → merged → removed', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    // Create active worktree
    const worktree = await createTestWorktree(codespace.id, {
      taskId: task.id,
      status: 'active',
    });
    expect(worktree.status).toBe('active');
    expect(worktree.mergedAt).toBeNull();
    expect(worktree.removedAt).toBeNull();

    // Simulate merge
    const mergedAt = new Date().toISOString();
    await db
      .update(worktrees)
      .set({ mergedAt, status: 'active' })
      .where(eq(worktrees.id, worktree.id));

    const afterMerge = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(afterMerge!.mergedAt).toBe(mergedAt);

    // Set to removed
    const removedAt = new Date().toISOString();
    await db
      .update(worktrees)
      .set({ status: 'removed', removedAt })
      .where(eq(worktrees.id, worktree.id));

    const afterRemove = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(afterRemove!.status).toBe('removed');
    expect(afterRemove!.removedAt).toBe(removedAt);
  });

  it('IT-182: FIFO queue dequeue — picks oldest queued task by position', async () => {
    const codespace = await createTestProject();

    // Create 3 queued tasks with explicit positions
    const task1 = await createTestTask(codespace.id, {
      column: 'queued',
      position: 0,
      title: 'First in queue',
    });
    const task2 = await createTestTask(codespace.id, {
      column: 'queued',
      position: 1,
      title: 'Second in queue',
    });
    const task3 = await createTestTask(codespace.id, {
      column: 'queued',
      position: 2,
      title: 'Third in queue',
    });

    // Query ordered by position ASC (FIFO)
    const queued = await db.query.tasks.findMany({
      where: eq(tasks.column, 'queued'),
      orderBy: asc(tasks.position),
    });
    expect(queued.length).toBe(3);
    expect(queued[0]!.id).toBe(task1.id);
    expect(queued[1]!.id).toBe(task2.id);
    expect(queued[2]!.id).toBe(task3.id);

    // Dequeue: pick oldest (position 0), move to in_progress
    await db
      .update(tasks)
      .set({
        column: 'in_progress',
        startedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, queued[0]!.id));

    // Verify remaining queue
    const remaining = await db.query.tasks.findMany({
      where: eq(tasks.column, 'queued'),
      orderBy: asc(tasks.position),
    });
    expect(remaining.length).toBe(2);
    expect(remaining[0]!.id).toBe(task2.id);
    expect(remaining[1]!.id).toBe(task3.id);
  });
});
