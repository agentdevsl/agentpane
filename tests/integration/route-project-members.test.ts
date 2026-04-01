import { createId } from '@paralleldrive/cuid2';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codespaceMembers, users } from '../../src/db/schema';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { createProjectMembersRoutes } from '../../src/server/routes/project-members';
import { RbacService } from '../../src/services/rbac.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for project-members (codespace members) API routes.
 *
 * The routes are mounted under /api/codespaces/:id/members, so the :id param
 * is read from the parent route. We simulate this by mounting the sub-routes
 * under /:id/members on the outer app.
 *
 * NOTE: POST / uses db.transaction() which is incompatible with the test DB's
 * async transaction monkey-patch (double-invocation race). POST validation
 * tests use invalid input that fails BEFORE the transaction. Member creation
 * for GET/PATCH/DELETE tests uses direct DB inserts instead.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

describe('Project Members Routes (IT-460)', () => {
  let outerApp: Hono;
  let db: ReturnType<typeof getTestDb>;
  let rbacService: RbacService;
  let adminUserId: string;
  let memberUserId: string;
  let codespaceId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    rbacService = new RbacService(db);

    // Create admin user
    adminUserId = createId();
    await db.insert(users).values({
      id: adminUserId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `admin-${adminUserId.slice(0, 6)}`,
      name: 'Admin User',
    });

    // Create member user
    memberUserId = createId();
    await db.insert(users).values({
      id: memberUserId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `member-${memberUserId.slice(0, 6)}`,
      name: 'Member User',
      email: 'member@example.com',
    });

    // Create a codespace
    const codespace = await createTestProject({ name: 'Members Test CS' });
    codespaceId = codespace.id;

    // Create the routes with auth context injected via middleware
    const memberRoutes = createProjectMembersRoutes({ db: db as any, rbacService });

    outerApp = new Hono();
    outerApp.use('/*', async (c, next) => {
      const auth: AuthContext = {
        userId: adminUserId,
        authMethod: 'dev',
      };
      c.set('auth', auth);
      await next();
    });
    // Mount under /:id/members to simulate parent route param binding
    outerApp.route('/:id/members', memberRoutes);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── POST validation (tests that fail before db.transaction) ────

  it('IT-464: POST / returns 400 for missing required fields', async () => {
    const response = await outerApp.request(
      jsonRequest(`http://localhost/${codespaceId}/members`, {
        // missing userId and role
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-465: POST / returns 400 for invalid codespace ID', async () => {
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

  it('IT-464b: POST / returns 400 for invalid role value', async () => {
    const response = await outerApp.request(
      jsonRequest(`http://localhost/${codespaceId}/members`, {
        userId: memberUserId,
        role: 'superadmin',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  // ─── GET /api/codespaces/:id/members ────────────────

  it('IT-466: GET / lists codespace members with user details', async () => {
    // Add a member via direct DB insert
    await db.insert(codespaceMembers).values({
      codespaceId,
      userId: memberUserId,
      role: 'viewer',
    });

    const response = await outerApp.request(`http://localhost/${codespaceId}/members`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].userId).toBe(memberUserId);
    expect(body.data.items[0].name).toBe('Member User');
    expect(body.data.items[0].email).toBe('member@example.com');
    expect(body.data.items[0].projectRole).toBe('viewer');
    expect(body.data.items[0].source).toBe('direct');
  });

  it('IT-467: GET / returns empty list when no members exist', async () => {
    const response = await outerApp.request(`http://localhost/${codespaceId}/members`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(0);
  });

  it('IT-466b: GET / enriches with effectiveRole', async () => {
    await db.insert(codespaceMembers).values({
      codespaceId,
      userId: memberUserId,
      role: 'admin',
    });

    const response = await outerApp.request(`http://localhost/${codespaceId}/members`);
    const body = await response.json();
    expect(body.data.items[0].effectiveRole).toBeDefined();
    // Direct member role is the effective role when no team overrides exist
    expect(body.data.items[0].effectiveRole).toBe('admin');
  });

  // ─── PATCH /api/codespaces/:id/members/:uid ─────────

  it('IT-468: PATCH /:uid updates member role', async () => {
    await db.insert(codespaceMembers).values({
      codespaceId,
      userId: memberUserId,
      role: 'viewer',
    });

    const response = await outerApp.request(
      jsonRequest(
        `http://localhost/${codespaceId}/members/${memberUserId}`,
        { role: 'admin' },
        { method: 'PATCH' }
      )
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.role).toBe('admin');
  });

  it('IT-469: PATCH /:uid returns 404 for nonexistent member', async () => {
    const response = await outerApp.request(
      jsonRequest(
        `http://localhost/${codespaceId}/members/nonexistent-uid-xyz`,
        { role: 'admin' },
        { method: 'PATCH' }
      )
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('PROJECT_MEMBER_NOT_FOUND');
  });

  it('IT-470: PATCH /:uid returns 400 for missing role', async () => {
    await db.insert(codespaceMembers).values({
      codespaceId,
      userId: memberUserId,
      role: 'viewer',
    });

    const response = await outerApp.request(
      jsonRequest(
        `http://localhost/${codespaceId}/members/${memberUserId}`,
        {},
        { method: 'PATCH' }
      )
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-470b: PATCH /:uid returns 400 for invalid uid', async () => {
    const response = await outerApp.request(
      jsonRequest(
        `http://localhost/${codespaceId}/members/ab!bad`,
        { role: 'admin' },
        { method: 'PATCH' }
      )
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_ID');
  });

  // ─── DELETE /api/codespaces/:id/members/:uid ────────

  it('IT-471: DELETE /:uid removes a member and returns revertedToTeamRole', async () => {
    await db.insert(codespaceMembers).values({
      codespaceId,
      userId: memberUserId,
      role: 'viewer',
    });

    const response = await outerApp.request(
      `http://localhost/${codespaceId}/members/${memberUserId}`,
      { method: 'DELETE' }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.removed).toBe(true);
    // revertedToTeamRole is null when user has no team-based role
    expect(body.data).toHaveProperty('revertedToTeamRole');
  });

  it('IT-472: DELETE /:uid returns 404 for nonexistent member', async () => {
    const response = await outerApp.request(
      `http://localhost/${codespaceId}/members/nonexistent-uid-del`,
      { method: 'DELETE' }
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('PROJECT_MEMBER_NOT_FOUND');
  });

  it('IT-473: Lifecycle: insert member, list, update role, remove, verify gone', async () => {
    // Insert member directly (bypassing transaction-based POST)
    await db.insert(codespaceMembers).values({
      codespaceId,
      userId: memberUserId,
      role: 'viewer',
    });

    // List
    const listRes = await outerApp.request(`http://localhost/${codespaceId}/members`);
    const listBody = await listRes.json();
    expect(listBody.ok).toBe(true);
    expect(listBody.data.items).toHaveLength(1);
    expect(listBody.data.items[0].projectRole).toBe('viewer');

    // Update
    const updateRes = await outerApp.request(
      jsonRequest(
        `http://localhost/${codespaceId}/members/${memberUserId}`,
        { role: 'agent_operator' },
        { method: 'PATCH' }
      )
    );
    expect(updateRes.status).toBe(200);
    const updateBody = await updateRes.json();
    expect(updateBody.data.role).toBe('agent_operator');

    // Verify update via list
    const verifyRes = await outerApp.request(`http://localhost/${codespaceId}/members`);
    const verifyBody = await verifyRes.json();
    expect(verifyBody.data.items[0].projectRole).toBe('agent_operator');

    // Remove
    const removeRes = await outerApp.request(
      `http://localhost/${codespaceId}/members/${memberUserId}`,
      { method: 'DELETE' }
    );
    expect(removeRes.status).toBe(200);

    // Verify removed
    const finalRes = await outerApp.request(`http://localhost/${codespaceId}/members`);
    const finalBody = await finalRes.json();
    expect(finalBody.data.items).toHaveLength(0);
  });
});
