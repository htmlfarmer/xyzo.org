#!/usr/bin/env python3
"""Monitor NER backfill progress.

Usage:
    python3 scripts/monitor_ner_progress.py
"""

import os
import psycopg
import sys

def main():
    dsn = os.environ.get("XYZO_DB_DSN", "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo")
    conn = psycopg.connect(dsn, row_factory=psycopg.rows.dict_row)
    cur = conn.cursor()

    # Overall stats
    cur.execute("""
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN array_length(entities, 1) > 0 THEN 1 ELSE 0 END) as with_entities
        FROM news_articles
        WHERE status = 'extracted'
    """)
    stats = cur.fetchone()
    total = stats['total']
    with_entities = stats['with_entities']
    pct = with_entities / total * 100 if total > 0 else 0

    print(f"📊 NER Entity Extraction Progress")
    print(f"{'='*50}")
    print(f"Total articles:        {total:,}")
    print(f"With entities:          {with_entities:,} ({pct:.1f}%)")
    print(f"Missing entities:       {total - with_entities:,} ({100-pct:.1f}%)")
    print()

    # Stats by ID range
    cur.execute("""
        SELECT
            CASE
                WHEN id > 30000000 THEN '30M+ (newest)'
                WHEN id > 25000000 THEN '25M-30M'
                WHEN id > 20000000 THEN '20M-25M'
                WHEN id > 15000000 THEN '15M-20M'
                WHEN id > 10000000 THEN '10M-15M'
                WHEN id > 5000000 THEN '5M-10M'
                ELSE '<5M (oldest)'
            END as id_range,
            COUNT(*) as total,
            SUM(CASE WHEN array_length(entities, 1) > 0 THEN 1 ELSE 0 END) as with_entities
        FROM news_articles
        WHERE status = 'extracted'
        GROUP BY id_range
        ORDER BY id_range DESC
    """)
    print(f"{'ID Range':<20} {'Total':>10} {'With Entities':>15} {'%':>6}")
    print(f"{'-'*50}")
    for row in cur.fetchall():
        pct = row['with_entities'] / row['total'] * 100 if row['total'] > 0 else 0
        print(f"{row['id_range']:<20} {row['total']:>10,} {row['with_entities']:>15,} {pct:>5.1f}%")

    # news_entities table
    cur.execute("SELECT COUNT(*) as cnt FROM news_entities")
    print()
    print(f"news_entities table: {cur.fetchone()['cnt']:,} rows")

    # Recent articles
    cur.execute("""
        SELECT COUNT(*) as cnt
        FROM news_articles
        WHERE status = 'extracted'
          AND published_at > NOW() - INTERVAL '7 days'
    """)
    recent = cur.fetchone()['cnt']
    print(f"Articles in last 7 days: {recent:,}")

    conn.close()

    print()
    print("💡 To run NER backfill:")
    print("   python3 -m worker.ner_extract --method spacy --batch-size 100 --max-articles 100000")
    print()
    print("💡 To run AI entity extraction (slower but better):")
    print("   python3 -m worker.entity_extract --gpu-budget 0.3 --max-articles 10000 --backfill")

if __name__ == "__main__":
    main()
