# Durable Streams Integration

AgentPane uses Caddy's `durable_streams` plugin (via `@durable-streams/*` packages) for real-time event delivery. Events are produced by backend services, persisted in SQLite (`session_events`) for durability, and fanned out to browsers via SSE.

## Known-good version matrix

These versions are **exact-pinned** in `package.json` (no caret). See finding F05-14 for history.

| Package | Version | Role |
| --- | --- | --- |
| `@durable-streams/client` | `0.2.3` | Client-side `durableStream`, `IdempotentProducer`, `DurableStream` |
| `@durable-streams/server` | `0.3.1` | Used by `DurableStreamTestServer` (dev) and Caddy plugin |
| `@durable-streams/state` | `0.2.5` | State primitives used by server |

At 0.x semver, a minor bump is a breaking change. Do not upgrade without:
1. Running the contract test: `bunx vitest run tests/integration/durable-streams-contract.test.ts`
2. Exercising the full stream flow in dev (task → plan → execute → complete)
3. Updating this matrix in the same PR

## Stream-ID conventions

Stream IDs carry a prefix that routes them to the correct SSE URL:

| Prefix | Format | URL path | Persistence |
| --- | --- | --- | --- |
| (none, bare CUID) | `{sessionId}` | `/v1/stream/sessions/{id}` | DB + Caddy |
| `plan:` | `plan:{planSessionId}` | `/v1/stream/plans/{id}` | DB + Caddy |
| `sandbox:` | `sandbox:{sandboxId}` | `/v1/stream/sandboxes/{id}` | DB + Caddy |
| `terraform:` | `terraform:{jobId}` | `/v1/stream/terraform/{id}` | Caddy only (ephemeral) |
| `cli-monitor` | (literal) | `/v1/stream/cli-monitor` | DB + Caddy |

Branded types are declared in `src/lib/streams/stream-id.ts`; always construct stream IDs via the `planStreamId(...)`, `sandboxStreamId(...)`, `terraformStreamId(...)`, and `sessionStreamId(...)` factory functions rather than manual string concatenation (F05-01).

## Authentication

Caddy stream endpoints use `forward_auth` against `POST /api/auth/verify-stream`. That handler validates the session cookie and the stream scope (e.g. a `plan:*` stream requires that the user has access to the referenced plan session). See `src/server/routes/auth.ts` `verify-stream` handler (F05-07).

In local development, `forward_auth` is not configured because the `DurableStreamTestServer` on port 3002 handles streams. Enable `forward_auth` via the `Caddyfile` in production. The handler is still useful for manual verification (`curl -X POST http://localhost:3001/api/auth/verify-stream -H 'X-Original-URI: /v1/stream/sessions/abc' -H 'Cookie: ...'`).

## Outbox relay

Writes to durable streams are dual-write: the producing service inserts into the `event_outbox` table in the same transaction as the state change, then the `EventOutboxRelayService` (`src/services/event-outbox-relay.service.ts`) polls every 50ms and publishes to Caddy. Failed publishes re-queue with exponential backoff (up to 30s). Published rows are deleted after success.

See F05-05 for rationale. The relay is optional for services that prefer direct `DurableStreamsService.publish`, but durable guarantees only apply to the outbox path.

## Metrics

`DurableStreamsService` exports a publish-lag gauge (F05-13) readable via `GET /api/admin/metrics/streams`. A sustained p95 > 500 ms over 30 s triggers a `SIGNAL_PAUSE` hint on the publish Result, allowing callers (notably agent execution) to throttle. Plan-mode dropped-event counts are available at `GET /api/admin/metrics/plan-mode` (F05-02).
