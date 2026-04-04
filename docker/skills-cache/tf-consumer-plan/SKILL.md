---
name: "tf-consumer-plan"
description: "SDD Phases 1-2 for consumer provisioning. Clarify requirements, research private registry modules, produce consumer-design.md, and await human approval before any code is written."
source: image
---
# SDD — Consumer Plan

Produces `specs/{FEATURE}/consumer-design.md` from requirements. Stops for human approval before any code is written.

Post progress at key steps: `bash .foundations/scripts/bash/post-issue-progress.sh $ISSUE_NUMBER "<step>" "<status>" "<summary>"`. Valid status values: `started`, `in-progress`, `complete`, `failed`.
Checkpoint after each phase: `bash .foundations/scripts/bash/checkpoint-commit.sh "<step_name>"`. The `<step_name>` must be a short hyphenated identifier (e.g., `"clarify"`, `"research-and-design"`, `"design-approved"`) — NOT a sentence or file path.

## Phase 1: Requirements & Research

1. Run `bash .foundations/scripts/bash/validate-env.sh --json`. Stop if `gate_passed=false`. Then call MCP `list_terraform_orgs` to verify TFE_TOKEN — consumer workflows deploy to HCP Terraform, so this is critical.
2. Parse `$ARGUMENTS` for project name, provider, and description. Ask via `AskUserQuestion` if incomplete.
3. Create GitHub issue: read `.foundations/templates/issue-body-template.md`, fill in the placeholders with parsed requirements (adapt for consumer context — modules composed, not resources created), and run `gh issue create --title "Consumer: {project-name}" --body "$FILLED_BODY"`. Capture `$ISSUE_NUMBER`. Update the issue body again after Step 6 (clarification) to include module selections and scope boundaries.
4. Create feature branch: `bash .foundations/scripts/bash/create-new-feature.sh --json --workflow consumer --issue $ISSUE_NUMBER --short-name "<project-name>" "<feature description>"`. Parse the JSON output to capture `$BRANCH_NAME` as `$FEATURE` and `$DESIGN_FILE`.
5. Scan requirements against the `tf-domain-category` skill — focus on module composition ambiguity, networking integration, and workspace configuration decisions.
6. Ask up to 4 clarification questions via `AskUserQuestion`. Must include:
   - **Module selection**: Which private registry modules are required and their approximate versions?
   - **Environment and workspace**: Target workspace, region, and credential pattern (dynamic credentials, assume_role)?
   - A security-related question (encryption, public access, IAM)
   - Scope/integration clarification as needed (networking, monitoring, cross-workspace dependencies)
7. Launch 3-4 concurrent `tf-consumer-research` subagents (run in foreground — they use MCP tools):
   - **Private registry modules**: Available modules, versions, inputs, outputs, secure defaults
   - **Module wiring**: How module outputs connect to inputs, type compatibility, composition patterns
   - **Workspace and deployment**: HCP Terraform workspace configuration, variable sets, dynamic credentials
   Wait for all to complete. Verify research files exist at `specs/{FEATURE}/research-*.md` via Glob.

## Phase 2: Design

8. Launch `tf-consumer-design` agent with FEATURE path and clarified requirements. The agent reads the constitution, design template, and research files from `specs/{FEATURE}/research-*.md` itself.
9. Verify `specs/{FEATURE}/consumer-design.md` exists via Glob. Re-launch once if missing.
10. Grep to confirm all 6 sections present (`## 1. Purpose` through `## 6. Open Questions`). Fix inline if any missing.
11. Present design summary to user via `AskUserQuestion`: module count, wiring connection count, variable count, security controls, checklist items. Options: approve, review file first, request changes.
12. If changes requested, apply and re-present. Repeat until approved.

## Done

Design approved at `specs/{FEATURE}/consumer-design.md`. Run `/tf-consumer-implement $FEATURE` to build.
