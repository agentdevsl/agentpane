#!/usr/bin/env zsh
#
# create-demo-repos.zsh
# Creates demo repositories from a template with all branches
#
# Variables (via CLI args or env vars):
#   - -a, --account - Target GitHub account (from DEMO_REPO_TARGETS or CLI)
#   - -n, --name - Base repo name (auto-derived from template if not set)
#   - -c, --count - Number of repos to create (default: 1)
#   - -p, --path - Local clone path (default: ~/Documents/repos)
#   - -h, --host - GitHub Enterprise host (from DEMO_REPO_TARGETS or CLI)
#   - -t, --template - Template number or ORG/REPO (interactive menu if omitted)
#   - -v, --visibility - public/private (default: public)

#   Usage examples:
#   # Create 1 repo (interactive template selection)
#   ./ai/create-demo-repos.zsh
#
#   # Use template #1 directly, no interactive prompt
#   ./ai/create-demo-repos.zsh -t 1
#
#   # Create 5 repos with template #2
#   ./ai/create-demo-repos.zsh -t 2 -c 5

#   Pre-flight checks:
#   - Verifies gh CLI is installed
#   - Checks gh authentication for target and template hosts
#   - Confirms template repo exists
#   - Creates clone directory if needed

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

# Ensure cursor visible and spinner killed on exit/interrupt
trap 'printf "\e[?25h"; [[ -n "$_SPIN_PID" ]] && kill "$_SPIN_PID" 2>/dev/null' EXIT INT TERM

# ─── Theme Drawing Functions ──────────────────────────────────────────────────

neon_line() {
    printf "  ${C_DIMMER}┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄${C_RESET}\n" >&2
}

neon_header() {
    echo "" >&2
    printf "  ${C_CYAN}╭──────────────────────────────────────────────────────╮${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}                                                      ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}   ${C_PINK}░▒▓${C_RESET} ${C_WHITE}${C_BOLD}D E M O   R E P O   C R E A T O R${C_RESET} ${C_PINK}▓▒░${C_RESET}   ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}   ${C_DIM}${C_ITALIC}    clone · branch · push — automated${C_RESET}        ${C_CYAN}│${C_RESET}\n" >&2
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

neon_kv() {
    local key="$1" val="$2"
    printf "    ${C_DIM}%-14s${C_RESET} ${C_WHITE}%s${C_RESET}\n" "$key" "$val" >&2
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

# ─── Spinner for Long Operations ─────────────────────────────────────────────
# Usage: spin_start "message" ; <command> ; spin_stop

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

# ─── Progress Bar for Multi-Repo Creation ────────────────────────────────────

progress_bar() {
    local current="$1" total="$2" width=30
    local filled=$((current * width / total))
    local empty=$((width - filled))
    local pct=$((current * 100 / total))
    local bar=""
    for _ in $(seq 1 $filled); do bar+="█"; done
    for _ in $(seq 1 $empty); do bar+="░"; done
    printf "\r    ${C_PURPLE}%s${C_RESET} ${C_DIM}%3d%%${C_RESET} ${C_DIM}(%d/%d)${C_RESET}  " "$bar" "$pct" "$current" "$total" >&2
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
        printf "  ${C_CYAN}▎${C_RESET} ${C_PURPLE}${C_BOLD}%s${C_RESET}\n" "$title" >&2
        printf "\n" >&2
        for i in {1..$total}; do
            if (( i == cur )); then
                printf "    ${C_PINK}${C_BOLD}› ${C_WHITE}%s${C_RESET}\n" "${items[$i]}" >&2
            else
                printf "    ${C_DIMMER}  %s${C_RESET}\n" "${items[$i]}" >&2
            fi
        done
        printf "\n" >&2
        printf "    ${C_DIMMER}↑↓ navigate  ⏎ select${C_RESET}\n" >&2
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
    printf "\n    ${C_GREEN}✔${C_RESET} ${C_DIM}%s →${C_RESET} ${C_WHITE}%s${C_RESET}\n" "$title" "${items[$cur]}" >&2

    MENU_RESULT=$cur
}

# =============================================================================
# CONFIGURATION - Modify these defaults as needed
# =============================================================================
# Env vars:
#   DEMO_REPO_TARGETS    — comma-separated targets: ACCOUNT (defaults to github.com) or HOST::ACCOUNT
#   DEMO_REPO_TEMPLATES  — comma-separated template entries (ORG/REPO or HOST::ORG/REPO)
GITHUB_HOST="${GITHUB_HOST:-github.com}"
GITHUB_ACCOUNT="${GITHUB_ACCOUNT:-}"
CLONE_BASE_PATH="${CLONE_BASE_PATH:-$HOME/Documents/repos}"
REPO_COUNT="${REPO_COUNT:-1}"
REPO_VISIBILITY="${REPO_VISIBILITY:-public}"

# Template list — driven by DEMO_REPO_TEMPLATES env var
# Format: "ORG/REPO" (uses GITHUB_HOST) or "HOST::ORG/REPO" (explicit host)
TEMPLATES=()
if [[ -n "$DEMO_REPO_TEMPLATES" ]]; then
    IFS=',' read -rA TEMPLATES <<< "$DEMO_REPO_TEMPLATES"
else
    printf "\n  ${C_RED}✖${C_RESET} ${C_WHITE}DEMO_REPO_TEMPLATES${C_RESET} env var is not set.\n" >&2
    printf "    ${C_DIM}Run: ./setup-demo-env.zsh${C_RESET}\n\n" >&2
    exit 1
fi

# These get set by template selection (or -t flag)
TEMPLATE_HOST=""
TEMPLATE_ORG=""
TEMPLATE_REPO=""
REPO_BASE_NAME=""

# Destination - defaults to GITHUB_HOST/GITHUB_ACCOUNT, can be changed by select_destination()
DEST_HOST=""
DEST_ACCOUNT=""

# Known targets — driven by DEMO_REPO_TARGETS env var (shared with delete script)
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
    printf "\n  ${C_RED}✖${C_RESET} ${C_WHITE}DEMO_REPO_TARGETS${C_RESET} env var is not set.\n" >&2
    printf "    ${C_DIM}Run: ./setup-demo-env.zsh${C_RESET}\n\n" >&2
    exit 1
fi

# Derive GITHUB_ACCOUNT from first target if not set via env/CLI
if [[ -z "$GITHUB_ACCOUNT" ]]; then
    GITHUB_ACCOUNT="${KNOWN_TARGETS[1]#*::}"
fi

# =============================================================================
# USAGE
# =============================================================================
usage() {
    echo "" >&2
    printf "  ${C_CYAN}╭──────────────────────────────────────────────────────╮${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}   ${C_PINK}░▒▓${C_RESET} ${C_WHITE}${C_BOLD}D E M O   R E P O   C R E A T O R${C_RESET} ${C_PINK}▓▒░${C_RESET}   ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}╰──────────────────────────────────────────────────────╯${C_RESET}\n" >&2
    echo "" >&2
    printf "  ${C_DIM}Creates demo repos from a template with all branches.${C_RESET}\n" >&2
    printf "  ${C_DIM}If no template is specified, an interactive menu is shown.${C_RESET}\n" >&2
    echo "" >&2
    printf "  ${C_PURPLE}${C_BOLD}Usage${C_RESET}  ${C_WHITE}$0 ${C_DIM}[OPTIONS]${C_RESET}\n" >&2
    echo "" >&2
    printf "  ${C_CYAN}▎${C_RESET} ${C_PURPLE}${C_BOLD}Options${C_RESET}\n" >&2
    echo "" >&2
    printf "    ${C_CYAN}-a${C_RESET}, ${C_CYAN}--account${C_RESET} ${C_DIM}NAME${C_RESET}          Target account ${C_DIMMER}(default: first DEMO_REPO_TARGETS entry)${C_RESET}\n" >&2
    printf "    ${C_CYAN}-n${C_RESET}, ${C_CYAN}--name${C_RESET} ${C_DIM}BASE_NAME${C_RESET}        Base repo name ${C_DIMMER}(auto-derived from template)${C_RESET}\n" >&2
    printf "    ${C_CYAN}-c${C_RESET}, ${C_CYAN}--count${C_RESET} ${C_DIM}NUMBER${C_RESET}          Number of repos ${C_DIMMER}(default: ${REPO_COUNT})${C_RESET}\n" >&2
    printf "    ${C_CYAN}-p${C_RESET}, ${C_CYAN}--path${C_RESET} ${C_DIM}PATH${C_RESET}             Clone location ${C_DIMMER}(default: ${CLONE_BASE_PATH})${C_RESET}\n" >&2
    printf "    ${C_CYAN}-h${C_RESET}, ${C_CYAN}--host${C_RESET} ${C_DIM}HOST${C_RESET}             GHE hostname ${C_DIMMER}(default: first DEMO_REPO_TARGETS entry)${C_RESET}\n" >&2
    printf "    ${C_CYAN}-t${C_RESET}, ${C_CYAN}--template${C_RESET} ${C_DIM}NUM|ORG/REPO${C_RESET}  Template selection\n" >&2
    printf "    ${C_CYAN}-v${C_RESET}, ${C_CYAN}--visibility${C_RESET} ${C_DIM}TYPE${C_RESET}        public/private ${C_DIMMER}(default: ${REPO_VISIBILITY})${C_RESET}\n" >&2
    printf "    ${C_CYAN}--help${C_RESET}                       Show this help\n" >&2
    echo "" >&2
    printf "  ${C_CYAN}▎${C_RESET} ${C_PURPLE}${C_BOLD}Templates${C_RESET}\n" >&2
    echo "" >&2
    for i in {1..${#TEMPLATES[@]}}; do
        printf "    ${C_PINK}%d${C_RESET}${C_DIMMER})${C_RESET} ${C_WHITE}%s${C_RESET}\n" "$i" "${TEMPLATES[$i]}" >&2
    done
    echo "" >&2
    printf "  ${C_CYAN}▎${C_RESET} ${C_PURPLE}${C_BOLD}Examples${C_RESET}\n" >&2
    echo "" >&2
    printf "    ${C_DIM}\$${C_RESET} ${C_WHITE}$0${C_RESET}                    ${C_DIMMER}# interactive mode${C_RESET}\n" >&2
    printf "    ${C_DIM}\$${C_RESET} ${C_WHITE}$0 ${C_CYAN}-t${C_RESET} ${C_WHITE}1${C_RESET}                ${C_DIMMER}# use template #1${C_RESET}\n" >&2
    printf "    ${C_DIM}\$${C_RESET} ${C_WHITE}$0 ${C_CYAN}-t${C_RESET} ${C_WHITE}2 ${C_CYAN}-c${C_RESET} ${C_WHITE}5${C_RESET}            ${C_DIMMER}# 5 repos, template #2${C_RESET}\n" >&2
    printf "    ${C_DIM}\$${C_RESET} ${C_WHITE}$0 ${C_CYAN}-a${C_RESET} ${C_WHITE}MyOrg ${C_CYAN}-c${C_RESET} ${C_WHITE}2${C_RESET}        ${C_DIMMER}# different account${C_RESET}\n" >&2
    echo "" >&2
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
        -n|--name)
            REPO_BASE_NAME="$2"
            shift 2
            ;;
        -c|--count)
            REPO_COUNT="$2"
            shift 2
            ;;
        -p|--path)
            CLONE_BASE_PATH="$2"
            shift 2
            ;;
        -h|--host)
            GITHUB_HOST="$2"
            shift 2
            ;;
        -t|--template)
            if [[ "$2" =~ ^[0-9]+$ ]]; then
                # Numeric index into TEMPLATES array
                if (( $2 < 1 || $2 > ${#TEMPLATES[@]} )); then
                    echo "Error: Template number $2 out of range (1-${#TEMPLATES[@]})"
                    exit 1
                fi
                parse_template_entry "${TEMPLATES[$2]}"
            else
                # Direct HOST::ORG/REPO or ORG/REPO format
                parse_template_entry "$2"
            fi
            shift 2
            ;;
        -v|--visibility)
            REPO_VISIBILITY="$2"
            shift 2
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
# TEMPLATE SELECTION
# =============================================================================
derive_base_name() {
    # Converts template name to demo base name: ai-iac-consumer-template -> ai-iac-consumer-demo
    local template="$1"
    echo "${template%-template}-demo"
}

parse_template_entry() {
    # Parses "HOST::ORG/REPO" or "ORG/REPO" into TEMPLATE_HOST, TEMPLATE_ORG, TEMPLATE_REPO
    local entry="$1"
    if [[ "$entry" == *"::"* ]]; then
        TEMPLATE_HOST="${entry%%::*}"
        local org_repo="${entry#*::}"
        TEMPLATE_ORG="${org_repo%%/*}"
        TEMPLATE_REPO="${org_repo##*/}"
    else
        TEMPLATE_HOST="$GITHUB_HOST"
        TEMPLATE_ORG="${entry%%/*}"
        TEMPLATE_REPO="${entry##*/}"
    fi
}

select_template() {
    # Skip if template was already set via -t flag
    if [[ -n "$TEMPLATE_ORG" && -n "$TEMPLATE_REPO" ]]; then
        return
    fi

    interactive_menu "Select a template" "${TEMPLATES[@]}"
    local selection=$MENU_RESULT

    parse_template_entry "${TEMPLATES[$selection]}"
}

resolve_base_name() {
    # If user didn't provide -n, auto-derive from template
    if [[ -z "$REPO_BASE_NAME" ]]; then
        REPO_BASE_NAME=$(derive_base_name "$TEMPLATE_REPO")
    fi
}

select_destination() {
    # Default destination is the configured GITHUB_HOST / GITHUB_ACCOUNT
    DEST_HOST="${DEST_HOST:-$GITHUB_HOST}"
    DEST_ACCOUNT="${DEST_ACCOUNT:-$GITHUB_ACCOUNT}"

    # If template lives on a different host, offer all known targets
    if [[ "$TEMPLATE_HOST" != "$GITHUB_HOST" ]]; then
        local -a labels=()
        for entry in "${KNOWN_TARGETS[@]}"; do
            local host="${entry%%::*}"
            local account="${entry#*::}"
            labels+=("$account ($host)")
        done

        interactive_menu "Select destination for new repos" "${labels[@]}"
        local sel=$MENU_RESULT

        local chosen="${KNOWN_TARGETS[$sel]}"
        DEST_HOST="${chosen%%::*}"
        DEST_ACCOUNT="${chosen#*::}"
    fi
}

# =============================================================================
# PRE-FLIGHT CHECKS
# =============================================================================
preflight_checks() {
    neon_section "Pre-flight Checks"

    # Check gh CLI is installed
    if ! command -v gh &> /dev/null; then
        log_error "GitHub CLI (gh) is not installed"
        printf "      ${C_DIM}Install: brew install gh${C_RESET}\n" >&2
        exit 1
    fi
    log_success "GitHub CLI found"

    # Check auth for destination host
    if ! gh auth status --hostname "$DEST_HOST" &> /dev/null; then
        log_error "Not authenticated to destination host $DEST_HOST"
        echo "" >&2
        printf "      ${C_DIM}Run: gh auth login --hostname %s${C_RESET}\n" "$DEST_HOST" >&2
        echo "" >&2
        exit 1
    fi
    log_success "Authenticated to $DEST_HOST"

    # Check auth for template host if it differs from the destination
    if [[ "$TEMPLATE_HOST" != "$DEST_HOST" ]]; then
        if ! gh auth status --hostname "$TEMPLATE_HOST" &> /dev/null; then
            log_error "Not authenticated to template host $TEMPLATE_HOST"
            echo "" >&2
            printf "      ${C_DIM}Run: gh auth login --hostname %s${C_RESET}\n" "$TEMPLATE_HOST" >&2
            echo "" >&2
            exit 1
        fi
        log_success "Authenticated to template host $TEMPLATE_HOST"
    fi

    # Verify template repo exists
    if ! GH_HOST="$TEMPLATE_HOST" gh repo view "$TEMPLATE_ORG/$TEMPLATE_REPO" --json name &> /dev/null; then
        log_error "Template repo not found: $TEMPLATE_ORG/$TEMPLATE_REPO on $TEMPLATE_HOST"
        exit 1
    fi
    log_success "Template exists: $TEMPLATE_ORG/$TEMPLATE_REPO ($TEMPLATE_HOST)"

    # Check clone base path exists
    if [[ ! -d "$CLONE_BASE_PATH" ]]; then
        log_info "Creating clone directory: $CLONE_BASE_PATH"
        mkdir -p "$CLONE_BASE_PATH"
    fi
    log_success "Clone path ready"
}

# =============================================================================
# FIND NEXT AVAILABLE REPO NUMBER
# =============================================================================
find_next_available_number() {
    local base_name="$1"
    local highest=0

    log_info "Checking for existing repos matching '${base_name}*'..."

    # Query GitHub for repos matching our base name pattern
    # NO_COLOR prevents ANSI escape codes in output
    local repos
    repos=$(NO_COLOR=1 GH_HOST="$DEST_HOST" gh repo list "$DEST_ACCOUNT" \
        --json name \
        --jq '.[].name' \
        --limit 1000 2>/dev/null | grep -E "^${base_name}[0-9]+$" || true)

    if [[ -n "$repos" ]]; then
        # Extract numbers and find the highest
        while IFS= read -r repo; do
            # Skip empty lines
            [[ -z "$repo" ]] && continue
            # Extract the numeric suffix (e.g., "demo01" -> "01")
            local num="${repo#$base_name}"
            # Strip any non-digit characters (safety)
            num="${num//[^0-9]/}"
            # Skip if no number extracted
            [[ -z "$num" ]] && continue
            # Remove leading zeros for arithmetic
            num=$((10#$num))
            if (( num > highest )); then
                highest=$num
            fi
        done <<< "$repos"
        log_info "Found existing repos up to ${base_name}$(printf '%02d' $highest)"
    else
        log_info "No existing repos found matching pattern"
    fi

    echo "$highest"
}

# =============================================================================
# REPO CREATION
# =============================================================================
create_repo() {
    local repo_name="$1"
    local repo_full="$DEST_ACCOUNT/$repo_name"
    local local_path="$CLONE_BASE_PATH/$repo_name"
    local template_url="https://$TEMPLATE_HOST/$TEMPLATE_ORG/$TEMPLATE_REPO.git"
    local new_repo_url="https://$DEST_HOST/$repo_full.git"

    neon_section "Creating $repo_name"

    # Check if repo already exists on remote
    if GH_HOST="$DEST_HOST" gh repo view "$repo_full" --json name &> /dev/null 2>&1; then
        log_warn "Repo already exists on $DEST_HOST: $repo_full — skipping"
        return 1
    fi

    # Check if local directory exists
    if [[ -d "$local_path" ]]; then
        log_warn "Local directory already exists: $local_path — skipping"
        return 1
    fi

    # Create the new empty repo
    spin_start "Creating repo on $DEST_HOST"
    GH_HOST="$DEST_HOST" gh repo create "$repo_full" \
        --"$REPO_VISIBILITY" \
        --description "Demo repo created from $TEMPLATE_ORG/$TEMPLATE_REPO template"
    spin_stop "Repo created on $DEST_HOST"

    # Clone template with all branches to local
    spin_start "Cloning template"
    git clone "$template_url" "$local_path" 2>/dev/null
    cd "$local_path"
    spin_stop "Template cloned"

    # Fetch all remote branches and create local tracking branches
    spin_start "Configuring branches"
    for branch in $(git branch -r | grep -v '\->' | grep -v 'HEAD' | sed 's/origin\///'); do
        if [[ "$branch" != "main" && "$branch" != "master" ]]; then
            git branch --track "$branch" "origin/$branch" 2>/dev/null || true
        fi
    done
    spin_stop "Branches configured"

    # Update remote to point to new repo
    git remote set-url origin "$new_repo_url"

    # Push all branches and tags to new repo
    spin_start "Pushing all branches and tags"
    git push --all origin 2>/dev/null
    git push --tags origin 2>/dev/null
    spin_stop "Pushed to ${repo_full}"

    echo "" >&2
    printf "    ${C_GREEN}${C_BOLD}✔ Done${C_RESET}  ${C_CYAN}%s${C_RESET} ${C_DIMMER}→${C_RESET} ${C_DIM}%s${C_RESET}\n" "$repo_full" "$local_path" >&2
}

# =============================================================================
# MAIN
# =============================================================================
main() {
    neon_header

    # Select template (interactive arrow-key menu if -t not provided)
    select_template
    resolve_base_name

    # Choose destination (interactive if template host differs from default)
    select_destination

    neon_section "Configuration"
    neon_box_start
    neon_box_kv "Template" "$TEMPLATE_ORG/$TEMPLATE_REPO"
    neon_box_kv "Source host" "$TEMPLATE_HOST"
    neon_box_kv "Destination" "$DEST_ACCOUNT ($DEST_HOST)"
    neon_box_kv "Base name" "$REPO_BASE_NAME"
    neon_box_kv "Count" "$REPO_COUNT"
    neon_box_kv "Clone path" "$CLONE_BASE_PATH"
    neon_box_kv "Visibility" "$REPO_VISIBILITY"
    neon_box_end

    preflight_checks

    # Find the next available starting number
    local highest_existing
    highest_existing=$(find_next_available_number "$REPO_BASE_NAME")
    local start_num=$((highest_existing + 1))

    log_info "Will create repos starting from ${REPO_BASE_NAME}$(printf '%02d' $start_num)"

    local created=0
    local skipped=0
    local last_created_path=""

    for i in $(seq 1 "$REPO_COUNT"); do
        local repo_num=$((start_num + i - 1))
        local padded=$(printf "%02d" "$repo_num")
        local repo_name="${REPO_BASE_NAME}${padded}"

        if (( REPO_COUNT > 1 )); then
            progress_bar "$i" "$REPO_COUNT"
            printf "\n" >&2
        fi

        if create_repo "$repo_name"; then
            created=$((created + 1))
            last_created_path="$CLONE_BASE_PATH/$repo_name"
        else
            skipped=$((skipped + 1))
        fi
    done

    # Clear progress bar line if it was shown
    if (( REPO_COUNT > 1 )); then
        printf "\r\e[2K" >&2
    fi

    # Summary
    echo "" >&2
    printf "  ${C_CYAN}╭──────────────────────────────────────────────────────╮${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}   ${C_PINK}░▒▓${C_RESET} ${C_WHITE}${C_BOLD}Complete${C_RESET}                                     ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}╰──────────────────────────────────────────────────────╯${C_RESET}\n" >&2
    echo "" >&2
    printf "    ${C_GREEN}${C_BOLD}%d${C_RESET} ${C_DIM}created${C_RESET}" "$created" >&2
    if (( skipped > 0 )); then
        printf "  ${C_DIMMER}·${C_RESET}  ${C_YELLOW}${C_BOLD}%d${C_RESET} ${C_DIM}skipped${C_RESET}" "$skipped" >&2
    fi
    printf "  ${C_DIMMER}·${C_RESET}  ${C_DIM}%s elapsed${C_RESET}\n" "$(elapsed_time)" >&2
    echo "" >&2

    # Offer to open in VS Code (interactive menu if exactly 1 repo was created)
    if [[ "$created" -eq 1 && -n "$last_created_path" ]]; then
        interactive_menu "Open in VS Code?" \
            "Yes, open ${last_created_path##*/}" \
            "No thanks"

        if [[ $MENU_RESULT -eq 1 ]]; then
            log_info "Opening in VS Code..."
            code "$last_created_path"
        fi
    fi

    echo "" >&2
}

main
