"""City-Story Intelligence Pipeline

Architecture (layered, increasing cost):
  Level 0:    SQL/PostGIS geographic features
  Level 0.5:  Explicit textual signals (names, aliases, Wikidata entities)
  Level 1:    Small ML classifier (place_presence)
  Level 2:    Embedding semantic similarity (place_relevance)
  Level 3:    Graph/Wikidata entity neighborhoods
  Level 4:    Gemma for ambiguous cases

Candidate funnel:
  article → millions of cities
         → 50 candidates (geographic + textual)
         → 10 candidates (small ML)
         → 3 candidates (embeddings)
         → final (graph + optional Gemma)
"""

import json
import logging
import math
import os
import re
from datetime import datetime, timezone
from typing import Any

from .db import connect

log = logging.getLogger("xyzo.city_story_intel")

SCHEMA_VERSION = "v1"
CANDIDATE_CITIES_LIMIT = 50
ML_CANDIDATES_LIMIT = 10
EMBEDDING_CANDIDATES_LIMIT = 3

# ─── Level 0: Geographic Features ─────────────────────────────────────────────


def extract_geographic_features(
    article_id: int,
    article_lat: float | None,
    article_lng: float | None,
    article_country: str | None,
    article_admin1: str | None,
) -> list[dict[str, Any]]:
    """Extract geographic features for article vs all candidate cities.

    Uses PostGIS ST_DWithin + ST_Distance for efficient candidate generation
    and precise distance calculation.

    Returns list of dicts with:
      city_id, geographic_distance_m, geographic_contained,
      same_country, same_admin1, city_population
    """
    if article_lat is None or article_lng is None:
        return []

    features = []

    with connect() as conn:
        rows = conn.execute(
            """
            WITH article_point AS (
                SELECT ST_SetSRID(ST_MakePoint(%(lng)s, %(lat)s), 4326)::geography AS point,
                       %(country)s AS article_country,
                       %(admin1)s AS article_admin1
            ),
            nearby_cities AS (
                -- Find cities within 500km that have population >= 100k
                -- Order by distance to get closest first
                SELECT
                    wc.id AS city_id,
                    wc.name AS city_name,
                    wc.country_code,
                    wc.admin1_code,
                    wc.population,
                    ST_Distance(
                        ap.point,
                        wc.geom
                    ) AS distance_m,
                    -- Is article point contained in city boundary?
                    -- For now, simplified: within 5km = "contained"
                    CASE
                        WHEN ST_Distance(
                            ap.point,
                            wc.geom
                        ) < 5000 THEN TRUE
                        ELSE FALSE
                    END AS geographic_contained
                FROM article_point ap
                CROSS JOIN LATERAL (
                    SELECT id, name, country_code, admin1_code, population, lat, lng, geom
                    FROM world_cities
                    WHERE population >= 100000
                    ORDER BY geom <-> ap.point
                    LIMIT %(limit)s
                ) wc
            )
            SELECT
                nc.city_id,
                nc.city_name,
                nc.country_code,
                nc.admin1_code,
                nc.population,
                nc.distance_m,
                nc.geographic_contained,
                nc.country_code = ap.article_country AS same_country,
                nc.admin1_code = ap.article_admin1 AS same_admin1
            FROM nearby_cities nc
            CROSS JOIN article_point ap
            ORDER BY nc.distance_m ASC;
            """,
            {
                "lat": article_lat,
                "lng": article_lng,
                "country": article_country,
                "admin1": article_admin1,
                "limit": CANDIDATE_CITIES_LIMIT,
            },
        ).fetchall()

    for row in rows:
        features.append({
            "city_id": row["city_id"],
            "geographic_distance_m": row["distance_m"],
            "geographic_contained": row["geographic_contained"],
            "same_country": row["same_country"],
            "same_admin1": row["same_admin1"],
            "city_population": row["population"],
        })

    return features


def compute_distance_score(distance_m: float) -> float:
    """Convert distance to a 0-1 score (closer = higher)."""
    if distance_m is None:
        return 0.0
    # 100km = 100,000m
    # Using exponential decay: score = exp(-distance / 100km)
    return math.exp(-distance_m / 100_000)


def compute_geographic_score(features: dict[str, Any]) -> float:
    """Compute aggregate geographic score from features."""
    score = 0.0
    weights = {
        "geographic_contained": 1.0,
        "geographic_distance_m": 0.5,
        "same_country": 0.3,
        "same_admin1": 0.4,
        "city_population": 0.1,
    }

    # Contained is binary strong signal
    if features.get("geographic_contained"):
        return 1.0

    # Distance score
    dist_score = compute_distance_score(features.get("geographic_distance_m"))
    score += weights["geographic_distance_m"] * dist_score

    # Country match
    if features.get("same_country"):
        score += weights["same_country"]

    # Admin1 match
    if features.get("same_admin1"):
        score += weights["same_admin1"]

    # Population normalized (log scale)
    pop = features.get("city_population") or 0
    if pop > 0:
        pop_score = min(1.0, math.log10(pop) / 7)  # 10M = 1.0, 100k = 0.5
        score += weights["city_population"] * pop_score

    return min(1.0, score)


# ─── Level 0.5: Textual Signals ───────────────────────────────────────────────


def extract_textual_features(
    article_id: int,
    title: str,
    body: str | None,
    entities: list[str],
) -> dict[int, dict[str, Any]]:
    """Extract explicit textual signals for article vs candidate cities.

    Checks for:
    - City name mentions
    - City alias matches
    - Country/region mentions
    - Known entity matches (from Wikidata neighborhood)

    Returns dict mapping city_id -> {direct_city_name, city_alias_match,
    country_name, region_name, capital_indicator, landmark_entity,
    org_entity, person_in_city}
    """
    text = f"{title} {body[:1000] if body else ''}".lower()

    # Normalize text for matching
    text_normalized = re.sub(r'\s+', ' ', text)

    features_by_city = {}

    with connect() as conn:
        # Get candidate cities (already identified by geographic proximity)
        # and their aliases
        rows = conn.execute(
            """
            SELECT
                wc.id AS city_id,
                wc.name AS city_name,
                wc.ascii_name,
                wc.country_code,
                wc.admin1_code,
                ca.alias
            FROM world_cities wc
            LEFT JOIN city_aliases ca ON ca.city_id = wc.id
            WHERE wc.id = ANY(%(city_ids)s)
            ORDER BY wc.id, wc.population DESC
            """,
            {"city_ids": [f["city_id"] for f in []]},  # Will be filled by caller
        ).fetchall()

    # Build feature sets per city
    city_features = {}

    for row in rows:
        city_id = row["city_id"]
        if city_id not in city_features:
            city_features[city_id] = {
                "city_name": row["city_name"].lower(),
                "ascii_name": row["ascii_name"].lower() if row["ascii_name"] else None,
                "country_code": row["country_code"],
                "admin1_code": row["admin1_code"],
                "direct_city_name": False,
                "city_alias_match": False,
                "aliases": set(),
            }

        if row["alias"]:
            city_features[city_id]["aliases"].add(row["alias"].lower())

    # Check each city against the text
    for city_id, cf in city_features.items():
        # City name match (exact or word boundary)
        name = cf["city_name"]
        ascii_name = cf["ascii_name"]

        # Word boundary match for city name
        pattern = r'\b' + re.escape(name) + r'\b'
        if re.search(pattern, text_normalized):
            cf["direct_city_name"] = True

        # ASCII name match
        if ascii_name and ascii_name != name:
            pattern = r'\b' + re.escape(ascii_name) + r'\b'
            if re.search(pattern, text_normalized):
                cf["direct_city_name"] = True

        # Alias matches
        for alias in cf["aliases"]:
            pattern = r'\b' + re.escape(alias) + r'\b'
            if re.search(pattern, text_normalized):
                cf["city_alias_match"] = True
                break

        # Convert set to list for JSON
        cf["aliases"] = list(cf["aliases"])

    # Now check entity mentions against known entities per city
    # (This requires city_entity_neighborhoods - populated later)
    # For now, just return the basic textual features

    return city_features


def compute_textual_score(features: dict[str, Any]) -> float:
    """Compute aggregate textual score from features."""
    score = 0.0

    if features.get("direct_city_name"):
        score += 0.5

    if features.get("city_alias_match"):
        score += 0.3

    if features.get("capital_indicator"):
        score += 0.2

    if features.get("landmark_entity"):
        score += 0.4

    if features.get("org_entity"):
        score += 0.3

    if features.get("person_in_city"):
        score += 0.2

    return min(1.0, score)


# ─── Combined Feature Extraction ───────────────────────────────────────────────


def extract_features_for_article(
    article_id: int,
    title: str,
    body: str | None,
    entities: list[str],
    article_lat: float | None,
    article_lng: float | None,
    article_country: str | None,
    article_admin1: str | None,
) -> list[dict[str, Any]]:
    """Extract all Level 0 + 0.5 features for an article.

    Returns list of feature dicts, one per candidate city.
    """
    # Level 0: Geographic features
    geo_features = extract_geographic_features(
        article_id, article_lat, article_lng, article_country, article_admin1
    )

    if not geo_features:
        return []

    city_ids = [f["city_id"] for f in geo_features]

    # Level 0.5: Textual features
    textual_features = extract_textual_features(
        article_id, title, body, entities
    )

    # Combine
    combined = []
    for gf in geo_features:
        city_id = gf["city_id"]
        tf = textual_features.get(city_id, {})

        combined.append({
            "story_id": article_id,
            "city_id": city_id,
            # Geographic
            "geographic_distance_m": gf.get("geographic_distance_m"),
            "geographic_contained": gf.get("geographic_contained"),
            "same_country": gf.get("same_country"),
            "same_admin1": gf.get("same_admin1"),
            "city_population": gf.get("city_population"),
            # Textual
            "direct_city_name": tf.get("direct_city_name", False),
            "city_alias_match": tf.get("city_alias_match", False),
            "country_name": False,  # Filled by entity matching
            "region_name": False,
            "capital_indicator": False,
            "landmark_entity": False,
            "org_entity": False,
            "person_in_city": False,
            # Source signals (default False, filled by source lookup)
            "source_in_city": False,
            "source_country_match": False,
            "source_region_match": False,
            # Entity signals (default, filled by Wikidata matching)
            "wikidata_entity_count": 0,
            "entity_match_score": 0.0,
            "institution_match": False,
            "landmark_match": False,
            # Topic signals
            "topic_city_relevance": 0.0,
            "body_length": len(body) if body else 0,
            # Embedding signals (filled by embedding layer)
            "embedding_similarity": 0.0,
            "embedding_general": 0.0,
            "embedding_economy": 0.0,
            "embedding_science": 0.0,
            "embedding_politics": 0.0,
            "embedding_culture": 0.0,
            "embedding_transport": 0.0,
            "embedding_environment": 0.0,
            # Temporal
            "published_hour_local": 12,
            "weekend_published": False,
            # Aggregate (filled after ML)
            "presence_score": 0.0,
            "relevance_score": 0.0,
            # Feature version
            "feature_version": SCHEMA_VERSION,
        })

    return combined


# ─── Feature Storage ───────────────────────────────────────────────────────────


def store_features(features: list[dict[str, Any]], extraction_run_id: int | None = None) -> int:
    """Store extracted features in city_story_features table.

    Returns number of rows inserted.
    """
    if not features:
        return 0

    count = 0
    with connect() as conn:
        for feat in features:
            feat_copy = dict(feat)
            feat_copy["extraction_run_id"] = extraction_run_id
            conn.execute(
                """
                INSERT INTO city_story_features (
                    story_id, city_id, extraction_run_id,
                    geographic_distance_m, geographic_contained,
                    same_country, same_admin1, city_population,
                    direct_city_name, city_alias_match,
                    country_name, region_name, capital_indicator,
                    landmark_entity, org_entity, person_in_city,
                    source_in_city, source_country_match, source_region_match,
                    wikidata_entity_count, entity_match_score,
                    institution_match, landmark_match,
                    topic_city_relevance, body_length,
                    embedding_similarity,
                    embedding_general, embedding_economy, embedding_science,
                    embedding_politics, embedding_culture, embedding_transport,
                    embedding_environment,
                    published_hour_local, weekend_published,
                    presence_score, relevance_score,
                    feature_version
                ) VALUES (
                    %(story_id)s, %(city_id)s, %(extraction_run_id)s,
                    %(geographic_distance_m)s, %(geographic_contained)s,
                    %(same_country)s, %(same_admin1)s, %(city_population)s,
                    %(direct_city_name)s, %(city_alias_match)s,
                    %(country_name)s, %(region_name)s, %(capital_indicator)s,
                    %(landmark_entity)s, %(org_entity)s, %(person_in_city)s,
                    %(source_in_city)s, %(source_country_match)s, %(source_region_match)s,
                    %(wikidata_entity_count)s, %(entity_match_score)s,
                    %(institution_match)s, %(landmark_match)s,
                    %(topic_city_relevance)s, %(body_length)s,
                    %(embedding_similarity)s,
                    %(embedding_general)s, %(embedding_economy)s, %(embedding_science)s,
                    %(embedding_politics)s, %(embedding_culture)s, %(embedding_transport)s,
                    %(embedding_environment)s,
                    %(published_hour_local)s, %(weekend_published)s,
                    %(presence_score)s, %(relevance_score)s,
                    %(feature_version)s
                )
                ON CONFLICT (story_id, city_id) DO UPDATE SET
                    geographic_distance_m = EXCLUDED.geographic_distance_m,
                    geographic_contained = EXCLUDED.geographic_contained,
                    same_country = EXCLUDED.same_country,
                    same_admin1 = EXCLUDED.same_admin1,
                    city_population = EXCLUDED.city_population,
                    direct_city_name = EXCLUDED.direct_city_name,
                    city_alias_match = EXCLUDED.city_alias_match,
                    presence_score = EXCLUDED.presence_score,
                    relevance_score = EXCLUDED.relevance_score
                """,
                feat_copy,
            )
            count += 1

    return count


# ─── Auto-labeling (for training data) ───────────────────────────────────────


def generate_auto_labels(story_id: int) -> list[dict[str, Any]]:
    """Generate auto-labels from explicit signals.

    Positive labels (label=1) when:
    - Geographic contained (article coords within city)
    - Direct city name mentioned AND source is in same country
    - Source is in the city

    Negative labels (label=0) when:
    - City is mentioned but geographic distance > 500km
    - Random city from same country that's not in article text
    """
    labels = []

    with connect() as conn:
        # Get explicit positive signals
        rows = conn.execute(
            """
            SELECT
                csf.city_id,
                csf.geographic_contained,
                csf.direct_city_name,
                csf.source_in_city,
                csf.geographic_distance_m,
                csf.same_country,
                wc.name AS city_name
            FROM city_story_features csf
            JOIN world_cities wc ON wc.id = csf.city_id
            WHERE csf.story_id = %(story_id)s
            """,
            {"story_id": story_id},
        ).fetchall()

    for row in rows:
        label_source = "auto"
        label = 0
        implied_reason = None

        if row["geographic_contained"]:
            label = 1
            implied_reason = "article coordinates within city"
        elif row["direct_city_name"] and row["source_in_city"]:
            label = 1
            implied_reason = "city named and source located there"
        elif row["direct_city_name"] and row["same_country"]:
            label = 1
            implied_reason = "city named in same country"
        elif row["geographic_distance_m"] and row["geographic_distance_m"] > 500_000:
            label = 0
            implied_reason = "city mentioned but > 500km away"
        elif row["geographic_distance_m"] and row["geographic_distance_m"] > 200_000:
            label = 0
            implied_reason = "city > 200km away"
        elif row["same_country"] == False and row["geographic_distance_m"] and row["geographic_distance_m"] > 50000:
            label = 0
            implied_reason = "different country and > 50km away"

        if label != 0 or implied_reason:
            labels.append({
                "story_id": story_id,
                "city_id": row["city_id"],
                "label": label,
                "label_source": label_source,
                "implied_reason": implied_reason,
                "label_confidence": 1.0 if implied_reason else 0.5,
            })

    return labels


def store_labels(labels: list[dict[str, Any]]) -> int:
    """Store auto-generated labels."""
    if not labels:
        return 0

    count = 0
    with connect() as conn:
        for lbl in labels:
            conn.execute(
                """
                INSERT INTO city_story_labels (
                    story_id, city_id, label, label_source,
                    implied_reason, label_confidence
                ) VALUES (
                    %(story_id)s, %(city_id)s, %(label)s, %(label_source)s,
                    %(implied_reason)s, %(label_confidence)s
                )
                ON CONFLICT (story_id, city_id, label_source)
                DO UPDATE SET
                    label = EXCLUDED.label,
                    implied_reason = EXCLUDED.implied_reason,
                    label_confidence = EXCLUDED.label_confidence
                """,
                lbl,
            )
            count += 1

    return count


# ─── Extraction Run Tracking ─────────────────────────────────────────────────


def start_extraction_run(run_type: str = "batch") -> int:
    """Create a new extraction run record. Returns run_id."""
    with connect() as conn:
        row = conn.execute(
            """
            INSERT INTO city_story_extraction_runs (run_type, status)
            VALUES (%(run_type)s, 'running')
            RETURNING id
            """,
            {"run_type": run_type},
        ).fetchone()
    return row["id"]


def complete_extraction_run(
    run_id: int,
    stories_processed: int,
    stories_with_matches: int,
    candidates_generated: int,
    processing_time_ms: int,
) -> None:
    """Mark extraction run as completed."""
    with connect() as conn:
        conn.execute(
            """
            UPDATE city_story_extraction_runs
            SET status = 'completed',
                stories_processed = %(stories_processed)s,
                stories_with_matches = %(stories_with_matches)s,
                candidates_generated = %(candidates_generated)s,
                processing_time_ms = %(processing_time_ms)s,
                completed_at = now()
            WHERE id = %(run_id)s
            """,
            {
                "run_id": run_id,
                "stories_processed": stories_processed,
                "stories_with_matches": stories_with_matches,
                "candidates_generated": candidates_generated,
                "processing_time_ms": processing_time_ms,
            },
        )


def fail_extraction_run(run_id: int, error: str) -> None:
    """Mark extraction run as failed."""
    with connect() as conn:
        conn.execute(
            """
            UPDATE city_story_extraction_runs
            SET status = 'failed',
                error_message = %(error)s,
                completed_at = now()
            WHERE id = %(run_id)s
            """,
            {"run_id": run_id, "error": error},
        )


# ─── CLI Entry Point ──────────────────────────────────────────────────────────


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="City-Story Intelligence Pipeline")
    parser.add_argument("--article-id", type=int, help="Process single article")
    parser.add_argument("--batch", action="store_true", help="Process pending articles")
    parser.add_argument("--limit", type=int, default=100, help="Batch size")
    args = parser.parse_args()

    if args.article_id:
        with connect() as conn:
            row = conn.execute(
                """
                SELECT id, title, body,
                       COALESCE(extracted_lat, suggested_lat) AS lat,
                       COALESCE(extracted_lng, suggested_lng) AS lng
                FROM news_articles
                WHERE id = %(id)s
                """,
                {"id": args.article_id},
            ).fetchone()

            if not row:
                print(f"Article {args.article_id} not found")
                exit(1)

            features = extract_features_for_article(
                article_id=row["id"],
                title=row["title"],
                body=row["body"],
                entities=[],
                article_lat=row["lat"],
                article_lng=row["lng"],
                article_country=None,
                article_admin1=None,
            )

            count = store_features(features)
            print(f"Stored {count} feature rows for article {args.article_id}")

    elif args.batch:
        run_id = start_extraction_run("batch")

        with connect() as conn:
            rows = conn.execute(
                """
                SELECT id, title, body,
                       COALESCE(extracted_lat, suggested_lat) AS lat,
                       COALESCE(extracted_lng, suggested_lng) AS lng
                FROM news_articles
                WHERE status = 'extracted'
                  AND COALESCE(extracted_lat, suggested_lat) IS NOT NULL
                  AND id NOT IN (
                      SELECT DISTINCT story_id FROM city_story_features
                  )
                ORDER BY fetched_at DESC
                LIMIT %(limit)s
                """,
                {"limit": args.limit},
            ).fetchall()

        processed = 0
        matches = 0
        candidates = 0

        for row in rows:
            try:
                features = extract_features_for_article(
                    article_id=row["id"],
                    title=row["title"],
                    body=row["body"],
                    entities=[],
                    article_lat=row["lat"],
                    article_lng=row["lng"],
                    article_country=None,
                    article_admin1=None,
                )
                count = store_features(features, run_id)
                candidates += count
                if count > 0:
                    matches += 1

                # Generate auto-labels
                labels = generate_auto_labels(row["id"])
                store_labels(labels)

                processed += 1
            except Exception as e:
                log.error(f"Error processing article {row['id']}: {e}")

        complete_extraction_run(
            run_id, processed, matches, candidates,
            processing_time_ms=0
        )

        print(f"Batch complete: {processed} processed, {matches} with matches, {candidates} candidates")
