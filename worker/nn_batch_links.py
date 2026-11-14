#!/usr/bin/env python3
"""
Batch NN Link Generator

Runs the relationship model on recent articles and writes predictions
to news_story_links for the Links UI.

This makes the Links feature much smarter by using the NN model
instead of just rule-based matching.

Usage:
    python -m worker.nn_batch_links --dry-run      # Count pairs without writing
    python -m worker.nn_batch_links --run        # Generate and write links
    python -m worker.nn_batch_links --cleanup    # Remove old nn_detected links
"""
import argparse
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from worker.db import connect
from worker import nn_train

log = logging.getLogger("xyzo.nn_batch_links")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

DEVICE = torch.device("cpu")
RELATION_CLASSES = [
    "same_story", "related", "follow_up", "response", "background",
    "origin", "destination", "mentioned",
]


class ArticlePairDataset(Dataset):
    """Dataset for article pairs with embeddings."""

    FEAT_KEYS = [
        "cosine_sim", "jaccard_entity", "same_country", "same_city",
        "time_diff_h", "src_rank", "dst_rank", "src_sources", "dst_sources",
        "src_event_type_match", "dst_event_type_match",
    ]

    def __init__(self, pairs):
        self.pairs = pairs

    def __len__(self):
        return len(self.pairs)

    def __getitem__(self, idx):
        p = self.pairs[idx]
        return {
            "src_emb": torch.tensor(p["src_emb"]),
            "dst_emb": torch.tensor(p["dst_emb"]),
            "scalar_feats": torch.tensor(p["scalar_feats"], dtype=torch.float32),
        }


def collate_fn(batch):
    return {
        "src_emb": torch.stack([b["src_emb"] for b in batch]),
        "dst_emb": torch.stack([b["dst_emb"] for b in batch]),
        "scalar_feats": torch.stack([b["scalar_feats"] for b in batch]),
    }


def get_recent_articles_with_embeddings(hours=48, limit=5000):
    """Get recent articles with their embeddings."""

    with connect() as conn:
        cur = conn.cursor()

        cur.execute(f"""
            SELECT a.id AS article_id,
                   a.title,
                   a.event_type,
                   a.published_at,
                   s.country AS source_country,
                   e.vector
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            JOIN nn_article_embeddings e ON e.article_id = a.id
            WHERE a.status = 'extracted'
              AND a.fetched_at > NOW() - INTERVAL '{hours} hours'
              AND e.model_version = (
                  SELECT model_version FROM nn_model_registry
                  WHERE model_name = 'article_understanding' AND is_active = TRUE
                  LIMIT 1
              )
            ORDER BY a.fetched_at DESC
            LIMIT {limit}
        """)

        rows = cur.fetchall()

    articles = {}
    for r in rows:
        try:
            vec_str = str(r["vector"]).strip("[]")
            vector = [float(x) for x in vec_str.split(",")]
        except (ValueError, AttributeError):
            continue

        articles[r["article_id"]] = {
            "id": r["article_id"],
            "title": r["title"],
            "event_type": r["event_type"],
            "source_country": r["source_country"],
            "published_at": r["published_at"],
            "source_count": 1,
            "vector": vector,
        }

    return articles


def generate_candidate_pairs(articles, max_pairs_per_article=20):
    """Generate candidate pairs smartly - prioritize by similarity indicators."""

    article_list = list(articles.values())
    pairs = []
    seen = set()

    for i, a in enumerate(article_list):
        if i % 500 == 0:
            log.info(f"  Processing article {i}/{len(article_list)}")

        candidates = []

        for j, b in enumerate(article_list):
            if i >= j:
                continue
            if a["id"] == b["id"]:
                continue

            pair_key = (min(a["id"], b["id"]), max(a["id"], b["id"]))
            if pair_key in seen:
                continue

            same_country = 1.0 if a["source_country"] == b["source_country"] else 0.0
            same_event_type = 1.0 if a["event_type"] == b["event_type"] else 0.0

            if same_country < 0.5 and same_event_type < 0.5:
                continue

            try:
                time_diff_h = abs((a["published_at"] - b["published_at"]).total_seconds() / 3600)
                time_diff_h = min(time_diff_h / 48.0, 5.0)
            except (TypeError, AttributeError):
                time_diff_h = 0.5

            cosine_sim = sum(av * bv for av, bv in zip(a["vector"][:16], b["vector"][:16]))

            scalar_feats = [
                cosine_sim,
                0.0,
                same_country,
                0.0,
                time_diff_h,
                0.0,
                0.0,
                min(a["source_count"] / 100.0, 5.0),
                min(b["source_count"] / 100.0, 5.0),
                same_event_type,
                0.0,
            ]

            candidates.append({
                "src_id": a["id"],
                "dst_id": b["id"],
                "src_emb": a["vector"][:16],
                "dst_emb": b["vector"][:16],
                "scalar_feats": scalar_feats,
                "cosine_sim": cosine_sim,
            })
            seen.add(pair_key)

        candidates.sort(key=lambda x: x["cosine_sim"], reverse=True)
        pairs.extend(candidates[:max_pairs_per_article])

    return pairs


def run_inference(pairs, model, batch_size=128):
    """Run relationship inference on pairs."""

    dataset = ArticlePairDataset(pairs)
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, collate_fn=collate_fn)

    results = []
    with torch.no_grad():
        for batch in loader:
            out = model({
                "src_emb": batch["src_emb"].to(DEVICE),
                "dst_emb": batch["dst_emb"].to(DEVICE),
                "scalar_feats": batch["scalar_feats"].to(DEVICE),
            })

            scores = out["score"].cpu().tolist()
            rel_indices = out["relation_logits"].argmax(dim=1).cpu().tolist()

            for i in range(len(scores)):
                idx = len(results)
                if idx < len(pairs):
                    results.append({
                        "src_id": pairs[idx]["src_id"],
                        "dst_id": pairs[idx]["dst_id"],
                        "score": scores[i],
                        "relation": RELATION_CLASSES[rel_indices[i]],
                        "cosine_sim": pairs[idx]["cosine_sim"],
                    })

    return results


def write_links_to_db(predictions, min_score=0.7, dry_run=True):
    """Write NN predictions to news_story_links."""

    link_type = "ai_detected"
    count_written = 0

    if dry_run:
        log.info(f"  Would write {len([p for p in predictions if p['score'] >= min_score])} links (score >= {min_score})")
        return 0

    with connect() as conn:
        cur = conn.cursor()

        for p in predictions:
            if p["score"] < min_score:
                continue

            try:
                cur.execute("""
                    INSERT INTO news_story_links
                        (source_article_id, target_article_id, link_type, link_strength, link_reason, created_by)
                    VALUES (%s, %s, %s, %s, %s, 'nn_model')
                    ON CONFLICT (source_article_id, target_article_id, link_type)
                    DO UPDATE SET
                        link_strength = EXCLUDED.link_strength,
                        link_reason = EXCLUDED.link_reason,
                        updated_at = NOW()
                """, (
                    p["src_id"],
                    p["dst_id"],
                    link_type,
                    p["score"],
                    f"NN: {p['relation']} (cosine={p['cosine_sim']:.3f})"
                ))
                count_written += 1
            except Exception as e:
                log.debug(f"  Skip pair {p['src_id']}-{p['dst_id']}: {e}")

        conn.commit()

    return count_written


def cleanup_old_links(days=7, dry_run=True):
    """Remove old ai_detected links (FIX_NOTES 7.6: was 'ai_related'
    while the writer emits 'ai_detected' — generated links were immortal)."""

    with connect() as conn:
        cur = conn.cursor()

        if dry_run:
            cur.execute(f"""
                SELECT COUNT(*) FROM news_story_links
                WHERE link_type = 'ai_detected'
                  AND created_at < NOW() - INTERVAL '{days} days'
            """)
            count = cur.fetchone()[0]
            log.info(f"  Would delete {count} old ai_detected links")
            return count

        cur.execute(f"""
            DELETE FROM news_story_links
            WHERE link_type = 'ai_detected'
              AND created_at < NOW() - INTERVAL '{days} days'
        """)
        conn.commit()
        return cur.rowcount


def main():
    parser = argparse.ArgumentParser(description="Batch NN Link Generator")
    parser.add_argument("--dry-run", dest="dry_run", action="store_true", help="Count only, don't write")
    parser.add_argument("--run", dest="run", action="store_true", help="Generate and write links")
    parser.add_argument("--cleanup", action="store_true", help="Remove old ai_detected links")
    parser.add_argument("--hours", type=int, default=48, help="Hours of articles to consider")
    parser.add_argument("--limit", type=int, default=5000, help="Max articles to process")
    parser.add_argument("--min-score", type=float, default=0.7, help="Minimum score threshold")
    parser.add_argument("--max-pairs", type=int, default=20, help="Max pairs per article")
    args = parser.parse_args()

    if args.cleanup:
        log.info("=== Cleanup Old NN Links ===")
        cleanup_old_links(dry_run=args.dry_run)
        return

    if not args.run and not args.dry_run:
        log.info("Use --dry-run to count or --run to generate links")
        return

    log.info("=== Batch NN Link Generation ===")
    log.info(f"  Hours: {args.hours}, Limit: {args.limit}, Max pairs/article: {args.max_pairs}")

    log.info("Step 1: Loading articles with embeddings...")
    articles = get_recent_articles_with_embeddings(hours=args.hours, limit=args.limit)
    log.info(f"  Loaded {len(articles)} articles")

    if len(articles) < 2:
        log.warning("Not enough articles with embeddings")
        return

    log.info("Step 2: Generating candidate pairs...")
    pairs = generate_candidate_pairs(articles, max_pairs_per_article=args.max_pairs)
    log.info(f"  Generated {len(pairs)} candidate pairs")

    if not pairs:
        log.warning("No candidate pairs generated")
        return

    log.info("Step 3: Loading relationship model...")
    # FIX_NOTES 7.6: the model directory was hardcoded to
    # phase5_20260925_160725 — first retrain FileNotFoundError'd the
    # 15-min timer. Resolve the newest phase5_* dir containing model.pt.
    model_root = Path(os.environ.get("XYZO_MODEL_DIR", "/var/www/vhosts/xyzo.org/data/nn_models")) / "relationship"
    candidates = sorted(model_root.glob("phase5_*/model.pt"), key=lambda m: m.stat().st_mtime)
    if not candidates:
        raise FileNotFoundError(f"no phase5_* relationship model under {model_root}")
    model_pt = candidates[-1]
    log.info(f"  Using relationship model: {model_pt}")
    model = nn_train.SimpleRelationshipModel().to(DEVICE)
    state = torch.load(model_pt, weights_only=True)
    model.load_state_dict(state, strict=False)
    model.eval()
    log.info("  Model loaded")

    log.info("Step 4: Running inference...")
    predictions = run_inference(pairs, model)
    log.info(f"  Got {len(predictions)} predictions")

    good_preds = [p for p in predictions if p["score"] >= args.min_score]
    log.info(f"  {len(good_preds)} predictions with score >= {args.min_score}")

    log.info("Step 5: Writing to database...")
    count = write_links_to_db(predictions, min_score=args.min_score, dry_run=args.dry_run)
    log.info(f"  {'Would write' if args.dry_run else 'Wrote'} {count} links")

    log.info("Done!")


if __name__ == "__main__":
    main()
