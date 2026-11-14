#!/usr/bin/env bash
# ── xyzo emergency stop ─────────────────────────────────────────────
# Stops all automation workers immediately.
# Run: sudo ./scripts/emergency-stop.sh
# Or:  sudo bash scripts/emergency-stop.sh

echo "═══ XYZO EMERGENCY STOP ═══"

# Stop timers
echo "Stopping timers..."
systemctl stop xyzo-nightly.timer 2>/dev/null && echo "  ✓ xyzo-nightly.timer stopped" || echo "  - xyzo-nightly.timer not running"
systemctl stop xyzo-fetcher.timer 2>/dev/null && echo "  ✓ xyzo-fetcher.timer stopped" || echo "  - xyzo-fetcher.timer not running"
systemctl stop xyzo-fast-fetcher.timer 2>/dev/null && echo "  ✓ xyzo-fast-fetcher.timer stopped" || echo "  - xyzo-fast-fetcher.timer not running"

# Stop services
echo "Stopping services..."
systemctl stop xyzo-idle-worker.service 2>/dev/null && echo "  ✓ xyzo-idle-worker stopped" || echo "  - xyzo-idle-worker not running"
systemctl stop xyzo-nightly.service 2>/dev/null && echo "  ✓ xyzo-nightly stopped" || echo "  - xyzo-nightly not running"
systemctl stop xyzo-api 2>/dev/null && echo "  ✓ xyzo-api stopped" || echo "  - xyzo-api not running"

# Kill any remaining worker processes
echo "Killing worker processes..."
pkill -f "worker.run" 2>/dev/null && echo "  ✓ worker.run killed" || true
pkill -f "worker.explore_region" 2>/dev/null && echo "  ✓ worker.explore_region killed" || true
pkill -f "worker.dispatcher" 2>/dev/null && echo "  ✓ worker.dispatcher killed" || true
pkill -f "worker.extract" 2>/dev/null && echo "  ✓ worker.extract killed" || true
pkill -f "idle-worker.sh" 2>/dev/null && echo "  ✓ idle-worker.sh killed" || true
pkill -f "nightly-automation.sh" 2>/dev/null && echo "  ✓ nightly-automation.sh killed" || true

sleep 2

# Verify
echo ""
echo "═══ STATUS ═══"
echo "Timers:"
systemctl is-active xyzo-nightly.timer xyzo-fetcher.timer xyzo-fast-fetcher.timer 2>&1 | paste - - -
echo ""
echo "Services:"
systemctl is-active xyzo-api xyzo-idle-worker.service 2>&1 | paste - - -
echo ""
echo "Worker processes:"
pgrep -af "worker\." 2>/dev/null || echo "  None running"

echo ""
echo "═══ ALL STOPPED ═══"
echo ""
echo "To restart everything:"
echo "  sudo systemctl start xyzo-api"
echo "  sudo systemctl start xyzo-fast-fetcher.timer"
echo "  sudo systemctl start xyzo-fetcher.timer"
echo "  sudo systemctl start xyzo-nightly.timer"
echo "  sudo systemctl start xyzo-idle-worker.service"
