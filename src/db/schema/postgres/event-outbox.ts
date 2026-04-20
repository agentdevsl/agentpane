/**
 * event_outbox — F05-05 (Postgres).
 *
 * Transactional outbox for durable-streams publishes. A service that needs
 * exactly-once delivery writes a row to this table inside the same Postgres
 * transaction as the state change that produced the event. The
 * `EventOutboxRelayService` polls every 50ms, publishes to Caddy, and marks
 * rows `published` (hard-deleted after a retention window).
 */

import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const eventOutbox = pgTable(
  'event_outbox',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    streamId: text('stream_id').notNull(),
    type: text('type').notNull(),
    payload: text('payload').notNull(),
    status: text('status', { enum: ['pending', 'published', 'dead'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    index('event_outbox_status_idx').on(table.status),
    index('event_outbox_next_attempt_at_idx').on(table.nextAttemptAt),
    index('event_outbox_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
  ]
);

export type EventOutboxRow = typeof eventOutbox.$inferSelect;
export type NewEventOutboxRow = typeof eventOutbox.$inferInsert;
