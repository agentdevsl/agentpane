import { describe, expect, it, vi } from 'vitest';
import { ProjectErrors } from '../../lib/errors/project-errors.js';
import { TaskErrors } from '../../lib/errors/task-errors.js';
import { TaskService } from '../task.service.js';

const createDbMock = () => {
  const mock = {
    query: {
      projects: { findFirst: vi.fn() },
      tasks: { findFirst: vi.fn(), findMany: vi.fn() },
      settings: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn() })) })),
    })),
    delete: vi.fn(() => ({ where: vi.fn() })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      // The transaction callback receives a tx that behaves like the db itself
      return fn(mock);
    }),
  };
  return mock;
};

const createWorktreeServiceMock = () => ({
  getDiff: vi.fn(),
  merge: vi.fn(),
  remove: vi.fn(),
});

describe('TaskService', () => {
  it('creates task in backlog', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
    db.query.tasks.findFirst.mockResolvedValue(null);

    const returning = vi.fn().mockResolvedValue([{ id: 't1', column: 'backlog', position: 0 }]);
    db.insert.mockReturnValue({ values: vi.fn(() => ({ returning })) });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.create({ projectId: 'p1', title: 'Task' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.column).toBe('backlog');
    }
  });

  it('returns error if project missing', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.projects.findFirst.mockResolvedValue(null);

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.create({ projectId: 'p1', title: 'Task' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(ProjectErrors.NOT_FOUND);
    }
  });

  it('rejects invalid column transitions', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({ id: 't1', column: 'backlog', projectId: 'p1' });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.moveColumn('t1', 'verified');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TASK_INVALID_TRANSITION');
      expect(result.error.details?.from).toBe('backlog');
      expect(result.error.details?.to).toBe('verified');
      expect(result.error.details?.allowedTransitions).toEqual(['queued', 'in_progress']);
    }
  });

  it('approves task by merging', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'waiting_approval',
      worktreeId: 'w1',
      projectId: 'p1',
    });

    worktrees.getDiff.mockResolvedValue({
      ok: true,
      value: { stats: { filesChanged: 1, additions: 1, deletions: 0 } },
    });
    worktrees.merge.mockResolvedValue({ ok: true });
    worktrees.remove.mockResolvedValue({ ok: true });

    db.update.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 't1' }]) })),
      })),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.approve('t1', { approvedBy: 'user' });

    expect(result.ok).toBe(true);
  });

  it('rejects with reason', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'waiting_approval',
      rejectionCount: 0,
    });

    db.update.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 't1' }]) })),
      })),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.reject('t1', { reason: 'needs changes' });

    expect(result.ok).toBe(true);
  });

  it('returns error when approve has no diff', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'waiting_approval',
      worktreeId: 'w1',
    });
    worktrees.getDiff.mockResolvedValue({
      ok: true,
      value: { stats: { filesChanged: 0, additions: 0, deletions: 0 } },
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.approve('t1', { approvedBy: 'user' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NO_DIFF);
    }
  });

  it('getById returns task when found', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      title: 'Test Task',
      column: 'backlog',
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.getById('t1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('t1');
      expect(result.value.title).toBe('Test Task');
    }
  });

  it('getById returns error when task not found', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue(null);

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.getById('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NOT_FOUND);
    }
  });

  it('list returns tasks with default options', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findMany.mockResolvedValue([
      { id: 't1', title: 'Task 1', column: 'backlog' },
      { id: 't2', title: 'Task 2', column: 'backlog' },
    ]);

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.list('p1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
  });

  it('list filters by column', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findMany.mockResolvedValue([
      { id: 't1', title: 'Task 1', column: 'in_progress' },
    ]);

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.list('p1', { column: 'in_progress' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
    }
  });

  it('list filters by agentId', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findMany.mockResolvedValue([{ id: 't1', title: 'Task 1', agentId: 'a1' }]);

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.list('p1', { agentId: 'a1' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
    }
  });

  it('list supports all orderBy options', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findMany.mockResolvedValue([]);

    const service = new TaskService(db as never, worktrees as never);

    // Test orderBy createdAt
    const result1 = await service.list('p1', { orderBy: 'createdAt', orderDirection: 'desc' });
    expect(result1.ok).toBeTruthy();

    // Test orderBy updatedAt
    const result2 = await service.list('p1', { orderBy: 'updatedAt', orderDirection: 'asc' });
    expect(result2.ok).toBeTruthy();

    // Test orderBy position (default)
    const result3 = await service.list('p1', { orderBy: 'position' });
    expect(result3.ok).toBeTruthy();
  });

  it('update modifies task successfully', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();

    const updateReturning = vi
      .fn()
      .mockResolvedValue([{ id: 't1', title: 'Updated Title', description: 'New desc' }]);
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.update('t1', {
      title: 'Updated Title',
      description: 'New desc',
      labels: ['bug'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe('Updated Title');
    }
  });

  it('update returns error when task not found', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();

    const updateReturning = vi.fn().mockResolvedValue([]);
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.update('missing', { title: 'New' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NOT_FOUND);
    }
  });

  it('delete removes task successfully', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({ id: 't1' });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.delete('t1');

    expect(result.ok).toBe(true);
    expect(db.delete).toHaveBeenCalled();
  });

  it('delete returns error when task not found', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue(null);

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.delete('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NOT_FOUND);
    }
  });

  it('moveColumn transitions task successfully', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst
      .mockResolvedValueOnce({ id: 't1', column: 'backlog', projectId: 'p1' })
      .mockResolvedValueOnce(null); // No existing tasks in column

    const updateReturning = vi
      .fn()
      .mockResolvedValue([{ id: 't1', column: 'in_progress', position: 0 }]);
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.moveColumn('t1', 'in_progress');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.task.column).toBe('in_progress');
    }
  });

  it('moveColumn returns error when task not found', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue(null);

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.moveColumn('missing', 'in_progress');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NOT_FOUND);
    }
  });

  it('moveColumn with explicit position', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'backlog',
      projectId: 'p1',
    });

    const updateReturning = vi
      .fn()
      .mockResolvedValue([{ id: 't1', column: 'in_progress', position: 5 }]);
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.moveColumn('t1', 'in_progress', 5);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.task.position).toBe(5);
    }
  });

  it('moveColumn sets startedAt when moving to in_progress', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst
      .mockResolvedValueOnce({ id: 't1', column: 'backlog', projectId: 'p1' })
      .mockResolvedValueOnce(null);

    const updateReturning = vi
      .fn()
      .mockResolvedValue([{ id: 't1', column: 'in_progress', startedAt: new Date() }]);
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.moveColumn('t1', 'in_progress');

    expect(result.ok).toBe(true);
  });

  it('moveColumn returns error when update fails', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst
      .mockResolvedValueOnce({ id: 't1', column: 'backlog', projectId: 'p1' })
      .mockResolvedValueOnce(null);

    const updateReturning = vi.fn().mockResolvedValue([]);
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.moveColumn('t1', 'in_progress');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NOT_FOUND);
    }
  });

  it('reorder updates task position', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();

    const updateReturning = vi.fn().mockResolvedValue([{ id: 't1', position: 3 }]);
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.reorder('t1', 3);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.position).toBe(3);
    }
  });

  it('reorder returns error when task not found', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();

    const updateReturning = vi.fn().mockResolvedValue([]);
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.reorder('missing', 3);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NOT_FOUND);
    }
  });

  it('getByColumn returns tasks in specific column', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findMany.mockResolvedValue([
      { id: 't1', column: 'waiting_approval' },
      { id: 't2', column: 'waiting_approval' },
    ]);

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.getByColumn('p1', 'waiting_approval');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
  });

  it('approve returns error when task not found', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue(null);

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.approve('missing', { approvedBy: 'user' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NOT_FOUND);
    }
  });

  it('approve returns error when task not in waiting_approval', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'in_progress',
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.approve('t1', { approvedBy: 'user' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const expected = TaskErrors.NOT_WAITING_APPROVAL('in_progress');
      expect(result.error).toMatchObject({
        code: expected.code,
        message: expected.message,
        status: expected.status,
        details: expected.details,
      });
    }
  });

  it('approve returns error when already approved', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'waiting_approval',
      approvedAt: new Date(),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.approve('t1', { approvedBy: 'user' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.ALREADY_APPROVED);
    }
  });

  it('approve returns error when no worktree', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'waiting_approval',
      worktreeId: null,
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.approve('t1', { approvedBy: 'user' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NO_DIFF);
    }
  });

  it('approve returns error when getDiff fails', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'waiting_approval',
      worktreeId: 'w1',
    });
    worktrees.getDiff.mockResolvedValue({
      ok: false,
      error: { code: 'WORKTREE_NOT_FOUND', message: 'Not found' },
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.approve('t1', { approvedBy: 'user' });

    expect(result.ok).toBe(false);
  });

  it('approve skips merge when createMergeCommit is false', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'waiting_approval',
      worktreeId: 'w1',
      projectId: 'p1',
    });

    worktrees.getDiff.mockResolvedValue({
      ok: true,
      value: { stats: { filesChanged: 1, additions: 1, deletions: 0 } },
    });
    worktrees.remove.mockResolvedValue({ ok: true });

    db.update.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 't1' }]) })),
      })),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.approve('t1', {
      approvedBy: 'user',
      createMergeCommit: false,
    });

    expect(result.ok).toBe(true);
    expect(worktrees.merge).not.toHaveBeenCalled();
  });

  it('approve returns error when merge fails', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'waiting_approval',
      worktreeId: 'w1',
      projectId: 'p1',
    });

    worktrees.getDiff.mockResolvedValue({
      ok: true,
      value: { stats: { filesChanged: 1, additions: 1, deletions: 0 } },
    });
    worktrees.merge.mockResolvedValue({
      ok: false,
      error: { code: 'WORKTREE_MERGE_CONFLICT', message: 'Conflict' },
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.approve('t1', { approvedBy: 'user' });

    expect(result.ok).toBe(false);
  });

  it('approve returns error when update fails', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'waiting_approval',
      worktreeId: 'w1',
      projectId: 'p1',
    });

    worktrees.getDiff.mockResolvedValue({
      ok: true,
      value: { stats: { filesChanged: 1, additions: 1, deletions: 0 } },
    });
    worktrees.merge.mockResolvedValue({ ok: true });
    worktrees.remove.mockResolvedValue({ ok: true });

    db.update.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
      })),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.approve('t1', { approvedBy: 'user' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NOT_FOUND);
    }
  });

  it('reject returns error when task not found', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue(null);

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.reject('missing', { reason: 'needs work' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NOT_FOUND);
    }
  });

  it('reject returns error when task not in waiting_approval', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'in_progress',
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.reject('t1', { reason: 'needs work' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const expected = TaskErrors.NOT_WAITING_APPROVAL('in_progress');
      expect(result.error).toMatchObject({
        code: expected.code,
        message: expected.message,
        status: expected.status,
        details: expected.details,
      });
    }
  });

  it('reject returns error with empty reason', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'waiting_approval',
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.reject('t1', { reason: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ENUM_VALUE');
    }
  });

  it('reject returns error with too long reason', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'waiting_approval',
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.reject('t1', { reason: 'x'.repeat(1001) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ENUM_VALUE');
    }
  });

  it('reject returns error when update fails', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      column: 'waiting_approval',
      rejectionCount: 0,
    });

    db.update.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
      })),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.reject('t1', { reason: 'needs work' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NOT_FOUND);
    }
  });

  it('getDiff returns error when task not found', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue(null);

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.getDiff('missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NOT_FOUND);
    }
  });

  it('getDiff returns error when no worktree or branch', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      worktreeId: null,
      branch: null,
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.getDiff('t1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NO_DIFF);
    }
  });

  it('getDiff returns error when worktreeService.getDiff fails', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      worktreeId: 'w1',
      branch: 'feature/test',
    });
    worktrees.getDiff.mockResolvedValue({
      ok: false,
      error: { code: 'WORKTREE_NOT_FOUND', message: 'Not found' },
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.getDiff('t1');

    expect(result.ok).toBe(false);
  });

  it('getDiff returns diff result on success', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't1',
      worktreeId: 'w1',
      branch: 'feature/test',
    });
    worktrees.getDiff.mockResolvedValue({
      ok: true,
      value: {
        files: [{ path: 'file.ts', status: 'modified' }],
        stats: { filesChanged: 1, additions: 10, deletions: 5 },
      },
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.getDiff('t1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.taskId).toBe('t1');
      expect(result.value.branch).toBe('feature/test');
      expect(result.value.baseBranch).toBe('main');
      expect(result.value.files).toHaveLength(1);
    }
  });

  it('create handles existing tasks in backlog for position', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
    db.query.tasks.findFirst.mockResolvedValue({
      id: 't0',
      position: 5,
    });

    const returning = vi.fn().mockResolvedValue([{ id: 't1', column: 'backlog', position: 6 }]);
    db.insert.mockReturnValue({ values: vi.fn(() => ({ returning })) });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.create({ projectId: 'p1', title: 'Task' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.position).toBe(6);
    }
  });

  it('create returns error when insert fails', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
    db.query.tasks.findFirst.mockResolvedValue(null);

    const returning = vi.fn().mockResolvedValue([]);
    db.insert.mockReturnValue({ values: vi.fn(() => ({ returning })) });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.create({ projectId: 'p1', title: 'Task' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject(TaskErrors.NOT_FOUND);
    }
  });

  it('moveColumn sets completedAt when moving to verified', async () => {
    const db = createDbMock();
    const worktrees = createWorktreeServiceMock();
    db.query.tasks.findFirst
      .mockResolvedValueOnce({ id: 't1', column: 'waiting_approval', projectId: 'p1' })
      .mockResolvedValueOnce(null);

    const updateReturning = vi
      .fn()
      .mockResolvedValue([{ id: 't1', column: 'verified', completedAt: new Date() }]);
    db.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: updateReturning })) })),
    });

    const service = new TaskService(db as never, worktrees as never);
    const result = await service.moveColumn('t1', 'verified');

    expect(result.ok).toBe(true);
  });
});
