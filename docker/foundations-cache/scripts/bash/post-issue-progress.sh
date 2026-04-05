#!/usr/bin/env bash
# post-issue-progress.sh — Standardised issue progress commenting
#
# Usage:
#   post-issue-progress.sh <issue_number> <phase_name> <status> [summary] [details]
#
# Arguments:
#   issue_number  GitHub issue number (required)
#   phase_name    Human-readable phase name, e.g. "Environment Validation" (required)
#   status        One of: started, in-progress, complete, failed (required)
#   summary       Brief one-line summary of outcome (optional for started/in-progress, recommended for complete/failed)
#   details       Multi-line details/bullets to append as **Summary** block (optional)
#
# Examples:
#   post-issue-progress.sh 42 "Environment Validation" "complete" "All gates passed"
#   post-issue-progress.sh 42 "Specify" "complete" "design.md generated (12 sections)" "- Defined VPC with 3 AZs
# - 4 success criteria with measurable thresholds"
#   post-issue-progress.sh 42 "Sandbox Testing" "failed" "terraform apply failed: missing provider"
#   post-issue-progress.sh 42 "Implementation Phase 1" "started"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
[[ -f "${SCRIPT_DIR}/common.sh" ]] && source "${SCRIPT_DIR}/common.sh"

if [[ $# -lt 3 ]]; then
  echo "Usage: post-issue-progress.sh <issue_number> <phase_name> <status> [summary]" >&2
  echo "  status: started | in-progress | complete | failed" >&2
  exit 1
fi

ISSUE_NUMBER="$1"
PHASE_NAME="$2"
STATUS="$3"
SUMMARY="${4:-}"
DETAILS="${5:-}"

# Validate status
case "$STATUS" in
  started|in-progress|complete|failed) ;;
  *)
    echo "Error: status must be one of: started, in-progress, complete, failed (got: $STATUS)" >&2
    exit 1
    ;;
esac

# Build comment body
case "$STATUS" in
  started|in-progress)
    ICON="🔄"
    STATUS_LABEL="In Progress"
    BODY="## ${ICON} Phase: ${PHASE_NAME}
**Status**: ${STATUS_LABEL}"
    if [[ -n "$SUMMARY" ]]; then
      BODY="${BODY}
${SUMMARY}"
    fi
    ;;
  complete)
    ICON="✅"
    STATUS_LABEL="Complete"
    BODY="## ${ICON} Phase: ${PHASE_NAME}
**Status**: ${STATUS_LABEL}"
    if [[ -n "$SUMMARY" ]]; then
      BODY="${BODY}
**Result**: ${SUMMARY}"
    fi
    ;;
  failed)
    ICON="❌"
    STATUS_LABEL="Failed"
    BODY="## ${ICON} Phase: ${PHASE_NAME}
**Status**: ${STATUS_LABEL}"
    if [[ -n "$SUMMARY" ]]; then
      BODY="${BODY}
**Error**: ${SUMMARY}"
    fi
    ;;
esac

# Append details block if provided
if [[ -n "$DETAILS" ]]; then
  BODY="${BODY}

**Summary**:
${DETAILS}"
fi

# Post to GitHub issue (non-interactive: prevent gh from hanging on prompts)
ensure_gh_noninteractive
gh issue comment "$ISSUE_NUMBER" --body "$BODY" < /dev/null
