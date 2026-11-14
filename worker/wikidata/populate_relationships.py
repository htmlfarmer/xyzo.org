#!/usr/bin/env python3
"""
Populate xyzo_entity_relationships for priority entities
======================================================
Creates the relationship graph for our priority entities.

Backup: DROP TABLE xyzo_entity_relationships;

Run:
    python3 -m worker.wikidata.populate_relationships
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
log = logging.getLogger("xyzo.populate_rels")

WIKIDATA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
)

# Key properties for XYZO intelligence
KEY_PROPERTIES = ["P31", "P17", "P159", "P276", "P625", "P361", "P279", "P150", "P106", "P463"]

PROPERTY_NAMES = {
    "P31": "instance of",
    "P17": "country",
    "P159": "headquarters",
    "P276": "location",
    "P625": "coordinate location",
    "P361": "part of",
    "P279": "subclass of",
    "P150": "contains",
    "P106": "occupation",
    "P463": "member of",
}


def connect_wikidata():
    return psycopg.connect(WIKIDATA_DSN, row_factory=dict_row, autocommit=True)


def connect_xyzo():
    return psycopg.connect(XYZO_DSN, row_factory=dict_row, autocommit=True)


def create_table(conn):
    """Create xyzo_entity_relationships table."""
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS xyzo_entity_relationships (
                id              BIGSERIAL PRIMARY KEY,
                subject_qid     TEXT NOT NULL,
                predicate       TEXT NOT NULL,
                object_qid      TEXT,
                object_text     TEXT,
                importance      DOUBLE PRECISION DEFAULT 1.0,
                created_at      TIMESTAMPTZ DEFAULT now()
            )
        """)

        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_xyzo_rel_subject
            ON xyzo_entity_relationships(subject_qid)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_xyzo_rel_predicate
            ON xyzo_entity_relationships(predicate)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_xyzo_rel_object
            ON xyzo_entity_relationships(object_qid)
            WHERE object_qid IS NOT NULL
        """)

        conn.commit()
        log.info("  Table created")


def populate_relationships(conn_wiki, conn_xyzo):
    """Populate relationships for priority entities."""
    # Get QIDs from xyzo_entities
    with conn_xyzo.cursor() as cur:
        cur.execute("SELECT qid FROM xyzo_entities LIMIT 200")
        qids = [row['qid'] for row in cur.fetchall()]

    log.info(f"  Populating relationships for {len(qids)} entities...")

    prop_placeholders = ",".join(["%s"] * len(KEY_PROPERTIES))
    total_inserted = 0

    # Batch by 10 entities
    for i in range(0, len(qids), 10):
        batch = qids[i:i + 10]
        entity_placeholders = ",".join(["%s"] * len(batch))

        with conn_wiki.cursor() as cur:
            cur.execute(f"""
                SELECT entity_id, property, value_entity, value_text
                FROM wd_claims_flat
                WHERE entity_id IN ({entity_placeholders})
                  AND property IN ({prop_placeholders})
            """, (*batch, *KEY_PROPERTIES))
            claims = list(cur.fetchall())

        if not claims:
            continue

        # Insert relationships
        with conn_xyzo.cursor() as cur:
            for claim in claims:
                # Importance based on property
                importance = {
                    "P31": 10,  # instance of - most important
                    "P17": 9,   # country
                    "P159": 8,  # headquarters
                    "P276": 7,  # location
                    "P625": 10, # coordinates
                    "P361": 6,  # part of
                    "P279": 5,  # subclass of
                    "P150": 6,  # contains
                    "P106": 4,  # occupation
                    "P463": 4,  # member of
                }.get(claim['property'], 1.0)

                cur.execute("""
                    INSERT INTO xyzo_entity_relationships
                    (subject_qid, predicate, object_qid, object_text, importance)
                    VALUES (%s, %s, %s, %s, %s)
                """, (
                    claim['entity_id'],
                    claim['property'],
                    claim.get('value_entity'),
                    claim.get('value_text'),
                    importance
                ))
                total_inserted += 1

        conn_xyzo.commit()

        if (i + 10) % 50 == 0:
            log.info(f"    Processed {i + 10}/{len(qids)} entities, {total_inserted} relationships")

    log.info(f"  ✅ Inserted {total_inserted} relationships")
    return total_inserted


def verify(conn):
    """Verify relationships."""
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM xyzo_entity_relationships")
        total = cur.fetchone()['count']

        cur.execute("""
            SELECT predicate, COUNT(*) as cnt
            FROM xyzo_entity_relationships
            GROUP BY predicate
            ORDER BY cnt DESC
        """)
        by_pred = list(cur.fetchall())

    log.info(f"\n  Verification:")
    log.info(f"    Total relationships: {total}")
    log.info(f"    By predicate:")
    for row in by_pred:
        name = PROPERTY_NAMES.get(row['predicate'], row['predicate'])
        log.info(f"      {row['predicate']:<6} {name:<20} = {row['cnt']}")

    return total


def rollback(conn):
    """Rollback - drop table."""
    with conn.cursor() as cur:
        cur.execute("DROP TABLE IF EXISTS xyzo_entity_relationships CASCADE")
        conn.commit()
    log.info("  Rolled back - table dropped")


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "run"

    log.info("=" * 60)
    log.info("POPULATE xyzo_entity_relationships")
    log.info("=" * 60)

    if action == "rollback":
        log.info("ROLLBACK MODE")
        conn = connect_xyzo()
        rollback(conn)
        conn.close()
        return 0

    if action == "status":
        conn = connect_xyzo()
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM xyzo_entity_relationships")
            log.info(f"Relationships: {cur.fetchone()['count']}")
        conn.close()
        return 0

    conn_wiki = connect_wikidata()
    conn_xyzo = connect_xyzo()

    try:
        log.info("\nCreating table...")
        create_table(conn_xyzo)

        log.info("\nPopulating relationships...")
        inserted = populate_relationships(conn_wiki, conn_xyzo)

        log.info("\nVerifying...")
        verify(conn_xyzo)

        log.info("\n" + "=" * 60)
        log.info("DONE!")
        log.info("=" * 60)
        log.info("""
Backup: python3 -m worker.wikidata.populate_relationships rollback
Status: python3 -m worker.wikidata.populate_relationships status
""")

    finally:
        conn_wiki.close()
        conn_xyzo.close()


if __name__ == "__main__":
    sys.exit(main())
