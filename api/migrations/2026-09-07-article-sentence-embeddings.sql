-- ── 2026-09-07-article-sentence-embeddings.sql ─────────────────────
--
-- 384-dim sentence embeddings for article semantic linking.
-- Uses sentence-transformers/all-MiniLM-L6-v2 (same model as
-- crawl_events/upcoming_events embeddings).
--
-- These embeddings power Pass 3 of the story linker: cross-language
-- semantic similarity via pgvector ANN search.
--
-- Separate from nn_article_embeddings (16-dim internal NN model)
-- because the sentence-transformers model produces much richer
-- semantic representations for cross-language matching.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS nn_article_sentence_embeddings (
    id              BIGSERIAL PRIMARY KEY,
    article_id      BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
    vector          vector(384) NOT NULL,
    model_name      TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
    input_hash      TEXT NOT NULL,
    encoded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (article_id, model_name)
);

CREATE INDEX IF NOT EXISTS nn_article_sentence_emb_aid_idx
    ON nn_article_sentence_embeddings (article_id);

CREATE INDEX IF NOT EXISTS nn_article_sentence_emb_hnsw_idx
    ON nn_article_sentence_embeddings USING hnsw (vector vector_cosine_ops);

GRANT SELECT ON nn_article_sentence_embeddings TO xyzo_app;

COMMIT;
