# Events System Architecture Review

> **Date**: 2026-03-22
> **Scope**: Real-time event streaming, persistence, client consumption, webhook processing
> **Status**: Review complete — actionable findings with OSS recommendations

## Related Documents

- **[Hybrid Architecture Evolution](./hybrid-architecture.md)** — 3-phase evolution plan with 17+ OSS technology evaluations, pattern catalog (outbox, CQRS, DLQ, edge CEP), agent event model evolution (CloudEvents, hierarchical naming, delta/done pairing), and industry comparison across 7 agent platforms
- **[Prioritized Roadmap & Next Steps](./roadmap.md)** — 19 work items across P0-P3 priorities with effort estimates, dependencies, success criteria, milestone checkpoints, and risk register

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Scale Issues (Critical)](#2-scale-issues-critical)
3. [Potential Issues (Important)](#3-potential-issues-important)
4. [OSS Alternatives Analysis](#4-oss-alternatives-analysis)
5. [Recommended Improvements](#5-recommended-improvements)

---

## 1. Architecture Overview

### Event Flow

```
Producer (Agent/Service)
       │
       ▼
DurableStreamsService.publish(streamId, type, data)
       │
       ├──▶ SQLite (persist-first, source of truth)
       │      INSERT...SELECT for atomic offset assignment
       │      sessionEvents table with per-session monotonic offsets
       │
       └──▶ Caddy/LMDB (real-time delivery)
              IdempotentProducer batches (5ms linger, 1MB max)
              LRU producer pool (200 max, 5min idle timeout)
       │
       ▼
SSE Endpoint: /v1/stream/sessions/:id
       │
       ▼
@durable-streams/client (EventSource + offset-based resume)
       │
       ▼
React Hooks → TanStack DB Collections → UI
```

### Four Event Subsystems

| Subsystem | Table | Purpose | Write Frequency |
|-----------|-------|---------|-----------------|
| **Session Events** | `session_events` | Agent execution stream (chunks, tools, turns) | High — 100-500 events/min per agent |
| **Webhook Event Log** | `event_log` | Audit trail of incoming webhooks | On-demand — per webhook |
| **Event Sources** | `event_sources` | Webhook/cron source configuration | Rare — admin config |
| **Event Subscriptions** | `event_subscriptions` | Routing rules: event → task creation | Rare — admin config |

### Event Channels (12 categories)

| Channel | Event Types | Usage |
|---------|-------------|-------|
| `plan` | started, turn, token, interaction, completed, error | Planning phase with Claude Agent SDK |
| `sandbox` | creating, ready, idle, stopping, stopped, error | Docker sandbox lifecycle |
| `containerAgent` | status, started, token, turn, tool:start, tool:result, complete, error, plan_ready | Agent execution in containers |
| `terraform` | status, text, modules, questions, code, done, error | Terraform composition |
| `topology` | agent_spawned, agent_progress, agent_completed | Team mode / swarm coordination |
| `session` | chunk, tool:start, tool:result, presence, terminal, state:update, workflow | Real-time session data |

### Delivery Guarantees

- **SQLite → Client (historical)**: At-least-once, durable, queryable
- **Caddy/LMDB → Client (real-time)**: At-least-once with offset-based resume
- **Overall**: At-least-once semantics. No exactly-once guarantee. No protocol-level deduplication.

### Key Files

| File | Role |
|------|------|
| `src/services/durable-streams.service.ts` | Core publish, dual-write, producer pool |
| `src/services/session/session-stream.service.ts` | Session event persistence + queries |
| `src/lib/agents/stream-handler.ts` | Agent → event production (29 publish calls) |
| `src/lib/streams/client.ts` | DurableStreamsClient, shared subscriptions, offset tracking |
| `src/db/schema/sqlite/session-events.ts` | Event storage schema |
| `src/app/hooks/use-session.ts` | Client state management, chunk cap |
| `agent-runner/src/event-emitter.ts` | Container agent JSON-line emitter |

---

## 2. Scale Issues (Critical)

### 2.1 No Event Retention or Cleanup

**Impact**: Unbounded storage growth, query degradation over time

The `session_events` and `event_log` tables have **no TTL, no archival, no scheduled cleanup, and no partitioning**. Events persist indefinitely unless the parent session or event source is deleted (cascade).

**Growth estimate**:
- 1 agent session ≈ 500 events (50 turns × 10 events/turn)
- 100 sessions/day × 500 events = 50,000 rows/day
- 1 year = ~18M rows in `session_events` alone

**Evidence**: Searched for `cleanup`, `prune`, `retention`, `DELETE FROM session_events` — none found anywhere in the codebase.

**Affected files**: `src/services/session/session-stream.service.ts`, `src/db/schema/sqlite/session-events.ts`

---

### 2.2 SQLite Single-Writer Serialization

**Impact**: Write throughput ceiling under concurrent agent execution

All session event inserts use an atomic `INSERT...SELECT` to calculate the next offset:

```sql
INSERT INTO session_events (id, session_id, offset, type, channel, data, timestamp)
SELECT ?, ?, COALESCE(MAX(offset), -1) + 1, ?, ?, ?, ?
FROM session_events WHERE session_id = ?
```

SQLite's single-writer lock means **all event writes across all sessions are serialized**. With 5+ concurrent agents each producing 100-500 events/minute, this becomes the system bottleneck.

**Affected file**: `src/services/session/session-stream.service.ts`

---

### 2.3 No Batching on Chunk Events

**Impact**: Excessive I/O, 100-500 individual DB writes per minute per agent

Every `content_block_delta` from the Claude SDK triggers an immediate, individually-persisted event:

```typescript
// stream-handler.ts — no debounce, no batching
if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
  accumulated += event.delta.text;
  await sessionService.publish(sessionId, {
    type: 'chunk',
    data: { agentId, delta: event.delta.text, accumulated, phase }
  });
}
```

Each publish = 1 SQLite INSERT + 1 Caddy HTTP POST. At streaming speed, this is 5-10 writes/second per agent.

**Affected file**: `src/lib/agents/stream-handler.ts`

---

### 2.4 Accumulated Text Duplication (O(n^2) Storage)

**Impact**: Storage bloat, every chunk event carries the full response so far

Each `chunk` event includes both `delta` (incremental) and `accumulated` (full text to this point). For a 200-token response:

- Event 1: `accumulated` = 5 chars
- Event 2: `accumulated` = 10 chars
- ...
- Event 200: `accumulated` = ~1000 chars

**Total stored** = sum(1..N) ≈ N^2/2 characters. A 10KB response generates ~5MB of accumulated text across its chunk events.

**Affected file**: `src/lib/agents/stream-handler.ts` (producer), `src/db/schema/sqlite/session-events.ts` (storage)

---

### 2.5 Single-Node Caddy — No Horizontal Scaling

**Impact**: Real-time delivery cannot scale beyond one server

Caddy with LMDB is a single-node architecture. All SSE connections terminate at one Caddy instance. There is no:
- Cluster mode or Caddy-to-Caddy replication
- Shared LMDB backend
- Connection routing/load balancing for SSE

**Scaling path**: Requires replacing Caddy/LMDB with a distributed stream backend (Redis, NATS, etc.)

**Affected file**: `src/services/durable-streams.service.ts`

---

### 2.6 Hard SSE Connection Limit (50)

**Impact**: Blocks concurrent multi-agent viewing at scale

```typescript
// cli-monitor.ts / events.ts
const MAX_SSE_CONNECTIONS = 50;
```

With team mode spawning 3-5 subagents per task, a user viewing 10 concurrent sessions exhausts the limit. Additional connections receive `TOO_MANY_CONNECTIONS` error with no queuing or graceful degradation.

**Affected files**: `src/server/routes/cli-monitor.ts`, `src/server/routes/events.ts`

---

### 2.7 Silent Data Loss at Chunk Cap

**Impact**: Long sessions silently lose early events on the client

```typescript
// use-session.ts
const MAX_CHUNKS = 5000;
// When exceeded:
chunks.slice(chunks.length - MAX_CHUNKS)
```

Oldest chunks are discarded without notification. Users scrolling back in a long agent session see incomplete history. No indicator that data was truncated.

**Affected file**: `src/app/hooks/use-session.ts`

---

## 3. Potential Issues (Important)

### 3.1 No Backpressure on Publishing

The publish path is fire-and-forget relative to subscribers. If clients are slow (network, rendering), events queue in Caddy's LMDB buffer without limit. The publisher has no signal that consumers are falling behind.

**Risk**: Memory/disk exhaustion in Caddy under sustained high-throughput scenarios.

### 3.2 No Dead Letter Queue

If Caddy publish fails (network blip, Caddy restart), the event is logged as a warning but not retried or queued:

```typescript
// durable-streams.service.ts — publish to Caddy is best-effort
// If it fails, event is still in SQLite but real-time delivery is lost
```

The event is durable in SQLite, but clients connected via SSE will miss it until they reconnect and replay from offset. There's no mechanism to push missed events to connected clients without a full reconnect.

### 3.3 Container Agent Double-Hop Latency

Container agents emit JSON lines to stdout, which the host process parses line-by-line via `readline`, maps event types, and republishes to DurableStreams:

```
Agent SDK → JSON.stringify → stdout → readline → JSON.parse → DurableStreams.publish
```

This adds ~1-5ms per event vs. direct in-process publishing. For high-frequency token events, this accumulates.

**Affected files**: `agent-runner/src/event-emitter.ts`, `src/services/container-agent.service.ts`

### 3.4 GC Pressure from High-Frequency Object Allocation

Each chunk event creates a new object with `{ agentId, delta, accumulated, phase }`, wraps it in an event envelope, serializes to JSON for SQLite, and serializes again for Caddy. At 5-10 events/second per agent, this creates significant GC pressure in V8.

### 3.5 Offset-Based Pagination Fragility

The API uses numeric offset/limit pagination:

```
GET /api/sessions/:id/events?offset=0&limit=100
```

If events are concurrently inserted while a client paginates, offsets shift and the client may skip or duplicate events. Cursor-based pagination (using the event's monotonic offset field) would be more reliable.

### 3.6 Memory Accumulation in Stream Handler

The `accumulated` string variable in `runAgentPlanning()` and `runAgentExecution()` grows unbounded during a phase. For a 50-turn execution producing 200 tokens/turn, this is ~30KB held in memory for the duration of execution — per concurrent agent.

### 3.7 Topology rAF Batching — Partial Solution

The `useTopologyStream` hook uses `requestAnimationFrame` to batch rapid progress updates, which is good. However, chunk events in `useSession` are NOT batched — every chunk triggers a React state update, which can cause rendering bottlenecks during fast streaming.

---

## 4. OSS Alternatives Analysis

### 4.1 NATS JetStream

| Aspect | Assessment |
|--------|------------|
| **What it is** | Lightweight message broker with persistence (JetStream), exactly-once delivery, consumer groups |
| **Fit** | Strong — designed for event streaming at this scale |
| **Replaces** | Caddy/LMDB real-time layer + potentially SQLite for event storage |
| **Pros** | Embedded-friendly (single binary), consumer acknowledgment (backpressure), message replay by sequence/time, retention policies (time/size/count), exactly-once via dedup window, clustering for HA |
| **Cons** | Additional infrastructure dependency, learning curve, no built-in SSE (need adapter) |
| **Effort** | Medium — replace DurableStreamsService publish/subscribe, add NATS→SSE bridge |
| **Verdict** | **Best fit for this architecture.** Solves retention, backpressure, replay, and scaling in one system. |

### 4.2 Redis Streams

| Aspect | Assessment |
|--------|------------|
| **What it is** | Append-only log data structure in Redis with consumer groups, XRANGE replay, TTL |
| **Fit** | Strong — well-suited for session event streams |
| **Replaces** | Caddy/LMDB real-time layer |
| **Pros** | Consumer groups (backpressure + fan-out), `MAXLEN` for automatic trimming, `XRANGE` for offset-based replay, sub-millisecond latency, familiar ops tooling, built-in TTL via `XTRIM` |
| **Cons** | Memory-bound (events in RAM until trimmed), requires Redis infrastructure, no built-in SSE |
| **Effort** | Medium — replace Caddy publish with `XADD`, subscribe with `XREAD BLOCK` |
| **Verdict** | **Strong alternative to NATS.** Better if Redis is already in the stack. Consumer groups solve the backpressure gap. |

### 4.3 Apache Kafka

| Aspect | Assessment |
|--------|------------|
| **What it is** | Distributed event streaming platform with partitioned topics, consumer groups, compaction |
| **Fit** | Weak — massively over-provisioned for this use case |
| **Replaces** | Entire event pipeline |
| **Pros** | Proven at extreme scale, exactly-once semantics, log compaction, multi-datacenter replication |
| **Cons** | Heavy infrastructure (ZooKeeper/KRaft), high operational complexity, overkill for <1000 events/sec, Java ecosystem |
| **Effort** | High |
| **Verdict** | **Not recommended.** Operational overhead far exceeds the scaling needs. |

### 4.4 Litestream (SQLite Replication)

| Aspect | Assessment |
|--------|------------|
| **What it is** | Streaming replication for SQLite to S3/NFS/SFTP |
| **Replaces** | Nothing directly — adds HA to existing SQLite |
| **Pros** | Zero-config, continuous replication, point-in-time restore, keeps current SQLite stack |
| **Cons** | Read replicas are read-only, doesn't solve write throughput, single-writer still applies |
| **Effort** | Low — sidecar process, no code changes |
| **Verdict** | **Good complement.** Adds disaster recovery without architectural change. Does not solve scale issues. |

### 4.5 Electric SQL

| Aspect | Assessment |
|--------|------------|
| **What it is** | Real-time sync layer that streams Postgres changes to client-side SQLite |
| **Replaces** | SSE event delivery + client-side TanStack DB sync |
| **Pros** | Automatic sync (no manual event routing), offline-first, conflict resolution, eliminates custom SSE code |
| **Cons** | Requires PostgreSQL (not SQLite backend), alpha-stage stability, opinionated data model |
| **Effort** | High — requires PostgreSQL migration + client rewrite |
| **Verdict** | **Interesting long-term.** Would eliminate the entire custom event delivery layer, but requires PostgreSQL migration. |

### 4.6 Turso / libSQL

| Aspect | Assessment |
|--------|------------|
| **What it is** | Distributed SQLite with embedded replicas, built on libSQL fork |
| **Replaces** | SQLite backend — adds multi-node reads and edge replication |
| **Pros** | Drop-in SQLite replacement, embedded replicas for read scaling, managed or self-hosted, keeps Drizzle ORM |
| **Cons** | Write throughput still limited by primary, doesn't solve real-time delivery, adds network dependency |
| **Effort** | Low-Medium — swap better-sqlite3 for @libsql/client |
| **Verdict** | **Good for read scaling.** Doesn't solve the write bottleneck or real-time gaps. |

### 4.7 WebSocket (Socket.io) vs SSE

| Aspect | Assessment |
|--------|------------|
| **What it is** | Bi-directional WebSocket with rooms, namespaces, auto-reconnect |
| **Replaces** | SSE delivery layer |
| **Pros** | Bi-directional (enables client→server events like presence), room-based fan-out, no browser 6-connection limit, binary frame support, built-in backpressure via TCP flow control |
| **Cons** | More complex protocol, harder to debug, existing SSE works well for unidirectional streaming |
| **Effort** | Medium — replace EventSource with Socket.io client, add server rooms |
| **Verdict** | **Marginal improvement.** SSE is sufficient for unidirectional event streaming. WebSocket only justified if bi-directional features (collaborative editing, presence) become critical. |

### 4.8 Comparison Matrix

| Capability | Current (Caddy/LMDB) | NATS JetStream | Redis Streams | Kafka |
|-----------|----------------------|----------------|---------------|-------|
| Backpressure | None | Consumer ack | Consumer groups | Consumer groups |
| Retention policies | None | Time/size/count | MAXLEN/MINID | Time/size + compaction |
| Replay | Offset-based | Sequence/time | XRANGE | Offset/timestamp |
| Exactly-once | No | Dedup window | No (at-least-once) | Idempotent producer |
| Clustering/HA | No | Built-in | Redis Cluster/Sentinel | Built-in |
| Operational complexity | Low | Low-Medium | Medium | High |
| Latency | ~5ms (batch linger) | <1ms | <1ms | 5-50ms |
| Embedded option | Yes (Caddy module) | Yes (Go embed) | No (external) | No (external) |

---

## 5. Recommended Improvements

### Priority 1: Event Retention & Cleanup (Critical, Low Effort)

**Problem**: Unbounded table growth in `session_events` and `event_log`.

**Solution**: Add a scheduled cleanup job:

```
- session_events: Delete events for sessions older than 30 days (configurable)
- event_log: Delete webhook logs older than 90 days
- Run via setInterval on server start or cron event source
- Add index on (created_at) for efficient range deletes
```

**Files**: New cleanup service + `src/db/schema/sqlite/session-events.ts` (add index)

---

### Priority 2: Chunk Event Batching (Critical, Medium Effort)

**Problem**: 100-500 individual DB writes per minute per agent.

**Solution**: Buffer chunk events and flush on interval or threshold:

```
- Accumulate text deltas in memory for 50-100ms
- Flush as single batched event to SQLite + Caddy
- Send individual deltas to SSE for real-time UI (skip SQLite for intermediate chunks)
- Only persist the final accumulated text per batch window
```

**Impact**: Reduces SQLite writes by 10-50x during streaming. Real-time UI latency unchanged (SSE still gets individual deltas).

**Files**: `src/lib/agents/stream-handler.ts`, `src/services/durable-streams.service.ts`

---

### Priority 3: Drop `accumulated` from Chunk Events (Critical, Low Effort)

**Problem**: O(n^2) storage from carrying full text in every chunk.

**Solution**: Store only `delta` in chunk events. Reconstruct full text on the client by concatenating deltas in offset order. The client already tracks `accumulated` locally in `useSession`.

**Files**: `src/lib/agents/stream-handler.ts` (remove `accumulated` from publish), `src/app/hooks/use-session.ts` (already reconstructs — verify)

---

### Priority 4: Replace Caddy/LMDB with NATS JetStream (Important, High Effort)

**Problem**: No backpressure, no retention policies, no clustering, single-node ceiling.

**Solution**: Replace `DurableStreamsService` backend with NATS JetStream:

```
- One NATS stream per session (or partitioned by codespace)
- Consumer per SSE client with ack-based delivery
- Retention: 24h or 10,000 messages per stream
- Server-side: NATS publisher replaces Caddy IdempotentProducer
- Client-side: SSE adapter reads from NATS consumer and pushes to EventSource
```

**Why NATS over Redis**: Embeddable (single binary like Caddy), built-in exactly-once dedup, lower operational surface. Redis is equally viable if already in the stack.

**Files**: `src/services/durable-streams.service.ts` (full rewrite), new NATS adapter, SSE bridge endpoint

---

### Priority 5: Increase SSE Connection Limit + Graceful Degradation (Important, Low Effort)

**Problem**: Hard cap of 50 SSE connections with no fallback.

**Solution**:
- Increase to 200 (or make configurable via settings)
- Add graceful degradation: when near limit, return polling-mode response instead of error
- Add connection counting per user to prevent one user exhausting the pool

**Files**: `src/server/routes/cli-monitor.ts`, `src/server/routes/events.ts`

---

### Priority 6: Client Chunk Truncation Warning (Low, Low Effort)

**Problem**: Silent data loss when `MAX_CHUNKS` (5000) exceeded.

**Solution**: When truncating, set a `truncated: true` flag in session state. Display a "Showing last 5000 events" banner in the stream panel.

**Files**: `src/app/hooks/use-session.ts`, stream panel component

---

### Priority 7: Add Litestream for SQLite HA (Low, Low Effort)

**Problem**: Single SQLite file is a single point of failure.

**Solution**: Run Litestream as a sidecar process to continuously replicate to S3/NFS. Provides point-in-time restore with zero code changes.

**Files**: Docker/deployment config only — no application code changes

---

### Summary Matrix

| # | Improvement | Impact | Effort | Solves |
|---|------------|--------|--------|--------|
| 1 | Event retention/cleanup | High | Low | Unbounded growth (2.1) |
| 2 | Chunk event batching | High | Medium | Write throughput (2.2, 2.3) |
| 3 | Drop `accumulated` field | High | Low | O(n^2) storage (2.4) |
| 4 | NATS JetStream | High | High | Backpressure, HA, retention (2.5, 3.1, 3.2) |
| 5 | SSE limit + degradation | Medium | Low | Connection ceiling (2.6) |
| 6 | Truncation warning | Low | Low | Silent data loss (2.7) |
| 7 | Litestream replication | Medium | Low | SQLite HA (disaster recovery) |

Priorities 1-3 are quick wins that address the most critical scale issues. Priority 4 (NATS) is the architectural step-change for production-grade event delivery.
