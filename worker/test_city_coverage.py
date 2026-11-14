"""City coverage testbench — verify news coverage for the world's largest cities.

Checks the top 100 cities by population and reports:
  - How many news_events exist in the last 24 hours
  - How many news_sources are within 200km
  - Whether cities_text.find_cities_in_text() detects the city name
  - Coverage gaps (cities with zero events)

Usage:
    python -m worker.test_city_coverage                  # full report
    python -m worker.test_city_coverage --top 50         # top 50 only
    python -m worker.test_city_coverage --json           # JSON output
    python -m worker.test_city_coverage --test-detection # test city name detection only
    python -m worker.test_city_coverage --hours 48       # look back 48 hours
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timezone
from typing import Any

from .db import connect
from . import cities_text

log = logging.getLogger("xyzo.test_city_coverage")

# Top 100 cities by population — hardcoded as a safety net in case the
# DB query fails. These are the canonical names we expect in world_cities.
TOP_100_CITIES = [
    "Tokyo", "Delhi", "Shanghai", "Sao Paulo", "Mumbai", "Beijing",
    "Cairo", "Dhaka", "Mexico City", "Osaka", "Karachi", "Chongqing",
    "Istanbul", "Buenos Aires", "Kolkata", "Lagos", "Kinshasa",
    "Manila", "Rio de Janeiro", "Guangzhou", "Lahore", "Shenzhen",
    "Bangalore", "Moscow", "Chennai", "Bogota", "Jakarta", "Lima",
    "Paris", "Bangkok", "Hyderabad", "Seoul", "Nagoya", "London",
    "Chengdu", "Nanjing", "Tehran", "Ho Chi Minh City", "Luanda",
    "Ahmedabad", "Kuala Lumpur", "Hong Kong", "Riyadh", "Baghdad",
    "Santiago", "Singapore", "Shenyang", "Hangzhou", "Harbin",
    "Madrid", "Zhengzhou", "Toronto", "Johannesburg", "Dar es Salaam",
    "Singapore", "Saint Petersburg", "Kunming", "Alexandria", "Sydney",
    "Melbourne", "Yangon", "Abidjan", "Dalian", "Guadalajara",
    "Washington", "Barcelona", "Jeddah", "Monterrey", "Recife",
    "Porto Alegre", "Brasilia", "Phoenix", "San Francisco", "Berlin",
    "Rome", "Montreal", "Medellin", "Kampala", "Addis Ababa",
    "Nairobi", "Cape Town", "Durban", "Pretoria", "Minsk",
    "Kyiv", "Ankara", "Baku", "Tashkent", "Havana",
    "Budapest", "Warsaw", "Vienna", "Prague", "Brussels",
    "Amsterdam", "Stockholm", "Oslo", "Copenhagen", "Helsinki",
    "Dublin", "Lisbon", "Athens", "Zurich", "Geneva",
]


def _fetch_top_cities(limit: int = 100) -> list[dict]:
    """Fetch top N cities from world_cities by population."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, ascii_name, country_code, state_name,
                   lat, lng, population
            FROM world_cities
            WHERE population > 0
            ORDER BY population DESC
            LIMIT %s
        """, (limit,))
        return cur.fetchall()


def _events_for_city(city: dict, hours: int = 24) -> int:
    """Count news_events near this city in the last N hours.

    Uses a 50km radius around the city center + also checks by
    place_name match for cases where geocoder put the event in
    the city but with slightly different coordinates.
    """
    lat = city.get("lat")
    lng = city.get("lng")
    name = city.get("name") or ""
    ascii_name = city.get("ascii_name") or ""
    cc = city.get("country_code") or ""

    with connect() as conn, conn.cursor() as cur:
        # Method 1: spatial — events within 50km of city center
        if lat is not None and lng is not None:
            cur.execute("""
                SELECT COUNT(DISTINCT e.id)
                FROM news_events e
                JOIN news_locations l ON l.id = e.primary_location_id
                WHERE e.status = 'active'
                  AND (e.expires_at IS NULL OR e.expires_at > now())
                  AND e.first_reported_at >= now() - interval '%s hours'
                  AND ST_DWithin(
                      l.geom::geography,
                      ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                      50000  -- 50km
                  )
            """, (hours, lng, lat))
            spatial_count = cur.fetchone()["count"] or 0
        else:
            spatial_count = 0

        # Method 2: name match — events whose location name contains the city
        cur.execute("""
            SELECT COUNT(DISTINCT e.id)
            FROM news_events e
            JOIN news_locations l ON l.id = e.primary_location_id
            WHERE e.status = 'active'
              AND (e.expires_at IS NULL OR e.expires_at > now())
              AND e.first_reported_at >= now() - interval '%s hours'
              AND (l.place_name ILIKE %s OR l.place_name ILIKE %s)
        """, (hours, f"%{name}%", f"%{ascii_name}%"))
        name_count = cur.fetchone()["count"] or 0

        return max(spatial_count, name_count)


def _sources_near_city(city: dict, radius_km: float = 200) -> int:
    """Count news_sources within radius_km of this city."""
    lat = city.get("lat")
    lng = city.get("lng")
    if lat is None or lng is None:
        return 0

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*)
            FROM news_sources
            WHERE active = true
              AND lat IS NOT NULL AND lng IS NOT NULL
              AND ST_DWithin(
                  ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
                  ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                  %s
              )
        """, (lng, lat, radius_km * 1000))
        return cur.fetchone()["count"] or 0


def _articles_for_city(city: dict, hours: int = 24) -> int:
    """Count news_articles mentioning this city in the last N hours."""
    name = city.get("name") or ""
    ascii_name = city.get("ascii_name") or ""

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*)
            FROM news_articles
            WHERE fetched_at >= now() - interval '%s hours'
              AND (location_text ILIKE %s OR location_text ILIKE %s
                   OR title ILIKE %s OR title ILIKE %s)
        """, (hours,
              f"%{name}%", f"%{ascii_name}%",
              f"%{name}%", f"%{ascii_name}%"))
        return cur.fetchone()["count"] or 0


def _test_detection(city_name: str) -> dict:
    """Test cities_text.find_cities_in_text() for a city name."""
    test_text = f"Breaking news from {city_name} today"
    matches = cities_text.find_cities_in_text(test_text, min_population=0)
    detected = len(matches) > 0
    best = matches[0]["city"] if matches else None
    return {
        "city": city_name,
        "detected": detected,
        "best_match": best.get("name") if best else None,
        "best_pop": best.get("population") if best else None,
        "confidence": matches[0].get("confidence") if matches else None,
    }


def run(top: int = 100, hours: int = 24, test_detection: bool = False) -> dict:
    """Run the coverage testbench.

    Returns a dict with:
      - summary: {green, yellow, red, total}
      - cities: list of per-city results
      - gaps: list of cities with zero coverage
      - detection: list of detection test results (if test_detection=True)
    """
    t0 = time.time()
    log.info("loading top %d cities...", top)
    cities = _fetch_top_cities(top)

    if not cities:
        log.warning("no cities found in world_cities, using hardcoded list")
        # Fallback: just test detection on hardcoded names
        if test_detection:
            results = [_test_detection(name) for name in TOP_100_CITIES[:top]]
            return {"detection": results, "cities": [], "summary": {"total": len(results)}}
        return {"cities": [], "summary": {"total": 0, "error": "no cities in DB"}}

    results = []
    gaps = []
    green = yellow = red = 0

    for idx, city in enumerate(cities, 1):
        name = city.get("name") or ""
        cc = city.get("country_code") or ""
        pop = city.get("population") or 0

        event_count = _events_for_city(city, hours)
        source_count = _sources_near_city(city)
        article_count = _articles_for_city(city, hours)

        if event_count >= 3:
            status = "green"
            green += 1
        elif event_count >= 1:
            status = "yellow"
            yellow += 1
        else:
            status = "red"
            red += 1
            gaps.append({
                "city": name,
                "country": cc,
                "population": pop,
                "lat": city.get("lat"),
                "lng": city.get("lng"),
                "nearby_sources": source_count,
            })

        entry = {
            "rank": idx,
            "city": name,
            "country": cc,
            "population": pop,
            "lat": city.get("lat"),
            "lng": city.get("lng"),
            "events_24h": event_count,
            "articles_24h": article_count,
            "nearby_sources": source_count,
            "status": status,
        }

        if test_detection:
            det = _test_detection(name)
            entry["detection"] = det

        results.append(entry)

        if idx % 10 == 0:
            log.info("checked %d/%d cities (%d green, %d yellow, %d red)",
                     idx, len(cities), green, yellow, red)

    summary = {
        "total": len(cities),
        "green": green,
        "yellow": yellow,
        "red": red,
        "coverage_pct": round(100 * (green + yellow) / max(len(cities), 1), 1),
        "gaps": len(gaps),
        "hours": hours,
        "duration_s": round(time.time() - t0, 1),
    }

    log.info("coverage testbench done: %s", summary)
    return {
        "summary": summary,
        "cities": results,
        "gaps": gaps,
    }


def _print_table(report: dict) -> None:
    """Pretty-print the report as a table."""
    summary = report.get("summary", {})
    print(f"\n{'='*80}")
    print(f"  NEWSIUM CITY COVERAGE REPORT — Top {summary.get('total', '?')} cities")
    print(f"  Looking back: {summary.get('hours', 24)} hours")
    print(f"{'='*80}")
    print(f"  GREEN (≥3 events):  {summary.get('green', 0)}")
    print(f"  YELLOW (1-2):       {summary.get('yellow', 0)}")
    print(f"  RED (0 events):     {summary.get('red', 0)}")
    print(f"  Coverage:           {summary.get('coverage_pct', 0)}%")
    print(f"  Duration:           {summary.get('duration_s', 0)}s")
    print(f"{'='*80}\n")

    # Print city rows
    print(f"  {'#':>3}  {'City':<25} {'Country':<5} {'Pop':>10} {'Events':>7} {'Sources':>8} {'Status':<6}")
    print(f"  {'─'*3}  {'─'*25} {'─'*5} {'─'*10} {'─'*7} {'─'*8} {'─'*6}")

    icons = {"green": "🟢", "yellow": "🟡", "red": "🔴"}
    for c in report.get("cities", []):
        icon = icons.get(c["status"], "?")
        pop_str = f"{c['population']:,}" if c.get("population") else "?"
        print(f"  {c['rank']:>3}  {c['city']:<25} {c['country']:<5} {pop_str:>10} "
              f"{c['events_24h']:>7} {c['nearby_sources']:>8} {icon} {c['status']}")

    # Print gaps
    gaps = report.get("gaps", [])
    if gaps:
        print(f"\n{'─'*80}")
        print(f"  COVERAGE GAPS ({len(gaps)} cities with 0 events):")
        print(f"{'─'*80}")
        for g in gaps:
            pop_str = f"{g['population']:,}" if g.get("population") else "?"
            print(f"  • {g['city']}, {g['country']} (pop {pop_str}) — "
                  f"{g.get('nearby_sources', 0)} nearby sources")
    print()


def main():
    parser = argparse.ArgumentParser(description="City coverage testbench")
    parser.add_argument("--top", type=int, default=100,
                        help="Number of top cities to check (default 100)")
    parser.add_argument("--hours", type=int, default=24,
                        help="Hours to look back (default 24)")
    parser.add_argument("--json", action="store_true",
                        help="Output as JSON")
    parser.add_argument("--test-detection", action="store_true",
                        help="Also test city name detection")
    parser.add_argument("--output", type=str, default=None,
                        help="Write JSON report to file")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    report = run(
        top=args.top,
        hours=args.hours,
        test_detection=args.test_detection,
    )

    if args.json:
        json.dump(report, sys.stdout, indent=2, default=str)
        sys.stdout.write("\n")
    else:
        _print_table(report)

    if args.output:
        with open(args.output, "w") as f:
            json.dump(report, f, indent=2, default=str)
        log.info("report written to %s", args.output)

    # Exit with non-zero if coverage is below 50%
    pct = report.get("summary", {}).get("coverage_pct", 0)
    if pct < 50:
        log.warning("coverage below 50%% (%s%%) — exiting with code 1", pct)
        sys.exit(1)


if __name__ == "__main__":
    main()
