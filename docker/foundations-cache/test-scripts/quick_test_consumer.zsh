#!/usr/bin/env zsh
#
# quick_test_consumer.zsh
# Convenience wrapper — sources .env and runs bulk-run-demo.zsh
# with consumer prompts from the prompts/ directory.
#
# Usage:
#   ./quick_test_consumer.zsh                          # dry-run (default)
#   ./quick_test_consumer.zsh --run                    # live run
#   ./quick_test_consumer.zsh --run --parallel 2       # live, 2 at a time
#   ./quick_test_consumer.zsh --cleanup                # live + cleanup after
#   ./quick_test_consumer.zsh --prompt-glob 'consumer_{asg,elastic}*'  # subset

SCRIPT_DIR="${0:A:h}"

# Source env defaults
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
else
    echo "Error: $SCRIPT_DIR/.env not found. Copy .env.example or run setup-demo-env.zsh" >&2
    exit 1
fi

# Defaults
DRY_RUN_FLAG="--dry-run"
EXTRA_ARGS=()

# Parse our wrapper flags, pass everything else through
while [[ $# -gt 0 ]]; do
    case $1 in
        --run)
            DRY_RUN_FLAG=""
            shift
            ;;
        *)
            EXTRA_ARGS+=("$1")
            shift
            ;;
    esac
done

exec "$SCRIPT_DIR/bulk-run-demo.zsh" \
    -t 1 \
    --prompt-dir "$SCRIPT_DIR/prompts" \
    --prompt-glob 'consumer_{asg,cloudfront,elastic}*' \
    $DRY_RUN_FLAG \
    "${EXTRA_ARGS[@]}"
