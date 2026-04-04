#!/usr/bin/env bash
# scan-module-versions.sh
# TFC API fallback scanner for module version detection
# Queries the HCP Terraform registry API to discover new module versions
# that Dependabot may miss (e.g., submodule paths, private registry edge cases)
#
# Usage: scan-module-versions.sh --org <org> [--workspace <name>] [--create-prs]
#
# Required environment variables:
#   TFE_TOKEN - HCP Terraform API token
#   GITHUB_TOKEN - GitHub token for PR creation (if --create-prs)
#
# Exit codes:
#   0 - Scan complete (updates may or may not exist)
#   1 - Error (auth failure, API error, etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[[ -f "${SCRIPT_DIR}/common.sh" ]] && source "${SCRIPT_DIR}/common.sh"

TFE_HOSTNAME="${TFE_HOSTNAME:-app.terraform.io}"
TFE_API="https://${TFE_HOSTNAME}/api/v2"
CREATE_PRS=false
ORG=""
WORKSPACE_FILTER=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --org) ORG="$2"; shift 2 ;;
    --workspace) WORKSPACE_FILTER="$2"; shift 2 ;;
    --create-prs) CREATE_PRS=true; shift ;;
    --hostname) TFE_HOSTNAME="$2"; TFE_API="https://${TFE_HOSTNAME}/api/v2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ORG" ]]; then
  echo "Error: --org is required" >&2
  exit 1
fi

if [[ -z "${TFE_TOKEN:-}" ]]; then
  echo "Error: TFE_TOKEN environment variable is required" >&2
  exit 1
fi

# TFC API helper
tfc_api() {
  local endpoint="$1"
  local response
  response="$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer ${TFE_TOKEN}" \
    -H "Content-Type: application/vnd.api+json" \
    "${TFE_API}${endpoint}")" || {
    echo "Error: API request failed for ${endpoint}" >&2
    return 1
  }

  local http_code
  http_code="$(echo "$response" | tail -1)"
  local body
  body="$(echo "$response" | sed '$d')"

  if [[ "$http_code" -ge 400 ]]; then
    echo "Error: API returned HTTP ${http_code} for ${endpoint}" >&2
    echo "$body" >&2
    return 1
  fi

  echo "$body"
}

# List all private registry modules for the org
list_registry_modules() {
  local page=1
  local all_modules="[]"

  while true; do
    local response
    response="$(tfc_api "/organizations/${ORG}/registry-modules?page[number]=${page}&page[size]=100")" || return 1

    local modules
    modules="$(echo "$response" | jq '[.data[] | {
      id: .id,
      name: .attributes.name,
      provider: .attributes.provider,
      namespace: .attributes.namespace,
      status: .attributes.status,
      version: .attributes["version-statuses"][0].version
    }]')"

    all_modules="$(echo "$all_modules" "$modules" | jq -s '.[0] + .[1]')"

    # Check for next page
    local next_page
    next_page="$(echo "$response" | jq -r '.meta.pagination["next-page"] // empty')"
    if [[ -z "$next_page" ]]; then
      break
    fi
    page=$((page + 1))
  done

  echo "$all_modules"
}

# Get latest version for a specific module
get_latest_module_version() {
  local namespace="$1"
  local name="$2"
  local provider="$3"

  local response
  response="$(tfc_api "/organizations/${ORG}/registry-modules/private/${namespace}/${name}/${provider}")" || return 1

  echo "$response" | jq -r '.data.attributes["version-statuses"][0].version // empty'
}

# Scan .tf files in the current directory for module source references
scan_local_modules() {
  local modules_json="[]"

  while IFS= read -r tf_file; do
    # Extract module blocks with source and version
    local in_module=false
    local module_name=""
    local source=""
    local version=""

    while IFS= read -r line; do
      if [[ "$line" =~ ^[[:space:]]*module[[:space:]]+\"([^\"]+)\" ]]; then
        # Save previous module if complete
        if [[ "$in_module" == true && -n "$source" && -n "$version" ]]; then
          modules_json="$(echo "$modules_json" | jq \
            --arg name "$module_name" \
            --arg source "$source" \
            --arg version "$version" \
            --arg file "$tf_file" \
            '. += [{"module": $name, "source": $source, "current_version": $version, "file": $file}]')"
        fi
        module_name="${BASH_REMATCH[1]}"
        in_module=true
        source=""
        version=""
      fi

      if [[ "$in_module" == true ]]; then
        if [[ "$line" =~ source[[:space:]]*=[[:space:]]*\"([^\"]+)\" ]]; then
          source="${BASH_REMATCH[1]}"
        fi
        if [[ "$line" =~ version[[:space:]]*=[[:space:]]*\"([^\"]+)\" ]]; then
          version="${BASH_REMATCH[1]}"
        fi
      fi

      # End of block (closing brace at same indentation)
      if [[ "$in_module" == true && "$line" =~ ^[[:space:]]*\}[[:space:]]*$ ]]; then
        if [[ -n "$source" && -n "$version" ]]; then
          modules_json="$(echo "$modules_json" | jq \
            --arg name "$module_name" \
            --arg source "$source" \
            --arg version "$version" \
            --arg file "$tf_file" \
            '. += [{"module": $name, "source": $source, "current_version": $version, "file": $file}]')"
        fi
        in_module=false
      fi
    done < "$tf_file"
  done < <(find . -name '*.tf' -not -path './.terraform/*' 2>/dev/null)

  echo "$modules_json"
}

# Compare local module versions against registry
check_for_updates() {
  local local_modules="$1"
  local updates_json="[]"

  local module_count
  module_count="$(echo "$local_modules" | jq 'length')"

  for ((i = 0; i < module_count; i++)); do
    local module_source module_name current_version file_path
    module_source="$(echo "$local_modules" | jq -r ".[$i].source")"
    module_name="$(echo "$local_modules" | jq -r ".[$i].module")"
    current_version="$(echo "$local_modules" | jq -r ".[$i].current_version")"
    file_path="$(echo "$local_modules" | jq -r ".[$i].file")"

    # Only check private registry modules (app.terraform.io or custom hostname)
    if [[ "$module_source" != *"${TFE_HOSTNAME}"* ]] && [[ ! "$module_source" =~ app\.terraform\.io ]]; then
      continue
    fi

    # Parse module source: app.terraform.io/org/name/provider
    local source_path
    source_path="${module_source#*"${TFE_HOSTNAME}"/}"
    source_path="${source_path%%//*}"
    IFS='/' read -r namespace name provider <<< "$source_path"

    if [[ -z "$name" || -z "$provider" ]]; then
      echo "Warning: Could not parse module source: ${module_source}" >&2
      continue
    fi

    # Get latest version from registry
    local latest_version
    latest_version="$(get_latest_module_version "$namespace" "$name" "$provider" 2>/dev/null)" || continue

    if [[ -z "$latest_version" ]]; then
      continue
    fi

    # Strip constraint operators for comparison
    local clean_current
    clean_current="$(echo "$current_version" | sed 's/^[~>=v ]*//' | sed 's/[" ]//g')"

    if [[ "$clean_current" != "$latest_version" ]]; then
      # Classify bump type
      local bump_type
      IFS='.' read -r cur_major cur_minor cur_patch <<< "$clean_current"
      IFS='.' read -r lat_major lat_minor lat_patch <<< "$latest_version"

      if [[ "${lat_major:-0}" -gt "${cur_major:-0}" ]]; then
        bump_type="major"
      elif [[ "${lat_minor:-0}" -gt "${cur_minor:-0}" ]]; then
        bump_type="minor"
      elif [[ "${lat_patch:-0}" -gt "${cur_patch:-0}" ]]; then
        bump_type="patch"
      else
        bump_type="unknown"
      fi

      updates_json="$(echo "$updates_json" | jq \
        --arg module "$module_name" \
        --arg source "$module_source" \
        --arg current "$current_version" \
        --arg latest "$latest_version" \
        --arg bump "$bump_type" \
        --arg file "$file_path" \
        '. += [{"module": $module, "source": $source, "current_version": $current, "latest_version": $latest, "bump_type": $bump, "file": $file}]')"
    fi
  done

  echo "$updates_json"
}

# Create a PR for a module update (Dependabot-compatible format)
create_update_pr() {
  local module_name="$1"
  local source="$2"
  local current_version="$3"
  local latest_version="$4"
  local file_path="$5"
  local bump_type="$6"

  local branch_name="dependabot/terraform/${module_name}-${latest_version}"

  # Check if branch already exists
  if git rev-parse --verify "refs/heads/${branch_name}" > /dev/null 2>&1; then
    echo "Branch ${branch_name} already exists, skipping" >&2
    return 0
  fi

  # Create branch
  git checkout -b "$branch_name" > /dev/null 2>&1

  # Update version in file
  local escaped_current
  escaped_current="$(echo "$current_version" | sed 's/[.~>= ]/\\&/g')"
  local escaped_latest_repl
  escaped_latest_repl="$(printf '%s\n' "$latest_version" | sed 's/[&\\/]/\\&/g')"
  sed -i "s/version[[:space:]]*=[[:space:]]*\"${escaped_current}\"/version = \"~> ${escaped_latest_repl}\"/" "$file_path"

  # Commit
  git add "$file_path"
  git commit -m "build(deps): bump ${module_name} from ${current_version} to ${latest_version}" \
    -m "Bumps ${source} from ${current_version} to ${latest_version}." \
    -m "Detected by scan-module-versions.sh (fallback scanner)" > /dev/null 2>&1

  # Push and create PR
  git push -u origin "$branch_name" > /dev/null 2>&1

  if [[ "${CREATE_PRS}" == true ]] && command -v gh > /dev/null 2>&1; then
    ensure_gh_noninteractive
    gh pr create \
      --title "build(deps): bump ${module_name} from ${current_version} to ${latest_version}" \
      --body "$(cat <<PRBODY
Bumps [\`${module_name}\`](${source}) from \`${current_version}\` to \`${latest_version}\`.

**Bump type**: ${bump_type}
**File**: ${file_path}

---
*This PR was created by \`scan-module-versions.sh\` (fallback scanner) to maintain compatibility with the consumer uplift pipeline.*
PRBODY
)" \
      --label "dependencies" < /dev/null 2>&1
  fi

  # Return to original branch
  git checkout - > /dev/null 2>&1
}

# Main execution
main() {
  echo "Scanning local .tf files for private registry module references..." >&2
  local local_modules
  local_modules="$(scan_local_modules)"

  local local_count
  local_count="$(echo "$local_modules" | jq 'length')"
  echo "Found ${local_count} module reference(s) in local .tf files" >&2

  if [[ "$local_count" -eq 0 ]]; then
    jq -n '{"updates": [], "update_count": 0, "scanned_modules": 0}'
    exit 0
  fi

  echo "Checking HCP Terraform registry for updates..." >&2
  local updates
  updates="$(check_for_updates "$local_modules")"

  local update_count
  update_count="$(echo "$updates" | jq 'length')"
  echo "Found ${update_count} module(s) with available updates" >&2

  # Create PRs if requested
  if [[ "${CREATE_PRS}" == true && "$update_count" -gt 0 ]]; then
    echo "Creating PRs for ${update_count} update(s)..." >&2
    for ((i = 0; i < update_count; i++)); do
      local mod src cur lat fp bt
      mod="$(echo "$updates" | jq -r ".[$i].module")"
      src="$(echo "$updates" | jq -r ".[$i].source")"
      cur="$(echo "$updates" | jq -r ".[$i].current_version")"
      lat="$(echo "$updates" | jq -r ".[$i].latest_version")"
      fp="$(echo "$updates" | jq -r ".[$i].file")"
      bt="$(echo "$updates" | jq -r ".[$i].bump_type")"
      create_update_pr "$mod" "$src" "$cur" "$lat" "$fp" "$bt"
    done
  fi

  # Output structured JSON
  jq -n \
    --argjson updates "$updates" \
    --argjson scanned "$local_count" \
    '{
      updates: $updates,
      update_count: ($updates | length),
      scanned_modules: $scanned
    }'
}

main
