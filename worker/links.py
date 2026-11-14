"""Story link detector — finds connections between news articles.

Link types (in priority order):
  1. same_city — articles about the same city
  2. same_country — articles about the same country
  3. same_entity — articles mentioning the same people/orgs
  4. same_topic — articles with matching word frequency topics
  5. same_source — articles from the same news source
  6. same_event — articles clustered into the same event
  7. manual — manually created links
  8. ai_detected — AI-detected links

Usage:
    from worker.links import detect_links, get_links_for_article
    detect_links(limit=500)  # detect links for recent articles
    links = get_links_for_article(article_id)  # get links for one article
"""
from __future__ import annotations

import json
import logging
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from .db import connect
from .word_freq import word_freq_from_json

log = logging.getLogger("xyzo.links")

# Minimum word overlap to consider articles related
WORD_OVERLAP_THRESHOLD = 3

# Maximum links per article
MAX_LINKS_PER_ARTICLE = 20


def _get_article_words(article_id: int) -> dict[str, int]:
    """Get word frequency for an article."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT word_freq FROM news_articles WHERE id = %s", (article_id,))
        row = cur.fetchone()
    if row and row.get("word_freq"):
        return word_freq_from_json(row["word_freq"])
    return {}


def _calculate_word_overlap(words1: dict[str, int], words2: dict[str, int]) -> tuple[int, list[str]]:
    """Calculate word overlap between two articles.

    Returns (overlap_count, [shared_words]).
    """
    common = set(words1.keys()) & set(words2.keys())
    # Weight by frequency — words that appear more in both articles score higher
    weighted = []
    for w in common:
        score = min(words1[w], words2[w])
        weighted.append((w, score))
    weighted.sort(key=lambda x: -x[1])
    overlap = sum(s for _, s in weighted[:10])
    shared = [w for w, _ in weighted[:10]]
    return overlap, shared


def detect_links_for_article(article_id: int, limit: int = 50) -> list[dict]:
    """Detect links for a single article against recent articles.

    Returns list of {target_id, link_type, link_strength, link_reason, city, country, entity, topic}.
    """
    with connect() as conn, conn.cursor() as cur:
        # Get the article
        cur.execute("""
            SELECT a.id, a.title, a.source_id, a.event_type,
                   a.extracted_lat, a.extracted_lng, a.extracted_location,
                   a.auto_categorize_city_label, a.word_freq,
                   s.country as source_country, s.name as source_name
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            WHERE a.id = %s
        """, (article_id,))
        article = cur.fetchone()

    if not article:
        return []

    links = []
    seen_targets = set()

    with connect() as conn, conn.cursor() as cur:
        # ── Link Type 1: Same City ──────────────────────────────────
        city_label = article.get("auto_categorize_city_label") or article.get("extracted_location")
        if city_label:
            cur.execute("""
                SELECT a.id, a.title, a.source_id
                FROM news_articles a
                WHERE a.id != %s
                  AND a.auto_categorize_city_label = %s
                  AND a.status = 'extracted'
                  AND a.fetched_at > now() - interval '7 days'
                ORDER BY a.fetched_at DESC
                LIMIT %s
            """, (article_id, city_label, limit))
            for row in cur.fetchall():
                if row["id"] not in seen_targets:
                    seen_targets.add(row["id"])
                    links.append({
                        "target_id": row["id"],
                        "target_title": row["title"],
                        "link_type": "same_city",
                        "link_strength": 0.9,
                        "link_reason": f"Both about {city_label}",
                        "city_name": city_label.split(",")[0].strip() if "," in city_label else city_label,
                        "country_code": city_label.split(", ")[-1].strip() if ", " in city_label else None,
                    })

        # ── Link Type 2: Same Country ───────────────────────────────
        # Same-country links now have variable strength based on recency
        # and keyword overlap. Fresh articles with shared keywords score higher.
        source_country = article.get("source_country")
        if source_country:
            cur.execute("""
                SELECT a.id, a.title, a.source_id, a.word_freq, a.published_at, a.fetched_at
                FROM news_articles a
                JOIN news_sources s ON s.id = a.source_id
                WHERE a.id != %s
                  AND s.country = %s
                  AND a.status = 'extracted'
                  AND a.fetched_at > now() - interval '7 days'
                  AND a.id NOT IN (SELECT unnest(%s::bigint[]))
                ORDER BY a.fetched_at DESC
                LIMIT %s
            """, (article_id, source_country, list(seen_targets) or [0], limit))
            for row in cur.fetchall():
                if row["id"] not in seen_targets:
                    seen_targets.add(row["id"])
                    # Score based on recency: fresh articles get higher base score
                    fetched_at = row.get("fetched_at") or row.get("published_at")
                    if fetched_at:
                        hours_old = (datetime.now(timezone.utc) - fetched_at.replace(tzinfo=timezone.utc)).total_seconds() / 3600
                        recency_score = max(0.0, 1.0 - hours_old / 168)  # 0 at 7 days, 1 at 0 hours
                    else:
                        recency_score = 0.3
                    strength = min(0.75, 0.45 + recency_score * 0.30)
                    links.append({
                        "target_id": row["id"],
                        "target_title": row["title"],
                        "link_type": "same_country",
                        "link_strength": round(strength, 2),
                        "link_reason": f"Both from {source_country} sources",
                        "country_code": source_country,
                    })

        # ── Link Type 3: Same Event ─────────────────────────────────
        # Check if articles share the same event cluster
        cur.execute("""
            SELECT e.event_id FROM news_event_sources e
            WHERE e.article_id = %s
        """, (article_id,))
        event_rows = cur.fetchall()
        for er in event_rows:
            event_id = er["event_id"]
            cur.execute("""
                SELECT a.id, a.title
                FROM news_event_sources es
                JOIN news_articles a ON a.id = es.article_id
                WHERE es.event_id = %s AND es.article_id != %s
                ORDER BY a.fetched_at DESC
                LIMIT %s
            """, (event_id, article_id, limit))
            for row in cur.fetchall():
                if row["id"] not in seen_targets:
                    seen_targets.add(row["id"])
                    links.append({
                        "target_id": row["id"],
                        "target_title": row["title"],
                        "link_type": "same_event",
                        "link_strength": 0.95,
                        "link_reason": f"Same event cluster",
                    })

    # ── Link Type 4: Word Overlap ───────────────────────────────────
    article_words = _get_article_words(article_id)
    if article_words:
        with connect() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT a.id, a.title, a.word_freq
                FROM news_articles a
                WHERE a.id != %s
                  AND a.status = 'extracted'
                  AND a.word_freq IS NOT NULL AND a.word_freq != '{}'::jsonb
                  AND a.fetched_at > now() - interval '7 days'
                  AND a.id NOT IN (SELECT unnest(%s::bigint[]))
                ORDER BY a.fetched_at DESC
                LIMIT 200
            """, (article_id, list(seen_targets) or [0]))
            for row in cur.fetchall():
                target_words = word_freq_from_json(row.get("word_freq", "{}"))
                if not target_words:
                    continue
                overlap, shared = _calculate_word_overlap(article_words, target_words)
                if overlap >= WORD_OVERLAP_THRESHOLD:
                    if row["id"] not in seen_targets:
                        seen_targets.add(row["id"])
                        links.append({
                            "target_id": row["id"],
                            "target_title": row["title"],
                            "link_type": "same_topic",
                            "link_strength": min(1.0, overlap / 10),
                            "link_reason": f"Shared topics: {', '.join(shared[:5])}",
                            "topic": shared[0] if shared else None,
                        })

    # Sort by strength and limit
    links.sort(key=lambda x: -x["link_strength"])
    return links[:MAX_LINKS_PER_ARTICLE]


def detect_links_batch(limit: int = 500) -> dict:
    """Detect and store links for recent articles.

    Returns {processed, links_created, links_skipped}.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id FROM news_articles
            WHERE status = 'extracted'
              AND fetched_at > now() - interval '7 days'
            ORDER BY fetched_at DESC
            LIMIT %s
        """, (limit,))
        article_ids = [r["id"] for r in cur.fetchall()]

    created = 0
    skipped = 0

    for aid in article_ids:
        links = detect_links_for_article(aid)
        for link in links:
            try:
                with connect() as conn, conn.cursor() as cur:
                    cur.execute("""
                        INSERT INTO news_story_links (
                            source_article_id, target_article_id, link_type,
                            link_strength, link_reason, city_name, country_code,
                            entity_name, topic, created_by
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'system')
                        ON CONFLICT (source_article_id, target_article_id, link_type) DO NOTHING
                    """, (
                        aid, link["target_id"], link["link_type"],
                        link["link_strength"], link.get("link_reason"),
                        link.get("city_name"), link.get("country_code"),
                        link.get("entity_name"), link.get("topic"),
                    ))
                    if cur.rowcount > 0:
                        created += 1
                    else:
                        skipped += 1
            except Exception as e:
                log.debug("link insert failed: %s", e)
                skipped += 1

    return {
        "processed": len(article_ids),
        "links_created": created,
        "links_skipped": skipped,
    }


def get_links_for_article(article_id: int) -> list[dict]:
    """Get all links for an article (both directions).

    Returns list of {link_id, target_id, target_title, link_type, link_strength, link_reason, ...}.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT l.id, l.link_type, l.link_strength, l.link_reason,
                   l.city_name, l.country_code, l.entity_name, l.topic,
                   l.created_by, l.created_at,
                   CASE WHEN l.source_article_id = %s THEN l.target_article_id ELSE l.source_article_id END as target_id,
                   a.title as target_title,
                   a.extracted_lat, a.extracted_lng, a.auto_categorize_city_label,
                   s.name as source_name, s.country as source_country
            FROM news_story_links l
            JOIN news_articles a ON a.id = CASE WHEN l.source_article_id = %s THEN l.target_article_id ELSE l.source_article_id END
            JOIN news_sources s ON s.id = a.source_id
            WHERE l.source_article_id = %s OR l.target_article_id = %s
            ORDER BY l.link_strength DESC
        """, (article_id, article_id, article_id, article_id))
        rows = cur.fetchall()

    return [{
        "link_id": r["id"],
        "target_id": r["target_id"],
        "target_title": r["target_title"],
        "link_type": r["link_type"],
        "link_strength": float(r["link_strength"]),
        "link_reason": r["link_reason"],
        "city_name": r["city_name"],
        "country_code": r["country_code"],
        "entity_name": r["entity_name"],
        "topic": r["topic"],
        "created_by": r["created_by"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "target_location": {
            "lat": float(r["extracted_lat"]) if r.get("extracted_lat") else None,
            "lng": float(r["extracted_lng"]) if r.get("extracted_lng") else None,
            "city": r.get("auto_categorize_city_label"),
        },
        "source_name": r["source_name"],
        "source_country": r["source_country"],
    } for r in rows]


def add_manual_link(source_id: int, target_id: int, reason: str = "") -> dict:
    """Add a manual link between two articles."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO news_story_links (
                source_article_id, target_article_id, link_type,
                link_strength, link_reason, created_by
            ) VALUES (%s, %s, 'manual', 1.0, %s, 'user')
            ON CONFLICT (source_article_id, target_article_id, link_type) DO UPDATE
                SET link_reason = %s, updated_at = now()
            RETURNING id
        """, (source_id, target_id, reason, reason))
        row = cur.fetchone()
        return {"ok": True, "link_id": row["id"] if row else None}


def delete_link(link_id: int) -> dict:
    """Delete a link."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM news_story_links WHERE id = %s RETURNING id", (link_id,))
        row = cur.fetchone()
    return {"ok": row is not None}


def get_links_stats() -> dict:
    """Get statistics about links."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT link_type, COUNT(*) as count,
                   AVG(link_strength) as avg_strength
            FROM news_story_links
            GROUP BY link_type
            ORDER BY count DESC
        """)
        by_type = cur.fetchall()

        cur.execute("SELECT COUNT(*) as total FROM news_story_links")
        total = cur.fetchone()["total"]

        cur.execute("""
            SELECT city_name, COUNT(*) as count
            FROM news_story_links
            WHERE city_name IS NOT NULL
            GROUP BY city_name
            ORDER BY count DESC
            LIMIT 20
        """)
        top_cities = cur.fetchall()

    return {
        "total_links": total,
        "by_type": [{"type": r["link_type"], "count": r["count"], "avg_strength": round(float(r["avg_strength"]), 2)} for r in by_type],
        "top_cities": [{"city": r["city_name"], "count": r["count"]} for r in top_cities],
    }
