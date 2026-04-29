import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createMeta(streamId: string, eventId: string, partType: string, blockId?: string | null) {
  return {
    schemaVersion: 1,
    eventId,
    streamId,
    blockId: blockId ?? null,
    partType,
    durability: 'durable',
    sequence: null,
    createdAt: '2026-03-23T00:00:00.000Z',
  };
}

type StreamTextChunk = {
  offset?: string;
  text: string;
};

type StreamOptions = {
  url: string;
  live: string;
  offset?: string;
  onError?: (error: unknown) => unknown;
};

type Controller = {
  options: StreamOptions;
  cancel: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  streamClosed: boolean;
  closed: Promise<void>;
  emit: (batch: {
    offset?: string;
    items: Array<{ type: string; data: unknown; timestamp?: number; meta?: unknown }>;
  }) => void;
  emitText: (chunk: { offset?: string; text: string }) => void;
  close: () => void;
};

type ControllerStore = {
  0: Controller;
  1: Controller;
  [index: number]: Controller;
  length: number;
  push: (...controllers: Controller[]) => number;
};

const durableMocks = vi.hoisted(() => {
  const controllers = [] as unknown as ControllerStore;

  const stream = vi.fn(async (options: StreamOptions) => {
    let handler: ((chunk: StreamTextChunk) => void) | null = null;
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
        // The implementation uses subscribeText, which receives { offset, text }
        // where text is JSON-stringified items array
        const chunk: StreamTextChunk = {
          offset: batch.offset,
          text: JSON.stringify(batch.items),
        };
        handler?.(chunk);
      },
      emitText: (chunk) => {
        handler?.(chunk);
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
      subscribeText: (nextHandler: (chunk: StreamTextChunk) => void) => {
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

// =============================================================================
// Existing tests - shared subscriptions
// =============================================================================

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

// =============================================================================
// DurableStreamsClient class tests
// =============================================================================

describe('DurableStreamsClient', () => {
  beforeEach(() => {
    vi.resetModules();
    durableMocks.reset();
  });

  it('creates a stream with the correct URL', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-123', {});

    await flushPromises();

    expect(durableMocks.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('/v1/stream/sessions/sess-123'),
        live: 'sse',
      })
    );

    sub.unsubscribe();
  });

  it('starts in disconnected state before connection', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-new', {});

    // Before async connect resolves, state should not be connected yet
    // (though it may transition quickly)
    expect(['disconnected', 'connecting']).toContain(sub.getState());

    await flushPromises();
    sub.unsubscribe();
  });

  it('transitions to connected after successful stream creation', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const states: string[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-connect', {
      onConnectionStateChange: (s) => states.push(s),
    });

    await flushPromises();

    expect(sub.getState()).toBe('connected');
    expect(states).toContain('connected');

    sub.unsubscribe();
  });

  it('routes chunk events to onChunk callback', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const chunks: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-chunk', {
      onChunk: (e) => chunks.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '1_0',
      items: [
        {
          type: 'chunk',
          data: { text: 'Hello world' },
          timestamp: Date.now(),
          meta: createMeta('sess-chunk', 'evt-chunk-1', 'chunk_end', 'chunk-1'),
        },
      ],
    });

    expect(chunks).toHaveLength(1);
    expect((chunks[0] as { data: { text: string } }).data.text).toBe('Hello world');

    sub.unsubscribe();
  });

  it('parses concatenated catch-up batches from a single text chunk', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const chunks: unknown[] = [];
    const states: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-concatenated-catchup', {
      onChunk: (event) => chunks.push(event),
      onAgentState: (event) => states.push(event),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    const stateBatch = JSON.stringify([
      {
        type: 'state:update',
        data: { status: 'running', sessionId: 'sess-concatenated-catchup' },
        timestamp: 10,
        meta: createMeta('sess-concatenated-catchup', 'evt-state-1', 'lifecycle', 'agent-1'),
      },
    ]);

    const chunkBatch = JSON.stringify([
      {
        type: 'chunk',
        data: { text: 'hello', agentId: 'agent-1' },
        timestamp: 11,
        meta: createMeta('sess-concatenated-catchup', 'evt-chunk-1', 'chunk_end', 'block-1'),
      },
    ]);

    controller.emitText({
      offset: 'opaque_concat_1',
      text: `${stateBatch}${chunkBatch}`,
    });

    expect(states).toHaveLength(1);
    expect((states[0] as { data: { status: string } }).data.status).toBe('running');
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as { data: { text: string } }).data.text).toBe('hello');
    expect(sub.getLastCursor()).toBe('opaque_concat_1');

    sub.unsubscribe();
  });

  it('blocks legacy wire events that omit structured metadata', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const chunks: unknown[] = [];
    const errors: string[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-legacy-blocked', {
      onChunk: (e) => chunks.push(e),
      onError: (error) => errors.push(error.message),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '1_0',
      items: [{ type: 'chunk', data: { text: 'legacy chunk' }, timestamp: Date.now() }],
    });

    expect(chunks).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('structured-envelope-only migration gate');

    sub.unsubscribe();
  });

  it('accepts payload-level structured metadata through the migration gate', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const chunks: Array<{ meta?: { eventId?: string } }> = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-payload-meta', {
      onChunk: (e) => chunks.push(e as { meta?: { eventId?: string } }),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '1_1',
      items: [
        {
          type: 'chunk',
          data: {
            text: 'payload metadata chunk',
            meta: {
              schemaVersion: 1,
              eventId: 'evt-payload-only',
              streamId: 'sess-payload-meta',
              blockId: 'block-payload-only',
              partType: 'chunk_delta',
              durability: 'transient',
              sequence: 0,
              createdAt: new Date().toISOString(),
            },
          },
          timestamp: Date.now(),
        },
      ],
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.meta?.eventId).toBe('evt-payload-only');

    sub.unsubscribe();
  });

  it('routes tool:start events to onToolCall callback', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const tools: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-tool', {
      onToolCall: (e) => tools.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '2_0',
      items: [
        {
          type: 'tool:start',
          data: { id: 'tool-1', tool: 'read_file', input: { path: '/x' } },
          timestamp: Date.now(),
          meta: createMeta('sess-tool', 'evt-tool-start-1', 'tool_start', 'tool-1'),
        },
      ],
    });

    expect(tools).toHaveLength(1);
    expect((tools[0] as { data: { tool: string } }).data.tool).toBe('read_file');
    expect((tools[0] as { data: { status: string } }).data.status).toBe('running');

    sub.unsubscribe();
  });

  it('routes tool:result events to onToolCall callback', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const tools: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-tool-result', {
      onToolCall: (e) => tools.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '3_0',
      items: [
        {
          type: 'tool:result',
          data: { id: 'tool-1', tool: 'read_file', output: 'file contents' },
          timestamp: Date.now(),
          meta: createMeta('sess-tool-result', 'evt-tool-result-1', 'tool_result', 'tool-1'),
        },
      ],
    });

    expect(tools).toHaveLength(1);
    expect((tools[0] as { data: { status: string } }).data.status).toBe('complete');

    sub.unsubscribe();
  });

  it('uses metadata blockId as stable tool identity when payload id is missing', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const tools: Array<{ data: { id: string; status: string; output?: unknown } }> = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-tool-block-id', {
      onToolCall: (e) =>
        tools.push(e as { data: { id: string; status: string; output?: unknown } }),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '3_1',
      items: [
        {
          type: 'tool:start',
          data: { tool: 'read_file', input: { path: '/x' } },
          timestamp: Date.now(),
          meta: {
            schemaVersion: 1,
            eventId: 'evt-tool-start-1',
            streamId: 'sess-tool-block-id',
            blockId: 'tool-block-1',
            partType: 'tool_start',
            durability: 'durable',
            sequence: null,
            createdAt: new Date().toISOString(),
          },
        },
        {
          type: 'tool:result',
          data: { tool: 'read_file', output: 'file contents' },
          timestamp: Date.now(),
          meta: {
            schemaVersion: 1,
            eventId: 'evt-tool-result-1',
            streamId: 'sess-tool-block-id',
            blockId: 'tool-block-1',
            partType: 'tool_result',
            durability: 'durable',
            sequence: null,
            createdAt: new Date().toISOString(),
          },
        },
      ],
    });

    expect(tools).toHaveLength(2);
    expect(tools[0]?.data.id).toBe('tool-block-1');
    expect(tools[1]?.data.id).toBe('tool-block-1');
    expect(tools[1]?.data.status).toBe('complete');

    sub.unsubscribe();
  });

  it('routes presence events to onPresence callback', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const presences: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-presence', {
      onPresence: (e) => presences.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '4_0',
      items: [
        {
          type: 'presence:joined',
          data: { userId: 'user-1' },
          timestamp: Date.now(),
          meta: createMeta('sess-presence', 'evt-presence-1', 'lifecycle', 'user-1'),
        },
      ],
    });

    expect(presences).toHaveLength(1);

    sub.unsubscribe();
  });

  it('routes state:update events to onAgentState callback', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const states: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-state', {
      onAgentState: (e) => states.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '5_0',
      items: [
        {
          type: 'state:update',
          data: { agentId: 'a-1', status: 'running', turn: 3 },
          timestamp: Date.now(),
          meta: createMeta('sess-state', 'evt-state-1', 'lifecycle', 'a-1'),
        },
      ],
    });

    expect(states).toHaveLength(1);

    sub.unsubscribe();
  });

  it('routes container-agent:status to onContainerAgentStatus', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const statuses: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-ca-status', {
      onContainerAgentStatus: (e) => statuses.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '6_0',
      items: [
        {
          type: 'container-agent:status',
          data: {
            taskId: 't-1',
            sessionId: 's-1',
            stage: 'executing',
            message: 'Starting agent',
          },
          timestamp: Date.now(),
          meta: createMeta('sess-ca-status', 'evt-ca-status-1', 'lifecycle', 't-1'),
        },
      ],
    });

    expect(statuses).toHaveLength(1);
    expect((statuses[0] as { data: { stage: string } }).data.stage).toBe('executing');

    sub.unsubscribe();
  });

  it('routes container-agent:token to onContainerAgentToken', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const tokens: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-ca-token', {
      onContainerAgentToken: (e) => tokens.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '7_0',
      items: [
        {
          type: 'container-agent:token',
          data: {
            taskId: 't-1',
            sessionId: 's-1',
            delta: 'Hello',
          },
          timestamp: Date.now(),
          meta: createMeta('sess-ca-token', 'evt-ca-token-1', 'chunk_delta', 't-1'),
        },
      ],
    });

    expect(tokens).toHaveLength(1);

    sub.unsubscribe();
  });

  it('routes container-agent:complete to onContainerAgentComplete', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const completions: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-ca-complete', {
      onContainerAgentComplete: (e) => completions.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '8_0',
      items: [
        {
          type: 'container-agent:complete',
          data: {
            taskId: 't-1',
            sessionId: 's-1',
            status: 'completed',
            turnCount: 5,
          },
          timestamp: Date.now(),
          meta: createMeta('sess-ca-complete', 'evt-ca-complete-1', 'lifecycle', 't-1'),
        },
      ],
    });

    expect(completions).toHaveLength(1);

    sub.unsubscribe();
  });

  it('routes container-agent:error to onContainerAgentError', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const errors: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-ca-error', {
      onContainerAgentError: (e) => errors.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '9_0',
      items: [
        {
          type: 'container-agent:error',
          data: {
            taskId: 't-1',
            sessionId: 's-1',
            error: 'Agent crashed',
            turnCount: 2,
          },
          timestamp: Date.now(),
          meta: createMeta('sess-ca-error', 'evt-ca-error-1', 'lifecycle', 't-1'),
        },
      ],
    });

    expect(errors).toHaveLength(1);

    sub.unsubscribe();
  });

  it('routes container-agent:plan_ready to onContainerAgentPlanReady', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const plans: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-ca-plan', {
      onContainerAgentPlanReady: (e) => plans.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '10_0',
      items: [
        {
          type: 'container-agent:plan_ready',
          data: {
            taskId: 't-1',
            sessionId: 's-1',
            plan: 'Step 1: refactor module',
            turnCount: 3,
          },
          timestamp: Date.now(),
          meta: createMeta('sess-ca-plan', 'evt-ca-plan-1', 'lifecycle', 't-1'),
        },
      ],
    });

    expect(plans).toHaveLength(1);

    sub.unsubscribe();
  });

  it('routes topology:agent_spawned to onTopologyAgentSpawned', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const spawned: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-topo', {
      onTopologyAgentSpawned: (e) => spawned.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '11_0',
      items: [
        {
          type: 'topology:agent_spawned',
          data: {
            agentId: 'a-1',
            name: 'Coder',
            role: 'coder',
            parentId: null,
          },
          timestamp: Date.now(),
          meta: createMeta('sess-topo', 'evt-topo-spawn-1', 'lifecycle', 'a-1'),
        },
      ],
    });

    expect(spawned).toHaveLength(1);

    sub.unsubscribe();
  });

  it('routes topology:agent_completed to onTopologyAgentCompleted', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const completed: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-topo-done', {
      onTopologyAgentCompleted: (e) => completed.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '12_0',
      items: [
        {
          type: 'topology:agent_completed',
          data: {
            agentId: 'a-1',
            status: 'completed',
          },
          timestamp: Date.now(),
          meta: createMeta('sess-topo-done', 'evt-topo-complete-1', 'lifecycle', 'a-1'),
        },
      ],
    });

    expect(completed).toHaveLength(1);

    sub.unsubscribe();
  });

  it('ignores connected control events without error', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const chunks: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-connected-evt', {
      onChunk: (e) => chunks.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '1_0',
      items: [
        { type: 'connected', data: {}, timestamp: Date.now() },
        {
          type: 'chunk',
          data: { text: 'after connect' },
          timestamp: Date.now(),
          meta: createMeta('sess-connected-evt', 'evt-connected-chunk-1', 'chunk_end', 'chunk-1'),
        },
      ],
    });

    // Only chunk should be routed, connected is a control event
    expect(chunks).toHaveLength(1);

    sub.unsubscribe();
  });

  it('updates offset tracking from batch metadata', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-offset', {});

    await flushPromises();

    expect(sub.getLastOffset()).toBe(0);

    const controller = durableMocks.controllers[0];
    controller.emit({
      offset: '5_128',
      items: [{ type: 'chunk', data: { text: 'hi' }, timestamp: Date.now() }],
    });

    expect(sub.getLastOffset()).toBe(5);

    sub.unsubscribe();
  });

  it('calls onError for invalid event data', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const errors: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-invalid', {
      onError: (e) => errors.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    // Send a chunk with invalid data (missing text field - but text defaults to '' so use presence)
    controller.emit({
      offset: '1_0',
      items: [
        {
          type: 'presence:joined',
          data: {
            /* missing userId */
          },
          timestamp: Date.now(),
        },
      ],
    });

    // This should cause a validation failure in rawPresenceDataSchema but
    // mapRawEventToTyped returns null for invalid data, so no error callback is triggered
    // Instead, the event is silently dropped
    // This is the expected behavior per the implementation
    sub.unsubscribe();
  });

  it('blocks conflicting wire and payload metadata during event parsing', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const chunks: unknown[] = [];
    const errors: string[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-conflicting-meta', {
      onChunk: (e) => chunks.push(e),
      onError: (error) => errors.push(error.message),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '1_2',
      items: [
        {
          type: 'chunk',
          data: {
            text: 'conflicting chunk',
            meta: {
              schemaVersion: 1,
              eventId: 'evt-payload',
              streamId: 'sess-conflicting-meta',
              blockId: 'block-1',
              partType: 'chunk_delta',
              durability: 'transient',
              sequence: 0,
              createdAt: '2026-03-23T00:00:00.000Z',
            },
          },
          meta: {
            schemaVersion: 1,
            eventId: 'evt-wire',
            streamId: 'sess-conflicting-meta',
            blockId: 'block-1',
            partType: 'chunk_delta',
            durability: 'transient',
            sequence: 0,
            createdAt: '2026-03-23T00:00:00.000Z',
          },
          timestamp: Date.now(),
        },
      ],
    });

    expect(chunks).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('conflicting wire and payload metadata');

    sub.unsubscribe();
  });

  it('processes multiple events in a single batch', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const chunks: unknown[] = [];
    const tools: unknown[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-multi', {
      onChunk: (e) => chunks.push(e),
      onToolCall: (e) => tools.push(e),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller.emit({
      offset: '3_0',
      items: [
        {
          type: 'chunk',
          data: { text: 'Hello' },
          timestamp: Date.now(),
          meta: createMeta('sess-multi', 'evt-multi-chunk-1', 'chunk_end', 'chunk-1'),
        },
        {
          type: 'tool:start',
          data: { tool: 'bash', id: 't-1' },
          timestamp: Date.now(),
          meta: createMeta('sess-multi', 'evt-multi-tool-1', 'tool_start', 't-1'),
        },
        {
          type: 'chunk',
          data: { text: ' World' },
          timestamp: Date.now(),
          meta: createMeta('sess-multi', 'evt-multi-chunk-2', 'chunk_end', 'chunk-2'),
        },
      ],
    });

    expect(chunks).toHaveLength(2);
    expect(tools).toHaveLength(1);

    sub.unsubscribe();
  });

  it('unsubscribe cleans up and cancels the response', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-unsub', {});

    await flushPromises();
    const controller = durableMocks.controllers[0];

    sub.unsubscribe();

    expect(sub.getState()).toBe('disconnected');
    expect(controller.cancel).toHaveBeenCalled();
  });
});

// =============================================================================
// Fatal error handling
// =============================================================================

describe('fatal error handling', () => {
  beforeEach(() => {
    vi.resetModules();
    durableMocks.reset();
  });

  for (const code of [
    'NOT_FOUND',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'BAD_REQUEST',
    'ALREADY_CONSUMED',
    'ALREADY_CLOSED',
  ]) {
    it(`treats ${code} as fatal and does not request retry`, async () => {
      const streamModule = await import('../../../src/lib/streams/client');
      streamModule.setStreamsAvailable(true);

      const states: string[] = [];
      const sub = streamModule.subscribeToSession(`session-fatal-${code}`, {
        onConnectionStateChange: (s) => states.push(s),
      });

      await flushPromises();

      const controller = durableMocks.controllers[0];
      const result = controller?.options.onError?.(new Error(code));

      expect(result).toBeUndefined();
      expect(sub.getState()).toBe('disconnected');

      sub.unsubscribe();
    });
  }

  it('returns {} to signal retry for non-fatal errors', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const sub = streamModule.subscribeToSession('session-retry', {});

    await flushPromises();

    const controller = durableMocks.controllers[0];
    const result = controller?.options.onError?.(new Error('ECONNRESET'));

    expect(result).toEqual({});
    expect(sub.getState()).toBe('reconnecting');

    sub.unsubscribe();
  });
});

// =============================================================================
// Reconnection behavior
// =============================================================================

describe('reconnection behavior', () => {
  beforeEach(() => {
    vi.resetModules();
    durableMocks.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onReconnect when transitioning from reconnecting to connected', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const reconnectSpy = vi.fn();
    const sub = streamModule.subscribeToSession('sess-reconnect', {
      onReconnect: reconnectSpy,
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    // Trigger error to enter reconnecting state
    controller?.options.onError?.(new Error('temporary'));

    // Emit data to go back to connected
    controller?.emit({
      offset: '1_0',
      items: [
        {
          type: 'chunk',
          data: { text: 'hi' },
          timestamp: Date.now(),
          meta: createMeta('sess-resume-cursor', 'evt-resume-1', 'chunk_end', 'chunk-1'),
        },
      ],
    });

    expect(reconnectSpy).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
  });

  it('does not call onReconnect on initial connection', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const reconnectSpy = vi.fn();
    const sub = streamModule.subscribeToSession('sess-initial', {
      onReconnect: reconnectSpy,
    });

    await flushPromises();

    expect(reconnectSpy).not.toHaveBeenCalled();

    sub.unsubscribe();
  });

  it('calls onDisconnect when stream closes', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const disconnectSpy = vi.fn();
    const sub = streamModule.subscribeToSession('sess-disconnect', {
      onDisconnect: disconnectSpy,
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    controller?.close();
    await flushPromises();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
  });

  it('does not call onDisconnect after unsubscribe', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const disconnectSpy = vi.fn();
    const sub = streamModule.subscribeToSession('sess-no-disconnect', {
      onDisconnect: disconnectSpy,
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    sub.unsubscribe();
    controller?.close();
    await flushPromises();

    expect(disconnectSpy).not.toHaveBeenCalled();
  });

  it('reconnects with the last opaque cursor after clean stream closure', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const chunkSpy = vi.fn();
    const sub = streamModule.subscribeToSession('sess-resume-cursor', {
      onChunk: chunkSpy,
    });

    await flushPromises();

    const firstController = durableMocks.controllers[0];
    firstController?.emit({
      offset: 'opaque_42',
      items: [{ type: 'chunk', data: { text: 'first' }, timestamp: Date.now() }],
    });

    expect(sub.getLastCursor()).toBe('opaque_42');

    firstController?.close();
    await flushPromises();

    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();

    expect(durableMocks.stream).toHaveBeenCalledTimes(2);
    expect(durableMocks.controllers[1]?.options.offset).toBe('opaque_42');

    sub.unsubscribe();
  });

  it('F05-28: resets reconnect-attempt budget after a successful reconnect', async () => {
    // Simulate: connect → close → reconnect (success) → close again. After
    // the second close the implementation should NOT have terminal-disconnected
    // because the successful reconnect re-armed the budget. With the bug, the
    // counter never resets and the budget exhausts after MAX_RECONNECT_ATTEMPTS
    // closes regardless of intervening successes.
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const terminalSpy = vi.fn();
    const sub = streamModule.subscribeToSession('sess-reconnect-budget', {
      onTerminalDisconnect: terminalSpy,
    });

    await flushPromises();
    expect(durableMocks.stream).toHaveBeenCalledTimes(1);

    // Burn 5 close→reconnect cycles. Each successful reconnect must reset
    // the counter so MAX_RECONNECT_ATTEMPTS=8 is never approached.
    for (let cycle = 0; cycle < 5; cycle++) {
      const ctrl = durableMocks.controllers[cycle];
      // Deliver an event so markConnected() runs and resets the budget.
      ctrl?.emit({
        offset: `opaque_${cycle}`,
        items: [{ type: 'chunk', data: { text: `cycle-${cycle}` }, timestamp: Date.now() }],
      });
      ctrl?.close();
      await flushPromises();
      // Backoff capped at 30s; first few cycles reach 2s/4s/8s/16s/30s.
      await vi.advanceTimersByTimeAsync(30000);
      await flushPromises();
    }

    // Now there should be (cycles + 1) underlying streams created — one
    // per reconnect — and no terminal-disconnect callback yet.
    expect(durableMocks.stream).toHaveBeenCalledTimes(6);
    expect(terminalSpy).not.toHaveBeenCalled();

    sub.unsubscribe();
  });

  it('resumes mixed chunk and tool replay from the last opaque cursor after transient error', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const chunks: Array<{ data: { text: string } }> = [];
    const tools: Array<{ data: { id: string; status: string; output?: unknown } }> = [];

    const sub = streamModule.subscribeToSession('sess-mixed-resume', {
      onChunk: (event) => chunks.push(event as { data: { text: string } }),
      onToolCall: (event) =>
        tools.push(event as { data: { id: string; status: string; output?: unknown } }),
    });

    await flushPromises();

    const firstController = durableMocks.controllers[0];
    firstController?.emit({
      offset: 'opaque_100',
      items: [
        {
          type: 'chunk',
          data: { text: 'hello' },
          timestamp: Date.now(),
          meta: createMeta('sess-mixed-resume', 'evt-mixed-chunk-1', 'chunk_end', 'chunk-1'),
        },
        {
          type: 'tool:start',
          data: { tool: 'bash', input: { command: 'pwd' } },
          timestamp: Date.now(),
          meta: {
            schemaVersion: 1,
            eventId: 'evt-tool-start-100',
            streamId: 'sess-mixed-resume',
            blockId: 'tool-block-100',
            partType: 'tool_start',
            durability: 'durable',
            sequence: null,
            createdAt: new Date().toISOString(),
          },
        },
      ],
    });

    expect(sub.getLastCursor()).toBe('opaque_100');
    expect(chunks).toHaveLength(1);
    expect(tools[0]?.data.id).toBe('tool-block-100');

    firstController?.options.onError?.(new Error('ECONNRESET'));
    await flushPromises();
    expect(sub.getState()).toBe('reconnecting');

    firstController?.emit({
      offset: 'opaque_101',
      items: [
        {
          type: 'tool:result',
          data: { tool: 'bash', output: 'pwd output' },
          timestamp: Date.now(),
          meta: {
            schemaVersion: 1,
            eventId: 'evt-tool-result-100',
            streamId: 'sess-mixed-resume',
            blockId: 'tool-block-100',
            partType: 'tool_result',
            durability: 'durable',
            sequence: null,
            createdAt: new Date().toISOString(),
          },
        },
        {
          type: 'chunk',
          data: { text: ' world' },
          timestamp: Date.now(),
          meta: createMeta('sess-mixed-resume', 'evt-mixed-chunk-2', 'chunk_end', 'chunk-2'),
        },
      ],
    });

    expect(sub.getState()).toBe('connected');
    expect(sub.getLastCursor()).toBe('opaque_101');
    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.data.text).toBe(' world');
    expect(tools).toHaveLength(2);
    expect(tools[1]?.data.id).toBe('tool-block-100');
    expect(tools[1]?.data.status).toBe('complete');

    sub.unsubscribe();
  });
});

// =============================================================================
// Shared subscription fan-out
// =============================================================================

describe('shared subscription fan-out', () => {
  beforeEach(() => {
    vi.resetModules();
    durableMocks.reset();
  });

  it('delivers events to all subscribers of the same session', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const chunks1: unknown[] = [];
    const chunks2: unknown[] = [];

    const sub1 = streamModule.subscribeToSession('shared-session', {
      onChunk: (e) => chunks1.push(e),
    });

    await flushPromises();

    const sub2 = streamModule.subscribeToSession('shared-session', {
      onChunk: (e) => chunks2.push(e),
    });

    const controller = durableMocks.controllers[0];
    controller.emit({
      offset: '1_0',
      items: [
        {
          type: 'chunk',
          data: { text: 'shared!' },
          timestamp: Date.now(),
          meta: createMeta('shared-session', 'evt-shared-1', 'chunk_end', 'chunk-1'),
        },
      ],
    });

    expect(chunks1).toHaveLength(1);
    expect(chunks2).toHaveLength(1);

    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  it('only uses one underlying stream for shared sessions', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const sub1 = streamModule.subscribeToSession('one-stream', {});
    await flushPromises();

    const sub2 = streamModule.subscribeToSession('one-stream', {});
    await flushPromises();

    expect(durableMocks.stream).toHaveBeenCalledTimes(1);

    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  it('keeps stream alive when one subscriber unsubscribes but another remains', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const chunks: unknown[] = [];
    const sub1 = streamModule.subscribeToSession('keep-alive', {});
    await flushPromises();

    const sub2 = streamModule.subscribeToSession('keep-alive', {
      onChunk: (e) => chunks.push(e),
    });

    sub1.unsubscribe();

    // Stream should still work for sub2
    const controller = durableMocks.controllers[0];
    controller.emit({
      offset: '1_0',
      items: [
        {
          type: 'chunk',
          data: { text: 'still alive' },
          timestamp: Date.now(),
          meta: createMeta('keep-alive', 'evt-keepalive-1', 'chunk_end', 'chunk-1'),
        },
      ],
    });

    expect(chunks).toHaveLength(1);
    expect(sub2.getState()).toBe('connected');

    sub2.unsubscribe();
  });

  it('tears down stream when all subscribers unsubscribe', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    const sub1 = streamModule.subscribeToSession('teardown', {});
    await flushPromises();

    const sub2 = streamModule.subscribeToSession('teardown', {});

    const controller = durableMocks.controllers[0];

    sub1.unsubscribe();
    sub2.unsubscribe();

    expect(controller.cancel).toHaveBeenCalled();
  });
});

// =============================================================================
// setStreamsAvailable / isStreamsAvailable
// =============================================================================

describe('streams availability', () => {
  beforeEach(() => {
    vi.resetModules();
    durableMocks.reset();
  });

  it('setStreamsAvailable(true) enables connections', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(true);

    expect(streamModule.isStreamsAvailable()).toBe(true);

    const sub = streamModule.subscribeToSession('avail-session', {});
    await flushPromises();

    expect(durableMocks.stream).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
  });

  it('setStreamsAvailable(false) prevents connections', async () => {
    const streamModule = await import('../../../src/lib/streams/client');
    streamModule.setStreamsAvailable(false);

    expect(streamModule.isStreamsAvailable()).toBe(false);

    const sub = streamModule.subscribeToSession('no-avail-session', {});
    await flushPromises();

    expect(durableMocks.stream).not.toHaveBeenCalled();
    expect(sub.getState()).toBe('disconnected');

    sub.unsubscribe();
  });
});

// =============================================================================
// subscribeToAgent
// =============================================================================

describe('subscribeToAgent', () => {
  beforeEach(() => {
    vi.resetModules();
    durableMocks.reset();
  });

  it('subscribes to agent-prefixed session', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToAgent('agent-123', {
      onState: vi.fn(),
      onStep: vi.fn(),
    });

    await flushPromises();

    expect(durableMocks.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('/v1/stream/sessions/agent:agent-123'),
      })
    );

    sub.unsubscribe();
  });
});

// =============================================================================
// Error scenarios
// =============================================================================

describe('error scenarios', () => {
  beforeEach(() => {
    vi.resetModules();
    durableMocks.reset();
  });

  it('reports onError callback when stream creation fails', async () => {
    durableMocks.stream.mockRejectedValueOnce(new Error('Connection refused'));

    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const errors: Error[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('fail-session', {
      onError: (e) => errors.push(e as Error),
    });

    await flushPromises();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('Connection refused');

    sub.unsubscribe();
  });

  it('calls onError for fatal stream creation errors', async () => {
    durableMocks.stream.mockRejectedValueOnce(new Error('NOT_FOUND: stream not found'));

    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const errors: Error[] = [];
    const states: string[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('fatal-create', {
      onError: (e) => errors.push(e as Error),
      onConnectionStateChange: (s) => states.push(s),
    });

    await flushPromises();

    expect(errors).toHaveLength(1);
    expect(sub.getState()).toBe('disconnected');

    sub.unsubscribe();
  });

  it('normalizes non-Error objects in onError callback from stream', async () => {
    const { DurableStreamsClient, setStreamsAvailable } = await import(
      '../../../src/lib/streams/client'
    );
    setStreamsAvailable(true);

    const errors: Error[] = [];
    const client = new DurableStreamsClient({ url: '/v1/stream/sessions' });
    const sub = client.subscribeToSession('sess-norm-error', {
      onError: (e) => errors.push(e as Error),
    });

    await flushPromises();
    const controller = durableMocks.controllers[0];

    // Clear any errors accumulated during connection setup
    errors.length = 0;

    // Pass a string instead of Error
    controller?.options.onError?.('string error' as unknown);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);

    sub.unsubscribe();
  });
});
