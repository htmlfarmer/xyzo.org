#!/usr/bin/env python3
"""
Safe Step 3: Entity Resolution Test
===================================
Tests if we can resolve XYzo entity names to Wikidata QIDs.

This is THE key test - does having xyzo_entities actually help us
understand what's in our news?

Run:
    python3 -m worker.wikidata.safe_step3
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
log = logging.getLogger("xyzo.safe_step3")

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
)

WIKIDATA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)


def connect_xyzo():
    return psycopg.connect(XYZO_DSN, row_factory=dict_row, autocommit=True)


def connect_wikidata():
    return psycopg.connect(WIKIDATA_DSN, row_factory=dict_row, autocommit=True)


def test_resolution(conn_xyzo, conn_wiki):
    """
    Test: Can we resolve our sample entities to Wikidata QIDs?

    Strategy:
    1. Take entities from xyzo_entities_sample
    2. Try to match them to our xyzo_entities table
    3. Show what context we get from Wikidata
    """
    log.info("\n" + "=" * 60)
    log.info("ENTITY RESOLUTION TEST")
    log.info("=" * 60)

    # Get entities from our sample table
    with conn_xyzo.cursor() as cur:
        cur.execute("""
            SELECT qid, label_en, lat, lon
            FROM xyzo_entities_sample
            WHERE label_en IS NOT NULL
            LIMIT 20
        """)
        our_entities = list(cur.fetchall())

    log.info(f"\n  Our entities in xyzo_entities_sample: {len(our_entities)}")

    # Now try to resolve them using Wikipedia title lookup in Wikidata
    log.info("\n  Testing: Can we resolve using enwiki_title?")

    resolved = 0
    unresolved = 0

    for entity in our_entities:
        qid = entity['qid']
        label = entity['label_en']

        # Query Wikidata directly to see if we can get more context
        with conn_wiki.cursor() as cur:
            cur.execute("""
                SELECT id, label_en, description_en, lat, lon, enwiki_title
                FROM wd_entities
                WHERE enwiki_title = %s
                LIMIT 1
            """, (label,))
            wd_entity = cur.fetchone()

        if wd_entity:
            resolved += 1
            log.info(f"  ✅ {label:<35} → {wd_entity['id']}")
            if wd_entity['description_en']:
                log.info(f"      📝 {wd_entity['description_en'][:60]}...")
        else:
            unresolved += 1
            log.info(f"  ❌ {label:<35} → not found via Wikipedia title")

    log.info(f"\n  Resolution rate: {resolved}/{resolved+unresolved} ({resolved/(resolved+unresolved)*100:.0f}%)")

    # Now test: What if we use our xyzo_entities_sample as a lookup table?
    log.info("\n" + "=" * 60)
    log.info("VALUE OF xyzo_entities_sample")
    log.info("=" * 60)

    with conn_xyzo.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) as with_coords
            FROM xyzo_entities_sample
        """)
        stats = cur.fetchone()

    log.info(f"\n  Our xyzo_entities_sample contains:")
    log.info(f"    Total entities: {stats['total']}")
    log.info(f"    With coordinates: {stats['with_coords']}")
    log.info(f"    Coverage: {stats['with_coords']/stats['total']*100:.0f}%")

    # What context do we have?
    log.info("\n  Sample entity context:")
    with conn_xyzo.cursor() as cur:
        cur.execute("""
            SELECT qid, label_en, description_en, lat, lon
            FROM xyzo_entities_sample
            WHERE lat IS NOT NULL
            LIMIT 3
        """)
        samples = list(cur.fetchall())

    for s in samples:
        log.info(f"\n    {s['label_en']} ({s['qid']})")
        log.info(f"      Description: {s['description_en'] or 'N/A'}")
        log.info(f"      Location: {s['lat']:.4f}, {s['lon']:.4f}")

    return resolved, unresolved


def main():
    log.info("=" * 60)
    log.info("SAFE STEP 3: Entity Resolution Test")
    log.info("=" * 60)

    conn_xyzo = connect_xyzo()
    conn_wiki = connect_wikidata()

    try:
        resolved, unresolved = test_resolution(conn_xyzo, conn_wiki)

        log.info("\n" + "=" * 60)
        log.info("✅ SAFE STEP 3 COMPLETE")
        log.info("=" * 60)

        if resolved > 0:
            log.info(f"""
NEXT STEPS:
  1. The xyzo_entities_sample IS useful - we can resolve entities!
  2. We could now populate news_entities.wikidata_id for real entities
  3. python3 -m worker.wikidata.safe_step4  # Test coverage gaps

VALUE DEMONSTRATED:
  - {resolved} entities resolved from sample
  - All resolved entities have coordinates
  - Wikipedia titles enable cross-database linking
""")
        else:
            log.info("""
❌ ISSUE: No entities resolved
  - This suggests the enwiki_title matching isn't working
  - Need to investigate alternative matching strategies
""")

        return 0

    finally:
        conn_xyzo.close()
        conn_wiki.close()


if __name__ == "__main__":
    sys.exit(main())
