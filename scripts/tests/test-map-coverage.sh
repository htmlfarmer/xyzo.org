#!/usr/bin/env bash
# ── test-map-coverage.sh ────────────────────────────────────────────
# Tests to verify the map has good global coverage.
# Run: ./scripts/tests/test-map-coverage.sh

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

# ── Test: Minimum active sources ────────────────────────────────────
start_group "Active sources"
source_count="$(runpsql "SELECT COUNT(*) FROM news_sources WHERE active=TRUE" | head -1 | tr -d ' ')"
if [ "$source_count" -ge 200 ]; then
  pass "Active sources: $source_count (>= 200)"
else
  fail "Active sources too low" "$source_count (need >= 200)"
fi
end_group || exit 1

# ── Test: Country coverage ──────────────────────────────────────────
start_group "Country coverage"
country_count="$(runpsql "SELECT COUNT(DISTINCT country) FROM news_sources WHERE active=TRUE AND country IS NOT NULL" | head -1 | tr -d ' ')"
if [ "$country_count" -ge 50 ]; then
  pass "Countries covered: $country_count (>= 50)"
else
  fail "Country coverage too low" "$country_count (need >= 50)"
fi
end_group || exit 1

# ── Test: Total articles with locations ─────────────────────────────
start_group "Articles with locations"
located_count="$(runpsql "
  SELECT COUNT(*) FROM news_articles a
  JOIN news_locations l ON l.id = a.location_id
  WHERE a.status IN ('extracted','clustered')
  AND l.lat IS NOT NULL AND l.lng IS NOT NULL
" | head -1 | tr -d ' ')"
if [ "$located_count" -ge 1000 ]; then
  pass "Located articles: $located_count (>= 1000)"
else
  fail "Located articles too low" "$located_count (need >= 1000)"
fi
end_group || exit 1

# ── Test: Global pin coverage at world zoom ─────────────────────────
start_group "Global pin coverage (world view)"
world_pins="$(curl -sf "http://localhost:3008/api/pins?bbox=-180,-90,180,90&limit=500" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print(len(d.get("pins", [])))
' 2>/dev/null || echo "0")"
if [ "$world_pins" -ge 100 ]; then
  pass "World view pins: $world_pins (>= 100)"
else
  fail "World view pins too low" "$world_pins (need >= 100)"
fi
end_group || exit 1

# ── Test: Pins on each continent ────────────────────────────────────
start_group "Continental coverage"
declare -A CONTINENTS=(
  ["North America"]="-170,15,-50,75"
  ["South America"]="-85,-55,-35,15"
  ["Europe"]="-25,35,45,72"
  ["Africa"]="-20,-35,55,38"
  ["Asia"]="25,5,180,75"
  ["Oceania"]="110,-50,180,-5"
)

all_ok=true
for continent in "${!CONTINENTS[@]}"; do
  bbox="${CONTINENTS[$continent]}"
  count="$(curl -sf "http://localhost:3008/api/pins?bbox=$bbox&limit=100" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print(len(d.get("pins", [])))
' 2>/dev/null || echo "0")"
  if [ "$count" -ge 5 ]; then
    echo -e "  ${GREEN}✓${RESET} $continent: $count pins"
  else
    echo -e "  ${RED}✗${RESET} $continent: $count pins (need >= 5)"
    all_ok=false
  fi
done

if [ "$all_ok" = true ]; then
  pass "All continents have pins"
else
  fail "Some continents missing pins" "See above"
fi
end_group || exit 1

# ── Test: Recent articles (7 days) ──────────────────────────────────
start_group "Recent articles (7 days)"
recent_count="$(runpsql "
  SELECT COUNT(*) FROM news_articles
  WHERE published_at > now() - interval '7 days'
  AND status IN ('extracted','clustered')
" | head -1 | tr -d ' ')"
if [ "$recent_count" -ge 500 ]; then
  pass "Recent articles (7d): $recent_count (>= 500)"
else
  fail "Recent articles too low" "$recent_count (need >= 500)"
fi
end_group || exit 1

# ── Test: Articles fetched in last 24h ──────────────────────────────
start_group "Articles fetched (24h)"
fetched_24h="$(runpsql "
  SELECT COUNT(*) FROM news_articles
  WHERE fetched_at > now() - interval '24 hours'
" | head -1 | tr -d ' ')"
if [ "$fetched_24h" -ge 100 ]; then
  pass "Fetched in 24h: $fetched_24h (>= 100)"
else
  fail "Fetched in 24h too low" "$fetched_24h (need >= 100)"
fi
end_group || exit 1

# ── Test: Source freshness (sources fetched in last 24h) ────────────
start_group "Source freshness"
fresh_sources="$(runpsql "
  SELECT COUNT(DISTINCT source_id) FROM news_articles
  WHERE fetched_at > now() - interval '24 hours'
" | head -1 | tr -d ' ')"
total_sources="$(runpsql "SELECT COUNT(*) FROM news_sources WHERE active=TRUE" | head -1 | tr -d ' ')"
pct=0
if [ "$total_sources" -gt 0 ]; then
  pct=$((fresh_sources * 100 / total_sources))
fi
if [ "$pct" -ge 30 ]; then
  pass "Sources fetched in 24h: $fresh_sources/$total_sources ($pct%)"
else
  fail "Source freshness too low" "$fresh_sources/$total_sources ($pct%, need >= 30%)"
fi
end_group || exit 1

# ── Test: Location diversity (unique cities) ────────────────────────
start_group "Location diversity"
city_count="$(runpsql "
  SELECT COUNT(DISTINCT place_name) FROM news_locations
  WHERE place_name IS NOT NULL AND place_name != ''
" | head -1 | tr -d ' ')"
if [ "$city_count" -ge 100 ]; then
  pass "Unique locations: $city_count (>= 100)"
else
  fail "Location diversity too low" "$city_count (need >= 100)"
fi
end_group || exit 1

# ── Test: Event clustering ──────────────────────────────────────────
start_group "Event clustering"
event_count="$(runpsql "SELECT COUNT(*) FROM news_events" | head -1 | tr -d ' ')"
if [ "$event_count" -ge 100 ]; then
  pass "Events: $event_count (>= 100)"
else
  fail "Events too low" "$event_count (need >= 100)"
fi
end_group || exit 1

# ── Test: No stale sources (not fetched in 7 days) ──────────────────
start_group "Stale sources"
stale_count="$(runpsql "
  SELECT COUNT(*) FROM news_sources ns
  WHERE ns.active = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM news_articles na
    WHERE na.source_id = ns.id
    AND na.fetched_at > now() - interval '7 days'
  )
" | head -1 | tr -d ' ')"
if [ "$stale_count" -le 50 ]; then
  pass "Stale sources: $stale_count (<= 50)"
else
  fail "Too many stale sources" "$stale_count (need <= 50)"
fi
end_group

# ── Test: Pins with 24h time filter (default view) ──────────────────
start_group "Pins with 24h filter"
pins_24h="$(curl -sf "http://localhost:3008/api/pins?bbox=-180,-90,180,90&limit=500&since=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print(len(d.get("pins", [])))
' 2>/dev/null || echo "0")"
if [ "$pins_24h" -ge 50 ]; then
  pass "Pins with 24h filter: $pins_24h (>= 50)"
else
  fail "Too few pins with 24h filter" "$pins_24h (need >= 50)"
fi
end_group || exit 1

# ── Test: Pins with 7d time filter ──────────────────────────────────
start_group "Pins with 7d filter"
pins_7d="$(curl -sf "http://localhost:3008/api/pins?bbox=-180,-90,180,90&limit=500&since=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print(len(d.get("pins", [])))
' 2>/dev/null || echo "0")"
if [ "$pins_7d" -ge 200 ]; then
  pass "Pins with 7d filter: $pins_7d (>= 200)"
else
  fail "Too few pins with 7d filter" "$pins_7d (need >= 200)"
fi
end_group || exit 1

# ── Test: Article location rate ─────────────────────────────────────
start_group "Article location rate"
total_articles="$(runpsql "SELECT COUNT(*) FROM news_articles WHERE status IN ('extracted','clustered')" | head -1 | tr -d ' ')"
located_articles="$(runpsql "
  SELECT COUNT(*) FROM news_articles a
  JOIN news_locations l ON l.id = a.location_id
  WHERE a.status IN ('extracted','clustered')
  AND l.lat IS NOT NULL AND l.lng IS NOT NULL
" | head -1 | tr -d ' ')"
pct=0
if [ "$total_articles" -gt 0 ]; then
  pct=$((located_articles * 100 / total_articles))
fi
if [ "$pct" -ge 50 ]; then
  pass "Location rate: $located_articles/$total_articles ($pct%)"
else
  fail "Location rate too low" "$located_articles/$total_articles ($pct%, need >= 50%)"
fi
end_group || exit 1

echo ""
echo -e "${GREEN}${BOLD}All map coverage tests passed.${RESET}"
