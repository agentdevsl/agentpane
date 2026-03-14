# Daemon — `@agentpane/cli-monitor`

Standalone Node.js/Bun process. Zero AgentPane dependencies. Communicates exclusively via HTTP (localhost only).

---

## Installation

```bash
# One-shot (recommended)
npx @agentpane/cli-monitor

# Global install
npm i -g @agentpane/cli-monitor

# Homebrew (macOS)
brew install agentpane/tap/cli-monitor
```

---

## CLI Commands

```
cli-monitor start [--port 3001] [--path ~/.claude/projects] [--daemon]
cli-monitor stop  [--port 3001]
cli-monitor status [--port 3001]
cli-monitor version
cli-monitor help
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `3001` | AgentPane server port |
| `--path <dir>` | `~/.claude/projects/` | Directory to watch |
| `--daemon` | `false` | Run in background (detached child process) |

---

## Module Map

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `index.ts` | CLI entry | Argument parsing, command routing, `start`/`stop`/`status` dispatch |
| `daemon.ts` | Core | Process lifecycle, PID locking, signal handling, heartbeat + ingest timers |
| `watcher.ts` | FileWatcher | chokidar file watching, debounced processing |
| `parser.ts` | JSONL parser | Line parsing, status derivation, token accumulation, session extraction |
| `session-store.ts` | SessionStore | In-memory Map with LRU eviction, change tracking, idle management |
| `agentpane-client.ts` | HTTP client | Register/heartbeat/ingest/deregister with circuit breaker |
| `logger.ts` | Logging | Structured JSON logger with level control via `LOG_LEVEL` env |
| `display.ts` | Terminal UI | ASCII status box, colored output (TTY-aware). Exports: `printStatusBox`, `printError`, `printInfo` |
| `utils.ts` | Helpers | `createId()` — 8-char hex ID via `crypto.getRandomValues()` |
| `version.ts` | Version | `PKG_VERSION` injected at build time, falls back to `0.0.0-dev` |

---

## Process Lifecycle

### Startup (`startDaemon`)

```
1. If --daemon flag: spawn detached child process, exit parent
2. Generate daemonId = "dm_{createId()}"
3. Create AgentPaneClient, SessionStore, FileWatcher
4. Acquire PID lock (~/.claude/.cli-monitor.lock)
   - If lock held by running process → exit with error
5. Register with AgentPane (POST /register)
   - On failure: exponential backoff retry (1s → 2s → 4s → 8s → ... 30s cap)
6. Start file watcher
7. Print terminal status box
8. Start heartbeat timer (every 10s)
9. Start ingest timer (every 500ms)
10. Install signal handlers
```

### Shutdown

Triggered by SIGINT, SIGTERM, SIGHUP, uncaughtException, or unhandledRejection.

```
1. Clear all timers (heartbeat, ingest)
2. Close file watcher
3. Deregister from AgentPane (POST /deregister)
4. Release PID lock
5. Force exit after 5s timeout
```

### PID Lock

- **File**: `~/.claude/.cli-monitor.lock`
- Contains PID of running daemon
- On startup: check if PID is alive via `process.kill(pid, 0)`
- Stale locks (dead PID) are overwritten

---

## FileWatcher

### Watch Strategy

Uses chokidar v5 for cross-platform recursive file watching. Works on macOS, Windows, and Linux without platform-specific branching.

### Processing Pipeline

```
1. File change detected by chokidar
2. 200ms debounce settles
3. Resolve symlinks via realpath()
4. Verify file is within watch directory (path containment)
5. Get file stats
6. If file truncated (stat.size < stored offset) → reset offset
7. Read up to 100MB chunk from stored offset
8. Skip UTF-8 continuation bytes at buffer start (0x80-0xBF)
9. Pass to parseJsonlFile()
10. Update stored read offset
```

### Edge Cases

| Scenario | Handling |
|----------|----------|
| File deleted (ENOENT) | Remove from session store |
| Permission denied (EACCES/EPERM) | Log warning, skip file |
| Directory doesn't exist | Poll every 5s for up to 5 minutes |
| File > 100MB | Warn, read last 100MB chunk only |
| Symlink outside watch dir | Rejected by path containment check |

---

## JSONL Parser

### Session Extraction

Path format: `~/.claude/projects/{projectHash}/{sessionId}.jsonl`

- **projectHash**: second-to-last path segment
- **projectName**: `path.basename(event.cwd)`
- **isSubagent**: detected via `/subagents/` in path or `agentId` field

### Status Derivation

| Event | Derived Status |
|-------|---------------|
| Assistant message with `tool_use` content | `waiting_for_approval` |
| Assistant message with text content | `working` |
| Assistant message with `stop_reason` set (not already waiting_for_approval) | `waiting_for_input` |
| `summary` event | `idle` |
| No activity for 5 minutes | `idle` (via timer) |

### Token Accumulation

From `message.usage` on assistant events:

```typescript
tokenUsage.inputTokens += usage.input_tokens
tokenUsage.outputTokens += usage.output_tokens
tokenUsage.cacheCreationTokens += usage.cache_creation_input_tokens
tokenUsage.cacheReadTokens += usage.cache_read_input_tokens
```

### Safety Limits

- Lines > 1MB are skipped
- Malformed JSON on non-final lines are skipped (final line assumed incomplete)
- Events missing `sessionId` or `type` are skipped

---

## SessionStore

### Capacity

- **Max sessions**: 1,000
- **Max pending changes**: 5,000
- **Eviction**: LRU by `lastActivityAt` when limit exceeded

### Change Tracking

The store tracks which sessions were updated or removed since the last `flushChanges()` call. The daemon calls `flushChanges()` every 500ms to batch changes for the ingest endpoint.

```typescript
flushChanges(): { updated: StoredSession[]; removed: string[] }
markPendingRetry(sessions, removedIds): void  // Restore on ingest failure
```

### Idle Management

Called every 30s by the ingest timer:

- `markIdleSessions(5min)` — sessions inactive > 5 minutes marked `idle`
- `evictIdleSessions(30min)` — sessions idle > 30 minutes removed

---

## AgentPaneClient

### Endpoints

| Method | Path | Frequency |
|--------|------|-----------|
| POST | `/api/cli-monitor/register` | Once at startup |
| POST | `/api/cli-monitor/heartbeat` | Every 10s |
| POST | `/api/cli-monitor/ingest` | Every 500ms (batched) |
| POST | `/api/cli-monitor/deregister` | Once at shutdown |

### Circuit Breaker

Protects against server downtime flooding logs with errors.

| State | Behavior |
|-------|----------|
| **Closed** | Normal operation, requests pass through |
| **Open** | After 5 consecutive failures, all requests blocked for 60s |
| **Half-Open** | After 60s timeout, next request allowed as probe |

- Success in any state → reset to Closed
- Failure in Half-Open → back to Open
- All requests have a 10s timeout via `AbortController`

---

## Logger

Structured JSON output controlled by `LOG_LEVEL` environment variable.

| Level | Default | Output |
|-------|---------|--------|
| `debug` | No | `console.debug` |
| `info` | Yes | `console.log` |
| `warn` | Yes | `console.warn` |
| `error` | Yes | `console.error` |

Format:

```json
{"ts":"2025-01-31T10:00:00.000Z","level":"info","msg":"Daemon started","daemonId":"dm_a1b2c3d4"}
```

---

## Build & Distribution

### Build Commands

```bash
bun run build          # Standalone binary (current platform)
bun run build:js       # Node.js module (dist/index.js)
bun run build:all      # Cross-platform binaries (darwin-arm64, darwin-x64, linux-x64)
```

### Binary Targets

| Target | Output |
|--------|--------|
| `bun-darwin-arm64` | `dist/cli-monitor-darwin-arm64` |
| `bun-darwin-x64` | `dist/cli-monitor-darwin-x64` |
| `bun-linux-x64` | `dist/cli-monitor-linux-x64` |

### Package Metadata

```json
{
  "name": "@agentpane/cli-monitor",
  "version": "0.1.0",
  "type": "module",
  "bin": { "cli-monitor": "dist/index.js" },
  "engines": { "node": ">=22.0.0" },
  "dependencies": {
    "chokidar": "^5.0.0"
  }
}
```

One production dependency (chokidar for cross-platform file watching). DevDeps: `@types/bun` only.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Logging verbosity (debug/info/warn/error) |
| `CLI_MONITOR_PORT` | — | Override for `--port` flag |
| `CLI_MONITOR_PATH` | — | Override for `--path` flag |
