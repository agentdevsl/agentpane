# Arch Review — 05: Event Streaming

Theme: durable streams, Caddy SSE backend, stream-ID conventions, retention, SSE scale, single-writer SQLite bottleneck, event publishing patterns, session events table.

## Summary

Event streaming is the nerve of AgentPane. Every agent turn, token, tool call, sandbox transition, plan interaction, Terraform compose, and topology update is produced by a backend service, persisted to `session_events` in SQLite, and fanned out to browsers via Caddy's `durable_streams` plugin (or `DurableStreamTestServer` on :3002 in dev). The shape is a two-lane dual-write: SQLite provides durability and offset-ordered replay; Caddy/LMDB provides sub-second live delivery.

The system has materially improved since the March 2026 `specs/events_review/` pass. The P0 trio — dropping `accumulated` from chunk payloads, scheduled retention cleanup in `EventCleanupService`, and `ChunkBatcher` batching SQLite writes while streaming individual tokens to SSE — has been delivered. Atomic offset assignment now uses a single `INSERT...SELECT` with bounded retry, LRU eviction keeps the Caddy producer pool bounded at 200 with a 5-minute idle sweep, and shared client subscriptions de-duplicate SSE connections per session with a 60s orphan audit. Envelope metadata (OC-005) is now enforced end-to-end.

What remains is the architectural tail: the 50-connection SSE cap is still hard-coded, presence/counters/retention are still split across `EventBus`, `CliMonitorService`, and Caddy-managed SSE, the dual-write is still best-effort (no outbox), there is no client-side gap detection on reconnect, the `MAX_CHUNKS=5000` client cap still drops history silently, Caddy SSE endpoints still have no authentication beyond network trust, and SQLite remains the single writer for every event. Stream-ID conventions are documented in `CLAUDE.md` but not enforced in code — a bare CUID published to `DurableStreamsService` for what should be a plan stream will land in `session_events` as a session event and never reach the plan SSE path. And the `droppedEventCount` counter on `PlanModeService` swallows publish failures silently, with no surfaced metric, no alert, and no export to an admin endpoint.

This file consolidates the 19 work items from `specs/events_review/roadmap.md`, restates those still valid with their current disposition, and adds findings for issues that surfaced after that pass.

## Map

Producer → persist → distribute → consume:

- `src/services/durable-streams.service.ts` — typed `publish<T>` + `publishSessionEvent`; channel routing via `getChannelForType`; metadata enforcement via `requirePayloadStreamMetadata`; terraform ephemeral branch (skip DB). 1005 lines.
- `src/services/session/session-stream.service.ts` — REST query surface (offset/limit), session-event persistence for the session channel, explicit cleanup API for session deletion.
- `src/lib/streams/caddy-producer.ts` — `CaddyDurableStreamsServer` with `IdempotentProducer` (5ms linger, 1 MB batch, 5 in-flight), LRU pool (MAX_PRODUCERS=200, 5-min idle, 60s sweep), stream-ID → URL routing.
- `src/lib/streams/client.ts` — `DurableStreamsClient`, shared subscription multiplexer, reconnect loop (exponential backoff capped at 30s, 8 attempts), Zod validation per event type.
- `src/lib/streams/envelope.ts` — OC-005 structured envelope + opaque cursor normalization; `STREAM_PROTOCOL_MIGRATION_GATE` enforcement.
- `src/lib/agents/stream-handler.ts` — Claude SDK → `publish` bridge; `ChunkBatcher` for tokens; plan/execution phase handlers.
- `src/lib/agents/chunk-batcher.ts` — delta accumulator: immediate SSE, batched DB persistence.
- `src/services/event-cleanup.service.ts` — 24h retention job (60d sessionEvents, 90d eventLog defaults, batch 1000), integrity-check-gated SQLite backups.
- `src/lib/events/event-bus.ts` — in-process SSE listeners for `/api/events`; `MAX_SSE_CONNECTIONS=50`.
- `src/server/routes/cli-monitor.ts` — separate SSE endpoint, separate `MAX_SSE_CONNECTIONS=50` counter.
- `src/app/hooks/use-session.ts` — `MAX_CHUNKS=5000` cap, silent slice on overflow.
- `src/db/schema/sqlite/session-events.ts` — 4 indexes (session, (session, offset) unique, created_at, (session, type)); sessionId has no FK.
- `Caddyfile` — `@streams path /v1/stream /v1/stream/*` handler; auth handled upstream by API server, not by Caddy itself.
- Packages: `@durable-streams/client@^0.2.3`, `@durable-streams/server@^0.3.1`, `@durable-streams/state@^0.2.5`.

Stream-ID prefixes (documented in `CLAUDE.md`, routed by `streamIdToPath` in `caddy-producer.ts`): bare CUID → sessions; `plan:` → plans; `sandbox:` → sandboxes; `terraform:` → ephemeral terraform; `cli-monitor` → singleton.

## What's working

- **Atomic offset assignment (DB-008).** `persistToDb` uses a single `INSERT...SELECT` with `COALESCE(MAX(offset), -1) + 1` and a 3-attempt bounded retry on unique-constraint collision. No read-then-write race window.
- **Chunk batching (P0-3).** `ChunkBatcher` wires immediate SSE delivery for tokens with batched DB persistence, and flushes before turn-boundary events to preserve ordering.
- **Retention scheduler (P0-2).** `EventCleanupService` batch-deletes with `LIMIT 1000` to avoid long-held locks, reads retention days from `SettingsService` at runtime, and runs a WAL-checkpointed SQLite backup with integrity-check gating on the same cadence.
- **LRU producer pool (P1-6 / RS-001).** 200-entry cap with 5-minute idle sweep; timer is `unref`-ed so it never blocks process exit.
- **Shared subscription multiplexing (RS-010).** Client-side `subscribeToSession` fans out a single underlying SSE connection to many subscribers, tears down on last unsubscribe, and audits orphans every 60s.
- **Envelope gating (OC-005d).** `requirePayloadStreamMetadata` now fails publish if metadata is missing or targets a conflicting stream — caught the kind of cross-stream leak that F14 in the previous review worried about.
- **Ephemeral Terraform streams.** `isEphemeral` branch skips SQLite entirely and surfaces Caddy failures as first-class errors for that path, so operators don't accumulate 18M rows of compose-noise.
- **Sandbox ID consistency.** Provider accepts `config.id` so `sandbox:{id}` is the same identifier in DB, stream, and provider map (fix from commit f8d5947b).
- **Structured logging + masking.** All stream publish sites go through the `createLogger` path with sensitive-data masking (e6335667) — good floor for later observability work.

## Findings

### F05-01 — No code enforcement of stream-ID conventions

- **Priority:** P1
- **Observation:** `CLAUDE.md` lines 413–427 document prefixes (`plan:`, `sandbox:`, `terraform:`, bare CUID, `cli-monitor`), but `DurableStreamsService.publish` accepts any non-empty string as `streamId`. Routing is decided downstream in `streamIdToPath` (`src/lib/streams/caddy-producer.ts:12-22`) via prefix string matching, and `getChannelForType` (`durable-streams.service.ts:530-539`) switches on the event type — not the stream ID. A plan-typed event published to a bare CUID would persist to `session_events` and be delivered at `/v1/stream/sessions/{id}`, not `/v1/stream/plans/{id}`. Nothing warns.
- **Risk:** Events silently land on the wrong channel. Debugging "why doesn't the plan panel see its own events" becomes a string-matching archaeology exercise. Migrations that change an entity's naming (project→codespace, task→skill) create stream-ID drift that is invisible until a user hits the missing stream in the UI.
- **Recommendation:** Introduce a tagged type `StreamId = PlanStreamId | SandboxStreamId | SessionStreamId | TerraformStreamId | typeof CLI_MONITOR_STREAM_ID` with constructors (`planStreamId(id)`, `sandboxStreamId(id)`) that prepend the prefix. Make `publish` and `createStream` take the tagged type. Cross-check at the publish site: a `plan:*` event type requires a `PlanStreamId`; a `sandbox:*` type requires `SandboxStreamId`. Reject mismatches with `STREAM_PROTOCOL_MISMATCH` (the error code already exists for envelope mismatches). No runtime cost — pure compile-time plus a cheap prefix check.
- **Effort:** S (1 day) — narrow type plus site updates; bulk of call sites already compose the prefix inline.
- **Links:** `CLAUDE.md:413-427`; `src/services/durable-streams.service.ts:422-482`, `src/lib/streams/caddy-producer.ts:12-22`; partially anticipated by `specs/events_review/README.md` §3.2 Phase 2.4 (schema normalization).

### F05-02 — `droppedEventCount` is invisible beyond a getter

- **Priority:** P1
- **Observation:** `PlanModeService.droppedEventCount` increments on 13 publish-in-catch sites (`src/services/plan-mode.service.ts:67, 194, 206, 263, 386, 403, 453, 532, 545, 570, 600, 667, 679`). `getMetrics()` exposes it, but nothing calls `getMetrics()`: no admin endpoint, no log emission, no alerting threshold, no resetting, no per-session breakdown. A plan-mode deployment that silently loses every streaming event still returns healthy.
- **Risk:** Silent failure class — exactly what the events-review pass called out — persisting in the one service the pass said had the counter. A user whose plan stream is broken sees a spinner; operators see clean logs.
- **Recommendation:** (1) Emit a `log.warn` at each increment with the stream type and error code so the structured logger picks it up. (2) Add `GET /api/admin/metrics/plan-mode` returning `{ droppedEventCount, perType, perSession }`. (3) If the counter exceeds a threshold (say 100 over 5 min) emit a `plan:stream_degraded` event to the plan stream itself so the UI can show a banner. (4) Consider converting these catches to the outbox pattern proposed in F05-05 — most of them exist because the Caddy publish is best-effort.
- **Effort:** S (half day) for logging + endpoint; folds into F05-05.
- **Links:** `src/services/plan-mode.service.ts:67-116`, increment sites throughout the file.

### F05-03 — SSE connection cap still 50 with two separate counters

- **Priority:** P1
- **Observation:** `MAX_SSE_CONNECTIONS = 50` appears in `src/lib/events/event-bus.ts:24` for the `/api/events` endpoint and is declared separately (same value) in `src/server/routes/cli-monitor.ts:175`. Caddy-managed SSE streams are not counted at all. The `event-bus.ts` TODO (line 12) explicitly flags the split. Team mode spawning 5 subagents with a user viewing 10 sessions already approaches the cap for the `/api/events` route alone, and 429s arrive as `TOO_MANY_CONNECTIONS` with no polling fallback.
- **Risk:** Scaling wall at ≈2x current usage. With team mode (launchSwarm) + browser tabs + CLI-monitor + session panels, a single heavy user can exhaust the cap. No graceful degradation.
- **Recommendation:** Implement P1-3 per the roadmap: single `EventRouter` with a `Map<route, count>`, lift default to 200, make it an admin setting, enforce per-user quotas (~20), and return a polling-mode response at 80% capacity instead of 429. Pair with F05-08 (unified event bus) — they touch the same code.
- **Effort:** S (1 day) for the cap bump + graceful degradation alone; M for unified bus.
- **Links:** `src/lib/events/event-bus.ts:24`, `src/server/routes/cli-monitor.ts:175`, `src/server/routes/events.ts:1069`; `specs/events_review/roadmap.md` P1-3.

### F05-04 — `MAX_CHUNKS=5000` silently drops history on the client

- **Priority:** P1
- **Observation:** `src/app/hooks/use-session.ts:148` slices to `MAX_CHUNKS=5000` with no user-visible signal. A long agent session (a realistic swarm run past ~1,000 turns) silently loses the earliest chunks from the UI, with no banner, no "load earlier" control, and no state flag.
- **Risk:** User-visible but mis-attributed data loss — the user concludes "AgentPane forgot the start of the conversation," when in fact the REST endpoint `/api/sessions/:id/events?offset=0&limit=...` still has it.
- **Recommendation:** Implement P1-4: set a `truncated: boolean` + `truncatedAt: offset` on the returned state. Render a "Showing last 5,000 events — load earlier" banner. Back the "load earlier" button with the existing REST endpoint. Deduplicate by offset on merge.
- **Effort:** S (2-4 h).
- **Links:** `src/app/hooks/use-session.ts:148, 205`; `specs/events_review/roadmap.md` P1-4.

### F05-05 — Dual-write still best-effort; no transactional outbox

- **Priority:** P1
- **Observation:** `DurableStreamsService.publish` persists to SQLite first, then publishes to Caddy; a Caddy failure logs at `debug` and returns `ok(offset)` (`durable-streams.service.ts:713-717`). `publishSessionEvent` has the same shape (`:985-992`). If Caddy is mid-restart, connected SSE clients miss the event until they reconnect and replay from offset — but the reconnect loop in `DurableStreamsClient` uses the last *cursor*, not the last *DB offset*, so the chance of a silent gap exists (see F05-06). There is no outbox to decouple durability from delivery; re-publish to Caddy after a transient failure does not happen.
- **Risk:** Events durable in DB but missing from live SSE until client reconnects; no visibility into how often it happens; no retry path. Under a Caddy crash loop, the API server keeps ack-ing `ok` to callers while the browser goes quiet.
- **Recommendation:** Implement P1-1 (transactional outbox): new `event_outbox` table (status, attempts, nextAttemptAt, payload, streamId, type), `DurableStreamsService.publish` writes only to SQLite within the business transaction, a 50ms `OutboxRelayService` polls and publishes to Caddy with exponential backoff. Removes the best-effort catch in `durable-streams.service.ts:713`. Pair with F05-02 — most `droppedEventCount` increments disappear because the relay guarantees eventual delivery.
- **Effort:** M (1-2 days).
- **Links:** `src/services/durable-streams.service.ts:697-717, 985-992`; `specs/events_review/roadmap.md` P1-1.

### F05-06 — No client-side gap detection on reconnect

- **Priority:** P1
- **Observation:** `DurableStreamsClient` resumes from `lastCursor` via `offset: lastCursor ?? '-1'` (`client.ts:850`). The `StreamResponse` layer replays from that cursor on reconnect, but the hook never checks whether the first event *after* reconnect matches `lastCursor + 1`. GC pauses on the browser tab, sleeping the laptop, or a Caddy restart that lost in-flight LMDB entries all produce invisible gaps. `useTaskActivity` fetches historical data on mount; `useSession` does not.
- **Risk:** Client state diverges from server state after any non-trivial disconnect. The UI looks fine, but is missing tool results or chunk deltas between the last pre-disconnect and first post-reconnect offsets.
- **Recommendation:** Implement P2-5: on `onReconnect`, compare `getLastOffset()` with the next event's offset. If gap > 1, fetch missing events from the REST endpoint `/api/sessions/:id/events?offset=last&limit=gap` and merge by offset (dedup). Trivial once offsets are durable.
- **Effort:** S-M (3 days).
- **Links:** `src/lib/streams/client.ts:840-874, 994-999`; `specs/events_review/roadmap.md` P2-5.

### F05-07 — Caddy SSE endpoints still unauthenticated

- **Priority:** P1
- **Observation:** `Caddyfile` `@streams path /v1/stream /v1/stream/*` does not require auth. The inline comment (lines 15–30) documents that the deployment is expected to restrict the Caddy port to the internal network and that the API server terminates auth. There is no `forward_auth` block, no basicauth, no JWT validation. The browser session cookie is not checked by Caddy.
- **Risk:** In any deployment where Caddy's stream port is reachable from outside the trusted network — default dev, mis-configured prod, developer laptops bridged onto a public Wi-Fi, or a reverse-proxy mis-route — any client can subscribe to any stream ID they can guess, including CUIDs derived from URL leakage or log scraping. This is a security finding, not a scaling one.
- **Recommendation:** Implement P2-3 Option A immediately (network isolation documented in deploy), Option B as follow-up: enable `forward_auth` against `POST /api/auth/verify-stream` that returns 200 if the session cookie maps to a user with access to the stream ID (scope check). Stream IDs carry enough structure (`plan:` → team, `sandbox:` → codespace, bare CUID → session) to make this a bounded lookup.
- **Effort:** M (3-5 days including the scope resolver).
- **Links:** `Caddyfile:15-30, 31-33`; `specs/events_review/roadmap.md` P2-3 (RS-019).

### F05-08 — Three parallel SSE subsystems, three connection counters

- **Priority:** P2
- **Observation:** `EventBus` (`src/lib/events/event-bus.ts`) handles `/api/events` with its own listener Set and counter. `CliMonitorService` maintains its own `localSubscribers` and counter. Caddy handles `/v1/stream/*` with no API-level counter at all. The file's own TODO (line 11-13) flags the duplication. Event naming conventions drift between the two: `StreamEventMap` keys (colon-delimited `category:action`) don't match the `event-bus` payloads.
- **Risk:** Capacity planning is impossible — no single number says "this server is at X% of its SSE capacity." Cleanup bugs duplicate across three cleanup paths. Future events need to decide which system to publish into, and the answer depends on historical accident. Observability is gappy.
- **Recommendation:** Implement P1-2: unified `EventRouter` with channel-based pub/sub, a single `Map<route, count>` counter, one cleanup surface. `EventBus.publishEventToStream` and `CliMonitorService.localSubscribers` become subscribers of the router. Caddy delivery stays as-is for durable streams but publishes to the router for counting. No change to on-wire format — this is internal consolidation.
- **Effort:** M (1 day).
- **Links:** `src/lib/events/event-bus.ts:1-61`, `src/services/cli-monitor/cli-monitor.service.ts`, `src/server/routes/events.ts`; `specs/events_review/roadmap.md` P1-2.

### F05-09 — `session_events.sessionId` stores unrelated stream IDs with no FK

- **Priority:** P2
- **Observation:** The column stores bare session CUIDs *and* `plan:*` stream IDs *and* `sandbox:*` stream IDs (the comment on `src/db/schema/sqlite/session-events.ts:11-13` acknowledges this). The absence of an FK is intentional, but the column is misnamed and cleanup is fragmented across `session-crud.service.ts` (sessions), `codespace.service.ts` (plans + sandboxes), and `EventCleanupService` (age-based sweep). A developer reading the schema first-time expects FK-backed cardinality guarantees.
- **Risk:** Orphan rows for any stream type whose parent entity gets deleted by a code path that forgets the explicit-cleanup call. Confusion for anyone adding a new stream type — "do I need to add cleanup, or will the FK cascade?" The answer is always "you need to add cleanup" but there is no compile-time reminder.
- **Recommendation:** Rename the column (or add an alias view) `stream_id`, and split into two tables or add a `streamKind` enum column (`session | plan | sandbox | task-creation | container-agent`) indexed alongside the stream ID. Better: a registry that every stream-owning service registers with at startup (`registerStreamOwner('plan', planModeService)`) and which the cleanup service enumerates on delete.
- **Effort:** M (1-2 days with migration) — migrations touch a hot table, test carefully.
- **Links:** `src/db/schema/sqlite/session-events.ts:11-13`; `CLAUDE.md:405-411`.

### F05-10 — SQLite single-writer serialises all event persistence

- **Priority:** P2 (P1 at >10 concurrent agents)
- **Observation:** Every event goes through the same SQLite writer lock. With the post-batching state, writes per second are an order of magnitude lower than before (roughly 10x reduction per the ChunkBatcher PR b1448dc1), but the lock is still global: tool events, topology progress, sandbox lifecycle, plan turns, and batched chunk flushes all serialize on the writer. 5+ concurrent agents in team mode approach contention; 20+ is unambiguous.
- **Risk:** Write contention ceiling, measurable as increased `p99` publish latency under concurrent agent load. Symptoms: SSE delivery lag, occasional `UNIQUE constraint` retry under the atomic INSERT pattern (it is handled, but retries are still latency).
- **Recommendation:** Monitor first — add a histogram of publish latency by stream type. Batching makes this materially less urgent than the March review suggested. Only pursue libSQL/Turso (P3-5) when the metric actually shows contention. In the meantime, increase `PRAGMA journal_mode=WAL` busy timeout, verify `synchronous=NORMAL` is set (WAL + NORMAL is the right tradeoff for event writes).
- **Effort:** S to instrument; L to migrate DB driver if needed.
- **Links:** `src/services/durable-streams.service.ts:595-625`; `specs/events_review/roadmap.md` P3-5.

### F05-11 — Container-agent double-hop latency and parse cost

- **Priority:** P2
- **Observation:** `agent-runner/src/event-emitter.ts` emits JSON lines to stdout, `container-agent.service.ts` parses each line with `readline`, maps the type, and re-publishes via `DurableStreamsService.publish`. Adds ~1–5 ms per event. At token frequency during a long execution, accumulates. Token batching was added for the direct SDK path (ChunkBatcher); the container path has no equivalent.
- **Risk:** Increased CPU on the API server and slower perceived streaming for containerized agents relative to SDK-direct agents — inconsistent UX between sandbox modes.
- **Recommendation:** Mirror `ChunkBatcher` on the container side (P3-3 "Edge CEP"): accumulate 10 tokens or 50ms, flush as one JSON line, let the host process pass through. Host emits the batched payload directly to Caddy. Also opens the door to stall detection (>30s no output) and rate alerts inside the container.
- **Effort:** M (1-2 weeks for full Edge CEP; S for just token batching).
- **Links:** `agent-runner/src/event-emitter.ts`, `src/services/container-agent.service.ts`; `specs/events_review/roadmap.md` P3-3.

### F05-12 — Ephemeral Terraform streams lose data on Caddy restart mid-compose

- **Priority:** P2
- **Observation:** `isEphemeral = streamId.startsWith('terraform:')` (`durable-streams.service.ts:682`) skips the DB write entirely. Caddy failure on an ephemeral stream returns a hard error (good — surfaced to the caller), but if Caddy restarts *mid-compose*, the compose job has produced events, users have seen some, reconnecting clients will see no replay because there is no DB row to replay from. `deleteStream` after each turn (per `CLAUDE.md:411`) intentionally discards. There is no local buffer in the service.
- **Risk:** Partial compose output on Caddy flap — user sees "processing..." then an empty chat panel because the reconnect has nothing to replay. Unlike durable streams where the DB is the fallback, terraform has none.
- **Recommendation:** Two options: (a) persist terraform events to a short-lived `terraform_compose_events` table with TTL (24h) and read from it on reconnect; (b) accept ephemerality but require `generatedCode` in the `done` event (already the pattern) and ensure the API server buffers the full compose in memory until the `done` SSE is ack-ed — if Caddy drops, the client reconnect can pull the buffered response via a new REST endpoint. (b) is simpler and matches how the client-side fallback `extractHclFromText` already works.
- **Effort:** S (option b) to M (option a).
- **Links:** `src/services/durable-streams.service.ts:682-716`; `src/services/terraform-compose.service.ts`; `CLAUDE.md:405-411`.

### F05-13 — Publish path has no application-level backpressure

- **Priority:** P2
- **Observation:** `IdempotentProducer` has `lingerMs: 5, maxBatchBytes: 1_048_576, maxInFlight: 5` (`caddy-producer.ts:113-117`). Beyond those, there is no producer-level backpressure to the calling agent code. `publish` returns immediately; Caddy/LMDB is expected to swallow the event. Under a hostile scenario (8 agents in team mode, each producing 10 tokens/sec with ChunkBatcher still allowing per-turn bursts), LMDB grows and the producer pool's 5-in-flight limit becomes a silent queue at the producer.
- **Risk:** Under sustained high-throughput, memory pressure on the Caddy side accumulates and publish latency rises without the application noticing. No signal to throttle the agent.
- **Recommendation:** Emit a `publish_lag_ms` gauge per stream. If the 95th percentile exceeds a threshold, signal the agent to pause token streaming (drain before producing more). Longer term — consumer-ack-based backpressure (NATS JetStream per P2-1 in the roadmap).
- **Effort:** S (metric + threshold) now, L (NATS) later.
- **Links:** `src/lib/streams/caddy-producer.ts:113-129`; `specs/events_review/roadmap.md` §3.1 (RS-008) and P2-1.

### F05-14 — `@durable-streams/client@0.2.3` vs `@durable-streams/server@0.3.1` major version skew

- **Priority:** P2
- **Observation:** `package.json` pins `@durable-streams/client ^0.2.3` and `@durable-streams/server ^0.3.1`. At 0.x semver, a minor bump is a breaking change, so 0.2 vs 0.3 is explicitly a major delta. Both packages are produced by the same project. The code compiles and tests pass, so the used surface is presumably compatible today, but there is no compatibility matrix documented, no test that asserts the wire format round-trips, and no CI guard against an `npm update` that drags one package onto 0.4 while leaving the other on 0.3.
- **Risk:** Latent incompatibility; an innocent dependency bump may break stream delivery. The failure mode is subtle (events validated client-side by Zod, so malformed wire gets rejected quietly).
- **Recommendation:** (1) Pin exact versions (remove carets for these two packages). (2) Add a contract test: start a local `DurableStreamTestServer`, publish via `IdempotentProducer`, consume via `durableStream()`, assert the envelope round-trips. (3) Document the known-good matrix in `specs/application/integrations/durable-streams.md`.
- **Effort:** S (half day).
- **Links:** `package.json` `@durable-streams/*`; `src/lib/streams/caddy-producer.ts:8`; `src/lib/streams/client.ts:12`.

### F05-15 — Reconnect ceiling is 8 attempts on clean closure, silent afterwards

- **Priority:** P2
- **Observation:** `src/lib/streams/client.ts:377` sets `MAX_RECONNECT_ATTEMPTS = 8` with an exponential backoff capped at 30s. After attempt 8, the subscription stays disconnected with no visible state beyond `getState() === 'disconnected'`. The hook surfaces `onDisconnect` once per disconnect but not "terminal give-up." Users see a stale UI with no banner.
- **Risk:** Long-lived sessions (especially on a laptop sleeping overnight) exceed the reconnect budget and land in a dead state. No user-facing cue.
- **Recommendation:** Add `onTerminalDisconnect` callback, render a "Reconnect" button in the session panel when it fires. Consider resetting the attempt counter on a successful `markConnected` (current code already does this implicitly by recreating `connect()`), but a stale tab that loses power may re-enter `connect()` from a zero-attempts state multiple times — add a total-budget window (e.g., 32 attempts in 10 min).
- **Effort:** S (2-4h).
- **Links:** `src/lib/streams/client.ts:377, 942-948`.

### F05-16 — Event-type taxonomy remains inconsistent

- **Priority:** P3
- **Observation:** `StreamEventMap` uses `category:action` hierarchical names (`plan:started`, `container-agent:tool:start`) while the session-event domain uses shorter non-prefixed names (`chunk`, `tool:start`, `tool:result`, `presence:joined`). The client's `SessionEventType` union (`src/lib/streams/client.ts:382-412`) mixes both worlds. No versioning field on events; no CloudEvents envelope at the transport layer (the OC-005 envelope is structural metadata, not event-schema versioning).
- **Risk:** Consumers must know two naming conventions. Adding a field to a chunk payload requires mirrored changes in server types, Zod schemas, and client callbacks with no `schema_version` to support graceful rollouts.
- **Recommendation:** P2-4 from the roadmap. Normalize to `io.agentpane.{entity}.{action}` with a dual-publish (old + new) for two release cycles, then retire. Add a `schemaVersion` field. Publish an AsyncAPI 3.0 spec. Much larger than other findings — keep at P3 until consumer count grows (e.g., an external webhook exporter).
- **Effort:** L (1-2 weeks). Migration pain.
- **Links:** `src/services/durable-streams.service.ts:416-482`; `src/lib/streams/client.ts:382-412`; `specs/events_review/roadmap.md` P2-4.

### F05-17 — Single-node Caddy is the live-delivery SPOF

- **Priority:** P3 (P1 if you horizontally scale the API server)
- **Observation:** Today there is one API server process and one Caddy process. Multiple API instances cannot publish to the same LMDB without a Caddy-to-Caddy coordination layer that doesn't exist. SQLite remains the source of truth, so durability survives a Caddy restart (clients replay on reconnect once F05-06 is in place), but real-time delivery is single-node.
- **Risk:** Blocker for horizontal API scaling. Single Caddy also means one process in the hot path between every agent event and every browser — scheduled maintenance requires user-visible reconnects.
- **Recommendation:** Defer until horizontal scale is actually needed. At that point, P2-1 (NATS JetStream as routing/distribution layer with Caddy as SSE bridge) is the documented path. Short term, add a second Caddy for HA with LMDB replication via file-level sync, or front Caddy with a TCP LB — but both have caveats (LMDB file sync isn't guaranteed clean; TCP LB doesn't solve LMDB split-brain). NATS is the clean answer.
- **Effort:** L (2-3 weeks when triggered).
- **Links:** `Caddyfile`; `src/lib/streams/caddy-producer.ts`; `specs/events_review/roadmap.md` P2-1.

### F05-18 — `subscribe` on the server interface is a silent no-op

- **Priority:** P3
- **Observation:** `CaddyDurableStreamsServer.subscribe` (`caddy-producer.ts:210-223`) returns an immediately-`{done: true}` async iterable. The interface `DurableStreamsServer.subscribe` exists on the type (`durable-streams.service.ts:33-36`), so any server-side consumer that tried to iterate would get no events and no error. The no-op is documented as intentional (RS-015), but the type signature invites misuse.
- **Risk:** A future developer implements server-side processing (e.g., metrics aggregation, DLQ relay) by calling `subscribe`, sees nothing, and doesn't immediately learn it's a no-op.
- **Recommendation:** Either remove `subscribe` from the interface (SSE-only is an architectural choice — encode it in the type) or throw `NOT_IMPLEMENTED` so misuse fails loud. If server-side subscription becomes real (for P1-5 webhook DLQ relay or P2-1 NATS bridge), implement it properly.
- **Effort:** S (1 hour).
- **Links:** `src/services/durable-streams.service.ts:33-36`; `src/lib/streams/caddy-producer.ts:205-223`.

## What this supersedes

| Prior finding | Location | Disposition |
| --- | --- | --- |
| 2.1 Unbounded retention | `events_review/README.md` §2.1 | **Resolved** — `EventCleanupService` delivers P0-2 (60d / 90d defaults, settings-overridable). No new finding. |
| 2.2 SQLite single-writer serialisation | §2.2 | Still valid — superseded by **F05-10** with lowered priority because ChunkBatcher (2.3) mitigated the pressure. |
| 2.3 No chunk batching | §2.3 | **Resolved** — `ChunkBatcher` delivers P0-3. No new finding. |
| 2.4 O(n²) accumulated-text bloat | §2.4 | **Resolved** — P0-1 removed `accumulated`. No new finding. |
| 2.5 Single-node Caddy | §2.5 | Still valid — superseded by **F05-17**, priority kept at P3 until horizontal scale is triggered. |
| 2.6 50-connection SSE cap | §2.6 | Still valid — superseded by **F05-03**, promoted to P1 because team mode makes it reachable. |
| 2.7 Silent chunk truncation | §2.7 | Still valid — superseded by **F05-04**, P1-4 remains untriggered. |
| 3.1 No backpressure | §3.1 / RS-008 | Still valid — superseded by **F05-13** (instrumentation first, then NATS). |
| 3.2 No dead-letter queue | §3.2 | Folded into **F05-05** (outbox) and **F05-02** (plan-mode visibility). Webhook-specific DLQ (P1-5) remains out of scope here — covered in the operations theme. |
| 3.3 Container-agent double-hop | §3.3 | Still valid — superseded by **F05-11**. |
| 3.5 Offset-based pagination fragility | §3.5 | Partially mitigated — atomic INSERT removed the obvious race, but cursor-based pagination isn't implemented. No finding here; small enough to leave as a P3 polish. |
| 3.6 Memory accumulation in stream handler | §3.6 | Mitigated by batching — accumulated text still held per phase but no longer duplicated per chunk. No new finding. |
| RS-001 Producer pool unbounded growth | hybrid §2 | **Resolved** — LRU + idle sweep in `caddy-producer.ts`. No new finding. |
| RS-002 Duplicate SSE tracking | hybrid §2 | Still valid — folded into **F05-08** (unified bus). |
| RS-006 No gap detection | hybrid §2 | Still valid — superseded by **F05-06**. |
| RS-009 Three disconnected systems | hybrid §2 | Still valid — superseded by **F05-08**. |
| RS-010 Shared subscription map cleanup | hybrid §2 | **Resolved** — 60s orphan audit in `client.ts:1504-1522`. No new finding. |
| RS-011 `useSession` unbounded array | hybrid §2 | **Resolved** for growth (MAX_CHUNKS enforces a bound); surface gap remains — see **F05-04**. |
| RS-013 Dual-write inconsistency | hybrid §2 | Still valid — superseded by **F05-05** (outbox). |
| RS-014 Offset collision retry limited to 3 | hybrid §2 | **Resolved** by atomic INSERT pattern; 3 retries is a soft ceiling, not a correctness issue. No new finding. |
| RS-019 Caddy unauthenticated | hybrid §2 | Still valid — superseded by **F05-07**, priority raised to P1. |
| P1-5 Webhook DLQ | roadmap | Out of scope for this theme — belongs in the webhook/ops review. |
| P3-2 Durable execution (Inngest) | roadmap | Out of scope for this theme — belongs in the agent-execution review. |
| P3-4 CQRS snapshots | roadmap | Not yet justified — trigger condition (5k+-event sessions routine) not met; MAX_CHUNKS cap and offset-based replay still fine for current sessions. No new finding. |
| Stream-ID convention enforcement | CLAUDE.md docs | **New gap** — **F05-01**. |
| `droppedEventCount` silent swallowing | plan-mode.service.ts | **New gap** (was a TODO note in the counter) — **F05-02**. |
| `@durable-streams/*` version skew | package.json | **New finding** — **F05-14**. |
| Reconnect ceiling invisibility | client.ts | **New finding** — **F05-15**. |
| `subscribe` no-op footgun | caddy-producer.ts | **New finding** — **F05-18**. |
| Ephemeral Terraform loss on Caddy restart | durable-streams.service.ts | **New finding** — **F05-12**. |

## Open questions

1. **Operational topology.** Is the target deployment single-process + single-Caddy indefinitely, or is horizontal API scaling on the 6-month roadmap? This decides whether F05-17 (single-node Caddy) and F05-10 (single-writer SQLite) stay at P3 or promote to P1, and whether NATS JetStream enters the critical path.
2. **Auth model for Caddy streams.** Is network isolation of the Caddy port a deployable assumption in every environment AgentPane runs (self-hosted in customer infra, cloud-hosted, developer machines)? If not — specifically if `/v1/stream/*` is ever routed through the same ingress as the public API — F05-07 promotes to P0.
3. **Stream-ID tagging appetite.** F05-01 asks for tagged types at every publish site. This touches ~40 call sites. Is the migration worth the safety (author's view: yes), or should we invest in a runtime assertion only (cheaper but catches less)?
4. **Client memory ceiling.** `MAX_CHUNKS = 5000` is the right bound for RAM, but the user surface (F05-04) needs product direction: do we render a truncation banner with "load earlier" (fetches REST), or do we virtualize the chunk list so MAX_CHUNKS becomes irrelevant?
5. **Plan-mode dropped-event policy.** Should each drop be user-visible (banner in the plan UI), operator-visible (admin endpoint + alert), or both? F05-02 proposes both — confirm before implementing.
6. **Terraform ephemeral contract.** Is there a customer use case that needs terraform-compose replay after a Caddy restart, or is "restart the compose" an acceptable UX? F05-12's chosen remedy depends on this.
7. **Event schema versioning trigger.** F05-16 / P2-4 is heavy. Is there an external consumer on the horizon (webhook exporter, third-party integrations, CLI ingestion) that would justify the normalization and CloudEvents envelope now, or does this remain deferred until the consumer appears?
