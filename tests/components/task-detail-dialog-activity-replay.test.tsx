import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskActivity } from '@/app/components/features/task-detail-dialog/task-activity';
import type { Task } from '@/db/schema';
import type { SessionCallbacks } from '@/lib/streams/client';

const getEventsMock = vi.fn();
let latestCallbacks: SessionCallbacks | null = null;

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    sessions: {
      getEvents: (...args: unknown[]) => getEventsMock(...args),
    },
  },
}));

vi.mock('@/lib/streams/client', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/streams/client')>('@/lib/streams/client');

  return {
    ...actual,
    subscribeToSession: vi.fn((_sessionId: string, callbacks: SessionCallbacks) => {
      latestCallbacks = callbacks;
      return {
        unsubscribe: vi.fn(),
        getState: () => 'connected' as const,
        getLastCursor: () => 'cursor-0',
        getLastOffset: () => 0,
      };
    }),
  };
});

const createTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: overrides.id ?? 'task-1',
    codespaceId: overrides.codespaceId ?? 'project-1',
    title: overrides.title ?? 'Replay test task',
    description: overrides.description ?? null,
    column: overrides.column ?? 'in_progress',
    position: overrides.position ?? 0,
    labels: overrides.labels ?? [],
    priority: overrides.priority ?? 'medium',
    branch: null,
    diffSummary: null,
    approvedAt: null,
    approvedBy: null,
    rejectionCount: 0,
    rejectionReason: null,
    modelOverride: null,
    skillId: null,
    skillName: null,
    planOptions: null,
    plan: null,
    agentId: null,
    sessionId: overrides.sessionId ?? 'session-1',
    worktreeId: null,
    createdAt: overrides.createdAt ?? new Date('2026-03-23T09:00:00.000Z').toISOString(),
    updatedAt: overrides.updatedAt ?? new Date('2026-03-23T09:00:00.000Z').toISOString(),
    startedAt: overrides.startedAt ?? new Date('2026-03-23T09:01:00.000Z').toISOString(),
    completedAt: null,
    lastAgentStatus: null,
  }) satisfies Task;

describe('Task detail activity replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    latestCallbacks = null;
    getEventsMock.mockResolvedValue({ ok: true, data: [] });
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-03-23T09:10:00.000Z').getTime());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deduplicates replayed tool events and preserves stream timestamps from metadata', async () => {
    render(<TaskActivity task={createTask()} activeTab="timeline" onTabChange={vi.fn()} />);

    await waitFor(() => {
      expect(latestCallbacks).not.toBeNull();
    });

    await act(() => {
      latestCallbacks?.onToolCall?.({
        channel: 'toolCalls',
        data: {
          tool: 'Bash',
          status: 'running',
          timestamp: 10,
          input: { command: 'pwd' },
        },
        cursor: 'cursor-tool-1',
        meta: {
          eventId: 'evt-tool-1',
          streamId: 'session-1',
          blockId: 'tool-block-1',
          partType: 'tool_start',
          durability: 'durable',
          sequence: null,
          schemaVersion: 1,
          createdAt: '2026-03-23T09:02:00.000Z',
        },
      } as never);
      latestCallbacks?.onToolCall?.({
        channel: 'toolCalls',
        data: {
          tool: 'Bash',
          status: 'running',
          timestamp: 10,
          input: { command: 'pwd' },
        },
        cursor: 'cursor-tool-1',
        meta: {
          eventId: 'evt-tool-1',
          streamId: 'session-1',
          blockId: 'tool-block-1',
          partType: 'tool_start',
          durability: 'durable',
          sequence: null,
          schemaVersion: 1,
          createdAt: '2026-03-23T09:02:00.000Z',
        },
      } as never);
    });

    await waitFor(() => {
      expect(screen.getAllByText('Running Bash')).toHaveLength(1);
    });

    expect(screen.getByText('8m ago')).toBeInTheDocument();
  });

  it('does not collapse distinct repeated agent-state events with the same status', async () => {
    render(<TaskActivity task={createTask()} activeTab="timeline" onTabChange={vi.fn()} />);

    await waitFor(() => {
      expect(latestCallbacks).not.toBeNull();
    });

    await act(() => {
      latestCallbacks?.onAgentState?.({
        channel: 'agentState',
        data: { status: 'running', turn: 1, progress: 10 },
        cursor: 'cursor-state-1',
        meta: {
          eventId: 'evt-state-1',
          streamId: 'session-1',
          blockId: 'agent-1',
          partType: 'lifecycle',
          durability: 'durable',
          sequence: 1,
          schemaVersion: 1,
          createdAt: '2026-03-23T09:03:00.000Z',
        },
      } as never);
      latestCallbacks?.onAgentState?.({
        channel: 'agentState',
        data: { status: 'running', turn: 2, progress: 20 },
        cursor: 'cursor-state-2',
        meta: {
          eventId: 'evt-state-2',
          streamId: 'session-1',
          blockId: 'agent-1',
          partType: 'lifecycle',
          durability: 'durable',
          sequence: 2,
          schemaVersion: 1,
          createdAt: '2026-03-23T09:04:00.000Z',
        },
      } as never);
    });

    await waitFor(() => {
      expect(screen.getAllByText('Agent started execution')).toHaveLength(2);
    });
  });
});
