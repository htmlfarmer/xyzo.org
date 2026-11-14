"""Shared constants and utilities for the video pipeline.

All video modules import from here to avoid duplication.
Single source of truth for timeouts, user agents, thresholds.
"""

# ── HTTP ──────────────────────────────────────────────────────────────────
DEFAULT_UA = "XyzoFetcher/0.1 (+https://xyzo.org/bot; contact@xyzo.org)"
POLITE_UA = "xyzo-events-bot/1.0 (+https://xyzo.org/bot) polite-fetch"
REQUEST_TIMEOUT = 15.0

# ── Fetching ──────────────────────────────────────────────────────────────
MIN_FETCH_INTERVAL_S = 1.0
CRAWL_DELAY = 1.0
MAX_CONCURRENT_HOSTS = 8
LEASE_TTL_S = 300
RECENT_SUCCESS_WINDOW_S = 300

# ── Limits ────────────────────────────────────────────────────────────────
MAX_VIDEOS_PER_SOURCE = 100
MAX_PAGES_PER_SECTION = 20
TRANSCRIPT_BATCH_SIZE = 50
LINKER_BATCH_SIZE = 500
SITE_CRAWL_BATCH_SIZE = 5

# ── YouTube API (optional) ────────────────────────────────────────────────
YOUTUBE_QUOTA_BUDGET = 5000
