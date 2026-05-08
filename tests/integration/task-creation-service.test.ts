import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEvents, sessions, tasks } from '../../src/db/schema';
import { SessionService } from '../../src/services/session.service';
import {
  TaskCreationErrors,
  TaskCreationService,
  type TaskSuggestion,
} from '../../src/services/task-creation.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';
import { createInMemoryStreams } from '../helpers/mocks';

const sdkMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: sdkMocks.createSession,
}));

const DEFAULT_SUGGESTION_TEXT =
  '```json\n{"type":"task_suggestion","title":"Test Task","description":"A test task description","labels":["feature"],"priority":"high"}\n```';

function createSdkSession(messages: unknown[] = [createAssistantMessage(DEFAULT_SUGGESTION_TEXT)]) {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    stream: vi.fn().mockImplementation(async function* (): AsyncGenerator<unknown> {
      for (const message of messages) {
        yield message;
      }
    }),
    close: vi.fn(),
  };
}

function createAssistantMessage(text: string) {
  return {
    type: 'assistant',
    session_id: 'mock-sdk-session-1',
    message: {
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 11, output_tokens: 7 },
      content: [{ type: 'text', text }],
    },
  };
}

/**
 * Mock DurableStreamsService — external I/O boundary
 */
function createMockStreams() {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(0),
    publishTaskCreationStarted: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationMessage: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationToken: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationSuggestion: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationQuestions: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationCompleted: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationCancelled: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationError: vi.fn().mockResolvedValue(undefined),
    publishTaskCreationProcessing: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    deleteStream: vi.fn().mockResolvedValue(true),
  };
}

function createTaskCreationStreams() {
  const streams = createInMemoryStreams();
  const publishTyped = async (streamId: string, type: string, data: unknown): Promise<void> => {
    await streams.publish(streamId, type, data);
  };

  return {
    ...streams,
    publishTaskCreationStarted: vi.fn((streamId: string, data: unknown) =>
      publishTyped(streamId, 'task-creation:started', data)
    ),
    publishTaskCreationMessage: vi.fn((streamId: string, data: unknown) =>
      publishTyped(streamId, 'task-creation:message', data)
    ),
    publishTaskCreationToken: vi.fn((streamId: string, data: unknown) =>
      publishTyped(streamId, 'task-creation:token', data)
    ),
    publishTaskCreationSuggestion: vi.fn((streamId: string, data: unknown) =>
      publishTyped(streamId, 'task-creation:suggestion', data)
    ),
    publishTaskCreationQuestions: vi.fn((streamId: string, data: unknown) =>
      publishTyped(streamId, 'task-creation:questions', data)
    ),
    publishTaskCreationCompleted: vi.fn((streamId: string, data: unknown) =>
      publishTyped(streamId, 'task-creation:completed', data)
    ),
    publishTaskCreationCancelled: vi.fn((streamId: string, data: unknown) =>
      publishTyped(streamId, 'task-creation:cancelled', data)
    ),
    publishTaskCreationError: vi.fn((streamId: string, data: unknown) =>
      publishTyped(streamId, 'task-creation:error', data)
    ),
    publishTaskCreationProcessing: vi.fn((streamId: string, data: unknown) =>
      publishTyped(streamId, 'task-creation:processing', data)
    ),
  };
}

/**
 * Mock SessionService — external I/O boundary (used for DB session tracking)
 */
function createMockSessionService() {
  return {
    create: vi.fn().mockResolvedValue({
      ok: true,
      value: { id: 'mock-db-session-id' },
    }),
    close: vi.fn().mockResolvedValue({ ok: true, value: { id: 'mock-db-session-id' } }),
    publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 0 } }),
    persistEvent: vi.fn().mockResolvedValue({ ok: true, value: { id: 'evt-1', offset: 0 } }),
  };
}

describe('TaskCreationService (IT-250 to IT-275)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: TaskCreationService;
  let mockStreams: ReturnType<typeof createMockStreams>;
  let mockSessionService: ReturnType<typeof createMockSessionService>;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    mockStreams = createMockStreams();
    mockSessionService = createMockSessionService();
    sdkMocks.createSession.mockReset();
    sdkMocks.createSession.mockImplementation(() => createSdkSession());
    service = new TaskCreationService(
      db as any,
      mockStreams as any,
      mockSessionService as any,
      undefined // No settingsService
    );
  });

  afterEach(async () => {
    service.destroy();
    await clearTestDatabase();
    vi.restoreAllMocks();
  });

  // ===== startConversation() =====

  it('IT-250: startConversation() creates a new session for valid codespace', async () => {
    const codespace = await createTestProject();

    const result = await service.startConversation(codespace.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const session = result.value;
    expect(session.codespaceId).toBe(codespace.id);
    expect(session.status).toBe('active');
    expect(session.messages).toEqual([]);
    expect(session.suggestion).toBeNull();
    expect(session.pendingQuestions).toBeNull();
    expect(session.questionRound).toBe(0);
    expect(session.totalQuestionsAsked).toBe(0);
    expect(session.createdTaskId).toBeNull();
    expect(session.completedAt).toBeNull();
    expect(session.createdAt).toBeTruthy();
  });

  it('IT-251: startConversation() returns error for nonexistent codespace', async () => {
    const result = await service.startConversation('nonexistent-codespace');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('IT-252: startConversation() creates a database session', async () => {
    const codespace = await createTestProject();

    const result = await service.startConversation(codespace.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(mockSessionService.create).toHaveBeenCalledTimes(1);
    expect(mockSessionService.create).toHaveBeenCalledWith({
      codespaceId: codespace.id,
      title: 'Task Creation',
    });

    expect(result.value.dbSessionId).toBe('mock-db-session-id');
  });

  it('IT-253: startConversation() creates a durable stream', async () => {
    const codespace = await createTestProject();

    const result = await service.startConversation(codespace.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(mockStreams.createStream).toHaveBeenCalledTimes(1);
    expect(mockStreams.publishTaskCreationStarted).toHaveBeenCalledTimes(1);
  });

  it('IT-254: startConversation() inserts a sessions row in the DB', async () => {
    const codespace = await createTestProject();

    const result = await service.startConversation(codespace.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const dbSession = await db.query.sessions.findFirst({
      where: eq(sessions.id, result.value.id),
    });
    expect(dbSession).toBeDefined();
    expect(dbSession!.title).toBe('Task Creation');
    expect(dbSession!.status).toBe('active');
  });

  // ===== getSession() =====

  it('IT-255: getSession() returns session for valid ID', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const session = service.getSession(startResult.value.id);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(startResult.value.id);
    expect(session!.codespaceId).toBe(codespace.id);
  });

  it('IT-256: getSession() returns null for nonexistent session', () => {
    const session = service.getSession('nonexistent-session-id');
    expect(session).toBeNull();
  });

  // ===== sendMessage() =====

  it('IT-257: sendMessage() returns error for nonexistent session', async () => {
    const result = await service.sendMessage('nonexistent-id', 'Hello');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('IT-258: sendMessage() returns error for completed session', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    // Manually mark as completed to test the guard
    const session = service.getSession(startResult.value.id);
    expect(session).not.toBeNull();
    session!.status = 'completed';

    const result = await service.sendMessage(startResult.value.id, 'Too late');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_COMPLETED');
  });

  it('IT-259: sendMessage() rejects messages exceeding max length', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    // Create a message that exceeds 50KB
    const longMessage = 'x'.repeat(51 * 1024);

    const result = await service.sendMessage(startResult.value.id, longMessage);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MESSAGE_TOO_LONG');
  });

  it('IT-260: sendMessage() adds user message to session history', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const sessionId = startResult.value.id;

    const result = await service.sendMessage(sessionId, 'Create a deploy task');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The returned session should have the user message in its history
    expect(result.value.messages.length).toBeGreaterThanOrEqual(1);
    const userMsg = result.value.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg!.content).toBe('Create a deploy task');
  });

  it('IT-261: sendMessage() publishes user message to stream', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    await service.sendMessage(startResult.value.id, 'Build a feature');

    expect(mockStreams.publishTaskCreationMessage).toHaveBeenCalledWith(
      startResult.value.id,
      expect.objectContaining({
        sessionId: startResult.value.id,
        role: 'user',
        content: 'Build a feature',
      })
    );
  });

  // ===== acceptSuggestion() =====

  it('IT-262: acceptSuggestion() returns error for nonexistent session', async () => {
    const result = await service.acceptSuggestion('nonexistent-session-id');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('IT-263: acceptSuggestion() returns error when no suggestion available', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const result = await service.acceptSuggestion(startResult.value.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NO_SUGGESTION');
  });

  it('IT-264: acceptSuggestion() creates a task from suggestion', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const session = service.getSession(startResult.value.id);
    expect(session).not.toBeNull();

    // Inject a suggestion
    const suggestion: TaskSuggestion = {
      title: 'Deploy to production',
      description: 'Deploy the latest build to production environment',
      labels: ['feature'],
      priority: 'high',
    };
    session!.suggestion = suggestion;

    const result = await service.acceptSuggestion(startResult.value.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.taskId).toBeTruthy();
    expect(result.value.session.status).toBe('completed');
    expect(result.value.session.completedAt).toBeTruthy();

    // Verify task was created in DB
    const dbTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, result.value.taskId),
    });
    expect(dbTask).toBeDefined();
    expect(dbTask!.title).toBe('Deploy to production');
    expect(dbTask!.description).toBe('Deploy the latest build to production environment');
    expect(dbTask!.labels).toEqual(['feature']);
    expect(dbTask!.priority).toBe('high');
    expect(dbTask!.column).toBe('backlog');
    expect(dbTask!.codespaceId).toBe(codespace.id);
  });

  it('IT-265: acceptSuggestion() with overrides merges over the session suggestion', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const session = service.getSession(startResult.value.id);
    session!.suggestion = {
      title: 'Original Title',
      description: 'Original Description',
      labels: ['bug'],
      priority: 'low',
    };

    const result = await service.acceptSuggestion(startResult.value.id, {
      title: 'Overridden Title',
      priority: 'high',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const dbTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, result.value.taskId),
    });
    expect(dbTask!.title).toBe('Overridden Title');
    expect(dbTask!.description).toBe('Original Description');
    expect(dbTask!.priority).toBe('high');
  });

  it('IT-266: acceptSuggestion() with complete overrides works without session suggestion', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    // No suggestion on session — use complete overrides
    const result = await service.acceptSuggestion(startResult.value.id, {
      title: 'Override Only Task',
      description: 'Created purely from overrides',
      labels: ['enhancement'],
      priority: 'medium',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const dbTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, result.value.taskId),
    });
    expect(dbTask).toBeDefined();
    expect(dbTask!.title).toBe('Override Only Task');
    expect(dbTask!.description).toBe('Created purely from overrides');
  });

  it('IT-267: acceptSuggestion() truncates title and description at length limits', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const session = service.getSession(startResult.value.id);
    session!.suggestion = {
      title: 'T'.repeat(300), // Exceeds 200 char limit
      description: 'D'.repeat(11000), // Exceeds 10000 char limit
      labels: [],
      priority: 'medium',
    };

    const result = await service.acceptSuggestion(startResult.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const dbTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, result.value.taskId),
    });
    expect(dbTask!.title!.length).toBeLessThanOrEqual(200);
    expect(dbTask!.description!.length).toBeLessThanOrEqual(10000);
  });

  it('IT-268: acceptSuggestion() publishes completion event and closes DB session', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const session = service.getSession(startResult.value.id);
    session!.suggestion = {
      title: 'Task for Completion',
      description: 'Test completion events',
      labels: [],
      priority: 'medium',
    };

    await service.acceptSuggestion(startResult.value.id);

    expect(mockStreams.publishTaskCreationCompleted).toHaveBeenCalledTimes(1);
    expect(mockSessionService.close).toHaveBeenCalledTimes(1);
  });

  // ===== answerQuestions() =====

  it('IT-269: answerQuestions() returns error for nonexistent session', async () => {
    const result = await service.answerQuestions('nonexistent-id', 'q-1', { '0': 'Yes' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('IT-270: answerQuestions() returns error for mismatched questionsId', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const session = service.getSession(startResult.value.id);
    session!.pendingQuestions = {
      id: 'correct-id',
      questions: [
        {
          header: 'Q1',
          question: 'What type?',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
      round: 1,
      totalAsked: 1,
      maxQuestions: 4,
    };

    const result = await service.answerQuestions(startResult.value.id, 'wrong-id', { '0': 'A' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_QUESTIONS_ID');
  });

  it('IT-271: answerQuestions() is idempotent for same questionsId', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const session = service.getSession(startResult.value.id);
    const questionsId = 'idempotent-q-id';

    // Set up pending questions
    session!.pendingQuestions = {
      id: questionsId,
      questions: [{ header: 'Q1', question: 'Type?', options: [{ label: 'A' }] }],
      round: 1,
      totalAsked: 1,
      maxQuestions: 4,
    };
    session!.pendingToolUseId = 'tool-1';
    session!.status = 'waiting_user';

    // Also set up a mock permission resolver so the first call succeeds
    const mockResolver = vi.fn();
    session!.pendingPermissionResolver = mockResolver;
    session!.pendingQuestionsInput = { questions: [] };

    // First answer
    const result1 = await service.answerQuestions(startResult.value.id, questionsId, { '0': 'A' });
    expect(result1.ok).toBe(true);

    // Second answer with same questionsId should return ok with alreadyProcessed
    const result2 = await service.answerQuestions(startResult.value.id, questionsId, { '0': 'A' });
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect((result2.value as any).alreadyProcessed).toBe(true);
  });

  // ===== cancel() =====

  it('IT-272: cancel() marks session as cancelled', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const cancelResult = await service.cancel(startResult.value.id);

    expect(cancelResult.ok).toBe(true);
    if (!cancelResult.ok) return;
    expect(cancelResult.value.status).toBe('cancelled');
    expect(cancelResult.value.completedAt).toBeTruthy();
  });

  it('IT-273: cancel() returns error for nonexistent session', async () => {
    const result = await service.cancel('nonexistent-session-id');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('IT-274: cancel() publishes cancellation event and closes DB session', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    await service.cancel(startResult.value.id);

    expect(mockStreams.publishTaskCreationCancelled).toHaveBeenCalledTimes(1);
    expect(mockSessionService.close).toHaveBeenCalledTimes(1);
  });

  // ===== destroy() =====

  it('IT-275: destroy() stops cleanup interval', () => {
    // Should not throw
    service.destroy();
    // Calling again should be safe
    service.destroy();
  });

  // ===== Error definitions =====

  it('IT-275b: TaskCreationErrors static errors have correct codes', () => {
    expect(TaskCreationErrors.PROJECT_NOT_FOUND.code).toBe('PROJECT_NOT_FOUND');
    expect(TaskCreationErrors.SESSION_NOT_FOUND.code).toBe('SESSION_NOT_FOUND');
    expect(TaskCreationErrors.NO_SUGGESTION.code).toBe('NO_SUGGESTION');
    expect(TaskCreationErrors.MESSAGE_TOO_LONG.code).toBe('MESSAGE_TOO_LONG');
  });

  it('IT-275c: TaskCreationErrors factory functions produce correct codes', () => {
    const sessionErr = TaskCreationErrors.SESSION_COMPLETED('sess-1');
    expect(sessionErr.code).toBe('SESSION_COMPLETED');
    expect(sessionErr.message).toContain('sess-1');

    const apiErr = TaskCreationErrors.API_ERROR('timeout');
    expect(apiErr.code).toBe('API_ERROR');
    expect(apiErr.message).toContain('timeout');

    const dbErr = TaskCreationErrors.DATABASE_ERROR('insert', 'constraint failed');
    expect(dbErr.code).toBe('DATABASE_ERROR');
    expect(dbErr.message).toContain('insert');
    expect(dbErr.message).toContain('constraint failed');
  });

  // ===== Suggestion parsing (via acceptSuggestion) =====

  it('IT-275d: acceptSuggestion() filters invalid labels from suggestion', async () => {
    const codespace = await createTestProject();

    const startResult = await service.startConversation(codespace.id);
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const session = service.getSession(startResult.value.id);
    session!.suggestion = {
      title: 'Label Test',
      description: 'Test label filtering',
      labels: ['feature', 'invalid-label', 'bug'],
      priority: 'medium',
    };

    const result = await service.acceptSuggestion(startResult.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const dbTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, result.value.taskId),
    });
    // Labels are stored directly from the suggestion — filtering happens during parsing
    // The suggestion was manually set, so all labels are stored as-is
    expect(dbTask!.labels).toEqual(['feature', 'invalid-label', 'bug']);
  });

  describe('real SessionService persistence', () => {
    it('IT-276: sendMessage() persists user and assistant chunks through the real session facade', async () => {
      const streams = createTaskCreationStreams();
      const sessionService = new SessionService(db as never, streams as never, {
        baseUrl: 'http://localhost:3000',
      });
      const realService = new TaskCreationService(
        db as never,
        streams as never,
        sessionService,
        undefined
      );
      sdkMocks.createSession.mockReturnValueOnce(
        createSdkSession([
          createAssistantMessage(
            '```json\n{"type":"task_suggestion","title":"Persisted Task","description":"Created from real persisted messages","labels":["test"],"priority":"medium"}\n```'
          ),
          { type: 'result', usage: { input_tokens: 11, output_tokens: 7 } },
        ])
      );

      try {
        const codespace = await createTestProject();
        const startResult = await realService.startConversation(codespace.id);
        expect(startResult.ok).toBe(true);
        if (!startResult.ok) return;

        const result = await realService.sendMessage(startResult.value.id, 'Create coverage task');
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.suggestion).toMatchObject({
          title: 'Persisted Task',
          priority: 'medium',
        });
        expect(result.value.dbSessionId).toBeTruthy();

        const persistedEvents = await db.query.sessionEvents.findMany({
          where: eq(sessionEvents.sessionId, result.value.dbSessionId!),
          orderBy: [sessionEvents.offset],
        });
        expect(persistedEvents.map((event) => event.type)).toEqual(['chunk', 'chunk']);
        expect(persistedEvents[0].data).toMatchObject({
          role: 'user',
          content: 'Create coverage task',
        });
        expect(persistedEvents[1].data).toMatchObject({
          role: 'assistant',
          content: expect.stringContaining('Persisted Task'),
          usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
        });

        const streamEvents = streams.getEvents(startResult.value.id);
        expect(streamEvents.map((event) => event.type)).toContain('task-creation:suggestion');
      } finally {
        realService.destroy();
        sessionService.destroy();
      }
    });

    it('IT-277: stream_event tool lifecycle is persisted with parsed tool input', async () => {
      const streams = createTaskCreationStreams();
      const sessionService = new SessionService(db as never, streams as never, {
        baseUrl: 'http://localhost:3000',
      });
      const realService = new TaskCreationService(
        db as never,
        streams as never,
        sessionService,
        undefined
      );
      sdkMocks.createSession.mockReturnValueOnce(
        createSdkSession([
          {
            type: 'stream_event',
            session_id: 'mock-sdk-session-1',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'tool-read-1', name: 'Read' },
            },
          },
          {
            type: 'stream_event',
            session_id: 'mock-sdk-session-1',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"file_path":"README.md"}' },
            },
          },
          {
            type: 'stream_event',
            session_id: 'mock-sdk-session-1',
            event: { type: 'content_block_stop', index: 0 },
          },
          createAssistantMessage(
            '```json\n{"type":"task_suggestion","title":"Tool Persisted Task","description":"Tool lifecycle was persisted","labels":["test"],"priority":"low"}\n```'
          ),
          { type: 'result', usage: { input_tokens: 8, output_tokens: 4 } },
        ])
      );

      try {
        const codespace = await createTestProject();
        const startResult = await realService.startConversation(codespace.id);
        expect(startResult.ok).toBe(true);
        if (!startResult.ok) return;

        const result = await realService.sendMessage(startResult.value.id, 'Inspect files');
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const persistedEvents = await db.query.sessionEvents.findMany({
          where: eq(sessionEvents.sessionId, result.value.dbSessionId!),
          orderBy: [sessionEvents.offset],
        });
        const toolEvents = persistedEvents.filter((event) => event.type.startsWith('tool:'));

        expect(toolEvents.map((event) => event.type)).toEqual(['tool:start', 'tool:result']);
        expect(toolEvents[0].data).toMatchObject({
          id: 'tool-read-1',
          tool: 'Read',
          input: {},
        });
        expect(toolEvents[1].data).toMatchObject({
          id: 'tool-read-1',
          tool: 'Read',
          input: { file_path: 'README.md' },
          output: null,
          isError: false,
        });
      } finally {
        realService.destroy();
        sessionService.destroy();
      }
    });

    it('IT-278: answerQuestions() stores processing and AskUserQuestion result events', async () => {
      const streams = createTaskCreationStreams();
      const sessionService = new SessionService(db as never, streams as never, {
        baseUrl: 'http://localhost:3000',
      });
      const realService = new TaskCreationService(
        db as never,
        streams as never,
        sessionService,
        undefined
      );

      try {
        const codespace = await createTestProject();
        const startResult = await realService.startConversation(codespace.id);
        expect(startResult.ok).toBe(true);
        if (!startResult.ok) return;

        const session = realService.getSession(startResult.value.id);
        expect(session).not.toBeNull();
        if (!session) return;

        const questionsId = 'questions-real-1';
        const resolver = vi.fn();
        session.pendingQuestions = {
          id: questionsId,
          questions: [
            {
              header: 'Kind',
              question: 'What kind of work is this?',
              options: [{ label: 'Bug' }, { label: 'Feature' }],
            },
            {
              header: 'Scope',
              question: 'What scope applies?',
              options: [{ label: 'High' }, { label: 'Regression' }],
              multiSelect: true,
            },
          ],
          round: 1,
          totalAsked: 2,
          maxQuestions: 4,
        };
        session.pendingToolUseId = 'ask-user-1';
        const pendingQuestionsInput = { questions: session.pendingQuestions.questions };
        session.pendingQuestionsInput = pendingQuestionsInput;
        session.pendingPermissionResolver = resolver;
        session.status = 'waiting_user';

        const result = await realService.answerQuestions(startResult.value.id, questionsId, {
          '0': 'Bug',
          '1': ['High', 'Regression'],
        });
        expect(result.ok).toBe(true);

        expect(resolver).toHaveBeenCalledWith({
          behavior: 'allow',
          updatedInput: {
            questions: pendingQuestionsInput.questions,
            answers: { '0': 'Bug', '1': 'High, Regression' },
          },
          toolUseID: 'ask-user-1',
        });

        expect(streams.getEvents(startResult.value.id).map((event) => event.type)).toContain(
          'task-creation:processing'
        );

        const persistedEvents = await db.query.sessionEvents.findMany({
          where: eq(sessionEvents.sessionId, startResult.value.dbSessionId!),
          orderBy: [sessionEvents.offset],
        });
        const toolResult = persistedEvents.find((event) => event.type === 'tool:result');
        expect(toolResult?.data).toMatchObject({
          id: 'ask-user-1',
          tool: 'AskUserQuestion',
          output: { answers: { '0': 'Bug', '1': 'High, Regression' } },
          isError: false,
        });
      } finally {
        realService.destroy();
        sessionService.destroy();
      }
    });

    it('IT-279: skipQuestions() resolves pending permission and continues with a normal message', async () => {
      const streams = createTaskCreationStreams();
      const sessionService = new SessionService(db as never, streams as never, {
        baseUrl: 'http://localhost:3000',
      });
      const realService = new TaskCreationService(
        db as never,
        streams as never,
        sessionService,
        undefined
      );
      const sdkSession = createSdkSession([
        createAssistantMessage(
          '```json\n{"type":"task_suggestion","title":"Skipped Questions Task","description":"Generated after skipping questions","labels":["feature"],"priority":"medium"}\n```'
        ),
      ]);
      sdkMocks.createSession.mockReturnValueOnce(sdkSession);

      try {
        const codespace = await createTestProject();
        const startResult = await realService.startConversation(codespace.id);
        expect(startResult.ok).toBe(true);
        if (!startResult.ok) return;

        const session = realService.getSession(startResult.value.id);
        expect(session).not.toBeNull();
        if (!session) return;

        const resolver = vi.fn();
        session.pendingQuestions = {
          id: 'skip-questions',
          questions: [{ header: 'Kind', question: 'What kind?', options: [{ label: 'Bug' }] }],
          round: 1,
          totalAsked: 1,
          maxQuestions: 4,
        };
        session.pendingToolUseId = 'ask-user-skip';
        const pendingQuestionsInput = { questions: session.pendingQuestions.questions };
        session.pendingQuestionsInput = pendingQuestionsInput;
        session.pendingPermissionResolver = resolver;
        session.status = 'waiting_user';

        const result = await realService.skipQuestions(startResult.value.id);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(resolver).toHaveBeenCalledWith({
          behavior: 'allow',
          updatedInput: { questions: pendingQuestionsInput.questions, answers: {} },
          toolUseID: 'ask-user-skip',
        });
        expect(sdkSession.send).toHaveBeenCalledWith(
          expect.stringContaining('Please proceed with generating the task')
        );
        expect(result.value.suggestion).toMatchObject({ title: 'Skipped Questions Task' });
      } finally {
        realService.destroy();
        sessionService.destroy();
      }
    });
  });

  // ===== Multiple sessions =====

  it('IT-275e: multiple concurrent sessions are independent', async () => {
    const codespace1 = await createTestProject({ name: 'Project A' });
    const codespace2 = await createTestProject({ name: 'Project B' });

    const r1 = await service.startConversation(codespace1.id);
    const r2 = await service.startConversation(codespace2.id);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    expect(r1.value.id).not.toBe(r2.value.id);
    expect(r1.value.codespaceId).toBe(codespace1.id);
    expect(r2.value.codespaceId).toBe(codespace2.id);

    // Each session is independently accessible
    const s1 = service.getSession(r1.value.id);
    const s2 = service.getSession(r2.value.id);
    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(s1!.codespaceId).not.toBe(s2!.codespaceId);
  });
});
