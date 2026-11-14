"""Tests for AI scan tier budgets and configuration."""
from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from worker.ai_intelligence_scan import (  # noqa: E402
    ScanBudget, TIER_BUDGETS, budget_for_tier, needs_refresh,
    total_pages_in_budget, build_scan_context,
    compute_intelligence_confidence, merge_feed_findings, ScanResult,
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


def _record(**overrides):
    """Build a fake record dict matching site_intelligence row shape.

    Defaults are deliberately *fresh* (recent refreshed_at, high
    confidence, no errors, healthy drift) so each test can override a
    single field and isolate the trigger it cares about. A stale
    refreshed_at here would make the higher-priority age check mask the
    confidence and drift triggers.
    """
    base = {
        "host": "example.com",
        "format_version": 1,
        "refreshed_at": dt.datetime(2026, 9, 5, tzinfo=dt.timezone.utc),
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

    def test_error_check_beats_age_check(self):
        """Priority 2 (errors) wins over priority 3 (age)."""
        now = dt.datetime(2026, 9, 6, tzinfo=dt.timezone.utc)
        record = _record(
            refreshed_at=now - dt.timedelta(days=60),
            consecutive_errors=5,
        )
        needs, reason = needs_refresh(record, "x.com", now=now)
        assert needs is True
        assert "errors" in reason

    def test_age_beats_low_confidence(self):
        """Priority 3 (age) wins over priority 4 (low-conf)."""
        now = dt.datetime(2026, 9, 6, tzinfo=dt.timezone.utc)
        record = _record(
            refreshed_at=now - dt.timedelta(days=60),
            confidence=0.1,
        )
        needs, reason = needs_refresh(record, "x.com", now=now)
        assert needs is True
        assert "age" in reason

    def test_low_confidence_beats_drift(self):
        """Priority 4 (low-conf) wins over priority 5 (feed-drift)."""
        now = dt.datetime(2026, 9, 6, tzinfo=dt.timezone.utc)
        record = _record(
            confidence=0.1,
            drift_signals={
                "predicted_feeds_alive": 1,
                "predicted_feeds_total": 5,
                "predicted_paths_returning_events": 1,
                "predicted_paths_total": 10,
            },
        )
        needs, reason = needs_refresh(record, "x.com", now=now)
        assert needs is True
        assert "low-conf" in reason


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
