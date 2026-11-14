#!/usr/bin/env python3
"""Compute TF-IDF and entropy metrics for location-term pairs.

This builds the foundation for understanding what topics are distinctive
per location - e.g., "oil" is distinctive for Middle East,
"tech" for San Francisco, "flood" for Southeast Asia.

Performance (rewritten 2026-09-26, FIX_NOTES 1.10): document frequency
used to be computed with one full scan of news_articles PER TERM —
thousands of 7 GB scans per run, which saturated Postgres for hours and
starved the API. Now: one aggregate pass refreshes a `news_term_df`
cache table, per-location terms come from the (indexed) per-location
scan, and locations are processed oldest-data-first so a capped run
still covers the whole fleet over time.

Usage:
    python -m worker.compute_tfidf                    # capped incremental pass
    python -m worker.compute_tfidf --location-id 123  # single location
    python -m worker.compute_tfidf --limit 100        # batch limit
    python -m worker.compute_tfidf --refresh-df-only  # rebuild DF cache only
"""

import argparse
import math
import time
from datetime import datetime, timezone

from .db import connect

import logging

log = logging.getLogger("xyzo.compute_tfidf")

BATCH_SIZE = 500
MIN_TERM_COUNT = 3
MAX_TERMS_PER_LOCATION = 1000
DEFAULT_LOCATION_LIMIT = 2000          # locations per scheduled pass
DF_WINDOW_DAYS = 90                    # recency window for the DF aggregate


def compute_entropy(counts: dict[str, int]) -> float:
    """Shannon entropy of a term distribution."""
    if not counts:
        return 0.0
    total = sum(counts.values())
    if total == 0:
        return 0.0
    entropy = 0.0
    for count in counts.values():
        if count > 0:
            p = count / total
            entropy -= p * math.log2(p)
    return entropy


def term_df_is_fresh(conn, max_age_hours: float = 6.0) -> bool:
    """True if the news_term_df cache was refreshed within max_age_hours.

    FIX 2026-11-14: this cache was rebuilt UNCONDITIONALLY on every
    compute_tfidf run, and compute_tfidf runs inside xyzo-trending on a
    60-minute timer. Each rebuild executes

        SELECT wf.key, a.location_id
        FROM news_articles a
        JOIN LATERAL jsonb_each_text(a.word_freq) wf ON TRUE
        WHERE ... AND a.fetched_at > now() - interval '90 days'

    which reads the word_freq JSONB (TOAST, ~13 GB) for every article in
    the window. Measured cost: 405 s of wall clock and 518 s of
    cumulative read time, holding the connection for 6m45s once an hour,
    for a document-frequency count that barely changes between runs.

    A 6-hour staleness guard cuts that cost by ~6x with no measurable
    quality loss: the DF cache only tracks how many locations mention a
    term, which moves slowly relative to the article feed.
    """
    cur = conn.execute(
        "SELECT COALESCE(MAX(updated_at), 'epoch'::timestamptz) AS m "
        "FROM news_term_df"
    )
    row = cur.fetchone()
    if not row or not row["m"]:
        return False
    return (datetime.now(timezone.utc) - row["m"]).total_seconds() < max_age_hours * 3600


def refresh_term_df(window_days: int = DF_WINDOW_DAYS, max_age_hours: float = 6.0) -> int:
    """One aggregate pass: term -> how many locations mention it (recent)."""
    with connect() as conn:
        if max_age_hours > 0 and term_df_is_fresh(conn, max_age_hours):
            cur = conn.execute("SELECT COUNT(*) AS n FROM news_term_df")
            n = cur.fetchone()["n"]
            log.info(
                "compute_tfidf: DF cache is fresh (<%gh old), skipping the "
                "%d-day full scan (%d terms)",
                max_age_hours, window_days, n,
            )
            return n
        # The whole-pool default statement_timeout (60 s) is too tight for
        # the jsonb aggregation across 90 days; raise it for this session
        # and reset before the (pooled) connection goes back.
        #
        # FIX 2026-11-14 — measured, not guessed:
        #   * the JSONB explode + aggregate over the 90-day window is ~180 s
        #     (4,145,406 terms, 426,153,033 total frequency)
        #   * the INSERT ... ON CONFLICT rewrite of all 4,145,406 rows is
        #     the dominant cost: 1,120 s (18m40s) on its own, because every
        #     row update had to maintain FOUR indexes. The unused 1 GB
        #     news_term_df_locations_idx (410 scans in its lifetime) has
        #     since been dropped, which removes one of them.
        # So a full pass needs on the order of 1200-1500 s under load.
        # 1800 s (the value this originally had) bounds the worst case
        # while the 6-hour staleness guard keeps it off the hourly path.
        conn.execute("SET statement_timeout = '1800s'")
        try:
            conn.execute(
            f"""
            WITH t AS (
                SELECT wf.key AS term, a.location_id,
                       -- FIX 2026-11-14: carry the term frequency through
                       -- as well as the location. compute_pmi.get_top_terms
                       -- used to re-derive the global frequency with its OWN
                       -- full scan of news_articles + jsonb_each_text(word_freq)
                       -- — a second 13 GB JSONB explode over the same rows,
                       -- which blew the pool's 60 s statement_timeout and
                       -- made worker.compute_pmi (and therefore the whole
                       -- xyzo-trending service) fail every cycle.
                       -- Verified all values are numeric before casting.
                       (wf.value)::bigint AS freq
                FROM news_articles a
                JOIN LATERAL jsonb_each_text(a.word_freq) wf ON TRUE
                WHERE a.status = 'extracted'
                  AND a.location_id IS NOT NULL
                  AND a.word_freq IS NOT NULL
                  AND a.word_freq <> '{{}}'::jsonb
                  AND a.fetched_at > now() - interval '{int(window_days)} days'
            )
            INSERT INTO news_term_df (term, locations, frequency, updated_at)
            SELECT term, COUNT(DISTINCT location_id), COALESCE(SUM(freq), 0), now()
            FROM t
            GROUP BY term
            ON CONFLICT (term) DO UPDATE
            SET locations = EXCLUDED.locations,
                frequency = EXCLUDED.frequency,
                updated_at = now()
            """
            )
            # prune terms that have not refreshed in 30 days (vocabulary drift)
            conn.execute(
                "DELETE FROM news_term_df WHERE updated_at < now() - interval '30 days'"
            )
            conn.commit()
        except Exception:
            # FIX 2026-11-14: roll back BEFORE re-raising. Otherwise the
            # RESET in `finally` is rejected with
            #     InFailedSqlTransaction: current transaction is aborted
            # which REPLACED the real error in the log — the actual
            # failure never reached the journal, so the service just
            # showed "exit-code" with no cause and the DF cache stayed
            # un-refreshed (frequency stayed 0 for every term).
            conn.rollback()
            raise
        finally:
            try:
                conn.execute("RESET statement_timeout")
            except Exception:
                # Connection may be dead; never mask the original error.
                pass
        cur = conn.execute("SELECT COUNT(*) AS n FROM news_term_df")
        return cur.fetchone()["n"]


def get_document_frequencies(conn, terms: list[str]) -> dict[str, int]:
    """Batched DF lookup from the cache table (replaces per-term full scans)."""
    if not terms:
        return {}
    out: dict[str, int] = {}
    for i in range(0, len(terms), 1000):
        chunk = terms[i:i + 1000]
        cur = conn.execute(
            "SELECT term, locations FROM news_term_df WHERE term = ANY(%s)",
            (chunk,),
        )
        for row in cur.fetchall():
            out[row["term"]] = row["locations"]
    return out


def get_terms_for_location(conn, location_id: int) -> dict[str, int]:
    """Aggregated word frequencies for one location (indexed by location_id)."""
    cur = conn.execute(
        """
        SELECT wf.key AS term, SUM((wf.value)::int) AS count
        FROM news_articles a,
             jsonb_each_text(a.word_freq) wf
        WHERE a.location_id = %s
          AND a.status = 'extracted'
          AND a.word_freq IS NOT NULL
        GROUP BY wf.key
        HAVING SUM((wf.value)::int) >= %s
        ORDER BY count DESC
        LIMIT %s
        """,
        (location_id, MIN_TERM_COUNT, MAX_TERMS_PER_LOCATION),
    )
    return {row["term"]: int(row["count"]) for row in cur.fetchall()}


def compute_tfidf_for_location(
    location_id: int,
    terms: dict[str, int],
    total_articles: int,
    total_locations: int,
    dfmap: dict[str, int],
) -> list[dict]:
    results = []
    sum_terms = max(1, sum(terms.values()))
    entropy = compute_entropy(terms)
    for term, term_count in terms.items():
        tf = term_count / sum_terms
        df = dfmap.get(term, 0)
        idf = math.log(total_locations / max(1, df)) if df > 0 else 0.0
        results.append({
            "location_id": location_id,
            "term": term.lower(),
            "term_count": term_count,
            "article_count": min(term_count, total_articles),
            "tf": tf,
            "idf": idf,
            "tfidf": tf * idf,
            "entropy": entropy,
        })
    return results


def compute_location_tfidf(location_id: int, conn, total_locations: int,
                           dry_run: bool = False) -> int:
    """Compute TF-IDF for a single location using an open connection."""
    terms = get_terms_for_location(conn, location_id)
    if not terms:
        return 0
    cur = conn.execute(
        "SELECT COUNT(*) AS total FROM news_articles "
        "WHERE location_id = %s AND status = 'extracted'",
        (location_id,),
    )
    total_articles = cur.fetchone()["total"]
    dfmap = get_document_frequencies(conn, list(terms.keys()))
    results = compute_tfidf_for_location(
        location_id, terms, total_articles, total_locations, dfmap
    )
    if dry_run or not results:
        return len(results)
    # psycopg3: executemany lives on the cursor, not the connection
    with conn.cursor() as cur_up:
        cur_up.executemany(
        """
        INSERT INTO news_location_terms
            (location_id, term, term_count, article_count, tf, idf, tfidf, entropy, updated_at)
        VALUES
            (%(location_id)s, %(term)s, %(term_count)s, %(article_count)s,
             %(tf)s, %(idf)s, %(tfidf)s, %(entropy)s, NOW())
        ON CONFLICT (location_id, term) DO UPDATE SET
            term_count = EXCLUDED.term_count,
            article_count = EXCLUDED.article_count,
            tf = EXCLUDED.tf,
            idf = EXCLUDED.idf,
            tfidf = EXCLUDED.tfidf,
            entropy = EXCLUDED.entropy,
            updated_at = NOW()
        """,
            results,
        )
    return len(results)


def _eligible_locations(conn, limit: int) -> list[int]:
    """Locations with article data, oldest-computed first (incremental sweep)."""
    cur = conn.execute(
        """
        SELECT l.id
        FROM news_locations l
        LEFT JOIN (
            SELECT location_id, MAX(updated_at) AS mu
            FROM news_location_terms
            GROUP BY location_id
        ) t ON t.location_id = l.id
        WHERE l.lat IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM news_articles a
              WHERE a.location_id = l.id
                AND a.status = 'extracted'
                AND a.word_freq IS NOT NULL
                AND a.word_freq <> '{}'::jsonb
          )
        ORDER BY t.mu NULLS FIRST, l.id
        LIMIT %s
        """,
        (limit,),
    )
    return [row["id"] for row in cur.fetchall()]


def compute_all_tfidf(limit: int | None = None, dry_run: bool = False) -> dict:
    start = time.time()
    vocab = 0
    try:
        vocab = refresh_term_df()
        log.info("compute_tfidf: DF cache refreshed (%d terms)", vocab)
    except Exception as exc:  # noqa: BLE001
        log.warning("compute_tfidf: DF refresh failed, using stale cache: %s", exc)

    with connect() as conn:
        cur = conn.execute("SELECT COUNT(*) AS n FROM news_locations WHERE lat IS NOT NULL")
        total_locations = cur.fetchone()["n"]
        locations = _eligible_locations(conn, limit or DEFAULT_LOCATION_LIMIT)

        processed = 0
        total_terms = 0
        for loc_id in locations:
            try:
                n = compute_location_tfidf(loc_id, conn, total_locations, dry_run=dry_run)
                total_terms += n
                processed += 1
                if processed % 50 == 0:
                    conn.commit()
                    log.info("compute_tfidf: %d/%d locations", processed, len(locations))
            except Exception as exc:  # noqa: BLE001
                log.warning("compute_tfidf: location %d failed: %s", loc_id, exc)
        conn.commit()

    elapsed = time.time() - start
    return {
        "locations_processed": processed,
        "total_terms": total_terms,
        "df_vocab": vocab,
        "elapsed_seconds": elapsed,
        "terms_per_second": total_terms / elapsed if elapsed else 0.0,
    }


def main():
    parser = argparse.ArgumentParser(description="Compute TF-IDF metrics for locations")
    parser.add_argument("--location-id", type=int, help="Compute for single location")
    parser.add_argument("--limit", type=int, help="Max locations per run")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--refresh-df-only", action="store_true",
                        help="Only rebuild the news_term_df cache")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    if args.refresh_df_only:
        print(f"DF cache: {refresh_term_df()} terms")
        return
    if args.location_id:
        with connect() as conn:
            cur = conn.execute("SELECT COUNT(*) AS n FROM news_locations WHERE lat IS NOT NULL")
            total_locations = cur.fetchone()["n"]
            count = compute_location_tfidf(args.location_id, conn, total_locations,
                                           dry_run=args.dry_run)
            conn.commit()
        print(f"Computed {count} terms for location {args.location_id}")
        return

    result = compute_all_tfidf(limit=args.limit, dry_run=args.dry_run)
    print("TF-IDF computation complete:")
    print(f"  Locations processed: {result['locations_processed']}")
    print(f"  Total terms: {result['total_terms']}")
    print(f"  DF vocab: {result['df_vocab']}")
    print(f"  Elapsed: {result['elapsed_seconds']:.1f}s")


if __name__ == "__main__":
    main()
