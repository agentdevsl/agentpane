import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createSessionsRoutes } from '../sessions.js';

// ── Mock Session Service ──

function createMockSessionService() {
  return {
    list: vi.fn(),
    listSessionsWithFilters: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    delete: vi.fn(),
    getEventsBySession: vi.fn(),
    getSessionSummary: vi.fn(),
  };
}

// ── Test App Factory ──

function createTestApp() {
  const sessionService = createMockSessionService();
  const routes = createSessionsRoutes({ sessionService: sessionService as never });
  const app = new Hono();
  app.route('/api/sessions', routes);
  return { app, sessionService };
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

describe('Sessions API Routes', () => {
  // ── GET /api/sessions ──

  describe('GET /api/sessions', () => {
    it('returns sessions list', async () => {
      const { app, sessionService } = createTestApp();
      const mockSessions = [
        { id: 'sess-1', status: 'active', title: 'Session 1' },
        { id: 'sess-2', status: 'closed', title: 'Session 2' },
      ];
      sessionService.list.mockResolvedValue({ ok: true, value: mockSessions });

      const res = await request(app, 'GET', '/api/sessions');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.pagination).toBeDefined();
      expect(json.pagination.limit).toBe(50);
      expect(json.pagination.offset).toBe(0);
    });

    it('passes pagination parameters to service', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.list.mockResolvedValue({ ok: true, value: [] });

      await request(app, 'GET', '/api/sessions?limit=10&offset=20');

      expect(sessionService.list).toHaveBeenCalledWith({ limit: 10, offset: 20 });
    });

    it('returns 500 when service fails', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.list.mockRejectedValue(new Error('DB error'));

      const res = await request(app, 'GET', '/api/sessions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('SERVER_ERROR');
    });
  });

  // ── POST /api/sessions ──

  describe('POST /api/sessions', () => {
    it('creates a session and returns 201', async () => {
      const { app, sessionService } = createTestApp();
      const created = { id: 'sess-new', projectId: 'proj-1', status: 'active' };
      sessionService.create.mockResolvedValue({ ok: true, value: created });

      const res = await request(app, 'POST', '/api/sessions', {
        projectId: 'proj-1',
        title: 'My Session',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('sess-new');
    });

    it('returns 400 when projectId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/sessions', {
        title: 'No project',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('creates a session with optional taskId and agentId', async () => {
      const { app, sessionService } = createTestApp();
      const created = {
        id: 'sess-new',
        projectId: 'proj-1',
        taskId: 'task-1',
        agentId: 'agent-1',
        status: 'active',
      };
      sessionService.create.mockResolvedValue({ ok: true, value: created });

      const res = await request(app, 'POST', '/api/sessions', {
        projectId: 'proj-1',
        taskId: 'task-1',
        agentId: 'agent-1',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.taskId).toBe('task-1');
    });
  });

  // ── GET /api/sessions/:id ──

  describe('GET /api/sessions/:id', () => {
    it('returns a session by id', async () => {
      const { app, sessionService } = createTestApp();
      const session = { id: 'sess-1', status: 'active', title: 'Test Session' };
      sessionService.getById.mockResolvedValue({ ok: true, value: session });

      const res = await request(app, 'GET', '/api/sessions/sess-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('sess-1');
    });

    it('returns 400 for invalid id format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/sessions/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when session not found', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Session not found', status: 404 },
      });

      const res = await request(app, 'GET', '/api/sessions/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ── DELETE /api/sessions/:id ──

  describe('DELETE /api/sessions/:id', () => {
    it('deletes a session', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.delete.mockResolvedValue({ ok: true, value: { deleted: true } });

      const res = await request(app, 'DELETE', '/api/sessions/sess-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/sessions/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when session not found', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.delete.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Session not found', status: 404 },
      });

      const res = await request(app, 'DELETE', '/api/sessions/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── GET /api/sessions/:id/events ──

  describe('GET /api/sessions/:id/events', () => {
    it('returns events for a session', async () => {
      const { app, sessionService } = createTestApp();
      const events = [
        { id: 'ev-1', type: 'agent:started', timestamp: Date.now(), data: {} },
        { id: 'ev-2', type: 'agent:turn', timestamp: Date.now(), data: {} },
      ];
      sessionService.getEventsBySession.mockResolvedValue({ ok: true, value: events });

      const res = await request(app, 'GET', '/api/sessions/sess-1/events');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.pagination).toBeDefined();
    });

    it('returns 400 for invalid session id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/sessions/bad!id/events');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('passes pagination params to service', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getEventsBySession.mockResolvedValue({ ok: true, value: [] });

      await request(app, 'GET', '/api/sessions/sess-1/events?limit=25&offset=10');

      expect(sessionService.getEventsBySession).toHaveBeenCalledWith('sess-1', {
        limit: 25,
        offset: 10,
      });
    });
  });

  // ── GET /api/sessions/:id/summary ──

  describe('GET /api/sessions/:id/summary', () => {
    it('returns session summary', async () => {
      const { app, sessionService } = createTestApp();
      const summary = {
        sessionId: 'sess-1',
        durationMs: 5000,
        turnsCount: 3,
        tokensUsed: 1500,
        filesModified: 2,
        linesAdded: 20,
        linesRemoved: 5,
        finalStatus: 'completed',
      };
      sessionService.getSessionSummary.mockResolvedValue({ ok: true, value: summary });

      const res = await request(app, 'GET', '/api/sessions/sess-1/summary');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.turnsCount).toBe(3);
      expect(json.data.tokensUsed).toBe(1500);
    });

    it('returns default summary when none exists', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getSessionSummary.mockResolvedValue({ ok: true, value: null });

      const res = await request(app, 'GET', '/api/sessions/sess-1/summary');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.turnsCount).toBe(0);
      expect(json.data.tokensUsed).toBe(0);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/sessions/bad!id/summary');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });
  });

  // ── POST /api/sessions/:id/export ──

  describe('POST /api/sessions/:id/export', () => {
    it('exports session as JSON', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sess-1', title: 'Test', status: 'closed' },
      });
      sessionService.getEventsBySession.mockResolvedValue({
        ok: true,
        value: [{ id: 'ev-1', type: 'agent:started', timestamp: Date.now(), data: {} }],
      });

      const res = await request(app, 'POST', '/api/sessions/sess-1/export', {
        format: 'json',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.contentType).toBe('application/json');
      expect(json.data.filename).toContain('.json');
    });

    it('exports session as markdown', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sess-1', title: 'Test', status: 'closed' },
      });
      sessionService.getEventsBySession.mockResolvedValue({ ok: true, value: [] });

      const res = await request(app, 'POST', '/api/sessions/sess-1/export', {
        format: 'markdown',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.contentType).toBe('text/markdown');
    });

    it('exports session as CSV', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sess-1', title: 'Test', status: 'closed' },
      });
      sessionService.getEventsBySession.mockResolvedValue({ ok: true, value: [] });

      const res = await request(app, 'POST', '/api/sessions/sess-1/export', {
        format: 'csv',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.contentType).toBe('text/csv');
    });

    it('returns 400 for invalid format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/sessions/sess-1/export', {
        format: 'xml',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/sessions/bad!id/export', {
        format: 'json',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when session not found', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Session not found', status: 404 },
      });

      const res = await request(app, 'POST', '/api/sessions/nonexistent-id/export', {
        format: 'json',
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── GET /api/sessions with projectId filter ──

  describe('GET /api/sessions (projectId filtering)', () => {
    it('returns sessions when valid projectId is provided', async () => {
      const { app, sessionService } = createTestApp();
      const mockSessions = [
        { id: 'sess-1', status: 'active', title: 'Session 1', projectId: 'proj-abc' },
      ];
      sessionService.listSessionsWithFilters.mockResolvedValue({
        ok: true,
        value: { sessions: mockSessions, total: 1 },
      });

      const res = await request(app, 'GET', '/api/sessions?projectId=proj-abc');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.pagination).toBeDefined();
      expect(json.pagination.total).toBe(1);
      expect(sessionService.listSessionsWithFilters).toHaveBeenCalledWith(
        'proj-abc',
        expect.objectContaining({ limit: 50, offset: 0 })
      );
    });

    it('returns 400 when limit is NaN', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/sessions?limit=notanumber');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_PARAMS');
    });

    it('returns 400 when offset is negative', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/sessions?offset=-5');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_PARAMS');
    });

    it('returns 400 when limit is zero', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/sessions?limit=0');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_PARAMS');
    });

    it('filters out invalid status values and passes only valid ones', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.listSessionsWithFilters.mockResolvedValue({
        ok: true,
        value: { sessions: [], total: 0 },
      });

      await request(
        app,
        'GET',
        '/api/sessions?projectId=proj-abc&status=active,invalid_status,closed'
      );

      expect(sessionService.listSessionsWithFilters).toHaveBeenCalledWith(
        'proj-abc',
        expect.objectContaining({ status: ['active', 'closed'] })
      );
    });

    it('passes undefined status when all status values are invalid', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.listSessionsWithFilters.mockResolvedValue({
        ok: true,
        value: { sessions: [], total: 0 },
      });

      await request(app, 'GET', '/api/sessions?projectId=proj-abc&status=bad_status,another_bad');

      const callArgs = sessionService.listSessionsWithFilters.mock.calls[0]?.[1];
      // After filtering all invalid statuses, status array should be empty (not undefined)
      expect(callArgs.status).toEqual([]);
    });
  });

  // ── GET /api/sessions/:id/stream ──

  describe('GET /api/sessions/:id/stream', () => {
    it('returns SSE response with correct headers', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sess-1', status: 'active' },
      });

      const res = await request(app, 'GET', '/api/sessions/sess-1/stream');

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
      expect(res.headers.get('Connection')).toBe('keep-alive');

      // Clean up the stream
      const reader = res.body!.getReader();
      reader.cancel();
    });

    it('returns 400 for invalid session id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/sessions/bad!id/stream');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when session not found', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Session not found', status: 404 },
      });

      const res = await request(app, 'GET', '/api/sessions/nonexistent-id/stream');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });
});
