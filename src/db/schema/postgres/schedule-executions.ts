import { createId } from '@paralleldrive/cuid2';
import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { BudgetWindow, ScheduleExecutionStatus } from '../shared/enums';
import { eventSources } from './event-sources';
import { eventSubscriptions } from './event-subscriptions';
import { tasks } from './tasks';

export const scheduleExecutions = pgTable(
  'schedule_executions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),

    eventSourceId: text('event_source_id')
      .notNull()
      .references(() => eventSources.id, { onDelete: 'cascade' }),

    status: text('status').$type<ScheduleExecutionStatus>().notNull(),

    scheduledAt: timestamp('scheduled_at', { mode: 'string' }).notNull(),

    executedAt: timestamp('executed_at', { mode: 'string' }).notNull(),

    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),

    subscriptionId: text('subscription_id').references(() => eventSubscriptions.id, {
      onDelete: 'set null',
    }),

    budgetWindow: text('budget_window').$type<BudgetWindow>(),

    windowExecutionCount: integer('window_execution_count').default(0).notNull(),

    error: text('error'),

    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
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
