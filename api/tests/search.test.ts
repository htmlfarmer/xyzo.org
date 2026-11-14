import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { pinsRoute } from "../src/routes/pins";
import { searchRoute } from "../src/routes/search";
import { aiChatRoute } from "../src/routes/ai-chat";
import { eventsRoute } from "../src/routes/events";
import { locationsRoute } from "../src/routes/locations";

describe("GET /api/pins — query validation", () => {
  test("returns 200 with pins array for a topic query", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins?q=artificial+intelligence&limit=100");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("pins");
    expect(Array.isArray(body.pins)).toBe(true);
  });

  test("returns 200 with empty pins array for nonexistent topic", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins?q=nonexistenttopic123xyz&limit=100");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pins).toEqual([]);
  });

  test("rejects limit parameter over schema max (cap enforced)", async () => {
    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request("/api/pins?q=AI&limit=99999");
    // Schema caps limit at 1000; over-cap must return 400 (or be clamped
    // — depending on implementation). What we DON'T accept is 200 with
    // an unbounded read that could DoS the DB.
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(body.pins.length).toBeLessThanOrEqual(1000);
    }
  });
});

describe("GET /api/locations/search", () => {
  test("returns location matches for a city name", async () => {
    const app = new Hono();
    app.route("/api", locationsRoute);
    const res = await app.request("/api/locations/search?q=San+Francisco&limit=5");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.locations)).toBe(true);
    if (body.locations.length > 0) {
      expect(body.locations[0]).toHaveProperty("place_name");
      expect(body.locations[0]).toHaveProperty("lat");
      expect(body.locations[0]).toHaveProperty("lng");
    }
  });

  test("returns 200 for unrecognized place (may be empty or fallback-gazetteer match)", async () => {
    // Loose assertion: an unknown query should not 5xx. May be empty
    // (similarity filter rejects it) or a gazetteer fallback hit. The
    // exact behavior depends on the gazetteer's coverage and similarity
    // threshold — both may evolve. What we MUST guarantee: 200 status.
    const app = new Hono();
    app.route("/api", locationsRoute);
    const res = await app.request("/api/locations/search?q=zzqxNotALocationXYZ123&limit=5");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.locations)).toBe(true);
  });

  test("respects limit parameter", async () => {
    const app = new Hono();
    app.route("/api", locationsRoute);
    const res = await app.request("/api/locations/search?q=New+York&limit=2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.locations.length).toBeLessThanOrEqual(2);
  });
});

describe("POST /api/ai/chat", () => {
  test("returns 400 for empty message", async () => {
    const app = new Hono();
    app.route("/api", aiChatRoute);
    const res = await app.request("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for missing message", async () => {
    const app = new Hono();
    app.route("/api", aiChatRoute);
    const res = await app.request("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test.skip("returns a response or error for a valid question (requires AI service)", async () => {
    const app = new Hono();
    app.route("/api", aiChatRoute);
    const res = await app.request("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What is artificial intelligence?" }),
    });
    expect([200, 502, 504]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("response");
      expect(typeof body.response).toBe("string");
    }
  });
});

describe("POST /api/events/search", () => {
  test("returns 400 for missing query parameter", async () => {
    const app = new Hono();
    app.route("/api", searchRoute);
    const res = await app.request("/api/events/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test.skip("accepts query without explicit limit (requires worker, slow in test env)", async () => {
    const app = new Hono();
    app.route("/api", searchRoute);
    const res = await app.request("/api/events/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "test" }),
    });
    expect([200, 400, 408, 429, 500]).toContain(res.status);
  });

  test.skip("accepts valid topic query (requires worker, slow in test env)", async () => {
    const app = new Hono();
    app.route("/api", searchRoute);
    const res = await app.request("/api/events/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "artificial intelligence", limit: 10 }),
    });
    expect([200, 400, 408, 429, 500]).toContain(res.status);
  });
});
