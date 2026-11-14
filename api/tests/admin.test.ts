import { describe, expect, test, beforeEach } from "bun:test";
import { Hono } from "hono";
import { adminRoute } from "../src/routes/admin";
import { truncateAll, seedAdminKey } from "./helpers";
import { getDb } from "../src/db";

describe("POST /api/admin/pins (editorial)", () => {
  beforeEach(async () => { await truncateAll(); });

  test("rejects when X-Admin-Key missing", async () => {
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request("/api/admin/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", lat: 0, lng: 0, body_markdown: "y", author_name: "z" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects when key is invalid", async () => {
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request("/api/admin/pins", {
      method: "POST",
      headers: { "X-Admin-Key": "nk_live_wrong.secret", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", lat: 0, lng: 0, body_markdown: "y", author_name: "z" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects when role is wrong (rss_ingest can't post editorial)", async () => {
    const key = await seedAdminKey("rss-bot", "rss_ingest");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request("/api/admin/pins", {
      method: "POST",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", lat: 0, lng: 0, body_markdown: "y", author_name: "z" }),
    });
    expect(res.status).toBe(403);
  });

  test("creates editorial pin when role is editorial", async () => {
    const key = await seedAdminKey("editor-1", "editorial");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request("/api/admin/pins", {
      method: "POST",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Karachi flood", lat: 24.86, lng: 67.00,
        body_markdown: "# Heading\n\nDetails...",
        author_name: "Reporter",
        category: "weather",
        published_at: "2026-08-18T03:00:00Z",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeGreaterThan(0);
    const sql = getDb();
    const [pin] = await sql<any[]>`SELECT * FROM pins WHERE id = ${body.id}`;
    expect(pin.source_type).toBe("editorial");
    expect(pin.category).toBe("weather");
  });
});

describe("POST /api/admin/rss", () => {
  beforeEach(async () => { await truncateAll(); });

  test("ingests RSS item", async () => {
    const key = await seedAdminKey("rss-bot", "rss_ingest");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request("/api/admin/rss", {
      method: "POST",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Article",
        lat: 40.7, lng: -74.0,
        source_feed: "https://feed.example.com/rss",
        source_url: "https://example.com/article/xyz",
        original_published_at: "2026-08-20T00:00:00Z",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeGreaterThan(0);
  });

  test("dedupes by normalized source_url — second POST returns existing pin", async () => {
    const key = await seedAdminKey("rss-bot", "rss_ingest");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const url1 = "https://example.com/article?utm_source=tw";
    const url2 = "https://EXAMPLE.com/article";

    const res1 = await app.request("/api/admin/rss", {
      method: "POST",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Article", lat: 40.7, lng: -74.0,
        source_feed: "https://feed.example.com/rss",
        source_url: url1,
      }),
    });
    expect(res1.status).toBe(201);
    const first = await res1.json();

    const res2 = await app.request("/api/admin/rss", {
      method: "POST",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Article (dup)", lat: 40.7, lng: -74.0,
        source_feed: "https://feed.example.com/rss",
        source_url: url2,
      }),
    });
    expect(res2.status).toBe(200);
    const second = await res2.json();
    expect(second.id).toBe(first.id);
    expect(second.dedup).toBe(true);
  });

  test("editorial role can't post RSS", async () => {
    const key = await seedAdminKey("editor", "editorial");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request("/api/admin/rss", {
      method: "POST",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "x", lat: 0, lng: 0,
        source_feed: "https://f.com", source_url: "https://f.com/x",
      }),
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/admin/pins/:id (hide / update)", () => {
  beforeEach(async () => { await truncateAll(); });

  test("hides a pin (fast takedown)", async () => {
    const sql = getDb();
    const [p] = await sql<{ id: number }[]>`
      INSERT INTO pins (source_type, title, location)
      VALUES ('editorial', 'Bad', ST_SetSRID(ST_MakePoint(0,0),4326)::geography)
      RETURNING id`;
    await sql`INSERT INTO editorial_details (pin_id, body_markdown, author_name) VALUES (${p.id}, 'x', 'y')`;

    const key = await seedAdminKey("editor", "editorial");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request(`/api/admin/pins/${p.id}`, {
      method: "PATCH",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "hidden" }),
    });
    expect(res.status).toBe(200);
    const [hidden] = await sql<any[]>`SELECT status FROM pins WHERE id = ${p.id}`;
    expect(hidden.status).toBe("hidden");
  });

  test("hidden pin disappears from GET /api/pins", async () => {
    const sql = getDb();
    const [p] = await sql<{ id: number }[]>`
      INSERT INTO pins (source_type, title, location)
      VALUES ('editorial', 'Bad', ST_SetSRID(ST_MakePoint(0,0),4326)::geography)
      RETURNING id`;
    await sql`INSERT INTO editorial_details (pin_id, body_markdown, author_name) VALUES (${p.id}, 'x', 'y')`;

    const key = await seedAdminKey("editor", "editorial");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    await app.request(`/api/admin/pins/${p.id}`, {
      method: "PATCH",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "hidden" }),
    });
    const { pinsRoute } = await import("../src/routes/pins");
    const a = new Hono();
    a.route("/api", pinsRoute);
    const res = await a.request("/api/pins");
    const body = await res.json();
    expect(body.pins.find((x: any) => x.id === p.id)).toBeUndefined();
  });

  test("404 on unknown id", async () => {
    const key = await seedAdminKey("editor", "editorial");
    const app = new Hono();
    app.route("/api/admin", adminRoute);
    const res = await app.request("/api/admin/pins/999999", {
      method: "PATCH",
      headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "hidden" }),
    });
    expect(res.status).toBe(404);
  });
});
