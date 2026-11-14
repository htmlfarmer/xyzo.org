-- Newsium/Xyzo: extended metadata on news_sources for the new Central/South
-- American ingestion wave + richer per-source observability.
--
-- All columns are NULL-able + additive; existing rows keep their current
-- values. The fetcher does NOT depend on any of these — they're populated
-- by background tooling (cadence tracker, geocoder, AI topic classifier).
--
-- Run: psql "$XYZO_DB_URL" -f api/migrations/2026-09-07-news-sources-extended-metadata.sql

BEGIN;

-- Observability: fetcher fills these on each successful crawl.
ALTER TABLE news_sources
  ADD COLUMN IF NOT EXISTS crawl_latency_ms      INTEGER,
  ADD COLUMN IF NOT EXISTS http_status           INTEGER,
  ADD COLUMN IF NOT EXISTS sitemap_url           TEXT;

-- Coverage / role: "local" (city), "national" (country-wide),
-- "regional" (sub-region), "international" (multi-country).
ALTER TABLE news_sources
  ADD COLUMN IF NOT EXISTS locality              TEXT;

-- Multi-axis topic taxonomy. The single `topic` column already exists;
-- this new array lets a source self-describe across the axes the AI
-- extractor cares about (politics, business, sports, investigations, …).
-- Free-form for now; we can constrain later once the taxonomy stabilizes.
ALTER TABLE news_sources
  ADD COLUMN IF NOT EXISTS topics                TEXT[];

-- Quality signals — populated by background analysis, not by fetcher.
ALTER TABLE news_sources
  ADD COLUMN IF NOT EXISTS geolocation_quality   REAL,
  ADD COLUMN IF NOT EXISTS duplicate_rate        REAL,
  ADD COLUMN IF NOT EXISTS article_length_avg    INTEGER;

-- Light index to support per-locality rollups without seqscans.
CREATE INDEX IF NOT EXISTS news_sources_locality_idx
  ON news_sources (locality) WHERE locality IS NOT NULL;

CREATE INDEX IF NOT EXISTS news_sources_topics_gin_idx
  ON news_sources USING GIN (topics) WHERE topics IS NOT NULL;

COMMIT;
