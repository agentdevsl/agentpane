import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { TaskColumn, TaskPriority } from '../shared/enums';
import { codespaces } from './codespaces';
import { eventSources } from './event-sources';

export type { SubscriptionFilter } from '../../../lib/events/plugin-interface.js';
export type { TaskColumn, TaskPriority } from '../shared/enums';

import type { SubscriptionFilter } from '../../../lib/events/plugin-interface.js';

export const eventSubscriptions = sqliteTable(
  'event_subscriptions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text('name').notNull(),
    eventSourceId: text('event_source_id')
      .notNull()
      .references(() => eventSources.id, { onDelete: 'cascade' }),
    targetCodespaceId: text('target_codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
    isEnabled: integer('is_enabled', { mode: 'boolean' }).default(true).notNull(),
    eventTypes: text('event_types', { mode: 'json' }).$type<string[]>().default([]),
    filters: text('filters', { mode: 'json' }).$type<SubscriptionFilter[]>().default([]),
    promptTemplate: text('prompt_template').notNull(),
    autoStartAgent: integer('auto_start_agent', { mode: 'boolean' }).default(false).notNull(),
    taskColumn: text('task_column').$type<TaskColumn>().default('backlog').notNull(),
    taskPriority: text('task_priority').$type<TaskPriority>().default('medium').notNull(),
    taskLabels: text('task_labels', { mode: 'json' }).$type<string[]>().default([]),
    matchedCount: integer('matched_count').default(0).notNull(),
    lastMatchedAt: text('last_matched_at'),
    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
    updatedAt: text('updated_at')
      .default(sql`(datetime('now'))`)
      .notNull()
      .$onUpdate(() => new Date().toISOString()),
  },
  (table) => [
    index('event_subscriptions_source_idx').on(table.eventSourceId),
    index('event_subscriptions_codespace_idx').on(table.targetCodespaceId),
    index('event_subscriptions_source_enabled_idx').on(table.eventSourceId, table.isEnabled),
  ]
);

export type EventSubscription = typeof eventSubscriptions.$inferSelect;
export type NewEventSubscription = typeof eventSubscriptions.$inferInsert;
