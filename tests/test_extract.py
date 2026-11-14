"""Unit tests for worker/extract.py — pure function tests for the
regex fallback and circuit breaker. These run without AI or DB.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make the project root importable so `from worker.extract import …` works.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from worker import extract  # noqa: E402


# ── _regex_fallback ─────────────────────────────────────────────────

class TestRegexFallback:
    def test_earthquake_in_tokyo(self):
        r = extract._regex_fallback(
            "Strong earthquake hits Tokyo, Japan — magnitude 7.1",
            "A 7.1 magnitude earthquake struck Tokyo early today.",
        )
        assert r["location_text"] and "Tokyo" in r["location_text"]
        assert r["event_type"] == "earthquake"
        assert r["summary"]
        assert isinstance(r["entities"], list)
        assert isinstance(r["topic_tags"], list)

    def test_no_location_still_has_event_type(self):
        r = extract._regex_fallback("Markets tumble on inflation news", "")
        assert r["event_type"] in ("markets", "banking", "other")
        # Summary is the title (truncated to 200 chars).
        assert r["summary"]

    def test_empty_input(self):
        r = extract._regex_fallback("", "")
        assert isinstance(r, dict)
        assert "summary" in r
        assert "event_type" in r

    def test_event_type_is_known_or_other(self):
        # All outputs must be in the known EVENT_TYPES set or "other".
        from worker.extract import EVENT_TYPES
        r = extract._regex_fallback("Random headline here", "")
        assert r["event_type"] in EVENT_TYPES

    def test_summary_truncated(self):
        long_body = "lorem ipsum " * 200
        r = extract._regex_fallback("Test title", long_body)
        # Summary combines title + first sentence; capped at 300.
        assert len(r["summary"]) <= 310


# ── Circuit breaker ─────────────────────────────────────────────────

class TestCircuitBreaker:
    def setup_method(self):
        # Reset breaker state before each test.
        extract._breaker_state["failures"].clear()
        extract._breaker_state["open_until"] = 0.0

    def test_allows_when_no_failures(self):
        assert extract._ai_call_allowed() is True

    def test_opens_after_threshold(self):
        for _ in range(extract._BREAKER_FAIL_THRESHOLD):
            extract._ai_record_failure("test")
        assert extract._ai_call_allowed() is False

    def test_success_closes_breaker(self):
        for _ in range(extract._BREAKER_FAIL_THRESHOLD):
            extract._ai_record_failure("test")
        extract._ai_record_success()
        assert extract._ai_call_allowed() is True
        assert extract._breaker_state["failures"] == []

    def test_snapshot_shape(self):
        snap = extract.breaker_snapshot()
        assert "open" in snap
        assert "open_for_seconds" in snap
        assert "recent_failures" in snap
        assert "fail_threshold" in snap
        assert snap["fail_threshold"] == extract._BREAKER_FAIL_THRESHOLD

    def test_below_threshold_still_allows(self):
        # One or two failures shouldn't open the breaker.
        for _ in range(extract._BREAKER_FAIL_THRESHOLD - 1):
            extract._ai_record_failure("test")
        assert extract._ai_call_allowed() is True

    def test_old_failures_pruned(self):
        # Failures older than the window should be pruned.
        import time as _time
        old = _time.time() - (extract._BREAKER_FAIL_WINDOW_S + 5)
        extract._breaker_state["failures"].append(old)
        # A new failure below threshold should leave the breaker closed.
        extract._ai_record_failure("recent")
        assert len(extract._breaker_state["failures"]) == 1
        assert extract._breaker_state["failures"][0] != old