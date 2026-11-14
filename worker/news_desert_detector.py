"""News Desert Detector — finds places with high population but low news coverage.

Scoring (pure SQL + Python statistics, no AI required):
  coverage_ratio  = active_sources_within_40km / (population / 100_000)
                  = sources per 100k population
  desert_score    = 1 - (city_coverage_ratio / global_median_coverage_ratio)
                  = 0 (well-covered) to 1 (severe desert)
  velocity_score = articles_last_24h / max(articles_last_7d / 7, 1)
                  = >1 means accelerating coverage, <1 means fading

Cities with desert_score > 0.7 and population > 500k are flagged as severe deserts.

Usage:
    from worker.news_desert_detector import run
    result = run()
    print(f"Found {result['desert_count']} news deserts")
"""
from __future__ import annotations

import logging
import math
from datetime import timedelta

from .db import connect

log = logging.getLogger("xyzo.news_deserts")

MIN_POPULATION = 100_000   # Minimum city population to evaluate
DESERT_THRESHOLD = 0.6     # desert_score above this = "desert"
MAX_SOURCES = 200          # Cap sources considered for ratio calc
EARTH_RADIUS_KM = 6371.0


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Approximate km distance between two lat/lng points."""
    lat1_r = math.radians(lat1)
    lat2_r = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1_r) * math.cos(lat2_r) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def _coverage_ratio(sources: int, population: int) -> float:
    """Sources per 100,000 population."""
    if population <= 0:
        return 0.0
    return (sources / (population / 100_000))


def run(min_desert_score: float = 0.5, limit: int = 500) -> dict:
    """Detect and score news deserts.

    Returns:
        dict with keys: desert_count, total_cities, max_score, avg_ratio
    """
    with connect() as conn:
        now_raw = conn.execute("SELECT now()").fetchone()["now"]
    now = now_raw
    day_ago = now - timedelta(hours=24)
    week_ago = now - timedelta(days=7)

    # ── Global median coverage ratio (computed over all evaluated cities) ──
    global_sql = """
    WITH city_coverage AS (
        SELECT
            wc.id AS city_id,
            wc.name AS city_name,
            wc.country_code,
            wc.lat,
            wc.lng,
            wc.population,
            COUNT(DISTINCT ns.id) AS source_count
        FROM world_cities wc
        LEFT JOIN news_sources ns ON ns.active = TRUE
            AND ns.lat BETWEEN wc.lat - 0.35 AND wc.lat + 0.35
            AND ns.lng BETWEEN wc.lng - 0.35 AND wc.lng + 0.35
        WHERE wc.population >= %s
        GROUP BY wc.id, wc.name, wc.country_code, wc.lat, wc.lng, wc.population
    )
    SELECT
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY
            CASE WHEN population > 0
                THEN (source_count::float / (population / 100000))
                ELSE 0 END
        ) AS median_ratio,
        COUNT(*) AS total_cities
    FROM city_coverage
    """
    with connect() as conn:
        global_rows = conn.execute(global_sql, (MIN_POPULATION,)).fetchall()

    median_ratio = float(global_rows[0]["median_ratio"] or 0.5)
    total_cities = int(global_rows[0]["total_cities"] or 0)
    log.info("news_desert_detector: global median coverage ratio=%.3f across %d cities", median_ratio, total_cities)

    # ── Per-city desert analysis ──────────────────────────────────────────
    sql = """
    WITH city_coverage AS (
        SELECT
            wc.id AS city_id,
            wc.name AS city_name,
            wc.country_code,
            wc.lat,
            wc.lng,
            wc.population,
            COUNT(DISTINCT ns.id) AS source_count,
            COUNT(DISTINCT CASE WHEN ns.country IN ('US','GB','INT') THEN ns.id END) AS mainstream_count
        FROM world_cities wc
        LEFT JOIN news_sources ns ON ns.active = TRUE
            AND ns.lat BETWEEN wc.lat - 0.35 AND wc.lat + 0.35
            AND ns.lng BETWEEN wc.lng - 0.35 AND wc.lng + 0.35
        WHERE wc.population >= %s
        GROUP BY wc.id, wc.name, wc.country_code, wc.lat, wc.lng, wc.population
    ),
    article_coverage AS (
        SELECT
            wc.id AS city_id,
            COALESCE(COUNT(DISTINCT CASE WHEN a.published_at >= %s THEN a.id END), 0) AS articles_24h,
            COALESCE(COUNT(DISTINCT CASE WHEN a.published_at >= %s THEN a.id END), 0) AS articles_7d,
            MAX(a.published_at) AS last_article_at,
            MODE() WITHIN GROUP (ORDER BY ns.language) AS dominant_language
        FROM world_cities wc
        LEFT JOIN news_sources ns ON ns.active = TRUE
            AND ns.lat BETWEEN wc.lat - 0.35 AND wc.lat + 0.35
            AND ns.lng BETWEEN wc.lng - 0.35 AND wc.lng + 0.35
        LEFT JOIN news_articles a ON a.source_id = ns.id AND a.status = 'extracted'
        WHERE wc.population >= %s
        GROUP BY wc.id
    ),
    nearest_source AS (
        SELECT
            wc.id AS city_id,
            MIN(ST_Distance(
                ST_MakePoint(wc.lng, wc.lat)::geography,
                ST_MakePoint(ns.lng, ns.lat)::geography
            ) / 1000) AS nearest_km
        FROM world_cities wc
        JOIN news_sources ns ON ns.active = TRUE
        WHERE wc.population >= %s
        GROUP BY wc.id, wc.lat, wc.lng
    ),
    scored AS (
        SELECT
            cc.city_id,
            cc.city_name,
            cc.country_code,
            cc.lat,
            cc.lng,
            cc.population,
            LEAST(cc.source_count, %s) AS source_count,  -- cap for ratio
            cc.mainstream_count > 0 AS mainstream_present,
            ac.articles_24h,
            ac.articles_7d,
            ac.last_article_at,
            ac.dominant_language,
            ns_km.nearest_km,
            CASE WHEN cc.population > 0
                THEN LEAST(cc.source_count, %s)::float / (cc.population / 100000.0)
                ELSE 0
            END AS coverage_ratio,
            CASE WHEN %s > 0
                THEN 1.0 - LEAST(cc.source_count, %s)::float / (cc.population / 100000.0) / %s
                ELSE 1.0
            END AS desert_score,
            CASE WHEN ac.articles_7d > 0
                THEN ac.articles_24h::float / GREATEST(ac.articles_7d::float / 7, 1)
                ELSE 0.0
            END AS velocity_score
        FROM city_coverage cc
        LEFT JOIN article_coverage ac ON ac.city_id = cc.city_id
        LEFT JOIN nearest_source ns_km ON ns_km.city_id = cc.city_id
    )

    SELECT
        city_id, city_name, country_code, lat, lng, population,
        source_count, mainstream_present,
        articles_24h, articles_7d, last_article_at, dominant_language,
        nearest_km,
        ROUND(coverage_ratio::NUMERIC, 4) AS coverage_ratio,
        ROUND(desert_score::NUMERIC, 4) AS desert_score,
        ROUND(velocity_score::NUMERIC, 3) AS velocity_score
    FROM scored
    WHERE desert_score >= %s
    ORDER BY desert_score DESC
    LIMIT %s;
    """

    rows: list[dict] = []
    with connect() as conn:
        rows = conn.execute(sql, (
            MIN_POPULATION,
            day_ago, week_ago,
            MIN_POPULATION,
            MIN_POPULATION,
            MAX_SOURCES, MAX_SOURCES, MAX_SOURCES,
            median_ratio, median_ratio,
            min_desert_score,
            limit
        )).fetchall()

    desert_count = len(rows)
    log.info("news_desert_detector: found %d deserts (score >= %.2f)", desert_count, min_desert_score)

    if desert_count == 0:
        return {"desert_count": 0, "total_cities": total_cities, "max_score": 0.0, "median_ratio": round(median_ratio, 4)}

    max_score = max(r["desert_score"] for r in rows)
    avg_ratio = sum(r["coverage_ratio"] for r in rows) / desert_count

    upsert_sql = """
    INSERT INTO news_deserts (
        city_id, city_name, country_code, lat, lng, population,
        source_count, mainstream_present,
        article_24h, article_7d, last_article_at, dominant_language,
        nearest_source_km, coverage_ratio, desert_score, velocity_score, updated_at
    )
    VALUES (
        %(city_id)s, %(city_name)s, %(country_code)s, %(lat)s, %(lng)s, %(population)s,
        %(source_count)s, %(mainstream_present)s,
        %(articles_24h)s, %(articles_7d)s, %(last_article_at)s, %(dominant_language)s,
        %(nearest_km)s, %(coverage_ratio)s, %(desert_score)s, %(velocity_score)s, NOW()
    )
    ON CONFLICT (city_id) DO UPDATE SET
        source_count      = EXCLUDED.source_count,
        mainstream_present = EXCLUDED.mainstream_present,
        article_24h       = EXCLUDED.article_24h,
        article_7d        = EXCLUDED.article_7d,
        last_article_at   = EXCLUDED.last_article_at,
        dominant_language = EXCLUDED.dominant_language,
        nearest_source_km = EXCLUDED.nearest_source_km,
        coverage_ratio   = EXCLUDED.coverage_ratio,
        desert_score     = EXCLUDED.desert_score,
        velocity_score   = EXCLUDED.velocity_score,
        updated_at       = NOW();
    """

    upserted = 0
    with connect() as conn:
        for r in rows:
            params = {
                "city_id": r["city_id"],
                "city_name": r["city_name"],
                "country_code": r["country_code"],
                "lat": r["lat"],
                "lng": r["lng"],
                "population": r["population"],
                "source_count": r["source_count"],
                "mainstream_present": r["mainstream_present"],
                "articles_24h": r["articles_24h"] or 0,
                "articles_7d": r["articles_7d"] or 0,
                "last_article_at": r["last_article_at"],
                "dominant_language": r["dominant_language"],
                "nearest_km": r["nearest_km"],
                "coverage_ratio": r["coverage_ratio"],
                "desert_score": r["desert_score"],
                "velocity_score": r["velocity_score"],
            }
            conn.execute(upsert_sql, params)
            upserted += 1
        conn.commit()

    # Cleanup: delete cities that are no longer deserts or have changed status
    cleanup_sql = """
    DELETE FROM news_deserts
    WHERE city_id NOT IN (
        SELECT id FROM world_cities WHERE population >= %s
    )
    OR desert_score < %s;
    """
    with connect() as conn:
        deleted = conn.execute(cleanup_sql, (MIN_POPULATION, min_desert_score)).rowcount
        conn.commit()

    log.info(
        "news_desert_detector: upserted %d, deleted %d stale, max_score=%.3f",
        upserted, deleted, max_score
    )

    return {
        "desert_count": desert_count,
        "total_cities": total_cities,
        "max_score": max_score,
        "avg_coverage_ratio": round(avg_ratio, 4),
        "median_coverage_ratio": round(median_ratio, 4),
        "upserted": upserted,
        "deleted": deleted,
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    result = run()
    print(result)
