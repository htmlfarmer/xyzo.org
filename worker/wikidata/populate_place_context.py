#!/usr/bin/env python3
"""
Populate xyzo_place_context with CORRECT QIDs
=============================================
Uses enwiki_title lookup (fast, indexed) to get correct QIDs.

Run:
    python3 -m worker.wikidata.populate_place_context
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

WIKIDATA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)

XYZO_DSN = os.environ.get(
    "XYZO_DB_DSN",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
)

# Correct QIDs mapped by Wikipedia title
# (enwiki_title, place_name, country_code)
CORRECT_CITIES = [
    # Major world cities
    ("New York City", "New York", "US"),
    ("San Francisco", "San Francisco", "US"),
    ("Los Angeles", "Los Angeles", "US"),
    ("London", "London", "UK"),
    ("Paris", "Paris", "FR"),
    ("Tokyo", "Tokyo", "JP"),
    ("Beijing", "Beijing", "CN"),
    ("Shanghai", "Shanghai", "CN"),
    ("Mumbai", "Mumbai", "IN"),
    ("Delhi", "Delhi", "IN"),
    ("Chicago", "Chicago", "US"),
    ("Houston", "Houston", "US"),
    ("Seattle", "Seattle", "US"),
    ("Singapore", "Singapore", "SG"),
    ("Sydney", "Sydney", "AU"),
    ("Toronto", "Toronto", "CA"),
    ("Berlin", "Berlin", "DE"),
    ("Moscow", "Moscow", "RU"),
    ("Dubai", "Dubai", "AE"),
    ("Seoul", "Seoul", "KR"),
    ("Bangkok", "Bangkok", "TH"),
    ("Jakarta", "Jakarta", "ID"),
    ("Manila", "Manila", "PH"),
    ("Hong Kong", "Hong Kong", "HK"),
    ("São Paulo", "São Paulo", "BR"),
    ("Mexico City", "Mexico City", "MX"),
    ("Buenos Aires", "Buenos Aires", "AR"),
    ("Cairo", "Cairo", "EG"),
    ("Lagos", "Lagos", "NG"),
    ("Nairobi", "Nairobi", "KE"),
    ("Johannesburg", "Johannesburg", "ZA"),
    # US Tech/Science cities
    ("Austin, Texas", "Austin", "US"),
    ("Boston", "Boston", "US"),
    ("San Diego", "San Diego", "US"),
    ("Denver", "Denver", "US"),
    ("Phoenix, Arizona", "Phoenix", "US"),
    ("Atlanta", "Atlanta", "US"),
    ("Miami", "Miami", "US"),
    ("Dallas", "Dallas", "US"),
    ("Philadelphia", "Philadelphia", "US"),
    ("Washington, D.C.", "Washington DC", "US"),
    ("Baltimore", "Baltimore", "US"),
    ("San Jose, California", "San Jose", "US"),
    ("Pasadena, California", "Pasadena", "US"),  # JPL
    ("Cape Canaveral, Florida", "Cape Canaveral", "US"),  # Kennedy Space Center
    ("Huntsville, Alabama", "Huntsville", "US"),  # Marshall Space Flight Center
    ("Hampton, Virginia", "Hampton", "US"),  # NASA Langley
    ("Mountain View, California", "Mountain View", "US"),  # Google
    ("Menlo Park, California", "Menlo Park", "US"),  # Meta
    ("Redmond, Washington", "Redmond", "US"),  # Microsoft
    ("Santa Clara, California", "Santa Clara", "US"),  # NVIDIA, Intel
    ("Cambridge, Massachusetts", "Cambridge", "US"),  # MIT, Harvard
    ("Palo Alto", "Palo Alto", "US"),  # Stanford
    ("Berkeley, California", "Berkeley", "US"),  # UC Berkeley
    ("Ithaca, New York", "Ithaca", "US"),  # Cornell
    ("Princeton, New Jersey", "Princeton", "US"),  # Princeton
    # European cities
    ("Amsterdam", "Amsterdam", "NL"),
    ("Madrid", "Madrid", "ES"),
    ("Rome", "Rome", "IT"),
    ("Vienna", "Vienna", "AT"),
    ("Prague", "Prague", "CZ"),
    ("Stockholm", "Stockholm", "SE"),
    ("Warsaw", "Warsaw", "PL"),
    ("Budapest", "Budapest", "HU"),
    ("Dublin", "Dublin", "IE"),
    ("Lisbon", "Lisbon", "PT"),
    ("Copenhagen", "Copenhagen", "DK"),
    ("Oslo", "Oslo", "NO"),
    ("Helsinki", "Helsinki", "FI"),
    ("Brussels", "Brussels", "BE"),
    ("Zürich", "Zürich", "CH"),
    ("Geneva", "Geneva", "CH"),
    ("Milan", "Milan", "IT"),
    ("Barcelona", "Barcelona", "ES"),
    ("Munich", "Munich", "DE"),
    ("Frankfurt", "Frankfurt", "DE"),
    ("Hamburg", "Hamburg", "DE"),
    ("Leiden", "Leiden", "NL"),  # CERN nearby
    ("Geneva", "Geneva", "CH"),  # CERN
    ("CERN", "Geneva", "CH"),  # CERN
    # Asian cities
    ("Kuala Lumpur", "Kuala Lumpur", "MY"),
    ("Karachi", "Karachi", "PK"),
    ("Lahore", "Lahore", "PK"),
    ("Dhaka", "Dhaka", "BD"),
    ("Hanoi", "Hanoi", "VN"),
    ("Ho Chi Minh City", "Ho Chi Minh City", "VN"),
    ("Taipei", "Taipei", "TW"),
    ("Taipei", "Taipei", "TW"),
    # Middle East
    ("Doha", "Doha", "QA"),
    ("Riyadh", "Riyadh", "SA"),
    ("Kuwait City", "Kuwait City", "KW"),
    ("Muscat", "Muscat", "OM"),
    ("Tel Aviv", "Tel Aviv", "IL"),
    ("Beirut", "Beirut", "LB"),
    ("Amman", "Amman", "JO"),
    # African cities
    ("Accra", "Accra", "GH"),
    ("Addis Ababa", "Addis Ababa", "ET"),
    ("Kampala", "Kampala", "UG"),
    ("Kigali", "Kigali", "RW"),
    ("Dakar", "Dakar", "SN"),
    ("Luanda", "Luanda", "AO"),
    ("Maputo", "Maputo", "MZ"),
    ("Harare", "Harare", "ZW"),
    ("Lusaka", "Lusaka", "ZM"),
    ("Casablanca", "Casablanca", "MA"),
    ("Tunis", "Tunis", "TN"),
    ("Algiers", "Algiers", "DZ"),
    ("Khartoum", "Khartoum", "SD"),
]


def connect_wikidata():
    return psycopg.connect(WIKIDATA_DSN, row_factory=dict_row, autocommit=True)


def connect_xyzo():
    return psycopg.connect(XYZO_DSN, row_factory=dict_row, autocommit=True)


def lookup_city(wikidata_conn, enwiki_title):
    """Get QID and coordinates via enwiki_title (indexed lookup)."""
    with wikidata_conn.cursor() as cur:
        cur.execute("""
            SELECT id, label_en, lat, lon
            FROM wd_entities
            WHERE enwiki_title = %s
            LIMIT 1
        """, (enwiki_title,))
        return cur.fetchone()


def main():
    log.info("=" * 60)
    log.info("POPULATE xyzo_place_context (CORRECT QIDs)")
    log.info("=" * 60)

    conn_wiki = connect_wikidata()
    conn_xyzo = connect_xyzo()

    try:
        inserted = 0
        not_found = []

        for enwiki_title, place_name, country_code in CORRECT_CITIES:
            city = lookup_city(conn_wiki, enwiki_title)

            if not city:
                not_found.append(enwiki_title)
                log.info(f"  ❌ {place_name} ({enwiki_title}) - not found")
                continue

            with conn_xyzo.cursor() as cur:
                cur.execute("""
                    INSERT INTO xyzo_place_context (place_qid, place_name, country_code, lat, lon)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (place_qid) DO UPDATE SET
                        place_name = EXCLUDED.place_name,
                        lat = COALESCE(EXCLUDED.lat, xyzo_place_context.lat),
                        lon = COALESCE(EXCLUDED.lon, xyzo_place_context.lon)
                """, (city['id'], place_name, country_code, city['lat'], city['lon']))
                conn_xyzo.commit()

            inserted += 1
            status = "✅" if city['lat'] else "⚠️"
            coords = f"({city['lat']:.2f}, {city['lon']:.2f})" if city['lat'] else "(no coords)"
            log.info(f"  {status} {place_name} ({city['id']}) - {coords}")

        # Stats
        with conn_xyzo.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM xyzo_place_context")
            total = cur.fetchone()['count']
            cur.execute("SELECT COUNT(*) FROM xyzo_place_context WHERE lat IS NOT NULL")
            with_coords = cur.fetchone()['count']

        log.info("\n" + "=" * 60)
        log.info(f"DONE! {inserted} places, {total} total, {with_coords} with coords")
        log.info("=" * 60)

        if not_found:
            log.info(f"\nNot found ({len(not_found)}): {', '.join(not_found[:10])}...")

    finally:
        conn_wiki.close()
        conn_xyzo.close()


if __name__ == "__main__":
    sys.exit(main())
