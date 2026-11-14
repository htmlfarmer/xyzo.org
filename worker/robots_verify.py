"""Periodic robots.txt verification — persists results to news_sources.

This uses the existing RobotsCache from worker/robots.py, which already
handles fetching, parsing, sitemap extraction, and politeness tiers.
This script's job is to:
  1. Find sources that haven't been checked recently (or never)
  2. Force RobotsCache to refresh each host's robots.txt
  3. Persist the results to news_sources columns:
       robots_checked_at, robots_status, robots_content_hash,
       robots_http_status, robots_sitemaps, robots_crawl_delay_s

Run:
    python -m worker.robots_verify                          # all unverified sources
    python -m worker.robots_verify --dry-run              # count only
    python -m worker.robots_verify --since 7              # not checked in 7 days
    python -m worker.robots_verify --limit 500            # max hosts per run
    python -m worker.robots_verify --only-changed         # re-check all verified hosts, persist only on hash change
    python -m worker.robots_verify --only-changed --verbose  # show each changed host
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

import psycopg

from robots import RobotsCache, RobotsVerdict

log = logging.getLogger("xyzo.robots_verify")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo",
)

DEFAULT_BATCH = 500
DEFAULT_RECHECK_DAYS = 7
PARALLEL_HOSTS = 16


def _host(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def get_sources_needing_check(since_days: int | None, limit: int) -> list[dict]:
    where_parts = [
        "active = TRUE",
        "deleted_at IS NULL",
        "feed_url IS NOT NULL",
    ]
    if since_days is not None:
        where_parts.append(
            f"(robots_checked_at IS NULL OR robots_checked_at < now() - interval '{since_days} days')"
        )

    where_clause = " AND ".join(where_parts)
    query = f"""
        SELECT DISTINCT ON (host)
               id,
               host,
               feed_url,
               robots_checked_at,
               robots_status,
               robots_content_hash
        FROM (
            SELECT id,
                   feed_url,
                   LOWER(SPLIT_PART(SPLIT_PART(feed_url, '://', 2), '/', 1)) AS host,
                   robots_checked_at,
                   robots_status,
                   robots_content_hash
            FROM news_sources
            WHERE {where_clause}
        ) AS sub(id, feed_url, host, robots_checked_at, robots_status, robots_content_hash)
        ORDER BY host, id
        LIMIT {limit}
    """
    with psycopg.connect(DSN) as conn, conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute(query)
        return list(cur.fetchall())


def get_all_checked_sources(limit: int) -> list[dict]:
    """Return all active sources that have been verified at least once, grouped by host."""
    query = f"""
        SELECT DISTINCT ON (host)
               id,
               host,
               feed_url,
               robots_checked_at,
               robots_status,
               robots_content_hash
        FROM (
            SELECT id,
                   feed_url,
                   LOWER(SPLIT_PART(SPLIT_PART(feed_url, '://', 2), '/', 1)) AS host,
                   robots_checked_at,
                   robots_status,
                   robots_content_hash
            FROM news_sources
            WHERE active = TRUE
              AND deleted_at IS NULL
              AND feed_url IS NOT NULL
              AND robots_content_hash IS NOT NULL
        ) AS sub(id, feed_url, host, robots_checked_at, robots_status, robots_content_hash)
        ORDER BY host, id
        LIMIT {limit}
    """
    with psycopg.connect(DSN) as conn, conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute(query)
        return list(cur.fetchall())


def get_all_sources(limit: int) -> list[dict]:
    query = f"""
        SELECT DISTINCT ON (host)
               id,
               host,
               feed_url,
               robots_checked_at,
               robots_status,
               robots_content_hash
        FROM (
            SELECT id,
                   feed_url,
                   LOWER(SPLIT_PART(SPLIT_PART(feed_url, '://', 2), '/', 1)) AS host,
                   robots_checked_at,
                   robots_status,
                   robots_content_hash
            FROM news_sources
            WHERE active = TRUE AND deleted_at IS NULL AND feed_url IS NOT NULL
        ) AS sub(id, feed_url, host, robots_checked_at, robots_status, robots_content_hash)
        ORDER BY host, id
        LIMIT {limit}
    """
    with psycopg.connect(DSN) as conn, conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute(query)
        return list(cur.fetchall())


def run_batch(sources: list[dict], max_workers: int = PARALLEL_HOSTS) -> list[dict]:
    results = []

    def check_one(src: dict) -> dict:
        host = src["host"]
        try:
            cache = RobotsCache(ttl_s=0)
            verdict = cache.is_allowed(src["feed_url"])
            cache.persist_to_db(src["id"], src["feed_url"], verdict)
            entry = cache._cache.get(host)
            return {
                "id": src["id"],
                "host": host,
                "status": "ok",
                "verdict": verdict.allowed,
                "http_status": entry.http_status if entry else None,
            }
        except Exception as exc:
            return {
                "id": src["id"],
                "host": host,
                "status": "error",
                "error": str(exc)[:200],
            }

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(check_one, src): src for src in sources}
        for future in as_completed(futures):
            results.append(future.result())

    return results


def run_batch_changed(
    sources: list[dict], max_workers: int = PARALLEL_HOSTS, verbose: bool = False
) -> dict:
    """Re-check previously-verified sources; only persist if robots.txt content changed.

    Returns {"checked": N, "changed": M, "errors": K, "details": [...]}.
    """
    import hashlib

    changed_records: list[dict] = []
    errors: list[dict] = []

    def check_one(src: dict) -> dict:
        host = src["host"]
        stored_hash = src.get("robots_content_hash")
        try:
            cache = RobotsCache(ttl_s=0)
            verdict = cache.is_allowed(src["feed_url"])
            entry = cache._cache.get(host)

            new_hash = None
            if entry and entry.raw_text:
                new_hash = hashlib.sha256(entry.raw_text.encode()).hexdigest()

            if new_hash != stored_hash:
                cache.persist_to_db(src["id"], src["feed_url"], verdict)
                return {
                    "id": src["id"],
                    "host": host,
                    "status": "changed",
                    "old_hash": stored_hash,
                    "new_hash": new_hash,
                    "verdict": verdict.allowed,
                }
            return {
                "id": src["id"],
                "host": host,
                "status": "unchanged",
            }
        except Exception as exc:
            return {
                "id": src["id"],
                "host": host,
                "status": "error",
                "error": str(exc)[:200],
            }

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(check_one, src): src for src in sources}
        for future in as_completed(futures):
            result = future.result()
            if result["status"] == "changed":
                changed_records.append(result)
                if verbose:
                    log.info("  CHANGED %s: %s → %s",
                             result["host"], result["old_hash"][:16] if result["old_hash"] else "none",
                             result["new_hash"][:16] if result["new_hash"] else "none")
            elif result["status"] == "error":
                errors.append(result)

    return {
        "checked": len(sources),
        "changed": len(changed_records),
        "errors": len(errors),
        "details": changed_records,
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Verify robots.txt for news sources")
    p.add_argument("--dry-run", action="store_true", help="Count sources, don't update DB")
    p.add_argument("--since", type=int, default=DEFAULT_RECHECK_DAYS,
                   help=f"Re-check sources not verified in N days (default {DEFAULT_RECHECK_DAYS})")
    p.add_argument("--limit", type=int, default=DEFAULT_BATCH,
                   help=f"Max hosts per run (default {DEFAULT_BATCH})")
    p.add_argument("--workers", type=int, default=PARALLEL_HOSTS,
                   help=f"Parallel fetches (default {PARALLEL_HOSTS})")
    p.add_argument("--quiet", action="store_true", help="Warnings only")
    p.add_argument("--only-changed", action="store_true",
                   help="Only re-check hosts that already have a hash; persist only on change")
    p.add_argument("--verbose", action="store_true",
                   help="Show each changed host when using --only-changed")
    args = p.parse_args()

    if args.quiet:
        logging.getLogger().setLevel(logging.WARNING)

    if args.only_changed:
        log.info("Fetching all previously-verified sources (limit=%d)...", args.limit)
        sources = get_all_checked_sources(args.limit)
        log.info("Found %d verified sources to re-check", len(sources))
        if not sources:
            return 0
        total_checked = 0
        total_changed = 0
        total_errors = 0
        for i in range(0, len(sources), DEFAULT_BATCH):
            batch = sources[i:i + DEFAULT_BATCH]
            log.info("Batch %d–%d of %d...",
                     i + 1, min(i + DEFAULT_BATCH, len(sources)), len(sources))
            result = run_batch_changed(batch, max_workers=args.workers, verbose=args.verbose)
            total_checked += result["checked"]
            total_changed += result["changed"]
            total_errors += result["errors"]
            if i + DEFAULT_BATCH < len(sources):
                time.sleep(2)
        log.info("Done: %d checked, %d changed, %d errors", total_checked, total_changed, total_errors)
        return 0

    log.info("Fetching sources needing robots.txt check (since=%s, limit=%d)...",
             args.since, args.limit)
    sources = get_sources_needing_check(args.since, args.limit)
    log.info("Found %d sources needing check", len(sources))

    if not sources:
        log.info("Nothing to do.")
        return 0

    if args.dry_run:
        log.info("[DRY RUN] First 10 hosts:")
        for s in sources[:10]:
            log.info("  %s (%s) — last checked: %s — status: %s",
                     s["host"], s["id"], s.get("robots_checked_at"), s.get("robots_status", "pending"))
        if len(sources) > 10:
            log.info("  ... and %d more", len(sources) - 10)
        return 0

    total_ok = 0
    total_errors = 0
    total_blocked = 0

    for i in range(0, len(sources), DEFAULT_BATCH):
        batch = sources[i:i + DEFAULT_BATCH]
        log.info("Batch %d–%d of %d...",
                 i + 1, min(i + DEFAULT_BATCH, len(sources)), len(sources))
        results = run_batch(batch, max_workers=args.workers)
        for r in results:
            if r["status"] == "ok":
                total_ok += 1
                if not r["verdict"]:
                    total_blocked += 1
            else:
                total_errors += 1
                log.warning("  %s: %s", r["host"], r.get("error", "unknown"))

        log.info("  -> %d ok, %d blocked, %d errors",
                 sum(1 for r in results if r["status"] == "ok"),
                 sum(1 for r in results if r["status"] == "ok" and not r["verdict"]),
                 sum(1 for r in results if r["status"] == "error"))

        if i + DEFAULT_BATCH < len(sources):
            time.sleep(2)

    log.info("Done: %d checked, %d ok, %d blocked, %d errors",
             len(sources), total_ok, total_blocked, total_errors)
    return 0


if __name__ == "__main__":
    sys.exit(main())
