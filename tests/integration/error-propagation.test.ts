import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks, worktrees } from '../../src/db/schema';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const mockWorktreeService = {
  getDiff: vi.fn().mockResolvedValue({
    ok: true,
    value: { files: [], stats: { filesChanged: 1, additions: 10, deletions: 5 } },
  }),
  merge: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
};

describe('Error Propagation (IT-201 to IT-205)', () => {
  let db: ReturnType<typeof getTestDb>;
  let taskService: TaskService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    taskService = new TaskService(db as never, mockWorktreeService);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-201: TaskService returns NOT_FOUND (404) and INVALID_TRANSITION (400)', async () => {
    // NOT_FOUND
    const notFound = await taskService.getById('nonexistent-id');
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) {
      expect(notFound.error.code).toBe('TASK_NOT_FOUND');
      expect(notFound.error.status).toBe(404);
    }

    // INVALID_TRANSITION
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });
    const invalid = await taskService.moveColumn(task.id, 'verified');
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe('TASK_INVALID_TRANSITION');
      expect(invalid.error.status).toBe(400);
    }
  });

  it('IT-202: INVALID_TRANSITION error includes from, to, allowedTransitions', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });

    const result = await taskService.moveColumn(task.id, 'waiting_approval');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TASK_INVALID_TRANSITION');
      const details = result.error.details as Record<string, unknown>;
      expect(details.from).toBe('backlog');
      expect(details.to).toBe('waiting_approval');
      expect(details.allowedTransitions).toEqual(expect.arrayContaining(['queued', 'in_progress']));
    }
  });

  it('IT-203: query sessionEvents for nonexistent session returns empty', async () => {
    const { sessionEvents } = await import('../../src/db/schema');
    const events = await db.query.sessionEvents.findMany({
      where: eq(sessionEvents.sessionId, 'nonexistent-session-id'),
    });
    expect(events).toEqual([]);
  });

  it('IT-204: TaskService.create with nonexistent codespaceId returns CODESPACE_NOT_FOUND', async () => {
    const result = await taskService.create({
      codespaceId: 'nonexistent-codespace',
      title: 'Should fail',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CODESPACE_NOT_FOUND');
    }
  });

  it('IT-205: task references deleted worktree — stale worktreeId detected', async () => {
    const codespace = await createTestProject();
    const worktree = await createTestWorktree(codespace.id, { status: 'active' });
    const task = await createTestTask(codespace.id, {
      column: 'in_progress',
      worktreeId: worktree.id,
    });

    // Verify task has worktreeId
    const before = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(before!.worktreeId).toBe(worktree.id);

    // Delete worktree — FK set null should clear worktreeId on task
    await db.delete(worktrees).where(eq(worktrees.id, worktree.id));

    // Verify worktree is gone
    const deletedWorktree = await db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktree.id),
    });
    expect(deletedWorktree).toBeUndefined();

    // Task's worktreeId should be set to null by FK onDelete: 'set null'
    const after = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(after!.worktreeId).toBeNull();
  });
});
