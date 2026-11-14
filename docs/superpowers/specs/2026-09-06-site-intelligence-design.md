# Site Intelligence Subsystem — Design

**Date:** 2026-09-06
**Status:** Draft
**Owner:** Xyzo Dev

## Purpose

Add an AI-driven "site intelligence" layer that studies every website we
crawl, persists what it learns in a per-host record, and lets future crawls
operate much more efficiently: pick the right extractor on the first try,
re-rank the BFS frontier toward event-rich paths, subscribe to discovered
feeds instead of re-crawling, and dedupe events across sources via semantic
embeddings.

We will combine three signals:

1. **AI (Claude API)** — one rich scan per host that produces structured
   intelligence: feeds, structural map, structured-data fingerprint,
   politics (anti-scrape, language, taxonomy).
2. **Algorithms** — pure-Python consumers of that JSON that reshape the
   BFS frontier, select extractors per page, resolve field-level
   conflicts between JSON-LD / AI / heuristic.
3. **Neural networks** — local sentence-transformers for semantic
   embedding dedup + a small two-head classifier (re-ranker + event type)
   trained on our own crawl labels.

Everything ships behind feature flags. The main site must keep working
byte-identically when flags are off.

## User constraints (verbatim)

- "we have to be especially careful about tracking government events and
  government websites not to over check and being especially careful
  about legal and robots.txt however we want to track city wide events
  globally"
- "we want to be able to study any website with or without rss support
  and also dig deeper then just there home page using various algorithms
  and ai if needed"

## Decisions locked during brainstorming

| Question | Decision |
|---|---|
| Knowledge persistence | Per-host intelligence record (lazy refresh) |
| Output scope | All four categories: feeds/APIs, structural map, SD fingerprint, politics (anti-scrape + language + taxonomy) |
| Refresh policy | Lazy — only on miss / staleness / drift / failure |
| NN role | All three: embeddings + classifier + AI |
| Classifier task | Two heads: re-ranker (URL event-richness 0-1) + event type (8 classes) |
| AI budget | Tiered by politeness tier (gov/university = cheap, commercial = deep) |
| Embeddings | Local sentence-transformers (all-MiniLM-L6-v2) + pgvector |
| Conflict resolution | JSON-LD wins; AI patches missing; heuristic hints only |

## Architecture overview

```
                    ┌─────────────────────────────────────────────┐
                    │            site_intelligence (host)         │
                    │ intelligence_json  (JSONB)                 │
                    │   feeds[]: RSS/Atom/iCal/JSON-Feed         │
                    │   structural_map[]: URL path patterns       │
                    │   sd_fingerprint: schema types + microdata │
                    │   politics: anti-scrape, lang, taxonomy    │
                    │ version, producer, experiment_tag          │
                    │ confidence, drift_signals, scan_count      │
                    └─────────────────────────────────────────────┘
                                    ▲ read on every crawl
                                    │ write when missing/stale
                    ┌─────────────────────────────────────────────┐
                    │           ai_intelligence_scan             │
                    │  ─────────────────────────────────────────  │
                    │  • reads home + sitemap + sampled pages     │
                    │  • tiered budget by politeness tier         │
                    │  • returns structured intelligence JSON     │
                    └─────────────────────────────────────────────┘

POST /api/sites/crawl { url }
   │
   ▼
┌────────────────────────────────────────────────────────────────┐
│ crawl_with_intelligence(url)                                   │
│   1. robots + legal_policies (existing)                        │
│   2. load site_intelligence (lazy AI scan if missing/stale)   │
│   3. frontier scoring = 0.4*classifier + 0.3*page_priority     │
│                          + 0.3*intelligence_hint               │
│   4. per page: extractor chosen from intelligence              │
│   5. JSON-LD > AI > heuristic for field conflicts              │
│   6. for each event: embed (sentence-transformers)             │
│      → pgvector cosine search for cross-source dedup           │
│   7. update drift_signals based on what actually happened      │
└────────────────────────────────────────────────────────────────┘
```

## Components

### 1. `worker/ai_intelligence_scan.py`

Lazy AI scan that produces the intelligence JSON. Tiered budget, prompt
versioning, defensive against API failures.

**Tier budgets:**

| Tier | pages_max | tokens_in_max | model |
|---|---|---|---|
| gov | 2 | 15,000 | claude-haiku-4-5 |
| university | 2 | 15,000 | claude-haiku-4-5 |
| community | 4 | 40,000 | claude-haiku-4-5 |
| commercial | 6 | 80,000 | claude-sonnet-5 |
| platform | 4 | 40,000 | claude-haiku-4-5 |
| user | 3 | 30,000 | claude-haiku-4-5 |

**Flow:**

1. Load existing `site_intelligence` for host. Apply `needs_refresh()`.
   If fresh, return cached. If stale, return stale + schedule refresh.
2. Resolve tier + budget.
3. Fetch seed pages (home, sitemap.xml, top page_priority URLs).
   All cheap — no AI calls.
4. Run cheap extractors (JSON-LD, microdata, autodiscovery) to build a
   "context" dict for the AI prompt.
5. Single Claude call with response_format prefill `{` to force JSON.
6. Parse + validate against schema. Merge: autodiscovery > sitemap >
   heuristic_pre > ai.
7. Compute `intelligence.confidence` from field coverage.
8. Upsert `site_intelligence` with metrics.

**Refresh logic:**

```python
def needs_refresh(record, host) -> tuple[bool, str]:
    if not record:                            return (True, "no-record")
    if record.consecutive_errors >= 3:        return (True, "errors")
    if age_days > 30:                         return (True, f"age={age_days}d")
    if record.confidence < 0.5:               return (True, "low-conf")
    feed_survival = alive / total             # from drift_signals
    if feed_survival < 0.5:                   return (True, "feed-drift")
    if path_yield < 0.4:                      return (True, "path-drift")
    return (False, "fresh")
```

### 2. `worker/intelligence_consume.py`

Pure-Python. No I/O beyond DB read. Given `SiteIntelligence`, returns
`CrawlHints` that the crawler uses.

```python
@dataclass
class CrawlHints:
    url_score_adjustments: dict[str, float]
    extra_seeds: list[str]
    avoided_paths: list[re.Pattern]
    preferred_extractor_per_url: dict[str, str]
    skip_extractors: dict[str, list[str]]
    feeds_to_subscribe: list[FeedRef]
    crawl_window_utc: list[tuple[int, int]]
    min_request_interval_s: float
    js_only_paths: list[re.Pattern]
    primary_language: str
    language_variants: dict[str, str]
    field_winners: dict[str, str]
```

**Re-ranking:**

```python
def score_url_with_intelligence(url, page_priority_score,
                                 classifier_score, intelligence):
    cfg = get_feature_config()
    return (
        cfg['classifier.weight'] * (classifier_score or page_priority_score) +
        cfg['page_priority.weight'] * page_priority_score +
        cfg['intelligence_hint.weight'] * url_adjustment(url, intelligence)
    )
```

### 3. `worker/embeddings.py`

sentence-transformers loaded once per subprocess, cached in module-level
singleton.

- Model: `sentence-transformers/all-MiniLM-L6-v2` (384-dim, ~80MB)
- Storage: pgvector `vector(384)` column on `crawl_events` and
  `upcoming_events`
- Index: `ivfflat` with `vector_cosine_ops`, lists=100
- Dedup threshold: 0.92 cosine (auto-merge); 0.85-0.92 = review queue

```python
def event_to_text(event) -> str:
    parts = [
        event.get("title", ""),
        event.get("venue_name") or "",
        event.get("city") or "",
        event.get("country_code") or "",
        (event.get("description") or "").split(".")[0][:200],
        " ".join(event.get("categories") or []),
    ]
    return " | ".join(p for p in parts if p).strip()
```

### 4. `worker/classifier.py`

Two-head NN, bootstrapped from `discovered_pages` labels.

```
URL text → sentence-transformers → 384-dim
                                      │
                                      ▼
                          Dense(128, ReLU) + Dropout(0.3)
                                      │
                                      ▼
                            Dense(64, ReLU) + Dropout(0.3)
                                      │
                        ┌─────────────┴─────────────┐
                        ▼                           ▼
              Dense(1, Sigmoid)             Dense(8, Softmax)
              "event-richness 0-1"        "event type"
```

**Training data:** existing `discovered_pages` rows with signals +
extracted event counts as the re-ranker label, and JSON-LD `@type` as
the event-type label.

**Retrain trigger:** weekly cron OR when `new_samples >= retrain_min_samples`
(default 500). Quality-regression check on holdout set rejects degraded
models.

**Cold start:** feature flag OFF until 500 labeled samples exist.

### 5. Wire-up in existing crawl

`worker/site_crawl.py` changes:

- Load intelligence at top of `crawl_site()`
- Blend classifier + page_priority + intelligence into frontier scoring
- Pick extractor per page based on intelligence hints
- Apply JSON-LD-wins conflict resolution
- Embed each event post-extraction
- Cosine-dedupe against `upcoming_events`
- Update `drift_signals` at end of crawl

`worker/page_priority.py` adds `score_url_with_intelligence()` alongside
the existing `score_url()` — never replaces it.

`worker/ai_extract.py` adds field-level tagging (`jsonld_*`, `ai_*`,
`heur_*` raw fields) so the merger can pick winners.

## Database schema

### `site_intelligence`

```sql
CREATE TABLE site_intelligence (
    id                  BIGSERIAL PRIMARY KEY,
    host                TEXT NOT NULL UNIQUE,
    tier                TEXT NOT NULL DEFAULT 'commercial',

    -- Versioning
    format_version      INTEGER NOT NULL DEFAULT 1,
    producer            TEXT NOT NULL,
    producer_version    TEXT NOT NULL,
    experiment_tag      TEXT,

    -- Payload
    intelligence        JSONB NOT NULL,
    summary             TEXT,

    -- Operational metrics
    scan_tokens_in      INTEGER NOT NULL DEFAULT 0,
    scan_tokens_out     INTEGER NOT NULL DEFAULT 0,
    scan_cost_usd       NUMERIC(10,6) NOT NULL DEFAULT 0,
    scan_model          TEXT,
    pages_sampled       INTEGER NOT NULL DEFAULT 0,
    scan_duration_ms    INTEGER,

    -- Lifecycle
    refreshed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error          TEXT,
    consecutive_errors  INTEGER NOT NULL DEFAULT 0,

    -- Usage stats
    scan_count          INTEGER NOT NULL DEFAULT 1,
    crawl_count         INTEGER NOT NULL DEFAULT 0,
    events_extracted    BIGINT NOT NULL DEFAULT 0,
    duplicates_caught   BIGINT NOT NULL DEFAULT 0,
    last_used_at        TIMESTAMPTZ,

    -- Staleness signals
    confidence          REAL NOT NULL DEFAULT 0.9,
    drift_signals       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX site_intelligence_host_idx ON site_intelligence (host);
CREATE INDEX site_intelligence_refreshed_idx
    ON site_intelligence (refreshed_at) WHERE last_error IS NULL;
CREATE INDEX site_intelligence_format_idx ON site_intelligence (format_version);
CREATE INDEX site_intelligence_drift_idx ON site_intelligence (drift_signals);
```

### `intelligence` JSON shape

```json
{
  "schema_version": 1,
  "feeds": [
    {"href": "https://example.com/events.ics", "type": "text/calendar",
     "title": "Public Events", "detection": "ai_link", "confidence": 0.95}
  ],
  "structural_map": [
    {"pattern": "/events", "kind": "listing", "confidence": 0.9,
     "depth_estimate": 2, "examples": ["/events", "/events/2026"]}
  ],
  "sd_fingerprint": {
    "json_ld_types": ["Event", "MusicEvent", "ExhibitionEvent"],
    "microdata_itemtypes": ["schema.org/Event"],
    "opengraph": {"og:type": "website", "og:locale": "en_US"},
    "widgets": ["eventbrite-embed"],
    "feed_formats": ["rss", "atom", "ical"],
    "date_formats_seen": ["ISO 8601", "October 5, 2026"],
    "currency_seen": ["USD", "EUR"],
    "languages_seen": ["en", "es"]
  },
  "politics": {
    "anti_bot_signals": ["cloudflare-challenge"],
    "rate_limit_headers_seen": ["x-ratelimit-limit", "retry-after"],
    "js_only_pages": ["/events"],
    "best_crawl_window_utc": ["02:00-06:00"],
    "publishes_on": ["Monday morning"],
    "language_primary": "en",
    "language_variants": {"es": "/es/"},
    "taxonomy": {
      "categories": ["Music", "Lectures", "Workshops", "Sports"],
      "audience_signals": ["families", "adults", "students"],
      "price_signals": ["free", "ticketed"]
    }
  },
  "site_summary": "Public university events calendar...",
  "scanned_urls": ["https://example.com/", "https://example.com/events"]
}
```

### `feature_flags` and `feature_config`

```sql
CREATE TABLE feature_flags (
    key             TEXT PRIMARY KEY,
    enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    rollout_pct     SMALLINT NOT NULL DEFAULT 0,
    tier_overrides  JSONB NOT NULL DEFAULT '{}'::jsonb,
    host_overrides  JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      TEXT,
    description     TEXT
);

CREATE TABLE feature_config (
    key     TEXT PRIMARY KEY,
    value   JSONB NOT NULL
);
```

Seed flags:
- `ai_intelligence_scan` (default OFF)
- `intelligence_driven_crawl` (default OFF)
- `embedding_dedup` (default OFF)
- `classifier_reranker` (default OFF)
- `jsonld_wins_conflict` (default ON — already in our code path)
- `emergency_disable_intelligence` (default OFF — kill switch)

### Embedding columns (additive)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE crawl_events
    ADD COLUMN IF NOT EXISTS embedding vector(384),
    ADD COLUMN IF NOT EXISTS embedding_text TEXT;

ALTER TABLE upcoming_events
    ADD COLUMN IF NOT EXISTS embedding vector(384);

CREATE INDEX IF NOT EXISTS crawl_events_embedding_idx
    ON crawl_events USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

CREATE INDEX IF NOT EXISTS upcoming_events_embedding_idx
    ON upcoming_events USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
```

### Classifier runs

```sql
CREATE TABLE classifier_runs (
    id              BIGSERIAL PRIMARY KEY,
    trained_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sample_count    INTEGER NOT NULL,
    new_samples     INTEGER NOT NULL,
    auc             REAL,
    rmse            REAL,
    f1              REAL,
    status          TEXT NOT NULL,
    model_path      TEXT,
    notes           TEXT
);
```

## Schema evolution rules

The contract: `format_version` is the only thing consumers check.

| Change | Action |
|---|---|
| Add field to `intelligence` JSON | Bump `format_version`, write adapter in `readers/site_intel/v{N}.py` |
| Add column to `site_intelligence` | Add with `DEFAULT`, no version bump |
| Rename column | Add new column, dual-write, migrate, drop old |
| Split JSONB array into child table | New sibling table, dual-write, backfill |
| Major shape change | New column `intelligence_v2 JSONB`, deprecate `intelligence` |
| Drop a field | Mark deprecated in `format_version`, remove after 2 releases |

## Feature flag + rollout

```python
def is_enabled(flag_key: str, host: str, tier: str) -> bool:
    flag = flags[flag_key]
    if flags['emergency_disable_intelligence'].enabled:
        return False
    overrides = flag.host_overrides
    if host in overrides:
        return overrides[host]
    tier_pct = flag.tier_overrides.get(tier, flag.rollout_pct)
    return stable_hash(f"{flag_key}:{host}") % 100 < tier_pct
```

**Rollout stages** (each runs ≥7 days before next):

| Stage | What's enabled | Verification |
|---|---|---|
| 1. Shadow | AI scan runs, result logged not used | Compare AI predictions vs actual findings |
| 2. Write-only | AI scan writes `site_intelligence` | Spot-check rows; no crawl behavior change |
| 3. Crawl hints | Intelligence reshapes BFS on 5% commercial | Compare event counts vs control |
| 4. Embeddings | pgvector + cosine dedup on 25% commercial | Verify dedup precision/recall |
| 5. Classifier | Trained reranker joins scoring blend | A/B test against page_priority alone |
| 6. Full | All features on by tier defaults | Monitor cost, error rate, events/day |

**Backwards compatibility:**

- API responses: never remove fields; new fields are nullable.
- DB writes: idempotent (`ON CONFLICT DO UPDATE`).
- Frontend JS: ignore unknown fields.
- New tables: `CREATE TABLE IF NOT EXISTS`. Empty = current behavior.
- AI scan failure: catches all exceptions, returns None. Crawl proceeds.
- Embeddings failure: catches all exceptions, stores event without `embedding`.
- Classifier missing: weight=0. page_priority fully drives ranking.

**Per-feature knobs:**

| Config key | Default |
|---|---|
| `classifier.weight` | 0.4 |
| `page_priority.weight` | 0.3 |
| `intelligence_hint.weight` | 0.3 |
| `embedding.dedup_threshold` | 0.92 |
| `classifier.retrain_min_samples` | 500 |
| `classifier.retrain_cron` | `0 3 * * 0` |

## Failure modes

| Failure | Mitigation |
|---|---|
| Claude API down | `consecutive_errors++`, heuristic-only fallback, exponential backoff |
| Claude returns invalid JSON | Parse fails, error counter increments |
| sentence-transformers not installed | Mark embeddings unavailable, log warning, skip dedup |
| pgvector not enabled | Migration writes `migrations_pending`, runs without embedding |
| Model download slow | Pre-download in install script |
| AI scan on 403 host | `confidence=0.1`, mark `intelligence_unavailable`, no auto-retry |
| AI hallucinated feeds | 3 strikes, drop feed. `drift_signals.feed_alive_count` tracks. |
| Daily spend cap hit | `ai_spend_today` check rejects new scans |
| Two crawlers race on host | `pg_advisory_xact_lock(hashtext(host))` |
| Budget exhausted mid-scan | Strict token cap; parse partial JSON; null missing fields |
| Classifier quality regressed | Evaluate rejects, keep prior model |

**Defensive pattern (everywhere):**

```python
def safe_intelligence_operation(host: str, fn: Callable) -> Result:
    try:
        if not is_feature_enabled(host):  return Result.skipped("feature-off")
        return fn()
    except BudgetExceeded:                return Result.skipped("budget-exceeded")
    except ClaudeAPIError as e:           record_error(host, str(e)); return Result.skipped("ai-unavailable")
    except Exception as e:                log.exception(...); record_error(host, str(e)); return Result.skipped("unknown-error")
```

No operation raises to the caller. Crawl must always succeed.

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/sites/crawl` | Crawl with intelligence (existing — response gets richer) |
| POST | `/api/sites/intelligence-scan` | Force a refresh of `site_intelligence` for a host |
| GET | `/api/sites/intelligence/:host` | Read current record + drift signals |
| GET | `/api/sites/intelligence-list` | List all hosts with confidence + scan_count |
| POST | `/api/sites/embed-event` | Force re-embed one event by id |
| POST | `/api/features` | Admin: update feature flag |
| GET | `/api/features` | Read all flags |
| GET | `/api/sites/cost` | 30-day AI spend rollup |

## Testing strategy

Unit tests:

- `tests/test_intelligence_scan.py` — schema validation, tier budgets,
  refresh logic, lazy behavior
- `tests/test_intelligence_consume.py` — path expansion, JSON-LD-wins
  conflict, AI patches missing, AI contradiction logged
- `tests/test_embeddings.py` — text composition, dedup thresholds,
  near-dupe detection, graceful fallback when model missing
- `tests/test_classifier.py` — two-head output shapes, cold start
  disabled, quality regression rejected, retrain trigger
- `tests/test_feature_flags.py` — emergency kill switch, host override,
  tier override, rollout_pct hashing

Integration tests:

- `tests/test_integration.py` — first crawl triggers AI scan, second
  uses cache, stale triggers refresh, emergency disables legacy mode,
  embeddings dedupe across crawls

Load test:

- `tests/test_load.py` — 100 concurrent crawls on same host trigger
  only one AI scan (advisory lock holds)

Manual verification:

- `curl -X POST .../api/sites/intelligence-scan -d '{"host":"sf.gov"}'`
  → tokens_in < 15000
- `curl -X POST .../api/sites/intelligence-scan -d '{"host":"eventbrite.com"}'`
  → tokens_in up to 80000
- Set emergency disable → verify legacy behavior unchanged

## Files touched / added

**New files:**
- `worker/ai_intelligence_scan.py`
- `worker/intelligence_consume.py`
- `worker/embeddings.py`
- `worker/classifier.py`
- `worker/prompts/intelligence_scan.py`
- `worker/readers/site_intel/v1.py` (adapter)
- `api/src/routes/site_intelligence.ts`
- `api/src/routes/feature_flags.ts`
- `api/src/xyzo_features.py` (helper module)
- `api/migrations/2026-09-07-site-intelligence.sql`
- `api/migrations/2026-09-07-feature-flags.sql`
- `api/migrations/2026-09-07-embeddings.sql`
- `api/migrations/2026-09-07-classifier-runs.sql`
- `tests/test_intelligence_scan.py`
- `tests/test_intelligence_consume.py`
- `tests/test_embeddings.py`
- `tests/test_classifier.py`
- `tests/test_feature_flags.py`
- `tests/test_integration.py`
- `tests/test_load.py`
- `scripts/xyzo-fetch-models.sh` (pre-download sentence-transformers)
- `docs/superpowers/plans/2026-09-07-site-intelligence-impl.md` (impl plan)

**Modified files:**
- `worker/site_crawl.py` (intelligence load, hint-aware scoring)
- `worker/page_priority.py` (add `score_url_with_intelligence`)
- `worker/ai_extract.py` (add field-level tagging)
- `api/src/routes/sites_study.ts` (richer response, new endpoints)

## Out of scope (intentional)

- Training a model from scratch (we bootstrap from existing labels)
- Real-time embedding index updates (batch per crawl is enough)
- Multi-language embedding model (multilingual MiniLM is a future swap)
- External intelligence microservice (everything in-process)
- LLM-driven prompt optimization (manual prompt iteration for now)
- Streaming/chunked intelligence (single host scan is fast enough)

## Open questions

None blocking. Parked for after first rollout:
- Should we expose intelligence to users (e.g., "verified publisher" badge)?
- Should the classifier train on negative samples too (URLs that failed)?
- Should embeddings also live on `event_sources` for source-similarity clustering?
