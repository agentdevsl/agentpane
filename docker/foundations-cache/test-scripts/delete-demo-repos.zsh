#!/usr/bin/env zsh
#
# delete-demo-repos.zsh
# Deletes demo repositories locally and remotely
#
# Usage examples:
#   # Delete specific repos by name
#   ./delete-demo-repos.zsh ai-iac-consumer-demo01 ai-iac-consumer-demo02
#
#   # Delete a range using brace expansion
#   ./delete-demo-repos.zsh ai-iac-consumer-demo{01..05}
#
#   # Delete from a file (one repo name per line)
#   ./delete-demo-repos.zsh -f repos-to-delete.txt
#
#   # Dry run (show what would be deleted without doing it)
#   ./delete-demo-repos.zsh --dry-run ai-iac-consumer-demo01

set -e

# =============================================================================
#「 ネオン 」 JAPAN NEON THEME
# =============================================================================
typeset -r C_PINK="\033[38;5;198m"
typeset -r C_CYAN="\033[38;5;51m"
typeset -r C_PURPLE="\033[38;5;141m"
typeset -r C_GREEN="\033[38;5;49m"
typeset -r C_RED="\033[38;5;197m"
typeset -r C_YELLOW="\033[38;5;220m"
typeset -r C_WHITE="\033[1;37m"
typeset -r C_DIM="\033[38;5;242m"
typeset -r C_BOLD="\033[1m"
typeset -r C_RESET="\033[0m"

# Ensure cursor is always visible on exit/interrupt
trap 'printf "\e[?25h"' EXIT INT TERM

# ─── Theme Drawing Functions ──────────────────────────────────────────────────

neon_line() {
    printf "  ${C_CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}\n" >&2
}

neon_header() {
    local title="$1"
    echo "" >&2
    neon_line
    printf "  ${C_PINK}${C_BOLD}   ✦  %s  ✦${C_RESET}\n" "$title" >&2
    printf "  ${C_PURPLE}                 「 ネオン 」${C_RESET}\n" >&2
    neon_line
    echo "" >&2
}

neon_section() {
    local title="$1"
    local dashes=$(( 46 - ${#title} ))
    [[ $dashes -lt 4 ]] && dashes=4
    printf "\n  ${C_CYAN}──${C_RESET} ${C_PURPLE}${C_BOLD}%s${C_RESET} ${C_CYAN}%s${C_RESET}\n\n" "$title" "$(printf '─%.0s' {1..$dashes})" >&2
}

neon_kv() {
    local key="$1" val="$2"
    printf "    ${C_PURPLE}%-14s${C_RESET} ${C_WHITE}%s${C_RESET}\n" "$key" "$val" >&2
}

log_info() {
    printf "    ${C_CYAN}▸${C_RESET} %s\n" "$1" >&2
}

log_success() {
    printf "    ${C_GREEN}✓${C_RESET} %s\n" "$1" >&2
}

log_error() {
    printf "    ${C_RED}✗${C_RESET} %s\n" "$1" >&2
}

log_warn() {
    printf "    ${C_YELLOW}▲${C_RESET} %s\n" "$1" >&2
}

log_dry() {
    printf "    ${C_PURPLE}◇${C_RESET} ${C_DIM}%s${C_RESET}\n" "$1" >&2
}

# ─── Interactive Arrow-Key Menu ───────────────────────────────────────────────
# Usage: interactive_menu "Title" "Option 1" "Option 2" ...
# Sets MENU_RESULT to the 1-based index of the selected item

interactive_menu() {
    local title="$1"
    shift
    local -a items=("$@")
    local cur=1
    local total=${#items[@]}

    # Fallback for non-interactive (piped) input
    if [[ ! -t 0 ]]; then
        printf "%s\n" "$title" >&2
        for i in {1..$total}; do
            printf "  %d) %s\n" "$i" "${items[$i]}" >&2
        done
        printf "Selection: " >&2
        read sel
        MENU_RESULT=$sel
        return
    fi

    printf '\e[?25l' >&2  # hide cursor

    _neon_render_menu() {
        printf "\n" >&2
        printf "  ${C_PURPLE}${C_BOLD}%s${C_RESET}\n" "$title" >&2
        printf "\n" >&2
        for i in {1..$total}; do
            if (( i == cur )); then
                printf "   ${C_PINK}❯ ${C_WHITE}%s${C_RESET}\n" "${items[$i]}" >&2
            else
                printf "   ${C_DIM}  %s${C_RESET}\n" "${items[$i]}" >&2
            fi
        done
        printf "\n" >&2
        printf "  ${C_DIM}  ↑↓ navigate · enter select${C_RESET}\n" >&2
    }

    _neon_render_menu
    local height=$((total + 5))

    while true; do
        local key=""
        read -r -s -k 1 key
        case "$key" in
            $'\e')
                local seq1="" seq2=""
                read -r -s -k 1 -t 0.1 seq1 2>/dev/null || true
                if [[ "$seq1" == "[" ]]; then
                    read -r -s -k 1 -t 0.1 seq2 2>/dev/null || true
                    case "$seq2" in
                        A) if [[ $cur -gt 1 ]]; then cur=$((cur - 1)); fi ;;
                        B) if [[ $cur -lt $total ]]; then cur=$((cur + 1)); fi ;;
                    esac
                fi
                ;;
            ''|$'\n')
                break
                ;;
        esac

        # Redraw
        printf "\e[${height}A" >&2
        for _ in {1..$height}; do printf "\e[2K\n" >&2; done
        printf "\e[${height}A" >&2
        _neon_render_menu
    done

    printf '\e[?25h' >&2  # show cursor

    # Collapse menu to a single result line
    printf "\e[${height}A" >&2
    for _ in {1..$height}; do printf "\e[2K\n" >&2; done
    printf "\e[${height}A" >&2
    printf "\n  ${C_PURPLE}%s ${C_DIM}→${C_RESET} ${C_CYAN}%s${C_RESET}\n" "$title" "${items[$cur]}" >&2

    MENU_RESULT=$cur
}

# =============================================================================
# CONFIGURATION
# =============================================================================
GITHUB_HOST="${GITHUB_HOST:-github.com}"
GITHUB_ACCOUNT=""
CLONE_BASE_PATH="${CLONE_BASE_PATH:-$HOME/Documents/repos}"
DRY_RUN=false
SKIP_CONFIRM=false
REPO_LIST=()

# Known host/account pairs — driven by DEMO_REPO_TARGETS env var
# Accepts "ACCOUNT" (defaults to github.com) or "HOST::ACCOUNT"
KNOWN_TARGETS=()
if [[ -n "$DEMO_REPO_TARGETS" ]]; then
    IFS=',' read -rA _raw_targets <<< "$DEMO_REPO_TARGETS"
    for _entry in "${_raw_targets[@]}"; do
        [[ "$_entry" != *"::"* ]] && _entry="${GITHUB_HOST}::${_entry}"
        KNOWN_TARGETS+=("$_entry")
    done
    unset _raw_targets _entry
else
    printf "\n  ${C_RED}✗${C_RESET} ${C_WHITE}DEMO_REPO_TARGETS${C_RESET} env var is not set.\n" >&2
    printf "    ${C_DIM}Run: ./setup-demo-env.zsh${C_RESET}\n\n" >&2
    exit 1
fi

# =============================================================================
# USAGE
# =============================================================================
usage() {
    cat <<EOF
Usage: $0 [OPTIONS] REPO_NAME [REPO_NAME...]

Deletes demo repositories locally and on GitHub.

Options:
    -a, --account NAME      GitHub account/org (interactive if omitted)
    -p, --path PATH         Local base path (default: $CLONE_BASE_PATH)
    -H, --host HOST         GitHub host (interactive if omitted)
    -f, --file FILE         Read repo names from file (one per line)
    -y, --yes               Skip confirmation prompt
    --dry-run               Show what would be deleted without doing it
    --help                  Show this help message

Examples:
    # Delete specific repos
    $0 ai-iac-consumer-demo01 ai-iac-consumer-demo02

    # Delete a range (zsh brace expansion)
    $0 ai-iac-consumer-demo{01..10}

    # Delete from file
    $0 -f repos-to-delete.txt

    # Dry run first
    $0 --dry-run ai-iac-consumer-demo{01..05}

    # Skip confirmation
    $0 -y ai-iac-consumer-demo01
EOF
    exit 0
}

# =============================================================================
# ARGUMENT PARSING
# =============================================================================
while [[ $# -gt 0 ]]; do
    case $1 in
        -a|--account)
            GITHUB_ACCOUNT="$2"
            shift 2
            ;;
        -p|--path)
            CLONE_BASE_PATH="$2"
            shift 2
            ;;
        -H|--host)
            GITHUB_HOST="$2"
            shift 2
            ;;
        -f|--file)
            if [[ -f "$2" ]]; then
                while IFS= read -r line; do
                    [[ -n "$line" && ! "$line" =~ ^# ]] && REPO_LIST+=("$line")
                done < "$2"
            else
                echo "Error: File not found: $2"
                exit 1
            fi
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
        --help)
            usage
            ;;
        -*)
            echo "Error: Unknown option $1"
            usage
            ;;
        *)
            REPO_LIST+=("$1")
            shift
            ;;
    esac
done

# =============================================================================
# INTERACTIVE TARGET SELECTION
# =============================================================================
select_target_interactive() {
    # Build display labels from KNOWN_TARGETS
    local -a labels=()
    for entry in "${KNOWN_TARGETS[@]}"; do
        local host="${entry%%::*}"
        local account="${entry#*::}"
        labels+=("$account ($host)")
    done

    interactive_menu "Select GitHub target" "${labels[@]}"
    local sel=$MENU_RESULT

    local chosen="${KNOWN_TARGETS[$sel]}"
    GITHUB_HOST="${chosen%%::*}"
    GITHUB_ACCOUNT="${chosen#*::}"
}

# =============================================================================
# INTERACTIVE REPO SELECTION
# =============================================================================
select_repo_interactive() {
    # Fetch repos from the account, filtering for demo-pattern names
    log_info "Fetching repos from $GITHUB_ACCOUNT on $GITHUB_HOST..."
    local repos_raw
    repos_raw=$(NO_COLOR=1 GH_HOST="$GITHUB_HOST" gh repo list "$GITHUB_ACCOUNT" \
        --json name \
        --jq '.[].name' \
        --limit 1000 2>/dev/null | grep -E "demo[0-9]*$" | sort || true)

    local -a repo_choices=()
    if [[ -n "$repos_raw" ]]; then
        while IFS= read -r name; do
            [[ -n "$name" ]] && repo_choices+=("$name")
        done <<< "$repos_raw"
    fi

    if [[ ${#repo_choices[@]} -eq 0 ]]; then
        log_warn "No demo repos found on $GITHUB_ACCOUNT — enter name manually"
        printf "\n    ${C_CYAN}▸${C_RESET} Repo name: " >&2
        read -r manual_name
        if [[ -z "$manual_name" ]]; then
            log_error "No repo name provided"
            exit 1
        fi
        REPO_LIST+=("$manual_name")
        return
    fi

    # Add manual entry option at the end
    repo_choices+=("⌨  Enter name manually")

    interactive_menu "Select a repo to delete" "${repo_choices[@]}"
    local selection=$MENU_RESULT

    if (( selection == ${#repo_choices[@]} )); then
        # Last option = manual entry
        printf "\n    ${C_CYAN}▸${C_RESET} Repo name: " >&2
        read -r manual_name
        if [[ -z "$manual_name" ]]; then
            log_error "No repo name provided"
            exit 1
        fi
        REPO_LIST+=("$manual_name")
    else
        REPO_LIST+=("${repo_choices[$selection]}")
    fi
}

# =============================================================================
# PRE-FLIGHT CHECKS
# =============================================================================
preflight_checks() {
    neon_section "Pre-flight Checks"

    # Check gh CLI
    if ! command -v gh &> /dev/null; then
        log_error "GitHub CLI (gh) is not installed"
        printf "      ${C_DIM}Install: brew install gh${C_RESET}\n" >&2
        exit 1
    fi
    log_success "GitHub CLI found"

    # If host/account not set via flags, prompt interactively
    if [[ -z "$GITHUB_HOST" || -z "$GITHUB_ACCOUNT" ]]; then
        select_target_interactive
    fi

    # Set GH_HOST for GitHub Enterprise
    export GH_HOST="$GITHUB_HOST"

    # Check authentication
    if ! gh auth status --hostname "$GITHUB_HOST" &> /dev/null; then
        log_error "Not authenticated to $GITHUB_HOST"
        printf "      ${C_DIM}Run: gh auth login --hostname %s${C_RESET}\n" "$GITHUB_HOST" >&2
        exit 1
    fi
    log_success "Authenticated to $GITHUB_HOST"

    # If no repos specified, prompt interactively
    if [[ ${#REPO_LIST[@]} -eq 0 ]]; then
        select_repo_interactive
    fi
}

# =============================================================================
# DELETE REPO
# =============================================================================
delete_repo() {
    local repo_name="$1"
    local repo_full="$GITHUB_ACCOUNT/$repo_name"
    local local_path="$CLONE_BASE_PATH/$repo_name"

    neon_section "Processing $repo_name"

    # Check and delete remote repo
    if GH_HOST="$GITHUB_HOST" gh repo view "$repo_full" --json name &> /dev/null 2>&1; then
        if [[ "$DRY_RUN" == true ]]; then
            log_dry "Would delete remote: $GITHUB_HOST/$repo_full"
        else
            log_info "Deleting remote repo..."
            if GH_HOST="$GITHUB_HOST" gh repo delete "$repo_full" --yes; then
                log_success "Deleted remote: $repo_full"
            else
                log_error "Failed to delete remote: $repo_full"
            fi
        fi
    else
        log_warn "Remote repo not found: $repo_full"
    fi

    # Check and delete local directory
    if [[ -d "$local_path" ]]; then
        if [[ "$DRY_RUN" == true ]]; then
            log_dry "Would delete local: $local_path"
        else
            log_info "Deleting local directory..."
            rm -rf "$local_path"
            log_success "Deleted local: $local_path"
        fi
    else
        log_warn "Local directory not found: $local_path"
    fi
}

# =============================================================================
# MAIN
# =============================================================================
main() {
    neon_header "D E M O   R E P O   D E L E T E R"

    preflight_checks

    neon_section "Configuration"
    neon_kv "GitHub Host" "$GITHUB_HOST"
    neon_kv "Account" "$GITHUB_ACCOUNT"
    neon_kv "Local Path" "$CLONE_BASE_PATH"
    neon_kv "Dry Run" "$DRY_RUN"

    neon_section "Repositories to Delete (${#REPO_LIST[@]})"
    for repo in "${REPO_LIST[@]}"; do
        printf "    ${C_RED}▪${C_RESET} ${C_WHITE}%s${C_RESET}\n" "$repo" >&2
    done

    # Confirmation prompt (interactive menu)
    if [[ "$DRY_RUN" == false && "$SKIP_CONFIRM" == false ]]; then
        echo "" >&2
        printf "  ${C_RED}${C_BOLD}  ⚠  This will permanently delete the above repositories!${C_RESET}\n" >&2

        interactive_menu "Confirm deletion?" \
            "No, abort" \
            "Yes, permanently delete"

        if [[ $MENU_RESULT -ne 2 ]]; then
            echo "" >&2
            log_info "Aborted."
            exit 0
        fi
    fi

    # Process each repo
    local processed=0
    for repo_name in "${REPO_LIST[@]}"; do
        delete_repo "$repo_name"
        processed=$((processed + 1))
    done

    # Summary
    echo "" >&2
    neon_line
    printf "  ${C_PINK}${C_BOLD}   ✦  Summary  ✦${C_RESET}\n" >&2
    neon_line
    neon_kv "Processed" "$processed repositories"
    if [[ "$DRY_RUN" == true ]]; then
        printf "    ${C_PURPLE}%-14s${C_RESET} ${C_DIM}%s${C_RESET}\n" "" "(dry run — no changes made)" >&2
    fi
    neon_line
    echo "" >&2
}

main
