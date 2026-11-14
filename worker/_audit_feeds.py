#!/usr/bin/env python3
"""Refined one-shot audit of worker/feeds.json — same as _audit_feeds.py but with
better truncation detection.

Truncation is detected by inspecting the END of the body text (last 300 chars)
for indicators like:
  - trailing "..." / "…" that isn't a sentence terminator
  - trailing "[…]" or "[...]"
  - trailing "Read more", "Continue reading", "Subscribe", etc.
  - trailing "Click here", "Getty Images"

This avoids false positives from newsletters that put "Subscribe to our
newsletter" mid-article.
"""
import asyncio
import json
import logging
import re
import statistics
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import feedparser
import httpx

sys.path.insert(0, str(Path(__file__).parent.parent.absolute()))

from worker.fetch import _entry_body, _strip_html, USER_AGENT, REQUEST_TIMEOUT
from worker.robots import RobotsCache

FEEDS_FILE = Path(__file__).parent / "feeds.json"
OUTPUT = Path(__file__).parent.parent / "logs" / "feed_audit.json"
OUTPUT.parent.mkdir(parents=True, exist_ok=True)

# Trailing-truncation markers (only match in the last 300 chars of body)
# Note: these are intentionally narrow to avoid matching mid-sentence
# "Read more..." / "..." / etc. that appear in normal article prose.
TAIL_RE = re.compile(
    r"(?:"
    r"\[\s*\.{2,3}\s*\]"                 # [...]  or  [...]
    r"|\[…\]"                            # [...]
    r"|\.{3}\s*$"                        # "..." at very end of body
    r"|…\s*$"                            # "…" at very end
    r"|\bRead\s+(?:the\s+)?full(?:\s+story)?\b"  # "Read the full story"
    r"|\bRead\s+more(?:\s+of\s+this\s+story)?(?:\s*[:\-]?\s*https?://\S+)?"  # "Read more" or "Read more: https://..."
    r"|\bRead\s+more\b"
    r"|\bcontinue\s+reading\b"
    r"|\bsubscribe\s+to\b"               # "Subscribe to ..."
    r"|\bsign\s+up\s+here\b"             # newsletter footer
    r"|\bclick\s+here\s+for\b"
    r"|\bgetty\s+images\b"
    r"|\bsubmit\s+a\s+(?:tip|story)\b"
    r"|\bfollow\s+us\s+on\b"
    r"|\bimage:\s*https?://"
    r"|\bleer\s+m[aá]s\b"               # Spanish: "read more"
    r"|\bsigue\s+leyendo\b"              # Spanish: "keep reading"
    r"|\blire\s+la\s+suite\b"            # French: "read more"
    r"|\bweiterlesen\b"                  # German: "read more"
    r"|\bcontinuar\s+leyendo\b"          # Spanish: "continue reading"
    r"|\bRead\s+full\s+story\s+here\b"
    r")",
    re.I | re.S,
)

# Mid-body markers that strongly suggest "first paragraph only" truncation
# when the body is otherwise short.
SHORT_BODY_TAIL_RE = re.compile(
    r"(?:"
    r"^\.{3}$"                      # body is literally "..."
    r"|full\s+story\s+(?:at|on)\b"  # "Full story at ..."
    r"|\bview\s+full\b"
    r")",
    re.I | re.S,
)


def body_stats(body: str) -> dict:
    s = (body or "").strip()
    if not s:
        return {
            "chars": 0, "words": 0, "sentences": 0,
            "truncated": True, "truncation_markers": ["empty"],
            "tail_snippet": "",
        }
    chars = len(s)
    words = len(s.split())
    sentences = len(re.findall(r"[.!?]+(?:\s|$)", s))
    tail = s[-300:]
    truncated = bool(TAIL_RE.search(tail))
    return {
        "chars": chars,
        "words": words,
        "sentences": sentences,
        "truncated": truncated,
        "truncation_markers": ["tail"] if truncated else [],
        "tail_snippet": tail[-150:],
    }


def classify(article_stats: list[dict]) -> str:
    if not article_stats:
        return "EMPTY"
    chars = [a["chars"] for a in article_stats]
    words = [a["words"] for a in article_stats]
    truncated_frac = sum(1 for a in article_stats if a["truncated"]) / len(article_stats)
    med_chars = statistics.median(chars)
    med_words = statistics.median(words)

    # Full-text: generous body (most feeds include some footer boilerplate)
    if med_chars >= 1500 and med_words >= 200:
        return "FULL"
    # Long body with mild truncation at the tail is still FULL — many sites
    # append "Read more" / "Subscribe" to long articles.
    if med_chars >= 3000 and med_words >= 400 and truncated_frac <= 0.8:
        return "FULL"
    # Brief but plausibly complete: short-form news wires are real news.
    if med_chars >= 400 and med_words >= 50 and truncated_frac <= 0.3:
        return "BRIEF"
    if med_chars >= 200 and med_words >= 30 and truncated_frac <= 0.5:
        return "BRIEF"
    return "PARTIAL"


async def warm_robots(hosts: list[str]) -> RobotsCache:
    cache = RobotsCache()
    sem = asyncio.Semaphore(8)

    async def warm(h):
        async with sem:
            loop = asyncio.get_running_loop()
            try:
                await loop.run_in_executor(None, cache.is_allowed, f"https://{h}/")
            except Exception:
                pass

    await asyncio.gather(*[warm(h) for h in hosts])
    return cache


async def audit_feed(client: httpx.AsyncClient, robots: RobotsCache, feed: dict) -> dict:
    name = feed["name"]
    url = feed["feed_url"]
    stype = feed.get("source_type", "rss")
    host = urlparse(url).netloc.lower()

    loop = asyncio.get_running_loop()
    try:
        allowed, delay, blocked_path = await loop.run_in_executor(None, robots.is_allowed, url)
    except Exception:
        allowed, delay, blocked_path = True, None, None

    result = {
        "name": name,
        "url": url,
        "host": host,
        "country": feed.get("country"),
        "region": feed.get("region"),
        "enabled": feed.get("enabled", True),
        "source_type": stype,
        "robots_allowed": bool(allowed),
        "robots_blocked_path": blocked_path,
        "robots_crawl_delay": delay,
        "http_status": None,
        "error": None,
        "fetch_ms": 0,
        "articles_parsed": 0,
        "articles": [],
        "classification": "UNKNOWN",
    }

    if not allowed:
        result["classification"] = "BLOCKED"
        return result

    t0 = time.perf_counter()
    try:
        resp = await client.get(url, timeout=REQUEST_TIMEOUT, follow_redirects=True)
    except httpx.HTTPError as exc:
        result["fetch_ms"] = int((time.perf_counter() - t0) * 1000)
        result["error"] = f"{type(exc).__name__}: {exc}"
        result["classification"] = "BROKEN"
        return result

    result["fetch_ms"] = int((time.perf_counter() - t0) * 1000)
    result["http_status"] = resp.status_code
    if resp.status_code != 200:
        result["error"] = f"HTTP {resp.status_code}"
        result["classification"] = "BROKEN"
        return result

    try:
        if stype in ("json", "geojson"):
            from worker.fetch import parse_feed
            articles = parse_feed(resp.content, stype)
            # Coerce into common shape
            normalized = [
                {"url": a.get("url"), "title": a.get("title", ""), "body": a.get("body", "")}
                for a in articles
            ]
        else:
            parsed = feedparser.parse(resp.content)
            normalized = []
            for e in parsed.entries:
                link = (e.get("link") or e.get("id") or "").strip()
                if not link:
                    continue
                title = (e.get("title") or "").strip()[:500]
                body = _strip_html(_entry_body(e))[:16000]
                normalized.append({"url": link, "title": title, "body": body})
    except Exception as exc:
        result["error"] = f"Parser error: {type(exc).__name__}: {exc}"
        result["classification"] = "BROKEN"
        return result

    result["articles_parsed"] = len(normalized)
    stats = []
    for a in normalized[:10]:
        s = body_stats(a.get("body", ""))
        stats.append(s)
        result["articles"].append({
            "url": a.get("url"),
            "title": a.get("title", "")[:120],
            **s,
        })

    result["classification"] = classify(stats)
    return result


async def main() -> None:
    print("=" * 100)
    print("Newsium feed audit v2 — tail-aware truncation detection")
    print("=" * 100)
    with FEEDS_FILE.open() as f:
        data = json.load(f)
    feeds = [fd for fd in data["feeds"] if fd.get("enabled", True)]
    print(f"Loaded {len(feeds)} enabled feeds.")

    hosts = sorted({urlparse(f["feed_url"]).netloc.lower() for f in feeds})
    print(f"Warming robots.txt for {len(hosts)} hosts...")
    t = time.perf_counter()
    robots = await warm_robots(hosts)
    print(f"  done in {time.perf_counter() - t:.1f}s\n")

    headers = {"User-Agent": USER_AGENT}
    limits = httpx.Limits(max_keepalive_connections=8, max_connections=16)
    async with httpx.AsyncClient(headers=headers, limits=limits, follow_redirects=True) as client:
        results = await asyncio.gather(*[audit_feed(client, robots, f) for f in feeds])

    with OUTPUT.open("w") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"Detailed results saved to {OUTPUT}\n")

    counts = {"FULL": 0, "BRIEF": 0, "PARTIAL": 0, "EMPTY": 0, "BROKEN": 0, "BLOCKED": 0, "UNKNOWN": 0}
    for r in results:
        counts[r["classification"]] = counts.get(r["classification"], 0) + 1

    print(f"{'Source':<28} | {'Class':<8} | {'Robots':<6} | {'HTTP':<4} | {'N':<4} | {'MedChars':<9} | {'MedWords':<9} | Notes")
    print("-" * 130)
    prio = {"BLOCKED": 0, "BROKEN": 1, "PARTIAL": 2, "EMPTY": 3, "UNKNOWN": 4, "BRIEF": 5, "FULL": 6}
    results.sort(key=lambda r: (prio.get(r["classification"], 9), r["name"]))

    for r in results:
        arts = r["articles"]
        if arts:
            chars = statistics.median(a["chars"] for a in arts)
            words = statistics.median(a["words"] for a in arts)
            c_s = f"{chars:.0f}"
            w_s = f"{words:.0f}"
        else:
            c_s = "-"
            w_s = "-"
        robots_s = "ALLOW" if r["robots_allowed"] else "BLOCK"
        http_s = str(r.get("http_status") or "-")
        notes = r.get("error") or ""
        if r["classification"] == "BLOCKED":
            notes = f"robots disallow {r.get('robots_blocked_path') or '/'}"
        print(f"{r['name'][:27]:<28} | {r['classification']:<8} | {robots_s:<6} | {http_s:<4} | {r['articles_parsed']:<4} | {c_s:<9} | {w_s:<9} | {notes[:50]}")

    print("-" * 130)
    print("Summary: " + " | ".join(f"{counts[k]} {k}" for k in ("FULL", "BRIEF", "PARTIAL", "EMPTY", "BLOCKED", "BROKEN") if counts.get(k)))


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    asyncio.run(main())
