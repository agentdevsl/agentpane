/**
 * CaddyDurableStreamsServer — DurableStreamsServer backed by Caddy's
 * durable_streams plugin (or DurableStreamTestServer in dev).
 *
 * Uses IdempotentProducer from @durable-streams/client for writes.
 * Streams are auto-created on first publish via PUT.
 */
import { DurableStream, IdempotentProducer } from '@durable-streams/client';
import type { DurableStreamsServer } from '../../services/durable-streams.service.js';

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
  /** Timestamp of last publish or access, used for LRU eviction (RS-001). */
  lastUsedAt: number;
}

/**
 * RS-001: LRU eviction configuration for the producer pool.
 * Prevents unbounded memory growth when many streams are created over time.
 */
const MAX_PRODUCERS = 200;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

export class CaddyDurableStreamsServer implements DurableStreamsServer {
  private baseUrl: string;
  private producers = new Map<string, ProducerEntry>();
  private pendingProducers = new Map<string, Promise<ProducerEntry>>();
  private producerId: string;
  /** RS-001: Periodic cleanup timer for idle producers. */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env.CADDY_STREAMS_URL ?? 'http://localhost:3000/v1/stream';
    this.baseUrl = this.baseUrl.replace(/\/+$/, '');
    // Strip trailing /v1/stream from baseUrl since streamIdToPath adds it
    if (this.baseUrl.endsWith('/v1/stream')) {
      this.baseUrl = this.baseUrl.slice(0, -'/v1/stream'.length);
    }
    this.producerId = `api-server-${process.pid}`;

    // RS-001: Start periodic cleanup of idle producers
    this.cleanupTimer = setInterval(() => this.evictIdleProducers(), CLEANUP_INTERVAL_MS);
    // Allow the process to exit even if this timer is still running
    if (
      this.cleanupTimer &&
      typeof this.cleanupTimer === 'object' &&
      'unref' in this.cleanupTimer
    ) {
      this.cleanupTimer.unref();
    }
  }

  private getOrCreateProducer(id: string): Promise<ProducerEntry> {
    const entry = this.producers.get(id);
    if (entry) {
      entry.lastUsedAt = Date.now();
      return Promise.resolve(entry);
    }

    // Deduplicate concurrent initialization for the same stream ID
    const pending = this.pendingProducers.get(id);
    if (pending) return pending;

    const promise = this.initProducer(id).finally(() => this.pendingProducers.delete(id));
    this.pendingProducers.set(id, promise);
    return promise;
  }

  private async initProducer(id: string): Promise<ProducerEntry> {
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
        throw new Error(
          `[CaddyStreams] Failed to create stream at ${url}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const producer = new IdempotentProducer(stream, this.producerId, {
      autoClaim: true,
      lingerMs: 5,
      maxBatchBytes: 1_048_576,
      maxInFlight: 5,
      onError: (error) => {
        console.error(`[CaddyStreams] Producer error for ${id}:`, error);
        // Only invalidate if this is still the current entry (avoid racing with a new producer)
        const current = this.producers.get(id);
        if (current && current.producer === producer) {
          this.producers.delete(id);
          this.pendingProducers.delete(id);
          producer.detach().catch((detachErr) => {
            console.error(`[CaddyStreams] Failed to detach producer for ${id}:`, detachErr);
          });
        }
      },
    });

    const entry: ProducerEntry = { stream, producer, offset: 0, lastUsedAt: Date.now() };
    this.producers.set(id, entry);

    // RS-001: Evict LRU producers when pool exceeds MAX_PRODUCERS
    if (this.producers.size > MAX_PRODUCERS) {
      this.evictLRUProducers();
    }

    return entry;
  }

  /**
   * RS-001: Evict producers that have been idle longer than IDLE_TIMEOUT_MS.
   * Called periodically via cleanup timer.
   */
  private evictIdleProducers(): void {
    const now = Date.now();
    for (const [id, entry] of this.producers) {
      if (now - entry.lastUsedAt > IDLE_TIMEOUT_MS) {
        this.producers.delete(id);
        entry.producer.detach().catch((err) => {
          console.error(`[CaddyStreams] Failed to detach idle producer for ${id}:`, err);
        });
      }
    }
  }

  /**
   * RS-001: Evict least-recently-used producers when pool exceeds MAX_PRODUCERS.
   * Removes the oldest entries until the pool is back at MAX_PRODUCERS.
   */
  private evictLRUProducers(): void {
    const entries = [...this.producers.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const toRemove = entries.slice(0, this.producers.size - MAX_PRODUCERS);
    for (const [id, entry] of toRemove) {
      this.producers.delete(id);
      entry.producer.detach().catch((err) => {
        console.error(`[CaddyStreams] Failed to detach LRU producer for ${id}:`, err);
      });
    }
  }

  async createStream(id: string, _schema: unknown): Promise<void> {
    await this.getOrCreateProducer(id);
  }

  /**
   * Publish an event to the stream. Returns a local monotonic offset (not the
   * server-assigned durable offset). The true offset is managed by Caddy/LMDB
   * and only visible to subscribers via the SSE stream.
   */
  async publish(id: string, type: string, data: unknown): Promise<number> {
    let entry = await this.getOrCreateProducer(id);
    const event = JSON.stringify({ type, data, timestamp: Date.now() });
    try {
      entry.producer.append(`${event}\n`);
    } catch (err: unknown) {
      // If producer was closed/invalidated, re-init and retry once
      const code =
        err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : '';
      if (code === 'ALREADY_CLOSED') {
        console.warn(`[CaddyStreams] Producer for ${id} was closed, reinitializing`);
        this.producers.delete(id);
        entry = await this.getOrCreateProducer(id);
        entry.producer.append(`${event}\n`);
      } else {
        throw err;
      }
    }
    const offset = entry.offset;
    entry.offset++;
    return offset;
  }

  /**
   * RS-015: Server-side subscription is intentionally not implemented.
   * Clients subscribe directly to Caddy via SSE at /v1/stream/sessions/{sessionId}.
   * Returns an empty async iterable to satisfy the DurableStreamsServer interface
   * without crashing callers. This is by design -- see RS-009 documentation below.
   */
  subscribe(
    _id: string,
    _options?: { fromOffset?: number }
  ): AsyncIterable<{ type: string; data: unknown; offset: number }> {
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  async deleteStream(id: string): Promise<boolean> {
    this.pendingProducers.delete(id);
    const entry = this.producers.get(id);
    if (!entry) return false;

    let success = true;
    try {
      await entry.producer.detach();
      await entry.stream.delete();
    } catch (err) {
      console.warn(`[CaddyStreams] deleteStream(${id}) cleanup error:`, err);
      success = false;
    }

    this.producers.delete(id);
    return success;
  }

  /**
   * RS-001: Stop the periodic cleanup timer. Call during graceful shutdown.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
