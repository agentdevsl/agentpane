import { createId } from '@paralleldrive/cuid2';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  codespaces,
  eventLog,
  eventSources,
  projectFolders,
  teamMembers,
  teamProjectFolders,
  teams,
  users,
} from '../../src/db/schema';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import type { AppError } from '../../src/lib/errors/base';
import type { Result } from '../../src/lib/utils/result';
import { createEventsRoutes, type EventsRouteDependencies } from '../../src/server/routes/events';
import { RbacService } from '../../src/services/rbac.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for event plugin system routes.
 *
 * Tests RBAC enforcement, team-scoped data isolation, event source/subscription
 * CRUD, cursor pagination, and cron source operations.
 *
 * Uses mock eventSourceService and eventSubscriptionService, but real DB
 * for team scoping checks and real RbacService for role resolution.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

function okResult<T>(value: T): Result<T, AppError> {
  return { ok: true, value } as any;
}

function errResult(code: string, message: string, status = 404): Result<never, AppError> {
  return { ok: false, error: { code, message, status } } as any;
}

function createMockEventSourceService() {
  const sources = new Map<string, any>();

  return {
    getById: vi.fn().mockImplementation(async (id: string) => {
      const source = sources.get(id);
      if (!source) return errResult('NOT_FOUND', 'Event source not found');
      return okResult(source);
    }),
    create: vi.fn().mockImplementation(async (input: any) => {
      const id = createId();
      const slug = `source-${id.slice(0, 8)}`;
      const source = {
        id,
        slug,
        teamId: input.teamId,
        name: input.name,
        type: input.type,
        webhookSecret: 'encrypted-secret',
        config: input.config ?? null,
        status: 'active',
        isEnabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sources.set(id, source);
      return okResult({ source, plaintextSecret: 'plain-secret-abc' });
    }),
    update: vi.fn().mockImplementation(async (id: string, data: any) => {
      const source = sources.get(id);
      if (!source) return errResult('NOT_FOUND', 'Event source not found');
      const updated = { ...source, ...data, updatedAt: new Date().toISOString() };
      sources.set(id, updated);
      return okResult(updated);
    }),
    delete: vi.fn().mockImplementation(async (id: string) => {
      if (!sources.has(id)) return errResult('NOT_FOUND', 'Event source not found');
      sources.delete(id);
      return okResult({ deleted: true });
    }),
    rotateSecret: vi.fn().mockImplementation(async (id: string) => {
      if (!sources.has(id)) return errResult('NOT_FOUND', 'Event source not found');
      return okResult({ newSecret: 'rotated-secret-xyz' });
    }),
    // Helper: seed a source for tests
    _seed: (source: any) => {
      sources.set(source.id, source);
    },
    _clear: () => {
      sources.clear();
    },
  };
}

function createMockEventSubscriptionService() {
  const subs = new Map<string, any>();

  return {
    getById: vi.fn().mockImplementation(async (id: string) => {
      const sub = subs.get(id);
      if (!sub) return errResult('NOT_FOUND', 'Subscription not found');
      return okResult(sub);
    }),
    create: vi.fn().mockImplementation(async (input: any) => {
      const id = createId();
      const sub = {
        id,
        ...input,
        isEnabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      subs.set(id, sub);
      return okResult(sub);
    }),
    update: vi.fn().mockImplementation(async (id: string, data: any) => {
      const sub = subs.get(id);
      if (!sub) return errResult('NOT_FOUND', 'Subscription not found');
      const updated = { ...sub, ...data, updatedAt: new Date().toISOString() };
      subs.set(id, updated);
      return okResult(updated);
    }),
    delete: vi.fn().mockImplementation(async (id: string) => {
      if (!subs.has(id)) return errResult('NOT_FOUND', 'Subscription not found');
      subs.delete(id);
      return okResult({ deleted: true });
    }),
    // Helper: seed a subscription for tests
    _seed: (sub: any) => {
      subs.set(sub.id, sub);
    },
    _clear: () => {
      subs.clear();
    },
  };
}

function createMockSchedulerService() {
  return {
    triggerManual: vi.fn().mockResolvedValue(okResult({ triggered: true })),
    pauseSource: vi.fn().mockResolvedValue(okResult({ paused: true })),
    resumeSource: vi.fn().mockResolvedValue(okResult({ resumed: true })),
    getBudgetStatus: vi.fn().mockResolvedValue({
      currentSpend: 0,
      budgetLimit: 100,
      percentUsed: 0,
    }),
  };
}

describe('Event Routes (IT-1050)', () => {
  let db: ReturnType<typeof getTestDb>;
  let rbacService: RbacService;
  let mockEventSourceService: ReturnType<typeof createMockEventSourceService>;
  let mockEventSubscriptionService: ReturnType<typeof createMockEventSubscriptionService>;
  let mockSchedulerService: ReturnType<typeof createMockSchedulerService>;

  let ownerUserId: string;
  let operatorUserId: string;
  let viewerUserId: string;
  let outsiderUserId: string;
  let teamId: string;
  let sourceId: string;
  let codespaceId: string;
  let folderId: string;

  function createApp(userId: string, authMethod: 'dev' | 'session' = 'dev') {
    const deps: EventsRouteDependencies = {
      eventSourceService: mockEventSourceService as any,
      eventSubscriptionService: mockEventSubscriptionService as any,
      db: db as any,
      rbacService,
      schedulerService: mockSchedulerService as any,
    };
    const routes = createEventsRoutes(deps);
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use('*', async (c, next) => {
      c.set('auth', { userId, authMethod });
      await next();
    });
    app.route('/api/events', routes);
    return app;
  }

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    rbacService = new RbacService(db as any);
    mockEventSourceService = createMockEventSourceService();
    mockEventSubscriptionService = createMockEventSubscriptionService();
    mockSchedulerService = createMockSchedulerService();

    // Create users
    ownerUserId = createId();
    operatorUserId = createId();
    viewerUserId = createId();
    outsiderUserId = createId();

    for (const [id, login] of [
      [ownerUserId, 'owner'],
      [operatorUserId, 'operator'],
      [viewerUserId, 'viewer'],
      [outsiderUserId, 'outsider'],
    ] as const) {
      await db.insert(users).values({
        id,
        githubId: Math.floor(Math.random() * 1000000000),
        githubLogin: `${login}-${id.slice(0, 6)}`,
        name: `${login} User`,
      });
    }

    // Create team
    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Events Team',
      slug: `events-team-${teamId.slice(0, 8)}`,
    });

    // Add members with different roles
    await db.insert(teamMembers).values([
      { teamId, userId: ownerUserId, role: 'owner' },
      { teamId, userId: operatorUserId, role: 'agent_operator' },
      { teamId, userId: viewerUserId, role: 'viewer' },
    ]);
    // outsiderUserId is NOT a member

    // Create a project folder and codespace associated with the team
    folderId = createId();
    await db.insert(projectFolders).values({
      id: folderId,
      name: 'Test Folder',
      slug: `folder-${folderId.slice(0, 8)}`,
    });

    await db.insert(teamProjectFolders).values({
      teamId,
      projectFolderId: folderId,
    });

    codespaceId = createId();
    await db.insert(codespaces).values({
      id: codespaceId,
      name: 'Test Codespace',
      path: `/tmp/test-cs-${codespaceId}`,
      projectFolderId: folderId,
    });

    // Seed an event source in the mock and in the DB
    sourceId = createId();
    const sourceData = {
      id: sourceId,
      slug: `source-${sourceId.slice(0, 8)}`,
      teamId,
      name: 'Test Webhook Source',
      type: 'generic_webhook' as const,
      webhookSecret: 'encrypted-secret',
      config: null,
      status: 'active',
      isEnabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mockEventSourceService._seed(sourceData);

    // Also insert in real DB for list query scoping
    await db.insert(eventSources).values({
      id: sourceId,
      slug: sourceData.slug,
      teamId,
      name: sourceData.name,
      type: 'generic_webhook',
    });
  });

  afterEach(async () => {
    mockEventSourceService._clear();
    mockEventSubscriptionService._clear();
    await clearTestDatabase();
  });

  // =========================================================================
  // Event Sources — RBAC
  // =========================================================================

  describe('Event Sources RBAC', () => {
    it('IT-1051: POST /sources requires agent_operator role', async () => {
      // Viewer should be denied
      const app = createApp(viewerUserId, 'session');
      const response = await app.request(
        jsonRequest('http://localhost/api/events/sources', {
          teamId,
          name: 'New Source',
          type: 'generic_webhook',
        })
      );

      const body = await response.json();
      expect(response.status).toBe(403);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('IT-1052: POST /sources succeeds for agent_operator', async () => {
      const app = createApp(operatorUserId, 'session');
      const response = await app.request(
        jsonRequest('http://localhost/api/events/sources', {
          teamId,
          name: 'Operator Source',
          type: 'generic_webhook',
        })
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.webhookSecret).toBe('plain-secret-abc');
      expect(body.data.webhookUrl).toBeDefined();
    });

    it('IT-1053: PATCH /sources/:id requires agent_operator', async () => {
      const app = createApp(viewerUserId, 'session');
      const response = await app.request(
        jsonRequest(
          `http://localhost/api/events/sources/${sourceId}`,
          { name: 'Renamed' },
          { method: 'PATCH' }
        )
      );

      expect(response.status).toBe(403);
    });

    it('IT-1054: DELETE /sources/:id requires agent_operator', async () => {
      const app = createApp(viewerUserId, 'session');
      const response = await app.request(
        new Request(`http://localhost/api/events/sources/${sourceId}`, { method: 'DELETE' })
      );

      expect(response.status).toBe(403);
    });

    it('IT-1055: outsider cannot access source in team', async () => {
      const app = createApp(outsiderUserId, 'session');
      const response = await app.request(`http://localhost/api/events/sources/${sourceId}`);

      expect(response.status).toBe(403);
    });

    it('IT-1056: POST /sources/:id/rotate-secret requires agent_operator', async () => {
      const app = createApp(viewerUserId, 'session');
      const response = await app.request(
        jsonRequest(`http://localhost/api/events/sources/${sourceId}/rotate-secret`, {})
      );

      expect(response.status).toBe(403);
    });
  });

  // =========================================================================
  // Event Sources — CRUD
  // =========================================================================

  describe('Event Sources CRUD', () => {
    it('IT-1057: GET /sources lists sources scoped to user teams', async () => {
      const app = createApp(ownerUserId, 'session');
      const response = await app.request('http://localhost/api/events/sources');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.items.length).toBeGreaterThanOrEqual(1);
      // webhookSecret should be stripped
      for (const item of body.data.items) {
        expect(item.webhookSecret).toBeUndefined();
      }
    });

    it('IT-1058: GET /sources returns empty for user with no teams', async () => {
      const app = createApp(outsiderUserId, 'session');
      const response = await app.request('http://localhost/api/events/sources');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.items).toHaveLength(0);
    });

    it('IT-1059: GET /sources filters by teamId', async () => {
      const app = createApp(ownerUserId, 'session');
      const response = await app.request(`http://localhost/api/events/sources?teamId=${teamId}`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });

    it('IT-1060: GET /sources returns empty for non-member with teamId filter', async () => {
      // Outsider has no team memberships, so getUserTeamIds returns []
      // The route returns empty result before reaching the teamId filter check
      const app = createApp(outsiderUserId, 'session');
      const response = await app.request(`http://localhost/api/events/sources?teamId=${teamId}`);

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.data.items).toHaveLength(0);
    });

    it('IT-1061: GET /sources validates teamId format', async () => {
      const app = createApp(ownerUserId);
      const response = await app.request('http://localhost/api/events/sources?teamId=invalid!id');

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('IT-1062: GET /sources/:id strips webhook secret', async () => {
      const app = createApp(ownerUserId, 'session');
      const response = await app.request(`http://localhost/api/events/sources/${sourceId}`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.webhookSecret).toBeUndefined();
      expect(body.data.name).toBe('Test Webhook Source');
    });

    it('IT-1063: POST /sources returns 400 for missing name', async () => {
      const app = createApp(ownerUserId);
      const response = await app.request(
        jsonRequest('http://localhost/api/events/sources', {
          teamId,
          type: 'generic_webhook',
        })
      );

      expect(response.status).toBe(400);
    });

    it('IT-1064: DELETE /sources/:id succeeds for operator', async () => {
      const app = createApp(operatorUserId, 'session');
      const response = await app.request(
        new Request(`http://localhost/api/events/sources/${sourceId}`, { method: 'DELETE' })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.deleted).toBe(true);
    });
  });

  // =========================================================================
  // Cursor Pagination
  // =========================================================================

  describe('Cursor pagination', () => {
    it('IT-1065: GET /sources supports composite cursor pagination', async () => {
      // Insert multiple sources in DB for pagination test
      for (let i = 0; i < 3; i++) {
        const srcId = createId();
        await db.insert(eventSources).values({
          id: srcId,
          slug: `src-${srcId.slice(0, 8)}`,
          teamId,
          name: `Source ${i}`,
          type: 'generic_webhook',
        });
      }

      const app = createApp(ownerUserId, 'session');
      const response = await app.request('http://localhost/api/events/sources?limit=2');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.items.length).toBeLessThanOrEqual(2);
      // If there are more items, hasMore should be true and nextCursor should exist
      if (body.data.hasMore) {
        expect(body.data.nextCursor).toBeTruthy();
        expect(body.data.nextCursor).toContain('|');
      }
    });
  });

  // =========================================================================
  // Event Subscriptions — RBAC
  // =========================================================================

  describe('Event Subscriptions RBAC', () => {
    let subId: string;

    beforeEach(() => {
      subId = createId();
      mockEventSubscriptionService._seed({
        id: subId,
        name: 'Test Sub',
        eventSourceId: sourceId,
        targetCodespaceId: codespaceId,
        promptTemplate: 'Handle event: {{event}}',
        isEnabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    it('IT-1066: POST /subscriptions requires agent_operator', async () => {
      const app = createApp(viewerUserId, 'session');
      const response = await app.request(
        jsonRequest('http://localhost/api/events/subscriptions', {
          name: 'New Sub',
          eventSourceId: sourceId,
          targetCodespaceId: codespaceId,
          promptTemplate: 'Do something',
        })
      );

      expect(response.status).toBe(403);
    });

    it('IT-1067: POST /subscriptions succeeds for agent_operator', async () => {
      const app = createApp(operatorUserId, 'session');
      const response = await app.request(
        jsonRequest('http://localhost/api/events/subscriptions', {
          name: 'Operator Sub',
          eventSourceId: sourceId,
          targetCodespaceId: codespaceId,
          promptTemplate: 'Handle: {{event}}',
        })
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });

    it('IT-1068: PATCH /subscriptions/:id requires agent_operator', async () => {
      const app = createApp(viewerUserId, 'session');
      const response = await app.request(
        jsonRequest(
          `http://localhost/api/events/subscriptions/${subId}`,
          { name: 'Renamed' },
          { method: 'PATCH' }
        )
      );

      expect(response.status).toBe(403);
    });

    it('IT-1069: DELETE /subscriptions/:id requires agent_operator', async () => {
      const app = createApp(viewerUserId, 'session');
      const response = await app.request(
        new Request(`http://localhost/api/events/subscriptions/${subId}`, { method: 'DELETE' })
      );

      expect(response.status).toBe(403);
    });

    it('IT-1070: GET /subscriptions/:id accessible to viewer', async () => {
      const app = createApp(viewerUserId, 'session');
      const response = await app.request(`http://localhost/api/events/subscriptions/${subId}`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.name).toBe('Test Sub');
    });

    it('IT-1071: outsider cannot access subscription', async () => {
      const app = createApp(outsiderUserId, 'session');
      const response = await app.request(`http://localhost/api/events/subscriptions/${subId}`);

      expect(response.status).toBe(403);
    });
  });

  // =========================================================================
  // Cron Source Operations
  // =========================================================================

  describe('Cron source operations', () => {
    it('IT-1072: POST /sources/:id/trigger requires scheduler', async () => {
      // Create app without scheduler
      const deps: EventsRouteDependencies = {
        eventSourceService: mockEventSourceService as any,
        eventSubscriptionService: mockEventSubscriptionService as any,
        db: db as any,
        rbacService,
        // No scheduler
      };
      const routes = createEventsRoutes(deps);
      const noSchedulerApp = new Hono<{ Variables: { auth: AuthContext } }>();
      noSchedulerApp.use('*', async (c, next) => {
        c.set('auth', { userId: ownerUserId, authMethod: 'dev' });
        await next();
      });
      noSchedulerApp.route('/api/events', routes);

      const response = await noSchedulerApp.request(
        jsonRequest(`http://localhost/api/events/sources/${sourceId}/trigger`, {})
      );

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('IT-1073: POST /sources/:id/trigger succeeds with scheduler', async () => {
      const app = createApp(operatorUserId, 'session');
      const response = await app.request(
        jsonRequest(`http://localhost/api/events/sources/${sourceId}/trigger`, {})
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });

    it('IT-1074: POST /sources/:id/pause requires agent_operator', async () => {
      const app = createApp(viewerUserId, 'session');
      const response = await app.request(
        jsonRequest(`http://localhost/api/events/sources/${sourceId}/pause`, {})
      );

      expect(response.status).toBe(403);
    });

    it('IT-1075: POST /sources/:id/resume requires agent_operator', async () => {
      const app = createApp(viewerUserId, 'session');
      const response = await app.request(
        jsonRequest(`http://localhost/api/events/sources/${sourceId}/resume`, {})
      );

      expect(response.status).toBe(403);
    });

    it('IT-1076: GET /sources/:id/budget requires cron type', async () => {
      // The source is type webhook, not cron
      const app = createApp(ownerUserId, 'session');
      const response = await app.request(`http://localhost/api/events/sources/${sourceId}/budget`);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('SCHEDULE_NOT_CRON_TYPE');
    });
  });

  // =========================================================================
  // Event Log
  // =========================================================================

  describe('Event Log', () => {
    it('IT-1077: GET /log scopes entries to user teams', async () => {
      // Insert a log entry for the source
      await db.insert(eventLog).values({
        id: createId(),
        eventSourceId: sourceId,
        eventType: 'push',
        status: 'received',
        payload: '{}',
        deliveryId: createId(),
      });

      const app = createApp(ownerUserId, 'session');
      const response = await app.request('http://localhost/api/events/log');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.items.length).toBeGreaterThanOrEqual(1);
    });

    it('IT-1078: GET /log returns empty for outsider', async () => {
      await db.insert(eventLog).values({
        id: createId(),
        eventSourceId: sourceId,
        eventType: 'push',
        status: 'received',
        payload: '{}',
        deliveryId: createId(),
      });

      const app = createApp(outsiderUserId, 'session');
      const response = await app.request('http://localhost/api/events/log');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.items).toHaveLength(0);
    });

    it('IT-1079: GET /log/:id returns 404 for non-existent entry', async () => {
      const app = createApp(ownerUserId);
      const response = await app.request(`http://localhost/api/events/log/${createId()}`);

      expect(response.status).toBe(404);
    });

    it('IT-1080: GET /log supports date range filters', async () => {
      const now = new Date().toISOString();
      await db.insert(eventLog).values({
        id: createId(),
        eventSourceId: sourceId,
        eventType: 'push',
        status: 'received',
        payload: '{}',
        deliveryId: createId(),
        receivedAt: now,
      });

      const app = createApp(ownerUserId, 'session');
      const response = await app.request(
        `http://localhost/api/events/log?since=${now}&eventSourceId=${sourceId}`
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });
  });

  // =========================================================================
  // SSE Stream
  // =========================================================================

  describe('SSE stream', () => {
    it('IT-1081: GET /stream requires authentication', async () => {
      // Create an app with no userId
      const deps: EventsRouteDependencies = {
        eventSourceService: mockEventSourceService as any,
        eventSubscriptionService: mockEventSubscriptionService as any,
        db: db as any,
        rbacService,
      };
      const routes = createEventsRoutes(deps);
      const noAuthApp = new Hono<{ Variables: { auth: AuthContext } }>();
      noAuthApp.use('*', async (c, next) => {
        c.set('auth', { userId: '', authMethod: 'dev' } as AuthContext);
        await next();
      });
      noAuthApp.route('/api/events', routes);

      const response = await noAuthApp.request('http://localhost/api/events/stream');

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('UNAUTHORIZED');
    });
  });

  // =========================================================================
  // Validation
  // =========================================================================

  describe('Validation', () => {
    it('IT-1082: GET /sources/:id returns 400 for invalid ID', async () => {
      const app = createApp(ownerUserId);
      const response = await app.request('http://localhost/api/events/sources/invalid!id');

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_ID');
    });

    it('IT-1083: POST /subscriptions validates required fields', async () => {
      const app = createApp(ownerUserId);
      const response = await app.request(
        jsonRequest('http://localhost/api/events/subscriptions', {
          name: 'Missing fields',
        })
      );

      expect(response.status).toBe(400);
    });

    it('IT-1084: GET /sources validates type filter', async () => {
      const app = createApp(ownerUserId);
      const response = await app.request('http://localhost/api/events/sources?type=invalid_type');

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
