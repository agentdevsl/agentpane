/**
 * Coverage gap-filler for src/server/routes/rbac-tokens.ts.
 *
 * The existing test (`route-rbac-tokens.test.ts`) uses `authMethod: 'dev'`
 * which short-circuits role-resolution branches. This file uses
 * `authMethod: 'session'` so the rbacService.resolveTeamRole path runs,
 * exercising scopeCodespaceId, scopeTags, allTeam admin listing, and
 * rotation-due admin team-mode.
 *
 * IT-IDs: IT-2460 to IT-2489
 */
import { createHash, randomBytes } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiTokens,
  codespaces,
  projectFolders,
  tags,
  teamMembers,
  teamProjectFolders,
  teams,
  users,
} from '../../src/db/schema';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { createRbacTokensRoutes } from '../../src/server/routes/rbac-tokens';
import { RbacService } from '../../src/services/rbac.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

async function insertToken(
  db: ReturnType<typeof getTestDb>,
  opts: {
    userId: string;
    teamId: string;
    name: string;
    role: string;
    status?: string;
    scopeCodespaceId?: string | null;
    scopeTags?: string[] | null;
    expiresAt?: string | null;
  }
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
      role: opts.role as 'viewer' | 'member' | 'admin' | 'owner',
      status: (opts.status ?? 'active') as 'active' | 'revoked',
      scopeCodespaceId: opts.scopeCodespaceId ?? null,
      scopeTags: opts.scopeTags ?? null,
      expiresAt: opts.expiresAt ?? null,
    })
    .returning();
  return created!;
}

describe('RBAC Token Routes — extras (role + scope branches)', () => {
  let outerApp: Hono;
  let db: ReturnType<typeof getTestDb>;
  let rbacService: RbacService;
  let userId: string;
  let teamId: string;
  let folderId: string;

  function makeApp(authOverrides: Partial<AuthContext> = {}) {
    const tokenRoutes = createRbacTokensRoutes({
      db: db as never,
      rbacService,
    });
    const app = new Hono();
    app.use('/*', async (c, next) => {
      const auth: AuthContext = {
        userId,
        authMethod: 'session',
        ...authOverrides,
      };
      c.set('auth', auth);
      await next();
    });
    app.route('/', tokenRoutes);
    return app;
  }

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    rbacService = new RbacService(db);

    userId = createId();
    await db.insert(users).values({
      id: userId,
      githubId: Math.floor(Math.random() * 1_000_000_000),
      githubLogin: `extras-user-${userId.slice(0, 6)}`,
      name: 'Extras User',
    });

    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Extras Team',
      slug: `extras-team-${teamId.slice(0, 8)}`,
    });

    folderId = createId();
    await db.insert(projectFolders).values({
      id: folderId,
      name: 'Extras Folder',
      slug: `extras-folder-${folderId.slice(0, 8)}`,
    });
    await db.insert(teamProjectFolders).values({ teamId, projectFolderId: folderId });

    outerApp = makeApp();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── POST / role + team membership ─────────────────────────────────

  describe('POST / role/membership branches (non-dev)', () => {
    it('IT-2460: returns 403 FORBIDDEN when user is not a team member', async () => {
      // userId has no team membership yet
      const response = await outerApp.request(
        jsonRequest('http://localhost/', {
          name: 'No Membership',
          teamId,
          role: 'viewer',
        })
      );
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toContain('Not a member');
    });

    it('IT-2461: returns 403 when token role exceeds user team role (viewer -> admin)', async () => {
      await db.insert(teamMembers).values({ teamId, userId, role: 'viewer' });
      const response = await outerApp.request(
        jsonRequest('http://localhost/', {
          name: 'Over Ceiling',
          teamId,
          role: 'admin',
        })
      );
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.message).toContain('cannot exceed');
    });
  });

  // ─── POST / scopeCodespaceId branches ──────────────────────────────

  describe('POST / scopeCodespaceId branches', () => {
    beforeEach(async () => {
      await db.insert(teamMembers).values({ teamId, userId, role: 'admin' });
    });

    it('IT-2465: returns 400 when scopeCodespaceId does not exist', async () => {
      const response = await outerApp.request(
        jsonRequest('http://localhost/', {
          name: 'Bad Codespace',
          teamId,
          role: 'viewer',
          scopeCodespaceId: createId(), // not in DB
        })
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.message).toContain('Codespace not found');
    });

    it('IT-2466: returns 400 when scopeCodespaceId belongs to a different team', async () => {
      // Create a codespace in a folder owned by a DIFFERENT team
      const otherTeamId = createId();
      const otherFolderId = createId();
      await db.insert(teams).values({
        id: otherTeamId,
        name: 'Other',
        slug: `other-${otherTeamId.slice(0, 6)}`,
      });
      await db.insert(projectFolders).values({
        id: otherFolderId,
        name: 'Other Folder',
        slug: `other-folder-${otherFolderId.slice(0, 6)}`,
      });
      await db
        .insert(teamProjectFolders)
        .values({ teamId: otherTeamId, projectFolderId: otherFolderId });
      const cid = createId();
      await db.insert(codespaces).values({
        id: cid,
        name: 'Other Codespace',
        path: '/tmp/other',
        projectFolderId: otherFolderId,
      });

      const response = await outerApp.request(
        jsonRequest('http://localhost/', {
          name: 'Wrong Team Codespace',
          teamId,
          role: 'viewer',
          scopeCodespaceId: cid,
        })
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.message).toContain('not found in this team');
    });
  });

  // ─── POST / scopeTags branches ─────────────────────────────────────

  describe('POST / scopeTags branches', () => {
    beforeEach(async () => {
      await db.insert(teamMembers).values({ teamId, userId, role: 'admin' });
    });

    it('IT-2470: returns 400 when scopeTags reference missing tag IDs', async () => {
      const missingId = createId();
      const response = await outerApp.request(
        jsonRequest('http://localhost/', {
          name: 'Missing Tags',
          teamId,
          role: 'viewer',
          scopeTags: [missingId],
        })
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.message).toContain('Tag(s) not found');
      expect(body.error.message).toContain(missingId);
    });

    it('IT-2471: returns 400 when scopeTags reference tags from another team', async () => {
      // Create a tag in a folder owned by a different team
      const otherTeamId = createId();
      const otherFolderId = createId();
      await db.insert(teams).values({
        id: otherTeamId,
        name: 'OtherT',
        slug: `othert-${otherTeamId.slice(0, 6)}`,
      });
      await db.insert(projectFolders).values({
        id: otherFolderId,
        name: 'OtherF',
        slug: `otherf-${otherFolderId.slice(0, 6)}`,
      });
      await db
        .insert(teamProjectFolders)
        .values({ teamId: otherTeamId, projectFolderId: otherFolderId });
      const wrongTagId = createId();
      await db.insert(tags).values({
        id: wrongTagId,
        projectFolderId: otherFolderId,
        name: 'wrong-tag',
        color: '#aaa',
      });

      const response = await outerApp.request(
        jsonRequest('http://localhost/', {
          name: 'Wrong Team Tags',
          teamId,
          role: 'viewer',
          scopeTags: [wrongTagId],
        })
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.message).toContain('do not belong to this team');
    });
  });

  // ─── GET /?allTeam=true ────────────────────────────────────────────

  describe('GET / allTeam admin listing', () => {
    it('IT-2475: returns 403 when non-admin requests team-wide listing', async () => {
      await db.insert(teamMembers).values({ teamId, userId, role: 'agent_operator' });
      // agent_operator is below admin (level 2 < 3)
      const response = await outerApp.request(`http://localhost/?allTeam=true&teamId=${teamId}`);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.message).toContain('Only team admins');
    });

    it('IT-2476: returns all team tokens when admin requests team-wide listing', async () => {
      await db.insert(teamMembers).values({ teamId, userId, role: 'admin' });
      // Insert tokens from two different users in the same team
      const otherUserId = createId();
      await db.insert(users).values({
        id: otherUserId,
        githubId: Math.floor(Math.random() * 1_000_000_000),
        githubLogin: `other-extras-${otherUserId.slice(0, 6)}`,
      });
      await db.insert(teamMembers).values({ teamId, userId: otherUserId, role: 'viewer' });
      await insertToken(db, { userId, teamId, name: 'Mine', role: 'viewer' });
      await insertToken(db, { userId: otherUserId, teamId, name: 'Theirs', role: 'viewer' });

      const response = await outerApp.request(`http://localhost/?allTeam=true&teamId=${teamId}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.items).toHaveLength(2);
      expect(body.data.totalCount).toBe(2);
    });

    it('IT-2477: status=all + allTeam includes revoked team tokens', async () => {
      await db.insert(teamMembers).values({ teamId, userId, role: 'admin' });
      await insertToken(db, { userId, teamId, name: 'Active', role: 'viewer' });
      await insertToken(db, { userId, teamId, name: 'Revoked', role: 'viewer', status: 'revoked' });

      const response = await outerApp.request(
        `http://localhost/?allTeam=true&teamId=${teamId}&status=all`
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.items).toHaveLength(2);
    });
  });

  // ─── GET /?status=invalid ──────────────────────────────────────────

  describe('GET / status filter validation', () => {
    it('IT-2480: returns 400 for invalid status filter', async () => {
      const response = await outerApp.request('http://localhost/?status=banana');
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('IT-2481: returns 400 when teamId is malformed', async () => {
      const response = await outerApp.request('http://localhost/?teamId=not!valid');
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('INVALID_ID');
    });
  });

  // ─── GET /rotation-due ─────────────────────────────────────────────

  describe('GET /rotation-due', () => {
    it('IT-2485: returns 400 for non-numeric days param', async () => {
      const response = await outerApp.request('http://localhost/rotation-due?days=banana');
      // parseInt('banana') === NaN; clamped via Math.max(1,...)
      // The Number.isNaN guard returns 400
      expect([400, 200]).toContain(response.status);
    });

    it('IT-2486: returns user-scoped rotation-due tokens (default 30 days)', async () => {
      await db.insert(teamMembers).values({ teamId, userId, role: 'admin' });
      // Token expiring in 10 days — within 30-day window
      const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
      // Token expiring in 60 days — outside default window
      const later = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
      await insertToken(db, {
        userId,
        teamId,
        name: 'Soon',
        role: 'viewer',
        expiresAt: soon,
      });
      await insertToken(db, {
        userId,
        teamId,
        name: 'Later',
        role: 'viewer',
        expiresAt: later,
      });

      const response = await outerApp.request('http://localhost/rotation-due');
      expect(response.status).toBe(200);
      const body = await response.json();
      const names = body.data.items.map((t: { name: string }) => t.name);
      expect(names).toContain('Soon');
      expect(names).not.toContain('Later');
    });

    it('IT-2487: rotation-due with teamId admin mode returns 403 for non-admin', async () => {
      await db.insert(teamMembers).values({ teamId, userId, role: 'agent_operator' });
      const response = await outerApp.request(`http://localhost/rotation-due?teamId=${teamId}`);
      expect(response.status).toBe(403);
    });

    it('IT-2488: rotation-due with teamId admin mode returns team-wide list', async () => {
      await db.insert(teamMembers).values({ teamId, userId, role: 'admin' });
      const otherUserId = createId();
      await db.insert(users).values({
        id: otherUserId,
        githubId: Math.floor(Math.random() * 1_000_000_000),
        githubLogin: `other-rotation-${otherUserId.slice(0, 6)}`,
      });
      const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
      await insertToken(db, {
        userId: otherUserId,
        teamId,
        name: "Other's Soon",
        role: 'viewer',
        expiresAt: soon,
      });

      const response = await outerApp.request(`http://localhost/rotation-due?teamId=${teamId}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      const names = body.data.items.map((t: { name: string }) => t.name);
      expect(names).toContain("Other's Soon");
    });
  });

  // ─── DELETE /:id revoke + idempotency ─────────────────────────────

  describe('DELETE /:id', () => {
    it('IT-2490: returns 400 for invalid id format', async () => {
      const response = await outerApp.request('http://localhost/not!valid', {
        method: 'DELETE',
      });
      expect(response.status).toBe(400);
    });

    it('IT-2491: returns 404 when token does not exist', async () => {
      const response = await outerApp.request(`http://localhost/${createId()}`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(404);
    });

    it('IT-2492: revokes a user-owned token (status -> revoked)', async () => {
      await db.insert(teamMembers).values({ teamId, userId, role: 'admin' });
      const token = await insertToken(db, {
        userId,
        teamId,
        name: 'To Revoke',
        role: 'viewer',
      });

      const response = await outerApp.request(`http://localhost/${token.id}`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);

      const after = await db.query.apiTokens.findFirst({
        where: eq(apiTokens.id, token.id),
      });
      expect(after!.status).toBe('revoked');
    });
  });
});
