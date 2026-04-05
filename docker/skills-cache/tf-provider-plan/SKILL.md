---
name: "tf-provider-plan"
description: "SDD Phases 1-2 for provider development. Clarify requirements, research, produce provider-design-{resource}.md, and await human approval before any code is written."
source: image
---
# SDD — Provider Plan

Produces `specs/{FEATURE}/provider-design-{resource}.md` from requirements. Stops for human approval before any code is written.

Post progress at key steps: `bash .foundations/scripts/bash/post-issue-progress.sh $ISSUE_NUMBER "<step>" "<status>" "<summary>"`. Valid status values: `started`, `in-progress`, `complete`, `failed`.
Checkpoint after each phase: `bash .foundations/scripts/bash/checkpoint-commit.sh "<step_name>"`. The `<step_name>` must be a short hyphenated identifier (e.g., `"clarify"`, `"research-and-design"`, `"design-approved"`) — NOT a sentence or file path.

## Phase 1: Requirements & Research

1. Run `bash .foundations/scripts/bash/validate-env.sh --json`. Stop if `gate_passed=false`. Then separately verify Go is available: `go version` (Go >= 1.21 required). Stop if Go is not installed or version is insufficient.
2. Create GitHub issue: read `.foundations/templates/issue-body-template.md`, fill in the placeholders with parsed requirements, and run `gh issue create --title "Provider Resource: {provider}_{service}_{resource}" --body "$FILLED_BODY"`. Capture `$ISSUE_NUMBER`. Update the issue body again after Step 6 (clarification) to include API decisions and scope boundaries.
4. Create feature branch: `bash .foundations/scripts/bash/create-new-feature.sh --json --workflow provider --issue $ISSUE_NUMBER --short-name "<resource-name>" "<feature description>"`. Parse the JSON output to capture `$BRANCH_NAME` as `$FEATURE`.
5. Scan requirements against the `tf-domain-category` skill — focus on API behavior ambiguity, state management decisions (ForceNew vs in-place update), and error handling patterns.
6. Ask up to 5 clarification questions via `AskUserQuestion`. Must include update-behavior (ForceNew vs in-place), test environment, and security questions.
7. Launch 3-4 concurrent `tf-provider-research` subagents for API/SDK docs, Plugin Framework patterns, existing provider implementations, and import/state patterns. Wait for all to complete. Verify research files exist at `specs/{FEATURE}/research-*.md` via Glob.

## Phase 2: Design

8. Launch `tf-provider-design` agent with FEATURE path, RESOURCE name, and clarified requirements. The agent reads the constitution, design template, and research files from `specs/{FEATURE}/research-*.md` itself. Output: `specs/{FEATURE}/provider-design-{resource}.md`.
9. Verify `specs/{FEATURE}/provider-design-{resource}.md` exists via Glob. Re-launch once if missing.
10. Grep to confirm all 7 sections present (`## 1. Purpose` through `## 7. Open Questions`). Fix inline if any missing.
11. Present design summary to user via `AskUserQuestion`: attribute counts, CRUD operations, test scenario counts, checklist items. Options: approve, review file first, request changes.
12. If changes requested, apply and re-present. Repeat until approved.

## Done

Design approved at `specs/{FEATURE}/provider-design-{resource}.md`. Run `/tf-provider-implement $FEATURE $RESOURCE` to build.
