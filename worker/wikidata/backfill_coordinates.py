#!/usr/bin/env python3
"""
Backfill coordinates for xyzo_entities from Wikidata
================================================
Wikidata stores coordinates in wd_entities (lat/lon columns).
We match via QID and update the missing lat/lon values.

Run:
    python3 -m worker.wikidata.backfill_coordinates --limit 10000
"""

import argparse
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
log = logging.getLogger("xyzo.backfill_coords")

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


def get_entities_missing_coords(conn, limit=10000):
    """Get xyzo_entities that need coordinates."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT qid, label_en
            FROM xyzo_entities
            WHERE lat IS NULL OR lon IS NULL
            ORDER BY importance_score DESC NULLS LAST
            LIMIT %s
        """, (limit,))
        return list(cur.fetchall())


def get_coords_from_wikidata(conn_wiki, qids):
    """Get coordinates for a list of QIDs - uses small batches to avoid slow scans."""
    if not qids:
        return {}

    results = {}
    batch_size = 100
    for i in range(0, len(qids), batch_size):
        batch = qids[i:i+batch_size]
        placeholders = ",".join(["%s"] * len(batch))
        try:
            with conn_wiki.cursor() as cur:
                cur.execute(f"""
                    SELECT id, lat, lon
                    FROM wd_entities
                    WHERE id IN ({placeholders})
                    AND lat IS NOT NULL AND lon IS NOT NULL
                """, batch)
                for row in cur.fetchall():
                    results[row['id']] = (row['lat'], row['lon'])
        except Exception as e:
            log.warning(f"  Batch {i//batch_size} failed: {e}")
    return results


def update_coordinates(conn, updates):
    """Batch update coordinates."""
    count = 0
    for qid, (lat, lon) in updates.items():
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE xyzo_entities
                SET lat = %s, lon = %s, updated_at = NOW()
                WHERE qid = %s AND (lat IS NULL OR lon IS NULL)
            """, (lat, lon, qid))
            count += cur.rowcount
    conn.commit()
    return count


def main():
    parser = argparse.ArgumentParser(description="Backfill coordinates for xyzo_entities")
    parser.add_argument("--limit", type=int, default=10000, help="Max entities to process")
    parser.add_argument("--dry", action="store_true", help="Dry run only")
    args = parser.parse_args()

    conn_xyzo = connect_xyzo()
    conn_wiki = connect_wikidata()

    try:
        # Get entities missing coords
        log.info(f"Fetching entities missing coordinates (limit={args.limit})...")
        entities = get_entities_missing_coords(conn_xyzo, args.limit)
        log.info(f"  Found {len(entities)} entities needing coordinates")

        if not entities:
            log.info("  No entities need coordinates")
            return 0

        # Get QIDs
        qids = [e['qid'] for e in entities]

        # Lookup coordinates
        log.info(f"Looking up coordinates in Wikidata for {len(qids)} QIDs...")
        coords = get_coords_from_wikidata(conn_wiki, qids)
        log.info(f"  Found coordinates for {len(coords)} entities")

        if not coords:
            log.info("  No coordinates found in Wikidata")
            return 0

        # Report sample matches
        log.info("\nSample coordinate matches:")
        for i, (qid, (lat, lon)) in enumerate(list(coords.items())[:5]):
            log.info(f"    {qid}: ({lat:.4f}, {lon:.4f})")

        if args.dry:
            log.info(f"\n[DRY RUN] Would update {len(coords)} entities")
            return len(coords)

        # Update
        count = update_coordinates(conn_xyzo, coords)
        log.info(f"\n✅ Updated {count} entities with coordinates")

        # Final stats
        with conn_xyzo.cursor() as cur:
            cur.execute("""
                SELECT
                    COUNT(*) as total,
                    COUNT(CASE WHEN lat IS NOT NULL THEN 1 END) as with_coords
                FROM xyzo_entities
            """)
            stats = cur.fetchone()
            log.info(f"\nxyzo_entities now: {stats['total']} total, {stats['with_coords']} with coords ({stats['with_coords']/stats['total']*100:.1f}%)")

        return count

    finally:
        conn_xyzo.close()
        conn_wiki.close()


if __name__ == "__main__":
    sys.exit(main())
