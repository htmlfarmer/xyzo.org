#!/usr/bin/env python3
"""
Wikidata Value Validation Test
==============================
This tests whether Wikidata is actually useful for XYZO BEFORE we commit to populating tables.

Tests:
1. Can we resolve known organizations to QIDs?
2. Does the QID give us useful context?
3. Can we find related entities?

Run:
    python3 -m worker.wikidata.validate_value
"""

import json
import logging
import os
import sys

import psycopg
from psycopg.rows import dict_row

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("xyzo.validate_wikidata")

WIKIDATA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)


def connect_wikidata():
    return psycopg.connect(WIKIDATA_DSN, row_factory=dict_row, autocommit=True)


# Sample organizations from seed_org_anchors.py - these are real entities XYZO should know
SAMPLE_ORGS = [
    "NASA",
    "ESA",
    "CERN",
    "SpaceX",
    "OpenAI",
    "Google DeepMind",
    "MIT",
    "Stanford",
    "Reuters",
    "BBC",
    "Nature",
    "NIH",
    "WHO",
    "United Nations",
    "European Union",
    "Apple",
    "Microsoft",
    "NVIDIA",
    "Tesla",
    "Amazon",
]


def test_exact_label_resolution(conn):
    """
    Test 1: Can we resolve known organizations by exact label match?
    This simulates what resolve_wikidata_entities.py will do.
    """
    log.info("\n" + "=" * 60)
    log.info("TEST 1: Exact Label Resolution")
    log.info("=" * 60)

    placeholders = ",".join(["%s"] * len(SAMPLE_ORGS))
    sql = f"""
        SELECT id, label_en, description_en, lat, lon
        FROM wd_entities
        WHERE label_en IN ({placeholders})
          AND entity_type = 'item'
    """

    with conn.cursor() as cur:
        cur.execute(sql, SAMPLE_ORGS)
        results = {row["label_en"]: row for row in cur.fetchall()}

    resolved = 0
    for org in SAMPLE_ORGS:
        if org in results:
            r = results[org]
            log.info(f"  ✅ {org:<25} → {r['id']} | {r['description_en'][:50] if r['description_en'] else 'no desc'}...")
            resolved += 1
        else:
            log.info(f"  ❌ {org:<25} → NOT FOUND")

    log.info(f"\nResolution rate: {resolved}/{len(SAMPLE_ORGS)} = {resolved/len(SAMPLE_ORGS)*100:.1f}%")
    return resolved, results


def test_qid_context(conn, resolved_entities: dict):
    """
    Test 2: Given a QID, what else can we learn?
    This shows the VALUE of having the QID.
    """
    log.info("\n" + "=" * 60)
    log.info("TEST 2: QID Context Value (What do we get with the QID?)")
    log.info("=" * 60)

    # Test a few key entities
    test_entities = ["NASA", "CERN", "OpenAI", "Reuters", "WHO"]

    for org_name in test_entities:
        if org_name not in resolved_entities:
            continue

        qid = resolved_entities[org_name]["id"]

        log.info(f"\n  🔍 {org_name} ({qid})")

        # Get claims for this entity
        with conn.cursor() as cur:
            # P31 = instance of, P17 = country, P159 = headquarters, P276 = location
            cur.execute("""
                SELECT property, value_entity, value_text
                FROM wd_claims_flat
                WHERE entity_id = %s
                  AND property IN ('P31', 'P17', 'P159', 'P276', 'P150', 'P361', 'P625', 'P1082')
                LIMIT 20
            """, (qid,))
            claims = list(cur.fetchall())

        if not claims:
            log.info(f"     No claims found")
            continue

        # Get property labels
        property_names = {
            "P31": "instance of",
            "P17": "country",
            "P159": "headquarters",
            "P276": "location",
            "P150": "contains",
            "P361": "part of",
            "P625": "coordinates",
            "P1082": "population",
        }

        # Resolve value_entity IDs to labels (simplified - just show the QIDs)
        for claim in claims[:10]:
            prop_name = property_names.get(claim["property"], claim["property"])
            value = claim["value_entity"] or claim["value_text"] or "???"
            log.info(f"     {prop_name:<20} = {value}")


def test_geographic_context(conn):
    """
    Test 3: Geographic coverage - how many entities have coordinates?
    """
    log.info("\n" + "=" * 60)
    log.info("TEST 3: Geographic Coverage")
    log.info("=" * 60)

    with conn.cursor() as cur:
        # Sample to check geographic coverage
        cur.execute("""
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) as with_coords
            FROM wd_entities TABLESAMPLE SYSTEM (0.1)
            WHERE entity_type = 'item'
        """)
        row = cur.fetchone()

        total = row["total"] or 0
        with_coords = row["with_coords"] or 0

        if total > 0:
            rate = with_coords / total * 100
            log.info(f"  Sample: {total} entities, {with_coords} with coordinates")
            log.info(f"  Estimated coverage: {rate:.1f}%")
            log.info(f"  Projected for 119M entities: ~{int(119_000_000 * rate / 100):,} entities with coordinates")


def test_relationship_graph(conn):
    """
    Test 4: Can we traverse the relationship graph?
    This shows the NETWORK effect - entities connected to other entities.
    """
    log.info("\n" + "=" * 60)
    log.info("TEST 4: Relationship Graph (Network Effect)")
    log.info("=" * 60)

    # Find NASA (Q23548) and see what it's connected to
    nasa_qid = "Q23548"

    with conn.cursor() as cur:
        # Get entities connected TO NASA
        cur.execute("""
            SELECT property, value_entity, COUNT(*) as cnt
            FROM wd_claims_flat
            WHERE value_entity = %s
              AND property IN ('P31', 'P17', 'P276', 'P361', 'P463', 'P159')
            GROUP BY property, value_entity
            ORDER BY cnt DESC
            LIMIT 15
        """, (nasa_qid,))
        inbound = list(cur.fetchall())

        # Get NASA's outgoing relationships
        cur.execute("""
            SELECT property, value_entity, COUNT(*) as cnt
            FROM wd_claims_flat
            WHERE entity_id = %s
              AND property IN ('P31', 'P17', 'P276', 'P361', 'P463', 'P159', 'P150')
            GROUP BY property, value_entity
            ORDER BY cnt DESC
            LIMIT 15
        """, (nasa_qid,))
        outbound = list(cur.fetchall())

    log.info(f"\n  🔗 NASA ({nasa_qid}) connections:")

    property_names = {
        "P31": "instance of",
        "P17": "country",
        "P159": "headquarters",
        "P276": "location",
        "P150": "contains",
        "P361": "part of",
        "P463": "member of",
    }

    if inbound:
        log.info(f"\n  Entities pointing TO NASA ({len(inbound)} types):")
        for row in inbound[:5]:
            name = property_names.get(row["property"], row["property"])
            log.info(f"     {name:<20} ← {row['cnt']} entities")

    if outbound:
        log.info(f"\n  NASA's outgoing relationships ({len(outbound)} types):")
        for row in outbound[:5]:
            name = property_names.get(row["property"], row["property"])
            value = row["value_entity"] or "???"
            log.info(f"     {name:<20} → {value}")


def test_world_cities_coverage(conn):
    """
    Test 5: World cities - how many does Wikidata have?
    """
    log.info("\n" + "=" * 60)
    log.info("TEST 5: World Cities Coverage")
    log.info("=" * 60)

    # Look for entities that are cities (P31 = Q515 city, Q486972 settlement)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(DISTINCT e.id) as city_count
            FROM wd_entities e
            JOIN wd_claims_flat c ON c.entity_id = e.id AND c.property = 'P31'
            WHERE c.value_entity IN ('Q515', 'Q486972', 'Q3957', 'Q532')
              AND e.lat IS NOT NULL
            LIMIT 1
        """)
        row = cur.fetchone()
        log.info(f"  Entities classified as cities with coordinates: {row['city_count']:,}")


def estimate_xyzo_benefit(resolved_count: int, total: int):
    """
    Estimate the benefit for XYZO based on resolution rate.
    """
    log.info("\n" + "=" * 60)
    log.info("ESTIMATED XYZO BENEFIT")
    log.info("=" * 60)

    resolution_rate = resolved_count / total if total > 0 else 0

    log.info(f"""
  If XYZO has ~10,000 unique entities in news_articles:
    Expected resolved: ~{int(10000 * resolution_rate):,}
    Expected unresolved: ~{int(10000 * (1 - resolution_rate)):,}

  For each RESOLVED entity, XYZO gains:
    ✅ Verified entity type (person/org/place/event)
    ✅ Geographic coordinates (if available)
    ✅ Wikipedia link
    ✅ Relationship graph (what it's connected to)
    ✅ Multilingual aliases
    ✅ Confidence score (usefulness)

  For UNRESOLVED entities:
    ❓ Unknown type (must guess)
    ❓ No geographic context
    ❓ No relationship network
    ❓ No Wikipedia link

  VALUE ASSESSMENT:
    If {resolved_count}/{total} ({resolution_rate*100:.0f}%) of known orgs resolve,
    this is {'✅ WORTH DOING' if resolution_rate > 0.5 else '⚠️ NEED TO IMPROVE'} for organizations.
""")


def main():
    log.info("=" * 60)
    log.info("WIKIDATA VALUE VALIDATION TEST")
    log.info("Testing if Wikidata is actually useful for XYZO")
    log.info("=" * 60)

    conn = connect_wikidata()

    try:
        # Run validation tests
        resolved_count, resolved_entities = test_exact_label_resolution(conn)
        test_qid_context(conn, resolved_entities)
        test_geographic_context(conn)
        test_relationship_graph(conn)
        test_world_cities_coverage(conn)

        # Estimate benefit
        estimate_xyzo_benefit(resolved_count, len(SAMPLE_ORGS))

        log.info("\n" + "=" * 60)
        log.info("VALIDATION COMPLETE")
        log.info("=" * 60)
        log.info("""
  RECOMMENDATION:
    If resolution rate > 50%: PROCEED with population
    If resolution rate < 50%: Consider fuzzy matching or alias resolution first

  NEXT STEPS AFTER VALIDATION:
    1. python3 -m worker.wikidata.populate_xyzo_entities --priority --limit 100000
    2. python3 -m worker.wikidata.populate_xyzo_relationships --properties P31,P17,P131
    3. python3 -m worker.wikidata.resolve_wikidata_entities --batch 100
    4. Verify entity resolution in XYzo UI
""")

    finally:
        conn.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
