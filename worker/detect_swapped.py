"""Swapped Coordinate Detector — finds articles where lat/lng appear to be swapped.

This detects when an article's extracted_lat and extracted_lng values look like
they were accidentally swapped (e.g., lat=106.0, lng=-6.0 instead of lat=-6.0, lng=106.0).

This happens when:
- Geocoder returns lat/lng but they're stored in wrong order
- Source data has lat/lng in reversed order
- Import errors from other systems

Detection uses the fact that valid latitudes are -90 to 90, and valid longitudes are -180 to 180.
If both coordinates are valid in their positions but the SWAPPED values would ALSO be valid,
we use reverse geocoding to check which placement makes sense.

Usage:
    python -m worker.detect_swapped           # detect all swapped coords
    python -m worker.detect_swapped --fix      # apply corrections
    python -m worker.detect_swapped --dry-run  # preview
"""
from __future__ import annotations

import argparse
import logging
from dataclasses import dataclass

from .db import connect
from .fast_suggest import geocode_text

log = logging.getLogger("xyzo.detect_swapped")

# Thresholds
COORD_ERROR_THRESHOLD = 0.5  # degrees - if swapped puts coords in a valid location
MIN_COUNTRY_CONFIDENCE = 0.5  # geocoder confidence for validation


@dataclass
class SwappedCoord:
    article_id: int
    title: str[:80]
    original_lat: float
    original_lng: float
    swapped_lat: float
    swapped_lng: float
    original_country: str | None
    swapped_country: str | None
    likely_correct: str  # 'original', 'swapped', 'unknown'


def is_valid_lat(lat: float) -> bool:
    return -90 <= lat <= 90


def is_valid_lng(lng: float) -> bool:
    return -180 <= lng <= 180


def geocode_to_country(lat: float, lng: float) -> str | None:
    """Reverse geocode to get country. Returns ISO code or None."""
    try:
        result = geocode_text(f"{lat},{lng}")
        if result and result.get("country"):
            return result["country"]
    except Exception:
        pass
    return None


def check_swapped(article_id: int, title: str, lat: float, lng: float) -> SwappedCoord | None:
    """Check if coordinates appear to be swapped."""
    # First check: are both original coordinates valid?
    orig_lat_valid = is_valid_lat(lat)
    orig_lng_valid = is_valid_lng(lng)

    # If original is clearly invalid (lat out of range), it's broken
    if not orig_lat_valid or not orig_lng_valid:
        return None

    # Swap the coordinates
    swapped_lat = lng
    swapped_lng = lat

    swapped_lat_valid = is_valid_lat(swapped_lat)
    swapped_lng_valid = is_valid_lng(swapped_lng)

    # If swapped coordinates are ALSO valid, we need to check which makes sense
    if swapped_lat_valid and swapped_lng_valid:
        # Both are valid - check which placement makes more sense
        orig_country = geocode_to_country(lat, lng)
        swap_country = geocode_to_country(swapped_lat, swapped_lng)

        # If original is in valid range but swapped would be in ocean/invalid area
        # and original gives a valid country, prefer original
        if orig_country and not swap_country:
            likely = "original"
        elif swap_country and not orig_country:
            likely = "swapped"
        elif swap_country and orig_country:
            # Both give valid countries - prefer the one that makes sense
            likely = "unknown"  # Need more analysis
        else:
            likely = "unknown"

        return SwappedCoord(
            article_id=article_id,
            title=title[:80] if title else "",
            original_lat=lat,
            original_lng=lng,
            swapped_lat=swapped_lat,
            swapped_lng=swapped_lng,
            original_country=orig_country,
            swapped_country=swap_country,
            likely_correct=likely,
        )

    return None


def detect_swapped_coords(limit: int = 1000) -> list[SwappedCoord]:
    """Detect articles with potentially swapped coordinates."""
    with connect() as conn, conn.cursor() as cur:
        # Find articles where lat and lng are both in technically valid ranges
        # but might be swapped (e.g., both positive when source is from Southern hemisphere)
        cur.execute("""
            SELECT
                a.id,
                a.title,
                a.extracted_lat as lat,
                a.extracted_lng as lng,
                l.country as location_country
            FROM news_articles a
            LEFT JOIN news_locations l ON l.id = a.location_id
            WHERE a.status IN ('extracted', 'clustered')
              AND a.extracted_lat IS NOT NULL
              AND a.extracted_lng IS NOT NULL
              -- Both coordinates in valid range (could be swapped)
              AND a.extracted_lat BETWEEN -90 AND 90
              AND a.extracted_lng BETWEEN -180 AND 180
              -- Latitude doesn't look like a longitude (latitude rarely > 55 or < -55 for major cities)
              AND NOT (a.extracted_lat > 55 OR a.extracted_lat < -55)
              -- Longitude doesn't look like a latitude
              AND NOT (a.extracted_lng > 55 OR a.extracted_lng < -55)
              -- But swapped values would ALSO be valid
              AND a.extracted_lng BETWEEN -90 AND 90
              AND a.extracted_lat BETWEEN -180 AND 180
            ORDER BY a.fetched_at DESC
            LIMIT %s
        """, (limit,))

        results = []
        for row in cur.fetchall():
            try:
                coord = check_swapped(
                    row["id"],
                    row["title"] or "",
                    float(row["lat"]),
                    float(row["lng"])
                )
                if coord and coord.likely_correct != "unknown":
                    results.append(coord)
            except Exception as e:
                log.debug("Error checking article %d: %s", row["id"], e)

        return results


def fix_swapped_coord(article_id: int, dry_run: bool = True) -> bool:
    """Fix swapped coordinates for an article."""
    if dry_run:
        log.info("[DRY RUN] Would fix swapped coords for article %d", article_id)
        return True

    with connect() as conn, conn.cursor() as cur:
        # Get current coordinates
        cur.execute("""
            SELECT extracted_lat, extracted_lng FROM news_articles WHERE id = %s
        """, (article_id,))
        row = cur.fetchone()
        if not row:
            return False

        lat, lng = float(row["extracted_lat"]), float(row["extracted_lng"])

        # Swap and update
        cur.execute("""
            UPDATE news_articles
            SET extracted_lat = %s,
                extracted_lng = %s,
                location_confidence = GREATEST(0, (location_confidence - 0.1))
            WHERE id = %s
        """, (lng, lat, article_id))
        conn.commit()

        log.info("Fixed swapped coords for article %d: (%f,%f) -> (%f,%f)",
                 article_id, lat, lng, lng, lat)
        return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Detect swapped coordinates in articles")
    parser.add_argument("--dry-run", action="store_true", help="Preview fixes without applying")
    parser.add_argument("--fix", action="store_true", help="Apply coordinate corrections")
    parser.add_argument("--limit", type=int, default=1000, help="Max articles to check")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.WARNING if args.dry_run else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    log.info("Detecting swapped coordinates (limit=%d)", args.limit)
    swapped = detect_swapped_coords(limit=args.limit)

    if not swapped:
        log.info("No swapped coordinates detected")
        return 0

    log.warning("Found %d articles with potentially swapped coordinates:", len(swapped))
    for s in swapped[:20]:
        likely = "SWAPPED" if s.likely_correct == "swapped" else "ORIGINAL"
        print(f"  [{likely}] Article {s.article_id}: {s.title}")
        print(f"         Original: lat={s.original_lat:.4f}, lng={s.original_lng:.4f} -> {s.original_country or '?'}")
        print(f"         Swapped:  lat={s.swapped_lat:.4f}, lng={s.swapped_lng:.4f} -> {s.swapped_country or '?'}")
        print()

    if args.fix and not args.dry_run:
        fixed = 0
        for s in swapped:
            if s.likely_correct == "swapped":
                if fix_swapped_coord(s.article_id, dry_run=False):
                    fixed += 1
        log.info("Fixed %d articles with swapped coordinates", fixed)

    return len(swapped)


if __name__ == "__main__":
    raise SystemExit(main())
