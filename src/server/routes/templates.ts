/**
 * Template routes
 */

import { Hono } from 'hono';
import type { TemplateService } from '../../services/template.service.js';
import { isValidId, json } from '../shared.js';

interface TemplatesDeps {
  templateService: TemplateService;
}

export function createTemplatesRoutes({ templateService }: TemplatesDeps) {
  const app = new Hono();

  // GET /api/templates
  app.get('/', async (c) => {
    const scope = c.req.query('scope') as 'org' | 'project' | undefined;
    const projectId = c.req.query('projectId') ?? undefined;
    const limit = parseInt(c.req.query('limit') ?? '50', 10);

    try {
      const result = await templateService.list({ scope, projectId, limit });

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
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
    } catch (error) {
      console.error('[Templates] List error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list templates' } },
        500
      );
    }
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
      projectId?: string;
      projectIds?: string[];
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
    if (!body.scope || !['org', 'project'].includes(body.scope)) {
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

    try {
      const result = await templateService.create({
        name: body.name,
        description: body.description,
        scope: body.scope as 'org' | 'project',
        githubUrl: body.githubUrl,
        branch: body.branch,
        configPath: body.configPath,
        projectIds: body.projectIds ?? (body.projectId ? [body.projectId] : undefined),
      });

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: result.value }, 201);
    } catch (error) {
      console.error('[Templates] Create error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create template' } },
        500
      );
    }
  });

  // POST /api/templates/:id/sync
  app.post('/:id/sync', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid template ID format' } },
        400
      );
    }

    try {
      const result = await templateService.sync(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      console.error('[Templates] Sync error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to sync template' } },
        500
      );
    }
  });

  // GET /api/templates/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid template ID format' } },
        400
      );
    }

    try {
      const result = await templateService.getById(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      console.error('[Templates] Get error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get template' } },
        500
      );
    }
  });

  // PATCH /api/templates/:id
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid template ID format' } },
        400
      );
    }

    let body: {
      name?: string;
      description?: string;
      branch?: string;
      configPath?: string;
      projectIds?: string[];
    };
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    try {
      const result = await templateService.update(id, {
        name: body.name,
        description: body.description,
        branch: body.branch,
        configPath: body.configPath,
        projectIds: body.projectIds,
      });

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      console.error('[Templates] Update error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update template' } },
        500
      );
    }
  });

  // DELETE /api/templates/:id
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid template ID format' } },
        400
      );
    }

    try {
      const result = await templateService.delete(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: null });
    } catch (error) {
      console.error('[Templates] Delete error:', error);
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to delete template' } },
        500
      );
    }
  });

  return app;
}
