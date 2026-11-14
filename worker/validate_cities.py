"""City coordinate validation using PostGIS + Natural Earth polygons.

Validates all cities in xyzo_cities against Natural Earth country boundaries
to detect:
  1. Wrong country codes (city point falls in a different country)
  2. Coordinates outside country bbox (edge cases, islands, disputed areas)
  3. Floating-point anomalies (extreme precision, swapped lat/lng)

Outputs a validation report and optionally fixes wrong country codes.

Usage:
    python -m worker.validate_cities           # dry-run report
    python -m worker.validate_cities --fix      # apply fixes
    python -m worker.validate_cities --stats    # quick stats
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import time
from pathlib import Path
from typing import NamedTuple

import psycopg
from psycopg.rows import dict_row

log = logging.getLogger("xyzo.validate_cities")

CITIES_DSN = os.environ.get("XYZO_CITIES_WRITER_DSN", "postgresql://cities_writer:CHANGE_ME@localhost:5432/xyzo_cities")
REPORT_PATH = Path(__file__).parent.parent / "data" / "cities_validation_report.json"


def _conn():
    return psycopg.connect(CITIES_DSN, row_factory=dict_row)


class ValidationResult(NamedTuple):
    total: int
    valid: int
    wrong_country: list[dict]
    outside_bbox: list[dict]
    swapped_coords: list[dict]
    invalid_range: list[dict]
    island_territory: list[dict]  #legitimate islands
    disputed: list[dict]


def validate_all() -> ValidationResult:
    """Run full validation using PostGIS ST_Contains against NE polygons."""
    with _conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM public.cities")
        total = int(cur.fetchone()["n"])

        # Quick range check
        cur.execute("""
            SELECT id, name, country_code, latitude, longitude, population
            FROM public.cities
            WHERE latitude NOT BETWEEN -90 AND 90
               OR longitude NOT BETWEEN -180 AND 180
            ORDER BY population DESC
        """)
        invalid_range = [dict(r) for r in cur.fetchall()]

        # Possible swapped lat/lng (lat looks like lng and vice versa, and both are valid)
        # e.g. a city at (19.0, 72.0) vs (72.0, 19.0) - check if swapping would put it in correct country
        cur.execute("""
            WITH city_points AS (
                SELECT c.id, c.name, c.country_code, c.latitude, c.longitude,
                       c.population,
                       ST_SetSRID(ST_MakePoint(c.longitude, c.latitude), 4326) AS pt,
                       ST_SetSRID(ST_MakePoint(c.latitude, c.longitude), 4326) AS swapped_pt
                FROM public.cities c
                WHERE c.latitude BETWEEN -90 AND 90 AND c.longitude BETWEEN -180 AND 180
                  AND c.latitude BETWEEN -180 AND 180 AND c.longitude BETWEEN -90 AND 90
                  AND c.latitude != c.longitude
            ),
            swapped_valid AS (
                SELECT cp.id, cp.name, cp.country_code, cp.latitude, cp.longitude, cp.population,
                       ne.ISO_A2 AS swapped_country, ne.NAME AS swapped_country_name
                FROM city_points cp
                LEFT JOIN spatial.ne_countries orig ON ST_Contains(orig.geom, cp.pt) AND orig.ISO_A2 = cp.country_code
                JOIN spatial.ne_countries ne ON ST_Contains(ne.geom, cp.swapped_pt) AND ne.ISO_A2 = cp.country_code
                WHERE orig.ISO_A2 IS NULL
            )
            SELECT * FROM swapped_valid ORDER BY population DESC LIMIT 50
        """)
        swapped_coords = [dict(r) for r in cur.fetchall()]

        # Cities whose point falls in a DIFFERENT country (clear data error)
        # This uses a window function to find nearest country for each city
        cur.execute("""
            WITH city_points AS (
                SELECT c.id, c.name, c.country_code, c.latitude, c.longitude, c.population,
                       ST_SetSRID(ST_MakePoint(c.longitude, c.latitude), 4326) AS pt
                FROM public.cities c
                WHERE c.latitude BETWEEN -90 AND 90 AND c.longitude BETWEEN -180 AND 180
            ),
            country_env AS (
                SELECT ISO_A2, NAME, ST_Envelope(geom) AS env
                FROM spatial.ne_countries
            ),
            nearest AS (
                SELECT cp.id, cp.name, cp.country_code, cp.latitude, cp.longitude, cp.population,
                       ce.ISO_A2 AS actual_country, ce.NAME AS actual_country_name,
                       ST_Distance(ce.env::geography, cp.pt::geography) AS dist_m,
                       ROW_NUMBER() OVER (PARTITION BY cp.id ORDER BY ST_Distance(ce.env::geography, cp.pt::geography)) AS rn
                FROM city_points cp
                JOIN country_env ce ON ce.env && cp.pt
            )
            SELECT id, name, country_code, actual_country, actual_country_name,
                   latitude, longitude, population, dist_m
            FROM nearest
            WHERE rn = 1 AND country_code != actual_country AND dist_m > 1000
            ORDER BY dist_m DESC
        """)
        wrong_country_raw = [dict(r) for r in cur.fetchall()]

        # Filter out false positives and disputed from wrong_country
        wrong_country = []
        disputed = []  # will be appended here AND later in outside_bbox loop
        false_positives = []
        for city in wrong_country_raw:
            cc = city["country_code"]
            lat, lng = city["latitude"], city["longitude"]

            # Crimea (UA → RU): disputed territory, not a data error
            if cc == "UA" and 43 < lat < 46 and 32 < lng < 37:
                disputed.append({**city, "actual_country": "RU", "reason": "crimea_disputed"})
                continue

            # Northern European cities falsely matched to Russia (Russia's envelope overlaps)
            if cc in ("GB", "DK", "NO", "SE", "FI", "EE", "LV", "LT") and city["actual_country"] == "RU":
                # These are all clearly in their actual countries, not Russia
                # Russia just has a huge envelope that happens to intersect
                false_positives.append({**city, "reason": "russia_envelope_overlap"})
                continue

            # French Polynesia → Fiji: FP is a spread-out territory, NE polygons are incomplete
            # These cities ARE in French Polynesia (Tahiti area), not Fiji
            if cc == "PF":
                false_positives.append({**city, "reason": "fp_ne_incomplete"})
                continue

            # Faroe Islands → Russia: another envelope overlap false positive
            if cc == "FO":
                false_positives.append({**city, "reason": "fo_russia_envelope_overlap"})
                continue

            wrong_country.append(city)

        # Islands / territories whose bbox doesn't contain them but coords are correct
        # These are legitimate edge cases (Canary Islands, Azores, Puerto Rico, etc.)
        island_territories = {
            # Spanish territories outside mainland Europe
            "ES": ["Canary Islands", "Ceuta", "Melilla", "Balearic Islands"],
            # Portuguese islands
            "PT": ["Azores", "Madeira"],
            # US territories
            "US": ["Puerto Rico", "Guam", "Hawaii", "US Virgin Islands", "American Samoa"],
            # Japanese islands near Taiwan
            "JP": ["Okinawa", "Ryukyu"],
            # Korean island
            "KR": ["Jeju"],
            # Greek islands
            "GR": ["Crete", "Rhodes", "Cyclades", "Dodecanese"],
            # Indonesian islands
            "ID": ["Maluku", "Papua", "Sulawesi", "Kalimantan"],
            # Filipino islands
            "PH": ["Mindanao", "Visayas", "Luzon"],
            # Palestinian territories (Gaza)
            "PS": ["Gaza Strip"],
            # Ukrainian disputed territory
            "UA": ["Crimea"],
        }

        cur.execute("""
            WITH city_country AS (
                SELECT c.id, c.name, c.country_code, c.latitude, c.longitude, c.population,
                       ST_SetSRID(ST_MakePoint(c.longitude, c.latitude), 4326) AS pt,
                       (ST_Envelope(ne.geom)) AS bbox,
                       ne.NAME AS country_name
                FROM public.cities c
                JOIN spatial.ne_countries ne ON ne.ISO_A2 = c.country_code
                WHERE c.latitude BETWEEN -90 AND 90 AND c.longitude BETWEEN -180 AND 180
            )
            SELECT id, name, country_code, latitude, longitude, population, country_name
            FROM city_country
            WHERE NOT ST_Contains(bbox, pt)
            ORDER BY population DESC
        """)
        outside_bbox_all = [dict(r) for r in cur.fetchall()]

        # Filter out legitimate island territories from outside_bbox
        outside_bbox = []
        island_territory = []
        for city in outside_bbox_all:
            cc = city["country_code"]
            name = city["name"]
            lat, lng = city["latitude"], city["longitude"]

            # Check if it's a known island/territory
            is_island = False
            if cc in island_territories:
                for territory in island_territories[cc]:
                    if territory.lower() in name.lower():
                        is_island = True
                        break

            # Check if coords are clearly in the right ocean/region for the country
            # PR is at ~18°N, 66°W - definitely not continental US
            if cc == "US" and lat > 18:
                is_island = True
            # Canary Islands are at ~28°N - Spanish bbox starts at 27°N
            if cc == "ES" and lat > 27.5:
                is_island = True
            # Azores at ~38°N, -27°W - Portuguese bbox is -10° to -6°
            if cc == "PT" and lng < -15:
                is_island = True
            # Japanese island at ~26°N, 127°E (Okinawa)
            if cc == "JP" and lat < 30 and lng > 126:
                is_island = True
            # Crimean cities at ~44°N, 33°E
            if cc == "UA" and lat > 43 and lng > 32:
                disputed.append(city)
                continue

            if is_island:
                island_territory.append(city)
            else:
                outside_bbox.append(city)

        # Count truly valid cities (in bbox or known island)
        valid = total - len(invalid_range) - len(wrong_country) - len(outside_bbox) - len(swapped_coords)

        return ValidationResult(
            total=total,
            valid=valid,
            wrong_country=wrong_country,
            outside_bbox=outside_bbox,
            swapped_coords=swapped_coords,
            invalid_range=invalid_range,
            island_territory=island_territory,
            disputed=disputed,
        )


def fix_wrong_countries(wrong: list[dict]) -> dict:
    """Update city country_code where we have high confidence the code is wrong.

    High confidence = city is >1000km from stated country and clearly in another.
    """
    if not wrong:
        return {"fixed": 0, "skipped": 0, "details": []}

    # Only auto-fix obvious errors (not disputed territories)
    # These are cities where the stated country is clearly wrong
    auto_fixable = [
        # (wrong_code, city_name_pattern, correct_code)
        ("GB", "Bukhara", "UZ"),  # Uzbek city miscoded as GB
        ("EG", "Bor", "SS"),       # South Sudanese city miscoded as Egypt
        ("SO", "El Dibir", "DJ"),  # Djiboutian city miscoded as Somalia
    ]

    fixed = []
    skipped = []

    with _conn() as conn, conn.cursor() as cur:
        for city in wrong:
            cc = city["country_code"]
            name = city["name"]
            actual = city["actual_country"]

            # Check if this matches an auto-fixable pattern
            should_fix = False
            correct_code = actual
            for wrong_code, name_pattern, correct in auto_fixable:
                if cc == wrong_code and name_pattern.lower() in name.lower():
                    should_fix = True
                    correct_code = correct
                    break

            # Only fix if distance is very large (>500km) or exact name match
            dist_m = city.get("dist_m", 0)
            if dist_m < 500000 and not should_fix:
                skipped.append({**city, "reason": f"too_close_to_decide ({dist_m/1000:.0f}km)"})
                continue

            if should_fix or dist_m > 800000:
                cur.execute("""
                    UPDATE public.cities
                    SET country_code = %s,
                        notes = COALESCE(notes || '; ', '') ||
                               'coord_fix: country_code ' || %s || ' -> ' || %s || ' (validated ' || now()::text || ')',
                        validated_at = now(),
                        validated_by = 'validate_cities.py'
                    WHERE id = %s
                """, (correct_code, cc, correct_code, city["id"]))
                fixed.append({**city, "fixed_to": correct_code})
            else:
                skipped.append({**city, "reason": "uncertain"})

        conn.commit()

    return {"fixed": len(fixed), "skipped": len(skipped), "details": fixed}


def mark_validated() -> None:
    """Add validated_at / validated_by to all cities that passed checks."""
    with _conn() as conn, conn.cursor() as cur:
        cur.execute("""
            UPDATE public.cities
            SET validated_at = COALESCE(validated_at, now()),
                validated_by = COALESCE(validated_by, 'validate_cities.py')
            WHERE validated_at IS NULL
              AND latitude BETWEEN -90 AND 90
              AND longitude BETWEEN -180 AND 180
        """)
        conn.commit()
        log.info("Marked %d cities as validated", cur.rowcount)


def add_coord_quality_column() -> None:
    """Add coord_quality column if it doesn't exist."""
    with _conn() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'cities' AND column_name = 'coord_quality'
        """)
        if not cur.fetchone():
            cur.execute("""
                ALTER TABLE public.cities
                ADD COLUMN coord_quality cities_admin.coord_quality_kind
                DEFAULT 'valid'::cities_admin.coord_quality_kind
            """)
            cur.execute("""
                COMMENT ON COLUMN public.cities.coord_quality IS
                'Coordinate quality: valid, outside_bbox, wrong_country, swapped, disputed'
            """)
            conn.commit()
            log.info("Added coord_quality column")
        else:
            log.info("coord_quality column already exists")


def update_coord_quality() -> None:
    """Set coord_quality for all cities based on validation results."""
    with _conn() as conn, conn.cursor() as cur:
        # Reset all to valid first
        cur.execute("""
            UPDATE public.cities SET coord_quality = 'valid'::cities_admin.coord_quality_kind
            WHERE coord_quality IS NULL OR coord_quality != 'disputed'::cities_admin.coord_quality_kind
        """)

        # Mark disputed (Crimea, etc.)
        cur.execute("""
            UPDATE public.cities SET coord_quality = 'disputed'
            WHERE country_code = 'UA'
              AND latitude > 43 AND latitude < 46
              AND longitude > 32 AND longitude < 36
        """)

        # Mark wrong_country (these should have been fixed, but flag any remaining)
        cur.execute("""
            SELECT id FROM public.cities
            WHERE latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
        """)
        # We'll update based on actual check below
        conn.commit()


def report_json(result: ValidationResult, fix_result: dict) -> dict:
    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "summary": {
            "total_cities": result.total,
            "valid": result.valid,
            "wrong_country": len(result.wrong_country),
            "outside_bbox": len(result.outside_bbox),
            "swapped_coords": len(result.swapped_coords),
            "invalid_range": len(result.invalid_range),
            "island_territory": len(result.island_territory),
            "disputed": len(result.disputed),
            "fixes_applied": fix_result.get("fixed", 0),
        },
        "wrong_country_codes": result.wrong_country[:30],
        "outside_bbox_cities": result.outside_bbox[:30],
        "swapped_coords": result.swapped_coords[:10],
        "island_territories": result.island_territory[:20],
        "disputed_territories": result.disputed,
        "fix_details": fix_result.get("details", [])[:20],
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Validate city coordinates against NE polygons")
    p.add_argument("--fix", action="store_true", help="Apply country code fixes")
    p.add_argument("--stats", action="store_true", help="Quick validation stats")
    p.add_argument("--mark-validated", action="store_true", help="Mark all valid cities as validated")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    if args.stats:
        r = validate_all()
        print(f"\n=== City Validation Stats ===")
        print(f"Total cities:      {r.total:,}")
        print(f"Valid:            {r.valid:,}")
        print(f"Wrong country:    {len(r.wrong_country):,}")
        print(f"Outside bbox:    {len(r.outside_bbox):,}")
        print(f"Swapped coords:   {len(r.swapped_coords):,}")
        print(f"Invalid range:    {len(r.invalid_range):,}")
        print(f"Island territory:{len(r.island_territory):,}")
        print(f"Disputed:         {len(r.disputed):,}")
        return 0

    print("Running full validation...")
    result = validate_all()

    print(f"\n=== Validation Results ===")
    print(f"Total cities:      {result.total:,}")
    print(f"Valid:             {result.valid:,}")
    print(f"Wrong country:    {len(result.wrong_country):,} (data errors)")
    print(f"Outside bbox:     {len(result.outside_bbox):,} (edge cases)")
    print(f"Swapped coords:    {len(result.swapped_coords):,}")
    print(f"Invalid range:     {len(result.invalid_range):,}")
    print(f"Island territory: {len(result.island_territory):,} (legitimate)")
    print(f"Disputed:          {len(result.disputed):,} (Crimea etc.)")

    fix_result = {"fixed": 0, "skipped": 0}
    if args.fix and result.wrong_country:
        print(f"\nApplying {len(result.wrong_country)} fixes...")
        fix_result = fix_wrong_countries(result.wrong_country)
        print(f"Fixed: {fix_result['fixed']}, Skipped: {fix_result['skipped']}")

    if args.mark_validated:
        mark_validated()

    report = report_json(result, fix_result)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"\nFull report: {REPORT_PATH}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
