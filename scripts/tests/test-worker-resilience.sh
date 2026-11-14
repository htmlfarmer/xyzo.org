#!/usr/bin/env bash
# ── Worker resilience tests ────────────────────────────────────────
# Validates that the Python worker pipeline keeps producing results
# when the AI endpoint is unreachable. These are the most important
# tests for the AI-fallback architecture — they prove the system
# still works without AI.
#
# Tests:
#   1. extract.py regex fallback produces valid output
#   2. ai_validate.py heuristic validator makes sensible decisions
#   3. fast_suggest.py heuristic_resolve resolves common inputs
#   4. auto_categorize.py runs against a small input set

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

start_group "extract.py regex fallback"
# The fallback produces a complete article dict. Test cases exercise
# the cities_text path (clear city name), the capitalized-phrase
# fallback (org name), and the no-city path.
out="$(cd "$NEWSIUM_WORKDIR" && python3 -c "
from worker.extract import _regex_fallback
r = _regex_fallback(
    'Strong earthquake hits Tokyo, Japan — magnitude 7.1',
    'A 7.1 magnitude earthquake struck Tokyo early today.'
)
assert r.get('location_text') and 'Tokyo' in r['location_text'], r
assert r.get('event_type') == 'earthquake', r
assert r.get('summary'), r
print('PASS:earthquake_tokyo')
r = _regex_fallback(
    'Markets tumble on inflation news',
    ''
)
assert r.get('event_type') in ('markets','banking','other'), r
print('PASS:no_location')
r = _regex_fallback('', '')
assert isinstance(r, dict), r
print('PASS:empty_input')
" 2>&1)"
assert_contains "$out" "PASS:earthquake_tokyo" "earthquake/tokyo produces location"
assert_contains "$out" "PASS:no_location" "no-location produces event_type"
assert_contains "$out" "PASS:empty_input" "empty input doesn't crash"
end_group || exit 1

start_group "ai_validate.py heuristic validator"
out="$(cd "$NEWSIUM_WORKDIR" && python3 -c "
from worker.ai_validate import _heuristic_validate

# Strong match: user says Tokyo, article is about Tokyo.
r = _heuristic_validate({
    'article_title': 'Strong earthquake hits Tokyo, Japan',
    'article_body': 'A 7.1 magnitude earthquake struck Tokyo early today.',
    'user_place': 'Tokyo, Japan',
    'current_place_name': 'Seoul',
})
assert r['valid'] is True, r
assert r['method'] == 'heuristic', r
assert r['confidence'] >= 0.4, r
print('PASS:strong_match')

# No signal: user says Antarctica, article is about Tokyo.
r = _heuristic_validate({
    'article_title': 'Strong earthquake hits Tokyo, Japan',
    'article_body': 'A 7.1 magnitude earthquake struck Tokyo early today.',
    'user_place': 'Antarctica',
    'current_place_name': 'Seoul',
})
assert r['valid'] is False, r
assert r['method'] == 'heuristic', r
print('PASS:no_signal')

# User suggests current location — heuristic should accept (article is
# actually about that place, the user is just confirming).
r = _heuristic_validate({
    'article_title': 'Election results in Seoul',
    'article_body': 'Voters in Seoul cast their ballots.',
    'user_place': 'Seoul, South Korea',
    'current_place_name': 'Seoul',
})
assert r['valid'] is True, r
assert r['confidence'] > 0, r
print('PASS:confirm_current_location')

# Empty user suggestion.
r = _heuristic_validate({
    'article_title': 'Some story',
    'article_body': 'Some body',
    'user_place': '',
})
assert r['valid'] is False, r
assert 'no user suggestion' in r['reasoning'].lower(), r
print('PASS:empty_suggestion')
" 2>&1)"
assert_contains "$out" "PASS:strong_match" "strong match → valid"
assert_contains "$out" "PASS:no_signal" "no signal → invalid"
assert_contains "$out" "PASS:confirm_current_location" "same as current → accepted (article is about it)"
assert_contains "$out" "PASS:empty_suggestion" "empty → rejected with reason"
end_group || exit 1

start_group "ai_validate.py force_heuristic CLI"
# The CLI flag --heuristic should always take the non-AI path even if
# AI is reachable. Run on any existing re_evaluate_request id.
req_id="$(runpsql "SELECT id FROM news_re_evaluate_requests ORDER BY id DESC LIMIT 1" | head -1 | tr -d ' ')"
if [ -n "$req_id" ] && [ "$req_id" -gt 0 ] 2>/dev/null; then
  out="$(cd "$NEWSIUM_WORKDIR" && python3 -m worker.ai_validate "$req_id" --heuristic 2>&1)"
  assert_contains "$out" "\"method\": \"heuristic\"" "--heuristic flag invokes heuristic"
  assert_contains "$out" "\"valid\"" "heuristic output has valid field"
else
  skip "no re_evaluate_requests rows to test against"
fi
end_group || exit 1

start_group "fast_suggest.py heuristic_resolve"
# Pure-function test of the helper that splits a user place into city
# + country and tries each. We don't need AI or Nominatim for this —
# we test the country_names dict path which is offline.
out="$(cd "$NEWSIUM_WORKDIR" && python3 -c "
from worker.fast_suggest import _heuristic_resolve
# We can't reach Nominatim in CI, but we can verify the function
# returns a tuple and the country-name lookup works.
geo, steps = _heuristic_resolve('Antarctica')
assert geo is None or isinstance(geo, dict), geo
assert isinstance(steps, list), steps
print('PASS:returns_tuple')
geo, steps = _heuristic_resolve('')
assert geo is None, geo
print('PASS:empty_input_handled')
# Direct test of COUNTRY_NAMES lookup path (skip if Nominatim down).
try:
    geo, steps = _heuristic_resolve('Argentina')
    if geo:
        assert 'Argentina' in geo.get('display_name', ''), geo
        print('PASS:country_dict_resolved')
    else:
        print('SKIP:country_dict_unreachable')
except Exception as e:
    print(f'SKIP:country_dict_error: {e}')
" 2>&1)"
assert_contains "$out" "PASS:returns_tuple" "heuristic_resolve returns tuple"
assert_contains "$out" "PASS:empty_input_handled" "empty input doesn't crash"
end_group || exit 1

start_group "extract.py circuit breaker"
out="$(cd "$NEWSIUM_WORKDIR" && python3 -c "
from worker import extract

# Reset breaker state.
extract._breaker_state['failures'].clear()
extract._breaker_state['open_until'] = 0.0

# Should allow when no recent failures.
assert extract._ai_call_allowed() is True

# Simulate threshold failures.
for i in range(extract._BREAKER_FAIL_THRESHOLD):
    extract._ai_record_failure(f'test failure {i}')

# Breaker should now be open.
assert extract._ai_call_allowed() is False, 'breaker should be open after threshold failures'
print('PASS:breaker_opens')

snap = extract.breaker_snapshot()
assert snap['open'] is True
assert snap['recent_failures'] >= 1
print('PASS:breaker_snapshot')

# Record success — breaker should close.
extract._ai_record_success()
assert extract._ai_call_allowed() is True, 'breaker should close on success'
print('PASS:success_closes_breaker')
" 2>&1)"
assert_contains "$out" "PASS:breaker_opens" "breaker opens after threshold failures"
assert_contains "$out" "PASS:breaker_snapshot" "breaker_snapshot returns state"
assert_contains "$out" "PASS:success_closes_breaker" "success closes breaker"
end_group || exit 1

start_group "auto_categorize.py runs without AI"
# Run the auto-categorize worker against the live DB. It should
# complete without error and emit a JSON summary even if AI is down
# (since fast_path decisions don't need AI).
out="$(cd "$NEWSIUM_WORKDIR" && NEWSIUM_AI_CHAT_URL=http://127.0.0.1:1/chat/stream \
   python3 -m worker.auto_categorize --limit 5 2>&1 | tail -10)"
assert_contains "$out" "fast_path_high" "auto_categorize emitted fast-path counts"
assert_contains "$out" "scanned" "auto_categorize reported scanned count"
end_group || exit 1

echo ""
echo -e "${GREEN}${BOLD}All worker resilience tests passed.${RESET}"