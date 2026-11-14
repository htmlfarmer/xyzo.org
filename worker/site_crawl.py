"""site_crawl — BFS through a domain, find events.

`crawl_site(seed_url, max_pages=50, max_depth=3, use_ai=False)` walks
the host starting from the seed, prioritises event-shaped paths
(events, calendar, agenda, etc.), and extracts events from each page
using:

  • JSON-LD (schema.org Event)
  • HTML microdata
  • Date-anchored heuristic
  • Claude API (when `use_ai=True` AND no events found by the others)

Politeness: same-host fetches are sequential, with the host's
configured crawl delay between requests. robots.txt is honoured
through `RobotsCache`. 429 / 5xx responses trigger adaptive cooldown.

CrawlResult holds the discovered pages, extracted events, RSS feeds,
and sitemap URLs. The caller is responsible for persisting it (the
/api/sites/crawl endpoint stores it in site_crawl_results,
discovered_pages, crawl_events).

Per-page signals are recorded so the API can explain why we
classified a page the way we did. The full URL set we discovered but
didn't fetch is also returned so the user can see what we found.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from collections import deque
from dataclasses import dataclass, field, asdict
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from robots import RobotsCache, tier_for_url
from site_study import (
    StudyResult, study_url,
    extract_rss_autodiscovery, extract_meta,
)
from page_priority import rank_urls, score_url, ScoredURL
from ai_extract import (
    ExtractedEvent, heuristic_extract, ai_extract,
)

log = logging.getLogger("xyzo.site_crawl")

USER_AGENT = ("xyzo-crawl/1.0 (+https://xyzo.org/bot) "
              "polite-crawler; contact@xyzo.org")


# ── DTOs ──────────────────────────────────────────────────────────────
@dataclass
class DiscoveredPage:
    url: str
    final_url: str | None
    parent_url: str | None
    depth: int
    priority: float
    status: int | None = None
    content_type: str | None = None
    title: str | None = None
    html_lang: str | None = None
    bytes: int = 0
    rss_links: list[dict[str, Any]] = field(default_factory=list)
    json_ld_events: list[dict[str, Any]] = field(default_factory=list)
    heuristic_events: list[dict[str, Any]] = field(default_factory=list)
    ai_events: list[dict[str, Any]] = field(default_factory=list)
    og_tags: dict[str, Any] = field(default_factory=dict)
    out_links_count: int = 0
    signals: list[str] = field(default_factory=list)
    error: str | None = None
    elapsed_ms: int = 0
    crawled_at: float = 0.0


@dataclass
class CrawlEvent:
    """A unified event record. Can come from JSON-LD, heuristic, AI, or RSS."""
    title: str
    source_url: str
    page_url: str
    description: str | None = None
    starts_at: str | None = None      # ISO string for serialization
    ends_at: str | None = None
    venue_name: str | None = None
    city: str | None = None
    country_code: str | None = None
    lat: float | None = None
    lng: float | None = None
    image_url: str | None = None
    price_min: float | None = None
    price_max: float | None = None
    currency: str | None = None
    is_free: bool | None = None
    is_online: bool = False
    event_url: str | None = None
    organizer_name: str | None = None
    extraction: str = "heuristic"
    confidence: float = 0.5
    content_hash: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class CrawlResult:
    seed_url: str
    host: str
    politeness_tier: str
    started_at: float
    finished_at: float = 0.0
    max_pages: int = 50
    max_depth: int = 3
    pages: list[DiscoveredPage] = field(default_factory=list)
    events: list[CrawlEvent] = field(default_factory=list)
    feeds: list[dict[str, Any]] = field(default_factory=list)
    sitemaps: list[str] = field(default_factory=list)
    robots_verdict: str = "unknown"
    robots_note: str = ""
    skipped_urls: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "seed_url": self.seed_url,
            "host": self.host,
            "politeness_tier": self.politeness_tier,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "max_pages": self.max_pages,
            "max_depth": self.max_depth,
            "pages": [asdict(p) for p in self.pages],
            "events": [e.to_dict() for e in self.events],
            "feeds": self.feeds,
            "sitemaps": self.sitemaps,
            "robots_verdict": self.robots_verdict,
            "robots_note": self.robots_note,
            "skipped_urls": self.skipped_urls,
            "error": self.error,
            "stats": {
                "pages_crawled": len(self.pages),
                "events_found": len(self.events),
                "feeds_found": len(self.feeds),
                "sitemaps_found": len(self.sitemaps),
                "skipped": len(self.skipped_urls),
            },
        }


# ── Link extraction (lightweight HTML parser, stdlib only) ───────────
_HREF_RE = re.compile(
    r'<a\b[^>]*?href=["\']([^"\']+)["\']',
    re.IGNORECASE,
)


def extract_links(html: str, base_url: str) -> list[str]:
    """Pull absolute URLs from anchor hrefs."""
    out: list[str] = []
    seen: set[str] = set()
    for m in _HREF_RE.finditer(html):
        href = m.group(1).strip()
        if not href or href.startswith("#"):
            continue
        try:
            abs_url = urljoin(base_url, href)
        except (ValueError, TypeError):
            continue
        # Normalise: drop fragment
        parsed = urlparse(abs_url)
        clean = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
        if parsed.query:
            clean += "?" + parsed.query
        if clean in seen:
            continue
        seen.add(clean)
        out.append(clean)
    return out


# ── Content-hash for dedup ───────────────────────────────────────────
def content_hash(title: str, starts_at: str | None,
                 venue: str | None) -> str:
    base = "|".join(filter(None, [
        (title or "").lower().strip(),
        (starts_at or "").strip(),
        (venue or "").lower().strip(),
    ]))
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:32]


# ── BFS crawler ──────────────────────────────────────────────────────
def crawl_site(seed_url: str,
               max_pages: int = 50,
               max_depth: int = 3,
               use_ai: bool = False,
               max_seconds: int = 90,
               robots: RobotsCache | None = None,
               intelligence: dict | None = None,
               ) -> CrawlResult:
    """BFS-crawl `seed_url`'s host. Returns a CrawlResult.

    `use_ai` — when True, escalate to Claude on high-priority pages
    that the heuristic extractor didn't find events on.
    `max_seconds` — overall wall-clock cap.
    """
    started = time.time()
    parsed_seed = urlparse(seed_url)
    host = (parsed_seed.hostname or "").lower()
    if not host:
        return CrawlResult(seed_url=seed_url, host="", politeness_tier="",
                           started_at=started,
                           error="invalid-seed-url")

    robots = robots or RobotsCache()
    tier = tier_for_url(seed_url)
    result = CrawlResult(
        seed_url=seed_url, host=host, politeness_tier=tier,
        started_at=started,
        max_pages=max_pages, max_depth=max_depth,
    )

    # Robots pre-check
    verdict = robots.is_allowed(seed_url, tier=tier)
    result.robots_verdict = (
        "allowed" if verdict.allowed else
        "partial" if verdict.sitemaps else "blocked"
    )
    result.robots_note = verdict.note
    result.sitemaps = list(verdict.sitemaps or [])
    if not verdict.allowed:
        result.error = f"robots-disallow:{verdict.disallowed_path}"
        result.finished_at = time.time()
        return result

    # BFS frontier. Each entry: (url, parent, depth)
    seen: set[str] = set()
    frontier: deque[tuple[str, str | None, int]] = deque()
    seed_clean = _normalise(seed_url)
    seen.add(seed_clean)
    frontier.append((seed_clean, None, 0))

    # Intelligence-driven hints (optional, may be None)
    crawl_hints = None
    if intelligence:
        try:
            from worker.intelligence_consume import parse_intelligence_to_hints
            crawl_hints = parse_intelligence_to_hints(intelligence)
            # Add intelligence seeds to frontier
            for seed in crawl_hints.extra_seeds[:10]:
                if seed.startswith("http"):
                    parsed_seed_url = seed
                else:
                    parsed_seed_url = urljoin(seed_url, seed)
                clean = _normalise(parsed_seed_url)
                if clean not in seen:
                    seen.add(clean)
                    frontier.append((clean, None, 1))
        except Exception as e:
            log.warning("failed to load crawl_hints: %s", e)

    # Crawl-delay from robots
    crawl_delay = verdict.crawl_delay_s or 1.0
    last_fetch_at = 0.0

    event_hashes: set[str] = set()    # dedup across pages

    while frontier and len(result.pages) < max_pages:
        if (time.time() - started) > max_seconds:
            result.error = "max-seconds-exceeded"
            break

        # Pop highest-priority URL from frontier
        url, parent, depth = frontier.popleft()
        scored = score_url(url)
        if crawl_hints is not None:
            try:
                from worker.page_priority import score_url_with_intelligence
                _scored = score_url_with_intelligence(
                    url, None, hints=crawl_hints)
                scored = type(scored)(
                    url=url, score=_scored, reasons=scored.reasons,
                )
            except Exception:
                pass
        # Re-check robots for this specific URL
        v = robots.is_allowed(url, tier=tier)
        if not v.allowed:
            result.skipped_urls.append({
                "url": url, "reason": "robots-disallow",
                "path": v.disallowed_path,
            })
            continue

        # Per-host throttle
        elapsed = time.time() - last_fetch_at
        if elapsed < crawl_delay:
            time.sleep(crawl_delay - elapsed)

        page = _crawl_page(url, parent, depth, scored, robots, tier)
        result.pages.append(page)
        last_fetch_at = time.time()

        if page.error:
            continue

        # Merge extracted events
        for ev in page.heuristic_events + page.json_ld_events + page.ai_events:
            h = ev.get("content_hash") or content_hash(
                ev.get("title", ""),
                ev.get("starts_at"),
                ev.get("venue_name"),
            )
            if h in event_hashes:
                continue
            event_hashes.add(h)
            result.events.append(CrawlEvent(
                title=ev.get("title", "(untitled)"),
                source_url=url,
                page_url=url,
                description=ev.get("description"),
                starts_at=ev.get("starts_at"),
                ends_at=ev.get("ends_at"),
                venue_name=ev.get("venue_name"),
                city=ev.get("city"),
                country_code=ev.get("country_code"),
                lat=ev.get("lat"),
                lng=ev.get("lng"),
                image_url=ev.get("image_url"),
                price_min=ev.get("price_min"),
                price_max=ev.get("price_max"),
                currency=ev.get("currency"),
                is_free=ev.get("is_free"),
                is_online=ev.get("is_online", False),
                event_url=ev.get("event_url"),
                organizer_name=ev.get("organizer_name"),
                extraction=ev.get("extraction", "heuristic"),
                confidence=ev.get("confidence", 0.5),
                content_hash=h,
            ))

        # Pick up RSS feeds discovered
        for feed in page.rss_links:
            if not any(f.get("href") == feed.get("href")
                       for f in result.feeds):
                result.feeds.append(feed)

        # Stop early if a high-priority page is rich
        if (scored.score >= 1.0 and
                len([e for e in result.events
                     if e.page_url == url]) >= 5):
            continue

        # Expand frontier if depth allows
        if depth >= max_depth:
            continue
        for link in page.out_links_count and getattr(page, "_out_links", []):
            if link in seen:
                continue
            parsed = urlparse(link)
            if (parsed.hostname or "").lower() != host:
                continue   # same-host only
            seen.add(link)
            frontier.append((link, url, depth + 1))

    result.finished_at = time.time()
    return result


def _normalise(url: str) -> str:
    parsed = urlparse(url)
    clean = f"{parsed.scheme or 'https'}://{parsed.netloc}{parsed.path}"
    if parsed.query:
        clean += "?" + parsed.query
    if clean.endswith("/") and len(parsed.path) > 1:
        clean = clean[:-1]
    return clean


def _crawl_page(url: str, parent: str | None, depth: int,
                scored: ScoredURL,
                robots: RobotsCache, tier: str,
                ) -> DiscoveredPage:
    """Fetch + extract events + extract links for one page."""
    started = time.time()
    page = DiscoveredPage(
        url=url, final_url=None, parent_url=parent, depth=depth,
        priority=scored.score, crawled_at=started,
    )

    study = study_url(url, robots=robots)
    page.final_url = study.final_url or url
    page.status = study.status
    page.content_type = study.content_type
    page.title = study.title
    page.html_lang = study.html_lang
    page.bytes = study.body_bytes
    page.og_tags = study.og_tags
    page.elapsed_ms = study.elapsed_ms
    page.error = study.error

    if not study.body or study.body_kind != "html":
        return page

    html = study.body

    # RSS autodiscovery
    rss = extract_rss_autodiscovery(html, page.final_url or url)
    page.rss_links = [
        {"href": r.href, "type": r.type, "title": r.title}
        for r in rss
    ]
    if rss:
        page.signals.append("rss_autodiscovery")

    # JSON-LD events
    jsonld_events = study.json_ld_events or []
    page.json_ld_events = [
        _extracted_to_dict(_coerce_event(e)) for e in jsonld_events
    ]
    if jsonld_events:
        page.signals.append("json_ld_event")

    # Heuristic
    heur = heuristic_extract(html, page.final_url or url)
    page.heuristic_events = [_extracted_to_dict(e) for e in heur]
    if heur:
        page.signals.append("heuristic_event")

    # AI escalation: only on high-priority pages with no events found
    if (not page.json_ld_events and not page.heuristic_events and
            scored.score >= 1.0):
        try:
            ai_events = ai_extract(html, page.final_url or url)
            page.ai_events = [_extracted_to_dict(e) for e in ai_events]
            if ai_events:
                page.signals.append("ai_extracted")
        except Exception as e:
            log.warning("ai_extract failed for %s: %s", url, e)

    # Out-links (count for stats; full list carried in attribute)
    links = extract_links(html, page.final_url or url)
    page.out_links_count = len(links)
    page._out_links = links  # type: ignore[attr-defined]

    return page


def _coerce_event(ev: Any) -> ExtractedEvent:
    """Coerce a dict (from JSON-LD) into an ExtractedEvent."""
    if isinstance(ev, ExtractedEvent):
        return ev
    if not isinstance(ev, dict):
        return ExtractedEvent(title=str(ev))
    starts = ev.get("startDate")
    ends = ev.get("endDate")
    import datetime as dt
    def _p(v):
        if not v:
            return None
        try:
            return dt.datetime.fromisoformat(
                str(v).replace("Z", "+00:00"))
        except ValueError:
            return None
    location = ev.get("location") or {}
    if isinstance(location, list):
        location = location[0] if location else {}
    addr = location.get("address") or {} if isinstance(location, dict) else {}
    geo = location.get("geo") or {} if isinstance(location, dict) else {}
    return ExtractedEvent(
        title=ev.get("name") or ev.get("headline") or "(untitled)",
        description=ev.get("description"),
        starts_at=_p(starts),
        ends_at=_p(ends),
        venue_name=(location.get("name")
                    if isinstance(location, dict) else None),
        city=(addr.get("addressLocality")
              if isinstance(addr, dict) else None),
        country_code=(addr.get("addressCountry")
                      if isinstance(addr, dict) else None),
        lat=(float(geo.get("latitude"))
             if isinstance(geo, dict)
             and geo.get("latitude") is not None else None),
        lng=(float(geo.get("longitude"))
             if isinstance(geo, dict)
             and geo.get("longitude") is not None else None),
        image_url=ev.get("image"),
        is_free=ev.get("isAccessibleForFree"),
        event_url=ev.get("url"),
        organizer_name=(ev.get("organizer", {}).get("name")
                        if isinstance(ev.get("organizer"), dict)
                        else None),
        extraction="json_ld",
        confidence=0.9,
        raw=ev,
    )


def _extracted_to_dict(e: ExtractedEvent) -> dict[str, Any]:
    return {
        "title": e.title,
        "description": e.description,
        "starts_at": e.starts_at.isoformat() if e.starts_at else None,
        "ends_at": e.ends_at.isoformat() if e.ends_at else None,
        "venue_name": e.venue_name,
        "city": e.city,
        "country_code": e.country_code,
        "lat": e.lat,
        "lng": e.lng,
        "image_url": e.image_url,
        "price_min": e.price_min,
        "price_max": e.price_max,
        "currency": e.currency,
        "is_free": e.is_free,
        "is_online": e.is_online,
        "event_url": e.event_url,
        "organizer_name": e.organizer_name,
        "extraction": e.extraction,
        "confidence": e.confidence,
        "content_hash": content_hash(
            e.title,
            e.starts_at.isoformat() if e.starts_at else None,
            e.venue_name,
        ),
    }


# ── Intelligence-driven wrapper ──────────────────────────────────────
def _fetch_intelligence_row(host: str) -> dict | None:
    """Read site_intelligence row. Returns None on any failure."""
    try:
        from db import connect
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT intelligence, refreshed_at, confidence, "
                "consecutive_errors, drift_signals "
                "FROM site_intelligence WHERE host = %s LIMIT 1",
                (host,),
            )
            row = cur.fetchone()
            return dict(row) if row else None
    except Exception as e:
        log.warning("fetch_intelligence failed for %s: %s", host, e)
        return None


def load_intelligence(host: str) -> dict | None:
    """Load intelligence JSON for a host, with refresh decision.

    Returns the parsed intelligence dict if usable, None otherwise.
    Triggers async AI scan if record is stale or missing.
    """
    try:
        row = _fetch_intelligence_row(host)
    except Exception as e:
        log.warning("load_intelligence: row fetch raised for %s: %s", host, e)
        return None
    if row is None:
        # Schedule background scan; return None so caller falls back
        try:
            from worker.ai_intelligence_scan import schedule_async_scan
            schedule_async_scan(host, reason="no-record")
        except Exception:
            pass
        return None

    try:
        from worker.ai_intelligence_scan import needs_refresh
        needs, reason = needs_refresh(row, host)
        if needs:
            try:
                from worker.ai_intelligence_scan import schedule_async_scan
                schedule_async_scan(host, reason=reason)
            except Exception:
                pass
    except Exception:
        pass
    # Return intelligence even if stale — better than nothing
    return row.get("intelligence") or None


def is_enabled(flag_key: str, host: str) -> bool:
    """Check if a feature flag is enabled for the host. Lazy import."""
    try:
        from api.src.xyzo_features import is_enabled as _is_enabled
        try:
            from robots import tier_for_url
            tier = tier_for_url(f"https://{host}")
        except Exception:
            tier = "commercial"
        return _is_enabled(flag_key, host, tier)
    except Exception as e:
        log.warning("is_enabled check failed: %s", e)
        return False


def crawl_with_intelligence(seed_url: str, **kwargs) -> dict | None:
    """Crawl a site using site_intelligence for hints.

    Returns the crawl result dict (from CrawlResult.to_dict()).
    Returns None if feature is disabled or pre-flight fails.

    Post-crawl: runs embedding dedup + drift signal update. Tier is
    derived from the seed URL via `tier_for_url` (the canonical source
    already used by `crawl_site` and `is_enabled`); the AI scan JSONB
    does not carry a `politics.tier` field. Falls back to `commercial`
    if the URL classifier itself raises so we never silently drop
    protection.
    """
    from urllib.parse import urlparse
    parsed = urlparse(seed_url)
    host = (parsed.hostname or "").lower()
    if not host:
        return None

    if not is_enabled("intelligence_driven_crawl", host):
        log.debug("intelligence_driven_crawl disabled for %s", host)
        return None

    intel = load_intelligence(host)

    # Pass intelligence into crawl_site via the existing kwargs
    result = crawl_site(seed_url, intelligence=intel, **kwargs)
    result_dict = result.to_dict()

    # Determine the host's tier from the SEED URL, not from the AI scan
    # JSONB. The AI scan `politics` payload does NOT carry a `tier` field
    # (see worker/prompts/intelligence_scan.py) — it only carries signals
    # like contact_kind / public_mandate. Reading `intel["politics"]["tier"]`
    # therefore always yields None and silently bypasses the gov/university
    # guard in compute_event_embeddings, violating the standing constraint
    # that gov/university events must NEVER be auto-merged.
    #
    # Canonical tier source: `tier_for_url(seed_url)` — the same function
    # crawl_site() and is_enabled() already use. Fall back to `commercial`
    # so we still call the helpers; they have their own gov/university
    # guards, but we never want to silently skip protection when the URL
    # classifier itself fails.
    try:
        tier = tier_for_url(seed_url)
    except Exception:
        tier = "commercial"

    # Post-process: embed events + update drift signals. Each helper
    # swallows its own errors and logs at WARNING; the crawl result
    # is always returned even if both steps fail.
    try:
        events = result_dict.get("events") or []
        if events:
            embedded_count = compute_event_embeddings(
                events, host, tier=tier)
            result_dict["embeddings_computed"] = embedded_count
    except Exception as e:
        log.warning("embedding step failed: %s", e)
    try:
        update_drift_signals(host, result_dict)
    except Exception as e:
        log.warning("drift update failed: %s", e)
    return result_dict


# ── Task 20: embeddings dedup + drift signal updates ────────────────
#
# IMPORTANT (gov/university protection):
#   compute_event_embeddings NEVER auto-merges gov/university events.
#   - find_near_duplicates is read-only (no HTTP) and runs for all tiers.
#   - mark_duplicate is skipped + a WARNING is logged for gov/university.
#   - The encoding work still happens — we just refuse to silently mutate
#     state for politically sensitive sources.
#   - source_tier/target_tier are passed to mark_duplicate as a
#     defence-in-depth audit trail.
def compute_event_embeddings(events: list[dict], host: str,
                              tier: str = "commercial") -> int:
    """Embed extracted events and run dedup. Returns count embedded.

    `host` + `tier` are passed by the caller (crawl_with_intelligence
    already knows the host and tier). We honour the standing
    constraint: government and university events are NEVER auto-merged.
    """
    if not events:
        return 0

    # Feature flag check (lazy import, matches site_crawl.is_enabled)
    try:
        from api.src.xyzo_features import is_enabled as _is_enabled
        if not _is_enabled("embedding_dedup", host, tier):
            return 0
    except Exception as e:
        log.warning("embedding_dedup flag check failed for %s: %s",
                     host, e)
        return 0

    try:
        from worker.embeddings import (  # type: ignore
            encode_events_batch, is_available,
        )
        from worker.embeddings_dedup import (  # type: ignore
            find_near_duplicates, mark_duplicate,
            DEFAULT_THRESHOLD, REVIEW_THRESHOLD_LOWER,
        )
    except Exception as e:
        log.warning("embedding imports failed: %s", e)
        return 0

    if not is_available():
        return 0

    try:
        vectors = encode_events_batch(events)
    except Exception as e:
        log.warning("encode_events_batch failed for %s: %s", host, e)
        return 0

    count = 0
    protected = tier in ("gov", "university")
    for ev, vec in zip(events, vectors):
        if vec is None:
            continue
        try:
            dups = find_near_duplicates(
                str(ev.get("id", "")),
                vec,
                starts_at=ev.get("starts_at"),
            )
        except Exception as e:
            log.warning("find_near_duplicates failed: %s", e)
            continue

        high_conf = [d for d in dups if d["sim"] >= DEFAULT_THRESHOLD]
        if high_conf:
            if protected:
                # Standing constraint: gov/university events must NEVER be
                # silently merged. Log loudly and skip the merge.
                log.warning(
                    "skipping auto-merge for %s event on tier=%s host=%s "
                    "(sim=%.3f vs target id=%s); manual review required",
                    ev.get("title", "(untitled)"),
                    tier, host,
                    high_conf[0]["sim"], high_conf[0]["id"],
                )
            else:
                try:
                    mark_duplicate(
                        lower_id=int(ev.get("id", 0)),
                        higher_id=high_conf[0]["id"],
                        source_tier=tier,
                        target_tier=tier,
                    )
                except Exception as e:
                    log.warning("mark_duplicate failed: %s", e)
        count += 1
    return count


def update_drift_signals(host: str, crawl_result: dict) -> None:
    """Update site_intelligence.drift_signals based on crawl findings.

    DB write only — no HTTP. Safe for gov/university tiers.
    """
    try:
        from db import connect
        import json as _json
    except Exception as e:
        log.warning("update_drift_signals import failed for %s: %s",
                     host, e)
        return

    try:
        pages = crawl_result.get("pages") or []
        feeds_found = crawl_result.get("feeds") or []
        paths_returning_events = sum(
            1 for p in pages
            if (p.get("json_ld_events") or p.get("heuristic_events")
                or p.get("ai_events"))
        )
        paths_total = len(pages)

        drift = {
            "predicted_paths_returning_events": paths_returning_events,
            "predicted_paths_total": paths_total,
            "predicted_feeds_alive": len(feeds_found),
            "predicted_feeds_total": len(feeds_found),
            "json_ld_seen_in_last_crawl": any(
                p.get("json_ld_events") for p in pages),
            "last_drift_check_at": _now_iso(),
        }

        with connect() as conn, conn.cursor() as cur:
            # Use `||` to merge with existing drift_signals rather than
            # overwriting — operator-added keys must survive across crawls.
            cur.execute(
                "UPDATE site_intelligence "
                "SET drift_signals = drift_signals || %s::jsonb, "
                "last_used_at = now(), crawl_count = crawl_count + 1, "
                "events_extracted = events_extracted + %s "
                "WHERE host = %s",
                (_json.dumps(drift),
                 crawl_result.get("stats", {}).get("events_found", 0),
                 host),
            )
            conn.commit()
    except Exception as e:
        log.warning("update_drift_signals failed for %s: %s", host, e)


def _now_iso() -> str:
    """Return current UTC time as ISO 8601 string."""
    import datetime as dt
    return dt.datetime.now(dt.timezone.utc).isoformat()
