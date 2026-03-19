/**
 * Project routes
 *
 * Thin route handlers that delegate to ProjectService.
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { agents } from '../../db/schema';
import type { ProjectService } from '../../services/project.service.js';
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
  projectService: ProjectService;
  db: Database;
}

export function createProjectsRoutes({ projectService, db }: ProjectsDeps) {
  const app = new Hono();

  // GET /api/projects
  app.get('/', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '24', 10);

    try {
      const result = await projectService.list({ limit });

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({
        ok: true,
        data: {
          items: result.value.map((p) => ({
            id: p.id,
            name: p.name,
            path: p.path,
            description: p.description,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          })),
          nextCursor: null,
          hasMore: false,
          totalCount: result.value.length,
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
      const result = await projectService.create({
        path: parsed.data.path,
        name: parsed.data.name,
        description: parsed.data.description,
      });

      if (!result.ok) {
        // Map service errors to API-compatible error codes
        const statusCode = result.error.status;
        const code = result.error.code === 'PROJECT_PATH_EXISTS' ? 'DUPLICATE' : result.error.code;
        return json({ ok: false, error: { code, message: result.error.message } }, statusCode);
      }

      const created = result.value;
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
      const result = await projectService.listWithSummaries({ limit });

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      const summaries = result.value;

      return json({
        ok: true,
        data: {
          items: summaries.map((s) => ({
            project: {
              id: s.project.id,
              name: s.project.name,
              path: s.project.path,
              description: s.project.description,
              createdAt: s.project.createdAt,
              updatedAt: s.project.updatedAt,
            },
            taskCounts: {
              backlog: s.taskCounts.backlog,
              queued: 0,
              inProgress: s.taskCounts.inProgress,
              waitingApproval: s.taskCounts.waitingApproval,
              verified: s.taskCounts.verified,
              total: s.taskCounts.total,
            },
            runningAgents: s.runningAgents,
            status: s.status,
            lastActivityAt: s.lastActivityAt ?? s.project.updatedAt,
          })),
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
      const result = await projectService.getById(id);

      if (!result.ok) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
      }

      const project = result.value;
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
      const result = await projectService.update(id, {
        name: parsed.data.name,
        description: parsed.data.description,
        maxConcurrentAgents: parsed.data.maxConcurrentAgents,
        config: parsed.data.config,
      });

      if (!result.ok) {
        const statusCode = result.error.status;
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          statusCode
        );
      }

      const updated = result.value;
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
      // Get the project first (needed for file deletion path)
      const projectResult = await projectService.getById(id);
      if (!projectResult.ok) {
        return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Project not found' } }, 404);
      }

      const existing = projectResult.value;

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

      // Delete via service (handles worktree pruning and cascade)
      const deleteResult = await projectService.delete(id);
      if (!deleteResult.ok) {
        return json(
          {
            ok: false,
            error: { code: deleteResult.error.code, message: deleteResult.error.message },
          },
          deleteResult.error.status
        );
      }

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
