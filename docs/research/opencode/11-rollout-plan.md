# Rollout Plan

Date: March 2026

This rollout plan covers the first implementation tranche:

1. `OC-005` structured stream envelope
2. `OC-006` opaque resume cursors

The goal is to make protocol and reconnect changes safer to ship by defining how
they should roll forward, what should gate rollout, and how to back out if the
behavior is worse than expected.

## Rollout Principles

- Prefer explicit migration over silent mixed-protocol tolerance.
- Ship correctness before polish.
- Roll out in narrow slices with observable checkpoints.
- Treat replay regressions as more serious than minor UI regressions.

## Recommended Rollout Order

### Step 1: Land the shared stream contract

- Scope:
  - `OC-005a`
- Goal:
  - Establish a single source of truth for the new envelope.
- Rollout check:
  - The schema is stable enough that both emitters and consumers can target it.
- Rollback rule:
  - If field definitions are still ambiguous, do not start emitter or client migration yet.

### Step 2: Migrate emitters to stable identity

- Scope:
  - `OC-005b`
- Goal:
  - Make server-side emitted events conform to the new schema.
- Rollout check:
  - Chunk, tool, and lifecycle events all emit stable IDs and explicit durability semantics.
- Rollback rule:
  - If any major event class still emits incompatible payloads, keep rollout incomplete and avoid mixed implied support.

### Step 3: Migrate main client parsing and identity handling

- Scope:
  - `OC-005c`
- Goal:
  - Make the main session client path rely on stable IDs from the new envelope.
- Rollout check:
  - Transcript rendering no longer depends on synthetic timestamp-plus-index identity in the main path.
- Rollback rule:
  - If stable IDs do not survive parsing cleanly, revert the parsing change rather than layering more fallback logic onto it.

### Step 4: Lock protocol migration behavior

- Scope:
  - `OC-005d`
- Goal:
  - Decide whether old and new protocols coexist or whether mixed behavior is blocked.
- Rollout check:
  - The migration rule is explicit and documented.
- Rollback rule:
  - If the rollout path is unclear, do not expand deployment; block the mixed mode rather than guessing.

### Step 5: Preserve opaque resume cursors in the client path

- Scope:
  - `OC-006a`
- Goal:
  - Keep durable cursor values opaque through the client subscription layer.
- Rollout check:
  - No correctness-critical logic in the changed path coerces cursor values to numbers.
- Rollback rule:
  - If downstream paths still depend on numeric forms, stop and isolate the compatibility boundary rather than leaking numeric assumptions further.

### Step 6: Remove reconnect-from-zero behavior

- Scope:
  - `OC-006b`
- Goal:
  - Make the main reconnect path resume from a real cursor.
- Rollout check:
  - Normal reconnect after interruption continues from the expected point without transcript loss or duplication.
- Rollback rule:
  - If reconnect reliability drops, revert to the last known-correct reconnect path and fix cursor propagation before retrying.

### Step 7: Update catch-up compatibility and lock regressions

- Scope:
  - `OC-006c` and `OC-006d`
- Goal:
  - Finish replay compatibility and prove duplicate/gap regressions are covered.
- Rollout check:
  - Automated and manual validation both pass for reconnect and refresh-driven replay.
- Rollback rule:
  - If duplicate or missing events remain reproducible, do not move to the next tranche.

## Rollout Gates

Do not advance to the next step unless the previous one is true:

- The new stream schema is concrete and shared.
- Stable event identity survives emission and parsing.
- Durable versus transient semantics are internally consistent.
- Opaque cursor values survive through the main reconnect path.
- Duplicate and gap cases are tested explicitly.

## Rollback Triggers

Rollback or pause the tranche if any of these happen:

- Mixed old/new protocol behavior is ambiguous in production-like testing.
- Hot events are marked durable before persistence.
- Reconnect duplicates or drops transcript events.
- Cursor handling falls back to numeric coercion in correctness-critical paths.
- The team starts adding unrelated deployment, UI-health, cache, or virtualization work just to compensate for protocol uncertainty.

## Safe Rollback Strategy

- Roll back the most recent slice, not the entire tranche, unless the schema itself is wrong.
- Prefer removing unstable client parsing changes before backing out the shared schema definition.
- Prefer blocking mixed protocol paths explicitly instead of leaving degraded compatibility in place.
- Keep validation artifacts updated after rollback so the next attempt starts from the real failure, not the planned path.

## Before Moving To `OC-001` And `OC-004`

These must be true first:

- The stream envelope contract is stable and documented.
- The main reconnect path uses real opaque cursors.
- Duplicate and gap regressions are not reproducible in the validated scenarios.
- The team can state the rollout compatibility rule in one sentence.

## Related Docs

- `docs/research/opencode/04-implementation-backlog.md`
- `docs/research/opencode/06-execution-briefs.md`
- `docs/research/opencode/08-kickoff-checklist.md`
- `docs/research/opencode/09-validation-matrix.md`
- `docs/research/opencode/10-risk-register.md`
