#!/bin/bash
# Journalist discovery pipeline - run incrementally
# Usage: ./run-journalist-pipeline.sh [limit] [step]
#   limit  - articles per batch (default: 5000)
#   step   - which step: "backfill", "resolve", "all" (default: all)

set -e

LIMIT=${1:-5000}
STEP=${2:-all}

export XYZO_DB_DSN="${XYZO_DB_DSN:-postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

if [ "$STEP" = "backfill" ] || [ "$STEP" = "all" ]; then
    log "=== Step 1: Backfill article authors (limit=$LIMIT) ==="
    python3 -m worker.backfill_article_authors --limit "$LIMIT"
fi

if [ "$STEP" = "resolve" ] || [ "$STEP" = "all" ]; then
    log "=== Step 2: Resolve journalists (limit=$LIMIT) ==="
    python3 -m worker.journalist_resolver --limit "$LIMIT"
fi

if [ "$STEP" = "all" ]; then
    log "=== Done. Run again with higher limit or different step. ==="
    log "  $0 10000 resolve   # run resolver on next 10k articles"
    log "  $0 5000 all       # backfill + resolve 5k articles"
fi
