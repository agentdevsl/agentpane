/**
 * Session routes
 */

import { Hono } from 'hono';
import type { SessionStatus } from '../../db/schema/shared/enums.js';
import { SESSION_STATUS } from '../../db/schema/shared/enums.js';
import type { DurableStreamsService } from '../../services/durable-streams.service.js';
import type { SessionService } from '../../services/session.service.js';
import { corsHeaders, isValidId, json } from '../shared.js';
import { createSessionSchema, exportSessionSchema, parseBody } from '../validation.js';

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
    const data = event.data as Record<string, unknown>;

    lines.push(`### ${time} - ${event.type}`);
    lines.push('');

    // Format content based on event type
    if (event.type === 'container-agent:message') {
      const role = (data.role as string) || 'unknown';
      const content = (data.content as string) || '';
      lines.push(`**${role}:** ${content}`);
    } else if (event.type.includes('tool')) {
      const toolName =
        (data.toolName as string) || (data.tool as string) || (data.name as string) || 'unknown';
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
    const data = event.data as Record<string, unknown>;

    const role = (data.role as string) || '';
    const tool = (data.toolName as string) || (data.tool as string) || (data.name as string) || '';
    let content = (data.content as string) || '';

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
  durableStreamsService?: DurableStreamsService;
}

// Track SSE connections for cleanup
const sseConnections = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();

export function createSessionsRoutes({ sessionService, durableStreamsService }: SessionsDeps) {
  const app = new Hono();

  // GET /api/sessions
  app.get('/', async (c) => {
    const projectId = c.req.query('projectId');
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    if (Number.isNaN(limit) || Number.isNaN(offset) || limit < 1 || offset < 0) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'INVALID_PARAMS',
            message: 'limit and offset must be non-negative integers',
          },
        },
        400
      );
    }

    try {
      if (projectId) {
        // Use filtered query when projectId is provided
        const rawStatuses = c.req.query('status')?.split(',');
        const status = rawStatuses?.filter((s): s is SessionStatus =>
          (SESSION_STATUS as readonly string[]).includes(s)
        );
        const agentId = c.req.query('agentId');
        const search = c.req.query('search');
        const dateFrom = c.req.query('dateFrom');
        const dateTo = c.req.query('dateTo');

        const result = await sessionService.listSessionsWithFilters(projectId, {
          status,
          agentId,
          search,
          dateFrom,
          dateTo,
          limit,
          offset,
        });

        if (!result.ok) {
          return json({ ok: false, error: result.error }, result.error.status ?? 400);
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

      // Fallback: no projectId filter (existing behavior)
      const result = await sessionService.list({ limit, offset });
      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 400);
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
    } catch (error) {
      console.error('[Sessions] List error:', error);
      return json(
        { ok: false, error: { code: 'SERVER_ERROR', message: 'Failed to list sessions' } },
        500
      );
    }
  });

  // POST /api/sessions
  app.post('/', async (c) => {
    try {
      const rawBody = await c.req.json();
      const parsed = parseBody(createSessionSchema, rawBody);
      if (!parsed.ok) return parsed.response;
      const { projectId, taskId, agentId, title } = parsed.data;

      const result = await sessionService.create({ projectId, taskId, agentId, title });
      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 400);
      }

      return json({ ok: true, data: result.value }, 201);
    } catch (error) {
      console.error('[Sessions] Create error:', error);
      return json(
        { ok: false, error: { code: 'SERVER_ERROR', message: 'Failed to create session' } },
        500
      );
    }
  });

  // GET /api/sessions/:id/events
  app.get('/:id/events', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid session ID format' } },
        400
      );
    }

    const limit = parseInt(c.req.query('limit') ?? '100', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    try {
      const result = await sessionService.getEventsBySession(id, { limit, offset });
      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 404);
      }

      return json({
        ok: true,
        data: result.value,
        pagination: { total: result.value.length, limit, offset },
      });
    } catch (error) {
      console.error('[Sessions] Get events error:', error);
      return json(
        { ok: false, error: { code: 'SERVER_ERROR', message: 'Failed to get session events' } },
        500
      );
    }
  });

  // GET /api/sessions/:id/summary
  app.get('/:id/summary', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid session ID format' } },
        400
      );
    }

    try {
      const result = await sessionService.getSessionSummary(id);
      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 404);
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
    } catch (error) {
      console.error('[Sessions] Get summary error:', error);
      return json(
        { ok: false, error: { code: 'SERVER_ERROR', message: 'Failed to get session summary' } },
        500
      );
    }
  });

  // POST /api/sessions/:id/export - Export session in various formats
  app.post('/:id/export', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid session ID format' } },
        400
      );
    }

    try {
      const rawBody = await c.req.json();
      const parsed = parseBody(exportSessionSchema, rawBody);
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
    } catch (error) {
      console.error('[Sessions] Export error:', error);
      return json(
        { ok: false, error: { code: 'SERVER_ERROR', message: 'Failed to export session' } },
        500
      );
    }
  });

  // GET /api/sessions/:id/stream - Server-Sent Events for real-time session updates
  app.get('/:id/stream', async (c) => {
    const sessionId = c.req.param('id');

    if (!isValidId(sessionId)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid session ID format' } },
        400
      );
    }

    // Verify session exists
    const sessionResult = await sessionService.getById(sessionId);
    if (!sessionResult.ok) {
      return json({ ok: false, error: sessionResult.error }, sessionResult.error.status ?? 404);
    }

    // Parse optional offset for resumption
    const offsetParam = c.req.query('offset');
    const fromOffset = offsetParam ? parseInt(offsetParam, 10) : 0;

    // Create SSE stream with keep-alive
    let pingInterval: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    // Helper function for consistent SSE cleanup
    const cleanupSSEConnection = (
      id: string,
      controller: ReadableStreamDefaultController<Uint8Array> | null,
      refs: {
        pingInterval: ReturnType<typeof setInterval> | null;
        unsubscribe: (() => void) | null;
      }
    ) => {
      if (refs.pingInterval) {
        clearInterval(refs.pingInterval);
        pingInterval = null;
      }
      if (refs.unsubscribe) {
        refs.unsubscribe();
        unsubscribe = null;
      }
      if (controller) {
        const controllers = sseConnections.get(id);
        if (controllers) {
          controllers.delete(controller);
          if (controllers.size === 0) {
            sseConnections.delete(id);
          }
        }
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        streamController = controller;
        // Store controller for this session
        const controllers = sseConnections.get(sessionId) ?? new Set();
        controllers.add(controller);
        sseConnections.set(sessionId, controllers);

        console.log(
          `[SSE] Connection established for session ${sessionId}, fromOffset=${fromOffset}`
        );

        // Send initial connected event
        const connectedData = JSON.stringify({
          type: 'connected',
          sessionId,
          offset: fromOffset,
          timestamp: Date.now(),
        });
        controller.enqueue(new TextEncoder().encode(`data: ${connectedData}\n\n`));

        // Subscribe to durable streams if available
        if (durableStreamsService) {
          // First, send any existing events from the stream (for replay)
          let replayedCount = 0;
          const server = durableStreamsService.getServer();
          if ('getEvents' in server && typeof server.getEvents === 'function') {
            const existingEvents = (
              server as {
                getEvents: (
                  id: string
                ) => Array<{ type: string; data: unknown; offset: number; timestamp: number }>;
              }
            ).getEvents(sessionId);

            // Filter events by offset and count how many will be replayed
            const eventsToReplay = existingEvents.filter(
              (event: { offset: number }) => event.offset >= fromOffset
            );
            console.log(
              `[SSE] Replaying ${eventsToReplay.length} events for session ${sessionId} (total stored: ${existingEvents.length}, fromOffset: ${fromOffset})`
            );

            for (const event of eventsToReplay) {
              const eventData = JSON.stringify({
                type: event.type,
                data: event.data,
                timestamp: event.timestamp,
                offset: event.offset,
              });
              controller.enqueue(new TextEncoder().encode(`data: ${eventData}\n\n`));
            }
            replayedCount = eventsToReplay.length;
          } else {
            console.log(
              `[SSE] Server does not have getEvents method for session ${sessionId}, no replay available`
            );
          }

          // Fallback: if in-memory store had no events, replay from database
          // This handles server restarts where in-memory events are lost
          if (replayedCount === 0) {
            try {
              const dbResult = await sessionService.getEventsBySession(sessionId, {
                limit: 10000,
                offset: 0,
              });
              if (dbResult.ok && dbResult.value.length > 0) {
                // Assign synthetic offsets and filter by fromOffset (same as in-memory path)
                let syntheticOffset = 1;
                const dbEventsWithOffsets = dbResult.value.map((dbEvent) => {
                  const eventOffset =
                    typeof (dbEvent as Record<string, unknown>).offset === 'number'
                      ? ((dbEvent as Record<string, unknown>).offset as number)
                      : syntheticOffset++;
                  return { dbEvent, eventOffset };
                });
                const filteredDbEvents = dbEventsWithOffsets.filter(
                  ({ eventOffset }) => eventOffset >= fromOffset
                );
                console.log(
                  `[SSE] Replaying ${filteredDbEvents.length} events from database for session ${sessionId} (total stored: ${dbResult.value.length}, fromOffset: ${fromOffset})`
                );
                for (const { dbEvent, eventOffset } of filteredDbEvents) {
                  const eventData = JSON.stringify({
                    type: dbEvent.type,
                    data: dbEvent.data,
                    timestamp: dbEvent.timestamp,
                    offset: eventOffset,
                  });
                  controller.enqueue(new TextEncoder().encode(`data: ${eventData}\n\n`));
                }
              }
            } catch (err) {
              console.error(
                `[SSE] Failed to replay events from database for session ${sessionId}:`,
                err
              );
            }
          }

          // Then subscribe to new events (after replay is complete to avoid race conditions)
          unsubscribe = durableStreamsService.addSubscriber(sessionId, (event) => {
            try {
              if (typeof event.offset === 'number' && event.offset < fromOffset) {
                return;
              }
              console.log(
                `[SSE] Sending live event to session ${sessionId}: type=${event.type}, offset=${event.offset}`
              );
              const eventData = JSON.stringify({
                type: event.type,
                data: event.data,
                timestamp: event.timestamp,
                offset: typeof event.offset === 'number' ? event.offset : 0,
              });
              controller.enqueue(new TextEncoder().encode(`data: ${eventData}\n\n`));
            } catch (err) {
              // Connection closed - log and clean up
              console.debug(`[SSE] Connection closed for session ${sessionId}:`, err);
              cleanupSSEConnection(sessionId, controller, { pingInterval, unsubscribe });
            }
          });
        } else {
          console.log(`[SSE] No durableStreamsService available for session ${sessionId}`);
        }

        // Send keep-alive ping every 15 seconds
        pingInterval = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(`: ping\n\n`));
          } catch (err) {
            // Connection closed during ping - log and clean up
            console.debug(`[SSE] Ping failed for session ${sessionId}, cleaning up:`, err);
            cleanupSSEConnection(sessionId, controller, { pingInterval, unsubscribe });
          }
        }, 15000);
      },
      cancel() {
        console.log(`[SSE] Connection cancelled/closed for session ${sessionId}`);
        cleanupSSEConnection(sessionId, streamController, { pingInterval, unsubscribe });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': corsHeaders['Access-Control-Allow-Origin'],
        'Access-Control-Allow-Headers': corsHeaders['Access-Control-Allow-Headers'],
      },
    });
  });

  // GET /api/sessions/:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid session ID format' } },
        400
      );
    }

    try {
      const result = await sessionService.getById(id);
      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 404);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      console.error('[Sessions] Get error:', error);
      return json(
        { ok: false, error: { code: 'SERVER_ERROR', message: 'Failed to get session' } },
        500
      );
    }
  });

  // DELETE /api/sessions/:id
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');

    if (!isValidId(id)) {
      return json(
        { ok: false, error: { code: 'INVALID_ID', message: 'Invalid session ID format' } },
        400
      );
    }

    try {
      const result = await sessionService.delete(id);
      if (!result.ok) {
        return json({ ok: false, error: result.error }, result.error.status ?? 404);
      }

      return json({ ok: true, data: result.value });
    } catch (error) {
      console.error('[Sessions] Delete error:', error);
      return json(
        { ok: false, error: { code: 'SERVER_ERROR', message: 'Failed to delete session' } },
        500
      );
    }
  });

  return app;
}
