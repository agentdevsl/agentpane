import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TASK_CREATION_TOOLS } from '@/lib/constants/tools';
import { invalidateSettingsCache, SETTING_KEYS } from '@/lib/hooks/use-settings';
import { useTaskCreation } from '@/lib/task-creation/hooks';
import { resetTaskCreationSession } from '@/lib/task-creation/sync';

// Controllable mock for useCollectionQuery. Tests update sessionStore/messageStore
// to simulate TanStack DB collection state changes after SSE events.
import type { TaskCreationSession, TaskCreationMessage } from '@/lib/task-creation/schema';

let sessionStore: TaskCreationSession[] = [];
let messageStore: TaskCreationMessage[] = [];

vi.mock('@/lib/db/use-collection-query', () => ({
  useCollectionQuery: vi.fn((queryFn: (q: unknown) => unknown) => {
    // Execute the query function with a spy builder to detect which collection is queried
    let queriedKey = '';
    const builder = {
      from: (obj: Record<string, unknown>) => {
        queriedKey = Object.keys(obj)[0] ?? '';
        return { where: () => ({}) };
      },
    };
    queryFn(builder);
    if (queriedKey === 'sessions') {
      return { data: sessionStore };
    }
    return { data: messageStore };
  }),
}));

// Mock the collections module with no-op fakes
vi.mock('@/lib/task-creation/collections', () => ({
  taskCreationSessionsCollection: {
    has: () => false,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    get toArray() {
      return [];
    },
    size: 0,
    isReady: () => true,
  },
  taskCreationMessagesCollection: {
    has: () => false,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    get toArray() {
      return [];
    },
    size: 0,
    isReady: () => true,
  },
  taskCreationCollections: {},
  clearTaskCreationSession: vi.fn(),
  clearAllTaskCreationData: vi.fn(),
  getTaskCreationCollectionStats: vi.fn(() => ({
    sessions: { size: 0, ready: true },
    messages: { size: 0, ready: true },
  })),
}));

// Mock the API client
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    taskCreation: {
      start: vi.fn(),
      sendMessage: vi.fn(),
      accept: vi.fn(),
      answerQuestions: vi.fn(),
      skipQuestions: vi.fn(),
      cancel: vi.fn(),
      getStreamUrl: vi.fn(
        (sessionId: string) => `/api/tasks/create-with-ai/stream?sessionId=${sessionId}`
      ),
    },
    settings: {
      get: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { apiClient } from '@/lib/api/client';

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1; // OPEN

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    // Simulate async open
    setTimeout(() => {
      if (this.onopen) {
        this.onopen(new Event('open'));
      }
    }, 0);
  }

  close() {
    this.readyState = 2; // CLOSED
  }

  // Helper to simulate server messages
  simulateMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }));
    }
  }

  simulateError() {
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }
}

// Replace global EventSource
const originalEventSource = global.EventSource;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const createDeferred = <T,>(): Deferred<T> => {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
};

// Helper to create a session object for the mock store
function makeSession(overrides: Partial<TaskCreationSession> = {}): TaskCreationSession {
  return {
    id: 'session-1',
    codespaceId: 'project-1',
    status: 'connecting',
    suggestion: null,
    pendingQuestions: null,
    createdTaskId: null,
    error: null,
    isStreaming: false,
    streamingContent: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// Helper to create a message for the mock store
function makeMessage(overrides: Partial<TaskCreationMessage> = {}): TaskCreationMessage {
  return {
    id: `msg-${Date.now()}`,
    sessionId: 'session-1',
    role: 'user',
    content: '',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('useTaskCreation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStore = [];
    messageStore = [];
    invalidateSettingsCache();
    resetTaskCreationSession('session-1');
    MockEventSource.instances = [];
    // @ts-expect-error - Mocking EventSource
    global.EventSource = MockEventSource;
    const storage = new Map<string, string>();
    // @ts-expect-error - Mocking localStorage for TanStack DB
    global.localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    };
    vi.mocked(apiClient.settings.get).mockResolvedValue({
      ok: true,
      data: {
        settings: {
          [SETTING_KEYS.TASK_CREATION_TOOLS]: DEFAULT_TASK_CREATION_TOOLS,
        },
      },
    });
  });

  afterEach(() => {
    global.EventSource = originalEventSource;
  });

  describe('initial state', () => {
    it('has idle status initially', () => {
      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      expect(result.current.status).toBe('idle');
      expect(result.current.sessionId).toBeNull();
      expect(result.current.messages).toHaveLength(0);
      expect(result.current.streamingContent).toBe('');
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.suggestion).toBeNull();
      expect(result.current.createdTaskId).toBeNull();
      expect(result.current.error).toBeNull();
    });
  });

  describe('startConversation', () => {
    it('creates a session and connects to stream', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      // Simulate collection updated after SSE 'connected' event
      sessionStore = [makeSession({ status: 'active' })];

      await act(async () => {
        MockEventSource.instances[0]?.simulateMessage({
          type: 'connected',
          sessionId: 'session-1',
        });
      });

      rerender();

      expect(result.current.status).toBe('active');
      expect(result.current.sessionId).toBe('session-1');
      expect(apiClient.taskCreation.start).toHaveBeenCalledWith(
        'project-1',
        DEFAULT_TASK_CREATION_TOOLS
      );
    });

    it('sets error status on failure', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: false,
        error: { code: 'ERROR', message: 'Failed to start' },
      });

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.localError).toBe('Failed to start');
    });
  });

  describe('sendMessage', () => {
    it('sends message and adds to list', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });
      vi.mocked(apiClient.taskCreation.sendMessage).mockResolvedValue({
        ok: true,
        data: { messageId: 'msg-1' },
      });

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      // Simulate collection state after addUserMessage + sendMessage
      messageStore = [makeMessage({ role: 'user', content: 'Create a bug fix task' })];
      sessionStore = [makeSession({ status: 'active', isStreaming: true })];

      await act(async () => {
        await result.current.sendMessage('Create a bug fix task');
      });

      rerender();

      // User message should be added immediately
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]?.role).toBe('user');
      expect(result.current.messages[0]?.content).toBe('Create a bug fix task');
      expect(result.current.isStreaming).toBe(true);
    });

    it('sets error when no session', async () => {
      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.sendMessage('hello');
      });

      expect(result.current.localError).toBe('No active session');
    });
  });

  describe('SSE events', () => {
    it('handles token events for streaming', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      // Wait for EventSource connection
      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      const eventSource = MockEventSource.instances[0];
      expect(eventSource).toBeDefined();

      // Simulate token streaming - update store to reflect what sync.ts would do
      sessionStore = [makeSession({ status: 'active', isStreaming: true, streamingContent: 'Hello' })];

      await act(async () => {
        eventSource.simulateMessage({
          type: 'task-creation:token',
          data: { delta: 'Hello' },
        });
      });

      rerender();
      expect(result.current.streamingContent).toBe('Hello');
      expect(result.current.isStreaming).toBe(true);

      // More tokens
      sessionStore = [makeSession({ status: 'active', isStreaming: true, streamingContent: 'Hello world' })];

      await act(async () => {
        eventSource.simulateMessage({
          type: 'task-creation:token',
          data: { delta: ' world' },
        });
      });

      rerender();
      expect(result.current.streamingContent).toBe('Hello world');
    });

    it('handles message completion', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      const eventSource = MockEventSource.instances[0];
      expect(eventSource).toBeDefined();

      // Simulate assistant message completion - update stores
      sessionStore = [makeSession({ status: 'active', isStreaming: false, streamingContent: '' })];
      messageStore = [makeMessage({ id: 'msg-1', role: 'assistant', content: 'Here is my response' })];

      await act(async () => {
        eventSource.simulateMessage({
          type: 'task-creation:message',
          data: {
            messageId: 'msg-1',
            role: 'assistant',
            content: 'Here is my response',
          },
        });
      });

      rerender();
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0]?.role).toBe('assistant');
      expect(result.current.messages[0]?.content).toBe('Here is my response');
      expect(result.current.streamingContent).toBe('');
      expect(result.current.isStreaming).toBe(false);
    });

    it('handles suggestion event', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      const eventSource = MockEventSource.instances[0];
      expect(eventSource).toBeDefined();

      // Simulate suggestion - update store
      sessionStore = [makeSession({
        status: 'active',
        suggestion: {
          title: 'Fix bug',
          description: 'Fix the login bug',
          labels: ['bug'],
          priority: 'high',
        },
      })];

      await act(async () => {
        eventSource.simulateMessage({
          type: 'task-creation:suggestion',
          data: {
            suggestion: {
              title: 'Fix bug',
              description: 'Fix the login bug',
              labels: ['bug'],
              priority: 'high',
              mode: 'implement',
            },
          },
        });
      });

      rerender();
      expect(result.current.suggestion).not.toBeNull();
      expect(result.current.suggestion?.title).toBe('Fix bug');
      expect(result.current.suggestion?.priority).toBe('high');
    });

    it('handles error event', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      const eventSource = MockEventSource.instances[0];
      expect(eventSource).toBeDefined();

      // Simulate error - update store
      sessionStore = [makeSession({ status: 'error', error: 'Something went wrong', isStreaming: false })];

      await act(async () => {
        eventSource.simulateMessage({
          type: 'task-creation:error',
          data: { error: 'Something went wrong' },
        });
      });

      rerender();
      expect(result.current.status).toBe('error');
      expect(result.current.error).toBe('Something went wrong');
      expect(result.current.isStreaming).toBe(false);
    });

    it('handles completion event', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      const eventSource = MockEventSource.instances[0];
      expect(eventSource).toBeDefined();

      // Simulate completion - update store
      sessionStore = [makeSession({ status: 'completed', createdTaskId: 'task-123' })];

      await act(async () => {
        eventSource.simulateMessage({
          type: 'task-creation:completed',
          data: { taskId: 'task-123' },
        });
      });

      rerender();
      expect(result.current.status).toBe('completed');
      expect(result.current.createdTaskId).toBe('task-123');
    });
  });

  describe('acceptSuggestion', () => {
    it('accepts suggestion and creates task', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });
      vi.mocked(apiClient.taskCreation.accept).mockResolvedValue({
        ok: true,
        data: { taskId: 'task-123', sessionId: 'session-1', status: 'completed' },
      });

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      // Set suggestion in store
      sessionStore = [makeSession({
        status: 'active',
        suggestion: { title: 'Test task', description: 'Description', labels: [], priority: 'medium' },
      })];

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      await act(async () => {
        MockEventSource.instances[0]?.simulateMessage({
          type: 'task-creation:suggestion',
          data: {
            suggestion: {
              title: 'Test task',
              description: 'Description',
              labels: [],
              priority: 'medium',
              mode: 'implement',
            },
          },
        });
      });

      rerender();
      expect(result.current.suggestion).not.toBeNull();

      await act(async () => {
        await result.current.acceptSuggestion();
      });

      expect(apiClient.taskCreation.accept).toHaveBeenCalledWith('session-1', undefined);

      // Simulate completion
      sessionStore = [makeSession({ status: 'completed', createdTaskId: 'task-123' })];

      await act(async () => {
        MockEventSource.instances[0]?.simulateMessage({
          type: 'task-creation:completed',
          data: { taskId: 'task-123' },
        });
      });

      rerender();
      expect(result.current.createdTaskId).toBe('task-123');
      expect(result.current.status).toBe('completed');
    });

    it('accepts suggestion with overrides', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });
      vi.mocked(apiClient.taskCreation.accept).mockResolvedValue({
        ok: true,
        data: { taskId: 'task-123', sessionId: 'session-1', status: 'completed' },
      });

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      // Set suggestion in store
      sessionStore = [makeSession({
        status: 'active',
        suggestion: { title: 'Original', description: 'Description', labels: [], priority: 'medium' },
      })];

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      await act(async () => {
        MockEventSource.instances[0]?.simulateMessage({
          type: 'task-creation:suggestion',
          data: {
            suggestion: {
              title: 'Original',
              description: 'Description',
              labels: [],
              priority: 'medium',
              mode: 'implement',
            },
          },
        });
      });

      rerender();

      await act(async () => {
        await result.current.acceptSuggestion({ title: 'Modified title' });
      });

      expect(apiClient.taskCreation.accept).toHaveBeenCalledWith('session-1', {
        title: 'Modified title',
      });
    });

    it('sets error when no suggestion', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      await act(async () => {
        const response = await result.current.acceptSuggestion();
        expect(response.ok).toBe(false);
        expect(response.error).toBe('No suggestion available');
      });
    });
  });

  describe('answerQuestions', () => {
    it('prevents duplicate submissions while a request is in flight', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });

      const deferred = createDeferred<{
        ok: true;
        data: { sessionId: string; status: string };
      }>();

      vi.mocked(apiClient.taskCreation.answerQuestions).mockReturnValue(deferred.promise);

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      // Set pending questions in store
      sessionStore = [makeSession({
        status: 'active',
        pendingQuestions: {
          id: 'q-1',
          round: 1,
          totalAsked: 1,
          maxQuestions: 10,
          questions: [
            {
              header: 'Scope',
              question: 'What scope?',
              multiSelect: false,
              options: [{ label: 'Full' }],
            },
          ],
        },
      })];

      await act(async () => {
        MockEventSource.instances[0]?.simulateMessage({
          type: 'task-creation:questions',
          data: {
            questions: {
              id: 'q-1',
              round: 1,
              totalAsked: 1,
              maxQuestions: 10,
              questions: [
                {
                  header: 'Scope',
                  question: 'What scope?',
                  multiSelect: false,
                  options: [{ label: 'Full' }],
                },
              ],
            },
          },
        });
      });

      rerender();

      const answers = { '0': 'Full' };
      let firstPromise: Promise<void> | null = null;
      let secondPromise: Promise<void> | null = null;

      await act(async () => {
        firstPromise = result.current.answerQuestions(answers);
        secondPromise = result.current.answerQuestions(answers);
      });

      expect(apiClient.taskCreation.answerQuestions).toHaveBeenCalledTimes(1);

      deferred.resolve({ ok: true, data: { sessionId: 'session-1', status: 'active' } });

      if (!firstPromise || !secondPromise) {
        throw new Error('Answer promises were not created');
      }

      await act(async () => {
        await Promise.all([firstPromise, secondPromise]);
      });
    });
  });

  describe('cancel', () => {
    it('cancels session', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });
      vi.mocked(apiClient.taskCreation.cancel).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1', status: 'cancelled' },
      });

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      await act(async () => {
        await result.current.cancel();
      });

      // Simulate cancelled state
      sessionStore = [makeSession({ status: 'cancelled' })];

      await act(async () => {
        MockEventSource.instances[0]?.simulateMessage({
          type: 'task-creation:cancelled',
          data: { sessionId: 'session-1' },
        });
      });

      rerender();
      expect(apiClient.taskCreation.cancel).toHaveBeenCalledWith('session-1');
      expect(result.current.status).toBe('cancelled');
    });
  });

  describe('reset', () => {
    it('resets all state', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      // Simulate connected state
      sessionStore = [makeSession({ status: 'active' })];

      await act(async () => {
        MockEventSource.instances[0]?.simulateMessage({
          type: 'connected',
          sessionId: 'session-1',
        });
      });

      rerender();
      expect(result.current.sessionId).toBe('session-1');
      expect(result.current.status).toBe('active');

      // Reset clears sessionId, so queries return empty
      sessionStore = [];
      messageStore = [];

      act(() => {
        result.current.reset();
      });

      expect(result.current.sessionId).toBeNull();
      expect(result.current.status).toBe('idle');
      expect(result.current.messages).toHaveLength(0);
      expect(result.current.streamingContent).toBe('');
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.suggestion).toBeNull();
      expect(result.current.createdTaskId).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('closes EventSource on reset', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });

      const { result, rerender } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      const eventSource = MockEventSource.instances[0];
      expect(eventSource).toBeDefined();
      expect(eventSource.readyState).toBe(1); // OPEN

      act(() => {
        result.current.reset();
      });

      expect(eventSource.readyState).toBe(2); // CLOSED
    });
  });

  describe('unmount cleanup', () => {
    it('closes EventSource on unmount', async () => {
      vi.mocked(apiClient.taskCreation.start).mockResolvedValue({
        ok: true,
        data: { sessionId: 'session-1' },
      });

      const { result, unmount } = renderHook(() => useTaskCreation('project-1'));

      await act(async () => {
        await result.current.startConversation();
      });

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      const eventSource = MockEventSource.instances[0];
      expect(eventSource).toBeDefined();
      expect(eventSource.readyState).toBe(1); // OPEN

      unmount();

      expect(eventSource.readyState).toBe(2); // CLOSED
    });
  });
});
