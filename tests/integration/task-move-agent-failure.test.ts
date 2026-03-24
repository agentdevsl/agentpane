import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessions, settings } from '../../src/db/schema';
import { err, ok } from '../../src/lib/utils/result';
import type { ContainerAgentTrigger } from '../../src/services/task.service';
import { TaskService } from '../../src/services/task.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-024: Task Move to in_progress When Agent Start Fails', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('moves task to in_progress and reports agentError when agent start fails', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();

    await db.insert(settings).values({
      key: 'sandbox.defaults',
      value: JSON.stringify({ enabled: true }),
    });

    const task = await createTestTask(codespace.id, {
      column: 'backlog',
    });

    const mockWorktreeService = {
      getDiff: async () =>
        ok({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } }),
      merge: async () => ok(undefined),
      remove: async () => ok(undefined),
    };

    const mockContainerAgent: ContainerAgentTrigger = {
      providerName: 'docker',
      startAgent: vi.fn().mockResolvedValue(
        err({
          code: 'SANDBOX_START_FAILED',
          message: 'Container crashed',
          status: 500,
        })
      ),
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
      expect(result.value.agentError).toBeDefined();
      expect(result.value.agentError).toContain('Container crashed');
    }

    const sessionRecord = await db.query.sessions.findFirst({
      where: eq(sessions.id, result.ok ? result.value.task.sessionId! : ''),
    });
    expect(sessionRecord).toBeDefined();
    expect(sessionRecord!.codespaceId).toBe(codespace.id);
    expect(sessionRecord!.taskId).toBe(task.id);
  });
});
