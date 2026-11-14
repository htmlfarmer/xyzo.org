#!/usr/bin/env bash
# XYZO Smart Backup Script
# Backs up: schema, recent 24h data, code, and .env
# Keeps 7 days of backups, rotates automatically
set -euo pipefail

DB_NAME="${XYZO_DB_NAME:-xyzo}"
DB_USER="${XYZO_DB_USER:-xyzo_app}"
DB_HOST="${XYZO_DB_HOST:-localhost}"
DB_PORT="${XYZO_DB_PORT:-5432}"
BACKUP_DIR="/var/backups/xyzo"
RETENTION_DAYS=7
DATE=$(date +%Y%m%d_%H%M%S)
LOG_FILE="/var/log/xyzo_backup.log"

mkdir -p "$BACKUP_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

log "=== XYZO Backup Started ==="

# 1. Schema + Recent 24h data
log "Backing up schema + recent 24h data..."
DB_FILE="$BACKUP_DIR/xyzo_recent_${DATE}.sql.gz"
{
  echo "-- XYZO Backup $DATE"
  echo "-- Schema"
  PGPASSWORD="${XYZO_DB_PASS:-CHANGE_ME}" pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --schema-only --no-owner --no-privileges --no-comments 2>/dev/null

  echo ""
  echo "-- Recent data (last 24h)"
  for TABLE in pins news_articles news_events news_sources news_entities events; do
    TS_COL=$(PGPASSWORD="${XYZO_DB_PASS:-CHANGE_ME}" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -A -c "
      SELECT column_name FROM information_schema.columns 
      WHERE table_name='$TABLE' AND table_schema='public'
      AND data_type IN ('timestamp with time zone','timestamp without time zone')
      ORDER BY ordinal_position LIMIT 1;" 2>/dev/null)
    
    if [ -n "$TS_COL" ]; then
      log "  $TABLE (filtered on $TS_COL)"
      PGPASSWORD="${XYZO_DB_PASS:-CHANGE_ME}" pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
        --data-only --no-owner --no-privileges --table="public.$TABLE" \
        --where="$TS_COL > NOW() - INTERVAL '24 hours'" 2>/dev/null
    else
      log "  $TABLE (all data - no timestamp)"
      PGPASSWORD="${XYZO_DB_PASS:-CHANGE_ME}" pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
        --data-only --no-owner --no-privileges --table="public.$TABLE" 2>/dev/null
    fi
  done
} | gzip > "$DB_FILE"
log "  -> $(ls -lh "$DB_FILE" | awk '{print $5}')"

# 2. Code + configs
log "Backing up code + configs..."
CODE_FILE="$BACKUP_DIR/xyzo_code_${DATE}.tar.gz"
tar czf "$CODE_FILE" \
  --exclude='node_modules' --exclude='.git' --exclude='venv' \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='*.log' \
  --exclude='dist' --exclude='.cache' \
  -C /var/www/vhosts/xyzo.org \
  api/src/ api/migrations/ api/package.json api/tsconfig.json \
  worker/ scripts/ deploy/ public/ caddy/ 2>/dev/null
log "  -> $(ls -lh "$CODE_FILE" | awk '{print $5}')"

# 3. .env (separate for security)
log "Backing up .env..."
ENV_FILE="$BACKUP_DIR/xyzo_env_${DATE}.backup"
cp /var/www/vhosts/xyzo.org/api/.env "$ENV_FILE"
log "  -> $(ls -lh "$ENV_FILE" | awk '{print $5}')"

# 4. Rotate old backups
log "Rotating backups older than ${RETENTION_DAYS} days..."
find "$BACKUP_DIR" -name "xyzo_*" -mtime +${RETENTION_DAYS} -delete 2>/dev/null || true
REMAINING=$(find "$BACKUP_DIR" -name "xyzo_*" | wc -l)
log "  -> ${REMAINING} backup sets remaining"

log "=== Backup Complete ==="
