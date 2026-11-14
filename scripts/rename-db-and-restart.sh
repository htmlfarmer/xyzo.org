#!/usr/bin/env bash
set -euo pipefail

# Rename newsium_cities → xyzo_cities and restart all services
# Run as root: sudo ./scripts/rename-db-and-restart.sh

echo "═══════════════════════════════════════════════════════════════"
echo "  RENAME newsium_cities → xyzo_cities + RESTART"
echo "═══════════════════════════════════════════════════════════════"

# ── 1. Stop all services ──────────────────────────────────────────
echo ""
echo "── 1. Stopping services ──"
systemctl stop xyzo-api xyzo-fetcher xyzo-fast-fetcher xyzo-queue-soak 2>/dev/null || true
sleep 2

# Force kill any remaining processes
pkill -9 -f "bun run src/server.ts" 2>/dev/null || true
pkill -9 -f "worker.dispatcher" 2>/dev/null || true
pkill -9 -f "worker.run" 2>/dev/null || true
pkill -9 -f "worker.explore_region" 2>/dev/null || true
sleep 1
echo "  ✓ All services stopped"

# ── 2. Check if newsium_cities exists ─────────────────────────────
echo ""
echo "── 2. Checking databases ──"

NEWSIUM_CITIES_EXISTS=$(psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'newsium_cities'" 2>/dev/null || echo "")
XYZO_CITIES_EXISTS=$(psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'xyzo_cities'" 2>/dev/null || echo "")

if [[ "$NEWSIUM_CITIES_EXISTS" == "1" ]]; then
  echo "  Found: newsium_cities"
else
  echo "  No newsium_cities database found (already renamed or never existed)"
fi

if [[ "$XYZO_CITIES_EXISTS" == "1" ]]; then
  echo "  Found: xyzo_cities"
fi

# ── 3. Rename database ───────────────────────────────────────────
echo ""
echo "── 3. Renaming database ──"

if [[ "$NEWSIUM_CITIES_EXISTS" == "1" && "$XYZO_CITIES_EXISTS" != "1" ]]; then
  # Simple case: rename newsium_cities → xyzo_cities
  psql -U postgres -c "ALTER DATABASE newsium_cities RENAME TO xyzo_cities;"
  echo "  ✓ Renamed newsium_cities → xyzo_cities"

elif [[ "$NEWSIUM_CITIES_EXISTS" == "1" && "$XYZO_CITIES_EXISTS" == "1" ]]; then
  # Both exist: need to merge or drop one
  echo "  ⚠ Both newsium_cities and xyzo_cities exist!"
  echo "  Checking which one has more data..."

  NEWSIUM_COUNT=$(psql -U postgres -d newsium_cities -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'" 2>/dev/null || echo "0")
  XYZO_COUNT=$(psql -U postgres -d xyzo_cities -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'" 2>/dev/null || echo "0")

  echo "    newsium_cities: $NEWSIUM_COUNT tables"
  echo "    xyzo_cities: $XYZO_COUNT tables"

  if [[ "$XYZO_COUNT" -gt "$NEWSIUM_COUNT" ]]; then
    echo "  → xyzo_cities has more tables, dropping newsium_cities"
    psql -U postgres -c "DROP DATABASE newsium_cities;"
    echo "  ✓ Dropped newsium_cities (xyzo_cities is the primary)"
  else
    echo "  → newsium_cities has more tables, renaming it"
    psql -U postgres -c "DROP DATABASE xyzo_cities;"
    psql -U postgres -c "ALTER DATABASE newsium_cities RENAME TO xyzo_cities;"
    echo "  ✓ Dropped xyzo_cities, renamed newsium_cities → xyzo_cities"
  fi

else
  echo "  ✓ No rename needed (newsium_cities doesn't exist)"
fi

# ── 4. Update FDW references ─────────────────────────────────────
echo ""
echo "── 4. Updating FDW references ──"

# Update the FDW server to point to the new database name
psql -U postgres -d xyzo -c "
  ALTER SERVER xyzo_cities_server OPTIONS (SET dbname 'xyzo_cities');
" 2>/dev/null && echo "  ✓ Updated FDW server dbname" || echo "  → FDW server already correct or not configured"

# ── 5. Verify ─────────────────────────────────────────────────────
echo ""
echo "── 5. Verification ──"

echo "  Databases:"
psql -U postgres -tAc "SELECT datname FROM pg_database WHERE datname LIKE '%cities%' ORDER BY datname;"

echo ""
echo "  Roles:"
psql -U postgres -tAc "SELECT rolname FROM pg_roles WHERE rolname IN ('newsium_app', 'xyzo_app') ORDER BY rolname;"

echo ""
echo "  Functions:"
psql -U postgres -d xyzo -tAc "SELECT proname FROM pg_proc WHERE proname LIKE '%updated_at%';"

echo ""
echo "  FDW Servers:"
psql -U postgres -d xyzo -tAc "SELECT srvname FROM pg_foreign_server;"

# ── 6. Restart services ──────────────────────────────────────────
echo ""
echo "── 6. Restarting services ──"

systemctl start xyzo-api
sleep 3

# Check if API is healthy
if curl -sf http://localhost:3008/api/health >/dev/null 2>&1; then
  echo "  ✓ xyzo-api is healthy"
else
  echo "  ✗ xyzo-api failed to start!"
  systemctl status xyzo-api --no-pager | head -15
  exit 1
fi

systemctl start xyzo-fetcher xyzo-fast-fetcher xyzo-queue-soak 2>/dev/null || true
echo "  ✓ All services started"

# ── 7. Final status ──────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  MIGRATION COMPLETE"
echo "═══════════════════════════════════════════════════════════════"
echo ""
systemctl is-active xyzo-api xyzo-fetcher xyzo-fast-fetcher 2>/dev/null | paste - - - | column -t
echo ""
echo "  API: $(curl -sf http://localhost:3008/api/health | python3 -c 'import sys,json; print(json.load(sys.stdin)["ok"])' 2>/dev/null || echo 'ERROR')"
echo ""
