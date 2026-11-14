# XYZO OBSERVABILITY MASTER PLAN

## Current State: What We Can See

### Available Metrics
| Metric | Source | Granularity | Alerting |
|--------|--------|-------------|----------|
| Database size | pg_database_size | Manual | ❌ |
| Table sizes | pg_total_relation_size | Manual | ❌ |
| Index scans | pg_stat_user_indexes | Manual | ❌ |
| Dead tuples | pg_stat_user_tables | Manual | ❌ |
| API latency | news_performance_metrics | Per-request | ❌ |
| Source fetch success | source_poll_observations | Per-fetch | ❌ |
| User interactions | news_interactions | Per-event | ❌ |
| Error count | news_client_errors | Per-error | ❌ |

### Missing Critical Metrics

| Metric | Why Needed | Collection Method |
|--------|------------|-------------------|
| Query performance | Find slow queries | pg_stat_statements |
| Connection pool | Detect connection exhaustion | pg_stat_activity |
| API error rates | Detect service degradation | Application logging |
| Model accuracy | Detect model drift | Prediction logging |
| Cache hit rates | Optimize caching | Application counters |
| Worker utilization | Detect bottlenecks | Process monitoring |
| Disk I/O | Detect storage pressure | OS metrics |
| Memory usage | Detect memory leaks | Process monitoring |

---

## Proposed Observability Stack

### Tier 1: Database Monitoring (Immediate)

**1. Enable pg_stat_statements**
```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```
- Tracks all SQL queries with timing
- Identifies top 100 expensive operations
- No application code changes needed

**2. Add Connection Pool Monitoring**
```sql
-- Monitor active connections
SELECT state, COUNT(*) FROM pg_stat_activity WHERE datname = 'xyzo' GROUP BY state;
```
- Alert if active > 20 (of 100 max)
- Alert if idle > 50 (wasted resources)

**3. Add Dead Tuple Monitoring**
```sql
-- Monitor vacuum health
SELECT relname, n_dead_tup, n_live_tup, 
       CASE WHEN n_live_tup > 0 THEN ROUND(n_dead_tup::numeric/n_live_tup*100,2) ELSE 0 END as dead_pct
FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY n_dead_tup DESC;
```
- Alert if dead_pct > 10%
- Trigger manual VACUUM if needed

### Tier 2: API Monitoring (This Week)

**4. Add Request/Response Logging**
- Log all API requests with timing
- Track error rates per endpoint
- Monitor response sizes

**5. Add Health Check Dashboard**
- `/api/health` already exists
- Add to Grafana dashboard
- Alert if health.ok = false

**6. Add Latency Histograms**
- Track p50, p95, p99 for each endpoint
- Alert if p95 > 2x baseline

### Tier 3: Application Monitoring (Next Week)

**7. Add Worker Utilization Metrics**
- Track jobs/minute per worker type
- Monitor queue depth
- Alert if queue age > 5 minutes

**8. Add Model Accuracy Monitoring**
- Log prediction confidence scores
- Compare with ground truth when available
- Alert if accuracy drops > 5%

**9. Add Cache Hit Rate Tracking**
- Track cache hits vs misses
- Optimize TTLs based on hit rates
- Alert if hit rate < 80%

### Tier 4: Business Metrics (This Month)

**10. Add User Engagement Metrics**
- Track search success rate
- Monitor article click-through rate
- Measure time on map

**11. Add Content Quality Metrics**
- Track geocoding confidence over time
- Monitor category distribution
- Alert if "other" category > 20%

**12. Add Source Health Metrics**
- Track source fetch success rates
- Monitor source freshness
- Alert if stale sources > 10%

---

## Alert Thresholds

### Critical (Page immediately)
- Database connections > 80
- API error rate > 5%
- Worker queue depth > 1000
- Model accuracy drop > 20%

### Warning (Notify within 1 hour)
- Dead tuples > 15%
- API p95 latency > 2x baseline
- Cache hit rate < 70%
- Source fetch success < 95%

### Info (Daily digest)
- New articles/day trend
- User engagement trend
- Model retraining status
- Backup completion

---

## Dashboard Layout

### Page 1: System Health
- Database size, connections, dead tuples
- API latency percentiles
- Worker utilization
- Error rates

### Page 2: Content Pipeline
- Articles ingested/day
- Geocoding success rate
- Category distribution
- Event clustering stats

### Page 3: Intelligence Models
- Model training status
- Prediction confidence distribution
- Accuracy metrics (when available)
- Drift indicators

### Page 4: User Engagement
- Active users
- Search success rate
- Article click-through
- Geographic distribution

---

## Implementation Roadmap

### Week 1
- [ ] Enable pg_stat_statements
- [ ] Add connection pool monitoring
- [ ] Create basic Grafana dashboard

### Week 2
- [ ] Add API request logging
- [ ] Add latency histograms
- [ ] Set up alerting rules

### Week 3
- [ ] Add worker utilization metrics
- [ ] Add cache hit rate tracking
- [ ] Create content pipeline dashboard

### Week 4
- [ ] Add model accuracy monitoring
- [ ] Add user engagement metrics
- [ ] Create intelligence models dashboard

---

## Success Criteria

After implementing this plan, XYZO will have:

1. **Full query visibility** — Every slow query identified
2. **Real-time alerting** — Problems detected in < 5 minutes
3. **Performance baselines** — Know what "normal" looks like
4. **Capacity planning** — Data-driven scaling decisions
5. **Model monitoring** — Detect drift before users notice

**Target: 99.9% uptime with < 5 minute detection of issues.**
