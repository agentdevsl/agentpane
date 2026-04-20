/**
 * Tests for TaskService plan approval/rejection methods.
 *
 * Covers:
 * - 503 when no container agent service configured
 * - approvePlan propagates actual error codes from containerAgentService
 * - rejectPlan returns Result and threads reason parameter
 * - Distinguishes PLAN_NOT_FOUND vs PLAN_REJECTION_FAILED
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '../../src/lib/utils/result';
import type { ContainerAgentTrigger } from '../../src/services/task.service';
import { TaskService } from '../../src/services/task.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

function createMockTrigger(overrides: Partial<ContainerAgentTrigger> = {}): ContainerAgentTrigger {
  return {
    startAgent: vi.fn().mockResolvedValue(ok(undefined)),
    stopAgent: vi.fn().mockResolvedValue(ok(undefined)),
    isAgentRunning: vi.fn().mockReturnValue(false),
    approvePlan: vi.fn().mockResolvedValue(ok(undefined)),
    rejectPlan: vi.fn().mockResolvedValue(ok(undefined)),
    ...overrides,
  };
}

describe('TaskService plan approval/rejection', () => {
  let taskService: TaskService;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    const mockWorktreeService = {
      getDiff: vi
        .fn()
        .mockResolvedValue(
          ok({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } })
        ),
      merge: vi.fn().mockResolvedValue(ok(undefined)),
      remove: vi.fn().mockResolvedValue(ok(undefined)),
    };
    taskService = new TaskService(db as any, mockWorktreeService);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  describe('approvePlan', () => {
    it('returns 503 when no execution service is configured', async () => {
      const result = await taskService.approvePlan('any-task-id');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NO_EXECUTION_SERVICE');
        expect(result.error.status).toBe(503);
      }
    });

    it('returns ok on successful approval', async () => {
      const trigger = createMockTrigger();
      taskService.setContainerAgentService(trigger);

      const result = await taskService.approvePlan('task-1');
      expect(result.ok).toBe(true);
      expect(trigger.approvePlan).toHaveBeenCalledWith('task-1');
    });

    it('propagates PLAN_NOT_FOUND error from containerAgentService', async () => {
      const trigger = createMockTrigger({
        approvePlan: vi.fn().mockResolvedValue(
          err({
            code: 'SANDBOX_PLAN_NOT_FOUND',
            message: 'No pending plan found for task: task-1',
            status: 404,
          })
        ),
      });
      taskService.setContainerAgentService(trigger);

      const result = await taskService.approvePlan('task-1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
        expect(result.error.status).toBe(404);
      }
    });

    it('propagates AGENT_START_FAILED error from containerAgentService', async () => {
      const trigger = createMockTrigger({
        approvePlan: vi.fn().mockResolvedValue(
          err({
            code: 'SANDBOX_AGENT_START_FAILED',
            message: 'DB update failed: constraint',
            status: 500,
          })
        ),
      });
      taskService.setContainerAgentService(trigger);

      const result = await taskService.approvePlan('task-1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_AGENT_START_FAILED');
        expect(result.error.status).toBe(500);
      }
    });
  });

  describe('rejectPlan', () => {
    it('returns NO_EXECUTION_SERVICE 503 when neither container nor host-mode service is configured', async () => {
      // theme-03 F6: the error code is now NO_EXECUTION_SERVICE (was
      // CONTAINER_AGENT_SERVICE_UNAVAILABLE) because rejectPlan now also
      // supports a host-mode fallback via agentExecutionService.rejectPlanForTask.
      const result = await taskService.rejectPlan('any-task-id');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NO_EXECUTION_SERVICE');
        expect(result.error.status).toBe(503);
      }
    });

    it('returns ok on successful rejection', async () => {
      const trigger = createMockTrigger();
      taskService.setContainerAgentService(trigger);

      const result = await taskService.rejectPlan('task-1');
      expect(result.ok).toBe(true);
      expect(trigger.rejectPlan).toHaveBeenCalledWith('task-1', undefined);
    });

    it('threads reason parameter to containerAgentService', async () => {
      const trigger = createMockTrigger();
      taskService.setContainerAgentService(trigger);

      await taskService.rejectPlan('task-1', 'Plan is too complex');
      expect(trigger.rejectPlan).toHaveBeenCalledWith('task-1', 'Plan is too complex');
    });

    it('propagates PLAN_NOT_FOUND from containerAgentService', async () => {
      const trigger = createMockTrigger({
        rejectPlan: vi
          .fn()
          .mockResolvedValue(
            err({ code: 'SANDBOX_PLAN_NOT_FOUND', message: 'No pending plan found', status: 404 })
          ),
      });
      taskService.setContainerAgentService(trigger);

      const result = await taskService.rejectPlan('task-1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_PLAN_NOT_FOUND');
        expect(result.error.status).toBe(404);
      }
    });

    it('propagates PLAN_REJECTION_FAILED from containerAgentService', async () => {
      const trigger = createMockTrigger({
        rejectPlan: vi
          .fn()
          .mockResolvedValue(
            err({ code: 'SANDBOX_PLAN_REJECTION_FAILED', message: 'DB write failed', status: 500 })
          ),
      });
      taskService.setContainerAgentService(trigger);

      const result = await taskService.rejectPlan('task-1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_PLAN_REJECTION_FAILED');
        expect(result.error.status).toBe(500);
      }
    });
  });
});
