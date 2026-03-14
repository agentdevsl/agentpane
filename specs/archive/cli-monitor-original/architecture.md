# Architecture

## System Overview

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
|  |  CliMonitorService                   ||  session cache (10K max)
|  |  InMemoryDurableStreamsServer        ||  SSE event bus
|  +--------------------------------------+|
|                                          |
|  GET /api/cli-monitor/status             |  daemon connection check
|  GET /api/cli-monitor/sessions           |  paginated session list
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

---

## Component Boundaries

### Daemon (`packages/cli-monitor/`)

Standalone Node.js process. Zero AgentPane dependencies. Communicates exclusively via HTTP.

| Module | Responsibility |
|--------|---------------|
| `index.ts` | CLI entry point, argument parsing |
| `daemon.ts` | Process lifecycle, PID locking, signal handling |
| `watcher.ts` | chokidar file watching, debounced processing |
| `parser.ts` | JSONL line parsing, status derivation, token accumulation |
| `session-store.ts` | In-memory Map with LRU eviction (1K sessions max) |
| `agentpane-client.ts` | HTTP client with circuit breaker pattern |
| `logger.ts` | Structured JSON logging with level control |
| `display.ts` | Terminal output formatting |

### Server (`src/services/cli-monitor/`, `src/server/routes/cli-monitor.ts`)

Passive receiver. No filesystem dependencies. Accepts data from daemon, caches it, fans out via SSE.

| Module | Responsibility |
|--------|---------------|
| `cli-monitor.service.ts` | Session cache (10K max), daemon lifecycle tracking, heartbeat timeout |
| `routes/cli-monitor.ts` | 7 Hono routes, Zod validation, SSE streaming (50 conn limit) |
| `types.ts` | Shared TypeScript types (CliSession, DaemonInfo, events) |

### Frontend (`src/app/routes/cli-monitor/`)

Single-page component with three states. SSE subscription for live updates.

| Feature | Implementation |
|---------|---------------|
| State machine | `useCliMonitorState` hook — install/waiting/active |
| Session list | Keyboard-navigable, grouped by project, lazy-loaded (50/batch) |
| Detail panel | Token breakdown, recent output, git info, action buttons |
| Alert toasts | Status-change notifications (approval needed, complete, error) |
| Error handling | React error boundary, offline detection, SSE reconnect |

---

## Data Flow

### Session Update Pipeline

```
1. Claude Code CLI writes to ~/.claude/projects/{hash}/{uuid}.jsonl
2. chokidar detects file change
3. 200ms debounce settles
4. Daemon tail-reads new bytes from stored offset
5. Parser extracts events, derives session status
6. SessionStore updates in-memory state
7. 500ms batch timer fires
8. Daemon POSTs changed sessions to /api/cli-monitor/ingest
9. Server updates its cache, publishes to DurableStreamsServer
10. SSE pushes cli-monitor:session-update to all connected browsers
11. React state updates, UI re-renders
```

### Daemon Registration Flow

```
1. Daemon starts, attempts POST /register
2. If server unreachable: exponential backoff retry (1s, 2s, 4s, 8s, ... 30s cap)
3. On success: server stores DaemonInfo, starts heartbeat monitor
4. Daemon sends heartbeat every 10s
5. Server considers daemon dead if no heartbeat for 30s
6. On daemon stop: POST /deregister, server clears sessions
```

### Frontend State Transitions

```
                    daemon registers
    INSTALL --------------------------> WAITING
       ^                                   |
       |   daemon disconnects              | first session arrives
       |                                   v
       +------------------------------- ACTIVE
                                           |
                                           | all sessions removed
                                           v
                                        WAITING
```

---

## Memory Management

| Layer | Limit | Eviction |
|-------|-------|----------|
| Daemon SessionStore | 1,000 sessions | LRU by `lastActivityAt` |
| Server CliMonitorService | 10,000 sessions | LRU by `lastActivityAt` |
| Frontend | 50 sessions per render batch | Intersection observer lazy load |
| SSE connections | 50 max | 429 Too Many Requests |
| Ingest payload | 5MB max | 413 Payload Too Large |

---

## Timing Constants

| Constant | Value | Location |
|----------|-------|----------|
| File watcher debounce | 200ms | `watcher.ts` |
| Ingest batch interval | 500ms | `daemon.ts` |
| Heartbeat interval | 10s | `daemon.ts` |
| Heartbeat timeout | 30s | `cli-monitor.service.ts` |
| SSE keepalive ping | 15s | `routes/cli-monitor.ts` |
| Idle session threshold | 5 min | `session-store.ts` |
| Idle session eviction | 30 min | `daemon.ts` |
| Frontend status poll | 3s | `index.tsx` (install state) |
| SSE reconnect delay | 3s | `index.tsx` |
| Registration retry backoff | 1s-30s exponential | `daemon.ts` |
| Circuit breaker open duration | 60s | `agentpane-client.ts` |
| Circuit breaker failure threshold | 5 consecutive | `agentpane-client.ts` |

---

## Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Path traversal via filePath | Path containment check in watcher (resolve + startsWith) |
| Daemon impersonation | Heartbeat timeout auto-evicts stale daemons; latest daemon wins |
| Oversized payloads | 5MB content-length check before JSON parse |
| SSE resource exhaustion | 50 connection cap with 429 response |
| Malformed JSONL injection | Zod validation on all POST payloads; parser skips unrecognized events |
| Symlink escape | `realpath()` resolution before path containment check |
