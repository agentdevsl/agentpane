/**
 * EventOutboxRelayService — F05-05.
 *
 * Polls the event_outbox table every 50ms for pending rows whose
 * `nextAttemptAt` is in the past, publishes them to the Caddy durable-streams
 * server, and marks them `published` on success. Failures bump `attempts` and
 * schedule exponential backoff up to 30s; after 10 attempts the row is marked
 * `dead` for operator review.
 *
 * The relay also trims `published` rows older than RETENTION_MINUTES so the
 * outbox table doesn't grow unbounded.
 *
 * Producers insert into event_outbox inside the same transaction as the state
 * change that produced the event. This converts the previous best-effort
 * dual-write into a durable, eventually-consistent publish pipeline.
 *
 * The relay is deliberately simple: single-process, at-least-once delivery,
 * no HA. Multi-node deployment (the follow-up in F05-17) will need a row-lock
 * pattern or move to NATS JetStream.
 */

import { and, eq, lt, lte, sql } from 'drizzle-orm';
import { eventOutbox } from '../db/schema/sqlite/event-outbox.js';
import type { BackgroundJob, BackgroundJobSnapshot } from '../lib/background/job.js';
import { createLogger } from '../lib/logging/logger.js';
import type { Database } from '../types/database.js';
import type { DurableStreamsServer } from './durable-streams.service.js';

const log = createLogger('EventOutboxRelay');

const POLL_INTERVAL_MS = 50;
const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 10;
const RETENTION_MINUTES = 30;
const RETENTION_CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 100;

export class EventOutboxRelayService implements BackgroundJob {
  readonly name = 'eventOutboxRelay';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlight = false;
  private lastTickAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private db: Database,
    private streams: DurableStreamsServer
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.retentionTimer = setInterval(
      () => void this.trimPublished(),
      RETENTION_CLEANUP_INTERVAL_MS
    );
    // Ensure a graceful process exit doesn't wait on these timers.
    if (this.pollTimer && typeof this.pollTimer === 'object' && 'unref' in this.pollTimer) {
      (this.pollTimer as { unref: () => void }).unref();
    }
    if (
      this.retentionTimer &&
      typeof this.retentionTimer === 'object' &&
      'unref' in this.retentionTimer
    ) {
      (this.retentionTimer as { unref: () => void }).unref();
    }
    log.info('EventOutboxRelay started', {
      data: { pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE },
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    // Drain any in-flight batch.
    for (let i = 0; i < 50 && this.inFlight; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * Process one poll cycle: fetch due rows, publish each, update status.
   * Public so tests can trigger a synchronous drain.
   */
  async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try {
      // F02-18: timestamps now stored as epoch-ms integers on both dialects.
      // The lex-string ordering risk on PG (`timestamptz` coercion of an ISO
      // string) is gone — comparison is purely numeric and dialect-neutral.
      const nowMs = Date.now();
      this.lastTickAt = new Date(nowMs).toISOString();
      const rows = await this.db
        .select()
        .from(eventOutbox)
        .where(and(eq(eventOutbox.status, 'pending'), lte(eventOutbox.nextAttemptAt, nowMs)))
        .orderBy(eventOutbox.nextAttemptAt)
        .limit(BATCH_SIZE);

      for (const row of rows) {
        await this.processRow(row);
      }
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      log.warn('EventOutboxRelay tick failed', {
        data: { error: this.lastError },
      });
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * {@link BackgroundJob.healthSnapshot} — reports last poll-tick timing and
   * any transient failure. Never throws.
   */
  healthSnapshot(): BackgroundJobSnapshot {
    return {
      name: this.name,
      running: this.running,
      lastRunAt: this.lastTickAt ?? undefined,
      lastError: this.lastError ?? undefined,
    };
  }

  private async processRow(row: typeof eventOutbox.$inferSelect): Promise<void> {
    try {
      await this.streams.publish(row.streamId, row.type, row.payload);
      await this.db
        .update(eventOutbox)
        .set({
          status: 'published',
          // F02-18: epoch ms — Drizzle accepts a number for both dialects.
          publishedAt: Date.now(),
          lastError: null,
        })
        .where(eq(eventOutbox.id, row.id));
    } catch (publishErr) {
      const nextAttempts = row.attempts + 1;
      const isDead = nextAttempts >= MAX_ATTEMPTS;
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(nextAttempts, 10));
      // F02-18: backoff now expressed as epoch ms (Date.now() + delay).
      const nextAt = Date.now() + backoff;
      await this.db
        .update(eventOutbox)
        .set({
          status: isDead ? 'dead' : 'pending',
          attempts: nextAttempts,
          nextAttemptAt: nextAt,
          lastError: publishErr instanceof Error ? publishErr.message : String(publishErr),
        })
        .where(eq(eventOutbox.id, row.id));
      if (isDead) {
        log.warn('EventOutbox row moved to dead after MAX_ATTEMPTS', {
          data: {
            id: row.id,
            streamId: row.streamId,
            type: row.type,
            attempts: nextAttempts,
          },
        });
      }
    }
  }

  private async trimPublished(): Promise<void> {
    try {
      // F02-18: cutoff is epoch ms — comparison numeric on both dialects.
      const cutoffMs = Date.now() - RETENTION_MINUTES * 60 * 1000;
      await this.db
        .delete(eventOutbox)
        .where(and(eq(eventOutbox.status, 'published'), lt(eventOutbox.publishedAt, cutoffMs)));
    } catch (err) {
      log.warn('EventOutboxRelay retention trim failed', {
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /**
   * Observability hook — counts per status. Useful in tests and admin
   * metrics endpoints.
   */
  async getCounts(): Promise<{ pending: number; published: number; dead: number }> {
    const [pending, published, dead] = await Promise.all([
      this.countByStatus('pending'),
      this.countByStatus('published'),
      this.countByStatus('dead'),
    ]);
    return { pending, published, dead };
  }

  private async countByStatus(status: 'pending' | 'published' | 'dead'): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)`.as('n') })
      .from(eventOutbox)
      .where(eq(eventOutbox.status, status));
    return rows[0]?.n ?? 0;
  }
}

/**
 * Helper: insert a pending outbox row. Call this from within the producing
 * service's transaction (pass the same `db` that holds the transaction).
 */
export async function enqueueOutboxEvent(
  db: Database,
  input: { streamId: string; type: string; payload: unknown }
): Promise<void> {
  await db.insert(eventOutbox).values({
    streamId: input.streamId,
    type: input.type,
    payload: input.payload,
  });
}
