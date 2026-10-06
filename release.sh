#!/usr/bin/env bash
# Sets the version everywhere it lives and dates the release.
# Usage: ./release.sh 1.1.0   (then add notes under the new heading in CHANGELOG.md)
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${1:?usage: ./release.sh <version>}"
DATE="$(date +%Y-%m-%d)"
python3 - "$VERSION" "$DATE" <<'PY'
import json, sys
version, date = sys.argv[1], sys.argv[2]
p = '.claude-plugin/plugin.json'
d = json.load(open(p))
d['version'] = version
with open(p, 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
with open('hooks/version.ts', 'w') as f:
    f.write("// Written by release.sh: keep in step with .claude-plugin/plugin.json.\n")
    f.write(f"export const VERSION = '{version}'\nexport const RELEASED = '{date}'\n")
c = open('CHANGELOG.md').read()
heading = f"## {version} — {date}"
if heading not in c:
    c = c.replace("# Changelog\n", f"# Changelog\n\n{heading}\n\n- \n", 1)
    open('CHANGELOG.md', 'w').write(c)
PY
echo "Version $VERSION, released $DATE. Add notes to CHANGELOG.md, then commit and push."
