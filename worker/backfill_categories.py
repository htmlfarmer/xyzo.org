"""Category backfill — reclassify articles with NULL/other/'news' event_type.

Uses ONLY the regex keyword classifier (worker/classify.py). No AI, no GPU,
no LLM. Pure sub-millisecond pattern matching — completely safe to run
alongside the live pipeline.

Updates BOTH columns:
  - event_type            (what the map reads via COALESCE in pins.ts)
  - auto_categorize_event_type  (what the NN classifier uses as training signal)

Usage:
    python3 -m worker.backfill_categories                    # full run
    python3 -m worker.backfill_categories --limit 5000       # batched
    python3 -m worker.backfill_categories --dry-run          # count only, no writes
"""
import os
import sys
import time
import argparse
from concurrent.futures import ProcessPoolExecutor

import psycopg2
from psycopg2.extras import execute_batch

from worker.classify import classify

# DSN comes from the environment (XYZO_DB_DSN / XYZO_DB_URL, the same
# sources worker/db.py reads) or the local .pgpass entry — no password is
# embedded in the source tree.
DSN = (
    os.environ.get("XYZO_DB_DSN")
    or os.environ.get("XYZO_DB_URL")
    or "postgresql://xyzo_app@localhost:5432/xyzo"
)


def classify_chunk(rows):
    """Classify a chunk of (id, title, summary, current_type) rows."""
    updates = []
    for art_id, title, summary, current_type in rows:
        new_cat = classify(title or "", summary or "")
        if new_cat != "other" and new_cat != current_type:
            updates.append((new_cat, art_id))
    return updates


def main():
    parser = argparse.ArgumentParser(description="Backfill categories using regex classifier")
    parser.add_argument("--limit", type=int, default=0,
                        help="Max articles to process (0 = no limit)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Count articles that would change, but don't write")
    parser.add_argument("--workers", type=int, default=8,
                        help="ProcessPool workers (default 8)")
    args = parser.parse_args()

    print("Starting category backfill (regex-only, no AI/GPU)...")
    start_time = time.time()
    conn = psycopg2.connect(DSN)
    cur = conn.cursor()

    # Target articles that are unclassified or misclassified
    query = """
        SELECT id, title, summary, event_type
        FROM news_articles
        WHERE (event_type = 'news' OR event_type IS NULL OR event_type = 'other')
        ORDER BY published_at DESC
    """
    if args.limit > 0:
        query += f" LIMIT {args.limit}"

    cur.execute(query)
    rows = cur.fetchall()
    print(f"Fetched {len(rows)} articles for classification check.")

    if not rows:
        print("Nothing to do.")
        cur.close()
        conn.close()
        return

    chunk_size = 2000
    chunks = [rows[i:i + chunk_size] for i in range(0, len(rows), chunk_size)]

    all_updates = []
    with ProcessPoolExecutor(max_workers=args.workers) as executor:
        results = executor.map(classify_chunk, chunks)
        for res in results:
            all_updates.extend(res)

    print(f"Found {len(all_updates)} articles to update "
          f"({len(rows) - len(all_updates)} already classified or no keyword match).")

    if args.dry_run:
        print("Dry run — no changes written.")
        # Show sample of what would change
        cur.execute("""
            SELECT n.title, n.event_type, n.auto_categorize_event_type
            FROM news_articles n
            WHERE n.id = ANY(%s)
            LIMIT 10
        """, ([u[1] for u in all_updates[:10]],))
        sample = cur.fetchall()
        if sample:
            print("\nSample of articles that would be reclassified:")
            for title, old_et, old_acet in sample:
                print(f"  [{old_et or 'NULL'}] {title[:70]}")
    elif all_updates:
        # Update BOTH columns so map display AND NN training signal are correct
        update_query = """
            UPDATE news_articles
            SET event_type = %s,
                auto_categorize_event_type = %s,
                auto_categorize_method = COALESCE(auto_categorize_method, 'fast_path'),
                auto_categorized_at = COALESCE(auto_categorized_at, now())
            WHERE id = %s;
        """
        # Pair each update for both columns
        dual_updates = [(cat, cat, art_id) for cat, art_id in all_updates]
        execute_batch(cur, update_query, dual_updates, page_size=1000)
        conn.commit()
        print(f"Successfully updated {len(all_updates)} articles!")

    # Post-update breakdown of event_type
    cur.execute("""
        SELECT COALESCE(event_type, 'NULL') as et, COUNT(*)
        FROM news_articles
        WHERE published_at > now() - interval '1 day'
          AND extracted_lat IS NOT NULL AND extracted_lat != 0
        GROUP BY et
        ORDER BY COUNT(*) DESC
        LIMIT 25
    """)
    stats = cur.fetchall()
    print("\n--- EVENT_TYPE BREAKDOWN (last 24h, map-visible articles) ---")
    total = sum(c for _, c in stats)
    for cat, count in stats:
        pct = (count / total) * 100 if total else 0
        marker = " ✓" if cat not in ("NULL", "other", "news") else ""
        print(f"  {cat:<20}: {count:>6} ({pct:>5.1f}%){marker}")

    cur.close()
    conn.close()
    print(f"\nCompleted in {time.time() - start_time:.2f} seconds.")


if __name__ == "__main__":
    main()
