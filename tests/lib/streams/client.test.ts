import { beforeEach, describe, expect, it, vi } from 'vitest';

type StreamBatchItem = {
  type: string;
  data: unknown;
  timestamp?: number;
};

type StreamBatch = {
  offset?: string;
  items: StreamBatchItem[];
};

type StreamOptions = {
  onError?: (error: unknown) => unknown;
};

type Controller = {
  options: StreamOptions;
  cancel: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  streamClosed: boolean;
  closed: Promise<void>;
  emit: (batch: StreamBatch) => void;
  close: () => void;
};

const durableMocks = vi.hoisted(() => {
  const controllers: Controller[] = [];

  const stream = vi.fn(async (options: StreamOptions) => {
    let handler: ((batch: StreamBatch) => void) | null = null;
    let resolveClosed = () => {};

    const controller: Controller = {
      options,
      cancel: vi.fn(),
      unsubscribe: vi.fn(),
      streamClosed: false,
      closed: new Promise<void>((resolve) => {
        resolveClosed = resolve;
      }),
      emit: (batch) => {
        handler?.(batch);
      },
      close: () => {
        resolveClosed();
      },
    };

    controllers.push(controller);

    return {
      streamClosed: controller.streamClosed,
      cancel: controller.cancel,
      closed: controller.closed,
      subscribeJson: (nextHandler: (batch: StreamBatch) => void) => {
        handler = nextHandler;
        return controller.unsubscribe;
      },
    };
  });

  const reset = () => {
    controllers.length = 0;
    stream.mockClear();
  };

  return { controllers, reset, stream };
});

vi.mock('@durable-streams/client', () => ({
  stream: durableMocks.stream,
}));

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('stream client shared subscriptions', () => {
  beforeEach(() => {
    vi.resetModules();
    durableMocks.reset();
  });

  it('hydrates late shared subscribers with the current connected state', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const firstStates: Array<string> = [];
    const secondStates: Array<string> = [];

    const first = streamModule.subscribeToSession('session-1', {
      onConnectionStateChange: (state) => {
        firstStates.push(state);
      },
    });

    await flushPromises();

    expect(durableMocks.stream).toHaveBeenCalledTimes(1);
    expect(first.getState()).toBe('connected');
    expect(firstStates).toContain('connected');

    const second = streamModule.subscribeToSession('session-1', {
      onConnectionStateChange: (state) => {
        secondStates.push(state);
      },
    });

    expect(durableMocks.stream).toHaveBeenCalledTimes(1);
    expect(second.getState()).toBe('connected');
    expect(secondStates).toEqual(['connected']);

    second.unsubscribe();
    first.unsubscribe();
  });

  it('transitions through reconnecting and back to connected without creating a second stream', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const seenStates: Array<string> = [];
    const reconnectSpy = vi.fn();

    const subscription = streamModule.subscribeToSession('session-2', {
      onConnectionStateChange: (state) => {
        seenStates.push(state);
      },
      onReconnect: reconnectSpy,
    });

    await flushPromises();

    const controller = durableMocks.controllers[0];
    expect(controller).toBeDefined();
    expect(subscription.getState()).toBe('connected');
    expect(durableMocks.stream).toHaveBeenCalledTimes(1);

    const retrySignal = controller?.options.onError?.(new Error('temporary network issue'));

    expect(retrySignal).toEqual({});
    expect(subscription.getState()).toBe('reconnecting');
    expect(seenStates).toContain('reconnecting');

    controller?.emit({
      offset: '12_1',
      items: [{ type: 'connected', data: {}, timestamp: Date.now() }],
    });

    expect(subscription.getState()).toBe('connected');
    expect(seenStates[seenStates.length - 1]).toBe('connected');
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    expect(durableMocks.stream).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
  });

  it('blocks subscriptions when streamsAvailable is false', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    // Do NOT call setStreamsAvailable(true)
    // or explicitly call setStreamsAvailable(false)
    streamModule.setStreamsAvailable(false);

    const callbacks = {
      onError: vi.fn(),
      onConnectionStateChange: vi.fn(),
    };

    const sub = streamModule.subscribeToSession('blocked-session', callbacks);

    // Wait for the async connect() to execute
    await flushPromises();

    // No underlying durable stream should have been created
    expect(durableMocks.stream).not.toHaveBeenCalled();
    // Subscription should remain disconnected
    expect(sub.getState()).toBe('disconnected');

    sub.unsubscribe();
  });

  it('treats fatal errors as disconnected and does not request retry', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const seenStates: Array<string> = [];

    const subscription = streamModule.subscribeToSession('session-3', {
      onConnectionStateChange: (state) => {
        seenStates.push(state);
      },
    });

    await flushPromises();

    const controller = durableMocks.controllers[0];
    const retrySignal = controller?.options.onError?.(new Error('FORBIDDEN'));

    expect(retrySignal).toBeUndefined();
    expect(subscription.getState()).toBe('disconnected');
    expect(seenStates).toContain('disconnected');

    subscription.unsubscribe();
  });
});
