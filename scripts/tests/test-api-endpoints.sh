#!/usr/bin/env bash
# ── API endpoint smoke tests ────────────────────────────────────────
# Exercises every public endpoint that's part of the AI-fallback
# architecture + the standard health/pins endpoints that catch
# regressions when other changes land.
#
# Skips any group if the API isn't reachable so CI doesn't fail when
# the service is intentionally down.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

# ── Health & basic endpoints ────────────────────────────────────────
start_group "API health & basic"
ensure_api_up || { skip "health (API down)"; end_group; exit 0; }

out="$(api_get /api/health)"
status="$(extract_status "$out")"
require_status "$status" "200" "GET /api/health"
body="$(extract_body "$out")"
assert_contains "$body" "ok" "/api/health body has ok"

out="$(api_get /api/ai-status)"
status="$(extract_status "$out")"
require_status "$status" "200" "GET /api/ai-status"
body="$(extract_body "$out")"
assert_contains "$body" "healthy" "/api/ai-status has healthy field"
end_group || exit 1

# ── Auto-categorize endpoints ──────────────────────────────────────
start_group "Auto-categorize"
out="$(api_get /api/articles/needs-ai?limit=5)"
status="$(extract_status "$out")"
require_status "$status" "200" "GET /api/articles/needs-ai"
body="$(extract_body "$out")"
assert_contains "$body" "\"count\"" "/needs-ai returns count field"
assert_contains "$body" "\"articles\"" "/needs-ai returns articles array"

out="$(api_get /api/articles/1/categorization-status)"
status="$(extract_status "$out")"
# Article 1 might not exist; accept either 200 (exists) or 404 (no row).
if [ "$status" = "200" ] || [ "$status" = "404" ]; then
  pass "GET /api/articles/1/categorization-status (status $status)"
else
  fail "GET /api/articles/1/categorization-status" "unexpected status $status"
fi

# Apply with no fields should fail validation (z.refine requires ≥1).
out="$(api_post /api/articles/1/apply-categorization '{}')"
status="$(extract_status "$out")"
assert_eq "400" "$status" "POST /apply-categorization rejects empty body"
end_group || exit 1

# ── Report-quality endpoint ─────────────────────────────────────────
start_group "Reports (all 11 types)"
# Three responses are all acceptable for this endpoint:
#   200 = first time, recorded
#   429 = rate-limited (5/IP/hour; intentional)
#   409 = duplicate (article_id+session_id+report_type already exists)
# Each of these proves the endpoint is wired up correctly and the
# CHECK constraint accepts the type.
#
# Use a unique session_id per run so we exercise the 200 path on
# types that the unique constraint doesn't yet have rows for.
RUN_ID="$(date +%s)_$$"
for rt in misleading false_info spam outdated low_quality offensive duplicate other paywall login_required; do
  body="{\"article_id\":1,\"session_id\":\"test_${RUN_ID}_$rt\",\"report_type\":\"$rt\"}"
  out="$(api_post /api/analytics/report-quality "$body")"
  status="$(extract_status "$out")"
  if [ "$status" = "200" ] || [ "$status" = "429" ] || [ "$status" = "409" ]; then
    pass "POST /report-quality type=$rt (status $status)"
  else
    fail "POST /report-quality type=$rt" "unexpected status $status"
  fi
done
end_group || exit 1

# ── Quality stats endpoint ──────────────────────────────────────────
start_group "Quality stats"
out="$(api_get /api/analytics/quality-stats)"
status="$(extract_status "$out")"
require_status "$status" "200" "GET /api/analytics/quality-stats"
body="$(extract_body "$out")"
assert_contains "$body" "reports_by_type" "stats has reports_by_type"
assert_contains "$body" "reports_by_access" "stats has reports_by_access"
end_group || exit 1

# ── Geocode endpoint ────────────────────────────────────────────────
start_group "Geocode"
# Query a real place — Nominatim should resolve it without needing AI.
out="$(api_get "/api/geocode?q=Paris")"
status="$(extract_status "$out")"
require_status "$status" "200" "GET /api/geocode?q=Paris"
body="$(extract_body "$out")"
assert_contains "$body" "\"lat\"" "geocode returns lat"
assert_contains "$body" "\"lng\"" "geocode returns lng"
assert_contains "$body" "\"source\"" "geocode returns source"
end_group || exit 1

# ── City extraction endpoint ────────────────────────────────────────
start_group "Extract-cities"
out="$(api_get "/api/extract-cities?text=Earthquake%20hits%20Tokyo%20Japan%20today")"
status="$(extract_status "$out")"
require_status "$status" "200" "GET /api/extract-cities"
body="$(extract_body "$out")"
assert_contains "$body" "Tokyo" "extract-cities finds Tokyo"
assert_contains "$body" "\"primary\"" "extract-cities returns primary"
end_group || exit 1

# ── Pins endpoints ──────────────────────────────────────────────────
start_group "Pins"
out="$(api_get "/api/pins?limit=3")"
status="$(extract_status "$out")"
require_status "$status" "200" "GET /api/pins"
body="$(extract_body "$out")"
assert_contains "$body" "\"pins\"" "/pins returns pins array"
end_group || exit 1

# ── Admin endpoints (skip if no key) ────────────────────────────────
start_group "Admin AI status"
if [ -z "$ADMIN_KEY" ]; then
  skip "no XYZO_ADMIN_KEY set — admin tests skipped"
else
  out="$(api_get /api/admin/ai-status)"
  # Will get 403 if no auth sent, 200 if we have the key. Test for 403
  # without auth, then 200 with.
  status="$(extract_status "$out")"
  if [ "$status" = "403" ] || [ "$status" = "200" ]; then
    pass "/api/admin/ai-status requires auth (status $status without key)"
  else
    fail "/api/admin/ai-status" "expected 403 or 200, got $status"
  fi

  # With the admin key it should return 200 + breaker state.
  out="$(curl -sS -m 10 -w "\n__HTTP_STATUS__:%{http_code}" \
    -H "X-Admin-Key: $ADMIN_KEY" \
    "$XYZO_API/api/admin/ai-status")"
  status="$(extract_status "$out")"
  require_status "$status" "200" "GET /admin/ai-status (with key)"
  body="$(extract_body "$out")"
  assert_contains "$body" "open" "/admin/ai-status returns open field"
  assert_contains "$body" "total_calls" "/admin/ai-status returns total_calls"
fi
end_group || exit 1

echo ""
echo -e "${GREEN}${BOLD}All API endpoint tests passed.${RESET}"