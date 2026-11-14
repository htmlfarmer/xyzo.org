"""Fast News Updater — prioritized news fetching for global coverage.

This module implements a fast, prioritized news update system:
  1. Prioritizes sources by country population and coverage gaps
  2. Uses concurrent fetching for speed
  3. Implements smart scheduling (more frequent for high-priority sources)
  4. Tracks fetch success rates and adjusts priority accordingly

Usage:
  python -m worker.fast_update --priority high     # Fetch high-priority sources only
  python -m worker.fast_update --region asia       # Fetch Asian sources
  python -m worker.fast_update --country CN IN ID  # Fetch specific countries
  python -m worker.fast_update --all               # Full update cycle
"""

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any

from .db import connect
from . import fetch, extract, geocode, cluster

log = logging.getLogger("xyzo.fast_update")

# Priority levels based on population and coverage
PRIORITY_LEVELS = {
    "critical": {  # >500M population, <5 sources
        "countries": ["CN", "IN", "ID", "PK", "BR", "NG", "BD", "ET"],
        "fetch_interval_s": 900,  # 15 minutes
        "max_articles_per_cycle": 30,
    },
    "high": {  # >100M population or significant news importance
        "countries": ["RU", "MX", "JP", "PH", "EG", "VN", "CD", "TR", "IR", "DE", "TH", "GB", "FR"],
        "fetch_interval_s": 1800,  # 30 minutes
        "max_articles_per_cycle": 20,
    },
    "medium": {  # >50M population
        "countries": ["IT", "TZ", "ZA", "MM", "KE", "KR", "CO", "ES", "UA", "AR", "DZ", "SD", "IQ", "AF", "PL", "CA"],
        "fetch_interval_s": 3600,  # 1 hour
        "max_articles_per_cycle": 15,
    },
    "low": {  # Other countries
        "countries": [],  # Will be populated dynamically
        "fetch_interval_s": 7200,  # 2 hours
        "max_articles_per_cycle": 10,
    },
}


def get_source_priority(country_code: str) -> str:
    """Get priority level for a country."""
    for level, config in PRIORITY_LEVELS.items():
        if country_code in config["countries"]:
            return level
    return "low"


def get_sources_by_priority(priority: str | None = None,
                            region: str | None = None,
                            countries: list[str] | None = None) -> list[dict]:
    """Get sources filtered by priority, region, or country."""
    with connect() as conn, conn.cursor() as cur:
        query = """
            SELECT id, name, feed_url, country, language, region,
                   last_success_at, last_failure_at, error_count,
                   reliability_score, active
            FROM news_sources
            WHERE active = TRUE
        """
        params: list = []

        if countries:
            placeholders = ", ".join(["%s"] * len(countries))
            query += f" AND country IN ({placeholders})"
            params.extend(countries)
        elif region:
            query += " AND region ILIKE %s"
            params.append(f"%{region}%")

        query += " ORDER BY reliability_score DESC, last_success_at DESC NULLS LAST"

        cur.execute(query, params)
        sources = cur.fetchall()

    # Filter by priority if specified
    if priority:
        sources = [s for s in sources if get_source_priority(s["country"]) == priority]

    return sources


def fetch_source_fast(source: dict, max_articles: int = 20) -> dict:
    """Fetch a single source with timeout and error handling."""
    source_id = source["id"]
    source_name = source["name"]
    feed_url = source["feed_url"]

    try:
        import httpx
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            headers = {"User-Agent": fetch.USER_AGENT}

            # Use ETag/Last-Modified if available
            if source.get("etag"):
                headers["If-None-Match"] = source["etag"]
            if source.get("last_modified"):
                headers["If-Modified-Since"] = source["last_modified"]

            resp = client.get(feed_url, headers=headers)

            if resp.status_code == 304:
                return {"source_id": source_id, "name": source_name,
                        "status": "not_modified", "articles": 0}

            if resp.status_code >= 400:
                return {"source_id": source_id, "name": source_name,
                        "status": "error", "error": f"HTTP {resp.status_code}"}

            # Parse feed
            articles = fetch.parse_feed(resp.content, source.get("source_type", "rss"))

            # Limit articles
            if len(articles) > max_articles:
                articles = articles[:max_articles]

            # Insert articles
            inserted = fetch.insert_articles(articles, source_id)

            # Update source status
            new_etag = resp.headers.get("etag")
            new_last_mod = resp.headers.get("last-modified")
            fetch.update_source(source_id, {
                "last_success_at": "now()",
                "etag": new_etag,
                "last_modified": new_last_mod,
            })

            return {"source_id": source_id, "name": source_name,
                    "status": "ok", "articles": inserted}

    except Exception as e:
        log.warning("Failed to fetch %s: %s", source_name, e)
        fetch.update_source(source_id, {"last_failure_at": "now()", "error_count_inc": 1})
        return {"source_id": source_id, "name": source_name,
                "status": "error", "error": str(e)[:200]}


def fast_fetch_cycle(priority: str | None = None,
                     region: str | None = None,
                     countries: list[str] | None = None,
                     max_workers: int = 10,
                     limit_per_source: int = 20) -> dict:
    """Run a fast fetch cycle with concurrent requests."""
    sources = get_sources_by_priority(priority, region, countries)

    if not sources:
        return {"sources": 0, "articles": 0, "errors": 0}

    log.info("Starting fast fetch: %d sources (priority=%s, region=%s, countries=%s)",
             len(sources), priority, region, countries)

    results = {"sources": 0, "articles": 0, "errors": 0, "details": []}

    # Use ThreadPoolExecutor for concurrent fetching
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(fetch_source_fast, src, limit_per_source): src
            for src in sources
        }

        for future in as_completed(futures):
            src = futures[future]
            try:
                result = future.result(timeout=30)
                results["sources"] += 1
                results["articles"] += result.get("articles", 0)
                if result.get("status") == "error":
                    results["errors"] += 1
                results["details"].append(result)
            except Exception as e:
                log.warning("Source %s failed: %s", src["name"], e)
                results["errors"] += 1

    return results


def run_priority_cycle() -> dict:
    """Run a complete priority-based update cycle.

    This fetches sources in priority order:
    1. Critical (high population, low coverage) - most frequent
    2. High - frequent
    3. Medium - regular
    4. Low - less frequent
    """
    summary = {"cycles": {}, "total_sources": 0, "total_articles": 0, "total_errors": 0}

    for priority in ["critical", "high", "medium", "low"]:
        log.info("Running %s priority cycle...", priority)

        result = fast_fetch_cycle(
            priority=priority,
            max_workers=5 if priority == "critical" else 3,
            limit_per_source=PRIORITY_LEVELS[priority]["max_articles_per_cycle"],
        )

        summary["cycles"][priority] = result
        summary["total_sources"] += result["sources"]
        summary["total_articles"] += result["articles"]
        summary["total_errors"] += result["errors"]

        # Brief pause between priority levels
        time.sleep(1)

    return summary


def run_extraction_cycle(limit: int = 100) -> dict:
    """Run AI extraction on newly fetched articles."""
    log.info("Running extraction cycle (limit=%d)...", limit)

    extract_result = extract.run(limit=limit)
    geocode_result = geocode.run(limit=limit)
    cluster_result = cluster.run(limit=limit * 2)

    return {
        "extract": extract_result,
        "geocode": geocode_result,
        "cluster": cluster_result,
    }


def get_update_stats() -> dict:
    """Get statistics about recent updates."""
    with connect() as conn, conn.cursor() as cur:
        # Recent fetch activity
        cur.execute("""
            SELECT
                COUNT(*) as total_sources,
                SUM(CASE WHEN last_success_at > now() - interval '1 hour' THEN 1 ELSE 0 END) as fetched_1h,
                SUM(CASE WHEN last_success_at > now() - interval '6 hours' THEN 1 ELSE 0 END) as fetched_6h,
                SUM(CASE WHEN last_success_at > now() - interval '24 hours' THEN 1 ELSE 0 END) as fetched_24h,
                SUM(CASE WHEN active = FALSE THEN 1 ELSE 0 END) as inactive
            FROM news_sources
        """)
        source_stats = dict(cur.fetchone())

        # Recent article counts
        cur.execute("""
            SELECT
                COUNT(*) as total_articles,
                SUM(CASE WHEN fetched_at > now() - interval '1 hour' THEN 1 ELSE 0 END) as articles_1h,
                SUM(CASE WHEN fetched_at > now() - interval '6 hours' THEN 1 ELSE 0 END) as articles_6h,
                SUM(CASE WHEN fetched_at > now() - interval '24 hours' THEN 1 ELSE 0 END) as articles_24h
            FROM news_articles
        """)
        article_stats = dict(cur.fetchone())

        # Coverage by priority
        cur.execute("""
            SELECT country, COUNT(*) as sources,
                   SUM(CASE WHEN last_success_at > now() - interval '1 hour' THEN 1 ELSE 0 END) as recent
            FROM news_sources
            WHERE active = TRUE
            GROUP BY country
            ORDER BY sources DESC
        """)
        country_stats = cur.fetchall()

    return {
        "sources": source_stats,
        "articles": article_stats,
        "countries": country_stats,
    }


# CLI entry point
if __name__ == "__main__":
    import argparse
    import json

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    parser = argparse.ArgumentParser(description="Fast news updater")
    parser.add_argument("--priority", choices=["critical", "high", "medium", "low"],
                        help="Fetch specific priority level")
    parser.add_argument("--region", help="Fetch specific region")
    parser.add_argument("--countries", nargs="+", help="Fetch specific countries")
    parser.add_argument("--all", action="store_true", help="Run full priority cycle")
    parser.add_argument("--extract", type=int, help="Run extraction on N articles")
    parser.add_argument("--stats", action="store_true", help="Show update statistics")
    parser.add_argument("--workers", type=int, default=10, help="Max concurrent workers")
    args = parser.parse_args()

    if args.stats:
        stats = get_update_stats()
        print("\n=== News Update Statistics ===\n")
        print(f"Total sources: {stats['sources']['total_sources']}")
        print(f"Active (fetched in 1h): {stats['sources']['fetched_1h']}")
        print(f"Active (fetched in 6h): {stats['sources']['fetched_6h']}")
        print(f"Active (fetched in 24h): {stats['sources']['fetched_24h']}")
        print(f"Inactive: {stats['sources']['inactive']}")
        print(f"\nTotal articles: {stats['articles']['total_articles']}")
        print(f"New (1h): {stats['articles']['articles_1h']}")
        print(f"New (6h): {stats['articles']['articles_6h']}")
        print(f"New (24h): {stats['articles']['articles_24h']}")

    elif args.all:
        result = run_priority_cycle()
        print(f"\n=== Priority Cycle Complete ===")
        print(f"Total sources fetched: {result['total_sources']}")
        print(f"Total articles inserted: {result['total_articles']}")
        print(f"Total errors: {result['total_errors']}")

    elif args.priority or args.region or args.countries:
        result = fast_fetch_cycle(
            priority=args.priority,
            region=args.region,
            countries=args.countries,
            max_workers=args.workers,
        )
        print(f"\nFetched {result['sources']} sources, {result['articles']} articles, {result['errors']} errors")

    elif args.extract:
        result = run_extraction_cycle(args.extract)
        print(f"\nExtracted: {result['extract']}")
        print(f"Geocoded: {result['geocode']}")
        print(f"Clustered: {result['cluster']}")

    else:
        parser.print_help()
