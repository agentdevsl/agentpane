# Task Scheduling System - Scheduler Service

## Overview

The `SchedulerService` is a background service that runs a polling loop to execute cron event sources on schedule. It is started during server initialization and stopped during graceful shutdown. On each tick (default: every 30 seconds), it queries the database for enabled cron event sources whose `nextRunAt` has passed, enforces budget limits, generates synthetic events via the `CronEventSourcePlugin`, and feeds those events into the existing event processing pipeline.

The service is designed for single-instance deployment. It uses compare-and-swap (CAS) row locking on the `nextRunAt` field to prevent duplicate execution in edge cases, but does not support distributed scheduling across multiple server instances.

---

## Service Lifecycle

### Start

Called during application bootstrap (phase 5 of the 6-phase initialization sequence, after database and services are ready):

```typescript
// src/server/bootstrap.ts (excerpt)

import { SchedulerService } from '@/services/scheduler.service';

// Phase 5: Start background services
const schedulerService = new SchedulerService(db, pluginRegistry, eventProcessingService);
await schedulerService.start();

// Store reference for graceful shutdown
app.set('schedulerService', schedulerService);
```

### Stop

Called during graceful shutdown to cancel the tick loop and allow in-flight executions to complete:

```typescript
// src/server/shutdown.ts (excerpt)

const schedulerService = app.get('schedulerService');
if (schedulerService) {
  await schedulerService.stop();
}
```

### Restart Recovery

On startup, the service runs a recovery pass before entering the tick loop. This handles sources that may have missed executions while the server was down:

```
1. Query all enabled cron sources (type = 'cron', status = 'active')
2. For each source:
   a. If nextRunAt is null: calculate first nextRunAt from config and set it
   b. If nextRunAt is in the past: calculate the NEXT future occurrence and update
   c. If nextRunAt is in the future: no action needed
3. Log recovery summary: "Recovered N schedules, M had missed executions"
```

**Important:** Missed executions are NOT retroactively fired. When the server recovers after downtime, it skips past occurrences and advances `nextRunAt` to the next future time. This prevents a burst of stale executions on restart.

---

## Service Implementation

```typescript
// src/services/scheduler.service.ts

import type { CronEventSourceConfig } from '@/lib/events/plugins/cron-types';
import type { CronTickContext } from '@/lib/events/plugins/cron-plugin';
import type { PluginRegistry } from '@/lib/events/plugin-registry';
import type { EventProcessingService } from './event-processing.service';
import type { Database } from '@/types/database';
import { createLogger } from '@/lib/logging/logger';
import { eq, and, lte, sql } from 'drizzle-orm';
import { eventSources } from '@/db/schema';
import { scheduleExecutions } from '@/db/schema/sqlite/schedule-executions';
import { createId } from '@paralleldrive/cuid2';
import { parseExpression } from 'cron-parser';

const log = createLogger('SchedulerService');

export class SchedulerService {
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private activeExecutions = new Set<string>();

  // Configuration (can be overridden via environment variables)
  private readonly tickIntervalMs: number;
  private readonly concurrencyLimit: number;
  private readonly enabled: boolean;
  private readonly minInterval: number;

  constructor(
    private db: Database,
    private pluginRegistry: PluginRegistry,
    private eventProcessingService: EventProcessingService,
  ) {
    this.tickIntervalMs = Number(process.env.SCHEDULER_TICK_INTERVAL_MS) || 30_000;
    this.concurrencyLimit = Number(process.env.SCHEDULER_CONCURRENCY_LIMIT) || 5;
    this.enabled = process.env.SCHEDULER_ENABLED !== 'false';
    this.minInterval = Number(process.env.SCHEDULER_MIN_INTERVAL) || 60;
  }

  /**
   * Start the scheduler.
   *
   * 1. Run recovery pass to fix stale nextRunAt values
   * 2. Start the periodic tick loop
   */
  async start(): Promise<void> {
    if (!this.enabled) {
      log.info('Scheduler disabled via SCHEDULER_ENABLED=false');
      return;
    }

    if (this.isRunning) {
      log.warn('Scheduler already running, ignoring start()');
      return;
    }

    log.info('Starting scheduler', {
      data: {
        tickIntervalMs: this.tickIntervalMs,
        concurrencyLimit: this.concurrencyLimit,
      },
    });

    // Recovery pass
    await this.recoverSchedules();

    // Start tick loop
    this.isRunning = true;
    this.tickInterval = setInterval(() => this.tick(), this.tickIntervalMs);

    // Run first tick immediately
    await this.tick();

    log.info('Scheduler started');
  }

  /**
   * Stop the scheduler gracefully.
   *
   * Cancels the tick interval and waits for all in-flight executions to
   * complete (up to 30 seconds).
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    log.info('Stopping scheduler...');
    this.isRunning = false;

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    // Wait for active executions to drain (30s timeout)
    const deadline = Date.now() + 30_000;
    while (this.activeExecutions.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (this.activeExecutions.size > 0) {
      log.warn('Scheduler stopped with active executions', {
        data: { remaining: this.activeExecutions.size },
      });
    }

    log.info('Scheduler stopped');
  }

  // ... (continued below)
}
```

---

## Tick Loop

The core scheduling loop runs every `SCHEDULER_TICK_INTERVAL_MS` (default: 30 seconds):

```typescript
/**
 * Single tick of the scheduling loop.
 *
 * 1. Query all enabled cron sources where nextRunAt <= now
 * 2. Process each due source with concurrency limit
 * 3. Log tick summary
 */
private async tick(): Promise<void> {
  if (!this.isRunning) return;

  const tickStart = Date.now();
  const now = new Date().toISOString();

  // Query due sources
  const dueSources = await this.db.query.eventSources.findMany({
    where: and(
      eq(eventSources.type, 'cron'),
      eq(eventSources.status, 'active'),
      eq(eventSources.isEnabled, true),
      lte(sql`json_extract(${eventSources.config}, '$.nextRunAt')`, now),
    ),
  });

  if (dueSources.length === 0) return;

  log.info('Tick: processing due sources', {
    data: { dueCount: dueSources.length },
  });

  // Process with concurrency limit
  const results = {
    executed: 0,
    skippedBudget: 0,
    skippedLock: 0,
    errors: 0,
  };

  // Process in batches of concurrencyLimit
  for (let i = 0; i < dueSources.length; i += this.concurrencyLimit) {
    const batch = dueSources.slice(i, i + this.concurrencyLimit);
    const batchResults = await Promise.allSettled(
      batch.map((source) => this.processSource(source, 'tick')),
    );

    for (const result of batchResults) {
      if (result.status === 'rejected') {
        results.errors++;
      } else {
        switch (result.value) {
          case 'executed': results.executed++; break;
          case 'skipped_budget': results.skippedBudget++; break;
          case 'skipped_lock': results.skippedLock++; break;
          case 'error': results.errors++; break;
        }
      }
    }
  }

  log.info('Tick complete', {
    data: {
      durationMs: Date.now() - tickStart,
      ...results,
    },
  });
}
```

### Tick Sequence Diagram

```
Every 30 seconds:

  ┌──────────────────────────────────────────────────────────────┐
  │  Query: SELECT * FROM event_sources                          │
  │  WHERE type = 'cron'                                         │
  │    AND status = 'active'                                     │
  │    AND is_enabled = 1                                        │
  │    AND json_extract(config, '$.nextRunAt') <= datetime('now')│
  └──────────────────┬───────────────────────────────────────────┘
                     │
                     ▼
            ┌────────────────┐
            │ For each source │ (parallel, max 5)
            │ (due sources)   │
            └────────┬───────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ Acquire │ │ Acquire │ │ Acquire │
   │ CAS lock│ │ CAS lock│ │ CAS lock│
   └────┬────┘ └────┬────┘ └────┬────┘
        │            │            │
        ▼            ▼            ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ Check   │ │ Check   │ │ Check   │
   │ budget  │ │ budget  │ │ budget  │
   └────┬────┘ └────┬────┘ └────┬────┘
        │            │            │
        ▼            ▼            ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │Generate │ │Generate │ │Generate │
   │ event   │ │ event   │ │ event   │
   └────┬────┘ └────┬────┘ └────┬────┘
        │            │            │
        ▼            ▼            ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ Feed to │ │ Feed to │ │ Feed to │
   │pipeline │ │pipeline │ │pipeline │
   └────┬────┘ └────┬────┘ └────┬────┘
        │            │            │
        ▼            ▼            ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ Record  │ │ Record  │ │ Record  │
   │execution│ │execution│ │execution│
   └────┬────┘ └────┬────┘ └────┬────┘
        │            │            │
        ▼            ▼            ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ Update  │ │ Update  │ │ Update  │
   │nextRunAt│ │nextRunAt│ │nextRunAt│
   └─────────┘ └─────────┘ └─────────┘
```

---

## Locking Strategy

The service uses a compare-and-swap (CAS) pattern on the `nextRunAt` field within the event source's `config` JSON column. This provides lightweight row-level locking without requiring explicit SQLite locking primitives.

### Acquiring the Lock

```typescript
/**
 * Attempt to acquire an exclusive lock on a cron source by atomically
 * updating nextRunAt via compare-and-swap.
 *
 * If another tick already updated nextRunAt (i.e., the expected value
 * no longer matches), the UPDATE affects 0 rows and we skip this source.
 */
private async acquireLock(
  sourceId: string,
  expectedNextRunAt: string,
  newNextRunAt: string,
): Promise<boolean> {
  const result = await this.db.run(sql`
    UPDATE event_sources
    SET config = json_set(
          json_set(config, '$.nextRunAt', ${newNextRunAt}),
          '$.lastRunAt', ${new Date().toISOString()}
        ),
        updated_at = datetime('now')
    WHERE id = ${sourceId}
      AND json_extract(config, '$.nextRunAt') = ${expectedNextRunAt}
  `);

  return result.changes > 0;
}
```

### Why CAS Instead of Row Locks

| Approach | Pros | Cons |
|----------|------|------|
| SQLite row locks (`BEGIN EXCLUSIVE`) | Strong isolation | Blocks all other writes; poor concurrency |
| CAS on `nextRunAt` | Non-blocking; concurrent reads allowed | Small window for double-check (acceptable for 30s tick) |
| External lock (Redis, file lock) | Well-understood pattern | Adds external dependency; unnecessary for single-instance |

The CAS approach is optimal for single-instance SQLite deployments. The `nextRunAt` field serves double duty as both the scheduling trigger and the lock sentinel.

---

## Source Processing

```typescript
/**
 * Process a single cron event source.
 *
 * Returns the outcome status for tick-level aggregation.
 */
private async processSource(
  source: EventSource,
  trigger: 'tick' | 'manual',
): Promise<'executed' | 'skipped_budget' | 'skipped_lock' | 'error'> {
  const config = source.config as CronEventSourceConfig;
  const executionStart = Date.now();
  const executionId = createId();

  // Track active execution
  this.activeExecutions.add(executionId);

  try {
    // Step 1: Calculate next run time
    const newNextRunAt = this.calculateNextRunAt(config);

    // Step 2: Acquire CAS lock (skip if another tick got here first)
    if (trigger === 'tick') {
      const locked = await this.acquireLock(
        source.id,
        config.nextRunAt!,
        newNextRunAt,
      );
      if (!locked) {
        log.debug('Skipped source (lock contention)', { data: { sourceId: source.id } });
        return 'skipped_lock';
      }
    }

    // Step 3: Check budget limits
    const budgetResult = await this.checkBudget(source.id, config);
    if (!budgetResult.ok) {
      await this.recordExecution(source.id, 'skipped_budget', trigger, executionStart);
      log.info('Skipped source (budget exceeded)', {
        data: { sourceId: source.id, window: budgetResult.window },
      });
      return 'skipped_budget';
    }

    // Step 4: Get execution count for context
    const executionCount = await this.getExecutionCount(source.id);

    // Step 5: Build CronTickContext and serialize as rawBody
    const tickContext: CronTickContext = {
      sourceName: source.name,
      config,
      executionCount,
      trigger,
    };

    // Step 6: Get the cron plugin and generate the event
    const plugin = this.pluginRegistry.get('cron');
    if (!plugin) {
      log.error('Cron plugin not registered');
      return 'error';
    }

    const parseResult = plugin.parseEvent(
      new Headers(),
      JSON.stringify(tickContext),
    );

    if (!parseResult.ok) {
      await this.recordExecution(source.id, 'error', trigger, executionStart, parseResult.error.message);
      return 'error';
    }

    // Step 7: Feed the normalized event into the existing processing pipeline.
    //
    // NOTE: processScheduledEvent is a NEW method to be added to EventProcessingService.
    // Unlike processIncomingEvent (which takes a sourceSlug + raw headers/body and performs
    // slug lookup, signature verification, and deduplication), processScheduledEvent accepts
    // an already-resolved EventSource and NormalizedEvent directly. It bypasses slug lookup,
    // signature verification, and deduplication (since cron events are internal and have
    // scheduler-generated deliveryIds), and proceeds directly to: event log insertion,
    // subscription matching, template rendering, and task creation.
    //
    // Signature: processScheduledEvent(source: EventSource, event: NormalizedEvent): Promise<Result<ProcessingResult, AppError>>
    const processingResult = await this.eventProcessingService.processScheduledEvent(
      source,
      parseResult.value,
    );

    // Step 8: Record execution
    const tasksCreated = processingResult.ok ? processingResult.value.tasksCreated : [];
    const eventLogId = processingResult.ok ? processingResult.value.eventLogId : undefined;

    await this.recordExecution(
      source.id,
      processingResult.ok ? 'executed' : 'error',
      trigger,
      executionStart,
      processingResult.ok ? undefined : processingResult.error.message,
      eventLogId,
      tasksCreated,
    );

    // Step 9: Check consecutive error count
    if (!processingResult.ok) {
      await this.checkConsecutiveErrors(source.id);
      return 'error';
    }

    log.info('Source executed successfully', {
      data: {
        sourceId: source.id,
        tasksCreated: tasksCreated.length,
        durationMs: Date.now() - executionStart,
      },
    });

    return 'executed';
  } catch (err) {
    log.error('Unexpected error processing source', {
      data: { sourceId: source.id },
      error: err,
    });
    await this.recordExecution(source.id, 'error', trigger, executionStart, String(err));
    await this.checkConsecutiveErrors(source.id);
    return 'error';
  } finally {
    this.activeExecutions.delete(executionId);
  }
}
```

---

## Budget Enforcement

Budget limits prevent runaway costs from misconfigured schedules. Each budget window is checked independently; if any window is exceeded, the execution is skipped.

### Algorithm

```typescript
interface BudgetCheckResult {
  ok: boolean;
  window?: string;
}

/**
 * Check all configured budget limits for a cron source.
 *
 * For each budget window (hour, day, week, month), count the number of
 * successful executions within that window. If any count meets or exceeds
 * the configured limit, the execution is denied.
 */
private async checkBudget(
  sourceId: string,
  config: CronEventSourceConfig,
): Promise<BudgetCheckResult> {
  const { budget } = config;
  if (!budget) return { ok: true };

  const windows: Array<{ name: string; limit: number | undefined; start: string }> = [
    { name: 'hour', limit: budget.maxPerHour, start: this.getWindowStart('hour', config.timezone) },
    { name: 'day', limit: budget.maxPerDay, start: this.getWindowStart('day', config.timezone) },
    { name: 'week', limit: budget.maxPerWeek, start: this.getWindowStart('week', config.timezone) },
    { name: 'month', limit: budget.maxPerMonth, start: this.getWindowStart('month', config.timezone) },
  ];

  for (const window of windows) {
    if (window.limit === undefined) continue;

    const count = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(scheduleExecutions)
      .where(
        and(
          eq(scheduleExecutions.eventSourceId, sourceId),
          eq(scheduleExecutions.status, 'executed'),
          sql`${scheduleExecutions.executedAt} >= ${window.start}`,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);

    if (count >= window.limit) {
      return { ok: false, window: window.name };
    }
  }

  return { ok: true };
}
```

### Window Boundary Calculation

Window boundaries are calculated in the source's configured timezone to align with the user's expectations:

```typescript
/**
 * Calculate the start of a budget window in the source's configured timezone.
 *
 * - hour:  Start of current hour (e.g., 14:00:00)
 * - day:   Start of current day (00:00:00 in source timezone)
 * - week:  Monday 00:00:00 in source timezone
 * - month: First of month 00:00:00 in source timezone
 */
private getWindowStart(
  window: 'hour' | 'day' | 'week' | 'month',
  timezone: string,
): string {
  const now = new Date();

  // Format current time in the source's timezone to extract date parts
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((p) => [p.type, p.value]),
  );

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);

  switch (window) {
    case 'hour': {
      // Current hour start in the timezone
      const dt = new Date(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:00:00`);
      return toTimezoneISO(dt, timezone);
    }
    case 'day': {
      // Midnight in the timezone
      const dt = new Date(`${year}-${pad(month)}-${pad(day)}T00:00:00`);
      return toTimezoneISO(dt, timezone);
    }
    case 'week': {
      // Monday 00:00:00 in the timezone
      const current = new Date(`${year}-${pad(month)}-${pad(day)}T00:00:00`);
      const dayOfWeek = current.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      current.setDate(current.getDate() - daysToMonday);
      return toTimezoneISO(current, timezone);
    }
    case 'month': {
      // First of month 00:00:00 in the timezone
      const dt = new Date(`${year}-${pad(month)}-01T00:00:00`);
      return toTimezoneISO(dt, timezone);
    }
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toTimezoneISO(date: Date, timezone: string): string {
  // Implementation must convert timezone-local boundary to UTC for database comparison.
  // Consider using date-fns-tz or Temporal API.
  //
  // The `date` parameter represents a wall-clock time in the target timezone
  // (e.g., "2026-03-02T00:00:00" meaning midnight in America/New_York).
  // This function must compute the actual UTC instant for that wall-clock time.
  //
  // Approach using Intl.DateTimeFormat:
  // 1. Use Intl.DateTimeFormat with timeZone option to format `new Date()` in the
  //    target timezone, extracting the current UTC offset for that timezone.
  // 2. Apply the inverse offset to the input date to produce the correct UTC timestamp.
  // 3. Return the result as an ISO 8601 string.
  //
  // Example: midnight Eastern (UTC-5) should return "2026-03-02T05:00:00.000Z"
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  });
  const parts = formatter.formatToParts(date);
  const offsetPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? '+0';
  // Parse offset string (e.g., "GMT-5", "GMT+5:30") into minutes
  const match = offsetPart.match(/GMT([+-]?)(\d{1,2})(?::(\d{2}))?/);
  if (!match) return date.toISOString(); // fallback for UTC/GMT
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  const offsetMs = sign * (hours * 60 + minutes) * 60_000;
  // The input `date` was constructed as if in the target timezone,
  // so subtract the offset to get the true UTC instant.
  return new Date(date.getTime() - offsetMs).toISOString();
}
```

### Budget Window Examples

Given a cron source with `timezone: 'America/New_York'` and current time `2026-03-02T14:35:00-05:00`:

| Window | Start | Description |
|--------|-------|-------------|
| `hour` | `2026-03-02T14:00:00-05:00` | Current hour |
| `day` | `2026-03-02T00:00:00-05:00` | Midnight Eastern |
| `week` | `2026-03-02T00:00:00-05:00` | Monday (March 2 is Monday) |
| `month` | `2026-03-01T00:00:00-05:00` | First of March |

---

## nextRunAt Calculation

The `nextRunAt` field determines when a cron source will next be eligible for execution. It is updated after each execution (or on recovery).

```typescript
/**
 * Calculate the next execution time for a cron source.
 *
 * For interval-based sources: lastRunAt + interval seconds (or now + interval if never run).
 * For cron-based sources: next cron occurrence after lastRunAt (or now) in the configured timezone.
 */
private calculateNextRunAt(config: CronEventSourceConfig): string {
  const now = new Date();
  const baseTime = config.lastRunAt ? new Date(config.lastRunAt) : now;

  if (config.scheduleType === 'interval') {
    const intervalMs = (config.interval ?? 60) * 1000;
    const next = new Date(baseTime.getTime() + intervalMs);
    // If the calculated next time is in the past (e.g., after recovery),
    // advance to the next future interval
    if (next <= now) {
      const elapsed = now.getTime() - baseTime.getTime();
      const missedIntervals = Math.ceil(elapsed / intervalMs);
      return new Date(baseTime.getTime() + missedIntervals * intervalMs).toISOString();
    }
    return next.toISOString();
  }

  if (config.scheduleType === 'cron' && config.cronExpression) {
    const interval = parseExpression(config.cronExpression, {
      currentDate: baseTime,
      tz: config.timezone,
    });

    let next = interval.next().toDate();

    // Advance past 'now' if the next occurrence is in the past
    while (next <= now) {
      next = interval.next().toDate();
    }

    return next.toISOString();
  }

  // Fallback: 60 seconds from now
  return new Date(now.getTime() + 60_000).toISOString();
}
```

### cron-parser Library

The `cron-parser` npm package is used for parsing standard cron expressions with timezone support:

```bash
bun add cron-parser
```

**Supported cron expression format:** Standard 5-field cron (`minute hour day-of-month month day-of-week`).

| Field | Values | Special Characters |
|-------|--------|--------------------|
| Minute | 0-59 | `* , - /` |
| Hour | 0-23 | `* , - /` |
| Day of month | 1-31 | `* , - /` |
| Month | 1-12 | `* , - /` |
| Day of week | 0-7 (0 and 7 = Sunday) | `* , - /` |

**Examples:**

| Expression | Description |
|------------|-------------|
| `0 9 * * 1-5` | 9:00 AM weekdays |
| `*/15 * * * *` | Every 15 minutes |
| `0 0 * * *` | Midnight daily |
| `0 10 * * 1` | 10:00 AM every Monday |
| `0 0 1 * *` | Midnight on the 1st of each month |

---

## Manual Trigger

Manual triggering allows users to execute a cron source on demand without waiting for the next scheduled tick.

### API Endpoint

```
POST /api/events/sources/:id/trigger
```

**Authorization:** `agent_operator` or above

**Request Body:**
```typescript
// No body required; the source ID comes from the URL path
```

**Response (200):**
```typescript
{
  ok: true,
  data: {
    executionId: string,
    status: 'executed' | 'skipped_budget' | 'error',
    tasksCreated: string[],
    durationMs: number
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `EVENT_SOURCE_NOT_FOUND` | Source not found or not a cron source |
| 422 | `SCHEDULE_SOURCE_PAUSED` | Source is paused (status = `disabled`) |
| 429 | `SCHEDULE_BUDGET_EXCEEDED` | Budget limit reached for current window |

### Behavior

```typescript
/**
 * Trigger a manual execution of a cron source.
 *
 * - Bypasses interval/cron timing check (executes immediately)
 * - Still respects budget limits
 * - Records as schedule.manual_trigger event type
 * - Does NOT reset nextRunAt (manual triggers are independent of the schedule)
 */
async triggerManual(sourceId: string): Promise<Result<ManualTriggerResult, AppError>> {
  const sourceResult = await this.eventSourceService.getById(sourceId);
  if (!sourceResult.ok) return sourceResult;

  const source = sourceResult.value;
  if (source.type !== 'cron') {
    return err(EventErrors.SOURCE_NOT_FOUND());
  }
  if (source.status === 'disabled') {
    return err(ScheduleErrors.SOURCE_PAUSED(sourceId));
  }

  const result = await this.processSource(source, 'manual');
  // ... return formatted result
}
```

### Manual vs. Scheduled Execution

| Aspect | Scheduled (tick) | Manual (trigger) |
|--------|-----------------|-----------------|
| Timing | Respects `nextRunAt` schedule | Immediate |
| Budget | Enforced | Enforced |
| CAS lock | Acquired (prevents double-fire) | Not needed (explicit user action) |
| `nextRunAt` update | Advanced to next occurrence | Not modified |
| Event type | `schedule.tick` | `schedule.manual_trigger` |
| Event action | `tick` | `manual` |

---

## Pause / Resume

### Pause

```
POST /api/events/sources/:id/pause
```

**Authorization:** `agent_operator` or above

**Behavior:**
1. Sets the event source `status` to `'disabled'` (keeps `isEnabled: true` -- only the terminal `disabled` state via explicit deletion/permanent disable sets `isEnabled: false`)
2. The scheduler's tick loop skips disabled sources in its query
3. Manual trigger also rejects paused sources with `SCHEDULE_SOURCE_PAUSED`
4. `nextRunAt` is preserved so the schedule can resume without recalculation

**Response (200):**
```typescript
{
  ok: true,
  data: { source: EventSource }
}
```

### Resume

```
POST /api/events/sources/:id/resume
```

**Authorization:** `agent_operator` or above

**Behavior:**
1. Sets the event source `status` to `'active'` and `isEnabled` to `true`
2. Recalculates `nextRunAt` from the current time (not from the original schedule)
3. If the source was in `'error'` status, the consecutive error count is reset
4. The source becomes eligible for the next tick loop iteration

```typescript
async resumeSource(sourceId: string): Promise<Result<EventSource, AppError>> {
  const sourceResult = await this.eventSourceService.getById(sourceId);
  if (!sourceResult.ok) return sourceResult;

  const source = sourceResult.value;
  const config = source.config as CronEventSourceConfig;

  // Recalculate nextRunAt from now
  const newNextRunAt = this.calculateNextRunAt({
    ...config,
    lastRunAt: new Date().toISOString(),
  });

  // Update source: re-enable and set next run time
  return this.eventSourceService.update(sourceId, {
    isEnabled: true,
    config: {
      ...config,
      nextRunAt: newNextRunAt,
    },
  });
}
```

**Response (200):**
```typescript
{
  ok: true,
  data: { source: EventSource, nextRunAt: string }
}
```

---

## Error Handling

### Per-Source Error Isolation

Individual source errors never stop the tick loop. Each source is processed independently within a `Promise.allSettled()` call, so a failure in one source does not affect others:

```typescript
const batchResults = await Promise.allSettled(
  batch.map((source) => this.processSource(source, 'tick')),
);
```

### Error Recording

All execution outcomes are recorded in the `schedule_executions` table:

```typescript
private async recordExecution(
  eventSourceId: string,
  status: ScheduleExecutionStatus,
  trigger: 'tick' | 'manual',
  startTime: number,
  error?: string,
  eventLogId?: string,
  tasksCreated?: string[],
): Promise<void> {
  await this.db.insert(scheduleExecutions).values({
    id: createId(),
    eventSourceId,
    status,
    trigger,
    eventLogId,
    tasksCreated: tasksCreated ?? [],
    durationMs: Date.now() - startTime,
    error,
    executedAt: new Date().toISOString(),
  });
}
```

### Consecutive Error Threshold

After 5 consecutive errors, the source transitions to `'error'` status and requires manual intervention (resume) to re-enable:

```typescript
private static readonly MAX_CONSECUTIVE_ERRORS = 5;

/**
 * Check if a source has exceeded the consecutive error threshold.
 * If so, transition the source to 'error' status.
 */
private async checkConsecutiveErrors(sourceId: string): Promise<void> {
  // Count the most recent consecutive 'error' executions
  const recentExecutions = await this.db.query.scheduleExecutions.findMany({
    where: eq(scheduleExecutions.eventSourceId, sourceId),
    orderBy: [desc(scheduleExecutions.executedAt)],
    limit: SchedulerService.MAX_CONSECUTIVE_ERRORS,
  });

  const allErrors = recentExecutions.every((e) => e.status === 'error');
  if (allErrors && recentExecutions.length >= SchedulerService.MAX_CONSECUTIVE_ERRORS) {
    log.warn('Source exceeded consecutive error threshold, disabling', {
      data: { sourceId, consecutiveErrors: recentExecutions.length },
    });

    await this.db
      .update(eventSources)
      .set({ status: 'error', updatedAt: new Date().toISOString() })
      .where(eq(eventSources.id, sourceId));
    // Note: isEnabled stays true. The 'error' state keeps isEnabled: true, status: 'error'.
    // Only the 'disabled' terminal state (explicit user action) sets isEnabled: false.
  }
}
```

### Error Recovery

When a source is resumed from `'error'` status:
1. The status transitions back to `'active'`
2. The consecutive error count effectively resets (since new successful executions will break the streak)
3. `nextRunAt` is recalculated from the current time

---

## Metrics / Observability

### Tick-Level Logging

Every tick logs a summary:

```json
{
  "level": "info",
  "message": "Tick complete",
  "data": {
    "durationMs": 245,
    "executed": 3,
    "skippedBudget": 1,
    "skippedLock": 0,
    "errors": 0
  }
}
```

### Execution-Level Logging

Each source execution logs:

```json
{
  "level": "info",
  "message": "Source executed successfully",
  "data": {
    "sourceId": "clx1a2b3c4d5",
    "tasksCreated": 2,
    "durationMs": 187
  }
}
```

### SSE Events

Schedule executions emit SSE events on the existing `GET /api/events/stream` endpoint:

| SSE Event | When | Data |
|-----------|------|------|
| `schedule:executed` | Source executed successfully | `{ sourceId, executionId, tasksCreated, trigger }` |
| `schedule:skipped` | Execution skipped (budget/disabled) | `{ sourceId, reason }` |
| `schedule:error` | Execution failed | `{ sourceId, error }` |
| `schedule:status_change` | Source status changed (active/disabled/error) | `{ sourceId, oldStatus, newStatus }` |

### Monitoring Queries

**Execution rate by source (last 24 hours):**
```sql
SELECT event_source_id, status, COUNT(*) as count
FROM schedule_executions
WHERE executed_at >= datetime('now', '-24 hours')
GROUP BY event_source_id, status
ORDER BY count DESC;
```

**Average execution duration by source:**
```sql
SELECT event_source_id, AVG(duration_ms) as avg_ms, MAX(duration_ms) as max_ms
FROM schedule_executions
WHERE status = 'executed'
  AND executed_at >= datetime('now', '-7 days')
GROUP BY event_source_id;
```

**Sources in error state:**
```sql
SELECT es.id, es.name, es.status,
       (SELECT COUNT(*) FROM schedule_executions se
        WHERE se.event_source_id = es.id AND se.status = 'error'
          AND se.executed_at >= datetime('now', '-1 hour')) as recent_errors
FROM event_sources es
WHERE es.type = 'cron' AND es.status = 'error';
```

---

## Configuration

| Setting | Environment Variable | Default | Description |
|---------|---------------------|---------|-------------|
| Tick interval | `SCHEDULER_TICK_INTERVAL_MS` | `30000` (30s) | How often the scheduler polls for due sources. Lower values increase database load but reduce scheduling latency. |
| Concurrency limit | `SCHEDULER_CONCURRENCY_LIMIT` | `5` | Maximum number of sources processed in parallel per tick. Prevents CPU/database contention from many simultaneous executions. |
| Enabled | `SCHEDULER_ENABLED` | `true` | Master kill switch. Set to `false` to completely disable the scheduler. Useful during maintenance or debugging. |
| Minimum interval | `SCHEDULER_MIN_INTERVAL` | `60` | Minimum allowed interval in seconds for interval-type schedules. Enforced during event source creation/update validation. |

### Configuration Validation

```typescript
// Validated during event source creation/update
if (config.scheduleType === 'interval') {
  if (config.interval < this.minInterval) {
    return err(ScheduleErrors.INVALID_INTERVAL(config.interval));
  }
}

if (config.scheduleType === 'cron') {
  try {
    parseExpression(config.cronExpression!);
  } catch {
    return err(ScheduleErrors.INVALID_CRON(config.cronExpression!));
  }
}

// Validate timezone
const validTimezones = Intl.supportedValuesOf('timeZone');
if (!validTimezones.includes(config.timezone)) {
  return err(ScheduleErrors.INVALID_TIMEZONE(config.timezone));
}
```

---

## Server Restart Recovery

The recovery pass runs once during `start()`, before the tick loop begins:

```typescript
/**
 * Recover schedules after a server restart.
 *
 * For each enabled cron source, ensure nextRunAt points to a future time.
 * If the server was down for a period, nextRunAt may be in the past --
 * in which case we advance it to the next future occurrence WITHOUT
 * retroactively firing the missed executions.
 */
private async recoverSchedules(): Promise<void> {
  const cronSources = await this.db.query.eventSources.findMany({
    where: and(
      eq(eventSources.type, 'cron'),
      eq(eventSources.status, 'active'),
      eq(eventSources.isEnabled, true),
    ),
  });

  let recovered = 0;
  let missed = 0;

  for (const source of cronSources) {
    const config = source.config as CronEventSourceConfig;

    if (!config.nextRunAt) {
      // Never been scheduled: calculate first run
      const nextRunAt = this.calculateNextRunAt(config);
      await this.updateNextRunAt(source.id, nextRunAt);
      recovered++;
      continue;
    }

    const nextRunAt = new Date(config.nextRunAt);
    if (nextRunAt <= new Date()) {
      // nextRunAt is in the past: advance to next future occurrence
      const newNextRunAt = this.calculateNextRunAt(config);
      await this.updateNextRunAt(source.id, newNextRunAt);
      recovered++;
      missed++;
    }
  }

  log.info('Schedule recovery complete', {
    data: {
      totalSources: cronSources.length,
      recovered,
      missedExecutions: missed,
    },
  });
}

/**
 * Update nextRunAt in the config JSON for a source.
 */
private async updateNextRunAt(sourceId: string, nextRunAt: string): Promise<void> {
  await this.db.run(sql`
    UPDATE event_sources
    SET config = json_set(config, '$.nextRunAt', ${nextRunAt}),
        updated_at = datetime('now')
    WHERE id = ${sourceId}
  `);
}
```

### Recovery Scenarios

| Scenario | Server Down Duration | nextRunAt on Restart | Action |
|----------|---------------------|---------------------|--------|
| Brief restart (< tick interval) | 30 seconds | Still in future | No action |
| Short outage | 5 minutes | In the past | Advance to next occurrence |
| Extended outage | 24 hours | Far in the past | Advance to next occurrence (skip all missed) |
| New source (never run) | N/A | `null` | Calculate first occurrence |
| Source with `lastRunAt` | 2 hours | In the past | Advance from `lastRunAt` to next future time |

---

## API Endpoint Summary

New endpoints added to support cron event source management:

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| `POST` | `/api/events/sources/:id/trigger` | Yes | `agent_operator` | Manually trigger a cron source |
| `POST` | `/api/events/sources/:id/pause` | Yes | `agent_operator` | Pause a cron source |
| `POST` | `/api/events/sources/:id/resume` | Yes | `agent_operator` | Resume a paused/errored cron source |
| `GET` | `/api/events/sources/:id/executions` | Yes | `viewer` | List execution history for a source |

### GET /api/events/sources/:id/executions

List execution history with cursor-based pagination.

**Query Parameters:**

```typescript
const listExecutionsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().min(1).max(100).default(50),
  status: z.enum(SCHEDULE_EXECUTION_STATUS).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});
```

**Response:**

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

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Cron Plugin](./cron-plugin.md) | `CronEventSourcePlugin` generates events consumed by this service |
| [Plugin Interface](../event-plugin-system/plugin-interface.md) | Pipeline integration via `EventSourcePlugin` interface |
| [Event Processing](../event-plugin-system/state-machine.md) | Cron events flow through the same state machine as webhooks |
| [Database Schema](../event-plugin-system/database-schema.md) | Cron config stored in `event_sources.config`; new `schedule_executions` table |
| [API Endpoints](../event-plugin-system/api-endpoints.md) | New trigger/pause/resume/executions endpoints |
| [App Bootstrap](../application/architecture/app-bootstrap.md) | Scheduler started in phase 5 of initialization |
| [Operations / Monitoring](../application/operations/monitoring.md) | Scheduler metrics and logging |
| [Error Catalog](../application/errors/error-catalog.md) | `SCHEDULE_*` error codes |
