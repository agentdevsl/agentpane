#!/usr/bin/env bash
# arch29-W3-C / F08-01 + F08-02 — Frontend design-token CI gate.
#
# Two checks, both fatal:
#
#   1. Tailwind `*-warning` classes are silent no-ops in this project — the
#      design system uses `attention` not `warning` for yellow/amber colours.
#      Tailwind v4 emits the literal class with no rule when a token is
#      missing, so paused / cancelled / reconnecting / degraded states
#      render without any colour. See CLAUDE.md §"Tailwind Color Token Names".
#
#   2. Hardcoded SVG hex colours (`fill="#..."`, `stroke="#..."`,
#      `stopColor="#..."`, `floodColor="#..."`) violate the theme contract.
#      Use `var(--accent-fg)`, `var(--fg-default)`, etc. — see CLAUDE.md
#      §"SVG and Theme Colors". Branded mascot eyes in `ai-action-button.tsx`
#      are allow-listed via filename exclusion; anything else fails the build.
#
# Usage:
#   scripts/check-frontend-tokens.sh
#
# Exit codes:
#   0 — clean
#   1 — Tailwind `*-warning` violation(s)
#   2 — SVG hex literal violation(s)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

EXIT_CODE=0

# -----------------------------------------------------------------------------
# Check 1 — Tailwind `*-warning` classes (F08-01).
# -----------------------------------------------------------------------------

# Match `bg-warning`, `text-warning`, `border-warning`, `ring-warning`,
# `fill-warning`, `stroke-warning`, `via-warning`, `from-warning`, `to-warning`,
# any of the variant suffixes (-muted, -subtle, -emphasis, -fg, -hover), and
# any opacity modifier (`bg-warning/15`, `bg-warning/5`, etc).
#
# Test files under `src/app/__tests__/` are excluded — the regression test
# harness for this gate references the forbidden patterns inside string
# literals / regex sources / JSDoc comments.
warning_matches=$(grep -RnE \
  '(bg|text|border|ring|fill|stroke|via|from|to)-warning(-(muted|emphasis|subtle|fg|hover))?(/[0-9]+)?\b' \
  --include='*.tsx' \
  --include='*.ts' \
  --exclude-dir='__tests__' \
  src/app/ 2>/dev/null || true)

if [ -n "$warning_matches" ]; then
  echo "ERROR: Tailwind \`*-warning\` classes are silent no-ops. Use \`attention\` instead."
  echo "  See CLAUDE.md §\"Tailwind Color Token Names\" and"
  echo "      specs/arch_review_april29/08-frontend.md F08-01."
  echo ""
  echo "$warning_matches"
  echo ""
  EXIT_CODE=1
fi

# -----------------------------------------------------------------------------
# Check 2 — SVG hex literals in attribute form (F08-02).
# -----------------------------------------------------------------------------

# Allow-list: branded mascot eyes in ai-action-button.tsx carry an inline
# justification comment. Test files under `src/app/__tests__/` are excluded
# because they reference the forbidden pattern in regex sources.
hex_matches=$(grep -RnE \
  '(fill|stroke|stopColor|floodColor)="#[0-9A-Fa-f]{3,8}"' \
  --include='*.tsx' \
  --exclude='ai-action-button.tsx' \
  --exclude-dir='__tests__' \
  src/app/ 2>/dev/null || true)

if [ -n "$hex_matches" ]; then
  echo "ERROR: Hardcoded SVG hex colours violate the theme contract."
  echo "  Use CSS custom properties (e.g. var(--accent-fg), var(--fg-default))."
  echo "  See CLAUDE.md §\"SVG and Theme Colors\" and"
  echo "      specs/arch_review_april29/08-frontend.md F08-02."
  echo ""
  echo "$hex_matches"
  echo ""
  if [ "$EXIT_CODE" -eq 0 ]; then
    EXIT_CODE=2
  fi
fi

if [ "$EXIT_CODE" -eq 0 ]; then
  echo "Frontend design-token gate: clean."
fi

exit "$EXIT_CODE"
