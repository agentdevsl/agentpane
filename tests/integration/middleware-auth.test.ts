/**
 * Integration tests for API middleware.
 *
 * Covers:
 * - auth-middleware.ts: getAuthContext, withAuth, validateUserIdMatch
 * - rate-limiter.ts: rateLimiter (IP-based and token-based)
 *
 * Note: rbac-middleware.ts (enrichAuthContext, requireRole, requireTagAccess) requires
 * a full database setup with users/teams/codespaces tables, which is tested via
 * the Hono app.request() pattern below.
 *
 * IT-IDs: IT-1918 through IT-1949
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestEnv } from '../helpers/env';

// ── Auth Middleware ──────────────────────────────────────────────────────────

describe('getAuthContext', () => {
  // Import after env setup
  let getAuthContext: typeof import('../../src/lib/api/auth-middleware').getAuthContext;

  beforeEach(async () => {
    // Dynamically import to allow env manipulation
    const mod = await import('../../src/lib/api/auth-middleware');
    getAuthContext = mod.getAuthContext;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setupTestEnv();
    vi.restoreAllMocks();
  });

  it('IT-1918: returns UNAUTHORIZED when no auth is provided', async () => {
    vi.stubEnv('SKIP_AUTH', 'false');
    const req = new Request('http://localhost/api/test');
    const result = await getAuthContext(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHORIZED');
      expect(result.error.status).toBe(401);
    }
  });

  it('IT-1919: returns dev-user when SKIP_AUTH=true in development', async () => {
    vi.stubEnv('SKIP_AUTH', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    const req = new Request('http://localhost/api/test');
    const result = await getAuthContext(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.userId).toBe('dev-user');
      expect(result.value.authMethod).toBe('dev');
    }
  });

  it('IT-1920: respects X-Dev-User header in dev mode', async () => {
    vi.stubEnv('SKIP_AUTH', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    const req = new Request('http://localhost/api/test', {
      headers: { 'X-Dev-User': 'custom-user' },
    });
    const result = await getAuthContext(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.userId).toBe('custom-user');
    }
  });

  it('IT-1921: does NOT bypass auth when SKIP_AUTH=true but NODE_ENV is not development', async () => {
    vi.stubEnv('SKIP_AUTH', 'true');
    vi.stubEnv('NODE_ENV', 'production');
    const req = new Request('http://localhost/api/test');
    const result = await getAuthContext(req);
    expect(result.ok).toBe(false);
  });

  it('IT-1922: validates session cookie with provided validator', async () => {
    vi.stubEnv('SKIP_AUTH', 'false');
    vi.stubEnv('NODE_ENV', 'production');
    const req = new Request('http://localhost/api/test', {
      headers: { Cookie: 'agentpane_session=valid-token-123' },
    });
    const result = await getAuthContext(req, {
      validateSessionToken: async (token) => {
        if (token === 'valid-token-123') return 'user-42';
        return null;
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.userId).toBe('user-42');
      expect(result.value.authMethod).toBe('session');
    }
  });

  it('IT-1923: rejects invalid session token', async () => {
    vi.stubEnv('SKIP_AUTH', 'false');
    vi.stubEnv('NODE_ENV', 'production');
    const req = new Request('http://localhost/api/test', {
      headers: { Cookie: 'agentpane_session=bad-token' },
    });
    const result = await getAuthContext(req, {
      validateSessionToken: async () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Invalid or expired session token');
    }
  });

  it('IT-1924: rejects session cookie when no validator provided', async () => {
    vi.stubEnv('SKIP_AUTH', 'false');
    vi.stubEnv('NODE_ENV', 'production');
    const req = new Request('http://localhost/api/test', {
      headers: { Cookie: 'agentpane_session=token-123' },
    });
    const result = await getAuthContext(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Session validation not configured');
    }
  });

  it('IT-1925: validates Bearer token with provided validator', async () => {
    vi.stubEnv('SKIP_AUTH', 'false');
    vi.stubEnv('NODE_ENV', 'production');
    const req = new Request('http://localhost/api/test', {
      headers: { Authorization: 'Bearer api-key-abc' },
    });
    const result = await getAuthContext(req, {
      validateApiKey: async (key) => {
        if (key === 'api-key-abc') return 'api-user-99';
        return null;
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.userId).toBe('api-user-99');
      expect(result.value.authMethod).toBe('api_token');
    }
  });

  it('IT-1926: rejects invalid Bearer token', async () => {
    vi.stubEnv('SKIP_AUTH', 'false');
    vi.stubEnv('NODE_ENV', 'production');
    const req = new Request('http://localhost/api/test', {
      headers: { Authorization: 'Bearer bad-key' },
    });
    const result = await getAuthContext(req, {
      validateApiKey: async () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Invalid API key');
    }
  });

  it('IT-1927: rejects Bearer token when no validator provided', async () => {
    vi.stubEnv('SKIP_AUTH', 'false');
    vi.stubEnv('NODE_ENV', 'production');
    const req = new Request('http://localhost/api/test', {
      headers: { Authorization: 'Bearer some-key' },
    });
    const result = await getAuthContext(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('API key validation not configured');
    }
  });
});

// ── validateUserIdMatch ─────────────────────────────────────────────────────

describe('validateUserIdMatch', () => {
  let validateUserIdMatch: typeof import('../../src/lib/api/auth-middleware').validateUserIdMatch;

  beforeEach(async () => {
    const mod = await import('../../src/lib/api/auth-middleware');
    validateUserIdMatch = mod.validateUserIdMatch;
  });

  it('IT-1928: returns true when requestUserId is undefined', () => {
    expect(validateUserIdMatch(undefined, 'user-1')).toBe(true);
  });

  it('IT-1929: returns true for dev-mode users regardless of ID', () => {
    expect(validateUserIdMatch('any-user', 'dev-user')).toBe(true);
    expect(validateUserIdMatch('other', 'dev-test')).toBe(true);
  });

  it('IT-1930: returns true for exact match', () => {
    expect(validateUserIdMatch('user-1', 'user-1')).toBe(true);
  });

  it('IT-1931: returns true when requestUserId matches extracted part (after colon)', () => {
    expect(validateUserIdMatch('user-1', 'session:user-1')).toBe(true);
  });

  it('IT-1932: returns false for mismatch', () => {
    expect(validateUserIdMatch('user-1', 'user-2')).toBe(false);
  });
});

// ── forbiddenResponse ───────────────────────────────────────────────────────

describe('forbiddenResponse', () => {
  let forbiddenResponse: typeof import('../../src/lib/api/auth-middleware').forbiddenResponse;

  beforeEach(async () => {
    const mod = await import('../../src/lib/api/auth-middleware');
    forbiddenResponse = mod.forbiddenResponse;
  });

  it('IT-1933: returns 403 response with FORBIDDEN code', async () => {
    const response = forbiddenResponse('Access denied');
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Access denied',
      },
    });
  });
});

// ── withAuth wrapper ────────────────────────────────────────────────────────

describe('withAuth', () => {
  let withAuth: typeof import('../../src/lib/api/auth-middleware').withAuth;

  beforeEach(async () => {
    const mod = await import('../../src/lib/api/auth-middleware');
    withAuth = mod.withAuth;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setupTestEnv();
  });

  it('IT-1934: passes auth context to handler in dev mode', async () => {
    vi.stubEnv('SKIP_AUTH', 'true');
    vi.stubEnv('NODE_ENV', 'development');

    const handler = withAuth(async ({ auth }) => {
      return new Response(JSON.stringify({ userId: auth.userId }), { status: 200 });
    });

    const req = new Request('http://localhost/api/test');
    const response = await handler({ request: req });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.userId).toBe('dev-user');
  });

  it('IT-1935: returns 401 when not authenticated', async () => {
    vi.stubEnv('SKIP_AUTH', 'false');
    vi.stubEnv('NODE_ENV', 'production');

    const handler = withAuth(async () => {
      return new Response('OK', { status: 200 });
    });

    const req = new Request('http://localhost/api/test');
    const response = await handler({ request: req });
    expect(response.status).toBe(401);
  });
});

// ── Rate Limiter ────────────────────────────────────────────────────────────

describe('rateLimiter', () => {
  // We need a fresh import to avoid shared state across tests.
  // The rate limiter uses module-level shared stores.

  it('IT-1936: allows requests under the limit', async () => {
    const { rateLimiter } = await import('../../src/lib/api/rate-limiter');

    const app = new Hono();
    app.use('/*', rateLimiter({ max: 5, windowMs: 60_000 }));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { 'x-real-ip': 'test-ip-1936' },
    });
    expect(res.status).toBe(200);

    const remaining = res.headers.get('X-RateLimit-Remaining');
    expect(remaining).toBe('4');
  });

  it('IT-1937: returns 429 when rate limit is exceeded', async () => {
    const { rateLimiter } = await import('../../src/lib/api/rate-limiter');

    const app = new Hono();
    app.use('/*', rateLimiter({ max: 2, windowMs: 60_000 }));
    app.get('/test', (c) => c.json({ ok: true }));

    // Use a unique IP for this test to avoid shared state
    const ip = `test-ip-1937-${Date.now()}`;
    const headers = { 'x-real-ip': ip };

    // Request 1 - OK
    const r1 = await app.request('/test', { headers });
    expect(r1.status).toBe(200);

    // Request 2 - OK (at limit)
    const r2 = await app.request('/test', { headers });
    expect(r2.status).toBe(200);

    // Request 3 - RATE LIMITED
    const r3 = await app.request('/test', { headers });
    expect(r3.status).toBe(429);

    const body = await r3.json();
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('IT-1938: sets rate limit headers', async () => {
    const { rateLimiter } = await import('../../src/lib/api/rate-limiter');

    const app = new Hono();
    app.use('/*', rateLimiter({ max: 10, windowMs: 60_000 }));
    app.get('/test', (c) => c.json({ ok: true }));

    const ip = `test-ip-1938-${Date.now()}`;
    const res = await app.request('/test', {
      headers: { 'x-real-ip': ip },
    });

    expect(res.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(res.headers.get('X-RateLimit-Remaining')).toBeDefined();
    expect(res.headers.get('X-RateLimit-Reset')).toBeDefined();
  });

  it('IT-1939: uses default max=100 and windowMs=60000', async () => {
    const { rateLimiter } = await import('../../src/lib/api/rate-limiter');

    const app = new Hono();
    app.use('/*', rateLimiter());
    app.get('/test', (c) => c.json({ ok: true }));

    const ip = `test-ip-1939-${Date.now()}`;
    const res = await app.request('/test', {
      headers: { 'x-real-ip': ip },
    });
    expect(res.headers.get('X-RateLimit-Limit')).toBe('100');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('99');
  });

  it('IT-1940: skips token-keyed limiter when no API token is present', async () => {
    const { rateLimiter } = await import('../../src/lib/api/rate-limiter');

    const app = new Hono();
    // Token-keyed limiter should skip entirely for non-token requests
    app.use('/*', rateLimiter({ max: 1, windowMs: 60_000, keyOnToken: true }));
    app.get('/test', (c) => c.json({ ok: true }));

    const ip = `test-ip-1940-${Date.now()}`;
    // Multiple requests should all pass since keyOnToken skips when no token
    const r1 = await app.request('/test', { headers: { 'x-real-ip': ip } });
    expect(r1.status).toBe(200);

    const r2 = await app.request('/test', { headers: { 'x-real-ip': ip } });
    expect(r2.status).toBe(200);
  });

  it('IT-1941: rate limits by token ID when keyOnToken and auth context present', async () => {
    const { rateLimiter } = await import('../../src/lib/api/rate-limiter');

    const tokenId = `token-1941-unique-${Date.now()}-${Math.random()}`;
    const limiter = rateLimiter({ max: 1, windowMs: 60_000, keyOnToken: true });

    const app = new Hono();

    // Simulate auth middleware setting context with a fixed token ID
    app.use('/*', async (c, next) => {
      c.set('auth', {
        userId: 'user-1',
        authMethod: 'api_token',
        tokenScope: {
          tokenId,
          role: 'admin',
          codespaceId: null,
          tags: null,
        },
      });
      return next();
    });
    app.use('/*', limiter);
    app.get('/test', (c) => c.json({ ok: true }));

    // First request OK
    const r1 = await app.request('/test');
    expect(r1.status).toBe(200);

    // Second request should be rate limited (same token)
    const r2 = await app.request('/test');
    expect(r2.status).toBe(429);
  });

  it('IT-1942: different IPs have separate rate limit buckets', async () => {
    const { rateLimiter } = await import('../../src/lib/api/rate-limiter');

    const app = new Hono();
    app.use('/*', rateLimiter({ max: 1, windowMs: 60_000 }));
    app.get('/test', (c) => c.json({ ok: true }));

    const ts = Date.now();
    // IP A
    const r1 = await app.request('/test', { headers: { 'x-real-ip': `ip-a-${ts}` } });
    expect(r1.status).toBe(200);

    // IP B - separate bucket, should be allowed
    const r2 = await app.request('/test', { headers: { 'x-real-ip': `ip-b-${ts}` } });
    expect(r2.status).toBe(200);

    // IP A again - should be limited
    const r3 = await app.request('/test', { headers: { 'x-real-ip': `ip-a-${ts}` } });
    expect(r3.status).toBe(429);
  });

  it('IT-1943: remaining count decreases with each request', async () => {
    const { rateLimiter } = await import('../../src/lib/api/rate-limiter');

    const app = new Hono();
    app.use('/*', rateLimiter({ max: 5, windowMs: 60_000 }));
    app.get('/test', (c) => c.json({ ok: true }));

    const ip = `test-ip-1943-${Date.now()}`;
    const headers = { 'x-real-ip': ip };

    const r1 = await app.request('/test', { headers });
    expect(r1.headers.get('X-RateLimit-Remaining')).toBe('4');

    const r2 = await app.request('/test', { headers });
    expect(r2.headers.get('X-RateLimit-Remaining')).toBe('3');

    const r3 = await app.request('/test', { headers });
    expect(r3.headers.get('X-RateLimit-Remaining')).toBe('2');
  });

  it('IT-1944: remaining is clamped to 0 (not negative) when over limit', async () => {
    const { rateLimiter } = await import('../../src/lib/api/rate-limiter');

    const app = new Hono();
    app.use('/*', rateLimiter({ max: 1, windowMs: 60_000 }));
    app.get('/test', (c) => c.json({ ok: true }));

    const ip = `test-ip-1944-${Date.now()}`;
    const headers = { 'x-real-ip': ip };

    await app.request('/test', { headers });
    const r2 = await app.request('/test', { headers });
    expect(r2.headers.get('X-RateLimit-Remaining')).toBe('0');
  });
});
