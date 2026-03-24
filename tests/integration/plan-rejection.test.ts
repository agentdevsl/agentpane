import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tasks } from '../../src/db/schema';
import { ok } from '../../src/lib/utils/result';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const mockWorktreeService = {
  getDiff: async () => ok({ files: [], stats: { filesChanged: 1, additions: 10, deletions: 5 } }),
  merge: async () => ok(undefined),
  remove: async () => ok(undefined),
};

describe('Plan Rejection (IT-008)', () => {
  let taskService: TaskService;
  let codespaceId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    taskService = new TaskService(db, mockWorktreeService);
    const project = await createTestProject({ name: 'Plan Rejection Test' });
    codespaceId = project.id;
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('reject moves task from waiting_approval to in_progress', async () => {
    const worktree = await createTestWorktree(codespaceId);
    const task = await createTestTask(codespaceId, {
      column: 'waiting_approval',
      worktreeId: worktree.id,
    });

    const result = await taskService.reject(task.id, { reason: 'Needs more tests' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.column).toBe('in_progress');
      expect(result.value.rejectionCount).toBe(1);
      expect(result.value.rejectionReason).toBe('Needs more tests');
    }
  });

  it('reject increments rejectionCount on repeated rejections', async () => {
    const worktree = await createTestWorktree(codespaceId);
    const task = await createTestTask(codespaceId, {
      column: 'waiting_approval',
      worktreeId: worktree.id,
      rejectionCount: 2,
    });

    const result = await taskService.reject(task.id, { reason: 'Still not right' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rejectionCount).toBe(3);
    }
  });

  it('reject fails if task is not in waiting_approval', async () => {
    const task = await createTestTask(codespaceId, { column: 'backlog' });

    const result = await taskService.reject(task.id, { reason: 'Bad' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TASK_NOT_WAITING_APPROVAL');
    }
  });

  it('moveColumn from waiting_approval to backlog abandons the task', async () => {
    const db = getTestDb();
    const worktree = await createTestWorktree(codespaceId);
    const task = await createTestTask(codespaceId, {
      column: 'waiting_approval',
      worktreeId: worktree.id,
    });

    // Simulate plan data being set via direct DB update
    db.update(tasks)
      .set({
        plan: 'My implementation plan',
        planOptions: { sdkSessionId: 'sdk-123' },
        lastAgentStatus: 'planning',
      })
      .where(eq(tasks.id, task.id))
      .run();

    const result = await taskService.moveColumn(task.id, 'backlog');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.task.column).toBe('backlog');
    }

    // Verify the task in DB
    const updated = await db.query.tasks.findFirst({
      where: eq(tasks.id, task.id),
    });
    expect(updated!.column).toBe('backlog');
    // Plan data is preserved (moveColumn does not clear it)
    expect(updated!.plan).toBe('My implementation plan');
  });

  it('moveColumn from in_progress to backlog cancels active work', async () => {
    const task = await createTestTask(codespaceId, { column: 'in_progress' });

    const result = await taskService.moveColumn(task.id, 'backlog');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.task.column).toBe('backlog');
    }
  });

  it('reject preserves worktreeId and branch on the task', async () => {
    const worktree = await createTestWorktree(codespaceId, { branch: 'agent/plan-test/task' });
    const task = await createTestTask(codespaceId, {
      column: 'waiting_approval',
      worktreeId: worktree.id,
      branch: worktree.branch,
    });

    const result = await taskService.reject(task.id, { reason: 'Rework needed' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.worktreeId).toBe(worktree.id);
      expect(result.value.branch).toBe('agent/plan-test/task');
    }
  });

  it('reject fails with empty reason', async () => {
    const task = await createTestTask(codespaceId, { column: 'waiting_approval' });

    const result = await taskService.reject(task.id, { reason: '' });

    expect(result.ok).toBe(false);
  });
});
