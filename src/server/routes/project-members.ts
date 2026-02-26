/**
 * Project member routes
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { projectMembers } from '../../db/schema/sqlite/project-members';
import { users } from '../../db/schema/sqlite/users';
import type { AuthContext } from '../../lib/api/auth-middleware';
import { createLogger } from '../../lib/logging/logger';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { isValidId, json } from '../shared';
import { addProjectMemberSchema, parseBody, updateProjectMemberSchema } from '../validation';

const log = createLogger('ProjectMembersRoutes');

interface ProjectMembersDeps {
  db: Database;
  rbacService: RbacService;
}

export function createProjectMembersRoutes({ db, rbacService }: ProjectMembersDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST / - Add project member override
  app.post('/', async (c) => {
    const projectId = c.req.param('id');
    const auth = c.get('auth');

    if (!projectId || !isValidId(projectId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid project ID' } }, 400);
    }

    // Require admin role on this project
    if (auth.authMethod !== 'dev') {
      const role = await rbacService.resolveUserRole(auth.userId, projectId);
      if (!role || !rbacService.hasMinimumRole(role, 'admin')) {
        return json(
          { ok: false, error: { code: 'FORBIDDEN', message: 'Requires admin role' } },
          403
        );
      }
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }, 400);
    }

    const parsed = parseBody(addProjectMemberSchema, body);
    if (!parsed.ok) return parsed.response;

    try {
      const existing = await db
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, parsed.data.userId)
          )
        );

      if (existing.length > 0) {
        return json(
          { ok: false, error: { code: 'DUPLICATE', message: 'Member already exists' } },
          409
        );
      }

      await db.insert(projectMembers).values({
        projectId,
        userId: parsed.data.userId,
        role: parsed.data.role,
        grantedByTeamId: parsed.data.teamId ?? null,
      });

      return json({
        ok: true,
        data: { projectId, userId: parsed.data.userId, role: parsed.data.role },
      });
    } catch (error) {
      log.error('Failed to add member', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to add member' } }, 500);
    }
  });

  // GET / - List project members
  app.get('/', async (c) => {
    const projectId = c.req.param('id');

    if (!projectId || !isValidId(projectId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid project ID' } }, 400);
    }

    const auth = c.get('auth');
    if (auth.authMethod !== 'dev') {
      const role = await rbacService.resolveUserRole(auth.userId, projectId);
      if (!role) {
        return json(
          { ok: false, error: { code: 'FORBIDDEN', message: 'Not a project member' } },
          403
        );
      }
    }

    try {
      const members = await db
        .select({
          userId: projectMembers.userId,
          role: projectMembers.role,
          grantedByTeamId: projectMembers.grantedByTeamId,
          createdAt: projectMembers.createdAt,
          userName: users.name,
          githubLogin: users.githubLogin,
          avatarUrl: users.avatarUrl,
        })
        .from(projectMembers)
        .leftJoin(users, eq(projectMembers.userId, users.id))
        .where(eq(projectMembers.projectId, projectId));

      return json({ ok: true, data: { items: members } });
    } catch (error) {
      log.error('Failed to list members', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list members' } },
        500
      );
    }
  });

  // PATCH /:uid - Update project member role
  app.patch('/:uid', async (c) => {
    const projectId = c.req.param('id');
    const uid = c.req.param('uid');
    const auth = c.get('auth');

    if (!projectId || !uid || !isValidId(projectId) || !isValidId(uid)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    if (auth.authMethod !== 'dev') {
      const role = await rbacService.resolveUserRole(auth.userId, projectId);
      if (!role || !rbacService.hasMinimumRole(role, 'admin')) {
        return json(
          { ok: false, error: { code: 'FORBIDDEN', message: 'Requires admin role' } },
          403
        );
      }
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }, 400);
    }

    const parsed = parseBody(updateProjectMemberSchema, body);
    if (!parsed.ok) return parsed.response;

    try {
      const result = await db
        .update(projectMembers)
        .set({ role: parsed.data.role })
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, uid)))
        .returning();

      if (result.length === 0) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Member not found' } }, 404);
      }

      return json({ ok: true, data: result[0] });
    } catch (error) {
      log.error('Failed to update member', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update member' } },
        500
      );
    }
  });

  // DELETE /:uid - Remove project member override
  app.delete('/:uid', async (c) => {
    const projectId = c.req.param('id');
    const uid = c.req.param('uid');
    const auth = c.get('auth');

    if (!projectId || !uid || !isValidId(projectId) || !isValidId(uid)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    if (auth.authMethod !== 'dev') {
      const role = await rbacService.resolveUserRole(auth.userId, projectId);
      if (!role || !rbacService.hasMinimumRole(role, 'admin')) {
        return json(
          { ok: false, error: { code: 'FORBIDDEN', message: 'Requires admin role' } },
          403
        );
      }
    }

    try {
      await db
        .delete(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, uid)));
      return json({ ok: true, data: { removed: true } });
    } catch (error) {
      log.error('Failed to remove member', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to remove member' } },
        500
      );
    }
  });

  return app;
}
