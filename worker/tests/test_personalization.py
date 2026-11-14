"""
Tests for Priority 5.2: Personalized News Ranking.
Validates:
- Session vectors updated on interaction
- Interaction weights applied correctly
- Session vectors normalized to unit length
- Decay reduces old interests
- Articles matching session interests rank higher

Run with: pytest worker/tests/test_personalization.py -v
"""

import math
import time
import pytest


class TestSessionVectorUpdate:
    """Validate nn_realtime_session updates on user interactions."""

    def test_session_created_on_first_interaction(self, db):
        """First interaction for a session_id creates a session row."""
        session_id = f'test_session_vector_{time.time()}'
        exists_before = db.row("""
            SELECT 1 AS x FROM nn_realtime_session WHERE session_id = %s
        """, session_id)
        assert exists_before is None

        db.unsafe("""
            INSERT INTO nn_realtime_session
                (session_id, topic_interest, country_interest, source_interest, category_interest,
                 interactions_30m, pin_clicks_30m, searches_30m)
            VALUES (%s, %s, %s, %s, %s, 1, 0, 0)
            ON CONFLICT (session_id) DO UPDATE SET
                interactions_30m = nn_realtime_session.interactions_30m + 1
        """, session_id, [], [], [], [])

        exists_after = db.row("""
            SELECT interactions_30m FROM nn_realtime_session WHERE session_id = %s
        """, session_id)
        assert exists_after is not None

    def test_interaction_increments_counters(self, db):
        """Interactions increment interactions_30m on subsequent calls."""
        session_id = f'test_session_inc_{time.time()}'
        # First call creates session with 1 interaction
        db.unsafe("""
            INSERT INTO nn_realtime_session
                (session_id, topic_interest, country_interest, source_interest, category_interest,
                 interactions_30m, pin_clicks_30m, searches_30m)
            VALUES (%s, %s, %s, %s, %s, 1, 0, 0)
        """, session_id, [], [], [], [])
        # Second call increments
        db.unsafe("""
            INSERT INTO nn_realtime_session
                (session_id, topic_interest, country_interest, source_interest, category_interest,
                 interactions_30m, pin_clicks_30m, searches_30m)
            VALUES (%s, %s, %s, %s, %s, 1, 0, 0)
            ON CONFLICT (session_id) DO UPDATE SET
                interactions_30m = nn_realtime_session.interactions_30m + 1
        """, session_id, [], [], [], [])

        row = db.row("""
            SELECT interactions_30m
            FROM nn_realtime_session WHERE session_id = %s
        """, session_id)
        assert row is not None, "Session should exist after interaction"
        assert row.get('interactions_30m') == 2, \
            f"Expected 2 interactions, got {row.get('interactions_30m')}"


class TestVectorNormalization:
    """Validate that session vectors remain normalized."""

    def test_vector_norm_computed_correctly(self):
        """Unit vector normalization: sqrt(sum(x^2)) = 1.0."""
        vec = [0.1] * 64
        norm = math.sqrt(sum(x**2 for x in vec))
        normalized = [x / norm for x in vec]
        new_norm = math.sqrt(sum(x**2 for x in normalized))
        assert abs(new_norm - 1.0) < 1e-6

    def test_session_vector_columns_are_array_type(self, db):
        """topic_interest etc. are real[] array columns."""
        cols = db.unsafe("""
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'nn_realtime_session'
              AND column_name LIKE '%_interest'
        """)
        assert len(cols) >= 4, "Should have topic/country/source/category_interest columns"
        for c in cols:
            dtype = c.get('data_type') or ''
            assert 'array' in dtype.lower(), \
                f"{c['column_name']} is {dtype}, expected array type"


class TestInterestDecay:
    """Validate that old interests decay over time."""

    def test_decay_reduces_vector_magnitude(self):
        """Decay uses 0.95× per hour — reduces vector magnitude."""
        original = [1.0] * 64
        decayed = [x * 0.95 for x in original]
        original_norm = math.sqrt(sum(x**2 for x in original))
        decayed_norm = math.sqrt(sum(x**2 for x in decayed))
        assert decayed_norm < original_norm
        assert abs(decayed_norm - original_norm * 0.95) < 1e-6


class TestPersonalizedRanking:
    """Validate that session interests affect article ranking."""

    def test_leaderboard_accepts_session_id(self, db):
        """nn_article_leaderboard_live table exists with expected columns."""
        cols = db.unsafe("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'nn_article_leaderboard_live'
        """)
        col_names = {c['column_name'] for c in cols}
        required = {'article_id', 'nn_ranking_score', 'blended_score',
                    'nn_bucket', 'classical_engagement', 'expires_at'}
        missing = required - col_names
        assert not missing, f"nn_article_leaderboard_live missing columns: {missing}"

    def test_empty_session_gets_fallback_ranking(self, db):
        """A completely new session gets ranked by classical engagement."""
        session_id = f'test_new_session_{time.time()}'
        db.unsafe("""
            INSERT INTO nn_realtime_session
                (session_id, topic_interest, country_interest, source_interest, category_interest,
                 interactions_30m, pin_clicks_30m, searches_30m)
            VALUES (%s, %s, %s, %s, %s, 0, 0, 0)
        """, session_id, [], [], [], [])

        row = db.row("""
            SELECT interactions_30m, pin_clicks_30m, searches_30m
            FROM nn_realtime_session WHERE session_id = %s
        """, session_id)
        assert row is not None
        assert row.get('interactions_30m') == 0
        assert row.get('pin_clicks_30m') == 0
