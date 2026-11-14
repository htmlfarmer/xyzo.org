"""Event Velocity & Propagation — articles/hour, sources/hour, geographic spread, acceleration.

Run:
    python3 -m worker.event_velocity --limit 500
    python3 -m worker.event_velocity --event-id 1234
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import math
import sys

from .db import connect
from .geo_utils import haversine_km

log = logging.getLogger("xyzo.event_velocity")


def process_event(event_id: int) -> dict:
    with connect() as conn:
        rows = conn.execute("""
            SELECT
                a.id, a.published_at, a.fetched_at,
                a.extracted_lat, a.extracted_lng,
                a.extracted_location,
                s.id AS source_id, s.country AS source_country,
                s.name AS source_name,
                COALESCE(syn.is_original, FALSE) AS is_original,
                COALESCE(syn.is_syndicated_copy, FALSE) AS is_syndicated
            FROM news_articles a
            JOIN news_event_sources es ON es.article_id = a.id
            JOIN news_sources s ON s.id = a.source_id
            LEFT JOIN news_article_syndication syn ON syn.article_id = a.id
            WHERE es.event_id = %s
              AND a.hidden_at IS NULL
              AND a.status = 'extracted'
            ORDER BY a.published_at ASC NULLS LAST
        """, (event_id,)).fetchall()

    if not rows:
        return {"event_id": event_id}

    articles = [dict(r) for r in rows]
    now = rows[-1]["fetched_at"] if rows else None
    first_pub = rows[0]["published_at"] if rows else None
    last_pub = rows[-1]["published_at"] if rows else None

    # Time windows from most recent article
    if not now:
        return {"event_id": event_id}

    windows = {
        "1h": 1 / 60,
        "6h": 6 / 60,
        "24h": 24 / 60,
    }

    def count_in_window(hours: float) -> tuple[int, set, set, set]:
        cutoff = (now - dt.timedelta(hours=hours)) if now else None
        arts = [a for a in articles if a["published_at"] and a["published_at"] >= cutoff]
        sources = {a["source_id"] for a in arts if a.get("source_id")}
        countries = {a["source_country"] for a in arts if a.get("source_country")}
        cities = {a["extracted_location"] for a in arts if a.get("extracted_location")}
        return len(arts), sources, countries, cities

    arts_1h, src_1h, cnt_1h, _ = count_in_window(windows["1h"])
    arts_6h, src_6h, cnt_6h, _ = count_in_window(windows["6h"])
    arts_24h, src_24h, cnt_24h, cities_24h = count_in_window(windows["24h"])

    # Acceleration ratios
    acc_1h = arts_1h / max(arts_6h / 6, 0.1)
    acc_6h = arts_6h / max(arts_24h / 24, 0.1)
    acc_24h = arts_24h / max(len(articles) / 7, 0.1)  # vs 7-day average

    # Velocity score: articles × unique_sources × unique_countries / hours
    hours_span = 1.0
    if first_pub and last_pub:
        delta = (last_pub - first_pub).total_seconds() / 3600
        hours_span = max(delta, 0.1)

    unique_sources_all = len({a["source_id"] for a in articles if a.get("source_id")})
    unique_countries_all = len({a["source_country"] for a in articles if a.get("source_country")})
    original_sources = sum(1 for a in articles if a.get("is_original"))
    syndicated_copies = sum(1 for a in articles if a.get("is_syndicated"))

    velocity_score = (arts_24h * len(src_24h) * len(cnt_24h)) / max(hours_span, 1)
    emerging_score = velocity_score * (1 - min(syndicated_copies / max(len(articles), 1), 1))

    # Geographic spread: max distance between any two reporting cities
    geo_points = [
        (a["extracted_lat"], a["extracted_lng"])
        for a in articles
        if a.get("extracted_lat") is not None and a["extracted_lng"] is not None
    ]
    max_spread_km = 0.0
    prop_vel_kmh = 0.0
    if len(geo_points) >= 2:
        for i in range(len(geo_points)):
            for j in range(i + 1, len(geo_points)):
                d = haversine_km(geo_points[i][0], geo_points[i][1],
                                  geo_points[j][0], geo_points[j][1])
                if d > max_spread_km:
                    max_spread_km = d
        if first_pub and last_pub and max_spread_km > 0:
            hours = max((last_pub - first_pub).total_seconds() / 3600, 0.1)
            prop_vel_kmh = max_spread_km / hours

    result = {
        "event_id": event_id,
        "articles_1h": arts_1h,
        "articles_6h": arts_6h,
        "articles_24h": arts_24h,
        "sources_1h": len(src_1h),
        "sources_6h": len(src_6h),
        "sources_24h": len(src_24h),
        "countries_1h": len(cnt_1h),
        "countries_6h": len(cnt_6h),
        "countries_24h": len(cnt_24h),
        "cities_24h": len(cities_24h),
        "acceleration_1h": round(acc_1h, 3),
        "acceleration_6h": round(acc_6h, 3),
        "acceleration_24h": round(acc_24h, 3),
        "velocity_score": round(velocity_score, 2),
        "emerging_score": round(emerging_score, 2),
        "unique_sources": unique_sources_all,
        "original_sources": original_sources,
        "syndicated_copies": syndicated_copies,
        "geographic_spread_km": round(max_spread_km, 1),
        "propagation_velocity_km_h": round(prop_vel_kmh, 1),
        "first_article_at": str(first_pub) if first_pub else None,
        "last_article_at": str(last_pub) if last_pub else None,
    }

    with connect() as conn:
        conn.execute("""
            INSERT INTO news_event_velocity (
                event_id, articles_1h, articles_6h, articles_24h,
                sources_1h, sources_6h, sources_24h,
                countries_1h, countries_6h, countries_24h, cities_24h,
                acceleration_1h, acceleration_6h, acceleration_24h,
                velocity_score, emerging_score,
                unique_sources, original_sources, syndicated_copies,
                geographic_spread_km, propagation_velocity_km_h,
                first_article_at, last_article_at
            )
            VALUES (%(event_id)s, %(articles_1h)s, %(articles_6h)s, %(articles_24h)s,
                    %(sources_1h)s, %(sources_6h)s, %(sources_24h)s,
                    %(countries_1h)s, %(countries_6h)s, %(countries_24h)s, %(cities_24h)s,
                    %(acceleration_1h)s, %(acceleration_6h)s, %(acceleration_24h)s,
                    %(velocity_score)s, %(emerging_score)s,
                    %(unique_sources)s, %(original_sources)s, %(syndicated_copies)s,
                    %(geographic_spread_km)s, %(propagation_velocity_km_h)s,
                    %(first_article_at)s, %(last_article_at)s)
            ON CONFLICT (event_id) DO UPDATE SET
                articles_1h   = EXCLUDED.articles_1h,
                articles_6h   = EXCLUDED.articles_6h,
                articles_24h  = EXCLUDED.articles_24h,
                sources_1h    = EXCLUDED.sources_1h,
                sources_6h    = EXCLUDED.sources_6h,
                sources_24h   = EXCLUDED.sources_24h,
                countries_1h  = EXCLUDED.countries_1h,
                countries_6h  = EXCLUDED.countries_6h,
                countries_24h = EXCLUDED.countries_24h,
                cities_24h    = EXCLUDED.cities_24h,
                acceleration_1h  = EXCLUDED.acceleration_1h,
                acceleration_6h  = EXCLUDED.acceleration_6h,
                acceleration_24h = EXCLUDED.acceleration_24h,
                velocity_score   = EXCLUDED.velocity_score,
                emerging_score    = EXCLUDED.emerging_score,
                unique_sources    = EXCLUDED.unique_sources,
                original_sources  = EXCLUDED.original_sources,
                syndicated_copies = EXCLUDED.syndicated_copies,
                geographic_spread_km = EXCLUDED.geographic_spread_km,
                propagation_velocity_km_h = EXCLUDED.propagation_velocity_km_h,
                first_article_at  = EXCLUDED.first_article_at,
                last_article_at   = EXCLUDED.last_article_at,
                updated_at = NOW()
        """, result)
        conn.commit()

    # Populate geographic propagation table
    ordered_articles = sorted(
        [a for a in articles if a.get("published_at") and a.get("extracted_lat")],
        key=lambda a: a["published_at"]
    )
    if ordered_articles and first_pub:
        for rank, art in enumerate(ordered_articles[:20]):  # cap at 20
            offset = int((art["published_at"] - first_pub).total_seconds())
            with connect() as conn:
                conn.execute("""
                    INSERT INTO news_event_propagation (
                        event_id, source_id, country_code, lat, lng,
                        propagation_order, time_offset_seconds, is_original_report
                    )
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (event_id, source_id, city_id) DO UPDATE SET
                        propagation_order   = EXCLUDED.propagation_order,
                        time_offset_seconds = EXCLUDED.time_offset_seconds,
                        is_original_report = EXCLUDED.is_original_report
                """, (
                    event_id,
                    art["source_id"],
                    art["source_country"],
                    art["extracted_lat"],
                    art["extracted_lng"],
                    rank + 1,
                    offset,
                    art.get("is_original", False),
                ))
                conn.commit()

    return result


def run(event_id: int | None = None, limit: int = 500) -> dict:
    if event_id:
        return process_event(event_id)

    with connect() as conn:
        rows = conn.execute("""
            SELECT DISTINCT es.event_id
            FROM news_event_sources es
            JOIN news_articles a ON a.id = es.article_id
            WHERE a.hidden_at IS NULL
              AND a.status = 'extracted'
              AND es.event_id IN (
                  SELECT id FROM news_events WHERE status = 'active'
              )
            ORDER BY es.event_id DESC
            LIMIT %s
        """, (limit,)).fetchall()

    event_ids = [r["event_id"] for r in rows]
    log.info("event_velocity: processing %d events", len(event_ids))

    totals = {"events": len(event_ids), "errors": 0}
    for eid in event_ids:
        try:
            process_event(eid)
        except Exception as ex:
            log.warning("Velocity error event %d: %s", eid, ex)
            totals["errors"] += 1

    log.info("event_velocity: done — %d events, %d errors",
             totals["events"], totals["errors"])
    return totals


if __name__ == "__main__":
    import argparse
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    parser = argparse.ArgumentParser()
    parser.add_argument("--event-id", type=int)
    parser.add_argument("--limit", type=int, default=500)
    args = parser.parse_args()
    result = run(event_id=args.event_id, limit=args.limit)
    print(json.dumps(result))
