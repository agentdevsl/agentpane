# Event Sourcing, CQRS, Schema Evolution, Outbox & Saga Patterns Research

**Date:** March 2026
**Current Stack:** SQLite session_events (append-only) | Durable Streams | ChunkBatcher | StreamEventMap (40+ typed events) | Agent lifecycle state machines

---

## 1. Event Sourcing for Agent Execution

### Current State

AgentPane already has the structural bones of an event-sourced system:

- **Append-only event log**: `session_events` table with monotonic offsets, session scoping, channel grouping
- **Atomic offset calculation**: `INSERT...SELECT COALESCE(MAX(offset), -1) + 1` for race-free ordering
- **Event replay**: `getEventsBySession()` returns ordered events; `DurableStreamsClient` supports `fromOffset` resume
- **State derivation**: Frontend TanStack DB collections are projections materialized from the event stream via `syncSessionToCollections()`

### What Is Missing for Full Event Sourcing

1. **Events are not the single source of truth** — Entity tables (`agents`, `tasks`, `sessions`, `worktrees`, `agent_runs`) are mutated directly alongside event emission. If event publish fails, state tables and event log diverge.
2. **No aggregate reconstruction from events** — Can't rebuild an agent's state by replaying events. The `agents` table's `status`/`currentTaskId`/`currentTurn` are authoritative, not derived.
3. **Events lack domain-level completeness** — `SessionEvent.data` is typed as `unknown`. Events capture effects, not the commands that caused state changes.

### Recommendation: Partial Event Sourcing (Sessions Only)

Full event sourcing for all entities would be overengineered. However, **agent execution sessions are a natural event-sourced aggregate**:

- Clear aggregate root (session)
- Append-only lifecycle (events flow forward, never edited)
- Replay requirements (reconnecting clients, debugging, audit)
- Temporal queries ("what was the agent doing at T?")

**Actions:**

1. Make `session_events` the authoritative source for session state — derive `session.status` from latest lifecycle event instead of direct DB writes
2. Keep entity tables for non-session aggregates (tasks, agents, codespaces, worktrees) — CRUD entities where event sourcing adds complexity without benefit
3. Don't adopt EventStoreDB or Marten — overkill for SQLite. The `session_events` table already provides essential event store semantics
4. Sequin (Postgres CDC) is premature — only relevant if/when migrating to Postgres

### Event Store Enhancement

Add `schema_version` to `session_events`:

```sql
ALTER TABLE session_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
```

Enables forward-compatible event versioning without migration pain.

---

## 2. CQRS (Command Query Responsibility Segregation)

### Already Implicit in the Architecture

| Aspect | Write Side | Read Side |
|--------|-----------|-----------|
| Agent execution | `stream-handler.ts` -> `sessionService.publish()` | SSE via Caddy -> `DurableStreamsClient` |
| DB persistence | `SessionStreamService.persistEvent()` with atomic offset | `getEventsBySession()` with pagination |
| Frontend state | Events pushed to TanStack DB collections | `useCollection()` queries over local collections |
| Batching | `ChunkBatcher.flush()` batches to DB | `ChunkBatcher.addDelta()` pushes realtime to SSE |

The `ChunkBatcher` is a textbook CQRS optimization: write path batched at 100ms, read path immediate per-delta.

### Where to Formalize

1. **Extract command types** from route handlers into `src/lib/commands/` — plain objects with discriminant `type` field. Makes intent explicit and testable
2. **Build projection functions** — update read-model tables from events. Register as subscribers decoupled from write path
3. **Enhance session_summaries** — currently only updates `updatedAt`. Should compute real aggregates (cost, tokens, turns) from `agent:metrics` events
4. **Don't introduce MediatR pattern** — Hono middleware handles cross-cutting concerns, TypeScript modules eliminate service locator need
5. **Don't introduce separate read database** — SQLite handles both workloads at current scale

---

## 3. Event Schema Evolution

### Current Problem: 4 Duplicate Type Systems

Event data shapes are defined in at least 4 places with no single source of truth:

- `SessionEventType` in `session/types.ts` — 30+ string literals, `data: unknown`
- `StreamEventMap` in `durable-streams.service.ts` — compile-time type safety for publish
- `AgentRunnerEventType` in `event-type-map.ts` — container event mapping
- Client-side Zod schemas in `streams/client.ts` — runtime validation (~15 schemas)

### Recommendation: Unified Discriminated Union + Zod

Consolidate into a single source of truth:

```typescript
// src/lib/events/schema.ts — SINGLE source of truth
const ChunkEventV1 = z.object({
  version: z.literal(1),
  agentId: z.string(),
  text: z.string(),
  phase: z.enum(['planning', 'execution']),
});

const TypedEventSchema = z.discriminatedUnion('type', [
  SessionEventSchema.extend({ type: z.literal('chunk'), data: ChunkEventV1 }),
  SessionEventSchema.extend({ type: z.literal('agent:started'), data: AgentStartedEventV1 }),
  // ... all event types
]);
```

**Schema evolution via upcasters:**

```typescript
const upcasters: Record<string, Upcaster[]> = {
  'chunk': [
    (data, fromVersion) => fromVersion < 2
      ? { ...data, phase: 'execution' }
      : data,
  ],
};
```

**Why not Avro/Protobuf/CloudEvents:**

- Avro/Protobuf: Solve cross-language, cross-service schema compat for distributed systems. AgentPane is a monolith
- CloudEvents: Useful for integration events (webhooks) but adds 12+ envelope fields to the hot path
- JSON Schema: Duplicates what Zod already does

---

## 4. Outbox Pattern

### The Dual-Write Problem

Two locations where DB write + stream publish can diverge:

1. **`SessionStreamService.publish()`**: Persists to SQLite first, then publishes to Caddy. If Caddy fails, error is swallowed — event in DB but not in live stream
2. **`DurableStreamsService.publish()`**: Same pattern — persist to DB, then publish to Caddy with swallowed error

Strategy: "DB first, stream best-effort." Pragmatic but creates a window where live clients see stale state.

### Recommendation: Polling Outbox (Medium Priority)

```typescript
class OutboxRelay {
  constructor(
    private db: Database,
    private streams: CaddyDurableStreamsServer,
    private pollIntervalMs = 50 // Fast enough for real-time feel
  ) {}

  private async relay() {
    const pending = await db.query.eventOutbox.findMany({
      where: isNull(eventOutbox.publishedAt),
      orderBy: [eventOutbox.createdAt],
      limit: 100,
    });
    for (const event of pending) {
      try {
        await this.streams.publish(event.streamId, event.eventType, JSON.parse(event.eventData));
        await db.update(eventOutbox).set({ publishedAt: now }).where(eq(eventOutbox.id, event.id));
      } catch { /* increment retryCount */ }
    }
  }
}
```

**Trade-off:** Adds ~50ms latency (poll interval). ChunkBatcher already adds 100ms for DB persistence, so same order of magnitude. For the real-time SSE path, continue using direct publish.

**Priority:** Medium. Current approach works — the gap manifests only when Caddy is down while the API server is up. When Caddy is down, no clients are connected anyway.

---

## 5. Event Replay and Time Travel

### What Works Today

- `getEventsBySession()` returns ordered events with pagination
- `DurableStreamsClient` supports `fromOffset` for resume
- `syncSessionToCollections()` replays events into TanStack DB on page load
- `subscribe()` with `includeHistory: true` replays from DB before live streaming

### What Doesn't Work

- No point-in-time queries ("what was agent state at T=12345?")
- No snapshots — replaying 1000-event session processes all from start
- No cross-session replay

### Recommendations

1. **Add timestamp index** to `session_events` — low cost, immediate value:

   ```sql
   CREATE INDEX idx_session_events_time ON session_events(session_id, timestamp);
   ```

2. **Phase-boundary snapshots** — snapshot when agent transitions planning -> execution (`agent:plan_ready`):

   ```typescript
   const sessionSnapshots = sqliteTable('session_snapshots', {
     id: text('id').primaryKey(),
     sessionId: text('session_id').references(() => sessions.id),
     offsetAt: integer('offset_at').notNull(),
     state: text('state', { mode: 'json' }).notNull(),
     createdAt: text('created_at').default(sql`(datetime('now'))`),
   });
   ```

   Fast replay: load nearest snapshot, replay only remaining events.

3. **Defer cross-session replay** — not needed until multi-agent global state reconstruction required

---

## 6. Saga Pattern for Multi-Agent Coordination

### Current Team Mode

- Claude SDK manages parallel execution natively
- `TopologyTracker` maps SDK `task_id` to topology node IDs
- AgentPane observes lifecycle events, publishes for UI, tracks running agents

### Recommendation: Orchestration Saga

Orchestration fits because:

1. The SDK already has an orchestrator (central agent delegating to sub-agents)
2. Compensation is critical (clean up worktrees, cancel other agents, update task status, notify user)
3. The saga state machine should mirror the agent lifecycle machine

```typescript
type TeamSagaState =
  | 'planning' | 'spawning' | 'executing'
  | 'merging' | 'compensating' | 'completed' | 'failed';

type TeamSagaEvent =
  | { type: 'PLAN_READY'; teammateCount: number }
  | { type: 'AGENT_SPAWNED'; agentId: string }
  | { type: 'AGENT_COMPLETED'; agentId: string; status: 'completed' | 'failed' }
  | { type: 'ALL_COMPLETED' }
  | { type: 'COMPENSATION_NEEDED'; failedAgentId: string; reason: string };
```

Persist saga state as new event types in `session_events`:

- `saga:state_changed` — `{ state, context }`
- `saga:compensation` — `{ action: 'cancel_agent' | 'remove_worktree', targetId }`

---

## 7. Domain Events vs Integration Events

### Current State: All Events Undifferentiated

All events flow through the same `session_events` table and Durable Streams pipeline.

### Three-Tier Classification

| Classification | Examples | Behavior |
|---|---|---|
| **Domain** | `agent:started`, `chunk`, `tool:result`, `topology:*` | Persist + real-time stream |
| **Operational** | `agent:metrics`, `agent:rate_limit`, `agent:compacted` | Persist only (no real-time needed) |
| **Integration** | Task completed -> GitHub comment, agent error -> Slack | Persist + route to adapters |

**Implementation:** Tag events with classification, route accordingly:

- Domain: persist + SSE
- Operational: persist only (saves SSE bandwidth)
- Integration: persist + anti-corruption layer transforms to external API calls

**Priority:** Low-medium. Becomes necessary when adding GitHub/Slack notifications or webhook delivery.

---

## Priority Summary

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| **High** | Unify event type definitions into single Zod source of truth | 2-3 days | Eliminates 4 duplicate type systems, enables schema versioning |
| **High** | Add `schema_version` column to `session_events` | 1 hour | Enables future schema evolution |
| **Medium** | Formalize session as event-sourced aggregate | 3-5 days | Session state derivable from events, enables replay |
| **Medium** | Add timestamp index to `session_events` | Minutes | Temporal queries for debugging |
| **Medium** | Phase-boundary snapshots | 1-2 days | Accelerates session replay for long sessions |
| **Medium** | Build team saga state machine | 2-3 days | Proper compensation and recovery for team mode |
| **Low** | Transactional outbox for guaranteed delivery | 2-3 days | Fixes theoretical consistency gap with Caddy |
| **Low** | Event classification (domain/integration/operational) | 1-2 days | Prepares for external integrations |
| **Low** | Extract command types from route handlers | 2-3 days | Improves testability and separation of concerns |
