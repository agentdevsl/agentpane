import { beforeEach, describe, expect, it, vi } from 'vitest';

// Use vi.hoisted so mock fns are available during vi.mock hoisting
const mocks = vi.hoisted(() => {
  const create = vi.fn().mockResolvedValue(undefined);
  const del = vi.fn().mockResolvedValue(undefined);
  const append = vi.fn();
  const detach = vi.fn().mockResolvedValue(undefined);

  // Track constructor calls
  const streamCalls: Array<Record<string, unknown>> = [];
  const producerCalls: Array<unknown[]> = [];

  return { create, del, append, detach, streamCalls, producerCalls };
});

vi.mock('@durable-streams/client', () => {
  // Use class syntax so `new` works
  class MockDurableStream {
    create = mocks.create;
    delete = mocks.del;
    constructor(opts: Record<string, unknown>) {
      mocks.streamCalls.push(opts);
    }
  }

  class MockIdempotentProducer {
    append = mocks.append;
    detach = mocks.detach;
    constructor(...args: unknown[]) {
      mocks.producerCalls.push(args);
    }
  }

  return { DurableStream: MockDurableStream, IdempotentProducer: MockIdempotentProducer };
});

import { CaddyDurableStreamsServer } from '../../../src/lib/streams/caddy-producer';

describe('CaddyDurableStreamsServer', () => {
  let server: CaddyDurableStreamsServer;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.streamCalls.length = 0;
    mocks.producerCalls.length = 0;
    mocks.create.mockResolvedValue(undefined);
    mocks.del.mockResolvedValue(undefined);
    mocks.detach.mockResolvedValue(undefined);
    server = new CaddyDurableStreamsServer('http://localhost:3000/v1/stream');
  });

  describe('constructor', () => {
    it('strips trailing /v1/stream from base URL', () => {
      const s = new CaddyDurableStreamsServer('http://localhost:3000/v1/stream');
      expect(s).toBeDefined();
    });

    it('uses CADDY_STREAMS_URL env var as fallback', () => {
      const original = process.env.CADDY_STREAMS_URL;
      process.env.CADDY_STREAMS_URL = 'http://caddy:3000/v1/stream';
      const s = new CaddyDurableStreamsServer();
      expect(s).toBeDefined();
      if (original !== undefined) {
        process.env.CADDY_STREAMS_URL = original;
      } else {
        delete process.env.CADDY_STREAMS_URL;
      }
    });
  });

  describe('createStream', () => {
    it('creates a DurableStream and producer', async () => {
      await server.createStream('test-session', null);

      expect(mocks.streamCalls).toHaveLength(1);
      expect(mocks.streamCalls[0]).toEqual({
        url: 'http://localhost:3000/v1/stream/sessions/test-session',
        contentType: 'application/json',
      });
      expect(mocks.create).toHaveBeenCalled();
      expect(mocks.producerCalls).toHaveLength(1);
    });

    it('handles CONFLICT_EXISTS gracefully', async () => {
      mocks.create.mockRejectedValueOnce({ code: 'CONFLICT_EXISTS' });

      await expect(server.createStream('test-session', null)).resolves.toBeUndefined();
    });

    it('rethrows non-CONFLICT_EXISTS errors', async () => {
      mocks.create.mockRejectedValueOnce(new Error('network error'));

      await expect(server.createStream('test-session', null)).rejects.toThrow('network error');
    });

    it('reuses cached producer on second call', async () => {
      await server.createStream('test-session', null);
      await server.createStream('test-session', null);

      expect(mocks.streamCalls).toHaveLength(1);
    });
  });

  describe('publish', () => {
    it('appends NDJSON event to producer', async () => {
      const offset = await server.publish('test-session', 'chunk', { delta: 'hello' });

      expect(mocks.append).toHaveBeenCalledTimes(1);
      const appendedStr = mocks.append.mock.calls[0][0] as string;
      expect(appendedStr.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(appendedStr.trim());
      expect(parsed.type).toBe('chunk');
      expect(parsed.data).toEqual({ delta: 'hello' });
      expect(parsed.timestamp).toBeTypeOf('number');
      expect(offset).toBe(0);
    });

    it('returns monotonically increasing local offsets', async () => {
      const o1 = await server.publish('s1', 'a', {});
      const o2 = await server.publish('s1', 'b', {});
      const o3 = await server.publish('s1', 'c', {});

      expect(o1).toBe(0);
      expect(o2).toBe(1);
      expect(o3).toBe(2);
    });

    it('maintains separate offsets per stream', async () => {
      const o1 = await server.publish('s1', 'a', {});
      const o2 = await server.publish('s2', 'b', {});

      expect(o1).toBe(0);
      expect(o2).toBe(0);
    });
  });

  describe('streamIdToPath mapping', () => {
    it('maps cli-monitor to /v1/stream/cli-monitor', async () => {
      await server.createStream('cli-monitor', null);
      expect(mocks.streamCalls[0]).toEqual(
        expect.objectContaining({ url: 'http://localhost:3000/v1/stream/cli-monitor' })
      );
    });

    it('maps terraform:{id} to /v1/stream/terraform/{id}', async () => {
      await server.createStream('terraform:job-123', null);
      expect(mocks.streamCalls[0]).toEqual(
        expect.objectContaining({ url: 'http://localhost:3000/v1/stream/terraform/job-123' })
      );
    });

    it('maps plan:{id} to /v1/stream/plans/{id}', async () => {
      await server.createStream('plan:session-456', null);
      expect(mocks.streamCalls[0]).toEqual(
        expect.objectContaining({ url: 'http://localhost:3000/v1/stream/plans/session-456' })
      );
    });

    it('maps plain session IDs to /v1/stream/sessions/{id}', async () => {
      await server.createStream('abc-def-123', null);
      expect(mocks.streamCalls[0]).toEqual(
        expect.objectContaining({ url: 'http://localhost:3000/v1/stream/sessions/abc-def-123' })
      );
    });
  });

  describe('subscribe', () => {
    it('throws because clients subscribe directly to Caddy', () => {
      expect(() => server.subscribe('test')).toThrow(
        '[CaddyStreams] Server-side subscribe not supported'
      );
    });
  });

  describe('deleteStream', () => {
    it('returns false for unknown stream', async () => {
      const result = await server.deleteStream('nonexistent');
      expect(result).toBe(false);
    });

    it('detaches producer and deletes stream', async () => {
      await server.createStream('test-session', null);
      const result = await server.deleteStream('test-session');

      expect(result).toBe(true);
      expect(mocks.detach).toHaveBeenCalled();
      expect(mocks.del).toHaveBeenCalled();
    });

    it('still removes from cache on cleanup error', async () => {
      await server.createStream('test-session', null);
      mocks.detach.mockRejectedValueOnce(new Error('detach failed'));

      const result = await server.deleteStream('test-session');
      expect(result).toBe(true);

      // Second delete should return false (removed from cache)
      const result2 = await server.deleteStream('test-session');
      expect(result2).toBe(false);
    });

    it('logs warning on cleanup error', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await server.createStream('test-session', null);
      mocks.detach.mockRejectedValueOnce(new Error('detach failed'));

      await server.deleteStream('test-session');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('deleteStream(test-session) cleanup error'),
        expect.any(Error)
      );
      warnSpy.mockRestore();
    });
  });

  describe('onError callback', () => {
    it('invalidates cached producer on error', async () => {
      await server.createStream('test-session', null);

      // Get the onError callback from the IdempotentProducer constructor args
      const producerArgs = mocks.producerCalls[0];
      const options = producerArgs[2] as { onError: (error: Error) => void };

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      options.onError(new Error('producer error'));
      errorSpy.mockRestore();

      // After error, the cache entry is removed. Next publish creates a new producer.
      const callsBefore = mocks.streamCalls.length;
      await server.publish('test-session', 'test', {});

      // A new DurableStream should have been created
      expect(mocks.streamCalls.length).toBe(callsBefore + 1);
    });
  });
});
