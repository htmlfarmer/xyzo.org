import { describe, expect, test, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { debugRoute } from "../src/routes/debug";
import { performanceRoute } from "../src/routes/performance";
import { truncateAll, seedAdminKey } from "./helpers";

// Pin the auth contract for operator-only endpoints. /api/sysload is
// intentionally PUBLIC (CPU%/GPU%/timestamp — no PII, no DB state) so
// the debug-panel "Live status" footer works for every user; its
// design choice is documented in src/routes/sysload.ts:113.

// Share a seeded admin key across the "valid key" cases in each
// describe block to keep the total number of bcrypt operations bounded.
// `truncateAll` runs once per describe via beforeAll, not beforeEach.
describe("GET /api/debug auth gate", () => {
  let validKey: string;

  beforeAll(async () => {
    await truncateAll();
    validKey = await seedAdminKey("debug-reader", "editorial");
  });

  test("rejects when X-Admin-Key missing", async () => {
    const app = new Hono();
    app.route("/api", debugRoute);
    const res = await app.request("/api/debug");
    expect(res.status).toBe(401);
  });

  test("rejects when key is invalid", async () => {
    const app = new Hono();
    app.route("/api", debugRoute);
    const res = await app.request("/api/debug", {
      headers: { "X-Admin-Key": "nk_live_wrong.secret" },
    });
    expect(res.status).toBe(401);
  });

  test("returns 200 with valid admin key", async () => {
    const app = new Hono();
    app.route("/api", debugRoute);
    const res = await app.request("/api/debug", {
      headers: { "X-Admin-Key": validKey },
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/performance/* auth gate", () => {
  let validKey: string;

  beforeAll(async () => {
    await truncateAll();
    validKey = await seedAdminKey("perf-reader", "editorial");
  });

  test("rejects /api/performance/summary when X-Admin-Key missing", async () => {
    const app = new Hono();
    app.route("/api", performanceRoute);
    const res = await app.request("/api/performance/summary");
    expect(res.status).toBe(401);
  });

  test("rejects /api/performance/slow when X-Admin-Key missing", async () => {
    const app = new Hono();
    app.route("/api", performanceRoute);
    const res = await app.request("/api/performance/slow");
    expect(res.status).toBe(401);
  });

  test("rejects /api/performance/summary when key is invalid", async () => {
    const app = new Hono();
    app.route("/api", performanceRoute);
    const res = await app.request("/api/performance/summary", {
      headers: { "X-Admin-Key": "nk_live_wrong.secret" },
    });
    expect(res.status).toBe(401);
  });

  test("returns 200 for /api/performance/summary with valid admin key", async () => {
    const app = new Hono();
    app.route("/api", performanceRoute);
    const res = await app.request("/api/performance/summary", {
      headers: { "X-Admin-Key": validKey },
    });
    expect(res.status).toBe(200);
  });

  test("returns 200 for /api/performance/slow with valid admin key", async () => {
    const app = new Hono();
    app.route("/api", performanceRoute);
    const res = await app.request("/api/performance/slow", {
      headers: { "X-Admin-Key": validKey },
    });
    expect(res.status).toBe(200);
  });
});
