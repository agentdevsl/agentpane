/**
 * CaddyDurableStreamsServer — DurableStreamsServer backed by Caddy's
 * durable_streams plugin (or DurableStreamTestServer in dev).
 *
 * Uses IdempotentProducer from @durable-streams/client for writes.
 * Streams are auto-created on first publish via PUT.
 */
import { DurableStream, IdempotentProducer } from '@durable-streams/client';

/**
 * DurableStreamsServer interface (same as used by DurableStreamsService)
 */
export interface DurableStreamsServer {
  createStream: (id: string, schema: unknown) => Promise<void>;
  publish: (id: string, type: string, data: unknown) => Promise<number>;
  subscribe: (
    id: string,
    options?: { fromOffset?: number }
  ) => AsyncIterable<{ type: string; data: unknown; offset: number }>;
  deleteStream?: (id: string) => Promise<boolean>;
}

/** Map internal stream IDs to URL paths */
function streamIdToPath(id: string): string {
  // cli-monitor -> /v1/stream/cli-monitor
  // terraform:{jobId} -> /v1/stream/terraform/{jobId}
  // plan:{sessionId} -> /v1/stream/plans/{sessionId}
  // {sessionId} -> /v1/stream/sessions/{sessionId}
  if (id === 'cli-monitor') return '/v1/stream/cli-monitor';
  if (id.startsWith('terraform:')) return `/v1/stream/terraform/${id.slice('terraform:'.length)}`;
  if (id.startsWith('plan:')) return `/v1/stream/plans/${id.slice('plan:'.length)}`;
  return `/v1/stream/sessions/${id}`;
}

interface ProducerEntry {
  stream: DurableStream;
  producer: IdempotentProducer;
  offset: number;
}

export class CaddyDurableStreamsServer implements DurableStreamsServer {
  private baseUrl: string;
  private producers = new Map<string, ProducerEntry>();
  private producerId: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env.CADDY_STREAMS_URL ?? 'http://localhost:3000/v1/stream';
    // Strip trailing /v1/stream from baseUrl since streamIdToPath adds it
    if (this.baseUrl.endsWith('/v1/stream')) {
      this.baseUrl = this.baseUrl.slice(0, -'/v1/stream'.length);
    }
    this.producerId = `api-server-${process.pid}`;
  }

  private async getOrCreateProducer(id: string): Promise<ProducerEntry> {
    let entry = this.producers.get(id);
    if (entry) return entry;

    const path = streamIdToPath(id);
    const url = `${this.baseUrl}${path}`;

    const stream = new DurableStream({
      url,
      contentType: 'application/json',
    });

    // Create the stream (PUT) — idempotent, safe to call if it already exists
    try {
      await stream.create();
    } catch (err: unknown) {
      // Ignore CONFLICT_EXISTS - stream already exists
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'CONFLICT_EXISTS'
      ) {
        // Stream already exists, that's fine
      } else {
        throw err;
      }
    }

    const producer = new IdempotentProducer(stream, this.producerId, {
      autoClaim: true,
      lingerMs: 5,
      maxBatchBytes: 1_048_576,
      maxInFlight: 5,
      onError: (error) => {
        console.error(`[CaddyStreams] Producer error for ${id}:`, error);
      },
    });

    entry = { stream, producer, offset: 0 };
    this.producers.set(id, entry);
    return entry;
  }

  async createStream(id: string, _schema: unknown): Promise<void> {
    await this.getOrCreateProducer(id);
  }

  async publish(id: string, type: string, data: unknown): Promise<number> {
    const entry = await this.getOrCreateProducer(id);
    const event = JSON.stringify({ type, data, timestamp: Date.now() });
    entry.producer.append(`${event}\n`);
    const offset = entry.offset;
    entry.offset++;
    return offset;
  }

  subscribe(
    _id: string,
    _options?: { fromOffset?: number }
  ): AsyncIterable<{ type: string; data: unknown; offset: number }> {
    // Server-side subscription is not used — clients subscribe directly to Caddy via SSE.
    // This is a no-op implementation to satisfy the interface.
    throw new Error(
      '[CaddyStreams] Server-side subscribe not supported — clients connect directly to Caddy'
    );
  }

  async deleteStream(id: string): Promise<boolean> {
    const entry = this.producers.get(id);
    if (!entry) return false;

    try {
      await entry.producer.detach();
      await entry.stream.delete();
    } catch {
      // Best effort
    }

    this.producers.delete(id);
    return true;
  }
}
