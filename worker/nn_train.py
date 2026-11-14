"""Xyzo neural network training loop.

Trains the 7-model taxonomy described in schema-neural-networks.sql:

  1. article_understanding  — text encoder (distilbert-base).
                              Output: 16-dim embedding per article.
                              Loss:   triplet (anchor=article, pos=related, neg=unrelated).
                              Think of it as: "teach the AI to read a headline
                              and know what it's ABOUT, not just what words it contains."

  2. entity_extraction      — lightweight BIO tagger over tokenized article.
                              Loss:   cross-entropy over BIO labels.
                              BIO = Beginning, Inside, Outside. Yes, it's an acronym.
                              No, we won't apologize for it.

  3. event_matching        — siamese twin of article_understanding; cosine sim score.
                              Loss:   binary cross-entropy on same/different event label.
                              "Are these two articles about the same thing?"
                              The AI equivalent of "same energy."

  4. relationship          — twin siamese + edge-type MLP → relation type + score.
                              Loss:   cross-entropy (relation) + BCE (score).
                              8 types of relationships: same_story, related, follow_up,
                              response, background, origin, destination, mentioned.
                              Because "related" wasn't specific enough.

  6. ranking               — [article_emb × session_emb, other features] → ranking score.
                              Loss:   listwise LambdaRank-style or pairwise BCE.
                              "Which stories should you see first?"
                              The AI version of "editor's pick," but with math.

  7. coverage              — [country_emb, classical_gap, neighbors] → gap score.
                              Loss:   MSE (gap_score) + BCE (has_sources).
                              "Which countries are we NOT covering well enough?"
                              The guilt trip model.

Architecture philosophy
──────────────────────
All models share a common embedding space so outputs of model 1 can feed
models 2-6 without re-encoding.  article_understanding is trained first
as the foundation; all other models consume its embeddings.

NOTE: there is no geolocation model. The geolocation head was removed
2026-10-26 — it never placed an article (its predictions were written to
nn_prediction_cache and read by nothing), its trainer explicitly skipped
text embeddings ("using zero text embeddings for fast training"), so the
text pathway never learned anything, and the classical pipeline
(auto_categorize → extract → geocode → place_disambiguation) places 95%+
of articles. Do not reintroduce it without a real held-out evaluation and
a write-back path into news_articles.extracted_lat/lng.

Training strategy
─────────────────
- AdamW optimizer, linear warmup + cosine decay.
- Early stopping on validation loss (patience=3). Yes, the AI gets bored too.
- Mixed precision (fp16) when available. Saves memory, same quality.
- Batch size 32 default; gradient accumulation for effective 128.
- nn_training_runs row written at start and updated on completion.
- Artifacts saved to /data/nn_models/<model_name>/<version>.pt.

Run
---
    python -m worker.nn_train                       # train all models
    python -m worker.nn_train --only article_understanding
    python -m worker.nn_train --epochs 5 --batch-size 64
    python -m worker.nn_train --dataset-hash <hash>  # reproduce specific dataset
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import os
import shutil
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset
from torch.cuda.amp import autocast, GradScaler

from .db import connect

log = logging.getLogger("xyzo.nn_train")

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
EMBEDDING_DIM = 16
MODEL_DIR = Path(os.environ.get("XYZO_MODEL_DIR", "/var/www/vhosts/xyzo.org/data/nn_models"))
BATCH_SIZE = 32
GRAD_ACCUM = 4
LEARNING_RATE = 2e-4
WARMUP_STEPS = 100
EPOCHS_DEFAULT = 10
PATIENCE = 3

os.makedirs(MODEL_DIR, exist_ok=True)


# ── Dataset ──────────────────────────────────────────────────────────────────

class TrainingDataset(Dataset):
    def __init__(self, rows: list[dict]):
        self.rows = rows

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, idx: int) -> dict:
        r = self.rows[idx]
        label = r.get("label")
        return {
            "features": r["features_jsonb"],
            "label": torch.tensor(label, dtype=torch.float32) if label is not None else torch.zeros(1),
            "label_aux": r.get("label_aux") or {},
            "entity_id": r["entity_id"],
        }


# ── Shared text encoder ───────────────────────────────────────────────────────

class TextEncoder(nn.Module):
    """DistilBERT-based encoder that produces a fixed-dim embedding.

    We use the CLS token projection, not mean-pooling, for speed.

    "Why 16 dimensions?"
    Because that's enough to capture the essential meaning of a news headline
    while keeping the vector small enough for fast similarity searches.
    Think of it as a very compressed understanding of what the article is about.
    """

    def __init__(self, dim: int = EMBEDDING_DIM):
        super().__init__()
        try:
            from sentence_transformers import SentenceTransformer
            self.backend = SentenceTransformer("distilbert-base-nli-stsb-mean-tokens", device=DEVICE)
            self._fixed = nn.Linear(768, dim, bias=False)
            self._active = True
            log.info("TextEncoder: using sentence-transformers distilbert")
        except Exception:
            # Fallback: hash-based encoder. Not great, not terrible.
            # When GPU is busy with Gemma, this is what keeps us running.
            log.warning("sentence-transformers not available — using simple hash encoder")
            self.backend = None
            self._active = False
            self.vocab = {}
            self._embed = nn.Embedding(8192, dim)

    def forward(self, texts: list[str]) -> torch.Tensor:
        if self._active:
            with torch.no_grad():
                embs = self.backend.encode(texts, convert_to_numpy=True, show_progress_bar=False)
            embs = torch.from_numpy(embs).float().to(DEVICE)
            return self._fixed(embs)
        else:
            indices = []
            for t in texts:
                h = abs(hash(t)) % 8192
                indices.append(h)
            idx = torch.tensor(indices, dtype=torch.long, device=DEVICE)
            return self._embed(idx)


# ── 1. Article Understanding ─────────────────────────────────────────────────

class ArticleUnderstanding(nn.Module):
    """Triplet-loss text encoder: anchor article + pos=related article + neg=random."""

    def __init__(self, dim: int = EMBEDDING_DIM):
        super().__init__()
        self.text_encoder = TextEncoder(dim)
        self.dim = dim

    def encode(self, texts: list[str]) -> torch.Tensor:
        return F.normalize(self.text_encoder(texts), p=2, dim=1)

    def forward(self, batch: dict) -> dict:
        # Handle both list of strings and tuple of lists from DataLoader
        def flatten_texts(texts):
            if isinstance(texts, (list, tuple)):
                # Check if it's a list of strings or list of lists
                if texts and isinstance(texts[0], (list, tuple)):
                    return [t[0] if isinstance(t, (list, tuple)) else t for t in texts]
                return list(texts)
            return [texts]
        
        anchors = self.encode(flatten_texts(batch["anchors"]))
        positives = self.encode(flatten_texts(batch["positives"]))
        negatives = self.encode(flatten_texts(batch["negatives"]))

        d_pos = F.pairwise_distance(anchors, positives)
        d_neg = F.pairwise_distance(anchors, negatives)
        loss = F.relu(d_pos - d_neg + 0.5).mean()

        return {
            "loss": loss,
            "d_pos": d_pos.mean().item(),
            "d_neg": d_neg.mean().item(),
            "anchors": anchors,
            "positives": positives,
            "negatives": negatives,
        }


# ── 2. Entity Extraction ────────────────────────────────────────────────────

class EntityExtractor(nn.Module):
    """BIO tagger. Lightweight 1D-CNN over token embeddings + linear head."""

    def __init__(self, vocab_size: int = 8192, num_classes: int = 7, dim: int = 64):
        super().__init__()
        self.embed = nn.Embedding(vocab_size, dim)
        self.cnn = nn.Conv1d(dim, dim, kernel_size=3, padding=1)
        self.head = nn.Linear(dim, num_classes)

    def forward(self, batch: dict) -> dict:
        tokens = batch["tokens"].to(DEVICE)  # (B, T)
        labels = batch["labels"].to(DEVICE)  # (B, T)
        mask = batch["mask"].to(DEVICE)

        x = self.embed(tokens).transpose(1, 2)  # (B, D, T)
        x = F.gelu(self.cnn(x)).transpose(1, 2)  # (B, T, D)
        logits = self.head(x)  # (B, T, C)

        loss = F.cross_entropy(
            logits.view(-1, logits.size(-1)),
            labels.view(-1),
            reduction="none",
        )
        loss = (loss * mask.view(-1)).sum() / mask.sum().clamp(min=1)
        preds = logits.argmax(dim=-1)
        acc = ((preds == labels) * mask.bool()).sum() / mask.sum().clamp(min=1)

        return {"loss": loss, "accuracy": acc.item(), "logits": logits}


# ── 3. Event Matching ────────────────────────────────────────────────────────

class EventMatcher(nn.Module):
    """Siamese twin of article encoder + cosine similarity head."""

    def __init__(self, article_model: ArticleUnderstanding, hidden: int = 64):
        super().__init__()
        self.article_model = article_model
        self.score_head = nn.Sequential(
            nn.Linear(EMBEDDING_DIM * 3, hidden),
            nn.GELU(),
            nn.Linear(hidden, 1),
        )

    def forward(self, batch: dict) -> dict:
        emb_a = self.article_model.encode(batch["title_a"])
        emb_b = self.article_model.encode(batch["title_b"])

        cosine = (emb_a * emb_b).sum(dim=1, keepdim=True)
        diff = (emb_a - emb_b).abs()
        x = torch.cat([emb_a, emb_b, diff], dim=1)
        score = torch.sigmoid(self.score_head(x))

        labels = batch["label"].to(DEVICE)
        loss = F.binary_cross_entropy(score.squeeze(), labels)

        preds = (score > 0.5).squeeze().float()
        acc = (preds == labels).float().mean()

        return {"loss": loss, "score": score, "accuracy": acc.item()}


# ── 4. Relationship Model ────────────────────────────────────────────────────

RELATION_CLASSES = [
    "same_story", "related", "follow_up", "response", "background",
    "origin", "destination", "mentioned",
]


class RelationshipModel(nn.Module):
    """Twin siamese + edge-type MLP → relation type + score."""

    def __init__(self, article_model: ArticleUnderstanding, hidden: int = 64):
        super().__init__()
        self.article_model = article_model
        self.edge_type_embed = nn.Embedding(3, 32)  # event, location, mixed
        self.fc = nn.Sequential(
            nn.Linear(EMBEDDING_DIM * 3 + 32, hidden),
            nn.GELU(),
            nn.LayerNorm(hidden),
            nn.Linear(hidden, hidden),
            nn.GELU(),
        )
        self.relation_head = nn.Linear(hidden, len(RELATION_CLASSES))
        self.score_head = nn.Linear(hidden, 1)

    def forward(self, batch: dict) -> dict:
        src_emb = self.article_model.encode(batch["src_title"])
        dst_emb = self.article_model.encode(batch["dst_title"])
        edge_idx = batch.get("edge_type_idx", torch.zeros(len(batch["src_title"]), dtype=torch.long, device=DEVICE))
        edge_emb = self.edge_type_embed(edge_idx.clamp(0, 2))

        diff = (src_emb - dst_emb).abs()
        x = torch.cat([src_emb, dst_emb, diff, edge_emb], dim=1)
        x = self.fc(x)
        relation_logits = self.relation_head(x)
        score = torch.sigmoid(self.score_head(x))

        rel_labels = batch.get("relation_label")
        if rel_labels is not None:
            rel_labels = rel_labels.to(DEVICE)
            ce_loss = F.cross_entropy(relation_logits, rel_labels)
            bce_loss = F.binary_cross_entropy(score.squeeze(), batch["score_label"].to(DEVICE))
            loss = ce_loss + bce_loss
        else:
            loss = F.binary_cross_entropy(score.squeeze(), batch["score_label"].to(DEVICE)) if batch.get("score_label") is not None else torch.tensor(0.0)

        preds = relation_logits.argmax(dim=1)
        rel_acc = (preds == rel_labels).float().mean() if rel_labels is not None else torch.tensor(0.0)

        return {"loss": loss, "relation_logits": relation_logits, "score": score, "relation_acc": rel_acc.item()}


class SimpleRelationshipModel(nn.Module):
    """Advanced siamese relationship model using pre-computed embeddings + features.

    Unlike RelationshipModel which requires an article_model for encoding,
    this model takes pre-computed embeddings directly.
    """

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


# ── 5. Ranking Model ─────────────────────────────────────────────────────────

class RankingModel(nn.Module):
    """Score article relevance given article embedding + session features."""

    def __init__(self, text_dim: int = EMBEDDING_DIM, hidden: int = 128):
        super().__init__()
        self.article_proj = nn.Linear(text_dim, hidden)
        self.session_proj = nn.Linear(64, hidden)
        self.feat_fc = nn.Linear(len(RankingDataset.FEAT_KEYS), hidden)
        self.encoder = nn.Sequential(
            nn.Linear(hidden * 3, hidden),
            nn.GELU(),
            nn.LayerNorm(hidden),
            nn.Linear(hidden, hidden // 2),
            nn.GELU(),
        )
        self.score_head = nn.Linear(hidden // 2, 1)
        self.trending_head = nn.Linear(hidden // 2, 1)
        self.local_head = nn.Linear(hidden // 2, 1)
        self.quality_head = nn.Linear(hidden // 2, 1)
        self.freshness_head = nn.Linear(hidden // 2, 1)

    def forward(self, batch: dict) -> dict:
        art_emb = batch["article_emb"].to(DEVICE)
        sess_emb = batch["session_emb"].to(DEVICE) if batch.get("session_emb") is not None else torch.zeros(art_emb.size(0), 64, device=DEVICE)
        scalar_feats = batch["scalar_feats"].to(DEVICE)

        a = F.gelu(self.article_proj(art_emb))
        s = F.gelu(self.session_proj(sess_emb))
        f = F.gelu(self.feat_fc(scalar_feats))
        x = torch.cat([a, s, f], dim=-1)

        enc = self.encoder(x)
        score = torch.sigmoid(self.score_head(enc))

        result = {
            "score": score,
            "trending": torch.sigmoid(self.trending_head(enc)),
            "local": torch.sigmoid(self.local_head(enc)),
            "quality": torch.sigmoid(self.quality_head(enc)),
            "freshness": torch.sigmoid(self.freshness_head(enc)),
        }

        if "label" in batch and batch["label"] is not None:
            labels = batch["label"].to(DEVICE)
            loss = F.binary_cross_entropy(score.squeeze(), labels)
            preds = (score > 0.5).squeeze().float()
            acc = (preds == labels).float().mean()
            result["loss"] = loss
            result["accuracy"] = acc.item()

        return result


# ── 6. Coverage Model ────────────────────────────────────────────────────────

class CoverageModel(nn.Module):
    """Predict coverage gap score for a country."""

    def __init__(self, country_emb_dim: int = EMBEDDING_DIM, hidden: int = 128):
        super().__init__()
        self.country_proj = nn.Linear(country_emb_dim, hidden)
        self.neighbor_proj = nn.Linear(32, hidden)  # neighbor gap scores
        self.feat_fc = nn.Sequential(
            nn.Linear(8, hidden),
            nn.GELU(),
        )
        self.fc = nn.Sequential(
            nn.Linear(hidden * 3, hidden),
            nn.GELU(),
            nn.LayerNorm(hidden),
            nn.Linear(hidden, hidden // 2),
            nn.GELU(),
        )
        self.gap_head = nn.Linear(hidden // 2, 1)
        self.conf_head = nn.Linear(hidden // 2, 1)

    def forward(self, batch: dict) -> dict:
        c_emb = batch["country_emb"].to(DEVICE)
        n_scores = batch["neighbor_scores"].to(DEVICE)
        feats = batch["scalar_feats"].to(DEVICE)

        c = F.gelu(self.country_proj(c_emb))
        n = F.gelu(self.neighbor_proj(n_scores))
        f = F.gelu(self.feat_fc(feats))
        x = torch.cat([c, n, f], dim=-1)
        x = self.fc(x)

        gap_score = self.gap_head(x)
        conf = torch.sigmoid(self.conf_head(x))

        result = {"gap_score": gap_score, "confidence": conf}

        if "label" in batch and batch["label"] is not None:
            labels = batch["label"].to(DEVICE)
            loss = F.mse_loss(gap_score.squeeze(), labels)
            result["loss"] = loss

        return result


# ── 7. Article Value Model ───────────────────────────────────────────────────
# Predicts how "valuable" an article is for AI treatment — used to prioritize
# which articles get full AI extraction vs lightweight regex extraction.
#
# Features:
#   - article_emb (16-dim): from article_understanding model
#   - source_reliability (1): from news_sources.reliability_score
#   - event_type_emb (8-dim): learned embedding for event_type
#   - geo_uniqueness (1): inverse frequency of source_country
#   - temporal_freshness (1): exponential decay from published_at
#   - has_location (1): whether auto_categorize found a city
#   - entity_novelty (1): ratio of novel entities
#   - topic_diversity (1): ratio of novel topics
#
# Output:
#   - value_score (1): sigmoid [0,1] — higher = more valuable
#   - engagement_head (1): predicted engagement (for future use)
#   - novelty_head (1): predicted novelty (for future use)

class ArticleValueModel(nn.Module):
    """Predict article value for AI treatment prioritization."""

    def __init__(self, text_dim: int = EMBEDDING_DIM, hidden: int = 128):
        super().__init__()
        self.article_proj = nn.Linear(text_dim, hidden)
        self.event_type_emb = nn.Embedding(15, 8)  # 14 event types + "other"
        self.feat_fc = nn.Linear(8 + 5, hidden)  # event_emb + scalar features
        self.encoder = nn.Sequential(
            nn.Linear(hidden * 2, hidden),
            nn.GELU(),
            nn.LayerNorm(hidden),
            nn.Dropout(0.1),
            nn.Linear(hidden, hidden // 2),
            nn.GELU(),
        )
        self.value_head = nn.Linear(hidden // 2, 1)
        self.engagement_head = nn.Linear(hidden // 2, 1)
        self.novelty_head = nn.Linear(hidden // 2, 1)

    def forward(self, batch: dict) -> dict:
        art_emb = batch["article_emb"].to(DEVICE)
        event_type_ids = batch["event_type_ids"].to(DEVICE)
        scalar_feats = batch["scalar_feats"].to(DEVICE)  # [batch, 5]

        a = F.gelu(self.article_proj(art_emb))
        e = self.event_type_emb(event_type_ids)  # [batch, 8]
        f = F.gelu(self.feat_fc(torch.cat([e, scalar_feats], dim=-1)))
        x = torch.cat([a, f], dim=-1)

        enc = self.encoder(x)
        value_score = torch.sigmoid(self.value_head(enc))
        engagement = torch.sigmoid(self.engagement_head(enc))
        novelty = torch.sigmoid(self.novelty_head(enc))

        labels = batch["label"].to(DEVICE)
        loss = F.binary_cross_entropy(value_score.squeeze(), labels)

        preds = (value_score > 0.5).squeeze().float()
        acc = (preds == labels).float().mean()

        return {
            "loss": loss,
            "value_score": value_score,
            "engagement": engagement,
            "novelty": novelty,
            "accuracy": acc.item(),
        }


# ── Training utilities ────────────────────────────────────────────────────────

def build_optimizer(model: nn.Module, lr: float = LEARNING_RATE) -> tuple[torch.optim.Optimizer, Any]:
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    return optimizer, None


def lr_lambda(step: int, total_steps: int) -> float:
    if step < WARMUP_STEPS:
        return step / max(WARMUP_STEPS, 1)
    progress = (step - WARMUP_STEPS) / max(total_steps - WARMUP_STEPS, 1)
    return 0.5 * (1 + math.cos(math.pi * progress))


def train_epoch(model: nn.Module, loader: DataLoader, optimizer: torch.optim.Optimizer,
                scaler: Any, step: int) -> tuple[float, int]:
    model.train()
    total_loss = 0.0
    n = 0
    optimizer.zero_grad()
    use_amp = DEVICE.type == "cuda"

    for batch_idx, batch in enumerate(loader):
        if use_amp:
            with autocast():
                out = model(batch)
                loss = out["loss"] / GRAD_ACCUM
            scaler.scale(loss).backward()
        else:
            out = model(batch)
            loss = out["loss"] / GRAD_ACCUM
            loss.backward()

        if (batch_idx + 1) % GRAD_ACCUM == 0:
            if use_amp:
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
            else:
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
            optimizer.zero_grad()
            step += 1

        total_loss += out["loss"].item()
        n += 1

    return total_loss / max(n, 1), step


@torch.no_grad()
def eval_model(model: nn.Module, loader: DataLoader) -> dict:
    model.eval()
    total_loss = 0.0
    total_acc = 0.0
    n = 0
    for batch in loader:
        with autocast():
            out = model(batch)
        total_loss += out["loss"].item()
        total_acc += out.get("accuracy", out.get("relation_acc", 0.0))
        n += 1
    return {"loss": total_loss / max(n, 1), "accuracy": total_acc / max(n, 1)}


# ── Model training functions ─────────────────────────────────────────────────

def train_article_understanding(cycle_id: str, dataset_hash: str | None, epochs: int) -> dict:
    log.info("Training article_understanding")
    with connect() as conn:
        cur = conn.cursor()
        if dataset_hash:
            cur.execute("""
                SELECT entity_id, features_jsonb, label, label_aux
                FROM nn_training_features
                WHERE model_name = 'article_understanding'
                  AND dataset_hash = %s
                  AND label IS NOT NULL
                LIMIT 20000
            """, (dataset_hash,))
        else:
            cur.execute("""
                SELECT entity_id, features_jsonb, label, label_aux
                FROM nn_training_features
                WHERE model_name = 'article_understanding'
                  AND label IS NOT NULL
                ORDER BY snapshot_at DESC
                LIMIT 20000
            """)
        rows = list(cur.fetchall())
        triplets = _build_triplets(rows, conn=conn)

    if len(rows) < 50:
        log.warning("Not enough labeled data for article_understanding: %d rows", len(rows))
        return {"skipped": True, "reason": "insufficient_labels", "rows": len(rows)}

    if not triplets:
        log.warning("No valid triplets built from %d labeled rows", len(rows))
        return {"skipped": True, "reason": "no_triplets", "rows": len(rows)}

    model = ArticleUnderstanding().to(DEVICE)
    optimizer, _ = build_optimizer(model)
    scaler = GradScaler(enabled=DEVICE.type == "cuda")

    ds = TripletDataset(triplets)
    loader = DataLoader(ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=0)
    total_steps = len(loader) * epochs

    run_id = _start_training_run(cycle_id, "article_understanding", dataset_hash, len(rows))
    best_loss = float("inf")
    patience_counter = 0
    step = 0

    for epoch in range(epochs):
        loss, step = train_epoch(model, loader, optimizer, scaler, step)
        log.info("  epoch %d loss=%.4f", epoch + 1, loss)
        if loss < best_loss - 1e-4:
            best_loss = loss
            patience_counter = 0
            version = _save_model(model, "article_understanding")
        else:
            patience_counter += 1
            if patience_counter >= PATIENCE:
                log.info("Early stopping at epoch %d", epoch + 1)
                break

    _finish_training_run(run_id, {"final_loss": best_loss})
    return {"model": "article_understanding", "final_loss": best_loss, "version": version}


class TripletDataset(Dataset):
    def __init__(self, triplets: list[dict]):
        self.triplets = triplets

    def __len__(self) -> int:
        return len(self.triplets)

    def __getitem__(self, idx: int) -> dict:
        t = self.triplets[idx]
        return {
            "anchors":    [t["anchor"]],
            "positives":  [t["positive"]],
            "negatives":  [t["negative"]],
            "label": torch.tensor(1.0),
        }


def _build_triplets(rows: list[dict], conn=None) -> list[dict]:
    """Build triplets from labeled data.
    
    Supports two formats:
    1. Legacy: articles with same entity_id grouped together
    2. Auto-labeled: label_aux contains anchor_id, positive_id, negative_id
    """
    # Check if we have auto-labeled triplets in label_aux
    auto_labeled = [r for r in rows if r.get("label_aux") and "anchor_id" in r.get("label_aux", {})]
    
    if auto_labeled:
        # Build a lookup from entity_id to features_jsonb
        by_entity = {r["entity_id"]: r["features_jsonb"] for r in rows}
        
        # Collect all referenced IDs that aren't in our sample
        needed_ids = set()
        for r in auto_labeled:
            aux = r["label_aux"]
            for key in ("anchor_id", "positive_id", "negative_id"):
                rid = aux.get(key)
                if rid and rid not in by_entity:
                    needed_ids.add(rid)
        
        # Fetch missing features from DB
        if needed_ids and conn:
            cur2 = conn.cursor()
            cur2.execute("""
                SELECT entity_id, features_jsonb FROM nn_training_features
                WHERE model_name = 'article_understanding' AND entity_id = ANY(%s)
            """, (list(needed_ids),))
            for r in cur2.fetchall():
                by_entity[r["entity_id"]] = r["features_jsonb"]
            cur2.close()
        
        triplets = []
        for r in auto_labeled:
            aux = r["label_aux"]
            anchor_id = aux["anchor_id"]
            positive_id = aux["positive_id"]
            negative_id = aux["negative_id"]
            
            anchor_feat = by_entity.get(anchor_id, {})
            positive_feat = by_entity.get(positive_id, {})
            negative_feat = by_entity.get(negative_id, {})
            
            anchor_text = f"{anchor_feat.get('title','')} {anchor_feat.get('body','')[:200]}"
            positive_text = f"{positive_feat.get('title','')} {positive_feat.get('body','')[:200]}"
            negative_text = f"{negative_feat.get('title','')} {negative_feat.get('body','')[:200]}"
            
            if anchor_text.strip() and positive_text.strip() and negative_text.strip():
                triplets.append({"anchor": anchor_text, "positive": positive_text, "negative": negative_text})
        
        return triplets
    
    # Legacy format: group by entity_id
    by_entity = {}
    for r in rows:
        by_entity.setdefault(r["entity_id"], []).append(r)

    triplets = []
    for entity_id, examples in by_entity.items():
        if len(examples) < 2:
            continue
        for i, anchor_row in enumerate(examples):
            pos_row = examples[(i + 1) % len(examples)]
            neg_row = next((x for x in rows if x["entity_id"] != entity_id), None)
            if neg_row is None:
                continue
            anchor_text = f"{anchor_row['features_jsonb'].get('title','')} {anchor_row['features_jsonb'].get('body','')[:200]}"
            pos_text = f"{pos_row['features_jsonb'].get('title','')} {pos_row['features_jsonb'].get('body','')[:200]}"
            neg_text = f"{neg_row['features_jsonb'].get('title','')} {neg_row['features_jsonb'].get('body','')[:200]}"
            triplets.append({"anchor": anchor_text, "positive": pos_text, "negative": neg_text})
    return triplets


def train_entity_extraction(cycle_id: str, dataset_hash: str | None, epochs: int) -> dict:
    log.info("Training entity_extraction")
    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT entity_id, features_jsonb, label, label_aux
            FROM nn_training_features
            WHERE model_name = 'entity_extraction'
              AND label IS NOT NULL
            ORDER BY snapshot_at DESC
            LIMIT 30000
        """)
        rows = list(cur.fetchall())

    if len(rows) < 50:
        return {"skipped": True, "reason": "insufficient_labels", "rows": len(rows)}

    tokens_list, labels_list = _tokenize_entity(rows)
    model = EntityExtractor().to(DEVICE)
    optimizer, _ = build_optimizer(model)
    scaler = GradScaler()
    ds = EntityDataset(tokens_list, labels_list)
    loader = DataLoader(ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=0)
    total_steps = len(loader) * epochs

    run_id = _start_training_run(cycle_id, "entity_extraction", dataset_hash, len(rows))
    best_loss = float("inf")
    patience_counter = 0
    step = 0
    version = "0.0.1"

    for epoch in range(epochs):
        loss, step = train_epoch(model, loader, optimizer, scaler, step)
        log.info("  epoch %d loss=%.4f", epoch + 1, loss)
        if loss < best_loss - 1e-4:
            best_loss = loss
            patience_counter = 0
            version = _save_model(model, "entity_extraction")
        else:
            patience_counter += 1
            if patience_counter >= PATIENCE:
                break

    _finish_training_run(run_id, {"final_loss": best_loss})
    return {"model": "entity_extraction", "final_loss": best_loss, "version": version}


class EntityDataset(Dataset):
    def __init__(self, tokens_list: list, labels_list: list):
        self.tokens_list = tokens_list
        self.labels_list = labels_list

    def __len__(self) -> int:
        return len(self.tokens_list)

    def __getitem__(self, idx: int) -> dict:
        return {
            "tokens": torch.tensor(self.tokens_list[idx], dtype=torch.long),
            "labels": torch.tensor(self.labels_list[idx], dtype=torch.long),
            "mask": torch.ones(len(self.tokens_list[idx]), dtype=torch.float),
        }


def _tokenize_entity(rows: list[dict]) -> tuple[list, list]:
    tokens_list, labels_list = [], []
    for r in rows:
        text = f"{r['features_jsonb'].get('title','')} {r['features_jsonb'].get('body','')[:300]}"
        words = text.lower().split()[:64]
        indices = [abs(hash(w)) % 8192 for w in words]
        aux = r.get("label_aux") or {}
        bio_labels = aux.get("bio_labels", [0] * len(words))
        tokens_list.append(indices + [0] * max(0, 64 - len(indices)))
        labels_list.append(bio_labels + [0] * max(0, 64 - len(bio_labels)))
    return tokens_list, labels_list


def train_event_matching(cycle_id: str, dataset_hash: str | None, epochs: int) -> dict:
    log.info("Training event_matching")
    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT entity_id, features_jsonb, label
            FROM nn_training_features
            WHERE model_name = 'event_matching'
              AND label IS NOT NULL
            ORDER BY snapshot_at DESC
            LIMIT 30000
        """)
        rows = list(cur.fetchall())

    if len(rows) < 50:
        return {"skipped": True, "reason": "insufficient_labels", "rows": len(rows)}

    article_model = ArticleUnderstanding().to(DEVICE)
    model = EventMatcher(article_model).to(DEVICE)
    optimizer, _ = build_optimizer(model)
    scaler = GradScaler()
    ds = EventMatchDataset(rows)
    loader = DataLoader(ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=0)

    run_id = _start_training_run(cycle_id, "event_matching", dataset_hash, len(rows))
    best_loss = float("inf")
    patience_counter = 0
    step = 0
    version = "0.0.1"

    for epoch in range(epochs):
        loss, step = train_epoch(model, loader, optimizer, scaler, step)
        log.info("  epoch %d loss=%.4f", epoch + 1, loss)
        if loss < best_loss - 1e-4:
            best_loss = loss
            patience_counter = 0
            version = _save_model(model, "event_matching")
        else:
            patience_counter += 1
            if patience_counter >= PATIENCE:
                break

    _finish_training_run(run_id, {"final_loss": best_loss})
    return {"model": "event_matching", "final_loss": best_loss, "version": version}


class EventMatchDataset(Dataset):
    def __init__(self, rows: list[dict]):
        self.rows = rows

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, idx: int) -> dict:
        r = self.rows[idx]
        f = r["features_jsonb"]
        return {
            "title_a": [f.get("title_a", "")],
            "title_b": [f.get("title_b", "")],
            "label": torch.tensor(r.get("label", 0.0), dtype=torch.float32),
        }


def train_relationship(cycle_id: str, dataset_hash: str | None, epochs: int) -> dict:
    log.info("Training relationship")
    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT entity_id, features_jsonb, label, label_aux
            FROM nn_training_features
            WHERE model_name = 'relationship'
              AND label IS NOT NULL
            ORDER BY snapshot_at DESC
            LIMIT 20000
        """)
        rows = list(cur.fetchall())

    if len(rows) < 50:
        return {"skipped": True, "reason": "insufficient_labels", "rows": len(rows)}

    article_model = ArticleUnderstanding().to(DEVICE)
    model = RelationshipModel(article_model).to(DEVICE)
    optimizer, _ = build_optimizer(model)
    scaler = GradScaler()
    ds = RelationDataset(rows)
    loader = DataLoader(ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=0)

    run_id = _start_training_run(cycle_id, "relationship", dataset_hash, len(rows))
    best_loss = float("inf")
    patience_counter = 0
    step = 0
    version = "0.0.1"

    for epoch in range(epochs):
        loss, step = train_epoch(model, loader, optimizer, scaler, step)
        log.info("  epoch %d loss=%.4f", epoch + 1, loss)
        if loss < best_loss - 1e-4:
            best_loss = loss
            patience_counter = 0
            version = _save_model(model, "relationship")
        else:
            patience_counter += 1
            if patience_counter >= PATIENCE:
                break

    _finish_training_run(run_id, {"final_loss": best_loss})
    return {"model": "relationship", "final_loss": best_loss, "version": version}


class RelationDataset(Dataset):
    def __init__(self, rows: list[dict]):
        self.rows = rows

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, idx: int) -> dict:
        r = self.rows[idx]
        f = r["features_jsonb"]
        aux = r.get("label_aux") or {}
        return {
            "src_title":  [f.get("src_title", "")],
            "dst_title":  [f.get("dst_title", "")],
            "edge_type_idx": torch.tensor([1], dtype=torch.long),
            "relation_label": torch.tensor(aux.get("relation_idx", 0), dtype=torch.long),
            "score_label": torch.tensor(r.get("label", 0.5), dtype=torch.float32),
        }


def train_ranking(cycle_id: str, dataset_hash: str | None, epochs: int) -> dict:
    log.info("Training ranking")
    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT entity_id, features_jsonb, label
            FROM nn_training_features
            WHERE model_name = 'ranking'
              AND label IS NOT NULL
            ORDER BY snapshot_at DESC
            LIMIT 50000
        """)
        rows = list(cur.fetchall())

    if len(rows) < 50:
        return {"skipped": True, "reason": "insufficient_labels", "rows": len(rows)}

    model = RankingModel().to(DEVICE)
    optimizer, _ = build_optimizer(model)
    scaler = GradScaler()
    ds = RankingDataset(rows)
    loader = DataLoader(ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=0)

    run_id = _start_training_run(cycle_id, "ranking", dataset_hash, len(rows))
    best_loss = float("inf")
    patience_counter = 0
    step = 0
    version = "0.0.1"

    for epoch in range(epochs):
        loss, step = train_epoch(model, loader, optimizer, scaler, step)
        log.info("  epoch %d loss=%.4f", epoch + 1, loss)
        if loss < best_loss - 1e-4:
            best_loss = loss
            patience_counter = 0
            version = _save_model(model, "ranking")
        else:
            patience_counter += 1
            if patience_counter >= PATIENCE:
                break

    _finish_training_run(run_id, {"final_loss": best_loss})
    return {"model": "ranking", "final_loss": best_loss, "version": version}


class RankingDataset(Dataset):
    FEAT_KEYS = [
        "source_quality", "freshness", "velocity_clicks", "velocity_views",
        "accel_clicks", "event_source_count", "country_match", "topic_match",
        "unique_sources_24h", "session_total_interactions", "local_relevance", "has_embedding",
        # Zoom-level features (zoom >= 10 = city-level intent signal)
        "high_zoom_views", "avg_zoom_depth", "zoom_view_duration_ms", "unique_cities_viewed",
        "city_zoom_score", "city_view_count",
        # Content quality signals (byline, contact, readability)
        "has_byline", "has_contact_info", "readability_score",
    ]

    def __init__(self, rows: list[dict]):
        self.rows = rows

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, idx: int) -> dict:
        r = self.rows[idx]
        f = r["features_jsonb"]
        feats = []
        for k in self.FEAT_KEYS:
            v = f.get(k, 0.0)
            if k == "has_embedding":
                v = 1.0 if f.get("article_embedding") else 0.0
            feats.append(float(v))
        return {
            "article_emb": torch.zeros(EMBEDDING_DIM),
            "session_emb": torch.zeros(64),
            "scalar_feats": torch.tensor(feats, dtype=torch.float32),
            "label": torch.tensor(r.get("label", 0.5), dtype=torch.float32),
        }


def train_coverage(cycle_id: str, dataset_hash: str | None, epochs: int) -> dict:
    log.info("Training coverage")
    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT entity_id, features_jsonb, label
            FROM nn_training_features
            WHERE model_name = 'coverage'
              AND label IS NOT NULL
            ORDER BY snapshot_at DESC
            LIMIT 5000
        """)
        rows = list(cur.fetchall())

    if len(rows) < 20:
        return {"skipped": True, "reason": "insufficient_labels", "rows": len(rows)}

    model = CoverageModel().to(DEVICE)
    optimizer, _ = build_optimizer(model)
    scaler = GradScaler()
    ds = CoverageDataset(rows)
    loader = DataLoader(ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=0)

    run_id = _start_training_run(cycle_id, "coverage", dataset_hash, len(rows))
    best_loss = float("inf")
    patience_counter = 0
    step = 0
    version = "0.0.1"

    for epoch in range(epochs):
        loss, step = train_epoch(model, loader, optimizer, scaler, step)
        log.info("  epoch %d loss=%.4f", epoch + 1, loss)
        if loss < best_loss - 1e-4:
            best_loss = loss
            patience_counter = 0
            version = _save_model(model, "coverage")
        else:
            patience_counter += 1
            if patience_counter >= PATIENCE:
                break

    _finish_training_run(run_id, {"final_loss": best_loss})
    return {"model": "coverage", "final_loss": best_loss, "version": version}


class CoverageDataset(Dataset):
    FEAT_KEYS = [
        "population", "active_sources", "articles_24h", "events_24h",
        "events_per_million", "classical_gap_score", "lat_norm", "lng_norm",
    ]

    def __init__(self, rows: list[dict]):
        self.rows = rows

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, idx: int) -> dict:
        r = self.rows[idx]
        f = r["features_jsonb"]
        feats = []
        for k in self.FEAT_KEYS:
            v = f.get(k, 0.0)
            if k in ("lat_norm", "lng_norm"):
                if k == "lat_norm":
                    v = (f.get("lat") or 0) / 90
                else:
                    v = (f.get("lng") or 0) / 180
            feats.append(float(v))
        neighbor_scores = f.get("neighbor_gap_scores", [])[:32]
        neighbor_scores = neighbor_scores + [0.0] * max(0, 32 - len(neighbor_scores))
        return {
            "country_emb": torch.zeros(EMBEDDING_DIM),
            "neighbor_scores": torch.tensor(neighbor_scores[:32], dtype=torch.float32),
            "scalar_feats": torch.tensor(feats, dtype=torch.float32),
            "label": torch.tensor(r.get("label", f.get("classical_gap_score", 0.0)), dtype=torch.float32),
        }


# ── Registry helpers ─────────────────────────────────────────────────────────

def _start_training_run(cycle_id: str, model_name: str, dataset_hash: str | None, rows: int) -> int:
    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO nn_training_runs (cycle_id, model_name, dataset_hash, rows_total, status)
            VALUES (%s, %s, %s, %s, 'running')
            RETURNING id
        """, (cycle_id, model_name, dataset_hash, rows))
        run_id = cur.fetchone()["id"]
        conn.commit()
    return run_id


def _finish_training_run(run_id: int, metrics: dict) -> None:
    with connect() as conn:
        cur = conn.cursor()
        # Get the model name from the training run
        cur.execute("SELECT model_name FROM nn_training_runs WHERE id = %s", (run_id,))
        row = cur.fetchone()
        if row:
            model_name = row["model_name"]
            # Activate the latest version of this model
            cur.execute("""
                UPDATE nn_model_registry SET is_active = FALSE
                WHERE model_name = %s
            """, (model_name,))
            cur.execute("""
                UPDATE nn_model_registry SET is_active = TRUE
                WHERE model_name = %s
                  AND version = (
                      SELECT version FROM nn_model_registry
                      WHERE model_name = %s ORDER BY trained_at DESC LIMIT 1
                  )
            """, (model_name, model_name))
        cur.execute("""
            UPDATE nn_training_runs
            SET status = 'completed', finished_at = now(),
                final_loss = %s, final_metrics = %s
            WHERE id = %s
        """, (metrics.get("final_loss"), json.dumps(metrics), run_id))
        conn.commit()


def _save_model(model: nn.Module, model_name: str) -> str:
    version = f"0.{datetime.now(timezone.utc):%Y%m%d}"
    artifact_dir = MODEL_DIR / model_name / version
    artifact_dir.mkdir(parents=True, exist_ok=True)
    artifact_path = artifact_dir / "model.pt"

    # Only save state dict for portability
    state = {k: v.cpu().half() if isinstance(v, torch.Tensor) else v
             for k, v in model.state_dict().items()}
    torch.save(state, artifact_path)

    import hashlib
    with open(artifact_path, "rb") as f:
        file_sha256 = hashlib.sha256(f.read()).hexdigest()

    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO nn_model_registry
                (model_name, version, dataset_hash, architecture,
                 hyperparameters, feature_schema, metrics,
                 artifact_path, artifact_sha256, artifact_bytes, is_active)
            VALUES (%s, %s, NULL, %s, %s, %s, %s, %s, %s, %s, FALSE)
            ON CONFLICT (model_name, version) DO UPDATE SET
                artifact_sha256 = EXCLUDED.artifact_sha256,
                artifact_bytes = EXCLUDED.artifact_bytes,
                is_active = FALSE
        """, (
            model_name, version,
            _architecture_for_model(model_name),
            json.dumps({"lr": LEARNING_RATE, "batch_size": BATCH_SIZE}),
            json.dumps({}),
            json.dumps({}),
            str(artifact_path),
            file_sha256,
            artifact_path.stat().st_size,
        ))
        conn.commit()

    log.info("Saved %s v%s to %s", model_name, version, artifact_path)
    return version


def _architecture_for_model(model_name: str) -> str:
    return {
        "article_understanding": "text-encoder-triplet",
        "entity_extraction":    "cnn1d-bio",
        "event_matching":       "siamese-cosine",
        "relationship":         "siamese-edge-mlp",
        "ranking":              "mlp-session-features",
        "coverage":             "mlp-country-gap",
    }.get(model_name, "mlp")


# ── Orchestrator ──────────────────────────────────────────────────────────────

TRAINERS = {
    "article_understanding": train_article_understanding,
    "entity_extraction":     train_entity_extraction,
    "event_matching":        train_event_matching,
    "relationship":          train_relationship,
    "ranking":               train_ranking,
    "coverage":              train_coverage,
}


def train_all(cycle_id: str | None = None, dataset_hash: str | None = None,
              epochs: int = EPOCHS_DEFAULT, only: str | None = None) -> dict:
    cycle_id = cycle_id or f"train_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}_{uuid.uuid4().hex[:6]}"
    log.info("Training cycle %s", cycle_id)

    results = {}
    models = [only] if only else list(TRAINERS.keys())

    for model_name in models:
        trainer = TRAINERS.get(model_name)
        if not trainer:
            log.warning("Unknown model: %s", model_name)
            continue
        try:
            result = trainer(cycle_id, dataset_hash, epochs)
            results[model_name] = result
        except Exception as e:
            log.exception("Training %s failed: %s", model_name, e)
            results[model_name] = {"error": str(e)}

    return {"cycle_id": cycle_id, "results": results}


# ── CLI ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Xyzo NN training")
    p.add_argument("--cycle-id", help="Override cycle_id")
    p.add_argument("--dataset-hash", help="Train on a specific dataset snapshot")
    p.add_argument("--epochs", type=int, default=EPOCHS_DEFAULT)
    p.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    p.add_argument("--only", choices=list(TRAINERS.keys()), help="Train one model")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    out = train_all(
        cycle_id=args.cycle_id,
        dataset_hash=args.dataset_hash,
        epochs=args.epochs,
        only=args.only,
    )
    json.dump(out, sys.stdout, default=str)
    sys.stdout.write("\n")
