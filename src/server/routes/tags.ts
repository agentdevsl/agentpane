/**
 * Tag routes
 */

import { and, count, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { codespaceTags } from '../../db/schema/sqlite/codespace-tags';
import { codespaces } from '../../db/schema/sqlite/codespaces';
import { tags } from '../../db/schema/sqlite/tags';
import { taskTags } from '../../db/schema/sqlite/task-tags';
import { tasks } from '../../db/schema/sqlite/tasks';
import { teamProjectFolders } from '../../db/schema/sqlite/team-project-folders';
import type { AuthContext } from '../../lib/api/auth-middleware';
import { createLogger } from '../../lib/logging/logger';
import type { RbacService } from '../../services/rbac.service';
import type { Database } from '../../types/database';
import { isValidId, json, requireCodespaceRole, requireTeamRole } from '../shared';
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

    // Look up which team owns this project folder for auth
    const folderTeams = await db
      .select({ teamId: teamProjectFolders.teamId })
      .from(teamProjectFolders)
      .where(eq(teamProjectFolders.projectFolderId, parsed.data.projectFolderId));
    const ownerTeamId = folderTeams[0]?.teamId;
    if (!ownerTeamId) {
      return json(
        { ok: false, error: { code: 'NOT_FOUND', message: 'Project folder not found' } },
        404
      );
    }

    const denied = await requireTeamRole(
      auth,
      rbacService,
      ownerTeamId,
      'agent_operator',
      'Requires agent_operator role in team'
    );
    if (denied) return denied;

    try {
      const [created] = await db
        .insert(tags)
        .values({
          projectFolderId: parsed.data.projectFolderId,
          name: parsed.data.name,
          ...(parsed.data.color && { color: parsed.data.color }),
        })
        .returning();

      return json({ ok: true, data: created }, 201);
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
      // Tags are now per-folder; find all folders for this team, then their tags
      const folderIds = (
        await db
          .select({ projectFolderId: teamProjectFolders.projectFolderId })
          .from(teamProjectFolders)
          .where(eq(teamProjectFolders.teamId, teamId))
      ).map((f) => f.projectFolderId);

      const teamTags =
        folderIds.length > 0
          ? await db.select().from(tags).where(inArray(tags.projectFolderId, folderIds))
          : [];

      // Batch-fetch project and task counts to avoid N+1 queries
      const tagIds = teamTags.map((t) => t.id);

      let projectCountMap = new Map<string, number>();
      let taskCountMap = new Map<string, number>();

      if (tagIds.length > 0) {
        const [projectCounts, taskCounts] = await Promise.all([
          db
            .select({ tagId: codespaceTags.tagId, total: count() })
            .from(codespaceTags)
            .where(inArray(codespaceTags.tagId, tagIds))
            .groupBy(codespaceTags.tagId),
          db
            .select({ tagId: taskTags.tagId, total: count() })
            .from(taskTags)
            .where(inArray(taskTags.tagId, tagIds))
            .groupBy(taskTags.tagId),
        ]);

        projectCountMap = new Map(projectCounts.map((r) => [r.tagId, r.total]));
        taskCountMap = new Map(taskCounts.map((r) => [r.tagId, r.total]));
      }

      const enrichedTags = teamTags.map((tag) => ({
        ...tag,
        projectCount: projectCountMap.get(tag.id) ?? 0,
        taskCount: taskCountMap.get(tag.id) ?? 0,
      }));

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

    try {
      // Check tag existence and resolve team via project folder
      const tagRows = await db
        .select({ projectFolderId: tags.projectFolderId })
        .from(tags)
        .where(eq(tags.id, id));
      const foundTag = tagRows[0];
      if (!foundTag) {
        return json({ ok: false, error: { code: 'TAG_NOT_FOUND', message: 'Tag not found' } }, 404);
      }

      const folderTeams = await db
        .select({ teamId: teamProjectFolders.teamId })
        .from(teamProjectFolders)
        .where(eq(teamProjectFolders.projectFolderId, foundTag.projectFolderId));
      const ownerTeamId = folderTeams[0]?.teamId;
      if (!ownerTeamId) {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Tag folder has no team' } },
          404
        );
      }

      const denied = await requireTeamRole(
        auth,
        rbacService,
        ownerTeamId,
        'admin',
        'Requires admin role in team'
      );
      if (denied) return denied;

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
 * Codespace tag assignment routes.
 * Mounted at /api/codespaces/:id/tags so paths resolve correctly.
 */
export function createProjectTagRoutes({
  db,
  rbacService,
}: {
  db: Database;
  rbacService: RbacService;
}) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // POST /api/codespaces/:id/tags - Assign tag to codespace
  app.post('/', async (c) => {
    const codespaceId = c.req.param('id') as string;

    if (!isValidId(codespaceId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid codespace ID' } },
        400
      );
    }

    const auth = c.get('auth');
    const denied = await requireCodespaceRole(
      auth,
      rbacService,
      codespaceId,
      'agent_operator',
      'Requires agent_operator role on codespace'
    );
    if (denied) return denied;

    const parsed = await parseJsonBody(c, assignTagSchema);
    if (!parsed.ok) return parsed.response;

    // Verify tag belongs to a folder that owns this codespace
    const tagRecord = await db
      .select({ projectFolderId: tags.projectFolderId })
      .from(tags)
      .where(eq(tags.id, parsed.data.tagId));

    const foundTagForCodespace = tagRecord[0];
    if (!foundTagForCodespace) {
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Tag not found' } }, 404);
    }

    // Verify codespace belongs to the same project folder as the tag
    const codespaceRecord = await db
      .select({ projectFolderId: codespaces.projectFolderId })
      .from(codespaces)
      .where(eq(codespaces.id, codespaceId));

    if (codespaceRecord[0]?.projectFolderId !== foundTagForCodespace.projectFolderId) {
      return json(
        {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Tag does not belong to a folder that owns this codespace',
          },
        },
        403
      );
    }

    try {
      await db
        .insert(codespaceTags)
        .values({ codespaceId, tagId: parsed.data.tagId })
        .onConflictDoNothing();

      return json(
        {
          ok: true,
          data: {
            codespaceId,
            tagId: parsed.data.tagId,
            assignedAt: new Date().toISOString(),
          },
        },
        201
      );
    } catch (error) {
      log.error('Failed to assign tag to codespace', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to assign tag' } }, 500);
    }
  });

  // DELETE /api/codespaces/:id/tags/:tagId - Remove tag from codespace
  app.delete('/:tagId', async (c) => {
    const codespaceId = c.req.param('id') as string;
    const tagId = c.req.param('tagId') as string;

    if (!isValidId(codespaceId) || !isValidId(tagId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');
    const denied = await requireCodespaceRole(
      auth,
      rbacService,
      codespaceId,
      'agent_operator',
      'Requires agent_operator role on codespace'
    );
    if (denied) return denied;

    try {
      await db
        .delete(codespaceTags)
        .where(and(eq(codespaceTags.codespaceId, codespaceId), eq(codespaceTags.tagId, tagId)));
      return json({ ok: true, data: { removed: true } });
    } catch (error) {
      log.error('Failed to remove tag from codespace', { error });
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

    // Look up the task's codespaceId (needed for both auth and cross-team validation)
    const taskRows = await db
      .select({ codespaceId: tasks.codespaceId })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    const foundTask = taskRows[0];
    if (!foundTask) {
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    }

    const auth = c.get('auth');
    const denied = await requireCodespaceRole(
      auth,
      rbacService,
      foundTask.codespaceId,
      'agent_operator',
      'Requires agent_operator role on codespace'
    );
    if (denied) return denied;

    const parsed = await parseJsonBody(c, assignTagSchema);
    if (!parsed.ok) return parsed.response;

    // Verify tag belongs to a folder that owns this task's codespace
    const tagRecord = await db
      .select({ projectFolderId: tags.projectFolderId })
      .from(tags)
      .where(eq(tags.id, parsed.data.tagId));

    const foundTagForTask = tagRecord[0];
    if (!foundTagForTask) {
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Tag not found' } }, 404);
    }

    // Verify codespace belongs to the same project folder as the tag
    const taskCodespaceRecord = await db
      .select({ projectFolderId: codespaces.projectFolderId })
      .from(codespaces)
      .where(eq(codespaces.id, foundTask.codespaceId));

    if (taskCodespaceRecord[0]?.projectFolderId !== foundTagForTask.projectFolderId) {
      return json(
        {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: "Tag does not belong to a folder that owns this task's codespace",
          },
        },
        403
      );
    }

    try {
      await db.insert(taskTags).values({ taskId, tagId: parsed.data.tagId }).onConflictDoNothing();

      return json(
        {
          ok: true,
          data: { taskId, tagId: parsed.data.tagId, assignedAt: new Date().toISOString() },
        },
        201
      );
    } catch (error) {
      log.error('Failed to assign tag to task', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to assign tag' } }, 500);
    }
  });

  // DELETE /api/tasks/:id/tags/:tagId - Remove tag from task
  app.delete('/:tagId', async (c) => {
    const taskId = c.req.param('id') as string;
    const tagId = c.req.param('tagId') as string;

    if (!isValidId(taskId) || !isValidId(tagId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');
    const taskRows = await db
      .select({ codespaceId: tasks.codespaceId })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    const foundTask = taskRows[0];
    if (!foundTask) {
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    }
    const denied = await requireCodespaceRole(
      auth,
      rbacService,
      foundTask.codespaceId,
      'agent_operator',
      'Requires agent_operator role on codespace'
    );
    if (denied) return denied;

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
