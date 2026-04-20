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
  app.onError((err, c) => {
    return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } }, 500);
  });
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
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });

    it('returns hasMore = true when result count equals limit', async () => {
      const { app, sessionService } = createTestApp();
      // Return exactly 5 results when limit is 5
      const fiveSessions = Array.from({ length: 5 }, (_, i) => ({
        id: `sess-${i}`,
        status: 'active',
      }));
      sessionService.list.mockResolvedValue({ ok: true, value: fiveSessions });

      const res = await request(app, 'GET', '/api/sessions?limit=5');

      const json = await res.json();
      expect(json.pagination.hasMore).toBe(true);
    });

    it('returns hasMore = false when result count is less than limit', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.list.mockResolvedValue({
        ok: true,
        value: [{ id: 'sess-1', status: 'active' }],
      });

      const res = await request(app, 'GET', '/api/sessions?limit=10');

      const json = await res.json();
      expect(json.pagination.hasMore).toBe(false);
    });

    it('returns error when list returns error result', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.list.mockResolvedValue({
        ok: false,
        error: { code: 'DB_ERROR', message: 'Failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/sessions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── POST /api/sessions ──

  describe('POST /api/sessions', () => {
    it('creates a session and returns 201', async () => {
      const { app, sessionService } = createTestApp();
      const created = { id: 'sess-new', codespaceId: 'proj-1', status: 'active' };
      sessionService.create.mockResolvedValue({ ok: true, value: created });

      const res = await request(app, 'POST', '/api/sessions', {
        codespaceId: 'proj-1',
        title: 'My Session',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('sess-new');
    });

    it('returns 400 when codespaceId is missing', async () => {
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
        codespaceId: 'proj-1',
        taskId: 'task-1',
        agentId: 'agent-1',
        status: 'active',
      };
      sessionService.create.mockResolvedValue({ ok: true, value: created });

      const res = await request(app, 'POST', '/api/sessions', {
        codespaceId: 'proj-1',
        taskId: 'task-1',
        agentId: 'agent-1',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.taskId).toBe('task-1');
    });

    it('returns 500 when create throws', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.create.mockRejectedValue(new Error('DB crashed'));

      const res = await request(app, 'POST', '/api/sessions', {
        codespaceId: 'proj-1',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });

    it('returns error when create returns error result', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.create.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Project not found', status: 404 },
      });

      const res = await request(app, 'POST', '/api/sessions', {
        codespaceId: 'proj-nonexistent',
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('passes title to create service', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.create.mockResolvedValue({
        ok: true,
        value: { id: 'sess-1', codespaceId: 'proj-1', title: 'My Title' },
      });

      await request(app, 'POST', '/api/sessions', {
        codespaceId: 'proj-1',
        title: 'My Title',
      });

      expect(sessionService.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'My Title' })
      );
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

    it('returns 500 when getById throws', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockRejectedValue(new Error('DB crash'));

      const res = await request(app, 'GET', '/api/sessions/sess-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error.code).toBe('INTERNAL_ERROR');
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

    it('returns 500 when delete throws', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.delete.mockRejectedValue(new Error('DB crash'));

      const res = await request(app, 'DELETE', '/api/sessions/sess-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error.code).toBe('INTERNAL_ERROR');
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

    it('passes afterEventId to the service as the explicit history resume boundary', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getEventsBySession.mockResolvedValue({ ok: true, value: [] });

      await request(app, 'GET', '/api/sessions/sess-1/events?limit=25&afterEventId=evt-1');

      expect(sessionService.getEventsBySession).toHaveBeenCalledWith('sess-1', {
        limit: 25,
        afterEventId: 'evt-1',
      });
    });

    it('rejects mixed offset and afterEventId params', async () => {
      const { app, sessionService } = createTestApp();

      const res = await request(
        app,
        'GET',
        '/api/sessions/sess-1/events?offset=10&afterEventId=evt-1'
      );

      expect(res.status).toBe(400);
      expect(sessionService.getEventsBySession).not.toHaveBeenCalled();
    });

    it('rejects mixed offset and beforeOffset params', async () => {
      const { app, sessionService } = createTestApp();

      const res = await request(app, 'GET', '/api/sessions/sess-1/events?offset=10&beforeOffset=5');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_PARAMS');
      expect(sessionService.getEventsBySession).not.toHaveBeenCalled();
    });

    it('rejects mixed offset and fromOffset/toOffset range', async () => {
      const { app, sessionService } = createTestApp();

      const res = await request(
        app,
        'GET',
        '/api/sessions/sess-1/events?offset=10&fromOffset=1&toOffset=5'
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_PARAMS');
      expect(sessionService.getEventsBySession).not.toHaveBeenCalled();
    });

    it('rejects mixed beforeOffset and fromOffset/toOffset range', async () => {
      const { app, sessionService } = createTestApp();

      const res = await request(
        app,
        'GET',
        '/api/sessions/sess-1/events?beforeOffset=5&fromOffset=1&toOffset=5'
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_PARAMS');
      expect(sessionService.getEventsBySession).not.toHaveBeenCalled();
    });

    it('rejects mixed afterEventId and beforeOffset params', async () => {
      const { app, sessionService } = createTestApp();

      const res = await request(
        app,
        'GET',
        '/api/sessions/sess-1/events?afterEventId=evt-1&beforeOffset=5'
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_PARAMS');
      expect(sessionService.getEventsBySession).not.toHaveBeenCalled();
    });

    it('rejects partial range (fromOffset without toOffset)', async () => {
      const { app, sessionService } = createTestApp();

      const res = await request(app, 'GET', '/api/sessions/sess-1/events?fromOffset=1');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_PARAMS');
      expect(json.error.message).toContain('fromOffset and toOffset');
      expect(sessionService.getEventsBySession).not.toHaveBeenCalled();
    });

    it('accepts fromOffset + toOffset together', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getEventsBySession.mockResolvedValue({ ok: true, value: [] });

      const res = await request(app, 'GET', '/api/sessions/sess-1/events?fromOffset=1&toOffset=5');

      expect(res.status).toBe(200);
      expect(sessionService.getEventsBySession).toHaveBeenCalledWith('sess-1', {
        limit: 100,
        fromOffset: 1,
        toOffset: 5,
      });
    });

    it('defaults to limit=100 and offset=0', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getEventsBySession.mockResolvedValue({ ok: true, value: [] });

      await request(app, 'GET', '/api/sessions/sess-1/events');

      expect(sessionService.getEventsBySession).toHaveBeenCalledWith('sess-1', {
        limit: 100,
        offset: 0,
      });
    });

    it('returns error when service returns error result', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getEventsBySession.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Session not found', status: 404 },
      });

      const res = await request(app, 'GET', '/api/sessions/sess-1/events');

      expect(res.status).toBe(404);
    });

    it('returns 500 when getEventsBySession throws', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getEventsBySession.mockRejectedValue(new Error('crash'));

      const res = await request(app, 'GET', '/api/sessions/sess-1/events');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });

    it('returns pagination total matching data length', async () => {
      const { app, sessionService } = createTestApp();
      const events = [{ id: 'ev-1', type: 'agent:started', timestamp: Date.now(), data: {} }];
      sessionService.getEventsBySession.mockResolvedValue({ ok: true, value: events });

      const res = await request(app, 'GET', '/api/sessions/sess-1/events');
      const json = await res.json();

      expect(json.pagination.total).toBe(1);
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
      expect(json.data.durationMs).toBeNull();
      expect(json.data.finalStatus).toBeNull();
      expect(json.data.sessionId).toBe('sess-1');
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/sessions/bad!id/summary');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns error when service returns error result', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getSessionSummary.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Session not found', status: 404 },
      });

      const res = await request(app, 'GET', '/api/sessions/sess-1/summary');

      expect(res.status).toBe(404);
    });

    it('returns 500 when getSessionSummary throws', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getSessionSummary.mockRejectedValue(new Error('crash'));

      const res = await request(app, 'GET', '/api/sessions/sess-1/summary');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error.code).toBe('INTERNAL_ERROR');
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
      expect(json.data.filename).toContain('.md');
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
      expect(json.data.filename).toContain('_events_');
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

    it('returns 500 when export throws', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockRejectedValue(new Error('DB crash'));

      const res = await request(app, 'POST', '/api/sessions/sess-1/export', {
        format: 'json',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });

    it('handles events fetch failure gracefully during export', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sess-1', title: 'Test', status: 'closed' },
      });
      // Events fetch returns error — should still export with empty events
      sessionService.getEventsBySession.mockResolvedValue({
        ok: false,
        error: { code: 'DB_ERROR', message: 'Events table corrupted', status: 500 },
      });

      const res = await request(app, 'POST', '/api/sessions/sess-1/export', {
        format: 'json',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      // Should export with empty events array
      const content = JSON.parse(json.data.content);
      expect(content.events).toEqual([]);
    });

    it('sanitizes session title for filename', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sess-1', title: 'My Session / with special chars!', status: 'closed' },
      });
      sessionService.getEventsBySession.mockResolvedValue({ ok: true, value: [] });

      const res = await request(app, 'POST', '/api/sessions/sess-1/export', {
        format: 'json',
      });

      const json = await res.json();
      // Special chars should be replaced with underscores
      expect(json.data.filename).not.toContain('/');
      expect(json.data.filename).not.toContain('!');
    });

    it('uses session id fallback when title is empty', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sess-1', title: '', status: 'closed' },
      });
      sessionService.getEventsBySession.mockResolvedValue({ ok: true, value: [] });

      const res = await request(app, 'POST', '/api/sessions/sess-1/export', {
        format: 'json',
      });

      const json = await res.json();
      expect(json.data.filename).toContain('session');
    });

    it('exports markdown with container-agent:message events formatted', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sess-1', title: 'Test', status: 'closed', createdAt: '2026-03-16T00:00:00Z' },
      });
      sessionService.getEventsBySession.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'ev-1',
            type: 'container-agent:message',
            timestamp: 1710547200000,
            data: { role: 'assistant', content: 'Hello world' },
          },
        ],
      });

      const res = await request(app, 'POST', '/api/sessions/sess-1/export', {
        format: 'markdown',
      });

      const json = await res.json();
      expect(json.data.content).toContain('**assistant:**');
      expect(json.data.content).toContain('Hello world');
    });

    it('exports markdown with tool events formatted', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sess-1', title: 'Test', status: 'closed' },
      });
      sessionService.getEventsBySession.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'ev-1',
            type: 'tool:result',
            timestamp: 1710547200000,
            data: {
              toolName: 'Read',
              input: { path: '/tmp/test.ts' },
              output: 'file contents here',
            },
          },
        ],
      });

      const res = await request(app, 'POST', '/api/sessions/sess-1/export', {
        format: 'markdown',
      });

      const json = await res.json();
      expect(json.data.content).toContain('**Tool:** Read');
      expect(json.data.content).toContain('file contents here');
    });

    it('exports CSV with proper header and event rows', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sess-1', title: 'Test', status: 'closed' },
      });
      sessionService.getEventsBySession.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'ev-1',
            type: 'agent:started',
            timestamp: 1710547200000,
            data: { content: 'Starting agent' },
          },
        ],
      });

      const res = await request(app, 'POST', '/api/sessions/sess-1/export', {
        format: 'csv',
      });

      const json = await res.json();
      const lines = json.data.content.split('\n');
      expect(lines[0]).toBe('timestamp,type,role,tool,content');
      expect(lines[1]).toContain('agent:started');
      expect(lines[1]).toContain('Starting agent');
    });

    it('truncates long content in CSV export', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sess-1', title: 'Test', status: 'closed' },
      });
      sessionService.getEventsBySession.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'ev-1',
            type: 'chunk',
            timestamp: 1710547200000,
            data: { content: 'A'.repeat(300) },
          },
        ],
      });

      const res = await request(app, 'POST', '/api/sessions/sess-1/export', {
        format: 'csv',
      });

      const json = await res.json();
      const lines = json.data.content.split('\n');
      // Content should be truncated to 200 + "..."
      expect(lines[1]).toContain('...');
    });

    it('escapes CSV fields with commas and quotes', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sess-1', title: 'Test', status: 'closed' },
      });
      sessionService.getEventsBySession.mockResolvedValue({
        ok: true,
        value: [
          {
            id: 'ev-1',
            type: 'chunk',
            timestamp: 1710547200000,
            data: { content: 'Hello, "world"' },
          },
        ],
      });

      const res = await request(app, 'POST', '/api/sessions/sess-1/export', {
        format: 'csv',
      });

      const json = await res.json();
      // The content field should be escaped: "Hello, ""world"""
      expect(json.data.content).toContain('"Hello, ""world"""');
    });
  });

  // ── GET /api/sessions with codespaceId filter ──

  describe('GET /api/sessions (codespaceId filtering)', () => {
    it('returns sessions when valid codespaceId is provided', async () => {
      const { app, sessionService } = createTestApp();
      const mockSessions = [
        { id: 'sess-1', status: 'active', title: 'Session 1', codespaceId: 'proj-abc' },
      ];
      sessionService.listSessionsWithFilters.mockResolvedValue({
        ok: true,
        value: { sessions: mockSessions, total: 1 },
      });

      const res = await request(app, 'GET', '/api/sessions?codespaceId=proj-abc');

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

    it('defaults limit to 50 when NaN is passed', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.listSessionsWithFilters.mockResolvedValue({
        ok: true,
        value: { sessions: [], total: 0 },
      });

      const res = await request(app, 'GET', '/api/sessions?codespaceId=proj-abc&limit=notanumber');

      expect(res.status).toBe(200);
      expect(sessionService.listSessionsWithFilters).toHaveBeenCalledWith(
        'proj-abc',
        expect.objectContaining({ limit: 50 })
      );
    });

    it('clamps offset to 0 when negative value is passed', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.listSessionsWithFilters.mockResolvedValue({
        ok: true,
        value: { sessions: [], total: 0 },
      });

      const res = await request(app, 'GET', '/api/sessions?codespaceId=proj-abc&offset=-5');

      expect(res.status).toBe(200);
      expect(sessionService.listSessionsWithFilters).toHaveBeenCalledWith(
        'proj-abc',
        expect.objectContaining({ offset: 0 })
      );
    });

    it('clamps limit to 1 when zero is passed', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.listSessionsWithFilters.mockResolvedValue({
        ok: true,
        value: { sessions: [], total: 0 },
      });

      const res = await request(app, 'GET', '/api/sessions?codespaceId=proj-abc&limit=0');

      expect(res.status).toBe(200);
      expect(sessionService.listSessionsWithFilters).toHaveBeenCalledWith(
        'proj-abc',
        expect.objectContaining({ limit: 1 })
      );
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
        '/api/sessions?codespaceId=proj-abc&status=active,invalid_status,closed'
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

      await request(app, 'GET', '/api/sessions?codespaceId=proj-abc&status=bad_status,another_bad');

      const callArgs = sessionService.listSessionsWithFilters.mock.calls[0]?.[1];
      // After filtering all invalid statuses, status array should be empty (not undefined)
      expect(callArgs.status).toEqual([]);
    });

    it('returns 500 when listSessionsWithFilters returns a DB_ERROR result', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.listSessionsWithFilters.mockResolvedValue({
        ok: false,
        error: { code: 'DB_ERROR', status: 500, message: 'Database error' },
      });

      const res = await request(app, 'GET', '/api/sessions?codespaceId=proj-abc');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });

    it('returns 500 with INTERNAL_ERROR code when listSessionsWithFilters throws an exception', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.listSessionsWithFilters.mockRejectedValue(new Error('Unexpected DB crash'));

      const res = await request(app, 'GET', '/api/sessions?codespaceId=proj-abc');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });

    it('passes agentId and search filters', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.listSessionsWithFilters.mockResolvedValue({
        ok: true,
        value: { sessions: [], total: 0 },
      });

      await request(app, 'GET', '/api/sessions?codespaceId=proj-abc&agentId=agent-1&search=test');

      expect(sessionService.listSessionsWithFilters).toHaveBeenCalledWith(
        'proj-abc',
        expect.objectContaining({ agentId: 'agent-1', search: 'test' })
      );
    });

    it('passes date range filters', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.listSessionsWithFilters.mockResolvedValue({
        ok: true,
        value: { sessions: [], total: 0 },
      });

      await request(
        app,
        'GET',
        '/api/sessions?codespaceId=proj-abc&dateFrom=2026-01-01&dateTo=2026-12-31'
      );

      expect(sessionService.listSessionsWithFilters).toHaveBeenCalledWith(
        'proj-abc',
        expect.objectContaining({ dateFrom: '2026-01-01', dateTo: '2026-12-31' })
      );
    });

    it('returns hasMore based on session count matching limit', async () => {
      const { app, sessionService } = createTestApp();
      const fiveSessions = Array.from({ length: 5 }, (_, i) => ({
        id: `sess-${i}`,
        status: 'active',
      }));
      sessionService.listSessionsWithFilters.mockResolvedValue({
        ok: true,
        value: { sessions: fiveSessions, total: 10 },
      });

      const res = await request(app, 'GET', '/api/sessions?codespaceId=proj-abc&limit=5');

      const json = await res.json();
      expect(json.pagination.hasMore).toBe(true);
    });

    it('returns hasMore = false when fewer sessions than limit', async () => {
      const { app, sessionService } = createTestApp();
      sessionService.listSessionsWithFilters.mockResolvedValue({
        ok: true,
        value: { sessions: [{ id: 'sess-1' }], total: 1 },
      });

      const res = await request(app, 'GET', '/api/sessions?codespaceId=proj-abc&limit=10');

      const json = await res.json();
      expect(json.pagination.hasMore).toBe(false);
    });
  });

  // NOTE: SSE stream endpoint tests removed — clients use Caddy durable streams directly.
});
