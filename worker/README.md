# xyzo worker

Python pipeline that polls ~30 RSS / GeoJSON / JSON feeds, extracts location
+ event metadata via a local Gemma-4 model, geocodes through Nominatim, and
clusters co-located co-typed articles within a 6-hour window into single
events.

## Pipeline

```
fetch → auto_categorize → extract → geocode → density → cluster
  (RSS)    (fast path)   (Gemma)  (Nominatim)  (analyze)  (Postgres)
```

**Fast path (`auto_categorize`):** Uses `cities_text.find_cities_in_text()` +
`classify.classify()` for articles where city is clearly stated. Bypasses AI.

**AI extraction (`extract`):** Gemma-4 extracts location_text, event_type, summary.
Includes circuit breaker (5 failures/5min → 3min cooldown).

**Geocoding (`geocode`):** Nominatim → `news_locations`. Negative caching
(1hr TTL) prevents retrying definitively unfound locations.

**Density analysis (`density`):** Detects suspicious clusters. Phase 1: re-read
body for better city. Phase 2: wiki_geo keyword matching + cities_text fallback
before hash-based spread.

**Place disambiguation (`place_disambiguation`):** Watchlist of 60+ ambiguous
place names. Uses source_country prior when no context matches. Handles
"City, ST" and "City of X" qualified forms.

Each stage is independent and crash-safe: articles enter as `status='pending'`
in `news_articles` and move forward only on success, so a killed mid-cycle
simply resumes next run.

## Install

```bash
cd /var/www/vhosts/xyzo.org
python3 -m venv .venv
.venv/bin/pip install -r worker/requirements.txt
```

Dependencies: `httpx`, `psycopg[binary]`, `feedparser`, `pytest` (+ pytest-asyncio).

## Configure

The worker reads `XYZO_DB_DSN` from the environment (preferred). For legacy
deploys the alias `NEWSIUM_DB_DSN` is also accepted — see `worker/db.py`.
Override before running:

```bash
export XYZO_DB_DSN="postgresql://user:CHANGE_ME@host:5432/xyzo"
```

`run.sh` already exports a working default (prefers `XYZO_DB_DSN`, falls
back to `NEWSIUM_DB_DSN`).

### Local AI server

`worker/extract.py` POSTs to `http://192.168.1.3:8888/chat/stream` by default.
Edit `EXTRACTION_URL` in `extract.py` to point elsewhere. The endpoint
expects `{message: str, stream: bool}` shape — OpenAI-style `messages[]`
returns 422.

### Nominatim

`worker/geocode.py` calls `https://nominatim.openstreetmap.org/search` with a
User-Agent containing a contact email. **Edit `_USER_AGENT` to your own
contact** before running in production — Nominatim's ToS requires it and
default agents get throttled or blocked.

## Run by hand

The wrapper script handles DB env + working directory so you don't have to:

```bash
# First-time: seed the feed registry (30 sources)
./worker/run.sh --seed-feeds

# Full cycle with default cap (60 AI extractions per run)
./worker/run.sh

# Cap AI step to 30 articles, log to a file
./worker/run.sh --limit 30 2>&1 | tee last-run.log

# Just fetch, don't touch the DB
./worker/run.sh --step fetch --dry-run

# On-demand place search (forces re-fetch + cluster, then returns matching events)
./worker/run.sh --search "Chicago" --limit 20
```

Expected final log line per cycle:

```
cycle done: {'steps': {'fetch': {'sources_fetched': 30, 'articles_inserted': 7, 'errors': 6, ...},
                     'extract': {'extracted': 30, 'failed': 0},
                     'geocode': {'geocoded': 21, 'not_found': 0, 'errors': 0},
                     'cluster': {'events_created': 20, 'events_merged': 1}},
           'duration_s': 132.1}
```

### Verify it's working

```bash
./worker/run.sh                            # run a cycle
curl -sS 'http://localhost:3008/api/events?limit=5' | python3 -m json.tool
PGPASSWORD=CHANGE_ME psql -U xyzo_app -d xyzo \
  -c "SELECT id, event_type, headline, source_count FROM news_events ORDER BY first_reported_at DESC LIMIT 10;"
```

A working run should produce new rows in `news_events` (the second event
onward will start merging with the first if the same place+type recurs
within 6h).

## Tests

```bash
python3 -m pytest worker/tests/ -v
```

Covers: feed parsing, JSON extraction fallback, geocode upsert idempotency,
cluster window merging.

## Known limitations

- **No embeddings** — clustering is heuristic (same place + same event_type +
  within 6h). Two unrelated incidents in the same city 3h apart will merge.
  Acceptable trade-off while the local AI server lacks an `/embeddings`
  endpoint. Neural embeddings table (`nn_city_embeddings`) exists but is not
  yet used for disambiguation.
- **Rate-limited Nominatim** — public instance, 1 req/sec. With 30+ feeds
  the geocode step can be the bottleneck. Swap to a self-hosted instance if
  this becomes painful. Negative caching (1hr TTL) helps but doesn't eliminate
  the issue.
- **Country-name ambiguity partially mitigated** — The `place_disambiguation`
  watchlist (60+ entries) handles most common collisions. The `source_country`
  prior helps when article context is ambiguous. Remaining edge cases:
  `"Gaza"` → Mozambique, `"West Bank"` → US region. These require explicit
  qualifier in AI output or manual watchlist entries.
- **Heuristic AI JSON parsing** — Gemma-4 sometimes streams a tool-call that
  blocks indefinitely. `extract.py` times out after 25s and falls back to a
  regex that pulls a capitalized phrase from the title.
- **NE 110m polygons coarse** — City coordinate validation uses Natural Earth
  110m country polygons. Caribbean islands near US, Philippine islands near CN,
  and some Pacific islands may be misclassified.
- **No clustering UI** — events merge silently with no admin way to split.
  Deferred to v2.
