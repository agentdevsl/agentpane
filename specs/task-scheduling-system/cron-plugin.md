# Task Scheduling System - Cron Event Source Plugin

## Overview

The `CronEventSourcePlugin` implements the `EventSourcePlugin` interface for internally-generated scheduled events. Unlike webhook-based plugins (GitHub, Linear, Jira, generic webhook), cron events are not triggered by external HTTP requests. Instead, the background `SchedulerService` calls into this plugin to generate synthetic `NormalizedEvent` objects on each schedule tick.

Because cron events originate internally, several interface methods behave differently from webhook plugins:

| Method | Webhook Plugins | Cron Plugin |
|--------|----------------|-------------|
| `verifySignature` | Validates HMAC against external payload | Always succeeds -- no external signature to verify |
| `parseEvent` | Parses raw HTTP body from external system | Generates a synthetic `NormalizedEvent` from schedule config |
| `matchesFilter` | Evaluates repo, branch, labels, author, action | Only `action` is meaningful; other fields always match |

The cron plugin is registered in the plugin registry under the `'cron'` type and is invoked exclusively by the `SchedulerService` -- it is never called from the public webhook endpoint (`POST /hooks/events/:slug`).

---

## Plugin Registry Update

The `cron` type is added to the `EventSourceType` enum and the plugin is registered alongside the existing plugins:

```typescript
// src/db/schema/shared/enums.ts
export const EVENT_SOURCE_TYPES = [
  'github',
  'linear',
  'jira',
  'generic_webhook',
  'cron',     // <-- NEW
] as const;
export type EventSourceType = (typeof EVENT_SOURCE_TYPES)[number];
```

```typescript
// Application bootstrap — plugin registration
import { PluginRegistry } from '@/lib/events/plugin-registry';
import { GitHubPlugin } from '@/lib/events/plugins/github-plugin';
import { LinearPlugin } from '@/lib/events/plugins/linear-plugin';
import { JiraPlugin } from '@/lib/events/plugins/jira-plugin';
import { GenericWebhookPlugin } from '@/lib/events/plugins/generic-webhook-plugin';
import { CronEventSourcePlugin } from '@/lib/events/plugins/cron-plugin';

const registry = new PluginRegistry();
registry.register('github', new GitHubPlugin());
registry.register('linear', new LinearPlugin());
registry.register('jira', new JiraPlugin());
registry.register('generic_webhook', new GenericWebhookPlugin());
registry.register('cron', new CronEventSourcePlugin());   // <-- NEW
```

---

## Cron Event Source Configuration

The `config` JSON column on the `event_sources` table stores cron-specific configuration when `type = 'cron'`:

```typescript
// src/lib/events/plugins/cron-types.ts

export interface CronEventSourceConfig {
  /** Whether to use a fixed interval or a cron expression */
  scheduleType: 'interval' | 'cron';

  /** Interval in seconds between executions (when scheduleType = 'interval'). Minimum: 60 */
  interval?: number;

  /** Standard cron expression (when scheduleType = 'cron'). e.g., "0 9 * * 1-5" */
  cronExpression?: string;

  /** IANA timezone identifier for cron expression evaluation */
  timezone: string;

  /** Execution budget limits to prevent runaway costs */
  budget: {
    maxPerHour?: number;
    maxPerDay?: number;
    maxPerWeek?: number;
    maxPerMonth?: number;
  };

  /** ISO-8601 timestamp of next scheduled execution (managed by SchedulerService) */
  nextRunAt: string | null;

  /** ISO-8601 timestamp of last successful execution */
  lastRunAt: string | null;
}
```

### Validation Schema

```typescript
// src/lib/validation/cron-event-sources.ts
import { z } from 'zod';

const budgetSchema = z.object({
  maxPerHour: z.number().int().min(1).max(1000).optional(),
  maxPerDay: z.number().int().min(1).max(10000).optional(),
  maxPerWeek: z.number().int().min(1).max(50000).optional(),
  maxPerMonth: z.number().int().min(1).max(200000).optional(),
});

export const cronEventSourceConfigSchema = z
  .object({
    scheduleType: z.enum(['interval', 'cron']),
    interval: z.number().int().min(60).optional(),
    cronExpression: z.string().min(9).max(100).optional(),
    timezone: z.string().min(1).max(64),
    budget: budgetSchema.default({}),
    nextRunAt: z.string().datetime().nullable().default(null),
    lastRunAt: z.string().datetime().nullable().default(null),
  })
  .refine(
    (data) => {
      if (data.scheduleType === 'interval') return data.interval !== undefined;
      if (data.scheduleType === 'cron') return data.cronExpression !== undefined;
      return false;
    },
    {
      message: 'interval is required for scheduleType=interval; cronExpression is required for scheduleType=cron',
    }
  );
```

---

## CronEventSourcePlugin Implementation

```typescript
// src/lib/events/plugins/cron-plugin.ts

import { createId } from '@paralleldrive/cuid2';
import type { AppError } from '@/lib/errors/base';
import type { Result } from '@/lib/utils/result';
import { ok } from '@/lib/utils/result';
import type {
  EventSourcePlugin,
  NormalizedEvent,
  EventTypeDefinition,
  TemplateVariable,
  SubscriptionFilter,
} from '../plugin-interface';
import type { CronEventSourceConfig } from './cron-types';

/**
 * Context passed from the SchedulerService when invoking the cron plugin.
 * This replaces the HTTP headers/body that webhook plugins receive.
 */
export interface CronTickContext {
  /** The event source name (for human-readable event titles) */
  sourceName: string;
  /** The cron config from the event source */
  config: CronEventSourceConfig;
  /** Running count of total executions for this source */
  executionCount: number;
  /** Whether this is a scheduled tick or a manual trigger */
  trigger: 'tick' | 'manual';
}

export class CronEventSourcePlugin implements EventSourcePlugin {
  readonly type = 'cron';

  /**
   * Signature verification is a no-op for cron events.
   *
   * Cron events are generated internally by the SchedulerService -- there is
   * no external HTTP request with an HMAC signature to verify. This method
   * always returns success to satisfy the pipeline interface.
   */
  async verifySignature(
    _payload: string,
    _signature: string | null,
    _secret: string,
  ): Promise<Result<boolean, AppError>> {
    return ok(true);
  }

  /**
   * Generate a synthetic NormalizedEvent from a schedule tick.
   *
   * Unlike webhook plugins that parse external HTTP payloads, the cron plugin
   * constructs an event from the schedule configuration and tick context.
   * The `rawBody` parameter is expected to be a JSON-serialized CronTickContext.
   *
   * The SchedulerService serializes a CronTickContext as the rawBody before
   * calling this method, maintaining the same call signature as webhook plugins.
   */
  parseEvent(
    _headers: Headers,
    rawBody: string,
  ): Result<NormalizedEvent, AppError> {
    const context: CronTickContext = JSON.parse(rawBody);
    const { sourceName, config, executionCount, trigger } = context;
    const timestamp = new Date().toISOString();

    const isManual = trigger === 'manual';

    const normalized: NormalizedEvent = {
      type: isManual ? 'schedule.manual_trigger' : 'schedule.tick',
      action: isManual ? 'manual' : 'tick',
      deliveryId: createId(),
      source: {
        repo: undefined,
        branch: undefined,
        labels: [],
        author: 'system',
      },
      data: {
        title: `Scheduled execution: ${sourceName}`,
        body: isManual
          ? `Manual trigger of "${sourceName}" at ${timestamp}`
          : `Scheduled task triggered at ${timestamp}`,
        url: undefined,
        number: undefined,
        scheduleName: sourceName,
        scheduleType: config.scheduleType,
        cronExpression: config.cronExpression,
        interval: config.interval,
        executionCount,
        lastRunAt: config.lastRunAt,
      },
      raw: {
        schedule: { ...config },
        trigger,
        timestamp,
        executionCount,
        sourceName,
      },
    };

    return ok(normalized);
  }

  /**
   * Return all event types the cron plugin can produce.
   */
  getEventTypes(): EventTypeDefinition[] {
    // NOTE: The current EventTypeDefinition interface (src/lib/events/plugin-interface.ts)
    // does not include a `description` field. The interface should be extended with
    // `description?: string` — it is valuable for UI tooltips and documentation.
    // Until the interface is updated, descriptions are included here as comments only.
    return [
      {
        type: 'schedule.tick',
        label: 'Scheduled Tick',
        // description: 'Automatic execution triggered by interval or cron schedule',
        actions: ['tick'],
      },
      {
        type: 'schedule.manual_trigger',
        label: 'Manual Trigger',
        // description: 'Manual execution triggered via the API',
        actions: ['manual'],
      },
    ];
  }

  /**
   * Return template variables available for cron event prompt interpolation.
   *
   * All variables are available regardless of the specific event type since
   * both schedule.tick and schedule.manual_trigger carry the same data shape.
   *
   * NOTE: The `example` field on TemplateVariable is optional per the interface
   * (`example?: string`), but should always be provided for cron variables to
   * help users author prompt templates with realistic sample values.
   */
  getTemplateVariables(_eventType: string): TemplateVariable[] {
    return [
      {
        name: 'schedule.name',
        description: 'Name of the schedule / event source',
        example: 'Daily code review',
      },
      {
        name: 'schedule.lastRunAt',
        description: 'ISO-8601 timestamp of the previous execution',
        example: '2026-03-01T09:00:00Z',
      },
      {
        name: 'schedule.executionCount',
        description: 'Total number of executions for this schedule',
        example: '42',
      },
      {
        name: 'schedule.cronExpression',
        description: 'Cron expression (if scheduleType is cron)',
        example: '0 9 * * 1-5',
      },
      {
        name: 'schedule.interval',
        description: 'Interval in seconds (if scheduleType is interval)',
        example: '3600',
      },
      {
        name: 'schedule.scheduleType',
        description: 'Schedule type: interval or cron',
        example: 'cron',
      },
      {
        name: 'schedule.timezone',
        description: 'IANA timezone configured for the schedule',
        example: 'America/New_York',
      },
      {
        name: 'timestamp',
        description: 'ISO-8601 timestamp of the current execution',
        example: '2026-03-02T09:00:00Z',
      },
      {
        name: 'trigger',
        description: 'How the execution was triggered',
        example: 'tick',
      },
      {
        name: 'event.type',
        description: 'Event type (schedule.tick or schedule.manual_trigger)',
        example: 'schedule.tick',
      },
      {
        name: 'event.action',
        description: 'Event action (tick or manual)',
        example: 'tick',
      },
    ];
  }

  /**
   * Evaluate whether a cron event matches a subscription filter.
   *
   * For cron events, most filter fields are not meaningful because scheduled
   * events do not originate from a repository, branch, or external author.
   * The behavior for each filter field is:
   *
   * - `repo`    -> always matches (cron events have no repo)
   * - `branch`  -> always matches (cron events have no branch)
   * - `labels`  -> always matches (cron events have no labels)
   * - `author`  -> always matches (author is always 'system')
   * - `action`  -> compared against event.action ('tick' or 'manual')
   *
   * In practice, cron subscriptions typically use empty filters (match all
   * ticks) or filter by action to distinguish scheduled vs. manual triggers.
   */
  matchesFilter(event: NormalizedEvent, filter: SubscriptionFilter): boolean {
    // Only the 'action' field is meaningful for cron events
    if (filter.field === 'action') {
      switch (filter.operator) {
        case 'equals':
          return event.action === filter.value;
        case 'not_equals':
          return event.action !== filter.value;
        case 'contains':
          return event.action?.includes(filter.value) ?? false;
        case 'matches':
          return new RegExp(filter.value).test(event.action ?? '');
        default:
          return true;
      }
    }

    // All other filter fields (repo, branch, labels, author) always match
    // because cron events don't have meaningful values for these fields.
    return true;
  }
}
```

---

## Supported Event Types

| Event Type | Actions | Description |
|------------|---------|-------------|
| `schedule.tick` | `tick` | Automatic execution triggered by the configured interval or cron expression. Generated by the `SchedulerService` tick loop. |
| `schedule.manual_trigger` | `manual` | Execution triggered manually via `POST /api/events/sources/:id/trigger`. Bypasses schedule timing but respects budget limits. |

---

## Template Variables

Variables available for prompt template interpolation in cron event subscriptions. These are resolved by the template engine when a cron event matches a subscription.

| Variable | Source Path | Description | Example |
|----------|------------|-------------|---------|
| `schedule.name` | `event.raw.sourceName` | Name of the schedule / event source | `Daily code review` |
| `schedule.lastRunAt` | `event.data.lastRunAt` | ISO-8601 timestamp of the previous execution | `2026-03-01T09:00:00Z` |
| `schedule.executionCount` | `event.data.executionCount` | Total number of executions for this schedule | `42` |
| `schedule.cronExpression` | `event.data.cronExpression` | Cron expression (if scheduleType is `cron`) | `0 9 * * 1-5` |
| `schedule.interval` | `event.data.interval` | Interval in seconds (if scheduleType is `interval`) | `3600` |
| `schedule.scheduleType` | `event.data.scheduleType` | Schedule type: `interval` or `cron` | `cron` |
| `schedule.timezone` | `event.raw.schedule.timezone` | IANA timezone configured for the schedule | `America/New_York` |
| `timestamp` | `event.raw.timestamp` | ISO-8601 timestamp of the current execution | `2026-03-02T09:00:00Z` |
| `trigger` | `event.raw.trigger` | How the execution was triggered: `tick` or `manual` | `tick` |
| `event.type` | `event.type` | Event type | `schedule.tick` |
| `event.action` | `event.action` | Event action | `tick` |

---

## Filter Matching

For cron events, the `SubscriptionFilter` fields map as follows:

| Filter Field | Behavior | Rationale |
|-------------|----------|-----------|
| `repo` | Always matches | Cron events have no repository context |
| `branch` | Always matches | Cron events have no branch context |
| `labels` | Always matches | Cron events have no labels |
| `author` | Always matches | Author is always `system` |
| `action` | Compared against `tick` or `manual` | Allows filtering by trigger type |

### Typical Filter Configurations

**Match all ticks (most common):**
```json
{
  "filters": []
}
```
An empty filter array matches all events from the source. This is the default for cron subscriptions -- every tick creates a task.

**Match only scheduled ticks (exclude manual triggers):**
```json
{
  "filters": [
    { "field": "action", "operator": "equals", "value": "tick" }
  ]
}
```

**Match only manual triggers:**
```json
{
  "filters": [
    { "field": "action", "operator": "equals", "value": "manual" }
  ]
}
```

---

## Pipeline Behavior for Cron Events

The cron plugin integrates with the existing event processing pipeline, but the flow is driven by the `SchedulerService` rather than by an incoming HTTP request:

```
SchedulerService                      Event Processing Pipeline
                                      (same as webhooks)
┌──────────────────┐
│ Tick loop fires  │
│ (every 30s)      │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Query due sources│
│ (nextRunAt <= now)│
└────────┬─────────┘
         │
         ▼
┌──────────────────┐      ┌─────────────────────────────┐
│ CronPlugin       │      │ Signature verification      │
│ .parseEvent()    │─────>│ (auto-passes for cron)      │
│ (generate event) │      └──────────┬──────────────────┘
└──────────────────┘                 │
                                     ▼
                          ┌─────────────────────────────┐
                          │ Deduplicate (deliveryId)     │
                          └──────────┬──────────────────┘
                                     │
                                     ▼
                          ┌─────────────────────────────┐
                          │ Match subscriptions          │
                          └──────────┬──────────────────┘
                                     │
                                     ▼
                          ┌─────────────────────────────┐
                          │ Render templates + create    │
                          │ tasks + optional agent start │
                          └─────────────────────────────┘
```

### Key Differences from Webhook Pipeline

| Aspect | Webhook Plugins | Cron Plugin |
|--------|----------------|-------------|
| Entry point | `POST /hooks/events/:slug` HTTP handler | `SchedulerService` tick loop |
| Signature verification | HMAC-SHA256 against external payload | Always passes (no external payload) |
| Event generation | `parseEvent` parses external HTTP body | `parseEvent` generates synthetic event from config |
| Delivery ID | Provided by external system (header) | Generated internally via `createId()` |
| Deduplication | Critical for webhook retries | Each tick generates a unique ID; dedup is not a concern |
| Webhook secret | Required for HMAC verification | Not used; `webhookSecret` can be empty for cron sources |

---

## Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `SCHEDULE_INVALID_CRON` | 400 | The cron expression is syntactically invalid or uses unsupported features. Validated on event source creation and update. |
| `SCHEDULE_INVALID_INTERVAL` | 400 | The interval is less than the minimum allowed value (default: 60 seconds). |
| `SCHEDULE_INVALID_TIMEZONE` | 400 | The timezone string is not a valid IANA timezone identifier. Validated using `Intl.supportedValuesOf('timeZone')`. |
| `SCHEDULE_BUDGET_EXCEEDED` | 429 | The execution budget for the current time window (hour/day/week/month) has been reached. The tick is skipped and recorded as `skipped_budget`. |
| `SCHEDULE_SOURCE_PAUSED` | 422 | The schedule event source is paused (status = `disabled`). Must be resumed before executions can occur. |
| `SCHEDULE_EXECUTION_FAILED` | 500 | The scheduled execution failed during event processing (template rendering, task creation, etc.). Recorded in `schedule_executions` with status `error`. |

### Error Definitions

```typescript
// Added to src/lib/errors/event-errors.ts

export const ScheduleErrors = {
  INVALID_CRON: (expression: string) =>
    createError(
      'SCHEDULE_INVALID_CRON',
      `Invalid cron expression: "${expression}"`,
      400,
      { expression }
    ),
  INVALID_INTERVAL: (interval: number) =>
    createError(
      'SCHEDULE_INVALID_INTERVAL',
      `Interval must be >= 60 seconds, got ${interval}`,
      400,
      { interval }
    ),
  INVALID_TIMEZONE: (timezone: string) =>
    createError(
      'SCHEDULE_INVALID_TIMEZONE',
      `Invalid IANA timezone: "${timezone}"`,
      400,
      { timezone }
    ),
  BUDGET_EXCEEDED: (sourceId: string, window: string) =>
    createError(
      'SCHEDULE_BUDGET_EXCEEDED',
      `Execution budget exceeded for ${window} window`,
      429,
      { sourceId, window }
    ),
  SOURCE_PAUSED: (sourceId: string) =>
    createError(
      'SCHEDULE_SOURCE_PAUSED',
      `Schedule "${sourceId}" is paused`,
      422,
      { sourceId }
    ),
  EXECUTION_FAILED: (sourceId: string, reason: string) =>
    createError(
      'SCHEDULE_EXECUTION_FAILED',
      `Scheduled execution failed for source "${sourceId}": ${reason}`,
      500,
      { sourceId, reason }
    ),
} as const;
```

---

## Example Prompt Templates

### Daily Code Review

A cron source configured with `cronExpression: "0 9 * * 1-5"` (9 AM weekdays) paired with this template:

```
Perform a daily code review for the team.

**Schedule:** {{schedule.name}}
**Run #:** {{schedule.executionCount}}
**Last run:** {{schedule.lastRunAt}}

## Instructions

1. Check all pull requests opened or updated since {{schedule.lastRunAt}}
2. Review each PR for code quality, security issues, and test coverage
3. Leave review comments on any issues found
4. Summarize findings in a brief report

Focus on changes in the `src/` directory. Prioritize PRs with the `needs-review` label.
```

### Hourly Health Check

A cron source configured with `scheduleType: 'interval'`, `interval: 3600` (every hour):

```
Run a health check on the application.

**Schedule:** {{schedule.name}} (every {{schedule.interval}}s)
**Execution #:** {{schedule.executionCount}}
**Trigger:** {{trigger}}

## Instructions

1. Verify all API endpoints return 200 status codes
2. Check database connection and query response times
3. Verify background job queue is processing normally
4. Check disk space and memory usage
5. If any check fails, create a detailed report with:
   - Which check failed
   - Error message or symptoms
   - Suggested remediation steps
```

### Weekly Dependency Update

A cron source configured with `cronExpression: "0 10 * * 1"` (Monday 10 AM):

```
Check for outdated dependencies and create update PRs.

**Schedule:** {{schedule.name}}
**Week of:** {{timestamp}}
**Previous run:** {{schedule.lastRunAt}}

## Instructions

1. Run `npm outdated` to identify packages with available updates
2. For each outdated package:
   a. Check the changelog for breaking changes
   b. If the update is a patch or minor version, update it
   c. If the update is a major version, assess the migration effort
3. Run the full test suite after updates
4. Create a PR with all safe updates grouped together
5. For major version updates that need manual migration, create separate tasks

**Timezone:** {{schedule.timezone}}
**Schedule type:** {{schedule.scheduleType}} ({{schedule.cronExpression}})
```

---

## Database Additions

### Schedule Executions Table

See [database-schema.md](./database-schema.md) for the `schedule_executions` table schema. That file is the single source of truth for all table definitions in the task scheduling system.

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Scheduler Service](./scheduler-service.md) | The `SchedulerService` invokes the cron plugin on each tick |
| [Plugin Interface](../event-plugin-system/plugin-interface.md) | `CronEventSourcePlugin` implements `EventSourcePlugin` |
| [Database Schema](../event-plugin-system/database-schema.md) | Cron config stored in `event_sources.config` JSON column |
| [State Machine](../event-plugin-system/state-machine.md) | Cron events flow through the same processing pipeline |
| [Prompt Templates](../event-plugin-system/prompt-templates.md) | Cron template variables added to the template engine |
| [API Endpoints](../event-plugin-system/api-endpoints.md) | New trigger/pause/resume endpoints for cron sources |
| [Error Catalog](../application/errors/error-catalog.md) | Schedule-specific error codes extend the existing catalog |
