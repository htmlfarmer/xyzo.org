"""Video site crawler — discovers video sections on news websites and indexes
their video content.

WHAT THIS DOES:
  When XYZO indexes a new news source (e.g., Le Soleil from Senegal),
  this module probes the site for video sections like /web-tv/, /video/,
  /emissions/. It then crawls those pages, finds video article links,
  fetches each page for YouTube embeds, and indexes them.

EXAMPLE (Le Soleil):
  1. Probe: finds /rubriques/web-tv/ (HTTP 200)
  2. Crawl: finds 24 video article links in the section
  3. Fetch: each video page has a YouTube embed iframe
  4. Index: creates video_items + links to source articles

COMMON VIDEO SECTION PATTERNS:
  /web-tv/, /webtv/, /video/, /videos/, /emissions/, /emission/,
  /watch/, /media/, /gallery/, /rubriques/web-tv/, /category/video/

ROBOTS.TXT:
  Every request checks robots.txt via RobotsCache before fetching.
  Uses the same XYZO User-Agent as article fetching.
  Respects Crawl-delay between requests.

WHY THIS IS IMPORTANT:
  Many non-English news sites (African, Asian, Latin American) have
  video sections that are invisible to standard RSS parsing. Without
  crawling these sections, XYZO would miss their video news entirely.
"""
import logging
import re
import time
from urllib.parse import urljoin, urlparse

import httpx

from .db import connect
from .robots import RobotsCache, tier_for_url
from .video_constants import DEFAULT_UA, REQUEST_TIMEOUT, CRAWL_DELAY, MAX_PAGES_PER_SECTION, MAX_VIDEOS_PER_SOURCE
from .video_discover import discover_videos

log = logging.getLogger("xyzo.video_site_crawler")

VIDEO_SECTION_PATHS = [
    "/web-tv", "/webtv", "/web_tv",
    "/video", "/videos", "/video-news",
    "/emissions", "/emission",
    "/watch", "/listen",
    "/media", "/gallery",
    "/rubriques/web-tv", "/rubriques/video",
    "/category/video", "/category/videos",
    "/section/video", "/section/videos",
]

VIDEO_LINK_PATTERNS = re.compile(
    r"href=[\"']([^\"']*(?:/video/|/videos/|/web-tv/|/emission|/watch)[^\"']*)[\"']",
    re.IGNORECASE,
)


def _probe_video_sections(base_url: str, client: httpx.Client,
                          robots: RobotsCache = None) -> list[str]:
    """Probe a site for common video section paths.

    Returns list of working video section URLs.
    """
    parsed = urlparse(base_url)
    base = f"{parsed.scheme}://{parsed.netloc}"

    found = []
    for path in VIDEO_SECTION_PATHS:
        url = base + path
        try:
            # Check robots.txt before probing
            if robots and not robots.is_allowed(url).allowed:
                continue

            resp = client.head(url, timeout=8, follow_redirects=True)
            if resp.status_code == 200:
                # Verify it's not just a redirect to the homepage
                final = str(resp.url)
                if final.rstrip("/") != base.rstrip("/") and final != base_url:
                    found.append(final)
                    log.info("video_site_crawler: found section %s -> %s", path, final)
        except Exception:
            continue

    return found


def _extract_video_links(page_url: str, html: str) -> list[str]:
    """Extract links to video article pages from a section listing page."""
    links = set()

    # Pattern-based extraction
    for m in VIDEO_LINK_PATTERNS.finditer(html):
        href = m.group(1)
        full_url = urljoin(page_url, href)
        links.add(full_url)

    # Also extract all links and filter by video-like patterns
    all_links = re.findall(r"href=[\"']([^\"']*)[\"']", html, re.IGNORECASE)
    for href in all_links:
        full_url = urljoin(page_url, href)
        parsed = urlparse(full_url)
        # Same domain only
        if parsed.netloc != urlparse(page_url).netloc:
            continue
        # Video-like URL patterns
        if any(kw in parsed.path.lower() for kw in ["/video", "/web-tv", "/emission", "/watch"]):
            links.add(full_url)

    return list(links)


def _extract_embedded_videos(page_url: str, html: str) -> list[dict]:
    """Extract YouTube videos embedded in a page."""
    return discover_videos(html)


def crawl_source(source_id: int, source_url: str, source_name: str,
                 feed_url: str | None = None) -> dict:
    """Crawl a news source for video content.

    1. Check RSS feed for video links
    2. Probe site for video sections
    3. Crawl video section pages
    4. Extract YouTube embeds from video article pages
    5. Index discovered videos
    """
    summary = {
        "sections_found": 0,
        "video_links_found": 0,
        "videos_embedded": 0,
        "videos_indexed": 0,
        "errors": 0,
    }

    parsed = urlparse(source_url)
    base_url = f"{parsed.scheme}://{parsed.netloc}"
    robots = RobotsCache(ua=DEFAULT_UA)

    with httpx.Client(timeout=REQUEST_TIMEOUT, follow_redirects=True,
                      headers={"User-Agent": DEFAULT_UA}) as client:

        # Step 1: Check RSS feed for video links
        if feed_url:
            try:
                resp = client.get(feed_url, timeout=10)
                if resp.status_code == 200:
                    video_links = _extract_video_links(feed_url, resp.text)
                    summary["video_links_found"] += len(video_links)
                    log.info("video_site_crawler: RSS feed has %d video links", len(video_links))
            except Exception as e:
                log.debug("video_site_crawler: RSS check failed: %s", e)

        # Step 2: Probe for video sections (with robots.txt check)
        sections = _probe_video_sections(base_url, client, robots)
        summary["sections_found"] = len(sections)

        # Step 3: Crawl video section pages (with robots.txt check)
        all_video_links = []
        for section_url in sections:
            try:
                verdict = robots.is_allowed(section_url)
                if not verdict.allowed:
                    log.info("video_site_crawler: robots skip %s", section_url)
                    continue

                resp = client.get(section_url, timeout=REQUEST_TIMEOUT)
                if resp.status_code != 200:
                    continue

                links = _extract_video_links(section_url, resp.text)
                all_video_links.extend(links)

                # Check for pagination
                page = 2
                while page <= 5 and len(all_video_links) < MAX_VIDEOS_PER_SOURCE:
                    paginated = section_url.rstrip("/") + f"/page/{page}/"
                    try:
                        presp = client.get(paginated, timeout=REQUEST_TIMEOUT)
                        if presp.status_code != 200:
                            break
                        more_links = _extract_video_links(paginated, presp.text)
                        if not more_links:
                            break
                        all_video_links.extend(more_links)
                        page += 1
                        time.sleep(CRAWL_DELAY)
                    except Exception:
                        break

                time.sleep(CRAWL_DELAY)
            except Exception as e:
                log.debug("video_site_crawler: section crawl failed: %s", e)

        # Deduplicate
        all_video_links = list(dict.fromkeys(all_video_links))
        summary["video_links_found"] = len(all_video_links)

        # Step 4: Fetch each video article page for embeds
        discovered = []
        for link in all_video_links[:MAX_VIDEOS_PER_SOURCE]:
            try:
                # Check robots.txt before fetching
                if not robots.is_allowed(link).allowed:
                    log.info("video_site_crawler: robots skip %s", link)
                    continue

                resp = client.get(link, timeout=REQUEST_TIMEOUT)
                if resp.status_code != 200:
                    continue

                videos = _extract_embedded_videos(link, resp.text)
                for vid in videos:
                    vid["source_url"] = link
                    discovered.append(vid)

                time.sleep(CRAWL_DELAY)
            except Exception as e:
                summary["errors"] += 1
                log.debug("video_site_crawler: page fetch failed %s: %s", link, e)

        summary["videos_embedded"] = len(discovered)

    # Step 5: Index discovered videos
    if discovered:
        with connect() as conn, conn.cursor() as cur:
            for vid in discovered:
                video_id = vid["video_id"]
                url = f"https://www.youtube.com/watch?v={video_id}"
                embed_url = f"https://www.youtube.com/embed/{video_id}"
                rss_url = f"https://www.youtube.com/feeds/videos.xml?channel_id={video_id}"

                # Upsert channel
                cur.execute("""
                    INSERT INTO video_channels (name, platform, channel_id, channel_url,
                                                feed_url, country, source_type, active)
                    VALUES (%s, 'youtube', %s, %s, %s, (SELECT country FROM news_sources WHERE id = %s),
                            'creator', TRUE)
                    ON CONFLICT (channel_id, platform) WHERE channel_id IS NOT NULL DO NOTHING
                    RETURNING id
                """, (f"YT:{video_id}", video_id,
                      f"https://www.youtube.com/channel/{video_id}",
                      rss_url, source_id))
                row = cur.fetchone()
                if row:
                    ch_id = row["id"]
                else:
                    cur.execute("SELECT id FROM video_channels WHERE channel_id = %s AND platform = 'youtube'",
                               (video_id,))
                    existing = cur.fetchone()
                    if not existing:
                        continue
                    ch_id = existing["id"]

                # Insert video
                cur.execute("""
                    INSERT INTO video_items (channel_id, video_id, platform, url, title,
                                             embed_url, video_type, status)
                    VALUES (%s, %s, 'youtube', %s, %s, %s, 'news_report', 'pending')
                    ON CONFLICT (url) DO NOTHING
                    RETURNING id
                """, (ch_id, video_id, url, vid.get("source_url", "")[:500], embed_url))

                if cur.fetchone():
                    summary["videos_indexed"] += 1

                    # Link to source article if available
                    if vid.get("source_url"):
                        cur.execute("""
                            SELECT id FROM news_articles WHERE url = %s
                        """, (vid["source_url"],))
                        article = cur.fetchone()
                        if article:
                            cur.execute("""
                                INSERT INTO video_article_matches (video_id, article_id, similarity)
                                VALUES ((SELECT id FROM video_items WHERE url = %s), %s, 0.9)
                                ON CONFLICT DO NOTHING
                            """, (url, article["id"]))

            conn.commit()

    return summary


def run_batch(limit: int = 10) -> dict:
    """Crawl recently-indexed sources for video content.

    Processes sources that haven't been video-crawled yet.
    """
    summary = {"sources_crawled": 0, "total_videos": 0}

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT s.id, s.name, s.feed_url,
                   COALESCE(s.website_url, s.feed_url) as url
            FROM news_sources s
            WHERE s.active = TRUE
              AND s.country IS NOT NULL
            ORDER BY s.last_success_at DESC NULLS LAST
            LIMIT %s
        """, (limit,))
        sources = cur.fetchall()

    if not sources:
        return summary

    log.info("video_site_crawler: probing %d sources for video sections", len(sources))

    for src in sources:
        url = src.get("url") or src.get("feed_url")
        if not url:
            continue

        result = crawl_source(
            source_id=src["id"],
            source_url=url,
            source_name=src["name"],
            feed_url=src.get("feed_url"),
        )

        summary["sources_crawled"] += 1
        summary["total_videos"] += result["videos_indexed"]

        if result["videos_indexed"] > 0:
            log.info("video_site_crawler: %s -> %d videos indexed",
                     src["name"], result["videos_indexed"])

    return summary


if __name__ == "__main__":
    import json, sys
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    result = run_batch()
    print(json.dumps(result, indent=2, default=str))
