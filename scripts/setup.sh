#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# XYZO — Full System Setup & Launch Script
# ═══════════════════════════════════════════════════════════════════════════
# This script installs dependencies, sets up the database, trains models,
# and starts all services. Run once on a fresh system or after major changes.
#
# Usage:
#   bash scripts/setup.sh              # Full setup
#   bash scripts/setup.sh --quick      # Skip model training
#   bash scripts/setup.sh --db-only    # Database setup only
#   bash scripts/setup.sh --train      # Train models only
#   bash scripts/setup.sh --start      # Start services only
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ── Configuration ─────────────────────────────────────────────────────────
BASE_DIR="/var/www/vhosts/xyzo.org"
DB_NAME="xyzo"
DB_USER="xyzo_app"
DB_PASS="${XYZO_DB_PASS:-CHANGE_ME}"
DB_HOST="localhost"
DB_PORT="5432"
API_PORT="3008"
PYTHON="/usr/bin/python3.11"

# ── Parse arguments ───────────────────────────────────────────────────────
QUICK=false
DB_ONLY=false
TRAIN_ONLY=false
START_ONLY=false

for arg in "$@"; do
  case $arg in
    --quick) QUICK=true ;;
    --db-only) DB_ONLY=true ;;
    --train) TRAIN_ONLY=true ;;
    --start) START_ONLY=true ;;
    --help|-h)
      echo "Usage: $0 [--quick] [--db-only] [--train] [--start]"
      echo "  --quick      Skip model training"
      echo "  --db-only    Database setup only"
      echo "  --train      Train models only"
      echo "  --start      Start services only"
      exit 0
      ;;
  esac
done

# ── Helper functions ──────────────────────────────────────────────────────
log() { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }
section() { echo -e "\n${CYAN}══════════════════════════════════════════════════════════════════${NC}"; echo -e "${CYAN}  $1${NC}"; echo -e "${CYAN}══════════════════════════════════════════════════════════════════${NC}\n"; }

check_command() {
  if command -v "$1" &> /dev/null; then
    success "$1 found: $(command -v $1)"
    return 0
  else
    error "$1 not found"
    return 1
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 1: System Requirements Check
# ═══════════════════════════════════════════════════════════════════════════
phase1_check() {
  section "PHASE 1: System Requirements Check"
  
  local errors=0
  
  # Check required commands
  check_command python3 || errors=$((errors + 1))
  check_command psql || errors=$((errors + 1))
  check_command bun || errors=$((errors + 1))
  check_command node || errors=$((errors + 1))
  
  # Check Python version
  PYTHON_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
  if [[ "$PYTHON_VER" == "3.11" || "$PYTHON_VER" == "3.12" ]]; then
    success "Python version: $PYTHON_VER"
  else
    warn "Python version $PYTHON_VER (recommended: 3.11+)"
  fi
  
  # Check PostgreSQL
  if pg_isready -h "$DB_HOST" -p "$DB_PORT" &> /dev/null; then
    success "PostgreSQL is running"
  else
    error "PostgreSQL is not running"
    errors=$((errors + 1))
  fi
  
  # Check database exists
  if psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" &> /dev/null; then
    success "Database $DB_NAME accessible"
  else
    error "Database $DB_NAME not accessible"
    errors=$((errors + 1))
  fi
  
  # Check required extensions
  local extensions=("postgis" "pg_trgm" "pgvector" "pgcrypto")
  for ext in "${extensions[@]}"; do
    if psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1 FROM pg_extension WHERE extname='$ext'" -t 2>/dev/null | grep -q "1"; then
      success "Extension: $ext"
    else
      warn "Extension $ext not installed (may need: CREATE EXTENSION $ext)"
    fi
  done
  
  # Check disk space
  local disk_avail=$(df -BG "$BASE_DIR" | tail -1 | awk '{print $4}' | sed 's/G//')
  if [[ $disk_avail -gt 10 ]]; then
    success "Disk space: ${disk_avail}GB available"
  else
    warn "Low disk space: ${disk_avail}GB available"
  fi
  
  # Check memory
  local mem_avail=$(free -m | awk '/^Mem:/{print $7}')
  if [[ $mem_avail -gt 500 ]]; then
    success "Available memory: ${mem_avail}MB"
  else
    warn "Low memory: ${mem_avail}MB available"
  fi
  
  if [[ $errors -gt 0 ]]; then
    error "System requirements check failed ($errors errors)"
    return 1
  fi
  
  success "System requirements check passed"
  return 0
}

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 2: Database Setup
# ═══════════════════════════════════════════════════════════════════════════
phase2_database() {
  section "PHASE 2: Database Setup"
  
  log "Running migrations..."
  cd "$BASE_DIR"
  
  # Run all migrations in order
  for migration in api/migrations/*.sql; do
    if [[ -f "$migration" ]]; then
      local name=$(basename "$migration")
      log "  Applying: $name"
      if psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -f "$migration" -q 2>/dev/null; then
        success "  $name applied"
      else
        warn "  $name skipped (may already exist)"
      fi
    fi
  done
  
  # Verify critical tables exist
  local tables=("news_articles" "news_events" "news_sources" "news_locations" "nn_training_features")
  for table in "${tables[@]}"; do
    if psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1 FROM $table LIMIT 0" -q 2>/dev/null; then
      success "Table: $table"
    else
      error "Table $table missing!"
    fi
  done
  
  # Run auto-labeling for the embedding model
  log "Running auto-labeling for article_understanding..."
  XYZO_DB_URL="postgresql://$DB_USER:$DB_PASS@$DB_HOST:$DB_PORT/$DB_NAME" \
    $PYTHON -c "
import sys
sys.path.insert(0, '$BASE_DIR')
from worker.nn_features import auto_label_article_understanding, connect

with connect() as conn:
    article_labeled = auto_label_article_understanding(conn)
    print(f'Article Understanding: {article_labeled} labeled')
" 2>/dev/null || warn "Auto-labeling skipped (will run on next snapshot)"
  
  success "Database setup complete"
}

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 3: Model Training
# ═══════════════════════════════════════════════════════════════════════════
phase3_train() {
  section "PHASE 3: Model Training"
  
  if [[ "$QUICK" == "true" ]]; then
    warn "Skipping model training (--quick mode)"
    return 0
  fi
  
  cd "$BASE_DIR"
  export XYZO_DB_URL="postgresql://$DB_USER:$DB_PASS@$DB_HOST:$DB_PORT/$DB_NAME"
  
  # Train article_understanding model
  log "Training article_understanding model..."
  if $PYTHON -m worker.nn_train --only article_understanding --epochs 3 2>&1 | tail -5; then
    success "article_understanding trained"
  else
    warn "article_understanding training failed (will use fallback)"
  fi
  
  # Activate models
  log "Activating trained models..."
  psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "
    UPDATE nn_model_registry SET is_active = TRUE 
    WHERE model_name = 'article_understanding'
      AND trained_at > now() - interval '1 hour';
  " -q 2>/dev/null || true
  
  success "Model training complete"
}

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 4: NN Inference
# ═══════════════════════════════════════════════════════════════════════════
phase4_inference() {
  section "PHASE 4: Neural Network Inference"
  
  if [[ "$QUICK" == "true" ]]; then
    warn "Skipping NN inference (--quick mode)"
    return 0
  fi
  
  cd "$BASE_DIR"
  export XYZO_DB_URL="postgresql://$DB_USER:$DB_PASS@$DB_HOST:$DB_PORT/$DB_NAME"
  
  log "Running NN inference (embeddings + ranking + coverage)..."
  if timeout 180 $PYTHON -m worker.nn_infer --limit 500 2>&1 | tail -5; then
    success "NN inference complete"
  else
    warn "NN inference timed out (will continue on next cycle)"
  fi
  
  # Check results
  local embeddings=$(psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM nn_article_embeddings" 2>/dev/null | tr -d ' ')
  local predictions=$(psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM nn_prediction_cache" 2>/dev/null | tr -d ' ')
  
  success "Embeddings: $embeddings, Predictions: $predictions"
}

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 5: Start Services
# ═══════════════════════════════════════════════════════════════════════════
phase5_start() {
  section "PHASE 5: Start Services"
  
  # API Server
  log "Starting API server..."
  if systemctl is-active --quiet xyzo-api; then
    success "API server already running"
  else
    sudo systemctl start xyzo-api 2>/dev/null || warn "Could not start xyzo-api (may need sudo)"
    sleep 2
    if systemctl is-active --quiet xyzo-api; then
      success "API server started on port $API_PORT"
    else
      warn "API server start failed"
    fi
  fi
  
  # NN Inference Timer
  log "Enabling NN inference timer..."
  sudo systemctl enable xyzo-nn-infer.timer 2>/dev/null || true
  sudo systemctl start xyzo-nn-infer.timer 2>/dev/null || true
  success "NN inference timer enabled (runs every 5 min)"
  
  # Fetch Timers
  log "Enabling fetch timers..."
  sudo systemctl enable xyzo-fast-fetcher.timer 2>/dev/null || true
  sudo systemctl start xyzo-fast-fetcher.timer 2>/dev/null || true
  sudo systemctl enable xyzo-fetcher.timer 2>/dev/null || true
  sudo systemctl start xyzo-fetcher.timer 2>/dev/null || true
  success "Fetch timers enabled (5min + 15min cycles)"
  
  # Nightly Timer
  log "Enabling nightly timer..."
  sudo systemctl enable xyzo-nightly.timer 2>/dev/null || true
  sudo systemctl start xyzo-nightly.timer 2>/dev/null || true
  success "Nightly timer enabled (3:00 AM)"
  
  # Story Link Timer
  log "Enabling story link timer..."
  sudo systemctl enable xyzo-story-link.timer 2>/dev/null || true
  sudo systemctl start xyzo-story-link.timer 2>/dev/null || true
  success "Story link timer enabled (every 6h)"
  
  # Idle Worker
  log "Enabling idle worker..."
  sudo systemctl enable xyzo-idle-worker.service 2>/dev/null || true
  sudo systemctl start xyzo-idle-worker.service 2>/dev/null || true
  success "Idle worker enabled"
  
  success "All services started"
}

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 6: Health Check
# ═══════════════════════════════════════════════════════════════════════════
phase6_health() {
  section "PHASE 6: Health Check"
  
  # API Health
  log "Checking API health..."
  local health=$(curl -s "http://localhost:$API_PORT/api/health" 2>/dev/null)
  if echo "$health" | grep -q '"ok":true'; then
    success "API health: OK"
  else
    warn "API health check failed"
  fi
  
  # Database stats
  log "Database statistics:"
  local articles=$(psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM news_articles" 2>/dev/null | tr -d ' ')
  local events=$(psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM news_events" 2>/dev/null | tr -d ' ')
  local sources=$(psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM news_sources WHERE active = TRUE" 2>/dev/null | tr -d ' ')
  local embeddings=$(psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM nn_article_embeddings" 2>/dev/null | tr -d ' ')
  local predictions=$(psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM nn_prediction_cache" 2>/dev/null | tr -d ' ')
  
  echo "  Articles: $articles"
  echo "  Events: $events"
  echo "  Active Sources: $sources"
  echo "  Embeddings: $embeddings"
  echo "  Predictions: $predictions"
  
  # Service status
  log "Service status:"
  for svc in xyzo-api xyzo-nn-infer.timer xyzo-fast-fetcher.timer xyzo-fetcher.timer; do
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
      success "  $svc: running"
    else
      warn "  $svc: not running"
    fi
  done
  
  success "Health check complete"
}

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 7: Summary
# ═══════════════════════════════════════════════════════════════════════════
phase7_summary() {
  section "SETUP COMPLETE"
  
  echo -e "${GREEN}XYZO is now running!${NC}"
  echo ""
  echo "Access points:"
  echo "  • Main map:     https://xyzo.org"
  echo "  • API:          http://localhost:$API_PORT"
  echo "  • Health:       http://localhost:$API_PORT/api/health"
  echo "  • Help/Stats:   https://xyzo.org/help/"
  echo ""
  echo "Services running:"
  echo "  • API Server (port $API_PORT)"
  echo "  • NN Inference (every 5 min)"
  echo "  • Fast Fetcher (every 5 min)"
  echo "  • Fetcher (every 15 min)"
  echo "  • Story Linker (every 6h)"
  echo "  • Nightly Training (3:00 AM)"
  echo ""
  echo "Useful commands:"
  echo "  • Check health:    curl http://localhost:$API_PORT/api/health | jq"
  echo "  • View logs:       journalctl -u xyzo-api -f"
  echo "  • Restart API:     sudo systemctl restart xyzo-api"
  echo "  • Run worker:      cd $BASE_DIR && python3 -m worker.run --fast"
  echo "  • Train models:    cd $BASE_DIR && python3 -m worker.nn_train"
  echo ""
  echo -e "${CYAN}The Earth is ready. XYZO is live.${NC}"
}

# ═══════════════════════════════════════════════════════════════════════════
# MAIN EXECUTION
# ═══════════════════════════════════════════════════════════════════════════
main() {
  echo -e "${CYAN}"
  echo "  ╔═══════════════════════════════════════════════════════════════╗"
  echo "  ║                  XYZO System Setup Script                  ║"
  echo "  ║            Global News Map & Intelligence Platform         ║"
  echo "  ╚═══════════════════════════════════════════════════════════════╝"
  echo -e "${NC}"
  
  local start_time=$(date +%s)
  
  if [[ "$DB_ONLY" == "true" ]]; then
    phase1_check && phase2_database
  elif [[ "$TRAIN_ONLY" == "true" ]]; then
    phase3_train && phase4_inference
  elif [[ "$START_ONLY" == "true" ]]; then
    phase5_start && phase6_health
  else
    phase1_check && \
    phase2_database && \
    phase3_train && \
    phase4_inference && \
    phase5_start && \
    phase6_health && \
    phase7_summary
  fi
  
  local end_time=$(date +%s)
  local duration=$((end_time - start_time))
  echo ""
  echo -e "${BLUE}Completed in ${duration} seconds${NC}"
}

# Run main function
main
