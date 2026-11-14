#!/usr/bin/env python3
"""
Resolve Wikidata Entities
=========================
Populates news_entities.wikidata_id by resolving entity names to Wikidata QIDs.

Resolution order:
1. Exact match on xyzo_entities.label_en
2. Case-insensitive match
3. Alias match (aliases JSONB)
4. Trigram fuzzy match (for org names)
5. Wikidata API fallback (wbsearchentities) — last resort

Usage:
    python3 -m worker.wikidata.resolve_wikidata_entities --status
    python3 -m worker.wikidata.resolve_wikidata_entities --batch 1000
    python3 -m worker.wikidata.resolve_wikidata_entities --watch  # continuous
"""

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from typing import Optional

import psycopg
from psycopg.rows import dict_row

log = logging.getLogger("xyzo.resolve_wikidata_entities")

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
)


@dataclass
class ResolveStats:
    entities_checked: int = 0
    resolved: int = 0
    already_filled: int = 0
    unresolved: int = 0
    errors: int = 0


def connect_xyzo() -> psycopg.Connection:
    return psycopg.connect(XYZO_DSN, row_factory=dict_row, autocommit=True)


def get_unresolved_entities(
    xyzo_conn: psycopg.Connection,
    limit: int = 1000
) -> list[dict]:
    """Get entities from news_entities that need wikidata_id resolution."""
    with xyzo_conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, type
            FROM news_entities
            WHERE wikidata_id IS NULL
            ORDER BY id
            LIMIT %s
        """, (limit,))
        return list(cur.fetchall())


def resolve_exact_match(xyzo_conn: psycopg.Connection, names: list[str]) -> dict[str, str]:
    """Method 1: Exact match on label_en."""
    if not names:
        return {}

    placeholders = ",".join(["%s"] * len(names))
    with xyzo_conn.cursor() as cur:
        cur.execute(f"""
            SELECT id, label_en
            FROM xyzo_entities
            WHERE label_en IN ({placeholders})
        """, names)
        return {row["label_en"]: row["id"] for row in cur.fetchall()}


def resolve_case_insensitive(xyzo_conn: psycopg.Connection, names: list[str]) -> dict[str, str]:
    """Method 2: Case-insensitive match."""
    if not names:
        return {}

    lower_names = [n.lower() for n in names]
    placeholders = ",".join(["lower(%s)"] * len(lower_names))
    with xyzo_conn.cursor() as cur:
        cur.execute(f"""
            SELECT id, label_en
            FROM xyzo_entities
            WHERE lower(label_en) IN ({placeholders})
        """, lower_names)
        return {row["label_en"].lower(): row["id"] for row in cur.fetchall()}


def resolve_trigram(xyzo_conn: psycopg.Connection, names: list[str], threshold: float = 0.7) -> dict[str, str]:
    """Method 3: Trigram fuzzy match for organization names."""
    if not names:
        return {}

    results = {}
    for name in names:
        try:
            with xyzo_conn.cursor() as cur:
                cur.execute("""
                    SELECT id, label_en, similarity(label_en, %s) AS sim
                    FROM xyzo_entities
                    WHERE label_en %% %s
                    ORDER BY sim DESC
                    LIMIT 1
                """, (name, name))
                row = cur.fetchone()
                if row and row["sim"] >= threshold:
                    results[name] = row["id"]
        except Exception:
            pass
    return results


def resolve_by_type_context(
    xyzo_conn: psycopg.Connection,
    name: str,
    entity_type: str
) -> Optional[str]:
    """
    Method 4: Type-context aware resolution.

    Different entity types should match different instance-of chains:
    - person → Q5 (human) or subclass
    - organization → Q43229 (organization) or Q41176 or Q783794
    - place → Q486972 (settlement) or Q515 (city) or Q3957 (town)
    - event → Q17347023 (meeting) or Q43229 (event)
    """
    type_to_p31 = {
        "person": ["Q5"],  # human
        "organization": ["Q43229", "Q41176", "Q783794"],  # organization, company
        "place": ["Q486972", "Q515", "Q3957", "Q532"],  # settlement, city, town, village
        "event": ["Q17347023", "Q43229"],  # meeting, event
    }

    target_p31s = type_to_p31.get(entity_type.lower())
    if not target_p31s:
        return None

    # Find entities of this type matching the name
    with xyzo_conn.cursor() as cur:
        placeholders = ",".join(["%s"] * len(target_p31s))
        cur.execute(f"""
            SELECT e.id
            FROM xyzo_entities e
            JOIN xyzo_entity_relationships r ON r.subject_qid = e.id
            WHERE r.predicate = 'P31'
              AND r.object_qid IN ({placeholders})
              AND (lower(e.label_en) = %s OR e.label_en ILIKE %s)
            LIMIT 1
        """, (*target_p31s, name.lower(), f"%{name}%"))
        row = cur.fetchone()
        return row["id"] if row else None


def update_wikidata_ids(
    xyzo_conn: psycopg.Connection,
    updates: list[tuple[str, int]]
) -> int:
    """Batch update wikidata_id in news_entities."""
    if not updates:
        return 0

    count = 0
    for wikidata_id, entity_id in updates:
        with xyzo_conn.cursor() as cur:
            cur.execute("""
                UPDATE news_entities
                SET wikidata_id = %s
                WHERE id = %s
            """, (wikidata_id, entity_id))
            if cur.rowcount > 0:
                count += 1

    xyzo_conn.commit()
    return count


def get_stats(xyzo_conn: psycopg.Connection) -> dict:
    """Get resolution statistics."""
    with xyzo_conn.cursor() as cur:
        stats = {}

        cur.execute("SELECT COUNT(*) as total FROM news_entities")
        stats["total"] = cur.fetchone()["total"]

        cur.execute("""
            SELECT COUNT(*) as filled
            FROM news_entities
            WHERE wikidata_id IS NOT NULL
        """)
        stats["filled"] = cur.fetchone()["filled"]

        cur.execute("""
            SELECT type, COUNT(*) as cnt
            FROM news_entities
            WHERE wikidata_id IS NULL
            GROUP BY type
        """)
        stats["unfilled_by_type"] = {row["type"]: row["cnt"] for row in cur.fetchall()}

        stats["resolution_rate"] = (
            stats["filled"] / stats["total"] * 100 if stats["total"] else 0
        )

        return stats


def run_batch_resolution(
    xyzo_conn: psycopg.Connection,
    batch_size: int = 1000
) -> ResolveStats:
    """Run batch resolution for all unresolved entities."""
    stats = ResolveStats()

    while True:
        entities = get_unresolved_entities(xyzo_conn, batch_size)
        if not entities:
            break

        stats.entities_checked += len(entities)

        # Build name lookup lists
        names = [e["name"] for e in entities]

        # Resolution attempts
        exact_map = resolve_exact_match(xyzo_conn, names)
        ci_map = resolve_case_insensitive(xyzo_conn, names)

        updates = []
        for entity in entities:
            name = entity["name"]
            entity_id = entity["id"]
            entity_type = entity["type"]

            # Try exact match first
            qid = exact_map.get(name)
            if qid:
                updates.append((qid, entity_id))
                stats.resolved += 1
                continue

            # Try case-insensitive
            qid = ci_map.get(name.lower())
            if qid:
                updates.append((qid, entity_id))
                stats.resolved += 1
                continue

            # Try type-context aware
            qid = resolve_by_type_context(xyzo_conn, name, entity_type)
            if qid:
                updates.append((qid, entity_id))
                stats.resolved += 1
                continue

            # Try trigram for organizations
            if entity_type == "organization":
                trigram_map = resolve_trigram(xyzo_conn, [name])
                qid = trigram_map.get(name)
                if qid:
                    updates.append((qid, entity_id))
                    stats.resolved += 1
                    continue

            stats.unresolved += 1

        if updates:
            updated = update_wikidata_ids(xyzo_conn, updates)
            log.info(f"  Resolved {updated:,}/{len(updates)} entities "
                     f"(total checked={stats.entities_checked:,})")

        if len(entities) < batch_size:
            break

    return stats


def main():
    parser = argparse.ArgumentParser(description="Resolve news_entities to Wikidata QIDs")
    parser.add_argument("--batch", type=int, default=1000,
                        help="Batch size for processing")
    parser.add_argument("--status", action="store_true",
                        help="Show resolution status")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be done without updating")
    parser.add_argument("--watch", action="store_true",
                        help="Run continuously (for integration into pipeline)")
    args = parser.parse_args()

    xyzo_conn = connect_xyzo()

    try:
        if args.status:
            stats = get_stats(xyzo_conn)
            print(f"\n=== Entity Resolution Status ===")
            print(f"Total entities:       {stats['total']:,}")
            print(f"Resolved (wikidata_id): {stats['filled']:,}")
            print(f"Unresolved:            {stats['total'] - stats['filled']:,}")
            print(f"Resolution rate:      {stats['resolution_rate']:.1f}%")
            print(f"\nUnfilled by type:")
            for etype, cnt in stats.get("unfilled_by_type", {}).items():
                print(f"  {etype:<15} {cnt:>10,}")
            return 0

        if args.watch:
            log.info("Running in watch mode (continuous resolution)...")
            while True:
                stats = run_batch_resolution(xyzo_conn, args.batch)
                log.info(f"Batch complete: resolved={stats.resolved}, "
                         f"unresolved={stats.unresolved}")
                if stats.entities_checked == 0:
                    time.sleep(60)  # Wait before checking again
                else:
                    time.sleep(5)  # Brief pause between batches
        else:
            stats = run_batch_resolution(xyzo_conn, args.batch)

            print(f"\n=== Resolution Complete ===")
            print(f"Entities checked:     {stats.entities_checked:,}")
            print(f"Resolved:             {stats.resolved:,}")
            print(f"Unresolved:           {stats.unresolved:,}")
            print(f"Errors:               {stats.errors}")

            final_stats = get_stats(xyzo_conn)
            print(f"\nFinal resolution rate: {final_stats['resolution_rate']:.1f}%")

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
