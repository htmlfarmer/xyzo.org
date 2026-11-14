"""Geocode news_sources — populate lat/lng from country + region.

Run once to backfill existing sources, then the auto_categorize
source_fallback path can use these coordinates for articles that
don't mention a city name in their text.

Usage:
    python -m worker.geocode_sources          # geocode all un-geocoded sources
    python -m worker.geocode_sources --force  # re-geocode all active sources
"""
from __future__ import annotations

import logging
from typing import Any

from .db import connect

log = logging.getLogger("xyzo.geocode_sources")

# Country code → (lat, lng, capital_name)
# ISO 3166-1 alpha-2 codes. Covers every country in feeds.json.
COUNTRY_COORDS: dict[str, tuple[float, float, str]] = {
    "US": (38.8951, -77.0364, "Washington"),
    "GB": (51.5074, -0.1278, "London"),
    "CA": (45.4215, -75.6972, "Ottawa"),
    "AU": (-35.2809, 149.1300, "Canberra"),
    "NZ": (-41.2865, 174.7762, "Wellington"),
    "IN": (28.6139, 77.2090, "New Delhi"),
    "PK": (33.6844, 73.0479, "Islamabad"),
    "BD": (23.8103, 90.4125, "Dhaka"),
    "NP": (27.7172, 85.3240, "Kathmandu"),
    "LK": (6.9271, 79.8612, "Colombo"),
    "MM": (19.7633, 96.0785, "Naypyidaw"),
    "PH": (14.5995, 120.9842, "Manila"),
    "ID": (-6.2088, 106.8456, "Jakarta"),
    "MY": (3.1390, 101.6869, "Kuala Lumpur"),
    "SG": (1.3521, 103.8198, "Singapore"),
    "TH": (13.7563, 100.5018, "Bangkok"),
    "VN": (21.0285, 105.8542, "Hanoi"),
    "KR": (37.5665, 126.9780, "Seoul"),
    "JP": (35.6762, 139.6503, "Tokyo"),
    "CN": (39.9042, 116.4074, "Beijing"),
    "TW": (25.0330, 121.5654, "Taipei"),
    "HK": (22.3193, 114.1694, "Hong Kong"),
    "TR": (39.9334, 32.8597, "Ankara"),
    "SA": (24.7136, 46.6753, "Riyadh"),
    "AE": (24.4539, 54.3773, "Abu Dhabi"),
    "QA": (25.2854, 51.5310, "Doha"),
    "IL": (31.7683, 35.2137, "Jerusalem"),
    "PS": (31.7683, 35.2137, "Ramallah"),
    "IR": (35.6892, 51.3890, "Tehran"),
    "IQ": (33.3152, 44.3661, "Baghdad"),
    "SY": (33.5138, 36.2929, "Damascus"),
    "LB": (33.8938, 35.5018, "Beirut"),
    "JO": (31.9454, 35.9284, "Amman"),
    "YE": (15.3694, 44.1910, "Sanaa"),
    "AF": (34.5553, 69.2075, "Kabul"),
    "UZ": (41.2995, 69.2401, "Tashkent"),
    "KZ": (51.1694, 71.4491, "Astana"),
    "RU": (55.7558, 37.6173, "Moscow"),
    "UA": (50.4501, 30.5234, "Kyiv"),
    "PL": (52.2297, 21.0122, "Warsaw"),
    "DE": (52.5200, 13.4050, "Berlin"),
    "FR": (48.8566, 2.3522, "Paris"),
    "ES": (40.4168, -3.7038, "Madrid"),
    "IT": (41.9028, 12.4964, "Rome"),
    "NL": (52.3676, 4.9041, "Amsterdam"),
    "BE": (50.8503, 4.3517, "Brussels"),
    "CH": (46.9480, 7.4474, "Bern"),
    "AT": (48.2082, 16.3738, "Vienna"),
    "SE": (59.3293, 18.0686, "Stockholm"),
    "NO": (59.9139, 10.7522, "Oslo"),
    "FI": (60.1699, 24.9384, "Helsinki"),
    "DK": (55.6761, 12.5683, "Copenhagen"),
    "IE": (53.3498, -6.2603, "Dublin"),
    "PT": (38.7223, -9.1393, "Lisbon"),
    "GR": (37.9838, 23.7275, "Athens"),
    "CZ": (50.0755, 14.4378, "Prague"),
    "RO": (44.4323, 26.1063, "Bucharest"),
    "HU": (47.4979, 19.0402, "Budapest"),
    "EG": (30.0444, 31.2357, "Cairo"),
    "NG": (9.0765, 7.3986, "Abuja"),
    "ZA": (-25.7479, 28.2293, "Pretoria"),
    "KE": (-1.2921, 36.8219, "Nairobi"),
    "ET": (9.0300, 38.7400, "Addis Ababa"),
    "GH": (5.6037, -0.1870, "Accra"),
    "TZ": (-6.7924, 39.2083, "Dodoma"),
    "CD": (-4.4419, 15.2663, "Kinshasa"),
    "CM": (3.8480, 11.5021, "Yaounde"),
    "AO": (-8.8390, 13.2894, "Luanda"),
    "MZ": (-25.9692, 32.5732, "Maputo"),
    "SD": (15.5007, 32.5599, "Khartoum"),
    "MA": (34.0209, -6.8416, "Rabat"),
    "DZ": (36.7538, 3.0588, "Algiers"),
    "LY": (32.8872, 13.1913, "Tripoli"),
    "BR": (-15.7975, -47.8919, "Brasilia"),
    "AR": (-34.6037, -58.3816, "Buenos Aires"),
    "MX": (19.4326, -99.1332, "Mexico City"),
    "CO": (4.7110, -74.0721, "Bogota"),
    "VE": (10.4806, -66.9036, "Caracas"),
    "PE": (-12.0464, -77.0428, "Lima"),
    "CL": (-33.4489, -70.6693, "Santiago"),
    "CU": (23.1136, -82.3666, "Havana"),
    "EC": (-0.1807, -78.4678, "Quito"),
    "UN": (40.7529, -73.9740, "New York"),  # UN HQ
    "EU": (50.8503, 4.3517, "Brussels"),    # EU HQ
}

# Region → approximate center (lat, lng). Used when country is "global"
# or when we want a more specific regional center.
REGION_COORDS: dict[str, tuple[float, float]] = {
    "global":           (20.0, 0.0),
    "global-south":     (-5.0, -30.0),
    "europe":           (50.0, 10.0),
    "eurasia":          (50.0, 60.0),
    "americas":         (15.0, -90.0),
    "south-america":    (-15.0, -60.0),
    "africa":           (0.0, 25.0),
    "north-africa":     (30.0, 5.0),
    "east-africa":      (-2.0, 35.0),
    "west-africa":      (10.0, -5.0),
    "central-africa":   (0.0, 20.0),
    "southern-africa":  (-25.0, 25.0),
    "middle-east":      (30.0, 45.0),
    "south-asia":       (25.0, 78.0),
    "central-asia":     (42.0, 65.0),
    "east-asia":        (35.0, 115.0),
    "southeast-asia":   (5.0, 110.0),
    "asia-pacific":     (15.0, 120.0),
    "western-australia": (-31.0, 115.0),
}


def geocode_source(name: str, country: str | None, region: str | None) -> dict | None:
    """Derive lat/lng for a news source from its country + region.

    Priority:
      1. Country code → capital city coords (most specific)
      2. Region → approximate center (fallback for "global" sources)
      3. None if both are missing/unknown
    """
    cc = (country or "").strip().upper()
    reg = (region or "").strip().lower()

    # Country match
    if cc and cc in COUNTRY_COORDS:
        lat, lng, city = COUNTRY_COORDS[cc]
        return {
            "lat": lat,
            "lng": lng,
            "geocoded_location": f"{city}, {cc}",
        }

    # Region match
    if reg and reg in REGION_COORDS:
        lat, lng = REGION_COORDS[reg]
        return {
            "lat": lat,
            "lng": lng,
            "geocoded_location": f"{reg} (region center)",
        }

    return None


def run(force: bool = False) -> dict:
    """Geocode all news_sources that don't have lat/lng yet.

    Args:
        force: If True, re-geocode all active sources (even those with lat/lng).

    Returns:
        Summary dict with counts.
    """
    summary = {"total": 0, "geocoded": 0, "skipped": 0, "failed": 0}

    with connect() as conn, conn.cursor() as cur:
        if force:
            cur.execute("""
                SELECT id, name, country, region
                FROM news_sources
                WHERE active = true
            """)
        else:
            cur.execute("""
                SELECT id, name, country, region
                FROM news_sources
                WHERE lat IS NULL AND active = true
            """)
        sources = cur.fetchall()
        summary["total"] = len(sources)

        for src in sources:
            result = geocode_source(src["name"], src["country"], src["region"])
            if result is None:
                summary["failed"] += 1
                log.debug("no coords for %s (country=%s, region=%s)",
                          src["name"], src["country"], src["region"])
                continue

            cur.execute("""
                UPDATE news_sources
                SET lat = %s,
                    lng = %s,
                    geocoded_location = %s,
                    geocoded_at = now()
                WHERE id = %s
            """, (result["lat"], result["lng"],
                  result["geocoded_location"], src["id"]))
            summary["geocoded"] += 1
            log.info("geocoded %s → %s (%.4f, %.4f)",
                     src["name"], result["geocoded_location"],
                     result["lat"], result["lng"])

    log.info("geocode_sources done: %s", summary)
    return summary


if __name__ == "__main__":
    import argparse
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    p = argparse.ArgumentParser(description="Geocode news sources")
    p.add_argument("--force", action="store_true",
                   help="Re-geocode all active sources")
    args = p.parse_args()
    print(run(force=args.force))
