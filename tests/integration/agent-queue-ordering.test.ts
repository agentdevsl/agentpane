import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tasks } from '../../src/db/schema';
import { ok } from '../../src/lib/utils/result';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const mockWorktreeService = {
  getDiff: async () => ok({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } }),
  merge: async () => ok(undefined),
  remove: async () => ok(undefined),
};

describe('Agent Queue Ordering (IT-011)', () => {
  let taskService: TaskService;
  let codespaceId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    taskService = new TaskService(db, mockWorktreeService);
    const project = await createTestProject({ name: 'Queue Test' });
    codespaceId = project.id;
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('tasks in queued column maintain FIFO order by position', async () => {
    const db = getTestDb();

    const task1 = await createTestTask(codespaceId, {
      title: 'First',
      column: 'backlog',
      position: 0,
    });
    const task2 = await createTestTask(codespaceId, {
      title: 'Second',
      column: 'backlog',
      position: 1,
    });
    const task3 = await createTestTask(codespaceId, {
      title: 'Third',
      column: 'backlog',
      position: 2,
    });

    // Move to queued in order
    await taskService.moveColumn(task1.id, 'queued');
    await taskService.moveColumn(task2.id, 'queued');
    await taskService.moveColumn(task3.id, 'queued');

    const queuedTasks = await db.query.tasks.findMany({
      where: and(eq(tasks.codespaceId, codespaceId), eq(tasks.column, 'queued')),
      orderBy: [asc(tasks.position)],
    });

    expect(queuedTasks.length).toBe(3);
    expect(queuedTasks[0].title).toBe('First');
    expect(queuedTasks[1].title).toBe('Second');
    expect(queuedTasks[2].title).toBe('Third');

    // Verify positions are sequential
    expect(queuedTasks[0].position).toBe(0);
    expect(queuedTasks[1].position).toBe(1);
    expect(queuedTasks[2].position).toBe(2);
  });

  it('new task queued after existing ones gets next position', async () => {
    await createTestTask(codespaceId, { column: 'queued', position: 0 });
    await createTestTask(codespaceId, { column: 'queued', position: 1 });
    const task3 = await createTestTask(codespaceId, { column: 'backlog', position: 0 });

    const result = await taskService.moveColumn(task3.id, 'queued');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.task.position).toBe(2);
    }
  });

  it('reorder changes position within column', async () => {
    const _task1 = await createTestTask(codespaceId, { column: 'queued', position: 0, title: 'A' });
    const _task2 = await createTestTask(codespaceId, { column: 'queued', position: 1, title: 'B' });
    const task3 = await createTestTask(codespaceId, { column: 'queued', position: 2, title: 'C' });

    // Move task3 to position 0
    const result = await taskService.reorder(task3.id, 0);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.position).toBe(0);
    }
  });

  it('getByColumn returns tasks ordered by position', async () => {
    await createTestTask(codespaceId, { column: 'queued', position: 2, title: 'C' });
    await createTestTask(codespaceId, { column: 'queued', position: 0, title: 'A' });
    await createTestTask(codespaceId, { column: 'queued', position: 1, title: 'B' });

    const result = await taskService.getByColumn(codespaceId, 'queued');

    expect(result.ok).toBe(true);
    if (result.ok) {
      // getByColumn orders by desc position
      expect(result.value.length).toBe(3);
      expect(result.value[0].title).toBe('C');
      expect(result.value[1].title).toBe('B');
      expect(result.value[2].title).toBe('A');
    }
  });

  it('queued tasks from different codespaces are independent', async () => {
    const db = getTestDb();
    const otherProject = await createTestProject({ name: 'Other Queue' });

    await createTestTask(codespaceId, { column: 'queued', position: 0, title: 'Queue A' });
    await createTestTask(codespaceId, { column: 'queued', position: 1, title: 'Queue A2' });
    await createTestTask(otherProject.id, { column: 'queued', position: 0, title: 'Queue B' });

    const queueA = await db.query.tasks.findMany({
      where: and(eq(tasks.codespaceId, codespaceId), eq(tasks.column, 'queued')),
    });
    const queueB = await db.query.tasks.findMany({
      where: and(eq(tasks.codespaceId, otherProject.id), eq(tasks.column, 'queued')),
    });

    expect(queueA.length).toBe(2);
    expect(queueB.length).toBe(1);
  });

  it('moving task out of queued removes it from the queue', async () => {
    const db = getTestDb();
    const task = await createTestTask(codespaceId, {
      column: 'queued',
      position: 0,
      title: 'Dequeue',
    });

    await taskService.moveColumn(task.id, 'in_progress');

    const queuedTasks = await db.query.tasks.findMany({
      where: and(eq(tasks.codespaceId, codespaceId), eq(tasks.column, 'queued')),
    });
    expect(queuedTasks.length).toBe(0);

    const inProgressTasks = await db.query.tasks.findMany({
      where: and(eq(tasks.codespaceId, codespaceId), eq(tasks.column, 'in_progress')),
    });
    expect(inProgressTasks.length).toBe(1);
    expect(inProgressTasks[0].title).toBe('Dequeue');
  });
});
