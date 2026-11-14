#!/bin/bash
# scripts/queue-soak-monitor.sh
#
# Daily check of the worker job queue stability metrics (Slice A Phase 5 gate).
# Runs once per day via systemd timer. Auto-cleans itself at day 14.

set -uo pipefail

ROOT="/var/www/vhosts/xyzo.org"
STATE_FILE="$ROOT/data/queue-soak-state.json"
LOG_DIR="$ROOT/logs/queue-soak"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR" "$ROOT/data"

# Initialize state file on first run
if [ ! -f "$STATE_FILE" ]; then
  cat > "$STATE_FILE" <<EOF
{
  "start_date": "$(date +%Y-%m-%d)",
  "target_end_date": "$(date -d '+14 days' +%Y-%m-%d)",
  "day_count": 0,
  "last_check": null,
  "failures": []
}
EOF
fi

# Bump day count
DAY=$(jq '.day_count + 1' "$STATE_FILE")
jq --arg day "$DAY" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.day_count = ($day|tonumber) | .last_check = $now' \
  "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

START_DATE=$(jq -r '.start_date' "$STATE_FILE")
TARGET_END=$(jq -r '.target_end_date' "$STATE_FILE")

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE"
}

log "=== Queue soak day $DAY of 14 (target end: $TARGET_END) ==="

# ── Metrics ──

# 1. Pool state from /api/health
HEALTH=$(curl -sS --max-time 5 http://localhost:3008/api/health 2>/dev/null || echo '{"queue":{"state":"UNKNOWN"}}')
QUEUE_STATE=$(echo "$HEALTH" | jq -r '.queue.state // "UNKNOWN"')
DEGRADED_SINCE=$(echo "$HEALTH" | jq -r '.queue.degradedSince // null')
ACTIVE_WORKERS=$(echo "$HEALTH" | jq -r '.queue.activeWorkers // 0')
POOL_SIZE=$(echo "$HEALTH" | jq -r '.queue.poolSize // 0')

log "Pool state: $QUEUE_STATE (active=$ACTIVE_WORKERS/$POOL_SIZE)"
[ "$QUEUE_STATE" = "RUNNING" ] || log "  WARNING pool is not RUNNING"
[ "$DEGRADED_SINCE" != "null" ] && log "  WARNING pool degraded since $DEGRADED_SINCE"

# 2. Stale-claim sweeper resets today (from journalctl)
RESETS=$(journalctl -u xyzo-api --since "24 hours ago" --no-pager 2>/dev/null | grep "sweeper reset" | wc -l)
log "Sweeper resets (24h): $RESETS"
[ "$RESETS" -ge 5 ] && log "  WARNING sweeper resets >=5/day threshold"

# 3. Pool degraded events today
DEGRADED_EVENTS=$(journalctl -u xyzo-api --since "24 hours ago" --no-pager 2>/dev/null | grep -c "degraded" | head -1)
log "Degraded events (24h): $DEGRADED_EVENTS"
[ "$DEGRADED_EVENTS" -gt 0 ] && log "  WARNING pool degraded events today"

# 4. Legacy-path calls today (look for 'via: legacy' in journal)
LEGACY_CALLS=$(journalctl -u xyzo-api --since "24 hours ago" --no-pager 2>/dev/null | grep '"via":"legacy"' | wc -l)
log "Legacy-path calls (24h): $LEGACY_CALLS"
[ "$LEGACY_CALLS" -gt 0 ] && log "  WARNING legacy fallback used today"

# 5. explore_region timeout rate (last 24h)
TIMEOUT_RATE=$(PGPASSWORD="${XYZO_DB_PASS:-CHANGE_ME}" psql -h localhost -U newsium_app -d newsium -t -A -c "
  SELECT
    CASE WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(100.0 * SUM(CASE WHEN error LIKE '%timeout%' OR error LIKE '%JobTimeout%' THEN 1 ELSE 0 END)::numeric / COUNT(*), 2)
    END
  FROM discovery_jobs
  WHERE kind = 'explore_region' AND scheduled_at > NOW() - INTERVAL '24 hours';
" 2>/dev/null || echo "ERR")
log "explore_region timeout rate (24h): ${TIMEOUT_RATE}%"
if [ "$TIMEOUT_RATE" != "ERR" ]; then
  ABOVE_THRESHOLD=$(echo "$TIMEOUT_RATE > 1" | bc -l 2>/dev/null || echo 0)
  [ "$ABOVE_THRESHOLD" = "1" ] && log "  WARNING timeout rate >=1% threshold"
fi

# 6. Job counts by status (last 24h)
JOB_COUNTS=$(PGPASSWORD="${XYZO_DB_PASS:-CHANGE_ME}" psql -h localhost -U newsium_app -d newsium -t -A -c "
  SELECT status, COUNT(*) FROM discovery_jobs
  WHERE scheduled_at > NOW() - INTERVAL '24 hours'
  GROUP BY status ORDER BY status;
" 2>/dev/null | tr '\n' ' ')
log "Job counts (24h): $JOB_COUNTS"

# ── Day-14 cleanup ──

if [ "$DAY" -ge 14 ]; then
  log "=== Day 14 reached — running Phase 5 cleanup ==="
  bash "$ROOT/scripts/queue-soak-cleanup.sh" 2>&1 | tee -a "$LOG_FILE"
  log "=== Cleanup complete. Self-disabling timer. ==="
  systemctl disable --now xyzo-queue-soak.timer 2>&1 | tee -a "$LOG_FILE" || true
  # Mark state
  jq '.cleanup_completed = now | todate' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
fi

log "=== Done ==="
