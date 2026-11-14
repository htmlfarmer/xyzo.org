#!/usr/bin/env python3
"""
Named Entity Linking (NEL) Pipeline

Links extracted news entities to Wikipedia articles using the Wikipedia Search API.
This fills in the wikidata_id field in news_entities.

Usage:
    python3 -m worker.nel_linker                    # Run with defaults
    python3 -m worker.nel_linker --batch 100       # Custom batch size
    python3 -m worker.nel_linker --dry-run         # Preview without changes
    python3 -m worker.nel_linker --stats           # Show current status
"""

import os
import sys
import time
import argparse
import logging
from typing import Optional
from dataclasses import dataclass
from urllib.parse import quote

import psycopg
import requests

sys.path.insert(0, '/var/www/vhosts/xyzo.org')

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
log = logging.getLogger("xyzo.nel_linker")

DSN = os.environ.get("XYZO_DB_DSN", "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo")
WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"

HEADERS = {
    "User-Agent": "XYZO-News-Aggregator/1.0 (https://xyzo.org; contact@xyzo.org) Python/3.11"
}

BATCH_SIZE = 100
REQUEST_DELAY = 0.1  # 100ms between requests to be respectful


@dataclass
class LinkResult:
    entity_id: int
    name: str
    entity_type: str
    wikidata_id: Optional[str]
    wikipedia_title: Optional[str]
    confidence: float


def get_wikipedia_qid(title: str, entity_type: str) -> tuple[Optional[str], Optional[str], float]:
    """
    Look up Wikipedia article by title and get its Wikidata QID.

    Returns: (wikidata_qid, wikipedia_title, confidence)
    """
    if not title:
        return None, None, 0.0

    params = {
        "action": "query",
        "titles": title,
        "prop": "pageprops",
        "format": "json",
        "redirects": "1",
    }

    try:
        resp = requests.get(WIKIPEDIA_API, params=params, headers=HEADERS, timeout=10)
        resp.raise_for_status()
        data = resp.json()

        pages = data.get("query", {}).get("pages", {})
        for page_id, page in pages.items():
            if page_id == "-1":  # Page not found
                return None, None, 0.0

            pageprops = page.get("pageprops", {})
            wikibase_item = pageprops.get("wikibase_item")

            if wikibase_item:
                return wikibase_item, page.get("title"), 0.9

            return None, page.get("title"), 0.1

    except Exception as e:
        log.debug(f"Lookup failed for {title}: {e}")

    return None, None, 0.0


def search_wikipedia(query: str, entity_type: str) -> tuple[Optional[str], Optional[str], float]:
    """
    Search Wikipedia for an entity and return best match with QID.

    Returns: (wikidata_qid, wikipedia_title, confidence)
    """
    search_params = {
        "action": "query",
        "list": "search",
        "srsearch": query,
        "srlimit": 1,
        "format": "json",
    }

    try:
        resp = requests.get(WIKIPEDIA_API, params=search_params, headers=HEADERS, timeout=10)
        resp.raise_for_status()
        data = resp.json()

        results = data.get("query", {}).get("search", [])
        if not results:
            return None, None, 0.0

        best = results[0]
        title = best["title"]

        return get_wikipedia_qid(title, entity_type)

    except Exception as e:
        log.debug(f"Search failed for {query}: {e}")

    return None, None, 0.0


def link_entity(name: str, entity_type: str, min_confidence: float = 0.3) -> tuple[Optional[str], Optional[str], float]:
    """
    Link an entity name to Wikipedia.

    Strategy:
    1. Direct lookup with exact name
    2. If not found, search with type hint
    3. Return best match above confidence threshold
    """
    if not name or len(name) < 2:
        return None, None, 0.0

    name_clean = name.strip()

    wikidata_qid, wiki_title, conf = get_wikipedia_qid(name_clean, entity_type)
    if wikidata_qid and conf >= min_confidence:
        return wikidata_qid, wiki_title, conf

    type_hint = ""
    if entity_type == "person":
        type_hint = ""
    elif entity_type == "organization":
        type_hint = "company"

    query = f"{name_clean} {type_hint}".strip()
    wikidata_qid, wiki_title, conf = search_wikipedia(query, entity_type)
    if wikidata_qid and conf >= min_confidence:
        return wikidata_qid, wiki_title, conf

    return None, None, 0.0


def get_unlinked_entities(conn: psycopg.Connection, batch_size: int = 100) -> list:
    """Fetch entities that need linking - prioritize English names."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, type
            FROM news_entities
            WHERE wikidata_id IS NULL
              AND type IN ('person', 'organization')
              AND LENGTH(name) BETWEEN 3 AND 40
              AND name ~ '^[A-Za-z ''.-]+$'
            ORDER BY
                CASE type
                    WHEN 'person' THEN 1
                    WHEN 'organization' THEN 2
                    ELSE 3
                END,
                LENGTH(name) DESC
            LIMIT %s
        """, (batch_size,))
        return list(cur.fetchall())


def get_stats(conn: psycopg.Connection) -> dict:
    """Get current linking statistics."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN wikidata_id IS NOT NULL THEN 1 ELSE 0 END) as linked
            FROM news_entities
        """)
        row = cur.fetchone()
        return {"total": row[0], "linked": row[1], "rate": row[1] / row[0] * 100 if row[0] else 0}


def link_batch(conn: psycopg.Connection, dry_run: bool = False) -> dict:
    """Process a batch of entities."""
    stats = {"processed": 0, "linked": 0, "failed": 0}

    entities = get_unlinked_entities(conn, BATCH_SIZE)
    if not entities:
        return stats

    stats["processed"] = len(entities)

    for entity in entities:
        entity_id, name, entity_type = entity

        time.sleep(REQUEST_DELAY)

        wikidata_qid, wiki_title, confidence = link_entity(name, entity_type)

        if wikidata_qid:
            stats["linked"] += 1
            if not dry_run:
                with conn.cursor() as cur:
                    cur.execute("""
                        UPDATE news_entities
                        SET wikidata_id = %s
                        WHERE id = %s
                    """, (wikidata_qid, entity_id))
                conn.commit()
            log.debug(f"Linked: {name} -> {wikidata_qid} ({confidence:.2f})")
        else:
            stats["failed"] += 1
            log.debug(f"No match: {name} ({entity_type})")

    return stats


def run_linker(batch_size: int = 100, dry_run: bool = False, max_entities: int = 0):
    """Run the NEL linker."""
    log.info(f"Starting NEL linker (batch_size={batch_size}, dry_run={dry_run})")

    conn = psycopg.connect(DSN)

    try:
        stats = get_stats(conn)
        log.info(f"Current: {stats['linked']:,} / {stats['total']:,} linked ({stats['rate']:.1f}%)")

        total_linked = 0
        total_processed = 0

        while True:
            batch_stats = link_batch(conn, dry_run=dry_run)

            if batch_stats["processed"] == 0:
                break

            total_processed += batch_stats["processed"]
            total_linked += batch_stats["linked"]

            log.info(f"Batch: +{batch_stats['linked']} linked, {batch_stats['failed']} no match")

            if max_entities > 0 and total_processed >= max_entities:
                log.info(f"Reached max_entities limit ({max_entities})")
                break

        log.info(f"Totals: processed={total_processed}, linked={total_linked}")

        if not dry_run:
            final_stats = get_stats(conn)
            log.info(f"Final: {final_stats['linked']:,} / {final_stats['total']:,} ({final_stats['rate']:.1f}%)")

    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description="Named Entity Linking pipeline")
    parser.add_argument("--batch", type=int, default=BATCH_SIZE, help=f"Batch size (default: {BATCH_SIZE})")
    parser.add_argument("--dry-run", action="store_true", help="Preview without making changes")
    parser.add_argument("--stats", action="store_true", help="Show current stats and exit")
    parser.add_argument("--max", type=int, default=0, help="Max entities to process (0=unlimited)")
    args = parser.parse_args()

    if args.stats:
        conn = psycopg.connect(DSN)
        try:
            s = get_stats(conn)
            print(f"\n=== NEL Linker Status ===")
            print(f"Total entities:    {s['total']:,}")
            print(f"Linked to Wiki:    {s['linked']:,}")
            print(f"Unlinked:          {s['total'] - s['linked']:,}")
            print(f"Link rate:         {s['rate']:.1f}%")
        finally:
            conn.close()
        return 0

    run_linker(batch_size=args.batch, dry_run=args.dry_run, max_entities=args.max)
    return 0


if __name__ == "__main__":
    sys.exit(main())
