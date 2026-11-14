"""Two-pass location extraction with granularity detection.

Pass 1: Extract ALL location mentions from article text using NER-style
         pattern matching (no AI needed).

Pass 2: Rank by granularity and pick the finest one tied to the main event.
         Use Gemma-4 for ambiguous cases.

Granularity levels (finest → coarsest):
  landmark  — specific building, monument, venue
  street    — street address, intersection
  neighborhood — named area within a city
  district  — borough, ward, administrative division
  city      — city name
  region    — state, province, prefecture
  country   — country name only

Usage:
    from worker.granular_geocode import extract_and_geocode
    result = extract_and_geocode(article_id)
    # → {lat, lng, granularity, confidence, specific_location, method}
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
from typing import Any

from . import cities_text
from .db import connect
from .auto_categorize import _detect_country_mentions, _load_source_cache

log = logging.getLogger("xyzo.granular_geocode")

AI_URL = os.environ.get("XYZO_AI_CHAT_URL", "http://192.168.1.3:8888/chat/stream")
AI_TIMEOUT = float(os.environ.get("XYZO_AI_TIMEOUT", "20"))
SAFE_HEADERS = {"X-MCP-Safe": "true"}

# ── Granularity patterns ─────────────────────────────────────────────
# These patterns detect specific location mentions in article text.
# Order matters — more specific patterns are checked first.

LANDMARK_PATTERNS = [
    # Named buildings, monuments, venues
    re.compile(r'\b(?:the\s+)?(?:pentagon|white\s+house|capitol|parliament|senate|house\s+of\s+representatives)\b', re.I),
    re.compile(r'\b(?:stadium|arena|center|centre|theatre|theater|museum|hospital|university|airport|station)\s+(?:of|in|at)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)', re.I),
    re.compile(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:stadium|arena|center|centre|theatre|theater|museum|hospital|university|airport|station)\b', re.I),
    re.compile(r'\b(?:tower|bridge|palace|temple|mosque|church|cathedral|shrine|fort|castle)\s+(?:of|in|at)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)', re.I),
    re.compile(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:tower|bridge|palace|temple|mosque|church|cathedral|shrine|fort|castle)\b', re.I),
]

STREET_PATTERNS = [
    # Street addresses
    re.compile(r'\b\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl)\b', re.I),
    re.compile(r'\b(?:intersection|corner)\s+(?:of)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:and|&)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)', re.I),
]

NEIGHBORHOOD_PATTERNS = [
    # Named neighborhoods/districts within cities
    re.compile(r'\b(?:in|at|near|from)\s+(?:the\s+)?(?:neighborhood|district|area|quarter|ward|borough)\s+of\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)', re.I),
    re.compile(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:neighborhood|district|area|quarter|ward|borough)\b', re.I),
    # Common South Asian locality patterns
    re.compile(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:colony|nagar|puram|puri|ganj|peth|wadi|pally|halli|pet|street|road|lane)\b', re.I),
]

# ── Text extraction functions ─────────────────────────────────────────

def _extract_locations_from_text(title: str, body: str) -> list[dict]:
    """Extract all location mentions from article text.

    Returns list of {text, granularity, context, position}.
    """
    full_text = f"{title}\n{body[:3000]}"
    locations = []

    # Extract landmarks
    for pattern in LANDMARK_PATTERNS:
        for m in pattern.finditer(full_text):
            text = m.group(0).strip()
            if len(text) > 3:
                locations.append({
                    "text": text,
                    "granularity": "landmark",
                    "context": _get_context(full_text, m.start()),
                    "position": m.start(),
                })

    # Extract streets
    for pattern in STREET_PATTERNS:
        for m in pattern.finditer(full_text):
            text = m.group(0).strip()
            if len(text) > 5:
                locations.append({
                    "text": text,
                    "granularity": "street",
                    "context": _get_context(full_text, m.start()),
                    "position": m.start(),
                })

    # Extract neighborhoods
    for pattern in NEIGHBORHOOD_PATTERNS:
        for m in pattern.finditer(full_text):
            text = m.group(1).strip() if m.lastindex else m.group(0).strip()
            if len(text) > 3:
                locations.append({
                    "text": text,
                    "granularity": "neighborhood",
                    "context": _get_context(full_text, m.start()),
                    "position": m.start(),
                })

    # Extract cities using cities_text
    try:
        stats = cities_text.stats(full_text)
        for city in stats.get("cities", [])[:5]:
            locations.append({
                "text": city.get("name", ""),
                "granularity": "city",
                "context": _get_context(full_text, 0),
                "position": 0,
                "city_data": city,
            })
    except Exception:
        pass

    # Extract countries
    mentioned_countries = _detect_country_mentions(full_text)
    for cc in mentioned_countries:
        locations.append({
            "text": cc,
            "granularity": "country",
            "context": "",
            "position": 0,
            "country_code": cc,
        })

    return locations


def _get_context(text: str, position: int, window: int = 100) -> str:
    """Get surrounding text context for a location mention."""
    start = max(0, position - window)
    end = min(len(text), position + window)
    return text[start:end].strip()


# ── Granularity ranking ──────────────────────────────────────────────

GRANULARITY_RANK = {
    "landmark": 1,
    "street": 2,
    "neighborhood": 3,
    "district": 4,
    "city": 5,
    "region": 6,
    "country": 7,
}


def _rank_locations(locations: list[dict], source_country: str | None = None) -> list[dict]:
    """Rank locations by relevance to the article's main event.

    Factors:
      1. Granularity (finer = better)
      2. Position in text (title mentions > body mentions)
      3. Source country bias (domestic locations preferred)
      4. Frequency (mentioned more = more relevant)
    """
    if not locations:
        return []

    # Count frequency
    freq = {}
    for loc in locations:
        key = loc["text"].lower()
        freq[key] = freq.get(key, 0) + 1

    scored = []
    for loc in locations:
        score = 0

        # Granularity score (finer = higher)
        granularity = loc.get("granularity", "city")
        score += (7 - GRANULARITY_RANK.get(granularity, 5)) * 10

        # Position score (title mentions get bonus)
        if loc.get("position", 0) < 100:  # In title
            score += 20

        # Frequency bonus
        key = loc["text"].lower()
        score += min(freq.get(key, 1) - 1, 3) * 5

        # Source country bias
        if source_country and loc.get("country_code"):
            if loc["country_code"].upper() == source_country.upper():
                score += 15  # Domestic location bonus

        # City data bonus (has coordinates)
        if loc.get("city_data"):
            score += 10

        scored.append({**loc, "score": score})

    scored.sort(key=lambda x: -x["score"])
    return scored


# ── Deterministic jitter ─────────────────────────────────────────────

def _deterministic_jitter(article_id: int, lat: float, lng: float, radius_m: int = 200) -> tuple[float, float]:
    """Apply deterministic jitter to break pin stacking.

    Uses article ID as seed so the same article always gets the same
    offset. Jitter is within `radius_m` of the original point.
    """
    # Hash the article ID to get deterministic values
    h = hashlib.md5(str(article_id).encode()).hexdigest()
    angle = int(h[:8], 16) / 0xFFFFFFFF * 2 * math.pi
    distance = int(h[8:16], 16) / 0xFFFFFFFF * radius_m / 111000  # Convert to degrees

    new_lat = lat + distance * math.cos(angle)
    new_lng = lng + distance * math.sin(angle) / math.cos(math.radians(lat))
    return round(new_lat, 6), round(new_lng, 6)


# ── AI extraction for ambiguous cases ────────────────────────────────

def _ai_extract_locations(title: str, body: str, source_country: str | None = None) -> list[dict] | None:
    """Use Gemma-4 to extract specific locations from article text.

    Returns list of {text, granularity, context} or None on failure.
    """
    import httpx

    country_hint = f" The source is based in {source_country}." if source_country else ""

    prompt = f"""Extract every specific location mentioned in this article.
For each, classify its granularity: landmark, street, neighborhood, district, city, region, country.
Return JSON: [{{"text": "...", "granularity": "...", "context": "..."}}]

Rules:
- Only include locations that are central to the main event
- Ignore locations mentioned in passing (e.g., datelines, quotes from officials elsewhere)
- Prefer the most specific location that's directly related to the news
{country_hint}

Title: {title}

Article: {body[:2000]}"""

    try:
        with httpx.Client(timeout=AI_TIMEOUT) as client:
            resp = client.post(
                AI_URL,
                json={"message": prompt, "stream": True},
                headers={**SAFE_HEADERS, "Content-Type": "application/json"},
            )
            resp.raise_for_status()

            full_text = ""
            for line in resp.text.split("\n"):
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    obj = json.loads(payload)
                    delta = obj.get("choices", [{}])[0].get("delta", {}).get("content", "")
                    full_text += delta
                except json.JSONDecodeError:
                    continue

        # Parse JSON array from response
        matches = re.findall(r'\[[\s\S]*?\]', full_text)
        for match in matches:
            try:
                result = json.loads(match)
                if isinstance(result, list) and len(result) > 0:
                    return result[:10]
            except json.JSONDecodeError:
                continue

    except Exception as e:
        log.debug("AI location extraction failed: %s", e)

    return None


# ── Main extraction function ─────────────────────────────────────────

def extract_and_geocode(article_id: int, use_ai: bool = False) -> dict | None:
    """Extract specific location from article and geocode it.

    Two-pass approach:
      1. Pattern-based extraction (fast, no AI)
      2. AI extraction for ambiguous cases (optional)

    Returns:
        {lat, lng, granularity, confidence, specific_location, method,
         location_text, city_fallback}
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT a.id, a.title, a.body, a.source_id,
                   a.extracted_lat, a.extracted_lng, a.extracted_location,
                   a.auto_categorize_city_label,
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
    city_label = row.get("auto_categorize_city_label") or row.get("extracted_location") or ""

    # Pass 1: Pattern-based extraction
    locations = _extract_locations_from_text(title, body)
    ranked = _rank_locations(locations, source_country)

    # Check if we have a specific location (finer than city)
    specific = None
    for loc in ranked:
        if loc.get("granularity") in ("landmark", "street", "neighborhood", "district"):
            specific = loc
            break

    if specific:
        # Try to geocode the specific location
        city_hint = city_label.split(",")[0].strip() if city_label else None
        geocoded = _geocode_specific(specific["text"], city_hint, source_country)
        if geocoded:
            lat, lng = _deterministic_jitter(article_id, geocoded["lat"], geocoded["lng"], 100)
            return {
                "lat": lat,
                "lng": lng,
                "granularity": specific["granularity"],
                "confidence": 0.9,
                "specific_location": specific["text"],
                "method": "pattern_specific",
                "location_text": f"{specific['text']}, {city_label}",
                "city_fallback": False,
            }

    # Pass 2: AI extraction (if enabled and pattern extraction didn't find specific)
    if use_ai and not specific:
        ai_locations = _ai_extract_locations(title, body, source_country)
        if ai_locations:
            for loc in ai_locations:
                granularity = loc.get("granularity", "city")
                if granularity in ("landmark", "street", "neighborhood", "district"):
                    geocoded = _geocode_specific(loc["text"], city_label.split(",")[0].strip(), source_country)
                    if geocoded:
                        lat, lng = _deterministic_jitter(article_id, geocoded["lat"], geocoded["lng"], 100)
                        return {
                            "lat": lat,
                            "lng": lng,
                            "granularity": granularity,
                            "confidence": 0.85,
                            "specific_location": loc["text"],
                            "method": "ai_specific",
                            "location_text": f"{loc['text']}, {city_label}",
                            "city_fallback": False,
                        }

    # Fallback: Use city centroid with jitter
    if old_lat and old_lng:
        lat, lng = _deterministic_jitter(article_id, old_lat, old_lng, 300)
        return {
            "lat": lat,
            "lng": lng,
            "granularity": "city_fallback",
            "confidence": 0.3,
            "specific_location": None,
            "method": "city_fallback_jitter",
            "location_text": city_label,
            "city_fallback": True,
        }

    return None


def _geocode_specific(location_text: str, city_hint: str | None, country_hint: str | None) -> dict | None:
    """Geocode a specific location with city/country context.

    Priority:
      1. Local gazetteer (fast, no rate limit, trusted data)
      2. cities_text database
      3. Nominatim with viewbox bias
    """
    # Priority 1: Local gazetteer lookup
    try:
        from .gazetteer import lookup_gazetteer
        # Get city coordinates for spatial search
        city_lat, city_lng = None, None
        if city_hint:
            try:
                stats = cities_text.stats(city_hint)
                if stats and stats.get("primary"):
                    city_lat = float(stats["primary"]["lat"])
                    city_lng = float(stats["primary"]["lng"])
            except Exception:
                pass

        matches = lookup_gazetteer(
            location_text,
            lat=city_lat,
            lng=city_lng,
            radius_km=50,
            limit=3,
            min_similarity=0.35,
        )
        if matches:
            best = matches[0]
            if best["similarity"] >= 0.4:
                return {
                    "lat": best["lat"],
                    "lng": best["lng"],
                    "name": best["label"],
                    "confidence": "high" if best["similarity"] >= 0.7 else "medium",
                    "source": "gazetteer",
                    "entity_type": best["entity_type"],
                }
    except Exception as e:
        log.debug("Gazetteer lookup failed for %s: %s", location_text, e)

    # Priority 2: cities_text database
    try:
        stats = cities_text.stats(location_text)
        if stats and stats.get("primary"):
            primary = stats["primary"]
            return {
                "lat": float(primary["lat"]),
                "lng": float(primary["lng"]),
                "name": primary.get("name"),
                "confidence": "high" if primary.get("population", 0) >= 100000 else "medium",
                "source": "cities_text",
            }
    except Exception:
        pass

    # Priority 3: Nominatim with viewbox bias
    try:
        import httpx
        params = {
            "q": location_text,
            "format": "json",
            "limit": "1",
        }
        if city_hint:
            # Add viewbox bias
            city_stats = cities_text.stats(city_hint)
            if city_stats and city_stats.get("primary"):
                primary = city_stats["primary"]
                lat, lng = float(primary["lat"]), float(primary["lng"])
                # Create a ~50km viewbox around the city
                offset = 0.25  # ~25km
                params["viewbox"] = f"{lng-offset},{lat+offset},{lng+offset},{lat-offset}"
                params["bounded"] = "1"

        with httpx.Client(timeout=5) as client:
            resp = client.get(
                "https://nominatim.openstreetmap.org/search",
                params=params,
                headers={"User-Agent": "xyzo.org/1.0"},
            )
            if resp.status_code == 200:
                results = resp.json()
                if results and len(results) > 0:
                    r = results[0]
                    return {
                        "lat": float(r["lat"]),
                        "lng": float(r["lon"]),
                        "name": r.get("display_name", ""),
                        "confidence": "medium",
                        "source": "nominatim",
                    }
    except Exception as e:
        log.debug("Nominatim geocode failed for %s: %s", location_text, e)

    return None


# ── Backfill script ──────────────────────────────────────────────────

def backfill_granularity(limit: int = 500, use_ai: bool = False) -> dict:
    """Backfill granularity for existing articles.

    Re-extracts location granularity for articles that don't have it yet.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id FROM news_articles
            WHERE status = 'extracted'
              AND location_granularity IS NULL
              AND extracted_lat IS NOT NULL
            ORDER BY fetched_at DESC
            LIMIT %s
        """, (limit,))
        article_ids = [r["id"] for r in cur.fetchall()]

    processed = 0
    updated = 0
    by_granularity = {}

    for aid in article_ids:
        result = extract_and_geocode(aid, use_ai=use_ai)
        if result:
            with connect() as conn, conn.cursor() as cur:
                cur.execute("""
                    UPDATE news_articles
                    SET location_granularity = %s,
                        location_confidence = %s,
                        location_source = %s,
                        specific_location = %s,
                        extracted_lat = %s,
                        extracted_lng = %s
                    WHERE id = %s
                """, (
                    result["granularity"],
                    result["confidence"],
                    result["method"],
                    result.get("specific_location"),
                    result["lat"],
                    result["lng"],
                    aid,
                ))
            updated += 1
            gran = result["granularity"]
            by_granularity[gran] = by_granularity.get(gran, 0) + 1

        processed += 1

    return {
        "processed": processed,
        "updated": updated,
        "by_granularity": by_granularity,
    }
