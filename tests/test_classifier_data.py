"""Tests for classifier training data extraction.

These tests patch ``worker.classifier._query_training_data`` so no real
DB connection is ever attempted.
"""
from unittest.mock import patch

from worker.classifier import (
    fetch_training_samples, TrainingSample, _label_to_richness,
    _extract_event_type,
)


class TestLabelToRichness:
    def test_events_present_high(self):
        assert _label_to_richness(5, False, False) >= 0.8

    def test_only_heuristic_medium(self):
        assert 0.4 <= _label_to_richness(0, False, True) <= 0.7

    def test_nothing_low(self):
        assert _label_to_richness(0, False, False) <= 0.2

    def test_caps_at_one(self):
        assert _label_to_richness(50, True, True) <= 1.0


class TestExtractEventType:
    def test_jsonld_event(self):
        assert _extract_event_type([{"@type": "MusicEvent"}]) == "concert"

    def test_jsonld_sportsevent(self):
        assert _extract_event_type([{"@type": "SportsEvent"}]) == "sports"

    def test_no_events_returns_other(self):
        assert _extract_event_type([]) == "other"

    def test_unknown_type_returns_other(self):
        assert _extract_event_type([{"@type": "MysteryType"}]) == "other"


class TestFetchTrainingSamples:
    def test_returns_list_of_training_samples(self):
        fake_rows = [
            {"url": "https://x.com/events", "json_ld_events": [{"@type": "Event"}],
             "heuristic_events": [], "signals": []},
            {"url": "https://x.com/about", "json_ld_events": [],
             "heuristic_events": [], "signals": ["rss_autodiscovery"]},
        ]
        with patch("worker.classifier._query_training_data") as q:
            q.return_value = fake_rows
            samples = fetch_training_samples()
            assert len(samples) == 2
            assert all(isinstance(s, TrainingSample) for s in samples)

    def test_handles_db_error(self):
        with patch("worker.classifier._query_training_data") as q:
            q.side_effect = Exception("db down")
            samples = fetch_training_samples()
            assert samples == []


# ── Tier filter (deviation from spec) ────────────────────────────────
#
# Standing constraint: gov / university events must never be the basis
# for derived signals (crawling, auto-merge, classifier training).
# The training set must therefore EXCLUDE rows from protected tiers.
# We mock ``_query_training_data`` to return rows with a `tier` key —
# the implementation is responsible for filtering them out.

class TestTierFilter:
    def test_filters_out_gov_tier(self):
        fake_rows = [
            {"url": "https://x.com/events", "tier": "commercial",
             "json_ld_events": [{"@type": "Event"}],
             "heuristic_events": [], "signals": []},
            {"url": "https://city.gov/calendar", "tier": "gov",
             "json_ld_events": [{"@type": "Event"}],
             "heuristic_events": [], "signals": []},
        ]
        with patch("worker.classifier._query_training_data") as q:
            q.return_value = fake_rows
            samples = fetch_training_samples()
            urls = [s.url for s in samples]
            assert "https://x.com/events" in urls
            assert "https://city.gov/calendar" not in urls

    def test_filters_out_university_tier(self):
        fake_rows = [
            {"url": "https://example.edu/events", "tier": "university",
             "json_ld_events": [{"@type": "Event"}],
             "heuristic_events": [], "signals": []},
            {"url": "https://x.com/events", "tier": "commercial",
             "json_ld_events": [{"@type": "Event"}],
             "heuristic_events": [], "signals": []},
        ]
        with patch("worker.classifier._query_training_data") as q:
            q.return_value = fake_rows
            samples = fetch_training_samples()
            urls = [s.url for s in samples]
            assert "https://example.edu/events" not in urls
            assert "https://x.com/events" in urls

    def test_keeps_commercial_and_community(self):
        fake_rows = [
            {"url": "https://acme.com/events", "tier": "commercial",
             "json_ld_events": [{"@type": "Event"}],
             "heuristic_events": [], "signals": []},
            {"url": "https://arts.org/events", "tier": "community",
             "json_ld_events": [{"@type": "Event"}],
             "heuristic_events": [], "signals": []},
        ]
        with patch("worker.classifier._query_training_data") as q:
            q.return_value = fake_rows
            samples = fetch_training_samples()
            urls = [s.url for s in samples]
            assert "https://acme.com/events" in urls
            assert "https://arts.org/events" in urls
