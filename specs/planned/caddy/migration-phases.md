# Migration Phases

## Phase 1: Infrastructure (Caddy + Docker)

No behavior changes. Caddy proxies everything through to Bun.

### 1.1 Create Caddyfile
- New file: `Caddyfile` (see caddyfile.md)

### 1.2 Update Dockerfile
- File: `docker/Dockerfile`
- Add stage to download `durable-streams-server` binary
- Copy `Caddyfile` to `/app/Caddyfile`
- Create `/app/data/streams` directory
- Change `EXPOSE 3001` to `EXPOSE 3000`
- Replace `CMD` with entrypoint script

### 1.3 Create entrypoint script
- New file: `docker/start.sh`
- Starts Caddy in background, Bun in foreground
- Handles signal propagation via `trap`

### 1.4 Update docker-compose.yml
- File: `docker/docker-compose.yml`
- Port mapping: `3000:3000` (remove 3001 exposure)
- Add volume: `agentpane-streams:/app/data/streams`
- Remove `CORS_ORIGIN` (same-origin now)
- Update healthcheck to `:3000/healthz`

### 1.5 Dev startup
- File: `scripts/start-dev.ts`
- Add DurableStreamTestServer on :3002
- New file: `scripts/start-streams-server.ts`

### 1.6 Update Vite proxy
- File: `vite.config.ts`
- Add proxy: `/v1/stream` -> `http://localhost:3002`

### Verification
- `npm run dev` starts 3 processes (Vite, Bun, streams)
- `docker compose up` starts Caddy + Bun
- Static files served at `:3000`
- API proxied through Caddy to Bun
- `/v1/stream/*` responds (empty streams)

---

## Phase 2: Server-Side Producer Migration

Replace `InMemoryDurableStreamsServer` with Caddy-backed producer.

### 2.1 Create CaddyDurableStreamsServer adapter
- New file: `src/lib/streams/caddy-producer.ts`
- Implements `DurableStreamsServer` interface
- Uses `@durable-streams/client` `IdempotentProducer` for writes
- Maps stream IDs to URL paths (see architecture.md URL schema)
- Lazy stream creation on first publish

### 2.2 Swap in api.ts
- File: `src/server/api.ts`
- Replace `new InMemoryDurableStreamsServer()` (line 574) with `new CaddyDurableStreamsServer()`
- Add `CADDY_STREAMS_URL` env var (default: `http://localhost:3000/v1/stream`)
- In dev, set to `http://localhost:3002/v1/stream`

### 2.3 Simplify DurableStreamsService
- File: `src/services/durable-streams.service.ts`
- `publish()`: Keep DB dual-write, replace in-memory publish with Caddy publish
- Remove: `addSubscriber()`, `notifySubscribers()`, local subscriber Map
- Remove: `getServer()` method (clients subscribe directly to Caddy)
- Keep: `StreamEventMap`, typed publish helpers, DB persistence

### 2.4 Simplify SessionStreamService
- File: `src/services/session/session-stream.service.ts`
- `publish()` calls through to Caddy via DurableStreamsServer interface
- Remove dual in-memory + DB write (Caddy is primary, DB is async secondary)

### 2.5 Update CLI Monitor
- File: `src/services/cli-monitor/cli-monitor.service.ts`
- Replace `addRealtimeSubscriber()` / `getEvents()` usage
- Publish via the same DurableStreamsServer interface → Caddy

### Verification
- Events published to Caddy appear at `/v1/stream/sessions/{id}`
- `sessionEvents` DB table still populated
- Existing SSE endpoint still works (reads from Caddy now)

---

## Phase 3: Client-Side Consumer Migration (Durable Streams)

Replace custom DurableStreamsClient with @durable-streams/client.

### 3.1 Rewrite streams client
- File: `src/lib/streams/client.ts`
- Replace custom EventSource wrapper (~1107 lines) with @durable-streams/client wrapper (~200 lines)
- Use `DurableStream.connect()` + `.stream({ live: true })` + `.subscribeJson()`
- Preserve: `SessionCallbacks` interface, `Subscription` return type
- Preserve: `mapRawEventToTyped()` function (validates same RawSessionEvent shape)
- Preserve: `routeEventToCallback()` function
- URL: `/v1/stream/sessions/{sessionId}` (relative, goes through Vite proxy in dev, Caddy in prod)

### 3.2 Consumer hooks — no changes needed
These all use `subscribeToSession()` from the client:
- `src/app/hooks/use-session.ts` — unchanged
- `src/app/hooks/use-agent-stream.ts` — unchanged
- `src/app/hooks/use-container-agent.ts` — unchanged
- `src/app/hooks/use-container-agent-statuses.ts` — unchanged
- `src/app/components/features/task-detail-dialog/use-task-activity.ts` — unchanged

### Verification
- Browser connects to `/v1/stream/sessions/{id}` via SSE
- Events flow from Caddy → browser (not through Hono)
- Reconnection works (disconnect wifi, reconnect)
- Offset-based resume works

---

## Phase 4: Migrate Terraform Compose SSE

Move the Terraform compose streaming from custom SSE to durable streams.

### 4.1 Server-side
- File: `src/services/terraform-compose.service.ts`
- Replace custom SSE response with publishing to Caddy stream
- Stream path: `/v1/stream/terraform/{jobId}`
- Events: `text`, `code`, `questions`, `error`, `done`

### 4.2 Client-side
- File: `src/app/components/features/terraform/terraform-context.tsx`
- Replace manual fetch + ReadableStream parsing with @durable-streams/client subscription
- Remove `extractHclFromText` fallback (events are structured, not raw text)

### Verification
- Terraform compose chat works end-to-end
- Code extraction from streaming events works
- Error handling preserved

---

## Phase 5: Migrate Plan Session SSE

Move plan session streaming from raw EventSource to durable streams.

### 5.1 Server-side
- Plan events already publish via `DurableStreamsService` (plan:started, plan:turn, etc.)
- Stream path: `/v1/stream/plans/{sessionId}`

### 5.2 Client-side
- File: `src/app/components/features/plan-session-view/use-plan-session.ts`
- Replace raw `EventSource` (line 157) with @durable-streams/client subscription
- Map plan event types to existing handlers

### Verification
- Plan session view shows streaming text
- Interactions (clarifying questions) work
- Plan completion/error events handled

---

## Phase 6: Cleanup

Remove dead code after all consumers migrated.

### 6.1 Remove custom SSE endpoint
- File: `src/server/routes/sessions.ts`
- Delete: SSE endpoint at `GET /api/sessions/:id/stream` (lines 368-575)
- Delete: `sseConnections` tracking Map (line 119)

### 6.2 Remove InMemoryDurableStreamsServer
- Delete file: `src/lib/streams/server.ts` (224 lines)
- Remove: `InMemoryDurableStreamsServer` class from `src/server/api.ts` (lines 450-571)

### 6.3 Simplify provider
- File: `src/lib/streams/provider.ts`
- Simplify or remove if no longer needed

### 6.4 Remove Terraform SSE endpoint
- File: `src/server/routes/terraform.ts`
- Remove custom SSE streaming code (replaced by Caddy streams)

### 6.5 Update CORS config
- File: `src/server/router.ts`
- CORS no longer needed for browser requests (same-origin via Caddy)
- Keep for any direct API access patterns

### Verification
- All tests pass
- No references to removed code
- `npm run dev` and `docker compose up` both work
- All streaming features work end-to-end
