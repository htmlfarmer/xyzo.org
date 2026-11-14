"""Fast suggestion handler — processes location suggestions inline.

This module provides fast, synchronous processing of location suggestions
without spawning a worker process. It:
  1. Geocodes the user's text suggestion immediately via Nominatim
  2. Applies the location change if confident
  3. Returns detailed results including what the AI "thought"

Usage:
  Called directly by the API endpoint for quick suggestions.
"""

import json
import logging
import re
import time
from typing import Any

import httpx

from .db import connect
from . import geocode
from .geo_utils import haversine_km

log = logging.getLogger("xyzo.fast_suggest")

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "xyzo.org/1.0 (https://xyzo.org; contact@xyzo.org)"
AI_ENDPOINT = "http://192.168.1.3:8888/chat/stream"
SAFE_HEADERS = {"X-MCP-Safe": "true"}


def process_suggestion(
    pin_id: int,
    article_id: int,
    user_place: str | None = None,
    lat: float | None = None,
    lng: float | None = None,
    radius_km: float = 25,
    map_center_lat: float | None = None,
    map_center_lng: float | None = None,
    map_zoom: int | None = None,
) -> dict:
    """Process a location suggestion and return detailed results.

    This runs synchronously for fast feedback. Returns a dict with:
      - applied: bool
      - steps: list of {step, status, message, duration_ms}
      - result: {lat, lng, place_name, precision, confidence}
      - reasoning: str (AI explanation if available)
    """
    steps = []
    t0 = time.time()

    # Step 1: Determine the target location
    step1_start = time.time()

    if lat is not None and lng is not None:
        # User clicked the map — use those coordinates directly
        steps.append({
            "step": "input",
            "status": "ok",
            "message": f"Using map click coordinates: {lat:.4f}, {lng:.4f}",
            "duration_ms": 0,
        })
        target_lat, target_lng = lat, lng
        source = "map_click"
    elif user_place:
        # User typed a description — try to geocode it
        steps.append({
            "step": "input",
            "status": "ok",
            "message": f"Analyzing: \"{user_place}\"",
            "duration_ms": 0,
        })

        # First try direct geocoding
        geo_result = geocode_text(user_place)

        if not geo_result:
            # Direct geocoding failed — try non-AI heuristics first so
            # we still resolve common cases when the AI endpoint is down.
            heuristic_geo, heuristic_steps = _heuristic_resolve(user_place)
            steps.extend(heuristic_steps)
            if heuristic_geo:
                geo_result = heuristic_geo
                steps.append({
                    "step": "heuristic_resolve",
                    "status": "ok",
                    "message": f"Non-AI resolver picked: \"{heuristic_geo['display_name']}\"",
                    "duration_ms": 0,
                })
            else:
                # Direct + heuristic both failed — try AI to parse the
                # intent from the article body.
                steps.append({
                    "step": "fetch_article",
                    "status": "ok",
                    "message": "Fetching article content for context…",
                    "duration_ms": 0,
                })

                steps.append({
                    "step": "ai_parse",
                    "status": "ok",
                    "message": "Using AI to analyze article and your correction…",
                    "duration_ms": 0,
                })

                ai_result = ai_parse_location(user_place, article_id)
                step1_ms = int((time.time() - step1_start) * 1000)

                if ai_result and ai_result.get("extracted_location"):
                    steps.append({
                        "step": "ai_parse",
                        "status": "ok",
                        "message": f"AI determined: \"{ai_result['extracted_location']}\"",
                        "duration_ms": step1_ms,
                    })
                    if ai_result.get("reasoning"):
                        steps.append({
                            "step": "ai_reasoning",
                            "status": "ok",
                            "message": f"Reasoning: {ai_result['reasoning']}",
                            "duration_ms": 0,
                        })

                    # Now geocode the AI's extracted location
                    geo_result = geocode_text(ai_result["extracted_location"])
                    if geo_result:
                        steps.append({
                            "step": "geocode",
                            "status": "ok",
                            "message": f"Found: {geo_result['display_name']} ({geo_result['lat']:.4f}, {geo_result['lng']:.4f})",
                            "duration_ms": int((time.time() - step1_start) * 1000) - step1_ms,
                        })
                    else:
                        steps.append({
                            "step": "geocode",
                            "status": "failed",
                            "message": f"Could not geocode: \"{ai_result['extracted_location']}\"",
                            "duration_ms": int((time.time() - step1_start) * 1000) - step1_ms,
                        })
                else:
                    steps.append({
                        "step": "ai_parse",
                        "status": "failed",
                        "message": "AI could not determine a location from the article and your correction",
                        "duration_ms": step1_ms,
                    })

        if geo_result:
            target_lat = geo_result["lat"]
            target_lng = geo_result["lng"]
            # Source attribution: which resolver gave us a hit? Order of
            # preference — map_click > ai > heuristic > direct geocode.
            # The AI branch sets ai_result; the heuristic branch leaves
            # both ai_result and the geo_result source as "heuristic".
            if lat is not None and lng is not None:
                source = "map_click"
            elif ai_result:
                source = "ai"
            elif any(s.get("step", "").startswith("heuristic_") for s in steps):
                source = "heuristic"
            else:
                source = "geocode"
            step1_ms = int((time.time() - step1_start) * 1000)
            if not any(s["step"] == "geocode" and s["status"] == "ok" for s in steps):
                steps.append({
                    "step": "geocode",
                    "status": "ok",
                    "message": f"Found: {geo_result['display_name']} ({target_lat:.4f}, {target_lng:.4f})",
                    "duration_ms": step1_ms,
                })
        else:
            step1_ms = int((time.time() - step1_start) * 1000)
            steps.append({
                "step": "geocode",
                "status": "failed",
                "message": f"Could not find location for \"{user_place}\"",
                "duration_ms": step1_ms,
            })
            return {
                "applied": False,
                "steps": steps,
                "reason": "geocode_failed",
                "total_ms": int((time.time() - t0) * 1000),
            }
    else:
        return {
            "applied": False,
            "steps": steps,
            "reason": "no_input",
            "total_ms": int((time.time() - t0) * 1000),
        }

    # Step 2: Get current article location for comparison
    step2_start = time.time()
    current = get_article_location(article_id)
    step2_ms = int((time.time() - step2_start) * 1000)

    if current:
        steps.append({
            "step": "current_location",
            "status": "ok",
            "message": f"Current: {current['place_name']} ({current['lat']:.4f}, {current['lng']:.4f})",
            "duration_ms": step2_ms,
        })

        # Check if the new location is significantly different
        dist_km = haversine_km(current["lat"], current["lng"], target_lat, target_lng)
        if dist_km < 10:
            steps.append({
                "step": "validation",
                "status": "skipped",
                "message": f"New location is only {dist_km:.0f}km from current — no change needed",
                "duration_ms": 0,
            })
            return {
                "applied": False,
                "steps": steps,
                "reason": "same_location",
                "distance_km": round(dist_km, 1),
                "total_ms": int((time.time() - t0) * 1000),
            }
        else:
            steps.append({
                "step": "validation",
                "status": "ok",
                "message": f"New location is {dist_km:.0f}km away — will update",
                "duration_ms": 0,
            })
    else:
        steps.append({
            "step": "current_location",
            "status": "skipped",
            "message": "No current location found",
            "duration_ms": step2_ms,
        })

    # Step 3: Determine precision and confidence
    precision = _precision_for_radius(radius_km)
    confidence = {
        "exact": 0.9,
        "city": 0.85,
        "region": 0.7,
        "country": 0.55,
    }.get(precision, 0.7)

    # Boost confidence if user clicked the map (more precise than text)
    if source == "map_click":
        confidence = min(confidence + 0.05, 0.95)

    # Step 4: Apply the location change
    step4_start = time.time()
    result = apply_location_change(
        pin_id=pin_id,
        article_id=article_id,
        lat=target_lat,
        lng=target_lng,
        precision=precision,
        confidence=confidence,
        place_name=user_place or f"user suggestion ({target_lat:.4f}, {target_lng:.4f})",
        map_center_lat=map_center_lat,
        map_center_lng=map_center_lng,
        map_zoom=map_zoom,
    )
    step4_ms = int((time.time() - step4_start) * 1000)

    if result["applied"]:
        steps.append({
            "step": "apply",
            "status": "ok",
            "message": f"Pin moved to {target_lat:.4f}, {target_lng:.4f}",
            "duration_ms": step4_ms,
        })
    else:
        steps.append({
            "step": "apply",
            "status": "failed",
            "message": f"Failed to apply: {result.get('reason', 'unknown')}",
            "duration_ms": step4_ms,
        })

    total_ms = int((time.time() - t0) * 1000)

    return {
        "applied": result["applied"],
        "steps": steps,
        "result": {
            "lat": target_lat,
            "lng": target_lng,
            "place_name": user_place or f"{target_lat:.4f}, {target_lng:.4f}",
            "precision": precision,
            "confidence": confidence,
            "source": source,
        },
        "reasoning": f"Suggestion processed via {source}. " +
                    (f"Moved {dist_km:.0f}km from previous location." if current and 'dist_km' in dir() else "New location applied."),
        "total_ms": total_ms,
    }


def geocode_text(text: str) -> dict | None:
    """Geocode text using Nominatim. Returns {lat, lng, display_name} or None."""
    try:
        with httpx.Client(timeout=10) as client:
            resp = client.get(
                NOMINATIM_URL,
                params={
                    "q": text,
                    "format": "json",
                    "limit": 1,
                    "addressdetails": 1,
                },
                headers={"User-Agent": USER_AGENT},
            )
            resp.raise_for_status()
            data = resp.json()

        if not data:
            return None

        hit = data[0]
        lat = float(hit["lat"])
        lng = float(hit["lon"])
        display_name = hit.get("display_name", text)

        return {
            "lat": lat,
            "lng": lng,
            "display_name": display_name,
            "osm_type": hit.get("type", ""),
            "country": hit.get("address", {}).get("country_code", "").upper(),
        }
    except Exception as e:
        log.warning("Geocode failed for %r: %s", text, e)
        return None


def _heuristic_resolve(user_place: str) -> tuple[dict | None, list[dict]]:
    """Non-AI location resolution.

    Three strategies, tried in order:
      1. Nominatim re-query with each comma-separated segment (catches
         cases where "City, Country" needs just the city).
      2. find_cities_in_text_db — matches user_place against the
         world_cities table (population ≥ 100k).
      3. COUNTRY_NAMES dict — for "Argentina" / "USA" style corrections.

    Returns (geo_result_or_None, list_of_step_dicts).
    """
    steps: list[dict] = []
    if not user_place:
        return None, steps

    # Strategy 1: comma-split re-query.
    segments = [s.strip() for s in user_place.split(",") if s.strip()]
    # Try the most specific segment first (city), then walk up.
    for seg in reversed(segments):
        if len(seg) < 3:
            continue
        try:
            geo = geocode_text(seg)
            if geo:
                steps.append({
                    "step": "heuristic_nominatim_split",
                    "status": "ok",
                    "message": f"Resolved via Nominatim on \"{seg}\"",
                    "duration_ms": 0,
                })
                return geo, steps
        except Exception:
            continue

    # Strategy 2: world_cities table lookup.
    try:
        matches = find_cities_in_text_db(user_place, min_population=100_000)
        if matches:
            top = matches[0]
            steps.append({
                "step": "heuristic_cities_db",
                "status": "ok",
                "message": f"Matched city DB: {top.get('name', '')}, {top.get('country', '')}",
                "duration_ms": 0,
            })
            return {
                "lat": float(top["lat"]),
                "lng": float(top["lng"]),
                "display_name": f"{top.get('name','')}, {top.get('country','')}".strip(", "),
                "country": top.get("country", ""),
                "osm_type": "city",
            }, steps
    except Exception as e:
        log.debug("heuristic_resolve cities lookup failed: %s", e)

    # Strategy 3: country name dict.
    try:
        low = user_place.lower().strip()
        if low in COUNTRY_NAMES:
            cname = COUNTRY_NAMES[low]
            geo = geocode_text(cname)
            if geo:
                steps.append({
                    "step": "heuristic_country_dict",
                    "status": "ok",
                    "message": f"Matched country dictionary: {cname}",
                    "duration_ms": 0,
                })
                return geo, steps
    except Exception:
        pass

    return None, steps


def find_cities_in_text_db(text: str, min_population: int = 100000) -> list[dict]:
    """Find city names in text using the world_cities database.

    This is the fast, non-AI approach. Returns cities sorted by population.
    Uses word-boundary matching to avoid false positives.
    Handles negations like "not Seoul" by deprioritizing negated cities.
    """
    if not text or len(text) < 3:
        return []

    # Normalize text for matching
    text_lower = text.lower()
    text_words = set(text_lower.split())

    # Find negation positions (where "not", "isn't", etc. appear)
    negation_positions = []
    negation_words = ["not", "isn't", "isnt", "wasn't", "wasnt", "wrong"]
    for neg in negation_words:
        idx = text_lower.find(f" {neg} ")
        if idx >= 0:
            negation_positions.append(idx + len(neg) + 1)

    with connect() as conn, conn.cursor() as cur:
        # Get cities that could match
        cur.execute("""
            SELECT name, ascii_name, country_code, state_name, lat, lng, population
            FROM world_cities
            WHERE population >= %s
            ORDER BY population DESC
        """, (min_population,))

        results = []
        seen = set()

        for row in cur.fetchall():
            name_lower = row["name"].lower()
            ascii_lower = row["ascii_name"].lower()

            # Check if city name appears as a whole word in text
            is_match = False
            match_position = -1

            # Check if it's in our word set (exact word match)
            if name_lower in text_words or ascii_lower in text_words:
                is_match = True
                match_position = text_lower.find(name_lower)

            # Check if it appears with word boundaries in the text
            if not is_match:
                for pattern in [f" {name_lower} ", f" {name_lower},", f" {name_lower}.",
                               f" {ascii_lower} ", f" {ascii_lower},", f" {ascii_lower}."]:
                    idx = text_lower.find(pattern)
                    if idx >= 0:
                        is_match = True
                        match_position = idx
                        break

            if is_match and row["name"] not in seen:
                # Check if this city is negated (appears after "not", etc.)
                is_negated = False
                for neg_pos in negation_positions:
                    if match_position > neg_pos:
                        is_negated = True
                        break

                seen.add(row["name"])
                results.append({
                    "name": row["name"],
                    "state": row["state_name"],
                    "country": row["country_code"],
                    "lat": float(row["lat"]),
                    "lng": float(row["lng"]),
                    "population": int(row["population"]),
                    "negated": is_negated,
                    "position": match_position,
                })

                if len(results) >= 10:
                    break

    # Sort: non-negated first, then by population
    results.sort(key=lambda x: (x.get("negated", False), -x["population"]))

    return results


def ai_parse_location(user_text: str, article_id: int | None = None) -> dict | None:
    """Use AI to parse user's intent and extract a geocodable location.

    This function:
      1. First tries to find cities in the text using the database (fast)
      2. If that fails, fetches the article and uses AI (slower)

    Handles cases like:
      - "this story is in the usa not india" → finds "usa" in text
      - "wrong location says northeast us" → AI parses intent
      - "should be in Argentina" → finds "argentina" in text
    """
    # First, try fast database lookup
    # Extract potential location names from the user's text
    cities_in_text = find_cities_in_text_db(user_text, min_population=100000)

    if cities_in_text:
        # Found cities in the user's text - use the highest population one
        best_city = cities_in_text[0]
        return {
            "extracted_location": f"{best_city['name']}, {best_city['country']}",
            "reasoning": f"Found '{best_city['name']}' in your text (pop: {best_city['population']:,})",
            "source": "database",
        }

    # Also check for country names in the text
    country_match = extract_country_from_text(user_text)
    if country_match:
        return {
            "extracted_location": country_match["name"],
            "reasoning": f"Found country '{country_match['name']}' in your text",
            "source": "database",
        }

    # Database lookup failed - try AI with article context
    article_context = ""
    article_content = ""
    if article_id:
        article = get_article_info(article_id)
        if article:
            article_context = f"""
Article title: {article.get('title', '')}
Current location text: {article.get('location_text', '')}
Article URL: {article.get('url', '')}"""

            # Use existing body text if available, otherwise fetch from URL
            if article.get('body') and len(article['body']) > 100:
                article_content = article['body'][:2000]
            elif article.get('url'):
                article_content = fetch_article_text(article['url'])
                if article_content:
                    article_content = article_content[:2000]

    prompt = f"""You are helping correct a news story's geographic location.

USER'S CORRECTION: "{user_text}"
{article_context}

{f"ARTICLE CONTENT (first 2000 chars):{chr(10)}{article_content}" if article_content else ""}

The user is telling us the story is geographically misplaced. Analyze:
1. What the user is saying about the correct location
2. What the article content says about where the story takes place
3. Determine the ACTUAL geographic location this story should be pinned to

Examples of user corrections:
- "this story is in the usa not india" → the story should be in the USA
- "wrong location says northeast us" → northeast United States
- "should be in Argentina" → Argentina
- "the article mentions Beirut" → Beirut, Lebanon
- "this is about Tokyo" → Tokyo, Japan

Reply with ONLY a JSON object:
{{"extracted_location": "<the location to geocode>", "reasoning": "<brief explanation of why this is the correct location>"}}

If you truly cannot determine a location, reply with:
{{"extracted_location": null, "reasoning": "could not determine location"}}"""

    try:
        with httpx.Client(timeout=12) as client:
            resp = client.post(
                AI_ENDPOINT,
                json={"message": prompt, "stream": False},
                headers={**SAFE_HEADERS, "Content-Type": "application/json"},
            )
            resp.raise_for_status()
            data = resp.json()

        # Extract JSON from response
        text = data.get("response", "") or data.get("message", "")
        matches = re.findall(r'\{[^{}]*\}', text)
        for match in matches:
            try:
                result = json.loads(match)
                if result.get("extracted_location"):
                    result["source"] = "ai"
                    return result
            except json.JSONDecodeError:
                continue

    except Exception as e:
        log.warning("AI parse failed: %s", e)

    return None


# Common country names for quick lookup
COUNTRY_NAMES = {
    "afghanistan": "Afghanistan", "albania": "Albania", "algeria": "Algeria",
    "argentina": "Argentina", "australia": "Australia", "austria": "Austria",
    "bangladesh": "Bangladesh", "belgium": "Belgium", "brazil": "Brazil",
    "bulgaria": "Bulgaria", "cambodia": "Cambodia", "cameroon": "Cameroon",
    "canada": "Canada", "chile": "Chile", "china": "China", "colombia": "Colombia",
    "congo": "Congo", "costa rica": "Costa Rica", "croatia": "Croatia",
    "cuba": "Cuba", "czech republic": "Czech Republic", "denmark": "Denmark",
    "dominican republic": "Dominican Republic", "ecuador": "Ecuador",
    "egypt": "Egypt", "ethiopia": "Ethiopia", "finland": "Finland",
    "france": "France", "germany": "Germany", "ghana": "Ghana",
    "greece": "Greece", "guatemala": "Guatemala", "haiti": "Haiti",
    "honduras": "Honduras", "hungary": "Hungary", "iceland": "Iceland",
    "india": "India", "indonesia": "Indonesia", "iran": "Iran", "iraq": "Iraq",
    "ireland": "Ireland", "israel": "Israel", "italy": "Italy",
    "ivory coast": "Ivory Coast", "jamaica": "Jamaica", "japan": "Japan",
    "jordan": "Jordan", "kazakhstan": "Kazakhstan", "kenya": "Kenya",
    "kuwait": "Kuwait", "lebanon": "Lebanon", "libya": "Libya",
    "malaysia": "Malaysia", "mexico": "Mexico", "mongolia": "Mongolia",
    "morocco": "Morocco", "mozambique": "Mozambique", "myanmar": "Myanmar",
    "nepal": "Nepal", "netherlands": "Netherlands", "new zealand": "New Zealand",
    "nicaragua": "Nicaragua", "nigeria": "Nigeria", "north korea": "North Korea",
    "norway": "Norway", "oman": "Oman", "pakistan": "Pakistan",
    "panama": "Panama", "paraguay": "Paraguay", "peru": "Peru",
    "philippines": "Philippines", "poland": "Poland", "portugal": "Portugal",
    "qatar": "Qatar", "romania": "Romania", "russia": "Russia",
    "saudi arabia": "Saudi Arabia", "senegal": "Senegal", "serbia": "Serbia",
    "singapore": "Singapore", "slovakia": "Slovakia", "slovenia": "Slovenia",
    "somalia": "Somalia", "south africa": "South Africa",
    "south korea": "South Korea", "spain": "Spain", "sri lanka": "Sri Lanka",
    "sudan": "Sudan", "sweden": "Sweden", "switzerland": "Switzerland",
    "syria": "Syria", "taiwan": "Taiwan", "tanzania": "Tanzania",
    "thailand": "Thailand", "tunisia": "Tunisia", "turkey": "Turkey",
    "uganda": "Uganda", "ukraine": "Ukraine",
    "united arab emirates": "United Arab Emirates",
    "united kingdom": "United Kingdom", "united states": "United States",
    "uruguay": "Uruguay", "uzbekistan": "Uzbekistan", "venezuela": "Venezuela",
    "vietnam": "Vietnam", "yemen": "Yemen", "zambia": "Zambia", "zimbabwe": "Zimbabwe",
    # Common abbreviations
    "usa": "United States", "us": "United States", "uk": "United Kingdom",
    "uae": "United Arab Emirates", "drc": "Congo",
}


def extract_country_from_text(text: str) -> dict | None:
    """Extract country name from text using simple string matching.

    Handles negations like "not in India" or "not India" - these indicate
    the WRONG location, so we skip them and look for the correct one.
    """
    text_lower = text.lower()

    # Sort by length (longest first) to avoid partial matches
    sorted_countries = sorted(COUNTRY_NAMES.items(), key=lambda x: len(x[0]), reverse=True)

    # Find all country mentions
    found = []
    for pattern, name in sorted_countries:
        idx = text_lower.find(pattern)
        if idx == -1:
            continue

        # Check if this mention is negated
        # Look for "not" before the mention, but NOT "should be in" (which means user wants it there)
        prefix = text_lower[:idx].strip()
        is_negated = False

        # These patterns indicate the WRONG location (negation)
        negation_patterns = ["not", "isn't", "isnt", "wasn't", "wasnt",
                           "shouldn't be", "shouldnt be", "wrong", "incorrect"]

        for neg in negation_patterns:
            if prefix.endswith(neg):
                is_negated = True
                break

        # These patterns indicate the DESIRED location (positive)
        positive_patterns = ["should be in", "move to", "relocate to",
                           "actually in", "about", "in", "from"]

        for pos in positive_patterns:
            if prefix.endswith(pos):
                is_negated = False
                break

        found.append({
            "name": name,
            "pattern": pattern,
            "position": idx,
            "negated": is_negated,
        })

    if not found:
        return None

    # Prefer non-negated mentions
    non_negated = [f for f in found if not f["negated"]]
    if non_negated:
        # Return the first non-negated mention
        return {"name": non_negated[0]["name"], "pattern": non_negated[0]["pattern"]}

    # If all are negated, return None (we don't know the correct location)
    return None


def fetch_article_text(url: str) -> str | None:
    """Fetch article content from URL for AI analysis."""
    try:
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            resp = client.get(url, headers={"User-Agent": USER_AGENT})
            if resp.status_code >= 400:
                return None

            content_type = resp.headers.get("content-type", "")
            if "text/html" not in content_type:
                return None

            html = resp.text

            # Simple HTML to text extraction
            # Remove script and style tags
            html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
            html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
            # Remove HTML tags
            text = re.sub(r'<[^>]+>', ' ', html)
            # Clean up whitespace
            text = re.sub(r'\s+', ' ', text).strip()

            return text[:3000]
    except Exception as e:
        log.warning("Failed to fetch article from %s: %s", url, e)
        return None


def get_article_info(article_id: int) -> dict | None:
    """Get basic article info for context."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT title, location_text, url, body
            FROM news_articles
            WHERE id = %s
        """, (article_id,))
        row = cur.fetchone()
    if not row:
        return None
    result = dict(row)
    # If we have body text, use it instead of fetching
    if result.get('body') and len(result['body']) > 100:
        result['_has_body'] = True
    return result


def get_pin_suggestions(pin_id: int) -> list[dict]:
    """Get all previous suggestions for a pin."""
    with connect() as conn, conn.cursor() as cur:
        # Get from news_re_evaluate_requests
        cur.execute("""
            SELECT
                r.id,
                r.user_place,
                r.status,
                r.result,
                r.requested_at,
                r.completed_at,
                r.community_status,
                r.confirm_votes,
                r.reject_votes,
                a.title as article_title,
                a.location_text as original_location
            FROM news_re_evaluate_requests r
            LEFT JOIN news_articles a ON a.id = r.article_id
            WHERE r.pin_id = %s AND r.kind = 'suggest_location'
            ORDER BY r.requested_at DESC
            LIMIT 20
        """, (pin_id,))
        requests = cur.fetchall()

        # Get from news_quality_reports
        cur.execute("""
            SELECT
                report_type,
                reason,
                created_at
            FROM news_quality_reports
            WHERE article_id = %s
            ORDER BY created_at DESC
            LIMIT 10
        """, (pin_id,))
        reports = cur.fetchall()

    suggestions = []
    for r in requests:
        result = r.get("result") or {}
        suggestions.append({
            "type": "location_suggestion",
            "id": r["id"],
            "user_place": r["user_place"],
            "status": r["status"],
            "community_status": r.get("community_status"),
            "confirm_votes": r.get("confirm_votes", 0),
            "reject_votes": r.get("reject_votes", 0),
            "applied": result.get("applied", False) if isinstance(result, dict) else False,
            "result_lat": result.get("lat") if isinstance(result, dict) else None,
            "result_lng": result.get("lng") if isinstance(result, dict) else None,
            "result_place": result.get("place_name") if isinstance(result, dict) else None,
            "requested_at": r["requested_at"].isoformat() if r["requested_at"] else None,
            "completed_at": r["completed_at"].isoformat() if r["completed_at"] else None,
        })

    for r in reports:
        suggestions.append({
            "type": "quality_report",
            "report_type": r["report_type"],
            "reason": r["reason"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        })

    return suggestions


def get_article_location(article_id: int) -> dict | None:
    """Get the current location of an article."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT l.lat, l.lng, l.place_name, l.country, l.precision
            FROM news_articles a
            JOIN news_locations l ON l.id = a.location_id
            WHERE a.id = %s
        """, (article_id,))
        row = cur.fetchone()

    if not row:
        return None

    return {
        "lat": float(row["lat"]),
        "lng": float(row["lng"]),
        "place_name": row["place_name"],
        "country": row["country"],
        "precision": row["precision"],
    }


def apply_location_change(
    pin_id: int,
    article_id: int,
    lat: float,
    lng: float,
    precision: str,
    confidence: float,
    place_name: str,
    map_center_lat: float | None = None,
    map_center_lng: float | None = None,
    map_zoom: int | None = None,
) -> dict:
    """Apply a location change to a pin/article."""
    with connect() as conn, conn.cursor() as cur:
        # Find or create the location
        cur.execute("""
            SELECT id FROM news_locations
            WHERE ROUND(lat::numeric, 3) = ROUND(%s::numeric, 3)
              AND ROUND(lng::numeric, 3) = ROUND(%s::numeric, 3)
            LIMIT 1
        """, (lat, lng))
        row = cur.fetchone()

        if row:
            location_id = row["id"]
        else:
            cur.execute("""
                INSERT INTO news_locations (
                    place_name, place_name_normalized, country, lat, lng,
                    precision, confidence, geom, learned_from_user_count
                )
                VALUES (%s, %s, NULL, %s, %s, %s, %s,
                        ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, 1)
                RETURNING id
            """, (
                place_name, f"user:{lat:.4f},{lng:.4f}",
                lat, lng, precision, confidence,
                lng, lat,
            ))
            location_id = cur.fetchone()["id"]

        # Update the article
        cur.execute("""
            UPDATE news_articles
            SET location_id = %s,
                location_confidence = %s,
                re_evaluated_at = now()
            WHERE id = %s
        """, (location_id, confidence, article_id))

        # Update the pin if it exists
        cur.execute("""
            UPDATE pins
            SET location = ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                location_precision = %s,
                confidence_score = %s
            WHERE id = %s
        """, (lng, lat, precision, max(confidence, 0.5), pin_id))

        # Bump learned_from_user_count
        cur.execute("""
            UPDATE news_locations
            SET learned_from_user_count = learned_from_user_count + 1
            WHERE id = %s
        """, (location_id,))

        # Create a news_re_evaluate_requests record so it shows on the requests page
        user_place = f"coords:{lat:.4f},{lng:.4f},25,{confidence}"
        cur.execute("""
            INSERT INTO news_re_evaluate_requests (
                pin_id, article_id, kind, user_place, status, completed_at,
                result, community_status, public_visible,
                map_center_lat, map_center_lng, map_zoom
            )
            VALUES (%s, %s, 'suggest_location', %s, 'completed', now(),
                    %s, 'open', true,
                    %s, %s, %s)
            ON CONFLICT (dedup_key) WHERE status IN ('queued','running')
            DO NOTHING
        """, (
            pin_id, article_id, user_place,
            json.dumps({
                "applied": True,
                "lat": lat,
                "lng": lng,
                "place_name": place_name,
                "precision": precision,
                "confidence": confidence,
                "location_id": location_id,
            }),
            map_center_lat, map_center_lng, map_zoom,
        ))

    return {"applied": True, "location_id": location_id}


def _precision_for_radius(radius_km: float) -> str:
    """Map radius to precision level."""
    if radius_km <= 5:
        return "exact"
    if radius_km <= 25:
        return "city"
    if radius_km <= 100:
        return "region"
    return "country"
