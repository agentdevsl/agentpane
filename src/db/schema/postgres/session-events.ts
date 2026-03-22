import { createId } from '@paralleldrive/cuid2';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sessions } from './sessions';

export const sessionEvents = pgTable(
  'session_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
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
    index('session_events_offset_idx').on(table.sessionId, table.offset),
    uniqueIndex('session_events_unique_offset').on(table.sessionId, table.offset),
    index('session_events_created_at_idx').on(table.createdAt),
  ]
);

export type SessionEvent = typeof sessionEvents.$inferSelect;
export type NewSessionEvent = typeof sessionEvents.$inferInsert;
