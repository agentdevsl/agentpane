# tf-consumer-implement Flow Diagram

Mapping of the `tf-consumer-implement` orchestrator skill and its interaction with the `tf-consumer-developer` and `tf-consumer-validator` agents.

## Full Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     tf-consumer-implement (Orchestrator Skill)       │
│                        Phases 3 + 4                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  PREREQUISITES                                                      │
│  ┌───────────────────────────────────────────────────────┐          │
│  │ 1. Resolve $FEATURE from $ARGUMENTS or branch name    │          │
│  │ 2. Run validate-env.sh --json (gate_passed=false?)    │──No──▶ STOP
│  │ 3. Glob: specs/{FEATURE}/consumer-design.md exists?   │──No──▶ STOP
│  │    (Tell user to run /tf-consumer-plan first)          │          │
│  │ 4. Find $ISSUE_NUMBER from $ARGUMENTS or gh issue list│          │
│  └────────────────────────┬──────────────────────────────┘          │
│                           │ Yes                                     │
│                           ▼                                         │
│  PHASE 3: BUILD                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                                                              │   │
│  │  Step 5: Grep consumer-design.md Section 5 → extract         │   │
│  │          checklist items [A, B, C, D, ...]                   │   │
│  │                         │                                    │   │
│  │                         ▼                                    │   │
│  │  Step 6: FOR EACH checklist item (sequentially):             │   │
│  │  ┌──────────────────────────────────────────────────────┐    │   │
│  │  │  ┌──────────────────────────────────────────────┐    │    │   │
│  │  │  │       tf-consumer-developer (Agent)          │    │    │   │
│  │  │  │                                              │    │    │   │
│  │  │  │  INPUT:  FEATURE path + checklist item desc  │    │    │   │
│  │  │  │                                              │    │    │   │
│  │  │  │  1. Read consumer-design.md                  │    │    │   │
│  │  │  │  2. Read existing .tf files                  │    │    │   │
│  │  │  │  3. Compose module calls + wiring            │    │    │   │
│  │  │  │  4. Write/edit .tf files                     │    │    │   │
│  │  │  │                                              │    │    │   │
│  │  │  │  OUTPUT: Modified .tf files                  │    │    │   │
│  │  │  └──────────────────────────────────────────────┘    │    │   │
│  │  │                         │                            │    │   │
│  │  │                         ▼                            │    │   │
│  │  │  Orchestrator: Glob verify expected files exist      │    │   │
│  │  │  Orchestrator: terraform fmt -check                  │    │   │
│  │  │  Orchestrator: terraform validate                    │    │   │
│  │  │                (may require terraform init first)    │    │   │
│  │  │  Checkpoint commit                                   │    │   │
│  │  └──────────────────────────────────────────────────────┘    │   │
│  │          (repeat for each item; concurrent if independent)   │   │
│  │                         │                                    │   │
│  │                         ▼                                    │   │
│  │  Step 7: terraform validate (final)                          │   │
│  │          Failures? ──Yes──▶ Re-launch tf-consumer-developer  │   │
│  │                             targeted at specific errors      │   │
│  │          │                                                   │   │
│  │          ▼ No                                                │   │
│  │  Step 8: Grep: all checklist items [x] in Section 5?        │   │
│  │          Missing? → Mark (if work done) or flag gap          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                         │                                           │
│                         ▼                                           │
│  PHASE 4: VALIDATE                                                  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Step 9: Launch tf-consumer-validator agent                  │   │
│  │  ┌────────────────────────────────────────────────────────┐  │   │
│  │  │           tf-consumer-validator (Agent)                │  │   │
│  │  │                                                        │  │   │
│  │  │  1. Design conformance check                           │  │   │
│  │  │     (modules, wiring, variables vs design)             │  │   │
│  │  │  2. Static analysis:                                   │  │   │
│  │  │       terraform fmt                                    │  │   │
│  │  │       terraform validate                               │  │   │
│  │  │       tflint                                           │  │   │
│  │  │       trivy                                            │  │   │
│  │  │  3. Quality scoring via tf-judge-criteria              │  │   │
│  │  │                                                        │  │   │
│  │  │  Security enforced by Sentinel policies at workspace   │  │   │
│  │  │  level + modules inherently secure — validator does    │  │   │
│  │  │  NOT perform separate security review.                 │  │   │
│  │  │                                                        │  │   │
│  │  │  OUTPUT: Validation results + quality score            │  │   │
│  │  └────────────────────────────────────────────────────────┘  │   │
│  │                                                              │   │
│  │  Step 10: Quality score < 7.0?                               │   │
│  │           ──Yes──▶ Launch tf-consumer-developer              │   │
│  │                    targeted at specific issues               │   │
│  │                    Re-run tf-consumer-validator after fixes   │   │
│  │           │                                                  │   │
│  │           ▼ Score >= 7.0                                     │   │
│  │  Step 11: Deploy to sandbox                                  │   │
│  │           Trigger plan+apply in HCP Terraform sandbox        │   │
│  │           workspace. Capture run URL + deploy status.        │   │
│  │                         │                                    │   │
│  │                         ▼                                    │   │
│  │  Step 12: Orchestrator writes deployment report directly     │   │
│  │           (reads tf-report-template, applies consumer        │   │
│  │            format — NOT a subagent dispatch)                  │   │
│  │           Writes to specs/{FEATURE}/reports/                 │   │
│  │           Includes: static analysis, quality score,          │   │
│  │                     sandbox deployment results               │   │
│  │                         │                                    │   │
│  │                         ▼                                    │   │
│  │  Step 13: Checkpoint commit → push branch → create PR        │   │
│  │           linking to $ISSUE_NUMBER                           │   │
│  │                         │                                    │   │
│  │                         ▼                                    │   │
│  │  Step 14: AskUserQuestion: "Destroy sandbox resources?"      │   │
│  │           ┌──────────────────────────────────────────────┐   │   │
│  │           │  Yes, destroy ──▶ Trigger destroy run in     │   │   │
│  │           │                   sandbox workspace.         │   │   │
│  │           │                   Report status.             │   │   │
│  │           │                                              │   │   │
│  │           │  No, keep   ──▶ Leave sandbox resources      │   │   │
│  │           │                  running.                    │   │   │
│  │           └──────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                         │                                           │
│                         ▼                                           │
│  DONE: Report validation status, quality score,                     │
│        sandbox deploy status (if run), PR link                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Flow Summary

```
consumer-design.md ─────────────────────────────────────────────┐
  (Section 5 checklist)                                          │
                         ▼                                       │
               ┌──────────────────────┐                          │
               │ tf-consumer-developer│                          │
               │ (per checklist item) │                          │
               └──────────┬───────────┘                          │
                          │                                      │
                          ▼                                      │
                main.tf, variables.tf, outputs.tf                │
                (module calls, wiring, provider config)          │
                          │                                      │
                          ▼                                      │
               tf-consumer-implement orchestrator                │
               (fmt -check, validate, commits)                   │
                          │                                      │
                          ▼                                      │
               ┌──────────────────────┐     consumer-design.md ──┘
               │ tf-consumer-validator│     (design conformance)
               │                      │
               │ design conformance,  │
               │ fmt, validate,       │
               │ tflint, trivy,       │
               │ tf-judge-criteria    │
               │ quality scoring      │
               └──────────┬───────────┘
                          │
                          ▼
               tf-consumer-implement orchestrator
               (writes deployment report directly,
                deploys to HCP Terraform sandbox)
                          │
                          ▼
               specs/{FEATURE}/reports/
```

## Analysis: Key Differences from Module Flow

The consumer-implement flow diverges from `tf-module-implement` in several significant ways, all stemming from the fact that consumer configurations compose existing modules rather than authoring new resources.

### 1. No TDD Cycle

There is no `tf-consumer-test-writer` agent. Consumer configurations do not produce `*.tftest.hcl` files and the orchestrator never runs `terraform test`. Modules consumed by the configuration are assumed to have their own test suites. The validation strategy relies entirely on static analysis and design conformance rather than runtime testing.

### 2. Sentinel Policy Enforcement Instead of Tests

Security and compliance are enforced by Sentinel policies attached at the HCP Terraform workspace level, not by test assertions in the consumer code. The `tf-consumer-validator` does not perform a separate security review — it trusts that consumed modules are inherently secure and that Sentinel policies catch policy violations during plan+apply.

### 3. Orchestrator-Controlled Sandbox Destroy

After PR creation (step 13), the orchestrator prompts the user via `AskUserQuestion` to decide whether to destroy sandbox resources. This is a post-PR interactive step — the module flow has no equivalent. The orchestrator handles the destroy run directly, giving the user control over resource lifecycle.

### 4. Checklist Extraction from Section 5

The consumer-design.md checklist lives in Section 5 (not Section 6 as in the module design.md). This reflects the different document structure of the consumer design template.

### 5. Report Written Directly by Orchestrator

The deployment report at step 12 is written by the orchestrator itself, not delegated to a subagent. The orchestrator reads the `tf-report-template` skill inline and applies the consumer template format. This contrasts with the module flow where the `tf-module-validator` agent writes the report as part of its pipeline.
