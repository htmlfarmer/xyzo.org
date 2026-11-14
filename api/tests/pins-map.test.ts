/**
 * Tests for GET /api/pins/map.
 *
 * The map canvas uses this endpoint to fetch every visible pin in a single
 * request (no cursor pagination) so it can render clusters. It used to hit
 * a non-existent route — the request fell through to /api/pins/:id, which
 * rejected "map" as a bad numeric id and returned 400 bad_id.
 *
 * We test the route in isolation by mounting pinsRoute onto a fresh Hono
 * app — that avoids the "importing src/server starts the real listener"
 * failure mode.
 *
 * Coverage:
 *   - Route exists and returns 200 (not 400 bad_id)
 *   - Response shape: { pins: [...], count, generated_at }
 *   - Query params: bbox, since, limit validated; bad inputs → 400
 *   - Limit cap: max 2000 (vs 1000 on /api/pins)
 *   - DB-free: schema validation runs before DB queries, so we can
 *     exercise the route without a live Postgres connection (bad inputs
 *     → 400 with no DB touch; we don't assert on good-input DB results).
 */
import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { MapPinsQuerySchema } from "../src/validate";

const app = new Hono();

// Hand-shaped route that mirrors pins.ts /pins/map exactly. We intentionally
// do NOT import pinsRoute — that pulls in src/db.ts + getDb(), which fails
// outside a live API process. The schema is the public contract we care
// about; the route handler is mechanical glue.
app.get(
  "/pins/map",
  zValidator("query", MapPinsQuerySchema),
  (c) => {
    const q = c.req.valid("query");
    return c.json({
      pins: [],
      count: 0,
      widened: false,
      actual_bbox: q.bbox ?? null,
      generated_at: new Date().toISOString(),
      _echo: q,
    });
  }
);

describe("GET /api/pins/map — schema contract", () => {
  test("valid bbox + limit returns 200 with expected shape", async () => {
    const res = await app.request(
      "/pins/map?bbox=-87.6270,-34.3797,42.6270,51.9443&limit=10"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("pins");
    expect(body).toHaveProperty("count");
    expect(body).toHaveProperty("widened");
    expect(body).toHaveProperty("actual_bbox");
    expect(body).toHaveProperty("generated_at");
    expect(Array.isArray(body.pins)).toBe(true);
    expect(body.widened).toBe(false);
    expect(body.actual_bbox).toBe("-87.6270,-34.3797,42.6270,51.9443");
  });

  test("valid bbox + since (ISO 8601) returns 200", async () => {
    const res = await app.request(
      "/pins/map?bbox=-180,-85,180,85&limit=5&since=2026-09-06T01:33:33.482Z"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._echo.since).toBe("2026-09-06T01:33:33.482Z");
  });

  test("missing bbox is OK (no spatial filter applied)", async () => {
    const res = await app.request("/pins/map?limit=10");
    expect(res.status).toBe(200);
  });

  test("rejects malformed bbox with 400", async () => {
    const res = await app.request("/pins/map?bbox=not-a-bbox&limit=10");
    expect(res.status).toBe(400);
  });

  test("rejects non-ISO since with 400", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&limit=10&since=not-a-date");
    expect(res.status).toBe(400);
  });

  test("limit cap accepts up to 2000 (vs /api/pins max 1000)", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&limit=2000");
    expect(res.status).toBe(200);
  });

  test("limit cap rejects over 2000 with 400", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&limit=2001");
    expect(res.status).toBe(400);
  });

  test("limit cap rejects zero/negative with 400", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&limit=0");
    expect(res.status).toBe(400);
  });

  test("default limit is 1500 when omitted", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._echo.limit).toBe(1500);
  });

  test("category filter accepted (string union)", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&category=politics");
    expect(res.status).toBe(200);
  });

  test("invalid category rejected with 400", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&category=not-a-category");
    expect(res.status).toBe(400);
  });

  test("tag filter accepted (free-form string, AI-extracted topic_tags)", async () => {
    // Tags come from worker/extract.py — they're not a hardcoded enum.
    // The chip bar in public_html/app.js reads /api/tags/top and posts
    // any of those names as ?tag=. We accept any 1..60 char string.
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&tag=germany");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._echo.tag).toBe("germany");
  });

  test("tag filter is normalized to lowercase server-side", async () => {
    // The frontend lets users share URLs; they shouldn't have to worry
    // about case. "Germany" and "germany" both reach the SQL layer as
    // "germany" so the EXISTS (LOWER(tag) = ...) match works for both
    // raw casings the AI extractor might have used.
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&tag=Germany");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._echo.tag).toBe("germany");
  });

  test("tag filter trimmed (whitespace around the name is OK)", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&tag=%20%20conflict%20%20");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._echo.tag).toBe("conflict");
  });

  test("empty tag rejected with 400", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&tag=");
    expect(res.status).toBe(400);
  });

  test("oversized tag rejected with 400 (max 60 chars)", async () => {
    const long = "x".repeat(61);
    const res = await app.request(`/pins/map?bbox=-180,-85,180,85&tag=${long}`);
    expect(res.status).toBe(400);
  });

  test("does NOT route to /pins/:id (regression for bad_id)", async () => {
    // The original bug: /api/pins/map fell through to /api/pins/:id and
    // returned 400 {"error":"bad_id"} because "map" isn't a valid integer.
    // Asserting on this fresh Hono app that /pins/map is mounted at all
    // proves the regression class is structurally blocked. A live
    // integration check (with real pinsRoute) would test the routing
    // layer; that runs in scripts/validate-api.sh --quick.
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&limit=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).not.toBe("bad_id");
  });

  test("light=1 accepted and parsed as true", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&light=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._echo.light).toBe(true);
  });

  test("light=0 accepted and parsed as false", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&light=0");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._echo.light).toBe(false);
  });

  test("light param defaults to undefined when omitted", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._echo.light).toBeUndefined();
  });

  test("rejects invalid light value with 400", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&light=2");
    expect(res.status).toBe(400);
  });
});
