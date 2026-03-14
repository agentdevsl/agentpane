# Scheduler Service

## Overview

The `SchedulerService` enables AgentPane to run tasks on cron schedules and fixed intervals by extending the event plugin architecture with `'cron'` as an event source type. When a schedule fires, the system checks budget limits, emits a synthetic event into the existing event processing pipeline, evaluates subscription filters, interpolates a prompt template, creates a task on the target project's Kanban board (typically in `in_progress`), and auto-starts an agent.

Schedules are **team-scoped**: a cron event source belongs to a team, and subscriptions route scheduled events to specific projects within that team.

**Key implementation files:**

| File | Purpose |
|------|---------|
| `src/services/scheduler.service.ts` | Background tick loop, CAS locking, budget enforcement, manual trigger/pause/resume |
| `src/lib/events/plugins/cron-plugin.ts` | `CronEventSourcePlugin` -- generates synthetic `NormalizedEvent` objects |
| `src/db/schema/sqlite/schedule-executions.ts` | `schedule_executions` Drizzle table definition |
| `src/db/schema/shared/cron-config.ts` | `CronEventSourceConfig` and `CronBudgetConfig` TypeScript interfaces |
| `src/lib/validation/cron-event-sources.ts` | Zod schemas for create/update/trigger/list-executions |
| `src/lib/errors/event-errors.ts` | `ScheduleErrors` error factory (`SCHEDULE_*` codes) |
| `src/server/routes/events.ts` | Hono route handlers for trigger/pause/resume/budget/executions |
| `src/lib/events/template-engine.ts` | Template interpolation with `schedule.*` namespace variables |
| `src/lib/events/event-bus.ts` | `publishEventToStream()` for SSE event delivery |
| `src/services/event-processing.service.ts` | `processScheduledEvent()` -- shared pipeline entry for cron events |

---

## Architecture

### Scheduling Pipeline

```
SchedulerService                AgentPane Event Pipeline                  Kanban Board
(Background Tick Loop)          (Reused from Event Plugin System)          + Agent

  +------------------+
  |  30s tick loop   |
  |  (setInterval)   |
  +--------+---------+
           |
           v
  +------------------+     nextRunAt <= now()      +----------------------+
  |  Query due       |     AND isEnabled = true     |  Budget Check         |
  |  cron sources    |----------------------------->|  (window counting)    |
  |  (compare-and-   |                              |                       |
  |   swap lock)     |                              |  maxPerHour?          |
  +------------------+                              |  maxPerDay?           |
                                                    |  maxPerWeek?          |
                                                    |  maxPerMonth?         |
                                                    +----------+------------+
                                                               |
                                                    +----------+------------+
                                                    |  Pass    |    Fail    |
                                                    |          |            |
                                                    v          v
                                         +---------------+  +------------+
                                         | Emit Synthetic |  | Log skip:  |
                                         | NormalizedEvent|  | skipped_   |
                                         | type: "cron"   |  | budget     |
                                         | action: "tick" |  +------------+
                                         +-------+-------+
                                                 |
                                                 v
                                      +----------------------+
                                      |  processScheduledEvent|
                                      |  (shared pipeline)    |
                                      +----------+-----------+
                                                 |
                                      +----------+-----------+
                                      |  Match Subscriptions  |
                                      |  (filters + types)    |
                                      +----------+-----------+
                                                 |
                                                 v
                                      +----------------------+
                                      |  Template Engine      |
                                      |  {{variable}} interp  |
                                      +----------+-----------+
                                                 |
                                                 v
                                      +----------------------+
                                      |  Task Creation        |
                                      |  column: in_progress  |
                                      |  + agent auto-start   |
                                      +----------------------+
```

### Cron as an Event Source Type

Rather than building a standalone scheduling subsystem, the scheduler adds `'cron'` to the `EVENT_SOURCE_TYPES` enum in `src/db/schema/shared/enums.ts`:

```typescript
export const EVENT_SOURCE_TYPES = ['github', 'linear', 'jira', 'generic_webhook', 'cron'] as const;
```

This reuses the existing event subscription infrastructure: filter conditions, prompt templates, target project routing, auto-start agent flag, and task column/priority/label settings all work identically for cron sources. The `CronEventSourcePlugin` is registered in the plugin registry alongside GitHub/Linear/Jira/generic webhook plugins.

The tradeoff is that cron sources skip some pipeline stages (signature verification, deduplication) that are only relevant to webhook-based sources. The `CronEventSourcePlugin` returns no-ops for `verifySignature()`.

---

## Database Schema

### `schedule_executions` Table

Defined in `src/db/schema/sqlite/schedule-executions.ts`. Audit trail of every schedule tick -- records whether a task was created, budget was exceeded, or an error occurred.

```typescript
export const scheduleExecutions = sqliteTable('schedule_executions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  eventSourceId: text('event_source_id').notNull()
    .references(() => eventSources.id, { onDelete: 'cascade' }),
  status: text('status').$type<ScheduleExecutionStatus>().notNull(),
  scheduledAt: text('scheduled_at').notNull(),
  executedAt: text('executed_at').notNull(),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  subscriptionId: text('subscription_id')
    .references(() => eventSubscriptions.id, { onDelete: 'set null' }),
  budgetWindow: text('budget_window').$type<BudgetWindow>(),
  windowExecutionCount: integer('window_execution_count').default(0).notNull(),
  error: text('error'),
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
});
```

**Indexes** (defined inline via the table's third argument):

| Index | Columns | Purpose |
|-------|---------|---------|
| `schedule_executions_event_source_idx` | `eventSourceId` | Look up executions by source |
| `schedule_executions_source_status_idx` | `eventSourceId, status` | Filter by source + status |
| `schedule_executions_source_executed_at_idx` | `eventSourceId, executedAt` | Budget window counting |
| `schedule_executions_source_scheduled_at_idx` | `eventSourceId, scheduledAt` | Chronological listing, cursor pagination |

### Execution Status Enum

Defined in `src/db/schema/shared/enums.ts`:

```typescript
export const SCHEDULE_EXECUTION_STATUS = ['executed', 'skipped_budget', 'skipped_disabled', 'error'] as const;
export const BUDGET_WINDOWS = ['hour', 'day', 'week', 'month'] as const;
```

### `CronEventSourceConfig` Interface

Defined in `src/db/schema/shared/cron-config.ts`. Stored in the `config` JSON column of the `event_sources` table when `type = 'cron'`:

| Field | Type | Description |
|-------|------|-------------|
| `scheduleType` | `'interval' \| 'cron'` | Simple repeating or cron expression |
| `interval` | `number?` | Seconds (min 60, max 2592000). Required for `scheduleType: 'interval'` |
| `cronExpression` | `string?` | Standard 5-field cron. Required for `scheduleType: 'cron'` |
| `timezone` | `string` | IANA timezone for cron evaluation and budget window boundaries |
| `budget` | `CronBudgetConfig` | `{ maxPerHour?, maxPerDay?, maxPerWeek?, maxPerMonth? }` |
| `nextRunAt` | `string \| null` | ISO 8601 UTC. Managed by SchedulerService |
| `lastRunAt` | `string \| null` | ISO 8601 UTC. Updated after each execution |
| `consecutiveErrors` | `number` | Resets on success; auto-pauses at 5 |
| `pausedAt` | `string \| null` | ISO 8601 timestamp when paused (null when active) |

### Reused Tables

The scheduler reuses existing tables without modification:
- **`event_sources`** -- cron sources stored with `type = 'cron'`, schedule config in JSON `config` column
- **`event_subscriptions`** -- subscriptions link cron sources to target projects with prompt templates
- **`event_log`** -- execution events logged via the shared pipeline

---

## Service Layer

### SchedulerService Class

Defined in `src/services/scheduler.service.ts`. Background service started during application bootstrap.

**Constructor dependencies:**

```typescript
constructor(
  private db: Database,
  private pluginRegistry: PluginRegistry,
  private eventProcessingService: EventProcessingService,
  private eventSourceService: EventSourceService,
)
```

**Configuration (environment variables):**

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| Tick interval | `SCHEDULER_TICK_INTERVAL_MS` | `30000` (30s) | Polling frequency |
| Concurrency limit | `SCHEDULER_CONCURRENCY_LIMIT` | `5` | Max sources processed in parallel per tick |
| Enabled | `SCHEDULER_ENABLED` | `true` | Master kill switch |

### Lifecycle Methods

- **`start()`** -- Runs recovery pass, starts the `setInterval` tick loop, fires first tick immediately. No-ops if `SCHEDULER_ENABLED=false` or already running.
- **`stop()`** -- Clears interval, waits up to 30s for in-flight executions to drain.

### Tick Loop

Every `SCHEDULER_TICK_INTERVAL_MS` milliseconds:

1. Query all cron event sources where `json_extract(config, '$.nextRunAt') <= now` AND `status = 'active'` AND `isEnabled = true`.
2. Process in batches of `concurrencyLimit` using `Promise.allSettled()` for error isolation.
3. Log tick summary with counts of executed/skipped/errors.

### CAS Locking

The service uses compare-and-swap on the `nextRunAt` JSON field to prevent double-firing:

```sql
UPDATE event_sources
SET config = json_set(json_set(config, '$.nextRunAt', :newNextRunAt), '$.lastRunAt', :now),
    updated_at = datetime('now')
WHERE id = :sourceId
  AND json_extract(config, '$.nextRunAt') = :expectedNextRunAt
```

If `result.changes === 0`, the lock was not acquired (another tick claimed it) and the source is skipped.

### Source Processing Flow

For each due source (in `processSource()`):

1. Calculate next run time via `calculateNextRunAt()`
2. Acquire CAS lock (tick) or update directly (manual)
3. Check budget limits via `checkBudget()`
4. Get total execution count for template context
5. Build `CronTickContext` and invoke `CronEventSourcePlugin.parseEvent()`
6. Feed the `NormalizedEvent` into `eventProcessingService.processScheduledEvent()`
7. Record execution in `schedule_executions`
8. On success: reset `consecutiveErrors` to 0, publish `schedule:executed` SSE event
9. On failure: increment `consecutiveErrors`, publish `schedule:error` SSE event

### Budget Enforcement

Budget limits prevent runaway costs. The implementation queries all four budget windows in a single SQL query using conditional SUM:

```sql
SELECT
  sum(CASE WHEN executed_at >= :hourStart THEN 1 ELSE 0 END) as countHour,
  sum(CASE WHEN executed_at >= :dayStart THEN 1 ELSE 0 END) as countDay,
  sum(CASE WHEN executed_at >= :weekStart THEN 1 ELSE 0 END) as countWeek,
  sum(CASE WHEN executed_at >= :monthStart THEN 1 ELSE 0 END) as countMonth
FROM schedule_executions
WHERE event_source_id = :sourceId AND status = 'executed' AND executed_at >= :monthStart
```

Window boundaries are calculated in the source's configured timezone using `Intl.DateTimeFormat` with `getTimezoneOffsetMs()` for UTC conversion. Calendar-aligned boundaries: top of hour, midnight, Monday 00:00, 1st of month.

### nextRunAt Calculation

The `calculateNextRunAt()` method is public (used by routes for resume):

- **Interval type**: `lastRunAt + interval` seconds. If result is in the past, advances by the correct number of missed intervals.
- **Cron type**: Uses `cron-parser` (`CronExpressionParser.parse()`) with timezone support. Advances until the next occurrence is in the future.
- Throws on invalid cron expression or unknown schedule type.

### Consecutive Error Handling

After 5 consecutive errors (`MAX_CONSECUTIVE_ERRORS = 5`), the source status transitions to `'error'` and a `schedule:paused` SSE event is published with `reason: 'consecutive_errors'`. The source must be manually resumed.

### Recovery on Startup

The `recoverSchedules()` method runs before the first tick:

- Queries all enabled, active cron sources
- Sources with `nextRunAt` in the past: advance to next future occurrence (missed executions are NOT retroactively fired)
- Sources with `null` nextRunAt: calculate first occurrence
- Sources with future nextRunAt: no action

### Public Methods (for API routes)

| Method | Returns | Description |
|--------|---------|-------------|
| `triggerManual(sourceId)` | `Result<ManualTriggerResult, AppError>` | Execute source immediately; respects budget; does not affect `nextRunAt` |
| `pauseSource(sourceId)` | `Result<{id, status, pausedAt}, AppError>` | Set status to `'disabled'`, preserve `nextRunAt` |
| `resumeSource(sourceId)` | `Result<{id, status, nextRunAt, resumedAt}, AppError>` | Set status to `'active'`, recalculate `nextRunAt`, reset errors |
| `getBudgetRemaining(sourceId, config)` | Budget remaining per window | Returns `null` for unconfigured windows |
| `getBudgetStatus(sourceId, config)` | `{ limits: Record<window, {limit, used, remaining}> }` | Full budget status with usage counts |

---

## CronEventSourcePlugin

Defined in `src/lib/events/plugins/cron-plugin.ts`. Implements `EventSourcePlugin`.

### Key Behaviors

- **`verifySignature()`** -- Always returns `ok(true)`. No external webhook to verify.
- **`parseEvent()`** -- Deserializes `CronTickContext` from the `rawBody` JSON string, constructs a `NormalizedEvent` with event type `schedule.tick` or `schedule.manual_trigger`.
- **`matchesFilter()`** -- Only the `action` field is meaningful (`tick` or `manual`). All other filter fields (repo, branch, labels, author) always match.
- **`getEventTypes()`** -- Returns `schedule.tick` and `schedule.manual_trigger`.
- **`getTemplateVariables()`** -- Returns 11 variables in the `schedule.*` namespace.

### CronTickContext

```typescript
export interface CronTickContext {
  sourceName: string;
  config: CronEventSourceConfig;
  executionCount: number;
  trigger: 'tick' | 'manual';
}
```

---

## API Routes

All schedule-specific endpoints are defined in `src/server/routes/events.ts` under the "Schedule-Specific Endpoints" section. They are mounted under `/api/events/`.

### Schedule-Specific Endpoints

| Method | Path | Auth Role | Description |
|--------|------|-----------|-------------|
| `POST` | `/sources/:id/trigger` | `agent_operator` | Manually trigger a cron source |
| `POST` | `/sources/:id/pause` | `agent_operator` | Pause a cron source |
| `POST` | `/sources/:id/resume` | `agent_operator` | Resume a paused/errored source |
| `GET` | `/sources/:id/budget` | `viewer` | Get budget status with usage counts |
| `GET` | `/sources/:id/executions` | `viewer` | List execution history (cursor-paginated) |

### Existing Endpoints with Cron Behavior

| Method | Path | Cron Behavior |
|--------|------|---------------|
| `POST` | `/sources` | Creates cron source when `type: 'cron'`; validates config |
| `PATCH` | `/sources/:id` | Merges config; schedule changes trigger `nextRunAt` recalculation |
| `GET` | `/sources` | Supports `type=cron` filter; returns cron sources alongside others |

### Response Format

All endpoints follow the standard response structure:

```typescript
// Success
{ ok: true, data: T }

// Error
{ ok: false, error: { code: string, message: string } }
```

### Execution History Pagination

The executions endpoint supports cursor-based pagination with filters:

- **cursor**: Opaque `scheduledAt|id` string
- **limit**: 1-100, default 50
- **status**: Filter by `executed`, `skipped_budget`, `skipped_disabled`, `error`
- **since/until**: ISO 8601 datetime filters on `scheduledAt`

Ordered by `scheduledAt` descending (newest first).

---

## Validation Schemas

Defined in `src/lib/validation/cron-event-sources.ts`:

| Schema | Purpose |
|--------|---------|
| `createCronEventSourceSchema` | Create: requires `teamId`, `name`, `config` (discriminated union on `scheduleType`) |
| `updateCronEventSourceSchema` | Update: partial config merge |
| `manualTriggerSchema` | Optional `promptOverride` (max 10000 chars) |
| `listExecutionsSchema` | Execution history query params with coerced limit |
| `budgetConfigSchema` | Budget limits with non-decreasing constraint: `hour <= day <= week <= month` |

Timezone validation uses `Intl.DateTimeFormat` constructor (throws `RangeError` for invalid IANA timezones). Cron expression validation uses a 5-field regex pattern.

---

## Error Codes

Defined in `src/lib/errors/event-errors.ts` as `ScheduleErrors`:

| Code | HTTP | Factory | Description |
|------|------|---------|-------------|
| `SCHEDULE_INVALID_CRON` | 400 | `INVALID_CRON(expression)` | Invalid 5-field cron expression |
| `SCHEDULE_INVALID_INTERVAL` | 400 | `INVALID_INTERVAL(interval)` | Interval below 60 seconds |
| `SCHEDULE_INVALID_TIMEZONE` | 400 | `INVALID_TIMEZONE(timezone)` | Invalid IANA timezone |
| `SCHEDULE_BUDGET_EXCEEDED` | 429 | `BUDGET_EXCEEDED(sourceId, window)` | Budget limit reached |
| `SCHEDULE_SOURCE_PAUSED` | 422 | `SOURCE_PAUSED(sourceId)` | Source is paused or in error state |
| `SCHEDULE_EXECUTION_FAILED` | 500 | `EXECUTION_FAILED(sourceId, reason)` | Pipeline processing failure |
| `SCHEDULE_NOT_CRON_TYPE` | 400 | `NOT_CRON_TYPE(sourceId)` | Source exists but is not type `'cron'` |
| `SCHEDULE_ALREADY_PAUSED` | 409 | `ALREADY_PAUSED(sourceId)` | Source is already paused |
| `SCHEDULE_ALREADY_ACTIVE` | 409 | `ALREADY_ACTIVE(sourceId)` | Source is already active |

---

## Event System Integration

### SSE Events

The scheduler publishes events via `publishEventToStream()` from `src/lib/events/event-bus.ts`. Connected SSE clients receive these on the existing `GET /api/events/stream` endpoint:

| SSE Event | When | Key Data |
|-----------|------|----------|
| `schedule:executed` | Source executed successfully | `executionId`, `eventSourceId`, `taskIds` |
| `schedule:skipped` | Execution skipped (budget) | `eventSourceId`, `reason`, `window` |
| `schedule:error` | Execution failed | `eventSourceId`, `executionId`, `error` |
| `schedule:paused` | Source auto-paused (5 errors) or manually paused | `eventSourceId`, `reason` (`consecutive_errors` or `manual`) |
| `schedule:resumed` | Source resumed | `eventSourceId`, `nextRunAt` |

### processScheduledEvent Pipeline

The `EventProcessingService` (in `src/services/event-processing.service.ts`) provides `processScheduledEvent()` as the entry point for cron events. This method:

1. Skips slug lookup, signature verification, and plugin parsing (already done by scheduler)
2. Shares the `processEventPipeline()` method with webhook events
3. The shared pipeline handles: deduplication via `deliveryId`, event log insertion, subscription matching, filter evaluation via plugin `matchesFilter()`, template rendering, task creation, and optional column move (which can trigger agent auto-start)

### Template Variables

The template engine (`src/lib/events/template-engine.ts`) populates the `schedule.*` namespace in `buildTemplateContext()`:

| Variable | Source | Example |
|----------|--------|---------|
| `{{schedule.name}}` | `event.data.scheduleName` | `Daily code review` |
| `{{schedule.lastRunAt}}` | `event.data.lastRunAt` | `2026-03-01T09:00:00Z` |
| `{{schedule.executionCount}}` | `event.data.executionCount` | `42` |
| `{{schedule.cronExpression}}` | `event.data.cronExpression` | `0 9 * * 1-5` |
| `{{schedule.interval}}` | `event.data.interval` | `3600` |
| `{{schedule.scheduleType}}` | `event.data.scheduleType` | `cron` |
| `{{schedule.timezone}}` | `event.raw.schedule.timezone` | `America/New_York` |
| `{{timestamp}}` | `event.raw.timestamp` | `2026-03-02T09:00:00Z` |
| `{{trigger}}` | `event.raw.trigger` | `tick` |
| `{{event.type}}` | `event.type` | `schedule.tick` |
| `{{event.action}}` | `event.action` | `tick` |

---

## State Machines

### Schedule Lifecycle

```
                                    +-------------+
                                    |             |
                                    v             |
         +-------------+  pause  +-------------+ |
  ------>|   active     |-------->|   paused    | |
         +------+-------+        +------+-------+ |
                |                       |          |
                | 5 consecutive         | resume   |
                | errors                |          |
                v                       |          |
         +-------------+               |          |
         |    error     |--- resume ---+          |
         +------+-------+                         |
                |                                  |
                | disable             disable      | disable
      +---------+--------------------+-------------+
      v                              |
+-------------+                      |
|  disabled   |<---------------------+
+-------------+
```

**State mapping to `event_sources` columns:**

| State | `isEnabled` | `status` |
|-------|-------------|----------|
| `active` | `true` | `'active'` |
| `paused` | `true` | `'disabled'` |
| `error` | `true` | `'error'` |
| `disabled` (terminal) | `false` | `'disabled'` |

### Execution Lifecycle

Each row in `schedule_executions` transitions through: pending -> budget_check -> (skipped_budget | skipped_disabled | executing -> (completed | error)).

---

## Schedule Types

| Type | Config Field | Constraints | Description |
|------|-------------|-------------|-------------|
| Interval | `interval` (seconds) | Min 60, max 2,592,000 | Simple repeating: run every N seconds |
| Cron Expression | `cronExpression` | Standard 5-field | minute hour day-of-month month day-of-week |

**Cron expression examples:**

| Expression | Description |
|------------|-------------|
| `*/15 * * * *` | Every 15 minutes |
| `0 9 * * 1-5` | 9:00 AM weekdays |
| `0 0 * * 0` | Midnight every Sunday |
| `0 0 1 * *` | First day of every month at midnight |

---

## Dependencies

| Package | Usage |
|---------|-------|
| `cron-parser` | `CronExpressionParser.parse()` for cron expression evaluation with timezone |
| `@paralleldrive/cuid2` | `createId()` for execution IDs |
| `drizzle-orm` | Database queries, JSON field extraction via `sql` template tag |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Task Service](./task-service.md) | Task creation in `in_progress` column triggers agent auto-start |
| [Agent Service](./agent-service.md) | Agent auto-start on scheduled task creation |
| [Session Service](./session-service.md) | SSE stream carries `schedule:*` events |
| [Database Schema](../database/schema.md) | FK references to `event_sources`, `event_subscriptions`, `tasks` |
| [API Endpoints](../api/endpoints.md) | Schedule endpoints follow same response format and cursor pagination |
| [Error Catalog](../errors/error-catalog.md) | `SCHEDULE_*` error codes |
| [App Bootstrap](../architecture/app-bootstrap.md) | Scheduler started during server initialization |
| [Operations / Monitoring](../operations/monitoring.md) | Scheduler metrics and logging |

---

## Original Specification

The original multi-file specification that informed this implementation is archived at `specs/archive/task-scheduling-original/`.
