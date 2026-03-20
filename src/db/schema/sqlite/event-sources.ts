import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { EventSourceStatus, EventSourceType } from '../shared/enums';
import { teams } from './teams';

export type { EventSourceStatus, EventSourceType } from '../shared/enums';

export const eventSources = sqliteTable(
  'event_sources',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').$type<EventSourceType>().notNull(),
    slug: text('slug').notNull().unique(),
    webhookSecret: text('webhook_secret'),
    isEnabled: integer('is_enabled', { mode: 'boolean' }).default(true).notNull(),
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    eventCount: integer('event_count').default(0).notNull(),
    lastEventAt: text('last_event_at'),
    status: text('status').$type<EventSourceStatus>().default('active').notNull(),
    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
    updatedAt: text('updated_at')
      .default(sql`(datetime('now'))`)
      .notNull()
      .$onUpdate(() => new Date().toISOString()),
  },
  (table) => [
    index('event_sources_team_idx').on(table.teamId),
    uniqueIndex('event_sources_slug_idx').on(table.slug),
  ]
);

export type EventSource = typeof eventSources.$inferSelect;
export type NewEventSource = typeof eventSources.$inferInsert;
