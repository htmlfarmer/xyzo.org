"""Newsium cities loader.

Ingests a CSV of cities (population >= 100,000) into `world_cities`,
validates each row, auto-corrects where safe, flags anomalies for
review, and writes a load report.

The user's CSV columns:
    city,lat,lng,country,state,population

Validation pipeline (per row):
    1. Hard checks: lat in [-90,90], lng in [-180,180], population > 0,
       name + country non-empty.
    2. Normalize country to ISO 3166-1 alpha-2 (reuse learn.normalize_country).
    3. Title-case the city name; ASCII-fold.
    4. Match against existing world_cities rows by (lower(name), country_code):
         - exact match: UPDATE population + source='merged'; preserve geoname_id
         - no match:     INSERT new row, source='user_csv'
    5. Anomaly detection (flag, don't reject):
         - lat/lng outside plausible country bbox
         - population wildly out of country range
         - name == country name (likely placeholder)

After the load:
    - regenerate data/cities.min.json for the JS bundle
    - emit load_cities_report.json to data/

Usage:
    python -m worker.load_cities --csv /home/asher/Downloads/cities.csv
    python -m worker.load_cities --csv /path/to/cities.csv --no-export
    python -m worker.load_cities --stats
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import re
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any

from .db import connect
from .learn import normalize_country
import os

# xyzo_cities writes go through cities_writer; reads stay on xyzo
# (which proxies to xyzo_cities via FDW).
CITIES_WRITER_DSN = os.environ.get(
    "XYZO_CITIES_WRITER_DSN",
    "postgresql://cities_writer:CHANGE_ME@localhost:5432/xyzo_cities",
)


def _cities_conn():
    """Connection to xyzo_cities (writable)."""
    import psycopg
    from psycopg.rows import dict_row
    return psycopg.connect(CITIES_WRITER_DSN, row_factory=dict_row)

log = logging.getLogger("xyzo.load_cities")

OUTPUT_DIR = Path(__file__).parent.parent / "data"
CITIES_JSON = OUTPUT_DIR / "cities.json"
CITIES_MIN_JSON = OUTPUT_DIR / "cities.min.json"
REPORT_JSON = OUTPUT_DIR / "cities_load_report.json"

# Reasonable per-country lat/lng bounding boxes for anomaly detection.
# Conservative — only fires for cities well outside plausible country
# territory (e.g. a "Tokyo" reported at lat=10).
COUNTRY_BBOX: dict[str, tuple[float, float, float, float]] = {
    # (min_lat, max_lat, min_lng, max_lng)
    "US": (17.5, 72.0, -180.0, -64.0),  # contiguous + AK + HI + PR
    "CA": (42.0, 72.0, -140.0, -52.0),
    "MX": (14.0, 33.0, -118.0, -86.0),
    "BR": (-34.0,  6.0,  -74.0, -34.0),
    "AR": (-56.0, -21.0, -74.0, -53.0),
    "GB": (49.0, 61.0,  -8.0,  2.0),
    "FR": (41.0, 51.0,  -5.0, 10.0),
    "DE": (47.0, 55.0,   6.0, 15.0),
    "IT": (36.0, 47.0,   6.0, 19.0),
    "ES": (27.0, 44.0, -10.0,  5.0),
    "PT": (32.0, 42.0, -10.0, -6.0),
    "NL": (50.0, 54.0,   3.0,  8.0),
    "PL": (49.0, 55.0,  14.0, 25.0),
    "UA": (44.0, 53.0,  22.0, 41.0),
    "RU": (41.0, 82.0,  19.0, 180.0),
    "TR": (35.0, 43.0,  25.0, 47.0),
    "EG": (21.0, 32.0,  24.0, 37.0),
    "NG": ( 4.0, 14.0,   2.0, 15.0),
    "ZA": (-35.0, -22.0, 16.0, 33.0),
    "KE": ( -5.0,  5.0,  33.0, 42.0),
    "ET": ( 3.0, 15.0,  32.0, 48.0),
    "MA": (27.0, 36.0, -13.0,  0.0),
    "IN": ( 6.0, 36.0,  68.0, 98.0),
    "PK": (23.0, 37.0,  60.0, 78.0),
    "BD": (20.0, 27.0,  88.0, 93.0),
    "CN": (18.0, 54.0,  73.0, 135.0),
    "JP": (24.0, 46.0, 127.0, 146.0),  # incl. Okinawa (127.7°E)
    "KR": (33.0, 39.0, 124.0, 132.0),
    "KP": (37.0, 43.0, 124.0, 131.0),
    "VN": ( 8.0, 24.0, 102.0, 110.0),
    "TH": ( 5.0, 21.0,  97.0, 106.0),
    "ID": (-11.0,  6.0,  94.0, 141.0),
    "PH": ( 4.0, 21.0, 117.0, 127.0),
    "MY": ( 0.5,  7.0,  99.0, 119.0),
    "SG": ( 1.0,  2.0, 103.0, 105.0),
    "AU": (-44.0, -10.0, 112.0, 154.0),
    "NZ": (-48.0, -34.0, 165.0, 179.0),
    "IR": (24.0, 40.0,  44.0, 64.0),
    "IQ": (29.0, 38.0,  38.0, 49.0),
    "SA": (15.0, 33.0,  34.0, 56.0),
    "AE": (22.0, 27.0,  51.0, 57.0),
    "IL": (29.0, 34.0,  34.0, 36.0),
    "PS": (31.0, 33.0,  34.0, 36.0),
    "LB": (33.0, 35.0,  35.0, 37.0),
    "JO": (29.0, 34.0,  34.0, 40.0),
    "AF": (29.0, 39.0,  60.0, 75.0),
    "YE": (12.0, 19.0,  42.0, 54.0),
}


def ascii_fold(s: str) -> str:
    """Strip diacritics + lowercase. 'São Paulo' -> 'sao paulo'."""
    if not s:
        return ""
    nfd = unicodedata.normalize("NFD", s)
    stripped = "".join(c for c in nfd if unicodedata.category(c) != "Mn")
    return unicodedata.normalize("NFC", stripped).lower().strip()


def title_case(s: str) -> str:
    if not s:
        return ""
    # Title-case words, but keep all-caps acronyms (e.g. "NYC").
    out: list[str] = []
    for word in re.split(r"(\s+|[-–—])", s.strip()):
        if not word or word.isspace() or word in "-–—":
            out.append(word)
            continue
        if word.isupper() and len(word) <= 4:
            out.append(word)
            continue
        out.append(word[:1].upper() + word[1:].lower())
    return "".join(out)


def validate_row(raw: dict) -> tuple[dict | None, list[str]]:
    """Validate + normalize one CSV row. Returns (cleaned, anomalies)."""
    anomalies: list[str] = []
    name = (raw.get("city") or "").strip()
    country = (raw.get("country") or "").strip()
    state = (raw.get("state") or "").strip()

    if not name:
        return None, ["missing_name"]
    if not country:
        return None, ["missing_country"]

    try:
        lat = float(raw.get("lat") or "")
        lng = float(raw.get("lng") or "")
    except (TypeError, ValueError):
        return None, ["bad_lat_lng"]

    try:
        population = int(float(raw.get("population") or 0))
    except (TypeError, ValueError):
        return None, ["bad_population"]

    if not (-90.0 <= lat <= 90.0):
        return None, ["lat_out_of_range"]
    if not (-180.0 <= lng <= 180.0):
        return None, ["lng_out_of_range"]
    if population <= 0:
        return None, ["population_zero"]

    cc = normalize_country(country)
    if not cc:
        anomalies.append(f"country_unrecognized:{country}")
        # Reject when we can't map to a real ISO code. Falling back to
        # "first two letters" would mislabel e.g. Angola as AN
        # (Netherlands Antilles, deleted). Better to skip than to put
        # a city in the wrong country.
        return None, anomalies
    cc_iso = cc.upper()

    # Anomaly: bbox check.
    bbox = COUNTRY_BBOX.get(cc_iso)
    if bbox:
        min_lat, max_lat, min_lng, max_lng = bbox
        if not (min_lat <= lat <= max_lat and min_lng <= lng <= max_lng):
            anomalies.append(f"bbox_out:{cc_iso}")

    # Anomaly: population out of plausible range for the file
    # (we'll cross-check against DB after load).

    # Anomaly: state == country (likely placeholder).
    if state and state.strip().lower() == country.lower():
        anomalies.append("state_equals_country")

    cleaned = {
        "name": title_case(name),
        "ascii_name": title_case(ascii_fold(name)),
        "country_code": cc_iso,
        "country_name": country,
        "state_name": state if state and state.lower() != country.lower() else None,
        "lat": lat,
        "lng": lng,
        "population": population,
    }
    return cleaned, anomalies


def load_csv(path: Path) -> dict:
    """Load a CSV file, validate, merge into world_cities.

    Returns a report dict with counts + anomaly lists.
    """
    if not path.exists():
        raise FileNotFoundError(path)

    t0 = time.time()
    rows = list(csv.DictReader(path.open(encoding="utf-8")))
    log.info("read %d rows from %s", len(rows), path)

    validated: list[dict] = []
    rejected: list[dict] = []
    anomaly_summary: dict[str, int] = {}

    for raw in rows:
        cleaned, anomalies = validate_row(raw)
        for a in anomalies:
            anomaly_summary[a] = anomaly_summary.get(a, 0) + 1
        if cleaned is None:
            rejected.append({"raw": raw, "issues": anomalies})
            continue
        cleaned["anomalies"] = anomalies
        validated.append(cleaned)

    log.info("validated %d / rejected %d", len(validated), len(rejected))

    # Group by (ascii_name, country_code) for dedup.
    grouped: dict[tuple[str, str], list[dict]] = {}
    for row in validated:
        key = (row["ascii_name"], row["country_code"])
        grouped.setdefault(key, []).append(row)

    # Pick the entry with the largest population as canonical for each group.
    canonical: list[dict] = []
    duplicates: list[dict] = []
    for key, group in grouped.items():
        group.sort(key=lambda r: r["population"], reverse=True)
        canonical.append(group[0])
        for extra in group[1:]:
            duplicates.append({
                "kept": group[0]["name"],
                "dropped": extra,
                "reason": "case_or_dup_in_csv",
            })

    log.info("after dedup: %d canonical, %d duplicates", len(canonical), len(duplicates))

    # Cross-check against DB.
    inserted = 0
    updated = 0
    matched_existing = 0
    new_rows = 0
    population_anomalies: list[dict] = []

    with _cities_conn() as conn, conn.cursor() as cur:
        for row in canonical:
            # Look for an existing row by (lower(name), country_code).
            # Compare against lowercase ascii_name directly. The query
            # runs against xyzo_cities (where world_cities has been
            # folded into public.cities with longitude/latitude columns).
            cur.execute("""
                SELECT id, geoname_id, population, latitude, longitude
                FROM public.cities
                WHERE lower(ascii_name) = %s AND country_code = %s
                ORDER BY population DESC NULLS LAST
                LIMIT 1
            """, (row["ascii_name"].lower(), row["country_code"]))
            existing = cur.fetchone()

            if existing:
                matched_existing += 1
                # Update: prefer user's population if larger; always
                # mark source as 'merge' so we know it was cross-validated.
                new_pop = max(int(existing["population"] or 0), row["population"])
                # Flag if user's lat/lng disagrees wildly (>2 degrees).
                if existing["latitude"] is not None and existing["longitude"] is not None:
                    dlat = abs(float(existing["latitude"]) - row["lat"])
                    dlng = abs(float(existing["longitude"]) - row["lng"])
                    if dlat > 2 or dlng > 2:
                        row["anomalies"].append(f"db_position_disagree:{dlat:.2f},{dlng:.2f}")
                notes = "; ".join(row["anomalies"]) if row["anomalies"] else None
                cur.execute("""
                    UPDATE public.cities
                       SET population   = %s,
                           source       = 'merge'::cities_admin.source_kind,
                           validated_at = now(),
                           validated_by = 'load_cities.py',
                           notes        = COALESCE(%s, notes)
                     WHERE id = %s
                """, (new_pop, notes, existing["id"]))
                updated += 1
            else:
                # Insert new row.
                notes = "; ".join(row["anomalies"]) if row["anomalies"] else None
                search_text = " | ".join(filter(None, [
                    row["ascii_name"], row["name"], row["country_name"]
                ])).lower()
                cur.execute("""
                    INSERT INTO public.cities (
                        name, ascii_name, country_code, state_name,
                        latitude, longitude, population, source,
                        validated_at, validated_by, notes, search_text
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s,
                              'user_csv'::cities_admin.source_kind,
                              now(), 'load_cities.py', %s, %s)
                """, (
                    row["name"], row["ascii_name"], row["country_code"],
                    row["state_name"], row["lat"], row["lng"], row["population"],
                    notes, search_text,
                ))
                new_rows += 1

            # Per-row population sanity vs country peers (skip for performance;
            # we run a global sanity query after the loop).

        # Final cross-check: are any new rows wildly off vs country average?
        cur.execute("""
            WITH country_stats AS (
                SELECT country_code,
                       percentile_cont(0.5) WITHIN GROUP (ORDER BY population) AS median_pop,
                       COUNT(*) AS n
                FROM public.cities
                WHERE population > 0
                GROUP BY country_code
            )
            SELECT wc.id, wc.name, wc.country_code, wc.population, cs.median_pop
            FROM public.cities wc
            JOIN country_stats cs ON cs.country_code = wc.country_code
            WHERE wc.population > 0
              AND cs.median_pop > 0
              AND (
                wc.population > cs.median_pop * 100
                OR (wc.population < cs.median_pop / 100 AND cs.n > 5)
              )
        """)
        for r in cur.fetchall():
            population_anomalies.append({
                "id": int(r["id"]),
                "name": r["name"],
                "country": r["country_code"],
                "population": int(r["population"]),
                "country_median": int(r["median_pop"]),
            })

        conn.commit()

    elapsed = time.time() - t0
    report = {
        "csv_path": str(path),
        "loaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "elapsed_s": round(elapsed, 2),
        "rows_read": len(rows),
        "rows_validated": len(validated),
        "rows_rejected": rejected,
        "rows_canonical_after_dedup": len(canonical),
        "duplicates_in_csv": duplicates,
        "matched_existing_in_db": matched_existing,
        "rows_updated": updated,
        "rows_inserted": new_rows,
        "anomaly_summary": dict(sorted(anomaly_summary.items(), key=lambda kv: -kv[1])),
        "population_anomalies": population_anomalies[:50],
        "population_anomaly_total": len(population_anomalies),
    }

    log.info(
        "done: read=%d validated=%d canonical=%d matched=%d updated=%d inserted=%d rejected=%d in %.1fs",
        report["rows_read"], report["rows_validated"], report["rows_canonical_after_dedup"],
        matched_existing, updated, new_rows, len(rejected), elapsed,
    )
    return report


def export_json(min_pop: int = 100000) -> dict:
    """Regenerate data/cities.json + data/cities.min.json from xyzo_cities.

    Args:
        min_pop: Minimum population threshold. Default 100000 for map bundle.
                 Use 10000 to generate a comprehensive autocomplete bundle.
    """
    OUTPUT_DIR.mkdir(exist_ok=True)
    with _cities_conn() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, geoname_id, name, ascii_name, country_code,
                   state_name, latitude, longitude, population, source
            FROM public.cities
            WHERE population >= %s
            ORDER BY population DESC
        """, (min_pop,))
        rows = [dict(r) for r in cur.fetchall()]

    full_path = OUTPUT_DIR / "cities.json"
    with full_path.open("w", encoding="utf-8") as f:
        json.dump({
            "version": "3.0",
            "source_db": "xyzo_cities",
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "count": len(rows),
            "cities": rows,
        }, f, ensure_ascii=False, indent=2)

    bundle_name = "cities.min.json" if min_pop == 100000 else f"cities.{min_pop // 1000}k.json"
    min_path = OUTPUT_DIR / bundle_name
    min_cities = [
        {
            "n": r["name"],
            "a": r["ascii_name"],
            "cc": r["country_code"],
            "s": r["state_name"] or "",
            "la": round(float(r["latitude"]), 4),
            "ln": round(float(r["longitude"]), 4),
            "p": int(r["population"]),
        }
        for r in rows
    ]
    with min_path.open("w", encoding="utf-8") as f:
        json.dump(min_cities, f, ensure_ascii=False, separators=(",", ":"))

    if min_pop == 100000:
        public_min = OUTPUT_DIR.parent / "public_html" / "data" / "cities.min.json"
        public_min.parent.mkdir(exist_ok=True)
        public_min.write_bytes(min_path.read_bytes())

    return {
        "full_path": str(full_path),
        "full_size": full_path.stat().st_size,
        "min_path": str(min_path),
        "min_size": min_path.stat().st_size,
        "count": len(rows),
    }


def stats() -> dict:
    """Show xyzo_cities statistics."""
    with _cities_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT source::text AS source, COUNT(*)::int AS n FROM public.cities GROUP BY 1 ORDER BY 2 DESC")
        by_source = cur.fetchall()
        cur.execute("""
            SELECT COUNT(*)::int AS n, COUNT(DISTINCT country_code)::int AS countries,
                   SUM(population)::bigint AS total_pop
            FROM public.cities WHERE population >= 100000
        """)
        head = cur.fetchone()
        cur.execute("""
            SELECT country_code, COUNT(*)::int AS n
            FROM public.cities
            WHERE population >= 100000
            GROUP BY 1 ORDER BY 2 DESC LIMIT 10
        """)
        top_countries = cur.fetchall()
    return {
        "by_source": by_source,
        "headline": head,
        "top_countries": top_countries,
    }


def write_report(report: dict) -> Path:
    OUTPUT_DIR.mkdir(exist_ok=True)
    with REPORT_JSON.open("w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2, default=str)
    return REPORT_JSON


def main() -> int:
    p = argparse.ArgumentParser(description="Newsium cities loader")
    p.add_argument("--csv", type=Path, help="Path to cities CSV")
    p.add_argument("--no-export", action="store_true",
                   help="Skip regenerating JSON bundle")
    p.add_argument("--stats", action="store_true", help="Show stats and exit")
    p.add_argument("--export-only", action="store_true",
                   help="Only regenerate JSON from current DB state")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    if args.stats:
        s = stats()
        print("\n=== world_cities ===")
        print(f"Rows (pop>=100k): {s['headline']['n']:,}")
        print(f"Countries: {s['headline']['countries']}")
        print(f"Total population: {s['headline']['total_pop']:,}")
        print("\nBy source:")
        for r in s["by_source"]:
            print(f"  {r['source']}: {r['n']:,}")
        print("\nTop 10 countries by city count:")
        for r in s["top_countries"]:
            print(f"  {r['country_code']}: {r['n']:,}")
        return 0

    if args.export_only:
        for pop in (100000, 10000):
            info = export_json(min_pop=pop)
            print(f"Exported {info['count']:,} cities (pop>={pop // 1000}k) to {info['min_path']} "
                  f"({info['min_size'] // 1024} KB)")
        return 0

    if not args.csv:
        p.error("--csv is required (or use --stats / --export-only)")

    report = load_csv(args.csv)
    write_report(report)

    # Print a brief summary regardless of log level.
    print("\n=== Cities Load Report ===")
    print(f"Source: {report['csv_path']}")
    print(f"Rows read: {report['rows_read']}")
    print(f"Validated: {report['rows_validated']}")
    print(f"Rejected: {len(report['rows_rejected'])}")
    print(f"Canonical (after dedup): {report['rows_canonical_after_dedup']}")
    print(f"Matched existing DB rows: {report['matched_existing_in_db']}")
    print(f"Updated: {report['rows_updated']}")
    print(f"Inserted: {report['rows_inserted']}")
    print(f"Population anomalies: {report['population_anomaly_total']}")
    print(f"Elapsed: {report['elapsed_s']}s")
    if report["anomaly_summary"]:
        print("\nTop anomalies:")
        for k, v in list(report["anomaly_summary"].items())[:8]:
            print(f"  {k}: {v}")
    print(f"\nFull report: {REPORT_JSON}")

    if not args.no_export:
        info = export_json()
        print(f"\nRegenerated JS bundle: {info['min_path']} "
              f"({info['count']:,} cities, {info['min_size'] // 1024} KB)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
