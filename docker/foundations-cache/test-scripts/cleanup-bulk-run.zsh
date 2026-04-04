#!/usr/bin/env zsh
#
# cleanup-bulk-run.zsh
# Scans a directory for demo repos and deletes them (remote + local).
# Identifies repos by inspecting git remotes in each subdirectory.
#
# Variables (via CLI args):
#   - -p, --path - Base directory to scan (default: /workspace/demo-runs)
#   - -a, --account - GitHub account (filters repos)
#   - -H, --host - GitHub hostname (filters repos)
#   - -y, --yes - Skip confirmation
#   - --dry-run - Show what would be deleted
#   - --local-only - Only delete local clones
#   - --help - Show help

#   Usage examples:
#   # Scan and show what would be deleted
#   ./cleanup-bulk-run.zsh --dry-run
#
#   # Delete everything without confirmation
#   ./cleanup-bulk-run.zsh -y
#
#   # Only delete local clones
#   ./cleanup-bulk-run.zsh --local-only -y

set -e

# =============================================================================
#  ░▒▓ FLUX TERMINAL THEME ▓▒░
# =============================================================================
typeset -r C_PINK="\033[38;2;255;92;138m"
typeset -r C_CYAN="\033[38;2;80;220;235m"
typeset -r C_PURPLE="\033[38;2;168;130;255m"
typeset -r C_GREEN="\033[38;2;80;250;160m"
typeset -r C_RED="\033[38;2;255;85;85m"
typeset -r C_YELLOW="\033[38;2;255;200;80m"
typeset -r C_ORANGE="\033[38;2;255;150;50m"
typeset -r C_WHITE="\033[1;37m"
typeset -r C_DIM="\033[38;5;243m"
typeset -r C_DIMMER="\033[38;5;238m"
typeset -r C_BOLD="\033[1m"
typeset -r C_ITALIC="\033[3m"
typeset -r C_RESET="\033[0m"
typeset -r C_BG_SUBTLE="\033[48;5;236m"

SCRIPT_START_TIME=$EPOCHSECONDS

# Ensure cursor visible on exit/interrupt
trap 'printf "\e[?25h"; [[ -n "$_SPIN_PID" ]] && kill "$_SPIN_PID" 2>/dev/null' EXIT INT TERM

# ─── Theme Drawing Functions ──────────────────────────────────────────────────

neon_header() {
    echo "" >&2
    printf "  ${C_CYAN}╭──────────────────────────────────────────────────────╮${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}                                                      ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}   ${C_PINK}░▒▓${C_RESET} ${C_WHITE}${C_BOLD}B U L K   R U N   C L E A N U P${C_RESET}      ${C_PINK}▓▒░${C_RESET}   ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}   ${C_DIM}${C_ITALIC}     scan · identify · delete — automated${C_RESET}     ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}                                                      ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}╰──────────────────────────────────────────────────────╯${C_RESET}\n" >&2
    echo "" >&2
}

neon_section() {
    local title="$1"
    local dashes=$(( 50 - ${#title} ))
    [[ $dashes -lt 4 ]] && dashes=4
    printf "\n  ${C_CYAN}▎${C_RESET} ${C_PURPLE}${C_BOLD}%s${C_RESET} ${C_DIMMER}%s${C_RESET}\n\n" "$title" "$(printf '─%.0s' {1..$dashes})" >&2
}

neon_box_start() {
    printf "    ${C_DIMMER}┌─────────────────────────────────────────────────┐${C_RESET}\n" >&2
}

neon_box_kv() {
    local key="$1" val="$2"
    printf "    ${C_DIMMER}│${C_RESET}  ${C_PURPLE}%-13s${C_RESET} ${C_WHITE}%-33s${C_RESET} ${C_DIMMER}│${C_RESET}\n" "$key" "$val" >&2
}

neon_box_end() {
    printf "    ${C_DIMMER}└─────────────────────────────────────────────────┘${C_RESET}\n" >&2
}

log_info() {
    printf "    ${C_CYAN}▸${C_RESET} %s\n" "$1" >&2
}

log_success() {
    printf "    ${C_GREEN}✔${C_RESET} %s\n" "$1" >&2
}

log_error() {
    printf "    ${C_RED}✖${C_RESET} %s\n" "$1" >&2
}

log_warn() {
    printf "    ${C_YELLOW}▲${C_RESET} %s\n" "$1" >&2
}

# ─── Spinner ─────────────────────────────────────────────────────────────────

_SPIN_PID=""

spin_start() {
    local msg="$1"
    (
        local frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
        local i=0
        while true; do
            printf "\r    ${C_CYAN}${frames[$((i % 10 + 1))]}${C_RESET} ${C_DIM}%s${C_RESET}  " "$msg" >&2
            sleep 0.08
            i=$((i + 1))
        done
    ) &
    _SPIN_PID=$!
}

spin_stop() {
    local ok="${1:-done}"
    if [[ -n "$_SPIN_PID" ]]; then
        kill "$_SPIN_PID" 2>/dev/null
        wait "$_SPIN_PID" 2>/dev/null
        _SPIN_PID=""
    fi
    printf "\r\e[2K    ${C_GREEN}✔${C_RESET} %s\n" "$ok" >&2
}

spin_stop_fail() {
    local msg="${1:-failed}"
    if [[ -n "$_SPIN_PID" ]]; then
        kill "$_SPIN_PID" 2>/dev/null
        wait "$_SPIN_PID" 2>/dev/null
        _SPIN_PID=""
    fi
    printf "\r\e[2K    ${C_RED}✖${C_RESET} %s\n" "$msg" >&2
}

elapsed_time() {
    local elapsed=$(( EPOCHSECONDS - SCRIPT_START_TIME ))
    local mins=$((elapsed / 60))
    local secs=$((elapsed % 60))
    if (( mins > 0 )); then
        printf "%dm %ds" "$mins" "$secs"
    else
        printf "%ds" "$secs"
    fi
}

# =============================================================================
# CONFIGURATION
# =============================================================================
SCAN_PATH="${SCAN_PATH:-/workspace/demo-runs}"
FILTER_ACCOUNT=""
FILTER_HOST=""
SKIP_CONFIRM=false
DRY_RUN=false
LOCAL_ONLY=false

# =============================================================================
# USAGE
# =============================================================================
usage() {
    echo "" >&2
    printf "  ${C_CYAN}╭──────────────────────────────────────────────────────╮${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}   ${C_PINK}░▒▓${C_RESET} ${C_WHITE}${C_BOLD}B U L K   R U N   C L E A N U P${C_RESET}      ${C_PINK}▓▒░${C_RESET}   ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}╰──────────────────────────────────────────────────────╯${C_RESET}\n" >&2
    echo "" >&2
    printf "  ${C_DIM}Scans a directory for demo repos and deletes them.${C_RESET}\n" >&2
    printf "  ${C_DIM}Identifies repos by inspecting git remotes.${C_RESET}\n" >&2
    echo "" >&2
    printf "  ${C_PURPLE}${C_BOLD}Usage${C_RESET}  ${C_WHITE}$0 ${C_DIM}[OPTIONS]${C_RESET}\n" >&2
    echo "" >&2
    printf "  ${C_CYAN}▎${C_RESET} ${C_PURPLE}${C_BOLD}Options${C_RESET}\n" >&2
    echo "" >&2
    printf "    ${C_CYAN}-p${C_RESET}, ${C_CYAN}--path${C_RESET} ${C_DIM}PATH${C_RESET}          Base directory to scan ${C_DIMMER}(default: ${SCAN_PATH})${C_RESET}\n" >&2
    printf "    ${C_CYAN}-a${C_RESET}, ${C_CYAN}--account${C_RESET} ${C_DIM}NAME${C_RESET}       GitHub account filter\n" >&2
    printf "    ${C_CYAN}-H${C_RESET}, ${C_CYAN}--host${C_RESET} ${C_DIM}HOST${C_RESET}          GitHub hostname filter\n" >&2
    printf "    ${C_CYAN}-y${C_RESET}, ${C_CYAN}--yes${C_RESET}                 Skip confirmation\n" >&2
    printf "    ${C_CYAN}--dry-run${C_RESET}                 Show what would be deleted\n" >&2
    printf "    ${C_CYAN}--local-only${C_RESET}              Only delete local clones\n" >&2
    printf "    ${C_CYAN}--help${C_RESET}                    Show this help\n" >&2
    echo "" >&2
    printf "  ${C_CYAN}▎${C_RESET} ${C_PURPLE}${C_BOLD}Examples${C_RESET}\n" >&2
    echo "" >&2
    printf "    ${C_DIM}\$${C_RESET} ${C_WHITE}$0 ${C_CYAN}--dry-run${C_RESET}                          ${C_DIMMER}# show plan${C_RESET}\n" >&2
    printf "    ${C_DIM}\$${C_RESET} ${C_WHITE}$0 ${C_CYAN}-y${C_RESET}                                 ${C_DIMMER}# delete all, no confirm${C_RESET}\n" >&2
    printf "    ${C_DIM}\$${C_RESET} ${C_WHITE}$0 ${C_CYAN}--local-only${C_RESET} ${C_CYAN}-y${C_RESET}                    ${C_DIMMER}# local only${C_RESET}\n" >&2
    printf "    ${C_DIM}\$${C_RESET} ${C_WHITE}$0 ${C_CYAN}-a${C_RESET} ${C_WHITE}MyOrg ${C_CYAN}-H${C_RESET} ${C_WHITE}github.example.com${C_RESET}  ${C_DIMMER}# filter by account/host${C_RESET}\n" >&2
    echo "" >&2
    exit 0
}

# =============================================================================
# ARGUMENT PARSING
# =============================================================================
while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--path)
            SCAN_PATH="$2"
            shift 2
            ;;
        -a|--account)
            FILTER_ACCOUNT="$2"
            shift 2
            ;;
        -H|--host)
            FILTER_HOST="$2"
            shift 2
            ;;
        -y|--yes)
            SKIP_CONFIRM=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --local-only)
            LOCAL_ONLY=true
            shift
            ;;
        --help)
            usage
            ;;
        *)
            echo "Error: Unknown option $1"
            usage
            ;;
    esac
done

# =============================================================================
# PARSE GIT REMOTE URL
# =============================================================================
# Extracts host, account, and repo name from a git remote URL.
# Supports both HTTPS and SSH URL formats.
#
# Sets: PARSED_HOST, PARSED_ACCOUNT, PARSED_REPO
parse_remote_url() {
    local url="$1"
    PARSED_HOST=""
    PARSED_ACCOUNT=""
    PARSED_REPO=""

    # Remove trailing .git
    url="${url%.git}"

    if [[ "$url" == https://* ]]; then
        # https://github.com/account/repo
        local stripped="${url#https://}"
        PARSED_HOST="${stripped%%/*}"
        local path="${stripped#*/}"
        PARSED_ACCOUNT="${path%%/*}"
        PARSED_REPO="${path#*/}"
    elif [[ "$url" == git@* ]]; then
        # git@github.com:account/repo
        local stripped="${url#git@}"
        PARSED_HOST="${stripped%%:*}"
        local path="${stripped#*:}"
        PARSED_ACCOUNT="${path%%/*}"
        PARSED_REPO="${path#*/}"
    elif [[ "$url" == ssh://* ]]; then
        # ssh://git@github.com/account/repo
        local stripped="${url#ssh://}"
        stripped="${stripped#*@}"
        PARSED_HOST="${stripped%%/*}"
        local path="${stripped#*/}"
        PARSED_ACCOUNT="${path%%/*}"
        PARSED_REPO="${path#*/}"
    fi
}

# =============================================================================
# SCAN DIRECTORY
# =============================================================================
scan_repos() {
    neon_section "Scanning for Repos"

    if [[ ! -d "$SCAN_PATH" ]]; then
        log_error "Directory not found: $SCAN_PATH"
        exit 1
    fi

    # Arrays to hold discovered repos
    typeset -ga REPO_DIRS=()
    typeset -ga REPO_HOSTS=()
    typeset -ga REPO_ACCOUNTS=()
    typeset -ga REPO_NAMES=()
    typeset -ga REPO_REMOTES=()

    local found=0
    local skipped=0

    for dir in "$SCAN_PATH"/*(N/); do
        local dir_name="${dir:t}"

        # Check if it's a git repo
        if [[ ! -d "$dir/.git" ]]; then
            skipped=$((skipped + 1))
            continue
        fi

        # Get the origin remote URL
        local remote_url
        remote_url=$(git -C "$dir" remote get-url origin 2>/dev/null || true)

        if [[ -z "$remote_url" ]]; then
            log_warn "No origin remote in $dir_name — skipping"
            skipped=$((skipped + 1))
            continue
        fi

        # Parse the remote URL
        parse_remote_url "$remote_url"

        if [[ -z "$PARSED_HOST" || -z "$PARSED_ACCOUNT" || -z "$PARSED_REPO" ]]; then
            log_warn "Could not parse remote URL for $dir_name: $remote_url"
            skipped=$((skipped + 1))
            continue
        fi

        # Apply filters
        if [[ -n "$FILTER_ACCOUNT" && "$PARSED_ACCOUNT" != "$FILTER_ACCOUNT" ]]; then
            skipped=$((skipped + 1))
            continue
        fi
        if [[ -n "$FILTER_HOST" && "$PARSED_HOST" != "$FILTER_HOST" ]]; then
            skipped=$((skipped + 1))
            continue
        fi

        REPO_DIRS+=("$dir")
        REPO_HOSTS+=("$PARSED_HOST")
        REPO_ACCOUNTS+=("$PARSED_ACCOUNT")
        REPO_NAMES+=("$PARSED_REPO")
        REPO_REMOTES+=("$remote_url")
        found=$((found + 1))
    done

    log_success "Found $found repo(s), skipped $skipped"
}

# =============================================================================
# DISPLAY REPOS
# =============================================================================
display_repos() {
    if (( ${#REPO_DIRS[@]} == 0 )); then
        log_warn "No repos found to clean up"
        exit 0
    fi

    neon_section "Repos to Delete"

    # Table header
    printf "    ${C_PURPLE}${C_BOLD}%-4s %-25s %-20s %-25s${C_RESET}\n" "#" "REPO" "ACCOUNT" "HOST" >&2
    printf "    ${C_DIMMER}%-4s %-25s %-20s %-25s${C_RESET}\n" "────" "─────────────────────────" "────────────────────" "─────────────────────────" >&2

    for i in {1..${#REPO_DIRS[@]}}; do
        printf "    ${C_DIM}%-4d${C_RESET} ${C_WHITE}%-25s${C_RESET} ${C_DIM}%-20s${C_RESET} ${C_DIMMER}%-25s${C_RESET}\n" \
            "$i" "${REPO_NAMES[$i]}" "${REPO_ACCOUNTS[$i]}" "${REPO_HOSTS[$i]}" >&2
    done
    echo "" >&2

    if [[ "$LOCAL_ONLY" == true ]]; then
        log_info "Mode: ${C_WHITE}local-only${C_RESET} (remote repos will NOT be deleted)"
    else
        log_info "Mode: ${C_WHITE}full cleanup${C_RESET} (remote + local)"
    fi
}

# =============================================================================
# CONFIRM
# =============================================================================
confirm_delete() {
    if [[ "$DRY_RUN" == true ]]; then
        echo "" >&2
        printf "    ${C_YELLOW}▲${C_RESET} ${C_DIM}No changes made (dry run)${C_RESET}\n" >&2
        echo "" >&2
        exit 0
    fi

    if [[ "$SKIP_CONFIRM" == true ]]; then
        return
    fi

    echo "" >&2
    printf "    ${C_RED}${C_BOLD}⚠  This will permanently delete ${#REPO_DIRS[@]} repo(s).${C_RESET}\n" >&2
    printf "    ${C_DIM}This action cannot be undone.${C_RESET}\n" >&2
    echo "" >&2
    printf "    ${C_WHITE}Continue? ${C_DIM}[y/N]${C_RESET} " >&2
    read -r answer
    if [[ "$answer" != [yY] && "$answer" != [yY][eE][sS] ]]; then
        log_info "Aborted"
        exit 0
    fi
}

# =============================================================================
# DELETE REPOS
# =============================================================================
delete_repos() {
    neon_section "Deleting Repos"

    local deleted_remote=0
    local deleted_local=0
    local failed=0

    for i in {1..${#REPO_DIRS[@]}}; do
        local dir="${REPO_DIRS[$i]}"
        local host="${REPO_HOSTS[$i]}"
        local account="${REPO_ACCOUNTS[$i]}"
        local repo="${REPO_NAMES[$i]}"
        local full_name="$account/$repo"

        # Delete remote repo (unless --local-only)
        if [[ "$LOCAL_ONLY" != true ]]; then
            spin_start "Deleting remote $full_name ($host)"
            if GH_HOST="$host" gh repo delete "$full_name" --yes 2>/dev/null; then
                spin_stop "Deleted remote: $full_name"
                deleted_remote=$((deleted_remote + 1))
            else
                spin_stop_fail "Failed to delete remote: $full_name"
                failed=$((failed + 1))
            fi
        fi

        # Delete local directory
        if [[ -d "$dir" ]]; then
            rm -rf "$dir"
            log_success "Deleted local: ${dir:t}"
            deleted_local=$((deleted_local + 1))
        fi
    done

    # Summary
    echo "" >&2
    printf "  ${C_CYAN}╭──────────────────────────────────────────────────────╮${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}   ${C_PINK}░▒▓${C_RESET} ${C_WHITE}${C_BOLD}Cleanup Complete${C_RESET}                              ${C_PINK}▓▒░${C_RESET} ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}╰──────────────────────────────────────────────────────╯${C_RESET}\n" >&2
    echo "" >&2
    if [[ "$LOCAL_ONLY" != true ]]; then
        printf "    ${C_GREEN}${C_BOLD}%d${C_RESET} ${C_DIM}remote(s) deleted${C_RESET}" "$deleted_remote" >&2
        printf "  ${C_DIMMER}·${C_RESET}  " >&2
    fi
    printf "${C_GREEN}${C_BOLD}%d${C_RESET} ${C_DIM}local clone(s) deleted${C_RESET}" "$deleted_local" >&2
    if (( failed > 0 )); then
        printf "  ${C_DIMMER}·${C_RESET}  ${C_RED}${C_BOLD}%d${C_RESET} ${C_DIM}failed${C_RESET}" "$failed" >&2
    fi
    printf "  ${C_DIMMER}·${C_RESET}  ${C_DIM}%s elapsed${C_RESET}\n" "$(elapsed_time)" >&2
    echo "" >&2

    # Remove scan directory if empty
    if [[ -d "$SCAN_PATH" ]] && [[ -z "$(ls -A "$SCAN_PATH" 2>/dev/null)" ]]; then
        rmdir "$SCAN_PATH" 2>/dev/null && log_info "Removed empty directory: $SCAN_PATH" || true
    fi
}

# =============================================================================
# MAIN
# =============================================================================
main() {
    neon_header

    neon_section "Configuration"
    neon_box_start
    neon_box_kv "Scan path" "$SCAN_PATH"
    [[ -n "$FILTER_ACCOUNT" ]] && neon_box_kv "Account" "$FILTER_ACCOUNT"
    [[ -n "$FILTER_HOST" ]] && neon_box_kv "Host" "$FILTER_HOST"
    neon_box_kv "Local only" "$( [[ "$LOCAL_ONLY" == true ]] && echo "yes" || echo "no" )"
    neon_box_kv "Dry run" "$( [[ "$DRY_RUN" == true ]] && echo "yes" || echo "no" )"
    neon_box_end

    # Check gh CLI (unless local-only)
    if [[ "$LOCAL_ONLY" != true ]]; then
        if ! command -v gh &> /dev/null; then
            log_error "GitHub CLI (gh) is not installed"
            printf "      ${C_DIM}Install: brew install gh${C_RESET}\n" >&2
            exit 1
        fi
    fi

    scan_repos
    display_repos
    confirm_delete
    delete_repos
}

main
