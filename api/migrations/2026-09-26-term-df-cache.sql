-- FIX_NOTES 1.10 (2026-09-26): TF-IDF term→#locations document-frequency
-- cache. The old compute_tfidf ran one full news_articles scan PER TERM
-- (~1000 per location) and saturated the database for hours. One hourly
-- refresh pass + cheap = ANY() lookups now.
CREATE TABLE IF NOT EXISTS news_term_df (
    term        text        NOT NULL PRIMARY KEY,
    locations   integer     NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS news_term_df_locations_idx
    ON news_term_df (locations);

GRANT SELECT, INSERT, UPDATE, DELETE ON news_term_df TO xyzo_app;
