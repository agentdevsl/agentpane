# Performance & Scalability Assessment

## Current Architecture

AgentPane runs as a **single Bun process** serving both API (Hono on port 3001) and frontend (Vite dev / static assets). Real-time event delivery is split across three independent systems:

1. **DurableStreamsService** -- typed events persisted to SQLite then published to Caddy's LMDB-backed SSE streams at `/v1/stream/*`
2. **EventBus** -- in-process pub/sub for general UI updates via SSE at `/api/events`
3. **CliMonitorService** -- dedicated in-process SSE stream for CLI monitor daemon data

SQLite with WAL mode is the default database. PostgreSQL is supported via `DB_MODE=postgres`. Agent execution spawns Claude SDK sessions inside Docker/K8s/Nomad containers, with output bridged back via stdout JSON lines or AgentCore SSE.

---

## Memory Management

### Bounded In-Memory Collections (Good)

Several in-memory caches have proper eviction and cleanup:

| Collection | Location | Bound | Eviction |
|---|---|---|---|
| Caddy producers | `caddy-producer.ts` | MAX_PRODUCERS=200 | LRU + 5min idle timeout (RS-001) |
| CLI monitor sessions | `cli-monitor.service.ts` | MAX_SESSIONS=10,000 | LRU eviction on overflow + 7-day retention |
| Terraform compose sessions | `terraform-compose.service.ts` | MAX_SESSIONS=100 | 30min TTL + LRU overflow eviction |
| Pending plans | `sandbox-state.ts` | TTL-based | 1hr TTL, 5min cleanup sweep |
| Task creation sessions | `task-creation.service.ts` | TTL-based | 30min idle timeout, 5min cleanup sweep |
| Rate limiter entries | `rate-limiter.ts` | TTL-based | 60s cleanup interval (`unref()`'d) |

### Potential Memory Growth Concerns

**P1: Presence store has no upper bound on session count**
- Location: `src/services/session/session-presence.service.ts:36`
- The `presenceStore` is a `Map<sessionId, Map<userId, ActiveUser>>` with no cap on the number of tracked sessions. Individual users within sessions are swept after 30 minutes of inactivity, and empty session maps are deleted. However, if sessions are never explicitly closed, the outer map grows without limit. Each entry is small (~200 bytes), but over weeks/months with thousands of sessions, this could accumulate.
- **Risk**: Low in typical usage; medium in production with many concurrent sessions over long uptime.
- **Fix**: Add a maximum session count (e.g., 5,000) with LRU eviction, or periodically sweep sessions that have been empty or have only stale users for >1 hour.

**P2: Agent execution tool hooks maps (`preToolHooks`, `postToolHooks`) never cleaned up**
- Location: `src/services/agent/agent-execution.service.ts:68-69`
- These `Map<string, Hook[]>` collections are populated per agent but never pruned after agent completion. If hooks are registered per-agent, they accumulate over the process lifetime.
- **Risk**: Low -- hooks appear to be registered globally, not per-agent. Verify.

**P3: `runningAgents` Map in `AgentExecutionService` retains AbortControllers**
- Location: `src/services/agent/agent-execution.service.ts:67`
- AbortControllers are stored for running agents. The code removes them on completion/error, but if an agent crashes without calling the completion handler, the entry persists. The timeout handle in `AgentCoreBridgeService` (2h default) provides a safety net, but the local `AgentExecutionService` map has no equivalent timeout.
- **Risk**: Medium -- orphaned entries hold AbortController references but no large buffers.
- **Fix**: Add a periodic sweep (e.g., every 10 minutes) that removes entries older than `maxRuntimeMs`.

**P4: Rate limiter stores grow per-unique-IP**
- Location: `src/lib/api/rate-limiter.ts:38-55`
- All rate limiter instances share a single cleanup interval. Entries are cleaned when `resetAt <= now`, but between cleanup sweeps (60s), an attacker rotating source IPs could create many entries. The 60s window and small entry size (~100 bytes each) limit the practical impact.
- **Risk**: Low under normal conditions; could be used for memory exhaustion in a DDoS scenario (no IP-diversity cap).

### Timer Cleanup (Good)

All significant intervals are properly registered with the `GracefulShutdown` handler in `server-bootstrap.ts`:

- Session presence cleanup timer
- CLI monitor heartbeat and maintenance timers
- Sandbox controller status sync and warm pool sync timers
- K8s/Nomad heal intervals
- Event cleanup scheduler
- Template/Terraform sync schedulers
- Dream scheduler
- Task creation session cleanup interval
- Rate limiter interval (`unref()`'d -- will not prevent process exit)
- Caddy producer cleanup interval (`unref()`'d)

**P5: TaskCreationService cleanup interval not registered with shutdown handler**
- Location: `src/services/task-creation.service.ts:214`
- The `cleanupInterval` is created in the constructor but there is no `destroy()` method and no registration with `GracefulShutdown`. This is a minor leak -- the interval will be cleared on process exit, but for clean shutdown semantics it should be stopped.

---

## Connection Management

### SSE Connections (Good)

- **EventBus SSE** (`/api/events`): Hard-capped at `MAX_SSE_CONNECTIONS = 50`. Each connection registers a listener and ping interval. Both are properly cleaned up via a `cleanup()` closure on `cancel()` and on send/ping errors.
- **Durable Streams SSE**: Managed by Caddy externally. The Bun server does not hold client SSE connections for durable streams -- clients connect directly to Caddy at `/v1/stream/*`.
- **CLI Monitor SSE** (`/api/cli-monitor/stream`): Has its own `localSubscribers` set. No explicit connection limit is documented, but the subscriber pattern is simple (Set-based with cleanup on error).

### Database Connections

- **SQLite**: Single `better-sqlite3` instance shared across the process. Synchronous API means no connection pool needed. WAL mode enables concurrent readers. Only one writer at a time (see Database Performance).
- **PostgreSQL**: Single `postgres` client instance via `postgres()` constructor. No connection pool size is configured -- the `postgres` library defaults to 10 connections. This is adequate for single-instance but may need tuning under load.

### Docker/K8s Connections

- **Docker**: Single `dockerode` client instance per `DockerProvider`. No connection pooling -- each API call opens/closes a connection to the Docker socket.
- **Container exec streams**: Properly cleaned up in `stopAgent()` via `execResult.kill()`, bridge `stop()`, and sentinel file removal.

---

## Database Performance

### Write Contention (Key Concern)

**SQLite WAL mode is correctly enabled** in both `db/client.ts` and `lib/bootstrap/phases/sqlite.ts`. WAL allows concurrent reads during writes, which is the right configuration.

**P6: DurableStreamsService `persistToDb` has a retry loop for offset collisions**
- Location: `src/services/durable-streams.service.ts:579-621`
- Each publish does a `findFirst` (to get max offset) then an `insert` (with the computed next offset). Under high event throughput from multiple concurrent agents, this read-then-write pattern creates contention and can trigger the retry loop up to 5 times. Each retry re-queries for the max offset.
- **Impact**: With 5+ concurrent agents streaming tokens, this could become a bottleneck. The `uniqueIndex('session_events_unique_offset')` constraint is correctly used to detect collisions, but the retry approach is O(n) in contention.
- **Fix**: Use a single `INSERT INTO session_events (...) VALUES (..., (SELECT COALESCE(MAX(offset), -1) + 1 FROM session_events WHERE session_id = ?), ...)` atomic subquery to compute and insert in one statement. Or use SQLite's `RETURNING` to avoid the read entirely.

**P7: ChunkBatcher reduces write pressure effectively**
- Location: `src/lib/agents/chunk-batcher.ts`
- Token deltas are batched (default: flush every 100ms or 10 deltas) and written as a single row. Real-time delivery goes directly to Caddy SSE without touching the database. This is a well-designed split-path optimization.

**P8: Event cleanup service does batched deletes (Good)**
- Location: `src/services/event-cleanup.service.ts:67-90`
- Deletes in `BATCH_SIZE = 1000` row chunks to avoid long-held locks. Configurable retention (30 days for session events, 90 days for event log).

### Indexing (Good)

Key indexes are present:

| Table | Index | Columns |
|---|---|---|
| `session_events` | `session_events_session_idx` | `sessionId` |
| `session_events` | `session_events_unique_offset` | `sessionId, offset` (unique) |
| `session_events` | `session_events_created_at_idx` | `createdAt` |
| `tasks` | `idx_tasks_agent_id` | `agentId` |
| `tasks` | `idx_tasks_kanban` | `codespaceId, column, position` |

**P9: Missing index on `session_events.type`**
- Queries that filter by event type (e.g., fetching all `chunk` events for a session) would benefit from a composite index on `(sessionId, type)`. Currently only `sessionId` is indexed alone.

### N+1 Query Patterns (Mostly Fixed)

The codespace service explicitly documents and fixes N+1 patterns with batch queries (comment: `fixes N+1` at line 234 of `codespace.service.ts`). Tasks, agents, and codespaces are fetched in batch `findMany` calls and grouped in-memory.

**P10: Worktree prune loop does sequential `remove()` calls**
- Location: `src/services/worktree.service.ts:372-386`
- Each stale worktree calls `this.remove(worktreeId)` sequentially, which involves a database query + git operations. This is acceptable because worktree pruning is a background admin operation, not a hot path.

---

## Streaming Performance

### Token Streaming Architecture (Well-Designed)

The dual-path architecture is well-optimized:

1. **Real-time path**: Token deltas go directly to Caddy SSE via `publishRealtime()` -- no database write, no SQLite lock contention.
2. **Persistence path**: Batched token chunks are written to SQLite via `persistEvent()` at 100ms intervals for replay/catch-up after reconnection.

### Backpressure

**P11: No backpressure mechanism between agent output and stream publish**
- The container bridge (`container-bridge.ts`) processes stdout lines in a `for await...of` loop, calling `publishEvent()` for each line. If the Caddy producer's in-flight limit (`maxInFlight: 5`) is reached, the `IdempotentProducer.append()` call is fire-and-forget -- it lingers and batches but does not apply backpressure to the readline loop.
- The `ChunkBatcher` similarly does not block on SQLite writes -- it buffers and catches errors but does not slow down the producer.
- **Risk**: Under extreme agent output rates, memory usage could spike from buffered but unwritten data. Practical risk is low because Claude SDK output is human-readable text, not high-throughput binary.

### Reconnection

- **Durable Streams Client** (`lib/streams/client.ts`): Implements exponential backoff with `MAX_RECONNECT_ATTEMPTS = 8`, max delay 30s. Fatal error codes (NOT_FOUND, UNAUTHORIZED, etc.) halt reconnection.
- **Event Stream Hook** (`hooks/use-event-stream.ts`): Exponential backoff up to 30s, max 10 retries. Proper cleanup of EventSource and retry timeout on unmount.
- **Caddy SSE** (`Caddyfile`): `sse_reconnect_interval 120s` -- clients will reconnect every 2 minutes if the connection drops. `long_poll_timeout 30s` for fallback clients.

---

## Horizontal Scaling Blockers

### Critical Blockers

**B1: In-memory rate limiter (documented as AR-031)**
- Each instance maintains its own counters. With N instances, effective rate limit is N * configured limit. The code explicitly documents this and suggests Redis-backed replacement.

**B2: In-memory state maps in SandboxStateManager**
- `runningAgents`, `runningAgentCoreAgents`, `pendingPlans`, `startingAgents` are all process-local. An agent started on instance A cannot be stopped from instance B. Plans approved on one instance cannot be matched to the pending plan on another.
- **Impact**: Must use sticky sessions or a shared state store (Redis) for multi-instance deployment.

**B3: In-memory presence tracking**
- `SessionPresenceService.presenceStore` is process-local. Users on different instances won't see each other's presence.

**B4: EventBus is process-local**
- `publishEventToStream()` only reaches SSE listeners on the same process. For multi-instance, a pub/sub broker (Redis Pub/Sub, NATS) would be needed.

**B5: CLI Monitor sessions are process-local**
- The daemon connects to a single instance. Other instances won't have session data.

**B6: SQLite is single-file, single-writer**
- WAL mode allows concurrent reads but only one writer. Multiple instances writing to the same SQLite file would cause contention and potential corruption. PostgreSQL mode (`DB_MODE=postgres`) removes this blocker.

### Non-Blockers (Already Handled)

- **Caddy Durable Streams**: Caddy can be scaled independently with LMDB-backed persistence. Clients connect directly to Caddy, not through the Bun process.
- **Agent execution**: Agents run in Docker/K8s containers and are decoupled from the API process (except for the in-memory state tracking in B2).

---

## Quick Wins

### QW-1: Add `busy_timeout` pragma to SQLite (Effort: 1 hour) -- ✅ DONE

SQLite returns `SQLITE_BUSY` immediately when it cannot acquire the write lock. Adding `sqlite.pragma('busy_timeout = 5000')` makes it wait up to 5 seconds before failing, dramatically reducing write contention errors under concurrent agent load.

**Files**: `src/db/client.ts:76`, `src/lib/bootstrap/phases/sqlite.ts:42`

```typescript
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000'); // Wait up to 5s for write lock
```

### QW-2: Atomic offset computation in DurableStreamsService (Effort: 2 hours) -- ✅ DONE

Replace the read-then-write retry loop with a single atomic INSERT:

```sql
INSERT INTO session_events (id, session_id, offset, type, channel, data, timestamp)
VALUES (?, ?, (SELECT COALESCE(MAX(offset), -1) + 1 FROM session_events WHERE session_id = ?), ?, ?, ?, ?)
```

This eliminates the retry loop and reduces write contention from O(retries) to O(1).

**File**: `src/services/durable-streams.service.ts:579-621`

### QW-3: Add TaskCreationService destroy method (Effort: 30 minutes) -- ✅ DONE (already existed, now registered with shutdown)

Add a `destroy()` method to clear the cleanup interval and register it with the shutdown handler:

```typescript
destroy(): void {
  if (this.cleanupInterval) {
    clearInterval(this.cleanupInterval);
    this.cleanupInterval = null;
  }
}
```

Register in `server-bootstrap.ts` alongside other service cleanup registrations.

**Files**: `src/services/task-creation.service.ts`, `src/server/bootstrap/server-bootstrap.ts`

### QW-4: Cap presence store sessions (Effort: 1 hour) -- ✅ DONE

Add a maximum tracked session count (e.g., 5,000) to `SessionPresenceService`. When exceeded, evict sessions with the oldest `lastSeen` timestamps.

**File**: `src/services/session/session-presence.service.ts`

### QW-5: Add composite index on session_events(session_id, type) (Effort: 30 minutes) -- ✅ DONE

If event queries filter by type within a session, this composite index avoids scanning all events for the session.

**File**: `src/db/schema/sqlite/session-events.ts`

### QW-6: Enable Gzip compression for API responses (Effort: 1 hour)

The Caddyfile enables `encode gzip br` for static files but API responses from the Bun reverse proxy are not compressed. For large JSON payloads (session event lists, task lists), compression can reduce transfer sizes by 60-80%.

Add compression middleware to the Hono app, or configure Caddy to compress proxied responses:

```
handle /api/* {
  reverse_proxy localhost:3001 {
    flush_interval -1
  }
  encode gzip br
}
```

**File**: `Caddyfile:42`

---

## Recommendations

Ordered by priority (impact vs effort):

| # | Recommendation | Effort | Impact | Priority | Status |
|---|---|---|---|---|---|
| 1 | **Add `busy_timeout` pragma** -- prevents SQLITE_BUSY errors under concurrent writes | 1h | High | P0 -- do before any multi-agent testing | ✅ Done |
| 2 | **Atomic offset insert** -- eliminates retry loop and contention in hot path | 2h | High | P0 -- required for concurrent agents | ✅ Done |
| 3 | **Add TaskCreationService.destroy()** -- clean shutdown hygiene | 30m | Low | P1 -- quick fix | ✅ Done |
| 4 | **Cap presence store** -- prevent unbounded Map growth | 1h | Medium | P1 -- production hygiene | ✅ Done |
| 5 | **Add session_events(session_id, type) index** | 30m | Medium | P1 -- query optimization | ✅ Done |
| 6 | **Compress API responses** via Caddy or Hono middleware | 1h | Medium | P1 -- bandwidth savings | |
| 7 | **Add orphaned agent sweep** to AgentExecutionService | 2h | Medium | P2 -- safety net | ✅ Done |
| 8 | **Replace in-memory rate limiter** with Redis for multi-instance | 4h | High | P2 -- required for horizontal scaling | |
| 9 | **Externalize agent state** (runningAgents, pendingPlans) to Redis | 2-3d | High | P2 -- required for horizontal scaling | |
| 10 | **Externalize presence** to Redis Pub/Sub | 1d | Medium | P2 -- required for horizontal scaling | |
| 11 | **Configure PostgreSQL connection pool size** for production | 1h | Medium | P2 -- needed when using PG mode | |
| 12 | **Add SSE connection limit** to CLI monitor endpoint | 1h | Low | P3 -- hardening | |
| 13 | **Add backpressure** to container bridge readline loop | 4h | Low | P3 -- edge case protection | |
| 14 | **Add IP-diversity cap** to rate limiter | 2h | Low | P3 -- DDoS mitigation | |

### Architecture Notes

The current single-process architecture is **appropriate for the product stage** (single-tenant, self-hosted). The codebase is well-structured for future horizontal scaling:

- Clean separation between Caddy (SSE) and Bun (API) means SSE can scale independently
- PostgreSQL mode removes the SQLite single-writer bottleneck
- Agent execution is already decoupled into containers
- The `DurableStreamsService` persists before publishing, ensuring event durability on reconnect
- Graceful shutdown is comprehensive with LIFO cleanup ordering

The primary scaling path is: (1) SQLite `busy_timeout` + atomic offset for single-instance reliability, (2) switch to PostgreSQL for write scalability, (3) add Redis for shared state to enable multi-instance deployment.
