# Task Scheduling System Specification

## Overview

The Task Scheduling System enables AgentPane to run tasks on schedules -- both simple intervals and cron expressions -- by extending the event plugin architecture with `'cron'` as a new event source type. When a schedule fires, the system checks budget limits, emits a synthetic event into the existing event processing pipeline, evaluates subscription filters, interpolates a prompt template, creates a task on the target project's Kanban board in `in_progress`, and auto-starts an agent.

Schedules are **team-scoped**: a cron event source belongs to a team, and subscriptions route scheduled events to specific projects within that team. Budget limits (max executions per hour/day/week/month) prevent runaway execution costs. The scheduler stores `nextRunAt` in the database so schedules survive server restarts without missing or double-firing.

---

## Architecture

### Pipeline

```
SchedulerService                AgentPane Event Pipeline                  Kanban Board
(Background Tick Loop)          (Reused from Event Plugin System)          + Agent

  ┌──────────────────┐
  │  30s tick loop   │
  │  (setInterval)   │
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐     nextRunAt <= now()      ┌──────────────────────┐
  │  Query due       │     AND isEnabled = true     │  Budget Check         │
  │  cron sources    │─────────────────────────────>│  (window counting)    │
  │  (compare-and-   │                              │                       │
  │   swap lock)     │                              │  maxPerHour?          │
  └──────────────────┘                              │  maxPerDay?           │
                                                    │  maxPerWeek?          │
                                                    │  maxPerMonth?         │
                                                    └──────────┬────────────┘
                                                               │
                                                    ┌──────────┴────────────┐
                                                    │  Pass    │    Fail    │
                                                    │          │            │
                                                    ▼          ▼            │
                                         ┌───────────────┐  ┌────────────┐ │
                                         │ Emit Synthetic │  │ Log skip:  │ │
                                         │ NormalizedEvent│  │ skipped_   │ │
                                         │ type: "cron"   │  │ budget     │ │
                                         │ action: "tick" │  └────────────┘ │
                                         └───────┬───────┘                  │
                                                 │                          │
                                                 ▼                          │
                                      ┌──────────────────────┐             │
                                      │  Match Subscriptions  │             │
                                      │  (filters + types)    │             │
                                      └──────────┬───────────┘             │
                                                 │                          │
                                            ┌────┴────┐                    │
                                            │  0..N   │                    │
                                            │ matches  │                    │
                                            └────┬────┘                    │
                                                 │                          │
                                                 ▼                          │
                                      ┌──────────────────────┐             │
                                      │  Template Engine      │             │
                                      │  {{variable}} interp  │             │
                                      └──────────┬───────────┘             │
                                                 │                          │
                                                 ▼                          │
                                      ┌──────────────────────┐             │
                                      │  Task Creation        │             │
                                      │  column: in_progress  │             │
                                      │  + agent auto-start   │             │
                                      └──────────────────────┘             │
                                                                           │
                                      ┌──────────────────────┐             │
                                      │  Update nextRunAt     │◄────────────┘
                                      │  + log execution      │  (always, regardless
                                      └──────────────────────┘   of pass/fail)
```

### Component Interaction

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AgentPane Server                                  │
│                                                                             │
│  ┌────────────────────┐     ┌──────────────────────────────────────────┐   │
│  │  SchedulerService   │     │  Event Processing Pipeline               │   │
│  │  (Background Loop)  │     │  (Reused from Event Plugin System)       │   │
│  │                     │     │                                          │   │
│  │  • 30s tick interval│────>│  1. (skip signature -- no webhook)       │   │
│  │  • Query due sources│     │  2. parseEvent (synthetic cron event)    │   │
│  │  • Budget check     │     │  3. (skip dedup -- scheduler handles)    │   │
│  │  • CAS locking      │     │  4. matchSubscriptions                   │   │
│  │  • nextRunAt update │     │  5. renderTemplate                       │   │
│  └────────────────────┘     │  6. createTask (in_progress)             │   │
│                              └───────────────┬──────────────────────────┘   │
│  ┌────────────────────┐                      │                              │
│  │  Admin API          │                      │                              │
│  │  /api/events/*      │                      │                              │
│  │  (RBAC protected)   │                      │                              │
│  │  + schedule-specific│                      │                              │
│  │    endpoints        │                      │                              │
│  └────────────────────┘                      │                              │
│                                               ▼                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                           Database                                   │   │
│  │  ┌────────────────┐ ┌─────────────────────┐ ┌──────────────────────┐│   │
│  │  │ event_sources   │ │ event_subscriptions │ │ schedule_executions  ││   │
│  │  │ (type='cron',   │ │                     │ │ (new table)          ││   │
│  │  │  config JSON    │ │                     │ │                      ││   │
│  │  │  has schedule   │ │                     │ │ • execution status   ││   │
│  │  │  + budget)      │ │                     │ │ • budget accounting  ││   │
│  │  └────────────────┘ └─────────────────────┘ └──────────────────────┘│   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     Plugin Registry                                  │   │
│  │  ┌────────┐  ┌────────┐  ┌──────┐  ┌─────────────┐  ┌────────────┐│   │
│  │  │ GitHub │  │ Linear │  │ Jira │  │ Gen.Webhook │  │ Cron (new) ││   │
│  │  └────────┘  └────────┘  └──────┘  └─────────────┘  └────────────┘│   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     Existing Services                                │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐      │   │
│  │  │ TaskService   │  │ AgentService │  │ SessionService (SSE) │      │   │
│  │  └──────────────┘  └──────────────┘  └──────────────────────┘      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### Cron as an Event Source Type

Rather than building a standalone scheduling subsystem, the Task Scheduling System adds `'cron'` as a new entry in the `EVENT_SOURCE_TYPES` enum. This decision has several advantages:

- **Reuses subscription infrastructure**: Existing event subscriptions -- with their filter conditions, prompt templates, target project routing, auto-start agent flag, and task column/priority/label settings -- work identically for cron sources.
- **Unified admin UI**: Cron schedules appear alongside GitHub/Linear/Jira sources in the event sources management interface. No new top-level navigation is needed.
- **Same RBAC model**: Event source permissions (Agent Operator+, level 2+) apply to cron sources without additional configuration.
- **Consistent audit trail**: Schedule executions are recorded in the same `event_log` and the new `schedule_executions` table, keeping all event-driven activity in one place.

The tradeoff is that cron sources skip some pipeline stages (signature verification, deduplication) that are only relevant to webhook-based sources. The `CronEventSourcePlugin` returns no-ops for these methods.

### Budget Enforcement

Scheduled tasks consume agent execution resources (API calls, compute time). Without limits, a misconfigured schedule could rapidly accumulate costs. Budget limits are enforced **per time window**:

| Window | Column | Example |
|--------|--------|---------|
| Hour | `maxPerHour` | Max 2 executions per calendar hour |
| Day | `maxPerDay` | Max 10 executions per calendar day |
| Week | `maxPerWeek` | Max 50 executions per calendar week |
| Month | `maxPerMonth` | Max 200 executions per calendar month |

Budget is checked by counting rows in `schedule_executions` with `status = 'executed'` within the relevant window. If any configured limit is exceeded, the execution is logged as `skipped_budget` and `nextRunAt` advances to the next scheduled time. All limits are optional -- if none are set, the schedule runs without budget constraints.

### Polling Approach (30-Second Tick)

The SchedulerService runs a `setInterval` loop every 30 seconds. On each tick:

1. Query all cron event sources where `config->>'nextRunAt' <= datetime('now')` AND `isEnabled = true` AND `status = 'active'`.
2. For each due source, perform a compare-and-swap (CAS) update: `UPDATE event_sources SET config = jsonb_set(config, '$.nextRunAt', :newNextRunAt) WHERE id = :id AND config->>'nextRunAt' = :expectedNextRunAt`. If the CAS fails (another process/tick already claimed it), skip.
3. Run budget check, emit event, log execution.

The CAS lock prevents double-firing when ticks overlap (e.g., if a tick takes longer than 30 seconds). The 30-second interval provides sub-minute granularity while keeping database polling lightweight. For schedules with intervals shorter than 30 seconds, the minimum effective interval is 30 seconds.

### Server Restart Recovery

The `nextRunAt` timestamp is persisted in the `config` JSON column of the `event_sources` table. On server startup:

1. The SchedulerService queries all enabled cron sources.
2. For any source where `nextRunAt` is in the past, it fires the missed execution immediately (subject to budget checks) and advances `nextRunAt` to the next future occurrence.
3. For any source where `nextRunAt` is `null` (newly created), it calculates the first `nextRunAt` based on the schedule configuration.

This ensures no scheduled executions are permanently lost due to downtime. At most one execution may be delayed; the system does not attempt to "catch up" multiple missed windows.

### Team-Scoped Schedules with Project Targets

A cron event source belongs to a team (via `teamId` on `event_sources`). A single cron source can have multiple subscriptions, each targeting a different project within the team. This allows patterns like:

- One "Daily standup agent" schedule with subscriptions targeting each project in the team.
- One "Weekly code review" schedule that creates tasks on a specific project.
- One "Hourly monitoring sweep" schedule targeting an infrastructure project.

Permissions follow the existing RBAC model: creating and managing cron event sources requires Agent Operator role (level 2+).

---

## Schedule Types

| Type | Config Field | Example | Description |
|------|-------------|---------|-------------|
| Interval | `interval` (seconds) | `3600` | Simple repeating schedule: run every N seconds. Minimum 60 seconds. |
| Cron Expression | `cronExpression` | `0 9 * * 1-5` | Standard 5-field cron: minute, hour, day-of-month, month, day-of-week. Evaluated in the configured `timezone`. |

### Cron Expression Examples

| Expression | Description |
|-----------|-------------|
| `*/15 * * * *` | Every 15 minutes |
| `0 9 * * 1-5` | 9:00 AM weekdays |
| `0 0 * * 0` | Midnight every Sunday |
| `0 8,17 * * *` | 8:00 AM and 5:00 PM daily |
| `0 0 1 * *` | First day of every month at midnight |

### Interval Constraints

| Constraint | Value | Rationale |
|-----------|-------|-----------|
| Minimum interval | 60 seconds | Prevent excessive polling; matches budget intent |
| Maximum interval | 2,592,000 seconds (30 days) | Beyond this, a cron expression is more appropriate |
| Effective minimum | 30 seconds | Scheduler tick rate limits sub-30s intervals |

---

## Specification Documents

| Document | Purpose |
|----------|---------|
| [database-schema.md](./database-schema.md) | Enum additions, `CronEventSourceConfig` shape, new `schedule_executions` table, Zod validation |
| [scheduler-service.md](./scheduler-service.md) | `SchedulerService` background loop, tick logic, CAS locking, startup recovery |
| [cron-plugin.md](./cron-plugin.md) | `CronEventSourcePlugin` implementing the `EventSourcePlugin` interface |
| [api-endpoints.md](./api-endpoints.md) | REST endpoints for cron source CRUD, execution history, manual trigger |

---

## Cross-References

| Related Spec | Relationship |
|-------------|--------------|
| [Event Plugin System](../event-plugin-system/README.md) | Parent system; cron extends the event source type enum and reuses the processing pipeline |
| [Event Plugin Database Schema](../event-plugin-system/database-schema.md) | Existing `event_sources` and `event_subscriptions` tables are reused; `schedule_executions` is new |
| [Event Plugin Interface](../event-plugin-system/plugin-interface.md) | `CronEventSourcePlugin` implements the `EventSourcePlugin` interface |
| [Event Prompt Templates](../event-plugin-system/prompt-templates.md) | Template variables available for cron events: `{{schedule.name}}`, `{{schedule.expression}}`, `{{execution.time}}` |
| [Database Schema](../application/database/schema.md) | FK references to `teams` and `projects` tables |
| [Task Service](../application/services/task-service.md) | Task creation in `in_progress` column triggers agent auto-start |
| [Agent Service](../application/services/agent-service.md) | Agent auto-start on scheduled task creation |
| [API Endpoints](../application/api/endpoints.md) | Schedule endpoints follow same response format and cursor pagination |
| [Error Catalog](../application/errors/error-catalog.md) | Schedule-specific error codes extend the existing catalog |
| [RBAC / Auth](../rbac-auth/) | Agent Operator+ (level 2+) required for schedule management |
| [Durable Sessions](../application/integrations/durable-sessions.md) | SSE stream for real-time schedule execution monitoring |
