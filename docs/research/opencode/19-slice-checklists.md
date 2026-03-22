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

## `OC-005d` Explicit Migration Gate

### Ready

- `OC-005b` and `OC-005c` are functionally in place.
- The team has decided whether old/new coexistence is supported or blocked.

### Done

- Protocol migration behavior is explicit.
- Compatibility, if any, exists in one deliberate boundary.
- The client does not have scattered per-surface fallback parsers.
- Ambiguous mixed-mode rollout is prevented.

## `OC-006a` Preserve Opaque Cursor Values

### Ready

- `OC-005c` is done.
- The current cursor-loss points from `docs/research/opencode/17-cursor-flow-inventory.md` are understood.

### Done

- The real opaque cursor survives through the main client stream path.
- No correctness-critical logic in the changed path depends on numeric coercion.
- The authoritative client-side resume field is obvious.

## `OC-006b` Remove Reconnect-From-Zero Behavior

### Ready

- `OC-006a` is done.
- The main reconnect path has access to the real cursor.

### Done

- Main reconnect behavior no longer resets to `0`.
- Reconnect after interruption resumes from the expected point.
- The session hook no longer exposes fake compatibility state as if it were authoritative.

## `OC-006c` Catch-Up Compatibility Boundary

### Ready

- `OC-006a` is done.
- Any remaining numeric compatibility need is understood.

### Done

- If translation is required, it exists in one explicit boundary.
- Client hooks and parsing layers do not know about numeric fallback forms.
- Compatibility behavior is documented rather than inferred.

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

## Slice Completion Rule

- A slice is not done just because the code builds.
- A slice is done when its checklist is satisfied and it does not violate the dependency graph in `docs/research/opencode/18-slice-dependency-graph.md`.

## Related Docs

- `docs/research/opencode/09-validation-matrix.md`
- `docs/research/opencode/11-rollout-plan.md`
- `docs/research/opencode/15-implementation-map.md`
- `docs/research/opencode/18-slice-dependency-graph.md`
