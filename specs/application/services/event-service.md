# Event Service

## Overview

The Event Service provides a webhook-driven event processing pipeline that monitors external sources (GitHub, Linear, Jira, generic webhooks, and cron schedules) and triggers automated task creation with optional agent auto-start. When an external system fires a webhook or a cron schedule ticks, AgentPane normalizes the event, evaluates it against user-defined subscription filters, interpolates a prompt template, and creates a task on the target project's Kanban board.

The system is **team-scoped**: event sources and subscriptions belong to a team, and webhook endpoints are addressed by a per-source slug that is unique across the installation.

---

## Architecture

### Pipeline

```
External Source           AgentPane                               Kanban Board
(GitHub, Linear, etc.)    Webhook / Scheduler                      + Agent

  +----------+    POST /hooks/events/:slug    +---------------------+
  |  GitHub   |------------------------------>|  Signature Verify    |
  |  Linear   |                               |  (plugin.verifySig) |
  |  Jira     |                               +----------+----------+
  |  Webhook  |                                          |
  |  Cron     |---(scheduler tick)--------+              v
  +----------+                            |    +---------------------+
                                          +--->|  Parse & Normalize   |
                                               |  (plugin.parseEvent) |
                                               +----------+----------+
                                                          |
                                                          v
                                               +---------------------+
                                               |  Deduplicate         |
                                               |  (deliveryId check)  |
                                               +----------+----------+
                                                          |
                                                          v
                                               +---------------------+
                                               |  Match Subscriptions |
                                               |  (filters + types)   |
                                               +----------+----------+
                                                          |
                                                          v
                                               +---------------------+
                                               |  Template Rendering  |
                                               |  {{variable}} interp |
                                               +----------+----------+
                                                          |
                                                          v
                                               +---------------------+
                                               |  Task Creation       |
                                               |  + optional column   |
                                               |    move / auto-start |
                                               +---------------------+
```

### Component Interaction

```
+--------------------------------------------------------------------+
|                        AgentPane Server                              |
|                                                                      |
|  +------------------+     +---------------------+                   |
|  | Webhook Route     |     | EventProcessing     |                   |
|  | POST /hooks/      |---->| Service             |                   |
|  |   events/:slug    |     |                     |                   |
|  | (no auth, rate    |     | processIncomingEvent|                   |
|  |  limited 60/min)  |     | processScheduledEvt |                   |
|  +------------------+     +----------+----------+                   |
|                                      |                               |
|  +------------------+                |                               |
|  | Admin API         |               v                               |
|  | /api/events/*     |     +---------------------+                   |
|  | (RBAC protected)  |     |   PluginRegistry    |                   |
|  +------------------+     |  (DI, not singleton) |                   |
|                            +----------+----------+                   |
|  +------------------+                |                               |
|  | SchedulerService  |               v                               |
|  | (cron tick loop)  |     +---------------------+                   |
|  +------------------+     |    EventBus (SSE)    |                   |
|                            | publishEventToStream|                   |
|  +------------------------------------------------------+           |
|  |                       Database                         |          |
|  |  +---------------+ +-------------------+ +----------+  |          |
|  |  | event_sources | | event_subscriptions| | event_log|  |          |
|  |  +---------------+ +-------------------+ +----------+  |          |
|  |  +---------------------+                                |          |
|  |  | schedule_executions |                                |          |
|  |  +---------------------+                                |          |
|  +------------------------------------------------------+           |
+--------------------------------------------------------------------+
```

---

## Database Schema

Four tables support the event system. All use cuid2 primary keys, `text` columns, JSON mode for structured data, and `sql\`(datetime('now'))\`` timestamp defaults.

### `event_sources`

File: `src/db/schema/sqlite/event-sources.ts`

Represents a configured webhook endpoint that receives events from an external system.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | cuid2 |
| `teamId` | text FK | References `teams.id`, cascade delete |
| `name` | text | Human-readable label |
| `type` | text | `EventSourceType`: `'github'`, `'linear'`, `'jira'`, `'generic_webhook'`, `'cron'` |
| `slug` | text | Unique URL-safe slug for `POST /hooks/events/:slug` |
| `webhookSecret` | text | Encrypted HMAC secret (nullable for cron sources) |
| `isEnabled` | integer (boolean) | Default `true` |
| `config` | text (JSON) | Source-specific configuration (e.g., `CronEventSourceConfig` for cron) |
| `eventCount` | integer | Running count of events received |
| `lastEventAt` | text | ISO timestamp of most recent event |
| `status` | text | `EventSourceStatus`: `'active'`, `'error'`, `'disabled'` |
| `createdAt` | text | ISO timestamp |
| `updatedAt` | text | ISO timestamp |

**Indexes:**
- `event_sources_team_idx` on `teamId`
- `event_sources_slug_idx` unique on `slug`

### `event_subscriptions`

File: `src/db/schema/sqlite/event-subscriptions.ts`

Defines a rule that maps incoming events from a source to task creation on a target project.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | cuid2 |
| `name` | text | Human-readable label |
| `eventSourceId` | text FK | References `event_sources.id`, cascade delete |
| `targetProjectId` | text FK | References `projects.id`, cascade delete |
| `isEnabled` | integer (boolean) | Default `true` |
| `eventTypes` | text (JSON) | Array of event type strings to match; empty = wildcard |
| `filters` | text (JSON) | Array of `SubscriptionFilter` objects |
| `promptTemplate` | text | `{{variable}}` template rendered against `NormalizedEvent` |
| `autoStartAgent` | integer (boolean) | Default `false` |
| `taskColumn` | text | Target Kanban column; default `'backlog'` |
| `taskPriority` | text | Default `'medium'` |
| `taskLabels` | text (JSON) | String array of labels |
| `matchedCount` | integer | Running count of matched events |
| `lastMatchedAt` | text | ISO timestamp |
| `createdAt` | text | ISO timestamp |
| `updatedAt` | text | ISO timestamp |

**Indexes:**
- `event_subscriptions_source_idx` on `eventSourceId`
- `event_subscriptions_project_idx` on `targetProjectId`
- `event_subscriptions_source_enabled_idx` on `(eventSourceId, isEnabled)`

### `event_log`

File: `src/db/schema/sqlite/event-log.ts`

Immutable audit trail of every event received. Tracks processing status.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | cuid2 |
| `eventSourceId` | text FK | References `event_sources.id`, SET NULL on delete |
| `eventType` | text | Normalized event type |
| `action` | text | Normalized event action (nullable) |
| `status` | text | `EventLogStatus`: `'received'`, `'matched'`, `'task_created'`, `'ignored'`, `'error'` |
| `payload` | text (JSON) | Full event payload |
| `matchedSubscriptions` | text (JSON) | `Array<{ subscriptionId: string; taskId?: string }>` |
| `error` | text | Error message if processing failed |
| `deliveryId` | text | External delivery ID for deduplication |
| `receivedAt` | text | ISO timestamp |
| `processedAt` | text | ISO timestamp when processing completed |

**Indexes:**
- `event_log_source_idx` on `eventSourceId`
- `event_log_received_at_idx` on `receivedAt`
- `event_log_source_status_idx` on `(eventSourceId, status)`
- `event_log_delivery_idx` unique on `(eventSourceId, deliveryId)` -- deduplication constraint

### `schedule_executions`

File: `src/db/schema/sqlite/schedule-executions.ts`

Audit trail for cron/interval event source executions.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | cuid2 |
| `eventSourceId` | text FK | References `event_sources.id`, cascade delete |
| `status` | text | `ScheduleExecutionStatus`: `'executed'`, `'skipped_budget'`, `'skipped_disabled'`, `'error'` |
| `scheduledAt` | text | When the execution was scheduled for |
| `executedAt` | text | When it actually ran |
| `taskId` | text FK | References `tasks.id`, SET NULL on delete |
| `subscriptionId` | text FK | References `event_subscriptions.id`, SET NULL on delete |
| `budgetWindow` | text | `BudgetWindow`: `'hour'`, `'day'`, `'week'`, `'month'` |
| `windowExecutionCount` | integer | Count of executions in the current window |
| `error` | text | Error message if execution failed |
| `createdAt` | text | ISO timestamp |

**Indexes:**
- `schedule_executions_event_source_idx` on `eventSourceId`
- `schedule_executions_source_status_idx` on `(eventSourceId, status)`
- `schedule_executions_source_executed_at_idx` on `(eventSourceId, executedAt)`
- `schedule_executions_source_scheduled_at_idx` on `(eventSourceId, scheduledAt)`

### Relations

File: `src/db/schema/sqlite/relations.ts`

```
teams --1:N--> event_sources --1:N--> event_subscriptions
                              --1:N--> event_log
                              --1:N--> schedule_executions

projects --1:N--> event_subscriptions (targetProjectId)
```

- `eventSources` has `team` (one), `subscriptions` (many), `eventLogs` (many)
- `eventSubscriptions` has `eventSource` (one), `targetProject` (one)
- `eventLog` has `eventSource` (one)

---

## Service Layer

### EventSourceService

File: `src/services/event-source.service.ts`

CRUD service for event sources. Takes a `Database` instance via constructor injection.

| Method | Signature | Description |
|--------|-----------|-------------|
| `create` | `(input: CreateEventSourceInput) => Result<{ source, plaintextSecret }>` | Creates source, generates slug from name + random suffix, auto-generates 32-byte hex secret if not provided, encrypts secret via `encryptToken()` |
| `getById` | `(id: string) => Result<EventSource>` | Lookup by ID |
| `getBySlug` | `(slug: string) => Result<EventSource>` | Lookup by slug (used by webhook handler) |
| `listByTeam` | `(teamId: string) => Result<EventSource[]>` | List all sources for a team, ordered by `createdAt` desc |
| `update` | `(id, input: UpdateEventSourceInput) => Result<EventSource>` | Partial update; syncs `status` field with `isEnabled` toggle |
| `delete` | `(id: string) => Result<void>` | Cascade-deletes subscriptions via FK |
| `rotateSecret` | `(id: string) => Result<{ secret: string }>` | Generates new 32-byte hex secret, encrypts and stores it, returns plaintext once |
| `incrementEventCount` | `(id: string) => Result<void>` | Atomic increment of `eventCount` + update `lastEventAt` |
| `decryptSecret` | `(source: EventSource) => string | null` | Decrypt the stored webhook secret |

**Key implementation details:**
- Slug generation: `slugify(name)` + 6-char cuid2 suffix for uniqueness
- Secrets are encrypted at rest using `encryptToken()` / `decryptToken()` from `src/lib/crypto/server-encryption.ts`
- The plaintext secret is only returned on `create()` and `rotateSecret()`

### EventSubscriptionService

File: `src/services/event-subscription.service.ts`

CRUD service for event subscriptions.

| Method | Signature | Description |
|--------|-----------|-------------|
| `create` | `(input: CreateSubscriptionInput) => Result<EventSubscription>` | Validates event source exists and target project belongs to same team (via `team_projects` join) |
| `getById` | `(id: string) => Result<EventSubscription>` | Lookup by ID |
| `listBySource` | `(eventSourceId: string) => Result<EventSubscription[]>` | List all subscriptions for a source |
| `listByProject` | `(projectId: string) => Result<EventSubscription[]>` | List all subscriptions targeting a project |
| `update` | `(id, input: UpdateSubscriptionInput) => Result<EventSubscription>` | Partial update |
| `delete` | `(id: string) => Result<void>` | Delete subscription |
| `findMatchingSubscriptions` | `(eventSourceId, eventType) => Result<EventSubscription[]>` | Find enabled subscriptions for a source that match the given event type (empty `eventTypes` = wildcard) |
| `incrementMatchCount` | `(id: string) => Result<void>` | Atomic increment of `matchedCount` + update `lastMatchedAt` |

### EventProcessingService

File: `src/services/event-processing.service.ts`

Orchestrates the full event processing pipeline. Takes `Database`, `PluginRegistry`, `EventSourceService`, `EventSubscriptionService`, and `TaskService` via constructor injection.

**Two entry points:**

1. **`processIncomingEvent(sourceSlug, headers, rawBody)`** -- for webhook events
   - Looks up source by slug
   - Verifies source is enabled
   - Resolves plugin from registry
   - Decrypts webhook secret and verifies signature
   - Parses event into `NormalizedEvent`
   - Delegates to shared `processEventPipeline()`

2. **`processScheduledEvent(source, event)`** -- for cron/scheduler events
   - Skips slug lookup, signature verification, and parsing (already done by scheduler)
   - Delegates to shared `processEventPipeline()`

**Shared pipeline (`processEventPipeline`):**
1. **Deduplicate**: Insert into `event_log` with delivery ID; unique constraint catches duplicates
2. **Match subscriptions**: `findMatchingSubscriptions()` by source + event type, then filter evaluation
3. **Create tasks**: For each matched subscription, render prompt template, create task, optionally move to configured column
4. **Update event log**: Set final status and matched subscription records
5. **Increment source event count**

**Filter evaluation** (actual implementation): All filters on a subscription must match (AND logic), unlike the original spec which used OR logic for multiple filters. Each `SubscriptionFilter` has:
- `field`: `'repo' | 'branch' | 'labels' | 'author' | 'action'`
- `operator`: `'equals' | 'contains' | 'matches' | 'not_equals'`
- `value`: string

**ProcessingResult type:**
```typescript
type ProcessingResult = {
  eventSourceId: string;
  eventLogId: string;
  status: 'processed' | 'duplicate' | 'ignored';
  matchCount: number;
  tasksCreated: string[];
};
```

### SchedulerService

File: `src/services/scheduler.service.ts`

Manages cron and interval event sources. Runs a background tick loop (default: 30s interval, configurable via `SCHEDULER_TICK_INTERVAL_MS`).

| Method | Description |
|--------|-------------|
| `start()` | Begin the tick loop (disabled via `SCHEDULER_ENABLED=false`) |
| `stop()` | Stop the tick loop |
| `triggerManual(id)` | Manually trigger a cron source execution |
| `pauseSource(id)` | Pause a cron source |
| `resumeSource(id)` | Resume a paused/errored cron source |
| `getBudgetStatus(id, config)` | Get budget consumption for a cron source |

**Cron source configuration** (`CronEventSourceConfig` in `src/db/schema/shared/cron-config.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `scheduleType` | `'interval' | 'cron'` | Schedule mechanism |
| `interval` | number | Seconds between runs (min: 60, max: 2,592,000) |
| `cronExpression` | string | Standard 5-field cron expression |
| `timezone` | string | IANA timezone for cron evaluation |
| `budget` | `CronBudgetConfig` | Rate limits per hour/day/week/month |
| `nextRunAt` | string | Next scheduled run (managed by scheduler) |
| `lastRunAt` | string | Last successful run |
| `consecutiveErrors` | number | Error counter (max 5 before auto-disable) |
| `pausedAt` | string | Pause timestamp |

---

## Plugin System

### PluginRegistry

File: `src/lib/events/plugin-registry.ts`

Dependency-injected registry (not a singleton). Each `PluginRegistry` instance is independent, enabling isolated test registries.

```typescript
class PluginRegistry {
  register(type: string, plugin: EventSourcePlugin): void;
  get(type: string): EventSourcePlugin | undefined;
  getRegisteredTypes(): string[];
}
```

### EventSourcePlugin Interface

File: `src/lib/events/plugin-interface.ts`

```typescript
interface EventSourcePlugin {
  readonly type: string;
  verifySignature(payload: string, signature: string | null, secret: string): Promise<Result<boolean>>;
  parseEvent(headers: Headers, rawBody: string): Result<NormalizedEvent>;
  getEventTypes(): EventTypeDefinition[];
  getTemplateVariables(eventType: string): TemplateVariable[];
  matchesFilter(event: NormalizedEvent, filter: SubscriptionFilter): boolean;
}
```

### NormalizedEvent

The common event format all plugins produce:

```typescript
interface NormalizedEvent {
  type: string;              // e.g. 'issues', 'pull_request', 'push', 'scheduled'
  action: string | null;     // e.g. 'opened', 'closed', 'tick'
  deliveryId: string;        // Unique delivery ID from source
  source: {
    repo?: string;
    branch?: string;
    labels?: string[];
    author?: string;
  };
  data: {
    title?: string;
    body?: string;
    url?: string;
    number?: number;
    [key: string]: unknown;  // Schedule variables: scheduleName, cronExpression, etc.
  };
  raw: Record<string, unknown>;
}
```

### SubscriptionFilter

```typescript
interface SubscriptionFilter {
  field: 'repo' | 'branch' | 'labels' | 'author' | 'action';
  operator: 'equals' | 'contains' | 'matches' | 'not_equals';
  value: string;
}
```

### Plugin Types

| Type | Source | Signature Header | Delivery ID |
|------|--------|------------------|-------------|
| `github` | GitHub Webhooks | `X-Hub-Signature-256` | `X-GitHub-Delivery` |
| `linear` | Linear Webhooks | `Linear-Signature` or `X-Hub-Signature` | Header-derived |
| `jira` | Atlassian Webhooks | `X-Hub-Signature` | `X-Atlassian-Webhook-Identifier` |
| `generic_webhook` | Any HTTP POST | `X-Webhook-Signature` or `X-Signature` | `X-Delivery-Id` or generated UUID |
| `cron` | Internal scheduler | N/A (no webhook) | Generated per tick |

---

## Template Engine

File: `src/lib/events/template-engine.ts`

### Interpolation

Templates use `{{variable.path}}` syntax with dot-notation traversal. The engine:
1. Matches `{{variableName}}` patterns via regex
2. Resolves the path through a nested context object
3. Formats arrays as comma-separated strings
4. Sanitizes output (collapses excessive newlines, truncates to 4096 chars per value)
5. Replaces unresolved variables with empty strings

### Template Context

`buildTemplateContext(event)` maps `NormalizedEvent` into the template namespace:

| Namespace | Variables |
|-----------|-----------|
| `event.*` | `type`, `action` |
| `repo.*` | `name`, `full_name`, `owner` |
| `issue.*` | `title`, `body`, `number`, `url`, `labels` |
| `pr.*` | `title`, `body`, `number`, `url`, `branch`, `base_branch` |
| `author.*` | `login` |
| `schedule.*` | `name`, `lastRunAt`, `executionCount`, `cronExpression`, `interval`, `scheduleType`, `timezone` |
| `delivery_id` | Delivery ID string |
| `timestamp` | From raw payload |
| `trigger` | From raw payload |

---

## Event Bus (SSE)

File: `src/lib/events/event-bus.ts`

In-memory pub/sub for real-time event notifications to connected SSE clients.

- `publishEventToStream(event)` -- broadcast to all listeners
- `addStreamListener(fn)` / `removeStreamListener(fn)` -- manage listener set
- Max 50 concurrent SSE connections (`MAX_SSE_CONNECTIONS`)
- Stale listeners are auto-removed on error
- The webhook route publishes `event:processed` events via `queueMicrotask()` to avoid blocking the response

---

## API Routes

File: `src/server/routes/events.ts`

All routes are mounted under `/api/events/` and require authentication. Uses Hono router with Zod validation.

### Event Sources

| Method | Path | Auth Role | Description |
|--------|------|-----------|-------------|
| `GET` | `/sources` | viewer | List sources for user's teams. Filters: `teamId`, `type`, `status`. Cursor pagination. Strips `webhookSecret`. |
| `GET` | `/sources/:id` | viewer | Get source by ID. Strips `webhookSecret`. |
| `POST` | `/sources` | admin | Create source. Returns `webhookSecret` and `webhookUrl` in creation response only. |
| `PATCH` | `/sources/:id` | admin | Update source name, enabled state, config. |
| `DELETE` | `/sources/:id` | admin | Delete source. Cascades to subscriptions. |
| `POST` | `/sources/:id/rotate-secret` | admin | Rotate webhook secret. Returns new plaintext once. |

### Schedule-Specific Endpoints (cron sources)

| Method | Path | Auth Role | Description |
|--------|------|-----------|-------------|
| `POST` | `/sources/:id/trigger` | agent_operator | Manually trigger a cron source |
| `POST` | `/sources/:id/pause` | agent_operator | Pause a cron source |
| `POST` | `/sources/:id/resume` | agent_operator | Resume a paused/errored cron source |
| `GET` | `/sources/:id/budget` | viewer | Get budget consumption status |
| `GET` | `/sources/:id/executions` | viewer | List execution history (paginated) |

### Event Subscriptions

| Method | Path | Auth Role | Description |
|--------|------|-----------|-------------|
| `GET` | `/subscriptions` | viewer | List subscriptions. Filters: `eventSourceId`, `targetProjectId`, `isEnabled`. Cursor pagination. |
| `GET` | `/subscriptions/:id` | viewer | Get subscription by ID |
| `POST` | `/subscriptions` | agent_operator | Create subscription |
| `PATCH` | `/subscriptions/:id` | agent_operator | Update subscription |
| `DELETE` | `/subscriptions/:id` | agent_operator | Delete subscription |

### Event Log

| Method | Path | Auth Role | Description |
|--------|------|-----------|-------------|
| `GET` | `/log` | viewer | List events. Filters: `eventSourceId`, `status`, `eventType`, `since`, `until`. Cursor pagination. |
| `GET` | `/log/:id` | viewer | Get event log entry with full payload |

### SSE Stream

| Method | Path | Auth Role | Description |
|--------|------|-----------|-------------|
| `GET` | `/stream` | viewer | SSE endpoint for real-time event notifications. 15s keep-alive pings. Scoped to user's team sources. Max 50 connections. |

### Public Webhook Endpoint

File: `src/server/router.ts` (lines 207-248)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/hooks/events/:slug` | None* | Public webhook receiver. Rate-limited to 60 req/min per IP. |

*Authentication via HMAC signature verification, not session/token auth.

The webhook route is mounted outside `/api/*` to bypass authentication middleware. After processing, it publishes an `event:processed` SSE event via `queueMicrotask()`.

---

## Error Codes

File: `src/lib/errors/event-errors.ts`

### Event Errors

| Code | HTTP | Description |
|------|------|-------------|
| `EVENT_SOURCE_NOT_FOUND` | 404 | Source with given slug or ID not found |
| `EVENT_SOURCE_DISABLED` | 400 | Source is disabled |
| `EVENT_SLUG_CONFLICT` | 409 | Slug already in use |
| `EVENT_TEAM_NOT_FOUND` | 404 | Team not found |
| `EVENT_SUBSCRIPTION_NOT_FOUND` | 404 | Subscription not found |
| `EVENT_PROJECT_TEAM_MISMATCH` | 400 | Target project not in same team as source |
| `EVENT_SIGNATURE_INVALID` | 401 | Webhook signature verification failed |
| `EVENT_PARSE_FAILED` | 400 | Failed to parse webhook event |
| `EVENT_PLUGIN_NOT_FOUND` | 400 | No plugin registered for source type |
| `EVENT_PROCESSING_FAILED` | 500 | Event processing failed |
| `EVENT_SECRET_DECRYPT_FAILED` | 500 | Failed to decrypt webhook secret |

### Schedule Errors

| Code | HTTP | Description |
|------|------|-------------|
| `SCHEDULE_INVALID_CRON` | 400 | Invalid cron expression |
| `SCHEDULE_INVALID_INTERVAL` | 400 | Interval must be >= 60 seconds |
| `SCHEDULE_INVALID_TIMEZONE` | 400 | Invalid IANA timezone |
| `SCHEDULE_BUDGET_EXCEEDED` | 429 | Execution budget exceeded for window |
| `SCHEDULE_SOURCE_PAUSED` | 422 | Schedule is paused |
| `SCHEDULE_EXECUTION_FAILED` | 500 | Scheduled execution failed |
| `SCHEDULE_NOT_CRON_TYPE` | 400 | Source is not a cron type |
| `SCHEDULE_ALREADY_PAUSED` | 409 | Already paused |
| `SCHEDULE_ALREADY_ACTIVE` | 409 | Already active |

---

## Enums

File: `src/db/schema/shared/enums.ts`

```typescript
const EVENT_SOURCE_TYPES = ['github', 'linear', 'jira', 'generic_webhook', 'cron'] as const;
const EVENT_SOURCE_STATUS = ['active', 'error', 'disabled'] as const;
const EVENT_LOG_STATUS = ['received', 'matched', 'task_created', 'ignored', 'error'] as const;
const SCHEDULE_EXECUTION_STATUS = ['executed', 'skipped_budget', 'skipped_disabled', 'error'] as const;
const BUDGET_WINDOWS = ['hour', 'day', 'week', 'month'] as const;
```

---

## Key Implementation Files

| File | Purpose |
|------|---------|
| `src/services/event-source.service.ts` | Event source CRUD with secret encryption |
| `src/services/event-subscription.service.ts` | Subscription CRUD with team validation |
| `src/services/event-processing.service.ts` | Full event processing pipeline |
| `src/services/scheduler.service.ts` | Cron/interval scheduling with budget enforcement |
| `src/server/routes/events.ts` | REST API routes (mounted at `/api/events/`) |
| `src/server/router.ts` | Public webhook endpoint (`/hooks/events/:slug`) |
| `src/lib/events/plugin-interface.ts` | `EventSourcePlugin` interface, `NormalizedEvent` type |
| `src/lib/events/plugin-registry.ts` | Dependency-injected plugin registry |
| `src/lib/events/template-engine.ts` | `{{variable}}` interpolation engine |
| `src/lib/events/event-bus.ts` | In-memory SSE pub/sub |
| `src/lib/events/types.ts` | Frontend-facing entity types |
| `src/lib/errors/event-errors.ts` | Error codes for events and schedules |
| `src/db/schema/sqlite/event-sources.ts` | Drizzle schema for `event_sources` |
| `src/db/schema/sqlite/event-subscriptions.ts` | Drizzle schema for `event_subscriptions` |
| `src/db/schema/sqlite/event-log.ts` | Drizzle schema for `event_log` |
| `src/db/schema/sqlite/schedule-executions.ts` | Drizzle schema for `schedule_executions` |
| `src/db/schema/shared/enums.ts` | Event-related enum constants |
| `src/db/schema/shared/cron-config.ts` | `CronEventSourceConfig` type |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](../database/schema.md) | FK references to `teams`, `projects`, `tasks` |
| [Task Service](./task-service.md) | Task creation triggered by matched events |
| [Agent Service](./agent-service.md) | Optional agent auto-start when task moves to `in_progress` |
| [API Endpoints](../api/endpoints.md) | Event endpoints follow same response format and pagination |
| [Error Catalog](../errors/error-catalog.md) | Event-specific error codes extend the catalog |
| [Durable Sessions](../integrations/durable-sessions.md) | SSE stream for real-time event monitoring |
