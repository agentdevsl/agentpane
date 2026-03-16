import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../lib/api/auth-middleware';
import { createMeRoutes } from '../me.js';

// ── Mock Database ──

function createMockDb() {
  return {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };
}

// ── Test App Factory ──

function createTestApp(authOverrides: Partial<AuthContext> = {}) {
  const db = createMockDb();
  const routes = createMeRoutes({ db: db as never });
  const app = new Hono();

  // Simulate auth middleware
  const auth: AuthContext = {
    userId: 'user-1',
    authMethod: 'session',
    ...authOverrides,
  };
  app.use('*', async (c, next) => {
    c.set('auth' as never, auth as never);
    await next();
  });

  app.route('/api/me', routes);
  return { app, db };
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

describe('Me API Routes', () => {
  // ── GET /api/me ──

  describe('GET /api/me', () => {
    it('returns synthetic profile for dev auth', async () => {
      const { app } = createTestApp({ authMethod: 'dev', userId: 'dev-user' });

      const res = await request(app, 'GET', '/api/me');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('dev-user');
      expect(json.data.authMethod).toBe('dev');
      expect(json.data.name).toBe('Development User');
      expect(json.data.teams).toEqual([]);
    });

    it('returns user profile with team memberships', async () => {
      const { app, db } = createTestApp();

      const mockUser = {
        id: 'user-1',
        githubId: 12345,
        githubLogin: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
        avatarUrl: 'https://example.com/avatar.png',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      db.query.users.findFirst.mockResolvedValue(mockUser);

      // Mock the chained select().from().leftJoin().where()
      const mockMemberships = [
        {
          teamId: 'team-1',
          role: 'admin',
          joinedAt: '2024-01-01T00:00:00Z',
          teamName: 'Test Team',
          teamSlug: 'test-team',
        },
      ];
      const whereFn = vi.fn().mockResolvedValue(mockMemberships);
      const leftJoinFn = vi.fn().mockReturnValue({ where: whereFn });
      const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });
      db.select.mockReturnValue({ from: fromFn });

      const res = await request(app, 'GET', '/api/me');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.id).toBe('user-1');
      expect(json.data.githubLogin).toBe('testuser');
      expect(json.data.authMethod).toBe('session');
      expect(json.data.teams).toHaveLength(1);
      expect(json.data.teams[0].teamId).toBe('team-1');
      expect(json.data.teams[0].role).toBe('admin');
    });

    it('returns 404 when user not found', async () => {
      const { app, db } = createTestApp();
      db.query.users.findFirst.mockResolvedValue(null);

      const res = await request(app, 'GET', '/api/me');

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 500 on database error', async () => {
      const { app, db } = createTestApp();
      db.query.users.findFirst.mockRejectedValue(new Error('DB connection failed'));

      const res = await request(app, 'GET', '/api/me');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });

  // ── PATCH /api/me ──

  describe('PATCH /api/me', () => {
    it('returns 403 when updating dev user profile', async () => {
      const { app } = createTestApp({ authMethod: 'dev', userId: 'dev-user' });

      const res = await request(app, 'PATCH', '/api/me', { name: 'New Name' });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
    });

    it('updates user name successfully', async () => {
      const { app, db } = createTestApp();
      const updatedUser = {
        id: 'user-1',
        githubLogin: 'testuser',
        name: 'Updated Name',
        email: 'test@example.com',
        avatarUrl: null,
      };

      db.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([updatedUser]),
              }),
            }),
          }),
        };
        return fn(tx);
      });

      const res = await request(app, 'PATCH', '/api/me', { name: 'Updated Name' });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.name).toBe('Updated Name');
    });

    it('returns 409 when email already exists', async () => {
      const { app, db } = createTestApp();

      db.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ id: 'other-user' }]),
            }),
          }),
        };
        return fn(tx);
      });

      const res = await request(app, 'PATCH', '/api/me', { email: 'taken@example.com' });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('EMAIL_ALREADY_EXISTS');
    });

    it('returns 404 when user not found during update', async () => {
      const { app, db } = createTestApp();

      db.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        };
        return fn(tx);
      });

      const res = await request(app, 'PATCH', '/api/me', { name: 'New Name' });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 when body is empty object', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'PATCH', '/api/me', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { app } = createTestApp();

      const init: RequestInit = {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      };
      const res = await app.request('/api/me', init);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 500 on database error during update', async () => {
      const { app, db } = createTestApp();
      db.transaction.mockRejectedValue(new Error('DB write failed'));

      const res = await request(app, 'PATCH', '/api/me', { name: 'New Name' });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });
  });
});
