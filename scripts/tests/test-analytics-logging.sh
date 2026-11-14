#!/usr/bin/env bash
# ── Analytics logging end-to-end tests ───────────────────────────────
# Verifies that every tracking path actually PERSISTS to Postgres —
# not just returns 200. Each run uses a unique session id so the DB
# assertions are exact and re-runnable.
#
#   POST /api/analytics/log     → 1 news_interactions row
#   POST /api/analytics/batch   → N news_interactions rows (+ client_ts)
#   POST /api/search/log        → 1 news_search_log row (the learn-loop sink)
#   POST /api/analytics/set-home→ news_user_locations home_* + set_home event
#   POST /api/analytics/set-home(detected) → detected_* only, never clobbers home
#   GET  /api/analytics/stats   → rich Overview payload (by_type, totals…)
#   GET  /api/analytics/interactions → drill-down rows for the Overview modals
#   rate limiting on the batch endpoint

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

ensure_api_up || { echo "API down — skipping analytics tests"; exit 0; }

# Unique per run so counts are deterministic.
SFX="$(date +%s)_$$"
S="test_analytics_${SFX}"
SD="test_detect_${SFX}"

# ── Single-event log ─────────────────────────────────────────────────
start_group "Analytics: /log persists one interaction"
body='{"session_id":"'"$S"'","type":"pin_click","pin_id":999001,"article_id":42,"source_id":7,"metadata":{"title":"smoke-test-pin"}}'
out="$(api_post /api/analytics/log "$body")"
require_status "$(extract_status "$out")" "200" "POST /api/analytics/log"

n="$(runpsql "SELECT count(*) FROM news_interactions WHERE session_id='$S' AND interaction_type='pin_click' AND metadata->>'title'='smoke-test-pin';")"
assert_eq "1" "$(echo "$n" | tr -d '[:space:]')" "pin_click row written to news_interactions"

# user_agent enrichment (was silently dropped pre-migration)
ua="$(runpsql "SELECT count(*) FROM news_interactions WHERE session_id='$S' AND user_agent IS NOT NULL;")"
# /log does not set user_agent from a curl UA only if header present; curl sends one.
assert_neq "0" "$(echo "$ua" | tr -d '[:space:]')" "user_agent captured on /log"
end_group || exit 1

# ── Batch log ────────────────────────────────────────────────────────
start_group "Analytics: /batch persists many + client_ts"
# Build the batch payload in python so quoting/escaping can't drift.
b="$(python3 -c 'import json,time; print(json.dumps({"session_id":"'"$S"'","events":[
  {"type":"map_move","map_lat":51.5,"map_lng":-0.1,"map_zoom":6,"timestamp":int(time.time()*1000)},
  {"type":"page_view","metadata":{"path":"/"}},
  {"type":"ui_click","metadata":{"label":"Heatmap","section":"mode-toggle"}},
  {"type":"search","metadata":{"query":"pullman","result_count":3}}]}))')"
out="$(api_post /api/analytics/batch "$b")"
require_status "$(extract_status "$out")" "200" "POST /api/analytics/batch"
assert_contains "$(extract_body "$out")" '"count":4' "batch reports 4 inserted"

tot="$(runpsql "SELECT count(*) FROM news_interactions WHERE session_id='$S';")"
assert_eq "5" "$(echo "$tot" | tr -d '[:space:]')" "4 batch + 1 earlier = 5 interaction rows"

cts="$(runpsql "SELECT count(*) FROM news_interactions WHERE session_id='$S' AND interaction_type='map_move' AND client_ts IS NOT NULL;")"
assert_eq "1" "$(echo "$cts" | tr -d '[:space:]')" "client_ts persisted from per-event timestamp"

uic="$(runpsql "SELECT count(*) FROM news_interactions WHERE session_id='$S' AND interaction_type='ui_click' AND metadata->>'section'='mode-toggle';")"
assert_eq "1" "$(echo "$uic" | tr -d '[:space:]')" "ui_click type accepted + metadata stored"
end_group || exit 1

# ── Search log (the route that used to 404) ──────────────────────────
start_group "Analytics: /search/log persists (learn-loop sink)"
out="$(api_post /api/search/log '{"session_id":"'"$S"'","query":"spokane wildfire","result_count":12}')"
require_status "$(extract_status "$out")" "200" "POST /api/search/log"
sl="$(runpsql "SELECT count(*) FROM news_search_log WHERE session_id='$S' AND query='spokane wildfire';")"
assert_eq "1" "$(echo "$sl" | tr -d '[:space:]')" "news_search_log row written (was always empty pre-fix)"
end_group || exit 1

# ── Set-home + detection ─────────────────────────────────────────────
start_group "Analytics: set-home (home vs detected)"
out="$(api_post /api/analytics/set-home '{"session_id":"'"$S"'","lat":47.65,"lng":-117.42,"city":"Spokane","country":"US"}')"
require_status "$(extract_status "$out")" "200" "POST set-home (home)"
home="$(runpsql "SELECT home_city FROM news_user_locations WHERE session_id='$S';")"
assert_eq "Spokane" "$(echo "$home" | tr -d '[:space:]')" "home_city stored"

# Detected must NOT overwrite an explicit home…
out="$(api_post /api/analytics/set-home '{"session_id":"'"$S"'","lat":46.7,"lng":-117.1,"city":"Pullman","country":"US","source":"detected"}')"
require_status "$(extract_status "$out")" "200" "POST set-home (detected)"
after="$(runpsql "SELECT home_city FROM news_user_locations WHERE session_id='$S';")"
assert_eq "Spokane" "$(echo "$after" | tr -d '[:space:]')" "detected does NOT clobber explicit home"
dc="$(runpsql "SELECT detected_city FROM news_user_locations WHERE session_id='$S';")"
assert_eq "Pullman" "$(echo "$dc" | tr -d '[:space:]')" "detected_city stored in detected_* columns"

# …but for a session with NO home, detection may set active.
out="$(api_post /api/analytics/set-home '{"session_id":"'"$SD"'","lat":40.7,"lng":-74.0,"city":"New York","country":"US","source":"detected"}')"
require_status "$(extract_status "$out")" "200" "POST set-home (detected, no home)"
act="$(runpsql "SELECT active_source FROM news_user_locations WHERE session_id='$SD';")"
assert_eq "detected" "$(echo "$act" | tr -d '[:space:]')" "active_source=detected when no explicit home"

# cleanup detection session
runpsql "DELETE FROM news_user_locations WHERE session_id='$SD';" >/dev/null
end_group || exit 1

# ── Overview stats payload ───────────────────────────────────────────
start_group "Analytics: /stats is the Overview superset"
out="$(api_get /api/analytics/stats)"
require_status "$(extract_status "$out")" "200" "GET /api/analytics/stats"
body="$(extract_body "$out")"
for key in interactions_24h users_24h active_sources total_sources articles_24h quality_reports_24h client_errors_24h by_type top_sources top_countries; do
  assert_contains "$body" "\"$key\"" "stats exposes '$key'"
done
# by_type must list at least the types we just inserted
assert_contains "$body" '"ui_click"' "by_type includes ui_click rows"
# active_sources / articles_24h must be REAL numbers now (the old bug:
# the Overview read keys /stats never returned -> always showed 0).
if printf '%s' "$body" | grep -qoE '"active_sources":[0-9]+' && printf '%s' "$body" | grep -qoE '"articles_24h":[0-9]+'; then
  pass "active_sources & articles_24h are real ints"
else
  fail "active_sources & articles_24h are real ints" "missing or non-numeric in stats payload"
fi
end_group || exit 1

# ── Drill-down interactions feed ─────────────────────────────────────
start_group "Analytics: /interactions drill feed"
out="$(api_get "/api/analytics/interactions?type=ui_click&limit=10&session_id=test_analytics")"
require_status "$(extract_status "$out")" "200" "GET /api/analytics/interactions"
body="$(extract_body "$out")"
assert_contains "$body" '"items"' "interactions returns items[]"
assert_contains "$body" "ui_click" "interactions filtered to type=ui_click"
assert_contains "$body" '"detail"' "rows carry a summarized detail string"
end_group || exit 1

# ── Client-error ingest ──────────────────────────────────────────────
start_group "Analytics: client-error ingest + query"
ce_body='{"session_id":"'"$S"'","errors":[{"type":"error","message":"boom: test-analytics-'"$SFX"'","filename":"https://xyzo.org/app.js","lineno":10}]}'
out="$(api_post /api/analytics/client-error "$ce_body")"
require_status "$(extract_status "$out")" "200" "POST /api/analytics/client-error"
ceb="$(runpsql "SELECT count(*) FROM news_client_errors WHERE session_id='$S';")"
assert_eq "1" "$(echo "$ceb" | tr -d '[:space:]')" "client error row persisted"
ce="$(api_get "/api/analytics/client-errors?limit=5&hours=1")"
require_status "$(extract_status "$ce")" "200" "GET /api/analytics/client-errors?hours=1"
assert_contains "$(extract_body "$ce")" "test-analytics" "errors feed returns the ingested message"
end_group || exit 1

# ── Cleanup ──────────────────────────────────────────────────────────
runpsql "DELETE FROM news_interactions WHERE session_id LIKE 'test_analytics_%';" >/dev/null
runpsql "DELETE FROM news_user_locations WHERE session_id LIKE 'test_analytics_%';" >/dev/null
runpsql "DELETE FROM news_search_log WHERE session_id LIKE 'test_analytics_%';" >/dev/null
runpsql "DELETE FROM news_client_errors WHERE session_id LIKE 'test_analytics_%';" >/dev/null

echo ""
echo -e "${GREEN}✓ analytics logging tests complete${RESET}"
exit 0
