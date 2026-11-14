/**
 * /pins/map LIVE contract — CODEBASE_REVIEW_2026-09-26 BUG-9 (+ perf DoS class).
 *
 * Pins the fixes already shipped in the working tree AND the invariants the
 * map view must never regress:
 *   1. hidden_at IS NULL on the articles leg (moderation bypass)
 *   2. malformed/NaN bbox → 400 loud, never a silent world-scan
 *   3. source_type filters the ARTICLES leg correctly (was inverted: any
 *      source_type emptied pins and returned ALL articles)
 *   4. cache keys are shape-isolated (light vs full vs format) — the same
 *      bbox must never serve a truncated payload to a full client
 *   5. count/serialization BigInt-safe at zero results
 *
 * Runs against the ISOLATED xyzo_test DB (bun --env-file=.env.test); the
 * helpers.ts guard refuses to run anywhere else.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Hono } from "hono";
import { pinsRoute } from "../src/routes/pins";
import { truncateAll } from "./helpers";
import { pinsCache } from "../src/cache";
import { getDb } from "../src/db";

const sql = getDb();
const app = new Hono();
app.route("/api", pinsRoute);

// Jakarta-ish bbox with seeded data
const BBOX = "106.7,-6.3,106.9,-6.1";
const SEA = "140.0,-10.0,140.1,-9.9";

async function seed() {
  const [src] = await sql<{ id: number }[]>`
    INSERT INTO news_sources (name, feed_url, source_type, country, active)
    VALUES ('ZZ Map Contract Test', 'https://mapcontract.test.invalid/feed', 'rss', 'ID', TRUE)
    RETURNING id
  `;
  const sid = Number(src.id);

  const mk = async (title: string, hidden: boolean) => {
    await sql`
      INSERT INTO news_articles (title, url, source_id, status, hidden_at,
                                 extracted_lat, extracted_lng, fetched_at, published_at, event_type)
      VALUES (${title}, ${"https://mapcontract.test.invalid/" + title.replace(/\s/g, "-")},
              ${sid}, 'extracted', ${hidden ? new Date() : null},
              -6.2, 106.8, now(), now(), 'general')
    `;
  };
  await mk("Visible Story", false);
  await mk("Hidden Story", true);
  pinsCache.clear();
  return sid;
}

async function cleanupSource(sid: number) {
  await sql`DELETE FROM news_articles WHERE source_id = ${sid}`;
  await sql`DELETE FROM news_sources WHERE id = ${sid}`;
  pinsCache.clear();
}

describe("GET /api/pins/map live contract", () => {
  beforeEach(async () => {
    await truncateAll();
    pinsCache.clear();
  }, 30_000);

  test("visible article renders; hidden_at article does NOT (moderation bypass)", async () => {
    const sid = await seed();
    try {
      const res = await app.request(`/api/pins/map?bbox=${BBOX}&limit=50`);
      expect(res.status).toBe(200);
      const body = await res.json();
      const titles = (body.pins || []).map((p: any) => p.title);
      expect(titles).toContain("Visible Story");
      expect(
        titles,
        "hidden_at article leaked to the default map view (BUG-9 moderation bypass)",
      ).not.toContain("Hidden Story");
    } finally {
      await cleanupSource(sid);
    }
  }, 30_000);

  test("malformed bbox is a loud 400, not a silent world-scan", async () => {
    for (const bad of ["abc", "1,2,3", "106.8,-6.2", "0,200,1,1"]) {
      const res = await app.request(`/api/pins/map?bbox=${bad}&limit=5`);
      expect(res.status, `bbox=${bad} must 400 (was: silent full-world scan)`).toBe(400);
      const body = await res.json().catch(() => ({} as any));
      expect(body).toBeObject(); // zod rejects with a structured payload, never a hang/200
    }
  }, 30_000);

  test("NaN limit must not 500", async () => {
    const res = await app.request(`/api/pins/map?bbox=${SEA}&limit=abc`);
    expect(res.status).not.toBe(500);
  }, 30_000);

  test("empty bbox → JSON-safe 200 with numeric count", async () => {
    const res = await app.request(`/api/pins/map?bbox=${SEA}&limit=5`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.count).toBe("number");
    expect(() => JSON.stringify(body)).not.toThrow();
  }, 30_000);

  test("source_type=rss keeps articles; non-rss type excludes the articles leg", async () => {
    const sid = await seed();
    try {
      const rssRes = await app.request(`/api/pins/map?bbox=${BBOX}&limit=50&source_type=rss`);
      const rssBody = await rssRes.json();
      const rssTitles = (rssBody.pins || []).map((p: any) => p.title);
      expect(rssTitles, "source_type=rss must include rss articles").toContain("Visible Story");

      const webRes = await app.request(`/api/pins/map?bbox=${BBOX}&limit=50&source_type=web`);
      const webBody = await webRes.json();
      const webTitles = (webBody.pins || []).map((p: any) => p.title);
      expect(
        webTitles,
        "inverted-filter regression: non-rss source_type returned articles",
      ).not.toContain("Visible Story");
    } finally {
      await cleanupSource(sid);
    }
  }, 30_000);

  test("cache entries are shape-isolated (light vs full, same bbox)", async () => {
    const sid = await seed();
    try {
      // Populate the cache with the LIGHT shape first…
      const lightRes = await app.request(`/api/pins/map?bbox=${BBOX}&limit=50&light=1`);
      const light = await lightRes.json();
      expect(light.pins.length).toBeGreaterThan(0);

      // …then ask the SAME bbox full. If the cache key omitted `light`
      // (the shipped BUG-9), this returns the truncated payload.
      const fullRes = await app.request(`/api/pins/map?bbox=${BBOX}&limit=50`);
      const full = await fullRes.json();
      const anyFullPin = full.pins[0];
      expect(
        anyFullPin,
        "full request after light returned zero pins — cache-shape contamination",
      ).toBeDefined();
      expect(
        Object.keys(anyFullPin),
        "full payload missing shape keys (status/word_freq/created_at)",
      ).toContain("status");
    } finally {
      await cleanupSource(sid);
    }
  }, 30_000);
});
