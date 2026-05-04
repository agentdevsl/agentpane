# 03 - Streaming and Observability

## Verdict

The streaming stack has moved forward significantly. Stream IDs are validated, Caddy auth is stronger for the main stream kinds, plan-mode drop counters are exposed, and the outbox relay is no longer dead code. The remaining problem is split delivery architecture: `DurableStreamsService.publish()` uses the outbox for most durable streams, while `SessionService` still publishes live events directly to Caddy after DB persistence.

## Findings

### MAY-05 - P1 - Core session events bypass the outbox

`SessionService` is constructed with `CaddyDurableStreamsServer` (`src/server/bootstrap/service-container.ts:175`). `SessionStreamService.publish()` persists the event, then calls `this.streams.publish()` directly, best-effort (`src/services/session/session-stream.service.ts:149`, `src/services/session/session-stream.service.ts:165`).

Impact: core agent/session events retain the same live-delivery failure mode the outbox was intended to remove.

Recommendation: route session publishing through the outbox-backed `DurableStreamsService`, or enqueue outbox rows inside `SessionStreamService.publish()`.

### MAY-06 - P1 - Outbox enqueue is not transactional with event persistence

`DurableStreamsService.publish()` persists into `session_events` first (`src/services/durable-streams.service.ts:790`), then calls `enqueueOutboxEvent()` as a separate write (`src/services/durable-streams.service.ts:826`). The helper itself documents that it should be called within the producing transaction (`src/services/event-outbox-relay.service.ts:217`), but the current call path does not do that.

Impact: a crash between durable event insert and outbox enqueue leaves the event replayable from DB but never live-delivered to current subscribers.

Recommendation: wrap `session_events` insert and `event_outbox` insert in one transaction. If Drizzle dialect typing makes this awkward, isolate it in a repository with dialect-specific transaction helpers.

### MAY-12 - P1 - Gap detection exists but recovery is disabled

The session hook detects gaps, logs them, and explicitly says REST gap healing is disabled (`src/app/hooks/use-session.ts:466`, `src/app/hooks/use-session.ts:472`). `fetchGapEvents()` exists in the stream client (`src/lib/streams/client.ts:1504`) but is unused.

Impact: reconnects can identify missing offsets but cannot repair the UI timeline.

Recommendation: on `onGapDetected`, fetch the missing offset range, merge by event ID/offset, and surface unrecoverable gaps in the UI.

### MAY-30 - P1 - Backpressure is observability-only

`publishWithBackpressure()` exists but has no call sites. The current lag sample measures local publish/enqueue time, not outbox depth, oldest pending age, or downstream Caddy append acknowledgement.

Impact: high-volume token streams can overwhelm the delivery path while producers continue at full speed.

Recommendation: compute backpressure from outbox pending count, oldest pending age, and failed/dead counts. Make token publishers consume the signal and throttle.

### MAY-31 - P2 - Truncation is visible but not recoverable

`useSession` tracks when `MAX_CHUNKS` drops older chunks. The UI renders a truncation banner, but the actual session view does not pass a load-earlier callback, so users cannot recover earlier events.

Recommendation: track oldest durable offset, pass `onLoadEarlier`, fetch `beforeOffset`, and prepend deduped events.

### MAY-32 - P2 - Terraform compose stream auth is not tenant-scoped

The stream auth route keeps `terraform/:id` cookie-only because there is no DB entity to resolve ownership against. Terraform compose uses ephemeral stream IDs.

Impact: any authenticated browser session may subscribe to a guessed live terraform stream ID if IDs leak or are predictable enough through logs/UI.

Recommendation: store compose jobs with owner/codespace or issue short-lived signed stream tokens per job.

### MAY-33 - P2 - Outbox health is not surfaced

`EventOutboxRelayService.getCounts()` exposes pending/published/dead counts (`src/services/event-outbox-relay.service.ts:198`), but metrics routes focus on publish lag and do not expose dead row counts or oldest pending age.

Impact: the live-delivery guarantee can be broken while `/api/metrics` looks healthy.

Recommendation: expose pending, published, dead, attempts, and oldest pending age in admin metrics. Alert on dead rows.

### MAY-34 - P2 - Background job health snapshots are local-only

`BackgroundJobRegistry` can produce snapshots, but the registry is local to scheduler bootstrap and is not retained in the service container. Routes cannot expose job health.

Recommendation: store the registry in the service container and expose it in `/api/admin/metrics` or readiness detail.

### MAY-35 - P2 - Server-side `subscribe()` no-ops

`CaddyDurableStreamsServer.subscribe()` remains a silent no-op async iterator. Future server consumers can iterate it and receive nothing without an error.

Recommendation: remove it from the interface or throw `NOT_IMPLEMENTED`.

### MAY-36 - P2 - Error aggregation is still a stub

Correlation IDs and `captureException()` exist, but the Sentry path only logs a breadcrumb and there is no distributed span propagation across HTTP, agent execution, streams, and container runner.

Recommendation: either implement the real error-sink adapter and traces, or clearly document the current logger-only posture and expose enough IDs for manual correlation.

## Resolved or materially improved

- Stream-ID kind enforcement is live.
- Plan-mode dropped-event visibility exists.
- Caddy auth is stronger for sessions, plans, and sandboxes.
- The 50-connection in-process SSE cap is no longer the main bottleneck.
- `/api/metrics` exists as a JSON baseline.
