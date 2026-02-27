/**
 * Tests for teams API routes.
 *
 * Covers:
 * - POST /teams: create team (201, 409 slug conflict)
 * - GET /teams: list teams (dev mode, authenticated user, search filter, pagination)
 * - GET /teams/:id: get team details (success, not found, not member)
 * - PATCH /teams/:id: update team (admin required, returns updated)
 * - POST /teams/:id/transfer-ownership: owner only, self-transfer, target not member
 * - DELETE /teams/:id: owner only, cascading deletes
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTeamsRoutes } from '../../src/server/routes/teams';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const mockRbacService = {
  resolveTeamRole: vi.fn(),
  resolveUserRole: vi.fn(),
  hasMinimumRole: vi.fn(),
};

// A minimal mock db that mirrors the Drizzle query builder chain used in teams.ts.
// Each chainable method returns `this` unless overridden per test.
const mockDb = {
  query: {
    teams: { findFirst: vi.fn() },
    teamMembers: { findFirst: vi.fn() },
  },
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  leftJoin: vi.fn().mockReturnThis(),
  groupBy: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({ returning: vi.fn() }),
  }),
  update: vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn() }),
    }),
  }),
  delete: vi.fn().mockReturnValue({ where: vi.fn() }),
  transaction: vi.fn(),
};

// Reusable sample data
const sampleTeam = {
  id: 'team-abc123',
  name: 'Acme Corp',
  slug: 'acme-corp',
  description: 'A test team',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

type AuthMethod = 'session' | 'api_token' | 'dev';

const createApp = (authMethod: AuthMethod = 'session', userId = 'user-1') => {
  const routes = createTeamsRoutes({
    db: mockDb as never,
    rbacService: mockRbacService as never,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { userId, authMethod });
    return next();
  });
  app.route('/teams', routes);
  return app;
};

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Restore chainable defaults after clearAllMocks wipes them
  mockDb.select.mockReturnThis();
  mockDb.from.mockReturnThis();
  mockDb.where.mockReturnThis();
  mockDb.orderBy.mockReturnThis();
  mockDb.limit.mockReturnThis();
  mockDb.leftJoin.mockReturnThis();
  mockDb.groupBy.mockReturnThis();
  mockDb.insert.mockReturnValue({
    values: vi.fn().mockReturnValue({ returning: vi.fn() }),
  });
  mockDb.update.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn() }),
    }),
  });
  mockDb.delete.mockReturnValue({ where: vi.fn() });

  // Default RBAC: resolve as owner with minimum role always passing
  mockRbacService.resolveTeamRole.mockResolvedValue('owner');
  mockRbacService.hasMinimumRole.mockReturnValue(true);
});

// ===========================================================================
// POST /teams — Create team
// ===========================================================================

describe('POST /teams', () => {
  it('creates a team and returns 201-compatible data with membership', async () => {
    const createdTeam = { ...sampleTeam };

    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => {
      const tx = {
        ...mockDb,
        query: {
          teams: {
            findFirst: vi
              .fn()
              // First call: slug uniqueness check → not found
              .mockResolvedValueOnce(undefined)
              // Second call: fetch the newly created team
              .mockResolvedValueOnce(createdTeam),
          },
          teamMembers: { findFirst: vi.fn() },
        },
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      };
      return fn(tx as never);
    });

    const app = createApp();
    const res = await app.request('/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Corp', slug: 'acme-corp' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('team-abc123');
    expect(body.data.membership.role).toBe('owner');
    expect(body.data.membership.userId).toBe('user-1');
  });

  it('returns 409 when slug already exists', async () => {
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => {
      const tx = {
        ...mockDb,
        query: {
          teams: {
            // Slug uniqueness check: slug taken
            findFirst: vi.fn().mockResolvedValueOnce(sampleTeam),
          },
          teamMembers: { findFirst: vi.fn() },
        },
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      };
      return fn(tx as never);
    });

    const app = createApp();
    const res = await app.request('/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Corp', slug: 'acme-corp' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('TEAM_SLUG_EXISTS');
  });

  it('returns 400 when name is missing', async () => {
    const app = createApp();
    const res = await app.request('/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'no-name' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ===========================================================================
// GET /teams — List teams
// ===========================================================================

describe('GET /teams', () => {
  it('returns all teams for dev mode without membership filter', async () => {
    // Count query
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ total: 2 }]),
      }),
    });
    // Teams list query (limit+1 rows)
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([sampleTeam, { ...sampleTeam, id: 'team-xyz' }]),
          }),
        }),
      }),
    });
    // Member counts
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          groupBy: vi.fn().mockResolvedValue([{ teamId: 'team-abc123', total: 3 }]),
        }),
      }),
    });
    // Project counts
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          groupBy: vi.fn().mockResolvedValue([{ teamId: 'team-abc123', total: 1 }]),
        }),
      }),
    });

    const app = createApp('dev');
    const res = await app.request('/teams');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);
  });

  it('returns empty list when authenticated user has no memberships', async () => {
    // Members query returns empty
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const app = createApp('session');
    const res = await app.request('/teams');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toEqual([]);
    expect(body.data.totalCount).toBe(0);
    expect(body.data.hasMore).toBe(false);
  });

  it('returns teams with myRole for authenticated user', async () => {
    // Members query
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ teamId: 'team-abc123', role: 'admin' }]),
      }),
    });
    // Count query
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ total: 1 }]),
      }),
    });
    // Teams list query
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([sampleTeam]),
          }),
        }),
      }),
    });
    // Member counts
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          groupBy: vi.fn().mockResolvedValue([{ teamId: 'team-abc123', total: 5 }]),
        }),
      }),
    });
    // Project counts
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          groupBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const app = createApp('session');
    const res = await app.request('/teams');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items[0].myRole).toBe('admin');
    expect(body.data.items[0].memberCount).toBe(5);
    expect(body.data.items[0].projectCount).toBe(0);
  });

  it('supports search filter and returns matching teams for dev mode', async () => {
    // Count query
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ total: 1 }]),
      }),
    });
    // Teams list (search filtered)
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([sampleTeam]),
          }),
        }),
      }),
    });
    // Member counts
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          groupBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    // Project counts
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          groupBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const app = createApp('dev');
    const res = await app.request('/teams?search=Acme');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items.length).toBe(1);
  });

  it('supports pagination with cursor and hasMore flag', async () => {
    const teamsPage = [sampleTeam, { ...sampleTeam, id: 'team-page2' }];
    // limit=1 → fetch 2 items, hasMore=true

    // Members query
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { teamId: 'team-abc123', role: 'owner' },
          { teamId: 'team-page2', role: 'viewer' },
        ]),
      }),
    });
    // Count query
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ total: 2 }]),
      }),
    });
    // Teams list (limit+1 = 2 items returned)
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(teamsPage),
          }),
        }),
      }),
    });
    // Member counts
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          groupBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    // Project counts
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          groupBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const app = createApp('session');
    const res = await app.request('/teams?limit=1');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.hasMore).toBe(true);
    expect(body.data.nextCursor).toBe('team-abc123');
    expect(body.data.items.length).toBe(1);
  });
});

// ===========================================================================
// GET /teams/:id — Get team details
// ===========================================================================

describe('GET /teams/:id', () => {
  it('returns team details with counts and myRole for a team member', async () => {
    mockRbacService.resolveTeamRole.mockResolvedValue('admin');
    mockRbacService.hasMinimumRole.mockReturnValue(true);

    mockDb.query.teams.findFirst.mockResolvedValue(sampleTeam);

    // Member count
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ total: 4 }]),
      }),
    });
    // Project count
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ total: 2 }]),
      }),
    });

    const app = createApp('session');
    const res = await app.request('/teams/team-abc123');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('team-abc123');
    expect(body.data.memberCount).toBe(4);
    expect(body.data.projectCount).toBe(2);
    expect(body.data.myRole).toBe('admin');
  });

  it('returns 404 when team does not exist', async () => {
    mockRbacService.resolveTeamRole.mockResolvedValue('owner');
    mockRbacService.hasMinimumRole.mockReturnValue(true);

    mockDb.query.teams.findFirst.mockResolvedValue(undefined);

    // Member count
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ total: 0 }]),
      }),
    });
    // Project count
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ total: 0 }]),
      }),
    });

    const app = createApp('session');
    const res = await app.request('/teams/team-abc123');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when user is not a team member', async () => {
    // resolveTeamRole returns null → not a member
    mockRbacService.resolveTeamRole.mockResolvedValue(null);
    mockRbacService.hasMinimumRole.mockReturnValue(false);

    const app = createApp('session');
    const res = await app.request('/teams/team-abc123');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for an invalid team ID', async () => {
    const app = createApp('session');
    const res = await app.request('/teams/!!!invalid!!!');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });
});

// ===========================================================================
// PATCH /teams/:id — Update team
// ===========================================================================

describe('PATCH /teams/:id', () => {
  it('updates team when caller is admin and returns updated data', async () => {
    mockRbacService.resolveTeamRole.mockResolvedValue('admin');
    mockRbacService.hasMinimumRole.mockReturnValue(true);

    const updatedTeam = { ...sampleTeam, name: 'Updated Name' };
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedTeam]),
        }),
      }),
    });

    const app = createApp('session');
    const res = await app.request('/teams/team-abc123', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Name' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('Updated Name');
  });

  it('returns 403 when caller lacks admin role', async () => {
    mockRbacService.resolveTeamRole.mockResolvedValue('viewer');
    mockRbacService.hasMinimumRole.mockReturnValue(false);

    const app = createApp('session');
    const res = await app.request('/teams/team-abc123', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sneaky Update' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('returns 404 when team does not exist during update', async () => {
    mockRbacService.resolveTeamRole.mockResolvedValue('admin');
    mockRbacService.hasMinimumRole.mockReturnValue(true);

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]), // empty → not found
        }),
      }),
    });

    const app = createApp('session');
    const res = await app.request('/teams/team-abc123', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ghost Team' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for invalid ID format on update', async () => {
    const app = createApp('session');
    const res = await app.request('/teams/bad id!', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });
});

// ===========================================================================
// POST /teams/:id/transfer-ownership
// ===========================================================================

describe('POST /teams/:id/transfer-ownership', () => {
  it('transfers ownership successfully when target is a member', async () => {
    mockRbacService.resolveTeamRole.mockResolvedValue('owner');
    mockRbacService.hasMinimumRole.mockReturnValue(true);

    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => {
      const tx = {
        ...mockDb,
        query: {
          teams: { findFirst: vi.fn() },
          teamMembers: {
            findFirst: vi.fn().mockResolvedValue({ teamId: 'team-abc123', userId: 'user-2', role: 'admin' }),
          },
        },
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      return fn(tx as never);
    });

    const app = createApp('session', 'user-1');
    const res = await app.request('/teams/team-abc123/transfer-ownership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserId: 'user-2' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.newOwnerId).toBe('user-2');
    expect(body.data.previousOwnerId).toBe('user-1');
  });

  it('returns 400 when attempting to transfer ownership to self', async () => {
    mockRbacService.resolveTeamRole.mockResolvedValue('owner');
    mockRbacService.hasMinimumRole.mockReturnValue(true);

    const app = createApp('session', 'user-1');
    const res = await app.request('/teams/team-abc123/transfer-ownership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserId: 'user-1' }), // same as current user
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('CANNOT_TRANSFER_TO_SELF');
  });

  it('returns 404 when target user is not a team member', async () => {
    mockRbacService.resolveTeamRole.mockResolvedValue('owner');
    mockRbacService.hasMinimumRole.mockReturnValue(true);

    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => {
      const tx = {
        ...mockDb,
        query: {
          teams: { findFirst: vi.fn() },
          teamMembers: {
            findFirst: vi.fn().mockResolvedValue(undefined), // not a member
          },
        },
        update: vi.fn(),
      };
      return fn(tx as never);
    });

    const app = createApp('session', 'user-1');
    const res = await app.request('/teams/team-abc123/transfer-ownership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserId: 'user-outsider' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MEMBER_NOT_FOUND');
  });

  it('returns 403 when caller is not an owner', async () => {
    mockRbacService.resolveTeamRole.mockResolvedValue('admin');
    mockRbacService.hasMinimumRole.mockReturnValue(false);

    const app = createApp('session', 'user-1');
    const res = await app.request('/teams/team-abc123/transfer-ownership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserId: 'user-2' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });
});

// ===========================================================================
// DELETE /teams/:id — Delete team
// ===========================================================================

describe('DELETE /teams/:id', () => {
  it('deletes team and all associated data when caller is owner', async () => {
    mockRbacService.resolveTeamRole.mockResolvedValue('owner');
    mockRbacService.hasMinimumRole.mockReturnValue(true);

    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => {
      const tx = {
        ...mockDb,
        query: {
          teams: {
            findFirst: vi.fn().mockResolvedValue(sampleTeam),
          },
          teamMembers: { findFirst: vi.fn() },
        },
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      };
      return fn(tx as never);
    });

    const app = createApp('session', 'user-1');
    const res = await app.request('/teams/team-abc123', { method: 'DELETE' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);
  });

  it('returns 403 when caller is not an owner', async () => {
    mockRbacService.resolveTeamRole.mockResolvedValue('admin');
    mockRbacService.hasMinimumRole.mockReturnValue(false);

    const app = createApp('session', 'user-1');
    const res = await app.request('/teams/team-abc123', { method: 'DELETE' });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('returns 404 when the team does not exist', async () => {
    mockRbacService.resolveTeamRole.mockResolvedValue('owner');
    mockRbacService.hasMinimumRole.mockReturnValue(true);

    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => {
      const tx = {
        ...mockDb,
        query: {
          teams: {
            findFirst: vi.fn().mockResolvedValue(undefined), // team not found
          },
          teamMembers: { findFirst: vi.fn() },
        },
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      };
      return fn(tx as never);
    });

    const app = createApp('session', 'user-1');
    const res = await app.request('/teams/team-abc123', { method: 'DELETE' });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for an invalid team ID', async () => {
    const app = createApp('session');
    const res = await app.request('/teams/!!!bad!!!', { method: 'DELETE' });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_ID');
  });
});
