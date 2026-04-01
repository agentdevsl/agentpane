import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { teamInvitations, teamMembers, teams, users } from '../../src/db/schema';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { createTeamInvitationsRoutes } from '../../src/server/routes/team-invitations';
import { RbacService } from '../../src/services/rbac.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for team-invitations API routes.
 *
 * Mounted at /api/teams/:id/invitations.
 * Tests creating, listing, declining, and revoking team invitations.
 *
 * Uses a single-call transaction wrapper to avoid the test helper's
 * monkey-patched transaction() invoking async callbacks twice.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

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

describe('Team Invitation Routes (IT-550)', () => {
  let outerApp: Hono;
  let db: ReturnType<typeof getTestDb>;
  let wrappedDb: ReturnType<typeof getTestDb>;
  let rbacService: RbacService;
  let teamId: string;
  let userId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    wrappedDb = wrapDbForSingleCallTransaction(db);
    rbacService = new RbacService(db as any);

    // Create a test user (inviter)
    userId = createId();
    await db.insert(users).values({
      id: userId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `inviter-${userId.slice(0, 6)}`,
      name: 'Inviter User',
    });

    // Create a team
    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Invitations Team',
      slug: `inv-team-${teamId.slice(0, 8)}`,
    });

    // Make user an admin of the team
    await db.insert(teamMembers).values({
      teamId,
      userId,
      role: 'admin',
    });

    // Mount routes with wrapped db
    const routes = createTeamInvitationsRoutes({ db: wrappedDb as any, rbacService });
    outerApp = new Hono<{ Variables: { auth: AuthContext } }>();
    outerApp.use('*', async (c, next) => {
      c.set('auth', { userId, authMethod: 'dev' });
      await next();
    });
    outerApp.route('/api/teams/:id/invitations', routes);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── POST /api/teams/:id/invitations ────────────────

  it('IT-551: POST creates a new invitation', async () => {
    const response = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        email: 'newuser@example.com',
        role: 'viewer',
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.teamId).toBe(teamId);
    expect(body.data.email).toBe('newuser@example.com');
    expect(body.data.role).toBe('viewer');
    expect(body.data.token).toBeDefined();
    expect(body.data.expiresAt).toBeDefined();
    expect(body.data.id).toBeDefined();
  });

  it('IT-552: POST returns 409 for duplicate pending invitation', async () => {
    // Create first invitation
    await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        email: 'dupe@example.com',
        role: 'viewer',
      })
    );

    // Try to create another for the same email
    const response = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        email: 'dupe@example.com',
        role: 'admin',
      })
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVITATION_ALREADY_EXISTS');
  });

  it('IT-553: POST returns 409 when user with email is already a member', async () => {
    // Create a user with the target email and add them to the team
    const memberId = createId();
    await db.insert(users).values({
      id: memberId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `existing-${memberId.slice(0, 6)}`,
      name: 'Existing Member',
      githubEmail: 'already-member@example.com',
    });
    await db.insert(teamMembers).values({ teamId, userId: memberId, role: 'viewer' });

    const response = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        email: 'already-member@example.com',
        role: 'viewer',
      })
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MEMBER_ALREADY_EXISTS');
  });

  it('IT-554: POST returns 400 for invalid email', async () => {
    const response = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        email: 'not-an-email',
        role: 'viewer',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-555: POST returns 400 for missing email', async () => {
    const response = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        role: 'viewer',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-556: POST returns 400 for invalid role', async () => {
    const response = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        email: 'test@example.com',
        role: 'superadmin',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-557: POST returns 400 for invalid team ID', async () => {
    const response = await outerApp.request(
      jsonRequest('http://localhost/api/teams/inv@lid!/invitations', {
        email: 'test@example.com',
        role: 'viewer',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  // ─── GET /api/teams/:id/invitations ─────────────────

  it('IT-558: GET lists pending invitations', async () => {
    // Create two invitations
    await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        email: 'user1@example.com',
        role: 'viewer',
      })
    );
    await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        email: 'user2@example.com',
        role: 'admin',
      })
    );

    const response = await outerApp.request(`http://localhost/api/teams/${teamId}/invitations`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.items.length).toBe(2);
    expect(body.data.items[0].invitedBy).toBeDefined();
    expect(body.data.items[0].invitedBy.userId).toBe(userId);
  });

  it('IT-559: GET returns empty list when no invitations exist', async () => {
    const response = await outerApp.request(`http://localhost/api/teams/${teamId}/invitations`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.items.length).toBe(0);
  });

  // ─── POST /api/teams/:id/invitations/:iid/decline ──

  it('IT-560: POST /decline declines a pending invitation', async () => {
    // Create an invitation
    const createRes = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        email: 'decline-me@example.com',
        role: 'viewer',
      })
    );
    const invitationId = (await createRes.json()).data.id;

    const response = await outerApp.request(
      `http://localhost/api/teams/${teamId}/invitations/${invitationId}/decline`,
      { method: 'POST' }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.declined).toBe(true);

    // Verify status changed in DB
    const inv = await db.select().from(teamInvitations).where(eq(teamInvitations.id, invitationId));
    expect(inv[0]?.status).toBe('declined');
  });

  it('IT-561: POST /decline returns 404 for non-existent invitation', async () => {
    const response = await outerApp.request(
      `http://localhost/api/teams/${teamId}/invitations/nonexistent-inv/decline`,
      { method: 'POST' }
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('IT-562: POST /decline returns 404 for already processed invitation', async () => {
    // Create and then revoke an invitation
    const createRes = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        email: 'already-revoked@example.com',
        role: 'viewer',
      })
    );
    const invitationId = (await createRes.json()).data.id;

    // Revoke it
    await outerApp.request(`http://localhost/api/teams/${teamId}/invitations/${invitationId}`, {
      method: 'DELETE',
    });

    // Try to decline the now-revoked invitation
    const response = await outerApp.request(
      `http://localhost/api/teams/${teamId}/invitations/${invitationId}/decline`,
      { method: 'POST' }
    );

    expect(response.status).toBe(404);
  });

  // ─── DELETE /api/teams/:id/invitations/:iid ─────────

  it('IT-563: DELETE revokes a pending invitation', async () => {
    // Create an invitation
    const createRes = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        email: 'revoke-me@example.com',
        role: 'viewer',
      })
    );
    const invitationId = (await createRes.json()).data.id;

    const response = await outerApp.request(
      `http://localhost/api/teams/${teamId}/invitations/${invitationId}`,
      { method: 'DELETE' }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.revoked).toBe(true);

    // Verify status changed in DB
    const inv = await db.select().from(teamInvitations).where(eq(teamInvitations.id, invitationId));
    expect(inv[0]?.status).toBe('revoked');
  });

  it('IT-564: DELETE returns 404 for non-existent invitation', async () => {
    const response = await outerApp.request(
      `http://localhost/api/teams/${teamId}/invitations/nonexistent-del`,
      { method: 'DELETE' }
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('IT-565: DELETE returns 404 for already-revoked invitation', async () => {
    // Create and revoke
    const createRes = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        email: 'double-revoke@example.com',
        role: 'viewer',
      })
    );
    const invitationId = (await createRes.json()).data.id;

    await outerApp.request(`http://localhost/api/teams/${teamId}/invitations/${invitationId}`, {
      method: 'DELETE',
    });

    // Try to revoke again
    const response = await outerApp.request(
      `http://localhost/api/teams/${teamId}/invitations/${invitationId}`,
      { method: 'DELETE' }
    );

    expect(response.status).toBe(404);
  });

  // ─── RBAC enforcement ──────────────────────────────

  it('IT-566: POST returns 403 for non-admin team member', async () => {
    const viewerId = createId();
    await db.insert(users).values({
      id: viewerId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `viewer-inv-${viewerId.slice(0, 6)}`,
      name: 'Viewer',
    });
    await db.insert(teamMembers).values({ teamId, userId: viewerId, role: 'viewer' });

    const routes = createTeamInvitationsRoutes({ db: wrappedDb as any, rbacService });
    const viewerApp = new Hono<{ Variables: { auth: AuthContext } }>();
    viewerApp.use('*', async (c, next) => {
      c.set('auth', { userId: viewerId, authMethod: 'session' });
      await next();
    });
    viewerApp.route('/api/teams/:id/invitations', routes);

    const response = await viewerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        email: 'test@example.com',
        role: 'viewer',
      })
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('IT-567: GET returns 403 for non-admin listing invitations', async () => {
    const viewerId = createId();
    await db.insert(users).values({
      id: viewerId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `viewer-list-${viewerId.slice(0, 6)}`,
      name: 'Viewer',
    });
    await db.insert(teamMembers).values({ teamId, userId: viewerId, role: 'viewer' });

    const routes = createTeamInvitationsRoutes({ db: wrappedDb as any, rbacService });
    const viewerApp = new Hono<{ Variables: { auth: AuthContext } }>();
    viewerApp.use('*', async (c, next) => {
      c.set('auth', { userId: viewerId, authMethod: 'session' });
      await next();
    });
    viewerApp.route('/api/teams/:id/invitations', routes);

    const response = await viewerApp.request(`http://localhost/api/teams/${teamId}/invitations`);

    expect(response.status).toBe(403);
  });

  // ─── Round-trip test ────────────────────────────────

  it('IT-568: Full lifecycle: create, list, revoke, verify not listed', async () => {
    // Create
    const createRes = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/invitations`, {
        email: 'lifecycle@example.com',
        role: 'agent_operator',
      })
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()).data;

    // List — should include it
    const listRes = await outerApp.request(`http://localhost/api/teams/${teamId}/invitations`);
    const listed = (await listRes.json()).data;
    expect(listed.items.some((i: any) => i.id === created.id)).toBe(true);

    // Revoke
    const revokeRes = await outerApp.request(
      `http://localhost/api/teams/${teamId}/invitations/${created.id}`,
      { method: 'DELETE' }
    );
    expect(revokeRes.status).toBe(200);

    // List again — should not include revoked invitation
    const listRes2 = await outerApp.request(`http://localhost/api/teams/${teamId}/invitations`);
    const listed2 = (await listRes2.json()).data;
    expect(listed2.items.some((i: any) => i.id === created.id)).toBe(false);
  });
});
