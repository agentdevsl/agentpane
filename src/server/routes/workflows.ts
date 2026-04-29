/**
 * Workflow routes
 *
 * Thin route handlers that delegate to WorkflowService.
 */

import { Hono } from 'hono';
import { createWorkflowSchema } from '../../lib/api/schemas.js';
import type { WorkflowService } from '../../services/workflow.service.js';
import { json, parseLimit, parseOffset, validateIdParam } from '../shared.js';
import { parseJsonBody, updateWorkflowSchema } from '../validation.js';

interface WorkflowsDeps {
  workflowService: WorkflowService;
}

export function createWorkflowsRoutes({ workflowService }: WorkflowsDeps) {
  const app = new Hono();

  // GET /api/workflows
  app.get('/', async (c) => {
    const limit = parseLimit(c);
    const offset = parseOffset(c);
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
  // AR-012: Uses Zod validation via createWorkflowSchema from schemas.ts
  app.post('/', async (c) => {
    const parsed = await parseJsonBody(c, createWorkflowSchema);
    if (!parsed.ok) {
      return parsed.response;
    }

    const body = parsed.data;

    const result = await workflowService.create({
      name: body.name,
      description: body.description,
      nodes: body.nodes,
      edges: body.edges,
      viewport: body.viewport,
      status: body.status,
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
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

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
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const parsed = await parseJsonBody(c, updateWorkflowSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const result = await workflowService.update(id, {
      name: body.name,
      description: body.description,
      nodes: body.nodes,
      edges: body.edges,
      viewport: body.viewport,
      status: body.status,
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
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

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
