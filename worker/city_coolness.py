"""Compute city value scores — the "City Value Engine" worker.

This module calculates 100+ factors for every city and produces a composite
value_score that surfaces buzzing locations worldwide.

Usage:
    # Full recompute (all cities):
    python -m worker.city_value

    # Single city (for testing):
    python -m worker.city_value --city "Tokyo" --country JP

    # Quick update (just trending changes):
    python -m worker.city_value --fast

    # Status:
    python -m worker.city_value --status
"""

from __future__ import annotations

import argparse
import logging
import math
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent.parent))

from worker.db import connect

log = logging.getLogger("xyzo.city_value")

# ── Factor Categories ────────────────────────────────────────────────────────

VOLUME_FACTORS = [
    "articles_1d", "articles_7d", "articles_30d",
    "article_velocity", "articles_per_source",
]

EVENT_FACTORS = [
    "events_7d", "events_30d", "event_velocity",
    "major_events_7d", "ongoing_events",
]

DIVERSITY_FACTORS = [
    "unique_sources", "unique_countries", "unique_languages",
    "source_diversity_idx", "new_sources_7d",
]

FRESHNESS_FACTORS = [
    "freshness_score", "continuous_coverage_hours",
]

QUALITY_FACTORS = [
    "avg_article_length", "has_images_ratio",
    "verified_ratio", "avg_source_reliability",
]

TREND_FACTORS = [
    "week_change_pct", "month_change_pct", "velocity_acceleration",
    "is_surging", "surge_velocity",
]

STRATEGIC_FACTORS = [
    "is_capital", "is_coastal", "is_conflict_zone",
    "is_economic_center", "is_diplomatic_hub", "is_sports_center",
    "is_cultural_heritage", "is_tourist_destination", "is_tech_hub",
    "is_financial_center",
]

ALL_FACTORS = (
    VOLUME_FACTORS + EVENT_FACTORS + DIVERSITY_FACTORS +
    FRESHNESS_FACTORS + QUALITY_FACTORS + TREND_FACTORS +
    STRATEGIC_FACTORS
)


# ── Helper SQL Queries ────────────────────────────────────────────────────────

VOLUME_SQL = """
WITH article_stats AS (
    SELECT
        g.primary_city_id AS city_id,
        COUNT(CASE WHEN a.published_at > NOW() - INTERVAL '1 day' THEN 1 END) AS articles_1d,
        COUNT(CASE WHEN a.published_at > NOW() - INTERVAL '7 days' THEN 1 END) AS articles_7d,
        COUNT(CASE WHEN a.published_at > NOW() - INTERVAL '30 days' THEN 1 END) AS articles_30d,
        COUNT(DISTINCT ns.id) AS unique_sources
    FROM news_source_geography g
    JOIN news_sources ns ON ns.id = g.source_id AND ns.active = true
    JOIN news_articles a ON a.source_id = ns.id
    WHERE a.published_at > NOW() - INTERVAL '30 days'
      AND a.status IN ('extracted', 'clustered')
      AND g.primary_city_id IS NOT NULL
    GROUP BY g.primary_city_id
),
prev_week AS (
    SELECT g.primary_city_id AS city_id,
           COUNT(*) AS prev_week_count
    FROM news_source_geography g
    JOIN news_sources ns ON ns.id = g.source_id AND ns.active = true
    JOIN news_articles a ON a.source_id = ns.id
    WHERE a.published_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
      AND a.status IN ('extracted', 'clustered')
      AND g.primary_city_id IS NOT NULL
    GROUP BY g.primary_city_id
)
SELECT
    s.city_id,
    s.articles_1d,
    s.articles_7d,
    s.articles_30d,
    s.unique_sources,
    CASE WHEN p.prev_week_count > 0
         THEN (s.articles_7d::float / p.prev_week_count) - 1.0
         ELSE 0 END AS article_velocity,
    CASE WHEN s.unique_sources > 0
         THEN s.articles_7d::float / s.unique_sources
         ELSE 0 END AS articles_per_source
FROM article_stats s
LEFT JOIN prev_week p ON p.city_id = s.city_id
"""

EVENT_SQL = """
WITH recent_events AS (
    SELECT
        e.primary_location_id,
        e.first_reported_at,
        e.source_count,
        e.expires_at
    FROM news_events e
    WHERE e.first_reported_at > NOW() - INTERVAL '30 days'
)
SELECT
    l.id AS location_id,
    COUNT(CASE WHEN re.first_reported_at > NOW() - INTERVAL '7 days' THEN 1 END) AS events_7d,
    COUNT(CASE WHEN re.first_reported_at > NOW() - INTERVAL '30 days' THEN 1 END) AS events_30d,
    COUNT(CASE WHEN re.first_reported_at > NOW() - INTERVAL '7 days' AND re.source_count >= 5 THEN 1 END) AS major_events_7d,
    COUNT(CASE WHEN re.expires_at IS NULL OR re.expires_at > NOW() THEN 1 END) AS ongoing_events
FROM news_locations l
LEFT JOIN recent_events re ON re.primary_location_id = l.id
WHERE l.lat IS NOT NULL
GROUP BY l.id
"""

FRESHNESS_SQL = """
WITH latest AS (
    SELECT
        g.primary_city_id AS city_id,
        MAX(a.published_at) AS last_article_at
    FROM news_source_geography g
    JOIN news_sources ns ON ns.id = g.source_id AND ns.active = true
    JOIN news_articles a ON a.source_id = ns.id
    WHERE a.status IN ('extracted', 'clustered')
    GROUP BY g.primary_city_id
)
SELECT
    city_id,
    last_article_at,
    EXTRACT(EPOCH FROM (NOW() - last_article_at)) / 60 AS minutes_since_article
FROM latest
"""

DIVERSITY_SQL = """
WITH country_langs AS (
    SELECT DISTINCT
        g.primary_city_id AS city_id,
        ns.country,
        ns.language
    FROM news_source_geography g
    JOIN news_sources ns ON ns.id = g.source_id AND ns.active = true
    WHERE g.primary_city_id IS NOT NULL
),
source_counts AS (
    SELECT
        city_id,
        COUNT(DISTINCT ns_id) AS unique_sources,
        COUNT(DISTINCT country) AS unique_countries,
        COUNT(DISTINCT language) AS unique_languages
    FROM (
        SELECT g.primary_city_id AS city_id, g.source_id AS ns_id, ns.country, ns.language
        FROM news_source_geography g
        JOIN news_sources ns ON ns.id = g.source_id AND ns.active = true
        WHERE g.primary_city_id IS NOT NULL
    ) combined
    GROUP BY city_id
),
source_dist AS (
    SELECT
        city_id,
        COUNT(*) AS total_articles,
        COUNT(*) FILTER (WHERE rn = 1) AS src1_articles,
        COUNT(*) FILTER (WHERE rn = 2) AS src2_articles,
        COUNT(*) FILTER (WHERE rn = 3) AS src3_articles
    FROM (
        SELECT g.primary_city_id AS city_id, ns.id AS ns_id,
               ROW_NUMBER() OVER (PARTITION BY g.primary_city_id, ns.id ORDER BY COUNT(*) DESC) AS rn,
               COUNT(*) OVER (PARTITION BY g.primary_city_id, ns.id) AS cnt
        FROM news_source_geography g
        JOIN news_sources ns ON ns.id = g.source_id AND ns.active = true
        JOIN news_articles a ON a.source_id = ns.id
        WHERE a.status IN ('extracted', 'clustered')
          AND a.published_at > NOW() - INTERVAL '30 days'
          AND g.primary_city_id IS NOT NULL
        GROUP BY g.primary_city_id, ns.id
    ) article_counts
    WHERE rn <= 5
    GROUP BY city_id
)
SELECT
    sc.city_id,
    sc.unique_sources,
    sc.unique_countries,
    sc.unique_languages,
    CASE WHEN sd.total_articles > 1 AND sd.src1_articles > 0
         THEN -1.0 * (
             NULLIF(sd.src1_articles::float / NULLIF(sd.total_articles,0), 0) * LN(NULLIF(sd.src1_articles::float / NULLIF(sd.total_articles,0), 0)) +
             COALESCE(NULLIF(sd.src2_articles::float / NULLIF(sd.total_articles,0), 0) * LN(NULLIF(sd.src2_articles::float / NULLIF(sd.total_articles,0), 0)), 0) +
             COALESCE(NULLIF(sd.src3_articles::float / NULLIF(sd.total_articles,0), 0) * LN(NULLIF(sd.src3_articles::float / NULLIF(sd.total_articles,0), 0)), 0)
         ) / LN(3)  -- normalize to 0-1
         ELSE 0 END AS source_diversity_idx
FROM source_counts sc
LEFT JOIN source_dist sd ON sd.city_id = sc.city_id
"""

QUALITY_SQL = """
WITH quality_stats AS (
    SELECT
        g.primary_city_id AS city_id,
        AVG(LENGTH(a.body)) AS avg_article_length,
        AVG(CASE WHEN a.image_url IS NOT NULL THEN 1.0 ELSE 0.0 END) AS has_images_ratio,
        AVG(CASE WHEN ns.reliability_score >= 0.7 THEN 1.0 ELSE 0.0 END) AS verified_ratio,
        AVG(ns.reliability_score) AS avg_source_reliability
    FROM news_source_geography g
    JOIN news_sources ns ON ns.id = g.source_id AND ns.active = true
    JOIN news_articles a ON a.source_id = ns.id
    WHERE a.published_at > NOW() - INTERVAL '30 days'
      AND a.status IN ('extracted', 'clustered')
      AND g.primary_city_id IS NOT NULL
    GROUP BY g.primary_city_id
)
SELECT * FROM quality_stats
"""

# ── Geocoding Quality Metrics (from news_article_cities) ───────────────────────

GEOCODING_QUALITY_SQL = """
WITH city_stats AS (
    SELECT
        city_id,
        COUNT(*) FILTER (WHERE is_primary = true)::float /
            NULLIF(COUNT(*), 0) AS primary_mention_ratio,
        AVG(CASE confidence
            WHEN 'high' THEN 0.9
            WHEN 'medium' THEN 0.6
            WHEN 'low' THEN 0.3
            ELSE 0.5 END) AS avg_confidence,
        COUNT(*) FILTER (WHERE confidence = 'high')::float /
            NULLIF(COUNT(*), 0) AS high_confidence_ratio
    FROM news_article_cities
    WHERE city_id IS NOT NULL
    GROUP BY city_id
)
SELECT * FROM city_stats
"""

# ── User Engagement Metrics (from news_location_rankings) ───────────────────────

USER_ENGAGEMENT_SQL = """
WITH city_names AS (
    SELECT id AS city_id, name, country_code
    FROM world_cities
)
SELECT
    cn.city_id,
    nlr.trend_score AS user_trend_score,
    nlr.discovery_priority,
    nlr.views_24h,
    nlr.views_7d
FROM city_names cn
JOIN news_location_rankings nlr ON nlr.city_name = cn.name
    AND nlr.country_code = cn.country_code
"""


# ── Normalization Helpers ──────────────────────────────────────────────────────

def normalize(val: float, min_val: float, max_val: float) -> float:
    """Normalize a value to 0-100 scale."""
    if max_val <= min_val:
        return 0
    normalized = (val - min_val) / (max_val - min_val)
    return max(0, min(100, normalized * 100))


def normalize_log(val: float, max_val: float) -> float:
    """Log-normalize a value (good for counts that span orders of magnitude)."""
    if val <= 0:
        return 0
    log_val = math.log1p(val)
    log_max = math.log1p(max_val) if max_val > 0 else 1
    return max(0, min(100, (log_val / log_max) * 100))


# ── Score Computation ────────────────────────────────────────────────────────

def _to_float(val) -> float:
    """Convert PostgreSQL Decimal or any numeric to float safely."""
    if val is None:
        return 0.0
    try:
        return float(val)
    except (TypeError, ValueError):
        return 0.0


def compute_composite_score(factors: dict[str, float]) -> dict[str, float]:
    """Compute composite scores from factors using category weights."""
    # Get factor config
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT factor_name, category, weight FROM value_factor_config WHERE enabled = true")
            config = {r["factor_name"]: {"category": r["category"], "weight": _to_float(r["weight"])} for r in cur.fetchall()}

    # Normalize factors to 0-100 scale before computing scores
    MAX_ARTICLES = 3000
    MAX_SOURCES = 50
    MAX_EVENTS = 100
    MAX_CHANGE = 500  # 500% change cap

    def normalize_factor(name: str, value: float) -> float:
        """Normalize a factor value to 0-100 scale."""
        if name in ("articles_1d", "articles_7d", "articles_30d"):
            return min(100, (value / MAX_ARTICLES) * 100)
        elif name in ("unique_sources", "unique_countries", "unique_languages"):
            return min(100, (value / MAX_SOURCES) * 100)
        elif name in ("events_7d", "events_30d", "major_events_7d", "ongoing_events"):
            return min(100, (value / MAX_EVENTS) * 100)
        elif name in ("week_change_pct", "month_change_pct", "article_velocity"):
            return min(100, max(0, value / MAX_CHANGE * 100))
        elif name in ("freshness_score", "verified_ratio", "has_images_ratio",
                       "avg_source_reliability", "source_diversity_idx"):
            return min(100, max(0, value))  # Already 0-100
        elif name == "avg_article_length":
            return min(100, value / 100)  # 100 chars = 100%
        elif name == "articles_per_source":
            return min(100, value * 10)  # 10 articles/source = 100%
        elif name == "surge_velocity":
            return min(100, value * 50)  # 2x surge = 100%
        else:
            return min(100, max(0, value))  # Boolean or 0-100 factors

    def category_score(factor_list: list[str]) -> float:
        total_weight = 0
        weighted_sum = 0.0
        for f in factor_list:
            if f in factors and f in config:
                w = config[f]["weight"]
                normalized = normalize_factor(f, _to_float(factors[f]))
                weighted_sum += normalized * w
                total_weight += w
        return (weighted_sum / total_weight) if total_weight > 0 else 0.0

    volume_score = category_score(VOLUME_FACTORS)
    event_score = category_score(EVENT_FACTORS)
    diversity_score = category_score(DIVERSITY_FACTORS)
    freshness_score = category_score(FRESHNESS_FACTORS)
    quality_score = category_score(QUALITY_FACTORS)
    trend_score = category_score(TREND_FACTORS)
    strategic_score = category_score(STRATEGIC_FACTORS)
    editorial_score = _to_float(factors.get("editorial_coolness", 0)) * 10  # 0-10 → 0-100

    # Composite: weighted average of category scores (all now 0-100)
    total_score = (
        volume_score * 0.20 +
        event_score * 0.15 +
        diversity_score * 0.15 +
        freshness_score * 0.15 +
        quality_score * 0.05 +
        trend_score * 0.15 +
        strategic_score * 0.05 +
        editorial_score * 0.10
    )

    return {
        "value_score": min(100.0, max(0, total_score)),
        "volume_score": min(100.0, volume_score),
        "diversity_score": min(100.0, diversity_score),
        "trend_score": min(100.0, trend_score),
        "freshness_score_ct": min(100.0, freshness_score),
        "editorial_score": editorial_score,
    }


def assign_tier(score: float, sources: int, population: int) -> str:
    """Assign a coolness tier based on score and other factors."""
    if score >= 70 or (sources >= 10 and score >= 50):
        return "global"
    elif score >= 40 or sources >= 5:
        return "regional"
    elif score >= 20 or sources >= 2:
        return "local"
    else:
        return "underground"


# ── Main Computation ─────────────────────────────────────────────────────────

def compute_all_cities(fast: bool = False) -> dict[str, Any]:
    """Compute coolness scores for all cities with article coverage."""
    log.info("Starting city value computation (fast=%s)", fast)

    # Fetch all factor data in parallel-ish batches
    results: dict[int, dict[str, Any]] = {}

    # Volume factors
    log.info("Fetching volume factors...")
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(VOLUME_SQL)
            for row in cur.fetchall():
                city_id = row["city_id"]
                if city_id:
                    results.setdefault(city_id, {})["articles_1d"] = row["articles_1d"] or 0
                    results[city_id]["articles_7d"] = row["articles_7d"] or 0
                    results[city_id]["articles_30d"] = row["articles_30d"] or 0
                    results[city_id]["unique_sources"] = row["unique_sources"] or 0
                    results[city_id]["article_velocity"] = row["article_velocity"] or 0
                    results[city_id]["articles_per_source"] = row["articles_per_source"] or 0

    # Event factors (per location - skip for now as it requires heavy geographic join)
    # Will add back once we have a cached event→city mapping table
    for city_id in results:
        results[city_id].setdefault("events_7d", 0)
        results[city_id].setdefault("events_30d", 0)
        results[city_id].setdefault("major_events_7d", 0)
        results[city_id].setdefault("ongoing_events", 0)
        results[city_id].setdefault("event_velocity", 0)

    # Freshness factors
    log.info("Fetching freshness factors...")
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(FRESHNESS_SQL)
            for row in cur.fetchall():
                city_id = row["city_id"]
                if city_id:
                    results.setdefault(city_id, {})["last_article_at"] = row["last_article_at"]
                    results[city_id]["minutes_since_article"] = row["minutes_since_article"] or 0
                    # freshness_score: 100 if < 60 min, decays logarithmically
                    mins = max(0, row["minutes_since_article"] or 999999)
                    results[city_id]["freshness_score"] = max(0, 100 - math.log1p(mins / 60) * 20)

    # Diversity factors
    log.info("Fetching diversity factors...")
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(DIVERSITY_SQL)
            for row in cur.fetchall():
                city_id = row["city_id"]
                if city_id:
                    results[city_id].setdefault("unique_sources", 0)
                    results[city_id]["unique_countries"] = row["unique_countries"] or 0
                    results[city_id]["unique_languages"] = row["unique_languages"] or 0
                    results[city_id]["source_diversity_idx"] = (row["source_diversity_idx"] or 0) * 100

    # Quality factors
    if not fast:
        log.info("Fetching quality factors...")
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute(QUALITY_SQL)
                for row in cur.fetchall():
                    city_id = row["city_id"]
                    if city_id:
                        results[city_id]["avg_article_length"] = min(row["avg_article_length"] or 0, 10000) / 100
                        results[city_id]["has_images_ratio"] = (row["has_images_ratio"] or 0) * 100
                        results[city_id]["verified_ratio"] = (row["verified_ratio"] or 0) * 100
                        results[city_id]["avg_source_reliability"] = (row["avg_source_reliability"] or 0) * 100

    # Geocoding quality metrics (from news_article_cities)
    log.info("Fetching geocoding quality metrics...")
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(GEOCODING_QUALITY_SQL)
            for row in cur.fetchall():
                city_id = row["city_id"]
                if city_id:
                    results.setdefault(city_id, {})["primary_mention_ratio"] = row["primary_mention_ratio"] or 0
                    results[city_id]["avg_confidence"] = (row["avg_confidence"] or 0) * 100
                    results[city_id]["high_confidence_ratio"] = (row["high_confidence_ratio"] or 0) * 100

    # User engagement metrics (from news_location_rankings)
    log.info("Fetching user engagement metrics...")
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(USER_ENGAGEMENT_SQL)
            for row in cur.fetchall():
                city_id = row["city_id"]
                if city_id:
                    results.setdefault(city_id, {})["user_trend_score"] = row["user_trend_score"] or 0
                    results[city_id]["discovery_priority"] = row["discovery_priority"] or 0
                    results[city_id]["views_24h"] = row["views_24h"] or 0
                    results[city_id]["views_7d"] = row["views_7d"] or 0

    # City metadata (from world_cities)
    log.info("Fetching city metadata...")
    city_metadata: dict[int, dict] = {}
    with connect() as conn:
        with conn.cursor() as cur:
            # world_cities is a foreign table, so we query it directly
            cur.execute("""
                SELECT id, name, country_code, population, lat, lng, timezone,
                       feature_code
                FROM world_cities
                WHERE id = ANY(%s)
            """, [list(results.keys())])
            for row in cur.fetchall():
                city_id = row["id"]
                city_metadata[city_id] = {
                    "name": row["name"],
                    "country_code": row["country_code"],
                    "population": row["population"],
                    "lat": row["lat"],
                    "lng": row["lng"],
                    "timezone": row["timezone"],
                    "is_capital": row["feature_code"] == "PPLC",
                }

    # Editorial tags
    log.info("Fetching editorial tags...")
    editorial_scores: dict[int, float] = {}
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT city_id,
                       COUNT(*) FILTER (WHERE tag_type = 'breaking') AS breaking,
                       COUNT(*) FILTER (WHERE tag_type = 'editorial') AS editorial
                FROM city_value_tag
                WHERE city_id = ANY(%s)
                GROUP BY city_id
            """, [list(results.keys())])
            for row in cur.fetchall():
                editorial_scores[row["city_id"]] = (row["editorial"] or 0) * 2 + (row["breaking"] or 0) * 5

    # Curated city status
    curated_cities: set[int] = set()
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT city_id FROM city_value_curated WHERE city_id = ANY(%s)", [list(results.keys())])
            for row in cur.fetchall():
                if row["city_id"]:
                    curated_cities.add(row["city_id"])

    # Compute composite scores and write to DB
    log.info("Computing composite scores for %d cities...", len(results))

    rows_to_insert = []
    for city_id, factors in results.items():
        meta = city_metadata.get(city_id, {})

        # Add metadata factors
        factors["population"] = meta.get("population", 0)
        factors["is_capital"] = meta.get("is_capital", False)
        factors["lat"] = meta.get("lat")
        factors["lng"] = meta.get("lng")
        factors["timezone_offset"] = _parse_timezone(meta.get("timezone"))
        factors["country_code"] = meta.get("country_code")
        factors["region"] = _get_region(meta.get("country_code"))
        factors["editorial_coolness"] = editorial_scores.get(city_id, 0)
        factors["is_curated"] = city_id in curated_cities

        # Trend factors
        factors["week_change_pct"] = factors.get("article_velocity", 0) * 100
        factors["month_change_pct"] = _compute_month_change(factors)
        factors["velocity_acceleration"] = factors.get("article_velocity", 0) * factors.get("event_velocity", 0)
        factors["is_surging"] = factors.get("article_velocity", 0) > 1.0
        factors["surge_velocity"] = factors.get("article_velocity", 0) if factors["is_surging"] else 0

        # Strategic defaults (can be enhanced with external data)
        factors.setdefault("is_coastal", False)
        factors.setdefault("is_conflict_zone", False)
        factors.setdefault("is_economic_center", False)
        factors.setdefault("is_diplomatic_hub", False)
        factors.setdefault("is_sports_center", False)
        factors.setdefault("is_cultural_heritage", False)
        factors.setdefault("is_tourist_destination", False)
        factors.setdefault("is_tech_hub", False)
        factors.setdefault("is_financial_center", False)
        factors.setdefault("continuous_coverage_hours", 0)
        factors.setdefault("avg_article_length", 0)
        factors.setdefault("has_images_ratio", 0)
        factors.setdefault("verified_ratio", 0)
        factors.setdefault("avg_source_reliability", 0)
        # New columns from news_article_cities and news_location_rankings
        factors.setdefault("user_trend_score", 0)
        factors.setdefault("discovery_priority", 0)
        factors.setdefault("views_24h", 0)
        factors.setdefault("views_7d", 0)
        factors.setdefault("primary_mention_ratio", 0)
        factors.setdefault("avg_confidence", 0)
        factors.setdefault("high_confidence_ratio", 0)

        # Ensure all volume/event factors exist
        for f in VOLUME_FACTORS:
            factors.setdefault(f, 0)
        for f in EVENT_FACTORS:
            factors.setdefault(f, 0)

        # Composite
        composite = compute_composite_score(factors)
        factors.update(composite)
        factors["tier"] = assign_tier(factors["value_score"], factors["unique_sources"], factors["population"])
        factors["city_id"] = city_id
        factors["computed_at"] = datetime.now(timezone.utc)

        rows_to_insert.append(factors.copy())

    # Batch upsert
    if rows_to_insert:
        log.info("Writing %d city value records to DB...", len(rows_to_insert))
        with connect() as conn:
            with conn.cursor() as cur:
                for row in rows_to_insert:
                    cur.execute("""
                        INSERT INTO city_value (
                            city_id, value_score, tier,
                            articles_1d, articles_7d, articles_30d, article_velocity, articles_per_source,
                            events_7d, events_30d, event_velocity, major_events_7d, ongoing_events,
                            unique_sources, unique_countries, unique_languages, source_diversity_idx,
                            last_article_at, minutes_since_article, freshness_score, continuous_coverage_hours,
                            avg_article_length, has_images_ratio, verified_ratio, avg_source_reliability,
                            week_change_pct, month_change_pct, velocity_acceleration, is_surging, surge_velocity,
                            population, is_capital, is_coastal, lat, lng, timezone_offset,
                            is_conflict_zone, is_economic_center, is_diplomatic_hub, is_sports_center,
                            is_cultural_heritage, is_tourist_destination, is_tech_hub, is_financial_center,
                            region, country_code, editorial_coolness, is_curated,
                            volume_score, diversity_score, trend_score, freshness_score_ct, editorial_score,
                            user_trend_score, discovery_priority, views_24h, views_7d,
                            primary_mention_ratio, avg_confidence, high_confidence_ratio,
                            computed_at
                        ) VALUES (
                            %(city_id)s, %(value_score)s, %(tier)s,
                            %(articles_1d)s, %(articles_7d)s, %(articles_30d)s, %(article_velocity)s, %(articles_per_source)s,
                            %(events_7d)s, %(events_30d)s, %(event_velocity)s, %(major_events_7d)s, %(ongoing_events)s,
                            %(unique_sources)s, %(unique_countries)s, %(unique_languages)s, %(source_diversity_idx)s,
                            %(last_article_at)s, %(minutes_since_article)s, %(freshness_score)s, %(continuous_coverage_hours)s,
                            %(avg_article_length)s, %(has_images_ratio)s, %(verified_ratio)s, %(avg_source_reliability)s,
                            %(week_change_pct)s, %(month_change_pct)s, %(velocity_acceleration)s, %(is_surging)s, %(surge_velocity)s,
                            %(population)s, %(is_capital)s, %(is_coastal)s, %(lat)s, %(lng)s, %(timezone_offset)s,
                            %(is_conflict_zone)s, %(is_economic_center)s, %(is_diplomatic_hub)s, %(is_sports_center)s,
                            %(is_cultural_heritage)s, %(is_tourist_destination)s, %(is_tech_hub)s, %(is_financial_center)s,
                            %(region)s, %(country_code)s, %(editorial_coolness)s, %(is_curated)s,
                            %(volume_score)s, %(diversity_score)s, %(trend_score)s, %(freshness_score_ct)s, %(editorial_score)s,
                            %(user_trend_score)s, %(discovery_priority)s, %(views_24h)s, %(views_7d)s,
                            %(primary_mention_ratio)s, %(avg_confidence)s, %(high_confidence_ratio)s,
                            %(computed_at)s
                        )
                        ON CONFLICT (city_id) DO UPDATE SET
                            value_score = EXCLUDED.value_score,
                            tier = EXCLUDED.tier,
                            articles_1d = EXCLUDED.articles_1d,
                            articles_7d = EXCLUDED.articles_7d,
                            articles_30d = EXCLUDED.articles_30d,
                            unique_sources = EXCLUDED.unique_sources,
                            freshness_score = EXCLUDED.freshness_score,
                            week_change_pct = EXCLUDED.week_change_pct,
                            is_surging = EXCLUDED.is_surging,
                            is_curated = EXCLUDED.is_curated,
                            computed_at = EXCLUDED.computed_at
                    """, row)
            conn.commit()

    # Update ranks
    log.info("Computing ranks...")
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                WITH ranked AS (
                    SELECT city_id, RANK() OVER (ORDER BY value_score DESC) AS rn
                    FROM city_value
                )
                UPDATE city_value c
                SET value_rank = r.rn
                FROM ranked r
                WHERE r.city_id = c.city_id
            """)
            conn.commit()

    log.info("City value computation complete for %d cities", len(rows_to_insert))

    return {
        "cities_computed": len(rows_to_insert),
        "tiers": _count_tiers(rows_to_insert),
    }


def _parse_timezone(tz: str | None) -> float | None:
    """Parse timezone string like 'Asia/Kolkata' to UTC offset hours."""
    if not tz:
        return None
    # Rough approximation using known offsets
    offsets = {
        "UTC": 0, "GMT": 0,
        "Asia/Kolkata": 5.5, "Asia/Dubai": 4, "Asia/Bangkok": 7,
        "Europe/London": 0, "Europe/Paris": 1, "Europe/Berlin": 1,
        "America/New_York": -5, "America/Los_Angeles": -8, "America/Chicago": -6,
    }
    return offsets.get(tz)


def _get_region(country_code: str | None) -> str:
    """Map country code to region."""
    if not country_code:
        return "unknown"
    regions = {
        "IN": "south-asia", "PK": "south-asia", "BD": "south-asia", "NP": "south-asia",
        "AF": "south-asia", "LK": "south-asia", "BT": "south-asia",
        "MM": "southeast-asia", "TH": "southeast-asia", "VN": "southeast-asia",
        "ID": "southeast-asia", "PH": "southeast-asia", "MY": "southeast-asia",
        "SG": "southeast-asia", "KH": "southeast-asia", "LA": "southeast-asia",
        "JP": "east-asia", "KR": "east-asia", "CN": "east-asia", "TW": "east-asia",
        "AU": "oceania", "NZ": "oceania", "PG": "oceania", "FJ": "oceania",
        "US": "americas", "CA": "americas", "MX": "americas", "BR": "south-america",
        "AR": "south-america", "CO": "south-america", "PE": "south-america",
        "GB": "europe", "DE": "europe", "FR": "europe", "IT": "europe",
        "ES": "europe", "PT": "europe", "NL": "europe", "PL": "europe",
        "RU": "eurasia", "TR": "eurasia", "UA": "europe",
        "EG": "north-africa", "MA": "north-africa", "NG": "west-africa",
        "KE": "east-africa", "ZA": "southern-africa", "ET": "east-africa",
        "SA": "middle-east", "AE": "middle-east", "IR": "middle-east",
    }
    return regions.get(country_code.upper(), "other")


def _compute_month_change(factors: dict) -> float:
    """Compute month-over-month change."""
    curr = factors.get("articles_30d", 0)
    # Approximate prev month as 30d - 7d (rough)
    prev = max(0, curr - factors.get("articles_7d", 0) * 4)
    if prev <= 0:
        return 0
    return ((curr - prev) / prev) * 100


def _count_tiers(rows: list[dict]) -> dict[str, int]:
    counts = Counter(r.get("tier", "unknown") for r in rows)
    return dict(counts)


# ── CLI ─────────────────────────────────────────────────────────────────────

def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    parser = argparse.ArgumentParser(description="Compute city value scores")
    parser.add_argument("--fast", action="store_true", help="Skip quality factors (faster)")
    parser.add_argument("--status", action="store_true", help="Show city value status")
    parser.add_argument("--city", type=str, help="Compute single city")
    parser.add_argument("--country", type=str, default="US", help="Country code for single city")

    args = parser.parse_args()

    if args.status:
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT tier, COUNT(*) AS count,
                           ROUND(AVG(value_score)::numeric, 1) AS avg_score,
                           COUNT(CASE WHEN is_surging THEN 1 END) AS surging
                    FROM city_value
                    GROUP BY tier
                    ORDER BY avg_score DESC
                """)
                print("\n=== City Value by Tier ===\n")
                print(f"{'Tier':<15} {'Cities':<8} {'Avg Score':<12} {'Surging':<8}")
                print("-" * 45)
                for r in cur.fetchall():
                    print(f"{r['tier']:<15} {r['count']:<8} {r['avg_score']:<12} {r['surging']:<8}")

                cur.execute("""
                    SELECT c.name, cc.country_code, cc.articles_7d, cc.value_score,
                           cc.tier, cc.is_surging
                    FROM city_value cc
                    JOIN world_cities c ON c.id = cc.city_id
                    WHERE cc.value_rank <= 20
                    ORDER BY cc.value_rank
                """)
                print("\n=== Top 20 Cities by Value ===\n")
                print(f"{'Rank':<5} {'City':<25} {'Country':<8} {'7d Art':<8} {'Score':<8} {'Tier':<12} {'Surging'}")
                print("-" * 80)
                rank = 1
                for r in cur.fetchall():
                    print(f"{rank:<5} {r['name']:<25} {r['country_code']:<8} {r['articles_7d']:<8} "
                          f"{r['value_score']:<8.1f} {r['tier']:<12} {'YES' if r['is_surging'] else ''}")
                    rank += 1
        return

    result = compute_all_cities(fast=args.fast)
    print(f"\nCoolness computation complete!")
    print(f"  Cities computed: {result['cities_computed']}")
    print(f"  Tiers: {result['tiers']}")


if __name__ == "__main__":
    main()
