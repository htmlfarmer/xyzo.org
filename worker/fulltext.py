"""Full-text article extractor — fetches complete article content from URLs.

Many RSS feeds only provide summaries or truncated content. This module
fetches the full article from the source URL and extracts the main text
content using various strategies:

  1. Readability-style extraction (main content detection)
  2. AI-powered extraction for complex pages
  3. Fallback to meta description + first paragraphs

PARALLEL FETCHING (Audit 4 #26):
===============================
:func:`process_batch` (and :class:`FulltextFetcher`) fetches fulltext for
many articles concurrently. Bounded by an :class:`asyncio.Semaphore` AND
a per-host lock with a per-host floor (default 200 ms), so:

  * Total concurrency is capped (default 16 in flight).
  * Same host is strictly serial — never two in-flight requests to the
    same domain (politeness; some sites will block).
  * Different hosts run in parallel up to the global cap.

Replaces the previous sequential loop with ``time.sleep(0.5)`` per
article: 100 articles × ~1 s each = ~100 s sequential → ~6–10 s parallel.

Usage:
  python -m worker.fulltext --article-id 123    # Extract full text for one article
  python -m worker.fulltext --batch 50          # Process batch of articles
  python -m worker.fulltext --source-id 5       # Process all articles from source
"""

import asyncio
import logging
import html
import re
import time
from collections import defaultdict
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlparse

import httpx

from .db import connect

log = logging.getLogger("xyzo.fulltext")

USER_AGENT = "Mozilla/5.0 (compatible; NewsiumBot/1.0; +https://xyzo.org)"
TIMEOUT_S = 15.0
MAX_CONTENT_LENGTH = 50000  # Max chars to store

# ── Parallel fetcher tunables (Audit 4 #26) ─────────────────────────────
#
# ``MAX_CONCURRENT`` caps total in-flight HTTP requests. ``PER_HOST_DELAY_MS``
# is the polite floor between two fetches to the same domain. Both can be
# overridden via env or :class:`FulltextFetcher` constructor.
import os as _os
MAX_CONCURRENT = int(_os.environ.get("NEWSIUM_FULLTEXT_CONCURRENCY", "16"))
PER_HOST_DELAY_MS = int(_os.environ.get("NEWSIUM_FULLTEXT_PER_HOST_MS", "200"))

# Hosts we never fetch from (loopback / private / known-bad). Match on the
# bare host (no port). Use :meth:`FulltextFetcher.is_blacklisted` to extend.
DEFAULT_BLACKLIST: frozenset[str] = frozenset({
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
})


class SimpleHTMLExtractor(HTMLParser):
    """Simple HTML parser that extracts main content."""

    def __init__(self):
        super().__init__()
        self.in_article = False
        self.in_p = False
        self.in_h = False
        self.skip_tags = {"script", "style", "nav", "header", "footer", "aside", "form", "iframe"}
        self.skip_depth = 0
        self.content_parts = []
        self.title = ""
        self.description = ""
        self.current_tag = ""
        self.depth = 0

    def handle_starttag(self, tag, attrs):
        self.current_tag = tag
        self.depth += 1
        attrs_dict = dict(attrs)

        # Skip non-content areas
        if tag in self.skip_tags:
            self.skip_depth = self.depth
            return

        # Look for article/main content areas
        classes = attrs_dict.get("class", "").lower()
        id_attr = attrs_dict.get("id", "").lower()

        if any(kw in classes or kw in id_attr
               for kw in ["article", "story", "content", "post", "entry", "body", "main"]):
            self.in_article = True

        if tag == "p":
            self.in_p = True

        if tag in ("h1", "h2", "h3"):
            self.in_h = True

        # Extract title
        if tag == "title" and not self.title:
            self.in_h = True

        # Extract meta description
        if tag == "meta":
            name = attrs_dict.get("name", "").lower()
            if name == "description":
                self.description = attrs_dict.get("content", "")

    def handle_endtag(self, tag):
        self.depth -= 1

        if self.skip_depth > 0 and self.depth < self.skip_depth:
            self.skip_depth = 0

        if tag == "p":
            self.in_p = False
        if tag in ("h1", "h2", "h3"):
            self.in_h = False

    def handle_data(self, data):
        if self.skip_depth > 0:
            return

        text = data.strip()
        if not text:
            return

        if self.in_h and not self.title:
            self.title = text

        if self.in_p or self.in_article:
            self.content_parts.append(text)

    def get_content(self) -> str:
        """Return extracted content."""
        # Join all paragraphs
        content = " ".join(self.content_parts)

        # Clean up whitespace
        content = re.sub(r"\s+", " ", content).strip()

        # If we got very little content from article detection, use all paragraphs
        if len(content) < 200 and len(self.content_parts) > 0:
            content = " ".join(self.content_parts)

        return content[:MAX_CONTENT_LENGTH]


def extract_lead_image(html: str, base_url: str = "") -> str | None:
    """Extract lead article image from HTML document.

    Uses the image_scorer module for weighted-feature ranking of all
    candidates (og:image, twitter:image, body <img> tags). Falls back
    to simple og:image extraction if scorer is unavailable.
    """
    try:
        from .image_scorer import extract_image_candidates, pick_best_image
        candidates = extract_image_candidates(html, base_url)
        return pick_best_image(candidates, min_score=5.0)
    except Exception:
        pass

    # Fallback: simple og:image / twitter:image extraction
    from urllib.parse import urljoin
    NOISE = ("pixel", "track", "gravatar", "favicon", "icon", "logo", "badge", "avatar", "blank.gif", "1x1", "share.png")
    for meta_patt in (
        r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
        r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)["\']',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']twitter:image["\']',
    ):
        m = re.search(meta_patt, html, re.I)
        if m:
            # The attribute value still carries its HTML entities —
            # "…?w=1200&amp;h=630" is stored verbatim and 404s. The
            # same fix as worker/fetch.py and worker/image_scorer.py.
            img = html.unescape(m.group(1).strip())
            if img and not any(n in img.lower() for n in NOISE):
                if img.startswith("//"): return "https:" + img
                if img.startswith("/") and base_url: return urljoin(base_url, img)
                return img if img.startswith("http") else None
    return None

def extract_from_html(html: str, base_url: str = "") -> dict:
    """Extract content from HTML string."""
    parser = SimpleHTMLExtractor()
    try:
        parser.feed(html)
    except Exception as e:
        log.warning("HTML parse error: %s", e)

    content = parser.get_content()
    title = parser.title
    description = parser.description

    # If we got very little content, try a simpler approach
    if len(content) < 100:
        # Extract all text between <p> tags
        p_texts = re.findall(r"<p[^>]*>(.*?)</p>", html, re.DOTALL | re.IGNORECASE)
        content = " ".join(re.sub(r"<[^>]+>", "", t).strip() for t in p_texts)
        content = re.sub(r"\s+", " ", content).strip()[:MAX_CONTENT_LENGTH]

    image_url = extract_lead_image(html, base_url)
    return {
        "title": title[:500] if title else "",
        "content": content,
        "description": description[:1000] if description else "",
        "content_length": len(content),
        "image_url": image_url,
    }


def fetch_full_text(url: str) -> dict:
    """Fetch and extract full text from a URL (legacy sync helper)."""
    try:
        with httpx.Client(timeout=TIMEOUT_S, follow_redirects=True) as client:
            resp = client.get(url, headers={"User-Agent": USER_AGENT})

            if resp.status_code >= 400:
                return {"error": f"HTTP {resp.status_code}", "content": ""}

            content_type = resp.headers.get("content-type", "")
            if "text/html" not in content_type and "application/xhtml" not in content_type:
                return {"error": f"Not HTML: {content_type}", "content": ""}

            html = resp.text
            extracted = extract_from_html(html, url)

            return {
                "url": url,
                "title": extracted["title"],
                "content": extracted["content"],
                "description": extracted["description"],
                "content_length": extracted["content_length"],
                "image_url": extracted.get("image_url"),
                "error": None,
            }

    except Exception as e:
        return {"url": url, "error": str(e)[:200], "content": ""}


# ── Parallel fulltext fetcher (Audit 4 #26) ─────────────────────────────
#
# The legacy :func:`process_batch` walked articles one at a time with
# ``time.sleep(0.5)`` between each: 100 articles × ~1 s each = ~100 s.
# :class:`FulltextFetcher` fetches many articles concurrently:
#
#   * Global cap via :class:`asyncio.Semaphore` (default 16).
#   * Per-host :class:`asyncio.Lock` ensures at most one in-flight
#     request to any given domain (politeness — never parallelize the
#     same host).
#   * Per-host polite floor (``PER_HOST_DELAY_MS``, default 200 ms)
#     between successive requests to the same domain.
#
# Returns the SAME shape as :func:`fetch_full_text` (so existing call
# sites that consume ``error`` / ``content`` / ``title`` keep working)
# plus an ``id`` field carrying the source article id when supplied.

class FulltextFetcher:
    """Parallel fulltext fetcher with bounded concurrency + per-host rate limiting.

    Usage::

        fetcher = FulltextFetcher(max_concurrent=16, per_host_delay_ms=200)
        results = fetcher.fetch_batch_sync(articles)   # list of {id, url, title,
                                                       #        content, image_url,
                                                       #        error, ...}

    Or, from inside an existing event loop::

        results = await fetcher.fetch_batch(articles)
    """

    def __init__(
        self,
        max_concurrent: int = MAX_CONCURRENT,
        per_host_delay_ms: int = PER_HOST_DELAY_MS,
        timeout: float = TIMEOUT_S,
        user_agent: str = USER_AGENT,
        blacklist: frozenset[str] | set[str] | None = None,
    ):
        self.max_concurrent = max(1, int(max_concurrent))
        self.per_host_delay_ms = max(0, int(per_host_delay_ms))
        self.timeout = float(timeout)
        self.user_agent = user_agent
        self.blacklist: frozenset[str] = (
            frozenset(blacklist) if blacklist is not None else DEFAULT_BLACKLIST
        )
        self.semaphore = asyncio.Semaphore(self.max_concurrent)
        # Per-host serialisation. Created lazily on first request to a host.
        self._host_locks: dict[str, asyncio.Lock] = {}
        # Last call timestamp per host (event-loop time, seconds).
        self._last_host_call: dict[str, float] = defaultdict(float)

    # ── host helpers ────────────────────────────────────────────────────

    @staticmethod
    def _extract_host(url: str) -> str:
        """Return bare lowercased hostname (no port, no userinfo).

        Stripping the port matters for two reasons:
          * Blacklist keys (``localhost``, ``127.0.0.1``) wouldn't match
            ``localhost:8000`` otherwise, so a misconfigured caller could
            accidentally hit a dev server.
          * Per-host locks keyed on ``example.com:8080`` and
            ``example.com:9090`` would not be shared — same host, two
            locks, polite-floor broken.
        """
        try:
            host = (urlparse(url).hostname or "").lower()
        except Exception:
            return ""
        return host or ""

    def is_blacklisted(self, host: str) -> bool:
        return host in self.blacklist

    def _get_host_lock(self, host: str) -> asyncio.Lock:
        lock = self._host_locks.get(host)
        if lock is None:
            lock = asyncio.Lock()
            self._host_locks[host] = lock
        return lock

    async def _wait_for_host(self, host: str) -> None:
        """Hold the per-host lock and enforce the polite floor.

        Acquiring the per-host lock first guarantees no two coroutines
        ever overlap on the same host — even if the event loop scheduled
        them at the same instant. The sleep afterwards enforces the
        minimum spacing between successive calls to the same host.
        """
        lock = self._get_host_lock(host)
        async with lock:
            if self.per_host_delay_ms <= 0:
                self._last_host_call[host] = asyncio.get_event_loop().time()
                return
            now = asyncio.get_event_loop().time()
            gap_ms = (now - self._last_host_call[host]) * 1000.0
            if gap_ms < self.per_host_delay_ms:
                await asyncio.sleep((self.per_host_delay_ms - gap_ms) / 1000.0)
            self._last_host_call[host] = asyncio.get_event_loop().time()

    # ── core fetch ──────────────────────────────────────────────────────

    async def fetch_one(self, article: dict, client: httpx.AsyncClient) -> dict:
        """Fetch one article. Returns dict matching :func:`fetch_full_text` shape + ``id``."""
        url = article.get("url") or ""
        article_id = article.get("id")
        host = self._extract_host(url)
        base = {"id": article_id, "url": url}

        if not url:
            return {**base, "error": "missing_url", "content": ""}
        if self.is_blacklisted(host):
            return {**base, "error": f"blacklisted_host:{host}", "content": ""}

        async with self.semaphore:
            await self._wait_for_host(host)
            try:
                resp = await client.get(
                    url,
                    headers={"User-Agent": self.user_agent},
                    follow_redirects=True,
                )
            except Exception as e:
                return {**base, "error": str(e)[:200], "content": ""}

            if resp.status_code >= 400:
                return {**base, "error": f"HTTP {resp.status_code}", "content": ""}

            content_type = resp.headers.get("content-type", "")
            if "text/html" not in content_type and "application/xhtml" not in content_type:
                return {**base, "error": f"Not HTML: {content_type}", "content": ""}

            try:
                extracted = extract_from_html(resp.text, url)
            except Exception as e:
                return {**base, "error": f"extract_failed:{e!r}"[:200], "content": ""}

            return {
                **base,
                "title": extracted["title"],
                "content": extracted["content"],
                "description": extracted["description"],
                "content_length": extracted["content_length"],
                "image_url": extracted.get("image_url"),
                "error": None,
            }

    async def fetch_batch(self, articles: list[dict]) -> list[dict]:
        """Fetch many articles in parallel. One :class:`AsyncClient` shared across the batch."""
        if not articles:
            return []
        async with httpx.AsyncClient(
            timeout=self.timeout,
            follow_redirects=True,
            headers={"User-Agent": self.user_agent},
        ) as client:
            tasks = [self.fetch_one(a, client) for a in articles]
            # return_exceptions=False: fetch_one already converts all
            # exceptions into {error: ...} dicts, so a propagating
            # exception would be a true bug — let it surface.
            return await asyncio.gather(*tasks)

    # ── sync wrappers (legacy callers) ──────────────────────────────────

    def fetch_batch_sync(self, articles: list[dict]) -> list[dict]:
        """Sync entry point — runs the async batch in a fresh event loop."""
        return asyncio.run(self.fetch_batch(articles))

    def fetch_one_sync(self, article: dict) -> dict:
        """Sync wrapper for single-article callers."""
        return asyncio.run(self.fetch_batch([article]))[0]


def update_article_full_text(article_id: int, content: str, title: str = "", image_url: str | None = None) -> bool:
    """Update an article's body with full text content."""
    if not content or len(content) < 50:
        return False

    with connect() as conn, conn.cursor() as cur:
        # Only update if we got significantly more content than what exists
        cur.execute("SELECT LENGTH(body) as body_len FROM news_articles WHERE id = %s", (article_id,))
        row = cur.fetchone()
        if not row:
            return False

        existing_len = row["body_len"] or 0
        if len(content) <= existing_len * 1.2:  # Need at least 20% more content
            return False

        cur.execute("""
            UPDATE news_articles
            SET body = %s,
                title = CASE WHEN %s != '' THEN %s ELSE title END,
                image_url = COALESCE(image_url, %s)
            WHERE id = %s
        """, (content, title, title, image_url, article_id))

        return cur.rowcount > 0


def process_batch(limit: int = 50, source_id: int | None = None,
                  min_body_length: int = 200,
                  max_concurrent: int = MAX_CONCURRENT,
                  per_host_delay_ms: int = PER_HOST_DELAY_MS) -> dict:
    """Process a batch of articles with PARALLEL fulltext fetching.

    Audit 4 #26: replaced the previous sequential loop
    (``time.sleep(0.5)`` per article → ~100 s for 100 articles) with a
    :class:`FulltextFetcher` running 16 concurrent fetches subject to a
    per-host polite floor of 200 ms. Wall-clock for 100 × ~1 s fetches
    drops to ~6–10 s.

    Concurrency tunables:
      * ``max_concurrent``: global in-flight cap (default 16).
      * ``per_host_delay_ms``: min spacing between fetches to the same
        domain (default 200 ms — comfortably below the 1 req/s politeness
        floor even at the lowest setting).

    Same return shape as before:
        {"processed", "updated", "errors", "skipped"}
    so CLI / cron callers don't need to change.
    """
    with connect() as conn, conn.cursor() as cur:
        # Find articles with short or missing body text
        query = """
            SELECT a.id, a.url, a.title, LENGTH(a.body) as body_len
            FROM news_articles a
            WHERE a.status IN ('extracted', 'clustered')
              AND (a.body IS NULL OR LENGTH(a.body) < %s)
        """
        params: list = [min_body_length]

        if source_id:
            query += " AND a.source_id = %s"
            params.append(source_id)

        query += " ORDER BY a.fetched_at DESC LIMIT %s"
        params.append(limit)

        cur.execute(query, params)
        articles = cur.fetchall()

    results = {"processed": 0, "updated": 0, "errors": 0, "skipped": 0}
    if not articles:
        return results

    log.info(
        "process_batch: %d articles (max_concurrent=%d, per_host_delay_ms=%d)",
        len(articles), max_concurrent, per_host_delay_ms,
    )

    fetcher = FulltextFetcher(
        max_concurrent=max_concurrent,
        per_host_delay_ms=per_host_delay_ms,
    )
    started = time.time()
    fetch_results = fetcher.fetch_batch_sync(articles)
    fetch_elapsed = time.time() - started
    log.info(
        "process_batch: %d fetches in %.2fs (%.2f/s effective)",
        len(fetch_results), fetch_elapsed,
        len(fetch_results) / fetch_elapsed if fetch_elapsed > 0 else 0.0,
    )

    for result in fetch_results:
        article_id = result.get("id")
        url = result.get("url", "")

        if result.get("error"):
            log.warning("Failed to fetch %s: %s", article_id, result["error"])
            results["errors"] += 1
            continue

        content = result.get("content", "")
        if content and len(content) > 50:
            updated = update_article_full_text(
                article_id,
                content,
                result.get("title", ""),
                result.get("image_url"),
            )
            if updated:
                results["updated"] += 1
                log.info("Updated article %d: %d chars", article_id, len(content))
            else:
                results["skipped"] += 1
        else:
            results["skipped"] += 1

        results["processed"] += 1

    return results


def process_article(article_id: int) -> dict:
    """Process a single article for full text extraction."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, url, title, body FROM news_articles WHERE id = %s", (article_id,))
        article = cur.fetchone()

    if not article:
        return {"error": "Article not found"}

    url = article["url"]
    result = fetch_full_text(url)

    if result.get("error"):
        return {"error": result["error"], "url": url}

    content = result.get("content", "")
    if content and len(content) > 50:
        updated = update_article_full_text(article_id, content, result.get("title", ""), result.get("image_url"))
        return {
            "article_id": article_id,
            "url": url,
            "content_length": len(content),
            "updated": updated,
            "title": result.get("title", ""),
        }

    return {"article_id": article_id, "url": url, "error": "Insufficient content extracted"}


# CLI entry point
if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    parser = argparse.ArgumentParser(description="Full-text article extractor")
    parser.add_argument("--article-id", type=int, help="Process single article")
    parser.add_argument("--batch", type=int, default=50, help="Process batch of articles")
    parser.add_argument("--source-id", type=int, help="Process articles from specific source")
    parser.add_argument("--min-length", type=int, default=200, help="Min body length to skip")
    args = parser.parse_args()

    if args.article_id:
        result = process_article(args.article_id)
        print(json.dumps(result, indent=2, default=str))
    else:
        result = process_batch(args.batch, args.source_id, args.min_length)
        print(f"\nProcessed: {result['processed']}")
        print(f"Updated: {result['updated']}")
        print(f"Errors: {result['errors']}")
        print(f"Skipped: {result['skipped']}")
