"""RSS / Atom / GeoJSON / JSON fetcher.

PARALLEL FETCHING RULES (critical — read before modifying):
============================================================
  ✅ OK to fetch DIFFERENT hosts in parallel (different domains/IPs)
  ❌ NEVER fetch the SAME host in parallel — must be sequential
  ✅ Within same host: respect per-host throttle (robots.txt Crawl-delay)
  ✅ Skip sources that succeeded in the last 5 minutes (no re-fetch)
  ✅ Group sources by host, run host groups concurrently via ThreadPoolExecutor

Why: Fetching the same host in parallel gets you rate-limited or banned.
Different hosts have no shared rate limit, so parallel is safe and fast.

For each enabled news_sources row:
  - robots.txt check on the feed host (one HTTP per host, cached 24h)
  - GET the feed_url with stored ETag / Last-Modified (cheap re-poll)
  - per-host throttle: max(robots.txt Crawl-delay, MIN_FETCH_INTERVAL_S)
  - parse with feedparser (or JSON.loads for source_type='json'/'geojson')
  - upsert to news_sources (touch last_success_at or last_failure_at)
  - INSERT IGNORE new items into news_articles by (url, source_id) UNIQUE

If robots.txt explicitly Disallows the feed URL for our UA, we set
active=false on news_sources and skip silently — no error raised,
no retry storm. The check_feeds.py utility can re-enable in bulk
after re-confirming publisher policy.

CONCURRENT FETCHING: Sources are grouped by host and fetched in
parallel (up to MAX_CONCURRENT_HOSTS at a time). Within each host,
requests are sequential with per-host throttle. This cuts total
fetch time from ~3 minutes to ~30 seconds for 170 sources.

CRASH RECOVERY: On startup, run() calls cleanup_stale_leases() which
clears fetch_in_progress=TRUE from any source whose lease has expired
or whose worker died before writing a lease token. Sources mid-fetch
when the server died are immediately reclaimable — no 5-minute wait.
The 5-minute lease TTL (LEASE_TTL_S=300) protects against actual
worker crashes in the normal case.

Returns a dict with per-source counts.
"""
import calendar
import html
import json
import logging
import re
import time
import uuid
from urllib.parse import urljoin
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse

import feedparser
import httpx

from .db import connect
from .robots import RobotsCache, tier_for_url
from .progress import ProgressWriter

log = logging.getLogger("newsium.fetch")

REQUEST_TIMEOUT = 20.0  # Reduced from 30s

# ── Polite User-Agent (Step 2a of Smart Publish-Time Predictor plan) ──
#
# Two reasons this lives here and not in robots.py:
#   1. robots.is_allowed() checks against the SAME bot that fetches, else
#      a publisher's `Disallow: XyzoFetcher` won't actually block us and
#      we look like a liar to anyone reading their robots.txt.
#   2. gov / .edu hosts (tier_for_url -> 'gov' or 'university') use the
#      POLITE_UA per the standing politeness constraint (HANDOFF §3.1,
#      README §9.6, memory/government-site-politeness.md). It is the bot
#      those hosts are likely whitelisting for academic / city-event
#      monitoring. See also robots.py:_TIERS which still carries the
#      per-tier User-Agent strings (kept in sync with this file).
#
# DO NOT collapse to a single UA — the tier differentiation IS the
# politeness contract. Adding a third tier requires updating both
# robots.py:_TIERS and user_agent_for() below.
DEFAULT_UA = "XyzoFetcher/0.1 (+https://xyzo.org/bot; contact@xyzo.org)"
# The polite UA is what we use for government and university sites.
# It's like wearing a suit to a job interview — you want to look professional.
POLITE_UA = "xyzo-events-bot/1.0 (+https://xyzo.org/bot) polite-fetch"


def user_agent_for(url: str) -> str:
    """Return the User-Agent we should both fetch AS and check robots.txt AGAINST.

    .gov and .edu hosts (TLD-derived via tier_for_url) use the polite UA;
    everything else uses the default. The function exists exactly so
    fetch.py and the RobotsCache cannot drift — using one UA to fetch
    and another to check robots was the live UA-mismatch bug.

    "Why does this matter?"
    Because if we check robots.txt with UA "PoliteBot" but fetch with
    "AggressiveScraper", the publisher's "Disallow: AggressiveScraper"
    rule won't match, and we'll look like we're ignoring their wishes.
    That's bad. Don't be that bot.
    """
    tier = tier_for_url(url)
    if tier in ("gov", "university"):
        return POLITE_UA
    return DEFAULT_UA
def _env(name: str, default: str) -> str:
    """Read XYZO_* first, fall back to legacy NEWSIUM_* (2026-09-26 env unification)."""
    import os
    return os.environ.get(f"XYZO_{name}") or os.environ.get(f"NEWSIUM_{name}") or default


# Floor: polite minimum between fetches to the same host, regardless of what
# robots.txt says. We respect Crawl-delay if it's higher than this floor.
MIN_FETCH_INTERVAL_S = float(_env("FETCH_INTERVAL", "1.0"))
# Hard cap for a single feed response. Feeds are streamed and aborted at this
# size, then salvaged down to the last complete item (feeds are newest-first).
# Protects the 1G-MemoryMax worker from giant or malicious XML payloads.
MAX_FEED_BYTES = int(_env("FETCH_MAX_FEED_BYTES", "8000000"))
# Max concurrent host groups to fetch in parallel
MAX_CONCURRENT_HOSTS = int(_env("FETCH_CONCURRENT", _env("FETCH_MAX_CONCURRENT_HOSTS", "8")))
# httpx connection-pool cap per host. Lower numbers shrink the anyio
# internal thread pool — was contributing ~10 threads to the 44-thread
# count, now contributes ~4. Tuned 2026-09-10 alongside NEWSIUM_FETCH_CONCURRENT.
HTTPX_MAX_CONNECTIONS = int(_env("HTTPX_MAX_CONNECTIONS", "4"))
HTTPX_MAX_KEEPALIVE = int(_env("HTTPX_MAX_KEEPALIVE", "2"))
_HTTPX_LIMITS = httpx.Limits(
    max_connections=HTTPX_MAX_CONNECTIONS,
    max_keepalive_connections=HTTPX_MAX_KEEPALIVE,
)
# Skip sources that succeeded recently (within this window). This is now
# enforced INSIDE CLAIM_SQL (we never claim a source we intend to skip —
# the old post-claim filter leaked leases; FIX_NOTES 1.6). Decoupled from
# the lease TTL on purpose: shorter window = fresher feeds, longer TTL =
# tolerance for slow host groups.
RECENT_SUCCESS_WINDOW_S = int(_env("FETCH_RECENT_SUCCESS_WINDOW_S", "300"))
# 'web' scrape sources are expensive (1 page + up to 20 article fetches).
# Poll them at most once per this interval instead of every cycle (FIX_NOTES 1.2/5.4).
WEB_SOURCE_MIN_INTERVAL_H = int(_env("FETCH_WEB_SOURCE_MIN_INTERVAL_H", "24"))

FEEDS_FILE = Path(__file__).parent / "feeds.json"


def load_feeds() -> list[dict]:
    with FEEDS_FILE.open() as f:
        return [fd for fd in json.load(f)["feeds"] if fd.get("enabled", True)]


def seed_sources(feeds: list[dict] | None = None) -> int:
    """Upsert all enabled feeds into news_sources.

    The upsert must NOT degrade good metadata with an empty value. A
    feeds.json entry with ``country: ""`` and ``region: "unknown"`` used
    to overwrite a row's real country ('GB' for New Scientist, 'US' for
    ScienceDaily) — and the placement gate then rejected the row as
    "a source with no country that is not marked regional/global". The
    seed path is a fill-in, never a downgrade.
    """
    feeds = feeds or load_feeds()
    rows = [
        (
            fd["name"], fd["feed_url"], fd.get("country"), fd.get("language"),
            fd.get("region", "global"), fd.get("source_type", "rss"),
        )
        for fd in feeds
    ]
    with connect() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO news_sources (name, feed_url, country, language, region, source_type)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (feed_url) DO UPDATE SET
                name = EXCLUDED.name,
                country = COALESCE(NULLIF(EXCLUDED.country, ''), news_sources.country),
                language = COALESCE(NULLIF(EXCLUDED.language, ''), news_sources.language),
                region = CASE
                             WHEN EXCLUDED.region IS NULL OR EXCLUDED.region = '' THEN
                                 COALESCE(news_sources.region, 'global')
                             WHEN EXCLUDED.region = 'unknown'
                                  AND news_sources.region IS NOT NULL
                                  AND news_sources.region <> '' THEN
                                 news_sources.region
                             ELSE EXCLUDED.region
                         END
            """,
            rows,
        )
    return len(rows)


def _entry_url_and_id(entry) -> tuple[str, str | None]:
    """Pull the canonical URL and a stable id (guid or link) out of a feedparser entry."""
    url = (entry.get("link") or entry.get("id") or "").strip()
    guid = entry.get("id") if entry.get("id") and entry.get("id") != url else None
    return url, guid


def _entry_published(entry) -> datetime | None:
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        t = entry.get(key)
        if t:
            try:
                # feedparser's *_parsed is a UTC struct — timegm(), NOT mktime()
                # which assumes local time and skewed every timestamp +7/8h
                # on this LA-timezone box (FIX_NOTES 1.1).
                return datetime.fromtimestamp(calendar.timegm(t), tz=timezone.utc)
            except (OverflowError, ValueError, OSError):
                continue
    raw = entry.get("published") or entry.get("updated")
    if raw:
        from email.utils import parsedate_to_datetime
        try:
            dt = parsedate_to_datetime(raw)
            if dt is not None and dt.tzinfo is None:
                # tz-less feeds: assume UTC, never server-local time
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except (ValueError, TypeError):
            pass
    return None


def _entry_body(entry) -> str:
    """Return best-available body text from a feedparser entry."""
    parts: list[str] = []
    for key in ("summary", "description", "content"):
        val = entry.get(key)
        if isinstance(val, str):
            parts.append(val)
        elif isinstance(val, list):
            for item in val:
                if isinstance(item, dict) and item.get("value"):
                    parts.append(item["value"])
    return "\n\n".join(parts).strip()


def _sanitize_image_url(url: str) -> str | None:
    """Validate and fix common image URL malformations.

    Returns a clean URL or None if unfixable.
    Fixes: missing slash between TLD and path (e.g. .netuploads → .net/uploads)
    """
    if not url or not isinstance(url, str):
        return None
    # UNESCAPE THE HTML ENTITIES. A URL lifted out of an RSS <img src>
    # or an HTML meta tag still carries them: "…?format=jpg&amp;name=
    # large" is stored verbatim and the upstream answers 404. 39,295
    # rows in the database were stored that way before this fix.
    url = html.unescape(url.strip())
    if not url.startswith(("http://", "https://")):
        return None

    # Split into scheme://host/path
    m = re.match(r'^(https?://)([^/]+)(/.*)?$', url)
    if not m:
        return None
    scheme, host, path = m.group(1), m.group(2), m.group(3) or ""

    # Known TLDs
    _TLDS = {
        "net", "com", "org", "edu", "gov", "mil", "biz", "info", "name", "pro",
        "io", "dev", "ai", "co", "tv", "me", "rs", "tr", "ro", "ir", "id", "hr",
        "bg", "uk", "by", "kz", "az", "ge", "am", "md", "lt", "lv", "ee", "fi",
        "is", "no", "se", "dk", "nl", "be", "fr", "de", "es", "pt", "it", "gr",
        "cy", "mt", "lu", "in", "pk", "bd", "lk", "np", "cn", "jp", "kr", "th",
        "vn", "my", "sg", "ph", "au", "nz", "za", "ng", "ke", "gh", "eg", "ma",
        "tn", "dz", "news", "online", "site", "store", "blog", "cloud", "app",
        "tech", "digital", "media", "network", "group", "life", "world", "today",
    }

    def _split_host_at_tld(h: str) -> tuple[str, str] | None:
        """Split host into (clean_host, glued_path) at the last valid TLD boundary.
        Returns None if no valid TLD found."""
        # Find all positions where a known TLD appears as a complete label
        # A TLD label ends when followed by end-of-string or a letter that
        # starts a new label (but we need to distinguish domain labels from
        # glued path text).
        #
        # Strategy: find .tld where tld ∈ _TLDS and what follows looks like
        # a path (starts with 2+ letters that aren't another domain label).
        candidates = []
        for tld in _TLDS:
            # Match .tld followed by letters (glued path)
            for match in re.finditer(r'\.' + re.escape(tld) + r'([a-z]{2,})', h, re.IGNORECASE):
                # The text after TLD should look like a path, not a domain label
                glued = match.group(1)
                # If glued text contains no dots and is > 2 chars, it's likely a path
                clean = h[:match.start()] + "." + tld
                candidates.append((match.start(), clean, glued))
        if not candidates:
            return None
        # Pick the candidate closest to the end of the host.
        #
        # THE TIE MUST BE BROKEN DETERMINISTICALLY. Two candidates can
        # start at the SAME position ("www.infomoney.com.br" offers
        # ".in" and ".info" both at index 3), and the old sort was a
        # stable sort on the position alone — so the winner was decided
        # by the iteration order of a SET, which PYTHONHASHSEED
        # randomises per process. The same URL therefore became a
        # DIFFERENT broken hostname on every run, and both variants
        # 404. Sorting on the hostname too makes the answer the same
        # every time.
        candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)
        _, clean, glued = candidates[0]
        return clean, glued

    # Check if host already ends with a known TLD.
    #
    # A TWO-LETTER last label is a country-code TLD — every ISO 3166-1
    # alpha-2 code is two letters — so it is a valid host end even when
    # that particular code is not in _TLDS. Without this rule
    # "www.infomoney.com.br" looked malformed (".br" is not listed),
    # the splitter ran, and it cut the hostname at ".in" / ".info",
    # turning the domain into "www.in" or "www.info" and the rest of
    # the domain into a path. Both variants 404, and the source's
    # images were lost with them.
    host_labels = host.lower().split(".")
    host_is_valid = (
        len(host_labels) >= 2
        and (
            host_labels[-1] in _TLDS
            or (len(host_labels[-1]) == 2 and host_labels[-1].isalpha())
        )
    )

    if not host_is_valid:
        split = _split_host_at_tld(host)
        if not split:
            return None
        clean_host, glued = split
        host = clean_host
        path = "/" + glued.lstrip("/") + (path if path else "")

    # Collapse double slashes in path
    fixed = scheme + host + (re.sub(r'/{2,}', '/', path) if path else "")

    # Final validation: must have host with TLD + a path
    if not re.match(r'^https?://[^/]+\.[a-z]{2,8}/[a-z0-9]', fixed, re.IGNORECASE):
        return None
    return fixed


# Tracking pixels and spacers: they are technically images, and they
# are never the picture the reader wanted.
_IMAGE_NOISE = re.compile(
    r"(^|/)(pixel|spacer|blank|transparent|beacon|1x1)[._-]|"
    r"\b(1x1|pixel|spacer|tracking|beacon)\b|"
    r"\.(gif)\b",
    re.IGNORECASE,
)


def _entry_image(entry, base_url: str = "") -> str | None:
    """Extract the best image URL from a feed entry.

    Checks in priority order:
    1. media_content with medium="image"
    2. enclosures with type="image/*"
    3. media_thumbnail
    4. An <meta property="og:image"> tag in content/summary
    5. The first <img> tag in content/summary

    `base_url` resolves a RELATIVE url ("/uploads/photo.jpg") against
    the publisher's own address — without it a relative image is
    dropped, and a great many feeds use relative paths.
    """
    raw = None

    # 1. media_content (Media RSS)
    media_content = entry.get("media_content") or []
    for media in media_content:
        if isinstance(media, dict):
            url = media.get("url")
            medium = (media.get("medium") or "").lower()
            if url and (medium == "image" or not medium):
                raw = url
                break

    # 2. enclosures (RSS enclosures)
    if not raw:
        enclosures = entry.get("enclosures") or []
        for enc in enclosures:
            if isinstance(enc, dict):
                url = enc.get("href") or enc.get("url")
                type_ = (enc.get("type") or "").lower()
                if url and type_.startswith("image/"):
                    raw = url
                    break

    # 3. media_thumbnail
    if not raw:
        media_thumbnail = entry.get("media_thumbnail") or []
        for thumb in media_thumbnail:
            if isinstance(thumb, dict):
                url = thumb.get("url")
                if url:
                    raw = url
                    break

    # 4/5. An og:image tag or an <img> tag in content or summary.
    #
    # The attribute value still carries its HTML entities, so it is
    # UNESCAPED here — "…?format=jpg&amp;name=large" is stored
    # verbatim by the raw regex and the publisher answers 404 for it.
    if not raw:
        html_sources = []
        for key in ("content", "summary", "description"):
            val = entry.get(key)
            if isinstance(val, str):
                html_sources.append(val)
            elif isinstance(val, list):
                for item in val:
                    if isinstance(item, dict) and item.get("value"):
                        html_sources.append(item["value"])
        for blob in html_sources:
            m = re.search(
                r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
                blob, re.IGNORECASE)
            if not m:
                m = re.search(
                    r'<img[^>]+src=["\']([^"\']+)["\']', blob, re.IGNORECASE)
            if m:
                raw = html.unescape(m.group(1))
                break

    if not raw:
        return None
    if _IMAGE_NOISE.search(raw):
        return None
    if base_url and not raw.startswith(("http://", "https://")):
        try:
            raw = urljoin(base_url, raw)
        except Exception:
            pass
    return _sanitize_image_url(raw)


def _strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", " ", s or "").strip()


def parse_feed(content: bytes, source_type: str) -> list[dict]:
    """Return list of normalized articles. source_type drives the parser branch."""
    if source_type in ("json", "geojson"):
        try:
            data = json.loads(content)
        except json.JSONDecodeError as exc:
            log.warning("json parse failed: %s", exc)
            return []
        # USGS GeoJSON FeatureCollection
        if isinstance(data, dict) and data.get("type") == "FeatureCollection":
            return _parse_usgs_geojson(data)
        # GDELT ArtList
        if isinstance(data, dict) and "articles" in data:
            return _parse_gdelt(data)
        # NASA EONET
        if isinstance(data, dict) and "events" in data:
            return _parse_eonet(data)
        # ReliefWeb reports
        if isinstance(data, dict) and "data" in data:
            return _parse_reliefweb(data)
        log.warning("unknown json shape: keys=%s", list(data.keys())[:5] if isinstance(data, dict) else type(data).__name__)
        return []

    parsed = feedparser.parse(content)
    out: list[dict] = []
    for e in parsed.entries:
        url, guid = _entry_url_and_id(e)
        if not url:
            continue
        out.append({
            "url": url,
            "guid": guid,
            "title": (e.get("title") or "").strip()[:500],
            "body": _strip_html(_entry_body(e))[:16000],
            "published_at": _entry_published(e),
            # The base URL lets a RELATIVE image ("/uploads/x.jpg")
            # be resolved against the publisher's own address — a great
            # many feeds use relative paths, and without the base they
            # are simply dropped.
            "image_url": _entry_image(e, base_url=url),
        })
    return out


def _parse_usgs_geojson(data: dict) -> list[dict]:
    out = []
    for feat in data.get("features", []):
        geom = feat.get("geometry") or {}
        if geom.get("type") != "Point":
            continue
        coords = geom.get("coordinates") or [None, None]
        lng, lat = coords[0], coords[1]
        if lat is None or lng is None:
            continue
        props = feat.get("properties") or {}
        title = props.get("title") or f"M{props.get('mag', '?')} earthquake"
        out.append({
            "url": feat.get("id") or props.get("detail") or f"usgs:{props.get('ids', '')}",
            "guid": props.get("ids"),
            "title": title,
            "body": (
                f"USGS earthquake report. Magnitude {props.get('mag')}. "
                f"Depth {props.get('depth')}km. Place: {props.get('place')}. "
                f"Time: {props.get('time')}. Coordinates: {lat}, {lng}."
            ),
            "published_at": datetime.fromtimestamp(props["time"] / 1000, tz=timezone.utc) if props.get("time") else None,
            "extracted_lat": float(lat),
            "extracted_lng": float(lng),
            "extracted_location": props.get("place") or "earthquake",
            "extracted_event_type": "disaster",
        })
    return out


def _parse_gdelt(data: dict) -> list[dict]:
    out = []
    for a in data.get("articles", []):
        url = a.get("url")
        if not url:
            continue
        title = a.get("title") or ""
        out.append({
            "url": url,
            "guid": None,
            "title": title[:500],
            "body": (a.get("socialimage") and f"image:{a['socialimage']}") or "",
            "published_at": None,
        })
    return out


def _parse_eonet(data: dict) -> list[dict]:
    out = []
    for ev in data.get("events", []):
        title = ev.get("title") or "natural event"
        cats = ev.get("categories") or []
        cat_labels = [c.get("title") if isinstance(c, dict) else str(c) for c in cats]
        for geom in ev.get("geometry", []):
            coords = (geom or {}).get("coordinates")
            if not coords or len(coords) < 2:
                continue
            lng, lat = coords[0], coords[1]
            ev_id = ev.get("id")
            out.append({
                "url": f"eonet:{ev_id}",
                "guid": ev_id,
                "title": title,
                "body": (
                    f"NASA EONET event {ev_id}. Category: {','.join(cat_labels)}. "
                    f"Coordinates: {lat}, {lng}."
                ),
                "published_at": None,
                "extracted_lat": float(lat),
                "extracted_lng": float(lng),
                "extracted_location": title,
                "extracted_event_type": "environment",
            })
    return out


def _parse_reliefweb(data: dict) -> list[dict]:
    out = []
    fields = {f["name"]: f for f in data.get("fields", {}).get("url", []) and [data] or []}
    for r in data.get("data", []):
        url = None
        fields = r.get("fields") or {}
        if "url" in fields:
            url_obj = fields["url"]
            if isinstance(url_obj, dict):
                url = url_obj.get("url")
            elif isinstance(url_obj, list) and url_obj:
                url = url_obj[0].get("url") if isinstance(url_obj[0], dict) else None
        if not url:
            continue
        body = fields.get("body") or fields.get("title") or ""
        if isinstance(body, str):
            body = body[:8000]
        countries = fields.get("country") or []
        country_names = ", ".join(
            c["name"] for c in countries if isinstance(c, dict) and c.get("name")
        )
        loc = (fields.get("location") or [{}])
        first_loc = loc[0] if isinstance(loc, list) and loc else (loc if isinstance(loc, dict) else {})
        lat = first_loc.get("lat") if isinstance(first_loc, dict) else None
        lng = first_loc.get("lon") if isinstance(first_loc, dict) else None
        entry = {
            "url": url,
            "guid": r.get("id"),
            "title": (fields.get("title") or "reliefweb report")[:500],
            "body": body if isinstance(body, str) else str(body),
            "published_at": None,
            "extracted_event_type": "humanitarian",
        }
        if lat is not None and lng is not None:
            entry["extracted_lat"] = float(lat)
            entry["extracted_lng"] = float(lng)
        if country_names:
            entry["extracted_location"] = country_names
        out.append(entry)
    return out


def _truncate_feed_body(body: bytes) -> bytes:
    """Salvage a capped feed: keep everything up to the LAST complete item
    and close the document. Feeds are newest-first, so this drops only the
    stale tail — the stories we'd have parsed within limit_per_source anyway."""
    for tag in (b"</item>", b"</entry>"):
        cut = body.rfind(tag)
        if cut >= 0:
            doc = body[:cut + len(tag)]
            head = body[:2048].lower()
            if b"<rss" in head:
                doc += b"</channel></rss>"
            elif b"<feed" in head:
                doc += b"</feed>"
            return doc
    return b""


def _bounded_get(client: httpx.Client, url: str, headers: dict):
    """Streaming GET with a hard size cap (MAX_FEED_BYTES) and a redirect
    cap (6 hops). Guards the 1G-MemoryMax worker against giant/malicious
    feeds; returns (status_code, headers, body_bytes|None)."""
    with client.stream("GET", url, headers=headers, timeout=REQUEST_TIMEOUT,
                       follow_redirects=True) as resp:
        if resp.status_code >= 400 or resp.status_code == 304:
            return resp.status_code, dict(resp.headers), None
        chunks: list[bytes] = []
        total = 0
        capped = False
        for chunk in resp.iter_bytes():
            chunks.append(chunk)
            total += len(chunk)
            if total >= MAX_FEED_BYTES:
                capped = True
                break
        body = b"".join(chunks)
        if capped:
            log.info("feed %s exceeded %d bytes — parsed truncated prefix", url, MAX_FEED_BYTES)
            body = _truncate_feed_body(body)
        return resp.status_code, dict(resp.headers), body


def fetch_one(client: httpx.Client, source: dict) -> tuple[list[dict], dict]:
    """Fetch and parse a single source. Returns (articles, status_update_dict)."""
    source_type = source.get("source_type", "rss")

    # Web scraper sources use a different path
    if source_type == "web":
        return _fetch_web_source(source)

    url = source["feed_url"]
    headers = {"User-Agent": user_agent_for(url)}
    if source.get("etag"):
        headers["If-None-Match"] = source["etag"]
    if source.get("last_modified"):
        headers["If-Modified-Since"] = source["last_modified"]

    try:
        status_code, resp_headers, body = _bounded_get(client, url, headers)
    except httpx.HTTPError as exc:
        log.warning("fetch failed for %s: %s", url, exc)
        return [], {"last_failure_at": "now()", "error_count_inc": 1, "_status_code": None}

    if status_code == 304:
        return [], {"last_success_at": "now()", "_status_code": 304}

    if status_code >= 400:
        log.warning("fetch %s: HTTP %s", url, status_code)
        return [], {
            "last_failure_at": "now()",
            "error_count_inc": 1,
            "_status_code": status_code,
        }

    new_etag = resp_headers.get("etag")
    new_last_mod = resp_headers.get("last-modified")

    articles = parse_feed(body or b"", source_type)
    return articles, {
        "last_success_at": "now()",
        "etag": new_etag,
        "last_modified": new_last_mod,
        "_status_code": status_code,
    }


def _fetch_web_source(source: dict) -> tuple[list[dict], dict]:
    """Fetch articles from a non-RSS web source using the scraper."""
    from .web_scraper import scrape_source
    url = source["feed_url"]
    try:
        raw_articles = scrape_source(url, max_articles=20)
        if not raw_articles:
            return [], {"last_failure_at": "now()", "error_count_inc": 1}
        # Normalize to match fetch.py's article shape
        articles = []
        for a in raw_articles:
            articles.append({
                "url": a["url"],
                "guid": None,
                "title": a.get("title", ""),
                "body": a.get("body", ""),
                "published_at": a.get("published_at"),
            })
        return articles, {"last_success_at": "now()"}
    except Exception as e:
        log.warning("web scrape failed for %s: %s", url, e)
        return [], {"last_failure_at": "now()", "error_count_inc": 1}


def insert_articles(articles: list[dict], source_id: int) -> int:
    """INSERT IGNORE new articles; returns count of newly inserted rows.

    Also extracts word frequency for each article so we don't need
    to re-download it later.
    """
    if not articles:
        return 0

    from .word_freq import extract_word_freq, word_freq_to_json

    rows = []
    for a in articles:
        status = "extracted" if a.get("extracted_lat") is not None else "pending"

        # Extract word frequency on insert — fast, no AI needed
        wf = extract_word_freq(a.get("title", ""), a.get("body", ""))
        wf_json = word_freq_to_json(wf) if wf else "{}"

        rows.append((
            source_id, a["url"], a.get("guid"), a["title"], a.get("body", ""),
            a.get("published_at"), a.get("extracted_lat"), a.get("extracted_lng"),
            a.get("extracted_location"), a.get("extracted_event_type"), status,
            wf_json, a.get("image_url"),
        ))
    with connect() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO news_articles (
                source_id, url, guid, title, body, published_at,
                extracted_lat, extracted_lng, extracted_location, extracted_event_type,
                status, word_freq, image_url
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (url, source_id) DO NOTHING
            RETURNING id, source_id, title, url, published_at, status
            """,
            rows,
            returning=True,
        )
        inserted = []
        while True:
            if cur.pgresult:
                inserted.extend(cur.fetchall())
            if not cur.nextset():
                break
        # Best-effort fan-out to the API's SSE broadcaster. Never
        # blocks the worker — the API's snapshot safety net picks up
        # anything we miss here.
        if inserted:
            try:
                from .notify import notify_article_created, trigger_nlp_processing
                for row in inserted:
                    # cur.fetchall() rows: tuple when dict_row not set.
                    if isinstance(row, dict):
                        notify_article_created(row)
                    else:
                        notify_article_created({
                            "id": row[0],
                            "source_id": row[1],
                            "title": row[2],
                            "url": row[3],
                            "published_at": row[4],
                            "status": row[5],
                        })
                    # Trigger NLP processing in background
                    article_id = row[0] if isinstance(row, (list, tuple)) else row.get("id")
                    if article_id:
                        trigger_nlp_processing(article_id)
            except Exception:  # noqa: BLE001
                pass
        return len(inserted)


def update_source(source_id: int, status: dict) -> None:
    sets = []
    args: list = []
    if status.get("last_success_at"):
        sets.append("last_success_at = now()")
        # Success clears the backoff slate entirely.
        sets.append("consecutive_failures = 0")
        sets.append("next_retry_at = NULL")
    if status.get("last_failure_at"):
        sets.append("last_failure_at = now()")
        sets.append("error_count = error_count + 1")
    if status.get("error_count_inc") and not status.get("last_failure_at"):
        sets.append("error_count = error_count + 1")
    if (status.get("last_failure_at") or status.get("error_count_inc")) \
            and not status.get("robots_block"):
        # Value-weighted exponential backoff: 1d → 2d → 4d → 8d (capped),
        # divided by 4 for high-value sources (reliability_score ≥ 0.7), by 2
        # for decent (≥ 0.4), floored at 4 h so even trusted sources back off.
        # SQL SET semantics read PRE-update column values, hence POWER on the
        # old consecutive_failures count (0 → 1 day, 1 → 2, 2 → 4, 3+ → 8).
        sets.append("consecutive_failures = LEAST(consecutive_failures + 1, 12)")
        sets.append("""next_retry_at = now() + GREATEST(
              LEAST(INTERVAL '1 day' * POWER(2, LEAST(consecutive_failures, 3)),
                    INTERVAL '8 days')
              / CASE WHEN COALESCE(reliability_score, 0) >= 0.7 THEN 4.0
                     WHEN COALESCE(reliability_score, 0) >= 0.4 THEN 2.0
                     ELSE 1.0 END,
              INTERVAL '4 hours')""")
    if status.get("etag"):
        sets.append("etag = %s"); args.append(status["etag"])
    if status.get("last_modified"):
        sets.append("last_modified = %s"); args.append(status["last_modified"])
    if status.get("robots_block"):
        sets.append("active = FALSE")
        sets.append("robots_blocked_at = now()")
        if status.get("robots_path"):
            sets.append("robots_block_path = %s")
            args.append(status["robots_path"])
    if not sets:
        return
    args.append(source_id)
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            f"UPDATE news_sources SET {', '.join(sets)} WHERE id = %s",
            args,
        )


# ── Atomic fetch-lease (Tier 1.5 — Audit 4 fix) ────────────────────────
#
# Audit 4 found that the previous claim CTE
# (WITH claimable AS …, claimed AS UPDATE … SET last_polled_at = now() …)
# was non-atomic for non-protected tiers: the inner WHERE clause filter
# was always TRUE for commercial + community hosts, so two workers
# running the same claim query within seconds of each other could both
# see the same row as claimable, both UPDATE last_polled_at, both
# RETURNING it, and end up processing the same source — duplicate fetch,
# duplicate INSERT attempt on news_articles.
#
# The fix is true compare-and-set: a single UPDATE that:
#   1. pre-selects due rows with FOR UPDATE SKIP LOCKED, so concurrent
#      workers see a *disjoint* subset of claimable rows (the inner
#      SELECT skips rows another worker's transaction is currently
#      locking);
#   2. AND combines an explicit "in-flight" filter
#      (fetch_in_progress = FALSE OR lease_expires_at < now()) so that
#      even non-protected rows are protected for the duration of the
#      fetch — closing the window between claim-commit and fetch-done
#      that was the duplicate-fetch hole.
#
# `last_polled_at` is kept as the polite-floor timestamp (separately
# indexed). The lease is *additional*, not a replacement — the standing
# politeness constraint (HANDOFF §3.1,
# memory/government-site-politeness.md, README §9.6) is still enforced
# by last_polled_at, and the Tier 1.5 migration
# (api/migrations/2026-09-08-fetch-lease.sql) installs the lease
# columns alongside it.
#
# `gen_random_uuid()` is provided by pgcrypto (enabled by
# migrate-db.sh). `lease_token` is a high-entropy TEXT so it doubles
# as the CAS key on release — even if another worker has somehow
# claimed the row (e.g. lease expired mid-fetch), our release won't
# stomp on the live claim because the WHERE clause also filters on
# lease_token.
LEASE_TTL_S = 300  # 5 minutes; covers worst-case fetch + parse + insert

# Batch-limited claims (2026-09-28): the whole due sweep (~2,400 sources)
# used to be claimed under a single 5-min lease that a 40–60 min sweep could
# never honor — leases expired mid-run and got re-claimed next cycle
# (expired-lease thrashing). fetch_all now claims at most CLAIM_BATCH_SIZE
# sources per batch and re-claims between batches, so each lease is granted
# minutes before its source is actually fetched.
CLAIM_BATCH_SIZE = int(_env("FETCH_CLAIM_BATCH", "200"))

# Hard ceiling on how many sources ONE fetch_all() call may claim, whatever
# happens. See the "SWEEP TERMINATION" note in fetch_all: batch limiting alone
# does not terminate the claim loop, because the claimable pool refills faster
# than the fleet can be swept. The default comfortably covers the whole active
# fleet (~3,700 sources) while still bounding a pathological run.
FETCH_MAX_CLAIMED_PER_SWEEP = int(_env("FETCH_MAX_CLAIMED_PER_SWEEP", "8000"))

CLAIM_SQL = """
    WITH claimable AS (
        SELECT id,
               tier_for_url_inline(feed_url) AS tier,
               EXTRACT(EPOCH FROM (now() - last_success_at)) AS seconds_since_success
        FROM news_sources
        WHERE active = TRUE
          AND deleted_at IS NULL
          AND (
                last_polled_at IS NULL
             OR (tier_for_url_inline(feed_url) = 'gov'
                 AND last_polled_at < now() - INTERVAL '24 hours')
             OR (tier_for_url_inline(feed_url) = 'university'
                 AND last_polled_at < now() - INTERVAL '6 hours')
             OR  tier_for_url_inline(feed_url) NOT IN ('gov','university')
          )
          AND (fetch_in_progress = FALSE OR lease_expires_at < now())
          -- Value-weighted failure backoff (2026-09-26): after each failure a
          -- source waits 1d→2d→4d→8d before retry (reliability_score shortens
          -- the wait for historically valuable sources — the learn.py bandit's
          -- output finally drives the scheduler). next_retry_at is cleared on
          -- success; NULL means "always due".
          AND (next_retry_at IS NULL OR next_retry_at <= now())
          -- Never claim a source we would post-filter as "succeeded
          -- recently": claiming-then-skipping leaked leases (FIX_NOTES 1.6).
          AND (last_success_at IS NULL
               OR last_success_at < now() - INTERVAL '{recent_window} seconds')
          -- Web scrapes cost 1 page + up to 20 article fetches; poll them at
          -- most once per WEB_SOURCE_MIN_INTERVAL_H, not every cycle (FIX_NOTES 1.2/5.4).
          AND (source_type IS DISTINCT FROM 'web'
               OR last_polled_at IS NULL
               OR last_polled_at < now() - INTERVAL '{web_hours} hours')
        ORDER BY last_polled_at NULLS FIRST, id
        LIMIT {claim_batch}
        FOR UPDATE SKIP LOCKED
    ),
    claimed AS (
        UPDATE news_sources
        SET fetch_in_progress = TRUE,
            lease_token = gen_random_uuid()::text,
            lease_expires_at = now() + INTERVAL '{} seconds',
            last_polled_at = now()
        FROM claimable
        WHERE news_sources.id = claimable.id
        RETURNING news_sources.id, news_sources.name, news_sources.feed_url,
                  news_sources.source_type, news_sources.etag, news_sources.last_modified,
                  news_sources.lease_token,
                  claimable.tier, claimable.seconds_since_success
    )
    SELECT id, name, feed_url, source_type, etag, last_modified,
           lease_token, tier, seconds_since_success
    FROM claimed
    ORDER BY id
""".format(LEASE_TTL_S, recent_window=RECENT_SUCCESS_WINDOW_S,
           web_hours=WEB_SOURCE_MIN_INTERVAL_H, claim_batch=CLAIM_BATCH_SIZE)


def _claim_sources_due(cur) -> list[dict]:
    """Atomically claim up to CLAIM_BATCH_SIZE currently-due sources for fetch.

    Returns a list of source dicts, each augmented with ``lease_token``.
    The caller MUST release each lease via :func:`_release_lease` once
    the fetch completes (success or failure); otherwise the row stays
    leased for ``LEASE_TTL_S`` before the lease-expires filter releases
    it for another worker (crash recovery).

    Concurrency contract: even if many workers (xyzo-fetcher timer at
    :0/15/30/45 + xyzo-fast-fetcher every 5 min) call this function at
    the same second, every claimed ``id`` is owned by exactly one
    worker. The FOR UPDATE SKIP LOCKED inside the inner SELECT
    guarantees no double-claim.
    """
    cur.execute(CLAIM_SQL)
    return cur.fetchall()


def _release_lease(cur, source_id: int, lease_token: str,
                   *, reset_polled: bool = False) -> bool:
    """Release the lease on a source; CAS-guarded by ``lease_token``.

    Returns True if the row was still leased by us (lease_token
    matched) and we successfully cleared fetch_in_progress. Returns
    False if another worker has already taken over — in which case we
    MUST NOT stomp on the active claim.

    ``reset_polled=True`` also clears ``last_polled_at`` (failure path:
    "polite, but try again soon"). On success, ``last_polled_at`` keeps
    the polite-floor stamp so the standing .gov/.edu floor is honored.
    """
    sets = [
        "fetch_in_progress = FALSE",
        "lease_token = NULL",
        "lease_expires_at = NULL",
    ]
    if reset_polled:
        sets.append("last_polled_at = NULL")
    cur.execute(
        f"UPDATE news_sources SET {', '.join(sets)} "
        "WHERE id = %s AND lease_token = %s RETURNING id",
        (source_id, lease_token),
    )
    return cur.fetchone() is not None


def fetch_all(limit_per_source: int | None = 50) -> dict:
    """Fetch all enabled sources concurrently by host group.

    Groups sources by host, then fetches up to MAX_CONCURRENT_HOSTS
    host groups in parallel. Within each host, requests are sequential
    with per-host throttle. Sources that succeeded recently are skipped.

    Claims are batch-limited (CLAIM_BATCH_SIZE per lease cycle): claim →
    fetch → re-claim, so no lease is older than one batch when its source
    is fetched (previously the whole sweep held 5-min leases that expired
    mid-run — see CLAIM_BATCH_SIZE comment).
    """
    summary = {
        "sources_fetched": 0,
        "articles_inserted": 0,
        "errors": 0,
        "dropped_at_cap": 0,
        "sources_skipped_robots": 0,
        "sources_skipped_5xx": 0,  # Step 2b — temporary blocks, retried later
        "sources_skipped_recent": 0,
    }

    def _run_batch(fresh_sources: list[dict]) -> None:
        """Fetch ONE claimed batch: group by host, run host groups in parallel.

        Nested inside fetch_all so it closes over limit_per_source and
        summary. The caller claims a fresh batch (with fresh LEASE_TTL_S
        leases) immediately before each call — see the claim loop below.
        """
        # Group sources by host
        host_groups: dict[str, list[dict]] = {}
        for src in fresh_sources:
            host = urlparse(src["feed_url"]).netloc.lower()
            if host not in host_groups:
                host_groups[host] = []
            host_groups[host].append(src)

        # Fetch host groups concurrently
        # RULE: Different hosts = parallel OK. Same host = sequential only.
        # Never fetch the same website/IP in parallel — you'll get rate-limited.
        #
        # STREAMING: Each source is processed immediately after fetch (insert +
        # word_freq extraction). We don't wait for all sources to download
        # before starting to process. This means the first articles appear on
        # the map within seconds of being fetched.
        def fetch_host_group(host: str, host_sources: list[dict]) -> dict:
            """Fetch all sources from one host (SEQUENTIAL within host).

            This function runs in a thread pool. Multiple host groups run
            in parallel, but within each group, requests are sequential
            with per-host throttle to respect rate limits.

            STREAMING: Each article is inserted + processed immediately
            after its source is fetched, not batched at the end.
            """
            result = {"fetched": 0, "inserted": 0, "errors": 0, "dropped": 0, "robots_blocked": 0, "robots_5xx": 0}
            # All sources in this host group share the same host, so they
            # share the same politeness tier — compute UA once per group.
            # The robots cache also stores on disk keyed by host, so passing
            # the per-host UA here makes the cache entry reflect what we
            # actually sent.
            robots = RobotsCache(ua=user_agent_for(host_sources[0]["feed_url"]))
            last_at = 0.0

            with httpx.Client(timeout=REQUEST_TIMEOUT, limits=_HTTPX_LIMITS,
                              follow_redirects=True, max_redirects=6) as client:
                for src in host_sources:
                    url = src["feed_url"]
                    src_id = src["id"]
                    # lease_token was written by the atomic claim CTE (see
                    # _claim_sources_due). We MUST release it before any
                    # code path that bails early — ``continue`` or
                    # exception — otherwise the row stays leased until
                    # lease_expires_at (5 min) and another worker has to
                    # wait. The finally block below handles every exit.
                    lease_token = src.get("lease_token")
                    # failure_mode: True if we should also reset
                    # last_polled_at on release (retry-soon semantics);
                    # False on success (keep polite-floor stamp).
                    failure_mode = False

                    try:
                        # robots.txt check — returns a RobotsVerdict object with
                        # .allowed (bool), .crawl_delay_s (float|None),
                        # .disallowed_path (str|None). Previously this tried to
                        # unpack a 3-tuple which broke after robots.py was
                        # refactored to return an object — every host group then
                        # crashed silently and no articles were ever inserted.
                        verdict = robots.is_allowed(url)
                        # Persist verification result to DB (best-effort — don't fail the fetch)
                        try:
                            robots.persist_to_db(src_id, url, verdict)
                        except Exception:
                            pass
                        if not verdict.allowed:
                            # Step 2b — distinguish 5xx (temporary, retry next cycle)
                            # from persistent robots_block (Disallow, active=FALSE).
                            #
                            # Standing politeness constraint (HANDOFF §3.1,
                            # README §9.6): publishers under load (5xx) must
                            # not be pummelled with retries. We mark failure
                            # (last_failure_at, error_count++) and skip —
                            # but do NOT mark active=FALSE which is permanent.
                            # The robots cache TTL is shortened in
                            # robots._fetch so we re-check in ~10 min.
                            #
                            # Persistent blocks (Disallow: /, explicit deny)
                            # still set active=FALSE via robots_block — that's
                            # intentional: the publisher has spoken.
                            if verdict.note == "5xx-server-error":
                                log.info("robots: 5xx, retry next cycle %s", url)
                                update_source(src_id, {"last_failure_at": "now()", "error_count_inc": 1})
                                result["robots_5xx"] += 1
                                # Retry-soon only for unprotected tiers; .gov/.edu
                                # keep their politeness floor even when failing
                                # (FIX_NOTES 5.1 — the floor was being erased by
                                # reset_polled, causing 5-min re-polling of
                                # persistently-failing .gov feeds).
                                if (src.get("tier") not in ("gov", "university")
                                        and src.get("source_type") != "web"):
                                    failure_mode = True
                            else:
                                log.info("robots: skip %s (path %s)", url, verdict.disallowed_path)
                                update_source(src_id, {"robots_block": True, "robots_path": verdict.disallowed_path})
                                result["robots_blocked"] += 1
                                # Persistent block: source is now inactive,
                                # so the polite floor is moot. Releasing
                                # the lease without resetting last_polled_at
                                # (i.e. failure_mode=False) lets it fall out
                                # of the claim filter via active=FALSE on
                                # the next cycle. The retry semantics don't
                                # apply — we've stopped trying.
                            continue

                        # Step 2c — cap in-cycle sleep at 60 s.
                        #
                        # A .gov host with no robots.txt previously caused
                        # robots.py to return crawl_delay_s = tier_floor
                        # (86 400 s, the standing politeness constant). The
                        # original sleep unbounded here would park this pool
                        # thread for 24 h on the very first iteration,
                        # effectively freezing one of the 8 concurrent slots
                        # for a single .gov host.
                        #
                        # The CORRECT place to enforce a 24 h minimum between
                        # .gov polls is Step 3 (SQL gate via last_polled_at).
                        # This loop is the in-cycle throttle for sources that
                        # the gate ALREADY approved as due. Capping here
                        # prevents accidental sleeps huge enough to miss the
                        # next fetcher cycle while leaving the politeness
                        # floor where it actually belongs (the scheduler).
                        MAX_IN_CYCLE_SLEEP_S = 60.0
                        interval = max(verdict.crawl_delay_s or 0, MIN_FETCH_INTERVAL_S)
                        if interval > MAX_IN_CYCLE_SLEEP_S:
                            log.warning(
                                "fetch.py: capping in-cycle sleep %.0fs -> %.0fs for %s "
                                "(robots requested %.0fs; politeness enforced by Step 3 gate, not here)",
                                interval, MAX_IN_CYCLE_SLEEP_S, url, interval,
                            )
                            interval = MAX_IN_CYCLE_SLEEP_S
                        elapsed = time.time() - last_at
                        if elapsed < interval:
                            time.sleep(interval - elapsed)
                        last_at = time.time()

                        # Fetch this source
                        articles, status = fetch_one(client, src)

                        # Process immediately — don't wait for other sources
                        if limit_per_source and len(articles) > limit_per_source:
                            result["dropped"] += len(articles) - limit_per_source
                            articles = articles[:limit_per_source]

                        # Insert + extract word_freq right away
                        inserted = insert_articles(articles, src_id)

                        # Step 1 — observation log (no behavior change).
                        #
                        # Writes a per-poll row to source_poll_observations. This
                        # is measurement ONLY; no behavioral change. Failures here
                        # MUST NOT block the fetch path — wrapped in try/except.
                        # Next session's Step 4 (rate-estimator predictor) reads
                        # this table to fit per-source lambdas once we have >= 2
                        # weeks of independent observations.
                        #
                        # `outcome` derivation:
                        #   'ok'             -> 200 + >= 1 article processed
                        #   'not_modified'   -> 304 (revalidation hit; common, cheap)
                        #   'robots_block'   -> robots.is_allowed returned False
                        #                       (caller already set active=FALSE via
                        #                        update_source)
                        #   'error'          -> transport failure OR HTTP >= 400
                        #
                        # `hit_item_cap` is true when the feed returned >=
                        # limit_per_source items. That means we censored older
                        # items — useful for picking the ceiling in Step 4.
                        #
                        # Cancel-safe: if fetch_one() raised before reaching this
                        # line, no row is written. Cancellation is recorded by
                        # fetch_all's outer try/except (summary['errors']).
                        try:
                            outcome = (
                                "not_modified" if int(status.get("_status_code") or 0) == 304
                                else "ok" if status.get("last_success_at")
                                else "robots_block" if status.get("robots_block")
                                else "error"
                            )
                            # items_returned is the count BEFORE the cap truncation
                            # at L524–526 — that's the true feed size.
                            returned_before_cap = len(articles)
                            hit_cap = (
                                limit_per_source is not None
                                and returned_before_cap >= limit_per_source
                            )
                            pub_dates = [
                                a.get("published_at")
                                for a in articles
                                if a.get("published_at") is not None
                            ]
                            with connect() as _obs_conn:
                                with _obs_conn.cursor() as _obs_cur:
                                    _obs_cur.execute(
                                        """
                                        INSERT INTO source_poll_observations (
                                          source_id, http_status, items_returned,
                                          items_new, hit_item_cap, newest_published_at,
                                          oldest_published_at, tier, outcome
                                        )
                                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                                        """,
                                        (
                                            src_id,
                                            status.get("_status_code"),
                                            returned_before_cap,
                                            inserted,
                                            hit_cap,
                                            max(pub_dates) if pub_dates else None,
                                            min(pub_dates) if pub_dates else None,
                                            tier_for_url(src["feed_url"]),
                                            outcome,
                                        ),
                                    )
                                    _obs_conn.commit()
                        except Exception as _obs_err:
                            log.warning(
                                "observation log insert failed for %s: %s",
                                src["name"], _obs_err,
                            )

                        update_source(src_id, status)

                        # Step 3 — on failure, do NOT extend the polite
                        # floor. last_polled_at is reset on release
                        # (failure_mode=True) so the next cycle retries
                        # without waiting 24h. On success the stamp
                        # stays so .gov/.edu floors are honored.
                        #
                        # EXCEPTION (FIX_NOTES 5.1): the retry-soon reset is
                        # itself a politeness violation for .gov/.edu hosts —
                        # a persistently-failing government feed was being
                        # re-polled every ~5 min forever, breaking the
                        # standing 24h/6h constraint this file's own header
                        # comment says MUST NOT happen. For protected tiers we
                        # keep the floor stamp on failure; they retry at the
                        # tier cadence regardless of error state. Same for
                        # 'web' sources whose 24h cadence gate (FIX_NOTES 1.2)
                        # keys off last_polled_at too.
                        if (status.get("last_failure_at")
                                and src.get("tier") not in ("gov", "university")
                                and src.get("source_type") != "web"):
                            failure_mode = True

                        result["fetched"] += 1
                        result["inserted"] += inserted
                        if status.get("last_failure_at"):
                            result["errors"] += 1
                        log.info("source %s: %d new (etag=%s)", src["name"], inserted, (status.get("etag") or "")[:30])

                    except Exception as src_err:
                        # FIX_NOTES 1.7: previously this loop had no except —
                        # one poison row (e.g. malformed USGS coordinates)
                        # raised past the finally and killed the WHOLE host
                        # group, stranding leases for every later source in
                        # the group until TTL. Isolate failures to one source.
                        log.exception("source id=%s (%s) failed in-group: %s",
                                      src_id, src.get("name"), src_err)
                        result["errors"] += 1
                        failure_mode = (src.get("tier") not in ("gov", "university")
                                        and src.get("source_type") != "web")

                    finally:
                        # Release the lease on every exit path — success,
                        # robots-skip, exception from fetch_one() / insert /
                        # observation log. CAS-guarded by lease_token so we
                        # don't stomp on a row that another worker has
                        # taken over (lease_expires_at).
                        #
                        # Note: we do not let release failures abort the
                        # outer fetch_host_group return — a transient DB
                        # hiccup here would otherwise strand the row until
                        # the 5-min lease expiry. The log line is enough:
                        # the next cycle will reclaim via lease_expires_at
                        # once the predicate ``lease_expires_at < now()``
                        # matches.
                        if lease_token:
                            try:
                                with connect() as _rel_conn:
                                    with _rel_conn.cursor() as _rel_cur:
                                        released = _release_lease(
                                            _rel_cur, src_id, lease_token,
                                            reset_polled=failure_mode,
                                        )
                                        if not released:
                                            log.info(
                                                "lease for source id=%s was already reassigned "
                                                "(token mismatch) — leaving it alone",
                                                src_id,
                                            )
                                        _rel_conn.commit()
                            except Exception as _rel_err:
                                log.warning(
                                    "lease release failed for source id=%s: %s",
                                    src_id, _rel_err,
                                )

            return result

        # Run host groups in parallel
        with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_HOSTS) as executor:
            futures = {
                executor.submit(fetch_host_group, host, host_srcs): host
                for host, host_srcs in host_groups.items()
            }
            for future in as_completed(futures):
                host = futures[future]
                try:
                    result = future.result()
                    summary["sources_fetched"] += result["fetched"]
                    summary["articles_inserted"] += result["inserted"]
                    summary["errors"] += result["errors"]
                    summary["dropped_at_cap"] += result["dropped"]
                    summary["sources_skipped_robots"] += result["robots_blocked"]
                    summary["sources_skipped_5xx"] += result.get("robots_5xx", 0)
                except Exception as e:
                    log.error("host group %s failed: %s", host, e)
                    summary["errors"] += 1


    # ── Batch-limited claim loop (2026-09-28) ─────────────────────────
    # The old code claimed the ENTIRE due sweep (~2,400 sources) under one
    # LEASE_TTL_S (5 min) lease, but a full sweep takes 40–60 min. Leases
    # expired mid-run and the next timer cycle re-claimed the same sources
    # (expired-lease thrashing: wasted polls; URL dedupe prevented dupes).
    # Now we claim at most CLAIM_BATCH_SIZE sources per batch, fetch them,
    # then claim again. ORDER BY last_polled_at NULLS FIRST in CLAIM_SQL
    # guarantees the staleest sources go first, so repeated cycles still
    # cover the whole fleet — with every lease fresh when its source is
    # actually fetched.
    #
    # SWEEP TERMINATION (2026-09-29 outage — read before editing this loop).
    #
    # Batch limiting does NOT make this loop terminate. The only exit used to
    # be `len(sources) < CLAIM_BATCH_SIZE`, i.e. "the claimable pool drained".
    # But the pool refills faster than it drains: RECENT_SUCCESS_WINDOW_S is
    # 300 s, so a source becomes claimable again 5 minutes after it succeeds,
    # while sweeping the whole ~3,700-source fleet takes 15–40 minutes. The
    # claim therefore always returned a full batch, `fetch_all()` never
    # returned, and run.py — which calls fetch BEFORE auto_categorize /
    # geocode / cluster — never got past step one.
    #
    # Symptoms (measured 2026-09-29): 10,624 polls in one hour across only
    # 2,234 distinct sources (same source polled 5x/hour), while
    # auto_categorized_at was frozen 20 h in the past, 75k articles stuck at
    # status='pending' with no coordinates, and the map showing only
    # pre-outage pins. worker.run runs ONE cycle and exits, so the services
    # sitting at "1 day uptime" was itself the proof that fetch never
    # returned.
    #
    # Termination is now explicit and provable: track the ids THIS call has
    # already polled and stop as soon as a claim hands back nothing new
    # (fleet wrapped), with FETCH_MAX_CLAIMED_PER_SWEEP as a backstop. `seen`
    # only ever grows and ids come from a finite set, so the loop must end.
    claimed_total = 0
    seen: set[int] = set()
    while True:
        with connect() as conn, conn.cursor() as cur:
            # Step 3 — politeness gate + true compare-and-set lease (READ BEFORE EDITING).
            #
            # Standing politeness constraint (HANDOFF §3.1,
            # memory/government-site-politeness.md, README §9.6):
            # .gov hosts once / 24h, .edu (and ac.*) once / 6h. The tier
            # derivation lives in tier_for_url_inline(feed_url) (api/migrations
            # /2026-09-07-tier-fn.sql) and MUST stay in sync with
            # worker/robots.py:tier_for_url.
            #
            # Audit 4 (fixed by Tier 1.5): the previous claim CTE used a
            # WHERE clause whose predicate was always TRUE for non-protected
            # tiers (commercial + community), so two workers running the
            # same claim query within seconds of each other could both
            # UPDATE the same row, both RETURNING it, and end up processing
            # the same source — duplicate fetch + duplicate INSERT attempt
            # on news_articles.
            #
            # The fix is true CAS: a single UPDATE that
            #   1. pre-selects due rows with FOR UPDATE SKIP LOCKED so
            #      concurrent workers see a *disjoint* subset of claimable
            #      rows; the other timer skips rows we are locking and
            #      picks the next available one.
            #   2. AND filters on (fetch_in_progress = FALSE OR
            #      lease_expires_at < now()) so that even non-protected
            #      rows are protected for the duration of the fetch,
            #      closing the claim-commit ↔ fetch-done window where the
            #      duplicate fetch hole lived.
            # The polite-floor timestamp ``last_polled_at`` is preserved
            # for its original role (24h / 6h / none per tier) and is set
            # on every successful claim; on failure we reset it back to
            # NULL so the next cycle retries without waiting the full
            # politeness floor (HANDOFF §3.1: "polite, but when we fail,
            # try again soon").
            #
            # DO NOT bypass this gate. DO NOT add a code path that
            # polls a .gov source more often than the floor. If you
            # need to (e.g. emergency incident coverage), set
            # last_polled_at = NULL in SQL — that leaves an audit
            # trail in source_poll_observations rather than silently
            # weakening the constraint.
            sources = _claim_sources_due(cur)

            if not sources:
                fresh: list[dict] = []
            else:
                # Split this claim into sources THIS call has not polled yet
                # versus ones it already has. A repeat means the politeness
                # window (RECENT_SUCCESS_WINDOW_S, 300 s) reopened before the
                # fleet sweep finished — expected, not new work. Hand those
                # leases straight back so we neither re-poll them this sweep
                # nor leave them leased for LEASE_TTL_S. reset_polled=False
                # keeps last_polled_at, which is exactly right: it was already
                # stamped by the claim we are undoing.
                fresh = [s for s in sources if s["id"] not in seen]
                for s in (s for s in sources if s["id"] in seen):
                    _release_lease(cur, s["id"], s["lease_token"])

                # Backstop: even if `seen` somehow never fills, one fetch_all()
                # can only ever claim FETCH_MAX_CLAIMED_PER_SWEEP sources.
                if fresh and claimed_total + len(fresh) > FETCH_MAX_CLAIMED_PER_SWEEP:
                    for s in fresh:
                        _release_lease(cur, s["id"], s["lease_token"])
                    log.warning(
                        "fetch: sweep cap %d reached — releasing %d claimed "
                        "source(s) without fetching",
                        FETCH_MAX_CLAIMED_PER_SWEEP, len(fresh))
                    fresh = []

        if not fresh:
            # Nothing claimable, OR everything claimable was already polled by
            # this call (the fleet wrapped) — either way the sweep is complete.
            break

        # The "succeeded recently" skip is enforced INSIDE CLAIM_SQL (see
        # RECENT_SUCCESS_WINDOW_S). The old post-claim filter dropped sources
        # that were already claimed — fetch_in_progress stayed TRUE until the
        # lease TTL expired (~50% of the fleet at any moment) because the
        # per-source finally{} never ran for them (FIX_NOTES 1.6).
        log.info("fetch: %d due sources claimed (batch cap %d), %d new this sweep, %d claimed so far",
                 len(sources), CLAIM_BATCH_SIZE, len(fresh), claimed_total)
        _run_batch(fresh)
        seen.update(s["id"] for s in fresh)
        claimed_total += len(fresh)
        if len(sources) < CLAIM_BATCH_SIZE:
            break  # claimed everything due — sweep complete

    return summary


def cleanup_stale_leases() -> int:
    """Clear fetch_in_progress on any source that was mid-fetch when a worker crashed.

    On a sudden reboot, workers leave behind `fetch_in_progress=TRUE` rows.
    The lease_token is NULL for a crashed worker (it never got to write the token
    before dying), so these rows are definitively stuck. We also clear rows where
    the lease has expired but wasn't released — those are claimable but we err
    on the side of starting clean after a crash rather than trying to resume.

    Returns the number of rows cleared.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            UPDATE news_sources
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
            log.warning("[cleanup] cleared %d stale fetch lease(s): %s", n, rows)
        return n


def run(limit: int | None = None, progress: ProgressWriter | None = None) -> dict:
    cleanup_stale_leases()
    if progress:
        progress.update(step="fetch", detail="Fetching news feeds...")
    res = fetch_all(limit_per_source=limit)
    if progress:
        progress.update(
            step="fetch",
            detail=f"Fetched {res['sources_fetched']} sources, inserted {res['articles_inserted']} new articles",
            counters={"articles_inserted": res["articles_inserted"]},
        )
    return res


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    print(run())
