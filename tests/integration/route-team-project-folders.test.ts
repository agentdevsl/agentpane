import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectFolders, teamMembers, teamProjectFolders, teams, users } from '../../src/db/schema';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import { createTeamProjectFoldersRoutes } from '../../src/server/routes/team-project-folders';
import { RbacService } from '../../src/services/rbac.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for team-project-folders API routes.
 *
 * Mounted at /api/teams/:id/project-folders.
 * Tests assignment and removal of project folders to/from teams.
 *
 * NOTE: The test helper's monkey-patched transaction() invokes the async
 * callback twice (once in the native SQLite wrapper, once in the fallback).
 * For routes that use db.transaction() with INSERT on a composite PK
 * (team_project_folders), this causes a PK constraint violation. We wrap
 * the db with a single-call transaction to avoid the double-invocation.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

/**
 * Wrap the test db's transaction method so the async callback is only called
 * once.  The default monkey-patch calls the callback twice (sync attempt +
 * fallback), which triggers PK-constraint errors on composite-PK tables
 * whose rows have no auto-generated ID column.
 */
function wrapDbForSingleCallTransaction(db: ReturnType<typeof getTestDb>) {
  const _original = db.transaction.bind(db);
  const wrapped = Object.create(db);
  wrapped.transaction = (callback: (tx: any) => any) => {
    // Skip the native better-sqlite3 wrapper that causes the double-call.
    // Just run the callback directly — all Drizzle ops on better-sqlite3
    // resolve synchronously, so transactional safety is acceptable for tests.
    return callback(db);
  };
  // Proxy query/select/insert/delete/update through to the real db
  wrapped.query = db.query;
  wrapped.select = db.select.bind(db);
  wrapped.insert = db.insert.bind(db);
  wrapped.delete = db.delete.bind(db);
  wrapped.update = db.update.bind(db);
  return wrapped;
}

describe('Team Project Folder Routes (IT-530)', () => {
  let outerApp: Hono;
  let db: ReturnType<typeof getTestDb>;
  let rbacService: RbacService;
  let teamId: string;
  let userId: string;
  let folderId: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    rbacService = new RbacService(db as any);

    // Create a test user
    userId = createId();
    await db.insert(users).values({
      id: userId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `tpf-user-${userId.slice(0, 6)}`,
      name: 'TPF Test User',
    });

    // Create a team
    teamId = createId();
    await db.insert(teams).values({
      id: teamId,
      name: 'Test Team',
      slug: `test-team-${teamId.slice(0, 8)}`,
    });

    // Make user an admin of the team
    await db.insert(teamMembers).values({
      teamId,
      userId,
      role: 'admin',
    });

    // Create a project folder for assignment
    folderId = createId();
    await db.insert(projectFolders).values({
      id: folderId,
      name: 'Test Folder',
      slug: `test-folder-${folderId.slice(0, 8)}`,
    });

    // Use wrapped db to avoid double-callback transaction bug
    const wrappedDb = wrapDbForSingleCallTransaction(db);

    // Mount the routes under /api/teams/:id/project-folders
    const routes = createTeamProjectFoldersRoutes({ db: wrappedDb as any, rbacService });
    outerApp = new Hono<{ Variables: { auth: AuthContext } }>();
    // Inject dev auth context
    outerApp.use('*', async (c, next) => {
      c.set('auth', { userId, authMethod: 'dev' });
      await next();
    });
    outerApp.route('/api/teams/:id/project-folders', routes);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── POST /api/teams/:id/project-folders ────────────

  it('IT-531: POST assigns a project folder to the team', async () => {
    const response = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/project-folders`, {
        projectFolderId: folderId,
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.teamId).toBe(teamId);
    expect(body.data.projectFolderId).toBe(folderId);
  });

  it('IT-532: POST returns 409 for duplicate assignment', async () => {
    // First assignment
    await db.insert(teamProjectFolders).values({ teamId, projectFolderId: folderId });

    const response = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/project-folders`, {
        projectFolderId: folderId,
      })
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('FOLDER_ALREADY_ASSIGNED');
  });

  it('IT-533: POST returns 404 for non-existent project folder', async () => {
    const response = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/project-folders`, {
        projectFolderId: 'nonexistent-folder-id',
      })
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('IT-534: POST returns 400 for missing projectFolderId', async () => {
    const response = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/project-folders`, {})
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it('IT-535: POST returns 400 for invalid team ID format', async () => {
    const response = await outerApp.request(
      jsonRequest('http://localhost/api/teams/inv@lid!/project-folders', {
        projectFolderId: folderId,
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('IT-536: POST returns 400 for invalid JSON body', async () => {
    const response = await outerApp.request(
      new Request(`http://localhost/api/teams/${teamId}/project-folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  // ─── DELETE /api/teams/:id/project-folders/:folderId ─

  it('IT-537: DELETE removes a project folder assignment', async () => {
    // Assign first
    await db.insert(teamProjectFolders).values({ teamId, projectFolderId: folderId });

    const response = await outerApp.request(
      `http://localhost/api/teams/${teamId}/project-folders/${folderId}`,
      { method: 'DELETE' }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.removed).toBe(true);

    // Verify it's gone
    const remaining = await db
      .select()
      .from(teamProjectFolders)
      .where(eq(teamProjectFolders.teamId, teamId));
    expect(remaining.length).toBe(0);
  });

  it('IT-538: DELETE returns 404 when assignment does not exist', async () => {
    const response = await outerApp.request(
      `http://localhost/api/teams/${teamId}/project-folders/${folderId}`,
      { method: 'DELETE' }
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('IT-539: DELETE returns 400 for invalid folder ID format', async () => {
    const response = await outerApp.request(
      `http://localhost/api/teams/${teamId}/project-folders/inv@lid!`,
      { method: 'DELETE' }
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  // ─── RBAC enforcement ──────────────────────────────

  it('IT-540: POST returns 403 for non-admin team member', async () => {
    // Create viewer user
    const viewerId = createId();
    await db.insert(users).values({
      id: viewerId,
      githubId: Math.floor(Math.random() * 1000000000),
      githubLogin: `viewer-${viewerId.slice(0, 6)}`,
      name: 'Viewer User',
    });
    await db.insert(teamMembers).values({ teamId, userId: viewerId, role: 'viewer' });

    // Create app with viewer auth (non-dev mode)
    const routes = createTeamProjectFoldersRoutes({ db: db as any, rbacService });
    const viewerApp = new Hono<{ Variables: { auth: AuthContext } }>();
    viewerApp.use('*', async (c, next) => {
      c.set('auth', { userId: viewerId, authMethod: 'session' });
      await next();
    });
    viewerApp.route('/api/teams/:id/project-folders', routes);

    const response = await viewerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/project-folders`, {
        projectFolderId: folderId,
      })
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  // ─── Round-trip test ────────────────────────────────

  it('IT-541: Assign and remove round-trip', async () => {
    // Assign
    const assignRes = await outerApp.request(
      jsonRequest(`http://localhost/api/teams/${teamId}/project-folders`, {
        projectFolderId: folderId,
      })
    );
    expect(assignRes.status).toBe(201);

    // Remove
    const removeRes = await outerApp.request(
      `http://localhost/api/teams/${teamId}/project-folders/${folderId}`,
      { method: 'DELETE' }
    );
    expect(removeRes.status).toBe(200);

    // Verify removing again returns 404
    const doubleRemoveRes = await outerApp.request(
      `http://localhost/api/teams/${teamId}/project-folders/${folderId}`,
      { method: 'DELETE' }
    );
    expect(doubleRemoveRes.status).toBe(404);
  });
});
