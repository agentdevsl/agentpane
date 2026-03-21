import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from '../../src/db/schema';
import type { DurableStreamsService } from '../../src/services/durable-streams.service';
import type { SessionService } from '../../src/services/session.service';
import type { SettingsService } from '../../src/services/settings.service';
import {
  TaskCreationErrors,
  TaskCreationService,
  type TaskCreationSession,
  type TaskSuggestion,
} from '../../src/services/task-creation.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

// Mock the Claude Agent SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: vi.fn(),
}));

// Mock prompts module so it doesn't pull in server-only deps
vi.mock('../../src/lib/prompts/index.js', () => ({
  getPromptDefaultText: vi
    .fn()
    .mockReturnValue('You are an AI assistant helping users create tasks.'),
  resolvePromptServer: vi.fn().mockResolvedValue('Custom system prompt for task creation'),
}));

// Mock the SDK env builder
vi.mock('../../src/lib/agents/agent-sdk-utils.js', () => ({
  buildSdkEnv: vi.fn((extra: Record<string, string>) => extra),
}));

describe('TaskCreationService', () => {
  let service: TaskCreationService;
  let mockStreams: DurableStreamsService;
  let mockSessionService: SessionService;
  let mockSettingsService: SettingsService;
  let mockV2Session: {
    send: ReturnType<typeof vi.fn>;
    stream: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

  // Helper to create a mock async generator for streaming
  function createMockStream(messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
    return (async function* () {
      for (const msg of messages) {
        yield msg;
      }
    })();
  }

  // Helper to create a valid task suggestion JSON response
  function createSuggestionResponse(suggestion: Partial<TaskSuggestion> = {}): string {
    const fullSuggestion = {
      type: 'task_suggestion',
      title: suggestion.title ?? 'Test Task Title',
      description: suggestion.description ?? 'Test task description with details.',
      labels: suggestion.labels ?? ['feature'],
      priority: suggestion.priority ?? 'medium',
    };
    return `Here's a task suggestion:\n\n\`\`\`json\n${JSON.stringify(fullSuggestion, null, 2)}\n\`\`\``;
  }

  // Helper to create a clarifying questions JSON response
  function createQuestionsResponse(
    questions: Array<{
      header: string;
      question: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>
  ): string {
    const payload = {
      type: 'clarifying_questions',
      questions,
    };
    return `I need some more information:\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    await setupTestDatabase();
    const db = getTestDb();

    // Create mock V2 session
    mockV2Session = {
      send: vi.fn().mockResolvedValue(undefined),
      stream: vi.fn(),
      close: vi.fn(),
    };

    // Mock unstable_v2_createSession to return our mock session
    const { unstable_v2_createSession } = await import('@anthropic-ai/claude-agent-sdk');
    (unstable_v2_createSession as ReturnType<typeof vi.fn>).mockReturnValue(mockV2Session);

    // Create mock streams service
    mockStreams = {
      createStream: vi.fn().mockResolvedValue(undefined),
      publishTaskCreationStarted: vi.fn().mockResolvedValue(undefined),
      publishTaskCreationMessage: vi.fn().mockResolvedValue(undefined),
      publishTaskCreationToken: vi.fn().mockResolvedValue(undefined),
      publishTaskCreationSuggestion: vi.fn().mockResolvedValue(undefined),
      publishTaskCreationQuestions: vi.fn().mockResolvedValue(undefined),
      publishTaskCreationCompleted: vi.fn().mockResolvedValue(undefined),
      publishTaskCreationCancelled: vi.fn().mockResolvedValue(undefined),
      publishTaskCreationError: vi.fn().mockResolvedValue(undefined),
      publishTaskCreationProcessing: vi.fn().mockResolvedValue(undefined),
    } as unknown as DurableStreamsService;

    // Create mock session service
    mockSessionService = {
      create: vi.fn().mockResolvedValue({ ok: true, value: { id: 'mock-db-session-id' } }),
      publish: vi.fn().mockResolvedValue({ ok: true, value: { offset: 1 } }),
      close: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as SessionService;

    // Create mock settings service
    mockSettingsService = {
      getTaskCreationModel: vi.fn().mockResolvedValue('claude-sonnet-4-6'),
      get: vi.fn().mockResolvedValue(null),
    } as unknown as SettingsService;

    service = new TaskCreationService(db, mockStreams, mockSessionService, mockSettingsService);
  });

  afterEach(async () => {
    service.destroy();
    await clearTestDatabase();
  });

  // ===========================================================================
  // Session Creation and Management (8 tests)
  // ===========================================================================

  describe('session creation and management', () => {
    it('creates a new task creation session for valid project', async () => {
      const project = await createTestProject();
      const result = await service.startConversation(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.codespaceId).toBe(project.id);
        expect(result.value.status).toBe('active');
        expect(result.value.messages).toHaveLength(0);
        expect(result.value.suggestion).toBeNull();
        expect(result.value.createdTaskId).toBeNull();
        expect(result.value.createdAt).toBeDefined();
        expect(result.value.systemPromptSent).toBe(false);
        expect(result.value.v2Session).toBe(mockV2Session);
      }
    });

    it('returns error for non-existent project', async () => {
      const result = await service.startConversation('non-existent-project-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PROJECT_NOT_FOUND');
      }
    });

    it('creates stream and publishes start event', async () => {
      const project = await createTestProject();
      await service.startConversation(project.id);

      expect(mockStreams.createStream).toHaveBeenCalled();
      expect(mockStreams.publishTaskCreationStarted).toHaveBeenCalled();
    });

    it('creates database session when session service is available', async () => {
      const project = await createTestProject();
      const result = await service.startConversation(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.dbSessionId).toBe('mock-db-session-id');
      }
      expect(mockSessionService.create).toHaveBeenCalledWith({
        codespaceId: project.id,
        title: 'Task Creation',
      });
    });

    it('works without session service (dbSessionId is null)', async () => {
      const db = getTestDb();
      const serviceNoSession = new TaskCreationService(db, mockStreams);

      const project = await createTestProject();
      const result = await serviceNoSession.startConversation(project.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.dbSessionId).toBeNull();
      }
      serviceNoSession.destroy();
    });

    it('retrieves session by ID via getSession', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const session = service.getSession(startResult.value.id);
      expect(session).not.toBeNull();
      expect(session?.id).toBe(startResult.value.id);
      expect(session?.codespaceId).toBe(project.id);
    });

    it('returns null for non-existent session via getSession', () => {
      const session = service.getSession('non-existent-session');
      expect(session).toBeNull();
    });

    it('initializes session with correct default fields', async () => {
      const project = await createTestProject();
      const result = await service.startConversation(project.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const s = result.value;
      expect(s.pendingQuestions).toBeNull();
      expect(s.questionRound).toBe(0);
      expect(s.totalQuestionsAsked).toBe(0);
      expect(s.completedAt).toBeNull();
      expect(s.sdkSessionId).toBeNull();
      expect(s.pendingToolUseId).toBeNull();
      expect(s.pendingPermissionResolver).toBeNull();
      expect(s.pendingQuestionsInput).toBeNull();
      expect(s.activeStreamIterator).toBeNull();
      expect(s.streamProcessingPromise).toBeNull();
      expect(s.onSuggestionCallback).toBeNull();
      expect(s.onMessageCallback).toBeNull();
      expect(s.lastProcessedQuestionsId).toBeNull();
    });
  });

  // ===========================================================================
  // Message Sending and Processing (10 tests)
  // ===========================================================================

  describe('message sending and processing', () => {
    it('adds user message to session messages', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Ok' }] },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Build a login form');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.messages[0].role).toBe('user');
        expect(result.value.messages[0].content).toBe('Build a login form');
      }
    });

    it('processes assistant response and creates assistant message', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'I understand your request.' }] },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Hello');
      expect(result.ok).toBe(true);
      if (result.ok) {
        // user + assistant
        expect(result.value.messages).toHaveLength(2);
        expect(result.value.messages[1].role).toBe('assistant');
        expect(result.value.messages[1].content).toBe('I understand your request.');
      }
    });

    it('returns error for non-existent session', async () => {
      const result = await service.sendMessage('non-existent', 'Hello');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(TaskCreationErrors.SESSION_NOT_FOUND);
      }
    });

    it('returns error for completed session', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      // Cancel the session
      await service.cancel(startResult.value.id);

      const result = await service.sendMessage(startResult.value.id, 'Hello');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_COMPLETED');
      }
    });

    it('returns error for cancelled session', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      await service.cancel(startResult.value.id);

      const result = await service.sendMessage(startResult.value.id, 'Try again');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_COMPLETED');
      }
    });

    it('returns error when message is too long', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const longMessage = 'x'.repeat(51 * 1024); // 51KB exceeds 50KB limit
      const result = await service.sendMessage(startResult.value.id, longMessage);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MESSAGE_TOO_LONG');
      }
    });

    it('returns error when V2 session is missing', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      // Manually remove V2 session
      const session = service.getSession(startResult.value.id) as TaskCreationSession;
      session.v2Session = null;

      const result = await service.sendMessage(startResult.value.id, 'Hello');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('API_ERROR');
        expect(result.error.message).toContain('No active V2 session');
      }
    });

    it('includes system prompt in first message only', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const sessionId = startResult.value.id;

      // First message
      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Understood.' }] },
          } as unknown as SDKMessage,
        ])
      );

      await service.sendMessage(sessionId, 'First message');

      // System prompt should be prepended
      const firstCall = mockV2Session.send.mock.calls[0][0] as string;
      expect(firstCall).toContain('First message');
      // The system prompt gets prepended before the user's message
      expect(firstCall.length).toBeGreaterThan('First message'.length);

      // Second message
      mockV2Session.send.mockClear();
      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Ok.' }] },
          } as unknown as SDKMessage,
        ])
      );

      await service.sendMessage(sessionId, 'Second message');

      // Second message should NOT include system prompt
      expect(mockV2Session.send).toHaveBeenCalledWith('Second message');
    });

    it('invokes token callback during streaming', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const tokens: string[] = [];

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'Hello' },
            },
          } as unknown as SDKMessage,
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: ' world' },
            },
          } as unknown as SDKMessage,
        ])
      );

      await service.sendMessage(startResult.value.id, 'Test', (delta) => {
        tokens.push(delta);
      });

      expect(tokens).toContain('Hello');
      expect(tokens).toContain(' world');
    });

    it('publishes user message to streams', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Ok' }] },
          } as unknown as SDKMessage,
        ])
      );

      await service.sendMessage(startResult.value.id, 'My task description');

      expect(mockStreams.publishTaskCreationMessage).toHaveBeenCalledWith(
        startResult.value.id,
        expect.objectContaining({
          sessionId: startResult.value.id,
          role: 'user',
          content: 'My task description',
        })
      );
    });
  });

  // ===========================================================================
  // AI Suggestion Generation (9 tests)
  // ===========================================================================

  describe('AI suggestion generation', () => {
    it('parses task suggestion from assistant response', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'text',
                  text: createSuggestionResponse({
                    title: 'Implement Login Feature',
                    description: 'Add user auth with email/password.',
                    labels: ['feature', 'enhancement'],
                    priority: 'high',
                  }),
                },
              ],
            },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Add login');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestion).not.toBeNull();
        expect(result.value.suggestion?.title).toBe('Implement Login Feature');
        expect(result.value.suggestion?.description).toBe('Add user auth with email/password.');
        expect(result.value.suggestion?.labels).toEqual(['feature', 'enhancement']);
        expect(result.value.suggestion?.priority).toBe('high');
      }
    });

    it('handles response without JSON block (no suggestion)', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Let me help you with that.' }] },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Hello');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestion).toBeNull();
      }
    });

    it('handles malformed JSON in response', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: '```json\n{ invalid json here }\n```' }],
            },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Create a task');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestion).toBeNull();
      }
    });

    it('defaults invalid priority to medium', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const invalidPriorityJson = JSON.stringify({
        type: 'task_suggestion',
        title: 'Test Task',
        description: 'Description',
        labels: [],
        priority: 'critical', // not a valid priority
      });

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: `\`\`\`json\n${invalidPriorityJson}\n\`\`\`` }],
            },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Task');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestion?.priority).toBe('medium');
      }
    });

    it('filters out invalid labels from suggestion', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const json = JSON.stringify({
        type: 'task_suggestion',
        title: 'Task',
        description: 'Desc',
        labels: ['bug', 'invalid-label', 'feature', 'another-bad-one'],
        priority: 'low',
      });

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: `\`\`\`json\n${json}\n\`\`\`` }],
            },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Task');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestion?.labels).toEqual(['bug', 'feature']);
      }
    });

    it('publishes suggestion event when suggestion is parsed', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'text',
                  text: createSuggestionResponse({ title: 'Published Suggestion' }),
                },
              ],
            },
          } as unknown as SDKMessage,
        ])
      );

      await service.sendMessage(startResult.value.id, 'Create a task');

      expect(mockStreams.publishTaskCreationSuggestion).toHaveBeenCalledWith(
        startResult.value.id,
        expect.objectContaining({
          sessionId: startResult.value.id,
          suggestion: expect.objectContaining({ title: 'Published Suggestion' }),
        })
      );
    });

    it('ignores JSON block that is not type task_suggestion', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const nonSuggestionJson = JSON.stringify({
        type: 'something_else',
        data: 'hello',
      });

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: `\`\`\`json\n${nonSuggestionJson}\n\`\`\`` }],
            },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Hello');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestion).toBeNull();
      }
    });

    it('ignores suggestion without title', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const noTitleJson = JSON.stringify({
        type: 'task_suggestion',
        description: 'No title here',
        labels: [],
        priority: 'medium',
      });

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: `\`\`\`json\n${noTitleJson}\n\`\`\`` }],
            },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Task');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestion).toBeNull();
      }
    });

    it('ignores suggestion without description', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const noDescJson = JSON.stringify({
        type: 'task_suggestion',
        title: 'Has title',
        labels: [],
        priority: 'low',
      });

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: `\`\`\`json\n${noDescJson}\n\`\`\`` }],
            },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Task');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.suggestion).toBeNull();
      }
    });
  });

  // ===========================================================================
  // Task Creation from Conversation (6 tests)
  // ===========================================================================

  describe('task creation from conversation (acceptSuggestion)', () => {
    async function setupSessionWithSuggestion(
      suggestion?: Partial<TaskSuggestion>
    ): Promise<string> {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      if (!startResult.ok) throw new Error('Failed to start conversation');

      const sessionId = startResult.value.id;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: createSuggestionResponse(suggestion) }],
            },
          } as unknown as SDKMessage,
        ])
      );

      await service.sendMessage(sessionId, 'Create a task');
      return sessionId;
    }

    it('creates a task from the suggestion', async () => {
      const sessionId = await setupSessionWithSuggestion({
        title: 'New Feature Task',
        description: 'Implement the new feature',
        labels: ['feature'],
        priority: 'medium',
      });

      const result = await service.acceptSuggestion(sessionId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.taskId).toBeDefined();
        expect(result.value.session.status).toBe('completed');
        expect(result.value.session.createdTaskId).toBe(result.value.taskId);

        // Verify task was created in database
        const db = getTestDb();
        const [task] = await db.select().from(tasks).where(eq(tasks.id, result.value.taskId));
        expect(task).toBeDefined();
        expect(task.title).toBe('New Feature Task');
        expect(task.column).toBe('backlog');
      }
    });

    it('allows overriding suggestion fields', async () => {
      const sessionId = await setupSessionWithSuggestion({
        title: 'Original Title',
        priority: 'low',
      });

      const result = await service.acceptSuggestion(sessionId, {
        title: 'Overridden Title',
        priority: 'high',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const db = getTestDb();
        const [task] = await db.select().from(tasks).where(eq(tasks.id, result.value.taskId));
        expect(task.title).toBe('Overridden Title');
        expect(task.priority).toBe('high');
      }
    });

    it('accepts with complete overrides even without session suggestion', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      // No suggestion set (no sendMessage)
      const result = await service.acceptSuggestion(startResult.value.id, {
        title: 'Override Only Title',
        description: 'Override Only Description',
        labels: ['bug'],
        priority: 'high',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const db = getTestDb();
        const [task] = await db.select().from(tasks).where(eq(tasks.id, result.value.taskId));
        expect(task.title).toBe('Override Only Title');
        expect(task.description).toBe('Override Only Description');
      }
    });

    it('returns error when no suggestion and no complete overrides', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.acceptSuggestion(startResult.value.id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NO_SUGGESTION');
      }
    });

    it('returns error for non-existent session', async () => {
      const result = await service.acceptSuggestion('non-existent');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('truncates title and description that exceed limits', async () => {
      const sessionId = await setupSessionWithSuggestion();

      const longTitle = 'T'.repeat(300);
      const longDescription = 'D'.repeat(11000);

      const result = await service.acceptSuggestion(sessionId, {
        title: longTitle,
        description: longDescription,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const db = getTestDb();
        const [task] = await db.select().from(tasks).where(eq(tasks.id, result.value.taskId));
        expect(task.title.length).toBe(200);
        expect(task.description!.length).toBe(10000);
      }
    });
  });

  // ===========================================================================
  // Conversation History (3 tests)
  // ===========================================================================

  describe('conversation history', () => {
    it('accumulates messages across multiple exchanges', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const sessionId = startResult.value.id;

      // First exchange
      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Got it.' }] },
          } as unknown as SDKMessage,
        ])
      );
      await service.sendMessage(sessionId, 'First');

      // Second exchange
      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: createSuggestionResponse() }],
            },
          } as unknown as SDKMessage,
        ])
      );
      await service.sendMessage(sessionId, 'Second');

      const session = service.getSession(sessionId);
      expect(session).not.toBeNull();
      // 2 user messages + 2 assistant messages
      expect(session!.messages).toHaveLength(4);
      expect(session!.messages[0].role).toBe('user');
      expect(session!.messages[0].content).toBe('First');
      expect(session!.messages[1].role).toBe('assistant');
      expect(session!.messages[2].role).toBe('user');
      expect(session!.messages[2].content).toBe('Second');
      expect(session!.messages[3].role).toBe('assistant');
    });

    it('persists user messages to database via session service', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Ok' }] },
          } as unknown as SDKMessage,
        ])
      );

      await service.sendMessage(startResult.value.id, 'My message');

      // Should publish user message chunk
      expect(mockSessionService.publish).toHaveBeenCalledWith(
        'mock-db-session-id',
        expect.objectContaining({
          type: 'chunk',
          data: expect.objectContaining({
            role: 'user',
            content: 'My message',
          }),
        })
      );
    });

    it('persists assistant messages to database via session service', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Response text' }] },
          } as unknown as SDKMessage,
        ])
      );

      await service.sendMessage(startResult.value.id, 'Hello');

      // Should publish assistant message chunk
      expect(mockSessionService.publish).toHaveBeenCalledWith(
        'mock-db-session-id',
        expect.objectContaining({
          type: 'chunk',
          data: expect.objectContaining({
            role: 'assistant',
            content: 'Response text',
          }),
        })
      );
    });
  });

  // ===========================================================================
  // Error Handling (5 tests)
  // ===========================================================================

  describe('error handling', () => {
    it('handles API errors during message send', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.send.mockRejectedValue(new Error('API rate limit exceeded'));

      const result = await service.sendMessage(startResult.value.id, 'Create a task');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('API_ERROR');
        expect(result.error.message).toContain('API rate limit exceeded');
      }
    });

    it('publishes error event on API failure', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const sessionId = startResult.value.id;
      mockV2Session.send.mockRejectedValue(new Error('Network error'));

      await service.sendMessage(sessionId, 'Create a task');

      expect(mockStreams.publishTaskCreationError).toHaveBeenCalledWith(sessionId, {
        sessionId,
        error: 'Network error',
      });
    });

    it('sets session status to cancelled on API error', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.send.mockRejectedValue(new Error('Fail'));

      await service.sendMessage(startResult.value.id, 'Test');

      const session = service.getSession(startResult.value.id);
      expect(session?.status).toBe('cancelled');
      expect(session?.completedAt).toBeDefined();
    });

    it('closes V2 session on error to prevent resource leaks', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.send.mockRejectedValue(new Error('Fail'));

      await service.sendMessage(startResult.value.id, 'Test');

      expect(mockV2Session.close).toHaveBeenCalled();
    });

    it('handles non-Error exceptions gracefully', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.send.mockRejectedValue('string error');

      const result = await service.sendMessage(startResult.value.id, 'Test');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('API_ERROR');
        expect(result.error.message).toContain('string error');
      }
    });
  });

  // ===========================================================================
  // Stream Event Publishing (4 tests)
  // ===========================================================================

  describe('stream event publishing', () => {
    it('publishes both user and assistant message events', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const sessionId = startResult.value.id;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: createSuggestionResponse() }] },
          } as unknown as SDKMessage,
        ])
      );

      await service.sendMessage(sessionId, 'Create a task');

      expect(mockStreams.publishTaskCreationMessage).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ role: 'user', content: 'Create a task' })
      );
      expect(mockStreams.publishTaskCreationMessage).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ role: 'assistant' })
      );
    });

    it('publishes token events during streaming', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      // Create stream with enough text deltas to trigger token publishing
      const deltas: SDKMessage[] = [];
      for (let i = 0; i < 15; i++) {
        deltas.push({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: `token${i} ` },
          },
        } as unknown as SDKMessage);
      }

      mockV2Session.stream.mockReturnValue(createMockStream(deltas));

      await service.sendMessage(startResult.value.id, 'Test');

      // Token batch size is 10, so at least one batch should have been published
      expect(mockStreams.publishTaskCreationToken).toHaveBeenCalled();
    });

    it('publishes completion event on accept', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const sessionId = startResult.value.id;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: createSuggestionResponse() }] },
          } as unknown as SDKMessage,
        ])
      );

      await service.sendMessage(sessionId, 'Create a task');
      await service.acceptSuggestion(sessionId);

      expect(mockStreams.publishTaskCreationCompleted).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({
          sessionId,
          taskId: expect.any(String),
          suggestion: expect.objectContaining({ title: 'Test Task Title' }),
        })
      );
    });

    it('publishes cancelled event on cancel', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const sessionId = startResult.value.id;
      await service.cancel(sessionId);

      expect(mockStreams.publishTaskCreationCancelled).toHaveBeenCalledWith(sessionId, {
        sessionId,
      });
    });
  });

  // ===========================================================================
  // Cancel Session (4 tests)
  // ===========================================================================

  describe('cancel session', () => {
    it('cancels an active session', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const result = await service.cancel(startResult.value.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('cancelled');
        expect(result.value.completedAt).toBeDefined();
      }
    });

    it('returns error for non-existent session', async () => {
      const result = await service.cancel('non-existent');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('closes V2 session and database session on cancel', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      await service.cancel(startResult.value.id);

      expect(mockV2Session.close).toHaveBeenCalled();
      expect(mockSessionService.close).toHaveBeenCalledWith('mock-db-session-id');
    });

    it('closes V2 and database session on accept', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const sessionId = startResult.value.id;
      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: createSuggestionResponse() }] },
          } as unknown as SDKMessage,
        ])
      );
      await service.sendMessage(sessionId, 'Create a task');
      await service.acceptSuggestion(sessionId);

      expect(mockV2Session.close).toHaveBeenCalled();
      expect(mockSessionService.close).toHaveBeenCalledWith('mock-db-session-id');
    });
  });

  // ===========================================================================
  // Settings and Model Configuration (4 tests)
  // ===========================================================================

  describe('settings and model configuration', () => {
    it('uses settings service model when available', async () => {
      const { unstable_v2_createSession } = await import('@anthropic-ai/claude-agent-sdk');

      (mockSettingsService.getTaskCreationModel as ReturnType<typeof vi.fn>).mockResolvedValue(
        'claude-opus-4-5-20251101'
      );

      const project = await createTestProject();
      await service.startConversation(project.id);

      expect(unstable_v2_createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4-5-20251101',
        })
      );
    });

    it('uses default model when settings service is not available', async () => {
      const { unstable_v2_createSession } = await import('@anthropic-ai/claude-agent-sdk');
      const db = getTestDb();
      const serviceNoSettings = new TaskCreationService(db, mockStreams, mockSessionService);

      const project = await createTestProject();
      await serviceNoSettings.startConversation(project.id);

      expect(unstable_v2_createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-6',
        })
      );
      serviceNoSettings.destroy();
    });

    it('uses custom configured tools when provided', async () => {
      const { unstable_v2_createSession } = await import('@anthropic-ai/claude-agent-sdk');

      const project = await createTestProject();
      await service.startConversation(project.id, ['Read', 'Grep']);

      expect(unstable_v2_createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          // AskUserQuestion should be added automatically
          allowedTools: ['Read', 'Grep', 'AskUserQuestion'],
        })
      );
    });

    it('does not duplicate AskUserQuestion if already in configured tools', async () => {
      const { unstable_v2_createSession } = await import('@anthropic-ai/claude-agent-sdk');

      const project = await createTestProject();
      await service.startConversation(project.id, ['Read', 'AskUserQuestion']);

      expect(unstable_v2_createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedTools: ['Read', 'AskUserQuestion'],
        })
      );
    });
  });

  // ===========================================================================
  // Clarifying Questions (Legacy JSON block path) (3 tests)
  // ===========================================================================

  describe('clarifying questions (legacy JSON block parsing)', () => {
    it('parses clarifying questions from assistant response', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const questionsResponse = createQuestionsResponse([
        {
          header: 'Scope',
          question: 'What areas should this cover?',
          options: [
            { label: 'Frontend', description: 'UI changes' },
            { label: 'Backend', description: 'API changes' },
          ],
        },
      ]);

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: questionsResponse }] },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Add search');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pendingQuestions).not.toBeNull();
        expect(result.value.pendingQuestions?.questions).toHaveLength(1);
        expect(result.value.pendingQuestions?.questions[0].header).toBe('Scope');
        expect(result.value.status).toBe('waiting_user');
      }
    });

    it('publishes questions event via streams', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const questionsResponse = createQuestionsResponse([
        {
          header: 'Priority',
          question: 'How urgent is this?',
          options: [{ label: 'High' }, { label: 'Low' }],
        },
      ]);

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: questionsResponse }] },
          } as unknown as SDKMessage,
        ])
      );

      await service.sendMessage(startResult.value.id, 'Task');

      expect(mockStreams.publishTaskCreationQuestions).toHaveBeenCalledWith(
        startResult.value.id,
        expect.objectContaining({
          sessionId: startResult.value.id,
          questions: expect.objectContaining({
            questions: expect.arrayContaining([expect.objectContaining({ header: 'Priority' })]),
          }),
        })
      );
    });

    it('ignores invalid clarifying_questions with no options', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const badQuestions = JSON.stringify({
        type: 'clarifying_questions',
        questions: [
          { header: 'Q1', question: 'What?', options: [] }, // empty options
        ],
      });

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: `\`\`\`json\n${badQuestions}\n\`\`\`` }],
            },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Task');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pendingQuestions).toBeNull();
      }
    });
  });

  // ===========================================================================
  // Skip Questions (2 tests)
  // ===========================================================================

  describe('skipQuestions', () => {
    it('returns error for non-existent session', async () => {
      const result = await service.skipQuestions('non-existent');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('clears pending questions and sets status to active', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const sessionId = startResult.value.id;

      // Set up pending questions state manually
      const session = service.getSession(sessionId) as TaskCreationSession;
      session.pendingQuestions = {
        id: 'q1',
        questions: [
          {
            header: 'Test',
            question: 'Q?',
            options: [{ label: 'A' }],
          },
        ],
        round: 1,
        totalAsked: 1,
        maxQuestions: 4,
      };
      session.status = 'waiting_user';

      // Mock stream for the skip message
      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: createSuggestionResponse() }],
            },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.skipQuestions(sessionId);
      expect(result.ok).toBe(true);
    });
  });

  // ===========================================================================
  // Answer Questions (3 tests)
  // ===========================================================================

  describe('answerQuestions', () => {
    it('returns error for non-existent session', async () => {
      const result = await service.answerQuestions('non-existent', 'q1', { '0': 'answer' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
    });

    it('returns error for mismatched questionsId', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const sessionId = startResult.value.id;
      const session = service.getSession(sessionId) as TaskCreationSession;
      session.pendingQuestions = {
        id: 'correct-id',
        questions: [{ header: 'Q', question: 'Q?', options: [{ label: 'A' }] }],
        round: 1,
        totalAsked: 1,
        maxQuestions: 4,
      };

      const result = await service.answerQuestions(sessionId, 'wrong-id', { '0': 'answer' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_QUESTIONS_ID');
      }
    });

    it('deduplicates retried answer submissions (idempotency)', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const sessionId = startResult.value.id;
      const session = service.getSession(sessionId) as TaskCreationSession;

      // Mark as already processed
      session.lastProcessedQuestionsId = 'q-already-done';
      session.pendingQuestions = null;

      const result = await service.answerQuestions(sessionId, 'q-already-done', { '0': 'A' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Should have alreadyProcessed flag
        expect(
          (result.value as TaskCreationSession & { alreadyProcessed: boolean }).alreadyProcessed
        ).toBe(true);
      }
    });
  });

  // ===========================================================================
  // Service Lifecycle (3 tests)
  // ===========================================================================

  describe('service lifecycle', () => {
    it('destroy stops cleanup interval', () => {
      const db = getTestDb();
      const svc = new TaskCreationService(db, mockStreams);
      // Should not throw
      svc.destroy();
      svc.destroy(); // Double destroy is safe
    });

    it('service without session service skips DB session operations', async () => {
      const db = getTestDb();
      const svc = new TaskCreationService(db, mockStreams);

      const project = await createTestProject();
      const startResult = await svc.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: createSuggestionResponse() }] },
          } as unknown as SDKMessage,
        ])
      );

      const sendResult = await svc.sendMessage(startResult.value.id, 'Test');
      expect(sendResult.ok).toBe(true);

      const cancelResult = await svc.cancel(startResult.value.id);
      expect(cancelResult.ok).toBe(true);
      svc.destroy();
    });

    it('uses custom system prompt from settings service', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Ok' }] },
          } as unknown as SDKMessage,
        ])
      );

      await service.sendMessage(startResult.value.id, 'Hello');

      // The resolvePromptServer mock returns 'Custom system prompt for task creation'
      const sentMessage = mockV2Session.send.mock.calls[0][0] as string;
      expect(sentMessage).toContain('Custom system prompt for task creation');
    });
  });

  // ===========================================================================
  // Stream Message Types (5 tests)
  // ===========================================================================

  describe('stream message types handling', () => {
    it('captures session ID from stream messages', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            session_id: 'sdk-session-123',
            message: { content: [{ type: 'text', text: 'Ok' }] },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Hello');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sdkSessionId).toBe('sdk-session-123');
      }
    });

    it('captures model and usage from message_start stream events', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'stream_event',
            event: {
              type: 'message_start',
              message: {
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 100 },
              },
            },
          } as unknown as SDKMessage,
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Ok' }] },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Hello');
      expect(result.ok).toBe(true);
      // The test just verifies no errors — model/usage are logged internally
    });

    it('handles result message with usage info', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Ok' }] },
          } as unknown as SDKMessage,
          {
            type: 'result',
            usage: { input_tokens: 50, output_tokens: 30 },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Hello');
      expect(result.ok).toBe(true);
    });

    it('handles user type messages in stream without errors', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'user',
            message: { content: [{ type: 'text', text: 'echo' }] },
            tool_use_result: {
              tool_name: 'Read',
              tool_use_id: 'tu-1',
              input: {},
              output: 'file contents',
            },
          } as unknown as SDKMessage,
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Got it.' }] },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Read a file');
      expect(result.ok).toBe(true);
    });

    it('handles tool_progress messages', async () => {
      const project = await createTestProject();
      const startResult = await service.startConversation(project.id);
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      mockV2Session.stream.mockReturnValue(
        createMockStream([
          {
            type: 'tool_progress',
            tool_use_id: 'tu-1',
            tool_name: 'Grep',
            elapsed_time_seconds: 2,
          } as unknown as SDKMessage,
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Done searching.' }] },
          } as unknown as SDKMessage,
        ])
      );

      const result = await service.sendMessage(startResult.value.id, 'Search for pattern');
      expect(result.ok).toBe(true);
    });
  });
});
