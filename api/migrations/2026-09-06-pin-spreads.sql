-- 2026-09-06-pin-spreads.sql
-- Add a spread_position column to pins to persist user-driven pin adjustments
-- (drag-to-spread in the canvas renderer). The endpoint POST /api/pins/spread-positions
-- writes to this column; frontend reads pins.spread_position and uses it in lieu of
-- pins.location when present.
--
-- Idempotent: skip if column already exists (re-running this migration is safe).

ALTER TABLE pins
  ADD COLUMN IF NOT EXISTS spread_position geography(Point,4326);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pins_spread_lng_range'
  ) THEN
    ALTER TABLE pins
      ADD CONSTRAINT pins_spread_lng_range CHECK (
        spread_position IS NULL
        OR (st_x(spread_position::geometry) BETWEEN -180 AND 180)
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS pins_spread_position_gix
  ON pins USING gist (spread_position)
  WHERE spread_position IS NOT NULL;
