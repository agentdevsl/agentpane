import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryRoutes } from '../memory.js';

// ── Test Data ──

const mockConclusion = {
  id: 'conc-1',
  content: 'Always use Drizzle for DB queries',
  observerId: 'agent-default',
  observedId: 'user-default',
  sessionId: 'sess-1',
  createdAt: '2026-01-01T00:00:00Z',
};

const mockSession = {
  id: 'sess-1',
  metadata: { phase: 'planning', taskId: 'task-1' },
};

const mockSearchResult = {
  id: 'conc-1',
  content: 'Always use Drizzle for DB queries',
  type: 'conclusion' as const,
  observerId: 'agent-default',
  observedId: 'user-default',
  sessionId: 'sess-1',
  createdAt: '2026-01-01T00:00:00Z',
};

// ── Mock Memory Service ──

function createMockMemoryService(opts?: { available?: boolean }) {
  const available = opts?.available ?? true;
  return {
    isAvailable: vi.fn().mockReturnValue(available),
    healthCheck: vi.fn().mockResolvedValue({
      ok: true,
      value: { available: true, version: '2.0.1', latencyMs: 5, workspaceCount: 1 },
    }),
    getConclusions: vi.fn().mockResolvedValue({ ok: true, value: [mockConclusion] }),
    createConclusion: vi.fn().mockResolvedValue({ ok: true, value: mockConclusion }),
    deleteConclusion: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    getSessions: vi.fn().mockResolvedValue({ ok: true, value: [mockSession] }),
    search: vi.fn().mockResolvedValue({ ok: true, value: [mockSearchResult] }),
  };
}

// ── Test App Factory ──

function createTestApp(opts?: { available?: boolean }) {
  const memoryService = createMockMemoryService(opts);
  const routes = createMemoryRoutes({ memoryService: memoryService as never });
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
      expect(json.data.version).toBe('2.0.1');
      expect(json.data.latencyMs).toBe(5);
      expect(json.data.workspaceCount).toBe(1);
    });

    it('returns error when health check fails with result error', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.healthCheck.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_CONNECTION_FAILED', message: 'Connection refused', status: 503 },
      });

      const res = await request(app, 'GET', '/api/memory/health');

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_CONNECTION_FAILED');
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

  // ── GET /api/memory/codespaces/:id/conclusions ──

  describe('GET /api/memory/codespaces/:id/conclusions', () => {
    it('returns 503 when memory unavailable', async () => {
      const { app } = createTestApp({ available: false });

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/conclusions');

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_UNAVAILABLE');
    });

    it('returns conclusions with pagination metadata', async () => {
      const { app, memoryService } = createTestApp();

      const res = await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/conclusions?page=2&size=10'
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('conc-1');
      expect(json.pagination).toEqual({ page: 2, size: 10, hasMore: false });

      expect(memoryService.getConclusions).toHaveBeenCalledWith('cs-1', { page: 2, size: 10 });
    });

    it('defaults page=1 size=50 when not specified', async () => {
      const { app, memoryService } = createTestApp();

      await request(app, 'GET', '/api/memory/codespaces/cs-1/conclusions');

      expect(memoryService.getConclusions).toHaveBeenCalledWith('cs-1', { page: 1, size: 50 });
    });

    it('hasMore is true when result count equals page size', async () => {
      const { app, memoryService } = createTestApp();
      // Return exactly 5 items with size=5 => hasMore=true
      const fiveConclusions = Array.from({ length: 5 }, (_, i) => ({
        ...mockConclusion,
        id: `conc-${i}`,
      }));
      memoryService.getConclusions.mockResolvedValue({ ok: true, value: fiveConclusions });

      const res = await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/conclusions?page=1&size=5'
      );

      const json = await res.json();
      expect(json.pagination.hasMore).toBe(true);
    });

    it('returns error when service returns err', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.getConclusions.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/conclusions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_QUERY_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.getConclusions.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/conclusions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── POST /api/memory/codespaces/:id/conclusions ──

  describe('POST /api/memory/codespaces/:id/conclusions', () => {
    it('returns 503 when memory unavailable', async () => {
      const { app } = createTestApp({ available: false });

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/conclusions', {
        content: 'some content',
      });

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_UNAVAILABLE');
    });

    it('returns 400 for missing content', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/conclusions', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for empty string content', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/conclusions', {
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

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/conclusions', {
        content: longContent,
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const res = await app.request('/api/memory/codespaces/cs-1/conclusions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json{',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('creates conclusion and returns 201', async () => {
      const { app, memoryService } = createTestApp();

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/conclusions', {
        content: 'Always use Drizzle for DB queries',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('conc-1');
      expect(json.data.content).toBe('Always use Drizzle for DB queries');

      expect(memoryService.createConclusion).toHaveBeenCalledWith(
        'cs-1',
        'Always use Drizzle for DB queries'
      );
    });

    it('returns error when service returns err', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.createConclusion.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_CAPTURE_ERROR', message: 'No conclusion created', status: 500 },
      });

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/conclusions', {
        content: 'some content',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_CAPTURE_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.createConclusion.mockRejectedValue(new Error('Boom'));

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/conclusions', {
        content: 'some content',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── DELETE /api/memory/conclusions/:id ──

  describe('DELETE /api/memory/conclusions/:id', () => {
    it('returns 503 when memory unavailable', async () => {
      const { app } = createTestApp({ available: false });

      const res = await request(app, 'DELETE', '/api/memory/conclusions/conc-1?codespaceId=cs-1');

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_UNAVAILABLE');
    });

    it('returns 400 when codespaceId query param missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/memory/conclusions/conc-1');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.message).toContain('codespaceId');
    });

    it('deletes conclusion successfully', async () => {
      const { app, memoryService } = createTestApp();

      const res = await request(app, 'DELETE', '/api/memory/conclusions/conc-1?codespaceId=cs-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toBeNull();

      expect(memoryService.deleteConclusion).toHaveBeenCalledWith('cs-1', 'conc-1');
    });

    it('returns error when service returns err', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.deleteConclusion.mockResolvedValue({
        ok: false,
        error: {
          code: 'MEMORY_NOT_FOUND',
          message: 'Memory entity not found: conclusion:conc-1',
          status: 404,
        },
      });

      const res = await request(app, 'DELETE', '/api/memory/conclusions/conc-1?codespaceId=cs-1');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_NOT_FOUND');
    });

    it('returns 500 when service throws', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.deleteConclusion.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'DELETE', '/api/memory/conclusions/conc-1?codespaceId=cs-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /api/memory/codespaces/:id/sessions ──

  describe('GET /api/memory/codespaces/:id/sessions', () => {
    it('returns 503 when memory unavailable', async () => {
      const { app } = createTestApp({ available: false });

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/sessions');

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_UNAVAILABLE');
    });

    it('returns sessions list with pagination', async () => {
      const { app, memoryService } = createTestApp();

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/sessions?page=1&size=25');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('sess-1');
      expect(json.data[0].metadata).toEqual({ phase: 'planning', taskId: 'task-1' });
      expect(json.pagination).toEqual({ page: 1, size: 25, hasMore: false });

      expect(memoryService.getSessions).toHaveBeenCalledWith('cs-1', { page: 1, size: 25 });
    });

    it('defaults page=1 size=50', async () => {
      const { app, memoryService } = createTestApp();

      await request(app, 'GET', '/api/memory/codespaces/cs-1/sessions');

      expect(memoryService.getSessions).toHaveBeenCalledWith('cs-1', { page: 1, size: 50 });
    });

    it('returns error when service returns err', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.getSessions.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'Failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/sessions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_QUERY_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.getSessions.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/sessions');

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
      expect(json.data[0].id).toBe('conc-1');
      expect(json.data[0].type).toBe('conclusion');

      expect(memoryService.search).toHaveBeenCalledWith('cs-1', 'drizzle database', {
        limit: undefined,
      });
    });

    it('passes limit option when provided', async () => {
      const { app, memoryService } = createTestApp();

      await request(app, 'POST', '/api/memory/codespaces/cs-1/search', {
        query: 'typescript',
        limit: 5,
      });

      expect(memoryService.search).toHaveBeenCalledWith('cs-1', 'typescript', { limit: 5 });
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
