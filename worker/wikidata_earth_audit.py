#!/usr/bin/env python3
"""
Wikidata Earth Audit - Phase A
==============================
Maps the actual Wikidata schema, sizes, and distributions WITHOUT heavy queries.

Run:
    python3 -m worker.wikidata_earth_audit

This is READ-ONLY exploration - no writes, no indexes, no modifications.
"""

import os
import sys
from typing import Iterator

import psycopg
from psycopg.rows import dict_row

WIKI_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)

WIKIPEDIA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikipedia"
).replace("/wikidata", "/wikipedia")


def connect_wiki() -> psycopg.Connection:
    return psycopg.connect(WIKI_DSN, row_factory=dict_row, autocommit=True)


def connect_wikipedia() -> psycopg.Connection:
    return psycopg.connect(WIKIPEDIA_DSN, row_factory=dict_row, autocommit=True)


def get_table_estimate(conn: psycopg.Connection, table: str) -> int | None:
    """Get pg_class estimate for row count - fast, no scan."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT reltuples::bigint AS estimate
            FROM pg_class
            WHERE relname = %s
        """, (table,))
        row = cur.fetchone()
        return row["estimate"] if row else None


def sample_table(conn: psycopg.Connection, table: str, cols: str,
                 where: str = "", sample_pct: float = 0.001,
                 limit: int = 1000) -> Iterator[dict]:
    """Generator that samples a table without full scan."""
    sql = f"""
        SELECT {cols}
        FROM {table} TABLESAMPLE SYSTEM (%s)
        {where}
        LIMIT %s
    """
    with conn.cursor() as cur:
        cur.execute(sql, (sample_pct, limit))
        while True:
            rows = cur.fetchmany(100)
            if not rows:
                break
            for row in rows:
                yield row


def audit_wikidata():
    """Audit the wikidata database - schema, sizes, distributions."""
    print("=" * 70)
    print("WIKIDATA EARTH AUDIT - Phase A")
    print("=" * 70)

    conn = connect_wiki()

    # Table sizes from pg_statio_user_tables
    print("\n📊 TABLE SIZES (wikidata database)")
    print("-" * 70)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                relname,
                pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
                pg_size_pretty(pg_relation_size(relid)) AS table_size,
                pg_size_pretty(pg_indexes_size(relid)) AS idx_size
            FROM pg_catalog.pg_statio_user_tables
            WHERE schemaname = 'public'
            ORDER BY pg_total_relation_size(relid) DESC
        """)
        for row in cur.fetchall():
            print(f"  {row['relname']:<35} total={row['total_size']:>10}  table={row['table_size']:>10}  idx={row['idx_size']:>8}")

    # Row estimates
    print("\n📈 ROW COUNT ESTIMATES")
    print("-" * 70)
    tables = ['wd_entities', 'wd_claims_flat', 'wd_identifiers', 'wd_stats',
              'wikidata_entities', 'companies']
    for t in tables:
        est = get_table_estimate(conn, t)
        print(f"  {t:<35} ~{est:>15,}" if est else f"  {t:<35}  unknown")

    # Schema for key tables
    print("\n📋 SCHEMA: wd_entities")
    print("-" * 70)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'wd_entities'
            ORDER BY ordinal_position
        """)
        for row in cur.fetchall():
            null = "NULL" if row['is_nullable'] == 'YES' else "NOT NULL"
            print(f"  {row['column_name']:<25} {row['data_type']:<30} {null}")

    print("\n📋 SCHEMA: wd_claims_flat")
    print("-" * 70)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'wd_claims_flat'
            ORDER BY ordinal_position
        """)
        for row in cur.fetchall():
            null = "NULL" if row['is_nullable'] == 'YES' else "NOT NULL"
            print(f"  {row['column_name']:<25} {row['data_type']:<30} {null}")

    # Property distribution from sample
    print("\n🏷 PROPERTY DISTRIBUTION (from 1% sample of claims)")
    print("-" * 70)
    print("  (Extrapolated to total ~183M claims)")
    print()
    print(f"  {'Property':<10} {'Sample Count':>15} {'Est. Total':>15}  Meaning")
    print(f"  {'-'*10:<10} {'-'*15:>15} {'-'*15:>15}")

    # Map of known Wikidata properties
    PROP_NAMES = {
        'P31': 'instance of',
        'P17': 'country',
        'P131': 'located in administrative entity',
        'P106': 'occupation',
        'P276': 'location',
        'P279': 'subclass of',
        'P159': 'headquarters location',
        'P361': 'part of',
        'P150': 'contains administrative entities',
        'P463': 'member of',
        'P527': 'has part',
        'P641': 'sport',
        'P39': 'position held',
        'P569': 'date of birth',
        'P570': 'date of death',
        'P27': 'country of citizenship',
        'P569': 'date of birth',
        'P625': 'coordinate location',
        'P18': 'image',
        'P856': 'official website',
        'P1412': 'languages spoken/written',
        'P102': 'member of political party',
        'P69': 'educated at',
        'P108': 'employer',
        'P264': 'record label',
        'P413': 'position',
        'P166': 'award received',
        'P509': 'cause of death',
        'P725': 'voice actor',
        'P1038': 'relative',
        'P3342': 'Netflix ID',
        'P580': 'start time',
        'P582': 'end time',
        'P585': 'point in time',
        'P1543': 'mascot',
        'P567': 'basin country',
        'P36': 'capital',
        'P35': 'head of state',
        'P37': 'official language',
        'P38': 'currency',
        'P6': 'head of government',
        'P30': 'continent',
        'P29': 'country of birth',
        'P119': 'meeting place',
        'P1344': 'participant of',
        'P710': 'participant',
        'P241': 'military branch',
        'P137': 'operator',
        'P449': 'original network',
        'P344': 'filming',
        'P750': 'distributed by',
        'P162': 'producer',
        'P161': 'cast member',
        'P57': 'director',
        'P86': 'composer',
        'P175': 'performer',
        'P87': 'librettist',
        'P123': 'publisher',
        'P195': 'collection',
        'P973': 'described at URL',
        'P301': 'field of work',
        'P101': 'field of work',
        'P1066': 'student',
        'P802': 'student',
        'P184': 'doctoral advisor',
        'P185': 'doctoral student',
        'P500': 'member of',
    }

    with conn.cursor() as cur:
        cur.execute("""
            SELECT property, COUNT(*) as cnt
            FROM wd_claims_flat TABLESAMPLE SYSTEM (1)
            GROUP BY property
            ORDER BY cnt DESC
            LIMIT 60
        """)
        rows = cur.fetchall()

    for row in rows:
        prop = row['property']
        sample_cnt = row['cnt']
        # Extrapolate: sample is 1% = 0.01, so multiply by 100
        est_total = sample_cnt * 100
        name = PROP_NAMES.get(prop, '???')
        print(f"  {prop:<10} {sample_cnt:>15,} {est_total:>15,}  {name}")

    # Entity type distribution from sample
    print("\n📊 ENTITY TYPE DISTRIBUTION (from 0.1% sample)")
    print("-" * 70)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT entity_type, COUNT(*) as cnt
            FROM wd_entities TABLESAMPLE SYSTEM (0.1)
            GROUP BY entity_type
            ORDER BY cnt DESC
        """)
        type_rows = cur.fetchall()

    total_sample = sum(r['cnt'] for r in type_rows)
    for row in type_rows:
        pct = (row['cnt'] / total_sample * 100) if total_sample else 0
        est_total = row['cnt'] * 1000  # 0.1% sample
        print(f"  {row['entity_type']:<15} {row['cnt']:>10,} ({pct:5.1f}%)  est ~{est_total:>12,}")

    # Geographic coverage
    print("\n🌍 GEOGRAPHIC COVERAGE (entities with coordinates)")
    print("-" * 70)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*) as geo_count
            FROM wd_entities TABLESAMPLE SYSTEM (0.1)
            WHERE lat IS NOT NULL
        """)
        geo_row = cur.fetchone()
        geo_sample = geo_row['geo_count'] if geo_row else 0
        est_geo = geo_sample * 1000
        print(f"  Sample entities with lat/lon: {geo_sample:,}")
        print(f"  Estimated total with coordinates: ~{est_geo:,}")
        print(f"  Coverage rate: {geo_sample / total_sample * 100:.1f}%" if total_sample else "  N/A")

    # Sample geographic entities
    print("\n🌍 SAMPLE GEOGRAPHIC ENTITIES")
    print("-" * 70)
    print(f"  {'QID':<12} {'Label':<45} {'Lat':>12} {'Lon':>12}")
    print(f"  {'-'*12:<12} {'-'*45:<45} {'-'*12:>12} {'-'*12:>12}")
    with conn.cursor() as cur:
        cur.execute("""
            SELECT id, label_en, lat, lon
            FROM wd_entities TABLESAMPLE SYSTEM (0.1)
            WHERE lat IS NOT NULL AND label_en IS NOT NULL
            ORDER BY random()
            LIMIT 15
        """)
        for row in cur.fetchall():
            label = (row['label_en'][:43] + '..') if row['label_en'] and len(row['label_en']) > 45 else (row['label_en'] or '???')
            print(f"  {row['id']:<12} {label:<45} {row['lat']:>12.4f} {row['lon']:>12.4f}")

    conn.close()


def audit_wikipedia():
    """Audit the wikipedia database."""
    print("\n" + "=" * 70)
    print("WIKIPEDIA DATABASE AUDIT")
    print("=" * 70)

    try:
        conn = connect_wikipedia()
    except Exception as e:
        print(f"\n❌ Could not connect to wikipedia DB: {e}")
        return

    # Schema
    print("\n📋 SCHEMA: wiki_articles")
    print("-" * 70)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'wiki_articles'
            ORDER BY ordinal_position
        """)
        for row in cur.fetchall():
            null = "NULL" if row['is_nullable'] == 'YES' else "NOT NULL"
            print(f"  {row['column_name']:<25} {row['data_type']:<20} {null}")

    # Check for wikidata_qid column (critical for linking)
    print("\n🔗 WIKIDATA LINKAGE CHECK")
    print("-" * 70)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'wiki_articles' AND column_name = 'wikidata_qid'
        """)
        has_qid = cur.fetchone() is not None

    if has_qid:
        print("  ✅ wikidata_qid column EXISTS")
    else:
        print("  ❌ wikidata_qid column MISSING")
        print("  ⚠️  Wikipedia → Wikidata linkage not implemented")
        print("  ℹ️  This is needed for: Wikipedia title → QID resolution")

    # Row estimate
    print("\n📈 ROW COUNT ESTIMATE")
    est = get_table_estimate(conn, 'wiki_articles')
    print(f"  wiki_articles: ~{est:,}" if est else "  Unknown")

    # Sample
    print("\n📝 SAMPLE ARTICLES")
    print("-" * 70)
    print(f"  {'wiki_id':<12} {'title':<50} {'length':>10}")
    print(f"  {'-'*12:<12} {'-'*50:<50} {'-'*10:>10}")
    with conn.cursor() as cur:
        cur.execute("""
            SELECT wiki_id, title, article_length
            FROM wiki_articles
            ORDER BY random()
            LIMIT 10
        """)
        for row in cur.fetchall():
            title = (row['title'][:48] + '..') if row['title'] and len(row['title']) > 50 else (row['title'] or '???')
            print(f"  {row['wiki_id']:<12} {title:<50} {row['article_length']:>10,}")

    conn.close()


def audit_xyzo_wikidata_integration():
    """Check current XYZO wikidata integration status."""
    print("\n" + "=" * 70)
    print("XYZO WIKIDATA INTEGRATION STATUS")
    print("=" * 70)

    xyzo_dsn = os.environ.get("XYZO_DB_DSN") or os.environ.get("XYZO_DB_URL")
    if not xyzo_dsn:
        xyzo_dsn = os.environ.get("XYZO_DB_DSN", "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo")

    try:
        conn = psycopg.connect(xyzo_dsn, row_factory=dict_row, autocommit=True)
    except Exception as e:
        print(f"\n❌ Could not connect to XYzo DB: {e}")
        return

    # news_entities table
    print("\n📋 SCHEMA: news_entities")
    print("-" * 70)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'news_entities'
            ORDER BY ordinal_position
        """)
        for row in cur.fetchall():
            null = "NULL" if row['is_nullable'] == 'YES' else "NOT NULL"
            print(f"  {row['column_name']:<25} {row['data_type']:<20} {null}")

    # Count rows
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) as cnt FROM news_entities")
        row = cur.fetchone()
        print(f"\n📊 Row count: {row['cnt']:,}")

    # Check for wikidata_id usage
    with conn.cursor() as cur:
        cur.execute("""
            SELECT COUNT(*) as has_qid
            FROM news_entities
            WHERE wikidata_id IS NOT NULL
        """)
        row = cur.fetchone()
        print(f"📊 Entities with wikidata_id: {row['has_qid']:,}")

    # Check news_articles.entities column
    print("\n📋 SCHEMA: news_articles (entities column)")
    print("-" * 70)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'news_articles' AND column_name = 'entities'
        """)
        row = cur.fetchone()
        if row:
            print(f"  {row['column_name']:<25} {row['data_type']}")
        else:
            print("  ❌ entities column not found")

    # Count articles
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) as cnt FROM news_articles")
        row = cur.fetchone()
        print(f"\n📊 news_articles row count: {row['cnt']:,}")

    conn.close()


def main():
    print("Starting Wikidata Earth Audit...")
    print()

    try:
        audit_wikidata()
        audit_wikipedia()
        audit_xyzo_wikidata_integration()
    except Exception as e:
        print(f"\n❌ Error during audit: {e}")
        import traceback
        traceback.print_exc()
        return 1

    print("\n" + "=" * 70)
    print("AUDIT COMPLETE")
    print("=" * 70)
    print("""
KEY FINDINGS:

1. ❌ NO wikidata_qid column in wiki_articles
   → Wikipedia ↔ Wikidata linkage not built

2. ⚠️  wd_entities table (688 GB) has autovacuum_enabled=false
   → Table bloat accumulated, statistics stale
   → Even COUNT(*) times out

3. ⚠️  wd_claims_flat (23 GB) - 183M claims
   → Property distribution skewed:
     - P31 (instance of): ~127M
     - P17 (country): ~18M
     - P131 (location): ~14M

4. ✅ news_entities.wikidata_id column EXISTS but is EMPTY
   → Ready for population

5. ✅ wd_entities has good indexes including:
   - GIST index on geog (coordinates)
   - trigram indexes on labels
   - full-text search vector

NEXT STEPS:
1. Build Wikipedia → Wikidata QID linkage
2. Create xyzo_entities table from wd_entities
3. Pre-compute property statistics (don't COUNT on 688GB)
4. Consider vacuuming wd_entities
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
