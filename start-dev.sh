#!/bin/bash
# start-dev.sh — Start the XYZO development server
# Runs on port 3009, separate from production (port 3008)
#
# Usage:
#   ./start-dev.sh           # start dev server
#   ./start-dev.sh --stop    # stop dev server
#   ./start-dev.sh --status  # check if running
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
DEV_PORT=3009
PID_FILE="$DIR/.dev-server.pid"
LOG_FILE="$DIR/.dev-server.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[dev]${NC} $1"; }
warn() { echo -e "${YELLOW}[dev]${NC} $1"; }
err()  { echo -e "${RED}[dev]${NC} $1"; exit 1; }

# ── Stop ───────────────────────────────────────────────────────────────
if [ "${1:-}" = "--stop" ]; then
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID"
            rm -f "$PID_FILE"
            log "Dev server stopped (PID $PID)"
        else
            rm -f "$PID_FILE"
            log "Dev server was not running"
        fi
    else
        log "No dev server PID file found"
    fi
    exit 0
fi

# ── Status ─────────────────────────────────────────────────────────────
if [ "${1:-}" = "--status" ]; then
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        PID=$(cat "$PID_FILE")
        HEALTH=$(curl -s --max-time 3 http://localhost:$DEV_PORT/api/health 2>/dev/null || echo '{"ok":false}')
        if echo "$HEALTH" | grep -q '"ok":true'; then
            log "Dev server running (PID $PID) — healthy ✓"
        else
            warn "Dev server running (PID $PID) — unhealthy ✗"
        fi
    else
        warn "Dev server not running"
    fi
    exit 0
fi

# ── Start ──────────────────────────────────────────────────────────────
# Kill existing dev server if running
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    warn "Stopping existing dev server..."
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    sleep 1
fi

# Copy current production frontend to dev as starting point
if [ ! -f "$DIR/public_html_dev/app.js" ]; then
    log "Initializing dev frontend from production..."
    cp "$DIR/public_html/app.js" "$DIR/public_html_dev/app.js"
    cp "$DIR/public_html/styles.css" "$DIR/public_html_dev/styles.css"
    cp "$DIR/public_html/index.html" "$DIR/public_html_dev/index.html"
    # Copy other JS files
    for f in "$DIR/public_html/"*.js; do
        fname=$(basename "$f")
        [ "$fname" = "app.js" ] && continue
        cp "$f" "$DIR/public_html_dev/$fname" 2>/dev/null || true
    done
    log "  ✓ Dev frontend initialized"
fi

log "Starting dev server on port $DEV_PORT..."
log "  Production: http://localhost:3008 (NEVER edit directly)"
log "  Development: http://localhost:$DEV_PORT (edit here)"
log ""

# Start the dev Bun server
cd "$DIR/api"
XYZO_PORT=$DEV_PORT \
XYZO_DB_URL="${XYZO_DB_URL:-postgres://xyzo_app:CHANGE_ME@localhost:5432/xyzo}" \
nohup bun run src/server.ts > "$LOG_FILE" 2>&1 &
DEV_PID=$!
echo "$DEV_PID" > "$PID_FILE"

sleep 2
if kill -0 "$DEV_PID" 2>/dev/null; then
    HEALTH=$(curl -s --max-time 5 http://localhost:$DEV_PORT/api/health 2>/dev/null || echo '{"ok":false}')
    if echo "$HEALTH" | grep -q '"ok":true'; then
        log "✓ Dev server running on http://localhost:$DEV_PORT (PID $DEV_PID)"
    else
        warn "Dev server started but health check failed — check $LOG_FILE"
    fi
else
    err "Dev server failed to start. Check $LOG_FILE"
fi
