"""City Entity Neighborhood Builder

Builds entity neighborhoods for each city from:
  - Wikidata database (wd_entities, wikidata_entities)
  - Wikipedia database (wp_geo, wp_articles)
  - XYZO news_entities table

Stores results in city_entity_neighborhoods table.

Entity categories:
  - universities
  - hospitals
  - research_institutions
  - landmarks
  - organizations
  - airports
  - sports_teams
  - museums
  - parks
"""

import json
import logging
import os
from typing import Any

import psycopg
from psycopg.rows import dict_row

from .db import connect as xyzo_connect

log = logging.getLogger("xyzo.city_neighborhoods")

WIKI_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)

WIKIPEDIA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikipedia"
).replace("/wikidata", "/wikipedia")


def connect_wiki():
    return psycopg.connect(WIKI_DSN, row_factory=dict_row, autocommit=True)


def connect_wikipedia():
    return psycopg.connect(WIKIPEDIA_DSN, row_factory=dict_row, autocommit=True)


ENTITY_TYPES = {
    "universities": ["Q3918", "Q2383894", "Q875538"],  # university, business school, technical university
    "hospitals": ["Q16917", "Q1737605"],  # hospital, medical center
    "research_institutions": ["Q3181291", "Q3863"],  # research institute, scientific institution
    "landmarks": ["Q83620", "Q49827", "Q585656", "Q532"],  # museum, monument, tower, palace
    "airports": ["Q1248784", "Q1939338"],  # airport, international airport
    "sports_teams": ["Q847842", "Q1924409"],  # sports club, football club
    "museums": ["Q33506", "Q2469976", "Q1137841"],  # museum, art museum, gallery
    "parks": ["Q22633", "Q42709522", "Q19829994"],  # park, urban park, national park
}


def build_city_neighborhood(city_id: int, lat: float, lng: float, city_name: str) -> dict[str, Any]:
    """Build entity neighborhood for a single city.

    Queries wikidata database for nearby entities, then categorizes them.

    Args:
        city_id: world_cities id
        lat, lng: city coordinates
        city_name: for fuzzy matching

    Returns:
        dict with entity lists and metadata
    """
    neighborhoods = {
        "universities": [],
        "hospitals": [],
        "research_institutions": [],
        "landmarks": [],
        "organizations": [],
        "airports": [],
        "sports_teams": [],
        "museums": [],
        "parks": [],
        "hospitals_wikidata": [],
        "universities_wikidata": [],
        "institutions_wikidata": [],
    }

    try:
        neighborhoods = _query_wikidata_entities(lat, lng, city_name)
        source_wikidata = True
    except Exception as e:
        log.warning("Wikidata query failed for city %d: %s", city_id, e)
        neighborhoods = {
            "universities": [], "hospitals": [], "research_institutions": [],
            "landmarks": [], "organizations": [], "airports": [],
            "sports_teams": [], "museums": [], "parks": [],
            "hospitals_wikidata": [], "universities_wikidata": [], "institutions_wikidata": [],
        }
        source_wikidata = False

    return {
        "city_id": city_id,
        **neighborhoods,
        "source_wikidata": source_wikidata,
        "source_wikipedia": False,
        "source_manual": False,
    }


def _query_wikidata_entities(lat: float, lng: float, city_name: str) -> dict[str, Any]:
    """Query Wikidata for entities near a location."""
    import time

    lat_range = 0.5  # roughly 50km
    lng_range = 0.5

    neighborhoods = {
        "universities": [], "hospitals": [], "research_institutions": [],
        "landmarks": [], "organizations": [], "airports": [],
        "sports_teams": [], "museums": [], "parks": [],
        "hospitals_wikidata": [], "universities_wikidata": [], "institutions_wikidata": [],
    }

    try:
        with connect_wiki() as conn:
            rows = conn.execute("""
                SELECT id, label_en, lat, lon
                FROM wd_entities
                WHERE lat BETWEEN %(lat_min)s AND %(lat_max)s
                  AND lon BETWEEN %(lng_min)s AND %(lng_max)s
                  AND lat IS NOT NULL
                  AND label_en IS NOT NULL
                LIMIT 200
            """, {
                "lat_min": lat - lat_range,
                "lat_max": lat + lat_range,
                "lng_min": lng - lng_range,
                "lng_max": lng + lng_range,
            }).fetchall()

        for row in rows:
            label = row["label_en"]
            if not label:
                continue

            # Categorize by keywords in label
            label_lower = label.lower()

            if any(kw in label_lower for kw in ["university", "univ", "college", "institute", "school of"]):
                neighborhoods["universities"].append(label)
                neighborhoods["universities_wikidata"].append(row["id"])
            elif any(kw in label_lower for kw in ["hospital", "medical center", "clinic", "healthcare"]):
                neighborhoods["hospitals"].append(label)
                neighborhoods["hospitals_wikidata"].append(row["id"])
            elif any(kw in label_lower for kw in ["airport", "airfield"]):
                neighborhoods["airports"].append(label)
            elif any(kw in label_lower for kw in ["museum", "gallery", "exhibition"]):
                neighborhoods["museums"].append(label)
            elif any(kw in label_lower for kw in ["park", "garden", "reserve", "sanctuary"]):
                neighborhoods["parks"].append(label)
            elif any(kw in label_lower for kw in ["stadium", "arena", "sports club", "football club", "FC", "SC"]):
                neighborhoods["sports_teams"].append(label)
            elif any(kw in label_lower for kw in ["landmark", "monument", "tower", "palace", "castle", "shrine", "temple"]):
                neighborhoods["landmarks"].append(label)
            else:
                neighborhoods["organizations"].append(label)

        # Deduplicate and limit
        for key in neighborhoods:
            if isinstance(neighborhoods[key], list):
                neighborhoods[key] = list(dict.fromkeys(neighborhoods[key]))[:20]

    except Exception as e:
        log.warning("Wikidata query error: %s", e)

    return neighborhoods


def store_neighborhood(neighborhood: dict[str, Any]) -> None:
    """Store a city neighborhood in the database."""
    with xyzo_connect() as conn:
        conn.execute("""
            INSERT INTO city_entity_neighborhoods (
                city_id,
                universities, hospitals, research_institutions,
                landmarks, organizations, airports, sports_teams,
                museums, parks,
                hospitals_wikidata, universities_wikidata, institutions_wikidata,
                source_wikidata, source_wikipedia, source_manual
            ) VALUES (
                %(city_id)s,
                %(universities)s, %(hospitals)s, %(research_institutions)s,
                %(landmarks)s, %(organizations)s, %(airports)s, %(sports_teams)s,
                %(museums)s, %(parks)s,
                %(hospitals_wikidata)s, %(universities_wikidata)s, %(institutions_wikidata)s,
                %(source_wikidata)s, %(source_wikipedia)s, %(source_manual)s
            )
            ON CONFLICT (city_id) DO UPDATE SET
                universities = EXCLUDED.universities,
                hospitals = EXCLUDED.hospitals,
                research_institutions = EXCLUDED.research_institutions,
                landmarks = EXCLUDED.landmarks,
                organizations = EXCLUDED.organizations,
                airports = EXCLUDED.airports,
                sports_teams = EXCLUDED.sports_teams,
                museums = EXCLUDED.museums,
                parks = EXCLUDED.parks,
                hospitals_wikidata = EXCLUDED.hospitals_wikidata,
                universities_wikidata = EXCLUDED.universities_wikidata,
                institutions_wikidata = EXCLUDED.institutions_wikidata,
                source_wikidata = EXCLUDED.source_wikidata,
                source_wikipedia = EXCLUDED.source_wikipedia,
                last_updated = now()
            """,
            neighborhood
        )


def build_all_neighborhoods(limit: int = 500, city_ids: list[int] | None = None) -> dict[str, int]:
    """Build neighborhoods for all major cities.

    Args:
        limit: Maximum cities to process
        city_ids: Specific city IDs to process, or None for all major cities

    Returns:
        Stats dict
    """
    stats = {"processed": 0, "errors": 0, "skipped": 0}

    with xyzo_connect() as conn:
        if city_ids:
            rows = conn.execute("""
                SELECT id, name, lat, lng, population
                FROM world_cities
                WHERE id = ANY(%(city_ids)s)
                  AND lat IS NOT NULL
                  AND lng IS NOT NULL
                ORDER BY population DESC NULLS LAST
                LIMIT %(limit)s
            """, {"city_ids": city_ids, "limit": limit}).fetchall()
        else:
            rows = conn.execute("""
                SELECT wc.id, wc.name, wc.lat, wc.lng, wc.population
                FROM world_cities wc
                WHERE wc.lat IS NOT NULL
                  AND wc.lng IS NOT NULL
                  AND wc.population >= 500000
                  AND NOT EXISTS (
                      SELECT 1 FROM city_entity_neighborhoods cen
                      WHERE cen.city_id = wc.id AND cen.source_wikidata = TRUE
                  )
                ORDER BY wc.population DESC
                LIMIT %(limit)s
            """, {"limit": limit}).fetchall()

    log.info("Building neighborhoods for %d cities", len(rows))

    # Pre-check which cities already have neighborhoods
    city_ids = [row["id"] for row in rows]
    with xyzo_connect() as conn:
        existing = conn.execute("""
            SELECT city_id FROM city_entity_neighborhoods
            WHERE city_id = ANY(%(city_ids)s)
              AND source_wikidata = TRUE
            """,
            {"city_ids": city_ids}
        ).fetchall()
    existing_ids = {r["city_id"] for r in existing}

    for row in rows:
        try:
            if row["id"] in existing_ids:
                stats["skipped"] += 1
                continue

            neighborhood = build_city_neighborhood(
                city_id=row["id"],
                lat=row["lat"],
                lng=row["lng"],
                city_name=row["name"],
            )

            store_neighborhood(neighborhood)
            stats["processed"] += 1

            if stats["processed"] % 100 == 0:
                log.info("Processed %d cities", stats["processed"])

        except Exception as e:
            log.error("Error building neighborhood for city %d: %s", row["id"], e)
            stats["errors"] += 1
            stats["errors"] += 1

    return stats


def match_entities_in_text(
    city_id: int,
    entities: list[str],
) -> dict[str, Any]:
    """Match a list of entities against a city's neighborhood.

    Returns:
        wikidata_entity_count, entity_match_score, institution_match, landmark_match
    """
    with xyzo_connect() as conn:
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

    if not neighborhood:
        return {
            "wikidata_entity_count": 0,
            "entity_match_score": 0.0,
            "institution_match": False,
            "landmark_match": False,
        }

    entity_set = set()
    for category, entities_list in neighborhood.items():
        if isinstance(entities_list, list):
            entity_set.update(e.lower() for e in entities_list)

    # Count matches
    matched = 0
    institution_match = False
    landmark_match = False

    for entity in entities:
        entity_lower = entity.lower()
        if entity_lower in entity_set:
            matched += 1
            # Check if matched entity is an institution
            if any(inst.lower() in entity_lower for inst in neighborhood.get("research_institutions", [])):
                institution_match = True
            if any(lm.lower() in entity_lower for lm in neighborhood.get("landmarks", [])):
                landmark_match = True

    return {
        "wikidata_entity_count": matched,
        "entity_match_score": min(1.0, matched / max(1, len(entities))),
        "institution_match": institution_match,
        "landmark_match": landmark_match,
    }


# ─── CLI ─────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="City Entity Neighborhood Builder")
    parser.add_argument("--limit", type=int, default=500, help="Max cities to process")
    parser.add_argument("--city-ids", type=str, help="Comma-separated city IDs")
    parser.add_argument("--city-id", type=int, help="Single city ID")
    args = parser.parse_args()

    if args.city_id:
        with xyzo_connect() as conn:
            row = conn.execute("""
                SELECT id, name, lat, lng FROM world_cities WHERE id = %(id)s
                """, {"id": args.city_id}).fetchone()

        if not row:
            print(f"City {args.city_id} not found")
            exit(1)

        neighborhood = build_city_neighborhood(row["id"], row["lat"], row["lng"], row["name"])
        store_neighborhood(neighborhood)

        total_entities = sum(len(v) for k, v in neighborhood.items()
                            if isinstance(v, list) and not k.endswith("_wikidata"))
        print(f"Built neighborhood for {row['name']}: {total_entities} entities")

    else:
        city_ids = None
        if args.city_ids:
            city_ids = [int(x.strip()) for x in args.city_ids.split(",")]

        stats = build_all_neighborhoods(limit=args.limit, city_ids=city_ids)
        print(f"Processed: {stats['processed']}, Skipped: {stats['skipped']}, Errors: {stats['errors']}")
