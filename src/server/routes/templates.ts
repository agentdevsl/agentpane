/**
 * Template routes
 */

import { Hono } from 'hono';
import type { TemplateService } from '../../services/template.service.js';
import { errorResponse, json, parseLimit, validateIdParam } from '../shared.js';
import { createTemplateSchema, parseJsonBody, updateTemplateSchema } from '../validation.js';

interface TemplatesDeps {
  templateService: TemplateService;
}

export function createTemplatesRoutes({ templateService }: TemplatesDeps) {
  const app = new Hono();

  // GET /api/templates
  app.get('/', async (c) => {
    const scope = c.req.query('scope') as 'org' | 'codespace' | undefined;
    const codespaceId = c.req.query('codespaceId') ?? undefined;
    const limit = parseLimit(c);

    const result = await templateService.list({ scope, codespaceId, limit });

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({
      ok: true,
      data: {
        items: result.value,
        nextCursor: null,
        hasMore: false,
        totalCount: result.value.length,
      },
    });
  });

  // POST /api/templates
  app.post('/', async (c) => {
    const parsed = await parseJsonBody(c, createTemplateSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const result = await templateService.create({
      name: body.name,
      description: body.description,
      scope: body.scope,
      githubUrl: body.githubUrl,
      branch: body.branch,
      configPath: body.configPath,
      codespaceIds: body.codespaceIds ?? (body.codespaceId ? [body.codespaceId] : undefined),
    });

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value }, 201);
  });

  // POST /api/templates/:id/sync
  app.post('/:id/sync', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await templateService.sync(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value });
  });

  // GET /api/templates/:id
  app.get('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await templateService.getById(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value });
  });

  // PATCH /api/templates/:id
  app.patch('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const parsed = await parseJsonBody(c, updateTemplateSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const result = await templateService.update(id, {
      name: body.name,
      description: body.description,
      branch: body.branch,
      configPath: body.configPath,
      codespaceIds: body.codespaceIds,
    });

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value });
  });

  // DELETE /api/templates/:id
  app.delete('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await templateService.delete(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: null });
  });

  return app;
}
