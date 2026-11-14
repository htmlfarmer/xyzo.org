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
