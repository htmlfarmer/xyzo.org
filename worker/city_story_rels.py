"""City-Story Relationship Computation

Computes final relationships from features + ML scores + embeddings.
Stores results in city_story_relationships table.

Two-dimensional scoring:
  - place_presence: geographic/statistical likelihood (from small ML)
  - place_relevance: semantic similarity (from embeddings)

Relationship classification:
  ABOUT:      presence >= 0.7 AND relevance >= 0.7
  LOCAL:       presence >= 0.7 AND relevance < 0.7
  RELATED:     presence < 0.7 AND relevance >= 0.7
  INCIDENTAL: presence < 0.7 AND relevance < 0.7
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from .db import connect
from .city_story_ml import update_presence_scores

log = logging.getLogger("xyzo.city_story_rels")

PRESENCE_THRESHOLD = 0.7
RELEVANCE_THRESHOLD = 0.7

# Quadrant classification
QUADRANT_ABOUT = "ABOUT"
QUADRANT_LOCAL = "LOCAL"
QUADRANT_RELATED = "RELATED"
QUADRANT_INCIDENTAL = "INCIDENTAL"


class RelationshipType(str, Enum):
    DIRECT_LOCAL = "DIRECT_LOCAL"
    DIRECT_CITY = "DIRECT_CITY"
    ADMINISTRATIVE = "ADMINISTRATIVE"
    SOURCE_LOCATION = "SOURCE_LOCATION"
    ENTITY_ASSOCIATED = "ENTITY_ASSOCIATED"
    REGIONAL = "REGIONAL"
    COUNTRY = "COUNTRY"
    ECONOMIC = "ECONOMIC"
    CULTURAL = "CULTURAL"
    SCIENTIFIC = "SCIENTIFIC"
    SEMANTIC = "SEMANTIC"
    HISTORICAL = "HISTORICAL"
    INCIDENTAL = "INCIDENTAL"
    NONE = "NONE"


def _classify_quadrant(presence: float, relevance: float) -> str:
    """Classify into quadrant based on presence and relevance scores."""
    if presence >= PRESENCE_THRESHOLD and relevance >= RELEVANCE_THRESHOLD:
        return QUADRANT_ABOUT
    elif presence >= PRESENCE_THRESHOLD and relevance < RELEVANCE_THRESHOLD:
        return QUADRANT_LOCAL
    elif presence < PRESENCE_THRESHOLD and relevance >= RELEVANCE_THRESHOLD:
        return QUADRANT_RELATED
    else:
        return QUADRANT_INCIDENTAL


def _determine_relationship_type(
    presence: float,
    relevance: float,
    features: dict[str, Any],
) -> RelationshipType:
    """Determine the specific relationship type based on features and scores."""
    # Check for strong geographic signals
    if features.get("geographic_contained"):
        return RelationshipType.DIRECT_LOCAL

    if features.get("direct_city_name") and presence >= 0.6:
        return RelationshipType.DIRECT_CITY

    if features.get("source_in_city"):
        return RelationshipType.SOURCE_LOCATION

    if features.get("landmark_entity") or features.get("org_entity"):
        return RelationshipType.ENTITY_ASSOCIATED

    if features.get("institution_match"):
        return RelationshipType.SCIENTIFIC

    # Check embedding domain scores
    domain_scores = {
        "economy": features.get("embedding_economy", 0),
        "culture": features.get("embedding_culture", 0),
        "science": features.get("embedding_science", 0),
        "politics": features.get("embedding_politics", 0),
        "transport": features.get("embedding_transport", 0),
        "environment": features.get("embedding_environment", 0),
    }
    max_domain = max(domain_scores.items(), key=lambda x: x[1])

    if max_domain[1] > 0.7:
        if max_domain[0] == "economy":
            return RelationshipType.ECONOMIC
        elif max_domain[0] == "culture":
            return RelationshipType.CULTURAL
        elif max_domain[0] == "science":
            return RelationshipType.SCIENTIFIC
        elif max_domain[0] == "politics":
            return RelationshipType.COUNTRY  # politics often national
        elif max_domain[0] == "transport":
            return RelationshipType.REGIONAL
        elif max_domain[0] == "environment":
            return RelationshipType.REGIONAL

    # Regional/country level
    if features.get("same_admin1"):
        return RelationshipType.REGIONAL

    if features.get("same_country"):
        return RelationshipType.COUNTRY

    # Semantic only
    if relevance > PRESENCE_THRESHOLD:
        return RelationshipType.SEMANTIC

    # Incidental
    if presence > 0.3 or relevance > 0.3:
        return RelationshipType.INCIDENTAL

    return RelationshipType.NONE


def _extract_evidence(features: dict[str, Any]) -> list[str]:
    """Extract top 3 evidence strings for explainability."""
    evidence = []

    if features.get("geographic_contained"):
        evidence.append("coordinates within city boundary")
    elif features.get("geographic_distance_m", float("inf")) < 5000:
        evidence.append("very close to city center")

    if features.get("direct_city_name"):
        evidence.append("city name explicitly mentioned")

    if features.get("city_alias_match"):
        evidence.append("city alias mentioned")

    if features.get("source_in_city"):
        evidence.append("source located in city")

    if features.get("landmark_entity"):
        evidence.append("landmark entity matched")

    if features.get("org_entity"):
        evidence.append("organization entity matched")

    if features.get("institution_match"):
        evidence.append("institution matched")

    if features.get("wikidata_entity_count", 0) >= 3:
        evidence.append(f"{features['wikidata_entity_count']} Wikidata entities matched")

    if features.get("same_country"):
        evidence.append("same country")

    # Limit to top 3
    return evidence[:3]


def _compute_display_level(
    is_primary: bool,
    relationship_type: RelationshipType,
    quadrant: str,
) -> str:
    """Determine how prominently to display this relationship."""
    if is_primary and quadrant in (QUADRANT_ABOUT, QUADRANT_LOCAL):
        return "primary"
    elif quadrant == QUADRANT_RELATED:
        return "related"
    elif relationship_type in (RelationshipType.REGIONAL, RelationshipType.COUNTRY):
        return "regional"
    else:
        return "hidden"


def compute_relationships_for_story(story_id: int) -> int:
    """Compute final relationships for all city candidates of a story.

    Returns number of relationships computed.
    """
    with connect(autocommit=True) as conn:
        rows = conn.execute(
            """
            SELECT
                csf.city_id,
                wc.name AS city_name,
                csf.presence_score,
                csf.relevance_score,
                csf.geographic_distance_m,
                csf.geographic_contained,
                csf.same_country,
                csf.same_admin1,
                csf.city_population,
                csf.direct_city_name,
                csf.city_alias_match,
                csf.source_in_city,
                csf.landmark_entity,
                csf.org_entity,
                csf.institution_match,
                csf.wikidata_entity_count,
                csf.embedding_similarity,
                csf.embedding_general,
                csf.embedding_economy,
                csf.embedding_science,
                csf.embedding_politics,
                csf.embedding_culture,
                csf.embedding_transport,
                csf.embedding_environment
            FROM city_story_features csf
            JOIN world_cities wc ON wc.id = csf.city_id
            WHERE csf.story_id = %(story_id)s
            ORDER BY csf.presence_score DESC, csf.relevance_score DESC
            """,
            {"story_id": story_id},
        ).fetchall()

    if not rows:
        return 0

    relationships = []

    for row in rows:
        features = {k: v for k, v in row.items() if k not in ("city_id", "city_name")}

        presence = row["presence_score"] or 0.0
        relevance = row["relevance_score"] or 0.0
        if relevance == 0.0:
            relevance = row["embedding_similarity"] or 0.0

        if presence == 0.0:
            presence = 0.0
            if row["geographic_contained"]:
                presence = 1.0
            elif row["geographic_distance_m"]:
                presence = min(1.0, 1.0 / (1.0 + row["geographic_distance_m"] / 50000))
            if row["direct_city_name"]:
                presence = max(presence, 0.7)
            if row["source_in_city"]:
                presence = max(presence, 0.8)

        quadrant = _classify_quadrant(presence, relevance)
        rel_type = _determine_relationship_type(presence, relevance, features)
        evidence = _extract_evidence(features)

        confidence = (presence + relevance) / 2

        is_primary = False
        is_related = False

        if quadrant == QUADRANT_ABOUT:
            is_primary = True
            is_related = True
        elif quadrant == QUADRANT_LOCAL:
            is_primary = True
            is_related = True
        elif quadrant == QUADRANT_RELATED:
            is_related = True
        elif confidence > 0.4:
            is_related = True

        is_related = is_related and (presence > 0.3 or relevance > 0.3)

        display_level = _compute_display_level(is_primary, rel_type, quadrant)

        relationships.append({
            "story_id": story_id,
            "city_id": row["city_id"],
            "place_presence": presence,
            "place_relevance": relevance,
            "relationship_type": rel_type.value,
            "primary_evidence": evidence,
            "all_signals_json": features,
            "geographic_score": presence,
            "textual_score": 1.0 if row["direct_city_name"] else 0.0,
            "entity_score": min(1.0, (row["wikidata_entity_count"] or 0) / 5),
            "source_score": 1.0 if row["source_in_city"] else 0.0,
            "embedding_score": relevance,
            "confidence": confidence,
            "is_primary_city": is_primary,
            "is_related_city": is_related,
            "display_level": display_level,
        })

    # Store relationships
    with connect(autocommit=True) as conn:
        for rel in relationships:
            rel_copy = dict(rel)
            rel_copy["all_signals_json"] = json.dumps(rel["all_signals_json"])
            conn.execute(
                """
                INSERT INTO city_story_relationships (
                    story_id, city_id,
                    place_presence, place_relevance,
                    relationship_type, primary_evidence,
                    all_signals_json,
                    geographic_score, textual_score, entity_score,
                    source_score, embedding_score,
                    confidence, is_primary_city, is_related_city, display_level
                ) VALUES (
                    %(story_id)s, %(city_id)s,
                    %(place_presence)s, %(place_relevance)s,
                    %(relationship_type)s, %(primary_evidence)s,
                    %(all_signals_json)s,
                    %(geographic_score)s, %(textual_score)s, %(entity_score)s,
                    %(source_score)s, %(embedding_score)s,
                    %(confidence)s, %(is_primary_city)s, %(is_related_city)s, %(display_level)s
                )
                ON CONFLICT (story_id, city_id)
                DO UPDATE SET
                    place_presence = EXCLUDED.place_presence,
                    place_relevance = EXCLUDED.place_relevance,
                    relationship_type = EXCLUDED.relationship_type,
                    primary_evidence = EXCLUDED.primary_evidence,
                    all_signals_json = EXCLUDED.all_signals_json,
                    geographic_score = EXCLUDED.geographic_score,
                    confidence = EXCLUDED.confidence,
                    is_primary_city = EXCLUDED.is_primary_city,
                    is_related_city = EXCLUDED.is_related_city,
                    display_level = EXCLUDED.display_level,
                    updated_at = now()
                """,
                rel_copy,
            )

    return len(relationships)


def process_pending_stories(limit: int = 100) -> dict[str, int]:
    """Process stories that have features but no computed relationships.

    Returns stats dict.
    """
    stats = {"processed": 0, "relationships_created": 0, "errors": 0}

    # Find stories with features but no relationships - quick query
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT csf.story_id
            FROM city_story_features csf
            LEFT JOIN city_story_relationships csr ON csr.story_id = csf.story_id
            WHERE csr.story_id IS NULL
            ORDER BY csf.story_id DESC
            LIMIT %(limit)s
            """,
            {"limit": limit},
        ).fetchall()

    story_ids = [r["story_id"] for r in rows]

    if not story_ids:
        log.info("No pending stories to process")
        return stats

    log.info("Processing %d pending stories", len(story_ids))

    # First, update presence scores using ML (opens own connection)
    try:
        update_presence_scores(story_ids)
    except Exception as e:
        log.warning("Presence score update failed: %s", e)

    # Then compute relationships (each opens own connection)
    for story_id in story_ids:
        try:
            count = compute_relationships_for_story(story_id)
            stats["processed"] += 1
            stats["relationships_created"] += count
        except Exception as e:
            log.error("Error processing story %d: %s", story_id, e)
            stats["errors"] += 1

    return stats


# ─── CLI ─────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="City-Story Relationship Computation")
    parser.add_argument("--story-id", type=int, help="Process single story")
    parser.add_argument("--batch", action="store_true", help="Process pending stories")
    parser.add_argument("--limit", type=int, default=100, help="Batch size")
    parser.add_argument("--recompute", action="store_true", help="Clear existing relationships before computing")
    args = parser.parse_args()

    if args.story_id:
        if args.recompute:
            with connect() as conn:
                conn.execute("DELETE FROM city_story_relationships WHERE story_id = %(sid)s", {"sid": args.story_id})
        count = compute_relationships_for_story(args.story_id)
        print(f"Computed {count} relationships for story {args.story_id}")

    elif args.batch:
        story_ids = None
        if args.recompute:
            with connect() as conn:
                conn.execute("DELETE FROM city_story_relationships")
            log.info("Cleared all existing relationships")
        stats = process_pending_stories(limit=args.limit)
        print(f"Processed: {stats['processed']}, Relationships: {stats['relationships_created']}, Errors: {stats['errors']}")
