#!/usr/bin/env bash
# ── xyzo status ─────────────────────────────────────────────────────
# Shows what's running and current article counts.
# Run: ./scripts/status.sh

DB_DSN="${XYZO_DB_DSN:-postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo}"

echo "═══ XYZO STATUS ═══"
echo ""

echo "── Services ──"
for svc in xyzo-api xyzo-nightly.timer xyzo-fetcher.timer xyzo-fast-fetcher.timer xyzo-idle-worker.service; do
  status=$(systemctl is-active "$svc" 2>/dev/null || echo "not-found")
  printf "  %-30s %s\n" "$svc" "$status"
done

echo ""
echo "── Worker Processes ──"
pgrep -af "worker\." 2>/dev/null | sed 's/^/  /' || echo "  None running"

echo ""
echo "── Database ──"
articles=$(psql "$DB_DSN" -t -A -c "SELECT COUNT(*) FROM news_articles;" 2>/dev/null || echo "?")
sources=$(psql "$DB_DSN" -t -A -c "SELECT COUNT(*) FROM news_sources WHERE active=TRUE;" 2>/dev/null || echo "?")
events=$(psql "$DB_DSN" -t -A -c "SELECT COUNT(*) FROM news_events;" 2>/dev/null || echo "?")
locations=$(psql "$DB_DSN" -t -A -c "SELECT COUNT(*) FROM news_locations;" 2>/dev/null || echo "?")
printf "  %-20s %s\n" "Articles:" "$articles"
printf "  %-20s %s\n" "Active Sources:" "$sources"
printf "  %-20s %s\n" "Events:" "$events"
printf "  %-20s %s\n" "Locations:" "$locations"

echo ""
echo "── Recent Activity (24h) ──"
fetched=$(psql "$DB_DSN" -t -A -c "SELECT COUNT(*) FROM news_articles WHERE fetched_at > now() - interval '24 hours';" 2>/dev/null || echo "?")
extracted=$(psql "$DB_DSN" -t -A -c "SELECT COUNT(*) FROM news_articles WHERE auto_categorized_at > now() - interval '24 hours';" 2>/dev/null || echo "?")
searches=$(psql "$DB_DSN" -t -A -c "SELECT COUNT(*) FROM news_search_log WHERE created_at > now() - interval '24 hours';" 2>/dev/null || echo "?")
printf "  %-20s %s\n" "Fetched:" "$fetched"
printf "  %-20s %s\n" "Categorized:" "$extracted"
printf "  %-20s %s\n" "Searches:" "$searches"

echo ""
echo "── System Load ──"
cpu_idle=$(awk '/^cpu / {idle=$5; total=0; for(i=2;i<=NF;i++) total+=$i; print int(idle*100/total)}' /proc/stat)
printf "  %-20s %s%%\n" "CPU Idle:" "$cpu_idle"
if command -v nvidia-smi &>/dev/null; then
  gpu_util=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -1 || echo "?")
  printf "  %-20s %s%%\n" "GPU Util:" "$gpu_util"
else
  printf "  %-20s %s\n" "GPU:" "Not available"
fi

echo ""
echo "── Next Scheduled Runs ──"
systemctl list-timers xyzo-*.timer --no-pager 2>/dev/null | grep -E "xyzo|NEXT" || echo "  No timers found"

echo ""
echo "═══════════════════════════════"
