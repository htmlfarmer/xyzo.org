"""intelligence_scan prompt template.

Versioned. Bump PROMPT_VERSION when the prompt text changes.
prompt_hash() gives a stable hash so callers can store it in
site_intelligence.producer for auditability.
"""
from __future__ import annotations

import hashlib
import json

PROMPT_VERSION = "intelligence-scan-v1.0"


_GOV_PREAMBLE = """\
=== POLITENESS RULES (gov/university site) ===
You are analyzing a government or university website. These sites are governed by:
- robots.txt (must be honored at all times)
- Terms of Service and acceptable-use policies
- Accessibility and rate-limit expectations

Apply conservative posture:
- Do NOT recommend crawling patterns that would exceed typical academic/government fair-use cadence (suggest 1 request per 10+ seconds minimum, never suggest parallelism above 2).
- Do NOT recommend bypassing robots.txt, captchas, login walls, or any access control.
- Flag any anti-bot signals (Cloudflare, captchas, geo restrictions) and recommend the human operator verify legality before deeper scanning.
- Prefer inference over actual fetching — describe structural patterns you observe; do not suggest URLs that would require circumventing access controls.
- If the robots.txt or ToS explicitly prohibits scraping events, set detection='ai_inferred' only and recommend manual review."""


def build_prompt(context: dict) -> str:
    """Compose the prompt string from context. Stable across calls."""
    seed = context.get("seed_url", "<unknown>")
    feeds = context.get("feeds", [])
    pages = context.get("pages", [])
    meta = context.get("meta", {})
    json_ld = context.get("json_ld_types_seen", [])
    sitemap_urls = context.get("sitemap_urls", [])
    tier = context.get("tier", "commercial")

    parts = []

    if tier in ("gov", "university"):
        parts.append(_GOV_PREAMBLE)
        parts.append("")

    parts.extend([
        "You are analyzing a website to discover its event-publishing structure.",
        f"Target URL: {seed}",
        "",
        "=== Already-discovered signals (from automatic extractors) ===",
        f"Meta tags: {json.dumps(meta, default=str)[:2000]}",
        f"JSON-LD @type seen: {json_ld}",
        f"Autodiscovered feeds: {json.dumps(feeds)[:2000]}",
        f"Sitemap URLs (sample): {sitemap_urls[:50]}",
        "",
        "=== Pages (text extracted from HTML) ===",
    ])
    for p in pages:
        parts.append(f"\n--- {p['url']} ---")
        parts.append(p.get("text", "")[:8000])

    parts.extend([
        "",
        "=== Required output ===",
        "Return a JSON object (NOT an array) with these top-level keys:",
        "{",
        '  "feeds": [ {"href": "...", "type": "...", "title": "...", "detection": "ai_*", "confidence": 0.0-1.0} ],',
        '  "structural_map": [ {"pattern": "/path/{slug}", "kind": "listing|detail", "confidence": 0.0-1.0, "examples": [...]} ],',
        '  "sd_fingerprint": { "json_ld_types": [...], "microdata_itemtypes": [...], "opengraph": {...}, "widgets": [...], "feed_formats": [...], "date_formats_seen": [...], "currency_seen": [...], "languages_seen": [...] },',
        '  "politics": { "anti_bot_signals": [...], "rate_limit_headers_seen": [...], "js_only_pages": [...], "best_crawl_window_utc": [...], "publishes_on": [...], "language_primary": "...", "language_variants": {...}, "taxonomy": {...} },',
        '  "site_summary": "one paragraph in English",',
        '  "scanned_urls": [list of URLs you actually saw]',
        "}",
        "",
        "Use detection='ai_link' for feeds you found in HTML/JS that",
        "weren't in autodiscovery. Use detection='ai_inferred' for",
        "structural patterns you deduced from navigation. Be thorough —",
        "we want as much detail as possible in this single scan.",
        "If the page has NO events, still return the full schema with empty arrays.",
    ])
    return "\n".join(parts)


def prompt_hash(prompt: str) -> str:
    """Stable hash of the prompt text. Store in site_intelligence.producer."""
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]
