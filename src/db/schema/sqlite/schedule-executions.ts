import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { BudgetWindow, ScheduleExecutionStatus } from '../shared/enums';
import { eventSources } from './event-sources';
import { eventSubscriptions } from './event-subscriptions';
import { tasks } from './tasks';

export const scheduleExecutions = sqliteTable(
  'schedule_executions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),

    eventSourceId: text('event_source_id')
      .notNull()
      .references(() => eventSources.id, { onDelete: 'cascade' }),

    status: text('status').$type<ScheduleExecutionStatus>().notNull(),

    scheduledAt: text('scheduled_at').notNull(),

    executedAt: text('executed_at').notNull(),

    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),

    subscriptionId: text('subscription_id').references(() => eventSubscriptions.id, {
      onDelete: 'set null',
    }),

    budgetWindow: text('budget_window').$type<BudgetWindow>(),

    windowExecutionCount: integer('window_execution_count').default(0).notNull(),

    error: text('error'),

    createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  },
  (table) => [
    index('schedule_executions_event_source_idx').on(table.eventSourceId),
    index('schedule_executions_source_status_idx').on(table.eventSourceId, table.status),
    index('schedule_executions_source_executed_at_idx').on(table.eventSourceId, table.executedAt),
    index('schedule_executions_source_scheduled_at_idx').on(table.eventSourceId, table.scheduledAt),
  ]
);

export type ScheduleExecution = typeof scheduleExecutions.$inferSelect;
export type NewScheduleExecution = typeof scheduleExecutions.$inferInsert;
