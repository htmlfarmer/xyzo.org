"""Xyzo neural network online inference.

Loads the latest active model from nn_model_registry and runs predictions
against fresh articles/events, writing results to the NN cache tables.

Inference pipeline
─────────────────
1. article_understanding  → nn_article_embeddings (and nn_event_embeddings)
2. event_matching         → nn_event_pair_predictions
3. relationship           → nn_event_relationships
4. ranking                → nn_prediction_cache (ranking)
5. coverage               → nn_prediction_cache (coverage)

Note: there is no geolocation model. The NN geolocation head was removed
2026-10-26 — it never placed an article (its predictions were written to
nn_prediction_cache and read by nothing), it trained on zero text vectors,
and the classical pipeline (auto_categorize → extract → geocode →
place_disambiguation) places 95%+ of articles. Do not reintroduce it
without a real held-out evaluation and a write-back path into
news_articles.extracted_lat/lng.

Design decisions
───────────────
- Models loaded lazily on first use (avoid GPU memory waste if model not needed).
- article_understanding is run first; its embeddings are cached in PG and re-used
  by models 3-6 so we never re-encode the same text twice.
- Batch inference: up to 200 articles per call, 20 per CUDA batch.
- Predictions are cached with a TTL (default 6h for articles, 24h for coverage).
- Cache invalidation: if input_hash changed for an article, re-encode regardless of TTL.
- nn_infer is idempotent — re-running overwrites with latest model version.

Run
---
    python -m worker.nn_infer                       # all models
    python -m worker.infer --only article_understanding
    python -m worker.nn_infer --limit 500
    python -m worker.nn_infer --dry-run             # count only, no DB writes
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import signal
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F
from torch.cuda.amp import autocast

from .db import connect

log = logging.getLogger("xyzo.nn_infer")

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
MODEL_DIR = Path(os.environ.get("XYZO_MODEL_DIR", "/var/www/vhosts/xyzo.org/data/nn_models"))
EMBEDDING_DIM = 16
INFER_BATCH = 200
TTL_ARTICLE_H = 6
TTL_COVERAGE_H = 24

MODEL_REGISTRY: dict[str, Any] = {}


# ── Model loading ─────────────────────────────────────────────────────────────

def load_model(model_name: str, version: str | None = None) -> tuple[torch.nn.Module, str]:
    """Lazily load a model from the registry or disk. Returns (model, active_version)."""
    if version is None:
        with connect() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT version, artifact_path FROM nn_model_registry
                WHERE model_name = %s AND is_active = TRUE
                ORDER BY trained_at DESC LIMIT 1
            """, (model_name,))
            row = cur.fetchone()
            if not row:
                raise FileNotFoundError(f"No active model for {model_name}")
            version = row["version"]
            artifact_path = row["artifact_path"]

    cache_key = f"{model_name}:{version}"
    if cache_key in MODEL_REGISTRY:
        return MODEL_REGISTRY[cache_key], version

    model_class = _model_class_for(model_name)
    model = model_class().to(DEVICE)
    model.eval()

    artifact_path = MODEL_DIR / model_name / version / "model.pt"
    if artifact_path.exists():
        state = torch.load(artifact_path, map_location=DEVICE, weights_only=True)
        model.load_state_dict(state, strict=False)
        log.info("Loaded %s v%s from %s", model_name, version, artifact_path)
    else:
        log.warning("No artifact at %s — using untrained model", artifact_path)

    MODEL_REGISTRY[cache_key] = model
    return model, version


def _model_class_for(model_name: str):
    from . import nn_train
    CLASSES = {
        "article_understanding": nn_train.ArticleUnderstanding,
        "entity_extraction":    nn_train.EntityExtractor,
        "event_matching":        nn_train.EventMatcher,
        "relationship":          nn_train.SimpleRelationshipModel,
        "ranking":              nn_train.RankingModel,
        "coverage":              nn_train.CoverageModel,
        "article_value":        nn_train.ArticleValueModel,
    }
    return CLASSES.get(model_name, nn_train.ArticleUnderstanding)


# ── Article Understanding inference ──────────────────────────────────────────

def infer_article_embeddings(limit: int = INFER_BATCH, dry_run: bool = False) -> dict:
    """Encode fresh articles and write to nn_article_embeddings."""
    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT a.id, a.title, a.body, a.body_hash, a.fetched_at,
                   s.country AS source_country, a.event_type
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            WHERE a.status = 'extracted'
              AND NOT EXISTS (
                  SELECT 1 FROM nn_article_embeddings e
                  WHERE e.article_id = a.id
                    AND e.model_version = (
                        SELECT version FROM nn_model_registry
                        WHERE model_name = 'article_understanding' AND is_active LIMIT 1
                    )
              )
            ORDER BY a.fetched_at DESC
            LIMIT %s
        """, (limit,))
        rows = list(cur.fetchall())

    if not rows:
        return {"encoded": 0}

    texts = [f"{r['title']} {r['body'][:512]}" if r['body'] else r['title'] for r in rows]
    embeddings = _encode_texts(texts)

    version = _get_active_version("article_understanding")
    if version is None:
        return {"error": "no_active_model", "encoded": 0}

    records = []
    for r, emb in zip(rows, embeddings):
        input_hash = r["body_hash"] or hashlib.sha256(texts[rows.index(r)].encode()).hexdigest()[:16]
        records.append((
            "article_understanding", version, r["id"],
            json.dumps(emb.tolist()),
            input_hash, r.get("source_country"), r.get("event_type"),
        ))

    if not dry_run:
        with connect() as conn:
            cur = conn.cursor()
            for r, emb, (model_name, ver, art_id, emb_json, inp_hash, src_country, evt_type) in zip(rows, embeddings, records):
                cur.execute("""
                    INSERT INTO nn_article_embeddings
                        (model_name, model_version, article_id, vector, input_hash)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (model_name, model_version, article_id)
                    DO UPDATE SET vector = EXCLUDED.vector, input_hash = EXCLUDED.input_hash
                """, (model_name, ver, art_id, emb_json, inp_hash))
            conn.commit()

    log.info("Encoded %d article embeddings (v%s)", len(rows), version)
    return {"encoded": len(rows), "version": version}


def infer_event_embeddings(limit: int = INFER_BATCH, dry_run: bool = False) -> dict:
    """Pool article embeddings per event and write to nn_event_embeddings."""
    version = _get_active_version("article_understanding")
    if version is None:
        return {"error": "no_active_model"}

    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT e.id AS event_id,
                   ARRAY_AGG(ea.article_id) AS article_ids,
                   COUNT(*) AS article_count
            FROM news_events e
            JOIN news_event_sources ea ON ea.event_id = e.id
            JOIN nn_article_embeddings ae ON ae.article_id = ea.article_id
                AND ae.model_version = %s
            WHERE e.status = 'active'
              AND NOT EXISTS (
                  SELECT 1 FROM nn_event_embeddings ee
                  WHERE ee.event_id = e.id AND ee.model_version = %s
              )
            GROUP BY e.id
            ORDER BY e.first_reported_at DESC
            LIMIT %s
        """, (version, version, limit))
        rows = list(cur.fetchall())

    if not rows:
        return {"encoded": 0}

    results = []
    for r in rows:
        cur.execute("""
            SELECT vector FROM nn_article_embeddings
            WHERE article_id = ANY(%s) AND model_version = %s
        """, (r["article_ids"], version))
        vecs = [torch.tensor(json.loads(row["vector"])) for row in cur.fetchall()]
        if not vecs:
            continue
        pooled = torch.stack(vecs).mean(dim=0)
        pooled = F.normalize(pooled, p=2, dim=0)
        results.append({
            "event_id": r["event_id"],
            "vector": pooled.tolist(),
            "article_count": r["article_count"],
        })

    if not dry_run and results:
        with connect() as conn:
            cur = conn.cursor()
            for res in results:
                cur.execute("""
                    INSERT INTO nn_event_embeddings
                        (model_name, model_version, event_id, vector, source_article_count)
                    VALUES ('event_matching', %s, %s, %s, %s)
                    ON CONFLICT (model_name, model_version, event_id)
                    DO UPDATE SET vector = EXCLUDED.vector, source_article_count = EXCLUDED.source_article_count
                """, (version, res["event_id"], json.dumps(res["vector"]), res["article_count"]))
            conn.commit()

    log.info("Encoded %d event embeddings", len(results))
    return {"encoded": len(results), "version": version}


def _encode_texts(texts: list[str]) -> list[torch.Tensor]:
    """Encode a list of texts using the article_understanding model.

    Tries GPU first via sentence-transformers, then falls back to the
    trained article_understanding model on CPU. Only uses random vectors
    as a last resort (no trained model available).
    """
    # Try GPU sentence-transformers first
    try:
        from sentence_transformers import SentenceTransformer
        st_model = SentenceTransformer("distilbert-base-nli-stsb-mean-tokens", device=DEVICE)
        with torch.no_grad():
            embs = st_model.encode(texts, convert_to_numpy=True, show_progress_bar=False)
            embs = torch.from_numpy(embs).float()
            proj = torch.zeros(embs.shape[0], EMBEDDING_DIM, device=DEVICE)
            proj[:, :embs.shape[1]] = embs[:, :EMBEDDING_DIM]
            return [F.normalize(proj[i], p=2, dim=0) for i in range(len(texts))]
    except Exception as e:
        log.warning("sentence-transformers GPU unavailable, trying CPU model: %s", e)

    # Fallback: use sentence-transformers on CPU (smaller, ~80MB)
    try:
        from sentence_transformers import SentenceTransformer
        cpu_model = SentenceTransformer("distilbert-base-nli-stsb-mean-tokens", device="cpu")
        with torch.no_grad():
            embs = cpu_model.encode(texts, convert_to_numpy=True, show_progress_bar=False)
            embs = torch.from_numpy(embs).float()
            proj = torch.zeros(embs.shape[0], EMBEDDING_DIM)
            proj[:, :embs.shape[1]] = embs[:, :EMBEDDING_DIM]
            log.info("Encoding %d texts with sentence-transformers on CPU", len(texts))
            return [F.normalize(proj[i], p=2, dim=0) for i in range(len(texts))]
    except Exception as e:
        log.warning("sentence-transformers CPU fallback also failed: %s", e)
    except Exception as e:
        log.warning("article_understanding CPU model failed: %s", e)

    # Last resort: deterministic hash-based embeddings (not random!)
    log.warning("Using deterministic hash fallback for %d texts", len(texts))
    result = []
    for t in texts:
        h = hash(t.encode("utf-8"))
        torch.manual_seed(abs(h) % (2**31))
        result.append(F.normalize(torch.randn(EMBEDDING_DIM), p=2, dim=0))
    return result


def infer_event_matching(limit: int = INFER_BATCH, dry_run: bool = False) -> dict:
    """Score candidate event pairs; write pairs above threshold to nn_event_pair_predictions."""
    version = _get_active_version("event_matching")
    article_emb_version = _get_active_version("article_understanding")
    if version is None or article_emb_version is None:
        return {"error": "no_active_model"}

    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT e1.id AS event_a, e2.id AS event_b,
                   e1.headline AS title_a, e2.headline AS title_b,
                   l1.country AS country_a, l2.country AS country_b,
                   e1.event_type AS event_type_a, e2.event_type AS event_type_b,
                   e1.first_reported_at AS pub_a, e2.first_reported_at AS pub_b
            FROM news_events e1
            JOIN news_events e2 ON e1.id < e2.id
            LEFT JOIN news_locations l1 ON l1.id = e1.primary_location_id
            LEFT JOIN news_locations l2 ON l2.id = e2.primary_location_id
            WHERE e1.status = 'active' AND e2.status = 'active'
              AND e1.first_reported_at > now() - interval '72 hours'
              AND e2.first_reported_at > now() - interval '72 hours'
              AND NOT EXISTS (
                  SELECT 1 FROM nn_event_pair_predictions p
                  WHERE p.event_a = LEAST(e1.id, e2.id)
                    AND p.event_b = GREATEST(e1.id, e2.id)
                    AND p.model_version = %s
              )
            ORDER BY e1.first_reported_at DESC
            LIMIT %s
        """, (version, limit))
        rows = list(cur.fetchall())

    if not rows:
        return {"scored": 0}

    texts_a = [r["title_a"] for r in rows]
    texts_b = [r["title_b"] for r in rows]
    emb_a = _encode_texts(texts_a)
    emb_b = _encode_texts(texts_b)

    scores = []
    with torch.no_grad():
        for i, (ea, eb) in enumerate(zip(emb_a, emb_b)):
            cosine = (ea.to(DEVICE) @ eb.to(DEVICE)).item()
            scores.append(cosine)

    to_write = [(r, s) for r, s in zip(rows, scores) if s > 0.5]
    if not dry_run and to_write:
        with connect() as conn:
            cur = conn.cursor()
            for r, score in to_write:
                cur.execute("""
                    INSERT INTO nn_event_pair_predictions
                        (event_a, event_b, model_name, model_version, score, source)
                    VALUES (%s, %s, 'event_matching', %s, %s, 'siamese')
                    ON CONFLICT (event_a, event_b, model_version) DO UPDATE SET score = EXCLUDED.score
                """, (r["event_a"], r["event_b"], version, score))
            conn.commit()

    log.info("Event matching: scored %d pairs, %d above threshold", len(scores), len(to_write))
    return {"scored": len(scores), "above_threshold": len(to_write), "version": version}


# ── Relationship inference ────────────────────────────────────────────────────

RELATION_CLASSES = [
    "same_story", "related", "follow_up", "response", "background",
    "origin", "destination", "mentioned",
]


def infer_relationships(limit: int = INFER_BATCH, dry_run: bool = False) -> dict:
    """Score event→event relationships using article embeddings."""
    version = _get_active_version("relationship")
    if version is None:
        return {"error": "no_active_model"}

    with connect() as conn:
        cur = conn.cursor()

        # Get candidate event pairs via their articles with embeddings
        cur.execute("""
            WITH article_embs AS (
                SELECT a.id AS article_id, aes.event_id, e.vector
                FROM news_articles a
                JOIN nn_article_embeddings e ON e.article_id = a.id
                JOIN news_event_sources aes ON aes.article_id = a.id
                WHERE a.status = 'extracted'
                  AND a.fetched_at > NOW() - INTERVAL '24 hours'
                  AND e.model_version = (
                      SELECT model_version FROM nn_model_registry
                      WHERE model_name = 'article_understanding' AND is_active = TRUE
                      LIMIT 1
                  )
            ),
            event_avg_emb AS (
                SELECT event_id, AVG(vector) AS avg_emb
                FROM article_embs
                WHERE event_id IS NOT NULL
                GROUP BY event_id
            )
            SELECT
                e1.id AS src_id, e2.id AS dst_id,
                e1.headline AS src_title, e2.headline AS dst_title,
                e1.event_type AS src_event_type, e2.event_type AS dst_event_type,
                e1.first_reported_at AS src_pub, e2.first_reported_at AS dst_pub,
                l1.country AS src_country, l2.country AS dst_country,
                e1.source_count AS src_sources, e2.source_count AS dst_sources,
                eae1.avg_emb AS src_emb, eae2.avg_emb AS dst_emb
            FROM news_events e1
            JOIN news_events e2 ON e1.id < e2.id
            JOIN event_avg_emb eae1 ON eae1.event_id = e1.id
            JOIN event_avg_emb eae2 ON eae2.event_id = e2.id
            LEFT JOIN news_locations l1 ON l1.id = e1.primary_location_id
            LEFT JOIN news_locations l2 ON l2.id = e2.primary_location_id
            WHERE e1.status = 'active' AND e2.status = 'active'
              AND e1.first_reported_at > NOW() - INTERVAL '48 hours'
              AND e2.first_reported_at > NOW() - INTERVAL '48 hours'
              AND eae1.avg_emb IS NOT NULL AND eae2.avg_emb IS NOT NULL
            ORDER BY e1.first_reported_at DESC
            LIMIT %s
        """, (limit,))
        rows = list(cur.fetchall())

    if not rows:
        return {"scored": 0}

    model, _ = load_model("relationship", version)
    results = []
    batch_data = []

    for r in rows:
        try:
            src_emb_str = str(r["src_emb"]).strip("[]")
            dst_emb_str = str(r["dst_emb"]).strip("[]")
            src_emb = torch.tensor([float(x) for x in src_emb_str.split(",")])
            dst_emb = torch.tensor([float(x) for x in dst_emb_str.split(",")])
        except (ValueError, AttributeError):
            continue

        same_country = 1.0 if r["src_country"] == r["dst_country"] else 0.0
        try:
            time_diff_h = min(abs((r["src_pub"] - r["dst_pub"]).total_seconds() / 3600), 48.0) / 48.0
        except (TypeError, AttributeError):
            time_diff_h = 0.5

        cosine_sim = (src_emb * dst_emb).sum().item()

        scalar_feats = torch.tensor([
            cosine_sim,
            0.0,
            same_country,
            0.0,
            time_diff_h,
            0.0,
            0.0,
            min(float(r["src_sources"] or 0) / 100.0, 5.0),
            min(float(r["dst_sources"] or 0) / 100.0, 5.0),
            1.0 if r["src_event_type"] == r["dst_event_type"] else 0.0,
            0.0,
        ], dtype=torch.float32)

        batch_data.append({
            "src_emb": src_emb,
            "dst_emb": dst_emb,
            "scalar_feats": scalar_feats,
            "src_id": r["src_id"],
            "dst_id": r["dst_id"],
        })

    if not batch_data:
        return {"scored": 0}

    with torch.no_grad(), autocast():
        for bd in batch_data:
            batch = {
                "src_emb": bd["src_emb"].unsqueeze(0).to(DEVICE),
                "dst_emb": bd["dst_emb"].unsqueeze(0).to(DEVICE),
                "scalar_feats": bd["scalar_feats"].unsqueeze(0).to(DEVICE),
            }
            out = model(batch)
            rel_idx = out["relation_logits"].argmax(dim=1).item()
            score = out["score"].item()
            results.append({
                "src_id": bd["src_id"],
                "dst_id": bd["dst_id"],
                "relation": RELATION_CLASSES[rel_idx],
                "score": score,
            })

    if not dry_run and results:
        with connect() as conn:
            cur = conn.cursor()
            for res in results:
                if res["score"] < 0.3:
                    continue
                cur.execute("""
                    INSERT INTO nn_event_relationships
                        (model_name, model_version, src_event_id, dst_event_id,
                         edge_type, relation, score)
                    VALUES ('relationship', %s, %s, %s, 'event', %s, %s)
                    ON CONFLICT (model_version, src_event_id, dst_event_id, edge_type, relation)
                    DO UPDATE SET score = EXCLUDED.score
                """, (version, res["src_id"], res["dst_id"], res["relation"], res["score"]))
            conn.commit()

    log.info("Relationship: scored %d edges", len(results))
    return {"scored": len(results), "version": version}


# ── Ranking inference ─────────────────────────────────────────────────────────

def infer_ranking(limit: int = INFER_BATCH, dry_run: bool = False) -> dict:
    """Score articles for hot/trending/rising leaderboards."""
    version = _get_active_version("ranking")
    if version is None:
        return {"error": "no_active_model"}

    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            WITH event_stats AS (
                SELECT
                    es.event_id,
                    COUNT(DISTINCT es.article_id) AS event_source_count,
                    COUNT(DISTINCT s.country) AS geographic_spread
                FROM news_event_sources es
                JOIN news_articles a ON a.id = es.article_id
                JOIN news_sources s ON s.id = a.source_id
                WHERE es.event_id IN (SELECT id FROM news_events WHERE status = 'active')
                GROUP BY es.event_id
            )
            SELECT a.id AS article_id, a.title, a.event_type, a.published_at,
                   s.reliability_score AS source_quality,
                   l.lat AS event_lat, l.lng AS event_lng, l.country AS event_country,
                   ev.velocity_clicks, ev.velocity_views, ev.accel_clicks,
                   COALESCE(est.event_source_count, 0) AS event_source_count,
                   COALESCE(est.geographic_spread, 0) AS geographic_spread,
                   sess.topic_interest, sess.country_interest,
                   sess.total_interactions AS session_interactions,
                   sess.unique_sources,
                   sess.last_seen_lat AS user_lat, sess.last_seen_lng AS user_lng,
                   sess.high_zoom_views, sess.avg_zoom_depth,
                   sess.zoom_view_duration_ms, sess.unique_cities_viewed,
                   zi.zoom_weighted_score AS city_zoom_score,
                   zi.view_count AS city_view_count,
                   COALESCE(lg.gap_score, 0) AS coverage_gap_score,
                   COALESCE(lg.source_count, 0) AS country_source_count
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            LEFT JOIN news_event_sources aes ON aes.article_id = a.id
            LEFT JOIN news_events e ON e.id = aes.event_id
            LEFT JOIN event_stats est ON est.event_id = e.id
            LEFT JOIN news_locations l ON l.id = e.primary_location_id
            LEFT JOIN nn_event_velocity ev ON ev.event_id = e.id
                AND ev.snapshot_at > now() - interval '6 hours'
            LEFT JOIN nn_v_session_features_latest sess ON TRUE
            LEFT JOIN nn_zoom_city_interest zi
                ON zi.session_id = sess.session_id
                AND zi.city_name = l.country
                AND zi.snapshot_at > now() - interval '6 hours'
            LEFT JOIN LATERAL (
                SELECT DISTINCT ON (country_code)
                    country_code, gap_score, source_count
                FROM news_coverage_gaps
                WHERE country_code = l.country
                ORDER BY country_code, created_at DESC
                LIMIT 1
            ) lg ON l.country IS NOT NULL
            WHERE a.status = 'extracted'
              AND a.fetched_at > now() - interval '24 hours'
            GROUP BY a.id, s.id, l.lat, l.lng, l.country,
                     ev.velocity_clicks, ev.velocity_views, ev.accel_clicks,
                     est.event_source_count, est.geographic_spread,
                     sess.topic_interest, sess.country_interest,
                     sess.total_interactions, sess.unique_sources,
                     sess.last_seen_lat, sess.last_seen_lng,
                     sess.high_zoom_views, sess.avg_zoom_depth,
                     sess.zoom_view_duration_ms, sess.unique_cities_viewed,
                     zi.zoom_weighted_score, zi.view_count,
                     lg.gap_score, lg.source_count
            ORDER BY a.fetched_at DESC
            LIMIT %s
        """, (limit,))
        rows = list(cur.fetchall())

    if not rows:
        return {"scored": 0}

    texts = [f"{r['title']}" for r in rows]
    embeddings = _encode_texts(texts)

    model, _ = load_model("ranking", version)
    predictions = []

    with torch.no_grad(), autocast():
        for i, r in enumerate(rows):
            topic_int = r.get("topic_interest") or {}
            country_int = r.get("country_interest") or {}
            sess_vec = _session_interest_to_vector(topic_int, country_int)
            session_emb = torch.tensor(sess_vec, dtype=torch.float32)
            gap_score = float(r.get("coverage_gap_score") or 0)
            src_count = int(r.get("country_source_count") or 0)
            geo_spread = int(r.get("geographic_spread") or 0)
            scalar_feats = torch.tensor([
                float(r.get("source_quality") or 0.5),
                _freshness(r.get("published_at")),
                float(r.get("velocity_clicks") or 0),
                float(r.get("velocity_views") or 0),
                float(r.get("accel_clicks") or 0),
                float(r.get("event_source_count") or 0),
                float(r.get("country_interest", {}).get((r.get("event_country") or "").upper(), 0.0)),
                float(r.get("topic_interest", {}).get(r.get("event_type") or "", 0.0)),
                float(r.get("unique_sources") or 0),
                float(r.get("session_interactions") or 0),
                _local_relevance(r.get("user_lat"), r.get("user_lng"),
                                 r.get("event_lat"), r.get("event_lng")),
                1.0 if embeddings[i] is not None else 0.0,
                float(r.get("high_zoom_views") or 0),
                float(r.get("avg_zoom_depth") or 0),
                float(r.get("zoom_view_duration_ms") or 0),
                float(r.get("unique_cities_viewed") or 0),
                float(r.get("city_zoom_score") or 0),
                float(r.get("city_view_count") or 0),
                # Content quality signals (from nn_features extraction)
                float(r.get("has_byline") or 0),
                float(r.get("has_contact_info") or 0),
                float(r.get("readability_score") or 0.3),
            ], dtype=torch.float32).unsqueeze(0)

            out = model({
                "article_emb": embeddings[i].unsqueeze(0).to(DEVICE),
                "session_emb": session_emb.unsqueeze(0).to(DEVICE),
                "scalar_feats": scalar_feats.to(DEVICE),
            })

            score = out["score"].item()
            bucket = _score_to_bucket(score)
            score_aux = {
                "trending_score": round(out.get("trending", torch.tensor(0.5)).item(), 3),
                "local_relevance": round(out.get("local", torch.tensor(0.5)).item(), 3),
                "source_quality": round(out.get("quality", torch.tensor(0.5)).item(), 3),
                "freshness": round(out.get("freshness", torch.tensor(0.5)).item(), 3),
                "velocity": round(float(r.get("velocity_clicks") or 0), 3),
                "audience_match": round(float(r.get("session_interactions") or 0) / 100.0, 3),
                "coverage_gap_boost": round(_coverage_gap_boost(gap_score, src_count), 3),
                "geographic_spread": round(_geographic_spread_score(geo_spread), 3),
                "high_zoom_views": int(r.get("high_zoom_views") or 0),
                "avg_zoom_depth": round(float(r.get("avg_zoom_depth") or 0), 2),
                "city_zoom_score": round(float(r.get("city_zoom_score") or 0), 3),
                "city_view_count": int(r.get("city_view_count") or 0),
                "bucket": bucket,
            }
            predictions.append({
                "entity_id": r["article_id"],
                "entity_type": "article",
                "score": score,
                "score_aux": score_aux,
            })

    if not dry_run and predictions:
        _write_prediction_cache("ranking", version, predictions, entity_type="article",
                                ttl_h=TTL_ARTICLE_H)

    log.info("Ranking: scored %d articles", len(predictions))
    return {"scored": len(predictions), "version": version}


def _freshness(published_at) -> float:
    if not isinstance(published_at, datetime):
        return 0.5
    age_h = (datetime.now(timezone.utc) - published_at).total_seconds() / 3600
    return max(0.0, 1.0 - age_h / 24.0)


def _coverage_gap_boost(gap_score: float, source_count: int) -> float:
    """Boost for events in coverage gap countries.

    Events in underserved countries (high gap_score, few sources) are boosted
    because they're likely important news that readers aren't seeing elsewhere.
    Also penalize if too many sources already cover this country.
    """
    if gap_score <= 0:
        return 0.3
    # Normalize gap_score (typically 0-5) to 0-1 range
    normalized = min(gap_score / 5.0, 1.0)
    # If country already has 10+ sources, reduce the boost (well-covered)
    source_penalty = max(0.0, 1.0 - source_count / 20.0)
    return 0.3 + (normalized * 0.5 * source_penalty)


def _geographic_spread_score(spread: int) -> float:
    """Score for how many countries are covering an event.

    Events covered by sources from multiple countries are more globally
    significant. Max out around 10 countries.
    """
    if spread <= 0:
        return 0.0
    return min(spread / 5.0, 1.0)


def _local_relevance(user_lat, user_lng, event_lat, event_lng) -> float:
    if not all(v is not None for v in [user_lat, user_lng, event_lat, event_lng]):
        return 0.5
    R = 6371
    phi1, phi2 = math.radians(user_lat), math.radians(event_lat)
    dphi = math.radians(event_lat - user_lat)
    dlam = math.radians(event_lng - user_lng)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    dist = 2 * R * math.asin(math.sqrt(a))
    return max(0.0, 1.0 - dist / 2000.0)


def _score_to_bucket(score: float) -> str:
    if score >= 0.8:
        return "hot"
    elif score >= 0.6:
        return "trending"
    elif score >= 0.4:
        return "rising"
    return "normal"


# ── Coverage inference ────────────────────────────────────────────────────────

def infer_coverage(dry_run: bool = False, limit: int = 5000) -> dict:
    """Score coverage gaps and write recommendations.

    Uses news_coverage_gaps for gap signals and world_cities for the most
    populous city lat/lng per country. Falls back to 0.0 for countries with
    no world_cities entry.
    """
    version = _get_active_version("coverage")
    if version is None:
        return {"error": "no_active_model"}

    with connect() as conn:
        cur = conn.cursor()
        # Get most-populous city lat/lng per country from world_cities.
        cur.execute("""
            SELECT DISTINCT ON (country_code)
                   country_code, lat, lng
            FROM world_cities
            WHERE country_code IS NOT NULL
              AND lat IS NOT NULL AND lng IS NOT NULL
            ORDER BY country_code, population DESC
        """)
        country_coords = {row["country_code"]: (row["lat"], row["lng"])
                         for row in cur.fetchall()}

        cur.execute("""
            SELECT g.id, g.country_code, g.country_name,
                   g.population,
                   g.active_sources, g.articles_24h, g.events_24h,
                   g.events_per_million_24h, g.gap_score,
                   ARRAY_AGG(DISTINCT s.language) AS languages
            FROM news_coverage_gaps g
            LEFT JOIN news_sources s ON s.country = g.country_code AND s.active
            WHERE g.cycle_id = (
                SELECT cycle_id FROM news_coverage_gaps ORDER BY id DESC LIMIT 1
            )
            GROUP BY g.id, g.country_code, g.country_name,
                     g.population,
                     g.active_sources, g.articles_24h, g.events_24h,
                     g.events_per_million_24h, g.gap_score
            LIMIT %s
        """, (limit,))
        rows = list(cur.fetchall())

    if not rows:
        return {"scored": 0}

    model, _ = load_model("coverage", version)
    predictions = []

    with torch.no_grad(), autocast():
        for r in rows:
            neighbor_gaps = [0.0] * 32
            country_code = r["country_code"]
            lat, lng = country_coords.get(country_code, (0.0, 0.0))
            pop = r["population"] or 0

            scalar_feats = torch.tensor([
                math.log1p(r["active_sources"]) / 3.0,
                math.log1p(r["articles_24h"]) / 10.0,
                math.log1p(r["events_24h"]) / 5.0,
                r["events_per_million_24h"] / 100.0,
                r["gap_score"] / 5.0,
                math.log1p(pop) / 20.0,
                (lat + 90.0) / 180.0,   # normalize lat to [0,1]
                (lng + 180.0) / 360.0,  # normalize lng to [0,1]
            ], dtype=torch.float32).unsqueeze(0)

            out = model({
                "country_emb": torch.zeros(EMBEDDING_DIM).unsqueeze(0).to(DEVICE),
                "neighbor_scores": torch.tensor(neighbor_gaps, dtype=torch.float32).unsqueeze(0).to(DEVICE),
                "scalar_feats": scalar_feats.to(DEVICE),
            })

            gap_score = out["gap_score"].item()
            conf = out["confidence"].item()
            predictions.append({
                "entity_id": r["id"],
                "entity_type": "country",
                "score": gap_score,
                "score_aux": {
                    "confidence": round(conf, 3),
                    "reasoning": f"Coverage gap for {r['country_code']}",
                    "recommended_sources": max(1, int(conf * 5)),
                    "expected_yield_per_source": round(gap_score * 0.1, 3),
                    "languages": ",".join([l for l in (r["languages"] or []) if l] or ["en"]),
                    "feed_url_hints": f"news.{r['country_code'].lower()}.com",
                },
            })

    if not dry_run and predictions:
        _write_prediction_cache("coverage", version, predictions, entity_type="country",
                                ttl_h=TTL_COVERAGE_H)

    log.info("Coverage: scored %d countries", len(predictions))
    return {"scored": len(predictions), "version": version}


# ── Article Leaderboard materialization ──────────────────────────────────────────
# nn_article_leaderboard_live is the main integration point between the NN layer
# and the website's live panel. It is refreshed every 5 minutes by this function,
# called at the end of run_all(). Even without trained models it computes
# a useful classical-engagement leaderboard; NN scores are blended in when available.

def refresh_nn_article_leaderboard_live(dry_run: bool = False, limit: int = 1000) -> dict:
    """Materialize article leaderboard from classical + NN signals."""
    ranking_version = _get_active_version("ranking")
    article_emb_version = _get_active_version("article_understanding")

    with connect() as conn:
        cur = conn.cursor()

        cur.execute("""
            DELETE FROM nn_article_leaderboard_live
            WHERE expires_at <= now()
        """)
        conn.commit()

        cur.execute("""
            INSERT INTO nn_article_leaderboard_live
                (article_id, nn_ranking_score, nn_bucket, classical_engagement,
                 blended_score, trending_score, local_relevance, source_quality,
                 freshness, velocity, audience_match, coverage_gap_boost, geographic_spread,
                 event_id, event_type, headline,
                 source_id, source_name, source_country,
                 published_at, fetched_at,
                 event_lat, event_lng, event_country, event_place_name,
                 article_vector, model_version, scored_at, expires_at)
            SELECT
                a.id                                       AS article_id,
                COALESCE(nn_r.score, 0.5)                AS nn_ranking_score,
                COALESCE(nn_aux->>'bucket', 'normal')    AS nn_bucket,
                greatest(1, ln(ei.clicks_24h + 1))          AS classical_engagement,
                0.0                                       AS blended_score,
                COALESCE((nn_aux->>'trending_score')::float, 0.5) AS trending_score,
                COALESCE((nn_aux->>'local_relevance')::float, 0.5) AS local_relevance,
                s.reliability_score                        AS source_quality,
                greatest(0,
                    1.0 - extract(epoch from (now() - a.published_at)) / 86400.0
                )                                         AS freshness,
                greatest(0, ln(ei.clicks_24h + 1)) / 10.0 AS velocity,
                0.5                                       AS audience_match,
                COALESCE((nn_aux->>'coverage_gap_boost')::float, 0.5) AS coverage_gap_boost,
                COALESCE((nn_aux->>'geographic_spread')::float, 0.0) AS geographic_spread,
                e.id                                      AS event_id,
                e.event_type,
                a.title                                   AS headline,
                s.id                                      AS source_id,
                s.name                                    AS source_name,
                s.country                                 AS source_country,
                a.published_at,
                a.fetched_at,
                l.lat                                      AS event_lat,
                l.lng                                      AS event_lng,
                l.country                                  AS event_country,
                l.place_name                               AS event_place_name,
                ae.vector::vector(16)                      AS article_vector,
                %s                                        AS model_version,
                now()                                     AS scored_at,
                now() + interval '6 hours'                AS expires_at
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            LEFT JOIN news_event_sources aes ON aes.article_id = a.id
            LEFT JOIN news_events e ON e.id = aes.event_id
            LEFT JOIN news_locations l ON l.id = e.primary_location_id
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(CASE WHEN interaction_type IN ('pin_click', 'click') THEN 1 END) AS clicks_24h,
                    COUNT(CASE WHEN interaction_type IN ('pin_view', 'view') THEN 1 END) AS views_24h
                FROM news_interactions
                WHERE article_id = a.id
                  AND created_at > now() - interval '24 hours'
            ) ei ON true
            LEFT JOIN LATERAL (
                SELECT score, score_aux
                FROM nn_prediction_cache c
                WHERE c.entity_id = a.id
                  AND c.entity_type = 'article'
                  AND c.model_name = 'ranking'
                  AND c.valid_until > now()
                ORDER BY c.predicted_at DESC LIMIT 1
            ) nn_r ON true
            LEFT JOIN LATERAL (
                SELECT score_aux AS nn_aux
                FROM nn_prediction_cache c
                WHERE c.entity_id = a.id
                  AND c.entity_type = 'article'
                  AND c.model_name = 'ranking'
                  AND c.valid_until > now()
                ORDER BY c.predicted_at DESC LIMIT 1
            ) nn_aux ON true
            LEFT JOIN nn_article_embeddings ae ON ae.article_id = a.id
                AND ae.model_version = %s
            WHERE a.status = 'extracted'
              AND a.published_at > now() - interval '48 hours'
            ORDER BY (s.reliability_score * greatest(1, ln(ei.clicks_24h + 1))) DESC
            LIMIT %s
            ON CONFLICT (article_id) DO UPDATE SET
                nn_ranking_score  = EXCLUDED.nn_ranking_score,
                nn_bucket         = EXCLUDED.nn_bucket,
                classical_engagement = EXCLUDED.classical_engagement,
                blended_score     = EXCLUDED.blended_score,
                trending_score    = EXCLUDED.trending_score,
                local_relevance   = EXCLUDED.local_relevance,
                source_quality    = EXCLUDED.source_quality,
                freshness        = EXCLUDED.freshness,
                velocity         = EXCLUDED.velocity,
                coverage_gap_boost = EXCLUDED.coverage_gap_boost,
                geographic_spread = EXCLUDED.geographic_spread,
                model_version    = EXCLUDED.model_version,
                scored_at        = EXCLUDED.scored_at,
                expires_at       = EXCLUDED.expires_at
        """, (ranking_version or "none", article_emb_version or "none", limit))
        conn.commit()

        cur.execute("""
            UPDATE nn_article_leaderboard_live
            SET blended_score =
                nn_ranking_score  * 0.35 +
                classical_engagement * 0.25 +
                freshness         * 0.12 +
                velocity         * 0.08 +
                source_quality   * 0.05 +
                coverage_gap_boost * 0.10 +
                geographic_spread * 0.05
            WHERE expires_at > now()
        """)
        conn.commit()

        cur.execute("SELECT count(*) FROM nn_article_leaderboard_live WHERE expires_at > now()")
        count = cur.fetchone()["count"]

    log.info("refresh_nn_article_leaderboard_live: %d articles", count)
    return {"refreshed": count, "ranking_version": ranking_version, "emb_version": article_emb_version}


# ── Inference queue management ──────────────────────────────────────────────────

def enqueue_pending_articles(limit: int = 200, dry_run: bool = False) -> dict:
    """Add unprocessed articles to the inference queue."""
    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO nn_inference_queue
                (article_id, event_id, needs_embedding, needs_geo, needs_entity, status, priority, enqueued_at)
            SELECT
                a.id                                        AS article_id,
                e.id                                        AS event_id,
                NOT EXISTS (
                    SELECT 1 FROM nn_article_embeddings e2
                    WHERE e2.article_id = a.id
                )                                          AS needs_embedding,
                a.location_confidence IS NULL
                 OR a.location_confidence < 0.7           AS needs_geo,
                TRUE                                       AS needs_entity,
                'pending'                                  AS status,
                CASE WHEN a.published_at > now() - interval '2 hours' THEN 10 ELSE 0 END AS priority,
                now()                                      AS enqueued_at
            FROM news_articles a
            LEFT JOIN news_event_sources aes ON aes.article_id = a.id
            LEFT JOIN news_events e ON e.id = aes.event_id
            WHERE a.status = 'extracted'
              AND a.fetched_at > now() - interval '48 hours'
              AND NOT EXISTS (
                  SELECT 1 FROM nn_inference_queue q
                  WHERE q.article_id = a.id AND q.status IN ('pending','encoding','embedded')
              )
            ORDER BY a.published_at DESC
            LIMIT %s
            ON CONFLICT (article_id) DO NOTHING
        """, (limit,))
        conn.commit()

        cur.execute("SELECT count(*) FROM nn_inference_queue WHERE status = 'pending'")
        pending = cur.fetchone()["count"]

    log.info("enqueue_pending_articles: %d pending in queue", pending)
    return {"enqueued": limit, "total_pending": pending}


# ── Prediction cache writer ────────────────────────────────────────────────────

def _sanitize_json_floats(obj):
    """Replace non-finite floats (NaN / ±Inf) with 0.0, recursively.

    FIX 2026-11-14: JSON has no NaN or Infinity. Python's json module
    emits them anyway by default, producing a document PostgreSQL
    refuses to parse. The ranking model emits NaN for some article
    inputs, which aborted the whole ranking INSERT.

    NaN means "no signal", so 0.0 is the correct neutral substitute.
    """
    import math

    if isinstance(obj, dict):
        return {k: _sanitize_json_floats(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_json_floats(v) for v in obj]
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return 0.0
        return obj
    return obj


def _write_prediction_cache(
    model_name: str,
    model_version: str,
    predictions: list[dict],
    entity_type: str,
    ttl_h: int,
) -> None:
    valid_until = datetime.now(timezone.utc).timestamp() + ttl_h * 3600
    with connect() as conn:
        cur = conn.cursor()
        for p in predictions:
            # FIX 2026-11-14: the ranking model can emit NaN for some
            # inputs (e.g. a division by zero inside the network head).
            # json.dumps() happily serialises NaN as the bare token `NaN`,
            # which is NOT valid JSON, and PostgreSQL then rejects the
            # whole INSERT with:
            #     invalid input syntax for type json
            #     DETAIL:  Token "NaN" is invalid.
            # That aborted the entire ranking write, which is why
            # refresh_nn_article_leaderboard_live then had no fresh
            # ranking rows to read and had to fall back to defaults.
            #
            # allow_nan=False would raise instead; the correct fix is to
            # sanitise the values BEFORE serialising, replacing any
            # non-finite float with a neutral 0.0.
            score_aux = _sanitize_json_floats(p["score_aux"])
            cur.execute("""
                INSERT INTO nn_prediction_cache
                    (model_name, model_version, entity_type, entity_id,
                     score, score_aux, valid_until)
                VALUES (%s, %s, %s, %s, %s, %s, to_timestamp(%s))
                ON CONFLICT DO NOTHING
            """, (
                model_name, model_version, entity_type, p["entity_id"],
                p["score"], json.dumps(score_aux, allow_nan=False), valid_until,
            ))
        conn.commit()


def _get_active_version(model_name: str) -> str | None:
    with connect() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT version FROM nn_model_registry
            WHERE model_name = %s AND is_active = TRUE
            LIMIT 1
        """, (model_name,))
        row = cur.fetchone()
        return row["version"] if row else None


def _session_interest_to_vector(topic_interest: dict, country_interest: dict) -> list[float]:
    """Project JSONB topic/country interest dicts into a 64-dim session embedding.

    Strategy: hash each key into a slot and average contributions.
    This is deterministic and requires no trained projection layer.
    """
    dim = 64
    vec = [0.0] * dim
    weights = [0.0] * dim

    for key, val in (topic_interest or {}).items():
        h = hash(key) % dim
        vec[h] += float(val)
        weights[h] += 1.0

    for key, val in (country_interest or {}).items():
        h = (hash(str(key).upper()) * 31) % dim
        vec[h] += float(val)
        weights[h] += 1.0

    for i in range(dim):
        if weights[i] > 0:
            vec[i] /= weights[i]

    norm = math.sqrt(sum(v * v for v in vec))
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec


# ── Orchestrator ──────────────────────────────────────────────────────────────

INFER_FNS = {
    "article_understanding": infer_article_embeddings,
    "event_matching":       infer_event_matching,
    "relationship":         infer_relationships,
    "ranking":              infer_ranking,
    "coverage":             infer_coverage,
}


def run_all(limit: int = INFER_BATCH, dry_run: bool = False, only: str | None = None,
            refresh_leaderboard: bool = True) -> dict:
    log.info("Inference run (limit=%d, dry=%s, only=%s, refresh=%s)",
             limit, dry_run, only, refresh_leaderboard)
    results = {}
    fns = [only] if only else list(INFER_FNS.keys())

    if only is None and "article_understanding" not in fns:
        fns = ["article_understanding"] + fns

    for model_name in fns:
        infer_fn = INFER_FNS.get(model_name)
        if not infer_fn:
            continue
        try:
            result = infer_fn(limit=limit, dry_run=dry_run)
            results[model_name] = result
        except FileNotFoundError as e:
            results[model_name] = {"error": str(e)}
            log.warning("Skipping %s: %s", model_name, e)
        except Exception as e:
            log.exception("Inference %s failed: %s", model_name, e)
            results[model_name] = {"error": str(e)}

    if refresh_leaderboard and only is None:
        try:
            lb = refresh_nn_article_leaderboard_live(dry_run=dry_run, limit=limit)
            results["_leaderboard"] = lb
        except Exception as e:
            log.exception("Leaderboard refresh failed: %s", e)
            results["_leaderboard"] = {"error": str(e)}

    return results


# ── CLI ──────────────────────────────────────────────────────────────────────

class TimeoutError(Exception):
    pass


def timeout_handler(signum, frame):
    raise TimeoutError("Inference timed out after 10 minutes")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Xyzo NN inference")
    p.add_argument("--limit", type=int, default=INFER_BATCH)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--only", choices=list(INFER_FNS.keys()), help="Run one model")
    p.add_argument("--no-refresh", action="store_true", help="Skip leaderboard refresh")
    p.add_argument("--enqueue", action="store_true", help="Enqueue pending articles before inferring")
    p.add_argument("--timeout", type=int, default=600, help="Timeout in seconds (default 600 = 10 min)")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    signal.signal(signal.SIGALRM, timeout_handler)
    signal.alarm(args.timeout)

    try:
        if args.enqueue:
            eq = enqueue_pending_articles(limit=args.limit)
            json.dump({"enqueue": eq}, sys.stdout, default=str)
            sys.stdout.write("\n")

        out = run_all(
            limit=args.limit,
            dry_run=args.dry_run,
            only=args.only,
            refresh_leaderboard=not args.no_refresh,
        )
        json.dump(out, sys.stdout, default=str)
        sys.stdout.write("\n")
    except TimeoutError as e:
        log.error(str(e))
        sys.exit(124)  # Standard timeout exit code
    finally:
        signal.alarm(0)  # Cancel alarm
