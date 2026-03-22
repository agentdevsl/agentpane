import { createId } from '@paralleldrive/cuid2';
import { createLogger } from '../logging/logger.js';

const log = createLogger('ChunkBatcher');

interface ChunkBatcherOptions {
  sessionId: string;
  agentId: string;
  /** Persist a batched chunk event to SQLite (DB-only, no SSE) */
  persistEvent: (
    sessionId: string,
    event: { id: string; type: string; timestamp: number; data: Record<string, unknown> }
  ) => Promise<unknown>;
  /** Publish a real-time delta to Caddy SSE (no DB) */
  publishRealtime: (sessionId: string, type: string, data: unknown) => Promise<number>;
  /** Flush interval in ms (default: 100) */
  flushIntervalMs?: number;
  /** Max deltas before forced flush (default: 10) */
  maxBatchSize?: number;
}

export class ChunkBatcher {
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private currentPhase: 'planning' | 'execution' = 'planning';
  private destroyed = false;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;

  constructor(private options: ChunkBatcherOptions) {
    this.flushIntervalMs = options.flushIntervalMs ?? 100;
    this.maxBatchSize = options.maxBatchSize ?? 10;
  }

  setPhase(phase: 'planning' | 'execution'): void {
    // Flush remaining buffer from previous phase before switching
    if (this.buffer.length > 0) {
      this.flushSync();
    }
    this.currentPhase = phase;
  }

  /**
   * Add a text delta. Immediately publishes to Caddy SSE for real-time delivery.
   * Buffers for batched SQLite persistence.
   */
  async addDelta(delta: string): Promise<void> {
    if (this.destroyed) return;

    // 1. Immediately publish to Caddy for real-time SSE delivery
    try {
      await this.options.publishRealtime(this.options.sessionId, 'chunk', {
        agentId: this.options.agentId,
        delta,
        phase: this.currentPhase,
      });
    } catch (err) {
      log.warn('Failed to publish real-time chunk to SSE', {
        error: err instanceof Error ? err : new Error(String(err)),
        data: { sessionId: this.options.sessionId, agentId: this.options.agentId },
      });
    }

    // 2. Buffer for batched SQLite persistence
    this.buffer.push(delta);

    // 3. Check if we should flush to SQLite
    if (this.buffer.length >= this.maxBatchSize) {
      await this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush().catch((err) => {
          log.error('Timer flush failed, chunk data may be lost', {
            error: err instanceof Error ? err : new Error(String(err)),
            data: { sessionId: this.options.sessionId, agentId: this.options.agentId },
          });
        });
      }, this.flushIntervalMs);
    }
  }

  /**
   * Flush buffer to SQLite as a single batched chunk event.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length === 0) return;

    const batchedDelta = this.buffer.join('');
    const snapshot = this.buffer;
    this.buffer = [];

    try {
      await this.options.persistEvent(this.options.sessionId, {
        id: createId(),
        type: 'chunk',
        timestamp: Date.now(),
        data: {
          agentId: this.options.agentId,
          delta: batchedDelta,
          phase: this.currentPhase,
        },
      });
    } catch (err) {
      // Restore buffer on failure so data is not lost
      this.buffer = [...snapshot, ...this.buffer];
      throw err;
    }
  }

  /**
   * Fire-and-forget flush. Used during phase transitions where we cannot await.
   */
  private flushSync(): void {
    this.flush().catch((err) => {
      log.error('Phase-transition flush failed, chunk data may be lost', {
        error: err instanceof Error ? err : new Error(String(err)),
        data: { sessionId: this.options.sessionId, agentId: this.options.agentId },
      });
    });
  }

  /**
   * Final flush + cleanup. MUST be called at stream end.
   */
  async destroy(): Promise<void> {
    this.destroyed = true;
    await this.flush();
  }
}
