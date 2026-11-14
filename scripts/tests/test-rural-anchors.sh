#!/usr/bin/env bash
# ── Rural-anchor regression tests ───────────────────────────────────
# Guards the 2026-08-28 "Sender Europe 1" incident: five German national
# papers were geocoded onto a rural Saarland radio transmitter, and the
# fallback placement scattered ~275 of their stories across farmland at
# xyzo.org/#49.28,6.65. These tests assert that class of bug can't
# reappear.
#
#   1. No active news source sits in the countryside (>25 km from any
#      town of ≥25k) — the deterministic capital/region anchor holds.
#   2. The specific incident location (transmitter 49.28,6.66) is empty,
#      and Saarland's stories anchor to Saarbrücken, not a tower.
#   3. The German sources that were broken now resolve to Berlin.
#   4. Python geocoding helpers reject non-administrative OSM results.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"
cd "${XYZO_WORKDIR:-${NEWSIUM_WORKDIR:-/var/www/vhosts/xyzo.org}}" || exit 1

# ── 1. No rural-anchored sources ────────────────────────────────────
start_group "Source anchors are cities, not countryside"
RURAL="$(python3 - <<'PY'
import sys; sys.path.insert(0,'/var/www/vhosts/xyzo.org')
from worker.db import connect
from worker.density import _snap_to_major_city
with connect() as c, c.cursor() as cur:
    cur.execute("SELECT id,name,lat,lng FROM news_sources WHERE active AND lat IS NOT NULL")
    rows = cur.fetchall()
n=0
for r in rows:
    near = _snap_to_major_city(float(r['lat']), float(r['lng']), min_pop=25_000)
    if not near or (near.get('dist_km') or 999) > 25: n+=1
print(n)
PY
)"
assert_eq "0" "$RURAL" "every geocoded source is within 25km of a town (rural outliers: $RURAL)"

# Sources with no coordinates are fine (article-level geocoding handles
# them); sources MUST NOT have coordinates in the ocean/null-island.
BADCO="$(python3 - <<'PY'
import sys; sys.path.insert(0,'/var/www/vhosts/xyzo.org')
from worker.db import connect
with connect() as c, c.cursor() as cur:
    cur.execute("""SELECT count(*) FROM news_sources
      WHERE lat IS NOT NULL AND lng IS NOT NULL
        AND (lat = 0 AND lng = 0)""")
    print(cur.fetchone()['count'])
PY
)"
assert_eq "0" "$BADCO" "no source anchored at 0,0 null-island"
end_group || exit 1

# ── 2. The Saarland incident location is drained ────────────────────
start_group "Saarland transmitter pins cleared"
TX="$(runpsql "SELECT count(*) FROM news_articles a JOIN news_locations l ON l.id=a.location_id WHERE l.place_name ILIKE 'Sender Europe 1%'")"
assert_eq "0" "$(echo "$TX" | tr -d '[:space:]')" "zero articles anchored to the Europe 1 transmitter"

# Anything still in that rural bbox should be a real named city.
SAAAR="$(python3 - <<'PY'
import sys; sys.path.insert(0,'/var/www/vhosts/xyzo.org')
from worker.db import connect
from worker.density import _snap_to_major_city
with connect() as c, c.cursor() as cur:
    cur.execute("""SELECT DISTINCT l.id, l.lat, l.lng, l.place_name
      FROM news_locations l JOIN news_articles a ON a.location_id=l.id
      WHERE l.geom::geometry && ST_MakeEnvelope(6.0,49.0,7.3,49.6,4326)""")
    rows = cur.fetchall()
bad=0
for r in rows:
    near = _snap_to_major_city(float(r['lat']), float(r['lng']), min_pop=25_000)
    if not near or (near.get('dist_km') or 999) > 25: bad+=1
print(bad)
PY
)"
assert_eq "0" "$SAAAR" "no location row with articles in the Saarland view is rural"
end_group || exit 1

# ── 3. The five broken German papers resolve to Berlin ──────────────
start_group "German national papers re-anchored to Berlin"
for id in 996 997 998 999 1000; do
  gl="$(runpsql "SELECT geocoded_location FROM news_sources WHERE id=$id;")"
  assert_contains "$gl" "Berlin" "source $id anchored to Berlin (got: ${gl:-none})"
done
DETX="$(runpsql "SELECT count(*) FROM news_articles a JOIN news_locations l ON l.id=a.location_id WHERE a.source_id IN (996,997,998,999,1000) AND a.fetched_at > now() - interval '1 day' AND l.place_name ILIKE '%Ittersdorf%'")"
assert_eq "0" "$(echo "$DETX" | tr -d '[:space:]')" "no fresh German-paper article is placed at the transmitter"
end_group || exit 1

# ── 4. Python source-geocoder rejects facilities ────────────────────
start_group "explore source geocoder is deterministic + facility-safe"
python3 - <<'PY' || exit 1
import sys; sys.path.insert(0,'/var/www/vhosts/xyzo.org')
from worker.explore_region import _geocode_source_location as g

# Country code → capital, no Nominatim round-trip.
lat, lng, disp = g({"country": "DE", "region": "europe"})
assert abs(lat-52.52) < 0.01 and abs(lng-13.40) < 0.01, f"DE→Berlin failed: {disp}"
assert "Berlin" in disp, f"DE label wrong: {disp}"

# A 2-letter ISO country always resolves to its capital, never to a
# rural Nominatim feature like "Sender Europe 1".
for cc, city in [("FR","Paris"),("GB","London"),("ES","Madrid")]:
    _lat,_lng,_d = g({"country": cc, "region": "unknown"})
    assert _d and city in _d, f"{cc}->{city} failed: {_d}"

# Unknown country + skip-listed region → no bogus anchor (None), NOT a
# random OSM transmitter/company/village.
lat2, lng2, d2 = g({"country": "", "region": "unknown"})
assert lat2 is None, f"should be unlocated, got {d2}"

print("PASS")
PY
[ $? -eq 0 ] && pass "_geocode_source_location: capital map + rural-garbage rejection"
end_group || exit 1

echo ""
echo -e "${GREEN}✓ rural-anchor regression tests complete${RESET}"
exit 0
