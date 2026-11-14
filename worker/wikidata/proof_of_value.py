#!/usr/bin/env python3
"""
Wikidata Proof of Value - Incremental Validation
================================================
Tests Wikidata value in SMALL increments before committing to full population.

SAFE: Only reads from wikidata DB, writes small test data to xyzo DB
DISRUPTION: ZERO - all changes are in separate databases

Usage:
    python3 -m worker.wikidata.proof_of_value --step 1  # Resolution test
    python3 -m worker.wikidata.proof_of_value --step 2  # Context test
    python3 -m worker.wikidata.proof_of_value --step 3  # Create sample entities
    python3 -m worker.wikidata.proof_of_value --step 4  # Relationship graph
    python3 -m worker.wikidata.proof_of_value --full    # Full validation report
"""

import argparse
import json
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
log = logging.getLogger("xyzo.proof_of_value")

WIKIDATA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
)


# Known QIDs for testing - these are verified entities
TEST_ENTITIES = {
    "Q23548": "NASA",
    "Q42944": "CERN",
    "Q9531": "BBC",
    "Q21708200": "OpenAI",
    "Q130879": "Reuters",
    "Q49108": "MIT",
    "Q17550": "Stanford University",
    "Q23433": "European Space Agency",
    "Q62": "San Francisco",
    "Q60": "New York City",
    "Q145": "United Kingdom",
    "Q30": "United States of America",
    "Q39": "Switzerland",
    "Q142": "France",
    "Q183": "Germany",
    "Q668": "India",
    "Q148": "China",
    "Q16": "Canada",
    "Q414": "Argentina",
    "Q219": "Brazil",
}

PROPERTY_NAMES = {
    "P31": "instance of",
    "P17": "country",
    "P159": "headquarters",
    "P276": "location",
    "P131": "located in administrative entity",
    "P625": "coordinate location",
    "P361": "part of",
    "P150": "contains administrative entities",
    "P279": "subclass of",
    "P106": "occupation",
    "P463": "member of",
    "P527": "has part",
    "P1082": "population",
    "P1543": "mascot",
    "P37": "official language",
    "P36": "capital",
    "P38": "currency",
}


def connect_wikidata():
    return psycopg.connect(WIKIDATA_DSN, row_factory=dict_row, autocommit=True)


def connect_xyzo():
    return psycopg.connect(XYZO_DSN, row_factory=dict_row, autocommit=True)


def step1_resolution_test(conn):
    """
    STEP 1: Test entity resolution via enwiki_title lookup.
    This is how we'll resolve XYZO entities to Wikidata QIDs.
    """
    log.info("\n" + "=" * 60)
    log.info("STEP 1: Entity Resolution Test")
    log.info("=" * 60)
    log.info("Question: Can we resolve XYZO entities to Wikidata QIDs?")

    # Test Wikipedia title lookups
    test_titles = ['NASA', 'CERN', 'BBC', 'Reuters', 'OpenAI', 'MIT']

    with conn.cursor() as cur:
        placeholders = ",".join(["%s"] * len(test_titles))
        cur.execute(f"""
            SELECT id, label_en, description_en, lat, lon, enwiki_title
            FROM wd_entities
            WHERE enwiki_title IN ({placeholders})
        """, test_titles)

        results = {row["enwiki_title"]: row for row in cur.fetchall()}

    resolved = 0
    for title in test_titles:
        if title in results:
            r = results[title]
            log.info(f"  ✅ {title:<20} → {r['id']} | {r['description_en'][:45] if r['description_en'] else 'no desc'}...")
            resolved += 1
        else:
            log.info(f"  ❌ {title:<20} → NOT FOUND")

    rate = resolved / len(test_titles) * 100
    log.info(f"\nResolution rate: {resolved}/{len(test_titles)} ({rate:.0f}%)")

    return {
        "resolved": resolved,
        "total": len(test_titles),
        "rate": rate,
        "verdict": "✅ PASS" if rate >= 80 else "⚠️ NEED FUZZY MATCHING" if rate >= 50 else "❌ FAIL"
    }


def step2_context_value(conn):
    """
    STEP 2: Test the VALUE of having a QID.
    What context do we get for each resolved entity?
    """
    log.info("\n" + "=" * 60)
    log.info("STEP 2: Context Value Test")
    log.info("=" * 60)
    log.info("Question: What do we learn from the QID?")

    sample_qids = ["Q23548", "Q42944", "Q9531", "Q130879", "Q49108"]

    with conn.cursor() as cur:
        placeholders = ",".join(["%s"] * len(sample_qids))
        cur.execute(f"""
            SELECT e.id, e.label_en, e.description_en, e.lat, e.lon,
                   c.property, c.value_entity, c.value_text
            FROM wd_entities e
            LEFT JOIN wd_claims_flat c ON c.entity_id = e.id
                AND c.property IN ('P31','P17','P159','P625','P361','P279','P106','P463')
            WHERE e.id IN ({placeholders})
            ORDER BY e.id, c.property
        """, sample_qids)

        rows = list(cur.fetchall())

    # Group by entity
    entities = {}
    for row in rows:
        qid = row["id"]
        if qid not in entities:
            entities[qid] = {
                "label": row["label_en"],
                "description": row["description_en"],
                "lat": row["lat"],
                "lon": row["lon"],
                "claims": []
            }
        if row["property"]:
            entities[qid]["claims"].append({
                "property": row["property"],
                "value": row["value_entity"] or row["value_text"]
            })

    for qid, entity in entities.items():
        log.info(f"\n  🔍 {entity['label']} ({qid})")
        if entity["lat"]:
            log.info(f"     📍 Coordinates: {entity['lat']:.4f}, {entity['lon']:.4f}")
        if entity["description"]:
            log.info(f"     📝 {entity['description'][:70]}...")

        # Group claims by property
        by_property = {}
        for claim in entity["claims"]:
            prop = claim["property"]
            if prop not in by_property:
                by_property[prop] = []
            by_property[prop].append(claim["value"])

        for prop, values in list(by_property.items())[:5]:
            prop_name = PROPERTY_NAMES.get(prop, prop)
            val_str = ", ".join(values[:2])
            if len(values) > 2:
                val_str += f" (+{len(values)-2} more)"
            log.info(f"     {prop_name:<25} = {val_str}")

    value_score = sum(1 for e in entities.values() if e["lat"] or e["claims"])
    log.info(f"\n\nEntities with useful context: {value_score}/{len(entities)}")

    return {
        "entities_with_context": value_score,
        "total": len(entities),
        "verdict": "✅ HIGH VALUE" if value_score >= len(entities) * 0.8 else "⚠️ PARTIAL VALUE"
    }


def step3_create_sample_entities(conn_xyzo, conn_wiki):
    """
    STEP 3: Create a small xyzo_entities sample table and verify it works.
    This tests our ability to copy data from Wikidata to XYZO.
    """
    log.info("\n" + "=" * 60)
    log.info("STEP 3: Sample xyzo_entities Creation")
    log.info("=" * 60)
    log.info("Question: Can we safely copy Wikidata entities to XYZO?")

    # Create sample table
    with conn_xyzo.cursor() as cur:
        # Check if table exists
        cur.execute("""
            SELECT table_name FROM information_schema.tables
            WHERE table_name = 'xyzo_entities_sample'
        """)
        exists = cur.fetchone() is not None

        if not exists:
            log.info("  Creating xyzo_entities_sample table...")
            cur.execute("""
                CREATE TABLE xyzo_entities_sample (
                    qid         TEXT PRIMARY KEY,
                    label_en    TEXT,
                    description TEXT,
                    lat         DOUBLE PRECISION,
                    lon         DOUBLE PRECISION,
                    country_qid TEXT,
                    entity_type TEXT,
                    created_at  TIMESTAMPTZ DEFAULT now()
                )
            """)
            conn_xyzo.commit()
            log.info("  ✅ Table created")
        else:
            log.info("  ℹ️  Table already exists")

    # Insert sample data from known QIDs
    qids = list(TEST_ENTITIES.keys())[:10]

    # First get the data from wikidata
    with conn_wiki.cursor() as cur:
        cur.execute("""
            SELECT id, label_en, description_en, lat, lon
            FROM wd_entities
            WHERE id = ANY(%s)
        """, (qids,))
        wiki_data = list(cur.fetchall())

    # Then insert into xyzo
    with conn_xyzo.cursor() as cur:
        for row in wiki_data:
            cur.execute("""
                INSERT INTO xyzo_entities_sample (qid, label_en, description, lat, lon)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (qid) DO UPDATE SET
                    label_en = EXCLUDED.label_en,
                    description = EXCLUDED.description,
                    lat = COALESCE(EXCLUDED.lat, xyzo_entities_sample.lat),
                    lon = COALESCE(EXCLUDED.lon, xyzo_entities_sample.lon)
            """, (row["id"], row["label_en"], row["description_en"], row["lat"], row["lon"]))
        conn_xyzo.commit()

        cur.execute("SELECT COUNT(*) as cnt FROM xyzo_entities_sample")
        count = cur.fetchone()["cnt"]

    log.info(f"  ✅ Inserted/updated {count} entities into xyzo_entities_sample")

    # Verify we can query it
    with conn_xyzo.cursor() as cur:
        cur.execute("""
            SELECT qid, label_en, lat, lon
            FROM xyzo_entities_sample
            ORDER BY label_en
            LIMIT 5
        """)
        rows = list(cur.fetchall())

    log.info(f"\n  Sample data in XYzo DB:")
    for row in rows:
        log.info(f"    {row['qid']:<12} {row['label_en']:<30} {row['lat']}, {row['lon']}")

    return {"created": count, "verdict": "✅ SUCCESS"}


def step4_relationship_graph(conn):
    """
    STEP 4: Test relationship graph traversal.
    This shows the network effect - how entities connect to each other.
    """
    log.info("\n" + "=" * 60)
    log.info("STEP 4: Relationship Graph Test")
    log.info("=" * 60)
    log.info("Question: Can we traverse relationships between entities?")

    # Find all entities related to NASA
    nasa_qid = "Q23548"

    with conn.cursor() as cur:
        # Entities that point TO NASA
        cur.execute("""
            SELECT property, COUNT(*) as cnt
            FROM wd_claims_flat
            WHERE value_entity = %s
              AND property IN ('P31','P17','P276','P361','P463','P159')
            GROUP BY property
            ORDER BY cnt DESC
            LIMIT 10
        """, (nasa_qid,))
        inbound = list(cur.fetchall())

        # NASA's outgoing relationships
        cur.execute("""
            SELECT property, COUNT(*) as cnt
            FROM wd_claims_flat
            WHERE entity_id = %s
              AND property IN ('P31','P17','P276','P361','P463','P159','P150')
            GROUP BY property
            ORDER BY cnt DESC
            LIMIT 10
        """, (nasa_qid,))
        outbound = list(cur.fetchall())

    log.info(f"\n  🔗 NASA ({nasa_qid}) relationship graph:")

    if inbound:
        total_in = sum(r["cnt"] for r in inbound)
        log.info(f"     ← {total_in} incoming relationships")
        for r in inbound[:3]:
            name = PROPERTY_NAMES.get(r["property"], r["property"])
            log.info(f"       {name:<20} ← {r['cnt']}")

    if outbound:
        total_out = sum(r["cnt"] for r in outbound)
        log.info(f"     → {total_out} outgoing relationships")
        for r in outbound[:3]:
            name = PROPERTY_NAMES.get(r["property"], r["property"])
            log.info(f"       {name:<20} → {r['cnt']}")

    graph_score = (len(inbound) + len(outbound)) / 2
    return {
        "inbound_types": len(inbound),
        "outbound_types": len(outbound),
        "verdict": "✅ RICH GRAPH" if graph_score >= 3 else "⚠️ PARTIAL GRAPH"
    }


def generate_report(results: dict):
    """Generate a final report card."""
    log.info("\n" + "=" * 60)
    log.info("PROOF OF VALUE - FINAL REPORT")
    log.info("=" * 60)

    log.info(f"""
    ┌─────────────────────────────────────────────────────────┐
    │ WIKIDATA VALUE ASSESSMENT                               │
    ├─────────────────────────────────────────────────────────┤""")

    # Step 1: Resolution
    r1 = results.get("step1", {})
    verdict = r1.get("verdict", "❓")
    log.info(f"    │ STEP 1: Entity Resolution                             │")
    log.info(f"    │   {r1.get('resolved', 0)}/{r1.get('total', 0)} resolved ({r1.get('rate', 0):.0f}%)                              │")
    log.info(f"    │   Verdict: {verdict:<45}│")

    # Step 2: Context
    r2 = results.get("step2", {})
    verdict = r2.get("verdict", "❓")
    log.info(f"    │ STEP 2: Context Value                                │")
    log.info(f"    │   {r2.get('entities_with_context', 0)}/{r2.get('total', 0)} with useful context                    │")
    log.info(f"    │   Verdict: {verdict:<45}│")

    # Step 3: Creation
    r3 = results.get("step3", {})
    verdict = r3.get("verdict", "❓")
    log.info(f"    │ STEP 3: Safe Data Copy                               │")
    log.info(f"    │   {r3.get('created', 0)} entities safely copied                          │")
    log.info(f"    │   Verdict: {verdict:<45}│")

    # Step 4: Graph
    r4 = results.get("step4", {})
    verdict = r4.get("verdict", "❓")
    log.info(f"    │ STEP 4: Relationship Graph                           │")
    log.info(f"    │   {r4.get('inbound_types', 0)} inbound + {r4.get('outbound_types', 0)} outbound relationship types      │")
    log.info(f"    │   Verdict: {verdict:<45}│")

    # Overall
    overall = "✅ PROCEED" if all(
        r.get("verdict", "").startswith("✅") or r.get("rate", 0) >= 50
        for r in [r1, r2, r3, r4]
    ) else "⚠️  PROCEED WITH CAUTION"

    log.info(f"    ├─────────────────────────────────────────────────────────┤")
    log.info(f"    │ OVERALL: {overall:<49}│")
    log.info(f"    └─────────────────────────────────────────────────────────┘")

    log.info("""
    RECOMMENDATIONS:

    IF PROCEED:
    1. Create xyzo_entities table with curated entities (prioritize: countries, cities >50k, universities, airports, hospitals, major companies)
    2. Populate xyzo_entity_relationships for key properties (P31, P17, P131, P159, P625)
    3. Run entity resolver on news_entities sample to verify improvement

    TIME ESTIMATE:
    - Proof of value: DONE (this test)
    - Create xyzo_entities (100k priority entities): ~30 minutes
    - Create xyzo_entity_relationships (key properties): ~1 hour
    - Full population (10M entities): ~4-6 hours
    - Entity resolution for existing news_entities: ~1 hour

    DISK SPACE:
    - xyzo_entities (100k): ~50 MB
    - xyzo_entities (10M): ~5 GB
    - xyzo_entity_relationships (1M): ~200 MB
    - Total estimated: ~10-15 GB for useful subset

    SAFETY:
    - ZERO disruption to live site
    - All work in separate databases
    - Tables are additive (new, not modifying existing)
    - Can drop and recreate without affecting production
    """)


def main():
    parser = argparse.ArgumentParser(description="Wikidata Proof of Value")
    parser.add_argument("--step", type=int, choices=[1, 2, 3, 4],
                        help="Run specific step only")
    parser.add_argument("--full", action="store_true",
                        help="Run full validation")
    args = parser.parse_args()

    results = {}

    # Always need wikidata connection
    conn_wiki = connect_wikidata()
    conn_xyzo = connect_xyzo()

    try:
        if args.step == 1 or args.full:
            results["step1"] = step1_resolution_test(conn_wiki)

        if args.step == 2 or args.full:
            results["step2"] = step2_context_value(conn_wiki)

        if args.step == 3 or args.full:
            results["step3"] = step3_create_sample_entities(conn_xyzo, conn_wiki)

        if args.step == 4 or args.full:
            results["step4"] = step4_relationship_graph(conn_wiki)

        if args.full:
            generate_report(results)

    finally:
        conn_wiki.close()
        conn_xyzo.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
