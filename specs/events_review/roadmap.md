# Events System — Next Steps & Prioritized Roadmap

> **Date**: 2026-03-22
> **Based on**: [Events System Architecture Review](./README.md) + [Hybrid Architecture Evolution](./hybrid-architecture.md)
> **Purpose**: Actionable, priority-ranked work items with effort estimates, dependencies, and success criteria

---

## Priority Ranking System

| Priority | Meaning | Action |
|----------|---------|--------|
| **P0** | Critical — blocks scale or causes data issues now | Do immediately |
| **P1** | High — significant improvement, unblocks next phase | Do next sprint |
| **P2** | Medium — important but not urgent, improves resilience | Plan for next quarter |
| **P3** | Low — strategic investment, long-term value | Backlog, trigger when needed |

---

## Executive Summary

19 work items across 3 phases. Phase 1 (P0/P1) requires **no new infrastructure** — all improvements use SQLite + existing Durable Streams. Phase 2 (P2) introduces NATS JetStream + Valkey for horizontal scaling. Phase 3 (P3) adds durable execution and edge processing.

| Phase | Items | Total Effort | New Infra Required |
|-------|-------|-------------|-------------------|
| **1. Foundation** | 9 items (3x P0, 6x P1) | ~3-4 weeks | None |
| **2. Scaling** | 5 items (all P2) | ~6-8 weeks | NATS JetStream, Valkey |
| **3. Durability** | 5 items (all P3) | ~8-12 weeks | Litestream, Inngest/Restate |

---

## Phase 1: Foundation — No New Infrastructure

### P0-1: Drop `accumulated` from Chunk Events

| Attribute | Detail |
|-----------|--------|
| **Priority** | P0 — Critical |
| **Effort** | Small (1-2 hours) |
| **Solves** | O(n^2) storage bloat (Issue 2.4) |
| **Dependencies** | None |
| **Risk** | Low |

**Problem**: Every chunk event carries the full response text so far. A 10KB response generates ~5MB of accumulated text across its chunk events.

**Action**:
1. Remove `accumulated` field from chunk event publish in `src/lib/agents/stream-handler.ts`
2. Verify `src/app/hooks/use-session.ts` already reconstructs text from deltas (it does)
3. Remove `accumulated` from container agent token events in `agent-runner/src/event-emitter.ts`

**Success criteria**: Chunk events contain only `{ delta, agentId, phase }`. Storage per session reduced ~80%.

**Files**:
- `src/lib/agents/stream-handler.ts`
- `agent-runner/src/event-emitter.ts`
- `src/app/hooks/use-session.ts` (verify only)

---

### P0-2: Event Retention & Cleanup

| Attribute | Detail |
|-----------|--------|
| **Priority** | P0 — Critical |
| **Effort** | Small (2-4 hours) |
| **Solves** | Unbounded storage growth (Issue 2.1), ~18M rows/year |
| **Dependencies** | None |
| **Risk** | Low |

**Problem**: `session_events` and `event_log` tables grow without bound. No TTL, no archival, no cleanup.

**Action**:
1. Create `src/services/event-cleanup.service.ts`
2. Add `created_at` index to `session_events` for efficient range deletes
3. Scheduled job on server start (`setInterval`, configurable via settings):
   - `session_events`: Delete where session older than 30 days
   - `event_log`: Delete where `receivedAt` older than 90 days
4. Add admin setting for retention periods

**Success criteria**: Storage growth bounded. Cleanup runs automatically. Configurable retention periods.

**Files**:
- New: `src/services/event-cleanup.service.ts`
- `src/db/schema/sqlite/session-events.ts` (add index)
- `src/db/schema/sqlite/event-log.ts` (add index)
- `src/server/api.ts` (register cleanup on start)

---

### P0-3: Chunk Event Batching

| Attribute | Detail |
|-----------|--------|
| **Priority** | P0 — Critical |
| **Effort** | Medium (4-8 hours) |
| **Solves** | 100-500 individual DB writes/min per agent (Issue 2.3), SQLite write pressure (Issue 2.2) |
| **Dependencies** | P0-1 (drop accumulated) |
| **Risk** | Medium — must preserve real-time UI latency |

**Problem**: Every `content_block_delta` triggers an immediate, individually-persisted event. At streaming speed, this is 5-10 SQLite writes/second per agent.

**Action**:
1. Create a `ChunkBatcher` in stream-handler that accumulates text deltas
2. Flush to SQLite on interval (50-100ms) or threshold (10 tokens)
3. Continue sending individual deltas to Caddy SSE for real-time UI (skip SQLite for intermediate chunks)
4. Only persist the batched/final text per flush window

**Success criteria**: SQLite writes reduced 10-50x during streaming. Real-time UI latency unchanged. No lost text.

**Files**:
- `src/lib/agents/stream-handler.ts`
- `src/services/durable-streams.service.ts`

---

### P1-1: Transactional Outbox

| Attribute | Detail |
|-----------|--------|
| **Priority** | P1 — High |
| **Effort** | Medium-Large (1-2 days) |
| **Solves** | Dual-write inconsistency RS-013, offset collision RS-014 |
| **Dependencies** | P0-3 (batching, to reduce outbox volume) |
| **Risk** | Medium — changes core publish path |

**Problem**: `DurableStreamsService` writes DB-first-then-Caddy; `SessionStreamService` writes Caddy-first-then-DB. Either second write can fail silently.

**Action**:
1. Create `event_outbox` table (schema in hybrid-architecture.md Section 6.1)
2. Create `src/services/outbox-relay.service.ts` — polls every 50ms, publishes to Caddy
3. Modify `DurableStreamsService.publish()` to write to outbox within business transaction
4. Modify `SessionStreamService.publish()` to use same outbox path
5. Remove direct Caddy publish from both services

**Success criteria**: All events flow through outbox. Zero events lost if Caddy temporarily unavailable. Single publish path for all event types.

**Files**:
- New: `src/db/schema/sqlite/event-outbox.ts`
- New: `src/services/outbox-relay.service.ts`
- `src/services/durable-streams.service.ts` (refactor publish)
- `src/services/session/session-stream.service.ts` (refactor publish)
- `src/server/api.ts` (start relay worker)

---

### P1-2: Unified Event Bus

| Attribute | Detail |
|-----------|--------|
| **Priority** | P1 — High |
| **Effort** | Medium (1 day) |
| **Solves** | Three disconnected SSE systems RS-009, duplicate connection tracking RS-002 |
| **Dependencies** | P1-1 (outbox, provides single publish path) |
| **Risk** | Medium — affects all SSE consumers |

**Problem**: Three separate SSE delivery mechanisms with independent connection counters (50+50+Caddy-managed), cleanup logic, and delivery semantics.

**Action**:
1. Create `src/lib/events/event-router.ts` — single in-process pub/sub with channel subscriptions
2. Migrate `eventStreamListeners` (event-bus.ts) → EventRouter channel `webhooks`
3. Migrate `localSubscribers` (cli-monitor.service.ts) → EventRouter channel `cli-monitor`
4. Caddy delivery becomes a subscriber on EventRouter channels `sessions.*`, `plans.*`, etc.
5. Single global `activeConnections` counter with configurable limit (default 200)

**Success criteria**: Single event bus. One connection counter. All SSE endpoints route through EventRouter.

**Files**:
- New: `src/lib/events/event-router.ts`
- `src/lib/events/event-bus.ts` (replace or wrap)
- `src/services/cli-monitor/cli-monitor.service.ts` (remove localSubscribers)
- `src/server/routes/events.ts` (use EventRouter)
- `src/server/routes/cli-monitor.ts` (use EventRouter)

---

### P1-3: SSE Connection Limit + Graceful Degradation

| Attribute | Detail |
|-----------|--------|
| **Priority** | P1 — High |
| **Effort** | Small (2-4 hours) |
| **Solves** | Hard 50-connection ceiling (Issue 2.6), blocks team mode at scale |
| **Dependencies** | P1-2 (unified event bus, single counter) |
| **Risk** | Low |

**Problem**: Hard cap of 50 SSE connections per subsystem. Team mode with 3-5 subagents per task exhausts limits quickly.

**Action**:
1. Increase default to 200 (configurable via admin settings)
2. Add per-user connection counting (prevent one user exhausting pool)
3. Near-limit graceful degradation: return polling-mode response instead of error
4. Add connection metrics to admin dashboard

**Success criteria**: 200 concurrent SSE connections supported. Per-user fairness. Graceful degradation near limit.

**Files**:
- `src/lib/events/event-router.ts` (from P1-2)
- `src/server/routes/events.ts`
- `src/server/routes/cli-monitor.ts`

---

### P1-4: Client Chunk Truncation Warning

| Attribute | Detail |
|-----------|--------|
| **Priority** | P1 — High |
| **Effort** | Small (1-2 hours) |
| **Solves** | Silent data loss at MAX_CHUNKS (Issue 2.7) |
| **Dependencies** | None |
| **Risk** | Low |

**Problem**: When `MAX_CHUNKS` (5000) exceeded, oldest chunks silently discarded. Users see incomplete history with no indicator.

**Action**:
1. Set `truncated: true` flag in session state when slicing
2. Display "Showing last 5,000 events — earlier events available in history" banner in stream panel
3. Add "Load earlier" button that fetches from REST API `/api/sessions/:id/events`

**Success criteria**: Users see clear indicator when viewing truncated stream. Can load full history on demand.

**Files**:
- `src/app/hooks/use-session.ts`
- Stream panel component (add truncation banner)

---

### P1-5: Dead Letter Queue for Webhooks

| Attribute | Detail |
|-----------|--------|
| **Priority** | P1 — High |
| **Effort** | Medium (1 day) |
| **Solves** | No retry for failed webhook processing, silent event loss |
| **Dependencies** | None |
| **Risk** | Low |

**Problem**: If `processIncomingEvent` fails after deduplication, the event is logged as `error` in `event_log` with no automatic retry.

**Action**:
1. Create `webhook_dlq` table (schema in hybrid-architecture.md Section 5, Phase 1.3)
2. On processing failure in `EventProcessingService`, classify error type (transient/permanent/rate_limit)
3. Transient errors: insert into DLQ with exponential backoff schedule
4. DLQ relay worker processes retries on schedule
5. API endpoints: `POST /api/events/dlq/:id/retry`, `POST /api/events/dlq/retry-all`
6. Admin UI: DLQ depth indicator, error distribution

**Success criteria**: Transient webhook failures automatically retried. Permanent failures visible in admin. No silent loss.

**Files**:
- New: `src/db/schema/sqlite/webhook-dlq.ts`
- New: `src/services/webhook-dlq.service.ts`
- `src/services/event-processing.service.ts` (add DLQ on failure)
- `src/server/routes/events.ts` (add DLQ endpoints)

---

### P1-6: Producer Pool LRU Eviction

| Attribute | Detail |
|-----------|--------|
| **Priority** | P1 — High |
| **Effort** | Small (2-4 hours) |
| **Solves** | Unbounded producer pool growth RS-001 |
| **Dependencies** | None |
| **Risk** | Low |

**Problem**: `producers` Map grows unboundedly. Each unique stream ID creates a new producer pair never cleaned up.

**Action**:
1. Add LRU eviction to `CaddyDurableStreamsServer.producers` Map
2. Max 200 entries (configurable), evict least-recently-used on overflow
3. Add idle timeout (5 minutes) — sweep stale producers periodically
4. Log eviction events for observability

**Success criteria**: Producer pool bounded at 200. Idle producers cleaned up after 5 minutes. Memory stable over time.

**Files**:
- `src/lib/streams/caddy-producer.ts`

---

## Phase 2: Scaling — NATS JetStream + Valkey

### P2-1: NATS JetStream Introduction

| Attribute | Detail |
|-----------|--------|
| **Priority** | P2 — Medium |
| **Effort** | Large (2-3 weeks) |
| **Solves** | Single-node ceiling (Issue 2.5), no backpressure (Issue 3.1), no horizontal scaling |
| **Dependencies** | P1-1 (outbox), P1-2 (unified event bus) |
| **Risk** | High — new infrastructure dependency |
| **New infra** | NATS server (sidecar binary) |

**Problem**: Caddy/LMDB is single-node. All event delivery through one process. No consumer groups, no backpressure, no clustering.

**Action**:
1. Add `nats-server` to Docker Compose / deployment config as sidecar
2. Configure with `sync: always` (critical — Jepsen findings)
3. Add `@nats-io/jetstream` client to API server
4. Create stream configuration (SESSIONS, AGENTS, WEBHOOKS — see hybrid-architecture.md Section 5, Phase 2.1)
5. Modify outbox relay to publish to NATS in addition to Caddy
6. Create SSE bridge consumer: NATS → Caddy (decouples producers from SSE delivery)
7. SQLite remains source of truth — NATS is the routing/distribution layer

**Success criteria**: Events flow through NATS. Multiple API instances can publish. SSE delivery decoupled from publish path. Backpressure via consumer acks.

**Key files**:
- New: `src/services/nats.service.ts`
- New: `src/services/sse-bridge-consumer.ts`
- `src/services/outbox-relay.service.ts` (add NATS publish)
- `docker/docker-compose.yml` (add nats-server)
- Config/env: `NATS_URL`, stream configs

**CRITICAL CONFIG**:
```
# nats-server.conf
jetstream {
  store_dir: /data/nats
  sync: always        # MUST be set — Jepsen found 49.7% data loss without this
}
```

---

### P2-2: Valkey for Presence & Ephemeral State

| Attribute | Detail |
|-----------|--------|
| **Priority** | P2 — Medium |
| **Effort** | Medium (1 week) |
| **Solves** | Stale presence RS-007, multi-instance shared state |
| **Dependencies** | None (can parallel with P2-1) |
| **Risk** | Medium — new infrastructure dependency |
| **New infra** | Valkey server |

**Problem**: In-memory `presenceStore` Map never cleans stale users (RS-007). Single-instance only. No TTL.

**Action**:
1. Add Valkey to Docker Compose / deployment config
2. Create `src/services/valkey.service.ts` — connection pool, typed helpers
3. Migrate presence from in-memory Map to Valkey with 30s TTL auto-expiry
4. Add rate limiting for webhook endpoints and SSE connections
5. Add session state cache (reduce SQLite reads for hot sessions)
6. Add agent status cache

**Valkey key patterns**:
```
presence:{sessionId}:{userId}     TTL: 30s   → { displayName, cursor, lastSeen }
ratelimit:webhook:{ip}            TTL: 60s   → counter (max 60/min)
ratelimit:sse:{userId}            TTL: 300s  → counter (max 20 connections)
cache:session:{sessionId}:state   TTL: 60s   → { status, agentId, ... }
cache:agent:{agentId}:status      TTL: 10s   → { status, currentTurn, ... }
```

**Success criteria**: Stale presence auto-expires after 30s. Rate limiting enforced. Works across multiple API instances.

**Files**:
- New: `src/services/valkey.service.ts`
- `src/services/session/session-presence.service.ts` (replace in-memory Map)
- `docker/docker-compose.yml` (add valkey)

---

### P2-3: Caddy SSE Authentication

| Attribute | Detail |
|-----------|--------|
| **Priority** | P2 — Medium |
| **Effort** | Medium (3-5 days) |
| **Solves** | Unauthenticated SSE endpoints RS-019 |
| **Dependencies** | None |
| **Risk** | Medium — affects all SSE consumers |

**Problem**: Caddy `durable_streams` handler matches `/v1/stream/*` with no authentication. Anyone who reaches Caddy port can subscribe to any stream.

**Action — Option A (Network isolation)**:
1. Restrict Caddy port to internal network only in production (firewall/Docker network)
2. All SSE traffic routed through API server reverse proxy with auth check
3. Simplest approach, no Caddy config changes

**Action — Option B (JWT validation in Caddy)**:
1. Add `caddy-jwt` plugin or custom middleware to validate bearer tokens
2. Extract team/session scope from token claims
3. Reject subscriptions to streams outside user's scope

**Recommendation**: Option A for immediate fix, Option B for long-term.

**Success criteria**: No unauthenticated access to event streams in production.

**Files**:
- `Caddyfile` (auth middleware or network restriction)
- `docker/docker-compose.yml` (network config)
- Potentially: API server reverse proxy for streams

---

### P2-4: Event Schema Normalization

| Attribute | Detail |
|-----------|--------|
| **Priority** | P2 — Medium |
| **Effort** | Large (1-2 weeks) |
| **Solves** | Inconsistent naming RS-005, schema divergence RS-004, no event versioning |
| **Dependencies** | P1-1, P1-2 (outbox + unified bus provide single publish point for migration) |
| **Risk** | High — touches all 48 event types, all producers and consumers |

**Problem**: Inconsistent event naming (colons, hyphens, underscores mixed). Two disconnected schema systems. No event versioning.

**Action**:
1. Define hierarchical naming convention (see hybrid-architecture.md Section 7.1)
2. Create mapping layer: old names → new names (backward compat)
3. Wrap lifecycle events in CloudEvents v1.0 envelope
4. Add delta/done pairing for all streaming content
5. Add `schema_version` field to all events
6. Reconcile `@durable-streams/state` Zod schemas with `StreamEventMap` types
7. Document all channels with AsyncAPI 3.0

**Migration strategy**: Dual-publish both old and new names for 2 release cycles. Consumers updated to prefer new names. Remove old names after deprecation period.

**Success criteria**: All events follow `io.agentpane.{entity}.{action}` pattern. Lifecycle events have CloudEvents envelope. Streaming events have delta/done pairs. Single source of truth for event schemas.

**Files**:
- `src/services/durable-streams.service.ts` (StreamEventMap rewrite)
- `src/services/session/types.ts` (SessionEventType rewrite)
- `src/lib/agents/event-type-map.ts` (mapping layer)
- `src/lib/integrations/durable-streams/schema.ts` (reconcile)
- All event producers (stream-handler, plan-mode, terraform-compose, container-agent, etc.)
- All event consumers (use-session, use-plan-session, use-topology-stream, etc.)
- New: `specs/events_review/asyncapi.yaml`

---

### P2-5: Gap Detection on Client Reconnect

| Attribute | Detail |
|-----------|--------|
| **Priority** | P2 — Medium |
| **Effort** | Medium (3-5 days) |
| **Solves** | No gap detection RS-006, events lost during disconnect |
| **Dependencies** | None |
| **Risk** | Medium |

**Problem**: `useSession` appends events on each callback. On reconnect, no mechanism detects missed events. Events lost during JS GC pause or tab backgrounding are silently gone.

**Action**:
1. Track last processed offset in `useSession` state
2. On reconnect, compare last offset with stream's current offset
3. If gap detected, fetch missing events from REST API `/api/sessions/:id/events?offset=X&limit=Y`
4. Merge fetched events into client state, deduplicating by offset
5. Follow pattern from `useTaskActivity` which already fetches historical data on mount

**Success criteria**: No silent event loss on reconnect. Client state complete after network interruption.

**Files**:
- `src/app/hooks/use-session.ts`
- `src/lib/streams/client.ts`

---

## Phase 3: Durability — Durable Execution & HA

### P3-1: Litestream for SQLite Disaster Recovery

| Attribute | Detail |
|-----------|--------|
| **Priority** | P3 — Low (High if production-deployed) |
| **Effort** | Small (1-2 days) |
| **Solves** | Single point of failure for SQLite event store |
| **Dependencies** | None |
| **Risk** | Low — sidecar process, no code changes |
| **New infra** | Litestream binary, S3 bucket (or NATS JetStream target) |

**Problem**: Single SQLite file is a single point of failure. No backup, no disaster recovery.

**Action**:
1. Add Litestream v0.5 as sidecar in Docker Compose
2. Configure continuous WAL replication to S3 (or NATS JetStream if P2-1 deployed)
3. Configure LTX compaction: L1 (30s), L2 (5 min)
4. Document restore procedure
5. Test point-in-time recovery

**Success criteria**: Continuous backup. Sub-minute RPO. Documented restore procedure tested.

**Files**:
- New: `docker/litestream.yml` (config)
- `docker/docker-compose.yml` (add litestream sidecar)

---

### P3-2: Durable Execution for Agent Lifecycle

| Attribute | Detail |
|-----------|--------|
| **Priority** | P3 — Low |
| **Effort** | Large (3-4 weeks) |
| **Solves** | Agent execution lost on process restart, no automatic retry for LLM failures |
| **Dependencies** | P2-1 (NATS, for event routing) |
| **Risk** | High — fundamental change to agent execution model |
| **New infra** | Inngest (self-hosted) or Restate |
| **Trigger** | When agent reliability complaints exceed threshold |

**Problem**: If the Bun process crashes during agent execution, the entire session is lost. LLM rate limits or network failures require manual restart.

**Action (Inngest path)**:
1. Deploy Inngest self-hosted (Apache 2.0)
2. Wrap agent execution pipeline in Inngest function with steps:
   - `step.run("planning")` → agent planning phase
   - `step.waitForEvent("plan-approval")` → human approval
   - `step.run("execution")` → agent execution phase
   - `step.run("completion")` → task state transition
3. Each step checkpointed — no re-execution on restart
4. Automatic retry with configurable backoff for transient LLM failures

**Success criteria**: Agent execution survives process restarts. Plan approval is a native durable wait. Automatic retry for rate limits.

**Files**:
- New: `src/services/durable-agent-workflow.ts`
- `src/services/agent/agent-execution.service.ts` (refactor to use Inngest)
- `docker/docker-compose.yml` (add Inngest)

---

### P3-3: Edge Event Processing in Containers

| Attribute | Detail |
|-----------|--------|
| **Priority** | P3 — Low |
| **Effort** | Medium (1-2 weeks) |
| **Solves** | No stall detection, no intelligent batching in containers |
| **Dependencies** | None |
| **Risk** | Low — isolated to agent-runner |
| **Trigger** | When team mode with 5+ concurrent agents creates event flooding |

**Problem**: Container agents forward every event individually. No local intelligence for stall detection, rate monitoring, or batch optimization.

**Action**:
1. Add `EdgeCEP` class to `agent-runner/src/event-emitter.ts`
2. Stall detection: no output >30s → emit `agent.stall`
3. Rate warning: >5 tool calls/sec → emit `agent.rate_warning`
4. Tool degradation: 3+ consecutive tool errors → emit `agent.tool.degradation`
5. Token batching: accumulate 10 tokens into single batch event
6. Local buffer in tmpfs for disconnect resilience

**Success criteria**: Stall/rate/degradation alerts surfaced to UI. Token event volume reduced 10x at container boundary.

**Files**:
- `agent-runner/src/event-emitter.ts`
- `agent-runner/src/index.ts`

---

### P3-4: CQRS Snapshots for Long Sessions

| Attribute | Detail |
|-----------|--------|
| **Priority** | P3 — Low |
| **Effort** | Medium (1 week) |
| **Solves** | Full event replay degradation for long sessions |
| **Dependencies** | None |
| **Risk** | Low |
| **Trigger** | When sessions routinely exceed 5,000+ events |

**Problem**: Loading a session requires replaying all events from offset 0. At 10,000+ events, this causes visible load latency.

**Action**:
1. Create `session_snapshots` table (schema in hybrid-architecture.md Section 5, Phase 3.5)
2. Snapshot every 1,000 events or on agent phase transitions
3. On session load: read latest snapshot + events since snapshot offset
4. Snapshot contains: agent status, accumulated text, tool history, turn count

**Success criteria**: Session load time constant regardless of event count. Snapshots created automatically.

**Files**:
- New: `src/db/schema/sqlite/session-snapshots.ts`
- `src/services/session/session-stream.service.ts`
- `src/app/hooks/use-session.ts` (load from snapshot + delta)

---

### P3-5: Turso/libSQL Migration for Concurrent Writes

| Attribute | Detail |
|-----------|--------|
| **Priority** | P3 — Low |
| **Effort** | Large (2-3 weeks) |
| **Solves** | SQLite single-writer bottleneck (Issue 2.2), ~5-10 concurrent agent ceiling |
| **Dependencies** | P0-3 (batching reduces write pressure, may defer this need) |
| **Risk** | High — database layer change |
| **Trigger** | When concurrent agents routinely exceed 10 and write contention is measurable |

**Problem**: SQLite's single-writer lock serializes all event writes. With 5+ concurrent agents each producing 100-500 events/min, this becomes the bottleneck.

**Action**:
1. Evaluate Turso/libSQL Rust rewrite stability (check release notes, issues)
2. Swap `better-sqlite3` for `@libsql/client` in Drizzle config
3. Enable `BEGIN CONCURRENT` for MVCC concurrent writes
4. Test with 10+ concurrent agent simulations
5. Consider embedded replicas for agent-runner read access

**Success criteria**: 20+ concurrent agents writing events without contention. Drizzle ORM unchanged.

**Files**:
- `drizzle.config.ts`
- `src/db/index.ts`
- `package.json` (swap driver)

---

## Dependency Graph

```
P0-1  Drop accumulated ─────────┐
                                 ▼
P0-2  Event retention       P0-3  Chunk batching
                                 │
                                 ▼
                            P1-1  Transactional outbox
                                 │
                                 ▼
P1-4  Truncation warning    P1-2  Unified event bus
                                 │
P1-5  Webhook DLQ               ▼
                            P1-3  SSE connection limits
P1-6  Producer pool LRU
                                 │
          ┌──────────────────────┼──────────────────────┐
          ▼                      ▼                      ▼
     P2-1  NATS JetStream   P2-2  Valkey           P2-3  Caddy auth
          │                                              │
          ▼                                              ▼
     P2-4  Schema normalization                    P2-5  Gap detection
          │
          ├──────────────────────┬──────────────────────┐
          ▼                      ▼                      ▼
     P3-1  Litestream       P3-2  Durable execution P3-3  Edge CEP
                                                         │
                            P3-4  CQRS snapshots    P3-5  Turso/libSQL
```

---

## Quick Wins — Do This Week

These items are independent, low-risk, and deliver immediate value:

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 1 | **P0-1**: Drop `accumulated` from chunks | 1-2 hours | ~80% storage reduction per session |
| 2 | **P0-2**: Event retention cleanup job | 2-4 hours | Bounded storage growth |
| 3 | **P1-4**: Truncation warning banner | 1-2 hours | No more silent data loss |
| 4 | **P1-6**: Producer pool LRU eviction | 2-4 hours | Bounded memory growth |

Total: ~1 day of work for 4 significant improvements.

---

## Milestone Checkpoints

### Milestone 1: "Reliable Foundation" (End of Phase 1)

- [ ] Chunk events carry only delta (no accumulated)
- [ ] Event retention job running automatically
- [ ] All events flow through transactional outbox
- [ ] Single unified event bus replaces 3 SSE subsystems
- [ ] SSE connection limit raised to 200 with graceful degradation
- [ ] Webhook DLQ with automatic retry
- [ ] Producer pool bounded with LRU eviction
- [ ] Truncation warning visible in UI

**Validation**: Run 5 concurrent agents for 1 hour. Verify: no storage bloat, no lost events, outbox relay healthy, DLQ empty for clean webhooks.

### Milestone 2: "Horizontally Scalable" (End of Phase 2)

- [ ] NATS JetStream running as sidecar
- [ ] Events routed through NATS with SSE bridge to Caddy
- [ ] Valkey handles presence with auto-expiry
- [ ] Caddy SSE authenticated
- [ ] Events follow hierarchical naming with CloudEvents envelope
- [ ] Client reconnects without gap

**Validation**: Run 2 API server instances behind load balancer. Verify: events from either instance reach all connected browsers, presence shared across instances, no auth bypass.

### Milestone 3: "Production Resilient" (End of Phase 3)

- [ ] Litestream replicating SQLite to S3
- [ ] Agent execution survives process restart
- [ ] Edge CEP detecting stalls and rate issues
- [ ] Long sessions load from snapshot
- [ ] Concurrent write support (if needed)

**Validation**: Kill Bun process mid-agent-execution. Verify: agent resumes from checkpoint, no lost work, SQLite restorable from S3.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| NATS Jepsen durability issues | Medium | High | SQLite remains source of truth; NATS is routing only; `sync: always` configured |
| Outbox relay latency adds UI delay | Low | Medium | 50ms poll interval; direct Caddy SSE path still available as fallback |
| Schema migration breaks existing clients | Medium | High | Dual-publish old+new names for 2 release cycles; mapping layer |
| Valkey becomes single point of failure | Low | Medium | Presence degrades to in-memory fallback; cache misses fall through to SQLite |
| Inngest/Restate vendor lock-in | Medium | Medium | Wrap in service interface; agent execution logic stays in AgentPane code |
| Turso/libSQL Rust rewrite instability | Medium | High | Don't adopt until stable release; batch improvements (P0-3) defer the need |

---

## Cross-References

| Document | Relationship |
|----------|-------------|
| [Events System Architecture Review](./README.md) | RS-* findings that drive priorities |
| [Hybrid Architecture Evolution](./hybrid-architecture.md) | Full technology evaluation, pattern catalog, architecture design |
| [Durable Sessions Integration](../application/integrations/durable-sessions.md) | Current Durable Streams implementation |
| [Event Service](../application/services/event-service.md) | Webhook event processing pipeline |
| [Architecture Review: Streaming](../reviews/2026-03-architecture/06-realtime-streaming-events.md) | Detailed RS-001 through RS-019 findings |
