#!/usr/bin/env python3
"""One-shot correction of the +7/8h feedparser timezone skew (FIX_NOTES 1.1).

Bug: worker/fetch.py used time.mktime() on feedparser's UTC structs, so every
RSS-parsed published_at was shifted forward by the LA UTC offset (7h PDT /
8h PST, DST-aware per row). Fixed in code 2026-09-26 10:05 UTC — this script
corrects rows ingested BEFORE that cutoff.

The shift added to each row was exactly -offset_at_that_wallclock, so:
    true = stored + utc_offset(LA wall clock at stored instant)

DANGER: re-running on the same window double-subtracts the offset. The
--before cutoff must equal the code-deploy time; only rows fetched before it
are touched. NEVER widen the window without restoring a backup.

Usage:
    scripts/backfill_published_tz.py --check        # sample report only
    scripts/backfill_published_tz.py --before 2026-09-26T10:05:30 --run
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from worker.db import connect  # noqa: E402

BATCH = 5000
SLEEP_BETWEEN_BATCHES_S = 0.2

SAMPLE_SQL = """
    SELECT a.id, a.published_at, a.fetched_at,
           a.published_at + make_interval(secs =>
               EXTRACT(EPOCH FROM (a.published_at AT TIME ZONE 'America/Los_Angeles'))
             - EXTRACT(EPOCH FROM a.published_at))
               AS corrected
    FROM news_articles a
    JOIN news_sources s ON s.id = a.source_id
    WHERE s.source_type = 'rss'
      AND a.published_at IS NOT NULL
      AND a.fetched_at < %s::timestamptz
      AND a.id > %s
    ORDER BY a.id
    LIMIT 5
"""

COUNT_SQL = """
    SELECT count(*), COALESCE(max(a.id), 0)
    FROM news_articles a
    JOIN news_sources s ON s.id = a.source_id
    WHERE s.source_type = 'rss'
      AND a.published_at IS NOT NULL
      AND a.fetched_at < %s::timestamptz
      AND a.id > %s
"""

UPDATE_BATCH_SQL = """
    WITH batch AS (
        SELECT a.id
        FROM news_articles a
        JOIN news_sources s ON s.id = a.source_id
        WHERE s.source_type = 'rss'
          AND a.published_at IS NOT NULL
          AND a.fetched_at < %(cut)s::timestamptz
          AND a.id > %(cur)s
        ORDER BY a.id
        LIMIT %(n)s
    )
    UPDATE news_articles a
    SET published_at = a.published_at + make_interval(secs =>
            EXTRACT(EPOCH FROM (a.published_at AT TIME ZONE 'America/Los_Angeles'))
          - EXTRACT(EPOCH FROM a.published_at))
    FROM batch b
    WHERE a.id = b.id
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--before", default="2026-09-26T10:05:30+00:00",
                    help="only rows fetched before this timestamp (the code fix deploy time)")
    ap.add_argument("--check", action="store_true", help="sample rows, no writes")
    ap.add_argument("--run", action="store_true", help="apply the correction")
    ap.add_argument("--start-id", type=int, default=0, help="resume cursor (for retries after a crash)")
    ap.add_argument("--sleep", type=float, default=SLEEP_BETWEEN_BATCHES_S)
    args = ap.parse_args()

    with connect() as conn, conn.cursor() as cur:
        cur.execute(SAMPLE_SQL, (args.before, 0))
        print("sample (id, stored, fetched, corrected):")
        for row in cur.fetchall():
            print("  ", row["id"], row["published_at"], row["fetched_at"], "->", row["corrected"])

    with connect() as conn, conn.cursor() as cur:
        cur.execute(COUNT_SQL, (args.before, 0))
        total = cur.fetchone()["count"]
    print(f"rows in scope (fetched before {args.before}): {total:,}")

    if args.check or not args.run:
        print("dry-run only — pass --run to apply")
        return 0

    cursor_id = args.start_id
    done = 0
    import time as _t
    while True:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT COALESCE(MAX(id), 0) AS m FROM ("
                "  SELECT a.id FROM news_articles a"
                "  JOIN news_sources s ON s.id = a.source_id"
                "  WHERE s.source_type = 'rss' AND a.published_at IS NOT NULL"
                "    AND a.fetched_at < %s::timestamptz AND a.id > %s"
                "  ORDER BY a.id LIMIT 5000) x",
                (args.before, cursor_id),
            )
            batch_max = cur.fetchone()["m"]
            if not batch_max:
                break
            cur.execute(UPDATE_BATCH_SQL, {"cut": args.before, "cur": cursor_id, "n": BATCH})
            conn.commit()
        done += BATCH
        cursor_id = batch_max
        if done % 50000 < BATCH:
            print(f"  corrected through id {cursor_id:,} (~{done:,}/{total:,})", flush=True)
        _t.sleep(args.sleep)
    print(f"done: corrected ~{total:,} rows up to id {cursor_id:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
