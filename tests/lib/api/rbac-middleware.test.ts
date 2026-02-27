/**
 * Tests for RBAC Middleware
 *
 * Covers:
 * - enrichAuthContext(db): enriches auth context with RBAC information
 * - requireRole(minimumRole, rbacService): enforces minimum role on routes
 * - requireTagAccess(db): tag-based access control for API tokens
 * - C4 token format validation patterns
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RBAC_ROLE_LEVEL } from '../../../src/db/schema/shared/enums';
import type { RbacRole } from '../../../src/db/schema/shared/enums';
import type { AuthContext } from '../../../src/lib/api/auth-middleware';
import {
  enrichAuthContext,
  requireRole,
  requireTagAccess,
} from '../../../src/lib/api/rbac-middleware';

// =============================================================================
// Mock Database Factory
// =============================================================================

function createMockDb() {
  const updateChain = {
    set: vi.fn(),
    where: vi.fn(),
  };
  updateChain.set.mockReturnValue(updateChain);
  updateChain.where.mockReturnValue(
    Object.assign(Promise.resolve(undefined), {
      catch: vi.fn().mockResolvedValue(undefined),
    })
  );

  return {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(),
    update: vi.fn().mockReturnValue(updateChain),
  };
}

type MockDb = ReturnType<typeof createMockDb>;

// =============================================================================
// Mock RbacService Factory
// =============================================================================

function createMockRbacService() {
  return {
    hasMinimumRole: vi.fn(),
    resolveUserRole: vi.fn(),
    resolveTeamRole: vi.fn(),
    resolveGlobalRole: vi.fn(),
    applyTokenCeiling: vi.fn(),
    checkProjectScope: vi.fn(),
    checkTagAccess: vi.fn(),
    canPerformAction: vi.fn(),
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Creates a middleware that pre-sets auth context (and optional cached token).
 */
function createAuthMiddleware(auth: AuthContext | undefined, resolvedToken?: object) {
  return async (c: Context, next: Next) => {
    if (auth !== undefined) {
      c.set('auth', auth);
    }
    if (resolvedToken !== undefined) {
      c.set('_resolvedApiToken', resolvedToken);
    }
    await next();
  };
}

/**
 * Creates a simple select chain mock: select({...}).from(table).where(cond)
 * resolves with `resolvedValue`.
 */
function buildSelectChain(resolvedValue: unknown) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockResolvedValue(resolvedValue);
  return chain;
}

// =============================================================================
// enrichAuthContext Tests
// =============================================================================

describe('enrichAuthContext', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
    vi.clearAllMocks();
  });

  it('returns 401 when no auth context is present', async () => {
    const app = new Hono();
    app.use('*', enrichAuthContext(mockDb as never) as never);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('skips DB lookup for dev auth method and proceeds immediately', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const auth: AuthContext = { userId: 'dev-user', authMethod: 'dev' };

      const app = new Hono();
      app.use('*', createAuthMiddleware(auth) as never);
      app.use('*', enrichAuthContext(mockDb as never) as never);
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test');
      expect(res.status).toBe(200);
      // DB should not have been queried for dev users
      expect(mockDb.query.users.findFirst).not.toHaveBeenCalled();
      expect(mockDb.select).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('grants owner role to dev auth method users', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const auth: AuthContext = { userId: 'dev-user', authMethod: 'dev' };
      let capturedAuth: AuthContext | undefined;

      const app = new Hono();
      app.use('*', createAuthMiddleware(auth) as never);
      app.use('*', enrichAuthContext(mockDb as never) as never);
      app.get('/test', (c) => {
        capturedAuth = c.get('auth') as AuthContext;
        return c.json({ ok: true });
      });

      await app.request('/test');
      expect(capturedAuth?.resolvedRole).toBe('owner');
      expect(capturedAuth?.roleLevel).toBe(RBAC_ROLE_LEVEL.owner);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('skips token update for session auth method (no api_token path)', async () => {
    const auth: AuthContext = { userId: 'user-123', authMethod: 'session' };

    mockDb.query.users.findFirst.mockResolvedValue({
      id: 'user-123',
      githubId: 1,
      githubLogin: 'testuser',
      name: 'Test User',
      email: 'test@example.com',
      avatarUrl: null,
    });
    const selectChain = buildSelectChain([]);
    mockDb.select.mockReturnValue(selectChain);

    const app = new Hono();
    app.use('*', createAuthMiddleware(auth) as never);
    app.use('*', enrichAuthContext(mockDb as never) as never);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    // No token update should have occurred for session auth
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('populates tokenScope from cached _resolvedApiToken (H1)', async () => {
    const auth: AuthContext = { userId: 'user-123', authMethod: 'api_token' };
    const cachedToken = {
      id: 'token-abc',
      role: 'admin',
      scopeProjectId: 'proj-1',
      scopeTags: ['tag-a', 'tag-b'],
      expiresAt: null,
    };

    mockDb.query.users.findFirst.mockResolvedValue({
      id: 'user-123',
      githubId: 1,
      githubLogin: 'testuser',
      name: 'Test User',
      email: null,
      avatarUrl: null,
    });
    const selectChain = buildSelectChain([{ teamId: 'team-1', role: 'admin' }]);
    mockDb.select.mockReturnValue(selectChain);

    let capturedAuth: AuthContext | undefined;
    const app = new Hono();
    app.use('*', createAuthMiddleware(auth, cachedToken) as never);
    app.use('*', enrichAuthContext(mockDb as never) as never);
    app.get('/test', (c) => {
      capturedAuth = c.get('auth') as AuthContext;
      return c.json({ ok: true });
    });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(capturedAuth?.tokenScope).toEqual({
      tokenId: 'token-abc',
      role: 'admin',
      projectId: 'proj-1',
      tags: ['tag-a', 'tag-b'],
    });
  });

  it('applies token ceiling when token role is lower than membership role', async () => {
    const auth: AuthContext = { userId: 'user-123', authMethod: 'api_token' };
    const cachedToken = {
      id: 'token-abc',
      role: 'viewer', // token caps at viewer
      scopeProjectId: null,
      scopeTags: null,
      expiresAt: null,
    };

    mockDb.query.users.findFirst.mockResolvedValue({
      id: 'user-123',
      githubId: 1,
      githubLogin: 'testuser',
      name: null,
      email: null,
      avatarUrl: null,
    });
    // User is owner via team membership
    const selectChain = buildSelectChain([{ teamId: 'team-1', role: 'owner' }]);
    mockDb.select.mockReturnValue(selectChain);

    let capturedAuth: AuthContext | undefined;
    const app = new Hono();
    app.use('*', createAuthMiddleware(auth, cachedToken) as never);
    app.use('*', enrichAuthContext(mockDb as never) as never);
    app.get('/test', (c) => {
      capturedAuth = c.get('auth') as AuthContext;
      return c.json({ ok: true });
    });

    await app.request('/test');
    // Token ceiling: owner(4) > viewer(1) → capped to viewer
    expect(capturedAuth?.resolvedRole).toBe('viewer');
    expect(capturedAuth?.roleLevel).toBe(RBAC_ROLE_LEVEL.viewer);
  });

  it('returns 401 for an expired API token', async () => {
    const auth: AuthContext = { userId: 'user-123', authMethod: 'api_token' };
    const expiredToken = {
      id: 'token-expired',
      role: 'admin',
      scopeProjectId: null,
      scopeTags: null,
      expiresAt: new Date(Date.now() - 60_000).toISOString(), // expired 1 minute ago
    };

    mockDb.query.users.findFirst.mockResolvedValue({
      id: 'user-123',
      githubId: 1,
      githubLogin: 'testuser',
      name: null,
      email: null,
      avatarUrl: null,
    });
    const selectChain = buildSelectChain([]);
    mockDb.select.mockReturnValue(selectChain);

    const app = new Hono();
    app.use('*', createAuthMiddleware(auth, expiredToken) as never);
    app.use('*', enrichAuthContext(mockDb as never) as never);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toContain('expired');
  });

  it('accepts a token with a future expiry date', async () => {
    const auth: AuthContext = { userId: 'user-123', authMethod: 'api_token' };
    const validToken = {
      id: 'token-valid',
      role: 'admin',
      scopeProjectId: null,
      scopeTags: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), // expires in 1 hour
    };

    mockDb.query.users.findFirst.mockResolvedValue({
      id: 'user-123',
      githubId: 1,
      githubLogin: 'testuser',
      name: null,
      email: null,
      avatarUrl: null,
    });
    const selectChain = buildSelectChain([]);
    mockDb.select.mockReturnValue(selectChain);

    const app = new Hono();
    app.use('*', createAuthMiddleware(auth, validToken) as never);
    app.use('*', enrichAuthContext(mockDb as never) as never);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('returns 401 when API token is not cached (_resolvedApiToken missing)', async () => {
    const auth: AuthContext = { userId: 'user-123', authMethod: 'api_token' };
    // No cached token passed

    mockDb.query.users.findFirst.mockResolvedValue({
      id: 'user-123',
      githubId: 1,
      githubLogin: 'testuser',
      name: null,
      email: null,
      avatarUrl: null,
    });
    const selectChain = buildSelectChain([]);
    mockDb.select.mockReturnValue(selectChain);

    const app = new Hono();
    app.use('*', createAuthMiddleware(auth, undefined) as never); // no cached token
    app.use('*', enrichAuthContext(mockDb as never) as never);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('fires update for lastUsedAt and useCount asynchronously for api_token', async () => {
    const auth: AuthContext = { userId: 'user-123', authMethod: 'api_token' };
    const cachedToken = {
      id: 'token-track',
      role: 'viewer',
      scopeProjectId: null,
      scopeTags: null,
      expiresAt: null,
    };

    mockDb.query.users.findFirst.mockResolvedValue({
      id: 'user-123',
      githubId: 1,
      githubLogin: 'testuser',
      name: null,
      email: null,
      avatarUrl: null,
    });
    const selectChain = buildSelectChain([]);
    mockDb.select.mockReturnValue(selectChain);

    const app = new Hono();
    app.use('*', createAuthMiddleware(auth, cachedToken) as never);
    app.use('*', enrichAuthContext(mockDb as never) as never);
    app.get('/test', (c) => c.json({ ok: true }));

    await app.request('/test');

    // db.update() should have been called for usage tracking (fire-and-forget)
    expect(mockDb.update).toHaveBeenCalled();
  });
});

// =============================================================================
// requireRole Tests
// =============================================================================

describe('requireRole', () => {
  let mockRbacService: ReturnType<typeof createMockRbacService>;

  beforeEach(() => {
    mockRbacService = createMockRbacService();
    vi.clearAllMocks();
  });

  it('allows dev mode users to pass without performing a role check', async () => {
    const auth: AuthContext = {
      userId: 'dev-user',
      authMethod: 'dev',
      resolvedRole: 'owner',
      roleLevel: RBAC_ROLE_LEVEL.owner,
    };

    const app = new Hono();
    app.use('*', createAuthMiddleware(auth) as never);
    app.use('*', requireRole('admin', mockRbacService as never) as never);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(mockRbacService.hasMinimumRole).not.toHaveBeenCalled();
    expect(mockRbacService.resolveUserRole).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no auth context', async () => {
    const app = new Hono();
    // No auth middleware — no auth context set
    app.use('*', requireRole('viewer', mockRbacService as never) as never);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 403 when user has no resolved role (no team membership)', async () => {
    const auth: AuthContext = {
      userId: 'user-norole',
      authMethod: 'session',
      // resolvedRole intentionally omitted
    };

    const app = new Hono();
    app.use('*', createAuthMiddleware(auth) as never);
    app.use('*', requireRole('viewer', mockRbacService as never) as never);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('allows users with sufficient global role when no project context is present', async () => {
    const auth: AuthContext = {
      userId: 'user-admin',
      authMethod: 'session',
      resolvedRole: 'admin',
      roleLevel: RBAC_ROLE_LEVEL.admin,
    };
    mockRbacService.hasMinimumRole.mockReturnValue(true);

    const app = new Hono();
    app.use('*', createAuthMiddleware(auth) as never);
    app.use('*', requireRole('viewer', mockRbacService as never) as never);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('denies users with insufficient global role (no project context)', async () => {
    const auth: AuthContext = {
      userId: 'user-viewer',
      authMethod: 'session',
      resolvedRole: 'viewer',
      roleLevel: RBAC_ROLE_LEVEL.viewer,
    };
    mockRbacService.hasMinimumRole.mockReturnValue(false);

    const app = new Hono();
    app.use('*', createAuthMiddleware(auth) as never);
    app.use('*', requireRole('admin', mockRbacService as never) as never);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toContain('admin');
  });

  it('resolves project-scoped role when project :id param is present (route-level middleware)', async () => {
    const auth: AuthContext = {
      userId: 'user-123',
      authMethod: 'session',
      resolvedRole: 'admin',
      roleLevel: RBAC_ROLE_LEVEL.admin,
    };
    mockRbacService.resolveUserRole.mockResolvedValue('admin' as RbacRole);
    mockRbacService.hasMinimumRole.mockReturnValue(true);

    // Mount middleware at route level so c.req.param('id') is resolved
    const mw = requireRole('viewer', mockRbacService as never) as never;
    const app = new Hono();
    app.get(
      '/api/projects/:id',
      createAuthMiddleware(auth) as never,
      mw,
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/api/projects/proj-1');
    expect(res.status).toBe(200);
    expect(mockRbacService.resolveUserRole).toHaveBeenCalledWith('user-123', 'proj-1');
  });

  it('denies project-scoped access when user has no project role', async () => {
    const auth: AuthContext = {
      userId: 'user-123',
      authMethod: 'session',
      resolvedRole: 'viewer',
      roleLevel: RBAC_ROLE_LEVEL.viewer,
    };
    mockRbacService.resolveUserRole.mockResolvedValue(null);
    mockRbacService.hasMinimumRole.mockReturnValue(false);

    const mw = requireRole('viewer', mockRbacService as never) as never;
    const app = new Hono();
    app.get(
      '/api/projects/:id',
      createAuthMiddleware(auth) as never,
      mw,
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/api/projects/proj-1');
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// requireTagAccess Tests
// =============================================================================

describe('requireTagAccess', () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
    vi.clearAllMocks();
  });

  it('skips tag check for dev auth method', async () => {
    const auth: AuthContext = {
      userId: 'dev-user',
      authMethod: 'dev',
      tokenScope: {
        tokenId: 'tk-1',
        role: 'admin',
        projectId: null,
        tags: ['restricted-tag'],
      },
    };

    const mw = requireTagAccess(mockDb as never) as never;
    const app = new Hono();
    app.get(
      '/api/projects/:id',
      createAuthMiddleware(auth) as never,
      mw,
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/api/projects/proj-1');
    expect(res.status).toBe(200);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('skips tag check for session auth method', async () => {
    const auth: AuthContext = {
      userId: 'user-123',
      authMethod: 'session',
    };

    const mw = requireTagAccess(mockDb as never) as never;
    const app = new Hono();
    app.get(
      '/api/projects/:id',
      createAuthMiddleware(auth) as never,
      mw,
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/api/projects/proj-1');
    expect(res.status).toBe(200);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('skips tag check when api_token has no tag restrictions (null tags)', async () => {
    const auth: AuthContext = {
      userId: 'user-123',
      authMethod: 'api_token',
      tokenScope: {
        tokenId: 'tk-1',
        role: 'admin',
        projectId: null,
        tags: null, // no tag restriction
      },
    };

    const mw = requireTagAccess(mockDb as never) as never;
    const app = new Hono();
    app.get(
      '/api/projects/:id',
      createAuthMiddleware(auth) as never,
      mw,
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/api/projects/proj-1');
    expect(res.status).toBe(200);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('skips tag check when api_token has empty tag array', async () => {
    const auth: AuthContext = {
      userId: 'user-123',
      authMethod: 'api_token',
      tokenScope: {
        tokenId: 'tk-1',
        role: 'admin',
        projectId: null,
        tags: [], // empty = no restriction
      },
    };

    const mw = requireTagAccess(mockDb as never) as never;
    const app = new Hono();
    app.get(
      '/api/projects/:id',
      createAuthMiddleware(auth) as never,
      mw,
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/api/projects/proj-1');
    expect(res.status).toBe(200);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('allows access when tag-restricted token has matching tags on project resource', async () => {
    const auth: AuthContext = {
      userId: 'user-123',
      authMethod: 'api_token',
      tokenScope: {
        tokenId: 'tk-1',
        role: 'admin',
        projectId: null,
        tags: ['production'],
      },
    };

    // projectTags query returns matching tag
    const chain = buildSelectChain([{ tagId: 'production' }]);
    mockDb.select.mockReturnValue(chain);

    const mw = requireTagAccess(mockDb as never) as never;
    const app = new Hono();
    app.get(
      '/api/projects/:id',
      createAuthMiddleware(auth) as never,
      mw,
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/api/projects/proj-1');
    expect(res.status).toBe(200);
  });

  it('denies access when tag-restricted token has no tag overlap with project resource', async () => {
    const auth: AuthContext = {
      userId: 'user-123',
      authMethod: 'api_token',
      tokenScope: {
        tokenId: 'tk-1',
        role: 'admin',
        projectId: null,
        tags: ['production'],
      },
    };

    // Project has 'staging' tag, token requires 'production'
    const chain = buildSelectChain([{ tagId: 'staging' }]);
    mockDb.select.mockReturnValue(chain);

    const mw = requireTagAccess(mockDb as never) as never;
    const app = new Hono();
    app.get(
      '/api/projects/:id',
      createAuthMiddleware(auth) as never,
      mw,
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/api/projects/proj-1');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('denies access when resource has no tags (invisible to tag-restricted token)', async () => {
    const auth: AuthContext = {
      userId: 'user-123',
      authMethod: 'api_token',
      tokenScope: {
        tokenId: 'tk-1',
        role: 'admin',
        projectId: null,
        tags: ['production'],
      },
    };

    // Project has no tags
    const chain = buildSelectChain([]); // no tags
    mockDb.select.mockReturnValue(chain);

    const mw = requireTagAccess(mockDb as never) as never;
    const app = new Hono();
    app.get(
      '/api/projects/:id',
      createAuthMiddleware(auth) as never,
      mw,
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/api/projects/proj-1');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toContain('tag-restricted token');
  });

  it('allows access for task resource type when tags match', async () => {
    const auth: AuthContext = {
      userId: 'user-123',
      authMethod: 'api_token',
      tokenScope: {
        tokenId: 'tk-1',
        role: 'admin',
        projectId: null,
        tags: ['production'],
      },
    };

    // taskTags returns matching tag
    const chain = buildSelectChain([{ tagId: 'production' }]);
    mockDb.select.mockReturnValue(chain);

    const mw = requireTagAccess(mockDb as never) as never;
    const app = new Hono();
    app.get(
      '/api/tasks/:id',
      createAuthMiddleware(auth) as never,
      mw,
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/api/tasks/task-1');
    expect(res.status).toBe(200);
  });

  it('task resource falls back to parent project tags when task has no direct tags', async () => {
    const auth: AuthContext = {
      userId: 'user-123',
      authMethod: 'api_token',
      tokenScope: {
        tokenId: 'tk-1',
        role: 'admin',
        projectId: null,
        tags: ['production'],
      },
    };

    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      const chain = buildSelectChain(undefined); // placeholder
      if (callCount === 1) {
        // taskTags query returns empty (no task-level tags)
        chain.where.mockResolvedValue([]);
      } else if (callCount === 2) {
        // tasks query to get projectId
        chain.where.mockResolvedValue([{ projectId: 'proj-fallback' }]);
      } else {
        // projectTags for the parent project → matching tag
        chain.where.mockResolvedValue([{ tagId: 'production' }]);
      }
      return chain;
    });

    const mw = requireTagAccess(mockDb as never) as never;
    const app = new Hono();
    app.get(
      '/api/tasks/:id',
      createAuthMiddleware(auth) as never,
      mw,
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/api/tasks/task-1');
    expect(res.status).toBe(200);
    // select was called 3 times: taskTags, tasks (for projectId), projectTags
    expect(callCount).toBe(3);
  });

  it('allows access for session resource type when project tags match', async () => {
    const auth: AuthContext = {
      userId: 'user-123',
      authMethod: 'api_token',
      tokenScope: {
        tokenId: 'tk-1',
        role: 'admin',
        projectId: null,
        tags: ['team-alpha'],
      },
    };

    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      const chain = buildSelectChain(undefined);
      if (callCount === 1) {
        // sessions query returns session with projectId (no taskId)
        chain.where.mockResolvedValue([{ taskId: null, projectId: 'proj-1' }]);
      } else {
        // projectTags for the project → matching tag
        chain.where.mockResolvedValue([{ tagId: 'team-alpha' }]);
      }
      return chain;
    });

    const mw = requireTagAccess(mockDb as never) as never;
    const app = new Hono();
    app.get(
      '/api/sessions/:id',
      createAuthMiddleware(auth) as never,
      mw,
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/api/sessions/sess-1');
    expect(res.status).toBe(200);
  });

  it('allows access for agent resource type when project tags match', async () => {
    const auth: AuthContext = {
      userId: 'user-123',
      authMethod: 'api_token',
      tokenScope: {
        tokenId: 'tk-1',
        role: 'admin',
        projectId: null,
        tags: ['infra'],
      },
    };

    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      const chain = buildSelectChain(undefined);
      if (callCount === 1) {
        // agents query returns agent with projectId
        chain.where.mockResolvedValue([{ projectId: 'proj-infra' }]);
      } else {
        // projectTags for the project → matching tag
        chain.where.mockResolvedValue([{ tagId: 'infra' }]);
      }
      return chain;
    });

    const mw = requireTagAccess(mockDb as never) as never;
    const app = new Hono();
    app.get(
      '/api/agents/:id',
      createAuthMiddleware(auth) as never,
      mw,
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/api/agents/agent-1');
    expect(res.status).toBe(200);
  });

  it('returns 401 when called with no auth context', async () => {
    const mw = requireTagAccess(mockDb as never) as never;
    const app = new Hono();
    app.get('/api/projects/:id', mw, (c) => c.json({ ok: true }));

    const res = await app.request('/api/projects/proj-1');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('denies tag-restricted token on unrecognized resource paths', async () => {
    const auth: AuthContext = {
      userId: 'user-123',
      authMethod: 'api_token',
      tokenScope: {
        tokenId: 'tk-1',
        role: 'admin',
        projectId: null,
        tags: ['restricted'],
      },
    };

    // Global middleware for a non-resource path
    const app = new Hono();
    app.use('*', createAuthMiddleware(auth) as never);
    app.use('*', requireTagAccess(mockDb as never) as never);
    app.get('/api/health', (c) => c.json({ ok: true }));

    const res = await app.request('/api/health');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toBe('Tag-restricted tokens cannot access this resource type');
  });
});

// =============================================================================
// C4 Token Format Validation Tests
// =============================================================================

describe('C4 token format validation', () => {
  /**
   * Valid AgentPane API tokens must match:
   *   ap_[A-Za-z0-9_-]{42,44}
   * These tests validate that regex pattern against various inputs.
   */
  const AP_TOKEN_REGEX = /^ap_[A-Za-z0-9_-]{42,44}$/;

  it('accepts a valid token with exactly 42 characters after the prefix', () => {
    const token = 'ap_' + 'a'.repeat(42);
    expect(AP_TOKEN_REGEX.test(token)).toBe(true);
  });

  it('accepts a valid token with 43 characters after the prefix', () => {
    const token = 'ap_' + 'b'.repeat(43);
    expect(AP_TOKEN_REGEX.test(token)).toBe(true);
  });

  it('accepts a valid token with 44 characters after the prefix', () => {
    const token = 'ap_' + 'c'.repeat(44);
    expect(AP_TOKEN_REGEX.test(token)).toBe(true);
  });

  it('accepts tokens with mixed alphanumeric, underscore, and hyphen characters', () => {
    // 'aB3-xY_z9' = 9 chars, repeat(4) = 36 chars, plus '---aB3456' = 9 chars → total = 45 chars
    // Use a simpler construction: 42 alphanum + special chars
    const token = 'ap_' + 'aB3-xY_z'.repeat(5) + 'aB'; // 8*5=40 + 2 = 42 chars
    expect(token.length).toBe(45); // 3 + 42
    expect(AP_TOKEN_REGEX.test(token)).toBe(true);
  });

  it('rejects short tokens with fewer than 42 characters after the prefix', () => {
    const token = 'ap_' + 'a'.repeat(41); // one too short
    expect(AP_TOKEN_REGEX.test(token)).toBe(false);
  });

  it('rejects tokens with more than 44 characters after the prefix', () => {
    const token = 'ap_' + 'a'.repeat(45); // one too long
    expect(AP_TOKEN_REGEX.test(token)).toBe(false);
  });

  it('rejects tokens without the ap_ prefix', () => {
    const token = 'sk_' + 'a'.repeat(42);
    expect(AP_TOKEN_REGEX.test(token)).toBe(false);
  });

  it('rejects tokens with no prefix at all', () => {
    const token = 'a'.repeat(45);
    expect(AP_TOKEN_REGEX.test(token)).toBe(false);
  });

  it('rejects tokens containing special characters such as @ or #', () => {
    const tokenAt = 'ap_' + 'a'.repeat(41) + '@';
    const tokenHash = 'ap_' + 'a'.repeat(41) + '#';
    expect(AP_TOKEN_REGEX.test(tokenAt)).toBe(false);
    expect(AP_TOKEN_REGEX.test(tokenHash)).toBe(false);
  });

  it('rejects tokens containing spaces', () => {
    const token = 'ap_' + 'a'.repeat(41) + ' ';
    expect(AP_TOKEN_REGEX.test(token)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(AP_TOKEN_REGEX.test('')).toBe(false);
  });

  it('rejects the prefix alone with no suffix characters', () => {
    expect(AP_TOKEN_REGEX.test('ap_')).toBe(false);
  });
});
