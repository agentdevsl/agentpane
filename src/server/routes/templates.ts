/**
 * Template routes
 */

import { Hono } from 'hono';
import type { TemplateService } from '../../services/template.service.js';
import { errorResponse, json, parseLimit, validateIdParam } from '../shared.js';

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
    let body: {
      name?: string;
      description?: string;
      scope?: string;
      githubUrl?: string;
      branch?: string;
      configPath?: string;
      codespaceId?: string;
      codespaceIds?: string[];
    };
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    // Validate required fields
    if (!body.name) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'name is required' } },
        400
      );
    }
    if (!body.scope || !['org', 'codespace'].includes(body.scope)) {
      return json(
        {
          ok: false,
          error: { code: 'MISSING_PARAMS', message: 'scope must be "org" or "project"' },
        },
        400
      );
    }
    if (!body.githubUrl) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'githubUrl is required' } },
        400
      );
    }

    const result = await templateService.create({
      name: body.name,
      description: body.description,
      scope: body.scope as 'org' | 'codespace',
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

    let body: {
      name?: string;
      description?: string;
      branch?: string;
      configPath?: string;
      codespaceIds?: string[];
    };
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

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
