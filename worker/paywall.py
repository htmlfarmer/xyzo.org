"""Paywall detection — flags articles that likely require a subscription.

Uses a combination of:
  1. Known paywall domains (NYT, WSJ, FT, etc.)
  2. Common paywall text patterns in the article body
  3. HTTP response indicators (402, 403, login redirects)

No AI required — pure pattern matching for speed.

Usage:
    from worker.paywall import detect_paywall
    result = detect_paywall(url="https://www.nytimes.com/...", body="...")
    # result: {"is_paywalled": True, "confidence": 0.9, "reason": "known_paywall_domain"}
"""
from __future__ import annotations

import re
from urllib.parse import urlparse

# ── Known paywall domains ──────────────────────────────────────────
# These domains are known to require subscriptions for most content.
# Confidence is 0.8-0.95 depending on how strict the paywall is.
PAYWALL_DOMAINS: dict[str, tuple[float, str]] = {
    # Tier 1: Hard paywalls (very high confidence)
    "wsj.com": (0.95, "Wall Street Journal"),
    "ft.com": (0.95, "Financial Times"),
    "economist.com": (0.95, "The Economist"),
    "bloomberg.com": (0.90, "Bloomberg"),
    "nytimes.com": (0.90, "New York Times"),
    "washingtonpost.com": (0.90, "Washington Post"),
    "telegraph.co.uk": (0.90, "The Telegraph"),
    "thetimes.co.uk": (0.90, "The Times"),
    "lemonde.fr": (0.85, "Le Monde"),
    "lefigaro.fr": (0.85, "Le Figaro"),
    "elpais.com": (0.85, "El País"),
    "sueddeutsche.de": (0.85, "Süddeutsche Zeitung"),
    "handelsblatt.com": (0.85, "Handelsblatt"),
    "nikkei.com": (0.85, "Nikkei"),
    "scmp.com": (0.85, "South China Morning Post"),
    "theathletic.com": (0.90, "The Athletic"),
    "foreignaffairs.com": (0.90, "Foreign Affairs"),
    "foreignpolicy.com": (0.85, "Foreign Policy"),
    "newyorker.com": (0.85, "The New Yorker"),
    "theatlantic.com": (0.85, "The Atlantic"),
    "wired.com": (0.80, "Wired"),
    "nature.com": (0.85, "Nature"),
    "science.org": (0.85, "Science"),
    "thelancet.com": (0.85, "The Lancet"),
    "bmj.com": (0.85, "BMJ"),
    "jamanetwork.com": (0.85, "JAMA"),

    # Tier 2: Metered/soft paywalls (medium confidence)
    "medium.com": (0.60, "Medium"),
    "substack.com": (0.60, "Substack"),
    "seekingalpha.com": (0.70, "Seeking Alpha"),
    "barrons.com": (0.85, "Barron's"),
    "investors.com": (0.80, "Investor's Business Daily"),
    "strategypage.com": (0.70, "Strategy Page"),
}

# ── Paywall text patterns ──────────────────────────────────────────
# Common phrases found in paywalled articles or paywall prompts.
# Each pattern has a confidence weight.
PAYWALL_PATTERNS: list[tuple[str, float, str]] = [
    # Subscription prompts
    (r"subscribe\s+(?:now|today|to)\s+(?:to|for)\s+(?:continue|read|access)", 0.85, "subscribe_prompt"),
    (r"(?:sign|log)\s*in\s+(?:to|for)\s+(?:continue|read|access|view)", 0.80, "login_prompt"),
    (r"(?:this|the)\s+(?:article|story|content)\s+is\s+(?:for|available\s+to)\s+(?:subscribers|members|premium)", 0.85, "subscriber_only"),
    (r"(?:premium|exclusive|subscriber|members?)[\s-]*(?:only|content|article|story)", 0.80, "premium_content"),
    (r"(?:read|continue\s+reading)\s+(?:the\s+)?(?:full|complete|rest\s+of\s+the)\s+(?:article|story)\s+(?:with|by)\s+(?:a\s+)?(?:subscription|membership)", 0.85, "full_article_subscription"),
    (r"(?:you(?:'ve| have)?|reader)\s+(?:reached|exceeded)\s+(?:your|the)\s+(?:monthly|free|daily)\s+(?:limit|quota|allowance)", 0.90, "meter_limit"),
    (r"(?:free|trial)\s+(?:article|story|read)s?\s+(?:remaining|left|available)", 0.80, "free_articles_remaining"),

    # Login walls
    (r"(?:please|kindly)\s+(?:sign|log)\s*in\s+(?:to|before)\s+(?:continue|read|access|view)", 0.85, "please_login"),
    (r"(?:create|register\s+for)\s+(?:a\s+)?(?:free\s+)?(?:account|subscription)\s+(?:to|for)\s+(?:continue|read|access)", 0.85, "account_required"),
    (r"(?:this|the)\s+(?:article|story|content)\s+(?:is|requires?)\s+(?:a\s+)?(?:subscription|membership|login|account)", 0.85, "requires_subscription"),

    # Paywall UI elements
    (r"(?:subscribe|sign\s*up|register)\s+(?:button|now|today|here)", 0.60, "subscribe_button"),
    (r"(?:paywall|pay\s*wall|subscription\s*wall|login\s*wall)", 0.70, "paywall_mention"),
    (r"(?:metered|gated|locked|restricted)\s+(?:content|article|story)", 0.75, "metered_content"),

    # Article truncation indicators
    (r"(?:truncated|abbreviated|condensed)\s+(?:version|preview|excerpt)", 0.70, "truncated"),
    (r"(?:preview|excerpt|snippet|summary)\s+(?:only|version)", 0.65, "preview_only"),
    (r"(?:full|complete)\s+(?:article|story|text)\s+(?:available|requires|locked)", 0.80, "full_article_locked"),
]

# ── HTTP indicators ────────────────────────────────────────────────
# Status codes and headers that indicate paywalls.
PAYWALL_HTTP_CODES = {402, 403, 451}
PAYWALL_HEADERS = [
    "x-paywall", "x-metered", "x-subscription-required",
    "x-robots-tag",  # often "noindex" for paywalled content
]


def detect_paywall(url: str | None = None,
                   body: str | None = None,
                   http_status: int | None = None,
                   http_headers: dict | None = None) -> dict:
    """Detect if an article is likely paywalled.

    Returns:
        {
            "is_paywalled": bool,
            "confidence": float (0.0-1.0),
            "reason": str,
            "details": list[str]  # all detected indicators
        }
    """
    indicators: list[tuple[float, str, str]] = []  # (confidence, reason, detail)

    # 1. Domain check
    if url:
        try:
            domain = urlparse(url).netloc.lower()
            # Remove www. prefix
            if domain.startswith("www."):
                domain = domain[4:]
            for paywall_domain, (conf, name) in PAYWALL_DOMAINS.items():
                if domain == paywall_domain or domain.endswith("." + paywall_domain):
                    indicators.append((conf, "known_paywall_domain", f"{name} ({paywall_domain})"))
                    break
        except Exception:
            pass

    # 2. Body text pattern matching
    if body:
        body_lower = body.lower()[:5000]  # Only check first 5000 chars
        for pattern, conf, reason in PAYWALL_PATTERNS:
            if re.search(pattern, body_lower, re.IGNORECASE):
                indicators.append((conf, reason, f"matched: {pattern[:50]}"))

    # 3. HTTP status code
    if http_status and http_status in PAYWALL_HTTP_CODES:
        indicators.append((0.80, "http_paywall_code", f"HTTP {http_status}"))

    # 4. HTTP headers
    if http_headers:
        for header in PAYWALL_HEADERS:
            if header in {k.lower() for k in http_headers}:
                indicators.append((0.70, "paywall_header", header))

    # Calculate overall confidence
    if not indicators:
        return {
            "is_paywalled": False,
            "confidence": 0.0,
            "reason": "no_indicators",
            "details": [],
        }

    # Use the highest confidence indicator as the primary signal.
    # Multiple indicators boost confidence slightly.
    indicators.sort(key=lambda x: x[0], reverse=True)
    primary_conf = indicators[0][0]
    primary_reason = indicators[0][1]

    # Boost if multiple indicators agree.
    if len(indicators) > 1:
        primary_conf = min(0.99, primary_conf + 0.05 * (len(indicators) - 1))

    return {
        "is_paywalled": primary_conf >= 0.70,
        "confidence": round(primary_conf, 2),
        "reason": primary_reason,
        "details": [f"{reason}: {detail}" for _, reason, detail in indicators],
    }


def detect_paywall_from_article(article: dict) -> dict:
    """Convenience wrapper for articles from the DB.

    Expects article dict with keys: url, body, title.
    """
    return detect_paywall(
        url=article.get("url"),
        body=article.get("body") or article.get("title") or "",
    )
