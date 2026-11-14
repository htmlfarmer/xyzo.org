"""Non-AI fast-path categorizer for xyzo articles.

The standard pipeline calls Gemma for every pending article and uses
Nominatim for every extracted location. On a 300-article discovery run
that's a lot of LLM tokens and a lot of HTTP calls to public services.

`auto_categorize.run()` does a fast pre-pass using only the data we
already have on hand:

  * `cities_text.find_cities_in_text` — locates city mentions in
    title + body using the FDW-loaded world_cities index.
  * `classify.classify` — keyword-based event_type detection that
    mirrors worker/classify.py vocab.

When a row gets a high- or medium-confidence city + a non-"other"
category, we set:

  * extracted_lat / extracted_lng  (from the city row)
  * extracted_location             ("Mumbai, IN")
  * location_text                  ("Mumbai, India")
  * event_type                     (from classify)
  * summary                        (first 240 chars of title + '...')
  * entities / topic_tags          (empty — AI still owns these if needed)
  * status                         = 'extracted'
  * auto_categorized_at            = now()
  * auto_categorize_status         = 'high' | 'medium'
  * auto_categorize_confidence     = 'high' | 'medium'
  * auto_categorize_city_id        = world_cities.id
  * auto_categorize_city_label     = "Mumbai, IN"
  * auto_categorize_event_type     = the matched category
  * auto_categorize_method         = 'fast_path'

When no city is found OR the category is "other" / no category hits,
we leave the row at status='pending' WITHOUT setting auto_categorized_at
so extract.py's AI can still claim and process it.

Downstream effects:
  * extract.py claims rows WHERE status = 'pending' — since no_match/low
    articles keep auto_categorized_at NULL, the AI gets a second chance.
  * geocode.py skips Nominatim when extracted_lat/lng are already set
    by this pass.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any

from . import cities_text, classify
from .db import connect
from .geocode import find_location_by_coords
from .geo_utils import haversine_km as _haversine
from .progress import ProgressWriter

# NN category classifier — optional, lazy-loaded. When present, articles
# whose heuristic category is "other" / unknown get a second-chance
# classification from the trained WordFreqNN model. The classifier is
# loaded once per process and cached in nn_classifier._classifier_instance.
# Set XYZO_DISABLE_NN_CLASSIFIER=1 to skip it (useful in CI / when the
# model disk is missing).
try:
    from .nn_classifier import get_classifier
    _NN_CLASSIFIER_DISABLED = os.environ.get("XYZO_DISABLE_NN_CLASSIFIER", "").lower() in ("1", "true", "yes")
except Exception:  # pragma: no cover — nn_classifier pulls in torch, may not be installed everywhere
    get_classifier = None  # type: ignore[assignment]
    _NN_CLASSIFIER_DISABLED = True

log = logging.getLogger("xyzo.auto_categorize")

# Cache of source_id → {lat, lng, geocoded_location, country, name}
# Loaded once per run() call to avoid per-article DB hits.
_source_cache: dict[int, dict] = {}

# Cache of source_id → {top_cities, top_countries, primary_city_id}
# Loaded from news_source_geography table.
_source_geo_cache: dict[int, dict] = {}

# Country mentions in text → ISO code. Used to detect when an article
# is clearly about a different country than where it was geolocated.
# Matches demonym forms too (e.g. "Chinese" → CN, "Korean" → KR).
_COUNTRY_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r'\b(?:china|chinese|beijing|shanghai|hong\s*kong|tibet|xinjiang|taiwan)\b', re.I), 'CN'),
    (re.compile(r'\b(?:korea|korean|seoul|busan|pyongyang|north\s+korea|south\s+korea)\b', re.I), 'KR'),
    (re.compile(r'\b(?:japan|japanese|tokyo|osaka)\b', re.I), 'JP'),
    (re.compile(r'\b(?:india|indian|delhi|mumbai|bangalore)\b', re.I), 'IN'),
    (re.compile(r'\b(?:pakistan|pakistani|karachi|lahore|islamabad)\b', re.I), 'PK'),
    (re.compile(r'\b(?:germany|german|berlin|munich|hamburg)\b', re.I), 'DE'),
    (re.compile(r'\b(?:france|french|paris|marseille)\b', re.I), 'FR'),
    (re.compile(r'\b(?:united\s+states|usa|american|washington|new\s+york|california|texas)\b', re.I), 'US'),
    (re.compile(r'\b(?:united\s+kingdom|british|london|england|scotland)\b', re.I), 'GB'),
    (re.compile(r'\b(?:russia|russian|kremlin)\b', re.I), 'RU'),
    (re.compile(r'\b(?:ukraine|ukrainian|kyiv|kiev)\b', re.I), 'UA'),
    (re.compile(r'\b(?:brazil|brazilian|brasilia|rio|sao\s+paulo)\b', re.I), 'BR'),
    (re.compile(r'\b(?:australia|australian|sydney|melbourne|canberra)\b', re.I), 'AU'),
    (re.compile(r'\b(?:canada|canadian|toronto|ottawa|vancouver)\b', re.I), 'CA'),
    (re.compile(r'\b(?:mexico|mexican|cdmx|guadalajara)\b', re.I), 'MX'),
    (re.compile(r'\b(?:turkey|turkish|istanbul|ankara)\b', re.I), 'TR'),
    (re.compile(r'\b(?:iran|iranian|tehran)\b', re.I), 'IR'),
    (re.compile(r'\b(?:israel|israeli|tel\s+aviv|jerusalem)\b', re.I), 'IL'),
    (re.compile(r'\b(?:egypt|egyptian|cairo)\b', re.I), 'EG'),
    (re.compile(r'\b(?:nigeria|nigerian|lagos|abuja)\b', re.I), 'NG'),
    (re.compile(r'\b(?:south\s+africa|south\s+african|johannesburg|cape\s+town|pretoria)\b', re.I), 'ZA'),
    (re.compile(r'\b(?:indonesia|indonesian|jakarta|bali)\b', re.I), 'ID'),
    (re.compile(r'\b(?:philippines|filipino|manila|cebu)\b', re.I), 'PH'),
    (re.compile(r'\b(?:thailand|thai|bangkok)\b', re.I), 'TH'),
    (re.compile(r'\b(?:vietnam|vietnamese|hanoi|ho\s+chi\s+minh)\b', re.I), 'VN'),
    (re.compile(r'\b(?:saudi|riyadh|jeddah|mecca)\b', re.I), 'SA'),
    (re.compile(r'\b(?:uae|emirati|dubai|abu\s+dhabi)\b', re.I), 'AE'),
    (re.compile(r'\b(?:argentina|argentinian|buenos\s+aires)\b', re.I), 'AR'),
    (re.compile(r'\b(?:colombia|colombian|bogota)\b', re.I), 'CO'),
    (re.compile(r'\b(?:kenya|kenyan|nairobi)\b', re.I), 'KE'),
    (re.compile(r'\b(?:bangladesh|bangladeshi|dhaka)\b', re.I), 'BD'),
    (re.compile(r'\b(?:malaysia|malaysian|kuala\s+lumpur)\b', re.I), 'MY'),
    (re.compile(r'\b(?:singapore|singaporean)\b', re.I), 'SG'),
    (re.compile(r'\b(?:new\s+zealand|kiwi|auckland|wellington)\b', re.I), 'NZ'),
    (re.compile(r'\b(?:chile|chilean|santiago)\b', re.I), 'CL'),
    (re.compile(r'\b(?:spain|spanish|madrid|barcelona)\b', re.I), 'ES'),
    (re.compile(r'\b(?:italy|italian|rome|milan)\b', re.I), 'IT'),
    (re.compile(r'\b(?:netherlands|dutch|amsterdam)\b', re.I), 'NL'),
    (re.compile(r'\b(?:sweden|swedish|stockholm)\b', re.I), 'SE'),
    (re.compile(r'\b(?:poland|polish|warsaw)\b', re.I), 'PL'),
    (re.compile(r'\b(?:switzerland|swiss|zurich|geneva)\b', re.I), 'CH'),
    (re.compile(r'\b(?:norway|norwegian|oslo)\b', re.I), 'NO'),
    (re.compile(r'\b(?:peru|peruvian|lima)\b', re.I), 'PE'),
    (re.compile(r'\b(?:greece|greek|athens)\b', re.I), 'GR'),
    (re.compile(r'\b(?:portugal|portuguese|lisbon)\b', re.I), 'PT'),
    (re.compile(r'\b(?:ireland|irish|dublin)\b', re.I), 'IE'),
    (re.compile(r'\b(?:austria|austrian|vienna)\b', re.I), 'AT'),
    (re.compile(r'\b(?:denmark|danish|copenhagen)\b', re.I), 'DK'),
    (re.compile(r'\b(?:finland|finnish|helsinki)\b', re.I), 'FI'),
    (re.compile(r'\b(?:fiji|fijian|fijians|suva|lautoka)\b', re.I), 'FJ'),
    (re.compile(r'\b(?:papua new guinea|papua|papuan|png|port moresby)\b', re.I), 'PG'),
    (re.compile(r'\b(?:solomon islands|solomon|solomon island|honiara|guadalcanal)\b', re.I), 'SB'),
    (re.compile(r'\b(?:vanuatu|vanuatu\'s|port vila|efate)\b', re.I), 'VU'),
    (re.compile(r'\b(?:samoa|samoan|samoa\'s|apia)\b', re.I), 'WS'),
    (re.compile(r'\b(?:tonga|tongan|tonga\'s|nukualofa)\b', re.I), 'TO'),
    (re.compile(r'\b(?:cook islands|cook island|rarotonga)\b', re.I), 'CK'),
    (re.compile(r'\b(?:kiribati|kiribati\'s|tarawa|banaba)\b', re.I), 'KI'),
    (re.compile(r'\b(?:tuvalu|tuvaluan|funafuti)\b', re.I), 'TV'),
    (re.compile(r'\b(?:nauru|nauruan|nauru\'s)\b', re.I), 'NR'),
    (re.compile(r'\b(?:micronesia|federated states|palikir|pohnpei)\b', re.I), 'FM'),
    (re.compile(r'\b(?:marshall islands|marshallese|majuro|kwajalein)\b', re.I), 'MH'),
    (re.compile(r'\b(?:palau|palaun|melekkok|ngerulmud)\b', re.I), 'PW'),
    (re.compile(r'\b(?:pina|pacnews)\b', re.I), 'FJ'),
]

# Expected languages per country (mirrors city_anomaly_detector.COUNTRY_LANGUAGES)
_COUNTRY_LANGUAGES: dict[str, set[str]] = {
    "US": {"en"}, "GB": {"en"}, "AU": {"en"}, "CA": {"en", "fr"}, "NZ": {"en"},
    "AT": {"de"}, "DE": {"de"}, "CH": {"de"}, "LI": {"de"},
    "ES": {"es", "ca", "gl", "eu"}, "MX": {"es"}, "AR": {"es"}, "CO": {"es"},
    "CL": {"es"}, "PE": {"es"}, "VE": {"es"}, "EC": {"es"}, "GT": {"es"},
    "CU": {"es"}, "BO": {"es"}, "DO": {"es"}, "HN": {"es"}, "PY": {"es"},
    "SV": {"es"}, "NI": {"es"}, "CR": {"es"}, "PA": {"es"}, "UY": {"es"},
    "BR": {"pt"}, "PT": {"pt"},
    "FR": {"fr"},
    "IT": {"it"},
    "NL": {"nl"},
    "RU": {"ru"}, "UA": {"uk", "ru"}, "PL": {"pl"},
    "HR": {"hr"}, "RS": {"sr"}, "BA": {"bs", "hr", "sr"}, "ME": {"sr", "me"},
    "XK": {"sq", "sr"}, "MK": {"mk"}, "SI": {"sl"},
    "MA": {"ar", "fr"}, "DZ": {"ar", "fr"}, "TN": {"ar", "fr"}, "EG": {"ar"},
    "SA": {"ar"}, "AE": {"ar", "en"},
    "PK": {"ur", "en"}, "IN": {"hi", "en"},
    "CN": {"zh"}, "JP": {"ja"}, "KR": {"ko"},
    "PH": {"en", "tl", "fil"},
    "AZ": {"az", "ru"},
}


def _detect_country_mentions(text: str) -> set[str]:
    """Extract country ISO codes mentioned in text (names, demonyms, capitals)."""
    codes = set()
    for pattern, code in _COUNTRY_PATTERNS:
        if pattern.search(text):
            codes.add(code)
    return codes


US_STATE_NAMES = {
    'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California',
    'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware', 'FL': 'Florida', 'GA': 'Georgia',
    'HI': 'Hawaii', 'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa',
    'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland',
    'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi', 'MO': 'Missouri',
    'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey',
    'NM': 'New Mexico', 'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio',
    'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina',
    'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont',
    'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming'
}


def _validate_source_distance_and_state(src: dict | None, primary: dict | None, text: str) -> tuple[bool, str]:
    """Validate that a candidate city is not a distant false-positive match from a local source.

    If source has lat/lng coordinates and candidate city is > 250km away in a different state/province,
    require article text to explicitly mention the candidate city's state/region (e.g. 'Illinois' or 'IL').
    """
    if not src or not primary:
        return True, "ok"

    src_lat = src.get("lat")
    src_lng = src.get("lng")
    city_lat = primary.get("lat")
    city_lng = primary.get("lng")
    if src_lat is None or src_lng is None or city_lat is None or city_lng is None:
        return True, "ok"

    dist_km = _haversine(float(src_lat), float(src_lng), float(city_lat), float(city_lng))
    if dist_km <= 250:
        return True, "within_local_radius"

    country_code = (primary.get("country_code") or "").upper()
    state_code = (primary.get("state_name") or "").upper()

    # Check US state context requirement
    if country_code == "US" and state_code:
        full_state = US_STATE_NAMES.get(state_code, "")
        patterns = [
            rf"\b{re.escape(state_code)}\b",
            rf"\b{re.escape(primary.get('name', ''))},\s*{re.escape(state_code)}\b"
        ]
        if full_state:
            patterns.append(rf"\b{re.escape(full_state)}\b")

        has_state_context = any(re.search(pat, text, re.IGNORECASE) for pat in patterns)
        if not has_state_context:
            return False, f"distant_source_mismatch: city={primary.get('name')},{state_code} is {int(dist_km)}km from source {src.get('name')} without state context"

    return True, "ok"


def _load_source_cache() -> dict[int, dict]:
    """Load lat/lng for all active sources into a dict keyed by source_id."""
    global _source_cache
    if _source_cache:
        return _source_cache
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, country, region, lat, lng, geocoded_location,
                   primary_city_id, primary_city_confidence, secondary_city_id
            FROM news_sources
            WHERE active = true
        """)
        for row in cur.fetchall():
            _source_cache[row["id"]] = row
    log.info("source geo cache loaded: %d sources", len(_source_cache))
    return _source_cache


def _load_source_geo_cache() -> dict[int, dict]:
    """Load source geography profiles from news_source_geography.

    This includes top_cities and top_countries which are used as
    fallback when an article can't be geolocated from text.
    """
    global _source_geo_cache
    if _source_geo_cache:
        return _source_geo_cache

    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT source_id, top_cities, top_countries,
                       primary_city_id, secondary_city_id,
                       article_count_30d, content_article_count_30d
                FROM news_source_geography
                WHERE article_count_30d > 0
            """)
            for row in cur.fetchall():
                _source_geo_cache[row["source_id"]] = {
                    "top_cities": row["top_cities"] or [],
                    "top_countries": row["top_countries"] or [],
                    "primary_city_id": row["primary_city_id"],
                    "secondary_city_id": row["secondary_city_id"],
                    "article_count_30d": row["article_count_30d"] or 0,
                    "content_article_count_30d": row["content_article_count_30d"] or 0,
                }
        log.info("source geo profile cache loaded: %d sources", len(_source_geo_cache))
    except Exception as e:
        log.warning("could not load source geo cache: %s", e)

    return _source_geo_cache


def _get_source_profile_city(source_id: int, source_country: str | None) -> dict | None:
    """Get the top city from a source's geographic profile.

    Uses the source's computed top_cities from news_source_geography.
    Falls back to primary_city_id from news_sources if no profile exists.

    Returns a city dict with id, name, country_code, lat, lng, population
    or None if no city can be determined.
    """
    geo_cache = _load_source_geo_cache()
    geo = geo_cache.get(source_id)

    if geo and geo.get("top_cities"):
        top_cities = geo["top_cities"]
        if top_cities and len(top_cities) > 0:
            primary = top_cities[0]
            city_id = primary.get("city_id")

            if city_id:
                # top_cities[].city_id comes from source_profiles.py, which
                # SELECTs l.id FROM news_locations — so resolve it against
                # news_locations, NOT world_cities. (IDs collide across the
                # two tables: news_locations 8585 is "Cupertino, AZ",
                # world_cities 8585 is "Kajansi, UG".)
                try:
                    with connect() as conn, conn.cursor() as cur:
                        cur.execute("""
                            SELECT id, place_name, country, lat, lng
                            FROM news_locations
                            WHERE id = %s
                        """, (city_id,))
                        row = cur.fetchone()
                        if row:
                            expected = (primary.get("place_name") or "").strip().lower()
                            actual = (row["place_name"] or "").strip().lower()
                            if expected and actual and expected != actual:
                                log.warning(
                                    "source profile city_id %s mismatch: profile says %r, "
                                    "news_locations has %r — ignoring profile city",
                                    city_id, primary.get("place_name"), row["place_name"],
                                )
                            else:
                                return {
                                    "id": row["id"],
                                    "name": row["place_name"],
                                    "ascii_name": (row["place_name"] or "").lower(),
                                    "country_code": (row.get("country") or "")[:2].upper() or None,
                                    "state_name": None,
                                    "lat": float(row["lat"]),
                                    "lng": float(row["lng"]),
                                    "population": 0,
                                }
                except Exception as e:
                    log.debug("failed to fetch city details for %s: %s", city_id, e)

            # If we have the city data embedded (from top_cities JSON)
            if primary.get("lat") and primary.get("lng"):
                return {
                    "id": city_id,
                    "name": primary.get("place_name"),
                    "country_code": primary.get("country_code"),
                    "population": primary.get("article_count", 0) * 1000,  # rough estimate
                }

    # Fallback to primary_city_id from news_sources
    source_cache = _load_source_cache()
    src = source_cache.get(source_id)
    if src and src.get("primary_city_id"):
        try:
            with connect() as conn, conn.cursor() as cur:
                cur.execute("""
                    SELECT id, name, ascii_name, country_code,
                           state_name, lat, lng, population
                    FROM world_cities
                    WHERE id = %s
                """, (src["primary_city_id"],))
                row = cur.fetchone()
                if row:
                    return {
                        "id": row["id"],
                        "name": row["name"],
                        "ascii_name": (row.get("ascii_name") or row["name"] or "").lower(),
                        "country_code": row["country_code"],
                        "state_name": row.get("state_name"),
                        "lat": float(row["lat"]),
                        "lng": float(row["lng"]),
                        "population": row.get("population") or 0,
                    }
        except Exception as e:
            log.debug("failed to fetch primary_city for source %s: %s", source_id, e)

    return None


# ── Source geography consistency ──────────────────────────────────────
# "One city for every article the fast path could not place" is only
# defensible when the source genuinely publishes from that country.
# When it does not, the source's ENTIRE output collapses onto a single
# capital and the map lies:
#
#   • dev.to ("DEV Community", seeded with country=ML) → 12.4k posts on
#     Bamako, Mali — a programming blog with no geography at all.
#   • 141 MENA sources seeded with country="ME" ("Middle East") → the
#     2-letter code is ISO **Montenegro** → 41k stories on Podgorica.
#   • Pan-Arab papers tagged country=GB → 6k stories on Belfast.
#
# The evidence is the source's own 30-day geographic profile, computed
# from CONTENT placements only: how much of what the source publishes
# actually lands in the country it claims to publish from. A source with
# no centre of gravity in its own country (a global platform, a
# pan-regional wire, a mis-tagged source) gets no single-city fallback.
#
# Either way the article is left UNLOCATED (the AI pass may still place
# it) instead of being pinned to a capital the story is not about.
#
# The threshold is deliberately low: a national paper with a world
# audience (Infobae Argentina: 29% of its stories are Argentine) still
# gets its newsroom attribution, while a MIS-TAGGED source (country=ML
# for dev.to, country=AF for a Malinese paper) has ~0% and is refused.
MIN_PROFILE_COUNTRY_SHARE = 0.10

# Country codes that are NOT countries. "ME" is ISO Montenegro, but the
# source catalogue uses it for "Middle East" (region MENA) — the single
# most common mis-tag in the fleet. "UN"/"EU" are organisations.
PSEUDO_COUNTRY_CODES = {"UN", "EU", "GLOBAL", "WW", "ZZ"}
MENA_REGIONS = {"mena", "middle east", "middle-east", "mideast", "north africa"}


def _source_geo_is_country_specific(source_id: int, source_country: str | None,
                                     source_region: str | None = None) -> tuple[bool, str]:
    """May this source's articles be pinned to a single city of its country?

    Returns (ok, reason). ``ok`` is False when a single-city fallback
    would invent a location the stories are not about — the caller then
    leaves the article unlocated instead.

    A missing profile is treated as "country-specific" so that brand new
    sources keep the historical behaviour until we have data about them.
    """
    cc = (source_country or "").strip().upper()
    region = (source_region or "").strip().lower()

    if not cc:
        return False, "source has no country"

    if cc in PSEUDO_COUNTRY_CODES:
        return False, f"country code {cc} is not a country"
    if cc == "ME" and region in MENA_REGIONS:
        return False, "country 'ME' means Middle East here, not Montenegro"

    geo = _load_source_geo_cache().get(source_id)
    if not geo or not geo.get("top_countries"):
        return True, "no geographic profile — assume country-specific"

    # The profile's city/country breakdown is computed from CONTENT
    # placements only (source_profiles.py), so the denominator has to be
    # the content count too — otherwise a source that pins 90% of its
    # output to one capital looks like a well-spread source.
    total = int(geo.get("content_article_count_30d") or 0) or int(geo.get("article_count_30d") or 0)
    own = sum(int(c.get("article_count") or 0)
              for c in geo["top_countries"]
              if (c.get("country_code") or "").strip().upper() == cc)

    if total > 0:
        share = own / total
        if share < MIN_PROFILE_COUNTRY_SHARE:
            return False, (f"only {share:.0%} of its own-text articles are in {cc} "
                           f"— no single-country centre of gravity")
    return True, f"{own}/{total} of its own-text articles are in {cc}"


def store_article_cities(article_id: int, title: str, body: str = None,
                         lang: str | None = None, conn=None) -> int:
    """Detect and store city mentions for an article.

    Uses cities_text.find_cities_in_text() to detect cities in the
    title + first 500 chars of body, then stores them in the
    news_article_cities junction table.

    If `lang` is provided, searches multilingual city names first.

    Returns the number of cities detected.
    """
    text = f"{title or ''} {body or ''}"[:1000]
    if len(text.strip()) < 5:
        return 0

    matches = cities_text.find_cities_in_text(text, lang=lang, min_population=100_000)
    if not matches:
        return 0

    # Dedupe by city id, keep highest population
    seen: dict[int, dict] = {}
    for m in matches:
        city = m.get("city") or {}
        city_id = city.get("id")
        if not city_id:
            continue
        if city_id not in seen or (city.get("population") or 0) > (seen[city_id].get("population") or 0):
            seen[city_id] = city

    if not seen:
        return 0

    # Determine primary (highest population)
    primary_id = max(seen.keys(), key=lambda cid: seen[cid].get("population") or 0)

    def _execute_store(cur):
        cur.execute("DELETE FROM news_article_cities WHERE article_id = %s", (article_id,))
        for city_id, city in seen.items():
            pop = city.get("population") or 0
            is_primary = (city_id == primary_id)
            confidence = "high" if pop >= 1_000_000 else "medium" if pop >= 250_000 else "low"

            cur.execute("""
                INSERT INTO news_article_cities (article_id, city_id, mention_count, is_primary, confidence)
                VALUES (%s, %s, 1, %s, %s)
                ON CONFLICT (article_id, city_id) DO UPDATE
                    SET mention_count = EXCLUDED.mention_count,
                        is_primary = EXCLUDED.is_primary,
                        confidence = EXCLUDED.confidence
            """, (article_id, city_id, is_primary, confidence))

    if conn is not None:
        with conn.cursor() as cur:
            _execute_store(cur)
    else:
        with connect() as conn_obj, conn_obj.cursor() as cur:
            _execute_store(cur)

    log.debug("stored %d city mentions for article %s", len(seen), article_id)
    return len(seen)


def _nearest_city(lat: float, lng: float, country_hint: str | None = None) -> dict | None:
    """Find the nearest world-city to (lat, lng), optionally filtered by country.

    Returns a dict with the city row and distance in km, or None if nothing
    is found within 150 km.
    """
    lat_pad = max(2.0, abs(lat) * 0.1 + 2)
    lng_pad = max(2.0, abs(lng) * 0.1 + 2)

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, ascii_name, country_code, state_name,
                   lat, lng, population
            FROM world_cities
            WHERE lat BETWEEN %s AND %s
              AND lng BETWEEN %s AND %s
              AND population >= 50000
            ORDER BY population DESC
            LIMIT 30
        """, (lat - lat_pad, lat + lat_pad, lng - lng_pad, lng + lng_pad))
        rows = cur.fetchall()

    best = None
    best_dist = 99999
    hint = (country_hint or "").strip().upper() or None
    for row in rows:
        # A source-based anchor must stay in the source's own country.
        # "La Hora" (Guatemala) once geocoded to Ho (Ghana) and dragged
        # every Guatemalan story to West Africa.
        if hint and (row.get("country_code") or "").upper() != hint:
            continue
        d = _haversine(lat, lng, float(row["lat"]), float(row["lng"]))
        if d < best_dist:
            best_dist = d
            best = row

    if best is None or best_dist > 150:
        return None

    return {
        "city": {
            "id": best["id"],
            "name": best["name"],
            "ascii_name": (best.get("ascii_name") or best["name"] or "").lower(),
            "country_code": best.get("country_code"),
            "state_name": best.get("state_name"),
            "lat": float(best["lat"]),
            "lng": float(best["lng"]),
            "population": best.get("population") or 0,
        },
        "dist_km": best_dist,
    }


def _source_fallback(article: dict) -> dict | None:
    """When no city is found in title+opening, try harder before using source HQ.

    Resolution order:
      1. Scan FULL article body for city mentions (the _decide fast-path
         only scans the first 2000 chars — some articles bury the city
         deep in the text).
      2. Try wiki_geo keyword matching (gazetteer → entity_locations →
         world_cities → wiki_articles full-text search).
      3. Fall back to source's geocoded position (the old behaviour).

    Returns a decision dict (same shape as _decide()) or None.
    """
    title = article.get("title") or ""
    body = article.get("body") or ""
    source_id = article.get("source_id")
    article_id = article.get("id")

    cache = _load_source_cache()
    src = cache.get(source_id) if source_id else None
    source_country = (src.get("country") or "").upper() if src else None

    # ── Pass 1: full-body city scan ─────────────────────────────────
    # The _decide() fast-path only scans title + first 2000 chars.
    # Some articles mention a city only in later paragraphs.
    full_text = f"{title}\n{body}"
    detected_lang = article.get("detected_lang")
    full_stats = cities_text.stats(full_text, lang=detected_lang)
    primary = full_stats.get("primary")
    all_cities = full_stats.get("cities") or []

    if primary:
        # If we found a city in the full body, use it — but prefer
        # cities in the source's country (domestic news is more likely).
        best = primary
        if source_country and len(all_cities) > 1:
            for c in all_cities:
                if (c.get("country_code") or "").upper() == source_country:
                    if (c.get("population") or 0) >= (best.get("population") or 0) * 0.3:
                        best = c
                        break

        # ── Cross-country validation (same rules as _decide) ────────
        # If the detected city is in a different country than the source,
        # AND the text does NOT mention the city's country, reject it.
        city_country = (best.get("country_code") or "").upper() if best else ""
        if source_country and city_country and source_country != city_country:
            mentioned = _detect_country_mentions(f"{title}\n{body[:1500]}")
            if city_country not in mentioned:
                log.info(
                    "source-fallback cross-country: article %s from %s placed in %s/%s but text doesn't mention %s — rejecting",
                    article_id, source_country,
                    best.get("name") if best else "?", city_country, city_country,
                )
                best = None

        # Place-disambiguation: reject ambiguous names without context
        if best:
            try:
                from .place_disambiguation import disambiguate
                keep, reason = disambiguate(
                    best.get("name") or "",
                    f"{title}\n{body[:2000]}",
                    source_country=source_country,
                )
                if not keep:
                    log.info("source-fallback disambig: article %s place %r dropped (%s)",
                             article_id, best.get("name"), reason)
                    # Don't return here — fall through to wiki_geo / source coords
                    best = None
            except Exception:
                pass

        if best:
            pop = best.get("population") or 0
            category = classify.classify(title, body[:1500])
            confidence = "high" if pop >= HIGH_CONF_MIN_POP else "medium" if pop >= MED_CONF_MIN_POP else "low"
            log.info("source-fallback: article %s found city %s in full body scan",
                     article_id, best.get("name"))
            return {
                "status": confidence,
                "confidence": confidence,
                "city": best,
                "category": category if category and category != "other" else None,
                "reason": f"full-body city scan: {best.get('name')}",
            }

    # ── Pass 2: wiki_geo keyword matching ───────────────────────────
    # Extract keywords from title + body and try to resolve them to
    # specific places via gazetteer / entity_locations / world_cities /
    # wiki_articles.  This catches articles about specific places that
    # aren't in the world_cities list (landmarks, districts, etc.).
    try:
        from . import wiki_geo
        word_freq = article.get("word_freq")
        result = wiki_geo.geolocate_article(
            article_id or 0,
            word_freq=word_freq,
            title=title,
            body=body[:2000],
            country_hint=source_country,
        )
        if result:
            category = classify.classify(title, body[:1500])
            synthetic_city = {
                "id": None,
                "name": result["place_name"],
                "ascii_name": result["place_name"].lower(),
                "country_code": result.get("country_code") or source_country or None,
                "state_name": None,
                "lat": result["lat"],
                "lng": result["lng"],
                "population": result.get("population") or 0,
            }
            log.info("source-fallback: article %s wiki_geo → %s (%.4f, %.4f) via %s",
                     article_id, result["place_name"],
                     result["lat"], result["lng"], result["source"])
            return {
                "status": "medium",
                "confidence": "medium" if result["source"] in ("gazetteer", "world_cities") else "low",
                "city": synthetic_city,
                "category": category if category and category != "other" else None,
                "reason": f"wiki_geo: {result['keyword']} → {result['place_name']} ({result['source']})",
            }
    except Exception as e:
        log.debug("wiki_geo failed for article %s: %s", article_id, e)

    # ── Pass 2b: source's geographic profile (top cities) ─────────────
    # Use the source's computed top cities from news_source_geography.
    # This is more accurate than just using the source's HQ coordinates
    # because it reflects WHERE the source actually reports from.
    #
    # GATE: only sources whose geography really is their own country may
    # use a single-city fallback. Otherwise their whole output collapses
    # onto one capital (12.4k dev.to posts on Bamako, 41k MENA stories on
    # Podgorica) — see _source_geo_is_country_specific().
    country_specific, why = _source_geo_is_country_specific(
        source_id, source_country, (src or {}).get("region") if src else None)
    if not country_specific:
        log.info("source-fallback: article %s from %s left unlocated — %s",
                 article_id, (src or {}).get("name") or source_id, why)
        return None

    if source_id:
        profile_city = _get_source_profile_city(source_id, source_country)
        # A source-based fallback must stay in the source's own country.
        # Cross-country profile tops (stale data, 2-article flukes, bad
        # geo profiles) are how Azerbaijani stories landed in Kajansi,
        # Uganda — reject them and fall through to nearest/largest/capital.
        if profile_city and source_country:
            pc_country = (profile_city.get("country_code") or "").upper()
            if pc_country and pc_country != source_country:
                log.info("source-fallback: article %s rejected profile city %s/%s "
                         "(source country is %s)", article_id,
                         profile_city.get("name"), pc_country, source_country)
                profile_city = None
        if profile_city:
            category = classify.classify(title, body[:1500])
            log.info("source-fallback: article %s using profile city %s for source_id=%s",
                     article_id, profile_city.get("name"), source_id)
            return {
                "status": "source_based",
                "confidence": "source_based",
                "city": profile_city,
                "category": category if category and category != "other" else None,
                "reason": f"source profile: {profile_city.get('name')} (top city for source)",
            }

    # ── Pass 3: source's own coordinates → nearest city ───────────────
    # Use the source's geocoded lat/lng as the anchor. This is the most
    # reliable position (from Nominatim or prior geocoding). Then find the
    # nearest world-city to those coordinates to get the city name/id.
    # Previously this used primary_city_id which could point to a different
    # city than where the source is actually geolocated (e.g. Nigerian
    # sources geocoded to Abuja but with primary_city_id=Lagos).
    has_src_coords = bool(src and src.get("lat") is not None and src.get("lng") is not None)
    location_label = (src.get("geocoded_location") or f"{src.get('name')}, {src.get('country') or ''}") if src else ""
    category = classify.classify(title, body[:1500])

    if has_src_coords:
        src_lat = float(src["lat"])
        src_lng = float(src["lng"])
        try:
            nearest = _nearest_city(src_lat, src_lng, src.get("country"))
            if nearest:
                # FIX_NOTES 1.8: _nearest_city returns {"city": {...}, "dist_km": ..}
                # — this logged nearest["name"] → KeyError swallowed by the
                # outer except AFTER a successful lookup, so "nearest city to
                # source coords" NEVER applied and everything degraded to
                # largest-city-in-country.
                log.info("source-fallback: article %s using nearest city %s (%.0f km) for source %s",
                         article_id, nearest["city"]["name"], nearest["dist_km"], src.get("name"))
                return {
                    "status": "source_based",
                    "confidence": "source_based",
                    "city": nearest["city"],
                    "category": category if category and category != "other" else None,
                    "reason": f"source geocode: {nearest['city']['name']} ({nearest['dist_km']:.0f} km)",
                    "_source_location": f"{nearest['city']['name']}, {src.get('country') or nearest['city'].get('country_code') or ''}".strip().strip(','),
                }
        except Exception as e:
            log.debug("nearest-city lookup failed for source %s: %s", source_id, e)

    # 3b: Fall back to largest city in source's country
    if source_country:
        try:
            from . import wiki_geo
            largest = wiki_geo.get_largest_cities(source_country, limit=5)
            if largest:
                best_city = largest[0]
                synthetic_city = {
                    "id": None,
                    "name": best_city["name"],
                    "ascii_name": (best_city.get("ascii_name") or best_city["name"]).lower(),
                    "country_code": source_country,
                    "state_name": best_city.get("state_name"),
                    "lat": float(best_city["lat"]),
                    "lng": float(best_city["lng"]),
                    "population": best_city.get("population") or 0,
                }
                log.info("source-fallback: article %s using largest city %s (no affinity) for source %s",
                         article_id, best_city["name"], src.get("name"))
                return {
                    "status": "source_based",
                    "confidence": "source_based",
                    "city": synthetic_city,
                    "category": category if category and category != "other" else None,
                    "reason": f"largest city in {source_country}: {best_city['name']}",
                    "_source_location": f"{best_city['name']}, {source_country}",
                }
        except Exception as e:
            log.debug("largest-city lookup failed for %s: %s", source_country, e)

    # 3c: Last resort — source's exact geocoded position, but ONLY if
    # that position is actually in/near a town. Five national German
    # papers once sat 30 km from any city on a mediumwave transmitter
    # ("Sender Europe 1") and their fallback stories peppered farmland.
    # Rural anchors get replaced by the country capital when known;
    # otherwise the article stays unlocated for the AI pass.
    from .density import _snap_to_major_city  # local import: avoid cycle
    try:
        if not has_src_coords:
            near = None
        else:
            near = _snap_to_major_city(float(src["lat"]), float(src["lng"]), min_pop=25_000)
    except Exception:
        near = None
    if not near or (near.get("dist_km") or 999) > 25:
        from .geocode_sources import COUNTRY_COORDS
        cc = (src.get("country") or "").strip().upper()
        if cc in COUNTRY_COORDS:
            cap_lat, cap_lng, cap_city = COUNTRY_COORDS[cc]
            log.info("source-fallback: article %s source %s anchor is rural (%s) → capital %s",
                     article_id, src.get("name"), near and f"{near['name']} {near['dist_km']:.0f}km" or "no town within 25km", cap_city)
            synthetic_city = {
                "id": None,
                "name": cap_city,
                "ascii_name": cap_city.lower(),
                "country_code": cc,
                "state_name": None,
                "lat": cap_lat,
                "lng": cap_lng,
                "population": 0,
            }
            return {
                "status": "source_based",
                "confidence": "source_based",
                "city": synthetic_city,
                "category": category if category and category != "other" else None,
                "reason": f"rural source anchor → capital {cap_city}",
                "_source_location": f"{cap_city}, {cc}",
            }
        log.info("source-fallback: article %s source %s anchor is rural and country unknown — leaving unlocated",
                 article_id, src.get("name"))
        return None
    synthetic_city = {
        "id": None,
        "name": src.get("name") or "Unknown",
        "ascii_name": (src.get("name") or "unknown").lower(),
        "country_code": src.get("country"),
        "state_name": None,
        "lat": float(src["lat"]),
        "lng": float(src["lng"]),
        "population": 0,
    }

    return {
        "status": "source_based",
        "confidence": "source_based",
        "city": synthetic_city,
        "category": category if category and category != "other" else None,
        "reason": f"source fallback: {location_label}",
        "_source_location": location_label,
    }

# Population floor for "high" confidence. Same number the JS city engine
# uses for its high-confidence bucket — keeps client + server honest.
HIGH_CONF_MIN_POP = 1_000_000
MED_CONF_MIN_POP = 250_000

# Cap per cycle. Auto-discover passes 0 to drain — we substitute a
# large but finite value so a runaway backlog doesn't lock up the DB.
DEFAULT_BATCH = 2000


def _fetch_pending(limit: int) -> list[dict]:
    """Pending articles that haven't been auto-categorized yet.

    Index-backed: news_articles_auto_cat_pending_idx is a partial btree
    on `auto_categorized_at IS NULL`, so this stays cheap even when the
    table has millions of rows.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, title, body, status, source_id, detected_lang
            FROM news_articles
            WHERE auto_categorized_at IS NULL
              AND status = 'pending'
            ORDER BY fetched_at DESC NULLS LAST
            LIMIT %s
            """,
            (limit,),
        )
        return cur.fetchall()


def _decide(row: dict) -> dict | None:
    """Run cities_text + classify on title+body.

    Returns a dict ready to be passed straight into _record_apply(), or
    None if the row should be left for the AI to handle.

    IMPORTANT: Only scan the title + first 200 chars of the body for
    city detection. This prevents articles that mention a city in passing
    (like "The Perth mum-of-two" in paragraph 5) from being geolocated
    to that city. The city must be prominent in the article's opening.

    CROSS-COUNTRY VALIDATION: If the detected city's country doesn't
    match the source's country AND the title mentions a third country,
    the match is likely wrong (e.g. Korean source about China placed in
    Germany). In that case we reject the city and let the AI handle it.
    """
    title = row.get("title") or ""
    body = row.get("body") or ""
    source_id = row.get("source_id")
    detected_lang = row.get("detected_lang")

    # Pass 1: Scan title + first 500 chars of body for city detection.
    # This catches cities mentioned in the opening paragraphs.
    text = f"{title}\n{body[:500]}"
    if len(text.strip()) < 5:
        return {"status": "no_match", "confidence": None,
                "city": None, "category": None, "reason": "text too short"}

    stats = cities_text.stats(text, lang=detected_lang)
    category = classify.classify(title, body[:1500])

    primary = stats.get("primary")
    primary_pop = primary.get("population") if primary else 0

    # Pass 2: If no city found in opening, scan more of the body.
    # Some articles bury the location deep in the text.
    if not primary and len(body) > 500:
        extended_text = f"{title}\n{body[:2000]}"
        stats = cities_text.stats(extended_text, lang=detected_lang)
        primary = stats.get("primary")
        primary_pop = primary.get("population") if primary else 0
        if primary:
            log.debug("found city in extended body scan: %s", primary.get("name"))

    # No city at all → fast path can't geocode. Mark for AI.
    # Keep category even if "other" so NN classifier can see it and
    # potentially upgrade it. Previously set to None, leaving articles
    # permanently unclassified on the map.
    if not primary:
        return {
            "status": "no_match",
            "confidence": None,
            "city": None,
            "category": category if category else "other",
            "reason": "no city in text",
        }

    # ── Suburb-priority refinement ──────────────────────────────────
    # "Chicago" + headline about Naperville → place in Naperville. The
    # population-max primary selection systematically erases suburb
    # coverage; this moves placement to the named satellite when the
    # headline (or "X suburb" phrasing) is clearly about it.
    try:
        from .suburb_priority import refine as _refine_suburb
        suburb, why = _refine_suburb(primary, title, body)
        if suburb:
            log.info("suburb-priority: article %s %s → %s (%s)",
                     row["id"], primary.get("name"), suburb.get("name"), why)
            primary = suburb
            primary_pop = suburb.get("population") or 0
            stats = dict(stats)
            stats["primary"] = suburb
            stats["primary_label"] = (
                f"{suburb.get('name')}, {suburb.get('country_code')}")
    except Exception as e:
        log.debug("suburb-priority refine failed for %s: %s", row.get("id"), e)

    # ── Cross-country validation ────────────────────────────────────
    # If the detected city is in a different country than the source,
    # AND the text mentions a third country, the placement is likely
    # wrong. Example: Korean source, title mentions "Chinese", city
    # detected as "Berlin" → clearly wrong.
    if source_id and primary:
        cache = _load_source_cache()
        src = cache.get(source_id)
        if src:
            src_country = (src.get("country") or "").upper()
            city_country = (primary.get("country_code") or "").upper()
            if src_country and city_country and src_country != city_country:
                # Check whether city was found in TITLE vs BODY ONLY
                city_in_title = any(
                    primary.get("name", "").lower() in title.lower()
                    or primary.get("ascii_name", "").lower() in title.lower()
                    for _ in [1]
                )

                title_mentioned = _detect_country_mentions(title)
                body_mentioned = _detect_country_mentions(body[:1000])
                mentioned = title_mentioned | body_mentioned

                # Rule A: Body-only city match where title mentions source country or different country
                if not city_in_title and (src_country in title_mentioned or (title_mentioned and city_country not in title_mentioned)):
                    log.info(
                        "cross-country: article %s from %s (%s) placed in body-only city %s/%s but title mentions %s — rejecting",
                        row["id"], src.get("name"), src_country,
                        primary.get("name"), city_country,
                        ",".join(title_mentioned) or src_country,
                    )
                    return {
                        "status": "no_match",
                        "confidence": None,
                        "city": None,
                        "category": category if category else "other",
                        "reason": f"cross-country mismatch: body-only city={city_country}, title mentions={','.join(title_mentioned)}",
                    }

                # Rule B: Generic cross-country mismatch
                # If source and city are in different countries, and the text does NOT
                # explicitly mention the city's country, reject the placement!
                if city_country not in mentioned:
                    log.info(
                        "cross-country: article %s from %s (%s) placed in %s/%s but text does not mention %s — rejecting",
                        row["id"], src.get("name"), src_country,
                        primary.get("name"), city_country, city_country,
                    )
                    return {
                        "status": "no_match",
                        "confidence": None,
                        "city": None,
                        "category": category if category else "other",
                        "reason": f"cross-country mismatch: source={src_country}, city={city_country}, mentioned={','.join(mentioned) or 'none'}",
                    }
                elif src_country in mentioned and city_country not in title_mentioned:
                    # Article mentions source's country in text but not city's country in title -> reject
                    log.info(
                        "cross-country: article %s from %s (%s) placed in %s/%s but text mentions source country %s — rejecting",
                        row["id"], src.get("name"), src_country,
                        primary.get("name"), city_country, src_country,
                    )
                    return {
                        "status": "no_match",
                        "confidence": None,
                        "city": None,
                        "category": category if category else "other",
                        "reason": f"cross-country mismatch: source={src_country}, city={city_country}, text mentions {src_country}",
                    }
                    # else: text mentions the city's country → foreign
                    # correspondent, placement is probably correct.

    # ── Language validation ───────────────────────────────────────────
    # If the source country matches the detected article language
    # (e.g., Austrian/German source + German article), but the matched
    # city is in a country where that language is NOT official (e.g., US
    # city), reject. This catches cases like German articles about
    # "Corona-Pandemie" that get incorrectly placed in Corona, US because
    # "Corona" appears in the body.
    # BUT: If the city country IS explicitly mentioned in the text, allow it
    # (foreign correspondent case).
    if source_id and primary:
        cache = _load_source_cache()
        src = cache.get(source_id)
        if src:
            src_country = (src.get("country") or "").upper()
            city_country = (primary.get("country_code") or "").upper()
            detected_lang = row.get("detected_lang")
            if (
                src_country
                and city_country
                and src_country != city_country
                and detected_lang
                and src_country in _COUNTRY_LANGUAGES
                and city_country in _COUNTRY_LANGUAGES
            ):
                src_langs = _COUNTRY_LANGUAGES.get(src_country, set())
                city_langs = _COUNTRY_LANGUAGES.get(city_country, set())
                if detected_lang in src_langs and detected_lang not in city_langs:
                    # Check if city country is explicitly mentioned in text (foreign correspondent case)
                    title_mentioned = _detect_country_mentions(title)
                    body_mentioned = _detect_country_mentions(body[:1000])
                    mentioned = title_mentioned | body_mentioned
                    if city_country not in mentioned:
                        log.info(
                            "auto-cat lang: article %s lang=%s from %s (%s) placed in %s/%s which expects %s — rejecting",
                            row["id"], detected_lang, src.get("name"), src_country,
                            primary.get("name"), city_country, city_langs,
                        )
                        return {
                            "status": "no_match",
                            "confidence": None,
                            "city": None,
                            "category": category if category else "other",
                            "reason": f"language mismatch: lang={detected_lang}, source={src_country}, city={city_country}",
                        }

    # ── Place-disambiguation watchlist ───────────────────────────────
    # For small ambiguous towns that exist in many countries (Man,
    # Springfield, Cordoba, Memphis, ...), the regex/cities_text match
    # alone isn't enough — Nominatim (and our world-cities index) both
    # silently pick a dominant referent that may not match the article.
    # Drop the match when neither the title nor body mentions a context
    # keyword for the matched town.
    if primary:
        try:
            from .place_disambiguation import disambiguate
            src_country = None
            if source_id:
                cache = _load_source_cache()
                src = cache.get(source_id)
                if src:
                    src_country = (src.get("country") or "").upper()
            keep, reason = disambiguate(
                primary.get("name") or "",
                f"{title}\n{body[:2000]}",
                source_country=src_country,
            )
            if not keep:
                log.info(
                    "auto-cat disambig: article %s place %r dropped (%s)",
                    row.get("id"), primary.get("name"), reason,
                )
                return {
                    "status": "no_match",
                    "confidence": None,
                    "city": None,
                    "category": category if category else "other",
                    "reason": f"disambig:{reason}",
                }
        except Exception:
            pass  # disambiguation is best-effort; never block the fast path

    # City found but category is "other" → we can still geocode but
    # the AI will be better at picking a non-default event_type.
    # Still set auto_categorize_event_type to "other" so the NN
    # classifier can later upgrade it, and so articles aren't invisible
    # on the map (previously set to None, showing as unclassified).
    if category == "other":
        return {
            "status": "medium",
            "confidence": "medium" if primary_pop >= MED_CONF_MIN_POP else "low",
            "city": primary,
            "category": "other",
            "reason": "city found, no category",
        }

    # City + non-"other" category — full fast-path win.
    if primary_pop >= HIGH_CONF_MIN_POP:
        return {
            "status": "high",
            "confidence": "high",
            "city": primary,
            "category": category,
            "reason": "high-pop city + category",
        }
    if primary_pop >= MED_CONF_MIN_POP:
        return {
            "status": "medium",
            "confidence": "medium",
            "city": primary,
            "category": category,
            "reason": "med-pop city + category",
        }
    # Small city. Still useful, but flag low so callers can decide
    # whether to surface on the map.
    return {
        "status": "low",
        "confidence": "low",
        "city": primary,
        "category": category,
        "reason": "small city + category",
    }


def _exec_with_conn(conn, fn):
    if conn is not None:
        with conn.cursor() as cur:
            fn(cur)
    else:
        with connect() as c, c.cursor() as cur:
            fn(cur)


def _record_apply(article_id: int, decision: dict, conn=None) -> None:
    """Write the decision back to news_articles. No-op for AI-only rows."""
    # `_method` is overridable so the NN classifier hook can mark its
    # contributions as 'nn_word_freq' for later auditing.
    method = decision.get("_method", "fast_path")

    if decision["status"] in ("no_match",):
        # Don't set auto_categorized_at — leave the article at status='pending'
        # so extract.py's AI can still claim and process it.  Setting the
        # timestamp would seal the article as "handled" but with no coordinates,
        # leaving it invisible on the map forever (the 108K-article bug
        # discovered 2026-09-29).
        def _exec_no_match(cur):
            cur.execute(
                """
                UPDATE news_articles
                SET auto_categorize_status = 'no_match',
                    auto_categorize_confidence = NULL,
                    auto_categorize_event_type = %s,
                    auto_categorize_method = %s
                WHERE id = %s
                """,
                (decision.get("category"), method, article_id),
            )
        _exec_with_conn(conn, _exec_no_match)
        return

    if decision["status"] == "low" and decision["city"] is None:
        # Same rationale as no_match: leave auto_categorized_at NULL so the
        # AI extractor can pick up these low-confidence/no-city articles.
        def _exec_low(cur):
            cur.execute(
                """
                UPDATE news_articles
                SET auto_categorize_status = 'low',
                    auto_categorize_confidence = NULL,
                    auto_categorize_event_type = NULL,
                    auto_categorize_method = %s
                WHERE id = %s
                """,
                (method, article_id),
            )
        _exec_with_conn(conn, _exec_low)
        return

    # source_based → use source's lat/lng, mark as extracted with lower confidence.
    if decision["status"] == "source_based":
        city = decision["city"]
        category = decision.get("category")
        source_location = decision.get("_source_location") or f"{city.get('name')}"
        location_text = source_location
        summary = ((decision.get("raw_title") or "")[:240]).strip()
        existing_loc_id = find_location_by_coords(city.get("lat"), city.get("lng"))

        def _exec_source(cur):
            cur.execute(
                """
            UPDATE news_articles
            SET location_text = %s,
                extracted_location = %s,
                extracted_lat = %s,
                extracted_lng = %s,
                event_type = COALESCE(%s, event_type, 'news'),
                summary = CASE
                            WHEN summary IS NULL OR summary = '' THEN %s
                            ELSE summary
                          END,
                status = 'extracted',
                extracted_at = now(),
                location_id = %s,
                geocoded_at = CASE WHEN %s::bigint IS NOT NULL THEN now() ELSE NULL END,
                location_confidence = CASE WHEN %s::bigint IS NOT NULL THEN 1.0 ELSE NULL END,
                auto_categorized_at = now(),
                auto_categorize_status = 'source_based',
                    auto_categorize_confidence = 'source_based',
                    auto_categorize_city_id = NULL,
                    auto_categorize_city_label = %s,
                    auto_categorize_event_type = %s,
                    auto_categorize_method = 'source_fallback'
                WHERE id = %s
                """,
                (
                    location_text,                # location_text
                    location_text,                # extracted_location
                    city.get("lat"),              # extracted_lat
                    city.get("lng"),              # extracted_lng
                    category,                     # event_type (nullable)
                    summary,                      # summary fallback
                    existing_loc_id,             # location_id (may be NULL)
                    existing_loc_id,             # geocoded_at
                    existing_loc_id,             # location_confidence
                    source_location,              # auto_categorize_city_label
                    category,                     # auto_categorize_event_type
                    article_id,
                ),
            )
        _exec_with_conn(conn, _exec_source)
        return

    # high / medium / low-with-city → populate fields and bump to extracted.
    city = decision["city"]
    category = decision.get("category")
    location_text = f"{city.get('name')}, {city.get('country_code')}"
    summary = ((decision.get("raw_title") or "")[:240]).strip()
    existing_loc_id = find_location_by_coords(city.get("lat"), city.get("lng"))

    def _exec_main(cur):
        cur.execute(
            """
            UPDATE news_articles
            SET location_text = %s,
                extracted_location = %s,
                extracted_lat = %s,
                extracted_lng = %s,
                event_type = COALESCE(%s, event_type),
                summary = CASE
                            WHEN summary IS NULL OR summary = '' THEN %s
                            ELSE summary
                          END,
                status = 'extracted',
                extracted_at = now(),
                location_id = %s,
                geocoded_at = CASE WHEN %s::bigint IS NOT NULL THEN now() ELSE NULL END,
                location_confidence = CASE WHEN %s::bigint IS NOT NULL THEN 1.0 ELSE NULL END,
                auto_categorized_at = now(),
                auto_categorize_status = %s,
                auto_categorize_confidence = %s,
                auto_categorize_city_id = %s,
                auto_categorize_city_label = %s,
                auto_categorize_event_type = %s,
                auto_categorize_method = %s
            WHERE id = %s
            """,
            (
                location_text,                # location_text
                location_text,                # extracted_location
                city.get("lat"),              # extracted_lat
                city.get("lng"),              # extracted_lng
                category,                     # event_type (nullable)
                summary,                      # summary fallback
                existing_loc_id,             # location_id (may be NULL if no match)
                existing_loc_id,             # geocoded_at
                existing_loc_id,             # location_confidence
                decision["status"],           # auto_categorize_status
                decision.get("confidence"),   # auto_categorize_confidence
                city.get("id"),               # auto_categorize_city_id
                f"{city.get('name')}, {city.get('country_code')}",
                category,                     # auto_categorize_event_type
                method,                       # auto_categorize_method (NN overrides 'fast_path')
                article_id,
            ),
        )
    _exec_with_conn(conn, _exec_main)

    # Store city mentions for this article
    try:
        store_article_cities(article_id, decision.get("raw_title") or "", conn=conn)
    except Exception as e:
        log.debug("failed to store city mentions for article %s: %s", article_id, e)


def _record_no_match(article_id: int, category: str | None, reason: str, conn=None) -> None:
    """Record that an article was skipped (e.g., flood limit).

    Does NOT set auto_categorized_at — the article must remain claimable by
    extract.py's AI so it has a chance to find coordinates.
    """
    def _exec_nm(cur):
        cur.execute(
            """
            UPDATE news_articles
            SET auto_categorize_status = 'no_match',
                auto_categorize_confidence = NULL,
                auto_categorize_event_type = %s,
                auto_categorize_method = 'fast_path',
                error_message = %s
            WHERE id = %s
            """,
            (category, reason, article_id),
        )
    _exec_with_conn(conn, _exec_nm)


# ── NN classifier hook ─────────────────────────────────────────────────────
#
# When the heuristic path can't decide a category (no keyword hit, or
# matches "other"), we ask the trained WordFreqNN model for a second
# opinion. The model is at /data/nn_models/category_classifier/<ver>/
# and produces a category + bucket + confidence per article.
#
# Acceptance rule: accept NN's call when its top-1 confidence >= 0.45
# AND the predicted category isn't "other". The NN model is 79.6% bucket-
# accurate (35 categories, 37k training samples); at 0.45 we're trading
# some precision for much better coverage on the long-tail of articles
# that the keyword-based `classify.classify` misses entirely.
#
# Side effect: when the NN supplies a category, we mark
# auto_categorize_method='nn_word_freq' instead of 'fast_path' so we can
# measure how often the heuristic-vs-NN split actually fires in prod.
_NN_ACCEPT_THRESHOLD = float(os.environ.get("XYZO_NN_ACCEPT_THRESHOLD", "0.45"))


def _nn_classify_batch(articles: list[dict]) -> dict[int, dict]:
    """Run NN classifier over a batch of articles.

    Returns {article_id: {"category": str, "bucket": str, "confidence": float}}
    for articles the NN has a confident-enough prediction for. Articles
    where the NN is below threshold or unavailable are simply absent.
    Defensive: returns {} on any failure so callers degrade gracefully.
    """
    if _NN_CLASSIFIER_DISABLED or get_classifier is None:
        return {}
    if not articles:
        return {}
    try:
        clf = get_classifier()
        results = clf.predict_batch(articles)
    except Exception as e:
        log.warning("nn_classifier.predict_batch failed (degrading to heuristic): %s", e)
        return {}

    out: dict[int, dict] = {}
    for art, pred in zip(articles, results):
        cat = pred.get("category") or ""
        bucket = pred.get("bucket") or ""
        conf = float(pred.get("confidence") or 0.0)
        if not cat or cat == "other" or conf < _NN_ACCEPT_THRESHOLD:
            continue
        out[int(art["id"])] = {
            "category": cat,
            "bucket": bucket,
            "confidence": round(conf, 3),
        }
    return out


def run_batch(limit: int = DEFAULT_BATCH) -> dict:
    """Batch-optimized version of run().

    Uses temp tables for bulk updates - ~10x faster than run() for large batches.
    """
    import time
    t0 = time.time()
    effective_limit = 10_000 if limit == 0 else limit
    pending = _fetch_pending(effective_limit)
    log.info("batch: processing %d articles", len(pending))

    summary = {
        "scanned": len(pending),
        "fast_path_high": 0,
        "fast_path_medium": 0,
        "fast_path_low": 0,
        "source_fallback": 0,
        "nn_word_freq": 0,
        "no_match": 0,
        "needs_ai": 0,
        "flood_blocked": 0,
    }

    flood_counts: dict[tuple[int, int], int] = {}
    FLOOD_LIMIT = 10

    extracted: list[tuple] = []
    no_match_ids: list[int] = []

    for art in pending:
        try:
            decision = _decide(art)
            decision["raw_title"] = art.get("title") or ""

            city = decision.get("city")
            if city and city.get("id"):
                source_id = art.get("source_id") or 0
                city_id = city["id"]
                flood_key = (source_id, city_id)
                current_count = flood_counts.get(flood_key, 0)
                if current_count >= FLOOD_LIMIT:
                    summary["flood_blocked"] += 1
                    no_match_ids.append(art["id"])
                    continue
                flood_counts[flood_key] = current_count + 1

            status = decision.get("status")
            if status in ("high", "medium", "low"):
                if status == "high":
                    summary["fast_path_high"] += 1
                elif status == "medium":
                    summary["fast_path_medium"] += 1
                else:
                    summary["fast_path_low"] += 1
                    summary["needs_ai"] += 1
                extracted.append((art["id"], city, decision.get("category"),
                    (decision.get("raw_title") or "")[:240].strip(), status, decision.get("confidence") or status))
            elif status == "source_based":
                src = _source_fallback(art)
                if src:
                    src["raw_title"] = art.get("title") or ""
                    summary["source_fallback"] += 1
                    extracted.append((art["id"], src.get("city"), src.get("category"),
                        (src.get("raw_title") or "")[:240].strip(), "source_based", "source_based"))
                else:
                    summary["no_match"] += 1
                    no_match_ids.append(art["id"])
            else:
                src_decision = _source_fallback(art)
                if src_decision:
                    src_decision["raw_title"] = art.get("title") or ""
                    summary["source_fallback"] += 1
                    extracted.append((art["id"], src_decision.get("city"), src_decision.get("category"),
                        (src_decision.get("raw_title") or "")[:240].strip(), "source_based", "source_based"))
                else:
                    summary["no_match"] += 1
                    no_match_ids.append(art["id"])
        except Exception as e:
            log.error("batch decide error article %s: %s", art.get("id"), e)
            no_match_ids.append(art["id"])
            summary["no_match"] += 1

    t1 = time.time()
    log.info("batch: decided %d articles in %.1fs", len(extracted) + len(no_match_ids), t1 - t0)

    with connect() as conn, conn.cursor() as cur:
        if extracted:
            # Pre-compute location IDs
            lats = [art[1]["lat"] for art in extracted if art[1] and art[1].get("lat")]
            lngs = [art[1]["lng"] for art in extracted if art[1] and art[1].get("lat")]
            latlng_to_id = {}
            if lats:
                cur.execute("SELECT id, lat, lng FROM news_locations WHERE lat = ANY(%s) AND lng = ANY(%s)", (lats, lngs))
                latlng_to_id = {(row["lat"], row["lng"]): row["id"] for row in cur.fetchall()}

            # Build arrays for bulk UPDATE
            ids_arr = []
            lats_arr = []
            lngs_arr = []
            loc_ids_arr = []
            loc_labels_arr = []
            event_types_arr = []
            summaries_arr = []
            statuses_arr = []
            confidences_arr = []
            city_ids_arr = []
            methods_arr = []

            for article_id, city, category, summary_text, status, confidence in extracted:
                lat = city.get("lat") if city else None
                lng = city.get("lng") if city else None
                loc_id = latlng_to_id.get((lat, lng)) if lat and lng else None
                loc_label = f"{city['name']}, {city['country_code']}" if city else None
                city_id = city.get("id") if city else None
                method = "source_fallback" if status == "source_based" else "fast_path"

                ids_arr.append(article_id)
                lats_arr.append(lat)
                lngs_arr.append(lng)
                loc_ids_arr.append(loc_id)
                loc_labels_arr.append(loc_label)
                event_types_arr.append(category)
                summaries_arr.append(summary_text)
                statuses_arr.append(status)
                confidences_arr.append(confidence)
                city_ids_arr.append(city_id)
                methods_arr.append(method)

            # Use temp table for fast bulk UPDATE
            cur.execute("""
                CREATE TEMP TABLE batch_update (
                    id bigint PRIMARY KEY,
                    lat float, lng float,
                    loc_id bigint, loc_label text,
                    event_type text, summary text,
                    status text, confidence text,
                    city_id bigint, method text
                )
            """)
            
            # Use unnest to insert all rows at once
            if extracted:
                arr_id = [a[0] for a in extracted]
                arr_lat = [a[1].get("lat") if a[1] else None for a in extracted]
                arr_lng = [a[1].get("lng") if a[1] else None for a in extracted]
                arr_loc_id = [latlng_to_id.get((a[1].get("lat"), a[1].get("lng"))) if a[1] and a[1].get("lat") else None for a in extracted]
                arr_loc_label = [f"{a[1]['name']}, {a[1]['country_code']}" if a[1] else None for a in extracted]
                arr_event = [a[2] for a in extracted]
                arr_summary = [a[3] for a in extracted]
                arr_status = [a[4] for a in extracted]
                arr_conf = [a[5] for a in extracted]
                arr_city_id = [a[1].get("id") if a[1] else None for a in extracted]
                arr_method = ["source_fallback" if a[4] == "source_based" else "fast_path" for a in extracted]
                
                cur.execute("""
                    INSERT INTO batch_update
                    SELECT * FROM unnest(%s::bigint[], %s::float[], %s::float[], %s::bigint[], %s::text[],
                                %s::text[], %s::text[], %s::text[], %s::text[], %s::bigint[], %s::text[])
                    AS t(id, lat, lng, loc_id, loc_label, event_type, summary, status, confidence, city_id, method)
                """, (arr_id, arr_lat, arr_lng, arr_loc_id, arr_loc_label,
                      arr_event, arr_summary, arr_status, arr_conf, arr_city_id, arr_method))
            
            cur.execute("""
                UPDATE news_articles a SET
                    location_text = b.loc_label, extracted_location = b.loc_label,
                    extracted_lat = b.lat, extracted_lng = b.lng,
                    event_type = COALESCE(b.event_type, a.event_type),
                    summary = COALESCE(NULLIF(b.summary, ''), NULLIF(a.summary, '')),
                    status = 'extracted', extracted_at = now(),
                    location_id = b.loc_id,
                    geocoded_at = CASE WHEN b.loc_id IS NOT NULL THEN now() ELSE NULL END,
                    location_confidence = CASE WHEN b.loc_id IS NOT NULL THEN 1.0 ELSE NULL END,
                    auto_categorized_at = now(),
                    auto_categorize_status = b.status, auto_categorize_confidence = b.confidence,
                    auto_categorize_city_id = b.city_id, auto_categorize_city_label = b.loc_label,
                    auto_categorize_event_type = b.event_type, auto_categorize_method = b.method
                FROM batch_update b WHERE a.id = b.id
            """)
            cur.execute("DROP TABLE batch_update")

        if no_match_ids:
            # Don't set auto_categorized_at — leave articles claimable by extract.py AI.
            cur.execute("""
                UPDATE news_articles SET auto_categorize_status = 'no_match',
                auto_categorize_confidence = NULL, auto_categorize_method = 'fast_path'
                WHERE id = ANY(%s)
            """, (no_match_ids,))

        conn.commit()

    t2 = time.time()
    log.info("batch: updated %d articles in %.1fs (total: %.1fs)", len(extracted) + len(no_match_ids), t2 - t1, t2 - t0)
    return summary


def _batch_location_lookup(cities: list[dict], cur) -> dict:
    """Batch lookup of location IDs by lat/lng."""
    if not cities:
        return {}
    lats = [c["lat"] for c in cities if c.get("lat")]
    lngs = [c["lng"] for c in cities if c.get("lng")]
    if not lats:
        return {}
    cur.execute("SELECT id, lat, lng FROM news_locations WHERE lat = ANY(%s) AND lng = ANY(%s)", (lats, lngs))
    return {(row["lat"], row["lng"]): row["id"] for row in cur.fetchall()}


def run(limit: int = DEFAULT_BATCH, progress: ProgressWriter | None = None) -> dict:
    """Process up to `limit` pending articles through the fast path.

    Returns a summary dict so the run.py orchestrator can log totals.

    Flood detection: tracks how many articles per source get geolocated
    to the same city. If a source floods a city (e.g., 50 articles all
    geolocated to "Perth"), subsequent articles from that source are
    left for the AI to handle (which can distinguish "Perth mum" from
    "Perth event").
    """
    effective_limit = 10_000 if limit == 0 else limit
    pending = _fetch_pending(effective_limit)
    log.info("auto_categorize: %d pending (cap %s)", len(pending), limit or "∞")

    summary = {
        "scanned": len(pending),
        "fast_path_high": 0,
        "fast_path_medium": 0,
        "fast_path_low": 0,
        "source_fallback": 0,
        "nn_word_freq": 0,
        "no_match": 0,
        "needs_ai": 0,
        "flood_blocked": 0,
    }

    # Flood detection: track how many articles per (source_id, city_id)
    # have been geolocated in this batch. If a source floods a city,
    # skip subsequent articles from that source (leave for AI).
    flood_counts: dict[tuple[int, int], int] = {}
    FLOOD_LIMIT = 10  # max articles per source per city per batch

    if progress:
        progress.update(
            step="auto_categorize",
            detail=f"Auto-categorizing {len(pending)} articles (no AI)...",
            counters={"auto_categorized": 0},
        )

    # Pre-fetch language detection in batch for articles missing it
    missing_lang = [art for art in pending if not art.get("detected_lang")]
    if missing_lang:
        from .lang_detect import detect_language
        for art in missing_lang:
            text = f"{art.get('title') or ''} {(art.get('body') or '')[:500]}"
            lang = detect_language(text)
            if lang:
                art["detected_lang"] = lang
        # Batch update detected languages in a single query
        lang_updates = [(art["detected_lang"], art["id"]) for art in missing_lang if art.get("detected_lang")]
        if lang_updates:
            try:
                with connect() as conn, conn.cursor() as cur:
                    for lang, aid in lang_updates:
                        cur.execute(
                            "UPDATE news_articles SET detected_lang = %s WHERE id = %s",
                            (lang, aid),
                        )
            except Exception as e:
                log.debug("failed to batch store detected_lang: %s", e)

    if pending:
        with connect() as conn:
            # Deferred no_match articles (no source_fallback) — the NN
            # classifier gets a shot at supplying a category before we
            # commit them as plain no_match.
            nn_candidates: list[tuple[dict, dict]] = []

            for idx, art in enumerate(pending, start=1):
                try:
                    decision = _decide(art)
                    decision["raw_title"] = art.get("title") or ""

                    # Flood detection: if this source has already geolocated too
                    # many articles to the same city in this batch, skip it.
                    city = decision.get("city")
                    if city and city.get("id"):
                        source_id = art.get("source_id") or 0
                        city_id = city["id"]
                        flood_key = (source_id, city_id)
                        current_count = flood_counts.get(flood_key, 0)
                        if current_count >= FLOOD_LIMIT:
                            summary["flood_blocked"] += 1
                            _record_no_match(art["id"], decision.get("category"),
                                             f"flood_limit:{city.get('name')}", conn=conn)
                            continue
                        flood_counts[flood_key] = current_count + 1

                    # Every row gets a marker so the AI study queue can find it.
                    # The "no_match" rows still get the timestamp so /api/articles/
                    # needs-ai can skip them by status filter alone.
                    if decision["status"] == "high":
                        summary["fast_path_high"] += 1
                        _record_apply(art["id"], decision, conn=conn)
                    elif decision["status"] == "medium":
                        summary["fast_path_medium"] += 1
                        _record_apply(art["id"], decision, conn=conn)
                    elif decision["status"] == "low":
                        summary["fast_path_low"] += 1
                        _record_apply(art["id"], decision, conn=conn)
                        # Low-confidence rows that still have a city can stay
                        # "extracted" but should also be queued for AI review.
                        summary["needs_ai"] += 1
                    else:  # no_match
                        # Try source-based fallback: use the news source's own
                        # geocoded lat/lng when the article text doesn't mention
                        # a city. Gets articles on the map without AI.
                        src_decision = _source_fallback(art)
                        if src_decision:
                            src_decision["raw_title"] = art.get("title") or ""
                            summary["source_fallback"] += 1
                            _record_apply(art["id"], src_decision, conn=conn)
                            decision = src_decision  # for progress reporting
                        else:
                            # Defer: NN classifier may yet supply a category.
                            nn_candidates.append((art, decision))

                    if idx % 50 == 0:
                        conn.commit()

                except Exception as e:
                    log.error("error auto-categorizing article %s: %s", art.get("id"), e)
                    try:
                        conn.rollback()
                    except Exception:
                        pass

                if progress and (idx % 25 == 0 or idx == len(pending)):
                    progress.update(
                        detail=(f"Auto-categorized {idx}/{len(pending)} — "
                                f"{summary['fast_path_high']} high, "
                                f"{summary['fast_path_medium']} med, "
                                f"{summary['source_fallback']} src-fb, "
                                f"{summary['nn_word_freq']} nn, "
                                f"{summary['no_match']} no-match, "
                                f"{summary['flood_blocked']} flood-blocked"),
                        counters={"auto_categorized": idx},
                        recent_article={
                            "id": int(art["id"]),
                            "title": (art.get("title") or "")[:80],
                            "category": decision.get("category") or "other",
                            "place": (decision.get("city") or {}).get("name") or "",
                        },
                    )

            # ── NN pass ──────────────────────────────────────────────────
            # Articles that the heuristic couldn't categorize AND that didn't
            # get a source_fallback city now get a second opinion from the
            # trained WordFreqNN model. The NN only supplies a category
            # (no city), so we record the article as no_match with the NN
            # category in auto_categorize_event_type and method='nn_word_freq'.
            # This way the AI study queue can prioritize by category, and we
            # can audit how often the NN rescue fires in prod.
            if nn_candidates:
                nn_articles = [art for art, _ in nn_candidates]
                nn_results = _nn_classify_batch(nn_articles)
                for art, decision in nn_candidates:
                    nn_hit = nn_results.get(int(art["id"]))
                    if nn_hit:
                        cat = nn_hit["category"]
                        conf_float = nn_hit["confidence"]
                        conf_cat = 'high' if conf_float >= 0.8 else 'medium' if conf_float >= 0.5 else 'low'
                        # Inline UPDATE — _record_apply's no_match path always
                        # writes confidence=NULL, but the NN gives us a real
                        # one we want to keep.
                        def _exec_nn(cur):
                            cur.execute(
                                """
                                UPDATE news_articles
                                SET event_type = COALESCE(event_type, %s),
                                    auto_categorize_status = 'no_match',
                                    auto_categorize_confidence = %s,
                                    auto_categorize_event_type = %s,
                                    auto_categorize_method = 'nn_word_freq'
                                WHERE id = %s
                                """,
                                (cat, conf_cat, cat, art["id"]),
                            )
                        _exec_with_conn(conn, _exec_nn)
                        summary["nn_word_freq"] += 1
                        summary["needs_ai"] += 1
                    else:
                        summary["no_match"] += 1
                        _record_apply(art["id"], decision, conn=conn)
                        summary["needs_ai"] += 1

            conn.commit()

    log.info("auto_categorize done: %s", summary)
    return summary


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    print(run())
