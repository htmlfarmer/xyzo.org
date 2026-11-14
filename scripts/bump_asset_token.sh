#!/usr/bin/env bash
# Stamp ONE asset's ?v= token without moving any other asset.
#
#   bash scripts/bump_asset_token.sh view-handoff.js
#   bash scripts/bump_asset_token.sh map-presets.js overlay-opacity.js
#   bash scripts/bump_asset_token.sh view-handoff.js 202611010900
#
# Why this exists next to bump_frontend.sh: that script stamps EVERY
# asset with ONE build token, so touching one small file busts the
# browser cache of the whole page. overlay-opacity.js and
# map-presets.js sit OUTSIDE its ASSETS list on purpose (AGENTS.md)
# and are stamped here, one file at a time.
#
# It stamps EVERY page that can reference the asset — index.html,
# globe.html — and globe.js's internal `const V` data token when that
# file is named, so the 2D globe and the 3D globe cannot drift apart.
# A file the asset does not appear in is a zero-count no-op, not an
# error.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HTML="$ROOT/public_html/index.html"
GLOBE_HTML="$ROOT/public_html/globe.html"
GLOBE_JS="$ROOT/public_html/globe.js"

if [ "$#" -lt 1 ]; then
  echo "usage: bash scripts/bump_asset_token.sh <asset.js> [stamp]" >&2
  exit 2
fi

# Every arg but the last is an asset; a trailing all-digit arg is the
# stamp (same convention as bump_frontend.sh).
assets=("$@")
stamp="$(date -u +%Y%m%d%H%M)"
if [ "$#" -gt 1 ] && [[ "${*: -1}" =~ ^[0-9]+$ ]]; then
  stamp="${*: -1}"
  unset 'assets[-1]'
fi

for asset in "${assets[@]}"; do
  for target in "$HTML" "$GLOBE_HTML"; do
    python3 - "$target" "$asset" "$stamp" <<'PY'
import re, sys
path, asset, stamp = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path) as fh:
        html = fh.read()
except FileNotFoundError:
    sys.exit(0)
pattern = re.compile(r'(' + re.escape(asset) + r'\?v=)(\d+)')
new, n = pattern.subn(lambda m: m.group(1) + stamp, html)
if n:
    with open(path, "w") as fh:
        fh.write(new)
print(f"  {asset} in {path.split('/')[-1]}: {n} reference(s) -> v={stamp}")
PY
  done
  # globe.js carries its OWN token in a constant, which drives its
  # /data/*.json fetches — a per-asset bump that skipped it would
  # leave the globe serving yesterday's overlay metadata.
  python3 - "$GLOBE_JS" "$asset" "$stamp" <<'PY'
import re, sys
path, asset, stamp = sys.argv[1], sys.argv[2], sys.argv[3]
if asset != "globe.js":
    sys.exit(0)
with open(path) as fh:
    js = fh.read()
new, n = re.subn(r'(const V = ")(\d+)(")', lambda m: m.group(1) + stamp + m.group(3), js, count=1)
if n:
    with open(path, "w") as fh:
        fh.write(new)
print(f"  globe.js V constant: {n} replacement(s) -> {stamp}")
PY
done

echo "Asset token(s) set to ${stamp}."
