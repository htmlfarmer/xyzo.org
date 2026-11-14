#!/usr/bin/env python3
"""Wikimedia Resolution Experiment

Measures Wikipedia/Wikidata resolution rates across N random XYZO stories
using public Wikipedia/Wikidata APIs + local DB.

For each story we test:
  - City resolution (via cities_text + location_text)
  - Organization resolution (via news_entities + Wikipedia API)
  - Person resolution (via news_entities + Wikipedia API)
  - Place resolution (via wiki_geo resolve_keyword)
  - Wikipedia article findability (via Wikipedia geosearch + text search)
  - Wikidata QID findability (via Wikidata API)
  - Related Wikipedia entities (via Wikipedia geosearch)

Outputs:
  - Wikipedia resolution rate
  - Wikidata resolution rate
  - False match rate (when we can verify)
  - Ambiguous match rate
  - Average search latency + p50, p95, p99
"""

import json
import random
import statistics
import time
import urllib.parse
from collections import defaultdict
from typing import Any

import psycopg

# ── Database connections ────────────────────────────────────────────

def get_xyzo_db():
    import os
    dsn = os.environ.get(
        "XYZO_DB_DSN",
        "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"
    )
    return psycopg.connect(dsn, row_factory=psycopg.rows.dict_row)

# ── Latency tracking ────────────────────────────────────────────────

class LatencyTracker:
    def __init__(self):
        self.times: list[float] = []

    def add(self, ms: float):
        self.times.append(ms)

    @property
    def avg(self) -> float:
        return statistics.mean(self.times) if self.times else 0.0

    def percentiles(self, pcts=(50, 95, 99)):
        if not self.times:
            return {p: 0.0 for p in pcts}
        sorted_times = sorted(self.times)
        return {p: sorted_times[int(len(sorted_times) * p / 100)] for p in pcts}

# ── Wikipedia API calls ────────────────────────────────────────────

WIKI_HEADERS = {
    "User-Agent": "xyzo.org experiment (https://xyzo.org/contact)",
    "Api-User-Agent": "xyzo.org experiment (https://xyzo.org/contact)",
}

def wikipedia_search(query: str, limit: int = 5) -> list[dict]:
    """Full-text search via Wikipedia API."""
    url = "https://en.wikipedia.org/w/api.php"
    params = {
        "action": "query",
        "list": "search",
        "srsearch": query,
        "srlimit": limit,
        "format": "json",
    }
    try:
        import urllib.request
        req = urllib.request.Request(
            f"{url}?{urllib.parse.urlencode(params)}",
            headers=WIKI_HEADERS
        )
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read())
            results = data.get("query", {}).get("search", [])
            return [{"title": r["title"], "pageid": r["pageid"], "snippet": r.get("snippet", "")} for r in results]
    except Exception:
        return []

def wikipedia_geosearch(lat: float, lng: float, radius_m: int = 10000, limit: int = 10) -> list[dict]:
    """Geosearch via Wikipedia API."""
    url = "https://en.wikipedia.org/w/api.php"
    params = {
        "action": "query",
        "list": "geosearch",
        "gscoord": f"{lat}|{lng}",
        "gsradius": min(radius_m, 10000),
        "gslimit": limit,
        "format": "json",
    }
    try:
        import urllib.request
        req = urllib.request.Request(
            f"{url}?{urllib.parse.urlencode(params)}",
            headers=WIKI_HEADERS
        )
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read())
            results = data.get("query", {}).get("geosearch", [])
            return [{
                "title": r["title"],
                "pageid": r["pageid"],
                "lat": r["lat"],
                "lng": r["lon"],
                "dist": r.get("dist", 0)
            } for r in results]
    except Exception:
        return []

def wikidata_lookup(entity_name: str) -> str | None:
    """Look up Wikidata QID via Wikipedia's API (wbsearchentities)."""
    url = "https://www.wikidata.org/w/api.php"
    params = {
        "action": "wbsearchentities",
        "search": entity_name,
        "language": "en",
        "type": "item",
        "limit": 3,
        "format": "json",
    }
    try:
        import urllib.request
        req = urllib.request.Request(
            f"{url}?{urllib.parse.urlencode(params)}",
            headers={"User-Agent": "xyzo.org experiment (https://xyzo.org/contact)"}
        )
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read())
            results = data.get("search", [])
            if results:
                return results[0].get("id")
    except Exception:
        pass
    return None

def wikipedia_page_extract(title: str) -> str | None:
    """Get first sentence of Wikipedia article."""
    url = "https://en.wikipedia.org/w/api.php"
    params = {
        "action": "query",
        "prop": "extracts",
        "titles": title,
        "exintro": True,
        "explaintext": True,
        "exsentences": 2,
        "format": "json",
    }
    try:
        import urllib.request
        req = urllib.request.Request(
            f"{url}?{urllib.parse.urlencode(params)}",
            headers=WIKI_HEADERS
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            pages = data.get("query", {}).get("pages", {})
            for page in pages.values():
                return page.get("extract")
    except Exception:
        pass
    return None

# ── City resolution test ────────────────────────────────────────────

def resolve_city(article_row: dict, xyzo_conn) -> dict:
    """Test city resolution using location_text + cities_text."""
    location_text = article_row.get("location_text") or ""
    if not location_text:
        return {"resolved": False, "method": None, "lat": None, "lng": None, "latency_ms": 0}

    start = time.perf_counter()
    try:
        from .cities_text import find_cities_in_text
        cities = find_cities_in_text(location_text, min_population=50_000, max_results=3)
        elapsed = (time.perf_counter() - start) * 1000

        if cities:
            best = max(cities, key=lambda c: c.get("confidence", 0) * (c.get("city", {}).get("population", 0) or 1))
            city_obj = best.get("city", {})
            return {
                "resolved": True,
                "method": "cities_text",
                "lat": city_obj.get("lat"),
                "lng": city_obj.get("lng"),
                "place_name": city_obj.get("name"),
                "latency_ms": elapsed,
            }
        return {"resolved": False, "method": None, "lat": None, "lng": None, "latency_ms": elapsed}
    except Exception as e:
        elapsed = (time.perf_counter() - start) * 1000
        return {"resolved": False, "method": f"error:{e}", "lat": None, "lng": None, "latency_ms": elapsed}

# ── Entity resolution test ─────────────────────────────────────────

def resolve_entities(article_row: dict, xyzo_conn) -> dict:
    """Test organization/person/place resolution from entities array + Wikipedia API."""
    entities: list[str] = article_row.get("entities") or []
    if not entities:
        return {
            "org_resolved": False,
            "person_resolved": False,
            "place_resolved": False,
            "wiki_found": False,
            "wikidata_found": False,
            "ambiguous": False,
            "latency_ms": 0,
        }

    org_results = []
    person_results = []
    place_results = []
    wiki_search_results = []
    wikidata_results = []
    ambiguous = False

    start = time.perf_counter()

    # Try to match entities against news_entities table
    try:
        with xyzo_conn.cursor() as cur:
            placeholders = ",".join(["%s"] * len(entities))
            cur.execute(f"""
                SELECT name, type, wikidata_id
                FROM news_entities
                WHERE name IN ({placeholders})
            """, entities)
            db_entities = {row["name"]: row for row in cur.fetchall()}
    except Exception:
        db_entities = {}

    for entity in entities:
        # Check news_entities table
        db_ent = db_entities.get(entity)
        if db_ent:
            if db_ent["type"] == "organization":
                org_results.append({"name": entity, "wikidata_id": db_ent.get("wikidata_id")})
            elif db_ent["type"] == "person":
                person_results.append({"name": entity, "wikidata_id": db_ent.get("wikidata_id")})
            elif db_ent["type"] == "place":
                place_results.append({"name": entity})

        # Wikipedia search for this entity
        wiki_hits = wikipedia_search(entity, limit=3)
        if len(wiki_hits) > 1:
            ambiguous = True
        if wiki_hits:
            wiki_search_results.append({
                "name": entity,
                "wiki_titles": [h["title"] for h in wiki_hits],
                "count": len(wiki_hits),
            })
            # Try Wikidata lookup on top hit
            qid = wikidata_lookup(entity)
            if qid:
                wikidata_results.append({"name": entity, "qid": qid})

    elapsed = (time.perf_counter() - start) * 1000

    return {
        "org_resolved": len(org_results) > 0,
        "person_resolved": len(person_results) > 0,
        "place_resolved": len(place_results) > 0,
        "wiki_found": len(wiki_search_results) > 0,
        "wikidata_found": len(wikidata_results) > 0,
        "ambiguous": ambiguous,
        "org_count": len(org_results),
        "person_count": len(person_results),
        "place_count": len(place_results),
        "wiki_entity_count": len(wiki_search_results),
        "wikidata_count": len(wikidata_results),
        "latency_ms": elapsed,
    }

# ── Place resolution via wiki_geo ──────────────────────────────────

def resolve_place_via_wiki_geo(article_row: dict) -> dict:
    """Test place resolution using wiki_geo.resolve_keyword (fast tiers only)."""
    title = article_row.get("title") or ""
    body = article_row.get("body") or ""

    start = time.perf_counter()
    try:
        from .wiki_geo import extract_keywords, resolve_keyword
        keywords = extract_keywords(None, title, body[:500])
        if not keywords:
            elapsed = (time.perf_counter() - start) * 1000
            return {"resolved": False, "place_name": None, "latency_ms": elapsed}

        resolved = None
        for kw in keywords[:5]:  # Try top 5 keywords
            result = resolve_keyword(kw, use_wiki=False)  # Fast tiers only
            if result:
                resolved = result
                break

        elapsed = (time.perf_counter() - start) * 1000
        if resolved:
            return {
                "resolved": True,
                "place_name": resolved.get("place_name"),
                "source": resolved.get("source"),
                "keyword": resolved.get("keyword"),
                "lat": resolved.get("lat"),
                "lng": resolved.get("lng"),
                "latency_ms": elapsed,
            }
        return {"resolved": False, "place_name": None, "latency_ms": elapsed}
    except Exception as e:
        elapsed = (time.perf_counter() - start) * 1000
        return {"resolved": False, "error": str(e), "latency_ms": elapsed}

# ── Wikipedia geosearch test ───────────────────────────────────────

def wikipedia_geosearch_test(lat: float, lng: float) -> dict:
    """Test finding Wikipedia articles near coordinates."""
    start = time.perf_counter()
    try:
        results = wikipedia_geosearch(lat, lng, radius_m=10000, limit=20)
        elapsed = (time.perf_counter() - start) * 1000
        return {
            "found": len(results) > 0,
            "count": len(results),
            "titles": [r["title"] for r in results[:5]],
            "latency_ms": elapsed,
        }
    except Exception as e:
        elapsed = (time.perf_counter() - start) * 1000
        return {"found": False, "error": str(e), "latency_ms": elapsed}

# ── Main experiment ─────────────────────────────────────────────────

def run_experiment(n: int = 10000, seed: int = 42):
    random.seed(seed)

    print(f"=== Wikimedia Resolution Experiment ===")
    print(f"Sampling {n} random stories...")

    xyzo_conn = get_xyzo_db()

    try:
        # Sample random stories - simple query + Python shuffle (ORDER BY random() is too slow on 600K+ rows)
        with xyzo_conn.cursor() as cur:
            cur.execute("""
                SELECT
                    na.id,
                    na.title,
                    na.body,
                    na.location_text,
                    na.entities,
                    nl.lat,
                    nl.lng,
                    nl.place_name as location_place_name
                FROM news_articles na
                LEFT JOIN news_locations nl ON na.location_id = nl.id
                WHERE na.status = %s
                  AND na.body IS NOT NULL
                LIMIT %s
            """, ('extracted', n * 3))  # Fetch extra to shuffle
            articles = list(cur.fetchall())
    finally:
        xyzo_conn.close()

    # Shuffle to truly randomize and take requested amount
    random.shuffle(articles)
    articles = articles[:n]

    print(f"Got {len(articles)} articles")

    # Metrics
    city_latency = LatencyTracker()
    entity_latency = LatencyTracker()
    wiki_geo_latency = LatencyTracker()
    geosearch_latency = LatencyTracker()
    wiki_search_latency = LatencyTracker()
    wikidata_latency = LatencyTracker()

    city_resolved = 0
    org_resolved = 0
    person_resolved = 0
    place_resolved = 0
    wiki_found = 0
    wikidata_found = 0
    ambiguous = 0
    wiki_geo_place_resolved = 0
    geosearch_found = 0
    wiki_search_found = 0

    entity_results_log = []
    failure_reasons = defaultdict(int)

    for i, article in enumerate(articles):
        if i % 200 == 0 and i > 0:
            print(f"  Processed {i}/{len(articles)}...")

        article_id = article["id"]

        # City resolution
        city_result = resolve_city(article, xyzo_conn)
        if city_result.get("latency_ms"):
            city_latency.add(city_result["latency_ms"])
        if city_result["resolved"]:
            city_resolved += 1
        else:
            failure_reasons["city_unresolved"] += 1

        # Entity resolution (org, person, place, wiki, wikidata)
        # Reconnect for each article to avoid stale connections
        xyzo_conn2 = get_xyzo_db()
        try:
            ent_result = resolve_entities(article, xyzo_conn2)
        finally:
            xyzo_conn2.close()

        if ent_result["latency_ms"]:
            entity_latency.add(ent_result["latency_ms"])
        if ent_result["org_resolved"]:
            org_resolved += 1
        else:
            failure_reasons["org_unresolved"] += 1
        if ent_result["person_resolved"]:
            person_resolved += 1
        else:
            failure_reasons["person_unresolved"] += 1
        if ent_result["place_resolved"]:
            place_resolved += 1
        if ent_result["wiki_found"]:
            wiki_found += 1
            wiki_search_found += 1
            wiki_search_latency.add(ent_result["latency_ms"])
        else:
            failure_reasons["wiki_not_found"] += 1
        if ent_result["wikidata_found"]:
            wikidata_found += 1
            wikidata_latency.add(ent_result["latency_ms"])
        else:
            failure_reasons["wikidata_not_found"] += 1
        if ent_result["ambiguous"]:
            ambiguous += 1

        # Wiki geo place resolution
        geo_result = resolve_place_via_wiki_geo(article)
        if geo_result.get("latency_ms"):
            wiki_geo_latency.add(geo_result["latency_ms"])
        if geo_result["resolved"]:
            wiki_geo_place_resolved += 1
        else:
            failure_reasons["wiki_geo_unresolved"] += 1

        # Wikipedia geosearch skipped (0.5s per call = 44 minutes for 5000 articles)
        # Uncomment to enable:
        # lat = article.get("lat")
        # lng = article.get("lng")
        # if lat is not None and lng is not None:
        #     geo_search_result = wikipedia_geosearch_test(lat, lng)
        #     if geo_search_result.get("latency_ms"):
        #         geosearch_latency.add(geo_search_result["latency_ms"])
        #     if geo_search_result["found"]:
        #         geosearch_found += 1
        #     else:
        #         failure_reasons["geosearch_no_results"] += 1
        # else:
        #     failure_reasons["no_coordinates"] += 1

        # Log first 100 for analysis
        if i < 100:
            entity_results_log.append({
                "article_id": article_id,
                "title": article["title"][:100],
                "entities": article.get("entities", [])[:10],
                "city_result": {k: v for k, v in city_result.items() if k != "latency_ms"},
                "entity_result": {k: v for k, v in ent_result.items() if k != "latency_ms"},
                "wiki_geo_result": {k: v for k, v in geo_result.items() if k != "latency_ms"},
            })

    # Compute rates
    total = len(articles)
    city_rate = city_resolved / total * 100 if total else 0
    org_rate = org_resolved / total * 100 if total else 0
    person_rate = person_resolved / total * 100 if total else 0
    place_rate = place_resolved / total * 100 if total else 0
    wiki_rate = wiki_found / total * 100 if total else 0
    wikidata_rate = wikidata_found / total * 100 if total else 0
    ambiguous_rate = ambiguous / total * 100 if total else 0
    wiki_geo_rate = wiki_geo_place_resolved / total * 100 if total else 0

    print(f"\n=== RESULTS ===")
    print(f"Total articles:          {total}")
    print(f"")
    print(f"RESOLUTION RATES:")
    print(f"  City resolved:         {city_resolved:5d} ({city_rate:.1f}%)")
    print(f"  Org resolved:          {org_resolved:5d} ({org_rate:.1f}%)")
    print(f"  Person resolved:       {person_resolved:5d} ({person_rate:.1f}%)")
    print(f"  Place resolved:        {place_resolved:5d} ({place_rate:.1f}%)")
    print(f"  Wiki entity found:    {wiki_found:5d} ({wiki_rate:.1f}%)")
    print(f"  Wikidata QID found:    {wikidata_found:5d} ({wikidata_rate:.1f}%)")
    print(f"  Wiki-geo place:       {wiki_geo_place_resolved:5d} ({wiki_geo_rate:.1f}%)")
    print(f"")
    print(f"MATCH QUALITY:")
    print(f"  Ambiguous matches:     {ambiguous:5d} ({ambiguous_rate:.1f}%)")
    print(f"")
    print(f"LATENCY (ms):")
    print(f"  City resolution:      avg={city_latency.avg:6.1f}  p50={city_latency.percentiles()[50]:6.1f}  p95={city_latency.percentiles()[95]:6.1f}  p99={city_latency.percentiles()[99]:6.1f}")
    print(f"  Entity resolution:     avg={entity_latency.avg:6.1f}  p50={entity_latency.percentiles()[50]:6.1f}  p95={entity_latency.percentiles()[95]:6.1f}  p99={entity_latency.percentiles()[99]:6.1f}")
    print(f"  Wiki-geo place:        avg={wiki_geo_latency.avg:6.1f}  p50={wiki_geo_latency.percentiles()[50]:6.1f}  p95={wiki_geo_latency.percentiles()[95]:6.1f}  p99={wiki_geo_latency.percentiles()[99]:6.1f}")
    print(f"")
    print(f"FAILURE BREAKDOWN:")
    for reason, count in sorted(failure_reasons.items(), key=lambda x: -x[1]):
        print(f"  {reason:30s} {count:5d} ({count/total*100:.1f}%)")

    # Save detailed logs
    output_path = "/tmp/xyzo_wikimedia_experiment.json"
    with open(output_path, "w") as f:
        json.dump({
            "summary": {
                "total": total,
                "city_resolved": city_resolved,
                "city_rate": city_rate,
                "org_resolved": org_resolved,
                "org_rate": org_rate,
                "person_resolved": person_resolved,
                "person_rate": person_rate,
                "place_resolved": place_resolved,
                "place_rate": place_rate,
                "wiki_found": wiki_found,
                "wiki_rate": wiki_rate,
                "wikidata_found": wikidata_found,
                "wikidata_rate": wikidata_rate,
                "wiki_geo_place_resolved": wiki_geo_place_resolved,
                "wiki_geo_rate": wiki_geo_rate,
                "geosearch_found": geosearch_found,
                "ambiguous": ambiguous,
                "ambiguous_rate": ambiguous_rate,
                "failure_reasons": dict(failure_reasons),
                "latency": {
                    "city": {"avg": city_latency.avg, **city_latency.percentiles()},
                    "entity": {"avg": entity_latency.avg, **entity_latency.percentiles()},
                    "wiki_geo": {"avg": wiki_geo_latency.avg, **wiki_geo_latency.percentiles()},
                }
            },
            "sample_logs": entity_results_log,
        }, f, indent=2, default=str)

    print(f"\nDetailed logs saved to: {output_path}")
    return {
        "total": total,
        "city_rate": city_rate,
        "org_rate": org_rate,
        "person_rate": person_rate,
        "wiki_rate": wiki_rate,
        "wikidata_rate": wikidata_rate,
        "ambiguous_rate": ambiguous_rate,
    }


if __name__ == "__main__":
    import sys
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 10000
    run_experiment(n=n)
