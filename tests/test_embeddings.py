"""Tests for embeddings module. Skipped when sentence-transformers
is not installed (model download is ~80MB)."""
import pytest
import os

# Skip the whole module if model isn't available
_sbert_available = False
try:
    import sentence_transformers  # noqa: F401
    _sbert_available = True
except ImportError:
    pass

pytestmark = pytest.mark.skipif(
    not _sbert_available,
    reason="sentence-transformers not installed"
)


class TestEventToText:
    def test_composes_minimal_event(self):
        from worker.embeddings import event_to_text
        text = event_to_text({"title": "Jazz Night"})
        assert "Jazz Night" in text

    def test_includes_venue_city_country(self):
        from worker.embeddings import event_to_text
        text = event_to_text({
            "title": "T", "venue_name": "V", "city": "C",
            "country_code": "US"
        })
        assert "V" in text and "C" in text and "US" in text

    def test_includes_first_sentence_of_description(self):
        from worker.embeddings import event_to_text
        text = event_to_text({
            "title": "T",
            "description": "First sentence here. Second sentence ignored."
        })
        assert "First sentence here" in text
        assert "Second sentence ignored" not in text

    def test_includes_categories(self):
        from worker.embeddings import event_to_text
        text = event_to_text({"title": "T", "categories": ["Music", "Free"]})
        assert "Music" in text
        assert "Free" in text

    def test_missing_fields_skipped(self):
        from worker.embeddings import event_to_text
        text = event_to_text({"title": "Only Title"})
        # No empty fields with empty pipes
        assert "  " not in text


class TestGetModel:
    def test_returns_model_instance(self):
        from worker.embeddings import get_model
        m = get_model()
        assert m is not None

    def test_cached_across_calls(self):
        from worker.embeddings import get_model
        m1 = get_model()
        m2 = get_model()
        assert m1 is m2


class TestEncodeEvent:
    def test_returns_384_dim_vector(self):
        from worker.embeddings import encode_event
        v = encode_event({"title": "Concert"})
        assert v is not None
        assert len(v) == 384

    def test_returns_none_when_disabled(self):
        from worker.embeddings import encode_event, set_available
        orig = os.environ.get("XYZO_DISABLE_EMBEDDINGS")
        try:
            set_available(False)
            v = encode_event({"title": "Concert"})
            assert v is None
        finally:
            set_available(_sbert_available)
            if orig is not None:
                os.environ["XYZO_DISABLE_EMBEDDINGS"] = orig

    def test_similar_events_have_high_similarity(self):
        import math
        from worker.embeddings import encode_event
        v1 = encode_event({"title": "Jazz Night at Blue Note",
                            "venue_name": "Blue Note", "city": "NYC"})
        v2 = encode_event({"title": "Blue Note Jazz Evening",
                            "venue_name": "Blue Note", "city": "NYC"})
        sim = _cosine_sim(v1, v2)
        assert sim > 0.7

    def test_unrelated_events_have_low_similarity(self):
        from worker.embeddings import encode_event
        v1 = encode_event({"title": "Jazz Night"})
        v2 = encode_event({"title": "Python Workshop"})
        sim = _cosine_sim(v1, v2)
        assert sim < 0.5


def _cosine_sim(a, b):
    """Quick cosine similarity for two equal-length lists."""
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)
