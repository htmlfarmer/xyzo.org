-- The two indexes the TEXT SEARCH needs to stop scanning the corpus.
--
-- MEASURED 2026-11-11, on the live corpus (3,796,777 articles, 3.7 M of
-- them 'extracted'):
--
--   /api/pins?q=tokyo      34.6 s  ->  0.94 s
--   /api/pins?q=india      26.6 s  ->  1.3 s
--   /api/pins?q=volcano    39.3 s  ->  0.58 s
--   /api/pins?q=nvidia    155.9 s  ->  1.78 s
--   /api/locations/search   2.05 s ->  0.33 s
--
-- TWO SEPARATE CAUSES, TWO INDEXES.
--
--
-- (1) THE DISCOVERY BRANCH MADE THE WHOLE OR UN-INDEXABLE.
--
-- The text predicate is an OR of five legs:
--
--   title ILIKE '%q%'  OR summary ILIKE '%q%'      <- trigram GIN: indexable
--   title %> q        OR summary %> q            <- trigram GIN: indexable
--   source_kind = 'web_discovered'
--     AND discovery_query ILIKE '%q%'              <- NO index at all
--
-- One un-indexable leg inside an OR is enough: the planner cannot use
-- an index for the OR as a whole, so it fell back to a PARALLEL SEQ SCAN
-- of the whole 3.8 M-row table (759,156 rows discarded by the filter),
-- reading 397,043 buffers — 3.1 GB of I/O — to produce 978 rows.
--
-- And that leg is worth almost nothing: `source_kind = 'web_discovered'`
-- is **20 rows** in the entire corpus. It was costing a full scan to
-- look at twenty articles.
--
-- A partial GIN trigram index over exactly those twenty rows makes the
-- leg indexable, so the planner can OR all five legs:
--
--   BitmapOr -> title_trgm (1585) + summary_trgm (1479)
--             + title_trgm (1668) + summary_trgm (1558)
--             + discovery_trgm (0)
--
--
-- (2) THE LOCATION COUNT READ THE WHOLE ARTICLE TABLE.
--
-- /api/locations/search counted the articles of ALL 45,231 locations
-- before it could answer a query about a handful of places, because the
-- aggregate was uncorrelated. That endpoint is called on EVERY search,
-- in parallel with the pin search.
--
-- idx_news_articles_loc_pub makes each per-location count an INDEX-ONLY
-- scan (location_id, published_at) WHERE status = 'extracted': the
-- count needs no heap visit, because both columns it reads are in the
-- index. 2,050 ms -> 67.7 ms for the same rows and the same numbers.
--
-- Applied 2026-11-11. Run:
--   psql "$XYZO_DB_DSN" -f api/migrations/2026-11-11-search-text-indexes.sql

-- (1) The twenty web-discovered articles, searchable by the query that
--     found them.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_articles_discovery_trgm
    ON news_articles USING gin (discovery_query gin_trgm_ops)
    WHERE source_kind = 'web_discovered';

-- (2) Per-location article counts, index-only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_news_articles_loc_pub
    ON news_articles (location_id, published_at)
    WHERE status = 'extracted';
