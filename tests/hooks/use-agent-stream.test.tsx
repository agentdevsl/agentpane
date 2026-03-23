import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentStream } from '@/app/hooks/use-agent-stream';
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

describe('useAgentStream', () => {
  beforeEach(() => {
    latestCallbacks = null;
  });

  it('registers stream callbacks on the initial render', () => {
    renderHook(() => useAgentStream('session-1'));

    expect(latestCallbacks?.onChunk).toBeTypeOf('function');
    expect(latestCallbacks?.onToolCall).toBeTypeOf('function');
    expect(latestCallbacks?.onAgentState).toBeTypeOf('function');
  });

  it('deduplicates replayed chunks by stable event identity', async () => {
    const { result } = renderHook(() => useAgentStream('session-1'));

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
        meta: { eventId: 'evt-chunk-1' },
      } as never);
      latestCallbacks?.onChunk?.({
        channel: 'chunks',
        data: {
          text: 'hello',
          timestamp: 10,
          agentId: 'agent-1',
        },
        cursor: 'cursor-chunk-1',
        meta: { eventId: 'evt-chunk-1' },
      } as never);
    });

    await waitFor(() => {
      expect(result.current.chunks).toHaveLength(1);
    });

    expect(result.current.fullText).toBe('hello');
    expect(result.current.isStreaming).toBe(true);
  });

  it('merges tool start and result by stable tool id', async () => {
    const { result } = renderHook(() => useAgentStream('session-1'));

    await waitFor(() => {
      expect(latestCallbacks).not.toBeNull();
    });

    act(() => {
      latestCallbacks?.onToolCall?.({
        channel: 'toolCalls',
        data: {
          id: 'tool-1',
          tool: 'Bash',
          input: { command: 'pwd' },
          status: 'running',
          timestamp: 11,
        },
        cursor: 'cursor-tool-1',
        meta: { eventId: 'evt-tool-1' },
      } as never);
      latestCallbacks?.onToolCall?.({
        channel: 'toolCalls',
        data: {
          id: 'tool-1',
          tool: 'Bash',
          input: { command: 'pwd' },
          output: 'ok',
          status: 'complete',
          timestamp: 12,
        },
        cursor: 'cursor-tool-2',
        meta: { eventId: 'evt-tool-2' },
      } as never);
    });

    await waitFor(() => {
      expect(result.current.tools).toHaveLength(1);
    });

    expect(result.current.tools[0]).toMatchObject({
      id: 'tool-1',
      tool: 'Bash',
      status: 'complete',
      output: 'ok',
    });
  });
});
