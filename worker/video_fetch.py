"""Video fetcher — YouTube RSS + broadcaster RSS polling for XYZO.

ARCHITECTURE DECISION: Why RSS over YouTube API?
  YouTube Data API v3 has a hard 100/day limit on search.list calls.
  RSS feeds (youtube.com/feeds/videos.xml?channel_id=...) are free,
  unlimited, and return the same 15 most recent videos per channel.
  We use RSS for routine fetching and reserve API calls for discovery.

FLOW:
  video_channels (seed from JSON)
    → claim due channels (5-min lease, FOR UPDATE SKIP LOCKED)
    → YouTube RSS: youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID
    → Broadcaster RSS: aljazeera.com/xml/rss/all.xml, france24.com/en/rss, etc.
    → Insert new video_items (status=pending)

ROBOTS.TXT:
  - YouTube RSS: bypassed (public feeds designed for programmatic access)
  - Non-YouTube RSS: checked via RobotsCache (same as article fetching)
  - Crawl-delay respected between same-host requests

QUOTA:
  - No YouTube API key needed for routine fetching
  - YouTube API used only for channel discovery (optional, needs XYZO_YOUTUBE_API_KEY)

Env vars:
  XYZO_YOUTUBE_API_KEY  — YouTube Data API v3 key (optional)
  XYZO_FETCH_CONCURRENT — max parallel host groups (default 8)
  XYZO_FETCH_INTERVAL   — min seconds between same-host requests (default 1.0)
"""
import json
import logging
import os
import re
import calendar
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode, urlparse, parse_qs

import feedparser
import httpx

from .db import connect
from .robots import RobotsCache, tier_for_url
from .video_constants import (
    DEFAULT_UA, POLITE_UA, REQUEST_TIMEOUT, MIN_FETCH_INTERVAL_S,
    MAX_CONCURRENT_HOSTS, LEASE_TTL_S, RECENT_SUCCESS_WINDOW_S,
    YOUTUBE_QUOTA_BUDGET,
)

log = logging.getLogger("xyzo.video_fetch")

VIDEO_SOURCES_FILE = Path(__file__).parent / "video_sources.json"

# Env-var overrides (not in shared constants — these are fetch-specific)
HTTPX_MAX_CONNECTIONS = int(os.environ.get("XYZO_HTTPX_MAX_CONNECTIONS", "4"))
HTTPX_MAX_KEEPALIVE = int(os.environ.get("XYZO_HTTPX_MAX_KEEPALIVE", "2"))
_HTTPX_LIMITS = httpx.Limits(
    max_connections=HTTPX_MAX_CONNECTIONS,
    max_keepalive_connections=HTTPX_MAX_KEEPALIVE,
)
YOUTUBE_API_KEY = os.environ.get("XYZO_YOUTUBE_API_KEY", "")
YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"
LEADERBOARD_SIZE = 200


def user_agent_for(url: str) -> str:
    tier = tier_for_url(url)
    if tier in ("gov", "university"):
        return POLITE_UA
    return DEFAULT_UA


# ── Source loading ───────────────────────────────────────────────────────

def load_video_sources() -> list[dict]:
    """Load video sources from video_sources.json."""
    if not VIDEO_SOURCES_FILE.exists():
        return []
    with VIDEO_SOURCES_FILE.open() as f:
        data = json.load(f)
    return [s for s in data.get("sources", []) if s.get("enabled", True)]


def seed_video_channels(sources: list[dict] | None = None) -> int:
    """Upsert all video sources into video_channels. Returns count."""
    sources = sources or load_video_sources()
    rows = []
    for s in sources:
        rows.append((
            s["name"],
            s.get("platform", "youtube"),
            s.get("channel_id"),
            s["channel_url"],
            s.get("website_url"),
            s.get("feed_url"),
            s.get("description", "")[:2000],
            s.get("country"),
            s.get("region", "global"),
            s.get("languages", []),
            s.get("categories", []),
            s.get("source_type", "broadcaster"),
        ))

    with connect() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO video_channels (
                name, platform, channel_id, channel_url,
                website_url, feed_url, description, country,
                region, languages, categories, source_type
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (channel_id, platform)
                WHERE channel_id IS NOT NULL
            DO UPDATE SET
                name = EXCLUDED.name,
                channel_url = EXCLUDED.channel_url,
                website_url = EXCLUDED.website_url,
                feed_url = EXCLUDED.feed_url,
                description = EXCLUDED.description,
                country = EXCLUDED.country,
                region = EXCLUDED.region,
                languages = EXCLUDED.languages,
                categories = EXCLUDED.categories,
                source_type = EXCLUDED.source_type
            """,
            rows,
        )
    return len(rows)


# ── YouTube Data API v3 ─────────────────────────────────────────────────

class YouTubeQuotaTracker:
    """Track YouTube API quota usage across the fetch cycle."""

    def __init__(self, budget: int = YOUTUBE_QUOTA_BUDGET):
        self.budget = budget
        self.used = 0
        self.costs = {
            "channels": 1,
            "playlistItems": 1,
            "videos": 1,
            "search": 100,  # 100 units per call
        }

    def can_afford(self, endpoint: str) -> bool:
        cost = self.costs.get(endpoint, 1)
        return (self.used + cost) <= self.budget

    def charge(self, endpoint: str) -> None:
        self.used += self.costs.get(endpoint, 1)

    @property
    def remaining(self) -> int:
        return max(0, self.budget - self.used)


def _youtube_api_get(endpoint: str, params: dict, quota: YouTubeQuotaTracker) -> dict | None:
    """Make a YouTube Data API v3 GET request with quota tracking."""
    if not YOUTUBE_API_KEY:
        log.warning("video_fetch: XYZO_YOUTUBE_API_KEY not set, skipping YouTube API")
        return None

    if not quota.can_afford(endpoint):
        log.info("video_fetch: YouTube quota exhausted (%d/%d used)", quota.used, quota.budget)
        return None

    params["key"] = YOUTUBE_API_KEY
    url = f"{YOUTUBE_API_BASE}/{endpoint}"

    try:
        resp = httpx.get(url, params=params, timeout=REQUEST_TIMEOUT)
        quota.charge(endpoint)

        if resp.status_code == 403:
            error = resp.json().get("error", {})
            if "quotaExceeded" in str(error.get("code", "")):
                log.warning("video_fetch: YouTube quota exceeded")
                quota.used = quota.budget  # force exhaustion
            else:
                log.warning("video_fetch: YouTube API 403: %s", error.get("message", ""))
            return None

        if resp.status_code >= 400:
            log.warning("video_fetch: YouTube API %d: %s", resp.status_code, resp.text[:200])
            return None

        return resp.json()

    except httpx.HTTPError as exc:
        log.warning("video_fetch: YouTube API error: %s", exc)
        return None


def _get_channel_uploads_playlist(channel_id: str, quota: YouTubeQuotaTracker) -> str | None:
    """Get the uploads playlist ID for a YouTube channel."""
    data = _youtube_api_get("channels", {
        "part": "contentDetails",
        "id": channel_id,
    }, quota)
    if not data or not data.get("items"):
        return None

    items = data["items"][0]
    content_details = items.get("contentDetails", {})
    related_playlists = content_details.get("relatedPlaylists", {})
    return related_playlists.get("uploads")


def _get_channel_metadata(channel_id: str, quota: YouTubeQuotaTracker) -> dict | None:
    """Get channel metadata (stats, topic details)."""
    data = _youtube_api_get("channels", {
        "part": "snippet,statistics,topicDetails",
        "id": channel_id,
    }, quota)
    if not data or not data.get("items"):
        return None

    item = data["items"][0]
    snippet = item.get("snippet", {})
    stats = item.get("statistics", {})

    return {
        "title": snippet.get("title", ""),
        "description": snippet.get("description", "")[:2000],
        "subscriber_count": int(stats.get("subscriberCount", 0)),
        "video_count": int(stats.get("videoCount", 0)),
        "country": snippet.get("country"),
        "language": snippet.get("defaultLanguage"),
        "thumbnail": (snippet.get("thumbnails", {}).get("high", {}) or
                      snippet.get("thumbnails", {}).get("medium", {}) or
                      snippet.get("thumbnails", {}).get("default", {})).get("url"),
    }


def _list_playlist_items(playlist_id: str, max_results: int = 50,
                         page_token: str | None = None,
                         quota: YouTubeQuotaTracker = None) -> tuple[list[dict], str | None]:
    """List items from a YouTube playlist. Returns (items, nextPageToken)."""
    params = {
        "part": "snippet,contentDetails",
        "playlistId": playlist_id,
        "maxResults": min(max_results, 50),
    }
    if page_token:
        params["pageToken"] = page_token

    data = _youtube_api_get("playlistItems", params, quota)
    if not data:
        return [], None

    items = []
    for item in data.get("items", []):
        snippet = item.get("snippet", {})
        content_details = item.get("contentDetails", {})

        # Skip private/deleted videos
        if snippet.get("title") in ("Deleted video", "Private video"):
            continue

        video_id = content_details.get("videoId", "")
        if not video_id:
            # Try to extract from resource_id
            resource_id = snippet.get("resourceId", {})
            video_id = resource_id.get("videoId", "")

        if not video_id:
            continue

        # Parse published date
        published_str = snippet.get("publishedAt", "")
        published_at = None
        if published_str:
            try:
                published_at = datetime.fromisoformat(published_str.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                pass

        # Thumbnail
        thumbnails = snippet.get("thumbnails", {})
        thumb = (thumbnails.get("maxres") or thumbnails.get("high") or
                 thumbnails.get("medium") or thumbnails.get("default") or {})
        thumbnail_url = thumb.get("url", "")

        items.append({
            "video_id": video_id,
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "embed_url": f"https://www.youtube.com/embed/{video_id}",
            "title": snippet.get("title", "").strip()[:500],
            "description": (snippet.get("description") or "").strip()[:4000],
            "published_at": published_at,
            "thumbnail_url": thumbnail_url,
            "channel_title": snippet.get("channelTitle", ""),
        })

    next_token = data.get("nextPageToken")
    return items, next_token


def _enrich_video_metadata(video_ids: list[str], quota: YouTubeQuotaTracker) -> dict[str, dict]:
    """Fetch detailed metadata for a batch of video IDs (max 50 per call)."""
    enriched = {}

    # Process in batches of 50
    for i in range(0, len(video_ids), 50):
        batch = video_ids[i:i + 50]
        data = _youtube_api_get("videos", {
            "part": "contentDetails,statistics,topicDetails",
            "id": ",".join(batch),
        }, quota)
        if not data:
            continue

        for item in data.get("items", []):
            vid = item["id"]
            content = item.get("contentDetails", {})
            stats = item.get("statistics", {})
            topics = item.get("topicDetails", {})

            # Parse ISO 8601 duration (PT1H2M3S)
            duration_str = content.get("duration", "")
            duration_seconds = _parse_iso_duration(duration_str)

            # Caption info
            caption = content.get("caption", "false").lower() == "true"

            enriched[vid] = {
                "duration_seconds": duration_seconds,
                "transcript_available": caption,
                "view_count": int(stats.get("viewCount", 0)),
                "like_count": int(stats.get("likeCount", 0)),
                "comment_count": int(stats.get("commentCount", 0)),
                "topic_ids": topics.get("topicIds", []),
                "category_id": content.get("videoCategoryId"),
            }

    return enriched


def _parse_iso_duration(s: str) -> int | None:
    """Parse ISO 8601 duration like PT1H2M3S → seconds."""
    if not s:
        return None
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s)
    if not m:
        return None
    h, mi, sec = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mi * 60 + sec


# ── RSS feed parsing (for non-YouTube sources) ──────────────────────────

def _parse_video_rss(content: bytes) -> list[dict]:
    """Parse an RSS/Atom feed that contains video entries.

    Handles standard RSS with <media:content>, <enclosure> with video MIME,
    and YouTube channel RSS feeds.
    """
    parsed = feedparser.parse(content)
    items = []

    for entry in parsed.entries:
        url = (entry.get("link") or entry.get("id") or "").strip()
        if not url:
            continue

        # Skip non-video entries
        title = (entry.get("title") or "").strip()
        if not title:
            continue

        # Video URL from media:content or enclosure
        video_url = None
        media_content = entry.get("media_content") or []
        for media in media_content:
            if isinstance(media, dict):
                medium = (media.get("medium") or "").lower()
                url_val = media.get("url", "")
                type_val = (media.get("type") or "").lower()
                if medium == "video" or type_val.startswith("video/"):
                    video_url = url_val
                    break

        if not video_url:
            enclosures = entry.get("enclosures") or []
            for enc in enclosures:
                if isinstance(enc, dict):
                    type_val = (enc.get("type") or "").lower()
                    url_val = enc.get("href") or enc.get("url", "")
                    if type_val.startswith("video/"):
                        video_url = url_val
                        break

        # Published date
        published_at = None
        for key in ("published_parsed", "updated_parsed", "created_parsed"):
            t = entry.get(key)
            if t:
                try:
                    # UTC struct from feedparser — timegm, NOT mktime (see fetch.py:183)
                    published_at = datetime.fromtimestamp(calendar.timegm(t), tz=timezone.utc)
                    break
                except (OverflowError, ValueError, OSError):
                    continue

        # Image/thumbnail
        thumbnail_url = None
        media_thumbnail = entry.get("media_thumbnail") or []
        if media_thumbnail and isinstance(media_thumbnail[0], dict):
            thumbnail_url = media_thumbnail[0].get("url")
        if not thumbnail_url:
            media_content_list = entry.get("media_content") or []
            for media in media_content_list:
                if isinstance(media, dict) and (media.get("medium") or "").lower() == "image":
                    thumbnail_url = media.get("url")
                    break

        # Description
        description = ""
        for key in ("summary", "description"):
            val = entry.get(key)
            if isinstance(val, str) and val.strip():
                description = re.sub(r"<[^>]+>", " ", val).strip()
                break

        # Extract YouTube video ID if present
        video_id = None
        if "youtube.com" in url or "youtu.be" in url:
            m = re.search(r"(?:v=|/)([a-zA-Z0-9_-]{11})", url)
            if m:
                video_id = m.group(1)

        items.append({
            "video_id": video_id or url,
            "url": url,
            "embed_url": f"https://www.youtube.com/embed/{video_id}" if video_id else None,
            "title": title[:500],
            "description": description[:4000],
            "published_at": published_at,
            "thumbnail_url": thumbnail_url,
            "video_url": video_url,
        })

    return items


# ── Lease system (same pattern as audio_fetch.py) ────────────────────────

VIDEO_CLAIM_SQL = """
    WITH claimable AS (
        SELECT id, name, channel_id, channel_url, platform, feed_url
        FROM video_channels
        WHERE active = TRUE
          AND (
                last_success_at IS NULL
             OR last_success_at < now() - INTERVAL '30 minutes'
          )
          AND (fetch_in_progress = FALSE OR lease_expires_at < now())
        ORDER BY last_success_at NULLS FIRST, id
        FOR UPDATE SKIP LOCKED
    ),
    claimed AS (
        UPDATE video_channels
        SET fetch_in_progress = TRUE,
            lease_token = gen_random_uuid()::text,
            lease_expires_at = now() + INTERVAL '{ttl} seconds',
            last_success_at = now()
        FROM claimable
        WHERE video_channels.id = claimable.id
        RETURNING video_channels.id, video_channels.name, video_channels.channel_id,
                  video_channels.channel_url, video_channels.platform,
                  video_channels.feed_url, video_channels.etag,
                  video_channels.last_modified, video_channels.lease_token
    )
    SELECT id, name, channel_id, channel_url, platform, feed_url,
           etag, last_modified, lease_token
    FROM claimed
    ORDER BY id
""".format(ttl=LEASE_TTL_S)


def _claim_channels_due(cur) -> list[dict]:
    """Atomically claim all currently-due video channels for fetch."""
    cur.execute("""
        ALTER TABLE video_channels ADD COLUMN IF NOT EXISTS fetch_in_progress BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE video_channels ADD COLUMN IF NOT EXISTS lease_token TEXT;
        ALTER TABLE video_channels ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
    """)
    cur.execute(VIDEO_CLAIM_SQL)
    return cur.fetchall()


def _release_lease(cur, channel_id: int, lease_token: str) -> bool:
    """Release the lease on a channel; CAS-guarded by lease_token."""
    cur.execute(
        "UPDATE video_channels SET fetch_in_progress = FALSE, "
        "lease_token = NULL, lease_expires_at = NULL "
        "WHERE id = %s AND lease_token = %s RETURNING id",
        (channel_id, lease_token),
    )
    return cur.fetchone() is not None


def _update_channel_status(cur, channel_id: int, status: dict) -> None:
    """Update channel-level status after a fetch attempt."""
    sets = []
    args = []
    if status.get("last_success_at"):
        sets.append("last_success_at = now()")
    if status.get("last_failure_at"):
        sets.append("last_failure_at = now()")
        sets.append("error_count = error_count + 1")
    if status.get("etag"):
        sets.append("etag = %s"); args.append(status["etag"])
    if status.get("last_modified"):
        sets.append("last_modified = %s"); args.append(status["last_modified"])
    if status.get("subscriber_count") is not None:
        sets.append("subscriber_count = %s"); args.append(status["subscriber_count"])
    if status.get("video_count") is not None:
        sets.append("video_count = %s"); args.append(status["video_count"])
    if not sets:
        return
    args.append(channel_id)
    cur.execute(
        f"UPDATE video_channels SET {', '.join(sets)} WHERE id = %s",
        args,
    )


# ── Video item insertion ─────────────────────────────────────────────────

def _insert_video_items(cur, items: list[dict], channel_db_id: int, channel_platform: str = "youtube") -> int:
    """Insert new video items; returns count of newly inserted rows."""
    if not items:
        return 0

    rows = []
    for item in items:
        rows.append((
            channel_db_id,
            item["video_id"],
            item.get("platform", channel_platform),
            item["url"],
            item["title"],
            item.get("description", ""),
            item.get("published_at"),
            item.get("duration_seconds"),
            item.get("thumbnail_url"),
            item.get("embed_url"),
            item.get("view_count"),
            item.get("like_count"),
            item.get("comment_count"),
            item.get("transcript_available", False),
        ))

    cur.executemany(
        """
        INSERT INTO video_items (
            channel_id, video_id, platform, url, title, description,
            published_at, duration_seconds, thumbnail_url, embed_url,
            view_count, like_count, comment_count, transcript_available
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (url) DO NOTHING
        RETURNING id
        """,
        rows,
    )
    inserted = []
    while True:
        if cur.pgresult:
            inserted.extend(cur.fetchall())
        if not cur.nextset():
            break

    # Update channel video count
    if inserted:
        cur.execute(
            "UPDATE video_channels SET video_count = "
            "(SELECT COUNT(*) FROM video_items WHERE channel_id = %s) "
            "WHERE id = %s",
            (channel_db_id, channel_db_id),
        )

    return len(inserted)


# ── YouTube channel fetcher ──────────────────────────────────────────────

def _fetch_youtube_channel(client: httpx.Client, channel: dict,
                           quota: YouTubeQuotaTracker) -> tuple[list[dict], dict]:
    """Fetch recent videos from a YouTube channel.

    Returns (videos, status_update).
    """
    channel_id = channel.get("channel_id")
    if not channel_id:
        return [], {"last_failure_at": True}

    # Step 1: Get uploads playlist ID
    uploads_playlist = _get_channel_uploads_playlist(channel_id, quota)
    if not uploads_playlist:
        log.warning("video_fetch: no uploads playlist for channel %s", channel["name"])
        return [], {"last_failure_at": True}

    # Step 2: List recent videos from uploads playlist
    all_videos = []
    page_token = None
    pages = 0
    max_pages = 3  # ~150 most recent videos per channel

    while pages < max_pages:
        items, page_token = _list_playlist_items(
            uploads_playlist, max_results=50,
            page_token=page_token, quota=quota,
        )
        all_videos.extend(items)
        pages += 1

        if not page_token:
            break

    if not all_videos:
        return [], {"last_success_at": True}

    # Step 3: Enrich with detailed metadata (duration, captions, stats)
    video_ids = [v["video_id"] for v in all_videos if v.get("video_id")]
    enriched = _enrich_video_metadata(video_ids[:50], quota)  # cap at 50 for quota

    # Merge enriched data into videos
    for video in all_videos:
        vid = video.get("video_id", "")
        if vid in enriched:
            video.update(enriched[vid])

    status = {
        "last_success_at": True,
        "subscriber_count": channel.get("subscriber_count"),
        "video_count": channel.get("video_count"),
    }

    return all_videos, status


# ── RSS channel fetcher ──────────────────────────────────────────────────

def _fetch_rss_channel(client: httpx.Client, channel: dict) -> tuple[list[dict], dict]:
    """Fetch videos from an RSS feed URL."""
    feed_url = channel.get("feed_url")
    if not feed_url:
        return [], {"last_failure_at": True}

    headers = {"User-Agent": user_agent_for(feed_url)}
    if channel.get("etag"):
        headers["If-None-Match"] = channel["etag"]
    if channel.get("last_modified"):
        headers["If-Modified-Since"] = channel["last_modified"]

    try:
        resp = client.get(feed_url, headers=headers, timeout=REQUEST_TIMEOUT, follow_redirects=True)
    except httpx.HTTPError as exc:
        log.warning("video_fetch: RSS failed for %s: %s", feed_url, exc)
        return [], {"last_failure_at": True}

    if resp.status_code == 304:
        return [], {"last_success_at": True, "_status_code": 304}

    if resp.status_code >= 400:
        log.warning("video_fetch: RSS %s: HTTP %d", feed_url, resp.status_code)
        return [], {"last_failure_at": True, "_status_code": resp.status_code}

    videos = _parse_video_rss(resp.content)
    status = {
        "last_success_at": True,
        "etag": resp.headers.get("etag"),
        "last_modified": resp.headers.get("last-modified"),
    }

    return videos, status


# ── Main fetch orchestration ─────────────────────────────────────────────

def fetch_all_videos(limit_per_channel: int = 50) -> dict:
    """Fetch all enabled video sources concurrently by host group.

    YouTube channels are fetched via API, RSS sources via feed parsing.
    """
    summary = {
        "channels_fetched": 0,
        "videos_inserted": 0,
        "errors": 0,
        "channels_skipped_recent": 0,
        "quota_used": 0,
    }

    quota = YouTubeQuotaTracker()

    with connect() as conn, conn.cursor() as cur:
        channels = _claim_channels_due(cur)

    log.info("video_fetch: %d channels to fetch (YouTube quota: %d remaining)",
             len(channels), quota.remaining)

    # Group by host for politeness
    host_groups: dict[str, list[dict]] = {}
    for ch in channels:
        url = ch.get("channel_url") or ch.get("feed_url") or ""
        host = urlparse(url).netloc.lower()
        if host not in host_groups:
            host_groups[host] = []
        host_groups[host].append(ch)

    def fetch_host_group(host: str, host_channels: list[dict]) -> dict:
        result = {"fetched": 0, "inserted": 0, "errors": 0}
        robots = RobotsCache(ua=user_agent_for(host_channels[0].get("channel_url", "")))
        last_at = 0.0

        with httpx.Client(timeout=REQUEST_TIMEOUT, limits=_HTTPX_LIMITS) as client:
            for ch in host_channels:
                channel_id_db = ch["id"]
                lease_token = ch.get("lease_token")
                platform = ch.get("platform", "youtube")

                try:
                    # robots.txt check (for RSS sources)
                    # Exception: YouTube RSS feeds (/feeds/videos.xml) are
                    # publicly designed for programmatic access despite robots.txt
                    feed_url = ch.get("feed_url")
                    is_youtube_rss = (feed_url and "youtube.com/feeds/" in feed_url)
                    if feed_url and not is_youtube_rss:
                        verdict = robots.is_allowed(feed_url)
                        if not verdict.allowed:
                            log.info("video_fetch: robots skip %s", feed_url)
                            continue

                        # Throttle
                        interval = max(verdict.crawl_delay_s or 0, MIN_FETCH_INTERVAL_S)
                        elapsed = time.time() - last_at
                        if elapsed < interval:
                            time.sleep(interval - elapsed)
                        last_at = time.time()

                    # Fetch videos — RSS preferred (works without API key),
                    # YouTube API used only when API key available and no RSS
                    if ch.get("feed_url"):
                        videos, status = _fetch_rss_channel(client, ch)
                    elif platform == "youtube" and YOUTUBE_API_KEY:
                        videos, status = _fetch_youtube_channel(client, ch, quota)
                    else:
                        log.debug("video_fetch: no fetch method for %s (platform=%s, has_key=%s)",
                                  ch["name"], platform, bool(YOUTUBE_API_KEY))
                        continue

                    # Handle 304 (not modified)
                    if status.get("_status_code") == 304:
                        with connect() as c, c.cursor() as cur304:
                            _update_channel_status(cur304, channel_id_db, status)
                            c.commit()
                        result["fetched"] += 1
                        continue

                    if status.get("last_failure_at"):
                        with connect() as fc, fc.cursor() as fc_cur:
                            _update_channel_status(fc_cur, channel_id_db, status)
                            fc.commit()
                        result["errors"] += 1
                        continue

                    # Insert videos
                    with connect() as ic, ic.cursor() as ic_cur:
                        inserted = _insert_video_items(
                            ic_cur, videos[:limit_per_channel], channel_id_db,
                            channel_platform=platform,
                        )
                        result["inserted"] += inserted
                        _update_channel_status(ic_cur, channel_id_db, status)
                        ic.commit()

                    result["fetched"] += 1
                    log.info("video channel %s: %d videos fetched, %d inserted",
                             ch["name"], len(videos), result["inserted"])

                finally:
                    if lease_token:
                        try:
                            with connect() as rc, rc.cursor() as rc_cur:
                                _release_lease(rc_cur, channel_id_db, lease_token)
                                rc.commit()
                        except Exception as rel_err:
                            log.warning("video lease release failed for id=%s: %s",
                                        channel_id_db, rel_err)

        return result

    # Run host groups in parallel
    with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_HOSTS) as executor:
        futures = {
            executor.submit(fetch_host_group, host, host_chs): host
            for host, host_chs in host_groups.items()
        }
        for future in as_completed(futures):
            host = futures[future]
            try:
                result = future.result()
                summary["channels_fetched"] += result["fetched"]
                summary["videos_inserted"] += result["inserted"]
                summary["errors"] += result["errors"]
            except Exception as e:
                log.error("video host group %s failed: %s", host, e)
                summary["errors"] += 1

    summary["quota_used"] = quota.used
    return summary


# ── Cleanup ──────────────────────────────────────────────────────────────

def cleanup_stale_leases() -> int:
    """Clear fetch_in_progress on any channel that was mid-fetch when a worker crashed."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            UPDATE video_channels
            SET fetch_in_progress = FALSE,
                lease_token = NULL,
                lease_expires_at = NULL
            WHERE fetch_in_progress = TRUE
              AND (lease_token IS NULL OR lease_expires_at < now())
            RETURNING id
        """)
        rows = list(cur.fetchall())
        conn.commit()
        n = len(rows)
        if n:
            log.warning("[video_cleanup] cleared %d stale fetch lease(s)", n)
        return n


# ── Entry point ──────────────────────────────────────────────────────────

def run(limit_per_channel: int = 50) -> dict:
    """Main entry point for video fetching."""
    cleanup_stale_leases()
    return fetch_all_videos(limit_per_channel=limit_per_channel)
