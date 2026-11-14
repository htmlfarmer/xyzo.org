"""Image backfill worker — finds images for articles missing them.

Fetches the article's original URL, runs the image_scorer (algorithm)
on the HTML to find the best image candidate, and optionally asks the
AI to confirm or improve the selection.

This bridges the gap between RSS feeds that don't include images and
the 85% of articles that currently have image_url = NULL.

Usage:
    python -m worker.backfill_images              # default: 100 articles
    python -m worker.backfill_images --limit 200  # more articles
    python -m worker.backfill_images --ai         # also ask AI to pick

Run via timer (e.g. every 15 min alongside the fetcher).
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import time
from typing import Any

import httpx

from .db import connect
from .image_scorer import extract_image_candidates, pick_best_image
from .progress import ProgressWriter
from .robots import RobotsCache

log = logging.getLogger("xyzo.backfill_images")

USER_AGENT = "xyzo-scraper/0.1 (https://xyzo.org; contact@xyzo.org)"
REQUEST_TIMEOUT = 15.0
DEFAULT_LIMIT = 100
IMAGE_RETENTION_DAYS = int(os.environ.get("XYMO_IMAGE_RETENTION_DAYS", "7"))

_robots = RobotsCache(ua=USER_AGENT)

CHAT_URL = os.environ.get(
    "XYZO_AI_CHAT_URL",
    "http://192.168.1.3:8888/chat/stream",
)
AI_TIMEOUT_S = float(os.environ.get("XYZO_AI_TIMEOUT", "25"))
SAFE_HEADERS = {"X-MCP-Safe": "true"}

AI_IMAGE_PROMPT = """You are an image selector for a news map. Given an article's title, body, and a list of candidate image URLs, pick the ONE best image URL that represents the main event.

Rules:
- Prefer images of people, places, or events mentioned in the title.
- Avoid logos, icons, social media badges, thumbnails, or decorative images.
- If a URL contains words like "logo", "icon", "avatar", "badge", "pixel", "banner-ad", skip it.
- If none of the candidates are suitable, return null.
- Return ONLY the exact URL string, or the word "null".

Title: {title}

Body (first 500 chars):
{body}

Candidate image URLs:
{candidates}

Best image URL (or "null"):"""


def _fetch_pending(limit: int) -> list[dict]:
    """Get recent articles without images."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT a.id, a.title, a.body, a.url, s.homepage_url
               FROM news_articles a
               LEFT JOIN news_sources s ON s.id = a.source_id
               WHERE a.image_url IS NULL
                 AND a.status = 'extracted'
                 AND a.fetched_at > now() - INTERVAL '%s days'
               ORDER BY a.fetched_at DESC
               LIMIT %s""",
            (IMAGE_RETENTION_DAYS, limit),
        )
        rows = cur.fetchall()
        return [
            {"id": r["id"], "title": r["title"], "body": r["body"],
             "url": r["url"], "homepage_url": r.get("homepage_url")}
            for r in rows
        ]


def _fetch_html(client: httpx.Client, url: str) -> str | None:
    """Fetch article HTML, respecting robots.txt."""
    verdict = _robots.is_allowed(url)
    if not verdict.allowed:
        return None
    delay = verdict.crawl_delay_s
    if delay and delay > 0:
        time.sleep(min(delay, 3.0))
    try:
        resp = client.get(url, timeout=REQUEST_TIMEOUT, follow_redirects=True)
        if resp.status_code >= 400:
            return None
        ct = resp.headers.get("content-type", "")
        if "html" not in ct and "xhtml" not in ct:
            return None
        return resp.text
    except Exception:
        return None


def _ai_pick_image(client: httpx.Client, title: str, body: str, candidates: list[str]) -> str | None:
    """Ask the AI to pick the best image from candidates."""
    if not candidates:
        return None
    prompt = AI_IMAGE_PROMPT.format(
        title=title,
        body=body[:500],
        candidates="\n".join(f"  {i+1}. {u}" for i, u in enumerate(candidates[:10])),
    )
    try:
        payload = {"message": prompt, "stream": True}
        full = ""
        with client.stream("POST", CHAT_URL, json=payload, headers=SAFE_HEADERS, timeout=AI_TIMEOUT_S) as resp:
            resp.raise_for_status()
            for chunk in resp.iter_text():
                if not chunk:
                    continue
                full += chunk
                for line in full.split("\n"):
                    line = line.strip()
                    if line.startswith("data:"):
                        data_str = line[5:].strip()
                        if data_str == "[DONE]":
                            break
                        try:
                            obj = __import__("json").loads(data_str)
                            delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                            if delta:
                                full = full  # keep accumulating
                        except Exception:
                            pass

        # Extract URL from response
        text = full.strip()
        # Look for http(s) URL in the response
        url_match = re.search(r'https?://[^\s"\'<>]+', text)
        if url_match:
            url = url_match.group(0).rstrip(".,;:)")
            if url in candidates:
                return url
        return None
    except Exception as e:
        log.debug("AI image pick failed: %s", e)
        return None


def _update_image(article_id: int, image_url: str) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE news_articles SET image_url = %s WHERE id = %s",
            (image_url, article_id),
        )


def run(limit: int = DEFAULT_LIMIT, use_ai: bool = False, progress: ProgressWriter | None = None) -> dict:
    """Main entry point. Returns summary dict."""
    articles = _fetch_pending(limit)
    log.info("backfill_images: %d articles without images (cap %d, ai=%s)",
             len(articles), limit, use_ai)

    if progress:
        progress.update(step="backfill_images", detail=f"Finding images for {len(articles)} articles...")

    summary = {
        "total": len(articles),
        "found": 0,
        "ai_upgraded": 0,
        "fetch_failed": 0,
        "no_image_found": 0,
        "robots_blocked": 0,
    }

    with httpx.Client(headers={"User-Agent": USER_AGENT}) as client:
        for idx, art in enumerate(articles, start=1):
            url = art["url"]
            if not url:
                summary["fetch_failed"] += 1
                continue

            # 1. Fetch the article page
            html = _fetch_html(client, url)
            if html is None:
                summary["fetch_failed"] += 1
                continue

            # 2. Run the image scorer (algorithm)
            candidates = extract_image_candidates(html, url)
            algo_best = pick_best_image(candidates, min_score=5.0)

            if not algo_best and not candidates:
                summary["no_image_found"] += 1
                continue

            # 3. Optionally ask AI to pick from top candidates
            final_url = algo_best
            if use_ai and candidates:
                top_urls = [c.url for c in candidates[:10]]
                ai_pick = _ai_pick_image(client, art["title"], art.get("body", ""), top_urls)
                if ai_pick and ai_pick != algo_best:
                    final_url = ai_pick
                    summary["ai_upgraded"] += 1

            if final_url:
                _update_image(art["id"], final_url)
                summary["found"] += 1
            else:
                summary["no_image_found"] += 1

            if progress and idx % 10 == 0:
                progress.update(
                    step="backfill_images",
                    detail=f"Processed {idx}/{len(articles)} articles",
                    counters={"found": summary["found"]},
                )

            # Polite delay between fetches
            time.sleep(0.5)

    log.info(
        "backfill_images done: %d/%d found images | ai_upgraded=%d | fetch_failed=%d | no_image=%d",
        summary["found"], summary["total"], summary["ai_upgraded"],
        summary["fetch_failed"], summary["no_image_found"],
    )
    return summary


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Backfill article images")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--ai", action="store_true", help="Also ask AI to pick best image")
    args = parser.parse_args()
    print(run(limit=args.limit, use_ai=args.ai))
