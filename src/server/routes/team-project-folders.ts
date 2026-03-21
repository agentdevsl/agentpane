/**
 * Team-project folder assignment routes
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { projectFolders } from '../../db/schema/sqlite/project-folders';
import { teamProjectFolders } from '../../db/schema/sqlite/team-project-folders';
import type { AuthContext } from '../../lib/api/auth-middleware';
import { createLogger } from '../../lib/logging/logger';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { isValidId, json, requireTeamRole } from '../shared';
import { idSchema, parseJsonBody } from '../validation';

const log = createLogger('TeamProjectFoldersRoutes');

interface TeamProjectFoldersDeps {
  db: Database;
  rbacService: RbacService;
}

export function createTeamProjectFoldersRoutes({ db, rbacService }: TeamProjectFoldersDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST /api/teams/:id/project-folders - Assign a project folder to the team
  app.post('/', async (c) => {
    const teamId = c.req.param('id');
    const auth = c.get('auth');

    if (!teamId || !isValidId(teamId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid team ID' } }, 400);
    }

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

    const assignFolderSchema = z.object({ projectFolderId: idSchema });
    const parsed = await parseJsonBody(c, assignFolderSchema);
    if (!parsed.ok) return parsed.response;

    const { projectFolderId } = parsed.data;

    try {
      const result = await db.transaction(async (tx) => {
        // Verify project folder exists
        const folder = await tx.query.projectFolders.findFirst({
          where: eq(projectFolders.id, projectFolderId),
        });
        if (!folder) return 'NOT_FOUND' as const;

        // Check for duplicate assignment
        const existing = await tx
          .select()
          .from(teamProjectFolders)
          .where(
            and(
              eq(teamProjectFolders.teamId, teamId),
              eq(teamProjectFolders.projectFolderId, projectFolderId)
            )
          );

        if (existing.length > 0) return 'DUPLICATE' as const;

        await tx.insert(teamProjectFolders).values({ teamId, projectFolderId });
        return 'OK' as const;
      });

      if (result === 'NOT_FOUND') {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Project folder not found' } },
          404
        );
      }
      if (result === 'DUPLICATE') {
        return json(
          {
            ok: false,
            error: {
              code: 'FOLDER_ALREADY_ASSIGNED',
              message: 'Project folder already assigned to team',
            },
          },
          409
        );
      }

      return json({ ok: true, data: { teamId, projectFolderId } }, 201);
    } catch (error) {
      log.error('Failed to assign project folder to team', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to assign project folder' } },
        500
      );
    }
  });

  // DELETE /api/teams/:id/project-folders/:folderId - Remove a project folder from the team
  app.delete('/:folderId', async (c) => {
    const teamId = c.req.param('id');
    const folderId = c.req.param('folderId');
    const auth = c.get('auth');

    if (!teamId || !folderId || !isValidId(teamId) || !isValidId(folderId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const denied = await requireTeamRole(auth, rbacService, teamId, 'admin');
    if (denied) return denied;

    try {
      const result = await db
        .delete(teamProjectFolders)
        .where(
          and(
            eq(teamProjectFolders.teamId, teamId),
            eq(teamProjectFolders.projectFolderId, folderId)
          )
        )
        .returning();

      if (result.length === 0) {
        return json(
          {
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Project folder not assigned to team' },
          },
          404
        );
      }

      return json({ ok: true, data: { removed: true } });
    } catch (error) {
      log.error('Failed to remove project folder from team', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to remove project folder' } },
        500
      );
    }
  });

  return app;
}
