"""Download and build a global cities database.

This module downloads city data from GeoNames (free, comprehensive) and:
  1. Saves to PostgreSQL table for server-side queries
  2. Saves to JSON file for client-side text parsing
  3. Includes all cities with population >= 100,000

Usage:
  python -m worker.build_cities_db --download    # Download fresh data
  python -m worker.build_cities_db --export       # Export to JSON
  python -m worker.build_cities_db --stats        # Show statistics
"""

import csv
import io
import json
import logging
import time
from pathlib import Path

import httpx

from .db import connect

log = logging.getLogger("xyzo.cities_db")

# GeoNames download URL for cities with population >= 1000
# We'll filter to >= 100,000 after download
GEONAMES_CITIES_URL = "https://download.geonames.org/export/dump/cities15000.zip"
GEONAMES_ALL_CITIES_URL = "https://download.geonames.org/export/dump/cities5000.zip"

OUTPUT_DIR = Path(__file__).parent.parent / "data"
CITIES_JSON = OUTPUT_DIR / "cities.json"
CITIES_MIN_JSON = OUTPUT_DIR / "cities.min.json"


def download_cities() -> list[dict]:
    """Download cities from GeoNames and parse them."""
    import zipfile

    log.info("Downloading cities from GeoNames...")
    cities = []

    with httpx.Client(timeout=120) as client:
        resp = client.get(GEONAMES_CITIES_URL, follow_redirects=True)
        resp.raise_for_status()

        # Extract ZIP in memory
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            # Find the .txt file inside
            txt_files = [f for f in zf.namelist() if f.endswith('.txt')]
            if not txt_files:
                raise ValueError("No .txt file found in ZIP")

            with zf.open(txt_files[0]) as f:
                # GeoNames tab-separated format
                # Fields: geonameid, name, asciiname, alternatenames, lat, lng,
                #         feature class, feature code, country code, cc2, admin1, admin2,
                #         admin3, admin4, population, elevation, dem, timezone, modification date
                reader = csv.reader(io.TextIOWrapper(f, encoding='utf-8'), delimiter='\t')

                for row in reader:
                    try:
                        if len(row) < 19:
                            continue

                        population = int(row[14]) if row[14] else 0
                        if population < 100000:
                            continue

                        lat = float(row[4])
                        lng = float(row[5])

                        city = {
                            "geoname_id": int(row[0]),
                            "name": row[1],
                            "ascii_name": row[2],
                            "country_code": row[8],
                            "admin1_code": row[10],  # State/region code
                            "admin2_code": row[11],  # County/province
                            "lat": lat,
                            "lng": lng,
                            "population": population,
                            "timezone": row[17],
                            "feature_code": row[7],
                        }
                        cities.append(city)
                    except (ValueError, IndexError) as e:
                        continue

    log.info("Downloaded %d cities with population >= 100,000", len(cities))
    return cities


def get_admin1_names() -> dict:
    """Download admin1 codes (state/region names) from GeoNames."""
    url = "https://download.geonames.org/export/dump/admin1CodesASCII.txt"
    admin1 = {}

    try:
        with httpx.Client(timeout=30) as client:
            resp = client.get(url, follow_redirects=True)
            resp.raise_for_status()

            for line in resp.text.split('\n'):
                if not line.strip():
                    continue
                parts = line.split('\t')
                if len(parts) >= 2:
                    # Format: CC.Admin1Code, name, ...
                    key = parts[0]  # e.g. "US.CA"
                    name = parts[1]
                    admin1[key] = name
    except Exception as e:
        log.warning("Failed to download admin1 codes: %s", e)

    return admin1


def enrich_cities(cities: list[dict]) -> list[dict]:
    """Add state/region names to cities."""
    admin1 = get_admin1_names()

    for city in cities:
        cc = city["country_code"]
        admin1_code = city.get("admin1_code", "")

        # Look up state/region name
        key = f"{cc}.{admin1_code}"
        city["state_name"] = admin1.get(key, admin1_code)

        # Clean up name
        city["name"] = city["name"].strip()
        city["ascii_name"] = city["ascii_name"].strip()

    return cities


def save_to_database(cities: list[dict]) -> int:
    """Save cities to xyzo_cities.public.cities (the canonical reference).

    Also writes through the xyzo.world_cities foreign table for
    backward compatibility with code that hasn't been ported yet.
    """
    import os
    import psycopg
    writer_dsn = os.environ.get(
        "XYZO_CITIES_WRITER_DSN",
        "postgresql://cities_writer:CHANGE_ME@localhost:5432/xyzo_cities",
    )
    log.info("Saving %d cities to xyzo_cities...", len(cities))

    inserted = 0
    with psycopg.connect(writer_dsn) as conn, conn.cursor() as cur:
        for city in cities:
            try:
                search_text = " | ".join(filter(None, [
                    city.get("ascii_name", ""),
                    city.get("name", ""),
                    city.get("country_code", ""),
                ])).lower()
                cur.execute("""
                    INSERT INTO public.cities (
                        geoname_id, name, ascii_name, country_code,
                        state_code, state_name,
                        latitude, longitude, population,
                        timezone, feature_code, source,
                        validated_at, validated_by, search_text
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                              'geonames'::cities_admin.source_kind,
                              now(), 'build_cities_db.py', %s)
                    ON CONFLICT (geoname_id) DO UPDATE SET
                        name = EXCLUDED.name,
                        ascii_name = EXCLUDED.ascii_name,
                        state_name = EXCLUDED.state_name,
                        latitude = EXCLUDED.latitude,
                        longitude = EXCLUDED.longitude,
                        population = EXCLUDED.population,
                        validated_at = EXCLUDED.validated_at
                """, (
                    city["geoname_id"], city["name"], city["ascii_name"],
                    city["country_code"], city.get("admin1_code", ""),
                    city.get("state_name", ""),
                    city["lat"], city["lng"], city["population"],
                    city.get("timezone", ""), city.get("feature_code", ""),
                    search_text,
                ))
                inserted += 1
            except Exception as e:
                log.warning("Failed to insert %s: %s", city["name"], e)
        conn.commit()

    log.info("Inserted/updated %d cities", inserted)
    return inserted


def _is_urban_area_name(name: str) -> bool:
    """Return True if this is an urban/metropolitan area name, not a real city."""
    lower = name.lower()
    # GeoNames uses these suffixes for metropolitan area aggregates
    if "metropolitan" in lower:
        return True
    if "urban area" in lower:
        return True
    # "Greater X" is always a region, not a city
    if lower.startswith("greater "):
        return True
    return False


def export_to_json(cities: list[dict], include_urban_areas: bool = False) -> dict:
    """Export cities to JSON files for client-side use.

    Args:
        cities: list of city dicts
        include_urban_areas: if False (default), excludes metropolitan/urban-area
            entries so the client-side index stays focused on real cities.
    """
    OUTPUT_DIR.mkdir(exist_ok=True)

    if not include_urban_areas:
        before = len(cities)
        cities = [c for c in cities if not _is_urban_area_name(c.get("name", ""))]
        log.info("Filtered %d urban-area entries, %d cities remain",
                 before - len(cities), len(cities))

    # Full version with all data
    with open(CITIES_JSON, 'w', encoding='utf-8') as f:
        json.dump({
            "version": "1.0",
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "count": len(cities),
            "cities": cities,
        }, f, ensure_ascii=False, indent=2)

    # Minified version for production (just essential fields)
    min_cities = []
    for c in cities:
        min_cities.append({
            "n": c["name"],
            "a": c["ascii_name"],
            "cc": c["country_code"],
            "s": c.get("state_name", ""),
            "la": round(c["lat"], 4),
            "ln": round(c["lng"], 4),
            "p": c["population"],
        })

    with open(CITIES_MIN_JSON, 'w', encoding='utf-8') as f:
        json.dump(min_cities, f, ensure_ascii=False, separators=(',', ':'))

    log.info("Exported to %s (%d KB) and %s (%d KB)",
             CITIES_JSON.name, CITIES_JSON.stat().st_size // 1024,
             CITIES_MIN_JSON.name, CITIES_MIN_JSON.stat().st_size // 1024)

    return {
        "full_path": str(CITIES_JSON),
        "full_size": CITIES_JSON.stat().st_size,
        "min_path": str(CITIES_MIN_JSON),
        "min_size": CITIES_MIN_JSON.stat().st_size,
    }


def get_stats() -> dict:
    """Get statistics about the cities database."""
    with connect() as conn, conn.cursor() as cur:
        # world_cities is now a foreign table to xyzo_cities. The
        # FDW maps lat/lng to latitude/longitude transparently for
        # most queries, but stats() reads multiple rows so we cast
        # explicitly here for clarity.
        cur.execute("SELECT COUNT(*) as total FROM world_cities")
        total = cur.fetchone()["total"]

        cur.execute("""
            SELECT country_code, COUNT(*) as count, SUM(population) as total_pop
            FROM world_cities
            GROUP BY country_code
            ORDER BY count DESC
            LIMIT 20
        """)
        by_country = cur.fetchall()

        cur.execute("SELECT MIN(population) as min_pop, MAX(population) as max_pop, AVG(population) as avg_pop FROM world_cities")
        pop_stats = cur.fetchone()

    return {
        "total_cities": total,
        "by_country": [{"country": r["country_code"], "count": r["count"], "population": r["total_pop"]} for r in by_country],
        "population": {
            "min": pop_stats["min_pop"],
            "max": pop_stats["max_pop"],
            "avg": int(pop_stats["avg_pop"]) if pop_stats["avg_pop"] else 0,
        },
    }


def find_cities_in_text(text: str, min_population: int = 500000) -> list[dict]:
    """Find city names mentioned in text using the database.

    This is the fast, non-AI approach. It searches for city names
    in the text and returns matches sorted by population.
    """
    if not text or len(text) < 3:
        return []

    with connect() as conn, conn.cursor() as cur:
        # Find cities whose names appear in the text
        # We use a simple LIKE search, but only for cities above min_population
        cur.execute("""
            SELECT name, ascii_name, country_code, state_name, lat, lng, population
            FROM world_cities
            WHERE population >= %s
              AND (
                %s ILIKE '%%' || name || '%%'
                OR %s ILIKE '%%' || ascii_name || '%%'
              )
            ORDER BY population DESC
            LIMIT 10
        """, (min_population, text, text))

        results = []
        for row in cur.fetchall():
            results.append({
                "name": row["name"],
                "state": row["state_name"],
                "country": row["country_code"],
                "lat": float(row["lat"]),
                "lng": float(row["lng"]),
                "population": int(row["population"]),
            })

    return results


# CLI entry point
if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    parser = argparse.ArgumentParser(description="Build global cities database")
    parser.add_argument("--download", action="store_true", help="Download fresh data from GeoNames")
    parser.add_argument("--export", action="store_true", help="Export to JSON files")
    parser.add_argument("--stats", action="store_true", help="Show statistics")
    parser.add_argument("--test", type=str, help="Test finding cities in text")
    args = parser.parse_args()

    if args.download:
        cities = download_cities()
        cities = enrich_cities(cities)
        save_to_database(cities)
        export_to_json(cities)
        print(f"\nDownloaded and saved {len(cities)} cities")

    elif args.export:
        # Re-export from xyzo_cities (the canonical source) via the
        # xyzo.world_cities FDW proxy.
        from .load_cities import export_json as load_export
        info = load_export()
        print(f"\nExported {info['count']:,} cities to {info['min_path']}")

    elif args.stats:
        stats = get_stats()
        print(f"\n=== Cities Database Statistics ===")
        print(f"Total cities: {stats['total_cities']}")
        print(f"Population range: {stats['population']['min']:,} - {stats['population']['max']:,}")
        print(f"Average population: {stats['population']['avg']:,}")
        print(f"\nTop 20 countries by city count:")
        for c in stats["by_country"]:
            print(f"  {c['country']}: {c['count']} cities ({c['population']:,} total pop)")

    elif args.test:
        results = find_cities_in_text(args.test)
        print(f"\nCities found in text: \"{args.test}\"")
        for r in results:
            print(f"  {r['name']}, {r['state']}, {r['country']} (pop: {r['population']:,}) at {r['lat']}, {r['lng']}")

    else:
        parser.print_help()
