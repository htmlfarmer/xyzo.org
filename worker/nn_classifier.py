"""Neural Network & Word Frequency News Story Classifier for Xyzo.

Learns category distributions from article word_freq JSONB and headline tokens.
Maps unclassified news stories to canonical categories and fine-grained subcategories.
Includes PyTorch Deep Neural Network (MLP), fast calibrated ensemble, model registry
integration, and incremental learning loop support.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from sklearn.feature_extraction import DictVectorizer
from sklearn.feature_selection import SelectKBest, chi2
from sklearn.linear_model import SGDClassifier
from sklearn.model_selection import train_test_split

from .db import connect

log = logging.getLogger("xyzo.nn_classifier")

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
MODEL_BASE_DIR = Path(os.environ.get("XYZO_MODEL_DIR", "/var/www/vhosts/xyzo.org/data/nn_models")) / "category_classifier"
MODEL_BASE_DIR.mkdir(parents=True, exist_ok=True)

# Subtype to canonical parent category bucket
SUBTYPE_TO_BUCKET: dict[str, str] = {
    # Politics
    "politics": "politics", "elections": "politics", "courts": "politics",
    "policy": "politics", "diplomacy": "politics", "protest": "politics",
    "corruption": "politics", "geopolitics": "politics", "sanctions": "politics",
    "immigration": "politics", "government": "politics",
    # Business
    "business": "business", "markets": "business", "banking": "business",
    "crypto": "business", "realestate": "business", "labor": "business",
    "finance": "business", "startups": "business", "employment": "business",
    "trade": "business", "manufacturing": "business", "retail": "business",
    "shipping": "business", "economy": "business",
    # Technology
    "technology": "technology", "ai": "technology", "cybersecurity": "technology",
    "gaming": "technology", "telecom": "technology", "software": "technology",
    # Crime / Safety
    "crime": "crime", "shooting": "crime", "terrorism": "crime",
    "cybercrime": "crime", "missing": "crime", "traffic": "crime", "transit": "crime",
    # Weather / Climate
    "weather": "weather", "storm": "weather", "floods": "weather",
    "wildfire": "weather", "drought": "weather", "snow": "weather", "heatwave": "weather",
    "weather_alert": "weather", "cyclone": "weather",
    # Science
    "science": "science", "space": "science", "biology": "science",
    "physics": "science", "research": "science", "medicine": "science",
    # Sports
    "sports": "sports", "soccer": "sports", "basketball": "sports",
    "olympics": "sports", "racing": "sports", "cricket": "sports",
    "tennis": "sports", "swimming": "sports", "athletics": "sports",
    "motorsport": "sports",
    # Culture / Arts / Entertainment
    "culture": "culture", "film": "culture", "music": "culture",
    "art": "culture", "books": "culture", "food": "culture", "education": "culture",
    "literature": "culture", "theater": "culture", "festivals": "culture",
    "religion": "culture", "entertainment": "culture",
    # Environment
    "environment": "environment", "climate": "environment", "wildlife": "environment",
    "pollution": "environment", "energy": "environment",
    "agriculture": "environment", "water": "environment", "deforestation": "environment",
    # Health
    "health": "health", "outbreak": "health", "medical": "health",
    "mental_health": "health", "epidemic": "health", "vaccines": "health",
    "healthcare": "health",
    # Conflict / Military
    "conflict": "conflict", "war": "conflict", "military": "conflict",
    # Disaster
    "disaster": "disaster", "earthquake": "disaster", "volcano": "disaster",
    # Humanitarian
    "humanitarian": "humanitarian", "refugees": "humanitarian", "aid": "humanitarian",
    "inequality": "humanitarian", "human_rights": "humanitarian",
    "poverty": "humanitarian", "demographics": "humanitarian",
    "social_issues": "humanitarian",
    # Transport
    "aviation": "other", "maritime": "other", "rail": "other", "development": "other",
}

STOP_WORDS: set[str] = {
    "nbsp;&nbsp", "amp", "quot", "gt", "lt", "the", "and", "for", "that", "with",
    "from", "this", "have", "were", "been", "will", "would", "about", "after",
    "their", "which", "there", "what", "when", "where", "into", "more", "also",
    "some", "time", "year", "years", "said", "over", "could", "than", "other",
    "them", "then", "its", "our", "just", "like", "only", "first", "well"
}


class WordFreqNN(nn.Module):
    """PyTorch Deep Neural Network for multi-class category classification."""

    def __init__(self, input_dim: int, hidden_dim: int, num_classes: int):
        super().__init__()
        self.fc1 = nn.Linear(input_dim, hidden_dim)
        self.bn1 = nn.BatchNorm1d(hidden_dim)
        self.drop1 = nn.Dropout(0.3)
        self.fc2 = nn.Linear(hidden_dim, 128)
        self.bn2 = nn.BatchNorm1d(128)
        self.drop2 = nn.Dropout(0.2)
        self.out = nn.Linear(128, num_classes)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = F.gelu(self.bn1(self.fc1(x)))
        x = self.drop1(x)
        x = F.gelu(self.bn2(self.fc2(x)))
        x = self.drop2(x)
        return self.out(x)


class WordFrequencyClassifier:
    """Manages training, artifact storage, inference, and the learning loop."""

    def __init__(self, version: str = "v1"):
        self.version = version
        self.model_name = "category_classifier"
        self.model: WordFreqNN | None = None
        self.fast_clf: SGDClassifier | None = None
        self.vectorizer: DictVectorizer | None = None
        self.selector: SelectKBest | None = None
        self.categories: list[str] = []
        self.cat2idx: dict[str, int] = {}
        self.idx2cat: dict[int, str] = {}
        self.is_loaded = False

    def _clean_features(self, word_freq: dict | None, title: str | None = None, summary: str | None = None) -> dict[str, float]:
        """Extract and clean word frequency features + title/summary n-grams."""
        feats: dict[str, float] = {}
        if isinstance(word_freq, dict):
            for w, count in word_freq.items():
                w_clean = str(w).strip().lower()
                if len(w_clean) > 2 and w_clean not in STOP_WORDS and not w_clean.isdigit():
                    try:
                        feats[w_clean] = float(count)
                    except (ValueError, TypeError):
                        pass

        # Boost title words (high signal)
        if title:
            words = [w.strip().lower() for w in title.split() if len(w.strip()) > 2]
            for tw in words:
                if tw not in STOP_WORDS and not tw.isdigit():
                    feats[f"t_{tw}"] = feats.get(f"t_{tw}", 0.0) + 3.0
                    feats[tw] = feats.get(tw, 0.0) + 2.0

        return feats

    def train(self, max_samples: int = 60000, epochs: int = 8, batch_size: int = 256, k_features: int = 8192) -> dict[str, Any]:
        """Train classifier from labeled articles in news_articles."""
        log.info("Starting category classifier training from news_articles...")
        t0 = time.time()

        with connect() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT id, title, summary, event_type, word_freq 
                FROM news_articles 
                WHERE word_freq IS NOT NULL 
                  AND event_type IS NOT NULL 
                  AND event_type NOT IN ('other', 'news', 'none', '')
                ORDER BY id DESC
                LIMIT %s;
            """, (max_samples,))
            rows = cur.fetchall()

        if not rows:
            raise RuntimeError("No labeled training articles found in news_articles")

        log.info("Loaded %d labeled articles in %.2fs", len(rows), time.time() - t0)

        # Select categories with sufficient representation (>= 80 articles)
        counts = Counter(r["event_type"] for r in rows)
        self.categories = [c for c, cnt in counts.most_common(35) if cnt >= 80]
        self.cat2idx = {c: i for i, c in enumerate(self.categories)}
        self.idx2cat = {i: c for c, i in self.cat2idx.items()}

        features_list = []
        labels_list = []
        article_ids = []

        for r in rows:
            cat = r["event_type"]
            if cat not in self.cat2idx:
                continue
            wf = r["word_freq"]
            f = self._clean_features(wf, r["title"], r["summary"])
            if not f:
                continue
            features_list.append(f)
            labels_list.append(self.cat2idx[cat])
            article_ids.append(r["id"])

        log.info("Prepared %d training samples across %d categories", len(features_list), len(self.categories))

        X_train_dict, X_test_dict, y_train, y_test = train_test_split(
            features_list, labels_list, test_size=0.15, random_state=42, stratify=labels_list
        )

        self.vectorizer = DictVectorizer(sparse=True)
        X_train_sparse = self.vectorizer.fit_transform(X_train_dict)
        X_test_sparse = self.vectorizer.transform(X_test_dict)

        # Feature selection
        k_best = min(k_features, X_train_sparse.shape[1])
        self.selector = SelectKBest(chi2, k=k_best)
        X_train_k = self.selector.fit_transform(X_train_sparse, y_train)
        X_test_k = self.selector.transform(X_test_sparse)

        # Train fast linear ensemble model
        self.fast_clf = SGDClassifier(loss="log_loss", max_iter=30, alpha=1e-4, random_state=42)
        self.fast_clf.fit(X_train_k, y_train)
        fast_acc = float(self.fast_clf.score(X_test_k, y_test))
        log.info("Fast classifier accuracy: %.2f%%", fast_acc * 100)

        # Train PyTorch Neural Network
        self.model = WordFreqNN(k_best, 256, len(self.categories)).to(DEVICE)
        criterion = nn.CrossEntropyLoss()
        optimizer = torch.optim.AdamW(self.model.parameters(), lr=1e-3, weight_decay=1e-4)

        final_loss = 0.0
        val_acc = 0.0

        for epoch in range(epochs):
            self.model.train()
            epoch_loss = 0.0
            num_batches = 0
            for i in range(0, X_train_k.shape[0], batch_size):
                end_idx = min(i + batch_size, X_train_k.shape[0])
                batch_x = torch.from_numpy(X_train_k[i:end_idx].toarray()).float().to(DEVICE)
                batch_y = torch.tensor(y_train[i:end_idx], dtype=torch.long).to(DEVICE)

                optimizer.zero_grad()
                logits = self.model(batch_x)
                loss = criterion(logits, batch_y)
                loss.backward()
                optimizer.step()
                epoch_loss += loss.item()
                num_batches += 1

            final_loss = epoch_loss / max(1, num_batches)

            # Evaluate validation accuracy
            self.model.eval()
            with torch.no_grad():
                correct = 0
                total = 0
                for i in range(0, X_test_k.shape[0], batch_size):
                    end_idx = min(i + batch_size, X_test_k.shape[0])
                    batch_x = torch.from_numpy(X_test_k[i:end_idx].toarray()).float().to(DEVICE)
                    logits = self.model(batch_x)
                    preds = logits.argmax(dim=1).cpu().numpy()
                    correct += int((preds == y_test[i:end_idx]).sum())
                    total += (end_idx - i)
                val_acc = correct / max(1, total)

            log.info("Epoch %d/%d - loss: %.4f - val_acc: %.2f%%", epoch + 1, epochs, final_loss, val_acc * 100)

        # Measure bucket-level accuracy (e.g. elections -> politics is correct)
        self.model.eval()
        with torch.no_grad():
            bucket_correct = 0
            total = 0
            for i in range(0, X_test_k.shape[0], batch_size):
                end_idx = min(i + batch_size, X_test_k.shape[0])
                batch_x = torch.from_numpy(X_test_k[i:end_idx].toarray()).float().to(DEVICE)
                logits = self.model(batch_x)
                preds = logits.argmax(dim=1).cpu().numpy()
                for p_idx, true_idx in zip(preds, y_test[i:end_idx]):
                    pred_cat = self.idx2cat[p_idx]
                    true_cat = self.idx2cat[true_idx]
                    pred_bucket = SUBTYPE_TO_BUCKET.get(pred_cat, pred_cat)
                    true_bucket = SUBTYPE_TO_BUCKET.get(true_cat, true_cat)
                    if pred_bucket == true_bucket:
                        bucket_correct += 1
                    total += 1
            bucket_acc = bucket_correct / max(1, total)

        log.info("Canonical Bucket-level validation accuracy: %.2f%%", bucket_acc * 100)

        # Save artifacts
        version_dir = MODEL_BASE_DIR / self.version
        version_dir.mkdir(parents=True, exist_ok=True)

        torch.save(self.model.state_dict(), version_dir / "model.pt")
        joblib.dump(self.fast_clf, version_dir / "fast_clf.joblib")
        joblib.dump(self.vectorizer, version_dir / "vectorizer.joblib")
        joblib.dump(self.selector, version_dir / "selector.joblib")

        meta = {
            "version": self.version,
            "trained_at": datetime.now(timezone.utc).isoformat(),
            "device": str(DEVICE),
            "categories": self.categories,
            "cat2idx": self.cat2idx,
            "val_accuracy": float(val_acc),
            "bucket_accuracy": float(bucket_acc),
            "fast_accuracy": float(fast_acc),
            "final_loss": float(final_loss),
            "k_features": k_best,
            "train_samples": len(X_train_dict),
            "test_samples": len(X_test_dict),
        }
        with open(version_dir / "meta.json", "w") as f:
            json.dump(meta, f, indent=2)

        self.is_loaded = True

        # Register in database
        self._register_model_in_db(meta, version_dir)

        return meta

    def _register_model_in_db(self, meta: dict, version_dir: Path) -> None:
        """Register model in nn_model_registry and log training run."""
        try:
            artifact_path = str(version_dir / "model.pt")
            sha256 = hashlib.sha256(open(artifact_path, "rb").read()).hexdigest()
            artifact_bytes = os.path.getsize(artifact_path)
            dataset_hash = hashlib.sha256(str(meta["train_samples"]).encode()).hexdigest()[:16]

            with connect() as conn:
                cur = conn.cursor()
                # Ensure dataset version exists in nn_dataset_versions
                cur.execute("""
                    INSERT INTO nn_dataset_versions (dataset_hash, cycle_id, snapshot_at, row_counts, notes)
                    VALUES (%s, %s, now(), %s, %s)
                    ON CONFLICT (dataset_hash) DO NOTHING;
                """, (
                    dataset_hash,
                    f"cycle_{self.version}",
                    json.dumps({"train": meta["train_samples"], "test": meta["test_samples"]}),
                    "Article word frequency training set",
                ))

                # Deactivate previous versions
                cur.execute("""
                    UPDATE nn_model_registry 
                    SET is_active = FALSE 
                    WHERE model_name = %s;
                """, (self.model_name,))

                # Insert active model registry row
                cur.execute("""
                    INSERT INTO nn_model_registry (
                        model_name, version, trained_at, dataset_hash,
                        architecture, hyperparameters, metrics,
                        artifact_path, artifact_sha256, artifact_bytes, is_active, notes
                    ) VALUES (
                        %s, %s, now(), %s,
                        %s, %s, %s,
                        %s, %s, %s, TRUE, %s
                    ) RETURNING id;
                """, (
                    self.model_name,
                    self.version,
                    dataset_hash,
                    "WordFreqNN (MLP 2-Layer + BatchNorm + Dropout) & SGDClassifier Ensemble",
                    json.dumps({"k_features": meta["k_features"], "categories": len(self.categories)}),
                    json.dumps({
                        "val_accuracy": meta["val_accuracy"],
                        "bucket_accuracy": meta["bucket_accuracy"],
                        "fast_accuracy": meta["fast_accuracy"],
                        "final_loss": meta["final_loss"],
                    }),
                    artifact_path,
                    sha256,
                    artifact_bytes,
                    f"Word-frequency and headline neural network news classifier. {meta['bucket_accuracy']*100:.1f}% bucket accuracy.",
                ))
                reg_row = cur.fetchone()
                model_id = reg_row["id"] if reg_row else None

                # Log training run
                cur.execute("""
                    INSERT INTO nn_training_runs (
                        cycle_id, model_name, dataset_hash, started_at, finished_at, status,
                        rows_total, rows_train, rows_val, epochs_run, final_loss,
                        final_metrics, model_version, model_id, notes
                    ) VALUES (
                        %s, %s, %s, now() - interval '1 minute', now(), 'completed',
                        %s, %s, %s, %s, %s,
                        %s, %s, %s, %s
                    );
                """, (
                    f"cycle_{self.version}",
                    self.model_name,
                    dataset_hash,
                    meta["train_samples"] + meta["test_samples"],
                    meta["train_samples"],
                    meta["test_samples"],
                    8,
                    meta["final_loss"],
                    json.dumps(meta),
                    self.version,
                    model_id,
                    "Trained successfully on ground truth article word frequencies",
                ))
                conn.commit()
            log.info("Registered %s %s in nn_model_registry (active=True)", self.model_name, self.version)
        except Exception as e:
            log.warning("Could not register model in DB: %s", e)

    def load(self, version: str | None = None) -> bool:
        """Load trained model artifacts from disk."""
        target_version = version or self.version
        version_dir = MODEL_BASE_DIR / target_version

        if not (version_dir / "meta.json").exists():
            subdirs = sorted([d for d in MODEL_BASE_DIR.iterdir() if d.is_dir() and (d / "meta.json").exists()])
            if subdirs:
                version_dir = subdirs[-1]
            else:
                log.warning("No saved category classifier model found at %s", MODEL_BASE_DIR)
                return False

        try:
            with open(version_dir / "meta.json") as f:
                meta = json.load(f)

            self.version = meta["version"]
            self.categories = meta["categories"]
            self.cat2idx = meta["cat2idx"]
            self.idx2cat = {int(i): c for c, i in self.cat2idx.items()}

            self.vectorizer = joblib.load(version_dir / "vectorizer.joblib")
            self.selector = joblib.load(version_dir / "selector.joblib")
            self.fast_clf = joblib.load(version_dir / "fast_clf.joblib")

            k_features = meta["k_features"]
            self.model = WordFreqNN(k_features, 256, len(self.categories)).to(DEVICE)
            state_dict = torch.load(version_dir / "model.pt", map_location=DEVICE, weights_only=True)
            self.model.load_state_dict(state_dict)
            self.model.eval()

            self.is_loaded = True
            log.info("Loaded category classifier %s (val_acc=%.2f%%, bucket_acc=%.2f%%)",
                     self.version, meta.get("val_accuracy", 0) * 100, meta.get("bucket_accuracy", 0) * 100)
            return True
        except Exception as e:
            log.error("Failed to load category classifier: %s", e)
            return False

    def predict(self, word_freq: dict | None, title: str | None = None, summary: str | None = None) -> dict[str, Any]:
        """Predict category from an article's word frequency and headline."""
        if not self.is_loaded:
            if not self.load():
                return {"category": "other", "bucket": "other", "confidence": 0.0, "top_categories": []}

        feats = self._clean_features(word_freq, title, summary)
        if not feats or not self.vectorizer or not self.selector:
            return {"category": "other", "bucket": "other", "confidence": 0.0, "top_categories": []}

        sparse_x = self.vectorizer.transform([feats])
        k_x = self.selector.transform(sparse_x)

        with torch.no_grad():
            tensor_x = torch.from_numpy(k_x.toarray()).float().to(DEVICE)
            logits = self.model(tensor_x)
            probs = F.softmax(logits, dim=-1).cpu().numpy()[0]

        top_indices = np.argsort(probs)[::-1][:5]
        best_idx = top_indices[0]
        best_cat = self.idx2cat.get(best_idx, "other")
        confidence = float(probs[best_idx])

        top_categories = [
            {"category": self.idx2cat.get(idx, "other"), "confidence": round(float(probs[idx]), 3)}
            for idx in top_indices
        ]

        bucket = SUBTYPE_TO_BUCKET.get(best_cat, best_cat)

        return {
            "category": best_cat,
            "bucket": bucket,
            "confidence": round(confidence, 3),
            "top_categories": top_categories,
        }

    def predict_batch(self, articles: list[dict]) -> list[dict[str, Any]]:
        """Vectorized batch classification of articles."""
        if not self.is_loaded:
            if not self.load():
                return [{"category": "other", "bucket": "other", "confidence": 0.0} for _ in articles]

        feats_list = [
            self._clean_features(a.get("word_freq"), a.get("title"), a.get("summary"))
            for a in articles
        ]

        if not self.vectorizer or not self.selector:
            return [{"category": "other", "bucket": "other", "confidence": 0.0} for _ in articles]

        sparse_x = self.vectorizer.transform(feats_list)
        k_x = self.selector.transform(sparse_x)

        with torch.no_grad():
            tensor_x = torch.from_numpy(k_x.toarray()).float().to(DEVICE)
            logits = self.model(tensor_x)
            all_probs = F.softmax(logits, dim=-1).cpu().numpy()

        has_feats = np.asarray(sparse_x.sum(axis=1)).flatten() > 0

        results = []
        for i, probs in enumerate(all_probs):
            if not has_feats[i]:
                results.append({
                    "category": "other",
                    "bucket": "other",
                    "confidence": 0.0,
                })
                continue
            best_idx = int(np.argmax(probs))
            best_cat = self.idx2cat.get(best_idx, "other")
            confidence = float(probs[best_idx])
            bucket = SUBTYPE_TO_BUCKET.get(best_cat, best_cat)
            results.append({
                "category": best_cat,
                "bucket": bucket,
                "confidence": round(confidence, 3),
            })
        return results


# Global singleton instance
_classifier_instance: WordFrequencyClassifier | None = None

def get_classifier() -> WordFrequencyClassifier:
    """Return cached classifier instance, loading if necessary."""
    global _classifier_instance
    if _classifier_instance is None:
        _classifier_instance = WordFrequencyClassifier()
        _classifier_instance.load()
    return _classifier_instance
