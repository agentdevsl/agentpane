---
name: "provider-golangci-lint-uplift"
description: ">-"
source: image
---
# Uplift golangci-lint Config to Scaffolding Framework Standard

Fetch the latest golangci-lint config from the HashiCorp
`terraform-provider-scaffolding-framework` repo and additively merge any
missing linters, settings, and sections into the local project's config. Local
customizations are always preserved.

## Why Additive Only

Teams invest effort tuning their lint config — extra linters, custom
thresholds, project-specific exclusions. Removing or overwriting those
decisions causes friction and breaks trust. The scaffolding config represents a
*minimum* standard; anything the local project already has beyond that baseline
is the team's prerogative.

| Scenario | Action | Reason |
|---|---|---|
| Item in baseline, missing locally | **Add** | Bring up to minimum standard |
| Item in local, not in baseline | **Keep** | Local exceeds baseline |
| Item in both, values differ | **Keep local** | Local customization wins |

This applies uniformly across linters, settings, formatters, exclusions, and
top-level sections. Never remove, replace, or overwrite existing config.

## Execution Steps

### 1. Fetch the Latest Baseline

The remote scaffolding repo is always the source of truth. Fetch it first:

```bash
gh api repos/hashicorp/terraform-provider-scaffolding-framework/contents/.golangci.yml --jq '.content' | base64 -d
```

If the fetch fails (no network, rate limit, auth issue), fall back to the
snapshot in `references/baseline.yml` — but inform the user that you're using a
cached version and suggest they retry with network access later.

### 2. Read the Target Config

Read `.golangci.yml` (or the path provided as argument).

- **File missing**: Inform the user and offer to create one from the fetched
  baseline as a starting point.
- **v1 format** (no `version` key, uses `linters-settings` instead of
  `linters.settings`): Inform the user that a v1-to-v2 migration is needed
  before this skill can be applied, and stop. The golangci-lint v2 migration
  guide is at <https://golangci-lint.run/product/migration-guide/>.

### 3. Delta Analysis

Compare the local config against the fetched baseline. Present a delta report
**before making any changes**:

**To add** — items in baseline, missing locally:

- Each missing linter with a one-line description of what it catches
- Each missing setting block
- Each missing section or exclusion preset

**Already present** — items in both configs (no action needed)

**Local extras** — items in local only (will be preserved as-is)

Wait for user confirmation before proceeding to changes.

### 4. Apply Changes

1. **Linters** — add missing entries to `linters.enable`, maintaining
   alphabetical order.
2. **Settings** — add missing setting blocks under `linters.settings`. For
   compound settings like `depguard`, merge missing deny rules into existing
   rule groups without duplicating or removing existing rules.
3. **Sections** — add missing top-level sections (e.g., `issues`, `formatters`).
4. **Exclusions** — add missing presets and paths to `linters.exclusions`.
5. **Formatters** — add missing entries to `formatters.enable`.

### 5. Validate

Run both checks and report results:

```bash
go build ./...
```

For linting, use whichever is available:

```bash
golangci-lint run ./...
# or if not on PATH:
go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest run ./...
```

- Config must parse without errors.
- New lint findings are expected from newly enabled linters — report as a
  summary (count per linter).
- Build must pass with no regressions.

### 6. Document

Create a spec history file at `spec/history/NNN-uplift-golangci-lint-config.md`
with:

- Date of uplift
- Delta analysis summary (what was added, what was kept)
- Verification results (build status, lint issue counts by linter)

Use the next available number prefix.
