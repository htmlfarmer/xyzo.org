# ── xyzo test library ─────────────────────────────────────────────
# Sourced by every test-*.sh script. Provides:
#   - Color output (PASS/FAIL/SKIP)
#   - Assertion helpers that increment counters and exit non-zero on
#     the first hard failure of a given group
#   - API helpers (api_get, api_post)
#
# Usage at the top of a test script:
#   SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
#   # shellcheck source=./lib.sh
#   source "$SCRIPT_DIR/lib.sh"
#   start_group "My test group"
#   assert_eq "1" "1" "one equals one"
#   end_group
#
# All tests are designed to be idempotent — running them twice yields
# the same result. They don't mutate the DB or worker state in a way
# that would change a subsequent run.

# Terminal colors (skip if not a TTY).
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' BOLD='' RESET=''
fi

# Counters for the active group.
_PASS=0
_FAIL=0
_SKIP=0
_GROUP=""

# API endpoint override — tests should set XYZO_API for non-local runs.
: "${XYZO_API:=http://localhost:3008}"
: "${XYZO_DB_DSN:=postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo}"
: "${XYZO_WORKDIR:=/var/www/vhosts/xyzo.org}"

# ── Group lifecycle ──────────────────────────────────────────────────
start_group() {
  _GROUP="$1"
  _PASS=0; _FAIL=0; _SKIP=0
  echo ""
  echo -e "${BOLD}${BLUE}═══ $_GROUP ═══${RESET}"
}

end_group() {
  local total=$((_PASS + _FAIL + _SKIP))
  if [ "$_FAIL" -eq 0 ]; then
    echo -e "${GREEN}✓ $_GROUP${RESET}: $_PASS passed, $_SKIP skipped"
    return 0
  fi
  echo -e "${RED}✗ $_GROUP${RESET}: $_FAIL failed, $_PASS passed, $_SKIP skipped"
  return 1
}

# ── Assertions ───────────────────────────────────────────────────────
pass() {
  _PASS=$((_PASS + 1))
  echo -e "  ${GREEN}✓${RESET} $1"
}

fail() {
  _FAIL=$((_FAIL + 1))
  echo -e "  ${RED}✗${RESET} $1"
  if [ -n "${2:-}" ]; then
    echo -e "    ${RED}$2${RESET}"
  fi
}

skip() {
  _SKIP=$((_SKIP + 1))
  echo -e "  ${YELLOW}○${RESET} $1"
}

assert_eq() {
  local expected="$1" actual="$2" label="${3:-assert_eq}"
  if [ "$expected" = "$actual" ]; then
    pass "$label"
  else
    fail "$label" "expected: $expected, got: $actual"
  fi
}

assert_neq() {
  local expected="$1" actual="$2" label="${3:-assert_neq}"
  if [ "$expected" != "$actual" ]; then
    pass "$label"
  else
    fail "$label" "expected ≠ $expected, got: $actual"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" label="${3:-assert_contains}"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    pass "$label"
  else
    fail "$label" "expected to contain: $needle"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="${3:-assert_not_contains}"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    fail "$label" "should NOT contain: $needle"
  else
    pass "$label"
  fi
}

assert_true() {
  if [ "$1" = "true" ] || [ "$1" = "0" ]; then
    pass "${2:-assert_true}"
  else
    fail "${2:-assert_true}" "value: $1"
  fi
}

# ── HTTP helpers ─────────────────────────────────────────────────────
api_get() {
  local path="$1"
  curl -sS -m 10 -w "\n__HTTP_STATUS__:%{http_code}" "$XYZO_API$path" 2>&1
}

api_post() {
  local path="$1" body="$2" extra_header="${3:-}"
  if [ -n "$extra_header" ]; then
    curl -sS -m 30 -w "\n__HTTP_STATUS__:%{http_code}" \
      -H "Content-Type: application/json" \
      -H "$extra_header" \
      -X POST -d "$body" "$XYZO_API$path" 2>&1
  else
    curl -sS -m 30 -w "\n__HTTP_STATUS__:%{http_code}" \
      -H "Content-Type: application/json" \
      -X POST -d "$body" "$XYZO_API$path" 2>&1
  fi
}

# Split the curl output into body and status code.
# Usage: out="$(api_get /api/foo)"
# body="$(extract_body "$out")"
# status="$(extract_status "$out")"
extract_body() {
  printf '%s' "$1" | sed '$d'
}
extract_status() {
  printf '%s' "$1" | tail -1 | sed 's/.*__HTTP_STATUS__://'
}

require_status() {
  local status="$1" expected="$2" label="$3"
  assert_eq "$expected" "$status" "$label (status)"
}

# Run a Python command inside the project root so the `worker` package
# is importable.
runpy() {
  (cd "$XYZO_WORKDIR" && python3 -c "$1" 2>&1)
}

runpy_module() {
  (cd "$XYZO_WORKDIR" && python3 -m "$@" 2>&1)
}

# Run psql with the project's DSN.
runpsql() {
  psql "$XYZO_DB_DSN" -t -A -c "$1" 2>&1
}

# Hash admin key from env (default admin key from the auth setup).
# If XYZO_ADMIN_KEY isn't set, the admin-required tests skip.
ADMIN_KEY="${XYZO_ADMIN_KEY:-}"
admin_auth_header() {
  if [ -n "$ADMIN_KEY" ]; then
    printf 'X-Admin-Key: %s' "$ADMIN_KEY"
  fi
}

# ── Pre-flight ───────────────────────────────────────────────────────
# Verify the API is up before running anything that needs it. If it
# isn't, every test in the group skips (so CI doesn't fail spuriously
# when the API is intentionally down).
ensure_api_up() {
  local out status
  out="$(api_get /api/health 2>/dev/null || true)"
  status="$(extract_status "$out" 2>/dev/null || echo "000")"
  if [ "$status" != "200" ]; then
    echo -e "${YELLOW}API not reachable at $XYZO_API (status=$status) — group will skip${RESET}"
    return 1
  fi
  return 0
}