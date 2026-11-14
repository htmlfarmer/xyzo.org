# XYZO Handoff — Active Issues for Next AI

**Date:** 2026-09-09
**Status:** Several frontend issues need attention

---

## Issue 1: Help Me Chat Location Detection (CRITICAL)

**Problem:** When user is zoomed into a region (e.g., Australia at `#-27.2546,129.9902,5`), the Help Me chat still said "You are currently located in Moscow, Russia" instead of detecting the actual map view location.

**Root Cause:** Two issues:
1. `getUserLocation()` prioritized cached `localStorage("newsium.home")` over the current map center
2. The map center might be in an empty area (e.g., Australian outback) — the real content is in cities

**What I Fixed:**
1. `getUserLocation()` now prefers map center when zoom >= 5 or when map center is >500km from cached home
2. `getViewportContext()` now calculates **story center** (source_count-weighted average of visible pins) instead of geometric map center
3. Added `topRegion` extraction from `place_name` fields (e.g., "AU" from "Alice Springs, AU")
4. Viewport context now shows: `Stories near: -25.2,133.8 (AU) — 45 stories`

**Verified:** AI now correctly identifies "Alice Springs, Australia" when zoomed into central Australia.

**Files:**
- `public_html/index.html:590-664` — `getUserLocation()` function
- `public_html/help-me-chat.js:306-380` — `getViewportContext()` with storyCenter + topRegion
- `public_html/help-me-chat.js:141-145` — `userLocationContext` variable

---

## Issue 2: Help Me Chat Prompt Size / Context Window

**Problem:** The Help Me chat prompt was exceeding the 5000 char Zod validation limit, causing `[object Object]` errors.

**What I Fixed:**
- Increased server limit from 5000 to 8000 in `api/src/routes/ai-chat.ts:32`
- Compact system prompt (1500→400 chars)
- Compact active story context (400→200 chars)
- Compact viewport context (2000→800 chars) — 6 stories, domain-only URLs
- Compact user memory (500→150 chars)
- Added frontend truncation safety at 7500 chars
- Added friendly error messages for rate limits, timeouts, AI down

**What Still Needs Work:**
- Server needs restart to pick up 8000 limit (currently running with old 5000)
- Test various context window sizes during low traffic tonight
- The `fullSystemPrompt` variable concatenation at `help-me-chat.js:230` should be reviewed

**Files:**
- `api/src/routes/ai-chat.ts:32` — Zod schema max
- `public_html/help-me-chat.js:25-40` — System prompt
- `public_html/help-me-chat.js:230` — `fullSystemPrompt` assembly
- `public_html/help-me-chat.js:363-382` — `buildPrompt()` with truncation

---

## Issue 3: `[object Object]` Error Display

**Problem:** API errors were showing as `⚠️ [object Object]:` instead of readable messages.

**What I Fixed:**
- ZodError handling: extracts friendly message from `error.issues[0].message`
- Object error stringification: `JSON.stringify()` for non-string errors
- Rate limit friendly messages: "We're getting a lot of questions right now!"
- Timeout friendly messages: "The AI is thinking hard but took too long"
- AI down friendly messages: "Our AI is taking a quick break"
- Server-side logging for rate limits, timeouts, AI errors

**Files:**
- `public_html/help-me-chat.js:484-510` — Error handling in `!res.ok` path
- `public_html/help-me-chat.js:536-550` — Error handling in catch block
- `api/src/routes/ai-chat.ts:140-171` — Server-side logging

---

## Issue 4: word_freq in API Response

**Problem:** `/api/pins/map` returned `word_freq: null` for all pins despite 177K articles having word_freq data.

**Root Cause:** `pins.ts:472` had `word_freq: null` hardcoded instead of `r.word_freq || null`.

**Status:** FIXED — Changed to `word_freq: r.word_freq || null`

**File:** `api/src/routes/pins.ts:472`

---

## Issue 5: Hub, PK False Positives

**Problem:** 15 stories incorrectly geolocated to "Hub, Pakistan" — articles about "USB4 Hub", "cyber-scam hub", etc.

**What I Fixed:**
- Added `hub`, `hubs`, `center`, `station`, `port`, etc. to `SKIP_WORDS` in `worker/cities_text.py:193`
- Matching client-side update in `public_html/city-engine.js:169`
- Added disambiguation check to `_source_fallback()` in `worker/auto_categorize.py:375-397`

**Status:** FIXED — verified with tests

**Files:**
- `worker/cities_text.py:169-194` — SKIP_WORDS
- `public_html/city-engine.js:145-170` — Client SKIP_WORDS
- `worker/auto_categorize.py:375-397` — Source fallback disambiguation

---

## Issue 6: Popup Context in Help Me Chat

**Problem:** When a popup is open and user clicks Help Me, the popup data (title, URL, location) should be injected into the AI context.

**What I Fixed:**
- Added DOM fallback reading from popup element (title, URL, city, category, keywords)
- Enhanced active story context to include URL prominently
- AI now instructed to always include URL when referencing stories

**Status:** FIXED — verified with tests

**Files:**
- `public_html/index.html:672-710` — Popup data extraction
- `public_html/help-me-chat.js:233-240` — Active story context

---

## Issue 7: AI Not Suggesting Specific URLs

**Problem:** AI gave generic answers without linking to specific stories.

**What I Fixed:**
- System prompt now includes "When suggesting a story, include its URL"
- Viewport context now includes domain for each story
- Active story context includes full URL

**Status:** FIXED — verified with tests

**Files:**
- `public_html/help-me-chat.js:25-40` — System prompt
- `public_html/help-me-chat.js:366-372` — Story list with domains

---

## Testing Checklist

```bash
# Run all tests
cd /var/www/vhosts/xyzo.org
bun test public_html/tests/syntax-validation.bun.test.js
python3 -m pytest worker/tests/test_place_disambiguation.py -x -q

# Test API
curl http://localhost:3008/api/health | jq
curl -s 'http://localhost:3008/api/pins/map?bbox=-10,30,15,55&limit=3' | python3 -m json.tool | head -20

# Test Help Me chat
curl -s -X POST 'http://localhost:3008/api/ai/chat' \
  -H 'Content-Type: application/json' \
  -d '{"message": "test", "stream": false}'
```

---

## Issue 8: MCP Tool Filtering (Security)

**Problem:** All 33 MCP tools (system health, processes, services, networking, memory) were exposed to user-facing AI via the bridge at 192.168.1.3:8888. A user could prompt the AI to read system files, restart services, scan ports, etc.

**What I Fixed:**
1. Added `X-MCP-Safe` header support to `bridge.py` — when `X-MCP-Safe: true` is sent, only web/wiki/wikidata tools are available
2. Updated all xyzo.org API routes to send the header (`command.ts`, `ai-flag.ts`, `geocode.ts`)
3. Updated all worker files to send the header (8 files)
4. Updated `ai_config.json` with `extra_headers` config
5. Updated `ai_client.py` to use `extra_headers` from config

**Verified:**
- Without header: AI can call `system_status`, returns uptime/memory ✅
- With `X-MCP-Safe: true`: AI says "I do not have access to system status" ✅
- With `X-MCP-Safe: true`: web search still works ✅

**Safe tools:** `web_search`, `fetch_url`, `search_and_fetch_*`, `wikipedia_*`, `wikidata_*`
**Blocked tools:** `system_*`, `service_*`, `restart_*`, `process_*`, `ping_*`, `traceroute_*`, `dns_*`, `network_*`, `listening_*`, `port_*`, `disk_*`, `remember`, `recall`, `search_memories`, `forget`

**Files:** `/home/asher/mcp/bridge.py`, `worker/ai_config.json`, `worker/ai_client.py`, all API routes + worker files

---

## Key Architecture Notes

- **API:** Bun + Hono on port 3008
- **Database:** PostgreSQL 15 + PostGIS + pgvector at `postgresql://xyzo_app:CHANGE_ME@localhost:5432/xyzo`
- **Frontend:** Vanilla JS in `public_html/app.js` (~14K LOC), no build step
- **AI:** Gemma-3-27b via hivv.org primary, local fallback
- **Worker:** Python 3.11 with PyTorch + sentence-transformers
- **Maps:** 8 free base layers (OSM, ESRI, etc.) + 5 NASA overlays

---

## What NOT to Break

- `public_html/app.js` — massive file, edit carefully
- `api/src/routes/pins.ts` — complex SQL CTEs, don't touch lightly
- `worker/auto_categorize.py` — 1100+ lines, has 5-layer geolocation pipeline
- `worker/place_disambiguation.py` — 35+ watchlisted names with regex patterns
