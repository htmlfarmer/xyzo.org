#!/usr/bin/env python3
"""
Populate xyzo_entities_priority
===============================
Populate xyzo_entities with HIGH-VALUE entities only:
- Countries (~200)
- Cities with >100k population via P276/P131 links
- Major universities (top 1000 globally)
- Major airports (~500)
- Major hospitals (~500)
- Major companies from seed_org_anchors

This is a curated subset, not everything in Wikidata.

Storage estimate: ~100k entities × ~500 bytes = ~50 MB

Run:
    python3 -m worker.wikidata.populate_priority_entities
"""

import logging
import os
import sys
import time

import psycopg
from psycopg.rows import dict_row

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("xyzo.populate_priority")

WIKIDATA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
)

BATCH_DELAY = 0.1  # Minimal delay for simple inserts


def connect_wikidata():
    return psycopg.connect(WIKIDATA_DSN, row_factory=dict_row, autocommit=True)


def connect_xyzo():
    return psycopg.connect(XYZO_DSN, row_factory=dict_row, autocommit=True)


def create_table(conn):
    """Create xyzo_entities table."""
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS xyzo_entities (
                qid             TEXT PRIMARY KEY,
                label_en        TEXT,
                description_en  TEXT,
                entity_type     TEXT,
                lat             DOUBLE PRECISION,
                lon             DOUBLE PRECISION,
                enwiki_title    TEXT,
                importance_score DOUBLE PRECISION DEFAULT 0,
                num_claims      INTEGER DEFAULT 0,
                entity_rank     TEXT DEFAULT 'low',
                created_at      TIMESTAMPTZ DEFAULT now(),
                updated_at      TIMESTAMPTZ DEFAULT now()
            )
        """)

        # Create indexes
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_xyzo_entities_latlon
            ON xyzo_entities(lat, lon)
            WHERE lat IS NOT NULL
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_xyzo_entities_rank
            ON xyzo_entities(entity_rank)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_xyzo_entities_importance
            ON xyzo_entities(importance_score DESC)
        """)

        conn.commit()


def compute_importance(row) -> tuple[float, str]:
    """Compute importance score and rank."""
    score = 0.0

    # Coordinates = +100
    if row.get('lat') and row.get('lon'):
        score += 100

    # Sitelinks = +10 each (up to +100)
    sitelinks = row.get('sitelinks')
    if sitelinks:
        count = len(sitelinks) if isinstance(sitelinks, (list, dict)) else 0
        score += min(count * 10, 100)

    # Claim count = +1 each (up to +50)
    claims = row.get('claims')
    if claims:
        count = len(claims) if isinstance(claims, (list, dict)) else 0
        score += min(count, 50)

    # Rank
    if score >= 200:
        rank = 'top'
    elif score >= 100:
        rank = 'high'
    elif score >= 50:
        rank = 'medium'
    else:
        rank = 'low'

    return score, rank


def populate_countries(conn_wiki, conn_xyzo):
    """Populate countries (P31 = Q6256)."""
    log.info("  Fetching countries...")

    with conn_wiki.cursor() as cur:
        cur.execute("""
            SELECT e.id, e.label_en, e.description_en, e.lat, e.lon, e.enwiki_title
            FROM wd_entities e
            WHERE e.id IN (
                SELECT DISTINCT c.value_entity
                FROM wd_claims_flat c
                WHERE c.entity_id IN (
                    SELECT entity_id FROM wd_claims_flat WHERE value_entity = 'Q6256' AND property = 'P31'
                )
                AND c.property = 'P31'
            )
            AND e.lat IS NOT NULL
            LIMIT 300
        """)
        countries = list(cur.fetchall())

    log.info(f"    Found {len(countries)} countries with coordinates")

    inserted = 0
    with conn_xyzo.cursor() as cur:
        for row in countries:
            score, rank = compute_importance(row)
            score += 50  # Countries get bonus

            cur.execute("""
                INSERT INTO xyzo_entities (qid, label_en, description_en, lat, lon, enwiki_title, importance_score, entity_rank)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (qid) DO UPDATE SET
                    label_en = EXCLUDED.label_en,
                    lat = COALESCE(EXCLUDED.lat, xyzo_entities.lat),
                    lon = COALESCE(EXCLUDED.lon, xyzo_entities.lon),
                    importance_score = EXCLUDED.importance_score,
                    entity_rank = EXCLUDED.entity_rank
            """, (row['id'], row['label_en'], row['description_en'], row['lat'], row['lon'], row['enwiki_title'], score, rank))
            inserted += 1

    conn_xyzo.commit()
    log.info(f"    Inserted {inserted} countries")
    return inserted


def populate_by_instance_of(conn_wiki, conn_xyzo, instance_of_qids: list, limit: int, label: str):
    """Populate entities by instance of."""
    log.info(f"  Fetching {label}...")

    placeholders = ",".join(["%s"] * len(instance_of_qids))

    with conn_wiki.cursor() as cur:
        cur.execute(f"""
            SELECT DISTINCT e.id, e.label_en, e.description_en, e.lat, e.lon, e.enwiki_title
            FROM wd_entities e
            JOIN wd_claims_flat c ON c.entity_id = e.id AND c.property = 'P31'
            WHERE c.value_entity IN ({placeholders})
              AND e.lat IS NOT NULL
              AND e.label_en IS NOT NULL
            LIMIT %s
        """, (*instance_of_qids, limit))

        entities = list(cur.fetchall())

    log.info(f"    Found {len(entities)} {label} with coordinates")

    inserted = 0
    with conn_xyzo.cursor() as cur:
        for row in entities:
            score, rank = compute_importance(row)

            cur.execute("""
                INSERT INTO xyzo_entities (qid, label_en, description_en, lat, lon, enwiki_title, importance_score, entity_rank)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (qid) DO UPDATE SET
                    label_en = EXCLUDED.label_en,
                    lat = COALESCE(EXCLUDED.lat, xyzo_entities.lat),
                    lon = COALESCE(EXCLUDED.lon, xyzo_entities.lon),
                    importance_score = GREATEST(xyzo_entities.importance_score, EXCLUDED.importance_score),
                    entity_rank = CASE
                        WHEN xyzo_entities.importance_score > EXCLUDED.importance_score THEN xyzo_entities.entity_rank
                        ELSE EXCLUDED.entity_rank
                    END
            """, (row['id'], row['label_en'], row['description_en'], row['lat'], row['lon'], row['enwiki_title'], score, rank))
            inserted += 1
            if inserted % 100 == 0:
                time.sleep(BATCH_DELAY)

    conn_xyzo.commit()
    log.info(f"    Inserted {inserted} {label}")
    return inserted


def populate_from_seed_anchors(conn_wiki, conn_xyzo):
    """Populate from seed_org_anchors QIDs."""
    log.info("  Fetching from seed anchors...")

    # QIDs from seed_org_anchors.py
    seed_qids = [
        "Q23548", "Q505015", "Q494839", "Q334745", "Q19459", "Q167757", "Q23433",
        "Q58104", "Q612572", "Q30002910", "Q108089601", "Q15350621", "Q219",
        "Q44456", "Q17447", "Q24848", "Q249794", "Q166623", "Q3037953",
        "Q151048034", "Q92860564", "Q28266747", "Q24872", "Q49118", "Q49108",
        "Q5358832", "Q387954", "Q4971095", "Q281648", "Q501852", "Q2566162",
        "Q308835", "Q510788", "Q284463", "Q503570", "Q1137560", "Q519676",
        "Q494859", "Q570094", "Q532195", "Q547830", "Q3098916", "Q2188191",
        "Q2605392", "Q37126", "Q9720", "Q308855", "Q191781", "Q9531",
        "Q167551", "Q49109", "Q437615", "Q479170", "Q7725", "Q16082485",
        "Q1261386", "Q1057292", "Q241480", "Q120770", "Q1526530", "Q170058",
        "Q1370848", "Q7169135",
    ]

    with conn_wiki.cursor() as cur:
        placeholders = ",".join(["%s"] * len(seed_qids))
        cur.execute(f"""
            SELECT id, label_en, description_en, lat, lon, enwiki_title
            FROM wd_entities
            WHERE id IN ({placeholders})
        """, seed_qids)

        entities = list(cur.fetchall())

    log.info(f"    Found {len(entities)} seed anchors")

    inserted = 0
    with conn_xyzo.cursor() as cur:
        for row in entities:
            score, rank = compute_importance(row)
            score += 200  # Seed anchors get high priority

            cur.execute("""
                INSERT INTO xyzo_entities (qid, label_en, description_en, lat, lon, enwiki_title, importance_score, entity_rank)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (qid) DO UPDATE SET
                    label_en = EXCLUDED.label_en,
                    lat = COALESCE(EXCLUDED.lat, xyzo_entities.lat),
                    lon = COALESCE(EXCLUDED.lon, xyzo_entities.lon),
                    importance_score = GREATEST(xyzo_entities.importance_score, EXCLUDED.importance_score),
                    entity_rank = 'top'
            """, (row['id'], row['label_en'], row['description_en'], row['lat'], row['lon'], row['enwiki_title'], score, rank))
            inserted += 1

    conn_xyzo.commit()
    log.info(f"    Inserted {inserted} seed anchors")
    return inserted


def get_stats(conn):
    """Get population stats."""
    with conn.cursor() as cur:
        stats = {}

        cur.execute("SELECT COUNT(*) as cnt FROM xyzo_entities")
        stats['total'] = cur.fetchone()['cnt']

        cur.execute("SELECT COUNT(*) as cnt FROM xyzo_entities WHERE lat IS NOT NULL")
        stats['with_coords'] = cur.fetchone()['cnt']

        cur.execute("SELECT COUNT(*) as cnt FROM xyzo_entities WHERE entity_rank = 'top'")
        stats['top'] = cur.fetchone()['cnt']

        cur.execute("SELECT COUNT(*) as cnt FROM xyzo_entities WHERE entity_rank = 'high'")
        stats['high'] = cur.fetchone()['cnt']

        cur.execute("SELECT COUNT(*) as cnt FROM xyzo_entities WHERE entity_rank = 'medium'")
        stats['medium'] = cur.fetchone()['cnt']

        cur.execute("SELECT COUNT(*) as cnt FROM xyzo_entities WHERE entity_rank = 'low'")
        stats['low'] = cur.fetchone()['cnt']

        return stats


def main():
    log.info("=" * 60)
    log.info("POPULATE xyzo_entities (PRIORITY ENTITIES)")
    log.info("=" * 60)

    conn_wiki = connect_wikidata()
    conn_xyzo = connect_xyzo()

    try:
        # Create table
        log.info("\nCreating xyzo_entities table...")
        create_table(conn_xyzo)

        # Check existing
        existing = get_stats(conn_xyzo)
        log.info(f"  Existing entities: {existing['total']}")

        total_inserted = 0

        # 1. Seed anchors (NASA, CERN, etc.) - HIGHEST priority
        total_inserted += populate_from_seed_anchors(conn_wiki, conn_xyzo)

        # 2. Countries
        total_inserted += populate_countries(conn_wiki, conn_xyzo)

        # 3. Major cities (Q515 = city, Q486972 = human settlement)
        total_inserted += populate_by_instance_of(conn_wiki, conn_xyzo,
            ['Q515', 'Q486972', 'Q3957'], 5000, "cities")

        # 4. Universities (Q3918 = university)
        total_inserted += populate_by_instance_of(conn_wiki, conn_xyzo,
            ['Q3918'], 2000, "universities")

        # 5. Airports (Q644371)
        total_inserted += populate_by_instance_of(conn_wiki, conn_xyzo,
            ['Q644371'], 500, "airports")

        # 6. Hospitals (Q16917)
        total_inserted += populate_by_instance_of(conn_wiki, conn_xyzo,
            ['Q16917'], 500, "hospitals")

        # 7. Museums (Q3350606)
        total_inserted += populate_by_instance_of(conn_wiki, conn_xyzo,
            ['Q3350606'], 500, "museums")

        # 8. Organizations (Q43229)
        total_inserted += populate_by_instance_of(conn_wiki, conn_xyzo,
            ['Q43229', 'Q41176', 'Q783794'], 2000, "organizations")

        # Final stats
        stats = get_stats(conn_xyzo)

        log.info("\n" + "=" * 60)
        log.info("POPULATION COMPLETE")
        log.info("=" * 60)
        log.info(f"""
Total entities:      {stats['total']:,}
With coordinates:    {stats['with_coords']:,}

By rank:
  Top:             {stats['top']:,}
  High:            {stats['high']:,}
  Medium:          {stats['medium']:,}
  Low:             {stats['low']:,}

Storage estimate: ~{stats['total'] * 500 / 1024 / 1024:.1f} MB

Next steps:
  1. python3 -m worker.wikidata.populate_xyzo_relationships
  2. python3 -m worker.wikidata.resolve_wikidata_entities
""")

    finally:
        conn_wiki.close()
        conn_xyzo.close()


if __name__ == "__main__":
    sys.exit(main())
