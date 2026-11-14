#!/usr/bin/env python3
"""
Entity Resolution Pipeline
========================
Resolves news_entities (from articles) to xyzo_entities (Wikidata).

This connects XYZO's news understanding to Wikidata's knowledge graph.

How it works:
1. Take news_entity names (e.g., "NASA", "Houston", "WHO")
2. Try to match against xyzo_entities.label_en (exact, then fuzzy)
3. If matched, get the QID and all Wikidata context
4. Update news_entities.wikidata_id with the QID

Result:
- Article about "NASA in Houston" →
- NASA → Q23548 (with coordinates, country, instance_of)
- Houston → Q16555 (with NASA JSC located there!)
- Story context: "NASA expanding in Houston"

Run:
    python3 -m worker.wikidata.resolve_entities          # Full resolution
    python3 -m worker.wikidata.resolve_entities --dry    # Test only
    python3 -m worker.wikidata.resolve_entities --batch 1000  # Process N entities
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
log = logging.getLogger("xyzo.resolve_entities")

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
)


def connect_xyzo():
    return psycopg.connect(XYZO_DSN, row_factory=dict_row, autocommit=True)


def get_unresolved_entities(conn, limit=1000):
    """Get entities that need wikidata_id."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, type
            FROM news_entities
            WHERE wikidata_id IS NULL
            ORDER BY id
            LIMIT %s
        """, (limit,))
        return list(cur.fetchall())


def resolve_exact_match(conn, names):
    """Method 1: Exact label match."""
    if not names:
        return {}

    placeholders = ",".join(["%s"] * len(names))
    with conn.cursor() as cur:
        cur.execute(f"""
            SELECT qid, label_en
            FROM xyzo_entities
            WHERE label_en IN ({placeholders})
        """, names)
        return {row['label_en']: row['qid'] for row in cur.fetchall()}


def resolve_case_insensitive(conn, names):
    """Method 2: Case-insensitive match (handles 'USA' vs 'U.S.A.' issues)."""
    if not names:
        return {}
    result = {}
    upper_names = {n.upper(): n for n in names}
    placeholders = ",".join(["%s"] * len(upper_names))
    with conn.cursor() as cur:
        cur.execute(f"""
            SELECT qid, label_en, UPPER(label_en) as upper_label
            FROM xyzo_entities
            WHERE UPPER(label_en) IN ({placeholders})
        """, list(upper_names.keys()))
        for row in cur.fetchall():
            original = upper_names.get(row['upper_label'])
            if original:
                result[original] = row['qid']
    return result


def resolve_fuzzy_match(conn, name):
    """Method 3: Fuzzy match using trigram similarity."""
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT qid, label_en, similarity(label_en, %s) AS sim
                FROM xyzo_entities
                WHERE label_en %% %s AND sim > 0.4
                ORDER BY sim DESC
                LIMIT 1
            """, (name, name))
            row = cur.fetchone()
            if row:
                return {name: row['qid']}
    except Exception:
        pass
    return {}


def update_wikidata_ids(conn, updates):
    """Batch update wikidata_id."""
    for entity_id, qid in updates:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE news_entities
                SET wikidata_id = %s
                WHERE id = %s AND wikidata_id IS NULL
            """, (qid, entity_id))
    conn.commit()


def get_resolution_stats(conn):
    """Get resolution statistics."""
    with conn.cursor() as cur:
        stats = {}

        cur.execute("SELECT COUNT(*) FROM news_entities")
        stats['total'] = cur.fetchone()['count']

        cur.execute("SELECT COUNT(*) FROM news_entities WHERE wikidata_id IS NOT NULL")
        stats['resolved'] = cur.fetchone()['count']

        cur.execute("SELECT COUNT(*) FROM news_entities WHERE wikidata_id IS NULL")
        stats['unresolved'] = cur.fetchone()['count']

        cur.execute("""
            SELECT type, COUNT(*) as cnt
            FROM news_entities
            WHERE wikidata_id IS NOT NULL
            GROUP BY type
        """)
        stats['by_type'] = {row['type']: row['cnt'] for row in cur.fetchall()}

        return stats


def resolve_batch(conn, batch_size=1000, dry_run=False):
    """Resolve a batch of entities."""
    entities = get_unresolved_entities(conn, batch_size)
    if not entities:
        log.info("  No unresolved entities")
        return 0, 0

    log.info(f"  Processing {len(entities)} unresolved entities...")

    names = [e['name'] for e in entities]

    # Exact match
    exact_matches = resolve_exact_match(conn, names)

    # Case-insensitive match for remaining
    unmatched_names = [n for n in names if n not in exact_matches]
    ci_matches = resolve_case_insensitive(conn, unmatched_names)

    # Fuzzy matches for still-unmatched (slow, one-by-one)
    fuzzy_matches = {}
    if len(unmatched_names) > len(ci_matches):
        remaining = [n for n in unmatched_names if n not in ci_matches]
        log.info(f"  Fuzzy matching {len(remaining)} remaining...")
        for i, name in enumerate(remaining):
            if i % 100 == 0:
                log.info(f"    Progress: {i}/{len(remaining)}")
            fuzzy = resolve_fuzzy_match(conn, name)
            fuzzy_matches.update(fuzzy)

    # Build update list
    updates = []
    for entity in entities:
        qid = exact_matches.get(entity['name']) or ci_matches.get(entity['name']) or fuzzy_matches.get(entity['name'])
        if qid:
            updates.append((entity['id'], qid))

    if not updates:
        log.info(f"  No matches found for {len(entities)} entities")
        return 0, len(entities)

    log.info(f"  Matches: {len(exact_matches)} exact, {len(ci_matches)} case-insensitive, {len(fuzzy_matches)} fuzzy")

    if dry_run:
        log.info(f"  [DRY RUN] Would update {len(updates)} entities")
        return len(updates), 0

    # Update
    update_wikidata_ids(conn, updates)
    log.info(f"  ✅ Updated {len(updates)} entities")

    return len(updates), 0


def show_sample_context(conn):
    """Show what context we get from resolved entities."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT ne.id, ne.name, ne.type, ne.wikidata_id,
                   xe.label_en, xe.description_en, xe.lat, xe.lon
            FROM news_entities ne
            JOIN xyzo_entities xe ON xe.qid = ne.wikidata_id
            WHERE ne.wikidata_id IS NOT NULL
            LIMIT 10
        """)
        samples = list(cur.fetchall())

    if not samples:
        log.info("\n  No resolved entities yet")
        return

    log.info("\n  Sample resolved entities:")
    for s in samples:
        log.info(f"\n    {s['name']} ({s['type']})")
        log.info(f"      QID: {s['wikidata_id']}")
        log.info(f"      Label: {s['label_en']}")
        log.info(f"      Description: {s['description_en'] or 'N/A'}")
        if s['lat']:
            log.info(f"      Location: {s['lat']:.4f}, {s['lon']:.4f}")


def main():
    parser = argparse.ArgumentParser(description="Resolve news_entities to Wikidata")
    parser.add_argument("--batch", type=int, default=1000, help="Batch size")
    parser.add_argument("--dry", action="store_true", help="Dry run only")
    parser.add_argument("--status", action="store_true", help="Show status only")
    args = parser.parse_args()

    conn = connect_xyzo()

    try:
        # Show current stats
        stats = get_resolution_stats(conn)
        log.info("=" * 60)
        log.info("ENTITY RESOLUTION PIPELINE")
        log.info("=" * 60)
        log.info(f"Total entities: {stats['total']}")
        log.info(f"Resolved: {stats['resolved']} ({stats['resolved']/max(stats['total'],1)*100:.1f}%)")
        log.info(f"Unresolved: {stats['unresolved']}")

        if args.status:
            show_sample_context(conn)
            return 0

        if args.dry:
            log.info("\n[DRY RUN MODE]")
            resolve_batch(conn, args.batch, dry_run=True)
            return 0

        # Process batches
        total_resolved = 0
        batch_num = 0

        while True:
            batch_num += 1
            log.info(f"\nBatch {batch_num}:")

            resolved, unresolved = resolve_batch(conn, args.batch)

            total_resolved += resolved

            if unresolved == 0 or resolved == 0:
                break

        # Final stats
        stats = get_resolution_stats(conn)
        log.info("\n" + "=" * 60)
        log.info("RESOLUTION COMPLETE")
        log.info("=" * 60)
        log.info(f"Total entities: {stats['total']}")
        log.info(f"Resolved: {stats['resolved']} ({stats['resolved']/max(stats['total'],1)*100:.1f}%)")
        log.info(f"Unresolved: {stats['unresolved']}")

        show_sample_context(conn)

        log.info("""
\nNext steps:
  1. python3 -m worker.wikidata.detect_coverage_gaps  # Find missing coverage
  2. python3 -m worker.wikidata.entity_resolution --status  # Verify
""")

    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
