"""Gazetteer builder — populates the local gazetteer from Wikipedia/Wikidata.

Pulls articles with geo-coordinates from the Wikipedia API, extracts
entity types, and stores them in the gazetteer table for fuzzy matching.

Usage:
    from worker.gazetteer import build_gazetteer, lookup_gazetteer
    build_gazetteer(lat=28.6, lng=77.2, radius_km=100)  # Delhi region
    matches = lookup_gazetteer("Lajpat Nagar", lat=28.6, lng=77.2)
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

import httpx

from .db import connect

log = logging.getLogger("xyzo.gazetteer")

WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
USER_AGENT = "xyzo.org/1.0 (https://xyzo.org; contact@xyzo.org)"

# Entity type classification from Wikipedia categories
ENTITY_TYPE_MAP = {
    # Neighborhoods and areas
    "neighborhood": ["neighborhood", "neighbourhood", "locality", "area", "colony", "nagar", "puram", "ganj", "peth", "pally", "halli", "pet"],
    "district": ["district", "ward", "borough", "tehsil", "taluk", "mandal"],
    # Landmarks
    "landmark": ["monument", "memorial", "statue", "fountain", "arch", "gate", "tower", "fort", "palace", "castle"],
    "building": ["building", "skyscraper", "headquarters", "office", "complex", "museum", "gallery", "library", "theater", "theatre", "cinema"],
    # Transport
    "metro_station": ["metro station", "railway station", "train station", "subway station", "station"],
    "airport": ["airport", "airfield"],
    # Religious
    "temple": ["temple", "mandir", "kovil"],
    "mosque": ["mosque", "masjid"],
    "church": ["church", "cathedral", "chapel", "basilica"],
    # Nature
    "park": ["park", "garden", "forest", "reserve", "sanctuary"],
    "lake": ["lake", "pond", "reservoir", "dam"],
    "river": ["river", "stream", "canal"],
    # Commercial
    "market": ["market", "bazaar", "mall", "shopping", "marketplace"],
    "hospital": ["hospital", "clinic", "medical center", "health center"],
    "university": ["university", "college", "institute", "academy", "school"],
    # Generic
    "city": ["city", "town", "village", "municipality"],
    "region": ["state", "province", "region", "territory"],
}


def _classify_entity(title: str, categories: list[str]) -> str:
    """Classify entity type from title and Wikipedia categories."""
    title_lower = title.lower()
    cats_text = " ".join(categories).lower()

    # Check title first
    for entity_type, keywords in ENTITY_TYPE_MAP.items():
        for kw in keywords:
            if kw in title_lower:
                return entity_type

    # Check categories
    for entity_type, keywords in ENTITY_TYPE_MAP.items():
        for kw in keywords:
            if kw in cats_text:
                return entity_type

    return "landmark"  # Default to landmark for geo-tagged articles


def _extract_aliases(title: str) -> list[str]:
    """Extract alternative names from title."""
    aliases = []

    # Remove parenthetical disambiguation
    clean = re.sub(r'\s*\([^)]+\)\s*', '', title).strip()
    if clean != title:
        aliases.append(clean)

    # Common abbreviations
    words = title.split()
    if len(words) > 1:
        # Initials (e.g., "Connaught Place" → "CP")
        initials = "".join(w[0].upper() for w in words if w[0].isupper())
        if len(initials) >= 2:
            aliases.append(initials)

    return aliases


def build_gazetteer(
    lat: float = 28.6,
    lng: float = 77.2,
    radius_km: int = 100,
    limit: int = 5000,
    batch_size: int = 50,
) -> dict:
    """Build gazetteer from Wikipedia articles with coordinates.

    Wikipedia API limits radius to 10km max, so for larger areas we
    make multiple requests with offset grid points.

    Args:
        lat: Center latitude
        lng: Center longitude
        radius_km: Search radius (will be split into 10km chunks)
        limit: Max articles to fetch
        batch_size: Articles per API request

    Returns:
        {fetched, inserted, skipped, errors}
    """
    fetched = 0
    inserted = 0
    skipped = 0
    errors = 0
    seen_ids = set()

    # Get existing source_ids to skip
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT source_id FROM gazetteer WHERE source = 'wikipedia'")
        existing = {r["source_id"] for r in cur.fetchall()}

    # Wikipedia API max radius is 10km, so we need to tile larger areas
    max_radius_m = 10000  # 10km
    actual_radius_m = min(radius_km * 1000, max_radius_m)

    # Generate grid points for larger areas
    grid_points = [(lat, lng)]
    if radius_km > 10:
        # Create grid of points covering the area
        step_deg = 0.09  # ~10km
        lat_range = radius_km / 111.0
        lng_range = radius_km / (111.0 * abs(lat * 3.14159 / 180))

        lat_steps = int(lat_range / step_deg) + 1
        lng_steps = int(lng_range / step_deg) + 1

        for i in range(-lat_steps, lat_steps + 1):
            for j in range(-lng_steps, lng_steps + 1):
                grid_lat = lat + i * step_deg
                grid_lng = lng + j * step_deg
                grid_points.append((grid_lat, grid_lng))

    log.info("Building gazetteer around %.2f, %.2f (%d grid points, radius %dkm)",
             lat, lng, len(grid_points), radius_km)

    for grid_lat, grid_lng in grid_points:
        if fetched >= limit:
            break

        continue_token = None
        while fetched < limit:
            params = {
                "action": "query",
                "list": "geosearch",
                "gscoord": f"{grid_lat}|{grid_lng}",
                "gsradius": str(actual_radius_m),
                "gslimit": str(min(batch_size, limit - fetched)),
                "format": "json",
                "origin": "*",
            }
            if continue_token:
                params["gscontinue"] = continue_token

            try:
                with httpx.Client(timeout=30) as client:
                    resp = client.get(
                        WIKIPEDIA_API,
                        params=params,
                        headers={"User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT},
                    )
                    resp.raise_for_status()
                    data = resp.json()
            except Exception as e:
                log.error("Wikipedia API failed: %s", e)
                errors += 1
                break

            pages = data.get("query", {}).get("geosearch", [])
            if not pages:
                break

            # Fetch detailed info for each page
            page_ids = [str(p["pageid"]) for p in pages if str(p["pageid"]) not in seen_ids]
            if not page_ids:
                break

            for i in range(0, len(page_ids), 50):
                batch = page_ids[i:i+50]
                try:
                    detail_params = {
                        "action": "query",
                        "pageids": "|".join(batch),
                        "prop": "categories|extracts|pageprops",
                        "cllimit": "20",
                        "exintro": "true",
                        "explaintext": "true",
                        "exlimit": "50",
                        "format": "json",
                        "origin": "*",
                    }
                    with httpx.Client(timeout=30) as client:
                        detail_resp = client.get(
                            WIKIPEDIA_API,
                            params=detail_params,
                            headers={"User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT},
                        )
                        detail_resp.raise_for_status()
                        detail_data = detail_resp.json()

                    for pid, page in detail_data.get("query", {}).get("pages", {}).items():
                        if str(pid) in existing:
                            skipped += 1
                            continue

                        title = page.get("title", "")
                        categories = [c.get("title", "").replace("Category:", "") for c in page.get("categories", [])]
                        extract = page.get("extract", "")
                        latlng = next((p for p in pages if p["pageid"] == int(pid)), None)

                        if not latlng:
                            continue

                        entity_type = _classify_entity(title, categories)
                        aliases = _extract_aliases(title)

                        # Extract country from categories
                        country_code = None
                        for cat in categories:
                            cat_lower = cat.lower()
                            if "india" in cat_lower:
                                country_code = "IN"
                            elif "pakistan" in cat_lower:
                                country_code = "PK"
                            elif "bangladesh" in cat_lower:
                                country_code = "BD"
                            # Add more as needed

                        # Calculate importance from page props
                        importance = 0.5
                        pageprops = page.get("pageprops", {})
                        if pageprops.get("wikibase_item"):
                            importance = 0.7  # Has Wikidata item

                        try:
                            with connect() as conn, conn.cursor() as cur:
                                cur.execute("""
                                    INSERT INTO gazetteer (
                                        source, source_id, label, aliases, entity_type,
                                        city, country_code, lat, lng, importance, description
                                    ) VALUES ('wikipedia', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                                    ON CONFLICT (source, source_id) DO NOTHING
                                """, (
                                    str(pid),
                                    title,
                                    aliases,
                                    entity_type,
                                    None,  # city — will be filled by backfill
                                    country_code,
                                    latlng["lat"],
                                    latlng["lon"],
                                    importance,
                                    extract[:500] if extract else None,
                                ))
                                if cur.rowcount > 0:
                                    inserted += 1
                                else:
                                    skipped += 1
                        except Exception as e:
                            log.debug("Insert failed for %s: %s", title, e)
                            errors += 1

                        seen_ids.add(str(pid))
                        fetched += 1

                except Exception as e:
                    log.error("Batch fetch failed: %s", e)
                    errors += 1

            # Check for continuation
            continue_token = data.get("continue", {}).get("gscontinue")
            if not continue_token:
                break

            time.sleep(0.5)  # Be polite

    return {
        "fetched": fetched,
        "inserted": inserted,
        "skipped": skipped,
        "errors": errors,
    }


def lookup_gazetteer(
    query: str,
    lat: float | None = None,
    lng: float | None = None,
    radius_km: int = 100,
    limit: int = 5,
    min_similarity: float = 0.35,
    auto_build: bool = True,
) -> list[dict]:
    """Fuzzy match a location string against the gazetteer.

    Uses pg_trgm trigram similarity for matching. Results are ranked by:
      1. Similarity score
      2. Entity type specificity (landmark > city)
      3. Distance from reference point (if provided)

    If auto_build=True and no results found, triggers a background
    gazetteer build for the area.

    Args:
        query: Location string to match
        lat: Reference latitude for distance ranking
        lng: Reference longitude for distance ranking
        radius_km: Max search radius
        limit: Max results
        min_similarity: Minimum similarity threshold (0-1)
        auto_build: If True, trigger background build when area is empty

    Returns:
        [{label, entity_type, lat, lng, similarity, distance_km, importance}]
    """
    with connect() as conn, conn.cursor() as cur:
        if lat is not None and lng is not None:
            # Spatial + text search
            cur.execute("""
                SELECT
                    g.label,
                    g.aliases,
                    g.entity_type,
                    g.lat,
                    g.lng,
                    g.importance,
                    g.description,
                    GREATEST(
                        similarity(g.label, %s),
                        CASE WHEN %s = ANY(g.aliases) THEN 0.9 ELSE 0 END
                    ) AS sim_score,
                    ST_Distance(
                        g.geom,
                        ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
                    ) / 1000 AS distance_km
                FROM gazetteer g
                WHERE (
                    similarity(g.label, %s) >= %s
                    OR %s = ANY(g.aliases)
                )
                AND ST_DWithin(
                    g.geom,
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                    %s * 1000
                )
                ORDER BY
                    GREATEST(
                        similarity(g.label, %s),
                        CASE WHEN %s = ANY(g.aliases) THEN 0.9 ELSE 0 END
                    ) DESC,
                    CASE g.entity_type
                      WHEN 'landmark' THEN 1
                      WHEN 'neighborhood' THEN 2
                      WHEN 'metro_station' THEN 3
                      WHEN 'market' THEN 4
                      WHEN 'building' THEN 5
                      WHEN 'district' THEN 6
                      WHEN 'city' THEN 7
                      ELSE 8
                    END,
                    distance_km ASC
                LIMIT %s
            """, (
                query, query, lng, lat,
                query, min_similarity, query,
                lng, lat, radius_km,
                query, query, limit,
            ))
        else:
            # Text-only search
            cur.execute("""
                SELECT
                    g.label,
                    g.aliases,
                    g.entity_type,
                    g.lat,
                    g.lng,
                    g.importance,
                    g.description,
                    GREATEST(
                        similarity(g.label, %s),
                        CASE WHEN %s = ANY(g.aliases) THEN 0.9 ELSE 0 END
                    ) AS sim_score,
                    0 AS distance_km
                FROM gazetteer g
                WHERE similarity(g.label, %s) >= %s
                   OR %s = ANY(g.aliases)
                ORDER BY
                    GREATEST(
                        similarity(g.label, %s),
                        CASE WHEN %s = ANY(g.aliases) THEN 0.9 ELSE 0 END
                    ) DESC,
                    CASE g.entity_type
                      WHEN 'landmark' THEN 1
                      WHEN 'neighborhood' THEN 2
                      WHEN 'metro_station' THEN 3
                      WHEN 'market' THEN 4
                      WHEN 'building' THEN 5
                      WHEN 'district' THEN 6
                      WHEN 'city' THEN 7
                      ELSE 8
                    END
                LIMIT %s
            """, (query, query, query, min_similarity, query, query, query, limit))

        rows = cur.fetchall()

    results = [{
        "label": r["label"],
        "aliases": r["aliases"],
        "entity_type": r["entity_type"],
        "lat": float(r["lat"]),
        "lng": float(r["lng"]),
        "importance": float(r["importance"]),
        "description": r["description"],
        "similarity": float(r["sim_score"]),
        "distance_km": round(float(r["distance_km"]), 1),
    } for r in rows]

    # Auto-build gazetteer for this area if empty and coordinates provided
    if not results and auto_build and lat is not None and lng is not None:
        _trigger_background_build(lat, lng, radius_km)

    return results


# Track builds in progress to avoid duplicate triggers
_builds_in_progress: set[str] = set()


def _trigger_background_build(lat: float, lng: float, radius_km: int) -> None:
    """Trigger a background gazetteer build for an area.

    Uses a grid key to avoid duplicate builds for nearby coordinates.
    """
    import threading

    # Round to ~50km grid to avoid duplicate builds
    grid_key = f"{round(lat * 2)},{round(lng * 2)}"
    if grid_key in _builds_in_progress:
        return

    _builds_in_progress.add(grid_key)

    def _build():
        try:
            log.info("Auto-building gazetteer for %.1f, %.1f (radius %dkm)", lat, lng, radius_km)
            build_gazetteer(lat=lat, lng=lng, radius_km=min(radius_km, 50), limit=2000)
            log.info("Auto-build complete for %.1f, %.1f", lat, lng)
        except Exception as e:
            log.warning("Auto-build failed for %.1f, %.1f: %s", lat, lng, e)
        finally:
            _builds_in_progress.discard(grid_key)

    thread = threading.Thread(target=_build, daemon=True)
    thread.start()


def build_gazetteer_for_region(region_name: str) -> dict:
    """Build gazetteer for a named region using city database.

    Finds all major cities in the region and builds gazetteer entries
    for each one.
    """
    from . import cities_text

    # Get cities from the database
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT name, country_code, lat, lng, population
            FROM world_cities
            WHERE population >= 100000
              AND (country_code = %s OR name ILIKE %s)
            ORDER BY population DESC
            LIMIT 50
        """, (region_name.upper(), f"%{region_name}%"))
        cities = cur.fetchall()

    if not cities:
        return {"error": f"No cities found for region: {region_name}"}

    total_fetched = 0
    total_inserted = 0

    for city in cities:
        lat = float(city["lat"])
        lng = float(city["lng"])
        result = build_gazetteer(lat=lat, lng=lng, radius_km=10, limit=500)
        total_fetched += result["fetched"]
        total_inserted += result["inserted"]

    return {
        "region": region_name,
        "cities_processed": len(cities),
        "total_fetched": total_fetched,
        "total_inserted": total_inserted,
    }


def gazetteer_stats() -> dict:
    """Get gazetteer statistics."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) as total FROM gazetteer")
        total = cur.fetchone()["total"]

        cur.execute("""
            SELECT entity_type, COUNT(*) as count
            FROM gazetteer
            GROUP BY entity_type
            ORDER BY count DESC
        """)
        by_type = cur.fetchall()

        cur.execute("""
            SELECT country_code, COUNT(*) as count
            FROM gazetteer
            WHERE country_code IS NOT NULL
            GROUP BY country_code
            ORDER BY count DESC
            LIMIT 10
        """)
        by_country = cur.fetchall()

    return {
        "total": total,
        "by_type": [{"type": r["entity_type"], "count": r["count"]} for r in by_type],
        "by_country": [{"country": r["country_code"], "count": r["count"]} for r in by_country],
    }
