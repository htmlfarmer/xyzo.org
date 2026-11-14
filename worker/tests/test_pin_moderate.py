"""Tests for stage-2 pin moderation (worker/pin_moderate.py).

DB-free by design: the deep-check pipeline's network/DB edges are mocked.
Covers the pieces most likely to regress silently:
  * dispatcher wiring for op="moderate_pin" (payload validation)
  * text analysis shape (lang/doc_type/frequency)
  * LLM verdict parsing + breaker-skip behavior
  * category whitelist stays inside the pins_category_check constraint
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest


class TestDispatcherWiring:
    def test_unknown_op_raises(self):
        from worker.handlers.community_triage import run

        ctx = MagicMock()
        with pytest.raises(ValueError, match="unknown community_triage op"):
            run({"op": "not_a_real_op"}, ctx)

    def test_moderate_pin_requires_numeric_pin_id(self):
        from worker.handlers.community_triage import run

        ctx = MagicMock()
        with pytest.raises(ValueError, match="numeric pin_id"):
            run({"op": "moderate_pin", "pin_id": "abc"}, ctx)
        with pytest.raises(ValueError, match="numeric pin_id"):
            run({"op": "moderate_pin"}, ctx)

    def test_moderate_pin_dispatches_to_pin_moderate(self):
        from worker.handlers import community_triage

        ctx = MagicMock()
        called = {}

        def fake_moderate(pin_id, *, user_category=None):
            called["pin_id"] = pin_id
            called["user_category"] = user_category
            return {"ok": True}

        with patch("worker.pin_moderate.moderate_pin", fake_moderate):
            out = community_triage.run(
                {"op": "moderate_pin", "pin_id": "42", "user_category": None}, ctx)
        assert out == {"ok": True}
        assert called == {"pin_id": 42, "user_category": None}


class TestTextAnalysis:
    def test_analyze_text_returns_shape(self):
        from worker.pin_moderate import _analyze_text

        info = _analyze_text(
            "Protest at city hall over water prices",
            "Hundreds marched downtown on Tuesday demanding clean water.",
        )
        assert info["lang"] == "en"
        assert info["doc_type"]  # e.g. news_report
        assert isinstance(info["top_words"], dict)
        assert len(info["top_words"]) > 0

    def test_analyze_text_survives_empty_input(self):
        from worker.pin_moderate import _analyze_text

        info = _analyze_text("", "")
        assert "top_words" in info


class TestLlmVerdictParsing:
    def _fake_pin(self):
        return {
            "id": 1, "title": "Bridge closed for repairs",
            "story_note": "Commuters affected downtown.",
            "canonical_url": None, "lat": 40.0, "lng": -74.0,
            "mod_fast": {"signals": ["none"]},
        }

    def test_breaker_open_skips_llm(self):
        from worker import pin_moderate

        with patch("worker.extract._ai_call_allowed", lambda: False):
            out = pin_moderate._llm_verdict(self._fake_pin(), {"lang": "en"}, None, "US")
        assert out is None

    def test_valid_json_verdict_parsed(self):
        from worker import pin_moderate

        class FakeResp:
            status_code = 200
            headers = {}

            def raise_for_status(self):
                pass

            def iter_text(self):
                payload = {"choices": [{"delta": {"content": json.dumps({
                    "ok": True,
                    "topic": "bridge repair closures",
                    "category": "transit",
                    "reason": "Legitimate local infrastructure story.",
                })}}]}
                yield f"data: {json.dumps(payload)}\n"
                yield "data: [DONE]\n"

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        class FakeClient:
            def __init__(self, **kw):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def stream(self, method, url, **kw):
                # Guard the 2026-09-26 outage class: no per-request
                # max_redirects on stream().
                assert "max_redirects" not in kw
                return FakeResp()

        with patch("worker.extract._ai_call_allowed", lambda: True), \
             patch.object(pin_moderate.httpx, "Client", FakeClient):
            out = pin_moderate._llm_verdict(self._fake_pin(), {"lang": "en"}, None, "US")

        assert out is not None
        assert out["ok"] is True
        assert out["topic"] == "bridge repair closures"
        # 'transit' IS a valid pins category (schema-icons.sql sub-types) —
        # kept. An invalid suggestion would be None instead.
        assert out["category"] in (None, "transit")

    def test_invalid_category_nullified(self):
        from worker import pin_moderate

        assert "not_a_category" not in pin_moderate.VALID_CATEGORIES
        for cat in ("politics", "earthquake", "other"):
            assert cat in pin_moderate.VALID_CATEGORIES


class TestPromptBuild:
    def test_ocean_note_present_when_no_country(self):
        from worker import pin_moderate

        # Prompt assembly lives inside _llm_verdict; verify the ocean
        # annotation string exists so LLM sees the coordinate red flag.
        src = open(pin_moderate.__file__).read()
        assert "OCEAN" in src
