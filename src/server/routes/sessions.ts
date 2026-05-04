/**
 * Session routes
 */

import { Hono } from 'hono';
import type { SessionStatus } from '../../db/schema/shared/enums.js';
import { SESSION_STATUS } from '../../db/schema/shared/enums.js';
import type { AuthContext } from '../../lib/api/auth-middleware.js';
import { decodeRequestCursor, paginate } from '../../lib/api/pagination.js';
import { applyTokenTagFilter } from '../../lib/api/rbac-middleware.js';
import type { SessionService } from '../../services/session.service.js';
import type { Database } from '../../types/database.js';
import { errorResponse, json, parseLimit, parseOffset, validateIdParam } from '../shared.js';
import { createSessionSchema, exportSessionSchema, parseJsonBody } from '../validation.js';

// Helper to format session as markdown
function formatSessionAsMarkdown(
  session: {
    id: string;
    title?: string | null;
    status: string;
    createdAt?: string;
    closedAt?: string | null;
  },
  events: Array<{ id: string; type: string; timestamp: number; data: unknown }>
): string {
  const lines: string[] = [];

  lines.push(`# Session: ${session.title || session.id}`);
  lines.push('');
  lines.push(`**Status:** ${session.status}`);
  if (session.createdAt) {
    lines.push(`**Created:** ${new Date(session.createdAt).toLocaleString()}`);
  }
  if (session.closedAt) {
    lines.push(`**Closed:** ${new Date(session.closedAt).toLocaleString()}`);
  }
  lines.push('');
  lines.push('## Events');
  lines.push('');

  for (const event of events) {
    const time = new Date(event.timestamp).toLocaleTimeString();
    // Runtime type guard: event.data may not be an object (could be null, string, etc.)
    const data: Record<string, unknown> =
      event.data != null && typeof event.data === 'object' && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : {};

    lines.push(`### ${time} - ${event.type}`);
    lines.push('');

    // Format content based on event type
    if (event.type === 'container-agent:message') {
      const role = typeof data.role === 'string' ? data.role : 'unknown';
      const content = typeof data.content === 'string' ? data.content : '';
      lines.push(`**${role}:** ${content}`);
    } else if (event.type.includes('tool')) {
      const toolName =
        (typeof data.toolName === 'string' ? data.toolName : undefined) ||
        (typeof data.tool === 'string' ? data.tool : undefined) ||
        (typeof data.name === 'string' ? data.name : undefined) ||
        'unknown';
      lines.push(`**Tool:** ${toolName}`);
      if (data.input) {
        lines.push('```json');
        lines.push(JSON.stringify(data.input, null, 2));
        lines.push('```');
      }
      if (data.output || data.result) {
        lines.push('**Output:**');
        lines.push('```');
        lines.push(String(data.output || data.result).slice(0, 500));
        lines.push('```');
      }
    } else {
      lines.push('```json');
      lines.push(JSON.stringify(data, null, 2));
      lines.push('```');
    }
    lines.push('');
  }

  return lines.join('\n');
}

// Helper to format events as CSV
function formatEventsAsCsv(
  events: Array<{ id: string; type: string; timestamp: number; data: unknown }>
): string {
  const lines: string[] = [];

  // Header
  lines.push('timestamp,type,role,tool,content');

  for (const event of events) {
    const time = new Date(event.timestamp).toISOString();
    // Runtime type guard: event.data may not be an object
    const data: Record<string, unknown> =
      event.data != null && typeof event.data === 'object' && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : {};

    const role = typeof data.role === 'string' ? data.role : '';
    const tool =
      (typeof data.toolName === 'string' ? data.toolName : undefined) ||
      (typeof data.tool === 'string' ? data.tool : undefined) ||
      (typeof data.name === 'string' ? data.name : undefined) ||
      '';
    let content = typeof data.content === 'string' ? data.content : '';

    // Escape CSV fields
    const escapeCSV = (str: string) => {
      if (str.includes('"') || str.includes(',') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    // Truncate long content for CSV
    if (content.length > 200) {
      content = `${content.slice(0, 200)}...`;
    }

    lines.push([time, event.type, role, tool, escapeCSV(content)].join(','));
  }

  return lines.join('\n');
}

interface SessionsDeps {
  sessionService: SessionService;
  db: Database;
}

export function createSessionsRoutes({ sessionService, db }: SessionsDeps) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET /api/sessions
  //
  // F07-01: two modes:
  //   (a) Filtered mode (when `codespaceId` is supplied): keeps the existing
  //       offset/total shape because the UI explicitly relies on `total` for
  //       badges and filter-count readouts. This path is documented as the
  //       legacy offset path in specs/application/api/pagination.md.
  //   (b) Global list (no `codespaceId`): cursor-paginated, sorted by
  //       `updatedAt` desc with `id` as tiebreaker. Returns the canonical
  //       `{ items, nextCursor, hasMore }` envelope.
  app.get('/', async (c) => {
    const codespaceId = c.req.query('codespaceId');
    const limit = parseLimit(c);
    const offset = parseOffset(c);

    if (codespaceId) {
      // Use filtered query when codespaceId is provided
      const rawStatuses = c.req.query('status')?.split(',');
      const status = rawStatuses?.filter((s): s is SessionStatus =>
        (SESSION_STATUS as readonly string[]).includes(s)
      );
      const agentId = c.req.query('agentId');
      const search = c.req.query('search');
      const dateFrom = c.req.query('dateFrom');
      const dateTo = c.req.query('dateTo');

      const result = await sessionService.listSessionsWithFilters(codespaceId, {
        status,
        agentId,
        search,
        dateFrom,
        dateTo,
        limit,
        offset,
      });

      if (!result.ok) {
        return errorResponse(result);
      }

      // F06-NEW-07: filter by tag scope when the token is tag-restricted.
      const auth = c.get('auth') as AuthContext | undefined;
      const filteredSessions = await applyTokenTagFilter(
        db,
        auth,
        result.value.sessions,
        (s) => s.id
      );
      // Adjust the total when a filter was applied so the UI badge counts
      // reflect what the token can actually see. When no filter is set,
      // `filteredSessions === result.value.sessions` and total is unchanged.
      const totalDelta = result.value.sessions.length - filteredSessions.length;
      const adjustedTotal = Math.max(0, result.value.total - totalDelta);

      return json({
        ok: true,
        data: filteredSessions,
        pagination: {
          limit,
          offset,
          total: auth?.tagFilter ? adjustedTotal : result.value.total,
          hasMore: filteredSessions.length === limit,
        },
      });
    }

    // F07-01: cursor-based pagination for the global session list.
    //
    // Backward-compatible envelope: `data` stays a flat array (so
    // `apiServerFetch<Session[]>` keeps working) and `pagination` exposes
    // the opaque `nextCursor` + `hasMore` flags alongside the legacy
    // `limit`/`offset`.
    //
    // Bug fix: previously only requests that carried an inbound `cursor`
    // query param went through `paginate()`; the first page (no cursor) fell
    // back to the legacy offset branch and never emitted `nextCursor`,
    // leaving clients with no way to advance beyond page 1. We now always
    // fetch `limit + 1` and run through `paginate()` so the first page
    // returns a valid `nextCursor` whenever there are more rows.
    const sortField = 'updatedAt' as const;
    const order = 'desc' as const;
    const rawCursor = c.req.query('cursor') || undefined;
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

    const result = await sessionService.list({
      // F07-01: fetch `limit + 1` so `paginate()` can detect `hasMore`
      // without a count query. When a cursor is supplied we do not apply an
      // offset (the cursor itself positions the page); when absent we keep
      // the legacy `offset` semantics so pre-cursor clients that still pass
      // `offset` continue to work.
      limit: limit + 1,
      offset: cursorPayload ? 0 : offset,
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
    const auth = c.get('auth') as AuthContext | undefined;
    const filteredItems = await applyTokenTagFilter(db, auth, result.value, (s) => s.id);

    const body = paginate(filteredItems, { limit, sortField, order });
    return json({
      ok: true,
      data: body.items,
      pagination: {
        limit,
        offset: cursorPayload ? 0 : offset,
        nextCursor: body.nextCursor,
        hasMore: body.hasMore,
      },
    });
  });

  // POST /api/sessions
  app.post('/', async (c) => {
    const parsed = await parseJsonBody(c, createSessionSchema);
    if (!parsed.ok) return parsed.response;
    const { codespaceId, taskId, agentId, title } = parsed.data;

    const result = await sessionService.create({ codespaceId, taskId, agentId, title });
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value }, 201);
  });

  // GET /api/sessions/:id/events
  app.get('/:id/events', async (c) => {
    const { id, error: idError } = validateIdParam(c, 'id');
    if (idError) return idError;

    // Default 1000 / cap 10_000. The topology view replays the full
    // session history client-side to reconstruct the workflow tree —
    // capping at 100 (the global parseLimit default) silently drops
    // earlier subagent_spawned events for any non-trivial run, so the
    // graph renders with only the most recent slice and the skill node
    // / earlier clusters appear missing. The router uses cursor / offset
    // pagination for "load earlier" anyway, so a high cap here doesn't
    // change pagination semantics — it just lets the topology fetch
    // every event in one round-trip when it asks for a large page.
    const limit = parseLimit(c, 1000, 10_000);
    const offset = parseOffset(c);
    const afterEventId = c.req.query('afterEventId') ?? undefined;

    // F05-04: "load earlier" via beforeOffset.
    // F05-06: contiguous gap-fill via fromOffset + toOffset.
    const beforeOffsetRaw = c.req.query('beforeOffset');
    const fromOffsetRaw = c.req.query('fromOffset');
    const toOffsetRaw = c.req.query('toOffset');
    const beforeOffset =
      beforeOffsetRaw !== undefined ? Number.parseInt(beforeOffsetRaw, 10) : undefined;
    const fromOffset = fromOffsetRaw !== undefined ? Number.parseInt(fromOffsetRaw, 10) : undefined;
    const toOffset = toOffsetRaw !== undefined ? Number.parseInt(toOffsetRaw, 10) : undefined;

    const hasOffset = c.req.query('offset') !== undefined;
    const hasAfter = afterEventId !== undefined;
    const hasBefore = beforeOffset !== undefined;
    const hasRange = fromOffset !== undefined || toOffset !== undefined;

    // Pagination modes are mutually exclusive. At most ONE of:
    //   1. default pagination (offset+limit)
    //   2. afterEventId (history resume)
    //   3. beforeOffset (load earlier)
    //   4. fromOffset + toOffset (gap-fill range)
    // If the client specifies more than one, return 400 rather than silently
    // picking a branch (which previously hid e.g. `beforeOffset + range`).
    const modeCount =
      (hasOffset ? 1 : 0) + (hasAfter ? 1 : 0) + (hasBefore ? 1 : 0) + (hasRange ? 1 : 0);
    if (modeCount > 1) {
      return json(
        {
          ok: false,
          error: {
            code: 'INVALID_PARAMS',
            message:
              'Use exactly one of: offset, afterEventId, beforeOffset, or (fromOffset + toOffset) — not multiple',
          },
        },
        400
      );
    }

    if (hasRange && (fromOffset === undefined || toOffset === undefined)) {
      return json(
        {
          ok: false,
          error: {
            code: 'INVALID_PARAMS',
            message: 'fromOffset and toOffset must be used together',
          },
        },
        400
      );
    }

    let result: Awaited<ReturnType<typeof sessionService.getEventsBySession>>;
    if (afterEventId) {
      result = await sessionService.getEventsBySession(id, { limit, afterEventId });
    } else if (beforeOffset !== undefined && Number.isFinite(beforeOffset)) {
      result = await sessionService.getEventsBySession(id, { limit, beforeOffset });
    } else if (
      fromOffset !== undefined &&
      toOffset !== undefined &&
      Number.isFinite(fromOffset) &&
      Number.isFinite(toOffset)
    ) {
      result = await sessionService.getEventsBySession(id, { limit, fromOffset, toOffset });
    } else {
      result = await sessionService.getEventsBySession(id, { limit, offset });
    }
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({
      ok: true,
      data: result.value,
      pagination: {
        total: result.value.length,
        limit,
        offset,
        afterEventId: afterEventId ?? null,
        beforeOffset: beforeOffset ?? null,
        fromOffset: fromOffset ?? null,
        toOffset: toOffset ?? null,
      },
    });
  });

  // GET /api/sessions/:id/summary
  app.get('/:id/summary', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await sessionService.getSessionSummary(id);
    if (!result.ok) {
      return errorResponse(result);
    }

    // Return default values if no summary exists yet
    const summary = result.value ?? {
      sessionId: id,
      durationMs: null,
      turnsCount: 0,
      tokensUsed: 0,
      filesModified: 0,
      linesAdded: 0,
      linesRemoved: 0,
      finalStatus: null,
    };

    return json({ ok: true, data: summary });
  });

  // POST /api/sessions/:id/export - Export session in various formats
  app.post('/:id/export', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const parsed = await parseJsonBody(c, exportSessionSchema);
    if (!parsed.ok) return parsed.response;
    const { format } = parsed.data;

    // Get session details
    const sessionResult = await sessionService.getById(id);
    if (!sessionResult.ok) {
      return json({ ok: false, error: sessionResult.error }, sessionResult.error.status ?? 404);
    }
    const session = sessionResult.value;

    // Get all events
    const eventsResult = await sessionService.getEventsBySession(id, { limit: 10000, offset: 0 });
    const events = eventsResult.ok ? eventsResult.value : [];

    // Generate export content based on format
    let content: string;
    let contentType: string;
    let filename: string;

    const timestamp = new Date().toISOString().slice(0, 10);
    const sessionTitle = session.title || 'session';
    const safeTitle = sessionTitle.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 50);

    switch (format) {
      case 'json':
        content = JSON.stringify({ session, events }, null, 2);
        contentType = 'application/json';
        filename = `${safeTitle}_${timestamp}.json`;
        break;

      case 'markdown':
        content = formatSessionAsMarkdown(session, events);
        contentType = 'text/markdown';
        filename = `${safeTitle}_${timestamp}.md`;
        break;

      case 'csv':
        content = formatEventsAsCsv(events);
        contentType = 'text/csv';
        filename = `${safeTitle}_events_${timestamp}.csv`;
        break;
    }

    return json({ ok: true, data: { content, contentType, filename } });
  });

  // NOTE: SSE endpoint removed — clients subscribe to Caddy durable streams
  // at /v1/stream/sessions/:id directly.

  // GET /api/sessions/:id
  app.get('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await sessionService.getById(id);
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value });
  });

  // DELETE /api/sessions/:id
  app.delete('/:id', async (c) => {
    const { id, error } = validateIdParam(c, 'id');
    if (error) return error;

    const result = await sessionService.delete(id);
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({ ok: true, data: result.value });
  });

  return app;
}
