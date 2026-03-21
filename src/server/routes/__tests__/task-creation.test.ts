import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createTaskCreationRoutes } from '../task-creation.js';

// ── Mock Task Creation Service ──

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

// ── Test App Factory ──

function createTestApp() {
  const taskCreationService = createMockTaskCreationService();
  const routes = createTaskCreationRoutes({
    taskCreationService: taskCreationService as never,
  });
  const app = new Hono();
  app.route('/api/tasks/create-with-ai', routes);
  return { app, taskCreationService };
}

// ── Request Helper ──

async function request(app: Hono, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return app.request(path, init);
}

// ── Tests ──

describe('Task Creation API Routes', () => {
  // ── POST /api/tasks/create-with-ai/start ──

  describe('POST /start', () => {
    it('starts a conversation and returns sessionId', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.startConversation.mockResolvedValue({
        ok: true,
        value: { id: 'session-1' },
      });

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/start', {
        codespaceId: 'proj-1',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.sessionId).toBe('session-1');
      expect(taskCreationService.startConversation).toHaveBeenCalledWith('proj-1');
    });

    it('returns 400 when codespaceId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/start', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when service returns error', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.startConversation.mockResolvedValue({
        ok: false,
        error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' },
      });

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/start', {
        codespaceId: 'proj-1',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 500 when service throws', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.startConversation.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/start', {
        codespaceId: 'proj-1',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('SERVER_ERROR');
    });
  });

  // ── POST /api/tasks/create-with-ai/message ──

  describe('POST /message', () => {
    it('sends a message and returns success', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.sendMessage.mockResolvedValue({
        ok: true,
        value: {
          messages: [{ id: 'msg-1', role: 'assistant', content: 'Response' }],
          status: 'active',
        },
      });

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/message', {
        sessionId: 'session-1',
        message: 'Create a login page',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.messageId).toBe('msg-sent');
    });

    it('returns 400 when sessionId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/message', {
        message: 'Hello',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when message is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/message', {
        sessionId: 'session-1',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when service returns error', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.sendMessage.mockResolvedValue({
        ok: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
      });

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/message', {
        sessionId: 'session-1',
        message: 'Hello',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 500 when service throws', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.sendMessage.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/message', {
        sessionId: 'session-1',
        message: 'Hello',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('SERVER_ERROR');
    });
  });

  // ── POST /api/tasks/create-with-ai/accept ──

  describe('POST /accept', () => {
    it('accepts a suggestion and returns taskId', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.acceptSuggestion.mockResolvedValue({
        ok: true,
        value: { taskId: 'task-1' },
      });

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/accept', {
        sessionId: 'session-1',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.taskId).toBe('task-1');
      expect(json.data.status).toBe('completed');
    });

    it('passes overrides to service', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.acceptSuggestion.mockResolvedValue({
        ok: true,
        value: { taskId: 'task-1' },
      });

      const overrides = { title: 'Custom Title', priority: 'high' };
      await request(app, 'POST', '/api/tasks/create-with-ai/accept', {
        sessionId: 'session-1',
        overrides,
      });

      expect(taskCreationService.acceptSuggestion).toHaveBeenCalledWith('session-1', overrides);
    });

    it('returns 400 when sessionId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/accept', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when service returns error', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.acceptSuggestion.mockResolvedValue({
        ok: false,
        error: { code: 'NO_SUGGESTION', message: 'No suggestion available' },
      });

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/accept', {
        sessionId: 'session-1',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 500 when service throws', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.acceptSuggestion.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/accept', {
        sessionId: 'session-1',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('SERVER_ERROR');
    });
  });

  // ── POST /api/tasks/create-with-ai/cancel ──

  describe('POST /cancel', () => {
    it('cancels a session', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.cancel.mockResolvedValue({ ok: true, value: true });

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/cancel', {
        sessionId: 'session-1',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.status).toBe('cancelled');
    });

    it('returns 400 when sessionId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/cancel', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when service returns error', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.cancel.mockResolvedValue({
        ok: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'Not found' },
      });

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/cancel', {
        sessionId: 'session-1',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 500 when service throws', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.cancel.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/cancel', {
        sessionId: 'session-1',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('SERVER_ERROR');
    });
  });

  // ── POST /api/tasks/create-with-ai/answer ──

  describe('POST /answer', () => {
    it('answers questions and returns success', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.answerQuestions.mockResolvedValue({
        ok: true,
        value: {
          messages: [{ id: 'msg-1', role: 'assistant', content: 'Thanks' }],
          status: 'active',
        },
      });

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/answer', {
        sessionId: 'session-1',
        questionsId: 'q-1',
        answers: { q1: 'Yes' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
    });

    it('returns 400 when required fields are missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/answer', {
        sessionId: 'session-1',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when answers is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/answer', {
        sessionId: 'session-1',
        questionsId: 'q-1',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when service returns error', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.answerQuestions.mockResolvedValue({
        ok: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
      });

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/answer', {
        sessionId: 'session-1',
        questionsId: 'q-1',
        answers: { q1: 'Yes' },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('handles duplicate answer submissions', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.answerQuestions.mockResolvedValue({
        ok: true,
        value: {
          messages: [],
          status: 'active',
          alreadyProcessed: true,
        },
      });

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/answer', {
        sessionId: 'session-1',
        questionsId: 'q-1',
        answers: { q1: 'Yes' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.duplicate).toBe(true);
    });

    it('returns 500 when service throws', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.answerQuestions.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/answer', {
        sessionId: 'session-1',
        questionsId: 'q-1',
        answers: { q1: 'Yes' },
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error.code).toBe('SERVER_ERROR');
    });
  });

  // ── POST /api/tasks/create-with-ai/skip ──

  describe('POST /skip', () => {
    it('skips questions and returns success', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.skipQuestions.mockResolvedValue({
        ok: true,
        value: {
          messages: [{ id: 'msg-1', role: 'assistant', content: 'OK, skipping questions' }],
          status: 'active',
        },
      });

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/skip', {
        sessionId: 'session-1',
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.status).toBe('active');
    });

    it('returns 400 when sessionId is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/skip', {});

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when service returns error', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.skipQuestions.mockResolvedValue({
        ok: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'Not found' },
      });

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/skip', {
        sessionId: 'session-1',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
    });

    it('returns 500 when service throws', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.skipQuestions.mockRejectedValue(new Error('unexpected'));

      const res = await request(app, 'POST', '/api/tasks/create-with-ai/skip', {
        sessionId: 'session-1',
      });

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error.code).toBe('SERVER_ERROR');
    });
  });

  // ── GET /api/tasks/create-with-ai/stream ──

  describe('GET /stream', () => {
    it('returns 400 when sessionId query param is missing', async () => {
      const { app } = createTestApp();

      const res = await request(app, 'GET', '/api/tasks/create-with-ai/stream');

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('INVALID_INPUT');
    });

    it('returns 404 when session not found', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.getSession.mockReturnValue(null);

      const res = await request(
        app,
        'GET',
        '/api/tasks/create-with-ai/stream?sessionId=nonexistent'
      );

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns SSE stream when session exists', async () => {
      const { app, taskCreationService } = createTestApp();
      taskCreationService.getSession.mockReturnValue({
        id: 'session-1',
        messages: [],
        status: 'active',
      });

      const res = await request(app, 'GET', '/api/tasks/create-with-ai/stream?sessionId=session-1');

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
    });
  });
});
