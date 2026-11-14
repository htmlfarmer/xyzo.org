#!/usr/bin/env bash
# ── trigger-story-link.sh ─────────────────────────────────────────────
#
# Fires the story_link + PageRank job by hitting POST /api/links/detect
# against the local API. The endpoint enqueues a 'links_generate' job
# with op='story_link', which the worker dispatcher picks up and runs:
#
#   1. worker.story_linker.run — geo + keyword + pgvector embedding
#      linking of recent articles → news_story_links
#   2. _compute_pagerank — power-iteration PageRank over the resulting
#      graph → news_articles.pagerank_score
#
# Designed to be invoked by xyzo-story-link.service, but safe to call
# manually too. Exits 0 on successful enqueue (we don't wait for the
# worker to finish — the dispatcher handles that asynchronously and
# the job's progress is visible via /api/discovery-status/<job_id>).
#
# Idempotent — calling while another story_link is running is fine,
# the dispatcher's soft cap (queued: 10, running: 3) absorbs it.

set -euo pipefail

API_BASE="${XYZO_API_BASE:-http://127.0.0.1:3008}"
ENDPOINT="${API_BASE}/api/links/detect"

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "[$started] firing story_link → $ENDPOINT"

# -fsS: fail on HTTP error, silent progress, show errors.
# Capture both body and status code so we can surface a useful message.
response=$(curl -fsS -X POST "$ENDPOINT" \
  -H 'Content-Type: application/json' \
  -w '\n%{http_code}' 2>&1) || {
  echo "✗ POST $ENDPOINT failed: $response" >&2
  echo "  (is the API up on $API_BASE? Try: systemctl status xyzo-api)" >&2
  exit 1
}

http_code=$(printf '%s\n' "$response" | tail -n1)
body=$(printf '%s\n' "$response" | sed '$d')

echo "  HTTP $http_code"
echo "  body: $body"

# Parse job_id out of the response so the operator can poll it.
job_id=$(printf '%s' "$body" | grep -oE '"job_id"[[:space:]]*:[[:space:]]*"[^"]+"' \
         | head -1 | sed -E 's/.*"([^"]+)"$/\1/')

if [ -n "${job_id:-}" ]; then
  echo "  job_id: $job_id"
  echo "  poll:   curl -s ${API_BASE}/api/discovery-status/${job_id}"
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] enqueued"
