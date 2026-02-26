/**
 * Tag routes
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { projectTags } from '../../db/schema/sqlite/project-tags';
import { tags } from '../../db/schema/sqlite/tags';
import { taskTags } from '../../db/schema/sqlite/task-tags';
import type { AuthContext } from '../../lib/api/auth-middleware';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { isValidId, json } from '../shared';
import { assignTagSchema, createTagSchema, parseBody } from '../validation';

interface TagsDeps {
  db: Database;
  rbacService: RbacService;
}

export function createTagsRoutes({ db, rbacService }: TagsDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST /api/tags - Create tag
  app.post('/', async (c) => {
    const auth = c.get('auth');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }, 400);
    }

    const parsed = parseBody(createTagSchema, body);
    if (!parsed.ok) return parsed.response;

    // Check admin role in the tag's team
    if (auth.authMethod !== 'dev') {
      const role = await rbacService.resolveTeamRole(auth.userId, parsed.data.teamId);
      if (!role || !rbacService.hasMinimumRole(role, 'admin')) {
        return json(
          { ok: false, error: { code: 'FORBIDDEN', message: 'Requires admin role in team' } },
          403
        );
      }
    }

    try {
      const [created] = await db
        .insert(tags)
        .values({
          teamId: parsed.data.teamId,
          name: parsed.data.name,
          ...(parsed.data.color && { color: parsed.data.color }),
        })
        .returning();

      return json({ ok: true, data: created });
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
        return json(
          {
            ok: false,
            error: { code: 'DUPLICATE', message: 'Tag name already exists in this team' },
          },
          409
        );
      }
      console.error('[Tags] Create error:', error);
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to create tag' } }, 500);
    }
  });

  // GET /api/tags?teamId=xxx - List tags for a team
  app.get('/', async (c) => {
    const teamId = c.req.query('teamId');

    if (!teamId || !isValidId(teamId)) {
      return json(
        {
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'teamId query parameter required' },
        },
        400
      );
    }

    try {
      const teamTags = await db.select().from(tags).where(eq(tags.teamId, teamId));

      return json({ ok: true, data: { items: teamTags } });
    } catch (error) {
      console.error('[Tags] List error:', error);
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to list tags' } }, 500);
    }
  });

  // DELETE /api/tags/:id - Delete tag
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    try {
      await db.delete(tags).where(eq(tags.id, id));
      return json({ ok: true, data: { deleted: true } });
    } catch (error) {
      console.error('[Tags] Delete error:', error);
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to delete tag' } }, 500);
    }
  });

  // POST /api/projects/:id/tags - Assign tag to project
  app.post('/projects/:id/tags', async (c) => {
    const projectId = c.req.param('id');

    if (!isValidId(projectId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid project ID' } }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }, 400);
    }

    const parsed = parseBody(assignTagSchema, body);
    if (!parsed.ok) return parsed.response;

    try {
      await db
        .insert(projectTags)
        .values({ projectId, tagId: parsed.data.tagId })
        .onConflictDoNothing();

      return json({ ok: true, data: { projectId, tagId: parsed.data.tagId } });
    } catch (error) {
      console.error('[Tags] Assign to project error:', error);
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to assign tag' } }, 500);
    }
  });

  // DELETE /api/projects/:id/tags/:tagId - Remove tag from project
  app.delete('/projects/:id/tags/:tagId', async (c) => {
    const projectId = c.req.param('id');
    const tagId = c.req.param('tagId');

    if (!isValidId(projectId) || !isValidId(tagId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    try {
      await db
        .delete(projectTags)
        .where(and(eq(projectTags.projectId, projectId), eq(projectTags.tagId, tagId)));
      return json({ ok: true, data: { removed: true } });
    } catch (error) {
      console.error('[Tags] Remove from project error:', error);
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to remove tag' } }, 500);
    }
  });

  // POST /api/tasks/:id/tags - Assign tag to task
  app.post('/tasks/:id/tags', async (c) => {
    const taskId = c.req.param('id');

    if (!isValidId(taskId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid task ID' } }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }, 400);
    }

    const parsed = parseBody(assignTagSchema, body);
    if (!parsed.ok) return parsed.response;

    try {
      await db.insert(taskTags).values({ taskId, tagId: parsed.data.tagId }).onConflictDoNothing();

      return json({ ok: true, data: { taskId, tagId: parsed.data.tagId } });
    } catch (error) {
      console.error('[Tags] Assign to task error:', error);
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to assign tag' } }, 500);
    }
  });

  // DELETE /api/tasks/:id/tags/:tagId - Remove tag from task
  app.delete('/tasks/:id/tags/:tagId', async (c) => {
    const taskId = c.req.param('id');
    const tagId = c.req.param('tagId');

    if (!isValidId(taskId) || !isValidId(tagId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    try {
      await db.delete(taskTags).where(and(eq(taskTags.taskId, taskId), eq(taskTags.tagId, tagId)));
      return json({ ok: true, data: { removed: true } });
    } catch (error) {
      console.error('[Tags] Remove from task error:', error);
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to remove tag' } }, 500);
    }
  });

  return app;
}
