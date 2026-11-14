#!/usr/bin/env bash
# Restart the xyzo API server after editing code.
#
# xyzo.org has two halves:
#   1. Static frontend at /var/www/vhosts/xyzo.org/public_html/
#      Served directly by Caddy from disk. JS / CSS / HTML edits take
#      effect on the next browser refresh — no rebuild required.
#
#   2. API server at /var/www/vhosts/xyzo.org/api/  (bun + Hono)
#      Running standalone under `bun run src/server.ts`. Listens on
#      :3008. Caddy proxies /api/* to it. Restart to pick up code changes.
#
# Run this script from the project root:
#
#   ./scripts/restart-xyzo.sh           # kill + relaunch the API
#   ./scripts/restart-xyzo.sh status    # show running state
#   ./scripts/restart-xyzo.sh logs      # tail the API log
#   ./scripts/restart-xyzo.sh wait      # block until health endpoint OK
#
# Safe to re-run; idempotent.

set -euo pipefail

API_DIR="/var/www/vhosts/xyzo.org/api"
PUBLIC_DIR="/var/www/vhosts/xyzo.org/public_html"
LOG_FILE="/tmp/xyzo-api.log"
API_PORT="3008"
API_HEALTH="http://127.0.0.1:${API_PORT}/api/health"
PID_FILE="/tmp/xyzo-api.pid"

cmd="${1:-restart}"

if [[ "$cmd" == "status" ]]; then
  echo "── API process(es) on :${API_PORT} ──"
  if pgrep -f "bun run src/server.ts" >/dev/null; then
    pgrep -af "bun run src/server.ts" || true
  else
    echo "  (none running)"
  fi
  echo
  echo "── Static file mtimes ──"
  ls -lh --time-style=long-iso "$PUBLIC_DIR/app.js" "$PUBLIC_DIR/styles.css" "$PUBLIC_DIR/index.html" 2>/dev/null \
    | awk '{print "  " $6 " " $7 "  " $NF}'
  echo
  echo "── Health check ──"
  if curl -fsS "$API_HEALTH" 2>/dev/null; then
    echo
  else
    echo "  (API not responding)"
  fi
  exit 0
fi

if [[ "$cmd" == "logs" ]]; then
  exec tail -F "$LOG_FILE"
fi

if [[ "$cmd" == "wait" ]]; then
  echo "Waiting for API at $API_HEALTH …"
  for i in $(seq 1 30); do
    if curl -fsS "$API_HEALTH" >/dev/null 2>&1; then
      echo "  ok after ${i}s"
      exit 0
    fi
    sleep 1
  done
  echo "  timed out after 30s — check $LOG_FILE"
  exit 1
fi

echo "── Restarting xyzo API on :${API_PORT} ──"

OLD_PID=""
if pgrep -f "bun run src/server.ts" >/dev/null; then
  OLD_PID="$(pgrep -f 'bun run src/server.ts' | head -1)"
  echo "  stopping existing PID ${OLD_PID}"
fi

pkill -TERM -f "bun run src/server.ts" 2>/dev/null || true
sleep 1
if [[ -n "${OLD_PID}" ]] && kill -0 "${OLD_PID}" 2>/dev/null; then
  echo "  forcing kill on PID ${OLD_PID}"
  kill -KILL "${OLD_PID}" 2>/dev/null || true
fi

for i in $(seq 1 10); do
  if ! ss -tlnp 2>/dev/null | grep -q ":${API_PORT} "; then
    break
  fi
  sleep 1
done

echo "  launching: bun run src/server.ts  (logs → ${LOG_FILE})"
cd "$API_DIR"
nohup bun run src/server.ts > "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "  new PID: ${NEW_PID}"

echo "  waiting up to 30s for health endpoint…"
ok=0
for i in $(seq 1 30); do
  if curl -fsS "$API_HEALTH" >/dev/null 2>&1; then
    ok=1
    echo "  healthy after ${i}s"
    break
  fi
  sleep 1
done
if [[ "$ok" != "1" ]]; then
  echo "  ⚠ API did NOT respond to $API_HEALTH within 30s."
  echo "  Last 40 log lines:"
  tail -n 40 "$LOG_FILE" | sed 's/^/    /'
  exit 1
fi

echo
echo "── Static files (served by Caddy from ${PUBLIC_DIR}) ──"
echo "  No rebuild needed for public_html/*.js, *.css, *.html."
echo "  Hard-refresh the browser (Ctrl/Cmd+Shift+R) to pick them up."
echo
echo "── Done ──"
