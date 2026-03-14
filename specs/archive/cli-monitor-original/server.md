# Server — AgentPane Receiver

Passive receiver. No filesystem dependencies. Accepts data from daemon, caches in memory, fans out via SSE.

---

## Module Map

| Module | Location | Lines | Responsibility |
|--------|----------|-------|----------------|
| `CliMonitorService` | `src/services/cli-monitor/cli-monitor.service.ts` | ~202 | Session cache, daemon lifecycle, heartbeat timeout |
| `types.ts` | `src/services/cli-monitor/types.ts` | ~283 | All shared TypeScript types, constants, raw JSONL event types (`RawTokenUsage`, `RawProgressData`, etc.), and exported constants |
| Routes | `src/server/routes/cli-monitor.ts` | ~323 | 7 Hono routes, Zod validation, SSE streaming |

---

## CliMonitorService

### State

```typescript
class CliMonitorService {
  private static readonly MAX_SESSIONS = 10_000;
  private sessions: Map<string, CliSession>;
  private daemon: DaemonInfo | null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null;
}
```

### Constructor

Takes a `StreamsServer` (DurableStreamsServer interface) for SSE event publishing.

### Methods

| Method | Description |
|--------|-------------|
| `registerDaemon(payload)` | Store daemon info, clear previous daemon's sessions, start heartbeat check, publish `daemon-connected` |
| `handleHeartbeat(daemonId, sessionCount)` | Update `lastHeartbeatAt`, return false if unknown daemon |
| `deregisterDaemon(daemonId)` | Clear daemon + all sessions, stop heartbeat check, publish `daemon-disconnected` |
| `ingestSessions(daemonId, sessions, removedIds)` | Update session cache, publish updates + status changes + removals |
| `isDaemonConnected()` | Boolean check |
| `getDaemon()` | Return DaemonInfo or null |
| `getSessions()` | Return all sessions as array |
| `getSessionCount()` | Return session count |
| `getStatus()` | Return `{ connected, daemon, sessionCount }` |
| `addRealtimeSubscriber(callback)` | Subscribe to SSE events, returns unsubscribe function |
| `destroy()` | Clear timers, sessions, daemon — called on server shutdown |

### Session Eviction

When `ingestSessions` would exceed 10,000 sessions, the oldest sessions (by `lastActivityAt`) are evicted first. Each eviction publishes a `session-removed` event.

### Heartbeat Monitor

- Checked every 10s via `setInterval`
- If `lastHeartbeatAt` older than 30s → auto-deregister daemon
- Deregistration clears all sessions and publishes `daemon-disconnected`

### Event Publishing

All events published to the `cli-monitor` stream via DurableStreamsServer. Publish failures are logged but don't throw.

---

## API Routes

### Daemon → Server (4 endpoints)

#### `POST /api/cli-monitor/register`

Register daemon with the server.

**Request:**

```json
{
  "daemonId": "dm_a1b2c3d4",
  "pid": 12345,
  "version": "0.1.0",
  "watchPath": "/Users/me/.claude/projects",
  "capabilities": [],
  "startedAt": 1706745600000
}
```

**Response:** `{ "ok": true }`

**Validation:** Zod schema — daemonId (1-200 chars), pid (positive int), version (1-50 chars), watchPath (1-1000 chars).

---

#### `POST /api/cli-monitor/heartbeat`

Daemon keepalive signal.

**Request:**

```json
{
  "daemonId": "dm_a1b2c3d4",
  "sessionCount": 5
}
```

**Response:** `{ "ok": true }` or `404` if daemon not registered.

---

#### `POST /api/cli-monitor/ingest`

Batched session updates from daemon.

**Request:**

```json
{
  "daemonId": "dm_a1b2c3d4",
  "sessions": [{ "sessionId": "...", "status": "working", ... }],
  "removedSessionIds": ["uuid-1", "uuid-2"]
}
```

**Limits:**
- `sessions` array max 500 items
- `removedSessionIds` array max 500 items
- `goal` max 500 chars, `recentOutput` max 1000 chars

**Response:** `{ "ok": true }` or `404` if daemon not registered.

---

#### `POST /api/cli-monitor/deregister`

Daemon shutdown notification.

**Request:**

```json
{
  "daemonId": "dm_a1b2c3d4"
}
```

**Response:** `{ "ok": true }`

---

### Frontend → Server (3 endpoints)

#### `GET /api/cli-monitor/status`

Check daemon connection state.

**Response:**

```json
{
  "ok": true,
  "data": {
    "connected": true,
    "daemon": { "daemonId": "...", "pid": 12345, "version": "0.1.0", ... },
    "sessionCount": 5
  }
}
```

---

#### `GET /api/cli-monitor/sessions`

Paginated session list.

**Query params:** `?limit=100&offset=0`

| Param | Default | Range |
|-------|---------|-------|
| `limit` | 100 | 1-500 |
| `offset` | 0 | 0+ |

**Response:**

```json
{
  "ok": true,
  "data": {
    "sessions": [...],
    "total": 42,
    "connected": true
  }
}
```

---

#### `GET /api/cli-monitor/stream`

SSE endpoint for real-time updates.

**Connection limit:** 50 concurrent. Returns `429` when exceeded.

**Event flow:**

1. On connect: send full snapshot (all sessions + daemon info)
2. Subscribe to live updates from DurableStreamsServer
3. Keep-alive ping (`: ping\n\n`) every 15s

**Response headers:**

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

---

## Request Validation

### Body Size Limit

All POST endpoints check `Content-Length` header before parsing JSON. Requests exceeding 5MB return `413 Payload Too Large`.

### Zod Schemas

Every POST payload is validated with Zod. Validation errors return:

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "First validation issue message"
  }
}
```

Status: `400`

### Error Codes

| Code | Status | When |
|------|--------|------|
| `VALIDATION_ERROR` | 400 | Zod validation failed |
| `INVALID_JSON` | 400 | JSON parse failed |
| `PAYLOAD_TOO_LARGE` | 413 | Content-Length > 5MB |
| `UNKNOWN_DAEMON` | 404 | Heartbeat/ingest from unregistered daemon |
| `TOO_MANY_CONNECTIONS` | 429 | SSE connection limit reached |

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

## Router Integration

The CLI monitor routes are conditionally mounted in `src/server/router.ts`:

```typescript
if (deps.cliMonitorService) {
  app.route('/api/cli-monitor', createCliMonitorRoutes({ cliMonitorService: deps.cliMonitorService }));
}
```

The `cliMonitorService` is optional in `RouterDependencies`. When not provided (e.g., if DurableStreamsServer is unavailable), the routes are not mounted.
