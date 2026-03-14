# Task Scheduling System - State Machines

## Overview

Defines two state machines for the Task Scheduling System: the **Schedule Lifecycle** governing the overall state of a cron event source, and the **Execution Lifecycle** governing each individual scheduled or manual trigger attempt. Both machines are synchronous within their respective contexts -- the schedule lifecycle is driven by API calls and error accumulation, while the execution lifecycle runs within a single scheduler tick or manual trigger request.

---

## State Machine 1: Schedule Lifecycle

The lifecycle of a cron event source from creation to permanent disablement. This state machine governs whether the SchedulerService will fire the source on its next tick.

### State Diagram

```
                                        ┌──────────────┐
                                        │              │
                                        ▼              │
           ┌─────────────┐   pause   ┌─────────────┐  │
  ────────>│   active     │─────────>│   paused     │  │
           └──────┬───────┘          └──────┬───────┘  │
                  │                         │          │
                  │  5 consecutive          │  resume   │
                  │  errors                 │          │
                  │                         │          │
                  ▼                         │          │
           ┌─────────────┐                 │          │
           │    error     │──── resume ────┘          │
           └──────┬───────┘                           │
                  │                                    │
                  │                                    │
                  │  disable                disable    │  disable
        ┌────────┴────────────────────┬───────────────┘
        │                             │
        ▼                             │
  ┌──────────────┐                    │
  │   disabled    │◄───────────────────┘
  └──────────────┘
```

### States

| State | Description | Terminal | SchedulerService Behavior |
|-------|-------------|----------|---------------------------|
| `active` | Schedule is running; will fire when `nextRunAt <= now()` | No | Included in tick query; CAS lock and execute |
| `paused` | Schedule is manually paused by a user | No | Excluded from tick query; `nextRunAt` preserved |
| `error` | Schedule has accumulated 5+ consecutive errors; requires user intervention | No | Excluded from tick query; auto-paused by system |
| `disabled` | Schedule is permanently disabled via `isEnabled: false` | Yes | Excluded from tick query; cannot be resumed |

### Transitions

| From | To | Trigger | Guard | API |
|------|----|---------|-------|-----|
| `active` | `paused` | User pauses | Source status is `active` | `POST /api/events/sources/:id/pause` |
| `active` | `error` | Consecutive error threshold | `config.consecutiveErrors >= 5` | Automatic (SchedulerService) |
| `active` | `disabled` | User disables permanently | `isEnabled` set to `false` | `PATCH /api/events/sources/:id` with `isEnabled: false` |
| `paused` | `active` | User resumes | Source status is `paused` | `POST /api/events/sources/:id/resume` |
| `paused` | `disabled` | User disables permanently | `isEnabled` set to `false` | `PATCH /api/events/sources/:id` with `isEnabled: false` |
| `error` | `active` | User resumes | Source status is `error`; resets `consecutiveErrors` to 0 | `POST /api/events/sources/:id/resume` |
| `error` | `disabled` | User disables permanently | `isEnabled` set to `false` | `PATCH /api/events/sources/:id` with `isEnabled: false` |

### State Mapping

The schedule lifecycle states map to existing `event_sources` columns as follows:

| Lifecycle State | `isEnabled` | `status` | `config.consecutiveErrors` |
|-----------------|-------------|----------|---------------------------|
| `active` | `true` | `'active'` | `< 5` |
| `paused` | `true` | `'disabled'` | N/A (preserved from before pause) |
| `error` | `true` | `'error'` | `>= 5` |
| `disabled` | `false` | `'disabled'` | N/A |

### Consecutive Error Tracking

When an execution fails:

1. Increment `config.consecutiveErrors` by 1.
2. If `config.consecutiveErrors >= 5`, transition to `error` state.
3. Emit `schedule:paused` SSE event with `reason: 'consecutive_errors'`.

When an execution succeeds:

1. Reset `config.consecutiveErrors` to `0`.

When a user resumes from `error` state:

1. Reset `config.consecutiveErrors` to `0`.
2. Recalculate `nextRunAt` from current time.
3. Transition to `active`.

---

## State Machine 2: Execution Lifecycle

Each individual schedule execution (one row in `schedule_executions`) progresses through these states. The lifecycle begins when the SchedulerService tick identifies a due source or when a user calls the manual trigger endpoint.

### State Diagram

```
  ┌───────────┐
  │  pending   │
  └─────┬─────┘
        │
        ▼
  ┌──────────────┐    source paused     ┌───────────────────┐
  │ budget_check  │───── or disabled ───>│  skipped_disabled  │
  └──────┬───────┘                      └───────────────────┘
         │
    ┌────┴─────┐
    │          │
    │ pass     │ fail
    │          │
    ▼          ▼
  ┌───────────┐  ┌─────────────────┐
  │ executing  │  │ skipped_budget   │
  └─────┬─────┘  └─────────────────┘
        │
   ┌────┴─────┐
   │          │
   │ success  │ failure
   │          │
   ▼          ▼
  ┌───────────┐  ┌───────────┐
  │ completed  │  │   error    │
  └───────────┘  └───────────┘
```

### States

| State | Description | Terminal | Recorded In |
|-------|-------------|----------|-------------|
| `pending` | Execution queued; `nextRunAt` reached or manual trigger received | No | `schedule_executions` |
| `budget_check` | Evaluating budget limits across all configured time windows | No | `schedule_executions` |
| `executing` | Budget passed; running event processing pipeline (match, template, create task) | No | `schedule_executions` |
| `completed` | Execution succeeded; task(s) created and agent(s) started | Yes | `schedule_executions` |
| `skipped_budget` | Skipped because one or more budget windows are exhausted | Yes | `schedule_executions` |
| `skipped_disabled` | Skipped because source is paused or disabled (race condition with tick query) | Yes | `schedule_executions` |
| `error` | Execution failed during pipeline processing | Yes | `schedule_executions` |

### Transitions

| From | To | Trigger | Guard |
|------|----|---------|-------|
| `pending` | `budget_check` | Execution dequeued for processing | Source acquired via CAS lock |
| `budget_check` | `skipped_disabled` | Source status check | `source.status !== 'active'` or `source.isEnabled === false` |
| `budget_check` | `skipped_budget` | Budget limit exceeded | Any configured window has `used >= limit` |
| `budget_check` | `executing` | All budget checks pass | All configured windows have `used < limit` (or no limits configured) |
| `executing` | `completed` | Pipeline succeeds | Event processed, subscriptions matched, tasks created |
| `executing` | `error` | Pipeline fails | Exception during matching, template rendering, or task creation |

### Pipeline Integration

The `executing` state delegates to the existing event processing pipeline with modifications for cron sources:

```typescript
// Simplified execution flow within the 'executing' state

async function executeScheduledSource(
  source: EventSource,
  execution: ScheduleExecution,
  promptOverride?: string,
): Promise<void> {
  // 1. Generate synthetic NormalizedEvent
  const event: NormalizedEvent = {
    type: execution.trigger === 'manual' ? 'schedule.manual_trigger' : 'schedule.tick',
    action: execution.trigger === 'manual' ? 'manual' : 'tick',
    deliveryId: execution.id,  // use execution ID as delivery ID
    timestamp: new Date().toISOString(),
    raw: {
      sourceId: source.id,
      sourceName: source.name,
      scheduleType: source.config.scheduleType,
      expression: source.config.cronExpression || `every ${source.config.interval}s`,
      timezone: source.config.timezone,
      executionId: execution.id,
      trigger: execution.trigger,
    },
  };

  // 2. Skip signature verification (no external webhook)
  // 3. Skip deduplication (scheduler CAS handles this)

  // 4. Match subscriptions
  const enabledSubs = await getEnabledSubscriptions(source.id);
  const matchedSubs = enabledSubs.filter((sub) => matchesSubscription(sub, event));

  // 5. Render templates and create tasks
  const taskIds: string[] = [];
  for (const sub of matchedSubs) {
    const prompt = promptOverride || renderTemplate(sub.promptTemplate, event);
    const taskId = await createTaskFromSubscription(sub, event, source.type, prompt);
    taskIds.push(taskId);
  }

  // 6. Update execution record
  await updateExecution(execution.id, {
    status: 'executed',
    taskIds,
    completedAt: new Date().toISOString(),
  });
}
```

---

## Budget Window Reset Logic

Budget windows reset at fixed boundaries based on the source's configured timezone. The reset is not based on rolling windows -- it uses calendar-aligned boundaries.

### Window Boundaries

| Window | Resets At | Example (timezone: `America/New_York`) |
|--------|-----------|----------------------------------------|
| **Hour** | Top of each hour | 14:00:00, 15:00:00, 16:00:00, ... |
| **Day** | Midnight in source timezone | 00:00:00 EST each day |
| **Week** | Monday 00:00 in source timezone | Monday 00:00:00 EST |
| **Month** | 1st of month 00:00 in source timezone | 2026-04-01 00:00:00 EST |

### Budget Check Algorithm

```
function checkBudget(sourceId: string, config: CronEventSourceConfig): BudgetResult {
  const tz = config.timezone || 'UTC';
  const now = new Date();

  for (const window of ['hour', 'day', 'week', 'month']) {
    const limit = config.budget[`maxPer${capitalize(window)}`];
    if (limit === undefined || limit === null) {
      continue;  // no limit configured for this window
    }

    const windowStart = calculateWindowStart(window, tz, now);
    const executionCount = COUNT(*) FROM schedule_executions
      WHERE eventSourceId = :sourceId
      AND status = 'executed'
      AND executedAt >= :windowStart;

    if (executionCount >= limit) {
      return {
        allowed: false,
        exceededWindow: window,
        limit: limit,
        used: executionCount,
      };
    }
  }

  return { allowed: true };
}
```

### Window Start Calculation

```typescript
function calculateWindowStart(window: string, timezone: string, now: Date): Date {
  // Convert 'now' to the source's timezone, then find the boundary
  switch (window) {
    case 'hour':
      // Start of the current hour
      return startOfHour(now);
    case 'day':
      // Midnight today in source timezone
      return startOfDayInTimezone(now, timezone);
    case 'week':
      // Most recent Monday 00:00 in source timezone
      return startOfWeekInTimezone(now, timezone);  // Monday = start of week
    case 'month':
      // 1st of current month 00:00 in source timezone
      return startOfMonthInTimezone(now, timezone);
  }
}
```

### Budget Edge Cases

| Scenario | Behavior |
|----------|----------|
| **No budget configured** | All windows return `allowed: true`; schedule runs without limits |
| **Multiple windows exceeded** | First exceeded window (checked in order: hour, day, week, month) is reported |
| **Manual trigger + scheduled trigger in same window** | Both count toward the same budget counters |
| **Timezone DST transition** | Window boundaries follow the timezone rules; a "day" may be 23 or 25 hours during DST transitions |
| **Budget changed mid-window** | New limits apply immediately; existing execution counts are not retroactively adjusted |

---

## Timing

| Stage | Expected Duration | Timeout |
|-------|-------------------|---------|
| Budget check | < 10ms | 5s (database query) |
| Event generation (synthetic) | < 5ms | N/A (CPU-bound) |
| Subscription matching | < 50ms | 5s |
| Template rendering | < 10ms | N/A (CPU-bound) |
| Task creation (per match) | < 100ms | 10s (database + optional agent start) |
| Pipeline processing (total) | < 500ms | 30s (hard timeout) |
| **Total execution** | **< 600ms typical** | **30s hard timeout** |

### Scheduler Tick Timing

| Parameter | Value | Notes |
|-----------|-------|-------|
| Tick interval | 30 seconds | `setInterval` in SchedulerService |
| Maximum sources per tick | 50 | Prevents tick from exceeding interval |
| CAS lock duration | Implicit (update `nextRunAt` atomically) | No explicit lock timeout |
| Minimum effective schedule interval | 30 seconds | Limited by tick rate |
| Startup recovery delay | 5 seconds | Grace period before first tick after server start |

---

## Error Handling

### Execution Error Details

| Error Scenario | Execution Status | Schedule Impact | Recovery |
|----------------|-----------------|-----------------|----------|
| Budget exceeded | `skipped_budget` | None; `nextRunAt` still advances | Automatic on next window reset |
| Source paused/disabled (race) | `skipped_disabled` | None | Resume the source |
| Subscription matching failure | `error` | Increments `consecutiveErrors` | Fix filter configuration |
| Template rendering failure | `error` | Increments `consecutiveErrors` | Fix prompt template |
| Task creation failure | `error` | Increments `consecutiveErrors` | Check target project exists |
| Database error | `error` | Increments `consecutiveErrors` | Investigate database health |
| Pipeline timeout (30s) | `error` | Increments `consecutiveErrors` | Investigate slow queries |

### Partial Failure

If a source has multiple matching subscriptions and task creation fails partway through:

1. Tasks already created by earlier subscriptions in the batch are **kept** (not rolled back).
2. The execution is marked as `error` with details about which subscription failed.
3. `config.consecutiveErrors` is incremented.
4. The `taskIds` array on the execution record contains only the successfully created task IDs.

### Auto-Pause Threshold

The consecutive error threshold of 5 is chosen to balance between:
- **Too low** (e.g., 1-2): Transient errors (database hiccup, brief network issue) would pause schedules unnecessarily.
- **Too high** (e.g., 20+): A misconfigured schedule would accumulate many failed executions before being stopped.

At the default 30-second tick interval, 5 consecutive errors means the schedule is auto-paused within approximately 2.5 minutes of persistent failure.

---

## SSE Event Emission

At each execution state transition, SSE events are emitted to connected clients via `GET /api/events/stream`:

| Execution State | SSE Event | Data |
|-----------------|-----------|------|
| `completed` | `schedule:executed` | `{ executionId, eventSourceId, status, taskIds, budgetRemaining }` |
| `skipped_budget` | `schedule:skipped` | `{ eventSourceId, reason, window, limit, used }` |
| `error` | `schedule:error` | `{ eventSourceId, executionId, error, consecutiveErrors }` |
| Schedule -> `error` (auto-pause) | `schedule:paused` | `{ eventSourceId, reason: 'consecutive_errors', errorCount }` |
| Schedule -> `paused` (manual) | `schedule:paused` | `{ eventSourceId, reason: 'manual', errorCount: 0 }` |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [API Endpoints](./api-endpoints.md) | Pause/resume/trigger endpoints drive schedule lifecycle transitions |
| [Database Schema](./database-schema.md) | `schedule_executions` table stores execution state; `CronEventSourceConfig` stores lifecycle metadata |
| [Scheduler Service](./scheduler-service.md) | Background tick loop creates `pending` executions and drives transitions |
| [Cron Plugin](./cron-plugin.md) | Generates synthetic `NormalizedEvent` during the `executing` state |
| [Scheduler Service](./scheduler-service.md) | Budget check algorithm and window calculations |
| [Event Plugin State Machine](../event-plugin-system/state-machine.md) | Event processing pipeline reused during `executing` state |
| [Event Plugin API](../event-plugin-system/api-endpoints.md) | SSE stream carries `schedule:*` events alongside `event:*` events |
| [Task Service](../application/services/task-service.md) | Task creation at the `completed` transition |
| [Agent Service](../application/services/agent-service.md) | Agent auto-start triggered by task creation in `in_progress` column |
| [Error Catalog](../application/errors/error-catalog.md) | `SCHEDULE_*` error codes for API responses |
