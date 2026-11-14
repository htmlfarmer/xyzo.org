"""Non-AI article geolocation — relocates mislocated articles using text parsing.

Strategies (tried in order, first confident match wins):
  1. Title city extraction — cities in the title are most relevant
  2. Full body city extraction — scan entire article for city mentions
  3. State/province detection — "California" → Sacramento, "Punjab" → Lahore
  4. Country detection — "Philippines" → Manila centroid
  5. Dateline extraction — "MANILA, Philippines (AP)" at article start
  6. Source country bias — Philippine source → Philippines
  7. Geographic hierarchy — city → state → country validation

Usage:
    from worker.relocate import relocate_articles, relocate_batch
    result = relocate_batch(limit=200)
    # → {relocated, flagged_for_ai, skipped}
"""
from __future__ import annotations

import logging
import math
import re
from collections import Counter, defaultdict

from . import cities_text
from .db import connect
from .auto_categorize import _detect_country_mentions, _load_source_cache

log = logging.getLogger("xyzo.relocate")

# ── Geographic hierarchy ─────────────────────────────────────────────
# Maps state/province names to their capital or major city.
# Used when article mentions a state but not a specific city.
STATE_TO_CITY = {
    # Philippines
    "metro manila": (14.6042, 120.9822, "Manila, PH"),
    "national capital region": (14.6042, 120.9822, "Manila, PH"),
    "ncr": (14.6042, 120.9822, "Manila, PH"),
    "cebu": (10.3157, 123.8854, "Cebu City, PH"),
    "davao": (7.1907, 125.4553, "Davao City, PH"),
    "laguna": (14.2691, 121.4113, "Santa Cruz, PH"),
    "cavite": (14.4791, 120.8969, "Imus, PH"),
    "bulacan": (14.7936, 120.8788, "Malolos, PH"),
    "rizal": (14.6037, 121.3084, "Antipolo, PH"),
    "pampanga": (14.9965, 120.6925, "San Fernando, PH"),
    "bataan": (14.6417, 120.4817, "Balanga, PH"),
    "zambales": (14.9333, 120.1500, "Iba, PH"),
    "pangasinan": (15.9333, 120.3333, "Lingayen, PH"),
    "la union": (16.6167, 120.3167, "San Fernando, PH"),
    "benguet": (16.4167, 120.5833, "La Trinidad, PH"),
    "ilocos sur": (17.5500, 120.3833, "Vigan, PH"),
    "ilocos norte": (18.1667, 120.7000, "Laoag, PH"),
    "tarlac": (15.4833, 120.5833, "Tarlac City, PH"),
    "nueva ecija": (15.5833, 120.9667, "Cabanatuan, PH"),
    "batangas": (13.7500, 121.0500, "Batangas City, PH"),
    "quezon": (14.0000, 121.7500, "Lucena, PH"),
    "albay": (13.2500, 123.7500, "Legazpi, PH"),
    "camarines sur": (13.5000, 123.3333, "Pili, PH"),
    "sorsogon": (12.9667, 124.0000, "Sorsogon City, PH"),
    "mindoro": (12.8333, 121.0833, "Calapan, PH"),
    "palawan": (10.0000, 118.7500, "Puerto Princesa, PH"),
    "iloilo": (10.7167, 122.5667, "Iloilo City, PH"),
    "negros": (10.3333, 123.0000, "Bacolod, PH"),
    "capiz": (11.5833, 122.7500, "Roxas City, PH"),
    "aklan": (11.6667, 122.3333, "Kalibo, PH"),
    "antique": (11.1667, 122.0000, "San Jose, PH"),
    "leyte": (11.0000, 124.8333, "Tacloban, PH"),
    "samar": (11.8333, 125.0000, "Catbalogan, PH"),
    "bohol": (9.8333, 124.1667, "Tagbilaran, PH"),
    "misamis": (8.5000, 124.6667, "Cagayan de Oro, PH"),
    "bukidnon": (8.0000, 125.0000, "Malaybalay, PH"),
    "lanao": (8.0000, 124.2500, "Marawi, PH"),
    "cotabato": (7.2167, 124.2500, "Cotabato City, PH"),
    "sultan kudarat": (6.5000, 124.5000, "Isulan, PH"),
    "maguindanao": (7.1333, 124.3000, "Shariff Aguak, PH"),
    "davao del sur": (6.7500, 125.3333, "Digos, PH"),
    "davao del norte": (7.5000, 125.7500, "Tagum, PH"),
    "compostela valley": (7.5000, 126.0833, "Nabunturan, PH"),
    "surigao": (9.7833, 125.4833, "Surigao City, PH"),
    "agusan": (8.9500, 125.5333, "Butuan, PH"),
    "zamboanga": (6.9167, 122.0833, "Zamboanga City, PH"),
    "sulu": (6.0500, 121.0000, "Jolo, PH"),
    "tawi-tawi": (5.0333, 119.7667, "Bongao, PH"),

    # US States
    "california": (36.7783, -119.4179, "Sacramento, US"),
    "texas": (31.9686, -99.9018, "Austin, US"),
    "florida": (27.6648, -81.5158, "Tallahassee, US"),
    "new york": (40.7128, -74.0060, "Albany, US"),
    "illinois": (40.6331, -89.3985, "Springfield, US"),
    "pennsylvania": (41.2033, -77.1945, "Harrisburg, US"),
    "ohio": (40.4173, -82.9071, "Columbus, US"),
    "georgia": (32.1656, -82.9001, "Atlanta, US"),
    "north carolina": (35.7596, -79.0193, "Raleigh, US"),
    "michigan": (44.3148, -85.6024, "Lansing, US"),
    "virginia": (37.4316, -78.6569, "Richmond, US"),
    "washington": (47.7511, -120.7401, "Olympia, US"),
    "arizona": (34.0489, -111.0937, "Phoenix, US"),
    "massachusetts": (42.4072, -71.3824, "Boston, US"),
    "tennessee": (35.5175, -86.5804, "Nashville, US"),
    "indiana": (40.2672, -86.1349, "Indianapolis, US"),
    "maryland": (39.0458, -76.6413, "Annapolis, US"),
    "wisconsin": (43.7844, -88.7879, "Madison, US"),
    "colorado": (39.5501, -105.7821, "Denver, US"),
    "minnesota": (46.7296, -94.6859, "Saint Paul, US"),
    "south carolina": (34.0007, -81.0348, "Columbia, US"),
    "alabama": (32.3182, -86.9023, "Montgomery, US"),
    "louisiana": (30.9843, -91.9623, "Baton Rouge, US"),
    "kentucky": (37.8393, -84.2700, "Frankfort, US"),
    "oregon": (43.8041, -120.5542, "Salem, US"),
    "oklahoma": (35.0078, -97.0929, "Oklahoma City, US"),
    "connecticut": (41.6032, -73.0877, "Hartford, US"),
    "iowa": (41.8780, -93.0977, "Des Moines, US"),
    "mississippi": (32.3547, -89.3985, "Jackson, US"),
    "arkansas": (34.9697, -92.3731, "Little Rock, US"),
    "utah": (39.3210, -111.0937, "Salt Lake City, US"),
    "kansas": (39.0119, -98.4842, "Topeka, US"),
    "nevada": (38.8026, -116.4194, "Carson City, US"),
    "new mexico": (34.5199, -105.8701, "Santa Fe, US"),
    "nebraska": (41.4925, -99.9018, "Lincoln, US"),
    "west virginia": (38.5976, -80.4549, "Charleston, US"),
    "idaho": (44.0682, -114.7420, "Boise, US"),
    "hawaii": (19.8968, -155.5828, "Honolulu, US"),
    "maine": (45.2538, -69.0000, "Augusta, US"),
    "new hampshire": (43.1939, -71.5724, "Concord, US"),
    "rhode island": (41.5801, -71.4774, "Providence, US"),
    "montana": (46.8797, -110.3626, "Helena, US"),
    "delaware": (38.9108, -75.5277, "Dover, US"),
    "south dakota": (43.9695, -99.9018, "Pierre, US"),
    "north dakota": (47.5515, -101.0020, "Bismarck, US"),
    "alaska": (64.2008, -149.4937, "Juneau, US"),
    "vermont": (44.5588, -72.5778, "Montpelier, US"),
    "wyoming": (43.0759, -107.2903, "Cheyenne, US"),

    # Indian States
    "maharashtra": (19.7515, 75.7139, "Mumbai, IN"),
    "uttar pradesh": (26.8467, 80.9462, "Lucknow, IN"),
    "tamil nadu": (13.0827, 80.2707, "Chennai, IN"),
    "karnataka": (12.9716, 77.5946, "Bengaluru, IN"),
    "gujarat": (23.0225, 72.5714, "Ahmedabad, IN"),
    "rajasthan": (26.9124, 75.7873, "Jaipur, IN"),
    "west bengal": (22.5726, 88.3639, "Kolkata, IN"),
    "madhya pradesh": (23.2599, 77.4126, "Bhopal, IN"),
    "andhra pradesh": (15.9129, 79.7400, "Amaravati, IN"),
    "telangana": (17.1232, 79.2088, "Hyderabad, IN"),
    "kerala": (10.8505, 76.2711, "Thiruvananthapuram, IN"),
    "punjab": (31.1471, 75.3412, "Chandigarh, IN"),
    "haryana": (30.7333, 76.7794, "Chandigarh, IN"),
    "bihar": (25.0961, 85.3131, "Patna, IN"),
    "odisha": (20.2961, 85.8245, "Bhubaneswar, IN"),
    "jharkhand": (23.6102, 85.2799, "Ranchi, IN"),
    "assam": (26.2006, 92.9376, "Dispur, IN"),
    "uttarakhand": (30.0668, 79.0193, "Dehradun, IN"),
    "himachal pradesh": (31.1048, 77.1734, "Shimla, IN"),
    "chhattisgarh": (21.2514, 81.6296, "Raipur, IN"),
    "goa": (15.2993, 74.1240, "Panaji, IN"),
    "tripura": (23.9408, 91.9882, "Agartala, IN"),
    "meghalaya": (25.4670, 91.3662, "Shillong, IN"),
    "manipur": (24.6637, 93.9063, "Imphal, IN"),
    "nagaland": (26.1584, 94.5624, "Kohima, IN"),
    "mizoram": (23.1645, 92.9376, "Aizawl, IN"),
    "arunachal pradesh": (27.0844, 93.6053, "Itanagar, IN"),
    "sikkim": (27.5330, 88.5122, "Gangtok, IN"),

    # Pakistan Provinces
    "punjab pakistan": (31.5204, 74.3587, "Lahore, PK"),
    "sindh": (24.8607, 67.0011, "Karachi, PK"),
    "khyber pakhtunkhwa": (34.0151, 71.5249, "Peshawar, PK"),
    "balochistan": (30.1798, 66.9750, "Quetta, PK"),
    "islamabad": (33.6844, 73.0479, "Islamabad, PK"),

    # UK
    "england": (51.5074, -0.1278, "London, GB"),
    "scotland": (55.9533, -3.1883, "Edinburgh, GB"),
    "wales": (51.4816, -3.1791, "Cardiff, GB"),
    "northern ireland": (54.5973, -5.9301, "Belfast, GB"),

    # Australia
    "new south wales": (-33.8688, 151.2093, "Sydney, AU"),
    "victoria": (-37.8136, 144.9631, "Melbourne, AU"),
    "queensland": (-27.4698, 153.0251, "Brisbane, AU"),
    "western australia": (-31.9505, 115.8605, "Perth, AU"),
    "south australia": (-34.9285, 138.6007, "Adelaide, AU"),
    "tasmania": (-42.8821, 147.3272, "Hobart, AU"),

    # Canadian Provinces
    "ontario": (43.6532, -79.3832, "Toronto, CA"),
    "quebec": (46.8139, -71.2080, "Quebec City, CA"),
    "british columbia": (49.2827, -123.1207, "Vancouver, CA"),
    "alberta": (51.0447, -114.0719, "Calgary, CA"),
    "manitoba": (49.8951, -97.1384, "Winnipeg, CA"),
    "saskatchewan": (50.4452, -104.6189, "Regina, CA"),
    "nova scotia": (44.6488, -63.5752, "Halifax, CA"),
    "new brunswick": (45.9636, -66.6431, "Fredericton, CA"),
}

# Country name → centroid (for when article mentions country but no city)
COUNTRY_CENTROID = {
    "PH": (12.8797, 121.7740), "US": (37.0902, -95.7129),
    "IN": (20.5937, 78.9629), "PK": (30.3753, 69.3451),
    "BD": (23.6850, 90.3563), "GB": (55.3781, -3.4360),
    "AU": (-25.2744, 133.7751), "CA": (56.1304, -106.3468),
    "DE": (51.1657, 10.4515), "FR": (46.2276, 2.2137),
    "JP": (36.2048, 138.2529), "KR": (35.9078, 127.7669),
    "CN": (35.8617, 104.1954), "BR": (-14.2350, -51.9253),
    "RU": (61.5240, 105.3188), "MX": (23.6345, -102.5528),
    "ID": (-0.7893, 113.9213), "TR": (38.9637, 35.2433),
    "SA": (23.8859, 45.0792), "IR": (32.4279, 53.6880),
    "EG": (26.8206, 30.8025), "NG": (9.0820, 8.6753),
    "ZA": (-30.5595, 22.9375), "KE": (-0.0236, 37.9062),
    "AR": (-38.4161, -63.6167), "CO": (4.5709, -74.2973),
    "CL": (-35.6751, -71.5430), "PE": (-9.1900, -75.0152),
    "VE": (6.4238, -66.5897), "EC": (-1.8312, -78.1834),
    "UA": (48.3794, 31.1656), "PL": (51.9194, 19.1451),
    "NL": (52.1326, 5.2913), "BE": (50.5039, 4.4699),
    "SE": (60.1282, 18.6435), "NO": (60.4720, 8.4689),
    "DK": (56.2639, 9.5018), "FI": (61.9241, 25.7482),
    "AT": (47.5162, 14.5501), "CH": (46.8182, 8.2275),
    "PT": (39.3999, -8.2245), "ES": (40.4637, -3.7492),
    "IT": (41.8719, 12.5674), "GR": (39.0742, 21.8243),
    "TH": (15.8700, 100.9925), "VN": (14.0583, 108.2772),
    "MY": (4.2105, 101.9758), "SG": (1.3521, 103.8198),
    "NZ": (-40.9006, 174.8860), "IE": (53.1424, -7.6921),
    "IL": (31.0461, 34.8516), "IQ": (33.2232, 43.6793),
    "AF": (33.9391, 67.7100), "NP": (28.3949, 84.1240),
    "LK": (7.8731, 80.7718), "MM": (21.9162, 95.9560),
    "KH": (12.5657, 104.9910), "LA": (19.8563, 102.4955),
    "TW": (23.6978, 120.9605), "HK": (22.3193, 114.1694),
}


def _extract_dateline(text: str) -> tuple[str | None, str | None]:
    """Extract city/country from a news dateline.

    Patterns:
      "MANILA, Philippines (AP) —"
      "TOKYO (Reuters) —"
      "NEW YORK (AP) —"
      "KARACHI, Pakistan —"
    """
    # Pattern: CITY, COUNTRY (SOURCE) —
    m = re.match(r'^([A-Z][A-Z\s]+),\s*([A-Z][a-z]+)\s*\([^)]+\)\s*[—\-]', text)
    if m:
        return m.group(1).strip().title(), m.group(2).strip()

    # Pattern: CITY (SOURCE) —
    m = re.match(r'^([A-Z][A-Z\s]+)\s*\([^)]+\)\s*[—\-]', text)
    if m:
        return m.group(1).strip().title(), None

    # Pattern: CITY, Country —
    m = re.match(r'^([A-Z][a-zA-Z\s]+),\s*([A-Z][a-z]+)\s*[—\-]', text)
    if m:
        return m.group(1).strip(), m.group(2).strip()

    return None, None


def _find_best_city(text: str, source_country: str | None = None) -> dict | None:
    """Find the best city match in text using multiple strategies.

    Returns {name, lat, lng, country_code, population, confidence, strategy} or None.
    """
    # Strategy 1: Extract cities from text
    matches = cities_text.find_cities_in_text(text, min_population=50_000)
    if matches:
        # Prefer cities that match the source country
        if source_country:
            source_matches = [m for m in matches if m["city"].get("country_code") == source_country]
            if source_matches:
                matches = source_matches

        # Pick the best match (first in text, then by population)
        matches.sort(key=lambda m: (m.get("start", 9999), -(m["city"].get("population") or 0)))
        best = matches[0]
        city = best["city"]
        return {
            "name": city.get("name"),
            "lat": float(city["lat"]),
            "lng": float(city["lng"]),
            "country_code": city.get("country_code"),
            "population": city.get("population", 0),
            "confidence": "high" if city.get("population", 0) >= 1_000_000 else "medium",
            "strategy": "city_extraction",
        }

    # Strategy 1b: Try gazetteer for cities not in world_cities
    gazetteer_matches = _find_in_gazetteer(text)
    if gazetteer_matches:
        # Prefer cities that match the source country
        if source_country:
            source_matches = [m for m in gazetteer_matches if m["city"].get("country_code") == source_country]
            if source_matches:
                gazetteer_matches = source_matches
        best = gazetteer_matches[0]
        city = best["city"]
        return {
            "name": city.get("name"),
            "lat": float(city["lat"]),
            "lng": float(city["lng"]),
            "country_code": city.get("country_code"),
            "population": city.get("population", 0),
            "confidence": "medium",
            "strategy": "gazetteer_extraction",
        }

    # Strategy 2: State/province detection
    text_lower = text.lower()
    for state_name, (lat, lng, city_label) in STATE_TO_CITY.items():
        if state_name in text_lower:
            return {
                "name": city_label.split(",")[0],
                "lat": lat,
                "lng": lng,
                "country_code": city_label.split(", ")[-1] if ", " in city_label else None,
                "population": 0,
                "confidence": "medium",
                "strategy": f"state_match:{state_name}",
            }

    # Strategy 3: Country detection
    mentioned = _detect_country_mentions(text)
    if mentioned and source_country and source_country in mentioned:
        centroid = COUNTRY_CENTROID.get(source_country)
        if centroid:
            return {
                "name": f"{source_country} (country centroid)",
                "lat": centroid[0],
                "lng": centroid[1],
                "country_code": source_country,
                "population": 0,
                "confidence": "low",
                "strategy": "country_centroid",
            }

    # Strategy 4: Source country fallback
    if source_country:
        centroid = COUNTRY_CENTROID.get(source_country)
        if centroid:
            return {
                "name": f"{source_country} (source fallback)",
                "lat": centroid[0],
                "lng": centroid[1],
                "country_code": source_country,
                "population": 0,
                "confidence": "low",
                "strategy": "source_country_fallback",
            }

    return None


def _is_false_positive_city(city_name: str, text: str) -> bool:
    """Check if a city name in text is likely a false positive.

    Detects:
    - Person names (Bello, Vladimir, etc.)
    - Sports teams (Vitória, San Pablo, etc.)
    - Region names (América Latina)
    - Common words in other languages (salta = jumps in Portuguese)
    """
    text_lower = text.lower()
    city_lower = city_name.lower()

    PERSON_CONTEXT = {
        "bello": [r"\batiku\b", r"\bgovernor\b", r"\bsenator\b", r"\bminister\b", r"\btasks\b"],
        "vladimir": [r"\bputin\b", r"\bpresident\b", r"\brussia\b", r"\brussian\b"],
        "gaya": [r"\belektabilitas\b", r"\bkdm\b", r"\bprabowo\b"],
    }

    SPORTS_CONTEXT = {
        "vitória": [r"\bgrêmio\b", r"\bgremio\b", r"\bfutebol\b", r"\bbrasileirão\b",
                    r"\bflamengo\b", r"\bsantos\b", r"\bcorinthians\b", r"\bpalmas\b",
                    r"\bec vitória\b", r"\bvitória\s+1\b", r"\bvitória\s+x\b",
                    r"\bvitória\s+da\b", r"\bvitória\s+sobre\b", r"\bgol\s+da\s+vitória\b"],
        "san pablo": [r"\bboca\b", r"\briver\b", r"\bfútbol\b", r"\bcopa\b",
                      r"\bsudamericana\b", r"\blibertadores\b", r"\bbrasileirão\b",
                      r"\bsão paulo\b", r"\bsao paulo\b"],
        "salta": [r"\bbaleia\b", r"\bsalto\b", r"\bsalta\s+en\b", r"\bjumps\b"],
    }

    REGION_CONTEXT = {
        "latina": [r"\bamérica\s+latina\b", r"\bamerica\s+latina\b", r"\blatinoamérica\b",
                   r"\blatinoamerica\b", r"\bregión\b", r"\bregion\b"],
        "rio": [r"\brio\s+de\s+la\s+plata\b", r"\brio\s+de\s+laplata\b"],
    }

    for name, patterns in PERSON_CONTEXT.items():
        if city_lower == name:
            if any(re.search(p, text_lower) for p in patterns):
                return True

    for name, patterns in SPORTS_CONTEXT.items():
        if city_lower == name:
            if any(re.search(p, text_lower) for p in patterns):
                return True

    for name, patterns in REGION_CONTEXT.items():
        if city_lower == name:
            if any(re.search(p, text_lower) for p in patterns):
                return True

    return False


def relocate_article(article_id: int) -> dict | None:
    """Try to relocate a single article using non-AI methods.

    Returns {new_lat, new_lng, new_location, strategy, confidence} or None.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT a.id, a.title, a.body, a.source_id,
                   a.extracted_lat, a.extracted_lng, a.extracted_location,
                   s.country as source_country, s.name as source_name
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            WHERE a.id = %s
        """, (article_id,))
        row = cur.fetchone()

    if not row:
        return None

    title = row.get("title") or ""
    body = row.get("body") or ""
    source_country = (row.get("source_country") or "").upper()
    old_lat = float(row["extracted_lat"]) if row.get("extracted_lat") else None
    old_lng = float(row["extracted_lng"]) if row.get("extracted_lng") else None

    full_text = f"{title} {body}"

    # Special check: Disambiguate Alexandria (Egypt vs US states / Washington DC)
    if old_lat and old_lng and 31.0 <= old_lat <= 31.3 and 29.7 <= old_lng <= 30.1:
        if not re.search(r"\begypt\b|\begyptian\b|\bcairo\b|\bnile\b|\bmediterranean\b|\bpharaoh\b|\balexandria,\s*egypt\b", full_text.lower()):
            if re.search(r"\bocasio\b|\bcortez\b|\baoc\b|\bcongresswoman\b|\brep\.\s+alexandria\b", full_text.lower()):
                return {"new_lat": 38.8951, "new_lng": -77.0364, "new_location": "Washington, US", "strategy": "alexandria_aoc_dc", "confidence": "high", "distance_km": 9000}
            elif re.search(r"\bminnesota\b|\bmn\b|\becho\s+press\b|\bvoice\s+of\s+alexandria\b", full_text.lower()):
                return {"new_lat": 45.8852, "new_lng": -95.9775, "new_location": "Alexandria, MN, US", "strategy": "alexandria_mn", "confidence": "high", "distance_km": 9000}
            elif re.search(r"\blouisiana\b|\bla\b|\btown\s+talk\b", full_text.lower()):
                return {"new_lat": 31.3113, "new_lng": -92.4451, "new_location": "Alexandria, LA, US", "strategy": "alexandria_la", "confidence": "high", "distance_km": 9000}
            elif re.search(r"\bkentucky\b|\bky\b|\balexandria\s+pike\b", full_text.lower()):
                return {"new_lat": 38.9620, "new_lng": -84.3847, "new_location": "Alexandria, KY, US", "strategy": "alexandria_ky", "confidence": "high", "distance_km": 9000}
            elif re.search(r"\bliving\s+magazine\b|\balexandria\s+living\b", full_text.lower()):
                return {"new_lat": 38.8048, "new_lng": -77.0469, "new_location": "Alexandria, VA, US", "strategy": "alexandria_va", "confidence": "high", "distance_km": 9000}
            else:
                return {"new_lat": 38.8048, "new_lng": -77.0469, "new_location": "Alexandria, VA, US", "strategy": "alexandria_va", "confidence": "high", "distance_km": 9000}

    # Try dateline first
    dateline_city, dateline_country = _extract_dateline(body)
    if dateline_city:
        stats = cities_text.stats(dateline_city)
        primary = stats.get("primary")
        if primary:
            new_lat = float(primary["lat"])
            new_lng = float(primary["lng"])
            if old_lat and old_lng:
                from .density import _haversine_km
                dist = _haversine_km(old_lat, old_lng, new_lat, new_lng)
                if dist > 30:
                    return {
                        "new_lat": new_lat,
                        "new_lng": new_lng,
                        "new_location": f"{primary['name']}, {primary.get('country_code', '')}",
                        "strategy": "dateline",
                        "confidence": "high",
                        "distance_km": round(dist),
                    }

    # Try title-first extraction (title cities are most relevant)
    title_result = _find_best_city(title, source_country)
    if title_result and title_result["confidence"] in ("high", "medium"):
        city_name = title_result["name"]
        if _is_false_positive_city(city_name, full_text):
            log.debug("Skipping false positive city '%s' in title for article %s", city_name, article_id)
        else:
            new_lat = title_result["lat"]
            new_lng = title_result["lng"]
            if old_lat and old_lng:
                from .density import _haversine_km
                dist = _haversine_km(old_lat, old_lng, new_lat, new_lng)
                if dist > 30:
                    return {
                        "new_lat": new_lat,
                        "new_lng": new_lng,
                        "new_location": f"{title_result['name']}, {title_result.get('country_code', '')}",
                        "strategy": f"title_{title_result['strategy']}",
                        "confidence": title_result["confidence"],
                        "distance_km": round(dist),
                    }

    # Try full body extraction
    full_text = f"{title}\n{body}"
    body_result = _find_best_city(full_text, source_country)
    if body_result and body_result["confidence"] in ("high", "medium"):
        new_lat = body_result["lat"]
        new_lng = body_result["lng"]
        if old_lat and old_lng:
            from .density import _haversine_km
            dist = _haversine_km(old_lat, old_lng, new_lat, new_lng)
            if dist > 50:
                return {
                    "new_lat": new_lat,
                    "new_lng": new_lng,
                    "new_location": f"{body_result['name']}, {body_result.get('country_code', '')}",
                    "strategy": f"body_{body_result['strategy']}",
                    "confidence": body_result["confidence"],
                    "distance_km": round(dist),
                }

    return None


def relocate_batch(limit: int = 200, only_flagged: bool = True) -> dict:
    """Relocate mislocated articles using non-AI methods.

    Args:
        limit: Max articles to process
        only_flagged: If True, only process density_flagged articles

    Returns:
        {relocated, flagged_for_ai, skipped, strategies: {strategy: count}}
    """
    with connect() as conn, conn.cursor() as cur:
        if only_flagged:
            cur.execute("""
                SELECT a.id FROM news_articles a
                WHERE a.auto_categorize_status = 'density_flagged'
                  AND a.status = 'extracted'
                ORDER BY a.fetched_at DESC
                LIMIT %s
            """, (limit,))
        else:
            cur.execute("""
                SELECT a.id FROM news_articles a
                WHERE a.status = 'extracted'
                  AND a.auto_categorize_method IN ('source_fallback', 'density_spread')
                ORDER BY a.fetched_at DESC
                LIMIT %s
            """, (limit,))

        article_ids = [r["id"] for r in cur.fetchall()]

    relocated = 0
    flagged = 0
    skipped = 0
    strategies = Counter()

    for aid in article_ids:
        result = relocate_article(aid)
        if result:
            with connect() as conn, conn.cursor() as cur:
                cur.execute("""
                    UPDATE news_articles
                    SET extracted_lat = %s,
                        extracted_lng = %s,
                        extracted_location = %s,
                        location_text = %s,
                        auto_categorize_method = %s,
                        auto_categorize_status = 'relocated'
                    WHERE id = %s
                """, (
                    result["new_lat"], result["new_lng"],
                    result["new_location"], result["new_location"],
                    f"relocated_{result['strategy']}", aid,
                ))
            relocated += 1
            strategies[result["strategy"]] += 1
            log.info("relocated %s → %s (%s, %s km)", aid, result["new_location"],
                     result["strategy"], result.get("distance_km"))
        else:
            skipped += 1

    return {
        "processed": len(article_ids),
        "relocated": relocated,
        "flagged_for_ai": flagged,
        "skipped": skipped,
        "strategies": dict(strategies),
    }


def audit_extracted_articles(limit: int = 500, apply_fixes: bool = False) -> dict:
    """Audit extracted articles where title mentions a city but extracted location is wrong.

    Catches cases where AI extraction (Gemma-4) got confused by body text
    (e.g., "playa Mansa" → "Mansa, ZM" instead of "Punta del Este, UY").

    Args:
        limit: Max articles to audit
        apply_fixes: If True, apply corrections; if False, dry-run report only

    Returns:
        {audited, mismatches, fixes_applied, details: [...]}
    """
    from .density import _haversine_km

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT a.id, a.title, a.body, a.extracted_lat, a.extracted_lng, a.extracted_location,
                   a.auto_categorize_method, s.country as source_country
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            WHERE a.status = 'extracted'
              AND a.extracted_lat IS NOT NULL
              AND a.extracted_lng IS NOT NULL
            ORDER BY a.fetched_at DESC
            LIMIT %s
        """, (limit,))
        articles = [dict(r) for r in cur.fetchall()]

    mismatches = []
    fixes_applied = 0

    gazetteer_cache = _load_gazetteer_cache()

    for article in articles:
        title = article.get("title") or ""
        body = article.get("body") or ""
        full_text = f"{title} {body}"
        if not title:
            continue

        title_matches = cities_text.find_cities_in_text(title, min_population=50_000)

        if not title_matches:
            title_matches = _find_in_gazetteer(title, gazetteer_cache)
        if not title_matches:
            continue

        _kind_rank = {"name": 0, "alias": 1, "entity": 2}
        title_matches.sort(key=lambda m: (
            _kind_rank.get(m.get("kind"), 9),
            -(m["city"].get("population") or 0),
        ))
        best = title_matches[0]
        if best.get("confidence") == "low":
            continue

        city = best["city"]
        city_name = city.get("name") or ""

        # Skip false positives (person names, sports teams, regions)
        if _is_false_positive_city(city_name, full_text):
            continue

        title_lat = float(city["lat"])
        title_lng = float(city["lng"])
        title_country = city.get("country_code")

        ext_lat = float(article["extracted_lat"])
        ext_lng = float(article["extracted_lng"])
        source_country = (article.get("source_country") or "").upper()

        dist_km = _haversine_km(ext_lat, ext_lng, title_lat, title_lng)

        if dist_km < 100:
            continue

        ext_country = _nearest_country(ext_lat, ext_lng)
        country_mismatch = title_country and ext_country and title_country != ext_country

        if dist_km < 500 and not country_mismatch:
            continue

        # If extracted location matches source country but title city is foreign,
        # the article is likely about a foreign place from a domestic source
        if source_country and ext_country == source_country and title_country != source_country:
            continue

        mismatch = {
            "article_id": article["id"],
            "title": title[:80],
            "extracted_location": article["extracted_location"],
            "extracted_coords": (ext_lat, ext_lng),
            "title_city": city.get("name"),
            "title_coords": (title_lat, title_lng),
            "title_country": title_country,
            "distance_km": round(dist_km),
            "country_mismatch": country_mismatch,
            "source_country": source_country,
        }
        mismatches.append(mismatch)

        if apply_fixes:
            result = relocate_article(article["id"])
            if result:
                with connect() as conn, conn.cursor() as cur:
                    cur.execute("""
                        UPDATE news_articles
                        SET extracted_lat = %s,
                            extracted_lng = %s,
                            extracted_location = %s,
                            location_text = %s,
                            auto_categorize_method = %s,
                            auto_categorize_status = 'relocated'
                        WHERE id = %s
                    """, (
                        result["new_lat"], result["new_lng"],
                        result["new_location"], result["new_location"],
                        f"relocated_audit_{result['strategy']}", article["id"],
                    ))
                fixes_applied += 1
                log.info("fixed %s: %s → %s (%s km)", article["id"],
                         article["extracted_location"], result["new_location"],
                         result.get("distance_km"))

    return {
        "audited": len(articles),
        "mismatches": len(mismatches),
        "fixes_applied": fixes_applied,
        "details": mismatches[:20],
    }


def _nearest_country(lat: float, lng: float) -> str | None:
    """Return the country_code of the nearest world city."""
    cities_text._INDEX.load()
    best_country = None
    best_d = float("inf")
    for c in cities_text._INDEX.cities_by_name.values():
        for r in c:
            d = _haversine_km(lat, lng, float(r["lat"]), float(r["lng"]))
            if d < best_d:
                best_d = d
                best_country = r.get("country_code")
    return best_country


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in kilometers."""
    R = 6_371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


_gazetteer_cache: list[dict] | None = None


def _load_gazetteer_cache() -> list[dict]:
    """Load gazetteer entries for city matching."""
    global _gazetteer_cache
    if _gazetteer_cache is not None:
        return _gazetteer_cache
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT label, aliases, lat, lng, country_code, population, entity_type
            FROM gazetteer
            WHERE entity_type = 'city'
        """)
        _gazetteer_cache = [dict(r) for r in cur.fetchall()]
    return _gazetteer_cache


def _find_in_gazetteer(text: str, gazetteer: list[dict] | None = None) -> list[dict]:
    """Find city mentions in text using the gazetteer.

    Returns list of {city: {...}, kind: 'name'|'alias', confidence: 'high'|'medium'|'low'}.
    """
    if gazetteer is None:
        gazetteer = _load_gazetteer_cache()
    text_lower = text.lower()
    matches = []
    for entry in gazetteer:
        label = entry.get("label") or ""
        aliases = entry.get("aliases") or []
        pop = entry.get("population") or 0
        city_data = {
            "name": label,
            "lat": entry["lat"],
            "lng": entry["lng"],
            "country_code": entry.get("country_code"),
            "population": pop,
        }
        if label and label.lower() in text_lower:
            conf = "high" if pop >= 500_000 else ("medium" if pop >= 50_000 else "low")
            matches.append({"city": city_data, "kind": "name", "confidence": conf})
        else:
            for alias in aliases:
                if alias and alias.lower() in text_lower:
                    conf = "high" if pop >= 500_000 else ("medium" if pop >= 50_000 else "low")
                    matches.append({"city": city_data, "kind": "alias", "confidence": conf})
                    break
    return matches
