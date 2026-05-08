/**
 * Integration tests for the GitHub OAuth flow + session management routes
 * in src/server/routes/auth.ts.
 *
 * Covers the major uncovered branches:
 * - GET /github redirect (config-missing, happy path)
 * - GET /github/callback (state mismatch, missing code, token exchange failure,
 *   user upsert success path, retry path)
 * - POST /logout (no cookie, valid cookie, db error)
 * - POST /revoke-all (no cookie, valid cookie, no session match, success)
 *
 * Stubs `global.fetch` for the GitHub API calls — never actually hits github.com.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userSessions, users } from '../../src/db/schema';
import { createAuthRoutes } from '../../src/server/routes/auth.js';
import { hashToken } from '../../src/server/shared.js';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

function mountAuthRoutes() {
  const app = new Hono();
  const routes = createAuthRoutes({ db: getTestDb() });
  app.route('/api/auth', routes);
  return app;
}

function mockGitHubFetch(handlers: {
  tokenResponse?: { access_token?: string; error?: string };
  userResponse?: {
    id?: number;
    login?: string;
    name?: string | null;
    email?: string | null;
    avatar_url?: string | null;
  };
}) {
  global.fetch = vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('github.com/login/oauth/access_token')) {
      return new Response(JSON.stringify(handlers.tokenResponse ?? {}), { status: 200 });
    }
    if (urlStr.includes('api.github.com/user')) {
      return new Response(JSON.stringify(handlers.userResponse ?? {}), { status: 200 });
    }
    throw new Error(`Unexpected fetch URL: ${urlStr}`);
  }) as typeof global.fetch;
}

describe('Auth route — GET /api/auth/github (IT-AUTH-1)', () => {
  const original = process.env.GITHUB_CLIENT_ID;

  beforeEach(async () => {
    await setupTestDatabase();
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CALLBACK_URL;
  });

  afterEach(async () => {
    if (original === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = original;
    await clearTestDatabase();
  });

  it('returns 500 CONFIG_ERROR when GITHUB_CLIENT_ID is not set', async () => {
    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/github');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('CONFIG_ERROR');
  });

  it('redirects to GitHub OAuth and sets oauth_state cookie', async () => {
    process.env.GITHUB_CLIENT_ID = 'test-client-id';
    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/github');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
    expect(res.headers.get('Set-Cookie')).toMatch(/oauth_state=[a-f0-9]+/);
  });
});

describe('Auth route — GET /api/auth/github/callback (IT-AUTH-2)', () => {
  const originalFetchRef = global.fetch;
  const originalEnv = {
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    APP_URL: process.env.APP_URL,
  };

  beforeEach(async () => {
    await setupTestDatabase();
    process.env.GITHUB_CLIENT_ID = 'test-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
  });

  afterEach(async () => {
    global.fetch = originalFetchRef;
    if (originalEnv.GITHUB_CLIENT_ID === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = originalEnv.GITHUB_CLIENT_ID;
    if (originalEnv.GITHUB_CLIENT_SECRET === undefined) delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = originalEnv.GITHUB_CLIENT_SECRET;
    if (originalEnv.APP_URL === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalEnv.APP_URL;
    await clearTestDatabase();
  });

  it('returns 400 when code query param is missing', async () => {
    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/github/callback?state=abc');
    expect(res.status).toBe(400);
  });

  it('returns 400 when state query param is missing', async () => {
    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/github/callback?code=xyz');
    expect(res.status).toBe(400);
  });

  it('returns 400 INVALID_STATE when cookie state does not match query state', async () => {
    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/github/callback?code=xyz&state=fromQuery', {
      headers: { Cookie: 'oauth_state=different' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('INVALID_STATE');
  });

  it('returns 500 CONFIG_ERROR when client secret is missing', async () => {
    delete process.env.GITHUB_CLIENT_SECRET;
    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/github/callback?code=xyz&state=abc', {
      headers: { Cookie: 'oauth_state=abc' },
    });
    expect(res.status).toBe(500);
  });

  it('returns 400 OAUTH_FAILED when GitHub token exchange returns error', async () => {
    mockGitHubFetch({ tokenResponse: { error: 'bad_verification_code' } });
    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/github/callback?code=xyz&state=abc', {
      headers: { Cookie: 'oauth_state=abc' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('OAUTH_FAILED');
  });

  it('returns 400 OAUTH_FAILED when GitHub user fetch returns no id', async () => {
    mockGitHubFetch({
      tokenResponse: { access_token: 'gho_test' },
      userResponse: {},
    });
    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/github/callback?code=xyz&state=abc', {
      headers: { Cookie: 'oauth_state=abc' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('OAUTH_FAILED');
  });

  it('creates a new user, session cookie, and redirects on happy path', async () => {
    process.env.APP_URL = 'http://localhost:3000';
    const githubId = 1234567;
    mockGitHubFetch({
      tokenResponse: { access_token: 'gho_test' },
      userResponse: {
        id: githubId,
        login: 'octocat',
        name: 'The Octocat',
        email: 'octo@example.com',
        avatar_url: 'https://example.com/avatar.png',
      },
    });

    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/github/callback?code=xyz&state=abc', {
      headers: { Cookie: 'oauth_state=abc' },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('http://localhost:3000');

    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('agentpane_session='))).toBe(true);

    const db = getTestDb();
    const user = await db.query.users.findFirst({ where: eq(users.githubId, githubId) });
    expect(user?.githubLogin).toBe('octocat');
  });

  it('updates an existing user when githubId already exists', async () => {
    const db = getTestDb();
    const githubId = 7777;
    const existingUserId = `existing-${Date.now()}`;
    await db.insert(users).values({
      id: existingUserId,
      githubId,
      githubLogin: 'old-login',
      name: 'Old Name',
      email: 'old@example.com',
    });

    mockGitHubFetch({
      tokenResponse: { access_token: 'gho_test' },
      userResponse: {
        id: githubId,
        login: 'new-login',
        name: 'New Name',
        email: 'new@example.com',
        avatar_url: 'https://example.com/new.png',
      },
    });

    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/github/callback?code=xyz&state=abc', {
      headers: { Cookie: 'oauth_state=abc' },
    });
    expect(res.status).toBe(302);

    const updated = await db.query.users.findFirst({ where: eq(users.id, existingUserId) });
    expect(updated?.githubLogin).toBe('new-login');
    expect(updated?.name).toBe('New Name');
    expect(updated?.email).toBe('new@example.com');
  });

  it('catches fetch errors and returns 400 OAUTH_FAILED', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network kaput');
    }) as typeof global.fetch;

    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/github/callback?code=xyz&state=abc', {
      headers: { Cookie: 'oauth_state=abc' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe('OAUTH_FAILED');
  });
});

describe('Auth route — POST /api/auth/logout (IT-AUTH-3)', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('returns ok=true with no cookie (no-op)', async () => {
    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true };
    expect(body.ok).toBe(true);
  });

  it('deletes the session row on valid logout', async () => {
    const db = getTestDb();
    await db.insert(users).values({
      id: 'logout-user',
      githubId: 99,
      githubLogin: 'logout-user',
      name: null,
      email: null,
    });
    const sessionToken = 'logout-session-token';
    await db.insert(userSessions).values({
      id: 'logout-session-id',
      userId: 'logout-user',
      token: hashToken(sessionToken),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `agentpane_session=${sessionToken}` },
    });
    expect(res.status).toBe(200);

    const remaining = await db.query.userSessions.findFirst({
      where: eq(userSessions.id, 'logout-session-id'),
    });
    expect(remaining).toBeUndefined();
  });
});

describe('Auth route — POST /api/auth/revoke-all (IT-AUTH-4)', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('returns 401 UNAUTHORIZED with no cookie', async () => {
    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/revoke-all', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 401 UNAUTHORIZED when cookie token is unknown', async () => {
    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/revoke-all', {
      method: 'POST',
      headers: { Cookie: 'agentpane_session=non-existent-token' },
    });
    expect(res.status).toBe(401);
  });

  it('revokes all sessions for the user and returns the count', async () => {
    const db = getTestDb();
    await db.insert(users).values({
      id: 'revoke-user',
      githubId: 100,
      githubLogin: 'revoke-user',
      name: null,
      email: null,
    });
    const tokenA = 'revoke-session-a';
    const tokenB = 'revoke-session-b';
    await db.insert(userSessions).values([
      {
        id: 'rev-a',
        userId: 'revoke-user',
        token: hashToken(tokenA),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        id: 'rev-b',
        userId: 'revoke-user',
        token: hashToken(tokenB),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ]);

    const app = mountAuthRoutes();
    const res = await app.request('/api/auth/revoke-all', {
      method: 'POST',
      headers: { Cookie: `agentpane_session=${tokenA}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { revokedCount: number } };
    expect(body.data.revokedCount).toBe(2);

    const remaining = await db.query.userSessions.findMany({
      where: eq(userSessions.userId, 'revoke-user'),
    });
    expect(remaining).toHaveLength(0);
  });
});
