# File Inventory

## New Files (6)

| File | Purpose | Phase |
|------|---------|-------|
| `Caddyfile` | Caddy server configuration (static, streams, proxy) | 1 |
| `docker/start.sh` | Entrypoint starting Caddy + Bun | 1 |
| `src/lib/streams/caddy-producer.ts` | CaddyDurableStreamsServer adapter (DurableStreamsServer interface backed by IdempotentProducer) | 2 |
| `scripts/start-streams-server.ts` | Dev-mode DurableStreamTestServer on :3002 | 1 |
| `Caddyfile.dev` | Optional dev Caddyfile (if needed for local Caddy testing) | 1 |

## Modified Files (13)

| File | Changes | Phase |
|------|---------|-------|
| `docker/Dockerfile` | Add Caddy binary download, copy Caddyfile, create streams dir, change EXPOSE/CMD | 1 |
| `docker/docker-compose.yml` | Port 3000, streams volume, remove CORS_ORIGIN, update healthcheck | 1 |
| `scripts/start-dev.ts` | Start DurableStreamTestServer as 3rd process | 1 |
| `vite.config.ts` | Add `/v1/stream` proxy to :3002 | 1 |
| `src/server/api.ts` | Replace InMemoryDurableStreamsServer with CaddyDurableStreamsServer, add CADDY_STREAMS_URL env | 2 |
| `src/services/durable-streams.service.ts` | Remove local subscribers, simplify publish (Caddy primary, DB secondary) | 2 |
| `src/services/session/session-stream.service.ts` | Simplify publish flow | 2 |
| `src/services/cli-monitor/cli-monitor.service.ts` | Use DurableStreamsServer interface for publish | 2 |
| `src/lib/streams/client.ts` | Rewrite: custom EventSource → @durable-streams/client wrapper (~1107→~200 lines) | 3 |
| `src/services/terraform-compose.service.ts` | Replace custom SSE with Caddy stream publishing | 4 |
| `src/app/components/features/terraform/terraform-context.tsx` | Replace fetch+ReadableStream with @durable-streams/client | 4 |
| `src/app/components/features/plan-session-view/use-plan-session.ts` | Replace raw EventSource with @durable-streams/client | 5 |
| `src/server/router.ts` | Simplify CORS (same-origin via Caddy) | 6 |

## Deleted Files / Code (Phase 6)

| Target | Lines | Reason |
|--------|-------|--------|
| `src/lib/streams/server.ts` | 224 | InMemoryDurableStreamsServer replaced by Caddy |
| `src/server/api.ts` lines 450-571 | ~120 | InMemoryDurableStreamsServer class in api.ts |
| `src/server/routes/sessions.ts` lines 119, 368-575 | ~210 | Custom SSE endpoint + connection tracking |
| `src/server/routes/terraform.ts` SSE code | ~100 | Custom Terraform SSE endpoint |

## Unchanged Consumer Files (5)

| File | Reason |
|------|--------|
| `src/app/hooks/use-session.ts` | Uses `subscribeToSession()` — same API preserved |
| `src/app/hooks/use-agent-stream.ts` | Same API |
| `src/app/hooks/use-container-agent.ts` | Same API |
| `src/app/hooks/use-container-agent-statuses.ts` | Same API |
| `src/app/components/features/task-detail-dialog/use-task-activity.ts` | Same API |

## Reused Code (Preserved)

| Code | File | Reason |
|------|------|--------|
| `mapRawEventToTyped()` | `src/lib/streams/client.ts` | Zod validation of 40+ event types — works on same RawSessionEvent shape |
| `routeEventToCallback()` | `src/lib/streams/client.ts` | Routes typed events to SessionCallbacks |
| `SessionCallbacks` interface | `src/lib/streams/client.ts` | Public API consumed by all hooks |
| `StreamEventMap` types | `src/services/durable-streams.service.ts` | Compile-time type safety for publish |
| `sessionSchema` | `src/lib/integrations/durable-streams/schema.ts` | @durable-streams/state schema (already using the package) |
| Typed publish helpers | `src/services/durable-streams.service.ts` | `publishPlanStarted()`, etc. — unchanged |

## Environment Variables

| Variable | Default | Where |
|----------|---------|-------|
| `CADDY_STREAMS_URL` | `http://localhost:3000/v1/stream` (prod) / `http://localhost:3002/v1/stream` (dev) | `src/lib/streams/caddy-producer.ts` |
| `STREAMS_DATA_DIR` | `/app/data/streams` | `Caddyfile` |
