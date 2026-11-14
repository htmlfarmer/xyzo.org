"""Xyzo central configuration — all tunable constants in one place.

This module replaces magic numbers scattered across worker/*.py with a single,
well-documented source of truth.

**Why a Python module instead of JSON/YAML/TOML?**
- Environment variable overrides work out of the box (os.environ.get)
- Complex types (dicts, lists) are natural
- No extra dependency to parse config format
- IDE autocomplete and type checking work natively

**Override pattern:**
    XYZO_<SECTION>_<KEY>  (uppercase, underscores)
    e.g. XYZO_FETCH_MIN_INTERVAL_S=0.5

**Adding new config:**
    1. Add section to CONFIG dict below
    2. Add default value with explanatory comment
    3. Reference via config.fetch.MIN_FETCH_INTERVAL_S in the module
"""

from __future__ import annotations

import os
from typing import Any

# ── Section access helper ────────────────────────────────────────────────
# config.fetch.KEY or config["fetch"]["KEY"] — both work

class _ConfigSection(dict):
    """Dict subclass that auto-prefixes env vars and supports attribute access."""
    def __getattr__(self, key: str) -> Any:
        return self.get(key)

    def __repr__(self) -> str:
        return f"ConfigSection({dict.__repr__(self)})"

class _Config(dict):
    """Root config dict with section-level attribute access."""
    def __getattr__(self, key: str) -> _ConfigSection:
        return self[key]

    def __repr__(self) -> str:
        return f"Config({dict.__repr__(self)})"

def _env(section: str, key: str, default: Any) -> Any:
    """Look up XYZO_<SECTION>_<KEY> in environment, fall back to default."""
    env_key = f"XYZO_{section.upper()}_{key.upper()}"
    val = os.environ.get(env_key)
    if val is None:
        return default
    # Type-coerce based on the default's type
    if isinstance(default, bool):
        return val.lower() in ("true", "1", "yes")
    if isinstance(default, int):
        return int(val)
    if isinstance(default, float):
        return float(val)
    return val

# ══════════════════════════════════════════════════════════════════════════
# FETCH CONFIG
# ══════════════════════════════════════════════════════════════════════════

FETCH: dict[str, Any] = {
    # HTTP timeout for feed fetches (seconds)
    "REQUEST_TIMEOUT": 20.0,

    # User-Agent strings — MUST stay in sync with robots.py:_TIERS
    # Default UA for commercial/production use
    "DEFAULT_UA": "XyzoFetcher/0.1 (+https://xyzo.org/bot; contact@xyzo.org)",
    # Polite UA for government and university sites (more likely to be whitelisted)
    "POLITE_UA": "xyzo-events-bot/1.0 (+https://xyzo.org/bot) polite-fetch",

    # Minimum interval between fetches to the same host (seconds).
    # Floor regardless of robots.txt Crawl-delay. Public Nominatim ToS is 1 req/s.
    "MIN_FETCH_INTERVAL_S": 1.0,

    # Max parallel host groups. Each group is fetched sequentially (respects
    # crawl-delay), but different hosts run in parallel.
    "MAX_CONCURRENT_HOSTS": 8,

    # httpx connection pool settings per host.
    # Reducing from defaults shrinks the anyio thread pool.
    "HTTPX_MAX_CONNECTIONS": 4,
    "HTTPX_MAX_KEEPALIVE": 2,

    # Skip sources that succeeded within this window (seconds).
    # Prevents hammering sources that just returned fresh content.
    "RECENT_SUCCESS_WINDOW_S": 300,  # 5 minutes
}

# ══════════════════════════════════════════════════════════════════════════
# GEOCODE CONFIG
# ══════════════════════════════════════════════════════════════════════════

GEOCODE: dict[str, Any] = {
    # Nominatim endpoint (public or self-hosted)
    "NOMINATIM_URL": "https://nominatim.openstreetmap.org/search",

    # User-Agent for Nominatim requests (required by ToS)
    "USER_AGENT": "newsium-fetcher/0.1 (https://newsium.org; contact@newsium.org)",

    # HTTP timeout per geocode request
    "TIMEOUT_S": 15.0,

    # Minimum interval between Nominatim requests (seconds).
    # Public Nominatim ToS: 1 req/s. Self-hosted can go lower.
    "MIN_INTERVAL_S": 1.1,

    # Max geocoding operations per cycle (None = unlimited)
    "MAX_PER_CYCLE": 300,

    # Thread pool size for parallel geocoding.
    # Still throttled by MIN_INTERVAL_S across all workers.
    "MAX_WORKERS": 4,

    # httpx connection pool settings (same rationale as fetch)
    "HTTPX_MAX_CONNECTIONS": 4,
    "HTTPX_MAX_KEEPALIVE": 2,
}

# ══════════════════════════════════════════════════════════════════════════
# CLUSTER CONFIG
# ══════════════════════════════════════════════════════════════════════════

CLUSTER: dict[str, Any] = {
    # Time window for grouping articles into the same event (hours).
    # Two articles about the same event within this window become one event.
    "CLUSTER_WINDOW_HOURS": 6,

    # How long each event_type stays relevant (days).
    # Override per-event if AI extraction later produces relevance_days hint.
    #
    # Why conflict=90 but weather=1?
    # - Wars don't end in a day; weather forecasts do
    # - Science papers take weeks to become obsolete
    # - Sports games are done in a day unless it's a controversy
    "RELEVANCE_DEFAULTS": {
        "weather":      1,    # today/tomorrow's forecast
        "sports":       1,    # game result, transfer
        "crime":        7,    # active investigation
        "politics":     3,    # fresh policy / statement
        "business":     3,    # market / earnings / deal
        "technology":   7,    # product launch, outage
        "science":      30,   # paper / discovery
        "culture":      14,   # release / award
        "health":       30,   # outbreak guidance / trial
        "environment":  30,   # advisory / spill
        "humanitarian": 14,   # appeal / migration wave
        "disaster":     7,    # post-event coverage
        "conflict":     90,   # war / sustained offensive
        "other":        7,
    },
}

# ══════════════════════════════════════════════════════════════════════════
# EXTRACT CONFIG (AI extraction via Gemma)
# ══════════════════════════════════════════════════════════════════════════

EXTRACT: dict[str, Any] = {
    # Gemma endpoint
    "CHAT_URL": "http://192.168.1.3:8888/chat/stream",

    # HTTP timeout for AI requests
    "TIMEOUT_S": 25.0,

    # Max articles to process per extraction cycle.
    # Set by --limit CLI arg, this is the default when not specified.
    "MAX_ARTICLES_PER_CYCLE": 60,

    # Headers sent to AI endpoint
    "SAFE_HEADERS": {"X-MCP-Safe": "true"},
}

# ══════════════════════════════════════════════════════════════════════════
# LEARN CONFIG
# ══════════════════════════════════════════════════════════════════════════

LEARN: dict[str, Any] = {
    # Min sample size before updating source reliability scores (prevents thrash)
    "MIN_SAMPLES_FOR_RELIABILITY": 10,

    # Decay factor for old articles when recalculating source quality (0-1)
    # Higher = more weight on recent performance
    "RECENCY_WEIGHT": 0.7,
}

# ══════════════════════════════════════════════════════════════════════════
# BUILD CONFIG (source building / discovery)
# ══════════════════════════════════════════════════════════════════════════

BUILD: dict[str, Any] = {
    # Max concurrent web requests during source discovery
    "MAX_CONCURRENT_REQUESTS": 8,

    # Timeout for web requests during discovery
    "REQUEST_TIMEOUT": 20.0,
}

# ══════════════════════════════════════════════════════════════════════════
# Full config assembly with env var overrides
# ══════════════════════════════════════════════════════════════════════════

CONFIG = _Config({
    "fetch": _ConfigSection({k: _env("fetch", k, v) for k, v in FETCH.items()}),
    "geocode": _ConfigSection({k: _env("geocode", k, v) for k, v in GEOCODE.items()}),
    "cluster": _ConfigSection({k: _env("cluster", k, v) for k, v in CLUSTER.items()}),
    "extract": _ConfigSection({k: _env("extract", k, v) for k, v in EXTRACT.items()}),
    "learn": _ConfigSection({k: _env("learn", k, v) for k, v in LEARN.items()}),
    "build": _ConfigSection({k: _env("build", k, v) for k, v in BUILD.items()}),
})

# Convenience: top-level keys for common access patterns
fetch = CONFIG.fetch
geocode = CONFIG.geocode
cluster = CONFIG.cluster
extract = CONFIG.extract
learn = CONFIG.learn
build = CONFIG.build
