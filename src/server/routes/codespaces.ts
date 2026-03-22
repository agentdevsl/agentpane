/**
 * Codespace routes
 *
 * Thin route handlers that delegate to CodespaceService.
 */

import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { agents } from '../../db/schema';
import { createLogger } from '../../lib/logging/logger.js';
import type { CodespaceService } from '../../services/codespace.service.js';
import type { TemplateService } from '../../services/template.service.js';
import type { Database } from '../../types/database.js';
import { isValidId, json } from '../shared.js';

const logger = createLogger('routes:codespaces');

// Validation schemas
const createCodespaceSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  path: z.string().min(1, 'Path is required'),
  description: z.string().optional(),
  projectFolderId: z.string().min(1, 'projectFolderId is required'),
});

const updateCodespaceSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  maxConcurrentAgents: z.number().int().positive().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  projectFolderId: z.string().min(1).optional(),
});

interface CodespacesDeps {
  codespaceService: CodespaceService;
  templateService: TemplateService;
  db: Database;
}

export function createCodespacesRoutes({ codespaceService, templateService, db }: CodespacesDeps) {
  const app = new Hono();

  // GET /api/codespaces
  app.get('/', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '24', 10);

    try {
      const result = await codespaceService.list({ limit });

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
            projectFolderId: p.projectFolderId,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          })),
          nextCursor: null,
          hasMore: false,
          totalCount: result.value.length,
        },
      });
    } catch (error) {
      logger.error('List error', { error: error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list codespaces' } },
        500
      );
    }
  });

  // POST /api/codespaces
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

    const parsed = createCodespaceSchema.safeParse(body);
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

    // AR-033: Validate path at creation time, not just deletion time.
    // Ensures the path resolves to a safe location, preventing registration of system
    // directories that could later be deleted via the codespace delete endpoint.
    // We resolve the path to prevent traversal attacks (e.g., /home/user/../../../etc).
    const resolvedPath = path.resolve(parsed.data.path);
    const normalizedPath = path.normalize(resolvedPath);
    const pathComponents = normalizedPath.split(path.sep).filter(Boolean);
    // Block root-level and system directories (must have at least 3 path components)
    if (pathComponents.length < 3) {
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message:
              'Codespace path is too shallow. Must be at least 3 levels deep (e.g., /home/user/project).',
          },
        },
        400
      );
    }

    try {
      const result = await codespaceService.create({
        path: parsed.data.path,
        name: parsed.data.name,
        description: parsed.data.description,
        projectFolderId: parsed.data.projectFolderId,
      });

      if (!result.ok) {
        // Map service errors to API-compatible error codes
        const statusCode = result.error.status;
        const code =
          result.error.code === 'CODESPACE_PATH_EXISTS' ? 'DUPLICATE' : result.error.code;
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
          projectFolderId: created.projectFolderId,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
      });
    } catch (error) {
      logger.error('Create error', { error: error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create codespace' } },
        500
      );
    }
  });

  // GET /api/codespaces/summaries
  app.get('/summaries', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '24', 10);

    try {
      const result = await codespaceService.listWithSummaries({ limit });

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
            codespace: {
              id: s.codespace.id,
              name: s.codespace.name,
              path: s.codespace.path,
              description: s.codespace.description,
              projectFolderId: s.codespace.projectFolderId,
              createdAt: s.codespace.createdAt,
              updatedAt: s.codespace.updatedAt,
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
            lastActivityAt: s.lastActivityAt ?? s.codespace.updatedAt,
          })),
          nextCursor: null,
          hasMore: false,
          totalCount: summaries.length,
        },
      });
    } catch (error) {
      logger.error('List with summaries error', { error: error });
      return json(
        {
          ok: false,
          error: { code: 'DB_ERROR', message: 'Failed to list codespaces with summaries' },
        },
        500
      );
    }
  });

  // GET /api/codespaces/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await codespaceService.getById(id);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Codespace not found' } },
          404
        );
      }

      const codespace = result.value;
      return json({
        ok: true,
        data: {
          id: codespace.id,
          name: codespace.name,
          path: codespace.path,
          description: codespace.description,
          projectFolderId: codespace.projectFolderId,
          maxConcurrentAgents: codespace.maxConcurrentAgents,
          config: codespace.config,
          createdAt: codespace.createdAt,
          updatedAt: codespace.updatedAt,
        },
      });
    } catch (error) {
      logger.error('Get error', { error: error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get codespace' } },
        500
      );
    }
  });

  // PATCH /api/codespaces/:id
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

    const parsed = updateCodespaceSchema.safeParse(body);
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
      const result = await codespaceService.update(id, {
        name: parsed.data.name,
        description: parsed.data.description,
        maxConcurrentAgents: parsed.data.maxConcurrentAgents,
        config: parsed.data.config,
        projectFolderId: parsed.data.projectFolderId,
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
          projectFolderId: updated.projectFolderId,
          maxConcurrentAgents: updated.maxConcurrentAgents,
          config: updated.config,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (error) {
      logger.error('Update error', { error: error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update codespace' } },
        500
      );
    }
  });

  // DELETE /api/codespaces/:id
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const deleteFiles = c.req.query('deleteFiles') === 'true';

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      // Get the codespace first (needed for file deletion path)
      const codespaceResult = await codespaceService.getById(id);
      if (!codespaceResult.ok) {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Codespace not found' } },
          404
        );
      }

      const existing = codespaceResult.value;

      // Check if codespace has running agents
      const runningAgents = await db.query.agents.findMany({
        where: and(eq(agents.codespaceId, id), eq(agents.status, 'running')),
      });

      if (runningAgents.length > 0) {
        return json(
          {
            ok: false,
            error: {
              code: 'CODESPACE_HAS_RUNNING_AGENTS',
              message: 'Cannot delete codespace with running agents. Stop all agents first.',
            },
          },
          409
        );
      }

      // Delete via service (handles worktree pruning and cascade)
      const deleteResult = await codespaceService.delete(id);
      if (!deleteResult.ok) {
        return json(
          {
            ok: false,
            error: { code: deleteResult.error.code, message: deleteResult.error.message },
          },
          deleteResult.error.status
        );
      }

      // Optionally delete codespace files
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
          deletionBlockedReason = validationResult.reason;
        } else {
          // Safety check: ensure the path exists and is a directory
          try {
            const stats = await fs.stat(normalizedPath);
            if (stats.isDirectory()) {
              await fs.rm(normalizedPath, { recursive: true, force: true });
              filesActuallyDeleted = true;
            } else {
              // Path exists but is not a directory
              deletionBlockedReason = 'Path is not a directory';
            }
          } catch (fsError) {
            // Track the error and return filesDeleted: false
            const errorMessage = fsError instanceof Error ? fsError.message : String(fsError);
            fileDeletionError = errorMessage;
            logger.error(`Failed to delete codespace files: `);
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
      logger.error('Delete error', { error: error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to delete codespace' } },
        500
      );
    }
  });

  // GET /api/codespaces/:id/skills - List available skills for a codespace
  app.get('/:id/skills', async (c) => {
    const codespaceId = c.req.param('id');

    if (!isValidId(codespaceId)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await templateService.getMergedConfig(codespaceId);

      if (!result.ok) {
        // No templates configured for this codespace — return empty skills list
        // This is expected when a codespace has no template associations
        return json({ ok: true, data: [] });
      }

      if (result.value.skills.length === 0) {
        return json({ ok: true, data: [] });
      }

      const skills = result.value.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        sourceType: skill.sourceType,
        sourceName: skill.sourceName,
      }));

      return json({ ok: true, data: skills });
    } catch (error) {
      logger.error('List skills error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list skills' } },
        500
      );
    }
  });

  // GET /api/codespaces/:id/skills/:skillId - Get full skill content
  app.get('/:id/skills/:skillId', async (c) => {
    const codespaceId = c.req.param('id');
    const skillId = c.req.param('skillId');

    if (!isValidId(codespaceId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid codespace ID format' } },
        400
      );
    }

    if (!skillId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(skillId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid skill ID format' } },
        400
      );
    }

    try {
      const result = await templateService.getMergedConfig(codespaceId);

      if (!result.ok) {
        return json(
          {
            ok: false,
            error: { code: 'SKILL_NOT_FOUND', message: 'Skill not found' },
          },
          404
        );
      }

      const skill = result.value.skills.find((s) => s.id === skillId);

      if (!skill) {
        return json(
          {
            ok: false,
            error: { code: 'SKILL_NOT_FOUND', message: 'Skill not found' },
          },
          404
        );
      }

      return json({
        ok: true,
        data: {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          content: skill.content,
          sourceType: skill.sourceType,
          sourceName: skill.sourceName,
        },
      });
    } catch (error) {
      logger.error('Get skill error', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to get skill' } }, 500);
    }
  });

  return app;
}
