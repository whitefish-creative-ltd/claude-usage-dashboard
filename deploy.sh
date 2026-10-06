#!/usr/bin/env bash
# Copies the plugin source into the folder Claude loads it from.
# Usage: ./deploy.sh [target-dir]
#   target-dir defaults to every ~/.claude/dev-mods/*/token-dashboard that exists.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

targets=()
if [[ $# -gt 0 ]]; then
  targets=("$1")
else
  for d in "$CLAUDE_DIR"/dev-mods/*/token-dashboard; do
    [[ -e "$d" ]] && targets+=("$d")
  done
fi

if [[ ${#targets[@]} -eq 0 ]]; then
  echo "No target found. Pass one: ./deploy.sh <plugin-folder>" >&2
  exit 1
fi

for dst in "${targets[@]}"; do
  # An earlier setup left a symlink here; the loader needs a real folder.
  [[ -L "$dst" ]] && rm "$dst"
  mkdir -p "$dst"
  rsync -a --delete \
    --exclude '.git/' --exclude '.gitignore' --exclude 'deploy.sh' --exclude 'release.sh' --exclude 'CONTRIBUTING.md' \
    --exclude '.claude-plugin/types/' --exclude '__pycache__/' --exclude '.DS_Store' \
    "$SRC"/ "$dst"/
  echo "Deployed to $dst"
done
