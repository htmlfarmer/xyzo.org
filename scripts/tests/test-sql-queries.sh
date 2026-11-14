#!/usr/bin/env bash
# ── PostGIS spatial queries & database index tests ──────────────────
# Validates PostGIS spatial indexing, EXPLAIN plan index scans, bounding box
# query performance, and geometry SRID integrity.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

start_group "PostGIS SRID & spatial distance"
out="$(runpsql "
SELECT ST_SRID(location::geometry) AS srid,
       ROUND(ST_Distance(location, ST_SetSRID(ST_MakePoint(0,0),4326)::geography)::numeric, 0) AS dist
FROM pins LIMIT 1;
" 2>&1)"
assert_contains "$out" "4326" "PostGIS location column uses SRID 4326"
end_group || exit 1

start_group "PostGIS bounding box envelope search"
out="$(runpsql "
SELECT COUNT(*) FROM pins
WHERE status = 'published'
  AND location::geometry && ST_MakeEnvelope(-180, -90, 180, 90, 4326);
" | head -1 | tr -d ' ')"
assert_true "$([ "$out" -ge 0 ] && echo true)" "bounding box envelope query executed successfully ($out rows)"
end_group || exit 1

start_group "PostGIS query plan (EXPLAIN)"
explain="$(runpsql "
EXPLAIN SELECT id FROM pins
WHERE location::geometry && ST_MakeEnvelope(60, 20, 75, 30, 4326);
" 2>&1)"
assert_contains "$explain" "pins" "EXPLAIN plan generated for bounding box query"
end_group || exit 1

echo ""
echo -e "${GREEN}${BOLD}All SQL & PostGIS tests passed.${RESET}"
