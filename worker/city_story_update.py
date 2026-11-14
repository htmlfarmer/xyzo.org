"""City-Story Feature Updater

Updates city_story_features with:
  - Entity match scores (from city_neighborhoods.py)
  - Embedding similarity scores (from city_embeddings.py)

This connects the L0/L0.5 feature extraction to the L2 embedding layer.
"""

import logging
from typing import Any

from .db import connect
from .city_neighborhoods import match_entities_in_text
from .city_embeddings import get_article_embedding_similarity

log = logging.getLogger("xyzo.city_story_update")

FEATURE_UPDATE_SQL = """
UPDATE city_story_features
SET
    wikidata_entity_count = %(wikidata_entity_count)s,
    entity_match_score = %(entity_match_score)s,
    institution_match = %(institution_match)s,
    landmark_match = %(landmark_match)s,
    embedding_similarity = %(embedding_similarity)s,
    embedding_general = %(embedding_general)s,
    embedding_economy = %(embedding_economy)s,
    embedding_science = %(embedding_science)s,
    embedding_politics = %(embedding_politics)s,
    embedding_culture = %(embedding_culture)s,
    embedding_transport = %(embedding_transport)s,
    embedding_environment = %(embedding_environment)s
WHERE story_id = %(story_id)s
  AND city_id = %(city_id)s
"""


def update_features_for_story(
    story_id: int,
    article_text: str,
    entities: list[str],
) -> int:
    """Update features for all city candidates of a story with embeddings.

    Args:
        story_id: news_articles id
        article_text: combined title + body for embedding comparison
        entities: extracted entity names from article

    Returns:
        Number of feature rows updated
    """
    with connect() as conn:
        # Get all city candidates for this story
        rows = conn.execute("""
            SELECT city_id
            FROM city_story_features
            WHERE story_id = %(story_id)s
            """,
            {"story_id": story_id}
        ).fetchall()

    if not rows:
        return 0

    updated = 0

    for row in rows:
        city_id = row["city_id"]

        # Get entity matches from city neighborhood
        entity_matches = match_entities_in_text(city_id, entities)

        # Get embedding similarity
        embedding_scores = get_article_embedding_similarity(article_text, city_id)

        # Combine
        updates = {
            "story_id": story_id,
            "city_id": city_id,
            **entity_matches,
            **embedding_scores,
        }

        # Store
        with connect() as conn:
            conn.execute(FEATURE_UPDATE_SQL, updates)
        updated += 1

    return updated


def update_features_batch(story_ids: list[int] | None = None, limit: int = 100) -> dict[str, int]:
    """Batch update features for stories that have features but no embeddings.

    Args:
        story_ids: Specific stories to update, or None for pending stories
        limit: Max stories to process

    Returns:
        Stats dict
    """
    stats = {"processed": 0, "updated": 0, "errors": 0}

    with connect() as conn:
        if story_ids:
            rows = conn.execute("""
                SELECT DISTINCT csf.story_id, na.title, LEFT(na.body, 2000) as body,
                       na.entities
                FROM city_story_features csf
                JOIN news_articles na ON na.id = csf.story_id
                WHERE csf.story_id = ANY(%(story_ids)s)
                ORDER BY csf.story_id
                LIMIT %(limit)s
                """,
                {"story_ids": story_ids, "limit": limit}
            ).fetchall()
        else:
            rows = conn.execute("""
                SELECT DISTINCT csf.story_id, na.title, LEFT(na.body, 2000) as body,
                       na.entities
                FROM city_story_features csf
                JOIN news_articles na ON na.id = csf.story_id
                WHERE csf.embedding_similarity = 0
                  AND csf.city_id IN (
                      SELECT city_id FROM city_entity_neighborhoods
                      WHERE embedding_general > 0
                  )
                ORDER BY csf.story_id
                LIMIT %(limit)s
                """,
                {"limit": limit}
            ).fetchall()

    for row in rows:
        try:
            # Parse entities from JSON array if needed
            entities = row["entities"]
            if isinstance(entities, str):
                import json
                entities = json.loads(entities) if entities else []
            elif not entities:
                entities = []

            # Combine title and body for embedding comparison
            article_text = f"{row['title']} {row['body']}"

            count = update_features_for_story(
                story_id=row["story_id"],
                article_text=article_text,
                entities=entities,
            )

            stats["processed"] += 1
            stats["updated"] += count

        except Exception as e:
            log.error("Error updating features for story %d: %s", row["story_id"], e)
            stats["errors"] += 1

    return stats


# ─── CLI ─────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="City-Story Feature Updater")
    parser.add_argument("--story-id", type=int, help="Single story ID")
    parser.add_argument("--batch", action="store_true", help="Batch update")
    parser.add_argument("--limit", type=int, default=100, help="Batch limit")
    args = parser.parse_args()

    if args.story_id:
        with connect() as conn:
            row = conn.execute("""
                SELECT id, title, body, entities
                FROM news_articles WHERE id = %(id)s
                """,
                {"id": args.story_id}
            ).fetchone()

        if not row:
            print(f"Story {args.story_id} not found")
            exit(1)

        import json
        entities = json.loads(row["entities"]) if row["entities"] else []
        article_text = f"{row['title']} {row['body']}"

        count = update_features_for_story(row["id"], article_text, entities)
        print(f"Updated {count} feature rows for story {args.story_id}")

    elif args.batch:
        stats = update_features_batch(limit=args.limit)
        print(f"Processed: {stats['processed']}, Updated: {stats['updated']}, Errors: {stats['errors']}")
