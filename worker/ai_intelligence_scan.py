"""ai_intelligence_scan — tier-budgeted Claude scan that produces
structured site intelligence JSON.

Exports:
- ScanBudget: pages_max, tokens_in_max, tokens_out_max, model, ...
- TIER_BUDGETS: per-tier ScanBudget
- budget_for_tier(): returns ScanBudget, falls back to commercial
- total_pages_in_budget(): counts pages including sitemap
- needs_refresh(): staleness/drift decision for re-running the scan
- ai_intelligence_scan(): main function (added in Task 11)
"""
from __future__ import annotations

from dataclasses import dataclass
import datetime as dt
import logging

log = logging.getLogger("xyzo.ai_intelligence_scan")


@dataclass(frozen=True)
class ScanBudget:
    pages_max: int
    tokens_in_max: int
    tokens_out_max: int
    model: str
    use_sitemap: bool
    use_heuristics_pre: bool


# Per-tier budgets. Gov/university cheap, commercial deep, others
# medium. The numbers reflect: 1k chars ~ 250 tokens of HTML.
TIER_BUDGETS: dict[str, ScanBudget] = {
    "gov":        ScanBudget(2,  15_000, 2_000, "claude-haiku-4-5",
                             use_sitemap=True, use_heuristics_pre=True),
    "university": ScanBudget(2,  15_000, 2_000, "claude-haiku-4-5",
                             use_sitemap=True, use_heuristics_pre=True),
    "community":  ScanBudget(4,  40_000, 4_000, "claude-haiku-4-5",
                             use_sitemap=True, use_heuristics_pre=True),
    "commercial": ScanBudget(6,  80_000, 6_000, "claude-sonnet-5",
                             use_sitemap=True, use_heuristics_pre=True),
    "platform":   ScanBudget(4,  40_000, 4_000, "claude-haiku-4-5",
                             use_sitemap=True, use_heuristics_pre=True),
    "user":       ScanBudget(3,  30_000, 3_000, "claude-haiku-4-5",
                             use_sitemap=True, use_heuristics_pre=True),
}


def budget_for_tier(tier: str) -> ScanBudget:
    """Return the ScanBudget for a tier. Falls back to commercial."""
    return TIER_BUDGETS.get(tier, TIER_BUDGETS["commercial"])


def total_pages_in_budget(tier: str) -> int:
    """Count pages the scan will fetch. Sitemap = 1 page."""
    b = budget_for_tier(tier)
    return b.pages_max + (1 if b.use_sitemap else 0)


def needs_refresh(
    record: dict | None,
    host: str,
    now: dt.datetime | None = None,
    max_age_days: int = 30,
    min_confidence: float = 0.5,
    max_consecutive_errors: int = 3,
    feed_survival_threshold: float = 0.5,
    path_yield_threshold: float = 0.4,
) -> tuple[bool, str]:
    """Decide whether to re-run the AI scan for this host.

    Returns (needs_refresh: bool, reason: str).
    Stale or missing records return True.
    Fresh records return False.

    Priority order:
      1. record is None                         -> True, "no-record"
      2. consecutive_errors >= max_consecutive  -> True, "errors=N"
      3. age > max_age_days                     -> True, "age=Nd"
      4. confidence < min_confidence            -> True, "low-conf=X"
      5. feed_survival < threshold              -> True, "feed-drift=X"
      6. path_yield < threshold                 -> True, "path-drift"
      7. else                                   -> False, "fresh"
    """
    if record is None:
        log.debug("needs_refresh(%s): %s", host, "no-record")
        return (True, "no-record")

    now = now or dt.datetime.now(dt.timezone.utc)

    errs = int(record.get("consecutive_errors", 0) or 0)
    if errs >= max_consecutive_errors:
        reason = f"errors={errs}"
        log.debug("needs_refresh(%s): %s", host, reason)
        return (True, reason)

    refreshed_at = record.get("refreshed_at")
    if refreshed_at is not None:
        age = (now - refreshed_at).days
        if age > max_age_days:
            reason = f"age={age}d"
            log.debug("needs_refresh(%s): %s", host, reason)
            return (True, reason)

    confidence = float(record.get("confidence", 1.0) or 0.0)
    if confidence < min_confidence:
        reason = f"low-conf={confidence:.2f}"
        log.debug("needs_refresh(%s): %s", host, reason)
        return (True, reason)

    drift = record.get("drift_signals") or {}
    feeds_alive = drift.get("predicted_feeds_alive")
    feeds_total = drift.get("predicted_feeds_total", 0) or 0
    if feeds_total > 0 and feeds_alive is not None:
        survival = feeds_alive / feeds_total
        if survival < feed_survival_threshold:
            reason = f"feed-drift={survival:.2f}"
            log.debug("needs_refresh(%s): %s", host, reason)
            return (True, reason)

    paths_returning = drift.get("predicted_paths_returning_events")
    paths_total = drift.get("predicted_paths_total", 0) or 0
    if paths_total > 0 and paths_returning is not None:
        yield_ = paths_returning / paths_total
        if yield_ < path_yield_threshold:
            log.debug("needs_refresh(%s): %s", host, "path-drift")
            return (True, "path-drift")

    return (False, "fresh")


def build_scan_context(
    seed_url: str,
    html_pages: dict[str, str],
    sitemap_xml: str | None,
    autodiscovered_rss: list[str],
    json_ld_blocks: list[dict],
    microdata_blocks: list[dict],
    meta_tags: dict[str, str],
    max_pages: int = 6,
    max_chars_per_page: int = 10_000,
) -> dict:
    """Build the pre-AI context dict.

    Returns a dict ready to be JSON-serialized into the prompt.
    Keys:
      - feeds: list of {href, type, title, detection}
      - meta: title, og:*, html lang, etc.
      - json_ld_types_seen: list of @type values
      - microdata_types_seen: list of itemtype values
      - sitemap_urls: list of URLs from sitemap (capped)
      - pages: list of {url, text (truncated)}
    """
    feeds = [{"href": u, "type": "application/rss+xml",
              "title": "", "detection": "autodiscovery"}
             for u in autodiscovered_rss]

    json_ld_types = list({b.get("@type") for b in json_ld_blocks
                          if b.get("@type")})
    microdata_types = list({b.get("itemtype") for b in microdata_blocks
                            if b.get("itemtype")})

    sitemap_urls = _extract_sitemap_urls(sitemap_xml or "")

    # Truncate + cap pages for prompt budget
    pages = []
    for url, html in list(html_pages.items())[:max_pages]:
        text = _strip_html_for_prompt(html)[:max_chars_per_page]
        pages.append({"url": url, "text": text})

    return {
        "seed_url": seed_url,
        "feeds": feeds,
        "meta": meta_tags,
        "json_ld_types_seen": json_ld_types,
        "microdata_types_seen": microdata_types,
        "sitemap_urls": sitemap_urls,
        "pages": pages,
    }


def _extract_sitemap_urls(xml: str, cap: int = 200) -> list[str]:
    """Crude sitemap URL extraction — sufficient for context."""
    import re
    urls = re.findall(r"<loc>([^<]+)</loc>", xml)
    return urls[:cap]


_TAG_STRIP_RE = __import__("re").compile(r"<[^>]+>")
_WS_RE = __import__("re").compile(r"\s+")


def _strip_html_for_prompt(html: str) -> str:
    s = _TAG_STRIP_RE.sub(" ", html)
    s = _WS_RE.sub(" ", s).strip()
    return s


def compute_intelligence_confidence(intel: dict) -> float:
    """Compute confidence 0..1 from field coverage.

    Heuristic:
      base = 0.6
      +0.10 if feeds list non-empty
      +0.10 if structural_map non-empty
      +0.10 if sd_fingerprint.json_ld_types non-empty
      +0.05 if site_summary non-empty
      -0.10 if politics.language_primary empty
    Clamped to [0.0, 1.0].
    """
    score = 0.6
    if intel.get("feeds"):
        score += 0.10
    if intel.get("structural_map"):
        score += 0.10
    sd = intel.get("sd_fingerprint") or {}
    if sd.get("json_ld_types"):
        score += 0.10
    if intel.get("site_summary"):
        score += 0.05
    pol = intel.get("politics") or {}
    if not pol.get("language_primary"):
        score -= 0.10
    return max(0.0, min(1.0, score))


def merge_feed_findings(*sources: list[dict]) -> list[dict]:
    """Merge feed lists from multiple sources.

    Precedence: autodiscovery > sitemap > heuristic > ai.
    Within each source, first occurrence wins.
    """
    precedence = {
        "autodiscovery": 4,
        "sitemap": 3,
        "html_pattern": 2,
        "ai_link": 1,
    }
    by_href: dict[str, dict] = {}
    for src in sources:
        for f in src or []:
            href = f.get("href")
            if not href:
                continue
            existing = by_href.get(href)
            if existing is None:
                by_href[href] = f
                continue
            new_rank = precedence.get(f.get("detection", ""), 0)
            old_rank = precedence.get(existing.get("detection", ""), 0)
            if new_rank > old_rank:
                by_href[href] = f
    return list(by_href.values())


@dataclass
class ScanResult:
    """The result of an AI scan attempt."""
    host: str
    intelligence: dict | None
    confidence: float
    tokens_in: int
    tokens_out: int
    cost_usd: float
    model: str
    pages_sampled: int
    duration_ms: int
    error: str | None = None
    success: bool = False

    def to_dict(self) -> dict:
        return {
            "host": self.host,
            "intelligence": self.intelligence,
            "confidence": self.confidence,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "cost_usd": self.cost_usd,
            "model": self.model,
            "pages_sampled": self.pages_sampled,
            "duration_ms": self.duration_ms,
            "error": self.error,
            "success": self.success,
        }
