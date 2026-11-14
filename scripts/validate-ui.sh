#!/usr/bin/env bash
# validate-ui.sh — Graphical Playwright E2E UI Validation for Xyzo.
# Launches headless Chromium to test page render, SVG clusters, click
# interactions, console error guard, and captures visual snapshots.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if command -v python3 &>/dev/null; then
  python3 "$SCRIPT_DIR/run_ui_tests.py" "$@"
else
  echo "Error: python3 is required to run Playwright UI tests."
  exit 1
fi
