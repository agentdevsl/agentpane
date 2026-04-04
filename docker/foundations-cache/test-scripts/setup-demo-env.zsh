#!/usr/bin/env zsh
#
# setup-demo-env.zsh
# Interactive setup for DEMO_REPO_TARGETS and DEMO_REPO_TEMPLATES env vars.
# Appends to an existing env file (deduplicating) or creates a new one.
# Optionally hooks it into ~/.zshrc.

set -e

ENV_FILE="$HOME/.demo-repos.env"

# =============================================================================
#  ░▒▓ FLUX TERMINAL THEME ▓▒░
# =============================================================================
typeset -r C_PINK="\033[38;2;255;92;138m"
typeset -r C_CYAN="\033[38;2;80;220;235m"
typeset -r C_PURPLE="\033[38;2;168;130;255m"
typeset -r C_GREEN="\033[38;2;80;250;160m"
typeset -r C_RED="\033[38;2;255;85;85m"
typeset -r C_YELLOW="\033[38;2;255;200;80m"
typeset -r C_WHITE="\033[1;37m"
typeset -r C_DIM="\033[38;5;243m"
typeset -r C_DIMMER="\033[38;5;238m"
typeset -r C_BOLD="\033[1m"
typeset -r C_RESET="\033[0m"

log_info()    { printf "    ${C_CYAN}▸${C_RESET} %s\n" "$1" >&2; }
log_success() { printf "    ${C_GREEN}✔${C_RESET} %s\n" "$1" >&2; }
log_warn()    { printf "    ${C_YELLOW}▲${C_RESET} %s\n" "$1" >&2; }

neon_header() {
    echo "" >&2
    printf "  ${C_CYAN}╭──────────────────────────────────────────────────────╮${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}                                                      ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}   ${C_PINK}░▒▓${C_RESET} ${C_WHITE}${C_BOLD}D E M O   E N V   S E T U P${C_RESET}     ${C_PINK}▓▒░${C_RESET}   ${C_CYAN}│${C_RESET}\n" >&2
    printf "  ${C_CYAN}│${C_RESET}   ${C_DIM}    configure targets & templates${C_RESET}              ${C_CYAN}│${C_RESET}\n" >&2
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

# =============================================================================
# COLLECT ENTRIES
# =============================================================================
# Collects items in a loop: prompts for input, shows running list, stops on empty input.
# Usage: collect_entries "prompt" "format hint" result_array_name
collect_entries() {
    local prompt="$1" hint="$2" arr_name="$3"
    local -a items=()
    local entry=""

    printf "    ${C_DIM}%s${C_RESET}\n" "$hint" >&2
    printf "    ${C_DIM}Press enter on an empty line when done.${C_RESET}\n\n" >&2

    while true; do
        printf "    ${C_CYAN}▸${C_RESET} ${C_WHITE}%s${C_RESET}: " "$prompt" >&2
        read -r entry
        [[ -z "$entry" ]] && break
        items+=("$entry")
        log_success "Added: $entry"
    done

    # Write result back via nameref
    eval "$arr_name=(\"\${items[@]}\")"
}

# =============================================================================
# MAIN
# =============================================================================
main() {
    neon_header

    # ── Load existing values (if any) ──────────────────────────────────────
    local -a existing_targets=() existing_templates=()

    if [[ -f "$ENV_FILE" ]]; then
        log_info "Existing config found: $ENV_FILE"

        # Parse current values from the env file (zsh-native, no GNU grep needed)
        local raw_targets raw_templates line
        raw_targets="" raw_templates=""
        while IFS= read -r line; do
            if [[ "$line" == export\ DEMO_REPO_TARGETS=* ]]; then
                raw_targets="${line#export DEMO_REPO_TARGETS=\"}"
                raw_targets="${raw_targets%\"}"
            elif [[ "$line" == export\ DEMO_REPO_TEMPLATES=* ]]; then
                raw_templates="${line#export DEMO_REPO_TEMPLATES=\"}"
                raw_templates="${raw_templates%\"}"
            fi
        done < "$ENV_FILE"

        if [[ -n "$raw_targets" ]]; then
            existing_targets=("${(@s:,:)raw_targets}")
        fi
        if [[ -n "$raw_templates" ]]; then
            existing_templates=("${(@s:,:)raw_templates}")
        fi

        if [[ ${#existing_targets[@]} -gt 0 ]]; then
            printf "    ${C_DIM}Current targets:${C_RESET}\n" >&2
            for t in "${existing_targets[@]}"; do
                printf "      ${C_PURPLE}•${C_RESET} %s\n" "$t" >&2
            done
            echo "" >&2
        fi
        if [[ ${#existing_templates[@]} -gt 0 ]]; then
            printf "    ${C_DIM}Current templates:${C_RESET}\n" >&2
            for t in "${existing_templates[@]}"; do
                printf "      ${C_PURPLE}•${C_RESET} %s\n" "$t" >&2
            done
            echo "" >&2
        fi
        printf "    ${C_DIM}New entries will be appended (duplicates ignored).${C_RESET}\n\n" >&2
    fi

    # ── Targets ──────────────────────────────────────────────────────────────
    neon_section "GitHub Targets"
    printf "    ${C_DIM}These are the GitHub accounts where you create${C_RESET}\n" >&2
    printf "    ${C_DIM}and delete demo repos.${C_RESET}\n\n" >&2

    local -a targets=()
    collect_entries "Target" "Format: ACCOUNT  (e.g. MyOrg)  or  HOST::ACCOUNT for GHE" targets

    # Merge with existing (deduplicate)
    for t in "${existing_targets[@]}"; do
        if (( ! ${targets[(Ie)$t]} )); then
            targets=("$t" "${targets[@]}")
        fi
    done

    if [[ ${#targets[@]} -eq 0 ]]; then
        printf "\n    ${C_RED}✖${C_RESET} No targets (existing or new). At least one is required.\n" >&2
        exit 1
    fi

    # ── Templates ────────────────────────────────────────────────────────────
    neon_section "Template Repos (for create script)"
    printf "    ${C_DIM}These are the source repos to clone from when${C_RESET}\n" >&2
    printf "    ${C_DIM}creating new demo repos.${C_RESET}\n\n" >&2

    local -a templates=()
    collect_entries "Template" "Format: ORG/REPO  or  HOST::ORG/REPO  (e.g. github.com::MyOrg/my-template)" templates

    # Merge with existing (deduplicate)
    for t in "${existing_templates[@]}"; do
        if (( ! ${templates[(Ie)$t]} )); then
            templates=("$t" "${templates[@]}")
        fi
    done

    if [[ ${#templates[@]} -eq 0 ]]; then
        printf "\n    ${C_RED}✖${C_RESET} No templates (existing or new). At least one is required.\n" >&2
        exit 1
    fi

    # ── Build comma-separated strings ────────────────────────────────────────
    local targets_csv="${(j:,:)targets}"
    local templates_csv="${(j:,:)templates}"

    # ── Write env file ───────────────────────────────────────────────────────
    neon_section "Writing $ENV_FILE"

    cat > "$ENV_FILE" <<EOF
# Demo repo scripts — generated by setup-demo-env.zsh
# Source this file from ~/.zshrc:  source $ENV_FILE

# Host::Account pairs for create & delete scripts
export DEMO_REPO_TARGETS="$targets_csv"

# Template repos for the create script
export DEMO_REPO_TEMPLATES="$templates_csv"
EOF

    log_success "Wrote $ENV_FILE"

    # ── Show what was written ────────────────────────────────────────────────
    echo "" >&2
    printf "    ${C_PURPLE}DEMO_REPO_TARGETS${C_RESET}=${C_WHITE}%s${C_RESET}\n" "$targets_csv" >&2
    printf "    ${C_PURPLE}DEMO_REPO_TEMPLATES${C_RESET}=${C_WHITE}%s${C_RESET}\n" "$templates_csv" >&2

    # ── Hook into .zshrc ─────────────────────────────────────────────────────
    neon_section "Shell Integration"

    local source_line="[[ -f $ENV_FILE ]] && source $ENV_FILE"

    if grep -qF "$ENV_FILE" "$HOME/.zshrc" 2>/dev/null; then
        log_success "~/.zshrc already sources $ENV_FILE"
    else
        printf "    ${C_CYAN}▸${C_RESET} Add to ~/.zshrc? ${C_DIM}(y/N)${C_RESET} " >&2
        read -r -k 1 yn
        echo "" >&2
        if [[ "$yn" == [yY] ]]; then
            echo "" >> "$HOME/.zshrc"
            echo "# Demo repo scripts env" >> "$HOME/.zshrc"
            echo "$source_line" >> "$HOME/.zshrc"
            log_success "Added source line to ~/.zshrc"
        else
            echo "" >&2
            log_info "Add this to your shell profile manually:"
            printf "\n    ${C_WHITE}%s${C_RESET}\n\n" "$source_line" >&2
        fi
    fi

    # ── Done ─────────────────────────────────────────────────────────────────
    echo "" >&2
    printf "  ${C_GREEN}${C_BOLD}✔ Setup complete.${C_RESET} ${C_DIM}Restart your shell or run:${C_RESET}\n" >&2
    printf "    ${C_WHITE}source %s${C_RESET}\n\n" "$ENV_FILE" >&2
}

main
