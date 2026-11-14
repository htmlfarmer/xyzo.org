"""Explore Region — discover news sources and articles for a geographic area.

Given a bounding box (from the map viewport), this module:
  1. Finds major cities within the bbox via Nominatim
  2. Searches the existing DB for news articles/events in those cities
  3. Uses AI to discover new RSS news sources for the region
  4. Validates discovered RSS feeds (robots.txt, parseability)
  5. Adds validated sources to feeds.json and news_sources table
  6. Optionally triggers a fetch cycle for the new sources

Designed to be called by the API endpoint POST /api/explore-region.
"""

import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import feedparser
import httpx

from .db import connect
from .progress import ProgressWriter
from .robots import RobotsCache
from .fast_suggest import geocode_text
from .immediate_discover import (
    _search_web_for_news,
    _probe_domain_for_feeds,
    _get_country_name,
)

log = logging.getLogger("newsium.explore_region")

NOMINATIM_SEARCH = "https://nominatim.openstreetmap.org/search"
NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "newsium.org/1.0 (https://newsium.org; contact@newsium.org)"
FEEDS_FILE = Path(__file__).parent / "feeds.json"

# Common RSS feed paths to probe when web search finds candidate domains.
# Mirrored from immediate_discover.py so we don't depend on that module's
# private constant.
FEED_PATHS = [
    "/feed", "/rss", "/rss.xml", "/atom.xml", "/feed.xml",
    "/feeds/posts/default", "/rss/feed", "/news/rss",
    "/rss/all.xml", "/en/rss", "/feed/rss", "/index.xml",
]

# AI endpoint for discovering news sources
AI_ENDPOINT = "http://192.168.1.3:8888/chat/stream"
SAFE_HEADERS = {"X-MCP-Safe": "true"}


def _parse_population(value) -> int | None:
    """Parse Nominatim population extratag, tolerating thousands-separator whitespace/commas.

    Returns None for missing/unparseable values rather than raising.
    """
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(value)
    try:
        # Strip thousands separators (both space and comma) before int()
        return int(str(value).replace(" ", "").replace(",", ""))
    except (ValueError, TypeError):
        return None


def _log_step(progress: ProgressWriter | None, step: str, detail: str, **kwargs):
    """Log a step both to the logger and the progress file."""
    log.info("[%s] %s %s", step, detail, " ".join(f"{k}={v}" for k, v in kwargs.items()) if kwargs else "")
    if progress:
        progress.update(step=step, detail=detail)


# ── City discovery via Nominatim ────────────────────────────────────────

def find_cities_in_bbox(bbox: list[float], limit: int = 15, progress: ProgressWriter | None = None) -> list[dict]:
    """Find major cities within a bounding box using Nominatim.

    Args:
        bbox: [minLng, minLat, maxLng, maxLat]
        limit: Max cities to return
        progress: optional ProgressWriter for status updates

    Returns:
        List of {name, country, lat, lng, population, type}
    """
    min_lng, min_lat, max_lng, max_lat = bbox

    # Try local database first (instant, eliminates 15s-30s Nominatim network wait)
    try:
        if progress:
            progress.update(step="cities", detail="Checking local database for known cities...")
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT place_name AS name, country, lat, lng,
                       0 AS population, precision AS type
                FROM news_locations
                WHERE geom IS NOT NULL
                  AND geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                ORDER BY confidence DESC, learned_from_user_count DESC
                LIMIT %s
                """,
                (min_lng, min_lat, max_lng, max_lat, limit),
            )
            db_cities = [dict(r) for r in cur.fetchall()]
            if len(db_cities) >= 3:
                if progress:
                    progress.update(step="cities", detail=f"Found {len(db_cities)} cities in local database")
                return db_cities
    except Exception as e:
        log.warning("Local city lookup failed, falling back to Nominatim: %s", e)
        if progress:
            progress.update(step="cities", detail="Local DB lookup failed, querying Nominatim...")

    # Nominatim search with viewbox for city/town/village
    # We search for multiple place types to get a good mix
    results = []
    seen_names = set()

    for place_type in ["city", "town"]:
        try:
            if progress:
                progress.update(step="cities", detail=f"Querying Nominatim for {place_type} locations...")
            with httpx.Client(timeout=15) as client:
                resp = client.get(
                    NOMINATIM_SEARCH,
                    params={
                        "format": "json",
                        "q": place_type,
                        "viewbox": f"{min_lng},{max_lat},{max_lng},{min_lat}",
                        "bounded": "1",
                        "limit": str(limit),
                        "addressdetails": "1",
                        "extratags": "1",
                    },
                    headers={"User-Agent": USER_AGENT},
                )
                resp.raise_for_status()
                data = resp.json()

            if not isinstance(data, list):
                log.warning("Nominatim returned non-list for %s: %s", place_type, type(data))
                continue

            for item in data:
                if not isinstance(item, dict):
                    continue

                name = item.get("display_name", "").split(",")[0].strip()
                if not name or name in seen_names:
                    continue

                lat = float(item.get("lat", 0))
                lng = float(item.get("lon", 0))

                # Verify it's actually within the bbox
                if not (min_lat <= lat <= max_lat and min_lng <= lng <= max_lng):
                    continue

                addr = item.get("address") or {}
                country = addr.get("country_code", "").upper() if isinstance(addr, dict) else ""
                extratags = item.get("extratags") or {}
                population = extratags.get("population") if isinstance(extratags, dict) else None

                results.append({
                    "name": name,
                    "country": country,
                    "lat": lat,
                    "lng": lng,
                    "population": _parse_population(population),
                    "type": place_type,
                    "osm_id": item.get("osm_id"),
                })
                seen_names.add(name)

        except Exception as e:
            log.warning("Nominatim search failed for %s: %s", place_type, e)

        time.sleep(1.1)  # Respect Nominatim rate limit

    # Sort by population (largest first), then by name
    results.sort(key=lambda x: (-(x.get("population") or 0), x["name"]))
    return results[:limit]


def find_countries_in_bbox(bbox: list[float], progress: ProgressWriter | None = None) -> list[str]:
    """Find country codes within a bounding box using reverse geocoding.

    Samples a few points within the bbox to identify countries.
    """
    min_lng, min_lat, max_lng, max_lat = bbox

    # Try local database first (instant, eliminates 5x reverse geocodes with 1s sleeps)
    try:
        if progress:
            progress.update(step="countries", detail="Checking local database for countries...")
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT UPPER(country) AS country
                FROM news_locations
                WHERE geom IS NOT NULL
                  AND geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                  AND country IS NOT NULL AND length(country) = 2
                LIMIT 20
                """,
                (min_lng, min_lat, max_lng, max_lat),
            )
            db_countries = [r["country"] for r in cur.fetchall() if r.get("country")]
            if db_countries:
                if progress:
                    progress.update(step="countries", detail=f"Found {len(db_countries)} countries in local database")
                return db_countries
    except Exception as e:
        log.warning("Local country lookup failed, falling back to Nominatim: %s", e)
        if progress:
            progress.update(step="countries", detail="Local DB lookup failed, reverse geocoding...")

    # Sample center + 4 corners
    center_lat = (min_lat + max_lat) / 2
    center_lng = (min_lng + max_lng) / 2
    sample_points = [
        (center_lat, center_lng),
        (min_lat, min_lng),
        (min_lat, max_lng),
        (max_lat, min_lng),
        (max_lat, max_lng),
    ]

    countries = set()
    for idx, (lat, lng) in enumerate(sample_points, start=1):
        if progress:
            progress.update(step="countries", detail=f"Reverse geocoding point {idx}/{len(sample_points)}...")
        try:
            with httpx.Client(timeout=10) as client:
                resp = client.get(
                    NOMINATIM_REVERSE,
                    params={
                        "format": "json",
                        "lat": str(lat),
                        "lon": str(lng),
                        "zoom": "5",
                    },
                    headers={"User-Agent": USER_AGENT},
                )
                resp.raise_for_status()
                data = resp.json()
                cc = data.get("address", {}).get("country_code", "").upper()
                if cc:
                    countries.add(cc)
        except Exception as e:
            log.warning("Reverse geocode failed for %s,%s: %s", lat, lng, e)
        time.sleep(1.1)

    return sorted(countries)


# ── Database search for existing news ───────────────────────────────────

def search_existing_news(bbox: list[float], limit: int = 50) -> dict:
    """Search the existing DB for news articles and events within a bbox.

    Returns:
        {
            "articles": [...],
            "events": [...],
            "sources": [...],
            "article_count": int,
            "event_count": int,
            "source_count": int,
        }
    """
    min_lng, min_lat, max_lng, max_lat = bbox

    with connect() as conn, conn.cursor() as cur:
        # Find articles with locations in the bbox
        cur.execute(
            """
            SELECT a.id, a.title, a.url, a.published_at, a.event_type,
                   l.place_name, l.country, l.lat, l.lng
            FROM news_articles a
            JOIN news_locations l ON l.id = a.location_id
            WHERE l.geom::geometry && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
              AND a.status IN ('extracted', 'clustered')
            ORDER BY a.published_at DESC NULLS LAST
            LIMIT %s
            """,
            (min_lng, min_lat, max_lng, max_lat, limit),
        )
        articles = [dict(row) for row in cur.fetchall()]

        # Find events with primary locations in the bbox
        cur.execute(
            """
            SELECT e.id, e.event_type, e.headline, e.summary,
                   e.first_reported_at, e.source_count,
                   l.place_name, l.country, l.lat, l.lng
            FROM news_events e
            JOIN news_locations l ON l.id = e.primary_location_id
            WHERE l.geom::geometry && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
              AND (e.expires_at IS NULL OR e.expires_at > now())
            ORDER BY e.first_reported_at DESC
            LIMIT %s
            """,
            (min_lng, min_lat, max_lng, max_lat, limit),
        )
        events = [dict(row) for row in cur.fetchall()]

        # Find sources that have articles in the bbox
        cur.execute(
            """
            SELECT DISTINCT ns.id, ns.name, ns.feed_url, ns.homepage_url,
                   ns.country, ns.region, ns.active, ns.reliability_score
            FROM news_sources ns
            JOIN news_articles na ON na.source_id = ns.id
            JOIN news_locations l ON l.id = na.location_id
            WHERE l.geom::geometry && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
            ORDER BY ns.name
            """,
            (min_lng, min_lat, max_lng, max_lat),
        )
        sources = [dict(row) for row in cur.fetchall()]

    return {
        "articles": articles,
        "events": events,
        "sources": sources,
        "article_count": len(articles),
        "event_count": len(events),
        "source_count": len(sources),
    }


# ── AI-powered news source discovery ────────────────────────────────────

def discover_news_sources_via_web(
    cities: list[dict],
    countries: list[str],
    category_hint: str | None = None,
    progress: ProgressWriter | None = None,
    request_id: int | None = None,
    ctx: Any = None,
) -> dict:
    """Discover RSS news sources by actually searching the web.

    Unlike the AI-suggestion path (which pulls URLs from the model's training
    data and frequently returns dead links), this path:
      1. Builds DuckDuckGo queries from real region + topic signals
      2. Searches DuckDuckGo HTML for candidate news domains
      3. Probes each domain against common RSS path patterns
      4. Returns validated feeds tagged with discovery_method="web_search"

    Args:
        cities: list of {name, country, ...} from Nominatim
        countries: ISO country codes detected in the bbox
        category_hint: optional topic like "technology", "sports"
        progress: optional ProgressWriter for status updates
        request_id: optional resume key

    Returns:
        {
          "queries": [str],            # queries we actually searched
          "domains": [str],            # unique domains returned by DDG
          "sources": [dict],           # validated {name, feed_url, country, ...}
          "probed_count": int,         # how many domain+path probes ran
        }
    """
    queries: list[str] = []
    seen_domains: set[str] = set()
    domains: list[str] = []
    sources: list[dict] = []
    probed_count = 0

    # Build a small set of targeted queries. We favor (city, topic) combos
    # when a category hint is present because that matches how users think
    # about the request ("find tech news in Berlin").
    #
    # IMPORTANT: query + probe budget has to fit inside the API's 60s
    # timeout. Each DuckDuckGo HTML scrape + parse takes ~5-15s, and
    # each RSS probe ~1-3s. With 3 queries + 5 probes we're looking at
    # ~25-50s — comfortable. Anything more risks the timeout that
    # truncates stderr mid-line and produces "Error: nd 50 articles…"
    # garbage on the frontend.
    topic = (category_hint or "").strip()
    city_names = [c["name"] for c in cities[:2] if c.get("name")]
    country_names = [
        _get_country_name(c) for c in countries if _get_country_name(c)
    ]

    candidate_queries: list[str] = []
    # Take ONE (city, topic) combo if available — it's the most targeted.
    if city_names and topic:
        candidate_queries.append(f"{city_names[0]} {topic} news RSS feed")
    # Then ONE broader country+topic combo.
    if country_names and topic:
        candidate_queries.append(f"{country_names[0]} {topic} news RSS")
    # Fall back to a generic country query if we had nothing else.
    if not candidate_queries:
        if city_names:
            candidate_queries.append(f"{city_names[0]} news RSS feed")
        elif country_names:
            candidate_queries.append(f"{country_names[0]} newspaper RSS")
        else:
            candidate_queries.append("local news RSS feed")

    # Cap the total queries we actually run so the worker can finish
    # well inside its 60s budget regardless of how many candidates we
    # built.
    MAX_QUERIES = 3
    candidate_queries = candidate_queries[:MAX_QUERIES]

    # Run each query with a short pause; bail early once we have enough
    # validated sources to avoid hammering search engines. We also bail
    # out of the loop if the first 2 queries both return 0 domains —
    # the html.duckduckgo.com endpoint is prone to bot-blocking, and
    # burning 8s × N more queries just to confirm it's broken is
    # wasteful. The AI fallback below will still cover the gap.
    consecutive_empty = 0
    for query in candidate_queries:
        if len(sources) >= 6:
            break
        if consecutive_empty >= 2:
            log.info("[web_search] aborting after %d empty queries — DDG appears to be blocking", consecutive_empty)
            break
        queries.append(query)
        _log_step(progress, "web_search", f"Searching the web: {query}", query=query)
        try:
            found_domains = _search_web_for_news(query)
        except Exception as e:
            log.warning("Web search failed for %r: %s", query, e)
            found_domains = []
        if not found_domains:
            consecutive_empty += 1
        else:
            consecutive_empty = 0
        for d in found_domains:
            if d not in seen_domains:
                seen_domains.add(d)
                domains.append(d)
        time.sleep(0.2)

    # Probe unique domains for RSS feeds (capped to be polite AND to
    # keep the worker under the timeout).
    probe_limit = 5
    total_domains = min(len(domains), probe_limit)
    for idx, domain in enumerate(domains[:probe_limit], start=1):
        if len(sources) >= 6:
            break
        pct = int((idx / total_domains) * 100) if total_domains > 0 else 0
        _log_step(progress, "web_search",
                  f"Probing {idx}/{total_domains} ({pct}%): {domain}...", domain=domain)
        try:
            feeds = _probe_domain_for_feeds(domain)
        except Exception as e:
            log.warning("Probe failed for %r: %s", domain, e)
            feeds = []
        probed_count += 1
        
        if feeds:
            # Show success with feed count
            if progress:
                progress.update(
                    step="web_search",
                    detail=f"✓ {domain} — found {len(feeds)} feed(s)",
                    counters={"domains_probed": probed_count, "feeds_found": len(sources) + len(feeds)}
                )
        else:
            # Show failure
            if progress:
                progress.update(
                    step="web_search",
                    detail=f"✗ {domain} — no RSS feeds found"
                )
        
        for feed in feeds:
            if ctx is not None:
                ctx.check_cancel()
            feed["country"] = (countries[0] if countries else "").upper()[:2]
            feed["language"] = feed.get("language") or "en"
            feed["region"] = feed.get("region") or "unknown"
            feed["discovery_method"] = "web_search"
            sources.append(feed)
        time.sleep(0.3)

    _log_step(progress, "web_search",
              f"Web search complete: {len(domains)} domains probed, "
              f"{len(sources)} feeds validated",
              queries=len(queries), domains=len(domains), validated=len(sources))

    return {
        "queries": queries,
        "domains": domains,
        "sources": sources,
        "probed_count": probed_count,
    }


def discover_news_sources_with_ai(
    cities: list[dict],
    countries: list[str],
    region_description: str,
    category_hint: str | None = None,
    progress: ProgressWriter | None = None,
    ctx: Any = None,
) -> list[dict]:
    """Use AI to discover news sources for a region.

    Returns list of {name, feed_url, country, language, region, description}
    """
    city_names = [c["name"] for c in cities[:10]]
    country_str = ", ".join(countries) if countries else "unknown"

    topic_line = (
        f"\nTopic focus: {category_hint}\nPrioritize outlets with strong coverage of this topic."
        if category_hint else ""
    )

    prompt = f"""I need to find RSS news feeds for the following geographic region:

Region: {region_description}
Countries: {country_str}
Major cities: {', '.join(city_names)}{topic_line}

Please provide a JSON array of RSS news sources that cover this region. For each source, include:
- name: The news outlet name
- feed_url: The RSS/Atom feed URL (must be a real, working URL)
- country: ISO 2-letter country code
- language: ISO language code (prefer "en" for English)
- region: A descriptive region tag (e.g. "central-america", "caribbean", "south-asia")
- description: Brief description of the outlet

Focus on:
1. Major national/regional newspapers and broadcasters with RSS feeds
2. Wire services and international outlets with regional sections
3. English-language sources when available
4. Government news agencies if they have RSS feeds

Return ONLY a valid JSON array, no other text. Example:
[
  {{"name": "Example News", "feed_url": "https://example.com/rss", "country": "MX", "language": "en", "region": "central-america", "description": "Major Mexican newspaper"}}
]

Return up to 15 sources. Only include sources you are confident have working RSS feeds."""

    _log_step(progress, "discover", f"Querying AI for RSS sources covering {region_description}...")
    
    try:
        sources = _call_ai_for_sources(prompt)
        if sources:
            _log_step(progress, "discover", f"AI returned {len(sources)} source suggestions")
            return sources
        else:
            _log_step(progress, "discover", "AI returned no sources")
    except Exception as e:
        log.warning("AI source discovery failed: %s", e)
        _log_step(progress, "discover", f"AI discovery failed: {str(e)[:100]}")

    # Fallback: use known regional sources
    _log_step(progress, "discover", "Using fallback regional sources")
    return _get_fallback_sources(countries)


def _call_ai_for_sources(prompt: str) -> list[dict]:
    """Call the AI endpoint and parse the response for news sources."""
    ac = httpx.Timeout(30.0)
    with httpx.Client(timeout=ac) as client:
        resp = client.post(
            AI_ENDPOINT,
            json={"message": prompt, "stream": True},
            headers={**SAFE_HEADERS, "Content-Type": "application/json"},
        )
        resp.raise_for_status()

        # Read streaming response
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

    # Extract JSON array from the response
    return _parse_sources_from_ai(full_text)


def _parse_sources_from_ai(text: str) -> list[dict]:
    """Parse news sources from AI response text."""
    # Try to find a JSON array in the response
    matches = re.findall(r'\[[\s\S]*?\]', text)
    for match in matches:
        try:
            sources = json.loads(match)
            if isinstance(sources, list):
                # Validate each source has required fields
                valid = []
                for s in sources:
                    if isinstance(s, dict) and s.get("name") and s.get("feed_url"):
                        # Ensure URL is valid
                        url = s["feed_url"]
                        if url.startswith("http://") or url.startswith("https://"):
                            valid.append({
                                "name": s["name"][:200],
                                "feed_url": url,
                                "country": (s.get("country") or "")[:2].upper(),
                                "language": (s.get("language") or "en")[:5],
                                "region": (s.get("region") or "unknown")[:50],
                                "description": (s.get("description") or "")[:500],
                            })
                return valid[:15]
        except json.JSONDecodeError:
            continue

    return []


def _get_fallback_sources(countries: list[str]) -> list[dict]:
    """Get fallback news sources for known country codes."""
    # Pre-defined sources for common regions
    FALLBACK = {
        "MX": [
            {"name": "El Universal", "feed_url": "https://www.eluniversal.com.mx/rss.xml", "country": "MX", "language": "es", "region": "mexico", "description": "Major Mexican newspaper"},
            {"name": "Mexico News Daily", "feed_url": "https://mexiconewsdaily.com/feed/", "country": "MX", "language": "en", "region": "mexico", "description": "English-language Mexico news"},
        ],
        "GT": [
            {"name": "Prensa Libre", "feed_url": "https://www.prensalibre.com/rss/", "country": "GT", "language": "es", "region": "central-america", "description": "Guatemalan newspaper"},
        ],
        "BZ": [
            {"name": "Amandala", "feed_url": "https://amandala.com.bz/feed/", "country": "BZ", "language": "en", "region": "central-america", "description": "Belize newspaper"},
        ],
        "SV": [
            {"name": "El Faro", "feed_url": "https://elfaro.net/es/rss", "country": "SV", "language": "es", "region": "central-america", "description": "Salvadoran investigative journalism"},
        ],
        "HN": [
            {"name": "La Prensa Honduras", "feed_url": "https://www.laprensa.hn/rss/", "country": "HN", "language": "es", "region": "central-america", "description": "Honduran newspaper"},
        ],
        "NI": [
            {"name": "Confidencial", "feed_url": "https://confidencial.com.ni/feed/", "country": "NI", "language": "es", "region": "central-america", "description": "Nicaraguan news"},
        ],
        "CR": [
            {"name": "Tico Times", "feed_url": "https://ticotimes.net/feed", "country": "CR", "language": "en", "region": "central-america", "description": "Costa Rica English news"},
        ],
        "PA": [
            {"name": "Panama America", "feed_url": "https://www.panamaamerica.com.pa/rss", "country": "PA", "language": "es", "region": "central-america", "description": "Panamanian newspaper"},
        ],
        "CO": [
            {"name": "Colombia Reports", "feed_url": "https://colombiareports.com/feed/", "country": "CO", "language": "en", "region": "south-america", "description": "English-language Colombia news"},
        ],
        "VE": [
            {"name": "Caracas Chronicles", "feed_url": "https://caracaschronicles.com/feed/", "country": "VE", "language": "en", "region": "south-america", "description": "Venezuela analysis"},
        ],
        "BR": [
            {"name": "Rio Times", "feed_url": "https://www.riotimesonline.com/feed/", "country": "BR", "language": "en", "region": "south-america", "description": "Brazil English news"},
        ],
        "AR": [
            {"name": "Buenos Aires Herald", "feed_url": "https://buenosairesherald.com/feed", "country": "AR", "language": "en", "region": "south-america", "description": "Argentina English news"},
        ],
        "PE": [
            {"name": "Peru Reports", "feed_url": "https://perureports.com/feed/", "country": "PE", "language": "en", "region": "south-america", "description": "Peru English news"},
        ],
        "CL": [
            {"name": "Santiago Times", "feed_url": "https://santiagotimes.cl/feed/", "country": "CL", "language": "en", "region": "south-america", "description": "Chile English news"},
        ],
        "EC": [
            {"name": "Ecuador Times", "feed_url": "https://www.ecuadortimes.net/feed/", "country": "EC", "language": "en", "region": "south-america", "description": "Ecuador English news"},
        ],
        "CU": [
            {"name": "Havana Times", "feed_url": "https://havanatimes.org/feed/", "country": "CU", "language": "en", "region": "caribbean", "description": "Cuba news"},
        ],
        "JM": [
            {"name": "Jamaica Observer", "feed_url": "https://www.jamaicaobserver.com/feed/", "country": "JM", "language": "en", "region": "caribbean", "description": "Jamaican newspaper"},
        ],
        "TT": [
            {"name": "Trinidad Express", "feed_url": "https://trinidadexpress.com/feed/", "country": "TT", "language": "en", "region": "caribbean", "description": "Trinidad newspaper"},
        ],
        "NG": [
            {"name": "Premium Times", "feed_url": "https://www.premiumtimesng.com/feed", "country": "NG", "language": "en", "region": "west-africa", "description": "Nigerian investigative news"},
            {"name": "Vanguard Nigeria", "feed_url": "https://www.vanguardngr.com/feed/", "country": "NG", "language": "en", "region": "west-africa", "description": "Nigerian newspaper"},
        ],
        "KE": [
            {"name": "The EastAfrican", "feed_url": "https://www.theeastafrican.co.ke/service/rss/meta/2558/feed.rss", "country": "KE", "language": "en", "region": "east-africa", "description": "East African regional news"},
        ],
        "ZA": [
            {"name": "AllAfrica", "feed_url": "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf", "country": "ZA", "language": "en", "region": "africa", "description": "Pan-African news aggregator"},
        ],
        "IN": [
            {"name": "The Hindu", "feed_url": "https://www.thehindu.com/news/international/feeder/default.rss", "country": "IN", "language": "en", "region": "south-asia", "description": "Major Indian newspaper"},
            {"name": "Times of India", "feed_url": "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", "country": "IN", "language": "en", "region": "south-asia", "description": "Major Indian newspaper"},
        ],
        "PK": [
            {"name": "Dawn Pakistan", "feed_url": "https://www.dawn.com/feeds/home/", "country": "PK", "language": "en", "region": "south-asia", "description": "Major Pakistani newspaper"},
        ],
        "BD": [
            {"name": "The Daily Star", "feed_url": "https://www.thedailystar.net/frontpage/rss.xml", "country": "BD", "language": "en", "region": "south-asia", "description": "Bangladeshi newspaper"},
        ],
        "PH": [
            {"name": "Rappler", "feed_url": "https://www.rappler.com/rss/", "country": "PH", "language": "en", "region": "southeast-asia", "description": "Philippine news"},
        ],
        "TH": [
            {"name": "Bangkok Post", "feed_url": "https://www.bangkokpost.com/rss/data/topstories.xml", "country": "TH", "language": "en", "region": "southeast-asia", "description": "Thai newspaper"},
        ],
        "VN": [
            {"name": "VnExpress", "feed_url": "https://e.vnexpress.net/rss/rss.xml", "country": "VN", "language": "en", "region": "southeast-asia", "description": "Vietnamese news"},
        ],
        "ID": [
            {"name": "Jakarta Post", "feed_url": "https://www.thejakartapost.com/feed", "country": "ID", "language": "en", "region": "southeast-asia", "description": "Indonesian newspaper"},
        ],
        "MY": [
            {"name": "The Star Malaysia", "feed_url": "https://www.thestar.com.my/rss/News/", "country": "MY", "language": "en", "region": "southeast-asia", "description": "Malaysian newspaper"},
        ],
        "SG": [
            {"name": "Straits Times", "feed_url": "https://www.straitstimes.com/news/world/rss.xml", "country": "SG", "language": "en", "region": "southeast-asia", "description": "Singapore newspaper"},
        ],
        "KR": [
            {"name": "Korea Times", "feed_url": "https://www.koreatimes.co.kr/www/rss/rss.xml", "country": "KR", "language": "en", "region": "east-asia", "description": "Korean newspaper"},
            {"name": "Yonhap News", "feed_url": "https://en.yna.co.kr/RSS/news.xml", "country": "KR", "language": "en", "region": "east-asia", "description": "Korean wire service"},
        ],
        "JP": [
            {"name": "Japan Times", "feed_url": "https://www.japantimes.co.jp/feed/", "country": "JP", "language": "en", "region": "east-asia", "description": "Japanese newspaper"},
        ],
        "AU": [
            {"name": "ABC News Australia", "feed_url": "https://www.abc.net.au/news/feed/51120/rss.xml", "country": "AU", "language": "en", "region": "oceania", "description": "Australian broadcaster"},
        ],
        "NZ": [
            {"name": "Radio NZ", "feed_url": "https://www.rnz.co.nz/rss/world.xml", "country": "NZ", "language": "en", "region": "oceania", "description": "New Zealand broadcaster"},
        ],
        # Middle East
        "EG": [
            {"name": "Egyptian Streets", "feed_url": "https://egyptianstreets.com/feed/", "country": "EG", "language": "en", "region": "north-africa", "description": "Egyptian news"},
        ],
        "IQ": [
            {"name": "Iraq News", "feed_url": "https://www.iraqnews.com/feed/", "country": "IQ", "language": "en", "region": "middle-east", "description": "Iraqi news"},
        ],
        "IR": [
            {"name": "Iranian", "feed_url": "https://iranianweekly.com/feed/", "country": "IR", "language": "en", "region": "middle-east", "description": "Iran news"},
        ],
        "SA": [
            {"name": "Arab News", "feed_url": "https://www.arabnews.com/feed", "country": "SA", "language": "en", "region": "middle-east", "description": "Saudi news"},
        ],
        "TR": [
            {"name": "Hurriyet Daily News", "feed_url": "https://www.hurriyetdailynews.com/rss", "country": "TR", "language": "en", "region": "middle-east", "description": "Turkish news"},
        ],
        "IL": [
            {"name": "Times of Israel", "feed_url": "https://www.timesofisrael.com/feed/", "country": "IL", "language": "en", "region": "middle-east", "description": "Israeli news"},
        ],
        "JO": [
            {"name": "Jordan Times", "feed_url": "https://www.jordantimes.com/rss", "country": "JO", "language": "en", "region": "middle-east", "description": "Jordan news"},
        ],
        "LB": [
            {"name": "The Daily Star Lebanon", "feed_url": "https://www.dailystar.com.lb/rss", "country": "LB", "language": "en", "region": "middle-east", "description": "Lebanese news"},
        ],
        "YE": [
            {"name": "Yemen Times", "feed_url": "https://www.yementimes.com/feed/", "country": "YE", "language": "en", "region": "middle-east", "description": "Yemeni news"},
        ],
        "SY": [
            {"name": "Syrian Observer", "feed_url": "https://syrianobserver.com/rss", "country": "SY", "language": "en", "region": "middle-east", "description": "Syrian news"},
        ],
        # Africa
        "GH": [
            {"name": "GhanaWeb", "feed_url": "https://www.ghanaweb.com/rss/rss.php?pid=1", "country": "GH", "language": "en", "region": "west-africa", "description": "Ghana news"},
        ],
        "TZ": [
            {"name": "The Citizen Tanzania", "feed_url": "https://www.thecitizen.co.tz/rss", "country": "TZ", "language": "en", "region": "east-africa", "description": "Tanzanian news"},
        ],
        "UG": [
            {"name": "Daily Monitor Uganda", "feed_url": "https://www.monitor.co.ug/rss/", "country": "UG", "language": "en", "region": "east-africa", "description": "Ugandan news"},
        ],
        "ET": [
            {"name": "Addis Standard", "feed_url": "https://addisstandard.com/feed/", "country": "ET", "language": "en", "region": "east-africa", "description": "Ethiopian news"},
        ],
        "SD": [
            {"name": "Sudan Tribune", "feed_url": "https://sudantribune.com/feed/", "country": "SD", "language": "en", "region": "north-africa", "description": "Sudanese news"},
        ],
        "MA": [
            {"name": "Morocco World News", "feed_url": "https://www.moroccoworldnews.com/feed/", "country": "MA", "language": "en", "region": "north-africa", "description": "Moroccan news"},
        ],
        "DZ": [
            {"name": "Algeria Press Service", "feed_url": "https://www.aps.dz/rss.xml", "country": "DZ", "language": "en", "region": "north-africa", "description": "Algerian news"},
        ],
        "TN": [
            {"name": "Tunisia Daily News", "feed_url": "https://www.tunisdailynews.com/feed/", "country": "TN", "language": "en", "region": "north-africa", "description": "Tunisian news"},
        ],
        "NG": [
            {"name": "Premium Times", "feed_url": "https://www.premiumtimesng.com/feed", "country": "NG", "language": "en", "region": "west-africa", "description": "Nigerian investigative news"},
            {"name": "Vanguard Nigeria", "feed_url": "https://www.vanguardngr.com/feed/", "country": "NG", "language": "en", "region": "west-africa", "description": "Nigerian newspaper"},
        ],
        "CM": [
            {"name": "Cameron News", "feed_url": "https://www.cameronnews.com/feed/", "country": "CM", "language": "en", "region": "central-africa", "description": "Cameroonian news"},
        ],
        "CD": [
            {"name": "Radio Okapi", "feed_url": "https://www.radiookapi.net/feed/", "country": "CD", "language": "fr", "region": "central-africa", "description": "Congolese news"},
        ],
        "AO": [
            {"name": "Angola News", "feed_url": "https://www.angolanews.net/feed/", "country": "AO", "language": "en", "region": "central-africa", "description": "Angolan news"},
        ],
        "KE": [
            {"name": "The EastAfrican", "feed_url": "https://www.theeastafrican.co.ke/service/rss/meta/2558/feed.rss", "country": "KE", "language": "en", "region": "east-africa", "description": "East African regional news"},
        ],
        "ZA": [
            {"name": "AllAfrica", "feed_url": "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf", "country": "ZA", "language": "en", "region": "africa", "description": "Pan-African news aggregator"},
        ],
        # South Asia
        "LK": [
            {"name": "Ada Derana Sri Lanka", "feed_url": "https://www.adaderana.lk/rss.php", "country": "LK", "language": "en", "region": "south-asia", "description": "Sri Lankan news"},
        ],
        "NP": [
            {"name": "Nepal News", "feed_url": "https://nepalnews.com/feed/", "country": "NP", "language": "en", "region": "south-asia", "description": "Nepalese news"},
        ],
        "AF": [
            {"name": "Tolo News", "feed_url": "https://www.tolonews.com/rss.xml", "country": "AF", "language": "en", "region": "south-asia", "description": "Afghan news"},
        ],
        # Central Asia & Caucasus
        "KZ": [
            {"name": "Kazakh News", "feed_url": "https://www.kazakhstannews.net/feed/", "country": "KZ", "language": "en", "region": "central-asia", "description": "Kazakh news"},
        ],
        "UZ": [
            {"name": "Uzbek News", "feed_url": "https://www.uzbekistannews.net/feed/", "country": "UZ", "language": "en", "region": "central-asia", "description": "Uzbek news"},
        ],
        "GE": [
            {"name": "Civil.ge", "feed_url": "https://civil.ge/feed/", "country": "GE", "language": "en", "region": "caucasus", "description": "Georgian news"},
        ],
        "UA": [
            {"name": "Kyiv Independent", "feed_url": "https://kyivindependent.com/feed/", "country": "UA", "language": "en", "region": "europe", "description": "Ukrainian news"},
        ],
        "RU": [
            {"name": "Moscow Times", "feed_url": "https://www.themoscowtimes.com/rss", "country": "RU", "language": "en", "region": "europe", "description": "Russian news"},
        ],
        # Southeast Asia
        "MM": [
            {"name": "Myanmar Times", "feed_url": "https://www.mmtimes.com/rss/", "country": "MM", "language": "en", "region": "southeast-asia", "description": "Myanmar news"},
        ],
        "KH": [
            {"name": "Cambodia Daily", "feed_url": "https://www.cambodiadaily.com/feed/", "country": "KH", "language": "en", "region": "southeast-asia", "description": "Cambodian news"},
        ],
        "LA": [
            {"name": "Lao News", "feed_url": "https://www.laonews.com/feed/", "country": "LA", "language": "en", "region": "southeast-asia", "description": "Lao news"},
        ],
        # Latin America
        "BO": [
            {"name": "Bolivia News", "feed_url": "https://www.bolivianews.com/feed/", "country": "BO", "language": "en", "region": "south-america", "description": "Bolivian news"},
        ],
        "PY": [
            {"name": "Paraguay News", "feed_url": "https://www.paraguaynews.net/feed/", "country": "PY", "language": "en", "region": "south-america", "description": "Paraguayan news"},
        ],
        "UY": [
            {"name": "Uruguay News", "feed_url": "https://www.uruguaynews.net/feed/", "country": "UY", "language": "en", "region": "south-america", "description": "Uruguayan news"},
        ],
        # Haiti & Caribbean
        "HT": [
            {"name": "Haiti Libre", "feed_url": "https://www.haitilibre.com/en/rss.html", "country": "HT", "language": "en", "region": "caribbean", "description": "Haitian news"},
        ],
        "DO": [
            {"name": "Dominican Today", "feed_url": "https://www.dominit.com/feed/", "country": "DO", "language": "en", "region": "caribbean", "description": "Dominican news"},
        ],
        "BS": [
            {"name": "The Tribune Bahamas", "feed_url": "https://www.tribune242.com/rss/", "country": "BS", "language": "en", "region": "caribbean", "description": "Bahamas news"},
        ],
        # Small island nations
        "FJ": [
            {"name": "Fiji Times", "feed_url": "https://www.fijitimes.com/feed/", "country": "FJ", "language": "en", "region": "oceania", "description": "Fijian news"},
        ],
        "PG": [
            {"name": "PNG News", "feed_url": "https://www.pngnews.com/feed/", "country": "PG", "language": "en", "region": "oceania", "description": "Papua New Guinea news"},
        ],
        "VU": [
            {"name": "Vanuatu Daily", "feed_url": "https://www.dailypost.vu/feed/", "country": "VU", "language": "en", "region": "oceania", "description": "Vanuatu news"},
        ],
    }

    sources = []
    for cc in countries:
        if cc in FALLBACK:
            sources.extend(FALLBACK[cc])

    return sources[:20]


# ── RSS feed validation ─────────────────────────────────────────────────

def _extract_homepage_from_feed(parsed) -> str | None:
    """Get the publisher's homepage URL from a parsed feed.

    RSS 2.0 puts the link on ``parsed.feed.link`` (plain string).
    Atom uses ``parsed.feed.links`` (list of dicts); we prefer
    ``rel='alternate'`` because that's the publisher's main site.
    ``rel='self'`` is the feed URL itself and matches ``feed_url``
    exactly — not useful for the homepage link.

    Returns ``None`` if no usable link was found.
    """
    try:
        links = parsed.feed.get("links") or []
    except Exception:
        links = []
    # Atom / RSS-with-links: prefer rel='alternate' (the website)
    for l in links:
        if isinstance(l, dict) and l.get("rel") == "alternate" and l.get("href"):
            return str(l["href"])[:500]
    # Fall back: first link with any href (some feeds omit rel)
    for l in links:
        if isinstance(l, dict) and l.get("href"):
            return str(l["href"])[:500]
    # RSS 2.0 simple form
    link = parsed.feed.get("link")
    if isinstance(link, str) and link:
        return link[:500]
    return None


def validate_rss_feed(url: str) -> dict:
    """Validate that a URL is a working RSS/Atom feed.

    Returns:
        {
            "valid": bool,
            "title": str | None,
            "entry_count": int,
            "error": str | None,
            "last_entry_date": str | None,
            "homepage_url": str | None,
        }
    """
    try:
        with httpx.Client(timeout=15, follow_redirects=True) as client:
            resp = client.get(
                url,
                headers={"User-Agent": USER_AGENT},
                timeout=15,
            )
            if resp.status_code >= 400:
                return {
                    "valid": False,
                    "title": None,
                    "entry_count": 0,
                    "error": f"HTTP {resp.status_code}",
                    "last_entry_date": None,
                    "homepage_url": None,
                }

            content = resp.content
            parsed = feedparser.parse(content)

            if parsed.bozo and not parsed.entries:
                return {
                    "valid": False,
                    "title": None,
                    "entry_count": 0,
                    "error": f"Parse error: {parsed.bozo_exception}",
                    "last_entry_date": None,
                    "homepage_url": None,
                }

            title = parsed.feed.get("title", "")
            entries = parsed.entries or []
            last_date = None
            if entries:
                for key in ("published", "updated", "created"):
                    val = entries[0].get(key)
                    if val:
                        last_date = val
                        break

            homepage_url = _extract_homepage_from_feed(parsed)

            return {
                "valid": len(entries) > 0,
                "title": title[:200] if title else None,
                "entry_count": len(entries),
                "error": None if entries else "No entries found",
                "last_entry_date": last_date,
                "homepage_url": homepage_url,
            }

    except Exception as e:
        return {
            "valid": False,
            "title": None,
            "entry_count": 0,
            "error": str(e)[:200],
            "last_entry_date": None,
            "homepage_url": None,
        }


# ── Add source to registry ──────────────────────────────────────────────

# TODO(backfill): Re-validating ~1000 existing feeds to populate
# news_sources.homepage_url would take ~30min of network IO. Write a
# `worker/backfill_homepage_urls.py` script that loops in batches with a
# short sleep, calls validate_rss_feed(feed_url) for each row, and
# UPDATEs the homepage_url column. Run it once after the migration as a
# separate task.

def _geocode_source_location(source: dict, client: httpx.Client | None = None) -> tuple[float | None, float | None, str | None]:
    """Resolve a source's country/region to lat/lng via Nominatim.

    Tries the country code first (faster, more precise), then the
    region, then a combination. Returns ``(lat, lng, display_name)``;
    any element may be ``None`` when geocoding fails.

    Network failures degrade silently — a source with no coordinates
    is still added to feeds.json; the system falls back to article-
    level geocoding for that source.
    """
    country = (source.get("country") or "").strip()
    region = (source.get("region") or "").strip()
    queries: list[str] = []
    if country and region and country.lower() not in region.lower():
        queries.append(f"{region}, {country}")
    if region:
        queries.append(region)
    if country:
        queries.append(country)
    if not queries:
        return None, None, None

    owns_client = client is None
    if owns_client:
        client = httpx.Client(timeout=10)
    try:
        for q in queries:
            # Country names sometimes look like "PK" — Nominatim wants the
            # full name, so map common ISO codes. We only do this for known
            # short codes to avoid breaking user-supplied strings.
            if len(q) <= 3 and q.upper() in _ISO_TO_COUNTRY:
                q = _ISO_TO_COUNTRY[q.upper()]
            try:
                hit = geocode_text(q)
            except Exception as exc:
                log.debug("source geocode %r failed: %s", q, exc)
                continue
            if hit:
                return hit["lat"], hit["lng"], hit.get("display_name")
        return None, None, None
    finally:
        if owns_client:
            client.close()


# Small mapping of the most common ISO codes we see from AI discovery.
# Unknown codes fall through to the raw search.
_ISO_TO_COUNTRY = {
    "PK": "Pakistan", "IN": "India", "BD": "Bangladesh", "NP": "Nepal",
    "LK": "Sri Lanka", "BT": "Bhutan", "MV": "Maldives",
    "MX": "Mexico", "GT": "Guatemala", "HN": "Honduras", "SV": "El Salvador",
    "NI": "Nicaragua", "CR": "Costa Rica", "PA": "Panama", "CU": "Cuba",
    "JM": "Jamaica", "HT": "Haiti", "DO": "Dominican Republic",
    "TT": "Trinidad and Tobago", "BZ": "Belize",
    "BR": "Brazil", "AR": "Argentina", "CL": "Chile", "CO": "Colombia",
    "PE": "Peru", "VE": "Venezuela", "EC": "Ecuador", "BO": "Bolivia",
    "PY": "Paraguay", "UY": "Uruguay", "GY": "Guyana", "SR": "Suriname",
    "NG": "Nigeria", "KE": "Kenya", "ZA": "South Africa", "GH": "Ghana",
    "ET": "Ethiopia", "TZ": "Tanzania", "UG": "Uganda", "SN": "Senegal",
    "CM": "Cameroon", "CI": "Ivory Coast", "BJ": "Benin", "TG": "Togo",
    "BF": "Burkina Faso", "ML": "Mali", "NE": "Niger", "TD": "Chad",
    "GA": "Gabon", "CG": "Congo", "CD": "DR Congo", "AO": "Angola",
    "MZ": "Mozambique", "MG": "Madagascar", "ZW": "Zimbabwe", "ZM": "Zambia",
    "BW": "Botswana", "NA": "Namibia", "MW": "Malawi", "RW": "Rwanda",
    "SO": "Somalia", "SD": "Sudan", "SS": "South Sudan", "LY": "Libya",
    "TN": "Tunisia", "DZ": "Algeria", "MA": "Morocco", "EG": "Egypt",
    "PH": "Philippines", "TH": "Thailand", "VN": "Vietnam",
    "ID": "Indonesia", "MY": "Malaysia", "SG": "Singapore",
    "KR": "South Korea", "JP": "Japan", "TW": "Taiwan", "HK": "Hong Kong",
    "AU": "Australia", "NZ": "New Zealand", "FJ": "Fiji",
    "CN": "China", "RU": "Russia", "MN": "Mongolia",
    "TR": "Turkey", "IR": "Iran", "IQ": "Iraq", "SY": "Syria",
    "LB": "Lebanon", "JO": "Jordan", "PS": "Palestine",
    "SA": "Saudi Arabia", "AE": "United Arab Emirates", "QA": "Qatar",
    "KW": "Kuwait", "BH": "Bahrain", "OM": "Oman", "YE": "Yemen",
    "IL": "Israel", "CY": "Cyprus",
    "FR": "France", "DE": "Germany", "ES": "Spain", "IT": "Italy",
    "GB": "United Kingdom", "PT": "Portugal", "NL": "Netherlands",
    "BE": "Belgium", "CH": "Switzerland", "AT": "Austria",
    "PL": "Poland", "CZ": "Czech Republic", "SK": "Slovakia",
    "HU": "Hungary", "RO": "Romania", "BG": "Bulgaria", "GR": "Greece",
    "HR": "Croatia", "RS": "Serbia", "BA": "Bosnia and Herzegovina",
    "SI": "Slovenia", "AL": "Albania", "MK": "North Macedonia",
    "ME": "Montenegro", "XK": "Kosovo", "MD": "Moldova",
    "UA": "Ukraine", "BY": "Belarus", "LT": "Lithuania", "LV": "Latvia",
    "EE": "Estonia", "FI": "Finland", "SE": "Sweden", "NO": "Norway",
    "DK": "Denmark", "IS": "Iceland", "IE": "Ireland",
    "CA": "Canada", "US": "United States",
    "GE": "Georgia", "AM": "Armenia", "AZ": "Azerbaijan",
    "KG": "Kyrgyzstan", "UZ": "Uzbekistan", "TJ": "Tajikistan",
    "TM": "Turkmenistan", "KZ": "Kazakhstan",
    "BN": "Brunei", "KH": "Cambodia", "LA": "Laos", "MM": "Myanmar",
    "TL": "East Timor", "PG": "Papua New Guinea",
}


def add_source_to_feeds(
    source: dict, progress: ProgressWriter | None = None,
) -> dict:
    """Add a validated news source to feeds.json and news_sources table.

    Args:
        source: {name, feed_url, country, language, region, description,
                 homepage_url?}
        progress: optional ProgressWriter — when present we geocode the
            source here (cheap reuse of the already-running worker) and
            report the new source's coordinates live.

    Returns:
        {added: bool, source_id: int | None, reason: str}
    """
    feed_url = source.get("feed_url", "").strip()
    if not feed_url:
        return {"added": False, "source_id": None, "reason": "missing_feed_url"}

    homepage_url = (source.get("homepage_url") or "").strip()[:500] or None

    # Check if already exists in DB
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, active, lat, lng FROM news_sources WHERE feed_url = %s",
            (feed_url,),
        )
        existing = cur.fetchone()
        if existing:
            return {
                "added": False,
                "source_id": existing["id"],
                "reason": f"already_exists (name={existing['name']}, active={existing['active']})",
            }

    # Add to feeds.json
    feeds_data = _load_feeds_json()
    feed_entry = {
        "name": source["name"],
        "feed_url": feed_url,
        "country": source.get("country", ""),
        "language": source.get("language", "en"),
        "region": source.get("region", "unknown"),
        "enabled": True,
    }
    if homepage_url:
        feed_entry["homepage_url"] = homepage_url
    feeds_data["feeds"].append(feed_entry)
    _save_feeds_json(feeds_data)

    # Add to news_sources table
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO news_sources (name, feed_url, country, language, region, source_type, active, homepage_url)
            VALUES (%s, %s, %s, %s, %s, 'rss', TRUE, %s)
            ON CONFLICT (feed_url) DO NOTHING
            RETURNING id
            """,
            (source["name"], feed_url, source.get("country"), source.get("language", "en"), source.get("region", "unknown"), homepage_url),
        )
        row = cur.fetchone()
        source_id = row["id"] if row else None

    # Geocode the source's country/region so future "news near
    # source-X" queries can use the source's coordinates without
    # re-hitting Nominatim. Wrapped in a try so a Nominatim failure
    # never blocks the source from being added.
    if source_id:
        try:
            with httpx.Client(timeout=10) as client:
                lat, lng, display = _geocode_source_location(source, client=client)
            if lat is not None and lng is not None:
                with connect() as conn, conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE news_sources
                        SET lat = %s, lng = %s,
                            geocoded_at = now(),
                            geocoded_location = %s,
                            geom = ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
                        WHERE id = %s
                        """,
                        (lat, lng, display or "", lng, lat, source_id),
                    )
                if progress:
                    progress.update(
                        counters={"sources_added": 1, "sources_geocoded": 1},
                        recent_source={
                            "id": int(source_id),
                            "name": source["name"],
                            "lat": lat,
                            "lng": lng,
                            "country": source.get("country", ""),
                            "region": source.get("region", ""),
                        },
                    )
            else:
                if progress:
                    progress.update(
                        counters={"sources_added": 1},
                        recent_source={
                            "id": int(source_id),
                            "name": source["name"],
                            "lat": None,
                            "lng": None,
                            "country": source.get("country", ""),
                            "region": source.get("region", ""),
                        },
                    )
        except Exception as exc:
            log.warning("source geocode skipped for %s: %s", source.get("name"), exc)
            if progress:
                progress.update(counters={"sources_added": 1})

    return {"added": True, "source_id": source_id, "reason": "added"}


def _load_feeds_json() -> dict:
    """Load feeds.json file."""
    try:
        with FEEDS_FILE.open() as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"feeds": []}


def _save_feeds_json(data: dict) -> None:
    """Save feeds.json file."""
    with FEEDS_FILE.open("w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# ── Main orchestrator ───────────────────────────────────────────────────

# File to save discovery progress for resume
PROGRESS_FILE = Path(__file__).parent.parent / "logs" / "discovery-progress.json"


def _save_progress(request_id: int | None, step: str, data: dict) -> None:
    """Save discovery progress to disk for resume."""
    if not request_id:
        return
    try:
        PROGRESS_FILE.parent.mkdir(parents=True, exist_ok=True)
        progress_data = {
            "request_id": request_id,
            "step": step,
            "saved_at": time.time(),
            "data": data,
        }
        with open(PROGRESS_FILE, "w") as f:
            json.dump(progress_data, f, default=str)
    except Exception as e:
        log.debug("failed to save progress: %s", e)


def _load_progress(request_id: int) -> dict | None:
    """Load saved progress for a request, if available."""
    try:
        if PROGRESS_FILE.exists():
            with open(PROGRESS_FILE) as f:
                saved = json.load(f)
            if saved.get("request_id") == request_id:
                return saved
    except Exception:
        pass
    return None


def explore_region(
    bbox: list[float],
    auto_add: bool = False,
    progress: ProgressWriter | None = None,
    request_id: int | None = None,
    category_hint: str | None = None,
    ctx: Any = None,
) -> dict:
    """Main entry point: explore a region and discover news sources.

    Args:
        bbox: [minLng, minLat, maxLng, maxLat]
        auto_add: If True, automatically add validated sources to registry
        progress: optional ProgressWriter; when present the orchestrator
            pushes per-step status updates and the source geocoding
            pipeline writes each new source's lat/lng as it's discovered.
        category_hint: optional topic like "technology" to focus the search.

    Returns:
        {
            "bbox": [minLng, minLat, maxLng, maxLat],
            "cities": [...],
            "countries": [...],
            "existing_news": {...},
            "discovered_sources": [...],
            "validated_sources": [...],
            "added_sources": [...],
            "web_search": {...},   # what we searched, domains found, probes
            "summary": str,
        }
    """
    log.info("Exploring region: bbox=%s category=%s", bbox, category_hint)

    # Pull category hint from env if not passed explicitly (set by API
    # route when the request body carried it).
    if not category_hint:
        category_hint = os.environ.get("NEWSIUM_CATEGORY_HINT") or None

    # Check for saved progress (resume support)
    saved = _load_progress(request_id) if request_id else None
    cities = None
    countries = None
    existing_news = None
    discovered = None
    web_search_result = None
    validated = None

    if saved and saved.get("data"):
        log.info("Resuming from saved progress: step=%s", saved.get("step"))
        saved_data = saved["data"]
        cities = saved_data.get("cities")
        countries = saved_data.get("countries")
        existing_news = saved_data.get("existing_news")
        discovered = saved_data.get("discovered")
        web_search_result = saved_data.get("web_search_result")
        validated = saved_data.get("validated")

    # Step 1: Find cities in bbox
    if not cities:
        _log_step(progress, "cities", f"Searching for cities in bbox {bbox}...")
        cities = find_cities_in_bbox(bbox, limit=15, progress=progress)
        _save_progress(request_id, "cities", {"cities": cities, "bbox": bbox})
    city_names = [c["name"] for c in cities]
    _log_step(progress, "cities", f"Found {len(cities)} cities: {', '.join(city_names[:5]) if city_names else 'none'}{'...' if len(city_names) > 5 else ''}")

    # Step 2: Find countries in bbox
    if not countries:
        _log_step(progress, "countries", "Identifying countries in the region...")
        countries = find_countries_in_bbox(bbox, progress=progress)
        _save_progress(request_id, "countries", {"cities": cities, "countries": countries, "bbox": bbox})
    _log_step(progress, "countries", f"Identified {len(countries)} countries: {', '.join(countries) if countries else 'unknown'}")

    # Step 3: Search existing DB for news
    if not existing_news:
        _log_step(progress, "search", "Querying database for existing coverage...")
        existing_news = search_existing_news(bbox, limit=50)
        _save_progress(request_id, "search", {
            "cities": cities, "countries": countries,
            "existing_news": existing_news, "bbox": bbox,
        })
    
    # Show detailed breakdown of existing coverage
    article_count = existing_news.get('article_count', 0)
    event_count = existing_news.get('event_count', 0)
    source_count = existing_news.get('source_count', 0)
    _log_step(progress, "search",
              f"Found existing coverage: {article_count} articles, {event_count} events, {source_count} sources")

    # Step 4: Discover new sources via web search + AI suggestion.
    # We run both and merge. Web search is more reliable (real URLs that
    # actually resolve) but slower; AI suggestions can surface niche local
    # outlets the search engine doesn't index highly.
    region_desc = _build_region_description(cities, countries, bbox)

    if not web_search_result:
        web_search_result = discover_news_sources_via_web(
            cities, countries,
            category_hint=category_hint,
            progress=progress,
            request_id=request_id,
            ctx=ctx,
        )
        _save_progress(request_id, "web_search", {
            "cities": cities, "countries": countries,
            "existing_news": existing_news,
            "web_search_result": web_search_result, "bbox": bbox,
        })

    if not discovered:
        # If web_search already validated enough sources we don't need
        # to also hit the AI endpoint — that call takes ~10-15s and
        # pushes us right against the 60s API timeout. The AI fallback
        # only adds value when web_search came back empty.
        web_validated = len(web_search_result.get("sources") or [])
        ai_sources: list[dict] = []
        if web_validated < 3:
            _log_step(progress, "discover",
                      f"Asking AI for RSS sources covering: {region_desc}...")
            try:
                ai_sources = discover_news_sources_with_ai(
                    cities, countries, region_desc,
                    category_hint=category_hint,
                    progress=progress,
                    ctx=ctx,
                )
            except Exception as e:
                log.warning("AI source discovery failed: %s", e)
                ai_sources = []
            # Tag AI suggestions so the UI can show how each was found.
            for src in ai_sources:
                src.setdefault("discovery_method", "ai_suggestion")
        else:
            _log_step(progress, "discover",
                      f"Skipping AI — web search already produced {web_validated} validated sources")
        discovered = (web_search_result.get("sources") or []) + ai_sources
        _save_progress(request_id, "discover", {
            "cities": cities, "countries": countries,
            "existing_news": existing_news,
            "web_search_result": web_search_result,
            "discovered": discovered, "bbox": bbox,
        })

    _log_step(progress, "discover",
              f"{len(web_search_result.get('sources') or [])} from web search + "
              f"{len(discovered) - len(web_search_result.get('sources') or [])} from AI "
              f"= {len(discovered)} candidate sources")

    # Step 5: Validate discovered sources
    if not validated:
        validated = []
        total = len(discovered)
        for idx, src in enumerate(discovered, start=1):
            feed_url = src.get("feed_url", "unknown")
            name = src.get("name", "unknown")
            # Show progress with percentage
            pct = int((idx / total) * 100) if total > 0 else 0
            _log_step(progress, "validate",
                      f"Validating {idx}/{total} ({pct}%): {name}")
            validation = validate_rss_feed(src["feed_url"])
            src["validation"] = validation
            # Lift the homepage_url out of validation onto the source
            # itself so the UI (renderExploreResults) can render it
            # directly, and so add_source_to_feeds below can persist it
            # onto the news_sources row without re-validating.
            src["homepage_url"] = validation.get("homepage_url")
            if validation["valid"]:
                validated.append(src)
                log.info("  ✓ %s — %d entries, title=%s", feed_url, validation["entry_count"], validation.get("title"))
                # Update progress with success detail
                if progress:
                    progress.update(
                        step="validate",
                        detail=f"✓ {name} — {validation['entry_count']} entries",
                        counters={"sources_validated": len(validated)}
                    )
            else:
                log.info("  ✗ %s — %s", feed_url, validation.get("error", "invalid"))
                # Update progress with failure detail
                if progress:
                    progress.update(
                        step="validate",
                        detail=f"✗ {name} — {validation.get('error', 'invalid')[:50]}"
                    )
            # Save progress after each validation
            _save_progress(request_id, "validate", {
                "cities": cities, "countries": countries,
                "existing_news": existing_news, "discovered": discovered,
                "validated": validated, "bbox": bbox,
            })
            time.sleep(0.5)  # Be polite to feeds

    _log_step(progress, "validate",
              f"Validation done: {len(validated)}/{len(discovered)} feeds are valid")

    # Step 6: Optionally add validated sources
    added = []
    if auto_add:
        total = len(validated)
        for idx, src in enumerate(validated, start=1):
            name = src.get("name", "unknown")
            country = src.get('country', '?')
            pct = int((idx / total) * 100) if total > 0 else 0
            _log_step(progress, "add", f"Adding {idx}/{total} ({pct}%): {name} ({country})")
            result = add_source_to_feeds(src, progress=progress)
            src["add_result"] = result
            if result["added"]:
                added.append(src)
                log.info("  ✓ Added %s (id=%s)", name, result.get("source_id"))
                # Update progress with success
                if progress:
                    progress.update(
                        step="add",
                        detail=f"✓ Added {name} (id={result.get('source_id')})",
                        counters={"sources_added": len(added)}
                    )
            else:
                log.info("  → Skipped %s — %s", name, result.get("reason"))
                # Update progress with skip reason
                if progress:
                    progress.update(
                        step="add",
                        detail=f"→ Skipped {name} — {result.get('reason', 'unknown')[:50]}"
                    )
        _log_step(progress, "add", f"Added {len(added)} new sources to registry")
    else:
        log.info("Auto-add disabled; skipping source registration")
        if progress:
            progress.update(step="add", detail="Auto-add disabled")

    if progress:
        progress.finish(step="discover_complete",
                        detail=f"Discovery done: {len(added)} added, {len(validated)} valid, {len(discovered)} tried")

    # Clean up progress file on completion
    if request_id:
        try:
            PROGRESS_FILE.unlink(missing_ok=True)
        except Exception:
            pass

    # Build summary
    summary_parts = [
        f"Region: {region_desc}",
        f"Cities: {len(cities)}",
        f"Countries: {', '.join(countries) or 'unknown'}",
        f"Existing articles: {existing_news['article_count']}",
        f"Existing events: {existing_news['event_count']}",
        f"Discovered sources: {len(discovered)}",
        f"Valid sources: {len(validated)}",
    ]
    if auto_add:
        summary_parts.append(f"Added to registry: {len(added)}")

    return {
        "bbox": bbox,
        "cities": cities,
        "countries": countries,
        "existing_news": {
            "article_count": existing_news["article_count"],
            "event_count": existing_news["event_count"],
            "source_count": existing_news["source_count"],
            "articles": existing_news["articles"][:20],  # Limit for response size
            "events": existing_news["events"][:20],
            "sources": existing_news["sources"],
        },
        "discovered_sources": discovered,
        "validated_sources": validated,
        "added_sources": added,
        "web_search": {
            "queries": web_search_result.get("queries", []) if web_search_result else [],
            "domains": web_search_result.get("domains", []) if web_search_result else [],
            "probed_count": web_search_result.get("probed_count", 0) if web_search_result else 0,
            "validated_count": len(web_search_result.get("sources", [])) if web_search_result else 0,
        },
        "category_hint": category_hint,
        "summary": " | ".join(summary_parts),
    }


def _build_region_description(cities: list[dict], countries: list[str], bbox: list[float]) -> str:
    """Build a human-readable region description."""
    parts = []

    # Use city names
    if cities:
        city_names = [c["name"] for c in cities[:5]]
        parts.append(f"area around {', '.join(city_names)}")

    # Use country names if available
    if countries:
        parts.append(f"countries: {', '.join(countries)}")

    # Use bbox for general description
    min_lng, min_lat, max_lng, max_lat = bbox
    center_lat = (min_lat + max_lat) / 2
    center_lng = (min_lng + max_lng) / 2

    # Rough region detection based on coordinates
    if 7 <= min_lat <= 18 and -92 <= max_lng <= -77:
        parts.append("Central America")
    elif -56 <= min_lat <= 13 and -82 <= max_lng <= -34:
        parts.append("South America")
    elif 15 <= min_lat <= 33 and -18 <= max_lng <= 52:
        parts.append("North Africa / Middle East")
    elif -36 <= min_lat <= 38 and -18 <= max_lng <= 52:
        parts.append("Africa")
    elif 8 <= min_lat <= 56 and 60 <= max_lng <= 150:
        parts.append("Asia")
    elif 35 <= min_lat <= 72 and -12 <= max_lng <= 45:
        parts.append("Europe")

    return " ".join(parts) if parts else f"region centered at {center_lat:.2f}, {center_lng:.2f}"


# ── CLI entry point ─────────────────────────────────────────────────────

if __name__ == "__main__":
    # Legacy CLI wrapper. The queue-callable handler lives at
    # worker/handlers/explore_region.py — this entry point constructs a
    # no-op ctx and delegates so the existing call shape (`python -m
    # worker.explore_region <minLng> <minLat> <maxLng> <maxLat> ...`)
    # exercises the same code path as the dispatcher, including the
    # ctx-aware ProgressWriter adapter and cancel checkpoints.
    import sys

    from worker.handlers.explore_region import run as _handler_run

    class _NoOpCtx:
        def progress(self, *, step=None, pct=None, message=None, meta=None, state=None):
            pass

        def check_cancel(self):
            pass

        def log(self, level, message, **fields):
            print(f"[{level}] {message}", file=sys.stderr)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if len(sys.argv) < 5:
        print("Usage: python -m worker.explore_region <minLng> <minLat> <maxLng> <maxLat> [--auto-add] [--category <hint>]")
        sys.exit(1)

    bbox = [float(x) for x in sys.argv[1:5]]
    auto_add = "--auto-add" in sys.argv
    category_hint = None
    if "--category" in sys.argv:
        idx = sys.argv.index("--category")
        if idx + 1 < len(sys.argv):
            category_hint = sys.argv[idx + 1]

    payload = {
        "bbox": bbox,
        "auto_add": auto_add,
        "category_hint": category_hint,
    }
    result = _handler_run(payload, _NoOpCtx())
    print(json.dumps(result, indent=2, default=str))
