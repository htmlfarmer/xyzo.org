#!/usr/bin/env bash
# ── Deprecated Full Database Backup Script ─────────────────────────────────
# Full database dumps via pg_dump are disabled to prevent high DB load.
# Automatically delegates to the lightweight test-gated backup script instead.

set -euo pipefail

BASE_DIR="/var/www/vhosts/xyzo.org"

echo "⚠️ Full website/database dump disabled (prevents heavy database IO load)."
echo "--> Delegating to lightweight 24h test-gated backup script..."
exec "${BASE_DIR}/scripts/backup-lightweight.sh" "$@"
