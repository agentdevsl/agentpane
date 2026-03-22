import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '@/app/hooks/use-session';
import type { SessionCallbacks } from '@/lib/streams/client';

let latestCallbacks: SessionCallbacks | null = null;

vi.mock('@/app/hooks/use-session-subscription', () => ({
  useSessionSubscription: (_sessionId: string | null, callbacks: SessionCallbacks) => {
    latestCallbacks = callbacks;
    return {
      connectionState: 'connected' as const,
      getLastCursor: () => 'cursor-1',
    };
  },
}));

describe('useSession', () => {
  beforeEach(() => {
    latestCallbacks = null;
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ ok: true }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deduplicates replayed chunks by stable event identity', async () => {
    const { result } = renderHook(() => useSession('session-1', 'user-1'));

    await waitFor(() => {
      expect(latestCallbacks).not.toBeNull();
    });

    act(() => {
      latestCallbacks?.onChunk?.({
        channel: 'chunks',
        data: {
          text: 'hello',
          timestamp: 10,
          agentId: 'agent-1',
        },
        cursor: 'cursor-chunk-1',
        meta: { eventId: 'evt-chunk-1', streamId: 'session-1' },
      } as never);
      latestCallbacks?.onChunk?.({
        channel: 'chunks',
        data: {
          text: 'hello',
          timestamp: 10,
          agentId: 'agent-1',
        },
        cursor: 'cursor-chunk-1',
        meta: { eventId: 'evt-chunk-1', streamId: 'session-1' },
      } as never);
    });

    await waitFor(() => {
      expect(result.current.state.chunks).toHaveLength(1);
    });
    expect(result.current.state.chunks[0]?.text).toBe('hello');
    expect(result.current.lastCursor).toBe('cursor-1');
  });

  it('uses blockId as the stable tool identity when stream payload ids are missing', async () => {
    const { result } = renderHook(() => useSession('session-2', 'user-1'));

    await waitFor(() => {
      expect(latestCallbacks).not.toBeNull();
    });

    act(() => {
      latestCallbacks?.onToolCall?.({
        channel: 'toolCalls',
        data: {
          tool: 'Bash',
          input: { command: 'pwd' },
          status: 'running',
          timestamp: 20,
        },
        cursor: 'cursor-tool-1',
        meta: { eventId: 'evt-tool-start', streamId: 'session-2', blockId: 'tool-block-1' },
      } as never);
      latestCallbacks?.onToolCall?.({
        channel: 'toolCalls',
        data: {
          tool: 'Bash',
          input: { command: 'pwd' },
          output: 'ok',
          status: 'complete',
          timestamp: 21,
        },
        cursor: 'cursor-tool-2',
        meta: { eventId: 'evt-tool-result', streamId: 'session-2', blockId: 'tool-block-1' },
      } as never);
    });

    await waitFor(() => {
      expect(result.current.state.toolCalls).toHaveLength(1);
    });

    expect(result.current.state.toolCalls[0]).toMatchObject({
      id: 'tool-block-1',
      tool: 'Bash',
      status: 'complete',
      output: 'ok',
    });
  });
});
