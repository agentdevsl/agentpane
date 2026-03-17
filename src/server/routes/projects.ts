/**
 * Project routes
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { agents, projects, tasks } from '../../db/schema';
import type { Database } from '../../types/database.js';
import { isValidId, json } from '../shared.js';

// Validation schemas
const createProjectSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  path: z.string().min(1, 'Path is required'),
  description: z.string().optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  maxConcurrentAgents: z.number().int().positive().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

interface ProjectsDeps {
  db: Database;
}

export function createProjectsRoutes({ db }: ProjectsDeps) {
  const app = new Hono();

  // GET /api/projects
  app.get('/', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '24', 10);

    try {
      const items = await db.query.projects.findMany({
        orderBy: [desc(projects.updatedAt)],
        limit,
      });

      return json({
        ok: true,
        data: {
          items: items.map((p) => ({
            id: p.id,
            name: p.name,
            path: p.path,
            description: p.description,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          })),
          nextCursor: null,
          hasMore: false,
          totalCount: items.length,
        },
      });
    } catch (error) {
      console.error('[Projects] List error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list projects' } },
        500
      );
    }
  });

  // POST /api/projects
  app.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    const parsed = createProjectSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message ?? 'Invalid request',
          },
        },
        400
      );
    }

    try {
      // Check if project with this path already exists
      const existing = await db.query.projects.findFirst({
        where: eq(projects.path, parsed.data.path),
      });

      if (existing) {
        return json(
          {
            ok: false,
            error: { code: 'DUPLICATE', message: 'A project with this path already exists' },
          },
          400
        );
      }

      const [created] = await db
        .insert(projects)
        .values({
          name: parsed.data.name,
          path: parsed.data.path,
          description: parsed.data.description,
        })
        .returning();

      if (!created) {
        return json(
          { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create project' } },
          500
        );
      }

      return json({
        ok: true,
        data: {
          id: created.id,
          name: created.name,
          path: created.path,
          description: created.description,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
      });
    } catch (error) {
      console.error('[Projects] Create error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create project' } },
        500
      );
    }
  });

  // GET /api/projects/summaries
  app.get('/summaries', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '24', 10);

    try {
      // Query 1: Get all projects
      const projectList = await db.query.projects.findMany({
        orderBy: [desc(projects.updatedAt)],
        limit,
      });

      const projectIds = projectList.map((p) => p.id);

      // Short-circuit: no projects means no summaries
      if (projectIds.length === 0) {
        return json({
          ok: true,
          data: { items: [], nextCursor: null, hasMore: false, totalCount: 0 },
        });
      }

      // Query 2: Get ALL tasks for ALL projects in one query
      const allTasks = await db.query.tasks.findMany({
        where: inArray(tasks.projectId, projectIds),
      });

      // Group tasks by projectId
      const tasksByProject = new Map<string, typeof allTasks>();
      for (const task of allTasks) {
        const existing = tasksByProject.get(task.projectId);
        if (existing) {
          existing.push(task);
        } else {
          tasksByProject.set(task.projectId, [task]);
        }
      }

      // Build a lookup map of task id → title for agent task titles
      const taskTitleMap = new Map<string, string>();
      for (const task of allTasks) {
        taskTitleMap.set(task.id, task.title);
      }

      // Query 3: Get ALL active agents for ALL projects in one query
      const activeStatuses = ['starting', 'planning', 'running'] as const;
      const allActiveAgents = await db.query.agents.findMany({
        where: and(
          inArray(agents.projectId, projectIds),
          inArray(agents.status, [...activeStatuses])
        ),
      });

      // Group agents by projectId
      const agentsByProject = new Map<string, typeof allActiveAgents>();
      for (const agent of allActiveAgents) {
        const existing = agentsByProject.get(agent.projectId);
        if (existing) {
          existing.push(agent);
        } else {
          agentsByProject.set(agent.projectId, [agent]);
        }
      }

      const summaries = projectList.map((project) => {
        const projectTasks = tasksByProject.get(project.id) ?? [];

        const taskCounts = {
          backlog: projectTasks.filter((t) => t.column === 'backlog').length,
          queued: projectTasks.filter((t) => t.column === 'queued').length,
          inProgress: projectTasks.filter((t) => t.column === 'in_progress').length,
          waitingApproval: projectTasks.filter((t) => t.column === 'waiting_approval').length,
          verified: projectTasks.filter((t) => t.column === 'verified').length,
          total: projectTasks.length,
        };

        const runningAgents = agentsByProject.get(project.id) ?? [];

        // Resolve task titles from the in-memory lookup map (no extra queries)
        const agentData = runningAgents.map((agent) => ({
          id: agent.id,
          name: agent.name ?? 'Agent',
          currentTaskId: agent.currentTaskId,
          currentTaskTitle: agent.currentTaskId ? taskTitleMap.get(agent.currentTaskId) : undefined,
        }));

        // Determine project status
        let status: 'running' | 'idle' | 'needs-approval' = 'idle';
        if (runningAgents.length > 0) {
          status = 'running';
        } else if (taskCounts.waitingApproval > 0) {
          status = 'needs-approval';
        }

        // Get last activity from tasks
        const lastTask = projectTasks.sort((a, b) => {
          const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return bTime - aTime;
        })[0];

        return {
          project: {
            id: project.id,
            name: project.name,
            path: project.path,
            description: project.description,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
          taskCounts,
          runningAgents: agentData,
          status,
          lastActivityAt: lastTask?.updatedAt ?? project.updatedAt,
        };
      });

      return json({
        ok: true,
        data: {
          items: summaries,
          nextCursor: null,
          hasMore: false,
          totalCount: summaries.length,
        },
      });
    } catch (error) {
      console.error('[Projects] List with summaries error:', error);
      return json(
        {
          ok: false,
          error: { code: 'DB_ERROR', message: 'Failed to list projects with summaries' },
        },
        500
      );
    }
  });

  // GET /api/projects/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, id),
      });

      if (!project) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
      }

      return json({
        ok: true,
        data: {
          id: project.id,
          name: project.name,
          path: project.path,
          description: project.description,
          maxConcurrentAgents: project.maxConcurrentAgents,
          config: project.config,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
      });
    } catch (error) {
      console.error('[Projects] Get error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get project' } },
        500
      );
    }
  });

  // PATCH /api/projects/:id
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    const parsed = updateProjectSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message ?? 'Invalid request',
          },
        },
        400
      );
    }

    try {
      // Check if project exists
      const existing = await db.query.projects.findFirst({
        where: eq(projects.id, id),
      });

      if (!existing) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
      }

      // Build update object with only provided fields
      const updateData: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
        ...(parsed.data.name !== undefined && { name: parsed.data.name }),
        ...(parsed.data.description !== undefined && { description: parsed.data.description }),
        ...(parsed.data.maxConcurrentAgents !== undefined && {
          maxConcurrentAgents: parsed.data.maxConcurrentAgents,
        }),
        ...(parsed.data.config !== undefined && {
          config: { ...(existing.config ?? {}), ...parsed.data.config },
        }),
      };

      const [updated] = await db
        .update(projects)
        .set(updateData)
        .where(eq(projects.id, id))
        .returning();

      if (!updated) {
        return json(
          { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update project' } },
          500
        );
      }

      return json({
        ok: true,
        data: {
          id: updated.id,
          name: updated.name,
          path: updated.path,
          description: updated.description,
          maxConcurrentAgents: updated.maxConcurrentAgents,
          config: updated.config,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (error) {
      console.error('[Projects] Update error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update project' } },
        500
      );
    }
  });

  // DELETE /api/projects/:id
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const deleteFiles = c.req.query('deleteFiles') === 'true';

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      // Check if project exists
      const existing = await db.query.projects.findFirst({
        where: eq(projects.id, id),
      });

      if (!existing) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
      }

      // Check if project has running agents
      const runningAgents = await db.query.agents.findMany({
        where: and(eq(agents.projectId, id), eq(agents.status, 'running')),
      });

      if (runningAgents.length > 0) {
        return json(
          {
            ok: false,
            error: {
              code: 'PROJECT_HAS_RUNNING_AGENTS',
              message: 'Cannot delete project with running agents. Stop all agents first.',
            },
          },
          409
        );
      }

      // Delete associated tasks first (foreign key constraint)
      await db.delete(tasks).where(eq(tasks.projectId, id));

      // Delete associated agents
      await db.delete(agents).where(eq(agents.projectId, id));

      // Delete the project from database
      await db.delete(projects).where(eq(projects.id, id));

      // Optionally delete project files
      let filesActuallyDeleted = false;
      let fileDeletionError: string | undefined;
      let deletionBlockedReason: string | undefined;

      if (deleteFiles && existing.path) {
        const fs = await import('node:fs/promises');
        const { getNormalizedPath, validatePathForDeletion } = await import(
          '../../lib/utils/path-safety.js'
        );

        const normalizedPath = getNormalizedPath(existing.path);

        // Validate path safety using centralized utility
        const validationResult = validatePathForDeletion(existing.path);

        if (validationResult.safe === false) {
          console.warn(
            `[Projects] Refusing to delete path (${validationResult.code}): ${normalizedPath}`
          );
          deletionBlockedReason = validationResult.reason;
        } else {
          // Safety check: ensure the path exists and is a directory
          try {
            const stats = await fs.stat(normalizedPath);
            if (stats.isDirectory()) {
              await fs.rm(normalizedPath, { recursive: true, force: true });
              filesActuallyDeleted = true;
              console.log(`[Projects] Deleted project files at: ${normalizedPath}`);
            } else {
              // Path exists but is not a directory
              deletionBlockedReason = 'Path is not a directory';
              console.warn(`[Projects] Path is not a directory: ${normalizedPath}`);
            }
          } catch (fsError) {
            // Track the error and return filesDeleted: false
            const errorMessage = fsError instanceof Error ? fsError.message : String(fsError);
            fileDeletionError = errorMessage;
            console.error(`[Projects] Failed to delete project files: ${errorMessage}`);
          }
        }
      }

      return json({
        ok: true,
        data: {
          deleted: true,
          filesDeleted: filesActuallyDeleted,
          ...(fileDeletionError && { fileDeletionError }),
          ...(deletionBlockedReason && { reason: deletionBlockedReason }),
        },
      });
    } catch (error) {
      console.error('[Projects] Delete error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to delete project' } },
        500
      );
    }
  });

  return app;
}
