#!/usr/bin/env python3
"""Compare RSS body text against the actual article webpage for borderline feeds.

For each feed, we:
  1. Pull the RSS item's <title>, <link>, and <description> body
  2. Fetch the article URL and extract its body text via BeautifulSoup
  3. Send both to the local Gemma-4 chat endpoint and ask whether the RSS body
     contains essentially all of the article's main content or only a subset
  4. Save verdicts to logs/ai_compare.json

Usage:
    python3 worker/_compare_rss_vs_web.py
"""
import asyncio
import json
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import feedparser
import httpx
import re

try:
    from bs4 import BeautifulSoup
except ImportError:
    print("bs4 not installed; run: pip install beautifulsoup4", file=sys.stderr)
    sys.exit(2)

# Local AI server (Gemma-4 / any chat completions endpoint with stream=true)
AI_URL = "http://192.168.1.3:8888/chat/stream"
SAFE_HEADERS = {"X-MCP-Safe": "true"}
USER_AGENT_RSS = "xyzo-fetcher/0.1"
USER_AGENT_WEB = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
TIMEOUT_AI = 60.0
TIMEOUT_HTTP = 30.0

FEEDS_FILE = Path(__file__).parent / "feeds.json"
OUTPUT = Path(__file__).parent.parent / "logs" / "ai_compare.json"
OUTPUT.parent.mkdir(parents=True, exist_ok=True)


def get_rss_body(entry) -> str:
    parts = []
    for k in ("summary", "description", "content"):
        v = entry.get(k)
        if isinstance(v, str):
            parts.append(v)
        elif isinstance(v, list):
            for it in v:
                if isinstance(it, dict) and it.get("value"):
                    parts.append(it["value"])
    return re.sub(r"<[^>]+>", " ", "\n\n".join(parts)).strip()


def extract_webpage_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    # Drop chrome
    for tag in soup([
        "script", "style", "nav", "aside", "footer", "iframe",
        "form", "header", "noscript",
    ]):
        tag.decompose()

    # Prefer <article> or main container if present
    article = (
        soup.find("article")
        or soup.find(attrs={"role": "main"})
        or soup.find("main")
        or soup.body
        or soup
    )

    text = article.get_text("\n", strip=True) if article else ""
    # Collapse runs of blank lines
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def collapse_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


async def query_ai(client: httpx.AsyncClient, rss_body: str, web_text: str,
                   title: str = "", max_tokens: int = 200) -> str:
    """Ask Gemma-4 to compare RSS body vs webpage body."""
    # Truncate to fit a single prompt
    rss_short = collapse_ws(rss_body)[:2500]
    web_short = collapse_ws(web_text)[:4000]
    prompt = (
        f"You are a precise text comparison judge.\n\n"
        f"ARTICLE TITLE: {title}\n\n"
        f"=== RSS FEED BODY (what the publisher's RSS feed exposes) ===\n"
        f"{rss_short}\n\n"
        f"=== WEBSITE BODY (what the actual article page on the web contains) ===\n"
        f"{web_short}\n\n"
        f"QUESTION: Does the RSS body contain the article's main content, "
        f"or only a partial summary?\n\n"
        f"Answer with EXACTLY ONE label, then a one-sentence justification:\n"
        f"  FULL     — RSS body is the article (or a near-complete equivalent). "
        f"Reader sees essentially the same content.\n"
        f"  PARTIAL  — RSS body is a partial subset — e.g., the lead paragraph "
        f"plus a few sentences. Reader is missing multiple key points.\n"
        f"  TRUNCATED — RSS body has been cut off mid-sentence or with a "
        f"'Read more' marker; full article is longer.\n"
        f"  SUMMARY  — RSS body is a marketing/teaser blurb (e.g., 'A look at "
        f"what happened this week') with no real article content.\n\n"
        f"Format your reply as:\nLabel: <one of FULL / PARTIAL / TRUNCATED / SUMMARY>\n"
        f"Reason: <one short sentence>"
    )
    body = {"message": prompt, "stream": False}
    try:
        resp = await client.post(AI_URL, json=body, headers=SAFE_HEADERS, timeout=TIMEOUT_AI)
        if resp.status_code != 200:
            return f"AI_ERROR: HTTP {resp.status_code}"
        # AI returns SSE-like stream content even with stream=false.
        # Concatenate the .content delta pieces.
        text = ""
        for line in resp.text.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            chunk = line[len("data:"):].strip()
            if not chunk or chunk == "[DONE]":
                continue
            try:
                obj = json.loads(chunk)
                delta = obj.get("choices", [{}])[0].get("delta", {})
                text += delta.get("content", "")
            except json.JSONDecodeError:
                text += chunk
        return text.strip()
    except Exception as exc:
        return f"AI_ERROR: {type(exc).__name__}: {exc}"


def parse_ai_label(reply: str) -> tuple[str, str]:
    """Pull 'Label:' and 'Reason:' from the AI's reply."""
    label = "UNKNOWN"
    reason = reply
    for line in reply.splitlines():
        s = line.strip()
        if s.lower().startswith("label:"):
            v = s.split(":", 1)[1].strip().upper()
            for allowed in ("FULL", "PARTIAL", "TRUNCATED", "SUMMARY"):
                if allowed in v:
                    label = allowed
                    break
        elif s.lower().startswith("reason:"):
            reason = s.split(":", 1)[1].strip()
    return label, reason


async def main() -> None:
    with FEEDS_FILE.open() as f:
        feeds_data = json.load(f)
    feeds = [fd for fd in feeds_data["feeds"]]
    print(f"Loaded {len(feeds)} feeds (all, including disabled).")
    if len(sys.argv) > 1:
        # Allow limiting to specific feed names
        wanted = set(sys.argv[1:])
        feeds = [f for f in feeds if f["name"] in wanted]
        print(f"Filtered to {len(feeds)} feeds: {', '.join(f['name'] for f in feeds)}")

    # Step 1: collect one RSS article per feed
    samples = []
    with httpx.Client(headers={"User-Agent": USER_AGENT_RSS}, timeout=TIMEOUT_HTTP, follow_redirects=True) as c:
        for feed in feeds:
            try:
                r = c.get(feed["feed_url"])
                if r.status_code != 200:
                    print(f"  [skip] {feed['name']}: HTTP {r.status_code}")
                    continue
                p = feedparser.parse(r.content)
                for e in p.entries:
                    link = (e.get("link") or e.get("id") or "").strip()
                    if not link or "video" in link or "live" in link:
                        continue
                    samples.append({
                        "feed": feed["name"],
                        "title": e.get("title", ""),
                        "url": link,
                        "rss_body": get_rss_body(e),
                    })
                    break
            except Exception as exc:
                print(f"  [skip] {feed['name']}: {exc}")
    print(f"Collected {len(samples)} RSS samples.")

    # Step 2: fetch webpages in parallel
    async with httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT_WEB},
        timeout=TIMEOUT_HTTP,
        follow_redirects=True,
        limits=httpx.Limits(max_connections=8),
    ) as client:

        async def fetch_web(s):
            try:
                r = await client.get(s["url"])
                if r.status_code != 200:
                    return {**s, "webpage_text": "", "web_status": r.status_code}
                text = extract_webpage_text(r.text)
                return {**s, "webpage_text": text, "web_status": 200}
            except Exception as exc:
                return {**s, "webpage_text": "", "web_status": f"ERR:{exc}"}

        enriched = await asyncio.gather(*[fetch_web(s) for s in samples])

    # Step 3: ask AI to compare (sequentially to avoid overloading the model server)
    async with httpx.AsyncClient(timeout=TIMEOUT_AI) as ai_client:
        out = []
        for s in enriched:
            print(f"\n--- {s['feed']} | {s['title'][:60]} ---")
            print(f"  RSS chars:   {len(s['rss_body'])}")
            print(f"  Web chars:   {len(s['webpage_text'])}")
            if not s["webpage_text"]:
                print(f"  Web fetch failed: {s.get('web_status')}")
                out.append({**s, "ai_label": "NO_WEB", "ai_reason": "fetch failed"})
                continue
            reply = await query_ai(ai_client, s["rss_body"], s["webpage_text"], title=s["title"])
            label, reason = parse_ai_label(reply)
            print(f"  AI verdict:  {label}")
            print(f"  AI reason:   {reason[:200]}")
            out.append({**s, "ai_label": label, "ai_reason": reason, "ai_reply_raw": reply})

    with OUTPUT.open("w") as f:
        json.dump([
            {
                "feed": x["feed"],
                "title": x["title"],
                "url": x["url"],
                "rss_chars": len(x["rss_body"]),
                "web_chars": len(x["webpage_text"]),
                "ai_label": x.get("ai_label"),
                "ai_reason": x.get("ai_reason"),
            }
            for x in out
        ], f, indent=2)
    print(f"\nSaved {len(out)} verdicts to {OUTPUT}")

    # Print compact summary
    print("\n=== AI verdicts ===")
    from collections import Counter
    by_label = Counter(x.get("ai_label") for x in out)
    print(f"Counts: {dict(by_label)}")
    for x in out:
        print(f"  {x['feed']:<28} {x.get('ai_label'):<10} rss={len(x['rss_body']):>5}c  web={len(x['webpage_text']):>6}c  {x.get('ai_reason','')[:80]}")


if __name__ == "__main__":
    asyncio.run(main())
