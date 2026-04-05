#!/usr/bin/env zsh
#
# bulk-run-demo.zsh
# Creates demo repos from a template, clones them, and runs Claude Code
# with a specified prompt inside each one.
#
# Variables (via CLI args or env vars):
#   - -t, --template - Template number or ORG/REPO (interactive if omitted)
#   - -c, --count - Number of repos to create (default: 3)
#   - -x, --execute - Claude prompt (inline string)
#   - --prompt-file - Read prompt from file (takes precedence over -x)
#   - -p, --path - Clone directory (default: /workspace/demo-runs)
#   - --parallel - Max concurrent sessions, 0=sequential (default: 3)
#   - -a, --account - Target GitHub account
#   - -h, --host - GitHub hostname
#   - -n, --name - Base repo name (auto-derived from template)
#   - -v, --visibility - public/private (default: public)
#   - --dry-run - Show plan without executing
#   - --cleanup - Delete repos after execution
#   - --help - Show help

#   Usage examples:
#   # Dry run with template #1
#   ./bulk-run-demo.zsh -t 1 -c 3 -x '/help' --dry-run
#
#   # Sequential run
#   ./bulk-run-demo.zsh -t 1 -c 2 -x 'echo hello' --parallel 0
#
#   # Parallel run with prompt file
#   ./bulk-run-demo.zsh -t 1 -c 3 --prompt-file prompt.txt --parallel 2

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
    printf "  ${C_CYAN}│${C_RESET}   ${C_PINK}░▒▓${C_RESET} ${C_WHITE}${C_BOLD}B U L K   R U N   D E M O${C_RESET}          ${C_PINK}▓▒░${C_RESET}   ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}   ${C_DIM}${C_ITALIC}  create · clone · run claude — automated${C_RESET}      ${C_CYAN}│${C_RESET}\n" >&2
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

format_duration() {
    local secs="$1"
    local mins=$((secs / 60))
    local remainder=$((secs % 60))
    if (( mins > 0 )); then
        printf "%dm %02ds" "$mins" "$remainder"
    else
        printf "%ds" "$remainder"
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
# CONFIGURATION
# =============================================================================
GITHUB_HOST="${GITHUB_HOST:-github.com}"
GITHUB_ACCOUNT="${GITHUB_ACCOUNT:-}"
CLONE_BASE_PATH="${CLONE_BASE_PATH:-/workspace/demo-runs}"
REPO_COUNT="${REPO_COUNT:-3}"
REPO_VISIBILITY="${REPO_VISIBILITY:-public}"
PARALLEL_MAX="${PARALLEL_MAX:-3}"
CLAUDE_PROMPT=""
PROMPT_FILE=""
PROMPT_DIR=""
PROMPT_GLOB="*.md"
typeset -A REPO_PROMPT_MAP     # repo_name -> prompt content
typeset -A REPO_PROMPT_LABEL   # repo_name -> prompt filename
typeset -a PROMPT_DIR_FILES=() # ordered list of prompt file paths
DRY_RUN=false
DO_CLEANUP=false

# Template list — driven by DEMO_REPO_TEMPLATES env var
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

# Destination
DEST_HOST=""
DEST_ACCOUNT=""

# Known targets — driven by DEMO_REPO_TARGETS env var
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
# TEMPLATE SELECTION (reused from create-demo-repos.zsh)
# =============================================================================
derive_base_name() {
    local template="$1"
    echo "${template%-template}-demo"
}

parse_template_entry() {
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
    if [[ -n "$TEMPLATE_ORG" && -n "$TEMPLATE_REPO" ]]; then
        return
    fi
    interactive_menu "Select a template" "${TEMPLATES[@]}"
    local selection=$MENU_RESULT
    parse_template_entry "${TEMPLATES[$selection]}"
}

resolve_base_name() {
    if [[ -z "$REPO_BASE_NAME" ]]; then
        REPO_BASE_NAME=$(derive_base_name "$TEMPLATE_REPO")
    fi
}

select_destination() {
    DEST_HOST="${DEST_HOST:-$GITHUB_HOST}"
    DEST_ACCOUNT="${DEST_ACCOUNT:-$GITHUB_ACCOUNT}"

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
# USAGE
# =============================================================================
usage() {
    echo "" >&2
    printf "  ${C_CYAN}╭──────────────────────────────────────────────────────╮${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}   ${C_PINK}░▒▓${C_RESET} ${C_WHITE}${C_BOLD}B U L K   R U N   D E M O${C_RESET}          ${C_PINK}▓▒░${C_RESET}   ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}╰──────────────────────────────────────────────────────╯${C_RESET}\n" >&2
    echo "" >&2
    printf "  ${C_DIM}Creates demo repos, clones them, and runs Claude Code${C_RESET}\n" >&2
    printf "  ${C_DIM}with a prompt inside each one.${C_RESET}\n" >&2
    echo "" >&2
    printf "  ${C_PURPLE}${C_BOLD}Usage${C_RESET}  ${C_WHITE}$0 ${C_DIM}[OPTIONS]${C_RESET}\n" >&2
    echo "" >&2
    printf "  ${C_CYAN}▎${C_RESET} ${C_PURPLE}${C_BOLD}Options${C_RESET}\n" >&2
    echo "" >&2
    printf "    ${C_CYAN}-t${C_RESET}, ${C_CYAN}--template${C_RESET} ${C_DIM}NUM|ORG/REPO${C_RESET}  Template selection\n" >&2
    printf "    ${C_CYAN}-c${C_RESET}, ${C_CYAN}--count${C_RESET} ${C_DIM}N${C_RESET}                Number of repos ${C_DIMMER}(default: ${REPO_COUNT})${C_RESET}\n" >&2
    printf "    ${C_CYAN}-x${C_RESET}, ${C_CYAN}--execute${C_RESET} ${C_DIM}PROMPT${C_RESET}          Claude prompt (inline string)\n" >&2
    printf "    ${C_CYAN}--prompt-file${C_RESET} ${C_DIM}FILE${C_RESET}            Read prompt from file\n" >&2
    printf "    ${C_CYAN}--prompt-dir${C_RESET} ${C_DIM}DIR${C_RESET}              Dir of prompt files (one repo per file)\n" >&2
    printf "    ${C_CYAN}--prompt-glob${C_RESET} ${C_DIM}PATTERN${C_RESET}         Glob filter for prompt-dir ${C_DIMMER}(default: ${PROMPT_GLOB})${C_RESET}\n" >&2
    printf "    ${C_CYAN}-p${C_RESET}, ${C_CYAN}--path${C_RESET} ${C_DIM}PATH${C_RESET}               Clone directory ${C_DIMMER}(default: ${CLONE_BASE_PATH})${C_RESET}\n" >&2
    printf "    ${C_CYAN}--parallel${C_RESET} ${C_DIM}N${C_RESET}                 Max concurrent sessions ${C_DIMMER}(default: ${PARALLEL_MAX}, 0=sequential)${C_RESET}\n" >&2
    printf "    ${C_CYAN}-a${C_RESET}, ${C_CYAN}--account${C_RESET} ${C_DIM}NAME${C_RESET}            Target account ${C_DIMMER}(default: first DEMO_REPO_TARGETS entry)${C_RESET}\n" >&2
    printf "    ${C_CYAN}-h${C_RESET}, ${C_CYAN}--host${C_RESET} ${C_DIM}HOST${C_RESET}               GHE hostname ${C_DIMMER}(default: first DEMO_REPO_TARGETS entry)${C_RESET}\n" >&2
    printf "    ${C_CYAN}-n${C_RESET}, ${C_CYAN}--name${C_RESET} ${C_DIM}BASE_NAME${C_RESET}          Base repo name ${C_DIMMER}(auto-derived from template)${C_RESET}\n" >&2
    printf "    ${C_CYAN}-v${C_RESET}, ${C_CYAN}--visibility${C_RESET} ${C_DIM}TYPE${C_RESET}          public/private ${C_DIMMER}(default: ${REPO_VISIBILITY})${C_RESET}\n" >&2
    printf "    ${C_CYAN}--dry-run${C_RESET}                     Show plan without executing\n" >&2
    printf "    ${C_CYAN}--cleanup${C_RESET}                     Delete repos after execution\n" >&2
    printf "    ${C_CYAN}--help${C_RESET}                        Show this help\n" >&2
    echo "" >&2
    printf "  ${C_CYAN}▎${C_RESET} ${C_PURPLE}${C_BOLD}Templates${C_RESET}\n" >&2
    echo "" >&2
    for i in {1..${#TEMPLATES[@]}}; do
        printf "    ${C_PINK}%d${C_RESET}${C_DIMMER})${C_RESET} ${C_WHITE}%s${C_RESET}\n" "$i" "${TEMPLATES[$i]}" >&2
    done
    echo "" >&2
    printf "  ${C_CYAN}▎${C_RESET} ${C_PURPLE}${C_BOLD}Examples${C_RESET}\n" >&2
    echo "" >&2
    printf "    ${C_DIM}\$${C_RESET} ${C_WHITE}$0 ${C_CYAN}-t${C_RESET} ${C_WHITE}1 ${C_CYAN}-c${C_RESET} ${C_WHITE}3 ${C_CYAN}-x${C_RESET} ${C_WHITE}'/help' ${C_CYAN}--dry-run${C_RESET}\n" >&2
    printf "    ${C_DIM}\$${C_RESET} ${C_WHITE}$0 ${C_CYAN}-t${C_RESET} ${C_WHITE}1 ${C_CYAN}-c${C_RESET} ${C_WHITE}2 ${C_CYAN}-x${C_RESET} ${C_WHITE}'echo hello' ${C_CYAN}--parallel${C_RESET} ${C_WHITE}0${C_RESET}\n" >&2
    printf "    ${C_DIM}\$${C_RESET} ${C_WHITE}$0 ${C_CYAN}-t${C_RESET} ${C_WHITE}1 ${C_CYAN}-c${C_RESET} ${C_WHITE}3 ${C_CYAN}--prompt-file${C_RESET} ${C_WHITE}prompt.txt ${C_CYAN}--parallel${C_RESET} ${C_WHITE}2${C_RESET}\n" >&2
    printf "    ${C_DIM}\$${C_RESET} ${C_WHITE}$0 ${C_CYAN}-t${C_RESET} ${C_WHITE}2 ${C_CYAN}-c${C_RESET} ${C_WHITE}5 ${C_CYAN}-x${C_RESET} ${C_WHITE}'/help' ${C_CYAN}--cleanup${C_RESET}\n" >&2
    printf "    ${C_DIM}\$${C_RESET} ${C_WHITE}$0 ${C_CYAN}-t${C_RESET} ${C_WHITE}1 ${C_CYAN}--prompt-dir${C_RESET} ${C_WHITE}./prompts ${C_CYAN}--parallel${C_RESET} ${C_WHITE}3${C_RESET}\n" >&2
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
                if (( $2 < 1 || $2 > ${#TEMPLATES[@]} )); then
                    echo "Error: Template number $2 out of range (1-${#TEMPLATES[@]})"
                    exit 1
                fi
                parse_template_entry "${TEMPLATES[$2]}"
            else
                parse_template_entry "$2"
            fi
            shift 2
            ;;
        -v|--visibility)
            REPO_VISIBILITY="$2"
            shift 2
            ;;
        -x|--execute)
            CLAUDE_PROMPT="$2"
            shift 2
            ;;
        --prompt-file)
            PROMPT_FILE="$2"
            shift 2
            ;;
        --parallel)
            PARALLEL_MAX="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --prompt-dir)
            PROMPT_DIR="$2"
            shift 2
            ;;
        --prompt-glob)
            PROMPT_GLOB="$2"
            shift 2
            ;;
        --cleanup)
            DO_CLEANUP=true
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
# PROMPT RESOLUTION
# =============================================================================
resolve_prompt() {
    # --prompt-dir takes highest precedence
    if [[ -n "$PROMPT_DIR" ]]; then
        if [[ ! -d "$PROMPT_DIR" ]]; then
            log_error "Prompt directory not found: $PROMPT_DIR"
            exit 1
        fi
        eval "PROMPT_DIR_FILES=( ${PROMPT_DIR}/${PROMPT_GLOB}(N) )"
        if (( ${#PROMPT_DIR_FILES[@]} == 0 )); then
            log_error "No files matching '$PROMPT_GLOB' in $PROMPT_DIR"
            exit 1
        fi
        PROMPT_DIR_FILES=( ${(o)PROMPT_DIR_FILES} )
        REPO_COUNT=${#PROMPT_DIR_FILES[@]}
        log_success "Prompt dir: $PROMPT_DIR ($REPO_COUNT files matching '$PROMPT_GLOB')"
        for f in "${PROMPT_DIR_FILES[@]}"; do
            log_info "  ${f:t}"
        done
        return
    fi

    # --prompt-file takes precedence over -x
    if [[ -n "$PROMPT_FILE" ]]; then
        if [[ ! -f "$PROMPT_FILE" ]]; then
            log_error "Prompt file not found: $PROMPT_FILE"
            exit 1
        fi
        CLAUDE_PROMPT=$(<"$PROMPT_FILE")
        log_success "Prompt loaded from file: $PROMPT_FILE (${#CLAUDE_PROMPT} chars)"
        return
    fi

    if [[ -z "$CLAUDE_PROMPT" ]]; then
        log_error "No prompt specified. Use -x 'prompt' or --prompt-file FILE"
        exit 1
    fi
    log_success "Using inline prompt (${#CLAUDE_PROMPT} chars)"
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

    # Check claude CLI is installed
    if ! command -v claude &> /dev/null; then
        log_error "Claude CLI is not installed"
        printf "      ${C_DIM}Install: npm install -g @anthropic-ai/claude-code${C_RESET}\n" >&2
        exit 1
    fi
    log_success "Claude CLI found"

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

    local repos
    repos=$(NO_COLOR=1 GH_HOST="$DEST_HOST" gh repo list "$DEST_ACCOUNT" \
        --json name \
        --jq '.[].name' \
        --limit 1000 2>/dev/null | grep -E "^${base_name}[0-9]+$" || true)

    if [[ -n "$repos" ]]; then
        while IFS= read -r repo; do
            [[ -z "$repo" ]] && continue
            local num="${repo#$base_name}"
            num="${num//[^0-9]/}"
            [[ -z "$num" ]] && continue
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
# REPO CREATION (adapted to use subshell for cd)
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
    spin_stop "Template cloned"

    # Configure branches and push (in subshell to avoid changing main script's cwd)
    (
        cd "$local_path"

        # Fetch all remote branches and create local tracking branches
        for branch in $(git branch -r | grep -v '\->' | grep -v 'HEAD' | sed 's/origin\///'); do
            if [[ "$branch" != "main" && "$branch" != "master" ]]; then
                git branch --track "$branch" "origin/$branch" 2>/dev/null || true
            fi
        done

        # Update remote to point to new repo
        git remote set-url origin "$new_repo_url"

        # Push all branches and tags to new repo
        git push --all origin 2>/dev/null
        git push --tags origin 2>/dev/null
    )
    log_success "Pushed to ${repo_full}"

    echo "" >&2
    printf "    ${C_GREEN}${C_BOLD}✔ Done${C_RESET}  ${C_CYAN}%s${C_RESET} ${C_DIMMER}→${C_RESET} ${C_DIM}%s${C_RESET}\n" "$repo_full" "$local_path" >&2
}

# =============================================================================
# CLAUDE EXECUTION — SEQUENTIAL
# =============================================================================
run_claude_sequential() {
    local -a repo_names=("$@")

    neon_section "Running Claude — Sequential"

    for repo_name in "${repo_names[@]}"; do
        local local_path="$CLONE_BASE_PATH/$repo_name"
        local log_file="$local_path/.claude-run.log"
        local start_ts=$EPOCHSECONDS

        log_info "Running in ${C_WHITE}$repo_name${C_RESET}..."

        local prompt
        if [[ -n "$PROMPT_DIR" ]]; then
            prompt="${REPO_PROMPT_MAP[$repo_name]}"
        else
            prompt="$CLAUDE_PROMPT"
        fi

        (
            cd "$local_path"
            claude -p "$prompt" --dangerously-skip-permissions 2>&1 | tee .claude-run.log
        )
        local exit_code=$?

        local end_ts=$EPOCHSECONDS
        local duration=$((end_ts - start_ts))

        if (( exit_code == 0 )); then
            RESULTS+=("$repo_name|pass|$duration|$log_file")
            log_success "$repo_name completed in $(format_duration $duration)"
        else
            RESULTS+=("$repo_name|fail|$duration|$log_file")
            log_error "$repo_name failed (exit $exit_code) in $(format_duration $duration)"
        fi
    done
}

# =============================================================================
# CLAUDE EXECUTION — PARALLEL
# =============================================================================
run_claude_parallel() {
    local -a repo_names=("$@")
    local max_jobs=$PARALLEL_MAX

    neon_section "Running Claude — Parallel (max $max_jobs)"

    # Associative arrays for PID tracking
    typeset -A pid_to_repo
    typeset -A pid_to_start
    local running=0

    for repo_name in "${repo_names[@]}"; do
        local local_path="$CLONE_BASE_PATH/$repo_name"
        local log_file="$local_path/.claude-run.log"

        # Throttle: wait for a slot if at max capacity
        while (( running >= max_jobs )); do
            # Wait for any child to finish
            wait -n 2>/dev/null || true

            # Check all tracked PIDs to find which one finished
            for pid in ${(k)pid_to_repo}; do
                if ! kill -0 "$pid" 2>/dev/null; then
                    # Process finished — collect result
                    wait "$pid" 2>/dev/null
                    local exit_code=$?
                    local finished_repo="${pid_to_repo[$pid]}"
                    local start_ts="${pid_to_start[$pid]}"
                    local duration=$((EPOCHSECONDS - start_ts))
                    local finished_log="$CLONE_BASE_PATH/$finished_repo/.claude-run.log"

                    if (( exit_code == 0 )); then
                        RESULTS+=("$finished_repo|pass|$duration|$finished_log")
                        log_success "$finished_repo completed in $(format_duration $duration)"
                    else
                        RESULTS+=("$finished_repo|fail|$duration|$finished_log")
                        log_error "$finished_repo failed (exit $exit_code) in $(format_duration $duration)"
                    fi

                    unset "pid_to_repo[$pid]"
                    unset "pid_to_start[$pid]"
                    running=$((running - 1))
                fi
            done
        done

        # Launch background claude process
        local prompt
        if [[ -n "$PROMPT_DIR" ]]; then
            prompt="${REPO_PROMPT_MAP[$repo_name]}"
        else
            prompt="$CLAUDE_PROMPT"
        fi

        log_info "Starting ${C_WHITE}$repo_name${C_RESET}..."
        (
            cd "$local_path"
            claude -p "$prompt" --dangerously-skip-permissions > .claude-run.log 2>&1
        ) &
        local bg_pid=$!
        pid_to_repo[$bg_pid]="$repo_name"
        pid_to_start[$bg_pid]=$EPOCHSECONDS
        running=$((running + 1))
    done

    # Wait for remaining jobs
    log_info "Waiting for remaining jobs to finish..."
    for pid in ${(k)pid_to_repo}; do
        wait "$pid" 2>/dev/null
        local exit_code=$?
        local finished_repo="${pid_to_repo[$pid]}"
        local start_ts="${pid_to_start[$pid]}"
        local duration=$((EPOCHSECONDS - start_ts))
        local finished_log="$CLONE_BASE_PATH/$finished_repo/.claude-run.log"

        if (( exit_code == 0 )); then
            RESULTS+=("$finished_repo|pass|$duration|$finished_log")
            log_success "$finished_repo completed in $(format_duration $duration)"
        else
            RESULTS+=("$finished_repo|fail|$duration|$finished_log")
            log_error "$finished_repo failed (exit $exit_code) in $(format_duration $duration)"
        fi
    done
}

# =============================================================================
# SUMMARY TABLE
# =============================================================================
render_summary() {
    local -a results=("$@")
    local passed=0
    local failed=0

    echo "" >&2
    printf "  ${C_CYAN}╭──────────────────────────────────────────────────────────────────────╮${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}   ${C_PINK}░▒▓${C_RESET} ${C_WHITE}${C_BOLD}Results Summary${C_RESET}                                              ${C_PINK}▓▒░${C_RESET} ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}╰──────────────────────────────────────────────────────────────────────╯${C_RESET}\n" >&2
    echo "" >&2

    # Table header
    if [[ -n "$PROMPT_DIR" ]]; then
        printf "    ${C_PURPLE}${C_BOLD}%-30s %-8s %-10s %-22s %-30s${C_RESET}\n" "REPO" "STATUS" "DURATION" "PROMPT" "LOG" >&2
        printf "    ${C_DIMMER}%-30s %-8s %-10s %-22s %-30s${C_RESET}\n" "──────────────────────────────" "────────" "──────────" "──────────────────────" "──────────────────────────────" >&2
    else
        printf "    ${C_PURPLE}${C_BOLD}%-30s %-8s %-10s %-30s${C_RESET}\n" "REPO" "STATUS" "DURATION" "LOG" >&2
        printf "    ${C_DIMMER}%-30s %-8s %-10s %-30s${C_RESET}\n" "──────────────────────────────" "────────" "──────────" "──────────────────────────────" >&2
    fi

    for entry in "${results[@]}"; do
        local repo="${entry%%|*}"
        local rest="${entry#*|}"
        local status="${rest%%|*}"
        rest="${rest#*|}"
        local duration="${rest%%|*}"
        local log_path="${rest#*|}"

        local status_color
        if [[ "$status" == "pass" ]]; then
            status_color="${C_GREEN}✔ pass${C_RESET}"
            passed=$((passed + 1))
        else
            status_color="${C_RED}✖ fail${C_RESET}"
            failed=$((failed + 1))
        fi

        if [[ -n "$PROMPT_DIR" ]]; then
            printf "    ${C_WHITE}%-30s${C_RESET} %-17s ${C_DIM}%-10s${C_RESET} ${C_CYAN}%-22s${C_RESET} ${C_DIMMER}%s${C_RESET}\n" \
                "$repo" "$status_color" "$(format_duration $duration)" "${REPO_PROMPT_LABEL[$repo]}" "$log_path" >&2
        else
            printf "    ${C_WHITE}%-30s${C_RESET} %-17s ${C_DIM}%-10s${C_RESET} ${C_DIMMER}%s${C_RESET}\n" \
                "$repo" "$status_color" "$(format_duration $duration)" "$log_path" >&2
        fi
    done

    echo "" >&2
    printf "    ${C_GREEN}${C_BOLD}%d${C_RESET} ${C_DIM}passed${C_RESET}" "$passed" >&2
    if (( failed > 0 )); then
        printf "  ${C_DIMMER}·${C_RESET}  ${C_RED}${C_BOLD}%d${C_RESET} ${C_DIM}failed${C_RESET}" "$failed" >&2
    fi
    printf "  ${C_DIMMER}·${C_RESET}  ${C_DIM}%s total elapsed${C_RESET}\n" "$(elapsed_time)" >&2
    echo "" >&2
}

# =============================================================================
# DRY RUN
# =============================================================================
show_dry_run() {
    local -a repo_names=("$@")

    neon_section "Dry Run — Planned Actions"

    log_info "Would create ${C_WHITE}${#repo_names[@]}${C_RESET} repos:"
    for i in {1..${#repo_names[@]}}; do
        local repo_name="${repo_names[$i]}"
        if [[ -n "$PROMPT_DIR" ]]; then
            printf "      ${C_DIMMER}•${C_RESET} ${C_WHITE}%s${C_RESET}  ${C_DIM}→ %s/%s${C_RESET}  ${C_CYAN}← %s${C_RESET}\n" \
                "$DEST_ACCOUNT/$repo_name" "$CLONE_BASE_PATH" "$repo_name" "${REPO_PROMPT_LABEL[$repo_name]}" >&2
        else
            printf "      ${C_DIMMER}•${C_RESET} ${C_WHITE}%s${C_RESET}  ${C_DIM}→ %s/%s${C_RESET}\n" \
                "$DEST_ACCOUNT/$repo_name" "$CLONE_BASE_PATH" "$repo_name" >&2
        fi
    done

    echo "" >&2
    log_info "Would run Claude in each repo:"
    local mode_label
    if (( PARALLEL_MAX == 0 )); then
        mode_label="sequential"
    else
        mode_label="parallel (max $PARALLEL_MAX)"
    fi
    printf "      ${C_DIMMER}•${C_RESET} ${C_DIM}Mode:${C_RESET}   ${C_WHITE}%s${C_RESET}\n" "$mode_label" >&2
    if [[ -n "$PROMPT_DIR" ]]; then
        printf "      ${C_DIMMER}•${C_RESET} ${C_DIM}Prompt:${C_RESET} ${C_WHITE}per-repo (from %s)${C_RESET}\n" "$PROMPT_DIR" >&2
    else
        printf "      ${C_DIMMER}•${C_RESET} ${C_DIM}Prompt:${C_RESET} ${C_WHITE}%s${C_RESET}\n" "${CLAUDE_PROMPT:0:80}${${CLAUDE_PROMPT[81,-1]:+...}}" >&2
    fi

    if [[ "$DO_CLEANUP" == true ]]; then
        echo "" >&2
        log_info "Would delete repos after execution (--cleanup)"
    fi

    echo "" >&2
    printf "    ${C_YELLOW}▲${C_RESET} ${C_DIM}No changes made (dry run)${C_RESET}\n" >&2
    echo "" >&2
}

# =============================================================================
# CLEANUP
# =============================================================================
cleanup_repos() {
    local -a repo_names=("$@")

    neon_section "Cleanup"

    for repo_name in "${repo_names[@]}"; do
        local repo_full="$DEST_ACCOUNT/$repo_name"
        local local_path="$CLONE_BASE_PATH/$repo_name"

        # Delete remote repo
        spin_start "Deleting remote $repo_full"
        if GH_HOST="$DEST_HOST" gh repo delete "$repo_full" --yes 2>/dev/null; then
            spin_stop "Deleted remote: $repo_full"
        else
            spin_stop_fail "Failed to delete remote: $repo_full"
        fi

        # Delete local clone
        if [[ -d "$local_path" ]]; then
            rm -rf "$local_path"
            log_success "Deleted local: $local_path"
        fi
    done

    log_success "Cleanup complete"
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

    # Resolve the prompt
    resolve_prompt

    # Display configuration
    neon_section "Configuration"
    neon_box_start
    neon_box_kv "Template" "$TEMPLATE_ORG/$TEMPLATE_REPO"
    neon_box_kv "Source host" "$TEMPLATE_HOST"
    neon_box_kv "Destination" "$DEST_ACCOUNT ($DEST_HOST)"
    neon_box_kv "Base name" "$REPO_BASE_NAME"
    neon_box_kv "Count" "$REPO_COUNT"
    neon_box_kv "Clone path" "$CLONE_BASE_PATH"
    neon_box_kv "Visibility" "$REPO_VISIBILITY"
    if (( PARALLEL_MAX == 0 )); then
        neon_box_kv "Execution" "sequential"
    else
        neon_box_kv "Execution" "parallel (max $PARALLEL_MAX)"
    fi
    if [[ -n "$PROMPT_DIR" ]]; then
        neon_box_kv "Prompt dir" "$PROMPT_DIR"
        neon_box_kv "Prompt glob" "$PROMPT_GLOB"
        neon_box_kv "Prompt files" "${#PROMPT_DIR_FILES[@]}"
    else
        neon_box_kv "Prompt" "${CLAUDE_PROMPT:0:33}"
    fi
    if [[ "$DO_CLEANUP" == true ]]; then
        neon_box_kv "Cleanup" "yes (after run)"
    fi
    neon_box_end

    # Build repo name list
    local -a REPO_NAMES=()
    local highest_existing
    highest_existing=$(find_next_available_number "$REPO_BASE_NAME")
    local start_num=$((highest_existing + 1))

    for i in $(seq 1 "$REPO_COUNT"); do
        local repo_num=$((start_num + i - 1))
        local padded=$(printf "%02d" "$repo_num")
        REPO_NAMES+=("${REPO_BASE_NAME}${padded}")
    done

    # Build per-repo prompt maps when using --prompt-dir
    if [[ -n "$PROMPT_DIR" ]]; then
        for i in $(seq 1 "$REPO_COUNT"); do
            REPO_PROMPT_MAP[${REPO_NAMES[$i]}]=$(<"${PROMPT_DIR_FILES[$i]}")
            REPO_PROMPT_LABEL[${REPO_NAMES[$i]}]="${PROMPT_DIR_FILES[$i]:t}"
        done
    fi

    # Dry run — print plan and exit
    if [[ "$DRY_RUN" == true ]]; then
        show_dry_run "${REPO_NAMES[@]}"
        exit 0
    fi

    # Pre-flight checks (after dry-run gate so dry-run doesn't require auth)
    preflight_checks

    # Create repos
    neon_section "Creating Repos"

    local created=0
    local skipped=0
    local -a CREATED_REPOS=()

    for i in $(seq 1 "$REPO_COUNT"); do
        local repo_name="${REPO_NAMES[$i]}"

        if (( REPO_COUNT > 1 )); then
            progress_bar "$i" "$REPO_COUNT"
            printf "\n" >&2
        fi

        if create_repo "$repo_name"; then
            created=$((created + 1))
            CREATED_REPOS+=("$repo_name")
        else
            skipped=$((skipped + 1))
        fi
    done

    # Clear progress bar line if it was shown
    if (( REPO_COUNT > 1 )); then
        printf "\r\e[2K" >&2
    fi

    log_success "$created repo(s) created, $skipped skipped"

    if (( created == 0 )); then
        log_warn "No repos were created — nothing to run"
        exit 0
    fi

    # Execute Claude
    typeset -a RESULTS=()

    if (( PARALLEL_MAX == 0 )); then
        run_claude_sequential "${CREATED_REPOS[@]}"
    else
        run_claude_parallel "${CREATED_REPOS[@]}"
    fi

    # Render summary table
    render_summary "${RESULTS[@]}"

    # Cleanup if requested
    if [[ "$DO_CLEANUP" == true ]]; then
        cleanup_repos "${CREATED_REPOS[@]}"
    fi

    echo "" >&2
}

main
