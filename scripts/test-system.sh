#!/usr/bin/env bash
# ── xyzo system test runner ────────────────────────────────────
# Runs every test group and reports pass/fail counts. Designed to be
# invoked after any change to validate the system still works end-to-
# end, with or without AI.
#
# Usage:
#   scripts/test-system.sh              # run everything
#   scripts/test-system.sh --api        # only API tests
#   scripts/test-system.sh --workers    # only worker tests
#   scripts/test-system.sh --schema     # only DB schema tests
#   scripts/test-system.sh --frontend   # only frontend tests
#   scripts/test-system.sh --pytest     # only pytest unit tests
#   XYZO_ADMIN_KEY=... scripts/test-system.sh --all  # include admin tests
#
# Exit code is non-zero if any group fails.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TESTS_DIR="$SCRIPT_DIR/tests"

# Default to running everything.
RUN_API=1
RUN_WORKERS=1
RUN_SCHEMA=1
RUN_FRONTEND=1
RUN_PYTEST=1

while [ $# -gt 0 ]; do
  case "$1" in
    --api)      RUN_API=1;      RUN_WORKERS=0; RUN_SCHEMA=0; RUN_FRONTEND=0; RUN_PYTEST=0 ;;
    --workers)  RUN_API=0;      RUN_WORKERS=1; RUN_SCHEMA=0; RUN_FRONTEND=0; RUN_PYTEST=0 ;;
    --schema)   RUN_API=0;      RUN_WORKERS=0; RUN_SCHEMA=1; RUN_FRONTEND=0; RUN_PYTEST=0 ;;
    --frontend) RUN_API=0;      RUN_WORKERS=0; RUN_SCHEMA=0; RUN_FRONTEND=1; RUN_PYTEST=0 ;;
    --pytest)   RUN_API=0;      RUN_WORKERS=0; RUN_SCHEMA=0; RUN_FRONTEND=0; RUN_PYTEST=1 ;;
    --all)      RUN_API=1; RUN_WORKERS=1; RUN_SCHEMA=1; RUN_FRONTEND=1; RUN_PYTEST=1 ;;
    -h|--help)
      sed -n '3,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
  esac
  shift
done

# Ensure the API is up — many tests depend on it. If the operator
# asked to skip API tests we don't auto-start.
if [ "$RUN_API" = "1" ] || [ "$RUN_WORKERS" = "1" ]; then
  if ! curl -sS -m 5 "http://localhost:3008/api/health" > /dev/null 2>&1; then
    echo -e "\033[1;33m⚠ API not reachable on localhost:3008 — starting tests anyway (groups will skip).\033[0m"
  fi
fi

export XYZO_WORKDIR="$WORKDIR"
export XYZO_DB_DSN="${XYZO_DB_DSN:-postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo}"
export XYZO_API="${XYZO_API:-http://localhost:3008}"

FAILED=0
PASSED_GROUPS=0

run_group() {
  local label="$1" script="$2"
  echo ""
  echo -e "\033[1;34m═══════════════════════════════════════════════════════════\033[0m"
  echo -e "\033[1;34m  $label\033[0m"
  echo -e "\033[1;34m═══════════════════════════════════════════════════════════\033[0m"
  if bash "$script";  then
    PASSED_GROUPS=$((PASSED_GROUPS + 1))
  else
    FAILED=$((FAILED + 1))
  fi
}

if [ "$RUN_API" = "1" ]; then
  run_group "API endpoints" "$TESTS_DIR/test-api-endpoints.sh"
fi
if [ "$RUN_WORKERS" = "1" ]; then
  run_group "Worker resilience" "$TESTS_DIR/test-worker-resilience.sh"
  run_group "Article validation" "$TESTS_DIR/test-article-validation.sh"
  run_group "User request auto-resolution" "$TESTS_DIR/test-auto-resolution.sh"
fi
if [ "$RUN_SCHEMA" = "1" ]; then
  run_group "DB schema" "$TESTS_DIR/test-db-schema.sh"
  run_group "PostGIS & SQL queries" "$TESTS_DIR/test-sql-queries.sh"
fi
if [ "$RUN_FRONTEND" = "1" ]; then
  run_group "Frontend" "$TESTS_DIR/test-frontend.sh"
fi
if [ "$RUN_PYTEST" = "1" ]; then
  echo ""
  echo -e "\033[1;34m═══════════════════════════════════════════════════════════\033[0m"
  echo -e "\033[1;34m  Python unit tests (pytest)\033[0m"
  echo -e "\033[1;34m═══════════════════════════════════════════════════════════\033[0m"
  if (cd "$WORKDIR" && pytest tests/ -v --tb=short 2>&1 | tail -60); then
    PASSED_GROUPS=$((PASSED_GROUPS + 1))
  else
    FAILED=$((FAILED + 1))
  fi
fi

echo ""
echo -e "\033[1;34m═══════════════════════════════════════════════════════════\033[0m"
if [ "$FAILED" = "0" ]; then
  echo -e "\033[1;32m  ✓ All $PASSED_GROUPS test groups passed.\033[0m"
  echo -e "\033[1;34m═══════════════════════════════════════════════════════════\033[0m"
  exit 0
else
  echo -e "\033[1;31m  ✗ $FAILED test group(s) failed, $PASSED_GROUPS passed.\033[0m"
  echo -e "\033[1;34m═══════════════════════════════════════════════════════════\033[0m"
  exit 1
fi