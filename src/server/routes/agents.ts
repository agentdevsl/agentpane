/**
 * Agent routes
 */

import { Hono } from 'hono';
import type { AgentConfig } from '../../db/schema';
import { AGENT_TYPES, type AgentType } from '../../db/schema';
import { createLogger } from '../../lib/logging/logger.js';
import type { AgentService } from '../../services/agent.service.js';
import { isValidId, json } from '../shared.js';
import { createAgentSchema, parseJsonBody } from '../validation.js';

const log = createLogger('agent-routes');

interface AgentsDeps {
  agentService: AgentService;
}

export function createAgentsRoutes({ agentService }: AgentsDeps) {
  const app = new Hono();

  // GET /api/agents
  app.get('/', async (c) => {
    const projectId = c.req.query('projectId');

    if (!projectId) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'projectId is required' } },
        400
      );
    }

    if (!isValidId(projectId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid projectId format' } },
        400
      );
    }

    try {
      const result = await agentService.list(projectId);

      if (!result.ok) {
        return json(
          { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list agents' } },
          500
        );
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('List error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list agents' } },
        500
      );
    }
  });

  // POST /api/agents
  app.post('/', async (c) => {
    const parsed = await parseJsonBody(c, createAgentSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    try {
      const result = await agentService.create({
        projectId: body.projectId,
        name: body.name,
        type: body.type,
        config: body.config,
      });

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 400);
      }

      return json({ ok: true, data: result.value }, 201);
    } catch (error) {
      log.error('Create error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create agent' } },
        500
      );
    }
  });

  // GET /api/agents/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await agentService.getById(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 404);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Get error', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to get agent' } }, 500);
    }
  });

  // PATCH /api/agents/:id
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

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

    try {
      const result = await agentService.update(id, updateInput);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 400);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Update error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update agent' } },
        500
      );
    }
  });

  // DELETE /api/agents/:id
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await agentService.delete(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 400);
      }

      return json({ ok: true, data: { deleted: true } });
    } catch (error) {
      log.error('Delete error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to delete agent' } },
        500
      );
    }
  });

  // POST /api/agents/:id/start
  app.post('/:id/start', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

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

    try {
      const result = await agentService.start(id, body?.taskId);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 400);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Start error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to start agent' } },
        500
      );
    }
  });

  // GET /api/agents/:id/status
  app.get('/:id/status', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await agentService.getById(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 404);
      }

      return json({ ok: true, data: { status: result.value.status } });
    } catch (error) {
      log.error('Status error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get agent status' } },
        500
      );
    }
  });

  // POST /api/agents/:id/stop
  app.post('/:id/stop', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await agentService.stop(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 400);
      }

      return json({ ok: true, data: { stopped: true } });
    } catch (error) {
      log.error('Stop error', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to stop agent' } }, 500);
    }
  });

  // POST /api/agents/:id/pause
  app.post('/:id/pause', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await agentService.pause(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 400);
      }

      return json({ ok: true, data: { paused: true } });
    } catch (error) {
      log.error('Pause error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to pause agent' } },
        500
      );
    }
  });

  // POST /api/agents/:id/resume
  app.post('/:id/resume', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

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

    try {
      const result = await agentService.resume(id, body?.feedback);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 400);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Resume error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to resume agent' } },
        500
      );
    }
  });

  return app;
}
