#!/usr/bin/env python3
"""City-Story Intelligence Worker

Continuously processes stories through the city-story ML pipeline:
1. Find stories that need processing
2. Extract geographic + textual features
3. Store features in city_story_features
4. Compute relationships using ML classifier
5. Optionally call Gemma for ambiguous cases

Usage:
    python -m worker.city_story_worker --continuous --batch-size 100
    python -m worker.city_story_worker --once --limit 1000
"""

import argparse
import logging
import signal
import sys
import time
from datetime import datetime, timezone

from .city_story_intel import (
    extract_features_for_article,
    store_features,
    generate_auto_labels,
    store_labels,
    complete_extraction_run,
    start_extraction_run,
)
from .city_story_rels import compute_relationships_for_story
from .db import connect

log = logging.getLogger("xyzo.city_story_worker")

RUNNING = True


def signal_handler(signum, frame):
    global RUNNING
    log.info("Received signal %d, shutting down...", signum)
    RUNNING = False


def get_pending_count() -> int:
    """Count stories waiting to be processed."""
    with connect() as conn:
        result = conn.execute("""
            SELECT count(*) as cnt
            FROM news_articles
            WHERE status = 'extracted'
              AND COALESCE(extracted_lat, suggested_lat) IS NOT NULL
              AND id NOT IN (
                  SELECT DISTINCT story_id FROM city_story_features
              )
        """).fetchone()
        return result['cnt'] if result else 0


def process_batch(batch_size: int = 100) -> tuple[int, int, int]:
    """Process a batch of stories.

    Returns: (processed, matches, candidates)
    """
    with connect() as conn:
        rows = conn.execute("""
            SELECT id, title, body,
                   COALESCE(extracted_lat, suggested_lat) AS lat,
                   COALESCE(extracted_lng, suggested_lng) AS lng
            FROM news_articles
            WHERE status = 'extracted'
              AND COALESCE(extracted_lat, suggested_lat) IS NOT NULL
              AND id NOT IN (
                  SELECT DISTINCT story_id FROM city_story_features
              )
            ORDER BY fetched_at DESC
            LIMIT %(limit)s
            FOR UPDATE SKIP LOCKED
        """, {"limit": batch_size}).fetchall()

    if not rows:
        return 0, 0, 0

    run_id = start_extraction_run(f"worker_batch_{datetime.now(timezone.utc).isoformat()}")

    processed = 0
    matches = 0
    candidates = 0

    for row in rows:
        if not RUNNING:
            break

        try:
            features = extract_features_for_article(
                article_id=row["id"],
                title=row["title"] or "",
                body=row["body"] or "",
                entities=[],
                article_lat=row["lat"],
                article_lng=row["lng"],
                article_country=None,
                article_admin1=None,
            )
            count = store_features(features, run_id)
            candidates += count
            if count > 0:
                matches += 1

            # Generate auto-labels for training (SLOW - skip for now)
            # labels = generate_auto_labels(row["id"])
            # store_labels(labels)

            # NOTE: compute_relationships_for_story is SLOW (1-5s per story)
            # and the city-story API isn't registered yet, so we skip it.
            # Re-enable once the API is integrated:
            # compute_relationships_for_story(row["id"])

            processed += 1

        except Exception as e:
            log.error("Error processing article %d: %s", row["id"], e)
            continue

    complete_extraction_run(run_id, processed, matches, candidates, processing_time_ms=0)

    return processed, matches, candidates


def run_continuous(batch_size: int = 100, poll_interval: float = 5.0):
    """Run continuously, processing batches."""
    log.info("Starting city-story worker (continuous mode, batch_size=%d)", batch_size)

    total_processed = 0
    last_report = time.time()

    while RUNNING:
        pending = get_pending_count()
        if pending == 0:
            log.debug("No pending stories, waiting %gs", poll_interval)
            time.sleep(poll_interval)
            continue

        processed, matches, candidates = process_batch(batch_size)

        if processed == 0:
            time.sleep(poll_interval)
            continue

        total_processed += processed

        # Progress report every 30 seconds
        if time.time() - last_report >= 30:
            pending = get_pending_count()
            log.info(
                "Progress: %d stories processed | %d remaining | %.1f candidates found",
                total_processed, pending, candidates / max(processed, 1)
            )
            last_report = time.time()

    log.info("Worker stopped. Total processed: %d", total_processed)


def run_once(batch_size: int = 100):
    """Process one batch and exit."""
    log.info("Processing single batch (limit=%d)", batch_size)

    processed, matches, candidates = process_batch(batch_size)

    pending = get_pending_count()

    print(f"\n{'='*60}")
    print(f"City-Story Worker Results:")
    print(f"  Processed: {processed} stories")
    print(f"  With matches: {matches}")
    print(f"  Total candidates: {candidates}")
    print(f"  Remaining: {pending}")
    print(f"{'='*60}\n")


def main():
    parser = argparse.ArgumentParser(description="City-Story Intelligence Worker")
    parser.add_argument("--continuous", action="store_true", help="Run continuously")
    parser.add_argument("--once", action="store_true", help="Process one batch and exit")
    parser.add_argument("--batch-size", type=int, default=100, help="Batch size")
    parser.add_argument("--limit", type=int, default=1000, help="Limit for --once mode")
    parser.add_argument("--poll-interval", type=float, default=5.0, help="Poll interval for continuous mode")

    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)-20s %(levelname)-8s %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    if args.continuous:
        run_continuous(batch_size=args.batch_size, poll_interval=args.poll_interval)
    else:
        run_once(batch_size=args.limit)


if __name__ == "__main__":
    main()
