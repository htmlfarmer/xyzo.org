"""Source Health Checker — validates and fixes news source URLs.

This module:
  1. Tests all enabled sources for HTTP errors
  2. Updates URLs for redirected sources (301/302)
  3. Disables sources returning 404, 403, or other errors
  4. Re-enables previously disabled sources if they start working

Usage:
  python -m worker.check_sources --fix         # Fix all issues
  python -m worker.check_sources --test        # Test without fixing
  python -m worker.check_sources --re-enable   # Try re-enabling disabled sources
"""

import json
import logging
import time
from pathlib import Path

import httpx

from .db import connect

log = logging.getLogger("xyzo.check_sources")

FEEDS_FILE = Path(__file__).parent / "feeds.json"
USER_AGENT = "xyzo-fetcher/0.1 (https://xyzo.org; contact@xyzo.org)"
TIMEOUT_S = 15.0


def test_source(url: str) -> dict:
    """Test a single source URL and return status info."""
    try:
        with httpx.Client(timeout=TIMEOUT_S, follow_redirects=False) as client:
            resp = client.get(url, headers={"User-Agent": USER_AGENT})

            if resp.status_code == 200:
                return {"status": "ok", "code": 200}
            elif resp.status_code in (301, 302, 303, 307, 308):
                new_url = resp.headers.get("location", "")
                # Handle relative redirects
                if new_url and new_url.startswith("/"):
                    from urllib.parse import urlparse
                    parsed = urlparse(url)
                    new_url = f"{parsed.scheme}://{parsed.netloc}{new_url}"
                return {"status": "redirect", "code": resp.status_code, "new_url": new_url}
            elif resp.status_code == 404:
                return {"status": "not_found", "code": 404}
            elif resp.status_code == 403:
                return {"status": "forbidden", "code": 403}
            elif resp.status_code == 410:
                return {"status": "gone", "code": 410}
            else:
                return {"status": "error", "code": resp.status_code}

    except httpx.ConnectError as e:
        return {"status": "connect_error", "error": str(e)[:100]}
    except httpx.TimeoutException:
        return {"status": "timeout"}
    except httpx.TooManyRedirects:
        return {"status": "too_many_redirects"}
    except Exception as e:
        return {"status": "error", "error": str(e)[:100]}


def check_all_sources(test_disabled: bool = False) -> dict:
    """Check all sources and return status report."""
    with connect() as conn, conn.cursor() as cur:
        if test_disabled:
            cur.execute("SELECT id, name, feed_url, country, active FROM news_sources ORDER BY id")
        else:
            cur.execute("SELECT id, name, feed_url, country, active FROM news_sources WHERE active = TRUE ORDER BY id")
        sources = cur.fetchall()

    results = {
        "ok": [],
        "redirect": [],
        "not_found": [],
        "forbidden": [],
        "gone": [],
        "other_error": [],
    }

    for src in sources:
        result = test_source(src["feed_url"])
        result["id"] = src["id"]
        result["name"] = src["name"]
        result["url"] = src["feed_url"]
        result["country"] = src["country"]
        result["active"] = src["active"]

        if result["status"] == "ok":
            results["ok"].append(result)
        elif result["status"] == "redirect":
            results["redirect"].append(result)
        elif result["status"] == "not_found":
            results["not_found"].append(result)
        elif result["status"] == "forbidden":
            results["forbidden"].append(result)
        elif result["status"] == "gone":
            results["gone"].append(result)
        else:
            results["other_error"].append(result)

        time.sleep(0.5)  # Rate limit

    return results


def fix_redirects(redirects: list[dict]) -> int:
    """Update URLs for redirected sources."""
    fixed = 0

    with connect() as conn, conn.cursor() as cur:
        for r in redirects:
            if not r.get("new_url"):
                continue

            new_url = r["new_url"]
            source_id = r["id"]

            # Update in database
            cur.execute("""
                UPDATE news_sources
                SET feed_url = %s, error_count = 0, last_failure_at = NULL
                WHERE id = %s
            """, (new_url, source_id))

            log.info("Updated %s: %s -> %s", r["name"], r["url"][:50], new_url[:50])
            fixed += 1

    # Also update feeds.json
    _update_feeds_json(redirects)

    return fixed


def disable_sources(sources: list[dict], reason: str = "") -> int:
    """Disable sources that are returning errors."""
    disabled = 0

    with connect() as conn, conn.cursor() as cur:
        for s in sources:
            source_id = s["id"]

            cur.execute("""
                UPDATE news_sources
                SET active = FALSE, robots_blocked_at = now(), robots_block_path = %s
                WHERE id = %s AND active = TRUE
            """, (f"auto-disabled: {reason} ({s.get('code', s.get('error', 'unknown'))})", source_id))

            if cur.rowcount > 0:
                log.info("Disabled %s (%s): %s", s["name"], s["country"], reason)
                disabled += 1

    # Also update feeds.json
    _disable_in_feeds_json(sources)

    return disabled


def re_enable_sources() -> dict:
    """Try re-enabling previously disabled sources."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, feed_url, country, robots_block_path
            FROM news_sources
            WHERE active = FALSE
              AND robots_blocked_at IS NOT NULL
              AND robots_blocked_at < now() - interval '24 hours'
            ORDER BY robots_blocked_at DESC
            LIMIT 50
        """)
        sources = cur.fetchall()

    results = {"tested": 0, "re_enabled": 0, "still_broken": 0}

    for src in sources:
        result = test_source(src["feed_url"])
        results["tested"] += 1

        if result["status"] == "ok":
            with connect() as conn, conn.cursor() as cur:
                cur.execute("""
                    UPDATE news_sources
                    SET active = TRUE, error_count = 0, robots_blocked_at = NULL, robots_block_path = NULL
                    WHERE id = %s
                """, (src["id"],))
            results["re_enabled"] += 1
            log.info("Re-enabled %s (%s)", src["name"], src["country"])
        else:
            results["still_broken"] += 1

        time.sleep(0.5)

    return results


def _update_feeds_json(redirects: list[dict]) -> None:
    """Update feed URLs in feeds.json."""
    try:
        with FEEDS_FILE.open() as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return

    url_map = {r["url"]: r["new_url"] for r in redirects if r.get("new_url")}

    for feed in data["feeds"]:
        if feed["feed_url"] in url_map:
            feed["feed_url"] = url_map[feed["feed_url"]]

    with FEEDS_FILE.open("w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _disable_in_feeds_json(sources: list[dict]) -> None:
    """Disable sources in feeds.json."""
    try:
        with FEEDS_FILE.open() as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return

    urls_to_disable = {s["url"] for s in sources}

    for feed in data["feeds"]:
        if feed["feed_url"] in urls_to_disable:
            feed["enabled"] = False

    with FEEDS_FILE.open("w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def fix_all(dry_run: bool = False) -> dict:
    """Run complete source health check and fix."""
    log.info("Checking all enabled sources...")
    results = check_all_sources(test_disabled=False)

    summary = {
        "ok": len(results["ok"]),
        "redirect": len(results["redirect"]),
        "not_found": len(results["not_found"]),
        "forbidden": len(results["forbidden"]),
        "gone": len(results["gone"]),
        "other_error": len(results["other_error"]),
        "fixed": 0,
        "disabled": 0,
    }

    if dry_run:
        log.info("DRY RUN - would fix %d redirects, disable %d sources",
                 len(results["redirect"]),
                 len(results["not_found"]) + len(results["forbidden"]) + len(results["gone"]) + len(results["other_error"]))
        return summary

    # Fix redirects
    if results["redirect"]:
        summary["fixed"] = fix_redirects(results["redirect"])

    # Disable broken sources
    to_disable = results["not_found"] + results["forbidden"] + results["gone"] + results["other_error"]
    if to_disable:
        summary["disabled"] = disable_sources(to_disable, "HTTP error")

    return summary


# CLI entry point
if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    parser = argparse.ArgumentParser(description="News source health checker")
    parser.add_argument("--fix", action="store_true", help="Fix all issues")
    parser.add_argument("--test", action="store_true", help="Test without fixing")
    parser.add_argument("--re-enable", action="store_true", help="Try re-enabling disabled sources")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done")
    args = parser.parse_args()

    if args.re_enable:
        results = re_enable_sources()
        print(f"\nTested: {results['tested']}")
        print(f"Re-enabled: {results['re_enabled']}")
        print(f"Still broken: {results['still_broken']}")

    elif args.fix or args.dry_run:
        results = fix_all(dry_run=args.dry_run)
        print(f"\n=== Source Health Check ===")
        print(f"OK: {results['ok']}")
        print(f"Redirects: {results['redirect']} (fixed: {results['fixed']})")
        print(f"Not Found: {results['not_found']}")
        print(f"Forbidden: {results['forbidden']}")
        print(f"Gone: {results['gone']}")
        print(f"Other errors: {results['other_error']}")
        print(f"Total disabled: {results['disabled']}")

    else:
        # Default: test mode
        results = check_all_sources(test_disabled=False)
        print(f"\n=== Source Status Report ===")
        print(f"OK: {len(results['ok'])}")
        print(f"Redirects: {len(results['redirect'])}")
        print(f"Not Found: {len(results['not_found'])}")
        print(f"Forbidden: {len(results['forbidden'])}")
        print(f"Gone: {len(results['gone'])}")
        print(f"Other errors: {len(results['other_error'])}")

        if results["redirect"]:
            print(f"\n--- Redirects ({len(results['redirect'])}) ---")
            for r in results["redirect"]:
                print(f"  {r['name']} ({r['country']}): {r['new_url'][:60]}")

        if results["not_found"]:
            print(f"\n--- Not Found ({len(results['not_found'])}) ---")
            for r in results["not_found"]:
                print(f"  {r['name']} ({r['country']})")

        if results["forbidden"]:
            print(f"\n--- Forbidden ({len(results['forbidden'])}) ---")
            for r in results["forbidden"]:
                print(f"  {r['name']} ({r['country']})")
