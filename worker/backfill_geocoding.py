"""One-time backfill for the geocoding backlog.

Audit 3+4 found 13,606 articles in ``news_articles`` with a
``location_text`` but no ``location_id`` — i.e., the geocoder hasn't
caught up. The cron-driven ``run()`` loop processes 300 per cycle
(~6 minutes per pass against public Nominatim at 1 req/sec), so the
backlog piles up faster than it drains.

This script is the **one-time** sweeper. It loops in batches of
``--batch`` articles, dispatches each batch through the parallel
:class:`Geocoder`, and resumes on the next batch until the DB has no
more pending rows. It is idempotent — re-running picks up wherever
the prior run stopped (driven by ``location_id IS NULL``).

It is intentionally NOT a cron schedule. The cron job is still
``./worker/run.sh --step geocode`` (which now uses
``run_parallel``). This backfill just clears the initial 13.6 k pile
so the cron loop can keep up.

Usage::

    # Dry run — just count, no geocoding.
    python -m worker.backfill_geocoding --dry-run

    # Smoke test on 100 articles.
    python -m worker.backfill_geocoding --limit 100

    # Real run: process every pending article (default).
    python -m worker.backfill_geocoding

    # Cap how many to chew through in one invocation.
    python -m worker.backfill_geocoding --limit 5000

    # Tighter Nominatim throttle (self-hosted mirror).
    NEWSIUM_GEOCODE_INTERVAL=0.05 python -m worker.backfill_geocoding --workers 8

Crash-safety:
    Each batch commits inside ``Geocoder``. If we crash mid-batch, the
    completed articles in that batch are already written; the next
    invocation picks up the remainder.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from typing import Any

from .db import connect
from .geocode import Geocoder, MIN_INTERVAL_S

log = logging.getLogger("xyzo.backfill_geocoding")

DEFAULT_BATCH = 100
# Per-invocation default. Setting this very high is fine — the script
# just exits when the DB is clean.
DEFAULT_OVERALL_LIMIT = 50_000


def _fetch_pending(limit: int, *, offset: int = 0) -> list[dict]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, location_text FROM news_articles "
            "WHERE status = 'extracted' AND location_id IS NULL "
            "  AND location_text IS NOT NULL AND location_text <> '' "
            "ORDER BY extracted_at ASC NULLS FIRST, id ASC "
            "LIMIT %s OFFSET %s",
            (limit, offset),
        )
        return cur.fetchall()


def _count_pending() -> int:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) AS n FROM news_articles "
            "WHERE status = 'extracted' AND location_id IS NULL "
            "  AND location_text IS NOT NULL AND location_text <> ''"
        )
        row = cur.fetchone()
        return int(row["n"]) if row else 0


def run(
    *,
    overall_limit: int = DEFAULT_OVERALL_LIMIT,
    batch_size: int = DEFAULT_BATCH,
    max_workers: int | None = None,
    min_interval_s: float | None = None,
    progress: bool = True,
) -> dict:
    """Drain the pending queue in parallel batches.

    Returns a summary dict suitable for printing / logging.
    """
    geocoder = Geocoder(
        max_workers=max_workers,
        min_interval_s=min_interval_s,
    )
    summary: dict[str, Any] = {
        "batches": 0,
        "processed": 0,
        "cached": 0,
        "geocoded": 0,
        "unlocated": 0,
        "errors": 0,
        "remaining": 0,
        "elapsed_s": 0.0,
        "articles_per_s": 0.0,
    }
    try:
        start_at = time.monotonic()
        while summary["processed"] < overall_limit:
            fetch_size = min(batch_size, overall_limit - summary["processed"])
            batch = _fetch_pending(fetch_size)
            if not batch:
                break
            batch_start = time.monotonic()
            results = geocoder.geocode_articles(batch)
            batch_elapsed = time.monotonic() - batch_start

            for art, res in results:
                summary["processed"] += 1
                if res is None:
                    summary["errors"] += 1
                    continue
                st = res.get("status")
                if st == "cached":
                    summary["cached"] += 1
                    summary["geocoded"] += 1
                elif st == "geocoded":
                    summary["geocoded"] += 1
                elif st == "unlocated":
                    summary["unlocated"] += 1
                # "skipped" / "error" contribute to errors counter
                elif st == "error":
                    summary["errors"] += 1

            summary["batches"] += 1
            if progress:
                rate = (summary["processed"]) / max(1e-6, time.monotonic() - start_at)
                print(
                    f"  batch {summary['batches']}: "
                    f"processed={summary['processed']} "
                    f"geocoded={summary['geocoded']} cached={summary['cached']} "
                    f"unlocated={summary['unlocated']} errors={summary['errors']} "
                    f"(batch took {batch_elapsed:.1f}s, "
                    f"overall {rate:.2f}/s)",
                    flush=True,
                )
        summary["elapsed_s"] = round(time.monotonic() - start_at, 1)
        summary["articles_per_s"] = round(
            summary["processed"] / max(1e-6, summary["elapsed_s"]), 2
        )
        summary["remaining"] = _count_pending()
    finally:
        geocoder.shutdown(wait=True)
    return summary


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--limit", type=int, default=DEFAULT_OVERALL_LIMIT,
                   help=f"Cap articles to process (default {DEFAULT_OVERALL_LIMIT}).")
    p.add_argument("--batch", type=int, default=DEFAULT_BATCH,
                   help=f"Articles per parallel batch (default {DEFAULT_BATCH}).")
    p.add_argument("--workers", type=int, default=None,
                   help=f"Override $NEWSIUM_GEOCODE_WORKERS.")
    p.add_argument("--interval", type=float, default=None,
                   help="Override $NEWSIUM_GEOCODE_INTERVAL (seconds between "
                        "Nominatim calls; 1.1s for public, 0.05 for self-hosted).")
    p.add_argument("--dry-run", action="store_true",
                   help="Just count pending articles, do nothing.")
    p.add_argument("--quiet", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    pending = _count_pending()
    print(f"backfill_geocoding: {pending} articles pending geocoding")
    if pending == 0:
        print("  nothing to do")
        return 0
    if args.dry_run:
        print(f"  dry run; would process up to {min(args.limit, pending)}")
        return 0
    print(
        f"  config: limit={args.limit} batch={args.batch} "
        f"workers={args.workers or os.environ.get('NEWSIUM_GEOCODE_WORKERS', 4)} "
        f"interval={args.interval or MIN_INTERVAL_S}s"
    )

    summary = run(
        overall_limit=args.limit,
        batch_size=args.batch,
        max_workers=args.workers,
        min_interval_s=args.interval,
    )
    print()
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
