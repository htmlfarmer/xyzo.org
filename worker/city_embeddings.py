"""City Embeddings Computation

Computes domain-specific city embeddings from:
  - Entity neighborhoods (from city_neighborhoods.py)
  - Article topic distributions per city
  - Geographic features (population, region)
  - Wikipedia/Wikipedia entity descriptions

Stores embeddings as similarity scores to each domain.

Domain embeddings computed:
  - general: overall city profile
  - economy: business/finance/tech
  - science: research/universities/health
  - politics: government/diplomacy
  - culture: arts/sports/entertainment
  - transport: airports/roads/rail
  - environment: parks/nature/climate
"""

import json
import logging
import math
import os
from datetime import datetime, timezone
from typing import Any

import numpy as np

from .db import connect
from .city_neighborhoods import match_entities_in_text

log = logging.getLogger("xyzo.city_embeddings")

# Domain keyword dictionaries for embedding computation
DOMAIN_KEYWORDS = {
    "economy": {
        "business", "company", "market", "stock", "finance", "bank", "investment",
        "startup", "tech", "technology", "innovation", "industry", "manufacturing",
        "trade", "export", "import", "economic", "gdp", "jobs", "employment",
        "corporate", "enterprise", "business district", "financial center",
    },
    "science": {
        "research", "science", "university", "institute", "study", "scientist",
        "laboratory", "hospital", "medical", "health", "doctor", "patient",
        "treatment", "disease", "vaccine", "genetic", "biotech", "pharma",
        "academic", "professor", "student", "education", "school", "college",
    },
    "politics": {
        "government", "politics", "election", "vote", "parliament", "congress",
        "senate", "president", "minister", "policy", "law", "regulation",
        "diplomat", "embassy", "treaty", "conflict", "war", "peace",
        "military", "defense", "security", "intelligence", "vote", "campaign",
    },
    "culture": {
        "museum", "gallery", "art", "theater", "concert", "music", "film",
        "festival", "culture", "heritage", "historic", "tourism", "museums",
        "library", "cultural center", "monument", "landmark", "archaeological",
        "sports", "stadium", "team", "athlete", "championship", "olympics",
        "football", "soccer", "basketball", "tennis", "marathon",
    },
    "transport": {
        "airport", "flight", "airline", "railway", "train", "metro", "subway",
        "bus", "road", "highway", "bridge", "tunnel", "port", "shipping",
        "cargo", "logistics", "transport", "transit", "commute", "station",
        "terminal", "airways", "travel", "passenger",
    },
    "environment": {
        "park", "nature", "forest", "river", "lake", "mountain", "beach",
        "climate", "environment", "pollution", "conservation", "wildlife",
        "endangered", "sustainable", "green", "energy", "solar", "wind",
        "park", "reserve", "sanctuary", "ecology", "ecosystem", "carbon",
    },
}


def compute_city_text_profile(city_id: int) -> str:
    """Build a text profile of a city from its entities and articles.

    Returns a combined text for embedding.
    """
    with connect() as conn:
        # Get neighborhood
        neighborhood = conn.execute("""
            SELECT universities, hospitals, research_institutions,
                   landmarks, organizations, airports, sports_teams,
                   museums, parks
            FROM city_entity_neighborhoods
            WHERE city_id = %(city_id)s
            """,
            {"city_id": city_id}
        ).fetchone()

        # Get city info
        city = conn.execute("""
            SELECT name, country_code, admin1_code, population
            FROM world_cities
            WHERE id = %(city_id)s
            """,
            {"city_id": city_id}
        ).fetchone()

        # Get top article topics for this city
        topics = conn.execute("""
            SELECT DISTINCT nt.slug
            FROM news_article_topics nat
            JOIN news_articles na ON na.id = nat.article_id
            JOIN news_article_cities nac ON nac.article_id = na.id
            JOIN news_topics nt ON nt.id = nat.topic_id
            WHERE nac.city_id = %(city_id)s
            ORDER BY nt.slug
            LIMIT 20
            """,
            {"city_id": city_id}
        ).fetchall()

    if not city:
        return ""

    # Build profile text
    parts = [city["name"]]

    if neighborhood:
        for category in ("universities", "hospitals", "research_institutions",
                         "landmarks", "organizations", "airports",
                         "sports_teams", "museums", "parks"):
            if neighborhood.get(category):
                parts.extend(neighborhood[category][:10])  # Top 10 per category

    # Add topics
    if topics:
        parts.extend([t["slug"] for t in topics])

    return " ".join(str(p) for p in parts if p)


def compute_keyword_similarity(text: str, domain: str) -> float:
    """Compute how much a city text profile matches a domain.

    Returns 0-1 similarity score.
    """
    if not text:
        return 0.0

    text_lower = text.lower()
    keywords = DOMAIN_KEYWORDS.get(domain, set())

    matches = sum(1 for kw in keywords if kw in text_lower)
    total = len(keywords)

    if total == 0:
        return 0.0

    # Normalize and apply non-linearity
    raw = matches / total
    # Boost for having multiple matches
    if matches > 2:
        raw = min(1.0, raw * 1.5)

    return min(1.0, raw)


def compute_entity_density_score(neighborhood: dict | None, domain: str) -> float:
    """Compute entity density score for a domain."""
    if not neighborhood:
        return 0.0

    domain_entity_map = {
        "economy": ["organizations"],
        "science": ["universities", "hospitals", "research_institutions"],
        "politics": [],  # No direct mapping
        "culture": ["museums", "sports_teams", "landmarks"],
        "transport": ["airports"],
        "environment": ["parks", "landmarks"],
    }

    entity_cats = domain_entity_map.get(domain, [])
    if not entity_cats:
        return 0.0

    total_entities = 0
    for cat in entity_cats:
        entities = neighborhood.get(cat, [])
        if isinstance(entities, list):
            total_entities += len(entities)

    # Normalize: 10+ entities = high score
    return min(1.0, total_entities / 10)


def compute_population_score(population: int | None) -> float:
    """Compute a normalized population score."""
    if not population or population <= 0:
        return 0.0
    # Log scale: 100k = 0.5, 1M = 0.67, 10M = 0.83
    return min(1.0, (math.log10(population) - 5) / 2)


def compute_city_embeddings(city_id: int) -> dict[str, float]:
    """Compute all domain embeddings for a single city.

    Returns dict with embedding_similarity and per-domain scores.
    """
    with connect() as conn:
        neighborhood = conn.execute("""
            SELECT universities, hospitals, research_institutions,
                   landmarks, organizations, airports, sports_teams,
                   museums, parks
            FROM city_entity_neighborhoods
            WHERE city_id = %(city_id)s
            """,
            {"city_id": city_id}
        ).fetchone()

        city = conn.execute("""
            SELECT name, country_code, population
            FROM world_cities
            WHERE id = %(city_id)s
            """,
            {"city_id": city_id}
        ).fetchone()

    if not city:
        return {
            "embedding_general": 0.0,
            "embedding_economy": 0.0,
            "embedding_science": 0.0,
            "embedding_politics": 0.0,
            "embedding_culture": 0.0,
            "embedding_transport": 0.0,
            "embedding_environment": 0.0,
            "embedding_similarity": 0.0,
        }

    # Build text profile
    text_profile = compute_city_text_profile(city_id)

    # Compute per-domain scores
    domain_scores = {}
    for domain in DOMAIN_KEYWORDS:
        # Combine keyword similarity and entity density
        kw_score = compute_keyword_similarity(text_profile, domain)
        entity_score = compute_entity_density_score(neighborhood, domain)

        # Weighted average
        domain_scores[f"embedding_{domain}"] = min(1.0, kw_score * 0.6 + entity_score * 0.4)

    # General embedding is average of all domains + population boost
    pop_score = compute_population_score(city.get("population"))
    domain_avg = sum(domain_scores.values()) / len(domain_scores) if domain_scores else 0
    general = min(1.0, domain_avg * 0.7 + pop_score * 0.3)
    domain_scores["embedding_general"] = general

    # Overall similarity is the general embedding
    domain_scores["embedding_similarity"] = general

    return domain_scores


def store_embeddings(city_id: int, embeddings: dict[str, float]) -> None:
    """Store computed embeddings for a city."""
    with connect() as conn:
        conn.execute("""
            UPDATE city_entity_neighborhoods
            SET embedding_general = %(embedding_general)s,
                embedding_economy = %(embedding_economy)s,
                embedding_science = %(embedding_science)s,
                embedding_politics = %(embedding_politics)s,
                embedding_culture = %(embedding_culture)s,
                embedding_transport = %(embedding_transport)s,
                embedding_environment = %(embedding_environment)s,
                last_updated = now()
            WHERE city_id = %(city_id)s
            """,
            {"city_id": city_id, **embeddings}
        )


def update_all_embeddings(limit: int = 1000) -> dict[str, int]:
    """Update embeddings for all cities with neighborhoods.

    Returns stats dict.
    """
    stats = {"updated": 0, "skipped": 0, "errors": 0}

    with connect() as conn:
        rows = conn.execute("""
            SELECT cen.city_id
            FROM city_entity_neighborhoods cen
            ORDER BY cen.city_id
            LIMIT %(limit)s
            """,
            {"limit": limit}
        ).fetchall()

    for row in rows:
        try:
            embeddings = compute_city_embeddings(row["city_id"])
            store_embeddings(row["city_id"], embeddings)
            stats["updated"] += 1

            if stats["updated"] % 100 == 0:
                log.info("Updated %d city embeddings", stats["updated"])

        except Exception as e:
            log.error("Error computing embeddings for city %d: %s", row["city_id"], e)
            stats["errors"] += 1

    return stats


def get_article_embedding_similarity(
    article_text: str,
    city_id: int,
) -> dict[str, float]:
    """Compute similarity between an article and a city using text matching.

    Returns per-domain similarity scores based on:
    - Direct city name mentions
    - Country/region name mentions
    - Source location signals
    """
    with connect() as conn:
        city_row = conn.execute("""
            SELECT
                name AS city_name,
                country_code,
                admin1_code,
                population
            FROM world_cities
            WHERE id = %(city_id)s
            """,
            {"city_id": city_id}
        ).fetchone()

        neighborhood = conn.execute("""
            SELECT
                universities, hospitals, research_institutions,
                landmarks, organizations, airports, sports_teams,
                museums, parks
            FROM city_entity_neighborhoods
            WHERE city_id = %(city_id)s
            """,
            {"city_id": city_id}
        ).fetchone()

    if not city_row:
        return _zero_scores()

    article_lower = article_text.lower()
    scores = {}

    city_name = city_row["city_name"] or ""
    country_code = city_row["country_code"] or ""
    admin1_code = city_row["admin1_code"] or ""

    country_map = {
        "US": "United States", "USA": "United States",
        "GB": "Britain", "UK": "United Kingdom",
        "CN": "China", "IN": "India", "JP": "Japan", "KR": "South Korea",
        "ID": "Indonesia", "BR": "Brazil", "MX": "Mexico", "EG": "Egypt",
        "PK": "Pakistan", "BD": "Bangladesh", "RU": "Russia",
        "AU": "Australia", "DE": "Germany", "FR": "France", "IT": "Italy",
        "ES": "Spain", "TR": "Turkey", "SA": "Saudi Arabia", "ZA": "South Africa",
        "NG": "Nigeria", "KE": "Kenya", "TH": "Thailand", "VN": "Vietnam",
        "PH": "Philippines", "MY": "Malaysia", "SG": "Singapore",
    }
    country_name = country_map.get(country_code, "")

    name_matches = 0
    total_names = 0

    if city_name:
        total_names += 1
        if city_name.lower() in article_lower:
            name_matches += 1
        for alias in [city_name.split()[0], city_name.split(",")[0]]:
            if len(alias) > 3 and alias.lower() in article_lower:
                name_matches += 0.5
                break

    if country_name:
        total_names += 1
        if country_name.lower() in article_lower:
            name_matches += 1

    if admin1_code:
        total_names += 1
        if admin1_code.lower() in article_lower:
            name_matches += 0.5

    name_score = name_matches / max(1, total_names)

    entity_matches = 0
    entity_total = 0
    if neighborhood:
        for category in ["universities", "hospitals", "landmarks", "organizations", "airports", "sports_teams", "museums", "parks"]:
            entities = neighborhood.get(category, [])
            if entities and isinstance(entities, list):
                for ent in entities[:10]:
                    entity_total += 1
                    if ent and isinstance(ent, str) and len(ent) > 2:
                        if ent.lower() in article_lower:
                            entity_matches += 1

    entity_score = entity_matches / max(1, entity_total) if entity_total > 0 else 0.0

    general = min(1.0, name_score * 0.7 + entity_score * 0.3)

    scores["embedding_general"] = general
    scores["embedding_similarity"] = general

    topic_weights = {
        "economy": ["business", "company", "market", "finance", "bank", "economy", "trade", "stock"],
        "science": ["university", "research", "science", "hospital", "medical", "study", "technology"],
        "politics": ["government", "election", "president", "minister", "parliament", "politics", "vote"],
        "culture": ["museum", "culture", "festival", "tourism", "sports", "team", "game", "art"],
        "transport": ["airport", "flight", "train", "road", "highway", "bus", "transport"],
        "environment": ["climate", "environment", "park", "nature", "pollution", "energy"],
    }

    for domain, keywords in topic_weights.items():
        keyword_col = f"embedding_{domain}"
        matches = sum(1 for kw in keywords if kw in article_lower)
        keyword_score = min(1.0, matches / 2)
        neighborhood_val = 0.0
        if neighborhood:
            neighborhood_val = neighborhood.get(keyword_col, 0.0)
        scores[keyword_col] = min(1.0, neighborhood_val * 0.5 + keyword_score * 0.5)

    return scores


def _zero_scores() -> dict[str, float]:
    return {
        "embedding_similarity": 0.0,
        "embedding_general": 0.0,
        "embedding_economy": 0.0,
        "embedding_science": 0.0,
        "embedding_politics": 0.0,
        "embedding_culture": 0.0,
        "embedding_transport": 0.0,
        "embedding_environment": 0.0,
    }


# ─── CLI ─────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="City Embeddings Computation")
    parser.add_argument("--city-id", type=int, help="Single city ID")
    parser.add_argument("--batch", action="store_true", help="Update all cities")
    parser.add_argument("--limit", type=int, default=1000, help="Batch limit")
    args = parser.parse_args()

    if args.city_id:
        embeddings = compute_city_embeddings(args.city_id)
        store_embeddings(args.city_id, embeddings)
        print(f"Computed embeddings for city {args.city_id}:")
        for k, v in embeddings.items():
            print(f"  {k}: {v:.3f}")

    elif args.batch:
        stats = update_all_embeddings(limit=args.limit)
        print(f"Updated: {stats['updated']}, Errors: {stats['errors']}")
