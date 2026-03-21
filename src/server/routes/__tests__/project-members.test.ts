import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../lib/api/auth-middleware.js';
import { createProjectMembersRoutes } from '../project-members.js';

// ── Mock Database ──

function createMockDb() {
  return {
    query: {
      projectMembers: {
        findMany: vi.fn(),
      },
    },
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
}

// ── Mock RBAC Service ──

function createMockRbacService() {
  return {
    resolveTeamRole: vi.fn(),
    hasMinimumRole: vi.fn(),
    resolveUserRole: vi.fn(),
  };
}

// ── Auth context helpers ──

function devAuth(userId = 'user-1'): AuthContext {
  return { authMethod: 'dev', userId };
}

function sessionAuth(userId = 'user-1'): AuthContext {
  return { authMethod: 'session', userId };
}

// ── Test App Factory ──

/**
 * project-members routes are mounted at /api/codespaces/:id/members.
 * The route reads codespaceId from c.req.param('id').
 */
function createTestApp(auth = devAuth()) {
  const db = createMockDb();
  const rbacService = createMockRbacService();
  const routes = createProjectMembersRoutes({
    db: db as never,
    rbacService: rbacService as never,
  });

  const app = new Hono();
  // Middleware to inject auth context
  app.use('*', async (c, next) => {
    c.set('auth' as never, auth as never);
    return next();
  });
  app.route('/api/codespaces/:id/members', routes);

  return { app, db, rbacService };
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

describe('Project Members API Routes', () => {
  // ── POST /api/codespaces/:id/members ──

  describe('POST /api/codespaces/:id/members', () => {
    it('adds a member to a project', async () => {
      const { app, db } = createTestApp();

      db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockResolvedValue(undefined),
          }),
        };
        // First call checks existing member (returns []), second checks user exists (returns [{id}])
        let selectCallCount = 0;
        tx.select.mockImplementation(() => {
          selectCallCount++;
          if (selectCallCount === 1) {
            // Check existing member
            return {
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([]),
              }),
            };
          }
          // Check user exists
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ id: 'user-2' }]),
            }),
          };
        });
        return fn(tx);
      });

      const res = await request(app, 'POST', '/api/codespaces/proj-1/members', {
        userId: 'user-2',
        role: 'viewer',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.codespaceId).toBe('proj-1');
      expect(json.data.userId).toBe('user-2');
      expect(json.data.role).toBe('viewer');
    });

    it('returns 400 for invalid project id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/codespaces/bad!id/members', {
        userId: 'user-2',
        role: 'viewer',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for missing required fields', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/codespaces/proj-1/members', {
        userId: 'user-2',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 400 for invalid role', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/codespaces/proj-1/members', {
        userId: 'user-2',
        role: 'superadmin',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 409 when member already exists', async () => {
      const { app, db } = createTestApp();

      db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi
                .fn()
                .mockResolvedValue([{ codespaceId: 'proj-1', userId: 'user-2', role: 'viewer' }]),
            }),
          }),
        };
        return fn(tx);
      });

      const res = await request(app, 'POST', '/api/codespaces/proj-1/members', {
        userId: 'user-2',
        role: 'viewer',
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('PROJECT_MEMBER_EXISTS');
    });

    it('returns 404 when user does not exist', async () => {
      const { app, db } = createTestApp();

      db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        let selectCallCount = 0;
        const tx = {
          select: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              return {
                from: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([]),
                }),
              };
            }
            return {
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([]),
              }),
            };
          }),
        };
        return fn(tx);
      });

      const res = await request(app, 'POST', '/api/codespaces/proj-1/members', {
        userId: 'user-missing',
        role: 'viewer',
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('USER_NOT_FOUND');
    });

    it('returns 403 when user lacks admin role', async () => {
      const { app, rbacService } = createTestApp(sessionAuth('user-1'));

      rbacService.resolveUserRole.mockResolvedValue('viewer');
      rbacService.hasMinimumRole.mockReturnValue(false);

      const res = await request(app, 'POST', '/api/codespaces/proj-1/members', {
        userId: 'user-2',
        role: 'viewer',
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('returns 500 on db error', async () => {
      const { app, db } = createTestApp();

      db.transaction.mockRejectedValue(new Error('DB failure'));

      const res = await request(app, 'POST', '/api/codespaces/proj-1/members', {
        userId: 'user-2',
        role: 'viewer',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });

  // ── GET /api/codespaces/:id/members ──

  describe('GET /api/codespaces/:id/members', () => {
    it('returns project members list', async () => {
      const { app, db, rbacService } = createTestApp();

      const leftJoin = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            userId: 'user-2',
            role: 'admin',
            grantedByTeamId: null,
            createdAt: '2025-01-01',
            name: 'User 2',
            email: 'user2@test.com',
            avatarUrl: null,
          },
        ]),
      });
      const from = vi.fn().mockReturnValue({ leftJoin });
      db.select.mockReturnValue({ from });

      rbacService.resolveUserRole.mockResolvedValue('admin');

      const res = await request(app, 'GET', '/api/codespaces/proj-1/members');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.items).toHaveLength(1);
      expect(json.data.items[0].userId).toBe('user-2');
      expect(json.data.items[0].effectiveRole).toBe('admin');
    });

    it('returns 400 for invalid project id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/codespaces/bad!id/members');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 403 when user lacks viewer role', async () => {
      const { app, rbacService } = createTestApp(sessionAuth('user-1'));

      rbacService.resolveUserRole.mockResolvedValue(null);
      rbacService.hasMinimumRole.mockReturnValue(false);

      const res = await request(app, 'GET', '/api/codespaces/proj-1/members');

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('returns 500 on db error', async () => {
      const { app, db } = createTestApp();

      db.select.mockImplementation(() => {
        throw new Error('DB failure');
      });

      const res = await request(app, 'GET', '/api/codespaces/proj-1/members');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });

  // ── PATCH /api/codespaces/:id/members/:uid ──

  describe('PATCH /api/codespaces/:id/members/:uid', () => {
    it('updates a member role', async () => {
      const { app, db } = createTestApp();

      const returning = vi
        .fn()
        .mockResolvedValue([{ codespaceId: 'proj-1', userId: 'user-2', role: 'admin' }]);
      const where = vi.fn().mockReturnValue({ returning });
      const set = vi.fn().mockReturnValue({ where });
      db.update.mockReturnValue({ set });

      const res = await request(app, 'PATCH', '/api/codespaces/proj-1/members/user-2', {
        role: 'admin',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.role).toBe('admin');
    });

    it('returns 400 for invalid project id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/codespaces/bad!id/members/user-2', {
        role: 'admin',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for invalid user id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/codespaces/proj-1/members/bad!id', {
        role: 'admin',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 when trying to change own role (non-dev)', async () => {
      const { app, rbacService } = createTestApp(sessionAuth('user-1'));

      // The RBAC check happens after the self-role check
      rbacService.resolveUserRole.mockResolvedValue('admin');
      rbacService.hasMinimumRole.mockReturnValue(true);

      const res = await request(app, 'PATCH', '/api/codespaces/proj-1/members/user-1', {
        role: 'viewer',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('CANNOT_CHANGE_OWN_ROLE');
    });

    it('returns 404 when member not found', async () => {
      const { app, db } = createTestApp();

      const returning = vi.fn().mockResolvedValue([]);
      const where = vi.fn().mockReturnValue({ returning });
      const set = vi.fn().mockReturnValue({ where });
      db.update.mockReturnValue({ set });

      const res = await request(app, 'PATCH', '/api/codespaces/proj-1/members/user-missing', {
        role: 'admin',
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('PROJECT_MEMBER_NOT_FOUND');
    });

    it('returns 403 when user lacks admin role', async () => {
      const { app, rbacService } = createTestApp(sessionAuth('user-3'));

      rbacService.resolveUserRole.mockResolvedValue('viewer');
      rbacService.hasMinimumRole.mockReturnValue(false);

      const res = await request(app, 'PATCH', '/api/codespaces/proj-1/members/user-2', {
        role: 'admin',
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('returns 400 for invalid role value', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/codespaces/proj-1/members/user-2', {
        role: 'superadmin',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 500 on db error', async () => {
      const { app, db } = createTestApp();

      db.update.mockImplementation(() => {
        throw new Error('DB failure');
      });

      const res = await request(app, 'PATCH', '/api/codespaces/proj-1/members/user-2', {
        role: 'admin',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });

  // ── DELETE /api/codespaces/:id/members/:uid ──

  describe('DELETE /api/codespaces/:id/members/:uid', () => {
    it('removes a member from a project', async () => {
      const { app, db, rbacService } = createTestApp();

      const returning = vi
        .fn()
        .mockResolvedValue([{ codespaceId: 'proj-1', userId: 'user-2', role: 'viewer' }]);
      const where = vi.fn().mockReturnValue({ returning });
      db.delete.mockReturnValue({ where });

      rbacService.resolveUserRole.mockResolvedValue('viewer');

      const res = await request(app, 'DELETE', '/api/codespaces/proj-1/members/user-2');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.removed).toBe(true);
      expect(json.data.revertedToTeamRole).toBe('viewer');
    });

    it('returns 400 for invalid project id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/codespaces/bad!id/members/user-2');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for invalid user id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/codespaces/proj-1/members/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when member not found', async () => {
      const { app, db } = createTestApp();

      const returning = vi.fn().mockResolvedValue([]);
      const where = vi.fn().mockReturnValue({ returning });
      db.delete.mockReturnValue({ where });

      const res = await request(app, 'DELETE', '/api/codespaces/proj-1/members/user-missing');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('PROJECT_MEMBER_NOT_FOUND');
    });

    it('returns 403 when user lacks admin role', async () => {
      const { app, rbacService } = createTestApp(sessionAuth('user-3'));

      rbacService.resolveUserRole.mockResolvedValue('viewer');
      rbacService.hasMinimumRole.mockReturnValue(false);

      const res = await request(app, 'DELETE', '/api/codespaces/proj-1/members/user-2');

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('returns 500 on db error', async () => {
      const { app, db } = createTestApp();

      db.delete.mockImplementation(() => {
        throw new Error('DB failure');
      });

      const res = await request(app, 'DELETE', '/api/codespaces/proj-1/members/user-2');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });
});
