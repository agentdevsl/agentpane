# Slice Dependency Graph

Date: March 2026

This document makes the dependency structure for the first implementation
tranche explicit.

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

- Show which slices truly block others.
- Clarify what can run in parallel.
- Reduce the chance that the team starts a later slice before its foundations are stable.

## Top-Level Dependency Chain

```text
OC-005a
  -> OC-005b
  -> OC-005c
  -> OC-005d
  -> OC-006a
  -> OC-006b
  -> OC-006c
  -> OC-006d
```

This is the safest default order.

## Detailed Dependencies

### `OC-005a` Shared stream schema

- Blocks:
  - `OC-005b`
  - `OC-005c`
  - `OC-005d`
- Why:
  - emitter and parser migration should not proceed until the envelope and field semantics are settled.

### `OC-005b` Server emitter migration

- Depends on:
  - `OC-005a`
- Partially blocks:
  - `OC-005c`
  - `OC-005d`
- Why:
  - client parsing can begin in parallel with known mock shapes, but it should not merge until real emitters produce the contract.

### `OC-005c` Client parser and identity migration

- Depends on:
  - `OC-005a`
- Prefer after or alongside:
  - `OC-005b`
- Blocks:
  - `OC-006a`
  - `OC-008`
- Why:
  - resume correctness and later transcript work both benefit from the client actually using stable event identity.

### `OC-005d` Explicit migration gate

- Depends on:
  - `OC-005a`
  - `OC-005b`
  - `OC-005c`
- Blocks:
  - broader rollout of `OC-006`
- Why:
  - reconnect fixes should not expand while protocol compatibility remains ambiguous.

### `OC-006a` Preserve opaque cursor values in the client path

- Depends on:
  - `OC-005c`
- Prefer after:
  - `OC-005d`
- Blocks:
  - `OC-006b`
  - `OC-006c`
- Why:
  - reconnect logic should not change until the client can carry the real cursor value through the relevant path.

### `OC-006b` Remove reconnect-from-zero behavior

- Depends on:
  - `OC-006a`
- Blocks:
  - `OC-006d`
- Why:
  - regression coverage needs the real reconnect behavior in place.

### `OC-006c` Catch-up compatibility boundary

- Depends on:
  - `OC-006a`
- Prefer after:
  - `OC-006b`
- Can overlap with:
  - `OC-006d` test preparation
- Why:
  - compatibility translation is easier to isolate once the main path already uses opaque cursors.

### `OC-006d` Duplicate and gap regression coverage

- Depends on:
  - `OC-006b`
- Prefer after:
  - `OC-006c`
- Why:
  - testing before the final reconnect and compatibility behavior stabilizes can produce noisy or misleading failures.

## What Can Run In Parallel

- `OC-005b` and early `OC-005c` exploration can overlap after `OC-005a` lands.
- `OC-006c` design work can start while `OC-006b` is being implemented, but merge should wait until reconnect behavior is stable.
- Validation preparation for `OC-006d` can start before `OC-006c` finishes, as long as final signoff waits for the full reconnect path.

## What Should Not Run In Parallel

- Do not run `OC-005d` as an afterthought after rollout starts.
- Do not run `OC-006b` before `OC-006a` preserves the real cursor.
- Do not begin `OC-008` transcript identity or virtualization work before `OC-005c` lands.
- Do not begin `OC-007` local hydration before both `OC-005` and `OC-006` exit criteria are satisfied.

## Dependency Rule For The Next Tranche

Only after this graph is effectively complete should the team move to:

- `OC-001`
- `OC-004`
- `OC-008`
- `OC-007`

## Related Docs

- `docs/research/opencode/04-implementation-backlog.md`
- `docs/research/opencode/11-rollout-plan.md`
- `docs/research/opencode/15-implementation-map.md`
- `docs/research/opencode/16-event-inventory.md`
- `docs/research/opencode/17-cursor-flow-inventory.md`
