"""Auto Robots Checker for news_science_sources.

Reads all pending science sources, checks robots.txt via RobotsCache,
updates robots_status/has_sitemap/has_rss/etc in news_science_sources.

Run:
    python3 -m worker.auto_robots_checker
    python3 -m worker.auto_robots_checker --dry-run
"""
import json
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

from .db import connect
from .robots import RobotsCache

log = logging.getLogger("xyzo.auto_robots_checker")

BATCH = 50
WORKERS = 8
USER_AGENT = "XyzoFetcher/0.1 (+https://xyzo.org/bot)"


def process_row(rc: RobotsCache, row: dict) -> dict:
    url = row["url"] or f"https://{row['domain']}"
    verdict = rc.is_allowed(url)
    entry = rc._cache.get(rc._host(url))
    http_status = entry.http_status if entry else None
    return {
        "id": row["id"],
        "robots_status": (
            "allowed" if verdict.allowed
            else "blocked" if verdict.note != "5xx-server-error"
            else "temp_blocked"
        ),
        "robots_checked_at": "NOW()",
        "robots_http_status": http_status,
        "robots_blocked_path": verdict.disallowed_path,
        "robots_sitemaps": json.dumps(verdict.sitemaps or []),
        "robots_crawl_delay_s": verdict.crawl_delay_s,
        "last_check_at": "NOW()",
        "last_http_status": http_status,
    }


def run(dry_run: bool = False, limit: int | None = None) -> dict:
    rc = RobotsCache()
    stats = {"checked": 0, "allowed": 0, "blocked": 0, "errors": 0, "skipped": 0}

    while True:
        with connect() as conn:
            rows = conn.execute("""
                SELECT id, name, domain, url, science_tier
                FROM news_science_sources
                WHERE robots_status = 'pending'
                ORDER BY science_tier ASC, id ASC
                LIMIT %s
            """, (BATCH,)).fetchall()

        if not rows:
            break

        updates = []
        for row in rows:
            if limit is not None and stats["checked"] >= limit:
                break
            try:
                upd = process_row(rc, row)
                updates.append(upd)
                stats["checked"] += 1
                if upd["robots_status"] == "allowed":
                    stats["allowed"] += 1
                elif upd["robots_status"] == "blocked":
                    stats["blocked"] += 1
            except Exception as e:
                log.warning("Error checking %s (%s): %s", row["domain"], row["id"], e)
                stats["errors"] += 1

        if dry_run:
            for u in updates:
                log.info("  [dry-run] %s: %s", u["id"], u["robots_status"])
            break

        if updates:
            with connect() as conn:
                for u in updates:
                    conn.execute("""
                        UPDATE news_science_sources SET
                            robots_status       = %s,
                            robots_checked_at   = NOW(),
                            robots_http_status  = %s,
                            robots_blocked_path = %s,
                            robots_sitemaps     = %s,
                            robots_crawl_delay_s= %s,
                            last_check_at       = NOW(),
                            last_http_status    = %s
                        WHERE id = %s
                    """, (
                        u["robots_status"], u["robots_http_status"],
                        u["robots_blocked_path"], u["robots_sitemaps"],
                        u["robots_crawl_delay_s"], u["last_http_status"],
                        u["id"],
                    ))
                conn.commit()

        if limit is not None and stats["checked"] >= limit:
            break

    log.info(
        "auto_robots_checker: checked=%d allowed=%d blocked=%d errors=%d skipped=%d",
        stats["checked"], stats["allowed"], stats["blocked"],
        stats["errors"], stats["skipped"],
    )
    return stats


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    dry = "--dry-run" in sys.argv
    limit = None
    for arg in sys.argv[1:]:
        if arg.lstrip("-").isdigit():
            limit = int(arg)
    result = run(dry_run=dry, limit=limit)
    print(json.dumps(result))
