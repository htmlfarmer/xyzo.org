"""Wikipedia-powered keyword geolocation for news articles.

Uses three data tiers to resolve article keywords to specific places:

  1. **entity_locations** (instant) — 58 company/org → HQ mappings
     ("Apple" → Cupertino).  Already used by cities_text.
  2. **gazetteer** (instant) — ~1k Wikipedia entities with lat/lng
     (landmarks, universities, districts, hospitals …).
  3. **world_cities** (instant) — 8k+ cities with lat/lng + population.
  4. **wiki_articles** (fallback) — 19M Wikipedia articles via full-text
     search.  When a keyword matches a wiki article, we run cities_text
     on the article text to extract place names, then use the most
     prominent city's coordinates.

The point: instead of placing every US political article on the same
Washington dot, an article mentioning "Pentagon" gets matched to the
gazetteer's Pentagon entry (Arlington, VA), and one mentioning "Seattle"
gets placed at Seattle rather than Washington.

Debug-friendly: every resolution step logs *why* it picked a location
so mis-geolocated articles can be traced in the audit log.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from .db import connect

log = logging.getLogger("xyzo.wiki_geo")

# ── Caches (loaded once per process) ────────────────────────────────
_gazetteer_index: dict[str, list[dict]] | None = None
_city_index: dict[str, list[dict]] | None = None
_country_cities: dict[str, list[dict]] | None = None


# ── Tier 1: entity_locations (company → HQ city) ───────────────────

def _check_entity(keyword: str) -> dict | None:
    """Check if keyword matches a known entity (company, org, brand)."""
    from .cities_text import _load_entity_locations
    entities = _load_entity_locations()
    loc = entities.get(keyword.lower())
    if loc:
        return {
            "lat": loc["lat"],
            "lng": loc["lng"],
            "place_name": loc.get("city", keyword),
            "source": "entity",
            "keyword": keyword,
        }
    return None


# ── Tier 2: gazetteer (Wikipedia entities with coords) ──────────────

def _load_gazetteer() -> dict[str, list[dict]]:
    global _gazetteer_index
    if _gazetteer_index is not None:
        return _gazetteer_index
    _gazetteer_index = {}
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT label, aliases, entity_type, lat, lng,
                       country_code, city, importance, population
                FROM gazetteer
            """)
            for row in cur.fetchall():
                label = (row["label"] or "").lower()
                if label:
                    _gazetteer_index.setdefault(label, []).append(dict(row))
                for alias in (row.get("aliases") or []):
                    _gazetteer_index.setdefault(alias.lower(), []).append(dict(row))
        log.info("gazetteer index loaded: %d keys → %d entries",
                 len(_gazetteer_index),
                 sum(len(v) for v in _gazetteer_index.values()))
    except Exception as e:
        log.warning("failed to load gazetteer: %s", e)
    return _gazetteer_index


def _check_gazetteer(keyword: str, country_hint: str | None = None) -> dict | None:
    """Check if keyword matches a gazetteer entry (landmark, district, etc.)."""
    idx = _load_gazetteer()
    matches = idx.get(keyword.lower())
    if not matches:
        return None
    if country_hint:
        country_matches = [m for m in matches
                          if (m.get("country_code") or "").upper() == country_hint.upper()]
        if country_matches:
            best = max(country_matches, key=lambda m: m.get("importance") or 0.5)
        else:
            return None
    else:
        best = max(matches, key=lambda m: m.get("importance") or 0.5)
    return {
        "lat": best["lat"], "lng": best["lng"],
        "place_name": best["label"],
        "entity_type": best.get("entity_type"),
        "source": "gazetteer",
        "keyword": keyword,
    }


# ── Tier 3: world_cities (city name match) ─────────────────────────

def _load_cities() -> tuple[dict[str, list[dict]], dict[str, list[dict]]]:
    global _city_index, _country_cities
    if _city_index is not None:
        return _city_index, _country_cities or {}
    _city_index = {}
    _country_cities = {}
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT id, name, ascii_name, country_code, state_name,
                       lat, lng, population
                FROM world_cities
                WHERE population >= 10000
            """)
            for row in cur.fetchall():
                nm = (row["name"] or "").lower()
                if nm:
                    _city_index.setdefault(nm, []).append(dict(row))
                as_ = (row.get("ascii_name") or "").lower()
                if as_ and as_ != nm:
                    _city_index.setdefault(as_, []).append(dict(row))
                cc = row.get("country_code") or ""
                if cc:
                    _country_cities.setdefault(cc.upper(), []).append(dict(row))
        log.info("city index loaded: %d keys, %d countries",
                 len(_city_index), len(_country_cities or {}))
    except Exception as e:
        log.warning("failed to load world_cities: %s", e)
    return _city_index, _country_cities or {}


def _check_city(keyword: str, country_hint: str | None = None) -> dict | None:
    """Check if keyword is a city name."""
    idx, _ = _load_cities()
    matches = idx.get(keyword.lower())
    if not matches:
        return None
    # If we have a country hint, STRICTLY filter — never return a city
    # in the wrong country (e.g. "Virginia" → Virginia, South Africa
    # when the article is about Virginia, US).
    if country_hint:
        country_matches = [m for m in matches
                          if (m.get("country_code") or "").upper() == country_hint.upper()]
        if not country_matches:
            return None
        best = max(country_matches, key=lambda m: m.get("population") or 0)
    else:
        best = max(matches, key=lambda m: m.get("population") or 0)
    return {
        "lat": best["lat"], "lng": best["lng"],
        "place_name": best["name"],
        "country_code": best.get("country_code"),
        "population": best.get("population"),
        "source": "world_cities",
        "keyword": keyword,
    }


# ── Tier 4: wiki_articles exact-title search → cities_text extraction ─

def _check_wiki(keyword: str, country_hint: str | None = None) -> dict | None:
    """Search wiki_articles by exact title match, extract place names.

    Only matches when the keyword is (or closely matches) the article
    TITLE — not a full-text mention.  This avoids the noise of "MI6"
    matching the Steele dossier (which merely mentions MI6) and instead
    finds the actual Wikipedia article titled "The Pentagon" or "MI6
    headquarters".

    Connects to the *wikipedia* database (XYZO_WIKI_DB_URL).
    """
    try:
        import psycopg
        wiki_dsn = __import__("os").environ.get(
            "XYZO_WIKI_DB_URL",
            os.environ.get("XYZO_WIKI_DB_URL", "postgres://xyzo_app:CHANGE_ME@localhost:5432/wikipedia"),
        )
        with psycopg.connect(wiki_dsn, autocommit=True, row_factory=psycopg.rows.dict_row) as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT wiki_id, title, left(text, 3000) as text
                    FROM wiki_articles
                    WHERE title ILIKE %s
                    ORDER BY article_length DESC NULLS LAST
                    LIMIT 3
                """, (f"%{keyword}%",))
                rows = cur.fetchall()
    except Exception as e:
        log.debug("wiki search failed for %r: %s", keyword, e)
        return None

    if not rows:
        return None

    from . import cities_text

    kw_lower = keyword.lower()

    for row in rows:
        title = (row.get("title") or "").lower()
        # Only accept exact or near-exact title matches.  "Pentagon"
        # should match the article titled "The Pentagon" or "Pentagon"
        # but NOT "Pentagon Papers" or "White House Farm murders".
        if kw_lower not in (title.replace("the ", "").strip(), title):
            if title.replace("the ", "").strip() != kw_lower:
                continue

        text = row.get("text") or ""
        if not text:
            continue
        stats = cities_text.stats(text, min_population=50_000)
        primary = stats.get("primary")
        if primary:
            if country_hint:
                cc = (primary.get("country_code") or "").upper()
                if cc != country_hint.upper():
                    continue
            return {
                "lat": primary["lat"],
                "lng": primary["lng"],
                "place_name": primary["name"],
                "country_code": primary.get("country_code"),
                "population": primary.get("population"),
                "source": "wiki_articles",
                "keyword": keyword,
                "wiki_title": row.get("title"),
            }
    return None


# ── Public API ──────────────────────────────────────────────────────

def extract_keywords(word_freq: dict | None, title: str = "", body: str = "") -> list[str]:
    """Extract geographically interesting keywords from an article.

    Prioritises:
      1. Capitalised words from word_freq (likely proper nouns)
      2. Capitalised words from title
      3. Known entity names (companies, orgs)
    Returns top-10 candidates, longest-first for multi-word matching.
    """
    candidates: dict[str, float] = {}

    if word_freq:
        for word, count in word_freq.items():
            if not word or len(word) < 2:
                continue
            if word[0].isupper() or word.replace(" ", "")[0:1].isupper():
                candidates[word] = candidates.get(word, 0) + count * 2

    title_words = re.findall(r'[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*', title or "")
    for w in title_words:
        if len(w) >= 3:
            candidates[w] = candidates.get(w, 0) + 5

    skip = {
        "The", "This", "That", "These", "Those", "They", "Their",
        "He", "She", "His", "Her", "We", "Our", "It", "Its",
        "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
        "Saturday", "Sunday", "January", "February", "March",
        "April", "May", "June", "July", "August", "September",
        "October", "November", "December",
    }
    candidates = {k: v for k, v in candidates.items() if k not in skip and len(k) >= 3}

    sorted_kw = sorted(candidates, key=lambda k: (-candidates[k], -len(k)))
    return sorted_kw[:10]


COUNTRY_DEMONYMS: dict[str, str] = {
    "chile": "CL", "chilean": "CL",
    "spain": "ES", "spanish": "ES",
    "italy": "IT", "italian": "IT",
    "germany": "DE", "german": "DE",
    "france": "FR", "french": "FR",
    "japan": "JP", "japanese": "JP",
    "brazil": "BR", "brazilian": "BR",
    "mexico": "MX", "mexican": "MX",
    "peru": "PE", "peruvian": "PE",
    "poland": "PL", "polish": "PL",
    "sweden": "SE", "swedish": "SE",
    "norway": "NO", "norwegian": "NO",
    "finland": "FI", "finnish": "FI",
    "greece": "GR", "greek": "GR",
    "turkey": "TR", "turkish": "TR",
    "egypt": "EG", "egyptian": "EG",
    "india": "IN", "indian": "IN",
    "china": "CN", "chinese": "CN",
}


def _check_country_demonym(keyword: str) -> dict | None:
    words = [w.strip() for w in re.split(r'\s+', keyword.lower()) if w.strip()]
    for w in words:
        cc = COUNTRY_DEMONYMS.get(w)
        if cc:
            top_city = get_country_city_with_rank(cc, 1)
            if top_city:
                return {
                    "lat": top_city["lat"],
                    "lng": top_city["lng"],
                    "place_name": f"{top_city['name']}, {cc}",
                    "country_code": cc,
                    "population": top_city.get("population"),
                    "source": "country_demonym",
                    "keyword": w,
                }
    return None


def resolve_keyword(keyword: str, country_hint: str | None = None,
                    use_wiki: bool = False) -> dict | None:
    """Resolve a single keyword to coordinates through the tier pipeline.

    Tiers 1-3 (entity → country_demonym → gazetteer → world_cities) are instant DB lookups.
    Tier 4 (wiki_articles) does an ILIKE on 19M rows — fast with the
    trigram index for short keywords but can be slow for batch runs.
    Pass ``use_wiki=True`` to enable it (e.g. from the API endpoint).

    Returns a result dict with lat, lng, place_name, source, keyword
    or None if no tier matched.
    """
    for tier_fn in [_check_entity, _check_country_demonym, _check_gazetteer, _check_city]:
        try:
            if tier_fn is _check_gazetteer or tier_fn is _check_city:
                result = tier_fn(keyword, country_hint)
            else:
                result = tier_fn(keyword)
            if result:
                return result
        except Exception as e:
            log.debug("tier %s failed for %r: %s", tier_fn.__name__, keyword, e)

    if use_wiki:
        try:
            result = _check_wiki(keyword, country_hint)
            if result:
                return result
        except Exception as e:
            log.debug("wiki tier failed for %r: %s", keyword, e)

    return None


def geolocate_article(
    article_id: int,
    word_freq: dict | None = None,
    title: str = "",
    body: str = "",
    primary_city: dict | None = None,
    country_hint: str | None = None,
    use_wiki: bool = False,
) -> dict | None:
    """Find a more precise location for an article using keyword matching.

    Tries each keyword from the article against all 4 tiers.
    Returns the first non-primary-city match (i.e. a *specific* place
    rather than the city center we already have).

    Args:
        article_id: For logging/audit.
        word_freq: Pre-extracted word frequencies (or None to skip).
        title: Article title.
        body: Article body (first 2000 chars is enough).
        primary_city: The city the article is currently placed at.
            We skip matches that resolve to this same city center.
        country_hint: ISO country code to prefer.

    Returns:
        {lat, lng, place_name, source, keyword} or None.
    """
    keywords = extract_keywords(word_freq, title, body[:500])
    if not keywords:
        return None

    primary_lat = primary_city.get("lat") if primary_city else None
    primary_lng = primary_city.get("lng") if primary_city else None

    context_text = f"{title}\n{body}"
    for kw in keywords:
        try:
            from .place_disambiguation import disambiguate
            keep, reason = disambiguate(kw, context_text, source_country=country_hint)
            if not keep:
                log.info("wiki_geo: keyword %r rejected by disambiguate (%s)", kw, reason)
                continue
        except Exception:
            pass

        result = resolve_keyword(kw, country_hint, use_wiki=use_wiki)
        if result is None:
            continue

        if result.get("place_name"):
            try:
                from .place_disambiguation import disambiguate
                keep, reason = disambiguate(result["place_name"], context_text, source_country=country_hint)
                if not keep:
                    log.info("wiki_geo: place_name %r rejected by disambiguate (%s)", result["place_name"], reason)
                    continue
            except Exception:
                pass

        skip = False
        if primary_lat is not None and primary_lng is not None:
            d_lat = abs(result["lat"] - primary_lat)
            d_lng = abs(result["lng"] - primary_lng)
            if d_lat < 0.01 and d_lng < 0.01:
                skip = True

        if not skip:
            log.info("wiki_geo: article %s keyword %r → %s (%.4f, %.4f) via %s",
                     article_id, kw, result["place_name"],
                     result["lat"], result["lng"], result["source"])
            return result

    return None


# ── Country-level helpers ───────────────────────────────────────────

def get_largest_cities(country_code: str, limit: int = 10) -> list[dict]:
    """Return the largest cities in a country from world_cities."""
    _, country_map = _load_cities()
    cities = country_map.get(country_code.upper(), [])
    return sorted(cities, key=lambda c: c.get("population") or 0, reverse=True)[:limit]


def get_country_city_with_rank(country_code: str, rank: int = 1) -> dict | None:
    """Get the Nth largest city in a country (1 = largest)."""
    cities = get_largest_cities(country_code, limit=rank)
    if len(cities) >= rank:
        return cities[rank - 1]
    return None


# ── Batch: spread articles in a cluster using wiki_geo ──────────────

def spread_cluster(
    article_ids: list[int],
    city_lat: float,
    city_lng: float,
    city_name: str = "",
    country_code: str | None = None,
) -> dict:
    """Re-geolocate articles in a cluster using keyword matching.

    For each article:
      1. Extract keywords from word_freq + title
      2. Try to resolve to a specific place (gazetteer / entity / wiki)
      3. If resolved → use that location
      4. If not → deterministic offset based on article_id

    Returns summary: {resolved, spread, total}.
    """
    import hashlib, math

    resolved = 0
    spread = 0

    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, title, body, word_freq, auto_categorize_city_id
            FROM news_articles
            WHERE id = ANY(%s)
        """, (article_ids,))
        articles = cur.fetchall()

    for art in articles:
        aid = art["id"]
        wf = art.get("word_freq") or {}
        title = art.get("title") or ""
        body = (art.get("body") or "")[:2000]

        primary = {"lat": city_lat, "lng": city_lng} if city_lat else None

        result = geolocate_article(
            aid, word_freq=wf, title=title, body=body,
            primary_city=primary, country_hint=country_code,
        )

        if result:
            with connect() as conn, conn.cursor() as cur:
                cur.execute("""
                    UPDATE news_articles
                    SET extracted_lat = %s,
                        extracted_lng = %s,
                        location_text = %s,
                        auto_categorize_method = 'wiki_geo'
                    WHERE id = %s
                """, (result["lat"], result["lng"],
                      f"{result['place_name']} (via {result['source']}: {result['keyword']})",
                      aid))
            resolved += 1
            continue

        h = int(hashlib.md5(str(aid).encode()).hexdigest()[:8], 16)
        angle = (h % 360) * math.pi / 180
        radius_base = 0.005 + (h % 100) / 10000.0
        offset_lat = radius_base * math.cos(angle)
        offset_lng = radius_base * math.sin(angle) / max(math.cos(math.radians(city_lat)), 0.3)

        new_lat = round(city_lat + offset_lat, 6)
        new_lng = round(city_lng + offset_lng, 6)

        with connect() as conn, conn.cursor() as cur:
            cur.execute("""
                UPDATE news_articles
                SET extracted_lat = %s,
                    extracted_lng = %s,
                    auto_categorize_method = 'hash_spread'
                WHERE id = %s
            """, (new_lat, new_lng, aid))
        spread += 1

    return {"resolved": resolved, "spread": spread, "total": len(articles)}


# ── Top-city regeolocation ─────────────────────────────────────────

def regeolocate_top_cities(
    top_n: int = 20,
    min_articles: int = 20,
) -> dict:
    """Re-geolocate articles in the most-clustered cities.

    Finds the top N cities by article count (where articles share the
    exact same coordinates), then runs wiki_geo + hash-spread on each.

    This is the main entry point for the /api/density/regeolocate
    endpoint and the --regeolocate CLI flag.

    Returns summary: {cities_processed, total_articles, resolved, spread}.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT extracted_lat, extracted_lng,
                   count(*) as cnt,
                   max(location_text) as location_text,
                   max(auto_categorize_city_label) as city_label
            FROM news_articles
            WHERE status = 'extracted'
              AND extracted_lat IS NOT NULL
              AND auto_categorize_method IN ('fast_path', 'source_fallback', 'density_spread', 'hash_spread')
            GROUP BY extracted_lat, extracted_lng
            HAVING count(*) >= %s
            ORDER BY cnt DESC
            LIMIT %s
        """, (min_articles, top_n))
        clusters = cur.fetchall()

    log.info("regeolocate: found %d clusters (top %d, min %d articles each)",
             len(clusters), top_n, min_articles)

    total_resolved = 0
    total_spread = 0
    total_articles = 0

    for cl in clusters:
        lat = float(cl["extracted_lat"])
        lng = float(cl["extracted_lng"])
        cnt = cl["cnt"]
        label = cl.get("city_label") or cl.get("location_text") or f"{lat},{lng}"

        with connect() as conn, conn.cursor() as cur:
            cur.execute("""
                SELECT id FROM news_articles
                WHERE extracted_lat = %s AND extracted_lng = %s
                  AND status = 'extracted'
                ORDER BY id
            """, (lat, lng))
            article_ids = [r["id"] for r in cur.fetchall()]

        if not article_ids:
            continue

        country_code = None
        if label and ", " in label:
            cc = label.split(", ")[-1].strip().upper()
            if len(cc) == 2:
                country_code = cc

        log.info("regeolocate: %s — %d articles at (%.4f, %.4f)",
                 label, len(article_ids), lat, lng)

        result = spread_cluster(
            article_ids,
            city_lat=lat,
            city_lng=lng,
            city_name=label,
            country_code=country_code,
        )
        total_resolved += result["resolved"]
        total_spread += result["spread"]
        total_articles += result["total"]

    summary = {
        "cities_processed": len(clusters),
        "total_articles": total_articles,
        "resolved_by_keyword": total_resolved,
        "hash_spread": total_spread,
    }
    log.info("regeolocate done: %s", summary)
    return summary
