/**
 * CLI Monitor API Routes
 *
 * Daemon → Server: register, heartbeat, ingest, deregister
 * Frontend → Server: status, sessions, stream (SSE)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { acquireSseSlot, releaseSseSlot } from '../../lib/events/event-router.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { CliMonitorService } from '../../services/cli-monitor/cli-monitor.service.js';
import type { CliSession } from '../../services/cli-monitor/types.js';
import { parseLimit, parseOffset, requireQueryParam } from '../shared.js';

const logger = createLogger('routes:cli-monitor');

// ── Zod Schemas ──

const registerSchema = z.object({
  daemonId: z.string().min(1).max(200),
  pid: z.number().int().positive(),
  version: z.string().min(1).max(50),
  watchPath: z.string().min(1).max(1000),
  capabilities: z.array(z.string()).default([]),
  startedAt: z.number().optional(),
});

const heartbeatSchema = z.object({
  daemonId: z.string().min(1).max(200),
  sessionCount: z.number().int().nonnegative().default(0),
});

const ingestSchema = z.object({
  daemonId: z.string().min(1).max(200),
  sessions: z
    .array(
      z.object({
        sessionId: z.string().min(1),
        filePath: z.string(),
        cwd: z.string(),
        projectName: z.string(),
        projectHash: z.string().optional().default(''),
        status: z.enum(['working', 'waiting_for_approval', 'waiting_for_input', 'idle']),
        messageCount: z.number().int().nonnegative(),
        turnCount: z.number().int().nonnegative(),
        tokenUsage: z.object({
          inputTokens: z.number().nonnegative().default(0),
          outputTokens: z.number().nonnegative().default(0),
          cacheCreationTokens: z.number().nonnegative().default(0),
          cacheReadTokens: z.number().nonnegative().default(0),
          ephemeral5mTokens: z.number().nonnegative().optional(),
          ephemeral1hTokens: z.number().nonnegative().optional(),
        }),
        startedAt: z.number(),
        lastActivityAt: z.number(),
        lastReadOffset: z.number().nonnegative().default(0),
        isSubagent: z.boolean().default(false),
        gitBranch: z.string().optional(),
        goal: z.string().max(500).optional(),
        recentOutput: z.string().max(1000).optional(),
        pendingToolUse: z
          .object({
            toolName: z.string(),
            toolId: z.string(),
          })
          .optional(),
        model: z.string().optional(),
        parentSessionId: z.string().optional(),
        slug: z.string().max(200).optional(),
        version: z.string().max(100).optional(),
        permissionMode: z.string().max(50).optional(),
        maxThinkingTokens: z.number().int().nonnegative().optional(),
        isSidechain: z.boolean().optional(),
        lastTurnDurationMs: z.number().nonnegative().optional(),
        avgTurnDurationMs: z.number().nonnegative().optional(),
        queueOperations: z
          .array(
            z.object({
              operation: z.string(),
              timestamp: z.number(),
              content: z.string().max(200).optional(),
              version: z.string().max(100).optional(),
            })
          )
          .max(20)
          .optional(),
        recentToolInvocations: z
          .array(
            z.object({
              toolName: z.string(),
              toolId: z.string(),
              timestamp: z.number(),
              isError: z.boolean().optional(),
              durationMs: z.number().nonnegative().optional(),
              resultNumFiles: z.number().int().nonnegative().optional(),
              resultNumLines: z.number().int().nonnegative().optional(),
            })
          )
          .max(50)
          .optional(),
        topology: z
          .object({
            sessionId: z.string(),
            agentId: z.string().optional(),
            agentType: z.string(),
            parentSessionId: z.string().optional(),
            childSessionIds: z.array(z.string()).default([]),
            depth: z.number().int().nonnegative().default(0),
            spawnedAt: z.number().optional(),
            completedAt: z.number().optional(),
            status: z.string(),
            tokenUsage: z.object({
              inputTokens: z.number().nonnegative().default(0),
              outputTokens: z.number().nonnegative().default(0),
              cacheCreationTokens: z.number().nonnegative().default(0),
              cacheReadTokens: z.number().nonnegative().default(0),
              ephemeral5mTokens: z.number().nonnegative().optional(),
              ephemeral1hTokens: z.number().nonnegative().optional(),
            }),
            turnCount: z.number().int().nonnegative().default(0),
            messageCount: z.number().int().nonnegative().default(0),
          })
          .optional(),
        performanceMetrics: z
          .object({
            compactionCount: z.number().int().nonnegative().default(0),
            lastCompactionAt: z.number().nullable().default(null),
            compactionEvents: z
              .array(
                z.object({
                  type: z.enum(['compact', 'microcompact']),
                  timestamp: z.number(),
                  trigger: z.string(),
                  preTokens: z.number().nonnegative(),
                  tokensSaved: z.number().nonnegative().optional(),
                  sessionId: z.string(),
                  parentSessionId: z.string().optional(),
                  compactedToolIds: z.array(z.string()).optional(),
                })
              )
              .default([]),
            recentTurns: z
              .array(
                z.object({
                  turnNumber: z.number().int().nonnegative(),
                  inputTokens: z.number().nonnegative(),
                  outputTokens: z.number().nonnegative(),
                  cacheReadTokens: z.number().nonnegative(),
                  cacheCreationTokens: z.number().nonnegative(),
                  timestamp: z.number(),
                  durationMs: z.number().nonnegative().optional(),
                })
              )
              .default([]),
            cacheHitRatio: z.number().min(0).max(1).default(0),
            contextWindowUsed: z.number().nonnegative().default(0),
            contextWindowLimit: z.number().nonnegative().default(0),
            contextPressure: z.number().min(0).max(1).default(0),
            healthStatus: z.enum(['healthy', 'warning', 'critical']).default('healthy'),
          })
          .optional(),
      })
    )
    .max(500)
    .default([]),
  removedSessionIds: z.array(z.string()).max(500).default([]),
});

const deregisterSchema = z.object({
  daemonId: z.string().min(1).max(200),
});

// ── Constants ──

const MAX_BODY_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * F05-03: CLI monitor SSE connections now share the EventRouter with the main
 * `/api/events` stream, so the global cap applies across both.
 */
const CLI_MONITOR_SSE_ROUTE = '/api/cli-monitor/stream';

// ── Helpers ──

function validationError(
  c: { json: (data: unknown, status: number) => Response },
  issues: z.ZodIssue[]
) {
  return c.json(
    {
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: issues[0]?.message ?? 'Invalid payload' },
    },
    400
  );
}

function invalidJsonError(c: { json: (data: unknown, status: number) => Response }) {
  return c.json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400);
}

function checkBodySize(c: {
  req: { header: (name: string) => string | undefined };
  json: (data: unknown, status: number) => Response;
}): Response | null {
  const contentLength = c.req.header('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE_BYTES) {
    return c.json(
      {
        ok: false,
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 5MB limit' },
      },
      413
    );
  }
  return null;
}

// ── Route Factory ──

interface CliMonitorDeps {
  cliMonitorService: CliMonitorService;
}

/** Parse and validate a JSON POST body against a Zod schema.
 *  Returns the parsed data on success, or an error Response on failure. */
async function parseBody<T>(
  c: {
    req: { header: (name: string) => string | undefined; json: () => Promise<unknown> };
    json: (data: unknown, status: number) => Response;
  },
  schema: z.ZodType<T>
): Promise<T | Response> {
  const sizeError = checkBodySize(c);
  if (sizeError) return sizeError;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return invalidJsonError(c);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return validationError(c, parsed.error.issues);
  }
  return parsed.data;
}

export function createCliMonitorRoutes({ cliMonitorService }: CliMonitorDeps) {
  const app = new Hono();

  // ── Daemon → Server ──

  // POST /register — Daemon announces itself
  app.post('/register', async (c) => {
    const data = await parseBody(c, registerSchema);
    if (data instanceof Response) return data;
    const registerResult = cliMonitorService.registerDaemon({
      daemonId: data.daemonId,
      pid: data.pid,
      version: data.version,
      watchPath: data.watchPath,
      capabilities: data.capabilities,
      startedAt: data.startedAt || Date.now(),
    });
    if (!registerResult.ok) {
      return c.json(
        {
          ok: false,
          error: { code: registerResult.error.code, message: registerResult.error.message },
        },
        500
      );
    }
    return c.json({ ok: true });
  });

  // POST /heartbeat — Daemon keepalive
  app.post('/heartbeat', async (c) => {
    const data = await parseBody(c, heartbeatSchema);
    if (data instanceof Response) return data;
    const heartbeatResult = cliMonitorService.handleHeartbeat(data.daemonId, data.sessionCount);
    if (!heartbeatResult.ok) {
      return c.json(
        {
          ok: false,
          error: { code: heartbeatResult.error.code, message: heartbeatResult.error.message },
        },
        500
      );
    }
    if (heartbeatResult.value === 'ok') {
      return c.json({ ok: true });
    }
    // Tell daemon to re-register so it can recover
    return c.json(
      {
        ok: false,
        error: { code: 'REREGISTER', message: 'Daemon not recognized — please re-register' },
      },
      409
    );
  });

  // POST /ingest — Daemon pushes session updates
  app.post('/ingest', async (c) => {
    const data = await parseBody(c, ingestSchema);
    if (data instanceof Response) return data;
    const accepted = cliMonitorService.ingestSessions(
      data.daemonId,
      data.sessions as CliSession[],
      data.removedSessionIds
    );
    if (!accepted) {
      return c.json(
        { ok: false, error: { code: 'UNKNOWN_DAEMON', message: 'Daemon not registered' } },
        404
      );
    }
    return c.json({ ok: true });
  });

  // POST /deregister — Daemon shutting down
  app.post('/deregister', async (c) => {
    const data = await parseBody(c, deregisterSchema);
    if (data instanceof Response) return data;
    cliMonitorService.deregisterDaemon(data.daemonId);
    return c.json({ ok: true });
  });

  // ── Frontend → Server ──

  // GET /status — Check if daemon is connected
  app.get('/status', (c) => {
    return c.json({ ok: true, data: cliMonitorService.getStatus() });
  });

  // GET /sessions — List sessions with optional pagination
  app.get('/sessions', (c) => {
    const allSessions = cliMonitorService
      .getSessions()
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const total = allSessions.length;

    const hasPagination = c.req.query('limit') !== undefined || c.req.query('offset') !== undefined;
    let sessions = allSessions;
    if (hasPagination) {
      const limit = parseLimit(c, 100, 500);
      const offset = parseOffset(c);
      sessions = allSessions.slice(offset, offset + limit);
    }

    return c.json({
      ok: true,
      data: {
        sessions,
        total,
        connected: cliMonitorService.isDaemonConnected(),
      },
    });
  });

  // GET /history — Query historical sessions from DB
  app.get('/history', (c) => {
    const projectHash = c.req.query('projectHash');
    const sinceParam = c.req.query('since');

    const since = sinceParam ? Number.parseInt(sinceParam, 10) : undefined;
    const limit = c.req.query('limit') !== undefined ? parseLimit(c, 50, 500) : undefined;

    try {
      const sessions = cliMonitorService.getHistoricalSessions({
        projectHash: projectHash || undefined,
        since: since && !Number.isNaN(since) ? since : undefined,
        limit,
      });

      return c.json({
        ok: true,
        data: { sessions, total: sessions.length },
      });
    } catch (err) {
      logger.error('/history query failed', { error: err });
      return c.json(
        { ok: false, error: { code: 'DB_ERROR', message: 'Failed to query historical sessions' } },
        500
      );
    }
  });

  // GET /stream — SSE endpoint for live updates
  app.get('/stream', (c) => {
    // F05-03: shared EventRouter enforces global + per-user caps across all SSE routes.
    const auth = (c.get as (key: string) => unknown)('auth') as { userId?: string } | undefined;
    const userId = auth?.userId ?? null;
    const acquire = acquireSseSlot(CLI_MONITOR_SSE_ROUTE, userId);
    if (!acquire.ok) {
      const status = acquire.code === 'USER_QUOTA_EXCEEDED' ? 429 : 503;
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: acquire.code,
            message:
              acquire.code === 'USER_QUOTA_EXCEEDED'
                ? `Per-user SSE quota (${acquire.perUserCap}) reached`
                : `Global SSE capacity (${acquire.globalCap}) reached`,
          },
        }),
        {
          status,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(acquire.retryAfterSeconds),
          },
        }
      );
    }

    let unsubscribe: (() => void) | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    // RS-003: Guard flag to prevent double cleanup (same pattern as events.ts).
    // Both the ping handler catch block and the cancel() callback can trigger
    // cleanup -- this flag ensures resources are released exactly once.
    let cleaned = false;

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      releaseSseSlot(CLI_MONITOR_SSE_ROUTE, userId);
      if (pingInterval) clearInterval(pingInterval);
      if (unsubscribe) unsubscribe();
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (data: unknown) => {
          if (cleaned) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch (err) {
            logger.error('SSE send error', { error: err });
          }
        };

        // 1. Send snapshot (include historical DB sessions when daemon is offline)
        const liveSessions = cliMonitorService.getSessions();
        let snapshotSessions: CliSession[];
        if (liveSessions.length > 0) {
          snapshotSessions = liveSessions;
        } else {
          try {
            snapshotSessions = cliMonitorService.getHistoricalSessions({ limit: 100 });
          } catch (err) {
            logger.error('SSE snapshot: historical query failed', { error: err });
            snapshotSessions = [];
          }
        }
        send({
          type: 'cli-monitor:snapshot',
          sessions: snapshotSessions,
          daemon: cliMonitorService.getDaemon(),
          connected: cliMonitorService.isDaemonConnected(),
        });

        // 2. Subscribe to live updates
        unsubscribe = cliMonitorService.addRealtimeSubscriber((event) => {
          send({
            type: event.type,
            ...(event.data && typeof event.data === 'object' && !Array.isArray(event.data)
              ? event.data
              : {}),
          });
        });

        // 3. Keep-alive ping every 15s
        pingInterval = setInterval(() => {
          if (cleaned) {
            if (pingInterval) clearInterval(pingInterval);
            return;
          }
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            // Stream closed — clean up using guard (RS-003)
            cleanup();
            try {
              controller.close();
            } catch {
              /* already closed */
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

  // GET /topology — Get topology graph for a root session
  app.get('/topology', (c) => {
    const { value: rootSessionId, error: rootSessionIdError } = requireQueryParam(
      c,
      'rootSessionId'
    );
    if (rootSessionIdError) return rootSessionIdError;

    const nodes = cliMonitorService.getTopologyGraph(rootSessionId);
    if (!nodes) {
      return c.json(
        {
          ok: false,
          error: { code: 'SESSION_NOT_FOUND', message: `Session ${rootSessionId} not found` },
        },
        404
      );
    }

    return c.json({ ok: true, data: { nodes, rootSessionId } });
  });

  return app;
}
