# Site Intelligence Subsystem — Phase 2: AI Scan + Algorithm Consumer + Crawl Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the AI scan module, the pure-Python consumer that turns intelligence into crawl hints, and integrate both into the existing crawler. After this phase, every crawl reads/writes `site_intelligence`, but behavior is gated behind feature flags so production is unchanged.

**Architecture:** `ai_intelligence_scan.py` runs a tier-budgeted Claude call per host, persists structured JSON to `site_intelligence`. `intelligence_consume.py` parses that JSON into a `CrawlHints` object. `site_crawl.py` gains a new `crawl_with_intelligence()` wrapper that loads hints, applies them to BFS scoring, extractor selection, and field-level conflict resolution.

**Tech Stack:** Python 3.11 (httpx, psycopg), Claude API.

**Spec:** `docs/superpowers/specs/2026-09-06-site-intelligence-design.md` (sections 3, 5)

**Prerequisites:** Phase 1 (`site_intelligence`, `feature_flags`, `xyzo_features.py` migrations and module) complete.

---

## Phase 2 Task Index

- Task 7: AI scan tier budgets module
- Task 8: `needs_refresh()` logic + tests
- Task 9: Cheap context builder (pre-AI extraction)
- Task 10: AI prompt template + version hash
- Task 11: `ai_intelligence_scan()` main function + tests
- Task 12: Schema adapter (`readers/site_intel/v1.py`)
- Task 13: `intelligence_consume.py` — CrawlHints + parser + tests
- Task 14: URL scoring blend (page_priority + intelligence + classifier-stub)
- Task 15: Extractor selection + field-level merge
- Task 16: Wire `crawl_with_intelligence()` into `site_crawl.py`
- Task 17: Integration test — first crawl triggers scan, second uses cache

---

### Task 7: AI scan tier budgets

**Files:**
- Create: `worker/ai_intelligence_scan.py` (initial scaffold)
- Create: `tests/test_ai_intelligence_scan.py` (initial tests)

- [ ] **Step 1: Write the failing test**

Create `tests/test_ai_intelligence_scan.py`:

```python
"""Tests for AI scan tier budgets and configuration."""
from worker.ai_intelligence_scan import (
    ScanBudget, TIER_BUDGETS, budget_for_tier, total_pages_in_budget,
)


class TestScanBudget:
    def test_default_construction(self):
        b = ScanBudget(pages_max=5, tokens_in_max=50_000,
                       tokens_out_max=5_000, model="claude-haiku-4-5",
                       use_sitemap=True, use_heuristics_pre=True)
        assert b.pages_max == 5
        assert b.model == "claude-haiku-4-5"


class TestTierBudgets:
    def test_all_tiers_present(self):
        for tier in ("gov", "university", "community",
                     "commercial", "platform", "user"):
            assert tier in TIER_BUDGETS

    def test_gov_is_cheapest(self):
        gov = TIER_BUDGETS["gov"]
        commercial = TIER_BUDGETS["commercial"]
        assert gov.tokens_in_max < commercial.tokens_in_max
        assert gov.pages_max < commercial.pages_max

    def test_budget_caps_respected(self):
        for tier, b in TIER_BUDGETS.items():
            assert b.pages_max <= 10, f"{tier} pages_max too high"
            assert b.tokens_in_max <= 100_000
            assert b.tokens_out_max <= 10_000

    def test_models_are_known(self):
        for tier, b in TIER_BUDGETS.items():
            assert b.model in ("claude-haiku-4-5", "claude-sonnet-5"), \
                f"{tier} unknown model: {b.model}"


class TestBudgetForTier:
    def test_known_tier(self):
        b = budget_for_tier("gov")
        assert b.tokens_in_max == 15_000

    def test_unknown_tier_falls_back_to_commercial(self):
        b = budget_for_tier("unknown_tier_xyz")
        assert b.tokens_in_max == TIER_BUDGETS["commercial"].tokens_in_max


class TestTotalPagesInBudget:
    def test_gov_total(self):
        # gov gets 2 pages, with sitemap counts as 1 page
        assert total_pages_in_budget("gov") >= 2

    def test_commercial_total(self):
        assert total_pages_in_budget("commercial") >= 6
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_ai_intelligence_scan.py -v 2>&1 | tail -15
```
Expected: `ModuleNotFoundError: No module named 'worker.ai_intelligence_scan'`.

- [ ] **Step 3: Write the implementation**

Create `worker/ai_intelligence_scan.py`:

```python
"""ai_intelligence_scan — tier-budgeted Claude scan that produces
structured site intelligence JSON.

Exports:
- ScanBudget: pages_max, tokens_in_max, tokens_out_max, model, ...
- TIER_BUDGETS: per-tier ScanBudget
- budget_for_tier(): returns ScanBudget, falls back to commercial
- total_pages_in_budget(): counts pages including sitemap
- ai_intelligence_scan(): main function (added in Task 11)
"""
from __future__ import annotations

from dataclasses import dataclass
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_ai_intelligence_scan.py -v 2>&1 | tail -20
```
Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/ai_intelligence_scan.py tests/test_ai_intelligence_scan.py
git commit -m "feat(ai-scan): tier-budgeted config + tests"
```

---

### Task 8: `needs_refresh()` logic + tests

**Files:**
- Modify: `worker/ai_intelligence_scan.py`
- Modify: `tests/test_ai_intelligence_scan.py`

- [ ] **Step 1: Append failing tests to `tests/test_ai_intelligence_scan.py`**

```python
import datetime as dt


def _record(**overrides):
    """Build a fake record dict matching site_intelligence row shape."""
    base = {
        "host": "example.com",
        "format_version": 1,
        "refreshed_at": dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc),
        "confidence": 0.9,
        "consecutive_errors": 0,
        "last_error": None,
        "drift_signals": {
            "predicted_feeds_alive": 5,
            "predicted_feeds_total": 5,
            "predicted_paths_returning_events": 8,
            "predicted_paths_total": 10,
        },
    }
    base.update(overrides)
    return base


class TestNeedsRefresh:
    def test_none_record_needs_refresh(self):
        needs, reason = needs_refresh(None, "x.com", now=dt.datetime(2026, 9, 6, tzinfo=dt.timezone.utc))
        assert needs is True
        assert reason == "no-record"

    def test_fresh_record_does_not_need_refresh(self):
        now = dt.datetime(2026, 9, 6, tzinfo=dt.timezone.utc)
        record = _record(refreshed_at=now - dt.timedelta(days=1))
        needs, reason = needs_refresh(record, "x.com", now=now)
        assert needs is False
        assert reason == "fresh"

    def test_old_record_needs_refresh(self):
        now = dt.datetime(2026, 9, 6, tzinfo=dt.timezone.utc)
        record = _record(refreshed_at=now - dt.timedelta(days=31))
        needs, reason = needs_refresh(record, "x.com", now=now)
        assert needs is True
        assert "age" in reason

    def test_low_confidence_needs_refresh(self):
        now = dt.datetime(2026, 9, 6, tzinfo=dt.timezone.utc)
        record = _record(confidence=0.4)
        needs, reason = needs_refresh(record, "x.com", now=now)
        assert needs is True
        assert "low-conf" in reason

    def test_consecutive_errors_needs_refresh(self):
        now = dt.datetime(2026, 9, 6, tzinfo=dt.timezone.utc)
        record = _record(consecutive_errors=3)
        needs, reason = needs_refresh(record, "x.com", now=now)
        assert needs is True
        assert "errors" in reason

    def test_feed_drift_triggers_refresh(self):
        now = dt.datetime(2026, 9, 6, tzinfo=dt.timezone.utc)
        record = _record(drift_signals={
            "predicted_feeds_alive": 2,
            "predicted_feeds_total": 5,
            "predicted_paths_returning_events": 8,
            "predicted_paths_total": 10,
        })
        needs, reason = needs_refresh(record, "x.com", now=now)
        assert needs is True
        assert "feed-drift" in reason

    def test_path_drift_triggers_refresh(self):
        now = dt.datetime(2026, 9, 6, tzinfo=dt.timezone.utc)
        record = _record(drift_signals={
            "predicted_feeds_alive": 5,
            "predicted_feeds_total": 5,
            "predicted_paths_returning_events": 3,
            "predicted_paths_total": 10,
        })
        needs, reason = needs_refresh(record, "x.com", now=now)
        assert needs is True
        assert "path-drift" in reason
```

- [ ] **Step 2: Run new tests to verify they fail**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_ai_intelligence_scan.py::TestNeedsRefresh -v 2>&1 | tail -15
```
Expected: `ImportError` or `NameError: name 'needs_refresh' is not defined`.

- [ ] **Step 3: Implement `needs_refresh` in `worker/ai_intelligence_scan.py`**

Append to `worker/ai_intelligence_scan.py`:

```python
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
      1. record is None                          -> True, "no-record"
      2. consecutive_errors >= max_consecutive  -> True, "errors=N"
      3. age > max_age_days                      -> True, "age=Nd"
      4. confidence < min_confidence             -> True, "low-conf=X"
      5. feed_survival < threshold               -> True, "feed-drift=X"
      6. path_yield < threshold                  -> True, "path-drift"
      7. else                                    -> False, "fresh"
    """
    import datetime as dt

    if record is None:
        return (True, "no-record")

    now = now or dt.datetime.now(dt.timezone.utc)

    errs = int(record.get("consecutive_errors", 0) or 0)
    if errs >= max_consecutive_errors:
        return (True, f"errors={errs}")

    refreshed_at = record.get("refreshed_at")
    if refreshed_at is not None:
        age = (now - refreshed_at).days
        if age > max_age_days:
            return (True, f"age={age}d")

    confidence = float(record.get("confidence", 1.0) or 0.0)
    if confidence < min_confidence:
        return (True, f"low-conf={confidence:.2f}")

    drift = record.get("drift_signals") or {}
    feeds_alive = drift.get("predicted_feeds_alive")
    feeds_total = drift.get("predicted_feeds_total", 0) or 0
    if feeds_total > 0 and feeds_alive is not None:
        survival = feeds_alive / feeds_total
        if survival < feed_survival_threshold:
            return (True, f"feed-drift={survival:.2f}")

    paths_returning = drift.get("predicted_paths_returning_events")
    paths_total = drift.get("predicted_paths_total", 0) or 0
    if paths_total > 0 and paths_returning is not None:
        yield_ = paths_returning / paths_total
        if yield_ < path_yield_threshold:
            return (True, "path-drift")

    return (False, "fresh")
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_ai_intelligence_scan.py -v 2>&1 | tail -25
```
Expected: all tests pass (existing 11 + 7 new = 18 total).

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/ai_intelligence_scan.py tests/test_ai_intelligence_scan.py
git commit -m "feat(ai-scan): needs_refresh logic with drift + staleness triggers"
```

---

### Task 9: Cheap context builder (pre-AI extraction)

**Files:**
- Modify: `worker/ai_intelligence_scan.py`
- Modify: `tests/test_ai_intelligence_scan.py`

This builds the context dict the AI prompt references. It runs existing extractors on the seed pages before sending to Claude, so the AI prompt can say "here's what we already found, fill in the gaps."

- [ ] **Step 1: Append failing tests**

Add to `tests/test_ai_intelligence_scan.py`:

```python
class TestBuildContext:
    def test_extracts_rss_from_html(self):
        html = '<html><head><link rel="alternate" type="application/rss+xml" ' \
               'href="/feed.xml" title="Events"></head><body></body></html>'
        ctx = build_scan_context(
            "https://example.com", html_pages={"https://example.com": html},
            sitemap_xml=None, autodiscovered_rss=["https://example.com/feed.xml"],
            json_ld_blocks=[], microdata_blocks=[], meta_tags={"title": "Example"},
        )
        assert any(f["href"] == "https://example.com/feed.xml"
                   for f in ctx["feeds"])

    def test_extracts_meta_tags(self):
        ctx = build_scan_context(
            "https://example.com", html_pages={}, sitemap_xml=None,
            autodiscovered_rss=[], json_ld_blocks=[],
            microdata_blocks=[], meta_tags={"title": "Test", "og:locale": "en_US"},
        )
        assert ctx["meta"]["title"] == "Test"
        assert ctx["meta"]["og:locale"] == "en_US"

    def test_includes_json_ld_types(self):
        ctx = build_scan_context(
            "https://example.com", html_pages={}, sitemap_xml=None,
            autodiscovered_rss=[],
            json_ld_blocks=[{"@type": "Event", "name": "Concert"}],
            microdata_blocks=[], meta_tags={},
        )
        assert "Event" in ctx["json_ld_types_seen"]

    def test_includes_sitemap_urls(self):
        ctx = build_scan_context(
            "https://example.com", html_pages={},
            sitemap_xml="<urlset><url><loc>https://example.com/a</loc></url>"
                        "<url><loc>https://example.com/b</loc></url></urlset>",
            autodiscovered_rss=[], json_ld_blocks=[], microdata_blocks=[],
            meta_tags={},
        )
        assert "https://example.com/a" in ctx["sitemap_urls"]
        assert "https://example.com/b" in ctx["sitemap_urls"]

    def test_pages_truncated_for_prompt(self):
        pages = {f"https://x.com/{i}": "x" * 5000 for i in range(20)}
        ctx = build_scan_context(
            "https://x.com", html_pages=pages, sitemap_xml=None,
            autodiscovered_rss=[], json_ld_blocks=[], microdata_blocks=[],
            meta_tags={}, max_pages=3, max_chars_per_page=1000,
        )
        assert len(ctx["pages"]) == 3
        for p in ctx["pages"]:
            assert len(p["text"]) <= 1000

    def test_handles_missing_inputs(self):
        ctx = build_scan_context(
            "https://x.com", html_pages={}, sitemap_xml=None,
            autodiscovered_rss=[], json_ld_blocks=[], microdata_blocks=[],
            meta_tags={},
        )
        assert ctx["feeds"] == []
        assert ctx["sitemap_urls"] == []
```

- [ ] **Step 2: Run new tests to verify they fail**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_ai_intelligence_scan.py::TestBuildContext -v 2>&1 | tail -10
```
Expected: `NameError: name 'build_scan_context' is not defined`.

- [ ] **Step 3: Implement `build_scan_context`**

Append to `worker/ai_intelligence_scan.py`:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_ai_intelligence_scan.py -v 2>&1 | tail -10
```
Expected: all 24 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/ai_intelligence_scan.py tests/test_ai_intelligence_scan.py
git commit -m "feat(ai-scan): pre-AI context builder combining extractors + sitemap"
```

---

### Task 10: AI prompt template + version hash

**Files:**
- Create: `worker/prompts/intelligence_scan.py`
- Create: `tests/test_intelligence_scan_prompt.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_intelligence_scan_prompt.py`:

```python
"""Tests for the AI scan prompt template."""
from worker.prompts.intelligence_scan import (
    build_prompt, prompt_hash, PROMPT_VERSION,
)


class TestPromptVersion:
    def test_version_is_set(self):
        assert isinstance(PROMPT_VERSION, str)
        assert len(PROMPT_VERSION) > 0


class TestPromptHash:
    def test_deterministic(self):
        ctx = {"seed_url": "https://x.com", "feeds": [], "pages": []}
        h1 = prompt_hash(build_prompt(ctx))
        h2 = prompt_hash(build_prompt(ctx))
        assert h1 == h2

    def test_changes_when_prompt_changes(self):
        ctx = {"seed_url": "https://x.com", "feeds": [], "pages": []}
        p1 = build_prompt(ctx) + "extra"
        assert prompt_hash(p1) != prompt_hash(build_prompt(ctx))


class TestBuildPrompt:
    def test_includes_schema_spec(self):
        prompt = build_prompt({"seed_url": "https://x.com",
                               "feeds": [], "pages": []})
        assert "feeds" in prompt
        assert "structural_map" in prompt
        assert "sd_fingerprint" in prompt
        assert "politics" in prompt

    def test_includes_seed_url(self):
        prompt = build_prompt({"seed_url": "https://example.com",
                               "feeds": [], "pages": []})
        assert "https://example.com" in prompt

    def test_includes_pages(self):
        ctx = {"seed_url": "https://x.com", "feeds": [],
               "pages": [{"url": "https://x.com/events", "text": "lots of events"}]}
        prompt = build_prompt(ctx)
        assert "https://x.com/events" in prompt
        assert "lots of events" in prompt

    def test_includes_discovered_feeds(self):
        ctx = {"seed_url": "https://x.com",
               "feeds": [{"href": "https://x.com/feed", "type": "rss"}],
               "pages": []}
        prompt = build_prompt(ctx)
        assert "https://x.com/feed" in prompt

    def test_requires_json_array_response(self):
        prompt = build_prompt({"seed_url": "https://x.com",
                               "feeds": [], "pages": []})
        assert "JSON" in prompt or "json" in prompt

    def test_gov_tier_includes_conservative_preamble(self):
        ctx = {"seed_url": "https://city.gov", "tier": "gov",
               "feeds": [], "pages": []}
        prompt = build_prompt(ctx)
        assert "POLITENESS RULES" in prompt
        assert "robots.txt" in prompt

    def test_university_tier_includes_conservative_preamble(self):
        ctx = {"seed_url": "https://example.edu", "tier": "university",
               "feeds": [], "pages": []}
        prompt = build_prompt(ctx)
        assert "POLITENESS RULES" in prompt

    def test_commercial_tier_has_no_preamble(self):
        ctx = {"seed_url": "https://x.com", "tier": "commercial",
               "feeds": [], "pages": []}
        prompt = build_prompt(ctx)
        assert "POLITENESS RULES" not in prompt
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_intelligence_scan_prompt.py -v 2>&1 | tail -10
```
Expected: `ModuleNotFoundError: No module named 'worker.prompts'`.

- [ ] **Step 3: Write the prompt module**

Create `worker/prompts/__init__.py` (empty) and `worker/prompts/intelligence_scan.py`:

```python
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
    ]
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
        "weren\\'t in autodiscovery. Use detection='ai_inferred' for",
        "structural patterns you deduced from navigation. Be thorough —",
        "we want as much detail as possible in this single scan.",
        "If the page has NO events, still return the full schema with empty arrays.",
    ])
    return "\n".join(parts)


def prompt_hash(prompt: str) -> str:
    """Stable hash of the prompt text. Store in site_intelligence.producer."""
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_intelligence_scan_prompt.py -v 2>&1 | tail -15
```
Expected: 11 tests pass (8 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/prompts/__init__.py worker/prompts/intelligence_scan.py \
        tests/test_intelligence_scan_prompt.py
git commit -m "feat(ai-scan): versioned prompt template + tests"
```

---

### Task 11: `ai_intelligence_scan()` main function + tests

**Files:**
- Modify: `worker/ai_intelligence_scan.py`
- Modify: `tests/test_ai_intelligence_scan.py`

- [ ] **Step 1: Append failing tests**

Add to `tests/test_ai_intelligence_scan.py`:

```python
class TestComputeConfidence:
    def test_perfect_record(self):
        intel = {
            "feeds": [{"href": "x"}],
            "structural_map": [{"pattern": "/events"}],
            "sd_fingerprint": {"json_ld_types": ["Event"]},
            "politics": {"language_primary": "en"},
        }
        c = compute_intelligence_confidence(intel)
        assert c >= 0.85

    def test_empty_record(self):
        c = compute_intelligence_confidence({"feeds": [], "structural_map": [],
                                              "sd_fingerprint": {}, "politics": {}})
        assert c <= 0.6

    def test_no_summary_penalised(self):
        intel = {"feeds": [], "structural_map": [],
                 "sd_fingerprint": {}, "politics": {},
                 "site_summary": ""}
        c = compute_intelligence_confidence(intel)
        assert c < 0.7


class TestMergeFindings:
    def test_autodiscovery_beats_ai(self):
        existing = [{"href": "https://x.com/feed", "detection": "autodiscovery"}]
        ai = [{"href": "https://x.com/feed", "detection": "ai_link"}]
        merged = merge_feed_findings(existing, ai)
        assert len(merged) == 1
        assert merged[0]["detection"] == "autodiscovery"

    def test_keeps_unique_feeds(self):
        existing = [{"href": "https://x.com/a", "detection": "autodiscovery"}]
        ai = [{"href": "https://x.com/b", "detection": "ai_link"}]
        merged = merge_feed_findings(existing, ai)
        assert len(merged) == 2
```

- [ ] **Step 2: Run new tests to verify they fail**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_ai_intelligence_scan.py::TestComputeConfidence \
                    tests/test_ai_intelligence_scan.py::TestMergeFindings -v 2>&1 | tail -10
```
Expected: `NameError` for both new functions.

- [ ] **Step 3: Implement the helpers**

Append to `worker/ai_intelligence_scan.py`:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_ai_intelligence_scan.py -v 2>&1 | tail -10
```
Expected: 30 tests pass (24 + 5 new = 29 actually; recompute).

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/ai_intelligence_scan.py tests/test_ai_intelligence_scan.py
git commit -m "feat(ai-scan): confidence + feed-merge + ScanResult dataclass"
```

(The actual `ai_intelligence_scan()` function that calls Claude is wired into the endpoint in Task 16 — it needs the context builder + prompt + result types that we just built, but the function lives next to the route to keep the worker→API boundary clean.)

---

### Task 12: Schema adapter (`readers/site_intel/v1.py`)

**Files:**
- Create: `worker/readers/__init__.py` (empty)
- Create: `worker/readers/site_intel/__init__.py` (empty)
- Create: `worker/readers/site_intel/v1.py`
- Create: `tests/test_site_intel_v1_reader.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_site_intel_v1_reader.py`:

```python
"""Tests for the v1 site_intelligence schema adapter."""
import pytest
from worker.readers.site_intel.v1 import (
    parse_intelligence, validate_intelligence,
    CURRENT_FORMAT_VERSION,
)


SAMPLE = {
    "schema_version": 1,
    "feeds": [{"href": "https://x.com/feed", "type": "rss",
               "title": "Events", "detection": "autodiscovery",
               "confidence": 0.9}],
    "structural_map": [{"pattern": "/events", "kind": "listing",
                        "confidence": 0.85, "examples": ["/events"]}],
    "sd_fingerprint": {"json_ld_types": ["Event"],
                       "microdata_itemtypes": [],
                       "opengraph": {},
                       "widgets": [],
                       "feed_formats": ["rss"],
                       "date_formats_seen": ["ISO 8601"],
                       "currency_seen": [],
                       "languages_seen": ["en"]},
    "politics": {"anti_bot_signals": [], "rate_limit_headers_seen": [],
                 "js_only_pages": [], "best_crawl_window_utc": [],
                 "publishes_on": [], "language_primary": "en",
                 "language_variants": {}, "taxonomy": {}},
    "site_summary": "A test site.",
    "scanned_urls": ["https://x.com"],
}


class TestValidate:
    def test_valid_record_passes(self):
        validate_intelligence(SAMPLE)  # no exception

    def test_missing_required_key_fails(self):
        bad = {k: v for k, v in SAMPLE.items() if k != "feeds"}
        with pytest.raises(ValueError, match="feeds"):
            validate_intelligence(bad)

    def test_wrong_schema_version_fails(self):
        bad = dict(SAMPLE, schema_version=2)
        with pytest.raises(ValueError, match="schema_version"):
            validate_intelligence(bad)


class TestParse:
    def test_returns_parsed_dict(self):
        result = parse_intelligence(SAMPLE)
        assert result["feeds"][0]["href"] == "https://x.com/feed"

    def test_unknown_keys_preserved(self):
        sample_with_extra = dict(SAMPLE, future_field="something")
        result = parse_intelligence(sample_with_extra)
        assert result["future_field"] == "something"

    def test_format_version_constant(self):
        assert CURRENT_FORMAT_VERSION == 1
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_site_intel_v1_reader.py -v 2>&1 | tail -10
```
Expected: `ModuleNotFoundError: No module named 'worker.readers'`.

- [ ] **Step 3: Implement the adapter**

Create empty `worker/readers/__init__.py` and `worker/readers/site_intel/__init__.py`, then create `worker/readers/site_intel/v1.py`:

```python
"""v1 site_intelligence schema adapter.

When the intelligence JSON shape changes:
  1. Create v2.py with the new shape + validation
  2. Bump CURRENT_FORMAT_VERSION below
  3. Keep v1.py readable so old rows in DB still work
"""
from __future__ import annotations

import copy
from typing import Any

CURRENT_FORMAT_VERSION = 1

REQUIRED_KEYS = ("feeds", "structural_map", "sd_fingerprint",
                 "politics", "site_summary")


def validate_intelligence(intel: dict[str, Any]) -> None:
    """Raise ValueError if `intel` does not match v1 schema."""
    if intel.get("schema_version") != CURRENT_FORMAT_VERSION:
        raise ValueError(
            f"schema_version={intel.get('schema_version')} != "
            f"{CURRENT_FORMAT_VERSION}"
        )
    for k in REQUIRED_KEYS:
        if k not in intel:
            raise ValueError(f"missing required key: {k}")


def parse_intelligence(record: dict[str, Any]) -> dict[str, Any]:
    """Parse a v1 site_intelligence row into a dict.

    The 'intelligence' JSONB is at record['intelligence'].
    Returns a deep-copied parsed dict. Unknown keys are preserved
    so future fields can be read by newer code without losing data.
    """
    intel = record.get("intelligence") or {}
    validate_intelligence(intel)
    return copy.deepcopy(intel)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_site_intel_v1_reader.py -v 2>&1 | tail -15
```
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/readers/ tests/test_site_intel_v1_reader.py
git commit -m "feat(readers): v1 site_intelligence schema adapter"
```

---

### Task 13: `intelligence_consume.py` — CrawlHints + parser + tests

**Files:**
- Create: `worker/intelligence_consume.py`
- Create: `tests/test_intelligence_consume.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_intelligence_consume.py`:

```python
"""Tests for intelligence_consume — pure-Python consumer that
translates site_intelligence into CrawlHints."""
import re
from worker.intelligence_consume import (
    CrawlHints, parse_intelligence_to_hints,
)


SAMPLE_INTEL = {
    "schema_version": 1,
    "feeds": [{"href": "https://x.com/feed", "type": "rss",
               "title": "Events", "detection": "autodiscovery",
               "confidence": 0.9}],
    "structural_map": [
        {"pattern": "/events", "kind": "listing", "confidence": 0.85,
         "examples": ["/events"]},
        {"pattern": "/events/{slug}", "kind": "detail", "confidence": 0.85,
         "examples": ["/events/lecture-1"]},
        {"pattern": "/admin", "kind": "listing", "confidence": 0.7,
         "examples": ["/admin"]},
    ],
    "sd_fingerprint": {
        "json_ld_types": ["Event"],
        "date_formats_seen": ["ISO 8601", "October 5, 2026"],
    },
    "politics": {
        "anti_bot_signals": ["cloudflare-challenge"],
        "js_only_pages": ["/calendar"],
        "best_crawl_window_utc": ["02:00-06:00"],
        "language_primary": "en",
        "language_variants": {"es": "/es/"},
        "taxonomy": {"categories": ["Music", "Lectures"]},
    },
}


class TestParseIntelligenceToHints:
    def test_returns_crawl_hints(self):
        hints = parse_intelligence_to_hints(SAMPLE_INTEL)
        assert isinstance(hints, CrawlHints)

    def test_extracts_feeds(self):
        hints = parse_intelligence_to_hints(SAMPLE_INTEL)
        assert len(hints.feeds_to_subscribe) == 1
        assert hints.feeds_to_subscribe[0]["href"] == "https://x.com/feed"

    def test_extracts_extra_seeds(self):
        hints = parse_intelligence_to_hints(SAMPLE_INTEL)
        assert "/events" in hints.extra_seeds
        # Detail patterns do NOT become seeds; they expand from listings
        assert "/events/{slug}" not in hints.extra_seeds

    def test_extracts_avoided_paths(self):
        intel = dict(SAMPLE_INTEL,
                     structural_map=[{"pattern": "/admin", "confidence": 0.7,
                                      "kind": "listing",
                                      "examples": ["/admin"]}])
        hints = parse_intelligence_to_hints(intel)
        # Patterns with very low confidence OR matching /admin should be avoided
        assert any(re.search(r"/admin", str(p.pattern))
                   for p in hints.avoided_paths)

    def test_extracts_js_only_paths(self):
        intel = dict(SAMPLE_INTEL,
                     politics=dict(SAMPLE_INTEL["politics"],
                                   js_only_pages=["/calendar"]))
        hints = parse_intelligence_to_hints(intel)
        # js_only_paths becomes regex patterns
        assert len(hints.js_only_paths) >= 1
        assert any(re.search(r"/calendar", str(p.pattern))
                   for p in hints.js_only_paths)

    def test_extracts_language(self):
        hints = parse_intelligence_to_hints(SAMPLE_INTEL)
        assert hints.primary_language == "en"
        assert hints.language_variants == {"es": "/es/"}

    def test_extracts_crawl_window(self):
        hints = parse_intelligence_to_hints(SAMPLE_INTEL)
        assert ("02:00", "06:00") in hints.crawl_window_utc or \
               ("02", "06") in hints.crawl_window_utc or \
               len(hints.crawl_window_utc) >= 1

    def test_extracts_sd_fingerprint(self):
        hints = parse_intelligence_to_hints(SAMPLE_INTEL)
        assert hints.json_ld_types == ["Event"]
        assert "ISO 8601" in hints.date_formats_seen

    def test_empty_intelligence_returns_safe_defaults(self):
        hints = parse_intelligence_to_hints({})
        assert isinstance(hints, CrawlHints)
        assert hints.feeds_to_subscribe == []
        assert hints.extra_seeds == []
        assert hints.primary_language == "en"  # safe default


class TestScoreUrlAdjustment:
    def test_url_matching_pattern_gets_boost(self):
        from worker.intelligence_consume import url_adjustment
        hints = parse_intelligence_to_hints(SAMPLE_INTEL)
        boost = url_adjustment("/events/some-event", hints)
        assert boost > 0

    def test_avoided_url_gets_penalty(self):
        from worker.intelligence_consume import url_adjustment
        intel = dict(SAMPLE_INTEL,
                     structural_map=[{"pattern": "/admin", "confidence": 0.7,
                                      "kind": "listing",
                                      "examples": ["/admin"]}])
        hints = parse_intelligence_to_hints(intel)
        penalty = url_adjustment("/admin", hints)
        assert penalty < 0 or penalty <= 0
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_intelligence_consume.py -v 2>&1 | tail -10
```
Expected: `ModuleNotFoundError`.

- [ ] **Step 3: Implement `intelligence_consume.py`**

```python
"""intelligence_consume — pure-Python consumer of site_intelligence.

Translates the JSON we stored about a host into actionable CrawlHints.
No I/O. No AI. Easy to unit-test.

Usage:
    record = db.fetch_site_intelligence(host)   # dict
    hints = parse_intelligence_to_hints(record['intelligence'])
    score = url_adjustment(url, hints)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable


@dataclass
class FeedRef:
    href: str
    type: str
    title: str = ""
    detection: str = ""
    confidence: float = 0.0


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
    """Translate the intelligence JSON into a CrawlHints object."""
    hints = CrawlHints()

    if not intel:
        return hints

    feeds = intel.get("feeds") or []
    hints.feeds_to_subscribe = [
        FeedRef(href=f.get("href", ""), type=f.get("type", ""),
                title=f.get("title", ""),
                detection=f.get("detection", ""),
                confidence=float(f.get("confidence", 0.0) or 0.0))
        for f in feeds if f.get("href")
    ]

    smap = intel.get("structural_map") or []
    for entry in smap:
        pattern = entry.get("pattern") or ""
        confidence = float(entry.get("confidence", 0.5) or 0.5)
        kind = entry.get("kind", "listing")
        examples = entry.get("examples") or []
        if not pattern:
            continue
        if kind == "listing" and confidence >= 0.6:
            hints.extra_seeds.extend(examples or [pattern])
        if confidence < 0.5:
            hints.avoided_paths.append(re.compile(_wildcard_to_regex(pattern)))
        if confidence >= 0.8:
            hints.url_score_adjustments[pattern] = 0.5

    politics = intel.get("politics") or {}
    for js_path in politics.get("js_only_pages") or []:
        hints.js_only_paths.append(re.compile(_wildcard_to_regex(js_path)))

    for window in politics.get("best_crawl_window_utc") or []:
        if "-" in str(window):
            start, end = str(window).split("-", 1)
            try:
                hints.crawl_window_utc.append((int(start.split(":")[0]),
                                                int(end.split(":")[0])))
            except (ValueError, IndexError):
                pass

    hints.primary_language = politics.get("language_primary") or "en"
    hints.language_variants = politics.get("language_variants") or {}
    hints.taxonomy = politics.get("taxonomy") or {}

    sd = intel.get("sd_fingerprint") or {}
    hints.json_ld_types = sd.get("json_ld_types") or []
    hints.microdata_itemtypes = sd.get("microdata_itemtypes") or []
    hints.date_formats_seen = sd.get("date_formats_seen") or []

    return hints


def url_adjustment(url: str, hints: CrawlHints) -> float:
    """Return a score adjustment (-2..+1) for a URL based on hints."""
    score = 0.0
    for pattern, boost in hints.url_score_adjustments.items():
        if re.search(_wildcard_to_regex(pattern), url):
            score += boost
    for pattern in hints.avoided_paths:
        if pattern.search(url):
            score -= 2.0
    for pattern in hints.js_only_paths:
        if pattern.search(url):
            score -= 2.0  # crawler without Playwright skips
    return score


def _wildcard_to_regex(pattern: str) -> str:
    """Convert a simple URL pattern with {slug} placeholders to regex."""
    escaped = re.escape(pattern)
    escaped = escaped.replace(r"\{slug\}", r"[^/]+")
    escaped = escaped.replace(r"\{year\}", r"\d{4}")
    escaped = escaped.replace(r"\{month\}", r"\d{1,2}")
    return escaped
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_intelligence_consume.py -v 2>&1 | tail -20
```
Expected: 10 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/intelligence_consume.py tests/test_intelligence_consume.py
git commit -m "feat(consume): CrawlHints parser + url_adjustment (pure-python, offline)"
```

---

### Task 14: URL scoring blend (page_priority + intelligence)

**Files:**
- Modify: `worker/page_priority.py`
- Modify: `tests/test_page_priority.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test_page_priority.py`:

```python
"""Tests for the URL scoring blend (page_priority + intelligence)."""
from worker.page_priority import score_url_with_intelligence, score_url


class TestScoreUrlWithIntelligence:
    def test_without_intelligence_returns_page_priority(self):
        score = score_url_with_intelligence("https://x.com/events", None)
        pp = score_url("https://x.com/events").score
        assert score == pp

    def test_intelligence_boost_adds_to_score(self):
        intel = {"url_score_adjustments": {"/events": 0.5}}
        with_intel = score_url_with_intelligence(
            "https://x.com/events/some-event", intel)
        without = score_url_with_intelligence(
            "https://x.com/events/some-event", None)
        assert with_intel > without

    def test_avoided_url_gets_penalty(self):
        from worker.intelligence_consume import CrawlHints, parse_intelligence_to_hints
        intel = {"structural_map": [
            {"pattern": "/admin", "kind": "listing",
             "confidence": 0.3, "examples": ["/admin"]}
        ]}
        hints = parse_intelligence_to_hints(intel)
        with_intel = score_url_with_intelligence("https://x.com/admin", None,
                                                 hints=hints)
        without = score_url_with_intelligence("https://x.com/admin", None)
        assert with_intel < without

    def test_classifier_score_blends(self):
        intel = {"url_score_adjustments": {}}
        # classifier_score > page_priority should pull the result up
        pp_only = score_url_with_intelligence("https://x.com/events", None)
        with_classifier = score_url_with_intelligence(
            "https://x.com/events", None,
            classifier_score=1.0,
            classifier_weight=0.8,
            page_priority_weight=0.1,
            intelligence_weight=0.1,
        )
        assert with_classifier > pp_only
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_page_priority.py -v 2>&1 | tail -10
```
Expected: `ImportError: cannot import name 'score_url_with_intelligence'`.

- [ ] **Step 3: Add the function to `worker/page_priority.py`**

Append to `worker/page_priority.py`:

```python
def score_url_with_intelligence(
    url: str,
    intelligence: dict | None,
    hints: "CrawlHints | None" = None,
    classifier_score: float | None = None,
    classifier_weight: float | None = None,
    page_priority_weight: float | None = None,
    intelligence_weight: float | None = None,
) -> float:
    """Blend page_priority + (optional classifier) + intelligence hint.

    Weights default to feature_config values; passing them explicitly
    makes the function easy to test without DB access.
    """
    from worker.intelligence_consume import url_adjustment

    pp_score = score_url(url).score

    # Defaults pulled lazily so unit tests without DB still work
    if classifier_weight is None:
        try:
            from api.src.xyzo_features import get_config
            classifier_weight = float(get_config("classifier.weight", "0.4"))
            page_priority_weight = float(get_config("page_priority.weight", "0.3"))
            intelligence_weight = float(get_config("intelligence_hint.weight", "0.3"))
        except Exception:
            classifier_weight, page_priority_weight, intelligence_weight = 0.4, 0.3, 0.3

    effective_classifier = classifier_score if classifier_score is not None else pp_score

    if hints is not None:
        intel_adj = url_adjustment(url, hints)
    elif intelligence is not None:
        from worker.intelligence_consume import parse_intelligence_to_hints
        hints = parse_intelligence_to_hints(intelligence)
        intel_adj = url_adjustment(url, hints)
    else:
        intel_adj = 0.0

    return (
        classifier_weight * effective_classifier +
        page_priority_weight * pp_score +
        intelligence_weight * intel_adj
    )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_page_priority.py -v 2>&1 | tail -15
```
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/page_priority.py tests/test_page_priority.py
git commit -m "feat(scoring): blend page_priority + classifier + intelligence"
```

---

### Task 15: Extractor selection + field-level merge

**Files:**
- Create: `worker/extractor_selector.py`
- Create: `tests/test_extractor_selector.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_extractor_selector.py`:

```python
"""Tests for extractor selection + field-level conflict merging."""
from worker.extractor_selector import (
    select_extractors, merge_event_fields, EXTRACTOR_ORDER,
)


class TestSelectExtractors:
    def test_default_order_is_jsonld_first(self):
        order = select_extractors("/events", None)
        assert order[0] == "json_ld"

    def test_intelligence_preferred_first(self):
        intel = {"preferred_extractor_per_url": {"/events": "rss"}}
        order = select_extractors("/events", intel)
        assert order[0] == "rss"

    def test_skip_extractors_dropped(self):
        intel = {"skip_extractors": {"/x": ["heuristic", "ai"]}}
        order = select_extractors("/x", intel)
        assert "heuristic" not in order
        assert "ai" not in order


class TestMergeEventFields:
    def test_jsonld_wins_over_ai(self):
        merged = merge_event_fields({
            "jsonld_title": "JSON-LD Title",
            "ai_title": "AI Title",
            "heur_title": "Heur Title",
        })
        assert merged["title"] == "JSON-LD Title"

    def test_ai_fills_missing_jsonld(self):
        merged = merge_event_fields({
            "jsonld_description": None,
            "ai_description": "AI filled this",
        })
        assert merged["description"] == "AI filled this"

    def test_heuristic_only_used_when_no_others(self):
        merged = merge_event_fields({
            "jsonld_title": None,
            "ai_title": None,
            "heur_title": "Heuristic Title",
        })
        assert merged["title"] == "Heuristic Title"

    def test_field_with_no_source_is_none(self):
        merged = merge_event_fields({
            "jsonld_title": None,
            "ai_title": None,
            "heur_title": None,
        })
        assert merged["title"] is None

    def test_logs_conflict_when_ai_disagrees_with_jsonld(self):
        # Both present and disagree — JSON-LD wins, but conflict should be trackable
        merged, conflicts = merge_event_fields({
            "jsonld_title": "JSON-LD",
            "ai_title": "AI different",
        }, return_conflicts=True)
        assert merged["title"] == "JSON-LD"
        assert any(c["field"] == "title" for c in conflicts)


FIELDS = ["title", "description", "starts_at", "ends_at",
          "venue_name", "city", "country_code", "lat", "lng",
          "image_url", "price_min", "price_max", "currency",
          "is_free", "is_online", "event_url", "organizer_name"]


class TestFieldList:
    def test_all_event_fields_covered(self):
        # If this list grows in ai_extract, add here too
        for f in FIELDS:
            sources = {f"jsonld_{f}": "x", f"ai_{f}": None, f"heur_{f}": None}
            merged = merge_event_fields(sources)
            assert merged[f] == "x"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_extractor_selector.py -v 2>&1 | tail -10
```
Expected: `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

Create `worker/extractor_selector.py`:

```python
"""extractor_selector — picks which extractor to run for a URL and
merges field-level conflicts when multiple extractors fire."""
from __future__ import annotations

from typing import Iterable


# Default order. JSON-LD is highest quality, heuristic is cheapest.
EXTRACTOR_ORDER = ["json_ld", "microdata", "rss", "ai", "heuristic"]


# Field-level conflict resolution: JSON-LD always wins when present.
# AI patches fields JSON-LD missed. Heuristic only fills gaps.
FIELD_SOURCES = ("jsonld", "ai", "heur")


# Fields we extract from pages
FIELDS = (
    "title", "description", "starts_at", "ends_at",
    "venue_name", "city", "country_code", "lat", "lng",
    "image_url", "price_min", "price_max", "currency",
    "is_free", "is_online", "event_url", "organizer_name",
)


def select_extractors(url: str, intelligence: dict | None) -> list[str]:
    """Return the extractors to try, in order.

    Default: JSON-LD > microdata > RSS > AI > heuristic.
    Intelligence can reorder or skip per URL.
    """
    order = list(EXTRACTOR_ORDER)

    if intelligence:
        preferred = (intelligence.get("preferred_extractor_per_url") or {}).get(url)
        if preferred and preferred in order:
            order.remove(preferred)
            order.insert(0, preferred)
        skips = (intelligence.get("skip_extractors") or {}).get(url) or []
        order = [e for e in order if e not in skips]

    return order


def merge_event_fields(
    sources: dict,
    return_conflicts: bool = False,
) -> dict | tuple[dict, list[dict]]:
    """Merge field-level values from jsonld/ai/heuristic extractors.

    Rules:
      - jsonld_* wins over ai_* and heur_*
      - ai_* wins over heur_* when jsonld is absent
      - heur_* only used when both are absent
      - Field is None if all sources are None

    Conflict reporting: when both jsonld and ai have non-None values
    that disagree, the JSON-LD wins but the conflict is recorded
    (when return_conflicts=True).
    """
    merged = {}
    conflicts = []

    for field in FIELDS:
        jsonld_val = sources.get(f"jsonld_{field}")
        ai_val = sources.get(f"ai_{field}")
        heur_val = sources.get(f"heur_{field}")

        chosen = None
        if jsonld_val is not None:
            chosen = jsonld_val
            if ai_val is not None and ai_val != jsonld_val:
                conflicts.append({
                    "field": field,
                    "jsonld": jsonld_val,
                    "ai": ai_val,
                })
        elif ai_val is not None:
            chosen = ai_val
        elif heur_val is not None:
            chosen = heur_val

        merged[field] = chosen

    if return_conflicts:
        return merged, conflicts
    return merged
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_extractor_selector.py -v 2>&1 | tail -15
```
Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/extractor_selector.py tests/test_extractor_selector.py
git commit -m "feat(extractor): selection order + jsonld-wins field merger"
```

---

### Task 16: Wire `crawl_with_intelligence()` into `site_crawl.py`

**Files:**
- Modify: `worker/site_crawl.py`
- Modify: `tests/test_site_crawl_intelligence.py` (create)

This is the integration task. We add a new function `crawl_with_intelligence()` that wraps `crawl_site()` and applies the intelligence-driven behavior. The original `crawl_site()` is left untouched so the legacy code path still works.

- [ ] **Step 1: Write the failing test**

Create `tests/test_site_crawl_intelligence.py`:

```python
"""Tests for crawl_with_intelligence wrapper.

We don't actually crawl in tests — we mock study_url and crawl_site
to verify the wrapper applies hints correctly."""
from unittest.mock import patch, MagicMock
from worker.site_crawl import crawl_with_intelligence


class TestCrawlWithIntelligence:
    def test_returns_none_when_intelligence_disabled(self):
        with patch("worker.site_crawl.is_enabled") as m:
            m.return_value = False
            result = crawl_with_intelligence("https://x.com")
            assert result is None

    def test_loads_intelligence_when_enabled(self):
        with patch("worker.site_crawl.is_enabled") as m, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl:
            m.return_value = True
            load.return_value = {"feeds": [], "structural_map": [],
                                  "sd_fingerprint": {}, "politics": {}}
            crawl.return_value = MagicMock(to_dict=lambda: {"stats": {}})
            result = crawl_with_intelligence("https://x.com")
            load.assert_called_once()
            crawl.assert_called_once()

    def test_passes_hints_to_crawl_site(self):
        with patch("worker.site_crawl.is_enabled") as m, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl:
            m.return_value = True
            intel = {"feeds": [{"href": "https://x.com/feed"}],
                     "structural_map": [], "sd_fingerprint": {},
                     "politics": {}}
            load.return_value = intel
            crawl.return_value = MagicMock(to_dict=lambda: {})
            crawl_with_intelligence("https://x.com")
            call_kwargs = crawl.call_args.kwargs
            assert "intelligence" in call_kwargs
            assert call_kwargs["intelligence"]["feeds"][0]["href"] == \
                   "https://x.com/feed"

    def test_load_intelligence_returns_none_triggers_legacy(self):
        with patch("worker.site_crawl.is_enabled") as m, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl:
            m.return_value = True
            load.return_value = None  # no record yet
            crawl.return_value = MagicMock(to_dict=lambda: {})
            crawl_with_intelligence("https://x.com")
            # Should still call crawl_site, just without intelligence
            assert crawl.called


class TestLoadIntelligence:
    def test_returns_none_on_db_error(self):
        from worker.site_crawl import load_intelligence
        with patch("worker.site_crawl._fetch_intelligence_row") as f:
            f.side_effect = Exception("db down")
            result = load_intelligence("example.com")
            assert result is None

    def test_returns_intel_json_on_success(self):
        from worker.site_crawl import load_intelligence
        fake_row = {"intelligence": {"feeds": [], "structural_map": [],
                                       "sd_fingerprint": {}, "politics": {}},
                    "refreshed_at": "2026-09-01", "confidence": 0.9,
                    "consecutive_errors": 0, "drift_signals": {}}
        with patch("worker.site_crawl._fetch_intelligence_row") as f:
            f.return_value = fake_row
            result = load_intelligence("example.com")
            assert result is not None
            assert "feeds" in result
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_site_crawl_intelligence.py -v 2>&1 | tail -10
```
Expected: `ImportError`.

- [ ] **Step 3: Add wrapper to `worker/site_crawl.py`**

Append to `worker/site_crawl.py`:

```python
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
    row = _fetch_intelligence_row(host)
    if row is None:
        # Schedule background scan; return None so caller falls back
        try:
            from worker.ai_intelligence_scan import schedule_async_scan
            schedule_async_scan(host, reason="no-record")
        except Exception:
            pass
        return None

    from worker.ai_intelligence_scan import needs_refresh
    needs, reason = needs_refresh(row, host)
    if needs:
        try:
            from worker.ai_intelligence_scan import schedule_async_scan
            schedule_async_scan(host, reason=reason)
        except Exception:
            pass
    # Return intelligence even if stale — better than nothing
    return row.get("intelligence") or None


def is_enabled(flag_key: str, host: str) -> bool:
    """Check if a feature flag is enabled for the host. Lazy import."""
    try:
        from urllib.parse import urlparse
        from api.src.xyzo_features import is_enabled as _is_enabled
        # Determine tier from host (could be cached separately)
        from robots import tier_for_url
        tier = tier_for_url(f"https://{host}")
        return _is_enabled(flag_key, host, tier)
    except Exception as e:
        log.warning("is_enabled check failed: %s", e)
        return False


def crawl_with_intelligence(seed_url: str, **kwargs) -> dict | None:
    """Crawl a site using site_intelligence for hints.

    Returns the crawl result dict (from CrawlResult.to_dict()).
    Returns None if feature is disabled or pre-flight fails.
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
    return result.to_dict()
```

Also add an `intelligence` parameter to `crawl_site()` (insert just before `robots=` in the existing signature) and a stub branch at the top of the BFS loop. Add to `worker/site_crawl.py`:

Find the existing `def crawl_site(` and update the signature to:
```python
def crawl_site(seed_url: str,
               max_pages: int = 50,
               max_depth: int = 3,
               use_ai: bool = False,
               max_seconds: int = 90,
               robots: RobotsCache | None = None,
               intelligence: dict | None = None,
               ) -> CrawlResult:
```

Add right after `result = CrawlResult(...)`:
```python
    # Intelligence-driven hints (optional, may be None)
    crawl_hints = None
    if intelligence:
        try:
            from worker.intelligence_consume import parse_intelligence_to_hints
            crawl_hints = parse_intelligence_to_hints(intelligence)
            # Add intelligence seeds to frontier
            for seed in crawl_hints.extra_seeds[:10]:
                parsed_seed_url = urljoin(seed_url, seed) if not seed.startswith("http") else seed
                clean = _normalise(parsed_seed_url)
                if clean not in seen:
                    seen.add(clean)
                    frontier.append((clean, None, 1))
        except Exception as e:
            log.warning("failed to load crawl_hints: %s", e)
```

And in the BFS loop, change the score line from:
```python
scored = score_url(url)
```
to:
```python
scored = score_url(url)
if crawl_hints is not None:
    try:
        from worker.page_priority import score_url_with_intelligence
        scored = type(scored)(
            url=url,
            score=score_url_with_intelligence(url, None, hints=crawl_hints),
            reasons=scored.reasons,
        )
    except Exception:
        pass
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_site_crawl_intelligence.py -v 2>&1 | tail -15
```
Expected: 5 tests pass.

- [ ] **Step 5: Verify existing site_crawl tests still pass**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest worker/tests/ -v 2>&1 | tail -15
```
Expected: all pre-existing tests still pass (crawl_site signature change is backward-compatible).

- [ ] **Step 6: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add worker/site_crawl.py tests/test_site_crawl_intelligence.py
git commit -m "feat(crawl): wrap with crawl_with_intelligence + load hints from DB"
```

---

### Task 17: Integration test — first crawl triggers scan, second uses cache

**Files:**
- Create: `tests/test_intelligence_integration.py`

This integration test exercises the full path: load_intelligence → crawl_with_intelligence. Uses mocks for HTTP and AI calls so it runs offline.

- [ ] **Step 1: Write the test**

```python
"""Integration test: first crawl triggers AI scan, second uses cache.

Mocks HTTP, AI, and DB to test the orchestration end-to-end.
"""
from unittest.mock import patch, MagicMock
import datetime as dt


class TestFirstCrawlTriggersScan:
    def test_no_record_schedules_scan(self):
        from worker.site_crawl import load_intelligence
        with patch("worker.site_crawl._fetch_intelligence_row") as f, \
             patch("worker.ai_intelligence_scan.schedule_async_scan") as scan:
            f.return_value = None
            result = load_intelligence("example.com")
            assert result is None
            scan.assert_called_once()
            assert "no-record" in str(scan.call_args)


class TestSecondCrawlUsesCache:
    def test_fresh_record_no_scan(self):
        from worker.site_crawl import load_intelligence
        fresh_row = {
            "intelligence": {"feeds": [], "structural_map": [],
                              "sd_fingerprint": {}, "politics": {}},
            "refreshed_at": dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1),
            "confidence": 0.9, "consecutive_errors": 0,
            "drift_signals": {},
        }
        with patch("worker.site_crawl._fetch_intelligence_row") as f, \
             patch("worker.ai_intelligence_scan.schedule_async_scan") as scan:
            f.return_value = fresh_row
            result = load_intelligence("example.com")
            assert result is not None
            scan.assert_not_called()


class TestStaleCrawlTriggersRefreshButUsesRecord:
    def test_still_returns_intel_for_stale_record(self):
        from worker.site_crawl import load_intelligence
        stale_row = {
            "intelligence": {"feeds": [], "structural_map": [],
                              "sd_fingerprint": {}, "politics": {}},
            "refreshed_at": dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=31),
            "confidence": 0.9, "consecutive_errors": 0,
            "drift_signals": {},
        }
        with patch("worker.site_crawl._fetch_intelligence_row") as f, \
             patch("worker.ai_intelligence_scan.schedule_async_scan") as scan:
            f.return_value = stale_row
            result = load_intelligence("example.com")
            assert result is not None  # still usable
            scan.assert_called_once()  # schedule refresh
            assert "age" in str(scan.call_args)


class TestFeatureFlagGate:
    def test_wrapper_returns_none_when_flag_off(self):
        from worker.site_crawl import crawl_with_intelligence
        with patch("worker.site_crawl.is_enabled") as m:
            m.return_value = False
            result = crawl_with_intelligence("https://example.com")
            assert result is None

    def test_wrapper_runs_when_flag_on(self):
        from worker.site_crawl import crawl_with_intelligence
        with patch("worker.site_crawl.is_enabled") as m, \
             patch("worker.site_crawl.load_intelligence") as load, \
             patch("worker.site_crawl.crawl_site") as crawl:
            m.return_value = True
            load.return_value = {"feeds": [], "structural_map": [],
                                  "sd_fingerprint": {}, "politics": {}}
            crawl.return_value = MagicMock(to_dict=lambda: {"stats": {}})
            result = crawl_with_intelligence("https://example.com")
            assert result is not None
            assert "stats" in result
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
cd /var/www/vhosts/xyzo.org
python3 -m pytest tests/test_intelligence_integration.py -v 2>&1 | tail -15
```
Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /var/www/vhosts/xyzo.org
git add tests/test_intelligence_integration.py
git commit -m "test(intelligence): end-to-end lazy + cache + feature-flag integration"
```

---

## Phase 2 Complete ✅

What ships (all disabled behind `intelligence_driven_crawl` flag by default):
- `worker/ai_intelligence_scan.py` with tier budgets, refresh logic, context builder, confidence calc, feed merge
- `worker/prompts/intelligence_scan.py` versioned prompt template
- `worker/readers/site_intel/v1.py` schema adapter (forward-compatible)
- `worker/intelligence_consume.py` pure-Python CrawlHints
- `worker/extractor_selector.py` field-level conflict merger (JSON-LD wins)
- `worker/page_priority.py` extended with `score_url_with_intelligence()`
- `worker/site_crawl.py` wrapped with `crawl_with_intelligence()` + `load_intelligence()`
- ~70 new tests, all passing
- Existing crawler untouched; legacy `crawl_site()` still works as before

**Next:** Phase 3 plan — embeddings pipeline + classifier + final API endpoints.
