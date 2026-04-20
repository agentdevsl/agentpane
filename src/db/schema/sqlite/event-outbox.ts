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
 */

import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
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
    /** ISO timestamp — relay skips rows with nextAttemptAt > now. */
    nextAttemptAt: text('next_attempt_at').notNull().default(sql`(datetime('now'))`),
    /** Last error message captured on a failed publish. */
    lastError: text('last_error'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    publishedAt: text('published_at'),
  },
  (table) => [
    index('event_outbox_status_idx').on(table.status),
    index('event_outbox_next_attempt_at_idx').on(table.nextAttemptAt),
    index('event_outbox_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
  ]
);

export type EventOutboxRow = typeof eventOutbox.$inferSelect;
export type NewEventOutboxRow = typeof eventOutbox.$inferInsert;
