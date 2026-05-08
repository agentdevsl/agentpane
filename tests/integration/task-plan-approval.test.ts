import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentExecutionTrigger, ContainerAgentTrigger } from '../../src/services/task.service';
import { TaskService } from '../../src/services/task.service';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestWorktree } from '../factories/worktree.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

function createMockWorktreeService() {
  return {
    getDiff: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        files: [{ path: 'src/index.ts', additions: 10, deletions: 2 }],
        stats: { filesChanged: 1, additions: 10, deletions: 2 },
      },
    }),
    merge: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    remove: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

function createMockContainerAgent(): ContainerAgentTrigger {
  return {
    providerName: 'docker',
    startAgent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    stopAgent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    isAgentRunning: vi.fn().mockReturnValue(false),
    approvePlan: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    rejectPlan: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

function createMockAgentExecution(
  overrides: Partial<AgentExecutionTrigger> = {}
): AgentExecutionTrigger {
  return {
    resume: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    rejectPlanForTask: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    ...overrides,
  };
}

describe('IT-041–045: Task Plan Approval and Rejection', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // IT-041: task-approve-plan-container-mode (P0)
  describe('IT-041: task-approve-plan-container-mode', () => {
    it('delegates approvePlan to containerAgentService when set', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, { column: 'in_progress' });

      const worktreeService = createMockWorktreeService();
      const containerAgent = createMockContainerAgent();
      const taskService = new TaskService(db as any, worktreeService);
      taskService.setContainerAgentService(containerAgent);

      const result = await taskService.approvePlan(task.id);

      expect(result.ok).toBe(true);
      expect(containerAgent.approvePlan).toHaveBeenCalledWith(task.id);
    });
  });

  // IT-042: task-approve-plan-host-fallback (P0)
  describe('IT-042: task-approve-plan-host-fallback', () => {
    it('falls back to agentExecutionService.resume when no containerAgentService is set', async () => {
      const codespace = await createTestProject();
      const agent = await createTestAgent(codespace.id, { status: 'planning' });
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
        agentId: agent.id,
        plan: 'Host-mode plan',
        lastAgentStatus: 'planning',
      });

      const worktreeService = createMockWorktreeService();
      const agentExecution = createMockAgentExecution();
      const taskService = new TaskService(db as any, worktreeService);
      // Do NOT set containerAgentService
      taskService.setAgentExecutionService(agentExecution);

      const result = await taskService.approvePlan(task.id);

      expect(result.ok).toBe(true);
      expect(agentExecution.resume).toHaveBeenCalledWith(agent.id);
    });

    it('rejects host-mode approve when no pending plan is stored', async () => {
      const codespace = await createTestProject();
      const agent = await createTestAgent(codespace.id, { status: 'planning' });
      const task = await createTestTask(codespace.id, {
        column: 'in_progress',
        agentId: agent.id,
      });

      const worktreeService = createMockWorktreeService();
      const agentExecution = createMockAgentExecution();
      const taskService = new TaskService(db as any, worktreeService);
      taskService.setAgentExecutionService(agentExecution);

      const result = await taskService.approvePlan(task.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('PLAN_NOT_FOUND');
      expect(agentExecution.resume).not.toHaveBeenCalled();
    });
  });

  // IT-043: task-approve-plan-no-service (P0)
  describe('IT-043: task-approve-plan-no-service', () => {
    it('returns NO_EXECUTION_SERVICE error when neither service is set', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, { column: 'in_progress' });

      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);
      // Neither containerAgentService nor agentExecutionService set

      const result = await taskService.approvePlan(task.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('NO_EXECUTION_SERVICE');
      expect(result.error.status).toBe(503);
    });
  });

  // IT-044: task-reject-plan-delegation (P1)
  describe('IT-044: task-reject-plan-delegation', () => {
    it('delegates rejectPlan to containerAgentService when set', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, { column: 'in_progress' });

      const worktreeService = createMockWorktreeService();
      const containerAgent = createMockContainerAgent();
      const taskService = new TaskService(db as any, worktreeService);
      taskService.setContainerAgentService(containerAgent);

      const result = await taskService.rejectPlan(task.id, 'bad plan');

      expect(result.ok).toBe(true);
      expect(containerAgent.rejectPlan).toHaveBeenCalledWith(task.id, 'bad plan');
    });

    // theme-03 F6: host-mode fallback for rejectPlan.
    it('F6-a: falls back to agentExecutionService.rejectPlanForTask when container service is not set', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, { column: 'in_progress' });

      const worktreeService = createMockWorktreeService();
      const agentExecution = createMockAgentExecution();
      const taskService = new TaskService(db as any, worktreeService);
      // Do NOT set containerAgentService; set host-mode fallback only
      taskService.setAgentExecutionService(agentExecution);

      const result = await taskService.rejectPlan(task.id, 'stale plan');

      expect(result.ok).toBe(true);
      expect(agentExecution.rejectPlanForTask).toHaveBeenCalledWith(task.id, 'stale plan');
    });

    it('F6-b: returns NO_EXECUTION_SERVICE when neither service is set', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, { column: 'in_progress' });

      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);
      // Neither containerAgentService nor agentExecutionService set

      const result = await taskService.rejectPlan(task.id, 'bad plan');

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('NO_EXECUTION_SERVICE');
      expect(result.error.status).toBe(503);
    });

    it('F6-c: propagates host-mode rejectPlanForTask errors to caller', async () => {
      const codespace = await createTestProject();
      const task = await createTestTask(codespace.id, { column: 'in_progress' });

      const worktreeService = createMockWorktreeService();
      const agentExecution = createMockAgentExecution({
        rejectPlanForTask: vi.fn().mockResolvedValue({
          ok: false,
          error: {
            code: 'PLAN_NOT_FOUND',
            message: 'No pending plan for task',
            status: 404,
          },
        }),
      });
      const taskService = new TaskService(db as any, worktreeService);
      taskService.setAgentExecutionService(agentExecution);

      const result = await taskService.rejectPlan(task.id, 'mistake');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('PLAN_NOT_FOUND');
      expect(result.error.status).toBe(404);
    });
  });

  // IT-045: task-approve-skip-merge (P0)
  describe('IT-045: task-approve-skip-merge', () => {
    it('skips merge when createMergeCommit is false but still moves to verified with diffSummary', async () => {
      const codespace = await createTestProject();
      const worktree = await createTestWorktree(codespace.id);
      const task = await createTestTask(codespace.id, {
        column: 'waiting_approval',
        worktreeId: worktree.id,
        branch: worktree.branch,
      });

      const worktreeService = createMockWorktreeService();
      const taskService = new TaskService(db as any, worktreeService);

      const result = await taskService.approve(task.id, { createMergeCommit: false });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.column).toBe('verified');
      expect(result.value.approvedAt).toBeTruthy();
      expect(result.value.completedAt).toBeTruthy();
      expect(result.value.diffSummary).toEqual({
        filesChanged: 1,
        additions: 10,
        deletions: 2,
      });

      // merge should NOT have been called
      expect(worktreeService.merge).not.toHaveBeenCalled();

      // getDiff should still have been called (to get the diff summary)
      expect(worktreeService.getDiff).toHaveBeenCalledWith(worktree.id);

      // remove should still be called (cleanup)
      expect(worktreeService.remove).toHaveBeenCalledWith(worktree.id);
    });
  });
});
