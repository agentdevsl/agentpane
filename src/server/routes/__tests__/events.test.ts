import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { EventsRouteDependencies } from '../events.js';
import { createEventsRoutes } from '../events.js';

// ── Mock Services ──

function createMockEventSourceService() {
  return {
    list: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    rotateSecret: vi.fn(),
  };
}

function createMockEventSubscriptionService() {
  return {
    list: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function createMockRbacService() {
  return {
    resolveTeamRole: vi.fn().mockResolvedValue('admin'),
    hasMinimumRole: vi.fn().mockReturnValue(true),
    resolveUserRole: vi.fn().mockResolvedValue('admin'),
  };
}

function createMockSchedulerService() {
  return {
    triggerManual: vi.fn(),
    pauseSource: vi.fn(),
    resumeSource: vi.fn(),
    getBudgetStatus: vi.fn(),
  };
}

function createMockDb() {
  // Create a thenable query builder that resolves to [] when awaited at any point in the chain
  function createQueryBuilder(): Record<string, unknown> {
    const builder: Record<string, unknown> = {};
    const methods = ['from', 'where', 'orderBy', 'limit'];
    for (const method of methods) {
      builder[method] = vi.fn().mockReturnValue(builder);
    }
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable mock for Drizzle query chain
    builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
    return builder;
  }

  const selectResult = createQueryBuilder();

  return {
    select: vi.fn().mockReturnValue(selectResult),
    query: {
      settings: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    _selectResult: selectResult,
  };
}

// ── Auth Middleware ──

const devAuth = {
  authMethod: 'dev' as const,
  userId: 'user-1',
  teamMemberships: [{ teamId: 'team-1', role: 'admin' }],
};

// ── Test App Factory ──

function createTestApp(overrides?: Partial<EventsRouteDependencies>) {
  const eventSourceService = createMockEventSourceService();
  const eventSubscriptionService = createMockEventSubscriptionService();
  const rbacService = createMockRbacService();
  const schedulerService = createMockSchedulerService();
  const db = createMockDb();

  const deps: EventsRouteDependencies = {
    eventSourceService: eventSourceService as never,
    eventSubscriptionService: eventSubscriptionService as never,
    db: db as never,
    rbacService: rbacService as never,
    schedulerService: schedulerService as never,
    ...overrides,
  };

  const routes = createEventsRoutes(deps);
  const app = new Hono();

  // Inject auth middleware
  app.use('/api/events/*', async (c, next) => {
    c.set('auth' as never, devAuth as never);
    await next();
  });

  app.route('/api/events', routes);

  return {
    app,
    eventSourceService,
    eventSubscriptionService,
    rbacService,
    schedulerService,
    db,
  };
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

describe('Events API Routes', () => {
  // =========================================================================
  // Event Sources
  // =========================================================================

  describe('GET /api/events/sources', () => {
    it('returns empty list when user has no teams', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/events/sources');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      // devAuth has teamMemberships so the DB query for sources may return []
      expect(json.data.items).toEqual([]);
    });

    it('returns 400 for invalid teamId filter', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/events/sources?teamId=bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid type filter', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/events/sources?type=invalid_type');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid status filter', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/events/sources?status=bogus');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/events/sources/:id', () => {
    it('returns an event source by id', async () => {
      const { app, eventSourceService } = createTestApp();
      const source = { id: 'src-1', name: 'GitHub Source', type: 'github', teamId: 'team-1' };
      eventSourceService.getById.mockResolvedValue({ ok: true, value: source });

      const res = await request(app, 'GET', '/api/events/sources/src-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('src-1');
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/events/sources/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns error when source not found', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Not found', status: 404 },
      });

      const res = await request(app, 'GET', '/api/events/sources/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('strips webhook secret from response', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.getById.mockResolvedValue({
        ok: true,
        value: {
          id: 'src-1',
          name: 'Source',
          teamId: 'team-1',
          webhookSecret: 'super-secret',
        },
      });

      const res = await request(app, 'GET', '/api/events/sources/src-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.webhookSecret).toBeUndefined();
    });

    it('returns 500 when service throws', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.getById.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'GET', '/api/events/sources/src-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });

  describe('POST /api/events/sources', () => {
    it('creates an event source and returns 201', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.create.mockResolvedValue({
        ok: true,
        value: {
          source: {
            id: 'src-new',
            name: 'New Source',
            type: 'github',
            teamId: 'team-1',
            slug: 'new-source',
          },
          plaintextSecret: 'whsec_abc123',
        },
      });

      const res = await request(app, 'POST', '/api/events/sources', {
        teamId: 'team-1',
        name: 'New Source',
        type: 'github',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('src-new');
      expect(json.data.webhookSecret).toBe('whsec_abc123');
      expect(json.data.webhookUrl).toBe('/hooks/events/new-source');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      };
      const res = await app.request('/api/events/sources', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 400 when required fields are missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/events/sources', {
        teamId: 'team-1',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns error when service create fails', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.create.mockResolvedValue({
        ok: false,
        error: { code: 'DUPLICATE', message: 'Already exists', status: 409 },
      });

      const res = await request(app, 'POST', '/api/events/sources', {
        teamId: 'team-1',
        name: 'Source',
        type: 'github',
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 500 when service throws', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.create.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'POST', '/api/events/sources', {
        teamId: 'team-1',
        name: 'Source',
        type: 'github',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });

  describe('PATCH /api/events/sources/:id', () => {
    it('updates an event source', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'src-1', teamId: 'team-1' },
      });
      eventSourceService.update.mockResolvedValue({
        ok: true,
        value: { id: 'src-1', name: 'Updated Source', teamId: 'team-1' },
      });

      const res = await request(app, 'PATCH', '/api/events/sources/src-1', {
        name: 'Updated Source',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.name).toBe('Updated Source');
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/events/sources/bad!id', {
        name: 'Updated',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for empty update body', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/events/sources/src-1', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 500 when service throws', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.getById.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'PATCH', '/api/events/sources/src-1', {
        name: 'Updated',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });

  describe('DELETE /api/events/sources/:id', () => {
    it('deletes an event source', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'src-1', teamId: 'team-1' },
      });
      eventSourceService.delete.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'DELETE', '/api/events/sources/src-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.deleted).toBe(true);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/events/sources/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when source not found', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Not found', status: 404 },
      });

      const res = await request(app, 'DELETE', '/api/events/sources/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 500 when service throws', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.getById.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'DELETE', '/api/events/sources/src-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });

  describe('POST /api/events/sources/:id/rotate-secret', () => {
    it('rotates webhook secret', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'src-1', teamId: 'team-1' },
      });
      eventSourceService.rotateSecret.mockResolvedValue({
        ok: true,
        value: { secret: 'new-secret' },
      });

      const res = await request(app, 'POST', '/api/events/sources/src-1/rotate-secret');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/events/sources/bad!id/rotate-secret');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });
  });

  // =========================================================================
  // Schedule-Specific Endpoints
  // =========================================================================

  describe('POST /api/events/sources/:id/trigger', () => {
    it('triggers a cron source manually', async () => {
      const { app, eventSourceService, schedulerService } = createTestApp();
      eventSourceService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'src-1', teamId: 'team-1', type: 'cron' },
      });
      schedulerService.triggerManual.mockResolvedValue({
        ok: true,
        value: { triggered: true },
      });

      const res = await request(app, 'POST', '/api/events/sources/src-1/trigger');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/events/sources/bad!id/trigger');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 503 when scheduler service not available', async () => {
      const { app } = createTestApp({ schedulerService: undefined });

      const res = await request(app, 'POST', '/api/events/sources/src-1/trigger');

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('SERVICE_UNAVAILABLE');
    });
  });

  describe('POST /api/events/sources/:id/pause', () => {
    it('pauses a cron source', async () => {
      const { app, eventSourceService, schedulerService } = createTestApp();
      eventSourceService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'src-1', teamId: 'team-1', type: 'cron' },
      });
      schedulerService.pauseSource.mockResolvedValue({
        ok: true,
        value: { paused: true },
      });

      const res = await request(app, 'POST', '/api/events/sources/src-1/pause');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
    });

    it('returns 503 when scheduler not available', async () => {
      const { app } = createTestApp({ schedulerService: undefined });

      const res = await request(app, 'POST', '/api/events/sources/src-1/pause');

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error.code).toBe('SERVICE_UNAVAILABLE');
    });
  });

  describe('POST /api/events/sources/:id/resume', () => {
    it('resumes a cron source', async () => {
      const { app, eventSourceService, schedulerService } = createTestApp();
      eventSourceService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'src-1', teamId: 'team-1', type: 'cron' },
      });
      schedulerService.resumeSource.mockResolvedValue({
        ok: true,
        value: { resumed: true },
      });

      const res = await request(app, 'POST', '/api/events/sources/src-1/resume');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/events/sources/bad!id/resume');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });
  });

  describe('GET /api/events/sources/:id/budget', () => {
    it('returns budget status for a cron source', async () => {
      const { app, eventSourceService, schedulerService } = createTestApp();
      eventSourceService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'src-1', teamId: 'team-1', type: 'cron', config: { budget: 100 } },
      });
      schedulerService.getBudgetStatus.mockResolvedValue({
        used: 50,
        remaining: 50,
        limit: 100,
      });

      const res = await request(app, 'GET', '/api/events/sources/src-1/budget');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.used).toBe(50);
    });

    it('returns 400 for non-cron source', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'src-1', teamId: 'team-1', type: 'github', config: {} },
      });

      const res = await request(app, 'GET', '/api/events/sources/src-1/budget');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('SCHEDULE_NOT_CRON_TYPE');
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/events/sources/bad!id/budget');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });
  });

  // =========================================================================
  // Subscriptions
  // =========================================================================

  describe('GET /api/events/subscriptions/:id', () => {
    it('returns a subscription by id', async () => {
      const { app, eventSubscriptionService, eventSourceService } = createTestApp();
      eventSubscriptionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sub-1', eventSourceId: 'src-1', name: 'My Sub' },
      });
      eventSourceService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'src-1', teamId: 'team-1' },
      });

      const res = await request(app, 'GET', '/api/events/subscriptions/sub-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('sub-1');
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/events/subscriptions/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when subscription not found', async () => {
      const { app, eventSubscriptionService } = createTestApp();
      eventSubscriptionService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Not found', status: 404 },
      });

      const res = await request(app, 'GET', '/api/events/subscriptions/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  describe('POST /api/events/subscriptions', () => {
    it('creates a subscription and returns 201', async () => {
      const { app, eventSourceService, eventSubscriptionService } = createTestApp();
      eventSourceService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'src-1', teamId: 'team-1' },
      });
      eventSubscriptionService.create.mockResolvedValue({
        ok: true,
        value: { id: 'sub-new', name: 'New Sub', eventSourceId: 'src-1' },
      });

      const res = await request(app, 'POST', '/api/events/subscriptions', {
        name: 'New Sub',
        eventSourceId: 'src-1',
        targetCodespaceId: 'proj-1',
        promptTemplate: 'Create a task for: {{event}}',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('sub-new');
    });

    it('returns 400 when required fields missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/events/subscriptions', {
        name: 'Sub',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns error when source not found', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Source not found', status: 404 },
      });

      const res = await request(app, 'POST', '/api/events/subscriptions', {
        name: 'Sub',
        eventSourceId: 'nonexistent',
        targetCodespaceId: 'proj-1',
        promptTemplate: 'Create task',
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 500 when service throws', async () => {
      const { app, eventSourceService } = createTestApp();
      eventSourceService.getById.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'POST', '/api/events/subscriptions', {
        name: 'Sub',
        eventSourceId: 'src-1',
        targetCodespaceId: 'proj-1',
        promptTemplate: 'Create task',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error.code).toBe('DB_ERROR');
    });
  });

  describe('PATCH /api/events/subscriptions/:id', () => {
    it('updates a subscription', async () => {
      const { app, eventSubscriptionService, eventSourceService } = createTestApp();
      eventSubscriptionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sub-1', eventSourceId: 'src-1' },
      });
      eventSourceService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'src-1', teamId: 'team-1' },
      });
      eventSubscriptionService.update.mockResolvedValue({
        ok: true,
        value: { id: 'sub-1', name: 'Updated Sub' },
      });

      const res = await request(app, 'PATCH', '/api/events/subscriptions/sub-1', {
        name: 'Updated Sub',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.name).toBe('Updated Sub');
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/events/subscriptions/bad!id', {
        name: 'Updated',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for empty update body', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/events/subscriptions/sub-1', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });
  });

  describe('DELETE /api/events/subscriptions/:id', () => {
    it('deletes a subscription', async () => {
      const { app, eventSubscriptionService, eventSourceService } = createTestApp();
      eventSubscriptionService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'sub-1', eventSourceId: 'src-1' },
      });
      eventSourceService.getById.mockResolvedValue({
        ok: true,
        value: { id: 'src-1', teamId: 'team-1' },
      });
      eventSubscriptionService.delete.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'DELETE', '/api/events/subscriptions/sub-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.deleted).toBe(true);
    });

    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/events/subscriptions/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when subscription not found', async () => {
      const { app, eventSubscriptionService } = createTestApp();
      eventSubscriptionService.getById.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Not found', status: 404 },
      });

      const res = await request(app, 'DELETE', '/api/events/subscriptions/nonexistent-id');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 500 when service throws', async () => {
      const { app, eventSubscriptionService } = createTestApp();
      eventSubscriptionService.getById.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'DELETE', '/api/events/subscriptions/sub-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error.code).toBe('DB_ERROR');
    });
  });

  // =========================================================================
  // Event Log
  // =========================================================================

  describe('GET /api/events/log/:id', () => {
    it('returns 400 for invalid id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/events/log/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });
  });

  // =========================================================================
  // SSE Stream
  // =========================================================================

  describe('GET /api/events/stream', () => {
    it('returns SSE stream with correct content type', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/events/stream');

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
    });
  });
});
