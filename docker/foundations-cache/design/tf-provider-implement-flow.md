# tf-provider-implement Flow Diagram

Mapping of the `tf-provider-implement` orchestrator skill and its interaction with the `tf-provider-test-writer`, `tf-provider-developer`, and `tf-provider-validator` agents.

## Full Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  tf-provider-implement (Orchestrator Skill)             │
│                        Phases 3 + 4                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  PREREQUISITES                                                          │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │ 1. Resolve $FEATURE + $RESOURCE from $ARGUMENTS               │     │
│  │    or current git branch name                                  │     │
│  │                    │                                           │     │
│  │                    ▼                                           │     │
│  │ 2. Glob: specs/{FEATURE}/provider-design-{resource}.md        │     │
│  │    exists?                                                     │     │
│  │    No ──▶ STOP (tell user to run /tf-provider-plan first)     │     │
│  │                    │ Yes                                       │     │
│  │                    ▼                                           │     │
│  │    Capture $DESIGN_FILE                                        │     │
│  │                    │                                           │     │
│  │                    ▼                                           │     │
│  │ 3. Find $ISSUE_NUMBER from $ARGUMENTS                         │     │
│  │    or gh issue list --search "$FEATURE"                        │     │
│  └────────────────────┬───────────────────────────────────────────┘     │
│                       │                                                 │
│                       ▼                                                 │
│  PHASE 3: BUILD + TEST                                                  │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                                                                    │ │
│  │  Step 4: Launch concurrent tf-provider-test-writer agents         │ │
│  │  ┌──────────────────────────────────────────────────────────────┐ │ │
│  │  │           tf-provider-test-writer (Agent)                    │ │ │
│  │  │                                                              │ │ │
│  │  │  INPUT:  $DESIGN_FILE (provider-design-{resource}.md)       │ │ │
│  │  │                                                              │ │ │
│  │  │  1. Read provider design document                            │ │ │
│  │  │  2. Generate acceptance test scaffolding                     │ │ │
│  │  │  3. Write _test.go files (resource + data source tests)     │ │ │
│  │  │                                                              │ │ │
│  │  │  OUTPUT: _test.go files                                      │ │ │
│  │  └──────────────────────────────────────────────────────────────┘ │ │
│  │                       │                                            │ │
│  │                       ▼                                            │ │
│  │  Verify _test.go exists. Checkpoint commit.                        │ │
│  │                       │                                            │ │
│  │                       ▼                                            │ │
│  │  Step 5: Grep design §6 → extract checklist items                  │ │
│  │          (all `- [ ]` lines)                                       │ │
│  │          [A, B, C, D, ...]                                         │ │
│  │                       │                                            │ │
│  │                       ▼                                            │ │
│  │  Step 6: FOR EACH checklist item:                                  │ │
│  │  ┌──────────────────────────────────────────────────────────────┐ │ │
│  │  │  ┌────────────────────────────────────────────────────────┐  │ │ │
│  │  │  │       tf-provider-developer (Agent)                    │  │ │ │
│  │  │  │                                                        │  │ │ │
│  │  │  │  INPUT:  $DESIGN_FILE + checklist item description     │  │ │ │
│  │  │  │                                                        │  │ │ │
│  │  │  │  1. Read provider design document                      │  │ │ │
│  │  │  │  2. Read existing .go files                            │  │ │ │
│  │  │  │  3. Research via MCP (provider/AWS docs)               │  │ │ │
│  │  │  │  4. Write/edit .go files (Plugin Framework)            │  │ │ │
│  │  │  │  5. go build                                           │  │ │ │
│  │  │  │  6. go test -c (compile tests)                         │  │ │ │
│  │  │  │  7. Mark [x] in design §6                              │  │ │ │
│  │  │  │                                                        │  │ │ │
│  │  │  │  OUTPUT: Modified .go files + report                   │  │ │ │
│  │  │  └────────────────────────────────────────────────────────┘  │ │ │
│  │  │                       │                                      │ │ │
│  │  │                       ▼                                      │ │ │
│  │  │  Orchestrator: go build + go test -c                         │ │ │
│  │  │  Checkpoint commit                                           │ │ │
│  │  └──────────────────────────────────────────────────────────────┘ │ │
│  │              (repeat for each item; concurrent if independent)    │ │
│  │                       │                                            │ │
│  │                       ▼                                            │ │
│  │  Step 7: go vet ./...                                              │ │
│  │          Failures? ──Yes──▶ Fix until clean                        │ │
│  │                       │ No                                         │ │
│  │                       ▼                                            │ │
│  │          Verify all §6 items marked [x]                            │ │
│  │          Missing? → Flag                                           │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                       │                                                 │
│                       ▼                                                 │
│  PHASE 4: VALIDATE                                                      │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                                                                    │ │
│  │  Step 8: Launch concurrent tf-provider-validator agents            │ │
│  │  ┌──────────────────────────────────────────────────────────────┐ │ │
│  │  │           tf-provider-validator (Agent)                      │ │ │
│  │  │                                                              │ │ │
│  │  │  INPUT:  $DESIGN_FILE + service directory                   │ │ │
│  │  │                                                              │ │ │
│  │  │  CHECKS:                                                     │ │ │
│  │  │  1. Design conformance (code matches design spec)           │ │ │
│  │  │  2. Build / static analysis (go build, go vet)              │ │ │
│  │  │  3. Test compilation (go test -c)                            │ │ │
│  │  │  4. Code review (patterns, naming, Plugin Framework)        │ │ │
│  │  │  5. Auto-fix minor issues where possible                    │ │ │
│  │  │                                                              │ │ │
│  │  │  OUTPUT: Validation findings + auto-fixes applied            │ │ │
│  │  └──────────────────────────────────────────────────────────────┘ │ │
│  │                       │                                            │ │
│  │                       ▼                                            │ │
│  │  If auto-fixes applied → go build to confirm                       │ │
│  │                       │                                            │ │
│  │                       ▼                                            │ │
│  │  Step 9: Remaining issues?                                         │ │
│  │          Yes ──▶ Launch tf-provider-developer targeted at          │ │
│  │          │       specific issues. Repeat until resolved.           │ │
│  │          │       ┌────────────────────────────────────────────┐    │ │
│  │          │       │  tf-provider-developer (Agent)             │    │ │
│  │          │       │  INPUT: specific issue description         │    │ │
│  │          │       │  Fix → go build → go test -c               │    │ │
│  │          │       └────────────────────────────────────────────┘    │ │
│  │          │                    │                                     │ │
│  │          └────────────────────┘ (loop until clean)                 │ │
│  │                       │ No remaining issues                        │ │
│  │                       ▼                                            │ │
│  │  Step 10: Run acceptance tests                                     │ │
│  │                       │                                            │ │
│  │                       ▼                                            │ │
│  │  Step 11: Write validation report to specs/{FEATURE}/reports/      │ │
│  │           using tf-report-template skill (provider template)       │ │
│  │                       │                                            │ │
│  │                       ▼                                            │ │
│  │  Step 12: Checkpoint commit → push branch → create PR              │ │
│  │           linking to $ISSUE_NUMBER                                 │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                       │                                                 │
│                       ▼                                                 │
│  DONE: Report build pass/fail, test compilation, acceptance test        │
│        results (if run), validation status, PR link                     │
└─────────────────────────────────────────────────────────────────────────┘
```

## Data Flow Summary

```
provider-design-{resource}.md ──┬──────────────────────────────────────┐
  (design document)              │              (design §6 checklist)    │
                                 ▼                                      ▼
               ┌─────────────────────────┐       ┌──────────────────────────┐
               │ tf-provider-test-writer  │       │  tf-provider-developer   │
               │                         │       │  (per checklist item)    │
               └───────────┬─────────────┘       └────────────┬─────────────┘
                           │                                  │
                           ▼                                  ▼
                   _test.go files                    .go resource/data files
                   (acceptance tests)                (Plugin Framework code)
                           │                                  │
                           └──────────┬───────────────────────┘
                                      ▼
                       tf-provider-implement orchestrator
                       (go build, go vet, go test -c)
                                      │
                                      ▼
                       ┌──────────────────────────┐
                       │  tf-provider-validator    │
                       │  (design conformance,     │
                       │   static analysis,        │
                       │   code review, auto-fix)  │
                       └────────────┬──────────────┘
                                    │
                                    ▼
                       validation report + PR
```

## Analysis: Does the Flow Make Sense?

**Yes, the flow is sound.** It correctly implements a TDD-driven provider development cycle with a dedicated validation phase.

### What's Right

1. **Test-first ordering**: `tf-provider-test-writer` runs at step 4 before any `tf-provider-developer` work begins. Test files exist before implementation code, establishing the RED baseline for the Go test compilation check (`go test -c`).

2. **Single artifact source**: Everything flows from `provider-design-{resource}.md`. No intermediate design files are created between agents. The orchestrator passes the same `$DESIGN_FILE` reference to all three agent types.

3. **Agent single-responsibility**: `tf-provider-test-writer` produces `_test.go` files. `tf-provider-developer` produces `.go` implementation files. `tf-provider-validator` checks conformance and applies auto-fixes. Each agent has one clear job.

4. **Orchestrator directs, doesn't accumulate**: `tf-provider-implement` checks file existence via Glob, passes file paths and checklist items to agents, and runs build/vet commands. It verifies state rather than reading agent outputs directly.

5. **Validator as independent gate (step 8)**: The validator agents receive both `$DESIGN_FILE` and the service directory, enabling them to check implementation against spec without relying on developer self-assessment. This is a trust-but-verify pattern.

6. **Fix cycle separation (step 9)**: When the validator finds issues, targeted `tf-provider-developer` agents are launched with specific issue descriptions rather than re-running the full checklist. This is efficient and focused.

### Things to Watch

1. **Acceptance test timing (step 10)**: Acceptance tests run after the fix cycle, which means they execute against real infrastructure. If acceptance tests fail, there is no explicit retry loop in the SKILL.md — unlike the validator fix cycle in step 9. This could leave the workflow in a state where unit/compilation checks pass but acceptance tests fail, with no automated recovery path. The orchestrator may need to decide whether to loop back or report the failure and let the user intervene.

2. **Concurrent developer agents (step 6)**: The flow notes items can run concurrently if independent. For provider resources, checklist items often have ordering dependencies (e.g., schema must exist before CRUD methods, CRUD before flatten/expand helpers). The orchestrator must correctly identify which items are truly independent to avoid compilation failures from missing symbols when agents run in parallel.

3. **Validator auto-fix scope (step 8)**: The validator can apply auto-fixes and then the orchestrator runs `go build` to confirm. If an auto-fix introduces a new issue (e.g., fixing a naming pattern breaks a test reference), the flow relies on the step 9 loop to catch it. This is adequate but worth monitoring for cascading fix cycles.
