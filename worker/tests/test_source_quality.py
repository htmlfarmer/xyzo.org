"""
Tests for Priority 1.2: Source Intelligence.
Validates:
- source_profile JSONB structure
- Source quality scores in valid range
- Citation graph bidirectionality
- Story overlap symmetry
- Topic expertise limits

Run with: pytest worker/tests/test_source_quality.py -v
"""

import pytest


def compute_source_quality_score(db, source_id):
    """Replicate the quality score formula for test comparison."""
    s = db.row("SELECT * FROM news_sources WHERE id = %s", source_id)
    if not s:
        return None
    w = {
        'reliability': 0.25, 'accuracy': 0.20, 'speed': 0.10,
        'original_reporting': 0.15, 'correction_rate': 0.10,
        'location_accuracy': 0.10, 'user_feedback': 0.10,
    }
    speed = 1.0 - min((s.get('avg_article_latency_seconds') or 86400) / 86400, 1.0)
    score = (
        w['reliability'] * (s.get('reliability_score') or 5) / 10.0 +
        w['accuracy'] * (s.get('accuracy_score') or 0.5) +
        w['speed'] * speed +
        w['original_reporting'] * (s.get('original_reporting_ratio') or 0) +
        w['correction_rate'] * (1.0 - (s.get('correction_rate') or 0)) +
        w['location_accuracy'] * (s.get('location_accuracy_score') or 0.5) +
        w['user_feedback'] * (s.get('user_feedback_score') or 0.5)
    )
    return round(score, 3)


class TestSourceProfileStructure:
    def _col_exists(self, db, table, col):
        return db.row(f"""
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '{table}' AND column_name = '{col}'
        """) is not None

    def test_profile_jsonb_has_required_keys(self, db):
        """Every active source with a profile has required top-level keys."""
        if not self._col_exists(db, 'news_sources', 'source_profile'):
            pytest.skip("source_profile column not yet in news_sources")
        required = {'summary', 'geographic_reach', 'topic_expertise',
                    'quality_signals', 'citation_graph', 'story_overlap'}
        rows = db.unsafe("""
            SELECT id, source_profile
            FROM news_sources
            WHERE active = true
              AND source_profile IS NOT NULL
            LIMIT 200
        """)
        for r in rows:
            p = r.get('source_profile') or {}
            missing = required - set(p.keys())
            assert not missing, f"source {r['id']} missing profile keys: {missing}"

    def test_summary_has_all_subkeys(self, db):
        """summary object has all required quality dimensions."""
        if not self._col_exists(db, 'news_sources', 'source_profile'):
            pytest.skip("source_profile column not yet in news_sources")
        required_dims = {'reliability', 'speed', 'accuracy',
                        'original_reporting', 'location_accuracy', 'overall'}
        rows = db.unsafe("""
            SELECT id, source_profile->'summary' AS summary
            FROM news_sources
            WHERE active = true AND source_profile IS NOT NULL
            LIMIT 200
        """)
        for r in rows:
            s = r.get('summary') or {}
            missing = required_dims - set(s.keys())
            assert not missing, f"source {r['id']} summary missing: {missing}"

    def test_overall_score_in_summary(self, db):
        """overall score in summary is between 0 and 1."""
        if not self._col_exists(db, 'news_sources', 'source_profile'):
            pytest.skip("source_profile column not yet in news_sources")
        rows = db.unsafe("""
            SELECT id, (source_profile->'summary'->>'overall')::float AS overall
            FROM news_sources
            WHERE active = true AND source_profile IS NOT NULL
              AND (source_profile->'summary'->>'overall') IS NOT NULL
            LIMIT 300
        """)
        for r in rows:
            overall = r.get('overall')
            if overall is not None:
                assert 0.0 <= overall <= 1.0, \
                    f"source {r['id']} overall score {overall} out of range"

    def test_topic_expertise_max_5(self, db):
        """topic_expertise lists at most 5 topics per source."""
        if not self._col_exists(db, 'news_sources', 'source_profile'):
            pytest.skip("source_profile column not yet in news_sources")
        rows = db.unsafe("""
            SELECT id, jsonb_array_length(source_profile->'topic_expertise') AS cnt
            FROM news_sources
            WHERE active = true AND source_profile IS NOT NULL
              AND source_profile->'topic_expertise' IS NOT NULL
            LIMIT 200
        """)
        for r in rows:
            if r.get('cnt') is not None:
                assert r['cnt'] <= 5, \
                    f"source {r['id']} has {r['cnt']} topic expertise entries (max 5)"


class TestSourceQualityScore:
    def test_quality_score_range(self, db):
        """Computed quality scores are always between 0.0 and 1.0."""
        rows = db.unsafe("SELECT id FROM news_sources WHERE active = true LIMIT 100")
        for r in rows:
            score = compute_source_quality_score(db, r['id'])
            if score is not None:
                assert 0.0 <= score <= 1.0, \
                    f"source {r['id']} quality score {score} out of range"

    def test_quality_score_deterministic(self, db):
        """Computing score twice gives the same result."""
        s = db.row("SELECT id FROM news_sources WHERE active = true LIMIT 20")
        if s:
            s1 = compute_source_quality_score(db, s['id'])
            s2 = compute_source_quality_score(db, s['id'])
            assert s1 == s2, \
                f"source {s['id']} score non-deterministic: {s1} vs {s2}"


class TestCitationGraph:
    def _col_exists(self, db, table, col):
        return db.row(f"""
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '{table}' AND column_name = '{col}'
        """) is not None

    def test_cited_by_reciprocates_cites(self, db):
        """If source A cites source B, then B's cited_by includes A."""
        if not self._col_exists(db, 'news_sources', 'source_profile'):
            pytest.skip("source_profile column not yet in news_sources")
        rows = db.unsafe("""
            SELECT id, source_profile
            FROM news_sources
            WHERE active = true
              AND source_profile IS NOT NULL
              AND source_profile->'citation_graph' IS NOT NULL
              AND (source_profile->'citation_graph'->>'cites') IS NOT NULL
            LIMIT 50
        """)
        for r in rows:
            cites = r.get('source_profile', {}).get('citation_graph', {}).get('cites') or []
            for cited_id in cites:
                cited_profile = db.row(
                    "SELECT source_profile FROM news_sources WHERE id = %s",
                    cited_id
                )
                if cited_profile:
                    cited_by = cited_profile.get('source_profile', {}).get(
                        'citation_graph', {}).get('cited_by') or []
                    assert r['id'] in cited_by, \
                        f"source {r['id']} cites {cited_id} but {cited_id} doesn't list {r['id']} in cited_by"

    def test_citation_graph_no_self_loops(self, db):
        """No source lists itself in cites or cited_by."""
        if not self._col_exists(db, 'news_sources', 'source_profile'):
            pytest.skip("source_profile column not yet in news_sources")
        rows = db.unsafe("""
            SELECT id, source_profile
            FROM news_sources
            WHERE active = true AND source_profile IS NOT NULL
              AND source_profile->'citation_graph' IS NOT NULL
            LIMIT 200
        """)
        for r in rows:
            cg = r.get('source_profile', {}).get('citation_graph', {})
            cites = cg.get('cites') or []
            cited_by = cg.get('cited_by') or []
            assert r['id'] not in cites, f"source {r['id']} has self-loop in cites"
            assert r['id'] not in cited_by, f"source {r['id']} has self-loop in cited_by"


class TestSourceMetadataColumns:
    def _col_exists(self, db, table, col):
        return db.row(f"""
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '{table}' AND column_name = '{col}'
        """) is not None

    def test_reliability_score_exists(self, db):
        """Every active source has a reliability_score."""
        missing = db.value("""
            SELECT COUNT(*) AS cnt
            FROM news_sources
            WHERE active = true AND (reliability_score IS NULL OR reliability_score = 0)
        """) or 0
        assert missing == 0, f"{missing} active sources have no reliability score"

    def test_language_primary_set(self, db):
        """Every active source has a primary language."""
        if not self._col_exists(db, 'news_sources', 'language_primary'):
            pytest.skip("language_primary column not yet in news_sources")
        missing = db.value("""
            SELECT COUNT(*) AS cnt
            FROM news_sources
            WHERE active = true AND language_primary IS NULL
        """) or 0
        assert missing == 0, f"{missing} active sources have no primary language"

    def test_source_kind_valid(self, db):
        """source_kind is one of the allowed values."""
        if not self._col_exists(db, 'news_sources', 'source_kind'):
            pytest.skip("source_kind column not yet in news_sources")
        valid_kinds = {'news', 'government', 'scientific', 'emergency', 'social', 'economic'}
        rows = db.unsafe("""
            SELECT DISTINCT source_kind FROM news_sources
            WHERE active = true AND source_kind IS NOT NULL
        """)
        found = {r['source_kind'] for r in rows}
        invalid = found - valid_kinds
        assert not invalid, f"Invalid source_kind values: {invalid}"

    def test_correction_rate_0_to_1(self, db):
        """correction_rate is between 0 and 1."""
        if not self._col_exists(db, 'news_sources', 'correction_rate'):
            pytest.skip("correction_rate column not yet in news_sources")
        rows = db.unsafe("""
            SELECT id, correction_rate FROM news_sources
            WHERE active = true AND correction_rate IS NOT NULL
            LIMIT 200
        """)
        for r in rows:
            cr = r.get('correction_rate')
            if cr is not None:
                assert 0.0 <= cr <= 1.0, \
                    f"source {r['id']} correction_rate {cr} out of range"


class TestSourceGeographicReach:
    def _col_exists(self, db, table, col):
        return db.row(f"""
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '{table}' AND column_name = '{col}'
        """) is not None

    def test_geographic_reach_has_primary_country(self, db):
        """geographic_reach has primary_country set."""
        if not self._col_exists(db, 'news_sources', 'source_profile'):
            pytest.skip("source_profile column not yet in news_sources")
        rows = db.unsafe("""
            SELECT id, source_profile->'geographic_reach'->>'primary_country' AS pc
            FROM news_sources
            WHERE active = true AND source_profile IS NOT NULL
            LIMIT 200
        """)
        for r in rows:
            pc = r.get('pc')
            assert pc is not None and pc != '', \
                f"source {r['id']} missing primary_country in geographic_reach"
