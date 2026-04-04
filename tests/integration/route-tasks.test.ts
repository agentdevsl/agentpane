import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTasksRoutes } from '../../src/server/routes/tasks';

/**
 * Integration tests for tasks API routes.
 *
 * Tests CRUD, list with column filter, move (with auto-agent-start and
 * partial failure), plan approval/rejection, stop agent, and column
 * validation.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

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

describe('Tasks Routes (IT-1350)', () => {
  let app: Hono;
  let mockService: ReturnType<typeof createMockTaskService>;

  beforeEach(() => {
    mockService = createMockTaskService();
    app = createTasksRoutes({
      taskService: mockService as any,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET / (list) ─────────────────────────────────────

  it('IT-1350: GET / lists tasks for a codespace', async () => {
    mockService.list.mockResolvedValue({
      ok: true,
      value: [
        { id: 'task-1', title: 'Task One', column: 'backlog' },
        { id: 'task-2', title: 'Task Two', column: 'in_progress' },
      ],
    });

    const res = await app.request('http://localhost/?codespaceId=cs-1');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.totalCount).toBe(2);
    expect(mockService.list).toHaveBeenCalledWith('cs-1', {
      column: undefined,
      limit: 50,
      offset: 0,
    });
  });

  it('IT-1351: GET / filters by column', async () => {
    mockService.list.mockResolvedValue({ ok: true, value: [] });

    await app.request('http://localhost/?codespaceId=cs-1&column=in_progress');

    expect(mockService.list).toHaveBeenCalledWith('cs-1', {
      column: 'in_progress',
      limit: 50,
      offset: 0,
    });
  });

  it('IT-1352: GET / returns 400 for invalid column value', async () => {
    const res = await app.request('http://localhost/?codespaceId=cs-1&column=invalid_column');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_PARAMS');
    expect(body.error.message).toContain('invalid_column');
    expect(body.error.message).toContain('backlog');
  });

  it('IT-1353: GET / returns 400 when codespaceId is missing', async () => {
    const res = await app.request('http://localhost/');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MISSING_PARAMS');
  });

  // ─── POST / (create) ──────────────────────────────────

  it('IT-1354: POST / creates a task', async () => {
    mockService.create.mockResolvedValue({
      ok: true,
      value: {
        id: 'task-new',
        title: 'New Task',
        codespaceId: 'cs-1',
        column: 'backlog',
      },
    });

    const res = await app.request(
      jsonRequest('http://localhost/', {
        codespaceId: 'cs-1',
        title: 'New Task',
        description: 'A description',
        labels: ['bug'],
        priority: 'high',
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('task-new');
    expect(mockService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        codespaceId: 'cs-1',
        title: 'New Task',
        labels: ['bug'],
        priority: 'high',
      })
    );
  });

  it('IT-1355: POST / creates a task with skillId and skillName', async () => {
    mockService.create.mockResolvedValue({
      ok: true,
      value: { id: 'task-skill', title: 'Skilled Task' },
    });

    const res = await app.request(
      jsonRequest('http://localhost/', {
        codespaceId: 'cs-1',
        title: 'Skilled Task',
        skillId: 'deploy-prod',
        skillName: 'Production Deploy',
      })
    );

    expect(res.status).toBe(201);
    expect(mockService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: 'deploy-prod',
        skillName: 'Production Deploy',
      })
    );
  });

  it('IT-1356: POST / returns 400 for missing title', async () => {
    const res = await app.request(jsonRequest('http://localhost/', { codespaceId: 'cs-1' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1357: POST / returns 400 for invalid JSON', async () => {
    const res = await app.request(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      })
    );

    expect(res.status).toBe(400);
  });

  // ─── GET /:id ─────────────────────────────────────────

  it('IT-1358: GET /:id returns a task', async () => {
    mockService.getById.mockResolvedValue({
      ok: true,
      value: { id: 'task-1', title: 'Found', column: 'backlog' },
    });

    const res = await app.request('http://localhost/task-1');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.title).toBe('Found');
  });

  it('IT-1359: GET /:id returns error for unknown task', async () => {
    mockService.getById.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Task not found', status: 404 },
    });

    const res = await app.request('http://localhost/task-missing');

    expect(res.status).toBe(404);
  });

  it('IT-1360: GET /:id returns 400 for invalid ID', async () => {
    const res = await app.request('http://localhost/bad!id');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });

  // ─── PUT /:id (update) ────────────────────────────────

  it('IT-1361: PUT /:id updates a task', async () => {
    mockService.update.mockResolvedValue({
      ok: true,
      value: { id: 'task-1', title: 'Updated', priority: 'low' },
    });

    const res = await app.request(
      new Request('http://localhost/task-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated', priority: 'low' }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.title).toBe('Updated');
  });

  it('IT-1362: PUT /:id returns 400 when no fields provided', async () => {
    const res = await app.request(
      new Request('http://localhost/task-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  // ─── DELETE /:id ──────────────────────────────────────

  it('IT-1363: DELETE /:id deletes a task', async () => {
    mockService.delete.mockResolvedValue({ ok: true, value: null });

    const res = await app.request('http://localhost/task-1', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toBeNull();
  });

  it('IT-1364: DELETE /:id returns error when task not found', async () => {
    mockService.delete.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found', status: 404 },
    });

    const res = await app.request('http://localhost/task-gone', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
  });

  // ─── GET /:id/diff ────────────────────────────────────

  it('IT-1365: GET /:id/diff returns diff data', async () => {
    mockService.getDiff.mockResolvedValue({
      ok: true,
      value: { diff: '+added line\n-removed line', filesChanged: 2 },
    });

    const res = await app.request('http://localhost/task-1/diff');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.diff).toContain('+added line');
  });

  it('IT-1366: GET /:id/diff returns error when no diff available', async () => {
    mockService.getDiff.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'No diff', status: 404 },
    });

    const res = await app.request('http://localhost/task-1/diff');

    expect(res.status).toBe(404);
  });

  // ─── PATCH /:id/move ──────────────────────────────────

  it('IT-1367: PATCH /:id/move moves task to new column', async () => {
    mockService.moveColumn.mockResolvedValue({
      ok: true,
      value: {
        task: { id: 'task-1', column: 'in_progress' },
        agentError: undefined,
      },
    });

    const res = await app.request(
      new Request('http://localhost/task-1/move', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column: 'in_progress' }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.task.column).toBe('in_progress');
    expect(body.data.agentError).toBeUndefined();
  });

  it('IT-1368: PATCH /:id/move returns task with agentError on partial failure', async () => {
    mockService.moveColumn.mockResolvedValue({
      ok: true,
      value: {
        task: { id: 'task-1', column: 'in_progress' },
        agentError: 'Failed to start agent: no sandbox configured',
      },
    });

    const res = await app.request(
      new Request('http://localhost/task-1/move', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column: 'in_progress' }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.agentError).toBe('Failed to start agent: no sandbox configured');
  });

  it('IT-1369: PATCH /:id/move returns 400 for invalid column', async () => {
    const res = await app.request(
      new Request('http://localhost/task-1/move', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column: 'nonexistent' }),
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1370: PATCH /:id/move supports optional position', async () => {
    mockService.moveColumn.mockResolvedValue({
      ok: true,
      value: { task: { id: 'task-1', column: 'backlog', position: 3 } },
    });

    const res = await app.request(
      new Request('http://localhost/task-1/move', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column: 'backlog', position: 3 }),
      })
    );

    expect(res.status).toBe(200);
    expect(mockService.moveColumn).toHaveBeenCalledWith('task-1', 'backlog', 3);
  });

  it('IT-1371: PATCH /:id/move returns service error', async () => {
    mockService.moveColumn.mockResolvedValue({
      ok: false,
      error: {
        code: 'INVALID_TRANSITION',
        message: 'Cannot move from verified',
        status: 400,
      },
    });

    const res = await app.request(
      new Request('http://localhost/task-1/move', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column: 'in_progress' }),
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.message).toContain('Cannot move from verified');
  });

  // ─── POST /:id/approve-plan ───────────────────────────

  it('IT-1372: POST /:id/approve-plan approves a plan', async () => {
    mockService.approvePlan.mockResolvedValue({ ok: true, value: null });

    const res = await app.request('http://localhost/task-1/approve-plan', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.approved).toBe(true);
    expect(mockService.approvePlan).toHaveBeenCalledWith('task-1');
  });

  it('IT-1373: POST /:id/approve-plan returns error when no plan pending', async () => {
    mockService.approvePlan.mockResolvedValue({
      ok: false,
      error: {
        code: 'NO_PLAN',
        message: 'No plan pending approval',
        status: 400,
      },
    });

    const res = await app.request('http://localhost/task-1/approve-plan', {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1374: POST /:id/approve-plan returns 400 for invalid task ID', async () => {
    const res = await app.request('http://localhost/bad!id/approve-plan', {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });

  // ─── POST /:id/reject-plan ────────────────────────────

  it('IT-1375: POST /:id/reject-plan rejects a plan', async () => {
    mockService.rejectPlan.mockResolvedValue({ ok: true, value: null });

    const res = await app.request(
      jsonRequest(
        'http://localhost/task-1/reject-plan',
        { reason: 'Needs better approach' },
        { method: 'POST' }
      )
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.rejected).toBe(true);
    expect(mockService.rejectPlan).toHaveBeenCalledWith('task-1', 'Needs better approach');
  });

  it('IT-1376: POST /:id/reject-plan works without reason', async () => {
    mockService.rejectPlan.mockResolvedValue({ ok: true, value: null });

    const res = await app.request('http://localhost/task-1/reject-plan', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.rejected).toBe(true);
    expect(mockService.rejectPlan).toHaveBeenCalledWith('task-1', undefined);
  });

  it('IT-1377: POST /:id/reject-plan returns error on service failure', async () => {
    mockService.rejectPlan.mockResolvedValue({
      ok: false,
      error: { code: 'NO_PLAN', message: 'No plan', status: 400 },
    });

    const res = await app.request('http://localhost/task-1/reject-plan', {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  // ─── POST /:id/stop-agent ─────────────────────────────

  it('IT-1378: POST /:id/stop-agent stops a running agent', async () => {
    mockService.stopAgent.mockResolvedValue({ ok: true, value: null });

    const res = await app.request('http://localhost/task-1/stop-agent', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.stopped).toBe(true);
    expect(mockService.stopAgent).toHaveBeenCalledWith('task-1');
  });

  it('IT-1379: POST /:id/stop-agent returns error when no agent running', async () => {
    mockService.stopAgent.mockResolvedValue({
      ok: false,
      error: {
        code: 'NO_AGENT',
        message: 'No agent running for this task',
        status: 400,
      },
    });

    const res = await app.request('http://localhost/task-1/stop-agent', {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1380: POST /:id/stop-agent returns 400 for invalid ID', async () => {
    const res = await app.request('http://localhost/bad!id/stop-agent', {
      method: 'POST',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });

  // ─── Column validation lists valid values ─────────────

  it('IT-1381: GET / column validation error lists all valid columns', async () => {
    const res = await app.request('http://localhost/?codespaceId=cs-1&column=todo');

    expect(res.status).toBe(400);
    const body = await res.json();
    const validColumns = ['backlog', 'queued', 'in_progress', 'waiting_approval', 'verified'];
    for (const col of validColumns) {
      expect(body.error.message).toContain(col);
    }
  });
});
