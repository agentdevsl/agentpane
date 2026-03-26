#!/usr/bin/env bash
# Semgrep pre-commit wrapper — skips gracefully if semgrep is not installed locally.
# Semgrep scanning is enforced in CI regardless.

if ! command -v semgrep &>/dev/null; then
  echo "semgrep not installed locally, skipping (enforced in CI)"
  exit 0
fi

exec semgrep scan --config .semgrep/rules/ --severity ERROR --error "$@"
