import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowsRoutes } from '../../src/server/routes/workflows';

/**
 * Integration tests for the Workflow API routes.
 *
 * Covers list/create/get/patch/delete with `parseLimit`/`parseOffset` and
 * status/search query handling, validation errors, and service error mapping.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = (code: string, message: string, status = 400) => ({
  ok: false as const,
  error: { code, message, status },
});

function createMockWorkflowService() {
  return {
    list: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

describe('Workflows Routes (IT-1730)', () => {
  let app: Hono;
  let svc: ReturnType<typeof createMockWorkflowService>;

  beforeEach(() => {
    svc = createMockWorkflowService();
    app = createWorkflowsRoutes({ workflowService: svc as never });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('IT-1730-1: GET / returns list with default pagination', async () => {
    svc.list.mockResolvedValue(ok({ items: [{ id: 'wf-1', name: 'A' }], totalCount: 1 }));
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(svc.list).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      status: undefined,
      search: undefined,
    });
  });

  it('IT-1730-2: GET / passes limit, offset, status, search', async () => {
    svc.list.mockResolvedValue(ok({ items: [], totalCount: 0 }));
    await app.request('http://localhost/?limit=10&offset=20&status=draft&search=foo');
    expect(svc.list).toHaveBeenCalledWith({
      limit: 10,
      offset: 20,
      status: 'draft',
      search: 'foo',
    });
  });

  it('IT-1730-3: GET / surfaces service error', async () => {
    svc.list.mockResolvedValue(err('WORKFLOW_LIST_FAILED', 'fail', 500));
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('WORKFLOW_LIST_FAILED');
  });

  it('IT-1730-4: POST / creates workflow with minimal valid body', async () => {
    svc.create.mockResolvedValue(ok({ id: 'wf-2', name: 'New' }));
    const res = await app.request(jsonRequest('http://localhost/', { name: 'New' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe('wf-2');
    expect(svc.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'New' }));
  });

  it('IT-1730-5: POST / rejects malformed body', async () => {
    const res = await app.request(jsonRequest('http://localhost/', { name: '' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-1730-6: POST / surfaces service error', async () => {
    svc.create.mockResolvedValue(err('WORKFLOW_EXISTS', 'duplicate', 409));
    const res = await app.request(jsonRequest('http://localhost/', { name: 'Dup' }));
    expect(res.status).toBe(409);
  });

  it('IT-1730-7: GET /:id rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id');
    expect(res.status).toBe(400);
  });

  it('IT-1730-8: GET /:id returns workflow', async () => {
    svc.getById.mockResolvedValue(ok({ id: 'wf-1', name: 'A' }));
    const res = await app.request('http://localhost/wf-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('A');
  });

  it('IT-1730-9: GET /:id propagates 404 from service', async () => {
    svc.getById.mockResolvedValue(err('WORKFLOW_NOT_FOUND', 'gone', 404));
    const res = await app.request('http://localhost/wf-1');
    expect(res.status).toBe(404);
  });

  it('IT-1730-10: PATCH /:id rejects bad ID', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/bad..id', { name: 'x' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(400);
  });

  it('IT-1730-11: PATCH /:id rejects empty body (refine)', async () => {
    const res = await app.request(jsonRequest('http://localhost/wf-1', {}, { method: 'PATCH' }));
    expect(res.status).toBe(400);
  });

  it('IT-1730-12: PATCH /:id updates workflow', async () => {
    svc.update.mockResolvedValue(ok({ id: 'wf-1', name: 'Updated' }));
    const res = await app.request(
      jsonRequest('http://localhost/wf-1', { name: 'Updated' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Updated');
  });

  it('IT-1730-13: PATCH /:id surfaces service error', async () => {
    svc.update.mockResolvedValue(err('WORKFLOW_NOT_FOUND', 'gone', 404));
    const res = await app.request(
      jsonRequest('http://localhost/wf-1', { name: 'X' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(404);
  });

  it('IT-1730-14: DELETE /:id rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('IT-1730-15: DELETE /:id succeeds', async () => {
    svc.delete.mockResolvedValue(ok(undefined));
    const res = await app.request('http://localhost/wf-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
  });

  it('IT-1730-16: DELETE /:id surfaces service error', async () => {
    svc.delete.mockResolvedValue(err('WORKFLOW_NOT_FOUND', 'gone', 404));
    const res = await app.request('http://localhost/wf-1', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
