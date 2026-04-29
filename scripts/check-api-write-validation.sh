#!/usr/bin/env bash
# arch29-W2-H / F07-03 — API write-path validation CI gate.
#
# Fails the build if any route handler under `src/server/routes/` calls
# `c.req.json()` directly. The canonical pattern is `parseJsonBody(c, schema)`
# from `src/server/validation.ts`, which combines JSON parsing with Zod
# schema validation in a single step and returns a structured error envelope
# on failure.
#
# Allow-listed sites: routes that legitimately accept a body that cannot be
# represented by a Zod root schema (e.g. JSON literal `null` for "clear
# override") may bypass this check by adding the comment
#     // HONO-ALLOW-UNTYPED:
# on the line immediately preceding the `c.req.json()` call. The body of
# such a route MUST still be validated via `schema.safeParse(...)` after the
# raw read.
#
# Usage:
#   scripts/check-api-write-validation.sh
#
# Exit codes:
#   0 — clean (or only allow-listed sites remain)
#   1 — un-allow-listed bare `c.req.json()` call(s) found
#   2 — too many allow-listed sites (> 2)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ROUTES_DIR="src/server/routes"

# Find every line that contains `c.req.json()` in the routes directory.
# Excludes test files (`__tests__/` and `*.test.ts`) — those reference the
# pattern in comments / mock setups and are not subject to the rule.
all_matches=$(grep -RnE "c\.req\.json\(\)" \
  --include='*.ts' \
  --exclude-dir='__tests__' \
  --exclude='*.test.ts' \
  --exclude='*.spec.ts' \
  "$ROUTES_DIR" 2>/dev/null || true)

if [ -z "$all_matches" ]; then
  echo "API write validation gate: no bare c.req.json() callers in $ROUTES_DIR — clean."
  exit 0
fi

violations=0
allowed=0

while IFS= read -r line; do
  # Format: file:line:contents
  file="${line%%:*}"
  rest="${line#*:}"
  lineno="${rest%%:*}"

  # Look at the preceding 10 lines for an allow-list comment.
  start=$((lineno - 10))
  if [ "$start" -lt 1 ]; then
    start=1
  fi
  end=$((lineno - 1))
  if [ "$end" -ge 1 ]; then
    prev_content=$(awk "NR>=$start && NR<=$end" "$file" 2>/dev/null || true)
  else
    prev_content=""
  fi

  if echo "$prev_content" | grep -qE 'HONO-ALLOW-UNTYPED:'; then
    allowed=$((allowed + 1))
    echo "  allow-listed: $file:$lineno (HONO-ALLOW-UNTYPED above)"
  else
    violations=$((violations + 1))
    echo "ERROR: bare c.req.json() at $file:$lineno"
    echo "  Replace with: const parsed = await parseJsonBody(c, <schema>); if (!parsed.ok) return parsed.response;"
  fi
done <<< "$all_matches"

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "API write validation gate FAILED ($violations un-allow-listed violation(s))."
  echo "See arch29-W2-H / specs/arch_review_april29/07-api-surface.md (F07-03)."
  exit 1
fi

if [ "$allowed" -gt 2 ]; then
  echo ""
  echo "API write validation gate FAILED: too many allow-listed sites ($allowed > 2)."
  echo "Migrate the rest to parseJsonBody. See arch29-W2-H plan."
  exit 2
fi

echo "API write validation gate passed ($allowed allow-listed site(s) within budget)."
