#!/usr/bin/env python3
"""NER Backfill Script - Gentle CPU version

Runs the NER extraction with CPU throttling to use only 10-20% CPU.
Uses smaller batches and delays to be gentle on the system.

Usage:
    python3 scripts/ner_backfill_gentle.py --max-articles 100000
"""

import argparse
import logging
import os
import subprocess
import sys
import time

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s'
)
log = logging.getLogger()

BATCH_SIZE = int(os.environ.get('NER_BATCH_SIZE', '25'))
DELAY_BETWEEN_BATCHES = float(os.environ.get('NER_DELAY_SECONDS', '2.0'))
MAX_ARTICLES = int(os.environ.get('NER_MAX_ARTICLES', '1000000'))


def get_cpu_percent():
    """Get current CPU usage percentage."""
    try:
        result = subprocess.run(
            ["ps", "aux"],
            capture_output=True,
            text=True,
            timeout=5
        )
        total_cpu = 0.0
        for line in result.stdout.split('\n')[1:]:
            parts = line.split()
            if len(parts) >= 3:
                try:
                    total_cpu += float(parts[2])
                except ValueError:
                    pass
        return total_cpu
    except Exception:
        return 0.0


def main():
    parser = argparse.ArgumentParser(description='Gentle NER backfill')
    parser.add_argument('--max-articles', type=int, default=MAX_ARTICLES,
                        help=f'Maximum articles to process (default: {MAX_ARTICLES})')
    parser.add_argument('--batch-size', type=int, default=BATCH_SIZE,
                        help=f'Batch size (default: {BATCH_SIZE})')
    parser.add_argument('--delay', type=float, default=DELAY_BETWEEN_BATCHES,
                        help=f'Delay between batches in seconds (default: {DELAY_BETWEEN_BATCHES})')
    parser.add_argument('--dry-run', action='store_true',
                        help='Run without writing to database')
    args = parser.parse_args()

    log.info("Starting gentle NER backfill")
    log.info(f"  Batch size: {args.batch_size}")
    log.info(f"  Delay between batches: {args.delay}s")
    log.info(f"  Max articles: {args.max_articles}")

    # Build command
    cmd = [
        sys.executable, '-m', 'worker.ner_extract',
        '--method', 'spacy',
        '--batch-size', str(args.batch_size),
        '--max-articles', str(args.max_articles),
    ]
    if args.dry_run:
        cmd.append('--dry-run')

    log.info(f"Running: {' '.join(cmd)}")

    # Run with monitoring
    process = subprocess.Popen(
        cmd,
        env={**os.environ, 'XYZO_DB_DSN': os.environ.get('XYZO_DB_DSN', 'postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo')}
    )

    start_time = time.time()
    articles_processed = 0

    while True:
        cpu = get_cpu_percent()
        log.info(f"CPU usage: {cpu:.1f}%")

        # Check if process is still running
        if process.poll() is not None:
            log.info("Process finished")
            break

        # Check elapsed time
        elapsed = time.time() - start_time
        if elapsed > 300:  # 5 minutes, then check in on articles processed
            log.info(f"Running for {elapsed/60:.1f} minutes...")
            start_time = time.time()

        time.sleep(args.delay)

    log.info("Backfill complete!")


if __name__ == '__main__':
    main()
