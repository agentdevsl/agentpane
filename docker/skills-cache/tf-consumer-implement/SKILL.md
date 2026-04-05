---
name: "tf-consumer-implement"
description: "SDD Phases 3-4 for consumer provisioning. Implementation and validation from an existing consumer-design.md. Composes modules, validates, deploys to sandbox, creates PR."
source: image
---
# SDD — Consumer Implement

Builds and validates a consumer deployment from `specs/{FEATURE}/consumer-design.md`.

Post progress at key steps: `bash .foundations/scripts/bash/post-issue-progress.sh $ISSUE_NUMBER "<step>" "<status>" "<summary>"`. Valid status values: `started`, `in-progress`, `complete`, `failed`.
Checkpoint after each phase: `bash .foundations/scripts/bash/checkpoint-commit.sh --dir . --prefix feat "<step_name>"`. The `<step_name>` must be a short hyphenated identifier (e.g., `"scaffolding"`, `"checklist-item-b"`, `"validation"`) — NOT a sentence or file path.

## Prerequisites

1. Resolve `$FEATURE` from `$ARGUMENTS` or current git branch name.
2. Run `bash .foundations/scripts/bash/validate-env.sh --json`. Stop if `gate_passed=false`.
3. Verify `specs/{FEATURE}/consumer-design.md` exists via Glob. Stop if missing — tell user to run `/tf-consumer-plan` first.
4. Find `$ISSUE_NUMBER` from `$ARGUMENTS` or `gh issue list --search "$FEATURE"`.

## Phase 3: Build

5. Extract checklist items from consumer-design.md Section 5 via Grep.
6. For each checklist item (sequentially — items depend on prior items):
   - Launch `tf-consumer-developer` subagent with FEATURE path and item description.
   - When it completes, verify expected files exist via Glob.
   - Run `terraform fmt -check` and `terraform validate` (validate may require `terraform init` first).
   - Checkpoint commit.
     Use concurrent subagents for independent items only when their outputs do not overlap.
7. After all items: run `terraform validate`. If failures remain, re-launch `tf-consumer-developer` subagents targeted at the specific errors.
8. Verify all checklist items in consumer-design.md Section 5 are marked `[x]` via Grep. If any remain `[ ]`, either mark them (if the work was done by a prior item) or flag the gap before proceeding.

## Phase 4: Validate & Deploy

9. Deploy to sandbox — trigger `terraform apply -auto-approve` against the HCP Terraform workspace. Capture the run ID and URL. Remediate any issues until deployment succeeds.
10. Launch `tf-consumer-validator` with `$FEATURE` path, run ID, and workspace name.
11. Verify report exists via Glob. Read the quality score from it. If score < 7.0:
    - Fix issues with `tf-consumer-developer` subagents
    - Destroy sandbox, redeploy, re-launch validator (max 3 rounds)
12. Checkpoint commit, push branch, create PR linking to `$ISSUE_NUMBER`.
13. Ask user: "Destroy sandbox resources?" If yes, trigger destroy run and report status.

## Done

Report at `specs/{FEATURE}/reports/deployment-report.md`. Output: quality score, sandbox deploy status, PR link.
