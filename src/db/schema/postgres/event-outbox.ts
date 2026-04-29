/**
 * event_outbox — F05-05 (Postgres).
 *
 * Transactional outbox for durable-streams publishes. A service that needs
 * exactly-once delivery writes a row to this table inside the same Postgres
 * transaction as the state change that produced the event. The
 * `EventOutboxRelayService` polls every 50ms, publishes to Caddy, and marks
 * rows `published` (hard-deleted after a retention window).
 *
 * F02-18 (arch29-W2-R): timestamp columns store epoch ms as `bigint({ mode:
 * 'number' })` — matching the SQLite `integer({ mode: 'timestamp_ms' })`
 * shape. Drizzle surfaces both as JS numbers (and Date for the SQLite mode),
 * which makes cross-dialect ordering numeric and removes the divergence
 * between lex-compared ISO strings on SQLite and `timestamptz` on PG.
 * Mirrors the `session_events.timestamp` precedent established in PG
 * migration 0002. Migration `0017_event_outbox_epoch_ms.sql` rebuilds the
 * column from the previous `timestamptz` shape.
 */

import { createId } from '@paralleldrive/cuid2';
import { bigint, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

export const eventOutbox = pgTable(
  'event_outbox',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    streamId: text('stream_id').notNull(),
    type: text('type').notNull(),
    // Migration 0012 creates this column as JSONB. Drizzle was previously declared as
    // `text` which caused a schema drift (caught by tests/integration/*-schema-drift.test.ts).
    // The `$type` annotation gives consumers a typed handle instead of `unknown`.
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: ['pending', 'published', 'dead'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /**
     * F02-18 — epoch ms (PG `bigint`). The relay compares numerically:
     * `where(lte(eventOutbox.nextAttemptAt, Date.now()))`. Drizzle `mode:
     * 'number'` returns the value as a JS number for direct numeric ops.
     */
    nextAttemptAt: bigint('next_attempt_at', { mode: 'number' })
      .notNull()
      .$defaultFn(() => Date.now()),
    lastError: text('last_error'),
    /** F02-18 — epoch ms. See `nextAttemptAt`. */
    createdAt: bigint('created_at', { mode: 'number' })
      .notNull()
      .$defaultFn(() => Date.now()),
    /** F02-18 — epoch ms; nullable until the relay marks the row published. */
    publishedAt: bigint('published_at', { mode: 'number' }),
  },
  (table) => [
    index('event_outbox_status_idx').on(table.status),
    index('event_outbox_next_attempt_at_idx').on(table.nextAttemptAt),
    index('event_outbox_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
  ]
);

export type EventOutboxRow = typeof eventOutbox.$inferSelect;
export type NewEventOutboxRow = typeof eventOutbox.$inferInsert;
