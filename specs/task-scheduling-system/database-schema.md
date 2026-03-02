# Task Scheduling System - Database Schema

## Overview

One new Drizzle table (`schedule_executions`) and enum additions to support the task scheduling system. The existing `event_sources` table is reused for cron-type sources -- schedule configuration (interval/expression, timezone, budget limits, next run time) is stored in the `config` JSON column. The existing `event_subscriptions` table is reused without modification; cron subscriptions use the same subscription model as webhook-based sources.

These follow the existing codebase patterns: SQLite via `better-sqlite3`, cuid2 primary keys, `text` columns, JSON mode for structured data, and `sql\`(datetime('now'))\`` defaults for timestamps.

---

## Enum Additions

Added to `src/db/schema/shared/enums.ts` following the existing const-array pattern:

```typescript
// --- Extend EVENT_SOURCE_TYPES with 'cron' ---

export const EVENT_SOURCE_TYPES = ['github', 'linear', 'jira', 'generic_webhook', 'cron'] as const;
export type EventSourceType = (typeof EVENT_SOURCE_TYPES)[number];

// --- Schedule Execution Status ---

export const SCHEDULE_EXECUTION_STATUS = [
  'executed',
  'skipped_budget',
  'skipped_disabled',
  'error',
] as const;
export type ScheduleExecutionStatus = (typeof SCHEDULE_EXECUTION_STATUS)[number];

// --- Budget Windows ---

export const BUDGET_WINDOWS = ['hour', 'day', 'week', 'month'] as const;
export type BudgetWindow = (typeof BUDGET_WINDOWS)[number];
```

---

## Cron Event Source Config Shape

When `event_sources.type = 'cron'`, the `config` JSON column holds a `CronEventSourceConfig` object. This interface is defined alongside the existing `EventSourceConfig` type.

```typescript
// src/db/schema/shared/cron-config.ts

import type { BudgetWindow } from './enums';

/**
 * Budget limits per time window.
 * All limits are optional; if not set, that window is unconstrained.
 * Limits are evaluated as rolling windows (e.g., "last 60 minutes" not "this clock hour").
 */
export interface CronBudgetConfig {
  maxPerHour?: number;
  maxPerDay?: number;
  maxPerWeek?: number;
  maxPerMonth?: number;
}

/**
 * Configuration stored in event_sources.config for type='cron'.
 * Extends the base EventSourceConfig with schedule-specific fields.
 */
export interface CronEventSourceConfig {
  /** 'interval' for simple repeating, 'cron' for cron expressions */
  scheduleType: 'interval' | 'cron';

  /**
   * Interval in seconds (for scheduleType: 'interval').
   * Minimum: 60, Maximum: 2592000 (30 days).
   */
  interval?: number;

  /**
   * Standard 5-field cron expression (for scheduleType: 'cron').
   * Fields: minute hour day-of-month month day-of-week
   * Examples: "0 9 * * 1-5" (weekdays at 9am), "*/15 * * * *" (every 15 min)
   */
  cronExpression?: string;

  /**
   * IANA timezone for cron evaluation.
   * Interval schedules are timezone-agnostic (pure elapsed time).
   * Example: "America/New_York", "Europe/London", "UTC"
   */
  timezone: string;

  /** Budget limits per time window */
  budget: CronBudgetConfig;

  /**
   * Next scheduled run time (ISO 8601 UTC).
   * Managed by SchedulerService -- set on creation and updated after each tick.
   * null when the schedule has not been initialized yet.
   */
  nextRunAt: string | null;

  /**
   * Last successful run time (ISO 8601 UTC).
   * Updated after each execution (including skipped_budget).
   * null if the schedule has never run.
   */
  lastRunAt: string | null;

  /** Number of consecutive execution errors (resets on success) */
  consecutiveErrors: number;

  /** ISO 8601 timestamp when schedule was paused (null when active) */
  pausedAt: string | null;
}
```

### Config Shape by Schedule Type

| Field | `scheduleType: 'interval'` | `scheduleType: 'cron'` |
|-------|---------------------------|------------------------|
| `interval` | Required (seconds) | Not used |
| `cronExpression` | Not used | Required (5-field cron) |
| `timezone` | Required (used for display) | Required (cron evaluation) |
| `budget` | Required (may be empty `{}`) | Required (may be empty `{}`) |
| `nextRunAt` | Managed by scheduler | Managed by scheduler |
| `lastRunAt` | Managed by scheduler | Managed by scheduler |
| `consecutiveErrors` | Managed by scheduler (resets on success) | Managed by scheduler (resets on success) |
| `pausedAt` | Managed by scheduler (null when active) | Managed by scheduler (null when active) |

---

## Schedule Executions Table

Audit trail of every schedule tick. Records whether a task was created, budget was exceeded, or an error occurred. Used for budget window counting and execution history display.

### Schema

```typescript
// src/db/schema/sqlite/schedule-executions.ts
import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ScheduleExecutionStatus, BudgetWindow } from '../shared/enums';
import { eventSources } from './event-sources';
import { eventSubscriptions } from './event-subscriptions';
import { tasks } from './tasks';

export const scheduleExecutions = sqliteTable('schedule_executions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),

  /** The cron event source that triggered this execution */
  eventSourceId: text('event_source_id')
    .notNull()
    .references(() => eventSources.id, { onDelete: 'cascade' }),

  /** Execution outcome */
  status: text('status').$type<ScheduleExecutionStatus>().notNull(),

  /**
   * The intended run time (ISO 8601 UTC).
   * This is the nextRunAt value that triggered the execution.
   */
  scheduledAt: text('scheduled_at').notNull(),

  /**
   * When the execution actually ran (ISO 8601 UTC).
   * May differ from scheduledAt due to tick interval or server delay.
   */
  executedAt: text('executed_at').notNull(),

  /**
   * The task created by this execution, if any.
   * null when status is skipped_budget, skipped_disabled, or error.
   * SET NULL on task deletion to preserve execution history.
   */
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),

  /**
   * The subscription that matched and created the task.
   * null when no subscription matched or execution was skipped.
   * SET NULL on subscription deletion to preserve execution history.
   */
  subscriptionId: text('subscription_id').references(() => eventSubscriptions.id, {
    onDelete: 'set null',
  }),

  /**
   * Which budget window caused a skip (when status = 'skipped_budget').
   * The first window that exceeded its limit.
   * null for non-budget-skip executions.
   */
  budgetWindow: text('budget_window').$type<BudgetWindow>(),

  /**
   * Execution count within the checked budget window at time of evaluation.
   * Useful for debugging budget behavior.
   * 0 for non-budget-related executions.
   */
  windowExecutionCount: integer('window_execution_count').default(0).notNull(),

  /** Error message if status = 'error' */
  error: text('error'),

  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
});

export type ScheduleExecution = typeof scheduleExecutions.$inferSelect;
export type NewScheduleExecution = typeof scheduleExecutions.$inferInsert;
```

### Indexes

```typescript
export const scheduleExecutionsIndexes = {
  /** Look up executions by source */
  eventSourceIdx: index('schedule_executions_event_source_idx').on(
    scheduleExecutions.eventSourceId,
  ),

  /** Filter by source + status for monitoring dashboards */
  sourceStatusIdx: index('schedule_executions_source_status_idx').on(
    scheduleExecutions.eventSourceId,
    scheduleExecutions.status,
  ),

  /**
   * Budget window counting: query executions by source within a time range.
   * Used by: SELECT COUNT(*) WHERE eventSourceId = ? AND status = 'executed'
   *          AND executedAt >= datetime('now', '-1 hour')
   */
  sourceExecutedAtIdx: index('schedule_executions_source_executed_at_idx').on(
    scheduleExecutions.eventSourceId,
    scheduleExecutions.executedAt,
  ),

  /** Chronological listing and cursor pagination */
  sourceScheduledAtIdx: index('schedule_executions_source_scheduled_at_idx').on(
    scheduleExecutions.eventSourceId,
    scheduleExecutions.scheduledAt,
  ),
};
```

---

## Relations

```typescript
// Added to src/db/schema/sqlite/relations.ts

import { relations } from 'drizzle-orm';
import { scheduleExecutions } from './schedule-executions';
import { eventSources } from './event-sources';
import { eventSubscriptions } from './event-subscriptions';
import { tasks } from './tasks';

// Schedule execution relations
export const scheduleExecutionsRelations = relations(scheduleExecutions, ({ one }) => ({
  /** The cron event source that triggered this execution */
  eventSource: one(eventSources, {
    fields: [scheduleExecutions.eventSourceId],
    references: [eventSources.id],
  }),
  /** The task created by this execution (if any) */
  task: one(tasks, {
    fields: [scheduleExecutions.taskId],
    references: [tasks.id],
  }),
  /** The subscription that matched (if any) */
  subscription: one(eventSubscriptions, {
    fields: [scheduleExecutions.subscriptionId],
    references: [eventSubscriptions.id],
  }),
}));

// Extend existing eventSources relations to include schedule executions
// (add to the existing eventSourcesRelations in relations.ts)
//
//   scheduleExecutions: many(scheduleExecutions),
```

---

## Schema Index File Update

Add export to `src/db/schema/sqlite/index.ts`:

```typescript
// Task scheduling system
export * from './schedule-executions';
```

---

## Entity Relationship Diagram

```
┌─────────────┐
│    teams     │
├─────────────┤
│ id (PK)     │
│ name        │
│ slug        │
└──────┬──────┘
       │ 1:N
       ▼
┌──────────────────────┐          ┌──────────────────┐
│    event_sources     │          │    projects      │
├──────────────────────┤          ├──────────────────┤
│ id (PK)              │          │ id (PK)          │
│ teamId (FK)          │          │ name             │
│ name                 │          │ path             │
│ type = 'cron'        │          └────────▲─────────┘
│ slug (unique)        │                   │
│ webhookSecret (n/a)  │                   │ targetProjectId
│ isEnabled            │                   │
│ config (JSON) ───────┼─┐        ┌────────┴──────────────────┐
│   .scheduleType      │ │        │  event_subscriptions      │
│   .interval          │ │        ├───────────────────────────┤
│   .cronExpression    │ │        │ id (PK)                   │
│   .timezone          │ │   1:N  │ eventSourceId (FK)        │
│   .budget            │ │◄───────│ targetProjectId (FK)      │
│   .nextRunAt         │ │        │ name                      │
│   .lastRunAt         │ │        │ isEnabled                 │
│ eventCount           │ │        │ eventTypes (JSON)         │
│ lastEventAt          │ │        │ filters (JSON)            │
│ status               │ │        │ promptTemplate            │
│ createdAt            │ │        │ autoStartAgent            │
│ updatedAt            │ │        │ taskColumn = 'in_progress'│
└──────────┬───────────┘ │        │ taskPriority              │
           │             │        │ taskLabels (JSON)         │
           │ 1:N         │        │ matchedCount              │
           ▼             │        │ lastMatchedAt             │
┌──────────────────────┐ │        │ createdAt                 │
│ schedule_executions  │ │        │ updatedAt                 │
├──────────────────────┤ │        └───────────────────────────┘
│ id (PK)              │ │
│ eventSourceId (FK)   │ │        ┌───────────────────────────┐
│ status               │ │        │        tasks              │
│ scheduledAt          │ │        ├───────────────────────────┤
│ executedAt           │ │        │ id (PK)                   │
│ taskId               │─┼───────>│ title                     │
│   (FK, SET NULL)     │ │        │ column                    │
│ subscriptionId       │ │        │ ...                       │
│   (FK, SET NULL)     │ │        └───────────────────────────┘
│ budgetWindow         │ │
│ windowExecutionCount │ │
│ error                │ │
│ createdAt            │ │
└──────────────────────┘ │
                         │
  Config JSON detail:    │
  ┌──────────────────┐   │
  │ CronEventSource  │◄──┘
  │ Config           │
  ├──────────────────┤
  │ scheduleType     │  'interval' | 'cron'
  │ interval?        │  seconds (min: 60)
  │ cronExpression?  │  "0 9 * * 1-5"
  │ timezone         │  "America/New_York"
  │ budget           │  { maxPerHour?, maxPerDay?, ... }
  │ nextRunAt        │  ISO 8601 UTC | null
  │ lastRunAt        │  ISO 8601 UTC | null
  │ consecutiveErrors│  number (resets on success)
  │ pausedAt         │  ISO 8601 UTC | null
  └──────────────────┘
```

---

## Migration

```bash
# Generate migration from schema changes
bun run db:generate

# Apply migration
bun run db:migrate
```

---

## Validation Schemas (Zod)

```typescript
// src/lib/validation/cron-event-sources.ts
import { z } from 'zod';
import { BUDGET_WINDOWS } from '@/db/schema/shared/enums';

// --- Budget Config ---

const budgetConfigSchema = z
  .object({
    maxPerHour: z.number().int().positive().optional(),
    maxPerDay: z.number().int().positive().optional(),
    maxPerWeek: z.number().int().positive().optional(),
    maxPerMonth: z.number().int().positive().optional(),
  })
  .refine(
    (budget) => {
      // If multiple windows are set, larger windows must have >= smaller window limits
      const { maxPerHour, maxPerDay, maxPerWeek, maxPerMonth } = budget;
      if (maxPerHour !== undefined && maxPerDay !== undefined && maxPerDay < maxPerHour) {
        return false;
      }
      if (maxPerDay !== undefined && maxPerWeek !== undefined && maxPerWeek < maxPerDay) {
        return false;
      }
      if (maxPerWeek !== undefined && maxPerMonth !== undefined && maxPerMonth < maxPerWeek) {
        return false;
      }
      return true;
    },
    { message: 'Budget limits must be non-decreasing: hour <= day <= week <= month' },
  );

// --- Cron Expression Validation ---

/**
 * Basic 5-field cron expression validation.
 * Fields: minute(0-59) hour(0-23) day(1-31) month(1-12) dow(0-7)
 * Supports: *, ranges (1-5), lists (1,3,5), steps (*/15)
 */
const cronExpressionSchema = z
  .string()
  .regex(
    /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/,
    'Must be a valid 5-field cron expression (minute hour day month weekday)',
  );

// --- Timezone Validation ---

const timezoneSchema = z.string().min(1).refine(
  (tz) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Must be a valid IANA timezone (e.g., "America/New_York", "UTC")' },
);

// --- Cron Event Source Config ---

const cronConfigBaseSchema = z.discriminatedUnion('scheduleType', [
  z.object({
    scheduleType: z.literal('interval'),
    interval: z
      .number()
      .int()
      .min(60, 'Minimum interval is 60 seconds')
      .max(2592000, 'Maximum interval is 2592000 seconds (30 days)'),
    timezone: timezoneSchema,
    budget: budgetConfigSchema,
  }),
  z.object({
    scheduleType: z.literal('cron'),
    cronExpression: cronExpressionSchema,
    timezone: timezoneSchema,
    budget: budgetConfigSchema,
  }),
]);

// --- Create Cron Event Source ---

export const createCronEventSourceSchema = z.object({
  teamId: z.string().min(1),
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Slug must be lowercase alphanumeric with hyphens'),
  config: cronConfigBaseSchema,
});

// --- Update Cron Event Source ---

export const updateCronEventSourceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  isEnabled: z.boolean().optional(),
  config: z
    .object({
      scheduleType: z.enum(['interval', 'cron']).optional(),
      interval: z
        .number()
        .int()
        .min(60, 'Minimum interval is 60 seconds')
        .max(2592000, 'Maximum interval is 2592000 seconds (30 days)')
        .optional(),
      cronExpression: cronExpressionSchema.optional(),
      timezone: timezoneSchema.optional(),
      budget: budgetConfigSchema.optional(),
    })
    .optional(),
});

// --- Cron Subscription ---
// Uses existing createEventSubscriptionSchema from event-sources validation.
// For cron sources, eventTypes should include ["cron"] and autoStartAgent
// should be true. taskColumn should be "in_progress" to trigger agent auto-start.

// Type exports
export type CreateCronEventSourceInput = z.infer<typeof createCronEventSourceSchema>;
export type UpdateCronEventSourceInput = z.infer<typeof updateCronEventSourceSchema>;
export type CronBudgetConfig = z.infer<typeof budgetConfigSchema>;
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Event Plugin Database Schema](../event-plugin-system/database-schema.md) | `event_sources` and `event_subscriptions` tables are reused; `schedule_executions` FK references `event_sources` |
| [Existing Schema](../application/database/schema.md) | FK references to `teams`, `projects`, and `tasks` tables |
| [Enums](../../src/db/schema/shared/enums.ts) | `EVENT_SOURCE_TYPES` extended with `'cron'`; new `SCHEDULE_EXECUTION_STATUS` and `BUDGET_WINDOWS` enums |
| [Task Scheduling README](./README.md) | System overview and architecture |
| [Scheduler Service](./scheduler-service.md) | Reads `nextRunAt` from config, writes execution records |
| [Budget Enforcement](./budget-enforcement.md) | Queries `schedule_executions` for window counting |
| [API Endpoints](./api-endpoints.md) | CRUD operations on cron sources and execution history queries |
