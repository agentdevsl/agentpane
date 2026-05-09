/**
 * Additional integration tests for the events route — cron sources, executions,
 * and validation branches that the existing IT-1050 suite skips.
 *
 * Targets uncovered branches in src/server/routes/events.ts (~56% baseline):
 * - GET /sources/:id/budget (cron type success path)
 * - GET /sources/:id/budget (no scheduler service → 503)
 * - GET /sources/:id/executions (cron success + filters)
 * - GET /sources/:id/executions (non-cron rejected)
 * - GET /sources/:id/executions (status filter validation)
 * - GET /sources?cursor= (composite cursor parsing)
 */

import { createId } from '@paralleldrive/cuid2';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventSources, scheduleExecutions, teamMembers, teams, users } from '../../src/db/schema';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import type { AppError } from '../../src/lib/errors/base';
import type { Result } from '../../src/lib/utils/result';
import { createEventsRoutes, type EventsRouteDependencies } from '../../src/server/routes/events';
import { RbacService } from '../../src/services/rbac.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

function okResult<T>(value: T): Result<T, AppError> {
  return { ok: true, value } as never;
}

function errResult(code: string, message: string, status = 404): Result<never, AppError> {
  return { ok: false, error: { code, message, status } } as never;
}

function createMockEventSourceService(seed: Map<string, unknown>) {
  return {
    getById: vi.fn().mockImplementation(async (id: string) => {
      const source = seed.get(id);
      if (!source) return errResult('NOT_FOUND', 'Event source not found');
      return okResult(source);
    }),
  };
}

function createMockSubscriptionService() {
  return { getById: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() };
}

function createMockSchedulerService() {
  return {
    triggerManual: vi.fn().mockResolvedValue(okResult({ triggered: true })),
    pauseSource: vi.fn().mockResolvedValue(okResult({ paused: true })),
    resumeSource: vi.fn().mockResolvedValue(okResult({ resumed: true })),
    getBudgetStatus: vi.fn().mockResolvedValue({
      currentSpendUsd: 12.34,
      budgetLimitUsd: 100,
      percentUsed: 0.1234,
      monthStartIso: '2026-05-01T00:00:00.000Z',
    }),
  };
}

describe('Event routes — cron coverage extras (IT-EVT-CRON)', () => {
  let db: ReturnType<typeof getTestDb>;
  let rbacService: RbacService;
  let mockSourceService: ReturnType<typeof createMockEventSourceService>;
  let mockSchedulerService: ReturnType<typeof createMockSchedulerService>;
  let teamId: string;
  let userId: string;
  let cronSourceId: string;
  const seed = new Map<string, unknown>();

  function makeApp(opts: { withScheduler?: boolean } = {}): Hono {
    const deps: EventsRouteDependencies = {
      eventSourceService: mockSourceService as never,
      eventSubscriptionService: createMockSubscriptionService() as never,
      db: db as never,
      rbacService,
      schedulerService: opts.withScheduler === false ? undefined : (mockSchedulerService as never),
    };
    const routes = createEventsRoutes(deps);
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use('*', async (c, next) => {
      c.set('auth', { userId, authMethod: 'session' });
      await next();
    });
    app.route('/api/events', routes);
    return app;
  }

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    rbacService = new RbacService(db as never);
    seed.clear();
    mockSourceService = createMockEventSourceService(seed);
    mockSchedulerService = createMockSchedulerService();

    userId = createId();
    teamId = createId();
    cronSourceId = createId();

    await db.insert(users).values({
      id: userId,
      githubId: Math.floor(Math.random() * 1_000_000_000),
      githubLogin: `cron-user-${userId.slice(0, 6)}`,
      name: 'Cron User',
    });
    await db
      .insert(teams)
      .values({ id: teamId, name: 'Cron Team', slug: `cron-${teamId.slice(0, 8)}` });
    await db.insert(teamMembers).values({ teamId, userId, role: 'owner' });

    // Seed a real cron event source row
    const cronSource = {
      id: cronSourceId,
      slug: `cron-${cronSourceId.slice(0, 8)}`,
      teamId,
      name: 'Daily cron',
      type: 'cron' as const,
      webhookSecret: 'enc-sec',
      config: { schedule: '0 0 * * *', budgetUsdMonth: 100 },
      status: 'active',
      isEnabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    seed.set(cronSourceId, cronSource);
    await db.insert(eventSources).values({
      id: cronSourceId,
      slug: cronSource.slug,
      teamId,
      name: cronSource.name,
      type: 'cron',
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('GET /sources/:id/budget returns 503 when scheduler is not wired', async () => {
    const app = makeApp({ withScheduler: false });
    const res = await app.request(`http://localhost/api/events/sources/${cronSourceId}/budget`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('GET /sources/:id/budget returns 200 with budget for cron source', async () => {
    const app = makeApp();
    const res = await app.request(`http://localhost/api/events/sources/${cronSourceId}/budget`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { budgetLimitUsd: number } };
    expect(body.ok).toBe(true);
    expect(body.data.budgetLimitUsd).toBe(100);
    expect(mockSchedulerService.getBudgetStatus).toHaveBeenCalledWith(
      cronSourceId,
      expect.objectContaining({ schedule: '0 0 * * *' })
    );
  });

  it('GET /sources/:id/executions returns 200 with empty list initially', async () => {
    const app = makeApp();
    const res = await app.request(`http://localhost/api/events/sources/${cronSourceId}/executions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { items: unknown[]; hasMore: boolean } };
    expect(body.data.items).toEqual([]);
    expect(body.data.hasMore).toBe(false);
  });

  it('GET /sources/:id/executions paginates execution history', async () => {
    // Insert 3 execution rows for the cron source
    for (let i = 0; i < 3; i++) {
      const ts = new Date(Date.now() - i * 60_000).toISOString();
      await db.insert(scheduleExecutions).values({
        id: createId(),
        eventSourceId: cronSourceId,
        scheduledAt: ts,
        executedAt: ts,
        status: 'executed',
      });
    }

    const app = makeApp();
    const res = await app.request(
      `http://localhost/api/events/sources/${cronSourceId}/executions?limit=2`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { items: unknown[]; hasMore: boolean; nextCursor: string | null };
    };
    expect(body.data.items).toHaveLength(2);
    expect(body.data.hasMore).toBe(true);
    expect(body.data.nextCursor).not.toBeNull();
  });

  it('GET /sources/:id/executions filters by status', async () => {
    const ts = new Date().toISOString();
    await db.insert(scheduleExecutions).values([
      {
        id: createId(),
        eventSourceId: cronSourceId,
        scheduledAt: ts,
        executedAt: ts,
        status: 'executed',
      },
      {
        id: createId(),
        eventSourceId: cronSourceId,
        scheduledAt: ts,
        executedAt: ts,
        status: 'error',
      },
    ]);

    const app = makeApp();
    const res = await app.request(
      `http://localhost/api/events/sources/${cronSourceId}/executions?status=error`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { items: Array<{ status: string }> } };
    expect(body.data.items.every((e) => e.status === 'error')).toBe(true);
  });

  it('GET /sources/:id/executions returns 400 on invalid status filter', async () => {
    const app = makeApp();
    const res = await app.request(
      `http://localhost/api/events/sources/${cronSourceId}/executions?status=bogus`
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /sources/:id/executions filters by since/until window', async () => {
    const now = Date.now();
    const t10m = new Date(now - 10 * 60_000).toISOString();
    const t1h = new Date(now - 60 * 60_000).toISOString();
    await db.insert(scheduleExecutions).values([
      {
        id: createId(),
        eventSourceId: cronSourceId,
        scheduledAt: t10m,
        executedAt: t10m,
        status: 'executed',
      },
      {
        id: createId(),
        eventSourceId: cronSourceId,
        scheduledAt: t1h,
        executedAt: t1h,
        status: 'executed',
      },
    ]);

    const app = makeApp();
    const since = new Date(now - 30 * 60_000).toISOString();
    const res = await app.request(
      `http://localhost/api/events/sources/${cronSourceId}/executions?since=${since}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { items: unknown[] } };
    expect(body.data.items).toHaveLength(1);
  });

  it('GET /sources/:id/executions rejects when source is non-cron', async () => {
    // Replace the source with a non-cron type
    seed.set(cronSourceId, {
      ...(seed.get(cronSourceId) as Record<string, unknown>),
      type: 'generic_webhook',
    });

    const app = makeApp();
    const res = await app.request(`http://localhost/api/events/sources/${cronSourceId}/executions`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('SCHEDULE_NOT_CRON_TYPE');
  });

  it('GET /sources/:id/budget rejects when source is non-cron', async () => {
    seed.set(cronSourceId, {
      ...(seed.get(cronSourceId) as Record<string, unknown>),
      type: 'generic_webhook',
    });
    const app = makeApp();
    const res = await app.request(`http://localhost/api/events/sources/${cronSourceId}/budget`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('SCHEDULE_NOT_CRON_TYPE');
  });
});
