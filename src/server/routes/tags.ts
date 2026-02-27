/**
 * Tag routes
 */

import { and, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { projectTags } from '../../db/schema/sqlite/project-tags';
import { tags } from '../../db/schema/sqlite/tags';
import { taskTags } from '../../db/schema/sqlite/task-tags';
import { tasks } from '../../db/schema/sqlite/tasks';
import { teamProjects } from '../../db/schema/sqlite/team-projects';
import type { AuthContext } from '../../lib/api/auth-middleware';
import { createLogger } from '../../lib/logging/logger';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { isValidId, json, requireProjectRole, requireTeamRole } from '../shared';
import { assignTagSchema, createTagSchema, parseJsonBody } from '../validation';

const log = createLogger('TagsRoutes');

interface TagsDeps {
  db: Database;
  rbacService: RbacService;
}

export function createTagsRoutes({ db, rbacService }: TagsDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST /api/tags - Create tag
  app.post('/', async (c) => {
    const auth = c.get('auth');
    const parsed = await parseJsonBody(c, createTagSchema);
    if (!parsed.ok) return parsed.response;

    const denied = await requireTeamRole(
      auth,
      rbacService,
      parsed.data.teamId,
      'agent_operator',
      'Requires agent_operator role in team'
    );
    if (denied) return denied;

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
            error: { code: 'TAG_ALREADY_EXISTS', message: 'Tag name already exists in this team' },
          },
          409
        );
      }
      log.error('Failed to create tag', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to create tag' } }, 500);
    }
  });

  // GET /api/tags?teamId=xxx - List tags for a team
  app.get('/', async (c) => {
    const teamId = c.req.query('teamId');
    const auth = c.get('auth');

    if (!teamId || !isValidId(teamId)) {
      return json(
        {
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'teamId query parameter required' },
        },
        400
      );
    }

    const denied = await requireTeamRole(
      auth,
      rbacService,
      teamId,
      'viewer',
      'Not a member of this team'
    );
    if (denied) return denied;

    try {
      const teamTags = await db.select().from(tags).where(eq(tags.teamId, teamId));

      // Enrich each tag with projectCount and taskCount
      const enrichedTags = await Promise.all(
        teamTags.map(async (tag) => {
          const [projectCountResult, taskCountResult] = await Promise.all([
            db.select({ total: count() }).from(projectTags).where(eq(projectTags.tagId, tag.id)),
            db.select({ total: count() }).from(taskTags).where(eq(taskTags.tagId, tag.id)),
          ]);

          return {
            ...tag,
            projectCount: projectCountResult[0]?.total ?? 0,
            taskCount: taskCountResult[0]?.total ?? 0,
          };
        })
      );

      return json({ ok: true, data: { items: enrichedTags } });
    } catch (error) {
      log.error('Failed to list tags', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to list tags' } }, 500);
    }
  });

  // DELETE /api/tags/:id - Delete tag
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');

    // Always check tag existence first
    const tagRows = await db.select({ teamId: tags.teamId }).from(tags).where(eq(tags.id, id));
    const foundTag = tagRows[0];
    if (!foundTag) {
      return json({ ok: false, error: { code: 'TAG_NOT_FOUND', message: 'Tag not found' } }, 404);
    }

    // Auth check (skip for dev mode)
    if (auth.authMethod !== 'dev') {
      const denied = await requireTeamRole(
        auth,
        rbacService,
        foundTag.teamId,
        'admin',
        'Requires admin role in team'
      );
      if (denied) return denied;
    }

    try {
      await db.delete(tags).where(eq(tags.id, id));
      return json({ ok: true, data: { deleted: true } });
    } catch (error) {
      log.error('Failed to delete tag', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to delete tag' } }, 500);
    }
  });

  return app;
}

/**
 * Project tag assignment routes.
 * Mounted at /api/projects/:id/tags so paths resolve correctly.
 */
export function createProjectTagRoutes({
  db,
  rbacService,
}: {
  db: Database;
  rbacService: RbacService;
}) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST /api/projects/:id/tags - Assign tag to project
  app.post('/', async (c) => {
    const projectId = c.req.param('id') as string;

    if (!isValidId(projectId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid project ID' } }, 400);
    }

    const auth = c.get('auth');
    const denied = await requireProjectRole(
      auth,
      rbacService,
      projectId,
      'agent_operator',
      'Requires agent_operator role on project'
    );
    if (denied) return denied;

    const parsed = await parseJsonBody(c, assignTagSchema);
    if (!parsed.ok) return parsed.response;

    // Verify tag belongs to a team that owns this project
    const tagRecord = await db
      .select({ teamId: tags.teamId })
      .from(tags)
      .where(eq(tags.id, parsed.data.tagId));

    const foundTagForProject = tagRecord[0];
    if (!foundTagForProject) {
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Tag not found' } }, 404);
    }

    const teamOwnsProject = await db
      .select({ teamId: teamProjects.teamId })
      .from(teamProjects)
      .where(
        and(
          eq(teamProjects.teamId, foundTagForProject.teamId),
          eq(teamProjects.projectId, projectId)
        )
      );

    if (teamOwnsProject.length === 0) {
      return json(
        {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Tag does not belong to a team that owns this project',
          },
        },
        403
      );
    }

    try {
      await db
        .insert(projectTags)
        .values({ projectId, tagId: parsed.data.tagId })
        .onConflictDoNothing();

      return json({
        ok: true,
        data: { projectId, tagId: parsed.data.tagId, assignedAt: new Date().toISOString() },
      });
    } catch (error) {
      log.error('Failed to assign tag to project', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to assign tag' } }, 500);
    }
  });

  // DELETE /api/projects/:id/tags/:tagId - Remove tag from project
  app.delete('/:tagId', async (c) => {
    const projectId = c.req.param('id') as string;
    const tagId = c.req.param('tagId');

    if (!isValidId(projectId) || !isValidId(tagId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');
    const denied = await requireProjectRole(
      auth,
      rbacService,
      projectId,
      'agent_operator',
      'Requires agent_operator role on project'
    );
    if (denied) return denied;

    try {
      await db
        .delete(projectTags)
        .where(and(eq(projectTags.projectId, projectId), eq(projectTags.tagId, tagId)));
      return json({ ok: true, data: { removed: true } });
    } catch (error) {
      log.error('Failed to remove tag from project', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to remove tag' } }, 500);
    }
  });

  return app;
}

/**
 * Task tag assignment routes.
 * Mounted at /api/tasks/:id/tags so paths resolve correctly.
 */
export function createTaskTagRoutes({
  db,
  rbacService,
}: {
  db: Database;
  rbacService: RbacService;
}) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST /api/tasks/:id/tags - Assign tag to task
  app.post('/', async (c) => {
    const taskId = c.req.param('id') as string;

    if (!isValidId(taskId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid task ID' } }, 400);
    }

    // Look up the task's projectId (needed for both auth and cross-team validation)
    const taskRows = await db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    const foundTask = taskRows[0];
    if (!foundTask) {
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    }

    const auth = c.get('auth');
    const denied = await requireProjectRole(
      auth,
      rbacService,
      foundTask.projectId,
      'agent_operator',
      'Requires agent_operator role on project'
    );
    if (denied) return denied;

    const parsed = await parseJsonBody(c, assignTagSchema);
    if (!parsed.ok) return parsed.response;

    // Verify tag belongs to a team that owns this task's project
    const tagRecord = await db
      .select({ teamId: tags.teamId })
      .from(tags)
      .where(eq(tags.id, parsed.data.tagId));

    const foundTagForTask = tagRecord[0];
    if (!foundTagForTask) {
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Tag not found' } }, 404);
    }

    const teamOwnsProject = await db
      .select({ teamId: teamProjects.teamId })
      .from(teamProjects)
      .where(
        and(
          eq(teamProjects.teamId, foundTagForTask.teamId),
          eq(teamProjects.projectId, foundTask.projectId)
        )
      );

    if (teamOwnsProject.length === 0) {
      return json(
        {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: "Tag does not belong to a team that owns this task's project",
          },
        },
        403
      );
    }

    try {
      await db.insert(taskTags).values({ taskId, tagId: parsed.data.tagId }).onConflictDoNothing();

      return json({
        ok: true,
        data: { taskId, tagId: parsed.data.tagId, assignedAt: new Date().toISOString() },
      });
    } catch (error) {
      log.error('Failed to assign tag to task', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to assign tag' } }, 500);
    }
  });

  // DELETE /api/tasks/:id/tags/:tagId - Remove tag from task
  app.delete('/:tagId', async (c) => {
    const taskId = c.req.param('id') as string;
    const tagId = c.req.param('tagId');

    if (!isValidId(taskId) || !isValidId(tagId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');
    if (auth.authMethod !== 'dev') {
      const taskRows = await db
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.id, taskId));
      const foundTask = taskRows[0];
      if (!foundTask) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
      }
      const denied = await requireProjectRole(
        auth,
        rbacService,
        foundTask.projectId,
        'agent_operator',
        'Requires agent_operator role on project'
      );
      if (denied) return denied;
    }

    try {
      await db.delete(taskTags).where(and(eq(taskTags.taskId, taskId), eq(taskTags.tagId, tagId)));
      return json({ ok: true, data: { removed: true } });
    } catch (error) {
      log.error('Failed to remove tag from task', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to remove tag' } }, 500);
    }
  });

  return app;
}
