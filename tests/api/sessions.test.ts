import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/db/schema';
import { CodespaceErrors } from '../../src/lib/errors/codespace-errors.js';
import { SessionErrors } from '../../src/lib/errors/session-errors.js';
import { err, ok } from '../../src/lib/utils/result.js';

const sessionServiceMocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  close: vi.fn(),
  delete: vi.fn(),
  updatePresence: vi.fn(),
  getActiveUsers: vi.fn(),
  getHistory: vi.fn(),
  getEventsBySession: vi.fn(),
  getSessionSummary: vi.fn(),
  subscribe: vi.fn(),
}));

import { createSessionsRoutes } from '../../src/server/routes/sessions.js';

const sampleSession: Session = {
  id: 'session-1',
  codespaceId: 'proj-1',
  taskId: null,
  agentId: null,
  status: 'active',
  title: null,
  url: 'http://localhost:5173/sessions/session-1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  closedAt: null,
};

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

const parseJson = async <T>(response: Response): Promise<T> => {
  return (await response.json()) as T;
};

describe('Session API', () => {
  let app: ReturnType<typeof createSessionsRoutes>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createSessionsRoutes({
      sessionService: sessionServiceMocks as never,
    });
  });

  it('lists sessions', async () => {
    sessionServiceMocks.list.mockResolvedValue(ok([sampleSession]));
    // Mock getSessionSummary for enrichment (called for each session)
    sessionServiceMocks.getSessionSummary.mockResolvedValue(
      ok({ turnsCount: 0, tokensUsed: 0, filesModified: 0, linesAdded: 0, linesRemoved: 0 })
    );

    const response = await app.request('http://localhost/');

    expect(response?.status).toBe(200);
    const result = await parseJson<{ ok: true; data: Session[]; pagination: unknown }>(
      response as Response
    );
    expect(result.data).toHaveLength(1);
  });

  it('creates a session', async () => {
    sessionServiceMocks.create.mockResolvedValue(ok({ ...sampleSession, status: 'active' }));

    const response = await app.request(
      jsonRequest('http://localhost/', {
        codespaceId: 'az2h33gpcldsq0a0wdimza6m',
      })
    );

    expect(response?.status).toBe(201);
    const data = await parseJson<{ ok: true; data: Session }>(response as Response);
    expect(data.data.id).toBe(sampleSession.id);
  });

  it('returns not found when project missing', async () => {
    sessionServiceMocks.create.mockResolvedValue(err(CodespaceErrors.NOT_FOUND));

    const response = await app.request(
      jsonRequest('http://localhost/', {
        codespaceId: 'az2h33gpcldsq0a0wdimza6m',
      })
    );

    expect(response?.status).toBe(404);
    const data = await parseJson<{ ok: false; error: { code: string } }>(response as Response);
    expect(data.error.code).toBe('CODESPACE_NOT_FOUND');
  });

  it('gets a session by id', async () => {
    sessionServiceMocks.getById.mockResolvedValue(ok(sampleSession));

    const response = await app.request(`http://localhost/${sampleSession.id}`);

    expect(response?.status).toBe(200);
    const data = await parseJson<{ ok: true; data: Session }>(response as Response);
    expect(data.data.id).toBe(sampleSession.id);
  });

  it('closes a session', async () => {
    sessionServiceMocks.close.mockResolvedValue(ok({ ...sampleSession, status: 'closed' }));

    sessionServiceMocks.delete.mockResolvedValue(ok({ deleted: true }));

    const response = await app.request(`http://localhost/${sampleSession.id}`, {
      method: 'DELETE',
    });

    expect(response?.status).toBe(200);
    const data = await parseJson<{ ok: true; data: { deleted: boolean } }>(response as Response);
    expect(data.data.deleted).toBe(true);
  });

  it.skip('updates presence', async () => {
    sessionServiceMocks.updatePresence.mockResolvedValue(ok(undefined));
    sessionServiceMocks.getById.mockResolvedValue(ok(sampleSession));

    const response = await app.request(
      `http://localhost/${sampleSession.id}/presence`,
      jsonRequest(`http://localhost/${sampleSession.id}/presence`, {
        userId: 'user-1',
        cursor: { x: 1, y: 2 },
      })
    );

    expect(response?.status).toBe(200);
    const data = await parseJson<{ ok: true; data: { updated: boolean } }>(response as Response);
    expect(data.data.updated).toBe(true);
  });

  it.skip('returns presence', async () => {
    sessionServiceMocks.getActiveUsers.mockResolvedValue(
      ok([
        {
          userId: 'user-1',
          lastSeen: 123,
          cursor: { x: 1, y: 2 },
        },
      ])
    );
    sessionServiceMocks.getById.mockResolvedValue(ok(sampleSession));

    const response = await app.request(`http://localhost/${sampleSession.id}/presence`);

    expect(response?.status).toBe(200);
    const data = await parseJson<{ ok: true; data: { userId: string }[] }>(response as Response);
    expect(data.data).toHaveLength(1);
  });

  it('returns history events', async () => {
    sessionServiceMocks.getEventsBySession.mockResolvedValue(ok([{ id: 'evt-1' }] as never));

    const response = await app.request(`http://localhost/${sampleSession.id}/events`);

    expect(response?.status).toBe(200);
    const data = await parseJson<{ ok: true; data: unknown[] }>(response as Response);
    expect(data.data).toHaveLength(1);
  });

  it('returns not found when session missing', async () => {
    sessionServiceMocks.getById.mockResolvedValue(err(SessionErrors.NOT_FOUND));

    const response = await app.request('http://localhost/missing');

    expect(response?.status).toBe(404);
    const data = await parseJson<{ ok: false; error: { code: string } }>(response as Response);
    expect(data.error.code).toBe('SESSION_NOT_FOUND');
  });
});
