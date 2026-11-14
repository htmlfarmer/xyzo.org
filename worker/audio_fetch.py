"""Audio fetcher — podcast RSS/Atom feed parser for XYZO.

Parses podcast RSS feeds (with iTunes namespace support) and inserts
episodes into audio_episodes. Shows are upserted into audio_shows.

Podcast RSS feeds are a superset of standard RSS:
- <itunes:summary>, <itunes:duration>, <itunes:image>
- <itunes:explicit>, <itunes:author>, <itunes:category>
- <enclosure> with audio MIME types
- <atom:link rel="self"> for feed URL
- <itunes:category> hierarchy

This module reuses the existing robots.txt cache, lease system,
and host-grouping parallelism from worker/fetch.py.

Key differences from article fetch:
  - Episodes are inserted into audio_episodes (not news_articles)
  - Shows are upserted into audio_shows (not news_sources)
  - No word_freq extraction (audio content is in audio, not text)
  - Duration extraction from <itunes:duration>
  - Audio URL extraction from <enclosure>
  - Host/guest extraction from <itunes:author> and <podcast:person>
"""
import json
import logging
import re
import calendar
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import feedparser
import httpx

from .db import connect
from .robots import RobotsCache, tier_for_url

log = logging.getLogger("xyzo.audio_fetch")

AUDIO_FEEDS_FILE = Path(__file__).parent / "audio_sources.json"

# Reuse fetch.py constants
DEFAULT_UA = "XyzoFetcher/0.1 (+https://xyzo.org/bot; contact@xyzo.org)"
POLITE_UA = "xyzo-events-bot/1.0 (+https://xyzo.org/bot) polite-fetch"
MIN_FETCH_INTERVAL_S = float(__import__("os").environ.get("NEWSIUM_FETCH_INTERVAL", "1.0"))
MAX_CONCURRENT_HOSTS = int(__import__("os").environ.get("NEWSIUM_FETCH_CONCURRENT", "8"))
HTTPX_MAX_CONNECTIONS = int(__import__("os").environ.get("NEWSIUM_HTTPX_MAX_CONNECTIONS", "4"))
HTTPX_MAX_KEEPALIVE = int(__import__("os").environ.get("NEWSIUM_HTTPX_MAX_KEEPALIVE", "2"))
_HTTPX_LIMITS = httpx.Limits(
    max_connections=HTTPX_MAX_CONNECTIONS,
    max_keepalive_connections=HTTPX_MAX_KEEPALIVE,
)
REQUEST_TIMEOUT = 20.0
RECENT_SUCCESS_WINDOW_S = 300
LEASE_TTL_S = 300
# Hard cap on podcast-feed body size — same 8 MB bound fetch.py enforces on
# RSS/JSON streams (this module runs in the same 1G-MemoryMax fleet).
# Oversized bodies are truncated at the cap; feedparser then parses what
# fit (feeds are newest-first, so the dropped tail is the oldest episodes —
# exactly what limit_per_show would discard anyway).
MAX_FEED_BYTES = int(
    __import__("os").environ.get("XYZO_FETCH_MAX_FEED_BYTES")
    or __import__("os").environ.get("NEWSIUM_FETCH_MAX_FEED_BYTES")
    or 8000000
)


def user_agent_for(url: str) -> str:
    tier = tier_for_url(url)
    if tier in ("gov", "university"):
        return POLITE_UA
    return DEFAULT_UA


def load_audio_sources() -> list[dict]:
    """Load audio sources from audio_sources.json."""
    if not AUDIO_FEEDS_FILE.exists():
        return []
    with AUDIO_FEEDS_FILE.open() as f:
        data = json.load(f)
    return [s for s in data.get("sources", []) if s.get("enabled", True)]


def seed_audio_shows(sources: list[dict] | None = None) -> int:
    """Upsert all audio sources into audio_shows."""
    sources = sources or load_audio_sources()
    rows = []
    for s in sources:
        rows.append((
            s["name"],
            s["feed_url"],
            s.get("homepage_url"),
            s.get("description", "")[:2000],
            s.get("author"),
            s.get("author_url"),
            s.get("image_url"),
            s.get("language"),
            s.get("country"),
            s.get("region", "global"),
            s.get("categories", []),
            s.get("license"),
            s.get("attribution_required", False),
        ))
    with connect() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO audio_shows (
                title, feed_url, homepage_url, description, author,
                author_url, image_url, language, country, region,
                categories, license, attribution_required
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (feed_url) DO UPDATE SET
                title = EXCLUDED.title,
                homepage_url = EXCLUDED.homepage_url,
                description = EXCLUDED.description,
                author = EXCLUDED.author,
                author_url = EXCLUDED.author_url,
                image_url = EXCLUDED.image_url,
                language = EXCLUDED.language,
                country = EXCLUDED.country,
                region = EXCLUDED.region,
                categories = EXCLUDED.categories,
                license = EXCLUDED.license,
                attribution_required = EXCLUDED.attribution_required
            """,
            rows,
        )
    return len(rows)


def _parse_duration(raw: str | None) -> int | None:
    """Parse duration from various formats:
    - HH:MM:SS or MM:SS
    - seconds as integer string
    - ISO 8601 duration (PT1H2M3S)
    """
    if not raw:
        return None
    raw = raw.strip()

    # ISO 8601: PT1H2M3S, PT30M, PT45S
    m = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', raw, re.IGNORECASE)
    if m:
        h, mi, s = (int(x) if x else 0 for x in m.groups())
        return h * 3600 + mi * 60 + s

    # HH:MM:SS or MM:SS
    parts = raw.split(':')
    if len(parts) == 3:
        try:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        except ValueError:
            pass
    elif len(parts) == 2:
        try:
            return int(parts[0]) * 60 + int(parts[1])
        except ValueError:
            pass

    # Plain seconds
    try:
        return int(raw)
    except ValueError:
        pass

    return None


def _extract_persons(entry) -> tuple[list[str], list[str]]:
    """Extract hosts and guests from feedparser entry.

    Checks multiple sources:
    - itunes:author
    - podcast:person
    - author_detail
    - itunes:owner
    """
    hosts = []
    guests = []

    # iTunes author
    author = entry.get('author')
    if author:
        hosts.append(author.strip())

    # iTunes owner
    owner = entry.get('itunes_owner') or {}
    if isinstance(owner, dict):
        name = owner.get('itunes_name')
        if name and name.strip() not in hosts:
            hosts.append(name.strip())

    # podcast:person (Podcast 2.0)
    persons = entry.get('podcast_person') or []
    if not isinstance(persons, list):
        persons = [persons]
    for p in persons:
        if isinstance(p, dict):
            name = p.get('name') or p.get('value', '')
            role = p.get('role', 'guest')
        elif isinstance(p, str):
            name = p
            role = 'guest'
        else:
            continue
        name = name.strip()
        if not name:
            continue
        if role in ('host', 'presenter'):
            if name not in hosts:
                hosts.append(name)
        else:
            if name not in guests:
                guests.append(name)

    return hosts, guests


def _strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", " ", s or "").strip()


def parse_podcast_feed(content: bytes) -> tuple[dict, list[dict]]:
    """Parse a podcast RSS feed.

    Returns (show_metadata, episodes) where show_metadata is a dict
    of show-level fields and episodes is a list of episode dicts.
    """
    parsed = feedparser.parse(content)

    # ── Show-level metadata ──
    feed = parsed.get('feed', {})
    show_meta = {
        'title': (feed.get('title') or '').strip()[:500],
        'description': (feed.get('description') or feed.get('itunes_summary') or '').strip()[:2000],
        'author': (feed.get('author') or feed.get('itunes_author') or '').strip()[:200],
        'author_url': feed.get('link'),
        'image_url': (
            (feed.get('image') or {}).get('href')
            or feed.get('itunes_image', {})
            and (feed.get('itunes_image') or {}).get('href')
            or None
        ),
        'language': (feed.get('language') or '').strip()[:10],
        'categories': [
            c.get('term', '') for c in feed.get('tags', [])
            if c.get('term')
        ],
    }

    # ── Episodes ──
    episodes = []
    for entry in parsed.entries:
        url = (entry.get('link') or entry.get('id') or '').strip()
        if not url:
            continue

        guid = entry.get('id') if entry.get('id') and entry.get('id') != url else None

        # Audio URL from enclosure
        audio_url = None
        audio_type = None
        enclosures = entry.get('enclosures') or []
        for enc in enclosures:
            if isinstance(enc, dict):
                href = enc.get('href') or enc.get('url')
                type_ = (enc.get('type') or '').lower()
                if href and type_.startswith('audio/'):
                    audio_url = href
                    audio_type = type_
                    break
                elif href and not audio_url:
                    audio_url = href
                    audio_type = type_

        # Duration
        duration = _parse_duration(
            entry.get('itunes_duration')
            or entry.get('duration')
        )

        # Published date
        published_at = None
        for key in ('published_parsed', 'updated_parsed', 'created_parsed'):
            t = entry.get(key)
            if t:
                try:
                    # feedparser's *_parsed is a UTC struct — timegm(), NOT
                    # mktime() (mktime assumes local TZ and skewed every RSS
                    # timestamp +7/8h on this LA-hosted server — FIX_NOTES 1.1,
                    # same bug already fixed in fetch.py:183).
                    published_at = datetime.fromtimestamp(calendar.timegm(t), tz=timezone.utc)
                    break
                except (OverflowError, ValueError, OSError):
                    continue
        if not published_at:
            raw = entry.get('published') or entry.get('updated')
            if raw:
                from email.utils import parsedate_to_datetime
                try:
                    published_at = parsedate_to_datetime(raw)
                except (ValueError, TypeError):
                    pass

        # Image (episode-level)
        image_url = None
        itunes_image = entry.get('itunes_image')
        if isinstance(itunes_image, dict):
            image_url = itunes_image.get('href')
        if not image_url:
            media_content = entry.get('media_content') or []
            for media in media_content:
                if isinstance(media, dict) and media.get('medium') == 'image':
                    image_url = media.get('url')
                    break

        # Description
        description = ''
        for key in ('itunes_summary', 'summary', 'description'):
            val = entry.get(key)
            if isinstance(val, str) and val.strip():
                description = val.strip()
                break
            elif isinstance(val, list):
                for item in val:
                    if isinstance(item, dict) and item.get('value'):
                        description = item['value'].strip()
                        break
                if description:
                    break
        description = _strip_html(description)[:4000]

        # People
        hosts, guests = _extract_persons(entry)

        # Transcript
        transcript_available = False
        transcript_url = None
        links = entry.get('links') or []
        for link in links:
            if isinstance(link, dict) and link.get('rel') == 'transcript':
                transcript_available = True
                transcript_url = link.get('href')
                break

        # Explicit flag
        explicit = entry.get('itunes_explicit')
        if isinstance(explicit, bool):
            pass  # fine
        elif isinstance(explicit, str):
            explicit = explicit.lower() in ('true', 'yes', '1')

        episodes.append({
            'url': url,
            'guid': guid,
            'title': (entry.get('title') or '').strip()[:500],
            'description': description,
            'summary': description[:500] if description else '',
            'published_at': published_at,
            'duration_seconds': duration,
            'audio_url': audio_url,
            'audio_type': audio_type,
            'image_url': image_url,
            'transcript_available': transcript_available,
            'transcript_url': transcript_url,
            'hosts': hosts,
            'guests': guests,
        })

    return show_meta, episodes


def upsert_show(cur, show_meta: dict, feed_url: str) -> int:
    """Upsert a show and return its id."""
    cur.execute(
        """
        INSERT INTO audio_shows (title, feed_url, description, author, author_url,
                                 image_url, language, categories)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (feed_url) DO UPDATE SET
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            author = EXCLUDED.author,
            author_url = EXCLUDED.author_url,
            image_url = EXCLUDED.image_url,
            language = EXCLUDED.language,
            categories = EXCLUDED.categories
        RETURNING id
        """,
        (
            show_meta['title'], feed_url, show_meta['description'],
            show_meta['author'], show_meta['author_url'],
            show_meta['image_url'], show_meta['language'],
            show_meta['categories'],
        ),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def insert_episodes(cur, episodes: list[dict], show_id: int) -> int:
    """Insert new episodes; returns count of newly inserted rows."""
    if not episodes:
        return 0

    rows = []
    for ep in episodes:
        rows.append((
            show_id, ep['url'], ep.get('guid'), ep['title'],
            ep['description'], ep['summary'], ep['published_at'],
            ep['duration_seconds'], ep['audio_url'], ep.get('audio_type'),
            ep.get('image_url'), ep.get('transcript_available', False),
            ep.get('transcript_url'), ep.get('hosts', []), ep.get('guests', []),
        ))

    cur.executemany(
        """
        INSERT INTO audio_episodes (
            show_id, url, guid, title, description, summary,
            published_at, duration_seconds, audio_url, audio_type,
            image_url, transcript_available, transcript_url,
            hosts, guests
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (url) DO NOTHING
        """,
        rows,
    )
    inserted_count = cur.rowcount

    # Update show episode count
    if inserted_count > 0:
        cur.execute(
            "UPDATE audio_shows SET episode_count = (SELECT COUNT(*) FROM audio_episodes WHERE show_id = %s) WHERE id = %s",
            (show_id, show_id),
        )

    return inserted_count


# ── Lease system (mirrors fetch.py for audio_shows) ─────────────────────

AUDIO_CLAIM_SQL = """
    WITH claimable AS (
        SELECT id, feed_url, title
        FROM audio_shows
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
        UPDATE audio_shows
        SET fetch_in_progress = TRUE,
            lease_token = gen_random_uuid()::text,
            lease_expires_at = now() + INTERVAL '{ttl} seconds',
            last_success_at = now()
        FROM claimable
        WHERE audio_shows.id = claimable.id
        RETURNING audio_shows.id, audio_shows.feed_url, audio_shows.title,
                  audio_shows.etag, audio_shows.last_modified,
                  audio_shows.lease_token
    )
    SELECT id, feed_url, title, etag, last_modified, lease_token
    FROM claimed
    ORDER BY id
""".format(ttl=LEASE_TTL_S)


def _claim_shows_due(cur) -> list[dict]:
    """Atomically claim all currently-due audio shows for fetch."""
    # Ensure lease columns exist (idempotent)
    cur.execute("""
        ALTER TABLE audio_shows ADD COLUMN IF NOT EXISTS fetch_in_progress BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE audio_shows ADD COLUMN IF NOT EXISTS lease_token TEXT;
        ALTER TABLE audio_shows ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
    """)
    cur.execute(AUDIO_CLAIM_SQL)
    return cur.fetchall()


def _release_lease(cur, show_id: int, lease_token: str) -> bool:
    """Release the lease on a show; CAS-guarded by lease_token."""
    cur.execute(
        "UPDATE audio_shows SET fetch_in_progress = FALSE, "
        "lease_token = NULL, lease_expires_at = NULL "
        "WHERE id = %s AND lease_token = %s RETURNING id",
        (show_id, lease_token),
    )
    return cur.fetchone() is not None


def update_show_status(cur, show_id: int, status: dict) -> None:
    """Update show-level status after a fetch attempt."""
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
    if not sets:
        return
    args.append(show_id)
    cur.execute(
        f"UPDATE audio_shows SET {', '.join(sets)} WHERE id = %s",
        args,
    )


def fetch_one_show(client: httpx.Client, show: dict) -> tuple[dict, list[dict], dict]:
    """Fetch and parse a single podcast feed.

    Returns (show_meta, episodes, status_update).
    """
    url = show["feed_url"]
    headers = {"User-Agent": user_agent_for(url)}
    if show.get("etag"):
        headers["If-None-Match"] = show["etag"]
    if show.get("last_modified"):
        headers["If-Modified-Since"] = show["last_modified"]

    try:
        # Bounded streaming fetch (MAX_FEED_BYTES cap). NOTE: max_redirects
        # lives on the Client constructor, NOT here — httpx's stream()
        # doesn't accept it (passing it per-request zeroed RSS ingestion
        # for 9 hours on 2026-09-26; test_fetch_smart_policy pins this).
        with client.stream("GET", url, headers=headers,
                           timeout=REQUEST_TIMEOUT) as resp:
            status = resp.status_code
            etag = resp.headers.get("etag")
            last_modified = resp.headers.get("last-modified")

            if status == 304:
                return {}, [], {"_status_code": 304}

            if status >= 400:
                log.warning("audio fetch %s: HTTP %s", url, status)
                return {}, [], {"_failed": True, "_status_code": status}

            chunks: list[bytes] = []
            total = 0
            for chunk in resp.iter_bytes(65536):
                total += len(chunk)
                if total > MAX_FEED_BYTES:
                    log.warning("audio feed %s exceeded %d bytes — parsing truncated prefix",
                                url, MAX_FEED_BYTES)
                    break
                chunks.append(chunk)
            content = b"".join(chunks)
    except httpx.HTTPError as exc:
        log.warning("audio fetch failed for %s: %s", url, exc)
        return {}, [], {"_failed": True, "_status_code": None}

    show_meta, episodes = parse_podcast_feed(content)
    return show_meta, episodes, {
        "etag": etag,
        "last_modified": last_modified,
        "_status_code": status,
    }


def fetch_all_audio(limit_per_show: int = 30) -> dict:
    """Fetch all enabled audio sources concurrently by host group.

    Groups shows by host, then fetches up to MAX_CONCURRENT_HOSTS
    host groups in parallel. Within each host, requests are sequential.
    """
    summary = {
        "shows_fetched": 0,
        "episodes_inserted": 0,
        "errors": 0,
        "shows_skipped_recent": 0,
    }

    with connect() as conn, conn.cursor() as cur:
        shows = _claim_shows_due(cur)

    # Skip recently successful
    fresh = []
    for show in shows:
        # No seconds_since_success column on audio_shows — just fetch everything due
        fresh.append(show)

    log.info("audio_fetch: %d shows to fetch", len(fresh))

    # Group by host
    host_groups: dict[str, list[dict]] = {}
    for show in fresh:
        host = urlparse(show["feed_url"]).netloc.lower()
        if host not in host_groups:
            host_groups[host] = []
        host_groups[host].append(show)

    def fetch_host_group(host: str, host_shows: list[dict]) -> dict:
        result = {"fetched": 0, "inserted": 0, "errors": 0}
        robots = RobotsCache(ua=user_agent_for(host_shows[0]["feed_url"]))
        last_at = 0.0

        with httpx.Client(timeout=REQUEST_TIMEOUT, limits=_HTTPX_LIMITS,
                          follow_redirects=True, max_redirects=6) as client:
            for show in host_shows:
                show_id = show["id"]
                lease_token = show.get("lease_token")

                try:
                    # robots.txt check
                    verdict = robots.is_allowed(show["feed_url"])
                    if not verdict.allowed:
                        log.info("audio robots: skip %s", show["feed_url"])
                        continue

                    # Throttle
                    interval = max(verdict.crawl_delay_s or 0, MIN_FETCH_INTERVAL_S)
                    elapsed = time.time() - last_at
                    if elapsed < interval:
                        time.sleep(interval - elapsed)
                    last_at = time.time()

                    # Fetch
                    show_meta, episodes, status = fetch_one_show(client, show)

                    if status.get("_status_code") == 304:
                        with connect() as c, c.cursor() as cur304:
                            update_show_status(cur304, show_id, status)
                            c.commit()
                        result["fetched"] += 1
                        continue

                    if status.get("_failed"):
                        with connect() as fail_conn, fail_conn.cursor() as fail_cur:
                            update_show_status(fail_cur, show_id, {"last_failure_at": True})
                            fail_conn.commit()
                        result["errors"] += 1
                        continue

                    # Insert episodes
                    with connect() as ins_conn, ins_conn.cursor() as ins_cur:
                        sid = upsert_show(ins_cur, show_meta, show["feed_url"])
                        if sid:
                            inserted = insert_episodes(ins_cur, episodes[:limit_per_show], sid)
                            result["inserted"] += inserted
                            update_show_status(ins_cur, show_id, status)
                            ins_conn.commit()

                    result["fetched"] += 1
                    log.info("audio show %s: %d episodes", show["title"], result["inserted"])

                finally:
                    if lease_token:
                        try:
                            with connect() as rel_conn, rel_conn.cursor() as rel_cur:
                                _release_lease(rel_cur, show_id, lease_token)
                                rel_conn.commit()
                        except Exception as rel_err:
                            log.warning("audio lease release failed for show id=%s: %s", show_id, rel_err)

        return result

    # Run host groups in parallel
    with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_HOSTS) as executor:
        futures = {
            executor.submit(fetch_host_group, host, host_shows): host
            for host, host_shows in host_groups.items()
        }
        for future in as_completed(futures):
            host = futures[future]
            try:
                result = future.result()
                summary["shows_fetched"] += result["fetched"]
                summary["episodes_inserted"] += result["inserted"]
                summary["errors"] += result["errors"]
            except Exception as e:
                log.error("audio host group %s failed: %s", host, e)
                summary["errors"] += 1

    return summary


def cleanup_stale_leases() -> int:
    """Clear fetch_in_progress on any audio show that was mid-fetch when a worker crashed."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            ALTER TABLE audio_shows ADD COLUMN IF NOT EXISTS fetch_in_progress BOOLEAN NOT NULL DEFAULT FALSE;
            ALTER TABLE audio_shows ADD COLUMN IF NOT EXISTS lease_token TEXT;
            ALTER TABLE audio_shows ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
        """)
        conn.commit()
        cur.execute("""
            UPDATE audio_shows
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
            log.warning("[audio_cleanup] cleared %d stale fetch lease(s)", n)
        return n


def run(limit_per_show: int = 30) -> dict:
    """Main entry point for audio fetching."""
    cleanup_stale_leases()
    return fetch_all_audio(limit_per_show=limit_per_show)
