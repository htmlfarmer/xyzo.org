# Handoff Notes — 2026-09-07 — HIVV.org public UI + xyzo worker routing

## What's live and verified

### hivv.org public surface
- **`https://hivv.org/`** (index.html, 19,674 B) — gateway marketing + working HIVV REQUEST chat with SSE streaming. End-to-end verified: `curl -N POST /v1/chat/completions` returns real `data: {...}` chunks.
- **`https://hivv.org/status.html`** (status.html, 16,276 B) — live command center: gateway banner with heartbeat (3s), 6 stat tiles, live request stream (4s, freshly-flashed rows), local backends list, models-in-rotation grid. All four `/api/public/*` endpoints wired.
- **`/css/shared.css`** — design system (CSS variables, layout, nav). Both pages depend on it; don't break the variable names (`--accent`, `--accent-2`, `--accent-3`, `--warn`, `--red`, `--bg-card`, `--border`, `--text`, `--text-muted`, `--text-dim`).

### xyzo.org workers — primary/fallback routing
- **`worker/ai_config.json`** — `primary_base_url: http://localhost:3011` (hivv.org), `fallback_base_url: http://192.168.1.3:8888` (direct local Gemma).
- **`worker/ai_client.py`** — `AIClient` now does primary-first, fallback-on-(502/503/504/timeout/connect), 30s cooldown to prevent hammering dead hivv.org, breaker tracks failures, WARN log fires on fallback. Streaming path forces `stream=False` on fallback (llama.cpp returns 500 on streaming) and re-emits as a single chunk + `[DONE]`. Module-level `ai_chat()` and `ai_chat_stream()` exported.

### xyzo.org user-facing chat — primary/fallback routing
- **`api/src/routes/ai-chat.ts`** — was hitting `XYZO_AI_URL ?? http://192.168.1.3:8888/chat/stream` (direct local) with the llama.cpp streaming shape `{message, stream}`. Rewritten to:
  - Read `XYZO_AI_PRIMARY_URL` (default `http://localhost:3011/v1/chat/completions`) and `XYZO_AI_FALLBACK_URL` (default `http://192.168.1.3:8888/v1/chat/completions`).
  - Send OpenAI-compatible `{model, messages: [{role: 'user', content}]}` with `stream: false`, JSON in / JSON out.
  - Use `withBreaker("ai-chat:primary", …)` from `api/src/ai-breaker.ts`; the breaker tracks primary health and short-circuits to fallback for 120s after 3 failures in 60s.
  - **Bun-specific bug fixed**: connection failures throw a plain `Error` with `code: "ConnectionRefused"` (not `TypeError` like Node), so `isFallbackWorthy` now matches on `code`, message string, and `upstream_(502|503|504)` patterns.
  - WARN log fires on primary failure (and on breaker open).
  - Returns `{response, via: "primary"|"fallback", latency_ms}` so operators can see which path served each request.

### hivv.org backend (already in place)
- **`api/server.js`** — exposes 4 public, no-auth endpoints behind Redis-style cache (or in-memory fallback):
  - `GET /api/public/status` (15s cache) — gateway version, uptime, providers_active, local_backends[], totals{users, keys, open_problems, visitors}, today{requests, tokens}, last_hour{requests, tokens}, recent[]
  - `GET /api/public/heartbeat` (no cache) — `{ts, local_backends_online}`
  - `GET /api/public/activity` (10s cache) — last 20 anon entries with `model, provider, latency_ms, tokens, status, ts`
  - `GET /api/public/models` (60s cache) — provider catalog with `name, kind` per model
- **`api/lib/router.js`** — `loadConfig()` robust to pg returning JSONB as parsed JS (not always a string); `discoverLocalEndpoints()` dedupes URLs.
- **`api/lib/routes/hivv-routes.js`** — fixed circular dep via `serverModule()` lazy require.
- **`api/lib/rate-limiter.js`** — fixed `dayAgo` mutation bug.
- **`api/lib/usage-tracker.js`** — whitelist + bound params for `date_trunc`/`INTERVAL`.
- **`api/lib/routes/dashboard-routes.js`** — was breaking hivv boot with `MODULE_NOT_FOUND: '../server'` (wrong relative path) and `MODULE_NOT_FOUND: 'express-validator'` (missing dep). Fixed: (1) `npm install express-validator` to satisfy the require, and (2) replaced eager `const { pool } = require('../server')` with a `Proxy` that lazily resolves `pool` on first property access — this dodges the circular-dep timing issue where server.js loads dashboard-routes.js at line 1988 while still mid-evaluation (so eager require returns an empty `module.exports`).
- **`api/package.json`** — added `express-validator` to dependencies.

## Restart after edits
```
pm2 restart hivv-ai-gateway              # hivv.org gateway (Node)
sudo systemctl restart xyzo-api           # xyzo.org API (Bun)
pm2 stop hivv-ai-gateway && pm2 start     # simulate primary-down for fallback tests
```

## End-to-end fallback test (verified 2026-09-07)
```
# Step 1: fresh breaker, hivv UP → xyzo responds via=primary (~300ms)
curl -sS -X POST https://xyzo.org/api/ai/chat -H "Content-Type: application/json" \
  -d '{"message":"2+2?"}' | jq -c .
# {"response":"2 + 2 equals 4.","via":"primary","latency_ms":336}

# Step 2: stop hivv → xyzo falls back to direct local via=fallback
pm2 stop hivv-ai-gateway && sleep 2
curl -sS -X POST https://xyzo.org/api/ai/chat -H "Content-Type: application/json" \
  -d '{"message":"3+4?"}' | jq -c .
# {"response":"7","via":"fallback","latency_ms":1355}

# Step 3: restart hivv → xyzo returns to via=primary
pm2 start hivv-ai-gateway && sleep 4
curl -sS -X POST https://xyzo.org/api/ai/chat -H "Content-Type: application/json" \
  -d '{"message":"7+8?"}' | jq -c .
# {"response":"7 + 8 equals 15.","via":"primary","latency_ms":350}
```

**Gotcha:** the breaker (`api/src/ai-breaker.ts`) is process-local and stays open 120s after 3 failures in 60s. To clear it between tests, `sudo systemctl restart xyzo-api`. Otherwise step 1 may falsely report `via: fallback` even when primary is up.

## What I deliberately did NOT do (open work for next AI)
1. **`hivv_fallback_events` table** — WARN logs persist in PM2 logs today. To persist: schema sketch in task #19 description, hook point is the two `log.warning(...)` blocks in `ai_client.py` after fallback fires.
2. **Operator dashboard polish** — `status.html` is the baseline. Polish items: request-rate chart (need ~24h history first), error-rate sparkline, CSV export, per-model latency breakdown, keyboard shortcuts.
3. **`index.html` and `status.html` consistency** — both use identical nav structure. If you add a new top-level page, add the link to both `<nav class="site-nav">` blocks and flip the `class="active"` to the right page.
4. **The 23 untracked src/ files in xyzo.org/api/src/** (`ai-breaker.ts`, `cache.ts`, `metrics.ts`, `routes/*.ts`, `types-nn.ts`, `wiki.ts`) — these were staged before my session but never wired into the running gateway. They're the TS mirror the docstring of `ai_client.py` refers to. Out of scope for "make UI + streaming work" but worth a triage pass.

## Architecture invariants to preserve
- **Three gates × three layers** — don't bypass the rate-limiter/usage-tracker/breaker chain.
- **Public endpoints cache aggressively** — 3–60s TTLs are intentional; don't drop them in the name of freshness or you'll melt the DB.
- **Privacy on `/api/public/activity`** — never leak prompts, IPs, or user IDs. Only model, latency, tokens, status, ts.
- **Fallback WARN is a feature** — operators need to see when the primary degrades. Don't suppress the log.
- **Tier-aware politeness** (per memory `government-site-politeness.md`) — applies to xyzo.org's source-polling gates, not hivv.org AI gateway. Don't conflate the two.

## Smoke tests the next AI should run before declaring anything broken
```
curl -N -X POST https://hivv.org/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma-3-27b","messages":[{"role":"user","content":"hi"}],"stream":true,"max_tokens":12}'
curl https://hivv.org/api/public/status | python3 -m json.tool | head -20
curl -o /dev/null -w "%{http_code}\n" https://hivv.org/index.html https://hivv.org/status.html
```
