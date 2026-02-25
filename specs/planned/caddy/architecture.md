# Caddy Front Door Architecture

## Target Architecture

```
Browser (:3000)
  |
  +-- /assets/*        -> Caddy serves static dist/ (gzip/br, immutable cache)
  +-- /*               -> Caddy try_files -> index.html (SPA fallback)
  +-- /v1/stream/*     -> Caddy durable_streams plugin (LMDB persistence)
  +-- /api/*           -> Caddy reverse_proxy -> Bun/Hono (:3001)
```

### Production (Docker)

```
Docker Container
  +-- durable-streams-server (Caddy) on :3000 (exposed)
  |     +-- /assets/*    -> /app/dist/ (gzip/br, immutable cache)
  |     +-- /*           -> try_files -> /app/dist/index.html
  |     +-- /v1/stream/* -> durable_streams (LMDB at /app/data/streams)
  |     +-- /api/*       -> reverse_proxy localhost:3001
  +-- Bun API on :3001 (internal only)
        +-- /api/*       -> Hono routes (no SSE, no static serving)
```

### Development

```
  +-- Vite Dev Server on :3000 (HMR, SPA)
  |     +-- /api/*           -> proxy -> Bun :3001
  |     +-- /v1/stream/*     -> proxy -> DurableStreamTestServer :3002
  +-- Bun API on :3001
  +-- DurableStreamTestServer on :3002 (from @durable-streams/server npm)
```

## Event Flow (After Migration)

### Publish (Server-side)
```
Business logic (agent, task, sandbox services)
  -> DurableStreamsService.publish(streamId, type, data)
     -> 1. IdempotentProducer.append() -> Caddy /v1/stream/{path} (LMDB)
     -> 2. Async persist to sessionEvents DB table (for SQL queries)
```

### Subscribe (Client-side)
```
React hook (use-session, use-container-agent, etc.)
  -> @durable-streams/client stream() with live: true
     -> SSE connection to /v1/stream/sessions/{sessionId}
     -> subscribeJson() delivers typed event batches
     -> mapRawEventToTyped() + routeEventToCallback() (unchanged)
```

## Stream URL Schema

| Stream ID (current) | Caddy URL Path |
|---------------------|----------------|
| `{sessionId}` | `/v1/stream/sessions/{sessionId}` |
| `cli-monitor` | `/v1/stream/cli-monitor` |
| `terraform:{jobId}` | `/v1/stream/terraform/{jobId}` |
| `plan:{sessionId}` | `/v1/stream/plans/{sessionId}` |

## Port Allocation

| Port | Dev | Production |
|------|-----|------------|
| 3000 | Vite (HMR) | Caddy (front door) |
| 3001 | Bun API | Bun API (internal) |
| 3002 | DurableStreamTestServer | N/A (Caddy plugin) |
