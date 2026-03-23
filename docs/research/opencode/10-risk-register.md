# Risk Register

Date: March 2026

This risk register focuses on the first implementation tranche:

1. `OC-005` structured stream envelope
2. `OC-006` opaque resume cursors

It exists to keep the team honest about what can go wrong while changing the
stream contract and replay path.

## How To Use This File

- Review it before starting the tranche.
- Re-check it before merging major protocol or reconnect changes.
- Update it if implementation reveals a new failure mode that changes rollout risk.

## Risk Summary

| ID | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| `R-001` | Old and new stream protocols coexist ambiguously | Medium | High | Make migration behavior explicit in `OC-005d` |
| `R-002` | Events are marked durable before they are actually persisted | Medium | High | Keep durability semantics strict and test them directly |
| `R-003` | Client still relies on synthetic identity in hidden paths | High | High | Audit all transcript parsing and dedupe paths |
| `R-004` | Resume cursor values are still coerced to numbers somewhere in the stack | High | High | Search and test every replay and reconnect boundary |
| `R-005` | Reconnect appears to work but silently drops or duplicates events | Medium | Very high | Add manual and automated duplicate/gap regression checks |
| `R-006` | Protocol work leaks into deployment cleanup or UI-state polish | Medium | Medium | Keep the tranche scope tight and defer `OC-001` and `OC-004` work |
| `R-007` | Validation is too shallow and only proves happy-path streaming | Medium | High | Require reconnect, refresh, tool-output, and mixed-event validation |

## Detailed Risks

### `R-001` Ambiguous dual-protocol rollout

- Failure mode:
  - Some emitters or consumers use the new envelope while others still assume the old shape, and the system appears to work only in partial cases.
- Why it matters:
  - This creates transcript bugs that are hard to reproduce and harder to trust.
- Mitigation:
  - Decide whether old/new coexistence is supported.
  - If not, fail explicitly instead of silently tolerating mixed behavior.
  - Keep `OC-005d` explicit and visible in rollout planning.

### `R-002` False durability semantics

- Failure mode:
  - Hot chunk output is labeled durable before persistence actually happens.
- Why it matters:
  - Users can still see text disappear after refresh, but the protocol would now falsely claim safety.
- Mitigation:
  - Keep transient versus durable semantics strict.
  - Validate labels against real persistence timing rather than intent.

### `R-003` Hidden synthetic identity remains

- Failure mode:
  - Main paths switch to stable IDs, but hidden or secondary paths still synthesize identity from timestamps or indexes.
- Why it matters:
  - Dedupe bugs and reconciliation glitches survive under a false sense of completion.
- Mitigation:
  - Audit transcript parsing, tool rendering, and any replay mapping code.
  - Treat synthetic identity usage as a migration bug until proven harmless.

### `R-004` Opaque cursors become numeric again later in the path

- Failure mode:
  - The client preserves opaque cursor values at one layer, but a downstream adapter coerces them back to numbers.
- Why it matters:
  - Replay correctness remains brittle even though the headline fix appears complete.
- Mitigation:
  - Search for numeric parsing and offset translation across the full reconnect path.
  - Cover adapters and catch-up boundaries in tests, not just the primary client.

### `R-005` Silent duplicate or gap regressions

- Failure mode:
  - Reconnect after interruption causes transcript duplication or omission without an obvious UI error.
- Why it matters:
  - This is one of the highest-trust failure modes in the product.
- Mitigation:
  - Treat duplicate or missing event regressions as tranche blockers.
  - Test long sessions, reconnect after tool output, and refresh-driven replay.

### `R-006` Scope bleed into adjacent work

- Failure mode:
  - The team starts mixing deployment cleanup, live-health UI polish, caching, or virtualization into the protocol tranche.
- Why it matters:
  - Progress becomes harder to measure and rollback becomes riskier.
- Mitigation:
  - Keep `OC-001`, `OC-004`, `OC-008`, and `OC-007` out of scope until `OC-005` and `OC-006` meet exit criteria.

### `R-007` Validation is too happy-path oriented

- Failure mode:
  - Tests show that a normal run still streams, but they do not prove reconnect correctness under stress.
- Why it matters:
  - The tranche would look done while the hardest failure modes remain untested.
- Mitigation:
  - Use `docs/research/opencode/09-validation-matrix.md` as a release bar, not just a suggestion.
  - Include reconnect, refresh, mixed-event, and tool-output flows in validation.

## Tranche Blockers

The tranche should be considered blocked if any of these are true:

- The team cannot explain exactly how old/new protocol behavior is handled.
- Any correctness-critical path still depends on numeric cursor coercion.
- Duplicate or gap regressions are reproducible in reconnect testing.
- Durable versus transient labeling is not backed by actual persistence behavior.

## Exit Rule

- Do not move to `OC-001` or `OC-004` until the risks above are either mitigated or explicitly accepted with a written rationale.
