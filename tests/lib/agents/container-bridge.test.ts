// @vitest-environment node
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ContainerAgentEvent,
  type ContainerBridgeOptions,
  createContainerBridge,
  parseContainerEvent,
} from '../../../src/lib/agents/container-bridge';
import { flushPromises } from '../../helpers/async';

// =============================================================================
// Helpers
// =============================================================================

function createMockStreams() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  };
}

function createDefaultOptions(
  overrides: Partial<ContainerBridgeOptions> = {}
): ContainerBridgeOptions {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    codespaceId: 'project-1',
    streams: createMockStreams() as unknown as ContainerBridgeOptions['streams'],
    ...overrides,
  };
}

function createEvent(
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

function readableFromLines(lines: string[]): Readable {
  const stream = new Readable({
    read() {
      for (const line of lines) {
        this.push(`${line}\n`);
      }
      this.push(null);
    },
  });
  return stream;
}

// =============================================================================
// parseContainerEvent Tests
// =============================================================================

describe('parseContainerEvent', () => {
  it('parses a valid JSON event', () => {
    const event = createEvent('agent:token', { delta: 'hello' });
    const result = parseContainerEvent(JSON.stringify(event));

    expect(result).not.toBeNull();
    expect(result!.type).toBe('agent:token');
    expect(result!.data).toEqual({ delta: 'hello' });
  });

  it('returns null for empty string', () => {
    expect(parseContainerEvent('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseContainerEvent('   ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseContainerEvent('not json at all')).toBeNull();
  });

  it('returns null for malformed JSON (incomplete)', () => {
    expect(parseContainerEvent('{"type": "agent:token"')).toBeNull();
  });

  it('returns null when missing required fields', () => {
    const line = JSON.stringify({ type: 'agent:token', timestamp: Date.now() });
    expect(parseContainerEvent(line)).toBeNull();
  });

  it('returns null when missing taskId', () => {
    const line = JSON.stringify({
      type: 'agent:token',
      timestamp: Date.now(),
      sessionId: 'session-1',
    });
    expect(parseContainerEvent(line)).toBeNull();
  });

  it('returns null when missing sessionId', () => {
    const line = JSON.stringify({
      type: 'agent:token',
      timestamp: Date.now(),
      taskId: 'task-1',
    });
    expect(parseContainerEvent(line)).toBeNull();
  });

  it('defaults missing data to an empty object', () => {
    const line = JSON.stringify({
      type: 'agent:token',
      timestamp: Date.now(),
      taskId: 'task-1',
      sessionId: 'session-1',
    });

    const event = parseContainerEvent(line);
    expect(event).not.toBeNull();
    expect(event?.data).toEqual({});
  });

  it('defaults array data to an empty object', () => {
    const line = JSON.stringify({
      type: 'agent:token',
      timestamp: Date.now(),
      taskId: 'task-1',
      sessionId: 'session-1',
      data: [1, 2, 3],
    });

    const event = parseContainerEvent(line);
    expect(event).not.toBeNull();
    expect(event?.data).toEqual({});
  });

  it('preserves valid object data', () => {
    const line = JSON.stringify({
      type: 'agent:token',
      timestamp: Date.now(),
      taskId: 'task-1',
      sessionId: 'session-1',
      data: { delta: 'hello' },
    });

    const event = parseContainerEvent(line);
    expect(event?.data).toEqual({ delta: 'hello' });
  });
});

// =============================================================================
// createContainerBridge Tests
// =============================================================================

describe('createContainerBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('processStream', () => {
    it('processes valid JSON lines and publishes events', async () => {
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
        })
      );

      const event = createEvent('agent:token', { delta: 'hi' });
      const stream = readableFromLines([JSON.stringify(event)]);

      await bridge.processStream(stream);

      expect(mockStreams.publish).toHaveBeenCalledWith(
        'session-1',
        'container-agent:token',
        expect.objectContaining({ delta: 'hi' })
      );
    });

    it('skips non-JSON lines without error', async () => {
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
        })
      );

      const event = createEvent('agent:token', { delta: 'valid' });
      const stream = readableFromLines([
        'some regular log output',
        JSON.stringify(event),
        'another log line',
      ]);

      await bridge.processStream(stream);

      expect(mockStreams.publish).toHaveBeenCalledTimes(1);
    });

    it('skips events with mismatched taskId', async () => {
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
        })
      );

      const event = createEvent('agent:token', { delta: 'x' }, { taskId: 'other-task' });
      const stream = readableFromLines([JSON.stringify(event)]);

      await bridge.processStream(stream);

      expect(mockStreams.publish).not.toHaveBeenCalled();
    });

    it('skips events with mismatched sessionId', async () => {
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
        })
      );

      const event = createEvent('agent:token', { delta: 'x' }, { sessionId: 'other-session' });
      const stream = readableFromLines([JSON.stringify(event)]);

      await bridge.processStream(stream);

      expect(mockStreams.publish).not.toHaveBeenCalled();
    });

    it('calls onComplete callback for agent:complete events', async () => {
      const onComplete = vi.fn();
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
          onComplete,
        })
      );

      const event = createEvent('agent:complete', {
        status: 'completed',
        turnCount: 5,
      });
      const stream = readableFromLines([JSON.stringify(event)]);

      await bridge.processStream(stream);

      expect(onComplete).toHaveBeenCalledWith('completed', 5);
    });

    it('calls onComplete with turn_limit status', async () => {
      const onComplete = vi.fn();
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
          onComplete,
        })
      );

      const event = createEvent('agent:complete', {
        status: 'turn_limit',
        turnCount: 50,
      });
      const stream = readableFromLines([JSON.stringify(event)]);

      await bridge.processStream(stream);

      expect(onComplete).toHaveBeenCalledWith('turn_limit', 50);
    });

    it('does not call onComplete for invalid completion data', async () => {
      const onComplete = vi.fn();
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
          onComplete,
        })
      );

      const event = createEvent('agent:complete', {
        status: 'completed',
        // missing turnCount
      });
      const stream = readableFromLines([JSON.stringify(event)]);

      await bridge.processStream(stream);

      expect(onComplete).not.toHaveBeenCalled();
    });

    it('calls onError callback for agent:error events', async () => {
      const onError = vi.fn();
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
          onError,
        })
      );

      const event = createEvent('agent:error', {
        error: 'Something went wrong',
        turnCount: 3,
      });
      const stream = readableFromLines([JSON.stringify(event)]);

      await bridge.processStream(stream);

      expect(onError).toHaveBeenCalledWith('Something went wrong', 3);
    });

    it('does not call onError for invalid error data', async () => {
      const onError = vi.fn();
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
          onError,
        })
      );

      const event = createEvent('agent:error', {
        // missing error string and turnCount
      });
      const stream = readableFromLines([JSON.stringify(event)]);

      await bridge.processStream(stream);

      expect(onError).not.toHaveBeenCalled();
    });

    it('calls onComplete with cancelled status for agent:cancelled events', async () => {
      const onComplete = vi.fn();
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
          onComplete,
        })
      );

      const event = createEvent('agent:cancelled', { turnCount: 7 });
      const stream = readableFromLines([JSON.stringify(event)]);

      await bridge.processStream(stream);

      expect(onComplete).toHaveBeenCalledWith('cancelled', 7);
    });

    it('does not call onComplete for invalid cancelled data', async () => {
      const onComplete = vi.fn();
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
          onComplete,
        })
      );

      const event = createEvent('agent:cancelled', {
        // missing turnCount
      });
      const stream = readableFromLines([JSON.stringify(event)]);

      await bridge.processStream(stream);

      expect(onComplete).not.toHaveBeenCalled();
    });

    it('calls onPlanReady for agent:plan_ready events', async () => {
      const onPlanReady = vi.fn();
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
          onPlanReady,
        })
      );

      const event = createEvent('agent:plan_ready', {
        plan: 'Step 1: analyze\nStep 2: implement',
        turnCount: 4,
        sdkSessionId: 'sdk-123',
      });
      const stream = readableFromLines([JSON.stringify(event)]);

      await bridge.processStream(stream);

      expect(onPlanReady).toHaveBeenCalledWith(
        expect.objectContaining({
          plan: 'Step 1: analyze\nStep 2: implement',
          turnCount: 4,
          sdkSessionId: 'sdk-123',
        })
      );
    });

    it('does not call onPlanReady for invalid plan data', async () => {
      const onPlanReady = vi.fn();
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
          onPlanReady,
        })
      );

      const event = createEvent('agent:plan_ready', {
        // missing plan string
        turnCount: 4,
      });
      const stream = readableFromLines([JSON.stringify(event)]);

      await bridge.processStream(stream);

      expect(onPlanReady).not.toHaveBeenCalled();
    });

    it('handles empty stream without errors', async () => {
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
        })
      );

      const stream = readableFromLines([]);
      await bridge.processStream(stream);

      expect(mockStreams.publish).not.toHaveBeenCalled();
    });

    it('handles publish errors gracefully', async () => {
      const mockStreams = createMockStreams();
      mockStreams.publish.mockRejectedValueOnce(new Error('Publish failed'));
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
        })
      );

      const event = createEvent('agent:token', { delta: 'hi' });
      const stream = readableFromLines([JSON.stringify(event)]);

      // Should not throw
      await bridge.processStream(stream);
    });

    it('processes multiple events in sequence', async () => {
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
        })
      );

      const events = [
        createEvent('agent:started', { model: 'claude-sonnet-4-6', maxTurns: 50 }),
        createEvent('agent:token', { delta: 'Hello' }),
        createEvent('agent:turn', { turn: 1, maxTurns: 50, remaining: 49 }),
        createEvent('agent:token', { delta: ' World' }),
      ];

      const stream = readableFromLines(events.map((e) => JSON.stringify(e)));
      await bridge.processStream(stream);

      expect(mockStreams.publish).toHaveBeenCalledTimes(4);
    });

    it('does not process if bridge is stopped', async () => {
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
        })
      );

      bridge.stop();

      const event = createEvent('agent:token', { delta: 'hi' });
      const stream = readableFromLines([JSON.stringify(event)]);

      await bridge.processStream(stream);

      expect(mockStreams.publish).not.toHaveBeenCalled();
    });
  });

  describe('processStderr', () => {
    it('captures JSON error events from stderr', async () => {
      const onError = vi.fn();
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
          onError,
        })
      );

      const errorEvent = createEvent('agent:error', {
        error: 'Fatal crash',
        turnCount: 2,
      });

      const stream = new Readable({
        read() {
          this.push(`${JSON.stringify(errorEvent)}\n`);
          this.push(null);
        },
      });

      bridge.processStderr(stream);

      // Wait for async line processing
      await flushPromises();

      expect(onError).toHaveBeenCalledWith('Fatal crash', 2);
    });

    it('ignores non-JSON stderr lines', async () => {
      const onError = vi.fn();
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
          onError,
        })
      );

      const stream = new Readable({
        read() {
          this.push('Warning: something happened\n');
          this.push('Error: not a JSON line\n');
          this.push(null);
        },
      });

      bridge.processStderr(stream);

      await flushPromises();

      expect(onError).not.toHaveBeenCalled();
    });

    it('ignores error events with mismatched taskId on stderr', async () => {
      const onError = vi.fn();
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
          onError,
        })
      );

      const errorEvent = createEvent(
        'agent:error',
        { error: 'crash', turnCount: 1 },
        {
          taskId: 'wrong-task',
        }
      );

      const stream = new Readable({
        read() {
          this.push(`${JSON.stringify(errorEvent)}\n`);
          this.push(null);
        },
      });

      bridge.processStderr(stream);

      await flushPromises();

      expect(onError).not.toHaveBeenCalled();
    });

    it('does not process stderr if bridge is stopped', async () => {
      const onError = vi.fn();
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
          onError,
        })
      );

      bridge.stop();

      const errorEvent = createEvent('agent:error', { error: 'crash', turnCount: 1 });
      const stream = new Readable({
        read() {
          this.push(`${JSON.stringify(errorEvent)}\n`);
          this.push(null);
        },
      });

      bridge.processStderr(stream);

      await flushPromises();

      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('prevents further stream processing', async () => {
      const mockStreams = createMockStreams();
      const bridge = createContainerBridge(
        createDefaultOptions({
          streams: mockStreams as unknown as ContainerBridgeOptions['streams'],
        })
      );

      bridge.stop();

      const event = createEvent('agent:token', { delta: 'hi' });
      const stream = readableFromLines([JSON.stringify(event)]);
      await bridge.processStream(stream);

      expect(mockStreams.publish).not.toHaveBeenCalled();
    });

    it('can be called multiple times safely', () => {
      const bridge = createContainerBridge(createDefaultOptions());

      expect(() => {
        bridge.stop();
        bridge.stop();
        bridge.stop();
      }).not.toThrow();
    });
  });
});
