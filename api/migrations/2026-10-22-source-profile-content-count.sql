-- Source geographic profiles now measure EDITORIAL geography (articles
-- placed from their own text) separately from the source's total output.
--
-- Why: a source-based fallback that pins "every article the fast path
-- could not place" to one city makes the profile self-reinforcing — the
-- pinned city becomes the profile's top city, and the next cycle pins
-- even more articles there. That is how 12.4k dev.to posts ended up on
-- Bamako (Mali) and 11k GuruFocus posts on Fargo (Wells Fargo).
--
-- content_article_count_30d = articles placed from their own text
-- (auto_categorize_method IS DISTINCT FROM 'source_fallback'). It is the
-- denominator for the "does this source really live in its country?"
-- check in worker/auto_categorize._source_geo_is_country_specific().

ALTER TABLE news_source_geography
    ADD COLUMN IF NOT EXISTS content_article_count_30d INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN news_source_geography.content_article_count_30d IS
    'Articles placed from their own text in the last 30d (excludes source_based fallback placements)';
