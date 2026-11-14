# Roadmap: AI Features + Non-AI Algorithms for Auto-Discovery & UX

**Date:** 2026-09-05
**Author:** Strategic review
**Scope:** Recommendations only — none are implemented yet. Each item has an effort estimate and a "first slice" so you can ship value incrementally.

---

## What we already have (so we don't reinvent it)

| Subsystem | What it does | Files |
|---|---|---|
| `nn_article_embeddings` / `nn_event_embeddings` / `nn_country_embeddings` | pgvector caches for semantic similarity | `api/schema-nn-embeddings.sql`, `worker/nn_features.py` |
| `news_fetch_decisions`, `news_coverage_gaps`, `news_extraction_feedback` | Learning loop: what to fetch, where the gaps are, what extraction got wrong | `api/schema-learning.sql`, `worker/learn.py`, `worker/coverage_bot.py` |
| `news_story_links` | Cross-source story linking (just deployed in Phase 1) | `worker/story_linker.py` exists but no handler wired |
| NN prediction views (`nn_v_*`) | Pre-computed rankings for hot topics | `api/schema-nn-predictions.sql`, `api/schema-nn-rankings.sql` |
| `nn_infer.py` | Inference path for trained models | `worker/nn_infer.py` |
| Worker Job Queue | Already shipped (Slice A Phase 5) | `api/src/queue/`, `deploy/xyzo-idle-worker.service` |
| ThreadPoolExecutor for AI extraction | Just shipped in Phase 3 | `worker/extract.py` |

**Gaps to fill (in priority order below):**

1. `news_story_links` is populated by `story_linker.py` but never wired into the worker queue or surfaced in the UI
2. `news_coverage_gaps` is computed but not driving source acquisition
3. `nn_v_*` views exist but no `/api/explore` endpoint consumes them
4. No personalization layer — every user sees the same map
5. No predictive scheduling — sources are fetched on a fixed cadence
6. No conversational UX — only structured filters

---

## Part 1 — AI Features (LLM-driven)

### 1.1 Auto-Discovery

| # | Feature | Why | Effort | First slice |
|---|---|---|---|---|
| A1 | **Semantic story grouping** (wire up `news_story_links`) | Multiple sources covering the same event appear as one pin; reduces noise 3-10× | M | Add `worker/handlers/links_run.py` that pulls pending `news_articles` and runs `story_linker.py`; show cluster count on each pin |
| A2 | **Coverage-gap-driven source acquisition** | `news_coverage_gaps` already computed; turn into auto-fetched feed suggestions | M | `/api/admin/coverage-gaps/top` endpoint + `worker/handlers/coverage_bot.py` enqueueing `discover_source` jobs |
| A3 | **Adaptive refresh scheduling** | High-yield sources get fetched more often; quiet sources get throttled | M | `news_fetch_decisions` → bandit policy; expose as `next_fetch_at` per source |
| A4 | **Cross-language story tracking** | Same event in EN/ES/AR/FR articles unified via embeddings | M | Use `nn_event_embeddings` cross-lingual space; merge clusters with sim > 0.85 |
| A5 | **Geo-disambiguation for ambiguous places** | "Paris TX" vs "Paris FR" — pick the right one based on article context | S | Pass `(lat,lng)` from extraction + nearest-city lookup; reject if ambiguous (>50km to nearest 2) |
| A6 | **Auto-translation of headlines** | Non-English sources show translated headlines to English-first users | S | `extract.py` adds `translated_title` field via cheap model (e.g., `gpt-4o-mini`); cache in `news_articles.translated_title` |
| A7 | **Predictive event heatmap** | Where will news break in next 24h based on history + current burst | L | Train Hawkes process (non-AI) on past events; visualize as heatmap overlay |
| A8 | **"Why this pin?" explanations** | Generate 1-sentence rationale citing the article that placed it | S | Add `pin_rationale` column; populate from extract.py's existing structured output |
| A9 | **Headline quality rewrite** | Weak headlines get rewritten in a consistent style | M | V2 of extract prompt; quality score threshold; A/B against originals |
| A10 | **Anomaly detection in source behavior** | A source suddenly posting 100× normal volume → flag for moderation | S | Z-score on per-source rolling rate; alert via `news_quality_reports` |

### 1.2 User Help

| # | Feature | Why | Effort | First slice |
|---|---|---|---|---|
| U1 | **Conversational search ("ask the map")** | "show me protests in Europe last week" → returns pins | L | `/api/ask` endpoint; LLM parses → structured query → existing search route |
| U2 | **"Tell me more about this story" panel** | Click pin → see all sources covering it, summary, timeline | M | Reuse `news_story_links`; add `worker/handlers/story_summarize.py` |
| U3 | **Bias / perspective analyzer** | Show how AP vs al Jazeera frame the same event | M | Per-source sentiment + framing classifier; side-by-side comparison view |
| U4 | **Follow-this-story subscriptions** | User gets email/push when new articles join their followed story | M | `story_follows` table; nightly digest job |
| U5 | **Personalized "what changed near you" digest** | Weekly summary of new pins in user's saved regions | M | `/api/regions/subscribe` + cron job writing `user_digests` |
| U6 | **Smart notifications** | Only ping when high-significance event happens nearby | M | Significance = NN ranking × distance; respect user's notification tier |
| U7 | **Voice narration of headlines** | TTS for accessibility / hands-free | S | Browser `SpeechSynthesis` first; server-side Polly later |
| U8 | **Reading-level adaptation** | ELI5 vs expert toggle | S | Pass reading level to extract prompt; cache result |
| U9 | **Auto-generated alt text for map pins** | Accessibility | XS | Pin's category + city + 3 keywords → "Protests in Paris, France" |

---

## Part 2 — Non-AI Algorithms

### 2.1 Graph Algorithms (we have `event_graph_edges` already)

| # | Algorithm | Use case | Effort | First slice |
|---|---|---|---|---|
| G1 | **PageRank on event graph** | Score "important" stories — what's getting the most cross-source attention | S | Compute in `worker/handlers/links_run.py` after story linking; store as `news_story_links.rank` |
| G2 | **HITS (hubs & authorities)** | Identify reliable sources (hubs) and landmark events (authorities) | S | Same handler; add `source_authority_score` |
| G3 | **Louvain community detection** | Find topic clusters beyond per-event grouping | M | `python-louvain` package; nightly batch |
| G4 | **Node2Vec embeddings** | Better-than-text embeddings for sources/events | M | Use as alternative signal in `story_linker.py` |
| G5 | **Label propagation for source classification** | Auto-label new sources by following similar ones | M | Existing `nn_country_embeddings` can seed this |

### 2.2 Classical ML / Math

| # | Algorithm | Use case | Effort | First slice |
|---|---|---|---|---|
| M1 | **MinHash / LSH for dedup at ingest** | Detect near-duplicate articles in O(1) before they hit DB | S | `datasketch` library; 5-minhash fingerprints per article; LSH table |
| M2 | **TF-IDF + cosine similarity** | Fast content similarity fallback when embeddings unavailable | XS | Use `sklearn.feature_extraction.text.TfidfVectorizer` |
| M3 | **BM25 for search relevance** | Replace naive FTS ranking with proper BM25 | S | Postgres has `ts_rank` but BM25 is better — implement via `pg_search` extension or in app |
| M4 | **TextRank / TextTiling for extractive summaries** | No-LLM summaries for "story digest" view | S | `sumy` library; 3-sentence summary per story |
| M5 | **LDA topic modeling** | Auto-discover topics across all articles; group "all climate stories" without explicit tag | M | `gensim` LDA; nightly; store top-10 topics per region |
| M6 | **NMF topic modeling** | Alt to LDA; faster on sparse data | M | Same slot as M5; pick winner by coherence |
| M7 | **VADER sentiment scoring** | Polarity per article; cheap; no LLM | XS | `vaderSentiment`; per-article + per-source aggregate |
| M8 | **Hawkes process for event prediction** | Self-exciting news bursts; predicts next event in a region | L | `tick` library; train on 6mo history |
| M9 | **BOCPD change-point detection** | Detect when a region's coverage pattern shifts | M | `bayesian-changepoint-detection`; trigger alert |
| M10 | **Multi-armed bandit for source scheduling** | Adaptive fetch cadence — explore new sources, exploit proven ones | M | UCB1 implementation in `worker/handlers/scheduler_bandit.py` |
| M11 | **DBSCAN with Haversine** | Better pin clustering (we have a `cluster.py` — likely k-means currently) | S | Verify current; replace if k-means |
| M12 | **TF-IDF source fingerprinting** | Detect "source families" (e.g., AP wire variants) | S | Per-source TF-IDF; cosine sim matrix |

### 2.3 UX Performance Algorithms (frontend + API)

| # | Feature | Why | Effort | First slice |
|---|---|---|---|---|
| X1 | **Viewport-priority pin rendering** | Render pins at center of viewport first; edges later (already partial via canvas) | XS | Z-order by distance from viewport center |
| X2 | **Predictive pre-fetch** | Based on pan direction, pre-fetch the next viewport's pins | S | Track pan velocity vector; trigger fetch at 50% pan |
| X3 | **Heatmap aggregation at low zoom** | Show density instead of 5000 pins | S | Server-side aggregation endpoint; toggle in UI |
| X4 | **Stale-while-revalidate** | Show last good state instantly while fetching fresh | S | ETag + `stale-while-revalidate=60` on `/api/pins` |
| X5 | **Smart debounce + throttle** | Map pan: 200ms debounce; search: 150ms | XS | Already partial — verify & document |
| X6 | **Adaptive worker concurrency** | Pool size scales with CPU/queue depth (extends Phase 3) | S | Read `os.cpu_count()` + queue depth; adjust `max_workers` |
| X7 | **Semantic cluster labels** | Show "5 sources reporting in Paris" instead of 5 pins | M | Reuse existing clusters; add label-generation step |
| X8 | **Time-travel slider** | Replay news coverage for a region over time | M | Server-side time-bucket API; client slider |
| X9 | **Saved searches with alerts** | User saves query → gets pinged on new matches | M | `saved_searches` table; job queue notification |
| X10 | **GeoIP-driven default region** | Map opens to user's country on first visit (already partial via GeoIP) | XS | Verify `geoip.ts` is called on `/` |

### 2.4 Personalization (no AI)

| # | Feature | Why | Effort | First slice |
|---|---|---|---|---|
| P1 | **Anonymous reading-history clustering** | "Users who read X also read Y" — collaborative filter | M | Store view events; nightly batch clustering |
| P2 | **Time-of-day defaults** | Show breaking news in morning, analysis in evening | XS | Per-user time bucket from view history |
| P3 | **Saved regions** | User draws box on map → "alert me when news happens here" | M | `saved_regions` table; UI + job queue |
| P4 | **Source following** | User follows a source; gets all its articles in feed | XS | Already have `news_sources`; add `user_follows_source` |

---

## Part 3 — Sequencing (suggested order)

**Slice B (weeks 1-2) — wire up what's already built**
- A1: Semantic story grouping (handler + UI cluster count) — biggest UX win for least work
- A2: Coverage gaps → auto-source acquisition (turn existing data into action)
- G1: PageRank on event graph (free quality lift on A1)
- M1: MinHash dedup (prevents garbage from polluting the system)
- X4: Stale-while-revalidate (instant perceived perf)

**Slice C (weeks 3-4) — personalization layer**
- P3: Saved regions
- U5: Personalized "what changed near you" digest
- X8: Time-travel slider
- A6: Auto-translation

**Slice D (weeks 5-8) — predictive + conversational**
- A3: Adaptive refresh scheduling (M10 bandit)
- A7: Predictive event heatmap (M8 Hawkes)
- U1: Conversational search
- U2: "Tell me more about this story"

**Slice E (backlog) — research-grade**
- G3: Louvain communities
- A4: Cross-language story tracking
- U3: Bias analyzer

---

## Part 4 — Risk & Cost Notes

| Concern | Mitigation |
|---|---|
| **LLM cost** — A6/U1/U2 add real $. | Cache aggressively; use `gpt-4o-mini` for translation; reserve GPT-4 for conversational search |
| **Latency** — U1 conversational adds 1-3s | Stream responses; show "thinking" indicator; pre-warm common queries |
| **Privacy** — P1/P3 store user history | Hash user IDs; offer opt-out; document retention |
| **Bias amplification** — A3 bandit could starve minority sources | Epsilon-greedy with ε≥0.1 to keep exploring |
| **Eval** — many features need quality measurement | Build eval harness before shipping; use `news_extraction_feedback` as ground truth for extraction features |
| **FDW constraint** — anything touching `world_cities` is fragile | Move to materialized local view refreshed nightly |

---

## Part 5 — Quick Wins (ship this week)

If you only do 3 things:

1. **Wire up `news_story_links` in worker queue** (A1) — biggest user-visible win
2. **Add `/api/admin/coverage-gaps/top` endpoint** (A2 first slice) — turns existing data into action
3. **PageRank on event graph** (G1) — runs in `links_run.py` handler; no UI changes needed

Each is ≤1 day of work and unlocks the next layer.
