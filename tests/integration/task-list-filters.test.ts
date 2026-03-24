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

describe('IT-030: TaskService.list() Filters and Pagination', () => {
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

  it('filters tasks by column', async () => {
    const codespace = await createTestProject();

    await createTestTask(codespace.id, { column: 'backlog', position: 0 });
    await createTestTask(codespace.id, { column: 'backlog', position: 1 });
    await createTestTask(codespace.id, { column: 'backlog', position: 2 });
    await createTestTask(codespace.id, { column: 'in_progress', position: 0 });
    await createTestTask(codespace.id, { column: 'in_progress', position: 1 });
    await createTestTask(codespace.id, { column: 'verified', position: 0 });

    const backlogResult = await taskService.list(codespace.id, { column: 'backlog' });
    expect(backlogResult.ok).toBe(true);
    if (!backlogResult.ok) return;
    expect(backlogResult.value).toHaveLength(3);

    const inProgressResult = await taskService.list(codespace.id, { column: 'in_progress' });
    expect(inProgressResult.ok).toBe(true);
    if (!inProgressResult.ok) return;
    expect(inProgressResult.value).toHaveLength(2);

    const verifiedResult = await taskService.list(codespace.id, { column: 'verified' });
    expect(verifiedResult.ok).toBe(true);
    if (!verifiedResult.ok) return;
    expect(verifiedResult.value).toHaveLength(1);
  });

  it('returns all tasks for a codespace without column filter', async () => {
    const codespace = await createTestProject();

    await createTestTask(codespace.id, { column: 'backlog', position: 0 });
    await createTestTask(codespace.id, { column: 'backlog', position: 1 });
    await createTestTask(codespace.id, { column: 'backlog', position: 2 });
    await createTestTask(codespace.id, { column: 'in_progress', position: 0 });
    await createTestTask(codespace.id, { column: 'in_progress', position: 1 });
    await createTestTask(codespace.id, { column: 'verified', position: 0 });

    const result = await taskService.list(codespace.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(6);
  });

  it('isolates tasks between codespaces', async () => {
    const codespaceA = await createTestProject({ name: 'Codespace A' });
    const codespaceB = await createTestProject({ name: 'Codespace B' });

    await createTestTask(codespaceA.id, { column: 'backlog', position: 0 });
    await createTestTask(codespaceA.id, { column: 'backlog', position: 1 });
    await createTestTask(codespaceA.id, { column: 'backlog', position: 2 });
    await createTestTask(codespaceA.id, { column: 'in_progress', position: 0 });
    await createTestTask(codespaceA.id, { column: 'in_progress', position: 1 });
    await createTestTask(codespaceA.id, { column: 'verified', position: 0 });

    await createTestTask(codespaceB.id, { column: 'backlog', position: 0 });
    await createTestTask(codespaceB.id, { column: 'backlog', position: 1 });

    const resultA = await taskService.list(codespaceA.id);
    expect(resultA.ok).toBe(true);
    if (!resultA.ok) return;
    expect(resultA.value).toHaveLength(6);

    const resultB = await taskService.list(codespaceB.id);
    expect(resultB.ok).toBe(true);
    if (!resultB.ok) return;
    expect(resultB.value).toHaveLength(2);
  });

  it('paginates with limit and offset', async () => {
    const codespace = await createTestProject();

    for (let i = 0; i < 6; i++) {
      await createTestTask(codespace.id, {
        column: 'backlog',
        position: i,
        title: `Task ${i}`,
      });
    }

    const page1 = await taskService.list(codespace.id, { limit: 2, offset: 0 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value).toHaveLength(2);

    const page2 = await taskService.list(codespace.id, { limit: 2, offset: 2 });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value).toHaveLength(2);

    const page1Ids = page1.value.map((t) => t.id);
    const page2Ids = page2.value.map((t) => t.id);
    for (const id of page2Ids) {
      expect(page1Ids).not.toContain(id);
    }
  });

  it('orders by position ascending by default', async () => {
    const codespace = await createTestProject();

    await createTestTask(codespace.id, { column: 'backlog', position: 2, title: 'Third' });
    await createTestTask(codespace.id, { column: 'backlog', position: 0, title: 'First' });
    await createTestTask(codespace.id, { column: 'backlog', position: 1, title: 'Second' });

    const result = await taskService.list(codespace.id, { column: 'backlog' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value[0].position).toBe(0);
    expect(result.value[1].position).toBe(1);
    expect(result.value[2].position).toBe(2);
  });

  it('orders by createdAt when specified', async () => {
    const codespace = await createTestProject();

    const task1 = await createTestTask(codespace.id, { column: 'backlog', position: 0 });
    const task2 = await createTestTask(codespace.id, { column: 'backlog', position: 1 });
    const task3 = await createTestTask(codespace.id, { column: 'backlog', position: 2 });

    await db
      .update(tasks)
      .set({ createdAt: '2025-01-01T00:00:00.000Z' })
      .where(eq(tasks.id, task1.id));
    await db
      .update(tasks)
      .set({ createdAt: '2025-01-02T00:00:00.000Z' })
      .where(eq(tasks.id, task2.id));
    await db
      .update(tasks)
      .set({ createdAt: '2025-01-03T00:00:00.000Z' })
      .where(eq(tasks.id, task3.id));

    const resultAsc = await taskService.list(codespace.id, {
      column: 'backlog',
      orderBy: 'createdAt',
      orderDirection: 'asc',
    });
    expect(resultAsc.ok).toBe(true);
    if (!resultAsc.ok) return;
    expect(resultAsc.value).toHaveLength(3);
    expect(resultAsc.value[0].id).toBe(task1.id);
    expect(resultAsc.value[2].id).toBe(task3.id);

    const resultDesc = await taskService.list(codespace.id, {
      column: 'backlog',
      orderBy: 'createdAt',
      orderDirection: 'desc',
    });
    expect(resultDesc.ok).toBe(true);
    if (!resultDesc.ok) return;
    expect(resultDesc.value).toHaveLength(3);
    expect(resultDesc.value[0].id).toBe(task3.id);
    expect(resultDesc.value[2].id).toBe(task1.id);
  });

  it('returns empty array for column with no tasks', async () => {
    const codespace = await createTestProject();

    await createTestTask(codespace.id, { column: 'backlog', position: 0 });

    const result = await taskService.list(codespace.id, { column: 'verified' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it('returns empty array for codespace with no tasks', async () => {
    const codespace = await createTestProject();

    const result = await taskService.list(codespace.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });
});
