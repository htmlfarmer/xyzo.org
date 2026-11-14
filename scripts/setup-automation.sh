#!/usr/bin/env bash
# ── Setup xyzo automation ────────────────────────────────────────────
# Installs systemd timers and services for automated news fetching.
# Run as root: sudo ./scripts/setup-automation.sh

set -euo pipefail

WORKDIR="/var/www/vhosts/xyzo.org"
DEPLOY_DIR="$WORKDIR/deploy"
SYSTEMD_DIR="/etc/systemd/system"

echo "═══════════════════════════════════════════════════════════════"
echo "  XYZO AUTOMATION SETUP"
echo "═══════════════════════════════════════════════════════════════"

# ── 1. Make scripts executable ──────────────────────────────────────
echo ""
echo "── 1. Making scripts executable ──"
chmod +x "$WORKDIR/scripts/nightly-automation.sh"
chmod +x "$WORKDIR/scripts/idle-worker.sh"
echo "  ✓ Scripts are executable"

# ── 2. Create log directory ─────────────────────────────────────────
echo ""
echo "── 2. Creating log directory ──"
mkdir -p /var/log/xyzo
chown www-data:www-data /var/log/xyzo
echo "  ✓ /var/log/xyzo created"

# ── 3. Install systemd units ────────────────────────────────────────
echo ""
echo "── 3. Installing systemd units ──"

for unit in xyzo-nightly.service xyzo-nightly.timer xyzo-idle-worker.service; do
  if [[ -f "$DEPLOY_DIR/$unit" ]]; then
    cp "$DEPLOY_DIR/$unit" "$SYSTEMD_DIR/$unit"
    echo "  ✓ Installed $unit"
  else
    echo "  ✗ $unit not found in deploy/"
  fi
done

# ── 4. Reload systemd ───────────────────────────────────────────────
echo ""
echo "── 4. Reloading systemd ──"
systemctl daemon-reload
echo "  ✓ systemd reloaded"

# ── 5. Enable and start services ────────────────────────────────────
echo ""
echo "── 5. Enabling services ──"

# Enable nightly timer
systemctl enable xyzo-nightly.timer
echo "  ✓ xyzo-nightly.timer enabled (runs 3 AM daily)"

# Enable idle worker
systemctl enable xyzo-idle-worker.service
echo "  ✓ xyzo-idle-worker.service enabled"

# Enable the full AI fetcher timer (15 min cycle)
if [[ -f "$SYSTEMD_DIR/xyzo-fetcher.timer" ]]; then
  systemctl enable xyzo-fetcher.timer
  echo "  ✓ xyzo-fetcher.timer enabled (full AI cycle every 15 min)"
else
  echo "  ⚠ xyzo-fetcher.timer not found in systemd"
  if [[ -f "$DEPLOY_DIR/xyzo-fetcher.timer" ]]; then
    cp "$DEPLOY_DIR/xyzo-fetcher.timer" "$SYSTEMD_DIR/"
    cp "$DEPLOY_DIR/xyzo-fetcher.service" "$SYSTEMD_DIR/"
    systemctl daemon-reload
    systemctl enable xyzo-fetcher.timer
    echo "  ✓ Installed and enabled xyzo-fetcher.timer"
  fi
fi

# ── 6. Start services ───────────────────────────────────────────────
echo ""
echo "── 6. Starting services ──"

systemctl start xyzo-nightly.timer
echo "  ✓ xyzo-nightly.timer started"

systemctl start xyzo-idle-worker.service
echo "  ✓ xyzo-idle-worker.service started"

systemctl start xyzo-fetcher.timer 2>/dev/null && echo "  ✓ xyzo-fetcher.timer started" || echo "  ⚠ xyzo-fetcher.timer failed to start"

# ── 7. Verify ───────────────────────────────────────────────────────
echo ""
echo "── 7. Verification ──"

echo ""
echo "  Active timers:"
systemctl list-timers --no-pager | grep -E "xyzo|NEXT" | head -10

echo ""
echo "  Active services:"
systemctl is-active xyzo-nightly.timer xyzo-idle-worker.service xyzo-fetcher.timer xyzo-fast-fetcher.timer 2>/dev/null | paste - - - - || true

# ── 8. Current stats ────────────────────────────────────────────────
echo ""
echo "── 8. Current stats ──"

DB_DSN="${XYZO_DB_DSN:-postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo}"
ARTICLES=$(psql "$DB_DSN" -t -A -c "SELECT COUNT(*) FROM news_articles;" 2>/dev/null || echo "?")
SOURCES=$(psql "$DB_DSN" -t -A -c "SELECT COUNT(*) FROM news_sources WHERE active=TRUE;" 2>/dev/null || echo "?")
EVENTS=$(psql "$DB_DSN" -t -A -c "SELECT COUNT(*) FROM news_events;" 2>/dev/null || echo "?")

echo "  Articles: $ARTICLES"
echo "  Active Sources: $SOURCES"
echo "  Events: $EVENTS"

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  SETUP COMPLETE"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Scheduled jobs:"
echo "    • 3 AM daily: Full AI cycle + city discovery + log analysis"
echo "    • Every 15 min: Full AI fetch cycle (xyzo-fetcher.timer)"
echo "    • Every 5 min: Fast fetch cycle (xyzo-fast-fetcher.timer)"
echo "    • Continuous: Idle worker (fetches when CPU/GPU idle 30min)"
echo ""
echo "  Logs:"
echo "    • /var/log/xyzo/nightly-YYYYMMDD.log"
echo "    • journalctl -u xyzo-idle-worker -f"
echo "    • journalctl -u xyzo-nightly -f"
echo ""
echo "  Manual triggers:"
echo "    • Full cycle: python3 -m worker.run --limit 100"
echo "    • Discovery: python3 -m worker.explore_region <bbox> --auto-add"
echo "    • Nightly now: systemctl start xyzo-nightly.service"
echo ""
