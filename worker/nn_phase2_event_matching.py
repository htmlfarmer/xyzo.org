#!/usr/bin/env python3
"""
Phase 2: Event Matching + Feedback Loop Fix

This script creates event matching training data using pre-computed article embeddings
and trains a similarity head on top.

Usage:
    python -m worker.nn_phase2_event_matching --dry-run
    python -m worker.nn_phase2_event_matching --train
    python -m worker.nn_phase2_event_matching --deploy
"""
import argparse
import json
import logging
import os
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from worker.db import connect

log = logging.getLogger("xyzo.phase2_event_matching")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

DEVICE = torch.device("cpu")
EMBEDDING_DIM = 16


class SimpleEventMatcher(nn.Module):
    """Simple cosine similarity matcher using pre-computed embeddings."""

    def __init__(self, hidden=64):
        super().__init__()
        self.score_head = nn.Sequential(
            nn.Linear(EMBEDDING_DIM * 3, hidden),
            nn.GELU(),
            nn.Linear(hidden, 1),
        )

    def forward(self, emb_a, emb_b):
        cosine = (emb_a * emb_b).sum(dim=1, keepdim=True)
        diff = (emb_a - emb_b).abs()
        x = torch.cat([emb_a, emb_b, diff], dim=1)
        score = torch.sigmoid(self.score_head(x))
        return score

    def predict(self, emb_a, emb_b):
        """For inference: returns similarity score."""
        with torch.no_grad():
            return self.forward(emb_a, emb_b)


class EmbeddingDataset(Dataset):
    """Dataset using pre-computed embeddings from DB."""

    def __init__(self, pairs):
        self.pairs = pairs

    def __len__(self):
        return len(self.pairs)

    def __getitem__(self, idx):
        p = self.pairs[idx]
        return {
            "emb_a": torch.tensor(p["emb_a"]),
            "emb_b": torch.tensor(p["emb_b"]),
            "label": torch.tensor(p["label"], dtype=torch.float32),
        }


def collate_fn(batch):
    return {
        "emb_a": torch.stack([b["emb_a"] for b in batch]),
        "emb_b": torch.stack([b["emb_b"] for b in batch]),
        "label": torch.stack([b["label"] for b in batch]),
    }


def create_training_pairs_from_embeddings(limit=20000):
    """Create training pairs using pre-computed article embeddings."""

    log.info("Creating event matching training pairs from embeddings...")

    with connect() as conn:
        cur = conn.cursor()

        # Positive pairs: articles in same event, both have embeddings
        cur.execute("""
            SELECT DISTINCT ON (nes1.article_id, nes2.article_id)
                e.id as event_id,
                a1.id as article1_id, ia1.vector as emb1,
                a2.id as article2_id, ia2.vector as emb2
            FROM news_events e
            JOIN news_event_sources nes1 ON nes1.event_id = e.id
            JOIN news_event_sources nes2 ON nes2.event_id = e.id
            JOIN news_articles a1 ON a1.id = nes1.article_id
            JOIN news_articles a2 ON a2.id = nes2.article_id
            JOIN nn_article_embeddings ia1 ON ia1.article_id = a1.id
            JOIN nn_article_embeddings ia2 ON ia2.article_id = a2.id
            WHERE e.source_count BETWEEN 2 AND 20
              AND nes1.article_id < nes2.article_id
              AND ia1.vector IS NOT NULL
              AND ia2.vector IS NOT NULL
            LIMIT %s
        """, (limit // 2,))
        rows = list(cur.fetchall())
        log.info("  Found %d article pairs with embeddings", len(rows))

    # Parse embeddings from the query results
    positive_pairs = []
    for r in rows:
        try:
            # PostgreSQL vector is returned as string '[...]'
            emb1_str = r['emb1'] if isinstance(r['emb1'], str) else str(r['emb1'])
            emb2_str = r['emb2'] if isinstance(r['emb2'], str) else str(r['emb2'])

            # Parse the string representation
            emb1 = json.loads(emb1_str) if emb1_str.startswith('[') else None
            emb2 = json.loads(emb2_str) if emb2_str.startswith('[') else None

            if emb1 and emb2 and len(emb1) == EMBEDDING_DIM and len(emb2) == EMBEDDING_DIM:
                positive_pairs.append({
                    "article1_id": r['article1_id'],
                    "article2_id": r['article2_id'],
                    "emb_a": emb1,
                    "emb_b": emb2,
                    "label": 1.0,
                })
        except (json.JSONDecodeError, TypeError, ValueError) as e:
            continue

    log.info("  Positive pairs: %d", len(positive_pairs))

    # Negative pairs: articles in different events
    # Sample random pairs of articles from different events
    negative_pairs = []
    used_pairs = set()

    for _ in range(limit // 2):
        # Pick two random positive pairs from different events
        if len(positive_pairs) < 2:
            break

        p1 = random.choice(positive_pairs)
        p2 = random.choice(positive_pairs)

        if p1['article1_id'] != p2['article1_id']:
            pair_key = (min(p1['article1_id'], p2['article1_id']), max(p1['article1_id'], p2['article1_id']))
            if pair_key not in used_pairs:
                used_pairs.add(pair_key)
                negative_pairs.append({
                    "article1_id": p1['article1_id'],
                    "article2_id": p2['article1_id'],
                    "emb_a": p1['emb_a'],
                    "emb_b": p2['emb_a'],
                    "label": 0.0,
                })

    log.info("  Negative pairs: %d", len(negative_pairs))

    all_pairs = positive_pairs + negative_pairs
    random.shuffle(all_pairs)
    return all_pairs


def train_model(epochs=10, limit=20000):
    """Train the event matching model."""

    log.info("=" * 60)
    log.info("PHASE 2: Training Event Matching Model")
    log.info("=" * 60)

    torch.set_num_threads(4)

    # Create model
    model = SimpleEventMatcher(hidden=64).to(DEVICE)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-4, weight_decay=0.01)

    # Load training data
    pairs = create_training_pairs_from_embeddings(limit=limit)
    if len(pairs) < 100:
        log.error("Insufficient training pairs: %d", len(pairs))
        return None

    dataset = EmbeddingDataset(pairs)
    loader = DataLoader(dataset, batch_size=64, shuffle=True, num_workers=0, collate_fn=collate_fn)

    best_loss = float("inf")
    version = f"phase2_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

    for epoch in range(epochs):
        model.train()
        total_loss = 0
        total_correct = 0
        total_samples = 0

        for batch in loader:
            emb_a = batch["emb_a"].to(DEVICE)
            emb_b = batch["emb_b"].to(DEVICE)
            labels = batch["label"].to(DEVICE)

            optimizer.zero_grad()
            scores = model(emb_a, emb_b).squeeze()

            loss = F.binary_cross_entropy(scores, labels)
            loss.backward()
            optimizer.step()

            total_loss += loss.item() * len(labels)
            preds = (scores > 0.5).float()
            total_correct += (preds == labels).sum().item()
            total_samples += len(labels)

        avg_loss = total_loss / total_samples
        accuracy = total_correct / total_samples

        log.info("  Epoch %d: loss=%.4f, accuracy=%.3f", epoch + 1, avg_loss, accuracy)

        if avg_loss < best_loss:
            best_loss = avg_loss
            best_metrics = {"loss": avg_loss, "accuracy": accuracy}
            save_model(model, version, best_metrics)

    log.info("Best loss: %.4f", best_loss)
    return {"version": version, "loss": best_loss, "accuracy": accuracy}


def save_model(model, version, metrics=None):
    """Save model and metrics to disk."""
    model_dir = Path(os.environ.get("XYZO_MODEL_DIR", "/var/www/vhosts/xyzo.org/data/nn_models"))
    path = model_dir / "event_matching" / version
    path.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), path / "model.pt")
    log.info("Saved model to %s", path / "model.pt")

    if metrics:
        import json
        with open(path / "metrics.json", "w") as f:
            json.dump(metrics, f)
        log.info("Saved metrics to %s", path / "metrics.json")


def register_model_in_db(version, metrics):
    """Register the new model in the database."""
    model_dir = Path(os.environ.get("XYZO_MODEL_DIR", "/var/www/vhosts/xyzo.org/data/nn_models"))
    artifact_path = model_dir / "event_matching" / version / "model.pt"

    import hashlib
    sha = hashlib.sha256()
    with open(artifact_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha.update(chunk)
    sha256 = sha.hexdigest()
    artifact_bytes = artifact_path.stat().st_size

    with connect() as conn:
        cur = conn.cursor()

        cur.execute("""
            UPDATE nn_model_registry
            SET is_active = FALSE
            WHERE model_name = 'event_matching'
        """)

        cur.execute("""
            INSERT INTO nn_model_registry (
                model_name, version, trained_at, artifact_path,
                artifact_sha256, artifact_bytes,
                architecture, hyperparameters, metrics, is_active
            ) VALUES (
                'event_matching', %s, %s, %s,
                %s, %s,
                'simple-event-matcher',
                %s, %s, TRUE
            )
            RETURNING id
        """, (
            version,
            datetime.now(timezone.utc),
            str(artifact_path),
            sha256, artifact_bytes,
            json.dumps({"hidden": 64}),
            json.dumps(metrics),
        ))
        conn.commit()

    log.info("Registered event_matching model v%s as active", version)


def main():
    parser = argparse.ArgumentParser(description="Phase 2: Event Matching")
    parser.add_argument("--dry-run", action="store_true", help="Just count data")
    parser.add_argument("--train", action="store_true", help="Train model")
    parser.add_argument("--deploy", action="store_true", help="Deploy model")
    parser.add_argument("--epochs", type=int, default=10, help="Training epochs")
    parser.add_argument("--limit", type=int, default=20000, help="Training data limit")
    args = parser.parse_args()

    if args.dry_run:
        pairs = create_training_pairs_from_embeddings(1000)
        log.info("Would train on %d pairs", len(pairs))
        return

    if args.train:
        result = train_model(epochs=args.epochs, limit=args.limit)
        if result:
            log.info("Training complete: %s", result)

    if args.deploy:
        model_dir = Path(os.environ.get("XYZO_MODEL_DIR", "/var/www/vhosts/xyzo.org/data/nn_models"))
        versions = list((model_dir / "event_matching").glob("phase2_*"))
        if versions:
            latest = sorted(versions)[-1].name
            metrics_path = model_dir / "event_matching" / latest / "metrics.json"
            if metrics_path.exists():
                with open(metrics_path) as f:
                    metrics = json.load(f)
            else:
                metrics = {"note": "trained with pre-computed embeddings"}
            register_model_in_db(latest, metrics)
            log.info("Deployed version: %s", latest)
        else:
            log.error("No phase2 model found to deploy")


if __name__ == "__main__":
    main()
