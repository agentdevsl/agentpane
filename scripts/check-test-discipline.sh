#!/usr/bin/env bash
# arch29-W2-S / F09-23 — Test-discipline CI gate.
#
# Functional tests at `tests/functional/` exercise REAL service code. Per
# CLAUDE.md §"Functional Tests: Real Service Transitions", every state
# transition must flow through a real service method. Direct DB writes that
# simulate transitions are forbidden; direct DB writes used only for fixture
# setup (e.g., re-linking a worktree after the production path cleared it,
# arranging an unreachable-via-service starting state for a guard test) are
# permitted but MUST be justified with a `// TEST-SETUP:` comment within the
# 10 lines preceding the write.
#
# This script enforces that convention. It also catches `vi.mock('drizzle-orm')`
# and friends in functional/integration/services tests (per F09-32) without an
# accompanying justification.
#
# Usage:
#   scripts/check-test-discipline.sh
#
# Exit codes:
#   0 — clean
#   1 — un-justified raw write(s) found

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

violations=0

# Tables that hold authoritative state managed by services. Raw writes to
# these in functional tests must be justified.
GUARDED_TABLES=(
  tasks
  taskRuns
  agents
  agentRuns
  sessions
  worktrees
  plan_sessions
)

# Build a regex alternation: tasks|taskRuns|...
table_regex=$(IFS='|'; echo "${GUARDED_TABLES[*]}")

# Search for `db.update(<table>)`, `db.insert(<table>)`, `db.delete(<table>)`
# in `tests/functional/`. Allows multi-line patterns (await db\n  .update(tasks))
# by using ripgrep's multiline mode if available; falls back to a simpler
# grep pattern that catches the common single-line and `await db\n  .update`
# forms.
echo "Checking tests/functional/ for un-justified raw db writes..."

# Use grep -P for Perl-compatible regex if available, else fall back. The
# pattern matches both `db.update(table)` and `.update(table)` (which catches
# the multi-line `await db\n  .update(table)` style — we then check the
# preceding window for `db` to confirm it is a Drizzle call).
matches=$(grep -RnE "\\.(update|insert|delete)\\((${table_regex})\\)" \
  --include='*.ts' \
  tests/functional/ 2>/dev/null || true)

if [ -z "$matches" ]; then
  echo "Test discipline gate: no raw db.{update,insert,delete} on guarded tables in tests/functional/ — clean."
else
  while IFS= read -r line; do
    # Format: file:line:contents
    file="${line%%:*}"
    rest="${line#*:}"
    lineno="${rest%%:*}"
    content="${rest#*:}"

    # Skip obvious non-Drizzle matches:
    # - `// db.update(...)` style comments
    # - `* db.update(...)` block-comment lines
    # - JSDoc/markdown
    case "$content" in
      *'//'*'.update('*|*'//'*'.insert('*|*'//'*'.delete('*) continue ;;
      *'*'*'.update('*|*'*'*'.insert('*|*'*'*'.delete('*) continue ;;
    esac

    # Confirm this is a Drizzle call: either the same line contains `db.` or
    # one of the previous 3 lines starts with `await db` / `db` (multi-line
    # form). Otherwise it is likely a different `.update(...)` / mock call.
    is_drizzle=0
    if echo "$content" | grep -qE "(\\bdb\\b|getDb\\(\\))"; then
      is_drizzle=1
    else
      check_start=$((lineno - 3))
      if [ "$check_start" -lt 1 ]; then
        check_start=1
      fi
      check_end=$((lineno - 1))
      if [ "$check_end" -ge 1 ]; then
        prev=$(awk "NR>=$check_start && NR<=$check_end" "$file" 2>/dev/null || true)
        if echo "$prev" | grep -qE "(await\\s+db\\s*$|^\\s*db\\s*$|=>\\s*db\\s*$)"; then
          is_drizzle=1
        fi
      fi
    fi

    if [ "$is_drizzle" -ne 1 ]; then
      continue
    fi

    # Look at the preceding 10 lines for a `// TEST-SETUP:` justification.
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

    if echo "$prev_content" | grep -qE 'TEST-SETUP:'; then
      continue
    fi

    violations=$((violations + 1))
    echo "ERROR: un-justified raw db write at $file:$lineno"
    echo "  $content"
    echo "  Add a '// TEST-SETUP: <reason>' comment within 10 lines above, or"
    echo "  route through the real service method (PlanApprovalService, TaskService, etc.)."
  done <<< "$matches"
fi

# Pattern 2: vi.mock of Drizzle / DB primitives in functional/integration/services
# tests. CLAUDE.md §"Functional Tests: Real Service Transitions" forbids mocking
# the data layer.
echo "Checking for vi.mock of drizzle-orm / db client in functional/integration tests..."
banned_mocks=$(grep -RnE "vi\\.mock\\(['\"](drizzle-orm|better-sqlite3|postgres|@/db/client|\\.\\./db/client|\\.\\./\\.\\./db/client)['\"]" \
  --include='*.ts' \
  tests/functional/ tests/integration/ tests/services/ 2>/dev/null || true)

if [ -n "$banned_mocks" ]; then
  while IFS= read -r line; do
    file="${line%%:*}"
    rest="${line#*:}"
    lineno="${rest%%:*}"
    content="${rest#*:}"

    # Allow opt-out via `// TEST-DISCIPLINE-EXEMPT:` comment within 10 lines.
    start=$((lineno - 10))
    if [ "$start" -lt 1 ]; then
      start=1
    fi
    end=$((lineno - 1))
    if [ "$end" -ge 1 ]; then
      prev_content=$(awk "NR>=$start && NR<=$end" "$file" 2>/dev/null || true)
      if echo "$prev_content" | grep -qE 'TEST-DISCIPLINE-EXEMPT:'; then
        continue
      fi
    fi

    violations=$((violations + 1))
    echo "ERROR: vi.mock of data-layer at $file:$lineno"
    echo "  $content"
    echo "  Functional/integration tests must exercise real Drizzle queries."
    echo "  See CLAUDE.md §\"Functional Tests: Real Service Transitions\"."
  done <<< "$banned_mocks"
fi

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "Test-discipline gate FAILED ($violations violation(s))."
  echo "See arch29-W2-S / specs/arch_review_april29/09-testing.md (F09-23, F09-32)."
  exit 1
fi

echo "Test-discipline gate passed."
