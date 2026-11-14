#!/usr/bin/env bash
# XYZO Database Vacuum Health Check & Auto-Fix
# Safe, non-destructive — runs VACUUM ANALYZE on bloated tables
set -euo pipefail

DB_NAME="${XYZO_DB_NAME:-xyzo}"
DB_USER="${XYZO_DB_USER:-xyzo_app}"
DB_HOST="${XYZO_DB_HOST:-localhost}"
DB_PORT="${XYZO_DB_PORT:-5432}"
DEAD_THRESHOLD="${DEAD_THRESHOLD:-10}"
LOG_FILE="/var/log/xyzo_vacuum.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() { echo "[$TIMESTAMP] $*" | tee -a "$LOG_FILE"; }

run_sql() {
  PGPASSWORD="${XYZO_DB_PASS:-CHANGE_ME}" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -A -c "$1"
}

log "=== XYZO Vacuum Health Check Started ==="

# Find tables with dead tuple percentage above threshold
NEEDS_VACUUM=$(run_sql "
SELECT schemaname || '.' || relname,
       n_live_tup,
       n_dead_tup,
       CASE WHEN n_live_tup > 0
            THEN round(100.0 * n_dead_tup / n_live_tup, 2)
            ELSE 0 END AS dead_pct
FROM pg_stat_user_tables
WHERE n_live_tup > 100
  AND CASE WHEN n_live_tup > 0
           THEN round(100.0 * n_dead_tup / n_live_tup, 2)
           ELSE 0 END > $DEAD_THRESHOLD
ORDER BY n_dead_tup DESC;
")

if [ -z "$NEEDS_VACUUM" ]; then
  log "All tables healthy — no vacuum needed (threshold: ${DEAD_THRESHOLD}%)"
  log "=== Check Complete ==="
  exit 0
fi

log "Tables needing vacuum (dead > ${DEAD_THRESHOLD}%):"
echo "$NEEDS_VACUUM" | while IFS='|' read -r tbl live dead pct; do
  log "  $tbl: $dead dead / $live live ($pct%)"
done

# Vacuum each table (try as xyzo_app first, fallback to postgres for owner-only)
echo "$NEEDS_VACUUM" | while IFS='|' read -r tbl live dead pct; do
  table_name=$(echo "$tbl" | cut -d'.' -f2)
  schema_name=$(echo "$tbl" | cut -d'.' -f1)

  log "Vacuuming $tbl ($pct% dead)..."

  # Try as xyzo_app first
  result=$(run_sql "VACUUM ANALYZE $schema_name.$table_name;" 2>&1) && {
    log "  OK — vacuumed as $DB_USER"
    continue
  }

  # Fallback: try as postgres (for owner-only tables)
  result=$(sudo -u postgres psql -d "$DB_NAME" -c "VACUUM ANALYZE $schema_name.$table_name;" 2>&1) && {
    log "  OK — vacuumed as postgres"
    continue
  }

  log "  WARNING — could not vacuum $tbl: $result"
done

# Summary
TOTAL_VACUUMED=$(echo "$NEEDS_VACUUM" | wc -l)
TOTAL_DEAD_RECLAIMED=$(run_sql "
SELECT COALESCE(SUM(n_dead_tup), 0)
FROM pg_stat_user_tables
WHERE n_live_tup > 100
  AND CASE WHEN n_live_tup > 0
           THEN round(100.0 * n_dead_tup / n_live_tup, 2)
           ELSE 0 END > $DEAD_THRESHOLD;
" 2>/dev/null || echo "0")

log "Vacuumed $TOTAL_VACUUMED tables"
log "=== XYZO Vacuum Health Check Complete ==="
