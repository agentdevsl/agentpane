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
  projectId: z.string().min(1, 'projectId is required'),
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

// Store active SSE connections for streaming
const sseConnections = new Map<string, ReadableStreamDefaultController<Uint8Array>>();

/**
 * Send task creation state updates to SSE client.
 */
function sendTaskCreationSSEUpdate(
  controller: ReadableStreamDefaultController<Uint8Array>,
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
    controller.enqueue(new TextEncoder().encode(`data: ${messageData}\n\n`));
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
    controller.enqueue(new TextEncoder().encode(`data: ${questionsData}\n\n`));
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
    controller.enqueue(new TextEncoder().encode(`data: ${suggestionData}\n\n`));
  }
}

export function createTaskCreationRoutes({ taskCreationService }: TaskCreationDeps) {
  const app = new Hono();

  // POST /api/tasks/create-with-ai/start
  app.post('/start', async (c) => {
    try {
      const parsed = await parseJsonBody(c, startSchema);
      if (!parsed.ok) return parsed.response;
      const { projectId } = parsed.data;

      const result = await taskCreationService.startConversation(projectId);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, 400);
      }

      return json({ ok: true, data: { sessionId: result.value.id } });
    } catch (error) {
      log.error('Start error', { error });
      return json(
        { ok: false, error: { code: 'SERVER_ERROR', message: 'Failed to start conversation' } },
        500
      );
    }
  });

  // POST /api/tasks/create-with-ai/message
  app.post('/message', async (c) => {
    try {
      const parsed = await parseJsonBody(c, messageSchema);
      if (!parsed.ok) return parsed.response;
      const { sessionId, message } = parsed.data;

      // Send message with token streaming to SSE
      const controller = sseConnections.get(sessionId);
      const onToken = controller
        ? (delta: string, accumulated: string) => {
            const data = JSON.stringify({
              type: 'task-creation:token',
              data: { delta, accumulated },
            });
            controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
          }
        : undefined;

      // Callback for when background processor publishes an assistant message (sends SSE event)
      const onMessage = controller
        ? (messageId: string, role: 'user' | 'assistant', content: string) => {
            log.debug('onMessage callback - sending SSE event');
            const messageData = JSON.stringify({
              type: 'task-creation:message',
              data: { sessionId, messageId, role, content },
            });
            controller.enqueue(new TextEncoder().encode(`data: ${messageData}\n\n`));
          }
        : undefined;

      // Callback for when background processor finds a suggestion (sends SSE event)
      const onSuggestion = controller
        ? (suggestion: {
            title: string;
            description: string;
            labels: string[];
            priority: string;
          }) => {
            log.debug('onSuggestion callback - sending SSE event');
            const suggestionData = JSON.stringify({
              type: 'task-creation:suggestion',
              data: { sessionId, suggestion },
            });
            controller.enqueue(new TextEncoder().encode(`data: ${suggestionData}\n\n`));
          }
        : undefined;

      const result = await taskCreationService.sendMessage(
        sessionId,
        message,
        onToken,
        onSuggestion,
        onMessage
      );

      if (!result.ok) {
        // Send error to SSE if connected
        if (controller) {
          const errorData = JSON.stringify({
            type: 'task-creation:error',
            data: { error: result.error.message },
          });
          controller.enqueue(new TextEncoder().encode(`data: ${errorData}\n\n`));
        }
        return json({ ok: false, error: result.error }, 400);
      }

      // Send events to SSE based on session state
      log.debug('About to send SSE update', {
        data: {
          sessionId,
          hasController: !!controller,
          sseConnectionsSize: sseConnections.size,
          hasPendingQuestions: !!result.value?.pendingQuestions,
        },
      });
      if (controller) {
        sendTaskCreationSSEUpdate(controller, sessionId, result.value);
      } else {
        log.debug('No SSE controller found for session', { data: { sessionId } });
      }

      return json({ ok: true, data: { messageId: 'msg-sent' } });
    } catch (error) {
      log.error('Message error', { error });
      return json(
        { ok: false, error: { code: 'SERVER_ERROR', message: 'Failed to send message' } },
        500
      );
    }
  });

  // POST /api/tasks/create-with-ai/accept
  app.post('/accept', async (c) => {
    try {
      const parsed = await parseJsonBody(c, acceptSchema);
      if (!parsed.ok) return parsed.response;
      const { sessionId, overrides } = parsed.data;

      const result = await taskCreationService.acceptSuggestion(sessionId, overrides);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, 400);
      }

      // Send completion to SSE
      const controller = sseConnections.get(sessionId);
      if (controller) {
        const completeData = JSON.stringify({
          type: 'task-creation:completed',
          data: { taskId: result.value.taskId },
        });
        controller.enqueue(new TextEncoder().encode(`data: ${completeData}\n\n`));
      }

      return json({
        ok: true,
        data: { taskId: result.value.taskId, sessionId, status: 'completed' },
      });
    } catch (error) {
      log.error('Accept error', { error });
      return json(
        { ok: false, error: { code: 'SERVER_ERROR', message: 'Failed to accept suggestion' } },
        500
      );
    }
  });

  // POST /api/tasks/create-with-ai/cancel
  app.post('/cancel', async (c) => {
    try {
      const parsed = await parseJsonBody(c, cancelSchema);
      if (!parsed.ok) return parsed.response;
      const { sessionId } = parsed.data;

      const result = await taskCreationService.cancel(sessionId);

      if (!result.ok) {
        return json({ ok: false, error: result.error }, 400);
      }

      // Close SSE connection
      const controller = sseConnections.get(sessionId);
      if (controller) {
        const cancelData = JSON.stringify({ type: 'task-creation:cancelled', data: { sessionId } });
        controller.enqueue(new TextEncoder().encode(`data: ${cancelData}\n\n`));
        controller.close();
        sseConnections.delete(sessionId);
      }

      return json({ ok: true, data: { sessionId, status: 'cancelled' } });
    } catch (error) {
      log.error('Cancel error', { error });
      return json(
        { ok: false, error: { code: 'SERVER_ERROR', message: 'Failed to cancel session' } },
        500
      );
    }
  });

  // POST /api/tasks/create-with-ai/answer
  app.post('/answer', async (c) => {
    try {
      const parsed = await parseJsonBody(c, answerSchema);
      if (!parsed.ok) return parsed.response;
      const { sessionId, questionsId, answers } = parsed.data;

      const controller = sseConnections.get(sessionId);

      // The service publishes SSE processing/update events internally
      const result = await taskCreationService.answerQuestions(sessionId, questionsId, answers);

      if (!result.ok) {
        if (controller) {
          const errorData = JSON.stringify({
            type: 'task-creation:error',
            data: { error: result.error.message },
          });
          controller.enqueue(new TextEncoder().encode(`data: ${errorData}\n\n`));
        }
        return json({ ok: false, error: result.error }, 400);
      }

      // Send SSE update based on session state, but skip for duplicate submissions
      // since the session has already advanced past this question round
      const alreadyProcessed = 'alreadyProcessed' in result.value && result.value.alreadyProcessed;
      if (controller && !alreadyProcessed) {
        sendTaskCreationSSEUpdate(controller, sessionId, result.value);
      }

      return json({
        ok: true,
        data: { sessionId, status: result.value.status, duplicate: !!alreadyProcessed },
      });
    } catch (error) {
      log.error('Answer error', { error });
      return json(
        { ok: false, error: { code: 'SERVER_ERROR', message: 'Failed to answer questions' } },
        500
      );
    }
  });

  // POST /api/tasks/create-with-ai/skip
  app.post('/skip', async (c) => {
    try {
      const parsed = await parseJsonBody(c, skipSchema);
      if (!parsed.ok) return parsed.response;
      const { sessionId } = parsed.data;

      const controller = sseConnections.get(sessionId);
      const result = await taskCreationService.skipQuestions(sessionId);

      if (!result.ok) {
        if (controller) {
          const errorData = JSON.stringify({
            type: 'task-creation:error',
            data: { error: result.error.message },
          });
          controller.enqueue(new TextEncoder().encode(`data: ${errorData}\n\n`));
        }
        return json({ ok: false, error: result.error }, 400);
      }

      // Send events to SSE based on session state
      if (controller) {
        sendTaskCreationSSEUpdate(controller, sessionId, result.value);
      }

      return json({ ok: true, data: { sessionId, status: result.value.status } });
    } catch (error) {
      log.error('Skip error', { error });
      return json(
        { ok: false, error: { code: 'SERVER_ERROR', message: 'Failed to skip questions' } },
        500
      );
    }
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

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Store controller for this session
        sseConnections.set(sessionId, controller);

        // Send initial connected event
        const connectedData = JSON.stringify({ type: 'connected', sessionId });
        controller.enqueue(new TextEncoder().encode(`data: ${connectedData}\n\n`));

        // Send immediate ping to keep connection alive
        controller.enqueue(new TextEncoder().encode(`: ping\n\n`));

        // Send keep-alive ping every 5 seconds
        pingInterval = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(`: ping\n\n`));
          } catch (error) {
            // Connection likely closed - clean up interval
            log.debug('Ping failed, closing connection', {
              error: error instanceof Error ? error : undefined,
            });
            if (pingInterval) {
              clearInterval(pingInterval);
              pingInterval = null;
            }
            sseConnections.delete(sessionId);
          }
        }, 5000);
      },
      cancel() {
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        sseConnections.delete(sessionId);
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
