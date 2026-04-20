import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionsRoutes } from '../../src/server/routes/sessions';

/**
 * Integration tests for sessions API routes.
 *
 * Tests CRUD, list with/without codespaceId filter, session events
 * (afterEventId vs offset mutual exclusion), export in JSON/markdown/CSV,
 * and summary defaults.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

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

describe('Sessions Routes (IT-1250)', () => {
  let app: Hono;
  let mockService: ReturnType<typeof createMockSessionService>;

  beforeEach(() => {
    mockService = createMockSessionService();
    app = createSessionsRoutes({
      sessionService: mockService as any,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET / (list without codespaceId) ─────────────────

  it('IT-1250: GET / lists sessions without filter', async () => {
    mockService.list.mockResolvedValue({
      ok: true,
      value: [
        { id: 'sess-1', title: 'Session 1', status: 'active' },
        { id: 'sess-2', title: 'Session 2', status: 'closed' },
      ],
    });

    const res = await app.request('http://localhost/');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.pagination.limit).toBe(50);
    expect(body.pagination.offset).toBe(0);
    expect(mockService.list).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });

  it('IT-1251: GET / respects limit and offset params', async () => {
    mockService.list.mockResolvedValue({ ok: true, value: [] });

    await app.request('http://localhost/?limit=10&offset=20');

    expect(mockService.list).toHaveBeenCalledWith({ limit: 10, offset: 20 });
  });

  it('IT-1252: GET / returns error on service failure', async () => {
    mockService.list.mockResolvedValue({
      ok: false,
      error: { code: 'DB_ERROR', message: 'Connection lost', status: 500 },
    });

    const res = await app.request('http://localhost/');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  // ─── GET / (list with codespaceId filter) ─────────────

  it('IT-1253: GET /?codespaceId=X uses filtered query path', async () => {
    mockService.listSessionsWithFilters.mockResolvedValue({
      ok: true,
      value: {
        sessions: [{ id: 'sess-1', status: 'active' }],
        total: 1,
      },
    });

    const res = await app.request('http://localhost/?codespaceId=cs-123');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.pagination.total).toBe(1);
    expect(mockService.listSessionsWithFilters).toHaveBeenCalledWith(
      'cs-123',
      expect.objectContaining({ limit: 50, offset: 0 })
    );
  });

  it('IT-1254: GET /?codespaceId=X supports status filter', async () => {
    mockService.listSessionsWithFilters.mockResolvedValue({
      ok: true,
      value: { sessions: [], total: 0 },
    });

    await app.request('http://localhost/?codespaceId=cs-1&status=active,closed');

    expect(mockService.listSessionsWithFilters).toHaveBeenCalledWith(
      'cs-1',
      expect.objectContaining({ status: ['active', 'closed'] })
    );
  });

  it('IT-1255: GET /?codespaceId=X filters out invalid status values', async () => {
    mockService.listSessionsWithFilters.mockResolvedValue({
      ok: true,
      value: { sessions: [], total: 0 },
    });

    await app.request('http://localhost/?codespaceId=cs-1&status=active,bogus,closed');

    expect(mockService.listSessionsWithFilters).toHaveBeenCalledWith(
      'cs-1',
      expect.objectContaining({ status: ['active', 'closed'] })
    );
  });

  it('IT-1256: GET /?codespaceId=X supports search and date filters', async () => {
    mockService.listSessionsWithFilters.mockResolvedValue({
      ok: true,
      value: { sessions: [], total: 0 },
    });

    await app.request(
      'http://localhost/?codespaceId=cs-1&search=deploy&dateFrom=2026-01-01&dateTo=2026-12-31'
    );

    expect(mockService.listSessionsWithFilters).toHaveBeenCalledWith(
      'cs-1',
      expect.objectContaining({
        search: 'deploy',
        dateFrom: '2026-01-01',
        dateTo: '2026-12-31',
      })
    );
  });

  // ─── POST / (create session) ──────────────────────────

  it('IT-1257: POST / creates a session', async () => {
    mockService.create.mockResolvedValue({
      ok: true,
      value: { id: 'sess-new', status: 'idle', codespaceId: 'cs-1' },
    });

    const res = await app.request(
      jsonRequest('http://localhost/', {
        codespaceId: 'cs-1',
        title: 'New Session',
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('sess-new');
  });

  it('IT-1258: POST / returns 400 for missing codespaceId', async () => {
    const res = await app.request(jsonRequest('http://localhost/', { title: 'No CS' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1259: POST / returns 400 for invalid JSON', async () => {
    const res = await app.request(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  // ─── GET /:id ─────────────────────────────────────────

  it('IT-1260: GET /:id returns a session', async () => {
    mockService.getById.mockResolvedValue({
      ok: true,
      value: { id: 'sess-1', status: 'active', title: 'My Session' },
    });

    const res = await app.request('http://localhost/sess-1');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.title).toBe('My Session');
  });

  it('IT-1261: GET /:id returns error for unknown session', async () => {
    mockService.getById.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Session not found', status: 404 },
    });

    const res = await app.request('http://localhost/sess-missing');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1262: GET /:id returns 400 for invalid ID', async () => {
    const res = await app.request('http://localhost/bad!id');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });

  // ─── DELETE /:id ──────────────────────────────────────

  it('IT-1263: DELETE /:id deletes a session', async () => {
    mockService.delete.mockResolvedValue({
      ok: true,
      value: { id: 'sess-1', deleted: true },
    });

    const res = await app.request('http://localhost/sess-1', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('IT-1264: DELETE /:id returns error for unknown session', async () => {
    mockService.delete.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found', status: 404 },
    });

    const res = await app.request('http://localhost/sess-gone', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
  });

  // ─── GET /:id/events ─────────────────────────────────

  it('IT-1265: GET /:id/events returns events with pagination', async () => {
    mockService.getEventsBySession.mockResolvedValue({
      ok: true,
      value: [
        { id: 'evt-1', type: 'chunk', timestamp: 1000, data: {} },
        { id: 'evt-2', type: 'tool:start', timestamp: 2000, data: {} },
      ],
    });

    const res = await app.request('http://localhost/sess-1/events?limit=10');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.pagination.limit).toBe(10);
    expect(body.pagination.afterEventId).toBeNull();
    expect(mockService.getEventsBySession).toHaveBeenCalledWith('sess-1', {
      limit: 10,
      offset: 0,
    });
  });

  it('IT-1266: GET /:id/events uses afterEventId when provided', async () => {
    mockService.getEventsBySession.mockResolvedValue({
      ok: true,
      value: [],
    });

    await app.request('http://localhost/sess-1/events?afterEventId=evt-5&limit=20');

    expect(mockService.getEventsBySession).toHaveBeenCalledWith('sess-1', {
      limit: 20,
      afterEventId: 'evt-5',
    });
  });

  it('IT-1267: GET /:id/events returns 400 when both offset and afterEventId are provided', async () => {
    const res = await app.request('http://localhost/sess-1/events?offset=5&afterEventId=evt-3');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_PARAMS');
    // The exclusivity-violation message must call out the pagination modes.
    expect(body.error.message).toContain('offset');
    expect(body.error.message).toContain('afterEventId');
  });

  // ─── GET /:id/summary ─────────────────────────────────

  it('IT-1268: GET /:id/summary returns summary data', async () => {
    mockService.getSessionSummary.mockResolvedValue({
      ok: true,
      value: {
        sessionId: 'sess-1',
        durationMs: 30000,
        turnsCount: 5,
        tokensUsed: 1500,
        filesModified: 3,
        linesAdded: 100,
        linesRemoved: 20,
        finalStatus: 'completed',
      },
    });

    const res = await app.request('http://localhost/sess-1/summary');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.turnsCount).toBe(5);
    expect(body.data.filesModified).toBe(3);
  });

  it('IT-1269: GET /:id/summary returns defaults when no summary exists', async () => {
    mockService.getSessionSummary.mockResolvedValue({
      ok: true,
      value: null,
    });

    const res = await app.request('http://localhost/sess-1/summary');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.sessionId).toBe('sess-1');
    expect(body.data.turnsCount).toBe(0);
    expect(body.data.tokensUsed).toBe(0);
    expect(body.data.filesModified).toBe(0);
    expect(body.data.durationMs).toBeNull();
    expect(body.data.finalStatus).toBeNull();
  });

  // ─── POST /:id/export ─────────────────────────────────

  it('IT-1270: POST /:id/export returns JSON format', async () => {
    mockService.getById.mockResolvedValue({
      ok: true,
      value: {
        id: 'sess-1',
        title: 'Export Test',
        status: 'closed',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    mockService.getEventsBySession.mockResolvedValue({
      ok: true,
      value: [
        {
          id: 'evt-1',
          type: 'container-agent:message',
          timestamp: 1704067200000,
          data: { role: 'assistant', content: 'Hello' },
        },
      ],
    });

    const res = await app.request(
      jsonRequest('http://localhost/sess-1/export', { format: 'json' })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.contentType).toBe('application/json');
    expect(body.data.filename).toContain('Export_Test');
    expect(body.data.filename).toContain('.json');

    // Verify content is valid JSON
    const parsed = JSON.parse(body.data.content);
    expect(parsed.session).toBeDefined();
    expect(parsed.events).toHaveLength(1);
  });

  it('IT-1271: POST /:id/export returns markdown format', async () => {
    mockService.getById.mockResolvedValue({
      ok: true,
      value: {
        id: 'sess-1',
        title: 'MD Test',
        status: 'closed',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    mockService.getEventsBySession.mockResolvedValue({
      ok: true,
      value: [
        {
          id: 'evt-1',
          type: 'container-agent:message',
          timestamp: 1704067200000,
          data: { role: 'assistant', content: 'Hello world' },
        },
      ],
    });

    const res = await app.request(
      jsonRequest('http://localhost/sess-1/export', { format: 'markdown' })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.contentType).toBe('text/markdown');
    expect(body.data.content).toContain('# Session: MD Test');
    expect(body.data.content).toContain('**assistant:** Hello world');
  });

  it('IT-1272: POST /:id/export returns CSV format', async () => {
    mockService.getById.mockResolvedValue({
      ok: true,
      value: { id: 'sess-1', title: 'CSV Test', status: 'closed' },
    });
    mockService.getEventsBySession.mockResolvedValue({
      ok: true,
      value: [
        {
          id: 'evt-1',
          type: 'tool:start',
          timestamp: 1704067200000,
          data: { toolName: 'Bash', content: 'ls -la' },
        },
      ],
    });

    const res = await app.request(jsonRequest('http://localhost/sess-1/export', { format: 'csv' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.contentType).toBe('text/csv');
    expect(body.data.content).toContain('timestamp,type,role,tool,content');
    expect(body.data.content).toContain('tool:start');
    expect(body.data.content).toContain('Bash');
  });

  it('IT-1273: POST /:id/export returns 400 for invalid format', async () => {
    const res = await app.request(jsonRequest('http://localhost/sess-1/export', { format: 'pdf' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1274: POST /:id/export returns error when session not found', async () => {
    mockService.getById.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found', status: 404 },
    });

    const res = await app.request(
      jsonRequest('http://localhost/sess-missing/export', { format: 'json' })
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1275: POST /:id/export handles events with non-object data gracefully', async () => {
    mockService.getById.mockResolvedValue({
      ok: true,
      value: { id: 'sess-1', title: 'Edge', status: 'closed' },
    });
    mockService.getEventsBySession.mockResolvedValue({
      ok: true,
      value: [
        { id: 'evt-1', type: 'system', timestamp: 1704067200000, data: null },
        {
          id: 'evt-2',
          type: 'text',
          timestamp: 1704067201000,
          data: 'plain string',
        },
      ],
    });

    const res = await app.request(
      jsonRequest('http://localhost/sess-1/export', { format: 'markdown' })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // Should not crash on null or string data
    expect(body.data.content).toContain('## Events');
  });
});
