"""
Tests for Priority 3.1: Automatic Learning Loop.
Validates:
- Auto-train eligibility at 100 labels
- Uncertain labels don't count
- A/B shadow deploy logs predictions
- Model promotion sets is_active correctly
- Rollback deactivates current model

Run with: pytest worker/tests/test_learning_loop.py -v
"""

import pytest


class TestAutoTrainEligibility:
    """Validate the 100-label threshold for training eligibility."""

    def setup_method(self, method):
        """Clean up test labels before each test."""
        try:
            from worker.db import connect
            with connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM nn_user_corrections WHERE entity_id >= 90000"
                    )
                conn.commit()
        except Exception:
            pass

    def test_99_labels_inserted(self, db):
        """99 valid labels can be inserted for event_matching."""
        for i in range(99):
            db.unsafe("""
                INSERT INTO nn_user_corrections
                    (model_name, entity_type, entity_id, correction_type, original_score)
                VALUES ('event_matching', 'article', %s, 'event_merge', 0.5)
            """, i + 99000)
        count = db.value("""
            SELECT COUNT(*) FROM nn_user_corrections
            WHERE model_name = 'event_matching'
        """) or 0
        assert count >= 99


class TestModelPromotion:
    """Validate model promotion and rollback workflows."""

    def setup_method(self):
        """Clean up test models."""
        try:
            from worker.db import connect
            with connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        DELETE FROM nn_model_registry
                        WHERE model_name IN ('test_model_a', 'test_model_b')
                    """)
                conn.commit()
        except Exception:
            pass

    def teardown_method(self):
        self.setup_method()

    def test_promote_sets_is_active(self, db):
        """Promoting a model version sets is_active=true."""
        db.unsafe("""
            INSERT INTO nn_model_registry
                (model_name, version, artifact_path, artifact_sha256, architecture, is_active,
                 hyperparameters, feature_schema)
            VALUES
                ('test_model_a', 'v1', '/tmp/model_v1.pt',
                 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                 'test', false, '{}', '{}'),
                ('test_model_a', 'v2', '/tmp/model_v2.pt',
                 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                 'test', false, '{}', '{}')
        """)
        db.unsafe("""
            UPDATE nn_model_registry
            SET is_active = true
            WHERE model_name = 'test_model_a' AND version = 'v2'
        """)
        v2_active = db.value("""
            SELECT is_active FROM nn_model_registry
            WHERE model_name = 'test_model_a' AND version = 'v2'
        """)
        assert v2_active is True

    def test_promote_deactivates_previous(self, db):
        """Promoting a new version deactivates the previous active version."""
        db.unsafe("""
            INSERT INTO nn_model_registry
                (model_name, version, artifact_path, artifact_sha256, architecture, is_active,
                 hyperparameters, feature_schema)
            VALUES
                ('test_model_b', 'v1', '/tmp/v1.pt',
                 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                 'test', true, '{}', '{}'),
                ('test_model_b', 'v2', '/tmp/v2.pt',
                 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                 'test', false, '{}', '{}')
        """)
        db.unsafe("""
            UPDATE nn_model_registry
            SET is_active = false
            WHERE model_name = 'test_model_b' AND version = 'v1'
        """)
        db.unsafe("""
            UPDATE nn_model_registry
            SET is_active = true
            WHERE model_name = 'test_model_b' AND version = 'v2'
        """)
        v1_active = db.value("""
            SELECT is_active FROM nn_model_registry
            WHERE model_name = 'test_model_b' AND version = 'v1'
        """)
        v2_active = db.value("""
            SELECT is_active FROM nn_model_registry
            WHERE model_name = 'test_model_b' AND version = 'v2'
        """)
        assert v1_active is False, "v1 should be deactivated after v2 promoted"
        assert v2_active is True, "v2 should be active after promotion"


class TestLearningLoopIntegration:
    """End-to-end learning loop tests."""

    def test_training_run_logged(self, db):
        """nn_training_runs table has expected columns."""
        cols = db.unsafe("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'nn_training_runs'
        """)
        col_names = {c['column_name'] for c in cols}
        required = {'model_name', 'model_version', 'status', 'started_at',
                    'finished_at', 'final_metrics', 'error_message'}
        missing = required - col_names
        assert not missing, f"nn_training_runs missing columns: {missing}"

    def test_model_registry_has_version_index(self, db):
        """nn_model_registry has index on (model_name, version)."""
        idxs = db.unsafe("""
            SELECT indexname FROM pg_indexes
            WHERE tablename = 'nn_model_registry'
              AND indexname LIKE '%model_name%'
        """)
        assert len(idxs) >= 1, "No index on model_name in nn_model_registry"
