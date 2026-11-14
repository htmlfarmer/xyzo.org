# XYZO Maintenance Notes
## 2026-09-21: Database Vacuum & Backup Setup

### What was done:
- **Vacuumed 136 tables** that had never been vacuumed
- **Key fixes**: news_articles (153K dead rows), news_events (32K), news_article_cities (27K)
- Created `vacuum_check.sh` — auto-fixes tables with >10% dead tuples
- Created `backup.sh` — smart backup (schema + recent 24h data + code + .env)
- Cron: vacuum every 6h, backup daily at 3am (7-day rotation)

### Important notes:
- Some tables are owned by `postgres` user (not xyzo_app) — vacuum script handles this with sudo fallback
- Tables like `classifier_runs`, `companies`, `crawl_events` etc. need `sudo -u postgres` for vacuum
- Database user: `xyzo_app`, password in `/var/www/vhosts/xyzo.org/api/.env`
- Backup location: `/var/backups/xyzo/`

### Quick commands:
```bash
# Manual vacuum check
/var/www/vhosts/xyzo.org/scripts/vacuum_check.sh

# Manual backup
/var/www/vhosts/xyzo.org/scripts/backup.sh

# Check dead tuples
psql -h localhost -U xyzo_app -d xyzo -c "SELECT relname, n_dead_tup, n_live_tup FROM pg_stat_user_tables WHERE n_dead_tup > 1000 ORDER BY n_dead_tup DESC;"

# Check backup files
ls -lh /var/backups/xyzo/
```
