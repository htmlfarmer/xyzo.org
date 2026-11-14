#!/usr/bin/env python3
"""
Populate xyzo_entity_relationships
==================================
Creates xyzo_entity_relationships from wd_claims_flat (183M claims).

This is XYZO's "relationship graph" — from Wikidata's flattened claims.

Key properties prioritized:
- P31   instance of        → entity classification
- P17   country           → geographic ownership
- P131  located in        → administrative hierarchy
- P276  location          → physical location
- P279  subclass of       → ontology
- P159  headquarters      → org location
- P150  contains          → administrative containment
- P361  part of           → compositional hierarchy
- P106  occupation        → person roles
- P463  member of         → organizational membership
- P527  has part          → composition
- P625  coordinate location → spatial position

Usage:
    python3 -m worker.wikidata.populate_xyzo_relationships --status
    python3 -m worker.wikidata.populate_xyzo_relationships --properties P31,P17,P131
    python3 -m worker.wikidata.populate_xyzo_relationships --sample 0.1
"""

import argparse
import json
import logging
import os
import sys
from collections import Counter
from dataclasses import dataclass
from typing import Iterator

import psycopg
from psycopg.rows import dict_row

log = logging.getLogger("xyzo.populate_xyzo_relationships")

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
    "P131": "located in administrative entity",
    "P276": "location",
    "P279": "subclass of",
    "P159": "headquarters location",
    "P150": "contains administrative entities",
    "P361": "part of",
    "P106": "occupation",
    "P463": "member of",
    "P527": "has part",
    "P625": "coordinate location",
    "P18": "image",
    "P856": "official website",
    "P36": "capital",
    "P37": "official language",
    "P38": "currency",
    "P35": "head of state",
    "P6": "head of government",
    "P30": "continent",
    "P421": "time zone",
    "P2048": "height",
    "P2046": "area",
    "P2067": "mass",
    "P1082": "population",
    "P571": "inception",
    "P569": "date of birth",
    "P570": "date of death",
    "P19": "place of birth",
    "P20": "place of death",
    "P27": "country of citizenship",
    "P3373": "sibling",
    "P22": "father",
    "P25": "mother",
    "P26": "spouse",
    "P40": "child",
    "P1038": "relative",
    "P1040": "film editor",
    "P86": "composer",
    "P57": "director",
    "P161": "cast member",
    "P175": "performer",
    "P344": "director of photography",
    "P162": "producer",
    "P750": "distributed by",
    "P57": "director",
    "P264": "record label",
    "P435": "field of this profession",
    "P641": "sport",
    "P413": "position",
    "P39": "position held",
    "P102": "member of political party",
    "P1412": "languages spoken/written",
    "P69": "educated at",
    "P108": "employer",
    "P166": "award received",
    "P1344": "participant of",
    "P710": "participant",
    "P241": "military branch",
    "P137": "operator",
    "P449": "original network",
    "P136": "genre",
    "P921": "main subject",
    "P155": "follows",
    "P156": "followed by",
    "P287": "designed by",
    "P271": "colleague",
    "P119": "meeting place",
    "P803": "prize",
    "P87": "librettist",
    "P123": "publisher",
    "P195": "collection",
    "P800": "notable work",
    "P178": "developer",
    "P277": "programming language",
    "P1072": "record held",
    "P241": "military branch",
    "P1253": "convicted of",
    "P1399": "convicted of",
    "P157": "killed by",
    "P357": "named after",
    "P1477": "formal name",
    "P1709": "equivalent",
    "P461": "opposite of",
    "P2094": "crosses",
    "P206": "located in or next to body of water",
    "P413": "position",
    "P512": "academic degree",
    "P533": "correct equation",
    "P723": "digitised by",
    "P673": "electronic identity document",
    "P1048": "catalogue",
    "P972": "catalog",
}


@dataclass
class RelStats:
    claims_processed: int = 0
    relationships_inserted: int = 0
    entities_linked: int = 0
    errors: int = 0
    property_counts: Counter = None

    def __post_init__(self):
        self.property_counts = Counter()


def connect_wikidata() -> psycopg.Connection:
    return psycopg.connect(WIKIDATA_DSN, row_factory=dict_row, autocommit=True)


def connect_xyzo() -> psycopg.Connection:
    return psycopg.connect(XYZO_DSN, row_factory=dict_row, autocommit=True)


def create_xyzo_entity_relationships_table(xyzo_conn: psycopg.Connection) -> None:
    """Create xyzo_entity_relationships table."""
    with xyzo_conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS xyzo_entity_relationships (
                id              BIGSERIAL PRIMARY KEY,
                subject_qid     TEXT NOT NULL,
                predicate       TEXT NOT NULL,
                object_qid      TEXT,
                object_text     TEXT,
                qualifiers      JSONB,
                rank            TEXT DEFAULT 'normal',

                -- Pre-computed usefulness
                usefulness      DOUBLE PRECISION DEFAULT 0,

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
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_xyzo_rel_lookup
            ON xyzo_entity_relationships(subject_qid, predicate)
        """)
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_xyzo_rel_usefulness
            ON xyzo_entity_relationships(usefulness DESC)
        """)

    xyzo_conn.commit()
    log.info("xyzo_entity_relationships table created/verified")


def sample_claims(
    wikidata_conn: psycopg.Connection,
    properties: list[str] | None = None,
    sample_pct: float = 0.0,
    limit: int = 0
) -> Iterator[dict]:
    """
    Sample claims from wd_claims_flat.

    Args:
        properties: List of property IDs to filter (e.g., ['P31', 'P17'])
        sample_pct: TABLESAMPLE percentage (0.0 = no sampling, use all)
        limit: Maximum claims to return
    """
    if properties:
        prop_list = ",".join(["%s"] * len(properties))
        where_clause = f"WHERE property IN ({prop_list})"
        params = properties
    else:
        where_clause = ""
        params = []

    sample_clause = f"TABLESAMPLE SYSTEM ({sample_pct})" if sample_pct > 0 else ""

    sql = f"""
        SELECT
            id,
            entity_id,
            property,
            value_entity,
            value_text
        FROM wd_claims_flat
        {sample_clause}
        {where_clause}
    """

    if limit > 0:
        sql += f" LIMIT {limit}"

    with wikidata_conn.cursor() as cur:
        cur.execute(sql, params)
        while True:
            rows = cur.fetchmany(1000)
            if not rows:
                break
            for row in rows:
                yield row


def compute_usefulness(predicate: str, has_qualifiers: bool, has_references: bool) -> float:
    """
    Compute usefulness score for a relationship.
    Higher = more valuable for XYZO intelligence.
    """
    # Base score by property type
    PROPERTY_SCORES = {
        "P31": 10,       # instance of - fundamental classification
        "P17": 9,        # country - geographic context
        "P131": 9,       # located in - hierarchy
        "P276": 8,       # location - physical
        "P279": 7,       # subclass of - ontology
        "P159": 8,       # headquarters - org location
        "P150": 7,       # contains - containment
        "P361": 7,       # part of - composition
        "P106": 6,       # occupation - person role
        "P463": 6,       # member of - networks
        "P527": 5,       # has part - composition
        "P625": 10,      # coordinates - spatial
        "P36": 8,        # capital - important geo
        "P37": 5,        # language
        "P38": 4,        # currency
        "P35": 7,        # head of state
        "P6": 6,         # head of government
        "P30": 7,        # continent
        "P571": 4,       # inception - temporal
        "P569": 5,       # date of birth
        "P570": 5,       # date of death
        "P1082": 8,      # population - demographics
        "P19": 4,        # place of birth
        "P20": 4,        # place of death
        "P27": 5,        # citizenship
        "P69": 4,        # educated at
        "P108": 5,       # employer
        "P175": 4,       # performer
        "P57": 4,        # director
        "P161": 4,       # cast
        "P86": 4,        # composer
        "P162": 4,       # producer
        "P264": 3,       # record label
        "P136": 4,       # genre
        "P921": 8,       # main subject
        "P155": 3,       # follows
        "P156": 3,       # followed by
        "P102": 5,       # political party
        "P1412": 4,      # languages
        "P166": 4,       # awards
    }

    score = PROPERTY_SCORES.get(predicate, 1.0)

    # Bonus for qualifiers (temporal/contextual info)
    if has_qualifiers:
        score *= 1.2

    return score


def insert_relationships(
    xyzo_conn: psycopg.Connection,
    relationships: list[dict],
    batch_size: int = 1000
) -> int:
    """Insert relationships into xyzo_entity_relationships."""
    if not relationships:
        return 0

    inserted = 0

    for i in range(0, len(relationships), batch_size):
        batch = relationships[i:i + batch_size]

        values = []
        for rel in batch:
            usefulness = compute_usefulness(
                rel["property"],
                has_qualifiers=bool(rel.get("qualifiers")),
                has_references=False
            )

            values.append((
                rel["entity_id"],
                rel["property"],
                rel.get("value_entity"),
                rel.get("value_text"),
                json.dumps(rel.get("qualifiers")) if rel.get("qualifiers") else None,
                rel.get("rank", "normal"),
                usefulness,
            ))

        with xyzo_conn.cursor() as cur:
            cur.executemany("""
                INSERT INTO xyzo_entity_relationships (
                    subject_qid, predicate, object_qid, object_text,
                    qualifiers, rank, usefulness
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT DO NOTHING
            """, values)

        inserted += len(values)

    xyzo_conn.commit()
    return inserted


def get_property_counts(wikidata_conn: psycopg.Connection, sample_pct: float = 0.1) -> Counter:
    """Get property distribution from a sample."""
    counts = Counter()

    try:
        with wikidata_conn.cursor() as cur:
            cur.execute(f"""
                SELECT property, COUNT(*) as cnt
                FROM wd_claims_flat TABLESAMPLE SYSTEM (%s)
                GROUP BY property
                ORDER BY cnt DESC
                LIMIT 100
            """, (sample_pct,))
            for row in cur.fetchall():
                counts[row["property"]] = row["cnt"]
    except Exception as e:
        log.warning(f"Could not get property counts: {e}")

    return counts


def get_xyzo_rel_stats(xyzo_conn: psycopg.Connection) -> dict:
    """Get xyzo_entity_relationships statistics."""
    with xyzo_conn.cursor() as cur:
        # Check if table exists
        cur.execute("""
            SELECT table_name
            FROM information_schema.tables
            WHERE table_name = 'xyzo_entity_relationships'
        """)
        if not cur.fetchone():
            return {"exists": False, "total": 0, "distinct_subjects": 0,
                    "distinct_predicates": 0, "top_predicates": []}

        stats = {"exists": True}

        cur.execute("SELECT COUNT(*) as total FROM xyzo_entity_relationships")
        stats["total"] = cur.fetchone()["total"]

        cur.execute("SELECT COUNT(DISTINCT subject_qid) as subjects FROM xyzo_entity_relationships")
        stats["distinct_subjects"] = cur.fetchone()["subjects"]

        cur.execute("SELECT COUNT(DISTINCT predicate) as predicates FROM xyzo_entity_relationships")
        stats["distinct_predicates"] = cur.fetchone()["predicates"]

        cur.execute("SELECT predicate, COUNT(*) as cnt FROM xyzo_entity_relationships GROUP BY predicate ORDER BY cnt DESC LIMIT 20")
        stats["top_predicates"] = [(row["predicate"], row["cnt"]) for row in cur.fetchall()]

        return stats


def main():
    parser = argparse.ArgumentParser(description="Populate xyzo_entity_relationships from wd_claims_flat")
    parser.add_argument("--properties", type=str,
                        help="Comma-separated list of property IDs (e.g., P31,P17,P131)")
    parser.add_argument("--sample", type=float, metavar="PCT",
                        help="Sample percentage (0.1 = 0.1%%)")
    parser.add_argument("--limit", type=int, default=0,
                        help="Limit number of claims to process")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be done without inserting")
    parser.add_argument("--status", action="store_true",
                        help="Show current relationship stats")
    args = parser.parse_args()

    xyzo_conn = connect_xyzo()

    try:
        if args.status:
            stats = get_xyzo_rel_stats(xyzo_conn)
            if not stats.get("exists", False):
                print(f"\n=== xyzo_entity_relationships Status ===")
                print(f"Table:               NOT YET CREATED")
                print(f"Run without --status to create and populate")
                return 0
            print(f"\n=== xyzo_entity_relationships Status ===")
            print(f"Total relationships:    {stats['total']:,}")
            print(f"Distinct subjects:      {stats['distinct_subjects']:,}")
            print(f"Distinct predicates:     {stats['distinct_predicates']}")
            print(f"\nTop predicates:")
            for prop, cnt in stats.get("top_predicates", [])[:15]:
                name = PROPERTY_NAMES.get(prop, "???")
                print(f"  {prop:<8} {cnt:>12,}  {name}")
            return 0

        create_xyzo_entity_relationships_table(xyzo_conn)

        wikidata_conn = connect_wikidata()

        try:
            properties = args.properties.split(",") if args.properties else None

            if properties:
                log.info(f"Processing properties: {properties}")
            elif args.sample:
                log.info(f"Sampling {args.sample}% of all claims...")
            else:
                log.info("Processing key properties: P31, P17, P131, P276, P279, P159, P150, P361, P106, P463")
                properties = ["P31", "P17", "P131", "P276", "P279", "P159", "P150", "P361", "P106", "P463"]

            claims = sample_claims(
                wikidata_conn,
                properties=properties,
                sample_pct=args.sample or 0,
                limit=args.limit
            )

            if args.dry_run:
                count = 0
                for _ in claims:
                    count += 1
                    if count >= 100:
                        break
                log.info(f"[dry-run] Would process ~{count} claims")
                return 0

            # Process in batches
            batch = []
            stats = RelStats()
            total_inserted = 0

            for claim in claims:
                stats.claims_processed += 1
                stats.property_counts[claim["property"]] += 1

                batch.append({
                    "entity_id": claim["entity_id"],
                    "property": claim["property"],
                    "value_entity": claim.get("value_entity"),
                    "value_text": claim.get("value_text"),
                    "qualifiers": None,
                    "rank": "normal",
                })

                if len(batch) >= 5000:
                    inserted = insert_relationships(xyzo_conn, batch)
                    total_inserted += inserted
                    stats.relationships_inserted += inserted

                    log.info(f"  Processed {stats.claims_processed:,} claims, "
                             f"inserted {total_inserted:,} relationships "
                             f"(errors={stats.errors})")
                    batch = []

                if args.limit and stats.claims_processed >= args.limit:
                    break

            # Final batch
            if batch:
                inserted = insert_relationships(xyzo_conn, batch)
                total_inserted += inserted
                stats.relationships_inserted += inserted

            log.info(f"\n=== Population Complete ===")
            log.info(f"Claims processed:       {stats.claims_processed:,}")
            log.info(f"Relationships inserted: {stats.relationships_inserted:,}")
            log.info(f"Errors:                 {stats.errors}")

            if stats.property_counts:
                log.info(f"\nProperty distribution:")
                for prop, cnt in stats.property_counts.most_common(20):
                    name = PROPERTY_NAMES.get(prop, "???")
                    log.info(f"  {prop:<8} {cnt:>12,}  {name}")

        finally:
            wikidata_conn.close()

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
