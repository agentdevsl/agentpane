import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../lib/api/auth-middleware';
import { SESSION_COOKIE_NAME } from '../../../lib/api/auth-middleware.js';
import { createAuthRoutes } from '../auth.js';

// ── Mock Database ──

function createMockDb() {
  return {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

// ── Test App Factory ──

function createTestApp(authOverrides: Partial<AuthContext> = {}) {
  const db = createMockDb();
  const routes = createAuthRoutes({ db: db as never });
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

  app.route('/api/auth', routes);
  app.onError((err, c) => {
    return c.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } }, 500);
  });
  return { app, db };
}

// ── Request Helper ──

async function request(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
) {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  if (headers) {
    Object.assign(init.headers as Record<string, string>, headers);
  }
  return app.request(path, init);
}

// ── Tests ──

describe('Auth API Routes', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ── GET /api/auth/github ──

  describe('GET /api/auth/github', () => {
    it('returns 500 when GITHUB_CLIENT_ID is not configured', async () => {
      const { app } = createTestApp();
      delete process.env.GITHUB_CLIENT_ID;

      const res = await request(app, 'GET', '/api/auth/github');

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('CONFIG_ERROR');
    });

    it('redirects to GitHub OAuth when configured', async () => {
      const { app } = createTestApp();
      process.env.GITHUB_CLIENT_ID = 'test-client-id';

      const res = await request(app, 'GET', '/api/auth/github');

      expect(res.status).toBe(302);
      const location = res.headers.get('Location');
      expect(location).toContain('https://github.com/login/oauth/authorize');
      expect(location).toContain('client_id=test-client-id');
      expect(location).toContain('scope=read%3Auser+user%3Aemail');

      // Should set state cookie
      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).toContain('oauth_state=');
      expect(setCookie).toContain('HttpOnly');
    });

    it('uses custom callback URL when configured', async () => {
      const { app } = createTestApp();
      process.env.GITHUB_CLIENT_ID = 'test-client-id';
      process.env.GITHUB_CALLBACK_URL = 'https://myapp.com/api/auth/github/callback';

      const res = await request(app, 'GET', '/api/auth/github');

      expect(res.status).toBe(302);
      const location = res.headers.get('Location');
      expect(location).toContain(
        'redirect_uri=https%3A%2F%2Fmyapp.com%2Fapi%2Fauth%2Fgithub%2Fcallback'
      );
    });
  });

  // ── GET /api/auth/github/callback ──

  describe('GET /api/auth/github/callback', () => {
    it('returns 400 when code is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/auth/github/callback?state=abc');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
    });

    it('returns 400 when state is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/auth/github/callback?code=abc');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('MISSING_PARAMS');
    });

    it('returns 400 when state does not match cookie', async () => {
      const { app } = createTestApp();

      const res = await request(
        app,
        'GET',
        '/api/auth/github/callback?code=abc&state=wrong-state',
        undefined,
        { Cookie: 'oauth_state=correct-state' }
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_STATE');
    });

    it('returns 500 when GitHub OAuth is not configured (callback)', async () => {
      const { app } = createTestApp();
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;

      const res = await request(
        app,
        'GET',
        '/api/auth/github/callback?code=abc&state=valid-state',
        undefined,
        { Cookie: 'oauth_state=valid-state' }
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('CONFIG_ERROR');
    });
  });

  // ── POST /api/auth/logout ──

  describe('POST /api/auth/logout', () => {
    it('clears session cookie and returns ok when no session cookie', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/auth/logout');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toBeNull();
    });

    it('deletes session from DB when cookie is present', async () => {
      const { app, db } = createTestApp();
      const deleteFn = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      db.delete.mockReturnValue({ where: deleteFn });

      const res = await request(app, 'POST', '/api/auth/logout', undefined, {
        Cookie: `${SESSION_COOKIE_NAME}=test-session-token`,
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });

    it('returns 500 when DB deletion fails', async () => {
      const { app, db } = createTestApp();
      db.delete.mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('DB error')),
      });

      const res = await request(app, 'POST', '/api/auth/logout', undefined, {
        Cookie: `${SESSION_COOKIE_NAME}=test-session-token`,
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('DB_ERROR');
    });

    it('returns DB_ERROR message when DB deletion fails with session cookie', async () => {
      const { app, db } = createTestApp();
      db.delete.mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error('DB error')),
      });

      const res = await request(app, 'POST', '/api/auth/logout', undefined, {
        Cookie: `${SESSION_COOKIE_NAME}=test-session-token`,
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.message).toContain('Session may not be fully invalidated');
    });

    it('returns ok with data null on successful logout', async () => {
      const { app, db } = createTestApp();
      db.delete.mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      const res = await request(app, 'POST', '/api/auth/logout', undefined, {
        Cookie: `${SESSION_COOKIE_NAME}=valid-token`,
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data).toBeNull();
    });
  });

  // ── GET /api/auth/github (additional) ──

  describe('GET /api/auth/github (additional)', () => {
    it('includes scope in redirect URL', async () => {
      const { app } = createTestApp();
      process.env.GITHUB_CLIENT_ID = 'test-id';

      const res = await request(app, 'GET', '/api/auth/github');

      const location = res.headers.get('Location');
      expect(location).toContain('scope=');
    });

    it('sets oauth_state cookie with HttpOnly and Secure flags', async () => {
      const { app } = createTestApp();
      process.env.GITHUB_CLIENT_ID = 'test-id';

      const res = await request(app, 'GET', '/api/auth/github');

      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Lax');
    });

    it('sets oauth_state cookie with 600 second max age', async () => {
      const { app } = createTestApp();
      process.env.GITHUB_CLIENT_ID = 'test-id';

      const res = await request(app, 'GET', '/api/auth/github');

      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).toContain('Max-Age=600');
    });

    it('state parameter in URL matches state cookie value', async () => {
      const { app } = createTestApp();
      process.env.GITHUB_CLIENT_ID = 'test-id';

      const res = await request(app, 'GET', '/api/auth/github');

      const location = res.headers.get('Location') ?? '';
      const setCookie = res.headers.get('Set-Cookie') ?? '';

      const stateFromUrl = new URL(location).searchParams.get('state');
      const stateFromCookie = setCookie.match(/oauth_state=([^;]+)/)?.[1];

      expect(stateFromUrl).toBeTruthy();
      expect(stateFromUrl).toBe(stateFromCookie);
    });
  });

  // ── GET /api/auth/github/callback (additional) ──

  describe('GET /api/auth/github/callback (additional)', () => {
    it('returns 400 when both code and state are missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/auth/github/callback');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('MISSING_PARAMS');
    });

    it('returns 400 when state cookie is absent', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/auth/github/callback?code=abc&state=some-state');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_STATE');
    });

    it('returns 500 when only GITHUB_CLIENT_ID is configured (missing secret)', async () => {
      const { app } = createTestApp();
      process.env.GITHUB_CLIENT_ID = 'test-id';
      delete process.env.GITHUB_CLIENT_SECRET;

      const res = await request(
        app,
        'GET',
        '/api/auth/github/callback?code=abc&state=valid',
        undefined,
        { Cookie: 'oauth_state=valid' }
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error.code).toBe('CONFIG_ERROR');
    });

    it('returns 500 when only GITHUB_CLIENT_SECRET is configured (missing id)', async () => {
      const { app } = createTestApp();
      delete process.env.GITHUB_CLIENT_ID;
      process.env.GITHUB_CLIENT_SECRET = 'test-secret';

      const res = await request(
        app,
        'GET',
        '/api/auth/github/callback?code=abc&state=valid',
        undefined,
        { Cookie: 'oauth_state=valid' }
      );

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error.code).toBe('CONFIG_ERROR');
    });
  });
});
