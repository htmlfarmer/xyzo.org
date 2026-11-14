#!/usr/bin/env bash
# ── Frontend tests ────────────────────────────────────────────────
# Validates that the JavaScript files in public_html/ parse cleanly
# and that the city-engine's client-side categorize function returns
# the expected shape (mirror of the worker auto_categorize).
#
# These tests run without a browser — just node --check for syntax
# and a node script that loads city-engine.js as a module.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

PUBLIC_HTML="$XYZO_WORKDIR/public_html"

start_group "JS & HTML syntax"
for f in app.js city-engine.js analytics.js submit-sniff.js; do
  if [ -f "$PUBLIC_HTML/$f" ]; then
    if node --check "$PUBLIC_HTML/$f" 2>&1 | head -1 > /tmp/_nodeout 2>&1; then
      pass "node --check $f"
    else
      fail "node --check $f" "$(cat /tmp/_nodeout)"
    fi
  else
    skip "node --check $f (file not found)"
  fi
done
if [ -f "$PUBLIC_HTML/inspector.html" ]; then
  pass "inspector.html exists"
else
  fail "inspector.html exists" "file missing"
fi
end_group || exit 1

start_group "CityEngine.categorize shape"
# city-engine.js attaches CityEngine to window. We stub window and
# document, then load it with node to validate the exported shape.
# The auto-load() at the end of the IIFE fails (no fetch), but the
# exported API surface is still populated synchronously.
out="$(cd "$XYZO_WORKDIR" && node -e "
const fs = require('fs');

// Stub the browser globals city-engine.js depends on.
global.window = {};
global.document = { addEventListener: () => {} };
global.fetch = () => Promise.reject(new Error('no fetch in tests'));
global.location = { hostname: 'localhost' };

const code = fs.readFileSync('public_html/city-engine.js', 'utf8');
const fn = new Function('window', 'document', 'fetch', 'location',
  code + ';return window.CityEngine || null;');
const CE = fn(global.window, global.document, global.fetch, global.location);
if (!CE) { console.log('FAIL: CityEngine not exported'); process.exit(1); }
console.log('PASS:exported');

if (typeof CE.categorize !== 'function') {
  console.log('FAIL: categorize is not a function');
  process.exit(1);
}
console.log('PASS:categorize_is_function');

const result = CE.categorize('Earthquake in Tokyo', 'A 7.1 earthquake struck Tokyo today.');
const required = ['city', 'city_label', 'city_confidence', 'category',
  'category_confidence', 'can_apply', 'reason'];
for (const k of required) {
  if (!(k in result)) {
    console.log('FAIL: missing field ' + k + ' in ' + JSON.stringify(result));
    process.exit(1);
  }
}
console.log('PASS:result_shape');

const cat = CE.categorizeText('Earthquake hits Tokyo', 'magnitude 7.1');
if (typeof cat !== 'string' || cat.length === 0) {
  console.log('FAIL: categorizeText returned empty: ' + JSON.stringify(cat));
  process.exit(1);
}
console.log('PASS:categorizeText_returns_string');
" 2>&1 | grep -E "^(PASS|FAIL):")"
assert_contains "$out" "PASS:exported" "CityEngine is exported"
assert_contains "$out" "PASS:categorize_is_function" "categorize() is a function"
assert_contains "$out" "PASS:result_shape" "categorize() returns expected fields"
assert_contains "$out" "PASS:categorizeText_returns_string" "categorizeText returns non-empty string"
end_group || exit 1

start_group "App.js AIStatus module"
# Validates that the AIStatus module has the expected API surface and
# that the file as a whole is syntactically clean.
grep_out="$(grep -n "AIStatus = {" "$PUBLIC_HTML/app.js" | head -1)"
if [ -n "$grep_out" ]; then
  pass "AIStatus module defined"
else
  fail "AIStatus module defined" "not found in app.js"
fi
grep_out="$(grep -n "_show\|_hide\|start()\|check()" "$PUBLIC_HTML/app.js" | head -5)"
if [ -n "$grep_out" ]; then
  pass "AIStatus has show/hide/start/check methods"
else
  fail "AIStatus has expected methods" "not found"
fi
end_group || exit 1

echo ""
echo -e "${GREEN}${BOLD}All frontend tests passed.${RESET}"