import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentsRoutes } from '../../src/server/routes/agents';

/**
 * Integration tests for the agents routes.
 *
 * Mocks AgentService and uses a stub DB. Auth context is supplied via a
 * wrapper middleware. The token-tag filter short-circuits when auth has no
 * tagFilter, so we don't exercise the DB path here (covered by RBAC tests).
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

function createMockAgentService() {
  return {
    list: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
}

function buildApp(svc: ReturnType<typeof createMockAgentService>) {
  const wrapper = new Hono();
  wrapper.use('*', async (c, next) => {
    // Auth without tagFilter so applyTokenTagFilter returns items unchanged.
    c.set('auth', { authMethod: 'session', userId: 'u-1' } as never);
    await next();
  });
  wrapper.route('/', createAgentsRoutes({ agentService: svc as never, db: {} as never }));
  return wrapper;
}

describe('Agents Routes (IT-1820)', () => {
  let app: Hono;
  let svc: ReturnType<typeof createMockAgentService>;

  beforeEach(() => {
    svc = createMockAgentService();
    app = buildApp(svc);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET / ───────────────────────────────────────────

  it('IT-1820-1: GET / requires codespaceId', async () => {
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(400);
  });

  it('IT-1820-2: GET / returns 500 when service errors', async () => {
    svc.list.mockResolvedValue(err('LIST_FAILED', 'fail', 500));
    const res = await app.request('http://localhost/?codespaceId=cs-1');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('DB_ERROR');
  });

  it('IT-1820-3: GET / returns filtered list', async () => {
    svc.list.mockResolvedValue(ok([{ id: 'a-1', name: 'A' }]));
    const res = await app.request('http://localhost/?codespaceId=cs-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  // ─── POST / ──────────────────────────────────────────

  it('IT-1820-4: POST / rejects malformed body', async () => {
    const res = await app.request(jsonRequest('http://localhost/', { codespaceId: 'cs-1' }));
    expect(res.status).toBe(400);
  });

  it('IT-1820-5: POST / creates agent', async () => {
    svc.create.mockResolvedValue(ok({ id: 'a-1' }));
    const res = await app.request(
      jsonRequest('http://localhost/', {
        codespaceId: 'cs-1',
        name: 'a',
        type: 'task',
      })
    );
    expect(res.status).toBe(201);
  });

  it('IT-1820-6: POST / surfaces service error', async () => {
    svc.create.mockResolvedValue(err('AGENT_EXISTS', 'dup', 409));
    const res = await app.request(
      jsonRequest('http://localhost/', { codespaceId: 'cs-1', name: 'a', type: 'task' })
    );
    expect(res.status).toBe(409);
  });

  // ─── GET /:id ────────────────────────────────────────

  it('IT-1820-7: GET /:id rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id');
    expect(res.status).toBe(400);
  });

  it('IT-1820-8: GET /:id returns agent', async () => {
    svc.getById.mockResolvedValue(ok({ id: 'a-1', name: 'A' }));
    const res = await app.request('http://localhost/a-1');
    expect(res.status).toBe(200);
  });

  it('IT-1820-9: GET /:id propagates not-found', async () => {
    svc.getById.mockResolvedValue(err('AGENT_NOT_FOUND', 'gone', 404));
    const res = await app.request('http://localhost/a-1');
    expect(res.status).toBe(404);
  });

  // ─── PATCH /:id ──────────────────────────────────────

  it('IT-1820-10: PATCH /:id rejects bad ID', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/bad..id', { allowedTools: ['Read'] }, { method: 'PATCH' })
    );
    expect(res.status).toBe(400);
  });

  it('IT-1820-11: PATCH /:id rejects empty body', async () => {
    const res = await app.request(jsonRequest('http://localhost/a-1', {}, { method: 'PATCH' }));
    expect(res.status).toBe(400);
  });

  it('IT-1820-12: PATCH /:id accepts wrapped config', async () => {
    svc.update.mockResolvedValue(ok({ id: 'a-1', name: 'A' }));
    const res = await app.request(
      jsonRequest('http://localhost/a-1', { config: { maxTurns: 100 } }, { method: 'PATCH' })
    );
    expect(res.status).toBe(200);
    expect(svc.update).toHaveBeenCalledWith('a-1', { maxTurns: 100 });
  });

  it('IT-1820-13: PATCH /:id accepts flat config fields', async () => {
    svc.update.mockResolvedValue(ok({ id: 'a-1', name: 'A' }));
    const res = await app.request(
      jsonRequest('http://localhost/a-1', { maxTurns: 100, model: 'opus' }, { method: 'PATCH' })
    );
    expect(res.status).toBe(200);
    expect(svc.update).toHaveBeenCalledWith('a-1', { maxTurns: 100, model: 'opus' });
  });

  it('IT-1820-14: PATCH /:id surfaces service error', async () => {
    svc.update.mockResolvedValue(err('AGENT_NOT_FOUND', 'gone', 404));
    const res = await app.request(
      jsonRequest('http://localhost/a-1', { maxTurns: 5 }, { method: 'PATCH' })
    );
    expect(res.status).toBe(404);
  });

  // ─── DELETE /:id ─────────────────────────────────────

  it('IT-1820-15: DELETE /:id rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('IT-1820-16: DELETE /:id succeeds', async () => {
    svc.delete.mockResolvedValue(ok(undefined));
    const res = await app.request('http://localhost/a-1', { method: 'DELETE' });
    const body = await res.json();
    expect(body.data.deleted).toBe(true);
  });

  it('IT-1820-17: DELETE /:id surfaces service error', async () => {
    svc.delete.mockResolvedValue(err('AGENT_NOT_FOUND', 'gone', 404));
    const res = await app.request('http://localhost/a-1', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  // ─── POST /:id/start ─────────────────────────────────

  it('IT-1820-18: POST /:id/start rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id/start', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('IT-1820-19: POST /:id/start works without body', async () => {
    svc.start.mockResolvedValue(ok({ status: 'running' }));
    const res = await app.request('http://localhost/a-1/start', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(svc.start).toHaveBeenCalledWith('a-1', undefined);
  });

  it('IT-1820-20: POST /:id/start parses optional taskId from JSON body', async () => {
    svc.start.mockResolvedValue(ok({ status: 'running' }));
    const res = await app.request(jsonRequest('http://localhost/a-1/start', { taskId: 't-1' }));
    expect(res.status).toBe(200);
    expect(svc.start).toHaveBeenCalledWith('a-1', 't-1');
  });

  it('IT-1820-21: POST /:id/start rejects malformed JSON body', async () => {
    svc.start.mockResolvedValue(ok({ status: 'running' }));
    const res = await app.request(jsonRequest('http://localhost/a-1/start', { taskId: 'bad..id' }));
    expect(res.status).toBe(400);
  });

  it('IT-1820-22: POST /:id/start surfaces service error', async () => {
    svc.start.mockResolvedValue(err('AGENT_NOT_READY', 'not ready', 409));
    const res = await app.request('http://localhost/a-1/start', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  // ─── GET /:id/status ─────────────────────────────────

  it('IT-1820-23: GET /:id/status rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id/status');
    expect(res.status).toBe(400);
  });

  it('IT-1820-24: GET /:id/status returns status', async () => {
    svc.getById.mockResolvedValue(ok({ id: 'a-1', status: 'running' }));
    const res = await app.request('http://localhost/a-1/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('running');
  });

  it('IT-1820-25: GET /:id/status surfaces service error', async () => {
    svc.getById.mockResolvedValue(err('AGENT_NOT_FOUND', 'gone', 404));
    const res = await app.request('http://localhost/a-1/status');
    expect(res.status).toBe(404);
  });

  // ─── POST /:id/stop ──────────────────────────────────

  it('IT-1820-26: POST /:id/stop rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id/stop', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('IT-1820-27: POST /:id/stop succeeds', async () => {
    svc.stop.mockResolvedValue(ok(undefined));
    const res = await app.request('http://localhost/a-1/stop', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.stopped).toBe(true);
  });

  it('IT-1820-28: POST /:id/stop surfaces service error', async () => {
    svc.stop.mockResolvedValue(err('AGENT_NOT_RUNNING', 'no', 409));
    const res = await app.request('http://localhost/a-1/stop', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  // ─── POST /:id/pause ─────────────────────────────────

  it('IT-1820-29: POST /:id/pause rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id/pause', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('IT-1820-30: POST /:id/pause succeeds', async () => {
    svc.pause.mockResolvedValue(ok(undefined));
    const res = await app.request('http://localhost/a-1/pause', { method: 'POST' });
    const body = await res.json();
    expect(body.data.paused).toBe(true);
  });

  it('IT-1820-31: POST /:id/pause surfaces service error', async () => {
    svc.pause.mockResolvedValue(err('AGENT_NOT_RUNNING', 'no', 409));
    const res = await app.request('http://localhost/a-1/pause', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  // ─── POST /:id/resume ────────────────────────────────

  it('IT-1820-32: POST /:id/resume rejects bad ID', async () => {
    const res = await app.request('http://localhost/bad..id/resume', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('IT-1820-33: POST /:id/resume works without body', async () => {
    svc.resume.mockResolvedValue(ok({ status: 'running' }));
    const res = await app.request('http://localhost/a-1/resume', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(svc.resume).toHaveBeenCalledWith('a-1', undefined);
  });

  it('IT-1820-34: POST /:id/resume parses optional feedback from JSON body', async () => {
    svc.resume.mockResolvedValue(ok({ status: 'running' }));
    const res = await app.request(
      jsonRequest('http://localhost/a-1/resume', { feedback: 'try again' })
    );
    expect(res.status).toBe(200);
    expect(svc.resume).toHaveBeenCalledWith('a-1', 'try again');
  });

  it('IT-1820-35: POST /:id/resume rejects malformed body', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/a-1/resume', { unexpected: 'field' })
    );
    expect(res.status).toBe(400);
  });

  it('IT-1820-36: POST /:id/resume surfaces service error', async () => {
    svc.resume.mockResolvedValue(err('AGENT_NOT_PAUSED', 'no', 409));
    const res = await app.request('http://localhost/a-1/resume', { method: 'POST' });
    expect(res.status).toBe(409);
  });
});
