#!/usr/bin/env python3
"""Feed connectivity + parser validator, with robots.txt compliance.

Concurrently probes every enabled feed in feeds.json:
  1. Warm a per-host robots.txt cache (8-way parallel)
  2. For each feed: short-circuit if robots disallows, otherwise GET + parse
  3. Print a sortable summary table

Sort order: FAILED > EMPTY > BLOCK > SUCCESS, then alphabetical.
Pre-fetched robots.txt answers let the live fetcher skip blocked hosts in O(1).

Flags:
  --disable-failed    set enabled=false on FAILED feeds
  --remove-failed     drop FAILED feeds from feeds.json entirely
  --disable-blocked   set enabled=false on robots-BLOCKed feeds
  --remove-blocked    drop robots-BLOCKed feeds from feeds.json entirely
"""
import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx

# Make the worker package importable when run as a script.
sys.path.insert(0, str(Path(__file__).parent.parent.absolute()))

from worker.fetch import load_feeds, parse_feed, USER_AGENT, REQUEST_TIMEOUT
from worker.robots import RobotsCache


async def warm_robots(unique_hosts: list[str], ttl_s: int = 86400) -> RobotsCache:
    """Fetch /robots.txt for every host once, in parallel under a semaphore."""
    cache = RobotsCache(ttl_s=ttl_s)
    sem = asyncio.Semaphore(8)

    async def warm_one(host: str) -> None:
        async with sem:
            loop = asyncio.get_running_loop()
            try:
                # Dummy URL on the host — RobotsCache only uses the hostname.
                await loop.run_in_executor(None, cache.is_allowed, f"https://{host}/")
            except Exception:  # noqa: BLE001 — robots failure should never abort the run
                pass

    await asyncio.gather(*[warm_one(h) for h in unique_hosts])
    return cache


async def test_feed(
    client: httpx.AsyncClient, robots: RobotsCache, source: dict
) -> dict:
    """Probe a single feed. Robots check first (cache hit after warm-up)."""
    name = source["name"]
    url = source["feed_url"]
    source_type = source.get("source_type", "rss")

    loop = asyncio.get_running_loop()
    try:
        _, _, blocked_path = await loop.run_in_executor(None, robots.is_allowed, url)
        robots_status = "ALLOW" if blocked_path is None else "BLOCK"
    except Exception:  # noqa: BLE001
        robots_status = "ERR"
        blocked_path = None

    result = {
        "name": name,
        "url": url,
        "status": "FAILED",
        "status_code": None,
        "time_ms": 0,
        "articles_count": 0,
        "error": None,
        "first_article_title": None,
        "robots": robots_status,
        "blocked_path": blocked_path,
    }

    t0 = time.perf_counter()
    try:
        resp = await client.get(url, timeout=REQUEST_TIMEOUT, follow_redirects=True)
        result["time_ms"] = int((time.perf_counter() - t0) * 1000)
        result["status_code"] = resp.status_code

        if resp.status_code != 200:
            result["error"] = f"HTTP {resp.status_code}"
            return result

        articles = parse_feed(resp.content, source_type)
        result["articles_count"] = len(articles)

        if len(articles) > 0:
            result["status"] = "SUCCESS"
            result["first_article_title"] = articles[0].get("title", "")
        else:
            result["status"] = "EMPTY"
            result["error"] = "Parsed successfully but returned 0 articles"

    except httpx.HTTPError as exc:
        result["time_ms"] = int((time.perf_counter() - t0) * 1000)
        result["error"] = f"Network Error: {type(exc).__name__}"
    except Exception as exc:  # noqa: BLE001
        result["time_ms"] = int((time.perf_counter() - t0) * 1000)
        result["error"] = f"Parser/Unexpected Error: {type(exc).__name__}: {str(exc)[:50]}"

    return result


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Newsium Feed Validation Utility (with robots.txt compliance)"
    )
    parser.add_argument(
        "--disable-failed",
        action="store_true",
        help="Set enabled=false in feeds.json for failing feeds",
    )
    parser.add_argument(
        "--remove-failed",
        action="store_true",
        help="Drop failing feeds from feeds.json entirely",
    )
    parser.add_argument(
        "--disable-blocked",
        action="store_true",
        help="Set enabled=false in feeds.json for robots-blocked feeds",
    )
    parser.add_argument(
        "--remove-blocked",
        action="store_true",
        help="Drop robots-blocked feeds from feeds.json entirely",
    )
    args = parser.parse_args()

    print("=" * 80)
    print("Newsium Feed Validation Utility  (robots.txt compliant)")
    print("=" * 80)

    feeds_file = Path(__file__).parent / "feeds.json"
    try:
        with feeds_file.open() as f:
            all_feeds_data = json.load(f)
            feeds = [fd for fd in all_feeds_data.get("feeds", []) if fd.get("enabled", True)]
    except Exception as e:
        print(f"Error loading feeds.json: {e}", file=sys.stderr)
        sys.exit(1)

    if not feeds:
        print("No enabled feeds to check.")
        sys.exit(0)

    unique_hosts = sorted({urlparse(f["feed_url"]).netloc.lower() for f in feeds})
    print(f"Loaded {len(feeds)} enabled feeds across {len(unique_hosts)} unique hosts.")
    print(f"Warming robots.txt cache for {len(unique_hosts)} hosts (parallel, 8-way)...")

    t_warm = time.perf_counter()
    robots = await warm_robots(unique_hosts)
    print(f"robots.txt cache warmed in {time.perf_counter() - t_warm:.1f}s.\n")

    headers = {"User-Agent": USER_AGENT}
    limits = httpx.Limits(max_keepalive_connections=5, max_connections=20)

    async with httpx.AsyncClient(headers=headers, limits=limits) as client:
        tasks = [test_feed(client, robots, source) for source in feeds]
        results = await asyncio.gather(*tasks)

    # Sort: problems first (FAILED > EMPTY > BLOCK > SUCCESS), then by robots, then name.
    priority = {"FAILED": 0, "EMPTY": 1, "BLOCK": 2, "SUCCESS": 3}
    results.sort(
        key=lambda r: (
            priority.get(r["status"], 9),
            r["robots"] != "ALLOW",
            r["name"],
        )
    )

    print("=" * 130)
    print(
        f"{'Source':<28} | {'Status':<7} | {'Robots':<6} | {'HTTP':<4} | "
        f"{'Latency':<8} | {'Articles':<8} | {'Details':<60}"
    )
    print("=" * 130)

    counts = {"SUCCESS": 0, "EMPTY": 0, "FAILED": 0, "BLOCK": 0}
    failed_urls: set[str] = set()
    blocked_urls: set[str] = set()

    for r in results:
        # A SUCCESSFUL fetch that robots disallows is still effectively BLOCKed
        # — the live fetcher will short-circuit it. Surface that prominently.
        if r["status"] == "SUCCESS" and r["robots"] == "BLOCK":
            display_status = "BLOCK"
        else:
            display_status = r["status"]

        counts[display_status] = counts.get(display_status, 0) + 1
        if display_status == "FAILED":
            failed_urls.add(r["url"])
        if display_status == "BLOCK":
            blocked_urls.add(r["url"])

        if display_status == "BLOCK":
            details = f"robots disallow: {r['blocked_path'] or '/'}"
        elif display_status == "SUCCESS":
            details = (r["first_article_title"] or "")[:60]
        elif display_status == "EMPTY":
            details = r["error"] or ""
        else:
            details = r["error"] or "Unknown"

        latency = f"{r['time_ms']}ms" if r["time_ms"] > 0 else "N/A"
        http_code = str(r["status_code"]) if r["status_code"] else "N/A"

        print(
            f"{r['name'][:27]:<28} | {display_status:<7} | {r['robots']:<6} | "
            f"{http_code:<4} | {latency:>8} | {r['articles_count']:<8} | {details:<60}"
        )

    print("=" * 130)
    parts = [f"{counts[k]} {k}" for k in ("SUCCESS", "BLOCK", "EMPTY", "FAILED") if counts.get(k)]
    print(f"Summary: {' | '.join(parts)}   (out of {len(feeds)} enabled)")
    print("=" * 130)

    # Mutate feeds.json if requested.
    will_disable_failed = bool(failed_urls) and (args.disable_failed or args.remove_failed)
    will_disable_blocked = bool(blocked_urls) and (args.disable_blocked or args.remove_blocked)

    if will_disable_failed or will_disable_blocked:
        kept: list[dict] = []
        modified = {"failed": 0, "blocked": 0}

        for fd in all_feeds_data.get("feeds", []):
            drop = False
            if fd["feed_url"] in failed_urls and will_disable_failed:
                if args.remove_failed:
                    drop = True
                else:
                    fd["enabled"] = False
                modified["failed"] += 1
            if fd["feed_url"] in blocked_urls and will_disable_blocked:
                if args.remove_blocked:
                    drop = True
                else:
                    fd["enabled"] = False
                modified["blocked"] += 1
            if not drop:
                kept.append(fd)

        all_feeds_data["feeds"] = kept
        with feeds_file.open("w") as f:
            json.dump(all_feeds_data, f, indent=2)

        verb = "Removed" if (args.remove_failed or args.remove_blocked) else "Disabled"
        print(
            f"\n{verb} {modified['failed']} failed and {modified['blocked']} blocked "
            f"feed(s) in feeds.json."
        )

    # Real fetcher exits non-zero only on actual broken feeds — polite blocks
    # are not failures.
    if counts.get("FAILED", 0) > 0 and not (args.disable_failed or args.remove_failed):
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    asyncio.run(main())
