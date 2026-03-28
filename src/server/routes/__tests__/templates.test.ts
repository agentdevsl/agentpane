import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createTemplatesRoutes } from '../templates.js';

// ── Mock Template Service ──

function createMockTemplateService() {
  return {
    list: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    sync: vi.fn(),
  };
}

// ── Test App Factory ──

function createTestApp() {
  const templateService = createMockTemplateService();
  const routes = createTemplatesRoutes({ templateService: templateService as never });
  const app = new Hono();
  app.route('/api/templates', routes);
  app.onError((err, c) => {
    return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } }, 500);
  });
  return { app, templateService };
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

describe('Templates API Routes', () => {
  // ── GET /api/templates ──

  describe('GET /api/templates', () => {
    it('returns templates list', async () => {
      const { app, templateService } = createTestApp();
      const mockTemplates = [
        { id: 'tpl-1', name: 'Template 1', scope: 'org' },
        { id: 'tpl-2', name: 'Template 2', scope: 'project' },
      ];
      templateService.list.mockResolvedValue({ ok: true, value: mockTemplates });

      const res = await request(app, 'GET', '/api/templates');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(2);
      expect(json.data.totalCount).toBe(2);
    });

    it('passes scope and codespaceId query params to service', async () => {
      const { app, templateService } = createTestApp();
      templateService.list.mockResolvedValue({ ok: true, value: [] });

      await request(app, 'GET', '/api/templates?scope=project&codespaceId=proj-1&limit=10');

      expect(templateService.list).toHaveBeenCalledWith({
        scope: 'project',
        codespaceId: 'proj-1',
        limit: 10,
      });
    });

    it('returns error when service fails', async () => {
      const { app, templateService } = createTestApp();
      templateService.list.mockResolvedValue({
        ok: false,
        error: { code: 'DB_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/templates');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, templateService } = createTestApp();
      templateService.list.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'GET', '/api/templates');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── POST /api/templates ──

  describe('POST /api/templates', () => {
    it('creates a template and returns 201', async () => {
      const { app, templateService } = createTestApp();
      const created = {
        id: 'tpl-new',
        name: 'New Template',
        scope: 'org',
        githubUrl: 'https://github.com/org/repo',
      };
      templateService.create.mockResolvedValue({ ok: true, value: created });

      const res = await request(app, 'POST', '/api/templates', {
        name: 'New Template',
        scope: 'org',
        githubUrl: 'https://github.com/org/repo',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('tpl-new');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      };
      const res = await app.request('/api/templates', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('returns 400 when name is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/templates', {
        scope: 'org',
        githubUrl: 'https://github.com/org/repo',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
    });

    it('returns 400 when scope is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/templates', {
        name: 'Template',
        githubUrl: 'https://github.com/org/repo',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
      expect(json.error.message).toContain('scope');
    });

    it('returns 400 when scope is invalid', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/templates', {
        name: 'Template',
        scope: 'invalid',
        githubUrl: 'https://github.com/org/repo',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
    });

    it('returns 400 when githubUrl is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/templates', {
        name: 'Template',
        scope: 'org',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
      expect(json.error.message).toContain('githubUrl');
    });

    it('returns error when service create fails', async () => {
      const { app, templateService } = createTestApp();
      templateService.create.mockResolvedValue({
        ok: false,
        error: { code: 'DUPLICATE', message: 'Template already exists', status: 409 },
      });

      const res = await request(app, 'POST', '/api/templates', {
        name: 'Template',
        scope: 'org',
        githubUrl: 'https://github.com/org/repo',
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DUPLICATE');
    });

    it('returns 500 when service throws', async () => {
      const { app, templateService } = createTestApp();
      templateService.create.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'POST', '/api/templates', {
        name: 'Template',
        scope: 'org',
        githubUrl: 'https://github.com/org/repo',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /api/templates/:id ──

  describe('GET /api/templates/:id', () => {
    it('returns a template by id', async () => {
      const { app, templateService } = createTestApp();
      const template = { id: 'tpl-1', name: 'Template 1', scope: 'org' };
      templateService.getById.mockResolvedValue({ ok: true, value: template });

      const res = await request(app, 'GET', '/api/templates/tpl-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('tpl-1');
    });

    it('returns 400 for invalid id format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/templates/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when template not found', async () => {
      const { app, templateService } = createTestApp();
      templateService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Template not found', status: 404 },
      });

      const res = await request(app, 'GET', '/api/templates/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 500 when service throws', async () => {
      const { app, templateService } = createTestApp();
      templateService.getById.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'GET', '/api/templates/tpl-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── PATCH /api/templates/:id ──

  describe('PATCH /api/templates/:id', () => {
    it('updates a template', async () => {
      const { app, templateService } = createTestApp();
      const updated = { id: 'tpl-1', name: 'Updated Template', scope: 'org' };
      templateService.update.mockResolvedValue({ ok: true, value: updated });

      const res = await request(app, 'PATCH', '/api/templates/tpl-1', {
        name: 'Updated Template',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.name).toBe('Updated Template');
    });

    it('returns 400 for invalid id format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/templates/bad!id', {
        name: 'Updated',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken',
      };
      const res = await app.request('/api/templates/tpl-1', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('returns error when service update fails', async () => {
      const { app, templateService } = createTestApp();
      templateService.update.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Template not found', status: 404 },
      });

      const res = await request(app, 'PATCH', '/api/templates/tpl-1', {
        name: 'Updated',
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 500 when service throws', async () => {
      const { app, templateService } = createTestApp();
      templateService.update.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'PATCH', '/api/templates/tpl-1', {
        name: 'Updated',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── DELETE /api/templates/:id ──

  describe('DELETE /api/templates/:id', () => {
    it('deletes a template', async () => {
      const { app, templateService } = createTestApp();
      templateService.delete.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'DELETE', '/api/templates/tpl-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toBeNull();
    });

    it('returns 400 for invalid id format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/templates/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns error when template not found', async () => {
      const { app, templateService } = createTestApp();
      templateService.delete.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Template not found', status: 404 },
      });

      const res = await request(app, 'DELETE', '/api/templates/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 500 when service throws', async () => {
      const { app, templateService } = createTestApp();
      templateService.delete.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'DELETE', '/api/templates/tpl-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── POST /api/templates/:id/sync ──

  describe('POST /api/templates/:id/sync', () => {
    it('syncs a template', async () => {
      const { app, templateService } = createTestApp();
      const synced = { id: 'tpl-1', name: 'Template 1', lastSyncedAt: '2025-01-15T10:00:00Z' };
      templateService.sync.mockResolvedValue({ ok: true, value: synced });

      const res = await request(app, 'POST', '/api/templates/tpl-1/sync');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('tpl-1');
      expect(templateService.sync).toHaveBeenCalledWith('tpl-1');
    });

    it('returns 400 for invalid id format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/templates/bad!id/sync');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns error when sync fails', async () => {
      const { app, templateService } = createTestApp();
      templateService.sync.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Template not found', status: 404 },
      });

      const res = await request(app, 'POST', '/api/templates/tpl-1/sync');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 500 when service throws', async () => {
      const { app, templateService } = createTestApp();
      templateService.sync.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'POST', '/api/templates/tpl-1/sync');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });
});
