# Phase Plan

Date: March 2026

This document groups the active OpenCode backlog into milestone-style phases.
Use it to answer a simple planning question: what should ship together, and what
must wait for earlier foundations?

This phase plan is derived from:

- `docs/research/opencode/03-roadmap.md`
- `docs/research/opencode/04-implementation-backlog.md`
- `docs/research/opencode/06-execution-briefs.md`

## Active Queue

The active queue remains:

1. `OC-005`
2. `OC-006`
3. `OC-001`
4. `OC-004`
5. `OC-008`
6. `OC-007`

Deferred:

- `OC-002`
- `OC-003`

## Phase 1: Make Stream Identity And Resume Correct

- Includes:
  - `OC-005` Introduce a structured stream envelope
  - `OC-006` Preserve opaque resume cursors end-to-end
- Why this phase exists:
  - Stable event identity and correct replay are the foundation for every later transcript improvement.
- Expected outcome:
  - Stream events have stable IDs and explicit durability semantics.
  - Reconnect no longer depends on reconnect-from-zero or lossy numeric offsets.
- Good stopping point:
  - Transcript correctness and replay trust improve even if deployment cleanup and UI-state polish are still pending.

## Phase 2: Make Production And Live-State Semantics Honest

- Includes:
  - `OC-001` Align deployed front door with documented Caddy topology
  - `OC-004` Add a shared live health state model
- Why this phase exists:
  - Once stream semantics are clearer, deployment truth and visible health-state semantics become easier to align honestly.
- Expected outcome:
  - Docs and deployment describe the same front door.
  - Users can distinguish healthy live output from degraded or failed states.
- Good stopping point:
  - The product becomes more honest operationally and visually after the stream contract is clarified.

## Phase 3: Make Long Sessions Feel Fast Again

- Includes:
  - `OC-008` Replace full transcript rebuilds with append-only timelines and virtualization
- Why this phase exists:
  - Once stream identity is stable, performance improvements become much safer to implement.
- Expected outcome:
  - Transcript append cost drops.
  - Long sessions keep follow-output and scrollback behavior without degrading as badly.
- Good stopping point:
  - Live transcripts feel fast enough that “live” still feels believable in long sessions.

## Phase 4: Make Refresh And Recovery Feel Durable

- Includes:
  - `OC-007` Add Dexie-backed durable session hydration
- Why this phase exists:
  - Local hydration becomes much safer after protocol, replay, and transcript identity are settled.
- Expected outcome:
  - Reload restores useful durable transcript state quickly.
  - Refresh no longer feels like a punishment for long-running sessions.
- Good stopping point:
  - Users can recover from refresh or reconnect events with far less trust loss.

## Suggested Milestone Names

- Phase 1: `Trustworthy Replay`
- Phase 2: `Honest Runtime`
- Phase 3: `Responsive Transcript`
- Phase 4: `Durable Reload`

## What Should Not Move Earlier

- `OC-007` should not move ahead of `OC-005` and `OC-006`.
- `OC-008` virtualization work should not move ahead of stable event identity.
- `OC-005` and `OC-006` should not be split across too many parallel protocol experiments.

## What Can Run In Parallel

- Within Phase 1, schema-definition work can begin before all reconnect adapters are migrated.
- Within Phase 2, parts of `OC-001` and design work for `OC-004` can overlap.
- Within Phase 3, audit-trail virtualization can follow the main session transcript rather than blocking it.

## Milestone Exit Criteria

### Exit Phase 1

- Stable stream identity is live.
- Resume cursors are preserved end-to-end.
- Duplicate and missing event regressions are covered by tests.

### Exit Phase 2

- Production docs and deployment topology agree.
- Main live surfaces no longer imply healthy state when startup or stream status is degraded.

### Exit Phase 3

- Long transcript append behavior is measurably cheaper.
- Virtualized transcript panes still support usable live-follow and scrollback behavior.

### Exit Phase 4

- Refresh restores durable transcript state quickly from local cache.
- Cache merge behavior is correct under normal replay and reconnect scenarios.

## Planning Rule

- If implementation planning ever feels conflicted between backlog order and speed, prefer the dependency order in this file over numerical ticket order.
