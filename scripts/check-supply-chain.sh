#!/usr/bin/env bash
# arch29-W1-C / F04-01 + F04-02 + F04-11 — supply-chain CI gate.
#
# Fails the build if production code references mutable image tags or runtime
# `kubectl apply -f https://...` patterns. Comments and documentation files
# are excluded; the negative-test file
# `tests/lib/sandbox/sandbox-theme-04.test.ts` is excluded because it
# DELIBERATELY contains the literal `'srlynch1/agent-sandbox:latest'` to
# verify it is REJECTED by `validateImage`.
#
# Usage:
#   scripts/check-supply-chain.sh
#
# Exit codes:
#   0 — clean
#   1 — supply-chain violation found

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

violations=0

# Pattern 1: mutable srlynch1 tags in non-comment lines.
# Excludes: tests that DELIBERATELY include the literal string to verify
# rejection (sandbox-theme-04, settings.test.ts), the test fixture docstring,
# and the k8s/vendored/ directory (upstream manifests vendored as-is may
# contain `:latest` references for unrelated upstream resources).
echo "Checking for mutable srlynch1 image tags in production code..."
matches=$(grep -RnE "srlynch1/[^:[:space:]]+:latest" \
  --include='*.ts' \
  --include='*.tsx' \
  --include='*.yaml' \
  --include='*.yml' \
  --include='Dockerfile*' \
  docker/ k8s/manifests/ tests/ src/ 2>/dev/null \
  | grep -v "tests/lib/sandbox/sandbox-theme-04.test.ts" \
  | grep -v "tests/fixtures/sandbox-image.ts" \
  | grep -v "tests/routes/settings.test.ts" \
  | grep -vE "^[^:]+:[0-9]+:[[:space:]]*[#/*]" \
  || true)

if [ -n "$matches" ]; then
  echo "ERROR: mutable srlynch1 image tags found in production code:"
  echo "$matches"
  violations=$((violations + 1))
fi

# Pattern 2: live "kubectl apply -f https://..." URLs (F04-11).
echo 'Checking for live "kubectl apply -f https://..." patterns...'
matches=$(grep -RnE "kubectl apply -f [\"']?https?://" \
  --include='*.ts' \
  --include='*.tsx' \
  --include='*.sh' \
  src/ docker/ k8s/manifests/ 2>/dev/null \
  | grep -vE "^[^:]+:[0-9]+:[[:space:]]*[#/*]" \
  || true)

if [ -n "$matches" ]; then
  echo "ERROR: live kubectl apply URL found (must use vendored manifest):"
  echo "$matches"
  violations=$((violations + 1))
fi

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "Supply-chain CI gate FAILED ($violations violation(s))."
  echo "See arch29-W1-C / specs/arch_review_april29/04-sandbox-providers.md (F04-01, F04-02, F04-11)."
  exit 1
fi

echo "Supply-chain CI gate passed."
