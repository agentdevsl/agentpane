# Kickoff Checklist

Date: March 2026

This checklist is for the first implementation tranche after the latest
reprioritization. It assumes the team starts with:

1. `OC-005` structured stream envelope
2. `OC-006` opaque resume cursors

Use this file as the shortest operational bridge from planning docs to actual
implementation work.

## Tranche Goal

- Make stream identity explicit.
- Make reconnect correctness trustworthy.
- Avoid doing deployment cleanup, UI-state polish, caching, or virtualization before the stream contract is solid.

## Before Opening PRs

- Confirm the active sequence still matches `docs/research/opencode/04-implementation-backlog.md`.
- Use `docs/research/opencode/06-execution-briefs.md` as the issue and PR brief source.
- Use `docs/research/opencode/05-open-questions.md` defaults unless the codebase has materially changed.
- Keep `OC-002` and `OC-003` deferred.

## Kickoff Week Plan

### Day 1: Lock The Stream Contract

- Create the shared schema for `OC-005a`.
- Decide exact field names for `eventId`, `blockId`, `partType`, `durability`, and `schemaVersion`.
- Write down what counts as `transient` versus `durable` output.
- Identify every current emitter and consumer that will need migration.

### Day 2: Migrate The Emitters

- Start `OC-005b`.
- Update chunk, tool, and lifecycle emitters to produce stable event identity.
- Keep migration behavior explicit instead of silent.
- Avoid partial rollout semantics that let old and new protocols look interchangeable.

### Day 3: Migrate The Main Client Path

- Start `OC-005c` and `OC-006a` together where useful.
- Preserve opaque cursor values through the durable streams client.
- Update the main session parsing path to use stable IDs from the new envelope.
- Remove any correctness-critical fallback to synthetic timestamp-plus-index identity.

### Day 4: Fix Reconnect Behavior

- Land `OC-006b`.
- Remove reconnect-from-zero behavior in the main session path.
- Confirm resume behavior does not depend on `parseInt()` coercion.
- Test disconnect and reconnect flows in long sessions.

### Day 5: Lock Migration And Regression Coverage

- Finish `OC-005d` and `OC-006d`.
- Decide whether old/new protocol coexistence is supported or explicitly blocked.
- Add regression coverage for duplicate and missing event cases.
- Write down follow-up tasks for catch-up API compatibility if `OC-006c` is not fully done yet.

## Definition Of Ready For `OC-001` And `OC-004`

Do not move the next tranche forward until these are true:

- The stream envelope schema is the clear source of truth.
- Resume cursors stay opaque end-to-end in the main path.
- Main reconnect behavior no longer resets to `0`.
- The team can explain which output is transient and which is durable.

## Guardrails

- Do not start Dexie hydration yet.
- Do not start transcript virtualization yet.
- Do not mix front-door deployment cleanup into the stream contract PRs.
- Do not add UI health labels that imply stronger correctness than the stream layer currently supports.

## Hand-off To The Next Tranche

Once this checklist is complete, the next active tranche should be:

1. `OC-001` Align production front door topology.
2. `OC-004` Add shared live health states.
3. `OC-008` Improve transcript performance.
4. `OC-007` Add durable local hydration.
