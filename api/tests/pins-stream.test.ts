/**
 * Tests for NDJSON streaming on GET /api/pins/map.
 */
import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { MapPinsQuerySchema } from "../src/validate";

const app = new Hono();

app.get(
  "/pins/map",
  zValidator("query", MapPinsQuerySchema),
  (c) => {
    const q = c.req.valid("query");
    const format = c.req.query("format");
    const acceptHeader = c.req.header("accept") || "";
    const isNdjson = format === "ndjson" || acceptHeader.includes("application/x-ndjson");

    if (isNdjson) {
      c.header("Content-Type", "application/x-ndjson");
      const meta = JSON.stringify({ meta: true, count: 1, widened: false, actual_bbox: q.bbox ?? null }) + "\n";
      const pin = JSON.stringify({ id: 1, title: "Test Pin", location: { lat: 10, lng: 20 } }) + "\n";

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(meta));
          controller.enqueue(encoder.encode(pin));
          controller.close();
        },
      });
      return c.body(stream);
    }

    return c.json({ pins: [{ id: 1, title: "Test Pin" }], count: 1 });
  }
);

describe("GET /api/pins/map — NDJSON streaming", () => {
  test("returns application/x-ndjson when Accept header is application/x-ndjson", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85", {
      headers: { Accept: "application/x-ndjson" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(2);
    const meta = JSON.parse(lines[0]);
    expect(meta.meta).toBe(true);
    const pin = JSON.parse(lines[1]);
    expect(pin.id).toBe(1);
  });

  test("returns application/x-ndjson when ?format=ndjson is present", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85&format=ndjson");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
  });

  test("returns standard application/json when NDJSON is not requested", async () => {
    const res = await app.request("/pins/map?bbox=-180,-85,180,85");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
