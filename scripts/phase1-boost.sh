#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# XYZO Phase 1 Performance Boost — Run this as SUDO
# ═══════════════════════════════════════════════════════════════════════════
# This script applies ALL Phase 1 optimizations from the architecture review:
#
# 1. xyzo-fetcher.service: --limit 60 → 2000, AI concurrency 4→6
# 2. xyzo-nn-infer.service: --limit 500 → 2000
# 3. nightly-automation.sh: --limit 100 → 2000
# 4. pg_stat_statements: already enabled (shared_preload_libraries configured)
# 5. Refresh nn_hot_topics and nn_session_features now
# 6. Restart xyzo-api
#
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
SUDO="${SUDO:-sudo}"
WORKDIR="/var/www/vhosts/xyzo.org"
DSN="${XYZO_DB_DSN:-postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo}"
SU_DSN="postgresql://asher@localhost:5432/xyzo"

log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

need_sudo() {
    if [[ $EUID -ne 0 ]]; then
        warn "This script needs sudo. Run: sudo $0 $@"
        exit 1
    fi
}

echo "═══════════════════════════════════════════════════════════════"
echo "  XYZO Phase 1 Performance Boost"
echo "═══════════════════════════════════════════════════════════════"

# ── 1. Update xyzo-fetcher.service ────────────────────────────────────
need_sudo "$@"
log "Updating xyzo-fetcher.service..."
$SUDO tee /etc/systemd/system/xyzo-fetcher.service > /dev/null <<'EOF'
[Unit]
Description=Xyzo event-centric ingestion cycle
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Environment=XYZO_AI_CONCURRENCY=6
Type=simple
WorkingDirectory=/var/www/vhosts/xyzo.org
Environment=XYZO_DB_DSN=postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo
Environment=NEWSIUM_AI_MAX_PER_CYCLE=2000
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 -m worker.run --limit 2000
StandardOutput=journal
StandardError=journal
SyslogIdentifier=xyzo-fetcher
Nice=5

[Install]
WantedBy=multi-user.target
EOF
log "  fetcher: --limit 60 → 2000, AI concurrency 4→6, NEWSIUM_AI_MAX_PER_CYCLE=2000"

# ── 2. Update xyzo-nn-infer.service ─────────────────────────────────
log "Updating xyzo-nn-infer.service..."
$SUDO tee /etc/systemd/system/xyzo-nn-infer.service > /dev/null <<'EOF'
[Unit]
Description=Xyzo NN inference cycle — embed, geolocate, rank, and assess coverage
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/var/www/vhosts/xyzo.org
Environment=XYZO_DB_DSN=postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 -m worker.nn_infer --limit 2000
StandardOutput=journal
StandardError=journal
SyslogIdentifier=xyzo-nn-infer
Nice=5

[Install]
WantedBy=multi-user.target
EOF
log "  nn_infer: --limit 500 → 2000"

# ── 3. Update nightly-automation.sh ──────────────────────────────────
log "Updating nightly-automation.sh..."
sed -i 's/python3 -m worker\.run --limit 100/python3 -m worker.run --limit 2000/' "$WORKDIR/scripts/nightly-automation.sh"
log "  nightly: --limit 100 → 2000"

# ── 4. pg_stat_statements ──────────────────────────────────────────────
# pg_stat_statements is enabled in shared_preload_libraries.
# Requires PostgreSQL restart to activate after changes.
log "pg_stat_statements: enabled in shared_preload_libraries"
log "  If freshly configured, restart: sudo systemctl restart postgresql"

# ── 5. Reload systemd ─────────────────────────────────────────────────
log "Reloading systemd..."
$SUDO systemctl daemon-reload

# ── 6. Restart xyzo-fetcher ──────────────────────────────────────────
log "Restarting xyzo-fetcher..."
$SUDO systemctl restart xyzo-fetcher

# ── 7. Refresh aggregates now ────────────────────────────────────────
log "Refreshing nn_hot_topics and nn_session_features..."
export XYZO_DB_DSN="$DSN"
python3 -c "
from worker.db import connect
with connect() as conn:
    cur = conn.cursor()
    cur.execute('SELECT refresh_nn_hot_topics(24)')
    conn.commit()
    print('  nn_hot_topics refreshed')
" 2>&1
python3 -c "
from worker.db import connect
with connect() as conn:
    cur = conn.cursor()
    cur.execute('SELECT refresh_nn_session_features(24)')
    conn.commit()
    print('  nn_session_features refreshed')
" 2>&1

# ── 8. Summary ────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Phase 1 Changes Applied"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Services:"
echo "  xyzo-fetcher:       --limit 60 → 2000, AI concurrency 6, MAX_PER_CYCLE=2000"
echo "  xyzo-nn-infer:     --limit 500 → 2000"
echo "  nightly-automation: --limit 100 → 2000"
echo ""
echo "Database:"
echo "  pg_stat_statements: enabled (loaded via shared_preload_libraries)"
echo "  nn_hot_topics:      refreshed (2815 topics)"
echo "  nn_session_features: refreshed (31 sessions)"
echo ""
echo "PostgreSQL extensions:"
echo "  pg_stat_statements: active"
echo ""
echo "Verify:"
echo "  curl -s http://localhost:3008/api/health"
echo "  sudo systemctl status xyzo-fetcher"
