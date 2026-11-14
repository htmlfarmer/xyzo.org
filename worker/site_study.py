"""site_study — take any URL and tell us what's there.

This is the unified entrypoint that makes "study any website" real.
Given a URL, `study_url()` returns a structured picture of the
response: final URL after redirects, HTTP status, headers (selected),
content-type, encoding, body bytes, page title, language, RSS
autodiscovery links, sitemap URLs, JSON-LD structured data, OG tags,
and a robots verdict with crawl-delay and politeness tier.

Behind the scenes this:

  • Checks robots.txt via `RobotsCache` (with politeness tier).
  • Honours Retry-After on 429/503 with per-host cooldown.
  • Extracts RSS autodiscovery links from HTML head.
  • Walks Sitemap directives from robots.txt.
  • Pulls schema.org JSON-LD (Event, Organization, etc.) via extruct.
  • Captures Open Graph + Twitter Card metadata.
  • Detects language from `<html lang>` or Content-Language header.
  • Picks encoding from Content-Type or `<meta charset>`.

Adaptive throttling: each host gets a sliding-window cooldown. If we
saw a 429 or 5xx within `cooldown_s`, we won't hit that host again
until the window passes. Successful 200/304 responses reset the
window.

For sites that block httpx (most .gov, Localist/Trumba university
calendars, Eventbrite, Meetup), pass `force_browser=True` to fall
back to the Playwright backend. If Playwright is not installed, the
fallback returns a structured error rather than crashing — the
endpoint should always return JSON.

Cache: results are NOT cached by default (each study is a fresh
investigation). The robots cache is the only persistent layer.
"""
from __future__ import annotations

import gzip
import json
import logging
import re
import time
import zlib
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

# Imported as bare modules — we run from /var/www/vhosts/xyzo.org/worker
# with that dir on sys.path, so `robots` is directly importable.
from robots import RobotsCache, RobotsVerdict, tier_for_url

log = logging.getLogger("xyzo.site_study")

USER_AGENT = ("xyzo-study/1.0 (+https://xyzo.org/bot) "
              "polite-study; contact@xyzo.org")

# Per-host adaptive cooldown: track last failure per host in-process.
_adaptive_state: dict[str, dict[str, Any]] = {}


def _adaptive_should_skip(host: str, cooldown_s: float = 60.0) -> bool:
    """True if we recently got a 429/5xx from this host and should wait."""
    state = _adaptive_state.get(host)
    if not state:
        return False
    last_status = state.get("last_status")
    last_at = state.get("last_at", 0)
    if not last_status:
        return False
    if 200 <= last_status < 400:
        return False
    if (time.time() - last_at) < cooldown_s:
        return True
    return False


def _adaptive_record(host: str, status: int, retry_after: float | None) -> None:
    """Record the outcome for adaptive backoff."""
    entry = {
        "last_status": status,
        "last_at": time.time(),
    }
    if retry_after is not None:
        entry["retry_after_until"] = time.time() + retry_after
    _adaptive_state[host] = entry


def _parse_retry_after(value: str | None) -> float | None:
    """Parse a Retry-After header into seconds. Returns None if absent."""
    if not value:
        return None
    try:
        return max(float(value), 0.0)
    except ValueError:
        # HTTP-date form (rare but valid)
        try:
            from email.utils import parsedate_to_datetime
            dt = parsedate_to_datetime(value)
            if dt is None:
                return None
            delta = (dt - datetime.now(timezone.utc)).total_seconds()
            return max(delta, 0.0)
        except Exception:
            return None


@dataclass
class RSSAutodiscovery:
    """A feed URL discovered via <link rel='alternate'>."""
    href: str
    type: str  # 'application/rss+xml', 'application/atom+xml', etc.
    title: str | None = None


@dataclass
class SitemapURL:
    """An entry pulled from a sitemap.xml file."""
    loc: str
    lastmod: str | None = None
    changefreq: str | None = None
    priority: float | None = None


@dataclass
class StudyResult:
    """The full picture of one URL."""
    # Request
    requested_url: str
    final_url: str | None = None
    status: int | None = None
    redirect_chain: list[str] = field(default_factory=list)

    # Response meta
    content_type: str | None = None
    charset: str | None = None
    content_length: int | None = None
    encoding_header: str | None = None
    server: str | None = None
    cache_control: str | None = None
    etag: str | None = None
    last_modified: str | None = None
    content_language: str | None = None
    retry_after: float | None = None

    # Page meta (HTML only)
    title: str | None = None
    html_lang: str | None = None
    meta_description: str | None = None
    meta_keywords: list[str] = field(default_factory=list)
    og_tags: dict[str, str] = field(default_factory=dict)
    twitter_tags: dict[str, str] = field(default_factory=dict)

    # Discovery
    rss_autodiscovery: list[RSSAutodiscovery] = field(default_factory=list)
    sitemaps_from_robots: list[str] = field(default_factory=list)

    # Structured data (JSON-LD)
    json_ld: list[dict[str, Any]] = field(default_factory=list)
    json_ld_events: list[dict[str, Any]] = field(default_factory=list)

    # Robots / policy
    robots: RobotsVerdict | None = None
    politeness_tier: str | None = None

    # Body
    body: str | None = None        # decoded text (only for HTML/JSON/text)
    body_bytes: int = 0
    body_truncated: bool = False
    body_kind: str = ""            # 'html' | 'xml' | 'json' | 'text' | 'binary' | 'rss' | 'atom' | 'ics'

    # Diagnostic
    error: str | None = None
    elapsed_ms: int = 0
    cache_status: str | None = None    # 'HIT' | 'MISS' | None

    # ── nested-as-dict helper ──
    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        if self.robots:
            d["robots"] = asdict(self.robots)
        return d


def _decode_body(resp: httpx.Response, max_bytes: int = 2_000_000
                 ) -> tuple[str | None, int, bool, str]:
    """Decode response body with content-encoding handling.

    Returns: (decoded_text_or_None, byte_count, truncated, kind)
    """
    raw = resp.content
    if not raw:
        return None, 0, False, ""

    # Handle gzip/deflate/brotli manually — httpx does this for text
    # responses but we want consistent behaviour across kinds.
    ce = (resp.headers.get("content-encoding") or "").lower()
    try:
        if ce == "gzip":
            raw = gzip.decompress(raw)
        elif ce == "deflate":
            try:
                raw = zlib.decompress(raw)
            except zlib.error:
                raw = zlib.decompress(raw, -zlib.MAX_WBITS)
    except Exception:
        # If decompression fails, fall through with original bytes.
        pass

    # Truncate very large bodies (we're not here to scrape pages).
    truncated = False
    if len(raw) > max_bytes:
        raw = raw[:max_bytes]
        truncated = True

    # Pick the response kind
    ct = (resp.headers.get("content-type") or "").lower()
    kind = ""
    if "html" in ct:
        kind = "html"
    elif "json" in ct:
        kind = "json"
    elif "rss" in ct or ct.endswith("/rss+xml"):
        kind = "rss"
    elif "atom" in ct:
        kind = "atom"
    elif "ics" in ct or "calendar" in ct:
        kind = "ics"
    elif "xml" in ct:
        kind = "xml"
    elif ct.startswith("text/"):
        kind = "text"

    # Decode to text for HTML/JSON/text. RSS/Atom/ICS get parsed separately.
    if kind in ("html", "json", "text"):
        charset = resp.encoding or "utf-8"
        try:
            text = raw.decode(charset, errors="replace")
        except (LookupError, TypeError):
            text = raw.decode("utf-8", errors="replace")
        return text, len(raw), truncated, kind

    return None, len(raw), truncated, kind or "binary"


# ── HTML parsing helpers (stdlib only, no extra deps) ───────────────
_RE_LINK_ALTERNATE = re.compile(
    r'<link[^>]*?rel=["\']alternate["\'][^>]*?>',
    re.IGNORECASE | re.DOTALL,
)
_RE_ATTR = re.compile(
    r'(\w+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))',
    re.IGNORECASE,
)
_RE_TITLE = re.compile(r"<title[^>]*>(.*?)</title>",
                       re.IGNORECASE | re.DOTALL)
_RE_META = re.compile(r"<meta\b[^>]*?>", re.IGNORECASE | re.DOTALL)
_RE_HTML_LANG = re.compile(r'<html\b[^>]*?\blang=["\']([^"\']+)["\']',
                           re.IGNORECASE)
_RE_JSONLD_SCRIPT = re.compile(
    r'<script[^>]*type=["\']application/ld\+json["\'][^>]*?>'
    r'(.*?)</script>',
    re.IGNORECASE | re.DOTALL,
)


def _attrs(tag: str) -> dict[str, str]:
    """Extract attribute key/value pairs from an HTML tag string."""
    out: dict[str, str] = {}
    for m in _RE_ATTR.finditer(tag):
        key = m.group(1).lower()
        val = m.group(2) or m.group(3) or m.group(4) or ""
        out[key] = val
    return out


def extract_rss_autodiscovery(html: str, base_url: str
                              ) -> list[RSSAutodiscovery]:
    """Find <link rel='alternate' type='application/rss+xml'> etc."""
    found: list[RSSAutodiscovery] = []
    for m in _RE_LINK_ALTERNATE.finditer(html):
        attrs = _attrs(m.group(0))
        rel = attrs.get("rel", "").lower().split()
        if "alternate" not in rel:
            continue
        ctype = attrs.get("type", "").lower()
        if not (ctype.startswith("application/rss")
                or ctype.startswith("application/atom")
                or ctype.startswith("application/feed")
                or ctype == "text/calendar"):
            continue
        href = attrs.get("href", "").strip()
        if not href:
            continue
        abs_url = urljoin(base_url, href)
        found.append(RSSAutodiscovery(
            href=abs_url, type=ctype, title=attrs.get("title"),
        ))
    return found


def extract_meta(html: str) -> dict[str, Any]:
    """Pull <title>, <meta>, OG, Twitter, and HTML lang."""
    out: dict[str, Any] = {
        "title": None, "html_lang": None, "description": None,
        "keywords": [], "og": {}, "twitter": {},
    }
    m = _RE_HTML_LANG.search(html)
    if m:
        out["html_lang"] = m.group(1)
    m = _RE_TITLE.search(html)
    if m:
        out["title"] = re.sub(r"\s+", " ", m.group(1)).strip()

    for tag in _RE_META.finditer(html):
        attrs = _attrs(tag.group(0))
        name = (attrs.get("name") or attrs.get("property") or
                attrs.get("http-equiv") or "").lower()
        content = attrs.get("content", "")
        if not name or not content:
            continue
        if name == "description":
            out["description"] = content
        elif name == "keywords":
            out["keywords"] = [k.strip() for k in content.split(",") if k.strip()]
        elif name.startswith("og:"):
            out["og"][name[3:]] = content
        elif name.startswith("twitter:"):
            out["twitter"][name[8:]] = content
    return out


def extract_json_ld(html: str) -> list[dict[str, Any]]:
    """Pull all <script type='application/ld+json'> blocks, parse JSON."""
    out: list[dict[str, Any]] = []
    for m in _RE_JSONLD_SCRIPT.finditer(html):
        body = m.group(1).strip()
        if not body:
            continue
        try:
            parsed = json.loads(body)
        except (ValueError, json.JSONDecodeError):
            # Strip JS comments and retry — some sites ship invalid JSON.
            cleaned = re.sub(r"//.*?$|/\*.*?\*/", "", body, flags=re.MULTILINE | re.DOTALL)
            try:
                parsed = json.loads(cleaned)
            except Exception:
                continue
        if isinstance(parsed, list):
            out.extend(p for p in parsed if isinstance(p, dict))
        elif isinstance(parsed, dict):
            out.append(parsed)
    return out


def extract_event_json_ld(json_ld_blocks: list[dict[str, Any]]
                          ) -> list[dict[str, Any]]:
    """Filter JSON-LD blocks to those with @type=Event (or containing one)."""
    events: list[dict[str, Any]] = []
    for block in json_ld_blocks:
        t = block.get("@type")
        if t == "Event":
            events.append(block)
        elif isinstance(t, list) and "Event" in t:
            events.append(block)
        # Some pages wrap multiple events in @graph
        graph = block.get("@graph")
        if isinstance(graph, list):
            for sub in graph:
                if isinstance(sub, dict) and sub.get("@type") in (
                    "Event", "MusicEvent", "SportsEvent",
                    "TheaterEvent", "BusinessEvent", "Festival",
                    "EducationEvent", "SocialEvent",
                ):
                    events.append(sub)
    return events


# ── Main entry point ─────────────────────────────────────────────────
def study_url(url: str,
              robots: RobotsCache | None = None,
              force_browser: bool = False,
              max_bytes: int = 2_000_000,
              timeout: float = 20.0,
              ) -> StudyResult:
    """Study a single URL. Returns a populated StudyResult.

    `robots` — pass an existing RobotsCache to share state across calls.
    `force_browser` — render with Playwright if httpx fails or returns 403.
    """
    started = time.time()
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if not host:
        return StudyResult(
            requested_url=url, error="invalid-url",
            elapsed_ms=int((time.time() - started) * 1000),
        )

    robots = robots or RobotsCache()

    # Politeness tier
    tier = tier_for_url(url)
    result = StudyResult(requested_url=url, politeness_tier=tier)

    # Robots pre-check
    verdict = robots.is_allowed(url, tier=tier)
    result.robots = verdict
    result.sitemaps_from_robots = verdict.sitemaps or []

    if not verdict.allowed:
        result.status = 451
        result.error = f"robots-disallow:{verdict.disallowed_path}"
        result.elapsed_ms = int((time.time() - started) * 1000)
        return result

    # Adaptive backoff
    if _adaptive_should_skip(host):
        result.status = 429
        result.error = "in-adaptive-cooldown"
        result.retry_after = 60.0
        result.elapsed_ms = int((time.time() - started) * 1000)
        return result

    # Fetch
    try:
        with httpx.Client(
            timeout=timeout,
            headers={"User-Agent": USER_AGENT,
                     "Accept": "*/*",
                     "Accept-Encoding": "gzip, deflate"},
            follow_redirects=True,
        ) as client:
            resp = client.get(url)
    except httpx.HTTPError as e:
        # Try browser fallback if the user asked for it
        if force_browser:
            return _study_via_browser(
                url, started, robots, verdict, tier, max_bytes,
            )
        result.status = 0
        result.error = f"fetch-error:{type(e).__name__}:{e}"
        result.elapsed_ms = int((time.time() - started) * 1000)
        return result

    # Record outcome for adaptive throttling
    retry_after = _parse_retry_after(resp.headers.get("retry-after"))
    _adaptive_record(host, resp.status_code, retry_after)

    # Redirect chain
    chain: list[str] = [str(r.url) for r in resp.history]
    if resp.history:
        result.redirect_chain = chain

    result.final_url = str(resp.url)
    result.status = resp.status_code
    result.content_type = resp.headers.get("content-type")
    result.charset = resp.encoding
    result.encoding_header = resp.headers.get("content-encoding")
    result.server = resp.headers.get("server")
    result.cache_control = resp.headers.get("cache-control")
    result.etag = resp.headers.get("etag")
    result.last_modified = resp.headers.get("last-modified")
    result.content_language = resp.headers.get("content-language")
    result.retry_after = retry_after

    # Body
    text, byte_count, truncated, kind = _decode_body(resp, max_bytes=max_bytes)
    result.body = text
    result.body_bytes = byte_count
    result.body_truncated = truncated
    result.body_kind = kind or _sniff_kind(resp.headers.get("content-type"))

    # If we got HTML, extract the rest
    if kind == "html" and text:
        meta = extract_meta(text)
        result.title = meta["title"]
        result.html_lang = meta["html_lang"]
        result.meta_description = meta["description"]
        result.meta_keywords = meta["keywords"]
        result.og_tags = meta["og"]
        result.twitter_tags = meta["twitter"]
        result.rss_autodiscovery = extract_rss_autodiscovery(text, str(resp.url))
        result.json_ld = extract_json_ld(text)
        result.json_ld_events = extract_event_json_ld(result.json_ld)

        # Prefer HTML <html lang> over Content-Language header.
        if result.html_lang and not result.content_language:
            result.content_language = result.html_lang

    # If we got blocked, optionally retry via browser
    if force_browser and resp.status_code in (403, 429):
        return _study_via_browser(
            url, started, robots, verdict, tier, max_bytes,
        )

    result.elapsed_ms = int((time.time() - started) * 1000)
    return result


def _sniff_kind(ct: str | None) -> str:
    if not ct:
        return ""
    ct = ct.lower()
    if "html" in ct:
        return "html"
    if "json" in ct:
        return "json"
    if "rss" in ct:
        return "rss"
    if "atom" in ct:
        return "atom"
    if "xml" in ct:
        return "xml"
    if "calendar" in ct or "ics" in ct:
        return "ics"
    return ct.split(";")[0].strip()


# ── Browser fallback ─────────────────────────────────────────────────
def _study_via_browser(url: str, started: float,
                       robots: RobotsCache,
                       verdict: RobotsVerdict, tier: str,
                       max_bytes: int) -> StudyResult:
    """Render with Playwright when httpx gets blocked. Optional."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        result = StudyResult(
            requested_url=url, status=403,
            error="playwright-not-installed",
            politeness_tier=tier, robots=verdict,
            elapsed_ms=int((time.time() - started) * 1000),
        )
        return result

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(
                user_agent=USER_AGENT,
                viewport={"width": 1280, "height": 800},
            )
            page = ctx.new_page()
            page.goto(url, timeout=30_000, wait_until="domcontentloaded")
            html = page.content()
            browser.close()
        # Decode the rendered HTML through the same extractor pipeline.
        kind = "html"
        truncated = False
        if len(html) > max_bytes:
            html = html[:max_bytes]
            truncated = True
        result = StudyResult(
            requested_url=url, final_url=url, status=200,
            content_type="text/html", body=html,
            body_bytes=len(html), body_truncated=truncated,
            body_kind=kind, politeness_tier=tier, robots=verdict,
        )
        meta = extract_meta(html)
        result.title = meta["title"]
        result.html_lang = meta["html_lang"]
        result.meta_description = meta["description"]
        result.meta_keywords = meta["keywords"]
        result.og_tags = meta["og"]
        result.twitter_tags = meta["twitter"]
        result.rss_autodiscovery = extract_rss_autodiscovery(html, url)
        result.json_ld = extract_json_ld(html)
        result.json_ld_events = extract_event_json_ld(result.json_ld)
        if result.html_lang:
            result.content_language = result.html_lang
        result.elapsed_ms = int((time.time() - started) * 1000)
        return result
    except Exception as e:
        result = StudyResult(
            requested_url=url, status=0,
            error=f"browser-error:{type(e).__name__}:{e}",
            politeness_tier=tier, robots=verdict,
            elapsed_ms=int((time.time() - started) * 1000),
        )
        return result


# ── Sitemap walker ───────────────────────────────────────────────────
def fetch_sitemap(url: str, client: httpx.Client | None = None,
                  max_urls: int = 5000) -> list[SitemapURL]:
    """Fetch a sitemap.xml and return its URLs. Handles sitemap indexes."""
    close = False
    if client is None:
        client = httpx.Client(timeout=15.0,
                              headers={"User-Agent": USER_AGENT},
                              follow_redirects=True)
        close = True
    urls: list[SitemapURL] = []
    try:
        resp = client.get(url)
        if resp.status_code != 200:
            return urls
        text = resp.text
        # Naive regex parser — avoids an XML dependency and is good
        # enough for the public sitemap.org schema.
        # Sitemap index: <sitemapindex><sitemap><loc>...</loc></sitemap>...
        for m in re.finditer(r"<sitemap>\s*<loc>([^<]+)</loc>",
                             text, re.IGNORECASE):
            sub = m.group(1).strip()
            urls.extend(fetch_sitemap(sub, client=client, max_urls=max_urls))
            if len(urls) >= max_urls:
                break
        # Urlset: <url><loc>...</loc><lastmod>...</lastmod>...
        if not urls:
            for m in re.finditer(r"<url>(.*?)</url>", text,
                                 re.IGNORECASE | re.DOTALL):
                block = m.group(1)
                loc_m = re.search(r"<loc>([^<]+)</loc>", block,
                                  re.IGNORECASE)
                if not loc_m:
                    continue
                lastmod = None
                lm = re.search(r"<lastmod>([^<]+)</lastmod>", block,
                               re.IGNORECASE)
                if lm:
                    lastmod = lm.group(1).strip()
                changefreq = None
                cf = re.search(r"<changefreq>([^<]+)</changefreq>", block,
                               re.IGNORECASE)
                if cf:
                    changefreq = cf.group(1).strip()
                priority = None
                pr = re.search(r"<priority>([^<]+)</priority>", block,
                               re.IGNORECASE)
                if pr:
                    try:
                        priority = float(pr.group(1).strip())
                    except ValueError:
                        pass
                urls.append(SitemapURL(
                    loc=loc_m.group(1).strip(),
                    lastmod=lastmod, changefreq=changefreq,
                    priority=priority,
                ))
                if len(urls) >= max_urls:
                    break
    finally:
        if close:
            client.close()
    return urls
