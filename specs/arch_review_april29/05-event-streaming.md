# 05 — Event Streaming (April 29 Review)

Theme: Durable Streams + Caddy fan-out, SSE endpoints, `session_events` dual-write, stream-ID conventions (`plan:`/`sandbox:`/`terraform:`), reconnect/gap detection, dropped-event tracking, transactional outbox, client-side buffering. HEAD `25c1c4f0`. Hard constraints honoured: no Redis or external MQ — events stay on Durable Streams + Caddy + SQLite/Postgres `session_events`.

## Summary

PR #176 (merged 2026-04-20) shipped substantial work against the April 20 review of this theme: the `MAX_SSE_CONNECTIONS=50` cap was lifted to a unified `EventRouter` with global cap 200 and per-user cap 10; a `stream-id.ts` module with branded types, prefix factories, and `expectedStreamIdKindForEventType`/`classifyStreamId` helpers landed and is wired into `DurableStreamsService.publish`; `PlanModeService.recordDroppedEvent` now logs per-increment and exposes per-type/per-reason breakdowns at `GET /api/admin/metrics/plan-mode`; `MAX_CHUNKS=5000` overflow now returns `truncated: true` + `truncatedCount`; client `onGapDetected` + `fetchGapEvents` and `onTerminalDisconnect` were added; Caddy now uses `forward_auth` to `POST /api/auth/verify-stream`; container-runner emits `agent:token:batch` envelopes with per-batch flush guarantees; an `event_outbox` schema, migration, and `EventOutboxRelayService` were added; admin metrics expose publish-lag p50/p95/max.

What did **not** ship in PR #176 (or shipped as code-without-callers):

- The **transactional outbox** has tables, migrations, a relay class, and integration tests, but **no producer ever calls `enqueueOutboxEvent`** and the relay is **never instantiated** in `service-container.ts`. The runtime dual-write in `DurableStreamsService.publish` still goes SQLite → Caddy with a debug-level swallow on Caddy failure. The infrastructure is dead code today (F05-19).
- The **branded `StreamId` types** are exported and imported, but every call site still passes raw strings. The `validateStreamIdKind` check at publish time **only logs `warn`**, never rejects — so the documented compile-time invariant is not enforced anywhere (F05-20). `publishSessionEvent` doesn't even call the validator.
- The `truncated` / `truncatedCount` state is plumbed through `useSession`, but **no feature component imports `TruncationBanner`** and no UI ever surfaces the flag. Same for `StreamReconnectBanner` and `onTerminalDisconnect`. The shared `useSessionSubscription` hook **does not proxy `onGapDetected` or `onTerminalDisconnect`** at all (F05-21). The capabilities exist on the client; the React tree never reaches them.
- The publish-backpressure metric is recorded and surfaced at `/api/admin/metrics/streams`, but `publishWithBackpressure` is **never called anywhere**, so `signalPause` reaches no agent (F05-22).
- Caddy `forward_auth` checks the session cookie but does **not** check that the cookie's user actually has access to the requested stream ID — any logged-in user can subscribe to any session/plan/sandbox (F05-23).
- Terraform compose remains durable-stream ephemeral with no in-memory or DB fallback for Caddy restart (F05-24 — same finding as the prior F05-12, still unresolved).
- `session_events.sessionId` still has no FK and no `streamKind` column (F05-25 — same finding as the prior F05-09, still unresolved).
- Producer pool LRU and shared subscription map remain healthy.

The pattern is encouraging — most prior P1 findings now have skeleton implementations — but a meaningful share of them stop one wiring step short of being effective. The next remediation pass should be measured by integration evidence: at least one production caller per new code path, and at least one component rendering each new UI surface.

## Map (post-PR-176)

- `src/services/durable-streams.service.ts` (1117 lines) — `publish<T>` with stream-ID kind validation (warn-only), publish-lag rolling window, ephemeral-Terraform branch, atomic INSERT...SELECT offset assignment, dual-write best-effort.
- `src/lib/streams/stream-id.ts` (110 lines, new) — `PlanStreamId`/`SandboxStreamId`/`TerraformStreamId`/`SessionStreamId`/`CliMonitorStreamId` brands; `planStreamId(id)`/`sandboxStreamId(id)`/`terraformStreamId(id)`/`sessionStreamId(id)` factories; `classifyStreamId`/`expectedStreamIdKindForEventType`/`assertStreamIdKind` runtime helpers.
- `src/lib/streams/caddy-producer.ts` — `streamIdToPath`, LRU pool (200 cap, 5-min idle, 60s sweep, `unref`-ed), `IdempotentProducer(lingerMs:5, maxBatchBytes:1MB, maxInFlight:5)`, retry on `ALREADY_CLOSED`, `subscribe()` returns immediate `{done:true}`.
- `src/lib/streams/client.ts` (1695 lines) — `subscribeToSession`, shared subscription multiplexer with 60s orphan audit, reconnect loop (`MAX_RECONNECT_ATTEMPTS=8`, exponential backoff to 30s), `onGapDetected` + `onTerminalDisconnect` callbacks, `fetchGapEvents` REST helper.
- `src/lib/events/event-router.ts` (165 lines, new) — unified SSE counter (global 200, per-user 10, anon-keyed), `acquireSseSlot(route, userId)` returning `USER_QUOTA_EXCEEDED | GLOBAL_CAP_EXCEEDED | ok`, settings overrides hook.
- `src/lib/events/event-bus.ts` — delegates to `EventRouter`; legacy `MAX_SSE_CONNECTIONS=200` exported for tests.
- `src/server/routes/events.ts:1075-1209` — `/api/events` SSE endpoint, calls `tryAcquireEventBusSlot(userId)`, returns 429/503 with `Retry-After`.
- `src/server/routes/cli-monitor.ts:393-510` — `/api/cli-monitor/stream` SSE endpoint, shares `EventRouter` via `acquireSseSlot('/api/cli-monitor/stream', userId)`.
- `src/server/routes/auth.ts:323-387` — `POST /api/auth/verify-stream` Caddy forward_auth handler.
- `src/server/routes/admin-metrics.ts` — `GET /api/admin/metrics/plan-mode` and `/streams` admin endpoints.
- `src/db/schema/sqlite/event-outbox.ts` (53 lines, new) + `src/db/migrations/0018_add_event_outbox.sql` — outbox table.
- `src/services/event-outbox-relay.service.ts` (224 lines, new) — relay class (50ms poll, 100/batch, 10 attempts, exp backoff to 30s, 30-min retention).
- `src/db/schema/sqlite/session-events.ts` — unchanged from April 20 review (4 indexes, no FK on `sessionId`).
- `Caddyfile` — `forward_auth localhost:3001 { uri /api/auth/verify-stream; copy_headers Cookie X-Original-URI }` on `@streams`.
- `src/app/hooks/use-session.ts:228` — `MAX_CHUNKS=5000`, returns `state.truncated`/`truncatedCount`.
- `src/app/hooks/use-session-subscription.ts` (131 lines) — shared SSE proxy, callback keys list does NOT include `onGapDetected` or `onTerminalDisconnect`.
- `src/app/components/ui/truncation-banner.tsx` + `stream-reconnect-banner.tsx` — UI primitives, **never imported**.
- `src/services/plan-mode.service.ts:62-167` — `recordDroppedEvent(eventType, streamId, error, ctx)` with structured warn log + `droppedByEventType`/`droppedByReason` maps.
- `agent-runner/src/event-emitter.ts:170-329` — `tokenBatch` buffer (`TOKEN_BATCH_SIZE=10`, `TOKEN_BATCH_FLUSH_MS=100`), emits `agent:token:batch`, `flushTokens()` called before every non-token event for ordering.
- `src/lib/agents/container-bridge.ts:425-442` — host-side decode of `agent:token:batch` back into individual `agent:token` events (so wire format to clients is unchanged).

## Findings

### F05-19 — Outbox infrastructure is dead code; dual-write still best-effort

- **Priority:** P0
- **Effort:** S (1 day to wire) / M (2-3 days for full producer migration)
- **Observation:** The `event_outbox` table (`src/db/schema/sqlite/event-outbox.ts`), migration `0018_add_event_outbox.sql`, helper `enqueueOutboxEvent` (`src/services/event-outbox-relay.service.ts:214-223`), and `EventOutboxRelayService` (lines 39-208) are all in tree. The integration test (`tests/integration/event-outbox-relay.test.ts`) exercises them. **No production code path calls `enqueueOutboxEvent`** (`grep -rn enqueueOutboxEvent src/ --include="*.ts"` returns only the helper definition). **`EventOutboxRelayService` is never instantiated** in `src/server/bootstrap/service-container.ts:140-180` (the streams section). And `DurableStreamsService.publish` still uses the unchanged best-effort dual-write (`src/services/durable-streams.service.ts:789-808`): persist to SQLite, then publish to Caddy, swallow Caddy failures at `log.debug`. The April 20 finding F05-05 ("dual-write still best-effort, no transactional outbox") is therefore unresolved — the code shipped, but it's effectively a stub.
- **Risk:** Same as F05-05 in the prior review: events durable in DB but missing from live SSE under any Caddy hiccup, no retry path, `droppedEventCount` (still in `plan-mode.service.ts`) still increments silently for the rest of the producers. The fact that the table and relay exist may also mislead operators into thinking the outbox is "live" — there's no admin signal that the relay isn't running, and `getCounts()` would always return zero.
- **Recommendation:**
  1. Instantiate `EventOutboxRelayService` in `service-container.ts` after the durable streams server, register with the `BackgroundJob` interface (already implemented), and start it in the bootstrap that already starts `EventCleanupService`. Stop in `shutdown.ts`.
  2. In `DurableStreamsService.publish`, replace the direct `await this.server.publish(...)` step with `await enqueueOutboxEvent(this.db, { streamId, type, payload })` inside the same transaction as `persistToDb`. The relay polls and publishes asynchronously.
  3. Keep the existing direct-publish path behind a feature flag (`STREAMS_USE_OUTBOX=true`) for one release so the rollback is one env-var flip.
  4. Add `outboxBacklog` and `outboxDeadCount` to the `/api/admin/metrics/streams` response so an unstarted relay is visible.
  5. Convert `plan-mode.service.ts` `recordDroppedEvent` sites to enqueue into the outbox instead of dropping — most plan publish failures disappear because the relay guarantees eventual delivery.
- **Links:** `src/services/event-outbox-relay.service.ts:39-208`; `src/db/schema/sqlite/event-outbox.ts`; `src/services/durable-streams.service.ts:789-808, 1095-1103`; `src/server/bootstrap/service-container.ts:140-180`. Prior review: `specs/arch_review_april/05-event-streaming.md` F05-05.

### F05-20 — Stream-ID kind validation is `log.warn`-only and skipped on `publishSessionEvent`

- **Priority:** P1
- **Effort:** XS (1 hour to flip warn → reject behind a flag) / S (1 day to migrate all call sites to branded factories)
- **Observation:** The new `validateStreamIdKind` (`src/services/durable-streams.service.ts:585-596`) computes the expected kind from the event type and the actual kind from `classifyStreamId`. On mismatch (line 738-743) it logs `log.warn('Stream ID kind mismatch (see F05-01)', ...)` and **continues to publish anyway**. The route is invariant-violating — a `plan:started` event published to a bare CUID will land in `session_events` and stream at `/v1/stream/sessions/{id}` regardless of the warning. Worse, `publishSessionEvent` (lines 1045-1115) does **not** call `validateStreamIdKind` at all, so session-typed events published to plan/sandbox stream IDs leak silently. The branded `StreamId` union exists in `src/lib/streams/stream-id.ts`, but every publish call site (e.g. `plan-mode.service.ts:234, 308, 435, 502, 584, 598, 625, 658, 726, 742`) still composes the prefix inline with `\`plan:${id}\``, never going through `planStreamId(id)`. The promised compile-time invariant is therefore not enforced.
- **Risk:** Stream-ID conventions remain best-practice, not contract. A future refactor that flips the prefix or migrates an entity name (project→codespace, task→skill) silently breaks streams. The `log.warn` line will accumulate in production logs without anyone wiring an alert. Operators will discover the issue when a user reports "the plan panel went silent."
- **Recommendation:** Three steps in order of cheapness:
  1. Promote the warn to a hard rejection in `validateStreamIdKind` — return the `AppError` from `publish` rather than ignoring it. Roll out behind `STREAMS_STRICT_KIND=true` and ratchet to default-on after one release.
  2. Apply the same validation in `publishSessionEvent` (the same single line).
  3. Migrate `plan-mode.service.ts`, `terraform-compose.service.ts`, `sandbox.service.ts`, and `container-bridge.ts` to use the brand factories: `streams.publish(planStreamId(session.id), 'plan:turn', ...)`. The brands then carry the invariant through TypeScript.
- **Links:** `src/services/durable-streams.service.ts:585-596, 738-743, 1045-1115`; `src/lib/streams/stream-id.ts:46-110`; `src/services/plan-mode.service.ts:234`. Prior review: F05-01.

### F05-21 — `useSessionSubscription` does not proxy `onGapDetected` or `onTerminalDisconnect`; banners never render

- **Priority:** P1
- **Effort:** XS (1 hour to add proxies) / S (half day to wire banners + truncation)
- **Observation:** The shared `subscribeToSession` in `src/lib/streams/client.ts:1595-1678` correctly enumerates `onGapDetected` and `onTerminalDisconnect` in its callback keys list (lines 1629-1630), so the underlying SSE multiplexer fans them out. But `src/app/hooks/use-session-subscription.ts:64-86` — the React hook every feature actually uses — has its own `keys: Array<keyof SessionCallbacks>` that **omits both callbacks**. Consumers of `useSessionSubscription` (the only path: `use-session.ts`, `use-agent-stream.ts`, `use-container-agent.ts`) cannot receive gap or terminal events. Separately, `useSession` returns `state.truncated`/`truncatedCount`, but `grep -rn 'TruncationBanner\|StreamReconnectBanner' src/app/components/features/` returns zero matches — `agent-session-view/index.tsx:147` calls `useSession` but never reads `state.truncated`. The `TruncationBanner` and `StreamReconnectBanner` components exist (`src/app/components/ui/truncation-banner.tsx`, `stream-reconnect-banner.tsx`) but are never imported anywhere.
- **Risk:** All three F05-04 / F05-06 / F05-15 capabilities (truncation visibility, gap detection, terminal-disconnect prompt) are unreachable from the UI. The April 20 review marked these as "implemented" — they are implemented at the API layer and sit one wiring step short of being user-visible.
- **Recommendation:**
  1. Add `'onGapDetected'` and `'onTerminalDisconnect'` to the `keys` array in `use-session-subscription.ts:64`. Two lines.
  2. In `use-session.ts`, register `onGapDetected: ({fromOffset, toOffset}) => void fetchGapEvents(sessionId, fromOffset, toOffset).then(merge into state)` and `onTerminalDisconnect: () => setTerminalDisconnect(true)`. Surface `terminalDisconnect` in the hook return.
  3. Render `<TruncationBanner truncated={state.truncated} truncatedCount={state.truncatedCount} onLoadEarlier={...} />` and `<StreamReconnectBanner show={terminalDisconnect} onReconnect={() => location.reload()} />` in `agent-session-view/index.tsx` and similar feature components. The two UI primitives already exist.
- **Links:** `src/lib/streams/client.ts:1595-1678` (correctly fans out); `src/app/hooks/use-session-subscription.ts:64-86` (omits the callbacks); `src/app/hooks/use-session.ts:385-454` (never registers them); `src/app/components/features/agent-session-view/index.tsx:147`; `src/app/components/ui/truncation-banner.tsx`, `stream-reconnect-banner.tsx`. Prior review: F05-04, F05-06, F05-15.

### F05-22 — `publishWithBackpressure` exists but no caller; `signalPause` reaches no agent

- **Priority:** P2
- **Effort:** S (half day)
- **Observation:** `DurableStreamsService.publishWithBackpressure` (`src/services/durable-streams.service.ts:830-839`) wraps `publish` with a `signalPause` derived from the rolling publish-lag p95. The `publishLagWindow` (lines 528-579) populates correctly on every publish. The metric is visible at `GET /api/admin/metrics/streams`. But `grep -rn 'publishWithBackpressure(' src/ --include="*.ts"` returns zero call sites. The agent execution path (`stream-handler.ts`, `chunk-batcher.ts`) and container bridge (`container-bridge.ts`) all call plain `streams.publish`. The backpressure mechanism cannot signal anyone, so under sustained 8-agent throughput, LMDB and Caddy memory pressure accumulate without slowing token streaming.
- **Risk:** Lower than F05-19 because backpressure is throughput-tail rather than correctness, but the original concern from F05-13 (LMDB memory growth at burst rates) remains. The metric exists for operators but does not feed back into producers.
- **Recommendation:** Convert the hot publish loops in `chunk-batcher.ts:90` (`publishRealtime`) and `container-bridge.ts:243` (`publish`) to call `publishWithBackpressure`, and on `signalPause: true` `await new Promise(r => setTimeout(r, 50))` before continuing the stream. That single sleep is enough to drain. Mark the change as best-effort throttling in CHANGELOG. Skip the change for `stream-handler.ts` topology events (they're low-frequency lifecycle).
- **Links:** `src/services/durable-streams.service.ts:830-839, 528-579`; `src/lib/agents/chunk-batcher.ts:90`; `src/lib/agents/container-bridge.ts:243`. Prior review: F05-13.

### F05-23 — Caddy `forward_auth` only checks "logged in", not "logged in to this stream"

- **Priority:** P1
- **Effort:** M (2-3 days, depends on scope-resolver shape)
- **Observation:** PR #176 wired Caddy `forward_auth localhost:3001 { uri /api/auth/verify-stream }` to `Caddyfile:25-32`. The handler at `src/server/routes/auth.ts:323-387` validates the URI shape (`/v1/stream/{kind}/{id}` regex), reads the session cookie, and verifies the cookie maps to a non-expired user session. **It never checks that the cookie's user has access to the requested stream ID** — the comment at line 319-322 explicitly acknowledges this: "path-level authorization (does THIS user have access to THIS plan/sandbox?) is a follow-up." The 200 response carries the resolved `streamKind` and `streamId` to the cookie, but Caddy ignores the body of a forward_auth 200. The current state is "any authenticated user can subscribe to any stream ID, including CUIDs from URL leakage or log scraping." This is a clear improvement over the April 20 unauthenticated state, but it's a partial fix — the original F05-07 risk (default-deny against unauthenticated network clients) is closed; the secondary risk (cross-tenant data leak via stream-ID guessing) is not.
- **Risk:** A user on team A who knows or guesses a session/plan/sandbox ID owned by team B can subscribe to its stream and observe live tool calls, plan turns, and chunked output. CUIDs are large enough that random guessing is impractical, but URL leakage (clipboard paste, screenshare, log extraction) is a realistic path.
- **Recommendation:** Extend the verify-stream handler to scope-check by stream kind:
  - `kind=sessions` → look up `sessions.codespaceId → codespaces.projectFolderId → teamProjectFolders.teamId`, assert the user is a member of `teamId`.
  - `kind=plans` → look up `planSessions.codespaceId → ...` (same path).
  - `kind=sandboxes` → look up `sandboxInstances.codespaceId → ...`.
  - `kind=terraform` → terraform jobs are user-scoped today; assert the requesting user matches the job's creator (add `terraform_compose_jobs.userId` if not present).
  - `kind=cli-monitor` → singleton stream, assert any authenticated user (current behavior).

  The scope check adds a single Drizzle query per stream subscription. Cache the team lookup at the user level for 60s to amortize. Return 403 (not 401) when the cookie is valid but the user lacks access.
- **Links:** `Caddyfile:14-32`; `src/server/routes/auth.ts:323-387`. Prior review: F05-07.

### F05-24 — Terraform compose ephemeral streams still lose data on Caddy restart mid-turn

- **Priority:** P2
- **Effort:** S (option B) to M (option A)
- **Observation:** No change since the prior F05-12. `DurableStreamsService.publish` still hits the `isEphemeral = streamId.startsWith('terraform:')` branch (`src/services/durable-streams.service.ts:774`) and skips the DB write. `TerraformComposeService.startCompose` deletes the stream on each turn (`src/services/terraform-compose.service.ts:139-141`) and `runPipeline` discards `fullResponse` once the pipeline ends. If Caddy restarts while a compose is mid-pipeline, the in-flight events that have already been published to LMDB but not yet delivered to the SSE client are gone, and the in-memory `ComposeSession.generatedCode` won't be set until the pipeline finishes — which it can't, because the Agent SDK session's stream throws on the next `publishEvent`. Reconnecting clients see no replay.
- **Risk:** Visible "spinner forever" UX after Caddy hiccups during compose. Not a correctness bug for the eventual `terraform:done` event (it's delivered when the pipeline runs to completion next turn), but it is for in-flight `terraform:text` deltas the user expects to see resume.
- **Recommendation:** Pick option B from the prior review:
  1. Buffer the full compose response in-memory on the API server, keyed by `sessionId`. When the SSE client reconnects, check the buffer and replay via a new `GET /api/terraform/compose/:sessionId/replay` endpoint.
  2. Cap the buffer at MAX_SESSIONS=100 (already enforced) and clear on `terraform:done` or `terraform:error`.
- **Links:** `src/services/durable-streams.service.ts:774-808`; `src/services/terraform-compose.service.ts:130-173`. Prior review: F05-12.

### F05-25 — `session_events.sessionId` schema still mixes stream kinds with no FK or `streamKind` discriminator

- **Priority:** P2
- **Effort:** M (1-2 days with migration)
- **Observation:** The schema (`src/db/schema/sqlite/session-events.ts:11-14`) is unchanged from April 20. The column comment continues to acknowledge that it stores bare CUIDs (sessions), `plan:*`, `sandbox:*`, and other prefix-namespaced stream IDs without an FK. Cleanup remains split across `src/services/session/session-crud.service.ts:281` (sessions), `src/services/codespace.service.ts:441-447` (plans + sandboxes), and `src/services/event-cleanup.service.ts` (age-based sweep). The stream-ID kind classifier (`stream-id.ts:76-85`) could derive the discriminator for free, but no column exists to store or index by it. New stream types added since April 20 (e.g. potential `task-creation:` or `terraform-replay:`) would need fresh cleanup paths.
- **Risk:** Same as the prior F05-09: orphan rows for any stream type whose owning entity is deleted by a path that forgets the explicit cleanup call. Adding the `task-creation:` ephemeral pattern (which is currently durable per the channel mapping at `durable-streams.service.ts:614`) creates new orphan classes.
- **Recommendation:** Same as the prior recommendation — add a `streamKind text not null` column populated from `classifyStreamId`, index `(streamKind, sessionId)`, and migrate existing rows with a backfill update. New stream types register with a small registry that the cleanup service enumerates. Migration is hot-table-touching; sequence the work for off-peak.
- **Links:** `src/db/schema/sqlite/session-events.ts:5-31`; `src/services/codespace.service.ts:441-447`; `src/services/session/session-crud.service.ts:279-281`. Prior review: F05-09.

### F05-26 — `subscribe()` no-op on `CaddyDurableStreamsServer` is still on the public interface

- **Priority:** P3
- **Effort:** XS (1 hour)
- **Observation:** Unchanged from prior F05-18. `CaddyDurableStreamsServer.subscribe` (`src/lib/streams/caddy-producer.ts:210-223`) returns an immediately-`{done:true}` async iterable, with the `RS-015` comment still claiming this is by design. The `DurableStreamsServer` interface (`durable-streams.service.ts:35-43`) still types `subscribe` as a real iterable. The relay service that *would* be a server-side consumer (`event-outbox-relay.service.ts`) doesn't iterate the stream — it polls SQLite and publishes — so the no-op is harmless for the implemented architecture, but it remains a footgun for any future server-side consumer (metrics aggregator, NATS bridge, etc.).
- **Risk:** Low. Misuse is silent.
- **Recommendation:** Either remove `subscribe` from the interface (encode "SSE-only" in the type) or `throw new Error('SUBSCRIBE_NOT_IMPLEMENTED — use direct SSE')`. One line.
- **Links:** `src/lib/streams/caddy-producer.ts:210-223`; `src/services/durable-streams.service.ts:35-43`. Prior review: F05-18.

### F05-27 — `@durable-streams/*` versions still pinned with carets across a 0.x major boundary

- **Priority:** P2
- **Effort:** XS (15 minutes)
- **Observation:** `package.json` still pins `@durable-streams/client: 0.2.3`, `@durable-streams/server: 0.3.1`, `@durable-streams/state: 0.2.5`. Since PR #176, the entries no longer have caret prefixes (good — they're exact pins now), but the **major-version skew between client (0.2) and server (0.3) is unchanged**. At 0.x semver every minor is a breaking change. There is no contract test asserting the wire envelope round-trips between these specific minors, and the dependency is from the same project — typically a sign that one was bumped in a hurry while the other wasn't.
- **Risk:** Latent incompatibility. The known-good combination works; an `npm update` or upstream patch release on either side could break the wire format with no compile-time signal.
- **Recommendation:**
  1. Add a contract test in `tests/integration/` that boots `DurableStreamTestServer`, publishes via `IdempotentProducer`, and consumes via `durableStream({live: 'sse'})` — assert the envelope round-trips.
  2. Document the known-good matrix in `specs/application/integrations/durable-streams.md`.
  3. Consider unifying the client and server versions on the next bump.
- **Links:** `package.json` `@durable-streams/*`; `src/lib/streams/caddy-producer.ts:8`; `src/lib/streams/client.ts:12`. Prior review: F05-14.

### F05-28 — Reconnect attempt counter never resets on successful reconnect; sleeping laptops re-enter dead state

- **Priority:** P2
- **Effort:** S (1-2 hours)
- **Observation:** `MAX_RECONNECT_ATTEMPTS=8` (`client.ts:377`) governs the budget after the underlying SSE response closes. On disconnect → reconnect-loop, `reconnectCount` is incremented (line 977) but **never decremented or reset on a successful reconnect**. `markConnected()` (line 838-846) sets `hasConnected = true` and updates state, but doesn't touch `reconnectCount`. A laptop closed overnight re-enters the loop the next morning with `reconnectCount` already at 1-8, depending on prior history. After 32+ minutes of pre-sleep reconnect activity (8 attempts at exponential 2s/4s/8s/16s/30s capped) the budget is fully exhausted; on wake the first failure fires `onTerminalDisconnect` immediately without ever giving the network a chance.
- **Risk:** Long-running browser tabs see spurious "Disconnected" banners. The terminal-disconnect path (now plumbed in F05-21) becomes noisy.
- **Recommendation:** Reset `reconnectCount = 0` inside `markConnected()` so a stable connection re-arms the budget. Optionally also implement a 10-minute time-window cap (e.g. "no more than 32 attempts in 10 min, regardless of success") to prevent runaway reconnects under truly broken networks.
- **Links:** `src/lib/streams/client.ts:377, 838-846, 974-984`. Prior review: F05-15.

### F05-29 — `EventRouter` global cap is not exposed as a setting; admin endpoint is missing

- **Priority:** P2
- **Effort:** S (half day)
- **Observation:** `EventRouter.setEventRouterOverrides` exists (`src/lib/events/event-router.ts:59-69`) and `getGlobalCap`/`getPerUserCap` honour the overrides. But:
  1. There is **no caller** of `setEventRouterOverrides` in `src/`. Settings overrides are not wired to `SettingsService`, so the cap stays at the hardcoded 200/10 forever.
  2. There is **no admin endpoint** that surfaces `getEventRouterSnapshot()` (the function returning `{ total, globalCap, perUserCap, byRoute, byUser }`). Operators cannot answer "are we close to the cap?" without scraping logs.
  3. The 429/503 responses on cap exhaustion (`events.ts:1097-1119`, `cli-monitor.ts:397-419`) include a `Retry-After`, but the spec roadmap also called for a graceful degradation at 80% — i.e., return a polling-mode response instead of full rejection. That degradation is not implemented.
- **Risk:** Capacity planning is still indirect. The cap is technically configurable but practically not. Once a heavy-team-mode tenant hits 200, every other tenant on the box gets `GLOBAL_CAP_EXCEEDED` until idle reconnects free slots — no per-tenant priority, no degradation.
- **Recommendation:**
  1. Wire `SettingsService.getNumberSetting('streams.sse.globalCap'|'streams.sse.perUserCap')` to call `setEventRouterOverrides` on bootstrap and on settings change.
  2. Add `GET /api/admin/metrics/sse` returning `getEventRouterSnapshot()`.
  3. Implement the 80% threshold: when `total >= globalCap * 0.8`, respond 200 with a `degraded: true` header and a body suggesting client-side polling (`/api/events/poll`); the client falls back rather than retrying SSE.
- **Links:** `src/lib/events/event-router.ts:51-99, 142-156`; `src/server/routes/events.ts:1096-1119`; `src/server/routes/cli-monitor.ts:393-419`. Prior review: F05-03.

### F05-30 — Plan-mode dropped events not surfaced through DurableStreams; admin metric is the only signal

- **Priority:** P2
- **Effort:** S (1 hour)
- **Observation:** `recordDroppedEvent` (`plan-mode.service.ts:78-97`) now logs structured `log.warn` and tracks per-type/per-reason counts. `GET /api/admin/metrics/plan-mode` exposes the counts. **What's missing**: the prior F05-02 also recommended that crossing a threshold (100 drops in 5 min) should publish a `plan:stream_degraded` event back into the plan stream so the UI can render a banner. That part was not implemented. There is no rate-based threshold, no event emission, and no UI signal. A plan session that loses every event still appears healthy to the user.
- **Risk:** Silent UX failure — exact same risk class as the original F05-02, partially mitigated by the admin endpoint.
- **Recommendation:** In `recordDroppedEvent`, after incrementing, check `droppedEventCount` against a 5-minute sliding window (small ring buffer of timestamps). When > 100 in the window, fire `streams.publish(streamId, 'plan:error', { sessionId, error: 'Real-time updates degraded — refresh the page to recover.', code: 'STREAM_DEGRADED' })`. The plan UI already handles `plan:error`. Throttle the emission to once per minute per session.
- **Links:** `src/services/plan-mode.service.ts:78-97`; `src/server/routes/admin-metrics.ts:23-39`. Prior review: F05-02 (partially resolved).

### F05-31 — `topology:*` events lack a dedicated stream prefix and travel on session streams

- **Priority:** P3
- **Effort:** L (1 week)
- **Observation:** `topology:agent_spawned` / `topology:agent_progress` / `topology:agent_completed` (defined in `durable-streams.service.ts:380-408, 472-475`) are published with the bare `sessionId` (e.g. `stream-handler.ts:339-345`). `expectedStreamIdKindForEventType('topology:agent_spawned')` returns `'session'` (`stream-id.ts:103-110`), so kind validation passes. But topology data has a different consumer (the topology view aggregates across multiple sessions/agents under a root parent). Today the topology view subscribes to each session stream individually and filters out non-topology events. A dedicated `topology:{rootSessionId}` prefix would let the topology view subscribe to one stream and receive only the events it cares about, sharply reducing client-side filtering and bandwidth.
- **Risk:** Bandwidth and client-side CPU cost at large fan-out (10+ subagents per root). Not a correctness issue.
- **Recommendation:** Introduce `topologyStreamId(rootSessionId)` brand returning `topology:{id}`, route topology events through it (publish to both for one release for backward compat), update `streamIdToPath` to map `topology:` to `/v1/stream/topology/{id}`. Verify-stream `kind=topology` resolves through the root session's team. Worth doing only when topology view contention is measurable.
- **Links:** `src/services/durable-streams.service.ts:380-408, 472-475`; `src/lib/agents/stream-handler.ts:330-426, 1100-1740`. New finding.

### F05-32 — `ChunkBatcher.flush()` swallows DB persistence errors after the snapshot restore — buffer can grow unboundedly under sustained DB pressure

- **Priority:** P3
- **Effort:** S
- **Observation:** `ChunkBatcher.flush` (`src/lib/agents/chunk-batcher.ts:124-167`) restores the unflushed deltas back into `this.buffer` when persist throws (line 164: `this.buffer = [...snapshot, ...this.buffer]`). The intent is "no data loss." But the surrounding code paths (`addDelta` line 107: `if (this.buffer.length >= this.maxBatchSize) await this.flush();`) await `flush()` and don't catch — so the throw bubbles, but the buffer keeps growing on the next delta. Combined with the timer-based flush (`flushIntervalMs=100ms`) which silently `.catch()`-es and restores too, a SQLite writer-lock contention spell can grow `this.buffer` without bound until the agent stream eventually closes via `destroy()`. RAM impact is bounded by the agent's own chunk volume, but in a long execution this could push hundreds of KB into memory per agent.
- **Risk:** Low — chunk text is small and bounded by execution duration. But the buffer-restore semantics mean "DB pressure → unbounded retry forever" rather than "DB pressure → bounded queue → eventual error."
- **Recommendation:** Cap the buffer size (e.g. `MAX_BUFFER_DELTAS=10_000`). When exceeded, drop oldest with a `log.error('ChunkBatcher buffer cap exceeded — dropping oldest delta')` and increment a metric. Aligns with the "fail loud" preference in the rest of the codebase.
- **Links:** `src/lib/agents/chunk-batcher.ts:107-119, 124-167`. New finding.

## What this supersedes

| Prior finding | Disposition |
| --- | --- |
| F05-01 (stream-ID kind enforcement) | **Partially resolved** — branded types exist, runtime check is `log.warn` only, call sites still pass raw strings → **F05-20**. |
| F05-02 (`droppedEventCount` invisible) | **Partially resolved** — structured log + admin endpoint exist; user-visible degraded-stream signal does not → **F05-30**. |
| F05-03 (50-conn cap, two counters) | **Resolved** for the cap (200 + per-user 10 unified). Settings wiring + admin snapshot endpoint missing → **F05-29**. |
| F05-04 (`MAX_CHUNKS=5000` silent drop) | **Partially resolved** — state plumbs through `useSession`; banners exist; no feature component renders them → **F05-21**. |
| F05-05 (no transactional outbox) | **Not resolved** — outbox infrastructure exists as dead code → **F05-19**. |
| F05-06 (no client gap detection) | **Partially resolved** — client emits `onGapDetected`, REST endpoint accepts `fromOffset`/`toOffset`; consumer hook never proxies → **F05-21**. |
| F05-07 (Caddy SSE unauthenticated) | **Partially resolved** — cookie check via `forward_auth`; per-stream scope check missing → **F05-23**. |
| F05-08 (three SSE subsystems) | **Resolved** — `EventRouter` unifies counters across `/api/events` and `/api/cli-monitor/stream`. |
| F05-09 (`session_events` no FK / no kind) | **Not resolved** → **F05-25**. |
| F05-10 (SQLite single-writer) | Still valid as P2; ChunkBatcher mitigation still in place; no new finding. |
| F05-11 (container-agent double-hop) | **Resolved** — agent-runner emits `agent:token:batch`, container-bridge expands; ordering preserved by `flushTokens()` before non-token events. |
| F05-12 (terraform ephemeral) | **Not resolved** → **F05-24**. |
| F05-13 (no app-level backpressure) | **Partially resolved** — metric and `publishWithBackpressure` exist; no caller → **F05-22**. |
| F05-14 (durable-streams version skew) | **Partially resolved** — exact pins now; contract test + version-matrix doc still missing → **F05-27**. |
| F05-15 (reconnect ceiling) | **Partially resolved** — `onTerminalDisconnect` exists; consumer hook doesn't proxy; counter never resets → **F05-21** + **F05-28**. |
| F05-16 (event taxonomy inconsistency) | Still P3, not addressed; no new finding here (out of P0–P2 scope for this pass). |
| F05-17 (single-node Caddy) | Still P3, not addressed; no new finding. |
| F05-18 (subscribe no-op) | **Not resolved** → **F05-26**. |
| Topology stream-ID prefix | **New** → **F05-31**. |
| ChunkBatcher unbounded restore | **New** → **F05-32**. |

## Open questions

1. **Outbox readiness for production.** F05-19 proposes turning on the outbox via `STREAMS_USE_OUTBOX=true` and migrating producers. Is the team ready to take a one-cycle stability hit if the relay polling rate (50ms) turns out to be too aggressive on Postgres? Alternative: bump to 200ms and accept higher live-delivery latency.
2. **Strict kind enforcement.** F05-20 promotes the warn to a hard error. Is there appetite to break currently-soft-violating call sites in CI, or should the strict mode roll out behind a feature flag for one release?
3. **Banner rendering policy.** F05-21 requires UI changes in `agent-session-view`, `live-task-view`, and any other session-rendering screen. Should there be a single `<SessionStatusBar>` host component that renders truncation + reconnect banners (and future status surfaces) consistently, or per-feature banners?
4. **Terraform replay UX.** F05-24's "buffer in memory + replay endpoint" is the cheap option. Does a customer use case exist for resuming a compose mid-Caddy-restart, or is "re-run the compose" acceptable? Trade-off shapes whether (b) or (a, persist to short-lived table) is the right answer.
5. **Per-stream auth scope.** F05-23's verify-stream extension needs a stream-kind → entity → team resolver. Does the team want to centralise this in a `StreamAuthService`, or keep it as a switch inside the auth route? The former is more reusable; the latter is faster to ship.
6. **EventRouter degraded mode.** F05-29 proposes a 200 with `degraded: true` at 80% capacity. Is the client willing to fall back to polling, or should we just lift the cap to 500 and skip degradation? Capacity-vs-fallback trade-off.
7. **Topology stream prefix.** F05-31 adds a new prefix and route. Do current session-side topology subscribers cause measurable browser CPU (>5% per session view), or is this premature optimization? Defer until measured.
