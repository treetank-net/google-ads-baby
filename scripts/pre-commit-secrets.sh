#!/usr/bin/env bash
# Pre-commit hook: block commits containing likely secrets.
# Install: ln -sf ../../scripts/pre-commit-secrets.sh .git/hooks/pre-commit

set -euo pipefail

PATTERNS=(
  'refresh_token'
  'GOCSPX-'
  'ya29\.'
  'AIza[0-9A-Za-z_-]{35}'
  'AKIA[0-9A-Z]{16}'
  '-----BEGIN (RSA |EC )?PRIVATE KEY-----'
  'sk-[a-zA-Z0-9]{20,}'
  'ghp_[a-zA-Z0-9]{36}'
  'glpat-[a-zA-Z0-9_-]{20}'
)

# Allowlisted files (public OAuth credentials / the hook script itself)
ALLOW_FILES='(server/src/constants\.ts|server/src/auth\.ts|scripts/pre-commit-secrets\.sh|server/bundle\.cjs)'

COMBINED=$(IFS='|'; echo "${PATTERNS[*]}")

STAGED=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$STAGED" ] && exit 0

FOUND=0
while IFS= read -r file; do
  [[ "$file" =~ $ALLOW_FILES ]] && continue
  MATCHES=$(git diff --cached -- "$file" | grep -E "^\+" | grep -v "^+++" | grep -Eo "$COMBINED" || true)
  if [ -n "$MATCHES" ]; then
    echo "BLOCKED: potential secret in $file:"
    echo "$MATCHES" | head -5 | sed 's/^/  /'
    FOUND=1
  fi
done <<< "$STAGED"

if [ "$FOUND" -eq 1 ]; then
  echo ""
  echo "If this is a false positive, commit with: git commit --no-verify"
  exit 1
fi
