"""Audio feed auto-discovery — finds correct RSS feed URLs from podcast homepages.

Probes common RSS URL patterns and checks HTML <link> tags for feed autodiscovery.
Updates audio_shows.feed_url with the correct URL, then re-fetches to pull episodes.

Common podcast RSS patterns:
  - /feed, /feed/, /feed/podcast, /feed/podcast/
  - /rss, /rss.xml, /podcast/feed
  - /podcasts/feed, /podcast.rss
  - iTunes: lookup via Apple Podcasts search API
"""
import logging
import re
import time
from urllib.parse import urljoin, urlparse

import httpx

from .db import connect

log = logging.getLogger("xyzo.audio_discover")

USER_AGENT = "XyzoFetcher/0.1 (+https://xyzo.org/bot; contact@xyzo.org)"
TIMEOUT = 15.0

# Common RSS/podcast feed URL patterns to probe
FEED_PATTERNS = [
    "/feed",
    "/feed/",
    "/feed/podcast",
    "/feed/podcast/",
    "/rss",
    "/rss.xml",
    "/podcast/feed",
    "/podcast/feed/",
    "/podcasts/feed",
    "/podcasts/feed/",
    "/podcast.rss",
    "/feed.xml",
    "/atom.xml",
    "/index.xml",
]

# MIME types that indicate an RSS/Atom feed
FEED_MIMES = {
    "application/rss+xml",
    "application/atom+xml",
    "application/xml",
    "text/xml",
    "application/rdf+xml",
    "application/json",
    "application/feed+json",
}


def _is_feed_content(content: bytes) -> bool:
    """Quick check if content looks like an RSS/Atom feed."""
    head = content[:500].strip()
    # RSS
    if b"<rss" in head or b"<channel" in head:
        return True
    # Atom
    if b"<feed" in head or b"xmlns:atom" in head:
        return True
    # RDF
    if b"<rdf:RDF" in head or b"<rdf:Description" in head:
        return True
    # JSON Feed
    if head.startswith(b"{") and b'"items"' in head[:500]:
        return True
    return False


def _discover_from_html(homepage_url: str, client: httpx.Client) -> str | None:
    """Check HTML <link> tags for RSS autodiscovery."""
    try:
        resp = client.get(homepage_url, timeout=TIMEOUT, follow_redirects=True)
        if resp.status_code != 200:
            return None
        html = resp.text[:50000]  # only scan first 50KB
        # Find <link rel="alternate" type="application/rss+xml" href="...">
        matches = re.findall(
            r'<link[^>]+type=["\']application/(?:rss|atom)\+xml["\'][^>]+href=["\']([^"\']+)["\']',
            html, re.IGNORECASE,
        )
        if not matches:
            # Also check reversed attribute order
            matches = re.findall(
                r'<link[^>]+href=["\']([^"\']+)["\'][^>]+type=["\']application/(?:rss|atom)\+xml["\']',
                html, re.IGNORECASE,
            )
        if matches:
            return urljoin(homepage_url, matches[0])
    except Exception:
        pass
    return None


def _probe_feed_patterns(homepage_url: str, client: httpx.Client) -> str | None:
    """Try common RSS URL patterns against the homepage."""
    parsed = urlparse(homepage_url)
    base = f"{parsed.scheme}://{parsed.netloc}"

    for pattern in FEED_PATTERNS:
        url = base + pattern
        try:
            resp = client.head(url, timeout=8, follow_redirects=True)
            if resp.status_code == 200:
                content_type = (resp.headers.get("content-type") or "").lower()
                if any(m in content_type for m in FEED_MIMES):
                    return url
                # Some servers don't set correct content-type, try GET
                resp2 = client.get(url, timeout=TIMEOUT, follow_redirects=True)
                if resp2.status_code == 200 and _is_feed_content(resp2.content):
                    return url
        except Exception:
            continue
    return None


def discover_feed(homepage_url: str, client: httpx.Client) -> str | None:
    """Try to find the correct RSS feed URL for a podcast homepage."""
    # 1. Check HTML <link> tags (most reliable)
    feed_url = _discover_from_html(homepage_url, client)
    if feed_url:
        return feed_url

    # 2. Probe common patterns
    feed_url = _probe_feed_patterns(homepage_url, client)
    if feed_url:
        return feed_url

    return None


def fix_broken_feeds(limit: int = 50) -> dict:
    """Find shows with 0 episodes and try to discover their correct RSS feed."""
    summary = {"checked": 0, "fixed": 0, "still_broken": 0, "no_homepage": 0}

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, title, homepage_url, feed_url
            FROM audio_shows
            WHERE episode_count = 0
              AND active = TRUE
              AND homepage_url IS NOT NULL
              AND homepage_url != ''
            ORDER BY id
            LIMIT %s
        """, (limit,))
        shows = list(cur.fetchall())

    if not shows:
        log.info("audio_discover: no broken feeds to fix")
        return summary

    log.info("audio_discover: checking %d shows", len(shows))

    with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as client:
        for show in shows:
            show_id = show["id"]
            homepage = show["homepage_url"]
            old_feed = show["feed_url"]

            summary["checked"] += 1

            try:
                new_feed = discover_feed(homepage, client)
                if new_feed and new_feed != old_feed:
                    # Update the feed URL
                    with connect() as conn, conn.cursor() as cur:
                        cur.execute(
                            "UPDATE audio_shows SET feed_url = %s, error_count = 0 WHERE id = %s",
                            (new_feed, show_id),
                        )
                        conn.commit()
                    summary["fixed"] += 1
                    log.info("audio_discover: fixed %s: %s → %s", show["title"], old_feed[:60], new_feed[:60])
                elif new_feed:
                    summary["still_broken"] += 1
                    log.debug("audio_discover: %s feed URL unchanged", show["title"])
                else:
                    summary["still_broken"] += 1
                    log.debug("audio_discover: could not find feed for %s", show["title"])
            except Exception as exc:
                summary["still_broken"] += 1
                log.warning("audio_discover: error for %s: %s", show["title"], exc)

            # Be polite
            time.sleep(0.5)

    return summary


def run(limit: int = 50) -> dict:
    """Main entry point for feed discovery."""
    return fix_broken_feeds(limit)
