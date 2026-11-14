-- ── 2026-09-07-embeddings.sql ──────────────────────────────────────
--
-- Enable pgvector for semantic event dedup. Adds a 384-dim embedding
-- column (matches sentence-transformers/all-MiniLM-L6-v2) to:
--   crawl_events  — events extracted from site_crawl runs
--   upcoming_events — unified events table (cross-source dedup target)
--
-- Empty embedding = no semantic dedup runs for that row. Existing
-- rows are unaffected.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Add embedding columns (idempotent) ─────────────────────────────
ALTER TABLE crawl_events
    ADD COLUMN IF NOT EXISTS embedding vector(384),
    ADD COLUMN IF NOT EXISTS embedding_text TEXT;

ALTER TABLE upcoming_events
    ADD COLUMN IF NOT EXISTS embedding vector(384);

-- ── Indexes for cosine similarity ──────────────────────────────────
-- Uses hnsw to match the existing pgvector convention in
-- schema-nn-embeddings.sql (nn_article_embeddings_hnsw_idx,
-- nn_event_embeddings_hnsw_idx). hnsw gives better recall, needs
-- no lists tuning, and won't degrade as data grows past 10x.
--
-- Note: CREATE INDEX inside a transaction takes a SHARE lock; for
-- tables >100k rows, drop+recreate with CONCURRENTLY in a follow-up
-- migration. At current ~114 rows this is microseconds.

CREATE INDEX IF NOT EXISTS crawl_events_embedding_idx
    ON crawl_events USING hnsw (embedding vector_cosine_ops)
    WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS upcoming_events_embedding_idx
    ON upcoming_events USING hnsw (embedding vector_cosine_ops)
    WHERE embedding IS NOT NULL;

COMMIT;
