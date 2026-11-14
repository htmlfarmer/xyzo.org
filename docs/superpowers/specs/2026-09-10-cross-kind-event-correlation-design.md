# Cross-Kind Event Correlation — Design

**Date:** 2026-09-10
**Status:** Draft (post-brainstorming)
**Owner:** Xyzo Dev
**Scope:** Sub-project B of the "signals, not sources" vision. A and C are separate specs.

## Purpose

Today, an event on the XYZO map is formed when `cluster.py` finds ≥2 articles sharing `(primary_location_id, event_type, ±6h)`. That works well for **same-kind** signals — five RSS articles about the same earthquake collapse to one pin.

It does **not** work when the signals are different kinds. A future state has seven signals about the same wildfire:

1. New satellite image
2. Wildfire sensor anomaly
3. Local weather observation
4. Emergency-management notice
5. Local Reddit discussion
6. Scientific researcher posting
7. Regional newspaper

Today those become up to seven separate pins (or one event + six orphans), because they don't share `event_type` or `location_id`. The user calls this the "signals, not sources" idea: XYZO should *discover* that apparently unrelated signals are the same event.

Sub-project A (signal_kind taxonomy + new sources) and sub-project C (UI surfacing) are separate specs. **This spec ships the correlation algorithm only.**

## User constraints (verbatim)

- "be careful not to break anything"
- "test first"
- "the really important idea for XYZO"
- "signals, not sources"
- "XYZO can discover that five apparently unrelated signals are actually the same event"

## Decisions locked during brainstorming

| Question | Decision |
|---|---|
| Scope decomposition | Three independent sub-projects. A, B, C. **B first** (this spec). |
| Matching anchor | **Entity-anchored.** Lean harder on existing `news_entities` + `news_event_entities`. |
| Rollout risk profile | **Additive layer, no behavior change today.** B only attaches articles to *existing* events; never creates events; never overrides a strong location+type match. |
| Matching rule | **Approach 2:** primary entity + headline n-gram Jaccard ≥ 0.3 + time window. Catches 1-entity global events (DeepSeek, Tesla) where pure 2-entity would miss. Tunable with one knob. |
| Schema on `news_event_sources` | Add `match_kind` column (recommended). Lets us audit "what fraction of joins came from B." |
| Rollout staging | Shadow (week 1) → Strict `JACCARD_MIN=0.5` (week 2) → Target `JACCARD_MIN=0.3` (week 3+). Env-var gated. |

## Architecture

```
fetch.py → extract.py → classify.py → auto_categorize.py
                                            ↓
                                     cluster.py            ← existing
                                  (location+type clustering, unchanged)
                                            ↓ writes news_events + news_event_sources (match_kind='location-type')
                                            ↓
                              entity_ngram_cluster.py     ← NEW (this spec)
                                  (primary entity + headline n-gram + time)
                                            ↓ ATTACH-only: writes news_event_sources (match_kind='entity-ngram')
                                            ↓ ghost-merges events that fall to 0 sources
                                            ↓
                                       news_events
```

### What B is allowed to do

- `INSERT INTO news_event_sources (event_id, article_id, match_kind='entity-ngram') ON CONFLICT DO NOTHING`
- `UPDATE news_events SET source_count = …, representative_headline = …, representative_entity = …` (recompute on a successful attach via existing `_rollup` pattern)
- `UPDATE news_events SET status='merged', merged_into_event_id=… WHERE id=<ghost_event>` (only when the old event has zero remaining sources)

### What B is **never** allowed to do

- Insert a new `news_events` row
- Update an existing `news_events` row's `headline`, `summary`, or `primary_location_id`
- Detach an article from an event that has `correlation_kind = 'location-type-match'` (the strong-match guardrail)
- Modify any row in `news_articles`, `news_locations`, `news_entities`, `news_event_locations`, `news_event_entities`, `news_event_topics`

This is the "additive" guarantee in code form.

## New files

| Path | Purpose | LOC |
|---|---|---|
| `api/schema-cross-kind-correlation.sql` | Migration: 4 new columns on `news_events`, 1 on `news_articles`, 1 on `news_event_sources`, 1 partial index. | ~25 |
| `worker/ngram.py` | Pure helper: bigrams + Jaccard. | ~30 |
| `worker/entity_ngram_cluster.py` | The orchestrator. Reads recently-clustered articles, finds candidate events, attaches via SQL. | ~150 |
| `worker/tests/test_ngram.py` | Pure unit tests. | ~40 |
| `worker/tests/test_entity_ngram_cluster.py` | DB-backed integration tests. | ~120 |

## Modified files

| Path | Edit | Net Δ |
|---|---|---|
| `worker/cluster.py` | Populate `representative_headline` + `representative_entity` on event create. Flip `correlation_kind` from `'location-type-new'` to `'location-type-match'` on first attach. Extend `_rollup` to refresh representative columns. | +12 |
| `worker/run.py` (or equivalent scheduler) | After `cluster.run(…)`, call `entity_ngram_cluster.run(…)`. | +3 |

## Schema

### `news_events` — 4 new columns

| Column | Type | Default | Purpose |
|---|---|---|---|
| `representative_headline` | `TEXT` | `NULL` | Cached headline of the highest-`location_confidence` source article. Used as the n-gram Jaccard target. |
| `representative_entity` | `TEXT` | `NULL` | Primary entity of the representative article. The fast lookup key. |
| `correlation_kind` | `TEXT NOT NULL` | `'location-type-new'` | How this event was formed: `'location-type-new'` (cluster.py created it), `'location-type-match'` (an article was attached via location+type), `'entity-ngram-merged'` (B attached an article). |
| `merged_into_event_id` | `BIGINT REFERENCES news_events(id)` | `NULL` | If `status='merged'`, the event this ghost was merged into. NULL for active events. |

### `news_articles` — 1 new column

| Column | Type | Default | Purpose |
|---|---|---|---|
| `correlation_attempted_at` | `TIMESTAMPTZ` | `NULL` | Last B attempt timestamp. The cursor for "what to process next." |

### `news_event_sources` — 1 new column

| Column | Type | Default | Purpose |
|---|---|---|---|
| `match_kind` | `TEXT NOT NULL` | `'location-type'` | How this source attached: `'location-type'` (cluster.py) or `'entity-ngram'` (entity_ngram_cluster.py). |

### Index

```sql
CREATE INDEX IF NOT EXISTS news_events_rep_entity_time_idx
    ON news_events (representative_entity, occurred_at DESC)
    WHERE status = 'active' AND representative_entity IS NOT NULL;
```

### Backfill (one-shot, idempotent)

```sql
UPDATE news_events e SET
    representative_headline = sub.title,
    representative_entity    = sub.primary_entity
FROM (
    SELECT DISTINCT ON (s.event_id)
        s.event_id,
        a.title,
        a.entities ->> 0 AS primary_entity
    FROM news_event_sources s
    JOIN news_articles a ON a.id = s.article_id
    ORDER BY s.event_id, a.location_confidence DESC NULLS LAST, a.id ASC
) sub
WHERE e.id = sub.event_id
  AND e.representative_headline IS NULL;
```

All existing rows get `correlation_kind = 'location-type-new'` (the default). We do not pretend to know which articles originally matched — that's accurate; cluster.py's location+type path created them.

## Data flow

### End-to-end, one article

1. `extract.py` writes `A.entities = ["Tesla", "Elon Musk", "Model Y"]`, `A.event_type = "business"`, `A.location_id = 537` (Fremont, CA), `A.location_confidence = 0.9`.
2. `cluster.py` (unchanged):
   - **Strong match:** active event `E_strong` at `location_id=537` with `event_type='business'` within ±6h → `INSERT INTO news_event_sources (E_strong, A, match_kind='location-type')`. `E_strong.correlation_kind = 'location-type-match'`. **B will skip A.**
   - **No match:** `INSERT INTO news_events … representative_headline=A.title, representative_entity='Tesla', correlation_kind='location-type-new'`. **B will consider A.**
3. `entity_ngram_cluster.py` (NEW) — for each article A in `clustered_at > correlation_attempted_at OR correlation_attempted_at IS NULL`:
   - `primary_entity = A.entities[0]` → `"Tesla"`.
   - Look up the `correlation_kind` of A's current event. (Today `cluster.py` attaches each article to exactly one event, so "the current event" is unambiguous. If that ever changes, this guardrail needs to become "skip if ANY of A's current events has a strong match.")
   - **Guardrail:** if `correlation_kind = 'location-type-match'`, mark `correlation_attempted_at` and skip.
   - Query candidate events: `WHERE representative_entity = 'Tesla' AND |occurred_at - A.ref_time| ≤ 6h AND status='active'`, top 5 by `occurred_at DESC`.
   - In Python, compute `jaccard(A.title, candidate.representative_headline)` for each. Pick best by `(jaccard, |Δt|)`.
   - If best `jaccard ≥ JACCARD_MIN` (default 0.3) **and** best event ≠ A's current event:
     - `INSERT INTO news_event_sources (best.id, A.id, match_kind='entity-ngram') ON CONFLICT DO NOTHING`
     - Re-run rollup on `best.id` (refreshes `source_count`, `avg_confidence`, `representative_headline`, `representative_entity` if the new article is higher-confidence).
     - If A's old event now has zero sources: `UPDATE news_events SET status='merged', merged_into_event_id=best.id WHERE id=<old_event>`.
   - Mark `A.correlation_attempted_at = now()`.

### N-gram helper (`worker/ngram.py`)

```python
_TOKEN_RE = re.compile(r"[a-z0-9]+")
_STOP = frozenset({"the","a","an","of","to","in","on","for","with","at","by","is",
                   "are","was","were","be","been","being","and","or","but","as","it",
                   "its","this","that","from","into","over","after","before"})

def bigrams(text: str) -> frozenset[str]:
    if not text:
        return frozenset()
    toks = [t for t in _TOKEN_RE.findall(text.lower()) if t not in _STOP and len(t) > 1]
    if len(toks) < 2:
        return frozenset(toks)
    return frozenset(f"{a}_{b}" for a, b in zip(toks, toks[1:]))

def jaccard(a: str | None, b: str | None) -> float:
    ba, bb = bigrams(a), bigrams(b)
    if not ba or not bb:
        return 0.0
    return len(ba & bb) / len(ba | bb)
```

## Tests

### `worker/tests/test_ngram.py` (pure, no DB)

- `test_bigrams_empty` → `""` → empty frozenset
- `test_bigrams_single_token` → `"Tesla"` → `{"tesla"}`
- `test_bigrams_stops_and_punct` → `"Tesla, Inc. releases Model-Y!"` → contains `{"tesla_releases","releases_model","model_y"}`, no `inc_*`
- `test_bigrams_lowercase` → `"TESLA Model"` → `{"tesla_model"}`
- `test_jaccard_identical` → 1.0
- `test_jaccard_disjoint` → 0.0
- `test_jaccard_partial` → ≈ 0.5 for `("Tesla Model Y recall","Tesla Model 3 recall")`
- `test_jaccard_handles_none` → 0.0
- `test_jaccard_symmetric` → `jaccard(a,b) == jaccard(b,a)`

### `worker/tests/test_entity_ngram_cluster.py` (DB-backed)

- `test_no_entities_skips_article` — empty `entities` → no attach, `correlation_attempted_at` set
- `test_strong_match_skipped` — current event has `correlation_kind='location-type-match'` → no other attach
- `test_orphan_attaches_to_matching_event` — orphan matches active event ≥ 0.3 → attaches
- `test_below_threshold_no_attach` — same entity + time, headline bigrams disjoint → no attach
- `test_no_candidate_within_window` — entity exists, no candidate within ±6h → no attach
- `test_idempotent_rerun` — running twice doesn't double-attach
- `test_ghost_event_marked_merged` — orphan's old event becomes `status='merged'`, `merged_into_event_id` set
- `test_match_kind_recorded` — after attach, `news_event_sources.match_kind = 'entity-ngram'`
- `test_representative_entity_used_in_query` — candidates whose `representative_entity` ≠ article's primary entity are excluded

### `worker/tests/test_cluster.py` (extend existing)

- `test_create_event_populates_representative_columns`
- `test_join_event_flips_correlation_kind`
- `test_representative_updates_on_higher_confidence_source`

### Manual run book

```bash
# Pre-deploy snapshot
psql -c "SELECT correlation_kind, count(*) FROM news_events GROUP BY 1"

# Deploy
psql -f api/schema-cross-kind-correlation.sql
psql -c "UPDATE news_events SET representative_headline=…  # backfill
python3 -m worker.run --fast

# Post-deploy
psql -c "SELECT correlation_kind, count(*) FROM news_events GROUP BY 1"
psql -c "SELECT match_kind, count(*) FROM news_event_sources GROUP BY 1"

# Spot-check 3 entity-ngram-merged events:
psql -c "SELECT e.id, e.headline, e.representative_entity,
                array_agg(a.title ORDER BY s.match_kind, a.id) AS sources
         FROM news_events e
         JOIN news_event_sources s ON s.event_id = e.id
         JOIN news_articles a ON a.id = s.article_id
         WHERE e.correlation_kind = 'entity-ngram-merged'
         GROUP BY e.id LIMIT 3"
```

**Pass criteria:** zero event_count growth from the B path (B only attaches); ≥1 entity-ngram-merged event with ≥3 clearly-related sources; no false-positive ghost merges on events with >1 source.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ENTITY_NGRAM_ENABLED` | `true` | Master kill-switch. `false` skips the entire stage. |
| `ENTITY_NGRAM_SHADOW` | `false` | When `true`, log decisions but skip all writes (rolls back via setting to `false`). |
| `ENTITY_NGRAM_JACCARD_MIN` | `0.3` | Jaccard threshold. Stage 2 ships with `0.5`; lowers to `0.3` at Stage 3. |
| `ENTITY_NGRAM_WINDOW_HOURS` | `6` | Time window. Matches `cluster.py`'s `CLUSTER_WINDOW_HOURS`. |
| `ENTITY_NGRAM_BATCH` | `200` | Max articles per run. |

## Observability

### Per-run log (matches `cluster.py` style)

```python
log.info(
    "entity_ngram_cluster: pending=%d attached=%d skipped_strong=%d "
    "skipped_no_entity=%d ghosts_merged=%d errors=%d window=%dh jaccard>=%.2f",
    len(pending), s["attached"], s["skipped_strong"],
    s["skipped_no_entity"], s["ghosts_merged"], s["errors"],
    WINDOW_HOURS, JACCARD_MIN,
)
```

### Daily review query

```sql
SELECT e.id, e.representative_entity, e.headline, e.source_count,
       array_agg(a.title ORDER BY s.match_kind, a.id) AS source_titles
FROM news_events e
JOIN news_event_sources s ON s.event_id = e.id
JOIN news_articles a ON a.id = s.article_id
WHERE e.correlation_kind = 'entity-ngram-merged' AND e.status = 'active'
GROUP BY e.id
ORDER BY e.source_count DESC, e.first_reported_at DESC
LIMIT 10;
```

### Health check extension (`/api/health`)

```sql
SELECT correlation_kind, count(*) FROM news_events GROUP BY 1
```

Returned as `event_kinds: { "location-type-new": N, "location-type-match": N, "entity-ngram-merged": N }`.

## Rollback

| Depth | How |
|---|---|
| **Pause** | `ENTITY_NGRAM_ENABLED=false` and restart the worker. ~30 seconds. |
| **Revert merges** | `DELETE FROM news_event_sources WHERE match_kind='entity-ngram'` then `UPDATE news_events SET status='active', merged_into_event_id=NULL WHERE status='merged' AND merged_into_event_id IS NOT NULL`. cluster.py's next cycle restores source_count via `_rollup`. |
| **Hard revert** | `git revert` of the worker files + `DROP COLUMN` on the 4+1+1 new columns. All new columns are `NULL`-able except `correlation_kind` and `match_kind` which have defaults. |

## Error handling

| Failure | Behavior |
|---|---|
| `ngram.py` raises | Caught, treated as `jaccard = 0.0`, logged at WARN with truncated title + article_id. Stage continues. |
| DB connection drops mid-batch | Outer `run.py` retries the stage (existing pattern). |
| Per-article DB error | Caught inside the per-article loop; logged; `errors` counter incremented; next article continues. |
| Backfill partial failure | Idempotent (`WHERE … IS NULL`); re-run to finish. |
| Too many merges | Daily review surfaces it; tighten `JACCARD_MIN` or pause via env var. |

## Sacred files (explicitly NOT touched)

- `public_html/app.js` (~14K LOC)
- `api/src/routes/pins.ts` (complex SQL CTEs)
- `worker/auto_categorize.py` (1100+ LOC, 5-layer geolocation pipeline)
- `worker/fetch.py`, `worker/extract.py`, `worker/feeds.json`
- All other `api/src/routes/*` (UI surfacing is sub-project C)

## Out of scope (deferred to other specs)

- **Sub-project A** — signal taxonomy (article/paper/repo/model/satellite/sensor/etc.), new fetch handlers for GitHub/arXiv/USGS/Hugging Face/etc., ~300 new sources.
- **Sub-project C** — UI surfacing: signal-kind icons on pins, "5 signals → 1 event" badge, category filters, optional `correlation_kind` field on `/api/feed/live`.
- Embeddings-based correlation (Approach 3).
- Topic-slug-based correlation.
- Composite weighted score (entity + topic + embedding + spatial-temporal).
- Cross-region global events without entity overlap (e.g., a pure visual similarity match between a satellite image and a newspaper photo).

## Future Work — Relationship Layers Beyond B

B's MVP finds *one kind* of connection: same event, via shared primary entity + headline n-gram. The bigger ambition — "how is everything connected to everything else" — builds on the substrate B ships (entity-anchored joins, `match_kind` audit trail, `correlation_kind` per event) and adds the following layers. **None of this ships in B; sketched here so the design choices in B (column names, audit hooks, additive-only invariant) don't paint us into a corner.**

### L1 — Story↔Story cross-event links (extend `news_story_links`)

`news_story_links` already exists. New `link_type` values: `same_event_cross_event`, `same_topic_cross_event`, `related_via_entity`. Backed by a new endpoint `/api/feed/relationships?entity=X&topic=Y&min_weight=0.5`. Foundation for "this wildfire article relates to that policy article via shared entity 'Cal Fire'." Read-mostly; minimal schema cost.

### L2 — Cross-event relationship edges (new table `news_event_relationships`)

`(event_id_a, event_id_b, kind, confidence, evidence_json)`. Kinds: `led_to`, `is_part_of`, `responded_to`, `supersedes`, `contradicts`. Lets the UI draw "event A caused event B" arcs on the map. Source: candidate generation by co-occurrence of entities/topics within a temporal window, ranked by an AI pass.

### L3 — Causal-chain detection (algorithm on top of L2)

Scan `(event A, event B)` pairs where (a) A's entities overlap with B's, (b) `0 < occurred_at_B - occurred_at_A < 14 days`, (c) locations are related (same region, supply chain, or known chain). Output candidate causal edges with confidence. Gemma confirms or rejects each candidate. This is the "X caused Y" layer.

### L4 — Topic/Entity connection graph (read-only views over existing joins)

Already implied by `news_event_entities` + `news_event_topics`. Surface as `/api/graph/entity/:id` and `/api/graph/topic/:slug`: every event connected through that entity/topic. Lets a user click "Tesla" and see all events that mention Tesla, with the strongest connections first.

### L5 — Action Graph (README §"Action Graph") — separate spec, multi-month

`event → problem → opportunity → action → outcome`. New tables `news_problems`, `news_opportunities`, `news_actions`, `news_outcomes` with human-in-the-loop confirmation per the README's safety framework. This is the "what can humans do" layer; it is its own spec because it requires UX, editorial review, and outcome tracking.

### L6 — Knowledge Graph convergence (long-term)

Single queryable graph over entities + events + problems + opportunities + actions + outcomes. Likely 12+ months out. Defer.

### How B sets up L1–L5

The `news_event_sources.match_kind` audit column added in B is what makes L1's "how often do cross-event links form via entity+ngram" measurable. The `news_events.correlation_kind` audit is what makes L2/L3's "did the entity+ngram join cause a downstream causal edge" measurable. B's additive-only invariant is what lets L2–L5 build new edges without breaking the event core. Every layer above is **read-mostly against the B-shaped data** until/unless it needs its own schema.
