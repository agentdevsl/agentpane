import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { teamMembers, teams, users } from '../../src/db/schema';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { createTeamMembersRoutes } from '../../src/server/routes/team-members';
import { RbacService } from '../../src/services/rbac.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for team-members API routes.
 *
 * The routes are mounted under /api/teams/:id/members, so the :id param
 * is read from the parent route. We simulate this by mounting the sub-routes
 * under /:id/members on the outer app.
 *
 * NOTE: POST / uses db.transaction() which is incompatible with the test DB's
 * async transaction monkey-patch (double-invocation race). POST validation
 * tests use invalid input that fails BEFORE the transaction. Member creation
 * for GET/PATCH/DELETE tests uses direct DB inserts.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

describe('Team Members Routes (IT-480)', () => {
  let outerApp: Hono;
  let db: ReturnType<typeof getTestDb>;
  let rbacService: RbacService;
  let ownerUserId: string;
  let memberUserId: string;
  let targetUserId: string;
  let teamId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    rbacService = new RbacService(db);

    // Create owner user
    ownerUserId = createId();
    await db.insert(users).values({
      id: ownerUserId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `owner-${ownerUserId.slice(0, 6)}`,
      name: 'Owner User',
    });

    // Create member user (to be added)
    memberUserId = createId();
    await db.insert(users).values({
      id: memberUserId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `member-${memberUserId.slice(0, 6)}`,
      name: 'Member User',
      email: 'member@test.com',
    });

    // Create target user (for additional operations)
    targetUserId = createId();
    await db.insert(users).values({
      id: targetUserId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `target-${targetUserId.slice(0, 6)}`,
      name: 'Target User',
    });

    // Create team
    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Test Team',
      slug: `team-${teamId.slice(0, 8)}`,
    });

    // Add owner user as team owner
    await db.insert(teamMembers).values({
      teamId,
      userId: ownerUserId,
      role: 'owner',
    });

    // Create the routes with auth context injected (as dev / owner)
    const memberRoutes = createTeamMembersRoutes({ db: db as any, rbacService });

    outerApp = new Hono();
    outerApp.use('/*', async (c, next) => {
      const auth: AuthContext = {
        userId: ownerUserId,
        authMethod: 'dev',
      };
      c.set('auth', auth);
      await next();
    });
    outerApp.route('/:id/members', memberRoutes);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── POST validation (tests that fail before db.transaction) ────

  it('IT-484: POST / returns 400 for missing required fields', async () => {
    const response = await outerApp.request(jsonRequest(`http://localhost/${teamId}/members`, {}));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-485: POST / returns 400 for invalid team ID', async () => {
    const response = await outerApp.request(
      jsonRequest('http://localhost/ab!invalid/members', {
        userId: memberUserId,
        role: 'viewer',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('IT-484b: POST / returns 400 for invalid role value', async () => {
    const response = await outerApp.request(
      jsonRequest(`http://localhost/${teamId}/members`, {
        userId: memberUserId,
        role: 'superadmin',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  // ─── GET /api/teams/:id/members ─────────────────────

  it('IT-486: GET / lists team members with user details and pagination', async () => {
    // Owner is already a member; add another via direct insert
    await db.insert(teamMembers).values({ teamId, userId: memberUserId, role: 'viewer' });

    const response = await outerApp.request(`http://localhost/${teamId}/members`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(2); // owner + member
    expect(body.data.totalCount).toBe(2);
    expect(body.data.hasMore).toBe(false);

    // Verify user details are joined
    const memberEntry = body.data.items.find((m: any) => m.userId === memberUserId);
    expect(memberEntry).toBeDefined();
    expect(memberEntry.name).toBe('Member User');
    expect(memberEntry.email).toBe('member@test.com');
  });

  it('IT-487: GET / supports role filter', async () => {
    await db.insert(teamMembers).values({ teamId, userId: memberUserId, role: 'viewer' });
    await db.insert(teamMembers).values({ teamId, userId: targetUserId, role: 'admin' });

    const response = await outerApp.request(`http://localhost/${teamId}/members?role=viewer`);
    const body = await response.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].role).toBe('viewer');
    expect(body.data.totalCount).toBe(1);
  });

  it('IT-488: GET / returns 400 for invalid role filter', async () => {
    const response = await outerApp.request(`http://localhost/${teamId}/members?role=superadmin`);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('IT-489: GET / supports limit pagination', async () => {
    await db.insert(teamMembers).values({ teamId, userId: memberUserId, role: 'viewer' });
    await db.insert(teamMembers).values({ teamId, userId: targetUserId, role: 'admin' });

    const response = await outerApp.request(`http://localhost/${teamId}/members?limit=1`);
    const body = await response.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.hasMore).toBe(true);
    expect(body.data.totalCount).toBe(3); // owner + 2 added
  });

  it('IT-489b: GET / returns empty list for nonexistent team', async () => {
    const response = await outerApp.request('http://localhost/nonexistent-team-id/members');
    expect(response.status).toBe(200);
    const body = await response.json();
    // dev mode bypasses team membership check, returns empty list
    expect(body.data.items).toHaveLength(0);
    expect(body.data.totalCount).toBe(0);
  });

  // ─── PATCH /api/teams/:id/members/:uid ──────────────

  it('IT-490: PATCH /:uid updates member role', async () => {
    await db.insert(teamMembers).values({ teamId, userId: memberUserId, role: 'viewer' });

    const response = await outerApp.request(
      jsonRequest(
        `http://localhost/${teamId}/members/${memberUserId}`,
        { role: 'agent_operator' },
        { method: 'PATCH' }
      )
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.role).toBe('agent_operator');
  });

  it('IT-491: PATCH /:uid returns 404 for nonexistent member', async () => {
    const response = await outerApp.request(
      jsonRequest(
        `http://localhost/${teamId}/members/nonexistent-uid-xyz`,
        { role: 'viewer' },
        { method: 'PATCH' }
      )
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MEMBER_NOT_FOUND');
  });

  it('IT-492: PATCH /:uid cannot demote the last owner', async () => {
    // ownerUserId is the only owner
    const response = await outerApp.request(
      jsonRequest(
        `http://localhost/${teamId}/members/${ownerUserId}`,
        { role: 'admin' },
        { method: 'PATCH' }
      )
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('CANNOT_DEMOTE_LAST_OWNER');
  });

  it('IT-493: PATCH /:uid returns 400 for missing role', async () => {
    await db.insert(teamMembers).values({ teamId, userId: memberUserId, role: 'viewer' });

    const response = await outerApp.request(
      jsonRequest(`http://localhost/${teamId}/members/${memberUserId}`, {}, { method: 'PATCH' })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  // ─── DELETE /api/teams/:id/members/:uid ─────────────

  it('IT-494: DELETE /:uid removes a member', async () => {
    await db.insert(teamMembers).values({ teamId, userId: memberUserId, role: 'viewer' });

    const response = await outerApp.request(`http://localhost/${teamId}/members/${memberUserId}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.removed).toBe(true);

    // Verify member is actually deleted from DB
    const remaining = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, memberUserId)));
    expect(remaining).toHaveLength(0);
  });

  it('IT-495: DELETE /:uid returns 404 for nonexistent member', async () => {
    const response = await outerApp.request(
      `http://localhost/${teamId}/members/nonexistent-uid-del`,
      { method: 'DELETE' }
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MEMBER_NOT_FOUND');
  });

  it('IT-496: DELETE /:uid cannot remove the last owner', async () => {
    // ownerUserId is the only owner
    const response = await outerApp.request(`http://localhost/${teamId}/members/${ownerUserId}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('CANNOT_REMOVE_LAST_OWNER');
  });

  // ─── Full lifecycle ─────────────────────────────────

  it('IT-497: Lifecycle: insert member, list, update role, remove, verify gone', async () => {
    // Insert member directly (bypassing transaction-based POST)
    await db.insert(teamMembers).values({ teamId, userId: memberUserId, role: 'viewer' });

    // List
    const listRes = await outerApp.request(`http://localhost/${teamId}/members`);
    const listBody = await listRes.json();
    expect(listBody.data.items).toHaveLength(2); // owner + new member
    const added = listBody.data.items.find((m: any) => m.userId === memberUserId);
    expect(added).toBeDefined();
    expect(added.role).toBe('viewer');

    // Update
    const updateRes = await outerApp.request(
      jsonRequest(
        `http://localhost/${teamId}/members/${memberUserId}`,
        { role: 'admin' },
        { method: 'PATCH' }
      )
    );
    expect(updateRes.status).toBe(200);
    const updateBody = await updateRes.json();
    expect(updateBody.data.role).toBe('admin');

    // Verify update via list
    const verifyRes = await outerApp.request(`http://localhost/${teamId}/members`);
    const verifyBody = await verifyRes.json();
    const updated = verifyBody.data.items.find((m: any) => m.userId === memberUserId);
    expect(updated.role).toBe('admin');

    // Remove
    const removeRes = await outerApp.request(`http://localhost/${teamId}/members/${memberUserId}`, {
      method: 'DELETE',
    });
    expect(removeRes.status).toBe(200);

    // Verify removed
    const finalRes = await outerApp.request(`http://localhost/${teamId}/members`);
    const finalBody = await finalRes.json();
    expect(finalBody.data.items).toHaveLength(1); // only owner remains
  });

  // ─── Session-mode RBAC paths (require non-dev auth) ────

  function buildSessionApp(asUserId: string): Hono {
    const memberRoutes = createTeamMembersRoutes({ db: db as never, rbacService });
    const sessionApp = new Hono();
    sessionApp.use('/*', async (c, next) => {
      c.set('auth', { userId: asUserId, authMethod: 'session' } as never);
      await next();
    });
    sessionApp.route('/:id/members', memberRoutes);
    return sessionApp;
  }

  it('IT-498: PATCH /:uid blocks user from changing own role', async () => {
    // Add the user as admin first via direct insert
    await db.insert(teamMembers).values({ teamId, userId: memberUserId, role: 'admin' });
    const sessionApp = buildSessionApp(memberUserId);
    const res = await sessionApp.request(
      jsonRequest(
        `http://localhost/${teamId}/members/${memberUserId}`,
        { role: 'viewer' },
        { method: 'PATCH' }
      )
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('CANNOT_CHANGE_OWN_ROLE');
  });

  it('IT-499: PATCH /:uid blocks admin from assigning admin role (only owners can)', async () => {
    // Make memberUserId an admin
    await db.insert(teamMembers).values({ teamId, userId: memberUserId, role: 'admin' });
    // Add a target as viewer
    await db.insert(teamMembers).values({ teamId, userId: targetUserId, role: 'viewer' });
    const sessionApp = buildSessionApp(memberUserId);
    const res = await sessionApp.request(
      jsonRequest(
        `http://localhost/${teamId}/members/${targetUserId}`,
        { role: 'admin' },
        { method: 'PATCH' }
      )
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('IT-500: DELETE /:uid blocks user from removing themselves', async () => {
    await db.insert(teamMembers).values({ teamId, userId: memberUserId, role: 'admin' });
    const sessionApp = buildSessionApp(memberUserId);
    const res = await sessionApp.request(`http://localhost/${teamId}/members/${memberUserId}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('CANNOT_REMOVE_SELF');
  });

  it('IT-501: DELETE /:uid blocks admin from removing an owner', async () => {
    // memberUserId is admin, ownerUserId is owner
    await db.insert(teamMembers).values({ teamId, userId: memberUserId, role: 'admin' });
    const sessionApp = buildSessionApp(memberUserId);
    const res = await sessionApp.request(`http://localhost/${teamId}/members/${ownerUserId}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('IT-502: DELETE /:uid blocks removing the last owner', async () => {
    // Add another owner so the auth check passes, then leave just one owner
    // Actually owner is calling, ownerUserId is the only owner - try to remove
    // a different user that is also owner. Setup another owner user, then
    // remove it as the original owner: should succeed. Then remove ourselves
    // should fail "remove self". But "last owner" requires removing owner
    // when only one owner — already tested via the insert below.
    // Add a second owner
    await db.insert(teamMembers).values({ teamId, userId: memberUserId, role: 'owner' });
    // Remove memberUserId (one of two owners): should succeed
    const removeOk = await outerApp.request(`http://localhost/${teamId}/members/${memberUserId}`, {
      method: 'DELETE',
    });
    expect(removeOk.status).toBe(200);

    // Now ownerUserId is the only owner left; try to remove ownerUserId via
    // session as a (non-existent) admin — but caller must be admin, so use
    // dev-mode bypass via outerApp. The route in dev mode skips the
    // remove-self check but still runs CANNOT_REMOVE_LAST_OWNER inside the
    // transaction.
    const res = await outerApp.request(`http://localhost/${teamId}/members/${ownerUserId}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CANNOT_REMOVE_LAST_OWNER');
  });
});
