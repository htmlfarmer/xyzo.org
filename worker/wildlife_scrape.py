"""Second pass for the wildlife registry: can the SITE be scraped?

A feed is the cheap path. When a publisher has no working feed, the
site itself may still carry a newsroom listing — and the fetcher already
has a second ingestion mode for exactly that (``source_type='web'``,
``worker/web_scraper.py``), used by 1,006 live sources already.

This probes the failed candidates with ``validate_web_source()``, which
checks robots.txt, fetches the homepage, extracts the article links and
verifies that at least one article body can actually be read.

Run:  python3 -m worker.wildlife_sources scrape-probe
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .web_scraper import validate_web_source

REGISTRY_PATH = Path(__file__).parent / "data" / "wildlife_sources.json"
REPORT_PATH = Path(__file__).parent.parent / "logs" / "wildlife_sources_report.json"
SCRAPE_REPORT_PATH = Path(__file__).parent.parent / "logs" / "wildlife_scrape_report.json"

SAME_HOST_GAP_S = 1.5
MAX_WORKERS = 8


def _host(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def probe_scrape(sources: list[dict[str, Any]], workers: int = MAX_WORKERS) -> list[dict[str, Any]]:
    """Probe each candidate's homepage for a scrapable newsroom listing."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for s in sources:
        groups.setdefault(_host(s.get("homepage") or ""), []).append(s)

    out: list[dict[str, Any]] = []

    def run_group(group: list[dict[str, Any]]) -> list[dict[str, Any]]:
        res: list[dict[str, Any]] = []
        last = 0.0
        for s in group:
            gap = time.monotonic() - last
            if gap < SAME_HOST_GAP_S:
                time.sleep(SAME_HOST_GAP_S - gap)
            last = time.monotonic()
            home = s.get("homepage")
            if not home:
                continue
            try:
                v = validate_web_source(home)
            except Exception as exc:  # noqa: BLE001
                v = {"valid": False, "article_count": 0, "sample_titles": [],
                     "error": f"{type(exc).__name__}: {exc}"}
            res.append({
                "id": s.get("id"),
                "name": s.get("name"),
                "homepage": home,
                "valid": bool(v.get("valid")),
                "article_count": int(v.get("article_count") or 0),
                "sample_titles": (v.get("sample_titles") or [])[:3],
                "error": v.get("error"),
            })
        return res

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for chunk in pool.map(run_group, groups.values()):
            out.extend(chunk)
    return out


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=MAX_WORKERS)
    ap.add_argument("--apply", action="store_true",
                    help="write the scrapable ones into news_sources as 'web' sources")
    args = ap.parse_args()

    doc = json.loads(REGISTRY_PATH.read_text())
    sources = doc["sources"]
    # Probe EVERY candidate except the aliases. The skipped ones are
    # exactly the ones whose FEED failed — which is the whole point of
    # this second pass.
    aliased = {s["id"] for s in sources if s.get("alias_of")}
    candidates = [s for s in sources if s.get("id") not in aliased]
    print(f"probing {len(candidates)} candidates for a scrapable newsroom…")

    results = probe_scrape(candidates, workers=args.workers)
    ok = [r for r in results if r["valid"] and r["article_count"] > 0]
    print(f"{len(ok)} scrapable of {len(results)}")

    SCRAPE_REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    SCRAPE_REPORT_PATH.write_text(json.dumps({
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "probed": len(results),
        "scrapable": len(ok),
        "results": results,
    }, indent=2))
    print(f"report: {SCRAPE_REPORT_PATH}")

    for r in sorted(ok, key=lambda x: -(x["article_count"] or 0))[:60]:
        print(f"  {r['name'][:38]:40} n={r['article_count']:3} {r['homepage'][:56]}")

    if args.apply:
        from .db import connect

        by_id = {s.get("id"): s for s in sources}
        inserted = 0
        with connect() as conn, conn.cursor() as cur:
            for r in ok:
                s = by_id.get(r["id"]) or {}
                scope = s.get("scope") or "international"
                cur.execute(
                    """
                    INSERT INTO news_sources (
                        name, feed_url, homepage_url, country, language, region,
                        source_type, locality, topics, topic, science_focus,
                        science_subfocus, license, active, base_domain, robots_status
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, 'web', %s, %s, %s, %s, %s,
                            'open', TRUE, %s, 'allowed')
                    ON CONFLICT (feed_url) DO UPDATE SET
                        source_type = 'web',
                        name = EXCLUDED.name,
                        homepage_url = COALESCE(EXCLUDED.homepage_url, news_sources.homepage_url),
                        country = EXCLUDED.country,
                        language = EXCLUDED.language,
                        region = EXCLUDED.region,
                        locality = EXCLUDED.locality,
                        topics = EXCLUDED.topics,
                        topic = EXCLUDED.topic,
                        science_focus = COALESCE(EXCLUDED.science_focus, news_sources.science_focus),
                        science_subfocus = COALESCE(EXCLUDED.science_subfocus, news_sources.science_subfocus),
                        active = TRUE,
                        updated_at = now()
                    RETURNING id
                    """,
                    (
                        r["name"],
                        r["homepage"],
                        r["homepage"],
                        s.get("country") if scope == "national" else None,
                        s.get("language"),
                        s.get("region") or "global",
                        {"national": "national", "regional": "regional"}.get(scope, "international"),
                        s.get("topics") or ["wildlife"],
                        s.get("topic") or "wildlife",
                        s.get("focus"),
                        s.get("subfocus"),
                        _host(r["homepage"]),
                    ),
                )
                inserted += cur.rowone() is not None
        print(f"web sources written: {inserted}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
