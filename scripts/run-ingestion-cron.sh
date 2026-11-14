#!/usr/bin/env bash
# Periodic background feed ingestion runner for Xyzo.
# Runs `python3 -m worker.run --fast` with lock protection to prevent overlapping cycles.
#
# Usage:
#   ./scripts/run-ingestion-cron.sh
#   Or add to crontab / systemd timer:
#   */15 * * * * /var/www/vhosts/xyzo.org/scripts/run-ingestion-cron.sh >> /var/www/vhosts/xyzo.org/logs/ingestion.log 2>&1

set -euo pipefail

PROJECT_DIR="/var/www/vhosts/xyzo.org"
LOCK_FILE="/tmp/xyzo-ingestion.lock"
LOG_DIR="${PROJECT_DIR}/logs"
LOG_FILE="${LOG_DIR}/ingestion.log"

mkdir -p "${LOG_DIR}"

exec 200>"${LOCK_FILE}"
if ! flock -n 200; then
  echo "$(date -Iseconds) [ingestion-cron] Previous ingestion run still active — skipping."
  exit 0
fi

echo "$(date -Iseconds) [ingestion-cron] Starting Xyzo fast ingestion cycle..."
cd "${PROJECT_DIR}"

python3 -m worker.run --fast

echo "$(date -Iseconds) [ingestion-cron] Ingestion cycle completed successfully."
