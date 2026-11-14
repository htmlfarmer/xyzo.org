#!/usr/bin/env bash
# Run one xyzo ingestion cycle by hand. Usage:
#   ./worker/run.sh                 # full cycle, default cap 60
#   ./worker/run.sh --limit 30      # cap AI step to 30 articles
#   ./worker/run.sh --dry-run       # fetch + extract only, no DB writes
#   ./worker/run.sh --step fetch    # only run one step
#   ./worker/run.sh --seed-feeds    # only upsert feeds.json → news_sources
set -euo pipefail

cd "$(dirname "$0")/.."  # repo root (so `python3 -m worker.run` resolves)

# Prefer XYZO_DB_DSN; fall back to NEWSIUM_DB_DSN for legacy deploys.
# (See worker/db.py for the matching Python-side resolution.)
export XYZO_DB_DSN="${XYZO_DB_DSN:-${NEWSIUM_DB_DSN:-}}"
export NEWSIUM_DB_DSN="${NEWSIUM_DB_DSN:-${XYZO_DB_DSN:-}}"
if [ -z "${XYZO_DB_DSN}${NEWSIUM_DB_DSN}" ]; then
  echo "XYZO_DB_DSN (or legacy NEWSIUM_DB_DSN) must be set" >&2
  exit 1
fi
export PYTHONUNBUFFERED=1

exec python3 -m worker.run "$@"
