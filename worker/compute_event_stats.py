#!/usr/bin/env python3
"""Compute quantitative statistics for events: burst detection, z-scores, novelty.

This worker analyzes event velocity patterns to detect:
- Bursts: sudden spikes in reporting
- Z-scores: how anomalous an event is compared to historical baseline
- Novelty: how different/unique an event is from past coverage
- Percentiles: where an event ranks vs historical

Usage:
    python -m worker.compute_event_stats                    # full computation
    python -m worker.compute_event_stats --event-id 123    # single event
    python -m worker.compute_event_stats --burst-only      # only burst detection
"""

import argparse
import logging
import math
import statistics
import time
from collections import defaultdict
from datetime import datetime, timezone

from .db import connect

log = logging.getLogger("xyzo.compute_event_stats")

BATCH_SIZE = 500


def get_historical_baseline() -> dict:
    """Get historical statistics for baseline comparison."""
    with connect() as conn, conn.cursor() as cur:
        # Get velocity statistics over past 30 days
        cur.execute("""
            SELECT 
                AVG(articles_24h)::float as mean_articles,
                STDDEV(articles_24h)::float as stddev_articles,
                AVG(velocity_score)::float as mean_velocity,
                STDDEV(velocity_score)::float as stddev_velocity,
                AVG(emerging_score)::float as mean_emerging,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY articles_24h)::float as p95_articles,
                PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY articles_24h)::float as p99_articles
            FROM news_event_velocity
            WHERE updated_at > NOW() - INTERVAL '30 days'
        """)
        row = cur.fetchone()
        
        return {
            "mean_articles": row["mean_articles"] or 10,
            "stddev_articles": row["stddev_articles"] or 20,
            "mean_velocity": row["mean_velocity"] or 5,
            "stddev_velocity": row["stddev_velocity"] or 10,
            "mean_emerging": row["mean_emerging"] or 10,
            "p95_articles": row["p95_articles"] or 100,
            "p99_articles": row["p99_articles"] or 200,
        }


def detect_burst(velocity: float, mean: float, stddev: float, threshold: float = 2.0) -> float:
    """Detect if velocity represents a burst (spike).
    
    Returns burst_score: 0 = normal, >1 = burst, >3 = major burst
    """
    if stddev == 0:
        return 0.0
    
    z = (velocity - mean) / stddev
    return max(0, z - threshold)


def compute_z_score(value: float, mean: float, stddev: float) -> float:
    """Compute z-score (standard deviation from mean)."""
    if stddev == 0:
        return 0.0
    return (value - mean) / stddev


def compute_percentile(value: float, sorted_values: list[float]) -> float:
    """Compute percentile rank of value in sorted list."""
    if not sorted_values:
        return 50.0
    
    count_below = sum(1 for v in sorted_values if v < value)
    return (count_below / len(sorted_values)) * 100


def compute_source_independence(conn, event_id: int) -> float:
    """Compute source independence score (0-1).
    
    Higher score = more independent sources (less syndication).
    """
    cur = conn.execute("""
        SELECT 
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE a.source_kind != 'syndicated') as originals
        FROM news_event_sources es
        JOIN news_articles a ON a.id = es.article_id
        WHERE es.event_id = %s
    """, (event_id,))
    row = cur.fetchone()
    
    if not row or row["total"] == 0:
        return 0.5
    
    return row["originals"] / row["total"]


def get_recent_headlines(conn, exclude_id: int | None = None, limit: int = 100) -> list[str]:
    """Return the most recently updated active event headlines.

    FIX 2026-11-14: this used to be inlined into compute_novelty_score()
    and executed once per event. It is now fetched ONCE per batch and
    reused, because the result does not depend on the event being
    scored.

    The result is cached per-connection so a batch of N events costs one
    query instead of N.
    """
    cache = getattr(conn, "_xyzo_recent_headlines", None)
    if cache is not None:
        return cache

    params = (exclude_id,) if exclude_id is not None else ()
    where = "id != %s" if exclude_id is not None else "TRUE"
    cur = conn.execute(f"""
        SELECT headline
        FROM news_events
        WHERE {where}
          AND status = 'active'
          AND updated_at > NOW() - INTERVAL '7 days'
        ORDER BY updated_at DESC
        LIMIT {int(limit)}
    """, params)
    headlines = [row["headline"] for row in cur.fetchall()]

    try:
        conn._xyzo_recent_headlines = headlines
    except AttributeError:
        pass
    return headlines


def compute_novelty_score(conn, event_id: int, headline: str) -> float:
    """Compute novelty score: how different this event is from past events.
    
    Simple heuristic: compare headline keywords to recent event headlines.
    Returns 0-1 where 1 = highly novel (new topic).
    """
    # FIX_NOTES 1.10: psycopg3 Connection has no .fetchall() — this module
    # had NEVER run successfully. Cursor-returning execute + cursor fetchall.
    #
    # FIX 2026-11-14 (N+1): this query was executed ONCE PER EVENT.
    #
    # The set of "recent headlines" it selects does NOT depend on the
    # event being scored — it is the same 100 most-recently-updated
    # headlines for every event in the batch (the only per-event term is
    # `id != %s`, which excludes at most one row). Re-running it per
    # event meant a full scan of the 1,073,142-row news_events table for
    # EVERY event: up to 5,000 scans per run.
    #
    # The measured damage on this database: news_events accumulated
    # 30,051,073 sequential scans reading 4,332,189,412,155 rows, which
    # pinned the SATA SSD at 100% utilisation with 582ms read latency
    # and left the whole machine at 30% io-wait.
    #
    # The batch caller now passes in a pre-fetched list of recent
    # headlines; this function keeps its original signature so any other
    # caller still works, falling back to a single query if no list is
    # supplied.
    recent_headlines = get_recent_headlines(conn, exclude_id=event_id)
    
    if not recent_headlines:
        return 0.5  # No history, assume average novelty
    
    # Simple word overlap check
    headline_words = set(headline.lower().split())
    overlaps = []
    for rh in recent_headlines:
        rh_words = set(rh.lower().split())
        if headline_words:
            overlap = len(headline_words & rh_words) / len(headline_words)
            overlaps.append(overlap)
    
    avg_overlap = statistics.mean(overlaps) if overlaps else 0
    return max(0, 1 - avg_overlap * 2)  # Higher novelty if less overlap


def compute_event_stats_batch(event_ids: list[int]) -> list[dict]:
    """Compute statistics for a batch of events."""
    results = []
    baseline = get_historical_baseline()
    
    with connect() as conn:
        # FIX 2026-11-14 (N+1 -> single query):
        # This loop previously ran THREE queries per event:
        #   1. the event row + velocity join          (WHERE e.id = %s)
        #   2. compute_source_independence()          (per event)
        #   3. compute_novelty_score()                (per event, and this
        #                                                one scanned the whole
        #                                                news_events table)
        # For a 5,000-event batch that is 15,000 round trips and 5,000
        # full-table scans.
        #
        # Now: ONE query fetches every event row via `= ANY(%s)`, and ONE
        # query fetches source-independence for the whole batch. The
        # recent-headline set used by the novelty score is fetched once
        # and cached on the connection.
        if not event_ids:
            return results

        cur = conn.execute("""
            SELECT e.id, e.headline, e.event_type, e.source_count,
                   e.first_reported_at, e.occurred_at,
                   v.articles_1h, v.articles_6h, v.articles_24h,
                   v.velocity_score, v.emerging_score,
                   v.geographic_spread_km, v.propagation_velocity_km_h,
                   v.first_article_at, v.last_article_at,
                   v.countries_24h, v.cities_24h,
                   v.unique_sources, v.original_sources, v.syndicated_copies
            FROM news_events e
            LEFT JOIN news_event_velocity v ON v.event_id = e.id
            WHERE e.id = ANY(%s)
        """, (list(event_ids),))
        rows = {row["id"]: row for row in cur.fetchall()}

        # Source independence for the whole batch in one round trip.
        src_cur = conn.execute("""
            SELECT es.event_id,
                   COUNT(*) as total,
                   COUNT(*) FILTER (WHERE a.source_kind != 'syndicated') as originals
            FROM news_event_sources es
            JOIN news_articles a ON a.id = es.article_id
            WHERE es.event_id = ANY(%s)
            GROUP BY es.event_id
        """, (list(event_ids),))
        independence = {
            row["event_id"]: (row["originals"] / row["total"] if row["total"] else 0.5)
            for row in src_cur.fetchall()
        }

        # Prime the recent-headline cache once for the whole batch.
        get_recent_headlines(conn)

        for event_id in event_ids:
            row = rows.get(event_id)
            
            if not row:
                continue
            
            # Compute velocity metrics
            articles_24h = row["articles_24h"] or 0
            velocity_24h = articles_24h / 24.0
            
            # Burst detection
            burst_score = detect_burst(
                articles_24h,
                baseline["mean_articles"],
                baseline["stddev_articles"]
            )
            
            # Z-score
            z_score = compute_z_score(
                articles_24h,
                baseline["mean_articles"],
                baseline["stddev_articles"]
            )
            
            # Percentile
            # (Using fixed baseline for simplicity - could query historical values)
            if articles_24h > baseline["p99_articles"]:
                percentile = 99.0
            elif articles_24h > baseline["p95_articles"]:
                percentile = 95.0
            else:
                percentile = min(99, (articles_24h / baseline["p95_articles"]) * 95)
            
            # Acceleration
            articles_6h = row["articles_6h"] or 0
            if articles_6h > 0:
                acceleration = (articles_24h - articles_6h) / articles_6h
            else:
                acceleration = 0
            
            # Source independence — precomputed for the whole batch above.
            source_independence = independence.get(event_id, 0.5)
            
            # Novelty — uses the batch-cached recent-headline set.
            novelty = compute_novelty_score(conn, event_id, row["headline"] or "")
            
            # Time span
            time_span = 0
            if row["first_article_at"] and row["last_article_at"]:
                delta = row["last_article_at"] - row["first_article_at"]
                time_span = delta.total_seconds() / 3600
            
            results.append({
                "event_id": event_id,
                "article_count_1h": row["articles_1h"] or 0,
                "article_count_6h": articles_6h,
                "article_count_24h": articles_24h,
                "unique_sources_24h": row["unique_sources"] or 0,
                "original_sources_24h": row["original_sources"] or 0,
                "syndicated_copies_24h": row["syndicated_copies"] or 0,
                "countries_24h": row["countries_24h"] or 0,
                "cities_24h": row["cities_24h"] or 0,
                "geographic_spread_km": row["geographic_spread_km"] or 0,
                "first_article_at": row["first_article_at"],
                "last_article_at": row["last_article_at"],
                "time_span_hours": time_span,
                "velocity_1h": (row["articles_1h"] or 0),
                "velocity_6h": articles_6h / 6.0 if articles_6h else 0,
                "velocity_24h": velocity_24h,
                "acceleration": acceleration,
                "burst_score": burst_score,
                "z_score": z_score,
                "percentile": percentile,
                "novelty_score": novelty,
                "source_independence_score": source_independence,
            })
    
    return results


def compute_all_event_stats(limit: int | None = None) -> dict:
    """Compute statistics for all active events."""
    start_time = time.time()
    total_computed = 0
    
    with connect() as conn:
        # FIX 2026-11-14: the LIMIT was applied in PYTHON, after fetching
        # every active event id. With 1,073,142 active events that meant
        # a 1,073,142-row result set was materialised and transferred to
        # the client even when the caller only wanted --limit 500.
        #
        # The limit is now pushed into the query so the database does the
        # limiting and only the requested rows cross the wire. The ORDER
        # BY source_count DESC is preserved, and the supporting partial
        # index (idx_news_events_status_source_count) makes it an index
        # scan rather than a sort over the whole table.
        if limit:
            cur = conn.execute("""
                SELECT id FROM news_events
                WHERE status = 'active'
                ORDER BY source_count DESC
                LIMIT %s
            """, (int(limit),))
        else:
            cur = conn.execute("""
                SELECT id FROM news_events 
                WHERE status = 'active'
                ORDER BY source_count DESC
            """)
        event_ids = [row["id"] for row in cur.fetchall()]
    
    total_events = len(event_ids)
    log.info("Computing stats for %d events", total_events)
    
    # Process in batches
    for i in range(0, len(event_ids), BATCH_SIZE):
        batch = event_ids[i:i+BATCH_SIZE]
        
        try:
            results = compute_event_stats_batch(batch)
            
            # Upsert results
            #
            # FIX 2026-11-14: this was one INSERT round trip PER EVENT.
            # psycopg3's executemany() sends the whole batch as a single
            # pipelined request instead of 500 separate round trips.
            with connect() as conn:
                if results:
                    # psycopg3 exposes executemany() on the CURSOR, not on
                    # the Connection (unlike psycopg2).
                    with conn.cursor() as cur:
                        cur.executemany("""
                        INSERT INTO news_event_stats 
                            (event_id, article_count_1h, article_count_6h, article_count_24h,
                             unique_sources_24h, original_sources_24h, syndicated_copies_24h,
                             countries_24h, cities_24h, geographic_spread_km,
                             first_article_at, last_article_at, time_span_hours,
                             velocity_1h, velocity_6h, velocity_24h, acceleration,
                             burst_score, z_score, percentile, novelty_score,
                             source_independence_score, computed_at)
                        VALUES 
                            (%(event_id)s, %(article_count_1h)s, %(article_count_6h)s,
                             %(article_count_24h)s, %(unique_sources_24h)s,
                             %(original_sources_24h)s, %(syndicated_copies_24h)s,
                             %(countries_24h)s, %(cities_24h)s, %(geographic_spread_km)s,
                             %(first_article_at)s, %(last_article_at)s, %(time_span_hours)s,
                             %(velocity_1h)s, %(velocity_6h)s, %(velocity_24h)s, %(acceleration)s,
                             %(burst_score)s, %(z_score)s, %(percentile)s, %(novelty_score)s,
                             %(source_independence_score)s, NOW())
                        ON CONFLICT (event_id) DO UPDATE SET
                            article_count_1h = EXCLUDED.article_count_1h,
                            article_count_6h = EXCLUDED.article_count_6h,
                            article_count_24h = EXCLUDED.article_count_24h,
                            velocity_24h = EXCLUDED.velocity_24h,
                            acceleration = EXCLUDED.acceleration,
                            burst_score = EXCLUDED.burst_score,
                            z_score = EXCLUDED.z_score,
                            percentile = EXCLUDED.percentile,
                            source_independence_score = EXCLUDED.source_independence_score,
                            computed_at = NOW()
                        """, results)
            
            total_computed += len(results)
            
        except Exception as e:
            log.error("Error processing batch starting at %d: %s", i, e)
        
        if (i + BATCH_SIZE) % 5000 == 0:
            elapsed = time.time() - start_time
            log.info("Progress: %d/%d events, elapsed: %.1fs", 
                    min(i + BATCH_SIZE, total_events), total_events, elapsed)
        
        if limit and total_computed >= limit:
            break
    
    elapsed = time.time() - start_time
    return {
        "events_computed": total_computed,
        "elapsed_seconds": elapsed,
        "events_per_second": total_computed / elapsed if elapsed > 0 else 0,
    }


def main():
    parser = argparse.ArgumentParser(description="Compute event statistics")
    parser.add_argument("--event-id", type=int, help="Compute for single event")
    parser.add_argument("--limit", type=int, help="Limit number of events")
    parser.add_argument("--burst-only", action="store_true", help="Only compute burst detection")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s"
    )
    
    if args.event_id:
        results = compute_event_stats_batch([args.event_id])
        if results:
            print(f"Stats for event {args.event_id}:")
            for k, v in results[0].items():
                print(f"  {k}: {v}")
    else:
        result = compute_all_event_stats(limit=args.limit)
        print(f"Event stats computation complete:")
        print(f"  Events computed: {result['events_computed']}")
        print(f"  Elapsed: {result['elapsed_seconds']:.1f}s")
        print(f"  Rate: {result['events_per_second']:.1f} events/sec")


if __name__ == "__main__":
    main()
