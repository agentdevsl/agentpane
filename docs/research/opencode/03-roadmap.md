# Recommended Roadmap

Date: March 2026

This roadmap is intentionally UX-first. It prioritizes changes that users will
notice directly and operators can trust immediately.

## Principle

Fix semantics before scale.

AgentPane should not pursue a bigger architecture until the current product can
honestly answer these questions:

- Is the output I am seeing durable?
- If I refresh, will I get the same truth back?
- If the run stalls, can I tell whether it is working, reconnecting, or broken?
- If the system restarts, do I resume, recover, or lose progress?
- If the agent made a strange decision, can I tell whether memory, a tool, or a sandbox issue caused it?

## Recommended Near-Term Operating Model

For the next major iteration, optimize for an honest single-node control plane:

- one real front door,
- one coherent stream lifecycle,
- SQLite plus off-node backup,
- SSE for primary agent output,
- selective WebSocket only where full-duplex interaction is real,
- gVisor as default hosted sandbox isolation,
- Dexie-backed reload resilience,
- and full run tracing.

Do not try to be both a single-node local-first app and a multi-node control
plane at the same time.

## Phase 0: Reality And Safety

Goal: remove the most misleading architectural contradictions.

### Work

- Fix the production topology so the official deployment path actually routes through the documented front door. The current mismatch between `Caddyfile:6` and the Helm templates must be resolved.
- Stop passing OAuth tokens as sandbox env vars. Replace `CLAUDE_OAUTH_TOKEN` injection in `src/services/container-agent/container-exec.service.ts:657` with file-based or short-lived credentials.
- Make gVisor the default sandbox isolation mode instead of leaving `runtimeClassName: "none"` in `charts/agentpane/values.yaml:295`.
- Freeze multi-instance claims until streams, rate limiting, and backplane semantics are real. In practice that means no autoscaling on the control plane yet.
- Introduce explicit user-facing degraded states for startup and streaming. Do not hide these behind logs and toasts.

### User-visible outcome

- Fewer situations where the UI looks healthy while the system is only partially working.
- Stronger safety story for running untrusted code.

### Exit criteria

- Official production docs match the official deployment manifests.
- No sandbox path injects long-lived OAuth credentials as plain env vars.
- The product can display `realtime degraded` and `startup failed` as first-class states.

## Phase 1: Transcript Trust And Responsiveness

Goal: make long-running sessions feel durable, fast, and understandable.

### Work

- Adopt a structured stream protocol with stable event IDs, block IDs, `schemaVersion`, and a transient/durable distinction.
- Replace numeric reconnect pagination assumptions with real resume cursors. The current `offset=0` reconnect fallback in `src/app/hooks/use-session.ts:163` needs a real replacement.
- Add Dexie-backed local persistence for durable session blocks, tool events, summaries, and last-read position.
- Replace full stream re-sorts with append-only timelines.
- Virtualize transcript and audit panes with `react-virtuoso`.
- Add explicit connection UI states: `live`, `reconnecting`, `catching up`, `stale`, `degraded`.
- Activate Shiki for code and diff readability.

### User-visible outcome

- Refresh no longer feels like a punishment.
- Long sessions remain responsive.
- Reconnect behavior becomes believable.
- Users can tell whether they are watching durable history or live buffered output.

### Exit criteria

- Reloading a long session restores a usable transcript quickly from local cache.
- Stream panes stay responsive well past the current several-thousand-event threshold.
- Connection state is visible and actionable in every live surface.

## Phase 2: Multi-Tab And Collaboration Sanity

Goal: remove split-brain behavior and inconsistent live semantics across the app.

### Work

- Redesign presence as connection-scoped, not user-scoped.
- Remove presence from the durable `session_events` hot path.
- Replace presence polling with streamed or awareness-based updates.
- Add BroadcastChannel-based multi-tab coordination for shared connection state and local hydration.
- Unify stream lifecycle behavior across session view, plan view, task creation, and CLI monitor.
- Fix the task-creation latest-tab-wins controller bug in `src/server/routes/task-creation.ts:48`.
- Introduce a shared optimistic action helper for run/stop/approve/reject/move flows.

### User-visible outcome

- Presence stops lying.
- Multiple tabs stop fighting each other.
- Similar actions feel similar across the product.

### Exit criteria

- No core flow relies on both polling and streaming for the same state.
- Task creation can be open in multiple tabs without silent stream theft.
- Presence semantics survive multiple tabs from the same user correctly.

## Phase 3: Trust, Review, And Operator Visibility

Goal: make runs explainable and approvals meaningful.

### Work

- Instrument the run lifecycle with OpenTelemetry spans across task move, sandbox startup, planning, approval, execution, and completion.
- Feed those traces to Langfuse and add Sentry for product-facing reliability monitoring.
- Add structured diff events and stronger file-level review surfaces.
- Upgrade the approval dialog so plan review includes phase structure, swarm metadata, sandbox continuity, and expected impact, not just markdown.
- Make memory inspectable: show whether memory was available, how many facts were injected, and where they came from.
- Split overloaded approval states into clearer concepts such as `plan_review`, `execution_review`, `interrupted`, and `needs_attention`.
- Add team-saga states for spawn, merge, compensation, and failure.

### User-visible outcome

- Users trust approvals more because they review intent and impact, not just transcripts.
- Operators can answer "what is it doing?" and "why did it fail?" without guesswork.

### Exit criteria

- A single trace can explain a run from task transition through sandbox startup to final review.
- Approval states map cleanly to what the user is being asked to do.
- Memory usage is visible enough that a user can challenge or suppress it.

## Phase 4: Choose The Scale Path Deliberately

Goal: make one strategic scale decision instead of carrying several half-true ones.

### Option A: Stay honest and single-node longer

Use this path if:

- most users are still self-hosted or small-team,
- the biggest pain is reliability, not throughput,
- and the product still benefits from SQLite simplicity.

Required technology stance:

- SQLite remains primary.
- Off-node backups become mandatory.
- Caddy Durable Streams remains the live transport.
- Multi-instance control-plane scaling remains off the table.

### Option B: Run a real PostgreSQL parity project

Use this path if:

- AgentPane needs a true multi-user control plane,
- hosted deployments are the priority,
- or product direction requires consistent durable sync across devices and users.

Required technology stance:

- PostgreSQL becomes the only primary DB, not a runtime toggle.
- Schema parity work is completed and enforced.
- Only after parity is real should Electric be considered for durable synced state.

### Option C: Add a service backplane later

Only consider NATS JetStream or similar if:

- the control plane becomes multi-service,
- multiple app instances must coordinate durable events,
- and the front-door and DB stories are already honest.

NATS is not the first scale decision. It is a later decision.

## Experiments To Run

These experiments have clear value and clear stop conditions.

### Dexie session cache

Success criteria:

- Reload to usable transcript is dramatically faster for long sessions.
- Cached state merges cleanly with server catch-up.

Stop conditions:

- Cache invalidation becomes error-prone.
- Browser storage edge cases create more confusion than the feature removes.

### `react-virtuoso` transcript virtualization

Success criteria:

- Long-session scrolling and interaction remain smooth.
- Follow-output behavior is easier to reason about than the current custom logic.

Stop conditions:

- Mixed-content rows become too difficult to measure.

### Node 24 hosted API spike

Success criteria:

- Production diagnostics and long-lived behavior are easier to reason about.
- No critical Bun-only features block the hosted runtime.

Stop conditions:

- Migration cost materially delays more important UX work.

### E2B sandbox provider trial

Success criteria:

- Hosted startup reliability or isolation materially improves over the current hosted path.

Stop conditions:

- Cost, latency, or lock-in outweighs the reliability gain.

### Mem0 dual-read evaluation

Success criteria:

- Retrieved context is meaningfully better with human review and provenance checks.

Stop conditions:

- It produces more plausible but less accountable memory behavior.

## Metrics To Track

If the architecture is improving, these numbers should move in the right direction.

- Time to first visible output.
- Time from refresh to usable transcript.
- Duplicate or missing event incidents after reconnect.
- Transcript render latency during long sessions.
- Sandbox startup success rate.
- Frequency of `in_progress` tasks with no real running agent.
- Frequency of stale presence incidents.
- Approval completion time.
- Rate of "realtime degraded" incidents.
- Percentage of runs with complete end-to-end traces.

## What Not To Do Next

Avoid these until the earlier phases are done.

- Do not replace SSE with WebSocket for primary agent output.
- Do not migrate to LiveStore or another client data-layer rewrite yet.
- Do not enable control-plane autoscaling while streams and rate limiting remain single-node assumptions.
- Do not keep marketing PostgreSQL as a ready runtime mode while parity gaps remain.
- Do not add NATS before the front-door, DB, and stream semantics are honest.
- Do not adopt a generic orchestration framework expecting it to fix trust, recovery, or UX.

## Final Recommendation

If only a small set of changes can happen soon, do these first:

1. Fix front-door honesty and secret handling.
2. Adopt structured stream semantics and real reconnect cursors.
3. Add Dexie-backed session hydration and transcript virtualization.
4. Add explicit connection and degraded-state UX everywhere live output appears.
5. Instrument the full run lifecycle with OpenTelemetry + Langfuse + Sentry.

Those five moves improve the product in the ways users actually feel:

- the transcript stops feeling fragile,
- live runs stop feeling mysterious,
- approvals become easier to trust,
- and operations become far less surprising.
