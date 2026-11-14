#!/bin/bash
# ── Xyzo Neural Network — end-to-end setup script ────────────────────────────
# Run from the repo root:
#   bash scripts/setup-nn.sh
#
# Two DB connections are needed:
#   • XYzo_app user  — for worker queries and inference (SELECT only)
#   • Superuser (postgres) — for CREATE TABLE and GRANT
#
# If you have XYZO_DB_SUPER_DSN set it directly. Otherwise the script
# tries: sudo -u postgres psql, then local peer auth.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

echo "══════════════════════════════════════════════════"
echo "  Xyzo Neural Network — setup"
echo "══════════════════════════════════════════════════"
echo ""

# ── Detect superuser DB connection ───────────────────────────────────────────
# Order of preference:
#   1. XYZO_DB_SUPER_DSN env var (e.g. postgresql://postgres:CHANGE_ME@localhost/xyzo)
#   2. sudo -u postgres psql
#   3. Local peer auth: psql -U postgres

SUPER_DB_URL=""
if [[ -n "${XYZO_DB_SUPER_DSN:-}" ]]; then
    SUPER_DB_URL="$XYZO_DB_SUPER_DSN"
    echo "Using superuser DSN from XYZO_DB_SUPER_DSN"
elif sudo -u postgres psql --help &>/dev/null; then
    # Try sudo; works on most systems where postgres is the superuser
    SUPER_DB_URL="postgres://postgres@localhost/xyzo"
    echo "Using sudo -u postgres psql for superuser access"
else
    # Fallback: peer auth on localhost (common in local dev)
    SUPER_DB_URL="postgres://postgres@localhost/xyzo"
    echo "Using local peer-auth superuser connection"
fi

# The xyzo_app user DSN (for worker operations)
APP_DB_URL="${XYZO_DB_DSN:-postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo}"

run_super() {
    if [[ "$SUPER_DB_URL" == *"@"* || "$SUPER_DB_URL" == *"localhost/"* ]]; then
        psql "$SUPER_DB_URL" "$@"
    else
        sudo -u postgres psql "$@"
    fi
}

run_app() {
    psql "$APP_DB_URL" "$@"
}

# ── 1. Database migrations (superuser only) ───────────────────────────────────
echo "── 1/7: Applying database migrations (requires superuser)"
run_super api/schema-neural-networks.sql
run_super api/schema-nn-embeddings.sql
run_super api/schema-nn-predictions.sql
run_super api/schema-nn-rankings.sql
run_super api/schema-nn-optimize.sql
echo "    ✓ All NN schemas applied"

# ── 2. Grant permissions (superuser) ─────────────────────────────────────
echo "── 2/7: Granting permissions to xyzo_app"
run_super -c "GRANT ALL PRIVILEGES ON SCHEMA public TO xyzo_app;"
run_super -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO xyzo_app;"
run_super -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO xyzo_app;"
run_super -c "GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO xyzo_app;"
run_super -c "GRANT EXECUTE ON FUNCTION nn_realtime_session_notify() TO xyzo_app;"
echo "    ✓ Permissions granted"

# ── 3. Python dependencies ────────────────────────────────────────────────────
echo "── 3/7: Installing Python dependencies"
PYTHON="${PYTHON:-python3}"

if ! command -v pip &>/dev/null && ! command -v pip3 &>/dev/null; then
    echo "    ⚠ pip not found — install torch manually:"
    echo "      pip install torch sentence-transformers safetensors numpy psycopg[binary]"
else
    PIP="$(command -v pip3 || command -v pip || echo 'pip3')"
    echo "    Installing torch, sentence-transformers, safetensors, numpy, psycopg[binary]..."
    $PIP install --break-system-packages torch sentence-transformers safetensors numpy "psycopg[binary]" httpx langdetect unidecode 2>&1 | tail -5
    echo "    ✓ Dependencies installed"
fi

# ── 4. Build feature snapshots ───────────────────────────────────────────────
echo "── 4/7: Building feature snapshots"
$PYTHON -m worker.nn_features
echo "    ✓ Feature snapshots written to DB"

# ── 5. Train all 7 models ───────────────────────────────────────────────────
echo "── 5/7: Training neural network models"
echo "    (First run may download DistilBERT ~ 260 MB)"
echo "    GPU recommended — CPU will work but be slower"

$PYTHON -m worker.nn_train --epochs 5

echo "    ✓ Training complete"

# ── 6. Run inference ─────────────────────────────────────────────────────────
echo "── 6/7: Running inference (encoding articles, populating caches)"
$PYTHON -m worker.nn_infer --limit 500
echo "    ✓ Inference complete"

# ── 7. Restart API ──────────────────────────────────────────────────────────
echo "── 7/7: Restarting API server"
if systemctl is-active xyzo-api &>/dev/null; then
    systemctl restart xyzo-api
    echo "    ✓ xyzo-api restarted"
elif systemctl is-active xyzo &>/dev/null; then
    systemctl restart xyzo
    echo "    ✓ xyzo restarted"
else
    echo "    ⚠ Could not detect systemd service — restart manually:"
    echo "      systemctl restart xyzo-api"
fi

echo ""
echo "══════════════════════════════════════════════════"
echo "  ✓ Neural network setup complete!"
echo "══════════════════════════════════════════════════"
echo ""
echo "  Next steps:"
echo "  • Dashboard:  https://your-domain/nn.html"
echo "  • API:       GET /api/nn/status"
echo "  • Leaderboard: GET /api/nn/leaderboard"
echo ""
echo "  Re-train models periodically:"
echo "    cd $REPO/worker"
echo "    python -m nn_features        # rebuild features"
echo "    python -m nn_train          # retrain"
echo "    python -m nn_infer          # repredict"
echo ""
