import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiTokens,
  codespaceMembers,
  codespaces,
  githubTokens,
  projectFolders,
  tags,
  teamInvitations,
  teamMembers,
  teamProjectFolders,
  teams,
  users,
} from '../../src/db/schema';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { createTeamsRoutes } from '../../src/server/routes/teams';
import { RbacService } from '../../src/services/rbac.service';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for team CRUD routes.
 *
 * Tests team creation, listing, update, delete, slug uniqueness,
 * ownership transfer, RBAC, and cascade delete.
 *
 * NOTE: POST / and PATCH /:id use db.transaction() which is incompatible
 * with the test DB's async transaction monkey-patch. We use
 * wrapDbForSingleCallTransaction to avoid double-invocation.
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
 * The setup.ts monkey-patch can invoke the callback twice under certain conditions.
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

function createApp(
  db: ReturnType<typeof getTestDb>,
  rbacService: RbacService,
  authUserId: string,
  authMethod: 'dev' | 'session' = 'dev'
) {
  const routes = createTeamsRoutes({ db: db as any, rbacService });
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use('*', async (c, next) => {
    c.set('auth', { userId: authUserId, authMethod });
    await next();
  });
  app.route('/api/teams', routes);
  return app;
}

describe('Team Routes (IT-1100)', () => {
  let db: ReturnType<typeof getTestDb>;
  let wrappedDb: ReturnType<typeof getTestDb>;
  let rbacService: RbacService;
  let ownerUserId: string;
  let memberUserId: string;
  let teamId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    wrappedDb = wrapDbForSingleCallTransaction(db);
    rbacService = new RbacService(db as any);

    // Create owner user
    ownerUserId = createId();
    await db.insert(users).values({
      id: ownerUserId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `owner-${ownerUserId.slice(0, 6)}`,
      name: 'Owner User',
    });

    // Create member user
    memberUserId = createId();
    await db.insert(users).values({
      id: memberUserId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `member-${memberUserId.slice(0, 6)}`,
      name: 'Member User',
    });

    // Create team
    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Test Team',
      slug: `test-team-${teamId.slice(0, 8)}`,
    });

    // Add owner
    await db.insert(teamMembers).values({
      teamId,
      userId: ownerUserId,
      role: 'owner',
    });

    // Add member as admin
    await db.insert(teamMembers).values({
      teamId,
      userId: memberUserId,
      role: 'admin',
    });
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // =========================================================================
  // POST /api/teams - Create team
  // =========================================================================

  describe('POST /api/teams', () => {
    it('IT-1101: creates a team with auto-generated slug', async () => {
      const app = createApp(wrappedDb, rbacService, ownerUserId);
      const response = await app.request(
        jsonRequest('http://localhost/api/teams', {
          name: 'My New Team',
        })
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.name).toBe('My New Team');
      expect(body.data.slug).toBe('my-new-team');
      expect(body.data.membership.role).toBe('owner');
    });

    it('IT-1102: creates a team with explicit slug', async () => {
      const app = createApp(wrappedDb, rbacService, ownerUserId);
      const response = await app.request(
        jsonRequest('http://localhost/api/teams', {
          name: 'Team With Slug',
          slug: 'custom-slug',
          description: 'A test description',
        })
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.slug).toBe('custom-slug');
      expect(body.data.description).toBe('A test description');
    });

    it('IT-1103: returns 409 for duplicate slug', async () => {
      const existingSlug = `test-team-${teamId.slice(0, 8)}`;
      const app = createApp(wrappedDb, rbacService, ownerUserId);
      const response = await app.request(
        jsonRequest('http://localhost/api/teams', {
          name: 'Duplicate Slug Team',
          slug: existingSlug,
        })
      );

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('TEAM_SLUG_EXISTS');
    });

    it('IT-1104: returns 400 for missing name', async () => {
      const app = createApp(wrappedDb, rbacService, ownerUserId);
      const response = await app.request(jsonRequest('http://localhost/api/teams', {}));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.ok).toBe(false);
    });

    it('IT-1105: returns 400 for invalid slug format', async () => {
      const app = createApp(wrappedDb, rbacService, ownerUserId);
      const response = await app.request(
        jsonRequest('http://localhost/api/teams', {
          name: 'Bad Slug Team',
          slug: 'INVALID_SLUG!',
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.ok).toBe(false);
    });
  });

  // =========================================================================
  // GET /api/teams - List teams
  // =========================================================================

  describe('GET /api/teams', () => {
    it('IT-1106: lists teams for dev auth (all teams)', async () => {
      const app = createApp(db, rbacService, ownerUserId, 'dev');
      const response = await app.request('http://localhost/api/teams');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.items.length).toBeGreaterThanOrEqual(1);
      expect(body.data.items[0].memberCount).toBeGreaterThanOrEqual(1);
    });

    it('IT-1107: lists teams for session auth (only user teams)', async () => {
      const app = createApp(db, rbacService, ownerUserId, 'session');
      const response = await app.request('http://localhost/api/teams');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.items.length).toBe(1);
      expect(body.data.items[0].id).toBe(teamId);
      expect(body.data.items[0].myRole).toBe('owner');
    });

    it('IT-1108: returns empty list for user with no teams', async () => {
      const loneUserId = createId();
      await db.insert(users).values({
        id: loneUserId,
        githubId: Math.floor(Math.random() * 1000000000),
        githubLogin: `lone-${loneUserId.slice(0, 6)}`,
        name: 'Lone User',
      });

      const app = createApp(db, rbacService, loneUserId, 'session');
      const response = await app.request('http://localhost/api/teams');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.items).toEqual([]);
      expect(body.data.totalCount).toBe(0);
    });

    it('IT-1109: supports search filter', async () => {
      const app = createApp(db, rbacService, ownerUserId, 'dev');
      const response = await app.request('http://localhost/api/teams?search=Test');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.items.length).toBeGreaterThanOrEqual(1);
    });

    it('IT-1110: supports cursor pagination', async () => {
      const app = createApp(db, rbacService, ownerUserId, 'dev');
      // Request with limit=1
      const response = await app.request('http://localhost/api/teams?limit=1');

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.items.length).toBeLessThanOrEqual(1);
    });
  });

  // =========================================================================
  // GET /api/teams/:id - Get team details
  // =========================================================================

  describe('GET /api/teams/:id', () => {
    it('IT-1111: returns team details with counts', async () => {
      const app = createApp(db, rbacService, ownerUserId);
      const response = await app.request(`http://localhost/api/teams/${teamId}`);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.id).toBe(teamId);
      expect(body.data.name).toBe('Test Team');
      expect(body.data.memberCount).toBe(2);
      expect(body.data.folderCount).toBe(0);
    });

    it('IT-1112: returns 404 for non-existent team', async () => {
      const app = createApp(db, rbacService, ownerUserId);
      const response = await app.request(`http://localhost/api/teams/${createId()}`);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('IT-1113: returns 400 for invalid ID format', async () => {
      const app = createApp(db, rbacService, ownerUserId);
      const response = await app.request('http://localhost/api/teams/abc!invalid');

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INVALID_ID');
    });

    it('IT-1114: RBAC - viewer denied for non-member (session auth)', async () => {
      const outsiderUserId = createId();
      await db.insert(users).values({
        id: outsiderUserId,
        githubId: Math.floor(Math.random() * 1000000000),
        githubLogin: `outsider-${outsiderUserId.slice(0, 6)}`,
        name: 'Outsider',
      });

      const app = createApp(db, rbacService, outsiderUserId, 'session');
      const response = await app.request(`http://localhost/api/teams/${teamId}`);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INSUFFICIENT_ROLE');
    });
  });

  // =========================================================================
  // PATCH /api/teams/:id - Update team
  // =========================================================================

  describe('PATCH /api/teams/:id', () => {
    it('IT-1115: updates team name', async () => {
      const app = createApp(wrappedDb, rbacService, ownerUserId);
      const response = await app.request(
        jsonRequest(
          `http://localhost/api/teams/${teamId}`,
          { name: 'Updated Name' },
          { method: 'PATCH' }
        )
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.name).toBe('Updated Name');
    });

    it('IT-1116: returns 409 for duplicate slug on update', async () => {
      // Create another team
      const otherTeamId = createId();
      await db.insert(teams).values({
        id: otherTeamId,
        name: 'Other Team',
        slug: 'other-team-slug',
      });

      const app = createApp(wrappedDb, rbacService, ownerUserId);
      const response = await app.request(
        jsonRequest(
          `http://localhost/api/teams/${teamId}`,
          { slug: 'other-team-slug' },
          { method: 'PATCH' }
        )
      );

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('TEAM_SLUG_EXISTS');
    });

    it('IT-1117: RBAC - viewer cannot update (session auth)', async () => {
      // Add a viewer
      const viewerUserId = createId();
      await db.insert(users).values({
        id: viewerUserId,
        githubId: Math.floor(Math.random() * 1000000000),
        githubLogin: `viewer-${viewerUserId.slice(0, 6)}`,
        name: 'Viewer',
      });
      await db.insert(teamMembers).values({
        teamId,
        userId: viewerUserId,
        role: 'viewer',
      });

      const app = createApp(wrappedDb, rbacService, viewerUserId, 'session');
      const response = await app.request(
        jsonRequest(`http://localhost/api/teams/${teamId}`, { name: 'Hacked' }, { method: 'PATCH' })
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INSUFFICIENT_ROLE');
    });
  });

  // =========================================================================
  // POST /api/teams/:id/transfer-ownership
  // =========================================================================

  describe('POST /api/teams/:id/transfer-ownership', () => {
    it('IT-1118: transfers ownership atomically', async () => {
      const app = createApp(wrappedDb, rbacService, ownerUserId);
      const response = await app.request(
        jsonRequest(`http://localhost/api/teams/${teamId}/transfer-ownership`, {
          targetUserId: memberUserId,
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.newOwnerId).toBe(memberUserId);
      expect(body.data.previousOwnerId).toBe(ownerUserId);

      // Verify roles were swapped in the DB
      const newOwner = await db.query.teamMembers.findFirst({
        where: eq(teamMembers.userId, memberUserId),
      });
      expect(newOwner?.role).toBe('owner');

      const oldOwner = await db.query.teamMembers.findFirst({
        where: eq(teamMembers.userId, ownerUserId),
      });
      expect(oldOwner?.role).toBe('admin');
    });

    it('IT-1119: self-transfer returns 400', async () => {
      const app = createApp(wrappedDb, rbacService, ownerUserId);
      const response = await app.request(
        jsonRequest(`http://localhost/api/teams/${teamId}/transfer-ownership`, {
          targetUserId: ownerUserId,
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('CANNOT_TRANSFER_TO_SELF');
    });

    it('IT-1120: transfer to non-member returns 404', async () => {
      const nonMemberId = createId();
      await db.insert(users).values({
        id: nonMemberId,
        githubId: Math.floor(Math.random() * 1000000000),
        githubLogin: `nonmember-${nonMemberId.slice(0, 6)}`,
        name: 'Non-member',
      });

      const app = createApp(wrappedDb, rbacService, ownerUserId);
      const response = await app.request(
        jsonRequest(`http://localhost/api/teams/${teamId}/transfer-ownership`, {
          targetUserId: nonMemberId,
        })
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('MEMBER_NOT_FOUND');
    });

    it('IT-1121: RBAC - non-owner cannot transfer (session auth)', async () => {
      const app = createApp(wrappedDb, rbacService, memberUserId, 'session');
      const response = await app.request(
        jsonRequest(`http://localhost/api/teams/${teamId}/transfer-ownership`, {
          targetUserId: memberUserId,
        })
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INSUFFICIENT_ROLE');
    });
  });

  // =========================================================================
  // DELETE /api/teams/:id - Cascade delete
  // =========================================================================

  describe('DELETE /api/teams/:id', () => {
    it('IT-1122: deletes team and cascades to all related tables', async () => {
      // Seed related data: invitations, api tokens, github tokens,
      // project folder with tags, codespace members, team project folders, team members
      await db.insert(teamInvitations).values({
        id: createId(),
        teamId,
        email: 'invite@example.com',
        role: 'viewer',
        invitedBy: ownerUserId,
        token: `inv-${createId()}`,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });

      await db.insert(apiTokens).values({
        id: createId(),
        userId: ownerUserId,
        teamId,
        name: 'Test Token',
        tokenHash: `hash-${createId()}`,
        tokenPrefix: 'ap_',
        role: 'viewer',
      });

      await db.insert(githubTokens).values({
        id: createId(),
        teamId,
        encryptedToken: 'encrypted-fake-token-abc123',
        githubLogin: 'test-user',
      });

      // Create a project folder and team association
      const folderId = createId();
      await db.insert(projectFolders).values({
        id: folderId,
        name: 'Team Folder',
        slug: `folder-${folderId.slice(0, 8)}`,
      });

      await db.insert(teamProjectFolders).values({
        teamId,
        projectFolderId: folderId,
      });

      // Migration v43 dropped the legacy team_id column; tags are scoped only
      // to project_folder_id now.
      const tagId = createId();
      execRawSql(
        `INSERT INTO tags (id, project_folder_id, name, color, created_at, updated_at) VALUES ('${tagId}', '${folderId}', 'test-tag', '#6B7280', datetime('now'), datetime('now'))`
      );

      // Create codespace member with grantedByTeamId
      const csId = createId();
      await db.insert(codespaces).values({
        id: csId,
        name: 'Test Codespace',
        path: '/tmp/test',
        projectFolderId: folderId,
      });
      await db.insert(codespaceMembers).values({
        codespaceId: csId,
        userId: memberUserId,
        role: 'viewer',
        grantedByTeamId: teamId,
      });

      // Now delete the team
      const app = createApp(wrappedDb, rbacService, ownerUserId);
      const response = await app.request(
        new Request(`http://localhost/api/teams/${teamId}`, { method: 'DELETE' })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.data.deleted).toBe(true);

      // Verify cascade: all related tables emptied for this team
      const remainingInvitations = await db
        .select()
        .from(teamInvitations)
        .where(eq(teamInvitations.teamId, teamId));
      expect(remainingInvitations).toHaveLength(0);

      const remainingTokens = await db.select().from(apiTokens).where(eq(apiTokens.teamId, teamId));
      expect(remainingTokens).toHaveLength(0);

      const remainingGhTokens = await db
        .select()
        .from(githubTokens)
        .where(eq(githubTokens.teamId, teamId));
      expect(remainingGhTokens).toHaveLength(0);

      const remainingTpf = await db
        .select()
        .from(teamProjectFolders)
        .where(eq(teamProjectFolders.teamId, teamId));
      expect(remainingTpf).toHaveLength(0);

      const remainingTags = await db.select().from(tags).where(eq(tags.projectFolderId, folderId));
      expect(remainingTags).toHaveLength(0);

      const remainingCsMembers = await db
        .select()
        .from(codespaceMembers)
        .where(eq(codespaceMembers.grantedByTeamId, teamId));
      expect(remainingCsMembers).toHaveLength(0);

      const remainingMembers = await db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId));
      expect(remainingMembers).toHaveLength(0);

      const remainingTeam = await db.query.teams.findFirst({
        where: eq(teams.id, teamId),
      });
      expect(remainingTeam).toBeUndefined();
    });

    it('IT-1123: returns 404 for non-existent team', async () => {
      const app = createApp(wrappedDb, rbacService, ownerUserId);
      const response = await app.request(
        new Request(`http://localhost/api/teams/${createId()}`, { method: 'DELETE' })
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.ok).toBe(false);
    });

    it('IT-1124: RBAC - admin cannot delete (session auth)', async () => {
      const app = createApp(wrappedDb, rbacService, memberUserId, 'session');
      const response = await app.request(
        new Request(`http://localhost/api/teams/${teamId}`, { method: 'DELETE' })
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('INSUFFICIENT_ROLE');
    });
  });
});
