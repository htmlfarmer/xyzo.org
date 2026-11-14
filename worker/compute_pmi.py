#!/usr/bin/env python3
"""Compute PMI (Pointwise Mutual Information) for term pairs.

PMI measures how often two terms appear together versus what we'd expect
by chance. High PMI indicates strong association: "earthquake" + "tsunami",
"tech" + "startup", "flood" + "evacuation".

Usage:
    python -m worker.compute_pmi                    # full computation
    python -m worker.compute_pmi --limit 100        # batch limit
"""

import argparse
import logging
import math
import time
from collections import defaultdict
from itertools import combinations

from .db import connect

log = logging.getLogger("xyzo.compute_pmi")

BATCH_SIZE = 1000
MIN_CO_COUNT = 5
MIN_TERM_COUNT = 10
MAX_PAIRS_PER_TERM = 50
TOP_N_PAIRS = 100000


def get_top_terms(limit: int = 5000) -> list[tuple[str, int]]:
    """Most frequent terms across all articles, read from the news_term_df cache.

    FIX 2026-11-14: this used to recompute the frequency from scratch with

        SELECT wf.key, SUM((wf.value)::int)
        FROM news_articles a, jsonb_each_text(a.word_freq) wf
        WHERE a.status = 'extracted' AND a.word_freq IS NOT NULL
        GROUP BY wf.key HAVING SUM(...) >= ... ORDER BY count DESC LIMIT ...

    That is a FULL explode of the word_freq JSONB over every extracted
    article — a second 13 GB scan of exactly the rows that
    compute_tfidf.refresh_term_df already walks (and caches) once every
    6 hours. Against the pool's 60 s statement_timeout it timed out on
    every single run, which made worker.compute_pmi exit non-zero and
    therefore failed the whole xyzo-trending.service cycle.

    news_term_df now carries the global `frequency` alongside `locations`,
    so this is a plain indexed read. It also means the corpus is the same
    90-day window the DF cache uses, rather than every article ever
    fetched — consistent with the rest of the TF-IDF/PMI maths.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT term, frequency AS count
            FROM news_term_df
            WHERE frequency >= %s
            ORDER BY frequency DESC
            LIMIT %s
        """, (MIN_TERM_COUNT, limit))
        return [(row["term"], row["count"]) for row in cur.fetchall()]


def get_co_occurrences(terms: list[str]) -> dict[tuple[str, str], int]:
    """Get co-occurrence counts for term pairs within same article."""
    if len(terms) < 2:
        return {}
    
    term_set = set(terms)
    placeholders = ",".join(["%s"] * len(terms))
    
    with connect() as conn, conn.cursor() as cur:
        # FIX 2026-11-14: this statement blew the pool's 60 s
        # statement_timeout on every run, so worker.compute_pmi always
        # exited non-zero and the whole xyzo-trending.service cycle failed
        # with it.
        #
        # Measured on a real 100-term batch: 110.8 s (and the restructured
        # LATERAL/self-join variant measured 110.0 s — the cost is reading
        # the word_freq JSONB across every extracted article, not the join
        # shape, so there is no cheap query rewrite available here).
        #
        # 600 s gives ~5x headroom. xyzo-trending is Type=oneshot with
        # TimeoutStartSec=infinity, so there is no outer limit to fight
        # with, and the batches run sequentially inside one job.
        conn.execute("SET statement_timeout = '600s'")
        try:
            cur.execute(f"""
                SELECT 
                    wf1.key as term1,
                    wf2.key as term2,
                    COUNT(DISTINCT a.id) as co_count
                FROM news_articles a, 
                     jsonb_each_text(a.word_freq) wf1,
                     jsonb_each_text(a.word_freq) wf2
                WHERE a.status = 'extracted'
                AND a.word_freq IS NOT NULL
                AND wf1.key IN ({placeholders})
                AND wf2.key IN ({placeholders})
                AND wf1.key < wf2.key
                GROUP BY wf1.key, wf2.key
                HAVING COUNT(DISTINCT a.id) >= %s
            """, terms + terms + [MIN_CO_COUNT])
        except Exception:
            # Roll back before re-raising so the RESET below is not
            # rejected with InFailedSqlTransaction, which is what used to
            # mask the real error in the journal.
            conn.rollback()
            raise
        finally:
            try:
                conn.execute("RESET statement_timeout")
            except Exception:
                pass

        co_counts = {}
        for row in cur.fetchall():
            pair = (row["term1"].lower(), row["term2"].lower())
            co_counts[pair] = row["co_count"]
        return co_counts


def compute_pmi(term: str, term_count: int, co_term: str, co_count: int, 
                total_articles: int) -> dict:
    """Compute PMI for a term pair."""
    # PMI = log(P(A,B) / (P(A) * P(B)))
    # P(A) = term_count / total
    # P(B) = co_term_count / total
    # P(A,B) = co_count / total
    
    p_a = term_count / total_articles
    p_b = co_count / total_articles  # using same count for simplicity
    p_ab = co_count / total_articles
    
    if p_a <= 0 or p_b <= 0 or p_ab <= 0:
        return None
    
    pmi = math.log2(p_ab / (p_a * p_b))
    
    # Normalized PMI: -1 to 1
    # NPMI = PMI / -log(P(A,B))
    npmi = pmi / (-math.log2(p_ab)) if p_ab > 0 else 0
    npmi = max(-1, min(1, npmi))  # clamp to [-1, 1]
    
    return {
        "pmi": pmi,
        "npmi": npmi,
    }


def compute_all_pmi(limit: int | None = None) -> dict:
    """Compute PMI for term pairs."""
    start_time = time.time()
    
    # Get top terms
    terms = get_top_terms(limit=5000)
    if not terms:
        return {"error": "No terms found"}
    
    term_counts = {t: c for t, c in terms}
    total_articles = term_counts.get("_total", sum(term_counts.values()))
    
    # Get total articles for probability calculation
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) as total FROM news_articles WHERE status = 'extracted'")
        total_articles = cur.fetchone()["total"]
    
    log.info("Computing PMI for %d terms across %d articles", len(terms), total_articles)
    
    # Process in batches to manage memory
    all_pairs = []
    processed = 0
    
    for i in range(0, len(terms), 100):
        batch = terms[i:i+100]
        term_list = [t for t, _ in batch]
        
        co_counts = get_co_occurrences(term_list)
        
        for (term1, term2), co_count in co_counts.items():
            if term1 not in term_counts or term2 not in term_counts:
                continue
            
            pmi_data = compute_pmi(
                term1, term_counts[term1],
                term2, term_counts[term2],
                total_articles
            )
            
            if pmi_data and pmi_data["pmi"] > 0:  # Only positive associations
                all_pairs.append({
                    "term1": term1,
                    "term2": term2,
                    "co_count": co_count,
                    "term1_count": term_counts[term1],
                    "term2_count": term_counts[term2],
                    "pmi": pmi_data["pmi"],
                    "npmi": pmi_data["npmi"],
                })
        
        processed += len(batch)
        
        if processed % 500 == 0:
            elapsed = time.time() - start_time
            log.info("Processed %d/%d terms, %d pairs found, elapsed: %.1fs",
                    processed, len(terms), len(all_pairs), elapsed)
        
        if limit and len(all_pairs) >= limit:
            break
    
    # Sort by PMI and take top pairs
    all_pairs.sort(key=lambda x: x["pmi"], reverse=True)
    top_pairs = all_pairs[:min(len(all_pairs), TOP_N_PAIRS)]
    
    # Insert into database
    with connect() as conn:
        for i, p in enumerate(top_pairs):
            conn.execute("""
                INSERT INTO news_term_pairs 
                    (term1, term2, co_count, term1_count, term2_count, pmi, npmi, updated_at)
                VALUES 
                    (%(term1)s, %(term2)s, %(co_count)s, %(term1_count)s, %(term2_count)s,
                     %(pmi)s, %(npmi)s, NOW())
                ON CONFLICT (term1, term2) DO UPDATE SET
                    co_count = EXCLUDED.co_count,
                    term1_count = EXCLUDED.term1_count,
                    term2_count = EXCLUDED.term2_count,
                    pmi = EXCLUDED.pmi,
                    npmi = EXCLUDED.npmi,
                    updated_at = NOW()
            """, p)
            
            if (i + 1) % 10000 == 0:
                log.info("Inserted %d/%d pairs", i + 1, len(top_pairs))
    
    elapsed = time.time() - start_time
    return {
        "terms_processed": processed,
        "pairs_found": len(all_pairs),
        "pairs_stored": len(top_pairs),
        "elapsed_seconds": elapsed,
    }


def main():
    parser = argparse.ArgumentParser(description="Compute PMI for term associations")
    parser.add_argument("--limit", type=int, help="Limit number of pairs")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s"
    )
    
    result = compute_all_pmi(limit=args.limit)
    if "error" in result:
        print(f"Error: {result['error']}")
    else:
        print(f"PMI computation complete:")
        print(f"  Terms processed: {result['terms_processed']}")
        print(f"  Pairs found: {result['pairs_found']}")
        print(f"  Pairs stored: {result['pairs_stored']}")
        print(f"  Elapsed: {result['elapsed_seconds']:.1f}s")


if __name__ == "__main__":
    main()
