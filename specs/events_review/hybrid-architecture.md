# Hybrid Events & Streaming Architecture — Evolution Roadmap

> **Date**: 2026-03-22
> **Scope**: Hybrid event architecture evolution for AgentPane — complementing Durable Streams with best-of-breed OSS
> **Status**: Research complete — phased evolution plan with technology recommendations
> **Methodology**: Three parallel Opus research agents covering 17+ OSS technologies, 10+ architecture patterns, 7+ agent platform event models

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture Assessment](#2-current-architecture-assessment)
3. [Technology Evaluation](#3-technology-evaluation)
4. [Hybrid Architecture Design](#4-hybrid-architecture-design)
5. [Evolution Phases](#5-evolution-phases)
6. [Pattern Catalog](#6-pattern-catalog)
7. [Agent Event Model Evolution](#7-agent-event-model-evolution)
8. [Industry Comparison](#8-industry-comparison)
9. [Decision Log](#9-decision-log)
10. [Sources & References](#10-sources--references)

---

## 1. Executive Summary

AgentPane's current event system — Durable Streams (Caddy/LMDB) for SSE delivery + SQLite for persistence — is well-designed and follows established CQRS/Event Sourcing patterns. The `sessionEvents` table is already an event store, TanStack DB collections are read-model projections, and offset-based replay provides temporal queries.

**However**, the architecture has a documented ceiling:
- **No backpressure** between producers and consumers
- **Dual-write inconsistency** between SQLite and Caddy (RS-013)
- **Three disconnected SSE subsystems** with separate connection tracking
- **No event retention or cleanup** — unbounded storage growth
- **Single-writer SQLite** bottleneck under concurrent agent execution
- **Single-node Caddy** — no horizontal scaling path

**The recommendation is a 3-phase hybrid evolution:**

| Phase | Timeline | Key Changes | Impact |
|-------|----------|-------------|--------|
| **1. Foundation** | Weeks | Transactional outbox, unified event bus, DLQ, CloudEvents schema, chunk batching | Fixes reliability + O(n²) storage |
| **2. Broker** | Months | NATS JetStream backbone, SSE bridge consumer, Valkey for presence/cache | Enables horizontal scaling |
| **3. Durability** | Quarters | Inngest/Restate for agent sagas, edge CEP, Litestream HA, multi-node | Production-grade resilience |

**Design principle**: Durable Streams remains the last-mile SSE delivery layer throughout all phases. Each phase adds capabilities without removing what works.

---

## 2. Current Architecture Assessment

### What Works Well

| Component | Strength |
|-----------|----------|
| **Durable Streams SSE** | Offset-based resume, CDN-friendly, auto-reconnect, shared subscriptions |
| **Persist-first strategy** | SQLite writes before Caddy broadcast — events are durable |
| **Typed event system** | 48 typed events across 6 categories with `StreamEventMap` registry |
| **Agent Runner sync/async writes** | Critical events use `writeSync(STDOUT_FD)`, high-frequency use buffered `stdout.write()` |
| **Client streams availability gate** | HEAD probe prevents retry storms when Caddy unavailable |
| **IdempotentProducer batching** | 5ms linger, 1MB max batch, 5 max in-flight |
| **Topology rAF batching** | `requestAnimationFrame` batches rapid progress updates |

### Known Limitations (RS-* Findings)

| ID | Issue | Severity | Phase Fix |
|----|-------|----------|-----------|
| RS-001 | Producer pool unbounded growth | Medium | Phase 1 |
| RS-004 | Schema divergence (durable-streams/state vs StreamEventMap) | Medium | Phase 1 |
| RS-005 | Inconsistent event naming conventions | Low | Phase 1 |
| RS-006 | No gap detection on reconnect | Medium | Phase 1 |
| RS-007 | Presence store never cleans up stale users | High | Phase 2 |
| RS-008 | No backpressure for high-frequency events | Medium | Phase 1 |
| RS-009 | Three disconnected event delivery systems | Low | Phase 2 |
| RS-010 | Shared subscription map cleanup uncertainty | Medium | Phase 1 |
| RS-011 | useSession hook unbounded array growth | Medium | Phase 1 |
| RS-013 | Dual-write inconsistency (DB vs Caddy) | Medium | Phase 1 |
| RS-014 | Offset collision retry limited to 3 attempts | Low | Phase 1 |
| RS-019 | Caddy SSE endpoints have no authentication | Medium | Phase 2 |

### Scale Ceiling Analysis

| Metric | Current Ceiling | Bottleneck |
|--------|----------------|------------|
| **Concurrent agents** | ~5-10 | SQLite single-writer serialization |
| **Events/sec (write)** | ~500-1000 | SQLite INSERT...SELECT for offset calculation |
| **SSE connections** | 100 (50+50) | Hard-coded limits in event-bus + cli-monitor |
| **Event storage** | ~18M rows/year | No retention, no cleanup |
| **Horizontal nodes** | 1 | Single Caddy instance, in-process event bus |

---

## 3. Technology Evaluation

### Tier 1: Adopt Now (High Value, Low Risk)

#### Electric SQL Durable Streams v0.2.x (Already Using)

| Attribute | Value |
|-----------|-------|
| **Version** | v0.2.2 (current), v0.2.0+ adds idempotent producers |
| **License** | Apache 2.0 |
| **Action** | Track releases, upgrade for exactly-once semantics |

AgentPane already uses `@durable-streams/*` packages. v0.2.0 adds idempotent producers and exactly-once delivery. Hosted Durable Streams on Electric Cloud (Jan 2026) could replace self-managed Caddy/LMDB if needed.

#### CloudEvents v1.0

| Attribute | Value |
|-----------|-------|
| **Version** | 1.0 (CNCF Graduated, Jan 2024) |
| **License** | Apache 2.0 |
| **GitHub** | SDKs: Go, JavaScript, Java, C#, Ruby, PHP, Rust, Python |
| **Action** | Adopt as event envelope format for lifecycle events |

Maps 1:1 to existing `StreamEvent` type. Low effort to adopt, enables external system interoperability. CloudEvents SQL v1 (June 2024) adds standardized event querying/filtering.

**Mapping:**

```
CloudEvents Field     AgentPane Current
─────────────────     ────────────────
id                    event.id
source                streamId (session/agent)
type                  event.type (e.g., 'io.agentpane.agent.completed.v1')
time                  event.timestamp
data                  event.data
specversion           "1.0"
subject               channel (chunks/toolCalls/etc.)
```

### Tier 2: Multi-Instance Scaling (Medium Term)

#### NATS JetStream

| Attribute | Value |
|-----------|-------|
| **Version** | 2.12.3 (Dec 2025, post-Jepsen fixes) |
| **License** | Apache 2.0 |
| **GitHub** | 14.6k stars, 18k+ across NATS org |
| **Performance** | 200k-400k msgs/sec persistent, sub-ms latency |
| **Embedding** | Go: full embedded server. Node.js/Bun: client-only (`@nats-io/jetstream`) |
| **Action** | Adopt for inter-service messaging when going multi-instance |

**Key features for AgentPane:**
- Single binary, zero dependencies — no ZooKeeper/JVM
- Exactly-once via producer dedup (`Nats-Msg-Id` header) + durable consumers with ack
- KV Store (built on streams) — agent state, config, presence
- Subject-based routing with wildcards: `agents.>`, `sessions.*.events`
- Leaf Nodes for edge deployment — buffer during disconnects, sync when reconnected
- Consumer groups for load-balanced processing
- Retention policies: time, size, count, or interest-based

**CRITICAL — Jepsen Analysis (Dec 2025):**
- Default lazy fsync (2-min flush interval) caused 49.7% data loss in worst case
- Must set `sync: always` for production durability (throughput impact)
- **SQLite must remain source of truth** — never rely solely on JetStream for durability

**Pros:** Single binary like Caddy, built-in exactly-once, KV store, leaf nodes for remote agents, subject routing
**Cons:** Cannot embed server in Bun (sidecar process), Jepsen findings require careful config

#### Valkey (Redis Fork)

| Attribute | Value |
|-----------|-------|
| **Version** | 8.1.1 / 9.0 (2025-2026) |
| **License** | BSD-3 (truly open source) |
| **GitHub** | 19.1k stars |
| **Performance** | 730K-1M RPS on 8 vCPU, 37% faster SET than Redis |
| **Action** | Adopt for presence cache, session state, rate limiting |

Drop-in Redis replacement with BSD license (Redis moved to SSPL). 37% higher SET throughput, 20-30 bytes less per-key overhead. Streams + consumer groups work identically to Redis Streams. Valkey 9.0 adds multi-database cluster mode, official JSON/Bloom/Search modules.

**Solves for AgentPane:** Presence store cleanup (RS-007), session state caching, rate limiting, ephemeral inter-process state.

#### Litestream v0.5

| Attribute | Value |
|-----------|-------|
| **Version** | v0.5.0 (Oct 2025) |
| **License** | Apache 2.0 |
| **GitHub** | ~12k stars |
| **Action** | Adopt for SQLite disaster recovery |

Continuous WAL replication to S3/GCS/Azure/SFTP/NATS JetStream. New LTX format with compaction: L1 (30s windows), L2 (5 min windows). VFS read replicas read directly from S3 without full restore. NATS JetStream replica backend pairs naturally with NATS adoption.

**Solves for AgentPane:** Single point of failure for SQLite event store, disaster recovery, read replica for historical session replay.

### Tier 3: Strategic Investment (When Needed)

#### Turso / libSQL

| Attribute | Value |
|-----------|-------|
| **Version** | Active development (Rust rewrite 2025) |
| **License** | MIT |
| **GitHub** | ~13k stars |
| **When** | When SQLite single-writer becomes bottleneck during parallel agent execution |

Most natural upgrade path from SQLite. Key features: concurrent writes via MVCC + fine-grained locking (Rust rewrite), embedded replicas (local read perf with replicated durability), native vector search (DiskANN), encryption at rest. `BEGIN CONCURRENT` eliminates single-writer limitation.

**Pros:** Drop-in SQLite replacement, keeps Drizzle ORM, concurrent writes, embedded replicas for agent runners
**Cons:** Rust rewrite may introduce instability, diverging from upstream SQLite, cloud pricing

#### Inngest (Durable Execution)

| Attribute | Value |
|-----------|-------|
| **Version** | Active development (2025-2026) |
| **License** | Proprietary (hosted) / Apache 2.0 (OSS self-host) |
| **When** | When agent execution reliability becomes critical |

TypeScript-native durable execution. `waitForEvent` primitive suspends workflows at defined points and awaits external signals — maps directly to AgentPane's plan approval flow. Automatic checkpointing at step boundaries (prevents re-paying for LLM tokens on replay). Configurable exponential backoff retries.

**Pros:** TypeScript-native, no infra overhead, `waitForEvent` for plan approval, step-level checkpointing
**Cons:** Less mature than Temporal, smaller community

#### Restate (Durable Execution)

| Attribute | Value |
|-----------|-------|
| **Version** | Active development (2025-2026) |
| **License** | BUSL 1.1 (converts to Apache 2.0 after change date) |
| **GitHub** | ~6k stars |
| **Performance** | <100ms p99 for 10-step workflow completions |
| **When** | When agent reliability is critical AND BUSL license is acceptable |

Single Rust binary, no external dependencies. Virtual Objects (keyed by session_id) with persistent state and guaranteed single instance per key. Execution journaling for exactly-once recovery. Built by original Apache Flink creators.

**Pros:** Fastest durable execution (<100ms), TypeScript SDK, Virtual Objects map to agent instances, framework-agnostic
**Cons:** BUSL license, younger project, smaller community

#### Temporal (Durable Execution)

| Attribute | Value |
|-----------|-------|
| **Version** | Active (v1.x server, multi-SDK) |
| **License** | MIT (server), Apache 2.0 (SDKs) |
| **GitHub** | ~17k stars, $300M Series D at $5B valuation |
| **When** | When team mode requires guaranteed multi-step execution across failures |

Market leader. Deterministic workflows + Activities with automatic replay. Signals for human-in-the-loop (approval/rejection). OpenAI Agents SDK integration (Feb 2026). Temporal Nexus for cross-namespace workflow connection.

**Pros:** Most mature, open source, multi-SDK, OpenAI integration pattern
**Cons:** Operational complexity (requires PostgreSQL/MySQL + Elasticsearch), heavy for simple flows

#### RisingWave (Streaming Database)

| Attribute | Value |
|-----------|-------|
| **Version** | v2.3 (2025) |
| **License** | Apache 2.0 |
| **GitHub** | 8.5k stars |
| **When** | When analytics/reporting dashboard over event streams needed |

SQL-based stream processing with incrementally maintained materialized views. <100ms freshness, 10-20ms p99 query latency. Ingests from Kafka, Pulsar, NATS, databases (CDC). 100x faster than PostgreSQL for streaming aggregations.

### Tier 4: Watch / Do Not Adopt

| Technology | Version | License | Reason |
|-----------|---------|---------|--------|
| **Apache Pulsar** | 4.1.3 | Apache 2.0 | Overkill — requires ZooKeeper + BookKeeper (6-9 nodes minimum) |
| **Redpanda** | 25.2.7 | BSL 1.1 | BSL license, Kafka-compat not needed for this architecture |
| **Memphis.dev** | Abandoned | — | Dead project, pivoted to Superstream (Kafka cost optimizer) |
| **Windmill** | Active | AGPLv3 | AGPL license, overlaps with existing Claude Agent SDK orchestration |
| **WebTransport** | Experimental | — | Not production-ready until 2027-2028; Safari behind flag. Stay with SSE. |
| **Benthos/Connect** | v4.x | MIT | Only useful when external system ETL/integration required |
| **Redis** | 8.0+ | SSPL | License changed to SSPL — use Valkey (BSD-3) instead |
| **Apache Kafka** | 4.0+ | Apache 2.0 | Massive operational overhead, overkill for <1000 events/sec |

### Technology Comparison Matrix

| Capability | Current (Caddy/LMDB) | NATS JetStream | Valkey | Turso/libSQL |
|-----------|----------------------|----------------|--------|-------------|
| Backpressure | None | Consumer ack | Consumer groups | N/A |
| Retention policies | None | Time/size/count | MAXLEN/MINID | N/A |
| Replay | Offset-based | Sequence/time | XRANGE | SQL queries |
| Exactly-once | v0.2.0 (idempotent) | Dedup window + ack | At-least-once | ACID |
| Clustering/HA | No | Built-in Raft | Cluster/Sentinel | Embedded replicas |
| Latency | ~5ms (batch linger) | <1ms | <1ms | Local reads |
| Embedded option | Yes (Caddy module) | Go only (sidecar for Bun) | No (external) | Yes (`@libsql/client`) |
| License | Apache 2.0 | Apache 2.0 | BSD-3 | MIT |

---

## 4. Hybrid Architecture Design

### Design Principles

1. **Evolve, don't replace** — Durable Streams stays for UI delivery throughout all phases
2. **SQLite remains source of truth** — never delegate durability to a message broker alone
3. **Outbox before broker** — fix dual-write inconsistency with the outbox pattern before introducing external messaging
4. **Adopt incrementally** — each phase delivers value independently; no big-bang migration
5. **License-safe** — prefer Apache 2.0, MIT, BSD-3; avoid SSPL, AGPL, BUSL unless explicitly accepted
6. **TypeScript-first** — all new components must have first-class TypeScript/Bun support

### Target Architecture (End of Phase 3)

```
                                   ┌─────────────────────────────────┐
                                   │         Browser Clients         │
                                   │  (SSE via Durable Streams)      │
                                   └────────────┬────────────────────┘
                                                │ SSE (offset-based resume)
                                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                  Caddy / Durable Streams v0.2.x                         │
│            (LMDB persistence, idempotent producers,                      │
│             exactly-once delivery, auth middleware)                       │
│            Events formatted as CloudEvents v1.0                         │
└──────────────┬───────────────────────────────────────────┬───────────────┘
               │ SSE bridge consumer                       │
               ▼                                           ▼
┌──────────────────────────────┐         ┌─────────────────────────────────┐
│    API Server (Bun/Hono)     │◄───────►│       NATS JetStream            │
│                              │  pub/sub│  (inter-service messaging)      │
│  SQLite (source of truth)    │         │  KV: agent state/config         │
│  + Outbox table + relay      │         │  Subjects: agent.*, session.*   │
│  + Litestream → S3 backup    │         │  Leaf nodes: remote agents      │
│  + Snapshots table           │         │  Consumer groups: processing    │
│                              │         └──────────┬──────────────────────┘
│  Valkey                      │                    │
│  (presence, rate limits,     │          ┌─────────┼─────────┐
│   ephemeral state cache)     │          ▼         ▼         ▼
│                              │    ┌──────────┐ ┌──────────┐ ┌──────────┐
│  Inngest / Restate           │    │ Agent    │ │ Agent    │ │ Agent    │
│  (durable agent execution)   │    │ Runner 1 │ │ Runner 2 │ │ Runner N │
└──────────────────────────────┘    │ (Docker) │ │ (Docker) │ │ (Remote) │
                                    │ + edge   │ │ + edge   │ │ + leaf   │
                                    │   CEP    │ │   CEP    │ │   node   │
                                    └──────────┘ └──────────┘ └──────────┘
```

### Component Responsibilities

| Component | Role | Phase |
|-----------|------|-------|
| **Durable Streams (Caddy/LMDB)** | Last-mile SSE delivery to browser clients | Current |
| **SQLite + Outbox** | Source of truth for all events, transactional outbox for reliable publishing | Phase 1 |
| **Outbox Relay Worker** | Polls outbox, publishes to Caddy + NATS | Phase 1 |
| **Unified Event Bus** | In-process event router replacing 3 disconnected SSE subsystems | Phase 1 |
| **Dead Letter Queue** | Retry failed webhook processing with backoff | Phase 1 |
| **NATS JetStream** | Inter-service messaging, consumer groups, subject routing | Phase 2 |
| **Valkey** | Presence cache, rate limiting, ephemeral session state | Phase 2 |
| **SSE Bridge Consumer** | NATS consumer that publishes to Caddy for browser delivery | Phase 2 |
| **Litestream** | SQLite WAL replication to S3/NATS for disaster recovery | Phase 3 |
| **Inngest/Restate** | Durable execution for agent lifecycle sagas | Phase 3 |
| **Edge CEP** | Local event processing in agent containers (stall detection, batching) | Phase 3 |

---

## 5. Evolution Phases

### Phase 1: Foundation (Timeline: Weeks)

**Goal**: Fix reliability, eliminate dual-write, standardize schema — no new infrastructure.

#### 1.1 Transactional Outbox

Replace the dual-write pattern (`DurableStreamsService` DB-first + `SessionStreamService` Caddy-first) with a single transactional outbox:

```sql
CREATE TABLE event_outbox (
    id TEXT PRIMARY KEY,
    sequence_id INTEGER NOT NULL,
    stream_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    channel TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    published_at TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 10
);

CREATE INDEX idx_outbox_unpublished ON event_outbox (sequence_id)
    WHERE published_at IS NULL;
CREATE INDEX idx_outbox_stream ON event_outbox (stream_id, sequence_id);
```

**Relay worker** polls unpublished events every 50ms and publishes to Caddy. On success, marks `published_at`. On failure, increments `retry_count`. Events with `retry_count >= max_retries` are logged and skipped.

**Solves**: RS-013 (dual-write inconsistency), RS-014 (offset collision retry).

**Files affected**: `src/services/durable-streams.service.ts`, `src/services/session/session-stream.service.ts`, new `src/services/outbox-relay.service.ts`

#### 1.2 Unified Event Bus

Consolidate three SSE subsystems into a single internal event router:

| Current | Replacement |
|---------|-------------|
| `eventStreamListeners` (Set) in event-bus.ts | Unified EventRouter with channel subscriptions |
| `localSubscribers` (Set) in cli-monitor.service.ts | EventRouter channel: `cli-monitor` |
| Caddy durable streams (external) | EventRouter channel: `sessions.*`, `plans.*`, etc. |

Single connection counter, single auth check, single backpressure policy.

**Solves**: RS-002 (duplicate SSE tracking), RS-009 (three disconnected systems).

#### 1.3 Dead Letter Queue for Webhooks

```sql
CREATE TABLE webhook_dlq (
    id TEXT PRIMARY KEY,
    event_log_id TEXT REFERENCES event_log(id),
    event_source_id TEXT,
    original_payload TEXT NOT NULL,
    original_headers TEXT NOT NULL,
    error_message TEXT NOT NULL,
    error_type TEXT NOT NULL CHECK (error_type IN ('transient','permanent','rate_limit')),
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 5,
    next_retry_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_retry_at TEXT,
    resolved_at TEXT,
    resolution TEXT CHECK (resolution IN ('retried_success','manual_fix','discarded'))
);
```

Retry strategy: exponential backoff with jitter (`2^n * 1000ms + random(0-1000ms)`).

API endpoints:
- `POST /api/events/dlq/:id/retry` — retry single message
- `POST /api/events/dlq/retry-all?error_type=transient` — bulk retry

#### 1.4 Event Schema Normalization

Adopt CloudEvents envelope for lifecycle events. Standardize naming:

**Current (inconsistent):**
```
plan:started, container-agent:started, topology:agent_spawned, plan_ready
```

**Proposed (hierarchical, delta/done pairing):**
```
io.agentpane.agent.started
io.agentpane.agent.text.delta       (was: chunk)
io.agentpane.agent.text.done        (new: signals end of text stream)
io.agentpane.agent.tool.started     (was: tool:start)
io.agentpane.agent.tool.completed   (was: tool:result)
io.agentpane.agent.plan.ready       (was: plan_ready / agent:plan_ready)
io.agentpane.agent.completed
io.agentpane.topology.agent.spawned (was: topology:agent_spawned)
io.agentpane.sandbox.creating
io.agentpane.terraform.code
```

**Backward compatibility**: Support both old and new names during transition via a mapping layer.

#### 1.5 Chunk Event Batching + Drop Accumulated

- Buffer text deltas for 50-100ms, flush as single batched event to SQLite
- Send individual deltas to Caddy SSE for real-time UI (skip SQLite for intermediate chunks)
- Remove `accumulated` field from chunk events (client already reconstructs from deltas)

**Solves**: RS-008 (no backpressure), 2.3 (no batching), 2.4 (O(n²) storage).

#### 1.6 Event Retention & Cleanup

Scheduled cleanup job:
- `session_events`: Delete events for sessions older than 30 days (configurable)
- `event_log`: Delete webhook logs older than 90 days
- `event_outbox`: Delete published events older than 7 days
- Add index on `created_at` for efficient range deletes

---

### Phase 2: Broker (Timeline: Months)

**Goal**: Enable horizontal scaling with NATS JetStream as the central messaging backbone.

#### 2.1 NATS JetStream Introduction

Deploy NATS as a sidecar process alongside the Bun API server.

**Subject hierarchy:**
```
agentpane.sessions.{sessionId}.events    — session lifecycle
agentpane.agents.{agentId}.lifecycle     — agent state changes
agentpane.agents.{agentId}.tokens        — high-frequency text deltas
agentpane.tasks.{taskId}.state           — task state machine transitions
agentpane.topology.{sessionId}           — team mode coordination
agentpane.webhooks.incoming              — incoming webhook events
agentpane.webhooks.dlq                   — dead letter queue
```

**Stream configuration:**
```
Stream: SESSIONS
  Subjects: agentpane.sessions.>
  Retention: Limits (24h or 100,000 messages)
  Storage: File (with sync: always)
  Replicas: 1 (single node) / 3 (cluster)

Stream: AGENTS
  Subjects: agentpane.agents.>
  Retention: Interest (when no consumers)
  Storage: File

Stream: WEBHOOKS
  Subjects: agentpane.webhooks.>
  Retention: WorkQueue (delete after ack)
  Storage: File
```

#### 2.2 SSE Bridge Consumer

A NATS consumer that reads from JetStream and publishes to Caddy Durable Streams:

```
NATS JetStream → SSE Bridge Consumer → Caddy/LMDB → SSE → Browser
```

This decouples producers from SSE delivery. Multiple API server instances can publish to NATS; the SSE bridge consumer handles fan-out to Caddy.

#### 2.3 Valkey for Presence & Cache

Replace in-memory `presenceStore` Map with Valkey:

```
Valkey key: presence:{sessionId}:{userId}
  Value: { displayName, avatarUrl, cursor, lastSeen }
  TTL: 30 seconds (auto-expire stale users)
```

**Solves**: RS-007 (stale presence), enables multi-instance presence awareness.

Also use Valkey for:
- Rate limiting (webhook endpoints, SSE connections)
- Session state cache (reduce SQLite reads for active sessions)
- Agent status cache (quick lookup without DB query)

#### 2.4 Authentication for Caddy SSE

Add auth middleware to Caddy stream paths (RS-019):
- Token validation via JWT or session cookie
- Scope enforcement: user can only subscribe to their team's sessions
- Network-level: restrict Caddy port to internal traffic in production

---

### Phase 3: Durability (Timeline: Quarters)

**Goal**: Production-grade resilience with durable execution, edge processing, and multi-node scaling.

#### 3.1 Durable Execution for Agent Lifecycle

Integrate Inngest (near-term) or Restate (if BUSL acceptable) for the agent execution pipeline:

```
Task assigned
  → step.run("planning", () => agentService.startPlanning(taskId))
  → step.waitForEvent("plan-approval", { event: "agentpane/plan.approved", timeout: "24h" })
  → step.run("execution", () => agentService.startExecution(taskId, approvedPlan))
  → step.run("completion", () => taskService.moveToApproval(taskId))
```

**Benefits:**
- Agent execution survives process restarts (no re-paying for LLM tokens)
- Plan approval flow is a native `waitForEvent` with configurable timeout
- Automatic retries with exponential backoff for transient failures
- Full execution history and observability
- Team mode: orchestrator workflow spawns sub-agent Activities

#### 3.2 Edge Event Processing in Containers

Enhance `agent-runner/src/event-emitter.ts` with local CEP:

- **Stall detection**: No output for >30 seconds → emit `agent.stall` event
- **Rate warning**: >5 tool calls in 1 second → emit `agent.rate_warning`
- **Tool degradation**: Repeated tool errors → emit `agent.tool.degradation`
- **Token batching**: Accumulate 10 tokens into single batch event before forwarding
- **Local buffering**: Store events in tmpfs, forward batches to central system (survives temporary disconnection)

#### 3.3 Litestream for SQLite HA

Deploy Litestream as a sidecar for continuous WAL replication:
- Primary destination: S3 bucket (or NATS JetStream)
- LTX compaction: L1 (30s), L2 (5 min)
- VFS read replicas for historical session replay without loading primary DB
- Point-in-time recovery for disaster scenarios

#### 3.4 Multi-Node Scaling

With NATS JetStream as backbone:
- Multiple Bun API instances publish to NATS (no local state needed)
- Each instance runs SSE bridge consumers for their connected browsers
- Competing consumers distribute webhook processing across instances
- Valkey provides shared state (presence, cache, rate limits)
- Litestream provides SQLite read replicas

#### 3.5 CQRS Snapshots

Add periodic snapshots to prevent full event replay degradation:

```sql
CREATE TABLE session_snapshots (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    snapshot_offset INTEGER NOT NULL,
    state TEXT NOT NULL,  -- JSON: agent status, accumulated text, tool history
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, snapshot_offset)
);
```

Snapshot every 1000 events or on agent phase transitions. On session load, read latest snapshot + events since snapshot offset.

---

## 6. Pattern Catalog

### 6.1 Transactional Outbox

**Problem**: Dual-write between SQLite and Caddy can lose events or create inconsistency.

**Pattern**: Write business data and event to the same SQLite transaction. A relay worker polls and publishes.

```typescript
// Write side: single transaction
await db.transaction(async (tx) => {
  await tx.update(sessions).set({ status: 'completed' }).where(eq(sessions.id, sessionId));
  await tx.insert(eventOutbox).values({
    id: createId(),
    sequenceId: nextSequence,
    streamId: sessionId,
    eventType: 'io.agentpane.agent.completed',
    payload: JSON.stringify(eventData),
  });
});

// Relay worker: poll and publish
const pending = await db.select().from(eventOutbox)
  .where(isNull(eventOutbox.publishedAt))
  .orderBy(eventOutbox.sequenceId)
  .limit(100);
for (const event of pending) {
  await caddyStreams.publish(event.streamId, event.eventType, event.payload);
  await db.update(eventOutbox).set({ publishedAt: now() }).where(eq(eventOutbox.id, event.id));
}
```

**Guarantees**: At-least-once delivery. Consumers must be idempotent (use `sequence_id` for dedup).

### 6.2 CQRS / Event Sourcing (Lightweight)

AgentPane's `sessionEvents` table already IS an event store:

| CQRS Concept | AgentPane Implementation |
|-------------|--------------------------|
| Event store | `session_events` table (append-only, ordered by offset) |
| Write model | `DurableStreamsService.publish()` |
| Read model | TanStack DB collections (client-side projections) |
| Temporal query | Offset-based replay from SQLite |
| Projection | `useSession` hook transforms events → UI state |

**Improvements needed:**
1. Add snapshot table (prevent full replay for long sessions)
2. Add `schema_version` to events for upcasting during replay
3. Formalize session as aggregate root with version checks
4. Ability to rebuild client projections from event history

### 6.3 Dead Letter Queue

**Classification-based retry:**

| Error Type | Examples | Strategy |
|------------|----------|----------|
| `transient` | DB timeout, service unavailable, network blip | Retry with exponential backoff (1s, 2s, 4s, 8s, 16s) |
| `permanent` | Invalid payload, missing subscription, schema violation | Move to DLQ, alert operator |
| `rate_limit` | Too many task creations | Retry with longer backoff (30s, 60s, 120s) |

**Monitoring**: Alert when DLQ depth > 10. Dashboard: growth rate, error distribution, resolution status.

### 6.4 Edge Event Processing

For container agents (event generation inside Docker → central system):

```
┌─────────────────────────────────────────┐
│  Container Agent                         │
│                                          │
│  Claude SDK → EventEmitter               │
│                    │                     │
│              ┌─────┴──────┐              │
│              │  Edge CEP   │              │
│              │  - stall    │              │
│              │  - rate     │              │
│              │  - degrade  │              │
│              │  - batch    │              │
│              └─────┬──────┘              │
│                    │                     │
│              ┌─────┴──────┐              │
│              │  Priority   │              │
│              │  Router     │              │
│              │             │              │
│              │ Critical:   │              │
│              │  writeSync  │              │
│              │             │              │
│              │ Normal:     │              │
│              │  buffered   │              │
│              └─────┬──────┘              │
│                    │                     │
│              stdout (JSON lines)         │
└────────────────────┬────────────────────┘
                     │
              ContainerBridge
                     │
              ┌──────┴───────┐
              │ Phase 1: Caddy│
              │ Phase 2: NATS │
              └──────────────┘
```

### 6.5 Event-Carried State Transfer

Standardize thin/fat/delta events:

| Event Category | Pattern | Example |
|---------------|---------|---------|
| **High-frequency streaming** | Thin (delta only) | `agent.text.delta: { text: "token" }` |
| **Lifecycle events** | Fat (full state) | `agent.completed: { taskId, sessionId, worktreePath, summary, duration }` |
| **State changes** | Delta (before/after) | `task.moved: { taskId, from: "backlog", to: "in_progress", agentId }` |

**Rule**: If a consumer would need to make a synchronous callback to act on the event, make it fat.

### 6.6 Saga / Choreography for Agent Orchestration

**Recommendation**: Hybrid orchestration + choreography.

**Orchestrator** (keep) for:
- Main agent lifecycle: task assigned → planning → approval → execution → completion
- Clear visibility into workflow state
- Single place to see the full saga

**Choreography** (adopt) for:
- Team mode sub-agent coordination (agents communicate via events)
- Webhook-triggered task creation (already event-driven)
- Cross-service notifications (session events, presence updates)

```
Orchestrated:
  TaskService.move("in_progress") → AgentExecutionService.start()
    → planning → waitForApproval → execution → completion

Choreographed:
  topology:agent_spawned → sub-agents listen for their assignments
  sub-agent publishes progress → topology consumer aggregates
  all sub-agents complete → completion event triggers merge
```

---

## 7. Agent Event Model Evolution

### 7.1 Hierarchical Naming Convention

Adopt the industry-standard hierarchical naming pattern (used by OpenAI, Google ADK, CloudEvents):

```
{reverse-domain}.{entity}.{action}[.{qualifier}]

io.agentpane.agent.started
io.agentpane.agent.text.delta
io.agentpane.agent.text.done
io.agentpane.agent.tool.started
io.agentpane.agent.tool.completed
io.agentpane.agent.plan.started
io.agentpane.agent.plan.ready
io.agentpane.agent.plan.approved
io.agentpane.agent.completed
io.agentpane.agent.error
io.agentpane.topology.agent.spawned
io.agentpane.topology.agent.progress
io.agentpane.topology.agent.completed
io.agentpane.sandbox.creating
io.agentpane.sandbox.ready
io.agentpane.sandbox.stopped
io.agentpane.terraform.text.delta
io.agentpane.terraform.code
io.agentpane.terraform.done
io.agentpane.task.creation.started
io.agentpane.task.creation.completed
io.agentpane.presence.joined
io.agentpane.presence.left
```

**Benefits**: Natural NATS subject filtering (`io.agentpane.agent.>` for all agent events), consistent discoverability, CloudEvents `type` field compatibility.

### 7.2 CloudEvents Envelope

Lifecycle events (agent started/completed, task moved, plan ready) wrapped in CloudEvents:

```json
{
  "specversion": "1.0",
  "id": "evt_cuid2abc123",
  "source": "/agentpane/sessions/sess-42",
  "type": "io.agentpane.agent.completed.v1",
  "datacontenttype": "application/json",
  "time": "2026-03-22T10:30:00Z",
  "subject": "agent-7",
  "data": {
    "sessionId": "sess-42",
    "agentId": "agent-7",
    "taskId": "task-99",
    "result": "success",
    "duration": 45000,
    "turnsUsed": 12
  }
}
```

**High-frequency events** (text deltas, token events) use lightweight format without CloudEvents envelope to minimize overhead.

### 7.3 Delta/Done Pairing for Streaming

Every content stream has both incremental deltas and a finalization event:

```
agent.text.delta  → { text: "Hello" }      (incremental)
agent.text.delta  → { text: " world" }     (incremental)
agent.text.done   → { text: "Hello world", turnId: "t-1" }  (final, complete)
```

The `.done` event carries the complete data, enabling consumers that miss deltas to reconstruct state. Matches OpenAI's universal delta/done pattern (53 streaming events follow this convention).

### 7.4 Subagent Namespace Tracking

For team mode, add namespace tracking to events (inspired by LangGraph's `ns` tuple and Claude SDK's `parent_tool_use_id`):

```json
{
  "type": "io.agentpane.agent.text.delta",
  "namespace": ["team-session-42", "sub-agent-frontend"],
  "parentAgentId": "planning-agent-1",
  "data": { "text": "Implementing the React component..." }
}
```

Enables:
- Client-side filtering by subagent
- Topology view attribution
- Progress tracking per subagent

### 7.5 AsyncAPI Documentation

Document all event channels using AsyncAPI 3.0:

```yaml
asyncapi: '3.0.0'
info:
  title: AgentPane Event API
  version: '1.0.0'
  description: Real-time event streaming for AI agent execution
channels:
  sessions/{sessionId}/events:
    messages:
      agentTextDelta:
        payload:
          $ref: '#/components/schemas/AgentTextDeltaEvent'
      agentCompleted:
        payload:
          $ref: '#/components/schemas/AgentCompletedEvent'
      toolStarted:
        payload:
          $ref: '#/components/schemas/ToolStartedEvent'
components:
  schemas:
    AgentTextDeltaEvent:
      type: object
      required: [text]
      properties:
        text:
          type: string
          description: Incremental text token
    AgentCompletedEvent:
      type: object
      required: [sessionId, agentId, taskId, result]
      properties:
        sessionId: { type: string }
        agentId: { type: string }
        taskId: { type: string }
        result: { type: string, enum: [success, error, cancelled] }
        duration: { type: integer, description: 'Execution time in ms' }
```

**Schema evolution rules:**
1. Never remove required fields
2. New fields must have defaults or be optional
3. Version in the type field: `io.agentpane.agent.completed.v2`
4. Backward compatibility as default mode
5. Support old versions for at least 2 release cycles

---

## 8. Industry Comparison

### How Other Agent Platforms Handle Events

| Platform | Streaming Model | Event Types | Multi-Agent |
|----------|----------------|-------------|-------------|
| **LangGraph** | 7 stream modes (values, updates, messages, custom, checkpoints, tasks, debug) | Unified v2 schema with `ns` tuple | Subgraph streaming via `subgraphs=True` |
| **OpenAI Responses API** | 53 streaming event types, hierarchical naming | `response.output_text.delta/done` pattern | `RunItemStreamEvent` for handoffs |
| **Claude Agent SDK** | Async generator yielding 18+ `SDKMessage` types | 18 hook events including `SubagentStart/Stop` | `parent_tool_use_id` for attribution |
| **Google ADK** | Immutable Event records with `EventActions` | `state_delta`, `artifact_delta`, `transfer_to_agent` | `LiveRequestQueue` bidirectional |
| **CrewAI** | Crews (autonomous) + Flows (event-driven) | 12M+ executions/day | Structured message passing |
| **AutoGen/AG2** | Async actor model with `AgentOS` runtime | Event-driven pipelines (Core API) | Cross-framework via A2A + MCP |
| **Vercel AI SDK v6** | Unified `Agent` class with `streamText` | `useChat` SSE streaming | `needsApproval` for human-in-loop |

### Key Insights for AgentPane

1. **LangGraph's multi-mode streaming** — ability to subscribe to specific event categories (values, updates, messages) is worth adopting
2. **OpenAI's delta/done pairing** — universal pattern now industry standard
3. **Claude SDK's hook system** — most granular in industry; `SubagentStart/Stop` maps to topology events
4. **Google A2A protocol** — emerging standard for inter-agent communication (150+ organizations, Linux Foundation governance)

### LLM Streaming Optimization

| Pattern | Description | Applicability |
|---------|-------------|---------------|
| **SSE for tokens** | Industry standard for unidirectional LLM streaming | Keep current approach |
| **Hybrid SSE + WebSocket** | SSE for tokens, WebSocket for bidirectional control | Consider for plan approval UX |
| **Stream multiplexing** | Stream IDs per agent over single connection | Team mode topology view |
| **Dynamic chunk sizing** | Flush every N tokens or T ms based on network | Phase 1 batching |
| **Delta compression** | Store only incremental changes | Already doing (delta text) |

### Observability (OpenTelemetry GenAI)

OpenTelemetry has established **GenAI Semantic Conventions** for agent observability:

- **Model Spans**: Individual LLM call tracing with token counts, latency, model info
- **Agent Spans**: Framework-level operation tracing across multi-step workflows
- **Technology-specific conventions**: Anthropic, OpenAI, AWS Bedrock, MCP

**Recommendation**: Implement OTel GenAI semantic conventions for agent spans. This enables export to any OTel-compatible backend (Datadog, Grafana, etc.) without custom integrations. Datadog natively supports GenAI conventions as of v1.37+.

---

## 9. Decision Log

| # | Decision | Options Considered | Chosen | Rationale |
|---|----------|-------------------|--------|-----------|
| 1 | Message broker | NATS JetStream, Redis Streams, Valkey Streams, Apache Pulsar, Redpanda, Kafka | **NATS JetStream** | Single binary, Apache 2.0, sub-ms latency, leaf nodes for edge agents, KV store. Jepsen caveat mitigated by keeping SQLite as source of truth. |
| 2 | In-memory cache | Redis, Valkey, Dragonfly | **Valkey** | BSD-3 license (Redis is SSPL), 37% faster, drop-in compatible, truly open source |
| 3 | SQLite HA | Litestream, Turso, rqlite, LiteFS | **Litestream** (now), **Turso** (later) | Litestream: zero-code, sidecar, no app changes. Turso: when concurrent writes needed |
| 4 | Event format | Custom, CloudEvents, AsyncAPI | **CloudEvents v1.0** | CNCF graduated, low adoption effort, enables interop, maps 1:1 to existing types |
| 5 | Event naming | Current (mixed), hierarchical, flat | **Hierarchical** (`io.agentpane.agent.text.delta`) | Industry standard (OpenAI, CloudEvents), natural NATS subject routing, discoverability |
| 6 | Reliable publishing | Dual-write, outbox, CDC | **Transactional Outbox** | Eliminates dual-write inconsistency with SQLite ACID, no new infra |
| 7 | Webhook retry | In-line retry, external queue, DLQ table | **DLQ table** | SQLite-native, error classification, exponential backoff, reprocessing API |
| 8 | Durable execution | Temporal, Restate, Inngest, Windmill | **Inngest** (near-term) | TypeScript-native, `waitForEvent` for plan approval, no infra overhead |
| 9 | SSE transport | SSE, WebSocket, WebTransport, gRPC | **Keep SSE** (Durable Streams) | SSE wins for 95% of real-time, WebTransport not ready until 2027-2028 |
| 10 | Schema docs | OpenAPI, AsyncAPI, custom | **AsyncAPI 3.0** | Industry standard for event-driven APIs, complements CloudEvents |
| 11 | Presence store | In-memory Map, Valkey, SQLite | **Valkey** (Phase 2) | TTL-based auto-expiry solves stale presence, multi-instance awareness |
| 12 | CDC approach | Trigger-based, Turso CDC, outbox | **Outbox** (not CDC) | Outbox captures intentional domain events; CDC captures all DB changes indiscriminately |

---

## 10. Sources & References

### Core Architecture
- [Durable Streams Protocol](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md)
- [Durable Streams 0.1.0](https://electric-sql.com/blog/2025/12/23/durable-streams-0.1.0)
- [Hosted Durable Streams](https://electric-sql.com/blog/2026/01/22/announcing-hosted-durable-streams)
- [Durable Sessions for Collaborative AI](https://electric-sql.com/blog/2026/01/12/durable-sessions-for-collaborative-ai)
- [Electric SQL 1.0 Released](https://electric-sql.com/blog/2025/03/17/electricsql-1.0-released)

### NATS JetStream
- [NATS JetStream Docs](https://docs.nats.io/nats-concepts/jetstream)
- [Jepsen: NATS 2.12.1](https://jepsen.io/analyses/nats-2.12.1)
- [NATS vs Kafka vs Redis Streams Benchmarks 2026](https://www.javacodegeeks.com/2026/03/nats-vs-kafka-vs-redis-streams-for-java-microservices-when-simpler-actually-wins.html)
- [NATS and Kafka Compared (Synadia)](https://www.synadia.com/blog/nats-and-kafka-compared)
- [NATS Leaf Nodes](https://docs.nats.io/running-a-nats-service/configuration/leafnodes)
- [NATS KV Store](https://docs.nats.io/nats-concepts/jetstream/key-value-store)
- [NATS JetStream Exactly-Once](https://medium.com/@hadiyolworld007/nats-jetstream-playbook-exactly-once-minus-the-bloat-02fd9d5a051c)
- [NATS JetStream Building Reliable Messaging](https://james-carr.org/posts/2026-01-21-nats-jetstream-building-reliable-messaging/)

### Valkey / Redis
- [Redis vs Valkey in 2026](https://dev.to/synsun/redis-vs-valkey-in-2026-what-the-license-fork-actually-changed-1kni)
- [Valkey Key Features](https://www.dragonflydb.io/guides/valkey-key-features-pros-cons-and-comparison-with-redis)
- [Redis 8.0 vs Valkey 8.1 Technical Comparison](https://www.dragonflydb.io/blog/redis-8-0-vs-valkey-8-1-a-technical-comparison)
- [Redis Streams Docs](https://redis.io/docs/latest/develop/data-types/streams/)

### SQLite Ecosystem
- [Litestream v0.5.0](https://fly.io/blog/litestream-v050-is-here/)
- [Litestream VFS Read Replicas](https://litestream.io/guides/vfs/)
- [Turso Vector Search](https://turso.tech/blog/turso-brings-native-vector-search-to-sqlite)
- [Turso Concurrent Writes](https://www.webpronews.com/turso-enables-concurrent-writes-in-libsql-for-scalable-edge-databases/)
- [Distributed SQLite: LibSQL and Turso 2026](https://dev.to/dataformathub/distributed-sqlite-why-libsql-and-turso-are-the-new-standard-in-2026-58fk)
- [SQLite Renaissance 2026](https://dev.to/pockit_tools/the-sqlite-renaissance-why-the-worlds-most-deployed-database-is-taking-over-production-in-2026-3jcc)

### Durable Execution
- [Temporal for AI](https://temporal.io/solutions/ai)
- [Durable Multi-Agent AI with Temporal](https://temporal.io/blog/using-multi-agent-architectures-with-temporal)
- [Temporal + OpenAI Agents SDK](https://temporal.io/blog/announcing-openai-agents-sdk-integration)
- [Temporal Replay 2025 Announcements](https://temporal.io/blog/replay-2025-product-announcements)
- [Rise of Durable Execution Engines](https://www.kai-waehner.de/blog/2025/06/05/the-rise-of-the-durable-execution-engine-temporal-restate-in-an-event-driven-architecture-apache-kafka/)
- [Durable AI Loops - Restate](https://www.restate.dev/blog/durable-ai-loops-fault-tolerance-across-frameworks-and-without-handcuffs)
- [Agentic Workflows Are Just Code - Restate](https://restate.dev/blog/agentic-workflows-are-just-code-treat-them-that-way/)
- [Durable Execution for AI Agents - Inngest](https://www.inngest.com/blog/durable-execution-key-to-harnessing-ai-agents)
- [Durable Workflow Platforms for AI - Render](https://render.com/articles/durable-workflow-platforms-ai-agents-llm-workloads)
- [TypeScript Orchestration: Temporal vs Trigger.dev vs Inngest](https://medium.com/@matthieumordrel/the-ultimate-guide-to-typescript-orchestration-temporal-vs-trigger-dev-vs-inngest-and-beyond-29e1147c8f2d)
- [Durable Execution Comparison](https://www.dbos.dev/blog/durable-execution-coding-comparison)

### Architecture Patterns
- [Transactional Outbox Pattern 2026](https://james-carr.org/posts/2026-01-15-transactional-outbox-pattern/)
- [Outbox Pattern with SQLite](https://medium.com/@actor-swe/implementing-the-outbox-pattern-with-sqlite-and-using-brighter-7da81c628c2b)
- [Saga Pattern for AI Workflow Orchestration](https://sparkco.ai/blog/master-saga-pattern-for-ai-workflow-orchestration)
- [Saga Pattern (ByteByteGo)](https://blog.bytebytego.com/p/saga-pattern-demystified-orchestration)
- [AWS Saga Orchestration for Agentic AI](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/saga-orchestration-patterns.html)
- [DLQ Patterns for Failed Messages 2026](https://oneuptime.com/blog/post/2026-02-09-dead-letter-queue-patterns/view)
- [Webhook Reliable Delivery](https://dohost.us/index.php/2025/09/04/implementing-a-webhook-queue-for-reliable-delivery/)

### Agent Platforms & Event Models
- [LangGraph Streaming Docs](https://docs.langchain.com/oss/python/langgraph/streaming)
- [OpenAI Responses API Streaming Events](https://developers.openai.com/api/reference/resources/responses/streaming-events)
- [OpenAI Agents SDK Streaming](https://openai.github.io/openai-agents-python/streaming/)
- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Claude Agent SDK TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [AI SDK 6 - Vercel](https://vercel.com/blog/ai-sdk-6)
- [Google ADK Events](https://google.github.io/adk-docs/events/)
- [Bidirectional Streaming Multi-Agent - Google](https://developers.googleblog.com/en/beyond-request-response-architecting-real-time-bidirectional-streaming-multi-agent-system/)
- [CrewAI Flows](https://docs.crewai.com/en/concepts/flows)
- [AG2 Official](https://www.ag2.ai/)

### Protocols & Standards
- [A2A Protocol Announcement](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [A2A Protocol Upgrade](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade)
- [MCP November 2025 Spec](https://medium.com/@dave-patten/mcps-next-phase-inside-the-november-2025-specification-49f298502b03)
- [CloudEvents Spec](https://cloudevents.io/)
- [AsyncAPI and CloudEvents](https://www.asyncapi.com/blog/asyncapi-cloud-events)
- [CloudEvents Schema Registry 2026](https://oneuptime.com/blog/post/2026-02-09-event-schema-registry-cloudevents/view)

### Streaming & SSE
- [SSE Still Wins in 2026](https://procedure.tech/blogs/the-streaming-backbone-of-llms-why-server-sent-events-(sse)-still-wins-in-2025)
- [SSE vs WebSockets for LLM Streaming](https://compute.hivenet.com/post/llm-streaming-sse-websockets)
- [Streaming at Scale](https://learnwithparam.com/blog/streaming-at-scale-sse-websockets-real-time-ai-apis)
- [SSE Beats WebSockets for 95% of Apps](https://dev.to/polliog/server-sent-events-beat-websockets-for-95-of-real-time-apps-heres-why-a4l)
- [WebTransport Browser Support](https://caniuse.com/webtransport)

### Event-Driven Architecture
- [Event-Driven Multi-Agent Systems - Confluent](https://www.confluent.io/blog/event-driven-multi-agent-systems/)
- [Solace Event Mesh](https://solace.com/solutions/initiative/event-mesh/)
- [Kong Event Gateway](https://konghq.com/products/event-gateway)
- [Supabase Realtime Architecture](https://supabase.com/docs/guides/realtime/architecture)
- [Figma Multiplayer Technology](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
- [Linear Sync Architecture](https://bytemash.net/posts/i-went-down-the-linear-rabbit-hole/)
- [GitHub Actions Architecture 2026](https://github.blog/news-insights/product-news/lets-talk-about-github-actions/)

### Observability
- [AI Agent Observability - OpenTelemetry](https://opentelemetry.io/blog/2025/ai-agent-observability/)
- [GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [Datadog OTel GenAI Support](https://www.datadoghq.com/blog/llm-otel-semantic-convention/)
- [Best AI Observability Platforms 2025](https://www.braintrust.dev/articles/best-ai-observability-platforms-2025)

### CQRS / Event Sourcing
- [SQLite Event Store](https://github.com/johnbcodes/sqlite-es)
- [CQRS Pattern - Azure](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs)
- [Redis CQRS](https://redis.io/solutions/microservices/cqrs/)
- [AI Agent Checkpointing](https://zylos.ai/research/2026-03-04-ai-agent-workflow-checkpointing-resumability)

### CDC
- [Turso CDC for SQLite](https://turso.tech/blog/introducing-change-data-capture-in-turso-sqlite-rewrite)
- [sqlite-cdc (trigger-based)](https://github.com/kevinconway/sqlite-cdc)
- [rqlite 9.0 CDC](https://philipotoole.com/rqlite-9-0-real-time-change-data-capture-for-distributed-sqlite/)

### Real-Time Collaboration
- [Yjs and CRDTs](https://www.oreateai.com/blog/understanding-yjs-and-crdt-the-future-of-realtime-collaboration/edd99caf9b9bbbb0378d16300568fdf9)
- [Best CRDT Libraries 2025](https://velt.dev/blog/best-crdt-libraries-real-time-data-sync)
- [Local-First Software 2026](https://tech-champion.com/software-engineering/the-local-first-manifesto-why-the-cloud-is-losing-its-luster-in-2026/)

---

## Cross-References

| Spec | Relationship |
|------|-------------|
| [Events System Architecture Review](./README.md) | Current state assessment with RS-* findings |
| [Durable Sessions Integration](../application/integrations/durable-sessions.md) | Current Durable Streams implementation details |
| [Event Service](../application/services/event-service.md) | Webhook event processing pipeline |
| [Event Streaming Diagram](../diagrams/06-event-streaming.md) | Current event flow visualization |
| [Architecture Review: Streaming](../reviews/2026-03-architecture/06-realtime-streaming-events.md) | Detailed RS-001 through RS-019 findings |
