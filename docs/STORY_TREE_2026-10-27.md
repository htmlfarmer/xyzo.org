# Story Tree — per-story relationship tree (2026-10-28)

`GET /api/pins/:id/tree` and `GET /api/events/:id/tree`.

## What it answers

"Click a pin → what else is connected to **this story**?"

The map renders **events** (a pin is a cluster of articles). The link graph
`news_story_links` is **article↔article**. The old endpoint
`GET /api/links/:articleId` answered for ONE article of a cluster that can
hold 3,000 — so it returned nothing, or an arbitrary slice, for most pins.
The tree resolves the pin to its **event** and ranks the whole cluster's
neighbourhood.

```
● Harry Kane wins Ballon d'Or            [root event]
│
├─ ⬤ Same story · 1,088 other outlets    ← the event's own members
│
├─ ★ MOST RELATED          score ≥ 0.55
│   ├─ ● Ballon d'Or 2026 — full ceremony recap    0.94  🧠 semantic
│   │   └─ ● Ceremony date moved to 27 Oct         0.71  (depth 2, lazy)
│   └─ ● Putellas wins her second Ballon d'Or      0.91
│
├─ ◐ RELATED               0.32 ≤ score < 0.55
│   └─ ● Bundesliga reacts to Kane's award         0.62  🏙 same_city
│
└─ ○ LONG TAIL             score < 0.32   (collapsed, loads on expand)
      └─ ● Kane's transfer to Madrid (July)        0.21  🤖 ai_detected
```

## Measured latency

Budget: **10 s per click** (hard ceiling), target a few seconds.

| Case | Time |
|---|---|
| Browser: click → popup → tree painted | **246–463 ms** |
| API, warm | 20–180 ms |
| API, fresh (never-cached pin) | 84–552 ms |
| API, cold **before** the covering indexes | up to **26.6 s** |
| API, cold **after** the covering indexes | 84–970 ms |
| Median over 20 random map pins | 152 ms |

`meta.timings` breaks the request into `resolve_ms` / `siblings_ms` /
`level_ms`. `?fresh=1` bypasses the 15-minute cache (use it to measure).

**There is a hard ceiling.** The level query runs under
`statement_timeout = 6000`. On a timeout it re-runs without the semantic
candidates and returns `meta.timed_out: true` (the UI shows
"⚠ timed out — partial"). The contract is 10 s per click, and a cold
query that once took 26.6 s now degrades instead of hanging.

**The covering indexes are what made the cold case bearable.**
`idx_news_story_links_src_cover (source_article_id, link_strength DESC)
INCLUDE (target_article_id, link_type)` and the `_tgt_cover` mirror turn
the fan-out into an index-only scan. Without them the fan-out does a
random heap read into the 25 GB link table per row, and the cold cost was
26.6 s.

The **tree is lazy** — it is only fetched when a pin is clicked, so it never
touches the map-load path.

## The query, and why it is fast

One round trip. Two hot parts:

**1. Graph fan-out.** `news_story_links` is 42.9 M rows / 25 GB. The
naive form (every link of every member) scanned 77,915 rows and took
1.5–3.5 s. The fix is a `LATERAL` with `ORDER BY link_strength DESC LIMIT
n` per member, which turns it into an **index-only scan that stops early**
on the existing `idx_news_story_links_source`:

```sql
JOIN LATERAL (
  SELECT target_article_id AS o, link_type, link_strength
  FROM news_story_links l
  WHERE l.source_article_id = m.article_id
  ORDER BY link_strength DESC
  LIMIT 12
) l ON true
```
Measured: 22 ms for a 3,212-member event (77,915 → 8,712 rows).

**2. Semantic fan-out.** HNSW KNN over `nn_article_sentence_embeddings`
(384-dim MiniLM). Measured 130 ms.

**Do NOT split the `OR` into a BitmapOr.** The old form
`WHERE (source_article_id = v.id OR target_article_id = v.id) ORDER BY
link_strength DESC LIMIT 12` compiles to a **Bitmap Heap Scan + a Sort per
article** (1,200 sorts in the arcs query) because a BitmapOr cannot
preserve the index order. Split into a `UNION ALL` of two ordered
`LATERAL`s and it becomes an Index Only Scan with a Limit.

## The ranking

```
score = 0.55 · semantic_cos
      + 0.25 · min(1, keyword_containment × 4)
      + 0.20 · link_strength
```

`semantic_cos` dominates because it is the only signal that actually
measures "same story". `link_strength` is kept only as a weak prior
because **it is saturated**: 89 % of `ai_detected` rows sit in [0.9, 1.0]
and the model returns `same_story` at 0.99 for articles about different
countries.

`keyword_containment` = weighted overlap between the root's top-40
`word_freq` keywords and the candidate's.

Buckets: **strong ≥ 0.55**, **medium ≥ 0.32**, **weak** below. The weak
bucket is collapsed in the UI.

## Three upstream problems this exposed

### 1. The `ai_detected` links are a same-language, same-day matcher

For "Prozess um Nord-Stream-Anschlag" the top NN-linked neighbours were
Arsenal transfer news, Trump voter fraud, Swiss authors and Montreal
helicopter crashes. The link gate is
`if same_country < 0.5 and same_event_type < 0.5: continue` — so the
candidate pool is "same country, same topic, same few days", and the
16-dim triplet embeddings collapse (141,680 rows have cosine = 1.000).

**This is why the ranking must not trust `link_strength`.** The tree's
score demotes it on purpose, and the "Long tail" bucket is where those
links land.

### 2. 25 % of all event membership sits in 840 garbage clusters

```
active events                    118,378
events with > 50 members             840   (0.7 % of events)
members inside those 840         100,197   of 404,282  → 25 %
```

Event 321,413 has 1,089 members whose headlines span Croatian, Arabic,
Persian, Indonesian, Chinese and English, about karate, OPEC and football.

**Cause:** `worker/cluster.py` matches on `primary_location_id +
event_type + occurred_at ± 6 h`. These members were clustered when they
shared a (wrong) location and were **re-geocoded later without rebuilding
the cluster** — 150 are still at the original `Podgorica, ME`, 939 were
moved to their true cities. The cluster is stale membership, not a real
story.

`root.is_mega_cluster` flags this in the API and the UI shows
"⚠ broad cluster".

### 3. The semantic index was frozen, and biased

`xyzo-embeddings.timer` was **disabled** since 2026-09-15 — 363,688
embeddings, six weeks stale, so every recent article had no vector and
Pass 3 of the story linker had been blind. Now **enabled** (2-hourly) and
the 7-day backlog was encoded (755,614 vectors).

The composed text was also wrong: `title | summary[:300] | Location: X |
Type: Y` put the place name and event type on equal footing with the
headline, so two unrelated stories from the same city with the same type
embedded almost identically. It is now `title | title | summary[:150]`
(the title repeated, location/type dropped) — the geographic signal stays
in the ranker and the map, it just no longer dominates the vector.

`--force` re-encodes rows that already have a vector (needed when the
composed text changes). The worker now **falls back to CPU** on CUDA OOM
and on a GPU model-load failure — the shared GPU on this host was
abandoning whole batches (8,192 articles lost in one backfill).

## How the ranking was fixed

The first version scored `0.55·semantic_cos + 0.25·kw + 0.20·link_strength`
and the results were still wrong, in three distinct ways. Each fix has a
regression test.

1. **`ai_detected` links carried 0.99 strengths.** They outranked genuine
   semantic neighbours. `ai_detected` now has a **type weight of 0**; the
   rule-based links (`same_entity`, `semantic_similarity`, `same_event`)
   keep theirs.
2. **Pins with no event cluster fell into a fallback branch** that returned
   raw link strengths with no semantic scoring at all — a 0.99 noise link
   was presented as a 0.99 "most related" score. Both paths now share one
   scorer, and a candidate that belongs to no event is still a child
   (under a synthetic negative id).
3. **The seeds were arbitrary cluster members.** A router-bug article once
   shared a stale event with eight Ballon d'Or articles, and half the
   retrieved stories came from the wrong story. The seeds are now the
   clicked article plus its cosine-verified siblings.

Before / after, same pin, same data:

| | before | after |
|---|---|---|
| router-bug story | Arsenal, Trump, Mumbai IPO | "Your router shipped with weaker security", "MikroTik Patches Critical Flaws", "6 reasons your brand new router is making your Wi-Fi worse" |
| dehumidifier guide | Arsenal, Trump, Swiss authors | "Is indoor air safer?", "Dehumidifier will dry damp and laundry faster", "'Astonishing' dehumidifier ideal for old houses" |
| Nato spending targets | AI security funding stories | "7 big questions as Britain hikes defense spending", "Budget will outline path to meet defence spending pledge" |

## Known limits

- **HNSW updates leave dead entries.** After a bulk re-encode, `REINDEX
  INDEX nn_article_sentence_embeddings_emb_hnsw_idx` (or `VACUUM
  ANALYZE`) is needed or the index keeps returning pre-update vectors.
- **Title-only embeddings are place-biased** when the place name is in the
  headline ("Kédougou : …" matches every other "Kédougou :" story). Those
  are honestly *different* stories that share a news cycle; the tree
  reports them as mid-cosine "Related", not "Most related".
- **Coverage is a flow, not a property.** The linkers only look back 24 h
  (`nn_batch_links --hours 24`) and 3 d (`story_linker days=3`), so a
  story that ages out loses its edges. 96 % of articles from the last 7
  days have ≥ 1 link; 81 % of active events do.
- The tree's **depth 2** is exposed as `GET /api/events/:id/tree`; the UI
  does not wire it yet.

## Files

| File | What |
|---|---|
| `api/src/routes/story-tree.ts` | the route + ranking + cache |
| `api/tests/story-tree.test.ts` | 8 tests (resolution, buckets, ranking, budget) |
| `public_html/app.js` | `renderPinTree()` + the popup section |
| `public_html/styles.css` | `.popup-tree-*` |
| `worker/populate_embeddings.py` | title-weighted text, `--force`, CPU fallback |
