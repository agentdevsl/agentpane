import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createAgentsRoutes } from '../agents.js';

// ── Mock Agent Service ──

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

// ── Test App Factory ──

function createTestApp() {
  const agentService = createMockAgentService();
  // Minimal stub DB for the tag-filter helper. Tests do not exercise tag
  // restrictions; the helper short-circuits when `auth.tagFilter` is unset.
  const db = {} as never;
  const routes = createAgentsRoutes({ agentService: agentService as never, db });
  const app = new Hono();
  app.route('/api/agents', routes);
  return { app, agentService };
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

describe('Agents API Routes', () => {
  // ── GET /api/agents ──

  describe('GET /api/agents', () => {
    it('returns agents list for a project', async () => {
      const { app, agentService } = createTestApp();
      const mockAgents = [
        { id: 'agent-1', name: 'Agent 1', status: 'idle', codespaceId: 'proj-1' },
      ];
      agentService.list.mockResolvedValue({ ok: true, value: mockAgents });

      const res = await request(app, 'GET', '/api/agents?codespaceId=proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('agent-1');
    });

    it('returns 400 when codespaceId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/agents');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
    });

    it('returns 400 when codespaceId is invalid', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/agents?codespaceId=bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });
  });

  // ── POST /api/agents ──

  describe('POST /api/agents', () => {
    it('creates an agent and returns 201', async () => {
      const { app, agentService } = createTestApp();
      const created = {
        id: 'agent-new',
        name: 'New Agent',
        type: 'task',
        codespaceId: 'proj-1',
        status: 'idle',
      };
      agentService.create.mockResolvedValue({ ok: true, value: created });

      const res = await request(app, 'POST', '/api/agents', {
        codespaceId: 'proj-1',
        name: 'New Agent',
        type: 'task',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('agent-new');
    });

    it('returns 400 when required fields are missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/agents', {
        codespaceId: 'proj-1',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid agent type', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/agents', {
        codespaceId: 'proj-1',
        name: 'Agent',
        type: 'invalid-type',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      };
      const res = await app.request('/api/agents', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid codespaceId format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/agents', {
        codespaceId: '../bad',
        name: 'Agent',
        type: 'task',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── GET /api/agents/:id ──

  describe('GET /api/agents/:id', () => {
    it('returns an agent by id', async () => {
      const { app, agentService } = createTestApp();
      const agent = { id: 'agent-1', name: 'Agent 1', status: 'idle' };
      agentService.getById.mockResolvedValue({ ok: true, value: agent });

      const res = await request(app, 'GET', '/api/agents/agent-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('agent-1');
    });

    it('returns 400 for invalid id format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/agents/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when agent not found', async () => {
      const { app, agentService } = createTestApp();
      agentService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Agent not found', status: 404 },
      });

      const res = await request(app, 'GET', '/api/agents/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ── PATCH /api/agents/:id ──

  describe('PATCH /api/agents/:id', () => {
    it('updates an agent config', async () => {
      const { app, agentService } = createTestApp();
      const updated = { id: 'agent-1', name: 'Agent 1', config: { maxTurns: 100 } };
      agentService.update.mockResolvedValue({ ok: true, value: updated });

      const res = await request(app, 'PATCH', '/api/agents/agent-1', {
        config: { maxTurns: 100 },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.config.maxTurns).toBe(100);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/agents/bad!id', {
        config: { maxTurns: 100 },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for empty body', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/agents/agent-1', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      // arch29-W2-H / F07-03: parseJsonBody now emits VALIDATION_ERROR
      // for empty/invalid update bodies (was MISSING_PARAMS).
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken',
      };
      const res = await app.request('/api/agents/agent-1', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      // arch29-W2-H / F07-15: parseJsonBody emits VALIDATION_ERROR for
      // JSON parse failures (was INVALID_JSON).
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('arch29-W2-H / F07-03: rejects oversized systemPrompt (Zod-bypass regression)', async () => {
      // Before W2-H, PATCH /api/agents/:id called `c.req.json()` directly
      // and forwarded the body to `agentService.update` with no field
      // validation. A client could send `{ systemPrompt: 'x'.repeat(1e6) }`
      // and the giant string would land in the DB. This test asserts the
      // schema now bounds the field at 20000 chars.
      const { app, agentService } = createTestApp();

      const oversized = 'x'.repeat(20_001);
      const res = await request(app, 'PATCH', '/api/agents/agent-1', {
        systemPrompt: oversized,
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
      // Service must NOT have been called with the oversized payload.
      expect(agentService.update).not.toHaveBeenCalled();
    });

    it('arch29-W2-H / F07-03: rejects unknown enum values for status fields', async () => {
      // Before W2-H, the status field on workflows.ts:97 was bare-cast to
      // the enum union — clients could write `status: "garbage"`. The
      // updateAgentSchema does not have a status field, but the same
      // pattern applied to allowedTools max length.
      const { app, agentService } = createTestApp();

      const res = await request(app, 'PATCH', '/api/agents/agent-1', {
        allowedTools: Array.from({ length: 201 }, (_, i) => `tool-${i}`),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(agentService.update).not.toHaveBeenCalled();
    });
  });

  // ── DELETE /api/agents/:id ──

  describe('DELETE /api/agents/:id', () => {
    it('deletes an agent', async () => {
      const { app, agentService } = createTestApp();
      agentService.delete.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'DELETE', '/api/agents/agent-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.deleted).toBe(true);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/agents/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns error when agent not found', async () => {
      const { app, agentService } = createTestApp();
      agentService.delete.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Agent not found', status: 404 },
      });

      const res = await request(app, 'DELETE', '/api/agents/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── POST /api/agents/:id/start ──

  describe('POST /api/agents/:id/start', () => {
    it('starts an agent', async () => {
      const { app, agentService } = createTestApp();
      agentService.start.mockResolvedValue({
        ok: true,
        value: { id: 'agent-1', status: 'running' },
      });

      const res = await request(app, 'POST', '/api/agents/agent-1/start', {
        taskId: 'task-1',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(agentService.start).toHaveBeenCalledWith('agent-1', 'task-1');
    });

    it('starts an agent without a taskId', async () => {
      const { app, agentService } = createTestApp();
      agentService.start.mockResolvedValue({
        ok: true,
        value: { id: 'agent-1', status: 'running' },
      });

      const res = await request(app, 'POST', '/api/agents/agent-1/start');

      expect(res.status).toBe(200);
      expect(agentService.start).toHaveBeenCalledWith('agent-1', undefined);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/agents/bad!id/start');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for invalid taskId format', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/agents/agent-1/start', {
        taskId: '../bad-id',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      // arch29-W2-H / F07-03: zod schema rejects taskIds that don't match
      // idSchema regex with VALIDATION_ERROR (was a manual INVALID_ID
      // check after raw JSON parse).
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── GET /api/agents/:id/status ──

  describe('GET /api/agents/:id/status', () => {
    it('returns agent status', async () => {
      const { app, agentService } = createTestApp();
      agentService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'agent-1', status: 'running' },
      });

      const res = await request(app, 'GET', '/api/agents/agent-1/status');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.status).toBe('running');
    });

    it('returns 404 when agent not found', async () => {
      const { app, agentService } = createTestApp();
      agentService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Agent not found', status: 404 },
      });

      const res = await request(app, 'GET', '/api/agents/nonexistent-id/status');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  // ── POST /api/agents/:id/stop ──

  describe('POST /api/agents/:id/stop', () => {
    it('stops an agent', async () => {
      const { app, agentService } = createTestApp();
      agentService.stop.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'POST', '/api/agents/agent-1/stop');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.stopped).toBe(true);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/agents/bad!id/stop');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });
  });

  // ── POST /api/agents/:id/pause ──

  describe('POST /api/agents/:id/pause', () => {
    it('pauses an agent', async () => {
      const { app, agentService } = createTestApp();
      agentService.pause.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'POST', '/api/agents/agent-1/pause');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.paused).toBe(true);
    });
  });

  // ── POST /api/agents/:id/resume ──

  describe('POST /api/agents/:id/resume', () => {
    it('resumes an agent with feedback', async () => {
      const { app, agentService } = createTestApp();
      agentService.resume.mockResolvedValue({
        ok: true,
        value: { id: 'agent-1', status: 'running' },
      });

      const res = await request(app, 'POST', '/api/agents/agent-1/resume', {
        feedback: 'Looks good, continue',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(agentService.resume).toHaveBeenCalledWith('agent-1', 'Looks good, continue');
    });

    it('resumes an agent without feedback', async () => {
      const { app, agentService } = createTestApp();
      agentService.resume.mockResolvedValue({
        ok: true,
        value: { id: 'agent-1', status: 'running' },
      });

      const res = await request(app, 'POST', '/api/agents/agent-1/resume');

      expect(res.status).toBe(200);
      expect(agentService.resume).toHaveBeenCalledWith('agent-1', undefined);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/agents/bad!id/resume');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });
  });
});
