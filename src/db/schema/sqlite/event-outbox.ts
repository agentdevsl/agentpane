/**
 * event_outbox — F05-05.
 *
 * Transactional outbox for durable-streams publishes. A service that needs
 * exactly-once delivery writes a row to this table inside the same SQLite
 * transaction as the state change that produced the event. The
 * `EventOutboxRelayService` polls every 50ms, publishes to Caddy, and marks
 * rows `published` (hard-deleted after a retention window).
 *
 * A failed publish bumps `attempts` and sets `nextAttemptAt` for exponential
 * backoff up to 30s. Rows with `attempts > 10` enter a `dead` status and need
 * operator attention.
 *
 * F02-18 (arch29-W2-R): timestamps are stored as epoch-ms `INTEGER` in SQLite
 * (mirrored by `bigint({ mode: 'number' })` on PG). The relay's
 * `lte(nextAttemptAt, now)` comparison is now numeric on both dialects,
 * removing the divergence between lex-compared ISO strings on SQLite and
 * `timestamptz` on PG. Drizzle surfaces both as JS `number` so the relay can
 * pass `Date.now()` directly without conversion. Migration v36 rebuilds
 * existing rows from ISO text to epoch ms.
 *
 * The "raw integer" shape (rather than `mode: 'timestamp_ms'`) matches the
 * pre-existing precedent set by `session_events.timestamp` and
 * `cli_sessions.startedAt`/`lastActivityAt` so the relay's type signatures
 * stay numeric across dialects (SQLite import is used regardless of
 * `DB_MODE`; see F02-18 for the dual-dialect discussion).
 */

import { createId } from '@paralleldrive/cuid2';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const eventOutbox = sqliteTable(
  'event_outbox',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    /** Stream identifier this event is published on (sessionId, plan:{id}, etc). */
    streamId: text('stream_id').notNull(),
    /** Event type (e.g. 'container-agent:token'). */
    type: text('type').notNull(),
    /** JSON-encoded event data payload. */
    payload: text('payload', { mode: 'json' }).notNull(),
    /** Status: pending (relay polls), published (delete-able), dead (giving up). */
    status: text('status', { enum: ['pending', 'published', 'dead'] })
      .notNull()
      .default('pending'),
    /** Number of relay attempts so far. */
    attempts: integer('attempts').notNull().default(0),
    /**
     * Epoch ms — relay skips rows with `nextAttemptAt > now`.
     * F02-18: stored as raw `integer` (epoch ms). Migration v36 backfills
     * existing ISO strings to epoch ms via `strftime('%s') * 1000`.
     */
    nextAttemptAt: integer('next_attempt_at')
      .notNull()
      .$defaultFn(() => Date.now()),
    /** Last error message captured on a failed publish. */
    lastError: text('last_error'),
    /** Epoch ms — when the row was inserted. F02-18: see `nextAttemptAt`. */
    createdAt: integer('created_at')
      .notNull()
      .$defaultFn(() => Date.now()),
    /** Epoch ms — set by the relay when the row reaches `published`. */
    publishedAt: integer('published_at'),
  },
  (table) => [
    index('event_outbox_status_idx').on(table.status),
    index('event_outbox_next_attempt_at_idx').on(table.nextAttemptAt),
    index('event_outbox_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
  ]
);

export type EventOutboxRow = typeof eventOutbox.$inferSelect;
export type NewEventOutboxRow = typeof eventOutbox.$inferInsert;
