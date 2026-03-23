import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContainerAgent } from '@/app/hooks/use-container-agent';
import type { SessionCallbacks } from '@/lib/streams/client';

let latestCallbacks: SessionCallbacks | null = null;
let onSubscribe: ((callbacks: SessionCallbacks) => void) | null = null;

vi.mock('@/lib/streams/client', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/streams/client')>('@/lib/streams/client');

  return {
    ...actual,
    subscribeToSession: vi.fn((_sessionId: string, callbacks: SessionCallbacks) => {
      latestCallbacks = callbacks;
      onSubscribe?.(callbacks);
      return {
        unsubscribe: vi.fn(),
        getState: () => 'connected' as const,
        getLastCursor: () => 'cursor-0',
      };
    }),
  };
});

describe('useContainerAgent', () => {
  beforeEach(() => {
    latestCallbacks = null;
    onSubscribe = null;
  });

  it('processes catch-up events emitted during initial subscription setup', async () => {
    onSubscribe = (callbacks) => {
      callbacks.onContainerAgentMessage?.({
        channel: 'containerAgent:message',
        data: {
          taskId: 'task-1',
          sessionId: 'session-1',
          role: 'assistant',
          content: 'catch-up event',
          timestamp: 50,
        },
        cursor: 'cursor-initial',
        meta: { eventId: 'evt-initial-message' },
      } as never);
    };

    const { result } = renderHook(() => useContainerAgent('session-1'));

    await waitFor(() => {
      expect(result.current.state.messages[0]?.content).toBe('catch-up event');
    });
  });

  it('deduplicates repeated container-agent message events by stable metadata identity', async () => {
    const { result } = renderHook(() => useContainerAgent('session-1'));

    await waitFor(() => {
      expect(latestCallbacks).not.toBeNull();
    });

    const messageEvent = {
      channel: 'containerAgent:message',
      data: {
        taskId: 'task-1',
        sessionId: 'session-1',
        role: 'assistant' as const,
        content: 'hello world',
        timestamp: 100,
      },
      cursor: 'cursor-1',
      meta: { eventId: 'evt-message-1' },
    } as const;

    act(() => {
      latestCallbacks?.onContainerAgentMessage?.(messageEvent as never);
      latestCallbacks?.onContainerAgentMessage?.(messageEvent as never);
    });

    expect(result.current.state.messages).toHaveLength(1);
    expect(result.current.state.messages[0]?.content).toBe('hello world');
  });

  it('deduplicates repeated status events by stable metadata identity', async () => {
    const { result } = renderHook(() => useContainerAgent('session-1'));

    await waitFor(() => {
      expect(latestCallbacks).not.toBeNull();
    });

    const statusEvent = {
      channel: 'containerAgent:status',
      data: {
        taskId: 'task-1',
        sessionId: 'session-1',
        stage: 'validating' as const,
        message: 'Validating configuration...',
        timestamp: 200,
      },
      cursor: 'cursor-2',
      meta: { eventId: 'evt-status-1' },
    } as const;

    act(() => {
      latestCallbacks?.onContainerAgentStatus?.(statusEvent as never);
      latestCallbacks?.onContainerAgentStatus?.(statusEvent as never);
    });

    expect(result.current.state.statusHistory).toHaveLength(1);
    expect(result.current.state.statusHistory[0]).toMatchObject({
      stage: 'validating',
      message: 'Validating configuration...',
    });
  });
});
