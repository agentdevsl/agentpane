/**
 * Session routes
 */

import { Hono } from 'hono';
import type { SessionStatus } from '../../db/schema/shared/enums.js';
import { SESSION_STATUS } from '../../db/schema/shared/enums.js';
import type { SessionService } from '../../services/session.service.js';
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
}

export function createSessionsRoutes({ sessionService }: SessionsDeps) {
  const app = new Hono();

  // GET /api/sessions
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

      return json({
        ok: true,
        data: result.value.sessions,
        pagination: {
          limit,
          offset,
          total: result.value.total,
          hasMore: result.value.sessions.length === limit,
        },
      });
    }

    // Fallback: no codespaceId filter (existing behavior)
    const result = await sessionService.list({ limit, offset });
    if (!result.ok) {
      return errorResponse(result);
    }

    return json({
      ok: true,
      data: result.value,
      pagination: {
        limit,
        offset,
        hasMore: result.value.length === limit,
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

    const limit = parseLimit(c, 100);
    const offset = parseOffset(c);
    const afterEventId = c.req.query('afterEventId') ?? undefined;

    if (afterEventId && c.req.query('offset') !== undefined) {
      return json(
        {
          ok: false,
          error: {
            code: 'INVALID_PARAMS',
            message: 'Use either offset or afterEventId, not both',
          },
        },
        400
      );
    }

    const result = await sessionService.getEventsBySession(
      id,
      afterEventId ? { limit, afterEventId } : { limit, offset }
    );
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
