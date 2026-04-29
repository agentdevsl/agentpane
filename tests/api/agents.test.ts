import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/db/schema';
import { AgentErrors } from '../../src/lib/errors/agent-errors.js';
import { err, ok } from '../../src/lib/utils/result.js';
import { createAgentsRoutes } from '../../src/server/routes/agents.js';

const agentServiceMocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

let app: ReturnType<typeof createAgentsRoutes>;

const sampleAgent: Agent = {
  id: 'agent-1',
  codespaceId: 'proj-1',
  name: 'Test Agent',
  type: 'task',
  status: 'idle',
  config: { allowedTools: [], maxTurns: 50 },
  currentTaskId: null,
  currentSessionId: null,
  currentTurn: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const jsonRequest = (body: unknown, init?: RequestInit) => ({
  ...init,
  method: init?.method ?? 'POST',
  headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  body: JSON.stringify(body),
});

describe('Agent API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    app = createAgentsRoutes({
      agentService: agentServiceMocks as never,
      db: {} as never,
    });
  });

  it('lists agents for a project', async () => {
    agentServiceMocks.list.mockResolvedValue(ok([sampleAgent]));

    const response = await app.request('/?codespaceId=az2h33gpcldsq0a0wdimza6m');

    expect(response.status).toBe(200);
    const data = (await response.json()) as { ok: true; data: Agent[] };
    expect(data.data).toHaveLength(1);
  });

  it('validates agent list query', async () => {
    const response = await app.request('/');

    expect(response.status).toBe(400);
    const data = (await response.json()) as { ok: false; error: { code: string } };
    expect(data.error.code).toBe('MISSING_PARAMS');
  });

  it('creates an agent', async () => {
    agentServiceMocks.create.mockResolvedValue(ok(sampleAgent));

    const response = await app.request(
      '/',
      jsonRequest({
        codespaceId: 'az2h33gpcldsq0a0wdimza6m',
        name: 'Test Agent',
        type: 'task',
      })
    );

    expect(response.status).toBe(201);
    const data = (await response.json()) as { ok: true; data: Agent };
    expect(data.data.id).toBe(sampleAgent.id);
  });

  it('gets an agent by id', async () => {
    agentServiceMocks.getById.mockResolvedValue(ok(sampleAgent));

    const response = await app.request(`/agent-1`);

    expect(response.status).toBe(200);
    const data = (await response.json()) as { ok: true; data: Agent };
    expect(data.data.id).toBe(sampleAgent.id);
  });

  it('updates an agent', async () => {
    agentServiceMocks.update.mockResolvedValue(ok(sampleAgent));

    const response = await app.request(
      '/agent-1',
      jsonRequest({ config: { maxTurns: 75 } }, { method: 'PATCH' })
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as { ok: true; data: Agent };
    expect(data.data.id).toBe(sampleAgent.id);
  });

  it('deletes an agent', async () => {
    agentServiceMocks.delete.mockResolvedValue(ok(undefined));

    const response = await app.request('/agent-1', {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as { ok: true; data: { deleted: boolean } };
    expect(data.data.deleted).toBe(true);
  });

  it('starts an agent', async () => {
    agentServiceMocks.start.mockResolvedValue(
      ok({
        agent: sampleAgent,
        task: { id: 'task-1' } as never,
        session: { id: 'session-1' } as never,
        worktree: { id: 'worktree-1' } as never,
      })
    );

    const response = await app.request(
      '/agent-1/start',
      jsonRequest({
        taskId: 'az2h33gpcldsq0a0wdimza6m',
      })
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as { ok: true; data: { agent: Agent } };
    expect(data.data.agent.id).toBe(sampleAgent.id);
  });

  it('stops an agent', async () => {
    agentServiceMocks.stop.mockResolvedValue(ok(undefined));

    const response = await app.request('/agent-1/stop', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as { ok: true; data: { stopped: boolean } };
    expect(data.data.stopped).toBe(true);
  });

  it('gets agent status', async () => {
    agentServiceMocks.getById.mockResolvedValue(ok({ ...sampleAgent, status: 'running' }));

    const response = await app.request('/agent-1/status');

    expect(response.status).toBe(200);
    const data = (await response.json()) as { ok: true; data: { status: string } };
    expect(data.data.status).toBe('running');
  });

  it('returns not found when agent missing', async () => {
    agentServiceMocks.getById.mockResolvedValue(err(AgentErrors.NOT_FOUND));

    const response = await app.request('/agent-404');

    expect(response.status).toBe(404);
    const data = (await response.json()) as { ok: false; error: { code: string } };
    expect(data.error.code).toBe('AGENT_NOT_FOUND');
  });
});
