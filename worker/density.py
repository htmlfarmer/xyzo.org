"""Density detector — finds suspicious pin clusters that may be mislocated.

When many pins cluster in one city (e.g. 15 pins all in "Berlin" from
various countries), it often means the geocoder picked the wrong city.
This module:

  1. Finds cities with unusually high pin density (scaled by city size)
  2. Cross-checks source countries against the cluster's country
  3. Re-reads the full article text to find better location matches
  4. Spreads clustered pins slightly so they don't stack on one point
  5. Flags articles for AI review when text parsing can't resolve

Usage:
    from worker.density import analyze_density, auto_correct_density
    report = analyze_density()           # just analyze
    fixes = auto_correct_density()       # analyze + fix what we can
"""
from __future__ import annotations

import logging
import math
import random
import json
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from . import cities_text, classify
from .db import connect
from .auto_categorize import _detect_country_mentions, _load_source_cache
from .geo_utils import haversine_km as _haversine_km

log = logging.getLogger("xyzo.density")

# Progress file for real-time updates
PROGRESS_DIR = Path(__file__).parent.parent / "logs" / "density-progress"

# ── Dynamic density thresholds based on city population ──────────────
# Big cities can absorb more pins; small cities get flagged sooner.
# Format: (min_population, max_pins_before_flag, spread_radius_km)
# These are generous because source_fallback places many articles at HQ.
DENSITY_TIERS = [
    (10_000_000, 200, 20),   # megacities: 200 pins, 20km spread
    (5_000_000,  150, 18),   # large metro
    (1_000_000,  100, 15),   # major city
    (500_000,    60,  12),   # mid city
    (250_000,    40,  10),   # small city
    (100_000,    25,  8),    # town
    (0,          15,  5),    # village / unknown
]

# Capital cities and major hubs get extra allowance because many
# national sources are headquartered there.
CAPITAL_CITY_BONUS = 2.0  # Double the max_allowed for capitals

SOURCE_COUNTRY_MISMATCH_PCT = 0.4  # if >40% of cluster pins are from different countries, suspicious


def _get_density_tier(population: int | None, is_capital: bool = False) -> tuple[int, float]:
    """Return (max_pins, spread_radius_km) for a given population."""
    pop = population or 0
    for min_pop, max_pins, radius in DENSITY_TIERS:
        if pop >= min_pop:
            if is_capital:
                max_pins = int(max_pins * CAPITAL_CITY_BONUS)
            return max_pins, radius
    return (30 if is_capital else 15), 5


def _snap_to_major_city(lat: float, lng: float, min_pop: int = 100_000) -> dict | None:
    """Nearest world_cities row with population >= min_pop.

    Used to re-anchor pin spreads: a cluster anchored to a rural point
    (e.g. five national German papers geocoded onto a Saarland radio
    transmitter) must be redistributed around the nearest MAJOR CITY,
    not scattered across farmland. Returns {id,name,country_code,lat,
    lng,population,dist_km} or None when nothing qualifies nearby.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, name, country_code, lat, lng, population,
                   ST_Distance(geom::geography,
                     ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography) / 1000.0 AS dist_km
            FROM world_cities
            WHERE population >= %s
            ORDER BY geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
            LIMIT 1
            """,
            (lng, lat, min_pop, lng, lat),
        )
        return cur.fetchone()


def _spread_pins_around_city(
    pins: list[dict],
    city_lat: float,
    city_lng: float,
    spread_km: float,
) -> list[dict]:
    """Spread pins in a natural pattern around a city center.

    Uses a sunflower spiral so pins fan out evenly instead of
    stacking on one point. Distance from center scales with pin
    index so the densest pins stay closest.

    For large clusters (>50 pins), the spread radius is automatically
    increased so pins don't overlap too much.
    """
    n = len(pins)
    if n <= 1:
        return pins

    # Scale spread radius with cluster size
    # More pins = need more space to spread out
    if n > 200:
        spread_km = max(spread_km, 25)
    elif n > 100:
        spread_km = max(spread_km, 18)
    elif n > 50:
        spread_km = max(spread_km, 12)

    # Golden angle spiral — gives even distribution
    golden_angle = math.pi * (3 - math.sqrt(5))
    # Convert spread_km to approximate degrees
    spread_deg = spread_km / 111

    results = []
    for i, pin in enumerate(pins):
        # Radius grows with sqrt(i) for even density
        r = spread_deg * math.sqrt((i + 1) / n) * 0.8
        theta = i * golden_angle
        offset_lat = city_lat + r * math.cos(theta)
        offset_lng = city_lng + r * math.sin(theta) / math.cos(math.radians(city_lat))
        results.append({**pin, "_spread_lat": round(offset_lat, 6), "_spread_lng": round(offset_lng, 6)})

    return results


def analyze_density(since_hours: int = 168, bbox: list[float] | None = None) -> dict:
    """Analyze pin density with dynamic thresholds.

    Args:
        since_hours: Only analyze pins fetched within this many hours
        bbox: Optional [minLng, minLat, maxLng, maxLat] to restrict analysis

    Returns:
        {
            clusters: [{lat, lng, city, country, population, pin_count,
                        max_allowed, spread_km, pins: [...], suspicious, reasons}],
            total_pins: int,
            flagged_pins: int,
        }
    """
    with connect() as conn, conn.cursor() as cur:
        # Build query with optional bbox filter
        bbox_filter = ""
        params = [since_hours]
        if bbox and len(bbox) == 4:
            min_lng, min_lat, max_lng, max_lat = bbox
            bbox_filter = "AND a.extracted_lat BETWEEN %s AND %s AND a.extracted_lng BETWEEN %s AND %s"
            params.extend([min_lat, max_lat, min_lng, max_lng])

        cur.execute(f"""
            SELECT a.id, a.title, a.event_type,
                   a.extracted_lat, a.extracted_lng, a.extracted_location,
                   a.auto_categorize_city_label, a.auto_categorize_method,
                   a.source_id, s.country as source_country, s.name as source_name,
                   s.source_type
            FROM news_articles a
            JOIN news_sources s ON s.id = a.source_id
            WHERE a.extracted_lat IS NOT NULL AND a.extracted_lng IS NOT NULL
              AND a.status = 'extracted'
              AND a.fetched_at > now() - (%s || ' hours')::interval
              {bbox_filter}
        """, tuple(params))
        pins = cur.fetchall()

    if not pins:
        return {"clusters": [], "total_pins": 0, "flagged_pins": 0}

    # Cluster pins by proximity (grid-based, adaptive size)
    # Use a finer grid for denser areas
    grid_size_km = 30  # 30km grid cells
    grid_size_deg = grid_size_km / 111
    grid = defaultdict(list)

    for pin in pins:
        lat = float(pin["extracted_lat"])
        lng = float(pin["extracted_lng"])
        grid_key = (round(lat / grid_size_deg), round(lng / grid_size_deg))
        grid[grid_key].append(pin)

    # Also merge adjacent grid cells that are both dense
    merged = {}
    processed = set()
    for key, cell_pins in grid.items():
        if key in processed:
            continue
        # Check adjacent cells
        r, c = key
        nearby_keys = [(r+dr, c+dc) for dr in [-1,0,1] for dc in [-1,0,1]]
        merged_pins = []
        for nk in nearby_keys:
            if nk in grid:
                merged_pins.extend(grid[nk])
                processed.add(nk)
        if len(merged_pins) >= 3:
            merged[key] = merged_pins

    # Find dense clusters
    clusters = []
    for grid_key, cluster_pins in merged.items():
        if len(cluster_pins) < 3:
            continue

        # Calculate centroid
        avg_lat = sum(float(p["extracted_lat"]) for p in cluster_pins) / len(cluster_pins)
        avg_lng = sum(float(p["extracted_lng"]) for p in cluster_pins) / len(cluster_pins)

        # Find the city name most common in the cluster
        city_labels = [p.get("auto_categorize_city_label") or p.get("extracted_location") or "" for p in cluster_pins]
        city_counts = defaultdict(int)
        for label in city_labels:
            if label:
                city_counts[label] += 1
        top_city = max(city_counts, key=city_counts.get) if city_counts else "unknown"

        # Look up city population from the city database
        population = 0
        city_info = None
        is_capital = False
        try:
            stats = cities_text.stats(top_city)
            if stats and stats.get("primary"):
                city_info = stats["primary"]
                population = city_info.get("population") or 0
        except Exception:
            pass

        # Check if this is a capital city or major hub
        # Capitals get extra pin allowance because many national sources HQ there
        CAPITAL_CITIES = {
            "washington", "london", "paris", "berlin", "tokyo", "beijing",
            "moscow", "canberra", "ottawa", "new delhi", "islamabad",
            "dhaka", "cairo", "abuja", "nairobi", "pretoria", "brasilia",
            "buenos aires", "mexico city", "seoul", "bangkok", "hanoi",
            "jakarta", "manila", "kuala lumpur", "singapore", "riyadh",
            "tehran", "baghdad", "ankara", "rome", "madrid", "lisbon",
            "amsterdam", "brussels", "vienna", "prague", "warsaw",
            "kyiv", "bucharest", "athens", "dublin", "edinburgh",
            "stockholm", "oslo", "copenhagen", "helsinki", "tallinn",
            "riga", "vilnius", "bern", "luxembourg", "monaco",
            "andorra la vella", "san marino", "vatican city",
            "addis ababa", "accra", "dar es salaam", "kampala",
            "kigali", "dakar", "bamako", "ouagadougou", "niamey",
            "n'djamena", "khartoum", "juba", "mogadishu", "djibouti",
            "asmara", "antananarivo", "port louis", "victoria",
            "colombo", "kathmandu", "thimphu", "male", "kabul",
            "dushanbe", "bishkek", "tashkent", "ashgabat", "astana",
            "ulaanbaatar", "pyongyang", "taipei", "ulaanbaatar",
        }
        city_name_lower = top_city.split(",")[0].strip().lower()
        if city_name_lower in CAPITAL_CITIES:
            is_capital = True

        # Dynamic thresholds based on city size
        max_allowed, spread_km = _get_density_tier(population, is_capital)

        # Check source country mismatch
        source_countries = [p.get("source_country") for p in cluster_pins if p.get("source_country")]
        country_counts = defaultdict(int)
        for cc in source_countries:
            country_counts[cc] += 1

        # Extract country from the cluster location
        cluster_country = None
        for label in city_labels:
            if ", " in label:
                cluster_country = label.split(", ")[-1].strip().upper()
                break

        # Count pins from different countries
        mismatch_count = 0
        if cluster_country and source_countries:
            for cc in source_countries:
                if cc.upper() != cluster_country:
                    mismatch_count += 1
            mismatch_pct = mismatch_count / len(source_countries)
        else:
            mismatch_pct = 0

        # Determine if suspicious
        suspicious = False
        reasons = []

        pin_count = len(cluster_pins)
        if pin_count > max_allowed:
            suspicious = True
            reasons.append(f"density: {pin_count} pins (max {max_allowed} for pop {population:,})")

        if mismatch_pct > SOURCE_COUNTRY_MISMATCH_PCT:
            suspicious = True
            reasons.append(f"country mismatch: {mismatch_pct:.0%} foreign sources")

        # Check if all pins have the same location text (likely all from source fallback)
        unique_locations = set(city_labels)
        if len(unique_locations) == 1 and pin_count >= 5:
            methods = [p.get("auto_categorize_method") for p in cluster_pins]
            if methods.count("source_fallback") > len(methods) * 0.5:
                suspicious = True
                reasons.append("mostly source fallback")

        # Calculate actual spread of pins in the cluster
        if pin_count >= 3:
            distances = []
            for p in cluster_pins:
                d = _haversine_km(avg_lat, avg_lng,
                                  float(p["extracted_lat"]), float(p["extracted_lng"]))
                distances.append(d)
            avg_distance = sum(distances) / len(distances)
            max_distance = max(distances)
            # If all pins are within 1km, they're basically stacked
            if max_distance < 1.0:
                reasons.append(f"stacked: all pins within {max_distance:.1f}km")

        clusters.append({
            "lat": round(avg_lat, 4),
            "lng": round(avg_lng, 4),
            "city": top_city,
            "country": cluster_country,
            "population": population,
            "pin_count": pin_count,
            "max_allowed": max_allowed,
            "spread_km": spread_km,
            "source_countries": dict(country_counts),
            "mismatch_pct": round(mismatch_pct * 100),
            "suspicious": suspicious,
            "reasons": reasons,
            "pin_ids": [p["id"] for p in cluster_pins],
        })

    # Sort by pin count descending
    clusters.sort(key=lambda c: c["pin_count"], reverse=True)

    flagged = sum(1 for c in clusters if c["suspicious"])

    return {
        "clusters": clusters[:100],
        "total_pins": len(pins),
        "flagged_pins": flagged,
    }


def re_read_article(article_id: int) -> dict | None:
    """Re-read an article's FULL body to find a better location.

    Uses the complete body text (not just first 200 chars) and
    cross-checks with source country. Returns a new location
    decision or None if the current one is better.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT a.id, a.title, a.body, a.source_id,
                   a.extracted_lat, a.extracted_lng, a.extracted_location,
                   s.country as source_country, s.name as source_name
            FROM news_articles a
            LEFT JOIN news_sources s ON s.id = a.source_id
            WHERE a.id = %s
        """, (article_id,))
        row = cur.fetchone()

    if not row:
        return None

    title = row.get("title") or ""
    body = row.get("body") or ""
    source_id = row.get("source_id")
    source_country = (row.get("source_country") or "").upper()

    # Parse FULL body for city mentions (not just 200 chars)
    full_text = f"{title}\n{body}"
    stats = cities_text.stats(full_text)
    primary = stats.get("primary")

    if not primary:
        return None

    # Cross-check with source country
    city_country = (primary.get("country_code") or "").upper()
    if source_country and city_country and source_country != city_country:
        mentioned = _detect_country_mentions(title) | _detect_country_mentions(body[:2000])
        if source_country in mentioned and city_country not in mentioned:
            return None

    # Check if this is a better match than what we had
    old_lat = float(row["extracted_lat"]) if row.get("extracted_lat") else None
    old_lng = float(row["extracted_lng"]) if row.get("extracted_lng") else None
    new_lat = float(primary["lat"])
    new_lng = float(primary["lng"])

    if old_lat and old_lng:
        distance = _haversine_km(old_lat, old_lng, new_lat, new_lng)
        if distance < 30:
            return None  # Not worth changing

    return {
        "article_id": article_id,
        "new_city": primary,
        "new_lat": new_lat,
        "new_lng": new_lng,
        "new_location": f"{primary['name']}, {primary.get('country_code', '')}",
        "old_lat": old_lat,
        "old_lng": old_lng,
        "distance_km": round(_haversine_km(old_lat or 0, old_lng or 0, new_lat, new_lng)) if old_lat else None,
        "confidence": "high" if primary.get("population", 0) >= 1_000_000 else "medium",
    }


def auto_correct_density(max_fixes: int = 100, job_id: str | None = None, bbox: list[float] | None = None) -> dict:
    """Analyze density and auto-correct what we can without AI.

    For each suspicious cluster:
      1. Try to re-read full article text → find a better city
      2. If better city found, relocate the pin
      3. If same city but pins are stacked, spread them around
      4. If neither works, flag for AI review

    Args:
        max_fixes: Maximum articles to relocate
        job_id: If provided, writes real-time progress to a file
        bbox: Optional [minLng, minLat, maxLng, maxLat] to restrict to viewport

    Returns:
        {analyzed, relocated, spread, flagged_for_ai, clusters_found}
    """
    progress_file = None
    if job_id:
        PROGRESS_DIR.mkdir(parents=True, exist_ok=True)
        progress_file = PROGRESS_DIR / f"{job_id}.json"

    def update_progress(step: str, detail: str, current: int = 0, total: int = 0, article_title: str = "", article_url: str = ""):
        if not progress_file:
            return
        try:
            data = {
                "step": step,
                "detail": detail,
                "current": current,
                "total": total,
                "article_title": article_title[:100],
                "article_url": article_url[:200],
                "updated_at": time.time(),
            }
            tmp = progress_file.with_suffix(".tmp")
            with open(tmp, "w") as f:
                json.dump(data, f)
            tmp.replace(progress_file)
        except Exception:
            pass

    update_progress("analyzing", "Running density analysis on pins in viewport...")

    report = analyze_density(bbox=bbox)
    source_cache = _load_source_cache()

    relocated = 0
    spread = 0
    flagged = 0
    suspicious = [c for c in report["clusters"] if c["suspicious"]]
    total_clusters = len(suspicious)

    update_progress("correcting", f"Found {total_clusters} suspicious clusters. Processing...", 0, total_clusters)

    for ci, cluster in enumerate(suspicious):
        city_lat = cluster["lat"]
        city_lng = cluster["lng"]
        spread_km = cluster["spread_km"]
        pin_ids = cluster["pin_ids"]  # Process ALL pins in cluster, not just 30
        city_name = cluster.get("city", "unknown")

        update_progress("correcting",
                       f"Cluster {ci+1}/{total_clusters}: {city_name} ({cluster['pin_count']} pins)",
                       ci, total_clusters)

        # Phase 1: Try to relocate pins to better cities via full-text re-read
        remaining_ids = []
        for pin_id in pin_ids:
            if relocated >= max_fixes:
                break

            # Get article title for progress
            article_title = ""
            article_url = ""
            try:
                with connect() as conn, conn.cursor() as cur:
                    cur.execute("SELECT title, url FROM news_articles WHERE id = %s", (pin_id,))
                    row = cur.fetchone()
                    if row:
                        article_title = row.get("title", "")
                        article_url = row.get("url", "")
            except Exception:
                pass

            update_progress("relocating",
                           f"Checking article in {city_name}...",
                           relocated, max_fixes,
                           article_title, article_url)

            result = re_read_article(pin_id)
            if result and result.get("new_city"):
                # Check if the new location is actually different
                if result.get("distance_km") and result["distance_km"] > 30:
                    with connect() as conn, conn.cursor() as cur:
                        cur.execute("""
                            UPDATE news_articles
                            SET extracted_lat = %s,
                                extracted_lng = %s,
                                extracted_location = %s,
                                location_text = %s,
                                -- re-anchored: let the geocode pass bind
                                -- the new location_text to a fresh row
                                location_id = NULL,
                                geocoded_at = NULL,
                                auto_categorize_method = 'density_corrected',
                                auto_categorize_status = 'corrected'
                            WHERE id = %s
                        """, (
                            result["new_lat"], result["new_lng"],
                            result["new_location"], result["new_location"],
                            pin_id,
                        ))
                    relocated += 1
                    update_progress("relocated",
                                   f"Moved to {result['new_location']} ({result['distance_km']}km away)",
                                   relocated, max_fixes,
                                   article_title, article_url)
                    log.info("density: relocated article %s → %s (%s km)",
                             pin_id, result["new_location"], result["distance_km"])
                    continue

            remaining_ids.append(pin_id)

        # Phase 2: Wiki-geo keyword placement + deterministic spread
        #
        # Instead of the old sunflower spiral (which places pins in an
        # artificial pattern), we now:
        #   a) Try wiki_geo to find a *real* place for each article
        #      (gazetteer landmark, entity HQ, city mentioned in text,
        #      or Wikipedia keyword match).
        #   b) For articles wiki_geo can't resolve, use a deterministic
        #      hash-based offset so the same article always lands at the
        #      same spot (stable across re-runs, no random jitter).
        if len(remaining_ids) >= 2:
            country_code = cluster.get("country") or ""
            if len(country_code) > 3:
                country_code = ""
            country_hint = country_code.upper() if country_code else None

            update_progress("wiki-geo",
                           f"Resolving {len(remaining_ids)} pins in {city_name} via keywords…",
                           ci, total_clusters)

            wiki_resolved = 0
            still_unplaced: list[int] = []

            # Batch fetch all articles for wiki_geo in a single query
            with connect() as conn, conn.cursor() as cur:
                cur.execute("""
                    SELECT id, title, body, word_freq
                    FROM news_articles
                    WHERE id = ANY(%s)
                """, (remaining_ids,))
                articles_for_geo = cur.fetchall()

            # Collect wiki_geo updates for batch execution
            wiki_updates: list[tuple] = []

            for art in articles_for_geo:
                aid = art["id"]
                placed = False
                try:
                    from . import wiki_geo as _wg
                    wf = art.get("word_freq") or {}
                    title = art.get("title") or ""
                    body_text = (art.get("body") or "")[:2000]

                    result = _wg.geolocate_article(
                        aid,
                        word_freq=wf if isinstance(wf, dict) else {},
                        title=title,
                        body=body_text,
                        primary_city={"lat": city_lat, "lng": city_lng},
                        country_hint=country_hint,
                    )
                    if result:
                        wiki_updates.append((
                            result["lat"], result["lng"],
                            result["place_name"], aid,
                        ))
                        wiki_resolved += 1
                        placed = True
                        continue
                except Exception as e:
                    log.debug("wiki_geo failed for article %s in density: %s", aid, e)

                # Phase 2 fallback: try cities_text on full body before hash-spread
                if not placed:
                    try:
                        from . import cities_text as _ct
                        full_body = art.get("body") or ""
                        stats = _ct.stats(full_body, lang=None)
                        primary = stats.get("primary") if stats else None
                        if primary and primary.get("lat") and primary.get("lng"):
                            # Found a city in the full body - use it if it's different from cluster center
                            p_lat = float(primary["lat"])
                            p_lng = float(primary["lng"])
                            d_lat = abs(p_lat - city_lat)
                            d_lng = abs(p_lng - city_lng)
                            # Only use if it's at least 5km away from cluster center
                            if d_lat > 0.05 or d_lng > 0.05:
                                wiki_updates.append((p_lat, p_lng, primary.get("name") or "", aid))
                                wiki_resolved += 1
                                placed = True
                                log.debug("density: cities_text fallback resolved article %s to %s", aid, primary.get("name"))
                                continue
                    except Exception as e:
                        log.debug("cities_text fallback failed for article %s in density: %s", aid, e)

                if not placed:
                    still_unplaced.append(aid)

            # Batch execute wiki_geo updates
            if wiki_updates:
                with connect() as conn, conn.cursor() as cur:
                    for lat, lng, place_name, aid in wiki_updates:
                        cur.execute("""
                            UPDATE news_articles
                            SET extracted_lat = %s,
                                extracted_lng = %s,
                                location_text = %s,
                                location_id = NULL,
                                geocoded_at = NULL,
                                auto_categorize_method = 'wiki_geo'
                            WHERE id = %s
                        """, (lat, lng, place_name, aid))

            if wiki_resolved:
                log.info("density: wiki_geo resolved %d/%d pins in %s",
                         wiki_resolved, len(remaining_ids), city_name)

            # Phase 2b: deterministic hash-based spread for unplaced pins
            if len(still_unplaced) >= 2:
                import hashlib, math as _math

                # Re-anchor rural clusters onto the nearest major city:
                # a transmitter tower or village green is not a place
                # where national-newspaper stories belong. If the cluster
                # center has no ≥100k city under ~60 km we leave pins
                # alone (genuinely regional coverage); otherwise we spread
                # around the CITY, within that city's density tier.
                spread_lat, spread_lng = city_lat, city_lng
                spread_radius_km = 11.0
                try:
                    anchor = _snap_to_major_city(city_lat, city_lng)
                    if anchor and (anchor.get("dist_km") or 0) > 15:
                        if (anchor.get("dist_km") or 0) <= 60:
                            spread_lat = float(anchor["lat"])
                            spread_lng = float(anchor["lng"])
                            _, spread_radius_km = _get_density_tier(anchor.get("population"))
                            log.info("density: re-anchoring %d pins from (%.3f,%.3f) to %s (%.0f km away)",
                                     len(still_unplaced), city_lat, city_lng,
                                     anchor["name"], anchor["dist_km"])
                        else:
                            # Nothing major within 60 km — spread tightly
                            # so we at least don't fabricate a 20 km farm
                            # belt of "city news".
                            spread_radius_km = 3.0
                except Exception as e:
                    log.debug("density snap-to-city failed: %s", e)

                update_progress("spreading",
                                f"Hash-spreading {len(still_unplaced)} remaining pins in {city_name}…",
                                ci, total_clusters)

                with connect() as conn, conn.cursor() as cur:
                    for aid in still_unplaced:
                        h = int(hashlib.md5(str(aid).encode()).hexdigest()[:10], 16)
                        angle = (h % 3600) / 3600.0 * 2 * _math.pi
                        # Normalized radius in [0.2, 1] of the tier budget,
                        # so big cities breathe and small anchors stay tight.
                        r_frac = 0.2 + (h % 1000) / 1000.0 * 0.8
                        radius_km = spread_radius_km * r_frac
                        radius_deg = radius_km / 111.0
                        cos_lat = _math.cos(_math.radians(spread_lat)) or 0.3
                        offset_lat = radius_deg * _math.cos(angle)
                        offset_lng = radius_deg * _math.sin(angle) / cos_lat

                        cur.execute("""
                            UPDATE news_articles
                            SET extracted_lat = %s,
                                extracted_lng = %s,
                                auto_categorize_method = 'hash_spread'
                            WHERE id = %s
                        """, (round(spread_lat + offset_lat, 6),
                              round(spread_lng + offset_lng, 6), aid))

                spread += len(still_unplaced)
                update_progress("spread",
                               f"wiki_geo: {wiki_resolved} resolved, {len(still_unplaced)} hash-spread in {city_name}",
                               ci, total_clusters)

        # Phase 3: Flag remaining for AI — batch update instead of per-pin
        if remaining_ids:
            with connect() as conn, conn.cursor() as cur:
                cur.execute("""
                    UPDATE news_articles
                    SET auto_categorize_status = 'density_flagged',
                        error_message = %s
                    WHERE id = ANY(%s) AND auto_categorize_status != 'density_corrected'
                """, (f"density: {cluster['pin_count']} pins at {city_name}", remaining_ids))
            flagged += len(remaining_ids)

    update_progress("done", f"Complete: {relocated} relocated, {spread} spread, {flagged} flagged")

    # Clean up progress file after a delay
    if progress_file:
        try:
            progress_file.unlink(missing_ok=True)
        except Exception:
            pass

    return {
        "analyzed": report["total_pins"],
        "relocated": relocated,
        "spread": spread,
        "flagged_for_ai": flagged,
        "clusters_found": len(report["clusters"]),
        "suspicious_clusters": total_clusters,
    }
