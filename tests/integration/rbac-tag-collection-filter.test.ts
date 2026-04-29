/**
 * Integration test for F06-NEW-07 (PR W2-L).
 *
 * RED → GREEN: tag-restricted tokens used to either be 403'd from collection
 * endpoints (which forced operators to bypass the middleware) or to leak every
 * resource when the middleware was skipped. This test verifies that
 * `applyTokenTagFilter` (driven by `requireTagAccess` populating `tagFilter`
 * on the auth context) narrows list endpoints to the resources the token's
 * scope tags can actually access.
 *
 * Endpoints covered:
 *   - GET /api/codespaces (list)
 *   - GET /api/codespaces/summaries (list with summaries)
 *   - GET /api/tasks      (list, codespace-scoped)
 *   - GET /api/agents     (list, codespace-scoped)
 *   - GET /api/sessions   (filtered list with codespaceId)
 *   - GET /api/sessions   (global cursor list, no codespaceId)
 *
 * For each endpoint, we run the same request twice:
 *   1. With session auth (no tag scope) → returns ALL resources.
 *   2. With a tag-restricted api_token auth → returns only the tagged subset.
 *
 * The two-shot pattern is the regression bar: the *fix* is that case (2) is
 * smaller than case (1) for tag-restricted tokens. Without the fix, both
 * cases would be identical (which is the leak).
 *
 * Strategy: keep the services as small in-memory mocks that read from the
 * real test DB (so the filter helper, which queries the DB directly, has a
 * consistent view of seeded fixtures). The filter logic lives in
 * `applyTokenTagFilter` — invoked by the route handlers — so this test
 * exercises the production path end-to-end at the HTTP layer.
 */

import { eq } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, codespaces, projectFolders, sessions, tasks, taskTags } from '../../src/db/schema';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { ok, type Result } from '../../src/lib/utils/result';
import { createAgentsRoutes } from '../../src/server/routes/agents';
import { createCodespacesRoutes } from '../../src/server/routes/codespaces';
import { createSessionsRoutes } from '../../src/server/routes/sessions';
import { createTasksRoutes } from '../../src/server/routes/tasks';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

// ── Auth context helpers ────────────────────────────────────────────────────

const SESSION_AUTH: AuthContext = {
  userId: 'user-tagless',
  authMethod: 'session',
};

function tagRestrictedAuth(scopeTags: string[]): AuthContext {
  // Mirror the middleware: tag-restricted tokens hitting collection endpoints
  // get `tagFilter` set on the auth context.
  return {
    userId: 'user-tag-restricted',
    authMethod: 'api_token',
    tokenScope: {
      tokenId: 'tk-test',
      role: 'admin',
      codespaceId: null,
      tags: scopeTags,
    },
    tagFilter: {
      // resourceType is overwritten per-endpoint by the helper below.
      resourceType: 'codespace',
      scopeTags,
    },
  };
}

type ResourceType = NonNullable<AuthContext['tagFilter']>['resourceType'];

function authMiddleware(auth: AuthContext, resourceType?: ResourceType) {
  return async (c: Context, next: Next) => {
    const a: AuthContext = { ...auth };
    if (a.tagFilter && resourceType) {
      a.tagFilter = { ...a.tagFilter, resourceType };
    }
    c.set('auth', a);
    await next();
  };
}

// ── Mock services (delegate to real DB so the filter helper stays consistent) ─

function makeCodespaceService(db: ReturnType<typeof getTestDb>) {
  return {
    async list(): Promise<Result<unknown[], never>> {
      const rows = await db.query.codespaces.findMany();
      return ok(rows);
    },
    async listWithSummaries(): Promise<Result<unknown[], never>> {
      const rows = await db.query.codespaces.findMany();
      return ok(
        rows.map((cs) => ({
          codespace: cs,
          taskCounts: {
            backlog: 0,
            inProgress: 0,
            waitingApproval: 0,
            verified: 0,
            total: 0,
          },
          runningAgents: [],
          status: 'idle' as const,
          lastActivityAt: cs.updatedAt,
        }))
      );
    },
    async create(): Promise<Result<unknown, never>> {
      return ok({});
    },
    async update(): Promise<Result<unknown, never>> {
      return ok({});
    },
    async getById(): Promise<Result<unknown, never>> {
      return ok({});
    },
    async delete(): Promise<Result<void, never>> {
      return ok(undefined);
    },
  };
}

function makeTaskService(db: ReturnType<typeof getTestDb>) {
  return {
    async list(codespaceId: string): Promise<Result<unknown[], never>> {
      const rows = await db.query.tasks.findMany({
        where: eq(tasks.codespaceId, codespaceId),
      });
      return ok(rows);
    },
  };
}

function makeAgentService(db: ReturnType<typeof getTestDb>) {
  return {
    async list(codespaceId: string): Promise<Result<unknown[], never>> {
      const rows = await db.query.agents.findMany({
        where: eq(agents.codespaceId, codespaceId),
      });
      return ok(rows);
    },
  };
}

function makeSessionService(db: ReturnType<typeof getTestDb>) {
  return {
    async list(): Promise<Result<unknown[], never>> {
      const rows = await db.query.sessions.findMany();
      return ok(rows);
    },
    async listSessionsWithFilters(
      codespaceId: string
    ): Promise<Result<{ sessions: unknown[]; total: number }, never>> {
      const rows = await db.query.sessions.findMany({
        where: eq(sessions.codespaceId, codespaceId),
      });
      return ok({ sessions: rows, total: rows.length });
    },
    async getSessionSummary(): Promise<Result<unknown, never>> {
      return ok({
        turnsCount: 0,
        tokensUsed: 0,
        filesModified: 0,
        linesAdded: 0,
        linesRemoved: 0,
      });
    },
  };
}

// ── Test infra ──────────────────────────────────────────────────────────────

interface Fixtures {
  prodCodespaceId: string;
  stagingCodespaceId: string;
  untaggedCodespaceId: string;
  prodTaskIds: string[];
  stagingTaskIds: string[];
  untaggedTaskIds: string[];
  prodAgentIds: string[];
  stagingAgentIds: string[];
  prodSessionIds: string[];
  stagingSessionIds: string[];
  untaggedSessionIds: string[];
}

async function seedFixtures(db: ReturnType<typeof getTestDb>): Promise<Fixtures> {
  const folderId = 'default-folder';

  // Ensure folder exists (idempotent)
  await db
    .insert(projectFolders)
    .values({
      id: folderId,
      name: 'Default',
      slug: 'default',
      description: 'Test folder',
      icon: 'Folder',
      color: '#6B7280',
    })
    .onConflictDoNothing();

  // Tags carry both `team_id` (legacy NOT NULL constraint) and
  // `project_folder_id` (added by v19 migration). Use raw SQL to set both.
  // We need a team to satisfy the FK on team_id.
  execRawSql(
    `INSERT OR IGNORE INTO teams (id, name, slug, description) VALUES ('team-test', 'Test Team', 'test-team', 'fixture team');
     INSERT INTO tags (id, team_id, project_folder_id, name, color, created_at, updated_at)
       VALUES ('tag-prod', 'team-test', '${folderId}', 'production', '#10B981', datetime('now'), datetime('now')),
              ('tag-staging', 'team-test', '${folderId}', 'staging', '#F59E0B', datetime('now'), datetime('now'));`
  );

  const prodCs = 'cs-prod';
  const stagingCs = 'cs-staging';
  const untaggedCs = 'cs-untagged';

  await db.insert(codespaces).values([
    {
      id: prodCs,
      name: 'Prod',
      path: '/test/prod',
      description: 'Production',
      projectFolderId: folderId,
    },
    {
      id: stagingCs,
      name: 'Staging',
      path: '/test/staging',
      description: 'Staging',
      projectFolderId: folderId,
    },
    {
      id: untaggedCs,
      name: 'Untagged',
      path: '/test/untagged',
      description: 'No tags',
      projectFolderId: folderId,
    },
  ]);

  // codespace_tags table is missing the `assigned_at` column in the test
  // bootstrap (schema-drift, tracked separately). Insert via raw SQL.
  execRawSql(
    `INSERT INTO codespace_tags (codespace_id, tag_id)
       VALUES ('${prodCs}', 'tag-prod'), ('${stagingCs}', 'tag-staging');`
  );

  const prodTasks = ['task-prod-1', 'task-prod-2'];
  const stagingTasks = ['task-staging-1', 'task-staging-2'];
  const untaggedTasks = ['task-untagged-1'];

  await db.insert(tasks).values([
    { id: prodTasks[0], codespaceId: prodCs, title: 'P1', column: 'backlog', position: 1 },
    { id: prodTasks[1], codespaceId: prodCs, title: 'P2', column: 'backlog', position: 2 },
    { id: stagingTasks[0], codespaceId: stagingCs, title: 'S1', column: 'backlog', position: 1 },
    { id: stagingTasks[1], codespaceId: stagingCs, title: 'S2', column: 'backlog', position: 2 },
    { id: untaggedTasks[0], codespaceId: untaggedCs, title: 'U1', column: 'backlog', position: 1 },
  ]);

  const prodAgents = ['agent-prod-1', 'agent-prod-2'];
  const stagingAgents = ['agent-staging-1'];

  await db.insert(agents).values([
    { id: prodAgents[0], codespaceId: prodCs, name: 'PA1', type: 'claude', status: 'idle' },
    { id: prodAgents[1], codespaceId: prodCs, name: 'PA2', type: 'claude', status: 'idle' },
    { id: stagingAgents[0], codespaceId: stagingCs, name: 'SA1', type: 'claude', status: 'idle' },
  ]);

  const prodSessions = ['sess-prod-1'];
  const stagingSessions = ['sess-staging-1', 'sess-staging-2'];
  const untaggedSessions = ['sess-untagged-1'];

  await db.insert(sessions).values([
    {
      id: prodSessions[0],
      codespaceId: prodCs,
      taskId: prodTasks[0],
      agentId: prodAgents[0],
      title: 'PS',
      status: 'closed',
      url: '/sessions/sess-prod-1',
    },
    {
      id: stagingSessions[0],
      codespaceId: stagingCs,
      taskId: stagingTasks[0],
      agentId: stagingAgents[0],
      title: 'SS1',
      status: 'closed',
      url: '/sessions/sess-staging-1',
    },
    {
      id: stagingSessions[1],
      codespaceId: stagingCs,
      taskId: null,
      agentId: stagingAgents[0],
      title: 'SS2',
      status: 'closed',
      url: '/sessions/sess-staging-2',
    },
    {
      id: untaggedSessions[0],
      codespaceId: untaggedCs,
      taskId: untaggedTasks[0],
      agentId: null,
      title: 'US',
      status: 'closed',
      url: '/sessions/sess-untagged-1',
    },
  ]);

  return {
    prodCodespaceId: prodCs,
    stagingCodespaceId: stagingCs,
    untaggedCodespaceId: untaggedCs,
    prodTaskIds: prodTasks,
    stagingTaskIds: stagingTasks,
    untaggedTaskIds: untaggedTasks,
    prodAgentIds: prodAgents,
    stagingAgentIds: stagingAgents,
    prodSessionIds: prodSessions,
    stagingSessionIds: stagingSessions,
    untaggedSessionIds: untaggedSessions,
  };
}

describe('F06-NEW-07: tag-restricted tokens see filtered collections (PR W2-L)', () => {
  let db: ReturnType<typeof getTestDb>;
  let fixtures: Fixtures;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    fixtures = await seedFixtures(db);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ── codespaces list ────────────────────────────────────────────────────────

  it('GET /api/codespaces returns ALL codespaces for session auth (no tag scope)', async () => {
    const codespaceService = makeCodespaceService(db);
    const routes = createCodespacesRoutes({
      codespaceService: codespaceService as never,
      templateService: {} as never,
      db: db as never,
    });
    const app = new Hono();
    app.use('*', authMiddleware(SESSION_AUTH));
    app.route('/', routes);

    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { items: Array<{ id: string }> } };
    expect(body.ok).toBe(true);
    const ids = body.data.items.map((i) => i.id).sort();
    expect(ids).toEqual(
      [fixtures.prodCodespaceId, fixtures.stagingCodespaceId, fixtures.untaggedCodespaceId].sort()
    );
  });

  it('GET /api/codespaces returns ONLY tag-matching codespaces for tag-restricted token', async () => {
    const codespaceService = makeCodespaceService(db);
    const routes = createCodespacesRoutes({
      codespaceService: codespaceService as never,
      templateService: {} as never,
      db: db as never,
    });
    const app = new Hono();
    app.use('*', authMiddleware(tagRestrictedAuth(['tag-prod']), 'codespace'));
    app.route('/', routes);

    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { items: Array<{ id: string }> } };
    expect(body.ok).toBe(true);
    const ids = body.data.items.map((i) => i.id);
    expect(ids).toEqual([fixtures.prodCodespaceId]);
    expect(ids).not.toContain(fixtures.stagingCodespaceId);
    expect(ids).not.toContain(fixtures.untaggedCodespaceId);
  });

  // ── tasks list ─────────────────────────────────────────────────────────────

  it('GET /api/tasks (codespace-scoped) returns ALL tasks for session auth', async () => {
    const taskService = makeTaskService(db);
    const routes = createTasksRoutes({ taskService: taskService as never, db: db as never });
    const app = new Hono();
    app.use('*', authMiddleware(SESSION_AUTH));
    app.route('/', routes);

    const res = await app.request(`http://localhost/?codespaceId=${fixtures.prodCodespaceId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { items: Array<{ id: string }> };
    };
    expect(body.ok).toBe(true);
    const ids = body.data.items.map((i) => i.id).sort();
    expect(ids).toEqual(fixtures.prodTaskIds.sort());
  });

  it('GET /api/tasks returns ONLY tag-matching tasks for tag-restricted token', async () => {
    const taskService = makeTaskService(db);
    const routes = createTasksRoutes({ taskService: taskService as never, db: db as never });
    const app = new Hono();
    app.use('*', authMiddleware(tagRestrictedAuth(['tag-prod']), 'task'));
    app.route('/', routes);

    // Staging codespace — token sees no tasks
    const stagingRes = await app.request(
      `http://localhost/?codespaceId=${fixtures.stagingCodespaceId}`
    );
    expect(stagingRes.status).toBe(200);
    const stagingBody = (await stagingRes.json()) as {
      ok: boolean;
      data: { items: Array<{ id: string }> };
    };
    expect(stagingBody.data.items).toEqual([]);

    // Prod codespace — token sees both prod tasks
    const prodRes = await app.request(`http://localhost/?codespaceId=${fixtures.prodCodespaceId}`);
    expect(prodRes.status).toBe(200);
    const prodBody = (await prodRes.json()) as {
      ok: boolean;
      data: { items: Array<{ id: string }> };
    };
    const prodIds = prodBody.data.items.map((i) => i.id).sort();
    expect(prodIds).toEqual(fixtures.prodTaskIds.sort());

    // Untagged codespace — token sees nothing
    const untaggedRes = await app.request(
      `http://localhost/?codespaceId=${fixtures.untaggedCodespaceId}`
    );
    expect(untaggedRes.status).toBe(200);
    const untaggedBody = (await untaggedRes.json()) as {
      ok: boolean;
      data: { items: Array<{ id: string }> };
    };
    expect(untaggedBody.data.items).toEqual([]);
  });

  it('GET /api/tasks honors per-task tag overrides (direct task_tags entry)', async () => {
    // Tag a single staging task as 'tag-prod' — token scoped to 'tag-prod'
    // should see THAT task even though its parent codespace is staging.
    await db.insert(taskTags).values({
      taskId: fixtures.stagingTaskIds[0],
      tagId: 'tag-prod',
    });

    const taskService = makeTaskService(db);
    const routes = createTasksRoutes({ taskService: taskService as never, db: db as never });
    const app = new Hono();
    app.use('*', authMiddleware(tagRestrictedAuth(['tag-prod']), 'task'));
    app.route('/', routes);

    const res = await app.request(`http://localhost/?codespaceId=${fixtures.stagingCodespaceId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { items: Array<{ id: string }> };
    };
    const ids = body.data.items.map((i) => i.id);
    expect(ids).toEqual([fixtures.stagingTaskIds[0]]);
    expect(ids).not.toContain(fixtures.stagingTaskIds[1]);
  });

  // ── agents list ────────────────────────────────────────────────────────────

  it('GET /api/agents returns ALL agents for session auth', async () => {
    const agentService = makeAgentService(db);
    const routes = createAgentsRoutes({ agentService: agentService as never, db: db as never });
    const app = new Hono();
    app.use('*', authMiddleware(SESSION_AUTH));
    app.route('/', routes);

    const res = await app.request(`http://localhost/?codespaceId=${fixtures.prodCodespaceId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: Array<{ id: string }> };
    expect(body.ok).toBe(true);
    const ids = body.data.map((i) => i.id).sort();
    expect(ids).toEqual(fixtures.prodAgentIds.sort());
  });

  it('GET /api/agents returns ONLY tag-matching agents for tag-restricted token', async () => {
    const agentService = makeAgentService(db);
    const routes = createAgentsRoutes({ agentService: agentService as never, db: db as never });
    const app = new Hono();
    app.use('*', authMiddleware(tagRestrictedAuth(['tag-prod']), 'agent'));
    app.route('/', routes);

    const stagingRes = await app.request(
      `http://localhost/?codespaceId=${fixtures.stagingCodespaceId}`
    );
    expect(stagingRes.status).toBe(200);
    const stagingBody = (await stagingRes.json()) as {
      ok: boolean;
      data: Array<{ id: string }>;
    };
    expect(stagingBody.data).toEqual([]);

    const prodRes = await app.request(`http://localhost/?codespaceId=${fixtures.prodCodespaceId}`);
    expect(prodRes.status).toBe(200);
    const prodBody = (await prodRes.json()) as { ok: boolean; data: Array<{ id: string }> };
    const prodIds = prodBody.data.map((i) => i.id).sort();
    expect(prodIds).toEqual(fixtures.prodAgentIds.sort());
  });

  // ── sessions list ──────────────────────────────────────────────────────────

  it('GET /api/sessions (codespace filter) returns ALL sessions for session auth', async () => {
    const sessionService = makeSessionService(db);
    const routes = createSessionsRoutes({
      sessionService: sessionService as never,
      db: db as never,
    });
    const app = new Hono();
    app.use('*', authMiddleware(SESSION_AUTH));
    app.route('/', routes);

    const res = await app.request(`http://localhost/?codespaceId=${fixtures.stagingCodespaceId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: Array<{ id: string }> };
    expect(body.ok).toBe(true);
    const ids = body.data.map((i) => i.id).sort();
    expect(ids).toEqual(fixtures.stagingSessionIds.sort());
  });

  it('GET /api/sessions (codespace filter) returns ONLY tag-matching sessions for tag-restricted token', async () => {
    const sessionService = makeSessionService(db);
    const routes = createSessionsRoutes({
      sessionService: sessionService as never,
      db: db as never,
    });
    const app = new Hono();
    app.use('*', authMiddleware(tagRestrictedAuth(['tag-prod']), 'session'));
    app.route('/', routes);

    const stagingRes = await app.request(
      `http://localhost/?codespaceId=${fixtures.stagingCodespaceId}`
    );
    expect(stagingRes.status).toBe(200);
    const stagingBody = (await stagingRes.json()) as {
      ok: boolean;
      data: Array<{ id: string }>;
    };
    expect(stagingBody.data).toEqual([]);

    const prodRes = await app.request(`http://localhost/?codespaceId=${fixtures.prodCodespaceId}`);
    expect(prodRes.status).toBe(200);
    const prodBody = (await prodRes.json()) as { ok: boolean; data: Array<{ id: string }> };
    const prodIds = prodBody.data.map((i) => i.id).sort();
    expect(prodIds).toEqual(fixtures.prodSessionIds.sort());
  });

  it('GET /api/sessions (global, no codespaceId) returns ONLY tag-matching sessions for tag-restricted token', async () => {
    const sessionService = makeSessionService(db);
    const routes = createSessionsRoutes({
      sessionService: sessionService as never,
      db: db as never,
    });

    // 1. session auth → all sessions
    const allApp = new Hono();
    allApp.use('*', authMiddleware(SESSION_AUTH));
    allApp.route('/', routes);
    const allRes = await allApp.request('http://localhost/');
    const allBody = (await allRes.json()) as { ok: boolean; data: Array<{ id: string }> };
    const allIds = new Set(allBody.data.map((i) => i.id));
    expect(allIds.has(fixtures.prodSessionIds[0])).toBe(true);
    expect(allIds.has(fixtures.stagingSessionIds[0])).toBe(true);
    expect(allIds.has(fixtures.untaggedSessionIds[0])).toBe(true);

    // 2. tag-restricted token → only prod sessions
    const filteredApp = new Hono();
    filteredApp.use('*', authMiddleware(tagRestrictedAuth(['tag-prod']), 'session'));
    filteredApp.route('/', routes);
    const filteredRes = await filteredApp.request('http://localhost/');
    const filteredBody = (await filteredRes.json()) as {
      ok: boolean;
      data: Array<{ id: string }>;
    };
    const filteredIds = filteredBody.data.map((i) => i.id);
    expect(filteredIds).toContain(fixtures.prodSessionIds[0]);
    expect(filteredIds).not.toContain(fixtures.stagingSessionIds[0]);
    expect(filteredIds).not.toContain(fixtures.stagingSessionIds[1]);
    expect(filteredIds).not.toContain(fixtures.untaggedSessionIds[0]);
  });

  // ── codespaces summaries list ──────────────────────────────────────────────

  it('GET /api/codespaces/summaries filters tag-restricted tokens', async () => {
    const codespaceService = makeCodespaceService(db);
    const routes = createCodespacesRoutes({
      codespaceService: codespaceService as never,
      templateService: {} as never,
      db: db as never,
    });
    const app = new Hono();
    app.use('*', authMiddleware(tagRestrictedAuth(['tag-staging']), 'codespace'));
    app.route('/', routes);

    const res = await app.request('http://localhost/summaries');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { items: Array<{ codespace: { id: string } }> };
    };
    expect(body.ok).toBe(true);
    const ids = body.data.items.map((i) => i.codespace.id);
    expect(ids).toEqual([fixtures.stagingCodespaceId]);
  });

  // ── empty scope tags edge case ─────────────────────────────────────────────

  it('tag-restricted token with no overlap sees nothing', async () => {
    const orphanScope = ['tag-orphan'];

    const codespaceService = makeCodespaceService(db);
    const routes = createCodespacesRoutes({
      codespaceService: codespaceService as never,
      templateService: {} as never,
      db: db as never,
    });
    const app = new Hono();
    app.use('*', authMiddleware(tagRestrictedAuth(orphanScope), 'codespace'));
    app.route('/', routes);
    const res = await app.request('http://localhost/');
    const body = (await res.json()) as { ok: boolean; data: { items: unknown[] } };
    expect(body.data.items).toEqual([]);
  });
});
