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
        for f in FIELDS:
            sources = {f"jsonld_{f}": "x", f"ai_{f}": None, f"heur_{f}": None}
            merged = merge_event_fields(sources)
            assert merged[f] == "x"
