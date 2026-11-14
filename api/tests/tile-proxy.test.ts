import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { tileProxyRoute } from "../src/routes/tileProxy";

const app = new Hono();
app.route("/api", tileProxyRoute);

describe("GET /api/tile/:dataset/:date/:z/:y/:x", () => {
  test("an unknown dataset is a 400 — the request is wrong, not the tile", async () => {
    const res = await app.request("/api/tile/not-a-dataset/2026-11-02/2/1/2");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_dataset");
  });

  test("a malformed date is a 400", async () => {
    const res = await app.request("/api/tile/rain/yesterday/2/1/2");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_date");
  });

  test("a zoom the matrix does not have is a 400", async () => {
    // GIBS answers HTTP 400 for a level that does not exist in that
    // matrix ("Level6 supports zoom 0..6 — asking for 7+ returns 400"),
    // and a 400 is a console error too — so the proxy refuses it first.
    const res = await app.request("/api/tile/rain/2026-11-02/9/6/8");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_zoom");
  });

  test("a tile outside the level's range is a 400", async () => {
    const res = await app.request("/api/tile/rain/2026-11-02/2/9/9");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_tile");
  });

  // A date GIBS has nothing for, and far enough in the past that the
  // date-resolution walk-back does not apply (it only covers a recent
  // request) — so this is deterministically a MISSING tile. IMERG
  // starts in June 2000; 1999 is safely before it.
  const MISSING = "/api/tile/rain/1999-01-01/2/1/2";

  test("a missing tile answers 200 with a TRANSPARENT PNG, not a 404", async () => {
    // THE RULE. GIBS has no tile over the open ocean and none over the
    // poles, and it answers 404. A 404 on a tile is a browser-logged
    // console error that no JavaScript can suppress — so the proxy
    // answers 200 with a 1x1 transparent PNG and the console stays
    // clean.
    const res = await app.request(MISSING);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = new Uint8Array(await res.arrayBuffer());
    // A PNG, and a TINY one (the placeholder is 70 bytes).
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf.length).toBeLessThan(200);
  });

  test("the placeholder is marked, so the client can tell it from a tile", async () => {
    const res = await app.request(MISSING);
    expect(res.headers.get("x-proxy-placeholder")).toBe("1");
  });

  test("a tile that EXISTS is served, with the date it was taken from", async () => {
    // The canary tile (z4, x8, y6 — over central Africa) is covered by
    // every one of these products, so the proxy resolves a published
    // date from it and serves the tile from THAT date.
    //
    // GIBS is FLAKY — the same URL answered 404, 200, 200, 404 across
    // four identical requests — so the request is retried here too.
    // The contract is checked on every attempt: the proxy NEVER
    // answers a 404, and when it serves a tile it says which date it
    // came from.
    let served = false;
    for (let i = 0; i < 4 && !served; i++) {
      const res = await app.request("/api/tile/rain/2026-11-02/4/6/8");
      expect(res.status).toBe(200);
      const date = res.headers.get("x-tile-date");
      if (res.headers.get("x-proxy-placeholder")) {
        // The upstream flaked; the proxy answered with the placeholder,
        // which is the CORRECT answer for a tile it could not get.
        continue;
      }
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const buf = new Uint8Array(await res.arrayBuffer());
      expect(buf.length).toBeGreaterThan(500);
      served = true;
    }
    expect(served, "GIBS served the canary tile at least once").toBe(true);
  });

  test("the satellite resolves a PUBLISHED date, not the requested one", async () => {
    // GIBS publishes the true-colour satellite a day or two behind, so
    // "yesterday" used to be a whole layer of 404s and the overlay
    // silently drew nothing. The proxy walks the date back until one
    // answers — and says which date it used.
    let date: string | null = null;
    for (let i = 0; i < 4 && !date; i++) {
      const res = await app.request("/api/tile/satellite/2026-11-03/4/6/8");
      expect(res.status).toBe(200);
      const d = res.headers.get("x-tile-date");
      if (!d) continue;   // the upstream flaked — the placeholder
      date = d;
    }
    expect(date, "the proxy resolved a published date").not.toBeNull();
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Never LATER than the one asked for: the proxy walks BACK, never
    // forward.
    expect(date! <= "2026-11-03").toBe(true);
  });

  test("the night lights keep their PINNED date", async () => {
    // The night layer is a fixed historical product — "the most recent
    // published" is meaningless for it, so the walk-back must not move
    // it.
    const res = await app.request("/api/tile/night/2016-01-01/4/6/8");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-tile-date")).toBe("2016-01-01");
  });

  test("the tile is CORS-open and cacheable", async () => {
    const res = await app.request("/api/tile/rain/2026-11-02/4/6/8");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toContain("max-age");
  });
});
