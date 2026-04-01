import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubTokens, teamMembers, teams, users } from '../../src/db/schema';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { decryptToken, encryptToken } from '../../src/lib/crypto/server-encryption';
import { createTeamGitHubTokenRoutes } from '../../src/server/routes/team-github-token';
import { RbacService } from '../../src/services/rbac.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for team-github-token API routes.
 *
 * Mounted at /api/teams/:id/github-token.
 * Tests GET, PUT, DELETE, and POST /validate for team GitHub PATs.
 *
 * NOTE: PUT and POST /validate hit the GitHub API (Octokit). Those tests
 * mock Octokit at the module level to avoid real network calls.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

// Mock Octokit to avoid real GitHub API calls.
// Must use a regular function (not arrow) so it works with `new Octokit(...)`.
vi.mock('octokit', () => {
  return {
    Octokit: function MockOctokit() {
      return {
        rest: {
          users: {
            getAuthenticated: () => Promise.resolve({ data: { login: 'mock-user', id: 99999 } }),
          },
        },
      };
    },
  };
});

describe('Team GitHub Token Routes (IT-580)', () => {
  let outerApp: Hono;
  let db: ReturnType<typeof getTestDb>;
  let rbacService: RbacService;
  let teamId: string;
  let userId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    rbacService = new RbacService(db as any);

    // Create a test user
    userId = createId();
    await db.insert(users).values({
      id: userId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `gh-token-user-${userId.slice(0, 6)}`,
      name: 'Token User',
    });

    // Create a team
    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Token Team',
      slug: `token-team-${teamId.slice(0, 8)}`,
    });

    // Make user an admin
    await db.insert(teamMembers).values({
      teamId,
      userId,
      role: 'admin',
    });

    // Mount routes
    const routes = createTeamGitHubTokenRoutes({ db: db as any, rbacService });
    outerApp = new Hono<{ Variables: { auth: AuthContext } }>();
    outerApp.use('*', async (c, next) => {
      c.set('auth', { userId, authMethod: 'dev' });
      await next();
    });
    outerApp.route('/api/teams/:id/github-token', routes);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await clearTestDatabase();
  });

  // ─── GET /api/teams/:id/github-token ────────────────

  it('IT-581: GET returns 404 when no token is configured', async () => {
    const response = await outerApp.request(`http://localhost/api/teams/${teamId}/github-token`);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('IT-582: GET returns masked token info when token exists', async () => {
    // Insert a token directly
    const rawPat = 'ghp_testtoken1234567890abcdefghij';
    const encrypted = encryptToken(rawPat);
    await db.insert(githubTokens).values({
      encryptedToken: encrypted,
      tokenType: 'pat',
      githubLogin: 'test-login',
      githubId: '12345',
      teamId,
      isValid: true,
      lastValidatedAt: new Date().toISOString(),
    });

    const response = await outerApp.request(`http://localhost/api/teams/${teamId}/github-token`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.githubLogin).toBe('test-login');
    expect(body.data.isValid).toBe(true);
    expect(body.data.maskedToken).toBeDefined();
    // Masked token should not contain the full PAT
    expect(body.data.maskedToken).not.toBe(rawPat);
    expect(body.data.maskedToken).toContain('ghp_');
    expect(body.data.id).toBeDefined();
    expect(body.data.tokenType).toBe('pat');
  });

  it('IT-583: GET returns 400 for invalid team ID format', async () => {
    const response = await outerApp.request('http://localhost/api/teams/inv@lid!/github-token');

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  // ─── PUT /api/teams/:id/github-token ────────────────

  it('IT-584: PUT saves a new GitHub token', async () => {
    const response = await outerApp.request(
      jsonRequest(
        `http://localhost/api/teams/${teamId}/github-token`,
        { token: 'ghp_validtoken1234567890abcdef' },
        { method: 'PUT' }
      )
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.tokenInfo).toBeDefined();
    expect(body.data.tokenInfo.githubLogin).toBe('mock-user');
    expect(body.data.tokenInfo.isValid).toBe(true);
    expect(body.data.tokenInfo.maskedToken).toBeDefined();

    // Verify token is stored encrypted in DB
    const stored = await db.query.githubTokens.findFirst({
      where: eq(githubTokens.teamId, teamId),
    });
    expect(stored).toBeDefined();
    const decrypted = decryptToken(stored!.encryptedToken);
    expect(decrypted).toBe('ghp_validtoken1234567890abcdef');
  });

  it('IT-585: PUT replaces existing token', async () => {
    // First save
    await outerApp.request(
      jsonRequest(
        `http://localhost/api/teams/${teamId}/github-token`,
        { token: 'ghp_firsttoken1234567890abcdef' },
        { method: 'PUT' }
      )
    );

    // Second save (replace)
    const response = await outerApp.request(
      jsonRequest(
        `http://localhost/api/teams/${teamId}/github-token`,
        { token: 'ghp_secondtoken123456789abcdef' },
        { method: 'PUT' }
      )
    );

    expect(response.status).toBe(200);

    // Verify only one token exists for the team
    const tokens = await db.select().from(githubTokens).where(eq(githubTokens.teamId, teamId));
    expect(tokens.length).toBe(1);
    const decrypted = decryptToken(tokens[0]!.encryptedToken);
    expect(decrypted).toBe('ghp_secondtoken123456789abcdef');
  });

  it('IT-586: PUT returns 400 for invalid PAT format', async () => {
    const response = await outerApp.request(
      jsonRequest(
        `http://localhost/api/teams/${teamId}/github-token`,
        { token: 'invalid-no-prefix-token' },
        { method: 'PUT' }
      )
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_FORMAT');
  });

  it('IT-587: PUT returns 400 for empty token', async () => {
    const response = await outerApp.request(
      jsonRequest(
        `http://localhost/api/teams/${teamId}/github-token`,
        { token: '' },
        { method: 'PUT' }
      )
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-588: PUT returns 400 for missing token field', async () => {
    const response = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/github-token`, {}, { method: 'PUT' })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-589: PUT returns 400 for invalid JSON body', async () => {
    const response = await outerApp.request(
      new Request(`http://localhost/api/teams/${teamId}/github-token`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-590: PUT accepts fine-grained PAT format', async () => {
    const response = await outerApp.request(
      jsonRequest(
        `http://localhost/api/teams/${teamId}/github-token`,
        { token: 'github_pat_testtoken1234567890' },
        { method: 'PUT' }
      )
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  // ─── DELETE /api/teams/:id/github-token ─────────────

  it('IT-591: DELETE removes the team token', async () => {
    // Store a token first
    const encrypted = encryptToken('ghp_deleteme1234567890abcdef');
    await db.insert(githubTokens).values({
      encryptedToken: encrypted,
      tokenType: 'pat',
      teamId,
      isValid: true,
    });

    const response = await outerApp.request(`http://localhost/api/teams/${teamId}/github-token`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data).toBeNull();

    // Verify it's gone from DB
    const remaining = await db.select().from(githubTokens).where(eq(githubTokens.teamId, teamId));
    expect(remaining.length).toBe(0);
  });

  it('IT-592: DELETE returns 404 when no token exists', async () => {
    const response = await outerApp.request(`http://localhost/api/teams/${teamId}/github-token`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  // ─── POST /api/teams/:id/github-token/validate ─────

  it('IT-593: POST /validate validates a stored token', async () => {
    // Store a valid token
    const encrypted = encryptToken('ghp_validate1234567890abcdef');
    await db.insert(githubTokens).values({
      encryptedToken: encrypted,
      tokenType: 'pat',
      teamId,
      isValid: false, // starts as invalid
    });

    const response = await outerApp.request(
      `http://localhost/api/teams/${teamId}/github-token/validate`,
      { method: 'POST' }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.isValid).toBe(true);

    // Verify DB was updated
    const token = await db.query.githubTokens.findFirst({
      where: eq(githubTokens.teamId, teamId),
    });
    expect(token?.isValid).toBe(true);
    expect(token?.lastValidatedAt).toBeDefined();
  });

  it('IT-594: POST /validate returns 404 when no token configured', async () => {
    const response = await outerApp.request(
      `http://localhost/api/teams/${teamId}/github-token/validate`,
      { method: 'POST' }
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  // ─── RBAC enforcement ──────────────────────────────

  it('IT-595: GET returns 403 for non-admin team member', async () => {
    const viewerId = createId();
    await db.insert(users).values({
      id: viewerId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `viewer-gh-${viewerId.slice(0, 6)}`,
      name: 'Viewer',
    });
    await db.insert(teamMembers).values({ teamId, userId: viewerId, role: 'viewer' });

    const routes = createTeamGitHubTokenRoutes({ db: db as any, rbacService });
    const viewerApp = new Hono<{ Variables: { auth: AuthContext } }>();
    viewerApp.use('*', async (c, next) => {
      c.set('auth', { userId: viewerId, authMethod: 'session' });
      await next();
    });
    viewerApp.route('/api/teams/:id/github-token', routes);

    const response = await viewerApp.request(`http://localhost/api/teams/${teamId}/github-token`);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('IT-596: PUT returns 403 for non-admin team member', async () => {
    const viewerId = createId();
    await db.insert(users).values({
      id: viewerId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `viewer-put-${viewerId.slice(0, 6)}`,
      name: 'Viewer',
    });
    await db.insert(teamMembers).values({ teamId, userId: viewerId, role: 'viewer' });

    const routes = createTeamGitHubTokenRoutes({ db: db as any, rbacService });
    const viewerApp = new Hono<{ Variables: { auth: AuthContext } }>();
    viewerApp.use('*', async (c, next) => {
      c.set('auth', { userId: viewerId, authMethod: 'session' });
      await next();
    });
    viewerApp.route('/api/teams/:id/github-token', routes);

    const response = await viewerApp.request(
      jsonRequest(
        `http://localhost/api/teams/${teamId}/github-token`,
        { token: 'ghp_viewertest1234567890abcdef' },
        { method: 'PUT' }
      )
    );

    expect(response.status).toBe(403);
  });

  it('IT-597: DELETE returns 403 for non-admin team member', async () => {
    const viewerId = createId();
    await db.insert(users).values({
      id: viewerId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `viewer-del-${viewerId.slice(0, 6)}`,
      name: 'Viewer',
    });
    await db.insert(teamMembers).values({ teamId, userId: viewerId, role: 'viewer' });

    const routes = createTeamGitHubTokenRoutes({ db: db as any, rbacService });
    const viewerApp = new Hono<{ Variables: { auth: AuthContext } }>();
    viewerApp.use('*', async (c, next) => {
      c.set('auth', { userId: viewerId, authMethod: 'session' });
      await next();
    });
    viewerApp.route('/api/teams/:id/github-token', routes);

    const response = await viewerApp.request(`http://localhost/api/teams/${teamId}/github-token`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(403);
  });

  // ─── Round-trip test ────────────────────────────────

  it('IT-598: Full round-trip: save, get, validate, delete, verify gone', async () => {
    // Save
    const saveRes = await outerApp.request(
      jsonRequest(
        `http://localhost/api/teams/${teamId}/github-token`,
        { token: 'ghp_roundtriptoken12345678abcde' },
        { method: 'PUT' }
      )
    );
    expect(saveRes.status).toBe(200);

    // Get
    const getRes = await outerApp.request(`http://localhost/api/teams/${teamId}/github-token`);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.ok).toBe(true);
    expect(getBody.data.githubLogin).toBe('mock-user');
    expect(getBody.data.isValid).toBe(true);

    // Validate
    const validateRes = await outerApp.request(
      `http://localhost/api/teams/${teamId}/github-token/validate`,
      { method: 'POST' }
    );
    expect(validateRes.status).toBe(200);
    const validateBody = await validateRes.json();
    expect(validateBody.data.isValid).toBe(true);

    // Delete
    const delRes = await outerApp.request(`http://localhost/api/teams/${teamId}/github-token`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);

    // Verify gone
    const verifyRes = await outerApp.request(`http://localhost/api/teams/${teamId}/github-token`);
    expect(verifyRes.status).toBe(404);
  });
});
