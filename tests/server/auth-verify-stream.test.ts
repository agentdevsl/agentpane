/**
 * F05-07: /api/auth/verify-stream — Caddy forward_auth endpoint.
 *
 * Verifies:
 *   1. Missing/unknown session cookie → 401 UNAUTHORIZED.
 *   2. Expired session → 401 SESSION_EXPIRED.
 *   3. Valid cookie + malformed stream URI → 400 INVALID_URI.
 *   4. Valid cookie + well-formed URI → 200 with user ID + stream metadata.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { userSessions } from '../../src/db/schema/sqlite/user-sessions.js';
import { users } from '../../src/db/schema/sqlite/users.js';
import { createAuthRoutes } from '../../src/server/routes/auth.js';
import { hashToken } from '../../src/server/shared.js';
import { getTestDb } from '../helpers/database.js';

async function seedUserAndSession(opts: { token: string; expiresInMs: number }) {
  const db = getTestDb();
  const userId = 'user-verify-stream';
  await db
    .insert(users)
    .values({
      id: userId,
      githubId: 9999,
      githubLogin: 'verify-stream-tester',
      name: 'Verify Stream',
      email: 'vs@example.com',
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

describe('/api/auth/verify-stream (F05-07)', () => {
  beforeEach(async () => {
    // setUp resets db in setup.ts afterEach
  });

  it('returns 401 when no session cookie is present', async () => {
    const app = buildApp();
    const res = await app.request('/api/auth/verify-stream', {
      method: 'POST',
      headers: { 'X-Original-URI': '/v1/stream/sessions/abc' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 when X-Original-URI is malformed', async () => {
    await seedUserAndSession({ token: 'tok-good', expiresInMs: 60_000 });
    const app = buildApp();
    const res = await app.request('/api/auth/verify-stream', {
      method: 'POST',
      headers: {
        'X-Original-URI': '/v1/stream/../weird',
        Cookie: 'agentpane_session=tok-good',
      },
    });
    expect(res.status).toBe(400);
  });

  it('returns 200 for a valid session + well-formed stream URI', async () => {
    const userId = await seedUserAndSession({ token: 'tok-valid', expiresInMs: 60_000 });
    const app = buildApp();
    const res = await app.request('/api/auth/verify-stream', {
      method: 'POST',
      headers: {
        'X-Original-URI': '/v1/stream/plans/plan-xyz',
        Cookie: 'agentpane_session=tok-valid',
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data?: { userId: string; streamKind: string; streamId: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.userId).toBe(userId);
    expect(body.data?.streamKind).toBe('plans');
    expect(body.data?.streamId).toBe('plan-xyz');
  });

  it('returns 401 when the session is expired', async () => {
    await seedUserAndSession({ token: 'tok-expired', expiresInMs: -60_000 });
    const app = buildApp();
    const res = await app.request('/api/auth/verify-stream', {
      method: 'POST',
      headers: {
        'X-Original-URI': '/v1/stream/sessions/abc',
        Cookie: 'agentpane_session=tok-expired',
      },
    });
    expect(res.status).toBe(401);
  });
});
