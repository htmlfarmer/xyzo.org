#!/usr/bin/env python3
"""
Phase 5: Relationship Model Training

This script trains an advanced relationship model to predict event relationships.
Uses story_links as ground truth for positive examples and random pairs for negatives.

Relation Classes:
    0: same_story    - same underlying news story
    1: related       - related but different story
    2: follow_up     - follow-up coverage
    3: response      - response/reaction to another story
    4: background    - background context
    5: origin        - original/originating story
    6: destination   - story that is destination of a link
    7: mentioned     - mentioned/cited in another story

Story Link Types → Relation Mapping:
    same_event → same_story
    same_topic → related
    semantic_similarity → related
    same_city → mentioned
    same_country → mentioned
    same_entity → related
    manual → same_story (if strong) or related

Usage:
    python -m worker.nn_phase5_relationship --dry-run
    python -m worker.nn_phase5_relationship --train
    python -m worker.nn_phase5_relationship --deploy
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

log = logging.getLogger("xyzo.phase5_relationship")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

DEVICE = torch.device("cpu")

RELATION_CLASSES = [
    "same_story", "related", "follow_up", "response", "background",
    "origin", "destination", "mentioned",
]

RELATION_MAP = {
    "same_event": 0,     # same_story
    "same_topic": 1,     # related
    "semantic_similarity": 1,  # related
    "same_city": 7,      # mentioned
    "same_country": 7,   # mentioned
    "same_entity": 1,    # related
    "same_source": 1,   # related
    "manual": 1,         # related (manual links are often related)
    "ai_detected": 1,   # related
}


class RelationshipDataset(Dataset):
    """Dataset for relationship model using pre-computed embeddings."""

    FEAT_KEYS = [
        "cosine_sim", "jaccard_entity", "same_country", "same_city",
        "time_diff_h", "src_rank", "dst_rank", "src_sources", "dst_sources",
        "src_event_type_match", "dst_event_type_match",
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
            "src_emb": torch.tensor(r.get("src_emb", [0.0] * nn_train.EMBEDDING_DIM)),
            "dst_emb": torch.tensor(r.get("dst_emb", [0.0] * nn_train.EMBEDDING_DIM)),
            "scalar_feats": torch.tensor(feats, dtype=torch.float32),
            "relation_label": torch.tensor(r.get("relation_label", 0), dtype=torch.long),
            "score_label": torch.tensor(r.get("score_label", 0.0), dtype=torch.float32),
        }


def collate_fn(batch):
    return {
        "src_emb": torch.stack([b["src_emb"] for b in batch]),
        "dst_emb": torch.stack([b["dst_emb"] for b in batch]),
        "scalar_feats": torch.stack([b["scalar_feats"] for b in batch]),
        "relation_label": torch.stack([b["relation_label"] for b in batch]),
        "score_label": torch.stack([b["score_label"] for b in batch]),
    }


class SimpleRelationshipModel(nn.Module):
    """Advanced siamese relationship model using embeddings + features."""

    def __init__(self, emb_dim=16, num_features=11, hidden=128, num_relations=8):
        super().__init__()
        self.emb_proj = nn.Linear(emb_dim * 3, hidden)  # src, dst, diff
        self.feat_fc = nn.Sequential(
            nn.Linear(num_features, hidden // 2),
            nn.GELU(),
            nn.Linear(hidden // 2, hidden // 2),
            nn.GELU(),
        )
        self.encoder = nn.Sequential(
            nn.Linear(hidden + hidden // 2, hidden),
            nn.GELU(),
            nn.LayerNorm(hidden),
            nn.Dropout(0.2),
            nn.Linear(hidden, hidden),
            nn.GELU(),
            nn.LayerNorm(hidden),
        )
        self.relation_head = nn.Linear(hidden, num_relations)
        self.score_head = nn.Sequential(
            nn.Linear(hidden, hidden // 2),
            nn.GELU(),
            nn.Linear(hidden // 2, 1),
            nn.Sigmoid(),
        )
        self.confidence_head = nn.Sequential(
            nn.Linear(hidden, hidden // 2),
            nn.GELU(),
            nn.Linear(hidden // 2, 1),
            nn.Sigmoid(),
        )

    def forward(self, batch: dict) -> dict:
        src_emb = batch["src_emb"].to(DEVICE)
        dst_emb = batch["dst_emb"].to(DEVICE)
        feats = batch["scalar_feats"].to(DEVICE)

        diff = (src_emb - dst_emb).abs()
        combined_emb = torch.cat([src_emb, dst_emb, diff], dim=1)

        emb_proj = F.gelu(self.emb_proj(combined_emb))
        feat_out = self.feat_fc(feats)
        x = torch.cat([emb_proj, feat_out], dim=1)
        encoded = self.encoder(x)

        relation_logits = self.relation_head(encoded)
        score = self.score_head(encoded).squeeze(-1)
        confidence = self.confidence_head(encoded).squeeze(-1)

        result = {
            "relation_logits": relation_logits,
            "score": score,
            "confidence": confidence,
        }

        if "relation_label" in batch and batch["relation_label"] is not None:
            rel_labels = batch["relation_label"].to(DEVICE)
            score_labels = batch["score_label"].to(DEVICE)

            ce_loss = F.cross_entropy(relation_logits, rel_labels)
            bce_loss = F.binary_cross_entropy(score, score_labels)
            loss = ce_loss + bce_loss

            preds = relation_logits.argmax(dim=1)
            rel_acc = (preds == rel_labels).float().mean()

            result["loss"] = loss
            result["relation_acc"] = rel_acc.item()
            result["ce_loss"] = ce_loss.item()
            result["bce_loss"] = bce_loss.item()

        return result


def get_embeddings_for_articles(article_ids, cur):
    """Get pre-computed embeddings for article IDs."""
    if not article_ids:
        return {}

    placeholders = ",".join(["%s"] * len(article_ids))
    cur.execute(f"""
        SELECT a.id, e.vector
        FROM news_articles a
        JOIN nn_article_embeddings e ON e.article_id = a.id
        WHERE a.id IN ({placeholders})
    """, article_ids)

    result = {}
    for row in cur.fetchall():
        if row["vector"]:
            vec_str = str(row["vector"]).strip("[]")
            result[row["id"]] = [float(x) for x in vec_str.split(",")]
    return result


def create_training_data(limit=100000, neg_ratio=3):
    """Create training data from story links (positives) and random pairs (negatives)."""

    log.info("Creating relationship training data...")
    log.info("  Target: %d positive examples, %d negative", limit, limit * neg_ratio)

    with connect() as conn:
        cur = conn.cursor()

        # Get positive examples from story_links
        cur.execute("""
            SELECT
                sl.source_article_id,
                sl.target_article_id,
                sl.link_type,
                sl.link_strength,
                sa.title AS src_title,
                ta.title AS dst_title,
                sa.event_type AS src_event_type,
                ta.event_type AS dst_event_type,
                s1.country AS src_country,
                s2.country AS dst_country,
                sa.published_at AS src_pub,
                ta.published_at AS dst_pub,
                COALESCE(es1.source_count, 0) AS src_sources,
                COALESCE(es2.source_count, 0) AS dst_sources,
                ABS(EXTRACT(EPOCH FROM (sa.published_at - ta.published_at)) / 3600) AS time_diff_h
            FROM news_story_links sl
            JOIN news_articles sa ON sa.id = sl.source_article_id
            JOIN news_articles ta ON ta.id = sl.target_article_id
            JOIN news_sources s1 ON s1.id = sa.source_id
            JOIN news_sources s2 ON s2.id = ta.source_id
            LEFT JOIN news_event_sources aes1 ON aes1.article_id = sa.id
            LEFT JOIN news_events e1 ON e1.id = aes1.event_id
            LEFT JOIN news_event_sources aes2 ON aes2.article_id = ta.id
            LEFT JOIN news_events e2 ON e2.id = aes2.event_id
            LEFT JOIN LATERAL (
                SELECT COUNT(*) AS source_count
                FROM news_event_sources
                WHERE event_id = e1.id
            ) es1 ON TRUE
            LEFT JOIN LATERAL (
                SELECT COUNT(*) AS source_count
                FROM news_event_sources
                WHERE event_id = e2.id
            ) es2 ON TRUE
            WHERE sl.link_strength >= 0.3
              AND sl.link_type IN ('same_event', 'same_topic', 'same_city', 'same_country',
                                   'semantic_similarity', 'same_entity', 'ai_detected')
              AND sa.status = 'extracted'
              AND ta.status = 'extracted'
            ORDER BY sl.link_strength DESC
            LIMIT %s
        """, (limit,))
        positive_rows = list(cur.fetchall())

        log.info("  Found %d positive story links", len(positive_rows))

        # Get article embeddings for positive examples
        pos_article_ids = list(set(
            [r["source_article_id"] for r in positive_rows] +
            [r["target_article_id"] for r in positive_rows]
        ))
        embeddings = get_embeddings_for_articles(pos_article_ids, cur)
        log.info("  Got embeddings for %d/%d articles", len(embeddings), len(pos_article_ids))

        # Build positive training examples
        positive_examples = []
        for r in positive_rows:
            src_emb = embeddings.get(r["source_article_id"])
            dst_emb = embeddings.get(r["target_article_id"])
            if src_emb is None or dst_emb is None:
                continue

            src_emb_list = src_emb[:nn_train.EMBEDDING_DIM]
            dst_emb_list = dst_emb[:nn_train.EMBEDDING_DIM]

            cosine_sim = sum(a * b for a, b in zip(src_emb_list, dst_emb_list))
            same_country = 1.0 if r["src_country"] == r["dst_country"] else 0.0
            same_city = 1.0 if r["link_type"] == "same_city" else 0.0

            positive_examples.append({
                "src_emb": src_emb_list,
                "dst_emb": dst_emb_list,
                "relation_label": RELATION_MAP.get(r["link_type"], 1),
                "score_label": float(r["link_strength"]),
                "features_jsonb": {
                    "cosine_sim": cosine_sim,
                    "jaccard_entity": 0.0,
                    "same_country": same_country,
                    "same_city": same_city,
                    "time_diff_h": min(float(r["time_diff_h"] or 0) / 48.0, 5.0),
                    "src_rank": 0.0,
                    "dst_rank": 0.0,
                    "src_sources": min(float(r["src_sources"] or 0) / 100.0, 5.0),
                    "dst_sources": min(float(r["dst_sources"] or 0) / 100.0, 5.0),
                    "src_event_type_match": 1.0 if r["src_event_type"] == r["dst_event_type"] else 0.0,
                    "dst_event_type_match": 0.0,
                }
            })

        log.info("  Built %d positive examples", len(positive_examples))

        # Generate negative examples using pre-sampled articles
        cur.execute("""
            WITH recent_articles AS (
                SELECT id, source_id, title, event_type, published_at
                FROM news_articles
                WHERE status = 'extracted'
                  AND published_at > NOW() - INTERVAL '3 days'
                ORDER BY RANDOM()
                LIMIT 500
            ),
            article_sources AS (
                SELECT a.id, s.country
                FROM recent_articles a
                JOIN news_sources s ON s.id = a.source_id
            )
            SELECT a1.id AS id1, a2.id AS id2,
                   a1.title AS title1, a2.title AS title2,
                   a1.event_type AS event_type1, a2.event_type AS event_type2,
                   s1.country AS country1, s2.country AS country2,
                   a1.published_at AS pub1, a2.published_at AS pub2,
                   1 AS sources1, 1 AS sources2,
                   ABS(EXTRACT(EPOCH FROM (a1.published_at - a2.published_at)) / 3600) AS time_diff_h
            FROM recent_articles a1
            CROSS JOIN recent_articles a2
            JOIN article_sources s1 ON s1.id = a1.id
            JOIN article_sources s2 ON s2.id = a2.id
            LEFT JOIN news_story_links sl ON sl.source_article_id = a1.id AND sl.target_article_id = a2.id
            WHERE a1.id < a2.id
              AND sl.id IS NULL
              AND s1.country != s2.country
            ORDER BY RANDOM()
            LIMIT %s
        """, (limit * neg_ratio,))
        negative_rows = list(cur.fetchall())

        log.info("  Found %d negative candidate pairs", len(negative_rows))

        # Get embeddings for negative examples
        neg_article_ids = list(set([r["id1"] for r in negative_rows] + [r["id2"] for r in negative_rows]))
        neg_embeddings = get_embeddings_for_articles(neg_article_ids, cur)

        # Build negative training examples
        negative_examples = []
        for r in negative_rows:
            src_emb = neg_embeddings.get(r["id1"])
            dst_emb = neg_embeddings.get(r["id2"])
            if src_emb is None or dst_emb is None:
                continue

            src_emb_list = src_emb[:nn_train.EMBEDDING_DIM]
            dst_emb_list = dst_emb[:nn_train.EMBEDDING_DIM]

            cosine_sim = sum(a * b for a, b in zip(src_emb_list, dst_emb_list))

            negative_examples.append({
                "src_emb": src_emb_list,
                "dst_emb": dst_emb_list,
                "relation_label": 7,  # mentioned
                "score_label": 0.0,
                "features_jsonb": {
                    "cosine_sim": cosine_sim,
                    "jaccard_entity": 0.0,
                    "same_country": 0.0,
                    "same_city": 0.0,
                    "time_diff_h": min(float(r["time_diff_h"] or 0) / 48.0, 5.0),
                    "src_rank": 0.0,
                    "dst_rank": 0.0,
                    "src_sources": min(float(r["sources1"] or 0) / 100.0, 5.0),
                    "dst_sources": min(float(r["sources2"] or 0) / 100.0, 5.0),
                    "src_event_type_match": 0.0,
                    "dst_event_type_match": 0.0,
                }
            })

        log.info("  Built %d negative examples", len(negative_examples))

    # Combine and shuffle
    all_examples = positive_examples + negative_examples
    import random
    random.shuffle(all_examples)

    log.info("  Total training examples: %d", len(all_examples))

    # Class distribution
    from collections import Counter
    rel_dist = Counter(e["relation_label"] for e in all_examples)
    log.info("  Relation distribution: %s", {RELATION_CLASSES[k]: v for k, v in rel_dist.items()})

    return all_examples


def train_model(epochs=10, limit=100000, neg_ratio=3):
    """Train the relationship model."""

    log.info("=" * 60)
    log.info("PHASE 5: Training Relationship Model")
    log.info("=" * 60)

    torch.set_num_threads(4)

    model = SimpleRelationshipModel(
        emb_dim=nn_train.EMBEDDING_DIM,
        num_features=len(RelationshipDataset.FEAT_KEYS),
        hidden=128,
        num_relations=len(RELATION_CLASSES)
    ).to(DEVICE)

    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=0.01)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)

    rows = create_training_data(limit=limit, neg_ratio=neg_ratio)
    if len(rows) < 100:
        log.error("Insufficient training data: %d rows", len(rows))
        return None

    log.info("  Total examples for training: %d", len(rows))

    dataset = RelationshipDataset(rows)
    loader = DataLoader(dataset, batch_size=128, shuffle=True, num_workers=0, collate_fn=collate_fn)

    best_loss = float("inf")
    version = f"phase5_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

    for epoch in range(epochs):
        model.train()
        total_loss = 0
        total_ce_loss = 0
        total_bce_loss = 0
        total_samples = 0
        correct = 0

        for batch in loader:
            optimizer.zero_grad()
            out = model(batch)

            loss = out["loss"]
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

            total_loss += out["ce_loss"] * len(batch["relation_label"]) + out["bce_loss"] * len(batch["score_label"])
            total_ce_loss += out["ce_loss"] * len(batch["relation_label"])
            total_bce_loss += out["bce_loss"] * len(batch["score_label"])
            total_samples += len(batch["relation_label"])

            preds = out["relation_logits"].argmax(dim=1)
            correct += (preds == batch["relation_label"].to(DEVICE)).sum().item()

        scheduler.step()

        avg_loss = total_loss / (total_samples * 2)  # Both CE and BCE
        avg_ce = total_ce_loss / total_samples
        avg_bce = total_bce_loss / total_samples
        accuracy = correct / total_samples

        log.info("  Epoch %d: loss=%.4f (ce=%.4f, bce=%.4f), acc=%.3f",
                 epoch + 1, avg_loss, avg_ce, avg_bce, accuracy)

        if avg_loss < best_loss:
            best_loss = avg_loss
            best_metrics = {
                "loss": avg_loss,
                "ce_loss": avg_ce,
                "bce_loss": avg_bce,
                "accuracy": accuracy,
            }
            save_model(model, version, best_metrics)

    log.info("Best loss: %.4f", best_loss)
    return {"version": version, "loss": best_loss, "accuracy": accuracy}


def save_model(model, version, metrics=None):
    """Save model and metrics to disk."""
    model_dir = Path(os.environ.get("XYZO_MODEL_DIR", "/var/www/vhosts/xyzo.org/data/nn_models"))
    path = model_dir / "relationship" / version
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
    artifact_path = model_dir / "relationship" / version / "model.pt"

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
            WHERE model_name = 'relationship'
        """)

        cur.execute("""
            INSERT INTO nn_model_registry (
                model_name, version, trained_at, artifact_path,
                artifact_sha256, artifact_bytes,
                architecture, hyperparameters, metrics, is_active
            ) VALUES (
                'relationship', %s, %s, %s,
                %s, %s,
                'simple-relationship-model',
                %s, %s, TRUE
            )
            RETURNING id
        """, (
            version,
            datetime.now(timezone.utc),
            str(artifact_path),
            sha256, artifact_bytes,
            json.dumps({"hidden": 128, "emb_dim": nn_train.EMBEDDING_DIM, "num_features": 11}),
            json.dumps(metrics),
        ))
        conn.commit()

    log.info("Registered relationship model v%s as active", version)


def main():
    parser = argparse.ArgumentParser(description="Phase 5: Relationship Model")
    parser.add_argument("--dry-run", action="store_true", help="Just count data")
    parser.add_argument("--train", action="store_true", help="Train model")
    parser.add_argument("--deploy", action="store_true", help="Deploy model")
    parser.add_argument("--epochs", type=int, default=10, help="Training epochs")
    parser.add_argument("--limit", type=int, default=100000, help="Positive examples limit")
    parser.add_argument("--neg-ratio", type=int, default=3, help="Negative to positive ratio")
    args = parser.parse_args()

    if args.dry_run:
        rows = create_training_data(limit=args.limit, neg_ratio=args.neg_ratio)
        log.info("Would train on %d examples", len(rows))
        return

    if args.train:
        result = train_model(epochs=args.epochs, limit=args.limit, neg_ratio=args.neg_ratio)
        if result:
            log.info("Training complete: %s", result)

    if args.deploy:
        model_dir = Path(os.environ.get("XYZO_MODEL_DIR", "/var/www/vhosts/xyzo.org/data/nn_models"))
        versions = list((model_dir / "relationship").glob("phase5_*"))
        if versions:
            latest = sorted(versions)[-1].name
            metrics_path = model_dir / "relationship" / latest / "metrics.json"
            if metrics_path.exists():
                with open(metrics_path) as f:
                    metrics = json.load(f)
            else:
                metrics = {"note": "Advanced relationship model with story_links training"}
            register_model_in_db(latest, metrics)
            log.info("Deployed version: %s", latest)
        else:
            log.error("No phase5 model found to deploy")


if __name__ == "__main__":
    main()
