# Architecture Review: Real-Time Streaming & Events

**Area**: 06 - Real-Time Streaming & Events
**Date**: 2026-03-18
**Reviewer**: Architecture Review (Automated)
**Status**: Complete

---

## Executive Summary

AgentPane's real-time streaming infrastructure is built on a **dual-layer architecture**: Caddy's `durable_streams` plugin (backed by LMDB) handles SSE delivery to clients, while a SQLite/PostgreSQL `session_events` table provides persistent event storage for replay and historical queries. The `DurableStreamsService` orchestrates both layers with a "persist-first, broadcast-second" strategy. Three independent SSE subsystems exist: (1) Durable Streams for session/plan/terraform/container-agent events, (2) an in-process event bus for webhook event notifications, and (3) a local subscriber system for CLI monitor updates. The architecture is generally sound but has notable gaps in backpressure handling, presence store cleanup, and dual-write consistency.

---

## Architecture Overview

```mermaid
graph TB
    subgraph "Agent Execution"
        AR[Agent Runner<br/>container/AgentCore] -->|JSON lines stdout| CB[ContainerBridge]
        AR -->|SSE events| ACB[AgentCoreBridge]
    end

    subgraph "Backend Services"
        CB -->|publish| DSS[DurableStreamsService]
        ACB -->|publish| DSS
        PMS[PlanModeService] -->|publish| DSS
        TCS[TaskCreationService] -->|publish| DSS
        TFC[TerraformComposeService] -->|publish| DSS
        SPS[SessionPresenceService] -->|publish| SSS[SessionStreamService]
        SSS -->|publish| CDSS[CaddyDurableStreamsServer]

        DSS -->|1. persist| DB[(session_events<br/>SQLite/PG)]
        DSS -->|2. broadcast| CDSS

        CMS[CliMonitorService] -->|local subscribers| SSE_CLI[CLI Monitor SSE]
        EB[EventBus] -->|listeners| SSE_EVT[Events SSE]
    end

    subgraph "Caddy / DurableStreamTestServer"
        CDSS -->|IdempotentProducer| CADDY[Caddy durable_streams<br/>LMDB persistence]
    end

    subgraph "Client (Browser)"
        DS_CLIENT[DurableStreamsClient<br/>@durable-streams/client] -->|SSE| CADDY
        US[useSession hook] --> DS_CLIENT
        UPS[usePlanSession hook] --> DS_CLIENT
        UTS[useTopologyStream hook] --> DS_CLIENT
        UTA[useTaskActivity hook] --> DS_CLIENT
        TC[TerraformContext] --> DS_CLIENT
        SSE_CLI_C[EventSource] -->|SSE| SSE_CLI
        SSE_EVT_C[EventSource] -->|SSE| SSE_EVT
    end
```

---

## 1. Durable Streams Integration

### Configuration

**Production**: Caddy serves durable streams on port 3000 via the `durable_streams` plugin with LMDB persistence.

```
# Caddyfile lines 14-19
@streams path /v1/stream /v1/stream/*
handle @streams {
    durable_streams {
        data_dir {$STREAMS_DATA_DIR:/app/data/streams}
        long_poll_timeout 30s
        sse_reconnect_interval 120s
    }
}
```

**Development**: `DurableStreamTestServer` runs on port 3002, proxied through Vite's dev server.

```typescript
// vite.config.ts lines 68-73
'/v1/stream': {
    target: 'http://localhost:3002',
    changeOrigin: true,
    timeout: 0,
    proxyTimeout: 0,
},
```

**Server Initialization** (`src/server/api.ts` lines 533-548):
```typescript
const streamsServerUrl =
  process.env.CADDY_STREAMS_URL ??
  (process.env.NODE_ENV === 'production'
    ? 'http://localhost:3000/v1/stream'
    : 'http://localhost:3002/v1/stream');
const caddyStreamsServer = new CaddyDurableStreamsServer(streamsServerUrl);
const durableStreamsService = new DurableStreamsService(caddyStreamsServer, db);
```

### Stream ID to URL Mapping

The `CaddyDurableStreamsServer` maps stream IDs to Caddy URL paths (`src/lib/streams/caddy-producer.ts` lines 12-21):

| Stream ID Pattern | URL Path |
|---|---|
| `cli-monitor` | `/v1/stream/cli-monitor` |
| `terraform:{jobId}` | `/v1/stream/terraform/{jobId}` |
| `plan:{sessionId}` | `/v1/stream/plans/{sessionId}` |
| `{sessionId}` | `/v1/stream/sessions/{sessionId}` |

### Producer Configuration

The `IdempotentProducer` is configured with batching (`src/lib/streams/caddy-producer.ts` lines 86-103):
- `autoClaim: true` -- auto-claims the stream on first write
- `lingerMs: 5` -- micro-batching with 5ms linger
- `maxBatchBytes: 1_048_576` -- 1MB max batch
- `maxInFlight: 5` -- up to 5 concurrent in-flight batches
- On error: invalidates the producer and detaches, forcing re-initialization on next publish

### Finding RS-001: Producer Pool Has No Upper Bound

**Severity**: Medium
**Location**: `src/lib/streams/caddy-producer.ts` lines 31, 106

The `producers` Map grows unboundedly. Each unique stream ID creates a new `DurableStream` + `IdempotentProducer` pair that is never cleaned up unless `deleteStream()` is explicitly called or the producer errors out. For long-running servers with many sessions, this could consume significant memory.

```typescript
private producers = new Map<string, ProducerEntry>();
// ...
this.producers.set(id, entry); // Never evicted unless explicitly deleted
```

**Recommendation**: Implement an LRU eviction policy or idle-timeout cleanup for producers. The Terraform compose service has its own session cleanup (TTL of 30 minutes, max 100), but the producer pool at the transport layer does not mirror this.

---

## 2. SSE Lifecycle

### Three SSE Subsystems

The codebase has **three distinct SSE delivery mechanisms**:

| # | Subsystem | Endpoint | Transport | Heartbeat | Max Connections |
|---|-----------|----------|-----------|-----------|-----------------|
| 1 | Durable Streams | `/v1/stream/*` (Caddy) | `@durable-streams/client` SSE | Caddy-managed (120s reconnect) | N/A (Caddy managed) |
| 2 | Event Bus SSE | `GET /api/events/stream` | In-process `ReadableStream` | 15s ping | 50 (global) |
| 3 | CLI Monitor SSE | `GET /api/cli-monitor/stream` | In-process `ReadableStream` | 15s ping | 50 (module-scoped) |

### Durable Streams SSE Lifecycle (Primary)

**Client connection** (`src/lib/streams/client.ts` lines 656-830):
1. Bootstrap phase checks if Caddy is reachable via HEAD request to `/v1/stream`
2. `setStreamsAvailable(true/false)` gates all subsequent subscriptions
3. Client calls `durableStream()` with `live: 'sse'`, `offset: '-1'` (replay all)
4. The `@durable-streams/client` library handles SSE connection, parsing, and reconnection
5. Events are dispatched to typed callbacks via `subscribeJson()`

**Shared subscriptions** (`src/lib/streams/client.ts` lines 1399+): Multiple components subscribing to the same session ID share a single SSE connection, with a fan-out subscriber map.

### In-Process SSE Lifecycle (Events and CLI Monitor)

**Events SSE** (`src/server/routes/events.ts` lines 1203-1320):
1. Auth check validates user identity and team membership
2. Builds `allowedSourceIds` set for event scoping
3. Creates `ReadableStream<Uint8Array>` with manual SSE formatting
4. Registers listener on `eventStreamListeners` Set (event bus)
5. 15-second keep-alive ping interval
6. Cleanup on `cancel()` or ping failure

**CLI Monitor SSE** (`src/server/routes/cli-monitor.ts` lines 373-469):
1. Connection limit check (50 max)
2. Sends initial snapshot (live sessions or historical from DB)
3. Subscribes to `cliMonitorService.addRealtimeSubscriber()`
4. 15-second keep-alive ping interval
5. Cleanup on `cancel()` or ping failure

### Finding RS-002: Duplicate SSE Connection Tracking

**Severity**: Low
**Location**: `src/lib/events/event-bus.ts` lines 7-8, `src/server/routes/cli-monitor.ts` lines 171-174

The event bus and CLI monitor both maintain their own `activeSSEConnections` counter and `MAX_SSE_CONNECTIONS` limit of 50, but these are separate module-scoped variables. Under load, the system could have up to 100 SSE connections across both subsystems (50 + 50), and neither knows about the other.

```typescript
// event-bus.ts
let activeSSEConnections = 0;
export const MAX_SSE_CONNECTIONS = 50;

// cli-monitor.ts
const MAX_SSE_CONNECTIONS = 50;
let activeSSEConnections = 0;
```

**Recommendation**: Centralize SSE connection tracking or at minimum document the aggregate limit.

### Finding RS-003: SSE Cleanup Race in Ping Handler

**Severity**: Low
**Location**: `src/server/routes/events.ts` lines 1286-1306, `src/server/routes/cli-monitor.ts` lines 438-452

In both SSE endpoints, the ping interval's catch block tries to clean up and close the controller. However, the `cancel()` callback also performs cleanup. If the ping fails and `cancel()` fires simultaneously, the double-cleanup could cause issues. The events route guards with `if (cleaned) return;` but the CLI monitor route does not use the same guard pattern -- it sets `streamClosed` in `cancel()` and checks it in `send()`, but the ping handler does not check `streamClosed`.

---

## 3. Event Schemas

### StreamEventMap (Type-Safe Event Registry)

The central type registry is at `src/services/durable-streams.service.ts` lines 406-466. All 48 event types are enumerated:

| Category | Event Types | Count |
|----------|------------|-------|
| Plan | `plan:started`, `plan:turn`, `plan:token`, `plan:interaction`, `plan:completed`, `plan:error`, `plan:cancelled` | 7 |
| Sandbox | `sandbox:creating`, `sandbox:ready`, `sandbox:idle`, `sandbox:stopping`, `sandbox:stopped`, `sandbox:error`, `sandbox:tmux:created`, `sandbox:tmux:destroyed` | 8 |
| Task Creation | `task-creation:started`, `task-creation:message`, `task-creation:token`, `task-creation:suggestion`, `task-creation:questions`, `task-creation:processing`, `task-creation:completed`, `task-creation:cancelled`, `task-creation:error` | 9 |
| Container Agent | `container-agent:status`, `container-agent:started`, `container-agent:token`, `container-agent:turn`, `container-agent:tool:start`, `container-agent:tool:result`, `container-agent:message`, `container-agent:complete`, `container-agent:error`, `container-agent:cancelled`, `container-agent:task-update-failed`, `container-agent:plan_ready`, `container-agent:worktree`, `container-agent:file_changed` | 14 |
| Topology | `topology:agent_spawned`, `topology:agent_progress`, `topology:agent_completed` | 3 |
| Terraform | `terraform:status`, `terraform:text`, `terraform:modules`, `terraform:questions`, `terraform:code`, `terraform:done`, `terraform:error` | 7 |
| **Total TypedEventType** | | **48** |

### SessionEventType (Session-Scoped Events)

Defined at `src/services/session/types.ts` lines 5-44:

| Category | Event Types | Count |
|----------|------------|-------|
| Core | `chunk`, `tool:start`, `tool:result` | 3 |
| Presence | `presence:joined`, `presence:left`, `presence:cursor` | 3 |
| Terminal | `terminal:input`, `terminal:output` | 2 |
| Approval | `approval:requested`, `approval:approved`, `approval:rejected` | 3 |
| State | `state:update` | 1 |
| Agent | `agent:started`, `agent:planning`, `agent:plan_ready`, `agent:turn`, `agent:turn_limit`, `agent:completed`, `agent:error`, `agent:warning`, `agent:metrics`, `agent:tool_progress`, `agent:compacted`, `agent:rate_limit` | 12 |
| Container Agent (subset) | `container-agent:started`, through `container-agent:plan_ready` | 10 |
| Topology (subset) | `topology:agent_spawned`, `topology:agent_progress`, `topology:agent_completed` | 3 |
| **Total SessionEventType** | | **37** |

### Agent Runner Event Type Map

The bridge layer (`src/lib/agents/event-type-map.ts`) maps 13 agent-runner event types to durable stream types:

```typescript
export const EVENT_TYPE_MAP: Record<AgentRunnerEventType, TypedEventType> = {
  'agent:started': 'container-agent:started',
  'agent:token': 'container-agent:token',
  // ... 11 more mappings
  'agent:topology:completed': 'topology:agent_completed',
};
```

### Finding RS-004: Schema Divergence Between Durable Streams Schema and Runtime Types

**Severity**: Medium
**Location**: `src/lib/integrations/durable-streams/schema.ts`, `src/services/durable-streams.service.ts`

The `@durable-streams/state` schema (`src/lib/integrations/durable-streams/schema.ts`) defines structured Zod schemas for session channels (chunks, toolCalls, presence, terminal, workflow, agentState), but the `DurableStreamsService` publishes events with ad-hoc `StreamEventMap` interfaces. These two type systems are not connected -- the durable streams schema expects specific fields like `agentId` and `sessionId` on every chunk, while the `StreamEventMap` types have different field names and shapes.

For example, `ChunkEvent` in the schema requires `{ id, agentId, sessionId, text, timestamp }`, but the client-side `rawChunkDataSchema` validates `{ text, agentId? }` -- missing `id`, `sessionId`, and using different optionality rules.

**Recommendation**: Reconcile or deprecate one of the two schema systems. The `sessionSchema` from `@durable-streams/state` appears to be an aspirational design that is not enforced at publish time.

### Finding RS-005: Inconsistent Event Type Naming Conventions

**Severity**: Low
**Location**: Various

Event types use inconsistent naming:
- Colons for namespacing: `plan:started`, `tool:start`
- Hyphens in namespace: `container-agent:started`, `task-creation:started`
- Underscores in event names: `plan_ready`, `agent_spawned`, `file_changed`
- Mixed: `topology:agent_spawned` vs `container-agent:plan_ready`

No single convention is applied consistently.

---

## 4. Reconnection Logic

### Durable Streams Client Reconnection

The client (`src/lib/streams/client.ts`) delegates reconnection to the `@durable-streams/client` library's `onError` callback mechanism:

**Plan Session** (`src/app/components/features/plan-session-view/use-plan-session.ts` lines 175-203):
```typescript
const response = await durableStream({
    url: `/v1/stream/plans/${sessionId}`,
    live: 'sse',
    offset: '-1',
    json: true,
    onError: (error) => {
        retryCount++;
        if (retryCount >= MAX_STREAM_RETRIES) {
            dispatch({ type: 'SET_ERROR', error: '...' });
            return; // Stop retrying
        }
        return {}; // Signal retry
    },
});
```

**Topology Stream** (`src/app/hooks/use-topology-stream.ts` lines 183-189):
```typescript
onDisconnect: () => {
    disconnectCount++;
    if (!hasReceivedEvent && disconnectCount >= 5) {
        subscription.unsubscribe();
    }
},
```

### Offset-Based Resume

The durable streams client passes `offset: '-1'` to replay all events from the beginning. The Caddy server tracks offsets in LMDB. On reconnect, the client resumes from its last known offset automatically (handled by the `@durable-streams/client` library).

### CLI Monitor Reconnection

The `EventSource` API provides automatic reconnection. The `startCliMonitorSync` function (`src/lib/cli-monitor/sync.ts` lines 102-107) counts reconnection errors and triggers `onConnectionError` after 5 failures:

```typescript
source.onerror = () => {
    reconnectCount++;
    if (reconnectCount >= 5) {
        callbacks.onConnectionError?.();
    }
};
```

### Finding RS-006: No Gap Detection on Reconnect for Session Streams

**Severity**: Medium
**Location**: `src/lib/streams/client.ts`, `src/app/hooks/use-session.ts`

The `useSession` hook appends events to arrays on each callback. When the connection drops and reconnects, there is no mechanism to detect whether events were missed during the gap. The durable streams library resumes from the last offset, but if the client lost events before processing them (e.g., during a JavaScript GC pause or tab backgrounding), those events are silently lost from the client state.

Additionally, the `useSession` hook does not fetch historical events from the REST API on reconnect -- it only relies on the SSE stream. Compare this with `useTaskActivity` which fetches `/api/sessions/:id/events` on mount for historical data.

**Recommendation**: On reconnect, either (a) fetch full event history from the REST API and reconcile, or (b) track the last processed offset and request replay from that offset.

---

## 5. Presence System

### Architecture

Presence is managed entirely in-memory via a shared `Map<string, Map<string, ActiveUser>>` at the `SessionService` level (`src/services/session.service.ts` line 51):

```typescript
const presenceStore = new Map<string, Map<string, ActiveUser>>();
```

**Join/Leave flow** (`src/services/session/session-presence.service.ts`):
1. User calls `POST /api/sessions/:id/presence` with `{ userId, action: 'join' }`
2. `SessionPresenceService.join()` adds user to the in-memory store
3. Publishes `presence:joined` event to the durable stream
4. Client receives the event via SSE and updates local state

**Heartbeat** (`src/app/hooks/use-session.ts` lines 230-246):
```typescript
const PRESENCE_HEARTBEAT_INTERVAL = 10000; // 10 seconds
const interval = window.setInterval(updatePresence, PRESENCE_HEARTBEAT_INTERVAL);
```

### Finding RS-007: Presence Store Never Cleans Up Stale Users

**Severity**: High
**Location**: `src/services/session/session-presence.service.ts`, `src/services/session.service.ts` line 51

The presence store is an in-memory `Map` that grows as users join sessions but has **no cleanup mechanism** for stale entries:

1. **No TTL-based cleanup**: If a user's browser crashes or loses connectivity, the `leave()` call in `useSession`'s cleanup never fires. The user remains "present" indefinitely.
2. **No heartbeat validation server-side**: The client sends heartbeat POSTs every 10 seconds, but the server's `updatePresence()` only updates `lastSeen` -- nothing ever checks whether `lastSeen` is stale and removes the user.
3. **No persistence**: The presence store is in-memory only, so a server restart clears all presence data. There is no recovery mechanism.
4. **Unbounded growth**: For sessions that accumulate many users over time, the presence maps grow indefinitely.

**Recommendation**: Implement a server-side sweep that removes users whose `lastSeen` exceeds 2-3x the heartbeat interval (e.g., 30 seconds). Consider running this on a periodic timer (e.g., every 30 seconds).

---

## 6. Backpressure

### Finding RS-008: No Backpressure Mechanism for High-Frequency Events

**Severity**: Medium
**Location**: `src/services/durable-streams.service.ts`, `src/lib/streams/caddy-producer.ts`

The system has **no explicit backpressure** between event producers and the streaming infrastructure:

1. **Agent token events**: During Claude SDK streaming, `container-agent:token` events fire for every text delta. Each event triggers: (a) DB insert with offset calculation, (b) Caddy publish via IdempotentProducer. The `lingerMs: 5` setting on the producer provides micro-batching, but there is no throttling of the publish rate from the service layer.

2. **DB write pressure**: `DurableStreamsService.persistToDb()` does a SELECT (to find max offset) + INSERT for every single event. Under high token throughput (many concurrent agents), this could create significant SQLite write contention.

3. **Client-side accumulation**: The `useSession` hook appends every chunk to a growing `chunks` array via `setState`. For long-running sessions with thousands of token events, this array grows unboundedly, potentially causing memory pressure and rendering performance degradation.

**Existing mitigations**:
- The `IdempotentProducer` has `maxInFlight: 5` limiting concurrent batches to Caddy
- The `useTopologyStream` hook uses `requestAnimationFrame` batching for progress updates
- The Caddy producer's `lingerMs: 5` micro-batches writes

**Recommendation**: Consider throttling or batching high-frequency events (especially token deltas) at the service layer before persisting. For the client, implement a sliding window or pagination for chunk history.

---

## 7. Event Bus Architecture

### In-Process Event Bus (`src/lib/events/event-bus.ts`)

This is a minimal pub/sub system for the webhook event notification subsystem:

```typescript
let activeSSEConnections = 0;
const eventStreamListeners = new Set<EventStreamListener>();

export function publishEventToStream(event: { type: string; data: unknown }): void {
    for (const listener of eventStreamListeners) {
        try {
            listener(event);
        } catch (err) {
            eventStreamListeners.delete(listener);
        }
    }
}
```

This event bus is **completely separate** from the durable streams infrastructure. It is used exclusively for the `/api/events/stream` SSE endpoint that notifies the frontend about webhook events (GitHub pushes, cron triggers, etc.).

### CLI Monitor Local Subscriber System

The `CliMonitorService` (`src/services/cli-monitor/cli-monitor.service.ts` lines 25-28, 282-289) maintains its own set of local subscribers:

```typescript
private localSubscribers = new Set<
    (event: { type: string; data: unknown; offset: number }) => void
>();

addRealtimeSubscriber(callback): () => void {
    this.localSubscribers.add(callback);
    return () => { this.localSubscribers.delete(callback); };
}
```

Events are dual-published to both Caddy (via `streamsServer.publish()`) and local subscribers (via in-process iteration). This dual delivery is necessary because the CLI monitor SSE endpoint (`/api/cli-monitor/stream`) serves events directly from the Bun process, not through Caddy.

### Event Processing Pipeline (Webhook Events)

The webhook event pipeline (`src/services/event-processing.service.ts`) is a distinct subsystem:
1. Webhook received at `/api/events/webhooks/:slug`
2. Plugin verifies signature and normalizes event
3. Event matched against subscriptions
4. Tasks created for matching subscriptions
5. `publishEventToStream()` notifies connected SSE clients

### Finding RS-009: Three Disconnected Event Delivery Systems

**Severity**: Low (architectural observation)
**Location**: System-wide

The codebase has three independent event delivery mechanisms:
1. **Durable Streams** (Caddy/LMDB + DB persistence) for agent/plan/terraform events
2. **Event Bus** (in-process Set iteration) for webhook event notifications
3. **CLI Monitor Local Subscribers** (in-process Set iteration) for CLI session updates

Each has its own connection tracking, cleanup logic, and delivery semantics. While this separation may be intentional (different durability and latency requirements), it increases the surface area for bugs and makes the system harder to reason about.

---

## 8. Memory Leaks

### Finding RS-010: Shared Subscription Map Never Cleans Up Inactive Sessions

**Severity**: Medium
**Location**: `src/lib/streams/client.ts` (shared subscriptions around line 1399+)

The `sharedSubscriptions` Map at module scope creates entries keyed by `sessionId`. When all subscribers for a session unsubscribe, the entry's `subscriberMap` becomes empty, but the implementation should clean up the entry from `sharedSubscriptions`. Without reading the full implementation of the unsubscribe logic, if this cleanup is missing, the map will grow indefinitely as users navigate between sessions.

### Finding RS-011: useSession Hook Unbounded Array Growth

**Severity**: Medium
**Location**: `src/app/hooks/use-session.ts` lines 137-148

The `chunks` array in `useSession` state grows without bound:

```typescript
onChunk: (event) => {
    setState((prev) => ({
        ...prev,
        chunks: [...prev.chunks, { text: event.data.text, ... }],
    }));
},
```

For a long-running agent session producing thousands of token events, this creates continuous memory pressure. The same pattern applies to `toolCalls` and `terminal` arrays.

**Recommendation**: Implement a maximum buffer size (e.g., keep last 1000 chunks) or use a ring buffer pattern.

### Finding RS-012: EventSource Cleanup on Reconnect

**Severity**: Low
**Location**: `src/lib/cli-monitor/sync.ts` lines 28-112

The `startCliMonitorSync` function creates a single `EventSource`. If the `onerror` handler fires 5+ times, `onConnectionError` is called but the EventSource is never closed -- it will continue attempting reconnections per the browser's EventSource spec (typically with exponential backoff). The cleanup function is only invoked externally. This is not a leak per se (the browser manages the EventSource), but it means failed connections continue consuming resources until the component unmounts.

---

## 9. Error Handling

### Publish Failure Strategy

The `DurableStreamsService` uses a **persist-first, broadcast-second** strategy (`src/services/durable-streams.service.ts` lines 625-660):

```typescript
// Persist to database FIRST (ensures durability)
const offset = await this.persistToDb(streamId, eventId, type, channel, data, timestamp);

// THEN publish to Caddy streams server (best-effort)
try {
    memoryOffset = await this.server.publish(streamId, type, data);
} catch (caddyErr) {
    console.warn('[DurableStreamsService] Caddy publish failed (event is persisted in DB)');
}
```

If DB persistence succeeds but Caddy publish fails, the event is durable in the database but may not be delivered in real-time. Clients can hydrate from the database on page refresh.

### Finding RS-013: Dual-Write Inconsistency Between DB and Caddy

**Severity**: Medium
**Location**: `src/services/durable-streams.service.ts` lines 625-660, `src/services/session/session-stream.service.ts` lines 43-75

There are **two competing persistence strategies**:

1. **`DurableStreamsService.publish()`**: DB-first, Caddy-second (best-effort). Used by plan, terraform, container-agent, sandbox, task-creation events.

2. **`SessionStreamService.publish()`**: Caddy-first, DB-second (non-blocking fire-and-forget). Used by session events (chunks, tools, presence, etc.).

```typescript
// SessionStreamService.publish() - Caddy first, DB fire-and-forget
const offset = await this.streams.publish(sessionId, event.type, event.data);
this.persistEvent(sessionId, event).then(/* non-blocking */);
```

This means:
- For DurableStreamsService events: if Caddy is down, events are still in DB (good)
- For SessionStreamService events: if DB insert fails, the event is lost from the database but was sent via Caddy (eventual consistency gap)
- The DB offset calculation (SELECT max + INSERT) is duplicated in both services

**Recommendation**: Standardize on one persistence strategy. The DB-first approach is safer for durability.

### Finding RS-014: Offset Collision Retry is Limited to 3 Attempts

**Severity**: Low
**Location**: `src/services/durable-streams.service.ts` lines 566-598

The `persistToDb()` method handles offset uniqueness violations with a 3-retry loop. If three concurrent writes all collide, the event is silently lost (the function returns `offset` from the last attempt without actually inserting):

```typescript
for (let attempt = 0; attempt < MAX_OFFSET_RETRIES; attempt++) {
    // ... SELECT max offset, INSERT ...
    // On constraint violation, continue
}
return offset; // May not have been actually inserted!
```

Under high concurrency (multiple agents publishing to the same session), 3 retries may not be sufficient.

### Finding RS-015: CaddyDurableStreamsServer Subscribe Returns Empty Iterator

**Severity**: Low (by design)
**Location**: `src/lib/streams/caddy-producer.ts` lines 142-157

The `subscribe()` method returns an empty async iterable by design -- server-side subscription is not used because clients subscribe directly to Caddy. However, the `SessionStreamService.subscribe()` method calls `getHistory()` which returns DB events, creating an inconsistency where the subscribe contract suggests real-time events but only delivers historical replay.

---

## 10. Additional Findings

### Finding RS-016: Terraform Compose Deletes and Recreates Streams on Each Request

**Severity**: Low
**Location**: `src/services/terraform-compose.service.ts` lines 126-138

On each compose request for an existing session, the stream is deleted and recreated:

```typescript
await this.durableStreamsService.deleteStream(streamId).catch(() => {});
await this.durableStreamsService.createStream(streamId, null);
```

This prevents stale event replay for multi-turn conversations but means clients subscribed to the old stream may lose their connection without a clean error. The client handles this via its own retry logic, but there is a window where events could be missed between the delete and the new stream's first event.

### Finding RS-017: Agent Runner Uses Synchronous stdout Writes for Critical Events

**Severity**: Informational (well-designed)
**Location**: `agent-runner/src/event-emitter.ts` lines 158-184

The `EventEmitter` differentiates between critical and non-critical events:
- **Synchronous** (`writeSync(STDOUT_FD, line)`): started, turn, tool:result, message, complete, error, cancelled, plan_ready, topology:spawned, topology:completed
- **Asynchronous** (`process.stdout.write(line)`): token, tool:start, file_changed, topology:progress

This is a thoughtful design that ensures critical lifecycle events are delivered immediately even if the process is about to exit, while high-frequency events use buffered writes for performance.

### Finding RS-018: Client-Side Streams Availability Gate

**Severity**: Informational (well-designed)
**Location**: `src/lib/streams/client.ts` lines 1351-1364, `src/lib/bootstrap/phases/streams.ts`

The bootstrap phase probes the streams endpoint with a HEAD request and 3-second timeout. If unreachable (common in dev without Caddy), `setStreamsAvailable(false)` prevents all subscription attempts, avoiding retry loops that exhaust browser connections. This is a good defensive pattern.

---

## SSE Endpoint Inventory

| Endpoint | Location | Transport | Auth | Connection Limit | Heartbeat | Reconnection |
|----------|----------|-----------|------|-----------------|-----------|-------------|
| `/v1/stream/sessions/:id` | Caddy (external) | Caddy SSE | None (public) | Caddy-managed | 120s SSE reconnect | Client-managed (`@durable-streams/client`) |
| `/v1/stream/plans/:id` | Caddy (external) | Caddy SSE | None (public) | Caddy-managed | 120s SSE reconnect | Client-managed, max 5 retries |
| `/v1/stream/terraform/:id` | Caddy (external) | Caddy SSE | None (public) | Caddy-managed | 120s SSE reconnect | Client-managed, max 5 retries |
| `/v1/stream/cli-monitor` | Caddy (external) | Caddy SSE | None (public) | Caddy-managed | 120s SSE reconnect | Not used client-side |
| `/api/events/stream` | `src/server/routes/events.ts:1203` | In-process ReadableStream | Auth required | 50 (event-bus) | 15s ping | Browser EventSource auto |
| `/api/cli-monitor/stream` | `src/server/routes/cli-monitor.ts:373` | In-process ReadableStream | None | 50 (module-scoped) | 15s ping | Browser EventSource auto |

### Finding RS-019: Caddy SSE Endpoints Have No Authentication

**Severity**: Medium
**Location**: `Caddyfile` lines 13-19

The Caddy `durable_streams` handler matches all paths under `/v1/stream/*` with no authentication. Anyone who can reach the Caddy port can subscribe to any stream by ID. In production, Caddy sits behind a reverse proxy or load balancer, but if exposed directly, all session events (including agent output, tool calls, and presence data) are accessible without authentication.

The in-process `/api/events/stream` endpoint properly validates authentication and scopes events to the user's teams (`events.ts` lines 1204-1222).

**Recommendation**: Add authentication middleware to the Caddy streams path, or ensure network-level access control prevents direct access to the Caddy port from untrusted networks.

---

## Findings Summary

| ID | Title | Severity | Category |
|----|-------|----------|----------|
| RS-001 | Producer pool has no upper bound | Medium | Memory |
| RS-002 | Duplicate SSE connection tracking | Low | Architecture |
| RS-003 | SSE cleanup race in ping handler | Low | Reliability |
| RS-004 | Schema divergence between durable streams schema and runtime types | Medium | Type Safety |
| RS-005 | Inconsistent event type naming conventions | Low | Consistency |
| RS-006 | No gap detection on reconnect for session streams | Medium | Reliability |
| RS-007 | Presence store never cleans up stale users | High | Memory Leak |
| RS-008 | No backpressure for high-frequency events | Medium | Performance |
| RS-009 | Three disconnected event delivery systems | Low | Architecture |
| RS-010 | Shared subscription map cleanup uncertainty | Medium | Memory |
| RS-011 | useSession hook unbounded array growth | Medium | Memory |
| RS-012 | EventSource cleanup on reconnect | Low | Resource Management |
| RS-013 | Dual-write inconsistency between DB and Caddy | Medium | Consistency |
| RS-014 | Offset collision retry limited to 3 attempts | Low | Reliability |
| RS-015 | Subscribe returns empty iterator | Low | API Contract |
| RS-016 | Terraform stream delete/recreate on each request | Low | Reliability |
| RS-017 | Sync/async stdout write differentiation | Informational | Good Design |
| RS-018 | Client-side streams availability gate | Informational | Good Design |
| RS-019 | Caddy SSE endpoints have no authentication | Medium | Security |

### Priority Recommendations

1. **RS-007** (High): Implement server-side presence cleanup with TTL-based eviction
2. **RS-013** (Medium): Standardize dual-write strategy across both service layers
3. **RS-008** (Medium): Add throttling/batching for high-frequency token events at the service layer
4. **RS-019** (Medium): Add authentication to Caddy stream endpoints or enforce network-level access control
5. **RS-006** (Medium): Implement gap detection and historical fetch on client reconnection
6. **RS-001** (Medium): Add LRU eviction to the producer pool
