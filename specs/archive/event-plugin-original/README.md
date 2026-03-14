# Event Plugin System Specification

## Overview

The Event Plugin System enables AgentPane to monitor external sources -- GitHub, Linear, Jira, and generic webhooks -- and trigger automated task creation and agent remediation in response to events. When an external system fires a webhook (e.g., a GitHub issue is opened, a Linear ticket transitions, or a Jira bug is filed), AgentPane normalizes the event, evaluates it against user-defined subscription filters, interpolates a prompt template, and creates a task on the target project's Kanban board, optionally auto-starting an agent.

This system is **team-scoped**: event sources and subscriptions belong to a team, and the webhook endpoints are addressed by a per-source slug that is unique across the installation.

---

## Architecture

### Pipeline

```
External Source          AgentPane                              Kanban Board
(GitHub, Linear, etc.)   Webhook Endpoint                       + Agent

  ┌──────────┐    POST /hooks/events/:slug    ┌──────────────────────┐
  │  GitHub   │──────────────────────────────>│  Signature Verify     │
  │  Linear   │                               │  (plugin.verifySig)   │
  │  Jira     │                               └──────────┬───────────┘
  │  Webhook  │                                          │
  └──────────┘                                           ▼
                                              ┌──────────────────────┐
                                              │  Parse & Normalize    │
                                              │  (plugin.parseEvent)  │
                                              └──────────┬───────────┘
                                                         │
                                                         ▼
                                              ┌──────────────────────┐
                                              │  Deduplicate          │
                                              │  (deliveryId check)   │
                                              └──────────┬───────────┘
                                                         │
                                                         ▼
                                              ┌──────────────────────┐
                                              │  Match Subscriptions  │
                                              │  (filters + types)    │
                                              └──────────┬───────────┘
                                                         │
                                                    ┌────┴────┐
                                                    │ 0..N    │
                                                    │ matches  │
                                                    └────┬────┘
                                                         │
                                                         ▼
                                              ┌──────────────────────┐
                                              │  Template Engine      │
                                              │  {{variable}} interp  │
                                              └──────────┬───────────┘
                                                         │
                                                         ▼
                                              ┌──────────────────────┐
                                              │  Task Creation        │
                                              │  + optional agent     │
                                              │    auto-start         │
                                              └──────────────────────┘
```

### Component Interaction

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          AgentPane Server                               │
│                                                                         │
│  ┌──────────────────┐     ┌────────────────────┐                       │
│  │ Webhook Route     │     │  Event Processing   │                      │
│  │ POST /hooks/      │────>│  Pipeline            │                      │
│  │   events/:slug    │     │                      │                      │
│  │ (no auth needed)  │     │  1. verifySignature  │                      │
│  └──────────────────┘     │  2. parseEvent       │                      │
│                            │  3. deduplicate      │                      │
│  ┌──────────────────┐     │  4. matchSubs        │                      │
│  │ Admin API         │     │  5. renderTemplate   │                      │
│  │ /api/events/*     │     │  6. createTask       │                      │
│  │ (RBAC protected)  │     └─────────┬────────────┘                      │
│  └──────────────────┘               │                                    │
│                                      ▼                                   │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                          Database                                │   │
│  │  ┌────────────────┐ ┌─────────────────────┐ ┌────────────────┐  │   │
│  │  │ event_sources   │ │ event_subscriptions │ │  event_log     │  │   │
│  │  └────────────────┘ └─────────────────────┘ └────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    Plugin Registry                                │   │
│  │  ┌────────┐  ┌────────┐  ┌──────┐  ┌─────────────────┐          │   │
│  │  │ GitHub │  │ Linear │  │ Jira │  │ Generic Webhook │          │   │
│  │  └────────┘  └────────┘  └──────┘  └─────────────────┘          │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    Existing Services                              │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │   │
│  │  │ TaskService   │  │ AgentService │  │ SessionService (SSE) │   │   │
│  │  └──────────────┘  └──────────────┘  └──────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### Team-Scoped Plugins

Event sources are scoped to a team via a `teamId` foreign key on `event_sources`. Subscriptions are scoped transitively through the event source they belong to. This means:

- A team can have multiple event sources (e.g., one GitHub source per organization, one Linear workspace).
- Each event source generates a unique webhook URL: `POST /hooks/events/:slug`.
- Subscriptions route matched events to specific projects within the team.

### Prompt Templates with `{{variable}}` Interpolation

Subscriptions include a `promptTemplate` field that uses Mustache-style `{{variable}}` syntax. When an event matches, the template is rendered with the normalized event data to produce the task title and description. This allows teams to customize how external events translate into agent instructions. See [prompt-templates.md](./prompt-templates.md) for the full variable reference.

### Subscription Filters

Each subscription defines `eventTypes` (which event types to match) and `filters` (structured filter objects). Filters support:

- **Repository**: match by repo name or full name
- **Branch**: match by branch pattern (glob supported)
- **Labels**: match when event includes any of the specified labels
- **Action**: match by event action (e.g., `opened`, `closed`, `merged`)
- **Author**: match by author login

Multiple filters on a subscription are combined with OR logic (any filter match triggers the subscription). Within a single filter, all specified fields must match (AND logic).

### Deduplication via `deliveryId`

Each normalized event carries a `deliveryId` (sourced from the external system, e.g., `X-GitHub-Delivery` header). The `event_log` table enforces a unique constraint on `(eventSourceId, deliveryId)` to prevent duplicate processing from webhook retries.

### Webhook Endpoint Outside `/api/*`

The public webhook endpoint is `POST /hooks/events/:slug`, deliberately placed outside the `/api/*` prefix so it bypasses the standard authentication middleware. Authentication is handled via HMAC signature verification using the event source's `webhookSecret`.

---

## Plugin Types

| Type | Source | Signature Method | Delivery ID Header |
|------|--------|------------------|--------------------|
| `github` | GitHub App/Webhook | HMAC-SHA256 (`X-Hub-Signature-256`) | `X-GitHub-Delivery` |
| `linear` | Linear Webhooks | HMAC-SHA256 (`Linear-Signature`) | `Linear-Delivery` |
| `jira` | Atlassian Webhooks | HMAC-SHA256 (`X-Hub-Signature`) | `X-Atlassian-Webhook-Identifier` |
| `generic_webhook` | Any HTTP POST | HMAC-SHA256 (`X-Webhook-Signature`) | `X-Delivery-Id` (or generated UUID) |

---

## Specification Documents

| Document | Purpose |
|----------|---------|
| [database-schema.md](./database-schema.md) | 3 new Drizzle tables: `event_sources`, `event_subscriptions`, `event_log` |
| [plugin-interface.md](./plugin-interface.md) | `EventSourcePlugin` interface, `NormalizedEvent`, GitHub plugin details |
| [api-endpoints.md](./api-endpoints.md) | REST endpoints for CRUD, event log, SSE stream, and public webhook |
| [prompt-templates.md](./prompt-templates.md) | `{{variable}}` template system with dot-notation and sanitization |
| [state-machine.md](./state-machine.md) | Event processing pipeline states from received through completed |

---

## Cross-References

| Related Spec | Relationship |
|-------------|--------------|
| [Database Schema](../application/database/schema.md) | Existing tables referenced by FKs (teams, projects) |
| [Task Service](../application/services/task-service.md) | Task creation triggered by matched events |
| [Agent Service](../application/services/agent-service.md) | Optional agent auto-start on task creation |
| [GitHub App](../application/integrations/github-app.md) | GitHub plugin shares webhook signature verification patterns |
| [API Endpoints](../application/api/endpoints.md) | Event endpoints follow same response format and pagination |
| [Error Catalog](../application/errors/error-catalog.md) | Event-specific error codes extend the existing catalog |
| [RBAC / Auth](../rbac-auth/) | Endpoint permissions use existing RBAC role hierarchy |
| [Durable Sessions](../application/integrations/durable-sessions.md) | SSE stream for real-time event monitoring |
