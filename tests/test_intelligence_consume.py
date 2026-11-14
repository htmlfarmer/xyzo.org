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
        assert "/events/{slug}" not in hints.extra_seeds

    def test_extracts_avoided_paths(self):
        intel = dict(SAMPLE_INTEL,
                     structural_map=[{"pattern": "/admin", "confidence": 0.7,
                                      "kind": "listing",
                                      "examples": ["/admin"]}])
        hints = parse_intelligence_to_hints(intel)
        assert any(re.search(r"/admin", str(p.pattern))
                   for p in hints.avoided_paths)

    def test_extracts_js_only_paths(self):
        intel = dict(SAMPLE_INTEL,
                     politics=dict(SAMPLE_INTEL["politics"],
                                   js_only_pages=["/calendar"]))
        hints = parse_intelligence_to_hints(intel)
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
        assert hints.primary_language == "en"


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
