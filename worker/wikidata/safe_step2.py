#!/usr/bin/env python3
"""
Safe Step 2: Create xyzo_entity_relationships_sample
==================================================
Small test to verify we can copy relationships from Wikidata to XYzo.

Goal: Verify we can copy entity relationships without breaking anything.

Safety:
- Only 1000 relationships
- Uses READ-ONLY wikidata DB
- Creates NEW table (doesn't touch existing data)

Run:
    python3 -m worker.wikidata.safe_step2
"""

import logging
import os
import sys

import psycopg
from psycopg.rows import dict_row

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("xyzo.safe_step2")

WIKIDATA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
)


PROPERTY_NAMES = {
    "P31": "instance of",
    "P17": "country",
    "P159": "headquarters",
    "P276": "location",
    "P625": "coordinate location",
    "P361": "part of",
    "P279": "subclass of",
}


def connect_wikidata():
    return psycopg.connect(WIKIDATA_DSN, row_factory=dict_row, autocommit=True)


def connect_xyzo():
    return psycopg.connect(XYZO_DSN, row_factory=dict_row, autocommit=True)


def create_table(conn):
    """Create xyzo_entity_relationships_sample table."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT table_name FROM information_schema.tables
            WHERE table_name = 'xyzo_entity_relationships_sample'
        """)
        if cur.fetchone():
            log.info("  Table already exists")
            return False

        log.info("  Creating xyzo_entity_relationships_sample table...")
        cur.execute("""
            CREATE TABLE xyzo_entity_relationships_sample (
                id              BIGSERIAL PRIMARY KEY,
                subject_qid     TEXT NOT NULL,
                predicate       TEXT NOT NULL,
                object_qid      TEXT,
                object_text     TEXT,
                created_at      TIMESTAMPTZ DEFAULT now()
            )
        """)
        conn.commit()
        log.info("  ✅ Table created")
        return True


def populate_relationships(conn_wiki, conn_xyzo):
    """Get relationships for our sample entities."""
    # Our sample QIDs
    sample_qids = [
        "Q23548",   # NASA
        "Q42944",   # CERN
        "Q9531",    # BBC
        "Q49108",   # MIT
        "Q130879",  # Reuters
        "Q145",     # UK
        "Q30",      # USA
        "Q39",      # Switzerland
    ]

    # Key properties to test
    key_properties = ["P31", "P17", "P159", "P276", "P625", "P361", "P279"]

    log.info(f"  Fetching relationships for {len(sample_qids)} entities...")

    with conn_wiki.cursor() as cur:
        placeholders = ",".join(["%s"] * len(sample_qids))
        prop_placeholders = ",".join(["%s"] * len(key_properties))

        cur.execute(f"""
            SELECT entity_id, property, value_entity, value_text
            FROM wd_claims_flat
            WHERE entity_id IN ({placeholders})
              AND property IN ({prop_placeholders})
            LIMIT 1000
        """, (*sample_qids, *key_properties))

        relationships = list(cur.fetchall())

    log.info(f"  Got {len(relationships)} relationships from Wikidata")

    # Insert into xyzo
    log.info("  Inserting into xyzo_entity_relationships_sample...")
    inserted = 0
    with conn_xyzo.cursor() as cur:
        for rel in relationships:
            try:
                cur.execute("""
                    INSERT INTO xyzo_entity_relationships_sample (
                        subject_qid, predicate, object_qid, object_text
                    )
                    VALUES (%s, %s, %s, %s)
                """, (
                    rel['entity_id'],
                    rel['property'],
                    rel.get('value_entity'),
                    rel.get('value_text'),
                ))
                inserted += 1
            except Exception as e:
                log.warning(f"  Error: {e}")

    conn_xyzo.commit()
    log.info(f"  ✅ Inserted {inserted} relationships")

    return inserted


def verify_sample(conn):
    """Verify the sample data."""
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) as cnt FROM xyzo_entity_relationships_sample")
        count = cur.fetchone()['cnt']

        cur.execute("""
            SELECT predicate, COUNT(*) as cnt
            FROM xyzo_entity_relationships_sample
            GROUP BY predicate
            ORDER BY cnt DESC
        """)
        pred_counts = list(cur.fetchall())

        cur.execute("""
            SELECT subject_qid, predicate, object_qid, object_text
            FROM xyzo_entity_relationships_sample
            LIMIT 10
        """)
        sample = list(cur.fetchall())

    log.info(f"\n  Verification:")
    log.info(f"    Total relationships: {count}")

    log.info(f"\n  By predicate:")
    for row in pred_counts:
        name = PROPERTY_NAMES.get(row['predicate'], row['predicate'])
        log.info(f"      {row['predicate']:<6} {name:<20} = {row['cnt']}")

    return count > 0


def main():
    log.info("=" * 60)
    log.info("SAFE STEP 2: Create xyzo_entity_relationships_sample")
    log.info("=" * 60)

    conn_wiki = connect_wikidata()
    conn_xyzo = connect_xyzo()

    try:
        # Create table
        log.info("\nCreating table...")
        create_table(conn_xyzo)

        # Populate
        log.info("\nPopulating relationships...")
        inserted = populate_relationships(conn_wiki, conn_xyzo)

        # Verify
        log.info("\nVerifying...")
        success = verify_sample(conn_xyzo)

        if success:
            log.info("\n" + "=" * 60)
            log.info("✅ SAFE STEP 2 COMPLETE")
            log.info("=" * 60)
            log.info("""
Next steps:
  1. python3 -m worker.wikidata.safe_step3  # Entity resolution test
""")
            return 0
        else:
            log.error("\n❌ Verification failed")
            return 1

    finally:
        conn_wiki.close()
        conn_xyzo.close()


if __name__ == "__main__":
    sys.exit(main())
