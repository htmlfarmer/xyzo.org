#!/usr/bin/env bash
# ── Non-AI article validation & source health tests ──────────────────
# Validates article location evaluation, distance threshold rules, paywall
# keyword detection, and city extraction without calling external AI endpoints.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

start_group "article location auditing (audit_locations)"
out="$(runpy "
from worker import audit_locations

pin = {
    'id': 999,
    'title': 'Heavy rain and flash floods in Tokyo',
    'lat': 51.5074, 'lng': -0.1278,
    'location_precision': 'city',
    'confidence_score': 0.9,
    'status': 'published',
    'source_type': 'rss',
}
c = audit_locations.evaluate_pin(pin)
assert c is not None, 'correction should be proposed'
assert 'distance' in c.rules_fired, c.rules_fired
assert c.after['place_name'] == 'Tokyo', c.after
print('PASS:distance_rule')

pin_ok = {
    'id': 1000,
    'title': 'Heavy rain and flash floods in Tokyo',
    'lat': 35.6895, 'lng': 139.6917,
    'location_precision': 'city',
    'confidence_score': 0.9,
    'status': 'published',
    'source_type': 'rss',
}
c2 = audit_locations.evaluate_pin(pin_ok)
assert c2 is None, 'correct pin should not fire rules'
print('PASS:correct_pin_passes')
" 2>&1)"
assert_contains "$out" "PASS:distance_rule" "distance rule proposed correction"
assert_contains "$out" "PASS:correct_pin_passes" "correct pin passes without rules firing"
end_group || exit 1

start_group "paywall and non-AI city detection"
out="$(runpy "
from worker import paywall, cities_text

# Paywall check
html_pw = '<div>Subscribe to read the full story. Subscriber-only content.</div>'
res = paywall.detect_paywall(body=html_pw)
assert res['is_paywalled'] is True, 'paywall keyword detected'
print('PASS:paywall_detected')

# Cities text check
text = 'Voters in Seoul and Tokyo cast ballots in local elections.'
matches = cities_text.find_cities_in_text(text, min_population=100_000)
names = {m['city']['name'] for m in matches}
assert 'Seoul' in names and 'Tokyo' in names, names
print('PASS:cities_extracted')
" 2>&1)"
assert_contains "$out" "PASS:paywall_detected" "paywall keyword correctly flagged"
assert_contains "$out" "PASS:cities_extracted" "cities extracted deterministically without AI"
end_group || exit 1

echo ""
echo -e "${GREEN}${BOLD}All article validation tests passed.${RESET}"
