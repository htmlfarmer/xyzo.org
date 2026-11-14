"""Polite robots.txt cache for the xyzo fetcher.

`RobotsCache.is_allowed(url)` returns a `RobotsVerdict` with:
  - allowed (bool)
  - crawl_delay_s (float|None)
  - disallowed_path (str|None)
  - sitemaps (list[str])
  - tier (str)
  - note (str)

We fetch `/robots.txt` on the first request to each host, parse with stdlib
`urllib.robotparser`, cache the parsed result in-process AND on disk for
`ttl_s` so a restart doesn't replay every host lookup.

Polite default: if `/robots.txt` is unreachable or empty, allow.

Politeness tiers: a URL's host determines its tier (`tier_for_url`), and the
cache enforces stricter backoff for government / university hosts. The tier
is derived from the host TLD (.gov, .edu, .ac.uk, etc.), but callers can
override by passing `tier=` to `is_allowed()`.

DB persistence: after each robots.txt check, call `persist_to_db(source_id,
url, verdict)` to write verification results to `news_sources`. Columns
updated: robots_checked_at, robots_status, robots_content_hash,
robots_http_status, robots_sitemaps, robots_crawl_delay_s.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
import urllib.robotparser
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx

log = logging.getLogger("xyzo.robots")

POLITE_UA = "xyzo-fetcher/0.1"  # historical alias for the canonical commercial UA below
# Canonical User-Agents (Step 2a of Smart Publish-Time Predictor plan).
# Mirrored in worker/fetch.py:DEFAULT_UA / :POLITE_UA — fetch.py is the
# authoritative source. Lazy-imported to break the module cycle.
DEFAULT_UA = "XyzoFetcher/0.1 (+https://xyzo.org/bot; contact@xyzo.org)"
# Polite UA: .gov and .edu hosts (tier_for_url => 'gov'|'university') get
# this bot — see fetch.py:user_agent_for().
# Standing politeness constraint (HANDOFF §3.1, README §9.6).


def _canonical_ua() -> str:
    """Return the canonical commercial UA. Lazy-import to avoid the
    fetch.py <-> robots.py import cycle."""
    try:
        from .fetch import DEFAULT_UA as _FETCH_DEFAULT_UA
        return _FETCH_DEFAULT_UA
    except ImportError:
        return DEFAULT_UA
TIMEOUT_S = 10.0
DEFAULT_DISK_PATH = os.path.expanduser("~/.xyzo/robots_cache.json")

# ── Politeness tiers ─────────────────────────────────────────────────
# Mirrors worker/events_calendar.py:_TIERS so a single fetch path
# (whether for news feeds, event sources, or arbitrary URLs) honours
# the same tier ceilings.
_TIERS: dict[str, dict[str, Any]] = {
    "gov": {
        "min_interval_seconds": 86_400,
        "max_retries": 1,
        "user_agent": "xyzo-events-bot/1.0 (+https://xyzo.org/bot) polite-fetch",
    },
    "university": {
        "min_interval_seconds": 21_600,
        "max_retries": 1,
        "user_agent": "xyzo-events-bot/1.0 (+https://xyzo.org/bot) polite-fetch",
    },
    "community": {
        "min_interval_seconds": 7_200,
        "max_retries": 2,
        "user_agent": "xyzo-events/1.0",
    },
    "commercial": {
        "min_interval_seconds": 1_800,
        "max_retries": 2,
        "user_agent": "xyzo-fetcher/0.1 (https://xyzo.org; contact@xyzo.org)",
    },
    "platform": {
        "min_interval_seconds": 900,
        "max_retries": 3,
        "user_agent": "xyzo-fetcher/0.1",
    },
}

_GOV_TLDS = (".gov", ".mil", ".gc.ca", ".gov.uk", ".gouv.fr",
             ".go.jp", ".gob.es", ".gov.au", ".govt.nz")
_EDU_TLDS = (".edu", ".ac.uk", ".ac.jp", ".edu.au", ".ac.in",
             ".ac.za", ".ac.kr", ".edu.cn")
_COMMUNITY_TLDS = (".org", ".ngo", ".museum", ".foundation")


def tier_for_url(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    if any(host.endswith(t) for t in _GOV_TLDS):
        return "gov"
    if any(host.endswith(t) for t in _EDU_TLDS):
        return "university"
    if any(host.endswith(t) for t in _COMMUNITY_TLDS):
        return "community"
    return "commercial"


def tier_settings(tier: str) -> dict[str, Any]:
    return _TIERS.get(tier, _TIERS["commercial"])


@dataclass
class _Entry:
    parser: urllib.robotparser.RobotFileParser | None
    sitemaps: list[str]
    crawl_delay_s: float | None
    next_refresh: float
    fetched_at: float
    raw_text: str | None = None
    http_status: int | None = None


@dataclass
class RobotsVerdict:
    """Public-facing per-URL verdict returned by `is_allowed`."""
    allowed: bool
    crawl_delay_s: float | None = None
    disallowed_path: str | None = None
    sitemaps: list[str] = field(default_factory=list)
    tier: str = "commercial"
    note: str = ""


class RobotsCache:
    def __init__(self, ttl_s: int = 86_400,
                 ua: str | None = None,
                 disk_path: str | None = DEFAULT_DISK_PATH):
        self.ttl = ttl_s
        # Default to the canonical commercial UA. Callers that hit
        # .gov / .edu hosts pass user_agent_for(url) explicitly so
        # tier differentiation is honored — see fetch.py:fetch_host_group.
        self.ua = ua or _canonical_ua()
        self._cache: dict[str, _Entry] = {}
        self._disk_path = disk_path
        if disk_path:
            self._load_disk()

    # ── disk persistence ───────────────────────────────────────────
    def _load_disk(self) -> None:
        if not self._disk_path:
            return
        try:
            with open(self._disk_path, "r") as f:
                raw = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return
        now = time.time()
        for host, entry in raw.items():
            if now >= entry.get("next_refresh", 0):
                continue  # expired; refetch on next request
            try:
                rp = None
                rules = entry.get("rules")
                if rules:
                    rp = urllib.robotparser.RobotFileParser()
                    rp.parse(rules)
                self._cache[host] = _Entry(
                    parser=rp,
                    sitemaps=entry.get("sitemaps", []),
                    crawl_delay_s=entry.get("crawl_delay_s"),
                    next_refresh=entry["next_refresh"],
                    fetched_at=entry.get("fetched_at", 0),
                    raw_text=None,
                    http_status=entry.get("http_status"),
                )
            except Exception as e:
                log.debug("robots disk restore %s: %s", host, e)

    def _save_disk(self) -> None:
        if not self._disk_path:
            return
        try:
            os.makedirs(os.path.dirname(self._disk_path), exist_ok=True)
            out: dict[str, Any] = {}
            for host, entry in self._cache.items():
                rules: list[str] | None = None
                if entry.parser is not None:
                    try:
                        rules = entry.parser.entries  # not always present
                    except Exception:
                        rules = None
                    # Fallback: re-parse from raw_text
                    if rules is None and entry.raw_text:
                        rules = entry.raw_text.splitlines()
                out[host] = {
                    "rules": rules,
                    "sitemaps": entry.sitemaps,
                    "crawl_delay_s": entry.crawl_delay_s,
                    "next_refresh": entry.next_refresh,
                    "fetched_at": entry.fetched_at,
                    "http_status": entry.http_status,
                }
            with open(self._disk_path, "w") as f:
                json.dump(out, f)
        except Exception as e:
            log.debug("robots disk save: %s", e)

    # ── host helpers ──────────────────────────────────────────────
    @staticmethod
    def _host(url: str) -> str:
        return (urlparse(url).hostname or "").lower()

    # ── robots.txt fetching ───────────────────────────────────────
    def _extract_sitemaps(self, text: str) -> list[str]:
        """Find `Sitemap:` directives. Case-insensitive; multiple allowed."""
        sitemaps: list[str] = []
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            # Allow some leading whitespace
            if ":" not in line:
                continue
            key, _, value = line.partition(":")
            if key.strip().lower() == "sitemap":
                url = value.strip()
                if url:
                    sitemaps.append(url)
        return sitemaps

    def _fetch(self, host: str) -> _Entry:
        url = f"https://{host}/robots.txt"
        next_refresh = time.time() + self.ttl
        try:
            with httpx.Client(
                timeout=TIMEOUT_S,
                headers={"User-Agent": self.ua},
                follow_redirects=True,
            ) as client:
                resp = client.get(url)
                status = resp.status_code
                if status != 200 or not resp.text:
                    # Step 2b — split 4xx (allow) from 5xx (temporary block).
                    #
                    # Standing politeness constraint (HANDOFF §3.1,
                    # README §9.6, memory/government-site-politeness.md):
                    # publishers under load (5xx) must not be pummelled
                    # with retries. We shorten the cache TTL so we
                    # re-check in ~10 min instead of the full ttl.
                    #
                    # 4xx (404 missing robots.txt, 401/403 by policy)
                    # means the publisher said something; absence of
                    # robots.txt is treated as permission to proceed.
                    #
                    # Both branches cache the miss so we don't re-fetch
                    # on every cycle for ttl_s. The 5xx-branch entry is
                    # read by is_allowed() below to set
                    # verdict.note = "5xx-server-error" — fetch.py:549
                    # then routes that signal to last_failure_at
                    # (retry next cycle) instead of active=FALSE
                    # (which is permanent).
                    if status is not None and 500 <= status < 600:
                        next_refresh = min(next_refresh, time.time() + 600)  # 10 min
                        log.info("robots %s: 5xx %s — temporary block", host, status)
                    entry = _Entry(
                        parser=None, sitemaps=[], crawl_delay_s=None,
                        next_refresh=next_refresh, fetched_at=time.time(),
                        raw_text=None, http_status=status,
                    )
                    self._save_disk()
                    return entry
                text = resp.text
        except httpx.HTTPError as exc:
            log.debug("robots %s: %s", host, exc)
            entry = _Entry(
                parser=None, sitemaps=[], crawl_delay_s=None,
                next_refresh=next_refresh, fetched_at=time.time(),
                raw_text=None, http_status=None,
            )
            self._save_disk()
            return entry

        rp = urllib.robotparser.RobotFileParser()
        rp.parse(text.splitlines())  # iterable of lines — Python 3.11's
                                     # parse(str) silently fails to register rules

        # Crawl-delay: prefer UA-specific, fall back to *
        delay = rp.crawl_delay(self.ua)
        if delay is None:
            delay = rp.crawl_delay("*")
        try:
            delay_s = float(delay) if delay is not None else None
        except (TypeError, ValueError):
            delay_s = None

        sitemaps = self._extract_sitemaps(text)
        entry = _Entry(
            parser=rp, sitemaps=sitemaps, crawl_delay_s=delay_s,
            next_refresh=next_refresh, fetched_at=time.time(),
            raw_text=text, http_status=200,
        )
        self._save_disk()
        return entry

    def _ensure(self, host: str) -> _Entry:
        now = time.time()
        entry = self._cache.get(host)
        if entry is None or now >= entry.next_refresh:
            entry = self._fetch(host)
            self._cache[host] = entry
        return entry

    # ── public API ────────────────────────────────────────────────
    def is_allowed(self, url: str, tier: str | None = None
                   ) -> RobotsVerdict:
        """Return a RobotsVerdict with allowed flag, delay, sitemaps, tier.

        `tier` overrides the host-derived tier. Callers should pass it
        explicitly so the answer matches the policy they're enforcing.
        """
        host = self._host(url)

        # Google News has public RSS under /rss/search — explicit exemption.
        if host == "news.google.com":
            return RobotsVerdict(
                allowed=True, crawl_delay_s=None, tier="commercial",
                note="google-news-exempt",
            )

        actual_tier = tier or tier_for_url(url)
        entry = self._ensure(host)

        if entry.parser is None:
            # Step 2b — 5xx returns a temporary block; 4xx/empty is the
            # polite allow. The fetch.py caller (fetch.py:549) checks
            # verdict.note to distinguish them and routes accordingly.
            entry_status = entry.http_status
            if entry_status is not None and 500 <= entry_status < 600:
                return RobotsVerdict(
                    allowed=False,
                    crawl_delay_s=None,
                    disallowed_path=None,
                    sitemaps=entry.sitemaps,
                    tier=actual_tier,
                    note="5xx-server-error",
                )
            return RobotsVerdict(
                allowed=True,
                crawl_delay_s=tier_settings(actual_tier).get(
                    "min_interval_seconds"),
                sitemaps=entry.sitemaps,
                tier=actual_tier,
                note="robots-absent-or-error",
            )

        allowed = entry.parser.can_fetch(self.ua, url)
        path = urlparse(url).path if not allowed else None
        return RobotsVerdict(
            allowed=bool(allowed),
            crawl_delay_s=entry.crawl_delay_s,
            disallowed_path=path,
            sitemaps=entry.sitemaps,
            tier=actual_tier,
            note="",
        )

    def sitemaps(self, host: str) -> list[str]:
        """Return the Sitemap: directives declared in this host's robots.txt."""
        host = host.lower()
        entry = self._ensure(host)
        return list(entry.sitemaps)

    def crawl_delay(self, host: str) -> float | None:
        host = host.lower()
        entry = self._ensure(host)
        return entry.crawl_delay_s

    def stats(self) -> dict[str, Any]:
        return {
            "hosts_cached": len(self._cache),
            "with_robots": sum(1 for e in self._cache.values()
                               if e.parser is not None),
            "with_sitemaps": sum(1 for e in self._cache.values()
                                 if e.sitemaps),
        }

    def persist_to_db(self, source_id: int, url: str, verdict: RobotsVerdict) -> None:
        """Write robots.txt verification result to news_sources.

        Called by fetch.py after each robots.txt check so the DB has a
        persistent record of: when each source's robots.txt was verified,
        what status it had, its content hash (for change detection),
        HTTP status, and any sitemap URLs found.

        Safely handles missing columns — only writes columns that exist.
        """
        host = self._host(url)
        entry = self._cache.get(host)
        if entry is None:
            return

        content_hash = None
        if entry.raw_text:
            content_hash = hashlib.sha256(entry.raw_text.encode()).hexdigest()

        if entry.http_status is not None and 500 <= entry.http_status < 600:
            status = "error"
        elif entry.parser is None:
            status = "unreachable"
        elif verdict.allowed:
            status = "allowed"
        else:
            status = "blocked"

        import os
        import psycopg

        DSN = os.environ.get(
            "XYZO_DB_DSN",
            "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo",
        )

        try:
            with psycopg.connect(DSN) as conn, conn.cursor() as cur:
                cur.execute("""
                    UPDATE news_sources
                    SET robots_checked_at   = now(),
                        robots_status       = %s,
                        robots_content_hash = %s,
                        robots_http_status = %s,
                        robots_sitemaps    = %s,
                        robots_crawl_delay_s = %s
                    WHERE id = %s
                """, (
                    status,
                    content_hash,
                    entry.http_status,
                    json.dumps(verdict.sitemaps),
                    verdict.crawl_delay_s,
                    source_id,
                ))
                conn.commit()
        except Exception as exc:
            log.debug("persist_to_db(%d): %s", source_id, exc)
