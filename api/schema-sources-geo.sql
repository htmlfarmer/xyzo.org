-- ─── Geocode news_sources once, not per-article ─────────────────────────
--
-- AI discovery geocodes each new source's country/region to a single
-- lat/lng pair. Storing it on the source row means subsequent articles
-- flowing from that source can be retrieved by source coordinates
-- without re-hitting Nominatim for every article.
--
-- Idempotent. Safe to re-run during development.
ALTER TABLE news_sources
    ADD COLUMN IF NOT EXISTS lat                 DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS lng                 DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS geocoded_at         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS geocoded_location   TEXT;

-- Cheap range check; same bounds as news_locations but on the source row.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'news_sources_lat_range'
    ) THEN
        ALTER TABLE news_sources
            ADD CONSTRAINT news_sources_lat_range
            CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
            ADD CONSTRAINT news_sources_lng_range
            CHECK (lng IS NULL OR lng BETWEEN -180 AND 180);
    END IF;
END$$;

-- A radius query "news sources within 200km of (lat,lng)" needs both
-- columns populated. Partial index keeps it cheap even when most rows
-- are still un-geocoded.
CREATE INDEX IF NOT EXISTS news_sources_geo_idx
    ON news_sources (lat, lng)
    WHERE lat IS NOT NULL AND lng IS NOT NULL;
