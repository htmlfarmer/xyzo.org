/**
 * /pins/map query-plan budget — CODEBASE_REVIEW_2026-09-26 BUG-9 / FIX_NOTES §8.1.
 *
 * Historical failure: the geography→geometry cast predicate
 * (`l.geom::geometry && ST_MakeEnvelope(...)`) cannot use the geography-ops
 * GiST indexes → parallel seq scan of 1.1M news_articles, ~0.43s warm and
 * ~1.5s world-view, hammered per pan with no rate limit.
 *
 * Two-phase assertion:
 *   NOW (pre-index-fix): actual execution < BUDGET_MS and result set bounded.
 *   AFTER the spatial fix (geography predicate or (geom::geometry) GiST):
 *   tighten PLAN_SHAPE_MUST_USE_INDEX = true and the plan must show an index
 *   scan — the test itself explains what to change.
 *
 * Read-only EXPLAIN ANALYZE against the PRODUCTION-sized database:
 *   XYZO_PLAN_DB_DSN=postgresql://xyzo_app:...@localhost:5432/xyzo bun test tests/pins-map-explain.test.ts
 * Skipped (not failed) when the env var is absent so the default CI suite
 * doesn't depend on the live DB. Never writes.
 */
import { describe, expect, test } from "bun:test";

const DSN = process.env.XYZO_PLAN_DB_DSN ?? "";
const BUDGET_MS = 1500;           // warm p50 target while the spatial fix is pending (measured 430 ms)
const PLAN_SHAPE_MUST_USE_INDEX = false; // flip true after FIX_NOTES §8.1 index work
// A real dense viewport (Jakarta) — sparse bboxes hide seq-scan costs.
const BBOX = { minLng: 105.0, minLat: -7.2, maxLng: 107.0, maxLat: -5.8 };

// Mirror of the articles leg from api/src/routes/pins.ts buildWhere()/fetchRows()
// (the CTE shape that actually runs per map pan; kept to the spatial filter).
const ARTICLES_SQL = `
  EXPLAIN (ANALYZE, FORMAT JSON)
  SELECT a.id, a.title, a.status, a.event_type, a.published_at, a.fetched_at,
         a.url, a.image_url, a.location_confidence, a.auto_categorize_method,
         a.extracted_lat, a.extracted_lng, a.source_kind,
         COALESCE(NULLIF(a.extracted_lat, 0), l.lat) AS lat,
         COALESCE(NULLIF(a.extracted_lng, 0), l.lng) AS lng,
         l.place_name,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(nes.event_id, a.location_id)
           ORDER BY a.fetched_at DESC
         ) AS loc_rank
  FROM news_articles a
  LEFT JOIN news_locations l ON l.id = a.location_id
  LEFT JOIN news_event_sources nes ON nes.article_id = a.id
  WHERE a.status IN ('extracted', 'discovered')
    AND a.hidden_at IS NULL
    AND ((l.geom::geometry && ST_MakeEnvelope($1, $2, $3, $4, 4326))
         OR (l.id IS NULL AND a.extracted_lat IS NOT NULL AND a.extracted_lat != 0
             AND a.extracted_lng BETWEEN $1 AND $3 AND a.extracted_lat BETWEEN $2 AND $4))
`;

async function queryPlan(): Promise<{ timeMs: number; plan: string }> {
  if (!DSN) return { timeMs: 0, plan: "" };
  const postgres = (await import("postgres")).default;
  const sql = postgres(DSN, { max: 1, connect_timeout: 5, request_timeout: 30_000 });
  try {
    // postgres.js v3: EXPLAIN params via .unsafe; result = [{ "QUERY PLAN": [...] }]
    const res = await sql.unsafe(ARTICLES_SQL, [BBOX.minLng, BBOX.minLat, BBOX.maxLng, BBOX.maxLat]);
    const entry = res?.[0]?.["QUERY PLAN"]?.[0];
    if (!entry) throw new Error("XYZO_PLAN_DB_DSN is set but EXPLAIN returned no plan — check DSN/permissions");
    return {
      timeMs: Number(entry["Execution Time"] ?? entry?.Plan?.["Actual Total Time"] ?? 0),
      plan: JSON.stringify(entry),
    };
  } finally {
    await sql.end({ timeout: 2 });
  }
}

describe("pins/map spatial plan budget", () => {
  test.skipIf(!DSN)("execution time within budget on a dense viewport", async () => {
    if (!DSN) return;
    const got = await queryPlan();
    expect(
      got.timeMs,
      `/pins/map articles leg took ${got.timeMs.toFixed(0)} ms (budget ${BUDGET_MS}). ` +
      "This is the seq-scan / index-drift class of BUG-9 — see FIX_NOTES 8.1.",
    ).toBeLessThan(BUDGET_MS);
  });

  test.skipIf(!DSN || !PLAN_SHAPE_MUST_USE_INDEX)("plan uses a spatial index scan", async () => {
    if (!DSN || !PLAN_SHAPE_MUST_USE_INDEX) return;
    const got = await queryPlan();
    const usesSpatialIndex =
      /gist|GiST|Index Scan/i.test(got.plan) && !/Seq Scan on news_locations/i.test(got.plan);
    expect(
      usesSpatialIndex,
      "spatial predicate is not indexable — apply the geography predicate or the " +
      "(geom::geometry) expression GiST from FIX_NOTES 8.1",
    ).toBe(true);
  });

  test("the mirrored SQL itself keeps the geography cast + hidden_at invariants", () => {
    // Static pin: if someone edits pins.ts away from these predicates, mirror
    // drift here is the tripwire (keep ARTICLES_SQL in sync with pins.ts).
    expect(ARTICLES_SQL).toContain("a.hidden_at IS NULL");
    expect(ARTICLES_SQL).toContain("ST_MakeEnvelope");
    expect(ARTICLES_SQL).toContain("l.geom::geometry"); // mirror — change WITH pins.ts
  });
});
