/**
 * Tests for team invitation RBAC routes.
 *
 * Covers:
 * - POST /invitations: create (admin required, duplicate pending 409, already member 409)
 * - GET /invitations: list pending (admin required, enriched invitedBy L4)
 * - POST /invitations/:iid/decline: only invitee can decline, not found
 * - DELETE /invitations/:iid: revoke (admin required)
 * - POST /invitations/:token/accept: success with teamName (H8), expired 404, email mismatch 403,
 *   already member 409
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { createInvitationAcceptRoutes } from '../../src/server/routes/invitation-accept';
import { createTeamInvitationsRoutes } from '../../src/server/routes/team-invitations';
import type { RbacService } from '../../src/services/rbac.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildMockRbacService(overrides: Partial<RbacService> = {}): RbacService {
  return {
    resolveTeamRole: vi.fn().mockResolvedValue('admin'),
    resolveUserRole: vi.fn().mockResolvedValue('admin'),
    hasMinimumRole: vi.fn().mockReturnValue(true),
    ...overrides,
  } as unknown as RbacService;
}

/**
 * Build a fluent mock DB chain that can be overridden per-test via
 * mockImplementation on the top-level methods.
 */
function buildMockDb() {
  function chain(defaultResult: unknown[] = []) {
    const obj: Record<string, unknown> = {};
    const methods = ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'groupBy'];
    for (const m of methods) {
      obj[m] = vi.fn().mockReturnValue(obj);
    }
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable mock for Drizzle query chain
    obj.then = (onfulfilled: (v: unknown) => unknown) =>
      Promise.resolve(defaultResult).then(onfulfilled);
    return obj;
  }

  const db = {
    select: vi.fn().mockReturnValue(chain()),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
    }),
    transaction: vi.fn(),
    query: {
      teams: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
  };

  return db;
}

type MockDb = ReturnType<typeof buildMockDb>;

/**
 * Build a Hono app with team-invitation routes mounted under /api/teams/:id/invitations.
 */
function buildTeamInvitationsApp(
  db: MockDb,
  rbacService: RbacService,
  authContext: Partial<AuthContext> = {}
) {
  const defaultAuth: AuthContext = {
    userId: 'user-admin-001',
    authMethod: 'dev',
    user: {
      id: 'user-admin-001',
      githubId: 1,
      githubLogin: 'admin',
      name: 'Admin',
      email: 'admin@example.com',
      avatarUrl: null,
    },
    ...authContext,
  };

  const routes = createTeamInvitationsRoutes({ db: db as never, rbacService });
  const app = new Hono();
  app.use('/api/teams/:id/invitations/*', async (c, next) => {
    c.set('auth', defaultAuth);
    await next();
  });
  app.use('/api/teams/:id/invitations', async (c, next) => {
    c.set('auth', defaultAuth);
    await next();
  });
  app.route('/api/teams/:id/invitations', routes);
  return app;
}

/**
 * Build a Hono app for the public invitation-accept route.
 */
function buildAcceptApp(db: MockDb, authContext: Partial<AuthContext> = {}) {
  const defaultAuth: AuthContext = {
    userId: 'user-invitee-001',
    authMethod: 'session',
    user: {
      id: 'user-invitee-001',
      githubId: 2,
      githubLogin: 'invitee',
      name: 'Invitee',
      email: 'invitee@example.com',
      githubEmail: 'invitee@example.com',
      avatarUrl: null,
    },
    ...authContext,
  };

  const routes = createInvitationAcceptRoutes({ db: db as never });
  const app = new Hono();
  app.use('/api/invitations/*', async (c, next) => {
    c.set('auth', defaultAuth);
    await next();
  });
  app.route('/api/invitations', routes);
  return app;
}

const VALID_TEAM_ID = 'team-aaa-001';
const VALID_INV_ID = 'inv-zzz-001';
const VALID_TOKEN = 'validtoken1234567890abcdefghijklmnopqrstuvwxyz';

// ─── POST /invitations ────────────────────────────────────────────────────────

describe('POST /api/teams/:id/invitations - Create invitation', () => {
  let db: MockDb;
  let rbacService: RbacService;
  let app: Hono;

  const sampleInvitation = {
    id: VALID_INV_ID,
    teamId: VALID_TEAM_ID,
    invitedBy: 'user-admin-001',
    email: 'newuser@example.com',
    role: 'viewer',
    token: VALID_TOKEN,
    status: 'pending',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    db = buildMockDb();
    rbacService = buildMockRbacService();
    app = buildTeamInvitationsApp(db, rbacService);
  });

  it('returns 201 and invitation data on success', async () => {
    // No pending invitation, no existing member, insert succeeds
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      let _selectCall = 0;
      const tx = {
        select: vi.fn().mockImplementation(() => {
          _selectCall++;
          const obj: Record<string, unknown> = {};
          const methods = ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy'];
          for (const m of methods) obj[m] = vi.fn().mockReturnValue(obj);
          // biome-ignore lint/suspicious/noThenProperty: intentional thenable mock
          obj.then = (fn: (v: unknown) => unknown) => Promise.resolve([]).then(fn);
          return obj;
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([sampleInvitation]),
          }),
        }),
      };
      return fn(tx);
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'newuser@example.com', role: 'viewer' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.email).toBe('newuser@example.com');
    expect(body.data.role).toBe('viewer');
  });

  it('returns 409 when a pending invitation already exists', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: vi.fn().mockImplementation(() => {
          const obj: Record<string, unknown> = {};
          const methods = ['from', 'where', 'leftJoin', 'innerJoin'];
          for (const m of methods) obj[m] = vi.fn().mockReturnValue(obj);
          // biome-ignore lint/suspicious/noThenProperty: intentional thenable mock
          obj.then = (fn: (v: unknown) => unknown) => Promise.resolve([sampleInvitation]).then(fn);
          return obj;
        }),
      };
      return fn(tx);
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'newuser@example.com', role: 'viewer' }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('INVITATION_ALREADY_EXISTS');
  });

  it('returns 409 when user with that email is already a member', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      let selectCall = 0;
      const tx = {
        select: vi.fn().mockImplementation(() => {
          selectCall++;
          const call = selectCall;
          const obj: Record<string, unknown> = {};
          const methods = ['from', 'where', 'leftJoin', 'innerJoin'];
          for (const m of methods) obj[m] = vi.fn().mockReturnValue(obj);
          // biome-ignore lint/suspicious/noThenProperty: intentional thenable mock
          obj.then = (fn: (v: unknown) => unknown) => {
            // First call: no pending invitation; second call: user is already a member
            const result = call === 1 ? [] : [{ userId: 'existing-user-001' }];
            return Promise.resolve(result).then(fn);
          };
          return obj;
        }),
      };
      return fn(tx);
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'existing@example.com', role: 'viewer' }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('MEMBER_ALREADY_EXISTS');
  });

  it('returns 400 for invalid email', async () => {
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', role: 'viewer' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 403 when caller lacks admin role', async () => {
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('viewer'),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });
    app = buildTeamInvitationsApp(db, rbacService, { authMethod: 'session', userId: 'viewer-001' });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', role: 'viewer' }),
    });

    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid team ID', async () => {
    const res = await app.request('/api/teams/!!!/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', role: 'viewer' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });
});

// ─── GET /invitations ─────────────────────────────────────────────────────────

describe('GET /api/teams/:id/invitations - List pending invitations', () => {
  let db: MockDb;
  let rbacService: RbacService;
  let app: Hono;

  const pendingInvitations = [
    {
      id: VALID_INV_ID,
      teamId: VALID_TEAM_ID,
      invitedBy: 'user-admin-001',
      invitedByName: 'Admin User',
      email: 'pending@example.com',
      role: 'viewer',
      status: 'pending',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      createdAt: new Date().toISOString(),
    },
  ];

  beforeEach(() => {
    db = buildMockDb();
    rbacService = buildMockRbacService();
    app = buildTeamInvitationsApp(db, rbacService);
  });

  it('returns 200 with enriched invitations (L4 invitedBy object)', async () => {
    db.select.mockImplementation(() => {
      const obj: Record<string, unknown> = {};
      const methods = ['from', 'where', 'leftJoin', 'innerJoin'];
      for (const m of methods) obj[m] = vi.fn().mockReturnValue(obj);
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable mock
      obj.then = (fn: (v: unknown) => unknown) => Promise.resolve(pendingInvitations).then(fn);
      return obj;
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/invitations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(1);
    // L4: invitedBy must be enriched as an object with userId and name
    expect(body.data.items[0].invitedBy).toMatchObject({
      userId: 'user-admin-001',
      name: 'Admin User',
    });
    // invitedByName raw field should be removed
    expect(body.data.items[0].invitedByName).toBeUndefined();
  });

  it('returns 403 when caller lacks admin role', async () => {
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('viewer'),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });
    app = buildTeamInvitationsApp(db, rbacService, { authMethod: 'session', userId: 'viewer-001' });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/invitations`);
    expect(res.status).toBe(403);
  });

  it('returns empty list when there are no pending invitations', async () => {
    db.select.mockImplementation(() => {
      const obj: Record<string, unknown> = {};
      const methods = ['from', 'where', 'leftJoin', 'innerJoin'];
      for (const m of methods) obj[m] = vi.fn().mockReturnValue(obj);
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable mock
      obj.then = (fn: (v: unknown) => unknown) => Promise.resolve([]).then(fn);
      return obj;
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/invitations`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.items).toHaveLength(0);
  });

  it('returns 400 for invalid team ID', async () => {
    const res = await app.request('/api/teams/!!!/invitations');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });
});

// ─── POST /invitations/:iid/decline ──────────────────────────────────────────

describe('POST /api/teams/:id/invitations/:iid/decline - Decline invitation', () => {
  let db: MockDb;
  let rbacService: RbacService;

  const inviteeEmail = 'invitee@example.com';

  const pendingInvitation = {
    id: VALID_INV_ID,
    teamId: VALID_TEAM_ID,
    email: inviteeEmail,
    status: 'pending',
  };

  beforeEach(() => {
    db = buildMockDb();
    rbacService = buildMockRbacService();
  });

  it('returns 200 when invitee declines their own invitation', async () => {
    db.select.mockImplementation(() => {
      const obj: Record<string, unknown> = {};
      const methods = ['from', 'where'];
      for (const m of methods) obj[m] = vi.fn().mockReturnValue(obj);
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable mock
      obj.then = (fn: (v: unknown) => unknown) => Promise.resolve([pendingInvitation]).then(fn);
      return obj;
    });
    db.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...pendingInvitation, status: 'declined' }]),
        }),
      }),
    });

    // The invitee's githubEmail matches the invitation email
    const app = buildTeamInvitationsApp(db, rbacService, {
      authMethod: 'session',
      userId: 'user-invitee-001',
      user: {
        id: 'user-invitee-001',
        githubId: 2,
        githubLogin: 'invitee',
        name: 'Invitee',
        email: inviteeEmail,
        githubEmail: inviteeEmail,
        avatarUrl: null,
      },
    });

    const res = await app.request(
      `/api/teams/${VALID_TEAM_ID}/invitations/${VALID_INV_ID}/decline`,
      { method: 'POST' }
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.declined).toBe(true);
  });

  it('returns 403 when a different user tries to decline', async () => {
    db.select.mockImplementation(() => {
      const obj: Record<string, unknown> = {};
      const methods = ['from', 'where'];
      for (const m of methods) obj[m] = vi.fn().mockReturnValue(obj);
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable mock
      obj.then = (fn: (v: unknown) => unknown) => Promise.resolve([pendingInvitation]).then(fn);
      return obj;
    });

    // Different githubEmail than the invitation target
    const app = buildTeamInvitationsApp(db, rbacService, {
      authMethod: 'session',
      userId: 'user-other-001',
      user: {
        id: 'user-other-001',
        githubId: 3,
        githubLogin: 'other',
        name: 'Other',
        email: 'other@example.com',
        githubEmail: 'other@example.com',
        avatarUrl: null,
      },
    });

    const res = await app.request(
      `/api/teams/${VALID_TEAM_ID}/invitations/${VALID_INV_ID}/decline`,
      { method: 'POST' }
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('returns 404 when invitation not found or already processed', async () => {
    db.select.mockImplementation(() => {
      const obj: Record<string, unknown> = {};
      const methods = ['from', 'where'];
      for (const m of methods) obj[m] = vi.fn().mockReturnValue(obj);
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable mock
      obj.then = (fn: (v: unknown) => unknown) => Promise.resolve([]).then(fn);
      return obj;
    });

    const app = buildTeamInvitationsApp(db, rbacService);
    const res = await app.request(
      `/api/teams/${VALID_TEAM_ID}/invitations/${VALID_INV_ID}/decline`,
      { method: 'POST' }
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for invalid invitation ID', async () => {
    const app = buildTeamInvitationsApp(db, rbacService);
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/invitations/!!!/decline`, {
      method: 'POST',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });
});

// ─── DELETE /invitations/:iid ─────────────────────────────────────────────────

describe('DELETE /api/teams/:id/invitations/:iid - Revoke invitation', () => {
  let db: MockDb;
  let rbacService: RbacService;
  let app: Hono;

  beforeEach(() => {
    db = buildMockDb();
    rbacService = buildMockRbacService();
    app = buildTeamInvitationsApp(db, rbacService);
  });

  it('returns 200 on successful revocation', async () => {
    db.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: VALID_INV_ID, status: 'revoked' }]),
        }),
      }),
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/invitations/${VALID_INV_ID}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data.revoked).toBe(true);
  });

  it('returns 404 when invitation not found', async () => {
    db.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/invitations/${VALID_INV_ID}`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('returns 403 when caller lacks admin role', async () => {
    rbacService = buildMockRbacService({
      resolveTeamRole: vi.fn().mockResolvedValue('viewer'),
      hasMinimumRole: vi.fn().mockReturnValue(false),
    });
    app = buildTeamInvitationsApp(db, rbacService, { authMethod: 'session', userId: 'viewer-001' });

    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/invitations/${VALID_INV_ID}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid invitation ID', async () => {
    const res = await app.request(`/api/teams/${VALID_TEAM_ID}/invitations/!!!`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_ID');
  });
});

// ─── POST /invitations/:token/accept ─────────────────────────────────────────

describe('POST /api/invitations/:token/accept - Accept invitation', () => {
  let db: MockDb;
  let app: Hono;

  const _futureExpiry = new Date(Date.now() + 86400000).toISOString();

  beforeEach(() => {
    db = buildMockDb();
    app = buildAcceptApp(db);
  });

  it('returns 200 with teamName on successful acceptance (H8)', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const claimed = {
        id: VALID_INV_ID,
        teamId: VALID_TEAM_ID,
        email: 'invitee@example.com',
        role: 'viewer',
        status: 'accepted',
      };
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([claimed]),
            }),
          }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]), // not yet a member
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
        query: {
          teams: {
            findFirst: vi.fn().mockResolvedValue({ name: 'Engineering Team' }),
          },
        },
      };
      return fn(tx);
    });

    const res = await app.request(`/api/invitations/${VALID_TOKEN}/accept`, {
      method: 'POST',
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.teamId).toBe(VALID_TEAM_ID);
    expect(body.data.role).toBe('viewer');
    expect(body.data.teamName).toBe('Engineering Team');
    expect(body.data.joinedAt).toBeDefined();
  });

  it('returns 404 when invitation is expired or not found', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]), // no matching row (expired/not found)
            }),
          }),
        }),
      };
      return fn(tx);
    });

    const res = await app.request(`/api/invitations/${VALID_TOKEN}/accept`, {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('INVITATION_NOT_FOUND');
  });

  it('returns 403 when invitee email does not match', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const claimed = {
        id: VALID_INV_ID,
        teamId: VALID_TEAM_ID,
        email: 'someone-else@example.com', // different email
        role: 'viewer',
        status: 'accepted',
      };
      let updateCallCount = 0;
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              updateCallCount++;
              if (updateCallCount === 1) {
                return { returning: vi.fn().mockResolvedValue([claimed]) };
              }
              // rollback update
              return { returning: vi.fn().mockResolvedValue([]) };
            }),
          }),
        }),
      };
      return fn(tx);
    });

    // User's email is 'invitee@example.com' but invitation targets 'someone-else@example.com'
    const res = await app.request(`/api/invitations/${VALID_TOKEN}/accept`, {
      method: 'POST',
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('INVITATION_EMAIL_MISMATCH');
  });

  it('returns 409 when user is already a team member', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const claimed = {
        id: VALID_INV_ID,
        teamId: VALID_TEAM_ID,
        email: 'invitee@example.com',
        role: 'viewer',
        status: 'accepted',
      };
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([claimed]),
            }),
          }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ userId: 'user-invitee-001', role: 'viewer' }]),
          }),
        }),
        insert: vi.fn(),
      };
      return fn(tx);
    });

    const res = await app.request(`/api/invitations/${VALID_TOKEN}/accept`, {
      method: 'POST',
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('MEMBER_ALREADY_EXISTS');
  });

  it('returns 400 for an invalid token format', async () => {
    const res = await app.request('/api/invitations/!!! bad token ***/accept', {
      method: 'POST',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_TOKEN');
  });

  it('returns 403 when user has no email and invitation requires email verification', async () => {
    db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const claimed = {
        id: VALID_INV_ID,
        teamId: VALID_TEAM_ID,
        email: 'somespecific@example.com',
        role: 'viewer',
        status: 'accepted',
      };
      let updateCallCount = 0;
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              updateCallCount++;
              if (updateCallCount === 1) {
                return { returning: vi.fn().mockResolvedValue([claimed]) };
              }
              return { returning: vi.fn().mockResolvedValue([]) };
            }),
          }),
        }),
      };
      return fn(tx);
    });

    // User has no email set in auth context (GitHub returned no public email)
    const noEmailApp = buildAcceptApp(db, {
      userId: 'user-no-email-001',
      authMethod: 'session',
      user: {
        id: 'user-no-email-001',
        githubId: 5,
        githubLogin: 'noemail',
        name: 'No Email',
        email: null,
        githubEmail: null,
        avatarUrl: null,
      },
    });

    const res = await noEmailApp.request(`/api/invitations/${VALID_TOKEN}/accept`, {
      method: 'POST',
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });
});
