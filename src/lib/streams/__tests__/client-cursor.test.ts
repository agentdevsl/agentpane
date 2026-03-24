import type { StreamResponse, TextChunk } from '@durable-streams/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDurableStreamsClient, type SessionCallbacks, setStreamsAvailable } from '../client.js';

type StreamChunkHandler = (chunk: { text: string; offset?: string }) => void;

vi.mock('@durable-streams/client', () => ({
  stream: vi.fn(),
}));

const durableStreamMock = vi.mocked((await import('@durable-streams/client')).stream!);

describe('DurableStreamsClient cursor handling', () => {
  beforeEach(() => {
    durableStreamMock.mockReset();
    setStreamsAvailable(true);
  });

  function createMockResponse(subscribeText: StreamResponse['subscribeText']): StreamResponse {
    return {
      subscribeText,
      closed: new Promise<void>(() => {}),
      cancel: () => {},
      streamClosed: false,
    } as StreamResponse;
  }

  it('preserves opaque cursor values for resume while exposing numeric approximation separately', async () => {
    let subscribeTextHandler: StreamChunkHandler = () => {
      throw new Error('subscribeText handler was not captured');
    };
    let capturedHandler = false;

    durableStreamMock.mockResolvedValue(
      createMockResponse((handler: (chunk: TextChunk) => void | Promise<void>) => {
        subscribeTextHandler = (chunk) => {
          void handler({
            text: chunk.text,
            offset: chunk.offset ?? '-1',
            upToDate: true,
            cursor: chunk.offset,
            streamClosed: false,
          });
        };
        capturedHandler = true;
        return () => {};
      })
    );

    const callbacks: SessionCallbacks = {
      onChunk: vi.fn(),
    };

    const subscription = getDurableStreamsClient().subscribeToSession('session-1', callbacks);

    await vi.waitFor(() => {
      expect(durableStreamMock).toHaveBeenCalled();
    });

    expect(capturedHandler).toBe(true);

    subscribeTextHandler({
      offset: '3_128',
      text: JSON.stringify({
        type: 'chunk',
        data: { text: 'hello', agentId: 'agent-1' },
        timestamp: 123,
      }),
    });

    expect(subscription.getLastCursor()).toBe('3_128');
    expect(subscription.getLastOffset()).toBe(3);

    subscription.unsubscribe();
  });

  it('does not coerce opaque non-numeric cursors into fake numeric resume state', async () => {
    let subscribeTextHandler: StreamChunkHandler = () => {
      throw new Error('subscribeText handler was not captured');
    };
    let capturedHandler = false;

    durableStreamMock.mockResolvedValue(
      createMockResponse((handler: (chunk: TextChunk) => void | Promise<void>) => {
        subscribeTextHandler = (chunk) => {
          void handler({
            text: chunk.text,
            offset: chunk.offset ?? '-1',
            upToDate: true,
            cursor: chunk.offset,
            streamClosed: false,
          });
        };
        capturedHandler = true;
        return () => {};
      })
    );

    const subscription = getDurableStreamsClient().subscribeToSession('session-2', {});

    await vi.waitFor(() => {
      expect(durableStreamMock).toHaveBeenCalled();
    });

    expect(capturedHandler).toBe(true);

    subscribeTextHandler({
      offset: 'opaque-cursor',
      text: JSON.stringify({
        type: 'chunk',
        data: { text: 'hello' },
        timestamp: 123,
      }),
    });

    expect(subscription.getLastCursor()).toBe('opaque-cursor');
    expect(subscription.getLastOffset()).toBe(0);

    subscription.unsubscribe();
  });
});
