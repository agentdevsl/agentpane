import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContainerAgentStatuses } from '@/app/hooks/use-container-agent-statuses';
import type { SessionCallbacks } from '@/lib/streams/client';

let latestCallbacksBySession = new Map<string, SessionCallbacks>();

vi.mock('@/lib/streams/client', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/streams/client')>('@/lib/streams/client');

  return {
    ...actual,
    subscribeToSession: vi.fn((sessionId: string, callbacks: SessionCallbacks) => {
      latestCallbacksBySession.set(sessionId, callbacks);
      return {
        unsubscribe: vi.fn(() => {
          latestCallbacksBySession.delete(sessionId);
        }),
        getState: () => 'connected' as const,
        getLastCursor: () => null,
        getLastOffset: () => 0,
      };
    }),
  };
});

describe('useContainerAgentStatuses', () => {
  beforeEach(() => {
    latestCallbacksBySession = new Map();
  });

  it('deduplicates repeated status and completion events by stable identity', async () => {
    const { result } = renderHook(() =>
      useContainerAgentStatuses([{ sessionId: 'session-1', taskId: 'task-1' }])
    );

    await waitFor(() => {
      expect(latestCallbacksBySession.has('session-1')).toBe(true);
    });

    const callbacks = latestCallbacksBySession.get('session-1');
    expect(callbacks).toBeDefined();

    act(() => {
      callbacks?.onContainerAgentStatus?.({
        channel: 'containerAgent:status',
        data: {
          taskId: 'task-1',
          sessionId: 'session-1',
          stage: 'validating',
          message: 'Validating...',
          timestamp: 10,
        },
        cursor: 'cursor-status-1',
        meta: { eventId: 'evt-status-1' },
      } as never);
      callbacks?.onContainerAgentStatus?.({
        channel: 'containerAgent:status',
        data: {
          taskId: 'task-1',
          sessionId: 'session-1',
          stage: 'validating',
          message: 'Validating...',
          timestamp: 10,
        },
        cursor: 'cursor-status-1',
        meta: { eventId: 'evt-status-1' },
      } as never);
      callbacks?.onContainerAgentComplete?.({
        channel: 'containerAgent:complete',
        data: {
          taskId: 'task-1',
          sessionId: 'session-1',
          status: 'completed',
          turnCount: 3,
          timestamp: 20,
        },
        cursor: 'cursor-complete-1',
        meta: { eventId: 'evt-complete-1' },
      } as never);
      callbacks?.onContainerAgentComplete?.({
        channel: 'containerAgent:complete',
        data: {
          taskId: 'task-1',
          sessionId: 'session-1',
          status: 'completed',
          turnCount: 3,
          timestamp: 20,
        },
        cursor: 'cursor-complete-1',
        meta: { eventId: 'evt-complete-1' },
      } as never);
    });

    const status = result.current.get('session-1');
    expect(status).toMatchObject({
      currentStage: 'validating',
      statusMessage: 'Validating...',
      isComplete: true,
      hasError: false,
    });
  });
});
