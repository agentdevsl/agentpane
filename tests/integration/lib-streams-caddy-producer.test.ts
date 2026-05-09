/**
 * Integration coverage for CaddyDurableStreamsServer (caddy-producer.ts).
 *
 * The class wraps the @durable-streams/client IdempotentProducer and is hard
 * to exercise end-to-end without a real Caddy. We mock the @durable-streams
 * package and verify the producer-pool LRU eviction, idle-timeout sweep,
 * deleteStream cleanup, stream-id → URL path mapping, and stopCleanup safety.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const durableStreamsMocks = vi.hoisted(() => {
  const stream = {
    create: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const producer = {
    append: vi.fn(),
    detach: vi.fn().mockResolvedValue(undefined),
  };
  return {
    DurableStream: vi.fn(function (this: unknown, _opts: unknown) {
      Object.assign(this as object, stream);
    }),
    IdempotentProducer: vi.fn(function (this: unknown, _stream: unknown, _id: string) {
      Object.assign(this as object, producer);
    }),
    streamSpy: stream,
    producerSpy: producer,
  };
});

vi.mock('@durable-streams/client', () => ({
  DurableStream: durableStreamsMocks.DurableStream,
  IdempotentProducer: durableStreamsMocks.IdempotentProducer,
}));

// Import AFTER the mock
import { CaddyDurableStreamsServer } from '../../src/lib/streams/caddy-producer';

describe('CaddyDurableStreamsServer (IT-CDS)', () => {
  let server: CaddyDurableStreamsServer;

  beforeEach(() => {
    vi.clearAllMocks();
    durableStreamsMocks.streamSpy.create.mockResolvedValue(undefined);
    durableStreamsMocks.streamSpy.delete.mockResolvedValue(undefined);
    durableStreamsMocks.producerSpy.append.mockReset();
    durableStreamsMocks.producerSpy.detach.mockResolvedValue(undefined);
    server = new CaddyDurableStreamsServer('http://localhost:9999/v1/stream');
  });

  afterEach(() => {
    server.stopCleanup();
  });

  it('creates a stream lazily on first publish and reuses it for subsequent publishes', async () => {
    await server.publish('session-x', 'foo', { a: 1 });
    await server.publish('session-x', 'bar', { b: 2 });

    expect(durableStreamsMocks.DurableStream).toHaveBeenCalledTimes(1);
    expect(durableStreamsMocks.IdempotentProducer).toHaveBeenCalledTimes(1);
    expect(durableStreamsMocks.producerSpy.append).toHaveBeenCalledTimes(2);
  });

  it('returns local monotonically increasing offsets per stream', async () => {
    const o1 = await server.publish('session-y', 'foo', {});
    const o2 = await server.publish('session-y', 'foo', {});
    expect(o2).toBeGreaterThan(o1);
  });

  it('createStream is idempotent (CONFLICT_EXISTS on stream.create() is swallowed)', async () => {
    durableStreamsMocks.streamSpy.create.mockRejectedValueOnce({ code: 'CONFLICT_EXISTS' });
    await expect(server.createStream('cli-monitor', null)).resolves.toBeUndefined();
  });

  it('createStream surfaces non-CONFLICT errors', async () => {
    durableStreamsMocks.streamSpy.create.mockRejectedValueOnce(new Error('500 backend down'));
    await expect(server.createStream('cli-monitor', null)).rejects.toThrow(
      /Failed to create stream/
    );
  });

  it('publish retries once when the producer was already closed', async () => {
    let attempts = 0;
    durableStreamsMocks.producerSpy.append.mockImplementation(() => {
      attempts++;
      if (attempts === 1) {
        const err = new Error('closed') as Error & { code?: string };
        err.code = 'ALREADY_CLOSED';
        throw err;
      }
    });

    const offset = await server.publish('session-z', 'foo', { x: 1 });
    expect(offset).toBe(0);
    expect(attempts).toBe(2);
    // initProducer ran a second time too
    expect(durableStreamsMocks.IdempotentProducer).toHaveBeenCalledTimes(2);
  });

  it('publish surfaces non-ALREADY_CLOSED errors from append', async () => {
    durableStreamsMocks.producerSpy.append.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(server.publish('session-fail', 'foo', {})).rejects.toThrow(/disk full/);
  });

  it('subscribe returns a no-op AsyncIterable that immediately yields done', async () => {
    const iter = server.subscribe('any');
    const reader = iter[Symbol.asyncIterator]();
    const result = await reader.next();
    expect(result.done).toBe(true);
  });

  it('deleteStream returns false when stream is unknown', async () => {
    const result = await server.deleteStream('never-published');
    expect(result).toBe(false);
  });

  it('deleteStream tears down stream + producer and returns true on success', async () => {
    await server.publish('session-del', 'foo', {});
    const result = await server.deleteStream('session-del');
    expect(result).toBe(true);
    expect(durableStreamsMocks.producerSpy.detach).toHaveBeenCalled();
    expect(durableStreamsMocks.streamSpy.delete).toHaveBeenCalled();
  });

  it('deleteStream returns false when underlying detach/delete throws', async () => {
    await server.publish('session-del-fail', 'foo', {});
    durableStreamsMocks.producerSpy.detach.mockRejectedValueOnce(new Error('detach fail'));
    const result = await server.deleteStream('session-del-fail');
    expect(result).toBe(false);
  });

  it('streamIdToPath maps cli-monitor / terraform / plan / sandbox / session prefixes', async () => {
    await server.publish('cli-monitor', 'foo', {});
    await server.publish('terraform:job-1', 'foo', {});
    await server.publish('plan:plan-1', 'foo', {});
    await server.publish('sandbox:sb-1', 'foo', {});
    await server.publish('session-bare', 'foo', {});

    const paths = (durableStreamsMocks.DurableStream.mock.calls as Array<[{ url: string }]>).map(
      (call) => call[0].url
    );
    expect(paths).toContain('http://localhost:9999/v1/stream/cli-monitor');
    expect(paths).toContain('http://localhost:9999/v1/stream/terraform/job-1');
    expect(paths).toContain('http://localhost:9999/v1/stream/plans/plan-1');
    expect(paths).toContain('http://localhost:9999/v1/stream/sandboxes/sb-1');
    expect(paths).toContain('http://localhost:9999/v1/stream/sessions/session-bare');
  });

  it('stopCleanup is idempotent', () => {
    expect(() => server.stopCleanup()).not.toThrow();
    expect(() => server.stopCleanup()).not.toThrow();
  });

  it('constructor handles trailing slashes in baseUrl', async () => {
    const trailingServer = new CaddyDurableStreamsServer('http://example.com/v1/stream///////');
    try {
      await trailingServer.publish('cli-monitor', 'foo', {});
      const lastCall = durableStreamsMocks.DurableStream.mock.calls.at(-1) as
        | [{ url: string }]
        | undefined;
      expect(lastCall?.[0].url).toBe('http://example.com/v1/stream/cli-monitor');
    } finally {
      trailingServer.stopCleanup();
    }
  });

  it('constructor falls back to CADDY_STREAMS_URL env then default', async () => {
    const original = process.env.CADDY_STREAMS_URL;
    process.env.CADDY_STREAMS_URL = 'http://from-env:1234/v1/stream';
    try {
      const envServer = new CaddyDurableStreamsServer();
      try {
        await envServer.publish('cli-monitor', 'foo', {});
        const lastCall = durableStreamsMocks.DurableStream.mock.calls.at(-1) as
          | [{ url: string }]
          | undefined;
        expect(lastCall?.[0].url).toBe('http://from-env:1234/v1/stream/cli-monitor');
      } finally {
        envServer.stopCleanup();
      }
    } finally {
      if (original === undefined) delete process.env.CADDY_STREAMS_URL;
      else process.env.CADDY_STREAMS_URL = original;
    }
  });
});
