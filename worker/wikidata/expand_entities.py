#!/usr/bin/env python3
"""
Expand xyzo_entities from news_entities
====================================
Learn from existing news_entities to expand our Wikidata knowledge.

Strategy:
1. Get all unique country/location names from news_entities
2. Look them up in Wikidata
3. Add them to xyzo_entities

This grows our knowledge base from what XYZO already knows.

Run:
    python3 -m worker.wikidata.expand_entities
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
log = logging.getLogger("xyzo.expand_entities")

WIKIDATA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
)


def connect_wikidata():
    return psycopg.connect(WIKIDATA_DSN, row_factory=dict_row, autocommit=True)


def connect_xyzo():
    return psycopg.connect(XYZO_DSN, row_factory=dict_row, autocommit=True)


def get_unique_entity_names(conn):
    """Get unique entity names from news_entities."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT name
            FROM news_entities
            WHERE wikidata_id IS NULL
            LIMIT 50000
        """)
        return [row['name'] for row in cur.fetchall()]


def lookup_in_wikidata(wikidata_conn, names):
    """Look up names in Wikidata via enwiki_title."""
    if not names:
        return {}

    results = {}
    placeholders = ",".join(["%s"] * len(names))

    with wikidata_conn.cursor() as cur:
        cur.execute(f"""
            SELECT enwiki_title, id, label_en, lat, lon
            FROM wd_entities
            WHERE enwiki_title IN ({placeholders})
        """, names)
        for row in cur.fetchall():
            if row['enwiki_title']:
                results[row['enwiki_title']] = row

    return results


def main():
    log.info("=" * 60)
    log.info("EXPAND xyzo_entities FROM news_entities")
    log.info("=" * 60)

    conn_wiki = connect_wikidata()
    conn_xyzo = connect_xyzo()

    try:
        # Get unique names from news_entities
        log.info("\nFetching unique entity names from news_entities...")
        names = get_unique_entity_names(conn_xyzo)
        log.info(f"  Found {len(names)} unique names")

        # Look up in Wikidata
        log.info("\nLooking up in Wikidata...")
        wikidata_results = lookup_in_wikidata(conn_wiki, names)
        log.info(f"  Found {len(wikidata_results)} matches in Wikidata")

        # Add to xyzo_entities
        log.info("\nAdding to xyzo_entities...")
        added = 0
        for title, row in wikidata_results.items():
            try:
                with conn_xyzo.cursor() as cur:
                    cur.execute("""
                        INSERT INTO xyzo_entities (qid, label_en, lat, lon, enwiki_title, importance_score, entity_rank)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (qid) DO NOTHING
                    """, (
                        row['id'],
                        row['label_en'],
                        row['lat'],
                        row['lon'],
                        row['enwiki_title'],
                        100,  # Base importance
                        'medium'
                    ))
                    if cur.rowcount > 0:
                        added += 1
            except Exception as e:
                log.warning(f"  Error adding {row['id']}: {e}")

        conn_xyzo.commit()
        log.info(f"  Added {added} new entities to xyzo_entities")

        # Final count
        with conn_xyzo.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM xyzo_entities")
            total = cur.fetchone()['count']

        log.info(f"\nxyzo_entities now has {total} entities")

        log.info("""
\nNext:
  python3 -m worker.wikidata.resolve_entities --batch 5000
""")

    finally:
        conn_wiki.close()
        conn_xyzo.close()


if __name__ == "__main__":
    sys.exit(main())
