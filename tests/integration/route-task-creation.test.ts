import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskCreationRoutes } from '../../src/server/routes/task-creation';

/**
 * Integration tests for task-creation (create-with-ai) API routes.
 *
 * These routes are mounted at /api/tasks/create-with-ai and orchestrate
 * an AI-driven conversation to create a task. The service is fully mocked;
 * we test route-level validation, JSON serialization, SSE event wiring,
 * and error propagation.
 */

const jsonRequest = (url: string, body: unknown, init?: RequestInit): Request =>
  new Request(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

function createMockTaskCreationService() {
  return {
    startConversation: vi.fn(),
    sendMessage: vi.fn(),
    acceptSuggestion: vi.fn(),
    cancel: vi.fn(),
    answerQuestions: vi.fn(),
    skipQuestions: vi.fn(),
    getSession: vi.fn(),
  };
}

describe('Task Creation Routes (IT-1300)', () => {
  let app: Hono;
  let mockService: ReturnType<typeof createMockTaskCreationService>;

  beforeEach(() => {
    mockService = createMockTaskCreationService();
    app = createTaskCreationRoutes({
      taskCreationService: mockService as any,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── POST /start ───────────────────────────────────────

  it('IT-1300: POST /start returns sessionId on success', async () => {
    mockService.startConversation.mockResolvedValue({
      ok: true,
      value: { id: 'session-abc123' },
    });

    const res = await app.request(
      jsonRequest('http://localhost/start', { codespaceId: 'cs-valid-id' })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.sessionId).toBe('session-abc123');
    expect(mockService.startConversation).toHaveBeenCalledWith('cs-valid-id');
  });

  it('IT-1301: POST /start returns 400 when codespaceId is missing', async () => {
    const res = await app.request(jsonRequest('http://localhost/start', {}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1302: POST /start returns 400 when codespaceId is empty string', async () => {
    const res = await app.request(jsonRequest('http://localhost/start', { codespaceId: '' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1303: POST /start returns 400 when service fails', async () => {
    mockService.startConversation.mockResolvedValue({
      ok: false,
      error: { code: 'AI_ERROR', message: 'Model unavailable' },
    });

    const res = await app.request(
      jsonRequest('http://localhost/start', { codespaceId: 'cs-valid-id' })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe('Model unavailable');
  });

  // ─── POST /message ─────────────────────────────────────

  it('IT-1304: POST /message sends message and returns messageId', async () => {
    mockService.sendMessage.mockResolvedValue({
      ok: true,
      value: {
        messages: [{ id: 'msg-1', role: 'assistant', content: 'Hello' }],
        pendingQuestions: null,
        suggestion: null,
        status: 'active',
      },
    });

    const res = await app.request(
      jsonRequest('http://localhost/message', {
        sessionId: 'sess-abc',
        message: 'Create a login page',
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.messageId).toBe('msg-sent');
    expect(mockService.sendMessage).toHaveBeenCalledWith(
      'sess-abc',
      'Create a login page',
      expect.any(Function),
      expect.any(Function),
      expect.any(Function)
    );
  });

  it('IT-1305: POST /message returns 400 when sessionId is missing', async () => {
    const res = await app.request(jsonRequest('http://localhost/message', { message: 'hello' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1306: POST /message returns 400 when message is empty', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/message', {
        sessionId: 'sess-abc',
        message: '',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1307: POST /message returns 400 on service error', async () => {
    mockService.sendMessage.mockResolvedValue({
      ok: false,
      error: { code: 'SESSION_NOT_FOUND', message: 'Session expired' },
    });

    const res = await app.request(
      jsonRequest('http://localhost/message', {
        sessionId: 'sess-expired',
        message: 'test',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe('Session expired');
  });

  // ─── POST /accept ──────────────────────────────────────

  it('IT-1308: POST /accept creates task from suggestion', async () => {
    mockService.acceptSuggestion.mockResolvedValue({
      ok: true,
      value: { taskId: 'task-xyz' },
    });

    const res = await app.request(
      jsonRequest('http://localhost/accept', {
        sessionId: 'sess-abc',
        overrides: { title: 'Custom Title' },
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.taskId).toBe('task-xyz');
    expect(body.data.status).toBe('completed');
    expect(mockService.acceptSuggestion).toHaveBeenCalledWith('sess-abc', {
      title: 'Custom Title',
    });
  });

  it('IT-1309: POST /accept works without overrides', async () => {
    mockService.acceptSuggestion.mockResolvedValue({
      ok: true,
      value: { taskId: 'task-def' },
    });

    const res = await app.request(
      jsonRequest('http://localhost/accept', { sessionId: 'sess-abc' })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.taskId).toBe('task-def');
    expect(mockService.acceptSuggestion).toHaveBeenCalledWith('sess-abc', undefined);
  });

  it('IT-1310: POST /accept returns 400 on service error', async () => {
    mockService.acceptSuggestion.mockResolvedValue({
      ok: false,
      error: { code: 'NO_SUGGESTION', message: 'No suggestion available' },
    });

    const res = await app.request(
      jsonRequest('http://localhost/accept', { sessionId: 'sess-abc' })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe('No suggestion available');
  });

  // ─── POST /cancel ──────────────────────────────────────

  it('IT-1311: POST /cancel cancels a session', async () => {
    mockService.cancel.mockResolvedValue({ ok: true, value: {} });

    const res = await app.request(
      jsonRequest('http://localhost/cancel', { sessionId: 'sess-abc' })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('cancelled');
    expect(mockService.cancel).toHaveBeenCalledWith('sess-abc');
  });

  it('IT-1312: POST /cancel returns 400 when sessionId missing', async () => {
    const res = await app.request(jsonRequest('http://localhost/cancel', {}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1313: POST /cancel returns 400 on service error', async () => {
    mockService.cancel.mockResolvedValue({
      ok: false,
      error: { code: 'SESSION_NOT_FOUND', message: 'Already cancelled' },
    });

    const res = await app.request(
      jsonRequest('http://localhost/cancel', { sessionId: 'sess-gone' })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  // ─── POST /answer ──────────────────────────────────────

  it('IT-1314: POST /answer submits answers and returns status', async () => {
    mockService.answerQuestions.mockResolvedValue({
      ok: true,
      value: {
        status: 'active',
        messages: [{ id: 'msg-2', role: 'assistant', content: 'Thanks' }],
        pendingQuestions: null,
        suggestion: null,
      },
    });

    const res = await app.request(
      jsonRequest('http://localhost/answer', {
        sessionId: 'sess-abc',
        questionsId: 'q-1',
        answers: { q1: 'Yes', q2: ['option-a', 'option-b'] },
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('active');
    expect(body.data.duplicate).toBe(false);
  });

  it('IT-1315: POST /answer returns duplicate flag for already processed answers', async () => {
    mockService.answerQuestions.mockResolvedValue({
      ok: true,
      value: {
        status: 'active',
        alreadyProcessed: true,
        messages: [],
      },
    });

    const res = await app.request(
      jsonRequest('http://localhost/answer', {
        sessionId: 'sess-abc',
        questionsId: 'q-old',
        answers: { q1: 'value' },
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.duplicate).toBe(true);
  });

  it('IT-1316: POST /answer returns 400 when questionsId is missing', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/answer', {
        sessionId: 'sess-abc',
        answers: { q1: 'val' },
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1317: POST /answer returns 400 when answers is missing', async () => {
    const res = await app.request(
      jsonRequest('http://localhost/answer', {
        sessionId: 'sess-abc',
        questionsId: 'q-1',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1318: POST /answer returns 400 on service error', async () => {
    mockService.answerQuestions.mockResolvedValue({
      ok: false,
      error: { code: 'INVALID_STATE', message: 'No pending questions' },
    });

    const res = await app.request(
      jsonRequest('http://localhost/answer', {
        sessionId: 'sess-abc',
        questionsId: 'q-1',
        answers: { q1: 'val' },
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe('No pending questions');
  });

  // ─── POST /skip ────────────────────────────────────────

  it('IT-1319: POST /skip skips questions and returns status', async () => {
    mockService.skipQuestions.mockResolvedValue({
      ok: true,
      value: {
        status: 'active',
        messages: [{ id: 'msg-3', role: 'assistant', content: 'Skipping...' }],
        pendingQuestions: null,
        suggestion: { title: 'Task', description: 'Desc', labels: [], priority: 'medium' },
      },
    });

    const res = await app.request(jsonRequest('http://localhost/skip', { sessionId: 'sess-abc' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('active');
  });

  it('IT-1320: POST /skip returns 400 when sessionId missing', async () => {
    const res = await app.request(jsonRequest('http://localhost/skip', {}));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('IT-1321: POST /skip returns 400 on service error', async () => {
    mockService.skipQuestions.mockResolvedValue({
      ok: false,
      error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
    });

    const res = await app.request(jsonRequest('http://localhost/skip', { sessionId: 'sess-gone' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  // ─── GET /stream ───────────────────────────────────────

  it('IT-1322: GET /stream returns 400 when sessionId query is missing', async () => {
    const res = await app.request('http://localhost/stream');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  it('IT-1323: GET /stream returns 404 when session not found', async () => {
    mockService.getSession.mockReturnValue(null);

    const res = await app.request('http://localhost/stream?sessionId=nonexistent');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('IT-1324: GET /stream returns SSE stream for valid session', async () => {
    mockService.getSession.mockReturnValue({
      id: 'sess-abc',
      messages: [],
      status: 'active',
    });

    const res = await app.request('http://localhost/stream?sessionId=sess-abc');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  // ─── Invalid JSON ──────────────────────────────────────

  it('IT-1325: POST /start returns 400 on invalid JSON body', async () => {
    const res = await app.request(
      new Request('http://localhost/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
  });
});
