/**
 * Team-project assignment routes
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { projects } from '../../db/schema/sqlite/projects';
import { teamProjects } from '../../db/schema/sqlite/team-projects';
import type { AuthContext } from '../../lib/api/auth-middleware';
import { createLogger } from '../../lib/logging/logger';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { isValidId, json, requireTeamRole } from '../shared';

const log = createLogger('TeamProjectsRoutes');

interface TeamProjectsDeps {
  db: Database;
  rbacService: RbacService;
}

export function createTeamProjectsRoutes({ db, rbacService }: TeamProjectsDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST /api/teams/:id/projects - Assign a project to the team
  app.post('/', async (c) => {
    const teamId = c.req.param('id');
    const auth = c.get('auth');

    if (!teamId || !isValidId(teamId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid team ID' } }, 400);
    }

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' } }, 400);
    }

    const { projectId } = body as { projectId?: string };
    if (!projectId || !isValidId(projectId)) {
      return json(
        { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Valid projectId is required' } },
        400
      );
    }

    try {
      // Verify project exists
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      if (!project) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
      }

      // Check for duplicate assignment
      const existing = await db
        .select()
        .from(teamProjects)
        .where(and(eq(teamProjects.teamId, teamId), eq(teamProjects.projectId, projectId)));

      if (existing.length > 0) {
        return json(
          { ok: false, error: { code: 'PROJECT_ALREADY_ASSIGNED', message: 'Project already assigned to team' } },
          409
        );
      }

      await db.insert(teamProjects).values({ teamId, projectId });

      return json({ ok: true, data: { teamId, projectId } }, 201);
    } catch (error) {
      log.error('Failed to assign project to team', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to assign project' } },
        500
      );
    }
  });

  // DELETE /api/teams/:id/projects/:projectId - Remove a project from the team
  app.delete('/:projectId', async (c) => {
    const teamId = c.req.param('id');
    const projectId = c.req.param('projectId');
    const auth = c.get('auth');

    if (!teamId || !projectId || !isValidId(teamId) || !isValidId(projectId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

    try {
      const result = await db
        .delete(teamProjects)
        .where(and(eq(teamProjects.teamId, teamId), eq(teamProjects.projectId, projectId)))
        .returning();

      if (result.length === 0) {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Project not assigned to team' } },
          404
        );
      }

      return json({ ok: true, data: { removed: true } });
    } catch (error) {
      log.error('Failed to remove project from team', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to remove project' } },
        500
      );
    }
  });

  return app;
}
