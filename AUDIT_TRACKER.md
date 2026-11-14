# XYZO Audit — Deferred Study & Improvement Tracker

*Created: 2026-09-13*
*Last updated: 2026-09-13 (robots system added)*

This file tracks issues, opportunities, and experiments discovered during the
2026-09-13 full-site audit. Items are organized by priority and category.

─────────────────────────────────────────────────────────────────
HIGH PRIORITY — Fix These Soon
─────────────────────────────────────────────────────────────────

[x] RE-ENABLE DISABLED SOURCES
    ─────────────────────────────────────────────────────────
    DONE 2026-09-13: All 3,730 sources re-enabled via:
      UPDATE news_sources SET active = TRUE, error_count = 0 WHERE active = FALSE;
    Root cause: ~1,265 sources failed simultaneously at 13:09–13:54 on
    Sep 10 — a network/DNS event, NOT feed problems.
    ─────────────────────────────────────────────────────────

[ ] ADD nn_infer TO AUTOMATIC PIPELINE
    ─────────────────────────────────────────────────────────
    nn_infer.py is never called automatically.
    The GPU sits at 7% utilization — massive waste.
    All 6 model types are ready but dormant:
      1. article_understanding (embeddings)
      2. geolocation predictions
      3. event_matching
      4. relationship detection
      5. ranking ← MOST IMPORTANT
      6. coverage scoring

    The nn_article_leaderboard_live view shows default blended_score=0.525
    for almost all articles — no real ranking differentiation.

    Action: Add `python -m worker.nn_infer --limit 500` to nightly script.
    File to edit: scripts/nightly-automation.sh
    ─────────────────────────────────────────────────────────

[ ] INCREASE AI EXTRACTION RATE
    ─────────────────────────────────────────────────────────
    Current: --limit 100 per night = ~100 articles/night.
    At this rate: 10+ years to process existing backlog.

    Nightly limit 100 is too conservative.
    GPU headroom: RTX 3050 at 7% util, 4.7/6 GB memory.

    Recommended: --limit 2000 in nightly, add midday run.
    Also: reduce circuit breaker threshold or increase cooldown.

    File to edit: scripts/nightly-automation.sh
    Environment vars:
      NEWSIUM_AI_MAX_PER_CYCLE=2000  (currently 60)
    ─────────────────────────────────────────────────────────

─────────────────────────────────────────────────────────────────
MEDIUM PRIORITY — Within 1–2 Weeks
─────────────────────────────────────────────────────────────────

[ ] TITLE-ONLY AI EXTRACTION MODE
    ─────────────────────────────────────────────────────────
    Currently extract.py sends: title + first 2,500 chars of body.
    This is already "title-heavy" but body is still fetched and stored.

    Create a lighter mode that sends only:
      - title
      - source name + country
      - first 500 chars of body snippet (RSS summary)

    This would allow processing more articles faster, with less
    token cost, using body only as fallback.

    File: worker/extract.py — add --title-only flag
    Benefit: 5x faster extraction, lower token cost.
    ─────────────────────────────────────────────────────────

[ ] INVESTIGATE fast_path CATEGORIZATION QUALITY
    ─────────────────────────────────────────────────────────
    61% of articles (216K) use fast_path (keyword+city matching).
    Only 3 articles have been through ai_study (actual LLM).
    fast_path confidence distribution:
      high: 48,552 | medium: 43,672 | low: 31,946

    The "AI-powered" claim is misleading for 97%+ of articles.
    Consider: What is the accuracy rate of fast_path vs ai_study?
    ─────────────────────────────────────────────────────────

[ ] POPULATE nn_hot_topics TABLE
    ─────────────────────────────────────────────────────────
    nn_hot_topics and nn_v_hot_topics_latest are EMPTY.
    The "trending topics" feature in the legend won't work.

    Action: nn_infer --only coverage needs to run to populate this.
    Also: check why it went empty (last successful population date?).
    ─────────────────────────────────────────────────────────

[ ] nn_entity_cache IS EMPTY (0 rows)
    ─────────────────────────────────────────────────────────
    Entity cache has 0 entries. The entity extraction (people, orgs)
    from articles is not being stored for re-use.

    File: worker/extract.py — entities are extracted but not cached.
    ─────────────────────────────────────────────────────────

[ ] nn_event_embeddings IS EMPTY (0 rows)
    ─────────────────────────────────────────────────────────
    No event embeddings stored. The relationship detection model
    needs these to find story connections.

    File: worker/populate_embeddings.py — has the logic but not called.
    ─────────────────────────────────────────────────────────

[x] ROBOTS.TXT TRACKING SYSTEM — PERSIST VERIFICATION RESULTS
    ─────────────────────────────────────────────────────────
    DONE 2026-09-13:
    - Added columns to news_sources: robots_checked_at, robots_status,
      robots_content_hash, robots_http_status, robots_sitemaps,
      robots_crawl_delay_s
    - Added persist_to_db() method to RobotsCache (worker/robots.py) —
      writes verification result to DB after each robots.txt check
    - Updated fetch.py to call robots.persist_to_db() after each check —
      every fetch cycle automatically populates the DB
    - robots_verify.py REWRITTEN to use RobotsCache instead of duplicating
      fetch logic — for backfilling/rerechecking sources on demand

    HOW IT WORKS:
    - Inline in fetch.py: every time a source is fetched, robots.is_allowed()
      is called and result is persisted to DB via persist_to_db(). No separate
      scheduling needed — robots.txt is checked when we fetch.
    - robots_verify.py: on-demand backfill tool (python -m worker.robots_verify
      --since 7 --limit 500) for catching up sources that haven't been checked.
    - RobotsCache TTL (24h default, 10min on 5xx) controls re-check frequency.

    Stats (2026-09-13): 2,892/3,625 active sources have robots_checked_at set.

    Done:
      - --only-changed flag to detect robots.txt changes between runs
    ─────────────────────────────────────────────────────────

[ ] nn_feedback TABLE IS EMPTY (0 rows)
    ─────────────────────────────────────────────────────────
    User corrections/implicit feedback not being collected.
    The learning loop has no feedback signal.

    Files: api/src/routes/feedback.ts — does it write to nn_feedback?
    ─────────────────────────────────────────────────────────

[ ] story_links only has 322 rows
    ─────────────────────────────────────────────────────────
    Story connection graph is barely populated.
    The "Links" feature on the map shows connections between stories.

    Files: worker/story_linker.py, worker/links.py
    The nn_event_pair_predictions table is also likely empty.
    ─────────────────────────────────────────────────────────

[ ] world_cities table inaccessible
    ─────────────────────────────────────────────────────────
    Attempted SELECT returned: "user mapping not found for 'asher'".
    The world_cities table exists (referenced in geo lookups) but
    asher role can't access it.

    Action: Grant permission or investigate XYZO_DB_DSN discrepancy.
    ─────────────────────────────────────────────────────────

─────────────────────────────────────────────────────────────────
LOWER PRIORITY — Good to Have
─────────────────────────────────────────────────────────────────

[ ] DROP news_articles.body COLUMN
    ─────────────────────────────────────────────────────────
    body column stores full article text (~15KB per article).
    Total: ~500MB+ in the news_articles table.
    AI extraction only reads first 2,500 chars.

    Options:
      A) ALTER TABLE news_articles DROP COLUMN body;  -- irreversible
      B) Move body to a separate table (news_article_bodies)
      C) Keep body only for articles < 30 days old

    Rationale for dropping: Users don't read full articles on the map.
    They read summaries + click through to original sources.
    Full body is only needed for full-text search (not implemented).

    Risk: Any future feature needing full text is blocked.
    Recommendation: Keep for 30 days, then drop to news_article_bodies.
    ─────────────────────────────────────────────────────────

[ ] nn_training_runs — 4 completed, 0 failed
    ─────────────────────────────────────────────────────────
    Models have been trained 4 times but training seems to have stopped.
    Check: Are retraining schedules running? Is there a training script?
    File: worker/nn_train.py
    ─────────────────────────────────────────────────────────

[ ] news_coverage_gaps last run Aug 26
    ─────────────────────────────────────────────────────────
    Coverage gap analysis ran once on Aug 26 and stopped.
    It identified 1,276 gap regions.

    Should run weekly or after major source additions.
    File: worker/coverage_bot.py or learn.py detect_coverage_gaps()
    ─────────────────────────────────────────────────────────

[ ] 15+ countries have ZERO active sources
    ─────────────────────────────────────────────────────────
    CI, TM, TT, BH, TD, PS, NE, JM, LY, and others have 0 active.

    These are small countries but some are strategically important.
    Script: worker/auto_seed_unserved_cities.py
    Nightly automation runs this but coverage may be incomplete.
    ─────────────────────────────────────────────────────────

[ ] pins table has only 6 rows (community submissions only)
    ─────────────────────────────────────────────────────────
    The /api/pins/map endpoint returns news_events, not the pins table.
    The pins table is only for community-submitted reports.

    This is actually fine — the map uses news_events as pins.
    But the system is confusing: two "pin" concepts.
    Consider: Document the architecture clearly.
    ─────────────────────────────────────────────────────────

[ ] article_leaderboard scores all identical (0.525 blended)
    ─────────────────────────────────────────────────────────
    Almost every article in nn_article_leaderboard_live has:
      nn_ranking_score = 0.5 (default)
      classical_engagement = 0 or 1
      blended_score = 0.525

    No differentiation = no "hot" ranking = no trending.
    This is because nn_infer ranking model is not running.

    Fix: Enable nn_infer in pipeline (see HIGH PRIORITY above).
    ─────────────────────────────────────────────────────────

─────────────────────────────────────────────────────────────────
ARCHITECTURE / DESIGN QUESTIONS
─────────────────────────────────────────────────────────────────

[ ] Two DB connections in use?
    ─────────────────────────────────────────────────────────
    worker/db.py uses XYZO_DB_URL or NEWSIUM_DB_URL.
    api/src/db.ts uses XYZO_DB_URL or NEWSIUM_DB_URL.
    But the API connects as xyzo_app and worker connects as ???

    Confirmed: API is using XYZO_DB_URL (found in api/.env).
    Worker connects via NEWSIUM_DB_URL (found in worker/db.py).
    These may be different DSN strings pointing to same DB.

    Investigation needed: What DSN does the worker actually use?
    The .env file for worker/ may differ from api/.env.
    ─────────────────────────────────────────────────────────

[ ] Why 1,535 disabled sources with error_count < 100?
    ─────────────────────────────────────────────────────────
    1,689 disabled sources total.
    1,265 failed at Sep 10 with very high errors.
    But 1,535 is much larger than those with high errors.

    227 sources failed before Sep 10 too.
    Some sources may have been disabled manually or by other triggers.

    SQL to check:
      SELECT COUNT(*) FROM news_sources
      WHERE active = FALSE AND error_count <= 100;
    ─────────────────────────────────────────────────────────

[ ] Fast mode (--fast) skips AI entirely
    ─────────────────────────────────────────────────────────
    The cron script uses --fast which runs:
      fetch → auto_categorize → geocode → cluster

    AI extract and learn are skipped.
    This means the cron (every 15 min) does NOT use AI at all.
    Only the nightly (3 AM) uses AI with --limit 100.

    Consider: Add a "medium" mode that runs AI with a low limit.
    ─────────────────────────────────────────────────────────

[ ] Source geographic coverage skews heavily to US/IN/AR/BR/DE
    ─────────────────────────────────────────────────────────
    Top 6 countries: US (514), IN (67), BR (70), DE (28), ME (33), ID (31)
    These 6 account for ~40% of all articles.

    Coverage of Africa, Central Asia, and Eastern Europe is thin.
    news_coverage_gaps shows: India, China, Tanzania, Indonesia, Peru
    as highest-priority gaps.

    Consider: Source discovery campaigns for:
      - Sub-Saharan Africa (KE, TZ, NG, ZA already decent)
      - Central Asia (KZ, UZ, AZ, KG, TJ, TM)
      - Eastern Europe (UA, BY, RS, BG, RO, GR)
      - South America (CO, CL, PE, EC, BO, PY, UY, GY, SR)
    ─────────────────────────────────────────────────────────

─────────────────────────────────────────────────────────────────
CURRENT LIVE STATS (2026-09-13 snapshot)
─────────────────────────────────────────────────────────────────
    DB size:              6.6 GB
    news_articles:         353,819 rows
    news_events:           98,113 rows
    news_sources:          3,730 total / 2,041 active
    world_cities:         unknown (access issue)
    story_links:           322
    ai_cache:             6,727 entries
    nn_prediction_cache:  450,945 entries / 192 MB
    ai_study articles:     3 (0.001% of total)

    GPU: RTX 3050 — 7% util, 5% mem, 46°C
    CPU: 86.7% idle
    API response (world pins): 519ms TTFB

─────────────────────────────────────────────────────────────────
PIPELINE NOTES
─────────────────────────────────────────────────────────────────
    python -m worker.run --fast        → fetch + auto_cat + geocode + cluster (no AI)
    python -m worker.run --limit 100   → full + AI extract 100 articles (nightly)
    python -m worker.nn_infer          → NOT IN PIPELINE (dormant)
    python -m worker.learn             → runs after nightly (source priorities only)

    Circuit breaker: trips at 5 failures / 3 min cooldown
    AI batch size: 60 articles/cycle (MAX_ARTICLES_PER_CYCLE)

─────────────────────────────────────────────────────────────────
