"""
Tests for Priority 1.1: Location Confidence Engine.
Validates:
- Precision enum values are valid
- Confidence scores are 0-1
- Location candidates table is populated
- Precision is not 'unknown' for extracted articles
- Low confidence articles are flagged
- location_metadata JSONB structure
- Disputed cross-border candidates are flagged

These are integration tests — they require a live PostgreSQL database.
Run with: pytest worker/tests/test_location_quality.py -v
"""

import pytest


class TestPrecisionEnum:
    VALID_PRECISIONS = {
        'exact_building', 'street', 'neighborhood', 'city',
        'county', 'state', 'country', 'regional', 'unknown'
    }

    def _table_exists(self, db, table):
        return db.row(f"""
            SELECT 1 FROM pg_tables WHERE tablename = '{table}'
        """) is not None

    def test_precision_enum_values_from_schema(self, db):
        """Only valid precision values are stored in candidates table."""
        if not self._table_exists(db, 'news_article_locationCandidates'):
            pytest.skip("news_article_locationCandidates table not yet created")
        rows = db.unsafe("""
            SELECT DISTINCT precision
            FROM news_article_locationCandidates
            WHERE article_id IN (
                SELECT id FROM news_articles
                WHERE published_at > '2026-08-01'
                LIMIT 1000
            )
        """)
        found = {r['precision'] for r in rows}
        invalid = found - self.VALID_PRECISIONS
        assert not invalid, f"Invalid precision values found: {invalid}"

    def test_precision_column_has_check_constraint(self, db):
        """Precision column has a CHECK constraint enforcing valid values."""
        if not self._table_exists(db, 'news_article_locationCandidates'):
            pytest.skip("news_article_locationCandidates table not yet created")
        conrow = db.row("""
            SELECT conname, pg_get_constraintdef(oid) AS constraint_def
            FROM pg_constraint
            WHERE conrelid = 'news_article_locationCandidates'::regclass
              AND contype = 'c'
              AND conname LIKE '%precision%'
        """)
        assert conrow is not None, "No CHECK constraint on precision column"
        assert 'exact_building' in (conrow.get('constraint_def') or '')


class TestConfidenceRange:
    def _col_exists(self, db, table, col):
        return db.row(f"""
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '{table}' AND column_name = '{col}'
        """) is not None

    def test_confidence_range_0_to_1(self, db):
        """Every chosen location has confidence between 0.0 and 1.0."""
        if not self._col_exists(db, 'news_articles', 'location_metadata'):
            pytest.skip("location_metadata column not yet in news_articles")
        rows = db.unsafe("""
            SELECT (location_metadata->'chosen'->>'confidence')::float AS conf
            FROM news_articles
            WHERE location_metadata IS NOT NULL
              AND published_at > '2026-08-01'
              AND status IN ('extracted', 'located', 'clustered')
            LIMIT 500
        """)
        for r in rows:
            conf = r.get('conf')
            if conf is not None:
                assert 0.0 <= conf <= 1.0, f"Invalid confidence: {conf}"

    def test_confidence_null_rate_acceptable(self, db):
        """Most articles should have confidence scores (allow up to 10% null)."""
        if not self._col_exists(db, 'news_articles', 'location_metadata'):
            pytest.skip("location_metadata column not yet in news_articles")
        total = db.value(
            "SELECT COUNT(*) FROM news_articles WHERE published_at > '2026-08-01' AND status != 'pending'"
        ) or 0
        with_conf = db.value("""
            SELECT COUNT(*) FROM news_articles
            WHERE published_at > '2026-08-01'
              AND status != 'pending'
              AND location_metadata IS NOT NULL
              AND (location_metadata->'chosen'->>'confidence') IS NOT NULL
        """) or 0
        if total > 0:
            null_rate = 1 - (with_conf / total)
            assert null_rate < 0.10, f"Too many articles without confidence: {null_rate:.1%}"


class TestLocationCandidates:
    def _table_exists(self, db, table):
        return db.row(f"SELECT 1 FROM pg_tables WHERE tablename = '{table}'") is not None

    def _require_candidates_table(self, db):
        if not self._table_exists(db, 'news_article_locationCandidates'):
            pytest.skip("news_article_locationCandidates table not yet created")

    def test_candidates_table_populated(self, db):
        """Every non-pending article has at least one location candidate."""
        self._require_candidates_table(db)
        articles = db.unsafe("""
            SELECT id FROM news_articles
            WHERE status NOT IN ('pending', 'failed')
              AND published_at > '2026-08-01'
            LIMIT 200
        """)
        for a in articles:
            candidates = db.unsafe(
                "SELECT id FROM news_article_locationCandidates WHERE article_id = %s",
                a['id']
            )
            assert len(candidates) >= 1, \
                f"article {a['id']} has no location candidates"

    def test_candidates_have_all_required_fields(self, db):
        """Each candidate has lat, lng, precision, confidence, source, method."""
        self._require_candidates_table(db)
        row = db.row("""
            SELECT lat, lng, precision, confidence, source, method, reasons
            FROM news_article_locationCandidates
            LIMIT 1
        """)
        if row is None:
            pytest.skip("No candidates found in table")
        assert row.get('lat') is not None, "candidate lat is null"
        assert row.get('lng') is not None, "candidate lng is null"
        assert row.get('precision') is not None, "candidate precision is null"
        assert row.get('confidence') is not None, "candidate confidence is null"
        assert row.get('source') is not None, "candidate source is null"
        assert row.get('method') is not None, "candidate method is null"

    def test_candidates_unique_per_article_source_method(self, db):
        """No duplicate (article_id, location_text, source, method) tuples."""
        self._require_candidates_table(db)
        dupes = db.unsafe("""
            SELECT article_id, location_text, source, method, COUNT(*) AS cnt
            FROM news_article_locationCandidates
            WHERE article_id IN (
                SELECT id FROM news_articles WHERE published_at > '2026-08-01'
            )
            GROUP BY article_id, location_text, source, method
            HAVING COUNT(*) > 1
            LIMIT 10
        """)
        assert len(dupes) == 0, f"Duplicate candidates found: {dupes}"

    def test_candidates_index_exists(self, db):
        """Index on article_id exists for fast candidate lookup."""
        self._require_candidates_table(db)
        idxs = db.unsafe("""
            SELECT indexname FROM pg_indexes
            WHERE tablename = 'news_article_locationcandidates'
              AND indexname LIKE '%article%'
        """)
        assert len(idxs) >= 1, "No index on article_id"


class TestPrecisionDeterminable:
    def _col_exists(self, db, table, col):
        return db.row(f"""
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '{table}' AND column_name = '{col}'
        """) is not None

    def test_precision_not_unknown_for_extracted(self, db):
        """Articles that passed extraction should not have 'unknown' precision."""
        if not self._col_exists(db, 'news_articles', 'location_metadata'):
            pytest.skip("location_metadata column not yet in news_articles")
        unknown = db.unsafe("""
            SELECT id FROM news_articles
            WHERE status NOT IN ('pending', 'failed')
              AND published_at > '2026-08-01'
              AND location_metadata IS NOT NULL
              AND (location_metadata->'chosen'->>'precision') = 'unknown'
            LIMIT 10
        """)
        assert len(unknown) == 0, \
            f"Found {len(unknown)} articles with unknown precision"

    def test_extracted_articles_have_chosen_location(self, db):
        """Every extracted article has a 'chosen' entry in location_metadata."""
        if not self._col_exists(db, 'news_articles', 'location_metadata'):
            pytest.skip("location_metadata column not yet in news_articles")
        missing = db.unsafe("""
            SELECT id FROM news_articles
            WHERE status NOT IN ('pending', 'failed')
              AND published_at > '2026-08-01'
              AND (location_metadata IS NULL
                   OR location_metadata->'chosen' IS NULL)
            LIMIT 10
        """)
        assert len(missing) == 0, \
            f"Found {len(missing)} articles without chosen location"


class TestLowConfidenceFlag:
    def _col_exists(self, db, table, col):
        return db.row(f"""
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '{table}' AND column_name = '{col}'
        """) is not None

    def test_low_confidence_flag_set_below_05(self, db):
        """Articles with confidence < 0.5 have low_confidence_flag=true."""
        if not self._col_exists(db, 'news_articles', 'location_metadata'):
            pytest.skip("location_metadata column not yet in news_articles")
        misflagged = db.unsafe("""
            SELECT id, confidence, low_flag
            FROM (
                SELECT
                    a.id,
                    (a.location_metadata->'chosen'->>'confidence')::float AS confidence,
                    (a.location_metadata->>'low_confidence_flag')::bool AS low_flag
                FROM news_articles a
                WHERE a.status NOT IN ('pending', 'failed')
                  AND a.published_at > '2026-08-01'
                  AND a.location_metadata IS NOT NULL
                  AND (a.location_metadata->'chosen'->>'confidence') IS NOT NULL
            ) sub
            WHERE (confidence < 0.5 AND (low_flag = false OR low_flag IS NULL))
               OR (confidence >= 0.5 AND low_flag = true)
            LIMIT 10
        """)
        assert len(misflagged) == 0, \
            f"Low-confidence flag mis-set: {misflagged}"

    def test_high_confidence_articles_not_flagged(self, db):
        """Articles with confidence >= 0.8 should never be flagged low."""
        if not self._col_exists(db, 'news_articles', 'location_metadata'):
            pytest.skip("location_metadata column not yet in news_articles")
        high = db.value("""
            SELECT COUNT(*) AS cnt
            FROM news_articles
            WHERE published_at > '2026-08-01'
              AND status NOT IN ('pending', 'failed')
              AND location_metadata IS NOT NULL
              AND (location_metadata->'chosen'->>'confidence')::float >= 0.8
              AND (location_metadata->>'low_confidence_flag')::bool = true
        """) or 0
        assert high == 0, f"{high} high-confidence articles wrongly flagged"


class TestLocationMetadataStructure:
    def _col_exists(self, db, table, col):
        return db.row(f"""
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '{table}' AND column_name = '{col}'
        """) is not None

    def test_metadata_has_required_keys(self, db):
        """location_metadata has all required top-level keys."""
        if not self._col_exists(db, 'news_articles', 'location_metadata'):
            pytest.skip("location_metadata column not yet in news_articles")
        required = {'chosen', 'candidates', 'geocoder_used',
                    'total_candidates', 'low_confidence_flag', 'needs_review'}
        rows = db.unsafe("""
            SELECT id, location_metadata
            FROM news_articles
            WHERE location_metadata IS NOT NULL
              AND published_at > '2026-08-01'
            LIMIT 200
        """)
        for r in rows:
            meta = r.get('location_metadata') or {}
            missing = required - set(meta.keys())
            assert not missing, \
                f"article {r['id']} missing location_metadata keys: {missing}"

    def test_chosen_has_required_subkeys(self, db):
        """'chosen' object has all required subkeys."""
        if not self._col_exists(db, 'news_articles', 'location_metadata'):
            pytest.skip("location_metadata column not yet in news_articles")
        required = {'location_text', 'lat', 'lng', 'precision',
                    'confidence', 'source', 'method', 'disputed'}
        rows = db.unsafe("""
            SELECT id, location_metadata->'chosen' AS chosen
            FROM news_articles
            WHERE location_metadata IS NOT NULL
              AND location_metadata->'chosen' IS NOT NULL
              AND published_at > '2026-08-01'
            LIMIT 200
        """)
        for r in rows:
            chosen = r.get('chosen') or {}
            missing = required - set(chosen.keys())
            assert not missing, \
                f"article {r['id']} chosen location missing keys: {missing}"


class TestDisputedLocations:
    def _col_exists(self, db, table, col):
        return db.row(f"""
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '{table}' AND column_name = '{col}'
        """) is not None

    def test_disputed_articles_have_needs_review(self, db):
        """Disputed cross-border articles have needs_review=true."""
        if not self._col_exists(db, 'news_articles', 'location_metadata'):
            pytest.skip("location_metadata column not yet in news_articles")
        """Disputed articles should have needs_review=true."""
        disputed = db.unsafe("""
            SELECT id
            FROM news_articles
            WHERE published_at > '2026-08-01'
              AND location_metadata IS NOT NULL
              AND (location_metadata->'chosen'->>'disputed')::bool = true
            LIMIT 10
        """)
        for a in disputed:
            meta = db.row(
                "SELECT location_metadata FROM news_articles WHERE id = %s",
                a['id']
            )
            if meta:
                assert meta.get('location_metadata', {}).get('needs_review') is True, \
                    f"disputed article {a['id']} missing needs_review=true"


class TestLocationPrecisionDistribution:
    def _table_exists(self, db, table):
        return db.row(f"SELECT 1 FROM pg_tables WHERE tablename = '{table}'") is not None

    def _col_exists(self, db, table, col):
        return db.row(f"""
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '{table}' AND column_name = '{col}'
        """) is not None

    def test_precision_distribution_reasonable(self, db):
        """Most articles should be at 'city' or better precision."""
        if not self._table_exists(db, 'news_article_locationCandidates'):
            pytest.skip("news_article_locationCandidates table not yet created")
        if not self._col_exists(db, 'news_articles', 'location_metadata'):
            pytest.skip("location_metadata column not yet in news_articles")
        precision_counts = db.unsafe("""
            SELECT lc.precision, COUNT(*) AS cnt
            FROM news_article_locationCandidates lc
            JOIN news_articles a ON a.id = lc.article_id
            WHERE a.published_at > '2026-08-01'
              AND lc.article_id IN (
                  SELECT UNNEST(a.location_metadata->'candidates')::bigint
                  FROM news_articles a
                  WHERE a.location_metadata IS NOT NULL
                    AND a.published_at > '2026-08-01'
                  LIMIT 500
              )
            GROUP BY lc.precision
        """)
        if not precision_counts:
            pytest.skip("No candidate data available")
        prec_dict = {r['precision']: r['cnt'] for r in precision_counts}
        total = sum(prec_dict.values())
        good = sum(v for k, v in prec_dict.items()
                   if k in {'exact_building', 'street', 'neighborhood', 'city'})
        if total > 0:
            good_pct = good / total
            assert good_pct >= 0.50, \
                f"Only {good_pct:.1%} of candidates have city-or-better precision"

    def test_unknown_precision_rate_acceptable(self, db):
        """No more than 5% of articles should have 'unknown' precision."""
        if not self._col_exists(db, 'news_articles', 'location_metadata'):
            pytest.skip("location_metadata column not yet in news_articles")
        total = db.value(
            "SELECT COUNT(*) FROM news_articles WHERE published_at > '2026-08-01' AND status != 'pending'"
        ) or 0
        unknown = db.value("""
            SELECT COUNT(*)
            FROM news_articles
            WHERE published_at > '2026-08-01'
              AND status != 'pending'
              AND (location_metadata->'chosen'->>'precision') = 'unknown'
        """) or 0
        if total > 0:
            rate = unknown / total
            assert rate < 0.05, f"Unknown precision rate too high: {rate:.1%}"
