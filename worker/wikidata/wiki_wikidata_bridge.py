#!/usr/bin/env python3
"""
Wiki-Wikidata Bridge
====================
Populates wikidata_qid in wiki_articles by joining on enwiki_title from wd_entities.

The Wikipedia database (wiki_articles) has NO wikidata_qid column.
The Wikidata database (wd_entities) has enwiki_title which maps to Wikipedia titles.

This script bridges them so XYZO can go:
    Wikipedia article → QID → Wikidata entity → all relationships

Usage:
    python3 -m worker.wikidata.wiki_wikidata_bridge --dry-run
    python3 -m worker.wikidata.wiki_wikidata_bridge --batch 10000
    python3 -m worker.wikidata.wiki_wikidata_bridge --status
"""

import argparse
import logging
import os
import sys
import time
from dataclasses import dataclass

import psycopg
from psycopg.rows import dict_row

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("xyzo.wiki_wikidata_bridge")


WIKIDATA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikidata"
)

WIKIPEDIA_DSN = os.environ.get(
    "XYZO_WIKI_DB_URL",
    "postgresql://xyzo_app:CHANGE_ME@localhost:5432/wikipedia"
).replace("/wikidata", "/wikipedia")


@dataclass
class Stats:
    total_articles: int = 0
    matched_exact: int = 0
    matched_case_insensitive: int = 0
    unmatched: int = 0
    already_filled: int = 0
    errors: int = 0


def connect_wikidata() -> psycopg.Connection:
    return psycopg.connect(WIKIDATA_DSN, row_factory=dict_row, autocommit=True)


def connect_wikipedia() -> psycopg.Connection:
    return psycopg.connect(WIKIPEDIA_DSN, row_factory=dict_row, autocommit=True)


def ensure_column_exists(wiki_conn: psycopg.Connection) -> bool:
    """Add wikidata_qid column to wiki_articles if it doesn't exist."""
    with wiki_conn.cursor() as cur:
        cur.execute("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'wiki_articles' AND column_name = 'wikidata_qid'
        """)
        if cur.fetchone():
            log.info("Column wikidata_qid already exists in wiki_articles")
            return True

    log.info("Adding wikidata_qid column to wiki_articles...")
    with wiki_conn.cursor() as cur:
        cur.execute("""
            ALTER TABLE wiki_articles
            ADD COLUMN wikidata_qid TEXT
        """)
    log.info("Column added. Creating index...")
    with wiki_conn.cursor() as cur:
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_wiki_wikidata_qid
            ON wiki_articles(wiki_id) INCLUDE (wikidata_qid)
        """)
    return True


def get_status(wiki_conn: psycopg.Connection) -> dict:
    """Get current bridge status."""
    with wiki_conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) as total FROM wiki_articles")
        total = cur.fetchone()["total"]

        # Check if wikidata_qid column exists
        cur.execute("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'wiki_articles' AND column_name = 'wikidata_qid'
        """)
        col_exists = cur.fetchone() is not None

        if not col_exists:
            return {"total": total, "filled": 0, "rate": 0.0, "col_exists": False}

        cur.execute("""
            SELECT COUNT(*) as filled
            FROM wiki_articles
            WHERE wikidata_qid IS NOT NULL
        """)
        filled = cur.fetchone()["filled"]

        return {"total": total, "filled": filled, "rate": filled / total * 100 if total else 0, "col_exists": True}


def bridge_batch(wiki_conn: psycopg.Connection, wiki_cursor_batch: int = 10000, skip_count: bool = False) -> Stats:
    """Bridge Wikipedia articles to Wikidata QIDs in batches."""
    stats = Stats()

    log.info(f"Starting batch bridge (batch_size={wiki_cursor_batch})...")

    if not skip_count:
        with wiki_conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) as total FROM wiki_articles WHERE wikidata_qid IS NULL")
            remaining = cur.fetchone()["total"]
            log.info(f"Articles needing QID: {remaining:,}")

    offset = 0
    while True:
        with wiki_conn.cursor() as cur:
            cur.execute("""
                SELECT wiki_id, title
                FROM wiki_articles
                WHERE wikidata_qid IS NULL
                ORDER BY wiki_id
                LIMIT %s
            """, (wiki_cursor_batch,))
            articles = list(cur.fetchall())

        if not articles:
            break

        # Build lookup from Wikidata
        titles = [a["title"] for a in articles if a["title"]]
        if not titles:
            offset += len(articles)
            continue

        qid_map = {}
        case_insensitive_map = {}

        wikidata_conn = connect_wikidata()
        try:
            with wikidata_conn.cursor() as wcur:
                placeholders = ",".join(["%s"] * len(titles))
                wcur.execute(f"""
                    SELECT id, enwiki_title, label_en
                    FROM wd_entities
                    WHERE enwiki_title IN ({placeholders})
                """, titles)
                for row in wcur.fetchall():
                    qid_map[row["enwiki_title"]] = row["id"]

                # Case-insensitive lookup for unmatched
                wcur.execute(f"""
                    SELECT id, enwiki_title
                    FROM wd_entities
                    WHERE lower(enwiki_title) IN ({",".join(["lower(%s)"] * len(titles))})
                """, titles)
                for row in wcur.fetchall():
                    case_insensitive_map[row["enwiki_title"].lower()] = row["id"]
        finally:
            wikidata_conn.close()

        # Update matches
        for article in articles:
            title = article["title"]
            wiki_id = article["wiki_id"]

            if not title:
                stats.unmatched += 1
                continue

            qid = qid_map.get(title)
            if qid:
                with wiki_conn.cursor() as cur:
                    cur.execute("""
                        UPDATE wiki_articles
                        SET wikidata_qid = %s
                        WHERE wiki_id = %s
                    """, (qid, wiki_id))
                stats.matched_exact += 1
            else:
                # Try case-insensitive
                qid_ci = case_insensitive_map.get(title.lower())
                if qid_ci:
                    with wiki_conn.cursor() as cur:
                        cur.execute("""
                            UPDATE wiki_articles
                            SET wikidata_qid = %s
                            WHERE wiki_id = %s
                        """, (qid_ci, wiki_id))
                    stats.matched_case_insensitive += 1
                else:
                    stats.unmatched += 1

        offset += len(articles)

        total_processed = stats.matched_exact + stats.matched_case_insensitive + stats.unmatched
        log.info(f"  Processed {total_processed:,}/{remaining + total_processed:,} | "
                 f"exact={stats.matched_exact:,} ci={stats.matched_case_insensitive:,} "
                 f"unmatched={stats.unmatched:,}")

        if len(articles) < wiki_cursor_batch:
            break

    return stats


def run_full_bridge(wiki_conn: psycopg.Connection, batch_size: int = 10000, skip_count: bool = False) -> Stats:
    """Run the full bridging process."""
    ensure_column_exists(wiki_conn)
    return bridge_batch(wiki_conn, batch_size, skip_count=skip_count)


def main():
    parser = argparse.ArgumentParser(description="Bridge Wikipedia articles to Wikidata QIDs")
    parser.add_argument("--dry-run", action="store_true", help="Show status without making changes")
    parser.add_argument("--status", action="store_true", help="Show current bridge status")
    parser.add_argument("--batch", type=int, default=10000, help="Batch size for processing")
    parser.add_argument("--fast", action="store_true", help="Skip initial COUNT (faster startup)")
    args = parser.parse_args()

    wiki_conn = connect_wikipedia()

    try:
        if args.status or args.dry_run:
            status = get_status(wiki_conn)
            print(f"\n=== Wiki-Wikidata Bridge Status ===")
            print(f"Total Wikipedia articles: {status['total']:,}")
            if status.get("col_exists", False):
                print(f"Articles with QID:       {status['filled']:,}")
                print(f"Bridge rate:            {status['rate']:.1f}%")
                print(f"Unbridged:              {status['total'] - status['filled']:,}")
            else:
                print(f"wikidata_qid column:    NOT YET CREATED")
                print(f"Run without --status to create column and populate")
            if args.dry_run:
                return 0

        stats = run_full_bridge(wiki_conn, args.batch, skip_count=args.fast)

        print(f"\n=== Bridge Complete ===")
        print(f"Matched (exact):           {stats.matched_exact:,}")
        print(f"Matched (case-insensitive): {stats.matched_case_insensitive:,}")
        print(f"Unmatched:                 {stats.unmatched:,}")

        if not args.fast:
            final_status = get_status(wiki_conn)
            print(f"\nFinal bridge rate: {final_status['rate']:.1f}%")
        else:
            print(f"\n(Final status skipped -- use --status to check later)")

    finally:
        wiki_conn.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
