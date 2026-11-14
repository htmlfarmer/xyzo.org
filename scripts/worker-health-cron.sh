#!/bin/bash
# Worker health cron job - runs every 5 minutes
# Auto-clears stale leases if worker crashes

export XYZO_DB_DSN="postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo"

LOG_FILE="/var/log/xyzo-health.log"
MAX_STALE_LEASES=100  # Auto-fix if > 100 stale leases

cd /var/www/vhosts/xyzo.org

python3 -m worker.health_monitor >> "$LOG_FILE" 2>&1

# Check if we need to auto-fix
STALE=$(python3 -c "
from worker.db import connect
with connect() as conn, conn.cursor() as cur:
    cur.execute('''
        SELECT COUNT(*) as count
        FROM news_sources
        WHERE fetch_in_progress = TRUE
          AND (lease_token IS NULL OR lease_expires_at < now())
    ''')
    print(cur.fetchone()['count'])
" 2>&1)

if [ "$STALE" -gt "$MAX_STALE_LEASES" ]; then
    echo "$(date): Auto-clearing $STALE stale leases" >> "$LOG_FILE"
    python3 -m worker.health_monitor --fix >> "$LOG_FILE" 2>&1
    
    # Check if worker needs restart
    WORKER_PID=$(pgrep -f "worker.run --fast" | head -1)
    if [ -z "$WORKER_PID" ]; then
        echo "$(date): Worker not running, restarting..." >> "$LOG_FILE"
        systemctl restart xyzo-fast-fetcher >> "$LOG_FILE" 2>&1
    fi
fi

# Keep log small
tail -n 100 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
