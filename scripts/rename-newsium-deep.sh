#!/usr/bin/env bash
set -euo pipefail

# Deep rename: NEWSIUM_* env vars, DB user, DB function, connection strings
# Run from repo root: ./scripts/rename-newsium-deep.sh [--dry-run]
#
# THIS IS A BREAKING CHANGE - requires:
# 1. Update .env files
# 2. Run DB migrations
# 3. Restart all services

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

DRY_RUN="${1:-}"
if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "=== DRY RUN — no files will be modified ==="
fi

UPDATED=0

replace_in_file() {
  local file="$1" old="$2" new="$3"
  if [[ -f "$file" ]]; then
    if grep -qF "$old" "$file" 2>/dev/null; then
      if [[ "$DRY_RUN" == "--dry-run" ]]; then
        local count
        count=$(grep -cF "$old" "$file" 2>/dev/null || echo 0)
        echo "  SED: $file — '$old' → '$new' ($count)"
        UPDATED=$((UPDATED + 1))
      else
        perl -i -pe "s/\Q$old\E/$new/g" "$file"
        UPDATED=$((UPDATED + 1))
      fi
    fi
  fi
}

echo "═══════════════════════════════════════════════════════════════"
echo "  DEEP RENAME: NEWSIUM → XYZO (env vars, DB, connections)"
echo "═══════════════════════════════════════════════════════════════"

# ── 1. ENVIRONMENT VARIABLES ────────────────────────────────────────
echo ""
echo "── 1. NEWSIUM_* → XYZO_* environment variables ──"

# All files that use NEWSIUM_ env vars
FILES_WITH_ENV=(
  api/src/server.ts
  api/src/db.ts
  api/src/wiki-db.ts
  api/src/geoip.ts
  api/src/ai-breaker.ts
  api/src/queue/workerPool.ts
  api/src/routes/health.ts
  api/src/routes/explore.ts
  api/src/routes/search.ts
  api/src/routes/feedback.ts
  api/src/routes/geocode.ts
  api/src/routes/ai-chat.ts
  api/.env
  api/.env.example
  worker/db.py
  worker/extract.py
  worker/fetch.py
  worker/geocode.py
  worker/granular_geocode.py
  worker/source_discovery.py
  worker/explore_region.py
  worker/run.py
  worker/progress.py
  worker/wiki_geo.py
  worker/cities_cli.py
  worker/load_cities.py
  worker/build_cities_db.py
  worker/migrate_cities.py
  worker/run.sh
  deploy/xyzo-api.service
  deploy/xyzo-fetcher.service
  deploy/xyzo-fast-fetcher.service
  deploy/xyzo-queue-soak.service
  scripts/test-system.sh
  scripts/tests/lib.sh
  scripts/tests/test-api-endpoints.sh
  scripts/geoip-smoke.ts
  scripts/queue-soak-monitor.sh
  scripts/deploy-xyzo.sh
  scripts/restart-xyzo.sh
)

for f in "${FILES_WITH_ENV[@]}"; do
  [[ -f "$f" ]] || continue
  replace_in_file "$f" "NEWSIUM_" "XYZO_"
done

# ── 2. CONNECTION STRINGS ───────────────────────────────────────────
echo ""
echo "── 2. Connection strings: newsium_app → xyzo_app ──"

FILES_WITH_CONN=(
  api/src/db.ts
  api/src/wiki-db.ts
  api/src/routes/explore.ts
  api/src/routes/search.ts
  worker/db.py
  worker/wiki_geo.py
  worker/migrate_cities.py
  api/.env
  api/.env.example
  deploy/xyzo-fetcher.service
  deploy/xyzo-fast-fetcher.service
  deploy/xyzo-queue-soak.service
  scripts/queue-soak-monitor.sh
  scripts/deploy-xyzo.sh
  scripts/test-system.sh
  scripts/tests/lib.sh
  scripts/migrate-db.sh
)

for f in "${FILES_WITH_CONN[@]}"; do
  [[ -f "$f" ]] || continue
  replace_in_file "$f" "newsium_app" "xyzo_app"
  replace_in_file "$f" "CHANGE_ME" "CHANGE_ME"
done

# ── 3. DATABASE NAME IN CONNECTION STRINGS ──────────────────────────
echo ""
echo "── 3. Database name: /newsium → /xyzo in connection strings ──"

# Only replace /newsium at end of connection strings (not /newsium_cities)
for f in "${FILES_WITH_CONN[@]}"; do
  [[ -f "$f" ]] || continue
  # Match /newsium at end of line or before whitespace/quote
  if [[ "$DRY_RUN" == "--dry-run" ]]; then
    if grep -qF '/newsium' "$f" 2>/dev/null; then
      echo "  REGEX: $f — /newsium → /xyzo (connection string)"
      UPDATED=$((UPDATED + 1))
    fi
  else
    # Use perl with proper escaping
    perl -i -pe 's|/newsium(?=["\s]|$)|/xyzo|g' "$f" 2>/dev/null || true
  fi
done

# ── 4. SQL FUNCTION NAME ───────────────────────────────────────────
echo ""
echo "── 4. SQL function: newsium_set_updated_at → xyzo_set_updated_at ──"

SQL_FILES=(
  api/schema.sql
  api/schema-events.sql
  api/schema-feed-submissions.sql
  api/migrations/2026-08-27-job-queue.sql
)

for f in "${SQL_FILES[@]}"; do
  [[ -f "$f" ]] || continue
  replace_in_file "$f" "newsium_set_updated_at" "xyzo_set_updated_at"
done

# ── 5. FDW SERVER AND DATABASE NAMES ───────────────────────────────
echo ""
echo "── 5. FDW: newsium_cities_server → xyzo_cities_server ──"

FDW_FILES=(
  api/cities_bootstrap.sql
  api/cities_schema.sql
  api/cities_bootstrap_prereqs.sql
  worker/cities_cli.py
  worker/load_cities.py
  worker/build_cities_db.py
  worker/migrate_cities.py
  scripts/tests/test-db-schema.sh
)

for f in "${FDW_FILES[@]}"; do
  [[ -f "$f" ]] || continue
  replace_in_file "$f" "newsium_cities_server" "xyzo_cities_server"
  replace_in_file "$f" "newsium_cities" "xyzo_cities"
done

# ── 6. USER-AGENT STRINGS ──────────────────────────────────────────
echo ""
echo "── 6. User-Agent strings ──"
replace_in_file "worker/fetch.py" "xyzo-fetcher" "xyzo-fetcher"  # already renamed
replace_in_file "worker/geocode.py" "xyzo-fetcher" "xyzo-fetcher"

# ── 7. DOCUMENTATION ───────────────────────────────────────────────
echo ""
echo "── 7. Documentation ──"

for f in README.md AGENTS.md docs/superpowers/specs/*.md docs/superpowers/plans/*.md; do
  [[ -f "$f" ]] || continue
  replace_in_file "$f" "NEWSIUM_" "XYZO_"
  replace_in_file "$f" "newsium_app" "xyzo_app"
  replace_in_file "$f" "newsium_cities" "xyzo_cities"
  replace_in_file "$f" "newsium_set_updated_at" "xyzo_set_updated_at"
done

# ── 8. CREATE DB MIGRATION ─────────────────────────────────────────
echo ""
echo "── 8. Creating DB migration ──"

MIGRATION_FILE="api/migrations/2026-08-29-rename-newsium-to-xyzo.sql"

if [[ "$DRY_RUN" != "--dry-run" ]]; then
  cat > "$MIGRATION_FILE" << 'MIGRATION'
-- Rename newsium → xyzo: database user, function, and FDW objects
-- Run this migration AFTER updating all code and .env files

BEGIN;

-- 1. Rename the function
ALTER FUNCTION IF EXISTS newsium_set_updated_at() RENAME TO xyzo_set_updated_at;

-- 2. Rename the database user/role
-- NOTE: This requires no active connections using the old role
ALTER ROLE IF EXISTS newsium_app RENAME TO xyzo_app;

-- 3. Update the password for the new role
ALTER ROLE xyzo_app WITH PASSWORD 'CHANGE_ME';

-- 4. Rename the cities database (requires no active connections)
-- NOTE: This must be run outside a transaction block
-- ALTER DATABASE IF EXISTS newsium_cities RENAME TO xyzo_cities;

-- 5. Update FDW server name
ALTER SERVER IF EXISTS newsium_cities_server RENAME TO xyzo_cities_server;

-- 6. Grant permissions to new role
GRANT SELECT ON ALL TABLES IN SCHEMA public TO xyzo_app;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO xyzo_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO xyzo_app;

COMMIT;

-- Post-migration steps (run manually):
-- 1. Update .env files with new credentials
-- 2. Restart all services: systemctl restart xyzo-api xyzo-fetcher xyzo-fast-fetcher
-- 3. Verify: SELECT rolname FROM pg_roles WHERE rolname = 'xyzo_app';
MIGRATION
  echo "  Created: $MIGRATION_FILE"
else
  echo "  Would create: $MIGRATION_FILE"
fi

# ── SUMMARY ─────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "  DRY RUN COMPLETE"
  echo "  Files to update: $UPDATED"
  echo ""
  echo "  Run without --dry-run to apply changes."
else
  echo "  DEEP RENAME COMPLETE"
  echo "  Files updated: $UPDATED"
  echo ""
  echo "  NEXT STEPS:"
  echo "  1. Update .env files with new credentials"
  echo "  2. Run DB migration: psql -U xyzo_app -d xyzo -f $MIGRATION_FILE"
  echo "  3. Restart services: systemctl restart xyzo-api"
  echo "  4. Verify: curl http://localhost:3008/api/health"
fi
echo "═══════════════════════════════════════════════════════════════"
