/**
 * Integration test — sibling of the github-app `/manifest` cookie-drop bug.
 *
 * Background: routes that call `c.header('Set-Cookie', ...)` and then return
 * via the shared `json()` helper (which builds a fresh `new Response(...)`
 * outside Hono's context) silently drop the header. The state cookie never
 * reaches the client, breaking auth flows.
 *
 * The same pattern exists in `auth.ts` for session-cookie clearing across
 * `/logout`, `/revoke-all`, and the OAuth callback failure path. These tests
 * fail on the bug (cookie missing) and pass once the routes set the cookie
 * directly on the returned Response.
 */

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { userSessions } from '../../src/db/schema/sqlite/user-sessions.js';
import { users } from '../../src/db/schema/sqlite/users.js';
import { SESSION_COOKIE_NAME } from '../../src/lib/api/auth-middleware.js';
import { createAuthRoutes } from '../../src/server/routes/auth.js';
import { hashToken } from '../../src/server/shared.js';
import { getTestDb } from '../helpers/database.js';

async function seedUserAndSession(opts: { token: string; expiresInMs: number; userId?: string }) {
  const db = getTestDb();
  const userId = opts.userId ?? `user-${opts.token.slice(0, 8)}`;
  await db
    .insert(users)
    .values({
      id: userId,
      githubId: Math.floor(Math.random() * 1_000_000) + 100_000,
      githubLogin: `cookie-tester-${userId}`,
      name: 'Cookie Tester',
      email: `${userId}@example.com`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing();
  await db.insert(userSessions).values({
    id: `sess-${opts.token.slice(0, 8)}`,
    userId,
    token: hashToken(opts.token),
    expiresAt: new Date(Date.now() + opts.expiresInMs).toISOString(),
    createdAt: new Date().toISOString(),
  });
  return userId;
}

function buildApp() {
  const app = new Hono();
  app.route('/api/auth', createAuthRoutes({ db: getTestDb() }));
  return app;
}

describe('Auth route Set-Cookie header propagation (regression for json-helper drop)', () => {
  beforeEach(() => {
    // setup.ts clears db between tests
  });

  it('POST /logout: clears session cookie via Set-Cookie header (no session)', async () => {
    // No session cookie path: route still appends Set-Cookie with Max-Age=0
    // before returning `json({ ok: true, data: null })`. Bug: header dropped.
    const app = buildApp();
    const res = await app.request('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('HttpOnly');
  });

  it('POST /logout: clears session cookie via Set-Cookie header (with valid session)', async () => {
    const token = randomBytes(16).toString('base64url');
    await seedUserAndSession({ token, expiresInMs: 60_000 });
    const app = buildApp();
    const res = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('Max-Age=0');
  });

  it('POST /revoke-all: returns 401 with cleared session cookie when session not found', async () => {
    // Path: lines 312-317 of auth.ts. A cookie is present but the session row
    // is missing (e.g., already revoked). The route clears the stale cookie
    // via `c.header('Set-Cookie', ...)` and returns `json({ ok:false, ... })`.
    // Bug: the Set-Cookie header is dropped because `json()` builds a fresh
    // Response outside Hono's context.
    const app = buildApp();
    const res = await app.request('/api/auth/revoke-all', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=stale-token-no-row` },
    });
    expect(res.status).toBe(401);
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('Max-Age=0');
  });

  it('POST /revoke-all: success path returns cleared session cookie', async () => {
    // Path: lines 332-334 of auth.ts. Same pattern — `c.header('Set-Cookie', ...)`
    // followed by `return json({ ok:true, ... })`.
    const token = randomBytes(16).toString('base64url');
    await seedUserAndSession({ token, expiresInMs: 60_000 });
    const app = buildApp();
    const res = await app.request('/api/auth/revoke-all', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('Max-Age=0');
  });

  it('GET /github/callback: failure path clears oauth_state cookie when token exchange fails', async () => {
    // Path: lines 234-256 of auth.ts. The OAuth callback failure branch sets
    // `Set-Cookie: oauth_state=; Max-Age=0` via `c.header()` then returns
    // `json({ ok:false, error: { code:'OAUTH_FAILED', ... } }, 400)`. Bug:
    // the cookie clear is dropped, leaving a stale state cookie in the browser.
    process.env.GITHUB_CLIENT_ID = 'test-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'bad_verification_code' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    try {
      const state = 'test-state-value';
      const app = buildApp();
      const res = await app.request(`/api/auth/github/callback?code=test-code&state=${state}`, {
        method: 'GET',
        headers: { Cookie: `oauth_state=${state}` },
      });
      expect(res.status).toBe(400);
      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).toContain('oauth_state=');
      expect(setCookie).toContain('Max-Age=0');
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
    }
  });
});
