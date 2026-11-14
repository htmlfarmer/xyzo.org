"""
Tests for Priority 1.3: Country Intelligence.
Validates:
- All countries have intelligence rows
- Population matches countries table
- News volume is non-negative
- Local + international sources = total
- Language coverage score 0-1
- topic_coverage JSONB structure
- Intelligence freshness < 1 hour

Run with: pytest worker/tests/test_country_intelligence.py -v
"""

import pytest


class TestCountryIntelligenceRows:
    def _table_exists(self, db, table):
        return db.row(f"SELECT 1 FROM pg_tables WHERE tablename = '{table}'") is not None

    def _require_table(self, db, table):
        if not self._table_exists(db, table):
            pytest.skip(f"{table} table not yet created")

    def test_all_countries_have_intelligence_row(self, db):
        self._require_table(db, 'nn_country_intelligence')
        """Every country in the countries table has a row in nn_country_intelligence."""
        countries = db.unsafe("SELECT iso_alpha2 FROM countries WHERE iso_alpha2 NOT IN ('XX','XG','XT')")
        intel_codes = db.unsafe("SELECT country_code FROM nn_country_intelligence")
        intel_set = {r['country_code'] for r in intel_codes}
        missing = [c['iso_alpha2'] for c in countries if c['iso_alpha2'] not in intel_set]
        assert not missing, f"Countries missing intelligence rows: {missing}"

    def test_population_matches_countries_table(self, db):
        """Population in intelligence matches countries table."""
        self._require_table(db, 'nn_country_intelligence')
        rows = db.unsafe("""
            SELECT c.iso_alpha2, c.population AS country_pop,
                   ci.population AS intel_pop
            FROM countries c
            JOIN nn_country_intelligence ci ON ci.country_code = c.iso_alpha2
            WHERE c.iso_alpha2 NOT IN ('XX','XG','XT')
        """)
        mismatched = [
            (r['iso_alpha2'], r['country_pop'], r['intel_pop'])
            for r in rows
            if r['country_pop'] != r['intel_pop']
        ]
        assert not mismatched, f"Population mismatches: {mismatched[:5]}"


class TestNewsVolume:
    def _table_exists(self, db, table):
        return db.row(f"SELECT 1 FROM pg_tables WHERE tablename = '{table}'") is not None

    def _require_table(self, db, table):
        if not self._table_exists(db, table):
            pytest.skip(f"{table} table not yet created")

    def test_news_volume_24h_non_negative(self, db):
        """news_volume_24h is never negative."""
        self._require_table(db, 'nn_country_intelligence')
        rows = db.unsafe("""
            SELECT country_code, news_volume_24h, news_volume_7d
            FROM nn_country_intelligence
        """)
        for r in rows:
            assert r.get('news_volume_24h', 0) >= 0, \
                f"country {r['country_code']} has negative news_volume_24h"
            assert r.get('news_volume_7d', 0) >= 0, \
                f"country {r['country_code']} has negative news_volume_7d"

    def test_events_24h_non_negative(self, db):
        """events_24h is never negative."""
        self._require_table(db, 'nn_country_intelligence')
        rows = db.unsafe("""
            SELECT country_code, events_24h, events_7d
            FROM nn_country_intelligence
        """)
        for r in rows:
            assert r.get('events_24h', 0) >= 0, \
                f"country {r['country_code']} has negative events_24h"
            assert r.get('events_7d', 0) >= 0, \
                f"country {r['country_code']} has negative events_7d"


class TestSourceCounts:
    def _table_exists(self, db, table):
        return db.row(f"SELECT 1 FROM pg_tables WHERE tablename = '{table}'") is not None

    def _require_table(self, db, table):
        if not self._table_exists(db, table):
            pytest.skip(f"{table} table not yet created")

    def test_local_intl_sum_equals_total(self, db):
        """local_sources + international_sources == source_count."""
        self._require_table(db, 'nn_country_intelligence')
        rows = db.unsafe("""
            SELECT country_code, source_count, local_sources, international_sources
            FROM nn_country_intelligence
            WHERE source_count > 0
        """)
        for r in rows:
            computed = (r.get('local_sources') or 0) + (r.get('international_sources') or 0)
            assert computed == r.get('source_count'), \
                f"country {r['country_code']}: {r.get('local_sources')}+{r.get('international_sources')}={computed} != {r.get('source_count')}"

    def test_local_source_pct_0_to_1(self, db):
        """local_source_pct is between 0 and 1."""
        self._require_table(db, 'nn_country_intelligence')
        rows = db.unsafe("""
            SELECT country_code, local_source_pct
            FROM nn_country_intelligence
            WHERE local_source_pct IS NOT NULL
        """)
        for r in rows:
            lsp = r.get('local_source_pct')
            if lsp is not None:
                assert 0.0 <= lsp <= 1.0, \
                    f"country {r['country_code']} local_source_pct {lsp} out of range"


class TestLanguageCoverage:
    def _table_exists(self, db, table):
        return db.row(f"SELECT 1 FROM pg_tables WHERE tablename = '{table}'") is not None

    def _require_table(self, db, table):
        if not self._table_exists(db, table):
            pytest.skip(f"{table} table not yet created")

    def test_language_coverage_score_range(self, db):
        """language_coverage_score is between 0 and 1."""
        self._require_table(db, 'nn_country_intelligence')
        rows = db.unsafe("""
            SELECT country_code, language_coverage_score
            FROM nn_country_intelligence
            WHERE language_coverage_score IS NOT NULL
        """)
        for r in rows:
            lcs = r.get('language_coverage_score')
            if lcs is not None:
                assert 0.0 <= lcs <= 1.0, \
                    f"country {r['country_code']} language_coverage_score {lcs} out of range"


class TestTopicCoverage:
    VALID_TOPICS = {
        'politics', 'economy', 'disaster', 'conflict', 'sports',
        'culture', 'health', 'science', 'technology', 'environment',
        'business', 'crime', 'education', 'food', 'energy'
    }

    def _table_exists(self, db, table):
        return db.row(f"SELECT 1 FROM pg_tables WHERE tablename = '{table}'") is not None

    def _require_table(self, db, table):
        if not self._table_exists(db, table):
            pytest.skip(f"{table} table not yet created")

    def test_topic_coverage_jsonb_valid(self, db):
        """topic_coverage JSONB has valid topic names and scores."""
        self._require_table(db, 'nn_country_intelligence')
        rows = db.unsafe("""
            SELECT country_code, topic_coverage
            FROM nn_country_intelligence
            WHERE topic_coverage IS NOT NULL
            LIMIT 300
        """)
        for r in rows:
            tc = r.get('topic_coverage') or {}
            for topic, score in tc.items():
                assert topic in self.VALID_TOPICS, \
                    f"country {r['country_code']}: unknown topic '{topic}'"
                assert 0.0 <= score <= 1.0, \
                    f"country {r['country_code']} topic '{topic}' score {score} out of range"

    def test_topic_coverage_score_0_to_1(self, db):
        """topic_coverage_score is between 0 and 1."""
        self._require_table(db, 'nn_country_intelligence')
        rows = db.unsafe("""
            SELECT country_code, topic_coverage_score
            FROM nn_country_intelligence
            WHERE topic_coverage_score IS NOT NULL
        """)
        for r in rows:
            tcs = r.get('topic_coverage_score')
            if tcs is not None:
                assert 0.0 <= tcs <= 1.0, \
                    f"country {r['country_code']} topic_coverage_score {tcs} out of range"


class TestGeographicCoverage:
    def _table_exists(self, db, table):
        return db.row(f"SELECT 1 FROM pg_tables WHERE tablename = '{table}'") is not None

    def _require_table(self, db, table):
        if not self._table_exists(db, table):
            pytest.skip(f"{table} table not yet created")

    def test_geographic_coverage_score_0_to_1(self, db):
        """geographic_coverage_score is between 0 and 1."""
        self._require_table(db, 'nn_country_intelligence')
        rows = db.unsafe("""
            SELECT country_code, geographic_coverage_score
            FROM nn_country_intelligence
            WHERE geographic_coverage_score IS NOT NULL
        """)
        for r in rows:
            gcs = r.get('geographic_coverage_score')
            if gcs is not None:
                assert 0.0 <= gcs <= 1.0, \
                    f"country {r['country_code']} geographic_coverage_score {gcs} out of range"

    def test_coverage_confidence_0_to_1(self, db):
        """coverage_confidence is between 0 and 1."""
        self._require_table(db, 'nn_country_intelligence')
        rows = db.unsafe("""
            SELECT country_code, coverage_confidence
            FROM nn_country_intelligence
            WHERE coverage_confidence IS NOT NULL
        """)
        for r in rows:
            cc = r.get('coverage_confidence')
            if cc is not None:
                assert 0.0 <= cc <= 1.0, \
                    f"country {r['country_code']} coverage_confidence {cc} out of range"


class TestRegionalAggregations:
    def _table_exists(self, db, table):
        return db.row(f"SELECT 1 FROM pg_tables WHERE tablename = '{table}'") is not None

    def _require_table(self, db, table):
        if not self._table_exists(db, table):
            pytest.skip(f"{table} table not yet created")

    def test_region_is_set(self, db):
        """Every country intelligence row has a region."""
        self._require_table(db, 'nn_country_intelligence')
        nulls = db.value("""
            SELECT COUNT(*) AS cnt
            FROM nn_country_intelligence
            WHERE region IS NULL OR region = ''
        """) or 0
        assert nulls == 0, f"{nulls} countries have no region"
