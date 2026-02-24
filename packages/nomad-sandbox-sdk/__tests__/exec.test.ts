import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecError, TimeoutError } from '../src/errors.js';
import type { NomadHttpClient } from '../src/http.js';
import { execInAllocation, execStreamInAllocation } from '../src/operations/exec.js';

// ----------------------------------------------------------------
// MockWebSocket
// ----------------------------------------------------------------
type WSCallback = (event: unknown) => void;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  url: string;
  onopen: WSCallback | null = null;
  onmessage: WSCallback | null = null;
  onerror: WSCallback | null = null;
  onclose: WSCallback | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    // Auto-connect asynchronously
    queueMicrotask(() => {
      if (this.onopen) this.onopen({});
    });
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code?: number): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose({ wasClean: true, code: code ?? 1000 });
    }
  }

  // Test helpers
  simulateMessage(data: string): void {
    if (this.onmessage) {
      this.onmessage({ data });
    }
  }

  simulateError(_message?: string): void {
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }

  simulateUncleanClose(code = 1006): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose({ wasClean: false, code });
    }
  }
}

// ----------------------------------------------------------------
// Mock HTTP client
// ----------------------------------------------------------------
function createMockHttpClient(opts?: { token?: string }): NomadHttpClient {
  return {
    wsBaseUrl: 'ws://localhost:4646',
    configuredToken: opts?.token,
    configuredNamespace: 'default',
  } as unknown as NomadHttpClient;
}

// Track created WebSocket instances
let wsInstances: MockWebSocket[] = [];

describe('exec operations', () => {
  beforeEach(() => {
    wsInstances = [];
    const MockWSConstructor = function (this: MockWebSocket, url: string) {
      const instance = new MockWebSocket(url);
      wsInstances.push(instance);
      return instance;
    } as unknown as typeof WebSocket;

    // Copy static properties
    Object.defineProperty(MockWSConstructor, 'CONNECTING', { value: 0 });
    Object.defineProperty(MockWSConstructor, 'OPEN', { value: 1 });
    Object.defineProperty(MockWSConstructor, 'CLOSING', { value: 2 });
    Object.defineProperty(MockWSConstructor, 'CLOSED', { value: 3 });

    vi.stubGlobal('WebSocket', MockWSConstructor);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // execInAllocation
  // ----------------------------------------------------------------
  describe('execInAllocation', () => {
    it('builds correct WebSocket URL with JSON-encoded command array', async () => {
      const http = createMockHttpClient({ token: 'my-token' });
      const promise = execInAllocation(http, {
        allocId: 'alloc-abc123',
        task: 'sandbox',
        command: ['/bin/sh', '-c', 'echo hello'],
      });

      // Wait for the WebSocket to be created
      await vi.waitFor(() => expect(wsInstances).toHaveLength(1));
      const ws = wsInstances[0];

      // Verify URL
      const url = new URL(ws.url);
      expect(url.pathname).toBe('/v1/client/allocation/alloc-abc123/exec');
      expect(url.searchParams.get('task')).toBe('sandbox');
      expect(url.searchParams.get('tty')).toBe('false');
      expect(url.searchParams.get('command')).toBe(JSON.stringify(['/bin/sh', '-c', 'echo hello']));
      expect(url.searchParams.get('X-Nomad-Token')).toBe('my-token');

      // Complete the exec
      ws.simulateMessage(JSON.stringify({ exited: true, result: { exit_code: 0 } }));

      const result = await promise;
      expect(result.exitCode).toBe(0);
    });

    it('collects stdout and stderr from base64 frames', async () => {
      const http = createMockHttpClient();
      const promise = execInAllocation(http, {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['echo', 'hello'],
      });

      await vi.waitFor(() => expect(wsInstances).toHaveLength(1));
      const ws = wsInstances[0];

      // Send stdout frame (base64 of "Hello ")
      ws.simulateMessage(
        JSON.stringify({ stdout: { data: Buffer.from('Hello ').toString('base64') } })
      );
      // Send stderr frame (base64 of "warning")
      ws.simulateMessage(
        JSON.stringify({ stderr: { data: Buffer.from('warning').toString('base64') } })
      );
      // Send more stdout (base64 of "World")
      ws.simulateMessage(
        JSON.stringify({ stdout: { data: Buffer.from('World').toString('base64') } })
      );
      // Exit
      ws.simulateMessage(JSON.stringify({ exited: true, result: { exit_code: 0 } }));

      const result = await promise;
      expect(result.stdout).toBe('Hello World');
      expect(result.stderr).toBe('warning');
      expect(result.exitCode).toBe(0);
    });

    it('returns exit code on exited frame', async () => {
      const http = createMockHttpClient();
      const promise = execInAllocation(http, {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['false'],
      });

      await vi.waitFor(() => expect(wsInstances).toHaveLength(1));
      const ws = wsInstances[0];

      ws.simulateMessage(JSON.stringify({ exited: true, result: { exit_code: 127 } }));

      const result = await promise;
      expect(result.exitCode).toBe(127);
    });

    it('rejects on WebSocket error', async () => {
      const http = createMockHttpClient();
      const promise = execInAllocation(http, {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['test'],
      });

      await vi.waitFor(() => expect(wsInstances).toHaveLength(1));
      const ws = wsInstances[0];

      ws.simulateError('connection failed');

      await expect(promise).rejects.toThrow(ExecError);
      await expect(promise).rejects.toThrow(/WebSocket error/);
    });

    it('rejects on unclean close', async () => {
      const http = createMockHttpClient();
      const promise = execInAllocation(http, {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['test'],
      });

      await vi.waitFor(() => expect(wsInstances).toHaveLength(1));
      const ws = wsInstances[0];

      ws.simulateUncleanClose(1006);

      await expect(promise).rejects.toThrow(ExecError);
      await expect(promise).rejects.toThrow(/code=1006/);
    });

    it('skips non-JSON heartbeat frames', async () => {
      const http = createMockHttpClient();
      const promise = execInAllocation(http, {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['echo', 'test'],
      });

      await vi.waitFor(() => expect(wsInstances).toHaveLength(1));
      const ws = wsInstances[0];

      // Heartbeat frames (non-JSON)
      ws.simulateMessage('heartbeat');
      ws.simulateMessage('ping');

      // Real data
      ws.simulateMessage(
        JSON.stringify({
          stdout: { data: Buffer.from('ok').toString('base64') },
        })
      );
      ws.simulateMessage(JSON.stringify({ exited: true, result: { exit_code: 0 } }));

      const result = await promise;
      expect(result.stdout).toBe('ok');
      expect(result.exitCode).toBe(0);
    });

    it('skips malformed JSON frames without rejecting', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const http = createMockHttpClient();
      const promise = execInAllocation(http, {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['echo', 'test'],
      });

      await vi.waitFor(() => expect(wsInstances).toHaveLength(1));
      const ws = wsInstances[0];

      // Malformed JSON that starts with { but is invalid
      ws.simulateMessage('{invalid json!!!');

      // Should have logged error
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[NomadSDK]'),
        expect.any(String)
      );

      // Still works with valid frames
      ws.simulateMessage(
        JSON.stringify({
          stdout: { data: Buffer.from('done').toString('base64') },
        })
      );
      ws.simulateMessage(JSON.stringify({ exited: true, result: { exit_code: 0 } }));

      const result = await promise;
      expect(result.stdout).toBe('done');
      expect(result.exitCode).toBe(0);

      consoleSpy.mockRestore();
    });

    it('sets tty=true in WebSocket URL when tty option is true', async () => {
      const http = createMockHttpClient();
      const promise = execInAllocation(http, {
        allocId: 'alloc-abc123',
        task: 'sandbox',
        command: ['/bin/sh'],
        tty: true,
      });

      await vi.waitFor(() => expect(wsInstances).toHaveLength(1));
      const ws = wsInstances[0];

      const url = new URL(ws.url);
      expect(url.searchParams.get('tty')).toBe('true');

      // Complete the exec
      ws.simulateMessage(JSON.stringify({ exited: true, result: { exit_code: 0 } }));
      await promise;
    });

    it('defaults exit code to 1 when not present in result', async () => {
      const http = createMockHttpClient();
      const promise = execInAllocation(http, {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['test'],
      });

      await vi.waitFor(() => expect(wsInstances).toHaveLength(1));
      const ws = wsInstances[0];

      ws.simulateMessage(JSON.stringify({ exited: true }));

      const result = await promise;
      expect(result.exitCode).toBe(1);
    });
  });

  // ----------------------------------------------------------------
  // execStreamInAllocation
  // ----------------------------------------------------------------
  describe('execStreamInAllocation', () => {
    it('returns stdout, stderr, stdin streams and wait/kill functions', async () => {
      const http = createMockHttpClient();
      const result = execStreamInAllocation(http, {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['bash'],
      });

      expect(result.stdout).toBeInstanceOf(ReadableStream);
      expect(result.stderr).toBeInstanceOf(ReadableStream);
      expect(result.stdin).toBeInstanceOf(WritableStream);
      expect(typeof result.wait).toBe('function');
      expect(typeof result.kill).toBe('function');
    });

    it('stdin writes are sent as base64 JSON frames', async () => {
      const http = createMockHttpClient();
      const stream = execStreamInAllocation(http, {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['bash'],
      });

      await vi.waitFor(() => expect(wsInstances).toHaveLength(1));
      const ws = wsInstances[0];

      // Write to stdin
      const writer = stream.stdin.getWriter();
      const chunk = new TextEncoder().encode('ls -la\n');
      await writer.write(chunk);

      expect(ws.sentMessages).toHaveLength(1);
      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent.stdin).toBeDefined();
      expect(sent.stdin.data).toBe(Buffer.from(chunk).toString('base64'));
    });

    it('kill closes WebSocket', async () => {
      const http = createMockHttpClient();
      const stream = execStreamInAllocation(http, {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['bash'],
      });

      await vi.waitFor(() => expect(wsInstances).toHaveLength(1));
      const ws = wsInstances[0];

      stream.kill();
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    });

    it('wait resolves with exit code when process exits', async () => {
      const http = createMockHttpClient();
      const stream = execStreamInAllocation(http, {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['echo', 'hi'],
      });

      await vi.waitFor(() => expect(wsInstances).toHaveLength(1));
      const ws = wsInstances[0];

      const waitPromise = stream.wait();

      ws.simulateMessage(JSON.stringify({ exited: true, result: { exit_code: 42 } }));

      const exitResult = await waitPromise;
      expect(exitResult.exitCode).toBe(42);
    });

    it('timeout rejects after specified ms', async () => {
      vi.useFakeTimers();

      const http = createMockHttpClient();
      const stream = execStreamInAllocation(http, {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['sleep', '999'],
        timeoutMs: 5000,
      });

      const waitPromise = stream.wait();

      // Advance past the timeout
      vi.advanceTimersByTime(5001);

      await expect(waitPromise).rejects.toThrow(TimeoutError);

      vi.useRealTimers();
    });

    it('stdout stream receives decoded data', async () => {
      const http = createMockHttpClient();
      const stream = execStreamInAllocation(http, {
        allocId: 'alloc-1',
        task: 'sandbox',
        command: ['echo', 'hello'],
      });

      await vi.waitFor(() => expect(wsInstances).toHaveLength(1));
      const ws = wsInstances[0];

      const reader = stream.stdout.getReader();

      // Send stdout frame
      ws.simulateMessage(
        JSON.stringify({
          stdout: { data: Buffer.from('hello world').toString('base64') },
        })
      );

      // Send exit
      ws.simulateMessage(JSON.stringify({ exited: true, result: { exit_code: 0 } }));

      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toBe('hello world');
    });
  });
});
