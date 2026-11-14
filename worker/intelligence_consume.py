"""Pure-Python consumer of site intelligence into crawl hints.

This module performs no I/O: it only translates an intelligence mapping and
scores URLs against the resulting hints.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class FeedRef:
    href: str
    type: str
    title: str = ""
    detection: str = ""
    confidence: float = 0.0

    def __getitem__(self, key: str):
        return getattr(self, key)


@dataclass
class CrawlHints:
    feeds_to_subscribe: list[FeedRef] = field(default_factory=list)
    extra_seeds: list[str] = field(default_factory=list)
    avoided_paths: list[re.Pattern] = field(default_factory=list)
    preferred_extractor_per_url: dict[str, str] = field(default_factory=dict)
    skip_extractors: dict[str, list[str]] = field(default_factory=dict)
    crawl_window_utc: list[tuple[int, int]] = field(default_factory=list)
    min_request_interval_s: float = 1.0
    js_only_paths: list[re.Pattern] = field(default_factory=list)
    primary_language: str = "en"
    language_variants: dict[str, str] = field(default_factory=dict)
    field_winners: dict[str, str] = field(default_factory=dict)
    json_ld_types: list[str] = field(default_factory=list)
    microdata_itemtypes: list[str] = field(default_factory=list)
    date_formats_seen: list[str] = field(default_factory=list)
    taxonomy: dict = field(default_factory=dict)
    url_score_adjustments: dict[str, float] = field(default_factory=dict)


def parse_intelligence_to_hints(intel: dict) -> CrawlHints:
    """Translate a site-intelligence mapping into actionable crawl hints."""
    hints = CrawlHints()
    if not isinstance(intel, dict) or not intel:
        return hints

    for feed in intel.get("feeds") or []:
        if isinstance(feed, dict) and feed.get("href"):
            hints.feeds_to_subscribe.append(FeedRef(
                href=str(feed["href"]), type=str(feed.get("type", "")),
                title=str(feed.get("title", "")),
                detection=str(feed.get("detection", "")),
                confidence=float(feed.get("confidence", 0.0) or 0.0),
            ))

    for entry in intel.get("structural_map") or []:
        if not isinstance(entry, dict):
            continue
        pattern = str(entry.get("pattern") or "")
        if not pattern:
            continue
        confidence = float(entry.get("confidence", 0.5) or 0.0)
        kind = entry.get("kind", "listing")
        if kind == "listing" and confidence >= 0.6:
            hints.extra_seeds.extend(entry.get("examples") or [pattern])
        # Administrative/authentication areas are intentionally avoided even
        # when the structural classifier is reasonably confident.
        if confidence < 0.5 or re.search(r"/(?:admin|login|logout)(?:/|$)", pattern, re.I):
            hints.avoided_paths.append(re.compile(_wildcard_to_regex(pattern)))
        if confidence >= 0.8:
            hints.url_score_adjustments[pattern] = 0.5

    politics = intel.get("politics") or {}
    for path in politics.get("js_only_pages") or []:
        hints.js_only_paths.append(re.compile(_wildcard_to_regex(str(path))))
    for window in politics.get("best_crawl_window_utc") or []:
        text = str(window)
        if "-" not in text:
            continue
        start, end = text.split("-", 1)
        try:
            hints.crawl_window_utc.append((int(start.split(":")[0]), int(end.split(":")[0])))
        except (ValueError, IndexError):
            continue
    hints.primary_language = politics.get("language_primary") or "en"
    hints.language_variants = politics.get("language_variants") or {}
    hints.taxonomy = politics.get("taxonomy") or {}

    fingerprint = intel.get("sd_fingerprint") or {}
    hints.json_ld_types = fingerprint.get("json_ld_types") or []
    hints.microdata_itemtypes = fingerprint.get("microdata_itemtypes") or []
    hints.date_formats_seen = fingerprint.get("date_formats_seen") or []
    return hints


def url_adjustment(url: str, hints: CrawlHints) -> float:
    """Return the additive crawl score adjustment for *url*."""
    score = 0.0
    for pattern, boost in hints.url_score_adjustments.items():
        if re.search(_wildcard_to_regex(pattern), url):
            score += boost
    score -= 2.0 * sum(1 for pattern in hints.avoided_paths if pattern.search(url))
    score -= 2.0 * sum(1 for pattern in hints.js_only_paths if pattern.search(url))
    return score


def _wildcard_to_regex(pattern: str) -> str:
    """Convert URL placeholders (such as ``{slug}``) to regex fragments."""
    escaped = re.escape(pattern)
    for name, fragment in {
        "slug": r"[^/]+", "year": r"\d{4}", "month": r"\d{1,2}",
    }.items():
        escaped = escaped.replace(r"\{" + name + r"\}", fragment)
    return escaped
