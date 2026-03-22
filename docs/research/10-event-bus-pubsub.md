# Event Bus, Pub/Sub, Message Brokers & Event Ordering Research

**Date:** March 2026
**Current Stack:** Durable Streams (Caddy + LMDB) | SQLite session_events | ChunkBatcher | CaddyDurableStreamsServer (LRU producer pool) | No in-process event bus | No external broker

---

## 1. Durable Streams Deep Dive

### Architecture

Open HTTP protocol from Electric SQL (announced Dec 2025, v0.1.0 published Dec 23 2025). Three packages:

- **`@durable-streams/client` (v0.2.1)**: `DurableStream` + `IdempotentProducer` (epoch-based fencing, sequence dedup, auto-batching via `fastq`)
- **`@durable-streams/server` (v0.2.2)**: Reference server with in-memory `StreamStore` + LMDB persistence
- **`@durable-streams/state` (v0.2.0)**: TanStack DB bridge

### Delivery Guarantees

- **Producer**: Exactly-once via `(producerId, epoch, seq)` triple
- **Consumer**: Offset-based resume with `?fromOffset=N`
- **AgentPane enhancement**: Persist-first strategy + atomic `INSERT...SELECT` + 5 retries on offset collision

### Scalability Limits

- **SQLite bottleneck**: Writes serialized per session (single-writer). At 1000+ events/sec across sessions, SQLite handles it because sessions have independent offset sequences
- **Producer pool**: Capped at 200 with LRU eviction. Team mode (5 agents) is well within limits
- **Multi-node**: Fundamentally single-node. Caddy writes to local LMDB. No clustering/replication

### Maturity

Young project (~3 months since initial release). Apache-2.0. Backed by Electric SQL. Small community compared to Redis Streams or NATS. Hosted cloud service launched Jan 2026.

---

## 2. In-Process Event Bus

### Current: No Event Bus

Zero `EventEmitter` usage in src/. Services call each other directly. The `StreamEventMap` in `durable-streams.service.ts` provides compile-time type safety for publish.

### Comparison

| Library | Size | Type Safety | Recommendation |
|---------|------|-------------|---------------|
| **Node.js EventEmitter** | Built-in | Poor without wrappers | HOLD |
| **mitt** | 200B | Good (`Record<Event, Handler>` generic) | ASSESS |
| **nanoevents** | 107B | Best (interface mapping event -> args) | ASSESS |
| **eventemitter3** | 3KB | Weak | HOLD |
| **RxJS Subject** | 30KB+ | Excellent | HOLD |

### Verdict: Not Needed

The `StreamEventMap` already provides type-safe event contracts. No service subscribes to events from another service in-process. If ever needed, **nanoevents** (107 bytes) mirrors the existing `StreamEventMap` pattern.

---

## 3. SQLite as Event Log

### Already Implemented

`session_events` table functions as a durable event log with WAL mode, atomic offsets, session-scoped ordering.

### Cross-Process Notification

SQLite has **no LISTEN/NOTIFY**. `sqlite3_update_hook()` only fires in the same connection. Only option for cross-process notification is polling. This is why AgentPane dual-writes to Caddy/LMDB for real-time delivery — the correct architectural choice.

### libSQL Change Notifications

libSQL supports change notifications, but migration from better-sqlite3 would be significant. Not recommended given current architecture works.

---

## 4. Embedded Message Brokers (No External Infra)

| Solution | External Infra | Throughput | DLQ | Recommendation |
|---|---|---|---|---|
| **Bunqueue** | None (SQLite) | 287K-1.2M ops/sec | Yes | **ASSESS** for job scheduling |
| **BullMQ** | Redis required | High | Yes | ASSESS if Redis already in stack |
| **Bee-Queue** | Redis required | Moderate | No | HOLD |

**Bunqueue** is the standout — SQLite-backed, BullMQ-compatible API, native Bun, DLQ built-in. Relevant for job scheduling (scheduling agent runs, retry logic), NOT for real-time streaming. Different concern from Durable Streams.

---

## 5. External Message Brokers (Multi-Node)

| Broker | Ops Complexity | JS Client | Ordering | Consumer Groups | Persistence |
|---|---|---|---|---|---|
| **NATS JetStream** | Low | Good (nats.js) | Per-stream | Yes (durable) | File-based |
| **Redis Streams** | Low | Excellent (ioredis) | Per-stream FIFO | Yes (XREADGROUP) | RAM + AOF |
| **Kafka** | High | Fair (kafkajs archived) | Per-partition | Yes | Log segments |
| **Redpanda** | Medium | Same as Kafka | Per-partition | Yes | Raft |
| **RabbitMQ** | Medium | Good (amqplib) | Per-queue FIFO | No (competing) | Mnesia |

**Kafka/Redpanda/Pulsar**: Overkill for single-node SQLite application. Operational overhead prohibitive.

**RabbitMQ**: Good for task queuing but weaker for event replay. Consume+ack+delete doesn't match append-only event log pattern.

---

## 6. NATS JetStream Deep Dive

### Why NATS Fits AgentPane

Single ~20MB binary with pub/sub, JetStream (persistent), KV store, object store — zero config:

| AgentPane Need | NATS Feature |
|---|---|
| Real-time event streaming | Core pub/sub (sub-millisecond) |
| Durable event replay | JetStream streams (file-backed) |
| Offset-based resume | Consumer sequence tracking |
| Session event fan-out | Subject routing (`sessions.{id}.>`) |
| Settings broadcast | KV store with watch |

### NATS vs Durable Streams

| Aspect | Durable Streams | NATS JetStream |
|--------|----------------|----------------|
| SSE delivery | Native (Caddy plugin) | Needs SSE bridge |
| Client library | Browser EventSource | WebSocket only (`nats.ws`) |
| TanStack DB integration | Native | Custom adapter needed |
| Multi-node | No clustering | Full clustering |
| Ecosystem maturity | 3 months | 10+ years |

### Verdict

NATS JetStream is the right choice for multi-node deployment. For now, Durable Streams + Caddy is simpler (native SSE, TanStack DB integration). Migration path: keep Durable Streams for client delivery, add NATS for inter-service communication.

---

## 7. Redis Streams vs Pub/Sub

**Redis Pub/Sub**: Fire-and-forget. Disconnected subscriber loses messages. Rules it out for durable delivery.

**Redis Streams**: Kafka-like semantics — `XADD`, `XREAD`, `XREADGROUP`, `XRANGE`.

| Aspect | Current (SQLite + Caddy/LMDB) | Redis Streams |
|--------|-------------------------------|---------------|
| Persistence | Disk | RAM (AOF optional) |
| Cost | Free (embedded) | RAM-proportional |
| Multi-node | Not supported | Redis Cluster |
| Data loss risk | Low (dual disk write) | Medium (depends on AOF) |

**Verdict:** Redis Streams compelling when: (a) multi-node needed, (b) sub-ms delivery matters, (c) consumer groups needed. Not justified at current scale.

---

## 8. Event Fan-Out

### Current: Caddy Broadcast

Caddy's `durable_streams` plugin handles fan-out — all subscribers receive all events. Client-side filtering by channel. Working correctly.

### Potential Improvements

1. **Subject-based filtering** — reduce bandwidth by subscribing to specific event types
2. **Presence-based fan-out** — skip publishing to sessions with no subscribers
3. **Activity stream** — aggregate key events from all sessions for dashboard views

---

## 9. DLQ and Error Handling

### Current: No DLQ, No Retry, No Circuit Breaker

- Caddy publish failures silently swallowed
- Chunk batching failures restore buffer (data preserved) but don't retry
- Client Zod validation failures silently dropped
- No circuit breaker for Caddy unavailability

### Recommended Additions (All In-Process, No External Broker)

| Addition | Priority | Effort |
|---|---|---|
| Bounded Caddy publish retry (3 attempts, 100/200/400ms) | High | Low |
| Persistence retry buffer for SQLite offset exhaustion | High | Low |
| Zod validation DLQ table (log unprocessable events) | Medium | Low |
| Caddy circuit breaker (open after N failures, half-open after timeout) | Medium | Medium |

---

## 10. Event Ordering and Consistency

### Current: Per-Session Total Ordering

Atomic `INSERT...SELECT` serializes writes at SQLite level. In team mode, events from different agents interleave in a single total order.

### Vector Clocks

**Not needed.** All events pass through single SQLite writer (total order). `agentId` identifies source. UI groups by agent. No cross-agent causal dependencies.

### Multi-Node Readiness

When different agents run on different servers:

- **Lamport timestamps**: Each event carries logical clock. Merge by timestamp, break ties by agent ID
- **Per-agent sequences**: Maintain per-agent sequence counter. Present grouped by agent with per-agent ordering guaranteed

**Current per-session total ordering via SQLite is sufficient.** Vector clocks are overkill unless agents develop cross-agent causal dependencies.

---

## Priority Summary

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| **High** | Add bounded Caddy publish retry | Low | Reduces event loss window |
| **High** | Add persistence retry buffer | Low | Prevents event loss on offset exhaustion |
| **Medium** | Add Caddy circuit breaker | Medium | Reduces resource waste when Caddy down |
| **Medium** | Add Zod validation DLQ table | Low | Diagnose data shape mismatches |
| **Low** | Evaluate Bunqueue for job scheduling | Low | Agent run scheduling, retry logic |
| **Future** | Add NATS JetStream for multi-node | High | Inter-service events when scaling |
| **Future** | Add per-agent Lamport timestamps | Medium | Cross-node event ordering |
