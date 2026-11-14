# Fetch Outage — 2026-09-29

**Symptom:** the map showed ~155 articles for today instead of the usual ~50k.
**Duration:** ~26 h (2026-09-28 16:00 → 2026-09-29 18:30 PDT).
**Severity:** every newly fetched article was invisible; ~75k rows stranded.

---

## What was actually broken

Fetch was **not** down. It was the *stage after* fetch that never ran.

| Layer | State during the outage |
|---|---|
| `fetch` | ✅ inserting — 57k articles/day, normal rate |
| `auto_categorize` | ❌ never called — `max(auto_categorized_at)` frozen 20 h in the past |
| `geocode` / `cluster` | ❌ never called |
| Articles at `status='pending'` | 75,969 (none have coordinates) |
| Articles on today's map | 58 |

Because `auto_categorize` writes `extracted_lat` / `extracted_lng` and flips
`status` to `'extracted'`, nothing fetched during the outage ever got
coordinates — and the map only serves rows with coordinates.

---

## Root cause

`worker/fetch.py` → `fetch_all()` restructured its claim loop on 2026-09-28
(commit `e853efb`, "fetch lease batching"):

```python
while True:
    sources = _claim_sources_due(cur)      # up to CLAIM_BATCH_SIZE (200)
    if not sources:
        break
    _run_batch(sources)
    if len(sources) < CLAIM_BATCH_SIZE:
        break        # "claimed everything due — sweep complete"
```

**That exit is unreachable.** It assumes the claimable pool drains within one
sweep. It does not:

* `RECENT_SUCCESS_WINDOW_S = 300` — a source is claimable again **5 minutes**
  after it succeeds.
* Sweeping the whole ~3,690-source fleet takes **15–40 minutes**.

So by the time the sweep wraps, the sources polled at the start are due again,
every claim returns a full batch of 200, and **`fetch_all()` never returns**.

`worker/run.py` runs exactly one cycle (`main()` returns 0, no outer loop) and
calls `fetch` *before* `auto_categorize` / `geocode` / `cluster`. With `fetch`
never returning, the process sat inside step 1 forever.

### Evidence

```
source_poll_observations, last hour:  10,624 polls / 2,234 distinct sources
                                       (some sources polled 5×/hour)
max(auto_categorized_at):             2026-09-28 21:35 — frozen 20 h
pending backlog:                       75,969
service uptime:                        "1 day 1h"  ← worker.run never exited,
                                                     so fetch never returned
```

The last line is the giveaway: `worker.run` runs **one cycle and exits**, so
two services sitting at 1-day uptime with an empty journal meant step 1 had
never completed since the 16:00 restart.

---

---

## Fix

### 1. `worker/fetch.py` — explicit, provable sweep termination

* Track `seen: set[int]` of source ids **this** `fetch_all()` call has polled.
* A claim that yields only already-seen sources means the fleet wrapped → break.
* Re-claimed sources have their lease handed straight back
  (`_release_lease`, `reset_polled=False`) instead of being re-polled.
* `FETCH_MAX_CLAIMED_PER_SWEEP` (env `FETCH_MAX_CLAIMED_PER_SWEEP`, default
  8000) as a hard backstop.

Termination is now provable: `seen` only grows and ids come from a finite set,
so the loop must end.

### 2. `worker/health_monitor.py` — pipeline-stage freshness

New `pending_backlog` / `autocat_last_30m` / `autocat_stale_minutes` stats and
a `pipeline_stuck()` predicate: **backlog > 1000 AND auto_categorize silent for
30+ min**. It requires *both*, so an idle-but-healthy system never alerts.
Folds into `has_problems`, so `--cron` exits non-zero.

### 3. Runaway queries cancelled

Three `SELECT DISTINCT ON (h.host) … image_url` queries from
`/var/www/vhosts/hivv.org/api/server.js` (same `xyzo_app` DB) had been pegging
**3 Postgres backends at 99.9% CPU for 19.5 h**. The query cross-joins every
host against every article with a per-row regex — it is not indexed and will
not finish in sane time. Cancelled via `pg_cancel_backend`. **Still needs an
upstream fix in hivv.org.**

---

## Tests

`worker/tests/test_fetch_smart_policy.py::TestSweepTermination` drives
`fetch_all()` against a claimable pool that *never drains* — the exact
production condition — with a tripwire so a non-terminating loop fails instead
of hanging.

Verified it actually catches the bug:

```
# against the ORIGINAL fetch.py (fix stashed):
AssertionError: fetch_all() did not terminate
FAILED TestSweepTermination::test_terminates_when_claimable_pool_never_drains

# against the fixed fetch.py:
21 passed   worker/tests/test_fetch_smart_policy.py + test_fetch_lease.py
 6 passed   worker/tests/test_health_monitor_pipeline.py
11 passed   tests/test_health_monitor.py
```

---

## Recovery performed (2026-09-29 18:30 PDT)

1. Diagnosed; cancelled the 3 runaway queries (freed ~3 cores).
2. Fixed `fetch.py` + added regression tests.
3. Added `pipeline_stuck()` health check + tests.
4. Drained the 75k backlog out-of-band (`auto_categorize.run`), since the two
   root-owned services only reload Python at restart.

Observed while draining: today's on-map articles **58 → 5,291** and climbing.

---

## Remaining / follow-up

1. **Restart the fetchers to pick up the fix** (requires root — the fix is on
   disk but the running processes loaded the old module):
   ```bash
   sudo systemctl restart xyzo-fast-fetcher xyzo-fetcher
   ```
2. **Fix the hivv.org image-host query** — it will re-burn 3 cores otherwise.
3. ~~`/var/log/xyzo-health.log` unwritable~~ ✅ **fixed 2026-09-29.** Every xyzo
   cron line redirected into `/var/log`, which the non-root `asher` crontab
   cannot create files in — and because a failed redirection aborts the command,
   `health_monitor` (*/5), `timer_watchdog` (*/5) and `health_monitor
   --cpu-guard` (*/2) had **never executed at all**. Verified with the exact
   cron command: `cannot create /var/log/xyzo-health.log: Permission denied`,
   exit 2, monitor never ran. Redirects repointed to
   `/var/www/vhosts/xyzo.org/logs/`; both now exit 0 and write output. Crontab
   backed up to `/tmp/crontab.backup.20260929-185104`.
4. `auto_categorize.run_batch()` (the documented ~10× faster bulk path) is
   **never called** by the pipeline — either wire it up or delete it.


## Why nothing alerted for 26 hours

`worker/health_monitor.py` watched only the **fetch layer** — stale leases,
robots staleness, error counts, `fetched_last_hour`. All of those were green,
because fetch genuinely was healthy. Nothing measured the freshness of the
stage *after* fetch, and the units log at INFO while the root logger has no
handler, so `journalctl -u xyzo-fast-fetcher` was empty by default.
