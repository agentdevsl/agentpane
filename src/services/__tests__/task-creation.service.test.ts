import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TASK_CREATION_TOOLS } from '../../lib/constants/tools.js';
import {
  TaskCreationErrors,
  TaskCreationService,
  type TaskSuggestion,
} from '../task-creation.service.js';

// Mock the Claude Agent SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: vi.fn(),
}));

import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';

const createDbMock = () => ({
  query: {
    projects: { findFirst: vi.fn() },
    tasks: { findFirst: vi.fn(), findMany: vi.fn() },
  },
  insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
  delete: vi.fn(() => ({ where: vi.fn() })),
});

const createStreamsMock = () => ({
  createStream: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn().mockResolvedValue(1),
  // Task creation convenience methods - these delegate to publish()
  publishTaskCreationStarted: vi.fn().mockResolvedValue(undefined),
  publishTaskCreationMessage: vi.fn().mockResolvedValue(undefined),
  publishTaskCreationToken: vi.fn().mockResolvedValue(undefined),
  publishTaskCreationSuggestion: vi.fn().mockResolvedValue(undefined),
  publishTaskCreationQuestions: vi.fn().mockResolvedValue(undefined),
  publishTaskCreationCompleted: vi.fn().mockResolvedValue(undefined),
  publishTaskCreationCancelled: vi.fn().mockResolvedValue(undefined),
  publishTaskCreationError: vi.fn().mockResolvedValue(undefined),
});

const createV2SessionMock = () => ({
  send: vi.fn().mockResolvedValue(undefined),
  stream: vi.fn(),
  close: vi.fn(),
});

const createSessionServiceMock = () => ({
  create: vi.fn().mockResolvedValue({ ok: true, value: { id: 'db-session-1' } }),
  publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 1 } }),
  close: vi.fn().mockResolvedValue({ ok: true }),
});

describe('TaskCreationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startConversation', () => {
    it('creates a new session when project exists', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1', name: 'Test Project' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const service = new TaskCreationService(db as never, streams as never);
      const result = await service.startConversation('p1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBeDefined();
        expect(result.value.projectId).toBe('p1');
        expect(result.value.status).toBe('active');
        expect(result.value.messages).toHaveLength(0);
        expect(result.value.suggestion).toBeNull();
        expect(result.value.v2Session).toBe(v2Session);
        expect(result.value.systemPromptSent).toBe(false);
      }

      expect(unstable_v2_createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-6',
          env: expect.objectContaining({ CLAUDE_CODE_ENABLE_TASKS: 'true' }),
          allowedTools: DEFAULT_TASK_CREATION_TOOLS,
          canUseTool: expect.any(Function),
        })
      );
      expect(streams.createStream).toHaveBeenCalled();
      expect(streams.publishTaskCreationStarted).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ projectId: 'p1' })
      );
    });

    it('returns error when project not found', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();

      db.query.projects.findFirst.mockResolvedValue(null);

      const service = new TaskCreationService(db as never, streams as never);
      const result = await service.startConversation('missing');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(TaskCreationErrors.PROJECT_NOT_FOUND);
      }
    });

    it('uses custom configured tools when provided', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1', name: 'Test Project' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const service = new TaskCreationService(db as never, streams as never);
      const result = await service.startConversation('p1', ['Read', 'Grep']);

      expect(result.ok).toBe(true);
      expect(unstable_v2_createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-6',
          env: expect.objectContaining({ CLAUDE_CODE_ENABLE_TASKS: 'true' }),
          allowedTools: ['Read', 'Grep', 'AskUserQuestion'],
          canUseTool: expect.any(Function),
        })
      );
    });

    it('does not duplicate AskUserQuestion if already in configured tools', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1', name: 'Test Project' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const service = new TaskCreationService(db as never, streams as never);
      const result = await service.startConversation('p1', ['Read', 'AskUserQuestion']);

      expect(result.ok).toBe(true);
      expect(unstable_v2_createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-6',
          env: expect.objectContaining({ CLAUDE_CODE_ENABLE_TASKS: 'true' }),
          allowedTools: ['Read', 'AskUserQuestion'],
          canUseTool: expect.any(Function),
        })
      );
    });
  });

  describe('sendMessage', () => {
    it('returns error when session not found', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();

      const service = new TaskCreationService(db as never, streams as never);
      const result = await service.sendMessage('missing', 'hello');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(TaskCreationErrors.SESSION_NOT_FOUND);
      }
    });

    it('returns error when session is completed', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      // Cancel the session to mark it as completed
      await service.cancel(startResult.value.id);

      const result = await service.sendMessage(startResult.value.id, 'hello');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_COMPLETED');
      }
    });

    it('sends message and processes streaming response', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      // Mock streaming response
      async function* mockStream() {
        yield {
          type: 'stream_event',
          session_id: 'sdk-session-1',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
        };
        yield {
          type: 'stream_event',
          session_id: 'sdk-session-1',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there!' } },
        };
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { content: [{ type: 'text', text: 'Hello there!' }] },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.sendMessage(startResult.value.id, 'Create a task');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.messages).toHaveLength(2); // user + assistant
        const userMsg = result.value.messages[0];
        const assistantMsg = result.value.messages[1];
        expect(userMsg?.role).toBe('user');
        expect(userMsg?.content).toBe('Create a task');
        expect(assistantMsg?.role).toBe('assistant');
        expect(assistantMsg?.content).toBe('Hello there!');
        expect(result.value.sdkSessionId).toBe('sdk-session-1');
        expect(result.value.systemPromptSent).toBe(true);
      }

      expect(v2Session.send).toHaveBeenCalled();
      // First message should include system prompt
      const sentMessage = v2Session.send.mock.calls[0]?.[0] as string;
      expect(sentMessage).toContain('User message: Create a task');
      // Check message publications (user + assistant)
      expect(streams.publishTaskCreationMessage.mock.calls.length).toBe(2);
      // Tokens are batched and flushed together for performance
      expect(streams.publishTaskCreationToken.mock.calls.length).toBeGreaterThan(0);
    });

    it('parses task suggestion from response', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const suggestionJson = JSON.stringify({
        type: 'task_suggestion',
        title: 'Fix login bug',
        description: 'The login form has a validation issue',
        labels: ['bug'],
        priority: 'high',
        mode: 'implement',
      });

      // Mock streaming response with suggestion
      async function* mockStream() {
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            content: [
              {
                type: 'text',
                text: `Here's my suggestion:\n\n\`\`\`json\n${suggestionJson}\n\`\`\``,
              },
            ],
          },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.sendMessage(startResult.value.id, 'Create a bug task');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestion).not.toBeNull();
        expect(result.value.suggestion?.title).toBe('Fix login bug');
        expect(result.value.suggestion?.priority).toBe('high');
      }

      expect(streams.publishTaskCreationSuggestion).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ suggestion: expect.any(Object) })
      );
    });

    it('handles API errors gracefully', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      v2Session.send.mockRejectedValue(new Error('API rate limit exceeded'));

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.sendMessage(startResult.value.id, 'hello');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('API_ERROR');
        expect(result.error.message).toContain('API rate limit exceeded');
      }

      expect(streams.publishTaskCreationError).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ error: expect.any(String) })
      );
    });
  });

  describe('acceptSuggestion', () => {
    it('returns error when session not found', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();

      const service = new TaskCreationService(db as never, streams as never);
      const result = await service.acceptSuggestion('missing');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(TaskCreationErrors.SESSION_NOT_FOUND);
      }
    });

    it('returns error when no suggestion available', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.acceptSuggestion(startResult.value.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(TaskCreationErrors.NO_SUGGESTION);
      }
    });

    it('creates task from suggestion', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const suggestion: TaskSuggestion = {
        title: 'Test Task',
        description: 'Test description',
        labels: ['feature'],
        priority: 'medium',
      };

      // Mock streaming response with suggestion
      async function* mockStream() {
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            content: [
              {
                type: 'text',
                text: `\`\`\`json\n${JSON.stringify({ type: 'task_suggestion', ...suggestion })}\n\`\`\``,
              },
            ],
          },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      db.insert.mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      // Send message to get suggestion
      await service.sendMessage(startResult.value.id, 'Create a task');

      const result = await service.acceptSuggestion(startResult.value.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.taskId).toBeDefined();
        expect(result.value.session.status).toBe('completed');
        expect(result.value.session.v2Session).toBeNull(); // Should be closed
      }

      expect(db.insert).toHaveBeenCalled();
      expect(streams.publishTaskCreationCompleted).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ taskId: expect.any(String) })
      );
    });

    it('applies overrides to suggestion', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const suggestion: TaskSuggestion = {
        title: 'Original Title',
        description: 'Test description',
        labels: ['feature'],
        priority: 'medium',
      };

      async function* mockStream() {
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            content: [
              {
                type: 'text',
                text: `\`\`\`json\n${JSON.stringify({ type: 'task_suggestion', ...suggestion })}\n\`\`\``,
              },
            ],
          },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      // Capture the insert call arguments
      const valuesMock = vi.fn().mockResolvedValue(undefined);
      db.insert.mockReturnValue({ values: valuesMock });

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      await service.sendMessage(startResult.value.id, 'Create a task');

      await service.acceptSuggestion(startResult.value.id, {
        title: 'Overridden Title',
        priority: 'high',
      });

      // Verify insert was called with overridden values
      // The last insert call is the task insert from acceptSuggestion
      // (earlier calls may include the session insert from startConversation)
      expect(valuesMock).toHaveBeenCalled();
      const lastCallIndex = valuesMock.mock.calls.length - 1;
      const insertedTask = valuesMock.mock.calls[lastCallIndex]?.[0] as Record<string, unknown>;
      expect(insertedTask).toBeDefined();
      expect(insertedTask.title).toBe('Overridden Title');
      expect(insertedTask.priority).toBe('high');
      expect(insertedTask.description).toBe('Test description'); // Not overridden
    });
  });

  describe('cancel', () => {
    it('returns error when session not found', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();

      const service = new TaskCreationService(db as never, streams as never);
      const result = await service.cancel('missing');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(TaskCreationErrors.SESSION_NOT_FOUND);
      }
    });

    it('cancels session and closes V2 session', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.cancel(startResult.value.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('cancelled');
        expect(result.value.completedAt).toBeDefined();
        expect(result.value.v2Session).toBeNull();
      }

      expect(v2Session.close).toHaveBeenCalled();
      expect(streams.publishTaskCreationCancelled).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sessionId: expect.any(String) })
      );
    });
  });

  describe('getSession', () => {
    it('returns null when session not found', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();

      const service = new TaskCreationService(db as never, streams as never);
      const session = service.getSession('missing');

      expect(session).toBeNull();
    });

    it('returns session when found', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const session = service.getSession(startResult.value.id);

      expect(session).not.toBeNull();
      expect(session?.id).toBe(startResult.value.id);
    });
  });

  describe('answerQuestions', () => {
    it('returns error when session not found', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();

      const service = new TaskCreationService(db as never, streams as never);
      const result = await service.answerQuestions('missing', 'q-id', { '0': 'answer' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(TaskCreationErrors.SESSION_NOT_FOUND);
      }
    });

    it('returns error when questions ID does not match', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      // No pending questions, so any ID will mismatch
      const result = await service.answerQuestions(startResult.value.id, 'wrong-id', {
        '0': 'answer',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_QUESTIONS_ID');
      }
    });

    it('formats answers correctly and sends to AI', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      // Mock streaming response for initial message
      async function* mockStream() {
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { content: [{ type: 'text', text: 'Response' }] },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      // Manually set pending questions on the session
      const session = service.getSession(startResult.value.id);
      if (!session) return;

      session.pendingQuestions = {
        id: 'q-123',
        questions: [
          { header: 'Scope', question: 'What is the scope?', options: [{ label: 'Full' }] },
          { header: 'Priority', question: 'What priority?', options: [{ label: 'High' }] },
        ],
        round: 1,
        totalAsked: 2,
        maxQuestions: 10,
      };
      session.status = 'waiting_user';

      // Answer the questions
      const result = await service.answerQuestions(startResult.value.id, 'q-123', {
        '0': 'Full scope',
        '1': 'High priority',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('active');
        expect(result.value.pendingQuestions).toBeNull();
      }

      // Verify the message sent contains the formatted answers
      const sentMessage = v2Session.send.mock.calls.find((call) =>
        (call[0] as string).includes('Here are my answers')
      );
      expect(sentMessage).toBeDefined();
      expect(sentMessage?.[0]).toContain('Scope: Full scope');
      expect(sentMessage?.[0]).toContain('Priority: High priority');
    });
  });

  describe('skipQuestions', () => {
    it('returns error when session not found', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();

      const service = new TaskCreationService(db as never, streams as never);
      const result = await service.skipQuestions('missing');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(TaskCreationErrors.SESSION_NOT_FOUND);
      }
    });

    it('sends skip message and clears pendingQuestions', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      // Mock streaming response
      async function* mockStream() {
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { content: [{ type: 'text', text: 'Generating task' }] },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      // Manually set pending questions on the session
      const session = service.getSession(startResult.value.id);
      if (!session) return;

      session.pendingQuestions = {
        id: 'q-123',
        questions: [{ header: 'Scope', question: 'What scope?', options: [] }],
        round: 1,
        totalAsked: 1,
        maxQuestions: 10,
      };
      session.status = 'waiting_user';

      const result = await service.skipQuestions(startResult.value.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('active');
        expect(result.value.pendingQuestions).toBeNull();
      }

      // Verify skip message was sent
      const sentMessage = v2Session.send.mock.calls.find((call) =>
        (call[0] as string).includes('proceed with generating the task')
      );
      expect(sentMessage).toBeDefined();
    });
  });

  describe('clarifying questions parsing', () => {
    it('parses clarifying questions from response', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const questionsJson = JSON.stringify({
        type: 'clarifying_questions',
        questions: [
          {
            header: 'Scope',
            question: 'What is the scope of this task?',
            options: [
              { label: 'Full feature', description: 'Complete implementation' },
              { label: 'MVP only', description: 'Minimal implementation' },
            ],
          },
        ],
      });

      async function* mockStream() {
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            content: [{ type: 'text', text: `\`\`\`json\n${questionsJson}\n\`\`\`` }],
          },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.sendMessage(startResult.value.id, 'Create a login feature');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pendingQuestions).not.toBeNull();
        expect(result.value.pendingQuestions?.questions).toHaveLength(1);
        expect(result.value.pendingQuestions?.questions[0]?.header).toBe('Scope');
        expect(result.value.status).toBe('waiting_user');
      }
    });

    it('returns null for invalid clarifying questions JSON', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      async function* mockStream() {
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            content: [
              { type: 'text', text: '```json\n{"type": "clarifying_questions", invalid}\n```' },
            ],
          },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.sendMessage(startResult.value.id, 'Create a task');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pendingQuestions).toBeNull();
      }
    });

    it('returns null when questions array is empty', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const questionsJson = JSON.stringify({
        type: 'clarifying_questions',
        questions: [],
      });

      async function* mockStream() {
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            content: [{ type: 'text', text: `\`\`\`json\n${questionsJson}\n\`\`\`` }],
          },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.sendMessage(startResult.value.id, 'Create a task');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pendingQuestions).toBeNull();
      }
    });

    it('filters out questions with missing required fields', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const questionsJson = JSON.stringify({
        type: 'clarifying_questions',
        questions: [
          { header: 'Valid', question: 'Valid question?', options: [{ label: 'Yes' }] },
          { header: 'Missing question field', options: [{ label: 'Yes' }] }, // No question
          { header: 'Missing options', question: 'Where?' }, // No options
          { question: 'Missing header?', options: [{ label: 'Yes' }] }, // No header
        ],
      });

      async function* mockStream() {
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            content: [{ type: 'text', text: `\`\`\`json\n${questionsJson}\n\`\`\`` }],
          },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.sendMessage(startResult.value.id, 'Create a task');

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Only the valid question should be kept
        expect(result.value.pendingQuestions?.questions).toHaveLength(1);
        expect(result.value.pendingQuestions?.questions[0]?.header).toBe('Valid');
      }
    });

    it('tracks question round and total asked correctly', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      const questionsJson = JSON.stringify({
        type: 'clarifying_questions',
        questions: [
          { header: 'Q1', question: 'First?', options: [{ label: 'Yes' }] },
          { header: 'Q2', question: 'Second?', options: [{ label: 'No' }] },
        ],
      });

      async function* mockStream() {
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            content: [{ type: 'text', text: `\`\`\`json\n${questionsJson}\n\`\`\`` }],
          },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.sendMessage(startResult.value.id, 'Create a task');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pendingQuestions?.round).toBe(1);
        expect(result.value.pendingQuestions?.totalAsked).toBe(2);
        expect(result.value.questionRound).toBe(1);
        expect(result.value.totalQuestionsAsked).toBe(2);
      }
    });
  });

  describe('suggestion parsing', () => {
    it('handles invalid JSON gracefully', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      async function* mockStream() {
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            content: [{ type: 'text', text: '```json\n{invalid json}\n```' }],
          },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.sendMessage(startResult.value.id, 'Create a task');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestion).toBeNull();
      }
    });

    it('handles missing required fields', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      async function* mockStream() {
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            content: [
              {
                type: 'text',
                text: '```json\n{"type": "task_suggestion", "title": "Test"}\n```', // Missing description
              },
            ],
          },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.sendMessage(startResult.value.id, 'Create a task');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestion).toBeNull();
      }
    });

    it('handles wrong type field', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      async function* mockStream() {
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            content: [
              {
                type: 'text',
                text: '```json\n{"type": "other_type", "title": "Test", "description": "Desc"}\n```',
              },
            ],
          },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.sendMessage(startResult.value.id, 'Create a task');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestion).toBeNull();
      }
    });

    it('uses defaults for missing optional fields', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      async function* mockStream() {
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: {
            content: [
              {
                type: 'text',
                text: '```json\n{"type": "task_suggestion", "title": "Test", "description": "Desc"}\n```',
              },
            ],
          },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(db as never, streams as never);
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.sendMessage(startResult.value.id, 'Create a task');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestion).not.toBeNull();
        expect(result.value.suggestion?.labels).toEqual([]);
        expect(result.value.suggestion?.priority).toBe('medium');
      }
    });
  });

  describe('tool event tracking', () => {
    it('publishes tool:start event when receiving content_block_start with tool_use', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const sessionService = createSessionServiceMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      async function* mockStream() {
        yield {
          type: 'stream_event',
          session_id: 'sdk-session-1',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
          },
        };
        yield {
          type: 'stream_event',
          session_id: 'sdk-session-1',
          event: { type: 'content_block_stop', index: 0 },
        };
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { content: [{ type: 'text', text: 'Done' }] },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(
        db as never,
        streams as never,
        sessionService as never
      );
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      await service.sendMessage(startResult.value.id, 'test message');

      // Find the tool:start publish call
      const toolStartCall = sessionService.publish.mock.calls.find(
        (call) => call[1]?.type === 'tool:start'
      );

      expect(toolStartCall).toBeDefined();
      expect(toolStartCall?.[1]?.data).toMatchObject({
        id: 'tool-1',
        tool: 'Read',
      });
    });

    it('publishes tool:result event when receiving content_block_stop', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const sessionService = createSessionServiceMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      async function* mockStream() {
        yield {
          type: 'stream_event',
          session_id: 'sdk-session-1',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
          },
        };
        yield {
          type: 'stream_event',
          session_id: 'sdk-session-1',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"file_path": "/test.txt"}' },
          },
        };
        yield {
          type: 'stream_event',
          session_id: 'sdk-session-1',
          event: { type: 'content_block_stop', index: 0 },
        };
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { content: [{ type: 'text', text: 'Done' }] },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(
        db as never,
        streams as never,
        sessionService as never
      );
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      await service.sendMessage(startResult.value.id, 'test message');

      // Find the tool:result publish call
      const toolResultCall = sessionService.publish.mock.calls.find(
        (call) => call[1]?.type === 'tool:result'
      );

      expect(toolResultCall).toBeDefined();
      expect(toolResultCall?.[1]?.data).toMatchObject({
        id: 'tool-1',
        tool: 'Read',
        input: { file_path: '/test.txt' },
        isError: false,
      });
      expect(toolResultCall?.[1]?.data?.duration).toBeGreaterThanOrEqual(0);
    });

    it('accumulates input_json_delta events correctly', async () => {
      const db = createDbMock();
      const streams = createStreamsMock();
      const sessionService = createSessionServiceMock();
      const v2Session = createV2SessionMock();

      db.query.projects.findFirst.mockResolvedValue({ id: 'p1' });
      vi.mocked(unstable_v2_createSession).mockReturnValue(v2Session as never);

      async function* mockStream() {
        yield {
          type: 'stream_event',
          session_id: 'sdk-session-1',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tool-1', name: 'Grep' },
          },
        };
        // Split the JSON across multiple delta events
        yield {
          type: 'stream_event',
          session_id: 'sdk-session-1',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"pattern": "' },
          },
        };
        yield {
          type: 'stream_event',
          session_id: 'sdk-session-1',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: 'test' },
          },
        };
        yield {
          type: 'stream_event',
          session_id: 'sdk-session-1',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '", "path": "/src"}' },
          },
        };
        yield {
          type: 'stream_event',
          session_id: 'sdk-session-1',
          event: { type: 'content_block_stop', index: 0 },
        };
        yield {
          type: 'assistant',
          session_id: 'sdk-session-1',
          message: { content: [{ type: 'text', text: 'Done' }] },
        };
      }
      v2Session.stream.mockReturnValue(mockStream());

      const service = new TaskCreationService(
        db as never,
        streams as never,
        sessionService as never
      );
      const startResult = await service.startConversation('p1');

      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      await service.sendMessage(startResult.value.id, 'test message');

      // Find the tool:result publish call
      const toolResultCall = sessionService.publish.mock.calls.find(
        (call) => call[1]?.type === 'tool:result'
      );

      expect(toolResultCall).toBeDefined();
      expect(toolResultCall?.[1]?.data).toMatchObject({
        id: 'tool-1',
        tool: 'Grep',
        input: { pattern: 'test', path: '/src' },
      });
    });
  });
});
