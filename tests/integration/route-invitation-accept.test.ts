import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { teamInvitations, teamMembers, teams, users } from '../../src/db/schema';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { createInvitationAcceptRoutes } from '../../src/server/routes/invitation-accept';
import { hashToken } from '../../src/server/shared';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for invitation-accept API routes.
 *
 * Mounted at /api/invitations.
 * Tests the POST /:token/accept endpoint for accepting team invitations.
 *
 * Uses a single-call transaction wrapper to avoid the test helper's
 * monkey-patched transaction() invoking async callbacks twice.
 */

/**
 * Wrap the test db's transaction to only call the callback once.
 * See route-team-project-folders.test.ts for full explanation.
 */
function wrapDbForSingleCallTransaction(db: ReturnType<typeof getTestDb>) {
  const wrapped = Object.create(db);
  wrapped.transaction = (callback: (tx: any) => any) => callback(db);
  wrapped.query = db.query;
  wrapped.select = db.select.bind(db);
  wrapped.insert = db.insert.bind(db);
  wrapped.delete = db.delete.bind(db);
  wrapped.update = db.update.bind(db);
  return wrapped;
}

describe('Invitation Accept Routes (IT-570)', () => {
  let db: ReturnType<typeof getTestDb>;
  let wrappedDb: ReturnType<typeof getTestDb>;
  let teamId: string;
  let inviterId: string;
  let accepterId: string;
  let rawToken: string;
  let tokenHash: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    wrappedDb = wrapDbForSingleCallTransaction(db);

    // Create an inviter user
    inviterId = createId();
    await db.insert(users).values({
      id: inviterId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `inviter-${inviterId.slice(0, 6)}`,
      name: 'Inviter',
    });

    // Create an accepter user
    accepterId = createId();
    await db.insert(users).values({
      id: accepterId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `accepter-${accepterId.slice(0, 6)}`,
      name: 'Accepter',
      githubEmail: 'accepter@example.com',
    });

    // Create a team
    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Accept Team',
      slug: `accept-team-${teamId.slice(0, 8)}`,
    });

    // Make inviter an admin
    await db.insert(teamMembers).values({
      teamId,
      userId: inviterId,
      role: 'admin',
    });

    // Create a pending invitation with a known token
    rawToken = `test-token-${createId()}`;
    tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.insert(teamInvitations).values({
      teamId,
      invitedBy: inviterId,
      email: 'accepter@example.com',
      role: 'viewer',
      token: tokenHash,
      status: 'pending',
      expiresAt,
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  function createApp(authOverrides: Partial<AuthContext> = {}): Hono {
    const routes = createInvitationAcceptRoutes({ db: wrappedDb as any });
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use('*', async (c, next) => {
      c.set('auth', {
        userId: accepterId,
        authMethod: 'dev',
        user: {
          id: accepterId,
          githubId: 123,
          githubLogin: 'accepter',
          name: 'Accepter',
          email: 'accepter@example.com',
          githubEmail: 'accepter@example.com',
          avatarUrl: null,
        },
        ...authOverrides,
      } as AuthContext);
      await next();
    });
    app.route('/api/invitations', routes);
    return app;
  }

  // ─── POST /api/invitations/:token/accept ────────────

  it('IT-571: POST accepts a valid invitation and adds user to team', async () => {
    const app = createApp();

    const response = await app.request(`http://localhost/api/invitations/${rawToken}/accept`, {
      method: 'POST',
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.teamId).toBe(teamId);
    expect(body.data.role).toBe('viewer');
    expect(body.data.joinedAt).toBeDefined();
    expect(body.data.teamName).toBe('Accept Team');

    // Verify user was added to team_members
    const membership = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, accepterId)));
    expect(membership.length).toBe(1);
    expect(membership[0]?.role).toBe('viewer');
  });

  it('IT-572: POST returns 404 for invalid/unknown token', async () => {
    const app = createApp();

    const response = await app.request(
      'http://localhost/api/invitations/bogus-token-value/accept',
      { method: 'POST' }
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVITATION_NOT_FOUND');
  });

  it('IT-573: POST returns 404 for expired invitation', async () => {
    // Create an expired invitation
    const expiredToken = `expired-${createId()}`;
    const expiredHash = hashToken(expiredToken);
    await db.insert(teamInvitations).values({
      teamId,
      invitedBy: inviterId,
      email: 'accepter@example.com',
      role: 'viewer',
      token: expiredHash,
      status: 'pending',
      expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    });

    const app = createApp();
    const response = await app.request(`http://localhost/api/invitations/${expiredToken}/accept`, {
      method: 'POST',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVITATION_NOT_FOUND');
  });

  it('IT-574: POST returns 404 for already-accepted invitation', async () => {
    // Accept first
    const app = createApp();
    await app.request(`http://localhost/api/invitations/${rawToken}/accept`, {
      method: 'POST',
    });

    // Try to accept again (status is no longer 'pending')
    const response = await app.request(`http://localhost/api/invitations/${rawToken}/accept`, {
      method: 'POST',
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVITATION_NOT_FOUND');
  });

  it('IT-575: POST returns 409 when user is already a team member', async () => {
    // Add the accepter directly to the team first
    await db.insert(teamMembers).values({
      teamId,
      userId: accepterId,
      role: 'admin',
    });

    const app = createApp();
    const response = await app.request(`http://localhost/api/invitations/${rawToken}/accept`, {
      method: 'POST',
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MEMBER_ALREADY_EXISTS');
  });

  it('IT-576: POST returns 403 for email mismatch (non-dev auth)', async () => {
    // Create invitation for a different email
    const mismatchToken = `mismatch-${createId()}`;
    const mismatchHash = hashToken(mismatchToken);
    await db.insert(teamInvitations).values({
      teamId,
      invitedBy: inviterId,
      email: 'different@example.com',
      role: 'viewer',
      token: mismatchHash,
      status: 'pending',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });

    // Use session auth (non-dev) with a mismatched githubEmail
    const app = createApp({
      authMethod: 'session',
      user: {
        id: accepterId,
        githubId: 123,
        githubLogin: 'accepter',
        name: 'Accepter',
        email: 'accepter@example.com',
        githubEmail: 'accepter@example.com', // does not match 'different@example.com'
        avatarUrl: null,
      },
    });

    const response = await app.request(`http://localhost/api/invitations/${mismatchToken}/accept`, {
      method: 'POST',
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVITATION_EMAIL_MISMATCH');
  });

  it('IT-577: POST returns 403 when user has no verified email (non-dev auth)', async () => {
    // Use session auth with no githubEmail
    const app = createApp({
      authMethod: 'session',
      user: {
        id: accepterId,
        githubId: 123,
        githubLogin: 'accepter',
        name: 'Accepter',
        email: null,
        githubEmail: null, // no verified email
        avatarUrl: null,
      },
    });

    const response = await app.request(`http://localhost/api/invitations/${rawToken}/accept`, {
      method: 'POST',
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('IT-578: POST returns 400 for invalid token format', async () => {
    const app = createApp();

    const response = await app.request('http://localhost/api/invitations/inv@lid!token/accept', {
      method: 'POST',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  // ─── Invitation status verification ─────────────────

  it('IT-579: Accepting an invitation marks it as accepted in DB', async () => {
    const app = createApp();
    await app.request(`http://localhost/api/invitations/${rawToken}/accept`, {
      method: 'POST',
    });

    // Find the invitation by token hash
    const inv = await db.select().from(teamInvitations).where(eq(teamInvitations.token, tokenHash));
    expect(inv[0]?.status).toBe('accepted');
  });
});
