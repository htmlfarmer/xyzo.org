#!/usr/bin/env bash
# check_dev_merge.sh — simulate merging public_html_dev into public_html and run pre-deploy validation
set -euo pipefail
SCRIPTDIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPTDIR/.." && pwd)"
DEV_FILE="$ROOT/public_html_dev/app.js"
PROD_FILE="$ROOT/public_html/app.js"
BACKUP="$ROOT/.tmp_app_js_backup.$$"

if [[ ! -f "$DEV_FILE" ]]; then
  echo "ERROR: dev file not found: $DEV_FILE" >&2
  exit 2
fi

echo "Simulating merge: copying $DEV_FILE -> $PROD_FILE (backup saved)"
cp "$PROD_FILE" "$BACKUP"
cp "$DEV_FILE" "$PROD_FILE"

echo "Running validation..."
set +e
"$SCRIPTDIR/validate-api.sh"
RESULT=$?
set -e

echo "Restoring original production file"
mv "$BACKUP" "$PROD_FILE"

if [[ $RESULT -eq 0 ]]; then
  echo "OK: Validation passed for dev->prod merge simulation"
else
  echo "FAIL: Validation failed for dev->prod merge simulation (exit $RESULT)"
fi
exit $RESULT
