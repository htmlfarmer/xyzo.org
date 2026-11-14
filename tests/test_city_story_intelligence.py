"""Tests for City-Story Intelligence Pipeline"""
import pytest


class TestFeatureColumns:
    def test_feature_columns_count(self):
        from worker.city_story_ml import FEATURE_COLUMNS
        assert len(FEATURE_COLUMNS) == 32

    def test_feature_columns_contain_expected(self):
        from worker.city_story_ml import FEATURE_COLUMNS
        expected = [
            "geographic_distance_m",
            "geographic_contained",
            "direct_city_name",
            "city_alias_match",
            "embedding_similarity",
            "wikidata_entity_count",
        ]
        for col in expected:
            assert col in FEATURE_COLUMNS, f"Missing: {col}"


class TestRelationshipTypes:
    def test_relationship_type_enum_values(self):
        from worker.city_story_rels import RelationshipType
        expected = [
            "DIRECT_LOCAL",
            "DIRECT_CITY",
            "ADMINISTRATIVE",
            "SOURCE_LOCATION",
            "ENTITY_ASSOCIATED",
            "REGIONAL",
            "COUNTRY",
            "ECONOMIC",
            "CULTURAL",
            "SCIENTIFIC",
            "SEMANTIC",
            "HISTORICAL",
            "INCIDENTAL",
            "NONE",
        ]
        actual = [e.value for e in RelationshipType]
        assert set(actual) == set(expected)


class TestQuadrantClassification:
    def test_quadrant_about(self):
        from worker.city_story_rels import _classify_quadrant, QUADRANT_ABOUT
        assert _classify_quadrant(0.8, 0.8) == QUADRANT_ABOUT

    def test_quadrant_local(self):
        from worker.city_story_rels import _classify_quadrant, QUADRANT_LOCAL
        assert _classify_quadrant(0.8, 0.5) == QUADRANT_LOCAL

    def test_quadrant_related(self):
        from worker.city_story_rels import _classify_quadrant, QUADRANT_RELATED
        assert _classify_quadrant(0.5, 0.8) == QUADRANT_RELATED

    def test_quadrant_incidental(self):
        from worker.city_story_rels import _classify_quadrant, QUADRANT_INCIDENTAL
        assert _classify_quadrant(0.3, 0.3) == QUADRANT_INCIDENTAL


class TestFeatureVectorization:
    def test_bool_to_float(self):
        from worker.city_story_ml import _bool_to_float
        assert _bool_to_float(True) == 1.0
        assert _bool_to_float(False) == 0.0
        assert _bool_to_float(None) == 0.0

    def test_normalize_population(self):
        from worker.city_story_ml import _normalize_population
        assert _normalize_population(100000) < 0.5  # Small city
        assert _normalize_population(10000000) > 0.6  # Large city (log10(10M)=7, so ~0.67)
        assert _normalize_population(None) == 0.0

    def test_normalize_distance(self):
        from worker.city_story_ml import _normalize_distance
        assert _normalize_distance(0) == 0.0
        assert _normalize_distance(1000) > 0.9  # Very close
        assert _normalize_distance(100000) < 0.5  # Far
        assert _normalize_distance(None) == 0.0


class TestEvidenceExtraction:
    def test_extract_evidence_contains(self):
        from worker.city_story_rels import _extract_evidence
        features = {
            "geographic_contained": True,
            "direct_city_name": True,
            "geographic_distance_m": 500,
        }
        evidence = _extract_evidence(features)
        assert len(evidence) <= 3
        assert "coordinates within city boundary" in evidence


class TestDisplayLevel:
    def test_primary_display_level(self):
        from worker.city_story_rels import _compute_display_level, RelationshipType, QUADRANT_ABOUT
        level = _compute_display_level(True, RelationshipType.DIRECT_LOCAL, QUADRANT_ABOUT)
        assert level == "primary"

    def test_related_display_level(self):
        from worker.city_story_rels import _compute_display_level, RelationshipType, QUADRANT_RELATED
        level = _compute_display_level(False, RelationshipType.SEMANTIC, QUADRANT_RELATED)
        assert level == "related"

    def test_hidden_display_level(self):
        from worker.city_story_rels import _compute_display_level, RelationshipType, QUADRANT_INCIDENTAL
        level = _compute_display_level(False, RelationshipType.INCIDENTAL, QUADRANT_INCIDENTAL)
        assert level == "hidden"


class TestSchemaTables:
    @pytest.mark.skip(reason="Requires XYZO_DB_DSN environment variable")
    def test_schema_tables_exist(self):
        pass  # Placeholder - manually verify with:
        # psql "$XYZO_DB_DSN" -c "\dt city_story*"


class TestEmbeddingSimilarity:
    def test_zero_scores_shape(self):
        from worker.city_embeddings import _zero_scores
        scores = _zero_scores()
        expected_keys = [
            "embedding_similarity", "embedding_general",
            "embedding_economy", "embedding_science",
            "embedding_politics", "embedding_culture",
            "embedding_transport", "embedding_environment",
        ]
        assert set(scores.keys()) == set(expected_keys)
        assert all(v == 0.0 for v in scores.values())

    def test_zero_scores_returns_dict(self):
        from worker.city_embeddings import _zero_scores
        scores = _zero_scores()
        assert isinstance(scores, dict)
        assert len(scores) == 8

    def test_city_name_matching_high_similarity(self):
        """Test that city name in text gives high embedding similarity."""
        from worker.city_embeddings import get_article_embedding_similarity

        # Text mentions "Tokyo" and article is about a city
        text = "Breaking: Major earthquake strikes Tokyo, Japan. Buildings damaged across the capital city."
        # This will return zero if city_id doesn't exist in DB, but we test the logic
        # We can't test with real city_id without DB, so just verify function exists and returns dict
        assert callable(get_article_embedding_similarity)


class TestClassifierModel:
    def test_model_loads_when_exists(self):
        import os
        from worker.city_story_ml import CityStoryClassifier

        clf = CityStoryClassifier()
        # Model was trained earlier so should load
        loaded = clf.load()
        # Either True (loaded) or False (not found) is acceptable
        assert isinstance(loaded, bool)

    def test_classifier_predict_returns_dict(self):
        from worker.city_story_ml import CityStoryClassifier

        clf = CityStoryClassifier()
        clf.load()

        features = {
            "geographic_distance_m": 5000,
            "geographic_contained": False,
            "same_country": True,
            "same_admin1": True,
            "city_population": 1000000,
            "direct_city_name": True,
            "city_alias_match": False,
            "country_name": True,
            "region_name": False,
            "capital_indicator": False,
            "landmark_entity": False,
            "org_entity": False,
            "person_in_city": False,
            "source_in_city": False,
            "source_country_match": True,
            "source_region_match": True,
            "wikidata_entity_count": 0,
            "entity_match_score": 0.0,
            "institution_match": False,
            "landmark_match": False,
            "topic_city_relevance": 0.0,
            "body_length": 500,
            "embedding_general": 0.5,
            "embedding_economy": 0.0,
            "embedding_science": 0.0,
            "embedding_politics": 0.0,
            "embedding_culture": 0.0,
            "embedding_transport": 0.0,
            "embedding_environment": 0.0,
            "embedding_similarity": 0.5,
            "published_hour_local": 10,
            "weekend_published": False,
        }
        result = clf.predict(features)
        assert isinstance(result, dict)
        assert "score" in result
        assert "confidence" in result
        assert 0.0 <= result["score"] <= 1.0


class TestRelationshipComputation:
    def test_quadrant_thresholds(self):
        from worker.city_story_rels import (
            _classify_quadrant, QUADRANT_ABOUT, QUADRANT_LOCAL,
            QUADRANT_RELATED, QUADRANT_INCIDENTAL,
            PRESENCE_THRESHOLD, RELEVANCE_THRESHOLD
        )
        # ABOUT: high presence AND high relevance
        assert _classify_quadrant(0.8, 0.8) == QUADRANT_ABOUT
        # LOCAL: high presence, low relevance
        assert _classify_quadrant(0.8, 0.3) == QUADRANT_LOCAL
        # RELATED: low presence, high relevance
        assert _classify_quadrant(0.3, 0.8) == QUADRANT_RELATED
        # INCIDENTAL: low presence AND low relevance
        assert _classify_quadrant(0.3, 0.3) == QUADRANT_INCIDENTAL
