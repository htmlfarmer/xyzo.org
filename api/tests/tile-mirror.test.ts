import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  tileMirrorRoute,
  mirrorIds,
  mirrorSources,
  mirrorUpstream,
  MIRROR_MAX_AGE_MS,
} from "../src/routes/tileMirror";

const app = new Hono();
app.route("/api", tileMirrorRoute);

/**
 * Every host the mirror is ALLOWED to talk to.
 *
 * This list is deliberately NOT read out of tileMirror.ts: it is the
 * second opinion. Adding a source with a new host has to fail here
 * first, so somebody has to decide that the origin belongs on both
 * sides rather than quietly appearing in one table.
 *
 * (There is no client-supplied URL anywhere in the route, so this is a
 * belt-and-braces check on a whitelist rather than the SSRF guard
 * itself — that is `safeFetch`, on every upstream request.)
 */
const ALLOWED_HOSTS = [
  "server.arcgisonline.com",
  "tile.openstreetmap.org",
  "a.tile.opentopomap.org",
  "tiles.macrostrat.org",
  "data.apps.fao.org",
];

describe("the whitelist", () => {
  test("every source builds a URL on a host we put there on purpose", () => {
    expect(mirrorIds().length).toBe(11);
    for (const id of mirrorIds()) {
      const url = mirrorUpstream(id, 3, 2, 1);
      expect(url, `${id} built no URL`).toBeTruthy();
      const host = new URL(url as string).hostname;
      expect(ALLOWED_HOSTS, `${id} talks to ${host}`).toContain(host);
      // The coordinates have to reach the origin: a builder that
      // ignored them would serve one tile for every point on Earth,
      // which looks exactly like a working map of the wrong places.
      for (const n of ["3", "2", "1"]) {
        expect(url as string, `${id} ignored a coordinate`).toContain(n);
      }
    }
  });

  test("the twelve sources are all specified", () => {
    expect(mirrorIds().sort()).toEqual(
      [
        "esri-dark",
        "esri-imagery",
        "esri-light",
        "esri-natgeo",
        "esri-street",
        "esri-terrain",
        "hwsd",
        "macrostrat",
        "opentopo",
        "osm",
        "worldpop",
      ].sort()
    );
    for (const s of mirrorSources()) {
      expect(s.label.length, `${s.id} has no label`).toBeGreaterThan(3);
      expect(s.ttlMs, `${s.id} has no TTL`).toBeGreaterThan(0);
      expect(s.maxZoom, `${s.id} has no maxZoom`).toBeGreaterThan(0);
    }
  });

  test("nothing can be evicted before it is ever revalidated", () => {
    // The freshness contract in one line: a copy must survive long
    // enough to be ASKED ABOUT. A TTL at or beyond MAX_AGE would mean
    // the sweeper deleted a tile first, and revalidation would never
    // run for that source at all.
    for (const s of mirrorSources()) {
      expect(
        MIRROR_MAX_AGE_MS,
        `${s.id}: TTL ${s.ttlMs}ms is not under the ${MIRROR_MAX_AGE_MS}ms ceiling`
      ).toBeGreaterThan(s.ttlMs);
    }
  });

  test("the route carries NO file extension", () => {
    // Caddy's `@staticAssets` block matches `path *.png *.jpg …` with no
    // `/api/` exclusion and stamps it `max-age=31536000, immutable` — a
    // mirrored `/…/5/3/2.png` would be pinned in the browser for a YEAR,
    // which is the exact opposite of the revalidation this route exists
    // to provide. Extension-less is load-bearing (the NASA and FAO-river
    // proxies already are).
    const paths = tileMirrorRoute.routes.map((r) => r.path).join(" ");
    expect(paths).toMatch(/:mapId/);
    expect(paths).toMatch(/:z/);
    expect(paths).not.toMatch(/\.(png|jpe?g|webp|gif|avif)/i);
  });
});

describe("GET /api/tile/mirror/:mapId/:z/:x/:y", () => {
  test("an unknown source is a 404 — the request is wrong, not the tile", async () => {
    const res = await app.request("/api/tile/mirror/not-a-source/3/2/1");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_mirror");
  });

  test("a non-integer coordinate is a 400", async () => {
    for (const bad of ["/a/1/1", "/3/x/1", "/3/1/1.5"]) {
      const res = await app.request(`/api/tile/mirror/osm${bad}`);
      expect(res.status, bad).toBe(400);
      expect((await res.json()).error).toBe("bad_tile_request");
    }
  });

  test("a coordinate outside the grid is a 400", async () => {
    // z=3 has 8 columns; x=99 and x=-1 are both impossible, and a
    // 400 is about the request rather than about a missing tile.
    expect((await app.request("/api/tile/mirror/osm/3/99/1")).status).toBe(400);
    expect((await app.request("/api/tile/mirror/osm/3/-1/1")).status).toBe(400);
    expect((await app.request("/api/tile/mirror/osm/-1/1/1")).status).toBe(400);
  });

  test("past a source's own maxZoom the answer is a placeholder, not a 404", async () => {
    // NatGeo stops at z12; asking for z18 would have the origin 404, and
    // a 404 on an <img> is a console line the reader can neither read
    // nor act on. The house answer is HTTP 200 + a transparent pixel.
    const res = await app.request("/api/tile/mirror/esri-natgeo/18/1/1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-tile-mirror")).toMatch(/placeholder/);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
