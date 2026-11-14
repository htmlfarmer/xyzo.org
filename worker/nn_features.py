"""Feature extraction for the Xyzo neural network layer.

Pulls raw DB rows and assembles them into training-ready feature dicts,
one per (model_name, entity_type, entity_id) snapshot.

Architecture
────────────
Every model consumes a JSONB features_jsonb dict.  The schemas are
documented per model below so nn_train.py can validate them.

Dataset lifecycle
────────────────
1. snapshot() writes one nn_dataset_versions row and many
   nn_training_features rows inside a transaction.
2. The cycle_id is the idempotency key — re-running with the same
   cycle_id is a no-op on nn_dataset_versions and appends no new rows
   (upsert on dataset_hash would be wrong; we want to keep history).
3. To reproduce a model: take its dataset_hash, SELECT * FROM
   nn_training_features WHERE dataset_hash = '...' AND model_name = '...'.

Cold-start labels
────────────────
Labels are never written here.  The labeling pipeline (human-in-the-loop
or heuristic) writes label back to nn_training_features.label separately.
If label is NULL the row is still a valid training example — the model
learns only from labeled rows.

Run
---
    python -m worker.nn_features                    # full snapshot
    python -m worker.nn_features --dry-run         # count only
    python -m worker.nn_features --only article_understanding
    python -m worker.nn_features --cycle-id foo   # override cycle_id
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from .db import connect

log = logging.getLogger("xyzo.nn_features")

EMBEDDING_DIM = 16

# ── helpers ──────────────────────────────────────────────────────────────────

def _sha256(obj: Any) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, default=str).encode()
    ).hexdigest()[:16]


def _null_or(val: Any, default: Any = None) -> Any:
    return default if val is None else val


import re as _re

_RE_BYLINE_NN = _re.compile(
    r"(?:^|\n)\s*(?:by\s+|written\s+by\s+|author:\s+|reporter:\s+|"
    r"correspondent:\s+|staff\s+writer\s+|contributor:\s+)",
    _re.IGNORECASE,
)
_RE_EMAIL_NN = _re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_RE_PHONE_NN = _re.compile(r"(?:\+?\d{1,4}[\s-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}")
_RE_SOCIAL_NN = _re.compile(
    r"(?:@\w{2,20}|"
    r"(?:twitter|x|instagram|facebook|linkedin|threads)\s*[:/]?\s*\S+)",
    _re.IGNORECASE,
)


def _extract_content_quality(full_text: str, body_512: str) -> dict:
    """Extract lightweight content quality signals for NN features.

    Returns floats in [0, 1] for three orthogonal signals:
      has_byline       — author attribution present
      has_contact_info — email, phone, or social handle present
      readability_score — sentence structure + tone quality
    """
    text = full_text[:3000]

    # Byline: 0.0 or 1.0
    has_byline = 1.0 if _RE_BYLINE_NN.search(text[:1500]) else 0.0

    # Contact info: 0.0, 0.33, 0.66, or 1.0 (count of email/phone/social)
    contact = sum([
        bool(_RE_EMAIL_NN.search(text)),
        bool(_RE_PHONE_NN.search(text)),
        bool(_RE_SOCIAL_NN.search(text)),
    ])
    has_contact_info = min(1.0, contact / 3.0)

    # Readability: composite of sentence length + pronoun density
    words = text.split()
    wc = len(words)
    readability_score = 0.3  # neutral base
    if wc > 20:
        sentences = max(1, text.count(".") + text.count("!") + text.count("?"))
        avg_wps = wc / sentences
        # Shorter sentences → higher score (15 wps → 1.0, 40+ → 0.0)
        readability_score += max(0.0, min(0.4, 0.4 * (1.0 - (avg_wps - 15) / 25)))
        # Pronoun density (conversational tone)
        pronouns = sum(1 for w in words if w.lower() in ("i", "we", "you", "your", "us", "our"))
        pronoun_ratio = min(1.0, pronouns / max(wc / 50, 1))
        readability_score += pronoun_ratio * 0.3

    return {
        "has_byline": has_byline,
        "has_contact_info": has_contact_info,
        "readability_score": min(1.0, readability_score),
    }


# ── article_understanding features ───────────────────────────────────────────
# features_jsonb shape:
# {
#   "title":        str,
#   "body":         str,          # first 512 chars
#   "body_hash":    str,
#   "source_id":    int,
#   "source_country": str,
#   "language":     str,
#   "event_type":   str | null,
#   "published_at_unix": float | null,
#   "hour_of_day":  int,          # 0-23 UTC
#   "day_of_week":  int,          # 0=Mon … 6=Sun
#   "entities":     list[str],
#   "topic_tags":   list[str],
#   "word_count":   int,
# }

def extract_article_understanding(rows: list[dict]) -> list[dict]:
    results = []
    for r in rows:
        body = (r.get("body") or "")[:512]
        full_text = (r.get("title") or "") + "\n" + (r.get("summary") or "") + "\n" + (r.get("body") or "")
        cq = _extract_content_quality(full_text, body)
        results.append({
            "title":            r.get("title") or "",
            "body":             body,
            "body_hash":        r.get("body_hash") or _sha256(body),
            "source_id":        r.get("source_id"),
            "source_country":   r.get("source_country") or "unknown",
            "language":        r.get("language") or "en",
            "event_type":       r.get("event_type"),
            "published_at_unix": (
                r["published_at"].timestamp()
                if isinstance(r.get("published_at"), datetime)
                else None
            ),
            "hour_of_day":      (
                int(r["published_at"].hour)
                if isinstance(r.get("published_at"), datetime)
                else 12
            ),
            "day_of_week":      (
                int(r["published_at"].weekday())
                if isinstance(r.get("published_at"), datetime)
                else 0
            ),
            "entities":         list(r.get("entities") or []),
            "topic_tags":       list(r.get("topic_tags") or []),
            "word_count":       len(body.split()),
            # Content quality signals for NN ranking
            "has_byline":       cq["has_byline"],
            "has_contact_info": cq["has_contact_info"],
            "readability_score": cq["readability_score"],
        })
    return results


# ── entity_extraction features ────────────────────────────────────────────────
# Same as article_understanding — the entity model re-uses article text
# features and adds token-level BIO labels derived from news_articles.entities
# and news_entities at label-time.

ENTITY_CLASSES = ["O", "B-PER", "I-PER", "B-ORG", "I-ORG", "B-LOC", "I-LOC"]


def extract_entity_extraction(rows: list[dict]) -> list[dict]:
    return extract_article_understanding(rows)


# ── event_matching features ──────────────────────────────────────────────────
# features_jsonb shape (pairwise — two rows merged):
# {
#   "title_a":     str,   "title_b":     str,
#   "body_a":      str,   "body_b":      str,
#   "loc_a":       str,   "loc_b":       str,
#   "country_a":   str,   "country_b":   str,
#   "event_type_a":str,   "event_type_b":str,
#   "pub_diff_h":  float,  # |pub_a - pub_b| in hours
#   "same_country": bool,
#   "source_shared": bool,  # any common source_id
#   "embedding_cosine": float | null,  # filled by nn_infer after encoding
#   "entity_jaccard": float,
#   "headline_sim": float,   # word-overlap ratio of headlines
# }

def extract_event_matching(pairs: list[dict]) -> list[dict]:
    results = []
    for p in pairs:
        body_a = (p.get("body_a") or "")[:256]
        body_b = (p.get("body_b") or "")[:256]
        title_a_words = set((p.get("title_a") or "").lower().split())
        title_b_words = set((p.get("title_b") or "").lower().split())
        overlap = len(title_a_words & title_b_words)
        headline_sim = (
            overlap / len(title_a_words | title_b_words)
            if title_a_words | title_b_words
            else 0.0
        )
        entities_a = set(e.lower() for e in (p.get("entities_a") or []))
        entities_b = set(e.lower() for e in (p.get("entities_b") or []))
        entity_jaccard = (
            len(entities_a & entities_b) / len(entities_a | entities_b)
            if entities_a | entities_b
            else 0.0
        )
        pub_diff_h = 999.0
        if isinstance(p.get("pub_a"), datetime) and isinstance(p.get("pub_b"), datetime):
            pub_diff_h = abs((p["pub_a"] - p["pub_b"]).total_seconds()) / 3600

        results.append({
            "title_a":       p.get("title_a") or "",
            "title_b":       p.get("title_b") or "",
            "body_a":        body_a,
            "body_b":        body_b,
            "loc_a":         p.get("loc_a") or "",
            "loc_b":         p.get("loc_b") or "",
            "country_a":     p.get("country_a") or "unknown",
            "country_b":     p.get("country_b") or "unknown",
            "event_type_a":  p.get("event_type_a") or "other",
            "event_type_b":  p.get("event_type_b") or "other",
            "pub_diff_h":    pub_diff_h,
            "same_country":  (p.get("country_a") or "").lower() == (p.get("country_b") or "").lower(),
            "source_shared": bool(set(p.get("source_ids_a") or []) & set(p.get("source_ids_b") or [])),
            "embedding_cosine": p.get("embedding_cosine"),
            "entity_jaccard": entity_jaccard,
            "headline_sim":  headline_sim,
        })
    return results


# ── relationship features ────────────────────────────────────────────────────
# features_jsonb shape (edge-level):
# {
#   "src_title":      str,
#   "dst_title":      str,
#   "src_loc":        str,
#   "dst_loc":        str,
#   "src_country":    str,
#   "dst_country":    str,
#   "src_event_type": str,
#   "dst_event_type": str,
#   "embedding_cosine": float | null,
#   "entity_jaccard": float,
#   "pub_diff_h":    float,
#   "same_country":  bool,
#   "edge_type":     str,   # 'event' | 'location'
# }

def extract_relationship(edges: list[dict]) -> list[dict]:
    results = []
    for e in edges:
        src_entities = set(ee.lower() for ee in (e.get("src_entities") or []))
        dst_entities = set(ee.lower() for ee in (e.get("dst_entities") or []))
        entity_jaccard = (
            len(src_entities & dst_entities) / len(src_entities | dst_entities)
            if src_entities | dst_entities
            else 0.0
        )
        pub_diff_h = 999.0
        if isinstance(e.get("src_pub"), datetime) and isinstance(e.get("dst_pub"), datetime):
            pub_diff_h = abs((e["src_pub"] - e["dst_pub"]).total_seconds()) / 3600

        results.append({
            "src_title":        e.get("src_title") or "",
            "dst_title":        e.get("dst_title") or "",
            "src_loc":          e.get("src_loc") or "",
            "dst_loc":          e.get("dst_loc") or "",
            "src_country":      e.get("src_country") or "unknown",
            "dst_country":      e.get("dst_country") or "unknown",
            "src_event_type":   e.get("src_event_type") or "other",
            "dst_event_type":   e.get("dst_event_type") or "other",
            "embedding_cosine": e.get("embedding_cosine"),
            "entity_jaccard":   entity_jaccard,
            "pub_diff_h":       pub_diff_h,
            "same_country":     (e.get("src_country") or "").lower() == (e.get("dst_country") or "").lower(),
            "edge_type":        e.get("edge_type") or "event",
        })
    return results


# ── ranking features ─────────────────────────────────────────────────────────
# features_jsonb shape:
# {
#   "article_embedding": list[float] | null,  # cosine-sim to session interest vec
#   "event_embedding":   list[float] | null,
#   "source_quality":    float,               # news_sources.reliability_score
#   "freshness":        float,                # 0=old, 1=fresh (24h window)
#   "velocity_clicks":   float,               # clicks/hour on event
#   "velocity_views":   float,               # views/hour
#   "accel_clicks":     float,               # Δclicks/hour over last window
#   "event_source_count": int,               # number of articles in event
#   "event_type":        str,
#   "country_match":     float,              # 0-1 session country interest
#   "topic_match":       float,              # 0-1 session topic interest
#   "unique_sources_24h": int,              # distinct sources in session
#   "session_total_interactions": int,
#   "local_relevance":   float,             # haversine proximity score
#   "user_lat":          float | null,
#   "user_lng":          float | null,
#   "event_lat":         float | null,
#   "event_lng":         float | null,
# }

def extract_ranking(rows: list[dict]) -> list[dict]:
    results = []
    for r in rows:
        published = r.get("published_at")
        if isinstance(published, datetime):
            age_h = (datetime.now(timezone.utc) - published).total_seconds() / 3600
            freshness = max(0.0, 1.0 - age_h / 24.0)
        else:
            freshness = 0.5

        user_lat = r.get("user_lat")
        user_lng = r.get("user_lng")
        event_lat = r.get("event_lat")
        event_lng = r.get("event_lng")
        local_relevance = 0.0
        if all(v is not None for v in [user_lat, user_lng, event_lat, event_lng]):
            local_relevance = _haversine_score(user_lat, user_lng, event_lat, event_lng)

        results.append({
            "article_embedding":        r.get("article_embedding"),
            "event_embedding":          r.get("event_embedding"),
            "source_quality":           float(r.get("source_quality") or 0.5),
            "freshness":                freshness,
            "velocity_clicks":          float(r.get("velocity_clicks") or 0),
            "velocity_views":           float(r.get("velocity_views") or 0),
            "accel_clicks":             float(r.get("accel_clicks") or 0),
            "event_source_count":       int(r.get("event_source_count") or 0),
            "event_type":               r.get("event_type") or "other",
            "country_match":            float((r.get("country_interest") or {}).get(r.get("event_country") or "", 0.0)),
            "topic_match":              float((r.get("topic_interest") or {}).get(r.get("event_type") or "", 0.0)),
            "unique_sources_24h":       int(r.get("unique_sources") or 0),
            "session_total_interactions": int(r.get("session_interactions") or 0),
            "local_relevance":          local_relevance,
            "user_lat":                 user_lat,
            "user_lng":                 user_lng,
            "event_lat":                event_lat,
            "event_lng":                event_lng,
            # Zoom-level features (zoom >= 10 = city-level user intent)
            "high_zoom_views":          int(r.get("high_zoom_views") or 0),
            "avg_zoom_depth":            float(r.get("avg_zoom_depth") or 0),
            "zoom_view_duration_ms":     int(r.get("zoom_view_duration_ms") or 0),
            "unique_cities_viewed":      int(r.get("unique_cities_viewed") or 0),
            # City-level zoom interest: article's city matches user's high-zoom views
            "city_zoom_score":           float(r.get("city_zoom_score") or 0),
            "city_view_count":           int(r.get("city_view_count") or 0),
        })
    return results


def _haversine_score(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6371
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    dist = 2 * R * math.asin(math.sqrt(a))
    return max(0.0, 1.0 - dist / 2000.0)


# ── coverage features ─────────────────────────────────────────────────────────
# features_jsonb shape:
# {
#   "country_code":    str,
#   "region":          str,
#   "population":      int,
#   "active_sources":  int,
#   "articles_24h":    int,
#   "events_24h":      int,
#   "events_per_million": float,
#   "classical_gap_score": float,
#   "lat":             float | null,
#   "lng":             float | null,
#   "country_embedding": list[float] | null,
#   "neighbor_gap_scores": list[float],  # gap scores of bordering countries
#   "languages":       list[str],
# }

def extract_coverage(rows: list[dict]) -> list[dict]:
    results = []
    for r in rows:
        results.append({
            "country_code":         r.get("country_code") or "XX",
            "region":               r.get("region") or "unknown",
            "population":           int(r.get("population") or 0),
            "active_sources":       int(r.get("active_sources") or 0),
            "articles_24h":        int(r.get("articles_24h") or 0),
            "events_24h":          int(r.get("events_24h") or 0),
            "events_per_million":  float(r.get("events_per_million_24h") or 0.0),
            "classical_gap_score":  float(r.get("gap_score") or 0.0),
            "lat":                  r.get("lat"),
            "lng":                  r.get("lng"),
            "country_embedding":    r.get("country_embedding"),
            "neighbor_gap_scores":  list(r.get("neighbor_gap_scores") or []),
            "languages":            list(r.get("languages") or ["en"]),
        })
    return results


# ── article_value features ────────────────────────────────────────────────────
# Predicts how "valuable" an article is for AI treatment.
# features_jsonb shape:
# {
#   "title":            str,
#   "body_first_512":   str,
#   "source_id":        int,
#   "source_country":   str,
#   "event_type":       str | null,
#   "published_at_unix": float | null,
#   "reliability_score": float | null,
#   "has_location":     bool,
#   "entity_count":     int,
#   "novel_entity_count": int,   # entities not seen today
#   "topic_count":      int,
#   "novel_topic_count": int,    # topics not seen today
#   "word_count":       int,
# }
#
# Label: binary — was the article eventually clicked/viewed/shared?
# (Derived from news_interactions or nn_training_features.label)

EVENT_TYPE_TO_ID = {
    "politics": 0, "business": 1, "crime": 2, "weather": 3,
    "science": 4, "technology": 5, "sports": 6, "culture": 7,
    "environment": 8, "conflict": 9, "health": 10, "disaster": 11,
    "humanitarian": 12, "other": 13,
}


def extract_article_value(rows: list[dict], cycle_counts: dict | None = None) -> list[dict]:
    """Extract features for article_value model.

    Args:
        rows: Article rows from DB
        cycle_counts: Optional dict with {event_types: Counter, countries: Counter,
                      entities: Counter, topics: Counter} for novelty scoring.
    """
    results = []
    for r in rows:
        body = (r.get("body") or "")[:512]
        et = (r.get("event_type") or "other").lower()
        cc = (r.get("source_country") or "unknown").upper()
        entities = list(r.get("entities") or [])
        topics = list(r.get("topic_tags") or [])

        # Compute novelty scores if cycle_counts provided
        novel_entities = 0
        novel_topics = 0
        if cycle_counts:
            ec = cycle_counts.get("entities", {})
            tc = cycle_counts.get("topics", {})
            novel_entities = sum(1 for e in entities if ec.get(e.lower(), 0) <= 1)
            novel_topics = sum(1 for t in topics if tc.get(t.lower(), 0) <= 1)

        results.append({
            "title":            r.get("title") or "",
            "body_first_512":   body,
            "source_id":        r.get("source_id"),
            "source_country":   cc,
            "event_type":       et,
            "published_at_unix": (
                r["published_at"].timestamp()
                if isinstance(r.get("published_at"), datetime)
                else None
            ),
            "reliability_score": r.get("reliability_score"),
            "has_location":     bool(r.get("location_text") or r.get("extracted_lat")),
            "entity_count":     len(entities),
            "novel_entity_count": novel_entities,
            "topic_count":      len(topics),
            "novel_topic_count": novel_topics,
            "word_count":       len(body.split()),
        })
    return results


# ── Snapshot orchestration ───────────────────────────────────────────────────

MODEL_EXTRACTORS = {
    "article_understanding": extract_article_understanding,
    "entity_extraction":    extract_entity_extraction,
    "event_matching":       extract_event_matching,
    "relationship":        extract_relationship,
    "ranking":             extract_ranking,
    "coverage":            extract_coverage,
    "article_value":       extract_article_value,
}


def snapshot_articles(conn, cycle_id: str, dataset_hash: str, limit: int = 50_000) -> dict:
    cur = conn.cursor()
    cur.execute("""
        SELECT
            a.id, a.title, a.body, a.body_hash, a.source_id,
            s.country AS source_country, s.language,
            a.event_type, a.published_at, a.location_text,
            a.entities, a.topic_tags,
            l.lat AS extracted_lat, l.lng AS extracted_lng,
            l.country AS extracted_country, a.location_confidence,
            a.extracted_at
        FROM news_articles a
        LEFT JOIN news_sources s ON s.id = a.source_id
        LEFT JOIN news_locations l ON l.id = a.location_id
        WHERE a.status = 'extracted'
          AND a.fetched_at > now() - interval '30 days'
        ORDER BY a.fetched_at DESC
        LIMIT %s
    """, (limit,))
    rows = list(cur.fetchall())

    # article_understanding + entity_extraction share the same rows
    for model_name in ("article_understanding", "entity_extraction"):
        extractor = MODEL_EXTRACTORS[model_name]
        features = extractor(rows)
        _upsert_features(cur, cycle_id, dataset_hash, model_name, features, rows)
    conn.commit()
    return {"article_rows": len(rows)}


def snapshot_events(conn, cycle_id: str, dataset_hash: str, limit: int = 20_000) -> dict:
    cur = conn.cursor()
    cur.execute("""
        SELECT
            e.id, e.headline AS title, e.summary AS body, e.event_type,
            e.primary_location_id,
            l.lat AS event_lat, l.lng AS event_lng,
            l.country AS event_country, l.place_name AS event_loc,
            e.first_reported_at AS published_at,
            COUNT(DISTINCT es.article_id) AS source_count
        FROM news_events e
        LEFT JOIN news_locations l ON l.id = e.primary_location_id
        LEFT JOIN news_event_sources es ON es.event_id = e.id
        WHERE e.status = 'active'
          AND e.first_reported_at > now() - interval '14 days'
        GROUP BY e.id, l.lat, l.lng, l.country, l.place_name
        ORDER BY e.first_reported_at DESC
        LIMIT %s
    """, (limit,))
    rows = list(cur.fetchall())
    # event_matching pairs
    event_ids = [r["id"] for r in rows]
    pair_rows = []
    if event_ids:
        cur.execute("""
            SELECT
                a1.id AS id_a, a2.id AS id_b,
                a1.title AS title_a, a2.title AS title_b,
                a1.body AS body_a, a2.body AS body_b,
                a1.published_at AS pub_a, a2.published_at AS pub_b,
                l1.country AS country_a, l2.country AS country_b,
                l1.place_name AS loc_a, l2.place_name AS loc_b,
                a1.event_type AS event_type_a, a2.event_type AS event_type_b,
                a1.entities AS entities_a, a2.entities AS entities_b,
                a1.source_id AS source_id_a, a2.source_id AS source_id_b
            FROM news_articles a1
            JOIN news_event_sources es1 ON es1.article_id = a1.id
            JOIN news_events ev1 ON ev1.id = es1.event_id
            JOIN news_event_sources es2 ON es2.article_id = a1.id
            JOIN news_events ev2 ON ev2.id = es2.event_id
            JOIN news_articles a2 ON a2.id = es2.article_id
            LEFT JOIN news_locations l1 ON l1.id = a1.location_id
            LEFT JOIN news_locations l2 ON l2.id = a2.location_id
            WHERE ev1.id = ANY(%s)
              AND ev2.id = ANY(%s)
              AND ev1.id < ev2.id
              AND a1.id < a2.id
            LIMIT 100000
        """, (event_ids, event_ids))
        pair_rows = list(cur.fetchall())

    features = extract_event_matching(pair_rows)
    _upsert_features(cur, cycle_id, dataset_hash, "event_matching", features, pair_rows)
    conn.commit()
    return {"event_rows": len(rows), "pair_rows": len(pair_rows)}


def snapshot_relationships(conn, cycle_id: str, dataset_hash: str) -> dict:
    cur = conn.cursor()
    cur.execute("""
        SELECT
            e1.id AS src_id, e2.id AS dst_id,
            e1.headline AS src_title, e2.headline AS dst_title,
            e1.event_type AS src_event_type, e2.event_type AS dst_event_type,
            e1.first_reported_at AS src_pub, e2.first_reported_at AS dst_pub,
            l1.country AS src_country, l2.country AS dst_country,
            l1.place_name AS src_loc, l2.place_name AS dst_loc,
            src_ent.src_entities, dst_ent.dst_entities,
            'event' AS edge_type
        FROM news_events e1
        JOIN news_events e2 ON e1.id != e2.id
        LEFT JOIN news_locations l1 ON l1.id = e1.primary_location_id
        LEFT JOIN news_locations l2 ON l2.id = e2.primary_location_id
        LEFT JOIN LATERAL (
            SELECT ARRAY_AGG(DISTINCT ae.name) AS src_entities
            FROM news_event_entities ee
            JOIN news_entities ae ON ae.id = ee.entity_id
            WHERE ee.event_id = e1.id
        ) src_ent ON true
        LEFT JOIN LATERAL (
            SELECT ARRAY_AGG(DISTINCT ae.name) AS dst_entities
            FROM news_event_entities ee
            JOIN news_entities ae ON ae.id = ee.entity_id
            WHERE ee.event_id = e2.id
        ) dst_ent ON true
        WHERE e1.status = 'active' AND e2.status = 'active'
          AND e1.first_reported_at > now() - interval '7 days'
          AND e2.first_reported_at > now() - interval '7 days'
        LIMIT 50000
    """)
    rows = list(cur.fetchall())
    features = extract_relationship(rows)
    _upsert_features(cur, cycle_id, dataset_hash, "relationship", features, rows)
    conn.commit()
    return {"relationship_rows": len(rows)}


def snapshot_ranking(conn, cycle_id: str, dataset_hash: str, limit: int = 100_000) -> dict:
    cur = conn.cursor()
    cur.execute("""
        SELECT
            a.id AS article_id,
            e.id AS event_id,
            a.title, a.body, a.published_at, a.event_type,
            s.id AS source_id, s.reliability_score AS source_quality,
            l.lat AS event_lat, l.lng AS event_lng, l.country AS event_country,
            ev.velocity_clicks, ev.velocity_views, ev.accel_clicks,
            COUNT(DISTINCT aes.article_id) AS event_source_count,
            sess.topic_interest, sess.country_interest,
            sess.total_interactions AS session_interactions,
            sess.unique_sources,
            sess.last_seen_lat AS user_lat, sess.last_seen_lng AS user_lng,
            -- Zoom-level session features (zoom >= 10 = city-level intent)
            sess.high_zoom_views,
            sess.avg_zoom_depth,
            sess.zoom_view_duration_ms,
            sess.unique_cities_viewed,
            -- Per-article city match: zoom interest for this article's city
            zi.zoom_weighted_score AS city_zoom_score,
            zi.view_count AS city_view_count
        FROM news_articles a
        JOIN news_sources s ON s.id = a.source_id
        LEFT JOIN news_event_sources aes ON aes.article_id = a.id
        LEFT JOIN news_events e ON e.id = aes.event_id
        LEFT JOIN news_locations l ON l.id = e.primary_location_id
        LEFT JOIN nn_event_velocity ev ON ev.event_id = e.id
            AND ev.snapshot_at > now() - interval '6 hours'
        LEFT JOIN nn_v_session_features_latest sess ON TRUE
        LEFT JOIN nn_zoom_city_interest zi
            ON zi.session_id = sess.session_id
            AND zi.city_name = l.city
            AND zi.snapshot_at > now() - interval '6 hours'
        WHERE a.status = 'extracted'
          AND a.fetched_at > now() - interval '24 hours'
        GROUP BY a.id, e.id, s.id, l.lat, l.lng, l.country,
                 ev.velocity_clicks, ev.velocity_views, ev.accel_clicks,
                 sess.topic_interest, sess.country_interest,
                 sess.total_interactions, sess.unique_sources,
                 sess.last_seen_lat, sess.last_seen_lng,
                 sess.high_zoom_views, sess.avg_zoom_depth,
                 sess.zoom_view_duration_ms, sess.unique_cities_viewed,
                 zi.zoom_weighted_score, zi.view_count
        LIMIT %s
    """, (limit,))
    rows = list(cur.fetchall())
    features = extract_ranking(rows)
    _upsert_features(cur, cycle_id, dataset_hash, "ranking", features, rows)
    conn.commit()
    return {"ranking_rows": len(rows)}


def snapshot_coverage(conn, cycle_id: str, dataset_hash: str) -> dict:
    cur = conn.cursor()
    cur.execute("""
        SELECT
            g.country_code, g.country_name,
            g.active_sources, g.articles_24h, g.events_24h,
            g.events_per_million_24h, g.gap_score,
            ARRAY_AGG(DISTINCT s.language) AS languages
        FROM news_coverage_gaps g
        LEFT JOIN news_sources s ON s.country = g.country_code AND s.active
        WHERE g.cycle_id = (
            SELECT cycle_id FROM news_coverage_gaps
            ORDER BY id DESC LIMIT 1
        )
        GROUP BY g.country_code, g.country_name,
                 g.active_sources, g.articles_24h, g.events_24h,
                 g.events_per_million_24h, g.gap_score
    """)
    rows = list(cur.fetchall())
    features = extract_coverage(rows)
    _upsert_features(cur, cycle_id, dataset_hash, "coverage", features, rows)
    conn.commit()
    return {"coverage_rows": len(rows)}


def _upsert_features(
    cur,
    cycle_id: str,
    dataset_hash: str,
    model_name: str,
    features: list[dict],
    source_rows: list[dict],
) -> None:
    for feat, row in zip(features, source_rows):
        entity_id = row.get("id") or row.get("article_id") or row.get("event_a") or 0
        cur.execute("""
            INSERT INTO nn_training_features
                (cycle_id, dataset_hash, model_name, entity_type, entity_id, features_jsonb)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
        """, (
            cycle_id,
            dataset_hash,
            model_name,
            _entity_type_for_model(model_name),
            entity_id,
            json.dumps(feat),
        ))


def _entity_type_for_model(model_name: str) -> str:
    return {
        "article_understanding": "article",
        "entity_extraction":    "article",
        "event_matching":       "event",
        "relationship":         "event",
        "ranking":             "article",
        "coverage":             "country",
    }.get(model_name, "article")


# ── Auto-labeling ────────────────────────────────────────────
# Uses the article graph as ground truth: for each article we find its
# positive/negative neighbours and store the pair as a triplet label, so
# the embedding model gets training examples without manual annotation.
#
# The label_aux dict stores the partner ids and the pair type so the loss
# function can compute the triplet margin.

def auto_label_article_understanding(conn, limit: int = 50_000) -> int:
    """Label article_understanding features with triplet pairs.
    
    Creates positive pairs from articles in the same event, and negative
    pairs from articles in different events. This allows the model to learn
    article embeddings via triplet loss without human annotation.
    """
    cur = conn.cursor()
    
    # Find unlabeled articles that are in MULTI-ARTICLE events (so a positive pair exists)
    cur.execute("""
        SELECT f.id, f.entity_id, f.features_jsonb
        FROM nn_training_features f
        JOIN news_event_sources nes ON nes.article_id = f.entity_id
        WHERE f.model_name = 'article_understanding'
          AND f.label IS NULL
          AND nes.event_id IN (
              SELECT event_id FROM news_event_sources
              GROUP BY event_id HAVING COUNT(*) >= 2
          )
        ORDER BY random()
        LIMIT %s
    """, (limit,))
    rows = list(cur.fetchall())
    
    if not rows:
        return 0
    
    labeled = 0
    for row in rows:
        article_id = row["entity_id"]
        
        # Find a positive pair (same event, different article)
        cur.execute("""
            SELECT nes2.article_id
            FROM news_event_sources nes1
            JOIN news_event_sources nes2 ON nes1.event_id = nes2.event_id
            WHERE nes1.article_id = %s
              AND nes2.article_id != %s
            LIMIT 1
        """, (article_id, article_id))
        pos = cur.fetchone()
        
        if not pos:
            continue
        
        # Find a negative pair (different event, same source type)
        cur.execute("""
            SELECT a2.id
            FROM news_articles a1
            JOIN news_articles a2 ON a1.source_id = a2.source_id
            WHERE a1.id = %s
              AND a2.id != %s
              AND a2.id != %s
              AND NOT EXISTS (
                  SELECT 1 FROM news_event_sources nes1
                  JOIN news_event_sources nes2 ON nes1.event_id = nes2.event_id
                  WHERE nes1.article_id = %s AND nes2.article_id = a2.id
              )
            LIMIT 1
        """, (article_id, article_id, pos["article_id"], article_id))
        neg = cur.fetchone()
        
        if not neg:
            continue
        
        # Label as triplet: (anchor, positive, negative)
        cur.execute("""
            UPDATE nn_training_features
            SET label = 1.0,
                label_aux = %s
            WHERE id = %s
        """, (
            json.dumps({
                "anchor_id": article_id,
                "positive_id": pos["article_id"],
                "negative_id": neg["id"],
            }),
            row["id"],
        ))
        labeled += 1
    
    conn.commit()
    log.info("auto-labeled %d article_understanding features with triplet pairs", labeled)
    return labeled


# ── Main snapshot ─────────────────────────────────────────────────────────────

def snapshot(cycle_id: str | None = None, dry_run: bool = False) -> dict:
    cycle_id = cycle_id or f"snap_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}_{uuid.uuid4().hex[:6]}"
    log.info("snapshot %s starting", cycle_id)

    with connect() as conn:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM nn_dataset_versions WHERE cycle_id = %s", (cycle_id,))
        if cur.fetchone():
            log.info("cycle_id %s already exists — skipping", cycle_id)
            return {"cycle_id": cycle_id, "skipped": True}

        rows = {"article": 0, "event": 0, "relationship": 0, "ranking": 0, "coverage": 0}
        dataset_hash = _sha256({"cycle_id": cycle_id, "ts": datetime.now(timezone.utc).isoformat()})

        cur.execute("""
            INSERT INTO nn_dataset_versions (cycle_id, dataset_hash, row_counts, notes)
            VALUES (%s, %s, %s, %s)
            RETURNING id
        """, (cycle_id, dataset_hash, json.dumps(rows), "auto-generated by nn_features"))
        conn.commit()

        art = snapshot_articles(conn, cycle_id, dataset_hash)
        rows["article"] = art["article_rows"]

        ev = snapshot_events(conn, cycle_id, dataset_hash)
        rows["event"] = ev["event_rows"]

        rel = snapshot_relationships(conn, cycle_id, dataset_hash)
        rows["relationship"] = rel["relationship_rows"]

        rank = snapshot_ranking(conn, cycle_id, dataset_hash)
        rows["ranking"] = rank["ranking_rows"]

        cov = snapshot_coverage(conn, cycle_id, dataset_hash)
        rows["coverage"] = cov["coverage_rows"]

        # Auto-label article_understanding with triplet pairs
        # so the embedding model can be trained.
        article_labeled = auto_label_article_understanding(conn)
        rows["article_understanding_labeled"] = article_labeled

        cur.execute("""
            UPDATE nn_dataset_versions SET row_counts = %s WHERE cycle_id = %s
        """, (json.dumps(rows), cycle_id))
        conn.commit()

    log.info("snapshot %s done: %s", cycle_id, rows)
    return {"cycle_id": cycle_id, "dataset_hash": dataset_hash, "rows": rows}


# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    p = argparse.ArgumentParser(description="Xyzo NN feature snapshot")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--cycle-id", help="Override auto-generated cycle_id")
    p.add_argument("--only", choices=list(MODEL_EXTRACTORS.keys()), help="Run one model only")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    if args.only:
        log.warning("--only flag is for future use; full snapshot runs all models")
    out = snapshot(cycle_id=args.cycle_id, dry_run=args.dry_run)
    json.dump(out, sys.stdout, default=str)
    sys.stdout.write("\n")
