/**
 * Tests for task plan approval/rejection API routes.
 *
 * Covers:
 * - POST /api/tasks/:id/approve-plan: 200/400/404/500
 * - POST /api/tasks/:id/reject-plan: 200/400/404, with and without reason body
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '../../src/lib/utils/result';
import { createTasksRoutes } from '../../src/server/routes/tasks';
import type { TaskService } from '../../src/services/task.service';

function createMockTaskService(overrides: Partial<TaskService> = {}): TaskService {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    moveColumn: vi.fn(),
    reorder: vi.fn(),
    getByColumn: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    getDiff: vi.fn(),
    stopAgent: vi.fn(),
    approvePlan: vi.fn().mockResolvedValue(ok(undefined)),
    rejectPlan: vi.fn().mockReturnValue(ok(undefined)),
    setContainerAgentService: vi.fn(),
    setWorktreeService: vi.fn(),
    ...overrides,
  } as unknown as TaskService;
}

describe('Task plan approval API routes', () => {
  let app: Hono;
  let taskService: TaskService;

  beforeEach(() => {
    taskService = createMockTaskService();
    const routes = createTasksRoutes({ taskService, db: {} as never });
    app = new Hono();
    app.route('/api/tasks', routes);
  });

  describe('POST /api/tasks/:id/approve-plan', () => {
    it('returns 200 on successful approval', async () => {
      const res = await app.request('/api/tasks/valid-id-123/approve-plan', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.approved).toBe(true);
    });

    it('returns 400 for invalid ID format', async () => {
      const res = await app.request('/api/tasks/!!!/approve-plan', {
        method: 'POST',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when plan not found', async () => {
      taskService = createMockTaskService({
        approvePlan: vi
          .fn()
          .mockResolvedValue(
            err({ code: 'SANDBOX_PLAN_NOT_FOUND', message: 'No pending plan', status: 404 })
          ),
      });
      const routes = createTasksRoutes({ taskService, db: {} as never });
      app = new Hono();
      app.route('/api/tasks', routes);

      const res = await app.request('/api/tasks/valid-id-123/approve-plan', {
        method: 'POST',
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });

    it('returns 500 on internal error', async () => {
      taskService = createMockTaskService({
        approvePlan: vi
          .fn()
          .mockResolvedValue(
            err({ code: 'SANDBOX_AGENT_START_FAILED', message: 'DB error', status: 500 })
          ),
      });
      const routes = createTasksRoutes({ taskService, db: {} as never });
      app = new Hono();
      app.route('/api/tasks', routes);

      const res = await app.request('/api/tasks/valid-id-123/approve-plan', {
        method: 'POST',
      });
      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/tasks/:id/reject-plan', () => {
    it('returns 200 on successful rejection without reason', async () => {
      const res = await app.request('/api/tasks/valid-id-123/reject-plan', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.rejected).toBe(true);
    });

    it('returns 200 and passes reason when provided', async () => {
      const res = await app.request('/api/tasks/valid-id-123/reject-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Too complex' }),
      });
      expect(res.status).toBe(200);
      expect(taskService.rejectPlan).toHaveBeenCalledWith('valid-id-123', 'Too complex');
    });

    it('returns 400 for invalid ID format', async () => {
      const res = await app.request('/api/tasks/!!!/reject-plan', {
        method: 'POST',
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 when plan not found', async () => {
      taskService = createMockTaskService({
        rejectPlan: vi
          .fn()
          .mockReturnValue(
            err({ code: 'SANDBOX_PLAN_NOT_FOUND', message: 'No pending plan', status: 404 })
          ),
      });
      const routes = createTasksRoutes({ taskService, db: {} as never });
      app = new Hono();
      app.route('/api/tasks', routes);

      const res = await app.request('/api/tasks/valid-id-123/reject-plan', {
        method: 'POST',
      });
      expect(res.status).toBe(404);
    });
  });
});
