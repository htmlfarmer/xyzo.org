"""events_calendar job handler.

Polls `event_sources` (RSS/iCal/API) according to the politeness tier
encoded on each row. Per the user's standing constraint (2026-09-06):

  • gov / university sources respect robots.txt strictly with a 24h /
    6h minimum interval and a single retry on 5xx.
  • community / commercial sources have shorter cadences (2h / 30m).
  • platform sources (paid APIs) follow their API's published rate limit
    — currently set to 15m as a safe floor.
  • user sources are never auto-fetched.

The handler runs one source per invocation. The job-queue dispatch
loop walks `event_sources` ordered by `source_priority` so Tier-1
(Eventbrite, Meetup, Lu.ma) wins when they become active.

Job payload:
  {"kind": "polite_poll", "source_id": 12}
  {"kind": "discover_patterns", "host": "example.com"}
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

import feedparser

import events_calendar as ec
from db import connect

log = logging.getLogger("xyzo.worker.events_calendar")


@dataclass
class SourceRow:
    """Subset of event_sources we use at poll-time."""
    id: int
    source: str
    name: str
    host: str
    feed_url: str
    website_url: str
    country_code: str | None
    region: str | None
    city: str | None
    default_category: str
    default_subcategory: str | None
    source_priority: int
    politeness_tier: str
    last_fetched_at: datetime | None
    last_status: int | None
    last_etag: str | None
    last_modified: str | None
    consecutive_failures: int
    backoff_until: datetime | None


def _row_to_source(row: dict) -> SourceRow:
    return SourceRow(
        id=row["id"],
        source=row["source"],
        name=row["name"],
        host=row["host"] or "",
        feed_url=row["feed_url"] or "",
        website_url=row["website_url"] or "",
        country_code=row.get("country_code"),
        region=row.get("region"),
        city=row.get("city"),
        default_category=row.get("default_category") or "other",
        default_subcategory=row.get("default_subcategory"),
        source_priority=row.get("source_priority") or 50,
        politeness_tier=row.get("politeness_tier") or "commercial",
        last_fetched_at=row.get("last_fetched_at"),
        last_status=row.get("last_status"),
        last_etag=row.get("last_etag"),
        last_modified=row.get("last_modified"),
        consecutive_failures=row.get("consecutive_failures") or 0,
        backoff_until=row.get("backoff_until"),
    )


def _can_fetch_now(row: SourceRow, now: float) -> tuple[bool, str]:
    """Returns (allowed, reason)."""
    if row.politeness_tier == "user":
        return False, "user-tier-never-autofetch"
    if row.backoff_until and row.backoff_until.timestamp() > now:
        return False, f"backoff_until={row.backoff_until.isoformat()}"
    settings = ec.tier_settings(row.politeness_tier)
    min_interval = settings.get("min_interval_seconds")
    if min_interval is None:
        return False, "no-cadence"
    if row.last_fetched_at is None:
        return True, "first-fetch"
    if (now - row.last_fetched_at.timestamp()) >= min_interval:
        return True, "cadence-elapsed"
    return False, "too-soon"


def _record_outcome(source_id: int, status: int, etag: str | None,
                    modified: str | None, items: int,
                    crawl_status: str, robots_allowed: bool,
                    backoff_seconds: int | None = None) -> None:
    """Update event_sources with the outcome of a fetch."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE event_sources
            SET last_fetched_at       = now(),
                last_status           = %s,
                last_etag             = COALESCE(%s, last_etag),
                last_modified         = COALESCE(%s, last_modified),
                items_last_fetch      = %s,
                consecutive_failures  = CASE WHEN %s >= 400 THEN consecutive_failures + 1 ELSE 0 END,
                crawl_status          = %s,
                robots_allowed        = %s,
                backoff_until         = CASE
                                            WHEN %s::int IS NULL THEN NULL
                                            ELSE now() + (%s::int || ' seconds')::interval
                                        END,
                updated_at            = now()
            WHERE id = %s
            """,
            (
                status, etag, modified, items, status,
                crawl_status, robots_allowed,
                backoff_seconds, backoff_seconds, source_id,
            ),
        )


def _derive_domain(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return ""


def _derive_robots_allowed(tier: str, url: str) -> bool:
    """Re-check robots before the actual fetch."""
    return ec.robots_allows(url, tier)


def _compute_content_hash(title: str, desc: str, starts_at: datetime | None,
                          city: str | None) -> str:
    """Stable hash for cross-source dedup."""
    base = "|".join(filter(None, [
        (title or "").lower().strip(),
        re.sub(r"\s+", " ", (desc or "").lower().strip())[:500],
        starts_at.isoformat() if starts_at else "",
        (city or "").lower().strip(),
    ]))
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:32]


def _upsert_item(it: ec.EventItem, source_priority: int,
                 politeness_tier: str) -> int | None:
    """Insert one parsed event into upcoming_events. Returns the id."""
    if not it.starts_at:
        return None
    content_hash = _compute_content_hash(
        it.title, it.description or "", it.starts_at, it.city,
    )
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO upcoming_events (
                source, source_id, source_url, canonical_url, source_domain,
                title, description, category, subcategory, event_type,
                timezone, venue_name, venue_address, city, region, state,
                country, country_code, lat, lng,
                starts_at, ends_at, is_online, is_free, price, price_min,
                price_max, currency, registration_url,
                organizer_name, organizer_url, image_url,
                speaker_names, artist_names, performer_names,
                tags, keywords, language,
                source_priority, crawl_status, robots_allowed,
                discovered_at, last_seen_at
            ) VALUES (
                %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                %s, %s, %s,
                COALESCE(%s, now()), now()
            )
            ON CONFLICT (source, source_id) DO UPDATE SET
                title = EXCLUDED.title,
                description = EXCLUDED.description,
                category = EXCLUDED.category,
                subcategory = EXCLUDED.subcategory,
                event_type = EXCLUDED.event_type,
                timezone = COALESCE(EXCLUDED.timezone, upcoming_events.timezone),
                city = COALESCE(EXCLUDED.city, upcoming_events.city),
                region = COALESCE(EXCLUDED.region, upcoming_events.region),
                state = COALESCE(EXCLUDED.state, upcoming_events.state),
                country = COALESCE(EXCLUDED.country, upcoming_events.country),
                country_code = COALESCE(EXCLUDED.country_code, upcoming_events.country_code),
                lat = COALESCE(EXCLUDED.lat, upcoming_events.lat),
                lng = COALESCE(EXCLUDED.lng, upcoming_events.lng),
                starts_at = EXCLUDED.starts_at,
                ends_at = COALESCE(EXCLUDED.ends_at, upcoming_events.ends_at),
                is_online = EXCLUDED.is_online,
                is_free = EXCLUDED.is_free,
                price = COALESCE(EXCLUDED.price, upcoming_events.price),
                currency = COALESCE(EXCLUDED.currency, upcoming_events.currency),
                organizer_name = COALESCE(EXCLUDED.organizer_name, upcoming_events.organizer_name),
                organizer_url = COALESCE(EXCLUDED.organizer_url, upcoming_events.organizer_url),
                image_url = COALESCE(EXCLUDED.image_url, upcoming_events.image_url),
                tags = EXCLUDED.tags,
                keywords = EXCLUDED.keywords,
                last_seen_at = now(),
                updated_at = now()
            RETURNING id
            """,
            (
                it.source, it.source_id, it.source_url, it.source_url,
                _derive_domain(it.source_url),
                it.title, it.description,
                it.category or "other",
                None,  # subcategory — to be filled from ML tagger
                "in-person",  # event_type — default; override when explicitly online
                None,  # timezone — populated when source declares one
                it.venue_name, None,  # venue_address
                it.city, None, None,  # region, state
                None, it.country_code,  # country, country_code
                it.lat, it.lng,
                it.starts_at, it.ends_at,
                it.is_online, it.is_free,
                None, None, None, it.currency,  # price, price_min, price_max
                None,  # registration_url
                it.organizer_name,  # organizer_name
                None,  # organizer_url
                it.image_url,
                it.tags if it.tags else [],  # speaker_names — populate from parse below
                [],  # artist_names
                [],  # performer_names
                it.tags or [],
                [],  # keywords
                it.language,
                source_priority, "ok", True,
                None,  # discovered_at — first-write semantics
            ),
        )
        result = cur.fetchone()
        return int(result["id"]) if result else None


def _is_online_indicator(text: str) -> bool:
    t = (text or "").lower()
    return any(k in t for k in (
        "online", "virtual", "webinar", "livestream",
        "zoom", "remote only", " via youtube",
    ))


def handle(payload: dict) -> dict[str, Any]:
    """Job entrypoint — returns a stats dict for the runner to log."""
    started = time.time()
    kind = payload.get("kind") or "polite_poll"

    if kind == "polite_poll":
        return _handle_polite_poll(payload, started)
    if kind == "discover_patterns":
        return _handle_discover_patterns(payload, started)
    if kind == "scan_active_sources":
        return _handle_scan_active_sources(payload, started)
    return {"ok": False, "error": f"unknown kind: {kind}", "ms": 0}


def _handle_polite_poll(payload: dict, started: float) -> dict[str, Any]:
    source_id = payload.get("source_id")
    if not source_id:
        return {"ok": False, "error": "missing source_id", "ms": 0}
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT * FROM event_sources WHERE id = %s AND is_active = TRUE
            """,
            (source_id,),
        )
        row = cur.fetchone()
    if not row:
        return {"ok": False, "error": "source-not-found-or-inactive", "ms": 0}

    src = _row_to_source(row)
    now = time.time()
    allowed, reason = _can_fetch_now(src, now)
    if not allowed:
        return {"ok": True, "skipped": reason, "source_id": source_id,
                "ms": int((time.time() - started) * 1000)}

    # Robots check first — fail fast and record the verdict.
    robots_ok = _derive_robots_allowed(src.politeness_tier, src.feed_url)
    if not robots_ok:
        _record_outcome(src.id, 451, None, None, 0,
                        crawl_status="blocked_robots", robots_allowed=False)
        return {"ok": True, "skipped": "robots-blocked", "source_id": source_id,
                "ms": int((time.time() - started) * 1000)}

    body, new_etag, new_lm, status = ec.fetch_feed(
        src.feed_url, src.politeness_tier,
        etag=src.last_etag, last_modified=src.last_modified,
    )
    if status == 304:
        _record_outcome(src.id, 304, src.last_etag, src.last_modified, 0,
                        crawl_status="not-modified", robots_allowed=True)
        return {"ok": True, "not_modified": True, "source_id": source_id,
                "ms": int((time.time() - started) * 1000)}
    if body is None:
        backoff = None
        if status == 429:
            backoff = 24 * 3600   # back off 24h
        elif status in (502, 503, 504):
            backoff = 600         # 10m
        _record_outcome(src.id, status, None, None, 0,
                        crawl_status=f"http_{status}", robots_allowed=True,
                        backoff_seconds=backoff)
        return {"ok": True, "http_status": status, "source_id": source_id,
                "backoff_seconds": backoff,
                "ms": int((time.time() - started) * 1000)}

    # Parse + upsert
    try:
        parsed = feedparser.parse(body)
        items = _extract_items(parsed, src)
    except Exception as e:
        log.warning("parse failed for %s: %s", src.feed_url, e)
        _record_outcome(src.id, status, new_etag, new_lm, 0,
                        crawl_status="parse_error", robots_allowed=True)
        return {"ok": False, "error": "parse_error", "source_id": source_id,
                "ms": int((time.time() - started) * 1000)}

    inserted = 0
    for it in items:
        if _upsert_item(it, src.source_priority, src.politeness_tier):
            inserted += 1

    _record_outcome(src.id, status, new_etag, new_lm, len(items),
                    crawl_status="ok", robots_allowed=True)
    return {
        "ok": True,
        "source_id": source_id,
        "feed_parsed": len(items),
        "inserted": inserted,
        "ms": int((time.time() - started) * 1000),
    }


def _extract_items(parsed, src: SourceRow) -> list[ec.EventItem]:
    """Convert a feedparser result into EventItems for our schema."""
    out: list[ec.EventItem] = []
    if not parsed or not getattr(parsed, "entries", None):
        return out
    for entry in parsed.entries:
        title = (entry.get("title") or "").strip()
        url = (entry.get("link") or "").strip()
        guid = (entry.get("id") or entry.get("guid") or url or title).strip()
        if not title or not url:
            continue
        title = re.sub(r"<!\[CDATA\[\s*(.*?)\s*\]\]>", r"\1",
                       title, flags=re.DOTALL).strip()
        description = ""
        if entry.get("summary"):
            description = entry.summary
        elif entry.get("content"):
            cl = entry.content
            if isinstance(cl, list) and cl:
                description = cl[0].get("value", "")
        if description:
            description = re.sub(r"<[^>]+>", " ", description)
            description = re.sub(r"\s+", " ", description).strip()[:2000]

        tags: list[str] = []
        for tag in entry.get("tags", []) or []:
            term = tag.get("term")
            if term:
                tags.append(term.strip())

        # GeoRSS
        lat = lng = None
        if entry.get("geo_lat") is not None and entry.get("geo_long") is not None:
            try:
                lat = float(entry.geo_lat)
                lng = float(entry.geo_long)
            except (TypeError, ValueError):
                lat = lng = None

        starts = ec._to_dt(entry.get("published_parsed")
                          or entry.get("updated_parsed")
                          or entry.get("created_parsed"))
        ends = ec._to_dt(entry.get("expired_parsed"))

        is_online = _is_online_indicator(f"{title} {description}")

        out.append(ec.EventItem(
            source=src.source,
            source_id=f"{src.source}:{src.host}:{guid}",
            source_url=url,
            title=title,
            description=description or None,
            category=src.default_category,
            venue_name=None,
            city=src.city,
            country_code=src.country_code,
            lat=lat, lng=lng,
            starts_at=starts,
            ends_at=ends,
            is_online=is_online,
            is_free=None,
            image_url=None,
            organizer_name=None,
            tags=tags,
            language=(parsed.feed.get("language")
                      if hasattr(parsed, "feed") and parsed.feed else None),
        ))
    return out


def _handle_discover_patterns(payload: dict, started: float) -> dict[str, Any]:
    """Walk event_url_patterns against a host, recording each probe."""
    host = (payload.get("host") or "").lower().strip()
    if not host:
        return {"ok": False, "error": "missing host", "ms": 0}
    robots_ok = _derive_robots_allowed("community", f"https://{host}/")
    if not robots_ok:
        return {"ok": True, "skipped": "robots-blocked", "host": host,
                "ms": int((time.time() - started) * 1000)}
    probed = 0
    hits = 0
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, pattern, kind FROM event_url_patterns "
            "WHERE is_active = TRUE ORDER BY priority ASC LIMIT 50"
        )
        patterns = cur.fetchall()
        for pat_id, pattern, kind in patterns:
            url = f"https://{host}{pattern}"
            try:
                req = __import__("urllib.request").request.Request(
                    url, headers={"User-Agent":
                                  "xyzo-events/1.0 (+https://xyzo.org)"}
                )
                with __import__("urllib.request").urlopen(req, timeout=8) as resp:
                    status = resp.status
                    body = resp.read()
                    if status == 200 and len(body) > 200:
                        hits += 1
                        cur.execute(
                            "INSERT INTO event_discoveries "
                            "(host, pattern_id, url, status, found_links) "
                            "VALUES (%s, %s, %s, %s, %s)",
                            (host, pat_id, url, status, body.count(b"<a ")),
                        )
            except Exception as e:
                cur.execute(
                    "INSERT INTO event_discoveries "
                    "(host, pattern_id, url, status) VALUES (%s, %s, %s, %s)",
                    (host, pat_id, url, 0),
                )
            probed += 1
    return {
        "ok": True,
        "host": host,
        "probed": probed,
        "hits": hits,
        "ms": int((time.time() - started) * 1000),
    }


def _handle_scan_active_sources(payload: dict, started: float) -> dict[str, Any]:
    """Enqueue one polite_poll job per active source that's due now."""
    enqueued = 0
    now = time.time()
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, politeness_tier, last_fetched_at, backoff_until "
            "FROM event_sources WHERE is_active = TRUE "
            "ORDER BY source_priority ASC, id ASC LIMIT 100"
        )
        rows = cur.fetchall()
        for src_id, tier, last_fetched, backoff in rows:
            if tier == "user":
                continue
            if backoff and backoff.timestamp() > now:
                continue
            settings = ec.tier_settings(tier)
            min_interval = settings.get("min_interval_seconds")
            if min_interval and last_fetched:
                if (now - last_fetched.timestamp()) < min_interval:
                    continue
            # Defer actual enqueue to runner — just return what we'd do
            enqueued += 1
    return {
        "ok": True,
        "due": enqueued,
        "ms": int((time.time() - started) * 1000),
    }
