#!/usr/bin/env bash
# ── xyzo nightly automation ─────────────────────────────────────────
# Runs at 3 AM daily via systemd timer.
# Does a full pipeline cycle + discovers sources for top cities +
# studies user search logs to find trending topics.
#
# Target: maintain 1500-7000+ articles with good geographic coverage.

set -euo pipefail

WORKDIR="/var/www/vhosts/xyzo.org"
LOG="/var/log/xyzo/nightly-$(date +%Y%m%d).log"
DB_DSN="${XYZO_DB_DSN:-postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo}"
export XYZO_DB_DSN="$DB_DSN"

mkdir -p /var/log/xyzo

log() {
  echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"
}

runpsql() {
  psql "$DB_DSN" -t -A -c "$1" 2>&1
}

log "═══ XYZO NIGHTLY AUTOMATION START ═══"

# ── 1. Full AI extraction cycle ─────────────────────────────────────
log "── Step 1: Full AI extraction cycle (2,000 articles) ──"
cd "$WORKDIR"
NEWSIUM_AI_MAX_PER_CYCLE=2000 python3 -m worker.run --limit 2000 2>&1 | tee -a "$LOG"
log "✓ Full cycle complete"

# ── 2. Study user search logs for trending topics ───────────────────
log "── Step 2: Analyzing search logs for trending topics ──"

# Get top search queries from last 24 hours
TRENDING_QUERIES=$(runpsql "
  SELECT query, COUNT(*) as cnt
  FROM news_search_log
  WHERE created_at > now() - interval '24 hours'
  GROUP BY query
  ORDER BY cnt DESC
  LIMIT 20;
" 2>/dev/null || echo "")

if [[ -n "$TRENDING_QUERIES" ]]; then
  log "Top search queries (24h):"
  echo "$TRENDING_QUERIES" | while IFS='|' read -r query cnt; do
    log "  '$query' (${cnt}x)"
  done
  
  # For each trending query, try to discover sources
  echo "$TRENDING_QUERIES" | head -5 | while IFS='|' read -r query cnt; do
    if [[ -n "$query" ]]; then
      log "  Discovering sources for trending topic: '$query'"
      # Use the API to trigger discovery
      curl -sf -X POST "http://localhost:3008/api/explore-region" \
        -H "Content-Type: application/json" \
        -d "{\"bbox\":\"-180,-90,180,90\",\"auto_add\":true,\"category_hint\":\"$query\"}" \
        >/dev/null 2>&1 || true
      sleep 2
    fi
  done
else
  log "No trending queries found"
fi

# ── 3. Discover & Seed Sources for Unserved Major Cities ───────────
log "── Step 3: Discovering and seeding sources for unserved cities worldwide ──"
python3 -m worker.auto_seed_unserved_cities 2>&1 | tee -a "$LOG"
log "✓ Unserved city discovery complete"

# ── 4. Coverage gap analysis ────────────────────────────────────────
log "── Step 4: Checking coverage gaps ──"

# Find cities with high interest but low coverage
GAPS=$(runpsql "
  SELECT city_name, country_code, views_24h, article_count
  FROM news_location_rankings
  WHERE views_24h > 5 AND article_count < 10
  ORDER BY views_24h DESC
  LIMIT 10;
" 2>/dev/null || echo "")

if [[ -n "$GAPS" ]]; then
  log "Coverage gaps (high interest, low coverage):"
  echo "$GAPS" | while IFS='|' read -r city country views articles; do
    log "  $city, $country: ${views} views, ${articles} articles"
  done
else
  log "No significant coverage gaps found"
fi

# ── 5. Undercovered event detection ─────────────────────────────────
log "── Step 5: Detecting undercovered events ──"
cd "$WORKDIR"
python3 -c "
from worker.undercovered_detector import run
result = run(min_score=30, limit=500)
print(f'  undercovered events: {result[\"covered_count\"]}, max_score={result[\"max_score\"]}')
" 2>&1 | tee -a "$LOG"
log "✓ Undercovered detection complete"

# ── 6. News desert detection ────────────────────────────────────────
log "── Step 6: Detecting news deserts ──"
python3 -c "
from worker.news_desert_detector import run
result = run(min_desert_score=0.5, limit=500)
print(f'  news deserts: {result[\"desert_count\"]}, countries={result[\"country_count\"]}')
" 2>&1 | tee -a "$LOG"
log "✓ News desert detection complete"

# ── 7. Article count check ──────────────────────────────────────────
log "── Step 6: Article count check ──"

ARTICLE_COUNT=$(runpsql "SELECT COUNT(*) FROM news_articles;" 2>/dev/null || echo "0")
SOURCE_COUNT=$(runpsql "SELECT COUNT(*) FROM news_sources WHERE active = TRUE;" 2>/dev/null || echo "0")
EVENT_COUNT=$(runpsql "SELECT COUNT(*) FROM news_events;" 2>/dev/null || echo "0")

log "Current state: $ARTICLE_COUNT articles, $SOURCE_COUNT active sources, $EVENT_COUNT events"

if [[ "$ARTICLE_COUNT" -lt 1500 ]]; then
  log "⚠ Article count below 1500 target! Running extra fetch cycle..."
  python3 -m worker.run --limit 0 2>&1 | tail -5 | while read -r line; do
    log "  $line"
  done
fi

# ── 8. Cleanup old data ─────────────────────────────────────────────
log "── Step 8: Cleanup ──"

# Remove location views older than 30 days
runpsql "DELETE FROM news_location_views WHERE created_at < now() - interval '30 days';" >/dev/null 2>&1 || true

# Remove old search logs (keep 30 days)
runpsql "DELETE FROM news_search_log WHERE created_at < now() - interval '30 days';" >/dev/null 2>&1 || true

# Remove old interactions (keep 30 days)
runpsql "DELETE FROM news_interactions WHERE created_at < now() - interval '30 days';" >/dev/null 2>&1 || true

log "✓ Cleanup complete"

# ── Summary ──────────────────────────────────────────────────────────
log "═══ XYZO NIGHTLY AUTOMATION COMPLETE ═══"
log "Final: $ARTICLE_COUNT articles, $SOURCE_COUNT sources, $EVENT_COUNT events"
