/**
 * Integration tests for rbac-middleware.ts (slice H).
 *
 * Comprehensively exercise enrichAuthContext, requireRole, requireTagAccess,
 * getAccessibleResourceIds, and applyTokenTagFilter — covering dev-mode
 * security gates, session-user role resolution, API-token expiry/cap/scope,
 * codespace-scoped role checks, tag-based collection filters, and per-resource
 * tag denial paths.
 */

import { createId } from '@paralleldrive/cuid2';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, apiTokens, codespaceTags, tags, taskTags, teamMembers } from '../../src/db/schema';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import {
  applyTokenTagFilter,
  enrichAuthContext,
  getAccessibleResourceIds,
  requireRole,
  requireTagAccess,
} from '../../src/lib/api/rbac-middleware';
import { RbacService } from '../../src/services/rbac.service';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestTeam, createTestTeamMember } from '../factories/team.factory';
import { createTestUser } from '../factories/user.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const ORIG_NODE_ENV = process.env.NODE_ENV;
const ORIG_SKIP_AUTH = process.env.SKIP_AUTH;

function restoreEnv() {
  if (ORIG_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIG_NODE_ENV;
  if (ORIG_SKIP_AUTH === undefined) delete process.env.SKIP_AUTH;
  else process.env.SKIP_AUTH = ORIG_SKIP_AUTH;
}

function buildApp(opts: {
  db: ReturnType<typeof getTestDb>;
  initialAuth?: AuthContext | null;
  preMiddleware?: (c: any) => void;
  routes?: (app: Hono) => void;
}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (opts.initialAuth !== undefined && opts.initialAuth !== null) {
      c.set('auth', opts.initialAuth);
    }
    if (opts.preMiddleware) opts.preMiddleware(c);
    await next();
  });
  app.use('*', enrichAuthContext(opts.db as never));
  if (opts.routes) opts.routes(app);
  return app;
}

describe('rbac-middleware (IT-1900)', () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    process.env.NODE_ENV = 'development';
    process.env.SKIP_AUTH = 'true';
  });

  afterEach(async () => {
    restoreEnv();
    await clearTestDatabase();
    vi.restoreAllMocks();
  });

  // ─── enrichAuthContext ───────────────────────────────

  it('IT-1900-1: passes through when no auth is set', async () => {
    const app = buildApp({
      db,
      routes: (a) => {
        a.get('/probe', (c) => {
          const auth = c.get('auth' as never) as AuthContext | undefined;
          return c.json({ ok: true, hasAuth: !!auth });
        });
      },
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasAuth).toBe(false);
  });

  it('IT-1900-2: dev-mode promotes to owner role when isDevAuthAllowed', async () => {
    const app = buildApp({
      db,
      initialAuth: { userId: 'dev-user', authMethod: 'dev' },
      routes: (a) => {
        a.get('/probe', (c) => {
          const auth = c.get('auth' as never) as AuthContext;
          return c.json({ resolvedRole: auth.resolvedRole, roleLevel: auth.roleLevel });
        });
      },
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolvedRole).toBe('owner');
    expect(body.roleLevel).toBeGreaterThan(0);
  });

  it('IT-1900-3: dev-mode rejected when isDevAuthAllowed=false (production)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SKIP_AUTH = 'false';
    const app = buildApp({
      db,
      initialAuth: { userId: 'dev-user', authMethod: 'dev' },
      routes: (a) => {
        a.get('/probe', (c) => c.json({ ok: true }));
      },
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('IT-1900-4: session user not found → 401', async () => {
    const app = buildApp({
      db,
      initialAuth: { userId: 'no-such-user', authMethod: 'session' },
      routes: (a) => {
        a.get('/probe', (c) => c.json({ ok: true }));
      },
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toContain('User account not found');
  });

  it('IT-1900-5: session user with team memberships gets resolved role + memberships', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    await createTestTeamMember(team.id, user.id, { role: 'admin' });
    const app = buildApp({
      db,
      initialAuth: { userId: user.id, authMethod: 'session' },
      routes: (a) => {
        a.get('/probe', (c) => {
          const auth = c.get('auth' as never) as AuthContext;
          return c.json({
            role: auth.resolvedRole,
            user: auth.user?.githubLogin,
            memberships: auth.teamMemberships,
          });
        });
      },
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe('admin');
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].teamId).toBe(team.id);
  });

  it('IT-1900-6: session user with NO teams has user but no resolvedRole', async () => {
    const user = await createTestUser();
    const app = buildApp({
      db,
      initialAuth: { userId: user.id, authMethod: 'session' },
      routes: (a) => {
        a.get('/probe', (c) => {
          const auth = c.get('auth' as never) as AuthContext;
          return c.json({ resolvedRole: auth.resolvedRole ?? null, hasUser: !!auth.user });
        });
      },
    });
    const res = await app.request('http://localhost/probe');
    const body = await res.json();
    expect(body.resolvedRole).toBeNull();
    expect(body.hasUser).toBe(true);
  });

  it('IT-1900-7: session user with invalid-role memberships logs and skips them', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    // Insert an invalid role directly (bypassing the assignable-role schema)
    await db
      .insert(teamMembers)
      .values({ teamId: team.id, userId: user.id, role: 'NOT_A_REAL_ROLE' as never });
    const app = buildApp({
      db,
      initialAuth: { userId: user.id, authMethod: 'session' },
      routes: (a) => {
        a.get('/probe', (c) => {
          const auth = c.get('auth' as never) as AuthContext;
          return c.json({
            memberships: auth.teamMemberships ?? [],
            role: auth.resolvedRole ?? null,
          });
        });
      },
    });
    const res = await app.request('http://localhost/probe');
    const body = await res.json();
    expect(body.memberships).toEqual([]);
    expect(body.role).toBeNull();
  });

  it('IT-1900-8: api_token cached and applied to auth (capping role)', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    await createTestTeamMember(team.id, user.id, { role: 'owner' });

    // Insert api token
    const tokenId = createId();
    await db.insert(apiTokens).values({
      id: tokenId,
      userId: user.id,
      teamId: team.id,
      name: 'tok',
      tokenHash: 'h-' + tokenId,
      tokenPrefix: 'agp_',
      role: 'viewer',
      status: 'active',
    });

    const app = buildApp({
      db,
      initialAuth: { userId: user.id, authMethod: 'api_token' },
      preMiddleware: (c) => {
        c.set('_resolvedApiToken', {
          id: tokenId,
          role: 'viewer',
          scopeCodespaceId: null,
          scopeTags: null,
          expiresAt: null,
        });
      },
      routes: (a) => {
        a.get('/probe', (c) => {
          const auth = c.get('auth' as never) as AuthContext;
          return c.json({ role: auth.resolvedRole, scope: auth.tokenScope });
        });
      },
    });

    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(200);
    const body = await res.json();
    // Token cap: viewer < owner so resolved role = viewer
    expect(body.role).toBe('viewer');
    expect(body.scope.tokenId).toBe(tokenId);
  });

  it('IT-1900-9: api_token without membership uses token role as effective role', async () => {
    const user = await createTestUser();
    const tokenId = createId();
    const team = await createTestTeam();
    await db.insert(apiTokens).values({
      id: tokenId,
      userId: user.id,
      teamId: team.id,
      name: 'tok',
      tokenHash: 'h-' + tokenId,
      tokenPrefix: 'agp_',
      role: 'admin',
      status: 'active',
    });
    const app = buildApp({
      db,
      initialAuth: { userId: user.id, authMethod: 'api_token' },
      preMiddleware: (c) => {
        c.set('_resolvedApiToken', {
          id: tokenId,
          role: 'admin',
          scopeCodespaceId: null,
          scopeTags: null,
          expiresAt: null,
        });
      },
      routes: (a) => {
        a.get('/probe', (c) => {
          const auth = c.get('auth' as never) as AuthContext;
          return c.json({ role: auth.resolvedRole });
        });
      },
    });
    const res = await app.request('http://localhost/probe');
    const body = await res.json();
    expect(body.role).toBe('admin');
  });

  it('IT-1900-10: api_token with expiresAt in past returns 401', async () => {
    const user = await createTestUser();
    const tokenId = createId();
    const team = await createTestTeam();
    await db.insert(apiTokens).values({
      id: tokenId,
      userId: user.id,
      teamId: team.id,
      name: 'tok',
      tokenHash: 'h-' + tokenId,
      tokenPrefix: 'agp_',
      role: 'viewer',
      status: 'active',
    });
    const app = buildApp({
      db,
      initialAuth: { userId: user.id, authMethod: 'api_token' },
      preMiddleware: (c) => {
        c.set('_resolvedApiToken', {
          id: tokenId,
          role: 'viewer',
          scopeCodespaceId: null,
          scopeTags: null,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        });
      },
      routes: (a) => {
        a.get('/probe', (c) => c.json({ ok: true }));
      },
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toContain('expired');
  });

  it('IT-1900-11: api_token with invalid role returns 500 INTERNAL_ERROR', async () => {
    const user = await createTestUser();
    const app = buildApp({
      db,
      initialAuth: { userId: user.id, authMethod: 'api_token' },
      preMiddleware: (c) => {
        c.set('_resolvedApiToken', {
          id: 'tok-bad',
          role: 'super-admin' as never,
          scopeCodespaceId: null,
          scopeTags: null,
          expiresAt: null,
        });
      },
      routes: (a) => {
        a.get('/probe', (c) => c.json({ ok: true }));
      },
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('IT-1900-12: api_token missing from cache returns 401', async () => {
    const user = await createTestUser();
    const app = buildApp({
      db,
      initialAuth: { userId: user.id, authMethod: 'api_token' },
      // no preMiddleware → _resolvedApiToken not set
      routes: (a) => {
        a.get('/probe', (c) => c.json({ ok: true }));
      },
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toContain('Invalid or revoked');
  });

  it('IT-1900-13: enrichAuthContext catches DB error for session user → 500', async () => {
    const failingDb = {
      query: {
        users: {
          findFirst: vi.fn().mockRejectedValue(new Error('db down')),
        },
      },
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    };
    const app = buildApp({
      db: failingDb as never,
      initialAuth: { userId: 'u-1', authMethod: 'session' },
      routes: (a) => {
        a.get('/probe', (c) => c.json({ ok: true }));
      },
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toContain('user permissions');
  });

  it('IT-1900-14: enrichAuthContext catches DB error for api_token → 500 with token-specific msg', async () => {
    const failingDb = {
      query: {
        users: {
          findFirst: vi.fn().mockRejectedValue(new Error('db down')),
        },
      },
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    };
    const app = buildApp({
      db: failingDb as never,
      initialAuth: { userId: 'u-1', authMethod: 'api_token' },
      preMiddleware: (c) => {
        c.set('_resolvedApiToken', {
          id: 'tk',
          role: 'viewer',
          scopeCodespaceId: null,
          scopeTags: null,
          expiresAt: null,
        });
      },
      routes: (a) => {
        a.get('/probe', (c) => c.json({ ok: true }));
      },
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toContain('token permissions');
  });

  // ─── requireRole ──────────────────────────────────────

  it('IT-1900-15: requireRole returns 401 when no auth set', async () => {
    const rbacService = new RbacService(db);
    const app = new Hono();
    app.use('*', requireRole('viewer', rbacService));
    app.get('/probe', (c) => c.json({ ok: true }));
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(401);
  });

  it('IT-1900-16: requireRole passes through for dev-mode', async () => {
    const rbacService = new RbacService(db);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'dev', authMethod: 'dev' } as never);
      await next();
    });
    app.use('*', requireRole('admin', rbacService));
    app.get('/probe', (c) => c.json({ ok: true }));
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(200);
  });

  it('IT-1900-17: requireRole denies when user has no resolvedRole', async () => {
    const rbacService = new RbacService(db);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'u-1', authMethod: 'session' } as never);
      await next();
    });
    app.use('*', requireRole('viewer', rbacService));
    app.get('/probe', (c) => c.json({ ok: true }));
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toContain('No role assigned');
  });

  it('IT-1900-18: requireRole resolves codespace-scoped role from query param', async () => {
    const user = await createTestUser();
    const cs = await createTestProject();
    const team = await createTestTeam();
    await createTestTeamMember(team.id, user.id, { role: 'viewer' });
    // Grant codespace-level admin via codespace_member
    const { codespaceMembers } = await import('../../src/db/schema');
    await db.insert(codespaceMembers).values({
      codespaceId: cs.id,
      userId: user.id,
      role: 'admin',
    });

    const rbacService = new RbacService(db);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: user.id,
        authMethod: 'session',
        resolvedRole: 'viewer',
        roleLevel: 1,
      } as never);
      await next();
    });
    app.use('*', requireRole('admin', rbacService));
    app.get('/probe', (c) => c.json({ ok: true }));
    const res = await app.request(`http://localhost/probe?codespaceId=${cs.id}`);
    expect(res.status).toBe(200);
  });

  it('IT-1900-19: requireRole denies when codespace role insufficient', async () => {
    const user = await createTestUser();
    const cs = await createTestProject();
    const rbacService = new RbacService(db);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: user.id,
        authMethod: 'session',
        resolvedRole: 'viewer',
        roleLevel: 1,
      } as never);
      await next();
    });
    app.use('*', requireRole('admin', rbacService));
    app.get('/probe', (c) => c.json({ ok: true }));
    const res = await app.request(`http://localhost/probe?codespaceId=${cs.id}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('IT-1900-20: requireRole on /api/codespaces/:id falls through to global role when middleware is mounted as wildcard', async () => {
    // Reality check: when requireRole is mounted as a wildcard (`*`) the
    // c.req.param('id') call returns undefined because Hono has not matched
    // the specific route yet. The middleware then falls back to global role.
    // Production wires this differently — per-route — but we still verify the
    // wildcard path so the codepath in the source is exercised.
    const user = await createTestUser();
    const cs = await createTestProject();
    const team = await createTestTeam();
    await createTestTeamMember(team.id, user.id, { role: 'admin' });
    const rbacService = new RbacService(db);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: user.id,
        authMethod: 'session',
        resolvedRole: 'admin',
        roleLevel: 100,
      } as never);
      await next();
    });
    app.use('*', requireRole('viewer', rbacService));
    app.get('/api/codespaces/:id', (c) => c.json({ ok: true, id: c.req.param('id') }));
    const res = await app.request(`http://localhost/api/codespaces/${cs.id}`);
    // global role 'admin' >= 'viewer' → pass
    expect(res.status).toBe(200);
  });

  it('IT-1900-21: requireRole reads codespaceId from JSON body for POST', async () => {
    const user = await createTestUser();
    const cs = await createTestProject();
    const { codespaceMembers } = await import('../../src/db/schema');
    await db.insert(codespaceMembers).values({
      codespaceId: cs.id,
      userId: user.id,
      role: 'admin',
    });
    const rbacService = new RbacService(db);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: user.id,
        authMethod: 'session',
        resolvedRole: 'viewer',
        roleLevel: 1,
      } as never);
      await next();
    });
    app.use('*', requireRole('admin', rbacService));
    app.post('/probe', (c) => c.json({ ok: true }));
    const res = await app.request('http://localhost/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codespaceId: cs.id }),
    });
    expect(res.status).toBe(200);
  });

  it('IT-1900-22: requireRole tolerates non-JSON body (form-data) and falls back to global role', async () => {
    const user = await createTestUser();
    const team = await createTestTeam();
    await createTestTeamMember(team.id, user.id, { role: 'admin' });
    const rbacService = new RbacService(db);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: user.id,
        authMethod: 'session',
        resolvedRole: 'admin',
        roleLevel: 100,
      } as never);
      await next();
    });
    app.use('*', requireRole('viewer', rbacService));
    app.post('/probe', (c) => c.json({ ok: true }));
    const res = await app.request('http://localhost/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data' },
      body: 'not json',
    });
    // No codespace context → falls back to global role (admin >= viewer) → pass
    expect(res.status).toBe(200);
  });

  it('IT-1900-23: requireRole applies token-ceiling on codespace-scoped routes', async () => {
    const user = await createTestUser();
    const cs = await createTestProject();
    const { codespaceMembers } = await import('../../src/db/schema');
    await db.insert(codespaceMembers).values({
      codespaceId: cs.id,
      userId: user.id,
      role: 'admin',
    });
    const rbacService = new RbacService(db);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: user.id,
        authMethod: 'api_token',
        resolvedRole: 'viewer',
        roleLevel: 1,
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: null },
      } as never);
      await next();
    });
    app.use('*', requireRole('admin', rbacService));
    app.get('/probe', (c) => c.json({ ok: true }));
    const res = await app.request(`http://localhost/probe?codespaceId=${cs.id}`);
    // codespace role is admin, but token caps to viewer → admin requirement fails
    expect(res.status).toBe(403);
  });

  it('IT-1900-24: requireRole denies when token codespace scope does not match', async () => {
    const user = await createTestUser();
    const cs = await createTestProject();
    const otherCs = await createTestProject();
    const { codespaceMembers } = await import('../../src/db/schema');
    await db.insert(codespaceMembers).values({
      codespaceId: cs.id,
      userId: user.id,
      role: 'admin',
    });
    const rbacService = new RbacService(db);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: user.id,
        authMethod: 'api_token',
        resolvedRole: 'admin',
        roleLevel: 100,
        tokenScope: { tokenId: 'tk', role: 'admin', codespaceId: otherCs.id, tags: null },
      } as never);
      await next();
    });
    app.use('*', requireRole('viewer', rbacService));
    app.get('/probe', (c) => c.json({ ok: true }));
    const res = await app.request(`http://localhost/probe?codespaceId=${cs.id}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toContain('Token not scoped');
  });

  // ─── requireTagAccess ─────────────────────────────────

  it('IT-1900-25: requireTagAccess passes when no auth set', async () => {
    const app = new Hono();
    app.use('*', requireTagAccess(db as never));
    app.get('/api/codespaces', (c) => c.json({ ok: true }));
    const res = await app.request('http://localhost/api/codespaces');
    expect(res.status).toBe(200);
  });

  it('IT-1900-26: requireTagAccess passes for non-token auth', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'u', authMethod: 'session' } as never);
      await next();
    });
    app.use('*', requireTagAccess(db as never));
    app.get('/api/codespaces', (c) => c.json({ ok: true }));
    const res = await app.request('http://localhost/api/codespaces');
    expect(res.status).toBe(200);
  });

  it('IT-1900-27: requireTagAccess passes for token without tag scope', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: 'u',
        authMethod: 'api_token',
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: null },
      } as never);
      await next();
    });
    app.use('*', requireTagAccess(db as never));
    app.get('/api/codespaces', (c) => c.json({ ok: true }));
    const res = await app.request('http://localhost/api/codespaces');
    expect(res.status).toBe(200);
  });

  it('IT-1900-28: requireTagAccess denies on unrecognized resource path', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: 'u',
        authMethod: 'api_token',
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: ['x'] },
      } as never);
      await next();
    });
    app.use('*', requireTagAccess(db as never));
    app.get('/api/unknown-thing', (c) => c.json({ ok: true }));
    const res = await app.request('http://localhost/api/unknown-thing');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toContain('cannot access');
  });

  it('IT-1900-29: requireTagAccess sets tagFilter for collection endpoint', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: 'u',
        authMethod: 'api_token',
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: ['my-tag'] },
      } as never);
      await next();
    });
    app.use('*', requireTagAccess(db as never));
    app.get('/api/codespaces', (c) => {
      const auth = c.get('auth' as never) as AuthContext;
      return c.json({ filter: auth.tagFilter });
    });
    const res = await app.request('http://localhost/api/codespaces');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filter.resourceType).toBe('codespace');
    expect(body.filter.scopeTags).toEqual(['my-tag']);
  });

  it('IT-1900-30: requireTagAccess sets tagFilter for sub-collection like /summaries', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: 'u',
        authMethod: 'api_token',
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: ['t'] },
      } as never);
      await next();
    });
    app.use('*', requireTagAccess(db as never));
    app.get('/api/codespaces/summaries', (c) => {
      const auth = c.get('auth' as never) as AuthContext;
      return c.json({ filter: auth.tagFilter ?? null });
    });
    const res = await app.request('http://localhost/api/codespaces/summaries');
    const body = await res.json();
    // 'summaries' is a known sub-collection → filter populated, not denied
    expect(body.filter).not.toBeNull();
  });

  it('IT-1900-31: requireTagAccess denies single resource with no tags', async () => {
    const cs = await createTestProject();
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: 'u',
        authMethod: 'api_token',
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: ['t'] },
      } as never);
      await next();
    });
    app.use('*', requireTagAccess(db as never));
    app.get('/api/codespaces/:id', (c) => c.json({ ok: true }));
    const res = await app.request(`http://localhost/api/codespaces/${cs.id}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toContain('not accessible');
  });

  it('IT-1900-32: requireTagAccess denies single resource when tags do not overlap', async () => {
    const cs = await createTestProject();
    const folderId = cs.projectFolderId!;
    const tagId = createId();
    await db.insert(tags).values({ id: tagId, projectFolderId: folderId, name: 'other' });
    await db.insert(codespaceTags).values({ codespaceId: cs.id, tagId });

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: 'u',
        authMethod: 'api_token',
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: ['mismatch'] },
      } as never);
      await next();
    });
    app.use('*', requireTagAccess(db as never));
    app.get('/api/codespaces/:id', (c) => c.json({ ok: true }));
    const res = await app.request(`http://localhost/api/codespaces/${cs.id}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toContain('do not match');
  });

  it('IT-1900-33: requireTagAccess passes when single resource tag overlaps', async () => {
    const cs = await createTestProject();
    const folderId = cs.projectFolderId!;
    const tagId = createId();
    await db.insert(tags).values({ id: tagId, projectFolderId: folderId, name: 'matched' });
    await db.insert(codespaceTags).values({ codespaceId: cs.id, tagId });

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: 'u',
        authMethod: 'api_token',
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: [tagId] },
      } as never);
      await next();
    });
    app.use('*', requireTagAccess(db as never));
    app.get('/api/codespaces/:id', (c) => c.json({ ok: true }));
    const res = await app.request(`http://localhost/api/codespaces/${cs.id}`);
    expect(res.status).toBe(200);
  });

  it('IT-1900-34: requireTagAccess returns 500 when resolver throws', async () => {
    const failingDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockRejectedValue(new Error('db down')),
        })),
      })),
    };
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: 'u',
        authMethod: 'api_token',
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: ['x'] },
      } as never);
      await next();
    });
    app.use('*', requireTagAccess(failingDb as never));
    app.get('/api/codespaces/:id', (c) => c.json({ ok: true }));
    const res = await app.request('http://localhost/api/codespaces/cs-1');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  // ─── getAccessibleResourceIds ─────────────────────────

  it('IT-1900-35: getAccessibleResourceIds returns [] for empty scopeTags', async () => {
    const ids = await getAccessibleResourceIds(db as never, 'codespace', []);
    expect(ids).toEqual([]);
  });

  it('IT-1900-36: getAccessibleResourceIds returns codespace IDs for codespace resourceType', async () => {
    const cs = await createTestProject();
    const folderId = cs.projectFolderId!;
    const tagId = createId();
    await db.insert(tags).values({ id: tagId, projectFolderId: folderId, name: 't' });
    await db.insert(codespaceTags).values({ codespaceId: cs.id, tagId });

    const ids = await getAccessibleResourceIds(db as never, 'codespace', [tagId]);
    expect(ids).toContain(cs.id);
  });

  it('IT-1900-37: getAccessibleResourceIds returns task IDs (direct + inherited)', async () => {
    const cs = await createTestProject();
    const folderId = cs.projectFolderId!;
    const tagId = createId();
    await db.insert(tags).values({ id: tagId, projectFolderId: folderId, name: 't' });
    await db.insert(codespaceTags).values({ codespaceId: cs.id, tagId });

    const directTask = await createTestTask(cs.id);
    const directTaskTagId = createId();
    await db.insert(tags).values({ id: directTaskTagId, projectFolderId: folderId, name: 't2' });
    await db.insert(taskTags).values({ taskId: directTask.id, tagId: directTaskTagId });

    const ids = await getAccessibleResourceIds(db as never, 'task', [tagId, directTaskTagId]);
    expect(ids).toContain(directTask.id);
  });

  it('IT-1900-38: getAccessibleResourceIds returns [] for agent when no codespaces tagged', async () => {
    const ids = await getAccessibleResourceIds(db as never, 'agent', ['nope']);
    expect(ids).toEqual([]);
  });

  it('IT-1900-39: getAccessibleResourceIds returns agent IDs under tagged codespace', async () => {
    const cs = await createTestProject();
    const folderId = cs.projectFolderId!;
    const tagId = createId();
    await db.insert(tags).values({ id: tagId, projectFolderId: folderId, name: 't' });
    await db.insert(codespaceTags).values({ codespaceId: cs.id, tagId });

    const agentId = createId();
    await db.insert(agents).values({
      id: agentId,
      codespaceId: cs.id,
      name: 'a',
      type: 'task',
    });

    const ids = await getAccessibleResourceIds(db as never, 'agent', [tagId]);
    expect(ids).toContain(agentId);
  });

  it('IT-1900-40: getAccessibleResourceIds returns session IDs by task or codespace', async () => {
    const cs = await createTestProject();
    const folderId = cs.projectFolderId!;
    const tagId = createId();
    await db.insert(tags).values({ id: tagId, projectFolderId: folderId, name: 't' });
    await db.insert(codespaceTags).values({ codespaceId: cs.id, tagId });

    const session = await createTestSession(cs.id);
    const ids = await getAccessibleResourceIds(db as never, 'session', [tagId]);
    expect(ids).toContain(session.id);
  });

  // ─── applyTokenTagFilter ──────────────────────────────

  it('IT-1900-41: applyTokenTagFilter passes through when no tagFilter', async () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    const out = await applyTokenTagFilter(db as never, undefined, items, (i) => i.id);
    expect(out).toEqual(items);
  });

  it('IT-1900-42: applyTokenTagFilter returns empty when items list empty', async () => {
    const out = await applyTokenTagFilter(
      db as never,
      { tagFilter: { resourceType: 'codespace', scopeTags: ['x'] } } as never,
      [],
      (i: { id: string }) => i.id
    );
    expect(out).toEqual([]);
  });

  // ─── TAG_RESOLVERS via requireTagAccess (task/session/agent) ──

  it('IT-1900-43a: requireTagAccess on /api/tasks/:id allows when task directly tagged', async () => {
    const cs = await createTestProject();
    const folderId = cs.projectFolderId!;
    const tagId = createId();
    await db.insert(tags).values({ id: tagId, projectFolderId: folderId, name: 'tt' });
    const task = await createTestTask(cs.id);
    await db.insert(taskTags).values({ taskId: task.id, tagId });

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: 'u',
        authMethod: 'api_token',
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: [tagId] },
      } as never);
      await next();
    });
    app.use('*', requireTagAccess(db as never));
    app.get('/api/tasks/:id', (c) => c.json({ ok: true }));
    const res = await app.request(`http://localhost/api/tasks/${task.id}`);
    expect(res.status).toBe(200);
  });

  it('IT-1900-43b: requireTagAccess on /api/tasks/:id falls back to codespace tags when no task tag', async () => {
    const cs = await createTestProject();
    const folderId = cs.projectFolderId!;
    const tagId = createId();
    await db.insert(tags).values({ id: tagId, projectFolderId: folderId, name: 'cs-tag' });
    await db.insert(codespaceTags).values({ codespaceId: cs.id, tagId });
    // Task has NO direct tag
    const task = await createTestTask(cs.id);

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: 'u',
        authMethod: 'api_token',
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: [tagId] },
      } as never);
      await next();
    });
    app.use('*', requireTagAccess(db as never));
    app.get('/api/tasks/:id', (c) => c.json({ ok: true }));
    const res = await app.request(`http://localhost/api/tasks/${task.id}`);
    expect(res.status).toBe(200);
  });

  it('IT-1900-43c: requireTagAccess on /api/sessions/:id resolves via task tags', async () => {
    const cs = await createTestProject();
    const folderId = cs.projectFolderId!;
    const tagId = createId();
    await db.insert(tags).values({ id: tagId, projectFolderId: folderId, name: 's-task-tag' });
    const task = await createTestTask(cs.id);
    await db.insert(taskTags).values({ taskId: task.id, tagId });
    const session = await createTestSession(cs.id, { taskId: task.id });

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: 'u',
        authMethod: 'api_token',
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: [tagId] },
      } as never);
      await next();
    });
    app.use('*', requireTagAccess(db as never));
    app.get('/api/sessions/:id', (c) => c.json({ ok: true }));
    const res = await app.request(`http://localhost/api/sessions/${session.id}`);
    expect(res.status).toBe(200);
  });

  it('IT-1900-43d: requireTagAccess on /api/sessions/:id falls back to codespace tags when no task or session task has no tag', async () => {
    const cs = await createTestProject();
    const folderId = cs.projectFolderId!;
    const tagId = createId();
    await db.insert(tags).values({ id: tagId, projectFolderId: folderId, name: 'cs-sess-tag' });
    await db.insert(codespaceTags).values({ codespaceId: cs.id, tagId });
    const session = await createTestSession(cs.id);

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: 'u',
        authMethod: 'api_token',
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: [tagId] },
      } as never);
      await next();
    });
    app.use('*', requireTagAccess(db as never));
    app.get('/api/sessions/:id', (c) => c.json({ ok: true }));
    const res = await app.request(`http://localhost/api/sessions/${session.id}`);
    expect(res.status).toBe(200);
  });

  it('IT-1900-43e: requireTagAccess on /api/agents/:id resolves via codespace tags', async () => {
    const cs = await createTestProject();
    const folderId = cs.projectFolderId!;
    const tagId = createId();
    await db.insert(tags).values({ id: tagId, projectFolderId: folderId, name: 'a-tag' });
    await db.insert(codespaceTags).values({ codespaceId: cs.id, tagId });
    const agentId = createId();
    await db.insert(agents).values({ id: agentId, codespaceId: cs.id, name: 'ag', type: 'task' });

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: 'u',
        authMethod: 'api_token',
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: [tagId] },
      } as never);
      await next();
    });
    app.use('*', requireTagAccess(db as never));
    app.get('/api/agents/:id', (c) => c.json({ ok: true }));
    const res = await app.request(`http://localhost/api/agents/${agentId}`);
    expect(res.status).toBe(200);
  });

  it('IT-1900-43f: requireTagAccess on /api/sessions/:id with no session record returns 403 (no tags)', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: 'u',
        authMethod: 'api_token',
        tokenScope: { tokenId: 'tk', role: 'viewer', codespaceId: null, tags: ['x'] },
      } as never);
      await next();
    });
    app.use('*', requireTagAccess(db as never));
    app.get('/api/sessions/:id', (c) => c.json({ ok: true }));
    const res = await app.request('http://localhost/api/sessions/no-such-session');
    expect(res.status).toBe(403);
  });

  it('IT-1900-43: applyTokenTagFilter narrows list to tagged codespaces only', async () => {
    const cs = await createTestProject();
    const otherCs = await createTestProject();
    const folderId = cs.projectFolderId!;
    const tagId = createId();
    await db.insert(tags).values({ id: tagId, projectFolderId: folderId, name: 't' });
    await db.insert(codespaceTags).values({ codespaceId: cs.id, tagId });

    const out = await applyTokenTagFilter(
      db as never,
      {
        userId: 'u',
        authMethod: 'api_token',
        tagFilter: { resourceType: 'codespace', scopeTags: [tagId] },
      } as never,
      [{ id: cs.id }, { id: otherCs.id }],
      (i: { id: string }) => i.id
    );
    expect(out.map((i) => (i as { id: string }).id)).toEqual([cs.id]);
  });
});
