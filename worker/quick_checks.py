#!/usr/bin/env python3
"""Xyzo Quick Checks — rapid health diagnostic for the xyzo.org news pipeline.

Run:
    python -m worker.quick_checks         # all checks
    python -m worker.quick_checks --live # include slow live checks (HTTP, AI)
    python -m worker.quick_checks --json  # machine-readable output
    python -m worker.quick_checks --fix   # auto-fix what can be fixed

Checks performed:
  [D]  Database connectivity + table sizes
  [D]  Source health: active, erroring, cold-start, stale
  [D]  Article health: recent volume, empty titles, duplicates
  [D]  Location health: NULL countries, coord quality
  [D]  Event health: recent count, type distribution
  [D]  NN pipeline: prediction cache, queue depth, training data
  [L]  Worker liveness: last fetch per source type
  [L]  API responsiveness
  [L]  AI endpoint reachable
  [L]  RSS feed samplers (BBC, Reuters)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False

from .db import connect

NOW = datetime.now(timezone.utc)

SEVERITY = {"ok": "✓", "warn": "⚠", "fail": "✗", "info": "ℹ", "skip": "∅"}


def green(txt): return f"\033[92m{txt}\033[0m"
def yellow(txt): return f"\033[93m{txt}\033[0m"
def red(txt): return f"\033[91m{txt}\033[0m"
def dim(txt): return f"\033[2m{txt}\033[0m"


def section(label: str) -> None:
    print(f"\n{'═' * 60}")
    print(f" {label}")
    print('═' * 60)


def check_db_size() -> dict:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
                (SELECT COUNT(*) FROM news_articles)                           AS articles,
                (SELECT COUNT(*) FROM news_events)                             AS events,
                (SELECT COUNT(*) FROM news_sources WHERE active = true)       AS active_sources,
                (SELECT COUNT(*) FROM news_sources WHERE active = false)       AS inactive_sources,
                (SELECT COUNT(*) FROM news_locations)                          AS locations,
                (SELECT COUNT(*) FROM world_cities)                            AS world_cities,
                (SELECT COUNT(*) FROM news_sources)                            AS total_sources,
                (SELECT MAX(fetched_at) FROM news_articles)                   AS last_article_at,
                (SELECT MAX(created_at) FROM news_events)                     AS last_event_at
        """)
        r = cur.fetchone()
        return dict(r)


def check_source_health() -> dict:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE active = true AND error_count = 0)            AS perfect,
                COUNT(*) FILTER (WHERE active = true AND error_count BETWEEN 1 AND 10)  AS low_errors,
                COUNT(*) FILTER (WHERE active = true AND error_count BETWEEN 11 AND 50) AS medium_errors,
                COUNT(*) FILTER (WHERE active = true AND error_count > 50)          AS high_errors,
                COUNT(*) FILTER (WHERE active = true AND articles_24h = 0 AND articles_7d = 0) AS cold_sources,
                COUNT(*) FILTER (WHERE active = true AND last_success_at < NOW() - INTERVAL '7 days') AS stale_sources,
                COUNT(*) FILTER (WHERE active = true AND reliability_score < 0.1)   AS low_reliability,
                COUNT(*) FILTER (WHERE reliability_score >= 0.9)                     AS high_reliability,
                COUNT(*) FILTER (WHERE reliability_score BETWEEN 0.5 AND 0.9)         AS medium_reliability
            FROM news_sources
        """)
        r = cur.fetchone()

        cur.execute("""
            SELECT s.id, s.name, s.error_count, s.articles_24h, s.articles_7d,
                   s.last_success_at::text, s.reliability_score
            FROM news_sources s
            WHERE s.active = true
              AND s.error_count > 50
              AND s.articles_7d = 0
            ORDER BY s.error_count DESC
            LIMIT 10
        """)
        worst = [dict(row) for row in cur.fetchall()]

        return {"distribution": dict(r), "worst_error_sources": worst}


def check_article_health() -> dict:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE fetched_at > NOW() - INTERVAL '1 hour')   AS last_hour,
                COUNT(*) FILTER (WHERE fetched_at > NOW() - INTERVAL '6 hours')  AS last_6h,
                COUNT(*) FILTER (WHERE fetched_at > NOW() - INTERVAL '24 hours') AS last_24h,
                COUNT(*) FILTER (WHERE fetched_at > NOW() - INTERVAL '7 days')  AS last_7d,
                COUNT(*) FILTER (WHERE title = '' OR title IS NULL)              AS empty_titles,
                COUNT(*) FILTER (WHERE url = '' OR url IS NULL)                  AS empty_urls,
                COUNT(*) FILTER (WHERE location_id IS NULL)                       AS no_location,
                COUNT(*) FILTER (WHERE source_id IS NULL)                         AS no_source
            FROM news_articles
        """)
        r = cur.fetchone()

        cur.execute("""
            SELECT title, source_id, COUNT(*) as cnt
            FROM news_articles
            WHERE fetched_at > NOW() - INTERVAL '7 days'
              AND title != ''
            GROUP BY title, source_id
            HAVING COUNT(*) > 10
            ORDER BY cnt DESC
            LIMIT 10
        """)
        top_dups = [dict(row) for row in cur.fetchall()]

        cur.execute("""
            SELECT s.name, COUNT(*) as cnt
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            WHERE a.fetched_at > NOW() - INTERVAL '7 days'
              AND (a.title = '' OR a.title IS NULL)
            GROUP BY s.name
            ORDER BY cnt DESC
            LIMIT 5
        """)
        empty_by_source = [dict(row) for row in cur.fetchall()]

        return {"stats": dict(r), "top_duplicates": top_dups, "empty_by_source": empty_by_source}


def check_location_health() -> dict:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE country IS NULL OR country = '') AS null_country,
                COUNT(*) FILTER (WHERE lat < -90 OR lat > 90 OR lng < -180 OR lng > 180) AS invalid_coords,
                COUNT(*) FILTER (WHERE lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180 AND country IS NOT NULL AND country != '') AS valid_located,
                COUNT(*) AS total
            FROM news_locations
        """)
        r = cur.fetchone()

        cur.execute("""
            SELECT COUNT(*) FROM news_articles a
            JOIN news_locations l ON l.id = a.location_id
            WHERE l.country IS NULL OR l.country = ''
        """)
        articles_no_country = cur.fetchone()["count"]

        return {"stats": dict(r), "articles_no_country": articles_no_country}


def check_event_health() -> dict:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')   AS last_hour,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last_24h,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')   AS last_7d,
                COUNT(*)                                                       AS total,
                COUNT(DISTINCT event_type)                                      AS distinct_types
            FROM news_events
        """)
        r = cur.fetchone()

        cur.execute("""
            SELECT event_type, COUNT(*) as cnt
            FROM news_events
            WHERE created_at > NOW() - INTERVAL '7 days'
            GROUP BY event_type
            ORDER BY cnt DESC
            LIMIT 10
        """)
        top_types = [dict(row) for row in cur.fetchall()]

        return {"stats": dict(r), "top_types": top_types}


def check_nn_pipeline() -> dict:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
                COUNT(*) FILTER (WHERE needs_geo = true)   AS needs_geo,
                MAX(enqueued_at)::text                      AS last_enqueued
            FROM nn_inference_queue
        """)
        r = cur.fetchone()

        # NOTE: there is no geolocation model any more (removed 2026-10-26),
        # so there are no geolocation training labels to report.
        return {"predictions": dict(r)}


def check_worker_liveness() -> dict:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
                (SELECT MAX(last_success_at) FROM news_sources WHERE source_type = 'rss') AS last_rss,
                (SELECT MAX(last_success_at) FROM news_sources WHERE source_type = 'web')  AS last_web,
                (SELECT MAX(last_success_at) FROM news_sources WHERE source_type = 'json') AS last_json
        """)
        r = cur.fetchone()
        return dict(r)


def check_api_responsive() -> float | None:
    if not HAS_HTTPX:
        return None
    try:
        t0 = time.monotonic()
        resp = httpx.get("http://localhost:3008/api/agent/health", timeout=5.0)
        elapsed = (time.monotonic() - t0) * 1000
        return elapsed if resp.status_code == 200 else None
    except Exception:
        return None


def check_ai_endpoint() -> dict:
    if not HAS_HTTPX:
        return {"reachable": False, "reason": "httpx not installed"}
    import os
    ai_url = os.environ.get("XYZO_AI_CHAT_URL", "http://192.168.1.3:8888/chat/stream")
    try:
        resp = httpx.get(ai_url.replace("/stream", "/health") if "/stream" in ai_url else ai_url, timeout=5.0)
        return {"reachable": True, "status": resp.status_code}
    except Exception as e:
        return {"reachable": False, "reason": str(e)[:80]}


def check_feed_sample() -> dict:
    if not HAS_HTTPX:
        return {"reachable": False, "reason": "httpx not installed"}
    feeds = {
        "BBC": "http://feeds.bbci.co.uk/news/world/rss.xml",
        "Reuters": "https://feeds.reuters.com/reuters/topNews",
    }
    results = {}
    for name, url in feeds.items():
        try:
            resp = httpx.get(url, timeout=8.0, follow_redirects=True)
            results[name] = {"ok": resp.status_code == 200, "status": resp.status_code, "size_kb": len(resp.content) / 1024}
        except Exception as e:
            results[name] = {"ok": False, "error": str(e)[:60]}
    return results


def auto_fix() -> dict:
    fixes = {}

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            UPDATE news_sources
               SET active = false
             WHERE active = true
               AND error_count > 30
               AND articles_7d = 0
               AND articles_24h = 0
        """)
        fixes["deactivated_dead_sources"] = cur.rowcount

        cur.execute("""
            DELETE FROM news_articles
             WHERE title = ''
               AND fetched_at < NOW() - INTERVAL '1 hour'
               AND id NOT IN (
                   SELECT id FROM news_articles
                   WHERE title != '' AND title IS NOT NULL
                   ORDER BY fetched_at DESC LIMIT 10000
               )
        """)
        fixes["removed_empty_articles"] = cur.rowcount

    return fixes


def print_report(data: dict, live: bool = False, json_out: bool = False, verbose: bool = False) -> None:
    if json_out:
        print(json.dumps(data, indent=2, default=str))
        return

    sources = data["source_health"]["distribution"]
    articles = data["article_health"]["stats"]
    loc_stats = data["location_health"]["stats"]
    events = data["event_health"]["stats"]
    nn = data["nn_pipeline"]["predictions"]

    section("DATABASE OVERVIEW")
    db = data["db_size"]
    last_article = db["last_article_at"] or "NEVER"
    last_event = db["last_event_at"] or "NEVER"
    print(f"  Articles:     {db['articles']:,}   (last: {last_article})")
    print(f"  Events:       {db['events']:,}   (last: {last_event})")
    print(f"  Locations:    {db['locations']:,}")
    print(f"  World cities: {db['world_cities']:,}")
    print(f"  Sources:      {db['total_sources']:,}  (active: {db['active_sources']:,}, inactive: {db['inactive_sources']:,})")

    section("SOURCE HEALTH")
    ok_srcs = sources.get("perfect", 0) + sources.get("low_errors", 0)
    warn_srcs = sources.get("medium_errors", 0)
    fail_srcs = sources.get("high_errors", 0)
    cold = sources.get("cold_sources", 0)
    stale = sources.get("stale_sources", 0)
    low_rel = sources.get("low_reliability", 0)

    print(f"  Low/no errors (perfect + low):  {ok_srcs:,}  {SEVERITY['ok']}")
    print(f"  Medium errors (11-50):         {warn_srcs:,}  {SEVERITY['warn'] if warn_srcs else SEVERITY['ok']}")
    print(f"  High errors (>50):             {fail_srcs:,}  {SEVERITY['fail'] if fail_srcs else SEVERITY['ok']}")
    print(f"  Cold (0 articles 7d):          {cold:,}  {SEVERITY['warn'] if cold else SEVERITY['ok']}")
    print(f"  Stale (>7d since success):     {stale:,}  {SEVERITY['warn'] if stale else SEVERITY['ok']}")
    print(f"  Low reliability (<0.1):        {low_rel:,}  {SEVERITY['fail'] if low_rel else SEVERITY['ok']}")
    print(f"  High reliability (≥0.9):        {sources.get('high_reliability', 0):,}")
    print(f"  Medium reliability (0.5-0.9):   {sources.get('medium_reliability', 0):,}")

    worst = data["source_health"]["worst_error_sources"]
    if worst and verbose:
        print(f"\n  Top erroring sources:")
        for s in worst[:5]:
            print(f"    [{s['error_count']} errors] {s['name']}")

    section("ARTICLE HEALTH")
    print(f"  Last hour:   {articles.get('last_hour', 0):>6,}  articles")
    print(f"  Last 6h:     {articles.get('last_6h', 0):>6,}  articles")
    print(f"  Last 24h:    {articles.get('last_24h', 0):>6,}  articles")
    print(f"  Last 7d:     {articles.get('last_7d', 0):>6,}  articles")
    print(f"  Empty titles: {articles.get('empty_titles', 0):>5,}  {SEVERITY['warn'] if articles.get('empty_titles', 0) > 100 else SEVERITY['ok']}")
    print(f"  No location:  {articles.get('no_location', 0):>5,}")
    empty_srcs = data["article_health"]["empty_by_source"]
    if empty_srcs and verbose:
        print(f"\n  Top sources with empty titles (7d):")
        for s in empty_srcs:
            print(f"    {s['name']}: {s['cnt']}")

    dups = data["article_health"]["top_duplicates"]
    if dups and verbose:
        print(f"\n  Top duplicate titles (7d):")
        for d in dups[:5]:
            print(f"    [{d['cnt']}x] {d['title'][:60]}")

    section("LOCATION HEALTH")
    null_country = loc_stats.get("null_country", 0)
    invalid_coords = loc_stats.get("invalid_coords", 0)
    valid_located = loc_stats.get("valid_located", 0)
    total_locs = loc_stats.get("total", 0)
    art_no_country = data["location_health"]["articles_no_country"]
    print(f"  Total locations:   {total_locs:,}")
    print(f"  Valid + country:   {valid_located:,}  {SEVERITY['ok']}")
    print(f"  NULL country:      {null_country:,}  {SEVERITY['warn'] if null_country > 50 else SEVERITY['ok']}")
    print(f"  Invalid coords:    {invalid_coords:,}  {SEVERITY['fail'] if invalid_coords else SEVERITY['ok']}")
    print(f"  Articles no country: {art_no_country:,}  {SEVERITY['warn'] if art_no_country > 50 else SEVERITY['ok']}")

    section("EVENT HEALTH")
    print(f"  Total:        {events.get('total', 0):>6,}")
    print(f"  Last hour:    {events.get('last_hour', 0):>6,}  events")
    print(f"  Last 24h:     {events.get('last_24h', 0):>6,}  events")
    print(f"  Last 7d:      {events.get('last_7d', 0):>6,}  events")
    print(f"  Event types:  {events.get('distinct_types', 0):>5,}")
    ev_types = data["event_health"]["top_types"]
    if ev_types:
        print(f"  Top types (7d):")
        for t in ev_types[:5]:
            print(f"    {t['event_type']}: {t['cnt']}")

    section("NN PIPELINE")
    print(f"  Inference queue pending:  {nn.get('pending', 0):>5,}")
    print(f"  Inference queue failed:   {nn.get('failed', 0):>5,}")
    print(f"  Queue items needing geo:  {nn.get('needs_geo', 0):>5,}")
    print(f"  Last queue enqueue:       {nn.get('last_enqueued', 'unknown')}")
    print(f"    — fake labels (label=0): {fake:,}")
    print(f"    — real labels (label≠0): {real:,}")

    if live:
        section("LIVE CHECKS")
        api_ms = data.get("api_ms")
        if api_ms is not None:
            print(f"  API /agent/health: {api_ms:.0f}ms  {SEVERITY['ok'] if api_ms < 200 else SEVERITY['warn']}")
        else:
            print(f"  API: not reachable  {SEVERITY['fail']}")

        ai = data.get("ai_endpoint", {})
        if ai.get("reachable"):
            print(f"  AI endpoint: reachable  {SEVERITY['ok']} (status {ai.get('status')})")
        else:
            print(f"  AI endpoint: {ai.get('reason', 'unreachable')}  {SEVERITY['fail']}")

        feeds = data.get("feed_samples", {})
        for name, result in feeds.items():
            if result.get("ok"):
                print(f"  RSS [{name}]: OK  {result.get('status')}  {result.get('size_kb', 0):.0f}KB  {SEVERITY['ok']}")
            else:
                print(f"  RSS [{name}]: FAIL  {result.get('error', result.get('status'))}  {SEVERITY['fail']}")

    worker = data.get("worker_liveness", {})
    section("WORKER LIVENESS")
    print(f"  Last RSS source success: {worker.get('last_rss') or 'NEVER'}")
    print(f"  Last web source success:  {worker.get('last_web') or 'NEVER'}")
    print(f"  Last JSON source success: {worker.get('last_json') or 'NEVER'}")

    if data.get("fixes_applied"):
        section("AUTO-FIXES APPLIED")
        for k, v in data["fixes_applied"].items():
            print(f"  {k}: {v:,}")


def main() -> int:
    p = argparse.ArgumentParser(description="Xyzo quick health checks")
    p.add_argument("--live", action="store_true", help="Include slow live checks (HTTP, AI, feeds)")
    p.add_argument("--json", action="store_true", help="Machine-readable JSON output")
    p.add_argument("--fix", action="store_true", help="Auto-fix what can be fixed")
    p.add_argument("-v", "--verbose", action="store_true", help="Show details")
    args = p.parse_args()

    data = {
        "timestamp": NOW.isoformat(),
        "db_size": check_db_size(),
        "source_health": check_source_health(),
        "article_health": check_article_health(),
        "location_health": check_location_health(),
        "event_health": check_event_health(),
        "nn_pipeline": check_nn_pipeline(),
        "worker_liveness": check_worker_liveness(),
    }

    if args.live and HAS_HTTPX:
        data["api_ms"] = check_api_responsive()
        data["ai_endpoint"] = check_ai_endpoint()
        data["feed_samples"] = check_feed_sample()

    if args.fix:
        data["fixes_applied"] = auto_fix()

    print_report(data, live=args.live, json_out=args.json, verbose=args.verbose)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
