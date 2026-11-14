import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { audioRoute } from "../src/routes/audio";
import { getDb, closeDb } from "../src/db";

const app = new Hono();
app.route("/api", audioRoute);

// ── Helpers ──────────────────────────────────────────────────────────

async function seedTestData() {
  const sql = getDb();

  // Seed a test show
  await sql`
    INSERT INTO audio_shows (title, feed_url, language, country, categories, active)
    VALUES ('Test Show', 'https://example.com/test-feed.rss', 'en', 'US', ARRAY['news', 'politics'], true)
    ON CONFLICT (feed_url) DO UPDATE SET title = EXCLUDED.title
    RETURNING id
  `;

  // Get the show id
  const [show] = await sql<{ id: number }[]>`
    SELECT id FROM audio_shows WHERE feed_url = 'https://example.com/test-feed.rss'
  `;

  // Seed test episodes
  await sql`
    INSERT INTO audio_episodes (show_id, url, title, description, status, location_text, event_type, topic_tags, entities, published_at)
    VALUES
      (${show.id}, 'https://example.com/ep1', 'Episode 1: Ukraine War', 'Discussion about the war in Ukraine', 'extracted', 'Ukraine', 'conflict', ARRAY['war', 'geopolitics'], ARRAY['Putin', 'NATO'], now() - interval '1 day'),
      (${show.id}, 'https://example.com/ep2', 'Episode 2: AI News', 'Latest developments in artificial intelligence', 'extracted', 'San Francisco', 'technology', ARRAY['ai', 'tech'], ARRAY['OpenAI', 'Google'], now()),
      (${show.id}, 'https://example.com/ep3', 'Episode 3: Unprocessed', 'This episode has not been extracted yet', 'pending', null, null, ARRAY[]::text[], ARRAY[]::text[], now())
    ON CONFLICT (url) DO NOTHING
  `;

  // Geocode one episode — Kyiv, Ukraine (lat ~50.45, lng ~30.52).
  // Earlier versions of this seed used Paris coords (48.86, 2.35) which
  // fell outside the Ukraine bbox the test queries and made the
  // /api/audio/map test fail with count=0.
  await sql`
    UPDATE audio_episodes SET
      extracted_lat = 50.4501,
      extracted_lng = 30.5234,
      extracted_location = 'Ukraine'
    WHERE url = 'https://example.com/ep1'
  `;

  return show.id;
}

async function cleanupTestData() {
  const sql = getDb();
  await sql`DELETE FROM audio_episodes WHERE url LIKE 'https://example.com/%'`;
  await sql`DELETE FROM audio_shows WHERE feed_url = 'https://example.com/test-feed.rss'`;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Audio API", () => {
  let showId: number;

  beforeAll(async () => {
    showId = await seedTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await closeDb();
  });

  // ── /api/audio/stats ──────────────────────────────────────────────
  describe("GET /api/audio/stats", () => {
    test("returns stats with correct shape", async () => {
      const res = await app.request("/api/audio/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.shows).toBeDefined();
      expect(body.shows.total).toBeGreaterThanOrEqual(1);
      expect(body.shows.active).toBeGreaterThanOrEqual(1);
      expect(body.episodes).toBeDefined();
      expect(body.episodes.total).toBeGreaterThanOrEqual(3);
      expect(body.by_language).toBeArray();
      expect(body.by_country).toBeArray();
      expect(body.by_category).toBeArray();
    });

    test("does not contain BigInt values", async () => {
      const res = await app.request("/api/audio/stats");
      const text = await res.text();
      expect(text).not.toContain('"BigInt"');
      expect(text).not.toContain('64');
    });
  });

  // ── /api/audio/shows ──────────────────────────────────────────────
  describe("GET /api/audio/shows", () => {
    test("returns shows with items/count shape", async () => {
      const res = await app.request("/api/audio/shows");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toBeArray();
      expect(body.count).toBeGreaterThanOrEqual(1);
    });

    test("filters by country", async () => {
      const res = await app.request("/api/audio/shows?country=US");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      for (const item of body.items) {
        expect(item.country).toBe("US");
      }
    });

    test("search by query", async () => {
      const res = await app.request("/api/audio/shows?q=Test");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBeGreaterThanOrEqual(1);
    });

    test("does not crash on ILIKE wildcard in query", async () => {
      const res = await app.request("/api/audio/shows?q=%25");
      expect(res.status).toBe(200);
    });

    test("does not contain BigInt", async () => {
      const res = await app.request("/api/audio/shows");
      const text = await res.text();
      expect(text).not.toContain('"BigInt"');
    });
  });

  // ── /api/audio/shows/:id ──────────────────────────────────────────
  describe("GET /api/audio/shows/:id", () => {
    test("returns show with episodes", async () => {
      const res = await app.request(`/api/audio/shows/${showId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.show).toBeDefined();
      expect(body.show.title).toBe("Test Show");
      expect(body.episodes).toBeArray();
      expect(body.episodes.length).toBe(3);
    });

    test("returns 404 for non-existent show", async () => {
      const res = await app.request("/api/audio/shows/999999");
      expect(res.status).toBe(404);
    });

    test("returns 400 for invalid id", async () => {
      const res = await app.request("/api/audio/shows/abc");
      expect(res.status).toBe(400);
    });
  });

  // ── /api/audio/episodes ──────────────────────────────────────────
  describe("GET /api/audio/episodes", () => {
    test("returns episodes with items/count shape", async () => {
      const res = await app.request("/api/audio/episodes");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toBeArray();
      expect(body.count).toBeGreaterThanOrEqual(3);
      expect(body.limit).toBeDefined();
      expect(body.offset).toBeDefined();
    });

    test("filters by status", async () => {
      const res = await app.request("/api/audio/episodes?status=extracted");
      expect(res.status).toBe(200);
      const body = await res.json();
      for (const item of body.items) {
        expect(item.status).toBe("extracted");
      }
    });

    test("search by query", async () => {
      const res = await app.request("/api/audio/episodes?q=Ukraine");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBeGreaterThanOrEqual(1);
    });

    test("guards negative offset", async () => {
      const res = await app.request("/api/audio/episodes?offset=-100");
      expect(res.status).toBe(200); // should not crash
    });

    test("does not contain BigInt", async () => {
      const res = await app.request("/api/audio/episodes");
      const text = await res.text();
      expect(text).not.toContain('"BigInt"');
    });
  });

  // ── /api/audio/episodes/:id ──────────────────────────────────────
  describe("GET /api/audio/episodes/:id", () => {
    test("returns episode detail", async () => {
      const res = await app.request("/api/audio/episodes?status=extracted&limit=1");
      const body = await res.json();
      const epId = body.items[0]?.id;
      if (!epId) return; // skip if no extracted episodes

      const detail = await app.request(`/api/audio/episodes/${epId}`);
      expect(detail.status).toBe(200);
      const detailBody = await detail.json();
      expect(detailBody.episode).toBeDefined();
      expect(detailBody.people).toBeArray();
      expect(detailBody.claims).toBeArray();
      expect(detailBody.topics).toBeArray();
    });

    test("returns 404 for non-existent episode", async () => {
      const res = await app.request("/api/audio/episodes/999999");
      expect(res.status).toBe(404);
    });
  });

  // ── /api/audio/map ───────────────────────────────────────────────
  describe("GET /api/audio/map", () => {
    test("returns episodes in bbox", async () => {
      // Ukraine area: lat 45-52, lng 20-40
      const res = await app.request("/api/audio/map?bbox=20,45,40,52&limit=10");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toBeArray();
      expect(body.count).toBeGreaterThanOrEqual(1);
    });

    test("returns 400 without bbox", async () => {
      const res = await app.request("/api/audio/map");
      expect(res.status).toBe(400);
    });

    test("returns 400 for invalid bbox", async () => {
      const res = await app.request("/api/audio/map?bbox=abc");
      expect(res.status).toBe(400);
    });
  });

  // ── /api/audio/search ────────────────────────────────────────────
  describe("GET /api/audio/search", () => {
    test("returns shows and episodes", async () => {
      const res = await app.request("/api/audio/search?q=Ukraine");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.shows).toBeArray();
      expect(body.episodes).toBeArray();
    });

    test("returns empty for empty query", async () => {
      const res = await app.request("/api/audio/search?q=");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.shows.length).toBe(0);
      expect(body.episodes.length).toBe(0);
    });

    test("does not burn rate limit on empty query", async () => {
      // Make 50 empty queries — should not rate-limit
      for (let i = 0; i < 50; i++) {
        const res = await app.request("/api/audio/search?q=");
        expect(res.status).toBe(200);
      }
    });
  });

  // ── /api/audio/topics ────────────────────────────────────────────
  describe("GET /api/audio/topics", () => {
    test("returns topics with count", async () => {
      const res = await app.request("/api/audio/topics");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toBeArray();
      expect(body.count).toBeGreaterThanOrEqual(10);
      // Verify each item has slug, label, count
      for (const item of body.items) {
        expect(item.slug).toBeString();
        expect(item.label).toBeString();
        expect(item.count).toBeNumber();
      }
    });
  });

  // ── Error handling ────────────────────────────────────────────────
  describe("Error handling", () => {
    test("invalid show_id returns 400", async () => {
      const res = await app.request("/api/audio/shows/abc");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_id");
    });

    test("invalid episode_id returns 400", async () => {
      const res = await app.request("/api/audio/episodes/xyz");
      expect(res.status).toBe(400);
    });

    test("non-existent show returns 404", async () => {
      const res = await app.request("/api/audio/shows/9999999");
      expect(res.status).toBe(404);
    });

    test("non-existent episode returns 404", async () => {
      const res = await app.request("/api/audio/episodes/9999999");
      expect(res.status).toBe(404);
    });
  });
});
