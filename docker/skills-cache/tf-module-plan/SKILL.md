---
name: "tf-module-plan"
description: "SDD Phases 1-2. Clarify requirements, research, produce design.md, and await human approval before any code is written."
source: image
---
# SDD — Plan

Produces `specs/{FEATURE}/design.md` from requirements. Stops for human approval before any code is written.

Post progress at key steps: `bash .foundations/scripts/bash/post-issue-progress.sh $ISSUE_NUMBER "<step>" "<status>" "<summary>"`. Valid status values: `started`, `in-progress`, `complete`, `failed`.
Checkpoint after each phase: `bash .foundations/scripts/bash/checkpoint-commit.sh "<step_name>"`. The `<step_name>` must be a short hyphenated identifier (e.g., `"clarify"`, `"research-and-design"`, `"design-approved"`) — NOT a sentence or file path.

## Phase 1: Requirements & Research

1. Run `bash .foundations/scripts/bash/validate-env.sh --json`. Stop if `gate_passed=false`.
2. Parse `$ARGUMENTS` for module name, provider, and description. Ask via `AskUserQuestion` if incomplete.
3. Create GitHub issue: read `.foundations/templates/issue-body-template.md`, fill in the placeholders with parsed requirements, and run `gh issue create --title "Module: {name}" --body "$FILLED_BODY"`. Capture `$ISSUE_NUMBER`. Update the issue body again after Step 6 (clarification) to include security decisions and scope boundaries.
4. Create feature branch: `bash .foundations/scripts/bash/create-new-feature.sh --json --issue $ISSUE_NUMBER --short-name "<module-name>" "<feature description>"`. Parse the JSON output to capture `$BRANCH_NAME` as `$FEATURE` and `$DESIGN_FILE`.
5. Scan requirements against the `tf-domain-category` skill
6. Ask up to 4 clarification questions via `AskUserQuestion`. Must include a security-defaults question.
7. Launch 3-4 concurrent `tf-module-research` subagents for provider docs, AWS best practices, registry patterns, and edge cases. Wait for all to complete. Verify research files exist at `specs/{FEATURE}/research-*.md` via Glob.

## Phase 2: Design

8. Launch `tf-module-design` agent with FEATURE path and clarified requirements. The agent reads the constitution, design template, and research files from `specs/{FEATURE}/research-*.md` itself.
9. Verify `specs/{FEATURE}/design.md` exists via Glob. Re-launch once if missing.
10. Grep to confirm all 7 sections present (`## 1. Purpose` through `## 7. Open Questions`). Fix inline if any missing.
11. Present design summary to user via `AskUserQuestion`: input/output counts, resource count, security controls, test scenarios, checklist items. Options: approve, review file first, request changes.
12. If changes requested, apply and re-present. Repeat until approved.

## Done

Design approved at `specs/{FEATURE}/design.md`. Run `/tf-module-implement $FEATURE` to build.
