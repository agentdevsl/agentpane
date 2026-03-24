import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const DIFF_FILES = [{ path: 'test.ts', additions: 10, deletions: 2 }];
const DIFF_STATS = { filesChanged: 1, additions: 10, deletions: 2 };

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

describe('IT-006: Task Approval Merge', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('approve triggers worktree merge, sets verified, and cleans up worktree', async () => {
    const codespace = await createTestProject();
    const worktree = await createTestWorktree(codespace.id);
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      worktreeId: worktree.id,
      branch: worktree.branch,
    });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);

    const result = await taskService.approve(task.id, { approvedBy: 'test-user' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.column).toBe('verified');
    expect(result.value.approvedAt).toBeTruthy();
    expect(result.value.completedAt).toBeTruthy();
    expect(result.value.approvedBy).toBe('test-user');
    expect(result.value.diffSummary).toEqual(DIFF_STATS);

    expect(worktreeService.getDiff).toHaveBeenCalledWith(worktree.id);
    expect(worktreeService.merge).toHaveBeenCalledWith(worktree.id);
    expect(worktreeService.remove).toHaveBeenCalledWith(worktree.id);
  });

  it('approve fails for task not in waiting_approval', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);

    const result = await taskService.approve(task.id, { approvedBy: 'test-user' });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('TASK_NOT_WAITING_APPROVAL');
  });

  it('approve fails for task with no worktreeId', async () => {
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      worktreeId: null,
    });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);

    const result = await taskService.approve(task.id, { approvedBy: 'test-user' });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('TASK_NO_DIFF');
  });

  it('approve fails when getDiff returns 0 files changed', async () => {
    const codespace = await createTestProject();
    const worktree = await createTestWorktree(codespace.id);
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      worktreeId: worktree.id,
      branch: worktree.branch,
    });

    const worktreeService = createMockWorktreeService();
    (worktreeService.getDiff as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: { files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } },
    });

    const taskService = new TaskService(db as any, worktreeService);

    const result = await taskService.approve(task.id, { approvedBy: 'test-user' });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('TASK_NO_DIFF');
  });

  it('approve fails for already-approved task', async () => {
    const codespace = await createTestProject();
    const worktree = await createTestWorktree(codespace.id);
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      worktreeId: worktree.id,
      branch: worktree.branch,
      approvedAt: new Date().toISOString() as unknown as Date,
      approvedBy: 'previous-user',
    });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);

    const result = await taskService.approve(task.id, { approvedBy: 'another-user' });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('TASK_ALREADY_APPROVED');
  });

  it('approve fails when merge returns error', async () => {
    const codespace = await createTestProject();
    const worktree = await createTestWorktree(codespace.id);
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      worktreeId: worktree.id,
      branch: worktree.branch,
    });

    const worktreeService = createMockWorktreeService();
    (worktreeService.merge as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: { code: 'MERGE_CONFLICT', message: 'Merge conflict', status: 409 },
    });

    const taskService = new TaskService(db as any, worktreeService);

    const result = await taskService.approve(task.id, { approvedBy: 'test-user' });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('MERGE_CONFLICT');
  });

  it('approve without approvedBy still succeeds', async () => {
    const codespace = await createTestProject();
    const worktree = await createTestWorktree(codespace.id);
    const task = await createTestTask(codespace.id, {
      column: 'waiting_approval',
      worktreeId: worktree.id,
      branch: worktree.branch,
    });

    const worktreeService = createMockWorktreeService();
    const taskService = new TaskService(db as any, worktreeService);

    const result = await taskService.approve(task.id, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.column).toBe('verified');
    expect(result.value.approvedBy).toBeNull();
  });
});
