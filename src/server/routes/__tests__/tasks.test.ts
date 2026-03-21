import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createTasksRoutes } from '../tasks.js';

// ── Mock Task Service ──

function createMockTaskService() {
  return {
    list: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getDiff: vi.fn(),
    moveColumn: vi.fn(),
    approvePlan: vi.fn(),
    rejectPlan: vi.fn(),
    stopAgent: vi.fn(),
  };
}

// ── Test App Factory ──

function createTestApp() {
  const taskService = createMockTaskService();
  const routes = createTasksRoutes({ taskService: taskService as never });
  const app = new Hono();
  app.route('/api/tasks', routes);
  return { app, taskService };
}

// ── Request Helper ──

async function request(app: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return app.request(path, init);
}

// ── Tests ──

describe('Tasks API Routes', () => {
  // ── GET /api/tasks ──

  describe('GET /api/tasks', () => {
    it('returns tasks list for a project', async () => {
      const { app, taskService } = createTestApp();
      const mockTasks = [
        { id: 'task-1', title: 'Task 1', column: 'backlog', codespaceId: 'proj-1' },
        { id: 'task-2', title: 'Task 2', column: 'in_progress', codespaceId: 'proj-1' },
      ];
      taskService.list.mockResolvedValue({ ok: true, value: mockTasks });

      const res = await request(app, 'GET', '/api/tasks?codespaceId=proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(2);
      expect(json.data.items[0].id).toBe('task-1');
      expect(taskService.list).toHaveBeenCalledWith('proj-1', {
        column: undefined,
        limit: 50,
        offset: 0,
      });
    });

    it('returns 400 when codespaceId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/tasks');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
    });

    it('returns 400 when codespaceId is invalid', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/tasks?codespaceId=bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('passes column filter to service', async () => {
      const { app, taskService } = createTestApp();
      taskService.list.mockResolvedValue({ ok: true, value: [] });

      await request(app, 'GET', '/api/tasks?codespaceId=proj-1&column=backlog');

      expect(taskService.list).toHaveBeenCalledWith('proj-1', {
        column: 'backlog',
        limit: 50,
        offset: 0,
      });
    });
  });

  // ── POST /api/tasks ──

  describe('POST /api/tasks', () => {
    it('creates a task and returns 201', async () => {
      const { app, taskService } = createTestApp();
      const created = {
        id: 'task-new',
        title: 'New Task',
        codespaceId: 'proj-1',
        column: 'backlog',
      };
      taskService.create.mockResolvedValue({ ok: true, value: created });

      const res = await request(app, 'POST', '/api/tasks', {
        codespaceId: 'proj-1',
        title: 'New Task',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('task-new');
    });

    it('returns 400 when title is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/tasks', {
        codespaceId: 'proj-1',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when codespaceId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/tasks', {
        title: 'Some Task',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── GET /api/tasks/:id ──

  describe('GET /api/tasks/:id', () => {
    it('returns a task by id', async () => {
      const { app, taskService } = createTestApp();
      const task = { id: 'task-1', title: 'Task 1', column: 'backlog' };
      taskService.getById.mockResolvedValue({ ok: true, value: task });

      const res = await request(app, 'GET', '/api/tasks/task-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('task-1');
    });

    it('returns 400 for invalid id format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/tasks/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when task not found', async () => {
      const { app, taskService } = createTestApp();
      taskService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Task not found', status: 404 },
      });

      const res = await request(app, 'GET', '/api/tasks/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ── PUT /api/tasks/:id ──

  describe('PUT /api/tasks/:id', () => {
    it('updates a task', async () => {
      const { app, taskService } = createTestApp();
      const updated = { id: 'task-1', title: 'Updated', column: 'backlog' };
      taskService.update.mockResolvedValue({ ok: true, value: updated });

      const res = await request(app, 'PUT', '/api/tasks/task-1', {
        title: 'Updated',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.title).toBe('Updated');
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PUT', '/api/tasks/bad!id', {
        title: 'Updated',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 when no fields provided', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PUT', '/api/tasks/task-1', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── DELETE /api/tasks/:id ──

  describe('DELETE /api/tasks/:id', () => {
    it('deletes a task', async () => {
      const { app, taskService } = createTestApp();
      taskService.delete.mockResolvedValue({ ok: true, value: null });

      const res = await request(app, 'DELETE', '/api/tasks/task-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toBeNull();
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/tasks/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when task not found', async () => {
      const { app, taskService } = createTestApp();
      taskService.delete.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Task not found', status: 404 },
      });

      const res = await request(app, 'DELETE', '/api/tasks/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ── GET /api/tasks/:id/diff ──

  describe('GET /api/tasks/:id/diff', () => {
    it('returns diff for a task', async () => {
      const { app, taskService } = createTestApp();
      const diff = { files: ['src/foo.ts'], additions: 10, deletions: 3 };
      taskService.getDiff.mockResolvedValue({ ok: true, value: diff });

      const res = await request(app, 'GET', '/api/tasks/task-1/diff');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.additions).toBe(10);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/tasks/bad!id/diff');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });
  });

  // ── PATCH /api/tasks/:id/move ──

  describe('PATCH /api/tasks/:id/move', () => {
    it('moves a task to a new column', async () => {
      const { app, taskService } = createTestApp();
      const movedTask = { id: 'task-1', column: 'in_progress' };
      taskService.moveColumn.mockResolvedValue({
        ok: true,
        value: { task: movedTask, agentError: null },
      });

      const res = await request(app, 'PATCH', '/api/tasks/task-1/move', {
        column: 'in_progress',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.task.column).toBe('in_progress');
    });

    it('returns 400 for invalid column', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/tasks/task-1/move', {
        column: 'invalid_column',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns agent error info when agent start fails', async () => {
      const { app, taskService } = createTestApp();
      const movedTask = { id: 'task-1', column: 'in_progress' };
      taskService.moveColumn.mockResolvedValue({
        ok: true,
        value: { task: movedTask, agentError: 'No idle agents available' },
      });

      const res = await request(app, 'PATCH', '/api/tasks/task-1/move', {
        column: 'in_progress',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.agentError).toBe('No idle agents available');
    });
  });

  // ── POST /api/tasks/:id/approve-plan ──

  describe('POST /api/tasks/:id/approve-plan', () => {
    it('approves a plan', async () => {
      const { app, taskService } = createTestApp();
      taskService.approvePlan.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'POST', '/api/tasks/task-1/approve-plan');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.approved).toBe(true);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/tasks/bad!id/approve-plan');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });
  });

  // ── POST /api/tasks/:id/reject-plan ──

  describe('POST /api/tasks/:id/reject-plan', () => {
    it('rejects a plan', async () => {
      const { app, taskService } = createTestApp();
      taskService.rejectPlan.mockReturnValue({ ok: true, value: true });

      const res = await request(app, 'POST', '/api/tasks/task-1/reject-plan', {
        reason: 'Needs more detail',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.rejected).toBe(true);
    });

    it('rejects a plan without a reason', async () => {
      const { app, taskService } = createTestApp();
      taskService.rejectPlan.mockReturnValue({ ok: true, value: true });

      const res = await request(app, 'POST', '/api/tasks/task-1/reject-plan');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
    });
  });

  // ── POST /api/tasks/:id/stop-agent ──

  describe('POST /api/tasks/:id/stop-agent', () => {
    it('stops an agent for a task', async () => {
      const { app, taskService } = createTestApp();
      taskService.stopAgent.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'POST', '/api/tasks/task-1/stop-agent');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.stopped).toBe(true);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/tasks/bad!id/stop-agent');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });
  });
});
