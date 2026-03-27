import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryRoutes } from '../memory.js';

// ── Test Data ──

const mockInsight = {
  id: 'ins-1',
  codespaceId: 'cs-1',
  content: 'Always use Drizzle for DB queries',
  source: 'manual',
  sourceSessionId: null,
  skillId: null,
  tags: [],
  metadata: null,
  createdAt: '2026-01-01T00:00:00Z',
};

const mockSearchResult = {
  id: 'ins-1',
  content: 'Always use Drizzle for DB queries',
  type: 'insight' as const,
  score: 1.0,
  createdAt: '2026-01-01T00:00:00Z',
};

// ── Mock Memory Service ──

function createMockMemoryService(opts?: { available?: boolean }) {
  const available = opts?.available ?? true;
  return {
    isAvailable: vi.fn().mockReturnValue(available),
    healthCheck: vi.fn().mockResolvedValue({
      ok: true,
      value: { available: true, insightCount: 10, messageCount: 50 },
    }),
    getInsights: vi.fn().mockResolvedValue({ ok: true, value: [mockInsight] }),
    createInsight: vi.fn().mockResolvedValue({ ok: true, value: mockInsight }),
    deleteInsight: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    search: vi.fn().mockResolvedValue({ ok: true, value: [mockSearchResult] }),
  };
}

// ── Test App Factory ──

function createTestApp(opts?: { available?: boolean }) {
  const memoryService = createMockMemoryService(opts);
  const routes = createMemoryRoutes({
    memoryService: memoryService as never,
    skillTrackingService: null,
    dreamService: null,
  });
  const app = new Hono();
  app.route('/api/memory', routes);
  return { app, memoryService };
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

describe('Memory API Routes', () => {
  // ── GET /api/memory/health ──

  describe('GET /api/memory/health', () => {
    it('returns health status data', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/memory/health');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.available).toBe(true);
      expect(json.data.insightCount).toBe(10);
    });

    it('returns error when health check fails with result error', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.healthCheck.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_SERVICE_ERROR', message: 'Service unavailable', status: 503 },
      });

      const res = await request(app, 'GET', '/api/memory/health');

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_SERVICE_ERROR');
    });

    it('returns 500 when health check throws', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.healthCheck.mockRejectedValue(new Error('Unexpected failure'));

      const res = await request(app, 'GET', '/api/memory/health');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /api/memory/codespaces/:id/insights ──

  describe('GET /api/memory/codespaces/:id/insights', () => {
    it('returns 503 when memory unavailable', async () => {
      const { app } = createTestApp({ available: false });

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/insights');

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_UNAVAILABLE');
    });

    it('returns insights with pagination metadata', async () => {
      const { app, memoryService } = createTestApp();

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/insights?page=2&size=10');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('ins-1');
      expect(json.pagination).toEqual({ page: 2, size: 10, hasMore: false });

      expect(memoryService.getInsights).toHaveBeenCalledWith('cs-1', { page: 2, size: 10 });
    });

    it('defaults page=1 size=50 when not specified', async () => {
      const { app, memoryService } = createTestApp();

      await request(app, 'GET', '/api/memory/codespaces/cs-1/insights');

      expect(memoryService.getInsights).toHaveBeenCalledWith('cs-1', { page: 1, size: 50 });
    });

    it('hasMore is true when result count equals page size', async () => {
      const { app, memoryService } = createTestApp();
      const fiveInsights = Array.from({ length: 5 }, (_, i) => ({
        ...mockInsight,
        id: `ins-${i}`,
      }));
      memoryService.getInsights.mockResolvedValue({ ok: true, value: fiveInsights });

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/insights?page=1&size=5');

      const json = await res.json();
      expect(json.pagination.hasMore).toBe(true);
    });

    it('returns error when service returns err', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.getInsights.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/insights');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_QUERY_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.getInsights.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/insights');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── POST /api/memory/codespaces/:id/insights ──

  describe('POST /api/memory/codespaces/:id/insights', () => {
    it('returns 503 when memory unavailable', async () => {
      const { app } = createTestApp({ available: false });

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/insights', {
        content: 'some content',
      });

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_UNAVAILABLE');
    });

    it('returns 400 for missing content', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/insights', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for empty string content', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/insights', {
        content: '',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for content exceeding 4096 chars', async () => {
      const { app } = createTestApp();
      const longContent = 'x'.repeat(4097);

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/insights', {
        content: longContent,
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const res = await app.request('/api/memory/codespaces/cs-1/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json{',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('creates insight and returns 201', async () => {
      const { app, memoryService } = createTestApp();

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/insights', {
        content: 'Always use Drizzle for DB queries',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('ins-1');
      expect(json.data.content).toBe('Always use Drizzle for DB queries');

      expect(memoryService.createInsight).toHaveBeenCalledWith(
        'cs-1',
        'Always use Drizzle for DB queries',
        'manual',
        undefined,
        undefined,
        undefined
      );
    });

    it('returns error when service returns err', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.createInsight.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_CAPTURE_ERROR', message: 'No insight created', status: 500 },
      });

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/insights', {
        content: 'some content',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_CAPTURE_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.createInsight.mockRejectedValue(new Error('Boom'));

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/insights', {
        content: 'some content',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── DELETE /api/memory/insights/:id ──

  describe('DELETE /api/memory/insights/:id', () => {
    it('returns 503 when memory unavailable', async () => {
      const { app } = createTestApp({ available: false });

      const res = await request(app, 'DELETE', '/api/memory/insights/ins-1');

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_UNAVAILABLE');
    });

    it('deletes insight successfully', async () => {
      const { app, memoryService } = createTestApp();

      const res = await request(app, 'DELETE', '/api/memory/insights/ins-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toBeNull();

      expect(memoryService.deleteInsight).toHaveBeenCalledWith('ins-1');
    });

    it('returns error when service returns err', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.deleteInsight.mockResolvedValue({
        ok: false,
        error: {
          code: 'MEMORY_NOT_FOUND',
          message: 'Memory entity not found: insight:ins-1',
          status: 404,
        },
      });

      const res = await request(app, 'DELETE', '/api/memory/insights/ins-1');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_NOT_FOUND');
    });

    it('returns 500 when service throws', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.deleteInsight.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'DELETE', '/api/memory/insights/ins-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── POST /api/memory/codespaces/:id/search ──

  describe('POST /api/memory/codespaces/:id/search', () => {
    it('returns 503 when memory unavailable', async () => {
      const { app } = createTestApp({ available: false });

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/search', {
        query: 'drizzle',
      });

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_UNAVAILABLE');
    });

    it('returns 400 for missing query', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/search', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for empty query string', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/search', {
        query: '',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const res = await app.request('/api/memory/codespaces/cs-1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('returns search results', async () => {
      const { app, memoryService } = createTestApp();

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/search', {
        query: 'drizzle database',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('ins-1');
      expect(json.data[0].type).toBe('insight');

      expect(memoryService.search).toHaveBeenCalledWith('cs-1', 'drizzle database', undefined);
    });

    it('passes limit option when provided', async () => {
      const { app, memoryService } = createTestApp();

      await request(app, 'POST', '/api/memory/codespaces/cs-1/search', {
        query: 'typescript',
        limit: 5,
      });

      expect(memoryService.search).toHaveBeenCalledWith('cs-1', 'typescript', 5);
    });

    it('returns error when service returns err', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.search.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/search', {
        query: 'test',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_QUERY_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.search.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/search', {
        query: 'test',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });
});
