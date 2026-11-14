#!/usr/bin/env bash
# update-geolite.sh — Download latest GeoLite2-City.mmdb
#
# Runs weekly via systemd timer. Downloads from GitHub mirror,
# verifies it's a valid file, replaces the old one, restarts API.
#
# Safe to run multiple times — skips download if the file is <7 days old.

set -euo pipefail

DB_DIR="/var/www/vhosts/xyzo.org/geoip"
DB_FILE="$DB_DIR/GeoLite2-City.mmdb"
MIRROR="https://raw.githubusercontent.com/P3TERX/GeoLite.mmdb/download/GeoLite2-City.mmdb"
MIN_AGE_DAYS=7
MIN_SIZE_MB=50

# Skip if file is recent
if [ -f "$DB_FILE" ]; then
  age_days=$(( ($(date +%s) - $(stat -c %Y "$DB_FILE")) / 86400 ))
  if [ "$age_days" -lt "$MIN_AGE_DAYS" ]; then
    echo "GeoLite2 is $age_days days old — skipping (min $MIN_AGE_DAYS)"
    exit 0
  fi
fi

echo "Downloading GeoLite2-City.mmdb..."
mkdir -p "$DB_DIR"
tmp="$DB_DIR/GeoLite2-City.mmdb.tmp"

curl -sL --max-time 120 "$MIRROR" -o "$tmp"

# Verify download
size_mb=$(( $(stat -c %s "$tmp") / 1048576 ))
if [ "$size_mb" -lt "$MIN_SIZE_MB" ]; then
  echo "ERROR: Downloaded file is only ${size_mb}MB (expected >${MIN_SIZE_MB}MB) — aborting"
  rm -f "$tmp"
  exit 1
fi

# Verify it's a valid mmdb file (starts with specific bytes)
if ! file "$tmp" | grep -q "data"; then
  echo "ERROR: Downloaded file is not a valid mmdb — aborting"
  rm -f "$tmp"
  exit 1
fi

# Atomic replace
mv -f "$tmp" "$DB_FILE"
echo "GeoLite2 updated: ${size_mb}MB"

# Restart API to pick up new database
if systemctl is-active --quiet xyzo-api; then
  systemctl restart xyzo-api
  echo "API restarted"
fi
