"""Tests for the daily digest engine (worker/daily_digest.py).

The pure parts (scoring, the world test, duplicate detection, the variety
pass, the veto patterns) are tested without a database — the DB is only
touched by the fetch_* helpers.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from worker import daily_digest as dd  # noqa: E402


NOW = datetime(2026, 10, 23, 12, 0, tzinfo=timezone.utc)


def _cand(eid=1, **kw):
    base = {
        "id": eid,
        "headline": "Something important happened in a place that matters",
        "summary": "",
        "event_type": "conflict",
        "first_reported_at": NOW - timedelta(hours=3),
        "velocity_score": 100.0,
        "acceleration_1h": 5.0,
        "acceleration_6h": 10.0,
        "articles_1h": 3,
        "articles_6h": 10,
        "articles_24h": 20,
        "sources_1h": 2,
        "sources_6h": 5,
        "sources_24h": 8,
        "countries_24h": 3,
        "syndicated_copies": 0,
        "unique_sources": 8,
        "first_article_at": NOW - timedelta(hours=3),
        "last_article_at": NOW,
        "geographic_spread_km": 900.0,
        "place_name": "Kyiv",
        "country": "UA",
        "lat": 50.45,
        "lng": 30.52,
    }
    base.update(kw)
    return base


def _stats(eid, outlets, countries=3, articles=None, names=None, article_ids=None):
    return {
        eid: {
            "articles": articles if articles is not None else outlets * 2,
            "outlets": outlets,
            "outlet_countries": countries,
            "credible_outlets": outlets,
            "top_outlets": max(0, outlets - 4),
            "languages": 2,
            "credible_names": names or [f"Outlet {i}" for i in range(outlets)],
            "article_ids": set(article_ids or range(eid * 100, eid * 100 + outlets * 3)),
        }
    }


# ── headline cleaning ─────────────────────────────────────────────────────

def test_clean_headline_strips_css_fragments():
    assert "cls-1" not in dd._clean_headline(".cls-1 { fill: #fff; } headline text")
    assert dd._clean_headline("<p>Real headline</p>") == "Real headline"
    assert dd._clean_headline(None) == ""


def test_promotional_headlines_are_vetoed():
    for h in [
        "Best iPhone Deals for 2026",
        "Amazon Great Indian Festival 2026: Best iPhone Deals",
        "10 movies that featured late actor Francis Duru",
        "Q3 2026 CIE Automotive India Ltd Earnings Call Transcript",
        "Ukraine war latest: analysis",
    ]:
        if "Ukraine war" in h:
            assert not dd.is_promotional(h), h
        else:
            assert dd.is_promotional(h), h


def test_real_news_is_not_vetoed():
    for h in [
        "Russia launched a massive missile strike on Kyiv",
        "Around 150,000 rally in Belgrade as Serbia heads to pivotal poll",
        "Magnitude 7 earthquake strikes Tibet",
    ]:
        assert not dd.is_promotional(h), h


# ── the world test ────────────────────────────────────────────────────────

def test_world_test_needs_corroboration():
    cand = _cand(outlets=2, countries=1)
    assert not dd.passes_world_test(cand)


def test_world_test_needs_reach():
    # 4 outlets but all in one country -> not a world story
    cand = _cand(outlets=4, countries=1)
    assert not dd.passes_world_test(cand)


def test_world_test_accepts_multi_country():
    cand = _cand(outlets=4, countries=2)
    assert dd.passes_world_test(cand)


def test_world_test_accepts_many_outlets_in_one_country():
    cand = _cand(outlets=8, countries=1)
    assert dd.passes_world_test(cand)


# ── scoring ───────────────────────────────────────────────────────────────

def test_score_is_bounded_and_signals_present():
    cands = [_cand(1), _cand(2, velocity_score=50.0)]
    stats = {**_stats(1, 8), **_stats(2, 5)}
    scored = dd.score_candidates(cands, stats, {}, NOW, set())
    assert len(scored) == 2
    for c in scored:
        assert 0 <= c["score"] <= 100
        assert set(c["signals"]) == set(dd.WEIGHTS)
        for v in c["signals"].values():
            assert 0.0 <= v <= 1.0


def test_weight_sum_is_one():
    assert abs(sum(dd.WEIGHTS.values()) - 1.0) < 1e-9


def test_repeat_story_is_penalised():
    cands = [_cand(1)]
    stats = _stats(1, 8)
    fresh = dd.score_candidates(cands, stats, {}, NOW, set())[0]["score"]
    again = dd.score_candidates(cands, stats, {}, NOW, {1})[0]["score"]
    assert again < fresh


def test_syndicated_copies_reduce_independence():
    cands = [_cand(1, syndicated_copies=18)]
    stats = _stats(1, 8, articles=20)
    scored = dd.score_candidates(cands, stats, {}, NOW, set())[0]
    assert scored["signals"]["independence"] < 0.2


def test_new_story_beats_an_old_one_on_novelty():
    cands = [
        _cand(1, first_article_at=NOW - timedelta(hours=80)),
        _cand(2, first_article_at=NOW - timedelta(hours=1)),
    ]
    stats = {**_stats(1, 8), **_stats(2, 8)}
    scored = dd.score_candidates(cands, stats, {}, NOW, set())
    fresh = [c for c in scored if c["id"] == 2][0]
    old = [c for c in scored if c["id"] == 1][0]
    assert fresh["signals"]["novelty"] > old["signals"]["novelty"]


# ── duplicates ────────────────────────────────────────────────────────────

def test_duplicate_detection_by_article_overlap():
    stats = {
        1: {"article_ids": {10, 11, 12, 13}},
        2: {"article_ids": {12, 13, 14}},
    }
    a = {"id": 1, "score": 90.0, "headline": "A", "category": "conflict"}
    b = {"id": 2, "score": 70.0, "headline": "B", "category": "conflict"}
    assert dd.is_duplicate(a, b, stats, set())


def test_unrelated_events_are_not_duplicates():
    stats = {
        1: {"article_ids": {10, 11}},
        2: {"article_ids": {90, 91}},
    }
    a = {"id": 1, "score": 90.0, "headline": "A", "category": "conflict"}
    b = {"id": 2, "score": 70.0, "headline": "B", "category": "conflict"}
    assert not dd.is_duplicate(a, b, stats, set())


def test_duplicate_detection_by_story_link():
    a = {"id": 1, "score": 90.0, "headline": "A", "category": "conflict"}
    b = {"id": 2, "score": 70.0, "headline": "B", "category": "conflict"}
    assert dd.is_duplicate(a, b, {}, {(1, 2)})


# ── the variety pass ──────────────────────────────────────────────────────

def test_diversify_caps_per_category_when_there_is_variety():
    # Two conflicts + two climates: the caps are satisfied by the first pass.
    scored = [
        {"id": 1, "score": 90, "headline": "a", "category": "conflict", "country": "UA"},
        {"id": 2, "score": 88, "headline": "b", "category": "conflict", "country": "IL"},
        {"id": 3, "score": 86, "headline": "c", "category": "climate", "country": "CN"},
        {"id": 4, "score": 84, "headline": "d", "category": "climate", "country": "IN"},
    ]
    chosen = dd.diversify(scored, 4)
    assert len(chosen) == 4
    assert sum(1 for c in chosen if c["category"] == "conflict") == 2


def test_diversify_tops_up_past_the_caps_when_there_is_nothing_else():
    # Six conflicts and nothing else: the caps would leave the digest short,
    # so the top-up fills it (the digest must not ship half-empty).
    scored = [
        {"id": i, "score": 100 - i, "headline": f"h{i}", "category": "conflict",
         "country": f"U{i}", "lat": 0, "lng": 0}
        for i in range(6)
    ]
    chosen = dd.diversify(scored, 6)
    assert len(chosen) == 6


def test_diversify_never_returns_a_duplicate():
    stats = {
        1: {"article_ids": {10, 11, 12}},
        2: {"article_ids": {11, 12, 13}},
        3: {"article_ids": {50, 51, 52}},
    }
    scored = [
        {"id": 1, "score": 90.0, "headline": "A", "category": "conflict", "country": "UA"},
        {"id": 2, "score": 80.0, "headline": "B", "category": "conflict", "country": "PL"},
        {"id": 3, "score": 70.0, "headline": "C", "category": "climate", "country": "CN"},
    ]
    chosen = dd.diversify(scored, 3, stats, set())
    ids = [c["id"] for c in chosen]
    assert len(ids) == len(set(ids))
    assert 1 in ids and 2 not in ids


def test_diversify_tops_up_when_caps_leave_it_short():
    scored = [
        {"id": i, "score": 100 - i, "headline": f"h{i}", "category": "conflict",
         "country": "UA"}
        for i in range(8)
    ]
    chosen = dd.diversify(scored, 4)
    assert len(chosen) == 4


# ── categories ────────────────────────────────────────────────────────────

def test_category_mapping():
    assert dd.category_of("war") == "conflict"
    assert dd.category_of("weather") == "climate"
    assert dd.category_of("soccer") == "culture"
    assert dd.category_of("electionz") == "other"
    assert dd.category_of(None) == "other"


def test_editorial_categories_exclude_culture_and_other():
    assert "culture" not in dd.EDITORIAL_CATEGORIES
    assert "society" not in dd.EDITORIAL_CATEGORIES
    assert "other" not in dd.EDITORIAL_CATEGORIES
    assert "other" not in dd.FILLER_CATEGORIES


# ── copy handling ─────────────────────────────────────────────────────────

def test_meta_language_is_stripped():
    assert dd._clean_copy("This news item is important for viewers.") == ""
    assert dd._clean_copy("...") == ""
    assert dd._clean_copy("A real sentence about the story.") != ""


def test_trim_sentence_ends_on_a_boundary():
    text = "First sentence here. Second sentence that runs on and on and should be cut off"
    trimmed = dd._trim_sentence(text, 40)
    assert trimmed.endswith(".")
    assert len(trimmed) <= 40


def test_parse_json_tolerates_fences_and_prose():
    assert dd._parse_json_reply('```json\n{"a": 1}\n```')["a"] == 1
    assert dd._parse_json_reply('Sure! {"a": 2} hope that helps')["a"] == 2
    assert dd._parse_json_reply("no json here") is None


def test_fallback_copy_never_leaves_a_hole():
    cand = {"headline": "Something happened", "outlets": 6, "countries": 3, "hours_old": 2}
    dd.fallback_copy(cand)
    assert cand["why"]
    assert cand["narration"] == "Something happened"

    cand2 = {"headline": "Other thing", "outlets": 0, "countries": 0, "hours_old": None}
    dd.fallback_copy(cand2)
    assert cand2["narration"] == "Other thing"
