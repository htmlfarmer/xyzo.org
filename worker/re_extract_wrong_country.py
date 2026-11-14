#!/usr/bin/env python3
"""
Re-extract articles from sources that had wrong source country when originally extracted.

This fixes the issue where articles were extracted with wrong source context
(e.g., Nepali articles extracted as if from Somalia source).

Usage:
    python -m worker.re_extract_wrong_country [--dry-run] [--limit N]
"""

import argparse
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from worker.db import connect

log = logging.getLogger("newsium.re_extract_wrong_country")

QUERY = """
SELECT DISTINCT
    a.source_id,
    s.name as source_name,
    s.country as source_country,
    COUNT(*) as article_count
FROM news_articles a
JOIN news_sources s ON s.id = a.source_id
WHERE a.status IN ('extracted', 'clustered')
    AND a.extracted_lat IS NOT NULL
    AND a.location_id IN (
        SELECT l.id FROM news_locations l WHERE l.country = 'SY'
    )
GROUP BY a.source_id, s.name, s.country
ORDER BY article_count DESC;
"""

RESET_QUERY = """
UPDATE news_articles
SET 
    status = 'pending',
    location_text = NULL,
    location_id = NULL,
    extracted_lat = NULL,
    extracted_lng = NULL,
    extracted_location = NULL,
    extracted_event_type = NULL,
    location_confidence = NULL,
    extracted_at = NULL,
    geocoded_at = NULL,
    error_message = NULL,
    quality_score = NULL,
    re_evaluated_at = NULL,
    re_evaluation_reasoning = NULL
WHERE source_id = %(source_id)s
    AND status IN ('extracted', 'clustered')
    AND extracted_lat IS NOT NULL
    AND location_id IN (
        SELECT id FROM news_locations WHERE country = 'SY'
    )
RETURNING id;
"""

def get_broken_sources():
    """Get list of sources with mislabeled articles."""
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(QUERY)
            rows = cur.fetchall()
            return [(r[0], r[1], r[2], r[3]) for r in rows]

def reset_articles_for_source(source_id):
    """Reset articles so they can be re-extracted."""
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(RESET_QUERY, {'source_id': source_id})
            rows = cur.fetchall()
            return len(rows)

def main():
    parser = argparse.ArgumentParser(description='Re-extract articles from wrong-country sources')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be fixed without making changes')
    parser.add_argument('--limit', type=int, default=0, help='Limit number of articles to reset per source (0=all)')
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

    print("=" * 60)
    print("RE-EXTRACTION CANDIDATE FINDER")
    print("=" * 60)

    broken = get_broken_sources()
    total_articles = sum(r[3] for r in broken)

    print(f"\nFound {len(broken)} sources with {total_articles} mislocated articles:\n")
    for source_id, name, country, count in broken:
        print(f"  [{source_id}] {name} ({country}): {count} articles")

    if args.dry_run:
        print("\n[DRY RUN] No changes made.")
        return

    print("\n" + "=" * 60)
    response = input("Reset these articles for re-extraction? (yes/no): ")
    if response.lower() != 'yes':
        print("Aborted.")
        return

    print("\nResetting articles...")
    total_reset = 0
    for source_id, name, country, count in broken:
        if args.limit > 0 and count > args.limit:
            print(f"  [{source_id}] {name}: Skipping {count} articles (limit set)")
            continue

        n = reset_articles_for_source(source_id)
        total_reset += n
        print(f"  [{source_id}] {name}: Reset {n} articles")

    print(f"\nTotal articles reset: {total_reset}")
    print("\nThese articles will be re-extracted on the next extraction cycle.")
    print("Make sure the extraction worker is running.")

if __name__ == '__main__':
    main()
