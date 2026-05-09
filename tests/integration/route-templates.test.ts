import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTemplatesRoutes } from '../../src/server/routes/templates';

/**
 * Integration tests for the Templates API routes (createTemplatesRoutes).
 *
 * Covers list/create/get/patch/delete and the manual sync endpoint, plus the
 * shared `validateIdParam` and Zod validation branches.
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

function createMockTemplateService() {
  return {
    list: vi.fn(),
    create: vi.fn(),
    sync: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

describe('Templates Routes (IT-1710)', () => {
  let app: Hono;
  let svc: ReturnType<typeof createMockTemplateService>;

  beforeEach(() => {
    svc = createMockTemplateService();
    app = createTemplatesRoutes({ templateService: svc as never });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('IT-1710-1: GET / returns mapped list with default limit', async () => {
    svc.list.mockResolvedValue(ok([{ id: 't-1', name: 'A' }]));
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.totalCount).toBe(1);
    expect(body.data.hasMore).toBe(false);
    expect(body.data.nextCursor).toBeNull();
    expect(svc.list).toHaveBeenCalledWith({
      scope: undefined,
      codespaceId: undefined,
      limit: 50,
    });
  });

  it('IT-1710-2: GET / passes scope and codespaceId filters', async () => {
    svc.list.mockResolvedValue(ok([]));
    await app.request('http://localhost/?scope=codespace&codespaceId=cs-1&limit=10');
    expect(svc.list).toHaveBeenCalledWith({
      scope: 'codespace',
      codespaceId: 'cs-1',
      limit: 10,
    });
  });

  it('IT-1710-3: GET / surfaces service error', async () => {
    svc.list.mockResolvedValue(err('TEMPLATE_LIST_FAILED', 'fail', 500));
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('TEMPLATE_LIST_FAILED');
  });

  it('IT-1710-4: POST / creates template with codespaceIds array', async () => {
    svc.create.mockResolvedValue(ok({ id: 't-2', name: 'New' }));
    const res = await app.request(
      jsonRequest('http://localhost/', {
        name: 'New',
        scope: 'org',
        githubUrl: 'https://github.com/x/y',
        codespaceIds: ['cs-1', 'cs-2'],
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe('t-2');
    expect(svc.create).toHaveBeenCalledWith(
      expect.objectContaining({ codespaceIds: ['cs-1', 'cs-2'] })
    );
  });

  it('IT-1710-5: POST / falls back to single codespaceId when codespaceIds missing', async () => {
    svc.create.mockResolvedValue(ok({ id: 't-3', name: 'Single' }));
    await app.request(
      jsonRequest('http://localhost/', {
        name: 'Single',
        scope: 'codespace',
        githubUrl: 'https://github.com/x/y',
        codespaceId: 'cs-9',
      })
    );
    expect(svc.create).toHaveBeenCalledWith(expect.objectContaining({ codespaceIds: ['cs-9'] }));
  });

  it('IT-1710-6: POST / leaves codespaceIds undefined when neither provided', async () => {
    svc.create.mockResolvedValue(ok({ id: 't-4', name: 'NoCs' }));
    await app.request(
      jsonRequest('http://localhost/', {
        name: 'NoCs',
        scope: 'org',
        githubUrl: 'https://github.com/x/y',
      })
    );
    expect(svc.create).toHaveBeenCalledWith(expect.objectContaining({ codespaceIds: undefined }));
  });

  it('IT-1710-7: POST / rejects malformed body via schema', async () => {
    const res = await app.request(jsonRequest('http://localhost/', { name: 'x' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-1710-8: POST / surfaces service error', async () => {
    svc.create.mockResolvedValue(err('TEMPLATE_EXISTS', 'duplicate', 409));
    const res = await app.request(
      jsonRequest('http://localhost/', {
        name: 'Dup',
        scope: 'org',
        githubUrl: 'https://github.com/x/y',
      })
    );
    expect(res.status).toBe(409);
  });

  it('IT-1710-9: POST /:id/sync rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id/sync', { method: 'POST' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('IT-1710-10: POST /:id/sync returns synced result', async () => {
    svc.sync.mockResolvedValue(ok({ updated: 5 }));
    const res = await app.request('http://localhost/t-1/sync', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.updated).toBe(5);
  });

  it('IT-1710-11: POST /:id/sync surfaces service error', async () => {
    svc.sync.mockResolvedValue(err('SYNC_FAILED', 'boom', 502));
    const res = await app.request('http://localhost/t-1/sync', { method: 'POST' });
    expect(res.status).toBe(502);
  });

  it('IT-1710-12: GET /:id rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id');
    expect(res.status).toBe(400);
  });

  it('IT-1710-13: GET /:id returns template', async () => {
    svc.getById.mockResolvedValue(ok({ id: 't-1', name: 'A' }));
    const res = await app.request('http://localhost/t-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('A');
  });

  it('IT-1710-14: GET /:id propagates 404 from service', async () => {
    svc.getById.mockResolvedValue(err('TEMPLATE_NOT_FOUND', 'gone', 404));
    const res = await app.request('http://localhost/t-1');
    expect(res.status).toBe(404);
  });

  it('IT-1710-15: PATCH /:id rejects bad ID', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/bad..id', { name: 'x' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(400);
  });

  it('IT-1710-16: PATCH /:id rejects malformed body', async () => {
    const res = await app.request(jsonRequest('http://localhost/t-1', {}, { method: 'PATCH' }));
    expect(res.status).toBe(400);
  });

  it('IT-1710-17: PATCH /:id updates template', async () => {
    svc.update.mockResolvedValue(ok({ id: 't-1', name: 'Updated' }));
    const res = await app.request(
      jsonRequest('http://localhost/t-1', { name: 'Updated' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Updated');
  });

  it('IT-1710-18: PATCH /:id surfaces service error', async () => {
    svc.update.mockResolvedValue(err('TEMPLATE_NOT_FOUND', 'gone', 404));
    const res = await app.request(
      jsonRequest('http://localhost/t-1', { name: 'x' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(404);
  });

  it('IT-1710-19: DELETE /:id rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('IT-1710-20: DELETE /:id succeeds', async () => {
    svc.delete.mockResolvedValue(ok(undefined));
    const res = await app.request('http://localhost/t-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
  });

  it('IT-1710-21: DELETE /:id surfaces service error', async () => {
    svc.delete.mockResolvedValue(err('TEMPLATE_NOT_FOUND', 'gone', 404));
    const res = await app.request('http://localhost/t-1', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
