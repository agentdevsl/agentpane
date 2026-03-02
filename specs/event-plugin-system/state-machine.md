# Event Plugin System - State Machine

## Overview

Defines the event processing pipeline as a state machine. Each incoming webhook event progresses through a sequence of stages, with error branches at each step. The pipeline is synchronous within a single request -- the webhook response is sent only after the pipeline completes (or errors).

---

## State Diagram

```
                          ERROR
                       (bad signature)
                            │
                            ▼
                    ┌──────────────────┐
                    │ error_signature   │
                    └──────────────────┘

  ┌──────────┐      ┌─────────────────────┐      ┌──────────┐
  │ received │─────>│ signature_verified   │─────>│  parsed  │
  └──────────┘      └─────────────────────┘      └────┬─────┘
                                                       │
                          ERROR                        │
                       (bad payload)                   │
                            │                          │
                            ▼                          │
                    ┌──────────────────┐               │
                    │  error_parse     │               │
                    └──────────────────┘               │
                                                       ▼
                          ERROR                ┌───────────────┐
                       (duplicate)             │ deduplicated  │
                            │                  └───────┬───────┘
                            ▼                          │
                    ┌──────────────────┐               │
                    │ error_duplicate   │               │
                    └──────────────────┘               │
                                                       ▼
                          ERROR                ┌───────────────┐
                       (filter eval)           │   matched     │──── 0 matches ──── ┐
                            │                  └───────┬───────┘                    │
                            ▼                          │                            │
                    ┌──────────────────┐               │ 1+ matches                │
                    │ error_matching    │               ▼                            │
                    └──────────────────┘        ┌───────────────┐                   │
                                               │ tasks_created │                   │
                          ERROR                └───────┬───────┘                   │
                       (task create)                   │                            │
                            │                          │                            │
                            ▼                          ▼                            ▼
                    ┌────────────────────┐      ┌──────────────┐           ┌──────────────┐
                    │error_task_creation │      │  completed   │           │  completed   │
                    └────────────────────┘      │ (with tasks) │           │ (no matches) │
                                               └──────────────┘           └──────────────┘
```

### Simplified Linear Flow (Happy Path)

```
received ──> signature_verified ──> parsed ──> deduplicated ──> matched ──> tasks_created ──> completed
```

---

## States

| State | Description | Terminal | HTTP Response |
|-------|-------------|----------|---------------|
| `received` | Event payload received at webhook endpoint | No | - |
| `signature_verified` | HMAC signature validated successfully | No | - |
| `parsed` | Raw payload parsed into NormalizedEvent | No | - |
| `deduplicated` | deliveryId uniqueness check passed | No | - |
| `matched` | Event evaluated against all enabled subscriptions | No | - |
| `tasks_created` | Tasks created for all matched subscriptions | No | - |
| `completed` | Processing finished successfully | Yes | 200 |
| `error_signature` | HMAC signature verification failed | Yes | 401 |
| `error_parse` | Failed to parse the webhook payload | Yes | 400 |
| `error_duplicate` | Event with this deliveryId already processed | Yes | 200* |
| `error_matching` | Error during filter evaluation | Yes | 500 |
| `error_task_creation` | Error creating one or more tasks | Yes | 500 |

*\*Duplicate events return 200 to prevent the external system from retrying.*

---

## Transitions

| From | To | Trigger | Guard |
|------|----|---------|-------|
| `received` | `signature_verified` | Signature check passes | `plugin.verifySignature() === true` |
| `received` | `error_signature` | Signature check fails | `plugin.verifySignature() === false` or error |
| `signature_verified` | `parsed` | Payload parsed successfully | `plugin.parseEvent()` returns ok |
| `signature_verified` | `error_parse` | Payload parsing fails | `plugin.parseEvent()` returns error |
| `parsed` | `deduplicated` | deliveryId is new | No existing row with same (eventSourceId, deliveryId) |
| `parsed` | `error_duplicate` | deliveryId already exists | Unique constraint violation or lookup hit |
| `deduplicated` | `matched` | Filter evaluation completes | Subscriptions evaluated without error |
| `deduplicated` | `error_matching` | Filter evaluation fails | Exception during filter evaluation |
| `matched` | `tasks_created` | 1+ subscriptions matched, tasks created | `matchedSubscriptions.length > 0` and task creation succeeds |
| `matched` | `completed` | 0 subscriptions matched | `matchedSubscriptions.length === 0` |
| `matched` | `error_task_creation` | Task creation fails | TaskService.create() returns error |
| `tasks_created` | `completed` | All tasks created successfully | - |

---

## Pipeline Implementation

```typescript
// src/services/event-plugins/event-pipeline.ts

import type { EventSourcePlugin, NormalizedEvent } from './types';
import type { EventSource, EventSubscription, EventLogEntry } from '@/db/schema';
import type { EventLogStatus } from '@/db/schema/shared/enums';

interface PipelineResult {
  status: EventLogStatus;
  eventLogId: string;
  matchedSubscriptions: string[];
  createdTaskIds: string[];
  error?: string;
}

export async function processEvent(
  source: EventSource,
  plugin: EventSourcePlugin,
  headers: Record<string, string>,
  rawBody: string,
): Promise<PipelineResult> {
  // --- Stage 1: Receive ---
  const logEntry = await createEventLogEntry(source.id, 'received');

  // --- Stage 2: Verify Signature ---
  const signatureHeader = getSignatureHeader(headers, source.type);
  if (!signatureHeader) {
    return finalize(logEntry, 'error_signature', 'Missing signature header');
  }

  const sigResult = plugin.verifySignature(rawBody, signatureHeader, source.webhookSecret);
  if (!sigResult.ok || !sigResult.data) {
    return finalize(logEntry, 'error_signature', sigResult.ok ? 'Invalid signature' : sigResult.error.message);
  }
  await updateLogStatus(logEntry.id, 'signature_verified');

  // --- Stage 3: Parse ---
  const parseResult = plugin.parseEvent(headers, rawBody);
  if (!parseResult.ok) {
    return finalize(logEntry, 'error_parse', parseResult.error.message);
  }
  const event = parseResult.data;
  await updateLogEntry(logEntry.id, {
    status: 'parsed',
    eventType: event.type,
    action: event.action,
    deliveryId: event.deliveryId,
    payload: event.raw,
  });

  // --- Stage 4: Deduplicate ---
  const isDuplicate = await checkDuplicate(source.id, event.deliveryId);
  if (isDuplicate) {
    return finalize(logEntry, 'error_duplicate', `Duplicate deliveryId: ${event.deliveryId}`);
  }
  await updateLogStatus(logEntry.id, 'deduplicated');

  // --- Stage 5: Match Subscriptions ---
  let matchedSubs: EventSubscription[];
  try {
    const enabledSubs = await getEnabledSubscriptions(source.id);
    matchedSubs = enabledSubs.filter((sub) => matchesSubscription(sub, event, plugin));
  } catch (err) {
    return finalize(logEntry, 'error_matching', String(err));
  }

  const matchedIds = matchedSubs.map((s) => s.id);
  await updateLogEntry(logEntry.id, {
    status: 'matched',
    matchedSubscriptions: matchedIds,
  });

  if (matchedSubs.length === 0) {
    return finalize(logEntry, 'completed');
  }

  // --- Stage 6: Create Tasks ---
  const createdTaskIds: string[] = [];
  try {
    for (const sub of matchedSubs) {
      const taskId = await createTaskFromSubscription(sub, event, source.type);
      createdTaskIds.push(taskId);
      await incrementSubscriptionMatchCount(sub.id);
    }
  } catch (err) {
    return finalize(logEntry, 'error_task_creation', String(err));
  }
  await updateLogStatus(logEntry.id, 'tasks_created');

  // --- Stage 7: Complete ---
  await incrementSourceEventCount(source.id);
  return finalize(logEntry, 'completed', undefined, matchedIds, createdTaskIds);
}
```

### Subscription Matching Logic

```typescript
function matchesSubscription(
  sub: EventSubscription,
  event: NormalizedEvent,
  plugin: EventSourcePlugin,
): boolean {
  // 1. Check event type
  if (sub.eventTypes.length > 0 && !sub.eventTypes.includes(event.type)) {
    return false;
  }

  // 2. Check filters (OR logic: any filter match is sufficient)
  if (sub.filters.length === 0) {
    // No filters means "match all events of the specified types"
    return true;
  }

  return sub.filters.some((filter) => plugin.matchesFilter(event, filter));
}
```

---

## Deduplication

### Strategy

Deduplication uses the unique constraint on `(eventSourceId, deliveryId)` in the `event_log` table.

### Flow

```
1. After parsing, extract deliveryId from NormalizedEvent
2. Attempt to look up existing event_log entry with same (eventSourceId, deliveryId)
3. If found: mark as error_duplicate, return 200 (idempotent)
4. If not found: proceed to matching stage
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| **deliveryId is null** | Skip deduplication check (SQLite unique indexes allow multiple NULLs) |
| **Same deliveryId, different source** | Allowed (uniqueness is per-source) |
| **Rapid retries** | The unique constraint prevents race conditions at the database level |
| **Generic webhooks without delivery ID** | Plugin generates a UUID; effectively no deduplication |

---

## Error Handling

### Error State Details

| Error State | Cause | Logged | Retryable | HTTP |
|-------------|-------|--------|-----------|------|
| `error_signature` | Invalid HMAC, missing header, wrong secret | `error` field in event_log | No (external system must resend) | 401 |
| `error_parse` | Malformed JSON, missing required fields, unknown event type | `error` field in event_log | No | 400 |
| `error_duplicate` | deliveryId already processed | `error` field in event_log | No (by design) | 200 |
| `error_matching` | Exception in filter evaluation, database error | `error` field in event_log | Yes (on next delivery) | 500 |
| `error_task_creation` | TaskService failure, project not found, database error | `error` field in event_log | Yes (on next delivery) | 500 |

### Partial Failure in Task Creation

If a subscription matches but task creation fails for that subscription:

1. Tasks already created by earlier subscriptions in the batch are **kept** (not rolled back).
2. The event is marked as `error_task_creation` with details about which subscription failed.
3. The `matchedSubscriptions` field still contains all matched subscription IDs.
4. The external system can retry delivery, which will hit deduplication -- so manual intervention may be needed for partial failures.

### Recovery

For `error_matching` and `error_task_creation` states, an admin can:

1. View the failed event in the event log UI.
2. Inspect the payload and error message.
3. Fix the underlying issue (e.g., re-enable a project, fix a filter).
4. Manually replay the event via a future API endpoint (not in v1).

---

## Event Log Status Transitions

```
received
  ├── error_signature       (terminal)
  │
  └── signature_verified
        ├── error_parse     (terminal)
        │
        └── parsed
              ├── error_duplicate   (terminal, 200)
              │
              └── deduplicated
                    ├── error_matching   (terminal)
                    │
                    └── matched
                          ├── completed (0 matches, terminal)
                          │
                          ├── error_task_creation   (terminal)
                          │
                          └── tasks_created
                                │
                                └── completed   (terminal)
```

---

## Timing

| Stage | Expected Duration | Timeout |
|-------|-------------------|---------|
| Signature verification | < 1ms | N/A (CPU-bound) |
| Payload parsing | < 5ms | N/A (CPU-bound) |
| Deduplication check | < 10ms | 5s (database) |
| Subscription matching | < 50ms (depends on filter count) | 5s |
| Task creation (per match) | < 100ms | 10s (database + optional agent start) |
| **Total pipeline** | **< 500ms typical** | **30s hard timeout** |

The 30-second hard timeout ensures the webhook response is sent before most external systems' timeout (typically 30-60 seconds).

---

## SSE Event Emission

At each state transition, an SSE event is emitted to connected clients via `GET /api/events/stream`:

| Pipeline Stage | SSE Event | Data |
|----------------|-----------|------|
| `received` | `event:received` | `{ id, eventSourceId, eventType, action, deliveryId }` |
| Any status change | `event:status` | `{ id, status, error? }` |
| `matched` (with matches) | `event:matched` | `{ id, matchedSubscriptions, taskIds }` |

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [Database Schema](./database-schema.md) | `EventLogStatus` enum defines all states |
| [Plugin Interface](./plugin-interface.md) | Plugin methods called at each pipeline stage |
| [API Endpoints](./api-endpoints.md) | Webhook endpoint drives the pipeline; SSE streams state changes |
| [Prompt Templates](./prompt-templates.md) | Template rendering occurs between `matched` and `tasks_created` |
| [Task Service](../application/services/task-service.md) | Task creation at the `tasks_created` stage |
| [Agent Service](../application/services/agent-service.md) | Optional agent auto-start after task creation |
