/**
 * Project Folder routes
 *
 * Thin route handlers that delegate to ProjectFolderService.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext } from '../../lib/api/auth-middleware.js';
import { createLogger } from '../../lib/logging/logger.js';
import { slugify } from '../../lib/utils/slugify.js';
import type { ProjectFolderService } from '../../services/project-folder.service.js';
import { isValidId, json } from '../shared.js';
import { parseJsonBody } from '../validation.js';

const logger = createLogger('routes:project-folders');

// Validation schemas
const createProjectFolderSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  slug: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  icon: z.string().max(100).optional(),
  color: z.string().max(50).optional(),
});

const updateProjectFolderSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    slug: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    icon: z.string().max(100).optional(),
    color: z.string().max(50).optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

interface ProjectFoldersDeps {
  projectFolderService: ProjectFolderService;
}

export function createProjectFoldersRoutes({ projectFolderService }: ProjectFoldersDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET /api/project-folders
  app.get('/', async (c) => {
    const teamId = c.req.query('teamId') ?? undefined;

    try {
      const result = await projectFolderService.list({ teamId });

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({
        ok: true,
        data: {
          items: result.value.items,
          totalCount: result.value.total,
        },
      });
    } catch (error) {
      logger.error('List project folders error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list project folders' } },
        500
      );
    }
  });

  // POST /api/project-folders
  app.post('/', async (c) => {
    const parsed = await parseJsonBody(c, createProjectFolderSchema);
    if (!parsed.ok) return parsed.response;

    const slug = parsed.data.slug ?? slugify(parsed.data.name, 200);

    try {
      const result = await projectFolderService.create({
        name: parsed.data.name,
        slug,
        description: parsed.data.description,
        icon: parsed.data.icon,
        color: parsed.data.color,
      });

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: result.value }, 201);
    } catch (error) {
      logger.error('Create project folder error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create project folder' } },
        500
      );
    }
  });

  // GET /api/project-folders/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await projectFolderService.getById(id);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Project folder not found' } },
          404
        );
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      logger.error('Get project folder error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get project folder' } },
        500
      );
    }
  });

  // PATCH /api/project-folders/:id
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    const parsed = await parseJsonBody(c, updateProjectFolderSchema);
    if (!parsed.ok) return parsed.response;

    try {
      const result = await projectFolderService.update(id, parsed.data);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      logger.error('Update project folder error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update project folder' } },
        500
      );
    }
  });

  // DELETE /api/project-folders/:id
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await projectFolderService.delete(id);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: { deleted: true } });
    } catch (error) {
      logger.error('Delete project folder error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to delete project folder' } },
        500
      );
    }
  });

  // GET /api/project-folders/:id/codespaces
  app.get('/:id/codespaces', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await projectFolderService.listCodespaces(id);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({
        ok: true,
        data: {
          items: result.value,
          totalCount: result.value.length,
        },
      });
    } catch (error) {
      logger.error('List folder codespaces error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list codespaces in folder' } },
        500
      );
    }
  });

  // GET /api/project-folders/:id/summary
  app.get('/:id/summary', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await projectFolderService.getSummary(id);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: result.error.code, message: result.error.message } },
          result.error.status
        );
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      logger.error('Get folder summary error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get folder summary' } },
        500
      );
    }
  });

  return app;
}
