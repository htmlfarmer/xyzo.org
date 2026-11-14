#!/usr/bin/env bash
# ── User request auto-resolution test script ─────────────────────────
# Verifies end-to-end processing of user location corrections, ground-truth
# location learning (learned_from_user_count), and status updates.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

start_group "user request auto-resolution pipeline"

# Seed a test pin, article, and re-evaluation request in DB.
req_info="$(runpsql "
WITH new_art AS (
    INSERT INTO news_articles (source_id, url, title, body, status, fetched_at)
    VALUES ((SELECT id FROM news_sources LIMIT 1), 'https://example.com/test-auto-res-' || floor(random()*100000)::text, 'Protest reported in Karachi', 'Crowds gathered in central Karachi.', 'extracted', now())
    RETURNING id
),
new_pin AS (
    INSERT INTO pins (source_type, title, location, status)
    VALUES ('community', 'Protest reported in Karachi', ST_SetSRID(ST_MakePoint(0,0),4326)::geography, 'published')
    RETURNING id
),
new_req AS (
    INSERT INTO news_re_evaluate_requests (pin_id, article_id, kind, user_place, status)
    SELECT new_pin.id, new_art.id, 'suggest_location', 'coords:24.86,67.0,5.0,0.9,Karachi', 'queued'
    FROM new_pin, new_art
    RETURNING id
)
SELECT id FROM new_req;
" | head -1 | tr -d ' ')"

if [ -n "$req_info" ] && [ "$req_info" -gt 0 ] 2>/dev/null; then
  # Process request via worker.run
  out="$(runpy_module worker.run --re-evaluate-request "$req_info" 2>&1)"
  assert_contains "$out" "\"applied\": true" "user request auto-resolved and applied"
  assert_contains "$out" "kind" "worker output contains request metadata"

  # Verify DB status updated to completed
  db_status="$(runpsql "SELECT status FROM news_re_evaluate_requests WHERE id = $req_info" | head -1 | tr -d ' ')"
  assert_eq "completed" "$db_status" "request status marked completed in DB"

  # Verify learned_from_user_count was incremented on the location row
  learned_count="$(runpsql "
      SELECT l.learned_from_user_count
      FROM news_re_evaluate_requests r
      JOIN news_articles a ON a.id = r.article_id
      JOIN news_locations l ON l.id = a.location_id
      WHERE r.id = $req_info;
  " | head -1 | tr -d ' ')"
  assert_true "$([ "$learned_count" -ge 1 ] && echo true)" "location learned_from_user_count incremented ($learned_count)"
else
  skip "failed to insert test request row"
fi

end_group || exit 1

echo ""
echo -e "${GREEN}${BOLD}All auto-resolution tests passed.${RESET}"
