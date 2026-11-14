#!/usr/bin/env bash
# ── deploy-xyzo.sh ────────────────────────────────────────────────
#
# One-shot deploy for /var/www/vhosts/xyzo.org. Does all of:
#
#   1. Commits the in-repo systemd unit fix
#      (deploy/xyzo-api.service: ProtectHome=read-only)
#   2. Commits the Live status UI consolidation
#      (public_html/index.html + styles.css + app.js)
#   3. Reconciles the live /etc/systemd unit file with the repo version
#      (catches the "edited live, forgot to mirror" drift)
#   4. Clears any stray bun holding :3008
#   5. Validates API imports (catches missing exports before they crash prod)
#   6. Kills any stray bun holding :3008 (else systemd will crash-loop)
#   7. systemctl reset-failed + restart xyzo-api
#   8. Verifies /api/health responds 200
#
# Idempotent — safe to re-run. Skips any commit whose staged diff is
# empty so it never produces empty commits.
#
# Run from anywhere:
#     sudo scripts/deploy-xyzo.sh           # one sudo, one prompt
#   or
#     scripts/deploy-xyzo.sh                # script calls sudo itself
#
# What this script does NOT do:
#   • Push to a remote — none is configured; this checkout is the deploy.
#   • Restart workers — none changed in this session; if you edit
#     worker/*.py, bounce them separately:
#         sudo systemctl restart xyzo-fast-fetcher
#   • Touch your browser cache — hard-refresh (Ctrl/Cmd+Shift+R)
#     yourself to pick up the new public_html/* files (Caddy already
#     serves them straight from disk).
#   • Commit anything outside the two scoped groups above.

set -euo pipefail

# ── Resolve repo + sanity checks ────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO"

if [ ! -d "$REPO/.git" ]; then
  echo "✗ $REPO is not a git repo" >&2
  exit 1
fi
if [ ! -f "$REPO/deploy/xyzo-api.service" ]; then
  echo "✗ deploy/xyzo-api.service missing at $REPO — wrong repo?" >&2
  exit 1
fi

# ── Sudo setup ───────────────────────────────────────────────────────
# Use sudo if we aren't already root. We refresh the timestamp once at
# the start so subsequent sudo calls in an interactive terminal don't
# re-prompt.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
  if ! $SUDO -v; then
    echo "✗ sudo authentication failed" >&2
    exit 1
  fi
fi

INSTALL_PATH=/etc/systemd/system/xyzo-api.service

# ── Step 1: commit the systemd unit fix ─────────────────────────────
echo "── Step 1/6: commit systemd unit fix ──"
git add deploy/xyzo-api.service
if ! git diff --cached --quiet; then
  git commit -m "fix(systemd): ProtectHome=read-only so bun at ~/.bun is reachable

Without this, the unit fails with status=203/EXEC because
ProtectHome=true sandboxes the unit out of its own binary
at /home/asher/.bun/bin/bun. read-only keeps the broader
/home restriction while letting the unit read its ExecStart."
else
  echo "  (nothing to commit — already in HEAD)"
fi

# ── Step 2: commit the Live status UI work ─────────────────────────
echo
echo "── Step 2/6: commit Live status UI work ──"
git add public_html/index.html public_html/styles.css public_html/app.js
if ! git diff --cached --quiet; then
  git commit -m "feat(ui): rename Live news → Live status, consolidate AI banner

Drop the floating top-center ai-status-banner and the nav-bar
ai-health-pill. Render one consolidated status line in the
live-panel footer (always visible while the panel is open).

States: --ok / --gpu-busy / --down / --degraded. The previous
two surfaces' text and color are merged into a single,
in-context strip."
else
  echo "  (nothing to commit — already in HEAD)"
fi

# ── Step 3: reconcile live /etc unit with repo version ─────────────
echo
echo "── Step 3/6: reconcile /etc unit with repo ──"
if [ ! -f "$INSTALL_PATH" ]; then
  echo "  installing $INSTALL_PATH from repo"
  $SUDO install -m 0644 "$REPO/deploy/xyzo-api.service" "$INSTALL_PATH"
  $SUDO systemctl daemon-reload
elif ! diff -q "$REPO/deploy/xyzo-api.service" "$INSTALL_PATH" >/dev/null 2>&1; then
  echo "  /etc unit out of sync with repo; copying + daemon-reload"
  $SUDO install -m 0644 "$REPO/deploy/xyzo-api.service" "$INSTALL_PATH"
  $SUDO systemctl daemon-reload
else
  echo "  ✓ /etc unit matches repo"
fi

# ── Step 4: clear any stray bun squatting on :3008 ─────────────────
echo
echo "── Step 4/6: clear stray bun on :3008 ──"
if ss -tlnp 2>/dev/null | grep -q ":3008 "; then
  pid="$(ss -tlnp 2>/dev/null | awk -F'pid=' '/:3008 /{print $2}' | awk -F',' '{print $1}' | head -1)"
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    echo "  killing PID $pid (stray bun on :3008)"
    kill -TERM "$pid" 2>/dev/null || true
    sleep 2
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
      sleep 1
    fi
  fi
else
  echo "  ✓ port 3008 is free"
fi

# ── Step 5: validate API before restart ─────────────────────────────
echo
echo "── Step 5/6: validate API imports ──"
if [ -f "$REPO/scripts/validate-api.sh" ]; then
  if "$REPO/scripts/validate-api.sh" --quick; then
    echo "  ✓ validation passed"
  else
    echo "  ✗ VALIDATION FAILED — fix errors before deploying" >&2
    exit 1
  fi
else
  echo "  SKIP: validate-api.sh not found"
fi

# ── Step 6: restart under systemd + verify ─────────────────────────
echo
echo "── Step 6/6: restart xyzo-api ──"
$SUDO systemctl reset-failed xyzo-api.service 2>/dev/null || true
$SUDO systemctl restart xyzo-api.service

ok=0
for _ in $(seq 1 10); do
  if $SUDO systemctl is-active --quiet xyzo-api.service; then
    ok=1
    break
  fi
  sleep 1
done

$SUDO systemctl --no-pager --full status xyzo-api.service | head -15 || true

echo
echo "── Health check ──"
HEALTH="$(curl -fsS --max-time 5 http://127.0.0.1:3008/api/health 2>&1 || true)"
if [ -n "$HEALTH" ] && printf '%s' "$HEALTH" | grep -q '"ok":true'; then
  echo "  ✓ $HEALTH"
else
  echo "  ⚠ API not responding to /api/health"
  echo
  echo "Last 30 journal lines:"
  $SUDO journalctl -u xyzo-api --no-pager -n 30 2>&1 || true
  exit 1
fi

# Confirm the API process is owned by systemd, not orphaned.
api_pid="$(ss -tlnp 2>/dev/null | awk -F'pid=' '/:3008 /{print $2}' | awk -F',' '{print $1}' | head -1)"
if [ -n "$api_pid" ] && [ "$api_pid" != "0" ]; then
  cg="$(cat "/proc/$api_pid/cgroup" 2>/dev/null || true)"
  if printf '%s' "$cg" | grep -q "system.slice/xyzo-api.service"; then
    echo "  ✓ PID $api_pid is in systemd cgroup"
  else
    echo "  ⚠ PID $api_pid is NOT in xyzo-api.service cgroup: $cg"
  fi
fi

echo
echo "── Done ──"
echo "  Static frontend (public_html/) is already served from disk by Caddy."
echo "  Hard-refresh your browser (Ctrl/Cmd+Shift+R) to see the new UI."
