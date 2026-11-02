#!/bin/sh
# Single source of truth for secret-material patterns shared by
# .githooks/pre-commit and the CI `secret-scan` job (.github/workflows/ci.yml).
#
# Matches:
#   - Stellar ed25519 secret seeds: S-prefixed 56-character base32 strkeys
#   - PEM private key blocks: PRIVATE KEY, RSA/EC/OPENSSH/ENCRYPTED PRIVATE KEY
# G… / C… addresses are public and are not flagged.

SECRET_PATTERN='S[A-Z2-7]{55}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

# When sourced (e.g. `. scripts/secret-scan.sh` from `.githooks/pre-commit`),
# expose SECRET_PATTERN and return without running the full-tree scan.
case "${0##*/}" in
  secret-scan.sh) ;;
  *) return 0 2>/dev/null || exit 0 ;;
esac

set -e

if [ "${1:-}" = "--staged" ]; then
  exec "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/.githooks/pre-commit"
fi

if [ -f frontend/wallet/scripts/pool.json ]; then
  echo "::error::pool.json holds a treasury secret key and must never be committed"
  exit 1
fi

if [ -n "$(git ls-files)" ] && git ls-files -z | xargs -0 grep -InE "$SECRET_PATTERN"; then
  echo "::error::a secret-looking string is tracked — see the lines above"
  exit 1
fi
