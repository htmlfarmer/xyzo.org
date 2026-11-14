"""Worker module to compute and track news source publication frequencies (posting cadence).

Calculates publication cadence per news source:
- articles_24h, articles_7d, articles_30d
- avg_articles_per_day, avg_hours_between_articles
- last_article_posted_at
- cadence_tier (high_frequency, daily, weekly, infrequent, dormant)
- recommended_poll_interval_s

Every run is logged in the `cadence_runs` table (success + failure), with a
file-based fallback at $XYZO_CADENCE_LOG or /var/log/xyzo/cadence-runs.log
for the case where the DB itself is unreachable. T-22.

Usage:
    python -m worker.source_cadence --update      # Calculate and update database metrics
    python -m worker.source_cadence --summary     # Display human-readable cadence report
    python -m worker.source_cadence --recommend   # Update poll_interval_s to optimal values based on cadence
"""

import os
import sys
import logging
import time
from datetime import datetime, timezone
import argparse

from worker.db import connect

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("source_cadence")


# ── File fallback for run-logging ────────────────────────────────────
# When the DB itself is unreachable (bad DSN, postgres down, network gone),
# we still want a paper trail so the operator can see *why* the cadence
# worker stopped writing to the database. Without this, T-22's
# "articles_30d = 0" mystery would have been silent in the DB too.
# Path: $XYZO_CADENCE_LOG if set, else /var/log/xyzo/cadence-runs.log.
_CADENCE_LOG = os.environ.get("XYZO_CADENCE_LOG", "/var/log/xyzo/cadence-runs.log")


def _file_log(line: str) -> None:
    """Best-effort append to the run log file. Never raises."""
    try:
        os.makedirs(os.path.dirname(_CADENCE_LOG), exist_ok=True)
        with open(_CADENCE_LOG, "a") as fh:
            fh.write(f"{datetime.now(timezone.utc).isoformat()} {line}\n")
    except Exception:
        pass  # last-resort logging; never escalate


def classify_cadence(articles_24h: int, articles_7d: int, articles_30d: int, avg_per_day: float) -> tuple[str, int]:
    """Determine cadence tier and recommended polling interval in seconds.

    Returns:
        (cadence_tier, recommended_poll_interval_s)
    """
    if avg_per_day >= 10.0 or articles_24h >= 10:
        return "high_frequency", 300       # 5 mins
    elif avg_per_day >= 1.0 or articles_7d >= 7:
        return "daily", 1800              # 30 mins
    elif articles_30d >= 4 or articles_7d >= 1:
        return "weekly", 14400            # 4 hours
    elif articles_30d >= 1:
        return "infrequent", 86400        # 24 hours
    else:
        return "dormant", 172800          # 48 hours


def calculate_and_update_cadence(apply_recommendations: bool = False, trigger: str = "cli") -> dict:
    """Analyze article publication frequencies for all sources and update database columns.

    Every run is recorded in `cadence_runs` so a silent crash (e.g. wrong DSN
    env var, broken SQL, table missing) is visible in the database instead of
    only in the systemd journal. T-22 caught us with `articles_30d = 0`
    everywhere because the worker had been crashing on every timer run for
    weeks — the per-run log would have flagged the very first failure.
    """
    import json as _json
    start_time = datetime.now(timezone.utc)

    # ── Open a run row up-front so a crash mid-flight still leaves a record.
    run_id = None
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO cadence_runs (status, trigger) VALUES ('running', %s) RETURNING id",
                (trigger,),
            )
            run_id = cur.fetchone()["id"]
            conn.commit()
    except Exception as e:
        # DB unreachable — most likely a missing/wrong DSN env var (T-22).
        # Log to a file so the operator can grep for it; the DB itself
        # can't help us here.
        log.error("Could not open cadence_runs row: %s", e)
        _file_log(f"FAIL open-run-row trigger={trigger} err={type(e).__name__}: {e}")
        raise

    def _finalize(status: str, sources: int | None = None, tier_counts: dict | None = None, err: str | None = None):
        try:
            with connect() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE cadence_runs
                    SET finished_at = now(),
                        status = %s,
                        sources_analyzed = %s,
                        tier_counts = %s,
                        error_message = %s
                    WHERE id = %s
                    """,
                    (
                        status,
                        sources,
                        _json.dumps(tier_counts) if tier_counts is not None else None,
                        err,
                        run_id,
                    ),
                )
                conn.commit()
        except Exception as finalize_err:
            log.warning("Failed to finalize cadence_runs row %s: %s", run_id, finalize_err)

    try:
        return _run_cadence(apply_recommendations, _finalize)
    except Exception as e:
        log.exception("Cadence run failed")
        try:
            _finalize("failed", err=f"{type(e).__name__}: {e}")
        except Exception:
            pass
        _file_log(f"FAIL run trigger={trigger} err={type(e).__name__}: {e}")
        raise


def _run_cadence(apply_recommendations: bool, _finalize) -> dict:
    start_time = datetime.now(timezone.utc)

    with connect() as conn, conn.cursor() as cur:
        # Fetch per-source article volume & latest posting timestamps over 24h, 7d, 30d
        cur.execute("""
            SELECT
                s.id,
                s.name,
                s.feed_url,
                s.poll_interval_s,
                COUNT(a.id) FILTER (WHERE a.published_at > NOW() - INTERVAL '24 hours' OR a.fetched_at > NOW() - INTERVAL '24 hours') AS articles_24h,
                COUNT(a.id) FILTER (WHERE a.published_at > NOW() - INTERVAL '7 days' OR a.fetched_at > NOW() - INTERVAL '7 days') AS articles_7d,
                COUNT(a.id) FILTER (WHERE a.published_at > NOW() - INTERVAL '30 days' OR a.fetched_at > NOW() - INTERVAL '30 days') AS articles_30d,
                MAX(COALESCE(a.published_at, a.fetched_at)) AS last_article_posted_at
            FROM news_sources s
            LEFT JOIN news_articles a ON a.source_id = s.id
            GROUP BY s.id, s.name, s.feed_url, s.poll_interval_s
        """)
        rows = cur.fetchall()

    if not rows:
        log.info("No sources found to analyze.")
        _finalize("success", sources=0, tier_counts={})
        return {"total_sources": 0, "tiers": {}}

    updated_records = []
    tier_counts = {"high_frequency": 0, "daily": 0, "weekly": 0, "infrequent": 0, "dormant": 0}

    for r in rows:
        source_id = r["id"]
        art_24h = int(r["articles_24h"] or 0)
        art_7d = int(r["articles_7d"] or 0)
        art_30d = int(r["articles_30d"] or 0)
        last_posted = r["last_article_posted_at"]

        # Calculate average articles per day
        avg_per_day = round(art_30d / 30.0, 2)
        
        # Calculate average hours between articles
        if art_30d > 1:
            avg_hours_between = round((30.0 * 24.0) / art_30d, 2)
        elif art_7d > 1:
            avg_hours_between = round((7.0 * 24.0) / art_7d, 2)
        elif art_24h > 1:
            avg_hours_between = round(24.0 / art_24h, 2)
        else:
            avg_hours_between = None

        tier, recommended_interval = classify_cadence(art_24h, art_7d, art_30d, avg_per_day)
        tier_counts[tier] = tier_counts.get(tier, 0) + 1

        record = {
            "id": source_id,
            "articles_24h": art_24h,
            "articles_7d": art_7d,
            "articles_30d": art_30d,
            "avg_articles_per_day": avg_per_day,
            "avg_hours_between_articles": avg_hours_between,
            "last_article_posted_at": last_posted,
            "cadence_tier": tier,
            "recommended_interval": recommended_interval,
            "current_interval": r["poll_interval_s"],
        }
        updated_records.append(record)

    # Batch update database in chunks of 50 to prevent lock contention / deadlocks with concurrent fetchers
    now = datetime.now(timezone.utc)
    chunk_size = 50

    for i in range(0, len(updated_records), chunk_size):
        chunk = updated_records[i : i + chunk_size]
        retries = 3
        while retries > 0:
            try:
                with connect() as conn, conn.cursor() as cur:
                    for rec in chunk:
                        if apply_recommendations:
                            cur.execute("""
                                UPDATE news_sources
                                SET articles_24h = %s,
                                    articles_7d = %s,
                                    articles_30d = %s,
                                    avg_articles_per_day = %s,
                                    avg_hours_between_articles = %s,
                                    last_article_posted_at = %s,
                                    cadence_tier = %s,
                                    cadence_updated_at = %s,
                                    poll_interval_s = %s
                                WHERE id = %s
                            """, (
                                rec["articles_24h"],
                                rec["articles_7d"],
                                rec["articles_30d"],
                                rec["avg_articles_per_day"],
                                rec["avg_hours_between_articles"],
                                rec["last_article_posted_at"],
                                rec["cadence_tier"],
                                now,
                                rec["recommended_interval"],
                                rec["id"],
                            ))
                        else:
                            cur.execute("""
                                UPDATE news_sources
                                SET articles_24h = %s,
                                    articles_7d = %s,
                                    articles_30d = %s,
                                    avg_articles_per_day = %s,
                                    avg_hours_between_articles = %s,
                                    last_article_posted_at = %s,
                                    cadence_tier = %s,
                                    cadence_updated_at = %s
                                WHERE id = %s
                            """, (
                                rec["articles_24h"],
                                rec["articles_7d"],
                                rec["articles_30d"],
                                rec["avg_articles_per_day"],
                                rec["avg_hours_between_articles"],
                                rec["last_article_posted_at"],
                                rec["cadence_tier"],
                                now,
                                rec["id"],
                            ))
                    conn.commit()
                break
            except Exception as e:
                retries -= 1
                if retries == 0:
                    log.warning("Failed to update chunk starting at index %d: %s", i, e)
                else:
                    time.sleep(0.1)

    elapsed = (datetime.now(timezone.utc) - start_time).total_seconds()
    log.info(
        "Cadence update complete: analyzed %d sources in %.2fs. Tier distribution: %s",
        len(updated_records), elapsed, tier_counts
    )

    _finalize("success", sources=len(updated_records), tier_counts=tier_counts)

    return {
        "total_sources": len(updated_records),
        "tier_counts": tier_counts,
        "elapsed_seconds": elapsed,
    }


def print_cadence_summary():
    """Print human-readable summary of news source publication frequency tiers."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT
                cadence_tier,
                COUNT(*) AS total_sources,
                ROUND(AVG(avg_articles_per_day)::numeric, 2) AS avg_daily_articles,
                ROUND(AVG(avg_hours_between_articles)::numeric, 2) AS avg_hours_gap
            FROM news_sources
            GROUP BY cadence_tier
            ORDER BY
                CASE cadence_tier
                    WHEN 'high_frequency' THEN 1
                    WHEN 'daily' THEN 2
                    WHEN 'weekly' THEN 3
                    WHEN 'infrequent' THEN 4
                    ELSE 5
                END
        """)
        tier_summary = cur.fetchall()

        cur.execute("""
            SELECT id, name, country, cadence_tier, avg_articles_per_day, avg_hours_between_articles, last_article_posted_at
            FROM news_sources
            WHERE active = TRUE
            ORDER BY avg_articles_per_day DESC NULLS LAST
            LIMIT 15
        """)
        top_sources = cur.fetchall()

    print("\n" + "=" * 70)
    print(" XYZO NEWS SOURCE PUBLISHING CADENCE REPORT")
    print("=" * 70)
    print(f"{'Cadence Tier':<16} | {'Sources':<8} | {'Avg Articles/Day':<16} | {'Avg Hours Gap':<15}")
    print("-" * 70)
    for t in tier_summary:
        tier = t["cadence_tier"] or "uncalculated"
        count = t["total_sources"]
        daily = t["avg_daily_articles"] or 0.0
        gap = t["avg_hours_gap"] or "N/A"
        print(f"{tier:<16} | {count:<8} | {daily:<16} | {str(gap):<15}")

    print("\nTop 15 Most Frequently Publishing Sources:")
    print("-" * 70)
    print(f"{'Source Name':<35} | {'Country':<8} | {'Daily Avg':<10} | {'Cadence Tier':<15}")
    print("-" * 70)
    for s in top_sources:
        name = (s["name"] or "")[:35]
        cc = s["country"] or "??"
        daily = s["avg_articles_per_day"] or 0.0
        tier = s["cadence_tier"] or "uncalculated"
        print(f"{name:<35} | {cc:<8} | {daily:<10} | {tier:<15}")
    print("=" * 70 + "\n")


def main():
    parser = argparse.ArgumentParser(description="XYZO News Source Publishing Cadence Tracker")
    parser.add_argument("--update", action="store_true", help="Calculate and update cadence metrics in database")
    parser.add_argument("--recommend", action="store_true", help="Apply recommended poll intervals based on cadence")
    parser.add_argument("--summary", action="store_true", help="Print summary report of news source publication frequency")

    args = parser.parse_args()

    if args.update or args.recommend:
        calculate_and_update_cadence(
            apply_recommendations=args.recommend,
            trigger="cli-recommend" if args.recommend else "cli-update",
        )

    if args.summary or (not args.update and not args.recommend):
        calculate_and_update_cadence(apply_recommendations=False, trigger="cli-summary")
        print_cadence_summary()


if __name__ == "__main__":
    main()
