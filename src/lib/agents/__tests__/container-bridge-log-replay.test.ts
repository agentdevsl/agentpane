import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../logging/logger.js', () => ({
  createLogger: () => mockLogger,
}));

import { createContainerBridge, tryReplayAgentRunnerLogLine } from '../container-bridge.js';

describe('F10-05 — agent-runner log replay in container bridge', () => {
  beforeEach(() => {
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns true and replays a structured info log line via the host logger', () => {
    const line = JSON.stringify({
      channel: 'agent-runner-log',
      level: 'info',
      msg: 'started planning phase',
      ts: new Date().toISOString(),
      correlationId: 'req-abc',
      taskId: 't1',
      sessionId: 's1',
    });

    const handled = tryReplayAgentRunnerLogLine(line);

    expect(handled).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'started planning phase',
      expect.objectContaining({
        data: expect.objectContaining({
          correlationId: 'req-abc',
          taskId: 't1',
          sessionId: 's1',
        }),
      })
    );
  });

  it('routes warn and error lines to matching logger levels', () => {
    const warnLine = JSON.stringify({
      channel: 'agent-runner-log',
      level: 'warn',
      msg: 'credential file stale',
    });
    const errorLine = JSON.stringify({
      channel: 'agent-runner-log',
      level: 'error',
      msg: 'SDK crashed',
      correlationId: 'req-xyz',
    });

    expect(tryReplayAgentRunnerLogLine(warnLine)).toBe(true);
    expect(tryReplayAgentRunnerLogLine(errorLine)).toBe(true);

    expect(mockLogger.warn).toHaveBeenCalledWith('credential file stale', expect.any(Object));
    expect(mockLogger.error).toHaveBeenCalledWith(
      'SDK crashed',
      expect.objectContaining({ data: expect.objectContaining({ correlationId: 'req-xyz' }) })
    );
  });

  it('returns false and does not log for non-runner lines', () => {
    expect(tryReplayAgentRunnerLogLine('plain text not JSON')).toBe(false);
    expect(tryReplayAgentRunnerLogLine('{"type":"agent:error","data":{}}')).toBe(false);
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('rejects lines with an invalid level', () => {
    const line = JSON.stringify({
      channel: 'agent-runner-log',
      level: 'nuclear',
      msg: 'no-op',
    });
    expect(tryReplayAgentRunnerLogLine(line)).toBe(false);
  });

  it('processStderr dispatches log lines and keeps agent:error handling intact', async () => {
    // Mix log lines and an event line in a single stderr stream and verify
    // the bridge routes each correctly (log → host logger, event → onError).
    const onError = vi.fn();
    const streams = {
      publish: vi.fn().mockResolvedValue({ ok: true, value: 0 }),
    };
    const bridge = createContainerBridge({
      taskId: 't1',
      sessionId: 's1',
      codespaceId: 'c1',
      // biome-ignore lint/suspicious/noExplicitAny: partial mock is fine for this host-side test
      streams: streams as any,
      onError,
    });

    const logLine = JSON.stringify({
      channel: 'agent-runner-log',
      level: 'info',
      msg: 'heartbeat',
      correlationId: 'req-join',
    });
    const errorEvent = JSON.stringify({
      type: 'agent:error',
      timestamp: Date.now(),
      taskId: 't1',
      sessionId: 's1',
      data: { error: 'boom', turnCount: 3 },
    });

    const stream = Readable.from([`${logLine}\n${errorEvent}\n`]);
    bridge.processStderr(stream);

    // Wait a tick so the line handlers fire.
    await new Promise((r) => setTimeout(r, 10));

    expect(mockLogger.info).toHaveBeenCalledWith(
      'heartbeat',
      expect.objectContaining({ data: expect.objectContaining({ correlationId: 'req-join' }) })
    );
    expect(onError).toHaveBeenCalledWith('boom', 3);

    bridge.stop();
  });
});
