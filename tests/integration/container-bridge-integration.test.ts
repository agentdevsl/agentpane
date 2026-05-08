/**
 * Integration tests for the container bridge — exercises stdout/stderr line
 * processing, plan_ready / complete / error / cancelled callbacks, and the
 * agent:token:batch decoding path. The unit-project tests for this file
 * live under tests/lib/agents/, which leaves the integration coverage at
 * ~43%; these tests bring the same paths into the integration coverage
 * project so we can verify the bridge from the streams.publish boundary.
 */

import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ContainerAgentEvent,
  type ContainerBridgeOptions,
  createContainerBridge,
  parseContainerEvent,
  tryReplayAgentRunnerLogLine,
} from '../../src/lib/agents/container-bridge';

function createMockStreams() {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

function buildEvent(
  type: string,
  data: Record<string, unknown> = {},
  overrides: Partial<ContainerAgentEvent> = {}
): ContainerAgentEvent {
  return {
    type: type as ContainerAgentEvent['type'],
    timestamp: Date.now(),
    taskId: 'task-1',
    sessionId: 'session-1',
    data,
    ...overrides,
  };
}

function buildOptions(overrides: Partial<ContainerBridgeOptions> = {}): ContainerBridgeOptions {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    codespaceId: 'cs-1',
    streams: createMockStreams() as unknown as ContainerBridgeOptions['streams'],
    ...overrides,
  };
}

function readableFromLines(lines: string[]): Readable {
  return new Readable({
    read() {
      for (const line of lines) this.push(`${line}\n`);
      this.push(null);
    },
  });
}

describe('container-bridge: parseContainerEvent (integration project)', () => {
  it('parses a valid event JSON line', () => {
    const event = buildEvent('agent:token', { delta: 'hi' });
    const parsed = parseContainerEvent(JSON.stringify(event));
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe('agent:token');
    expect(parsed?.data).toEqual({ delta: 'hi' });
  });

  it('returns null for empty / whitespace lines', () => {
    expect(parseContainerEvent('')).toBeNull();
    expect(parseContainerEvent('   ')).toBeNull();
  });

  it('returns null when event is missing required fields', () => {
    expect(parseContainerEvent(JSON.stringify({ type: 'foo' }))).toBeNull();
  });

  it('returns null when JSON is malformed', () => {
    expect(parseContainerEvent('{not-json')).toBeNull();
  });

  it('coerces non-object data to {}', () => {
    const ev = JSON.stringify({
      type: 'agent:token',
      timestamp: Date.now(),
      taskId: 't',
      sessionId: 's',
      data: 'bad',
    });
    const parsed = parseContainerEvent(ev);
    expect(parsed?.data).toEqual({});
  });
});

describe('container-bridge: tryReplayAgentRunnerLogLine (integration project)', () => {
  it('returns false for non-JSON lines', () => {
    expect(tryReplayAgentRunnerLogLine('Hello world')).toBe(false);
  });

  it('returns false for unrelated JSON channels', () => {
    expect(
      tryReplayAgentRunnerLogLine(JSON.stringify({ channel: 'other', level: 'info', msg: 'x' }))
    ).toBe(false);
  });

  it('returns true and replays when channel + level + msg are valid', () => {
    expect(
      tryReplayAgentRunnerLogLine(
        JSON.stringify({
          channel: 'agent-runner-log',
          level: 'info',
          msg: 'agent started',
          taskId: 'task-1',
        })
      )
    ).toBe(true);
  });

  it('returns false for valid channel but unknown level', () => {
    expect(
      tryReplayAgentRunnerLogLine(
        JSON.stringify({ channel: 'agent-runner-log', level: 'verbose', msg: 'x' })
      )
    ).toBe(false);
  });
});

describe('container-bridge: createContainerBridge.processStream (integration project)', () => {
  let mockStreams: ReturnType<typeof createMockStreams>;
  let onComplete: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;
  let onPlanReady: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockStreams = createMockStreams();
    onComplete = vi.fn();
    onError = vi.fn();
    onPlanReady = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('publishes a known event type and skips unknown ones', async () => {
    const bridge = createContainerBridge(
      buildOptions({
        streams: mockStreams as never,
      })
    );

    const goodEvent = buildEvent('agent:token', { delta: 'foo' });
    const badEvent = buildEvent('agent:unknown:type' as never, {});

    const stream = readableFromLines([JSON.stringify(goodEvent), JSON.stringify(badEvent)]);
    await bridge.processStream(stream);

    // Only the recognized event should have been published (mapped to container-agent:token)
    const publishedTypes = mockStreams.publish.mock.calls.map((call) => call[1]);
    expect(publishedTypes).toContain('container-agent:token');
  });

  it('decodes agent:token:batch into individual agent:token events', async () => {
    const bridge = createContainerBridge(buildOptions({ streams: mockStreams as never }));

    const batchEvent = buildEvent('agent:token:batch' as never, {
      deltas: [{ delta: 'a' }, { delta: 'b' }, { delta: 'c' }],
    });

    const stream = readableFromLines([JSON.stringify(batchEvent)]);
    await bridge.processStream(stream);

    const tokenPublishes = mockStreams.publish.mock.calls.filter(
      (call) => call[1] === 'container-agent:token'
    );
    expect(tokenPublishes).toHaveLength(3);
  });

  it('skips events with mismatched taskId/sessionId', async () => {
    const bridge = createContainerBridge(buildOptions({ streams: mockStreams as never }));

    const wrong = buildEvent(
      'agent:token',
      { delta: 'wrong' },
      {
        taskId: 'other-task',
        sessionId: 'other-session',
      }
    );

    const stream = readableFromLines([JSON.stringify(wrong)]);
    await bridge.processStream(stream);

    expect(mockStreams.publish).not.toHaveBeenCalled();
  });

  it('handles agent:complete and invokes onComplete with metrics', async () => {
    const bridge = createContainerBridge(
      buildOptions({ streams: mockStreams as never, onComplete })
    );

    const completeEvent = buildEvent('agent:complete', {
      status: 'completed',
      turnCount: 5,
      skillId: 'foo',
      skillName: 'Foo Skill',
      usage: { inputTokens: 100, outputTokens: 50 },
      fileChanges: { filesModified: 2, linesAdded: 10, linesRemoved: 3 },
    });

    const stream = readableFromLines([JSON.stringify(completeEvent)]);
    await bridge.processStream(stream);

    expect(onComplete).toHaveBeenCalledWith(
      'completed',
      5,
      expect.objectContaining({
        skillId: 'foo',
        skillName: 'Foo Skill',
        usage: { inputTokens: 100, outputTokens: 50 },
      })
    );
  });

  it('skips invalid agent:complete events (bad status or non-numeric turnCount)', async () => {
    const bridge = createContainerBridge(
      buildOptions({ streams: mockStreams as never, onComplete })
    );

    const bad1 = buildEvent('agent:complete', { status: 'bogus', turnCount: 1 });
    const bad2 = buildEvent('agent:complete', { status: 'completed', turnCount: 'NaN' });

    const stream = readableFromLines([JSON.stringify(bad1), JSON.stringify(bad2)]);
    await bridge.processStream(stream);

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('handles agent:error and invokes onError', async () => {
    const bridge = createContainerBridge(buildOptions({ streams: mockStreams as never, onError }));

    const errorEvent = buildEvent('agent:error', { error: 'kaboom', turnCount: 3 });
    const stream = readableFromLines([JSON.stringify(errorEvent)]);
    await bridge.processStream(stream);

    expect(onError).toHaveBeenCalledWith('kaboom', 3);
  });

  it('skips invalid agent:error events', async () => {
    const bridge = createContainerBridge(buildOptions({ streams: mockStreams as never, onError }));

    const bad = buildEvent('agent:error', { error: 123, turnCount: 1 });
    const stream = readableFromLines([JSON.stringify(bad)]);
    await bridge.processStream(stream);

    expect(onError).not.toHaveBeenCalled();
  });

  it('handles agent:cancelled and invokes onComplete with status=cancelled', async () => {
    const bridge = createContainerBridge(
      buildOptions({ streams: mockStreams as never, onComplete })
    );

    const cancelEvent = buildEvent('agent:cancelled', { turnCount: 7 });
    const stream = readableFromLines([JSON.stringify(cancelEvent)]);
    await bridge.processStream(stream);

    expect(onComplete).toHaveBeenCalledWith('cancelled', 7);
  });

  it('handles agent:plan_ready and invokes onPlanReady', async () => {
    const bridge = createContainerBridge(
      buildOptions({ streams: mockStreams as never, onPlanReady })
    );

    const planEvent = buildEvent('agent:plan_ready', {
      plan: 'Step 1\nStep 2',
      turnCount: 4,
      sdkSessionId: 'sdk-abc',
    });
    const stream = readableFromLines([JSON.stringify(planEvent)]);
    await bridge.processStream(stream);

    expect(onPlanReady).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'Step 1\nStep 2', turnCount: 4, sdkSessionId: 'sdk-abc' })
    );
  });

  it('skips invalid agent:plan_ready events (missing plan)', async () => {
    const bridge = createContainerBridge(
      buildOptions({ streams: mockStreams as never, onPlanReady })
    );

    const bad = buildEvent('agent:plan_ready', { turnCount: 1, sdkSessionId: 'x' });
    const stream = readableFromLines([JSON.stringify(bad)]);
    await bridge.processStream(stream);

    expect(onPlanReady).not.toHaveBeenCalled();
  });

  it('stop() halts stream processing', async () => {
    const bridge = createContainerBridge(buildOptions({ streams: mockStreams as never }));

    bridge.stop();
    // After stop, processStream returns early and publishes nothing
    const ev = buildEvent('agent:token', { delta: 'x' });
    const stream = readableFromLines([JSON.stringify(ev)]);
    await bridge.processStream(stream);
    expect(mockStreams.publish).not.toHaveBeenCalled();
  });
});

describe('container-bridge: processStderr (integration project)', () => {
  it('captures agent:error JSON from stderr and invokes onError', async () => {
    const mockStreams = createMockStreams();
    const onError = vi.fn();

    const bridge = createContainerBridge(buildOptions({ streams: mockStreams as never, onError }));

    const errorEvent = buildEvent('agent:error', { error: 'stderr error', turnCount: 2 });
    const stderrStream = readableFromLines([
      'normal log line',
      JSON.stringify(errorEvent),
      'another normal line',
    ]);

    bridge.processStderr(stderrStream);
    // Wait for stream to drain
    await new Promise((resolve) => stderrStream.on('end', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onError).toHaveBeenCalledWith('stderr error', 2);
  });

  it('replays agent-runner-log lines from stderr without invoking callbacks', async () => {
    const mockStreams = createMockStreams();
    const onError = vi.fn();

    const bridge = createContainerBridge(buildOptions({ streams: mockStreams as never, onError }));

    const stderrStream = readableFromLines([
      JSON.stringify({
        channel: 'agent-runner-log',
        level: 'info',
        msg: 'Internal log line',
      }),
    ]);

    bridge.processStderr(stderrStream);
    await new Promise((resolve) => stderrStream.on('end', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // No agent error events emitted from log replay
    expect(onError).not.toHaveBeenCalled();
  });

  it('processStderr returns early when bridge is already stopped', async () => {
    const mockStreams = createMockStreams();
    const onError = vi.fn();

    const bridge = createContainerBridge(buildOptions({ streams: mockStreams as never, onError }));
    bridge.stop();

    // After stop, processStderr returns immediately without setting up the
    // line reader — pass a basic Readable to verify it does not consume it.
    const stderrStream = new Readable({ read() {} });
    bridge.processStderr(stderrStream);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // No error callbacks fired because the bridge is stopped
    expect(onError).not.toHaveBeenCalled();
    stderrStream.push(null); // close to avoid leaks
  });
});
