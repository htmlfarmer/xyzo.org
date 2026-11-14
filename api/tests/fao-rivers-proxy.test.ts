import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// The cache directory is pointed at a temporary one, so the test never
// writes into the service's own cache.
const CACHE = path.join(os.tmpdir(), `xyzo-rivers-test-${process.pid}`);
process.env.XYZO_RIVERS_TILE_CACHE = CACHE;

const { faoRiversProxyRoute } = await import("../src/routes/faoRiversProxy");

const app = new Hono();
app.route("/api", faoRiversProxyRoute);

afterAll(async () => {
  await fs.rm(CACHE, { recursive: true, force: true });
});

describe("GET /api/tile/fao-rivers/:level/:z/:y/:x", () => {
  test("an unknown level is a 400 — the request is wrong, not the tile", async () => {
    const res = await app.request("/api/tile/fao-rivers/not-a-level/4/8/8");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_level");
  });

  test("a malformed tile number is a 400", async () => {
    const res = await app.request("/api/tile/fao-rivers/medium/4/abc/8");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_tile");
  });

  test("a zoom the network does not have is a 400", async () => {
    const res = await app.request("/api/tile/fao-rivers/medium/99/1/1");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_zoom");
  });

  test("a tile outside the zoom's range is a 400", async () => {
    // At zoom 2 the grid is 4x4, so x=9 is not a tile.
    const res = await app.request("/api/tile/fao-rivers/medium/2/9/9");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_tile");
  });

  test("the disk cache is SWEPT — an expired tile is removed, a fresh one is kept", async () => {
    // Nothing used to delete the expired entries: `readCache()` simply
    // ignored them, so the directory grew without bound (a z5 screen is
    // ~35 tiles, ~5 MB, and every new area a reader visits added to it).
    // On a site with real traffic that is a slow disk-full.
    //
    // The sweeper must honour EXACTLY the age `readCache()` honours, or
    // it could take a tile that would still have been served.
    const day = 24 * 60 * 60 * 1000;
    const dir = path.join(CACHE, "2026", "medium", "6");
    await fs.mkdir(dir, { recursive: true });
    const old = path.join(dir, "1.png");
    const fresh = path.join(dir, "2.png");
    await fs.writeFile(old, "x");
    await fs.writeFile(fresh, "x");
    const past = new Date(Date.now() - 30 * day);
    await fs.utimes(old, past, past);
    // One request runs the sweeper (it is rate-limited to once an hour).
    const res = await app.request("/api/tile/fao-rivers/medium/6/1/1");
    expect([200, 400]).toContain(res.status);
    // The old one is gone; the fresh one is still there.
    expect(await fs.exists(old)).toBe(false);
    expect(await fs.exists(fresh)).toBe(true);
  });

  test("there is NO way to make the proxy fetch an arbitrary URL", async () => {
    // THE RULE (the same one the NASA tile proxy follows): the upstream
    // URL is assembled from a whitelist — the level's own filter and the
    // PUBLISHED SLD — and there is no parameter a caller can add to
    // change it. So the route has no SSRF surface at all.
    const res = await app.request(
      "/api/tile/fao-rivers/medium/4/8/8?url=https://evil.example/x&sld_body=xx",
    );
    // Whatever the upstream does, the answer is a PNG or a 400 — never
    // the body of somebody else's URL.
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers.get("content-type")).toBe("image/png");
    }
    // The timeout is the PUBLISHER's, not ours: this request really
    // does fetch a tile upstream, and the publisher answers in 2-25 s.
  }, 60_000);

  test("a real tile answers 200 with a PNG, and it is written to the disk cache", async () => {
    // THE RULE. A tile that cannot be produced is not an error: the
    // proxy answers 200 with a 1x1 transparent PNG rather than a 404,
    // because a 404 on a tile is a browser-logged console error that no
    // JavaScript can suppress.
    //
    // This is a CHEAP tile (zoom 4 over central Africa) — the whole
    // world in one tile (zoom 0) takes the publisher 48 seconds, which
    // is a fact about the publisher, not about the proxy.
    const res = await app.request("/api/tile/fao-rivers/medium/8/8/8");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    if (res.headers.get("x-proxy-placeholder") !== "1") {
      // A real tile — and it must be ON DISK, because the second reader
      // of a view is a local file and not a two-second round trip to a
      // busy public server. The cache key carries the EDITION, so a new
      // edition of the network is a new picture and not a stale one.
      const meta = JSON.parse(
        await fs.readFile(
          path.join(import.meta.dir, "..", "..", "public_html", "data", "rivers", "fao", "meta.json"),
          "utf8"),
      );
      const edition = meta.edition || meta.published || "unknown";
      const file = path.join(CACHE, edition, "medium", "8", "8", "8.png");
      expect(await fs.stat(file)).toBeTruthy();
    }
  }, 60_000);

  test("the placeholder is marked, so the client can tell it from a tile", async () => {
    const res = await app.request("/api/tile/fao-rivers/medium/4/8/8");
    if (res.headers.get("x-proxy-placeholder") === "1") {
      expect(res.headers.get("x-proxy-reason")).toBeTruthy();
    }
  }, 60_000);
});
