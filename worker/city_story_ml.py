"""City-Story Small ML Classifier

Train and predict city-story relationships using:
  - Logistic Regression (fast baseline)
  - LightGBM (better with heterogeneous features)

Feature vector (~30 features) from city_story_features table.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np

from .db import connect

log = logging.getLogger("xyzo.city_story_ml")

MODEL_BASE_DIR = Path(os.environ.get("XYZO_MODEL_DIR", "/var/www/vhosts/xyzo.org/data/nn_models")) / "city_story_classifier"
MODEL_BASE_DIR.mkdir(parents=True, exist_ok=True)

FEATURE_COLUMNS = [
    # Geographic (5)
    "geographic_distance_m",
    "geographic_contained",
    "same_country",
    "same_admin1",
    "city_population",
    # Textual (8)
    "direct_city_name",
    "city_alias_match",
    "country_name",
    "region_name",
    "capital_indicator",
    "landmark_entity",
    "org_entity",
    "person_in_city",
    # Source (3)
    "source_in_city",
    "source_country_match",
    "source_region_match",
    # Entity (4)
    "wikidata_entity_count",
    "entity_match_score",
    "institution_match",
    "landmark_match",
    # Topic (2)
    "topic_city_relevance",
    "body_length",
    # Embedding (8)
    "embedding_general",
    "embedding_economy",
    "embedding_science",
    "embedding_politics",
    "embedding_culture",
    "embedding_transport",
    "embedding_environment",
    "embedding_similarity",
    # Temporal (2)
    "published_hour_local",
    "weekend_published",
]


def _normalize_population(pop: int | None) -> float:
    """Normalize population to 0-1 scale using log."""
    if pop is None or pop <= 0:
        return 0.0
    return min(1.0, (np.log10(pop) - 5) / 3)  # 100k -> ~0, 10M -> ~1


def _normalize_distance(dist_m: float | None) -> float:
    """Normalize distance to 0-1 scale using exponential decay."""
    if dist_m is None or dist_m <= 0:
        return 0.0
    return np.exp(-dist_m / 100_000)  # 100km = 0.37, 10km = 0.90


def _bool_to_float(val: bool | None) -> float:
    """Convert boolean to 0/1 float."""
    return 1.0 if val else 0.0


def features_to_vector(features: dict[str, Any]) -> np.ndarray:
    """Convert feature dict to numpy array for ML."""
    vec = np.zeros(len(FEATURE_COLUMNS), dtype=np.float32)

    for i, col in enumerate(FEATURE_COLUMNS):
        val = features.get(col)

        # Handle specific normalizations
        if col == "city_population":
            vec[i] = _normalize_population(val)
        elif col == "geographic_distance_m":
            vec[i] = _normalize_distance(val)
        elif col in ("geographic_contained", "direct_city_name", "city_alias_match",
                     "country_name", "region_name", "capital_indicator",
                     "landmark_entity", "org_entity", "person_in_city",
                     "source_in_city", "source_country_match", "source_region_match",
                     "institution_match", "landmark_match", "weekend_published"):
            vec[i] = _bool_to_float(val)
        elif col in ("wikidata_entity_count", "body_length", "published_hour_local"):
            vec[i] = float(val) if val is not None else 0.0
        else:
            vec[i] = float(val) if val is not None else 0.0

    return vec


def load_training_data(min_samples: int = 1000, max_samples: int = 50000) -> tuple[np.ndarray, np.ndarray]:
    """Load labeled feature vectors from city_story_labels joined with features."""
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT
                csl.story_id,
                csl.city_id,
                csl.label,
                csf.geographic_distance_m,
                csf.geographic_contained,
                csf.same_country,
                csf.same_admin1,
                csf.city_population,
                csf.direct_city_name,
                csf.city_alias_match,
                csf.country_name,
                csf.region_name,
                csf.capital_indicator,
                csf.landmark_entity,
                csf.org_entity,
                csf.person_in_city,
                csf.source_in_city,
                csf.source_country_match,
                csf.source_region_match,
                csf.wikidata_entity_count,
                csf.entity_match_score,
                csf.institution_match,
                csf.landmark_match,
                csf.topic_city_relevance,
                csf.body_length,
                csf.embedding_general,
                csf.embedding_economy,
                csf.embedding_science,
                csf.embedding_politics,
                csf.embedding_culture,
                csf.embedding_transport,
                csf.embedding_environment,
                csf.embedding_similarity,
                csf.published_hour_local,
                csf.weekend_published
            FROM city_story_labels csl
            JOIN city_story_features csf ON csf.story_id = csl.story_id
                                         AND csf.city_id = csl.city_id
            WHERE csl.label_source = 'auto'
              AND csl.label_confidence >= 1.0
              AND csl.label IN (0, 1)
            ORDER BY csl.created_at DESC
            LIMIT %(max)s;
            """,
            {"max": max_samples},
        ).fetchall()

    if len(rows) < min_samples:
        raise RuntimeError(f"Only {len(rows)} training samples found, need {min_samples}")

    X = np.zeros((len(rows), len(FEATURE_COLUMNS)), dtype=np.float32)
    y = np.zeros(len(rows), dtype=np.int32)

    for i, row in enumerate(rows):
        feat_dict = {col: row[col] for col in FEATURE_COLUMNS}
        X[i] = features_to_vector(feat_dict)
        y[i] = row["label"]

    return X, y


class CityStoryClassifier:
    """Small ML classifier for city-story relationship prediction."""

    def __init__(self, version: str = "v1"):
        self.version = version
        self.model_type = "logistic_regression"  # or "lightgbm"
        self.model = None
        self.is_trained = False
        self.feature_importances_: np.ndarray | None = None

    def train(
        self,
        min_samples: int = 1000,
        max_samples: int = 50000,
        model_type: str = "logistic_regression",
    ) -> dict[str, Any]:
        """Train the classifier on labeled city-story pairs."""
        self.model_type = model_type
        t0 = time.time()

        try:
            X, y = load_training_data(min_samples, max_samples)
        except RuntimeError as e:
            log.error("Training failed: %s", e)
            return {"error": str(e)}

        log.info("Loaded %d training samples (positive=%d, negative=%d) in %.2fs",
                 len(y), y.sum(), len(y) - y.sum(), time.time() - t0)

        # Train/test split
        np.random.seed(42)
        indices = np.random.permutation(len(X))
        test_size = int(0.15 * len(X))
        test_idx = indices[:test_size]
        train_idx = indices[test_size:]

        X_train, X_test = X[train_idx], X[test_idx]
        y_train, y_test = y[train_idx], y[test_idx]

        metrics = {}

        if model_type == "logistic_regression":
            metrics = self._train_logistic(X_train, y_train, X_test, y_test)
        elif model_type == "lightgbm":
            metrics = self._train_lightgbm(X_train, y_train, X_test, y_test)
        else:
            raise ValueError(f"Unknown model_type: {model_type}")

        # Save model
        self._save_model(metrics, len(X_train), len(X_test))

        self.is_trained = True
        total_time = time.time() - t0

        return {
            "version": self.version,
            "model_type": self.model_type,
            "train_samples": len(X_train),
            "test_samples": len(X_test),
            "metrics": metrics,
            "training_time_s": total_time,
        }

    def _train_logistic(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_test: np.ndarray,
        y_test: np.ndarray,
    ) -> dict[str, Any]:
        """Train logistic regression using sklearn."""
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score

        self.model = LogisticRegression(
            C=1.0,
            class_weight="balanced",
            max_iter=1000,
            random_state=42,
        )
        self.model.fit(X_train, y_train)

        y_pred = self.model.predict(X_test)
        y_prob = self.model.predict_proba(X_test)[:, 1]

        metrics = {
            "accuracy": accuracy_score(y_test, y_pred),
            "precision": precision_score(y_test, y_pred, zero_division=0),
            "recall": recall_score(y_test, y_pred, zero_division=0),
            "f1": f1_score(y_test, y_pred, zero_division=0),
        }

        log.info("Logistic Regression - Accuracy: %.3f, F1: %.3f, Precision: %.3f, Recall: %.3f",
                 metrics["accuracy"], metrics["f1"], metrics["precision"], metrics["recall"])

        # Feature importances (coefficients)
        self.feature_importances_ = np.abs(self.model.coef_[0])
        self.feature_importances_ /= self.feature_importances_.sum()

        return metrics

    def _train_lightgbm(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_test: np.ndarray,
        y_test: np.ndarray,
    ) -> dict[str, Any]:
        """Train LightGBM classifier."""
        try:
            import lightgbm as lgb
        except ImportError:
            log.warning("LightGBM not available, falling back to logistic regression")
            return self._train_logistic(X_train, y_train, X_test, y_test)

        self.model = lgb.LGBMClassifier(
            n_estimators=100,
            max_depth=6,
            learning_rate=0.1,
            class_weight="balanced",
            random_state=42,
            verbose=-1,
        )
        self.model.fit(X_train, y_train)

        y_pred = self.model.predict(X_test)
        y_prob = self.model.predict_proba(X_test)[:, 1]

        from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score

        metrics = {
            "accuracy": accuracy_score(y_test, y_pred),
            "precision": precision_score(y_test, y_pred, zero_division=0),
            "recall": recall_score(y_test, y_pred, zero_division=0),
            "f1": f1_score(y_test, y_pred, zero_division=0),
        }

        log.info("LightGBM - Accuracy: %.3f, F1: %.3f, Precision: %.3f, Recall: %.3f",
                 metrics["accuracy"], metrics["f1"], metrics["precision"], metrics["recall"])

        self.feature_importances_ = self.model.feature_importances_
        self.feature_importances_ /= self.feature_importances_.sum()

        return metrics

    def _save_model(self, metrics: dict, train_samples: int, test_samples: int) -> None:
        """Save model to disk and register in database."""
        version_dir = MODEL_BASE_DIR / self.version
        version_dir.mkdir(parents=True, exist_ok=True)

        joblib.dump(self.model, version_dir / "model.joblib")

        meta = {
            "version": self.version,
            "model_type": self.model_type,
            "trained_at": datetime.now(timezone.utc).isoformat(),
            "train_samples": train_samples,
            "test_samples": test_samples,
            "metrics": metrics,
            "feature_columns": FEATURE_COLUMNS,
        }
        with open(version_dir / "meta.json", "w") as f:
            json.dump(meta, f, indent=2)

        # Register in database
        self._register_in_db(meta, version_dir)

    def _register_in_db(self, meta: dict, version_dir: Path) -> None:
        """Register model in city_story_models table."""
        try:
            with connect() as conn:
                # Deactivate previous versions
                conn.execute(
                    """
                    UPDATE city_story_models
                    SET is_active = FALSE
                    WHERE model_type = %(model_type)s
                    """,
                    {"model_type": self.model_type},
                )

                # Insert new model
                conn.execute(
                    """
                    INSERT INTO city_story_models (
                        model_type, model_version, feature_version,
                        training_samples, accuracy, precision, recall, f1_score,
                        model_path, is_active, trained_at
                    ) VALUES (
                        %(model_type)s, %(version)s, 'v1',
                        %(train_samples)s, %(accuracy)s, %(precision)s, %(recall)s, %(f1_score)s,
                        %(model_path)s, TRUE, %(trained_at)s
                    )
                    """,
                    {
                        "model_type": self.model_type,
                        "version": self.version,
                        "train_samples": meta["train_samples"],
                        "accuracy": meta["metrics"]["accuracy"],
                        "precision": meta["metrics"]["precision"],
                        "recall": meta["metrics"]["recall"],
                        "f1_score": meta["metrics"]["f1"],
                        "model_path": str(version_dir / "model.joblib"),
                        "trained_at": datetime.now(timezone.utc),
                    },
                )
            log.info("Registered %s %s in city_story_models", self.model_type, self.version)
        except Exception as e:
            log.warning("Could not register model in DB: %s", e)

    def load(self, version: str | None = None) -> bool:
        """Load trained model from disk."""
        target_version = version or self.version
        version_dir = MODEL_BASE_DIR / target_version

        if not (version_dir / "meta.json").exists():
            log.warning("No saved city-story model found at %s", version_dir)
            return False

        try:
            with open(version_dir / "meta.json") as f:
                meta = json.load(f)

            self.version = meta["version"]
            self.model_type = meta["model_type"]
            self.model = joblib.load(version_dir / "model.joblib")
            self.is_trained = True

            log.info("Loaded city-story classifier %s (accuracy=%.3f)",
                     self.version, meta["metrics"]["accuracy"])
            return True
        except Exception as e:
            log.error("Failed to load city-story classifier: %s", e)
            return False

    def predict(self, features: dict[str, Any]) -> dict[str, Any]:
        """Predict city-story relationship score for a single feature set."""
        if not self.is_trained:
            if not self.load():
                return {"score": 0.0, "confidence": 0.0}

        X = features_to_vector(features).reshape(1, -1)
        prob = float(self.model.predict_proba(X)[0, 1])
        pred = int(self.model.predict(X)[0])

        return {
            "score": prob,
            "prediction": pred,
            "confidence": prob if pred == 1 else (1 - prob),
        }

    def predict_batch(self, feature_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Batch prediction for multiple feature sets."""
        if not self.is_trained:
            if not self.load():
                return [{"score": 0.0, "confidence": 0.0} for _ in feature_list]

        if not feature_list:
            return []

        X = np.zeros((len(feature_list), len(FEATURE_COLUMNS)), dtype=np.float32)
        for i, feats in enumerate(feature_list):
            X[i] = features_to_vector(feats)

        probs = self.model.predict_proba(X)[:, 1]
        preds = self.model.predict(X)

        return [
            {
                "score": float(probs[i]),
                "prediction": int(preds[i]),
                "confidence": float(probs[i]) if preds[i] == 1 else (1 - probs[i]),
            }
            for i in range(len(feature_list))
        ]


# ─── Inference Pipeline ───────────────────────────────────────────────────────


def update_presence_scores(story_ids: list[int] | None = None) -> int:
    """Update presence_score for stories using the trained classifier.

    Args:
        story_ids: Specific stories to update, or None for all stories with features

    Returns:
        Number of scores updated
    """
    clf = CityStoryClassifier()
    if not clf.load():
        log.warning("No trained city-story classifier found, skipping presence score update")
        return 0

    if story_ids:
        where_clause = "csf.story_id = ANY(%(story_ids)s)"
        params = {"story_ids": story_ids}
    else:
        where_clause = "csf.presence_score = 0"
        params = {}

    with connect() as conn:
        rows = conn.execute(
            f"""
            SELECT
                csf.story_id,
                csf.city_id,
                csf.geographic_distance_m,
                csf.geographic_contained,
                csf.same_country,
                csf.same_admin1,
                csf.city_population,
                csf.direct_city_name,
                csf.city_alias_match,
                csf.country_name,
                csf.region_name,
                csf.capital_indicator,
                csf.landmark_entity,
                csf.org_entity,
                csf.person_in_city,
                csf.source_in_city,
                csf.source_country_match,
                csf.source_region_match,
                csf.wikidata_entity_count,
                csf.entity_match_score,
                csf.institution_match,
                csf.landmark_match,
                csf.topic_city_relevance,
                csf.body_length,
                csf.embedding_general,
                csf.embedding_economy,
                csf.embedding_science,
                csf.embedding_politics,
                csf.embedding_culture,
                csf.embedding_transport,
                csf.embedding_environment,
                csf.embedding_similarity,
                csf.published_hour_local,
                csf.weekend_published
            FROM city_story_features csf
            WHERE {where_clause}
            """,
            params,
        ).fetchall()

    if not rows:
        return 0

    # Build feature dicts
    features_by_pair = {}
    for row in rows:
        feat_dict = {col: row[col] for col in FEATURE_COLUMNS}
        features_by_pair[(row["story_id"], row["city_id"])] = feat_dict

    # Batch predict
    feature_list = list(features_by_pair.values())
    predictions = clf.predict_batch(feature_list)

    # Update database
    count = 0
    with connect() as upd_conn:
        for (story_id, city_id), pred in zip(features_by_pair.keys(), predictions):
            upd_conn.execute(
                """
                UPDATE city_story_features
                SET presence_score = %(score)s
                WHERE story_id = %(story_id)s
                  AND city_id = %(city_id)s
                """,
                {"story_id": story_id, "city_id": city_id, "score": pred["score"]},
            )
            count += 1

    return count


# ─── CLI ─────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="City-Story ML Classifier")
    parser.add_argument("--train", action="store_true", help="Train classifier")
    parser.add_argument("--model", default="logistic_regression",
                        choices=["logistic_regression", "lightgbm"],
                        help="Model type")
    parser.add_argument("--min-samples", type=int, default=1000)
    parser.add_argument("--max-samples", type=int, default=50000)
    parser.add_argument("--update-scores", action="store_true",
                        help="Update presence_score in database")
    args = parser.parse_args()

    if args.train:
        clf = CityStoryClassifier()
        result = clf.train(
            min_samples=args.min_samples,
            max_samples=args.max_samples,
            model_type=args.model,
        )
        print(json.dumps(result, indent=2))

    elif args.update_scores:
        count = update_presence_scores()
        print(f"Updated {count} presence scores")
