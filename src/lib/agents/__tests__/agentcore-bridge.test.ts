import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentCoreBridge,
  AgentCoreBridgeOptions,
  AgentCorePlanReadyData,
  SSEEvent,
} from '../agentcore-bridge.js';
import { createAgentCoreBridge } from '../agentcore-bridge.js';
import { EVENT_TYPE_MAP } from '../event-type-map.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an AsyncIterable from an array of SSE events.
 * Optionally inserts a small delay between events for realism.
 */
async function* asyncIterableFromArray(events: SSEEvent[]): AsyncIterable<SSEEvent> {
  for (const event of events) {
    yield event;
  }
}

/**
 * Create an AsyncIterable that throws after yielding some events.
 */
async function* asyncIterableThatThrows(
  events: SSEEvent[],
  errorMessage: string
): AsyncIterable<SSEEvent> {
  for (const event of events) {
    yield event;
  }
  throw new Error(errorMessage);
}

/**
 * Create an AsyncIterable with a controllable delay that checks for stop.
 */
function asyncIterableWithDelay(events: SSEEvent[], delayMs = 50): AsyncIterable<SSEEvent> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SSEEvent>> {
          if (index >= events.length) {
            return { done: true, value: undefined };
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          const event = events[index++]!;
          return { done: false, value: event };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock DurableStreamsService
// ---------------------------------------------------------------------------

interface MockStreams {
  publish: ReturnType<typeof vi.fn>;
}

function createMockStreams(): MockStreams {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentCoreBridge', () => {
  let mockStreams: MockStreams;
  const taskId = 'task-001';
  const sessionId = 'session-001';
  const projectId = 'proj-001';

  beforeEach(() => {
    vi.clearAllMocks();
    mockStreams = createMockStreams();
    // Suppress console.log noise from info/debug logs
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createBridge(overrides: Partial<AgentCoreBridgeOptions> = {}): AgentCoreBridge {
    return createAgentCoreBridge({
      taskId,
      sessionId,
      projectId,
      streams: mockStreams as unknown as AgentCoreBridgeOptions['streams'],
      ...overrides,
    });
  }

  // -------------------------------------------------------------------------
  // 1. Basic event processing
  // -------------------------------------------------------------------------

  it('should map agent events to container-agent events', async () => {
    const events: SSEEvent[] = [
      { type: 'agent:started', data: { message: 'Agent starting' } },
      { type: 'agent:turn', data: { turnCount: 1, content: 'hello' } },
    ];

    const bridge = createBridge();
    await bridge.processStream(asyncIterableFromArray(events));

    expect(mockStreams.publish).toHaveBeenCalledTimes(2);

    // First call: agent:started mapped to container-agent:started
    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:started',
      expect.objectContaining({
        taskId,
        sessionId,
        projectId,
        message: 'Agent starting',
      })
    );

    // Second call: agent:turn mapped to container-agent:turn
    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:turn',
      expect.objectContaining({
        taskId,
        sessionId,
        projectId,
        turnCount: 1,
        content: 'hello',
      })
    );
  });

  // -------------------------------------------------------------------------
  // 2. All event types mapped correctly
  // -------------------------------------------------------------------------

  it('should map all event types from EVENT_TYPE_MAP', async () => {
    const eventTypes = Object.keys(EVENT_TYPE_MAP) as Array<keyof typeof EVENT_TYPE_MAP>;
    const events: SSEEvent[] = eventTypes.map((type) => ({
      type,
      data: {
        turnCount: 1,
        status: 'completed',
        error: 'test',
        plan: 'plan',
        sdkSessionId: 'sdk-1',
      },
    }));

    const bridge = createBridge();
    await bridge.processStream(asyncIterableFromArray(events));

    expect(mockStreams.publish).toHaveBeenCalledTimes(eventTypes.length);

    for (let i = 0; i < eventTypes.length; i++) {
      const agentType = eventTypes[i]!;
      const expectedStreamType = EVENT_TYPE_MAP[agentType];
      expect(mockStreams.publish).toHaveBeenCalledWith(
        sessionId,
        expectedStreamType,
        expect.objectContaining({ taskId, sessionId, projectId })
      );
    }
  });

  // -------------------------------------------------------------------------
  // 3. Token streaming
  // -------------------------------------------------------------------------

  it('should publish token events with delta data', async () => {
    const events: SSEEvent[] = [
      { type: 'agent:token', data: { delta: 'Hello' } },
      { type: 'agent:token', data: { delta: ' world' } },
      { type: 'agent:token', data: { delta: '!' } },
    ];

    const bridge = createBridge();
    await bridge.processStream(asyncIterableFromArray(events));

    expect(mockStreams.publish).toHaveBeenCalledTimes(3);

    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:token',
      expect.objectContaining({ delta: 'Hello', taskId, sessionId, projectId })
    );
    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:token',
      expect.objectContaining({ delta: ' world' })
    );
    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:token',
      expect.objectContaining({ delta: '!' })
    );
  });

  // -------------------------------------------------------------------------
  // 4. Turn tracking (eventCount)
  // -------------------------------------------------------------------------

  it('should track event count across the stream', async () => {
    const events: SSEEvent[] = [
      { type: 'agent:started', data: { message: 'started' } },
      { type: 'agent:turn', data: { turnCount: 1 } },
      { type: 'agent:turn', data: { turnCount: 2 } },
      { type: 'agent:turn', data: { turnCount: 3 } },
    ];

    const bridge = createBridge();
    await bridge.processStream(asyncIterableFromArray(events));

    // All 4 events should be published
    expect(mockStreams.publish).toHaveBeenCalledTimes(4);
  });

  // -------------------------------------------------------------------------
  // 5. Plan ready callback
  // -------------------------------------------------------------------------

  it('should call onPlanReady with plan data', async () => {
    const onPlanReady = vi.fn();
    const planData: AgentCorePlanReadyData = {
      plan: 'Step 1: read files\nStep 2: implement feature',
      turnCount: 5,
      sdkSessionId: 'sdk-session-123',
      allowedPrompts: [{ tool: 'Bash', prompt: 'npm test' }],
    };

    const events: SSEEvent[] = [
      { type: 'agent:plan_ready', data: planData as unknown as Record<string, unknown> },
    ];

    const bridge = createBridge({ onPlanReady });
    await bridge.processStream(asyncIterableFromArray(events));

    expect(onPlanReady).toHaveBeenCalledTimes(1);
    expect(onPlanReady).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: 'Step 1: read files\nStep 2: implement feature',
        turnCount: 5,
        sdkSessionId: 'sdk-session-123',
        allowedPrompts: [{ tool: 'Bash', prompt: 'npm test' }],
      })
    );
  });

  it('should not throw when onPlanReady is not provided', async () => {
    const events: SSEEvent[] = [
      {
        type: 'agent:plan_ready',
        data: { plan: 'plan text', turnCount: 3, sdkSessionId: 'sdk-1' },
      },
    ];

    const bridge = createBridge({ onPlanReady: undefined });
    await expect(bridge.processStream(asyncIterableFromArray(events))).resolves.toBeUndefined();
  });

  it('should call onPlanReady with fallback values when plan is missing', async () => {
    const onPlanReady = vi.fn();
    const events: SSEEvent[] = [
      { type: 'agent:plan_ready', data: { turnCount: 3, sdkSessionId: 'sdk-1' } },
    ];

    const bridge = createBridge({ onPlanReady });
    await bridge.processStream(asyncIterableFromArray(events));

    // Event is published to DurableStreams
    expect(mockStreams.publish).toHaveBeenCalledTimes(1);
    // Callback fires with fallback plan (JSON stringified data) to prevent stuck tasks
    expect(onPlanReady).toHaveBeenCalledTimes(1);
    const planData = onPlanReady.mock.calls[0]![0];
    expect(planData.turnCount).toBe(3);
    expect(planData.sdkSessionId).toBe('sdk-1');
    expect(typeof planData.plan).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 6. Completion callback
  // -------------------------------------------------------------------------

  it('should call onComplete on agent:complete', async () => {
    const onComplete = vi.fn();
    const events: SSEEvent[] = [
      { type: 'agent:started', data: { message: 'started' } },
      { type: 'agent:turn', data: { turnCount: 1 } },
      { type: 'agent:complete', data: { status: 'completed', turnCount: 5 } },
    ];

    const bridge = createBridge({ onComplete });
    await bridge.processStream(asyncIterableFromArray(events));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('completed', 5);
  });

  it('should call onComplete with turn_limit status', async () => {
    const onComplete = vi.fn();
    const events: SSEEvent[] = [
      { type: 'agent:complete', data: { status: 'turn_limit', turnCount: 50 } },
    ];

    const bridge = createBridge({ onComplete });
    await bridge.processStream(asyncIterableFromArray(events));

    expect(onComplete).toHaveBeenCalledWith('turn_limit', 50);
  });

  it('should call onComplete with cancelled status via agent:cancelled', async () => {
    const onComplete = vi.fn();
    const events: SSEEvent[] = [{ type: 'agent:cancelled', data: { turnCount: 3 } }];

    const bridge = createBridge({ onComplete });
    await bridge.processStream(asyncIterableFromArray(events));

    expect(onComplete).toHaveBeenCalledWith('cancelled', 3);
  });

  it('should call onComplete with fallback turnCount when turnCount is missing', async () => {
    const onComplete = vi.fn();
    const events: SSEEvent[] = [{ type: 'agent:complete', data: { status: 'completed' } }];

    const bridge = createBridge({ onComplete });
    await bridge.processStream(asyncIterableFromArray(events));

    // Callback still fires with fallback turnCount=0 to prevent stuck tasks
    expect(mockStreams.publish).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('completed', 0);
  });

  it('should call onComplete with fallback status when status is invalid', async () => {
    const onComplete = vi.fn();
    const events: SSEEvent[] = [
      { type: 'agent:complete', data: { status: 'unknown_status', turnCount: 5 } },
    ];

    const bridge = createBridge({ onComplete });
    await bridge.processStream(asyncIterableFromArray(events));

    // Falls back to 'completed' status to prevent stuck tasks
    expect(onComplete).toHaveBeenCalledWith('completed', 5);
  });

  // -------------------------------------------------------------------------
  // 7. Error callback
  // -------------------------------------------------------------------------

  it('should call onError on agent:error', async () => {
    const onError = vi.fn();
    const events: SSEEvent[] = [
      { type: 'agent:error', data: { error: 'Something went wrong', turnCount: 3 } },
    ];

    const bridge = createBridge({ onError });
    await bridge.processStream(asyncIterableFromArray(events));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('Something went wrong', 3);
  });

  it('should call onError with fallback values when error data is malformed', async () => {
    const onError = vi.fn();
    const events: SSEEvent[] = [{ type: 'agent:error', data: { error: 123, turnCount: 'bad' } }];

    const bridge = createBridge({ onError });
    await bridge.processStream(asyncIterableFromArray(events));

    // Callback fires with coerced values to prevent stuck tasks
    expect(mockStreams.publish).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('123', 0);
  });

  it('should not throw when onError is not provided', async () => {
    const events: SSEEvent[] = [{ type: 'agent:error', data: { error: 'fail', turnCount: 1 } }];

    const bridge = createBridge({ onError: undefined });
    await expect(bridge.processStream(asyncIterableFromArray(events))).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 8. Stream error handling
  // -------------------------------------------------------------------------

  it('should handle stream errors gracefully', async () => {
    const onError = vi.fn();
    const events: SSEEvent[] = [{ type: 'agent:started', data: { message: 'started' } }];

    const bridge = createBridge({ onError });
    await bridge.processStream(asyncIterableThatThrows(events, 'Network failure'));

    // The started event should have been published before the error
    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:started',
      expect.objectContaining({ taskId })
    );

    // Error event should also be published
    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:error',
      expect.objectContaining({
        error: 'Network failure',
        turnCount: 0,
        taskId,
        sessionId,
        projectId,
      })
    );

    // onError callback should be called
    expect(onError).toHaveBeenCalledWith('Network failure', 0);
  });

  it('should handle stream error when no events have been processed', async () => {
    const onError = vi.fn();

    async function* failImmediately(): AsyncIterable<SSEEvent> {
      throw new Error('Connection refused');
    }

    const bridge = createBridge({ onError });
    await bridge.processStream(failImmediately());

    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:error',
      expect.objectContaining({ error: 'Connection refused', turnCount: 0 })
    );
    expect(onError).toHaveBeenCalledWith('Connection refused', 0);
  });

  // -------------------------------------------------------------------------
  // 9. Invalid events skipped
  // -------------------------------------------------------------------------

  it('should skip events without type or data', async () => {
    const events: SSEEvent[] = [
      // Missing type
      { type: '', data: { message: 'no type' } },
      // Missing data (null coerced to empty-ish)
      { type: 'agent:started', data: null as unknown as Record<string, unknown> },
      // Valid event that should go through
      { type: 'agent:started', data: { message: 'valid' } },
    ];

    const bridge = createBridge();
    await bridge.processStream(asyncIterableFromArray(events));

    // Only the valid event should be published
    expect(mockStreams.publish).toHaveBeenCalledTimes(1);
    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:started',
      expect.objectContaining({ message: 'valid' })
    );
  });

  it('should skip events where data is not an object', async () => {
    const events: SSEEvent[] = [
      { type: 'agent:started', data: 'string' as unknown as Record<string, unknown> },
      { type: 'agent:started', data: { message: 'valid' } },
    ];

    const bridge = createBridge();
    await bridge.processStream(asyncIterableFromArray(events));

    expect(mockStreams.publish).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 10. Unknown event types skipped
  // -------------------------------------------------------------------------

  it('should skip unknown event types', async () => {
    const events: SSEEvent[] = [
      { type: 'agent:unknown_event', data: { message: 'unknown' } },
      { type: 'custom:event', data: { message: 'custom' } },
      { type: 'agent:started', data: { message: 'valid' } },
    ];

    const bridge = createBridge();
    await bridge.processStream(asyncIterableFromArray(events));

    // Only the valid agent:started should be published
    expect(mockStreams.publish).toHaveBeenCalledTimes(1);
    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:started',
      expect.objectContaining({ message: 'valid' })
    );
  });

  // -------------------------------------------------------------------------
  // 11. Event enrichment
  // -------------------------------------------------------------------------

  it('should enrich events with taskId, sessionId, and projectId', async () => {
    const events: SSEEvent[] = [{ type: 'agent:token', data: { delta: 'test' } }];

    const bridge = createBridge();
    await bridge.processStream(asyncIterableFromArray(events));

    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:token',
      expect.objectContaining({
        taskId: 'task-001',
        sessionId: 'session-001',
        projectId: 'proj-001',
        delta: 'test',
      })
    );
  });

  it('should not allow event data to overwrite bridge context keys', async () => {
    // Context keys (taskId, sessionId, projectId) are placed after the spread
    // so they always win over event data — prevents event data from misrouting
    const events: SSEEvent[] = [
      { type: 'agent:started', data: { taskId: 'malicious-task', extra: 'data' } },
    ];

    const bridge = createBridge();
    await bridge.processStream(asyncIterableFromArray(events));

    // Bridge context keys override event data to prevent misrouting
    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:started',
      expect.objectContaining({
        taskId: 'task-001', // bridge context wins
        sessionId: 'session-001',
        projectId: 'proj-001',
        extra: 'data',
      })
    );
  });

  // -------------------------------------------------------------------------
  // 12. Stop method
  // -------------------------------------------------------------------------

  it('should stop processing when stop() is called', async () => {
    const events: SSEEvent[] = [
      { type: 'agent:started', data: { message: 'started' } },
      { type: 'agent:turn', data: { turnCount: 1 } },
      { type: 'agent:turn', data: { turnCount: 2 } },
      { type: 'agent:turn', data: { turnCount: 3 } },
    ];

    const bridge = createBridge();

    // Use delayed stream so we can call stop() between events
    const stream = asyncIterableWithDelay(events, 20);

    const processPromise = bridge.processStream(stream);

    // Stop after a short delay (should stop before all events are processed)
    await new Promise((resolve) => setTimeout(resolve, 30));
    bridge.stop();

    await processPromise;

    // At most first 1-2 events processed (timing dependent, but less than all 4)
    expect(mockStreams.publish.mock.calls.length).toBeLessThan(4);
  });

  it('should not process stream when already stopped', async () => {
    const events: SSEEvent[] = [{ type: 'agent:started', data: { message: 'started' } }];

    const bridge = createBridge();
    bridge.stop();

    await bridge.processStream(asyncIterableFromArray(events));

    expect(mockStreams.publish).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('should handle publish errors gracefully (not throw)', async () => {
    mockStreams.publish.mockRejectedValueOnce(new Error('DurableStreams down'));

    const events: SSEEvent[] = [
      { type: 'agent:started', data: { message: 'started' } },
      { type: 'agent:turn', data: { turnCount: 1 } },
    ];

    const bridge = createBridge();
    // Should not throw even though publish fails for first event
    await expect(bridge.processStream(asyncIterableFromArray(events))).resolves.toBeUndefined();

    // Both events attempted
    expect(mockStreams.publish).toHaveBeenCalledTimes(2);
  });

  it('should handle empty event stream', async () => {
    async function* emptyStream(): AsyncIterable<SSEEvent> {
      // yield nothing
    }

    const bridge = createBridge();
    await bridge.processStream(emptyStream());

    expect(mockStreams.publish).not.toHaveBeenCalled();
  });

  it('should process agent:file_changed events', async () => {
    const events: SSEEvent[] = [
      { type: 'agent:file_changed', data: { path: 'src/index.ts', action: 'modified' } },
    ];

    const bridge = createBridge();
    await bridge.processStream(asyncIterableFromArray(events));

    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:file_changed',
      expect.objectContaining({
        path: 'src/index.ts',
        action: 'modified',
        taskId,
      })
    );
  });

  it('should process agent:tool:start and agent:tool:result events', async () => {
    const events: SSEEvent[] = [
      { type: 'agent:tool:start', data: { tool: 'Bash', input: 'ls' } },
      { type: 'agent:tool:result', data: { tool: 'Bash', output: 'file.ts' } },
    ];

    const bridge = createBridge();
    await bridge.processStream(asyncIterableFromArray(events));

    expect(mockStreams.publish).toHaveBeenCalledTimes(2);
    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:tool:start',
      expect.objectContaining({ tool: 'Bash', input: 'ls' })
    );
    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:tool:result',
      expect.objectContaining({ tool: 'Bash', output: 'file.ts' })
    );
  });

  it('should process agent:message events', async () => {
    const events: SSEEvent[] = [
      { type: 'agent:message', data: { content: 'Analyzing the codebase...' } },
    ];

    const bridge = createBridge();
    await bridge.processStream(asyncIterableFromArray(events));

    expect(mockStreams.publish).toHaveBeenCalledWith(
      sessionId,
      'container-agent:message',
      expect.objectContaining({ content: 'Analyzing the codebase...' })
    );
  });
});
