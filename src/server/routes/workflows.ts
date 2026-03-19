/**
 * Workflow routes
 *
 * Thin route handlers that delegate to WorkflowService.
 */

import { Hono } from 'hono';
import type { WorkflowService } from '../../services/workflow.service.js';
import { isValidId, json } from '../shared.js';

interface WorkflowsDeps {
  workflowService: WorkflowService;
}

export function createWorkflowsRoutes({ workflowService }: WorkflowsDeps) {
  const app = new Hono();

  // GET /api/workflows
  app.get('/', async (c) => {
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);
    const status = c.req.query('status') as 'draft' | 'published' | 'archived' | undefined;
    const search = c.req.query('search');

    const result = await workflowService.list({ limit, offset, status, search });

    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.status
      );
    }

    return json({ ok: true, data: result.value });
  });

  // POST /api/workflows
  app.post('/', async (c) => {
    let body: {
      name: string;
      description?: string;
      nodes?: unknown[];
      edges?: unknown[];
      viewport?: { x: number; y: number; zoom: number };
      status?: string;
      tags?: string[];
      sourceTemplateId?: string;
      sourceTemplateName?: string;
      thumbnail?: string;
      aiGenerated?: boolean;
      aiModel?: string;
      aiConfidence?: number;
    };
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    if (!body.name) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'Name is required' } },
        400
      );
    }

    const result = await workflowService.create({
      name: body.name,
      description: body.description,
      nodes: body.nodes,
      edges: body.edges,
      viewport: body.viewport,
      status: body.status as 'draft' | 'published' | 'archived' | undefined,
      tags: body.tags,
      sourceTemplateId: body.sourceTemplateId,
      sourceTemplateName: body.sourceTemplateName,
      thumbnail: body.thumbnail,
      aiGenerated: body.aiGenerated,
      aiModel: body.aiModel,
      aiConfidence: body.aiConfidence,
    });

    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.status
      );
    }

    return json({ ok: true, data: result.value }, 201);
  });

  // GET /api/workflows/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid workflow ID format' } },
        400
      );
    }

    const result = await workflowService.getById(id);

    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.status
      );
    }

    return json({ ok: true, data: result.value });
  });

  // PATCH /api/workflows/:id
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid workflow ID format' } },
        400
      );
    }

    let body: {
      name?: string;
      description?: string;
      nodes?: unknown[];
      edges?: unknown[];
      viewport?: { x: number; y: number; zoom: number };
      status?: string;
      tags?: string[];
      sourceTemplateId?: string | null;
      sourceTemplateName?: string | null;
      thumbnail?: string | null;
      aiGenerated?: boolean;
      aiModel?: string | null;
      aiConfidence?: number | null;
    };
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    const result = await workflowService.update(id, {
      name: body.name,
      description: body.description,
      nodes: body.nodes,
      edges: body.edges,
      viewport: body.viewport,
      status: body.status as 'draft' | 'published' | 'archived' | undefined,
      tags: body.tags,
      sourceTemplateId: body.sourceTemplateId,
      sourceTemplateName: body.sourceTemplateName,
      thumbnail: body.thumbnail,
      aiGenerated: body.aiGenerated,
      aiModel: body.aiModel,
      aiConfidence: body.aiConfidence,
    });

    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.status
      );
    }

    return json({ ok: true, data: result.value });
  });

  // DELETE /api/workflows/:id
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid workflow ID format' } },
        400
      );
    }

    const result = await workflowService.delete(id);

    if (!result.ok) {
      return json(
        { ok: false, error: { code: result.error.code, message: result.error.message } },
        result.error.status
      );
    }

    return json({ ok: true, data: null });
  });

  return app;
}
