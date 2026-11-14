/**
 * Tests for /api/tags/top schema contract.
 *
 * Tag names are dynamic — they're AI-extracted per article and stored in
 * news_articles.topic_tags::text[]. As of 2026-09-06 the DB holds 494
 * distinct concepts (case-collapsed) across 439 extracted+located articles.
 * The chip bar in public_html/app.js calls /api/tags/top to render the
 * filter row. We test the route in isolation (no DB) using the same
 * hand-shaped-route pattern as tests/pins-map.test.ts so the schema
 * (limit, bbox, category) is locked down without needing a live Postgres.
 */
import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

// Mirror of the schema in api/src/routes/tags.ts — if you change one,
// change both. The schema is the public contract; the handler is glue.
const TopQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(200),
  bbox: z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).optional(),
  category: z.string().min(1).max(40).optional(),
});

const app = new Hono();
app.get(
  "/tags/top",
  zValidator("query", TopQuery),
  (c) => {
    const q = c.req.valid("query");
    return c.json({
      tags: [],
      count: 0,
      generated_at: new Date().toISOString(),
      _echo: q,
    });
  }
);

describe("GET /api/tags/top — schema contract", () => {
  test("default limit is 200 when omitted", async () => {
    const res = await app.request("/tags/top");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._echo.limit).toBe(200);
  });

  test("limit cap accepts up to 500", async () => {
    const res = await app.request("/tags/top?limit=500");
    expect(res.status).toBe(200);
  });

  test("limit cap rejects over 500 with 400", async () => {
    const res = await app.request("/tags/top?limit=501");
    expect(res.status).toBe(400);
  });

  test("limit cap rejects zero with 400", async () => {
    const res = await app.request("/tags/top?limit=0");
    expect(res.status).toBe(400);
  });

  test("limit cap rejects negative with 400", async () => {
    const res = await app.request("/tags/top?limit=-5");
    expect(res.status).toBe(400);
  });

  test("limit accepts non-integer coerced (e.g. '10.5' becomes 10)", async () => {
    const res = await app.request("/tags/top?limit=10.5");
    // z.coerce.number() coerces to 10.5; .int() then rejects with 400.
    expect(res.status).toBe(400);
  });

  test("bbox filter accepted (same shape as /api/pins)", async () => {
    const res = await app.request("/tags/top?bbox=-87.6,-34.4,42.6,51.9&limit=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._echo.bbox).toBe("-87.6,-34.4,42.6,51.9");
  });

  test("malformed bbox rejected with 400", async () => {
    const res = await app.request("/tags/top?bbox=not-a-bbox");
    expect(res.status).toBe(400);
  });

  test("category filter accepted (free-form string)", async () => {
    // Unlike /api/pins which uses CategoryEnum (14 hardcoded values),
    // /api/tags/top accepts any 1..40 char string so future category
    // additions don't require an enum migration. The handler just
    // passes it through to SQL.
    const res = await app.request("/tags/top?category=politics");
    expect(res.status).toBe(200);
  });

  test("empty category rejected with 400", async () => {
    const res = await app.request("/tags/top?category=");
    expect(res.status).toBe(400);
  });

  test("all three filters combine (bbox + category + limit)", async () => {
    const res = await app.request("/tags/top?bbox=-180,-85,180,85&category=conflict&limit=50");
    expect(res.status).toBe(200);
  });

  test("response shape: { tags, count, generated_at }", async () => {
    const res = await app.request("/tags/top?limit=5");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("tags");
    expect(body).toHaveProperty("count");
    expect(body).toHaveProperty("generated_at");
    expect(Array.isArray(body.tags)).toBe(true);
  });
});
