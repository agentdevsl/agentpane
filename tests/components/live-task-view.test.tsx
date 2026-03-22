import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditTrailPanel } from '../../src/app/components/features/live-task-view/audit-trail-panel';
import { LiveTaskView } from '../../src/app/components/features/live-task-view/index';

interface SessionCallbacks {
  onContainerAgentMessage?: (event: {
    channel: 'containerAgent:message';
    data: {
      taskId: string;
      sessionId: string;
      role: 'user' | 'assistant' | 'system';
      content: string;
      timestamp: number;
    };
    offset?: number;
  }) => void;
  onContainerAgentToken?: (event: {
    channel: 'containerAgent:token';
    data: {
      taskId: string;
      sessionId: string;
      delta: string;
      timestamp: number;
    };
    offset?: number;
  }) => void;
  onContainerAgentToolStart?: (event: {
    channel: 'containerAgent:toolStart';
    data: {
      taskId: string;
      sessionId: string;
      toolName: string;
      toolId: string;
      input: Record<string, unknown>;
      timestamp: number;
    };
    offset?: number;
  }) => void;
  onChunk?: (event: { channel: 'chunks'; data: { text: string }; offset?: number }) => void;
}

const { getEventsMock, sessionCallbacksById, subscribeToSessionMock } = vi.hoisted(() => {
  const callbacks = new Map<string, SessionCallbacks>();

  return {
    getEventsMock: vi.fn(),
    sessionCallbacksById: callbacks,
    subscribeToSessionMock: vi.fn((sessionId: string, sessionCallbacks: SessionCallbacks) => {
      callbacks.set(sessionId, sessionCallbacks);

      return {
        unsubscribe: vi.fn(() => {
          callbacks.delete(sessionId);
        }),
        getState: () => 'connected' as const,
        getLastOffset: () => 0,
      };
    }),
  };
});

const localStorageMock = {
  getItem: vi.fn((_: string) => null as string | null),
  setItem: vi.fn((_: string, __: string) => undefined),
};

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    sessions: {
      getEvents: getEventsMock,
    },
  },
}));

vi.mock('@/lib/streams/client', async () => {
  return {
    subscribeToSession: subscribeToSessionMock,
  };
});

vi.mock('@/app/components/features/agent-topology', () => ({
  AgentTopology: ({
    initialData,
    sessionId,
  }: {
    initialData?: { taskName?: string };
    sessionId?: string;
  }) => <div data-testid="mock-topology">{`${sessionId}:${initialData?.taskName ?? ''}`}</div>,
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface SessionEventRecord {
  id: string;
  type: string;
  timestamp: number;
  data: unknown;
}

interface MockTask {
  id: string;
  title: string;
  column: string;
  priority?: 'low' | 'medium' | 'high';
  sessionId?: string | null;
  agentId?: string | null;
  lastAgentStatus?: string | null;
  description?: string | null;
  labels?: string[] | null;
  branch?: string | null;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function createTask(overrides: Partial<MockTask> = {}): MockTask {
  return {
    id: 'task-1',
    title: 'Task One',
    column: 'in_progress',
    priority: 'medium',
    sessionId: 'session-1',
    agentId: null,
    lastAgentStatus: null,
    description: null,
    labels: null,
    branch: null,
    ...overrides,
  };
}

function getSessionCallbacks(sessionId: string): SessionCallbacks {
  const callbacks = sessionCallbacksById.get(sessionId);
  if (!callbacks) {
    throw new Error(`Missing session callbacks for ${sessionId}`);
  }

  return callbacks;
}

function emitToolStart(sessionId: string, timestamp = 1): void {
  act(() => {
    getSessionCallbacks(sessionId).onContainerAgentToolStart?.({
      channel: 'containerAgent:toolStart',
      data: {
        taskId: 'task-1',
        sessionId,
        toolName: 'Read',
        toolId: `tool-${timestamp}`,
        input: {},
        timestamp,
      },
      offset: timestamp,
    });
  });
}

function emitAssistantMessage(sessionId: string, content: string, timestamp = 1): void {
  act(() => {
    getSessionCallbacks(sessionId).onContainerAgentMessage?.({
      channel: 'containerAgent:message',
      data: {
        taskId: 'task-1',
        sessionId,
        role: 'assistant',
        content,
        timestamp,
      },
      offset: timestamp,
    });
  });
}

describe('LiveTaskView', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: localStorageMock,
    });
    localStorageMock.getItem.mockReset();
    localStorageMock.getItem.mockReturnValue(null);
    localStorageMock.setItem.mockReset();
    getEventsMock.mockReset();
    getEventsMock.mockResolvedValue({ ok: true, data: [] });
    subscribeToSessionMock.mockClear();
    sessionCallbacksById.clear();
  });

  it('ignores stale topology fetches when task selection changes quickly', async () => {
    const user = userEvent.setup();
    const firstRequest = createDeferred<{ ok: true; data: SessionEventRecord[] }>();
    const secondRequest = createDeferred<{ ok: true; data: SessionEventRecord[] }>();

    getEventsMock.mockImplementation((sessionId: string, params?: { limit?: number }) => {
      if (params?.limit === 500 && sessionId === 'session-a') {
        return firstRequest.promise;
      }

      if (params?.limit === 500 && sessionId === 'session-b') {
        return secondRequest.promise;
      }

      return Promise.resolve({ ok: true, data: [] });
    });

    render(
      <LiveTaskView
        tasks={[
          createTask({ id: 'task-a', title: 'Alpha task', sessionId: 'session-a' }),
          createTask({ id: 'task-b', title: 'Beta task', sessionId: 'session-b' }),
        ]}
        codespaceId="codespace-1"
      />
    );

    await user.click(screen.getByText('Alpha task'));
    await waitFor(() => {
      expect(getEventsMock).toHaveBeenCalledWith('session-a', { limit: 500 });
    });

    await user.click(screen.getByText('Beta task'));
    await waitFor(() => {
      expect(getEventsMock).toHaveBeenCalledWith('session-b', { limit: 500 });
    });

    await act(async () => {
      firstRequest.resolve({ ok: true, data: [] });
      await firstRequest.promise;
    });

    await waitFor(() => {
      expect(screen.queryByTestId('mock-topology')).not.toBeInTheDocument();
    });

    await act(async () => {
      secondRequest.resolve({ ok: true, data: [] });
      await secondRequest.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId('mock-topology')).toHaveTextContent('session-b:Beta task');
    });
  });

  it('clears the selected task when sidebar filters hide it', async () => {
    const user = userEvent.setup();

    getEventsMock.mockResolvedValue({ ok: true, data: [] });

    render(
      <LiveTaskView
        tasks={[
          createTask({ id: 'task-a', title: 'Alpha task', sessionId: 'session-a' }),
          createTask({ id: 'task-b', title: 'Beta task', sessionId: 'session-b' }),
        ]}
        codespaceId="codespace-1"
      />
    );

    await user.click(screen.getByText('Alpha task'));
    await waitFor(() => {
      expect(screen.getByTestId('mock-topology')).toHaveTextContent('session-a:Alpha task');
    });

    const searchInput = screen.getByPlaceholderText('Search tasks…');
    await user.clear(searchInput);
    await user.type(searchInput, 'Beta');

    await waitFor(() => {
      expect(screen.getByText('Beta task')).toBeInTheDocument();
      expect(screen.queryByTestId('mock-topology')).not.toBeInTheDocument();
      expect(screen.getByText('Select a task to view its audit trail')).toBeInTheDocument();
    });
  });

  it('treats done tasks as completed in the status pipeline', async () => {
    const user = userEvent.setup();
    localStorageMock.getItem.mockImplementation((key: string) =>
      key === 'live-task-view:show-completed' ? 'true' : null
    );

    render(
      <LiveTaskView
        tasks={[
          createTask({ id: 'task-done', title: 'Done task', column: 'done', sessionId: null }),
        ]}
        codespaceId="codespace-1"
        onTaskMove={vi.fn()}
      />
    );

    await user.click(screen.getByText('Done task'));

    await waitFor(() => {
      expect(screen.getAllByTitle('Move to Backlog')).toHaveLength(1);
    });
  });
});

describe('AuditTrailPanel', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: localStorageMock,
    });
    localStorageMock.getItem.mockReset();
    localStorageMock.getItem.mockReturnValue(null);
    localStorageMock.setItem.mockReset();
    getEventsMock.mockReset();
    getEventsMock.mockResolvedValue({ ok: true, data: [] });
    subscribeToSessionMock.mockClear();
    sessionCallbacksById.clear();
  });

  it('shows a Done badge for verified tasks', () => {
    render(
      <AuditTrailPanel
        task={createTask({ column: 'verified', title: 'Verified task', sessionId: null })}
      />
    );

    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.queryByText(/^verified$/)).not.toBeInTheDocument();
  });

  it('appends live events in the Events tab after the initial fetch', async () => {
    const eventsRequest = createDeferred<{ ok: true; data: SessionEventRecord[] }>();
    getEventsMock.mockReturnValue(eventsRequest.promise);

    render(<AuditTrailPanel task={createTask({ sessionId: 'session-events' })} />);

    expect(screen.getByText('Loading events...')).toBeInTheDocument();

    await act(async () => {
      eventsRequest.resolve({ ok: true, data: [] });
      await eventsRequest.promise;
    });

    await waitFor(() => {
      expect(screen.getByText('No events yet')).toBeInTheDocument();
      expect(subscribeToSessionMock).toHaveBeenCalledWith('session-events', expect.any(Object));
    });

    emitToolStart('session-events', 10);

    expect(await screen.findByText('Tool: Read')).toBeInTheDocument();
  });

  it('preserves the visible transcript after the task leaves in progress', async () => {
    const user = userEvent.setup();
    getEventsMock.mockResolvedValue({ ok: true, data: [] });

    const { rerender } = render(
      <AuditTrailPanel task={createTask({ sessionId: 'session-stream', column: 'in_progress' })} />
    );

    await user.click(screen.getByRole('button', { name: 'Stream' }));

    await waitFor(() => {
      expect(subscribeToSessionMock).toHaveBeenCalledWith('session-stream', expect.any(Object));
    });

    emitAssistantMessage('session-stream', 'hello from the stream', 20);

    expect(await screen.findByText('hello from the stream')).toBeInTheDocument();

    rerender(
      <AuditTrailPanel task={createTask({ sessionId: 'session-stream', column: 'verified' })} />
    );

    expect(screen.getByText('hello from the stream')).toBeInTheDocument();
    expect(screen.queryByText('Session ended')).not.toBeInTheDocument();
  });
});
