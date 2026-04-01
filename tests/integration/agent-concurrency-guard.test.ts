import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../src/db/schema';
import { ok } from '../../src/lib/utils/result';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-017: Agent concurrency guard', () => {
  const mockWorktreeService = {
    getDiff: async () => ok({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } }),
    merge: async () => ok(undefined),
    remove: async () => ok(undefined),
  };

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ enabled: true, provider: 'docker', idleTimeoutMinutes: 30 }),
    });
  });

  afterEach(async () => {
    const db = getTestDb();
    await db.delete(settings).where(eq(settings.key, 'sandbox.defaults'));
    await clearTestDatabase();
  });

  it('skips startAgent when isAgentRunning returns true', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'backlog' });

    const mockContainerAgent = {
      providerName: 'docker',
      startAgent: vi.fn().mockResolvedValue(ok(undefined)),
      stopAgent: vi.fn().mockResolvedValue(ok(undefined)),
      isAgentRunning: vi.fn().mockReturnValue(true),
      approvePlan: vi.fn().mockResolvedValue(ok(undefined)),
      rejectPlan: vi.fn().mockResolvedValue(ok(undefined)),
    };

    const taskService = new TaskService(db, mockWorktreeService);
    taskService.setContainerAgentService(mockContainerAgent);

    const result = await taskService.moveColumn(task.id, 'in_progress');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.task.column).toBe('in_progress');
    }

    expect(mockContainerAgent.isAgentRunning).toHaveBeenCalledWith(task.id);
    expect(mockContainerAgent.startAgent).not.toHaveBeenCalled();
  });

  it('calls startAgent when isAgentRunning returns false', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'backlog' });

    const mockContainerAgent = {
      providerName: 'docker',
      startAgent: vi.fn().mockResolvedValue(ok(undefined)),
      stopAgent: vi.fn().mockResolvedValue(ok(undefined)),
      isAgentRunning: vi.fn().mockReturnValue(false),
      approvePlan: vi.fn().mockResolvedValue(ok(undefined)),
      rejectPlan: vi.fn().mockResolvedValue(ok(undefined)),
    };

    const taskService = new TaskService(db, mockWorktreeService);
    taskService.setContainerAgentService(mockContainerAgent);

    const result = await taskService.moveColumn(task.id, 'in_progress');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.task.column).toBe('in_progress');
      expect(result.value.task.sessionId).toBeTruthy();
    }

    expect(mockContainerAgent.isAgentRunning).toHaveBeenCalledWith(task.id);
    expect(mockContainerAgent.startAgent).toHaveBeenCalledTimes(1);
    expect(mockContainerAgent.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        codespaceId: project.id,
        taskId: task.id,
        prompt: expect.any(String),
      })
    );
  });

  it('returns agentError when startAgent fails', async () => {
    const db = getTestDb();
    const project = await createTestProject();
    const task = await createTestTask(project.id, { column: 'backlog' });

    const mockContainerAgent = {
      providerName: 'docker',
      startAgent: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'SANDBOX_ERROR', message: 'Container creation failed', status: 500 },
      }),
      stopAgent: vi.fn().mockResolvedValue(ok(undefined)),
      isAgentRunning: vi.fn().mockReturnValue(false),
      approvePlan: vi.fn().mockResolvedValue(ok(undefined)),
      rejectPlan: vi.fn().mockResolvedValue(ok(undefined)),
    };

    const taskService = new TaskService(db, mockWorktreeService);
    taskService.setContainerAgentService(mockContainerAgent);

    const result = await taskService.moveColumn(task.id, 'in_progress');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.task.column).toBe('backlog');
      expect(result.value.agentError).toBe('Container creation failed');
    }
  });
});
