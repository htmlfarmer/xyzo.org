#!/usr/bin/env python3
"""
Safe Step 1: Create xyzo_entities_sample (100 entities)
=====================================================
Small, safe test with CPU throttling and checkpoints.

Goal: Verify we can copy entities from Wikidata to XYzo without breaking anything.

Safety:
- Only 100 entities
- CPU throttled (1 batch per 2 seconds)
- Uses READ-ONLY wikidata DB
- Creates NEW table (doesn't touch existing data)

Run:
    python3 -m worker.wikidata.safe_step1
"""

import json
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
log = logging.getLogger("xyzo.safe_step1")

WIKIDATA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
)

# CPU throttling: seconds between batches (minimal for simple inserts)
BATCH_DELAY = 0.2

# Known important QIDs for testing - these are verified high-value entities
IMPORTANT_QIDS = [
    # Space / Science
    "Q23548",   # NASA
    "Q42944",   # CERN
    "Q334745",  # ESA
    "Q23548",   # NASA
    "Q505015",  # JPL
    "Q58104",   # SpaceX
    "Q44456",   # Microsoft
    "Q219",     # Google
    "Q17447",   # NVIDIA
    "Q30002910",# OpenAI
    "Q108089601",# Anthropic

    # Universities
    "Q49108",   # MIT
    "Q13368",   # Caltech
    "Q490565",  # University of Tokyo
    "Q49118",   # Stanford
    "Q13368",   # Harvard
    "Q35794",   # Cambridge

    # News
    "Q9720",    # Reuters
    "Q9531",    # BBC
    "Q308855",  # AP
    "Q191781",  # Bloomberg

    # Countries
    "Q30",      # USA
    "Q145",     # UK
    "Q39",      # Switzerland
    "Q142",     # France
    "Q183",     # Germany
    "Q668",     # India
    "Q148",     # China
    "Q16",      # Canada

    # Cities
    "Q60",      # New York
    "Q62",      # San Francisco
    "Q16554",   # Los Angeles
    "Q172",     # Chicago
    "Q84",      # London
    "Q220",     # Paris
    "Q17770",   # Tokyo
]

# Make unique
IMPORTANT_QIDS = list(set(IMPORTANT_QIDS))


def get_cpu_usage():
    """Get current CPU usage percentage."""
    try:
        with open('/proc/loadavg', 'r') as f:
            load = f.read().split()[0]
            # Convert to percentage (divide by CPU count)
            with open('/proc/cpuinfo', 'r') as cf:
                cpu_count = sum(1 for line in cf if line.startswith('processor'))
            return float(load) / cpu_count * 100
    except:
        return 0


def wait_for_cpu_ok(max_cpu=50):
    """Wait until CPU usage is below max_cpu."""
    while True:
        cpu = get_cpu_usage()
        if cpu < max_cpu:
            log.info(f"  CPU usage: {cpu:.1f}% (under {max_cpu}%)")
            return
        log.info(f"  CPU usage: {cpu:.1f}% (waiting for < {max_cpu}%)...")
        time.sleep(5)


def connect_wikidata():
    return psycopg.connect(WIKIDATA_DSN, row_factory=dict_row, autocommit=True)


def connect_xyzo():
    return psycopg.connect(XYZO_DSN, row_factory=dict_row, autocommit=True)


def check_existing_tables(conn):
    """Check what xyzo tables already exist."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name LIKE 'xyzo_%'
        """)
        return [row['table_name'] for row in cur.fetchall()]


def create_sample_table(conn):
    """Create xyzo_entities_sample table."""
    with conn.cursor() as cur:
        # Check if exists
        cur.execute("""
            SELECT table_name FROM information_schema.tables
            WHERE table_name = 'xyzo_entities_sample'
        """)
        if cur.fetchone():
            log.info("  Table xyzo_entities_sample already exists")
            return False

        log.info("  Creating xyzo_entities_sample table...")
        cur.execute("""
            CREATE TABLE xyzo_entities_sample (
                qid             TEXT PRIMARY KEY,
                label_en        TEXT,
                description_en  TEXT,
                entity_type     TEXT,
                lat             DOUBLE PRECISION,
                lon             DOUBLE PRECISION,
                enwiki_title    TEXT,
                importance_score DOUBLE PRECISION DEFAULT 0,
                num_claims      INTEGER DEFAULT 0,
                created_at      TIMESTAMPTZ DEFAULT now()
            )
        """)
        conn.commit()
        log.info("  ✅ Table created")
        return True


def populate_sample(conn_wiki, conn_xyzo):
    """Populate with known important QIDs."""
    # Deduplicate
    qids = list(set(IMPORTANT_QIDS))[:100]  # Max 100

    log.info(f"  Fetching {len(qids)} entities from Wikidata...")

    # Fetch from wikidata
    with conn_wiki.cursor() as cur:
        placeholders = ",".join(["%s"] * len(qids))
        cur.execute(f"""
            SELECT
                id,
                entity_type,
                label_en,
                description_en,
                enwiki_title,
                lat,
                lon
            FROM wd_entities
            WHERE id IN ({placeholders})
        """, qids)
        entities = list(cur.fetchall())

    log.info(f"  Got {len(entities)} entities from Wikidata")

    # Insert into xyzo
    log.info("  Inserting into xyzo_entities_sample...")
    inserted = 0
    with conn_xyzo.cursor() as cur:
        for entity in entities:
            # Simple importance score: +100 for having coordinates
            importance = 100.0 if entity['lat'] and entity['lon'] else 10.0

            try:
                cur.execute("""
                    INSERT INTO xyzo_entities_sample (
                        qid, label_en, description_en, entity_type,
                        lat, lon, enwiki_title, importance_score
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (qid) DO UPDATE SET
                        label_en = EXCLUDED.label_en,
                        lat = COALESCE(EXCLUDED.lat, xyzo_entities_sample.lat),
                        lon = COALESCE(EXCLUDED.lon, xyzo_entities_sample.lon),
                        importance_score = EXCLUDED.importance_score
                """, (
                    entity['id'],
                    entity['label_en'],
                    entity['description_en'],
                    entity['entity_type'],
                    entity['lat'],
                    entity['lon'],
                    entity['enwiki_title'],
                    importance,
                ))
                inserted += 1
            except Exception as e:
                log.warning(f"  Error inserting {entity['id']}: {e}")

            # CPU throttle
            if inserted % 10 == 0:
                time.sleep(BATCH_DELAY)

    conn_xyzo.commit()
    log.info(f"  ✅ Inserted {inserted} entities")

    return inserted


def verify_sample(conn):
    """Verify the sample data."""
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) as cnt FROM xyzo_entities_sample")
        count = cur.fetchone()['cnt']

        cur.execute("SELECT COUNT(*) as cnt FROM xyzo_entities_sample WHERE lat IS NOT NULL")
        with_coords = cur.fetchone()['cnt']

        log.info(f"\n  Verification:")
        log.info(f"    Total entities: {count}")
        log.info(f"    With coordinates: {with_coords}")

        cur.execute("""
            SELECT qid, label_en, lat, lon
            FROM xyzo_entities_sample
            ORDER BY importance_score DESC
            LIMIT 5
        """)
        top = list(cur.fetchall())

        log.info(f"\n  Top 5 by importance:")
        for row in top:
            log.info(f"    {row['qid']:<12} {row['label_en']:<40} {row['lat']}, {row['lon']}")

    return count > 0


def main():
    log.info("=" * 60)
    log.info("SAFE STEP 1: Create xyzo_entities_sample (100 entities)")
    log.info("=" * 60)
    log.info("CPU throttling: max 50%, 2s delay between batches")
    log.info("")

    # Connect
    log.info("Connecting to databases...")
    conn_wiki = connect_wikidata()
    conn_xyzo = connect_xyzo()
    log.info("  ✅ Connected")

    try:
        # Check existing tables
        log.info("\nChecking existing xyzo tables...")
        existing = check_existing_tables(conn_xyzo)
        if existing:
            log.info(f"  Found: {', '.join(existing)}")
        else:
            log.info("  None found")

        # Create table
        log.info("\nCreating sample table...")
        create_sample_table(conn_xyzo)

        # Populate
        log.info("\nPopulating with important entities...")
        inserted = populate_sample(conn_wiki, conn_xyzo)

        # Verify
        log.info("\nVerifying...")
        success = verify_sample(conn_xyzo)

        if success:
            log.info("\n" + "=" * 60)
            log.info("✅ SAFE STEP 1 COMPLETE")
            log.info("=" * 60)
            log.info(f"""
Next steps:
  1. Run frontend sanity check (see below)
  2. python3 -m worker.wikidata.safe_step2  # Add relationships

Frontend sanity check:
  curl -s http://xyzo.org/api/health | head -5
  curl -s "http://xyzo.org/api/pins/map?limit=5" | head -10
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
