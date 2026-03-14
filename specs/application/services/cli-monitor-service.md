# CLI Monitor Service

Monitor all Claude Code CLI sessions running on your machine from a single dashboard. An external daemon (`@agentpane/cli-monitor`) watches `~/.claude/projects/` for JSONL session logs, parses them incrementally, and pushes session state to the AgentPane server, which fans out to browsers via SSE.

---

## Architecture Overview

```
~/.claude/projects/                          Host filesystem
    |
    |  chokidar (recursive watch **/*.jsonl)
    v
+------------------------------------------+
|  @agentpane/cli-monitor (npx)            |  External daemon process
|  +--------------------------------------+|
|  |  FileWatcher   (chokidar, debounce)  ||  watches JSONL files
|  |  JSONLParser    (incremental tail)   ||  extracts session state
|  |  SessionStore   (Map, LRU 1K max)   ||  in-memory session cache
|  |  AgentPaneClient (HTTP, circuit brk) ||  pushes to server
|  +--------------------------------------+|
+------------------------------------------+
               |
               |  POST /api/cli-monitor/register     (on start)
               |  POST /api/cli-monitor/heartbeat    (every 10s)
               |  POST /api/cli-monitor/ingest       (batched every 500ms)
               |  POST /api/cli-monitor/deregister   (on stop)
               v
+------------------------------------------+
|  AgentPane Server (Hono)                 |  Receives + fans out
|  +--------------------------------------+|
|  |  CliMonitorService                   ||  in-memory + SQLite cache
|  |  DurableStreamsServer / local subs    ||  SSE event bus
|  +--------------------------------------+|
|                                          |
|  GET /api/cli-monitor/status             |  daemon connection check
|  GET /api/cli-monitor/sessions           |  paginated session list
|  GET /api/cli-monitor/history            |  historical DB query
|  GET /api/cli-monitor/topology           |  agent topology graph
|  GET /api/cli-monitor/stream   --> SSE   |  real-time event stream
+------------------------------------------+
               |
               |  EventSource
               v
+------------------------------------------+
|  /cli-monitor page (React)              |  Browser
|  +--------------------------------------+|
|  |  useCliMonitorState hook             ||  SSE subscription
|  |  Install / Waiting / Active states   ||  auto-transitions
|  |  Session cards + detail panel        ||  keyboard nav
|  |  Alert toasts                        ||  status notifications
|  +--------------------------------------+|
+------------------------------------------+
```

### Design Decisions

1. **External daemon, not in-process** -- The file watcher runs as a separate process (`npx @agentpane/cli-monitor`), not inside the AgentPane server. This provides zero coupling and independent lifecycle.

2. **Push model** -- The daemon pushes batched session updates every 500ms via `POST /ingest`. The server fans out to browsers via SSE. The server never needs filesystem access.

3. **Hybrid persistence** -- In-memory Map for real-time state, with optional SQLite persistence for historical queries. Sessions survive daemon restarts via re-scan from disk; they survive server restarts via the database.

4. **Terminal-first install** -- Users run `npx @agentpane/cli-monitor`. The UI auto-detects daemon connection by polling `/status` every 3 seconds.

---

## NPM Package: `@agentpane/cli-monitor`

**Location:** `packages/cli-monitor/`

**Version:** 0.2.1 (published as `@agentpane/cli-monitor` with public access)

### Installation

```bash
npx @agentpane/cli-monitor            # One-shot (recommended)
npm i -g @agentpane/cli-monitor       # Global install
brew install agentpane/tap/cli-monitor # Homebrew (macOS)
```

### CLI Commands

```
cli-monitor start [--port 3001] [--path ~/.claude/projects] [--retention 7] [--daemon]
cli-monitor stop  [--port 3001]
cli-monitor status [--port 3001]
cli-monitor version
cli-monitor help
```

### Module Map

| Module | File | Responsibility |
|--------|------|----------------|
| CLI entry | `src/index.ts` | Argument parsing, command routing |
| Daemon | `src/daemon.ts` | Process lifecycle, PID locking, signal handling, heartbeat + ingest timers |
| FileWatcher | `src/watcher.ts` | chokidar file watching, debounced processing, symlink resolution, path containment |
| Parser | `src/parser.ts` | JSONL line parsing, status derivation, token accumulation, topology tracking |
| SessionStore | `src/session-store.ts` | In-memory Map with LRU eviction (1K max), change tracking, idle management, topology graph |
| AgentPaneClient | `src/agentpane-client.ts` | HTTP client with circuit breaker pattern (5 failures -> 60s open) |
| Logger | `src/logger.ts` | Structured JSON logging with `LOG_LEVEL` env |
| Display | `src/display.ts` | Terminal status box, colored output (TTY-aware) |
| Utils | `src/utils.ts` | `createId()` -- 8-char hex ID via `crypto.getRandomValues()` |
| Version | `src/version.ts` | `PKG_VERSION` injected at build time |

### Dependencies

One production dependency: `chokidar` (^5.0.0). Dev: `@types/bun`.

### Build

```bash
bun run build          # Standalone binary (current platform)
bun run build:js       # Node.js module (dist/index.js)
bun run build:all      # Cross-platform binaries (darwin-arm64, darwin-x64, linux-x64)
```

---

## Daemon Process Lifecycle

### Startup

1. If `--daemon` flag: spawn detached child process, exit parent
2. Generate `daemonId = "dm_{createId()}"`
3. Acquire PID lock (`~/.claude/.cli-monitor.lock`)
4. Register with AgentPane (`POST /register`) with exponential backoff retry (1s -> 30s cap)
5. Scan existing JSONL files in watch directory
6. Start chokidar watcher
7. Start heartbeat timer (10s), ingest timer (500ms)

### Shutdown

Triggered by SIGINT, SIGTERM, SIGHUP, uncaughtException, or unhandledRejection:
1. Clear all timers
2. Close file watcher
3. Deregister from AgentPane (`POST /deregister`)
4. Release PID lock
5. Force exit after 5s timeout

### Heartbeat Recovery

If the server responds with `409 REREGISTER`, the daemon re-registers and triggers a full session re-sync via `store.markAllChanged()`.

---

## JSONL Parsing

### Watched Files

Path format: `~/.claude/projects/{projectHash}/{sessionId}.jsonl`

Claude Code writes one JSON object per line (append-only). The daemon tail-reads from a stored byte offset.

### Event Types

| Type | Description |
|------|-------------|
| `user` | User message (prompt or tool result) |
| `assistant` | Claude response (text, thinking, tool use) |
| `system` | System events (permission mode, hook summaries, compaction boundaries, turn duration) |
| `queue-operation` | Queue management |
| `summary` | Session summary (session becomes idle) |
| `progress` | Hook execution progress |
| `file-history-snapshot` | File backup tracking (ignored) |

### Status Derivation

| Condition | Derived Status |
|-----------|---------------|
| Assistant message contains `tool_use` block | `waiting_for_approval` |
| Assistant message contains `text` block (no tool_use) | `working` |
| Assistant message has `stop_reason` (not already waiting_for_approval) | `waiting_for_input` |
| `summary` event received | `idle` |
| No activity for 5 minutes | `idle` (timer-based) |

Priority: `waiting_for_approval` > `working` > `waiting_for_input` > `idle`

### Session Metadata Extraction

| Field | Source |
|-------|--------|
| `sessionId` | `event.sessionId` |
| `projectName` | `path.basename(event.cwd)` |
| `projectHash` | Directory name under `~/.claude/projects/` |
| `gitBranch` | `event.gitBranch` (updated on each event) |
| `goal` | First user message text, truncated to 200 chars |
| `recentOutput` | Last assistant text, truncated to 500 chars |
| `model` | `message.model` on assistant events |
| `isSubagent` | `/subagents/` in path or `agentId` present |
| `parentSessionId` | Extracted from path: `.../sessions/{parentId}/subagents/{id}.jsonl` |
| `slug` | First-write-wins from `event.slug` |
| `permissionMode` | Updated from `event.permissionMode` |

### Token Accumulation

From `message.usage` on assistant events:

```typescript
tokenUsage.inputTokens += usage.input_tokens
tokenUsage.outputTokens += usage.output_tokens
tokenUsage.cacheCreationTokens += usage.cache_creation_input_tokens
tokenUsage.cacheReadTokens += usage.cache_read_input_tokens
tokenUsage.ephemeral5mTokens += usage.cache_creation?.ephemeral_5m_input_tokens
tokenUsage.ephemeral1hTokens += usage.cache_creation?.ephemeral_1h_input_tokens
```

### Performance Metrics

The parser tracks per-turn metrics in a ring buffer (last 10 turns):

- **Cache hit ratio**: `cacheReadTokens / (cacheReadTokens + inputTokens)` across recent turns
- **Context pressure**: `inputTokens / contextWindowLimit` (200K default)
- **Health status**: `healthy` | `warning` | `critical` based on pressure, cache ratio, and compaction count
- **Compaction events**: Tracked from `compact_boundary` and `microcompact_boundary` system events
- **Turn duration**: From `turn_duration` system events, with running average

### Agent Topology

Each session maintains an `AgentTopologyNode` with:
- `agentType` derived via priority cascade: explicit `subagentType` > agentId pattern matching > permission mode > tool usage ratio > structural position > goal keywords > default
- Parent-child relationships via `parentSessionId` and `childSessionIds`
- The `SessionStore` maintains a `childIndex` Map for efficient BFS graph traversal

### Safety Limits

| Concern | Handling |
|---------|----------|
| Lines > 1MB | Skipped |
| Malformed JSON (non-final line) | Skipped |
| Missing sessionId or type | Skipped |
| File truncated | Offset reset |
| Multi-byte UTF-8 split | Continuation bytes (0x80-0xBF) skipped |
| File > 100MB | Read last 100MB chunk |
| Symlink outside watch dir | Rejected by realpath + path containment |
| File outside retention window | Skipped by mtime check |

---

## Server Service Layer

**Location:** `src/services/cli-monitor/cli-monitor.service.ts`

### CliMonitorService

```typescript
class CliMonitorService {
  private static readonly MAX_SESSIONS = 10_000;
  private static readonly MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
  private static readonly DEFAULT_RETENTION_DAYS = 7;

  private sessions: Map<string, CliSession>;
  private daemon: DaemonInfo | null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null;
  private localSubscribers: Set<callback>;
  private localOffset: number;

  constructor(streamsServer: StreamsServer, db?: Database);
}
```

### Methods

| Method | Description |
|--------|-------------|
| `registerDaemon(payload)` | Store daemon info, clear previous daemon's sessions, start heartbeat check, publish `daemon-connected` |
| `handleHeartbeat(daemonId, sessionCount)` | Update `lastHeartbeatAt`, return `'ok'` / `'unknown'` / `'stale'` |
| `deregisterDaemon(daemonId)` | Clear daemon + sessions, stop heartbeat check, publish `daemon-disconnected` |
| `ingestSessions(daemonId, sessions, removedIds)` | Filter stale sessions (>7 days), evict LRU if over limit, update cache, publish events, persist to DB |
| `isDaemonConnected()` | Boolean check |
| `getDaemon()` | Return `DaemonInfo` or null |
| `getSessions()` | Return all sessions filtered by retention window |
| `getSessionCount()` | Return count |
| `getStatus()` | Return `{ connected, daemon, sessionCount }` |
| `getHistoricalSessions(opts?)` | Query SQLite by projectHash, since, limit (max 500) |
| `getTopologyGraph(rootSessionId)` | BFS walk building `AgentTopologyNode[]` from a root session |
| `addRealtimeSubscriber(callback)` | Subscribe to local SSE events, returns unsubscribe function |
| `runMaintenance()` | Delete DB sessions older than retention (configurable via settings) |
| `destroy()` | Clear timers, sessions, subscribers |

### Event Publishing

Dual publishing: events go to the DurableStreamsServer (for Caddy/external consumers) AND to local in-process SSE subscribers (for the built-in SSE route).

### Heartbeat Monitor

- Checked every 15s via `setInterval`
- Timeout threshold: `DAEMON_TIMEOUT_MS * 1.5` (45s with grace period)
- On timeout: auto-deregister daemon, clear all sessions

### DB Persistence

When a `Database` instance is provided:
- `ingestSessions` persists to SQLite asynchronously (fire-and-forget) using upsert on `sessionId`
- JSON fields (`pendingToolUse`, `tokenUsage`, `performanceMetrics`, `topology`, `queueOperations`, `toolInvocations`) are serialized as JSON text
- Maintenance runs on startup and every 10 minutes, deleting sessions older than the configured retention (default 7 days, configurable via `cliMonitor.retentionDays` setting)

---

## API Routes

**Location:** `src/server/routes/cli-monitor.ts`

Mounted at `/api/cli-monitor` when `cliMonitorService` is present. Requires `viewer` role minimum (RBAC).

### Daemon -> Server (4 POST endpoints)

#### `POST /register`

Register daemon with the server.

```json
{
  "daemonId": "dm_a1b2c3d4",
  "pid": 12345,
  "version": "0.2.1",
  "watchPath": "/Users/me/.claude/projects",
  "capabilities": ["watch", "parse", "subagents"],
  "startedAt": 1706745600000
}
```

Response: `{ "ok": true }`

#### `POST /heartbeat`

Daemon keepalive. Returns `{ "ok": true }` on success, `409` with `REREGISTER` code if daemon not recognized.

```json
{ "daemonId": "dm_a1b2c3d4", "sessionCount": 5 }
```

#### `POST /ingest`

Batched session updates. Max 500 sessions + 500 removals per request.

```json
{
  "daemonId": "dm_a1b2c3d4",
  "sessions": [{ "sessionId": "...", "status": "working", ... }],
  "removedSessionIds": ["uuid-1"]
}
```

Returns `404 UNKNOWN_DAEMON` if daemon not registered.

#### `POST /deregister`

```json
{ "daemonId": "dm_a1b2c3d4" }
```

### Frontend -> Server (5 GET endpoints)

#### `GET /status`

Returns `{ ok, data: { connected, daemon, sessionCount } }`.

#### `GET /sessions`

Paginated session list. Query: `?limit=100&offset=0` (limit 1-500).

#### `GET /history`

Historical sessions from DB. Query: `?projectHash=&since=&limit=`.

#### `GET /topology`

Agent topology graph. Query: `?rootSessionId=`. Returns BFS-walked `AgentTopologyNode[]`.

#### `GET /stream` (SSE)

Real-time event stream. Max 50 concurrent connections (429 when exceeded).

**Event flow:**
1. On connect: send full snapshot (live sessions, or historical from DB if daemon offline)
2. Subscribe to live updates via `addRealtimeSubscriber`
3. Keep-alive ping (`: ping\n\n`) every 15s

### Request Validation

- All POST payloads validated with Zod schemas
- 5MB body size limit on all POST endpoints
- Validation errors return `400` with `VALIDATION_ERROR` code

### Error Codes

| Code | Status | When |
|------|--------|------|
| `VALIDATION_ERROR` | 400 | Zod validation failed |
| `INVALID_JSON` | 400 | JSON parse failed |
| `PAYLOAD_TOO_LARGE` | 413 | Content-Length > 5MB |
| `UNKNOWN_DAEMON` | 404 | Heartbeat/ingest from unregistered daemon |
| `REREGISTER` | 409 | Heartbeat from stale daemon -- re-register |
| `TOO_MANY_CONNECTIONS` | 429 | SSE connection limit reached |
| `MISSING_PARAM` | 400 | Required query parameter missing |
| `SESSION_NOT_FOUND` | 404 | Topology root session not found |
| `DB_ERROR` | 500 | Historical query failed |

---

## SSE Event Types

| Event Type | Payload | When |
|------------|---------|------|
| `cli-monitor:snapshot` | `{ sessions, daemon, connected }` | On SSE connect |
| `cli-monitor:session-update` | `{ session, previousStatus? }` | Session created or updated |
| `cli-monitor:session-removed` | `{ sessionId }` | Session evicted or daemon cleared |
| `cli-monitor:status-change` | `{ sessionId, previousStatus, newStatus, timestamp }` | Session status transition |
| `cli-monitor:daemon-connected` | `{ daemon }` | Daemon registered |
| `cli-monitor:daemon-disconnected` | `{}` | Daemon deregistered or timed out |

---

## Client-Server Protocol

### Data Flow Pipeline

```
1. Claude Code CLI writes to ~/.claude/projects/{hash}/{uuid}.jsonl
2. chokidar detects file change
3. 200ms debounce settles
4. Daemon tail-reads new bytes from stored offset
5. Parser extracts events, derives session status + topology + metrics
6. SessionStore updates in-memory state, marks as changed
7. 500ms batch timer fires
8. Daemon POSTs changed sessions to /api/cli-monitor/ingest
9. Server updates in-memory cache, persists to SQLite
10. Server publishes events to DurableStreamsServer + local subscribers
11. SSE pushes events to connected browsers
12. React state updates, UI re-renders
```

### Registration Flow

```
1. Daemon starts, POST /register with exponential backoff retry
2. Server stores DaemonInfo, starts heartbeat monitor, publishes daemon-connected
3. Daemon sends heartbeat every 10s
4. If server responds 409: daemon re-registers and triggers full session re-sync
5. Server considers daemon dead if no heartbeat for ~45s (30s + grace)
6. On daemon stop: POST /deregister, server clears sessions
```

### Circuit Breaker (Daemon HTTP Client)

| State | Behavior |
|-------|----------|
| **Closed** | Normal operation |
| **Open** | After 5 consecutive failures, all requests blocked for 60s |
| **Half-Open** | After timeout, next request allowed as probe |

All HTTP requests have a 10s timeout via `AbortController`.

---

## Database Schema

**Location:** `src/db/schema/sqlite/cli-sessions.ts`

Table `cli_sessions` with indexes on `(projectHash, lastActivityAt)`, `status`, and `lastActivityAt`.

Key columns: `session_id` (unique), `file_path`, `cwd`, `project_name`, `project_hash`, `status`, `message_count`, `turn_count`, `started_at`, `last_activity_at`, `is_subagent`, `parent_session_id`.

JSON text columns: `pending_tool_use`, `token_usage`, `performance_metrics`, `topology`, `queue_operations`, `tool_invocations`.

---

## Types

**Location:** `src/services/cli-monitor/types.ts`

Key exported types:
- `CliSessionStatus`: `'working' | 'waiting_for_approval' | 'waiting_for_input' | 'idle'`
- `CliSession`: Full session state with token usage, topology, performance metrics
- `DaemonInfo`, `DaemonRegisterPayload`, `DaemonHeartbeatPayload`, `DaemonIngestPayload`
- `AgentTopologyNode`: Session relationship graph node
- `PerformanceMetrics`, `CompactionEvent`, `TurnMetrics`
- `CliMonitorEvent` (union of all SSE event types)
- `RawCliEvent`, `RawTokenUsage`, `RawContentBlock`: JSONL event types from Claude Code CLI
- `deriveAggregateStatus()`: `attention > nominal > idle` priority

Exported constants: `IDLE_TIMEOUT_MS` (5min), `DAEMON_HEARTBEAT_INTERVAL_MS` (10s), `DAEMON_TIMEOUT_MS` (30s), `INGEST_BATCH_INTERVAL_MS` (500ms), `GOAL_MAX_LENGTH` (200), `RECENT_OUTPUT_MAX_LENGTH` (500).

---

## Memory Management

| Layer | Limit | Eviction |
|-------|-------|----------|
| Daemon SessionStore | 1,000 sessions | LRU by `lastActivityAt` |
| Daemon pending changes | 5,000 max | Capped on retry |
| Server CliMonitorService | 10,000 sessions | LRU by `lastActivityAt` |
| SSE connections | 50 max | 429 Too Many Requests |
| Ingest payload | 5MB max | 413 Payload Too Large |
| Ingest arrays | 500 items max each | Zod validation |

---

## Timing Constants

| Constant | Value | Location |
|----------|-------|----------|
| File watcher debounce | 200ms | `watcher.ts` |
| Ingest batch interval | 500ms | `daemon.ts` |
| Idle session check | Every 30s | `daemon.ts` (via ingest timer counter) |
| Heartbeat interval | 10s | `daemon.ts` |
| Heartbeat timeout | ~45s (30s + 1.5x grace) | `cli-monitor.service.ts` |
| Heartbeat check interval | 15s | `cli-monitor.service.ts` |
| SSE keepalive ping | 15s | `routes/cli-monitor.ts` |
| Idle session threshold | 5 min | `daemon.ts` |
| Idle session eviction | 30 min | `daemon.ts` |
| Session retention | 7 days (configurable) | `watcher.ts`, `cli-monitor.service.ts` |
| DB maintenance interval | 10 min | `cli-monitor.service.ts` |
| Frontend status poll | 3s | (install state) |
| Registration retry backoff | 1s-30s exponential | `daemon.ts` |
| Circuit breaker open duration | 60s | `agentpane-client.ts` |
| Circuit breaker failure threshold | 5 consecutive | `agentpane-client.ts` |
| HTTP request timeout | 10s | `agentpane-client.ts` |

---

## Test Coverage

| Area | Location |
|------|----------|
| JSONL parser (130+ tests) | `packages/cli-monitor/src/__tests__/parser.test.ts` |
| Session store | `packages/cli-monitor/src/__tests__/session-store.test.ts` |
| AgentPane client + circuit breaker | `packages/cli-monitor/src/__tests__/agentpane-client.test.ts` |
| Daemon lifecycle | `packages/cli-monitor/src/__tests__/daemon.test.ts` |
| File watcher | `packages/cli-monitor/src/__tests__/watcher.test.ts` |
| Server service | `src/services/cli-monitor/__tests__/cli-monitor.service.test.ts` |
| Server routes | `src/server/routes/__tests__/cli-monitor.test.ts` |

---

## Key File Locations

| Component | Path |
|-----------|------|
| NPM package source | `packages/cli-monitor/src/` |
| NPM package config | `packages/cli-monitor/package.json` |
| Server service | `src/services/cli-monitor/cli-monitor.service.ts` |
| Server types | `src/services/cli-monitor/types.ts` |
| Server routes | `src/server/routes/cli-monitor.ts` |
| Route tests | `src/server/routes/__tests__/cli-monitor.test.ts` |
| Service tests | `src/services/cli-monitor/__tests__/cli-monitor.service.test.ts` |
| DB schema | `src/db/schema/sqlite/cli-sessions.ts` |
| Frontend page | `src/app/routes/cli-monitor.tsx` |
| Frontend context | `src/app/components/features/cli-monitor/cli-monitor-context.tsx` |
| Frontend types | `src/app/components/features/cli-monitor/cli-monitor-types.ts` |
| Frontend utils | `src/app/components/features/cli-monitor/cli-monitor-utils.ts` |
| Wireframes | `specs/application/wireframes/cli-monitor/` |

---

## Known Gaps

| Priority | Gap | Description |
|----------|-----|-------------|
| High | Bidirectional actions | Approve/Input buttons disabled -- need daemon-side stdin injection or Claude Code API |
| High | npm publish CI | Package configured but needs CI workflow for automated publishing |
| Medium | Multi-daemon support | Server accepts one daemon (latest wins); could support multiple watching different directories |
| Medium | Subagent visualization | Topology data collected but no dedicated parent-child tree UI |
| Medium | Token cost accuracy | Flat $5/1M estimate; should differentiate input/output/cache rates by model |
| Low | Session export | No CSV/JSON export for analysis |
| Low | WebSocket upgrade | SSE is one-directional; WebSocket would enable bidirectional actions |

---

## Publishing to npm

The package is published under the `@agentpane` scope with public access. See `CLAUDE.md` for the publish workflow:

```bash
cd packages/cli-monitor
npm version patch --no-git-tag-version
npm publish --//registry.npmjs.org/:_authToken=<token>
```

The `prepublishOnly` script runs tests and builds automatically.
