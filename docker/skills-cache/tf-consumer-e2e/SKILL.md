---
name: "tf-consumer-e2e"
description: "Non-interactive test harness for end-to-end Terraform consumer workflow testing. Runs full `/tf-consumer-plan` -> `/tf-consumer-implement` cycle with test defaults, bypassing user prompts for automated validation."
source: image
---
# E2E Test Orchestrator — Consumer

---

## PART 1: PLANNING

Follow `/tf-consumer-plan` skill phases with these E2E-specific differences:

---

## PART 2: IMPLEMENTATION

Follow `/tf-consumer-implement` skill phases (reads consumer-design.md) with these E2E-specific differences:

### Implementation Validation Expectations

After implementation completes, verify:

- All checklist items from consumer-design.md Section 5 are marked `[x]`

Display: > E2E consumer test complete. Status: [PASSED|FAILED]. See issue #<number> for details.
