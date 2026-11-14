#!/usr/bin/env python3
"""Retention pruning for append-only telemetry tables (FIX_NOTES 8.3).

Disk sits at 88% and these tables are write-mostly with no pruning:
  source_poll_observations  (90d retention)
  news_fetch_decisions      (30d — never read by any endpoint today)
  news_performance_metrics  (30d)

Batched deletes (id-keyed, 10k per statement) so we never hold long row
locks against the fetch cycles. Run from a systemd timer; also safe by
hand.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from worker.db import connect  # noqa: E402

RETENTION = [
    ("source_poll_observations", "polled_at", "90 days"),
    ("news_fetch_decisions", "created_at", "30 days"),
    ("news_performance_metrics", "created_at", "30 days"),
    # Which overlays a reader had on, at what opacity, and which preset
    # they opened. One row per session per day per setting; 90 days is
    # long enough to tune a preset against a season of use and short
    # enough that the table stays a footnote. `day` is the partition —
    # pruning by it is a range delete, not a scan.
    ("map_settings_usage", "day", "90 days"),
    # The frame cadence, renderer and wind numbers readers' browsers
    # report (2026-11-14). Two rows per session per day; `day` is the
    # partition for the same reason as above.
    ("client_perf", "day", "90 days"),
]
BATCH = 10_000
MAX_BATCHES_PER_TABLE = 2000  # safety valve: ≤20M rows per run


def prune(table: str, ts_col: str, window: str) -> int:
    deleted = 0
    for _ in range(MAX_BATCHES_PER_TABLE):
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                f"""
                WITH victims AS (
                    SELECT id FROM {table}
                    WHERE {ts_col} < now() - INTERVAL '{window}'
                    ORDER BY id LIMIT {BATCH}
                )
                DELETE FROM {table} t USING victims v WHERE t.id = v.id
                """,
            )
            n = cur.rowcount
            conn.commit()
        deleted += n
        if n < BATCH:
            break
    return deleted


def main() -> int:
    for table, ts_col, window in RETENTION:
        try:
            n = prune(table, ts_col, window)
            print(f"{table}: deleted {n:,} rows older than {window}", flush=True)
        except Exception as exc:
            print(f"{table}: prune failed: {exc}", file=sys.stderr, flush=True)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
