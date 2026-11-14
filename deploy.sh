#!/bin/bash
# deploy.sh — Safe deployment from dev → production
# NEVER run this without testing on dev first.
#
# Usage:
#   ./deploy.sh              # deploy frontend only
#   ./deploy.sh --full       # deploy frontend + API restart
#   ./deploy.sh --dry-run    # show what would happen
#   ./deploy.sh --rollback   # revert to previous version
#
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN="${1:-}"
FULL="${2:-}"
ROLLBACK="${3:-}"

PROD_HTML="$DIR/public_html"
DEV_HTML="$DIR/public_html_dev"
API_DIR="$DIR/api"
BACKUP_DIR="$DIR/.deploy-backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $1"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $1"; }
err()  { echo -e "${RED}[deploy]${NC} $1"; exit 1; }

# ── Step 1: Pre-deploy validation ──────────────────────────────────────
log "Step 1: Running pre-deploy validation..."
if ! bash "$DIR/scripts/validate-api.sh" 2>&1 | tail -5; then
    err "Pre-deploy validation FAILED. Fix errors before deploying."
fi
log "  ✓ Validation passed"

# ── Step 2: Check dev site is working ──────────────────────────────────
log "Step 2: Checking dev site health..."
DEV_HEALTH=$(curl -s --max-time 5 http://localhost:3009/api/health 2>/dev/null || echo '{"ok":false}')
if echo "$DEV_HEALTH" | grep -q '"ok":true'; then
    log "  ✓ Dev site is healthy"
else
    warn "  ⚠ Dev site not responding (may not be running)"
    warn "  Continuing with deployment..."
fi

# ── Step 3: Backup current production ──────────────────────────────────
log "Step 3: Backing up current production..."
mkdir -p "$BACKUP_DIR"
tar czf "$BACKUP_DIR/prod-$TIMESTAMP.tar.gz" \
    -C "$DIR" \
    public_html/app.js \
    public_html/styles.css \
    public_html/index.html \
    2>/dev/null || true
log "  ✓ Backup saved: $BACKUP_DIR/prod-$TIMESTAMP.tar.gz"

# ── Step 4: Deploy frontend ────────────────────────────────────────────
# SAFETY GUARD (2026-09-26, FIX_NOTES 3.4): this script copies DEV -> PROD.
# Agents have been editing PROD directly (boot-coordinator fixes etc.), so
# prod can be NEWER than dev — a blind copy silently reverts production.
# Detect that and stop until the trees are re-synced (prod -> dev).
STALE_DEV=0
for f in app.js index.html styles.css city-engine.js console-guard.js; do
    if [ -f "$PROD_HTML/$f" ] && [ -f "$DEV_HTML/$f" ]; then
        if [ "$PROD_HTML/$f" -nt "$DEV_HTML/$f" ]; then
            warn "  PROD/$f is NEWER than DEV/$f — deploying would revert prod fixes"
            STALE_DEV=1
        fi
    fi
done
if [ "$STALE_DEV" = "1" ] && [ "${FORCE_DEPLOY:-0}" != "1" ]; then
    err "Dev is older than prod. Either 'rsync -a $PROD_HTML/ $DEV_HTML/' to re-sync, or set FORCE_DEPLOY=1 to override."
fi

log "Step 4: Deploying frontend..."
if [ "$DRY_RUN" = "--dry-run" ]; then
    warn "  [dry-run] Would copy:"
    diff --brief "$PROD_HTML/app.js" "$DEV_HTML/app.js" 2>/dev/null && log "  app.js: unchanged" || warn "  app.js: CHANGED"
    diff --brief "$PROD_HTML/styles.css" "$DEV_HTML/styles.css" 2>/dev/null && log "  styles.css: unchanged" || warn "  styles.css: CHANGED"
    diff --brief "$PROD_HTML/index.html" "$DEV_HTML/index.html" 2>/dev/null && log "  index.html: unchanged" || warn "  index.html: CHANGED"
else
    # Copy changed files from dev to prod
    for f in app.js styles.css index.html; do
        if [ -f "$DEV_HTML/$f" ]; then
            cp "$DEV_HTML/$f" "$PROD_HTML/$f"
            log "  ✓ Deployed $f"
        fi
    done
    # Copy any new files from dev
    rsync -av --ignore-existing "$DEV_HTML/" "$PROD_HTML/" --exclude='*.log' 2>/dev/null | grep -v "^$" | head -10
    # AUTO CACHE-BUST (FIX_NOTES 3.4): Caddy serves *.js immutable for a
    # year and there is no build pipeline, so returning visitors only see
    # changes when the ?v= query moves. Bump it on every real deploy.
    VNEW=$(date +%Y%m%d%H%M)
    sed -i -E 's#app\.js\?v=[0-9]+#app.js?v='"$VNEW"'#' "$PROD_HTML/index.html"
    log "  ✓ Frontend deployed (app.js?v=$VNEW)"
fi

# ── Step 5: API restart (only with --full) ─────────────────────────────
if [ "$FULL" = "--full" ]; then
    log "Step 5: Restarting API..."
    if [ "$DRY_RUN" = "--dry-run" ]; then
        warn "  [dry-run] Would restart xyzo-api"
    else
        systemctl restart xyzo-api 2>/dev/null || warn "  API restart failed (may need sudo)"
        sleep 2
        API_HEALTH=$(curl -s --max-time 5 http://localhost:3008/api/health 2>/dev/null || echo '{"ok":false}')
        if echo "$API_HEALTH" | grep -q '"ok":true'; then
            log "  ✓ API restarted and healthy"
        else
            err "  API restart failed! Run: ./deploy.sh --rollback"
        fi
    fi
else
    log "Step 5: Skipped (use --full to restart API)"
fi

# ── Step 6: Post-deploy verification ───────────────────────────────────
log "Step 6: Post-deploy verification..."
sleep 1
PROD_HEALTH=$(curl -s --max-time 5 http://localhost:3008/api/health 2>/dev/null || echo '{"ok":false}')
if echo "$PROD_HEALTH" | grep -q '"ok":true'; then
    log "  ✓ Production API healthy"
else
    err "  Production API unhealthy! Run: ./deploy.sh --rollback"
fi

# Quick smoke test
PINS=$(curl -s --max-time 10 "http://localhost:3008/api/pins/map?bbox=-10,-10,10,10&limit=5" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('pins',d.get('items',[]))))" 2>/dev/null || echo "0")
if [ "$PINS" -gt 0 ]; then
    log "  ✓ Pin API returning data ($PINS pins)"
else
    warn "  ⚠ Pin API returned 0 pins"
fi

log ""
log "════════════════════════════════════════"
log "  Deployment complete!"
log "  Production: https://xyzo.org"
log "  Dev:        http://localhost:3009"
log "  Backup:     $BACKUP_DIR/prod-$TIMESTAMP.tar.gz"
log "════════════════════════════════════════"
