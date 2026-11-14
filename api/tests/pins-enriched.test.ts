// Tests for GET /api/pins/:id/enriched — combined popup data endpoint.
//
// Verifies that the enriched endpoint returns all popup data in a single
// response (pin details, words, links, reports, categorization) instead
// of requiring 5-6 separate API calls.

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { pinsRoute } from "../src/routes/pins";
import { truncateAll, closeDb } from "./helpers";
import { pinsCache } from "../src/cache";
import { getDb } from "../src/db";

async function seedArticle(overrides: Record<string, unknown> = {}): Promise<number> {
  const sql = getDb();
  const [loc] = await sql<{ id: number }[]>`
    INSERT INTO news_locations (place_name, place_name_normalized, country, lat, lng, precision, confidence, geom)
    VALUES ('Test City', 'test city', 'TC', 40.0, 10.0, 'city', 1.0,
            ST_SetSRID(ST_MakePoint(10.0, 40.0), 4326)::geography)
    RETURNING id
  `;
  const [art] = await sql<{ id: number }[]>`
    INSERT INTO news_articles (
      title, summary, url, source_id, status, location_id,
      event_type, word_freq, extracted_at
    ) VALUES (
      'Test Article', 'A test summary', 'https://example.com/test',
      NULL, 'extracted', ${loc.id},
      'politics', '{"test": 5, "news": 3}'::jsonb, now()
    )
    RETURNING id
  `;
  return Number(art.id);
}

async function seedPin(): Promise<number> {
  const sql = getDb();
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO pins (source_type, title, location, published_at, created_at, category)
    VALUES ('editorial', 'Test Pin', ST_SetSRID(ST_MakePoint(10.0, 40.0), 4326)::geography, now(), now(), 'politics')
    RETURNING id
  `;
  return Number(row.id);
}

describe("GET /api/pins/:id/enriched", () => {
  beforeEach(async () => {
    await truncateAll();
    pinsCache.clear();
  });

  afterAll(async () => { await closeDb(); });

  test("returns 404 for nonexistent pin", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins/99999/enriched");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  test("returns 400 for invalid id", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins/abc/enriched");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_id");
  });

  test("returns enriched data with all fields", async () => {
    const pinId = await seedPin();
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request(`/api/pins/${pinId}/enriched`);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Pin details
    expect(body.pin).toBeDefined();
    expect(body.pin.id).toBe(pinId);
    expect(body.pin.title).toBe("Test Pin");
    expect(body.pin.location).toBeDefined();
    expect(body.pin.location.lat).toBeCloseTo(40.0, 1);
    expect(body.pin.location.lng).toBeCloseTo(10.0, 1);

    // Words, links, reports, categorization should all be present
    expect(body.words).toBeDefined();
    expect(body.links).toBeDefined();
    expect(body.reports).toBeDefined();
    expect(Array.isArray(body.links)).toBe(true);
    expect(Array.isArray(body.reports)).toBe(true);
  });

  test("returns word frequency for articles", async () => {
    const articleId = await seedArticle();
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request(`/api/pins/${articleId}/enriched`);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Should have word_freq from the article
    expect(body.words).toBeDefined();
    expect(body.words.test).toBe(5);
    expect(body.words.news).toBe(3);
  });
});
