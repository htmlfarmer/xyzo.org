#!/usr/bin/env bash
set -euo pipefail

# Comprehensive rename: newsium → xyzo
# Run from repo root: ./scripts/rename-newsium-to-xyzo.sh [--dry-run]
#
# WHAT GETS RENAMED:
#   - HTML titles, CSS classes, JS globals/properties/localStorage keys
#   - Python logger names, User-Agent strings, comments, docstrings
#   - Deploy service file names, script file names
#   - Documentation, package.json name
#
# WHAT STAYS (requires DB migration or env var coordination):
#   - NEWSIUM_* environment variables (used in 40+ files)
#   - DB user: newsium_app
#   - DB function: newsium_set_updated_at()
#   - DB name: newsium_cities (separate database)
#   - Hardcoded connection strings with newsium_app user

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

DRY_RUN="${1:-}"
if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "=== DRY RUN — no files will be modified ==="
fi

# Counters
RENAMED=0
UPDATED=0

rename_file() {
  local old="$1" new="$2"
  if [[ -f "$old" ]]; then
    if [[ "$DRY_RUN" == "--dry-run" ]]; then
      echo "  FILE: $old → $new"
      RENAMED=$((RENAMED + 1))
    else
      mv "$old" "$new"
      echo "  RENAMED: $old → $new"
      RENAMED=$((RENAMED + 1))
    fi
  fi
}

replace_in_file() {
  local file="$1" old="$2" new="$3"
  if [[ -f "$file" ]]; then
    if grep -qF "$old" "$file" 2>/dev/null; then
      if [[ "$DRY_RUN" == "--dry-run" ]]; then
        local count
        count=$(grep -cF "$old" "$file" 2>/dev/null || echo 0)
        echo "  SED: $file — '$old' → '$new' ($count occurrences)"
        UPDATED=$((UPDATED + 1))
      else
        # Use perl for literal string replacement (sed treats [] as regex)
        perl -i -pe "s/\Q$old\E/$new/g" "$file"
        echo "  UPDATED: $file"
        UPDATED=$((UPDATED + 1))
      fi
    fi
  fi
}

echo "═══════════════════════════════════════════════════════════════"
echo "  NEWSIUM → XYZO RENAME"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── 1. DEPLOY SERVICE FILES ──────────────────────────────────────────
echo "── 1. Deploy service files ──"
rename_file "deploy/newsium-api.service" "deploy/xyzo-api.service"
rename_file "deploy/newsium-fast-fetcher.service" "deploy/xyzo-fast-fetcher.service"
rename_file "deploy/newsium-fast-fetcher.timer" "deploy/xyzo-fast-fetcher.timer"
rename_file "deploy/newsium-fetcher.service" "deploy/xyzo-fetcher.service"
rename_file "deploy/newsium-fetcher.timer" "deploy/xyzo-fetcher.timer"
rename_file "deploy/newsium-queue-soak.service" "deploy/xyzo-queue-soak.service"
rename_file "deploy/newsium-queue-soak.timer" "deploy/xyzo-queue-soak.timer"

# Update internal references in deploy files
for f in deploy/xyzo-*.service deploy/xyzo-*.timer; do
  [[ -f "$f" ]] || continue
  replace_in_file "$f" "Description=Newsium " "Description=Xyzo "
  replace_in_file "$f" "SyslogIdentifier=newsium-" "SyslogIdentifier=xyzo-"
  replace_in_file "$f" "Requires=newsium-" "Requires=xyzo-"
  replace_in_file "$f" "Unit=newsium-" "Unit=xyzo-"
  replace_in_file "$f" "newsium-api.service" "xyzo-api.service"
  replace_in_file "$f" "newsium-fast-fetcher.service" "xyzo-fast-fetcher.service"
  replace_in_file "$f" "newsium-fetcher.service" "xyzo-fetcher.service"
  replace_in_file "$f" "newsium-queue-soak.service" "xyzo-queue-soak.service"
done

# ── 2. SCRIPTS ──────────────────────────────────────────────────────
echo ""
echo "── 2. Scripts ──"
rename_file "scripts/deploy-newsium.sh" "scripts/deploy-xyzo.sh"
rename_file "scripts/restart-newsium.sh" "scripts/restart-xyzo.sh"

# Update script internals
for f in scripts/deploy-xyzo.sh scripts/restart-xyzo.sh scripts/queue-soak-monitor.sh \
         scripts/update-geolite.sh scripts/validate-api.sh scripts/run-ingestion-cron.sh \
         scripts/optimize_frontend.py; do
  [[ -f "$f" ]] || continue
  replace_in_file "$f" "newsium-api" "xyzo-api"
  replace_in_file "$f" "newsium-fast-fetcher" "xyzo-fast-fetcher"
  replace_in_file "$f" "newsium-fetcher" "xyzo-fetcher"
  replace_in_file "$f" "newsium-queue-soak" "xyzo-queue-soak"
  replace_in_file "$f" "deploy/newsium-" "deploy/xyzo-"
  replace_in_file "$f" "Newsium API" "Xyzo API"
  replace_in_file "$f" "Newsium " "Xyzo "
  replace_in_file "$f" "/tmp/newsium-" "/tmp/xyzo-"
done

# ── 3. PACKAGE.JSON ─────────────────────────────────────────────────
echo ""
echo "── 3. Package.json ──"
replace_in_file "api/package.json" '"newsium-api"' '"xyzo-api"'

# ── 4. HTML FILES ───────────────────────────────────────────────────
echo ""
echo "── 4. HTML files ──"
for f in public_html/index.html public_html/dist/index.html public_html/system.html \
         public_html/requests.html public_html/rankings.html public_html/source-coverage.html \
         public_html/quality.html public_html/ai-status.html public_html/inspector.html \
         public_html/help/index.html; do
  [[ -f "$f" ]] || continue
  replace_in_file "$f" "<title>Newsium " "<title>Xyzo "
  replace_in_file "$f" "<title>Newsium—" "<title>Xyzo—"
  replace_in_file "$f" "<title>Newsium —" "<title>Xyzo —"
  replace_in_file "$f" "Newsium Spatial" "Xyzo Spatial"
  replace_in_file "$f" "newsium / help" "xyzo / help"
  replace_in_file "$f" "NewsiumAnalytics" "XyzoAnalytics"
done

# ── 5. CSS ──────────────────────────────────────────────────────────
echo ""
echo "── 5. CSS classes ──"
replace_in_file "public_html/styles.css" ".newsium-link" ".xyzo-link"
replace_in_file "public_html/styles.css" ".newsium-conn" ".xyzo-conn"
replace_in_file "public_html/styles.css" ".newsium-pin" ".xyzo-pin"

# ── 6. JAVASCRIPT ───────────────────────────────────────────────────
echo ""
echo "── 6. JavaScript ──"

# CSS class names in JS
replace_in_file "public_html/app.js" "newsium-pin" "xyzo-pin"
replace_in_file "public_html/app.js" "newsium-conn" "xyzo-conn"
replace_in_file "public_html/app.js" "newsium-link" "xyzo-link"

# Marker internal properties
replace_in_file "public_html/app.js" "._newsiumLat" "._xyzoLat"
replace_in_file "public_html/app.js" "._newsiumLng" "._xyzoLng"
replace_in_file "public_html/app.js" "._newsiumEventId" "._xyzoEventId"
replace_in_file "public_html/app.js" "._newsiumLiveArticleId" "._xyzoLiveArticleId"
replace_in_file "public_html/app.js" "._newsiumCategory" "._xyzoCategory"
replace_in_file "public_html/app.js" "._newsiumHeatType" "._xyzoHeatType"

# localStorage keys
replace_in_file "public_html/app.js" "'newsium.session'" "'xyzo.session'"
replace_in_file "public_html/app.js" "'newsium-map-view'" "'xyzo-map-view'"
replace_in_file "public_html/app.js" "'newsium.cities.cache'" "'xyzo.cities.cache'"
replace_in_file "public_html/app.js" "'newsium-category-filters'" "'xyzo-category-filters'"
replace_in_file "public_html/app.js" "'newsium.mapMode'" "'xyzo.mapMode'"
replace_in_file "public_html/app.js" "'newsium.timeFilter'" "'xyzo.timeFilter'"
replace_in_file "public_html/app.js" "'newsium.customDays'" "'xyzo.customDays'"
replace_in_file "public_html/app.js" "'newsium.home'" "'xyzo.home'"
replace_in_file "public_html/app.js" '"newsium.session"' '"xyzo.session"'
replace_in_file "public_html/app.js" '"newsium-map-view"' '"xyzo-map-view"'
replace_in_file "public_html/app.js" '"newsium.cities.cache"' '"xyzo.cities.cache"'
replace_in_file "public_html/app.js" '"newsium-category-filters"' '"xyzo-category-filters"'
replace_in_file "public_html/app.js" '"newsium.mapMode"' '"xyzo.mapMode"'
replace_in_file "public_html/app.js" '"newsium.timeFilter"' '"xyzo.timeFilter"'
replace_in_file "public_html/app.js" '"newsium.customDays"' '"xyzo.customDays"'
replace_in_file "public_html/app.js" '"newsium.home"' '"xyzo.home"'

# Global objects
replace_in_file "public_html/app.js" "NewsiumAnalytics" "XyzoAnalytics"
replace_in_file "public_html/app.js" "__newsiumTest" "__xyzoTest"
replace_in_file "public_html/app.js" "__newsiumRenderLinks" "__xyzoRenderLinks"
replace_in_file "public_html/app.js" "__newsiumSetZoom" "__xyzoSetZoom"
replace_in_file "public_html/app.js" "__newsiumGetZoom" "__xyzoGetZoom"
replace_in_file "public_html/app.js" "__newsiumSeedAndRender" "__xyzoSeedAndRender"
replace_in_file "public_html/app.js" "__newsiumCountPaths" "__xyzoCountPaths"
replace_in_file "public_html/app.js" "__newsiumGetPinIds" "__xyzoGetPinIds"
replace_in_file "public_html/app.js" "__newsiumGetFirstMarker" "__xyzoGetFirstMarker"
replace_in_file "public_html/app.js" "__newsiumGetLeafletIds" "__xyzoGetLeafletIds"

# analytics.js
replace_in_file "public_html/analytics.js" "Newsium Analytics" "Xyzo Analytics"
replace_in_file "public_html/analytics.js" "'newsium.session'" "'xyzo.session'"
replace_in_file "public_html/analytics.js" "'newsium.home'" "'xyzo.home'"
replace_in_file "public_html/analytics.js" "'newsium.detected'" "'xyzo.detected'"
replace_in_file "public_html/analytics.js" "NewsiumAnalytics" "XyzoAnalytics"

# city-engine.js
replace_in_file "public_html/city-engine.js" "Newsium City Engine" "Xyzo City Engine"

# feedback-dialog.js
replace_in_file "public_html/feedback-dialog.js" "NewsiumAnalytics" "XyzoAnalytics"

# requests.html
replace_in_file "public_html/requests.html" "NewsiumAnalytics" "XyzoAnalytics"

# ── 7. PYTHON ───────────────────────────────────────────────────────
echo ""
echo "── 7. Python logger names ──"
for f in worker/*.py; do
  [[ -f "$f" ]] || continue
  replace_in_file "$f" 'getLogger("newsium.' 'getLogger("xyzo.'
  replace_in_file "$f" "getLogger('newsium." "getLogger('xyzo."
done

echo ""
echo "── 8. Python User-Agent strings ──"
replace_in_file "worker/fetch.py" "newsium-fetcher" "xyzo-fetcher"
replace_in_file "worker/geocode.py" "newsium-fetcher" "xyzo-fetcher"
replace_in_file "worker/check_sources.py" "newsium-fetcher" "xyzo-fetcher"
replace_in_file "worker/_compare_rss_vs_web.py" "newsium-fetcher" "xyzo-fetcher"
replace_in_file "worker/web_scraper.py" "newsium-scraper" "xyzo-scraper"
replace_in_file "worker/web_search.py" "newsium-verify" "xyzo-verify"
replace_in_file "worker/source_discovery.py" "newsium-source-finder" "xyzo-source-finder"
replace_in_file "worker/check_paywalls.py" "NewsiumBot" "XyzoBot"

echo ""
echo "── 9. Python docstrings/comments ──"
replace_in_file "worker/auto_categorize.py" "newsium articles" "xyzo articles"
replace_in_file "worker/db.py" "newsium worker" "xyzo worker"
replace_in_file "worker/learn.py" "Newsium learning" "Xyzo learning"
replace_in_file "worker/run.py" "newsium event" "xyzo event"
replace_in_file "worker/sysload.py" "newsium pipeline" "xyzo pipeline"
replace_in_file "worker/explore_region.py" "newsium.explore_region" "xyzo.explore_region"

# ── 10. API TYPESCRIPT ──────────────────────────────────────────────
echo ""
echo "── 10. API TypeScript ──"
replace_in_file "api/src/server.ts" "[newsium]" "[xyzo]"
replace_in_file "api/src/routes/sniff.ts" "newsium-sniff" "xyzo-sniff"
replace_in_file "api/src/routes/analytics.ts" "newsium article" "xyzo article"
replace_in_file "api/src/routes/analytics.ts" "newsium pin" "xyzo pin"
replace_in_file "api/src/routes/cities.ts" "global newsium" "global xyzo"

# ── 11. SQL COMMENTS ────────────────────────────────────────────────
echo ""
echo "── 11. SQL file comments ──"
for f in api/schema*.sql api/cities*.sql api/migrations/*.sql; do
  [[ -f "$f" ]] || continue
  replace_in_file "$f" "-- Newsium " "-- Xyzo "
  replace_in_file "$f" "-- newsium " "-- xyzo "
done

# ── 12. ROBOTS.TXT ──────────────────────────────────────────────────
echo ""
echo "── 12. robots.txt ──"
replace_in_file "public_html/robots.txt" "Newsium" "Xyzo"

# ── 13. DOCUMENTATION ───────────────────────────────────────────────
echo ""
echo "── 13. Documentation ──"
for f in README.md AGENTS.md; do
  [[ -f "$f" ]] || continue
  replace_in_file "$f" "newsium-api" "xyzo-api"
  replace_in_file "$f" "newsium-fast-fetcher" "xyzo-fast-fetcher"
  replace_in_file "$f" "newsium-fetcher" "xyzo-fetcher"
  replace_in_file "$f" "restart-newsium.sh" "restart-xyzo.sh"
  replace_in_file "$f" "deploy-newsium.sh" "deploy-xyzo.sh"
  replace_in_file "$f" "Newsium" "Xyzo"
done

for f in docs/superpowers/specs/*.md docs/superpowers/plans/*.md; do
  [[ -f "$f" ]] || continue
  replace_in_file "$f" "newsium-api" "xyzo-api"
  replace_in_file "$f" "newsium-fast-fetcher" "xyzo-fast-fetcher"
  replace_in_file "$f" "newsium-fetcher" "xyzo-fetcher"
  replace_in_file "$f" "deploy/newsium-" "deploy/xyzo-"
  replace_in_file "$f" "Newsium" "Xyzo"
done

# ── 14. TEST SCRIPTS ────────────────────────────────────────────────
echo ""
echo "── 14. Test scripts ──"
replace_in_file "scripts/tests/test-analytics-clicks.mjs" "NewsiumAnalytics" "XyzoAnalytics"
replace_in_file "scripts/tests/test-analytics-clicks.mjs" "newsium-pin" "xyzo-pin"

# ── SUMMARY ─────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "  DRY RUN COMPLETE"
  echo "  Files to rename: $RENAMED"
  echo "  Files to update: $UPDATED"
  echo ""
  echo "  Run without --dry-run to apply changes."
else
  echo "  RENAME COMPLETE"
  echo "  Files renamed: $RENAMED"
  echo "  Files updated: $UPDATED"
  echo ""
  echo "  NEXT STEPS:"
  echo "  1. Review: git diff --stat"
  echo "  2. Rebuild dist: cd public_html && npm run build (if applicable)"
  echo "  3. Restart API: systemctl restart xyzo-api"
  echo "  4. Commit: git add -A && git commit -m 'rename: newsium → xyzo'"
fi
echo "═══════════════════════════════════════════════════════════════"
