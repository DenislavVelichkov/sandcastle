#!/usr/bin/env bash
set -euo pipefail
pnpm add --global @openai/codex
test -n "$CODEX_AUTH_JSON" || { echo "Configure the CODEX_AUTH_JSON Actions secret" >&2; exit 1; }
umask 077
mkdir -p "$HOME/.codex"
printf '%s\n' "$CODEX_AUTH_JSON" | jq -e 'objects' > "$HOME/.codex/auth.json"
chmod 600 "$HOME/.codex/auth.json"
