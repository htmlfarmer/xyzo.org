"""High-Performance Story Connection Linker for xyzo.

Links articles covering the same event or related breaking developments
across different languages, regions, and topics.

Passes:
  1. Geo-Proximity & Cross-Language Fact Linker (same city/35km radius, 72h window)
  2. Multi-Keyword & Entity Overlap Linker (shared entities & keywords)
  3. Neural Embedding Cosine Linker (uses nn_article_embeddings)
  4. Event-Cluster Linker (articles already clustered by news_events system)
  5. Entity-Name Linker (articles sharing extracted entity names via article_facts)
  6. Temporal Burst Linker (near-simultaneous coverage of same location)

Database Table:
  news_story_links (source_article_id, target_article_id, link_type, link_strength, ...)
"""
from __future__ import annotations

import argparse
import logging
import math
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from .db import connect
from .geo_utils import haversine_km as _haversine_km

log = logging.getLogger("xyzo.story_linker")

SAME_EVENT_HOURS = 72
GEO_RADIUS_KM = 35.0


def _extract_proper_nouns(text: str) -> set[str]:
    """Extract proper nouns and key terms for cross-language comparison."""
    if not text:
        return set()
    nouns = set()
    for m in re.finditer(r'(?<!\.\s)(?<!\?\s)(?<!!\s)\b([A-Z][a-z]{1,})\b', text):
        word = m.group(1).lower()
        if len(word) > 2 and word not in {
            'the', 'and', 'for', 'but', 'not', 'you', 'all', 'can', 'her', 'was',
            'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its',
            'may', 'new', 'now', 'old', 'see', 'two', 'who', 'did', 'man', 'say',
            'she', 'too', 'use', 'with', 'from', 'they', 'this', 'that', 'have'
        }:
            nouns.add(word)
    return nouns


def _proper_noun_overlap(t1: str, t2: str) -> float:
    """Calculate proper noun overlap ratio between two titles."""
    n1 = _extract_proper_nouns(t1)
    n2 = _extract_proper_nouns(t2)
    if not n1 or not n2:
        return 0.0
    inter = n1 & n2
    smaller = min(len(n1), len(n2))
    return len(inter) / smaller if smaller > 0 else 0.0


def _title_word_similarity(t1: str, t2: str) -> float:
    """Word-level Jaccard similarity between two titles."""
    if not t1 or not t2:
        return 0.0
    w1 = set(re.findall(r'\w+', t1.lower()))
    w2 = set(re.findall(r'\w+', t2.lower()))
    stopwords = {
        'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is',
        'are', 'was', 'were', 'el', 'la', 'le', 'de', 'des', 'du', 'der', 'die',
        'das', 'il', 'lo', 'un', 'una', 'con', 'por', 'para', 'las', 'los'
    }
    w1 = {w for w in w1 if len(w) > 2 and w not in stopwords}
    w2 = {w for w in w2 if len(w) > 2 and w not in stopwords}
    if not w1 or not w2:
        return 0.0
    return len(w1 & w2) / len(w1 | w2)


def _word_freq_overlap(
    wf1: dict[str, float] | None,
    wf2: dict[str, float] | None,
    top_n: int = 25,
) -> tuple[float, set[str]]:
    """Weighted overlap between two articles' keyword-frequency maps.

    Numerator is total weight of shared top terms; denominator is total mass
    across the union of top terms (Weighted Jaccard).
    """
    if not wf1 or not wf2:
        return 0.0, set()

    def top(wf):
        return dict(sorted(wf.items(), key=lambda kv: kv[1], reverse=True)[:top_n])

    t1, t2 = top(wf1), top(wf2)
    shared = t1.keys() & t2.keys()
    if not shared:
        return 0.0, set()

    num = sum(min(t1[k], t2[k]) for k in shared)
    denom = sum(max(t1.get(k, 0), t2.get(k, 0)) for k in (t1.keys() | t2.keys()))
    return (num / denom if denom > 0 else 0.0), shared


def find_all_story_links(days: int = 3, limit: int = 2000) -> list[dict]:
    """Find all story connections across languages, locations, and keywords.

    Returns a list of dicts suitable for insertion into news_story_links.
    """
    since = datetime.now(timezone.utc) - timedelta(days=days)
    links: list[dict] = []

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT a.id, a.title, a.summary, a.event_type, a.detected_lang, a.word_freq,
                   a.published_at, a.fetched_at,
                   COALESCE(a.extracted_lat, l.lat) AS lat,
                   COALESCE(a.extracted_lng, l.lng) AS lng,
                   COALESCE(a.extracted_location, l.place_name) AS place_name,
                   s.country AS source_country, s.name AS source_name
            FROM news_articles a
            LEFT JOIN news_locations l ON l.id = a.location_id
            LEFT JOIN news_sources s ON s.id = a.source_id
            WHERE a.status = 'extracted'
              AND (a.extracted_lat IS NOT NULL OR a.location_id IS NOT NULL)
              AND COALESCE(a.published_at, a.fetched_at) > %s
            ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
            LIMIT %s
        """, (since, limit))
        articles = [dict(r) for r in cur.fetchall()]

    if len(articles) < 2:
        return []

    # ── Pass 1: Geographic & Cross-Language Fact Linker ───────────────
    # Group articles by country / spatial grid (~50km grid cells)
    grid: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for art in articles:
        lat = float(art["lat"]) if art.get("lat") is not None else None
        lng = float(art["lng"]) if art.get("lng") is not None else None
        if lat is not None and lng is not None:
            cell = (int(math.floor(lat * 2)), int(math.floor(lng * 2)))
            grid[cell].append(art)

    for cell, group in grid.items():
        if len(group) < 2:
            continue
        group.sort(key=lambda a: a.get("published_at") or a.get("fetched_at") or datetime.min.replace(tzinfo=timezone.utc))
        for i, a1 in enumerate(group):
            for a2 in group[i + 1:]:
                # Check time window (72 hours)
                t1 = a1.get("published_at") or a1.get("fetched_at")
                t2 = a2.get("published_at") or a2.get("fetched_at")
                if t1 and t2 and abs((t1 - t2).total_seconds()) > SAME_EVENT_HOURS * 3600:
                    continue

                # Check geographic distance (within 35km)
                dist = _haversine_km(float(a1["lat"]), float(a1["lng"]), float(a2["lat"]), float(a2["lng"]))
                if dist > GEO_RADIUS_KM:
                    continue

                noun_sim = _proper_noun_overlap(a1.get("title") or "", a2.get("title") or "")
                word_sim = _title_word_similarity(a1.get("title") or "", a2.get("title") or "")
                kw_sim, shared_kws = _word_freq_overlap(a1.get("word_freq"), a2.get("word_freq"))
                title_score = max(noun_sim, word_sim, kw_sim)

                # Same event_type bonus
                evt_bonus = 0.15 if a1.get("event_type") and a1.get("event_type") == a2.get("event_type") else 0.0
                cross_lang_bonus = 0.10 if a1.get("detected_lang") and a2.get("detected_lang") and a1["detected_lang"] != a2["detected_lang"] else 0.0

                strength = min(0.98, 0.45 + title_score * 0.45 + evt_bonus + cross_lang_bonus)

                # same_event fires for: cross-language OR (same event_type AND noun overlap >= 0.3)
                is_same_event = cross_lang_bonus > 0 or (evt_bonus > 0 and noun_sim >= 0.30)

                # FIX_NOTES 7.5: the old gate was `strength < 0.45 and ...` —
                # strength has a 0.45 floor by construction, so it was always
                # False and ANY two articles within 35 km / 72 h got a
                # same_city link with zero shared words (the 1.39 M-row flood).
                # Real filter: require title overlap UNLESS the pair is a
                # genuine same-event cross-language match.
                if title_score < 0.10 and not is_same_event:
                    continue
                link_type = "same_event" if is_same_event else "same_city"
                reason = f"Same location ({a1.get('place_name') or 'nearby'}) within 72h ({int(dist)}km)"
                if shared_kws:
                    reason += f"; shared: {', '.join(sorted(shared_kws)[:5])}"

                src_id = min(a1["id"], a2["id"])
                tgt_id = max(a1["id"], a2["id"])
                links.append({
                    "source_article_id": src_id,
                    "target_article_id": tgt_id,
                    "link_type": link_type,
                    "link_strength": round(strength, 2),
                    "link_reason": reason,
                    "city_name": a1.get("place_name") or a2.get("place_name"),
                    "country_code": a1.get("source_country") or a2.get("source_country"),
                    "topic": a1.get("event_type") or a2.get("event_type"),
                })

    # ── Pass 2: Keyword Linker via word_freq Inverted Index ─────────
    TOP_KEYWORDS_PER_ARTICLE = 12
    keyword_index: dict[str, list[dict]] = defaultdict(list)
    for art in articles:
        wf = art.get("word_freq") or {}
        if not wf:
            continue
        top_kws = sorted(wf.items(), key=lambda kv: kv[1], reverse=True)[:TOP_KEYWORDS_PER_ARTICLE]
        for k, _ in top_kws:
            keyword_index[k].append(art)

    seen_pairs: set[tuple[int, int]] = set()
    for keyword, group in keyword_index.items():
        if len(group) < 2:
            continue
        # Skip generic boilerplate keywords shared by > 60 articles
        if len(group) > 60:
            continue
        for i, a1 in enumerate(group):
            for a2 in group[i + 1:]:
                pair_key = (min(a1["id"], a2["id"]), max(a1["id"], a2["id"]))
                if pair_key in seen_pairs:
                    continue
                seen_pairs.add(pair_key)

                kw_sim, shared_kws = _word_freq_overlap(a1.get("word_freq"), a2.get("word_freq"))
                noun_sim = _proper_noun_overlap(a1.get("title") or "", a2.get("title") or "")
                word_sim = _title_word_similarity(a1.get("title") or "", a2.get("title") or "")
                title_score = max(kw_sim, noun_sim, word_sim)
                if title_score < 0.20:
                    continue

                same_topic = bool(a1.get("event_type")) and a1.get("event_type") == a2.get("event_type")
                cross_lang_bonus = 0.10 if a1.get("detected_lang") and a2.get("detected_lang") and a1["detected_lang"] != a2["detected_lang"] else 0.0
                strength = min(0.95, 0.45 + title_score * 0.45 + (0.05 if same_topic else 0.0) + cross_lang_bonus)

                links.append({
                    "source_article_id": pair_key[0],
                    "target_article_id": pair_key[1],
                    "link_type": "same_topic",
                    "link_strength": round(strength, 2),
                    "link_reason": f"Shared keywords: {', '.join(sorted(shared_kws)[:5]) or keyword}",
                    "city_name": a1.get("place_name") or a2.get("place_name"),
                    "country_code": a1.get("source_country") or a2.get("source_country"),
                    "topic": a1.get("event_type") or a2.get("event_type"),
                })

    # ── Pass 3: Semantic Linker via pgvector ANN Search ──────────────
    embed_links = _link_via_embeddings(days=days, limit=limit)
    links.extend(embed_links)
    if embed_links:
        log.info("story_linker: embedding pass added %d candidate links", len(embed_links))

    # ── Pass 4: Event-Cluster Linker ─────────────────────────────────
    # The news_events system already clustered articles by event.
    # Articles sharing the same event_id are definitively about the same story.
    # This captures 440K+ pairs that geo/keyword passes miss.
    event_links = _link_via_events(articles, days=days)
    links.extend(event_links)
    if event_links:
        log.info("story_linker: event-cluster pass added %d same_event links", len(event_links))

    # ── Pass 5: Entity-Name Linker via article_facts ───────────────────
    # Articles whose article_facts share extracted entity names (person/org names).
    # We fuzzy-match article_facts.entities against news_entities.name for QID linking.
    entity_links = _link_via_article_entities(articles, days=days)
    links.extend(entity_links)
    if entity_links:
        log.info("story_linker: entity-name pass added %d same_entity links", len(entity_links))

    # ── Pass 6: Temporal Burst Linker ─────────────────────────────────
    # Breaking news: many sources covering same location within a short window.
    # Articles within 50km AND published within 6h of each other get a same_event link.
    # Note: only run for smaller article sets to avoid expensive self-join.
    burst_links = []
    if len(articles) <= 50000:
        try:
            burst_links = _link_via_temporal_burst(articles, days=days)
        except Exception as e:
            log.warning("story_linker: temporal burst pass failed (%s) — skipping", e)
    links.extend(burst_links)
    if burst_links:
        log.info("story_linker: temporal burst pass added %d links", len(burst_links))

    # Deduplicate by (source_article_id, target_article_id, link_type)
    seen = set()
    unique_links = []
    for l in links:
        key = (l["source_article_id"], l["target_article_id"], l["link_type"])
        if key not in seen:
            seen.add(key)
            unique_links.append(l)

    unique_links.sort(key=lambda x: x["link_strength"], reverse=True)
    return unique_links[:limit]


EMBED_K_NEIGHBORS = 8
EMBED_SIM_THRESHOLD = 0.80


def _link_via_embeddings(days: int, limit: int) -> list[dict]:
    """Pass 3: semantic linker via pgvector ANN search.

    Uses nn_article_sentence_embeddings (384-dim all-MiniLM-L6-v2) to
    catch same-event articles that share no literal keywords across
    languages and transliterations. Falls back to nn_article_embeddings
    (16-dim internal model) if sentence embeddings are unavailable.
    """
    since = datetime.now(timezone.utc) - timedelta(days=days)
    links: list[dict] = []

    # Try sentence embeddings first (384-dim, much better cross-language)
    table = "nn_article_sentence_embeddings"
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM nn_article_sentence_embeddings LIMIT 1"
            )
            if cur.fetchone() is None:
                # Table exists but is empty — try fallback
                table = "nn_article_embeddings"
                cur.execute(
                    "SELECT 1 FROM nn_article_embeddings LIMIT 1"
                )
                if cur.fetchone() is None:
                    log.info("story_linker: no embeddings available yet")
                    return []
    except Exception:
        log.info("story_linker: sentence embeddings table not available")
        return []

    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute("SET LOCAL hnsw.ef_search = 40;")
            cur.execute(f"""
                SELECT
                    a1.id AS source_id,
                    nn.target_id,
                    nn.sim,
                    a1.detected_lang AS source_lang,
                    a1.event_type AS source_topic,
                    a2t.detected_lang AS target_lang,
                    COALESCE(a1.extracted_location, l1.place_name) AS source_place,
                    COALESCE(a2t.extracted_location, l2.place_name) AS target_place,
                    s1.country AS source_country
                FROM news_articles a1
                JOIN {table} e1 ON e1.article_id = a1.id
                LEFT JOIN news_locations l1 ON l1.id = a1.location_id
                LEFT JOIN news_sources s1 ON s1.id = a1.source_id
                JOIN LATERAL (
                    SELECT
                        e2.article_id AS target_id,
                        1 - (e2.vector <=> e1.vector) AS sim
                    FROM {table} e2
                    JOIN news_articles a2 ON a2.id = e2.article_id
                    WHERE a2.status = 'extracted'
                      AND COALESCE(a2.published_at, a2.fetched_at) > %(since)s
                      AND e2.article_id != e1.article_id
                    ORDER BY e2.vector <=> e1.vector
                    LIMIT %(k)s
                ) nn ON true
                JOIN news_articles a2t ON a2t.id = nn.target_id
                LEFT JOIN news_locations l2 ON l2.id = a2t.location_id
                WHERE a1.status = 'extracted'
                  AND COALESCE(a1.published_at, a1.fetched_at) > %(since)s
                  AND nn.sim >= %(threshold)s
                ORDER BY nn.sim DESC
                LIMIT %(limit)s
            """, {"since": since, "k": EMBED_K_NEIGHBORS, "threshold": EMBED_SIM_THRESHOLD, "limit": limit})
            rows = [dict(r) for r in cur.fetchall()]
    except Exception as e:
        log.warning("story_linker: embedding pass unavailable (%s) — skipping", e)
        return []

    for r in rows:
        src_id = min(r["source_id"], r["target_id"])
        tgt_id = max(r["source_id"], r["target_id"])
        cross_lang = bool(r["source_lang"]) and bool(r["target_lang"]) and r["source_lang"] != r["target_lang"]
        cross_lang_bonus = 0.10 if cross_lang else 0.0
        strength = min(0.97, 0.50 + float(r["sim"]) * 0.45 + cross_lang_bonus)

        links.append({
            "source_article_id": src_id,
            "target_article_id": tgt_id,
            "link_type": "semantic_similarity",
            "link_strength": round(strength, 2),
            "link_reason": f"Semantic similarity {float(r['sim']):.2f}" + (" (cross-language)" if cross_lang else ""),
            "city_name": r["source_place"] or r["target_place"],
            "country_code": r["source_country"],
            "topic": r["source_topic"],
        })

    seen = set()
    unique = []
    for l in links:
        key = (l["source_article_id"], l["target_article_id"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(l)
    return unique


def _link_via_events(articles: list[dict], days: int) -> list[dict]:
    """Pass 4: same_event linker via news_event_sources table.

    The event clustering system has already grouped articles by story.
    Articles sharing an event_id are definitively the same story.
    """
    since = datetime.now(timezone.utc) - timedelta(days=days)
    article_ids = [a["id"] for a in articles]
    if not article_ids:
        return []

    links: list[dict] = []
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT es1.article_id AS a_id, es2.article_id AS b_id,
                   e.id AS event_id, e.event_type, e.headline,
                   COALESCE(a1.extracted_location, l1.place_name) AS place,
                   s1.country AS country
            FROM news_event_sources es1
            JOIN news_event_sources es2 ON es1.event_id = es2.event_id
              AND es1.article_id < es2.article_id
            JOIN news_events e ON e.id = es1.event_id
            JOIN news_articles a1 ON a1.id = es1.article_id
            LEFT JOIN news_locations l1 ON l1.id = a1.location_id
            LEFT JOIN news_sources s1 ON s1.id = a1.source_id
            WHERE es1.article_id = ANY(%s)
              AND es2.article_id = ANY(%s)
              AND e.status = 'active'
              AND (e.expires_at IS NULL OR e.expires_at > now())
              AND COALESCE(a1.published_at, a1.fetched_at) > %s
            ORDER BY e.first_reported_at DESC
            LIMIT 100000
        """, (article_ids, article_ids, since))
        rows = [dict(r) for r in cur.fetchall()]

        for r in rows:
            src_id = min(r["a_id"], r["b_id"])
            tgt_id = max(r["a_id"], r["b_id"])
            link_type = "same_event"
            strength = 0.92
            reason = f"Same event cluster #{r['event_id']}"
            if r.get("event_type"):
                reason += f" ({r['event_type']})"
            if r.get("headline"):
                reason += f": {r['headline'][:50]}"

            links.append({
                "source_article_id": src_id,
                "target_article_id": tgt_id,
                "link_type": link_type,
                "link_strength": round(strength, 2),
                "link_reason": reason,
                "city_name": r.get("place"),
                "country_code": r.get("country"),
                "topic": r.get("event_type"),
            })

    return links


def _link_via_article_entities(articles: list[dict], days: int) -> list[dict]:
    """Pass 5: same_entity linker via article_facts entity names.

    Matches articles that share extracted entity names from article_facts.entities.
    More shared entities = stronger link. Entity overlap is more precise than
    keyword overlap because entities are real people/orgs/places.
    """
    since = datetime.now(timezone.utc) - timedelta(days=days)
    links: list[dict] = []

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT af1.article_id AS a_id, af2.article_id AS b_id,
                   af1.entities AS entities1, af2.entities AS entities2,
                   a1.detected_lang AS lang1, a2.detected_lang AS lang2,
                   a1.event_type AS evt1, a2.event_type AS evt2,
                   COALESCE(a1.extracted_location, l1.place_name) AS place1,
                   COALESCE(a2.extracted_location, l2.place_name) AS place2,
                   s1.country AS country
            FROM article_facts af1
            JOIN article_facts af2 ON af1.article_id < af2.article_id
              AND af1.entities IS NOT NULL AND af2.entities IS NOT NULL
              AND jsonb_array_length(af1.entities) BETWEEN 1 AND 20
              AND jsonb_array_length(af2.entities) BETWEEN 1 AND 20
            JOIN news_articles a1 ON a1.id = af1.article_id
            JOIN news_articles a2 ON a2.id = af2.article_id
            LEFT JOIN news_locations l1 ON l1.id = a1.location_id
            LEFT JOIN news_locations l2 ON l2.id = a2.location_id
            LEFT JOIN news_sources s1 ON s1.id = a1.source_id
            WHERE af1.article_id = ANY(%s)
              AND af2.article_id = ANY(%s)
              AND COALESCE(a1.published_at, a1.fetched_at) > %s
              AND COALESCE(a2.published_at, a2.fetched_at) > %s
            ORDER BY af1.article_id
            LIMIT 50000
        """, ([a["id"] for a in articles], [a["id"] for a in articles], since, since))
        rows = [dict(r) for r in cur.fetchall()]

        for r in rows:
            entities1 = r.get("entities1") or []
            entities2 = r.get("entities2") or []
            if not entities1 or not entities2:
                continue
            shared = set(entities1) & set(entities2)
            if len(shared) < 2:
                continue
            total = len(entities1) + len(entities2) - len(shared)
            jaccard = len(shared) / total if total > 0 else 0.0

            same_type_bonus = 0.08 if r.get("evt1") and r.get("evt1") == r.get("evt2") else 0.0
            cross_lang = bool(r.get("lang1")) and bool(r.get("lang2")) and r.get("lang1") != r.get("lang2")
            cross_lang_bonus = 0.08 if cross_lang else 0.0

            strength = min(0.95, 0.52 + jaccard * 0.35 + same_type_bonus + cross_lang_bonus)
            src_id = min(r["a_id"], r["b_id"])
            tgt_id = max(r["a_id"], r["b_id"])

            links.append({
                "source_article_id": src_id,
                "target_article_id": tgt_id,
                "link_type": "same_entity",
                "link_strength": round(strength, 2),
                "link_reason": f"Shared entities: {', '.join(sorted(shared)[:5])}",
                "city_name": r.get("place1") or r.get("place2"),
                "country_code": r.get("country"),
                "topic": r.get("evt1"),
            })

    return links


def _link_via_temporal_burst(articles: list[dict], days: int) -> list[dict]:
    """Pass 6: Temporal Burst Linker for breaking news detection.

    Articles covering the same location within a short time window (6h)
    are likely covering the same breaking event. This catches cases where
    the geo pass might miss due to slightly different location tags
    (e.g., 'Downtown' vs 'City Center' for the same incident).
    """
    since = datetime.now(timezone.utc) - timedelta(days=days)
    links: list[dict] = []

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            WITH article_locs AS (
                SELECT a.id AS article_id,
                       COALESCE(a.extracted_lat, l.lat) AS lat,
                       COALESCE(a.extracted_lng, l.lng) AS lng,
                       a.published_at, a.fetched_at, a.event_type,
                       a.detected_lang, a.title,
                       COALESCE(a.extracted_location, l.place_name) AS place_name,
                       s.country
                FROM news_articles a
                LEFT JOIN news_locations l ON l.id = a.location_id
                LEFT JOIN news_sources s ON s.id = a.source_id
                WHERE a.id = ANY(%s)
                  AND COALESCE(a.published_at, a.fetched_at) > %s
                  AND (a.extracted_lat IS NOT NULL OR l.lat IS NOT NULL)
            ),
            burst_pairs AS (
                SELECT DISTINCT ON (LEAST(al.article_id, ar.article_id),
                                    GREATEST(al.article_id, ar.article_id))
                       al.article_id AS a_id, ar.article_id AS b_id,
                       al.lat AS lat1, al.lng AS lng1,
                       ar.lat AS lat2, ar.lng AS lng2,
                       al.event_type AS evt1, ar.event_type AS evt2,
                       al.detected_lang AS lang1, ar.detected_lang AS lang2,
                       al.place_name AS place1, ar.place_name AS place2,
                       al.country AS country,
                       al.title AS title1, ar.title AS title2,
                       ST_Distance(
                         ST_SetSRID(ST_MakePoint(al.lng, al.lat), 4326)::geography,
                         ST_SetSRID(ST_MakePoint(ar.lng, ar.lat), 4326)::geography
                       ) / 1000 AS dist_km
                FROM article_locs al
                JOIN article_locs ar ON al.article_id < ar.article_id
                  AND al.lat IS NOT NULL AND al.lng IS NOT NULL
                  AND ar.lat IS NOT NULL AND ar.lng IS NOT NULL
                  AND ABS(EXTRACT(EPOCH FROM (GREATEST(ar.published_at, ar.fetched_at) -
                                             GREATEST(al.published_at, al.fetched_at))) / 3600) <= 6
                  AND ST_DWithin(
                    ST_SetSRID(ST_MakePoint(al.lng, al.lat), 4326)::geography,
                    ST_SetSRID(ST_MakePoint(ar.lng, ar.lat), 4326)::geography,
                    50000
                  )
            )
            SELECT a_id, b_id, lat1, lng1, lat2, lng2, evt1, evt2,
                   lang1, lang2, place1, place2, country, title1, title2,
                   dist_km
            FROM burst_pairs
            ORDER BY a_id
            LIMIT 50000
        """, ([a["id"] for a in articles], since))
        rows = [dict(r) for r in cur.fetchall()]

        for r in rows:
            dist = r.get("dist_km") or 999
            noun_sim = _proper_noun_overlap(r.get("title1") or "", r.get("title2") or "")
            same_evt = bool(r.get("evt1")) and r.get("evt1") == r.get("evt2")
            cross_lang = bool(r.get("lang1")) and bool(r.get("lang2")) and r.get("lang1") != r.get("lang2")

            noun_bonus = noun_sim * 0.25
            evt_bonus = 0.10 if same_evt else 0.0
            cross_bonus = 0.08 if cross_lang else 0.0
            base = 0.55 if dist <= 25 else 0.50

            strength = min(0.95, base + noun_bonus + evt_bonus + cross_bonus)
            if strength < 0.58:
                continue

            src_id = min(r["a_id"], r["b_id"])
            tgt_id = max(r["a_id"], r["b_id"])
            link_type = "same_event" if (same_evt or cross_lang) else "same_city"

            links.append({
                "source_article_id": src_id,
                "target_article_id": tgt_id,
                "link_type": link_type,
                "link_strength": round(strength, 2),
                "link_reason": f"Temporal burst: {int(dist)}km apart, within 6h window",
                "city_name": r.get("place1") or r.get("place2"),
                "country_code": r.get("country"),
                "topic": r.get("evt1") or r.get("evt2"),
            })

    return links


def store_story_links(links: list[dict]) -> int:
    """Store story links in bulk using psycopg3 executemany.
    
    Executes batched bulk upserts in pages of 500 rows for high-speed database writes.
    """
    if not links:
        return 0

    rows = [
        (
            l["source_article_id"], l["target_article_id"], l["link_type"],
            l["link_strength"], l["link_reason"], l.get("city_name"),
            l.get("country_code"), l.get("topic"),
        )
        for l in links
    ]

    sql = """
        INSERT INTO news_story_links (
            source_article_id, target_article_id, link_type,
            link_strength, link_reason, city_name, country_code, topic, created_by
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'auto_linker')
        ON CONFLICT (source_article_id, target_article_id, link_type)
        DO UPDATE SET
            link_strength = EXCLUDED.link_strength,
            link_reason = EXCLUDED.link_reason,
            updated_at = now()
    """

    total_inserted = 0
    batch_size = 500

    with connect() as conn:
        with conn.cursor() as cur:
            for i in range(0, len(rows), batch_size):
                batch = rows[i : i + batch_size]
                try:
                    cur.executemany(sql, batch)
                    conn.commit()
                    total_inserted += len(batch)
                except Exception as e:
                    conn.rollback()
                    log.error("store_story_links: bulk insert batch failed (%d..%d): %s",
                              i, i + len(batch), e)

    return total_inserted


def run(days: int = 3, limit: int = 2000, dry_run: bool = False) -> dict:
    """Run the story linker pass."""
    log.info("story_linker: starting (days=%d, limit=%d, dry_run=%s)", days, limit, dry_run)

    links = find_all_story_links(days=days, limit=limit)
    log.info("story_linker: found %d story links", len(links))

    if dry_run:
        return {"links_found": len(links), "links_stored": 0, "dry_run": True, "sample": links[:5]}

    stored = store_story_links(links)
    log.info("story_linker: stored %d links in news_story_links", stored)

    return {"links_found": len(links), "links_stored": stored}


def main():
    parser = argparse.ArgumentParser(description="Xyzo High-Performance Story Linker")
    parser.add_argument("--days", type=int, default=3, help="Look back N days")
    parser.add_argument("--limit", type=int, default=2000, help="Max links to process")
    parser.add_argument("--dry-run", action="store_true", help="Show matches without DB writes")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    result = run(days=args.days, limit=args.limit, dry_run=args.dry_run)
    import json
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
