"""Populate nn_article_sentence_embeddings with384-dim sentence vectors.

Uses sentence-transformers/all-MiniLM-L6-v2 to encode articles for
cross-language semantic linking (Pass 3 of story_linker).

Designed to run incrementally: only encodes articles that don't yet
have an embedding. Safe to run repeatedly.

Usage:
    python -m worker.populate_embeddings           # backfill all
    python -m worker.populate_embeddings --recent 7 # last7 days only
    python -m worker.populate_embeddings --batch 256 # custom batch size
    python -m worker.populate_embeddings --limit 5000 # cap total articles
"""
from __future__ import annotations

import argparse
import hashlib
import logging
import os
import time

from .db import connect

log = logging.getLogger("xyzo.populate_embeddings")

MODEL_NAME = "all-MiniLM-L6-v2"


def _text_for_article(row: dict) -> str:
    """Compose text for embedding from article fields.

    The TITLE is repeated because it is the only discriminative part of an
    article. The previous composition (title | summary[:300] | Location: X |
    Type: Y) put the location and the event type on roughly equal footing
    with the headline, so two unrelated stories from the same city with the
    same type embedded almost identically — measured on the story tree,
    roughly half the retrieved "most related" neighbours were same-language,
    same-day noise rather than the same story.

    The geographic signal is not lost: the story tree ranks on place and the
    map draws it. It just must not dominate the semantic vector.
    """
    title = (row.get("title") or "").strip()
    summary = (row.get("summary") or "").strip()

    parts: list[str] = []
    if title:
        parts.extend([title, title])
    if summary:
        parts.append(summary[:150])

    return " | ".join(p for p in parts if p).strip()


def _input_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


def run(
    recent_days: int | None = None,
    batch_size: int = 128,
    limit: int | None = None,
    force: bool = False,
) -> dict:
    """Backfill article sentence embeddings.

    Returns {encoded, skipped, errors, total_pending}.
    """
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        log.error("sentence-transformers not installed — cannot encode")
        return {"encoded": 0, "skipped": 0, "errors": 0, "total_pending": 0,
                "error": "sentence-transformers not installed"}

    log.info("Loading model %s...", MODEL_NAME)
    try:
        model = SentenceTransformer(f"sentence-transformers/{MODEL_NAME}")
    except Exception as e:
        # The GPU on this host is shared and is often full. A model that
        # cannot even be LOADED onto the GPU used to abort the whole run.
        log.warning("Loading the model on the GPU failed (%s) — using CPU", e)
        model = SentenceTransformer(f"sentence-transformers/{MODEL_NAME}", device="cpu")
    log.info("Model loaded.")

    where_clause = "a.status = 'extracted'"
    params: list = []
    if recent_days is not None:
        where_clause += " AND a.fetched_at > now() - (%s || ' days')::interval"
        params.append(str(recent_days))

    limit_clause = ""
    if limit:
        limit_clause = f" LIMIT {int(limit)}"

    with connect() as conn, conn.cursor() as cur:
        # --force re-encodes articles that already have a vector. Needed when
        # the composed text changes: the stored vector no longer represents
        # the new text, and a mixed corpus in one HNSW index retrieves badly.
        skip_existing = "" if force else (
            "AND e.id IS NULL" if not force else ""
        )
        cur.execute(f"""
            SELECT a.id, a.title, a.summary, a.extracted_location, a.event_type
            FROM news_articles a
            LEFT JOIN nn_article_sentence_embeddings e
              ON e.article_id = a.id AND e.model_name = %s
            WHERE {where_clause}
              {skip_existing}
            ORDER BY a.fetched_at DESC
            {limit_clause}
        """, [MODEL_NAME] + params)
        pending = cur.fetchall()

    total_pending = len(pending)
    if total_pending == 0:
        log.info("No articles pending embedding.")
        return {"encoded": 0, "skipped": 0, "errors": 0, "total_pending": 0}

    log.info("Articles pending embedding: %d", total_pending)

    encoded = 0
    skipped = 0
    errors = 0

    for i in range(0, total_pending, batch_size):
        batch = pending[i : i + batch_size]
        texts = []
        rows_to_insert = []

        for row in batch:
            text = _text_for_article(row)
            if not text or len(text) < 10:
                skipped += 1
                continue
            h = _input_hash(text)
            texts.append(text)
            rows_to_insert.append((row["id"], h))

        if not texts:
            continue

        try:
            vectors = model.encode(
                texts,
                normalize_embeddings=True,
                batch_size=64,
                show_progress_bar=False,
            )
        except Exception as e:
            # The GPU on this host is shared. A CUDA OOM used to abandon the
            # whole batch, which left permanent holes in the semantic index
            # (8,192 articles in the 2026-10-27 backfill). Fall back to CPU
            # instead — slower, but it never loses a batch.
            log.warning("Encoding batch failed on GPU (%s) — retrying on CPU", e)
            try:
                model.to("cpu")
                vectors = model.encode(
                    texts,
                    normalize_embeddings=True,
                    batch_size=32,
                    show_progress_bar=False,
                )
                log.info("CPU fallback succeeded for %d texts", len(texts))
            except Exception as e2:
                log.error("Encoding batch failed on CPU too: %s", e2)
                errors += len(texts)
                continue

        insert_rows = []
        for (article_id, h), vec in zip(rows_to_insert, vectors):
            vec_str = "[" + ",".join(f"{v:.6f}" for v in vec.tolist()) + "]"
            insert_rows.append((article_id, vec_str, MODEL_NAME, h))

        with connect() as conn, conn.cursor() as cur:
            for aid, vec_str, model_name, h in insert_rows:
                try:
                    cur.execute("""
                        INSERT INTO nn_article_sentence_embeddings
                          (article_id, vector, model_name, input_hash)
                        VALUES (%s, %s::vector, %s, %s)
                        ON CONFLICT (article_id, model_name) DO UPDATE
                          SET vector = EXCLUDED.vector,
                              input_hash = EXCLUDED.input_hash,
                              encoded_at = now()
                    """, (aid, vec_str, model_name, h))
                    if cur.rowcount > 0:
                        encoded += 1
                    else:
                        skipped += 1
                except Exception as e:
                    log.debug("Insert failed for article %s: %s", aid, e)
                    errors += 1
            conn.commit()

        elapsed_pct = (i + len(batch)) / total_pending * 100
        log.info("Progress: %d/%d (%.0f%%) — encoded=%d skipped=%d errors=%d",
                 i + len(batch), total_pending, elapsed_pct, encoded, skipped, errors)

    log.info("Done: encoded=%d skipped=%d errors=%d", encoded, skipped, errors)
    return {
        "encoded": encoded,
        "skipped": skipped,
        "errors": errors,
        "total_pending": total_pending,
    }


def main():
    parser = argparse.ArgumentParser(description="Populate article sentence embeddings")
    parser.add_argument("--recent", type=int, default=None,
                        help="Only encode articles from last N days")
    parser.add_argument("--batch", type=int, default=128,
                        help="Batch size for encoding")
    parser.add_argument("--limit", type=int, default=None,
                        help="Max articles to process")
    parser.add_argument("--force", action="store_true",
                        help="Re-encode articles that already have a vector "
                             "(use after the composed text changes)")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    result = run(
        recent_days=args.recent,
        batch_size=args.batch,
        limit=args.limit,
        force=args.force,
    )
    import json
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
