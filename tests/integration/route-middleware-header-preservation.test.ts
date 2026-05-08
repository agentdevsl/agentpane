/**
 * Integration test — sibling-of-sibling regression hunt.
 *
 * The github-app /manifest cookie-drop fix (commit 8385f3ea) and the
 * matching auth.ts fix in this branch both used
 *
 *   return new Response(JSON.stringify(...), { status, headers: { ... } });
 *
 * to attach a Set-Cookie header that would otherwise be dropped by the
 * shared `json()` helper. That works for the cookie, but it has its own
 * regression: any header set in middleware *before* `next()` lives on
 * Hono's internal headers map, not on `c.res`. Hono only flushes that map
 * onto the response when the handler goes through `c.body()` / `c.json()`
 * / `c.text()` / `c.redirect()`. A bare `new Response(...)` bypasses that
 * flush and silently drops the pre-set headers.
 *
 * The router stack (src/server/router.ts) sets `X-Request-Id` in a global
 * `requestIdMiddleware` that runs before `next()`. Every observability
 * tool downstream — log correlation, error reports, the `/api/admin/...`
 * request lookup — relies on this header being present on every response.
 *
 * These tests fail on the current `new Response(...)` pattern (header
 * absent) and pass once the routes use `c.body(text, status, headers)`,
 * which routes through Hono's `newResponse` and merges the headers.
 */

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userSessions } from '../../src/db/schema/sqlite/user-sessions.js';
import { users } from '../../src/db/schema/sqlite/users.js';
import { SESSION_COOKIE_NAME } from '../../src/lib/api/auth-middleware.js';
import { createAuthRoutes } from '../../src/server/routes/auth.js';
import { createGitHubAppRoutes } from '../../src/server/routes/github-app.js';
import { hashToken } from '../../src/server/shared.js';
import { getTestDb } from '../helpers/database.js';

let requestCounter = 0;

function withRequestIdMiddleware<T extends Hono>(app: T): T {
  // Mirror src/server/router.ts:requestIdMiddleware — sets X-Request-Id
  // BEFORE calling next(). This is the production middleware chain.
  app.use('*', async (c, next) => {
    const id = c.req.header('x-request-id') ?? `req-test-${(++requestCounter).toString(36)}`;
    c.header('X-Request-Id', id);
    await next();
  });
  return app;
}

async function seedUserAndSession(token: string) {
  const db = getTestDb();
  const userId = `user-${token.slice(0, 8)}`;
  await db
    .insert(users)
    .values({
      id: userId,
      githubId: Math.floor(Math.random() * 1_000_000) + 200_000,
      githubLogin: `mw-tester-${userId}`,
      name: 'MW Tester',
      email: `${userId}@example.com`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing();
  await db.insert(userSessions).values({
    id: `sess-${token.slice(0, 8)}`,
    userId,
    token: hashToken(token),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  });
}

describe('Middleware-set X-Request-Id header survives routes that attach Set-Cookie', () => {
  beforeEach(() => {
    requestCounter = 0;
  });

  it('POST /manifest preserves X-Request-Id alongside Set-Cookie', async () => {
    // Mock service — manifest doesn't actually call any methods that need DB.
    const svc = {
      getCredentials: vi.fn(),
      saveCredentials: vi.fn(),
      deleteCredentials: vi.fn(),
      listInstallations: vi.fn(),
      handleInstallation: vi.fn(),
      removeInstallation: vi.fn(),
      autoConfigureEventsForCodespace: vi.fn(),
      getAppOctokitFromCredentials: vi.fn(),
      isConfigured: vi.fn(),
    };
    const app = new Hono();
    withRequestIdMiddleware(app);
    app.route('/api/github-app', createGitHubAppRoutes({ githubAppService: svc as never }));
    const res = await app.request('/api/github-app/manifest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalUrl: 'https://app.example.com' }),
    });
    expect(res.status).toBe(200);
    // Both the cookie (from the route) AND the request id (from middleware
    // BEFORE next()) must be present.
    expect(res.headers.get('Set-Cookie')).toContain('github_app_state=');
    expect(res.headers.get('X-Request-Id')).toMatch(/^req-test-/);
  });

  it('POST /logout preserves X-Request-Id alongside session cookie clear', async () => {
    const app = new Hono();
    withRequestIdMiddleware(app);
    app.route('/api/auth', createAuthRoutes({ db: getTestDb() }));
    const res = await app.request('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(res.headers.get('X-Request-Id')).toMatch(/^req-test-/);
  });

  it('POST /revoke-all (success) preserves X-Request-Id alongside session cookie clear', async () => {
    const token = randomBytes(16).toString('base64url');
    await seedUserAndSession(token);
    const app = new Hono();
    withRequestIdMiddleware(app);
    app.route('/api/auth', createAuthRoutes({ db: getTestDb() }));
    const res = await app.request('/api/auth/revoke-all', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(res.headers.get('X-Request-Id')).toMatch(/^req-test-/);
  });

  it('POST /revoke-all (session not found) preserves X-Request-Id alongside cookie clear', async () => {
    const app = new Hono();
    withRequestIdMiddleware(app);
    app.route('/api/auth', createAuthRoutes({ db: getTestDb() }));
    const res = await app.request('/api/auth/revoke-all', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=stale-no-row` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(res.headers.get('X-Request-Id')).toMatch(/^req-test-/);
  });

  it('GET /github/callback failure path preserves X-Request-Id alongside oauth_state clear', async () => {
    process.env.GITHUB_CLIENT_ID = 'test-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'bad_verification_code' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    try {
      const state = 'test-state-mw';
      const app = new Hono();
      withRequestIdMiddleware(app);
      app.route('/api/auth', createAuthRoutes({ db: getTestDb() }));
      const res = await app.request(`/api/auth/github/callback?code=test&state=${state}`, {
        method: 'GET',
        headers: { Cookie: `oauth_state=${state}` },
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('Set-Cookie')).toContain('oauth_state=');
      expect(res.headers.get('X-Request-Id')).toMatch(/^req-test-/);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });
});
