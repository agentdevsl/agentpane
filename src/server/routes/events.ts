/**
 * Event plugin system routes
 *
 * Provides CRUD for event sources, subscriptions, event log queries,
 * and an SSE stream for real-time event notifications.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { EventLogStatus, EventSourceType } from '../../db/schema/index.js';
import {
  EVENT_LOG_STATUS,
  EVENT_SOURCE_TYPES,
  eventLog,
  eventSources,
  eventSubscriptions,
  teamMembers,
  teamProjects,
} from '../../db/schema/index.js';
import type { AuthContext } from '../../lib/api/auth-middleware.js';
import type { AppError } from '../../lib/errors/base.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { EventSourceService } from '../../services/event-source.service.js';
import type { EventSubscriptionService } from '../../services/event-subscription.service.js';
import type { RbacService } from '../../services/rbac.service.js';
import type { Database } from '../../types/database.js';
import { isValidId, json, parsePagination, requireTeamRole } from '../shared.js';
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
  targetProjectId: idSchema,
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
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

const MAX_SSE_CONNECTIONS = 50;
let activeSSEConnections = 0;

// Simple in-process event bus for SSE subscribers
type EventStreamListener = (event: { type: string; data: unknown }) => void;
const eventStreamListeners = new Set<EventStreamListener>();

/**
 * Publish an event to all connected SSE clients.
 * Call this from the event processing pipeline after an event is logged.
 */
export function publishEventToStream(event: { type: string; data: unknown }): void {
  for (const listener of eventStreamListeners) {
    try {
      listener(event);
    } catch (err) {
      log.warn('SSE listener error, removing stale listener', {
        error: err instanceof Error ? err.message : String(err),
      });
      eventStreamListeners.delete(listener);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a failed Result into a JSON error response.
 */
function resultErrorResponse(error: AppError): Response {
  return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
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

  // Dev mode: return all teams
  if (auth.authMethod === 'dev') {
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

    try {
      const teamIds = await getUserTeamIds(auth, db);

      if (teamIds.length === 0) {
        return json({ ok: true, data: { items: [] } });
      }

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
        const result = await eventSourceService.listByTeam(teamIdFilter);
        if (!result.ok) return resultErrorResponse(result.error);
        return json({ ok: true, data: { items: result.value.map(stripSourceSecret) } });
      }

      // List sources across all user's teams
      const allSources = await Promise.all(
        teamIds.map((tid) => eventSourceService.listByTeam(tid))
      );

      const items = allSources.filter((r) => r.ok).flatMap((r) => (r.ok ? r.value : []));

      return json({ ok: true, data: { items: items.map(stripSourceSecret) } });
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
  // Event Subscriptions
  // =========================================================================

  // GET /subscriptions - List subscriptions (filter by eventSourceId or targetProjectId)
  app.get('/subscriptions', async (c) => {
    const auth = c.get('auth');
    const eventSourceId = c.req.query('eventSourceId');
    const targetProjectId = c.req.query('targetProjectId');

    try {
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

        const result = await eventSubscriptionService.listBySource(eventSourceId);
        if (!result.ok) return resultErrorResponse(result.error);
        return json({ ok: true, data: { items: result.value } });
      }

      if (targetProjectId) {
        if (!isValidId(targetProjectId)) {
          return json(
            { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid targetProjectId' } },
            400
          );
        }

        // Verify user has access to the project's team
        const teamIds = await getUserTeamIds(auth, db);
        const projectTeam = await db
          .select({ teamId: teamProjects.teamId })
          .from(teamProjects)
          .where(eq(teamProjects.projectId, targetProjectId));

        const hasAccess = projectTeam.some((tp) => teamIds.includes(tp.teamId));
        if (!hasAccess) {
          return json(
            { ok: false, error: { code: 'FORBIDDEN', message: 'No access to this project' } },
            403
          );
        }

        const result = await eventSubscriptionService.listByProject(targetProjectId);
        if (!result.ok) return resultErrorResponse(result.error);
        return json({ ok: true, data: { items: result.value } });
      }

      // No filter provided: list all subscriptions for user's teams' sources
      const teamIds = await getUserTeamIds(auth, db);
      if (teamIds.length === 0) {
        return json({ ok: true, data: { items: [] } });
      }

      const sources = await db
        .select({ id: eventSources.id })
        .from(eventSources)
        .where(inArray(eventSources.teamId, teamIds));

      if (sources.length === 0) {
        return json({ ok: true, data: { items: [] } });
      }

      const sourceIds = sources.map((s) => s.id);
      const subscriptions = await db
        .select()
        .from(eventSubscriptions)
        .where(inArray(eventSubscriptions.eventSourceId, sourceIds))
        .orderBy(desc(eventSubscriptions.createdAt));

      return json({ ok: true, data: { items: subscriptions } });
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
          ? `${items[items.length - 1]!.receivedAt}|${items[items.length - 1]!.id}`
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
  app.get('/stream', () => {
    if (activeSSEConnections >= MAX_SSE_CONNECTIONS) {
      return json(
        {
          ok: false,
          error: { code: 'TOO_MANY_CONNECTIONS', message: 'SSE connection limit reached' },
        },
        429
      );
    }
    activeSSEConnections++;

    let listener: EventStreamListener | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;
    let streamClosed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (data: unknown) => {
          if (streamClosed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch (sendErr) {
            log.warn('SSE send failed, cleaning up connection', {
              error: sendErr instanceof Error ? sendErr.message : String(sendErr),
            });
            streamClosed = true;
            if (pingInterval) clearInterval(pingInterval);
            if (listener) eventStreamListeners.delete(listener);
            activeSSEConnections = Math.max(0, activeSSEConnections - 1);
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        };

        // Send initial connected event
        send({ type: 'connected', timestamp: new Date().toISOString() });

        listener = send;
        eventStreamListeners.add(listener);

        // Keep-alive ping every 15s
        pingInterval = setInterval(() => {
          if (streamClosed) {
            if (pingInterval) clearInterval(pingInterval);
            return;
          }
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            if (!streamClosed) {
              streamClosed = true;
              if (pingInterval) clearInterval(pingInterval);
              if (listener) eventStreamListeners.delete(listener);
              activeSSEConnections = Math.max(0, activeSSEConnections - 1);
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            }
          }
        }, 15_000);
      },
      cancel() {
        if (streamClosed) return;
        streamClosed = true;
        activeSSEConnections = Math.max(0, activeSSEConnections - 1);
        if (pingInterval) clearInterval(pingInterval);
        if (listener) eventStreamListeners.delete(listener);
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
