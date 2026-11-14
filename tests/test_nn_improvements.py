"""
Regression tests for XYZO NN improvements.

These tests validate that:
1. Event matching model is deployed and functional
3. User feedback loop ingests corrections
4. Ranking model produces valid scores
5. Coverage model produces valid scores

Run:
    export XYZO_DB_DSN="postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
    python -m pytest tests/test_nn_improvements.py -v
"""
import pytest
import os
import torch
from pathlib import Path

# Make project root importable
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Force CPU for all tests
os.environ["CUDA_VISIBLE_DEVICES"] = ""


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def db_dsn():
    dsn = os.environ.get("XYZO_DB_DSN")
    if not dsn:
        pytest.skip("XYZO_DB_DSN not set")
    return dsn


@pytest.fixture(scope="session")
def db_conn(db_dsn):
    from worker.db import connect
    with connect() as conn:
        yield conn


# ── Test 1: Geolocation Model ────────────────────────────────────────────────

class TestPlaceDisambiguation:
    """Validate the classical cross-country disambiguation is working.

    This is the rule-based disambiguator in worker/place_disambiguation.py —
    the code that actually places articles on the map. It is NOT the (now
    removed) neural geolocation model.
    """

    def test_place_disambiguation_function_works(self):
        """Place disambiguation should be callable."""
        from worker.place_disambiguation import disambiguate

        # Just check it runs without error
        # Returns (keep: bool, reason: str)
        keep, reason = disambiguate(
            location_text="Paris",
            context="Paris Hilton news",
            source_country="US",
        )
        # Result is a tuple of (bool, str)
        assert isinstance(keep, bool)
        assert isinstance(reason, str)


# ── Guard: the NN geolocation head must not come back ────────────────────────

class TestNoNeuralGeolocation:
    """The neural geolocation head was removed 2026-10-26.

    It never placed a single article: its predictions were written to
    nn_prediction_cache and read by nothing, its trainer explicitly used
    zero text embeddings ("using zero text embeddings for fast training"),
    so the text pathway never learned anything, and its "known bug
    validation" incremented its pass counter unconditionally — it reported
    20/20 for any model at all.

    The coordinates on the map come from the classical pipeline
    (auto_categorize → extract → geocode → place_disambiguation), which
    places 95%+ of articles.

    Do not reintroduce this without ALL THREE of:
      1. a real held-out evaluation with measured precision/recall,
      2. actual text embeddings in the training path, and
      3. a write-back path into news_articles.extracted_lat/lng.
    """

    def test_no_geolocation_model_registered(self, db_conn):
        """The geolocation model must not be in the model registry."""
        with db_conn.cursor() as cur:
            cur.execute("""
                SELECT model_name, version, is_active
                FROM nn_model_registry
                WHERE model_name = 'geolocation'
            """)
            rows = list(cur.fetchall())
        assert rows == [], (
            "A geolocation NN model is registered again: "
            f"{[(r['model_name'], r['version']) for r in rows]}. "
            "The NN geolocation head was removed 2026-10-26 — see "
            "TestNoNeuralGeolocation for what a reintroduction requires."
        )

    def test_no_infer_geolocation_function(self):
        """nn_infer must not carry a geolocation inference path."""
        from worker import nn_infer
        assert not hasattr(nn_infer, "infer_geolocation"), (
            "infer_geolocation is back in nn_infer — it writes predictions "
            "nobody reads and grows nn_prediction_cache by ~576k rows/day."
        )

    def test_no_geolocation_predictions_in_cache(self, db_conn):
        """nn_prediction_cache must not accumulate geolocation predictions."""
        with db_conn.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) AS n
                FROM nn_prediction_cache
                WHERE model_name = 'geolocation'
            """)
            row = cur.fetchone()
        assert row["n"] == 0, (
            f"{row['n']} geolocation rows in nn_prediction_cache — the "
            "geolocation inference path is running again."
        )


# ── Test 2: Event Matching Model ──────────────────────────────────────────────

class TestEventMatchingModel:
    """Validate event_matching model is deployed and functional."""

    def test_event_matching_model_in_registry(self, db_conn):
        """Event matching model should be in registry."""
        from worker.db import connect
        with connect() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT model_name, version, is_active
                FROM nn_model_registry
                WHERE model_name = 'event_matching'
            """)
            rows = list(cur.fetchall())
            # event_matching might not be trained yet - check baseline
            if len(rows) == 0:
                pytest.skip("event_matching model not yet trained (expected for Phase 2)")
            assert len(rows) > 0

    def test_event_matching_model_is_instantiable(self):
        """EventMatcher class should exist and be instantiable."""
        from worker import nn_train

        nn_train.DEVICE = torch.device("cpu")

        # ArticleUnderstanding base model
        base = nn_train.ArticleUnderstanding()
        base.eval()

        # EventMatcher on top
        model = nn_train.EventMatcher(base)
        model.eval()

        B = 4
        batch = {
            "title_a": ["Breaking news in Tokyo"] * B,
            "title_b": ["Another story in Japan"] * B,
            "label": torch.tensor([1., 0., 1., 0.]),
        }

        with torch.no_grad():
            out = model(batch)

        scores = out["score"].squeeze()
        assert 0 <= scores[0].item() <= 1, f"Score out of range: {scores[0].item()}"
        assert 0 <= out["accuracy"] <= 1

    def test_singleton_events_exist(self, db_conn):
        """There should be singleton events (baseline for Phase 2 improvement)."""
        from worker.db import connect
        with connect() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT COUNT(*) as singleton_events
                FROM news_events
                WHERE source_count = 1
            """)
            row = cur.fetchone()
            # Baseline: ~156k singletons
            assert row['singleton_events'] > 10000


# ── Test 3: User Feedback Loop ──────────────────────────────────────────────

class TestUserFeedbackLoop:
    """Validate user corrections are being ingested."""

    def test_user_corrections_table_exists(self, db_conn):
        """nn_user_corrections table should exist."""
        from worker.db import connect
        with connect() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT COUNT(*) as correction_count
                FROM nn_user_corrections
            """)
            row = cur.fetchone()
            assert row['correction_count'] >= 0

    def test_corrections_exist_but_unused(self, db_conn):
        """Verify that corrections exist but are marked as not used."""
        from worker.db import connect
        with connect() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT model_name, correction_type, COUNT(*) as cnt,
                       SUM(CASE WHEN used_in_training = TRUE THEN 1 ELSE 0 END) as used
                FROM nn_user_corrections
                GROUP BY model_name, correction_type
            """)
            rows = list(cur.fetchall())
            assert len(rows) > 0, "No corrections in nn_user_corrections"

            for row in rows:
                # We expect corrections to NOT be used yet (baseline)
                assert row['used'] == 0, \
                    f"Corrections already used! {row['model_name']}/{row['correction_type']} used={row['used']}"

    def test_feedback_ingestion_function_will_be_added(self):
        """Placeholder: After Phase 2, ingest function should exist."""
        # This test documents what SHOULD exist after Phase 2
        from worker import nn_train

        # After Phase 2, we should have ingest_corrections or similar
        # For now, just document that it doesn't exist
        has_function = (
            hasattr(nn_train, 'ingest_corrections') or
            hasattr(nn_train, 'ingest_event_corrections') or
            hasattr(nn_train, 'ingest_location_corrections')
        )

        # Skip if not yet implemented (will be fixed in Phase 2)
        if not has_function:
            pytest.skip("Correction ingestion not yet implemented (expected for Phase 2)")


# ── Test 4: Ranking Model ────────────────────────────────────────────────────

class TestRankingModel:
    """Validate ranking model produces valid scores."""

    def test_ranking_model_class_exists(self):
        """RankingModel class should exist."""
        from worker import nn_train
        assert hasattr(nn_train, 'RankingModel')

    def test_ranking_model_produces_valid_scores(self):
        """Ranking model should produce bounded scores."""
        from worker import nn_train

        nn_train.DEVICE = torch.device("cpu")

        model = nn_train.RankingModel()
        model.eval()

        B = 4
        NUM_SCALAR_FEATS = 21  # Must match model's expected input
        batch = {
            "article_emb": torch.randn(B, 16),
            "session_emb": torch.randn(B, 64),
            "scalar_feats": torch.randn(B, NUM_SCALAR_FEATS),
            "label": torch.rand(B),
        }

        with torch.no_grad():
            out = model(batch)

        score = out["score"].squeeze()
        assert 0 <= score[0].item() <= 1, f"Ranking score out of range: {score[0].item()}"
        assert out["loss"].item() >= 0

    def test_ranking_features_extractor_exists(self):
        """Should have extract_ranking function."""
        from worker import nn_features

        assert hasattr(nn_features, 'extract_ranking'), \
            "extract_ranking function not found in nn_features"


# ── Test 5: Coverage Model ───────────────────────────────────────────────────

class TestCoverageModel:
    """Validate coverage model produces valid gap scores."""

    def test_coverage_model_class_exists(self):
        """CoverageModel class should exist."""
        from worker import nn_train
        assert hasattr(nn_train, 'CoverageModel')

    def test_coverage_model_produces_valid_gap_scores(self):
        """Coverage model should produce gap scores with bounded confidence."""
        from worker import nn_train

        nn_train.DEVICE = torch.device("cpu")

        model = nn_train.CoverageModel()
        model.eval()

        B = 4
        batch = {
            "country_emb": torch.randn(B, 16),
            "neighbor_scores": torch.randn(B, 32),
            "scalar_feats": torch.randn(B, 8),
            "label": torch.rand(B),
        }

        with torch.no_grad():
            out = model(batch)

        gap = out["gap_score"]
        conf = out["confidence"]

        assert gap.shape == (B, 1)
        assert 0 <= conf[0].item() <= 1, f"Coverage confidence out of range: {conf[0].item()}"
        # Gap score can be any value (positive or negative)
        # But should be finite
        assert -100 < gap[0].item() < 100, f"Gap score unreasonable: {gap[0].item()}"


# ── Test 6: Inference Pipeline Integration ───────────────────────────────────

class TestInferencePipeline:
    """Validate inference pipeline runs end-to-end."""

    def test_nn_infer_module_loads(self):
        """nn_infer module should load without errors."""
        from worker import nn_infer
        assert hasattr(nn_infer, 'infer_article_embeddings')

    def test_model_class_for_returns_valid_classes(self):
        """_model_class_for should return correct class for each model."""
        from worker.nn_infer import _model_class_for
        from worker import nn_train

        expected = {
            "article_understanding": nn_train.ArticleUnderstanding,
            "entity_extraction": nn_train.EntityExtractor,
            "event_matching": nn_train.EventMatcher,
            # nn_infer maps 'relationship' to the standalone SimpleRelationshipModel
            # (RelationshipModel requires an article_model for encoding).
            "relationship": nn_train.SimpleRelationshipModel,
            "ranking": nn_train.RankingModel,
            "coverage": nn_train.CoverageModel,
            "article_value": nn_train.ArticleValueModel,
        }

        for name, cls in expected.items():
            result = _model_class_for(name)
            assert result is cls, f"_model_class_for('{name}') returned {result}, expected {cls}"

# ── Test 7: Model Training Loop ─────────────────────────────────────────────

class TestTrainingLoop:
    """Validate training loop is functional."""

    def test_nn_train_module_loads(self):
        """nn_train module should load without errors."""
        from worker import nn_train
        assert hasattr(nn_train, 'ArticleUnderstanding')

    def test_training_dataset_handles_null_labels(self):
        """TrainingDataset should handle null labels gracefully."""
        from worker.nn_train import TrainingDataset

        rows = [
            {"entity_id": 1, "features_jsonb": {"x": 1}, "label": None},
            {"entity_id": 2, "features_jsonb": {"y": 2}, "label": 0.5},
        ]
        ds = TrainingDataset(rows)

        # Null label should be treated as 0.0
        item = ds[0]
        assert item["label"].item() == 0.0

        # Valid label should be preserved
        item = ds[1]
        assert item["label"].item() == 0.5


# ── Test 8: End-to-End Sanity ────────────────────────────────────────────────

class TestEndToEnd:
    """End-to-end sanity checks."""

    def test_database_has_articles(self, db_conn):
        """Database should have articles."""
        from worker.db import connect
        with connect() as conn:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) as cnt FROM news_articles")
            row = cur.fetchone()
            assert row['cnt'] > 100000, f"Only {row['cnt']} articles in DB (expected >100k)"

    def test_database_has_events(self, db_conn):
        """Database should have events."""
        from worker.db import connect
        with connect() as conn:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) as cnt FROM news_events")
            row = cur.fetchone()
            assert row['cnt'] > 10000, f"Only {row['cnt']} events in DB (expected >10k)"

    def test_timers_are_running(self):
        """Critical systemd timers should be active."""
        import subprocess
        timers = [
            "xyzo-fast-fetcher.timer",
            "xyzo-nn-infer.timer",
        ]
        for timer in timers:
            result = subprocess.run(
                ["systemctl", "is-active", timer],
                capture_output=True, text=True
            )
            assert result.returncode == 0, f"Timer {timer} is not active"
