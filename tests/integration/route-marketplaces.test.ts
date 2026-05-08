import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMarketplacesRoutes } from '../../src/server/routes/marketplaces';

/**
 * Integration tests for the Marketplace API routes.
 *
 * Covers list/create/get/delete plus seed, plugin search, categories, and the
 * sync endpoint, exercising the schema branches and `errorResponse` mapping.
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

function createMockMarketplaceService() {
  return {
    list: vi.fn(),
    create: vi.fn(),
    seedDefaultMarketplace: vi.fn(),
    listAllPlugins: vi.fn(),
    getCategories: vi.fn(),
    sync: vi.fn(),
    getById: vi.fn(),
    delete: vi.fn(),
  };
}

describe('Marketplaces Routes (IT-1720)', () => {
  let app: Hono;
  let svc: ReturnType<typeof createMockMarketplaceService>;

  beforeEach(() => {
    svc = createMockMarketplaceService();
    app = createMarketplacesRoutes({ marketplaceService: svc as never });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('IT-1720-1: GET / returns mapped list with default limit and includeDisabled=false', async () => {
    svc.list.mockResolvedValue(
      ok([
        {
          id: 'm-1',
          name: 'Default',
          githubOwner: 'agentpane',
          githubRepo: 'mp',
          branch: 'main',
          pluginsPath: 'plugins',
          isDefault: true,
          isEnabled: true,
          status: 'ready',
          lastSyncedAt: '2026-01-01',
          syncError: null,
          cachedPlugins: [{ id: 'p-1' }, { id: 'p-2' }],
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ])
    );
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items[0].pluginCount).toBe(2);
    expect(svc.list).toHaveBeenCalledWith({ limit: 20, includeDisabled: false });
  });

  it('IT-1720-2: GET / passes includeDisabled=true', async () => {
    svc.list.mockResolvedValue(ok([]));
    await app.request('http://localhost/?includeDisabled=true&limit=5');
    expect(svc.list).toHaveBeenCalledWith({ limit: 5, includeDisabled: true });
  });

  it('IT-1720-3: GET / handles cachedPlugins missing (default zero count)', async () => {
    svc.list.mockResolvedValue(
      ok([
        {
          id: 'm-2',
          name: 'B',
          githubOwner: 'x',
          githubRepo: 'y',
          branch: 'main',
          pluginsPath: '',
          isDefault: false,
          isEnabled: false,
          status: 'pending',
          lastSyncedAt: null,
          syncError: null,
          cachedPlugins: undefined,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ])
    );
    const res = await app.request('http://localhost/');
    const body = await res.json();
    expect(body.data.items[0].pluginCount).toBe(0);
  });

  it('IT-1720-4: GET / surfaces service error', async () => {
    svc.list.mockResolvedValue(err('MARKETPLACE_LIST_FAILED', 'fail', 500));
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(500);
  });

  it('IT-1720-5: POST / requires owner+repo or githubUrl', async () => {
    const res = await app.request(jsonRequest('http://localhost/', { name: 'm' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-1720-6: POST / accepts owner/repo and creates marketplace', async () => {
    svc.create.mockResolvedValue(ok({ id: 'm-3', name: 'New' }));
    const res = await app.request(
      jsonRequest('http://localhost/', {
        name: 'New',
        githubOwner: 'x',
        githubRepo: 'y',
      })
    );
    expect(res.status).toBe(201);
    expect(svc.create).toHaveBeenCalledWith(
      expect.objectContaining({ githubOwner: 'x', githubRepo: 'y' })
    );
  });

  it('IT-1720-7: POST / accepts githubUrl alone', async () => {
    svc.create.mockResolvedValue(ok({ id: 'm-4', name: 'URL' }));
    const res = await app.request(
      jsonRequest('http://localhost/', {
        name: 'URL',
        githubUrl: 'https://github.com/x/y',
      })
    );
    expect(res.status).toBe(201);
  });

  it('IT-1720-8: POST / surfaces service error', async () => {
    svc.create.mockResolvedValue(err('MARKETPLACE_EXISTS', 'duplicate', 409));
    const res = await app.request(
      jsonRequest('http://localhost/', {
        name: 'Dup',
        githubOwner: 'x',
        githubRepo: 'y',
      })
    );
    expect(res.status).toBe(409);
  });

  it('IT-1720-9: POST /seed returns seeded=true when seed creates a marketplace', async () => {
    svc.seedDefaultMarketplace.mockResolvedValue(ok({ id: 'm-default' }));
    const res = await app.request('http://localhost/seed', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.seeded).toBe(true);
  });

  it('IT-1720-10: POST /seed returns seeded=false when seed already exists', async () => {
    svc.seedDefaultMarketplace.mockResolvedValue(ok(null));
    const res = await app.request('http://localhost/seed', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.seeded).toBe(false);
  });

  it('IT-1720-11: POST /seed surfaces service error', async () => {
    svc.seedDefaultMarketplace.mockResolvedValue(err('SEED_FAILED', 'fail', 500));
    const res = await app.request('http://localhost/seed', { method: 'POST' });
    expect(res.status).toBe(500);
  });

  it('IT-1720-12: GET /plugins passes filters', async () => {
    svc.listAllPlugins.mockResolvedValue(ok([{ id: 'p-1' }]));
    const res = await app.request(
      'http://localhost/plugins?search=foo&category=lint&marketplaceId=m-1'
    );
    expect(res.status).toBe(200);
    expect(svc.listAllPlugins).toHaveBeenCalledWith({
      search: 'foo',
      category: 'lint',
      marketplaceId: 'm-1',
    });
  });

  it('IT-1720-13: GET /plugins surfaces service error', async () => {
    svc.listAllPlugins.mockResolvedValue(err('PLUGIN_LIST_FAILED', 'fail', 500));
    const res = await app.request('http://localhost/plugins');
    expect(res.status).toBe(500);
  });

  it('IT-1720-14: GET /categories returns categories', async () => {
    svc.getCategories.mockResolvedValue(ok(['lint', 'security']));
    const res = await app.request('http://localhost/categories');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.categories).toEqual(['lint', 'security']);
  });

  it('IT-1720-15: GET /categories surfaces service error', async () => {
    svc.getCategories.mockResolvedValue(err('CATEGORIES_FAILED', 'fail', 500));
    const res = await app.request('http://localhost/categories');
    expect(res.status).toBe(500);
  });

  it('IT-1720-16: POST /:id/sync rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id/sync', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('IT-1720-17: POST /:id/sync returns sync result', async () => {
    svc.sync.mockResolvedValue(ok({ pluginCount: 12 }));
    const res = await app.request('http://localhost/m-1/sync', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.pluginCount).toBe(12);
  });

  it('IT-1720-18: POST /:id/sync surfaces service error', async () => {
    svc.sync.mockResolvedValue(err('SYNC_FAILED', 'boom', 502));
    const res = await app.request('http://localhost/m-1/sync', { method: 'POST' });
    expect(res.status).toBe(502);
  });

  it('IT-1720-19: GET /:id rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id');
    expect(res.status).toBe(400);
  });

  it('IT-1720-20: GET /:id returns marketplace detail with plugins', async () => {
    svc.getById.mockResolvedValue(
      ok({
        id: 'm-1',
        name: 'Default',
        githubOwner: 'agentpane',
        githubRepo: 'mp',
        branch: 'main',
        pluginsPath: 'plugins',
        isDefault: true,
        isEnabled: true,
        status: 'ready',
        lastSyncedAt: '2026-01-01',
        syncError: null,
        cachedPlugins: [{ id: 'p-1' }],
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      })
    );
    const res = await app.request('http://localhost/m-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.plugins).toEqual([{ id: 'p-1' }]);
  });

  it('IT-1720-21: GET /:id falls back to empty plugins array when cachedPlugins missing', async () => {
    svc.getById.mockResolvedValue(
      ok({
        id: 'm-2',
        name: 'B',
        githubOwner: 'x',
        githubRepo: 'y',
        branch: 'main',
        pluginsPath: '',
        isDefault: false,
        isEnabled: false,
        status: 'pending',
        lastSyncedAt: null,
        syncError: null,
        cachedPlugins: undefined,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      })
    );
    const res = await app.request('http://localhost/m-2');
    const body = await res.json();
    expect(body.data.plugins).toEqual([]);
  });

  it('IT-1720-22: GET /:id propagates 404 from service', async () => {
    svc.getById.mockResolvedValue(err('MARKETPLACE_NOT_FOUND', 'gone', 404));
    const res = await app.request('http://localhost/m-1');
    expect(res.status).toBe(404);
  });

  it('IT-1720-23: DELETE /:id rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('IT-1720-24: DELETE /:id succeeds', async () => {
    svc.delete.mockResolvedValue(ok(undefined));
    const res = await app.request('http://localhost/m-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deleted).toBe(true);
  });

  it('IT-1720-25: DELETE /:id surfaces service error', async () => {
    svc.delete.mockResolvedValue(err('MARKETPLACE_NOT_FOUND', 'gone', 404));
    const res = await app.request('http://localhost/m-1', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
