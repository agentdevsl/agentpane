import { createId } from '@paralleldrive/cuid2';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { EventSourceStatus, EventSourceType } from '../shared/enums';
import { teams } from './teams';

export type { EventSourceStatus, EventSourceType } from '../shared/enums';

export const eventSources = pgTable(
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
    isEnabled: boolean('is_enabled').default(true).notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().default({}),
    eventCount: integer('event_count').default(0).notNull(),
    lastEventAt: timestamp('last_event_at', { mode: 'string' }),
    status: text('status').$type<EventSourceStatus>().default('active').notNull(),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('event_sources_team_idx').on(table.teamId),
    uniqueIndex('event_sources_slug_idx').on(table.slug),
  ]
);

export type EventSource = typeof eventSources.$inferSelect;
export type NewEventSource = typeof eventSources.$inferInsert;
