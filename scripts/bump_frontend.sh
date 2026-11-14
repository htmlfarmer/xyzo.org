#!/usr/bin/env bash
# Stamp every frontend asset with ONE build token.
#
# A stale ?v= on app.js is how the Köppen entry went missing from the
# layers dropdown for cached browsers (the file changed on 2026-10-22,
# the token did not). Doing it by hand drifts — this makes it one command.
#
#   bash scripts/bump_frontend.sh          # stamp with the current UTC time
#   bash scripts/bump_frontend.sh 20261024 # or an explicit stamp
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HTML="$ROOT/public_html/index.html"
GLOBE_HTML="$ROOT/public_html/globe.html"
STAMP="${1:-$(date -u +%Y%m%d%H%M)}"

# Assets that are loaded by index.html and must move together.
#
# overlay-opacity.js and map-presets.js are DELIBERATELY absent: they
# move one at a time via `bash scripts/bump_asset_token.sh <file>`, so
# touching one small file does not bust the whole page's cache.
#
# EVERY script index.html loads is here — INCLUDING console-guard.js
# and the vendored libraries, which used to have NO ?v= token at all.
# A *.js is served `max-age=31536000, immutable` for a year, so an
# unstamped script is FROZEN for a year: a reader who has loaded the
# page once keeps the copy they first fetched, and no change to it
# ever reaches them. console-guard.js last changed on 2026-10-21 and
# was unstamped until 2026-11-09 — three weeks of readers running a
# stale file (it defines window.XLog, which every module logs
# through). The gate that would have caught it is in
# frontend-hygiene.bun.test.js.
ASSETS="styles.css app.js console-guard.js i18n.js command-bar.js analytics.js perf-report.js presence.js city-engine.js submit-sniff.js debug-panel.js update-check.js viewport-nudge.js cache-debug.js vendor/leaflet/leaflet.js vendor/leaflet.heat/leaflet-heat.js vendor/leaflet.markercluster/leaflet.markercluster.js vendor/marked/marked.umd.min.js vendor/dompurify/purify.min.js climate-layer.js isobar-layer.js delta-contour.js temp-layer.js wind-layer.js wind-speed-layer.js lightning-layer.js phytoplankton-layer.js soil-layer.js cropland-layer.js river-layer.js fao-rivers-layer.js basin-layer.js geology-layer.js mag-layer.js languages-layer.js languages-regions-layer.js earthquake-layer.js fault-layer.js ocean-current-layer.js transport-layer.js salinity-layer.js ocean-layer.js city-labels.js etopo-layer.js wave-layer.js hover-info.js digest-panel.js field-layer.js field-bake.js hover-ring.js probe-stack.js saved-searches.js cape-layer.js ivt-layer.js export-contract.js export-writers.js export-engine.js export-panel.js map-debug.js feedback-dialog.js view-handoff.js generic-layers.js population-layer.js hwsd-layer.js overlay-palette.js ramp-styles.js offline.js tour.js weather-archive.js"

for asset in $ASSETS; do
  python3 - "$HTML" "$asset" "$STAMP" <<'PY'
import re, sys
path, asset, stamp = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as fh:
    html = fh.read()
pattern = re.compile(r'(' + re.escape(asset) + r'\?v=)(\d+)')
new, n = pattern.subn(lambda m: m.group(1) + stamp, html)
if n:
    with open(path, "w") as fh:
        fh.write(new)
print(f"  {asset}: {n} reference(s) -> v={stamp}")
PY
done

# globe.html has its own ?v= tokens (globe.js, globe.css, maplibre).
# view-handoff.js is in BOTH pages — flat map and globe — so it needs
# its token stamped in each.
# ramp-styles.js is loaded by BOTH pages now (the globe recolours its
# isobars with the same schemes the flat map uses), so its token has to
# move in globe.html too — a tag the stamp loop does not know about is
# a tag that keeps a stale ?v= forever.
for asset in globe.js globe.css console-guard.js field-bake.js globe-wind.js ramp-styles.js vendor/maplibre-gl/maplibre-gl.js vendor/maplibre-gl/maplibre-gl.css view-handoff.js; do
  python3 - "$GLOBE_HTML" "$asset" "$STAMP" <<'PY'
import re, sys
path, asset, stamp = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as fh:
    html = fh.read()
pattern = re.compile(r'(' + re.escape(asset) + r'\?v=)(\d+)')
new, n = pattern.subn(lambda m: m.group(1) + stamp, html)
if n:
    with open(path, "w") as fh:
        fh.write(new)
print(f"  globe: {asset}: {n} reference(s) -> v={stamp}")
PY
done

# Keep globe.js's internal V constant in sync so its data URLs bust too.
python3 - "$ROOT/public_html/globe.js" "$STAMP" <<'PY'
import re, sys
path, stamp = sys.argv[1], sys.argv[2]
with open(path) as fh:
    js = fh.read()
new, n = re.subn(r'(const V = ")(\d+)(")', lambda m: m.group(1) + stamp + m.group(3), js, count=1)
if n:
    with open(path, "w") as fh:
        fh.write(new)
print(f"  globe.js V constant: {n} replacement(s) -> {stamp}")
PY

# Lazy chunks (flag-quality, ai-story-chat, help-me-chat) are referenced
# from THREE places: index.html (prefetch / script tags), app.js
# (loadChunk URLs — these went stale at 2026090428 because nothing
# stamped app.js for them), and the inline fallback in index.html.
# Stamp every reference to them across both files.
for chunk in flag-quality.js ai-story-chat.js help-me-chat.js; do
  for target in "$HTML" "$ROOT/public_html/app.js"; do
    python3 - "$target" "$chunk" "$STAMP" <<'PY'
import re, sys
path, chunk, stamp = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as fh:
    src = fh.read()
pattern = re.compile(r'(' + re.escape(chunk) + r'\?v=)(\d+)')
new, n = pattern.subn(lambda m: m.group(1) + stamp, src)
if n:
    with open(path, "w") as fh:
        fh.write(new)
if n:
    print(f"  chunk {chunk} in {path.split('/')[-1]}: {n} reference(s) -> v={stamp}")
PY
  done
done

echo "Frontend build token set to ${STAMP}."
