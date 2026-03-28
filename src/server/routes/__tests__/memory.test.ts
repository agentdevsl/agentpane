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

const mockSkillMetrics = {
  id: 'sm-1',
  codespaceId: 'cs-1',
  skillId: 'skill-terraform',
  skillName: 'Terraform Apply',
  totalRuns: 25,
  successCount: 20,
  errorCount: 5,
  avgTokensUsed: 3500,
  avgTurnsUsed: 8,
  avgDurationMs: 12000,
  avgCostUsd: 0.02,
  successRate: 0.8,
  lastRunAt: '2026-03-20T10:00:00Z',
  updatedAt: '2026-03-20T10:00:00Z',
};

const mockSkillExecution = {
  id: 'exec-1',
  codespaceId: 'cs-1',
  skillId: 'skill-terraform',
  skillName: 'Terraform Apply',
  taskId: 'task-1',
  agentRunId: 'run-1',
  sessionId: 'sess-1',
  status: 'success' as const,
  turnsUsed: 10,
  tokensUsed: 4000,
  durationMs: 15000,
  filesModified: 3,
  linesAdded: 50,
  linesRemoved: 10,
  costUsd: 0.03,
  errorMessage: null,
  startedAt: '2026-03-20T09:50:00Z',
  completedAt: '2026-03-20T10:00:00Z',
  createdAt: '2026-03-20T09:50:00Z',
};

const mockDreamSession = {
  id: 'dream-1',
  codespaceId: 'cs-1',
  type: 'skill_improvement' as const,
  status: 'completed' as const,
  skillsAnalyzed: 3,
  suggestionsGenerated: 5,
  tokensUsed: 15000,
  costUsd: 0.05,
  startedAt: '2026-03-20T02:00:00Z',
  completedAt: '2026-03-20T02:05:00Z',
  errorMessage: null,
  createdAt: '2026-03-20T02:00:00Z',
};

const mockSuggestion = {
  id: 'sug-1',
  dreamSessionId: 'dream-1',
  codespaceId: 'cs-1',
  skillId: 'skill-terraform',
  skillName: 'Terraform Apply',
  suggestionType: 'improve_prompt' as const,
  title: 'Add error handling examples',
  reasoning: 'Failed runs often lack error handling patterns',
  currentContent: null,
  suggestedContent: 'Updated skill content with error handling',
  diff: null,
  status: 'pending' as const,
  userNotes: null,
  appliedAt: null,
  appliedBy: null,
  createdAt: '2026-03-20T02:05:00Z',
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

// ── Mock Skill Tracking Service ──

function createMockSkillTrackingService() {
  return {
    getMetrics: vi.fn().mockResolvedValue({ ok: true, value: [mockSkillMetrics] }),
    getExecutionHistory: vi.fn().mockResolvedValue({ ok: true, value: [mockSkillExecution] }),
  };
}

// ── Mock Dream Service ──

function createMockDreamService() {
  return {
    getDreamSessions: vi.fn().mockResolvedValue({ ok: true, value: [mockDreamSession] }),
    runDreamCycle: vi.fn().mockResolvedValue({ ok: true, value: mockDreamSession }),
    getSkillSuggestions: vi.fn().mockResolvedValue({ ok: true, value: [mockSuggestion] }),
    acceptSuggestion: vi.fn().mockResolvedValue({
      ok: true,
      value: { ...mockSuggestion, status: 'accepted' },
    }),
    rejectSuggestion: vi.fn().mockResolvedValue({
      ok: true,
      value: { ...mockSuggestion, status: 'rejected' },
    }),
    modifySuggestion: vi.fn().mockResolvedValue({
      ok: true,
      value: { ...mockSuggestion, status: 'modified', suggestedContent: 'Modified content' },
    }),
    getSkillOverrides: vi.fn().mockResolvedValue({
      'skill-terraform': { model: 'claude-opus-4-6', minRuns: 5 },
    }),
    setSkillOverride: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

// ── Test App Factory ──

function createTestApp(opts?: { available?: boolean }) {
  const memoryService = createMockMemoryService(opts);
  const skillTrackingService = createMockSkillTrackingService();
  const dreamService = createMockDreamService();
  const routes = createMemoryRoutes({
    memoryService: memoryService as never,
    skillTrackingService: skillTrackingService as never,
    dreamService: dreamService as never,
  });
  const app = new Hono();
  app.route('/api/memory', routes);
  app.onError((err, c) => {
    return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } }, 500);
  });
  return { app, memoryService, skillTrackingService, dreamService };
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

  // ── GET /api/memory/codespaces/:id/skill-metrics ──

  describe('GET /api/memory/codespaces/:id/skill-metrics', () => {
    it('returns all skill metrics for codespace', async () => {
      const { app, skillTrackingService } = createTestApp();

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/skill-metrics');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].skillId).toBe('skill-terraform');

      expect(skillTrackingService.getMetrics).toHaveBeenCalledWith('cs-1');
    });

    it('returns error when service returns err', async () => {
      const { app, skillTrackingService } = createTestApp();
      skillTrackingService.getMetrics.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/skill-metrics');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_QUERY_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, skillTrackingService } = createTestApp();
      skillTrackingService.getMetrics.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/skill-metrics');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /api/memory/codespaces/:id/skill-metrics/:skillId ──

  describe('GET /api/memory/codespaces/:id/skill-metrics/:skillId', () => {
    it('returns single skill metric (first item)', async () => {
      const { app, skillTrackingService } = createTestApp();

      const res = await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/skill-metrics/skill-terraform'
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.skillId).toBe('skill-terraform');
      expect(json.data.totalRuns).toBe(25);

      expect(skillTrackingService.getMetrics).toHaveBeenCalledWith('cs-1', 'skill-terraform');
    });

    it('returns null when no metrics exist for skill', async () => {
      const { app, skillTrackingService } = createTestApp();
      skillTrackingService.getMetrics.mockResolvedValue({ ok: true, value: [] });

      const res = await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/skill-metrics/skill-unknown'
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toBeNull();
    });

    it('returns error when service returns err', async () => {
      const { app, skillTrackingService } = createTestApp();
      skillTrackingService.getMetrics.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'DB error', status: 500 },
      });

      const res = await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/skill-metrics/skill-terraform'
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_QUERY_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, skillTrackingService } = createTestApp();
      skillTrackingService.getMetrics.mockRejectedValue(new Error('Unexpected'));

      const res = await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/skill-metrics/skill-terraform'
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /api/memory/codespaces/:id/skill-metrics/:skillId/executions ──

  describe('GET /api/memory/codespaces/:id/skill-metrics/:skillId/executions', () => {
    it('returns execution history with pagination', async () => {
      const { app, skillTrackingService } = createTestApp();

      const res = await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/skill-metrics/skill-terraform/executions?page=2&size=10'
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('exec-1');
      expect(json.pagination).toEqual({ page: 2, size: 10, hasMore: false });

      expect(skillTrackingService.getExecutionHistory).toHaveBeenCalledWith(
        'cs-1',
        'skill-terraform',
        { page: 2, size: 10 }
      );
    });

    it('defaults page=1 size=20 when not specified', async () => {
      const { app, skillTrackingService } = createTestApp();

      await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/skill-metrics/skill-terraform/executions'
      );

      expect(skillTrackingService.getExecutionHistory).toHaveBeenCalledWith(
        'cs-1',
        'skill-terraform',
        { page: 1, size: 20 }
      );
    });

    it('hasMore is true when result count equals page size', async () => {
      const { app, skillTrackingService } = createTestApp();
      const fiveExecutions = Array.from({ length: 5 }, (_, i) => ({
        ...mockSkillExecution,
        id: `exec-${i}`,
      }));
      skillTrackingService.getExecutionHistory.mockResolvedValue({
        ok: true,
        value: fiveExecutions,
      });

      const res = await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/skill-metrics/skill-terraform/executions?page=1&size=5'
      );

      const json = await res.json();
      expect(json.pagination.hasMore).toBe(true);
    });

    it('returns error when service returns err', async () => {
      const { app, skillTrackingService } = createTestApp();
      skillTrackingService.getExecutionHistory.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/skill-metrics/skill-terraform/executions'
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_QUERY_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, skillTrackingService } = createTestApp();
      skillTrackingService.getExecutionHistory.mockRejectedValue(new Error('Unexpected'));

      const res = await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/skill-metrics/skill-terraform/executions'
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /api/memory/codespaces/:id/dream-sessions ──

  describe('GET /api/memory/codespaces/:id/dream-sessions', () => {
    it('returns dream sessions with pagination', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/dream-sessions?page=1&size=10'
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('dream-1');
      expect(json.data[0].status).toBe('completed');
      expect(json.pagination).toEqual({ page: 1, size: 10, hasMore: false });

      expect(dreamService.getDreamSessions).toHaveBeenCalledWith('cs-1', { page: 1, size: 10 });
    });

    it('defaults page=1 size=20 when not specified', async () => {
      const { app, dreamService } = createTestApp();

      await request(app, 'GET', '/api/memory/codespaces/cs-1/dream-sessions');

      expect(dreamService.getDreamSessions).toHaveBeenCalledWith('cs-1', { page: 1, size: 20 });
    });

    it('hasMore is true when result count equals page size', async () => {
      const { app, dreamService } = createTestApp();
      const fiveSessions = Array.from({ length: 5 }, (_, i) => ({
        ...mockDreamSession,
        id: `dream-${i}`,
      }));
      dreamService.getDreamSessions.mockResolvedValue({ ok: true, value: fiveSessions });

      const res = await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/dream-sessions?page=1&size=5'
      );

      const json = await res.json();
      expect(json.pagination.hasMore).toBe(true);
    });

    it('returns error when service returns err', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.getDreamSessions.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/dream-sessions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_QUERY_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.getDreamSessions.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/dream-sessions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── POST /api/memory/codespaces/:id/dream ──

  describe('POST /api/memory/codespaces/:id/dream', () => {
    it('triggers dream cycle and returns 201', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/dream');

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('dream-1');
      expect(json.data.status).toBe('completed');

      expect(dreamService.runDreamCycle).toHaveBeenCalledWith('cs-1');
    });

    it('returns error when service returns err', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.runDreamCycle.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_DERIVATION_ERROR', message: 'Dream cycle failed', status: 500 },
      });

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/dream');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_DERIVATION_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.runDreamCycle.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'POST', '/api/memory/codespaces/cs-1/dream');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /api/memory/codespaces/:id/suggestions ──

  describe('GET /api/memory/codespaces/:id/suggestions', () => {
    it('returns suggestions with pagination', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/suggestions?page=1&size=10'
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('sug-1');
      expect(json.pagination).toEqual({ page: 1, size: 10, hasMore: false });

      expect(dreamService.getSkillSuggestions).toHaveBeenCalledWith(
        'cs-1',
        { status: undefined, skillId: undefined },
        { page: 1, size: 10 }
      );
    });

    it('defaults page=1 size=20 when not specified', async () => {
      const { app, dreamService } = createTestApp();

      await request(app, 'GET', '/api/memory/codespaces/cs-1/suggestions');

      expect(dreamService.getSkillSuggestions).toHaveBeenCalledWith(
        'cs-1',
        { status: undefined, skillId: undefined },
        { page: 1, size: 20 }
      );
    });

    it('passes status filter param when valid', async () => {
      const { app, dreamService } = createTestApp();

      await request(app, 'GET', '/api/memory/codespaces/cs-1/suggestions?status=pending');

      expect(dreamService.getSkillSuggestions).toHaveBeenCalledWith(
        'cs-1',
        { status: 'pending', skillId: undefined },
        { page: 1, size: 20 }
      );
    });

    it('ignores invalid status filter param', async () => {
      const { app, dreamService } = createTestApp();

      await request(app, 'GET', '/api/memory/codespaces/cs-1/suggestions?status=invalid');

      expect(dreamService.getSkillSuggestions).toHaveBeenCalledWith(
        'cs-1',
        { status: undefined, skillId: undefined },
        { page: 1, size: 20 }
      );
    });

    it('passes skillId filter param', async () => {
      const { app, dreamService } = createTestApp();

      await request(app, 'GET', '/api/memory/codespaces/cs-1/suggestions?skillId=skill-terraform');

      expect(dreamService.getSkillSuggestions).toHaveBeenCalledWith(
        'cs-1',
        { status: undefined, skillId: 'skill-terraform' },
        { page: 1, size: 20 }
      );
    });

    it('passes both status and skillId filters', async () => {
      const { app, dreamService } = createTestApp();

      await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/suggestions?status=accepted&skillId=skill-terraform'
      );

      expect(dreamService.getSkillSuggestions).toHaveBeenCalledWith(
        'cs-1',
        { status: 'accepted', skillId: 'skill-terraform' },
        { page: 1, size: 20 }
      );
    });

    it('hasMore is true when result count equals page size', async () => {
      const { app, dreamService } = createTestApp();
      const fiveSuggestions = Array.from({ length: 5 }, (_, i) => ({
        ...mockSuggestion,
        id: `sug-${i}`,
      }));
      dreamService.getSkillSuggestions.mockResolvedValue({ ok: true, value: fiveSuggestions });

      const res = await request(
        app,
        'GET',
        '/api/memory/codespaces/cs-1/suggestions?page=1&size=5'
      );

      const json = await res.json();
      expect(json.pagination.hasMore).toBe(true);
    });

    it('returns error when service returns err', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.getSkillSuggestions.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/suggestions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_QUERY_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.getSkillSuggestions.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'GET', '/api/memory/codespaces/cs-1/suggestions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── PATCH /api/memory/suggestions/:id/accept ──

  describe('PATCH /api/memory/suggestions/:id/accept', () => {
    it('accepts suggestion without body', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(app, 'PATCH', '/api/memory/suggestions/sug-1/accept');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.status).toBe('accepted');

      expect(dreamService.acceptSuggestion).toHaveBeenCalledWith('sug-1', undefined);
    });

    it('accepts suggestion with userNotes', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(app, 'PATCH', '/api/memory/suggestions/sug-1/accept', {
        userNotes: 'Looks good, apply it',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);

      expect(dreamService.acceptSuggestion).toHaveBeenCalledWith('sug-1', 'Looks good, apply it');
    });

    it('returns error when service returns err', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.acceptSuggestion.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_NOT_FOUND', message: 'Suggestion sug-1 not found', status: 404 },
      });

      const res = await request(app, 'PATCH', '/api/memory/suggestions/sug-1/accept');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_NOT_FOUND');
    });

    it('returns 500 when service throws', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.acceptSuggestion.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'PATCH', '/api/memory/suggestions/sug-1/accept');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── PATCH /api/memory/suggestions/:id/reject ──

  describe('PATCH /api/memory/suggestions/:id/reject', () => {
    it('rejects suggestion without body', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(app, 'PATCH', '/api/memory/suggestions/sug-1/reject');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.status).toBe('rejected');

      expect(dreamService.rejectSuggestion).toHaveBeenCalledWith('sug-1', undefined);
    });

    it('rejects suggestion with userNotes', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(app, 'PATCH', '/api/memory/suggestions/sug-1/reject', {
        userNotes: 'Not applicable to our workflow',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);

      expect(dreamService.rejectSuggestion).toHaveBeenCalledWith(
        'sug-1',
        'Not applicable to our workflow'
      );
    });

    it('returns error when service returns err', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.rejectSuggestion.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_NOT_FOUND', message: 'Suggestion sug-1 not found', status: 404 },
      });

      const res = await request(app, 'PATCH', '/api/memory/suggestions/sug-1/reject');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_NOT_FOUND');
    });

    it('returns 500 when service throws', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.rejectSuggestion.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'PATCH', '/api/memory/suggestions/sug-1/reject');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── PATCH /api/memory/suggestions/:id/modify ──

  describe('PATCH /api/memory/suggestions/:id/modify', () => {
    it('modifies suggestion with new content', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(app, 'PATCH', '/api/memory/suggestions/sug-1/modify', {
        modifiedContent: 'Updated skill content with better examples',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.status).toBe('modified');

      expect(dreamService.modifySuggestion).toHaveBeenCalledWith(
        'sug-1',
        'Updated skill content with better examples',
        undefined
      );
    });

    it('modifies suggestion with content and userNotes', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(app, 'PATCH', '/api/memory/suggestions/sug-1/modify', {
        modifiedContent: 'Tweaked content',
        userNotes: 'Adjusted wording',
      });

      expect(res.status).toBe(200);

      expect(dreamService.modifySuggestion).toHaveBeenCalledWith(
        'sug-1',
        'Tweaked content',
        'Adjusted wording'
      );
    });

    it('returns 400 for missing modifiedContent', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/memory/suggestions/sug-1/modify', {
        userNotes: 'some notes',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for empty modifiedContent', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/memory/suggestions/sug-1/modify', {
        modifiedContent: '',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const res = await app.request('/api/memory/suggestions/sug-1/modify', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json{',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('returns error when service returns err', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.modifySuggestion.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_NOT_FOUND', message: 'Suggestion sug-1 not found', status: 404 },
      });

      const res = await request(app, 'PATCH', '/api/memory/suggestions/sug-1/modify', {
        modifiedContent: 'New content',
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_NOT_FOUND');
    });

    it('returns 500 when service throws', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.modifySuggestion.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'PATCH', '/api/memory/suggestions/sug-1/modify', {
        modifiedContent: 'New content',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ===========================================================================
  // Global (non-codespace-scoped) endpoints — pass null as codespaceId
  // ===========================================================================

  // ── GET /api/memory/insights (global) ──

  describe('GET /api/memory/insights (global)', () => {
    it('returns insights with null codespaceId', async () => {
      const { app, memoryService } = createTestApp();

      const res = await request(app, 'GET', '/api/memory/insights?page=2&size=10');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('ins-1');
      expect(json.pagination).toEqual({ page: 2, size: 10, hasMore: false });

      expect(memoryService.getInsights).toHaveBeenCalledWith(null, { page: 2, size: 10 });
    });

    it('defaults page=1 size=50 when not specified', async () => {
      const { app, memoryService } = createTestApp();

      await request(app, 'GET', '/api/memory/insights');

      expect(memoryService.getInsights).toHaveBeenCalledWith(null, { page: 1, size: 50 });
    });

    it('returns error when service returns err', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.getInsights.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/memory/insights');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_QUERY_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.getInsights.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'GET', '/api/memory/insights');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── POST /api/memory/search (global) ──

  describe('POST /api/memory/search (global)', () => {
    it('returns search results with null codespaceId', async () => {
      const { app, memoryService } = createTestApp();

      const res = await request(app, 'POST', '/api/memory/search', {
        query: 'drizzle database',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('ins-1');
      expect(json.data[0].type).toBe('insight');

      expect(memoryService.search).toHaveBeenCalledWith(null, 'drizzle database', undefined);
    });

    it('passes limit option when provided', async () => {
      const { app, memoryService } = createTestApp();

      await request(app, 'POST', '/api/memory/search', {
        query: 'typescript',
        limit: 5,
      });

      expect(memoryService.search).toHaveBeenCalledWith(null, 'typescript', 5);
    });

    it('returns error when service returns err', async () => {
      const { app, memoryService } = createTestApp();
      memoryService.search.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(app, 'POST', '/api/memory/search', {
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

      const res = await request(app, 'POST', '/api/memory/search', {
        query: 'test',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /api/memory/skill-metrics (global) ──

  describe('GET /api/memory/skill-metrics (global)', () => {
    it('returns all skill metrics with null codespaceId', async () => {
      const { app, skillTrackingService } = createTestApp();

      const res = await request(app, 'GET', '/api/memory/skill-metrics');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].skillId).toBe('skill-terraform');

      expect(skillTrackingService.getMetrics).toHaveBeenCalledWith(null);
    });

    it('returns error when service returns err', async () => {
      const { app, skillTrackingService } = createTestApp();
      skillTrackingService.getMetrics.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/memory/skill-metrics');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_QUERY_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, skillTrackingService } = createTestApp();
      skillTrackingService.getMetrics.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'GET', '/api/memory/skill-metrics');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /api/memory/dream-sessions (global) ──

  describe('GET /api/memory/dream-sessions (global)', () => {
    it('returns dream sessions with null codespaceId', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(app, 'GET', '/api/memory/dream-sessions?page=1&size=10');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('dream-1');
      expect(json.data[0].status).toBe('completed');
      expect(json.pagination).toEqual({ page: 1, size: 10, hasMore: false });

      expect(dreamService.getDreamSessions).toHaveBeenCalledWith(null, { page: 1, size: 10 });
    });

    it('defaults page=1 size=20 when not specified', async () => {
      const { app, dreamService } = createTestApp();

      await request(app, 'GET', '/api/memory/dream-sessions');

      expect(dreamService.getDreamSessions).toHaveBeenCalledWith(null, { page: 1, size: 20 });
    });

    it('returns error when service returns err', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.getDreamSessions.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/memory/dream-sessions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_QUERY_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.getDreamSessions.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'GET', '/api/memory/dream-sessions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /api/memory/suggestions (global) ──

  describe('GET /api/memory/suggestions (global)', () => {
    it('returns suggestions with null codespaceId', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(app, 'GET', '/api/memory/suggestions?page=1&size=10');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('sug-1');
      expect(json.pagination).toEqual({ page: 1, size: 10, hasMore: false });

      expect(dreamService.getSkillSuggestions).toHaveBeenCalledWith(
        null,
        { status: undefined, skillId: undefined },
        { page: 1, size: 10 }
      );
    });

    it('defaults page=1 size=20 when not specified', async () => {
      const { app, dreamService } = createTestApp();

      await request(app, 'GET', '/api/memory/suggestions');

      expect(dreamService.getSkillSuggestions).toHaveBeenCalledWith(
        null,
        { status: undefined, skillId: undefined },
        { page: 1, size: 20 }
      );
    });

    it('passes status and skillId filter params', async () => {
      const { app, dreamService } = createTestApp();

      await request(app, 'GET', '/api/memory/suggestions?status=pending&skillId=skill-terraform');

      expect(dreamService.getSkillSuggestions).toHaveBeenCalledWith(
        null,
        { status: 'pending', skillId: 'skill-terraform' },
        { page: 1, size: 20 }
      );
    });

    it('returns error when service returns err', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.getSkillSuggestions.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/memory/suggestions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_QUERY_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.getSkillSuggestions.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'GET', '/api/memory/suggestions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /api/memory/skill-metrics/:skillId/executions (global) ──

  describe('GET /api/memory/skill-metrics/:skillId/executions (global)', () => {
    it('returns execution history with null codespaceId', async () => {
      const { app, skillTrackingService } = createTestApp();

      const res = await request(
        app,
        'GET',
        '/api/memory/skill-metrics/skill-terraform/executions?page=2&size=10'
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('exec-1');
      expect(json.pagination).toEqual({ page: 2, size: 10, hasMore: false });

      expect(skillTrackingService.getExecutionHistory).toHaveBeenCalledWith(
        null,
        'skill-terraform',
        { page: 2, size: 10 }
      );
    });

    it('defaults page=1 size=20 when not specified', async () => {
      const { app, skillTrackingService } = createTestApp();

      await request(app, 'GET', '/api/memory/skill-metrics/skill-terraform/executions');

      expect(skillTrackingService.getExecutionHistory).toHaveBeenCalledWith(
        null,
        'skill-terraform',
        { page: 1, size: 20 }
      );
    });

    it('returns error when service returns err', async () => {
      const { app, skillTrackingService } = createTestApp();
      skillTrackingService.getExecutionHistory.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_QUERY_ERROR', message: 'Query failed', status: 500 },
      });

      const res = await request(app, 'GET', '/api/memory/skill-metrics/skill-terraform/executions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_QUERY_ERROR');
    });

    it('returns 500 when service throws', async () => {
      const { app, skillTrackingService } = createTestApp();
      skillTrackingService.getExecutionHistory.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'GET', '/api/memory/skill-metrics/skill-terraform/executions');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── GET /api/memory/dream-config/skills ──

  describe('GET /api/memory/dream-config/skills', () => {
    it('returns skill overrides map', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(app, 'GET', '/api/memory/dream-config/skills');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data['skill-terraform']).toEqual({ model: 'claude-opus-4-6', minRuns: 5 });
      expect(dreamService.getSkillOverrides).toHaveBeenCalled();
    });

    it('returns 500 when service throws', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.getSkillOverrides.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'GET', '/api/memory/dream-config/skills');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ── PUT /api/memory/dream-config/skills/:skillId ──

  describe('PUT /api/memory/dream-config/skills/:skillId', () => {
    it('sets skill override', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(app, 'PUT', '/api/memory/dream-config/skills/skill-terraform', {
        model: 'claude-opus-4-6',
        minRuns: 5,
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(dreamService.setSkillOverride).toHaveBeenCalledWith('skill-terraform', {
        model: 'claude-opus-4-6',
        minRuns: 5,
      });
    });

    it('clears skill override with null body', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(
        app,
        'PUT',
        '/api/memory/dream-config/skills/skill-terraform',
        null
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(dreamService.setSkillOverride).toHaveBeenCalledWith('skill-terraform', null);
    });

    it('clears skill override with empty object body (client null-coalesce fallback)', async () => {
      const { app, dreamService } = createTestApp();

      const res = await request(app, 'PUT', '/api/memory/dream-config/skills/skill-terraform', {});

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(dreamService.setSkillOverride).toHaveBeenCalledWith('skill-terraform', null);
    });

    it('returns error when service returns err', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.setSkillOverride.mockResolvedValue({
        ok: false,
        error: { code: 'MEMORY_SERVICE_ERROR', message: 'Failed to save', status: 500 },
      });

      const res = await request(app, 'PUT', '/api/memory/dream-config/skills/skill-terraform', {
        enabled: false,
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MEMORY_SERVICE_ERROR');
    });

    it('returns 400 for invalid JSON', async () => {
      const { app } = createTestApp();

      const res = await app.request('/api/memory/dream-config/skills/skill-terraform', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_JSON');
    });

    it('returns 500 when service throws', async () => {
      const { app, dreamService } = createTestApp();
      dreamService.setSkillOverride.mockRejectedValue(new Error('Unexpected'));

      const res = await request(app, 'PUT', '/api/memory/dream-config/skills/skill-terraform', {
        enabled: true,
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INTERNAL_ERROR');
    });
  });
});
