#!/bin/bash
set -e
psql -U postgres -h /var/run/postgresql -d xyzo -t -A -c "
SELECT replace(
  pg_read_file('/var/log/postgresql/postgresql-15-main.log', 10000000, 1500000),
  E'\\000', ' '
);
" > /tmp/pg_recent.log 2>&1
wc -l /tmp/pg_recent.log
echo "--- first line ---"
head -1 /tmp/pg_recent.log | head -c 200
echo
echo "--- last line ---"
tail -1 /tmp/pg_recent.log | head -c 200
