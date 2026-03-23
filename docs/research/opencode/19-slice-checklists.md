# Slice Checklists

Date: March 2026

This document turns the first-tranche slices into implementation-ready checklists.

Scope:

- `OC-005a`
- `OC-005b`
- `OC-005c`
- `OC-005d`
- `OC-006a`
- `OC-006b`
- `OC-006c`
- `OC-006d`

## Purpose

- Give each slice a short definition of ready and done.
- Reduce ambiguity when work moves from planning to execution.
- Keep the team aligned on what must be true before the next slice starts.

## `OC-005a` Shared Stream Schema

### Ready

- The team agrees on the envelope fields from `docs/research/opencode/13-stream-envelope-proposal.md`.
- Ownership of the shared schema module is clear.
- The migration rule for old/new protocol behavior is decided at least provisionally.

### Done

- One shared schema definition exists.
- `schemaVersion`, `eventId`, `streamId`, `blockId`, `partType`, `durability`, `sequence`, and `createdAt` are defined clearly.
- The schema is concrete enough for emitters and consumers to target.
- Open questions are narrowed to implementation details, not core field semantics.

## `OC-005b` Server Emitter Migration

### Ready

- `OC-005a` is done.
- The first event families to migrate are chosen.
- Emitter ownership is clear.

### Done

- Core server emitters produce stable event identity.
- Chunk, tool, and lifecycle semantics align with the new envelope.
- Durable versus transient behavior is explicit in emitted events.
- No critical event family in the main session path is left half-migrated.

### Implementation status

- Shared metadata helpers and envelope stamping are in place in `src/services/session/event-metadata.ts` and `src/services/durable-streams.service.ts`.
- Durable persistence now preserves payload `meta.eventId` instead of replacing it with a fresh DB ID.
- Core session emitters are migrated across chunk batching, agent lifecycle, task creation tool events, and agent resume flows.
- Typed durable-stream publishers now receive metadata automatically when their payload family is metadata-eligible.
- Remaining work is mostly audit/cleanup on less central producers and any parser surfaces that still underuse `blockId` or `sequence`.

## `OC-005c` Client Parser And Identity Migration

### Ready

- `OC-005a` is done.
- `OC-005b` is either done or far enough along to target real payloads.
- The main parser surfaces are identified from `docs/research/opencode/15-implementation-map.md`.

### Done

- Main client parsing consumes stable event identity.
- Transcript logic no longer depends on synthetic timestamp-plus-index identity in the main path.
- Grouping uses `blockId` and ordering uses `sequence` where relevant.
- Main transcript trust semantics can surface transient versus durable output correctly.

### Implementation status

- `src/lib/streams/client.ts` preserves envelope metadata and now derives stable tool IDs from payload `id`, then `meta.blockId`, then envelope identity.
- Main hooks and live consumers now dedupe on stable identity in `src/app/hooks/use-session.ts`, `src/app/hooks/use-agent-stream.ts`, `src/app/hooks/use-container-agent.ts`, `src/app/hooks/use-container-agent-statuses.ts`, `src/app/hooks/use-topology-stream.ts`, `src/app/components/features/live-task-view/audit-trail-panel.tsx`, and `src/app/components/features/task-detail-dialog/use-task-activity.ts`.
- `src/app/components/features/agent-session-view/use-stream-parser.ts` already prefers stable event identity, and `src/app/components/features/agent-session-view/stream-line.tsx` now surfaces transient-versus-durable trust labels.
- Broader `blockId`/`sequence`-aware grouping remains incomplete.

## `OC-005d` Explicit Migration Gate

### Ready

- `OC-005b` and `OC-005c` are functionally in place.
- The team has decided whether old/new coexistence is supported or blocked.

### Done

- Protocol migration behavior is explicit.
- Compatibility, if any, exists in one deliberate boundary.
- The client does not have scattered per-surface fallback parsers.
- Ambiguous mixed-mode rollout is prevented.

### Implementation status

- This slice is only partially complete.
- The current implementation centralizes most compatibility in shared metadata helpers, `src/lib/streams/client.ts`, and the session catch-up boundary, which avoids broad per-surface protocol logic.
- However, the tranche does not yet enforce one hard migration gate for old/new protocol coexistence, and the UI still tolerates some semantic fallback forms.

## `OC-006a` Preserve Opaque Cursor Values

### Ready

- `OC-005c` is done.
- The current cursor-loss points from `docs/research/opencode/17-cursor-flow-inventory.md` are understood.

### Done

- The real opaque cursor survives through the main client stream path.
- No correctness-critical logic in the changed path depends on numeric coercion.
- The authoritative client-side resume field is obvious.

### Implementation status

- `src/lib/streams/client.ts` now preserves opaque cursor values through raw event mapping.
- `useSessionSubscription()` exposes `getLastCursor()` and `useSession()` exposes `lastCursor` as the authoritative resume state.

## `OC-006b` Remove Reconnect-From-Zero Behavior

### Ready

- `OC-006a` is done.
- The main reconnect path has access to the real cursor.

### Done

- Main reconnect behavior no longer resets to `0`.
- Reconnect after interruption resumes from the expected point.
- The session hook no longer exposes fake compatibility state as if it were authoritative.

### Implementation status

- The main durable-stream reconnect path resumes from the last opaque cursor rather than reconnecting from `0`.
- Client regression coverage exists for clean closure and transient reconnect paths in `tests/lib/streams/client.test.ts`.

## `OC-006c` Catch-Up Compatibility Boundary

### Ready

- `OC-006a` is done.
- Any remaining numeric compatibility need is understood.

### Done

- If translation is required, it exists in one explicit boundary.
- Client hooks and parsing layers do not know about numeric fallback forms.
- Compatibility behavior is documented rather than inferred.

### Implementation status

- `/api/sessions/:id/events` accepts `afterEventId` and rejects mixed `offset` plus `afterEventId` requests.
- `src/services/session/session-stream.service.ts` isolates the explicit resume-anchor path server-side and returns `SESSION_RESUME_POINT_NOT_FOUND` when the anchor is missing.
- Session-history refresh now uses `afterEventId` end-to-end and falls back to a full reload only at that explicit boundary.

## `OC-006d` Duplicate And Gap Regression Coverage

### Ready

- `OC-006b` is done.
- Preferably `OC-006c` is done or nearly done.
- Validation scenarios from `docs/research/opencode/09-validation-matrix.md` are prepared.

### Done

- Automated coverage exists for duplicate and gap regressions.
- Manual reconnect and refresh verification is completed.
- Reconnect after mixed chunk and tool runs is verified.
- The team can say with confidence that replay drift is not silently accepted.

### Implementation status

- Automated regression coverage now exists across raw stream reconnects, mixed chunk/tool replay, session refresh catch-up, task activity, and major live stream consumers.
- Focused validation currently passes across 14 test files / 236 tests in the tranche sweep.
- Manual reconnect/refresh verification is still pending, so this slice is not fully done yet.

## Slice Completion Rule

- A slice is not done just because the code builds.
- A slice is done when its checklist is satisfied and it does not violate the dependency graph in `docs/research/opencode/18-slice-dependency-graph.md`.

## Related Docs

- `docs/research/opencode/09-validation-matrix.md`
- `docs/research/opencode/11-rollout-plan.md`
- `docs/research/opencode/15-implementation-map.md`
- `docs/research/opencode/18-slice-dependency-graph.md`
