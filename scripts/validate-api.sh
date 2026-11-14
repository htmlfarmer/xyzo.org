#!/usr/bin/env bash
# validate-api.sh — Pre-deploy validation for the Xyzo API.
# Catches missing exports, broken imports, and TypeScript errors
# BEFORE they crash the production server.
#
# Usage:
#   ./scripts/validate-api.sh          # full validation
#   ./scripts/validate-api.sh --quick  # syntax check only (fast)
#
# Exit codes:
#   0 = all checks passed
#   1 = validation failed (do NOT deploy)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$SCRIPT_DIR/../api"
API_DIR="$(cd "$API_DIR" && pwd)"
QUICK="${1:-}"
ERRORS=0

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

bold "── Xyzo API Pre-Deploy Validation ──"

# ── 1. Check that every import in routes/ resolves to an actual export ──
bold "[1/8] Checking route imports against validate.ts exports..."

VALIDATE_FILE="$API_DIR/src/validate.ts"
if [[ ! -f "$VALIDATE_FILE" ]]; then
  red "  FAIL: validate.ts not found at $VALIDATE_FILE"
  ERRORS=$((ERRORS + 1))
else
  # Extract all named imports from route files
  MISSING=0
  for route_file in "$API_DIR"/src/routes/*.ts; do
    # Get imported names from validate
    imports=$(grep -oP 'import\s*\{([^}]+)\}\s*from\s*"\.\./validate"' "$route_file" 2>/dev/null \
      | sed 's/import\s*{//;s/}\s*from.*//' \
      | tr ',' '\n' \
      | sed 's/^ *//;s/ *$//' \
      | grep -v '^$' || true)

    for name in $imports; do
      if ! grep -qE "export\s+(const|type|enum|interface)\s+${name}\b" "$VALIDATE_FILE"; then
        red "  MISSING: $name — imported in $(basename "$route_file") but not exported from validate.ts"
        MISSING=$((MISSING + 1))
      fi
    done
  done

  if [[ $MISSING -gt 0 ]]; then
    red "  FAIL: $MISSING missing export(s) in validate.ts"
    ERRORS=$((ERRORS + 1))
  else
    green "  OK: All route imports resolve"
  fi
fi

# ── 2. Check that every route file is registered in server.ts ──
bold "[2/8] Checking route registration in server.ts..."

SERVER_FILE="$API_DIR/src/server.ts"
if [[ ! -f "$SERVER_FILE" ]]; then
  red "  FAIL: server.ts not found"
  ERRORS=$((ERRORS + 1))
else
  UNREGISTERED=0
  for route_file in "$API_DIR"/src/routes/*.ts; do
    basename_noext=$(basename "$route_file" .ts)
    # Check if the route is imported and used in server.ts
    if ! grep -q "$basename_noext" "$SERVER_FILE" 2>/dev/null; then
      red "  WARNING: $(basename "$route_file") exists but may not be registered in server.ts"
      UNREGISTERED=$((UNREGISTERED + 1))
    fi
  done
  if [[ $UNREGISTERED -eq 0 ]]; then
    green "  OK: All route files appear registered"
  fi
fi

# ── 3. Bun syntax check (fast — no DB needed) ──
bold "[3/8] Bun syntax check..."

if command -v bun &>/dev/null; then
  # Use bun's built-in typecheck if available, otherwise just parse
  if [[ "$QUICK" == "--quick" ]]; then
    # Quick mode: just check if the entry point parses without errors
    if bun build --target=bun "$API_DIR/src/server.ts" --outdir=/tmp/xyzo-validate-$$ 2>&1 | tail -5; then
      green "  OK: Entry point parses cleanly"
      rm -rf /tmp/xyzo-validate-$$
    else
      red "  FAIL: Entry point has syntax/build errors"
      ERRORS=$((ERRORS + 1))
      rm -rf /tmp/xyzo-validate-$$
    fi
  else
    # Full mode: try to import the module (will fail on DB but that's fine)
    OUTPUT=$(cd "$API_DIR" && timeout 10 bun -e "
      try {
        await import('./src/validate.ts');
        console.log('VALIDATE_OK');
      } catch (e) {
        console.error('VALIDATE_FAIL:', e.message);
        process.exit(1);
      }
    " 2>&1 || true)

    if echo "$OUTPUT" | grep -q "VALIDATE_OK"; then
      green "  OK: validate.ts compiles and all exports resolve"
    else
      red "  FAIL: validate.ts has errors"
      echo "$OUTPUT" | grep -i "fail\|error" | head -5
      ERRORS=$((ERRORS + 1))
    fi
  fi
else
  red "  SKIP: bun not found in PATH"
fi

# ── 4. Check frontend JS syntax ──
bold "[4/8] Checking frontend JS syntax..."

PUBLIC_DIR="$(cd "$SCRIPT_DIR/../public_html" && pwd)"
JS_ERRORS=0
for jsfile in "$PUBLIC_DIR"/*.js; do
  [ -f "$jsfile" ] || continue
  fname=$(basename "$jsfile")
  # Use node --check for syntax validation (fast, no execution)
  if command -v node &>/dev/null; then
    if ! node --check "$jsfile" 2>/dev/null; then
      red "  SYNTAX ERROR: $fname"
      node --check "$jsfile" 2>&1 | head -3
      JS_ERRORS=$((JS_ERRORS + 1))
    fi
  elif command -v bun &>/dev/null; then
    if ! bun build --target=browser "$jsfile" --outdir=/tmp/xyzo-js-check-$$ 2>/dev/null; then
      red "  SYNTAX ERROR: $fname"
      JS_ERRORS=$((JS_ERRORS + 1))
    fi
    rm -rf /tmp/xyzo-js-check-$$
  fi
done

if [[ $JS_ERRORS -gt 0 ]]; then
  red "  FAIL: $JS_ERRORS JS file(s) have syntax errors"
  ERRORS=$((ERRORS + 1))
else
  green "  OK: All frontend JS files parse cleanly"
fi

# ── 5. Check for common pitfalls ──
bold "[5/8] Checking for common pitfalls..."

PITFALLS=0

# Check for console.log in production routes (should use structured logging)
LOG_COUNT=$(grep -rn 'console\.log' "$API_DIR/src/routes/" 2>/dev/null | wc -l || echo 0)
if [[ $LOG_COUNT -gt 20 ]]; then
  red "  WARNING: $LOG_COUNT console.log calls in routes (consider structured logging)"
fi

# Check for missing error handling on fetch calls
# Look 8 lines before and after each fetch() call for error handling patterns
UNHANDLED_FETCH=0
while IFS=: read -r file line _; do
  # Check surrounding context (8 lines before + after) for error handling
  start=$((line - 8))
  end=$((line + 8))
  [[ $start -lt 1 ]] && start=1
  context=$(sed -n "${start},${end}p" "$file" 2>/dev/null)
  if ! echo "$context" | grep -qE '\.catch|try|signal|AbortController|if.*!.*ok|if.*!.*res|\.ok'; then
    UNHANDLED_FETCH=$((UNHANDLED_FETCH + 1))
  fi
done < <(grep -rn 'fetch(' "$API_DIR/src/" 2>/dev/null | grep -v '^\s*//')
if [[ $UNHANDLED_FETCH -gt 0 ]]; then
  red "  WARNING: $UNHANDLED_FETCH fetch() calls without visible error handling"
fi

if [[ $PITFALLS -eq 0 ]]; then
  green "  OK: No critical pitfalls found"
fi

# ── 6. API Timing Regression Tests ──
# NOT part of --quick: this step measures the LIVE API and can take
# minutes on a loaded box (the world-view /api/pins/map alone took 55 s
# while the disk was saturated).
#
# It used to run in --quick mode, which made the xyzo-api unit's
# ExecStartPre take 84 s — so every restart (the api_watchdog was
# restarting the API every couple of minutes) was an 84-second outage in
# which Caddy answered 502 and the browser console filled up with
# /api/feed/live/stream and /api/feed/links failures.
if [[ "$QUICK" == "--quick" ]]; then
  bold "[6/8] Skipping API response-time checks (--quick)..."
else
bold "[6/8] Checking API response times..."

TIMING_ERRORS=0
API_PORT="${XYZO_PORT:-3008}"
API_BASE="http://localhost:${API_PORT}"

# Endpoint → max acceptable ms
declare -A TIMING_TESTS=(
  ["/api/health"]=100
  ["/api/pins/stats"]=200
  ["/api/pins/map?bbox=-180,-85,180,85&limit=100"]=1000
  ["/api/pins?q=science&limit=10"]=500
  ["/api/geocode?q=chicago"]=500
  ["/api/locations/search?q=chicago&limit=5"]=500
  ["/api/cities/search?q=london&limit=5"]=200
)

for endpoint in "${!TIMING_TESTS[@]}"; do
  max_ms="${TIMING_TESTS[$endpoint]}"
  url="${API_BASE}${endpoint}"
  # Measure response time using curl
  timing=$(curl -s -o /dev/null -w "%{time_total}" "$url" 2>/dev/null || echo "99")
  ms=$(echo "$timing * 1000" | bc 2>/dev/null | cut -d. -f1 || echo "9999")
  if [[ "$ms" -gt "$max_ms" ]]; then
    red "  SLOW: ${endpoint} took ${ms}ms (max: ${max_ms}ms)"
    TIMING_ERRORS=$((TIMING_ERRORS + 1))
  else
    green "  OK: ${endpoint} ${ms}ms (max: ${max_ms}ms)"
  fi
done

# FTS-specific timing test: search should be <50ms with GIN index
fts_timing=$(curl -s -o /dev/null -w "%{time_total}" "${API_BASE}/api/pins?q=chicago&limit=10" 2>/dev/null || echo "99")
fts_ms=$(echo "$fts_timing * 1000" | bc 2>/dev/null | cut -d. -f1 || echo "9999")
if [[ "$fts_ms" -gt 200 ]]; then
  red "  SLOW: FTS search /api/pins?q=chicago took ${fts_ms}ms (should be <200ms with GIN index)"
  TIMING_ERRORS=$((TIMING_ERRORS + 1))
else
  green "  OK: FTS search /api/pins?q=chicago ${fts_ms}ms"
fi

# Enriched endpoint: should return in <50ms for known articles
enriched_timing=$(curl -s -o /dev/null -w "%{time_total}" "${API_BASE}/api/pins/1/enriched" 2>/dev/null || echo "99")
enriched_ms=$(echo "$enriched_timing * 1000" | bc 2>/dev/null | cut -d. -f1 || echo "9999")
if [[ "$enriched_ms" -gt 200 ]]; then
  red "  SLOW: /api/pins/1/enriched took ${enriched_ms}ms (should be <200ms)"
  TIMING_ERRORS=$((TIMING_ERRORS + 1))
else
  green "  OK: /api/pins/1/enriched ${enriched_ms}ms"
fi

if [[ $TIMING_ERRORS -gt 0 ]]; then
  red "  WARNING: $TIMING_ERRORS endpoint(s) exceeded timing thresholds"
fi
fi  # end of the non-quick timing block

# ── 7. Playwright Graphical E2E UI Tests ──
if [[ "$QUICK" != "--quick" ]]; then
  bold "[7/8] Running Playwright Graphical E2E UI Tests..."
  if "$SCRIPT_DIR/validate-ui.sh"; then
    green "  OK: All E2E UI tests passed"
  else
    red "  FAIL: E2E UI tests detected errors"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ── 8. Frontend /api/ paths must resolve to registered routes ────────
# T-13 found 13 frontend fetch() calls targeting routes that didn't
# exist. This guard diffs every /api/... literal in public_html/ against
# the routes actually registered in api/src/ so a similar drift can't
# slip back in. Cheap (~0.5s), runs in --quick too.
bold "[8/8] Checking frontend /api/ paths against registered routes..."
if "$SCRIPT_DIR/check-api-paths.sh"; then
  green "  OK: No silent 404 paths detected"
else
  red "  FAIL: Some frontend /api/ paths are not registered"
  ERRORS=$((ERRORS + 1))
fi

# ── Summary ──
echo ""
if [[ $ERRORS -gt 0 ]]; then
  red "═══ VALIDATION FAILED ($ERRORS error(s)) — DO NOT DEPLOY ═══"
  exit 1
else
  green "═══ ALL CHECKS PASSED — safe to deploy ═══"
  exit 0
fi
