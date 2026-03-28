/**
 * Agent routes
 */

import { Hono } from 'hono';
import type { AgentConfig } from '../../db/schema';
import type { AgentService } from '../../services/agent.service.js';
import { errorResponse, isValidId, json, requireQueryId, validateIdParam } from '../shared.js';
import { createAgentSchema, parseJsonBody } from '../validation.js';

interface AgentsDeps {
  agentService: AgentService;
}

export function createAgentsRoutes({ agentService }: AgentsDeps) {
  const app = new Hono();

  // GET /api/agents
  app.get('/', async (c) => {
    const { id: codespaceId, error: csError } = requireQueryId(c, 'codespaceId');
    if (csError) return csError;

    const result = await agentService.list(codespaceId);

    if (!result.ok) {
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list agents' } },
        500
      );
    }

    return json({ ok: true, data: result.value });
  });

  // POST /api/agents
  app.post('/', async (c) => {
    const parsed = await parseJsonBody(c, createAgentSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const result = await agentService.create({
      codespaceId: body.codespaceId,
      name: body.name,
      type: body.type,
      config: (body.config as AgentConfig) ?? null,
    });

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value }, 201);
  });

  // GET /api/agents/:id
  app.get('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await agentService.getById(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value });
  });

  // PATCH /api/agents/:id
  app.patch('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    let body: { config?: Partial<AgentConfig> } & Partial<AgentConfig>;
    try {
      body = await c.req.json();
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    const updateInput = body.config ?? body;
    if (!updateInput || Object.keys(updateInput).length === 0) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'config is required' } },
        400
      );
    }

    const result = await agentService.update(id, updateInput);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value });
  });

  // DELETE /api/agents/:id
  app.delete('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await agentService.delete(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: { deleted: true } });
  });

  // POST /api/agents/:id/start
  app.post('/:id/start', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    let body: { taskId?: string } | null = null;
    try {
      if (c.req.header('Content-Type')?.includes('application/json')) {
        body = await c.req.json();
      }
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    if (body?.taskId && !isValidId(body.taskId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid taskId format' } },
        400
      );
    }

    const result = await agentService.start(id, body?.taskId);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value });
  });

  // GET /api/agents/:id/status
  app.get('/:id/status', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await agentService.getById(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: { status: result.value.status } });
  });

  // POST /api/agents/:id/stop
  app.post('/:id/stop', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await agentService.stop(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: { stopped: true } });
  });

  // POST /api/agents/:id/pause
  app.post('/:id/pause', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await agentService.pause(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: { paused: true } });
  });

  // POST /api/agents/:id/resume
  app.post('/:id/resume', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    let body: { feedback?: string } | null = null;
    try {
      if (c.req.header('Content-Type')?.includes('application/json')) {
        body = await c.req.json();
      }
    } catch {
      return json(
        { ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON in request body' } },
        400
      );
    }

    const result = await agentService.resume(id, body?.feedback);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value });
  });

  return app;
}
