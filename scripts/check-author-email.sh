#!/usr/bin/env bash
# Reject commits authored with squat-vulnerable generic emails.
# A GitHub user has registered claude-code@anthropic.com to their account and is
# being credited as a contributor for every commit that uses it as the author.
# Set git config user.email to your GitHub noreply address instead.

set -eu

email=$(git config user.email 2>/dev/null || true)

case "$email" in
  claude-code@anthropic.com|noreply@anthropic.com|""|*"@example.com")
    echo "ERROR: refusing to commit with author email '${email:-<unset>}'." >&2
    echo "       Set a verified email on your GitHub account, e.g.:" >&2
    echo "       git config user.email '<id>+<username>@users.noreply.github.com'" >&2
    exit 1
    ;;
esac
