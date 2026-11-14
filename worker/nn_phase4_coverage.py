#!/usr/bin/env python3
"""
Phase 4: Coverage Gap Model

This script trains a model to predict which countries are under-covered.
Uses the proper CoverageModel architecture that matches nn_infer expectations.

Usage:
    python -m worker.nn_phase4_coverage --dry-run
    python -m worker.nn_phase4_coverage --train
    python -m worker.nn_phase4_coverage --deploy
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

log = logging.getLogger("xyzo.phase4_coverage")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

DEVICE = torch.device("cpu")


class CoverageDataset(Dataset):
    """Dataset for coverage gap model - matches nn_infer expectations."""

    FEAT_KEYS = [
        "active_sources_norm", "articles_24h_norm", "events_24h_norm",
        "events_per_million_norm", "gap_score_norm", "pop_norm",
        "lat_norm", "lng_norm",
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

        label = float(r.get("label", 0.0))

        return {
            "country_emb": torch.zeros(nn_train.EMBEDDING_DIM),
            "neighbor_scores": torch.zeros(32),
            "scalar_feats": torch.tensor(feats, dtype=torch.float32),
            "label": torch.tensor(label, dtype=torch.float32),
        }


def collate_fn(batch):
    return {
        "country_emb": torch.stack([b["country_emb"] for b in batch]),
        "neighbor_scores": torch.stack([b["neighbor_scores"] for b in batch]),
        "scalar_feats": torch.stack([b["scalar_feats"] for b in batch]),
        "label": torch.stack([b["label"] for b in batch]),
    }


def create_training_data():
    """Create training data from country coverage stats."""

    log.info("Creating coverage training data...")

    with connect() as conn:
        cur = conn.cursor()

        cur.execute("""
            WITH country_stats AS (
                SELECT
                    s.country as country_code,
                    COUNT(DISTINCT s.id) as active_sources,
                    COUNT(DISTINCT a.id) FILTER (WHERE a.fetched_at > NOW() - INTERVAL '24 hours') as articles_24h,
                    COUNT(DISTINCT a.id) FILTER (WHERE a.fetched_at > NOW() - INTERVAL '24 hours') / 1000.0 as events_24h
                FROM news_sources s
                LEFT JOIN news_articles a ON a.source_id = s.id
                WHERE s.country IS NOT NULL
                  AND s.active = TRUE
                GROUP BY s.country
            ),
            gap_scores AS (
                SELECT
                    cs.country_code,
                    cs.active_sources,
                    cs.articles_24h,
                    cs.events_24h,
                    CASE WHEN cs.articles_24h > 100 THEN 0.3
                         WHEN cs.articles_24h > 10 THEN 0.5
                         ELSE 0.7
                    END as classical_gap_score,
                    CASE WHEN cs.articles_24h > 100 THEN 0.8
                         WHEN cs.articles_24h > 50 THEN 0.6
                         WHEN cs.articles_24h > 10 THEN 0.4
                         ELSE 0.2
                    END - LEAST(1.0, cs.articles_24h::float / 200.0) as coverage_gap,
                    wc.lat, wc.lng, wc.population
                FROM country_stats cs
                LEFT JOIN world_cities wc ON wc.country_code = cs.country_code
                    AND wc.population = (
                        SELECT MAX(population) FROM world_cities
                        WHERE country_code = cs.country_code
                    )
            )
            SELECT
                gs.country_code,
                gs.active_sources,
                gs.articles_24h,
                gs.events_24h,
                gs.classical_gap_score,
                gs.coverage_gap as label,
                COALESCE(gs.lat, 0) as lat,
                COALESCE(gs.lng, 0) as lng,
                COALESCE(gs.population, 1000000) as population
            FROM gap_scores gs
            ORDER BY gs.coverage_gap DESC
            LIMIT 200
        """)
        rows = list(cur.fetchall())

    log.info("  Found %d countries with coverage data", len(rows))

    formatted_rows = []
    for r in rows:
        formatted_rows.append({
            "country_code": r["country_code"],
            "label": float(r["label"]),
            "features_jsonb": {
                "active_sources_norm": min(float(r["active_sources"] or 0) / 100.0, 5.0),
                "articles_24h_norm": min(float(r["articles_24h"] or 0) / 1000.0, 5.0),
                "events_24h_norm": min(float(r["events_24h"] or 0) / 100.0, 5.0),
                "events_per_million_norm": min(float(r["articles_24h"] or 0) / 200.0, 5.0),
                "gap_score_norm": float(r["classical_gap_score"] or 0.5),
                "pop_norm": min(float(r["population"] or 1000000) / 1e7, 5.0),
                "lat_norm": (float(r["lat"] or 0) + 90.0) / 180.0,
                "lng_norm": (float(r["lng"] or 0) + 180.0) / 360.0,
            }
        })

    return formatted_rows


def train_model(epochs=10):
    """Train the coverage gap model using proper CoverageModel architecture."""

    log.info("=" * 60)
    log.info("PHASE 4: Training Coverage Gap Model (Proper Architecture)")
    log.info("=" * 60)

    torch.set_num_threads(4)

    model = nn_train.CoverageModel().to(DEVICE)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=0.01)
    criterion = nn.MSELoss()

    rows = create_training_data()
    if len(rows) < 20:
        log.error("Insufficient training data: %d rows", len(rows))
        return None

    log.info("  Total countries for training: %d", len(rows))

    dataset = CoverageDataset(rows)
    loader = DataLoader(dataset, batch_size=16, shuffle=True, num_workers=0, collate_fn=collate_fn)

    best_loss = float("inf")
    version = f"phase4_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

    for epoch in range(epochs):
        model.train()
        total_loss = 0
        total_samples = 0

        for batch in loader:
            optimizer.zero_grad()
            out = model(batch)
            loss = criterion(out["gap_score"].squeeze(), batch["label"].to(DEVICE))
            loss.backward()
            optimizer.step()

            total_loss += loss.item() * len(batch["label"])
            total_samples += len(batch["label"])

        avg_loss = total_loss / total_samples

        model.eval()
        all_preds = []
        all_labels = []

        with torch.no_grad():
            for batch in loader:
                out = model(batch)
                all_preds.extend(out["gap_score"].squeeze().cpu().tolist())
                all_labels.extend(batch["label"].cpu().tolist())

        if len(all_preds) > 1:
            mean_pred = sum(all_preds) / len(all_preds)
            mean_label = sum(all_labels) / len(all_labels)
            num = sum((p - mean_pred) * (l - mean_label) for p, l in zip(all_preds, all_labels))
            den = (sum((p - mean_pred)**2 for p in all_preds) * sum((l - mean_label)**2 for l in all_labels)) ** 0.5
            corr = num / den if den > 0 else 0
        else:
            corr = 0

        log.info("  Epoch %d: loss=%.4f, correlation=%.3f", epoch + 1, avg_loss, corr)

        if avg_loss < best_loss:
            best_loss = avg_loss
            best_metrics = {"loss": avg_loss, "correlation": corr}
            save_model(model, version, best_metrics)

    log.info("Best loss: %.4f", best_loss)
    return {"version": version, "loss": best_loss, "correlation": corr}


def save_model(model, version, metrics=None):
    """Save model and metrics to disk."""
    model_dir = Path(os.environ.get("XYZO_MODEL_DIR", "/var/www/vhosts/xyzo.org/data/nn_models"))
    path = model_dir / "coverage" / version
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
    artifact_path = model_dir / "coverage" / version / "model.pt"

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
            WHERE model_name = 'coverage'
        """)

        cur.execute("""
            INSERT INTO nn_model_registry (
                model_name, version, trained_at, artifact_path,
                artifact_sha256, artifact_bytes,
                architecture, hyperparameters, metrics, is_active
            ) VALUES (
                'coverage', %s, %s, %s,
                %s, %s,
                'coverage-model',
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

    log.info("Registered coverage model v%s as active", version)


def main():
    parser = argparse.ArgumentParser(description="Phase 4: Coverage Gap Model")
    parser.add_argument("--dry-run", action="store_true", help="Just count data")
    parser.add_argument("--train", action="store_true", help="Train model")
    parser.add_argument("--deploy", action="store_true", help="Deploy model")
    parser.add_argument("--epochs", type=int, default=10, help="Training epochs")
    args = parser.parse_args()

    if args.dry_run:
        rows = create_training_data()
        log.info("Would train on %d countries", len(rows))
        return

    if args.train:
        result = train_model(epochs=args.epochs)
        if result:
            log.info("Training complete: %s", result)

    if args.deploy:
        model_dir = Path(os.environ.get("XYZO_MODEL_DIR", "/var/www/vhosts/xyzo.org/data/nn_models"))
        versions = list((model_dir / "coverage").glob("phase4_*"))
        if versions:
            latest = sorted(versions)[-1].name
            metrics_path = model_dir / "coverage" / latest / "metrics.json"
            if metrics_path.exists():
                with open(metrics_path) as f:
                    metrics = json.load(f)
            else:
                metrics = {"note": "CoverageModel architecture"}
            register_model_in_db(latest, metrics)
            log.info("Deployed version: %s", latest)
        else:
            log.error("No phase4 model found to deploy")


if __name__ == "__main__":
    main()
