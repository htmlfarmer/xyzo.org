"""Gemma Resolution for Ambiguous City-Story Cases

Used ONLY when small ML + embeddings are uncertain:
  - presence_score between 0.3 and 0.7
  - relevance_score between 0.3 and 0.7
  - Multiple candidates with similar scores

Gemma determines:
  1. Which city the story is actually about
  2. The nature of the relationship (direct, related, incidental)
  3. Confidence reasoning

This is expensive (GPU call) so we only use it sparingly.
"""

import json
import logging
import os
from typing import Any

import httpx

from .db import connect

log = logging.getLogger("xyzo.city_story_gemma")

CHAT_URL = os.environ.get(
    "XYZO_AI_CHAT_URL",
    "http://192.168.1.3:8888/chat/stream",
)
TIMEOUT_S = float(os.environ.get("XYZO_AI_TIMEOUT", "25"))
SAFE_HEADERS = {"X-MCP-Safe": "true"}

AMBIGUITY_THRESHOLD_LOW = 0.3
AMBIGUITY_THRESHOLD_HIGH = 0.7

Gemma_SYSTEM_PROMPT = """You are a geographic news analysis expert. Given a news article and candidate cities, determine which city the story is actually about.

You will receive:
1. Article title and summary
2. List of candidate cities with scores (presence_score, relevance_score)
3. Geographic evidence (distance, containment, country match)
4. Entity matches (organizations, landmarks, institutions in the article)

Your task:
- Determine the PRIMARY city this story is about
- Classify the relationship type: DIRECT_LOCAL, DIRECT_CITY, REGIONAL, COUNTRY, RELATED, INCIDENTAL
- Explain your reasoning

Output ONLY valid JSON (no markdown, no explanation):
{
  "primary_city_id": <city_id or null>,
  "relationship_type": "DIRECT_LOCAL|DIRECT_CITY|REGIONAL|COUNTRY|RELATED|INCIDENTAL",
  "reasoning": "2-3 sentence explanation",
  "confidence": 0.0-1.0
}
"""


def build_gemma_prompt(
    article_title: str,
    article_summary: str,
    article_body: str | None,
    candidates: list[dict[str, Any]],
) -> str:
    """Build the prompt for Gemma."""
    # Truncate body
    body_preview = ""
    if article_body:
        body_preview = article_body[:1500]

    # Build candidate list
    candidate_lines = []
    for c in candidates:
        candidate_lines.append(
            f"- City ID: {c['city_id']}, Name: {c.get('city_name', 'Unknown')}, "
            f"Presence: {c.get('presence_score', 0):.2f}, Relevance: {c.get('relevance_score', 0):.2f}, "
            f"Distance: {c.get('geographic_distance_m', 'N/A')}m, "
            f"Direct name match: {c.get('direct_city_name', False)}, "
            f"Country match: {c.get('same_country', False)}, "
            f"Entity matches: {c.get('wikidata_entity_count', 0)}"
        )

    candidates_text = "\n".join(candidate_lines)

    prompt = f"""Article Title: {article_title}

Article Summary: {article_summary}

Article Body Preview: {body_preview}

Candidate Cities:
{candidates_text}

Determine which city this story is primarily about.
"""
    return prompt


def resolve_with_gemma(
    article_title: str,
    article_summary: str,
    article_body: str | None,
    candidates: list[dict[str, Any]],
) -> dict[str, Any]:
    """Call Gemma to resolve ambiguous city-story relationship.

    Returns Gemma's decision.
    """
    prompt = build_gemma_prompt(article_title, article_summary, article_body, candidates)

    payload = {
        "message": Gemma_SYSTEM_PROMPT + "\n\n" + prompt,
        "stream": False,
    }

    try:
        with httpx.Client(timeout=TIMEOUT_S) as client:
            response = client.post(
                CHAT_URL,
                json=payload,
                headers=SAFE_HEADERS,
            )
            response.raise_for_status()
            result = response.json()

            # Parse Gemma's response
            content = result.get("content", "")
            if isinstance(content, list):
                content = " ".join(str(c) for c in content)

            # Try to parse as JSON
            # Gemma might wrap in ```json ... ``` or just return raw JSON
            content = content.strip()
            if content.startswith("```"):
                # Extract JSON from markdown
                lines = content.split("\n")
                json_lines = [l for l in lines if not l.startswith("```") and not l.startswith("json")]
                content = "\n".join(json_lines)

            decision = json.loads(content)

            return {
                "primary_city_id": decision.get("primary_city_id"),
                "relationship_type": decision.get("relationship_type", "INCIDENTAL"),
                "reasoning": decision.get("reasoning", ""),
                "confidence": decision.get("confidence", 0.5),
                "success": True,
            }

    except json.JSONDecodeError as e:
        log.warning("Gemma returned invalid JSON: %s - %s", e, content[:200] if content else "")
        return {
            "primary_city_id": None,
            "relationship_type": "INCIDENTAL",
            "reasoning": f"Failed to parse Gemma response: {e}",
            "confidence": 0.0,
            "success": False,
        }
    except Exception as e:
        log.error("Gemma call failed: %s", e)
        return {
            "primary_city_id": None,
            "relationship_type": "INCIDENTAL",
            "reasoning": f"Gemma call failed: {e}",
            "confidence": 0.0,
            "success": False,
        }


def find_ambiguous_stories(limit: int = 20) -> list[dict[str, Any]]:
    """Find stories with ambiguous city relationships.

    Returns stories where ML scores are in the uncertain range.
    """
    with connect() as conn:
        rows = conn.execute("""
            SELECT
                csf.story_id,
                na.title,
                na.body,
                na.summary,
                json_agg(json_build_object(
                    'city_id', csf.city_id,
                    'city_name', wc.name,
                    'presence_score', csf.presence_score,
                    'relevance_score', csf.relevance_score,
                    'geographic_distance_m', csf.geographic_distance_m,
                    'direct_city_name', csf.direct_city_name,
                    'same_country', csf.same_country,
                    'wikidata_entity_count', csf.wikidata_entity_count
                )) AS candidates
            FROM city_story_features csf
            JOIN news_articles na ON na.id = csf.story_id
            LEFT JOIN world_cities wc ON wc.id = csf.city_id
            WHERE csf.presence_score BETWEEN %(low)s AND %(high)s
              AND csf.relevance_score BETWEEN %(low)s AND %(high)s
              AND csf.story_id IN (
                  SELECT story_id FROM city_story_features
                  GROUP BY story_id
                  HAVING COUNT(*) >= 2
              )
            GROUP BY csf.story_id, na.title, na.body, na.summary
            ORDER BY csf.story_id DESC
            LIMIT %(limit)s
            """,
            {
                "low": AMBIGUITY_THRESHOLD_LOW,
                "high": AMBIGUITY_THRESHOLD_HIGH,
                "limit": limit,
            }
        ).fetchall()

    return rows


def process_ambiguous_stories(limit: int = 20) -> dict[str, int]:
    """Process ambiguous stories with Gemma.

    Returns stats dict.
    """
    stats = {"processed": 0, "resolved": 0, "errors": 0}

    ambiguous = find_ambiguous_stories(limit=limit)

    if not ambiguous:
        log.info("No ambiguous stories found")
        return stats

    log.info("Found %d ambiguous stories to process", len(ambiguous))

    for story in ambiguous:
        try:
            decision = resolve_with_gemma(
                article_title=story["title"],
                article_summary=story["summary"] or "",
                article_body=story["body"],
                candidates=story["candidates"],
            )

            stats["processed"] += 1

            if decision["success"]:
                # Update relationships based on Gemma's decision
                primary_id = decision["primary_city_id"]

                with connect() as conn:
                    # Clear previous primary flags
                    conn.execute("""
                        UPDATE city_story_relationships
                        SET is_primary_city = FALSE
                        WHERE story_id = %(story_id)s
                        """,
                        {"story_id": story["story_id"]}
                    )

                    # Update Gemma's chosen city
                    if primary_id:
                        conn.execute("""
                            UPDATE city_story_relationships
                            SET is_primary_city = TRUE,
                                confidence = GREATEST(confidence, %(confidence)s),
                                relationship_type = %(rel_type)s::city_story_relation_type
                            WHERE story_id = %(story_id)s
                              AND city_id = %(city_id)s
                            """,
                            {
                                "story_id": story["story_id"],
                                "city_id": primary_id,
                                "confidence": decision["confidence"],
                                "rel_type": decision["relationship_type"],
                            }
                        )
                        stats["resolved"] += 1

                    log.info("Story %d: Gemma chose city %s (%s, conf=%.2f)",
                             story["story_id"], primary_id,
                             decision["relationship_type"], decision["confidence"])

        except Exception as e:
            log.error("Error processing story %d: %s", story["story_id"], e)
            stats["errors"] += 1

    return stats


# ─── CLI ─────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Gemma Ambiguity Resolution")
    parser.add_argument("--story-id", type=int, help="Process single story")
    parser.add_argument("--batch", action="store_true", help="Process ambiguous stories")
    parser.add_argument("--limit", type=int, default=20, help="Batch limit")
    args = parser.parse_args()

    if args.story_id:
        with connect() as conn:
            row = conn.execute("""
                SELECT na.id, na.title, na.summary, na.body,
                       csf.presence_score, csf.relevance_score
                FROM news_articles na
                JOIN city_story_features csf ON csf.story_id = na.id
                WHERE na.id = %(id)s
                LIMIT 10
                """,
                {"id": args.story_id}
            ).fetchone()

        if not row:
            print(f"No features found for story {args.story_id}")
            exit(1)

        decision = resolve_with_gemma(
            article_title=row["title"],
            article_summary=row["summary"] or "",
            article_body=row["body"],
            candidates=[{
                "city_id": 0,
                "city_name": "Candidate",
                "presence_score": row["presence_score"],
                "relevance_score": row["relevance_score"],
            }],
        )

        print(f"Gemma decision: {json.dumps(decision, indent=2)}")

    elif args.batch:
        stats = process_ambiguous_stories(limit=args.limit)
        print(f"Processed: {stats['processed']}, Resolved: {stats['resolved']}, Errors: {stats['errors']}")
