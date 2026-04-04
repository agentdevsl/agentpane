/**
 * Task routes
 */

import { Hono } from 'hono';
import { createLogger } from '../../lib/logging/logger.js';
import type { TaskService } from '../../services/task.service.js';
import {
  errorResponse,
  json,
  parseLimit,
  parseOffset,
  requireQueryId,
  validateIdParam,
} from '../shared.js';
import {
  createTaskSchema,
  moveTaskSchema,
  parseJsonBody,
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
    const { id: codespaceId, error: csError } = requireQueryId(c, 'codespaceId');
    if (csError) return csError;
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
    const limit = parseLimit(c);
    const offset = parseOffset(c);

    const result = await taskService.list(codespaceId, { column, limit, offset });

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

  // POST /api/tasks
  app.post('/', async (c) => {
    const parsed = await parseJsonBody(c, createTaskSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const result = await taskService.create({
      codespaceId: body.codespaceId,
      title: body.title,
      description: body.description,
      labels: body.labels,
      priority: body.priority,
      skillId: body.skillId,
      skillName: body.skillName,
    });

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value }, 201);
  });

  // GET /api/tasks/:id
  app.get('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await taskService.getById(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value });
  });

  // PUT /api/tasks/:id
  app.put('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const parsed = await parseJsonBody(c, updateTaskSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const result = await taskService.update(id, {
      title: body.title,
      description: body.description,
      labels: body.labels,
      priority: body.priority,
      skillId: body.skillId,
      skillName: body.skillName,
    });

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value });
  });

  // DELETE /api/tasks/:id
  app.delete('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await taskService.delete(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: null });
  });

  // GET /api/tasks/:id/diff - Get diff for a task
  app.get('/:id/diff', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await taskService.getDiff(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value });
  });

  // PATCH /api/tasks/:id/move - Move task to different column
  // When moving to in_progress, optionally auto-start an agent
  app.patch('/:id/move', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const parsed = await parseJsonBody(c, moveTaskSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    // Move the task - this will trigger container agent if sandbox is enabled for the project
    const result = await taskService.moveColumn(id, body.column, body.position);
    if (!result.ok) {
      return errorResponse(result);
    }

    const { task: updatedTask, agentError } = result.value;

    // Return success for the move, but include agent error info if present
    if (agentError) {
      logger.error(`Failed to start agent for task ${id}`, { data: { agentError } });
      return json({
        ok: true,
        data: { task: updatedTask, agentError },
      });
    }

    return json({ ok: true, data: { task: updatedTask } });
  });

  // POST /api/tasks/:id/approve-plan - Approve a pending plan and start execution
  app.post('/:id/approve-plan', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await taskService.approvePlan(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: { approved: true } });
  });

  // POST /api/tasks/:id/reject-plan - Reject a pending plan
  app.post('/:id/reject-plan', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

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
        return errorResponse(result);
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

  // POST /api/tasks/:id/approve - Approve a completed task in waiting_approval → verified
  app.post('/:id/approve', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    try {
      let approvedBy: string | undefined;
      let createMergeCommit: boolean | undefined;
      try {
        const body = (await c.req.json()) as {
          approvedBy?: string;
          createMergeCommit?: boolean;
        };
        approvedBy = typeof body.approvedBy === 'string' ? body.approvedBy : undefined;
        createMergeCommit =
          typeof body.createMergeCommit === 'boolean' ? body.createMergeCommit : undefined;
      } catch (parseErr) {
        // No body or invalid JSON — fields are optional, log for debugging
        logger.debug('Approve task: body parse skipped (fields are optional)', {
          error: parseErr,
        });
      }

      const result = await taskService.approve(id, { approvedBy, createMergeCommit });

      if (!result.ok) {
        return errorResponse(result);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      logger.error('Approve task error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to approve task' } },
        500
      );
    }
  });

  // POST /api/tasks/:id/reject - Reject a completed task in waiting_approval → backlog
  app.post('/:id/reject', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    try {
      let reason: string | undefined;
      try {
        const body = (await c.req.json()) as { reason?: string };
        reason =
          typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason : undefined;
      } catch (parseErr) {
        // No body or invalid JSON — reason is required but parse failed
        logger.debug('Reject task: body parse failed (reason is required)', {
          error: parseErr,
        });
      }

      if (!reason) {
        return json(
          {
            ok: false,
            error: {
              code: 'INVALID_PARAMS',
              message: 'A non-empty "reason" field is required when rejecting a task',
            },
          },
          400
        );
      }

      const result = await taskService.reject(id, { reason });

      if (!result.ok) {
        return errorResponse(result);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      logger.error('Reject task error', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to reject task' } },
        500
      );
    }
  });

  // POST /api/tasks/:id/stop-agent - Stop a running container agent for a task
  app.post('/:id/stop-agent', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await taskService.stopAgent(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: { stopped: true } });
  });

  return app;
}
