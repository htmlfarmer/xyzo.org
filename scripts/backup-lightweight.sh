#!/usr/bin/env bash
# ── Lightweight Website & 24h Emergency Data Backup Script ──────────────────
# Backs up the XYZO codebase (public_html, api, worker algorithms, AI models, scripts)
# and a 24-hour snapshot of recent news data to /var/www/vhosts/xyzo.org/backups/
#
# GATEKEEPER: Backups only run if all automated tests pass!
# Usage: ./scripts/backup-lightweight.sh

set -euo pipefail

BASE_DIR="/var/www/vhosts/xyzo.org"
BACKUP_DIR="${BASE_DIR}/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/xyzo_lightweight_${TIMESTAMP}.tar.gz"
DB_DSN="${XYZO_DB_DSN:-postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo}"
TMP_DATA_DIR="/tmp/xyzo_snapshot_${TIMESTAMP}"

mkdir -p "${BACKUP_DIR}" "${TMP_DATA_DIR}"

echo "============================================================"
echo " Starting XYZO Lightweight Backup [${TIMESTAMP}]"
echo "============================================================"

# 0. Pre-Backup Test Gatekeeper (Only backup if tests pass!)
echo "--> Running automated test suite gatekeeper (validate-api.sh)..."
if ! "${BASE_DIR}/scripts/validate-api.sh"; then
  echo "❌ BACKUP ABORTED: Automated API & Playwright E2E UI tests failed!"
  echo "   Backups are strictly prohibited when tests are failing."
  rm -rf "${TMP_DATA_DIR}"
  exit 1
fi
echo "✓ Test suite PASSED cleanly — proceeding with backup creation."

# 1. Export 24-Hour Emergency Data Snapshot
echo "--> Exporting 24-hour data snapshot (articles, events & active sources)..."
psql "${DB_DSN}" -c "\copy (SELECT * FROM news_articles WHERE fetched_at >= now() - interval '24 hours') TO '${TMP_DATA_DIR}/articles_24h.csv' WITH CSV HEADER;" 2>/dev/null || true
psql "${DB_DSN}" -c "\copy (SELECT * FROM news_events WHERE first_reported_at >= now() - interval '24 hours') TO '${TMP_DATA_DIR}/events_24h.csv' WITH CSV HEADER;" 2>/dev/null || true
psql "${DB_DSN}" -c "\copy (SELECT * FROM news_sources WHERE active = true) TO '${TMP_DATA_DIR}/sources.csv' WITH CSV HEADER;" 2>/dev/null || true
echo "    24h data snapshot exported to ${TMP_DATA_DIR}"

# 2. Archive Codebase, AI Models & Algorithms, and 24h Snapshot
echo "--> Compressing codebase, AI algorithms & 24h snapshot..."
tar -czf "${BACKUP_FILE}" \
    -C "${BASE_DIR}" \
    --exclude="node_modules" \
    --exclude=".git" \
    --exclude="__pycache__" \
    --exclude="logs/*.log" \
    --exclude="backups/*.tar.gz" \
    public_html api worker scripts deploy data AGENTS.md README.md \
    -C "${TMP_DATA_DIR}" .

# Clean up temporary snapshot directory
rm -rf "${TMP_DATA_DIR}"

FILE_SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
echo "✓ Lightweight backup created: ${BACKUP_FILE} (${FILE_SIZE})"

# 3. Retain last 7 daily archives
echo "--> Cleaning up archives older than 7 days..."
find "${BACKUP_DIR}" -name "xyzo_lightweight_*.tar.gz" -mtime +7 -delete || true

echo "============================================================"
echo " Lightweight Backup Completed Successfully!"
echo "============================================================"
