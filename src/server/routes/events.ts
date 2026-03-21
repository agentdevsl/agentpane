/**
 * Event plugin system routes
 *
 * Provides CRUD for event sources, subscriptions, event log queries,
 * and an SSE stream for real-time event notifications.
 *
 * AR-024: This is the largest route module (~1,200 lines). A future split into
 * events-sources.ts, events-subscriptions.ts, events-log.ts, and events-stream.ts
 * is deferred because the endpoints are tightly coupled through shared auth helpers
 * (getUserTeamIds) and the SSE stream depends on source-level access checks.
 * Splitting would require significant refactoring of the shared helpers.
 */

import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { EventLogStatus, EventSourceType } from '../../db/schema/index.js';
import {
  codespaces,
  EVENT_LOG_STATUS,
  EVENT_SOURCE_TYPES,
  eventLog,
  eventSources,
  eventSubscriptions,
  scheduleExecutions,
  teamMembers,
  teamProjectFolders,
} from '../../db/schema/index.js';
import type { CronEventSourceConfig } from '../../db/schema/shared/cron-config.js';
import type { EventSourceStatus } from '../../db/schema/shared/enums.js';
import { EVENT_SOURCE_STATUS, SCHEDULE_EXECUTION_STATUS } from '../../db/schema/shared/enums.js';
import type { AuthContext } from '../../lib/api/auth-middleware.js';
import type { AppError } from '../../lib/errors/base.js';
import {
  addStreamListener,
  decrementSSEConnections,
  getActiveSSEConnections,
  incrementSSEConnections,
  MAX_SSE_CONNECTIONS,
  removeStreamListener,
} from '../../lib/events/event-bus.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { EventSourceService } from '../../services/event-source.service.js';
import type { EventSubscriptionService } from '../../services/event-subscription.service.js';
import type { RbacService } from '../../services/rbac.service.js';
import type { SchedulerService } from '../../services/scheduler.service.js';
import type { Database } from '../../types/database.js';
import { failure, isValidId, json, parsePagination, requireTeamRole } from '../shared.js';
import { idSchema, parseJsonBody, taskColumnSchema, taskPrioritySchema } from '../validation.js';

const log = createLogger('EventsRoutes');

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const subscriptionFilterSchema = z.object({
  field: z.enum(['repo', 'branch', 'labels', 'author', 'action']),
  operator: z.enum(['equals', 'contains', 'matches', 'not_equals']),
  value: z.string().min(1).max(500),
});

const createEventSourceSchema = z.object({
  teamId: idSchema,
  name: z.string().min(1, 'Name is required').max(200),
  type: z.enum(EVENT_SOURCE_TYPES),
  webhookSecret: z.string().max(500).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const updateEventSourceSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    isEnabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

const createSubscriptionSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  eventSourceId: idSchema,
  targetCodespaceId: idSchema,
  eventTypes: z.array(z.string().max(100)).max(50).optional(),
  filters: z.array(subscriptionFilterSchema).max(20).optional(),
  promptTemplate: z.string().min(1, 'Prompt template is required').max(10000),
  autoStartAgent: z.boolean().optional(),
  taskColumn: taskColumnSchema.optional(),
  taskPriority: taskPrioritySchema.optional(),
  taskLabels: z.array(z.string().max(50)).max(20).optional(),
});

const updateSubscriptionSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    isEnabled: z.boolean().optional(),
    eventTypes: z.array(z.string().max(100)).max(50).optional(),
    filters: z.array(subscriptionFilterSchema).max(20).optional(),
    promptTemplate: z.string().min(1).max(10000).optional(),
    autoStartAgent: z.boolean().optional(),
    taskColumn: taskColumnSchema.optional(),
    taskPriority: taskPrioritySchema.optional(),
    taskLabels: z.array(z.string().max(50)).max(20).optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface EventsRouteDependencies {
  eventSourceService: EventSourceService;
  eventSubscriptionService: EventSubscriptionService;
  db: Database;
  rbacService: RbacService;
  schedulerService?: SchedulerService;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resultErrorResponse(error: AppError): Response {
  return json(failure(error), error.status);
}

/**
 * Strip sensitive fields from EventSource before sending to client.
 */
function stripSourceSecret(source: { webhookSecret?: unknown; [key: string]: unknown }) {
  const { webhookSecret: _, ...rest } = source;
  return rest;
}

/**
 * Get team IDs for the authenticated user.
 * In dev mode, returns all team IDs.
 * In production, reads from auth context teamMemberships or queries DB.
 */
async function getUserTeamIds(auth: AuthContext, db: Database): Promise<string[]> {
  // If enriched auth has team memberships, use them
  if (auth.teamMemberships && auth.teamMemberships.length > 0) {
    return auth.teamMemberships.map((m) => m.teamId);
  }

  // Dev mode: return all teams (bypasses team scoping)
  if (auth.authMethod === 'dev') {
    log.warn('Dev mode: bypassing team scoping for user', { data: { userId: auth.userId } });
    const allTeams = await db.select({ teamId: teamMembers.teamId }).from(teamMembers);
    return [...new Set(allTeams.map((t) => t.teamId))];
  }

  // Query DB for user's team memberships
  const memberships = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, auth.userId));

  return memberships.map((m) => m.teamId);
}

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

export function createEventsRoutes(deps: EventsRouteDependencies) {
  const { eventSourceService, eventSubscriptionService, db, rbacService } = deps;

  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // =========================================================================
  // Event Sources
  // =========================================================================

  // GET /sources - List event sources for the user's teams
  app.get('/sources', async (c) => {
    const auth = c.get('auth');
    const { cursor, limit } = parsePagination(c);

    try {
      const teamIds = await getUserTeamIds(auth, db);

      if (teamIds.length === 0) {
        return json({ ok: true, data: { items: [], nextCursor: null, hasMore: false } });
      }

      const conditions = [];

      // Optionally filter by teamId query param
      const teamIdFilter = c.req.query('teamId');
      if (teamIdFilter) {
        if (!isValidId(teamIdFilter)) {
          return json(
            { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid teamId' } },
            400
          );
        }
        if (!teamIds.includes(teamIdFilter)) {
          return json(
            { ok: false, error: { code: 'FORBIDDEN', message: 'Not a member of this team' } },
            403
          );
        }
        conditions.push(eq(eventSources.teamId, teamIdFilter));
      } else {
        conditions.push(inArray(eventSources.teamId, teamIds));
      }

      // Filter by source type
      const typeFilter = c.req.query('type');
      if (typeFilter) {
        if (!(EVENT_SOURCE_TYPES as readonly string[]).includes(typeFilter)) {
          return json(
            { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid type filter' } },
            400
          );
        }
        conditions.push(eq(eventSources.type, typeFilter as EventSourceType));
      }

      // Filter by source status
      const statusFilter = c.req.query('status');
      if (statusFilter) {
        if (!(EVENT_SOURCE_STATUS as readonly string[]).includes(statusFilter)) {
          return json(
            { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status filter' } },
            400
          );
        }
        conditions.push(eq(eventSources.status, statusFilter as EventSourceStatus));
      }

      // Cursor-based pagination: "createdAt|id"
      if (cursor) {
        const separatorIdx = cursor.lastIndexOf('|');
        if (separatorIdx > 0) {
          const cursorTime = cursor.slice(0, separatorIdx);
          const cursorId = cursor.slice(separatorIdx + 1);
          conditions.push(
            sql`(${eventSources.createdAt} < ${cursorTime} OR (${eventSources.createdAt} = ${cursorTime} AND ${eventSources.id} < ${cursorId}))`
          );
        }
      }

      const entries = await db
        .select()
        .from(eventSources)
        .where(and(...conditions))
        .orderBy(desc(eventSources.createdAt), desc(eventSources.id))
        .limit(limit + 1);

      const hasMore = entries.length > limit;
      const items = hasMore ? entries.slice(0, limit) : entries;
      const lastItem = items[items.length - 1];
      const nextCursor = hasMore && lastItem ? `${lastItem.createdAt}|${lastItem.id}` : null;

      return json({
        ok: true,
        data: { items: items.map(stripSourceSecret), nextCursor, hasMore },
      });
    } catch (error) {
      log.error('Failed to list event sources', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list event sources' } },
        500
      );
    }
  });

  // GET /sources/:id - Get event source by ID
  app.get('/sources/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');

    try {
      const result = await eventSourceService.getById(id);
      if (!result.ok) return resultErrorResponse(result.error);

      // Verify user has access to this source's team
      const denied = await requireTeamRole(
        auth,
        rbacService,
        result.value.teamId,
        'viewer',
        'Not a member of this team'
      );
      if (denied) return denied;

      return json({ ok: true, data: stripSourceSecret(result.value) });
    } catch (error) {
      log.error('Failed to get event source', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get event source' } },
        500
      );
    }
  });

  // POST /sources - Create event source (requires admin)
  app.post('/sources', async (c) => {
    const auth = c.get('auth');
    const parsed = await parseJsonBody(c, createEventSourceSchema);
    if (!parsed.ok) return parsed.response;

    const denied = await requireTeamRole(
      auth,
      rbacService,
      parsed.data.teamId,
      'admin',
      'Requires admin role in team'
    );
    if (denied) return denied;

    try {
      const result = await eventSourceService.create({
        teamId: parsed.data.teamId,
        name: parsed.data.name,
        type: parsed.data.type as EventSourceType,
        webhookSecret: parsed.data.webhookSecret,
        config: parsed.data.config,
      });

      if (!result.ok) return resultErrorResponse(result.error);

      const { source, plaintextSecret } = result.value;
      return json(
        {
          ok: true,
          data: {
            ...stripSourceSecret(source),
            webhookSecret: plaintextSecret,
            webhookUrl: `/hooks/events/${source.slug}`,
          },
        },
        201
      );
    } catch (error) {
      log.error('Failed to create event source', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create event source' } },
        500
      );
    }
  });

  // PATCH /sources/:id - Update event source (requires admin)
  app.patch('/sources/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');
    const parsed = await parseJsonBody(c, updateEventSourceSchema);
    if (!parsed.ok) return parsed.response;

    try {
      const existing = await eventSourceService.getById(id);
      if (!existing.ok) return resultErrorResponse(existing.error);

      const denied = await requireTeamRole(
        auth,
        rbacService,
        existing.value.teamId,
        'admin',
        'Requires admin role in team'
      );
      if (denied) return denied;

      const result = await eventSourceService.update(id, parsed.data);
      if (!result.ok) return resultErrorResponse(result.error);

      return json({ ok: true, data: stripSourceSecret(result.value) });
    } catch (error) {
      log.error('Failed to update event source', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update event source' } },
        500
      );
    }
  });

  // DELETE /sources/:id - Delete event source (requires admin)
  app.delete('/sources/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');

    try {
      const existing = await eventSourceService.getById(id);
      if (!existing.ok) return resultErrorResponse(existing.error);

      const denied = await requireTeamRole(
        auth,
        rbacService,
        existing.value.teamId,
        'admin',
        'Requires admin role in team'
      );
      if (denied) return denied;

      const result = await eventSourceService.delete(id);
      if (!result.ok) return resultErrorResponse(result.error);

      return json({ ok: true, data: { deleted: true } });
    } catch (error) {
      log.error('Failed to delete event source', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to delete event source' } },
        500
      );
    }
  });

  // POST /sources/:id/rotate-secret - Rotate webhook secret (requires admin)
  app.post('/sources/:id/rotate-secret', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');

    try {
      const existing = await eventSourceService.getById(id);
      if (!existing.ok) return resultErrorResponse(existing.error);

      const denied = await requireTeamRole(
        auth,
        rbacService,
        existing.value.teamId,
        'admin',
        'Requires admin role in team'
      );
      if (denied) return denied;

      const result = await eventSourceService.rotateSecret(id);
      if (!result.ok) return resultErrorResponse(result.error);

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Failed to rotate webhook secret', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to rotate webhook secret' } },
        500
      );
    }
  });

  // =========================================================================
  // Schedule-Specific Endpoints (cron event sources)
  // =========================================================================

  // POST /sources/:id/trigger - Manually trigger a cron source
  app.post('/sources/:id/trigger', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');
    const { schedulerService } = deps;
    if (!schedulerService) {
      return json(
        { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Scheduler not available' } },
        503
      );
    }

    try {
      const existing = await eventSourceService.getById(id);
      if (!existing.ok) return resultErrorResponse(existing.error);

      const denied = await requireTeamRole(
        auth,
        rbacService,
        existing.value.teamId,
        'agent_operator',
        'Requires agent_operator role in team'
      );
      if (denied) return denied;

      const result = await schedulerService.triggerManual(id);
      if (!result.ok) return resultErrorResponse(result.error);

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Failed to trigger cron source', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to trigger cron source' } },
        500
      );
    }
  });

  // POST /sources/:id/pause - Pause a cron source
  app.post('/sources/:id/pause', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');
    const { schedulerService } = deps;
    if (!schedulerService) {
      return json(
        { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Scheduler not available' } },
        503
      );
    }

    try {
      const existing = await eventSourceService.getById(id);
      if (!existing.ok) return resultErrorResponse(existing.error);

      const denied = await requireTeamRole(
        auth,
        rbacService,
        existing.value.teamId,
        'agent_operator',
        'Requires agent_operator role in team'
      );
      if (denied) return denied;

      const result = await schedulerService.pauseSource(id);
      if (!result.ok) return resultErrorResponse(result.error);

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Failed to pause cron source', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to pause cron source' } },
        500
      );
    }
  });

  // POST /sources/:id/resume - Resume a paused/errored cron source
  app.post('/sources/:id/resume', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');
    const { schedulerService } = deps;
    if (!schedulerService) {
      return json(
        { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Scheduler not available' } },
        503
      );
    }

    try {
      const existing = await eventSourceService.getById(id);
      if (!existing.ok) return resultErrorResponse(existing.error);

      const denied = await requireTeamRole(
        auth,
        rbacService,
        existing.value.teamId,
        'agent_operator',
        'Requires agent_operator role in team'
      );
      if (denied) return denied;

      const result = await schedulerService.resumeSource(id);
      if (!result.ok) return resultErrorResponse(result.error);

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Failed to resume cron source', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to resume cron source' } },
        500
      );
    }
  });

  // GET /sources/:id/budget - Get budget status for a cron source
  app.get('/sources/:id/budget', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');
    const { schedulerService } = deps;
    if (!schedulerService) {
      return json(
        { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Scheduler not available' } },
        503
      );
    }

    try {
      const existing = await eventSourceService.getById(id);
      if (!existing.ok) return resultErrorResponse(existing.error);

      if (existing.value.type !== 'cron') {
        return json(
          {
            ok: false,
            error: { code: 'SCHEDULE_NOT_CRON_TYPE', message: 'Source is not a cron type' },
          },
          400
        );
      }

      const denied = await requireTeamRole(
        auth,
        rbacService,
        existing.value.teamId,
        'viewer',
        'Not a member of this team'
      );
      if (denied) return denied;

      const config = existing.value.config as unknown as CronEventSourceConfig;
      const budgetStatus = await schedulerService.getBudgetStatus(id, config);

      return json({ ok: true, data: budgetStatus });
    } catch (error) {
      log.error('Failed to get budget status', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get budget status' } },
        500
      );
    }
  });

  // GET /sources/:id/executions - List execution history for a cron source
  app.get('/sources/:id/executions', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');

    try {
      const existing = await eventSourceService.getById(id);
      if (!existing.ok) return resultErrorResponse(existing.error);

      if (existing.value.type !== 'cron') {
        return json(
          {
            ok: false,
            error: { code: 'SCHEDULE_NOT_CRON_TYPE', message: 'Source is not a cron type' },
          },
          400
        );
      }

      const denied = await requireTeamRole(
        auth,
        rbacService,
        existing.value.teamId,
        'viewer',
        'Not a member of this team'
      );
      if (denied) return denied;

      const { cursor, limit } = parsePagination(c);
      const statusFilter = c.req.query('status');
      const since = c.req.query('since');
      const until = c.req.query('until');

      const conditions = [eq(scheduleExecutions.eventSourceId, id)];

      if (statusFilter) {
        if (!(SCHEDULE_EXECUTION_STATUS as readonly string[]).includes(statusFilter)) {
          return json(
            { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status filter' } },
            400
          );
        }
        conditions.push(
          eq(scheduleExecutions.status, statusFilter as (typeof SCHEDULE_EXECUTION_STATUS)[number])
        );
      }

      if (since) {
        conditions.push(sql`${scheduleExecutions.scheduledAt} >= ${since}`);
      }
      if (until) {
        conditions.push(sql`${scheduleExecutions.scheduledAt} <= ${until}`);
      }

      if (cursor) {
        const separatorIdx = cursor.lastIndexOf('|');
        if (separatorIdx > 0) {
          const cursorTime = cursor.slice(0, separatorIdx);
          const cursorId = cursor.slice(separatorIdx + 1);
          conditions.push(
            sql`(${scheduleExecutions.scheduledAt} < ${cursorTime} OR (${scheduleExecutions.scheduledAt} = ${cursorTime} AND ${scheduleExecutions.id} < ${cursorId}))`
          );
        }
      }

      const entries = await db
        .select()
        .from(scheduleExecutions)
        .where(and(...conditions))
        .orderBy(desc(scheduleExecutions.scheduledAt), desc(scheduleExecutions.id))
        .limit(limit + 1);

      const hasMore = entries.length > limit;
      const items = hasMore ? entries.slice(0, limit) : entries;
      const lastItem = items[items.length - 1];
      const nextCursor = hasMore && lastItem ? `${lastItem.scheduledAt}|${lastItem.id}` : null;

      return json({
        ok: true,
        data: { items, nextCursor, hasMore },
      });
    } catch (error) {
      log.error('Failed to list schedule executions', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list schedule executions' } },
        500
      );
    }
  });

  // =========================================================================
  // Event Subscriptions
  // =========================================================================

  // GET /subscriptions - List subscriptions (filter by eventSourceId, targetCodespaceId, isEnabled)
  app.get('/subscriptions', async (c) => {
    const auth = c.get('auth');
    const { cursor, limit } = parsePagination(c);
    const eventSourceId = c.req.query('eventSourceId');
    const targetCodespaceId = c.req.query('targetCodespaceId');
    const isEnabledParam = c.req.query('isEnabled');

    try {
      // Determine base scope: source IDs the user has access to
      let scopeSourceIds: string[] | null = null;

      if (eventSourceId) {
        if (!isValidId(eventSourceId)) {
          return json(
            { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid eventSourceId' } },
            400
          );
        }
        // Verify access to the source's team
        const source = await eventSourceService.getById(eventSourceId);
        if (!source.ok) return resultErrorResponse(source.error);
        const denied = await requireTeamRole(
          auth,
          rbacService,
          source.value.teamId,
          'viewer',
          'Not a member of this team'
        );
        if (denied) return denied;
        scopeSourceIds = [eventSourceId];
      } else {
        // Scope to user's teams' sources
        const teamIds = await getUserTeamIds(auth, db);
        if (teamIds.length === 0) {
          return json({ ok: true, data: { items: [], nextCursor: null, hasMore: false } });
        }
        const sources = await db
          .select({ id: eventSources.id })
          .from(eventSources)
          .where(inArray(eventSources.teamId, teamIds));
        if (sources.length === 0) {
          return json({ ok: true, data: { items: [], nextCursor: null, hasMore: false } });
        }
        scopeSourceIds = sources.map((s) => s.id);
      }

      const conditions = [inArray(eventSubscriptions.eventSourceId, scopeSourceIds)];

      if (targetCodespaceId) {
        if (!isValidId(targetCodespaceId)) {
          return json(
            {
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: 'Invalid targetCodespaceId' },
            },
            400
          );
        }
        // Verify user has access to the codespace's team (via project folder)
        const teamIds = await getUserTeamIds(auth, db);
        const codespaceRecord = await db
          .select({ projectFolderId: codespaces.projectFolderId })
          .from(codespaces)
          .where(eq(codespaces.id, targetCodespaceId));
        let hasAccess = false;
        if (codespaceRecord[0]?.projectFolderId) {
          const folderTeams = await db
            .select({ teamId: teamProjectFolders.teamId })
            .from(teamProjectFolders)
            .where(eq(teamProjectFolders.projectFolderId, codespaceRecord[0].projectFolderId));
          hasAccess = folderTeams.some((ft) => teamIds.includes(ft.teamId));
        }
        if (!hasAccess) {
          return json(
            { ok: false, error: { code: 'FORBIDDEN', message: 'No access to this codespace' } },
            403
          );
        }
        conditions.push(eq(eventSubscriptions.targetProjectId, targetCodespaceId));
      }

      // Filter by isEnabled
      if (isEnabledParam !== undefined) {
        const isEnabled = isEnabledParam === 'true';
        conditions.push(eq(eventSubscriptions.isEnabled, isEnabled));
      }

      // Cursor-based pagination: "createdAt|id"
      if (cursor) {
        const separatorIdx = cursor.lastIndexOf('|');
        if (separatorIdx > 0) {
          const cursorTime = cursor.slice(0, separatorIdx);
          const cursorId = cursor.slice(separatorIdx + 1);
          conditions.push(
            sql`(${eventSubscriptions.createdAt} < ${cursorTime} OR (${eventSubscriptions.createdAt} = ${cursorTime} AND ${eventSubscriptions.id} < ${cursorId}))`
          );
        }
      }

      const entries = await db
        .select()
        .from(eventSubscriptions)
        .where(and(...conditions))
        .orderBy(desc(eventSubscriptions.createdAt), desc(eventSubscriptions.id))
        .limit(limit + 1);

      const hasMore = entries.length > limit;
      const items = hasMore ? entries.slice(0, limit) : entries;
      const lastItem = items[items.length - 1];
      const nextCursor = hasMore && lastItem ? `${lastItem.createdAt}|${lastItem.id}` : null;

      return json({
        ok: true,
        data: { items, nextCursor, hasMore },
      });
    } catch (error) {
      log.error('Failed to list subscriptions', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list subscriptions' } },
        500
      );
    }
  });

  // GET /subscriptions/:id - Get subscription by ID
  app.get('/subscriptions/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');

    try {
      const result = await eventSubscriptionService.getById(id);
      if (!result.ok) return resultErrorResponse(result.error);

      // Verify user has access to the source's team
      const source = await eventSourceService.getById(result.value.eventSourceId);
      if (!source.ok) return resultErrorResponse(source.error);
      const denied = await requireTeamRole(
        auth,
        rbacService,
        source.value.teamId,
        'viewer',
        'Not a member of this team'
      );
      if (denied) return denied;

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Failed to get subscription', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get subscription' } },
        500
      );
    }
  });

  // POST /subscriptions - Create subscription (requires agent_operator on source's team)
  app.post('/subscriptions', async (c) => {
    const auth = c.get('auth');
    const parsed = await parseJsonBody(c, createSubscriptionSchema);
    if (!parsed.ok) return parsed.response;

    try {
      const source = await eventSourceService.getById(parsed.data.eventSourceId);
      if (!source.ok) return resultErrorResponse(source.error);

      const denied = await requireTeamRole(
        auth,
        rbacService,
        source.value.teamId,
        'agent_operator',
        'Requires agent_operator role in team'
      );
      if (denied) return denied;

      const result = await eventSubscriptionService.create(parsed.data);

      if (!result.ok) return resultErrorResponse(result.error);

      return json({ ok: true, data: result.value }, 201);
    } catch (error) {
      log.error('Failed to create subscription', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to create subscription' } },
        500
      );
    }
  });

  // PATCH /subscriptions/:id - Update subscription (requires agent_operator)
  app.patch('/subscriptions/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');
    const parsed = await parseJsonBody(c, updateSubscriptionSchema);
    if (!parsed.ok) return parsed.response;

    try {
      const existing = await eventSubscriptionService.getById(id);
      if (!existing.ok) return resultErrorResponse(existing.error);

      const source = await eventSourceService.getById(existing.value.eventSourceId);
      if (!source.ok) return resultErrorResponse(source.error);

      const denied = await requireTeamRole(
        auth,
        rbacService,
        source.value.teamId,
        'agent_operator',
        'Requires agent_operator role in team'
      );
      if (denied) return denied;

      const result = await eventSubscriptionService.update(id, parsed.data);
      if (!result.ok) return resultErrorResponse(result.error);

      return json({ ok: true, data: result.value });
    } catch (error) {
      log.error('Failed to update subscription', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to update subscription' } },
        500
      );
    }
  });

  // DELETE /subscriptions/:id - Delete subscription (requires agent_operator)
  app.delete('/subscriptions/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');

    try {
      const existing = await eventSubscriptionService.getById(id);
      if (!existing.ok) return resultErrorResponse(existing.error);

      const source = await eventSourceService.getById(existing.value.eventSourceId);
      if (!source.ok) return resultErrorResponse(source.error);

      const denied = await requireTeamRole(
        auth,
        rbacService,
        source.value.teamId,
        'agent_operator',
        'Requires agent_operator role in team'
      );
      if (denied) return denied;

      const result = await eventSubscriptionService.delete(id);
      if (!result.ok) return resultErrorResponse(result.error);

      return json({ ok: true, data: { deleted: true } });
    } catch (error) {
      log.error('Failed to delete subscription', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to delete subscription' } },
        500
      );
    }
  });

  // =========================================================================
  // Event Log
  // =========================================================================

  // GET /log - List event log entries with cursor pagination and filters
  app.get('/log', async (c) => {
    const auth = c.get('auth');
    const { cursor, limit } = parsePagination(c);
    const eventSourceId = c.req.query('eventSourceId');
    const status = c.req.query('status') as EventLogStatus | undefined;
    const eventType = c.req.query('eventType');
    const since = c.req.query('since');
    const until = c.req.query('until');

    try {
      // Build filter conditions
      const conditions = [];

      if (eventSourceId) {
        if (!isValidId(eventSourceId)) {
          return json(
            { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid eventSourceId' } },
            400
          );
        }

        // Verify access to the source's team
        const source = await eventSourceService.getById(eventSourceId);
        if (!source.ok) return resultErrorResponse(source.error);
        const denied = await requireTeamRole(
          auth,
          rbacService,
          source.value.teamId,
          'viewer',
          'Not a member of this team'
        );
        if (denied) return denied;

        conditions.push(eq(eventLog.eventSourceId, eventSourceId));
      } else {
        // Scope to user's team sources
        const teamIds = await getUserTeamIds(auth, db);
        if (teamIds.length === 0) {
          return json({
            ok: true,
            data: { items: [], nextCursor: null, hasMore: false },
          });
        }

        const sources = await db
          .select({ id: eventSources.id })
          .from(eventSources)
          .where(inArray(eventSources.teamId, teamIds));

        if (sources.length === 0) {
          return json({
            ok: true,
            data: { items: [], nextCursor: null, hasMore: false },
          });
        }

        conditions.push(
          inArray(
            eventLog.eventSourceId,
            sources.map((s) => s.id)
          )
        );
      }

      if (status) {
        if (!(EVENT_LOG_STATUS as readonly string[]).includes(status)) {
          return json(
            { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid status filter' } },
            400
          );
        }
        conditions.push(eq(eventLog.status, status));
      }

      if (eventType) {
        conditions.push(eq(eventLog.eventType, eventType));
      }

      // Date range filters
      if (since) {
        conditions.push(gte(eventLog.receivedAt, since));
      }
      if (until) {
        conditions.push(lte(eventLog.receivedAt, until));
      }

      // Composite cursor: "receivedAt|id" for stable descending pagination
      if (cursor) {
        const separatorIdx = cursor.lastIndexOf('|');
        if (separatorIdx > 0) {
          const cursorTime = cursor.slice(0, separatorIdx);
          const cursorId = cursor.slice(separatorIdx + 1);
          conditions.push(
            sql`(${eventLog.receivedAt} < ${cursorTime} OR (${eventLog.receivedAt} = ${cursorTime} AND ${eventLog.id} < ${cursorId}))`
          );
        }
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Fetch limit+1 to determine hasMore
      const entries = await db
        .select()
        .from(eventLog)
        .where(whereClause)
        .orderBy(desc(eventLog.receivedAt), desc(eventLog.id))
        .limit(limit + 1);

      const hasMore = entries.length > limit;
      const items = hasMore ? entries.slice(0, limit) : entries;
      const nextCursor =
        hasMore && items.length > 0
          ? `${items[items.length - 1]?.receivedAt}|${items[items.length - 1]?.id}`
          : null;

      return json({
        ok: true,
        data: { items, nextCursor, hasMore },
      });
    } catch (error) {
      log.error('Failed to list event log', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to list event log' } },
        500
      );
    }
  });

  // GET /log/:id - Get event log entry by ID
  app.get('/log/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json({ ok: false, error: { code: 'INVALID_ID', message: 'Invalid ID' } }, 400);
    }

    const auth = c.get('auth');

    try {
      const entries = await db.select().from(eventLog).where(eq(eventLog.id, id));

      const entry = entries[0];
      if (!entry) {
        return json(
          { ok: false, error: { code: 'NOT_FOUND', message: 'Event log entry not found' } },
          404
        );
      }

      // Deny access if source cannot be resolved (deleted source = orphaned entry)
      if (!entry.eventSourceId) {
        return json(
          {
            ok: false,
            error: {
              code: 'FORBIDDEN',
              message: 'Cannot verify access to orphaned event log entry',
            },
          },
          403
        );
      }
      const source = await eventSourceService.getById(entry.eventSourceId);
      if (!source.ok) {
        return json(
          {
            ok: false,
            error: { code: 'FORBIDDEN', message: 'Cannot verify access to this event log entry' },
          },
          403
        );
      }
      const denied = await requireTeamRole(
        auth,
        rbacService,
        source.value.teamId,
        'viewer',
        'Not a member of this team'
      );
      if (denied) return denied;

      return json({ ok: true, data: entry });
    } catch (error) {
      log.error('Failed to get event log entry', { error });
      return json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to get event log entry' } },
        500
      );
    }
  });

  // =========================================================================
  // SSE Stream
  // =========================================================================

  // GET /stream - SSE endpoint for real-time event notifications
  app.get('/stream', async (c) => {
    // Validate authentication — reject unauthenticated requests
    const auth = c.get('auth');
    if (!auth?.userId) {
      return json(
        { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        401
      );
    }

    // Resolve accessible source IDs for event scoping
    const teamIds = await getUserTeamIds(auth, db);
    const teamSources =
      teamIds.length > 0
        ? await db
            .select({ id: eventSources.id })
            .from(eventSources)
            .where(inArray(eventSources.teamId, teamIds))
        : [];
    const allowedSourceIds = new Set(teamSources.map((s) => s.id));

    if (getActiveSSEConnections() >= MAX_SSE_CONNECTIONS) {
      return json(
        {
          ok: false,
          error: { code: 'TOO_MANY_CONNECTIONS', message: 'SSE connection limit reached' },
        },
        429
      );
    }

    let listener: ((event: { type: string; data: unknown }) => void) | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;
    let cleaned = false;

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      decrementSSEConnections();
      if (pingInterval) clearInterval(pingInterval);
      if (listener) removeStreamListener(listener);
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        incrementSSEConnections();
        const encoder = new TextEncoder();
        const send = (data: unknown) => {
          if (cleaned) return;

          // Scope SSE events: only forward events for sources the user has access to
          const eventData = data as { data?: { eventSourceId?: string } };
          if (
            eventData?.data?.eventSourceId &&
            !allowedSourceIds.has(eventData.data.eventSourceId)
          ) {
            return;
          }

          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch (sendErr) {
            log.warn('SSE send failed, cleaning up connection', {
              error: sendErr instanceof Error ? sendErr.message : String(sendErr),
            });
            cleanup();
            try {
              controller.close();
            } catch (closeErr) {
              log.debug('Stream controller close failed', {
                data: { error: closeErr instanceof Error ? closeErr.message : String(closeErr) },
              });
            }
          }
        };

        // Send initial connected event
        send({ type: 'connected', timestamp: new Date().toISOString() });

        listener = send;
        addStreamListener(listener);

        // Keep-alive ping every 15s
        pingInterval = setInterval(() => {
          if (cleaned) {
            if (pingInterval) clearInterval(pingInterval);
            return;
          }
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch (pingErr) {
            log.debug('SSE ping failed, closing connection', {
              data: { error: pingErr instanceof Error ? pingErr.message : String(pingErr) },
            });
            cleanup();
            try {
              controller.close();
            } catch (closeErr) {
              log.debug('Stream controller close failed', {
                data: { error: closeErr instanceof Error ? closeErr.message : String(closeErr) },
              });
            }
          }
        }, 15_000);
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  return app;
}
