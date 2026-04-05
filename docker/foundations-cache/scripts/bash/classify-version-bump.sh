#!/usr/bin/env bash
# classify-version-bump.sh
# Parse git diff to classify semver bump type (patch/minor/major)
# Extracts old/new version constraints from Terraform module source blocks
#
# Usage: classify-version-bump.sh [--base <ref>] [--head <ref>]
# Output: JSON with module name, old version, new version, bump type
#
# Exit codes:
#   0 - Successfully classified version bump(s)
#   1 - Error (no diff, parse failure, etc.)
#   2 - No module version changes detected

set -euo pipefail

# Source common utilities if available
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[[ -f "${SCRIPT_DIR}/common.sh" ]] && source "${SCRIPT_DIR}/common.sh"

BASE_REF="${1:-HEAD~1}"
HEAD_REF="${2:-HEAD}"

# Parse command-line flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE_REF="$2"; shift 2 ;;
    --head) HEAD_REF="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Compare two semver strings and return bump type
classify_semver() {
  local old_version="$1"
  local new_version="$2"

  # Strip leading 'v' and constraint operators (~>, >=, =, ~)
  old_version="$(echo "$old_version" | sed 's/^[~>=v ]*//' | sed 's/[" ]//g')"
  new_version="$(echo "$new_version" | sed 's/^[~>=v ]*//' | sed 's/[" ]//g')"

  IFS='.' read -r old_major old_minor old_patch <<< "$old_version"
  IFS='.' read -r new_major new_minor new_patch <<< "$new_version"

  # Default missing components to 0
  old_major="${old_major:-0}"; old_minor="${old_minor:-0}"; old_patch="${old_patch:-0}"
  new_major="${new_major:-0}"; new_minor="${new_minor:-0}"; new_patch="${new_patch:-0}"

  if [[ "$new_major" -gt "$old_major" ]]; then
    echo "major"
  elif [[ "$new_minor" -gt "$old_minor" ]]; then
    echo "minor"
  elif [[ "$new_patch" -gt "$old_patch" ]]; then
    echo "patch"
  else
    echo "unknown"
  fi
}

# Extract module source and version from diff
parse_module_changes() {
  local diff_output
  diff_output="$(git diff "${BASE_REF}..${HEAD_REF}" -- '*.tf' 2>/dev/null)" || {
    echo "Error: Failed to get git diff between ${BASE_REF} and ${HEAD_REF}" >&2
    exit 1
  }

  if [[ -z "$diff_output" ]]; then
    echo "No .tf file changes detected" >&2
    exit 2
  fi

  local modules_json="[]"
  local current_file=""
  local in_module_block=false
  local module_name=""
  local old_version=""
  local new_version=""
  local module_source=""

  while IFS= read -r line; do
    # Track current file
    if [[ "$line" =~ ^diff\ --git\ a/(.+\.tf) ]]; then
      # Flush any pending module change from previous file
      if [[ -n "$old_version" && -n "$new_version" && "$old_version" != "$new_version" ]]; then
        local bump_type
        bump_type="$(classify_semver "$old_version" "$new_version")"
        modules_json="$(echo "$modules_json" | jq \
          --arg name "${module_name:-unknown}" \
          --arg source "$module_source" \
          --arg old "$old_version" \
          --arg new "$new_version" \
          --arg bump "$bump_type" \
          --arg file "$current_file" \
          '. += [{"module": $name, "source": $source, "old_version": $old, "new_version": $new, "bump_type": $bump, "file": $file}]')"
      fi
      current_file="${BASH_REMATCH[1]}"
      in_module_block=false
      module_name=""
      old_version=""
      new_version=""
      module_source=""
      continue
    fi

    # On any @@ hunk boundary, flush pending version change before resetting
    if [[ "$line" =~ ^@@ ]]; then
      if [[ -n "$old_version" && -n "$new_version" && "$old_version" != "$new_version" ]]; then
        local bump_type
        bump_type="$(classify_semver "$old_version" "$new_version")"
        modules_json="$(echo "$modules_json" | jq \
          --arg name "${module_name:-unknown}" \
          --arg source "$module_source" \
          --arg old "$old_version" \
          --arg new "$new_version" \
          --arg bump "$bump_type" \
          --arg file "$current_file" \
          '. += [{"module": $name, "source": $source, "old_version": $old, "new_version": $new, "bump_type": $bump, "file": $file}]')"
      fi
      old_version=""
      new_version=""

      # Detect module block context from @@ hunk header
      if [[ "$line" =~ ^@@.*@@.*module\ \"([^\"]+)\" ]]; then
        module_name="${BASH_REMATCH[1]}"
        in_module_block=true
        module_source=""
      fi
      continue
    fi

    # Detect module block context from:
    # - Context lines (space-prefixed, e.g.,  module "demo_bucket" {)
    # - Added/removed lines (e.g., +module "demo_bucket" {)
    if [[ "$line" =~ ^[\ +-].*module\ \"([^\"]+)\"\ \{ ]]; then
      module_name="${BASH_REMATCH[1]}"
      in_module_block=true
      continue
    fi

    # Track module source (context, added, or removed lines)
    if [[ "$in_module_block" == true || -z "$module_name" ]]; then
      if [[ "$line" =~ source[[:space:]]*=[[:space:]]*\"([^\"]+)\" ]]; then
        module_source="${BASH_REMATCH[1]}"
        # If we see a registry source, we're in a module block even without explicit detection
        if [[ "$module_source" == *"app.terraform.io"* || "$module_source" == *"registry.terraform.io"* ]]; then
          in_module_block=true
        fi
      fi
    fi

    # Detect version changes (both - and + lines)
    if [[ "$in_module_block" == true ]]; then
      if [[ "$line" =~ ^-[[:space:]]*version[[:space:]]*=[[:space:]]*\"([^\"]+)\" ]]; then
        old_version="${BASH_REMATCH[1]}"
      fi
      if [[ "$line" =~ ^\+[[:space:]]*version[[:space:]]*=[[:space:]]*\"([^\"]+)\" ]]; then
        new_version="${BASH_REMATCH[1]}"
      fi
    fi

    # Note: @@ hunk boundary flush is handled at the top of the loop
  done <<< "$diff_output"

  # Catch the last module if diff ends without a new hunk
  if [[ -n "$old_version" && -n "$new_version" && "$old_version" != "$new_version" ]]; then
    local bump_type
    bump_type="$(classify_semver "$old_version" "$new_version")"
    modules_json="$(echo "$modules_json" | jq \
      --arg name "${module_name:-unknown}" \
      --arg source "$module_source" \
      --arg old "$old_version" \
      --arg new "$new_version" \
      --arg bump "$bump_type" \
      --arg file "$current_file" \
      '. += [{"module": $name, "source": $source, "old_version": $old, "new_version": $new, "bump_type": $bump, "file": $file}]')"
  fi

  echo "$modules_json"
}

# Also check for version constraint changes in required_providers and module source URLs
parse_constraint_changes() {
  local diff_output
  diff_output="$(git diff "${BASE_REF}..${HEAD_REF}" -- '*.tf' 2>/dev/null)" || return 0

  local modules_json="[]"
  local current_file=""

  while IFS= read -r line; do
    if [[ "$line" =~ ^diff\ --git\ a/(.+\.tf) ]]; then
      current_file="${BASH_REMATCH[1]}"
      continue
    fi

    # Match version constraint changes in module source URLs
    # e.g., source = "app.terraform.io/org/module/provider?version=1.2.3"
    # or version = "~> 1.2" style changes outside module blocks
    if [[ "$line" =~ ^\+.*version[[:space:]]*=[[:space:]]*\"([^\"]+)\" ]] && [[ ! "$line" =~ ^@@|^diff ]]; then
      : # Handled in parse_module_changes
    fi
  done <<< "$diff_output"

  echo "$modules_json"
}

# Main execution
main() {
  local modules_changed
  modules_changed="$(parse_module_changes)"

  local module_count
  module_count="$(echo "$modules_changed" | jq 'length')"

  if [[ "$module_count" -eq 0 ]]; then
    echo "No module version changes detected" >&2
    exit 2
  fi

  # Determine overall bump type (highest severity wins)
  local overall_bump="patch"
  if echo "$modules_changed" | jq -e '[.[].bump_type] | index("major")' > /dev/null 2>&1; then
    overall_bump="major"
  elif echo "$modules_changed" | jq -e '[.[].bump_type] | index("minor")' > /dev/null 2>&1; then
    overall_bump="minor"
  fi

  # Detect if this is a Dependabot PR
  local is_dependabot=false
  local branch_name
  branch_name="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
  if [[ "$branch_name" == dependabot/* ]]; then
    is_dependabot=true
  fi

  # Output structured JSON
  jq -n \
    --arg version_type "$overall_bump" \
    --argjson modules_changed "$modules_changed" \
    --argjson is_dependabot "$is_dependabot" \
    --arg base_ref "$BASE_REF" \
    --arg head_ref "$HEAD_REF" \
    '{
      version_type: $version_type,
      modules_changed: $modules_changed,
      module_count: ($modules_changed | length),
      is_dependabot: $is_dependabot,
      base_ref: $base_ref,
      head_ref: $head_ref
    }'
}

main
