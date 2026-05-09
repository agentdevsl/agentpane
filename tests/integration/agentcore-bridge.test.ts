/**
 * Integration tests for `src/lib/agents/agentcore-bridge.ts`.
 *
 * The bridge translates AWS AgentCore SSE events into DurableStreams
 * publishes plus typed callbacks (onComplete/onError/onPlanReady). The
 * file was at 0% combined coverage despite being in the production
 * AgentCore container-agent path.
 *
 * IT-IDs: IT-2400 to IT-2429
 */
import { describe, expect, it, vi } from 'vitest';
import { createAgentCoreBridge } from '../../src/lib/agents/agentcore-bridge';
import type { SSEEvent } from '../../src/lib/sandbox/providers/agentcore-sandbox-instance';

function makeStreams(opts: { publishThrows?: Error; failTimes?: number } = {}) {
  let calls = 0;
  return {
    publish: vi.fn(async () => {
      calls++;
      if (opts.publishThrows && (!opts.failTimes || calls <= opts.failTimes)) {
        throw opts.publishThrows;
      }
    }),
  };
}

function makeBridge(overrides: Partial<Parameters<typeof createAgentCoreBridge>[0]> = {}) {
  const streams = overrides.streams ?? makeStreams();
  const onComplete = vi.fn();
  const onError = vi.fn();
  const onPlanReady = vi.fn();
  const bridge = createAgentCoreBridge({
    taskId: 'task-1',
    sessionId: 'session-1',
    codespaceId: 'cs-1',
    streams: streams as never,
    onComplete,
    onError,
    onPlanReady,
    ...overrides,
  });
  return { bridge, streams, onComplete, onError, onPlanReady };
}

async function* fromArray(events: SSEEvent[]): AsyncIterable<SSEEvent> {
  for (const e of events) yield e;
}

describe('createAgentCoreBridge.processStream', () => {
  it('IT-2400: skips processing when bridge is stopped before invocation', async () => {
    const { bridge, streams } = makeBridge();
    bridge.stop();
    await bridge.processStream(fromArray([{ type: 'agent:turn', data: { turnCount: 1 } }]));
    expect(streams.publish).not.toHaveBeenCalled();
  });

  it('IT-2401: publishes a known event type to the configured stream + sessionId', async () => {
    const { bridge, streams } = makeBridge();
    await bridge.processStream(
      fromArray([{ type: 'agent:turn', data: { turnCount: 1, content: 'ok' } }])
    );
    expect(streams.publish).toHaveBeenCalledTimes(1);
    const [streamId, _type, payload] = (streams.publish as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(streamId).toBe('session-1');
    // Context is appended after spread so taskId/sessionId/codespaceId always populate
    expect(payload).toMatchObject({
      taskId: 'task-1',
      sessionId: 'session-1',
      codespaceId: 'cs-1',
      turnCount: 1,
      content: 'ok',
    });
  });

  it('IT-2402: skips events missing type or data', async () => {
    const { bridge, streams } = makeBridge();
    await bridge.processStream(
      fromArray([
        { type: '', data: { x: 1 } } as SSEEvent,
        { type: 'agent:turn' } as SSEEvent,
        { type: 'agent:turn', data: 'not-an-object' as never } as SSEEvent,
      ])
    );
    expect(streams.publish).not.toHaveBeenCalled();
  });

  it('IT-2403: skips unknown event types', async () => {
    const { bridge, streams } = makeBridge();
    await bridge.processStream(
      fromArray([{ type: 'agent:unknown-foo' as never, data: { whatever: true } }])
    );
    expect(streams.publish).not.toHaveBeenCalled();
  });

  it('IT-2404: stops mid-stream when stop() is called between events', async () => {
    const { bridge, streams } = makeBridge();
    async function* eventsThenStop(): AsyncIterable<SSEEvent> {
      yield { type: 'agent:turn', data: { turnCount: 1 } };
      bridge.stop();
      yield { type: 'agent:turn', data: { turnCount: 2 } };
    }
    await bridge.processStream(eventsThenStop());
    // Only the first publish ran; the second event hit the stopped guard
    // and broke out of the loop without publishing.
    expect(streams.publish).toHaveBeenCalledTimes(1);
  });

  it('IT-2405: invokes onComplete with status="completed" + turnCount on agent:complete', async () => {
    const { bridge, onComplete } = makeBridge();
    await bridge.processStream(
      fromArray([{ type: 'agent:complete', data: { status: 'completed', turnCount: 7 } }])
    );
    expect(onComplete).toHaveBeenCalledWith('completed', 7);
  });

  it('IT-2406: agent:complete with malformed status falls back to "completed" + turnCount=0', async () => {
    const { bridge, onComplete } = makeBridge();
    await bridge.processStream(
      fromArray([{ type: 'agent:complete', data: { status: 'banana', turnCount: 'NaN' as never } }])
    );
    expect(onComplete).toHaveBeenCalledWith('completed', 0);
  });

  it('IT-2407: agent:complete with valid status="turn_limit" passes through', async () => {
    const { bridge, onComplete } = makeBridge();
    await bridge.processStream(
      fromArray([{ type: 'agent:complete', data: { status: 'turn_limit', turnCount: 50 } }])
    );
    expect(onComplete).toHaveBeenCalledWith('turn_limit', 50);
  });

  it('IT-2408: invokes onError with message + turnCount on agent:error', async () => {
    const { bridge, onError } = makeBridge();
    await bridge.processStream(
      fromArray([{ type: 'agent:error', data: { error: 'boom', turnCount: 3 } }])
    );
    expect(onError).toHaveBeenCalledWith('boom', 3);
  });

  it('IT-2409: agent:error with non-string error falls back to String(error)', async () => {
    const { bridge, onError } = makeBridge();
    await bridge.processStream(
      fromArray([{ type: 'agent:error', data: { error: { code: 500 } } }])
    );
    // String({ code: 500 }) → "[object Object]" — the fallback fires the
    // callback rather than dropping it, so the error path is non-silent.
    expect(onError).toHaveBeenCalledWith('[object Object]', 0);
  });

  it('IT-2410: agent:error with no error data still fires callback (Unknown error)', async () => {
    const { bridge, onError } = makeBridge();
    await bridge.processStream(fromArray([{ type: 'agent:error', data: {} }]));
    expect(onError).toHaveBeenCalledWith('Unknown error', 0);
  });

  it('IT-2411: agent:cancelled invokes onComplete with status="cancelled"', async () => {
    const { bridge, onComplete } = makeBridge();
    await bridge.processStream(fromArray([{ type: 'agent:cancelled', data: { turnCount: 2 } }]));
    expect(onComplete).toHaveBeenCalledWith('cancelled', 2);
  });

  it('IT-2412: agent:cancelled with no turnCount uses 0 fallback', async () => {
    const { bridge, onComplete } = makeBridge();
    await bridge.processStream(fromArray([{ type: 'agent:cancelled', data: {} }]));
    expect(onComplete).toHaveBeenCalledWith('cancelled', 0);
  });

  it('IT-2413: agent:plan_ready invokes onPlanReady with full plan payload', async () => {
    const { bridge, onPlanReady } = makeBridge();
    await bridge.processStream(
      fromArray([
        {
          type: 'agent:plan_ready',
          data: {
            plan: '## Plan\n1. Step',
            turnCount: 1,
            sdkSessionId: 'sdk-abc',
            allowedPrompts: [{ tool: 'Bash', prompt: 'ls' }],
          },
        },
      ])
    );
    expect(onPlanReady).toHaveBeenCalledWith({
      plan: '## Plan\n1. Step',
      turnCount: 1,
      sdkSessionId: 'sdk-abc',
      allowedPrompts: [{ tool: 'Bash', prompt: 'ls' }],
    });
  });

  it('IT-2414: agent:plan_ready with non-string plan stringifies the data as fallback', async () => {
    const { bridge, onPlanReady } = makeBridge();
    await bridge.processStream(
      fromArray([{ type: 'agent:plan_ready', data: { something: 'else' } }])
    );
    expect(onPlanReady).toHaveBeenCalledWith(
      expect.objectContaining({ plan: expect.stringContaining('something'), turnCount: 0 })
    );
  });

  it('IT-2415: stream-iteration error publishes container-agent:error and fires onError', async () => {
    const { bridge, streams, onError } = makeBridge();
    async function* throwing(): AsyncIterable<SSEEvent> {
      yield { type: 'agent:turn', data: { turnCount: 1 } };
      throw new Error('socket reset');
    }
    await bridge.processStream(throwing());
    expect(onError).toHaveBeenCalledWith('socket reset', 0);
    // First the agent:turn publish; second the error publish
    const calls = (streams.publish as ReturnType<typeof vi.fn>).mock.calls;
    const errorCall = calls.find((c) => c[1] === 'container-agent:error');
    expect(errorCall).toBeDefined();
    expect(errorCall![2]).toMatchObject({ error: 'socket reset', turnCount: 0 });
  });

  it('IT-2416: tolerates transient publish failures (under threshold) without throwing', async () => {
    // 3 transient failures then success — under the MAX_CONSECUTIVE = 5 threshold
    const streams = makeStreams({ publishThrows: new Error('stream backpressure'), failTimes: 3 });
    const { bridge, onComplete } = makeBridge({ streams: streams as never });
    await bridge.processStream(
      fromArray([
        { type: 'agent:turn', data: { turnCount: 1 } },
        { type: 'agent:turn', data: { turnCount: 2 } },
        { type: 'agent:turn', data: { turnCount: 3 } },
        // success starts here, failure counter resets on success
        { type: 'agent:turn', data: { turnCount: 4 } },
        { type: 'agent:complete', data: { status: 'completed', turnCount: 4 } },
      ])
    );
    expect(onComplete).toHaveBeenCalledWith('completed', 4);
  });

  it('IT-2417: throws after MAX_CONSECUTIVE_PUBLISH_FAILURES (5) — error propagates', async () => {
    // After 5 consecutive failures publishEvent throws. The outer catch in
    // processStream tries to publish container-agent:error which ALSO fails
    // (still in the failing window), so the throw propagates out. This is
    // intentional — silent loss of every publish would orphan the task.
    const streams = makeStreams({ publishThrows: new Error('stream offline') });
    const { bridge } = makeBridge({ streams: streams as never });
    await expect(
      bridge.processStream(
        fromArray([
          { type: 'agent:turn', data: { turnCount: 1 } },
          { type: 'agent:turn', data: { turnCount: 2 } },
          { type: 'agent:turn', data: { turnCount: 3 } },
          { type: 'agent:turn', data: { turnCount: 4 } },
          { type: 'agent:turn', data: { turnCount: 5 } },
          { type: 'agent:turn', data: { turnCount: 6 } },
        ])
      )
    ).rejects.toThrow(/consecutive times/);
  });

  it('IT-2418: routes events to their typed stream channel via EVENT_TYPE_MAP', async () => {
    const { bridge, streams } = makeBridge();
    await bridge.processStream(
      fromArray([
        { type: 'agent:started', data: {} },
        { type: 'agent:turn', data: { turnCount: 1 } },
        { type: 'agent:tool:start', data: { toolName: 'Bash' } },
        { type: 'agent:tool:result', data: { exitCode: 0 } },
        { type: 'agent:token', data: { delta: 'hi' } },
        { type: 'agent:message', data: { role: 'assistant' } },
      ])
    );
    const types = (streams.publish as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    // All 6 events map to typed container-agent:* channels
    expect(types).toEqual([
      'container-agent:started',
      'container-agent:turn',
      'container-agent:tool:start',
      'container-agent:tool:result',
      'container-agent:token',
      'container-agent:message',
    ]);
  });

  it('IT-2420: topology event types route to topology:* channels', async () => {
    const { bridge, streams } = makeBridge();
    await bridge.processStream(
      fromArray([
        { type: 'agent:topology:spawned', data: { agent: 'planner' } },
        { type: 'agent:topology:progress', data: { progress: 0.5 } },
        { type: 'agent:topology:completed', data: { result: 'ok' } },
      ])
    );
    const types = (streams.publish as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(types).toEqual([
      'topology:agent_spawned',
      'topology:agent_progress',
      'topology:agent_completed',
    ]);
  });

  it('IT-2421: stop() is idempotent and safe to call after processStream completes', async () => {
    const { bridge } = makeBridge();
    await bridge.processStream(
      fromArray([{ type: 'agent:complete', data: { status: 'completed', turnCount: 1 } }])
    );
    expect(() => {
      bridge.stop();
      bridge.stop();
    }).not.toThrow();
  });
});
