# Cursor Migration Plan

Date: March 2026

This document is the concrete migration plan for `OC-006`.
It explains how to move resume handling from lossy numeric approximations to
opaque cursor correctness.

## Purpose

- Give the team a concrete migration path for opaque resume cursors.
- Make reconnect correctness explicit.
- Reduce the risk of duplicate and missing events during replay.

## Core Rule

- Treat the durable stream cursor as an opaque value end-to-end.
- Do not parse it into a number in any correctness-critical path.

## Current Problem

- The durable streams client tracks opaque offsets.
- Event mapping drops that identity.
- `useSession()` still falls back to reconnect-from-zero behavior.
- Numeric approximations create replay drift risk.

## Target State

- The client subscription layer stores the real cursor.
- Event mapping preserves the cursor or a safe reference to it.
- Reconnect uses the last known opaque cursor, not `0`.
- Catch-up boundaries either accept opaque cursors directly or isolate compatibility translation in one explicit adapter.

## Migration Steps

### Step 1: Preserve cursor identity in the client stream layer

- Goal:
  - Stop dropping the opaque cursor during event mapping.
- Expected result:
  - The client can carry the real cursor value forward without guessing.

### Step 2: Update session-level state to store the real cursor

- Goal:
  - Make session state hold the real resume value rather than only derived counters.
- Expected result:
  - Reconnect has a trustworthy resume reference.

### Step 3: Remove reconnect-from-zero behavior

- Goal:
  - Replace `0` fallback logic in the main session path.
- Expected result:
  - Reconnect resumes from the last real point instead of starting over.

### Step 4: Isolate compatibility translation if needed

- Goal:
  - If an API still expects numeric inputs, isolate translation to one explicit boundary.
- Expected result:
  - Numeric compatibility no longer leaks into the client model.

### Step 5: Validate duplicate and gap handling

- Goal:
  - Prove reconnect and replay do not silently drift.
- Expected result:
  - Duplicate and missing event cases are tested and visible.

## Data Model Recommendation

```ts
interface StreamResumeState {
  lastCursor: string | null
  lastEventId: string | null
  lastBlockId: string | null
}
```

Notes:

- `lastCursor` is the authoritative replay token.
- `lastEventId` is useful for dedupe and debugging, not as a cursor replacement.
- `lastBlockId` can help grouped-output recovery, but it does not replace the cursor.

## Compatibility Boundary Rule

- If numeric compatibility remains necessary during migration, do it in one server or adapter boundary only.
- The React hooks and client parsing layers should not know about numeric fallback forms.
- Remove the compatibility boundary once opaque cursor support is complete.

## Failure Modes To Watch

- Cursor preserved in one layer but dropped in another.
- Reconnect resumes correctly for chunk output but duplicates tool output.
- Refresh replay behaves differently from live reconnect.
- Adapter translation appears to work but truncates cursor precision or ordering semantics.

## Validation Requirements

- Reconnect during a long hot-stream phase.
- Reconnect immediately after tool output.
- Refresh during or after a mixed chunk/tool run.
- Replay with a cursor that cannot be represented meaningfully as a number.

## Tranche Exit Criteria For `OC-006`

- Main reconnect path no longer resets to `0`.
- Opaque cursor values survive end-to-end in the main path.
- Any numeric compatibility translation is isolated and documented.
- Duplicate and gap regressions are not reproducible in validated scenarios.

## Related Docs

- `docs/research/opencode/04-implementation-backlog.md`
- `docs/research/opencode/06-execution-briefs.md`
- `docs/research/opencode/09-validation-matrix.md`
- `docs/research/opencode/10-risk-register.md`
- `docs/research/opencode/11-rollout-plan.md`
