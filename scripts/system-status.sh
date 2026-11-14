#!/bin/bash
# XYZO System Status Check
# Run: bash /var/www/vhosts/xyzo.org/scripts/system-status.sh
export XYZO_DB_DSN="${XYZO_DB_DSN:-postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo}"
export PGPASSWORD="CHANGE_ME"

echo "═══════════════════════════════════════════════════════"
echo "  XYZO System Status — $(date)"
echo "═══════════════════════════════════════════════════════"

# ── API Health ────────────────────────────────────────────
echo ""
echo "── API Health ───────────────────────────────────────"
curl -s --max-time 5 http://localhost:3008/api/health 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'  API: {\"OK\" if d.get(\"ok\") else \"DOWN\"}')
q = d.get('queue',{})
print(f'  Queue: {q.get(\"state\",\"?\")}, workers: {q.get(\"activeWorkers\",\"?\")}/{q.get(\"poolSize\",\"?\")}')
running = q.get('jobsByKind',{}).get('running',{})
if running:
    print(f'  Running jobs: {list(running.keys())}')
" 2>/dev/null || echo "  API: UNREACHABLE (is it running on port 3008?)"

# ── Database Stats ─────────────────────────────────────────
echo ""
echo "── Database Stats ────────────────────────────────────"
python3 - <<'PYEOF'
import os
os.environ['XYZO_DB_DSN'] = os.environ.get('XYZO_DB_DSN', 'postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo')
from worker.db import connect
with connect() as conn:
    cur = conn.cursor()
    stats = {}
    for table, col in [
        ('news_articles', 'count'),
        ('news_events', 'count'),
        ('news_sources', 'count'),
        ('nn_article_embeddings', 'count'),
        ('nn_event_embeddings', 'count'),
        ('nn_hot_topics', 'count'),
        ('nn_prediction_cache', 'count'),
        ('nn_article_leaderboard_live', 'count'),
        ('news_story_links', 'count'),
        ('news_problems', 'count'),
    ]:
        try:
            cur.execute(f'SELECT count(*) FROM {table}')
            stats[table] = cur.fetchone()['count']
        except Exception as e:
            stats[table] = f'ERROR: {e}'
    
    for k, v in stats.items():
        if isinstance(v, int):
            bar = '█' * min(v // 1000, 50)
            print(f'  {k:35s} {v:>10,d} {bar}')
        else:
            print(f'  {k:35s} {str(v):>10s}')

    # Articles extracted vs pending
    cur.execute("SELECT status, count(*) FROM news_articles GROUP BY status")
    for row in cur.fetchall():
        print(f'  articles.{row["status"]}: {row["count"]:,}')
PYEOF

# ── System Resources ────────────────────────────────────────
echo ""
echo "── System Resources ──────────────────────────────────"
python3 - <<'PYEOF'
import os, subprocess, json

# CPU/memory
result = subprocess.run(['ps', 'aux'], capture_output=True, text=True)
lines = [l for l in result.stdout.split('\n') if 'xyzo' in l.lower() or 'worker' in l.lower() or 'python' in l.lower()]
print(f'  XYZO-related processes: {len(lines)}')

# GPU (nvidia-smi)
try:
    result = subprocess.run(['nvidia-smi', '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], 
                          capture_output=True, text=True, timeout=5)
    if result.returncode == 0:
        gpu_util, mem_used, mem_total, temp = result.stdout.strip().split(',')
        print(f'  GPU: {gpu_util.strip()}% util, {mem_used.strip()}/{mem_total.strip()} MB, {temp.strip()}°C')
except:
    print('  GPU: nvidia-smi not available')
PYEOF

# ── API Response Time ──────────────────────────────────────
echo ""
echo "── API Performance ───────────────────────────────────"
time_ms=$(curl -s --max-time 5 -o /dev/null -w "%{time_total}" "http://localhost:3008/api/pins/map?bbox=-180,-90,180,90&limit=50&light=1" 2>/dev/null)
if [ -n "$time_ms" ]; then
    ms=$(python3 -c "print(int($time_ms * 1000))")
    echo "  Map API (50 pins): ${ms}ms"
    if [ "$ms" -lt 500 ]; then
        echo "  Status: ✓ Within target (<500ms)"
    else
        echo "  Status: ⚠ Above target (>500ms)"
    fi
else
    echo "  Map API: UNREACHABLE"
fi

# ── Service Status ────────────────────────────────────────
echo ""
echo "── Services ──────────────────────────────────────────"
for svc in xyzo-api xyzo-fetcher xyzo-nn-infer xyzo-fast-fetcher xyzo-story-link; do
    status=$(systemctl is-active ${svc}.service 2>/dev/null || echo "unknown")
    if [ "$status" = "active" ]; then
        echo "  $svc: ✓ running"
    else
        echo "  $svc: ✗ $status"
    fi
done

echo ""
echo "═══════════════════════════════════════════════════════"
