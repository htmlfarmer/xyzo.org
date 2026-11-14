-- Allow 'manual_discover' as a request_source for news_area_requests
-- This is used by the new POST /api/discover endpoint for user-initiated
-- on-demand news source discovery.
ALTER TABLE news_area_requests
  DROP CONSTRAINT IF EXISTS news_area_requests_request_source_check,
  ADD CONSTRAINT news_area_requests_request_source_check
    CHECK (request_source = ANY (ARRAY[
      'recommend-news'::text,
      'auto-discover'::text,
      'manual_discover'::text
    ]));
