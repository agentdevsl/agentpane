import { createId } from '@paralleldrive/cuid2';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codespaces, projectFolders, sessionEvents, tasks } from '../../src/db/schema';
import { createMemoryRoutes } from '../../src/server/routes/memory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for memory API routes.
 *
 * Tests global and codespace-scoped insight CRUD, search, skill metrics,
 * dream sessions, suggestions, injection history (real DB), pagination,
 * and the legacy redirect.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

function patchRequest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function createMockMemoryService() {
  return {
    getInsights: vi.fn(),
    createInsight: vi.fn(),
    deleteInsight: vi.fn(),
    approveInsight: vi.fn(),
    rejectInsight: vi.fn(),
    search: vi.fn(),
    healthCheck: vi.fn(),
  };
}

function createMockSkillTrackingService() {
  return {
    getMetrics: vi.fn(),
    getExecutionHistory: vi.fn(),
  };
}

function createMockDreamService() {
  return {
    getDreamSessions: vi.fn(),
    runDreamCycle: vi.fn(),
    getSkillSuggestions: vi.fn(),
    acceptSuggestion: vi.fn(),
    rejectSuggestion: vi.fn(),
    modifySuggestion: vi.fn(),
    getSkillOverrides: vi.fn(),
    setSkillOverride: vi.fn(),
  };
}

describe('Memory Routes (IT-1200)', () => {
  let app: Hono;
  let db: ReturnType<typeof getTestDb>;
  let mockMemory: ReturnType<typeof createMockMemoryService>;
  let mockSkillTracking: ReturnType<typeof createMockSkillTrackingService>;
  let mockDream: ReturnType<typeof createMockDreamService>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    mockMemory = createMockMemoryService();
    mockSkillTracking = createMockSkillTrackingService();
    mockDream = createMockDreamService();

    app = createMemoryRoutes({
      memoryService: mockMemory as any,
      skillTrackingService: mockSkillTracking as any,
      dreamService: mockDream as any,
      db: db as any,
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
    vi.clearAllMocks();
  });

  // ─── GET /insights (global) ────────────────────────────

  it('IT-1200: GET /insights returns paginated insights list', async () => {
    const mockInsights = [
      { id: 'ins-1', content: 'Pattern A', status: 'active' },
      { id: 'ins-2', content: 'Pattern B', status: 'active' },
    ];
    mockMemory.getInsights.mockResolvedValue({
      ok: true,
      value: mockInsights,
    });

    const res = await app.request('http://localhost/insights?page=1&size=20');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.size).toBe(20);
    expect(mockMemory.getInsights).toHaveBeenCalledWith(
      null,
      { page: 1, size: 20 },
      { status: undefined, category: undefined }
    );
  });

  it('IT-1201: GET /insights clamps pagination size to max 100', async () => {
    mockMemory.getInsights.mockResolvedValue({ ok: true, value: [] });

    await app.request('http://localhost/insights?size=200');

    expect(mockMemory.getInsights).toHaveBeenCalledWith(
      null,
      { page: 1, size: 100 },
      expect.any(Object)
    );
  });

  it('IT-1202: GET /insights supports status and category filters', async () => {
    mockMemory.getInsights.mockResolvedValue({ ok: true, value: [] });

    await app.request('http://localhost/insights?status=pending_review&category=pattern');

    expect(mockMemory.getInsights).toHaveBeenCalledWith(null, expect.any(Object), {
      status: 'pending_review',
      category: 'pattern',
    });
  });

  it('IT-1203: GET /insights ignores invalid status/category values', async () => {
    mockMemory.getInsights.mockResolvedValue({ ok: true, value: [] });

    await app.request('http://localhost/insights?status=bogus&category=invalid');

    expect(mockMemory.getInsights).toHaveBeenCalledWith(null, expect.any(Object), {
      status: undefined,
      category: undefined,
    });
  });

  it('IT-1204: GET /insights returns 500 on service error', async () => {
    mockMemory.getInsights.mockResolvedValue({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'DB down', status: 500 },
    });

    const res = await app.request('http://localhost/insights');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  // ─── GET /codespaces/:codespaceId/insights (scoped) ────

  it('IT-1205: GET /codespaces/:id/insights passes codespaceId', async () => {
    mockMemory.getInsights.mockResolvedValue({ ok: true, value: [] });

    await app.request('http://localhost/codespaces/cs-123/insights');

    expect(mockMemory.getInsights).toHaveBeenCalledWith(
      'cs-123',
      expect.any(Object),
      expect.any(Object)
    );
  });

  // ─── POST /codespaces/:codespaceId/insights ────────────

  it('IT-1206: POST /codespaces/:id/insights creates an insight', async () => {
    mockMemory.createInsight.mockResolvedValue({
      ok: true,
      value: { id: 'ins-new', content: 'New pattern' },
    });

    const res = await app.request(
      jsonRequest('http://localhost/codespaces/cs-123/insights', {
        content: 'New pattern',
        source: 'manual',
        tags: ['perf'],
        category: 'pattern',
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('ins-new');
  });

  it('IT-1207: POST /codespaces/:id/insights returns 400 for empty content', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/codespaces/cs-123/insights', {
        content: '',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-1208: POST /codespaces/:id/insights returns 400 for invalid JSON', async () => {
    const res = await app.request(
      new Request('http://localhost/codespaces/cs-123/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_JSON');
  });

  // ─── DELETE /insights/:insightId ───────────────────────

  it('IT-1209: DELETE /insights/:insightId deletes an insight', async () => {
    mockMemory.deleteInsight.mockResolvedValue({ ok: true, value: null });

    const insightId = 'a'.repeat(24); // valid lowercase alphanum 20-30 chars
    const res = await app.request(`http://localhost/insights/${insightId}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('IT-1210: DELETE /insights/:insightId returns 400 for invalid ID format', async () => {
    const res = await app.request('http://localhost/insights/INVALID-ID!', {
      method: 'DELETE',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Invalid insightId');
  });

  it('IT-1211: DELETE /insights/:insightId returns 400 for too-short ID', async () => {
    const res = await app.request('http://localhost/insights/abc', {
      method: 'DELETE',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  // ─── PATCH /insights/:insightId/approve & reject ───────

  it('IT-1212: PATCH /insights/:insightId/approve approves an insight', async () => {
    mockMemory.approveInsight.mockResolvedValue({
      ok: true,
      value: { id: 'a'.repeat(24), status: 'active' },
    });

    const insightId = 'a'.repeat(24);
    const res = await app.request(`http://localhost/insights/${insightId}/approve`, {
      method: 'PATCH',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('IT-1213: PATCH /insights/:insightId/reject rejects an insight', async () => {
    mockMemory.rejectInsight.mockResolvedValue({
      ok: true,
      value: { id: 'a'.repeat(24), status: 'rejected' },
    });

    const insightId = 'a'.repeat(24);
    const res = await app.request(`http://localhost/insights/${insightId}/reject`, {
      method: 'PATCH',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('IT-1214: PATCH /insights/:insightId/approve returns 400 for invalid ID', async () => {
    const res = await app.request('http://localhost/insights/BAD/approve', { method: 'PATCH' });

    expect(res.status).toBe(400);
  });

  // ─── POST /search (global) ────────────────────────────

  it('IT-1215: POST /search returns search results', async () => {
    mockMemory.search.mockResolvedValue({
      ok: true,
      value: [{ id: 'ins-1', content: 'Match', score: 0.95 }],
    });

    const res = await app.request(
      jsonRequest('http://localhost/search', {
        query: 'error handling',
        limit: 10,
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(mockMemory.search).toHaveBeenCalledWith(null, 'error handling', 10);
  });

  it('IT-1216: POST /search returns 400 for missing query', async () => {
    const res = await app.request(jsonRequest('http://localhost/search', {}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-1217: POST /search returns 400 for invalid JSON', async () => {
    const res = await app.request(
      new Request('http://localhost/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_JSON');
  });

  // ─── POST /codespaces/:id/search (scoped) ─────────────

  it('IT-1218: POST /codespaces/:id/search passes codespaceId', async () => {
    mockMemory.search.mockResolvedValue({ ok: true, value: [] });

    await app.request(
      jsonRequest('http://localhost/codespaces/cs-456/search', {
        query: 'test',
      })
    );

    expect(mockMemory.search).toHaveBeenCalledWith('cs-456', 'test', undefined);
  });

  // ─── GET /skill-metrics ───────────────────────────────

  it('IT-1219: GET /skill-metrics returns global skill metrics', async () => {
    mockSkillTracking.getMetrics.mockResolvedValue({
      ok: true,
      value: [{ skillId: 'sk-1', successRate: 0.85 }],
    });

    const res = await app.request('http://localhost/skill-metrics');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(mockSkillTracking.getMetrics).toHaveBeenCalledWith(null);
  });

  // ─── GET /codespaces/:id/skill-metrics ─────────────────

  it('IT-1220: GET /codespaces/:id/skill-metrics returns scoped metrics', async () => {
    mockSkillTracking.getMetrics.mockResolvedValue({
      ok: true,
      value: [],
    });

    const res = await app.request('http://localhost/codespaces/cs-789/skill-metrics');

    expect(res.status).toBe(200);
    expect(mockSkillTracking.getMetrics).toHaveBeenCalledWith('cs-789');
  });

  // ─── GET /codespaces/:id/skill-metrics/:skillId ────────

  it('IT-1221: GET /codespaces/:id/skill-metrics/:skillId returns single metric', async () => {
    mockSkillTracking.getMetrics.mockResolvedValue({
      ok: true,
      value: [{ skillId: 'deploy', successRate: 0.9 }],
    });

    const res = await app.request('http://localhost/codespaces/cs-789/skill-metrics/deploy');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ skillId: 'deploy', successRate: 0.9 });
  });

  it('IT-1222: GET /codespaces/:id/skill-metrics/:skillId returns null when not found', async () => {
    mockSkillTracking.getMetrics.mockResolvedValue({
      ok: true,
      value: [],
    });

    const res = await app.request('http://localhost/codespaces/cs-789/skill-metrics/nonexistent');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeNull();
  });

  // ─── Skill execution history ──────────────────────────

  it('IT-1223: GET /skill-metrics/:skillId/executions returns paginated executions', async () => {
    mockSkillTracking.getExecutionHistory.mockResolvedValue({
      ok: true,
      value: [{ id: 'exec-1' }],
    });

    const res = await app.request(
      'http://localhost/skill-metrics/deploy/executions?page=1&size=10'
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.size).toBe(10);
    expect(mockSkillTracking.getExecutionHistory).toHaveBeenCalledWith(null, 'deploy', {
      page: 1,
      size: 10,
    });
  });

  // ─── Dream sessions ───────────────────────────────────

  it('IT-1224: GET /dream-sessions returns global dream sessions', async () => {
    mockDream.getDreamSessions.mockResolvedValue({
      ok: true,
      value: [{ id: 'dream-1' }],
    });

    const res = await app.request('http://localhost/dream-sessions');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  it('IT-1225: POST /codespaces/:id/dream triggers dream cycle', async () => {
    mockDream.runDreamCycle.mockResolvedValue({
      ok: true,
      value: { id: 'dream-new', status: 'completed' },
    });

    const res = await app.request(
      new Request('http://localhost/codespaces/cs-123/dream', {
        method: 'POST',
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockDream.runDreamCycle).toHaveBeenCalledWith('cs-123');
  });

  // ─── Suggestions ──────────────────────────────────────

  it('IT-1226: GET /suggestions returns global suggestions', async () => {
    mockDream.getSkillSuggestions.mockResolvedValue({
      ok: true,
      value: [{ id: 'sug-1', status: 'pending' }],
    });

    const res = await app.request('http://localhost/suggestions?status=pending');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('IT-1227: PATCH /suggestions/:id/accept accepts a suggestion', async () => {
    mockDream.acceptSuggestion.mockResolvedValue({
      ok: true,
      value: { id: 'sug-1', status: 'accepted' },
    });

    const res = await app.request(
      patchRequest('http://localhost/suggestions/sug-1/accept', {
        userNotes: 'Looks good',
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockDream.acceptSuggestion).toHaveBeenCalledWith('sug-1', 'Looks good');
  });

  it('IT-1228: PATCH /suggestions/:id/reject rejects a suggestion', async () => {
    mockDream.rejectSuggestion.mockResolvedValue({
      ok: true,
      value: { id: 'sug-1', status: 'rejected' },
    });

    const res = await app.request(patchRequest('http://localhost/suggestions/sug-1/reject', {}));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockDream.rejectSuggestion).toHaveBeenCalledWith('sug-1', undefined);
  });

  it('IT-1229: PATCH /suggestions/:id/modify modifies a suggestion', async () => {
    mockDream.modifySuggestion.mockResolvedValue({
      ok: true,
      value: { id: 'sug-1', status: 'modified' },
    });

    const res = await app.request(
      patchRequest('http://localhost/suggestions/sug-1/modify', {
        modifiedContent: 'Revised insight text',
        userNotes: 'Tweaked wording',
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockDream.modifySuggestion).toHaveBeenCalledWith(
      'sug-1',
      'Revised insight text',
      'Tweaked wording'
    );
  });

  it('IT-1230: PATCH /suggestions/:id/modify returns 400 for missing modifiedContent', async () => {
    const res = await app.request(
      patchRequest('http://localhost/suggestions/sug-1/modify', {
        userNotes: 'No content',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-1231: PATCH /suggestions/:id/modify returns 400 for invalid JSON', async () => {
    const res = await app.request(
      new Request('http://localhost/suggestions/sug-1/modify', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_JSON');
  });

  // ─── Dream config skill overrides ─────────────────────

  it('IT-1232: GET /dream-config/skills returns skill overrides', async () => {
    mockDream.getSkillOverrides.mockResolvedValue([{ skillId: 'deploy', enabled: true }]);

    const res = await app.request('http://localhost/dream-config/skills');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  it('IT-1233: PUT /dream-config/skills/:skillId sets an override', async () => {
    mockDream.setSkillOverride.mockResolvedValue({ ok: true, value: null });

    const res = await app.request(
      new Request('http://localhost/dream-config/skills/deploy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, minRuns: 5 }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockDream.setSkillOverride).toHaveBeenCalledWith('deploy', {
      enabled: false,
      minRuns: 5,
    });
  });

  it('IT-1234: PUT /dream-config/skills/:skillId clears override with empty body', async () => {
    mockDream.setSkillOverride.mockResolvedValue({ ok: true, value: null });

    const res = await app.request(
      new Request('http://localhost/dream-config/skills/deploy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );

    expect(res.status).toBe(200);
    expect(mockDream.setSkillOverride).toHaveBeenCalledWith('deploy', null);
  });

  // ─── Health ───────────────────────────────────────────

  it('IT-1235: GET /health returns health status', async () => {
    mockMemory.healthCheck.mockResolvedValue({
      ok: true,
      value: { status: 'healthy', uptime: 12345 },
    });

    const res = await app.request('http://localhost/health');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('healthy');
  });

  // ─── Insight injection history (real DB) ──────────────

  it('IT-1236: GET /insights/:insightId/injections queries real DB', async () => {
    const insightId = 'a'.repeat(24);
    const codespaceId = createId();
    const taskId = createId();

    // Ensure project folder exists
    try {
      await db.insert(projectFolders).values({
        id: 'default-folder',
        name: 'Default',
        slug: 'default',
      });
    } catch (e: unknown) {
      if (!(e instanceof Error) || !e.message.includes('UNIQUE constraint failed')) throw e;
    }

    // Create codespace and task for resolving names
    await db.insert(codespaces).values({
      id: codespaceId,
      name: 'Test Codespace',
      path: `/tmp/test-${codespaceId}`,
      projectFolderId: 'default-folder',
    });

    await db.insert(tasks).values({
      id: taskId,
      codespaceId,
      title: 'Test Task Title',
      column: 'backlog',
      position: 0,
    });

    // Insert a session event with memory injection data.
    // F05-25: 'session-for-injection' is a bare ID (session-kind).
    await db.insert(sessionEvents).values({
      id: createId(),
      sessionId: 'session-for-injection',
      streamKind: 'session',
      offset: 0,
      channel: 'system',
      type: 'memory:insights_injected',
      data: {
        insightIds: [insightId],
        codespaceId,
        taskId,
        agentId: 'agent-x',
        insightCount: 1,
        tokenCount: 500,
      },
      timestamp: Date.now(),
    });

    const res = await app.request(`http://localhost/insights/${insightId}/injections`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].sessionId).toBe('session-for-injection');
    expect(body.data[0].codespaceId).toBe(codespaceId);
    expect(body.data[0].codespaceName).toBe('Test Codespace');
    expect(body.data[0].taskId).toBe(taskId);
    expect(body.data[0].taskTitle).toBe('Test Task Title');
    expect(body.data[0].insightCount).toBe(1);
    expect(body.data[0].tokenCount).toBe(500);
  });

  it('IT-1237: GET /insights/:insightId/injections returns 400 for invalid insightId', async () => {
    const res = await app.request('http://localhost/insights/BAD_ID!/injections');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Invalid insightId');
  });

  it('IT-1238: GET /insights/:insightId/injections returns empty when no matches', async () => {
    const insightId = 'b'.repeat(24);

    const res = await app.request(`http://localhost/insights/${insightId}/injections`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(0);
  });

  // ─── Legacy redirect ──────────────────────────────────

  it('IT-1239: GET /codespaces/:id/conclusions redirects to insights (301)', async () => {
    const res = await app.request('http://localhost/codespaces/cs-legacy/conclusions', {
      redirect: 'manual',
    });

    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/api/memory/codespaces/cs-legacy/insights');
  });
});
