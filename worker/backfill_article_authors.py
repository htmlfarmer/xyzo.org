"""backfill_article_authors — populate news_article_authors from existing articles.

Run after journalist_resolver has processed all reachable articles.
This extracts author metadata from article bodies and stores it in
news_article_authors so the journalist resolver can use it as a
primary signal instead of falling back to body parsing.

Usage:
    python3 -m worker.backfill_article_authors --dry-run
    python3 -m worker.backfill_article_authors --limit 50000
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys

from .db import connect
from .journalist_resolver import _extract_byline, _clean_author_name

log = logging.getLogger("xyzo.backfill_article_authors")

_RE_BIO_PARAGRAPH = re.compile(
    r"(?:&lt;p&gt;|<p>)[^<]*"
    r"([A-Z][a-zA-Z''-]{2,20})\s+(?:has|is a|is an|is the)\s+(?:\w+\s+){0,15}"
    r"(?:writing|reporting|covering|working|freelance|journalist|reporter"
    r"|editor|technology|science|staff)[^<]{0,300}(?:&lt;/p&gt;|</p>)?",
    re.DOTALL | re.IGNORECASE,
)


def extract_from_body(body: str) -> tuple[str | None, str | None, str | None]:
    """Extract (author_name, author_url, bio_paragraph) from article body."""
    if not body or len(body) < 50:
        return None, None, None

    name, author_url, evidence = _extract_byline(body, "")

    bio = None
    if name:
        name = _clean_author_name(name)
        if name:
            bio_m = _RE_BIO_PARAGRAPH.search(body[:5000])
            if bio_m:
                raw = bio_m.group()
                bio = re.sub(r"<[^>]+>", "", raw).strip()[:500]

    return name, author_url, bio


def run(limit: int = 50000, dry_run: bool = False) -> dict:
    """Backfill news_article_authors for existing articles."""
    stats = {"checked": 0, "authors_found": 0, "inserted": 0, "skipped": 0, "errors": 0}

    with connect() as conn:
        articles = list(conn.execute(
            """
            SELECT a.id, a.body, a.url
            FROM news_articles a
            LEFT JOIN news_article_authors aa ON aa.article_id = a.id
            WHERE aa.id IS NULL
              AND a.body IS NOT NULL
              AND LENGTH(a.body) > 100
            ORDER BY a.published_at DESC NULLS LAST
            LIMIT %s
            """,
            (limit,),
        ).fetchall())

    log.info("backfill_article_authors: %s articles to check", len(articles))

    if not articles:
        return stats

    article_ids = [row["id"] for row in articles]
    bodies = {row["id"]: row["body"] for row in articles}

    # Process outside the connection context to avoid long-held locks
    results = []
    for article_id in article_ids:
        body = bodies.get(article_id, "")
        try:
            name, author_url, bio = extract_from_body(body)
            if name:
                name = _clean_author_name(name)
            results.append((article_id, name, author_url, bio))
        except Exception as e:
            results.append((article_id, None, None, None))

    if dry_run:
        for article_id, name, author_url, bio in results:
            if name:
                log.info("  [dry] article %s → %s", article_id, name)
        stats["checked"] = len(articles)
        stats["authors_found"] = sum(1 for r in results if r[1])
        return stats

    # Batch insert
    rows_to_insert = [
        (aid, name, author_url, 0.4, "body_backfill", "{}", bio)
        for aid, name, author_url, bio in results
        if name
    ]

    if rows_to_insert:
        with connect() as conn2:
            with conn2.cursor() as cur:
                cur.executemany(
                    """
                    INSERT INTO news_article_authors (
                        article_id, author_name, author_url,
                        confidence, evidence_type, raw_evidence, bio_paragraph
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (article_id) DO NOTHING
                    """,
                    rows_to_insert,
                )
            conn2.commit()

    stats["checked"] = len(articles)
    stats["authors_found"] = sum(1 for r in results if r[1])
    stats["inserted"] = len(rows_to_insert)
    stats["skipped"] = stats["checked"] - stats["authors_found"]

    log.info("backfill_article_authors: %s", json.dumps(stats))
    return stats


if __name__ == "__main__":
    import argparse
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    parser = argparse.ArgumentParser(description="Backfill article author metadata")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=50000)
    args = parser.parse_args()

    os.environ.setdefault(
        "XYZO_DB_DSN",
        os.environ.get("XYZO_DB_URL", "postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"),
    )

    run(limit=args.limit, dry_run=args.dry_run)
