import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const sessionEvents = sqliteTable(
  'session_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    // Stream ID — stores events for sessions, plans, sandboxes, and other stream types.
    // No FK constraint: plan/sandbox/task-creation stream IDs don't exist in the sessions table.
    // Session cleanup is handled explicitly in session-crud.service.ts.
    sessionId: text('session_id').notNull(),
    /**
     * F05-25: discriminator that records which stream-kind the row belongs to,
     * derived from `classifyStreamId(streamId)` at publish time. Allows cleanup
     * paths and admin queries to filter rows without parsing the prefix at
     * runtime. Values must match `StreamIdKind` from `lib/streams/stream-id.ts`.
     */
    streamKind: text('stream_kind').notNull(),
    offset: integer('offset').notNull(),
    type: text('type').notNull(), // chunk, tool:start, tool:result, etc.
    channel: text('channel').notNull(), // chunks, toolCalls, terminal, presence
    data: text('data', { mode: 'json' }).notNull(),
    timestamp: integer('timestamp').notNull(),
    userId: text('user_id'), // The user who initiated the action (if available)
    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  },
  (table) => [
    index('session_events_session_idx').on(table.sessionId),
    // DB-008: Removed redundant session_events_offset_idx — covered by unique_offset below
    // Enforce unique offset per session to prevent race conditions
    uniqueIndex('session_events_unique_offset').on(table.sessionId, table.offset),
    index('session_events_created_at_idx').on(table.createdAt),
    index('session_events_session_type_idx').on(table.sessionId, table.type),
    // F05-25: index for streamKind-scoped scans (cleanup, admin metrics).
    index('session_events_stream_kind_session_idx').on(table.streamKind, table.sessionId),
    // F05-25: enforce the discriminator's value space at the DB layer so a
    // stray writer cannot insert an unknown kind.
    check(
      'session_events_stream_kind_check',
      sql`${table.streamKind} IN ('session','plan','sandbox','terraform','topology','cli-monitor')`
    ),
  ]
);

export type SessionEvent = typeof sessionEvents.$inferSelect;
export type NewSessionEvent = typeof sessionEvents.$inferInsert;
