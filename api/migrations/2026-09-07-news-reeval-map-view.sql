-- Newsium: capture map view state at submit time for re-evaluation requests.
-- Lets /requests.html render a "View original" link that reopens the map at
-- the exact view the requester had (center + zoom). Three additive columns;
-- existing rows stay NULL and fall back to article lat/lng + zoom 8.

BEGIN;

ALTER TABLE news_re_evaluate_requests
  ADD COLUMN IF NOT EXISTS map_center_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS map_center_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS map_zoom INT;

COMMIT;
