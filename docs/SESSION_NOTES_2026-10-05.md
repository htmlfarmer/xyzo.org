# Session Notes — October 5, 2026

## Objective
- Redesign XYZO bottom bar into cockpit-style 5-button interface (completed at `?v=202610041400`)
- Fix pin popup appearing behind search bar (in progress)
- Reduce database size from 55GB toward 10GB by storing compacted article data (word_freq) instead of full text

## Important Constraints
- `setTimeout` and `requestAnimationFrame` callbacks do NOT fire in headless Playwright Chrome in this environment
- Playwright headless browser timers are blocked — Playwright context seems to suspend JS event loop after initial script execution
- Popup issue confirmed at Sri Lanka URL: popup at y=-21 (above viewport), height 408px, extends to y=387, overlaps top bar at y=12-56
- Screenshot confirmed: "Gnanasara Thera to be produced" popup barely visible behind search bar
- Database is 59GB (not 55GB as previously stated): city_story_features 14GB, news_articles 9.6GB, news_story_links 9GB, news_term_df 8.7GB, nn_* tables ~7GB
- User wants high-quality NN data (nn_* tables) kept; prefers storing word_freq over full text

## Work State
### Completed
- Bottom bar redesign deployed at `?v=202610041400` with 5 cockpit buttons
- Bumped `.leaflet-popup-pane` z-index from 700→1200
- Bumped `.cmd-dropdown` z-index from 500→800
- Confirmed popup at y=-21 overlapping top bar via Playwright screenshot at Sri Lanka URL
- Verified `news_articles.word_freq` jsonb already stores keyword frequencies (881MB actual)

### Active
- Fix code for popup z-index added to `app.js` at `openPinPopupFromCanvas()` (lines 4929-4951)
- Uses RAF loop to shift popup down if top < y=60
- Fix deployed at `app.js?v=202610042345` but NOT tested in Playwright (timers blocked)
- Popup z-index fix code currently deployed but status unknown — user needs to test in real browser

### Blocked
- Cannot test RAF/setTimeout-based popup fix in Playwright (timers don't fire in headless)
- Need user to test popup fix in real browser at `https://xyzo.org/#6.9396,79.8610,13`

## Database Analysis (Actual Measured Data - 2026-10-05)

### Total: 59 GB

| Table | Total | Data | Indexes | Rows |
|-------|-------|------|---------|------|
| city_story_features | 14 GB | 7.5 GB | 6.7 GB | 31.8M |
| news_articles | 9.6 GB | 3.1 GB | 6.5 GB | 1.6M |
| news_story_links | 9 GB | 2.9 GB | 6.2 GB | ? |
| news_term_df | 8.7 GB | 6.6 GB | 2.1 GB | 2.4M |
| nn_prediction_cache | 2.8 GB | 2.1 GB | 0.8 GB | ? |
| nn_training_features | 1.6 GB | 1.5 GB | 0.2 GB | 1.6M |
| nn_article_sentence_emb | 1.4 GB | 0.7 GB | 0.7 GB | ? |
| nn_article_leaderboard | 1.3 GB | 0.8 GB | 0.5 GB | ? |
| article_facts | 1.1 GB | 0.8 GB | 0.3 GB | ? |
| nn_article_embeddings | 1.1 GB | 0.3 GB | 0.8 GB | 1.6M |

### Key Findings

**1. news_articles indexes are 2x the table data (6.5 GB vs 3.1 GB)**

Largest indexes:
- `news_articles_fts_idx` (FTS on title+summary+**body**) = 1092 MB
- `idx_news_articles_fts_extracted` (FTS partial on **body**) = 899 MB
- `idx_news_articles_title_trgm` = 601 MB
- `idx_news_articles_summary_trgm` = 494 MB
- `news_articles_url_source_unique` = 484 MB

**If we drop `body` column → can drop 2 GB of FTS indexes immediately.**

**2. city_story_features is 14 GB of recent batch data**

- 31.8M rows, ALL from 2026-09-20 (same day as batch extraction run)
- 40 columns of per-story-per-city features
- Likely a feature extraction run that was一次性 (one-time) and can be recomputed
- **NOT historical data** - all one batch

**3. Actual column sizes in news_articles:**

| Column | On Disk | Notes |
|--------|---------|-------|
| body | 2.4 GB | Can drop - word_freq has the essence |
| word_freq | 881 MB | Keep - compact keyword storage |
| title | ~100 MB | Keep |
| summary | ~50 MB | Keep |

**4. NN data is 7+ GB and expensive to regenerate**

All nn_* tables should be kept - they contain expensive-to-compute embeddings and training data.

## Proposed Compact Mode Plan

### Step 1: Drop body column
```sql
ALTER TABLE news_articles DROP COLUMN body;
```
- Saves 2.4 GB
- Low risk - can re-scrape if needed

### Step 2: Drop FTS indexes on body
```sql
DROP INDEX IF EXISTS news_articles_fts_idx;
DROP INDEX IF EXISTS idx_news_articles_fts_extracted;
```
- Saves 2.0 GB
- Text search can use trigram indexes + embeddings

### Step 3: Regenerate news_term_df from word_freq (if needed)
- Saves 8.7 GB temporarily
- Can be recomputed from word_freq

### Step 4: Evaluate city_story_features truncation
- 14 GB of one-time batch data
- Can likely truncate after verifying it's all from same extraction run

### Total Potential Savings: ~27 GB → 59GB becomes ~32GB

## Files Changed Today

- `README.md` — Added "Database Storage Strategy" section with actual measured data
- `XYZO_SYSTEM_MAP.md` — Updated table sizes to actual measured values

## Next Steps

1. **Popup test**: User test at Sri Lanka URL `https://xyzo.org/#6.9396,79.8610,13`
2. **DB compaction**: Implement compact mode plan above
3. **Validate**: Run `bash scripts/validate-api.sh` before any deploy
