#!/usr/bin/env python3
"""
Fix mislocated articles: articles where extracted_lat/lng point to one city
but location_id points to a different city (e.g., Mumbai coords with Delhi location).

Usage:
    python -m worker.fix_mislocated --dry-run     # preview only
    python -m worker.fix_mislocated --limit 1000 # fix up to 1000
    python -m worker.fix_mislocated              # fix all
"""

import argparse
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("XYZO_DB_DSN", "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo")

from worker.db import connect

log = logging.getLogger("xyzo.fix_mislocated")

# Distance threshold in km - if extracted coords are more than this far from location coords, it's wrong
DISTANCE_THRESHOLD_KM = 100


def haversine_km(lat1, lng1, lat2, lng2):
    """Calculate distance between two lat/lng points."""
    import math
    R = 6371
    lat1, lng1, lat2, lng2 = map(math.radians, [lat1, lng1, lat2, lng2])
    dlat = lat2 - lat1
    dlng = lng2 - lng1
    a = math.sin(dlat/2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng/2)**2
    return 2 * R * math.asin(math.sqrt(a))


def find_mislocated_articles(limit=10000):
    """Find articles where extracted coordinates don't match location."""
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    a.id,
                    a.title,
                    a.extracted_lat,
                    a.extracted_lng,
                    l.id AS location_id,
                    l.place_name,
                    l.lat AS loc_lat,
                    l.lng AS loc_lng,
                    l.country AS loc_country,
                    s.name AS source_name,
                    s.country AS source_country
                FROM news_articles a
                JOIN news_locations l ON l.id = a.location_id
                JOIN news_sources s ON s.id = a.source_id
                WHERE a.location_id IS NOT NULL
                  AND a.extracted_lat IS NOT NULL
                  AND a.extracted_lng IS NOT NULL
                  AND a.extracted_lat != 0
                  AND a.extracted_lng != 0
                ORDER BY a.id
                LIMIT %s
            """, (limit,))
            rows = cur.fetchall()

    mislocated = []
    for r in rows:
        dist = haversine_km(r['extracted_lat'], r['extracted_lng'], r['loc_lat'], r['loc_lng'])
        if dist > DISTANCE_THRESHOLD_KM:
            mislocated.append({
                'id': r['id'],
                'title': r['title'],
                'extracted_lat': r['extracted_lat'],
                'extracted_lng': r['extracted_lng'],
                'location_id': r['location_id'],
                'place_name': r['place_name'],
                'loc_lat': r['loc_lat'],
                'loc_lng': r['loc_lng'],
                'loc_country': r['loc_country'],
                'source_name': r['source_name'],
                'source_country': r['source_country'],
                'distance_km': round(dist, 1),
            })
    return mislocated


def reset_articles_for_reprocess(article_ids):
    """Reset location_id so articles will be reprocessed."""
    if not article_ids:
        return 0
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE news_articles
                SET
                    location_id = NULL,
                    location_text = NULL,
                    extracted_location = NULL,
                    extracted_lat = NULL,
                    extracted_lng = NULL,
                    extracted_event_type = NULL,
                    location_confidence = NULL,
                    status = 'extracted',
                    geocoded_at = NULL,
                    auto_categorize_city_id = NULL,
                    auto_categorize_city_label = NULL,
                    auto_categorize_status = 'no_match'
                WHERE id = ANY(%s)
            """, (article_ids,))
            return cur.rowcount


def main():
    parser = argparse.ArgumentParser(description="Fix mislocated articles")
    parser.add_argument("--dry-run", action="store_true", help="Only show what would be fixed")
    parser.add_argument("--limit", type=int, default=10000, help="Max articles to process")
    parser.add_argument("--min-distance-km", type=float, default=DISTANCE_THRESHOLD_KM,
                        help=f"Minimum distance in km to consider mislocated (default: {DISTANCE_THRESHOLD_KM})")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    log.info("Scanning for mislocated articles...")
    mislocated = find_mislocated_articles(args.limit)
    log.info(f"Found {len(mislocated)} mislocated articles")

    if not mislocated:
        log.info("No mislocated articles found.")
        return

    # Group by wrong location for summary
    by_location = {}
    for a in mislocated:
        key = (a['location_id'], a['place_name'], a['loc_country'])
        if key not in by_location:
            by_location[key] = []
        by_location[key].append(a)

    log.info("\nMislocated by wrong location:")
    for (loc_id, place_name, country), articles in sorted(by_location.items(), key=lambda x: -len(x[1])):
        log.info(f"  {place_name}, {country} (loc_id={loc_id}): {len(articles)} articles")

    if args.dry_run:
        log.info("\n[Dry run] Would reset these articles:")
        for a in mislocated[:20]:
            log.info(f"  id={a['id']}: {a['extracted_lat']:.4f},{a['extracted_lng']:.4f} (was {a['place_name']}, {a['loc_country']}, {a['distance_km']}km away)")
        if len(mislocated) > 20:
            log.info(f"  ... and {len(mislocated) - 20} more")
        return

    # Actually fix them
    article_ids = [a['id'] for a in mislocated]
    log.info(f"\nResetting {len(article_ids)} articles for reprocessing...")
    count = reset_articles_for_reprocess(article_ids)
    log.info(f"Reset {count} articles. They will be reprocessed on next geocode run.")


if __name__ == "__main__":
    main()
