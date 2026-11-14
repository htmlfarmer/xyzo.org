-- Add trigram GIN index on pins.title for fast ILIKE/similarity search.
-- The /api/pins?q= endpoint uses pins.title ILIKE '%query%' which currently
-- forces a sequential scan of the entire pins table.
CREATE INDEX IF NOT EXISTS pins_title_trgm_idx
  ON pins USING GIN (title gin_trgm_ops);
