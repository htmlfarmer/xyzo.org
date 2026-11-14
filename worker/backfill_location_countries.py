"""Backfill missing country values in news_locations.

Run:
    python -m worker.backfill_location_countries --dry-run  # preview changes
    python -m worker.backfill_location_countries --apply      # write to DB

Strategy:
  1. Extract ISO country code from place_name suffix (e.g. "Leshan, CN" → CN)
  2. For remaining NULLs, reverse-geocode via world_cities by exact lat/lng
  3. Leave truly regional names (Africa, Europe, Mediterranean Sea) as NULL
  4. Also fix known broken coordinates:
     - id 1870: Washington, US at (40.808, -74.020) = New Jersey, not DC
       → create corrected Washington DC location and reassign 1,766 articles
"""

from __future__ import annotations

import argparse
import re
import math
from pathlib import Path

from .db import connect
from .geo_utils import haversine_km


REGIONAL_NAMES = {
    "africa", "europe", "asia", "americas", "middle east",
    "north america", "south america", "central america",
    "eastern europe", "western europe", "southern europe", "northern europe",
    "southeast asia", "east asia", "central asia", "west asia",
    "sub-saharan africa", "north africa", "west africa", "east africa",
    "caribbean", "pacific", "pacific ocean", "atlantic", "indian ocean",
    "mediterranean sea", "persian gulf", "south china sea", "east china sea",
    "red sea", "black sea", "caspian sea", "baltic sea", "america",
}

LOCATION_FIXES = {
    1870: {
        "action": "reassign_to_dc",
        "reason": "Coords (40.808, -74.020) = New Jersey, not Washington DC",
    },
}


def extract_country_from_name(place_name: str) -> str | None:
    """Extract ISO country code from place_name suffix like 'Leshan, CN'."""
    if not place_name:
        return None
    m = re.search(r",\s*([A-Z]{2})\s*$", place_name)
    if m:
        return m.group(1)
    return None


def build_world_cities_lookup() -> dict[tuple[float, float], dict]:
    """Build lookup from (round_lat, round_lng) -> world_cities row."""
    lookup: dict[tuple[float, float], dict] = {}
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT name, country_code, lat, lng, population
            FROM world_cities
            WHERE population >= 50000
        """)
        for row in cur.fetchall():
            key = (round(float(row["lat"]), 3), round(float(row["lng"]), 3))
            if key not in lookup or row["population"] > lookup[key].get("population", 0):
                lookup[key] = dict(row)
    return lookup


def upsert_location(cur, loc: dict) -> int:
    cur.execute("""
        INSERT INTO news_locations (
            place_name, place_name_normalized, country, lat, lng,
            precision, confidence, geom
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s,
                ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography)
        ON CONFLICT (place_name_normalized, ROUND(lat::numeric, 3), ROUND(lng::numeric, 3))
        DO UPDATE SET country = EXCLUDED.country, place_name = EXCLUDED.place_name
        RETURNING id
    """, (
        loc["place_name"], loc["place_name_normalized"], loc["country"],
        loc["lat"], loc["lng"], loc["precision"], loc["confidence"],
        loc["lng"], loc["lat"],
    ))
    return cur.fetchone()["id"]


def main() -> int:
    p = argparse.ArgumentParser(description="Backfill missing country in news_locations")
    p.add_argument("--apply", action="store_true", help="Write changes to DB (default is dry run)")
    args = p.parse_args()
    dry_run = not args.apply

    if dry_run:
        print("=== DRY RUN — no changes will be written ===\n")

    wc_lookup = build_world_cities_lookup()
    print(f"World cities lookup: {len(wc_lookup)} entries\n")

    total_fixed = 0

    # ── 1. Fix specific broken locations ─────────────────────────────────
    for loc_id, fix in LOCATION_FIXES.items():
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT id, place_name, lat, lng FROM news_locations WHERE id = %s",
                (loc_id,)
            )
            row = cur.fetchone()
            if not row:
                continue

            print(f"Location {loc_id}: {row['place_name']} at ({row['lat']}, {row['lng']})")
            print(f"  Reason: {fix['reason']}")

            if fix["action"] == "reassign_to_dc":
                cur.execute("""
                    SELECT id, name, country_code, lat, lng,
                           ST_Distance(
                             ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                             geom::geography
                           ) / 1000.0 AS dist_km
                    FROM world_cities
                    WHERE name ILIKE 'Washington%%'
                      AND country_code = 'US'
                      AND population >= 50000
                    ORDER BY geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geometry
                    LIMIT 10
                """, (row["lat"], row["lng"], row["lat"], row["lng"]))
                candidates = list(cur.fetchall())
                dc_row = None
                for c in candidates:
                    if abs(float(c["lat"]) - 38.9) < 0.5:
                        dc_row = c
                        break

                if not dc_row:
                    print(f"  WARNING: Could not find suitable Washington DC\n")
                    continue

                cur.execute(
                    "SELECT COUNT(*) FROM news_articles WHERE location_id = %s",
                    (loc_id,)
                )
                article_count = cur.fetchone()["count"]

                if dry_run:
                    print(f"  → Would reassign {article_count} articles to world_cities id={dc_row['id']}")
                    print(f"    (Washington DC at {dc_row['lat']:.4f}, {dc_row['lng']:.4f}, {dc_row['dist_km']:.1f}km away)\n")
                else:
                    new_loc_id = upsert_location(cur, {
                        "place_name": "Washington, DC, US",
                        "place_name_normalized": "washington, dc, us",
                        "country": "US",
                        "lat": float(dc_row["lat"]),
                        "lng": float(dc_row["lng"]),
                        "precision": "city",
                        "confidence": 0.9,
                    })
                    cur.execute(
                        "UPDATE news_articles SET location_id = %s WHERE location_id = %s",
                        (new_loc_id, loc_id)
                    )
                    print(f"  → Updated {article_count} articles to location_id={new_loc_id}\n")
                    conn.commit()
                    total_fixed += article_count

    # ── 2. Fix countries from place_name suffix ──────────────────────────
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, place_name, lat, lng
            FROM news_locations
            WHERE (country IS NULL OR country = '')
            ORDER BY id
        """)
        all_rows = list(cur.fetchall())

    by_name = 0
    by_geo = 0
    skipped_regional = 0

    for row in all_rows:
        loc_id = row["id"]
        place_name = row["place_name"] or ""

        # Skip regional names
        lower_name = place_name.lower().split(",")[0].strip()
        if lower_name in REGIONAL_NAMES:
            skipped_regional += 1
            continue

        # Try name extraction
        extracted = extract_country_from_name(place_name)
        if extracted:
            by_name += 1
            if dry_run:
                print(f"  [{loc_id}] '{place_name}' -> country='{extracted}' (from name)")
            else:
                with connect() as conn2, conn2.cursor() as cur2:
                    cur2.execute(
                        "UPDATE news_locations SET country = %s WHERE id = %s",
                        (extracted, loc_id)
                    )
                    conn2.commit()
            total_fixed += 1
            continue

        # Try coordinate match
        key = (round(float(row["lat"]), 3), round(float(row["lng"]), 3))
        match = wc_lookup.get(key)
        if match and match.get("country_code"):
            cc = match["country_code"]
            by_geo += 1
            if dry_run:
                print(f"  [{loc_id}] '{place_name}' ({row['lat']:.3f},{row['lng']:.3f}) -> country='{cc}' (world_cities: {match['name']})")
            else:
                with connect() as conn2, conn2.cursor() as cur2:
                    cur2.execute(
                        "UPDATE news_locations SET country = %s WHERE id = %s",
                        (cc, loc_id)
                    )
                    conn2.commit()
            total_fixed += 1
            continue

    # ── Summary ───────────────────────────────────────────────────────────
    print(f"\n=== Summary ===")
    print(f"Fixed by name extraction:  {by_name}")
    print(f"Fixed by geo lookup:       {by_geo}")
    print(f"Skipped (regional names): {skipped_regional}")
    if dry_run:
        print(f"\nTotal would be fixed: {by_name + by_geo}")
        print(f"Re-run with --apply to write changes.")
    else:
        print(f"\nTotal fixed: {total_fixed}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
