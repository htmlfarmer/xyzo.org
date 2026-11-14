#!/usr/bin/env python3
"""
Phase 3: Ranking Model Training

This script trains a ranking model to predict which events should be shown first.
Uses the proper RankingModel architecture that matches nn_infer expectations.

Usage:
    python -m worker.nn_phase3_ranking --dry-run
    python -m worker.nn_phase3_ranking --train
    python -m worker.nn_phase3_ranking --deploy
"""
import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from worker.db import connect
from worker import nn_train

log = logging.getLogger("xyzo.phase3_ranking")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

DEVICE = torch.device("cpu")


class RankingDataset(Dataset):
    """Dataset for ranking model - matches nn_infer expectations."""

    FEAT_KEYS = [
        "source_quality", "freshness", "velocity_clicks", "velocity_views",
        "accel_clicks", "event_source_count", "country_match", "topic_match",
        "unique_sources", "session_interactions", "local_relevance",
        "has_embedding", "high_zoom_views", "avg_zoom_depth", "zoom_view_duration_ms", "unique_cities_viewed",
        "city_zoom_score", "city_view_count",
        "has_byline", "has_contact_info", "readability_score",
        # Graph interconnection features (from news_event_graph_features)
        "graph_total_links", "graph_connectivity", "graph_same_event_links",
        "graph_consensus", "graph_link_types", "graph_avg_strength",
    ]

    def __init__(self, rows):
        self.rows = rows

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, idx):
        r = self.rows[idx]
        f = r.get("features_jsonb", {})

        feats = []
        for k in self.FEAT_KEYS:
            v = f.get(k, 0.0)
            feats.append(float(v))

        return {
            "article_emb": torch.zeros(nn_train.EMBEDDING_DIM),
            "session_emb": torch.zeros(64),
            "scalar_feats": torch.tensor(feats, dtype=torch.float32),
            "label": torch.tensor(r.get("label", 0.0), dtype=torch.float32),
        }


def collate_fn(batch):
    return {
        "article_emb": torch.stack([b["article_emb"] for b in batch]),
        "session_emb": torch.stack([b["session_emb"] for b in batch]),
        "scalar_feats": torch.stack([b["scalar_feats"] for b in batch]),
        "label": torch.stack([b["label"] for b in batch]),
    }


def create_training_data(limit=30000):
    """Create training data from events with source counts."""

    log.info("Creating ranking training data...")

    with connect() as conn:
        cur = conn.cursor()

        cur.execute("""
            SELECT
                e.id as event_id,
                e.source_count as label,
                e.created_at,
                0.5 as source_quality,
                GREATEST(0, 1.0 - EXTRACT(EPOCH FROM (NOW() - e.created_at)) / 86400.0) as freshness,
                0 as velocity_clicks,
                0 as velocity_views,
                0 as accel_clicks,
                LEAST(e.source_count / 10.0, 1.0) as event_source_count,
                0.5 as country_match,
                0.5 as topic_match,
                e.source_count as unique_sources,
                0 as session_interactions,
                0.5 as local_relevance,
                0 as high_zoom_views,
                0 as avg_zoom_depth,
                0 as zoom_view_duration_ms,
                0 as unique_cities_viewed,
                0 as city_zoom_score,
                0 as city_view_count,
                1.0 as has_byline,
                1.0 as has_contact_info,
                0.5 as readability_score,
                -- Graph interconnection features
                COALESCE(g.total_links, 0) as graph_total_links,
                COALESCE(g.connectivity_score, 0) as graph_connectivity,
                COALESCE(g.same_event_links, 0) as graph_same_event_links,
                COALESCE(g.same_event_avg_strength, 0) as graph_consensus,
                COALESCE(g.link_type_count, 0) as graph_link_types,
                COALESCE(g.avg_link_strength, 0) as graph_avg_strength
            FROM news_events e
            LEFT JOIN news_event_graph_features g ON g.event_id = e.id
            WHERE e.created_at > NOW() - INTERVAL '30 days'
              AND e.source_count > 0
            ORDER BY e.source_count DESC
            LIMIT %s
        """, (limit,))
        rows = list(cur.fetchall())

    log.info("  Found %d events", len(rows))

    formatted_rows = []
    for r in rows:
        formatted_rows.append({
            "event_id": r["event_id"],
            "label": min(float(r["label"]) / 50.0, 1.0),
            "features_jsonb": {
                "source_quality": r.get("source_quality", 0.5),
                "freshness": r.get("freshness", 0.5),
                "velocity_clicks": r.get("velocity_clicks", 0),
                "velocity_views": r.get("velocity_views", 0),
                "accel_clicks": r.get("accel_clicks", 0),
                "event_source_count": r.get("event_source_count", 0),
                "country_match": r.get("country_match", 0.5),
                "topic_match": r.get("topic_match", 0.5),
                "unique_sources": min(float(r.get("unique_sources", 0)) / 100.0, 5.0),
                "session_interactions": min(float(r.get("session_interactions", 0)) / 1000.0, 5.0),
                "local_relevance": r.get("local_relevance", 0.5),
                "has_embedding": 1.0,
                "high_zoom_views": min(float(r.get("high_zoom_views", 0)) / 100.0, 5.0),
                "avg_zoom_depth": min(float(r.get("avg_zoom_depth", 0)) / 10.0, 5.0),
                "zoom_view_duration_ms": min(float(r.get("zoom_view_duration_ms", 0)) / 60000.0, 5.0),
                "unique_cities_viewed": min(float(r.get("unique_cities_viewed", 0)) / 50.0, 5.0),
                "city_zoom_score": min(float(r.get("city_zoom_score", 0)) / 100.0, 5.0),
                "city_view_count": min(float(r.get("city_view_count", 0)) / 1000.0, 5.0),
                "has_byline": r.get("has_byline", 1.0),
                "has_contact_info": r.get("has_contact_info", 1.0),
                "readability_score": r.get("readability_score", 0.5),
                # Graph interconnection features
                "graph_total_links": min(float(r.get("graph_total_links", 0)) / 1000.0, 5.0),
                "graph_connectivity": min(float(r.get("graph_connectivity", 0)) / 10.0, 5.0),
                "graph_same_event_links": min(float(r.get("graph_same_event_links", 0)) / 500.0, 5.0),
                "graph_consensus": min(float(r.get("graph_consensus", 0)) / 100.0, 5.0),
                "graph_link_types": min(float(r.get("graph_link_types", 0)) / 5.0, 5.0),
                "graph_avg_strength": min(float(r.get("graph_avg_strength", 0)) / 3.0, 5.0),
            }
        })

    return formatted_rows


def train_model(epochs=10, limit=30000):
    """Train the ranking model using proper RankingModel architecture."""

    log.info("=" * 60)
    log.info("PHASE 3: Training Ranking Model (Proper Architecture)")
    log.info("=" * 60)

    torch.set_num_threads(4)

    model = nn_train.RankingModel().to(DEVICE)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=0.01)
    criterion = nn.MSELoss()

    rows = create_training_data(limit=limit)
    if len(rows) < 100:
        log.error("Insufficient training data: %d rows", len(rows))
        return None

    log.info("  Total events for training: %d", len(rows))

    dataset = RankingDataset(rows)
    loader = DataLoader(dataset, batch_size=64, shuffle=True, num_workers=0, collate_fn=collate_fn)

    best_loss = float("inf")
    version = f"phase3_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

    for epoch in range(epochs):
        model.train()
        total_loss = 0
        total_correct = 0
        total_samples = 0

        for batch in loader:
            optimizer.zero_grad()
            out = model(batch)
            loss = criterion(out["score"].squeeze(), batch["label"].to(DEVICE))
            loss.backward()
            optimizer.step()

            total_loss += loss.item() * len(batch["label"])
            total_correct += ((out["score"].squeeze() - batch["label"].to(DEVICE)).abs() < 0.2).sum().item()
            total_samples += len(batch["label"])

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
    path = model_dir / "ranking" / version
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
    artifact_path = model_dir / "ranking" / version / "model.pt"

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
            WHERE model_name = 'ranking'
        """)

        cur.execute("""
            INSERT INTO nn_model_registry (
                model_name, version, trained_at, artifact_path,
                artifact_sha256, artifact_bytes,
                architecture, hyperparameters, metrics, is_active
            ) VALUES (
                'ranking', %s, %s, %s,
                %s, %s,
                'ranking-model',
                %s, %s, TRUE
            )
            RETURNING id
        """, (
            version,
            datetime.now(timezone.utc),
            str(artifact_path),
            sha256, artifact_bytes,
            json.dumps({"hidden": 128, "emb_dim": nn_train.EMBEDDING_DIM}),
            json.dumps(metrics),
        ))
        conn.commit()

    log.info("Registered ranking model v%s as active", version)


def main():
    parser = argparse.ArgumentParser(description="Phase 3: Ranking Model")
    parser.add_argument("--dry-run", action="store_true", help="Just count data")
    parser.add_argument("--train", action="store_true", help="Train model")
    parser.add_argument("--deploy", action="store_true", help="Deploy model")
    parser.add_argument("--epochs", type=int, default=10, help="Training epochs")
    parser.add_argument("--limit", type=int, default=30000, help="Training limit")
    args = parser.parse_args()

    if args.dry_run:
        rows = create_training_data(limit=args.limit)
        log.info("Would train on %d events", len(rows))
        return

    if args.train:
        result = train_model(epochs=args.epochs, limit=args.limit)
        if result:
            log.info("Training complete: %s", result)

    if args.deploy:
        model_dir = Path(os.environ.get("XYZO_MODEL_DIR", "/var/www/vhosts/xyzo.org/data/nn_models"))
        versions = list((model_dir / "ranking").glob("phase3_*"))
        if versions:
            latest = sorted(versions)[-1].name
            metrics_path = model_dir / "ranking" / latest / "metrics.json"
            if metrics_path.exists():
                with open(metrics_path) as f:
                    metrics = json.load(f)
            else:
                metrics = {"note": "RankingModel architecture"}
            register_model_in_db(latest, metrics)
            log.info("Deployed version: %s", latest)
        else:
            log.error("No phase3 model found to deploy")


if __name__ == "__main__":
    main()
