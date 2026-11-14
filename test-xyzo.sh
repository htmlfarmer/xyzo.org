#!/bin/bash
# test-xyzO.sh — Quick smoke tests for XYZO
# Run after deploy to verify everything works.
#
# Usage: ./test-xyzo.sh [url]
set -euo pipefail

URL="${1:-https://xyzo.org}"
PASS=0; FAIL=0; WARN=0

check() {
  local desc="$1" url="$2" expect="$3"
  local code
  code=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
  if [ "$code" = "$expect" ]; then
    echo "  ✓ $desc ($code)"; PASS=$((PASS+1))
  elif [ "$code" = "000" ]; then
    echo "  ✗ $desc (timeout)"; FAIL=$((FAIL+1))
  else
    echo "  ⚠ $desc (expected $expect, got $code)"; WARN=$((WARN+1))
  fi
}

echo "════════════════════════════════════════"
echo "  XYZO Smoke Tests — $URL"
echo "════════════════════════════════════════"

echo ""
echo "── API Health ──"
check "GET /api/health" "$URL/api/health" "200"
check "GET /api/stats" "$URL/api/stats" "200"
check "GET /api/version" "$URL/api/version" "200"

echo ""
echo "── Pins ──"
check "GET /api/pins/map (world)" "$URL/api/pins/map?bbox=-180,-85,180,85&limit=10" "200"
check "GET /api/pins?q=news" "$URL/api/pins?q=news&limit=5" "200"

echo ""
echo "── Events ──"
check "GET /api/events" "$URL/api/events?limit=5" "200"
check "GET /api/feed/live" "$URL/api/feed/live?limit=5" "200"

echo ""
echo "── Search ──"
check "GET /api/locations/search" "$URL/api/locations/search?q=london&limit=3" "200"
check "GET /api/geocode" "$URL/api/geocode?q=paris" "200"

echo ""
echo "── Sources ──"
check "GET /api/sources/stats" "$URL/api/sources/stats" "200"
check "GET /api/photo-sources" "$URL/api/photo-sources?limit=5" "200"

echo ""
echo "── Frontend ──"
check "GET /" "$URL/" "200"
check "GET /about.html" "$URL/about.html" "200"

echo ""
echo "════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed, $WARN warnings"
echo "════════════════════════════════════════"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
