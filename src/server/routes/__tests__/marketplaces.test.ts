import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createMarketplacesRoutes } from '../marketplaces.js';

// ── Mock Marketplace Service ──

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

// ── Test App Factory ──

function createTestApp() {
  const marketplaceService = createMockMarketplaceService();
  const routes = createMarketplacesRoutes({ marketplaceService: marketplaceService as never });
  const app = new Hono();
  app.route('/api/marketplaces', routes);
  return { app, marketplaceService };
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

describe('Marketplaces API Routes', () => {
  // ── GET /api/marketplaces ──

  describe('GET /api/marketplaces', () => {
    it('returns marketplaces list', async () => {
      const { app, marketplaceService } = createTestApp();
      const mockMarketplaces = [
        {
          id: 'mp-1',
          name: 'Default',
          githubOwner: 'org',
          githubRepo: 'repo',
          branch: 'main',
          pluginsPath: 'plugins',
          isDefault: true,
          isEnabled: true,
          status: 'synced',
          lastSyncedAt: '2025-01-01',
          syncError: null,
          cachedPlugins: [{ id: 'p1' }],
          createdAt: '2025-01-01',
          updatedAt: '2025-01-01',
        },
      ];
      marketplaceService.list.mockResolvedValue({ ok: true, value: mockMarketplaces });

      const res = await request(app, 'GET', '/api/marketplaces');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(1);
      expect(json.data.items[0].id).toBe('mp-1');
      expect(json.data.items[0].pluginCount).toBe(1);
      expect(json.data.totalCount).toBe(1);
    });

    it('passes limit and includeDisabled params', async () => {
      const { app, marketplaceService } = createTestApp();
      marketplaceService.list.mockResolvedValue({ ok: true, value: [] });

      await request(app, 'GET', '/api/marketplaces?limit=5&includeDisabled=true');

      expect(marketplaceService.list).toHaveBeenCalledWith({
        limit: 5,
        includeDisabled: true,
      });
    });

    it('returns error when service fails', async () => {
      const { app, marketplaceService } = createTestApp();
      marketplaceService.list.mockResolvedValue({
        ok: false,
        error: { code: 'DB_ERROR', message: 'Failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/marketplaces');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── POST /api/marketplaces ──

  describe('POST /api/marketplaces', () => {
    it('creates a marketplace and returns 201', async () => {
      const { app, marketplaceService } = createTestApp();
      const created = { id: 'mp-new', name: 'New Marketplace' };
      marketplaceService.create.mockResolvedValue({ ok: true, value: created });

      const res = await request(app, 'POST', '/api/marketplaces', {
        name: 'New Marketplace',
        githubOwner: 'org',
        githubRepo: 'repo',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('mp-new');
    });

    it('returns 400 when name is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/marketplaces', {
        githubOwner: 'org',
        githubRepo: 'repo',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_NAME');
    });

    it('returns 400 when github info is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/marketplaces', {
        name: 'Marketplace',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_REPO');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      };
      const res = await app.request('/api/marketplaces', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('accepts githubUrl instead of owner/repo', async () => {
      const { app, marketplaceService } = createTestApp();
      const created = { id: 'mp-url', name: 'URL Marketplace' };
      marketplaceService.create.mockResolvedValue({ ok: true, value: created });

      const res = await request(app, 'POST', '/api/marketplaces', {
        name: 'URL Marketplace',
        githubUrl: 'https://github.com/org/repo',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
    });

    it('returns error when service fails', async () => {
      const { app, marketplaceService } = createTestApp();
      marketplaceService.create.mockResolvedValue({
        ok: false,
        error: { code: 'DUPLICATE', message: 'Already exists', status: 409 },
      });

      const res = await request(app, 'POST', '/api/marketplaces', {
        name: 'Dup',
        githubOwner: 'org',
        githubRepo: 'repo',
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── POST /api/marketplaces/seed ──

  describe('POST /api/marketplaces/seed', () => {
    it('seeds default marketplace', async () => {
      const { app, marketplaceService } = createTestApp();
      marketplaceService.seedDefaultMarketplace.mockResolvedValue({
        ok: true,
        value: { id: 'mp-default' },
      });

      const res = await request(app, 'POST', '/api/marketplaces/seed');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.seeded).toBe(true);
    });

    it('returns seeded=false when already seeded', async () => {
      const { app, marketplaceService } = createTestApp();
      marketplaceService.seedDefaultMarketplace.mockResolvedValue({
        ok: true,
        value: null,
      });

      const res = await request(app, 'POST', '/api/marketplaces/seed');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.seeded).toBe(false);
    });

    it('returns error when service fails', async () => {
      const { app, marketplaceService } = createTestApp();
      marketplaceService.seedDefaultMarketplace.mockResolvedValue({
        ok: false,
        error: { code: 'DB_ERROR', message: 'Failed', status: 500 },
      });

      const res = await request(app, 'POST', '/api/marketplaces/seed');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── GET /api/marketplaces/plugins ──

  describe('GET /api/marketplaces/plugins', () => {
    it('returns all plugins', async () => {
      const { app, marketplaceService } = createTestApp();
      const plugins = [{ id: 'p1', name: 'Plugin 1' }];
      marketplaceService.listAllPlugins.mockResolvedValue({ ok: true, value: plugins });

      const res = await request(app, 'GET', '/api/marketplaces/plugins');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(1);
      expect(json.data.totalCount).toBe(1);
    });

    it('passes search and category filters', async () => {
      const { app, marketplaceService } = createTestApp();
      marketplaceService.listAllPlugins.mockResolvedValue({ ok: true, value: [] });

      await request(
        app,
        'GET',
        '/api/marketplaces/plugins?search=terraform&category=infra&marketplaceId=mp-1'
      );

      expect(marketplaceService.listAllPlugins).toHaveBeenCalledWith({
        search: 'terraform',
        category: 'infra',
        marketplaceId: 'mp-1',
      });
    });

    it('returns error when service fails', async () => {
      const { app, marketplaceService } = createTestApp();
      marketplaceService.listAllPlugins.mockResolvedValue({
        ok: false,
        error: { code: 'DB_ERROR', message: 'Failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/marketplaces/plugins');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── GET /api/marketplaces/categories ──

  describe('GET /api/marketplaces/categories', () => {
    it('returns categories', async () => {
      const { app, marketplaceService } = createTestApp();
      const categories = ['infra', 'security', 'monitoring'];
      marketplaceService.getCategories.mockResolvedValue({ ok: true, value: categories });

      const res = await request(app, 'GET', '/api/marketplaces/categories');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.categories).toEqual(['infra', 'security', 'monitoring']);
    });

    it('returns error when service fails', async () => {
      const { app, marketplaceService } = createTestApp();
      marketplaceService.getCategories.mockResolvedValue({
        ok: false,
        error: { code: 'DB_ERROR', message: 'Failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/marketplaces/categories');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── POST /api/marketplaces/:id/sync ──

  describe('POST /api/marketplaces/:id/sync', () => {
    it('syncs a marketplace', async () => {
      const { app, marketplaceService } = createTestApp();
      marketplaceService.sync.mockResolvedValue({
        ok: true,
        value: { pluginCount: 42 },
      });

      const res = await request(app, 'POST', '/api/marketplaces/mp-1/sync');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.pluginCount).toBe(42);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/marketplaces/bad!id/sync');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns error when sync fails', async () => {
      const { app, marketplaceService } = createTestApp();
      marketplaceService.sync.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Marketplace not found', status: 404 },
      });

      const res = await request(app, 'POST', '/api/marketplaces/mp-1/sync');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ── GET /api/marketplaces/:id ──

  describe('GET /api/marketplaces/:id', () => {
    it('returns a marketplace by id', async () => {
      const { app, marketplaceService } = createTestApp();
      const marketplace = {
        id: 'mp-1',
        name: 'Default',
        githubOwner: 'org',
        githubRepo: 'repo',
        branch: 'main',
        pluginsPath: 'plugins',
        isDefault: true,
        isEnabled: true,
        status: 'synced',
        lastSyncedAt: '2025-01-01',
        syncError: null,
        cachedPlugins: [{ id: 'p1' }],
        createdAt: '2025-01-01',
        updatedAt: '2025-01-01',
      };
      marketplaceService.getById.mockResolvedValue({ ok: true, value: marketplace });

      const res = await request(app, 'GET', '/api/marketplaces/mp-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('mp-1');
      expect(json.data.plugins).toHaveLength(1);
    });

    it('returns 400 for invalid id format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/marketplaces/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when marketplace not found', async () => {
      const { app, marketplaceService } = createTestApp();
      marketplaceService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Not found', status: 404 },
      });

      const res = await request(app, 'GET', '/api/marketplaces/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ── DELETE /api/marketplaces/:id ──

  describe('DELETE /api/marketplaces/:id', () => {
    it('deletes a marketplace', async () => {
      const { app, marketplaceService } = createTestApp();
      marketplaceService.delete.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'DELETE', '/api/marketplaces/mp-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.deleted).toBe(true);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/marketplaces/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns error when marketplace not found', async () => {
      const { app, marketplaceService } = createTestApp();
      marketplaceService.delete.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Marketplace not found', status: 404 },
      });

      const res = await request(app, 'DELETE', '/api/marketplaces/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });
});
