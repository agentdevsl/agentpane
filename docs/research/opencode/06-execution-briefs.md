# Execution Briefs

Date: March 2026

This document turns the active queue from
`docs/research/opencode/04-implementation-backlog.md` into issue-ready and
PR-ready planning briefs. It covers only the active items:

- `OC-005`
- `OC-006`
- `OC-001`
- `OC-004`
- `OC-008`
- `OC-007`

Deferred items `OC-002` and `OC-003` are intentionally left out of the active
execution briefs.

## Issue Summary

| ID | Suggested issue title | Priority | Size | Risk |
| --- | --- | --- | --- | --- |
| `OC-005` | Introduce a structured stream envelope with stable event identity | P1 | L | High |
| `OC-006` | Preserve opaque durable-stream resume cursors end-to-end | P1 | M | High |
| `OC-001` | Align deployed front door with documented Caddy durable-streams topology | P0 | M | Medium |
| `OC-004` | Add a shared live health state model across live AgentPane surfaces | P0 | M | Medium |
| `OC-008` | Replace full transcript rebuilds with append-only timelines and virtualization | P1 | L | Medium |
| `OC-007` | Add Dexie-backed durable session hydration for reload resilience | P1 | M | Medium |

## Issue Briefs

### `OC-005` Introduce a structured stream envelope with stable event identity

- Suggested labels: `architecture`, `streaming`, `protocol`, `backend`, `frontend`, `P1`
- Problem:
  - The current stream path relies on weak synthetic identity.
  - Hot chunk delivery is realtime-first, while durable semantics remain implicit.
  - Client dedupe and replay confidence are weaker than they should be.
- Desired outcome:
  - Every stream event has stable identity and explicit schema versioning.
  - The UI can distinguish transient live output from durable replayed output.
- Key files:
  - `src/lib/agents/chunk-batcher.ts`
  - `src/lib/agents/stream-handler.ts`
  - `src/services/session/session-stream.service.ts`
  - `src/services/durable-streams.service.ts`
  - `src/lib/streams/client.ts`
  - `src/app/components/features/agent-session-view/use-stream-parser.ts`
- In scope:
  - Define one shared envelope with `eventId`, `blockId`, `partType`, `durability`, and `schemaVersion`.
  - Update server emitters to use that envelope.
  - Update client parsing and rendering to rely on stable event identity.
  - Make migration behavior explicit.
- Out of scope:
  - Dexie hydration.
  - Virtualization.
  - Broad event-bus or service-backplane changes.
- Acceptance criteria:
  - Newly emitted events have stable IDs and explicit schema versioning.
  - Client dedupe no longer relies on timestamp-plus-index identity.
  - Old/new protocol behavior is either supported explicitly or blocked explicitly.
- Rollout notes:
  - Land the shared schema first.
  - Avoid ambiguous dual-protocol behavior during rollout.

### `OC-006` Preserve opaque durable-stream resume cursors end-to-end

- Suggested labels: `streaming`, `correctness`, `frontend`, `backend`, `P1`
- Problem:
  - The durable streams client tracks opaque offsets but drops them during event mapping.
  - `useSession()` still has reconnect-from-zero behavior.
  - Numeric fallbacks risk duplicate and missing events.
- Desired outcome:
  - Resume and replay use real opaque cursors end-to-end.
  - Reconnect correctness no longer depends on lossy numeric parsing.
- Key files:
  - `src/lib/streams/client.ts`
  - `src/app/hooks/use-session.ts`
  - `src/server/routes/sessions.ts`
- In scope:
  - Preserve opaque cursor values in the client subscription layer.
  - Remove reconnect-from-zero behavior.
  - Update catch-up APIs or compatibility adapters to accept real resume cursors.
  - Add disconnect/reconnect regression coverage.
- Out of scope:
  - New caching layers.
  - UI-health wording beyond what is needed for correctness.
- Acceptance criteria:
  - Reconnect does not reset to `0`.
  - No correctness-critical path coerces durable cursors to numeric approximations.
  - Automated tests cover duplicate/gap scenarios.
- Rollout notes:
  - Validate both reconnect and refresh-driven replay.
  - Treat this as correctness work, not just refactoring.

### `OC-001` Align deployed front door with documented Caddy durable-streams topology

- Suggested labels: `architecture`, `deployment`, `streaming`, `P0`
- Problem:
  - `Caddyfile` and the durable-streams docs describe Caddy on `:3000` as the public front door.
  - Helm currently exposes Bun on `:3001` instead.
  - That mismatch makes production behavior harder to reason about and weakens confidence in streaming behavior.
- Desired outcome:
  - One official production topology for `/v1/stream/*`, `/api/*`, and static assets.
  - Docs, runtime entrypoint, and Helm all match.
- Key files:
  - `Caddyfile`
  - `docker/start.sh`
  - `charts/agentpane/templates/deployment.yaml`
  - `charts/agentpane/templates/service.yaml`
  - `charts/agentpane/templates/httproute.yaml`
  - `charts/agentpane/templates/hpa.yaml`
  - `docs/durable-streams-architecture.md`
- In scope:
  - Choose the canonical production front-door shape.
  - Align deployment, service, and route configuration with that choice.
  - Validate SSE, API, and static asset routing through the same front door.
  - Gate or remove scale-out guidance that is not yet operationally honest.
- Out of scope:
  - Stream protocol redesign.
  - Reconnect cursor changes.
  - Sandbox isolation or credential handoff work.
- Acceptance criteria:
  - The documented production topology matches the shipped manifests.
  - `/v1/stream/*`, `/api/*`, and SPA assets route through the same public entrypoint.
  - SSE continues to work without proxy buffering regressions.
  - Docs stop implying supported multi-node control-plane behavior where it does not exist.
- Rollout notes:
  - Smoke-test a deployed chart before calling this done.
  - Check cookie, header, and cache behavior at the chosen front door.

### `OC-004` Add a shared live health state model across live AgentPane surfaces

- Suggested labels: `ux`, `streaming`, `frontend`, `reliability`, `P0`
- Problem:
  - The product often knows more about startup and stream health than it shows.
  - Main session view, plan view, task creation, and CLI monitoring do not present one consistent health model.
- Desired outcome:
  - Users can tell whether output is `starting`, `live`, `reconnecting`, `catching_up`, `degraded`, `startup_failed`, or `disconnected`.
  - Similar live surfaces use the same state language.
- Key files:
  - `src/lib/streams/client.ts`
  - `src/app/hooks/use-session.ts`
  - `src/app/components/features/agent-session-view/stream-panel.tsx`
  - `src/app/components/features/plan-session-view/*`
  - `src/lib/task-creation/sync.ts`
  - `src/app/components/features/cli-monitor/terminal-pane.tsx`
- In scope:
  - Define the shared health-state enum and mapping rules.
  - Apply the model to the main session view first.
  - Extend the same semantics to plan view, task creation, and CLI monitor.
  - Add focused UI-state coverage.
- Out of scope:
  - Stream envelope migration.
  - Resume cursor correctness fixes.
  - Presence redesign.
- Acceptance criteria:
  - Core live surfaces no longer rely on toasts alone for startup and stream failures.
  - The same health vocabulary appears across live surfaces.
  - A failed startup does not leave the UI looking healthy.
- Rollout notes:
  - Start with the main session transcript.
  - Avoid surfacing states the backend cannot infer honestly.

### `OC-008` Replace full transcript rebuilds with append-only timelines and virtualization

- Suggested labels: `performance`, `frontend`, `streaming`, `P1`
- Problem:
  - Transcript rendering cost currently grows with session length.
  - The main path still does array copies, merge-sorts, and full DOM rendering.
- Desired outcome:
  - Transcript updates become append-oriented.
  - Long sessions remain responsive.
  - Virtualized panes preserve follow-output and readable scrollback.
- Key files:
  - `src/app/hooks/use-session.ts`
  - `src/app/components/features/agent-session-view/use-stream-parser.ts`
  - `src/app/components/features/agent-session-view/stream-panel.tsx`
  - `src/app/components/features/live-task-view/audit-trail-panel.tsx`
- In scope:
  - Replace synthetic line IDs with stable source-derived IDs.
  - Move transcript parsing away from full merge-sort rebuilds.
  - Virtualize transcript-heavy panes.
  - Preserve follow-output, jump-to-bottom, and scrollback behavior.
- Out of scope:
  - Durable session caching.
  - Protocol schema changes beyond what is needed for stable IDs.
- Acceptance criteria:
  - Append flow no longer rebuilds the full transcript on every update.
  - Long sessions stay responsive past the current several-thousand-event threshold.
  - Virtualized panes retain usable live-follow behavior.
- Rollout notes:
  - Stable event identity should land first.
  - Profile before and after each major slice.

### `OC-007` Add Dexie-backed durable session hydration for reload resilience

- Suggested labels: `frontend`, `local-first`, `streaming`, `P1`
- Problem:
  - Refresh still depends too heavily on network replay.
  - Long-session reload feels punitive and weakens trust.
- Desired outcome:
  - Durable transcript state restores quickly from local cache before live catch-up completes.
- Key files:
  - `src/app/hooks/use-session.ts`
  - new client persistence layer files
  - transcript surface integration points
- In scope:
  - Define Dexie schema, versioning, and eviction policy.
  - Persist durable session blocks, tool events, summaries, and last-read position.
  - Hydrate transcript state from IndexedDB before live catch-up.
  - Add browser-edge-case fallbacks.
- Out of scope:
  - SharedWorker or BroadcastChannel multi-tab coordination.
  - Persisting every transient token delta.
- Acceptance criteria:
  - Reloading a long session restores useful transcript state quickly from local durable cache.
  - Cached state merges cleanly with server catch-up.
  - Unsupported or quota-limited browsers degrade gracefully.
- Rollout notes:
  - Do this only after stream identity and resume semantics are stable.
  - Persist durable blocks, not token-by-token transient data.

## First PR Briefs

These are the first three PRs to open once implementation begins.

### `PR-001` `OC-005a`

- Suggested PR title: `feat: define the versioned stream envelope contract`
- Goal:
  - Establish the shared stream schema before changing emitters and consumers.
- Scope:
  - Shared type/schema definitions.
  - Versioning rules.
  - Clear durability semantics.
- Out of scope:
  - Server emitter migration.
  - Client parser migration.
- Verification:
  - A single shared source of truth exists for the new stream contract.
  - The schema is concrete enough to drive both server and client implementation.

### `PR-002` `OC-006a` + `OC-006b`

- Suggested PR title: `fix: preserve resume cursors in the main session stream path`
- Goal:
  - Stop losing opaque resume cursor identity and remove reconnect-from-zero behavior in the main path.
- Scope:
  - Preserve opaque cursor values in the client.
  - Update main session reconnect handling.
  - Add focused regression coverage where practical.
- Out of scope:
  - Full catch-up API migration.
  - Transcript virtualization.
- Verification:
  - Main reconnect flow no longer resets to `0`.
  - Cursor values remain opaque and stable through the path being changed.

### `PR-003` `OC-001a` + `OC-001b`

- Suggested PR title: `docs/deploy: align Helm with the canonical front-door topology`
- Goal:
  - Pick the official production front door and make Helm plus docs match it.
- Scope:
  - Canonical topology decision.
  - Manifest alignment in deployment, service, and route config.
  - Related doc updates.
- Out of scope:
  - SSE protocol changes.
  - Client reconnect logic.
- Verification:
  - Deployed route shape matches docs.
  - SSE path, API path, and SPA path all resolve through the chosen front door.

## Notes

- Use these briefs as copy-paste starting points for GitHub issues or project tasks.
- If the active queue changes, update this file and `docs/research/opencode/04-implementation-backlog.md` together.
