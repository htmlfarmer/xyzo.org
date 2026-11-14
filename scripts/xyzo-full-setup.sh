#!/usr/bin/env bash
# ── xyzo-full-setup.sh ────────────────────────────────────────────────
# Complete setup script for xyzo.org automation.
# Must be run as root: sudo bash scripts/xyzo-full-setup.sh
#
# This script:
# 1. Installs missing Python packages system-wide
# 2. Creates /var/log/xyzo with proper permissions
# 3. Fixes all systemd services to run as asher user
# 4. Installs/updates all systemd timers
# 5. Starts all services
# 6. Runs initial health checks

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err() { echo -e "${RED}[ERROR]${NC} $*"; }

# Check we're running as root
if [[ $EUID -ne 0 ]]; then
    err "This script must be run as root: sudo bash $0"
    exit 1
fi

WORKDIR="/var/www/vhosts/xyzo.org"
SCRIPTS_DIR="$WORKDIR/scripts"
DEPLOY_DIR="$WORKDIR/deploy"
SYSTEMD_DIR="/etc/systemd/system"
LOG_DIR="/var/log/xyzo"
USER="asher"

echo "═══════════════════════════════════════════════════════════════"
echo "  XYZO FULL SETUP"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── 1. Install missing Python packages system-wide ──────────────────
log "── 1. Installing Python packages system-wide ──"

# Install psycopg and other dependencies system-wide
pip3 install --break-system-packages \
    psycopg \
    psycopg-binary \
    feedparser \
    httpx \
    robotexclusionrulesparser \
    2>&1 | tail -5 || warn "Some packages may already be installed"

# Verify
python3 -c "import psycopg; import feedparser; import httpx; print('Python deps OK')" 2>&1 || err "Python deps check failed"
echo ""

# ── 2. Create log directory with proper permissions ─────────────────
log "── 2. Setting up log directory ──"
mkdir -p "$LOG_DIR"
chown $USER:$USER "$LOG_DIR"
chmod 755 "$LOG_DIR"
log "  ✓ $LOG_DIR created (owned by $USER)"
echo ""

# ── 3. Make deploy scripts executable ─────────────────────────────────
log "── 3. Making scripts executable ──"
chmod +x "$SCRIPTS_DIR"/*.sh 2>/dev/null || true
log "  ✓ Scripts in $SCRIPTS_DIR are executable"
echo ""

# ── 4. Install systemd units with proper user ────────────────────────
log "── 4. Installing systemd units ──"

for unit in xyzo-api.xyzo-nightly.xyzo-idle-worker.xyzo-fast-fetcher.xyzo-fetcher.xyzo-queue-soak; do
    src="$DEPLOY_DIR/$unit"
    dst="$SYSTEMD_DIR/$unit"
    if [[ -f "$src" ]]; then
        # Read the service file
        content=$(cat "$src")

        # Add User and PYTHONPATH if not present
        if ! grep -q "^User=" <<< "$content"; then
            content=$(echo "$content" | sed "/^\[Service\]/a\\
User=$USER\\
Environment=PYTHONPATH=/usr/local/lib/python3.11/dist-packages:/home/$USER/.local/lib/python3.11/site-packages" )
        fi

        # Write the unit file
        echo "$content" > "$dst"
        log "  ✓ Installed $unit"
    else
        warn "  ✗ $unit not found in $DEPLOY_DIR"
    fi
done

# Set proper ownership of all unit files
chown root:root "$SYSTEMD_DIR"/xyzo-* 2>/dev/null || true
echo ""

# ── 5. Reload systemd ────────────────────────────────────────────────
log "── 5. Reloading systemd ──"
systemctl daemon-reload
log "  ✓ systemd reloaded"
echo ""

# ── 6. Enable and start services ────────────────────────────────────
log "── 6. Starting services ──"

# Enable timers
systemctl enable xyzo-fast-fetcher.timer 2>&1 && log "  ✓ xyzo-fast-fetcher.timer enabled (every 5 min)" || warn "  ✗ Failed to enable fast-fetcher.timer"
systemctl enable xyzo-fetcher.timer 2>&1 && log "  ✓ xyzo-fetcher.timer enabled (every 15 min, full AI)" || warn "  ✗ Failed to enable fetcher.timer"
systemctl enable xyzo-nightly.timer 2>&1 && log "  ✓ xyzo-nightly.timer enabled (3 AM daily)" || warn "  ✗ Failed to enable nightly.timer"
systemctl enable xyzo-idle-worker.service 2>&1 && log "  ✓ xyzo-idle-worker.service enabled" || warn "  ✗ Failed to enable idle-worker"
systemctl enable xyzo-queue-soak.timer 2>&1 && log "  ✓ xyzo-queue-soak.timer enabled (9:30 AM daily)" || warn "  ✗ Failed to enable queue-soak"

# Start timers/services
systemctl start xyzo-fast-fetcher.timer 2>&1 && log "  ✓ xyzo-fast-fetcher.timer started" || warn "  ✗ Failed to start fast-fetcher.timer"
systemctl start xyzo-fetcher.timer 2>&1 && log "  ✓ xyzo-fetcher.timer started" || warn "  ✗ Failed to start fetcher.timer"
systemctl start xyzo-nightly.timer 2>&1 && log "  ✓ xyzo-nightly.timer started" || warn "  ✗ Failed to start nightly.timer"
systemctl start xyzo-idle-worker.service 2>&1 && log "  ✓ xyzo-idle-worker started" || warn "  ✗ Failed to start idle-worker"

# Ensure API is running
systemctl restart xyzo-api 2>&1 && log "  ✓ xyzo-api restarted" || warn "  ✗ Failed to restart API"

echo ""

# ── 7. Run initial health check ──────────────────────────────────────
log "── 7. Running health checks ──"
sleep 5

# API health
if curl -sf http://localhost:3008/api/health > /dev/null 2>&1; then
    log "  ✓ API is healthy"
else
    warn "  ✗ API is not responding"
fi

# Check article count
articles=$(curl -sf http://localhost:3008/api/health > /dev/null 2>&1 && \
    su - $USER -c "psql postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo -t -A -c 'SELECT COUNT(*) FROM news_articles WHERE fetched_at > now() - interval '\''24 hours'\'';' 2>/dev/null" || echo "?")
log "  Articles fetched in 24h: $articles"

echo ""

# ── 8. Summary ────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════"
echo "  SETUP COMPLETE"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Scheduled jobs:"
echo "  • Every 5 min:  Fast fetch cycle (xyzo-fast-fetcher.timer)"
echo "  • Every 15 min: Full AI fetch cycle (xyzo-fetcher.timer)"
echo "  • 3 AM daily:   Nightly automation (xyzo-nightly.timer)"
echo "  • Continuous:   Idle worker (xyzo-idle-worker.service)"
echo ""
echo "Useful commands:"
echo "  bash $SCRIPTS_DIR/status.sh         # Show system status"
echo "  bash $SCRIPTS_DIR/tests/test-map-coverage.sh  # Run coverage tests"
echo "  systemctl list-timers xyzo-*        # Show scheduled jobs"
echo "  sudo bash $SCRIPTS_DIR/emergency-stop.sh  # Emergency stop everything"
echo ""
echo "Log files:"
echo "  /var/log/xyzo/nightly-*.log"
echo "  /var/log/xyzo/idle-worker.log"
echo "  journalctl -u xyzo-* -f             # Service logs"
echo ""
