# API BigInt + Route Conflict Post-Mortem

## Date: 2026-09-23
## Severity: High (production breaking — /api/stats returned 500)
## Impact: Frontend dashboard stats panel broken

---

## Symptoms

1. **`/api/stats` returned 500** with `"JSON.stringify cannot serialize BigInt."`
2. **`/api/coolness/top` and `/api/coolness/surging` returned 500** — same BigInt error
3. **`/api/coolness/stats` returned 404** — route not found (route mounting issue)
4. **Frontend console errors** when loading the dashboard

---

## Root Causes

### Bug 1: PostgreSQL BigInt not converted to Number

**Problem:** `COUNT(*)` in PostgreSQL returns `BIGINT`, which JavaScript/JSON cannot serialize.

**Why it manifested:** The original code used `?? 0` to handle nulls:
```js
surging_count: surgingStats[0]?.surging_count ?? 0
```

But `0n ?? 0` evaluates to `0n` (BigInt zero), NOT `0` (Number zero). `JSON.stringify()` cannot serialize BigInt values.

**Same issue with typed queries:** Even with TypeScript types like `sql<Array<{ count: number }>>`, postgres.js returns actual BigInt values from `COUNT(*)`, and the type annotation doesn't coerce the values.

**Same issue with AVG():** `AVG(coolness_score)::numeric(5,1)` returns `numeric`, which postgres.js returns as a JavaScript `number`... BUT `COUNT(*)` always returns BigInt.

**Same issue everywhere:** `COUNT(*)`, `COUNT(DISTINCT ...)`, `MAX()`, `MIN()` without explicit casts return BigInt.

### Bug 2: Hono Route Conflict — coolnessRoute catching /api/stats

**Problem:** `coolnessRoute.get("/stats", ...)` was somehow being matched for `/api/stats` requests instead of `statsRoute.get("/stats", ...)`.

**Discovery method:** Added debug logging to both handlers:
```js
// In coolnessRoute.get("/stats")
console.log("COOLNESS STATS HANDLER HIT!");

// In statsRoute.get("/stats")
console.log("STATS ROUTE HANDLER HIT!");
```

When hitting `/api/stats`, only "COOLNESS STATS HANDLER HIT!" appeared — never the stats route handler.

**Why it happened:** Two routes registered at `/api` with identical `/stats` paths caused Hono to match the wrong one. The fix was to rename `coolnessRoute`'s `/stats` to `/coolness-stats`.

### Bug 3: Route File Not Being Reloaded

**Problem:** After editing `stats.ts`, the running API process didn't pick up changes even after `systemctl restart`.

**Why:** The `systemd` service uses `ExecStartPre` to run validation, which checked the file timestamps. But the actual `bun run src/server.ts` process had the old file cached. The restart detected the old file still had an older timestamp than expected.

**Lesson:** Killing the bun process and restarting via systemd actually works — the issue was that the old process was still running. Always verify with `journalctl` that the new process started AFTER your file edit timestamp.

---

## Files Changed

| File | Change |
|------|--------|
| `api/src/routes/stats.ts` | Use `COUNT(*)::float` cast, `safeNum()` helper, `Math.round()` |
| `api/src/routes/coolness.ts` | Use `::float` casts on all numeric columns, renamed `/stats` → `/coolness-stats` |
| `api/src/server.ts` | (no changes needed — both routes at `/api` was correct) |

---

## The Fix

### stats.ts
```js
// BEFORE (broken)
const [sourceRow] = await sql`SELECT COUNT(*) AS total FROM news_sources...`;
// ...
sources: sourceRow?.total ?? 0  // BigInt!

// AFTER (fixed)
const [sourceRow] = await sql`SELECT COUNT(*)::float AS total FROM news_sources...`;
// ...
sources: Math.round(safeNum(sourceRow?.total))

function safeNum(v) {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  return 0;
}
```

### coolness.ts
```js
// BEFORE (broken)
coolnessRoute.get("/stats", async (c) => {
  const [tierStats] = await sql`SELECT COUNT(*) AS count ...`;
  // COUNT(*) returns BigInt!
  return c.json({ tiers: tierStats, ... });
});

// AFTER (fixed)
coolnessRoute.get("/coolness-stats", async (c) => {
  const [tierStats] = await sql`SELECT COUNT(*)::float AS count ...`;
  // ::float cast ensures Number
  return c.json({ tiers: tierStats, ... });
});
```

---

## Prevention

### 1. API Health Check Script

Created `scripts/api-health-check.js` to catch these issues before deploy:

```bash
# Check endpoints against baseline
bun run scripts/api-health-check.js

# Update baseline when intentionally changing endpoints
bun run scripts/api-health-check.js --update
```

This tests 11 critical endpoints and stores response hashes. If an endpoint's response changes (including BigInt serialization errors), the check fails.

### 2. Always Use ::float or ::numeric Casts

For any SQL that uses `COUNT(*)`, `AVG()`, `MAX()`, `MIN()`, always cast:

```sql
-- Always cast COUNT
SELECT COUNT(*)::float AS total FROM ...

-- For AVG/numeric, cast to float
SELECT AVG(coolness_score)::float AS avg_score FROM ...

-- Or use numeric with explicit handling
SELECT AVG(coolness_score)::numeric(5,1) AS avg_score FROM ...
```

### 3. Route Naming Convention

Avoid duplicate route paths across different route files. If two routes might have the same path (like `/stats`), rename one to be specific (like `/coolness-stats`).

### 4. Verify API Changes After Restart

After editing an API route file and restarting:
1. Check that the process started: `systemctl status xyzo-api`
2. Check the startup time is AFTER your file edit: `journalctl -u xyzo-api --since "1 minute ago"`
3. Test the endpoint immediately: `curl http://localhost:3008/api/your-endpoint`

---

## Related Documents

- `docs/SESSION_NOTES_2026-09-21.md` — Previous session notes
- `scripts/api-health-check.js` — New API health check script
