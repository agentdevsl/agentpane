# Validation Matrix

Date: March 2026

This matrix defines the minimum validation expectations for the first active
implementation tranche:

1. `OC-005` structured stream envelope
2. `OC-006` opaque resume cursors

The goal is simple: do not call the tranche done just because the code compiles.

## Validation Principles

- Prefer correctness validation over visual polish in this tranche.
- Test both normal flow and failure/reconnect flow.
- Treat duplicate or missing transcript events as release-blocking regressions.
- Validate both server emission semantics and client replay behavior.

## `OC-005` Structured Stream Envelope

| Scenario | What to verify | Why it matters |
| --- | --- | --- |
| New chunk event emission | Chunk events include stable `eventId`, `blockId`, `partType`, `durability`, and `schemaVersion` | Establishes the core protocol contract |
| Tool event emission | Tool start, result, and error events follow the same schema rules | Prevents one-off protocol exceptions |
| Lifecycle/system event emission | Non-chunk events still carry stable identity and explicit semantics | Ensures the schema is truly shared |
| Durable vs transient labeling | Hot deltas are not mislabeled as durable before persistence | Prevents the UI from overstating safety |
| Client parsing | The client reads stable IDs from the envelope rather than rebuilding synthetic identity | Required for replay trust and later performance work |
| Migration handling | Old/new protocol behavior is explicitly supported or explicitly blocked | Avoids ambiguous rollout behavior |

### `OC-005` Minimum automated coverage

- Schema-level tests for the shared event envelope.
- Server-side tests for chunk, tool, and lifecycle event emission.
- Client-side tests that stable IDs survive parsing and mapping.
- Regression coverage for mixed old/new event payload handling if coexistence is supported.

Current tranche status:

- Covered now: shared envelope parsing, durable-stream metadata propagation, task-creation tool events, agent resume metadata, stable tool identity parsing, and live-consumer replay dedupe.
- Covered now: shared envelope parsing, durable-stream metadata propagation, task-creation tool events, agent resume metadata, stable tool identity parsing, live-consumer replay dedupe, and transcript durability label rendering in the main agent session stream.
- Still missing or incomplete: explicit automated coverage for `blockId`/`sequence`-aware transcript grouping semantics and a hard old/new protocol migration gate.

### `OC-005` Manual verification

- Start a normal agent run and confirm the transcript surfaces stable event identity.
- Confirm a hot streaming phase does not appear falsely durable.
- Confirm tool output still renders correctly after the schema shift.

## `OC-006` Opaque Resume Cursors

| Scenario | What to verify | Why it matters |
| --- | --- | --- |
| Initial subscribe | The client stores the opaque resume cursor without numeric coercion | Preserves real replay identity |
| Normal reconnect | The client reconnects using the last real cursor, not `0` | Prevents duplicate or missing events |
| Refresh-driven replay | Replay after refresh still preserves opaque cursor semantics | Connects reconnect and reload behavior |
| Catch-up API compatibility | Any compatibility layer preserves correctness if the API still expects numeric inputs | Prevents hidden replay drift |
| Duplicate event handling | Reconnect does not duplicate already-consumed durable events | Core trust requirement |
| Gap detection | Missing events are detectable and treated as a failure, not silent success | Prevents false confidence |

### `OC-006` Minimum automated coverage

- Tests that cursor values remain opaque through the durable streams client path.
- Tests that reconnect no longer resets to `0`.
- Regression coverage for duplicate and gap scenarios.
- Tests for refresh-driven catch-up behavior where feasible.

Current tranche status:

- Covered now: opaque cursor preservation, clean-close reconnect resume, transient reconnect mixed chunk/tool replay, session-history refresh via `afterEventId`, and replay dedupe in major live consumers.
- Manual verification remains required for reconnect/refresh continuity before calling the tranche fully complete.

### `OC-006` Manual verification

- Interrupt a long-running session and confirm reconnect resumes from the correct point.
- Refresh during or immediately after a streaming phase and confirm transcript continuity.
- Verify that reconnect after tool output does not replay tool lines incorrectly.

## Exit Checks For The First Tranche

Do not move on to `OC-001` and `OC-004` until all of these are true:

- Stream envelope fields are stable and documented.
- Durable versus transient output semantics are visible and internally consistent.
- Main reconnect behavior no longer falls back to `0`.
- Duplicate and gap regressions are covered by tests and checked manually.
- The team can explain how old/new protocol behavior is handled during rollout.

## Non-Goals For This Validation Pass

- Full transcript virtualization performance testing.
- Dexie hydration correctness testing.
- Deployment topology validation for Helm and Caddy alignment.
- Final UI-state wording across all live surfaces.

Those belong to later tranches.
