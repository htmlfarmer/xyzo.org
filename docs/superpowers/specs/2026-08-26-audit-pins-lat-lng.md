# Xyzo — Audit & Fix Misplaced Pins (lat/lng) via Non-AI Title Detection

**Date:** 2026-08-26
**Status:** Approved (post-brainstorm)
**Author:** Brainstorming session

## Goal

Audit every row in `pins` and, using only **non-AI** keyword/entity matching, move any pin whose lat/lng does not match the city (or country) named in the pin's `title`. Use the existing `cities_text.find_cities_in_text()` detector as the source of city truth. Log every change to a JSONL audit file so the operation is fully reversible.

This is a backfill, not a live behavior change. The map UI, the API, and the worker extraction pipeline are untouched. Only `pins.location` / `location_precision` / `confidence_score` are updated.

## Decisions captured in brainstorming

| Question | Answer |
|---|---|
| Target table | `pins` (current map table) |
| Miss heuristic | All four: title-city mismatch, distance > 100km, source-country mismatch, low confidence flag |
| Distance threshold | 100 km |
| Execution mode | Auto-apply with audit log (no dry-run gating) |
| Approach | Reusable module + CLI + worker hook (Approach B) |

## Architecture

### Files to create

- `worker/audit_locations.py` — main module
  - `audit_all_pins(*, limit=None, since=None, rules=None) -> list[Correction]` — read-only; returns proposed corrections
  - `apply_corrections(corrections, *, log_dir="data/audit-log") -> int` — applies, writes audit log
  - `revert_from_log(log_path) -> int` — inverse UPDATE from a JSONL log file
  - `cli()` — argparse entry point (called from `python -m worker.audit_locations …`)
- `data/audit-log/.gitkeep` — empty placeholder so the directory exists in git

### Files to modify

- `worker/run.py` — add an optional `audit-locations` step between `extract` and `publish`. Off by default; enabled by `--audit-locations` flag. No changes to default behavior.

### Files NOT touched

- `worker/cities_text.py` — reuse `find_cities_in_text()` and `stats()` as-is
- `worker/db.py` — reuse `connect()` as-is
- All API, schema, and frontend code — this is a backfill

### Reused primitives

- `cities_text.find_cities_in_text(title, min_population=100_000)` — non-AI city detection
- `cities_text._Index` (already lazy-loaded from `world_cities`)
- `worker/db.py:connect()` — psycopg context manager
- PostGIS `ST_Distance` / `ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography` for distance and updates
- `data/entity_locations.json` — already loaded by `cities_text`; covers company-HQ matches

## Data flow

```
CLI: python -m worker.audit_locations --apply [--since 2026-01-01] [--limit N]
                    │
                    ▼
1. SELECT pins + source country
   ┌────────────────────────────────────────────────────────────┐
   │ SELECT p.id, p.title,                                      │
   │        ST_Y(p.location::geometry) AS lat,                 │
   │        ST_X(p.location::geometry) AS lng,                 │
   │        p.location_precision, p.confidence_score,          │
   │        s.country_code AS source_country,                  │
   │        s.id AS source_id, p.created_at                    │
   │   FROM pins p                                              │
   │   LEFT JOIN news_sources s ON s.id = p.source_id          │
   │  WHERE p.status = 'published'                              │
   │    AND ($since IS NULL OR p.created_at >= $since::date)   │
   │  ORDER BY p.id ASC                                         │
   │  LIMIT $limit                                              │
   └────────────────────────────────────────────────────────────┘
                    │
                    ▼
2. Per pin: cities_text.find_cities_in_text(title, min_population=100_000)
   Pick the highest-population match (ties broken by: kind='name' > 'alias' > 'entity').
   Skip if no match, or if the chosen match has confidence == 'low'.
                    │
                    ▼
3. Apply miss rules (any one fires ⇒ correction)
   ┌────────────────────────────────────────────────────────────┐
   │ R1 distance:                                              │
   │   ST_Distance(                                            │
   │     pin.location,                                         │
   │     ST_SetSRID(ST_MakePoint(detected.lng, detected.lat), │
   │                 4326)::geography)                         │
   │   > 100000  (meters)                                      │
   │                                                            │
   │ R2 country≠source:                                        │
   │   pin's nearest world_cities country_code                 │
   │      != source.country_code                               │
   │   AND source.country_code IS NOT NULL                     │
   │                                                            │
   │   Catches the case where a Bangladesh source (BD) has a   │
   │   pin placed in Tokyo (JP). Source country and pin's      │
   │   actual country disagree.                                 │
   │                                                            │
   │ R3 low-confidence flag:                                   │
   │   pin.confidence_score < 0.5                              │
   │   AND detected kind in ('name', 'alias', 'entity')        │
   │                                                            │
   │ R4 title mismatch:                                        │
   │   pin's nearest world_cities country_code                 │
   │      != detected city country_code                        │
   │                                                            │
   │   Implementation: query world_cities for the row whose    │
   │   lat/lng is closest to (pin.lat, pin.lng) (Haversine),   │
   │   read its country_code, compare to detected.             │
   │                                                            │
   │ (R4 is the loosest — if R1 fires, R4 also fires. We pick  │
   │  R1 as the canonical signal when both apply.)              │
   └────────────────────────────────────────────────────────────┘
                    │
                    ▼
4. Idempotency check — read today's JSONL log, skip pin_ids already corrected
                    │
                    ▼
5. UPDATE pins SET location = ST_SetSRID(..., 4326)::geography,
                   location_precision = 'city',
                   confidence_score = LEAST(old_confidence, 0.85),
                   updated_at = now()
   WHERE id = $pin_id
   (Use LEAST() so we never raise a low-confidence pin above its original
   confidence; we only ever lower.)
                    │
                    ▼
6. Append JSONL line: {ts, pin_id, title, before, after, detected, rules_fired, source}
```

### precision / confidence policy

| Pin was | We set | Reason |
|---|---|---|
| `exact` | `city` | We can't claim exact precision from a title-only match |
| `city` | `city` | No change in precision category |
| `region` / `country` | `city` | If a more specific city is named in the title, upgrade |
| `confidence >= 0.5` | `LEAST(old, 0.85)` | Cap at the city-precision convention |
| `confidence < 0.5` | `old` (unchanged) | Don't accidentally raise a flag we set deliberately |

## Audit log

**Path:** `data/audit-log/pins-location-fix-YYYY-MM-DD.jsonl`

**One JSON object per line:**

```json
{
  "ts": "2026-08-26T14:23:01.123Z",
  "pin_id": 12345,
  "title": "No rush for Bangladesh PM Tarique Rahman's India visit...",
  "before": {
    "lat": 12.34,
    "lng": 56.78,
    "precision": "city",
    "confidence": 0.95,
    "country": null
  },
  "after": {
    "lat": 23.8103,
    "lng": 90.4125,
    "precision": "city",
    "confidence": 0.85,
    "country": "BD",
    "place_name": "Dhaka"
  },
  "detected": {
    "city": "Dhaka",
    "country": "BD",
    "population": 8906039,
    "kind": "name"
  },
  "rules_fired": ["distance>100km", "country≠source"],
  "source": {"id": 42, "country": "BD"}
}
```

**Idempotency:** before any UPDATE, read today's JSONL log (if it exists) and build a `set` of already-corrected `pin_id`s. Skip those.

**Append-only:** the file is opened in `'a'` mode; each run appends. Re-running the same day without `--revert` will not double-correct.

## Revert

```
python -m worker.audit_locations --revert data/audit-log/pins-location-fix-2026-08-26.jsonl
```

- Parse JSONL
- For each entry, run inverse UPDATE using `before.lat/lng/precision/confidence`
- Print summary: `"Reverted N pins. M pins not found (already changed since)."`

The revert reads the log; it does not write a new log entry. (If you re-apply after revert, a fresh log line is appended.)

## CLI

```
python -m worker.audit_locations [options]

  --apply              Make the changes (default if neither --apply nor
                       --revert is given: dry-run report only)
  --dry-run            Print summary, write nothing. Default if --apply absent.
  --limit N            Only audit the first N pins (default: all)
  --since YYYY-MM-DD   Only pins created on/after this date
  --rules R1,R2,...    Limit to specific rules:
                       distance, country, low_conf, title_mismatch
                       (default: all four)
  --revert PATH        Revert from a JSONL log file
  --batch-size N       Commit every N corrections in one transaction
                       (default: 100; transactions are atomic per batch)
  --log-dir PATH       Override audit log dir (default: data/audit-log/)
  -v / --verbose       Print per-pin decisions
```

**Default behavior (no flags):** dry-run, prints `N pins audited, M corrections proposed, K rules fired`. Reads world_cities, exits without writing.

## Worker integration

In `worker/run.py`, add a new step `audit-locations` after `extract`:

```python
def run(steps=None, audit_locations=False, ...):
    ...
    if "extract" in steps:
        run_extract()
    if audit_locations and "publish" in steps:
        from worker.audit_locations import audit_all_pins, apply_corrections
        corrections = audit_all_pins(since=today_iso)
        apply_corrections(corrections)
    if "publish" in steps:
        run_publish()
```

Default `audit_locations=False` — no behavior change for existing invocations. To enable, run: `./run.sh --audit-locations`.

## Testing

**Unit tests** in `worker/tests/test_audit_locations.py`:

| Test | Setup | Expected |
|---|---|---|
| `test_detect_miss_by_distance` | pin in Sydney (151, -33), title "Paris protests" | fires `distance>100km` |
| `test_detect_miss_by_country` | pin country=US, source country=US, title "Dhaka flood" | fires `country≠source` |
| `test_skip_when_close` | pin in Newark (40.7, -74.2), title "NYC news" | skipped (within 100km) |
| `test_skip_when_no_city_in_title` | title "Markets shrugged today" | skipped (no city detected) |
| `test_skip_when_only_low_conf_city` | title "Tiny hamlet Smithville news" | skipped (population < 100k) |
| `test_skip_when_confidence_above_threshold` | pin conf=0.9, title matches but < 100km | skipped |
| `test_low_confidence_flag` | pin conf=0.3, title "Tokyo summit" | fires `low_conf` |
| `test_idempotency` | run twice; second run makes no changes | log contains N entries after two runs |
| `test_revert` | apply N corrections, then revert | all N pins restored to `before.*` |
| `test_dry_run_no_writes` | `--dry-run` | no UPDATE issued, no JSONL written |
| `test_distance_calculation` | pin at (0,0), title "Paris" | distance > 100km from Paris (2.35, 48.85) |

Use a temporary SQLite-style mock or, if needed, a transactional test DB. Prefer the live DB with `BEGIN; … ROLLBACK;` for the apply test.

**Manual smoke test:**

```bash
# 1. Dry-run on 50 pins
python -m worker.audit_locations --dry-run --limit 50 2>&1 | head -30

# 2. Apply on 50 pins with verbose output
python -m worker.audit_locations --apply --limit 50 --verbose

# 3. Inspect the log
cat data/audit-log/pins-location-fix-$(date +%F).jsonl \
  | jq '.rules_fired' | sort | uniq -c

# 4. Confirm idempotency: re-run, should report 0 corrections
python -m worker.audit_locations --apply --limit 50

# 5. Revert
python -m worker.audit_locations --revert data/audit-log/pins-location-fix-$(date +%F).jsonl
```

## Out of scope

- Touching `news_articles` legacy table (handled by the live extraction pipeline)
- Touching `news_sources` lat/lng (sources are a different problem — different fix path)
- Re-geocoding via Nominatim (this spec is explicitly **non-AI**; Nominatim is the AI-tier fallback and we don't use it here)
- Auto-running on every extraction cycle (only on demand via `--audit-locations` flag)
- Building a UI to visualize corrections before applying (use the JSONL log + jq)

## Risks

- **False positives on regional stories.** A title that says "Texas" is not a city — `find_cities_in_text` will pick the highest-population city in the title's country match, which could be wrong for a statewide story. R1 (distance > 100km) catches most of these because the pin is roughly in the right place; R4 (title mismatch) is the rule most likely to false-positive on regional stories. If false-positives become a problem, add a `--rules` invocation that excludes `title_mismatch`.
- **Entity HQ matches.** `entity_locations.json` can map "Microsoft" → Redmond. If a story is *about* Microsoft but happened in London, the entity match could move the pin. Mitigation: entity matches have `kind='entity'` and the worker logs surface them; users can filter with `--rules distance` only.
- **Confidence demotion.** We never raise confidence above 0.85 for a city-level match. If a pin was previously an exact-precision match with confidence 1.0, we drop it to 0.85 — that's a signal to the UI that the placement is now lower-confidence.
- **Concurrent runs.** If two `audit_locations` invocations run on the same day, the JSONL-based idempotency check prevents double-correcting the same pin within one day. Cross-day runs require manual `--revert` + `--apply`.
