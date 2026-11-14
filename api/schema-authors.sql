-- Author metadata captured at ingestion time from RSS / HTML scraper.
-- This is the primary signal for journalist discovery since RSS bodies
-- are HTML-stripped before storage (losing author bio paragraphs).
CREATE TABLE IF NOT EXISTS news_article_authors (
    id                  BIGSERIAL PRIMARY KEY,
    article_id          BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,

    -- From RSS entry.author / entry.author_detail
    author_name         TEXT,
    author_url          TEXT,       -- href from author_detail, or /author/ page URL

    -- How confident we are this is a real person's byline
    confidence          DOUBLE PRECISION DEFAULT 0.5,

    -- Evidence type: how we found this
    evidence_type       TEXT NOT NULL DEFAULT 'rss_field',
    -- rss_author | rss_dc_creator | json_ld | meta_author | html_byline |
    -- html_author_link | html_bio_paragraph | scraper_fallback | none

    -- JSON blob of raw evidence for debugging
    raw_evidence        JSONB DEFAULT '{}',

    -- Bio paragraph extracted from HTML (before tag stripping)
    bio_paragraph        TEXT,

    -- Organization the article was published under
    publisher_name       TEXT,

    extracted_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(article_id)
);

CREATE INDEX IF NOT EXISTS idx_aa_article   ON news_article_authors(article_id);
CREATE INDEX IF NOT EXISTS idx_aa_author   ON news_article_authors USING GIN (lower(author_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_aa_url      ON news_article_authors(author_url);

GRANT SELECT, INSERT, UPDATE, DELETE ON news_article_authors TO xyzo_app;
