import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codespaceTags,
  projectFolders,
  tags,
  taskTags,
  teamProjectFolders,
} from '../../src/db/schema';
import type { AuthContext } from '../../src/lib/api/auth-middleware';
import {
  createProjectTagRoutes,
  createTagsRoutes,
  createTaskTagRoutes,
} from '../../src/server/routes/tags';
import { RbacService } from '../../src/services/rbac.service';
import { createTestProject } from '../factories/project.factory';
import { createTestTask } from '../factories/task.factory';
import { createTestTeam, createTestTeamMember } from '../factories/team.factory';
import { createTestUser } from '../factories/user.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Integration tests for tag routes (createTagsRoutes,
 * createProjectTagRoutes, createTaskTagRoutes).
 *
 * Uses real RbacService against the test DB to exercise the team-role and
 * codespace-role denials, plus the cross-folder validation that prevents
 * assigning tags to codespaces outside their owning folder.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

function makeAuth(userId: string): AuthContext {
  return { userId, authMethod: 'session' as const };
}

describe('Tags Routes (IT-1830)', () => {
  let db: ReturnType<typeof getTestDb>;
  let rbacService: RbacService;
  let outerApp: Hono;
  let outerProjApp: Hono;
  let outerTaskApp: Hono;

  let adminUserId: string;
  let viewerUserId: string;
  let nonMemberUserId: string;

  let teamId: string;
  let folderId: string;
  let codespaceId: string;
  let codespaceOtherFolderId: string;
  let taskId: string;
  let currentAuthUser: string;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    rbacService = new RbacService(db);

    const admin = await createTestUser();
    adminUserId = admin.id;
    const viewer = await createTestUser();
    viewerUserId = viewer.id;
    const nonMember = await createTestUser();
    nonMemberUserId = nonMember.id;

    const team = await createTestTeam();
    teamId = team.id;
    await createTestTeamMember(teamId, adminUserId, { role: 'admin' });
    await createTestTeamMember(teamId, viewerUserId, { role: 'viewer' });

    // Create folder owned by team
    folderId = `folder-${teamId.slice(0, 6)}`;
    await db.insert(projectFolders).values({ id: folderId, name: 'F', slug: `f-${folderId}` });
    await db.insert(teamProjectFolders).values({ teamId, projectFolderId: folderId });

    // Codespace inside the folder
    const cs = await createTestProject({ projectFolderId: folderId });
    codespaceId = cs.id;

    // Different folder + codespace (not owned by the same team)
    const otherFolderId = `folder-other-${Date.now()}`;
    await db
      .insert(projectFolders)
      .values({ id: otherFolderId, name: 'Other', slug: `other-${Date.now()}` });
    const otherCs = await createTestProject({ projectFolderId: otherFolderId });
    codespaceOtherFolderId = otherCs.id;

    const task = await createTestTask(codespaceId, { title: 'Tag me' });
    taskId = task.id;

    currentAuthUser = adminUserId;

    const tagsApp = createTagsRoutes({ db: db as never, rbacService });
    outerApp = new Hono();
    outerApp.use('*', async (c, next) => {
      c.set('auth', makeAuth(currentAuthUser) as never);
      await next();
    });
    outerApp.route('/', tagsApp);

    const projTagApp = createProjectTagRoutes({ db: db as never, rbacService });
    outerProjApp = new Hono();
    outerProjApp.use('*', async (c, next) => {
      c.set('auth', makeAuth(currentAuthUser) as never);
      await next();
    });
    outerProjApp.route('/:id/tags', projTagApp);

    const taskTagApp = createTaskTagRoutes({ db: db as never, rbacService });
    outerTaskApp = new Hono();
    outerTaskApp.use('*', async (c, next) => {
      c.set('auth', makeAuth(currentAuthUser) as never);
      await next();
    });
    outerTaskApp.route('/:id/tags', taskTagApp);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ─── POST /api/tags ──────────────────────────────────

  it('IT-1830-1: POST / returns 404 when projectFolderId not associated with any team', async () => {
    const res = await outerApp.request(
      jsonRequest('http://localhost/', { projectFolderId: 'no-such-folder', name: 'Tag1' })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('IT-1830-2: POST / denies non-member with INSUFFICIENT_ROLE', async () => {
    currentAuthUser = nonMemberUserId;
    const res = await outerApp.request(
      jsonRequest('http://localhost/', { projectFolderId: folderId, name: 'Tag1' })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('IT-1830-3: POST / denies viewer (needs agent_operator)', async () => {
    currentAuthUser = viewerUserId;
    const res = await outerApp.request(
      jsonRequest('http://localhost/', { projectFolderId: folderId, name: 'Tag1' })
    );
    expect(res.status).toBe(403);
  });

  it('IT-1830-4: POST / creates a tag for admin', async () => {
    const res = await outerApp.request(
      jsonRequest('http://localhost/', {
        projectFolderId: folderId,
        name: 'Backend',
        color: '#abcdef',
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.name).toBe('Backend');
    expect(body.data.color).toBe('#abcdef');
  });

  it('IT-1830-5: POST / returns 409 on duplicate tag name', async () => {
    await outerApp.request(
      jsonRequest('http://localhost/', { projectFolderId: folderId, name: 'Dup' })
    );
    const res = await outerApp.request(
      jsonRequest('http://localhost/', { projectFolderId: folderId, name: 'Dup' })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('TAG_ALREADY_EXISTS');
  });

  it('IT-1830-6: POST / rejects malformed body via schema', async () => {
    const res = await outerApp.request(
      jsonRequest('http://localhost/', { projectFolderId: 'bad..id', name: '' })
    );
    expect(res.status).toBe(400);
  });

  // ─── GET /api/tags ───────────────────────────────────

  it('IT-1830-7: GET / requires teamId param', async () => {
    const res = await outerApp.request('http://localhost/');
    expect(res.status).toBe(400);
  });

  it('IT-1830-8: GET / denies non-member', async () => {
    currentAuthUser = nonMemberUserId;
    const res = await outerApp.request(`http://localhost/?teamId=${teamId}`);
    expect(res.status).toBe(403);
  });

  it('IT-1830-9: GET / returns empty list when team has no folders', async () => {
    const newTeam = await createTestTeam();
    await createTestTeamMember(newTeam.id, adminUserId, { role: 'admin' });
    const res = await outerApp.request(`http://localhost/?teamId=${newTeam.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
  });

  it('IT-1830-10: GET / returns enriched tags with counts', async () => {
    const created = await db
      .insert(tags)
      .values({ projectFolderId: folderId, name: 'Backend' })
      .returning();
    const tagId = created[0]!.id;
    await db.insert(codespaceTags).values({ codespaceId, tagId });
    await db.insert(taskTags).values({ taskId, tagId });

    const res = await outerApp.request(`http://localhost/?teamId=${teamId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].projectCount).toBe(1);
    expect(body.data.items[0].taskCount).toBe(1);
  });

  // ─── DELETE /api/tags/:id ────────────────────────────

  it('IT-1830-11: DELETE /:id rejects bad ID', async () => {
    const res = await outerApp.request('http://localhost/bad..id', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('IT-1830-12: DELETE /:id returns 404 when tag does not exist', async () => {
    const res = await outerApp.request('http://localhost/no-such-tag', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('TAG_NOT_FOUND');
  });

  it('IT-1830-13: DELETE /:id returns 404 when tag folder has no team', async () => {
    const orphanFolderId = `orphan-folder-${Date.now()}`;
    await db
      .insert(projectFolders)
      .values({ id: orphanFolderId, name: 'O', slug: `o-${Date.now()}` });
    const created = await db
      .insert(tags)
      .values({ projectFolderId: orphanFolderId, name: 'OrphanTag' })
      .returning();
    const res = await outerApp.request(`http://localhost/${created[0]!.id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('IT-1830-14: DELETE /:id denies viewer', async () => {
    const created = await db
      .insert(tags)
      .values({ projectFolderId: folderId, name: 'ToDelete' })
      .returning();
    currentAuthUser = viewerUserId;
    const res = await outerApp.request(`http://localhost/${created[0]!.id}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('IT-1830-15: DELETE /:id deletes tag for admin', async () => {
    const created = await db
      .insert(tags)
      .values({ projectFolderId: folderId, name: 'ToDelete' })
      .returning();
    const res = await outerApp.request(`http://localhost/${created[0]!.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const remaining = await db.select().from(tags).where(eq(tags.id, created[0]!.id));
    expect(remaining).toHaveLength(0);
  });

  // ─── POST /api/codespaces/:id/tags ───────────────────

  it('IT-1830-16: POST codespace tags rejects bad codespace ID', async () => {
    const res = await outerProjApp.request(
      jsonRequest('http://localhost/bad..id/tags', { tagId: 'x' })
    );
    expect(res.status).toBe(400);
  });

  it('IT-1830-17: POST codespace tags denies user without role', async () => {
    currentAuthUser = nonMemberUserId;
    const tag = await db
      .insert(tags)
      .values({ projectFolderId: folderId, name: 'Backend' })
      .returning();
    const res = await outerProjApp.request(
      jsonRequest(`http://localhost/${codespaceId}/tags`, { tagId: tag[0]!.id })
    );
    expect(res.status).toBe(403);
  });

  it('IT-1830-18: POST codespace tags returns 404 when tag does not exist', async () => {
    const res = await outerProjApp.request(
      jsonRequest(`http://localhost/${codespaceId}/tags`, { tagId: 'no-tag' })
    );
    expect(res.status).toBe(404);
  });

  it('IT-1830-19: POST codespace tags rejects cross-folder assignment', async () => {
    // Make the admin a codespace_member on the OTHER codespace so the
    // RBAC check passes; we want to exercise the cross-folder validation
    // that follows.
    const { codespaceMembers } = await import('../../src/db/schema');
    await db
      .insert(codespaceMembers)
      .values({ codespaceId: codespaceOtherFolderId, userId: adminUserId, role: 'admin' });

    const tag = await db
      .insert(tags)
      .values({ projectFolderId: folderId, name: 'Backend' })
      .returning();
    // Try to assign tag from folder A to codespace in folder B
    const res = await outerProjApp.request(
      jsonRequest(`http://localhost/${codespaceOtherFolderId}/tags`, { tagId: tag[0]!.id })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toContain('does not belong');
  });

  it('IT-1830-20: POST codespace tags assigns tag', async () => {
    const tag = await db
      .insert(tags)
      .values({ projectFolderId: folderId, name: 'Backend' })
      .returning();
    const res = await outerProjApp.request(
      jsonRequest(`http://localhost/${codespaceId}/tags`, { tagId: tag[0]!.id })
    );
    expect(res.status).toBe(201);
    const rows = await db
      .select()
      .from(codespaceTags)
      .where(eq(codespaceTags.codespaceId, codespaceId));
    expect(rows).toHaveLength(1);
  });

  it('IT-1830-21: POST codespace tags rejects malformed body', async () => {
    const res = await outerProjApp.request(
      jsonRequest(`http://localhost/${codespaceId}/tags`, { tagId: '' })
    );
    expect(res.status).toBe(400);
  });

  // ─── DELETE /api/codespaces/:id/tags/:tagId ──────────

  it('IT-1830-22: DELETE codespace tag rejects bad codespace ID', async () => {
    const res = await outerProjApp.request('http://localhost/bad..id/tags/some-tag', {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
  });

  it('IT-1830-23: DELETE codespace tag rejects bad tag ID', async () => {
    const res = await outerProjApp.request(`http://localhost/${codespaceId}/tags/bad..id`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
  });

  it('IT-1830-24: DELETE codespace tag removes assignment', async () => {
    const tag = await db
      .insert(tags)
      .values({ projectFolderId: folderId, name: 'Backend' })
      .returning();
    await db.insert(codespaceTags).values({ codespaceId, tagId: tag[0]!.id });

    const res = await outerProjApp.request(`http://localhost/${codespaceId}/tags/${tag[0]!.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const remaining = await db
      .select()
      .from(codespaceTags)
      .where(eq(codespaceTags.codespaceId, codespaceId));
    expect(remaining).toHaveLength(0);
  });

  // ─── POST /api/tasks/:id/tags ────────────────────────

  it('IT-1830-25: POST task tag rejects bad task ID', async () => {
    const res = await outerTaskApp.request(
      jsonRequest('http://localhost/bad..id/tags', { tagId: 'x' })
    );
    expect(res.status).toBe(400);
  });

  it('IT-1830-26: POST task tag returns 404 when task missing', async () => {
    const res = await outerTaskApp.request(
      jsonRequest('http://localhost/no-task-id/tags', { tagId: 'x' })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('IT-1830-27: POST task tag denies non-member', async () => {
    currentAuthUser = nonMemberUserId;
    const tag = await db.insert(tags).values({ projectFolderId: folderId, name: 'T' }).returning();
    const res = await outerTaskApp.request(
      jsonRequest(`http://localhost/${taskId}/tags`, { tagId: tag[0]!.id })
    );
    expect(res.status).toBe(403);
  });

  it('IT-1830-28: POST task tag returns 404 when tag missing', async () => {
    const res = await outerTaskApp.request(
      jsonRequest(`http://localhost/${taskId}/tags`, { tagId: 'no-tag' })
    );
    expect(res.status).toBe(404);
  });

  it('IT-1830-29: POST task tag rejects cross-folder assignment', async () => {
    const otherFolderId = `cross-folder-${Date.now()}`;
    await db
      .insert(projectFolders)
      .values({ id: otherFolderId, name: 'X', slug: `x-${Date.now()}` });
    const tag = await db
      .insert(tags)
      .values({ projectFolderId: otherFolderId, name: 'CrossTag' })
      .returning();

    const res = await outerTaskApp.request(
      jsonRequest(`http://localhost/${taskId}/tags`, { tagId: tag[0]!.id })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('IT-1830-30: POST task tag rejects malformed body', async () => {
    const res = await outerTaskApp.request(
      jsonRequest(`http://localhost/${taskId}/tags`, { tagId: '' })
    );
    expect(res.status).toBe(400);
  });

  it('IT-1830-31: POST task tag assigns tag', async () => {
    const tag = await db.insert(tags).values({ projectFolderId: folderId, name: 'T' }).returning();
    const res = await outerTaskApp.request(
      jsonRequest(`http://localhost/${taskId}/tags`, { tagId: tag[0]!.id })
    );
    expect(res.status).toBe(201);
    const rows = await db.select().from(taskTags).where(eq(taskTags.taskId, taskId));
    expect(rows).toHaveLength(1);
  });

  // ─── DELETE /api/tasks/:id/tags/:tagId ───────────────

  it('IT-1830-32: DELETE task tag rejects bad task ID', async () => {
    const res = await outerTaskApp.request('http://localhost/bad..id/tags/some-tag', {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
  });

  it('IT-1830-33: DELETE task tag rejects bad tag ID', async () => {
    const res = await outerTaskApp.request(`http://localhost/${taskId}/tags/bad..id`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
  });

  it('IT-1830-34: DELETE task tag returns 404 when task missing', async () => {
    const res = await outerTaskApp.request('http://localhost/no-task-id/tags/some-tag', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  it('IT-1830-35: DELETE task tag removes assignment', async () => {
    const tag = await db.insert(tags).values({ projectFolderId: folderId, name: 'T' }).returning();
    await db.insert(taskTags).values({ taskId, tagId: tag[0]!.id });

    const res = await outerTaskApp.request(`http://localhost/${taskId}/tags/${tag[0]!.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const remaining = await db.select().from(taskTags).where(eq(taskTags.taskId, taskId));
    expect(remaining).toHaveLength(0);
  });
});
