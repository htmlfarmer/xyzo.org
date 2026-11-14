#!/usr/bin/env bash
# ── track-quality.sh ─────────────────────────────────────────────────────────
# Runs all test suites and logs results to data/quality/history.jsonl
# for trend analysis over time.
#
# Usage:
#   ./scripts/track-quality.sh              # full run
#   ./scripts/track-quality.sh --quick      # frontend + API only
#   ./scripts/track-quality.sh --report     # show last 30 entries
#
# Each line in history.jsonl is a JSON object:
# { "ts": "...", "suite": "...", "passed": N, "failed": N, "total": N,
#   "duration_ms": N, "git_sha": "...", "details": {...} }
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="$(cd "$SCRIPT_DIR/.." && pwd)"
QUALITY_DIR="$WORKDIR/data/quality"
HISTORY="$QUALITY_DIR/history.jsonl"
REPORT_MODE="${1:-}"
mkdir -p "$QUALITY_DIR"

# ── Helpers ──────────────────────────────────────────────────────────────────
ts_now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
git_sha() { git -C "$WORKDIR" rev-parse --short HEAD 2>/dev/null || echo "unknown"; }

log_result() {
  # $1=suite $2=passed $3=failed $4=duration_ms $5=details_json
  local suite="$1" passed="$2" failed="$3" dur="$4" details="${5:-{}}"
  local total=$((passed + failed))
  local sha git_info
  sha=$(git_sha)
  git_info="\"git_sha\":\"$sha\""
  printf '{"ts":"%s","suite":"%s","passed":%d,"failed":%d,"total":%d,"duration_ms":%d,%s,"details":%s}\n' \
    "$(ts_now)" "$suite" "$passed" "$failed" "$total" "$dur" "$git_info" "$details" \
    >> "$HISTORY"
}

timer_start() { date +%s%3N 2>/dev/null || python3 -c "import time; print(int(time.time()*1000))"; }
timer_ms() {
  local start="$1"
  local now
  now=$(date +%s%3N 2>/dev/null || python3 -c "import time; print(int(time.time()*1000))")
  echo $((now - start))
}

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

# ── Report mode ──────────────────────────────────────────────────────────────
if [[ "$REPORT_MODE" == "--report" ]]; then
  if [[ ! -f "$HISTORY" ]]; then
    echo "No quality history found. Run track-quality.sh first."
    exit 1
  fi
  echo ""
  bold "═══ Quality Trend Report (last 30 runs) ═══"
  echo ""
  printf "%-20s %-16s %-8s %-8s %-8s %-8s\n" "TIMESTAMP" "SUITE" "PASS" "FAIL" "TOTAL" "MS"
  printf "%-20s %-16s %-8s %-8s %-8s %-8s\n" "────────────────────" "────────────────" "────────" "────────" "────────" "────────"
  tail -30 "$HISTORY" | while IFS= read -r line; do
    ts=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['ts'][:19])" 2>/dev/null)
    suite=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['suite'])" 2>/dev/null)
    passed=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['passed'])" 2>/dev/null)
    failed=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['failed'])" 2>/dev/null)
    total=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['total'])" 2>/dev/null)
    ms=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['duration_ms'])" 2>/dev/null)
    if [[ "$failed" -gt 0 ]]; then
      color="\033[31m"
    else
      color="\033[32m"
    fi
    printf "${color}%-20s %-16s %-8s %-8s %-8s %-8s\033[0m\n" "$ts" "$suite" "$passed" "$failed" "$total" "$ms"
  done

  # Show trend
  echo ""
  bold "═══ Trends ═══"
  total_runs=$(wc -l < "$HISTORY")
  last_failures=$(tail -5 "$HISTORY" | python3 -c "
import sys, json
fails = [json.loads(l)['failed'] for l in sys.stdin if l.strip()]
avg = sum(fails) / max(len(fails),1)
print(f'{avg:.1f}')
" 2>/dev/null)
  last_duration=$(tail -5 "$HISTORY" | python3 -c "
import sys, json
durs = [json.loads(l)['duration_ms'] for l in sys.stdin if l.strip()]
avg = sum(durs) / max(len(durs),1)
print(f'{avg:.0f}')
" 2>/dev/null)
  echo "Total runs logged: $total_runs"
  echo "Last 5 avg failures: $last_failures"
  echo "Last 5 avg duration: ${last_duration}ms"
  echo ""
  exit 0
fi

bold "═══ Xyzo Quality Tracker ═══"
echo "Logging to: $HISTORY"
echo ""

TOTAL_SUITES=0
TOTAL_PASSED=0
TOTAL_FAILED=0

# ── 1. Frontend Bun tests ────────────────────────────────────────────────────
bold "[1/5] Frontend tests (bun)..."
START=$(timer_start)
if command -v bun &>/dev/null; then
  OUTPUT=$(cd "$WORKDIR" && bun test public_html/tests/*.bun.test.js 2>&1 || true)
  PASSED=$(echo "$OUTPUT" | grep -oP '\d+(?= pass)' | tail -1 || echo 0)
  FAILED=$(echo "$OUTPUT" | grep -oP '\d+(?= fail)' | tail -1 || echo 0)
  DUR=$(timer_ms "$START")
  PASSED=${PASSED:-0}; FAILED=${FAILED:-0}
  log_result "frontend-bun" "$PASSED" "$FAILED" "$DUR"
  TOTAL_SUITES=$((TOTAL_SUITES + 1))
  TOTAL_PASSED=$((TOTAL_PASSED + PASSED))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))
  if [[ "$FAILED" -gt 0 ]]; then
    red "  ✗ $FAILED failed, $PASSED passed (${DUR}ms)"
  else
    green "  ✓ $PASSED passed (${DUR}ms)"
  fi
else
  red "  SKIP: bun not found"
fi

# ── 2. API Bun tests ────────────────────────────────────────────────────────
bold "[2/5] API tests (bun)..."
START=$(timer_start)
if command -v bun &>/dev/null && [[ -d "$WORKDIR/api/tests" ]]; then
  OUTPUT=$(cd "$WORKDIR/api" && bun test tests/*.test.ts 2>&1 || true)
  PASSED=$(echo "$OUTPUT" | grep -oP '\d+(?= pass)' | tail -1 || echo 0)
  FAILED=$(echo "$OUTPUT" | grep -oP '\d+(?= fail)' | tail -1 || echo 0)
  DUR=$(timer_ms "$START")
  PASSED=${PASSED:-0}; FAILED=${FAILED:-0}
  log_result "api-bun" "$PASSED" "$FAILED" "$DUR"
  TOTAL_SUITES=$((TOTAL_SUITES + 1))
  TOTAL_PASSED=$((TOTAL_PASSED + PASSED))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))
  if [[ "$FAILED" -gt 0 ]]; then
    red "  ✗ $FAILED failed, $PASSED passed (${DUR}ms)"
  else
    green "  ✓ $PASSED passed (${DUR}ms)"
  fi
else
  red "  SKIP: bun or api/tests not found"
fi

# ── 3. Worker pytest ────────────────────────────────────────────────────────
bold "[3/5] Worker tests (pytest)..."
START=$(timer_start)
if command -v pytest &>/dev/null && [[ -d "$WORKDIR/worker/tests" ]]; then
  OUTPUT=$(cd "$WORKDIR" && pytest worker/tests/ -v --tb=short 2>&1 || true)
  PASSED=$(echo "$OUTPUT" | grep -oP '\d+(?= passed)' | tail -1 || echo 0)
  FAILED=$(echo "$OUTPUT" | grep -oP '\d+(?= failed)' | tail -1 || echo 0)
  DUR=$(timer_ms "$START")
  PASSED=${PASSED:-0}; FAILED=${FAILED:-0}
  log_result "worker-pytest" "$PASSED" "$FAILED" "$DUR"
  TOTAL_SUITES=$((TOTAL_SUITES + 1))
  TOTAL_PASSED=$((TOTAL_PASSED + PASSED))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))
  if [[ "$FAILED" -gt 0 ]]; then
    red "  ✗ $FAILED failed, $PASSED passed (${DUR}ms)"
  else
    green "  ✓ $PASSED passed (${DUR}ms)"
  fi
else
  red "  SKIP: pytest or worker/tests not found"
fi

# ── 4. Syntax validation ────────────────────────────────────────────────────
bold "[4/5] Syntax validation..."
START=$(timer_start)
SYNTAX_OK=0
SYNTAX_FAIL=0

# Check frontend JS syntax
for f in "$WORKDIR"/public_html/*.js; do
  [ -f "$f" ] || continue
  if command -v node &>/dev/null; then
    if node --check "$f" 2>/dev/null; then
      SYNTAX_OK=$((SYNTAX_OK + 1))
    else
      SYNTAX_FAIL=$((SYNTAX_FAIL + 1))
      red "  SYNTAX: $(basename "$f")"
    fi
  fi
done

# Check Python syntax
for f in "$WORKDIR"/worker/*.py; do
  [ -f "$f" ] || continue
  if python3 -m py_compile "$f" 2>/dev/null; then
    SYNTAX_OK=$((SYNTAX_OK + 1))
  else
    SYNTAX_FAIL=$((SYNTAX_FAIL + 1))
    red "  SYNTAX: $(basename "$f")"
  fi
done

DUR=$(timer_ms "$START")
log_result "syntax" "$SYNTAX_OK" "$SYNTAX_FAIL" "$DUR"
TOTAL_SUITES=$((TOTAL_SUITES + 1))
TOTAL_PASSED=$((TOTAL_PASSED + SYNTAX_OK))
TOTAL_FAILED=$((TOTAL_FAILED + SYNTAX_FAIL))
if [[ "$SYNTAX_FAIL" -gt 0 ]]; then
  red "  ✗ $SYNTAX_FAIL failed, $SYNTAX_OK passed (${DUR}ms)"
else
  green "  ✓ $SYNTAX_OK files clean (${DUR}ms)"
fi

# ── 5. API timing regression ────────────────────────────────────────────────
bold "[5/5] API timing checks..."
START=$(timer_start)
API_PORT="${XYZO_PORT:-3008}"
API_BASE="http://localhost:${API_PORT}"
TIMING_PASS=0
TIMING_FAIL=0

declare -A TIMING_THRESHOLDS=(
  ["/api/health"]=100
  ["/api/pins/stats"]=200
)

for endpoint in "${!TIMING_THRESHOLDS[@]}"; do
  max_ms="${TIMING_THRESHOLDS[$endpoint]}"
  timing=$(curl -s -o /dev/null -w "%{time_total}" "${API_BASE}${endpoint}" 2>/dev/null || echo "99")
  ms=$(echo "$timing * 1000" | bc 2>/dev/null | cut -d. -f1 || echo 9999)
  if [[ "$ms" -le "$max_ms" ]]; then
    TIMING_PASS=$((TIMING_PASS + 1))
  else
    TIMING_FAIL=$((TIMING_FAIL + 1))
    red "  SLOW: ${endpoint} ${ms}ms (max ${max_ms}ms)"
  fi
done

DUR=$(timer_ms "$START")
log_result "timing" "$TIMING_PASS" "$TIMING_FAIL" "$DUR"
TOTAL_SUITES=$((TOTAL_SUITES + 1))
TOTAL_PASSED=$((TOTAL_PASSED + TIMING_PASS))
TOTAL_FAILED=$((TOTAL_FAILED + TIMING_FAIL))
if [[ "$TIMING_FAIL" -gt 0 ]]; then
  red "  ✗ $TIMING_FAIL slow, $TIMING_PASS ok (${DUR}ms)"
else
  green "  ✓ $TIMING_PASS endpoints within threshold (${DUR}ms)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
bold "═══ Summary ═══"
TOTAL=$((TOTAL_PASSED + TOTAL_FAILED))
if [[ "$TOTAL_FAILED" -gt 0 ]]; then
  red "  $TOTAL_FAILED failures across $TOTAL_SUITES suites ($TOTAL_PASSED/$TOTAL passed)"
  echo "  Results logged to $HISTORY"
  exit 1
else
  green "  All $TOTAL_PASSED checks passed across $TOTAL_SUITES suites"
  echo "  Results logged to $HISTORY"
  exit 0
fi
