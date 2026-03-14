# Caddy Integration (Durable Streams Server)

## Overview

AgentPane uses a custom Caddy binary (`durable-streams-server`) as the production front door on port 3000. This binary is a standard Caddy server extended with the `durable_streams` plugin, which provides LMDB-backed Server-Sent Events (SSE) and long-poll streaming. Caddy serves three roles:

1. **Durable Streams** -- LMDB-backed event streaming at `/v1/stream/*` for real-time agent, plan, terraform, and CLI monitor events
2. **API Reverse Proxy** -- Proxies `/api/*` requests to the Bun/Hono backend on `:3001`
3. **Static File Server** -- Serves the built SPA from `/app/dist` with gzip/brotli compression and immutable cache headers

## Architecture

### Production (Docker)

```text
Docker Container
  +-- durable-streams-server (Caddy) on :3000 (exposed)
  |     +-- /healthz         -> responds "OK" 200
  |     +-- /v1/stream/*     -> durable_streams plugin (LMDB at /app/streams)
  |     +-- /api/*           -> reverse_proxy localhost:3001
  |     +-- /assets/*        -> /app/dist/ (gzip/br, immutable cache)
  |     +-- /*               -> try_files -> /app/dist/index.html (SPA fallback)
  +-- Bun API on :3001 (internal only)
        +-- /api/*           -> Hono routes
```

### Development

In development, Caddy is not used. Instead:

```text
  +-- Vite Dev Server on :3000 (HMR, SPA)
  |     +-- /api/*           -> proxy -> Bun :3001
  |     +-- /v1/stream/*     -> proxy -> DurableStreamTestServer :3002
  +-- Bun API on :3001
  +-- DurableStreamTestServer on :3002 (from @durable-streams/server npm)
```

The `DurableStreamTestServer` from `@durable-streams/server` provides the same streaming API as the Caddy plugin in development, running on port 3002. Vite proxies `/v1/stream` requests to it.

### Port Allocation

| Port | Development | Production |
|------|-------------|------------|
| 3000 | Vite (HMR + proxy) | Caddy (front door) |
| 3001 | Bun API | Bun API (internal) |
| 3002 | DurableStreamTestServer | N/A (Caddy plugin) |

## Configuration Files

### Caddyfile

**File:** `/Caddyfile`

The production Caddyfile configures all three routing concerns:

```caddyfile
{
  admin off
  auto_https off
}

:3000 {
  handle /healthz {
    respond "OK" 200
  }

  @streams path /v1/stream /v1/stream/*
  handle @streams {
    durable_streams {
      data_dir {$STREAMS_DATA_DIR:/app/data/streams}
      long_poll_timeout 30s
      sse_reconnect_interval 120s
    }
  }

  handle /api/* {
    reverse_proxy localhost:3001 {
      flush_interval -1
    }
  }

  handle {
    root * /app/dist
    encode gzip br
    try_files {path} /index.html
    file_server {
      precompressed gzip br
    }
    @immutable path /assets/*
    header @immutable Cache-Control "public, max-age=31536000, immutable"
  }
}
```

**Key directives:**

| Directive | Purpose |
|-----------|---------|
| `admin off` | Disables the Caddy admin API (not needed in production) |
| `auto_https off` | HTTPS is handled by external ingress/load balancer, not Caddy |
| `flush_interval -1` | Disables response buffering on `/api/*` so SSE passthrough works |
| `data_dir` | LMDB storage location for durable stream data, volume-mounted |
| `long_poll_timeout 30s` | Maximum wait time for long-poll consumers |
| `sse_reconnect_interval 120s` | SSE reconnect hint sent to clients |
| `precompressed gzip br` | Serves pre-compressed `.gz`/`.br` files when available |
| `try_files {path} /index.html` | SPA fallback for client-side routing |

### Dockerfile

**File:** `/docker/Dockerfile`

The multi-stage build downloads the `durable-streams-server` binary from GitHub releases:

```dockerfile
FROM alpine:3.21 AS caddy
ARG TARGETARCH
ADD https://github.com/anthropics/durable-streams/releases/download/v0.2.1/durable-streams-server_linux_${TARGETARCH} /usr/local/bin/durable-streams-server
RUN chmod +x /usr/local/bin/durable-streams-server
```

The binary and Caddyfile are copied into the runtime image. Port 3000 is exposed (Caddy's port, not Bun's).

### Entrypoint Script

**File:** `/docker/start.sh`

Starts Caddy in the background, waits for it to become healthy on `/healthz`, then starts Bun. Handles signal propagation via `trap` so both processes shut down cleanly. If either process exits, the other is killed.

### Docker Compose

**File:** `/docker/docker-compose.yml`

- Exposes port `3000:3000` (Caddy front door only; Bun on 3001 is internal)
- Mounts `agentpane-streams` volume at `/app/streams` for LMDB persistence
- Sets `CADDY_STREAMS_URL=http://localhost:3000/v1/stream` for the Bun API to publish events to Caddy
- Healthcheck targets `http://localhost:3000/healthz` (Caddy, not Bun)

### Vite Proxy (Development)

**File:** `/vite.config.ts` (lines 68-73)

In development, Vite proxies `/v1/stream` requests to `http://localhost:3002` (the DurableStreamTestServer) with `timeout: 0` for long-lived SSE connections.

### Dev Streams Server

**File:** `/scripts/start-streams-server.ts`

Starts a `DurableStreamTestServer` from `@durable-streams/server` on port 3002 (configurable via `STREAMS_PORT`). This provides the same streaming API as Caddy's `durable_streams` plugin for local development.

## Durable Streams Integration

### Stream URL Schema

Internal stream IDs are mapped to URL paths by the `streamIdToPath()` function:

| Internal Stream ID | Caddy URL Path |
|--------------------|----------------|
| `{sessionId}` | `/v1/stream/sessions/{sessionId}` |
| `cli-monitor` | `/v1/stream/cli-monitor` |
| `terraform:{jobId}` | `/v1/stream/terraform/{jobId}` |
| `plan:{sessionId}` | `/v1/stream/plans/{sessionId}` |

### Server-Side: CaddyDurableStreamsServer

**File:** `/src/lib/streams/caddy-producer.ts`

The `CaddyDurableStreamsServer` class implements the `DurableStreamsServer` interface and uses `IdempotentProducer` from `@durable-streams/client` to publish events to Caddy (or `DurableStreamTestServer` in dev).

Key behaviors:
- **Lazy stream creation** -- Streams are created on first publish via PUT (idempotent; `CONFLICT_EXISTS` is handled gracefully)
- **Producer caching** -- Each stream ID gets a cached `IdempotentProducer` instance, with deduplication of concurrent initialization
- **Auto-recovery** -- If a producer encounters an error or is closed, it is invalidated and re-created on the next publish
- **NDJSON format** -- Events are serialized as `{type, data, timestamp}` JSON lines

Producer configuration:
- `autoClaim: true` -- Automatically claim producer ownership
- `lingerMs: 5` -- Batch events within 5ms window
- `maxBatchBytes: 1_048_576` -- 1 MB max batch size
- `maxInFlight: 5` -- Up to 5 concurrent in-flight batches

**Note:** Server-side `subscribe()` is a no-op (returns empty async iterable). Clients subscribe directly to Caddy SSE endpoints.

### Server-Side: DurableStreamsService

**File:** `/src/services/durable-streams.service.ts`

The `DurableStreamsService` wraps `CaddyDurableStreamsServer` and adds:
- **Database dual-write** -- Events are persisted to the `sessionEvents` SQLite table first, then published to Caddy. DB persistence ensures durability; Caddy publish is best-effort for real-time delivery.
- **Type-safe publishing** -- The `StreamEventMap` interface enforces correct data shapes at compile time for 40+ event types across plan, sandbox, container-agent, task-creation, and terraform event families.

### Server-Side: Initialization

**File:** `/src/server/api.ts` (lines 533-540)

```typescript
const streamsServerUrl =
  process.env.CADDY_STREAMS_URL ??
  (process.env.NODE_ENV === 'production'
    ? 'http://localhost:3000/v1/stream'
    : 'http://localhost:3002/v1/stream');
const caddyStreamsServer = new CaddyDurableStreamsServer(streamsServerUrl);
```

### Client-Side: Bootstrap

**File:** `/src/lib/bootstrap/phases/streams.ts`

The bootstrap phase verifies that the streams endpoint is reachable (via `HEAD /v1/stream`). A 404 response is treated as success (endpoint exists, no streams yet). This works in both browser (uses `window.location.origin`) and SSR contexts (falls back to `CADDY_STREAMS_URL` or `http://localhost:3000`).

### Client-Side: Subscription

Clients subscribe directly to Caddy SSE endpoints using `@durable-streams/client`. The subscription URL is relative (e.g., `/v1/stream/sessions/{sessionId}`), which routes through Vite's proxy in dev or directly to Caddy in production. Consumer hooks (`use-session`, `use-agent-stream`, `use-container-agent`, etc.) use a shared `subscribeToSession()` function that wraps `DurableStream.connect()` and `subscribeJson()`.

## TLS / Certificate Management

Caddy's `auto_https` is explicitly disabled (`auto_https off`). In production deployments, TLS termination is handled by the external infrastructure (Kubernetes ingress, cloud load balancer, or reverse proxy) sitting in front of the Docker container. Caddy listens on plain HTTP on port 3000.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CADDY_STREAMS_URL` | `http://localhost:3000/v1/stream` (prod) / `http://localhost:3002/v1/stream` (dev) | URL the Bun API uses to publish events to the streams server |
| `STREAMS_DATA_DIR` | `/app/data/streams` | LMDB data directory for durable streams (Caddyfile) |
| `STREAMS_PORT` | `3002` | Dev-mode DurableStreamTestServer port |

## Event Flow

### Publish (Server to Caddy)

```text
Business logic (agent, task, sandbox, terraform services)
  -> DurableStreamsService.publish(streamId, type, data)
     -> 1. persistToDb() -> sessionEvents table (SQLite, durable)
     -> 2. CaddyDurableStreamsServer.publish() -> IdempotentProducer.append()
            -> HTTP POST to Caddy /v1/stream/{path} (LMDB, real-time)
```

### Subscribe (Client from Caddy)

```text
React hook (use-session, use-container-agent, use-plan-session, etc.)
  -> @durable-streams/client stream({ live: true })
     -> SSE connection to /v1/stream/sessions/{sessionId}
     -> subscribeJson() delivers typed event batches
     -> mapRawEventToTyped() + routeEventToCallback()
```

## File Reference

| File | Purpose |
|------|---------|
| `Caddyfile` | Production Caddy configuration |
| `docker/Dockerfile` | Downloads `durable-streams-server` binary, copies Caddyfile |
| `docker/start.sh` | Entrypoint: starts Caddy + Bun with signal handling |
| `docker/docker-compose.yml` | Port mapping, volumes, env vars for production |
| `vite.config.ts` | Dev proxy for `/v1/stream` to port 3002 |
| `scripts/start-streams-server.ts` | Dev-mode DurableStreamTestServer |
| `src/lib/streams/caddy-producer.ts` | CaddyDurableStreamsServer adapter |
| `src/services/durable-streams.service.ts` | Centralized publish with DB dual-write |
| `src/services/session/session-stream.service.ts` | Session-specific event streaming |
| `src/lib/bootstrap/phases/streams.ts` | Client bootstrap: verifies streams reachability |
| `tests/lib/streams/caddy-producer.test.ts` | Unit tests for CaddyDurableStreamsServer |

## Testing

**File:** `/tests/lib/streams/caddy-producer.test.ts`

Unit tests mock `@durable-streams/client` (`DurableStream` and `IdempotentProducer`) and verify:
- Stream ID to URL path mapping for all four stream types
- CONFLICT_EXISTS handling on stream creation
- Monotonically increasing local offsets per stream
- Producer cache reuse and invalidation on error
- deleteStream cleanup behavior
