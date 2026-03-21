import { createId } from '@paralleldrive/cuid2';
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { SubscriptionFilter } from '../../../lib/events/plugin-interface.js';
import type { TaskColumn, TaskPriority } from '../shared/enums';
import { codespaces } from './codespaces';
import { eventSources } from './event-sources';

export type { SubscriptionFilter };
export type { TaskColumn, TaskPriority } from '../shared/enums';

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
    targetCodespaceId: text('target_codespace_id')
      .notNull()
      .references(() => codespaces.id, { onDelete: 'cascade' }),
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
    updatedAt: timestamp('updated_at', { mode: 'string' })
      .defaultNow()
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
