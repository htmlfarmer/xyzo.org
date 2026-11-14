"""Web scraper for non-RSS news sources.

Fetches a news website's HTML, extracts article links, then fetches
each article page to pull title + body text. Respects robots.txt.

Used for sources that don't have RSS feeds but publish articles on
a regular HTML page (e.g. many local/regional news sites).

Usage:
    from worker.web_scraper import scrape_source
    articles = scrape_source("https://example.com/news")
    # → [{url, title, body, published_at}]
"""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import httpx
from .robots import RobotsCache
# Same 8 MB hard cap fetch.py enforces on RSS/JSON streams — HTML pages are
# fetched by the SAME background fleet under the SAME 1G MemoryMax unit, so
# an oversized <html> body must be truncated too, not read whole.
from .fetch import MAX_FEED_BYTES

log = logging.getLogger("xyzo.web_scraper")

USER_AGENT = "xyzo-scraper/0.1 (https://xyzo.org; contact@xyzo.org)"
REQUEST_TIMEOUT = 20.0
MAX_ARTICLES_PER_PAGE = 30
MAX_BODY_LENGTH = 16000


def _bounded_get(client: httpx.Client, url: str, **kw) -> tuple[int, bytes | None]:
    """Streaming GET with a hard MAX_FEED_BYTES cap.

    Returns (status_code, body_or_None). Oversized bodies are truncated at
    the cap (HTML parsers cope fine — we only extract links/text). Errors
    (>=400) return (status, None) without buffering the body.
    """
    with client.stream("GET", url, **kw) as resp:
        if resp.status_code >= 400:
            return resp.status_code, None
        chunks: list[bytes] = []
        total = 0
        for chunk in resp.iter_bytes(65536):
            total += len(chunk)
            if total > MAX_FEED_BYTES:
                log.warning("page %s exceeded %d bytes — using truncated body",
                            url, MAX_FEED_BYTES)
                break
            chunks.append(chunk)
        return resp.status_code, b"".join(chunks)

# Shared robots cache — respects Crawl-delay, caches for 24h
_robots = RobotsCache(ua="xyzo-scraper/0.1")


def _is_article_url(url: str) -> bool:
    """Heuristic: does this URL look like an article (not a category/tag page)?"""
    path = urlparse(url).path.lower()
    # Skip obvious non-article paths
    skip_patterns = [
        "/category/", "/tag/", "/author/", "/page/", "/search",
        "/login", "/register", "/about", "/contact", "/privacy",
        "/terms", "/advert", "/subscribe", "/newsletter",
        "/video/", "/gallery/", "/podcast/",
        "/rss", "/feed", "/atom", "/sitemap",
    ]
    for pat in skip_patterns:
        if pat in path:
            return False
    # Article URLs typically have a slug or ID
    # e.g. /news/2026/08/27/headline-slug or /article/12345
    if re.search(r'/\d{4}/\d{2}/', path):  # date-based URLs
        return True
    if re.search(r'/article/\d+', path):  # article ID
        return True
    if re.search(r'/[a-z0-9-]{10,}$', path):  # long slug
        return True
    if re.search(r'/news/[a-z0-9-]+', path):  # news slug
        return True
    if re.search(r'/story/[a-z0-9-]+', path):  # story slug
        return True
    if re.search(r'/(?:press|announcements|keynotes|program|papers|schedule|blog|updates|sessions|events|talks)/[a-z0-9-]+', path):  # conference & press slug
        return True
    if re.search(r'/(?:conference|symposium|summit|event|paper)/[a-z0-9-]+', path):  # academic & conference slug
        return True
    # If path has multiple segments and ends with something long
    segments = [s for s in path.split("/") if s]
    if len(segments) >= 2 and len(segments[-1]) > 8:
        return True
    return False


def _extract_links(html: str, base_url: str) -> list[str]:
    """Extract article-like links from an HTML page."""
    # Find all <a href="..."> tags
    link_pattern = re.compile(r'<a[^>]+href=["\']([^"\']+)["\']', re.I)
    raw_links = link_pattern.findall(html)

    seen = set()
    links = []
    for href in raw_links:
        # Resolve relative URLs
        full_url = urljoin(base_url, href)
        # Normalize
        full_url = full_url.split("#")[0].split("?")[0]
        if full_url in seen:
            continue
        seen.add(full_url)
        # Must be same domain
        if urlparse(full_url).netloc != urlparse(base_url).netloc:
            continue
        if _is_article_url(full_url):
            links.append(full_url)

    return links[:MAX_ARTICLES_PER_PAGE]


def _extract_article(html: str, url: str) -> dict | None:
    """Extract title, body, and best image from an article page."""
    # Title: try <h1> first, then <title>
    title = None
    h1_match = re.search(r'<h1[^>]*>(.*?)</h1>', html, re.I | re.DOTALL)
    if h1_match:
        title = re.sub(r'<[^>]+>', '', h1_match.group(1)).strip()
    if not title:
        title_match = re.search(r'<title[^>]*>(.*?)</title>', html, re.I | re.DOTALL)
        if title_match:
            title = re.sub(r'<[^>]+>', '', title_match.group(1)).strip()
            # Remove site name suffix
            for sep in [" | ", " - ", " — ", " :: ", " » "]:
                if sep in title:
                    title = title.split(sep)[0].strip()
    if not title:
        return None

    # Body: try <article> tag first, then common content divs
    body = None
    article_match = re.search(r'<article[^>]*>(.*?)</article>', html, re.I | re.DOTALL)
    if article_match:
        body = article_match.group(1)

    if not body:
        # Try common content class/id patterns
        content_patterns = [
            r'<div[^>]*class="[^"]*(?:article|story|post|entry|content)[^"]*"[^>]*>(.*?)</div>',
            r'<div[^>]*id="[^"]*(?:article|story|post|entry|content)[^"]*"[^>]*>(.*?)</div>',
            r'<main[^>]*>(.*?)</main>',
        ]
        for pat in content_patterns:
            m = re.search(pat, html, re.I | re.DOTALL)
            if m:
                body = m.group(1)
                break

    if not body:
        # Last resort: grab all <p> tags
        paragraphs = re.findall(r'<p[^>]*>(.*?)</p>', html, re.I | re.DOTALL)
        body = "\n\n".join(paragraphs)

    if not body:
        return None

    # Image: use the image scorer to pick the best candidate from the page
    image_url = None
    try:
        from .image_scorer import extract_image_candidates, pick_best_image
        candidates = extract_image_candidates(html, url)
        image_url = pick_best_image(candidates, min_score=5.0)
    except Exception:
        # Fallback: just grab og:image
        og_match = re.search(
            r"""<meta[^>]+property=['"]og:image['"][^>]+content=['"]([^'"]+)['"]""",
            html, re.I,
        )
        if og_match:
            raw = og_match.group(1)
            image_url = urljoin(url, raw) if raw.startswith("//") or raw.startswith("/") else raw

    # Strip HTML tags
    body = re.sub(r'<[^>]+>', ' ', body)
    # Collapse whitespace
    body = re.sub(r'\s+', ' ', body).strip()
    # Decode HTML entities
    body = body.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    body = body.replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " ")

    if len(body) < 50:
        return None  # Too short, probably not an article

    return {
        "url": url,
        "title": title[:500],
        "body": body[:MAX_BODY_LENGTH],
        "published_at": _extract_date(html),
        "image_url": image_url,
    }


def _extract_date(html: str) -> datetime | None:
    """Try to extract a publication date from HTML."""
    # <time datetime="...">
    time_match = re.search(r'<time[^>]*datetime=["\']([^"\']+)["\']', html, re.I)
    if time_match:
        try:
            raw = time_match.group(1)
            # Handle various ISO formats
            raw = raw.replace("Z", "+00:00")
            return datetime.fromisoformat(raw)
        except (ValueError, TypeError):
            pass

    # <meta property="article:published_time" content="...">
    meta_match = re.search(
        r'<meta[^>]*(?:property|name)=["\'](?:article:published_time|publishdate|date)["\'][^>]*content=["\']([^"\']+)["\']',
        html, re.I
    )
    if meta_match:
        try:
            raw = meta_match.group(1).replace("Z", "+00:00")
            return datetime.fromisoformat(raw)
        except (ValueError, TypeError):
            pass

    # JSON-LD datePublished
    ld_match = re.search(r'"datePublished"\s*:\s*"([^"]+)"', html)
    if ld_match:
        try:
            raw = ld_match.group(1).replace("Z", "+00:00")
            return datetime.fromisoformat(raw)
        except (ValueError, TypeError):
            pass

    return None


def scrape_source(url: str, max_articles: int = MAX_ARTICLES_PER_PAGE) -> list[dict]:
    """Scrape articles from a non-RSS news source.

    1. Check robots.txt — skip if disallowed
    2. Fetch the main page
    3. Extract article links
    4. Fetch each article page, extract title + body

    Returns list of {url, title, body, published_at}.
    """
    # Check robots.txt
    verdict = _robots.is_allowed(url)
    if not verdict.allowed:
        log.info("robots.txt disallows scraping %s (path: %s)", url, verdict.disallowed_path)
        return []

    # Respect Crawl-delay
    if verdict.crawl_delay_s and verdict.crawl_delay_s > 0:
        time.sleep(min(verdict.crawl_delay_s, 5.0))  # Cap at 5s

    articles = []
    try:
        with httpx.Client(
            timeout=REQUEST_TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
        ) as client:
            # Fetch main page (bounded — never buffer more than MAX_FEED_BYTES)
            status, body = _bounded_get(client, url)
            if status >= 400 or body is None:
                log.warning("scrape main page %s: HTTP %s", url, status)
                return []

            html = body.decode("utf-8", "replace")
            links = _extract_links(html, url)
            log.info("scrape %s: found %d article links", url, len(links))

            # Fetch each article
            for link in links[:max_articles]:
                # Check robots for each article URL.
                # FIX (2026-09-26, FIX_NOTES 1.2): this unpacked a 3-tuple
                # but RobotsCache.is_allowed() returns a RobotsVerdict
                # dataclass — the TypeError was swallowed by the outer
                # handler and EVERY 'web' source scraped 0 articles since
                # the robots.py refactor. Same bug already fixed in fetch.py.
                verdict = _robots.is_allowed(link)
                if not verdict.allowed:
                    continue

                if verdict.crawl_delay_s and verdict.crawl_delay_s > 0:
                    time.sleep(min(float(verdict.crawl_delay_s), 3.0))
                else:
                    time.sleep(0.5)  # Polite default

                try:
                    art_status, art_body = _bounded_get(client, link)
                    if art_status >= 400 or art_body is None:
                        continue
                    article = _extract_article(
                        art_body.decode("utf-8", "replace"), link)
                    if article:
                        articles.append(article)
                except Exception as e:
                    log.debug("scrape article %s failed: %s", link, e)
                    continue

    except Exception as e:
        log.warning("scrape %s failed: %s", url, e)

    return articles


def validate_web_source(url: str) -> dict:
    """Check if a URL is scrapable (robots.txt allows it, has article links).

    Returns {valid, article_count, sample_titles, error}.
    """
    verdict = _robots.is_allowed(url)
    if not verdict.allowed:
        return {
            "valid": False,
            "article_count": 0,
            "sample_titles": [],
            "error": f"robots.txt disallows scraping (path: {verdict.disallowed_path})",
        }

    try:
        with httpx.Client(
            timeout=REQUEST_TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
        ) as client:
            status, body = _bounded_get(client, url)
            if status >= 400 or body is None:
                return {
                    "valid": False,
                    "article_count": 0,
                    "sample_titles": [],
                    "error": f"HTTP {status}",
                }

            links = _extract_links(body.decode("utf-8", "replace"), url)
            if not links:
                return {
                    "valid": False,
                    "article_count": 0,
                    "sample_titles": [],
                    "error": "No article links found on page",
                }

            # Try to extract one article to verify it works
            sample_titles = []
            for link in links[:3]:
                try:
                    art_status, art_body = _bounded_get(client, link)
                    if art_status == 200 and art_body is not None:
                        article = _extract_article(
                            art_body.decode("utf-8", "replace"), link)
                        if article:
                            sample_titles.append(article["title"])
                except Exception:
                    continue
                time.sleep(0.5)

            return {
                "valid": len(sample_titles) > 0,
                "article_count": len(links),
                "sample_titles": sample_titles[:5],
                "error": None if sample_titles else "Could not extract articles from linked pages",
            }

    except Exception as e:
        return {
            "valid": False,
            "article_count": 0,
            "sample_titles": [],
            "error": str(e)[:200],
        }
