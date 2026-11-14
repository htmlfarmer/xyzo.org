"""Populate organization → location anchors from known science/tech institutions.

Run:
    python3 -m worker.seed_org_anchors
    python3 -m worker.seed_org_anchors --dry-run
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
from pathlib import Path

from .db import connect

log = logging.getLogger("xyzo.seed_org_anchors")

# ── Known organization → location anchors ────────────────────────────────
# [org_name, city_name, state_region, country, country_code, lat, lng, anchor_type, wikidata]
ORG_ANCHORS = [
    # Space / Astronomy
    ["NASA", "Washington", "DC", "United States", "US", 38.8977, -77.0365, "headquarters", "Q23548"],
    ["NASA Headquarters", "Washington", "DC", "United States", "US", 38.8977, -77.0365, "headquarters", "Q23548"],
    ["NASA JPL", "Pasadena", "California", "United States", "US", 34.2006, -118.1748, "campus", "Q505015"],
    ["NASA Johnson Space Center", "Houston", "Texas", "United States", "US", 29.7604, -95.3698, "campus", "Q494839"],
    ["NASA Goddard", "Greenbelt", "Maryland", "United States", "US", 38.9962, -76.8473, "campus", "Q494840"],
    ["Jet Propulsion Laboratory", "Pasadena", "California", "United States", "US", 34.2006, -118.1748, "campus", "Q505015"],
    ["ESA", "Paris", "Île-de-France", "France", "FR", 48.8588, 2.3470, "headquarters", "Q334745"],
    ["European Space Agency", "Paris", "Île-de-France", "France", "FR", 48.8588, 2.3470, "headquarters", "Q334745"],
    ["JAXA", "Tokyo", "Tokyo", "Japan", "JP", 35.6762, 139.6503, "headquarters", "Q19459"],
    ["ISRO", "Bangalore", "Karnataka", "India", "IN", 12.9716, 77.5946, "headquarters", "Q167757"],
    ["CERN", "Geneva", "Canton of Geneva", "Switzerland", "CH", 46.2333, 6.0557, "headquarters", "Q23433"],
    ["SpaceX", "Hawthorne", "California", "United States", "US", 33.8650, -118.3306, "headquarters", "Q58104"],
    ["Blue Origin", "Kent", "Washington", "United States", "US", 47.3816, -122.2618, "headquarters", "Q612572"],
    ["Spaceflight Now", "Washington", "DC", "United States", "US", 38.8977, -77.0365, "headquarters", None],
    ["Sky & Telescope", "Cambridge", "Massachusetts", "United States", "US", 42.3701, -71.1097, "headquarters", "Q3488963"],
    ["Space.com", "New York City", "New York", "United States", "US", 40.7128, -74.0060, "headquarters", "Q282688"],
    ["Universe Today", "Victoria", "British Columbia", "Canada", "CA", 48.4284, -123.3656, "headquarters", None],

    # AI / Tech
    ["OpenAI", "San Francisco", "California", "United States", "US", 37.7749, -122.4194, "headquarters", "Q30002910"],
    ["Anthropic", "San Francisco", "California", "United States", "US", 37.7749, -122.4194, "headquarters", "Q108089601"],
    ["Google DeepMind", "London", "England", "United Kingdom", "GB", 51.5074, -0.1278, "headquarters", "Q15350621"],
    ["DeepMind", "London", "England", "United Kingdom", "GB", 51.5074, -0.1278, "headquarters", "Q15350621"],
    ["Google AI", "Mountain View", "California", "United States", "US", 37.3861, -122.0839, "headquarters", "Q219"],
    ["Google", "Mountain View", "California", "United States", "US", 37.3861, -122.0839, "headquarters", "Q219"],
    ["Microsoft Research", "Redmond", "Washington", "United States", "US", 47.6740, -122.1215, "headquarters", "Q44456"],
    ["Microsoft", "Redmond", "Washington", "United States", "US", 47.6740, -122.1215, "headquarters", "Q44456"],
    ["NVIDIA", "Santa Clara", "California", "United States", "US", 37.3541, -121.9552, "headquarters", "Q17447"],
    ["Nvidia", "Santa Clara", "California", "United States", "US", 37.3541, -121.9552, "headquarters", "Q17447"],
    ["Intel", "Santa Clara", "California", "United States", "US", 37.3541, -121.9552, "headquarters", "Q24848"],
    ["AMD", "Santa Clara", "California", "United States", "US", 37.3541, -121.9552, "headquarters", "Q249794"],
    ["Qualcomm", "San Diego", "California", "United States", "US", 32.7157, -117.1611, "headquarters", "Q166623"],
    ["ARM", "San Jose", "California", "United States", "US", 37.3382, -121.8863, "headquarters", "Q3037953"],
    ["Hugging Face", "New York City", "New York", "United States", "US", 40.7128, -74.0060, "headquarters", "Q151048034"],
    ["EleutherAI", "London", "England", "United Kingdom", "GB", 51.5074, -0.1278, "headquarters", "Q92860564"],
    ["Mila", "Montreal", "Quebec", "Canada", "CA", 45.5017, -73.5673, "headquarters", "Q28266747"],
    ["FAIR", "Menlo Park", "California", "United States", "US", 37.4530, -122.1817, "headquarters", "Q24872"],
    ["Meta AI", "Menlo Park", "California", "United States", "US", 37.4530, -122.1817, "headquarters", "Q24872"],
    ["MIT CSAIL", "Cambridge", "Massachusetts", "United States", "US", 42.3601, -71.0942, "campus", "Q49118"],
    ["Stanford AI Lab", "Stanford", "California", "United States", "US", 37.4275, -122.1697, "campus", "Q49108"],
    ["Berkeley AI Research", "Berkeley", "California", "United States", "US", 37.8715, -122.2730, "campus", "Q165957"],
    ["Allen Institute AI", "Seattle", "Washington", "United States", "US", 47.6062, -122.3321, "headquarters", "Q5358832"],

    # Biology / Medicine
    ["NIH", "Bethesda", "Maryland", "United States", "US", 38.9846, -77.0947, "headquarters", "Q387954"],
    ["Broad Institute", "Cambridge", "Massachusetts", "United States", "US", 42.3701, -71.1097, "campus", "Q4971095"],
    ["Sanger Institute", "Cambridge", "England", "United Kingdom", "GB", 52.0799, 0.1833, "headquarters", "Q281648"],
    ["EMBL", "Heidelberg", "Baden-Württemberg", "Germany", "DE", 49.3988, 8.6724, "headquarters", "Q501852"],
    ["Wellcome Trust", "London", "England", "United Kingdom", "GB", 51.5074, -0.1278, "headquarters", "Q2566162"],
    ["HHMI", "Chevy Chase", "Maryland", "United States", "US", 38.9709, -77.0860, "headquarters", "Q308835"],

    # Physics
    ["Fermilab", "Batavia", "Illinois", "United States", "US", 41.8322, -88.2544, "headquarters", "Q510788"],
    ["SLAC", "Menlo Park", "California", "United States", "US", 37.4530, -122.1817, "campus", "Q284463"],
    ["Brookhaven National Lab", "Upton", "New York", "United States", "US", 40.8680, -72.8675, "headquarters", "Q503570"],
    ["Los Alamos National Lab", "Los Alamos", "New Mexico", "United States", "US", 35.8800, -106.3030, "headquarters", "Q1137560"],
    ["NIST", "Gaithersburg", "Maryland", "United States", "US", 39.1434, -77.2014, "headquarters", "Q519676"],
    ["CERN Courier", "Geneva", "Canton of Geneva", "Switzerland", "CH", 46.2333, 6.0557, "campus", "Q23433"],

    # Earth Science
    ["NOAA", "Silver Spring", "Maryland", "United States", "US", 38.9935, -77.0282, "headquarters", "Q494859"],
    ["USGS", "Reston", "Virginia", "United States", "US", 38.9586, -77.3592, "headquarters", "Q570094"],
    ["ECMWF", "Reading", "England", "United Kingdom", "GB", 51.4416, -0.9403, "headquarters", "Q532195"],
    ["EUMETSAT", "Darmstadt", "Hesse", "Germany", "DE", 49.8716, 8.6234, "headquarters", "Q547830"],
    ["Met Office", "Exeter", "England", "United Kingdom", "GB", 50.7260, -3.5275, "headquarters", "Q3098916"],
    ["Scripps Institution", "La Jolla", "California", "United States", "US", 32.8650, -117.2540, "campus", "Q2188191"],
    ["Woods Hole Oceanographic", "Woods Hole", "Massachusetts", "United States", "US", 41.5261, -70.6722, "headquarters", "Q2605392"],

    # Quantum / Computing
    ["IBM Quantum", "Yorktown Heights", "New York", "United States", "US", 41.1706, -73.7725, "campus", "Q37126"],
    ["Google Quantum AI", "Santa Barbara", "California", "United States", "US", 34.4208, -119.6982, "campus", "Q10802"],
    ["Microsoft Quantum", "Redmond", "Washington", "United States", "US", 47.6740, -122.1215, "headquarters", "Q44456"],
    ["Quantum Computing Report", "Ottawa", "Ontario", "Canada", "CA", 45.4215, -75.6972, "headquarters", None],

    # Universities / Research
    ["MIT", "Cambridge", "Massachusetts", "United States", "US", 42.3601, -71.0942, "headquarters", "Q49118"],
    ["Stanford", "Stanford", "California", "United States", "US", 37.4275, -122.1697, "headquarters", "Q49108"],
    ["University of Tokyo", "Tokyo", "Tokyo", "Japan", "JP", 35.7126, 139.7620, "headquarters", "Q490565"],
    ["KAUST", "Thuwal", "Makkah", "Saudi Arabia", "SA", 22.2833, 39.1000, "headquarters", "Q294305"],
    ["ETH Zurich", "Zurich", "Canton of Zurich", "Switzerland", "CH", 47.3763, 8.5477, "headquarters", "Q127963"],
    ["EPFL", "Lausanne", "Canton of Vaud", "Switzerland", "CH", 46.5197, 6.5653, "headquarters", "Q262757"],
    ["Imperial College London", "London", "England", "United Kingdom", "GB", 51.4988, -0.1749, "headquarters", "Q134148"],
    ["Cambridge University", "Cambridge", "England", "United Kingdom", "GB", 52.2053, 0.1218, "headquarters", "Q35794"],
    ["Cornell University", "Ithaca", "New York", "United States", "US", 42.4440, -76.5019, "headquarters", "Q49114"],
    ["Georgia Tech", "Atlanta", "Georgia", "United States", "US", 33.7756, -84.3963, "headquarters", "Q117876"],
    ["IIT Bombay", "Mumbai", "Maharashtra", "India", "IN", 19.1334, 72.9130, "headquarters", "Q629904"],
    ["KAIST", "Daejeon", None, "South Korea", "KR", 36.3725, 127.3604, "headquarters", "Q495496"],
    ["NUS", "Singapore", "Singapore", "Singapore", "SG", 1.2966, 103.8534, "headquarters", "Q49273"],
    ["CSIRO", "Canberra", "ACT", "Australia", "AU", -35.2820, 149.1288, "headquarters", "Q746746"],
    ["A*STAR", "Singapore", "Singapore", "Singapore", "SG", 1.2966, 103.8534, "headquarters", "Q2671514"],

    # News organizations
    ["Reuters", "London", "England", "United Kingdom", "GB", 51.5074, -0.1278, "headquarters", "Q9720"],
    ["AP News", "New York City", "New York", "United States", "US", 40.7128, -74.0060, "headquarters", "Q308855"],
    ["Bloomberg", "New York City", "New York", "United States", "US", 40.7128, -74.0060, "headquarters", "Q191781"],
    ["BBC", "London", "England", "United Kingdom", "GB", 51.5074, -0.1278, "headquarters", "Q9531"],
    ["Nature", "London", "England", "United Kingdom", "GB", 51.5074, -0.1278, "headquarters", "Q167551"],
    ["Science Magazine", "Washington", "DC", "United States", "US", 38.8977, -77.0365, "headquarters", "Q49109"],
    ["Scientific American", "New York City", "New York", "United States", "US", 40.7128, -74.0060, "headquarters", "Q437615"],
    ["Ars Technica", "New York City", "New York", "United States", "US", 40.7128, -74.0060, "headquarters", "Q479170"],
    ["MIT Technology Review", "Cambridge", "Massachusetts", "United States", "US", 42.3601, -71.0942, "headquarters", "Q7725"],
    ["Quanta Magazine", "New York City", "New York", "United States", "US", 40.7128, -74.0060, "headquarters", "Q16082485"],
    ["IEEE Spectrum", "New York City", "New York", "United States", "US", 40.7128, -74.0060, "headquarters", "Q1261386"],
    ["Wired", "San Francisco", "California", "United States", "US", 37.7749, -122.4194, "headquarters", "Q1057292"],
    ["The Verge", "New York City", "New York", "United States", "US", 40.7128, -74.0060, "headquarters", "Q241480"],
    ["TechCrunch", "San Francisco", "California", "United States", "US", 37.7749, -122.4194, "headquarters", "Q120770"],
    ["CNET", "San Francisco", "California", "United States", "US", 37.7749, -122.4194, "headquarters", "Q1526530"],
    ["Engadget", "New York City", "New York", "United States", "US", 40.7128, -74.0060, "headquarters", "Q170058"],
    ["VentureBeat", "San Francisco", "California", "United States", "US", 37.7749, -122.4194, "headquarters", "Q1370848"],
    ["Phys.org", "Sydney", "New South Wales", "Australia", "AU", -33.8688, 151.2093, "headquarters", "Q7169135"],
    ["ScienceAlert", "Melbourne", "Victoria", "Australia", "AU", -37.8136, 144.9631, "headquarters", "Q7169135"],
    ["Live Science", "New York City", "New York", "United States", "US", 40.7128, -74.0060, "headquarters", "Q437615"],
]


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def run(dry_run: bool = False) -> dict:
    stats = {"inserted": 0, "skipped": 0, "updated": 0}
    for row in ORG_ANCHORS:
        (org_name, city_name, state, country, cc, lat, lng, anchor_type, wikidata) = row
        org_norm = _norm(org_name)

        if dry_run:
            log.info("  [dry] %s → %s, %s (%s)", org_name, city_name, country, anchor_type)
            stats["inserted"] += 1
            continue

        with connect() as conn:
            loc_row = conn.execute("""
                SELECT id FROM news_locations
                WHERE (
                    place_name_normalized ILIKE %(city)s
                    OR place_name_normalized ILIKE %(city_pct)s
                )
                AND country ILIKE %(country)s
                LIMIT 5
            """, {
                "city": f"%{city_name.lower()}%",
                "city_pct": f"%{city_name.lower().replace(' ', '%')}%",
                "country": f"%{country}%",
            }).fetchone()

            location_id = loc_row["id"] if loc_row else None

            if location_id:
                log.info("  %s → location_id=%s (%s, %s)", org_name, location_id, city_name, country)
            else:
                log.info("  %s → no location match (%s, %s)", org_name, city_name, country)

            conn.execute("""
                INSERT INTO news_org_location_anchors (
                    org_name, org_name_normalized, location_id,
                    city_name, state_region, country, country_code,
                    lat, lng, anchor_type, wikidata_id, source
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'manual')
                ON CONFLICT (org_name_normalized, anchor_type) DO UPDATE SET
                    location_id      = EXCLUDED.location_id,
                    lat              = EXCLUDED.lat,
                    lng              = EXCLUDED.lng,
                    country          = EXCLUDED.country,
                    country_code     = EXCLUDED.country_code
            """, (
                org_name, org_norm, location_id,
                city_name, state, country, cc,
                lat, lng, anchor_type, wikidata,
            ))

        stats["inserted"] += 1

    if not dry_run:
        with connect() as conn:
            conn.commit()

    log.info("seed_org_anchors: %s inserted, %s skipped", stats["inserted"], stats["skipped"])
    return stats


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    dry = "--dry-run" in sys.argv
    result = run(dry_run=dry)
    print(json.dumps(result))
