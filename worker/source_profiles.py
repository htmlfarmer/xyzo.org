"""Compute per-source geographic and topic profiles.

This module builds the source intelligence described in:
docs/superpowers/specs/2026-09-01-quality-engine.md

Usage:
    python -m worker.source_profiles --all           # Compute all sources
    python -m worker.source_profiles --source 123    # Compute single source
    python -m worker.source_profiles --daily         # Daily full recompute
"""

import argparse
import logging
import json
from datetime import datetime, timedelta

from .db import connect
from .classify import PATTERNS

log = logging.getLogger("xyzo.source_profiles")

TOP_N = 12  # Top N cities/countries/topics to track per source


def compute_source_geography(source_id: int, days: int = 30) -> dict:
    """Compute geographic coverage profile for a source.

    The city/country breakdown is computed from **content-based placements
    only** — articles that were located from their own text
    (auto_categorize_method IS DISTINCT FROM 'source_fallback').

    Why: the source-based fallback pins every article the fast path could
    not place to a single city. If that city is part of the profile, the
    profile is self-reinforcing — the pinned city becomes the "top city",
    and the next cycle pins even more articles there. That is how a
    programming blog with no geography ended up owning Bamako, and how
    "Wells Fargo" turned Fargo, ND into a 11k-article hotspot.

    Returns dict with:
      - top_cities: list of {city_id, place_name, country_code, article_count, rank}
      - top_countries: list of {country_code, article_count, rank}
      - primary_city_id, secondary_city_id
      - article_count_30d, content_article_count_30d,
        unique_countries_30d, unique_cities_30d
    """
    interval_str = f"{days} days"
    with connect() as conn, conn.cursor() as cur:
        # Shared scope: every located article of this source in the window.
        # `scoped` keeps the placement method so the content-only variant
        # can be derived from it.
        cur.execute(f"""
            WITH scoped AS (
                SELECT
                    a.auto_categorize_method,
                    l.id AS city_id,
                    l.place_name,
                    l.country AS country_code
                FROM news_articles a
                JOIN news_locations l ON l.id = a.location_id
                WHERE a.source_id = %s
                  AND a.status = 'extracted'
                  AND a.fetched_at > now() - INTERVAL '{interval_str}'
                  AND l.id IS NOT NULL
            ),
            content_scoped AS (
                SELECT * FROM scoped
                WHERE (SELECT COUNT(*) FROM scoped s
                       WHERE s.auto_categorize_method IS DISTINCT FROM 'source_fallback') > 0
                  AND auto_categorize_method IS DISTINCT FROM 'source_fallback'
            )
            SELECT city_id, place_name, country_code, COUNT(*) AS article_count
            FROM content_scoped
            GROUP BY city_id, place_name, country_code
            ORDER BY COUNT(*) DESC
            LIMIT {TOP_N}
        """, (source_id,))
        city_rows = cur.fetchall()

        top_cities = []
        primary_city_id = None
        secondary_city_id = None
        for rank, row in enumerate(city_rows, start=1):
            city_data = {
                'city_id': row['city_id'],
                'place_name': row['place_name'],
                'country_code': row['country_code'],
                'article_count': row['article_count'],
                'rank': rank
            }
            top_cities.append(city_data)
            if rank == 1:
                primary_city_id = row['city_id']
            elif rank == 2:
                secondary_city_id = row['city_id']

        # Top countries (content-based, same scope as top_cities)
        cur.execute(f"""
            WITH scoped AS (
                SELECT
                    a.auto_categorize_method,
                    l.country AS country_code
                FROM news_articles a
                JOIN news_locations l ON l.id = a.location_id
                WHERE a.source_id = %s
                  AND a.status = 'extracted'
                  AND a.fetched_at > now() - INTERVAL '{interval_str}'
                  AND l.id IS NOT NULL
            ),
            content_scoped AS (
                SELECT * FROM scoped
                WHERE (SELECT COUNT(*) FROM scoped s
                       WHERE s.auto_categorize_method IS DISTINCT FROM 'source_fallback') > 0
                  AND auto_categorize_method IS DISTINCT FROM 'source_fallback'
            )
            SELECT country_code, COUNT(*) AS article_count
            FROM content_scoped
            WHERE country_code IS NOT NULL
            GROUP BY country_code
            ORDER BY COUNT(*) DESC
            LIMIT {TOP_N}
        """, (source_id,))
        country_rows = cur.fetchall()

        top_countries = []
        for rank, row in enumerate(country_rows, start=1):
            top_countries.append({
                'country_code': row['country_code'],
                'article_count': row['article_count'],
                'rank': rank
            })

        # Stats — total output (all placements) AND the content-based
        # denominator used by the country-consistency check.
        cur.execute(f"""
            SELECT
                COUNT(*) AS article_count,
                COUNT(*) FILTER (
                    WHERE a.auto_categorize_method IS DISTINCT FROM 'source_fallback'
                ) AS content_article_count,
                COUNT(DISTINCT l.country) AS unique_countries,
                COUNT(DISTINCT l.id) AS unique_cities
            FROM news_articles a
            JOIN news_locations l ON l.id = a.location_id
            WHERE a.source_id = %s
              AND a.status = 'extracted'
              AND a.fetched_at > now() - INTERVAL '{interval_str}'
        """, (source_id,))
        stats = dict(cur.fetchone())

        return {
            'top_cities': top_cities,
            'top_countries': top_countries,
            'primary_city_id': primary_city_id,
            'secondary_city_id': secondary_city_id,
            'article_count_30d': stats['article_count'],
            'content_article_count_30d': stats['content_article_count'],
            'unique_countries_30d': stats['unique_countries'],
            'unique_cities_30d': stats['unique_cities'],
        }


def compute_source_topics(source_id: int, days: int = 30) -> dict:
    """Compute topic coverage profile for a source.

    Returns dict with:
      - top_topics: list of {topic, article_count, score, rank}
      - primary_topic
      - article_count_30d
    """
    interval_str = f"{days} days"
    with connect() as conn, conn.cursor() as cur:
        # Get topic distribution from event_type
        cur.execute(f"""
            SELECT
                COALESCE(a.event_type, 'other') AS topic,
                COUNT(*) AS article_count
            FROM news_articles a
            WHERE a.source_id = %s
              AND a.status IN ('extracted', 'pending')
              AND a.fetched_at > now() - INTERVAL '{interval_str}'
            GROUP BY COALESCE(a.event_type, 'other')
            ORDER BY COUNT(*) DESC
            LIMIT {TOP_N}
        """, (source_id,))
        topic_rows = cur.fetchall()

        # Get total for score calculation
        cur.execute(f"""
            SELECT COUNT(*) AS total
            FROM news_articles a
            WHERE a.source_id = %s
              AND a.status IN ('extracted', 'pending')
              AND a.fetched_at > now() - INTERVAL '{interval_str}'
        """, (source_id,))
        total = cur.fetchone()['total'] or 1

        top_topics = []
        primary_topic = None
        for rank, row in enumerate(topic_rows, start=1):
            score = row['article_count'] / total if total > 0 else 0
            topic_data = {
                'topic': row['topic'],
                'article_count': row['article_count'],
                'score': round(score, 4),
                'rank': rank
            }
            top_topics.append(topic_data)
            if rank == 1:
                primary_topic = row['topic']

        # Article count
        cur.execute(f"""
            SELECT COUNT(*) AS article_count
            FROM news_articles a
            WHERE a.source_id = %s
              AND a.fetched_at > now() - INTERVAL '{interval_str}'
        """, (source_id,))
        article_count_30d = cur.fetchone()['article_count']

        return {
            'top_topics': top_topics,
            'primary_topic': primary_topic,
            'article_count_30d': article_count_30d,
        }


def compute_source_languages(source_id: int, days: int = 30) -> dict:
    """Compute language profile for a source.

    Since news_articles doesn't have a language column, we use the
    source's configured language and any additional languages from
    news_source_languages table.
    """
    with connect() as conn, conn.cursor() as cur:
        # Get source's primary language
        cur.execute("""
            SELECT language, language_primary, language_secondary
            FROM news_sources
            WHERE id = %s
        """, (source_id,))
        row = cur.fetchone()

        if not row:
            return {'detected_languages': [], 'primary_language': None}

        # Use source's language fields
        primary_language = row['language'] or row['language_primary']

        detected_languages = []
        if primary_language:
            detected_languages.append({
                'language': primary_language,
                'article_count': 0,  # Not tracked per-article
                'source': 'configured'
            })

        # Also check news_source_languages table for detected variants
        cur.execute("""
            SELECT detected_languages, primary_language
            FROM news_source_languages
            WHERE source_id = %s
        """, (source_id,))
        existing = cur.fetchone()
        if existing and existing['detected_languages']:
            # Merge with existing detected languages
            existing_langs = existing['detected_languages'] or []
            for lang in existing_langs:
                if lang not in [d['language'] for d in detected_languages]:
                    lang['source'] = 'detected'
                    detected_languages.append(lang)

        return {
            'detected_languages': detected_languages[:TOP_N],
            'primary_language': primary_language,
        }


def upsert_geography(source_id: int, data: dict) -> None:
    """Upsert geography data for a source."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO news_source_geography (
                source_id, top_cities, top_countries,
                primary_city_id, secondary_city_id,
                article_count_30d, content_article_count_30d,
                unique_countries_30d, unique_cities_30d,
                updated_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (source_id) DO UPDATE SET
                top_cities = EXCLUDED.top_cities,
                top_countries = EXCLUDED.top_countries,
                primary_city_id = EXCLUDED.primary_city_id,
                secondary_city_id = EXCLUDED.secondary_city_id,
                article_count_30d = EXCLUDED.article_count_30d,
                content_article_count_30d = EXCLUDED.content_article_count_30d,
                unique_countries_30d = EXCLUDED.unique_countries_30d,
                unique_cities_30d = EXCLUDED.unique_cities_30d,
                updated_at = now()
        """, (
            source_id,
            json.dumps(data.get('top_cities', [])),
            json.dumps(data.get('top_countries', [])),
            data.get('primary_city_id'),
            data.get('secondary_city_id'),
            data.get('article_count_30d', 0),
            data.get('content_article_count_30d', 0),
            data.get('unique_countries_30d', 0),
            data.get('unique_cities_30d', 0),
        ))


def upsert_topics(source_id: int, data: dict) -> None:
    """Upsert topic data for a source."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO news_source_topics (
                source_id, top_topics,
                article_count_30d, primary_topic,
                updated_at
            )
            VALUES (%s, %s, %s, %s, now())
            ON CONFLICT (source_id) DO UPDATE SET
                top_topics = EXCLUDED.top_topics,
                article_count_30d = EXCLUDED.article_count_30d,
                primary_topic = EXCLUDED.primary_topic,
                updated_at = now()
        """, (
            source_id,
            json.dumps(data.get('top_topics', [])),
            data.get('article_count_30d', 0),
            data.get('primary_topic'),
        ))


def upsert_languages(source_id: int, data: dict) -> None:
    """Upsert language data for a source."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO news_source_languages (
                source_id, detected_languages,
                primary_language,
                updated_at
            )
            VALUES (%s, %s, %s, now())
            ON CONFLICT (source_id) DO UPDATE SET
                detected_languages = EXCLUDED.detected_languages,
                primary_language = EXCLUDED.primary_language,
                updated_at = now()
        """, (
            source_id,
            json.dumps(data.get('detected_languages', [])),
            data.get('primary_language'),
        ))


def compute_all_profiles(source_id: int, days: int = 30) -> dict:
    """Compute all profiles for a single source."""
    log.info(f"Computing profiles for source {source_id}")

    geo = compute_source_geography(source_id, days)
    upsert_geography(source_id, geo)

    topics = compute_source_topics(source_id, days)
    upsert_topics(source_id, topics)

    langs = compute_source_languages(source_id, days)
    upsert_languages(source_id, langs)

    return {
        'source_id': source_id,
        'geography': geo,
        'topics': topics,
        'languages': langs,
    }


def compute_all_sources(days: int = 30, limit: int = None) -> dict:
    """Compute profiles for all active sources."""
    with connect() as conn, conn.cursor() as cur:
        if limit:
            cur.execute("""
                SELECT id FROM news_sources
                WHERE active = TRUE
                ORDER BY last_success_at DESC NULLS LAST
                LIMIT %s
            """, (limit,))
        else:
            cur.execute("""
                SELECT id FROM news_sources WHERE active = TRUE
            """)
        source_ids = [row['id'] for row in cur.fetchall()]

    log.info(f"Computing profiles for {len(source_ids)} sources")

    results = {'success': 0, 'errors': 0, 'sources': []}
    for i, sid in enumerate(source_ids):
        try:
            if (i + 1) % 50 == 0:
                log.info(f"  Progress: {i+1}/{len(source_ids)}")
            compute_all_profiles(sid, days)
            results['success'] += 1
        except Exception as e:
            log.error(f"  Error computing profile for source {sid}: {e}")
            results['errors'] += 1
            results['sources'].append({'source_id': sid, 'error': str(e)})

    log.info(f"Done: {results['success']} success, {results['errors']} errors")
    return results


def main():
    parser = argparse.ArgumentParser(description="Compute source profiles")
    parser.add_argument('--source', type=int, help='Source ID to compute')
    parser.add_argument('--all', action='store_true', help='Compute all sources')
    parser.add_argument('--daily', action='store_true', help='Daily recompute (all sources)')
    parser.add_argument('--days', type=int, default=30, help='Days to look back (default 30)')
    parser.add_argument('--limit', type=int, help='Limit to N sources')
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(message)s'
    )

    if args.source:
        result = compute_all_profiles(args.source, args.days)
        print(json.dumps(result, indent=2, default=str))
    elif args.all or args.daily:
        result = compute_all_sources(args.days, args.limit)
        print(json.dumps(result, indent=2, default=str))
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
