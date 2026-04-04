#!/usr/bin/env bash

set -euo pipefail

JSON_MODE=false
SHORT_NAME=""
BRANCH_NUMBER=""
WORKFLOW_TYPE="module"
ARGS=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        --json)
            JSON_MODE=true
            ;;
        --short-name)
            shift
            if [ "$#" -eq 0 ] || [[ "$1" == --* ]]; then
                echo 'Error: --short-name requires a value' >&2
                exit 1
            fi
            SHORT_NAME="$1"
            ;;
        --number)
            shift
            if [ "$#" -eq 0 ] || [[ "$1" == --* ]]; then
                echo 'Error: --number requires a value' >&2
                exit 1
            fi
            BRANCH_NUMBER="$1"
            ;;
        --issue)
            shift
            if [ "$#" -eq 0 ] || [[ "$1" == --* ]]; then
                echo 'Error: --issue requires a value' >&2
                exit 1
            fi
            # Use issue number as branch number
            BRANCH_NUMBER="$1"
            ;;
        --workflow)
            shift
            if [ "$#" -eq 0 ] || [[ "$1" == --* ]]; then
                echo 'Error: --workflow requires a value (module, provider, consumer)' >&2
                exit 1
            fi
            case "$1" in
                module|provider|consumer) WORKFLOW_TYPE="$1" ;;
                *) echo "Error: --workflow must be one of: module, provider, consumer" >&2; exit 1 ;;
            esac
            ;;
        --help|-h)
            echo "Usage: $0 [--json] [--short-name <name>] [--number N] [--issue N] [--workflow TYPE] <feature_description>"
            echo ""
            echo "Options:"
            echo "  --json              Output in JSON format"
            echo "  --short-name <name> Provide a custom short name (2-4 words) for the branch"
            echo "  --number N          Specify branch number manually (overrides auto-detection)"
            echo "  --issue N           Use GitHub issue number as the branch number"
            echo "  --workflow TYPE     Workflow type: module (default), provider, consumer"
            echo "  --help, -h          Show this help message"
            echo ""
            echo "Creates:"
            echo "  - Git feature branch: NNN-<short-name>"
            echo "  - Feature directory:  specs/NNN-<short-name>/"
            echo "  - Design document:    specs/NNN-<short-name>/<design-file> (from workflow template)"
            echo ""
            echo "Examples:"
            echo "  $0 'Add user authentication system' --short-name 'user-auth'"
            echo "  $0 'Implement OAuth2 integration for API' --number 5"
            echo "  $0 'Deploy EC2 with VPC' --issue 42 --short-name 'ec2-vpc'"
            exit 0
            ;;
        *)
            ARGS+=("$1")
            ;;
    esac
    shift
done

FEATURE_DESCRIPTION="${ARGS[*]:-}"
if [ -z "$FEATURE_DESCRIPTION" ]; then
    echo "Usage: $0 [--json] [--short-name <name>] [--number N] <feature_description>" >&2
    exit 1
fi

# Function to find the repository root by searching for existing project markers
find_repo_root() {
    local dir="$1"
    while [ "$dir" != "/" ]; do
        if [ -d "$dir/.git" ] || [ -d "$dir/.foundations" ]; then
            echo "$dir"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    return 1
}

# Function to get highest number from specs directory
get_highest_from_specs() {
    local specs_dir="$1"
    local highest=0

    if [ -d "$specs_dir" ]; then
        shopt -s nullglob
        for dir in "$specs_dir"/*; do
            [ -d "$dir" ] || continue
            dirname="$(basename "$dir")"
            number="$(echo "$dirname" | grep -o '^[0-9]\+' || echo "0")"
            number=$((10#$number))
            if [ "$number" -gt "$highest" ]; then
                highest=$number
            fi
        done
        shopt -u nullglob
    fi

    echo "$highest"
}

# Function to get highest number from git branches
get_highest_from_branches() {
    local highest=0

    # Get all branches (local and remote)
    branches="$(git branch -a 2>/dev/null || echo "")"

    if [ -n "$branches" ]; then
        while IFS= read -r branch; do
            # Clean branch name: remove leading markers and remote prefixes
            clean_branch="$(echo "$branch" | sed 's/^[* ]*//; s|^remotes/[^/]*/||')"

            # Extract feature number if branch matches pattern ###-*
            if echo "$clean_branch" | grep -q '^[0-9]\{3\}-'; then
                number="$(echo "$clean_branch" | grep -o '^[0-9]\{3\}' || echo "0")"
                number=$((10#$number))
                if [ "$number" -gt "$highest" ]; then
                    highest=$number
                fi
            fi
        done <<< "$branches"
    fi

    echo "$highest"
}

# Function to check existing branches (local and remote) and return next available number
check_existing_branches() {
    local short_name="$1"
    local specs_dir="$2"

    # Fetch all remotes to get latest branch info (suppress errors if no remotes)
    git fetch --all --prune 2>/dev/null || true

    # Find all branches matching the pattern using git ls-remote (more reliable)
    local remote_branches
    remote_branches="$(git ls-remote --heads origin 2>/dev/null | grep -E "refs/heads/[0-9]+-${short_name}$" | sed 's/.*\/\([0-9]*\)-.*/\1/' | sort -n)" || true

    # Also check local branches
    local local_branches
    local_branches="$(git branch 2>/dev/null | grep -E "^[* ]*[0-9]+-${short_name}$" | sed 's/^[* ]*//' | sed 's/-.*//' | sort -n)" || true

    # Check specs directory as well
    local spec_dirs=""
    if [ -d "$specs_dir" ]; then
        spec_dirs="$(find "$specs_dir" -maxdepth 1 -type d -name "[0-9]*-${short_name}" -print0 2>/dev/null | xargs -0 -n1 basename 2>/dev/null | sed 's/-.*//' | sort -n)"
    fi

    # Combine all sources and get the highest number
    local all_nums=()
    while IFS= read -r num; do
        [[ -n "$num" ]] && all_nums+=("$num")
    done <<< "$remote_branches"
    while IFS= read -r num; do
        [[ -n "$num" ]] && all_nums+=("$num")
    done <<< "$local_branches"
    while IFS= read -r num; do
        [[ -n "$num" ]] && all_nums+=("$num")
    done <<< "$spec_dirs"

    local max_num=0
    for num in "${all_nums[@]}"; do
        if [ "$num" -gt "$max_num" ] 2>/dev/null; then
            max_num=$num
        fi
    done

    # Return next number
    echo $((max_num + 1))
}

# Function to clean and format a branch name
clean_branch_name() {
    local name="$1"
    echo "$name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/-\+/-/g' | sed 's/^-//' | sed 's/-$//'
}

# Resolve repository root. Prefer git information when available, but fall back
# to searching for repository markers so the workflow still functions in repositories that
# were initialised with --no-git.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if git rev-parse --show-toplevel >/dev/null 2>&1; then
    REPO_ROOT="$(git rev-parse --show-toplevel)"
    HAS_GIT=true
else
    REPO_ROOT="$(find_repo_root "$SCRIPT_DIR")"
    if [ -z "$REPO_ROOT" ]; then
        echo "Error: Could not determine repository root. Please run this script from within the repository." >&2
        exit 1
    fi
    HAS_GIT=false
fi

cd "$REPO_ROOT"

SPECS_DIR="$REPO_ROOT/specs"
mkdir -p "$SPECS_DIR"

# Function to generate branch name with stop word filtering and length filtering
generate_branch_name() {
    local description="$1"

    # Common stop words to filter out
    local stop_words="^(i|a|an|the|to|for|of|in|on|at|by|with|from|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|should|could|can|may|might|must|shall|this|that|these|those|my|your|our|their|want|need|add|get|set)$"

    # Convert to lowercase and split into words
    local clean_name
    clean_name="$(echo "$description" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/ /g')"

    # Filter words: remove stop words and words shorter than 3 chars (unless they're uppercase acronyms in original)
    local meaningful_words=()
    IFS=' ' read -ra words <<< "$clean_name"
    for word in "${words[@]}"; do
        # Skip empty words
        [ -z "$word" ] && continue

        # Keep words that are NOT stop words AND (length >= 3 OR are potential acronyms)
        if ! echo "$word" | grep -qiE "$stop_words"; then
            if [ "${#word}" -ge 3 ]; then
                meaningful_words+=("$word")
            elif word_upper="$(echo "$word" | tr '[:lower:]' '[:upper:]')" && echo "$description" | grep -q "\b${word_upper}\b"; then
                # Keep short words if they appear as uppercase in original (likely acronyms)
                meaningful_words+=("$word")
            fi
        fi
    done

    # If we have meaningful words, use first 3-4 of them
    if [ "${#meaningful_words[@]}" -gt 0 ]; then
        local max_words=3
        if [ "${#meaningful_words[@]}" -eq 4 ]; then max_words=4; fi

        local result=""
        local count=0
        for word in "${meaningful_words[@]}"; do
            if [ "$count" -ge "$max_words" ]; then break; fi
            if [ -n "$result" ]; then result="$result-"; fi
            result="$result$word"
            count=$((count + 1))
        done
        echo "$result"
    else
        # Fallback to original logic if no meaningful words found
        local cleaned
        cleaned="$(clean_branch_name "$description")"
        # Use awk instead of head to avoid SIGPIPE under pipefail
        echo "$cleaned" | tr '-' '\n' | grep -v '^$' | awk 'NR<=3' | tr '\n' '-' | sed 's/-$//'
    fi
}

# Generate branch name
if [ -n "$SHORT_NAME" ]; then
    # Use provided short name, just clean it up
    BRANCH_SUFFIX="$(clean_branch_name "$SHORT_NAME")"
else
    # Generate from description with smart filtering
    BRANCH_SUFFIX="$(generate_branch_name "$FEATURE_DESCRIPTION")"
fi

# Determine branch number
if [ -z "$BRANCH_NUMBER" ]; then
    if [ "$HAS_GIT" = true ]; then
        # Use the global maximum across ALL sources to avoid numeric prefix collisions.
        # check_existing_branches only looks for same-suffix matches, which can return
        # a number that collides with an existing spec dir using a different suffix.
        SUFFIX_NUM="$(check_existing_branches "$BRANCH_SUFFIX" "$SPECS_DIR")"
        SPECS_NUM="$(($(get_highest_from_specs "$SPECS_DIR") + 1))"
        BRANCH_NUM="$(($(get_highest_from_branches) + 1))"
        BRANCH_NUMBER=$SUFFIX_NUM
        [ "$SPECS_NUM" -gt "$BRANCH_NUMBER" ] && BRANCH_NUMBER=$SPECS_NUM
        [ "$BRANCH_NUM" -gt "$BRANCH_NUMBER" ] && BRANCH_NUMBER=$BRANCH_NUM
    else
        # Fall back to local directory check
        HIGHEST="$(get_highest_from_specs "$SPECS_DIR")"
        BRANCH_NUMBER=$((HIGHEST + 1))
    fi
fi

FEATURE_NUM="$(printf "%03d" "$BRANCH_NUMBER")"
BRANCH_NAME="${FEATURE_NUM}-${BRANCH_SUFFIX}"

# GitHub enforces a 244-byte limit on branch names
# Validate and truncate if necessary
MAX_BRANCH_LENGTH=244
if [ "${#BRANCH_NAME}" -gt "$MAX_BRANCH_LENGTH" ]; then
    # Calculate how much we need to trim from suffix
    # Account for: feature number (3) + hyphen (1) = 4 chars
    MAX_SUFFIX_LENGTH=$((MAX_BRANCH_LENGTH - 4))

    # Truncate suffix at word boundary if possible
    TRUNCATED_SUFFIX="$(echo "$BRANCH_SUFFIX" | cut -c1-"$MAX_SUFFIX_LENGTH")"
    # Remove trailing hyphen if truncation created one
    TRUNCATED_SUFFIX="${TRUNCATED_SUFFIX%-}"

    ORIGINAL_BRANCH_NAME="$BRANCH_NAME"
    BRANCH_NAME="${FEATURE_NUM}-${TRUNCATED_SUFFIX}"

    >&2 echo "[specify] Warning: Branch name exceeded GitHub's 244-byte limit"
    >&2 echo "[specify] Original: $ORIGINAL_BRANCH_NAME (${#ORIGINAL_BRANCH_NAME} bytes)"
    >&2 echo "[specify] Truncated to: $BRANCH_NAME (${#BRANCH_NAME} bytes)"
fi

if [ "$HAS_GIT" = true ]; then
    CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
    >&2 echo "[specify] Creating feature branch '$BRANCH_NAME' from '$CURRENT_BRANCH'"
    git checkout -b "$BRANCH_NAME"
    # Push with -u to set upstream so checkpoint-commit.sh can `git push` without errors
    if git remote get-url origin &>/dev/null; then
        push_output=""
        if push_output="$(git push -u origin "$BRANCH_NAME" 2>&1)"; then
            echo "$push_output" | sed 's/^/[specify] /' >&2
        else
            echo "$push_output" | sed 's/^/[specify] /' >&2
            >&2 echo "[specify] Warning: initial push failed — will retry on first checkpoint commit"
        fi
    fi
else
    >&2 echo "[specify] Warning: Git repository not detected; skipped branch creation for $BRANCH_NAME"
fi

FEATURE_DIR="$SPECS_DIR/$BRANCH_NAME"
mkdir -p "$FEATURE_DIR"

case "$WORKFLOW_TYPE" in
    module)
        TEMPLATE="$REPO_ROOT/.foundations/templates/module-design-template.md"
        DESIGN_FILE="$FEATURE_DIR/design.md"
        ;;
    provider)
        TEMPLATE="$REPO_ROOT/.foundations/templates/provider-design-template.md"
        DESIGN_FILE="$FEATURE_DIR/provider-design.md"
        ;;
    consumer)
        TEMPLATE="$REPO_ROOT/.foundations/templates/consumer-design-template.md"
        DESIGN_FILE="$FEATURE_DIR/consumer-design.md"
        ;;
esac
if [ -f "$TEMPLATE" ]; then cp "$TEMPLATE" "$DESIGN_FILE"; else touch "$DESIGN_FILE"; fi

# Set the SPECIFY_FEATURE environment variable for the current session
export SPECIFY_FEATURE="$BRANCH_NAME"

if $JSON_MODE; then
    printf '{"BRANCH_NAME":"%s","DESIGN_FILE":"%s","FEATURE_NUM":"%s","FEATURE_DIR":"%s"}\n' "$BRANCH_NAME" "$DESIGN_FILE" "$FEATURE_NUM" "$FEATURE_DIR"
else
    echo "BRANCH_NAME: $BRANCH_NAME"
    echo "DESIGN_FILE: $DESIGN_FILE"
    echo "FEATURE_NUM: $FEATURE_NUM"
    echo "SPECIFY_FEATURE environment variable set to: $BRANCH_NAME"
fi
