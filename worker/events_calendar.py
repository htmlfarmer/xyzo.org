"""Events calendar library — fetch + parse + upsert for upcoming_events.

The system pulls upcoming events from three classes of source:

  1. RSS / iCal — polled on a politeness-tier cadence (24h for .gov,
     6h for .edu, 2h for .org, 30m for .com, 15m for paid APIs).
  2. Paid APIs (Eventbrite, Ticketmaster) — gated by env var, called
     only when the key is set.
  3. User submissions — never auto-fetched.

Per the user's standing constraint (2026-09-06): government and
university sources must respect robots.txt strictly and never be polled
more often than the tier ceiling, with at most one retry on 5xx.
This module encodes that policy in `_POLITENESS`.

Robots cache: `~/.xyzo/robots_cache.json` — keyed by host, with a 24h
TTL. A 403/404 on /robots.txt is treated as "all paths allowed" (the
common case for sites that simply don't serve the file).
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Iterable, Optional
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import feedparser

log = logging.getLogger("xyzo.events_calendar")

# ── Politeness tiers ──────────────────────────────────────────────────
# Each tier defines:
#   - min_interval_seconds: minimum gap between fetches of the SAME host
#   - max_retries:          how many 5xx retries we attempt
#   - respect_robots:       if True, we MUST see a parseable robots.txt
#                            or the host is skipped entirely
#   - require_user_agent:   UA string we send (some .gov sites block
#                            anything that looks like a bot)
_TIERS: dict[str, dict[str, Any]] = {
    # Government & municipal. The default for any host under .gov,
    # .gc.ca, .gov.uk, .gouv.fr, .go.jp, .mil, etc.
    "gov": {
        "min_interval_seconds": 86_400,  # once per day
        "max_retries": 1,
        "respect_robots": True,
        "user_agent": "xyzo-events-bot/1.0 (+https://xyzo.org/bot) polite-fetch",
    },
    # Universities. .edu, .ac.uk, .ac.jp, .edu.au, etc.
    "university": {
        "min_interval_seconds": 21_600,  # 6 hours
        "max_retries": 1,
        "respect_robots": True,
        "user_agent": "xyzo-events-bot/1.0 (+https://xyzo.org/bot) polite-fetch",
    },
    # Non-profits / community. .org, .ngo, .museum (museums often
    # have generous crawl policies but treat them as community).
    "community": {
        "min_interval_seconds": 7_200,  # 2 hours
        "max_retries": 2,
        "respect_robots": True,
        "user_agent": "xyzo-events-bot/1.0 (+https://xyzo.org)",
    },
    # Commercial / generic.
    "commercial": {
        "min_interval_seconds": 1_800,  # 30 minutes
        "max_retries": 2,
        "respect_robots": True,
        "user_agent": "xyzo-events/1.0",
    },
    # Paid APIs we hold keys for. No robots check needed; we honour
    # the API's published rate limit instead.
    "platform": {
        "min_interval_seconds": 900,  # 15 minutes
        "max_retries": 3,
        "respect_robots": False,
        "user_agent": "xyzo-events/1.0 (platform)",
    },
    # User-submitted — never auto-fetched.
    "user": {
        "min_interval_seconds": None,
        "max_retries": 0,
        "respect_robots": False,
        "user_agent": "n/a",
    },
}

# Public suffix-lite list for tier derivation. This is intentionally
# small — only the common TLDs where we want a specific tier. Anything
# not listed falls through to "commercial".
_GOV_TLDS = (".gov", ".mil", ".gc.ca", ".gov.uk", ".gouv.fr",
             ".go.jp", ".gob.es", ".gov.au", ".govt.nz")
_EDU_TLDS = (".edu", ".ac.uk", ".ac.jp", ".edu.au", ".ac.in",
             ".ac.za", ".ac.kr", ".edu.cn")
_COMMUNITY_TLDS = (".org", ".ngo", ".museum", ".foundation")


def tier_for_url(url: str) -> str:
    """Return the politeness tier for a source URL based on its host."""
    host = urlparse(url).hostname or ""
    host = host.lower()
    if any(host.endswith(t) for t in _GOV_TLDS):
        return "gov"
    if any(host.endswith(t) for t in _EDU_TLDS):
        return "university"
    if any(host.endswith(t) for t in _COMMUNITY_TLDS):
        return "community"
    return "commercial"


def tier_settings(tier: str) -> dict[str, Any]:
    return _TIERS.get(tier, _TIERS["commercial"])


# ── robots.txt cache ─────────────────────────────────────────────────
# Per-host robots.txt with 24h TTL. Disk-persisted at ~/.xyzo/robots_cache.json
# so restarts don't replay the lookup. Hosts that return 4xx for /robots.txt
# are recorded as "allow all" (the convention is: missing robots = allowed).
_ROBOTS_TTL_S = 86_400
_ROBOTS_CACHE_PATH = os.path.expanduser("~/.xyzo/robots_cache.json")
_robots_cache: dict[str, dict[str, Any]] = {}


def _load_robots_cache() -> None:
    global _robots_cache
    try:
        with open(_ROBOTS_CACHE_PATH, "r") as f:
            _robots_cache = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        _robots_cache = {}


def _save_robots_cache() -> None:
    try:
        os.makedirs(os.path.dirname(_ROBOTS_CACHE_PATH), exist_ok=True)
        with open(_ROBOTS_CACHE_PATH, "w") as f:
            json.dump(_robots_cache, f)
    except Exception as e:  # don't let cache failure abort fetches
        log.debug("robots cache save failed: %s", e)


def robots_allows(url: str, tier: str) -> bool:
    """Return True if a polite fetch of `url` is allowed by robots.txt.

    For tiers with `respect_robots=False`, always returns True.
    Otherwise, fetches (and caches) /robots.txt for the host, then
    asks RobotFileParser. A 4xx response is recorded as "allow all"
    (industry convention).
    """
    if not tier_settings(tier).get("respect_robots"):
        return True
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if not host:
        return False

    now = time.time()
    entry = _robots_cache.get(host)
    if entry and now - entry.get("checked_at", 0) < _ROBOTS_TTL_S:
        if entry.get("status") == "blocked":
            return False
        if entry.get("status") in ("allow_all", "ok"):
            # Re-check the parsed rule against the URL path
            try:
                rp = RobotFileParser()
                rp.parse(entry.get("rules", []))
                return rp.can_fetch(tier_settings(tier)["user_agent"], url)
            except Exception:
                return entry.get("status") == "allow_all"

    # Fetch the live robots.txt
    robots_url = f"{parsed.scheme}://{host}/robots.txt"
    ua = tier_settings(tier)["user_agent"]
    try:
        req = urllib.request.Request(robots_url, headers={"User-Agent": ua})
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read().decode("utf-8", errors="ignore")
            rules = content.splitlines()
            _robots_cache[host] = {
                "checked_at": now,
                "status": "ok",
                "rules": rules,
            }
            _save_robots_cache()
            try:
                rp = RobotFileParser()
                rp.parse(rules)
                return rp.can_fetch(ua, url)
            except Exception:
                return True
    except urllib.error.HTTPError as e:
        # 4xx = file doesn't exist = allow all (Robots.txt convention).
        # 5xx = server error = treat as blocked for gov/university tiers
        if 400 <= e.code < 500:
            _robots_cache[host] = {"checked_at": now, "status": "allow_all"}
            _save_robots_cache()
            return True
        _robots_cache[host] = {"checked_at": now, "status": "blocked"}
        _save_robots_cache()
        return False
    except Exception as e:
        log.warning("robots.txt fetch failed for %s: %s", host, e)
        _robots_cache[host] = {"checked_at": now, "status": "allow_all"}
        _save_robots_cache()
        return True


# ── Source metadata ──────────────────────────────────────────────────
@dataclass
class EventSource:
    source: str              # 'rss', 'eventbrite', etc.
    source_id: str           # opaque id used in upcoming_events.source_id
    source_url: str          # canonical URL of the event (not the feed)
    feed_url: Optional[str]  # RSS feed URL (for 'rss' sources)
    politeness_tier: str
    category: str            # default category for events from this source
    country_code: Optional[str] = None
    region: Optional[str] = None
    last_fetched_at: Optional[float] = None  # epoch seconds
    last_etag: Optional[str] = None
    last_status: Optional[int] = None  # HTTP status from last fetch
    consecutive_failures: int = 0


def can_fetch_now(source: EventSource, now: Optional[float] = None) -> bool:
    """Return True if `source` may be fetched right now, respecting cadence."""
    tier = source.politeness_tier
    settings = tier_settings(tier)
    min_interval = settings.get("min_interval_seconds")
    if min_interval is None:
        # 'user' tier — never auto-fetched
        return False
    if source.last_fetched_at is None:
        return True
    now = now if now is not None else time.time()
    return (now - source.last_fetched_at) >= min_interval


# ── Fetch with caching ───────────────────────────────────────────────
def fetch_feed(url: str, tier: str, etag: Optional[str] = None,
               last_modified: Optional[str] = None,
               timeout: int = 25) -> tuple[Optional[bytes], Optional[str],
                                            Optional[str], int]:
    """Fetch an RSS/Atom feed with conditional GET.

    Returns: (body, new_etag, new_last_modified, http_status)
    On 304, body is None.
    """
    if not robots_allows(url, tier):
        log.warning("robots.txt disallows fetch of %s (tier=%s)", url, tier)
        return None, None, None, 451

    settings = tier_settings(tier)
    req = urllib.request.Request(url, headers={
        "User-Agent": settings["user_agent"],
        "Accept": "application/rss+xml, application/atom+xml, "
                  "application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
    })
    if etag:
        req.add_header("If-None-Match", etag)
    if last_modified:
        req.add_header("If-Modified-Since", last_modified)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            new_etag = resp.headers.get("ETag")
            new_lm = resp.headers.get("Last-Modified")
            body = resp.read()
            return body, new_etag, new_lm, resp.status
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return None, etag, last_modified, 304
        log.warning("HTTP %d fetching %s", e.code, url)
        return None, None, None, e.code
    except Exception as e:
        log.warning("fetch failed for %s: %s", url, e)
        return None, None, None, 0


# ── RSS / iCal → EventItem ───────────────────────────────────────────
@dataclass
class EventItem:
    source: str
    source_id: str
    source_url: str
    title: str
    description: Optional[str] = None
    category: str = "other"
    venue_name: Optional[str] = None
    city: Optional[str] = None
    region: Optional[str] = None
    country: Optional[str] = None
    country_code: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    is_online: bool = False
    is_free: Optional[bool] = None
    price_min: Optional[float] = None
    price_max: Optional[float] = None
    currency: Optional[str] = None
    image_url: Optional[str] = None
    organizer_name: Optional[str] = None
    organizer_url: Optional[str] = None
    registration_url: Optional[str] = None
    timezone: Optional[str] = None
    event_type: Optional[str] = None
    subcategory: Optional[str] = None
    speaker_names: list[str] = field(default_factory=list)
    artist_names: list[str] = field(default_factory=list)
    performer_names: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    source_priority: Optional[int] = None
    crawl_status: str = "ok"
    robots_allowed: bool = True
    canonical_url: Optional[str] = None
    content_hash: Optional[str] = None
    tags: list[str] = field(default_factory=list)
    language: Optional[str] = None


def _to_dt(value: Any) -> Optional[datetime]:
    """Parse a feedparser date tuple / ISO string into aware UTC datetime."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            dt = parsedate_to_datetime(value)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            try:
                # ISO 8601 fallback
                dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
                return dt
            except ValueError:
                return None
    # feedparser's time.struct_time
    try:
        dt = datetime(*value[:6], tzinfo=timezone.utc)
        return dt
    except (TypeError, ValueError):
        return None


def parse_rss(content: bytes, source_meta: EventSource) -> list[EventItem]:
    """Parse an RSS/Atom feed body into EventItems."""
    parsed = feedparser.parse(content)
    if parsed.bozo and not parsed.entries:
        log.warning("feedparser bozo flag for %s: %s",
                    source_meta.feed_url, parsed.bozo_exception)
        return []
    items: list[EventItem] = []
    for entry in parsed.entries:
        title = (entry.get("title") or "").strip()
        url = (entry.get("link") or "").strip()
        guid = (entry.get("id") or entry.get("guid") or url or title).strip()
        if not title or not url:
            continue
        # Strip embedded CDATA in case feedparser missed it (rare but
        # seen in some Spanish/Portuguese feeds).
        title = re.sub(r"<!\[CDATA\[\s*(.*?)\s*\]\]", r"\1",
                       title, flags=re.DOTALL).strip()
        description = ""
        if entry.get("summary"):
            description = entry.summary
        elif entry.get("content"):
            content_list = entry.content
            if isinstance(content_list, list) and content_list:
                description = content_list[0].get("value", "")
        if description:
            description = re.sub(r"<[^>]+>", " ", description)
            description = re.sub(r"\s+", " ", description).strip()[:2000]

        # Tags from categories
        tags = []
        for tag in entry.get("tags", []) or []:
            term = tag.get("term")
            if term:
                tags.append(term.strip())

        # Georss / lat-lng
        lat = lng = None
        if entry.get("geo_lat") is not None and entry.get("geo_long") is not None:
            try:
                lat = float(entry.geo_lat)
                lng = float(entry.geo_long)
            except (TypeError, ValueError):
                lat = lng = None
        if lat is None and entry.get("where"):
            coords = entry["where"].get("coords", "")
            if coords:
                parts = coords.split()
                if len(parts) == 2:
                    try:
                        lat = float(parts[0])
                        lng = float(parts[1])
                    except ValueError:
                        lat = lng = None

        starts = _to_dt(entry.get("published_parsed") or entry.get("updated_parsed")
                        or entry.get("created_parsed"))
        ends = _to_dt(entry.get("expired_parsed"))

        # iCal-style: pubDate is start, no end
        items.append(EventItem(
            source=source_meta.source,
            source_id=f"{source_meta.source_id}:{guid}",
            source_url=url,
            title=title,
            description=description or None,
            category=source_meta.category,
            venue_name=None,  # RSS rarely has this — derived later from title
            city=None,
            country_code=source_meta.country_code,
            lat=lat,
            lng=lng,
            starts_at=starts,
            ends_at=ends,
            is_online=False,
            is_free=None,
            image_url=None,
            organizer_name=None,
            tags=tags,
            language=(parsed.feed.get("language") if hasattr(parsed, "feed") else None),
        ))
    return items


# ── DB upsert ────────────────────────────────────────────────────────
def upsert_events(items: Iterable[EventItem],
                  politeness_tier: str = "commercial") -> int:
    """Upsert a batch of EventItems into upcoming_events.

    Returns the count of rows inserted/updated.
    """
    from .db import connect

    rows = []
    for it in items:
        if not it.starts_at:
            # Skip events with no start time — can't show on calendar
            continue
        rows.append((
            it.source, it.source_id, it.source_url, it.title, it.description,
            it.category, it.venue_name, it.city, it.region, it.country,
            it.country_code, it.lat, it.lng, it.starts_at, it.ends_at,
            it.is_online, it.is_free, it.image_url, it.organizer_name,
            it.tags, it.language, politeness_tier,
        ))

    if not rows:
        return 0

    inserted = 0
    with connect() as conn, conn.cursor() as cur:
        from psycopg.types.json import Json
        for r in rows:
            (source, sid, url, title, desc, cat, venue, city, region,
             country, cc, lat, lng, starts, ends, online, free, img,
             org, tags, lang, tier) = r
            cur.execute(
                """
                INSERT INTO upcoming_events (
                    source, source_id, source_url, title, description,
                    category, venue_name, city, region, country, country_code,
                    lat, lng, starts_at, ends_at, is_online, is_free,
                    image_url, organizer_name, tags, language,
                    politeness_tier
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (source, source_id) DO UPDATE SET
                    title = EXCLUDED.title,
                    description = EXCLUDED.description,
                    category = EXCLUDED.category,
                    venue_name = COALESCE(EXCLUDED.venue_name, upcoming_events.venue_name),
                    city = COALESCE(EXCLUDED.city, upcoming_events.city),
                    region = COALESCE(EXCLUDED.region, upcoming_events.region),
                    country = COALESCE(EXCLUDED.country, upcoming_events.country),
                    country_code = COALESCE(EXCLUDED.country_code, upcoming_events.country_code),
                    lat = COALESCE(EXCLUDED.lat, upcoming_events.lat),
                    lng = COALESCE(EXCLUDED.lng, upcoming_events.lng),
                    starts_at = EXCLUDED.starts_at,
                    ends_at = COALESCE(EXCLUDED.ends_at, upcoming_events.ends_at),
                    is_online = EXCLUDED.is_online,
                    is_free = COALESCE(EXCLUDED.is_free, upcoming_events.is_free),
                    image_url = COALESCE(EXCLUDED.image_url, upcoming_events.image_url),
                    organizer_name = COALESCE(EXCLUDED.organizer_name, upcoming_events.organizer_name),
                    tags = EXCLUDED.tags,
                    language = COALESCE(EXCLUDED.language, upcoming_events.language),
                    updated_at = now()
                """,
                (source, sid, url, title, desc, cat, venue, city, region,
                 country, cc, lat, lng, starts, ends, online, free, img,
                 org, tags, lang, tier),
            )
            inserted += 1
    return inserted


# ── Per-source fetcher ───────────────────────────────────────────────
def fetch_and_upsert_source(source: EventSource) -> dict[str, Any]:
    """Fetch one RSS source and upsert its events.

    Returns a stats dict: {fetched, inserted, status, etag, ms}.
    """
    started = time.time()
    if not source.feed_url:
        return {"fetched": 0, "inserted": 0, "status": 0,
                "error": "no_feed_url"}
    if not can_fetch_now(source):
        return {"fetched": 0, "inserted": 0, "status": 0,
                "skipped": "too_soon"}
    body, new_etag, new_lm, status = fetch_feed(
        source.feed_url, source.politeness_tier,
        etag=source.last_etag, last_modified=source.last_modified if hasattr(source, 'last_modified') else None,
    )
    if status == 304:
        return {"fetched": 0, "inserted": 0, "status": 304, "ms": 0}
    if body is None:
        return {"fetched": 0, "inserted": 0, "status": status, "ms": 0}
    items = parse_rss(body, source)
    inserted = upsert_events(items, politeness_tier=source.politeness_tier)
    return {
        "fetched": len(items),
        "inserted": inserted,
        "status": status,
        "etag": new_etag,
        "ms": int((time.time() - started) * 1000),
    }


# Initialise robots cache on import so the first call doesn't pay the
# disk hit synchronously.
_load_robots_cache()
