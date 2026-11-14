#!/usr/bin/env bash
# ── xyzo idle worker ────────────────────────────────────────────────
# Runs as a systemd service. Monitors CPU/GPU usage and triggers
# background work when the system is idle for 30+ minutes.
#
# This ensures we're always fetching and processing articles when
# the server has spare capacity.

set -euo pipefail

WORKDIR="/var/www/vhosts/xyzo.org"
LOG="/var/log/xyzo/idle-worker.log"
DB_DSN="${XYZO_DB_DSN:-postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo}"
IDLE_THRESHOLD=30  # Minutes of idle before triggering work
CHECK_INTERVAL=60  # Check every 60 seconds

mkdir -p /var/log/xyzo

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"
}

runpsql() {
  psql "$DB_DSN" -t -A -c "$1" 2>&1
}

get_cpu_idle() {
  # Get CPU idle percentage from /proc/stat
  local cpu_line
  cpu_line=$(head -1 /proc/stat)
  local cpu_vals
  cpu_vals=($cpu_line)
  # user, nice, system, idle, iowait, irq, softirq, steal
  local idle=${cpu_vals[4]}
  local total=0
  for val in "${cpu_vals[@]:1}"; do
    total=$((total + val))
  done
  if [[ $total -gt 0 ]]; then
    echo $((idle * 100 / total))
  else
    echo 100
  fi
}

get_gpu_util() {
  # Get GPU utilization from nvidia-smi (returns 0 if no GPU)
  if command -v nvidia-smi &>/dev/null; then
    nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -1 || echo 0
  else
    echo 0
  fi
}

is_idle() {
  local cpu_idle gpu_util
  cpu_idle=$(get_cpu_idle)
  gpu_util=$(get_gpu_util)
  
  # Idle if CPU idle > 70% AND GPU util < 30%
  if [[ $cpu_idle -gt 70 && $gpu_util -lt 30 ]]; then
    return 0
  fi
  return 1
}

do_work() {
  local work_type="$1"
  local cpu_cap_threads="${2:-4}"  # 4 threads = 50% on 8-core CPU; 6 threads = 75% on 8-core CPU
  
  case "$work_type" in
    "fetch")
      log "Running fetch cycle (CPU cap: ${cpu_cap_threads} threads)..."
      cd "$WORKDIR"
      nice -n 15 python3 -m worker.run --limit 60 2>&1 | tail -3 | while read -r line; do
        log "  $line"
      done
      ;;
    "discover")
      log "Running discovery for under-covered major city (pop > 100k)..."
      local city_info
      city_info=$(runpsql "
        SELECT (c.lng - 0.15) || ',' || (c.lat - 0.15) || ',' || (c.lng + 0.15) || ',' || (c.lat + 0.15) || '|' || c.name
        FROM world_cities c
        LEFT JOIN news_sources s ON s.primary_city_id = c.id
        WHERE c.population > 100000
        GROUP BY c.id, c.name, c.population, c.lat, c.lng
        ORDER BY COUNT(s.id) ASC, c.population DESC
        LIMIT 1;
      " 2>/dev/null || echo "")

      if [[ -n "$city_info" ]]; then
        local bbox="${city_info%%|*}"
        local city="${city_info##*|}"
        IFS=',' read -r min_lng min_lat max_lng max_lat <<< "$bbox"
        log "  Discovering sources for $city ($bbox)"
        cd "$WORKDIR"
        nice -n 15 python3 -m worker.explore_region "$min_lng" "$min_lat" "$max_lng" "$max_lat" --auto-add 2>&1 | tail -5 | while read -r line; do
          log "    $line"
        done
      fi
      ;;
    "extract")
      log "Running AI extraction on pending articles (CPU limit: ${cpu_cap_threads} threads)..."
      cd "$WORKDIR"
      nice -n 15 python3 -m worker.run --step extract --limit 40 2>&1 | tail -3 | while read -r line; do
        log "  $line"
      done
      ;;
  esac
}

log "═══ XYZO IDLE WORKER & CPU GOVERNOR STARTED ═══"
log "Active Mode: Capped to 50% CPU capacity (4/8 cores reserved 100% for user)"
log "Idle Mode: Triggers up to 70% CPU usage after 30+ minutes of idle time"

idle_counter=0
last_work_time=0

while true; do
  sleep "$CHECK_INTERVAL"
  
  if is_idle; then
    idle_counter=$((idle_counter + 1))
    idle_minutes=$((idle_counter * CHECK_INTERVAL / 60))
    
    if [[ $idle_minutes -ge $IDLE_THRESHOLD ]]; then
      current_time=$(date +%s)
      time_since_last=$((current_time - last_work_time))
      
      # Only do work if we haven't done any in the last 30 minutes
      if [[ $time_since_last -ge 1800 ]]; then
        log "System idle for ${idle_minutes}m. Triggering 70% CPU boost mode for background processing..."
        
        # Check article count
        article_count=$(runpsql "SELECT COUNT(*) FROM news_articles;" 2>/dev/null || echo "0")
        log "Current article count: $article_count"
        
        # Choose work type based on what's needed (boosted to 6 threads / 70% capacity)
        if [[ $article_count -lt 1500 ]]; then
          do_work "fetch" 6
          do_work "extract" 6
        else
          if [[ $((RANDOM % 2)) -eq 0 ]]; then
            do_work "fetch" 6
          else
            do_work "discover" 6
          fi
        fi
        
        last_work_time=$(date +%s)
        idle_counter=0
      fi
    fi
  else
    if [[ $idle_counter -gt 0 ]]; then
      log "System active (user active / CPU load present). Restoring 50% reserved headroom for user."
    fi
    idle_counter=0
  fi
done
