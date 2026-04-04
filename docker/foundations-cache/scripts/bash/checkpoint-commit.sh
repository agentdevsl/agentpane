#!/usr/bin/env bash

# Checkpoint commit script for orchestrator artifact commits
#
# Abstracts the repeating git add/commit/push pattern used by tf-plan-module and
# tf-implement-module after each workflow step. Handles empty-commit detection,
# deterministic commit messages, and push failures.
#
# Pre-commit hooks run on every commit. If hooks auto-fix files (fmt, docs),
# the script re-stages and retries once. If hooks fail on the retry, the
# commit fails — the orchestrator must fix the code before checkpointing.
#
# Usage: ./checkpoint-commit.sh [OPTIONS] <step_name>
#
# ARGUMENTS:
#   step_name           Short step identifier (e.g., "specify", "clarify",
#                       "research-and-plan-draft", "design-review",
#                       "tasks-generation", "cross-artifact-analysis",
#                       "planning", "compound", "implementation-phase-N")
#
# OPTIONS:
#   --dir <path>        Directory to stage (default: . i.e. all changes)
#   --prefix <type>     Commit type prefix: docs, feat, compound (default: docs)
#   --json              Output result as JSON
#   --help, -h          Show help message
#
# EXIT CODES:
#   0: Commit and push succeeded (or nothing to commit)
#   1: Git operation failed (commit or push)
#   2: Invalid arguments
#
# EXAMPLES:
#   checkpoint-commit.sh "specify"
#   checkpoint-commit.sh --dir .foundations/memory/ --prefix compound "learnings"
#   checkpoint-commit.sh --json "design-review"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "$SCRIPT_DIR/common.sh"

# --- Defaults ---
STAGE_DIR="."
COMMIT_PREFIX="docs"
JSON_MODE=false
STEP_NAME=""

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dir)
            STAGE_DIR="$2"
            shift 2
            ;;
        --prefix)
            COMMIT_PREFIX="$2"
            shift 2
            ;;
        --json)
            JSON_MODE=true
            shift
            ;;
        --help|-h)
            cat << 'EOF'
Usage: checkpoint-commit.sh [OPTIONS] <step_name>

Commit and push staged artifacts after a workflow step.

ARGUMENTS:
  step_name           Short step identifier (e.g., "specify", "clarify")

OPTIONS:
  --dir <path>        Directory to stage (default: . i.e. all changes)
  --prefix <type>     Commit type prefix: docs, feat, compound (default: docs)
  --json              Output result as JSON
  --help, -h          Show this help message

EXIT CODES:
  0: Commit and push succeeded (or nothing to commit)
  1: Git operation failed
  2: Invalid arguments
EOF
            exit 0
            ;;
        -*)
            echo "ERROR: Unknown option '$1'. Use --help for usage." >&2
            exit 2
            ;;
        *)
            if [[ -z "$STEP_NAME" ]]; then
                STEP_NAME="$1"
            else
                echo "ERROR: Unexpected argument '$1'. Only one step_name allowed." >&2
                exit 2
            fi
            shift
            ;;
    esac
done

if [[ -z "$STEP_NAME" ]]; then
    echo "ERROR: step_name is required. Use --help for usage." >&2
    exit 2
fi

# --- Resolve feature name from branch ---
BRANCH="$(get_current_branch)"

# Extract feature short-name: strip numeric prefix (e.g., "004-vpc-setup" → "vpc-setup")
if [[ "$BRANCH" =~ ^[0-9]{3}-(.+)$ ]]; then
    FEATURE_NAME="${BASH_REMATCH[1]}"
else
    FEATURE_NAME="$BRANCH"
fi

# --- Build deterministic commit message ---
COMMIT_MSG="${COMMIT_PREFIX}(${FEATURE_NAME}): complete ${STEP_NAME} artifacts"

# --- Stage files ---
git add "$STAGE_DIR"

# --- Check if there's anything to commit ---
if git diff --cached --quiet; then
    # Nothing staged — success with no-op
    if $JSON_MODE; then
        printf '{"committed":false,"pushed":false,"reason":"nothing_to_commit","message":""}\n'
    else
        echo "Nothing to commit in ${STAGE_DIR} — skipping."
    fi
    exit 0
fi

# --- Commit (hooks run — if they auto-fix files, re-stage and retry once) ---
commit_with_retry() {
    if git commit -m "$COMMIT_MSG" "$@"; then
        return 0
    fi

    # Hooks may have auto-fixed files (fmt, terraform-docs). Re-stage and retry.
    git add "$STAGE_DIR"
    if git diff --cached --quiet; then
        # Hooks fixed files but unstaged everything — nothing left to commit
        return 1
    fi

    if git commit -m "$COMMIT_MSG" "$@"; then
        return 0
    fi

    return 1
}

if $JSON_MODE; then
    if ! commit_with_retry >/dev/null 2>&1; then
        printf '{"committed":false,"pushed":false,"reason":"commit_failed","message":"%s"}\n' "$COMMIT_MSG"
        exit 1
    fi
else
    if ! commit_with_retry; then
        echo "ERROR: git commit failed. Pre-commit hooks may have reported issues — fix and retry." >&2
        exit 1
    fi
fi

# --- Push (try plain push first, fall back to setting upstream) ---
# Push failure is non-fatal — the commit is the important part.
# The branch will be pushed later (e.g., during PR creation).
if ! git push 2>/dev/null; then
    if ! git push -u origin HEAD 2>/dev/null; then
        if $JSON_MODE; then
            printf '{"committed":true,"pushed":false,"reason":"push_failed","message":"%s"}\n' "$COMMIT_MSG"
        else
            echo "Warning: git push failed. Commit was created locally: $COMMIT_MSG" >&2
        fi
        exit 0
    fi
fi

# --- Success ---
if $JSON_MODE; then
    printf '{"committed":true,"pushed":true,"reason":"success","message":"%s"}\n' "$COMMIT_MSG"
else
    echo "Committed and pushed: $COMMIT_MSG"
fi

exit 0
