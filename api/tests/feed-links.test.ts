// Tests for GET /api/feed/links — the story-connection arcs.
//
// The endpoint used to filter news_story_links (36.6 M rows) with an OR
// of four geometry/coordinate tests, which meant a full table scan per
// request: 65 s for one viewport, so the browser's fetch timed out and
// the Links arcs never rendered (the toggle looked broken).
//
// It is now driven from the articles in view (the spatial index) with a
// LATERAL over the two source/target indexes on news_story_links.
//
// Verifies:
//  1. a bbox request answers 200 with the nodes/edges shape
//  2. the response stays inside the requested limit
//  3. the request is answered in well under the old 65 s (the guard that
//     would have caught the regression)

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { feedRoute } from "../src/routes/feed";

process.env.XYZO_INTERNAL_KEY = "links-test-internal-key";

function makeApp() {
  const app = new Hono();
  app.route("/api", feedRoute);
  return app;
}

describe("/api/feed/links", () => {
  test("answers a bbox request with the nodes/edges shape", async () => {
    const app = makeApp();
    const res = await app.request(
      "/api/feed/links?limit=25&min_weight=0.25&bbox=-0.3,51.3,0.3,51.7",
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
  }, 60_000);

  test("never returns more edges than the limit", async () => {
    const app = makeApp();
    const res = await app.request(
      "/api/feed/links?limit=10&min_weight=0.25&bbox=-180,-85,180,85",
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.edges.length).toBeLessThanOrEqual(10);
  }, 60_000);

  test("a viewport query is answered quickly (regression guard)", async () => {
    const app = makeApp();
    const started = Date.now();
    const res = await app.request(
      "/api/feed/links?limit=50&min_weight=0.25&bbox=-74.1,40.6,-73.9,40.8",
    );
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    // The old full-table scan took 65 s+ here and the browser gave up.
    expect(elapsed).toBeLessThan(20_000);
  }, 60_000);
});
