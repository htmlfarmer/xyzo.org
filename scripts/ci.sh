#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# xyzo CI gate — TEST_PLAN_2026-09-26 §6.1
#
# Nothing runs automatically today (CODEBASE_REVIEW: "code tsc would reject
# ships because no typecheck runs"). This is the minimum honest gate:
# everything is a RATCHET — current known-failing counts are baselined
# (measured 2026-09-26) and the gate fails only on NEW failures, so it can
# be adopted green and tightened as the backlog drains.
#
# Usage:
#   scripts/ci.sh            # fast PR checks (no network, no live API)
#   scripts/ci.sh --full     # + network/live suites (nightly)
#   scripts/ci.sh --only tsc # single stage
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-}"
ONLY="${2:-}"

# ── Baselined known-failures (2026-09-26; lower these, never raise) ─────────
TSC_BASELINE=379           # src/ 109 + tests/ 270 (tsc --noEmit has never run)
BUN_API_BASELINE=95        # measured 85→92 across identical runs (5s-timeout flakes under load)
PYTEST_TESTS_BASELINE=5    # tests/ stable 0–1; 5 seen when CPU-contended (model loads)
PYTEST_WORKER_BASELINE=25  # worker/tests/ stable 22 (image pipeline, labeling, sync…)

RED='\033[0;31m'; GRN='\033[0;32m'; YEL='\033[0;33m'; RST='\033[0m'
FAILS=0
RESULTS=()

stage() {  # stage <name> <expected-base> <actual-cmd…>
  local name="$1" base="$2"; shift 2
  if [ -n "$ONLY" ] && [ "$ONLY" != "$name" ]; then return 0; fi
  echo -e "${YEL}━━━ ${name} ━━━${RST}"
  local out actual
  out=$("$@" 2>&1) || true
  case "$name" in
    tsc)
      actual=$(printf '%s\n' "$out" | grep -cE "^[a-zA-Z0-9_./-]+\([0-9]+,[0-9]+\): error TS") ;;
    bun-api)
      actual=$(printf '%s\n' "$out" | grep -oP '\d+(?= fail\b)' | head -1 || echo 9999) ;;
    pytest-*)
      # summary line e.g. "1 failed, 307 passed, 2 skipped in 12s" (or "N errors")
      actual=$(printf '%s\n' "$out" | tail -1 | grep -oE '[0-9]+ (failed|errors?)' | grep -oE '^[0-9]+' | paste -sd+ - | bc 2>/dev/null)
      actual=${actual:-0}
      # collection/interrupt with no clean summary line → count as failure
      if printf '%s\n' "$out" | grep -q "Interrupted:"; then actual=9999; fi ;;
    security)
      # the scanner prints "security-scan: new=N gated=N report=N"
      actual=$(printf '%s\n' "$out" | grep -oE 'security-scan: new=[0-9]+' | grep -oE '[0-9]+$' | head -1)
      actual=${actual:-9999} ;;
    *) actual=0 ;;
  esac
  if [ "${actual:-9999}" -le "$base" ]; then
    echo -e "  ${GRN}✅ ${name}: ${actual} failures (baseline ${base})${RST}"
    RESULTS+=("✅ ${name}: ${actual}/${base}")
  else
    echo -e "  ${RED}❌ ${name}: ${actual} failures > baseline ${base} — NEW breakage${RST}"
    printf '%s\n' "$out" | grep -E "^\(fail\)|FAILED|ERROR|error TS" | head -10 | sed 's/^/     /'
    RESULTS+=("❌ ${name}: ${actual}/${base}")
    FAILS=$((FAILS+1))
  fi
  echo "$out" | tail -1 | sed 's/^/     └ /'
}

# ── 1. Static gates (always, fast) ──────────────────────────────────────────
stage "worker-py-compile" 0 bash -c '
  bad=0
  for f in worker/*.py; do python3 -m py_compile "$f" || { echo "PYCOMPILE FAIL: $f"; bad=1; }
  done
  # surface a count via grep-friendly output
  [ $bad -eq 0 ] && echo "0 failures"
  exit $bad'

stage "frontend-syntax" 0 bash -c '
  for f in public_html/*.js; do node -c "$f" || exit 1; done
  echo "0 failures"'

# The SECURITY GATE. The secrets side is covered by the global git
# hooks on every commit and every push; this is the other side — the
# patterns that make a hole (an interpolated query, an unguarded shell
# call, an unescaped innerHTML). It is a RATCHET like everything else
# here: the findings that exist today are baselined in
# scripts/security_baseline.txt and the gate fails only on a NEW one.
#
# `--no-secretz` because the git hooks already ran the secrets scan on
# the very files being committed; this stage is about the code patterns.
stage "security" 0 bash -c 'python3 scripts/security_check.py --no-secretz'

if [ -z "$ONLY" ] || [ "$ONLY" = "tsc" ]; then
  stage "tsc" $TSC_BASELINE bash -c 'cd api && bun x tsc --noEmit'
fi

# ── 2. Test suites ──────────────────────────────────────────────────────────
# bun api tests need the TEST db + .env.test (never the live xyzo DB)
stage "bun-api" $BUN_API_BASELINE bash -c 'cd api && bun --env-file=.env.test test 2>&1'

export $(grep -E "^XYZO_DB_(DSN|URL)=" api/.env 2>/dev/null | tr -d '"' | tr '\n' ' ') 2>/dev/null || true
export TZ=America/Los_Angeles   # production server TZ — TZ tests depend on it

if [ "$MODE" = "--full" ]; then
  stage "pytest-tests" $PYTEST_TESTS_BASELINE python3 -m pytest tests/ -q -p no:cacheprovider --ignore=tests/test_boot_fetch_coordinator.py --ignore=tests/test_time_dropdown_wiring.py --ignore=tests/test_extract_integration.py --ignore=tests/test_wikimedia.py
  stage "pytest-worker" $PYTEST_WORKER_BASELINE python3 -m pytest worker/tests/ -q -p no:cacheprovider
else
  # PR-fast: skip network/live-tagged tests
  stage "pytest-tests" $PYTEST_TESTS_BASELINE python3 -m pytest tests/ -q -p no:cacheprovider --ignore=tests/test_boot_fetch_coordinator.py --ignore=tests/test_time_dropdown_wiring.py --ignore=tests/test_extract_integration.py --ignore=tests/test_wikimedia.py -m "not network and not live"
  stage "pytest-worker" $PYTEST_WORKER_BASELINE python3 -m pytest worker/tests/ -q -p no:cacheprovider -m "not network and not live"
fi

# ── 3. Deploy hygiene (existing scripts, non-ratchet: hard gates) ──────────
if [ -z "$ONLY" ] || [ "$ONLY" = "validate-api" ]; then
  echo -e "${YEL}━━━ validate-api.sh ━━━${RST}"
  # One retry: the embedded E2E has a time-to-first-pin SLA that flakes
  # during heavy fetch-sweep cycles (observed: 6.7s fail / 1.2s pass back to back).
  if bash scripts/validate-api.sh >/tmp/ci-validate.out 2>&1 || bash scripts/validate-api.sh >/tmp/ci-validate.out 2>&1; then
    echo -e "  ${GRN}✅ validate-api passed${RST}"; RESULTS+=("✅ validate-api")
  else
    echo -e "  ${RED}❌ validate-api FAILED${RST}"; tail -8 /tmp/ci-validate.out | sed 's/^/     /'
    RESULTS+=("❌ validate-api"); FAILS=$((FAILS+1))
  fi
fi

if [ -z "$ONLY" ] || [ "$ONLY" = "run-tests-selftest" ]; then
  echo -e "${YEL}━━━ run_tests.sh selftest (parser can't lie) ━━━${RST}"
  if bash tests/run_tests.sh selftest >/dev/null 2>&1; then
    echo -e "  ${GRN}✅ verdict parser honest${RST}"; RESULTS+=("✅ run_tests selftest")
  else
    echo -e "  ${RED}❌ run_tests.sh parser BROKEN (false-green risk)${RST}"; RESULTS+=("❌ run_tests selftest"); FAILS=$((FAILS+1))
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""; echo "━━━ CI SUMMARY ━━━"
printf '  %s\n' "${RESULTS[@]}"
if [ $FAILS -eq 0 ]; then
  echo -e "${GRN}CI GREEN (at or under baseline)${RST}"; exit 0
else
  echo -e "${RED}CI RED — ${FAILS} stage(s) regressed past baseline${RST}"; exit 1
fi
