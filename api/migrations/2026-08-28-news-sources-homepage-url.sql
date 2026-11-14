-- api/migrations/2026-08-28-news-sources-homepage-url.sql
--
-- Add homepage_url to news_sources so we can link to the publisher's
-- main site instead of the RSS feed XML. Populated at validation time
-- from the channel-level <link> element of the feed (parsed by
-- feedparser — `feed.link` for RSS 2.0, `feed.links[rel=alternate].href`
-- for Atom). Frontend prefers this canonical URL when linking to
-- "open homepage"; falls back to the URL heuristic rewrite for
-- pre-existing rows where homepage_url is NULL.
--
-- Idempotent. Safe to re-run during development.
ALTER TABLE news_sources
  ADD COLUMN IF NOT EXISTS homepage_url TEXT;

-- Optional: index for queries that filter on homepage presence
-- (e.g., backfill progress reports). Skip if column is mostly NULL
-- initially — revisit after backfill.
