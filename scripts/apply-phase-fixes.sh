#!/usr/bin/env bash
# ── apply-phase-fixes.sh ─────────────────────────────────────────────
#
# One-shot deployment for the 5-phase recommendation rollout.
#
# Does all of:
#   1. Applies the Phase-1 schema migration
#      (api/migrations/2026-09-05-missing-tables-and-indexes.sql)
#   2. Mirrors any updated service files from deploy/ into /etc/systemd/system/
#      and adds XYZO_AI_CONCURRENCY=4 to the fetcher service (Phase 3 perf knob)
#   3. systemctl daemon-reload
#   4. Restarts xyzo-api           (picks up Phase-5 route changes)
#   5. Restarts xyzo-fast-fetcher   (picks up Phase-3 ThreadPoolExecutor)
#   6. Verifies /api/health responds 200
#
# Idempotent — safe to re-run. Skips steps whose state is already correct.
#
# Run from anywhere:
#     sudo scripts/apply-phase-fixes.sh        # one sudo, one prompt
#   or
#     scripts/apply-phase-fixes.sh             # script calls sudo itself
#
# What this script does NOT do:
#   • Restart xyzo-fetcher.timer — that runs on its own schedule and
#     picks up code changes the next time it fires (no daemon needed).
#   • Restart xyzo-idle-worker   — only restarts if it's currently active.
#   • Touch your browser cache — hard-refresh (Ctrl/Cmd+Shift+R) yourself
#     to pick up the new public_html/app.js (Phase-2 B5/B6 listener fixes).
#   • Push to a remote — none configured.

set -euo pipefail

# ── Resolve repo + sanity checks ─────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO"

if [ ! -d "$REPO/.git" ]; then
  echo "✗ $REPO is not a git repo" >&2
  exit 1
fi
if [ ! -f "$REPO/api/migrations/2026-09-05-missing-tables-and-indexes.sql" ]; then
  echo "✗ Phase-1 migration file missing — wrong branch?" >&2
  exit 1
fi

# Ordered list of one-shot migrations to apply. Add new files here as
# they're introduced. Each must be idempotent (use IF NOT EXISTS or
# DO $ IF NOT EXISTS $ END$ blocks) so re-runs are no-ops.
MIGRATIONS=(
  "$REPO/api/migrations/2026-09-05-missing-tables-and-indexes.sql"
  "$REPO/api/migrations/2026-09-05-pagerank-score.sql"
)

# ── Root permissions ────────────────────────────────────────────────
# Migration touches tables owned by `postgres`, not `xyzo_app`, so we
# need PG-superuser access. systemd ops need root. We always exec the
# psql step under the OS user `asher` (the PG peer-auth superuser on
# this host) — whether or not this script itself was started by sudo.
IS_ROOT=0
if [ "$(id -u)" -eq 0 ]; then IS_ROOT=1; fi
# SUDO is only for systemctl/cp ops, not psql.
SUDO=""
if [ "$IS_ROOT" -ne 1 ]; then SUDO=sudo; fi

# ── DSNs ────────────────────────────────────────────────────────────
# App-user DSN — used as a sanity check.
APP_DSN="${XYZO_DB_URL:-postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo}"
# Superuser DSN — peer auth as the OS user named below. We hard-code
# `asher` because that's the PG superuser on this host; falling back to
# $USER would become `root` under sudo and break peer auth.
PG_SUPERUSER="${PG_SUPERUSER:-asher}"
SU_DSN="${SUPERUSER_DSN:-postgresql://${PG_SUPERUSER}@localhost:5432/xyzo}"

# Run psql as the PG peer-auth superuser. `su` when we're root (the
# usual case under sudo), `sudo -u` otherwise. This is the only way
# to get peer auth working regardless of how the script was launched.
pg_super() {
  if [ "$IS_ROOT" -eq 1 ]; then
    su -s /bin/bash -c "$*" "$PG_SUPERUSER"
  else
    sudo -u "$PG_SUPERUSER" -- "$@"
  fi
}

# ── 1. Apply the migrations ─────────────────────────────────────────
# Walks MIGRATIONS[] in order. Each file MUST be idempotent
# (IF NOT EXISTS / DO blocks) — re-running the script is safe.
echo
echo "── 1/6 Applying migrations ──"
echo "  using superuser DSN: $SU_DSN"
for mig in "${MIGRATIONS[@]}"; do
  if [ ! -f "$mig" ]; then
    echo "  ✗ missing migration file: $mig" >&2
    exit 1
  fi
  name="$(basename "$mig")"
  echo "  → $name"
  if ! pg_super psql "$SU_DSN" -v ON_ERROR_STOP=1 -q -f "$mig"; then
    echo "  ✗ migration failed: $name — fix the cause and re-run" >&2
    exit 1
  fi
done
echo "  ok (${#MIGRATIONS[@]} applied)"

# ── 2. Mirror updated service files into /etc/systemd/system/ ───────
# xyzo-api.service was already updated in this session (Phase 5). Any
# other service files in deploy/ that are newer than their installed
# copies get synced. Then we patch in XYZO_AI_CONCURRENCY for the
# fetcher (Phase 3 perf knob).
echo
echo "── 2/6 Reconciling /etc/systemd/system/ with deploy/ ──"
synced=0
for src in "$REPO"/deploy/*.service "$REPO"/deploy/*.timer; do
  [ -f "$src" ] || continue
  name="$(basename "$src")"
  dst="/etc/systemd/system/$name"
  if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst"; then
    echo "  → syncing $name"
    $SUDO cp "$src" "$dst"
    $SUDO chown root:root "$dst"
    $SUDO chmod 644 "$dst"
    synced=$((synced+1))
  fi
done
if [ "$synced" -eq 0 ]; then
  echo "  (no drift — already in sync)"
fi

# ── 3. Patch XYZO_AI_CONCURRENCY into the fetcher service ──────────
# Idempotent: checks for the env var first, only inserts if missing.
echo
echo "── 3/6 Setting XYZO_AI_CONCURRENCY=4 on fetcher services ──"
for svc in xyzo-fast-fetcher.service xyzo-fetcher.service; do
  unit="/etc/systemd/system/$svc"
  [ -f "$unit" ] || continue
  if $SUDO grep -q '^Environment=XYZO_AI_CONCURRENCY=' "$unit"; then
    echo "  $svc: already set, skipping"
    continue
  fi
  echo "  $svc: adding Environment=XYZO_AI_CONCURRENCY=4"
  $SUDO sed -i '/^\[Service\]/a Environment=XYZO_AI_CONCURRENCY=4' "$unit"
done

# Reload systemd to pick up the env change.
$SUDO systemctl daemon-reload

# ── 4. Restart xyzo-api (Phase-5 batch inserts) ────────────────────
echo
echo "── 4/6 Restarting xyzo-api ──"
$SUDO systemctl reset-failed xyzo-api.service 2>/dev/null || true
$SUDO systemctl restart xyzo-api.service
# Wait briefly for the API to come up; it should respond within a second.
for i in 1 2 3 4 5; do
  if curl -sf "http://127.0.0.1:${XYZO_PORT:-3008}/api/health" >/dev/null 2>&1; then
    echo "  ok — /api/health responding"
    break
  fi
  sleep 1
  if [ "$i" -eq 5 ]; then
    echo "  ✗ /api/health still unreachable after 5s — check journalctl -u xyzo-api"
    $SUDO journalctl -u xyzo-api.service -n 30 --no-pager >&2 || true
    exit 1
  fi
done

# ── 5. Restart xyzo-fast-fetcher (Phase-3 ThreadPoolExecutor) ─────
echo
echo "── 5/6 Restarting xyzo-fast-fetcher ──"
# xyzo-fast-fetcher is Type=oneshot — a plain `systemctl restart`
# blocks until the cycle finishes (often 5-10+ min for --fast).
# Use --no-block to kick it off and return immediately; we don't need
# to wait for it. The .timer will fire it again on schedule regardless.
$SUDO systemctl reset-failed xyzo-fast-fetcher.service 2>/dev/null || true
if $SUDO systemctl restart --no-block xyzo-fast-fetcher.service 2>/dev/null \
   || $SUDO systemctl start --no-block xyzo-fast-fetcher.service 2>/dev/null; then
  echo "  ok — fast cycle kicked off (non-blocking)"
else
  echo "  ! --no-block not supported on this systemd; skipping manual restart"
  echo "    (the .timer will pick up the new code on its next fire)"
fi

# If the idle worker is active, restart it too. It's Type=simple so it
# picks up the new extract.py immediately. Skip silently if not running.
if $SUDO systemctl is-active --quiet xyzo-idle-worker.service; then
  echo "  → also restarting xyzo-idle-worker (was active)"
  $SUDO systemctl restart xyzo-idle-worker.service
fi

# ── 5b. Enable story-link + PageRank timer ──────────────────────────
# Installs the new xyzo-story-link.service + .timer (deployed earlier
# by step 2's drift-reconciliation). Without enabling the timer the
# story_link op only runs when manually triggered via the script.
echo
echo "── 5b Enabling xyzo-story-link.timer ──"
$SUDO systemctl daemon-reload
if $SUDO systemctl enable --now xyzo-story-link.timer 2>/dev/null; then
  # Show the next fire so the operator can sanity-check the schedule.
  next=$($SUDO systemctl list-timers --no-pager xyzo-story-link.timer \
         | awk '/[0-9]/ {print $1, $2, $3, $4, $5, $6; exit}')
  echo "  ok — timer enabled${next:+; next fire: $next}"
else
  echo "  ✗ enabling xyzo-story-link.timer failed" >&2
  echo "    (the .service + .timer were synced; try systemctl daemon-reload)" >&2
  exit 1
fi

# Fire once immediately so we don't wait 6 hours for the first run.
# Non-blocking: the dispatcher's pool picks up the enqueued job async.
echo "  → firing one-shot story_link run"
if "$REPO/scripts/trigger-story-link.sh"; then
  echo "  ok — enqueued (check /api/discovery-status for progress)"
else
  echo "  ✗ one-shot story_link trigger failed" >&2
  echo "    (the timer is still installed; next fire in ≤6h)" >&2
  exit 1
fi

# ── 6. Final sanity check ───────────────────────────────────────────
echo
echo "── 6/6 Final health check ──"
if curl -sf "http://127.0.0.1:${XYZO_PORT:-3008}/api/health" >/dev/null; then
  echo "  ✓ /api/health 200"
else
  echo "  ✗ /api/health not responding"
  exit 1
fi

# Spot-check that the Phase-1 objects now exist.
echo
echo "── Spot-check: do the new tables exist? ──"
for t in news_story_links news_quality_reports news_client_errors; do
  if pg_super psql "$SU_DSN" -tAc \
       "SELECT to_regclass('public.$t') IS NOT NULL" 2>/dev/null | grep -q '^t$'; then
    echo "  ✓ $t present"
  else
    echo "  ✗ $t missing"
    exit 1
  fi
done

# And the fts column + index.
if pg_super psql "$SU_DSN" -tAc \
     "SELECT to_regclass('public.pins_fts_idx') IS NOT NULL" 2>/dev/null | grep -q '^t$'; then
  echo "  ✓ pins_fts_idx present"
else
  echo "  ✗ pins_fts_idx missing"
  exit 1
fi

# PageRank column (added with the story_link + PageRank quick wins).
if pg_super psql "$SU_DSN" -tAc \
     "SELECT EXISTS(SELECT 1 FROM information_schema.columns
                    WHERE table_name='news_articles' AND column_name='pagerank_score')" \
     2>/dev/null | grep -q '^t$'; then
  echo "  ✓ news_articles.pagerank_score present"
else
  echo "  ✗ news_articles.pagerank_score missing"
  exit 1
fi

echo
echo "── All 6 steps complete ──"
echo "  Phase 1 schema: applied"
echo "  Phase 2 app.js: deployed (hard-refresh your browser)"
echo "  Phase 3 AI concurrency: XYZO_AI_CONCURRENCY=4 active on next cycle"
echo "  Phase 5 batch inserts: live on next API request"
echo "  Phase 4 (city trigger): deferred — FDW constraint; see migration comments"
