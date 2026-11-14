import { describe, expect, test, beforeEach } from "bun:test";
import { Hono } from "hono";
import { pinsRoute } from "../src/routes/pins";
import { truncateAll } from "./helpers";
import { pinsCache } from "../src/cache";
import { getDb } from "../src/db";

async function makeEditorialPin(title: string, lat: number, lng: number) {
  const sql = getDb();
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO pins (source_type, title, location, published_at, created_at)
    VALUES ('editorial', ${title}, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, clock_timestamp(), clock_timestamp())
    RETURNING id
  `;
  await sql`
    INSERT INTO editorial_details (pin_id, body_markdown, author_name)
    VALUES (${row.id}, ${"# " + title}, 'Tester')
  `;
  pinsCache.clear();
  return Number(row.id);
}

describe("GET /api/pins", () => {
  beforeEach(async () => { await truncateAll(); pinsCache.clear(); });

  test("returns empty list when no pins", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pins).toEqual([]);
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
  });

  test("returns pins sorted by created_at DESC", async () => {
    await makeEditorialPin("First", 0, 0);
    await new Promise(r => setTimeout(r, 5));
    await makeEditorialPin("Second", 0, 0);
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins");
    const body = await res.json();
    expect(body.pins.length).toBe(2);
    expect(body.pins[0].title).toBe("Second");
    expect(body.pins[1].title).toBe("First");
  });

  test("filters by bbox", async () => {
    await makeEditorialPin("InBox", 24.86, 67.00);
    await makeEditorialPin("OutBox", -33.86, 151.20);
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins?bbox=60,20,75,30");
    const body = await res.json();
    expect(body.pins.length).toBe(1);
    expect(body.pins[0].title).toBe("InBox");
  });

  test("filters by category", async () => {
    const sql = getDb();
    await sql`INSERT INTO pins (source_type, title, location, category)
              VALUES ('editorial', 'Cat', ST_SetSRID(ST_MakePoint(0,0),4326)::geography, 'weather')`;
    await sql`INSERT INTO pins (source_type, title, location, category)
              VALUES ('editorial', 'Other', ST_SetSRID(ST_MakePoint(0,0),4326)::geography, 'politics')`;
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins?category=weather");
    const body = await res.json();
    expect(body.pins.length).toBe(1);
    expect(body.pins[0].category).toBe("weather");
  });

  test("cursor pagination: returns has_more and next_cursor when limit hit", async () => {
    for (let i = 0; i < 5; i++) {
      await makeEditorialPin(`Pin${i}`, 0, 0);
    }
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins?limit=2");
    const body = await res.json();
    expect(body.pins.length).toBe(2);
    expect(body.has_more).toBe(true);
    expect(body.next_cursor).toBeTruthy();

    const res2 = await app.request(`/api/pins?limit=2&before=${encodeURIComponent(body.next_cursor)}`);
    const body2 = await res2.json();
    expect(body2.pins.length).toBe(2);
    expect(body2.has_more).toBe(true);
  });
});

describe("GET /api/pins/:id", () => {
  beforeEach(async () => { await truncateAll(); });

  test("returns editorial pin with detail, no email leak possible", async () => {
    const id = await makeEditorialPin("Detail", 24.86, 67.00);
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request(`/api/pins/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.source_type).toBe("editorial");
    expect(body.detail.body_markdown).toBe("# Detail");
    expect(body.detail.author_name).toBe("Tester");
    expect(JSON.stringify(body)).not.toContain("submitter_email");
  });

  test("community pin detail never contains email even though DB row does", async () => {
    const sql = getDb();
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO pins (source_type, title, location)
      VALUES ('community', 'Community', ST_SetSRID(ST_MakePoint(0,0),4326)::geography)
      RETURNING id
    `;
    await sql`
      INSERT INTO community_details (pin_id, submitter_name, submitter_email)
      VALUES (${row.id}, 'Jane', 'jane@example.com')
    `;
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request(`/api/pins/${row.id}`);
    const body = await res.json();
    expect(body.detail.submitter_name).toBe("Jane");
    expect(JSON.stringify(body)).not.toContain("jane@example.com");
  });

  test("returns 404 for missing id", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins/999999");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/pins (community submission)", () => {
  beforeEach(async () => { await truncateAll(); });

  test("creates a pin and returns 201", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Protest in Lahore",
        submitter_name: "Jane",
        submitter_email: "jane@example.com",
        lat: 31.52, lng: 74.36,
        hp_company: "",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeGreaterThan(0);
    expect(body.title).toBe("Protest in Lahore");
  });

  test("rejects when honeypot is filled", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Bot spam",
        submitter_name: "Bot",
        submitter_email: "bot@example.com",
        lat: 0, lng: 0,
        hp_company: "i am a bot",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects when validation fails (missing title)", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submitter_name: "Jane",
        submitter_email: "jane@example.com",
        lat: 0, lng: 0,
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/pins/stats", () => {
  beforeEach(async () => { await truncateAll(); });

  test("returns pin counts per timeframe and health status", async () => {
    await makeEditorialPin("Fresh Pin", 10.0, 20.0);
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toBeDefined();
    expect(body.counts["24h"]).toBe(1);
    expect(body.counts["7d"]).toBe(1);
    expect(body.counts["all"]).toBe(1);
    expect(body.healthy).toBe(true);
    expect(body.latest_timestamp).toBeTruthy();
  });
});
