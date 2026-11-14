#!/usr/bin/env bash
# ── DB schema invariant tests ──────────────────────────────────────
# Validates the database has the columns and constraints the
# application code relies on. These are guard rails — if someone drops
# a column or changes a CHECK constraint without updating the code,
# these tests catch it before the API does.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

# Helper: run a query and return trimmed output.
q() { runpsql "$1" | head -1 | tr -d ' '; }

start_group "Required tables exist"
# world_cities is a foreign table accessed via FDW from the
# xyzo_cities_server, so it's in foreign_tables, not pg_tables.
for t in news_articles news_sources news_locations news_quality_reports \
         news_re_evaluate_requests news_request_votes; do
  count="$(runpsql "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public' AND tablename='$t'" | head -1 | tr -d ' ')"
  assert_eq "1" "$count" "table $t exists"
done
count="$(runpsql "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='world_cities'" | head -1 | tr -d ' ')"
assert_eq "1" "$count" "table world_cities exists (FOREIGN)"
end_group || exit 1

start_group "news_articles auto-categorize columns"
for col in auto_categorized_at auto_categorize_confidence auto_categorize_status \
           auto_categorize_city_id auto_categorize_city_label \
           auto_categorize_event_type auto_categorize_method; do
  count="$(runpsql "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='news_articles' AND column_name='$col'" | head -1 | tr -d ' ')"
  assert_eq "1" "$count" "news_articles.$col exists"
done
end_group || exit 1

start_group "quality-reports CHECK constraint allows all types"
# The constraint must accept all 11 currently supported report types.
# We check by reading the constraint definition and asserting each
# type is mentioned. If a type is missing from the constraint, the
# INSERT will fail with a constraint violation.
constraint="$(runpsql "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
JOIN pg_class t ON c.conrelid = t.oid
WHERE t.relname = 'news_quality_reports' AND c.conname = 'news_quality_reports_report_type_check'" 2>&1)"
for rt in misleading false_info spam outdated low_quality offensive duplicate other rerun_requested paywall login_required; do
  if printf '%s' "$constraint" | grep -q "'$rt'"; then
    pass "CHECK constraint accepts type=$rt"
  else
    fail "CHECK constraint accepts type=$rt" "constraint: $constraint"
  fi
done
end_group || exit 1

start_group "quality-stats reports_by_access view"
# The analytics query must surface the new access-quality bucket.
out="$(api_get /api/analytics/quality-stats)"
status="$(extract_status "$out")"
if [ "$status" = "200" ]; then
  body="$(extract_body "$out")"
  assert_contains "$body" "reports_by_access" "stats exposes reports_by_access bucket"
else
  skip "API not reachable (status=$status)"
fi
end_group || exit 1

start_group "world_cities has lat/lng populated"
null_count="$(runpsql "SELECT COUNT(*) FROM world_cities WHERE lat IS NULL OR lng IS NULL OR lat = 0 OR lng = 0" | head -1 | tr -d ' ')"
total="$(runpsql "SELECT COUNT(*) FROM world_cities" | head -1 | tr -d ' ')"
if [ "$total" -gt 0 ] && [ "$null_count" = "0" ]; then
  pass "world_cities fully geocoded (${total} cities)"
else
  fail "world_cities fully geocoded" "$null_count / $total have NULL lat/lng"
fi
end_group || exit 1

start_group "PostGIS spatial GIST indexes exist"
for idx in pins_location_gix news_locations_geom_idx; do
  count="$(runpsql "SELECT COUNT(*) FROM pg_indexes WHERE indexname='$idx'" | head -1 | tr -d ' ')"
  assert_eq "1" "$count" "GIST spatial index $idx exists"
done
end_group || exit 1

echo ""
echo -e "${GREEN}${BOLD}All DB schema tests passed.${RESET}"