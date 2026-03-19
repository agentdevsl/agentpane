import { createId } from '@paralleldrive/cuid2';
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { TaskColumn, TaskPriority } from '../shared/enums';
import { eventSources } from './event-sources';
import { projects } from './projects';

export type { SubscriptionFilter } from '../../../lib/events/plugin-interface.js';
export type { TaskColumn, TaskPriority } from '../shared/enums';

import type { SubscriptionFilter } from '../../../lib/events/plugin-interface.js';

export const eventSubscriptions = pgTable(
  'event_subscriptions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text('name').notNull(),
    eventSourceId: text('event_source_id')
      .notNull()
      .references(() => eventSources.id, { onDelete: 'cascade' }),
    targetProjectId: text('target_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    isEnabled: boolean('is_enabled').default(true).notNull(),
    eventTypes: jsonb('event_types').$type<string[]>().default([]),
    filters: jsonb('filters').$type<SubscriptionFilter[]>().default([]),
    promptTemplate: text('prompt_template').notNull(),
    autoStartAgent: boolean('auto_start_agent').default(false).notNull(),
    taskColumn: text('task_column').$type<TaskColumn>().default('backlog').notNull(),
    taskPriority: text('task_priority').$type<TaskPriority>().default('medium').notNull(),
    taskLabels: jsonb('task_labels').$type<string[]>().default([]),
    matchedCount: integer('matched_count').default(0).notNull(),
    lastMatchedAt: timestamp('last_matched_at', { mode: 'string' }),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('event_subscriptions_source_idx').on(table.eventSourceId),
    index('event_subscriptions_project_idx').on(table.targetProjectId),
    index('event_subscriptions_source_enabled_idx').on(table.eventSourceId, table.isEnabled),
  ]
);

export type EventSubscription = typeof eventSubscriptions.$inferSelect;
export type NewEventSubscription = typeof eventSubscriptions.$inferInsert;
