#!/usr/bin/env python3
"""
Compute/update news_event_graph_features from news_story_links.

Incremental mode (default): only touch events whose articles have had
new links in the last N hours. Full mode (--full): recompute all.

Usage:
    python -m worker.compute_event_graph_features --dry-run
    python -m worker.compute_event_graph_features --full     # full refresh
    python -m worker.compute_event_graph_features --hours 6  # incremental, last 6h
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from worker.db import connect

log = logging.getLogger("xyzo.graph_features")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

INCREMENTAL_HOURS = 6  # Default: only refresh events with recent link activity


SQL_REFRESH_INCREMENTAL = """
-- Refresh graph features for events with recent link activity
WITH recent_link_events AS (
    -- Events whose articles have new links in the last N hours
    SELECT DISTINCT ses.event_id
    FROM news_event_sources ses
    JOIN news_story_links l ON l.source_article_id = ses.article_id
    WHERE l.created_at > NOW() - INTERVAL '%s hours'
),
affected_events AS (
    -- Also include events whose articles are targets of new links
    SELECT DISTINCT ses2.event_id
    FROM news_event_sources ses2
    JOIN news_story_links l2 ON l2.target_article_id = ses2.article_id
    WHERE l2.created_at > NOW() - INTERVAL '%s hours'
),
all_affected AS (
    SELECT event_id FROM recent_link_events
    UNION
    SELECT event_id FROM affected_events
)
INSERT INTO news_event_graph_features
WITH
article_link_stats AS (
    SELECT
        ses.event_id,
        ses.article_id,
        COUNT(l.id) AS outgoing,
        COALESCE(SUM(l.link_strength), 0) AS outgoing_strength,
        COUNT(l.id) FILTER (WHERE l.link_type = 'same_event') AS same_event_out,
        COUNT(l.id) FILTER (WHERE l.link_type = 'ai_detected') AS ai_out,
        COUNT(l.id) FILTER (WHERE l.link_type = 'same_city') AS city_out,
        COUNT(l.id) FILTER (WHERE l.link_type = 'same_topic') AS topic_out,
        COUNT(l.id) FILTER (WHERE l.link_type = 'same_country') AS country_out,
        COALESCE(MAX(l.link_strength), 0) AS max_out_strength
    FROM news_event_sources ses
    LEFT JOIN news_story_links l ON l.source_article_id = ses.article_id
    -- FIX 2026-11-14: a third join, `LEFT JOIN news_event_sources tes
    -- ON tes.article_id = l.target_article_id`, used to sit here. It was
    -- DEAD CODE — `tes` never appeared in the SELECT list, the GROUP BY,
    -- or any predicate — and it was both catastrophic and wrong:
    --
    --   * it multiplied every (ses, l) row by the number of news_event_sources
    --     rows for the TARGET article. 56,403 articles belong to more than
    --     one event and 203,608 links point at them, so those links were
    --     counted once per event they happened to belong to. That inflated
    --     `outgoing`, `outgoing_strength` and every `*_out` counter — a
    --     correctness bug in the stored graph features.
    --   * it turned a 512,146-row join into one that did not finish in
    --     600 seconds. Measured: the CTE timed out at 600s WITH the join
    --     and returned in 512k rows WITHOUT it.
    WHERE ses.event_id IN (SELECT event_id FROM all_affected)
    GROUP BY ses.event_id, ses.article_id
),
article_incoming_stats AS (
    SELECT
        ses.event_id,
        ses.article_id,
        COUNT(l.id) AS incoming,
        COALESCE(SUM(l.link_strength), 0) AS incoming_strength
    FROM news_event_sources ses
    LEFT JOIN news_story_links l ON l.target_article_id = ses.article_id
    WHERE ses.event_id IN (SELECT event_id FROM all_affected)
    GROUP BY ses.event_id, ses.article_id
),
same_event_internal AS (
    SELECT ses.event_id,
        COUNT(l.id) AS internal_same_event,
        COALESCE(SUM(l.link_strength), 0) AS internal_strength
    FROM news_event_sources ses
    JOIN news_story_links l ON l.source_article_id = ses.article_id
    JOIN news_event_sources tes ON tes.article_id = l.target_article_id AND tes.event_id = ses.event_id
    WHERE ses.event_id IN (SELECT event_id FROM all_affected)
    GROUP BY ses.event_id
),
event_linked_events AS (
    SELECT ses.event_id,
        COUNT(DISTINCT tes.event_id) FILTER (WHERE tes.event_id != ses.event_id) AS unique_other_events
    FROM news_event_sources ses
    JOIN news_story_links l ON l.source_article_id = ses.article_id
    JOIN news_event_sources tes ON tes.article_id = l.target_article_id
    WHERE ses.event_id IN (SELECT event_id FROM all_affected)
      AND tes.event_id != ses.event_id
    GROUP BY ses.event_id
),
event_article_counts AS (
    SELECT event_id, COUNT(DISTINCT article_id) AS article_count
    FROM news_event_sources
    WHERE event_id IN (SELECT event_id FROM all_affected)
    GROUP BY event_id
),
event_stats AS (
    SELECT
        als.event_id,
        COALESCE(eac.article_count, 0) AS articles_in_event,
        SUM(als.outgoing) AS total_links,
        COALESCE(SUM(ais.incoming), 0) AS incoming_links,
        SUM(als.outgoing) AS outgoing_links,
        SUM(als.same_event_out) AS same_event_links,
        SUM(als.ai_out) AS ai_detected_links,
        SUM(als.city_out) AS same_city_links,
        SUM(als.topic_out) AS same_topic_links,
        SUM(als.country_out) AS same_country_links,
        SUM(als.outgoing_strength + COALESCE(ais.incoming_strength, 0)) AS total_link_strength,
        GREATEST(MAX(als.max_out_strength), 0) AS max_link_strength,
        COALESCE(MAX(elu.unique_other_events), 0) AS unique_linked_events,
        COALESCE(MAX(sei.internal_same_event), 0) AS same_event_internal_links,
        COALESCE(MAX(sei.internal_strength), 0) AS same_event_internal_strength
    FROM article_link_stats als
    LEFT JOIN article_incoming_stats ais ON ais.event_id = als.event_id AND ais.article_id = als.article_id
    LEFT JOIN event_article_counts eac ON eac.event_id = als.event_id
    LEFT JOIN event_linked_events elu ON elu.event_id = als.event_id
    LEFT JOIN same_event_internal sei ON sei.event_id = als.event_id
    GROUP BY als.event_id, eac.article_count
)
SELECT
    es.event_id,
    es.articles_in_event,
    es.total_links,
    es.incoming_links,
    es.outgoing_links,
    es.same_event_links,
    es.ai_detected_links,
    es.same_city_links,
    es.same_topic_links,
    es.same_country_links,
    es.total_link_strength::REAL,
    CASE WHEN es.total_links > 0
         THEN (es.total_link_strength / es.total_links)::REAL
         ELSE 0 END AS avg_link_strength,
    es.max_link_strength,
    es.unique_linked_events,
    (CASE WHEN es.same_event_links > 0 THEN 1 ELSE 0 END +
     CASE WHEN es.ai_detected_links > 0 THEN 1 ELSE 0 END +
     CASE WHEN es.same_city_links > 0 THEN 1 ELSE 0 END +
     CASE WHEN es.same_topic_links > 0 THEN 1 ELSE 0 END +
     CASE WHEN es.same_country_links > 0 THEN 1 ELSE 0 END) AS link_type_count,
    CASE WHEN es.same_event_links > 0
         THEN (es.same_event_internal_strength::REAL / NULLIF(es.same_event_links, 0))::REAL
         ELSE 0 END AS same_event_avg_strength,
    CASE
        WHEN es.total_links = 0 THEN 0
        ELSE LEAST(
            LEAST((es.total_links::REAL / GREATEST(es.articles_in_event, 1)), 10.0) * 0.25
            + LEAST(es.total_link_strength::REAL / 100.0, 10.0) * 0.25
            + LEAST(es.unique_linked_events::REAL / 10.0, 5.0) * 0.20
            + (CASE WHEN es.same_event_links > 0
                    THEN (es.same_event_internal_strength::REAL / es.same_event_links) * 0.15
                    ELSE 0 END)
            + (CASE WHEN es.same_event_links > 0 THEN 1 ELSE 0 END +
               CASE WHEN es.ai_detected_links > 0 THEN 1 ELSE 0 END +
               CASE WHEN es.same_city_links > 0 THEN 1 ELSE 0 END +
               CASE WHEN es.same_topic_links > 0 THEN 1 ELSE 0 END +
               CASE WHEN es.same_country_links > 0 THEN 1 ELSE 0 END)::REAL * 0.15,
            10.0
        )
    END AS connectivity_score
FROM event_stats es
ON CONFLICT (event_id) DO UPDATE SET
    articles_in_event       = EXCLUDED.articles_in_event,
    total_links            = EXCLUDED.total_links,
    incoming_links         = EXCLUDED.incoming_links,
    outgoing_links         = EXCLUDED.outgoing_links,
    same_event_links       = EXCLUDED.same_event_links,
    ai_detected_links      = EXCLUDED.ai_detected_links,
    same_city_links       = EXCLUDED.same_city_links,
    same_topic_links      = EXCLUDED.same_topic_links,
    same_country_links    = EXCLUDED.same_country_links,
    total_link_strength   = EXCLUDED.total_link_strength,
    avg_link_strength     = EXCLUDED.avg_link_strength,
    max_link_strength     = EXCLUDED.max_link_strength,
    unique_linked_events  = EXCLUDED.unique_linked_events,
    link_type_count       = EXCLUDED.link_type_count,
    same_event_avg_strength = EXCLUDED.same_event_avg_strength,
    connectivity_score    = EXCLUDED.connectivity_score,
    updated_at            = NOW();
"""


SQL_REFRESH_FULL = SQL_REFRESH_INCREMENTAL.replace(
    "WHERE l.created_at > NOW() - INTERVAL '%s hours'",
    "WHERE 1=1"
).replace(
    "WHERE l2.created_at > NOW() - INTERVAL '%s hours'",
    "WHERE 1=1"
)


def refresh_graph_features(hours: int | None = None, dry_run: bool = False):
    """Refresh news_event_graph_features table."""
    if hours is not None:
        sql = SQL_REFRESH_INCREMENTAL % (hours, hours)
        log.info("Incremental refresh: events with links in last %d hours", hours)
    else:
        sql = SQL_REFRESH_FULL
        log.info("Full refresh: all events")

    with connect() as conn:
        cur = conn.cursor()

        if dry_run:
            if hours is not None:
                cur.execute(f"""
                    SELECT COUNT(DISTINCT ses.event_id)
                    FROM news_event_sources ses
                    JOIN news_story_links l ON l.source_article_id = ses.article_id
                    WHERE l.created_at > NOW() - INTERVAL '{hours} hours'
                """)
            else:
                cur.execute("SELECT COUNT(*) FROM news_events")
            count = cur.fetchone()['count']
            log.info("  [DRY RUN] Would refresh %d events", count)
            return count

        before = datetime.now(timezone.utc)
        # Pool default is statement_timeout=60000 (worker/db.py:85); this
        # refresh measured 105s against the 64.9M-row news_story_links, so
        # every hourly run died with QueryCanceled and
        # news_event_graph_features sat unrefreshed from 2026-10-02 — the
        # graph interconnection scores /api/feed/* reads off it (feed.ts
        # :251,351,513,651) were a month stale. Raise it for this
        # statement only, the pattern compute_tfidf.py already uses.
        conn.execute("SET statement_timeout = '900s'")

        # FIX 2026-11-14 (join order): the planner picks a MERGE JOIN that
        # INDEX-SCANS ALL 69 MILLION ROWS of news_story_links instead of
        # doing ~26,000 index lookups. Root cause is a bad row estimate: it
        # thinks `news_event_sources` restricted to all_affected has
        # 1,928,874 rows when the real number is 23,023 (84x over), so a
        # full-table merge looks cheaper than a nested loop.
        #
        # Forcing nested loop for this statement (scoped to the
        # transaction with SET LOCAL) is safe here: the driving side is a
        # 4,550-row CTE, and every inner side has a covering index.
        #
        # Measured on the same query, same data:
        #   original planner plan   843.9 s   (full 69M scan, 543s in one CTE)
        #   nested loop forced       84.8 s   -> 10x faster
        #   (a single CTE in isolation: 2.2 s vs 86 s)
        conn.execute("SET LOCAL enable_mergejoin = off")
        conn.execute("SET LOCAL enable_hashjoin = off")

        try:
            cur.execute(sql)
            conn.commit()
        except Exception:
            # Roll back BEFORE re-raising. Without this the cleanup
            # statement in `finally` is rejected with
            #     InFailedSqlTransaction: current transaction is aborted
            # which REPLACED the real error in the journal — the actual
            # failure (QueryCanceled from the timeout) never surfaced, so
            # the service just showed "exit-code" with no cause.
            conn.rollback()
            raise
        finally:
            try:
                conn.execute("RESET statement_timeout")
            except Exception:
                # Connection may already be dead; never mask the real error.
                pass
        rows_affected = cur.rowcount
        elapsed = (datetime.now(timezone.utc) - before).total_seconds()

        # Log summary stats
        cur.execute("""
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE total_links > 0) AS with_links,
                AVG(total_links)::REAL AS avg_links,
                AVG(connectivity_score)::REAL AS avg_score,
                MAX(total_links) AS max_links,
                MAX(updated_at) AS latest_update
            FROM news_event_graph_features
        """)
        stats = dict(cur.fetchone())

        log.info(
            "Graph features refresh: %d events updated in %.1fs | "
            "total=%d with_links=%d avg_links=%.1f avg_score=%.3f max_links=%d latest_update=%s",
            rows_affected, elapsed,
            stats['total'], stats['with_links'], stats['avg_links'],
            stats['avg_score'], stats['max_links'], stats['latest_update']
        )

        return rows_affected


def main():
    parser = argparse.ArgumentParser(description="Compute news_event_graph_features")
    parser.add_argument("--dry-run", action="store_true", help="Count only, don't write")
    parser.add_argument("--full", action="store_true", help="Full refresh of all events (default: incremental)")
    parser.add_argument("--hours", type=int, default=INCREMENTAL_HOURS,
                        help="For incremental mode: look back N hours (default: 6)")
    args = parser.parse_args()

    hours = None if args.full else args.hours
    refresh_graph_features(hours=hours, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
