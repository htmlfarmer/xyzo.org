#!/usr/bin/env python3
"""
Populate xyzo_entities
======================
Creates the xyzo_entities table from wd_entities (Wikidata's 119M entity database).

This is XYZO's "entity skeleton" — a curated, indexed subset of Wikidata
that actually matters for news intelligence.

Priority entities:
1. All entities with coordinates (have lat/lon)
2. All countries, cities >10k population
3. All universities, hospitals, airports
4. All organizations with P159 (headquarters)
5. All items with >10 sitelinks
6. All items with >50 claims

Usage:
    python3 -m worker.wikidata.populate_xyzo_entities --sample 0.1  # 1% sample
    python3 -m worker.wikidata.populate_xyzo_entities --limit 1000000
    python3 -m worker.wikidata.populate_xyzo_entities --full
"""

import argparse
import json
import logging
import os
import sys
import hashlib
from dataclasses import dataclass
from typing import Iterator

import psycopg
from psycopg.rows import dict_row

log = logging.getLogger("xyzo.populate_xyzo_entities")

WIKIDATA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
)


@dataclass
class PopStats:
    sampled: int = 0
    inserted: int = 0
    skipped: int = 0
    errors: int = 0


def connect_wikidata() -> psycopg.Connection:
    return psycopg.connect(WIKIDATA_DSN, row_factory=dict_row, autocommit=True)


def connect_xyzo() -> psycopg.Connection:
    return psycopg.connect(XYZO_DSN, row_factory=dict_row, autocommit=True)


def create_xyzo_entities_table(xyzo_conn: psycopg.Connection) -> None:
    """Create the xyzo_entities table if it doesn't exist."""
    with xyzo_conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS xyzo_entities (
                id              TEXT PRIMARY KEY,           -- Q12345
                label_en        TEXT,
                description_en  TEXT,
                entity_type     TEXT,                       -- 'item' or 'property'
                lat             DOUBLE PRECISION,
                lon             DOUBLE PRECISION,
                geog            GEOGRAPHY(POINT, 4326),

                -- Wikipedia linkage
                enwiki_title    TEXT,
                wikipedia_url   TEXT,

                -- Multilingual data
                labels          JSONB,                      -- {en: "...", fr: "...", ...}
                descriptions    JSONB,                      -- {en: "...", ...}
                aliases         JSONB,                      -- [{lang, aliases[]}, ...]

                -- Pre-computed importance
                importance_score    DOUBLE PRECISION DEFAULT 0,
                num_claims         INTEGER DEFAULT 0,
                num_sitelinks      INTEGER DEFAULT 0,

                -- Wikidata rank
                entity_rank        TEXT,                    -- 'top', 'high', 'medium', 'low'

                created_at          TIMESTAMPTZ DEFAULT now(),
                updated_at         TIMESTAMPTZ DEFAULT now()
            )
        """)

        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_xyzo_entities_geog
            ON xyzo_entities USING GIST(geog)
        """)

        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_xyzo_entities_label_trgm
            ON xyzo_entities USING GIN(label_en gin_trgm_ops)
        """)

        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_xyzo_entities_type
            ON xyzo_entities(entity_type)
            WHERE entity_type = 'item'
        """)

        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_xyzo_entities_importance
            ON xyzo_entities(importance_score DESC)
        """)

    xyzo_conn.commit()
    log.info("xyzo_entities table created/verified")


def compute_importance(entity: dict) -> float:
    """
    Compute importance score for an entity.
    Higher = more important for XYZO news coverage.
    """
    score = 0.0

    # Has coordinates = +100 (geographically significant)
    if entity.get("lat") is not None and entity.get("lon") is not None:
        score += 100

    # Sitelinks (Wikipedia articles pointing here) = +10 each
    sitelinks = entity.get("sitelinks")
    if sitelinks:
        if isinstance(sitelinks, dict):
            score += len(sitelinks) * 10
        elif isinstance(sitelinks, list):
            score += len(sitelinks) * 10

    # Claims count = +1 each (up to +50)
    claims = entity.get("claims")
    num_claims = 0
    if claims:
        if isinstance(claims, list):
            num_claims = len(claims)
        elif isinstance(claims, dict):
            num_claims = sum(len(v) for v in claims.values())
    score += min(num_claims, 50)

    # Instance-of classification bonuses
    instance_of = []
    if claims and isinstance(claims, dict):
        p31_claims = claims.get("P31", [])
        for c in p31_claims:
            if isinstance(c, dict):
                val = c.get("mainsnak", {}).get("datavalue", {}).get("value", {})
                if isinstance(val, dict):
                    instance_of.append(val.get("id"))
                elif isinstance(val, str):
                    instance_of.append(val)

    # High-value instance-of values
    HIGH_VALUE_TYPES = {
        "Q6256",      # country
        "Q486972",    # human settlement
        "Q515",       # city
        "Q3957",      # town
        "Q17347023",  # meeting/event
        "Q43229",     # event
        "Q41176",     # organization
        "Q783794",    # company
        "Q3832978",   # university
        "Q16917",     # hospital
        "Q644371",    # airport
        "Q3350606",   # museum
        "Q1371541",   # government organization
        "Q7167",      # government agency
    }

    for itype in instance_of:
        if itype in HIGH_VALUE_TYPES:
            score += 50
            break

    return score


def sample_wikidata_entities(
    wikidata_conn: psycopg.Connection,
    sample_pct: float = 0.1,
    limit: int = 0
) -> Iterator[dict]:
    """
    Sample entities from wd_entities.

    Uses TABLESAMPLE SYSTEM to avoid full table scans.
    Yields entities with computed importance scores.
    """
    sample_clause = f"TABLESAMPLE SYSTEM ({sample_pct})" if sample_pct > 0 else ""

    sql = f"""
        SELECT
            id,
            entity_type,
            label_en,
            description_en,
            enwiki_title,
            lat,
            lon,
            labels,
            descriptions,
            aliases,
            claims,
            sitelinks
        FROM wd_entities
        {sample_clause}
        WHERE id LIKE 'Q%%'  -- Only items, not properties
    """

    if limit > 0:
        sql += f" LIMIT {limit}"

    with wikidata_conn.cursor() as cur:
        cur.execute(sql)
        while True:
            rows = cur.fetchmany(1000)
            if not rows:
                break
            for row in rows:
                yield row


def priority_entities(
    wikidata_conn: psycopg.Connection,
    limit: int = 100000
) -> Iterator[dict]:
    """
    Yield high-priority entities first:
    - Entities with coordinates
    - Countries (P17)
    - Cities (P131)
    - Major organizations (P159)
    """
    # High-priority query: entities with coordinates AND instance-of
    sql = """
        SELECT DISTINCT e.id, e.entity_type, e.label_en, e.description_en,
               e.enwiki_title, e.lat, e.lon, e.labels, e.descriptions, e.aliases,
               e.claims, e.sitelinks
        FROM wd_entities e
        WHERE e.lat IS NOT NULL
          AND e.lon IS NOT NULL
          AND e.entity_type = 'item'
          AND e.id LIKE 'Q%'
        ORDER BY e.id
        LIMIT %s
    """
    with wikidata_conn.cursor() as cur:
        cur.execute(sql, (limit,))
        while True:
            rows = cur.fetchmany(1000)
            if not rows:
                break
            for row in rows:
                yield row


def insert_entities(
    xyzo_conn: psycopg.Connection,
    entities: list[dict],
    batch_size: int = 1000
) -> tuple[int, int]:
    """
    Insert entities into xyzo_entities using batch upsert.
    Returns (inserted, skipped).
    """
    inserted = 0
    skipped = 0

    for i in range(0, len(entities), batch_size):
        batch = entities[i:i + batch_size]

        values = []
        for e in batch:
            importance = compute_importance(e)

            # Determine entity rank
            if importance >= 200:
                rank = "top"
            elif importance >= 100:
                rank = "high"
            elif importance >= 50:
                rank = "medium"
            else:
                rank = "low"

            # Count sitelinks
            num_sitelinks = 0
            sitelinks = e.get("sitelinks")
            if sitelinks:
                if isinstance(sitelinks, dict):
                    num_sitelinks = len(sitelinks)
                elif isinstance(sitelinks, list):
                    num_sitelinks = len(sitelinks)

            # Count claims
            num_claims = 0
            claims = e.get("claims")
            if claims:
                if isinstance(claims, list):
                    num_claims = len(claims)
                elif isinstance(claims, dict):
                    num_claims = sum(len(v) for v in claims.values())

            # Wikipedia URL
            enwiki_title = e.get("enwiki_title")
            wikipedia_url = f"https://en.wikipedia.org/wiki/{enwiki_title.replace(' ', '_')}" if enwiki_title else None

            # Geog generation (will be set by trigger or application)
            geog = f"SRID=4326;POINT({e.get('lon', 0)} {e.get('lat', 0)})" if e.get('lat') and e.get('lon') else None

            values.append((
                e["id"],
                e.get("label_en"),
                e.get("description_en"),
                e.get("entity_type"),
                e.get("lat"),
                e.get("lon"),
                geog,
                enwiki_title,
                wikipedia_url,
                json.dumps(e.get("labels")) if e.get("labels") else None,
                json.dumps(e.get("descriptions")) if e.get("descriptions") else None,
                json.dumps(e.get("aliases")) if e.get("aliases") else None,
                importance,
                num_claims,
                num_sitelinks,
                rank,
            ))

        if not values:
            continue

        with xyzo_conn.cursor() as cur:
            # Batch upsert
            cur.executemany("""
                INSERT INTO xyzo_entities (
                    id, label_en, description_en, entity_type,
                    lat, lon, geog, enwiki_title, wikipedia_url,
                    labels, descriptions, aliases,
                    importance_score, num_claims, num_sitelinks, entity_rank
                )
                VALUES (
                    %s, %s, %s, %s,
                    %s, %s,
                    CASE WHEN %s::text IS NOT NULL
                         THEN ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
                         ELSE NULL END,
                    %s, %s,
                    %s, %s, %s,
                    %s, %s, %s, %s
                )
                ON CONFLICT (id) DO UPDATE SET
                    label_en = EXCLUDED.label_en,
                    description_en = EXCLUDED.description_en,
                    lat = EXCLUDED.lat,
                    lon = EXCLUDED.lon,
                    geog = COALESCE(EXCLUDED.geog, xyzo_entities.geog),
                    importance_score = EXCLUDED.importance_score,
                    num_claims = EXCLUDED.num_claims,
                    num_sitelinks = EXCLUDED.num_sitelinks,
                    entity_rank = EXCLUDED.entity_rank,
                    updated_at = now()
            """, values)

        inserted += len(values)

    xyzo_conn.commit()
    return inserted, skipped


def get_xyzo_stats(xyzo_conn: psycopg.Connection) -> dict:
    """Get current xyzo_entities statistics."""
    with xyzo_conn.cursor() as cur:
        # Check if table exists
        cur.execute("""
            SELECT table_name
            FROM information_schema.tables
            WHERE table_name = 'xyzo_entities'
        """)
        if not cur.fetchone():
            return {"exists": False, "total": 0, "with_coords": 0, "top_ranked": 0, "avg_importance": 0}

        stats = {"exists": True}

        cur.execute("SELECT COUNT(*) as total FROM xyzo_entities")
        stats["total"] = cur.fetchone()["total"]

        cur.execute("SELECT COUNT(*) as with_coords FROM xyzo_entities WHERE lat IS NOT NULL")
        stats["with_coords"] = cur.fetchone()["with_coords"]

        cur.execute("SELECT COUNT(*) as top_ranked FROM xyzo_entities WHERE entity_rank = 'top'")
        stats["top_ranked"] = cur.fetchone()["top_ranked"]

        cur.execute("SELECT AVG(importance_score) as avg_score FROM xyzo_entities")
        row = cur.fetchone()
        stats["avg_importance"] = round(row["avg_score"], 2) if row["avg_score"] else 0

        return stats


def main():
    parser = argparse.ArgumentParser(description="Populate xyzo_entities from Wikidata")
    parser.add_argument("--sample", type=float, metavar="PCT",
                        help="Sample percentage (0.1 = 0.1%%, 1 = 1%%)")
    parser.add_argument("--limit", type=int, default=0,
                        help="Limit number of entities to process")
    parser.add_argument("--priority", action="store_true",
                        help="Process priority entities first (with coordinates)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be done without inserting")
    parser.add_argument("--status", action="store_true",
                        help="Show current xyzo_entities stats")
    args = parser.parse_args()

    xyzo_conn = connect_xyzo()

    try:
        if args.status:
            stats = get_xyzo_stats(xyzo_conn)
            if not stats.get("exists", False):
                print(f"\n=== xyzo_entities Status ===")
                print(f"Table:               NOT YET CREATED")
                print(f"Run without --status to create and populate")
                return 0
            print(f"\n=== xyzo_entities Status ===")
            print(f"Total entities:      {stats['total']:,}")
            print(f"With coordinates:    {stats['with_coords']:,}")
            print(f"Top-ranked:          {stats['top_ranked']:,}")
            print(f"Avg importance:     {stats['avg_importance']}")
            return 0

        create_xyzo_entities_table(xyzo_conn)

        wikidata_conn = connect_wikidata()

        try:
            if args.priority:
                log.info("Processing priority entities (with coordinates)...")
                entities = priority_entities(wikidata_conn, args.limit or 100000)
            elif args.sample:
                log.info(f"Sampling {args.sample}% of Wikidata entities...")
                entities = sample_wikidata_entities(
                    wikidata_conn,
                    sample_pct=args.sample,
                    limit=args.limit
                )
            else:
                log.info("Processing priority entities first...")
                entities = priority_entities(wikidata_conn, args.limit or 100000)

            if args.dry_run:
                count = 0
                for e in entities:
                    count += 1
                    if count >= 100:
                        break
                log.info(f"[dry-run] Would process ~{count} sample entities")
                return 0

            # Process in batches
            batch = []
            total_inserted = 0
            stats = PopStats()

            for entity in entities:
                stats.sampled += 1
                batch.append(entity)

                if len(batch) >= 1000:
                    inserted, skipped = insert_entities(xyzo_conn, batch)
                    total_inserted += inserted
                    stats.inserted += inserted
                    stats.skipped += skipped
                    log.info(f"  Inserted {total_inserted:,} entities "
                             f"(sampled={stats.sampled:,}, errors={stats.errors})")
                    batch = []

                if args.limit and stats.sampled >= args.limit:
                    break

            # Final batch
            if batch:
                inserted, skipped = insert_entities(xyzo_conn, batch)
                total_inserted += inserted
                stats.inserted += inserted

            log.info(f"\n=== Population Complete ===")
            log.info(f"Sampled:    {stats.sampled:,}")
            log.info(f"Inserted:   {stats.inserted:,}")
            log.info(f"Errors:     {stats.errors}")

        finally:
            wikidata_conn.close()

    finally:
        xyzo_conn.close()

    return 0


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    sys.exit(main())
