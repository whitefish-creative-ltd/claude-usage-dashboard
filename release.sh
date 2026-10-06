#!/usr/bin/env bash
# Sets the release version in .claude-plugin/plugin.json and the README badge,
# and starts a dated entry in CHANGELOG.md. The dashboard reads both at start-up.
# Usage: ./release.sh 1.3.0   (then add notes under the new heading in CHANGELOG.md)
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${1:?usage: ./release.sh <version>}"
DATE="$(date +%Y-%m-%d)"

sed -i.bak -E "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" .claude-plugin/plugin.json
sed -i.bak -E "s/version-[0-9.]+-0A4E75/version-${VERSION}-0A4E75/; s/alt=\"Version [0-9.]+\"/alt=\"Version ${VERSION}\"/" README.md
rm -f .claude-plugin/plugin.json.bak README.md.bak

HEADING="## ${VERSION} — ${DATE}"
if ! grep -qF "$HEADING" CHANGELOG.md; then
  { echo "# Changelog"; echo; echo "$HEADING"; echo; echo "- "; tail -n +2 CHANGELOG.md; } > CHANGELOG.md.new
  mv CHANGELOG.md.new CHANGELOG.md
fi
echo "Version ${VERSION}, released ${DATE}. Add notes to CHANGELOG.md, then commit and push."
