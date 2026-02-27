/**
 * Tests for team member RBAC routes.
 *
 * Covers:
 * - POST /members: add member (admin required, user exists, duplicate 409, user not found 404)
 * - GET /members: list with pagination and role filter
 * - PATCH /members/:uid: update role, can't change own role, admin can't assign admin, last owner protection
 * - DELETE /members/:uid: remove, can't remove self, can't remove last owner, only owners remove owners
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTeamMembersRoutes } from '../../src/server/routes/team-members';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import type { RbacService } from '../../src/services/rbac.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock DB that mirrors the drizzle query chain pattern.
 * Each method returns an object that supports chaining all the way to an
 * awaitable array / value.
 */
function buildMockDb(overrides: Record<string, unknown> = {}) {
  // Default resolvers — most tests override these per-call via mockResolvedValueOnce
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    query: { teams: { findFirst: vi.fn() } },
    ...overrides,
  };

  // Fluent chain builder: select().from().where().orderBy().limit() etc.
  // Returns a Promise that resolves to an array by default.
  function chain(resolve: unknown[] = []) {
    const obj: Record<string, unknown> = {};
    const methods = ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'groupBy', 'returning'];
    for (const m of methods) {
      obj[m] = vi.fn().mockReturnValue(obj);
    }
    // Make the chain thenable (await-able)
    obj.then = (onfulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolve).then(onfulfilled);
    obj[Symbol.iterator] = [][Symbol.iterator];
    return obj;
  }

  mockDb.select.mockReturnValue(chain());
  mockDb.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) });
  mockDb.update.mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }) });
  mockDb.delete.mockReturnValue({ where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) });

  return mockDb;
}

function buildMockRbacService(overrides: Partial<RbacService> = {}): RbacService {
  return {
    resolveTeamRole: vi.fn().mockResolvedValue('admin'),
    resolveUserRole: vi.fn().mockResolvedValue('admin'),
    hasMinimumRole: vi.fn().mockReturnValue(true),
    ...overrides,
  } as unknown as RbacService;
}

/**
 * Build a Hono app with the team-members routes mounted.
 * The :id param is satisfied by mounting at /api/teams/:id/members.
 */
function buildApp(
  db: ReturnType<typeof buildMockDb>,
  rbacService: RbacService,
  authContext: Partial<AuthContext> = {}
) {
  const defaultAuth: AuthContext = {
    userId: 'user-admin-001',
    authMethod: 'dev',
    ...authContext,
  };

  const routes = createTeamMembersRoutes({ db: db as never, rbacService });

  const app = new Hono();
  app.use('/api/teams/:id/members/*', async (c, next) => {
    c.set('auth', defaultAuth);
    await next();
  });
  app.use('/api/teams/:id/members', async (c, next) => {
    c.set('auth', defaultAuth);
    await next();
  });
  app.route('/api/teams/:id/members', routes);

  return app;
}

const VALID_TEAM_ID = 'team-aaa-001';
const VALID_USER_ID = 'user-bbb-001';

// ─── POST /members ────────────────────────────────────────────────────────────

describe('POST /api/teams/:id/members - Add member', () => {
  let db: ReturnType<typeof buildMockDb>;
  let rbacService: RbacService;
  let app: Hono;

  beforeEach(() => {
    db = buildMockDb();
    rbacService = buildMockRbacService();
    app = buildApp(db, rbacService);
  });

  it('returns 200 and member data on successful add', async () => {
    // transaction resolves to 'OK'
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]), // no existing member
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      };
      // First select: no existing member → []
      // Second select: user exists → [{id: 'user-bbb-001'}]
      let callCount = 0;
      tx.select.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve([]); // no duplicate
            return Promise.resolve([{ id: VALID_USER_ID }]); // user exists
          }),
        }),
      }));
      return fn(tx);
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: VALID_USER_ID, role: 'viewer' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.teamId).toBe(VALID_TEAM_ID);
    expect(body.data.userId).toBe(VALID_USER_ID);
    expect(body.data.role).toBe('viewer');
  });

  it('returns 409 when user is already a member', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ teamId: VALID_TEAM_ID, userId: VALID_USER_ID }]),
          }),
        }),
        insert: vi.fn(),
      };
      return fn(tx);
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: VALID_USER_ID, role: 'viewer' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MEMBER_ALREADY_EXISTS');
  });

  it('returns 404 when user does not exist', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      let callCount = 0;
      const tx = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) return Promise.resolve([]); // no duplicate
              return Promise.resolve([]); // user not found
            }),
          }),
        })),
        insert: vi.fn(),
      };
      return fn(tx);
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: VALID_USER_ID, role: 'viewer' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('USER_NOT_FOUND');
  });

  it('returns 400 for invalid team ID', async () => {
    const res = await app.request('/api/teams/!!!/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: VALID_USER_ID, role: 'viewer' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('returns 403 when caller lacks admin role (non-dev mode)', async () => {
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('viewer'),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });
    app = buildApp(db, rbacService, { authMethod: 'session', userId: 'user-viewer-001' });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: VALID_USER_ID, role: 'viewer' }),
    });

    expect(res.status).toBe(403);
  });

  it('returns 400 for validation error (missing required fields)', async () => {
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }), // missing userId
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when attempting to assign owner role directly', async () => {
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: VALID_USER_ID, role: 'owner' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─── GET /members ─────────────────────────────────────────────────────────────

describe('GET /api/teams/:id/members - List members with pagination', () => {
  let db: ReturnType<typeof buildMockDb>;
  let rbacService: RbacService;
  let app: Hono;

  const mockMembers = [
    {
      userId: 'user-aaa',
      role: 'admin',
      joinedAt: '2024-01-01T00:00:00Z',
      name: 'Alice',
      email: 'alice@example.com',
      githubLogin: 'alice',
      avatarUrl: null,
    },
    {
      userId: 'user-bbb',
      role: 'viewer',
      joinedAt: '2024-01-02T00:00:00Z',
      name: 'Bob',
      email: 'bob@example.com',
      githubLogin: 'bob',
      avatarUrl: null,
    },
  ];

  beforeEach(() => {
    db = buildMockDb();
    rbacService = buildMockRbacService();
    app = buildApp(db, rbacService);

    // Default: count query then members query
    let selectCallIndex = 0;
    db.select.mockImplementation(() => {
      selectCallIndex++;
      const call = selectCallIndex;
      const obj: Record<string, unknown> = {};
      const methods = ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'groupBy'];
      for (const m of methods) {
        obj[m] = vi.fn().mockReturnValue(obj);
      }
      obj.then = (onfulfilled: (v: unknown) => unknown) => {
        // Call 1 is the count query, call 2+ is the members list
        const result = call === 1 ? [{ total: 2 }] : mockMembers;
        return Promise.resolve(result).then(onfulfilled);
      };
      return obj;
    });
  });

  it('returns 200 with member list and pagination metadata', async () => {
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.totalCount).toBe(2);
    expect(body.data.hasMore).toBe(false);
  });

  it('returns 400 for invalid team ID', async () => {
    const res = await app.request('/api/teams/!!!/members');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });

  it('returns 403 when caller is not a team member (non-dev mode)', async () => {
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue(null),
    });
    app = buildApp(db, rbacService, { authMethod: 'session', userId: 'outsider-001' });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('supports role filter query parameter (H6)', async () => {
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members?role=admin`);
    expect(res.status).toBe(200);
    // Verify that the DB select was called (role filter is applied via query)
    expect(db.select).toHaveBeenCalled();
  });

  it('returns hasMore=true and nextCursor when results exceed limit', async () => {
    // Generate limit+1 members to trigger pagination
    const manyMembers = Array.from({ length: 21 }, (_, i) => ({
      userId: `user-${String(i).padStart(3, '0')}`,
      role: 'viewer',
      joinedAt: '2024-01-01T00:00:00Z',
      name: `User ${i}`,
      email: `user${i}@example.com`,
      githubLogin: `user${i}`,
      avatarUrl: null,
    }));

    let selectCallIndex2 = 0;
    db.select.mockImplementation(() => {
      selectCallIndex2++;
      const call = selectCallIndex2;
      const obj: Record<string, unknown> = {};
      const methods = ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'groupBy'];
      for (const m of methods) {
        obj[m] = vi.fn().mockReturnValue(obj);
      }
      obj.then = (onfulfilled: (v: unknown) => unknown) => {
        const result = call === 1 ? [{ total: 21 }] : manyMembers;
        return Promise.resolve(result).then(onfulfilled);
      };
      return obj;
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members?limit=20`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.hasMore).toBe(true);
    expect(body.data.nextCursor).toBeDefined();
  });
});

// ─── PATCH /members/:uid ──────────────────────────────────────────────────────

describe('PATCH /api/teams/:id/members/:uid - Update member role', () => {
  let db: ReturnType<typeof buildMockDb>;
  let rbacService: RbacService;

  const OTHER_USER_ID = 'user-other-002';

  beforeEach(() => {
    db = buildMockDb();
    rbacService = buildMockRbacService();
  });

  it('returns 200 on successful role update', async () => {
    const updatedMember = {
      teamId: VALID_TEAM_ID,
      userId: OTHER_USER_ID,
      role: 'agent_operator',
      joinedAt: '2024-01-01T00:00:00Z',
    };

    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ userId: OTHER_USER_ID, role: 'viewer' }]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([updatedMember]),
            }),
          }),
        }),
      };
      return fn(tx);
    });

    const app = buildApp(db, rbacService);
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members/${OTHER_USER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'agent_operator' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.role).toBe('agent_operator');
  });

  it('returns 400 when user tries to change their own role', async () => {
    // Non-dev auth so the self-check fires
    const app = buildApp(db, rbacService, { authMethod: 'session', userId: VALID_USER_ID });
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members/${VALID_USER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('CANNOT_CHANGE_OWN_ROLE');
  });

  it('returns 403 when admin tries to assign admin role to another user', async () => {
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('admin'),
      hasMinimumRole: vi.fn().mockReturnValue(true),
    });
    const app = buildApp(db, rbacService, { authMethod: 'session', userId: 'user-admin-001' });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members/${OTHER_USER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('returns 400 when trying to demote the last owner', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      let callCount = 0;
      const tx = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                // target member is an owner
                return Promise.resolve([{ userId: OTHER_USER_ID, role: 'owner' }]);
              }
              // Only one owner
              return Promise.resolve([{ userId: OTHER_USER_ID, role: 'owner' }]);
            }),
          }),
        })),
        update: vi.fn(),
      };
      return fn(tx);
    });

    const app = buildApp(db, rbacService);
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members/${OTHER_USER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('CANNOT_DEMOTE_LAST_OWNER');
  });

  it('returns 404 when member not found', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]), // no member
          }),
        }),
        update: vi.fn(),
      };
      return fn(tx);
    });

    const app = buildApp(db, rbacService);
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members/${OTHER_USER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('MEMBER_NOT_FOUND');
  });

  it('returns 400 for invalid ID in path', async () => {
    const app = buildApp(db, rbacService);
    const res = await app.request(`/api/teams/!!!/members/${OTHER_USER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });
});

// ─── DELETE /members/:uid ─────────────────────────────────────────────────────

describe('DELETE /api/teams/:id/members/:uid - Remove member', () => {
  let db: ReturnType<typeof buildMockDb>;
  let rbacService: RbacService;

  const OTHER_USER_ID = 'user-other-003';

  beforeEach(() => {
    db = buildMockDb();
    rbacService = buildMockRbacService();
  });

  it('returns 200 on successful removal', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ userId: OTHER_USER_ID, role: 'viewer' }]),
          }),
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
      return fn(tx);
    });

    const app = buildApp(db, rbacService);
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members/${OTHER_USER_ID}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.removed).toBe(true);
  });

  it('returns 403 when user tries to remove themselves (non-dev)', async () => {
    const app = buildApp(db, rbacService, { authMethod: 'session', userId: VALID_USER_ID });
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members/${VALID_USER_ID}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('CANNOT_REMOVE_SELF');
  });

  it('returns 409 when trying to remove the last owner', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      let callCount = 0;
      const tx = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve([{ userId: OTHER_USER_ID, role: 'owner' }]);
              }
              // Only one owner in team
              return Promise.resolve([{ userId: OTHER_USER_ID, role: 'owner' }]);
            }),
          }),
        })),
        delete: vi.fn(),
      };
      return fn(tx);
    });

    const app = buildApp(db, rbacService);
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members/${OTHER_USER_ID}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CANNOT_REMOVE_LAST_OWNER');
  });

  it('returns 403 when an admin tries to remove an owner', async () => {
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('admin'),
      hasMinimumRole: vi.fn().mockReturnValue(true),
    });

    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ userId: OTHER_USER_ID, role: 'owner' }]),
          }),
        }),
        delete: vi.fn(),
      };
      return fn(tx);
    });

    const app = buildApp(db, rbacService, { authMethod: 'session', userId: 'user-admin-001' });
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members/${OTHER_USER_ID}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('returns 404 when member not found', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
        delete: vi.fn(),
      };
      return fn(tx);
    });

    const app = buildApp(db, rbacService);
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members/${OTHER_USER_ID}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('MEMBER_NOT_FOUND');
  });

  it('returns 400 for invalid IDs in path', async () => {
    const app = buildApp(db, rbacService);
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members/!!!`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });

  it('owner can successfully remove another owner when multiple owners exist', async () => {
    const secondOwnerId = 'user-owner-002';
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('owner'),
      hasMinimumRole: vi.fn().mockReturnValue(true),
    });

    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      let callCount = 0;
      const tx = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve([{ userId: secondOwnerId, role: 'owner' }]);
              }
              // Two owners exist
              return Promise.resolve([
                { userId: 'user-owner-001', role: 'owner' },
                { userId: secondOwnerId, role: 'owner' },
              ]);
            }),
          }),
        })),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
      return fn(tx);
    });

    const app = buildApp(db, rbacService, { authMethod: 'session', userId: 'user-owner-001' });
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/members/${secondOwnerId}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data.removed).toBe(true);
  });
});
