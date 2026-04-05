---
name: "tf-provider-implement"
description: "SDD Phases 3-4 for provider development. TDD implementation and validation from an existing provider-design-{resource}.md."
source: image
---
# SDD — Provider Implement

Builds and validates a Terraform provider resource from `specs/{FEATURE}/provider-design-{resource}.md` using TDD.

Post progress: `bash .foundations/scripts/bash/post-issue-progress.sh $ISSUE_NUMBER "<step>" "<status>" "<summary>"`
Checkpoint: `bash .foundations/scripts/bash/checkpoint-commit.sh --dir . --prefix feat "<step_name>"`

## Prerequisites

1. Resolve `$FEATURE` and `$RESOURCE` from `$ARGUMENTS` or current git branch name.
2. Verify `specs/{FEATURE}/provider-design-{resource}.md` exists via Glob. Stop if missing — tell user to run `/tf-provider-plan` first. Capture `$DESIGN_FILE`.
3. Find `$ISSUE_NUMBER` from `$ARGUMENTS` or `gh issue list --search "$FEATURE"`.

## Phase 3: Build + Test

4. Launch concurrent `tf-provider-test-writer` agents with `$DESIGN_FILE`. Verify `_test.go` exists. Checkpoint.
5. Extract all checklist items from design §6 via Grep (`- [ ]` lines).
6. For each item: launch `tf-provider-developer` agent → `go build` + `go test -c` → checkpoint.
7. Final `go vet ./...`. Fix until clean. Verify all §6 items marked `[x]`.

## Phase 4: Validate

8. Launch concurrent `tf-provider-validator` agents with `$DESIGN_FILE` and service directory. If auto-fixes applied, run `go build` to confirm.
9. If remaining issues, launch `tf-provider-developer` targeted at specific issues. Repeat until resolved.
10. Run acceptance tests.
11. Write validation report to `specs/{FEATURE}/reports/` using the `tf-report-template` skill provider template.
12. Checkpoint commit, push branch, create PR linking to `$ISSUE_NUMBER`.

## Done

Report: build pass/fail, test compilation, acceptance test results (if run), validation status, PR link.
