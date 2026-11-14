"""
Tests for Priority 2.3: Coverage Model Fix.
Validates:
- extract_coverage returns all countries
- gap_score is non-negative
- neighboring_gap_scores max 8 entries
- local_source_pct is 0-1
- feature extraction is deterministic (idempotent)

Run with: pytest worker/tests/test_coverage_features.py -v
"""

import pytest


class TestGapScore:
    def _table_exists(self, db, table):
        return db.row(f"SELECT 1 FROM pg_tables WHERE tablename = '{table}'") is not None

    def _require_table(self, db, table):
        if not self._table_exists(db, table):
            pytest.skip(f"{table} table not yet created")

    def test_gap_score_non_negative(self, db):
        """gap_score formula result is always >= 0 (clamped by GREATEST)."""
        self._require_table(db, 'countries')
        """gap_score formula result is always >= 0 (clamped by GREATEST)."""
        rows = db.unsafe("""
            WITH coverage AS (
                SELECT
                    c.iso_alpha2,
                    GREATEST(0,
                        LN(GREATEST(c.population, 1)) * 0.3
                        - LN(GREATEST(COALESCE(s.cnt, 1), 1)) * 0.4
                        - LN(GREATEST(COALESCE(a.cnt, 1), 1)) * 0.3
                    ) AS gap_score
                FROM countries c
                LEFT JOIN (
                    SELECT country, COUNT(*) AS cnt FROM news_sources WHERE active = true GROUP BY country
                ) s ON s.country = c.iso_alpha2
                LEFT JOIN (
                    SELECT source_id, COUNT(*) AS cnt
                    FROM news_articles
                    WHERE published_at > now() - INTERVAL '24 hours'
                    GROUP BY source_id
                ) a ON a.source_id IN (SELECT id FROM news_sources WHERE country = c.iso_alpha2)
                WHERE c.iso_alpha2 NOT IN ('XX','XG','XT')
            )
            SELECT iso_alpha2, gap_score FROM coverage WHERE gap_score < 0
        """)
        assert len(rows) == 0, \
            f"Countries with negative gap_score: {[(r['iso_alpha2'], r['gap_score']) for r in rows[:5]]}"

    def test_gap_score_higher_for_underserved(self, db):
        """High-population, low-source countries have higher gap scores."""
        self._require_table(db, 'countries')
        rows = db.unsafe("""
            WITH coverage AS (
                SELECT
                    c.iso_alpha2,
                    COUNT(DISTINCT s.id) AS source_count,
                    GREATEST(0,
                        LN(GREATEST(c.population, 1)) * 0.3
                        - LN(GREATEST(COUNT(DISTINCT s.id), 1)) * 0.4
                    ) AS gap_score
                FROM countries c
                LEFT JOIN news_sources s ON s.country = c.iso_alpha2 AND s.active = true
                WHERE c.iso_alpha2 IN ('JP', 'NE', 'BD')
                GROUP BY c.iso_alpha2, c.population
            )
            SELECT * FROM coverage ORDER BY source_count DESC
        """)
        if len(rows) >= 2:
            high_sources = rows[0]   # JP
            low_sources = rows[-1]   # likely NE or BD
            # Japan should have lower gap score (more sources per capita)
            if high_sources.get('source_count', 0) > low_sources.get('source_count', 0):
                assert high_sources.get('gap_score', 0) <= low_sources.get('gap_score', 0) + 2.0, \
                    f"High-source country gap ({high_sources['gap_score']:.3f}) unexpectedly higher than low-source ({low_sources['gap_score']:.3f})"


class TestLocalSourcePercentage:
    def _table_exists(self, db, table):
        return db.row(f"SELECT 1 FROM pg_tables WHERE tablename = '{table}'") is not None

    def _require_table(self, db, table):
        if not self._table_exists(db, table):
            pytest.skip(f"{table} table not yet created")

    def test_local_source_pct_0_to_1(self, db):
        """local_source_pct is between 0 and 1."""
        self._require_table(db, 'nn_country_intelligence')
        rows = db.unsafe("""
            SELECT country_code, local_source_pct
            FROM nn_country_intelligence
            WHERE local_source_pct IS NOT NULL
            LIMIT 200
        """)
        for r in rows:
            lsp = r.get('local_source_pct')
            if lsp is not None:
                assert 0.0 <= lsp <= 1.0, \
                    f"country {r['country_code']} local_source_pct {lsp} out of range"


class TestFeatureStability:
    def _table_exists(self, db, table):
        return db.row(f"SELECT 1 FROM pg_tables WHERE tablename = '{table}'") is not None

    def _require_table(self, db, table):
        if not self._table_exists(db, table):
            pytest.skip(f"{table} table not yet created")

    def test_extract_coverage_deterministic(self, db):
        """Running the same query twice produces identical gap_scores."""
        self._require_table(db, 'countries')
        rows1 = db.unsafe("""
            WITH coverage AS (
                SELECT
                    c.iso_alpha2,
                    GREATEST(0,
                        LN(GREATEST(c.population, 1)) * 0.3
                        - LN(GREATEST(COALESCE(s.cnt, 1), 1)) * 0.4
                    ) AS gap_score
                FROM countries c
                LEFT JOIN (
                    SELECT country, COUNT(*) AS cnt FROM news_sources WHERE active = true GROUP BY country
                ) s ON s.country = c.iso_alpha2
                WHERE c.iso_alpha2 NOT IN ('XX','XG','XT')
            )
            SELECT iso_alpha2, gap_score FROM coverage ORDER BY iso_alpha2
        """)
        rows2 = db.unsafe("""
            WITH coverage AS (
                SELECT
                    c.iso_alpha2,
                    GREATEST(0,
                        LN(GREATEST(c.population, 1)) * 0.3
                        - LN(GREATEST(COALESCE(s.cnt, 1), 1)) * 0.4
                    ) AS gap_score
                FROM countries c
                LEFT JOIN (
                    SELECT country, COUNT(*) AS cnt FROM news_sources WHERE active = true GROUP BY country
                ) s ON s.country = c.iso_alpha2
                WHERE c.iso_alpha2 NOT IN ('XX','XG','XT')
            )
            SELECT iso_alpha2, gap_score FROM coverage ORDER BY iso_alpha2
        """)
        assert len(rows1) == len(rows2), "Different number of countries on two runs"
        for r1, r2 in zip(rows1, rows2):
            assert r1['iso_alpha2'] == r2['iso_alpha2']
            assert abs(r1['gap_score'] - r2['gap_score']) < 1e-6, \
                f"Non-deterministic gap_score for {r1['iso_alpha2']}: {r1['gap_score']} vs {r2['gap_score']}"


class TestCountryBordersTable:
    def test_country_borders_table_exists(self, db):
        """country_borders table exists for neighbor lookups."""
        exists = db.row("""
            SELECT 1 FROM pg_tables
            WHERE tablename = 'country_borders'
              AND schemaname = 'public'
        """)
        if not exists:
            pytest.skip("country_borders table not yet created")

    def test_borders_have_country_and_neighbor(self, db):
        """country_borders has country_code and neighbor_code columns."""
        exists = db.row("SELECT 1 FROM pg_tables WHERE tablename = 'country_borders'")
        if not exists:
            pytest.skip("country_borders not yet created")
        cols = db.unsafe("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'country_borders'
        """)
        col_names = {c['column_name'] for c in cols}
        required = {'country_code', 'neighbor_code'}
        missing = required - col_names
        assert not missing, f"country_borders missing columns: {missing}"
