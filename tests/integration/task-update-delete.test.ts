import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import { TaskService } from '../../src/services/task.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import { createMockContainerAgent } from '../helpers/mocks';

function createMockWorktreeService() {
  return {
    getDiff: vi.fn(),
    merge: vi.fn(),
    remove: vi.fn(),
  };
}

describe('IT-031–035: Task Update and Delete', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // IT-031: task-update-partial-fields (P0)
  describe('IT-031: task-update-partial-fields', () => {
    it('updates only the specified field and preserves the rest', async () => {
      const codespace = await createTestProject();

      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);

      // Use TaskService.create to set priority (factory ignores priority option)
      const createResult = await taskService.create({
        codespaceId: codespace.id,
        title: 'Original Title',
        description: 'Original Description',
        labels: ['feature', 'v2'],
        priority: 'high',
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;
      const task = createResult.value;

      const result = await taskService.update(task.id, { title: 'New Title' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.title).toBe('New Title');
      expect(result.value.description).toBe('Original Description');
      expect(result.value.labels).toEqual(['feature', 'v2']);
      expect(result.value.priority).toBe('high');
      expect(result.value.updatedAt).not.toBe(task.updatedAt);
    });

    it('returns TASK_NOT_FOUND when updating nonexistent task', async () => {
      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);

      const result = await taskService.update('nonexistent-id', { title: 'New Title' });

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('TASK_NOT_FOUND');
    });
  });

  // IT-032: task-update-idempotency (P1)
  describe('IT-032: task-update-idempotency', () => {
    it('applying the same update twice returns ok with identical field values', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, { title: 'Initial' });

      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);

      const result1 = await taskService.update(task.id, { title: 'Same' });
      const result2 = await taskService.update(task.id, { title: 'Same' });

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) return;

      expect(result1.value.title).toBe('Same');
      expect(result2.value.title).toBe('Same');
      expect(result1.value.description).toBe(result2.value.description);
      expect(result1.value.labels).toEqual(result2.value.labels);
      // updatedAt may differ between the two calls
    });
  });

  // IT-033: task-delete-existing (P0)
  describe('IT-033: task-delete-existing', () => {
    it('deletes a task and confirms it is gone via getById and direct DB query', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, { title: 'Delete Me' });

      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);

      const deleteResult = await taskService.delete(task.id);
      expect(deleteResult.ok).toBe(true);

      // getById should return NOT_FOUND
      const getResult = await taskService.getById(task.id);
      expect(getResult.ok).toBe(false);
      if (!getResult.ok) {
        expect(getResult.error.code).toBe('TASK_NOT_FOUND');
      }

      // Direct DB query: zero rows
      const rows = await db.select().from(tasks).where(eq(tasks.id, task.id));
      expect(rows).toHaveLength(0);
    });

    it('stops an in-memory container agent before deleting an in-progress task', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, {
        title: 'Delete Running Task',
        column: 'in_progress',
      });

      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);
      const containerAgent = createMockContainerAgent({
        isAgentRunning: vi.fn().mockReturnValue(true),
      });
      taskService.setContainerAgentService(containerAgent);

      const deleteResult = await taskService.delete(task.id);

      expect(deleteResult.ok).toBe(true);
      expect(containerAgent.isAgentRunning).toHaveBeenCalledWith(task.id);
      expect(containerAgent.stopAgent).toHaveBeenCalledWith(task.id);

      const rows = await db.select().from(tasks).where(eq(tasks.id, task.id));
      expect(rows).toHaveLength(0);
    });

    it('stops a host-mode agent before deleting an in-progress task', async () => {
      const codespace = await createTestProject();
      const agent = await createTestAgent(codespace.id, { status: 'running' });
      const task = await createTestTask(codespace.id, {
        title: 'Delete Host Task',
        column: 'in_progress',
        agentId: agent.id,
      });

      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);
      const agentExecution = {
        resume: vi.fn(),
        stop: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      };
      taskService.setAgentExecutionService(agentExecution);

      const deleteResult = await taskService.delete(task.id);

      expect(deleteResult.ok).toBe(true);
      expect(agentExecution.stop).toHaveBeenCalledWith(agent.id);

      const rows = await db.select().from(tasks).where(eq(tasks.id, task.id));
      expect(rows).toHaveLength(0);
    });
  });

  // IT-034: task-delete-nonexistent (P1)
  describe('IT-034: task-delete-nonexistent', () => {
    it('returns TASK_NOT_FOUND when deleting a nonexistent task', async () => {
      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);

      const result = await taskService.delete('nonexistent-id');

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('TASK_NOT_FOUND');
    });
  });

  // IT-035: task-update-model-override (P1)
  describe('IT-035: task-update-model-override', () => {
    it('persists modelOverride and can clear it back to null', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, { title: 'Model Override Test' });

      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);

      // Set modelOverride
      const setResult = await taskService.update(task.id, {
        modelOverride: 'claude-opus-4',
      });
      expect(setResult.ok).toBe(true);
      if (!setResult.ok) return;
      expect(setResult.value.modelOverride).toBe('claude-opus-4');

      // Clear modelOverride back to null
      const clearResult = await taskService.update(task.id, {
        modelOverride: null,
      });
      expect(clearResult.ok).toBe(true);
      if (!clearResult.ok) return;
      expect(clearResult.value.modelOverride).toBeNull();
    });
  });

  describe('IT-036: task-cancel-running-agent-cleanup', () => {
    it('stops an in-memory container agent before cancelling an in-progress task', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, {
        title: 'Cancel Running Task',
        column: 'in_progress',
      });

      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);
      const containerAgent = createMockContainerAgent({
        isAgentRunning: vi.fn().mockReturnValue(true),
      });
      taskService.setContainerAgentService(containerAgent);

      const cancelResult = await taskService.cancelTask(task.id);

      expect(cancelResult.ok).toBe(true);
      expect(containerAgent.isAgentRunning).toHaveBeenCalledWith(task.id);
      expect(containerAgent.stopAgent).toHaveBeenCalledWith(task.id);
      if (!cancelResult.ok) return;
      expect(cancelResult.value.column).toBe('backlog');
      expect(cancelResult.value.lastAgentStatus).toBe('cancelled');
    });

    it('stops a host-mode agent before cancelling an in-progress task', async () => {
      const codespace = await createTestProject();
      const agent = await createTestAgent(codespace.id, { status: 'running' });
      const task = await createTestTask(codespace.id, {
        title: 'Cancel Host Task',
        column: 'in_progress',
        agentId: agent.id,
      });

      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);
      const agentExecution = {
        resume: vi.fn(),
        stop: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      };
      taskService.setAgentExecutionService(agentExecution);

      const cancelResult = await taskService.cancelTask(task.id);

      expect(cancelResult.ok).toBe(true);
      expect(agentExecution.stop).toHaveBeenCalledWith(agent.id);
      if (!cancelResult.ok) return;
      expect(cancelResult.value.column).toBe('backlog');
      expect(cancelResult.value.agentId).toBeNull();
      expect(cancelResult.value.lastAgentStatus).toBe('cancelled');
    });

    it('cancels a task while automated agent review is in flight and clears review state', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, {
        title: 'Cancel Agent Reviewing Task',
        column: 'waiting_approval',
        lastAgentStatus: 'agent_reviewing',
        plan: 'Review this plan',
        planOptions: { sdkSessionId: 'sdk-agent-reviewing' },
        agentReviewResult: {
          approved: false,
          concerns: ['still reviewing'],
        },
        agentReviewedAt: new Date().toISOString(),
      });

      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);

      const cancelResult = await taskService.cancelTask(task.id);

      expect(cancelResult.ok).toBe(true);
      if (!cancelResult.ok) return;
      expect(cancelResult.value.column).toBe('backlog');
      expect(cancelResult.value.lastAgentStatus).toBe('cancelled');
      expect(cancelResult.value.plan).toBeNull();
      expect(cancelResult.value.planOptions).toBeNull();
      expect(cancelResult.value.agentReviewResult).toBeNull();
      expect(cancelResult.value.agentReviewedAt).toBeNull();
    });
  });
});
