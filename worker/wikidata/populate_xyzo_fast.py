#!/usr/bin/env python3
"""
Populate xyzo_entities - FAST VERSION
====================================
Simple QID-based population using exact lookups.

Run:
    python3 -m worker.wikidata.populate_xyzo_fast
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
log = logging.getLogger("xyzo.populate_fast")

WIKIDATA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
)


# Known important QIDs - this is our curated list
# Format: (qid, importance_boost)
PRIORITY_QIDS = [
    # Space / Science
    ("Q23548", 500),   # NASA
    ("Q42944", 500),   # CERN
    ("Q334745", 400),  # ESA
    ("Q505015", 400),  # JPL
    ("Q58104", 400),   # SpaceX
    ("Q19459", 400),   # JAXA
    ("Q167757", 400),  # ISRO

    # AI / Tech
    ("Q30002910", 500),  # OpenAI
    ("Q108089601", 500), # Anthropic
    ("Q15350621", 400),  # DeepMind
    ("Q219", 400),       # Google
    ("Q44456", 400),     # Microsoft
    ("Q17447", 400),     # NVIDIA
    ("Q166623", 300),    # Qualcomm

    # Universities
    ("Q49108", 400),   # MIT
    ("Q49118", 400),   # Stanford
    ("Q13368", 400),   # Harvard / Caltech
    ("Q35794", 400),   # Cambridge
    ("Q490565", 400),  # U Tokyo
    ("Q294305", 300),  # KAUST
    ("Q127963", 300),   # ETH Zurich
    ("Q262757", 300),  # EPFL

    # Major news agencies
    ("Q9720", 400),    # Reuters
    ("Q9531", 400),    # BBC
    ("Q308855", 400),  # AP
    ("Q191781", 400),  # Bloomberg

    # Countries
    ("Q30", 300),      # USA
    ("Q145", 300),     # UK
    ("Q39", 300),      # Switzerland
    ("Q142", 300),     # France
    ("Q183", 300),     # Germany
    ("Q668", 300),     # India
    ("Q148", 300),     # China
    ("Q16", 300),      # Canada
    ("Q414", 300),     # Argentina
    ("Q219", 300),     # Brazil
    ("Q36", 300),      # Poland
    ("Q213", 300),     # Czech Republic
    ("Q218", 300),      # Ecuador
    ("Q241", 300),     # Chile
    ("Q77", 300),      # Mexico
    ("Q403", 300),     # South Africa
    ("Q258", 300),     # Saudi Arabia
    ("Q796", 300),     # Turkey
    ("Q794", 300),     # Spain
    ("Q142", 300),     # France
    ("Q38", 300),      # Italy
    ("Q159", 300),     # Russia
    ("Q884", 300),     # South Korea
    ("Q17", 300),      # Japan
    ("Q33", 300),      # Finland
    ("Q35", 300),      # Netherlands
    ("Q28", 300),      # Hungary
    ("Q40", 300),      # Austria

    # Major cities
    ("Q60", 200),      # New York
    ("Q62", 200),      # San Francisco
    ("Q16554", 200),   # Los Angeles
    ("Q172", 200),     # Chicago
    ("Q84", 200),      # London
    ("Q220", 200),     # Paris
    ("Q17770", 200),  # Tokyo
    ("Q148", 200),     # Beijing
    ("Q866", 200),     # Shanghai
    ("Q908", 200),     # Shenzhen
    ("Q1055", 200),    # Mumbai
    ("Q1352", 200),    # Delhi
    ("Q11759", 200),   # São Paulo
    ("Q10282", 200),   # Singapore
    ("Q8684", 200),    # Hong Kong
    ("Q1490", 200),    # Jakarta
    ("Q1744", 200),    # Sydney
    ("Q11553", 200),   # Melbourne
    ("Q43665", 200),   # Toronto
    ("Q88", 200),      # Berlin
    ("Q179", 200),     # Moscow
    ("Q24857", 200),   # Dubai
    ("Q1218", 200),    # Madrid
    ("Q217", 200),     # Rome
    ("Q190", 200),     # Amsterdam
    ("Q31", 200),      # Belgium
    ("Q174", 200),     # Seoul
    ("Q227", 200),     # Istanbul
    ("Q175", 200),     # Karachi
    ("Q11865", 200),   # Lagos
    ("Q408", 200),     # Nairobi
    ("Q94", 200),     # Cairo
    ("Q1228", 200),    # Manila
    ("Q17", 200),      # Osaka

    # Research organizations
    ("Q387954", 400),  # NIH
    ("Q570094", 400),  # USGS
    ("Q532195", 400),  # ECMWF
    ("Q494859", 400),  # NOAA
    ("Q519676", 400),  # NIST
    ("Q510788", 400),  # Fermilab
    ("Q284463", 400),  # SLAC
    ("Q503570", 400),  # Brookhaven
    ("Q281648", 400),  # Sanger Institute
    ("Q4971095", 400), # Broad Institute
]


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


def fetch_and_insert(conn_wiki, conn_xyzo, qids_with_boost):
    """Fetch QIDs from Wikidata and insert into XYzo."""
    qids = [q for q, _ in qids_with_boost]
    boost_map = {q: b for q, b in qids_with_boost}

    log.info(f"  Fetching {len(qids)} entities from Wikidata...")

    # Batch fetch
    batch_size = 50
    total_inserted = 0

    for i in range(0, len(qids), batch_size):
        batch = qids[i:i + batch_size]
        placeholders = ",".join(["%s"] * len(batch))

        with conn_wiki.cursor() as cur:
            cur.execute(f"""
                SELECT id, label_en, description_en, lat, lon, enwiki_title
                FROM wd_entities
                WHERE id IN ({placeholders})
            """, batch)
            rows = list(cur.fetchall())

        # Insert
        with conn_xyzo.cursor() as cur:
            for row in rows:
                boost = boost_map.get(row['id'], 0)
                score = boost + (100 if row['lat'] else 0)

                if score >= 400:
                    rank = 'top'
                elif score >= 300:
                    rank = 'high'
                elif score >= 200:
                    rank = 'medium'
                else:
                    rank = 'low'

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
                total_inserted += 1

        conn_xyzo.commit()

        if (i + batch_size) % 100 == 0:
            log.info(f"    Processed {min(i + batch_size, len(qids))}/{len(qids)}")

    log.info(f"  ✅ Inserted {total_inserted} entities")
    return total_inserted


def main():
    log.info("=" * 60)
    log.info("POPULATE xyzo_entities (FAST VERSION)")
    log.info("=" * 60)

    conn_wiki = connect_wikidata()
    conn_xyzo = connect_xyzo()

    try:
        create_table(conn_xyzo)

        total = fetch_and_insert(conn_wiki, conn_xyzo, PRIORITY_QIDS)

        # Stats
        with conn_xyzo.cursor() as cur:
            cur.execute("SELECT COUNT(*) as cnt FROM xyzo_entities")
            count = cur.fetchone()['cnt']

            cur.execute("SELECT COUNT(*) as cnt FROM xyzo_entities WHERE lat IS NOT NULL")
            with_coords = cur.fetchone()['cnt']

            cur.execute("SELECT COUNT(*) as cnt FROM xyzo_entities WHERE entity_rank = 'top'")
            top = cur.fetchone()['cnt']

        log.info("\n" + "=" * 60)
        log.info("DONE!")
        log.info("=" * 60)
        log.info(f"  Total entities: {count}")
        log.info(f"  With coordinates: {with_coords}")
        log.info(f"  Top-ranked: {top}")

    finally:
        conn_wiki.close()
        conn_xyzo.close()


if __name__ == "__main__":
    sys.exit(main())
