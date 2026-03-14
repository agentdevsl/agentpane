# Event Plugin System - API Endpoints

## Overview

REST API endpoints for managing event sources, subscriptions, and viewing the event log. Follows the existing AgentPane API patterns: Hono router, consistent `ok/error` response structure, Zod validation, cursor-based pagination, and RBAC authorization.

The public webhook endpoint is deliberately outside the `/api/*` prefix to bypass authentication middleware.

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

## Event Sources

### GET /api/events/sources

List event sources for the authenticated user's team.

**Authorization**: `viewer` or above

**Query Parameters:**

```typescript
const listEventSourcesSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().min(1).max(100).default(20),
  type: z.enum(EVENT_SOURCE_TYPES).optional(),
  status: z.enum(EVENT_SOURCE_STATUS).optional(),
});
```

**Response:**

```typescript
{
  ok: true,
  data: {
    items: EventSource[],       // webhookSecret is NEVER included
    nextCursor: string | null,
    hasMore: boolean,
    totalCount: number
  }
}
```

**Notes:**
- The `webhookSecret` field is always omitted from list responses.
- Results are ordered by `createdAt` descending.

---

### GET /api/events/sources/:id

Get a single event source by ID.

**Authorization**: `viewer` or above

**Response:**

```typescript
{
  ok: true,
  data: EventSource   // webhookSecret is NEVER included
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `EVENT_SOURCE_NOT_FOUND` | Source does not exist or not in user's team |

---

### POST /api/events/sources

Create a new event source. Generates a random `webhookSecret` server-side.

**Authorization**: `admin` or above

**Request Body:**

```typescript
const createEventSourceSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(EVENT_SOURCE_TYPES),
  slug: z.string().min(3).max(64).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  config: z.record(z.unknown()).optional(),
});
```

**Response (201):**

```typescript
{
  ok: true,
  data: {
    source: EventSource,
    /** Returned ONLY on creation so the user can configure their external system */
    webhookSecret: string,
    /** Full webhook URL for convenience */
    webhookUrl: string   // e.g., "https://app.agentpane.dev/hooks/events/my-github"
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 409 | `SLUG_ALREADY_EXISTS` | Slug is already taken |

**Notes:**
- The `webhookSecret` is only returned in the creation response. It cannot be retrieved after that.
- The `teamId` is inferred from the authenticated user's active team.

---

### PATCH /api/events/sources/:id

Update an event source.

**Authorization**: `admin` or above

**Request Body:**

```typescript
const updateEventSourceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  isEnabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});
```

**Response:**

```typescript
{
  ok: true,
  data: EventSource   // webhookSecret omitted
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 404 | `EVENT_SOURCE_NOT_FOUND` | Source not found |

---

### DELETE /api/events/sources/:id

Delete an event source. Cascades to subscriptions. Event log entries are preserved (FK set to NULL).

**Authorization**: `admin` or above

**Response:**

```typescript
{
  ok: true,
  data: { deleted: true }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `EVENT_SOURCE_NOT_FOUND` | Source not found |

---

### POST /api/events/sources/:id/rotate-secret

Rotate the webhook secret. Returns the new secret once; the old secret is immediately invalidated.

**Authorization**: `admin` or above

**Response:**

```typescript
{
  ok: true,
  data: {
    /** New secret, returned only in this response */
    webhookSecret: string
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `EVENT_SOURCE_NOT_FOUND` | Source not found |

---

## Event Subscriptions

### GET /api/events/subscriptions

List subscriptions, optionally filtered by event source or target project.

**Authorization**: `viewer` or above

**Query Parameters:**

```typescript
const listEventSubscriptionsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().min(1).max(100).default(20),
  eventSourceId: z.string().optional(),
  targetProjectId: z.string().optional(),
  isEnabled: z.boolean().optional(),
});
```

**Response:**

```typescript
{
  ok: true,
  data: {
    items: EventSubscription[],
    nextCursor: string | null,
    hasMore: boolean,
    totalCount: number
  }
}
```

---

### GET /api/events/subscriptions/:id

Get a single subscription by ID.

**Authorization**: `viewer` or above

**Response:**

```typescript
{
  ok: true,
  data: EventSubscription
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `EVENT_SUBSCRIPTION_NOT_FOUND` | Subscription not found |

---

### POST /api/events/subscriptions

Create a new subscription.

**Authorization**: `agent_operator` or above

**Request Body:**

```typescript
const createEventSubscriptionSchema = z.object({
  name: z.string().min(1).max(200),
  eventSourceId: z.string().min(1),
  targetProjectId: z.string().min(1),
  eventTypes: z.array(z.string()).min(1),
  filters: z.array(subscriptionFilterSchema).optional(),
  promptTemplate: z.string().min(1).max(10000),
  autoStartAgent: z.boolean().optional(),
  taskColumn: z.enum(TASK_COLUMNS).optional(),
  taskPriority: z.enum(TASK_PRIORITIES).optional(),
  taskLabels: z.array(z.string()).max(20).optional(),
});
```

**Response (201):**

```typescript
{
  ok: true,
  data: EventSubscription
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 404 | `EVENT_SOURCE_NOT_FOUND` | Referenced event source not found |
| 404 | `PROJECT_NOT_FOUND` | Referenced target project not found |

---

### PATCH /api/events/subscriptions/:id

Update a subscription.

**Authorization**: `agent_operator` or above

**Request Body:**

```typescript
const updateEventSubscriptionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  isEnabled: z.boolean().optional(),
  eventTypes: z.array(z.string()).optional(),
  filters: z.array(subscriptionFilterSchema).optional(),
  promptTemplate: z.string().min(1).max(10000).optional(),
  autoStartAgent: z.boolean().optional(),
  taskColumn: z.enum(TASK_COLUMNS).optional(),
  taskPriority: z.enum(TASK_PRIORITIES).optional(),
  taskLabels: z.array(z.string()).max(20).optional(),
});
```

**Response:**

```typescript
{
  ok: true,
  data: EventSubscription
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `VALIDATION_ERROR` | Invalid input |
| 404 | `EVENT_SUBSCRIPTION_NOT_FOUND` | Subscription not found |

---

### DELETE /api/events/subscriptions/:id

Delete a subscription.

**Authorization**: `agent_operator` or above

**Response:**

```typescript
{
  ok: true,
  data: { deleted: true }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `EVENT_SUBSCRIPTION_NOT_FOUND` | Subscription not found |

---

## Event Log

### GET /api/events/log

List event log entries with cursor-based pagination.

**Authorization**: `viewer` or above

**Query Parameters:**

```typescript
const listEventLogSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().min(1).max(100).default(50),
  eventSourceId: z.string().optional(),
  status: z.enum(EVENT_LOG_STATUS).optional(),
  eventType: z.string().optional(),
  /** Filter by date range */
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
});
```

**Response:**

```typescript
{
  ok: true,
  data: {
    items: EventLogEntry[],
    nextCursor: string | null,
    hasMore: boolean,
    totalCount: number
  }
}
```

**Notes:**
- Results are ordered by `receivedAt` descending (newest first).
- The `payload` field may be large; consider truncation for list views.

---

### GET /api/events/log/:id

Get a single event log entry with full payload.

**Authorization**: `viewer` or above

**Response:**

```typescript
{
  ok: true,
  data: EventLogEntry
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `EVENT_LOG_NOT_FOUND` | Log entry not found |

---

## Event Stream (SSE)

### GET /api/events/stream

Server-Sent Events stream for real-time event monitoring. Emits events as they are processed through the pipeline.

**Authorization**: `viewer` or above

**Query Parameters:**

```typescript
const eventStreamSchema = z.object({
  /** Only stream events for a specific source */
  eventSourceId: z.string().optional(),
});
```

**SSE Event Types:**

```typescript
// New event received
event: event:received
data: { id: string, eventSourceId: string, eventType: string, action: string, deliveryId: string }

// Event processing status updated
event: event:status
data: { id: string, status: EventLogStatus, error?: string }

// Event matched subscriptions
event: event:matched
data: { id: string, matchedSubscriptions: string[], taskIds: string[] }

// Connection keepalive
event: ping
data: { timestamp: string }
```

**Notes:**
- Keepalive pings are sent every 30 seconds.
- The connection auto-reconnects using standard SSE `retry` behavior.
- Scoped to the user's team -- only events for team-owned sources are streamed.

---

## Public Webhook Endpoint

### POST /hooks/events/:slug

Public endpoint for receiving webhook payloads from external systems. This endpoint is outside `/api/*` and does not require authentication. Security is provided by HMAC signature verification.

**Path Parameters:**
- `slug` - The unique slug of the event source (e.g., `my-github-org`)

**Headers (vary by source type):**

| Header | GitHub | Linear | Jira | Generic |
|--------|--------|--------|------|---------|
| Content-Type | `application/json` | `application/json` | `application/json` | `application/json` |
| Signature | `X-Hub-Signature-256` | `Linear-Signature` | `X-Hub-Signature` | `X-Webhook-Signature` |
| Event Type | `X-GitHub-Event` | (in body) | (in body) | (optional) |
| Delivery ID | `X-GitHub-Delivery` | `Linear-Delivery` | `X-Atlassian-Webhook-Identifier` | `X-Delivery-Id` |

**Request Body:** Raw JSON payload from the external system.

**Processing Flow:**

1. Look up event source by `slug`
2. Verify signature using the source's `webhookSecret`
3. Parse payload into `NormalizedEvent`
4. Check for duplicate `deliveryId`
5. Match against enabled subscriptions
6. Render prompt templates and create tasks
7. Log the event

**Response (200):**

```typescript
{
  ok: true,
  data: {
    received: true,
    eventId: string,      // ID of the event_log entry
    matched: number       // Number of subscriptions that matched
  }
}
```

**Error Responses:**

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `EVENT_SOURCE_NOT_FOUND` | No source with this slug |
| 401 | `EVENT_INVALID_SIGNATURE` | Signature verification failed |
| 400 | `EVENT_PARSE_ERROR` | Failed to parse the payload |
| 422 | `EVENT_SOURCE_DISABLED` | Source exists but is disabled |

**Notes:**
- Always returns 200 for duplicate events (idempotent).
- Processing happens synchronously to provide an immediate response with match count.
- Large payloads are capped at 1 MB; requests exceeding this limit receive a 413 error.
- The raw body must be preserved before JSON parsing for accurate HMAC verification.

---

## Endpoint Summary

| Method | Path | Auth | Role | Description |
|--------|------|------|------|-------------|
| `GET` | `/api/events/sources` | Yes | `viewer` | List event sources |
| `GET` | `/api/events/sources/:id` | Yes | `viewer` | Get event source |
| `POST` | `/api/events/sources` | Yes | `admin` | Create event source |
| `PATCH` | `/api/events/sources/:id` | Yes | `admin` | Update event source |
| `DELETE` | `/api/events/sources/:id` | Yes | `admin` | Delete event source |
| `POST` | `/api/events/sources/:id/rotate-secret` | Yes | `admin` | Rotate webhook secret |
| `GET` | `/api/events/subscriptions` | Yes | `viewer` | List subscriptions |
| `GET` | `/api/events/subscriptions/:id` | Yes | `viewer` | Get subscription |
| `POST` | `/api/events/subscriptions` | Yes | `agent_operator` | Create subscription |
| `PATCH` | `/api/events/subscriptions/:id` | Yes | `agent_operator` | Update subscription |
| `DELETE` | `/api/events/subscriptions/:id` | Yes | `agent_operator` | Delete subscription |
| `GET` | `/api/events/log` | Yes | `viewer` | List event log (paginated) |
| `GET` | `/api/events/log/:id` | Yes | `viewer` | Get event log entry |
| `GET` | `/api/events/stream` | Yes | `viewer` | SSE event stream |
| `POST` | `/hooks/events/:slug` | No* | - | Public webhook receiver |

*\*Authentication via HMAC signature verification, not session/token auth.*

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](./database-schema.md) | Zod schemas validate against table types |
| [Plugin Interface](./plugin-interface.md) | Webhook endpoint delegates to plugin methods |
| [Prompt Templates](./prompt-templates.md) | Template rendering during task creation |
| [State Machine](./state-machine.md) | Webhook endpoint drives state transitions |
| [API Endpoints](../application/api/endpoints.md) | Follows same response format and patterns |
| [Pagination](../application/api/pagination.md) | Cursor-based pagination for log and list endpoints |
| [RBAC](../rbac-auth/) | Role hierarchy: owner > admin > agent_operator > viewer |
