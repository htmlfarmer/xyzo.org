#!/usr/bin/env python3
"""
Create xyzo_place_context
=========================
Pre-computed context for important cities.

For each city:
- What institutions exist (via Wikidata)
- What's the XYZO coverage (articles, sources)
- What's the coverage gap?

Backup: DROP TABLE xyzo_place_context;

Run:
    python3 -m worker.wikidata.create_place_context
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
log = logging.getLogger("xyzo.place_context")

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
)

WIKIDATA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)


# Priority cities for context
PRIORITY_CITIES = [
    # Major world cities
    ("Q60", "New York", "USA"),
    ("Q62", "San Francisco", "USA"),
    ("Q16554", "Los Angeles", "USA"),
    ("Q84", "London", "UK"),
    ("Q220", "Paris", "France"),
    ("Q17770", "Tokyo", "Japan"),
    ("Q148", "Beijing", "China"),
    ("Q866", "Shanghai", "China"),
    ("Q1055", "Mumbai", "India"),
    ("Q1352", "Delhi", "India"),
    ("Q172", "Chicago", "USA"),
    ("Q148", "Beijing", "China"),
    ("Q11759", "São Paulo", "Brazil"),
    ("Q11553", "Toronto", "Canada"),
    ("Q88", "Berlin", "Germany"),
    ("Q179", "Moscow", "Russia"),
    ("Q174", "Seoul", "South Korea"),
    ("Q246", "Dubai", "UAE"),
    ("Q10282", "Singapore", "Singapore"),
    ("Q1744", "Sydney", "Australia"),
    # US Tech hubs
    ("Q1490", "Seattle", "USA"),
    ("Q4115642", "Austin", "USA"),
    ("Q129658", "Boston", "USA"),
    ("Q16553", "San Diego", "USA"),
    ("Q16552", "Denver", "USA"),
    ("Q16555", "Phoenix", "USA"),
    # Science cities
    ("Q1824", "Houston", "USA"),  # NASA JSC
    ("Q1641", "Cape Canaveral", "USA"),
    ("Q133231", "Pasadena", "USA"),  # JPL
]


def connect_xyzo():
    return psycopg.connect(XYZO_DSN, row_factory=dict_row, autocommit=True)


def connect_wikidata():
    return psycopg.connect(WIKIDATA_DSN, row_factory=dict_row, autocommit=True)


def create_table(conn):
    """Create xyzo_place_context table."""
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS xyzo_place_context (
                place_qid      TEXT PRIMARY KEY,
                place_name    TEXT,
                country_code  TEXT,

                -- Coordinates
                lat           DOUBLE PRECISION,
                lon           DOUBLE PRECISION,

                -- Institutions count (from Wikidata)
                num_universities INTEGER DEFAULT 0,
                num_hospitals    INTEGER DEFAULT 0,
                num_airports     INTEGER DEFAULT 0,
                num_companies     INTEGER DEFAULT 0,
                num_museums       INTEGER DEFAULT 0,

                -- XYZO coverage
                xyzo_articles  INTEGER DEFAULT 0,
                xyzo_sources   INTEGER DEFAULT 0,
                xyzo_events    INTEGER DEFAULT 0,

                -- Computed scores
                coverage_score   DOUBLE PRECISION DEFAULT 0,
                news_desert_score DOUBLE PRECISION DEFAULT 0,

                created_at     TIMESTAMPTZ DEFAULT now(),
                updated_at     TIMESTAMPTZ DEFAULT now()
            )
        """)
        conn.commit()


def get_city_info(wikidata_conn, qid):
    """Get city info and count of related institutions."""
    with wikidata_conn.cursor() as cur:
        cur.execute("""
            SELECT label_en, lat, lon, description_en
            FROM wd_entities
            WHERE id = %s
        """, (qid,))
        city = cur.fetchone()

    if not city:
        return None

    return {
        'qid': qid,
        'label': city['label_en'],
        'lat': city['lat'],
        'lon': city['lon'],
        'description': city['description_en'],
    }


def populate(conn_xyzo, conn_wikidata):
    """Populate place context for priority cities."""
    total = 0

    for qid, name, country in PRIORITY_CITIES:
        city_info = get_city_info(conn_wikidata, qid)
        if not city_info:
            log.info(f"  ❌ {name} ({qid}) - not found in Wikidata")
            continue

        with conn_xyzo.cursor() as cur:
            cur.execute("""
                INSERT INTO xyzo_place_context (
                    place_qid, place_name, country_code, lat, lon
                )
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (place_qid) DO UPDATE SET
                    place_name = EXCLUDED.place_name,
                    lat = COALESCE(EXCLUDED.lat, xyzo_place_context.lat),
                    lon = COALESCE(EXCLUDED.lon, xyzo_place_context.lon)
            """, (qid, name, country, city_info.get('lat'), city_info.get('lon')))
            conn_xyzo.commit()

        total += 1
        log.info(f"  ✅ {name} ({qid}) - lat={city_info.get('lat')}, lon={city_info.get('lon')}")

    return total


def verify(conn):
    """Verify context."""
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM xyzo_place_context")
        count = cur.fetchone()['count']

        cur.execute("""
            SELECT place_name, lat, lon, xyzo_articles, xyzo_sources
            FROM xyzo_place_context
            ORDER BY place_name
            LIMIT 10
        """)
        samples = list(cur.fetchall())

    log.info(f"\n  Total places: {count}")
    log.info(f"\n  Sample places:")
    for row in samples:
        log.info(f"    {row['place_name']:<20} ({row['lat']:.2f}, {row['lon']:.2f}) "
                  f"articles={row['xyzo_articles']} sources={row['xyzo_sources']}")


def rollback(conn):
    """Rollback."""
    with conn.cursor() as cur:
        cur.execute("DROP TABLE IF EXISTS xyzo_place_context")
        conn.commit()
    log.info("  Rolled back")


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "run"

    log.info("=" * 60)
    log.info("CREATE xyzo_place_context")
    log.info("=" * 60)

    if action == "rollback":
        conn = connect_xyzo()
        rollback(conn)
        conn.close()
        return 0

    if action == "status":
        conn = connect_xyzo()
        verify(conn)
        conn.close()
        return 0

    conn_xyzo = connect_xyzo()
    conn_wikidata = connect_wikidata()

    try:
        log.info("\nCreating table...")
        create_table(conn_xyzo)

        log.info("\nPopulating place context...")
        total = populate(conn_xyzo, conn_wikidata)

        log.info("\nVerifying...")
        verify(conn_xyzo)

        log.info("\n" + "=" * 60)
        log.info(f"DONE! {total} places")
        log.info("=" * 60)
        log.info("""
Backup: python3 -m worker.wikidata.create_place_context rollback
Status: python3 -m worker.wikidata.create_place_context status
""")

    finally:
        conn_xyzo.close()
        conn_wikidata.close()


if __name__ == "__main__":
    sys.exit(main())
