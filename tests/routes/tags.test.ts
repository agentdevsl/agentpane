/**
 * Tests for tag RBAC routes.
 *
 * Covers:
 * - POST /tags: create (agent_operator required, duplicate name 409)
 * - GET /tags?teamId: list with counts (H3 batch), viewer minimum
 * - DELETE /tags/:id: admin required, not found 404
 * - POST /projects/:id/tags: assign (agent_operator, cross-team forbidden)
 * - DELETE /projects/:id/tags/:tagId: remove assignment
 * - POST /tasks/:id/tags: assign (cross-team check via project)
 * - DELETE /tasks/:id/tags/:tagId: remove
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectTagRoutes,
  createTagsRoutes,
  createTaskTagRoutes,
} from '../../src/server/routes/tags';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import type { RbacService } from '../../src/services/rbac.service';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function buildMockRbacService(overrides: Partial<RbacService> = {}): RbacService {
  return {
    resolveTeamRole: vi.fn().mockResolvedValue('agent_operator'),
    resolveUserRole: vi.fn().mockResolvedValue('agent_operator'),
    hasMinimumRole: vi.fn().mockReturnValue(true),
    ...overrides,
  } as unknown as RbacService;
}

function createMockDb() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
        groupBy: vi.fn().mockResolvedValue([]),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
    query: {
      teams: { findFirst: vi.fn() },
      tags: { findFirst: vi.fn() },
      projects: { findFirst: vi.fn() },
    },
  };
}

type MockDb = ReturnType<typeof createMockDb>;

const DEV_AUTH: AuthContext = { userId: 'user-dev-001', authMethod: 'dev' };

function createApp(
  routes: Hono,
  mountPath: string,
  auth: AuthContext = DEV_AUTH
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    return next();
  });
  app.route(mountPath, routes);
  return app;
}

// ─── POST /tags ───────────────────────────────────────────────────────────────

describe('POST /tags - Create tag', () => {
  let mockDb: MockDb;
  let rbacService: RbacService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    rbacService = buildMockRbacService();
  });

  it('creates a tag successfully with name and color', async () => {
    const tag = { id: 'tag-1', teamId: 'team-1', name: 'backend', color: '#ff0000', createdAt: '2024-01-01T00:00:00Z' };
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([tag]),
      }),
    });

    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'team-1', name: 'backend', color: '#ff0000' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('backend');
    expect(body.data.color).toBe('#ff0000');
  });

  it('creates a tag successfully without optional color', async () => {
    const tag = { id: 'tag-2', teamId: 'team-1', name: 'no-color', color: null, createdAt: '2024-01-01T00:00:00Z' };
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([tag]),
      }),
    });

    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'team-1', name: 'no-color' }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).ok).toBe(true);
  });

  it('returns 409 for duplicate tag name within a team', async () => {
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('UNIQUE constraint failed: tags.name')),
      }),
    });

    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'team-1', name: 'duplicate-tag' }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('TAG_ALREADY_EXISTS');
  });

  it('requires agent_operator role — returns >=403 for insufficient role', async () => {
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('viewer'),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });

    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags', { userId: 'viewer-001', authMethod: 'session' });

    const res = await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'team-1', name: 'some-tag' }),
    });

    // Non-members get 404 from requireTeamRole, members with insufficient role get 403
    expect(res.status).toBeGreaterThanOrEqual(403);
  });

  it('returns 400 for missing tag name', async () => {
    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'team-1' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid color format', async () => {
    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'team-1', name: 'my-tag', color: 'not-a-hex' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for missing teamId', async () => {
    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'orphan-tag' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 500 on unexpected DB error', async () => {
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(new Error('SQLITE_DISK_IO_ERROR')),
      }),
    });

    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: 'team-1', name: 'crash-tag' }),
    });

    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('DB_ERROR');
  });
});

// ─── GET /tags?teamId ─────────────────────────────────────────────────────────

describe('GET /tags?teamId - List tags with usage counts (H3 batch)', () => {
  let mockDb: MockDb;
  let rbacService: RbacService;

  const teamTags = [
    { id: 'tag-1', teamId: 'team-1', name: 'backend', color: '#ff0000', createdAt: '2024-01-01T00:00:00Z' },
    { id: 'tag-2', teamId: 'team-1', name: 'frontend', color: '#00ff00', createdAt: '2024-01-01T00:00:00Z' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('viewer'),
      hasMinimumRole: vi.fn().mockReturnValue(true),
    });
  });

  it('returns 200 with tags enriched with projectCount and taskCount (H3 batch)', async () => {
    // The route executes three sequential select calls:
    //   call 1: db.select().from(tags).where(eq(tags.teamId, teamId)) → tags array
    //   call 2: db.select({tagId, total}).from(projectTags).where(inArray(...)).groupBy(...) → project counts
    //   call 3: db.select({tagId, total}).from(taskTags).where(inArray(...)).groupBy(...)   → task counts
    // Calls 2 & 3 run in parallel via Promise.all and use a where→groupBy chain.
    let selectCallIndex = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCallIndex++;
      const call = selectCallIndex;
      // For the first call (tag list): where() is the terminal awaitable
      if (call === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(teamTags),
          }),
        };
      }
      // For calls 2 & 3 (batch count queries): where() returns a chainable object with groupBy()
      const groupByResult =
        call === 2
          ? [{ tagId: 'tag-1', total: 3 }]
          : [{ tagId: 'tag-1', total: 5 }, { tagId: 'tag-2', total: 2 }];
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue(groupByResult),
          }),
        }),
      };
    });

    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags?teamId=team-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(2);
  });

  it('returns projectCount=0 and taskCount=0 for tags with no assignments', async () => {
    let selectCallIndex = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCallIndex++;
      const call = selectCallIndex;
      if (call === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(teamTags),
          }),
        };
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue([]), // no counts for either table
          }),
        }),
      };
    });

    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags?teamId=team-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    // When no counts returned, defaults should be 0
    for (const item of body.data.items) {
      expect(item.projectCount).toBe(0);
      expect(item.taskCount).toBe(0);
    }
  });

  it('returns empty items array when team has no tags', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
        groupBy: vi.fn().mockResolvedValue([]),
      }),
    });

    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags?teamId=team-1');
    expect(res.status).toBe(200);
    expect((await res.json()).data.items).toHaveLength(0);
  });

  it('returns 400 when teamId is missing', async () => {
    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when teamId contains invalid characters', async () => {
    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags?teamId=!!!invalid!!!');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('requires at minimum viewer role — non-member gets forbidden/not-found', async () => {
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue(null),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });

    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags', { userId: 'outsider-001', authMethod: 'session' });

    const res = await app.request('/tags?teamId=team-1');
    expect(res.status).toBeGreaterThanOrEqual(403);
  });

  it('dev mode bypasses role check and returns tags', async () => {
    let selectCallIndex = 0;
    mockDb.select = vi.fn().mockImplementation(() => {
      selectCallIndex++;
      const call = selectCallIndex;
      if (call === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(teamTags),
          }),
        };
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      };
    });

    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    // DEV_AUTH should pass without any rbac lookup
    const app = createApp(routes, '/tags', DEV_AUTH);

    const res = await app.request('/tags?teamId=team-1');
    expect(res.status).toBe(200);
    expect((await res.json()).data.items).toHaveLength(2);
  });
});

// ─── DELETE /tags/:id ─────────────────────────────────────────────────────────

describe('DELETE /tags/:id - Delete tag', () => {
  let mockDb: MockDb;
  let rbacService: RbacService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('admin'),
      hasMinimumRole: vi.fn().mockReturnValue(true),
    });
    // Default: tag exists
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ teamId: 'team-1' }]),
      }),
    });
  });

  it('deletes a tag successfully (admin role, dev mode)', async () => {
    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags/tag-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.deleted).toBe(true);
  });

  it('deletes a tag successfully when caller has admin role (non-dev)', async () => {
    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags', { userId: 'admin-user-001', authMethod: 'session' });

    const res = await app.request('/tags/tag-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.deleted).toBe(true);
  });

  it('returns 404 when tag does not exist', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags/nonexistent-tag', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('TAG_NOT_FOUND');
  });

  it('returns 403 when non-admin tries to delete a tag', async () => {
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('agent_operator'),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });

    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags', { userId: 'operator-001', authMethod: 'session' });

    const res = await app.request('/tags/tag-1', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid tag ID (special chars)', async () => {
    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags/!!!', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });

  it('returns 500 on unexpected DB error during delete', async () => {
    mockDb.delete = vi.fn().mockReturnValue({
      where: vi.fn().mockRejectedValue(new Error('disk full')),
    });

    const routes = createTagsRoutes({ db: mockDb as never, rbacService });
    const app = createApp(routes, '/tags');

    const res = await app.request('/tags/tag-1', { method: 'DELETE' });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('DB_ERROR');
  });
});

// ─── POST /projects/:id/tags ──────────────────────────────────────────────────

describe('POST /projects/:id/tags - Assign tag to project', () => {
  let mockDb: MockDb;
  let rbacService: RbacService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    rbacService = buildMockRbacService();
  });

  it('assigns a tag to a project successfully', async () => {
    let selectCall = 0;
    mockDb.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          selectCall++;
          if (selectCall === 1) return Promise.resolve([{ teamId: 'team-1' }]); // tag record
          return Promise.resolve([{ teamId: 'team-1' }]); // team owns project
        }),
      })),
    }));
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const routes = createProjectTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/projects/:id/tags', routes);

    const res = await app.request('/projects/proj-1/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-1' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.projectId).toBe('proj-1');
    expect(body.data.tagId).toBe('tag-1');
    expect(body.data.assignedAt).toBeDefined();
  });

  it('returns 403 when tag belongs to a different team than the project (cross-team forbidden)', async () => {
    let selectCall = 0;
    mockDb.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          selectCall++;
          if (selectCall === 1) return Promise.resolve([{ teamId: 'foreign-team-999' }]);
          return Promise.resolve([]); // foreign team does NOT own project
        }),
      })),
    }));

    const routes = createProjectTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/projects/:id/tags', routes);

    const res = await app.request('/projects/proj-1/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-1' }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('returns 404 when the tag does not exist', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const routes = createProjectTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/projects/:id/tags', routes);

    const res = await app.request('/projects/proj-1/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'nonexistent-tag' }),
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('returns 403 when caller lacks agent_operator role on project (non-dev)', async () => {
    rbacService = buildMockRbacService({
      resolveUserRole: vi.fn().mockResolvedValue('viewer'),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });

    const routes = createProjectTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'viewer-001', authMethod: 'session' as const });
      return next();
    });
    app.route('/projects/:id/tags', routes);

    const res = await app.request('/projects/proj-1/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-1' }),
    });

    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid project ID', async () => {
    const routes = createProjectTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/projects/:id/tags', routes);

    const res = await app.request('/projects/!!!/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-1' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });

  it('assignment is idempotent (onConflictDoNothing)', async () => {
    let selectCall = 0;
    mockDb.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          selectCall++;
          return selectCall === 1
            ? Promise.resolve([{ teamId: 'team-1' }])
            : Promise.resolve([{ teamId: 'team-1' }]);
        }),
      })),
    }));
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoNothing }),
    });

    const routes = createProjectTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/projects/:id/tags', routes);

    const res = await app.request('/projects/proj-1/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-1' }),
    });

    expect(res.status).toBe(201);
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });
});

// ─── DELETE /projects/:id/tags/:tagId ────────────────────────────────────────

describe('DELETE /projects/:id/tags/:tagId - Remove tag from project', () => {
  let mockDb: MockDb;
  let rbacService: RbacService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    rbacService = buildMockRbacService();
  });

  it('removes a tag from a project (dev mode)', async () => {
    const routes = createProjectTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/projects/:id/tags', routes);

    const res = await app.request('/projects/proj-1/tags/tag-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.removed).toBe(true);
  });

  it('returns 403 when caller lacks agent_operator role', async () => {
    rbacService = buildMockRbacService({
      resolveUserRole: vi.fn().mockResolvedValue('viewer'),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });

    const routes = createProjectTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'viewer-001', authMethod: 'session' as const });
      return next();
    });
    app.route('/projects/:id/tags', routes);

    const res = await app.request('/projects/proj-1/tags/tag-1', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid project ID', async () => {
    const routes = createProjectTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/projects/:id/tags', routes);

    const res = await app.request('/projects/!!!/tags/tag-1', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });

  it('returns 400 for invalid tag ID in path', async () => {
    const routes = createProjectTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/projects/:id/tags', routes);

    const res = await app.request('/projects/proj-1/tags/!!!', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });
});

// ─── POST /tasks/:id/tags ─────────────────────────────────────────────────────

describe('POST /tasks/:id/tags - Assign tag to task', () => {
  let mockDb: MockDb;
  let rbacService: RbacService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    rbacService = buildMockRbacService();
  });

  it('assigns a tag to a task successfully', async () => {
    let selectCall = 0;
    mockDb.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          selectCall++;
          if (selectCall === 1) return Promise.resolve([{ projectId: 'proj-1' }]); // task lookup
          if (selectCall === 2) return Promise.resolve([{ teamId: 'team-1' }]);     // tag record
          return Promise.resolve([{ teamId: 'team-1' }]);                           // team owns project
        }),
      })),
    }));
    mockDb.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const res = await app.request('/tasks/task-1/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-1' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.taskId).toBe('task-1');
    expect(body.data.tagId).toBe('tag-1');
    expect(body.data.assignedAt).toBeDefined();
  });

  it('returns 404 when task not found', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const res = await app.request('/tasks/nonexistent/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-1' }),
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('returns 403 when tag belongs to a different team than the task project (cross-team check via project)', async () => {
    let selectCall = 0;
    mockDb.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          selectCall++;
          if (selectCall === 1) return Promise.resolve([{ projectId: 'proj-1' }]);
          if (selectCall === 2) return Promise.resolve([{ teamId: 'foreign-team-999' }]);
          return Promise.resolve([]); // foreign team doesn't own the project
        }),
      })),
    }));

    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const res = await app.request('/tasks/task-1/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-foreign' }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('returns 404 when tag not found', async () => {
    let selectCall = 0;
    mockDb.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          selectCall++;
          if (selectCall === 1) return Promise.resolve([{ projectId: 'proj-1' }]); // task found
          return Promise.resolve([]); // tag not found
        }),
      })),
    }));

    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const res = await app.request('/tasks/task-1/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'ghost-tag' }),
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('returns 403 when caller lacks agent_operator role on the task project', async () => {
    let selectCall = 0;
    mockDb.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          selectCall++;
          return selectCall === 1
            ? Promise.resolve([{ projectId: 'proj-1' }])
            : Promise.resolve([]);
        }),
      })),
    }));

    rbacService = buildMockRbacService({
      resolveUserRole: vi.fn().mockResolvedValue('viewer'),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });

    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'viewer-001', authMethod: 'session' as const });
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const res = await app.request('/tasks/task-1/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-1' }),
    });

    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid task ID', async () => {
    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const res = await app.request('/tasks/!!!/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId: 'tag-1' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });

  it('returns 400 when tagId is missing from request body', async () => {
    let selectCall = 0;
    mockDb.select = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          selectCall++;
          return selectCall === 1
            ? Promise.resolve([{ projectId: 'proj-1' }])
            : Promise.resolve([]);
        }),
      })),
    }));

    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const res = await app.request('/tasks/task-1/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });
});

// ─── DELETE /tasks/:id/tags/:tagId ───────────────────────────────────────────

describe('DELETE /tasks/:id/tags/:tagId - Remove tag from task', () => {
  let mockDb: MockDb;
  let rbacService: RbacService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    rbacService = buildMockRbacService();
  });

  it('removes tag from task (dev mode)', async () => {
    // Task lookup now runs unconditionally; mock it to return a valid task
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ projectId: 'proj-1' }]),
      }),
    });

    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const res = await app.request('/tasks/task-1/tags/tag-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.removed).toBe(true);
  });

  it('removes tag from task for non-dev user with correct role', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ projectId: 'proj-1' }]),
      }),
    });

    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'operator-001', authMethod: 'session' as const });
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const res = await app.request('/tasks/task-1/tags/tag-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.removed).toBe(true);
  });

  it('returns 404 when task not found (non-dev user)', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'operator-001', authMethod: 'session' as const });
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const res = await app.request('/tasks/missing-task/tags/tag-1', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('returns 403 when non-dev caller lacks agent_operator role', async () => {
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ projectId: 'proj-1' }]),
      }),
    });

    rbacService = buildMockRbacService({
      resolveUserRole: vi.fn().mockResolvedValue('viewer'),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });

    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'viewer-001', authMethod: 'session' as const });
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const res = await app.request('/tasks/task-1/tags/tag-1', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid task ID', async () => {
    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const res = await app.request('/tasks/!!!/tags/tag-1', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });

  it('returns 400 for invalid tag ID in path', async () => {
    const routes = createTaskTagRoutes({ db: mockDb as never, rbacService });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', DEV_AUTH);
      return next();
    });
    app.route('/tasks/:id/tags', routes);

    const res = await app.request('/tasks/task-1/tags/!!!', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });
});
