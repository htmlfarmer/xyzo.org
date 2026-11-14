"""ai_extract — pull events out of arbitrary HTML.

Two extractors live here:

  1. **Heuristic extractor** — regex + date parsing + DOM-pattern
     matching. Works offline, no API calls. Cheap to run on every
     page; what we use by default.

  2. **Claude extractor** — sends a trimmed slice of the page to the
     Claude API and asks for structured JSON-LD-shaped events. Used
     when:
       • the heuristic extractor found 0 events on a high-priority
         page (e.g. /events, /calendar)
       • the user explicitly opts in via `use_ai=True`

The heuristic extractor looks for:

  • Date patterns in text: "Sat Oct 5, 2026", "October 5-7, 2026",
    "2026-10-05", "Oct 5 7:30 PM", "5 Oct 2026"
  • Headings that pair with dates within 200 characters
  • JSON-LD Event blocks (delegate to site_study.extract_event_json_ld)
  • Microdata itemtype="https://schema.org/Event"
  • Open Graph type="video.episode" or similar (sometimes misused for
    events)
  • Page sections that contain a date + a non-trivial title + a venue

The Claude extractor maps results back to the same dict shape so the
caller doesn't care which path produced them.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse

import httpx

from site_study import extract_event_json_ld

log = logging.getLogger("xyzo.ai_extract")

CLAUDE_MODEL = os.environ.get("XYZO_CLAUDE_MODEL", "claude-haiku-4-5")
CLAUDE_URL = "https://api.anthropic.com/v1/messages"
CLAUDE_TIMEOUT = 30.0
MAX_HTML_CHARS_FOR_AI = 60_000   # ~15k tokens


@dataclass
class ExtractedEvent:
    title: str
    description: str | None = None
    starts_at: dt.datetime | None = None
    ends_at: dt.datetime | None = None
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
    extraction: str = "heuristic"      # 'heuristic' | 'json_ld' | 'ai' | 'rss'
    confidence: float = 0.5
    raw: dict[str, Any] = field(default_factory=dict)


# ── Date parsing ─────────────────────────────────────────────────────
_DATE_PATTERNS: list[tuple[re.Pattern, str]] = [
    # ISO 8601 with time
    (re.compile(r"\b(20\d{2})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})\b"),
     "iso"),
    # ISO 8601 date only
    (re.compile(r"\b(20\d{2})-(\d{2})-(\d{2})\b"), "iso_date"),
    # "October 5, 2026" / "Oct 5 2026" / "Oct 5, 2026"
    (re.compile(r"\b(January|February|March|April|May|June|July|"
                r"August|September|October|November|December)\s+"
                r"(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b",
                re.IGNORECASE), "month_day_year"),
    # "5 October 2026" / "5 Oct 2026"
    (re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+"
                r"(January|February|March|April|May|June|July|"
                r"August|September|October|November|December)\s+"
                r"(20\d{2})\b", re.IGNORECASE), "day_month_year"),
    # "10/5/2026" US-style
    (re.compile(r"\b(\d{1,2})/(\d{1,2})/(20\d{2})\b"), "us_date"),
]

_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5,
    "june": 6, "july": 7, "august": 8, "september": 9,
    "october": 10, "november": 11, "december": 12,
}


def _parse_date(m: re.Match, kind: str) -> dt.datetime | None:
    try:
        if kind == "iso":
            y, mo, d, h, mi = (int(g) for g in m.groups())
            return dt.datetime(y, mo, d, h, mi, tzinfo=dt.timezone.utc)
        if kind == "iso_date":
            y, mo, d = (int(g) for g in m.groups())
            return dt.datetime(y, mo, d, tzinfo=dt.timezone.utc)
        if kind == "month_day_year":
            month_name, day, year = m.groups()
            mo = _MONTHS[month_name.lower()]
            return dt.datetime(int(year), mo, int(day),
                               tzinfo=dt.timezone.utc)
        if kind == "day_month_year":
            day, month_name, year = m.groups()
            mo = _MONTHS[month_name.lower()]
            return dt.datetime(int(year), mo, int(day),
                               tzinfo=dt.timezone.utc)
        if kind == "us_date":
            mo, d, y = (int(g) for g in m.groups())
            return dt.datetime(y, mo, d, tzinfo=dt.timezone.utc)
    except (ValueError, TypeError):
        return None
    return None


def find_dates(text: str, max_results: int = 50
               ) -> list[tuple[dt.datetime, int, int]]:
    """Return (datetime, char_start, char_end) for each parsed date.

    Sorted by position. Used to anchor event titles to dates.
    """
    found: list[tuple[dt.datetime, int, int]] = []
    for rgx, kind in _DATE_PATTERNS:
        for m in rgx.finditer(text):
            d = _parse_date(m, kind)
            if d is None:
                continue
            # Reject far-future or ancient dates (likely false positives)
            year = d.year
            if year < 2000 or year > 2100:
                continue
            found.append((d, m.start(), m.end()))
    # Deduplicate by char position
    seen: set[int] = set()
    unique: list[tuple[dt.datetime, int, int]] = []
    for d, s, e in sorted(found, key=lambda x: x[1]):
        if s in seen:
            continue
        seen.add(s)
        unique.append((d, s, e))
        if len(unique) >= max_results:
            break
    return unique


# ── Heuristic extractor ──────────────────────────────────────────────
_HEADING_RE = re.compile(
    r"<(h[1-6]|strong|b)\b[^>]*>(.*?)</\1>", re.IGNORECASE | re.DOTALL
)
_TAG_STRIP_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

# Strip tags + collapse whitespace + truncate
def _clean(s: str, max_len: int = 240) -> str:
    s = _TAG_STRIP_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    return s[:max_len]


def _slug_for_window(text: str, date_idx: int,
                     window: int = 240) -> str:
    """Pick a plausible event title near a date in `text`.

    Strategy: take ±window chars around the date, split on sentence-
    end punctuation or line breaks, pick the first sentence that's
    long enough to be a title and doesn't end with a date fragment.
    """
    start = max(0, date_idx - window)
    end = min(len(text), date_idx + window)
    snippet = _clean(text[start:end])
    # Split on . or ; or newline
    candidates = re.split(r"(?<=[.;\n])\s+", snippet)
    for c in candidates:
        c = c.strip()
        if 6 <= len(c) <= 200 and not re.match(r"^\d", c):
            return c
    return snippet[:200]


def heuristic_extract(html: str, source_url: str,
                      min_confidence: float = 0.4
                      ) -> list[ExtractedEvent]:
    """Pull events out of an HTML page using regex + date anchors.

    Returns events that are above `min_confidence`.
    """
    # 1) JSON-LD first — it's the cleanest signal
    json_ld_events = extract_event_json_ld(_safe_json_ld(html))
    out: list[ExtractedEvent] = []
    for ev in json_ld_events:
        e = _jsonld_to_event(ev, source_url)
        if e:
            e.extraction = "json_ld"
            e.confidence = 0.9
            out.append(e)

    # 2) Microdata itemtype="schema.org/Event"
    for ev in _extract_microdata(html, source_url):
        out.append(ev)

    # 3) Date-anchored heuristic — look at <h2>/<h3>/<strong> titles
    # paired with nearby dates.
    text = _clean(html, max_len=200_000)
    dates = find_dates(text)
    seen_titles: set[str] = set()
    for d, start, _ in dates:
        # Walk backward from the date to find a heading
        title = _find_preceding_heading(html, start) or _slug_for_window(
            text, start)
        title = title.strip()
        if not title or len(title) < 6 or len(title) > 220:
            continue
        key = title.lower()
        if key in seen_titles:
            continue
        seen_titles.add(key)
        out.append(ExtractedEvent(
            title=title,
            starts_at=d,
            extraction="heuristic",
            confidence=0.45,
            event_url=source_url,
            raw={"date_offset": start},
        ))
        if len(out) >= 60:
            break

    return [e for e in out if e.confidence >= min_confidence]


def _safe_json_ld(html: str) -> list[dict[str, Any]]:
    """Pull JSON-LD blocks. Wraps site_study's extractor safely."""
    try:
        from site_study import extract_json_ld
        return extract_json_ld(html)
    except Exception:
        return []


def _jsonld_to_event(ev: dict[str, Any], source_url: str
                     ) -> ExtractedEvent | None:
    title = ev.get("name") or ev.get("headline")
    if not title:
        return None
    description = ev.get("description")
    starts_at = _parse_iso(ev.get("startDate"))
    ends_at = _parse_iso(ev.get("endDate"))
    location = ev.get("location") or {}
    venue_name = None
    city = None
    country_code = None
    lat = lng = None
    if isinstance(location, dict):
        venue_name = location.get("name")
        addr = location.get("address") or {}
        if isinstance(addr, dict):
            city = addr.get("addressLocality")
            country_code = addr.get("addressCountry")
        geo = location.get("geo") or {}
        if isinstance(geo, dict):
            try:
                lat = float(geo.get("latitude")) if geo.get("latitude") is not None else None
                lng = float(geo.get("longitude")) if geo.get("longitude") is not None else None
            except (TypeError, ValueError):
                lat = lng = None
    image = ev.get("image")
    if isinstance(image, list):
        image = image[0] if image else None
    if isinstance(image, dict):
        image = image.get("url")
    organizer = ev.get("organizer") or {}
    org_name = organizer.get("name") if isinstance(organizer, dict) else None
    offers = ev.get("offers")
    is_free = None
    price_min = price_max = None
    currency = None
    if isinstance(offers, dict):
        offers = [offers]
    if isinstance(offers, list) and offers:
        try:
            price_min = min(float(o.get("price", 0)) for o in offers
                             if o.get("price") is not None)
            price_max = max(float(o.get("price", 0)) for o in offers
                            if o.get("price") is not None)
            currency = offers[0].get("priceCurrency")
            is_free = price_min == 0
        except (TypeError, ValueError):
            pass
    is_online = bool(ev.get("eventAttendanceMode", "")
                     .startswith("https://schema.org/Online"))
    return ExtractedEvent(
        title=title,
        description=description,
        starts_at=starts_at,
        ends_at=ends_at,
        venue_name=venue_name,
        city=city,
        country_code=country_code,
        lat=lat, lng=lng,
        image_url=image,
        price_min=price_min, price_max=price_max,
        currency=currency, is_free=is_free,
        is_online=is_online,
        organizer_name=org_name,
        event_url=ev.get("url") or source_url,
        raw=ev,
    )


def _extract_microdata(html: str, source_url: str) -> list[ExtractedEvent]:
    """Pull itemtype='schema.org/Event' microdata."""
    out: list[ExtractedEvent] = []
    for m in re.finditer(
        r'<[^>]*itemtype=["\']https?://schema\.org/Event["\'][^>]*>(.*?)</[^>]+>',
        html, re.IGNORECASE | re.DOTALL,
    ):
        block = m.group(1)
        title_m = re.search(r'itemprop=["\']name["\'][^>]*>([^<]+)<',
                            block, re.IGNORECASE)
        start_m = re.search(r'itemprop=["\']startDate["\'][^>]*content=["\']([^"\']+)["\']',
                            block, re.IGNORECASE)
        if not title_m:
            continue
        out.append(ExtractedEvent(
            title=_clean(title_m.group(1)),
            starts_at=_parse_iso(start_m.group(1)) if start_m else None,
            extraction="heuristic",
            confidence=0.55,
            event_url=source_url,
        ))
    return out


def _find_preceding_heading(html: str, char_offset: int
                            ) -> str | None:
    """Walk backward through `html` from `char_offset` to find a heading."""
    snippet = html[max(0, char_offset - 1500):char_offset]
    # Take the last heading we find in the snippet
    last: str | None = None
    for m in _HEADING_RE.finditer(snippet):
        last = _clean(m.group(2))
    return last


def _parse_iso(value: Any) -> dt.datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        s = value.replace("Z", "+00:00")
        d = dt.datetime.fromisoformat(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=dt.timezone.utc)
        return d
    except ValueError:
        return None


# ── Claude extractor ─────────────────────────────────────────────────
def ai_extract(html: str, source_url: str,
               model: str = CLAUDE_MODEL,
               api_key: str | None = None) -> list[ExtractedEvent]:
    """Ask Claude to extract events from a page. Best-effort."""
    api_key = api_key or os.environ.get("XYZO_CLAUDE_API_KEY")
    if not api_key:
        return []

    # Trim the HTML: drop scripts, styles, comments, long whitespace.
    trimmed = _trim_html_for_ai(html)
    if len(trimmed) > MAX_HTML_CHARS_FOR_AI:
        trimmed = trimmed[:MAX_HTML_CHARS_FOR_AI]

    prompt = (
        "Extract upcoming events from this HTML page. For each event "
        "return one JSON object with these keys: "
        "title (required), description, startDate (ISO 8601), endDate, "
        "venueName, city, countryCode (2-letter), imageUrl, isFree, "
        "price, currency, isOnline, eventUrl, organizerName. "
        "If the page lists no events, return an empty array. "
        "Respond with a JSON array only — no commentary, no markdown.\n\n"
        f"PAGE URL: {source_url}\n\n"
        f"HTML (trimmed):\n{trimmed}"
    )
    body = {
        "model": model,
        "max_tokens": 4000,
        "messages": [{"role": "user", "content": prompt}],
    }
    try:
        with httpx.Client(timeout=CLAUDE_TIMEOUT) as c:
            resp = c.post(
                CLAUDE_URL,
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                content=json.dumps(body),
            )
        if resp.status_code != 200:
            log.warning("claude extract %s: %d", source_url, resp.status_code)
            return []
        data = resp.json()
        text = "".join(
            blk.get("text", "") for blk in data.get("content", [])
            if blk.get("type") == "text"
        )
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
        parsed = json.loads(text)
        if not isinstance(parsed, list):
            return []
    except Exception as e:
        log.warning("claude extract %s: %s", source_url, e)
        return []

    out: list[ExtractedEvent] = []
    for raw in parsed:
        if not isinstance(raw, dict):
            continue
        title = raw.get("title")
        if not title:
            continue
        try:
            price = float(raw["price"]) if raw.get("price") is not None else None
        except (TypeError, ValueError):
            price = None
        out.append(ExtractedEvent(
            title=str(title).strip(),
            description=raw.get("description"),
            starts_at=_parse_iso(raw.get("startDate")),
            ends_at=_parse_iso(raw.get("endDate")),
            venue_name=raw.get("venueName"),
            city=raw.get("city"),
            country_code=raw.get("countryCode"),
            image_url=raw.get("imageUrl"),
            is_free=raw.get("isFree"),
            price_min=price, price_max=price,
            currency=raw.get("currency"),
            is_online=bool(raw.get("isOnline")),
            event_url=raw.get("eventUrl") or source_url,
            organizer_name=raw.get("organizerName"),
            extraction="ai",
            confidence=0.7,
            raw=raw,
        ))
    return out


_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style|noscript|svg)\b[^>]*>.*?</\1>",
    re.IGNORECASE | re.DOTALL,
)
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


def _trim_html_for_ai(html: str) -> str:
    """Drop noisy tags so the page fits in the prompt."""
    html = _COMMENT_RE.sub(" ", html)
    html = _SCRIPT_STYLE_RE.sub(" ", html)
    html = _TAG_STRIP_RE.sub(" ", html)
    html = _WS_RE.sub(" ", html)
    return html.strip()
