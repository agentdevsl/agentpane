import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../lib/api/auth-middleware.js';
import { createTeamProjectsRoutes } from '../team-projects.js';

// ── Mock Database ──

function createMockDb() {
  return {
    query: {
      projects: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(),
    insert: vi.fn(),
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

// ── Auth context helper ──

function devAuth(): AuthContext {
  return { authMethod: 'dev', userId: 'user-1' };
}

function sessionAuth(userId = 'user-1'): AuthContext {
  return { authMethod: 'session', userId };
}

// ── Test App Factory ──

/**
 * team-projects routes are mounted at /api/teams/:id/projects.
 * The route reads teamId from c.req.param('id').
 * We mount via a parent Hono that sets the auth variable and
 * routes the sub-app under /api/teams/:id/projects.
 */
function createTestApp(auth = devAuth()) {
  const db = createMockDb();
  const rbacService = createMockRbacService();
  const routes = createTeamProjectsRoutes({ db: db as never, rbacService: rbacService as never });

  const app = new Hono();
  // Middleware to inject auth context
  app.use('*', async (c, next) => {
    c.set('auth' as never, auth as never);
    return next();
  });
  app.route('/api/teams/:id/projects', routes);

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

describe('Team Projects API Routes', () => {
  // ── POST /api/teams/:id/projects ──

  describe('POST /api/teams/:id/projects', () => {
    it('assigns a project to a team', async () => {
      const { app, db } = createTestApp();

      db.transaction.mockImplementation(async (fn: Function) => {
        const tx = {
          query: {
            projects: {
              findFirst: vi.fn().mockResolvedValue({ id: 'proj-1', name: 'Project' }),
            },
          },
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockResolvedValue(undefined),
          }),
        };
        return fn(tx);
      });

      const res = await request(app, 'POST', '/api/teams/team-1/projects', {
        projectId: 'proj-1',
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.teamId).toBe('team-1');
      expect(json.data.projectId).toBe('proj-1');
    });

    it('returns 400 for invalid team id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/teams/bad!id/projects', {
        projectId: 'proj-1',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for invalid projectId in body', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/teams/team-1/projects', {
        projectId: '../bad',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 404 when project does not exist', async () => {
      const { app, db } = createTestApp();

      db.transaction.mockImplementation(async (fn: Function) => {
        const tx = {
          query: {
            projects: {
              findFirst: vi.fn().mockResolvedValue(undefined),
            },
          },
        };
        return fn(tx);
      });

      const res = await request(app, 'POST', '/api/teams/team-1/projects', {
        projectId: 'proj-missing',
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 409 when project already assigned', async () => {
      const { app, db } = createTestApp();

      db.transaction.mockImplementation(async (fn: Function) => {
        const tx = {
          query: {
            projects: {
              findFirst: vi.fn().mockResolvedValue({ id: 'proj-1' }),
            },
          },
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ teamId: 'team-1', projectId: 'proj-1' }]),
            }),
          }),
        };
        return fn(tx);
      });

      const res = await request(app, 'POST', '/api/teams/team-1/projects', {
        projectId: 'proj-1',
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('PROJECT_ALREADY_ASSIGNED');
    });

    it('returns 403 when user lacks admin role', async () => {
      const { app, rbacService } = createTestApp(sessionAuth('user-2'));

      rbacService.resolveTeamRole.mockResolvedValue('viewer');
      rbacService.hasMinimumRole.mockReturnValue(false);

      const res = await request(app, 'POST', '/api/teams/team-1/projects', {
        projectId: 'proj-1',
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('returns 500 on db error', async () => {
      const { app, db } = createTestApp();

      db.transaction.mockRejectedValue(new Error('DB failure'));

      const res = await request(app, 'POST', '/api/teams/team-1/projects', {
        projectId: 'proj-1',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });

  // ── DELETE /api/teams/:id/projects/:projectId ──

  describe('DELETE /api/teams/:id/projects/:projectId', () => {
    it('removes a project from a team', async () => {
      const { app, db } = createTestApp();

      const returning = vi.fn().mockResolvedValue([{ teamId: 'team-1', projectId: 'proj-1' }]);
      const where = vi.fn().mockReturnValue({ returning });
      db.delete.mockReturnValue({ where });

      const res = await request(app, 'DELETE', '/api/teams/team-1/projects/proj-1');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.removed).toBe(true);
    });

    it('returns 400 for invalid team id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/teams/bad!id/projects/proj-1');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 400 for invalid project id', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'DELETE', '/api/teams/team-1/projects/bad!id');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ID');
    });

    it('returns 404 when project not assigned', async () => {
      const { app, db } = createTestApp();

      const returning = vi.fn().mockResolvedValue([]);
      const where = vi.fn().mockReturnValue({ returning });
      db.delete.mockReturnValue({ where });

      const res = await request(app, 'DELETE', '/api/teams/team-1/projects/proj-missing');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 403 when user lacks admin role', async () => {
      const { app, rbacService } = createTestApp(sessionAuth('user-2'));

      rbacService.resolveTeamRole.mockResolvedValue('viewer');
      rbacService.hasMinimumRole.mockReturnValue(false);

      const res = await request(app, 'DELETE', '/api/teams/team-1/projects/proj-1');

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

      const res = await request(app, 'DELETE', '/api/teams/team-1/projects/proj-1');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });
});
