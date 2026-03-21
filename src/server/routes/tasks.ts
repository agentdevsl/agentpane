/**
 * Task routes
 */

import { Hono } from 'hono';
import { createLogger } from '../../lib/logging/logger.js';
import type { TaskService } from '../../services/task.service.js';
import { isValidId, json } from '../shared.js';
import {
  createTaskSchema,
  moveTaskSchema,
  parseBody,
  taskColumnSchema,
  updateTaskSchema,
} from '../validation.js';

const logger = createLogger('routes:tasks');

interface TasksDeps {
  taskService: TaskService;
}

export function createTasksRoutes({ taskService }: TasksDeps) {
  const app = new Hono();

  // GET /api/tasks
  app.get('/', async (c) => {
    const codespaceId = c.req.query('codespaceId');
    const rawColumn = c.req.query('column');
    // EH-014: Validate column query param against taskColumnSchema instead of bare cast
    let column: 'backlog' | 'queued' | 'in_progress' | 'waiting_approval' | 'verified' | undefined;
    if (rawColumn !== undefined) {
      const parsed = taskColumnSchema.safeParse(rawColumn);
      if (!parsed.success) {
        return json(
          {
            ok: false,
            error: {
              code: 'INVALID_PARAMS',
              message: `Invalid column value: "${rawColumn}". Must be one of: backlog, queued, in_progress, waiting_approval, verified`,
            },
          },
          400
        );
      }
      column = parsed.data;
    }
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    if (!codespaceId) {
      return json(
        { ok: false, error: { code: 'MISSING_PARAMS', message: 'codespaceId is required' } },
        400
      );
    }

    if (!isValidId(codespaceId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid codespaceId format' } },
        400
      );
    }

    try {
      const result = await taskService.list(codespaceId, { column, limit, offset });

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
      logger.error('List error', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to list tasks' } }, 500);
    }
  });

  // POST /api/tasks
  app.post('/', async (c) => {
    try {
      const rawBody = await c.req.json();
      const parsed = parseBody(createTaskSchema, rawBody);
      if (!parsed.ok) return parsed.response;
      const body = parsed.data;

      const result = await taskService.create({
        codespaceId: body.codespaceId,
        title: body.title,
        description: body.description,
        labels: body.labels,
        priority: body.priority,
      });

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: result.value }, 201);
    } catch (error) {
      logger.error('Create error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create task' } },
        500
      );
    }
  });

  // GET /api/tasks/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await taskService.getById(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      logger.error('Get error', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to get task' } }, 500);
    }
  });

  // PUT /api/tasks/:id
  app.put('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const rawBody = await c.req.json();
      const parsed = parseBody(updateTaskSchema, rawBody);
      if (!parsed.ok) return parsed.response;
      const body = parsed.data;

      const result = await taskService.update(id, {
        title: body.title,
        description: body.description,
        labels: body.labels,
        priority: body.priority,
      });

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      logger.error('Update error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update task' } },
        500
      );
    }
  });

  // DELETE /api/tasks/:id
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await taskService.delete(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: null });
    } catch (error) {
      logger.error('Delete error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to delete task' } },
        500
      );
    }
  });

  // GET /api/tasks/:id/diff - Get diff for a task
  app.get('/:id/diff', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await taskService.getDiff(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      logger.error('GetDiff error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get task diff' } },
        500
      );
    }
  });

  // PATCH /api/tasks/:id/move - Move task to different column
  // When moving to in_progress, optionally auto-start an agent
  app.patch('/:id/move', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const rawBody = await c.req.json();
      const parsed = parseBody(moveTaskSchema, rawBody);
      if (!parsed.ok) return parsed.response;
      const body = parsed.data;

      // Move the task - this will trigger container agent if sandbox is enabled for the project
      const result = await taskService.moveColumn(id, body.column, body.position);
      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      const { task: updatedTask, agentError } = result.value;

      // If moving to in_progress, check if we need to start host-side agent as fallback
      // (container agent is auto-triggered by taskService.moveColumn if sandbox is enabled)
      const shouldStartHostAgent = body.column === 'in_progress' && body.startAgent !== false;

      if (shouldStartHostAgent) {
      }

      // Return success for the move, but include agent error info if present
      if (agentError) {
        logger.error(`Failed to start agent for task ${id}`, { data: { agentError } });
        return json({
          ok: true,
          data: { task: updatedTask, agentError },
        });
      }

      return json({ ok: true, data: { task: updatedTask } });
    } catch (error) {
      logger.error('Move error', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to move task' } }, 500);
    }
  });

  // POST /api/tasks/:id/approve-plan - Approve a pending plan and start execution
  app.post('/:id/approve-plan', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await taskService.approvePlan(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: { approved: true } });
    } catch (error) {
      logger.error('ApprovePlan error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to approve plan' } },
        500
      );
    }
  });

  // POST /api/tasks/:id/reject-plan - Reject a pending plan
  app.post('/:id/reject-plan', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      // Parse optional rejection reason from body
      let reason: string | undefined;
      try {
        const body = (await c.req.json()) as { reason?: string };
        reason = typeof body.reason === 'string' ? body.reason : undefined;
      } catch {
        // No body or invalid JSON — reason is optional
      }

      const result = await taskService.rejectPlan(id, reason);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: { rejected: true } });
    } catch (error) {
      logger.error('RejectPlan error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to reject plan' } },
        500
      );
    }
  });

  // POST /api/tasks/:id/stop-agent - Stop a running container agent for a task
  app.post('/:id/stop-agent', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID format' } }, 400);
    }

    try {
      const result = await taskService.stopAgent(id);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status);
      }

      return json({ ok: true, data: { stopped: true } });
    } catch (error) {
      logger.error('StopAgent error', { error });
      return json({ ok: false, error: { code: 'DB_ERROR', message: 'Failed to stop agent' } }, 500);
    }
  });

  return app;
}
