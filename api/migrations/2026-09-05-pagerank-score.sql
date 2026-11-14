-- ── 2026-09-05-pagerank-score.sql ────────────────────────────────────
--
-- Adds `pagerank_score` to news_articles so the story linker can store
-- per-article graph-importance scores computed from news_story_links
-- edges. Populated by worker/handlers/links_generate.py when invoked
-- with op='story_link'.
--
-- Idempotent — safe to re-run.
--
-- Why a column instead of a separate table?
--   • The score is a single per-article value, queried in JOINs.
--   • news_articles is the natural place; UI surfaces (pins ranking)
--     already JOIN it.
--   • Index supports ORDER BY pagerank_score DESC LIMIT N cheaply.
--
-- DO block handles the "table owned by postgres, not xyzo_app" case
-- the same way the rest of the migration set does.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'news_articles' AND column_name = 'pagerank_score'
    ) THEN
        ALTER TABLE news_articles ADD COLUMN pagerank_score FLOAT;
    END IF;
END$$;

-- Partial index — only rows with a score are interesting for ranking.
-- Smaller index, faster ORDER BY DESC LIMIT N.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'news_articles_pagerank_score_idx'
    ) THEN
        CREATE INDEX news_articles_pagerank_score_idx
            ON news_articles (pagerank_score DESC NULLS LAST)
            WHERE pagerank_score IS NOT NULL;
    END IF;
END$$;
