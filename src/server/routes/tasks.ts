/**
 * Task routes
 */

import { Hono } from 'hono';
import type { AuthContext } from '../../lib/api/auth-middleware.js';
import { decodeRequestCursor, paginate } from '../../lib/api/pagination.js';
import { applyTokenTagFilter } from '../../lib/api/rbac-middleware.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { TaskService } from '../../services/task.service.js';
import type { Database } from '../../types/database.js';
import { errorResponse, json, parseLimit, requireQueryId, validateIdParam } from '../shared.js';
import {
  approveTaskSchema,
  createTaskSchema,
  moveTaskSchema,
  parseJsonBody,
  rejectPlanSchema,
  rejectTaskSchema,
  taskColumnSchema,
  updateTaskSchema,
} from '../validation.js';

const logger = createLogger('routes:tasks');

interface TasksDeps {
  taskService: TaskService;
  db: Database;
}

export function createTasksRoutes({ taskService, db }: TasksDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET /api/tasks
  //
  // F07-01: cursor-paginated list endpoint. The canonical envelope is
  //   { data: { items: Task[], nextCursor: string|null, hasMore: boolean } }
  // sorted by `position` asc with `id` as the tiebreaker. Request a next page
  // by passing the opaque `cursor` query param from the previous response.
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
    const rawCursor = c.req.query('cursor') || undefined;

    // F07-01: fixed sort for cursor stability. The route always sorts by
    // `position` asc; if we later expose a `sort` query param it must be
    // validated against the cursor's embedded sortField.
    const sortField = 'position' as const;
    const order = 'asc' as const;

    const cursorResult = decodeRequestCursor(rawCursor, { sortField, order });
    if (!cursorResult.ok) {
      return json(
        {
          ok: false,
          error: {
            code: 'INVALID_CURSOR',
            message: 'Invalid or malformed cursor. Restart pagination from the beginning.',
          },
        },
        400
      );
    }
    const cursorPayload = cursorResult.value;

    const result = await taskService.list(codespaceId, {
      column,
      limit: limit + 1, // F07-01: fetch limit+1 so `paginate` can detect hasMore.
      orderBy: sortField,
      orderDirection: order,
      ...(cursorPayload
        ? {
            cursor: {
              sortValue: cursorPayload.sortValue,
              id: cursorPayload.id,
            },
          }
        : {}),
    });

    if (!result.ok) {
      return errorResponse(result);
    }

    // F06-NEW-07: filter by tag scope when the token is tag-restricted.
    // We filter the raw service result before paginate() so the cursor +
    // hasMore semantics still hold for the visible-to-token subset.
    const auth = c.get('auth') as AuthContext | undefined;
    const filteredItems = await applyTokenTagFilter(db, auth, result.value, (t) => t.id);

    const body = paginate(filteredItems, { limit, sortField, order });
    return json({ ok: true, data: body });
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
      executionSkillId: body.executionSkillId,
      executionSkillName: body.executionSkillName,
      approvalMode: body.approvalMode,
      autoStart: body.autoStart,
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
      executionSkillId: body.executionSkillId,
      executionSkillName: body.executionSkillName,
      approvalMode: body.approvalMode,
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
  //
  // F07-06: when agent auto-start fails, return `ok:false` with a structured
  // error so the UI surfaces the failure. `taskService.moveColumn()` already
  // reverts the task to `backlog` when agent start fails, so the response
  // also signals the new column via `details.task`.
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

    // F07-06: agent auto-start failed → propagate as `ok:false` with a 500
    // status. The service has already reverted the column to `backlog` (or
    // logged a fatal warning if the revert itself failed). The previous
    // shape (`ok:true` with embedded `agentError`) hid the failure from
    // clients that key on `result.ok`.
    if (agentError) {
      logger.error(`Failed to start agent for task ${id}`, { data: { agentError } });
      return json(
        {
          ok: false,
          error: {
            code: 'AGENT_START_FAILED',
            message: agentError,
            details: {
              taskId: id,
              task: updatedTask,
            },
          },
        },
        500
      );
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

    // Body is optional — only validate when Content-Type indicates JSON.
    let reason: string | undefined;
    if (c.req.header('Content-Type')?.includes('application/json')) {
      const parsed = await parseJsonBody(c, rejectPlanSchema);
      if (!parsed.ok) return parsed.response;
      reason = parsed.data?.reason;
    }

    try {
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

    // Body is optional — only validate when Content-Type indicates JSON.
    let approvedBy: string | undefined;
    let createMergeCommit: boolean | undefined;
    if (c.req.header('Content-Type')?.includes('application/json')) {
      const parsed = await parseJsonBody(c, approveTaskSchema);
      if (!parsed.ok) return parsed.response;
      approvedBy = parsed.data?.approvedBy;
      createMergeCommit = parsed.data?.createMergeCommit;
    }

    try {
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

    // F07-03: reason is required and must be a non-empty trimmed string. The
    // canonical schema rejects whitespace-only and missing values; clients
    // that omitted the body previously got a misleading 200.
    //
    // No-body / no-Content-Type case: emit a clear "reason is required"
    // message rather than the generic "invalid JSON" — the only valid
    // request shape is `{ reason: string }`.
    const hasJsonBody = c.req.header('Content-Type')?.includes('application/json');
    if (!hasJsonBody) {
      return json(
        {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'A non-empty "reason" field is required when rejecting a task',
          },
        },
        400
      );
    }

    const parsed = await parseJsonBody(c, rejectTaskSchema);
    if (!parsed.ok) return parsed.response;
    const reason = parsed.data.reason;

    try {
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

  // POST /api/tasks/:id/cancel - Cancel an in-progress task (stop agent + move to backlog)
  app.post('/:id/cancel', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await taskService.cancelTask(id);

    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value });
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
