/**
 * Codespace Folder routes
 *
 * Thin route handlers that delegate to ProjectFolderService.
 *
 * arch29-W3-D (F12-06): renamed from `project-folders.ts` to align the API
 * surface with the codespace naming used in CLAUDE.md. The DB schema and
 * service still carry the `projectFolder` name (the entity is a
 * "folder of codespaces" — distinct from a single codespace) so the rename
 * is scoped to the public API mount path and route file. The 308 redirect
 * from `/api/project-folders/*` is registered in `router.ts` for one-release
 * backward compatibility.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthContext } from '../../lib/api/auth-middleware.js';
import { slugify } from '../../lib/utils/slugify.js';
import type { ProjectFolderService } from '../../services/project-folder.service.js';
import { json, validateIdParam } from '../shared.js';
import { parseJsonBody } from '../validation.js';

// Validation schemas — internal to this route module.
const createCodespaceFolderSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  slug: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  icon: z.string().max(100).optional(),
  color: z.string().max(50).optional(),
});

const updateCodespaceFolderSchema = z
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

interface CodespaceFoldersDeps {
  projectFolderService: ProjectFolderService;
}

export function createCodespaceFoldersRoutes({ projectFolderService }: CodespaceFoldersDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET /api/codespace-folders
  app.get('/', async (c) => {
    const teamId = c.req.query('teamId') ?? undefined;

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
  });

  // POST /api/codespace-folders
  app.post('/', async (c) => {
    const parsed = await parseJsonBody(c, createCodespaceFolderSchema);
    if (!parsed.ok) return parsed.response;

    const slug = parsed.data.slug ?? slugify(parsed.data.name, 200);

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
  });

  // GET /api/codespace-folders/:id
  app.get('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await projectFolderService.getById(id);

    if (!result.ok) {
      return json(
        { ok: false, error: { code: 'NOT_FOUND', message: 'Codespace folder not found' } },
        404
      );
    }

    return json({ ok: true, data: result.value });
  });

  // PATCH /api/codespace-folders/:id
  app.patch('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const parsed = await parseJsonBody(c, updateCodespaceFolderSchema);
    if (!parsed.ok) return parsed.response;

    const result = await projectFolderService.update(id, parsed.data);

    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.status
      );
    }

    return json({ ok: true, data: result.value });
  });

  // DELETE /api/codespace-folders/:id
  app.delete('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await projectFolderService.delete(id);

    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.status
      );
    }

    return json({ ok: true, data: { deleted: true } });
  });

  // GET /api/codespace-folders/:id/codespaces
  app.get('/:id/codespaces', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

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
  });

  // GET /api/codespace-folders/:id/summary
  app.get('/:id/summary', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await projectFolderService.getSummary(id);

    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.status
      );
    }

    return json({ ok: true, data: result.value });
  });

  return app;
}
