/**
 * Tests for GET /api/pins schema contract & pagination parameters.
 */
import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { ListPinsQuerySchema } from "../src/validate";
import { encodeCursor, decodeCursor } from "../src/cursors";

const app = new Hono();

app.get(
  "/pins",
  zValidator("query", ListPinsQuerySchema),
  (c) => {
    const q = c.req.valid("query");
    const cursor = q.before ? decodeCursor(q.before) : null;
    return c.json({
      pins: [],
      next_cursor: null,
      has_more: false,
      _echo: q,
      _decoded_cursor: cursor,
    });
  }
);

describe("GET /api/pins — schema & cursor pagination", () => {
  test("valid before cursor is accepted and decoded", async () => {
    const ts = new Date("2026-09-06T12:00:00.000Z");
    const encoded = encodeCursor(ts, 12345);

    const res = await app.request(`/pins?before=${encodeURIComponent(encoded)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._echo.before).toBe(encoded);
    expect(body._decoded_cursor).not.toBeNull();
    expect(body._decoded_cursor.id).toBe(12345);
    expect(new Date(body._decoded_cursor.timestamp).toISOString()).toBe(ts.toISOString());
  });

  test("missing before cursor returns null decoded cursor", async () => {
    const res = await app.request("/pins?limit=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._decoded_cursor).toBeNull();
  });
});
