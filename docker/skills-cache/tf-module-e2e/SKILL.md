---
name: "tf-module-e2e"
description: "Non-interactive test harness for end-to-end Terraform workflow testing. Runs full `/tf-module-plan` -> `/tf-module-implement` cycle with test defaults, bypassing user prompts for automated validation. Pass the prompt filename as the skill argument."
source: image
---
# E2E Test Orchestrator — Module

---

## PART 1: PLANNING

Follow `/tf-module-plan` skill phases with these E2E-specific differences:

---

## PART 2: IMPLEMENTATION

Follow `/tf-module-implement` skill phases (reads module-design.md) with these E2E-specific differences:

### Implementation Validation Expectations

After implementation completes, verify:

- All checklist items from module-design.md Section 5 are marked `[x]`

Display: > E2E module test complete. Status: [PASSED|FAILED]. See issue #<number> for details.
