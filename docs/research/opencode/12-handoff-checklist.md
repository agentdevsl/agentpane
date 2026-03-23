# Handoff Checklist

Date: March 2026

This checklist is for handing the first implementation tranche to the team.
It is intentionally short and meeting-friendly.

The tranche is:

1. `OC-005` structured stream envelope
2. `OC-006` opaque resume cursors

## Meeting Goal

- Make sure everyone starts with the same scope, risks, rollout expectations, and definition of done.

## Bring To The Handoff

- `docs/research/opencode/04-implementation-backlog.md`
- `docs/research/opencode/06-execution-briefs.md`
- `docs/research/opencode/08-kickoff-checklist.md`
- `docs/research/opencode/09-validation-matrix.md`
- `docs/research/opencode/10-risk-register.md`
- `docs/research/opencode/11-rollout-plan.md`

## Confirm In The Meeting

- The team agrees `OC-005` and `OC-006` are the first tranche.
- `OC-001`, `OC-004`, `OC-008`, and `OC-007` stay out of scope for this tranche.
- The team agrees whether old/new protocol coexistence is supported or explicitly blocked during rollout.
- Everyone uses the same definition of `transient` versus `durable` output.
- Everyone agrees duplicate or missing events are tranche blockers.

## Ownership Checklist

- Assign one owner for the shared stream schema.
- Assign one owner for server emitter migration.
- Assign one owner for client parsing and transcript identity migration.
- Assign one owner for reconnect and cursor propagation.
- Assign one owner for validation and regression signoff.

## Delivery Checklist

- First PR is `OC-005a`.
- Second PR covers the first reconnect correctness slice.
- Validation is planned before rollout, not after merge.
- Rollback criteria are written down before the main migration PRs land.

## Questions That Must Be Answered Before Coding Starts

- What is the exact envelope shape?
- Which current events become `transient` and which become `durable`?
- Where is the compatibility boundary if any old protocol path remains?
- What is the first place where opaque cursor values must stop being treated numerically?

## Exit From Handoff

- The team can explain the tranche in one sentence.
- The first two PRs are obvious.
- The validation owner knows what must pass before moving to `OC-001` and `OC-004`.
