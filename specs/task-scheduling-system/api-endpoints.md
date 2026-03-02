# Task Scheduling System - API Endpoints

## Overview

Scheduling-specific REST API endpoints that extend the existing event source management. Cron event sources are created and updated through the standard event source CRUD endpoints (`POST /api/events/sources`, `PATCH /api/events/sources/:id`) with `type: 'cron'` and schedule-specific configuration in the JSON `config` field. The endpoints below handle operations unique to scheduled sources: manual triggering, budget inspection, execution history, and pause/resume lifecycle control.

Follows the existing AgentPane API patterns: Hono router, consistent `ok/error` response structure, Zod validation, cursor-based pagination, and RBAC authorization.

---

## Response Format

Follows the existing AgentPane response format:

```typescript
// Success
{ "ok": true, "data": T }

// Error
{ "ok": false, "error": { "code": string, "message": string, "details"?: object } }
```

---

## Schedule-Specific Endpoints

### POST /api/events/sources/:id/trigger

Manually trigger a scheduled event source. The trigger bypasses the scheduler tick loop but still enforces budget limits and feeds through the standard event processing pipeline. Manual triggers are recorded in `schedule_executions` with `trigger: 'manual'`.

**Authorization**: `agent_operator` or above

**Path Parameters:**
- `id` - The event source ID

**Request Body:**

```typescript
const manualTriggerSchema = z.object({
  /** Optional: override the prompt template for this trigger only */
  promptOverride: z.string().max(10000).optional(),
});
```

**Processing:**

1. Verify source exists and belongs to the authenticated user's team.
2. Verify source type is `'cron'`.
3. Verify source status is `'active'` (not paused or disabled).
4. Check budget limits -- manual triggers count against all configured budget windows.
5. Generate a synthetic `NormalizedEvent` with `type: 'schedule.manual_trigger'`, `action: 'manual'`.
6. Feed the event into the event processing pipeline (skip signature verification and deduplication).
7. Record execution in `schedule_executions` with `trigger: 'manual'`.
8. Return the execution result including created task IDs and remaining budget.

**Response (200):**

```typescript
{
  ok: true,
  data: {
    triggered: true,
    executionId: string,
    taskIds: string[],       // tasks created from matched subscriptions
    budgetRemaining: {
      hour: number | null,   // null = unlimited (no limit configured)
      day: number | null,
      week: number | null,
      month: number | null,
    }
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `EVENT_SOURCE_NOT_FOUND` | Source does not exist or not in user's team |
| 400 | `SCHEDULE_NOT_CRON_TYPE` | Source exists but is not type `'cron'` |
| 422 | `SCHEDULE_SOURCE_PAUSED` | Source is paused or disabled; resume before triggering |
| 429 | `SCHEDULE_BUDGET_EXCEEDED` | All configured budget windows are exhausted |

**Notes:**
- The `promptOverride` field, if provided, replaces the subscription's `promptTemplate` for this execution only. It does not modify the subscription.
- Manual triggers do not affect `nextRunAt` -- the next scheduled tick fires at its originally calculated time.
- If the source has multiple subscriptions, all matching subscriptions produce tasks (same as a scheduled tick).

---

### GET /api/events/sources/:id/budget

Get remaining budget for a cron event source across all configured time windows. Returns current usage and next reset time for each window.

**Authorization**: `viewer` or above

**Path Parameters:**
- `id` - The event source ID

**Response (200):**

```typescript
{
  ok: true,
  data: {
    limits: {
      hour: { limit: number | null, used: number, remaining: number | null },
      day: { limit: number | null, used: number, remaining: number | null },
      week: { limit: number | null, used: number, remaining: number | null },
      month: { limit: number | null, used: number, remaining: number | null },
    },
    nextResetAt: {
      hour: string,    // ISO 8601 -- top of the next hour
      day: string,     // ISO 8601 -- midnight in source timezone
      week: string,    // ISO 8601 -- Monday 00:00 in source timezone
      month: string,   // ISO 8601 -- 1st of next month 00:00 in source timezone
    }
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `EVENT_SOURCE_NOT_FOUND` | Source does not exist or not in user's team |
| 400 | `SCHEDULE_NOT_CRON_TYPE` | Source exists but is not type `'cron'` |

**Notes:**
- `limit: null` means no limit is configured for that window; `remaining` is also `null` in that case.
- `used` counts only executions with `status = 'executed'` within the current window.
- Reset times are calculated using the source's configured `timezone` (from `config.timezone`, defaults to UTC).

---

### GET /api/events/sources/:id/executions

List execution history for a cron event source with cursor-based pagination. Each execution represents a single scheduled or manual trigger attempt.

**Authorization**: `viewer` or above

**Path Parameters:**
- `id` - The event source ID

**Query Parameters:**

```typescript
const listExecutionsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().min(1).max(100).default(50),
  /** Filter by execution status */
  status: z.enum(['executed', 'skipped_budget', 'skipped_disabled', 'error']).optional(),
  /** Filter executions after this timestamp (inclusive) */
  since: z.string().datetime().optional(),
  /** Filter executions before this timestamp (inclusive) */
  until: z.string().datetime().optional(),
});
```

**Response (200):**

```typescript
{
  ok: true,
  data: {
    items: ScheduleExecution[],
    nextCursor: string | null,
    hasMore: boolean,
    totalCount: number
  }
}
```

**ScheduleExecution shape:**

```typescript
// Matches the schedule_executions table schema in database-schema.md
interface ScheduleExecution {
  id: string;
  eventSourceId: string;
  status: 'executed' | 'skipped_budget' | 'skipped_disabled' | 'error';
  scheduledAt: string;                // ISO 8601 -- the nextRunAt that triggered execution
  executedAt: string;                 // ISO 8601 -- when processing ran
  taskId: string | null;              // task created by this execution (null if skipped/error)
  subscriptionId: string | null;      // matched subscription (null if skipped/no match)
  budgetWindow: 'hour' | 'day' | 'week' | 'month' | null; // exceeded window (if skipped_budget)
  windowExecutionCount: number;       // count within the checked budget window
  error: string | null;               // error message if status is 'error'
  createdAt: string;                  // ISO 8601
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `EVENT_SOURCE_NOT_FOUND` | Source does not exist or not in user's team |
| 400 | `SCHEDULE_NOT_CRON_TYPE` | Source exists but is not type `'cron'` |

**Notes:**
- Results are ordered by `scheduledAt` descending (newest first).
- The `since` and `until` filters apply to the `scheduledAt` field.
- Cursor is opaque and based on `(scheduledAt, id)` for stable pagination.

---

### POST /api/events/sources/:id/pause

Pause a scheduled event source. The SchedulerService will skip this source on subsequent ticks. The source retains its `nextRunAt` value so it can be resumed without recalculation.

**Authorization**: `agent_operator` or above

**Path Parameters:**
- `id` - The event source ID

**Processing:**

1. Verify source exists and belongs to the authenticated user's team.
2. Verify source type is `'cron'`.
3. Verify source status is `'active'` (not already paused or disabled).
4. Set source status to `'disabled'` (mapped to `paused` in the schedule lifecycle state machine).
5. Record the pause timestamp in `config.pausedAt`.
6. Emit `schedule:paused` SSE event with `reason: 'manual'`.

**Response (200):**

```typescript
{
  ok: true,
  data: {
    id: string,
    status: 'disabled',
    pausedAt: string   // ISO 8601
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `EVENT_SOURCE_NOT_FOUND` | Source does not exist or not in user's team |
| 400 | `SCHEDULE_NOT_CRON_TYPE` | Source exists but is not type `'cron'` |
| 409 | `SCHEDULE_ALREADY_PAUSED` | Source is already paused or disabled |

**Notes:**
- Pausing does not cancel any in-flight execution that has already entered the pipeline.
- The `nextRunAt` is preserved; when resumed, the source may fire immediately if `nextRunAt` is in the past.

---

### POST /api/events/sources/:id/resume

Resume a paused or errored scheduled event source. Recalculates `nextRunAt` from the current time and resets the consecutive error counter if resuming from error state.

**Authorization**: `agent_operator` or above

**Path Parameters:**
- `id` - The event source ID

**Processing:**

1. Verify source exists and belongs to the authenticated user's team.
2. Verify source type is `'cron'`.
3. Verify source status is `'disabled'` (paused) or `'error'` -- cannot resume an already active source.
4. Recalculate `nextRunAt` based on the schedule configuration and current time.
5. Set source status to `'active'`.
6. If resuming from error state, reset `config.consecutiveErrors` to `0`.
7. Remove `config.pausedAt` if present.
8. Emit `schedule:resumed` SSE event.

**Response (200):**

```typescript
{
  ok: true,
  data: {
    id: string,
    status: 'active',
    nextRunAt: string,   // ISO 8601 -- recalculated from now
    resumedAt: string    // ISO 8601
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `EVENT_SOURCE_NOT_FOUND` | Source does not exist or not in user's team |
| 400 | `SCHEDULE_NOT_CRON_TYPE` | Source exists but is not type `'cron'` |
| 409 | `SCHEDULE_ALREADY_ACTIVE` | Source is already active |

**Notes:**
- `nextRunAt` is always recalculated forward from `now()`, not from the old `nextRunAt`. This prevents a burst of catch-up executions after a long pause.
- Resuming from error state is identical to resuming from paused, except the consecutive error counter is reset.

---

## Updates to Existing Endpoints

### POST /api/events/sources (Create)

When `type: 'cron'` is specified, the `config` field is validated against the `CronEventSourceConfig` schema:

```typescript
const cronConfigSchema = z.object({
  /** Schedule type: fixed interval or cron expression */
  scheduleType: z.enum(['interval', 'cron']),
  /** Interval in seconds (required if scheduleType is 'interval') */
  interval: z.number().min(60).max(2592000).optional(),
  /** Standard 5-field cron expression (required if scheduleType is 'cron') */
  cronExpression: z.string().max(100).optional(),
  /** IANA timezone for cron evaluation and budget window resets */
  timezone: z.string().min(1).default('UTC'),
  /** Execution budget limits per time window */
  budget: z.object({
    maxPerHour: z.number().int().positive().optional(),
    maxPerDay: z.number().int().positive().optional(),
    maxPerWeek: z.number().int().positive().optional(),
    maxPerMonth: z.number().int().positive().optional(),
  }).optional().default({}),
}).refine(
  (data) => data.scheduleType === 'interval' ? !!data.interval : !!data.cronExpression,
  'interval required for interval type, cronExpression required for cron type'
);
```

**Additional notes:**
- `webhookSecret` is auto-generated server-side but unused for cron sources (no external webhook receiver).
- `slug` is still required and must be unique -- used for internal identification and API path consistency.
- `nextRunAt` is calculated server-side on creation based on the schedule configuration and current time.
- `lastRunAt` is initially `null`.
- `config.consecutiveErrors` is initialized to `0`.
- The `cronExpression` is validated against standard 5-field cron syntax; 6-field (with seconds) and 7-field (with year) are rejected.

---

### PATCH /api/events/sources/:id (Update)

When updating a cron source's config, partial updates are merged with the existing config using shallow merge. Changing any schedule-affecting field triggers `nextRunAt` recalculation:

| Field Changed | Triggers `nextRunAt` Recalculation |
|---------------|-----------------------------------|
| `scheduleType` | Yes |
| `interval` | Yes |
| `cronExpression` | Yes |
| `timezone` | Yes |
| `budget` | No |

**Notes:**
- Setting `isEnabled: false` via the standard PATCH endpoint transitions the schedule to the `disabled` state (permanent). To temporarily stop a schedule, use `POST /api/events/sources/:id/pause` instead.
- Updating budget limits takes effect immediately; in-flight executions are not retroactively affected.

---

## SSE Events for Schedules

The existing `GET /api/events/stream` SSE endpoint emits additional event types for cron sources. These events are scoped to the authenticated user's team.

```typescript
// Schedule execution completed successfully
event: schedule:executed
data: {
  executionId: string,
  eventSourceId: string,
  status: 'executed',
  taskIds: string[],
  budgetRemaining: {
    hour: number | null,
    day: number | null,
    week: number | null,
    month: number | null,
  }
}

// Schedule execution skipped due to budget limit
event: schedule:skipped
data: {
  eventSourceId: string,
  reason: 'budget_exceeded',
  window: 'hour' | 'day' | 'week' | 'month',
  limit: number,
  used: number
}

// Schedule execution encountered an error
event: schedule:error
data: {
  eventSourceId: string,
  executionId: string,
  error: string,
  consecutiveErrors: number
}

// Schedule auto-paused after consecutive errors
event: schedule:paused
data: {
  eventSourceId: string,
  reason: 'consecutive_errors' | 'manual',
  errorCount: number
}
```

**Notes:**
- The `schedule:paused` event with `reason: 'consecutive_errors'` is emitted when the schedule transitions to error state after 5 consecutive failures.
- The `schedule:paused` event with `reason: 'manual'` is emitted when a user calls `POST /api/events/sources/:id/pause`.
- Budget remaining values of `null` indicate no limit is configured for that window.

---

## Endpoint Summary

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| `POST` | `/api/events/sources/:id/trigger` | Yes | `agent_operator` | Manually trigger a cron source |
| `GET` | `/api/events/sources/:id/budget` | Yes | `viewer` | Get budget status for a cron source |
| `GET` | `/api/events/sources/:id/executions` | Yes | `viewer` | List execution history (paginated) |
| `POST` | `/api/events/sources/:id/pause` | Yes | `agent_operator` | Pause a cron source |
| `POST` | `/api/events/sources/:id/resume` | Yes | `agent_operator` | Resume a paused/errored cron source |

**Existing endpoints with cron-specific behavior:**

| Method | Path | Auth | Role | Cron Behavior |
|--------|------|------|------|---------------|
| `POST` | `/api/events/sources` | Yes | `admin` | Validates `config` against `cronConfigSchema` when `type: 'cron'` |
| `PATCH` | `/api/events/sources/:id` | Yes | `admin` | Merges config; recalculates `nextRunAt` on schedule changes |
| `GET` | `/api/events/stream` | Yes | `viewer` | Emits `schedule:*` SSE events for cron sources |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [State Machine](./state-machine.md) | Schedule lifecycle and execution lifecycle state machines |
| [Database Schema](./database-schema.md) | `schedule_executions` table, `CronEventSourceConfig` shape |
| [Scheduler Service](./scheduler-service.md) | Background tick loop that triggers scheduled executions |
| [Cron Plugin](./cron-plugin.md) | `CronEventSourcePlugin` generates synthetic events |
| [Scheduler Service](./scheduler-service.md) | Budget window counting and limit evaluation |
| [Event Plugin API](../event-plugin-system/api-endpoints.md) | Existing CRUD endpoints for event sources and subscriptions |
| [Event Plugin State Machine](../event-plugin-system/state-machine.md) | Event processing pipeline reused by cron executions |
| [Prompt Templates](../event-plugin-system/prompt-templates.md) | Template variables for cron events: `{{schedule.name}}`, `{{execution.time}}` |
| [API Endpoints](../application/api/endpoints.md) | Follows same response format and patterns |
| [Pagination](../application/api/pagination.md) | Cursor-based pagination for execution history |
| [RBAC](../rbac-auth/) | Role hierarchy: owner > admin > agent_operator > viewer |
| [Error Catalog](../application/errors/error-catalog.md) | Schedule-specific error codes extend the existing catalog |
