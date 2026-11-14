# XYZO AI Session Notes — Asher & Goddess Partnership
**Last session:** Wed Sep 09 2026
**Status:** HELP ME CHAT is LIVE at xyzo.org with memory, location, and follow-up

---

## WHAT WE BUILT TODAY 🇵🇰✨

### 1. Help Me Chat — LIVE
- Orange floating button (bottom-right) at xyzo.org
- Opens bold/funny/specific AI problem-solving chat
- Personality: knowledgeable friend who tells it straight
- Uses `/api/ai/chat` with custom system prompt
- Frontend: `public_html/help-me-chat.js` (384 lines)
- Button wired in `public_html/index.html` (line ~505)

### 2. GEOLOCATION AWARENESS
- Button handler reads `localStorage['newsium.home']` for user's set home
- Falls back to map center if no home set
- Passes `{ lat, lng, name, city, country, source }` to chat
- Chat shows "📍 Karachi, PK (24.8607°, 67.0011°)" in intro when known
- On first question: fetches `/api/problems?lat=...&lng=...&radius=500&limit=5&status=active`
- Includes nearby problems in AI prompt with severity scores

### 3. USER MEMORY SYSTEM (localStorage `xyzo.helpme.memory`)
Tracks across sessions:
- `conversations[]` — last 20 convos with question + reply snippet + timestamp
- `topicsViewed[]` — topic keywords from questions + article clicks (flood, war, pakistan, etc.)
- `problemsSeen[]` — problem types clicked (Flood, Earthquake, etc.)
- `storiesViewed[]` — article headlines clicked
- `lastVisit` — ISO timestamp
- `lastRecommendation` — { topic, suggestedAction, fullReply, ts }

### 4. PERSONALIZED GREETING
- First visit: "Hey! Ask me about any problem..."
- 1 prior visit: "Welcome back! I remember our last chat."
- 2-5 visits: "Good to see you again! You've been here N times."
- 5+ visits: "Hey friend! You're a regular now..."
- Has last rec: "Last time you asked about X — I suggested Y. Did you do it?"

### 5. "DID YOU FOLLOW THROUGH?" FOLLOW-UP
- After every AI reply, stores `{ topic, suggestedAction, fullReply, ts }`
- On reopening chat: greeting asks if they followed through
- AI prompt includes: "If user asks about same topic, ask if they followed through"
- Feels like a friend who actually cares whether you did the thing

### 6. app.js STORY CLICK TRACKING
- When user clicks a live panel story: calls `window.XyzoHelpMe.track("article", headline)`
- Also tracks `topic` from city name
- Connect dots: reading history → AI knows your interests

### 7. PROBLEMS API — Geo Filter
- Added `lat`, `lng`, `radius` params to `GET /api/problems`
- Bounding box filter (no PostGIS needed): `lat ± radius/111`, `lng ± radius/(111*cos(lat))`
- Returns `location_lat`, `location_lng` in response
- Works: tested with Busan coords (35.10, 129.03) → finds Busan problems
- Route: `api/src/routes/problems.ts`

---

## API ENDPOINTS RELEVANT TO HELP ME
```
GET /api/problems?lat=24.86&lng=67.00&radius=500&limit=5&status=active
GET /api/problems/:id
GET /api/problems/stats
POST /api/problems/:id/actions/:actionId/approve
GET /api/ai/chat  (body: { message, stream: false })
```

---

## FILES WE TOUCHED
```
public_html/help-me-chat.js        ← chat UI + memory + personalization
public_html/index.html             ← getUserLocation() + button handler
public_html/app.js                 ← story click tracking (line ~11864)
api/src/routes/problems.ts          ← lat/lng/radius geo filter
```

---

## PROBLEM DETECTOR (already running)
- Worker: `worker/problem_detector.py`
- Detects recurring/emerging problems from news events
- Creates problems + links events + generates default actions
- Currently: 20 active problems, 619 events, 20 actions
- Run: `python -m worker.problem_detector --dry-run` or real
- Cron: every 15min via `xyzo-fetcher` service

---

## WHAT TO DO NEXT (your call!) 🚀

### Phase 1 — Make Help Me EVEN SMARTER
- [ ] AI generates SPECIFIC actions (not just template) using Gemma
- [ ] Show problem severity badges in chat intro
- [ ] "Tell me more about this problem" → fetches `/api/problems/:id` with actions
- [ ] "I did it!" / "I didn't do it" buttons after recommendations
- [ ] Track outcome: saves `memory.outcomes[]` with did/not-did + how it went

### Phase 2 — Problem Outcomes Pipeline
- [ ] `POST /api/problems/:id/actions/:actionId/outcome` — user reports result
- [ ] `GET /api/problems/:id/actions` — list actions with outcomes
- [ ] AI looks at outcomes to learn what actually worked
- [ ] "Based on what 47 people reported about donating to Edhi..."

### Phase 3 — Multi-User / Sync
- [ ] `localStorage` → `sync()` to server with user auth
- [ ] So AI remembers across devices
- [ ] Or: anonymous UUID in localStorage, no login needed

### Phase 4 — World Event Alerts
- [ ] When breaking event detected → proactive Help Me notification
- [ ] "Something big just happened in Karachi. Want to know what I know?"
- [ ] Uses SSE stream already in `liveState.sse`

### Phase 5 — The Fun Stuff
- [ ] Voice input option (Web Speech API)
- [ ] "Snap a photo of a news article" → AI explains it
- [ ] Mood tracker: "how are you feeling about all this?" → adjusts tone
- [ ] Community wisdom: "Other people near you suggested..."

---

## GEMMA INTEGRATION (already set up)
- Endpoint: `http://192.168.1.3:8888/chat/stream`
- Model: Gemma 4 instructions-tuned
- Timeout: 25s
- Used for: problem categorization, location extraction, summary generation
- AI chat: also uses this endpoint via `/api/ai/chat`

---

## XYZO PRODUCT THESIS (from README)
> "XYZO exists to help humans act on world events — not just read them.
> The gap between "saw news" and "did something" is where we live."
>
> Problem Detection → Action Recommendation → Outcome Tracking → Learning

---

## THE VIBE WE'RE GOING FOR
- Like a really smart group chat with a friend who's read everything
- Not a corporate chatbot — more like a wise, slightly sarcastic older sibling
- Pakistani/Indian/Islamic cultural warmth — respectful of heritage, not sterile
- Funny when appropriate, deadly serious when it matters
- "WhatsApp forwards about this are 90% wrong. Don't be that person."
- "Honestly? Nothing direct you can do. But here's what to watch."
- The AI should feel like it's been paying attention to YOU specifically

---

## NOTES TO SELF FOR NEXT SESSION
- API validated with `bash scripts/validate-api.sh` ✓
- `systemctl restart xyzo-api` after API changes ✓
- Frontend is static — no restart needed, just refresh
- Help Me chat JS served from `public_html/help-me-chat.js` (not bundled)
- All user memory in localStorage key `xyzo.helpme.memory`
- Problems DB: `news_problems`, `news_problem_events`, `news_problem_actions`, `news_problem_outcomes`
- `newsium.home` = the home location key in localStorage (from live panel)
- XY Log: `XLog.log/warn/error/debug()` — not `console.log`!
- If API returns 404 on `/` — that's normal. Try `/api/health`

---

## QUICK TEST COMMANDS
```bash
# Restart API after changes
sudo systemctl restart xyzo-api

# Check API health
curl http://localhost:3008/api/health

# Check problems
curl "http://localhost:3008/api/problems?lat=24.86&lng=67.00&radius=500&limit=3&status=active"

# Check stats
curl http://localhost:3008/api/problems/stats

# Validate
cd /var/www/vhosts/xyzo.org && bash scripts/validate-api.sh

# Live site
curl -sk https://xyzo.org/help-me-chat.js | head -5
```

---

## ASHER SAID
> "keep it VERY FRIENDLY and VERY PERSONAL"
> "does our AI have access to what you have done.. and where you have looked"
> "thanks!1"

**Message received. The AI is now listening. 🌍✨**

---

*Session notes by Goddess — your always-paying-attention AI partner* 😏
*Next time: we make it even more personal, more honest, and more actionable*
*Because reading news without acting = just anxiety*
*XYZO = bridge from "that's sad" to "here's what I did"*

---

## CODE REVIEW NOTES (Sep 9 2026 — full review)

### Bugs Found & Fixed

1. **Greeting ReferenceError** — `getDaysAgo()` defined at line 204 but used at line 80 (before it was declared). Fixed: moved helpers above greeting logic.

2. **`locationInfo` undefined** — Old code referenced `locationInfo` in DOM template at line ~98 but it wasn't in scope. Fixed: properly defined in DOM template scope.

3. **`visitCount` greeting priority bug** — greeting was set → overwritten by visitCount → overwritten by lastRecommendation. If lastRecommendation existed, `getDaysAgo(rec.ts)` threw ReferenceError. Fixed: helpers defined first, proper priority order.

4. **Wrong SYSTEM_PROMPT** — personality was accidentally replaced with generic "explore stories on the map" theme. Fixed: restored bold/problem-solving personality.

5. **Dead `XyzoQuickQuestions` reference** — old code called `window.XyzoQuickQuestions.get()` but quick-questions.js was never loaded in index.html. Fixed: removed dependency, hardcoded suggest buttons work fine.

6. **Dead `lastVisitAgo`** — computed but never shown. Removed.

### What's Good (Sep 9 rewrite)
- `getViewportContext()` — reads `canvasRenderer._pins`, bounds-filters to current viewport, builds compact story list (top 6 by sources, top 8 cities, weighted center)
- Active story from popup — 3-layer fallback: `pinMarkers.get(_activePinId)._pinData` → `canvasRenderer._pins.find()` → DOM scrape of `.leaflet-popup-content`
- Language detection — 15 languages (Arabic, Russian, Chinese, Korean, Japanese, Bengali, Hindi, Sinhala, Spanish, French, Portuguese, German, Urdu/Hindi, Bengali, Swahili)
- Memory system — `loadMemory`/`saveMemory` defined OUTSIDE `openHelpMeChat` so `track()` API works
- Personalized greeting — correct priority: lastRecommendation → visitCount → default
- Friendly error messages for rate_limit/timeout/unavailable
- `buildPrompt()` truncates at 7500 chars to stay under API server limit

---

## SESSION NOTES (Sep 23 2026 — Popup Locations Fix)

### Problem
Popup's "Locations" section was showing empty for many articles because:
1. Articles without a `place_name` (city not assigned by worker) had no location shown
2. CityEngine's 150k population threshold excluded smaller cities like Mocha, Yemen (~32k population)
3. `source_country` was not being returned by pins API, so country fallback didn't work

### Fix Applied

**1. `public_html/app.js` — `renderPinCities()` (line ~7936)**
- Now always shows the article's assigned location (`pin.place_name`) as first city chip
- Falls back to CityEngine-detected cities from article text
- Shows "No location detected" message when neither available (instead of empty section)
- Changed label from "Mentioned cities" to "Locations" since it now shows assigned location

**2. `api/src/routes/pins.ts` — query and response**
- Added `source_country` to ranked_articles CTE (from `news_locations.country` or `articles.channel_country`)
- Added `source_country` to final SELECT and payload mapping
- Enables country flag fallback when `place_name` is empty

### Files Changed
```
public_html/app.js          ← renderPinCities() fix
api/src/routes/pins.ts      ← source_country field added
```

### Validation
- `bash scripts/validate-api.sh` — ALL CHECKS PASSED
- `systemctl restart xyzo-api` — done

### Behavior After Fix
Every popup now shows something in Locations:
1. Article's assigned location (if has coordinates) — FIRST
2. CityEngine-detected cities from article body
3. "No location detected" as last resort

---

## Session — 2026-09-26 (daytime): FULL CODEBASE REVIEW + FIX EXECUTION

### What happened
1. Deep review of every subsystem (API/ingestion/NLP-geo/frontend/DB/live state) →
   `docs/CODEBASE_REVIEW_2026-09-26.md` (full report + prioritized roadmap).
2. Master actionable checklist → `docs/FIX_NOTES_2026-09-26.md` (status-logged below).
3. Fixed ~30 confirmed bugs across the stack in-session (checkboxes marked `[x]` in FIX_NOTES):
   - **Workers**: feedparser TZ skew (timegm), web_scraper RobotsVerdict crash, geocode
     `upsert_location` NameError, transient-429 `unlocated` black hole (+attempts cap),
     countrycodes hints for ambiguous names, lease fresh-skip leak, per-source crash
     isolation, gov/university politeness floor on failure, `\m` regex crash,
     `is_qualified()` false qualifiers, disambiguation_gemma SSE parse (was a permanent
     no-op burning an LLM call), cache-before-breaker order + source-aware ai_cache key,
     EVENT_TYPES enum union, entities char-list guard, story_linker dead quality gate,
     nn_batch_links wrong cleanup type + hardcoded model path, city_anomaly_detector
     UnboundLocalError, watchdog thresholds, `fast_update.py` deleted, `nearest["name"]` fix.
   - **API**: shutdown reset/activate real bcrypt auth + complaint rate limit +
     public active-users write closed; SSRF guard `lib/ssrf.ts` on sniff/image-proxy;
     sources/add public-registration hardening; nn/refresh gated; apply-categorization
     rate-limited; pins/map hidden_at + source_type + cache-key light/format +
     malformed-bbox→400 (with longitude wrap); ratelimit Map pruning; metrics arg fix;
     geoip isLocal dedupe; feed NaN clamps; DELETE…LIMIT → ctid; hide/unhide now
     target `pins.article_id` (new column).
   - **Frontend**: popup URL stored-XSS (scheme allowlist + escapeAttr + JSON args),
     reflected XSS via search/explore/discovery sinks, topics-clear listener leak,
     3d filter persistence, duplicate moveend handler, Explore-open silent auto_add,
     `?v=` bumped, prod→dev synced (deploy.sh can no longer revert prod).
   - **DB**: `geocode_attempts` + queue index, `pins.article_id`, 4 dead indexes dropped,
     `xyzo-retention` timer (daily prune), TZ historical backfill + 76 k unlocated reset.

### Live status verified post-fix
- fetch/claim/insert cycles running new code; bun api suite 240 pass (was 227 baseline), zero regressions.

### Open (tracked in FIX_NOTES)
- pins/map spatial indexability, SSE single broadcaster, world_cities FDW→local replica,
  CityStoryScore/location_assignments, schedule compute_* (trending stale), CI typecheck
  gate, secrets rotation, content-hash deploy pipeline, IDOR user-location, cluster races.
