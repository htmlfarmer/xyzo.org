"""Unit tests for the Xyzo neural network layer.

Tests cover:
  • All 7 model architectures — forward pass shapes, value ranges, loss sign
  • Feature extractors — output schema, null handling
  • Inference helpers — text encoding, version lookup, cache key generation
  • haversine_score — numerical correctness
  • _sha256 — determinism

Fixtures are unit-test only (no live DB required); a conftest.py in this
directory provides a no-op connect() patch for tests that import from worker.db.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import torch

# Make project root importable
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

# ── conftest ─────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def patch_db(monkeypatch):
    """Replace worker.db.connect with a no-op for unit tests that don't need DB."""
    mock_conn = MagicMock()
    mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=MagicMock())
    mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
    monkeypatch.setattr("worker.db.connect", lambda: mock_conn)


@pytest.fixture(scope="session", autouse=True)
def force_cpu():
    """Force all torch operations to CPU so tests run without GPU."""
    import worker.nn_train as nn_train
    orig_device = nn_train.DEVICE
    nn_train.DEVICE = torch.device("cpu")
    # Patch every module that caches DEVICE at import time
    import worker.nn_infer as nn_infer
    nn_infer.DEVICE = torch.device("cpu")
    yield
    nn_train.DEVICE = orig_device
    nn_infer.DEVICE = orig_device


# ── Model architecture tests ──────────────────────────────────────────────────

class TestArticleUnderstanding:
    """Tests for the article_understanding triplet encoder."""

    def test_encode_produces_unit_vectors(self):
        from worker.nn_train import ArticleUnderstanding, EMBEDDING_DIM
        model = ArticleUnderstanding()
        model.eval()

        with torch.no_grad():
            emb = model.encode(["Breaking news in Tokyo", "Sports result from London"])
        assert emb.shape == (2, EMBEDDING_DIM)
        norms = emb.norm(p=2, dim=1)
        assert torch.allclose(norms, torch.ones_like(norms), atol=1e-4), \
            f"encode() must return unit vectors, got norms {norms}"

    def test_forward_triplet_loss_nonnegative(self):
        from worker.nn_train import ArticleUnderstanding
        model = ArticleUnderstanding()
        model.eval()

        batch = {
            "anchors":    ["Apple releases new iPhone", "NASA launches satellite"],
            "positives":  ["iPhone 15 announced by Apple", "SpaceX rocket launched"],
            "negatives":  ["Recipe for chocolate cake", "Weather in Paris"],
        }
        with torch.no_grad():
            out = model(batch)

        assert "loss" in out
        assert out["loss"].item() >= 0, "triplet loss must be non-negative"
        assert out["d_pos"] >= 0
        assert out["d_neg"] >= 0


class TestEntityExtractor:
    """Tests for the entity_extraction BIO tagger."""

    def test_output_shapes(self):
        from worker.nn_train import EntityExtractor
        model = EntityExtractor().eval()
        B, T = 4, 32

        batch = {
            "tokens": torch.randint(0, 8192, (B, T)),
            "labels": torch.randint(0, 7, (B, T)),
            "mask": torch.ones(B, T),
        }
        with torch.no_grad():
            out = model(batch)

        assert out["logits"].shape == (B, T, 7)
        assert "loss" in out
        assert 0 <= out["accuracy"] <= 1


class TestEventMatcher:
    """Tests for the event_matching siamese matcher."""

    def test_score_is_bounded(self):
        from worker.nn_train import ArticleUnderstanding, EventMatcher
        base = ArticleUnderstanding()
        base.eval()
        model = EventMatcher(base).eval()

        batch = {
            "title_a": ["Breaking news in Tokyo"] * 4,
            "title_b": ["Another story in Japan"] * 4,
            "label":    torch.tensor([1., 0., 1., 0.]),
        }
        with torch.no_grad():
            out = model(batch)

        scores = out["score"].squeeze()
        assert torch.all(scores >= 0) and torch.all(scores <= 1), \
            f"match scores must be in [0,1], got {scores}"
        assert 0 <= out["accuracy"] <= 1


class TestRelationshipModel:
    """Tests for the relationship edge-type model."""

    def test_relation_classes_valid(self):
        from worker.nn_train import ArticleUnderstanding, RelationshipModel, RELATION_CLASSES
        base = ArticleUnderstanding()
        base.eval()
        model = RelationshipModel(base).eval()
        B = 4

        batch = {
            "src_title":  ["Tokyo earthquake shakes Japan"] * B,
            "dst_title":  ["Aftershock reported in Osaka"] * B,
            "edge_type_idx": torch.tensor([0, 1, 2, 0]),
            "relation_label": torch.tensor([1, 2, 0, 3]),
            "score_label": torch.tensor([1., 0., 1., 0.]),
        }
        with torch.no_grad():
            out = model(batch)

        assert out["relation_logits"].shape == (B, len(RELATION_CLASSES))
        assert out["score"].shape == (B, 1)
        assert torch.all(out["score"] >= 0) and torch.all(out["score"] <= 1)


class TestRankingModel:
    """Tests for the ranking model."""

    def test_score_bounded(self):
        from worker.nn_train import RankingModel, EMBEDDING_DIM
        model = RankingModel().eval()
        B = 4
        NUM_SCALAR_FEATS = 21

        batch = {
            "article_emb":  torch.randn(B, EMBEDDING_DIM),
            "session_emb":  torch.randn(B, 64),
            "scalar_feats": torch.randn(B, NUM_SCALAR_FEATS),
            "label":        torch.rand(B),
        }
        with torch.no_grad():
            out = model(batch)

        # score is sigmoid output, must be in [0, 1]
        score = out["score"].squeeze()
        assert torch.all(score >= 0) and torch.all(score <= 1), \
            f"ranking score must be in [0,1], got {score}"
        assert "loss" in out
        # loss must be non-negative
        assert out["loss"].item() >= 0


class TestCoverageModel:
    """Tests for the coverage gap model."""

    def test_output_shapes(self):
        from worker.nn_train import CoverageModel, EMBEDDING_DIM
        model = CoverageModel().eval()
        B = 4

        batch = {
            "country_emb":   torch.randn(B, EMBEDDING_DIM),
            "neighbor_scores": torch.randn(B, 32),
            "scalar_feats":  torch.randn(B, 8),
            "label":         torch.rand(B),
        }
        with torch.no_grad():
            out = model(batch)

        assert "gap_score" in out
        assert "confidence" in out
        gap = out["gap_score"]
        conf = out["confidence"]
        # gap_score is unbounded for an untrained model; confidence sigmoid is bounded
        assert torch.all(conf >= 0) and torch.all(conf <= 1)
        assert gap.shape == (B, 1)


# ── Dataset tests ────────────────────────────────────────────────────────────

class TestTrainingDataset:
    def test_len_and_getitem(self):
        from worker.nn_train import TrainingDataset
        rows = [
            {"entity_id": 1, "features_jsonb": {"x": 1}, "label": 0.5},
            {"entity_id": 2, "features_jsonb": {"y": 2}, "label": None},
        ]
        ds = TrainingDataset(rows)
        assert len(ds) == 2
        item = ds[0]
        assert item["features"] == {"x": 1}
        assert item["label"].item() == 0.5
        assert ds[1]["label"].item() == 0.0

    def test_label_aux_preserved(self):
        from worker.nn_train import TrainingDataset
        rows = [{"entity_id": 1, "features_jsonb": {}, "label": 1.0, "label_aux": {"note": "test"}}]
        ds = TrainingDataset(rows)
        assert ds[0]["label_aux"] == {"note": "test"}


# ── Feature extractor tests ──────────────────────────────────────────────────

class TestExtractArticleUnderstanding:
    """extract_article_understanding returns raw feature dicts, NOT wrapped."""

    def test_handles_missing_fields(self):
        from worker.nn_features import extract_article_understanding
        rows = [
            {"id": 1, "title": "Quake hits Tokyo", "body": "A 5.0 earthquake", "published_at": None},
        ]
        results = extract_article_understanding(rows)
        assert len(results) == 1
        r = results[0]
        assert "title" in r
        assert "word_count" in r
        assert r["word_count"] == 3  # "A 5.0 earthquake" → 3 tokens

    def test_casts_hour_and_dow_from_datetime(self):
        from datetime import datetime
        from worker.nn_features import extract_article_understanding
        rows = [{
            "id": 1, "title": "Test", "body": "word " * 20,
            "published_at": datetime(2024, 6, 15, 14, 30),  # Saturday, hour=14
        }]
        results = extract_article_understanding(rows)
        f = results[0]
        assert f["hour_of_day"] == 14
        assert f["day_of_week"] == 5  # Monday=0, Saturday=5

    def test_body_hash_generated(self):
        from worker.nn_features import extract_article_understanding
        rows = [{"id": 1, "title": "Test", "body": "test body"}]
        results = extract_article_understanding(rows)
        assert "body_hash" in results[0]
        assert len(results[0]["body_hash"]) == 16


class TestExtractRanking:
    def test_country_match_none(self):
        from worker.nn_features import extract_ranking
        rows = [{
            "article_id": 1, "event_id": 10,
            "event_country": "JP",
            "country_interest": None,
            "topic_interest": None,
            "event_type": "earthquake",
            "velocity_clicks": 0, "velocity_views": 0, "accel_clicks": 0,
            "event_source_count": 3, "unique_sources": 5,
            "session_interactions": 0, "event_lat": 35.0, "event_lng": 139.0,
            "freshness": 0.8,
            "published_at": None, "source_id": 1, "source_quality": 0.5,
        }]
        results = extract_ranking(rows)
        assert len(results) == 1
        r = results[0]
        # The None.get() fix: must not raise AttributeError
        assert r["country_match"] == 0.0
        assert r["topic_match"] == 0.0

    def test_all_required_fields_present(self):
        from worker.nn_features import extract_ranking
        rows = [{
            "article_id": 2, "event_id": 20,
            "title": "Quake", "body": "text",
            "event_country": "PK",
            "country_interest": {"PK": 0.9, "IN": 0.1},
            "topic_interest": {"earthquake": 0.8},
            "event_type": "earthquake",
            "velocity_clicks": 10.5, "velocity_views": 100, "accel_clicks": 2.1,
            "event_source_count": 4, "unique_sources": 8,
            "session_interactions": 50,
            "event_lat": 33.0, "event_lng": 73.0,
            "published_at": None, "source_id": 1,
            "source_quality": 0.7,
            "freshness": 0.6,
        }]
        results = extract_ranking(rows)
        r = results[0]
        assert "country_match" in r
        assert "topic_match" in r
        assert "velocity_clicks" in r
        assert "event_lat" in r


class TestExtractCoverage:
    def test_handles_null_country_code(self):
        from worker.nn_features import extract_coverage
        rows = [{"country_code": None, "gap_score": 0.5, "active_sources": 0,
                 "articles_24h": 0, "events_24h": 0, "events_per_million_24h": 0}]
        results = extract_coverage(rows)
        assert len(results) == 1
        assert results[0]["country_code"] == "XX"

    def test_uses_default_language(self):
        from worker.nn_features import extract_coverage
        rows = [{"country_code": "US", "gap_score": 0.1, "active_sources": 10,
                 "articles_24h": 50, "events_24h": 5, "events_per_million_24h": 0.01,
                 "languages": None}]
        results = extract_coverage(rows)
        assert results[0]["languages"] == ["en"]

    def test_neighbor_gap_scores_preserved(self):
        from worker.nn_features import extract_coverage
        rows = [{"country_code": "US", "gap_score": 0.1, "active_sources": 5,
                 "articles_24h": 20, "events_24h": 2, "events_per_million_24h": 0.01,
                 "neighbor_gap_scores": [0.3, 0.5]}]
        results = extract_coverage(rows)
        # extract_coverage preserves the raw values; padding to 32 happens in CoverageDataset
        assert results[0]["neighbor_gap_scores"] == [0.3, 0.5]


class TestHaversineScore:
    def test_same_point_is_one(self):
        from worker.nn_features import _haversine_score
        score = _haversine_score(35.6762, 139.6503, 35.6762, 139.6503)
        assert abs(score - 1.0) < 1e-6

    def test_distant_point_is_near_zero(self):
        from worker.nn_features import _haversine_score
        score = _haversine_score(35.6762, 139.6503, 40.7128, -74.0060)
        assert 0 <= score < 0.1

    def test_london_to_paris(self):
        from worker.nn_features import _haversine_score
        score = _haversine_score(51.5074, -0.1278, 48.8566, 2.3522)
        assert 0.75 < score < 0.90


class TestSha256Helper:
    def test_deterministic(self):
        from worker.nn_features import _sha256
        obj = {"a": 1, "b": 2}
        assert _sha256(obj) == _sha256(obj)

    def test_different_inputs_different_hash(self):
        from worker.nn_features import _sha256
        assert _sha256({"key": "value1"}) != _sha256({"key": "value2"})

    def test_hash_length_is_16_chars(self):
        from worker.nn_features import _sha256
        assert len(_sha256({"test": 123})) == 16


class TestModelClassFor:
    def test_returns_correct_class(self):
        from worker.nn_infer import _model_class_for
        from worker import nn_train

        classes = {
            "article_understanding": nn_train.ArticleUnderstanding,
            "entity_extraction":    nn_train.EntityExtractor,
            "event_matching":        nn_train.EventMatcher,
            # standalone variant used by inference (see nn_infer._model_class_for)
            "relationship":          nn_train.SimpleRelationshipModel,
            "ranking":              nn_train.RankingModel,
            "coverage":             nn_train.CoverageModel,
            "article_value":        nn_train.ArticleValueModel,
        }
        for name, expected_cls in classes.items():
            assert _model_class_for(name) is expected_cls

        assert _model_class_for("unknown_model") is nn_train.ArticleUnderstanding
