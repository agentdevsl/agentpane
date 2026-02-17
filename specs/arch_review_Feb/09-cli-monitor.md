# 09 - CLI Monitor Architecture Review

## 1. Overview

The `@agentpane/cli-monitor` package (`packages/cli-monitor/`) is a standalone daemon that watches Claude Code JSONL session files on disk (`~/.claude/projects/`), parses session events in real-time, and forwards aggregated session state to the AgentPane server via REST API. It serves as the bridge between the local Claude Code CLI and the AgentPane dashboard, enabling real-time visibility into all running Claude sessions.

**Architecture Pattern**: File-system watcher daemon with batched HTTP ingestion and circuit-breaker resilience.

**Key Stats**:
- 12 source files (~1,700 lines of production code)
- 7 test files (~1,760 lines of test code)
- 1 external runtime dependency (chokidar)
- Published to npm as `@agentpane/cli-monitor` v0.2.1

## 2. Package Structure

### Entry Points and Build Configuration

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point (`#!/usr/bin/env node`), arg parsing, command dispatch |
| `src/daemon.ts` | Daemon lifecycle orchestrator (PID lock, watcher, client, timers) |
| `src/watcher.ts` | File system watcher using chokidar, debounced file processing |
| `src/parser.ts` | JSONL event parser, session state machine, topology derivation |
| `src/session-store.ts` | In-memory session store with change tracking and topology graph |
| `src/agentpane-client.ts` | HTTP client with circuit breaker for AgentPane server |
| `src/display.ts` | Terminal display formatting (ANSI status box) |
| `src/logger.ts` | Structured JSON logging with configurable levels |
| `src/utils.ts` | ID generation (`crypto.getRandomValues`) and error formatting |
| `src/version.ts` | Build-time version injection via `PKG_VERSION` define |

### Build Output

The package supports three build modes (`package.json:14-16`):

1. **`build`** - Bun-compiled single binary (`dist/cli-monitor`)
2. **`build:js`** - Node.js-compatible JS bundle (`dist/index.js`, ~75KB) - used for npm publish
3. **`build:all`** - Cross-platform binaries (darwin-arm64, darwin-x64, linux-x64)

Only `dist/index.js` is included in the npm package (`"files": ["dist/index.js"]`).

### Dependencies

| Dependency | Type | Purpose |
|------------|------|---------|
| `chokidar` ^5.0.0 | runtime | Cross-platform recursive file watching |
| `@types/bun` latest | dev | Bun type definitions |

The minimal dependency footprint is notable -- the package uses only Node.js built-in modules plus chokidar.

## 3. Daemon Architecture

### Process Management

The daemon uses a PID lock file (`~/.claude/.cli-monitor.lock`) to ensure single-instance operation (`daemon.ts:18-56`):

1. **Lock acquisition**: Reads existing lock, checks if PID is alive via `process.kill(pid, 0)`, overwrites if stale
2. **Lock release**: Deletes lock file on shutdown
3. **Background mode**: `--daemon` flag spawns a detached child process with `stdio: 'ignore'` (`daemon.ts:67-79`)

### Lifecycle Flow

```
CLI entry (index.ts)
  -> startDaemon(options) (daemon.ts:65)
    -> acquireLock()
    -> AgentPaneClient.register() [with exponential backoff retry]
    -> FileWatcher.start() [initial scan + chokidar watch]
    -> setInterval(heartbeat, 10s) [unref'd]
    -> setInterval(ingest batch, 500ms) [unref'd]
```

### Signal Handling

Graceful shutdown is handled for SIGINT, SIGTERM, SIGHUP with a 5-second forced exit timeout (`daemon.ts:120-145`). Uncaught exceptions and unhandled rejections also trigger shutdown.

### Timer Architecture

| Timer | Interval | Unref'd | Purpose |
|-------|----------|---------|---------|
| Heartbeat | 10s | Yes | Server keepalive, triggers re-registration on 409 |
| Ingest batch | 500ms | Yes | Flush changed sessions to server |
| Idle check | 30s (via counter) | N/A | Mark sessions idle after 5min, evict after 30min |

The idle check piggybacks on the ingest timer using a counter (`idleCheckCounter >= 60` at 500ms = 30s), which is an efficient approach to avoid yet another timer.

## 4. Metrics Collection

### What Is Collected

The parser (`parser.ts`) extracts comprehensive session metadata from JSONL events:

**Core Metrics**:
- Session status (working, waiting_for_approval, waiting_for_input, idle)
- Message counts (user + assistant)
- Turn counts (incremented on `stop_reason != null`)
- Goal text (first user message, truncated to 200 chars)
- Recent output (last text block, truncated to 500 chars)
- Model name (from assistant messages)
- Git branch (updated on each event)

**Token Usage** (`parser.ts:310-323`):
- Input tokens, output tokens
- Cache creation tokens, cache read tokens
- Ephemeral 5-minute and 1-hour cache tokens

**Performance Metrics** (`parser.ts:374-412`):
- Per-turn token breakdown (ring buffer of 10 recent turns)
- Cache hit ratio (rolling average across recent turns)
- Context window pressure (input_tokens / context_limit)
- Context health status (healthy/warning/critical)
- Compaction events (compact and microcompact boundaries)
- Turn duration (from `system:turn_duration` events)
- Average turn duration (running average)

**Tool Tracking** (`parser.ts:330-347`):
- Recent tool invocations (ring buffer of 50)
- Tool result enrichment (numFiles, numLines)

**Queue Operations** (`parser.ts:245-263`):
- Enqueue/remove operations (ring buffer of 20)

**Topology** (`parser.ts:200-213`):
- Agent hierarchy (parent/child relationships via file path structure)
- Agent type derivation (orchestrator, planner, coder, reviewer, tester, scanner, deployer, explorer)

### Processing Flow

```
chokidar detects file change
  -> debouncedProcess(filePath) [200ms debounce]
    -> processFile(filePath)
      -> stat file, check retention window
      -> read only new bytes (from stored offset)
      -> skip UTF-8 continuation bytes at boundary
      -> parseJsonlFile(filePath, content, offset, store)
        -> line-by-line JSON parsing
        -> session state updates
        -> topology enrichment
      -> update read offset
  -> [500ms timer] store.flushChanges()
    -> client.ingest(daemonId, updated, removed)
```

## 5. Cost Calculation

Cost calculation is **not performed in the CLI monitor daemon** itself. The daemon collects raw token counts and sends them to the server. Cost estimation happens in the frontend via `cli-monitor-utils.ts`:

```typescript
// src/app/components/features/cli-monitor/cli-monitor-utils.ts:24-36
const inputCost = ((t.inputTokens ?? 0) / 1_000_000) * 3;        // $3/MTok
const outputCost = ((t.outputTokens ?? 0) / 1_000_000) * 15;     // $15/MTok
const cacheCreateCost = ((t.cacheCreationTokens ?? 0) / 1_000_000) * 3.75;  // $3.75/MTok
const cacheReadCost = ((t.cacheReadTokens ?? 0) / 1_000_000) * 0.3;         // $0.30/MTok
```

These are hardcoded Sonnet pricing. The fallback flat-rate overload uses $5/MTok.

## 6. Session Tracking

### In-Memory Store (`session-store.ts`)

Sessions are stored in a `Map<string, StoredSession>` with these supporting structures:

- **Read offsets**: `Map<string, number>` -- byte offset per file path for incremental reading
- **Change tracking**: `Set<string>` for changed and removed session IDs (batched flush)
- **Child index**: `Map<string, Set<string>>` -- parentId to child session IDs for topology

**Limits**:
- MAX_SESSIONS: 1,000 (evicts oldest by `lastActivityAt`)
- MAX_PENDING_CHANGES: 5,000 (caps retry queue to prevent memory exhaustion)

### Session Lifecycle

```
New file detected -> status: 'working' (first event)
  -> User messages: status stays 'working'
  -> Assistant with tool_use: status -> 'waiting_for_approval'
  -> User with tool_result: status -> 'working' (approval given)
  -> Assistant with stop_reason: status -> 'waiting_for_input'
  -> Summary event: status -> 'idle'
  -> 5 min inactivity: status -> 'idle' (daemon-side)
  -> 30 min idle: evicted from memory
```

### Correlation with Main App

The daemon registers with the AgentPane server and sessions flow through:

1. **Daemon -> Server**: `POST /api/cli-monitor/ingest` with session array
2. **Server (in-memory)**: `CliMonitorService` stores sessions in a `Map` (max 10,000)
3. **Server (DB persistence)**: Fire-and-forget upsert to `cliSessions` table
4. **Server -> Frontend**: SSE stream via `GET /api/cli-monitor/stream`
5. **Frontend**: Real-time session dashboard with cost display

The `sessionId` field from the JSONL is the primary correlation key throughout the pipeline.

### Topology Graph

The `SessionStore.getTopologyGraph()` method (`session-store.ts:283-334`) performs BFS from a root session to build the agent hierarchy. It includes cycle detection via a visited set and depth calculation by walking the parent chain (also with cycle protection via `depthVisited` set).

## 7. Publishing Pipeline

### npm Publishing

Per `CLAUDE.md` and `package.json`:

```bash
cd packages/cli-monitor
npm version patch --no-git-tag-version
npm publish --//registry.npmjs.org/:_authToken=<token>
```

- **prepublishOnly** script runs `bun run test && bun run build:js` automatically
- Published under `@agentpane` scope with `"access": "public"`
- npm access token stored in `/specs/CLI_monitor/.env` (`npm_access_token`)
- Build output: single `dist/index.js` file (~75KB)

### Version Management

- Version is injected at build time via Bun's `--define "PKG_VERSION='...'"` flag
- Runtime fallback: `'0.0.0-dev'` when `PKG_VERSION` is undefined (`version.ts:3-4`)
- `--no-git-tag-version` is used for npm version bumps, meaning no git tags are created

### Repository References

The `package.json` references a different repository (`agentdevsl/claudorc`) than the actual monorepo, suggesting the package was originally developed elsewhere or the URLs need updating.

## 8. Findings

### CM-001: Hardcoded Cost Model Ignores Model-Specific Pricing

**Severity**: Medium
**File**: `src/app/components/features/cli-monitor/cli-monitor-utils.ts:30-35`

**Description**: The `estimateCost()` function uses hardcoded Sonnet-tier pricing ($3/$15 input/output per MTok) regardless of the actual model being used. Opus-tier pricing is significantly higher ($15/$75), and Haiku is lower ($0.25/$1.25). Sessions using different models will show inaccurate cost estimates.

**Recommendation**: Look up pricing per model from a model pricing map. The `session.model` field is already available and could be used for selection.

---

### CM-002: PID Lock File Has Race Condition

**Severity**: Low
**File**: `packages/cli-monitor/src/daemon.ts:29-46`

**Description**: The `acquireLock()` function performs a non-atomic check-then-write sequence: it reads the lock file, checks if the PID is alive, then writes its own PID. Between the check and the write, another process could acquire the lock. The window is small but exists when multiple daemons start simultaneously.

**Recommendation**: Use an atomic file creation approach (e.g., `O_EXCL` flag) or advisory file locking to eliminate the race condition. Alternatively, accept the low risk given single-user desktop usage.

---

### CM-003: Incorrect Repository URLs in package.json

**Severity**: Low
**File**: `packages/cli-monitor/package.json:21-28`

**Description**: The `repository`, `bugs`, and `homepage` URLs point to `agentdevsl/claudorc` instead of the actual repository hosting this code. This can confuse users who find the package on npm and try to report issues or contribute.

**Recommendation**: Update the repository URLs to match the actual monorepo location.

---

### CM-004: Missing Cost for Ephemeral Cache Tokens

**Severity**: Medium
**File**: `src/app/components/features/cli-monitor/cli-monitor-utils.ts:24-36`

**Description**: The `estimateCost()` function tracks `ephemeral5mTokens` and `ephemeral1hTokens` in the token total calculation (`getSessionTokenTotal`) but does not include ephemeral cache costs in the `estimateCost()` function. These tokens may have different pricing from standard cache tokens.

**Recommendation**: Add ephemeral cache token pricing to the cost estimation, or document that they are included in the standard cache pricing if that is the case.

---

### CM-005: No Authentication on Daemon-to-Server API

**Severity**: Medium
**File**: `packages/cli-monitor/src/agentpane-client.ts:82-88`, `src/server/routes/cli-monitor.ts:248-260`

**Description**: The daemon communicates with the AgentPane server over plaintext HTTP with no authentication. Any process on the local machine can register as a daemon, ingest fake session data, or deregister the real daemon. While this is a localhost-only service, it allows session data injection from malicious local processes.

**Recommendation**: Implement a shared secret or API key that the daemon and server exchange during registration. The key could be generated at server startup and passed to the daemon via a well-known file or environment variable.

---

### CM-006: Compaction Events Array Grows Unbounded

**Severity**: Medium
**File**: `packages/cli-monitor/src/parser.ts:453`

**Description**: The `compactionEvents` array in `performanceMetrics` has no ring buffer cap. While `recentTurns` is capped at 10, `recentToolInvocations` at 50, and `queueOperations` at 20, compaction events accumulate indefinitely. Long-running sessions with many compactions will consume increasing memory and bandwidth (the entire array is sent on each ingest).

**Recommendation**: Add a ring buffer cap (e.g., 20-30 events) to `compactionEvents`, consistent with other ring-buffered arrays in the parser.

---

### CM-007: Sequential File Scanning at Startup

**Severity**: Low
**File**: `packages/cli-monitor/src/watcher.ts:109-118`

**Description**: The `scanExisting()` method processes all JSONL files sequentially (`for...of` with `await`). On systems with many session files (hundreds), initial startup can be slow. The `walkJsonlFiles` recursive directory walk is also sequential.

**Recommendation**: Consider parallel processing with a concurrency limit (e.g., `Promise.all` with batches of 10-20 files) for the initial scan phase.

---

### CM-008: `realpath` Called on Every File Process

**Severity**: Low
**File**: `packages/cli-monitor/src/watcher.ts:140-153`

**Description**: The `processFile()` method calls `fsp.realpath()` on both the file path and watch directory on every file change event. This is a defensive security measure against symlink attacks, but the watch directory's real path is stable and could be resolved once at initialization rather than on every event.

**Recommendation**: Cache the resolved watch directory real path in `FileWatcher.start()` and only resolve the file path per-event.

---

### CM-009: Agent Type Derivation Uses Fragile String Matching

**Severity**: Low
**File**: `packages/cli-monitor/src/parser.ts:518-570`

**Description**: The `deriveAgentType()` function uses `includes()` checks on `agentId` strings (e.g., `agentId.includes('cod')` matches "coder" but also "encoding", "decoder"). The goal-based keyword matching is similarly fragile -- a user message like "find the code review tool" would match both "explorer" (find) and "reviewer" (review), but only "reviewer" wins due to check order.

**Recommendation**: Use more precise patterns (word boundaries, exact prefix/suffix matching) or prioritize the `subagentType` field from the JSONL which provides explicit agent type labels from the SDK.

---

### CM-010: `getContextWindowLimit()` Returns Same Value for All Models

**Severity**: Low
**File**: `packages/cli-monitor/src/parser.ts:92-98`

**Description**: The `getContextWindowLimit()` function returns 200,000 for all Claude models. While this is currently accurate, the function's structure suggests it was designed to differentiate between models. If models with different context windows are introduced, the function will need updating.

**Recommendation**: No immediate action needed, but consider making this configurable or deriving from model metadata.

---

### CM-011: Heartbeat Returns 'stale' but Client Treats as 'reregister'

**Severity**: Low
**File**: `src/services/cli-monitor/cli-monitor.service.ts:65-74`, `packages/cli-monitor/src/agentpane-client.ts:106-111`

**Description**: The server's `handleHeartbeat()` method returns `'unknown'` or `'stale'` for unrecognized daemons, but both result in a 409 status code at the route level. The daemon client maps 409 to `'reregister'`. The `'stale'` vs `'unknown'` distinction is lost. More importantly, the server route (`cli-monitor.ts:266-278`) only checks for `result === 'ok'` and returns 409 for everything else, so `'stale'` and `'unknown'` are treated identically.

**Recommendation**: Either remove the distinction in the service or propagate it to the client with different status codes.

---

### CM-012: `ingestTimer.unref` Guard Suggests Node Compatibility Concern

**Severity**: Info
**File**: `packages/cli-monitor/src/daemon.ts:213,243`

**Description**: The code uses `if (ingestTimer.unref) ingestTimer.unref()` guards, suggesting uncertainty about the runtime environment. In both Node.js and Bun, `setInterval` returns an object with `.unref()`. The guard is defensive but unnecessary for the stated `node >= 22.0.0` engine requirement.

**Recommendation**: Remove the guards for cleaner code, or document why they exist (e.g., test environment compatibility).

---

### CM-013: DB Persistence Is Fire-and-Forget Without Retry

**Severity**: Medium
**File**: `src/services/cli-monitor/cli-monitor.service.ts:146-153`

**Description**: The server persists ingested sessions to SQLite asynchronously with `.catch()` that only logs errors. If the database write fails (e.g., disk full, table locked), session data is lost from the historical record. The in-memory state is fine, but historical queries will have gaps.

**Recommendation**: Implement a retry queue for failed DB writes, or at minimum track failed persistence counts as a health metric.

---

### CM-014: Server-Side Topology BFS Uses Linear Search

**Severity**: Low
**File**: `src/server/routes/cli-monitor.ts:465`

**Description**: The topology endpoint uses `sessions.find()` inside a BFS loop to locate sessions by ID, resulting in O(n*m) time complexity where n is BFS queue size and m is total session count. The daemon-side `SessionStore` uses a `Map` for O(1) lookups, but the server route converts to an array first.

**Recommendation**: Build a `Map<sessionId, session>` before the BFS loop for O(1) lookups.

---

### CM-015: No Validation of `--retention` Flag

**Severity**: Low
**File**: `packages/cli-monitor/src/index.ts:38-39`

**Description**: The `--retention` flag is parsed with `parseInt()` but not validated for reasonable range. A user could pass `--retention 0` (skip all files) or `--retention 99999` (process extremely old files, potentially causing high memory usage on first scan). Negative values would also be accepted.

**Recommendation**: Clamp the retention value to a reasonable range (e.g., 1-365 days) and warn on out-of-range values.

---

### CM-016: CLI Argument Parser Does Not Handle Short Flags or `=` Syntax

**Severity**: Low
**File**: `packages/cli-monitor/src/index.ts:12-24`

**Description**: The hand-rolled argument parser only supports `--key value` syntax. It does not support short flags (`-p 3001`), equals syntax (`--port=3001`), or combined flags. This is documented in `--help` output which only shows long flags, but users familiar with other CLI tools may expect these.

**Recommendation**: Consider using a lightweight arg parsing library (e.g., `parseArgs` from `node:util` which is built-in since Node 18) for more robust flag handling, or document the limitation more prominently.

---

### CM-017: `touchSessionsByFilePath` Iterates All Sessions

**Severity**: Low
**File**: `packages/cli-monitor/src/session-store.ts:248-256`

**Description**: The `touchSessionsByFilePath()` method performs a linear scan of all sessions to find those matching a file path. While `readOffsets` uses a `Map<filePath, offset>`, there is no reverse index from file path to session IDs. With the MAX_SESSIONS cap of 1,000, this is a minor concern.

**Recommendation**: Add a `Map<filePath, Set<sessionId>>` index if performance becomes an issue with high session counts.

---

### CM-018: Missing `--retention` Flag Passthrough in Background Mode

**Severity**: Info
**File**: `packages/cli-monitor/src/daemon.ts:68-70`

**Description**: The background mode correctly passes the `--retention` flag to the spawned child process. However, there is a subtle issue: `if (options.retentionDays)` will not pass the flag if `retentionDays` is 0, which is a valid (if unwise) value. The condition should check `!= null` instead.

**Recommendation**: Change the guard to `if (options.retentionDays != null)` for correctness.

---

### CM-019: No Rate Limiting on SSE Connections Per Client

**Severity**: Low
**File**: `src/server/routes/cli-monitor.ts:363-371`

**Description**: The SSE endpoint has a global `MAX_SSE_CONNECTIONS = 50` limit, but no per-client limit. A single client could consume all 50 connections, denying service to other dashboard users. The counter is also a module-level variable, not tied to the service instance, which could cause issues if multiple Hono apps are created (unlikely in practice).

**Recommendation**: Consider per-IP or per-user connection limits in addition to the global cap.

---

### CM-020: Shallow Copy in `flushChanges()` Does Not Deep-Copy Nested Objects

**Severity**: Low
**File**: `packages/cli-monitor/src/session-store.ts:209`

**Description**: The `flushChanges()` method uses spread syntax (`{ ...session }`) to create copies, but nested objects like `tokenUsage`, `performanceMetrics`, and `topology` are shared references. If the session's nested objects are mutated between flush and ingest, the flushed copy will reflect those mutations.

**Recommendation**: Use `structuredClone()` for deep copies or accept the risk given the short 500ms window between flush and ingest.

## Summary

The CLI monitor package is well-architected with clean separation of concerns, comprehensive test coverage (7 test files with ~1,760 lines covering all major modules), and thoughtful resilience patterns (circuit breaker, PID locking, debounced file processing, exponential backoff retry). The in-memory session store with batched HTTP ingestion is an efficient design for high-throughput JSONL parsing.

Key areas for improvement:
1. **Cost accuracy** (CM-001, CM-004): Model-specific pricing and ephemeral cache token handling
2. **Security** (CM-005): Localhost API authentication for defense-in-depth
3. **Memory bounds** (CM-006): Unbounded compaction events array
4. **Data durability** (CM-013): Fire-and-forget DB persistence without retry

The test infrastructure (comprehensive mock factories in `mocks.ts`, scenario builders, circuit breaker tests) is particularly strong and sets a good standard for the project.
