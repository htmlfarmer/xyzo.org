#!/usr/bin/env python3
"""
Coverage Gap Detection
====================
Detect cities/countries that should have news coverage but don't.

How it works:
1. Compare xyzo_place_context (98 cities we care about)
2. Against actual xyzo_articles per city
3. Flag cities with NO recent coverage

Intelligence output:
- "We have 0 articles about Jakarta this week - is something happening?"
- "Lagos hasn't been covered in 48 hours - verify nothing major is being missed"

Run:
    python3 -m worker.wikidata.detect_coverage_gaps
"""

import logging
import os
import sys

import psycopg
from psycopg.rows import dict_row

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("xyzo.coverage_gaps")

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
)


def connect_xyzo():
    return psycopg.connect(XYZO_DSN, row_factory=dict_row, autocommit=True)


def get_place_article_counts(conn):
    """Get article counts per place."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                xpc.place_name,
                xpc.country_code,
                xpc.place_qid AS qid,
                COUNT(xa.id) AS article_count,
                MAX(xa.published_at) AS last_published
            FROM xyzo_place_context xpc
            LEFT JOIN news_articles xa ON (
                ST_DWithin(
                    ST_MakePoint(xa.extracted_lng, xa.extracted_lat)::geography,
                    ST_MakePoint(xpc.lon, xpc.lat)::geography,
                    50000  -- 50km radius
                )
                AND xa.published_at > NOW() - INTERVAL '7 days'
            )
            GROUP BY xpc.place_name, xpc.country_code, xpc.place_qid
            ORDER BY article_count ASC, last_published ASC NULLS FIRST
        """)
        return list(cur.fetchall())


def get_global_article_stats(conn):
    """Get global article statistics."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                COUNT(*) AS total_articles,
                COUNT(DISTINCT DATE(published_at)) AS active_days,
                MIN(published_at) AS oldest_article,
                MAX(published_at) AS newest_article
            FROM news_articles
            WHERE published_at > NOW() - INTERVAL '7 days'
        """)
        return cur.fetchone()


def main():
    log.info("=" * 60)
    log.info("COVERAGE GAP DETECTION")
    log.info("=" * 60)

    conn = connect_xyzo()

    try:
        # Global stats
        stats = get_global_article_stats(conn)
        log.info(f"\nGlobal (7-day window):")
        log.info(f"  Total articles: {stats['total_articles']}")
        log.info(f"  Active days: {stats['active_days']}")
        log.info(f"  Oldest: {stats['oldest_article']}")
        log.info(f"  Newest: {stats['newest_article']}")

        # Per-place coverage
        log.info(f"\nPlace Coverage Analysis:")
        places = get_place_article_counts(conn)

        no_coverage = [p for p in places if p['article_count'] == 0]
        low_coverage = [p for p in places if 0 < p['article_count'] <= 2]
        good_coverage = [p for p in places if p['article_count'] > 2]

        log.info(f"  Places with ZERO coverage: {len(no_coverage)}")
        log.info(f"  Places with LOW coverage (1-2): {len(low_coverage)}")
        log.info(f"  Places with GOOD coverage (3+): {len(good_coverage)}")

        # Show gaps
        if no_coverage:
            log.info(f"\n🚨 CRITICAL GAPS (0 articles):")
            for p in no_coverage[:15]:
                log.info(f"    {p['place_name']}, {p['country_code']} ({p['qid']})")

        if low_coverage:
            log.info(f"\n⚠️ LOW COVERAGE (1-2 articles):")
            for p in low_coverage[:10]:
                last = p['last_published'].strftime('%Y-%m-%d') if p['last_published'] else 'NEVER'
                log.info(f"    {p['place_name']}, {p['country_code']} - {p['article_count']} articles, last: {last}")

        # Top covered places
        log.info(f"\n✅ TOP COVERED PLACES:")
        top_places = sorted(good_coverage, key=lambda x: x['article_count'], reverse=True)[:10]
        for p in top_places:
            log.info(f"    {p['place_name']}, {p['country_code']} - {p['article_count']} articles")

        # Intelligence questions
        log.info(f"\n" + "=" * 60)
        log.info("INTELLIGENCE QUESTIONS")
        log.info("=" * 60)

        if no_coverage:
            sample_gaps = no_coverage[:5]
            log.info("\n1. VERIFY THESE CITIES:")
            for p in sample_gaps:
                log.info(f"   - {p['place_name']} ({p['country_code']}): 0 articles - is this correct?")

        if low_coverage:
            sample_low = low_coverage[:5]
            log.info("\n2. EXPAND COVERAGE?")
            for p in sample_low:
                last = p['last_published'].strftime('%Y-%m-%d') if p['last_published'] else 'NEVER'
                log.info(f"   - {p['place_name']}: only {p['article_count']} articles, last: {last}")

        log.info("""
\nNext steps:
  1. Add news sources for gap cities
  2. Adjust geolocation precision for low-coverage cities
  3. Create alerts for coverage gaps in major cities
""")

    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
