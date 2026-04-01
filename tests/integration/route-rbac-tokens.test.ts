import { createHash, randomBytes } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiTokens, teamMembers, teams, users } from '../../src/db/schema';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { createRbacTokensRoutes } from '../../src/server/routes/rbac-tokens';
import { RbacService } from '../../src/services/rbac.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for RBAC token API routes.
 *
 * Creates a real Hono app with the rbac-tokens routes mounted,
 * backed by a real SQLite database. Auth context is injected via
 * middleware to simulate authenticated requests.
 *
 * NOTE: POST / uses db.transaction() which has known double-invocation
 * issues with the test DB's async monkey-patch. Token creation for
 * GET/DELETE tests uses direct DB inserts. POST validation tests use
 * invalid input that fails BEFORE the transaction.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

/** Insert a token directly into the DB (bypassing the route's transaction). */
async function insertToken(
  db: ReturnType<typeof getTestDb>,
  opts: { userId: string; teamId: string; name: string; role: string; status?: string }
) {
  const rawToken = `ap_${randomBytes(32).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const tokenPrefix = rawToken.substring(0, 12);

  const [created] = await db
    .insert(apiTokens)
    .values({
      userId: opts.userId,
      teamId: opts.teamId,
      name: opts.name,
      tokenHash,
      tokenPrefix,
      role: opts.role as any,
      status: (opts.status ?? 'active') as any,
    })
    .returning();

  return { ...created!, rawToken };
}

describe('RBAC Token Routes (IT-440)', () => {
  let outerApp: Hono;
  let db: ReturnType<typeof getTestDb>;
  let rbacService: RbacService;
  let userId: string;
  let teamId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    rbacService = new RbacService(db);

    // Create a test user
    userId = createId();
    const uniqueGithubId = Math.floor(Math.random() * 1000000000);
    await db.insert(users).values({
      id: userId,
      githubId: uniqueGithubId,
      githubLogin: `token-user-${userId.slice(0, 6)}`,
      name: 'Token Test User',
    });

    // Create a test team
    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Token Team',
      slug: `token-team-${teamId.slice(0, 8)}`,
    });

    // Add user as admin of the team
    await db.insert(teamMembers).values({
      teamId,
      userId,
      role: 'admin',
    });

    // Create the routes with auth context injected via middleware
    const tokenRoutes = createRbacTokensRoutes({ db: db as any, rbacService });

    outerApp = new Hono();
    outerApp.use('/*', async (c, next) => {
      const auth: AuthContext = {
        userId,
        authMethod: 'dev',
      };
      c.set('auth', auth);
      await next();
    });
    outerApp.route('/', tokenRoutes);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── POST /api/tokens (validation tests) ────────────

  it('IT-443: POST / returns 400 for missing required fields', async () => {
    const response = await outerApp.request(
      jsonRequest('http://localhost/', {
        role: 'viewer',
        // missing name and teamId
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-443b: POST / returns 400 for invalid role', async () => {
    const response = await outerApp.request(
      jsonRequest('http://localhost/', {
        name: 'Bad Role Token',
        teamId,
        role: 'superadmin',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-443c: POST / returns 400 for empty name', async () => {
    const response = await outerApp.request(
      jsonRequest('http://localhost/', {
        name: '',
        teamId,
        role: 'viewer',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  // ─── GET /api/tokens ───────────────────────────────

  it('IT-445: GET / lists user tokens with pagination', async () => {
    // Insert 3 tokens directly
    for (let i = 1; i <= 3; i++) {
      await insertToken(db, { userId, teamId, name: `Token ${i}`, role: 'viewer' });
    }

    const response = await outerApp.request('http://localhost/');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(3);
    expect(body.data.totalCount).toBe(3);
    expect(body.data.hasMore).toBe(false);
  });

  it('IT-446: GET / supports limit and cursor pagination', async () => {
    for (let i = 1; i <= 5; i++) {
      await insertToken(db, { userId, teamId, name: `Paginated ${i}`, role: 'viewer' });
    }

    const response = await outerApp.request('http://localhost/?limit=2');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items).toHaveLength(2);
    expect(body.data.hasMore).toBe(true);
    expect(body.data.nextCursor).toBeDefined();

    // Fetch next page using cursor
    const nextResponse = await outerApp.request(
      `http://localhost/?limit=2&cursor=${body.data.nextCursor}`
    );
    const nextBody = await nextResponse.json();
    expect(nextBody.data.items).toHaveLength(2);
  });

  it('IT-447: GET / filters by teamId', async () => {
    // Create a second team
    const team2Id = createId();
    await db.insert(teams).values({
      id: team2Id,
      name: 'Other Team',
      slug: `other-${team2Id.slice(0, 8)}`,
    });
    await db.insert(teamMembers).values({ teamId: team2Id, userId, role: 'admin' });

    await insertToken(db, { userId, teamId, name: 'Team1 Token', role: 'viewer' });
    await insertToken(db, { userId, teamId: team2Id, name: 'Team2 Token', role: 'viewer' });

    const response = await outerApp.request(`http://localhost/?teamId=${teamId}`);
    const body = await response.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.totalCount).toBe(1);
  });

  it('IT-448: GET / returns 400 for invalid status filter', async () => {
    const response = await outerApp.request('http://localhost/?status=invalid');
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-449: GET /?status=all includes revoked tokens', async () => {
    // Insert a token with revoked status directly
    await insertToken(db, {
      userId,
      teamId,
      name: 'Active Token',
      role: 'viewer',
      status: 'active',
    });
    await insertToken(db, {
      userId,
      teamId,
      name: 'Revoked Token',
      role: 'viewer',
      status: 'revoked',
    });

    // Default listing should NOT include revoked
    const defaultRes = await outerApp.request('http://localhost/');
    const defaultBody = await defaultRes.json();
    expect(defaultBody.data.items).toHaveLength(1);
    expect(defaultBody.data.items[0].name).toBe('Active Token');

    // status=all should include both
    const allRes = await outerApp.request('http://localhost/?status=all');
    const allBody = await allRes.json();
    expect(allBody.data.items).toHaveLength(2);
  });

  // ─── GET /api/tokens/:id ───────────────────────────

  it('IT-450: GET /:id returns token details', async () => {
    const { id: tokenId } = await insertToken(db, {
      userId,
      teamId,
      name: 'Details Token',
      role: 'admin',
    });

    const response = await outerApp.request(`http://localhost/${tokenId}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe(tokenId);
    expect(body.data.name).toBe('Details Token');
    expect(body.data.role).toBe('admin');
    expect(body.data.teamName).toBe('Token Team');
  });

  it('IT-451: GET /:id returns 404 for nonexistent token', async () => {
    const response = await outerApp.request('http://localhost/nonexistent-token-abc');
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('IT-452: GET /:id returns 400 for invalid ID format', async () => {
    const response = await outerApp.request('http://localhost/ab!invalid');
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  // ─── DELETE /api/tokens/:id ─────────────────────────

  it('IT-453: DELETE /:id revokes a token', async () => {
    const { id: tokenId } = await insertToken(db, {
      userId,
      teamId,
      name: 'Revoke Me',
      role: 'viewer',
    });

    const response = await outerApp.request(`http://localhost/${tokenId}`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.revoked).toBe(true);

    // Verify the token status in DB
    const [updated] = await db
      .select({ status: apiTokens.status, revokedAt: apiTokens.revokedAt })
      .from(apiTokens)
      .where(eq(apiTokens.id, tokenId));
    expect(updated.status).toBe('revoked');
    expect(updated.revokedAt).toBeDefined();
  });

  it('IT-454: DELETE /:id returns 409 for already-revoked token', async () => {
    const { id: tokenId } = await insertToken(db, {
      userId,
      teamId,
      name: 'Already Revoked',
      role: 'viewer',
      status: 'revoked',
    });

    const response = await outerApp.request(`http://localhost/${tokenId}`, { method: 'DELETE' });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('ALREADY_REVOKED');
  });

  it('IT-455: DELETE /:id returns 404 for nonexistent token', async () => {
    const response = await outerApp.request('http://localhost/nonexistent-token-del', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
