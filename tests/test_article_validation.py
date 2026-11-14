"""Unit tests for non-AI article validation, location auditing, and source quality.

Validates that article positioning, distance mismatch detection, paywall heuristics,
and city text extractions function deterministically without requiring AI models.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make project root importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from worker import audit_locations, cities_text, paywall


class TestAuditLocations:
    def test_distance_rule_fired(self):
        # Pin in London (51.5074, -0.1278), but title says Tokyo
        pin = {
            "id": 101,
            "title": "Major earthquake hits Tokyo early today",
            "lat": 51.5074,
            "lng": -0.1278,
            "location_precision": "city",
            "confidence_score": 0.9,
            "status": "published",
            "source_type": "rss",
            "source_feed": "BBC",
            "source_country": "GB",
        }
        correction = audit_locations.evaluate_pin(pin)
        assert correction is not None
        assert "distance" in correction.rules_fired
        assert correction.after["place_name"] == "Tokyo"
        assert abs(correction.after["lat"] - 35.6895) < 0.1

    def test_no_city_in_title_returns_none(self):
        pin = {
            "id": 102,
            "title": "Markets tumble worldwide on interest rate fears",
            "lat": 40.7128,
            "lng": -74.0060,
            "location_precision": "city",
            "confidence_score": 0.8,
            "status": "published",
            "source_type": "rss",
        }
        correction = audit_locations.evaluate_pin(pin)
        assert correction is None

    def test_low_confidence_rule_fired(self):
        # Pin in Karachi with low confidence score 0.3
        pin = {
            "id": 103,
            "title": "Protest march reported in Karachi",
            "lat": 31.5204,  # Lahore coords instead of Karachi
            "lng": 74.3587,
            "location_precision": "city",
            "confidence_score": 0.3,
            "status": "published",
            "source_type": "rss",
        }
        correction = audit_locations.evaluate_pin(pin, rules=("low_conf", "distance"))
        assert correction is not None
        assert "low_conf" in correction.rules_fired

    def test_title_mismatch_rule(self):
        # Pin located in Sydney, title mentions Paris
        pin = {
            "id": 104,
            "title": "New art exhibition opens in Paris museum",
            "lat": -33.8688,
            "lng": 151.2093,
            "location_precision": "city",
            "confidence_score": 0.9,
            "status": "published",
            "source_type": "rss",
        }
        correction = audit_locations.evaluate_pin(pin, rules=("title_mismatch",))
        assert correction is not None
        assert "title_mismatch" in correction.rules_fired
        assert correction.after["country"] == "FR"


class TestNonAICityDetection:
    def test_city_extraction_precision(self):
        text = "Protesters gathered outside government buildings in Islamabad and Lahore today."
        matches = cities_text.find_cities_in_text(text, min_population=100_000)
        detected_names = {m["city"]["name"] for m in matches}
        assert "Islamabad" in detected_names or "Lahore" in detected_names

    def test_multi_word_city_wins(self):
        text = "Heavy snowfall disrupts transport in New York City."
        matches = cities_text.find_cities_in_text(text, min_population=100_000)
        assert len(matches) > 0
        assert matches[0]["city"]["name"] in ("New York City", "New York")

    def test_title_priority_disambiguation(self):
        text = "Tokyo election results announced\nDelegates previously met in Osaka last month."
        st = cities_text.stats(text)
        assert st["primary"] is not None
        assert st["primary"]["name"] == "Tokyo"


class TestPaywallDetection:
    def test_paywall_keyword_detection(self):
        html = "<html><body><h1>Exclusive Article</h1><p>Subscribe to read the full story. Subscriber-only content.</p></body></html>"
        res = paywall.detect_paywall(body=html)
        assert res["is_paywalled"] is True
        assert res["confidence"] >= 0.70

    def test_open_article_not_paywalled(self):
        html = "<html><body><h1>Public News</h1><p>Free public report on local community updates.</p></body></html>"
        res = paywall.detect_paywall(body=html)
        assert res["is_paywalled"] is False

