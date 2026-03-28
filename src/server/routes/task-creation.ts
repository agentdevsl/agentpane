/**
 * Task creation with AI routes
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '../../lib/logging/logger.js';
import type { TaskCreationService } from '../../services/task-creation.service.js';
import { corsHeaders, json } from '../shared.js';
import { parseJsonBody } from '../validation.js';

const log = createLogger('task-creation-routes');

// ─── Zod Schemas for Task Creation Routes ───────────
const startSchema = z.object({
  codespaceId: z.string().min(1, 'codespaceId is required'),
});

const messageSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
  message: z.string().min(1, 'message is required'),
});

const acceptSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
  overrides: z.record(z.string(), z.unknown()).optional(),
});

const cancelSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
});

const answerSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
  questionsId: z.string().min(1, 'questionsId is required'),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
});

const skipSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
});

interface TaskCreationDeps {
  taskCreationService: TaskCreationService;
}

type TaskCreationStreamController = ReadableStreamDefaultController<Uint8Array>;

const textEncoder = new TextEncoder();
const sseConnections = new Map<string, Map<number, TaskCreationStreamController>>();
let nextSseConnectionId = 0;

function addSseConnection(sessionId: string, controller: TaskCreationStreamController): number {
  const sessionConnections =
    sseConnections.get(sessionId) ?? new Map<number, TaskCreationStreamController>();
  const connectionId = nextSseConnectionId++;
  sessionConnections.set(connectionId, controller);
  sseConnections.set(sessionId, sessionConnections);
  return connectionId;
}

function removeSseConnection(sessionId: string, connectionId: number): void {
  const sessionConnections = sseConnections.get(sessionId);
  if (!sessionConnections) {
    return;
  }

  sessionConnections.delete(connectionId);
  if (sessionConnections.size === 0) {
    sseConnections.delete(sessionId);
  }
}

function broadcastTaskCreationEvent(sessionId: string, payload: unknown): void {
  const sessionConnections = sseConnections.get(sessionId);
  if (!sessionConnections || sessionConnections.size === 0) {
    return;
  }

  const message = `data: ${JSON.stringify(payload)}\n\n`;
  for (const [connectionId, controller] of sessionConnections) {
    try {
      controller.enqueue(textEncoder.encode(message));
    } catch (error) {
      log.debug('Failed to enqueue SSE event, removing connection', {
        data: {
          sessionId,
          connectionId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      removeSseConnection(sessionId, connectionId);
    }
  }
}

function closeTaskCreationConnections(sessionId: string): void {
  const sessionConnections = sseConnections.get(sessionId);
  if (!sessionConnections) {
    return;
  }

  for (const [connectionId, controller] of sessionConnections) {
    try {
      controller.close();
    } catch {
      // Connection already closed.
    }
    removeSseConnection(sessionId, connectionId);
  }
}

/**
 * Send task creation state updates to SSE client.
 */
function sendTaskCreationSSEUpdate(
  sessionId: string,
  session: {
    messages: Array<{ id: string; role: string; content: string }>;
    pendingQuestions?: unknown;
    suggestion?: unknown;
  }
): void {
  log.debug('sendTaskCreationSSEUpdate called', {
    data: {
      sessionId,
      messageCount: session.messages.length,
      hasPendingQuestions: !!session.pendingQuestions,
      hasSuggestion: !!session.suggestion,
    },
  });

  // Send assistant message event
  const lastMessage = session.messages[session.messages.length - 1];
  if (lastMessage && lastMessage.role === 'assistant') {
    const messageData = JSON.stringify({
      type: 'task-creation:message',
      data: {
        sessionId,
        messageId: lastMessage.id,
        role: lastMessage.role,
        content: lastMessage.content,
      },
    });
    broadcastTaskCreationEvent(sessionId, JSON.parse(messageData));
  }

  // Send questions event if pending
  if (session.pendingQuestions) {
    log.debug('Sending questions event');
    const questionsData = JSON.stringify({
      type: 'task-creation:questions',
      data: {
        sessionId,
        questions: session.pendingQuestions,
      },
    });
    broadcastTaskCreationEvent(sessionId, JSON.parse(questionsData));
    log.debug('Questions event enqueued');
  } else {
    log.debug('No pendingQuestions to send');
  }

  // Send suggestion event if available (only when no pending questions)
  if (session.suggestion && !session.pendingQuestions) {
    const suggestionData = JSON.stringify({
      type: 'task-creation:suggestion',
      data: {
        sessionId,
        suggestion: session.suggestion,
      },
    });
    broadcastTaskCreationEvent(sessionId, JSON.parse(suggestionData));
  }
}

export function createTaskCreationRoutes({ taskCreationService }: TaskCreationDeps) {
  const app = new Hono();

  // POST /api/tasks/create-with-ai/start
  app.post('/start', async (c) => {
    const parsed = await parseJsonBody(c, startSchema);
    if (!parsed.ok) return parsed.response;
    const { codespaceId } = parsed.data;

    const result = await taskCreationService.startConversation(codespaceId);

    if (!result.ok) {
      return json({ ok: false, error: result.error }, 400);
    }

    return json({ ok: true, data: { sessionId: result.value.id } });
  });

  // POST /api/tasks/create-with-ai/message
  app.post('/message', async (c) => {
    const parsed = await parseJsonBody(c, messageSchema);
    if (!parsed.ok) return parsed.response;
    const { sessionId, message } = parsed.data;

    // Send message with token streaming to SSE
    const onToken = (delta: string) => {
      broadcastTaskCreationEvent(sessionId, {
        type: 'task-creation:token',
        data: { sessionId, delta },
      });
    };

    // Callback for when background processor publishes an assistant message (sends SSE event)
    const onMessage = (messageId: string, role: 'user' | 'assistant', content: string) => {
      log.debug('onMessage callback - sending SSE event');
      broadcastTaskCreationEvent(sessionId, {
        type: 'task-creation:message',
        data: { sessionId, messageId, role, content },
      });
    };

    // Callback for when background processor finds a suggestion (sends SSE event)
    const onSuggestion = (suggestion: {
      title: string;
      description: string;
      labels: string[];
      priority: string;
    }) => {
      log.debug('onSuggestion callback - sending SSE event');
      broadcastTaskCreationEvent(sessionId, {
        type: 'task-creation:suggestion',
        data: { sessionId, suggestion },
      });
    };

    const result = await taskCreationService.sendMessage(
      sessionId,
      message,
      onToken,
      onSuggestion,
      onMessage
    );

    if (!result.ok) {
      // Send error to SSE if connected
      broadcastTaskCreationEvent(sessionId, {
        type: 'task-creation:error',
        data: { sessionId, error: result.error.message },
      });
      return json({ ok: false, error: result.error }, 400);
    }

    // Send events to SSE based on session state
    log.debug('About to send SSE update', {
      data: {
        sessionId,
        hasController: sseConnections.has(sessionId),
        sseConnectionsSize: sseConnections.size,
        hasPendingQuestions: !!result.value?.pendingQuestions,
      },
    });
    if (sseConnections.has(sessionId)) {
      sendTaskCreationSSEUpdate(sessionId, result.value);
    } else {
      log.debug('No SSE controller found for session', { data: { sessionId } });
    }

    return json({ ok: true, data: { messageId: 'msg-sent' } });
  });

  // POST /api/tasks/create-with-ai/accept
  app.post('/accept', async (c) => {
    const parsed = await parseJsonBody(c, acceptSchema);
    if (!parsed.ok) return parsed.response;
    const { sessionId, overrides } = parsed.data;

    const result = await taskCreationService.acceptSuggestion(sessionId, overrides);

    if (!result.ok) {
      return json({ ok: false, error: result.error }, 400);
    }

    // Send completion to SSE
    broadcastTaskCreationEvent(sessionId, {
      type: 'task-creation:completed',
      data: { sessionId, taskId: result.value.taskId },
    });

    return json({
      ok: true,
      data: { taskId: result.value.taskId, sessionId, status: 'completed' },
    });
  });

  // POST /api/tasks/create-with-ai/cancel
  app.post('/cancel', async (c) => {
    const parsed = await parseJsonBody(c, cancelSchema);
    if (!parsed.ok) return parsed.response;
    const { sessionId } = parsed.data;

    const result = await taskCreationService.cancel(sessionId);

    if (!result.ok) {
      return json({ ok: false, error: result.error }, 400);
    }

    // Close SSE connection
    broadcastTaskCreationEvent(sessionId, {
      type: 'task-creation:cancelled',
      data: { sessionId },
    });
    closeTaskCreationConnections(sessionId);

    return json({ ok: true, data: { sessionId, status: 'cancelled' } });
  });

  // POST /api/tasks/create-with-ai/answer
  app.post('/answer', async (c) => {
    const parsed = await parseJsonBody(c, answerSchema);
    if (!parsed.ok) return parsed.response;
    const { sessionId, questionsId, answers } = parsed.data;

    // The service publishes SSE processing/update events internally
    const result = await taskCreationService.answerQuestions(sessionId, questionsId, answers);

    if (!result.ok) {
      broadcastTaskCreationEvent(sessionId, {
        type: 'task-creation:error',
        data: { sessionId, error: result.error.message },
      });
      return json({ ok: false, error: result.error }, 400);
    }

    // Send SSE update based on session state, but skip for duplicate submissions
    // since the session has already advanced past this question round
    const alreadyProcessed = 'alreadyProcessed' in result.value && result.value.alreadyProcessed;
    if (!alreadyProcessed) {
      sendTaskCreationSSEUpdate(sessionId, result.value);
    }

    return json({
      ok: true,
      data: { sessionId, status: result.value.status, duplicate: !!alreadyProcessed },
    });
  });

  // POST /api/tasks/create-with-ai/skip
  app.post('/skip', async (c) => {
    const parsed = await parseJsonBody(c, skipSchema);
    if (!parsed.ok) return parsed.response;
    const { sessionId } = parsed.data;

    const result = await taskCreationService.skipQuestions(sessionId);

    if (!result.ok) {
      broadcastTaskCreationEvent(sessionId, {
        type: 'task-creation:error',
        data: { sessionId, error: result.error.message },
      });
      return json({ ok: false, error: result.error }, 400);
    }

    // Send events to SSE based on session state
    sendTaskCreationSSEUpdate(sessionId, result.value);

    return json({ ok: true, data: { sessionId, status: result.value.status } });
  });

  // GET /api/tasks/create-with-ai/stream
  app.get('/stream', async (c) => {
    const sessionId = c.req.query('sessionId');
    log.debug('Stream request', { data: { sessionId } });

    if (!sessionId) {
      log.debug('No sessionId provided');
      return json(
        { ok: false, error: { code: 'INVALID_INPUT', message: 'sessionId is required' } },
        400
      );
    }

    // Verify session exists
    const session = taskCreationService.getSession(sessionId);
    log.debug('Session lookup result', { data: { found: !!session } });
    if (!session) {
      log.debug('Session not found, returning 404');
      return json(
        { ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } },
        404
      );
    }

    // Create SSE stream with keep-alive
    let pingInterval: ReturnType<typeof setInterval> | null = null;
    let connectionId: number | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Store controller for this session
        connectionId = addSseConnection(sessionId, controller);

        // Send initial connected event
        const connectedData = JSON.stringify({ type: 'connected', sessionId });
        controller.enqueue(textEncoder.encode(`data: ${connectedData}\n\n`));

        // Send immediate ping to keep connection alive
        controller.enqueue(textEncoder.encode(`: ping\n\n`));

        // Send keep-alive ping every 5 seconds
        pingInterval = setInterval(() => {
          try {
            controller.enqueue(textEncoder.encode(`: ping\n\n`));
          } catch (error) {
            // Connection likely closed - clean up interval
            log.debug('Ping failed, closing connection', {
              data: { error: error instanceof Error ? error.message : String(error) },
            });
            if (pingInterval) {
              clearInterval(pingInterval);
              pingInterval = null;
            }
            if (connectionId !== null) {
              removeSseConnection(sessionId, connectionId);
            }
          }
        }, 5000);
      },
      cancel() {
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        if (connectionId !== null) {
          removeSseConnection(sessionId, connectionId);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders,
      },
    });
  });

  return app;
}
