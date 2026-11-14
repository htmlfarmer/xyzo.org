import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { healthRoute } from "../src/routes/health";

describe("GET /api/health", () => {
  test("returns ok with version", async () => {
    const app = new Hono();
    app.route("/api/health", healthRoute);
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
