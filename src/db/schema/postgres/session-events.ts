import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const sessionEvents = pgTable(
  'session_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    // Stream ID — stores events for sessions, plans, sandboxes, and other stream types.
    // No FK constraint: plan/sandbox/task-creation stream IDs don't exist in the sessions table.
    // Session cleanup is handled explicitly in session-crud.service.ts and codespace.service.ts.
    sessionId: text('session_id').notNull(),
    /**
     * F05-25: discriminator that records which stream-kind the row belongs to,
     * derived from `classifyStreamId(streamId)` at publish time. Allows cleanup
     * paths and admin queries to filter rows without parsing the prefix at
     * runtime. Values must match `StreamIdKind` from `lib/streams/stream-id.ts`.
     */
    streamKind: text('stream_kind').notNull(),
    offset: integer('offset').notNull(),
    type: text('type').notNull(),
    channel: text('channel').notNull(),
    data: jsonb('data').notNull(),
    timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
    userId: text('user_id'),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('session_events_session_idx').on(table.sessionId),
    // DB-008: Removed redundant session_events_offset_idx — covered by unique_offset below
    uniqueIndex('session_events_unique_offset').on(table.sessionId, table.offset),
    index('session_events_created_at_idx').on(table.createdAt),
    index('session_events_session_type_idx').on(table.sessionId, table.type),
    // F05-25: index for streamKind-scoped scans (cleanup, admin metrics).
    index('session_events_stream_kind_session_idx').on(table.streamKind, table.sessionId),
    // F05-25: enforce the discriminator's value space at the DB layer.
    check(
      'session_events_stream_kind_check',
      sql`${table.streamKind} IN ('session','plan','sandbox','terraform','topology','cli-monitor')`
    ),
  ]
);

export type SessionEvent = typeof sessionEvents.$inferSelect;
export type NewSessionEvent = typeof sessionEvents.$inferInsert;
