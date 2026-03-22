# Implementation Backlog

Date: March 2026

This document turns the research in `docs/research/opencode/01-reality-check.md`
and `docs/research/opencode/03-roadmap.md` into implementation-ready backlog
items.
It focuses on the highest-priority tranche only: Phase 0 and Phase 1 work that
improves safety, transcript trust, reconnect correctness, and long-session
responsiveness.

`OC-002` and `OC-003` are intentionally deferred from the current execution
queue. They remain documented for later hardening work, but they are not part
of the active plan.

## How To Use This File

- Treat each ticket as a separately shippable change.
- Keep Phase 2+ work out of scope until this tranche is stable.
- Prefer small PRs that make semantics more honest before adding polish.

## Current Focus

- Active now: `OC-001`, `OC-004`, `OC-005`, `OC-006`, `OC-007`, `OC-008`.
- Deferred for later: `OC-002`, `OC-003`.
- Bias for the next implementation cycle: fix deployment truth and stream semantics before adding cache or rendering optimizations.

## Sizing Guide

- `S`: small PR or focused doc/config change, usually one main area of the codebase.
- `M`: moderate PR spanning a few connected files or one end-to-end behavior.
- `L`: broad change across client/server boundaries or multiple live surfaces.

## Active Slice Summary

| Slice | Size | Risk | Why it matters |
| --- | --- | --- | --- |
| `OC-001a` | S | Medium | Forces one honest production topology decision |
| `OC-001b` | M | Medium | Makes Helm and runtime actually match the chosen topology |
| `OC-001c` | S | Medium | Verifies SSE, API, and SPA routing together |
| `OC-001d` | S | Low | Removes misleading scale-out claims |
| `OC-004a` | S | Medium | Creates one shared health vocabulary |
| `OC-004b` | M | Medium | Makes the main transcript surface honest |
| `OC-004c` | M | Medium | Prevents other live views from drifting semantically |
| `OC-004d` | S | Low | Locks in behavior with focused coverage |
| `OC-005a` | M | High | Defines the core stream contract |
| `OC-005b` | L | High | Changes server emission semantics |
| `OC-005c` | L | High | Changes client parsing and rendering assumptions |
| `OC-005d` | M | High | Prevents migration ambiguity |
| `OC-006a` | S | High | Stops losing real resume cursor values |
| `OC-006b` | M | High | Replaces reconnect-from-zero behavior |
| `OC-006c` | M | High | Makes catch-up paths compatible with real resume semantics |
| `OC-006d` | S | Medium | Proves duplicate/gap regressions are covered |
| `OC-007a` | M | Medium | Sets safe cache shape and invalidation rules |
| `OC-007b` | M | Medium | Persists only the durable data that matters |
| `OC-007c` | M | Medium | Improves reload UX materially |
| `OC-007d` | S | Low | Keeps browser edge cases from becoming trust failures |
| `OC-008a` | S | Medium | Stabilizes line identity for later rendering work |
| `OC-008b` | L | Medium | Removes full rebuild costs from the hot path |
| `OC-008c` | M | Medium | Keeps long transcripts responsive |
| `OC-008d` | M | Low | Spreads the same performance model to other long views |

## Recommended Execution Order

1. `OC-001` Align the deployed topology with the documented Caddy front door.
2. `OC-004` Add a shared live health state model for startup and streaming.
3. `OC-005` Adopt a structured stream envelope with stable IDs.
4. `OC-006` Preserve opaque resume cursors end-to-end.
5. `OC-008` Replace full transcript rebuilds with append-only timelines and virtualization.
6. `OC-007` Add Dexie-backed durable session hydration.

Deferred from the active queue: `OC-002`, `OC-003`.

## Overview

| ID | Priority | Title | Why now | Depends on |
| --- | --- | --- | --- | --- |
| `OC-001` | P0 | Align production front door topology | Docs and Helm disagree about the actual entrypoint | None |
| `OC-002` | Deferred | Remove sandbox env token injection | Intentionally deferred from the current execution queue | None |
| `OC-003` | Deferred | Default hosted sandboxes to gVisor | Important isolation hardening, but intentionally deferred for now | `OC-001` recommended |
| `OC-004` | P0 | Expose honest live health states | UI looks healthier than the system often is | `OC-001` helpful |
| `OC-005` | P1 | Structured stream envelope | Stable IDs and durability semantics unlock trustworthy replay | `OC-004` helpful |
| `OC-006` | P1 | Opaque reconnect cursors | Current reconnect path drops or approximates offsets | `OC-005` strongly preferred |
| `OC-007` | P1 | Dexie durable session cache | Refresh still feels punitive for long sessions | `OC-005`, `OC-006` |
| `OC-008` | P1 | Append-only transcript store plus virtualization | Transcript cost grows with session length | `OC-005` helpful |

## `OC-001` Align Production Front Door Topology

- Why now: `Caddyfile` documents Caddy on `:3000` as the front door for `/v1/stream/*`, `/api/*`, and static assets, but the Helm deployment exposes only Bun on `:3001` through `charts/agentpane/templates/deployment.yaml`, `charts/agentpane/templates/service.yaml`, and `charts/agentpane/templates/httproute.yaml`.
- Primary files: `Caddyfile`, `docker/start.sh`, `charts/agentpane/templates/deployment.yaml`, `charts/agentpane/templates/service.yaml`, `charts/agentpane/templates/httproute.yaml`, `charts/agentpane/templates/hpa.yaml`, `docs/durable-streams-architecture.md`.
- Scope:
  - Pick one official production topology and make docs, entrypoint, and Helm all match it.
  - If Caddy remains canonical, expose the Caddy port publicly and ensure `/v1/stream/*` does not bypass it.
  - Freeze or clearly disable autoscaling guidance for the control plane until stream and rate-limit semantics are truly multi-instance safe.
- Acceptance criteria:
  - The documented production path and the shipped manifests describe the same entrypoint.
  - `/v1/stream/*`, `/api/*`, and SPA assets all resolve through the same public front door.
  - SSE works end-to-end without proxy buffering regressions.
  - Production docs stop implying a supported multi-node control plane when that is not true.
- Verification:
  - Deploy the chart in a test cluster and confirm stream resume still works through the exposed route.
  - Confirm health checks hit the intended front door and backend.
- Pitfalls:
  - Reverse proxy buffering can silently break SSE.
  - Cookie, auth header, and cache behavior must remain correct through the chosen front door.

### Suggested slices

- `OC-001a` Choose and document the canonical production entrypoint shape.
- `OC-001b` Align Helm deployment, service, and route configuration with that shape.
- `OC-001c` Validate SSE, `/api/*`, and static asset routing through the same front door.
- `OC-001d` Remove or clearly gate scale-out guidance that is not yet operationally honest.

### Size and risk

- `OC-001a`: `S`, medium risk.
- `OC-001b`: `M`, medium risk.
- `OC-001c`: `S`, medium risk.
- `OC-001d`: `S`, low risk.

### Notes for execution

- Keep this ticket mostly topology and docs focused; avoid combining it with stream protocol changes.
- Land manifest and docs alignment before changing anything deeper in the client stream stack.
- Treat a working end-to-end SSE smoke test as part of the ticket, not a follow-up.

## `OC-002` Deferred: Remove Sandbox Env Token Injection

- Status: deferred from the active backlog for now.

- Why now: `src/services/container-agent/container-exec.service.ts` currently passes `CLAUDE_OAUTH_TOKEN` into `sandbox.execStream()` via process env, which is too easy to leak through process inspection, crash logs, inherited child processes, or debugging output.
- Primary files: `src/services/container-agent/container-exec.service.ts`, `charts/agentpane/templates/deployment.yaml`, `src/lib/sandbox/providers/sandbox-provider.ts`, any sandbox bootstrap or secret-loading code added during implementation.
- Scope:
  - Replace long-lived env-var injection with file-based credentials or a short-lived credential handoff.
  - Ensure sandbox startup can still fail explicitly when credentials are missing or expired.
  - Audit logging and diagnostics so token material is never emitted.
- Acceptance criteria:
  - No sandbox execution path passes a long-lived OAuth token in child process env.
  - Credential material is mounted, brokered, or injected in a form with a narrower exposure window.
  - Missing or expired credentials surface as a first-class startup failure, not a vague downstream tool error.
- Verification:
  - Add automated coverage around the exec request shape so credential material is absent from env.
  - Validate token rotation and cleanup behavior during sandbox teardown.
- Pitfalls:
  - Temporary files need strict permissions and cleanup.
  - A secret-manager change is not enough if the runtime handoff still uses env vars internally.

## `OC-003` Deferred: Default Hosted Sandboxes To gVisor

- Status: deferred from the active backlog for now.

- Why now: `charts/agentpane/values.yaml` still defaults `sandbox.runtimeClassName` to `"none"`, even though stronger isolation is one of the clearest near-term safety wins.
- Primary files: `charts/agentpane/values.yaml`, sandbox deployment templates, `src/lib/sandbox/providers/sandbox-provider.ts`, sandbox startup and error-reporting paths.
- Scope:
  - Make gVisor the default hosted runtime class.
  - Keep an explicit escape hatch for clusters that do not support it.
  - Surface sandbox compatibility failures separately from generic startup failures.
- Acceptance criteria:
  - Hosted defaults use gVisor unless explicitly overridden.
  - Unsupported runtime-class or syscall-compatibility failures are visible to operators and users.
  - Docs explain the supported fallback path instead of silently degrading to `none`.
- Verification:
  - Smoke-test planning and execution runs under gVisor in the supported cluster profile.
  - Confirm unsupported-cluster behavior is explicit and actionable.
- Pitfalls:
  - Some workloads will fail under gVisor and must not look like random flakiness.
  - Local Docker development should not be broken by hosted-only defaults.

### Suggested slices

- `OC-003a` Change the chart default from `none` to `gvisor` and document the override path.
- `OC-003b` Add sandbox startup error classification for unsupported runtime class and common compatibility failures.
- `OC-003c` Add a hosted smoke-test checklist or automated validation for planning and execution under gVisor.

## `OC-004` Expose Honest Live Health States

- Why now: the app often knows that startup or streaming is degraded, but users mostly see a confident transcript shell plus logs and toasts. The current state surface in `src/lib/streams/client.ts`, `src/app/hooks/use-session.ts`, and `src/app/components/features/agent-session-view/stream-panel.tsx` is too narrow.
- Primary files: `src/lib/streams/client.ts`, `src/app/hooks/use-session.ts`, `src/app/components/features/agent-session-view/stream-panel.tsx`, `src/app/components/features/plan-session-view/*`, `src/app/components/features/live-task-view/*`, `src/lib/task-creation/sync.ts`, `src/app/components/features/cli-monitor/terminal-pane.tsx`.
- Scope:
  - Define a shared state model for `starting`, `live`, `reconnecting`, `catching_up`, `degraded`, `startup_failed`, and `disconnected`.
  - Map backend and stream conditions into those states consistently.
  - Show the same semantics across session view, plan view, task creation, and CLI monitor.
- Acceptance criteria:
  - Core live surfaces stop relying on toasts alone for startup and stream failures.
  - Users can distinguish connected-but-idle from reconnecting, catching up, and degraded.
  - Copy and visuals are consistent across live surfaces.
- Verification:
  - Add UI-state coverage for cold start, reconnect, stream loss, and startup failure paths.
  - Manually verify that a failed startup does not leave a task looking healthy.
- Pitfalls:
  - Do not invent states the backend cannot support honestly.
  - Avoid slightly different health vocabularies in different panes.

### Suggested slices

- `OC-004a` Define the shared live-health state enum and mapping rules.
- `OC-004b` Apply the shared state model to the main session view.
- `OC-004c` Apply the same state model to plan view, task creation, and CLI monitor.
- `OC-004d` Add UI-state coverage for cold start, reconnect, catch-up, degraded, and startup failure.

### Size and risk

- `OC-004a`: `S`, medium risk.
- `OC-004b`: `M`, medium risk.
- `OC-004c`: `M`, medium risk.
- `OC-004d`: `S`, low risk.

### Notes for execution

- Keep wording consistent across surfaces; do not let each panel invent its own labels.
- Start with the main session view because it is the most visible transcript surface.
- Only expose states the backend or client can actually infer without guesswork.

## `OC-005` Adopt A Structured Stream Envelope

- Why now: `src/lib/agents/chunk-batcher.ts` publishes hot deltas to SSE before durability, while client parsing in `src/lib/streams/client.ts` and transcript rendering in `src/app/components/features/agent-session-view/use-stream-parser.ts` still rely on weak synthetic identity.
- Primary files: `src/lib/agents/chunk-batcher.ts`, `src/lib/agents/stream-handler.ts`, `src/services/session/session-stream.service.ts`, `src/services/durable-streams.service.ts`, `src/lib/streams/client.ts`, transcript parsing/rendering code, and any shared event-type definitions.
- Scope:
  - Define a single event envelope with `eventId`, `blockId`, `partType`, `durability`, and `schemaVersion`.
  - Apply it to chunk, tool, system, diff, and lifecycle events.
  - Plan a backwards-compatible rollout so old consumers do not silently misread new events.
- Acceptance criteria:
  - Every newly emitted stream event has stable identity and explicit schema versioning.
  - The UI can distinguish transient live output from durable replayed output.
  - Client dedupe no longer relies on timestamp-plus-index synthetic IDs.
- Verification:
  - Add round-trip tests for event emission, replay, reconnect, and client parsing.
  - Confirm mixed old/new protocol behavior is either supported or explicitly blocked.
- Pitfalls:
  - A sloppy migration can create two overlapping protocols with ambiguous semantics.
  - Do not declare events durable unless they are actually persisted before the UI relies on them.

### Suggested slices

- `OC-005a` Define the event envelope schema and shared type definitions.
- `OC-005b` Update server emitters for chunk, tool, and lifecycle events.
- `OC-005c` Update client parsing and rendering to use stable event identity.
- `OC-005d` Add backwards-compatibility handling or an explicit migration gate.

### Size and risk

- `OC-005a`: `M`, high risk.
- `OC-005b`: `L`, high risk.
- `OC-005c`: `L`, high risk.
- `OC-005d`: `M`, high risk.

### Notes for execution

- Put the schema in one shared source of truth early.
- Keep migration explicit; silent dual-protocol behavior is likely to create hard-to-debug transcript bugs.
- This ticket should make later reconnect and virtualization work easier, not harder.

## `OC-006` Preserve Opaque Resume Cursors End-To-End

- Why now: `src/lib/streams/client.ts` tracks opaque stream offsets but drops them during event mapping and exposes only a lossy numeric approximation, while `src/app/hooks/use-session.ts` still falls back to reconnect-from-zero behavior.
- Primary files: `src/lib/streams/client.ts`, `src/app/hooks/use-session.ts`, `src/server/routes/sessions.ts`, any catch-up APIs, and the durable stream subscription layer.
- Scope:
  - Keep the durable stream cursor opaque from transport through client state.
  - Remove `parseInt()`-style offset coercion from reconnect logic.
  - Replace numeric catch-up assumptions with a real cursor or a safe translation layer.
- Acceptance criteria:
  - Reconnect uses a real resume cursor instead of resetting to `0`.
  - No client path coerces durable cursors to numbers for correctness-critical logic.
  - Duplicate and missing event regressions are covered in automated tests.
- Verification:
  - Simulate disconnects during long sessions and confirm lossless catch-up.
  - Verify cursor handling with both realtime and replay responses.
- Pitfalls:
  - Old cursor formats and new cursor formats can collide during rollout.
  - Cache hydration later must not resurrect already-consumed events.

### Suggested slices

- `OC-006a` Preserve opaque cursor values in the durable streams client.
- `OC-006b` Replace reconnect-from-zero behavior in `useSession()`.
- `OC-006c` Update catch-up APIs or adapters to accept real resume cursors.
- `OC-006d` Add disconnect/reconnect regression coverage for duplicates and gaps.

### Size and risk

- `OC-006a`: `S`, high risk.
- `OC-006b`: `M`, high risk.
- `OC-006c`: `M`, high risk.
- `OC-006d`: `S`, medium risk.

### Notes for execution

- Treat cursor preservation as correctness work, not refactor cleanup.
- Avoid numeric fallback behavior in any path that can affect replay fidelity.
- Verify this against both live reconnect and refresh-driven replay.

## `OC-007` Add Dexie-Backed Durable Session Hydration

- Why now: long-session reload still depends on network replay, which makes refresh feel punitive and weakens trust when reconnect is slow.
- Primary files: `src/app/hooks/use-session.ts`, any new client persistence layer, transcript surfaces, and future multi-tab coordination hooks.
- Scope:
  - Persist durable session blocks, tool events, summaries, and last-read position in IndexedDB via Dexie.
  - Add versioning, eviction, and fallback behavior when IndexedDB is unavailable.
  - Hydrate from local durable state before live catch-up begins.
- Acceptance criteria:
  - Reloading a long session restores a usable transcript quickly from local cache.
  - Cache contents merge cleanly with server catch-up without duplicate durable blocks.
  - Transient token-by-token deltas are not persisted forever.
- Verification:
  - Test normal reload, hard refresh, quota exhaustion, and IndexedDB-unavailable scenarios.
  - Measure time-to-usable-transcript before and after the change.
- Pitfalls:
  - Safari private mode and low-storage environments need a graceful fallback.
  - Schema drift can make old cache contents look like fresh truth if versioning is weak.

### Suggested slices

- `OC-007a` Define Dexie schema, cache versioning, and eviction policy.
- `OC-007b` Persist durable session blocks and metadata after successful replay.
- `OC-007c` Hydrate transcript state from IndexedDB before live catch-up.
- `OC-007d` Add fallback behavior and tests for unsupported or quota-limited browsers.

### Size and risk

- `OC-007a`: `M`, medium risk.
- `OC-007b`: `M`, medium risk.
- `OC-007c`: `M`, medium risk.
- `OC-007d`: `S`, low risk.

### Notes for execution

- Do not start this before stream identity and resume semantics are stable enough to merge cached and live data safely.
- Persist durable blocks, not every transient micro-delta.
- Define cache invalidation and versioning before writing data.

## `OC-008` Replace Full Transcript Rebuilds With Append-Only Timelines And Virtualization

- Why now: `src/app/hooks/use-session.ts` copies arrays, `src/app/components/features/agent-session-view/use-stream-parser.ts` merges and sorts every event on each change, and `src/app/components/features/agent-session-view/stream-panel.tsx` renders the full line list into the DOM.
- Primary files: `src/app/hooks/use-session.ts`, `src/app/components/features/agent-session-view/use-stream-parser.ts`, `src/app/components/features/agent-session-view/stream-panel.tsx`, `src/app/components/features/live-task-view/audit-trail-panel.tsx`, and any shared list primitives.
- Scope:
  - Move transcript state toward an append-only timeline or external store model.
  - Preserve stable line IDs from source events instead of synthetic index-based identities.
  - Virtualize transcript and audit panes with `react-virtuoso` or equivalent log-friendly virtualization.
  - Preserve follow-output, scrollback, and jump-to-bottom behavior.
- Acceptance criteria:
  - Normal append flow does not trigger full merge-sort work for the entire transcript.
  - Long sessions stay responsive past the current several-thousand-event threshold.
  - Virtualized panes preserve live-follow behavior and readable scrollback.
- Verification:
  - Profile transcript append cost before and after the refactor.
  - Manually verify mixed-content sessions with chunks, tools, and terminal output.
- Pitfalls:
  - Mixed row heights and pinned-bottom behavior make log virtualization tricky.
  - A fast virtualized list still fails if event identity remains unstable.

### Suggested slices

- `OC-008a` Replace synthetic line IDs with stable source-derived IDs.
- `OC-008b` Move transcript parsing toward append-only updates instead of full merge-sort rebuilds.
- `OC-008c` Virtualize the main session transcript with `react-virtuoso` or equivalent.
- `OC-008d` Apply the same pattern to audit or other long live-output panes.

### Size and risk

- `OC-008a`: `S`, medium risk.
- `OC-008b`: `L`, medium risk.
- `OC-008c`: `M`, medium risk.
- `OC-008d`: `M`, low risk.

### Notes for execution

- Stable event identity should land before virtualization.
- Keep follow-output and scrollback behavior as a hard requirement, not optional polish.
- Profile before and after each slice so performance improvements stay measurable.

## Recommended PR Order

This is the smallest practical sequence that keeps dependencies clear.

1. `OC-001a` + `OC-001b`: choose the canonical front door and align Helm/docs.
2. `OC-001c` + `OC-001d`: validate end-to-end routing and remove misleading scale-out guidance.
3. `OC-004a` + `OC-004b`: define shared live-health states and land them in the main session view.
4. `OC-005a` + `OC-005b`: define the structured stream envelope and update server emitters.
5. `OC-005c` + `OC-005d`: update client parsing and gate or migrate old protocol behavior.
6. `OC-006a` + `OC-006b`: preserve opaque resume cursors and remove reconnect-from-zero behavior.
7. `OC-006c` + `OC-006d`: update catch-up paths and add reconnect regression tests.
8. `OC-008a` + `OC-008b`: stabilize line identity and move to append-only transcript updates.
9. `OC-008c` + `OC-008d`: virtualize transcript-heavy panes.
10. `OC-007a` through `OC-007d`: add durable local hydration once stream correctness is stable.

## Recommended First Three PRs

If the team wants the smallest useful starting set, begin here:

1. `OC-001a` + `OC-001b`
   - Size: `M`
   - Risk: medium
   - Outcome: the deployment story becomes honest before deeper fixes land.
2. `OC-004a` + `OC-004b`
   - Size: `M`
   - Risk: medium
   - Outcome: the main live transcript stops over-promising health.
3. `OC-005a`
   - Size: `M`
   - Risk: high
   - Outcome: the stream contract is defined before server/client migration work starts.

## What To Avoid While Executing

- Do not combine topology cleanup and protocol redesign in the same PR.
- Do not start Dexie hydration before resume cursors and stable event identity are working.
- Do not virtualize transcript panes while line identity is still synthetic or unstable.
- Do not ship surface-level live-state labels that the backend cannot support honestly.

## Deferred Until This Tranche Lands

These are important, but they should not interrupt the Phase 0 and Phase 1 queue above:

- `OC-002` sandbox credential handoff hardening.
- `OC-003` gVisor default isolation rollout.
- Presence redesign and multi-tab coordination.
- Task-creation multi-tab stream fixes.
- Full run tracing with OpenTelemetry, Langfuse, and Sentry.
- Memory visibility and approval-state cleanup.
- Shiki rollout for completed code blocks and diffs.

## Definition Of Done For This Tranche

- Production docs and deployment topology stop contradicting each other.
- Live-state reporting is materially more honest and trustworthy.
- Users can tell whether live output is healthy, degraded, replaying, or broken.
- Reconnect uses stable stream identity and real resume cursors.
- Refresh restores durable transcript state quickly and long sessions remain responsive.
