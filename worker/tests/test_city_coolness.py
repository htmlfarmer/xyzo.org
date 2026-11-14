"""
Tests for City Value Engine.

Run with:
    XYZO_DB_DSN="postgresql://xyzo_app@localhost/xyzo" \
    python3 -m pytest worker/tests/test_city_coolness.py -v
"""

import os
import pytest

os.environ.setdefault(
    "XYZO_DB_DSN",
    os.environ.get("XYZO_DB_DSN", "postgresql://xyzo_app@localhost/xyzo"),
)

from worker.db import connect


@pytest.fixture
def db():
    with connect() as conn:
        yield conn


class TestCityValueSchema:
    """City value tables exist and have correct structure."""

    def test_city_value_table_exists(self, db):
        with db.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) FROM city_value LIMIT 1
            """)
            result = cur.fetchone()
            assert result is not None

    def test_city_value_has_required_columns(self, db):
        with db.cursor() as cur:
            cur.execute("""
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'city_value'
            """)
            cols = {r["column_name"] for r in cur.fetchall()}

        required = {
            "city_id", "value_score", "value_rank", "tier",
            "articles_1d", "articles_7d", "articles_30d",
            "unique_sources", "freshness_score",
            "week_change_pct", "is_surging",
            "population", "is_capital", "region", "country_code",
        }
        assert required.issubset(cols), f"Missing: {required - cols}"

    def test_value_factor_config_exists(self, db):
        with db.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM value_factor_config")
            count = cur.fetchone()["count"]
            assert count >= 30, f"Expected 30+ factors, got {count}"

    def test_city_value_curated_table_exists(self, db):
        with db.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM city_value_curated LIMIT 1")
            result = cur.fetchone()
            assert result is not None

    def test_city_value_tag_table_exists(self, db):
        with db.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM city_value_tag LIMIT 1")
            result = cur.fetchone()
            assert result is not None


class TestCityValueData:
    """City value data is populated and makes sense."""

    def test_cities_have_value_scores(self, db):
        with db.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) FROM city_value
                WHERE value_score > 0
            """)
            count = cur.fetchone()["count"]
            assert count > 0, "No cities have value scores"

    def test_tiers_are_valid(self, db):
        with db.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT tier FROM city_value
            """)
            tiers = {r["tier"] for r in cur.fetchall()}

        valid_tiers = {"global", "regional", "local", "underground", "unknown"}
        assert tiers.issubset(valid_tiers), f"Invalid tiers: {tiers - valid_tiers}"

    def test_surging_cities_have_velocity(self, db):
        with db.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) FROM city_value
                WHERE is_surging = true
                  AND (week_change_pct <= 0 OR week_change_pct IS NULL)
            """)
            bad_count = cur.fetchone()["count"]

        assert bad_count == 0, (
            f"{bad_count} surging cities have non-positive week_change_pct"
        )

    def test_tier_assignment_makes_sense(self, db):
        with db.cursor() as cur:
            cur.execute("""
                SELECT tier,
                       AVG(value_score) AS avg_score,
                       AVG(unique_sources) AS avg_sources
                FROM city_value
                GROUP BY tier
            """)
            results = cur.fetchall()

        # Global should have higher scores than regional, etc.
        tier_order = {"global": 0, "regional": 1, "local": 2, "underground": 3, "unknown": 4}
        scores = [(r["tier"], r["avg_score"]) for r in results]
        scores.sort(key=lambda x: tier_order.get(x[0], 99))
        # Check that global avg > regional avg > local avg
        for i in range(len(scores) - 1):
            if scores[i][0] != "unknown" and scores[i+1][0] != "unknown":
                assert scores[i][1] >= scores[i+1][1], (
                    f"{scores[i][0]} ({scores[i][1]}) should have >= score "
                    f"than {scores[i+1][0]} ({scores[i+1][1]})"
                )

    def test_value_score_is_bounded(self, db):
        with db.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) FROM city_value
                WHERE value_score < 0 OR value_score > 150
            """)
            bad_count = cur.fetchone()["count"]

        assert bad_count == 0, f"{bad_count} cities have out-of-bounds value_score (>150)"

    def test_freshness_score_is_bounded(self, db):
        with db.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) FROM city_value
                WHERE freshness_score < 0 OR freshness_score > 100
            """)
            bad_count = cur.fetchone()["count"]

        assert bad_count == 0, f"{bad_count} cities have out-of-bounds freshness_score"

    def test_top_cities_have_valid_metadata(self, db):
        with db.cursor() as cur:
            cur.execute("""
                SELECT cc.city_id, cc.country_code, cc.value_score, cc.articles_7d, cc.tier
                FROM city_value cc
                WHERE cc.value_rank <= 10
            """)
            top = cur.fetchall()

        assert len(top) > 0, "No top cities found"
        for city in top:
            assert city["city_id"], f"City at rank has no city_id"
            assert city["articles_7d"] >= 0, f"City {city['city_id']} has negative articles_7d"

    def test_curated_cities_are_marked(self, db):
        # Find curated cities that DO have value scores
        with db.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) FROM city_value cc
                JOIN city_value_curated c ON c.city_id = cc.city_id
                WHERE cc.is_curated = true
            """)
            curated = cur.fetchone()["count"]

        # Find curated cities that have value scores (whether marked curated or not)
        with db.cursor() as cur:
            cur.execute("""
                SELECT COUNT(*) FROM city_value cc
                JOIN city_value_curated c ON c.city_id = cc.city_id
            """)
            total_with_scores = cur.fetchone()["count"]

        # If any curated cities have scores, they should be marked curated
        if total_with_scores > 0:
            assert curated > 0, f"{total_with_scores} curated cities have scores but {curated} are marked curated"


class TestValueFactors:
    """Factor configuration is correct."""

    def test_all_factor_configs_are_valid(self, db):
        with db.cursor() as cur:
            cur.execute("""
                SELECT factor_name, category, weight
                FROM value_factor_config
                WHERE enabled = true
            """)
            factors = cur.fetchall()

        valid_categories = {
            "volume", "event", "diversity", "freshness",
            "quality", "trend", "strategic", "editorial"
        }
        for f in factors:
            assert f["category"] in valid_categories, (
                f"Factor {f['factor_name']} has invalid category: {f['category']}"
            )
            assert f["weight"] >= 0, (
                f"Factor {f['factor_name']} has negative weight: {f['weight']}"
            )

    def test_volume_factors_have_high_weight(self, db):
        with db.cursor() as cur:
            cur.execute("""
                SELECT factor_name, weight
                FROM value_factor_config
                WHERE category = 'volume' AND enabled = true
            """)
            volume_factors = cur.fetchall()

        assert len(volume_factors) >= 3, "Should have at least 3 volume factors"
        for f in volume_factors:
            assert f["weight"] >= 0.5, f"Volume factor {f['factor_name']} has weight < 0.5: {f['weight']}"
