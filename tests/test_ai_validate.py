"""Unit tests for worker/ai_validate.py — pure-function tests for the
heuristic validator. No AI, no DB.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from worker import ai_validate  # noqa: E402


def _req(**overrides):
    base = {
        "article_title": "",
        "article_body": "",
        "user_place": "",
        "current_place_name": "",
    }
    base.update(overrides)
    return base


class TestHeuristicValidate:
    def test_strong_match_is_valid(self):
        r = ai_validate._heuristic_validate(_req(
            article_title="Strong earthquake hits Tokyo, Japan",
            article_body="A 7.1 magnitude earthquake struck Tokyo early today.",
            user_place="Tokyo, Japan",
            current_place_name="Seoul",
        ))
        assert r["valid"] is True
        assert r["method"] == "heuristic"
        assert r["confidence"] >= 0.4
        assert "Tokyo" in r["suggested_place"]

    def test_no_signal_is_invalid(self):
        r = ai_validate._heuristic_validate(_req(
            article_title="Strong earthquake hits Tokyo, Japan",
            article_body="A 7.1 magnitude earthquake struck Tokyo early today.",
            user_place="Antarctica",
            current_place_name="Seoul",
        ))
        assert r["valid"] is False
        assert r["method"] == "heuristic"
        assert r["suggested_place"] is None

    def test_confirm_current_location_accepted(self):
        # Article is about Seoul, user confirms Seoul — that's valid.
        r = ai_validate._heuristic_validate(_req(
            article_title="Election results in Seoul",
            article_body="Voters in Seoul cast their ballots.",
            user_place="Seoul, South Korea",
            current_place_name="Seoul",
        ))
        assert r["valid"] is True
        assert r["confidence"] > 0

    def test_empty_user_suggestion_rejected(self):
        r = ai_validate._heuristic_validate(_req(
            article_title="Some story",
            article_body="Some body",
            user_place="",
        ))
        assert r["valid"] is False
        assert "no user suggestion" in r["reasoning"].lower()
        assert r["suggested_place"] is None

    def test_confidence_capped(self):
        # Confidence should never exceed 0.85 even with very strong
        # signals — admins should know heuristics aren't gospel.
        r = ai_validate._heuristic_validate(_req(
            article_title="Breaking: massive Tokyo earthquake",
            article_body="Huge Tokyo Tokyo Tokyo earthquake earthquake earthquake",
            user_place="Tokyo",
            current_place_name="Berlin",
        ))
        assert r["confidence"] <= 0.85

    def test_returns_method_field(self):
        r = ai_validate._heuristic_validate(_req(user_place="Berlin"))
        assert r["method"] == "heuristic"

    def test_returns_validated_at(self):
        r = ai_validate._heuristic_validate(_req(user_place="Berlin"))
        assert "validated_at" in r
        # ISO 8601 timestamp.
        assert "T" in r["validated_at"]

    def test_reasoning_includes_heuristic_label(self):
        r = ai_validate._heuristic_validate(_req(
            article_title="Story",
            user_place="Tokyo",
        ))
        assert r["reasoning"].startswith("Heuristic:")