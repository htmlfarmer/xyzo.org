#!/usr/bin/env bash
# ── PostgreSQL configuration guard tests ──────────────────────────
# Prevents regressions like the pg_stat_statements crash caused by
# ALTER SYSTEM writing dynamic_library_path to /tmp/pg_extensions/lib.
# These tests validate the running PostgreSQL config is sane and that
# the auto.conf file hasn't been poisoned with bad overrides.

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

# Helper: run a query as the postgres superuser and return trimmed output.
runpsql_su() {
  sudo -u postgres psql -t -A -d xyzo -c "$1" 2>&1
}

start_group "shared_preload_libraries includes pg_stat_statements"

val="$(runpsql_su "SHOW shared_preload_libraries" | head -1 | tr -d ' ')"
assert_contains "$val" "pg_stat_statements" \
  "shared_preload_libraries contains pg_stat_statements"

end_group || exit 1


start_group "dynamic_library_path is not overridden to /tmp"

val="$(runpsql_su "SHOW dynamic_library_path" | head -1 | tr -d ' ')"
assert_not_contains "$val" "/tmp" \
  "dynamic_library_path should not point to /tmp"
assert_not_contains "$val" "pg_extensions" \
  "dynamic_library_path should not reference pg_extensions"

end_group || exit 1


start_group "postgresql.auto.conf has no dangerous overrides"

auto_conf="/var/lib/postgresql/15/main/postgresql.auto.conf"
if [ -f "$auto_conf" ]; then
  # Should not contain dynamic_library_path overrides
  bad_lines="$(grep -c 'dynamic_library_path' "$auto_conf" 2>/dev/null || echo "0")"
  assert_eq "0" "$bad_lines" \
    "postgresql.auto.conf has no dynamic_library_path overrides"
else
  skip "postgresql.auto.conf not found (OK — no overrides possible)"
fi

end_group || exit 1


start_group "pg_stat_statements extension is functional"

result="$(runpsql_su "SELECT count(*) FROM pg_stat_statements" | head -1 | tr -d ' ')"
# Should be a number > 0, not an error message
if [[ "$result" =~ ^[0-9]+$ ]] && [ "$result" -gt 0 ]; then
  pass "pg_stat_statements returns $result tracked queries"
else
  fail "pg_stat_statements query failed" "got: $result"
fi

end_group || exit 1


start_group "postgresql.conf has shared_preload_libraries set"

PG_CONF="/etc/postgresql/15/main/postgresql.conf"
if [ -f "$PG_CONF" ]; then
  line="$(grep 'shared_preload_libraries' "$PG_CONF" | grep -v '^#')"
  if [ -n "$line" ]; then
    pass "shared_preload_libraries is uncommented in postgresql.conf"
  else
    fail "shared_preload_libraries is commented out or missing"
  fi
else
  fail "postgresql.conf not found at $PG_CONF"
fi

end_group || exit 1


start_group "pg_stat_statements.so exists in lib directory"

so_path="/usr/lib/postgresql/15/lib/pg_stat_statements.so"
if [ -f "$so_path" ]; then
  pass "pg_stat_statements.so exists at $so_path"
else
  fail "pg_stat_statements.so not found at $so_path"
fi

# Also ensure no rogue copies in /tmp
rogue="/tmp/pg_extensions/lib/pg_stat_statements.so"
if [ -f "$rogue" ]; then
  fail "rogue copy found at $rogue (should be deleted)"
else
  pass "no rogue copy in /tmp"
fi

end_group || exit 1


start_group "PostgreSQL is running and accepting connections"

status="$(runpsql_su "SELECT 1" | head -1 | tr -d ' ')"
assert_eq "1" "$status" "PostgreSQL accepts connections"

end_group || exit 1
