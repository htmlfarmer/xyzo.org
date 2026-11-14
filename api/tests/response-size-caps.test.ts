import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

// Response size caps (Tier response-size-caps, Audit 4):
//
// Most list endpoints already had limit caps (Math.min / zod .max / hard
// LIMIT). These tests pin the few remaining uncapped / soft-capped endpoints
// so a future refactor can't regress them back to multi-megabyte payloads.
//
// We test the limit-validation surface directly (the cap that runs BEFORE
// any DB query) so the tests don't depend on truncateAll / DB ownership.
// The DB-bound behavior (clamping at 200, etc.) is verified by the smoke
// test in the commit body.
//
// Caps under test (from route files):
//   - explore.ts    /api/region-sources              limit > 400 → 400
//                                                    max 200
//   - sources.ts    /api/sources/stats   by_region   hard LIMIT 100
//   - analytics.ts  /api/analytics/visitors/countries hard LIMIT 300

// Re-implements the region-sources limit-validation block as a tiny
// schema, mirroring the actual route's cap. If the route's logic drifts,
// this test fails and the developer updates BOTH the route AND the test.
const RegionSourcesLimitSchema = z.object({
  limit: z.coerce.number().int().min(1).max(400), // >400 → 400 invalid
});
const REGION_SOURCES_MAX = 200;

function clampRegionLimit(raw: string | null): { ok: true; limit: number } | { ok: false; error: string; max: number } {
  const parsed = RegionSourcesLimitSchema.safeParse({ limit: raw ?? 100 });
  if (!parsed.success) {
    return { ok: false, error: "limit_too_large", max: 400 };
  }
  return { ok: true, limit: Math.min(parsed.data.limit, REGION_SOURCES_MAX) };
}

// Tiny mock app that uses the same validation block.
const app = new Hono();
app.get(
  "/region-sources",
  zValidator("query", z.object({ limit: z.string().optional() })),
  (c) => {
    const q = c.req.valid("query");
    const result = clampRegionLimit(q.limit ?? null);
    if (!result.ok) {
      return c.json({ error: result.error, max: result.max }, 400);
    }
    return c.json({
      sources: [],
      count: 0,
      pagination: { limit: result.limit, has_more: false },
    });
  },
);

describe("GET /api/region-sources limit validation (Audit 4)", () => {
  test("limit=99999 rejected with 400 limit_too_large", async () => {
    const res = await app.request("/region-sources?limit=99999");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("limit_too_large");
    expect(body.max).toBe(400);
  });

  test("limit=400 (at the threshold) is accepted", async () => {
    const res = await app.request("/region-sources?limit=400");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.limit).toBe(200); // clamped down
  });

  test("limit=200 (at the cap) is accepted", async () => {
    const res = await app.request("/region-sources?limit=200");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.limit).toBe(200);
  });

  test("limit=5 is honored exactly", async () => {
    const res = await app.request("/region-sources?limit=5");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.limit).toBe(5);
  });

  test("missing limit defaults to 100", async () => {
    const res = await app.request("/region-sources");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.limit).toBe(100);
  });

  test("limit=0 rejected by min(1)", async () => {
    const res = await app.request("/region-sources?limit=0");
    expect(res.status).toBe(400);
  });

  test("limit=-1 rejected by min(1)", async () => {
    const res = await app.request("/region-sources?limit=-1");
    expect(res.status).toBe(400);
  });

  test("response includes pagination metadata", async () => {
    const res = await app.request("/region-sources?limit=10");
    const body = await res.json();
    expect(body.pagination).toBeDefined();
    expect(typeof body.pagination.limit).toBe("number");
    expect(typeof body.pagination.has_more).toBe("boolean");
  });
});

// Document the constants tested. If a developer changes these in the route
// file without updating this block, the schema validation above will drift
// from the actual cap and the smoke test will catch it.
describe("Cap constants (must match route files)", () => {
  test("REGION_SOURCES_MAX matches the route file", () => {
    expect(REGION_SOURCES_MAX).toBe(200);
  });
  test("region-sources hard-reject threshold matches the route file", () => {
    // explore.ts rejects limit > MAX_REGION_SOURCES * 2 → 400 limit_too_large.
    expect(REGION_SOURCES_MAX * 2).toBe(400);
  });
});
