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
    approve: vi.fn(),
    reject: vi.fn(),
    cancelTask: vi.fn(),
  };
}

describe('Tasks Routes (IT-1350)', () => {
  let app: Hono;
  let mockService: ReturnType<typeof createMockTaskService>;

  beforeEach(() => {
    mockService = createMockTaskService();
    app = createTasksRoutes({
      taskService: mockService as any,
      db: {} as never,
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
    // F07-01: cursor envelope returns {items, nextCursor, hasMore} without
    // a synthesized totalCount that was just the page size.
    expect(body.data.hasMore).toBe(false);
    expect(body.data.nextCursor).toBeNull();
    expect(mockService.list).toHaveBeenCalledWith('cs-1', {
      column: undefined,
      limit: 51,
      orderBy: 'position',
      orderDirection: 'asc',
    });
  });

  it('IT-1351: GET / filters by column', async () => {
    mockService.list.mockResolvedValue({ ok: true, value: [] });

    await app.request('http://localhost/?codespaceId=cs-1&column=in_progress');

    // F07-01: cursor-paginated route fetches limit+1 and fixes the sort.
    expect(mockService.list).toHaveBeenCalledWith('cs-1', {
      column: 'in_progress',
      limit: 51,
      orderBy: 'position',
      orderDirection: 'asc',
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

  it('IT-1368: PATCH /:id/move returns ok:false with AGENT_START_FAILED on partial failure', async () => {
    // arch29-W2-H / F07-06: when the move succeeds but agent auto-start
    // fails, the route MUST return `ok:false` with
    // `error.code === 'AGENT_START_FAILED'` (HTTP 500). The previous
    // shape (`ok:true` with embedded `agentError`) hid the failure from
    // any client that keys on `result.ok`. The service has already
    // reverted the column to `backlog` by this point.
    mockService.moveColumn.mockResolvedValue({
      ok: true,
      value: {
        task: { id: 'task-1', column: 'backlog' },
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

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('AGENT_START_FAILED');
    expect(body.error.message).toBe('Failed to start agent: no sandbox configured');
    expect(body.error.details.task.column).toBe('backlog');
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

  // ─── POST /:id/approve ────────────────────────────────

  it('IT-1382: POST /:id/approve rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id/approve', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('IT-1383: POST /:id/approve works without body (no Content-Type)', async () => {
    mockService.approve.mockResolvedValue({
      ok: true,
      value: { task: { id: 'task-1', column: 'verified' } },
    });
    const res = await app.request('http://localhost/task-1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(mockService.approve).toHaveBeenCalledWith('task-1', {
      approvedBy: undefined,
      createMergeCommit: undefined,
    });
  });

  it('IT-1384: POST /:id/approve parses body fields', async () => {
    mockService.approve.mockResolvedValue({
      ok: true,
      value: { task: { id: 'task-1', column: 'verified' } },
    });
    const res = await app.request(
      jsonRequest('http://localhost/task-1/approve', {
        approvedBy: 'reviewer',
        createMergeCommit: true,
      })
    );
    expect(res.status).toBe(200);
    expect(mockService.approve).toHaveBeenCalledWith('task-1', {
      approvedBy: 'reviewer',
      createMergeCommit: true,
    });
  });

  it('IT-1385: POST /:id/approve rejects malformed body', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/task-1/approve', { approvedBy: 'x'.repeat(300) })
    );
    expect(res.status).toBe(400);
  });

  it('IT-1386: POST /:id/approve surfaces service error', async () => {
    mockService.approve.mockResolvedValue({
      ok: false,
      error: { code: 'TASK_INVALID_TRANSITION', message: 'wrong column', status: 409 },
    });
    const res = await app.request('http://localhost/task-1/approve', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('IT-1387: POST /:id/approve maps thrown error to DB_ERROR', async () => {
    mockService.approve.mockRejectedValue(new Error('db crashed'));
    const res = await app.request('http://localhost/task-1/approve', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('DB_ERROR');
  });

  // ─── POST /:id/reject ─────────────────────────────────

  it('IT-1388: POST /:id/reject rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id/reject', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('IT-1389: POST /:id/reject returns 400 when no Content-Type/body', async () => {
    const res = await app.request('http://localhost/task-1/reject', { method: 'POST' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('reason');
  });

  it('IT-1390: POST /:id/reject rejects empty/whitespace reason', async () => {
    const res = await app.request(jsonRequest('http://localhost/task-1/reject', { reason: '   ' }));
    expect(res.status).toBe(400);
  });

  it('IT-1391: POST /:id/reject rejects task and returns updated task', async () => {
    mockService.reject.mockResolvedValue({
      ok: true,
      value: { task: { id: 'task-1', column: 'backlog' } },
    });
    const res = await app.request(
      jsonRequest('http://localhost/task-1/reject', { reason: 'needs more work' })
    );
    expect(res.status).toBe(200);
    expect(mockService.reject).toHaveBeenCalledWith('task-1', { reason: 'needs more work' });
  });

  it('IT-1392: POST /:id/reject surfaces service error', async () => {
    mockService.reject.mockResolvedValue({
      ok: false,
      error: { code: 'TASK_INVALID_TRANSITION', message: 'wrong column', status: 409 },
    });
    const res = await app.request(jsonRequest('http://localhost/task-1/reject', { reason: 'no' }));
    expect(res.status).toBe(409);
  });

  it('IT-1393: POST /:id/reject maps thrown error to DB_ERROR', async () => {
    mockService.reject.mockRejectedValue(new Error('db crashed'));
    const res = await app.request(jsonRequest('http://localhost/task-1/reject', { reason: 'no' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('DB_ERROR');
  });

  // ─── POST /:id/cancel ─────────────────────────────────

  it('IT-1394: POST /:id/cancel rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id/cancel', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('IT-1395: POST /:id/cancel succeeds', async () => {
    mockService.cancelTask.mockResolvedValue({
      ok: true,
      value: { task: { id: 'task-1', column: 'backlog' } },
    });
    const res = await app.request('http://localhost/task-1/cancel', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('IT-1396: POST /:id/cancel surfaces service error', async () => {
    mockService.cancelTask.mockResolvedValue({
      ok: false,
      error: { code: 'CANCEL_FAILED', message: 'fail', status: 500 },
    });
    const res = await app.request('http://localhost/task-1/cancel', { method: 'POST' });
    expect(res.status).toBe(500);
  });

  // ─── POST /:id/reject-plan with malformed JSON body ──

  it('IT-1397: POST /:id/reject-plan rejects malformed JSON body', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/task-1/reject-plan', { reason: 'x'.repeat(20000) })
    );
    expect(res.status).toBe(400);
  });

  it('IT-1398: POST /:id/reject-plan rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id/reject-plan', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('IT-1399: POST /:id/reject-plan maps thrown error to DB_ERROR', async () => {
    mockService.rejectPlan.mockRejectedValue(new Error('db crashed'));
    const res = await app.request('http://localhost/task-1/reject-plan', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('DB_ERROR');
  });
});
