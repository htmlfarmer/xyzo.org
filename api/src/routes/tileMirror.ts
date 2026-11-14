/**
 * tileMirror.ts — one shared, freshness-checked local cache for every
 * REMOTE tile source the map draws from.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The map's basemaps and several overlays are hotlinked straight from
 * other people's servers: Esri (six services — imagery, streets, dark,
 * light, NatGeo, terrain), OpenStreetMap, OpenTopoMap, Macrostrat and
 * two FAO WMTS layers (WorldPop, HWSD soil type). Measured on the
 * owner's own link, those hosts are asked for ~180 tiles per view, and
 * a remote user pays a DNS+TCP+TLS handshake per host before a single
 * pixel arrives (raw TTFB from this box: Esri 165 ms, FAO 237 ms,
 * Macrostrat 287 ms — and every one of them is a place the page can
 * stall if the origin is having a bad day).
 *
 * So we ask ONCE, store it, and serve everybody else from disk.
 *
 * THE FRESHNESS CONTRACT (the owner's words: *"we don't want to save it
 * permanently, we just want to cache it so we have live data ready when
 * people need it"*)
 * ─────────────────────────────────────────────────────────────────────
 * A cached tile is served untouched while it is younger than its
 * source's TTL. Past the TTL it is REVALIDATED against the origin with
 * `If-Modified-Since`: a 304 keeps the bytes and refreshes the clock, a
 * 200 replaces them, and an origin that is down or slow answers with
 * the STALE copy rather than a hole in the map (availability beats
 * freshness — the reader can always see the last good picture, and the
 * next request tries again). Nothing is written that is older than
 * MAX_AGE: a sweeper prunes it hourly and enforces a byte ceiling, so
 * the cache is a cache and not an archive.
 *
 * ── THREE RULES THAT ARE LOAD-BEARING ─────────────────────────────────
 *
 * 1. **THE URL CARRIES NO FILE EXTENSION.** Caddy's `@staticAssets`
 *    header block matches `path *.png *.jpg …` with no `/api/`
 *    exclusion, so a mirrored `/api/tile/mirror/esri/5/3/2.png` would be
 *    sent with `Cache-Control: public, max-age=31536000, immutable` — a
 *    YEAR in the browser, which is precisely the freshness this file
 *    exists to provide. The NASA and FAO-river proxies already use
 *    extension-less paths for the same reason; browsers sniff images
 *    regardless (`nosniff` only binds scripts and stylesheets).
 *
 * 2. **THE UPSTREAM URL IS BUILT SERVER-SIDE FROM A WHITELIST.** There
 *    is no user-supplied URL anywhere in this file, so there is no SSRF
 *    surface to have to reason about — the only variable is z/x/y, and
 *    those are range-checked integers. Fetches go through `safeFetch`
 *    anyway, because a whitelist is a claim and the guard is the proof.
 *
 * 3. **AN ERROR PAGE IS NEVER CACHED AS A TILE.** FAO answers
 *    `{"detail":"Not Found"}` with HTTP 200 and a JSON body when it
 *    dislikes a request, and a publisher's maintenance page is a 200
 *    too. Anything whose content-type is not an image is treated as a
 *    failed fetch: the placeholder goes out (the house rule — a missing
 *    tile is a 200 transparent PNG, never a 404, because a 404 on an
 *    `<img>` is a console line the reader can neither read nor fix) and
 *    nothing is written to disk.
 *
 * Route:  GET /api/tile/mirror/:mapId/:z/:x/:y
 * Cache:  data/tile_mirror/<mapId>/<z>/<x>/<y>   (gitignored, outside
 *         the web root — same rule as the FAO river tiles)
 */
import { Hono } from "hono";
import { promises as fs } from "node:fs";
import path from "node:path";
import { safeFetch } from "../lib/ssrf";

export const tileMirrorRoute = new Hono();

const REPO = path.resolve(import.meta.dir, "../../..");
export const MIRROR_CACHE_DIR =
  process.env.XYZO_TILE_MIRROR_CACHE ?? path.join(REPO, "data", "tile_mirror");

const DAY = 24 * 60 * 60 * 1000;
/** How long a copy may be served without asking the origin again. */
const DEFAULT_TTL_MS = DAY;
/** Nothing is kept longer than this, whatever its TTL says. */
const MAX_AGE_MS = 45 * DAY;
/** …and the whole tree is capped, oldest-first, so it stays a cache. */
const MAX_CACHE_BYTES = 3 * 1024 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_TILE_BYTES = 8 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Browser-side window. The server is the freshness authority; this only
 *  stops the browser re-asking us for the same tile every pan. */
const BROWSER_MAX_AGE_S = 3600;

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const FAO_WMTS = "https://data.apps.fao.org/map/wmts/wmts";

type Upstream = (z: number, x: number, y: number) => string;

interface Mirror {
  /** What it is, for the X-Tile-Mirror label and for the operator. */
  label: string;
  up: Upstream;
  /** Freshness window — after this the origin is asked to revalidate. */
  ttlMs: number;
  maxZoom: number;
}

/**
 * THE WHITELIST. Adding a source means adding a row here, never a
 * parameter the client can fill in.
 *
 * TTLs are per source on purpose: Esri's imagery and the street maps
 * rotate continuously, Macrostrat's geology has not changed in a
 * hundred million years, and WorldPop ships a new release a year.
 */
const MIRRORS: Record<string, Mirror> = {
  // ── Esri (six services). NOTE THE ORDER: Esri's path is z/y/x, not
  //    z/x/y. The swap happens HERE so every caller can use the ordinary
  //    XYZ shape, and no client has to remember one source's quirk.
  "esri-imagery": {
    label: "Esri World Imagery",
    ttlMs: DEFAULT_TTL_MS,
    maxZoom: 19,
    up: (z, x, y) => `${ESRI}/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  },
  "esri-street": {
    label: "Esri World Street Map",
    ttlMs: DEFAULT_TTL_MS,
    maxZoom: 19,
    up: (z, x, y) => `${ESRI}/World_Street_Map/MapServer/tile/${z}/${y}/${x}`,
  },
  "esri-dark": {
    label: "Esri World Dark Gray",
    ttlMs: 7 * DAY,
    maxZoom: 16,
    up: (z, x, y) => `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
  },
  "esri-light": {
    label: "Esri World Light Gray",
    ttlMs: 7 * DAY,
    maxZoom: 16,
    up: (z, x, y) => `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
  },
  "esri-natgeo": {
    label: "Esri NatGeo World Map",
    ttlMs: 7 * DAY,
    maxZoom: 12,
    up: (z, x, y) => `${ESRI}/NatGeo_World_Map/MapServer/tile/${z}/${y}/${x}`,
  },
  "esri-terrain": {
    label: "Esri World Terrain",
    ttlMs: 7 * DAY,
    maxZoom: 13,
    up: (z, x, y) => `${ESRI}/World_Terrain_Base/MapServer/tile/${z}/${y}/${x}`,
  },

  // ── open sources ───────────────────────────────────────────────────
  osm: {
    label: "OpenStreetMap",
    ttlMs: DEFAULT_TTL_MS,
    maxZoom: 19,
    up: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  },
  // One fixed subdomain rather than {s}: we are the one asking now, and
  // a single well-behaved origin is easier on them than three.
  opentopo: {
    label: "OpenTopoMap",
    ttlMs: 2 * DAY,
    maxZoom: 17,
    up: (z, x, y) => `https://a.tile.opentopomap.org/${z}/${x}/${y}.png`,
  },
  macrostrat: {
    label: "Macrostrat geology (CC BY 4.0)",
    ttlMs: 30 * DAY,
    maxZoom: 14,
    up: (z, x, y) => `https://tiles.macrostrat.org/carto/${z}/${x}/${y}.png`,
  },

  // ── FAO WMTS (the query is fixed per row; only the tile indices move)
  worldpop: {
    label: "FAO/WorldPop population (CC BY 4.0)",
    ttlMs: 7 * DAY,
    maxZoom: 13,
    up: (z, x, y) =>
      `${FAO_WMTS}?layer=fao-gismgr/WPOP/mapsets/WPOP-GLOBAL2-D` +
      "&tilematrixset=WebMercatorQuad" +
      "&Service=WMTS&request=GetTile&Version=1.0.0" +
      "&Format=image/png&style=default" +
      `&TileMatrix=${z}&TileCol=${x}&TileRow=${y}&layertype=Image`,
  },
  hwsd: {
    label: "FAO/IIASA HWSD soil type (CC BY 4.0)",
    ttlMs: 7 * DAY,
    maxZoom: 13,
    up: (z, x, y) =>
      `${FAO_WMTS}?layer=fao-gismgr/GAEZ-V5/maps/HWSDV22` +
      "&tilematrixset=WebMercatorQuad" +
      "&Service=WMTS&request=GetTile&Version=1.0.0" +
      "&Format=image/png&style=default" +
      `&TileMatrix=${z}&TileCol=${x}&TileRow=${y}&layertype=Image`,
  },
};

/** Exported so the tests and the docs can list what is mirrored without
 *  keeping a second copy of this table. */
export function mirrorIds(): string[] {
  return Object.keys(MIRRORS);
}

/** The table without its functions — enough for a test to prove every
 *  source is actually specified (a label, a TTL and a ceiling). */
export function mirrorSources(): { id: string; label: string; ttlMs: number; maxZoom: number }[] {
  return Object.entries(MIRRORS).map(([id, m]) => ({
    id,
    label: m.label,
    ttlMs: m.ttlMs,
    maxZoom: m.maxZoom,
  }));
}

/** How long a copy may live at all. Exported because the invariant
 *  `MAX_AGE_MS > every TTL` is what makes revalidation reachable: a
 *  source whose TTL outlived the eviction window would be deleted before
 *  anyone ever asked the origin whether it had changed. */
export const MIRROR_MAX_AGE_MS = MAX_AGE_MS;

/** The upstream URL a source would ask for a tile. Exported for the
 *  tests, which are what prove every host this file will ever talk to is
 *  a host we put here on purpose — the whitelist is the SSRF story, and
 *  a whitelist nobody checks is a wish. */
export function mirrorUpstream(id: string, z: number, x: number, y: number): string | null {
  const m = MIRRORS[id];
  return m ? m.up(z, x, y) : null;
}

// 1×1 transparent PNG — the house answer to a tile that does not exist.
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function placeholder(reason: string) {
  return new Response(new Uint8Array(PLACEHOLDER_PNG), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      // Short, on purpose: a placeholder is a real (empty) answer, and
      // pinning it for a year is how a missing tile became permanent.
      "Cache-Control": "public, max-age=300",
      "X-Tile-Mirror": `placeholder; ${reason}`,
    },
  });
}

/** Only an image body may become a tile. Everything else — a JSON error,
 *  an HTML maintenance page, a 200 with nothing in it — is a failure. */
function isImageContentType(ct: string | null): boolean {
  if (!ct) return false;
  const t = ct.toLowerCase().split(";")[0].trim();
  return t.startsWith("image/") || t === "application/vnd.mapbox-vector-tile";
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};
/** Tried in order on a cache hit; a source is consistent about the type
 *  it returns, so this settles after the first fetch. */
const READ_CANDIDATES = ["png", "jpg", "webp", "gif", "avif"];

function tilePath(mapId: string, z: number, x: number, y: number, ext: string) {
  return path.join(MIRROR_CACHE_DIR, mapId, String(z), String(x), `${y}.${ext}`);
}

async function readCached(
  mapId: string,
  z: number,
  x: number,
  y: number,
): Promise<{ body: Buffer; ext: string; mtimeMs: number } | null> {
  for (const ext of READ_CANDIDATES) {
    const p = tilePath(mapId, z, x, y, ext);
    try {
      const st = await fs.stat(p);
      if (!st.isFile()) continue;
      return { body: await fs.readFile(p), ext, mtimeMs: st.mtimeMs };
    } catch {
      /* try the next extension */
    }
  }
  return null;
}

async function writeCached(mapId: string, z: number, x: number, y: number, body: Buffer, type: string) {
  const ext = EXT_BY_TYPE[type.toLowerCase().split(";")[0].trim()] ?? "png";
  const p = tilePath(mapId, z, x, y, ext);
  await fs.mkdir(path.dirname(p), { recursive: true });
  // Write to a temp name and rename: a reader must never see half a
  // tile, and a crash mid-write must not leave a truncated file that
  // looks cached.
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, p);
}

// ── sweep: keep it a cache, not an archive ────────────────────────────
let sweeping = false;
async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = Date.now();
    const seen: { p: string; mtime: number; size: number }[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(p);
        } else if (e.isFile()) {
          const st = await fs.stat(p).catch(() => null);
          if (!st) continue;
          if (now - st.mtimeMs > MAX_AGE_MS) {
            await fs.unlink(p).catch(() => {});
          } else {
            seen.push({ p, mtime: st.mtimeMs, size: st.size });
          }
        }
      }
    };
    await walk(MIRROR_CACHE_DIR);
    let total = seen.reduce((a, b) => a + b.size, 0);
    if (total > MAX_CACHE_BYTES) {
      // Oldest first — the tile nobody has asked for in the longest time
      // is the one worth dropping.
      seen.sort((a, b) => a.mtime - b.mtime);
      for (const f of seen) {
        if (total <= MAX_CACHE_BYTES) break;
        await fs.unlink(f.p).catch(() => {});
        total -= f.size;
      }
    }
  } finally {
    sweeping = false;
  }
}
setInterval(() => void sweep(), SWEEP_INTERVAL_MS).unref?.();
void sweep();

// ── a small per-IP limiter ────────────────────────────────────────────
// Tiles are our bandwidth, and an origin that answers slowly is one an
// abusive client can make us pay for twice (once to fetch, once to hold
// the connection). Generous enough for a real reader's viewport.
const buckets = new Map<string, { n: number; at: number }>();
// A per-IP limit on UPSTREAM fetches only (cache hits are checked
// above and never reach this). One view of a 15-overlay link is ~184
// mirrored tiles and a minute of panning produced 500, so the old 600
// was below a single reader's real appetite and punched holes in the
// basemap. 3000/min still bounds an abusive client while sitting far
// above anything a person does.
const RATE_LIMIT = 3000;
const RATE_WINDOW_MS = 60_000;
function rateOk(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now - b.at > RATE_WINDOW_MS) {
    buckets.set(ip, { n: 1, at: now });
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now - v.at > RATE_WINDOW_MS) buckets.delete(k);
    }
    return true;
  }
  b.n++;
  return b.n <= RATE_LIMIT;
}

function badRequest(why: string) {
  return new Response(JSON.stringify({ error: "bad_tile_request", detail: why }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

tileMirrorRoute.get("/tile/mirror/:mapId/:z/:x/:y", async (c) => {
  const mapId = c.req.param("mapId");
  const mirror = MIRRORS[mapId];
  if (!mirror) {
    return new Response(JSON.stringify({ error: "unknown_mirror", id: mapId }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const z = Number(c.req.param("z"));
  const x = Number(c.req.param("x"));
  const y = Number(c.req.param("y"));
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return badRequest("z/x/y must be integers");
  }
  if (z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    return badRequest(`out of range for z=${z}`);
  }
  if (z > mirror.maxZoom) {
    // Past the source's own ceiling the origin would 404 — and a 404 on
    // an <img> is a console error, so answer the placeholder instead.
    return placeholder(`beyond maxZoom ${mirror.maxZoom}`);
  }

  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  const cached = await readCached(mapId, z, x, y);
  const now = Date.now();
  const fresh = cached && now - cached.mtimeMs < mirror.ttlMs;

  if (fresh && cached) {
    // A cache hit is a DISK READ: it costs nothing and reaches no
    // origin, so it is never rate limited. That matters — one view of
    // the owner's 15-overlay link is ~184 mirrored tiles, and panning
    // produced 500 in a minute. Throttling the cheap path is what
    // punched 24 holes straight through the basemap (measured: 8 pans,
    // 24 × 429, 24 broken tiles, "the map doesn't show").
    return new Response(new Uint8Array(cached.body), {
      headers: {
        "Content-Type": typeForExt(cached.ext),
        "Cache-Control": `public, max-age=${BROWSER_MAX_AGE_S}`,
        "X-Tile-Mirror": `hit; age=${Math.round((now - cached.mtimeMs) / 1000)}s`,
        "X-Tile-Mirror-Upstream": mirror.label,
      },
    });
  }

  // Only a REAL upstream fetch is rate limited — that is the thing worth
  // protecting (the origin's patience and our bandwidth on a cold tile).
  if (!rateOk(ip)) {
    // Never answer a tile request with an error body: a 429 JSON is a
    // broken <img>, which the browser logs and Leaflet never retries,
    // so the hole stays until the reader happens to pan again. Serve the
    // last good copy if we have one, otherwise the placeholder.
    if (cached) {
      return new Response(new Uint8Array(cached.body), {
        headers: {
          "Content-Type": typeForExt(cached.ext),
          "Cache-Control": "public, max-age=60",
          "X-Tile-Mirror": "rate_limited; serving cached",
          "X-Tile-Mirror-Upstream": mirror.label,
        },
      });
    }
    return placeholder("rate_limited");
  }

  // Past the TTL (or a miss): ask the origin, conditionally.
  const url = mirror.up(z, x, y);
  const headers: Record<string, string> = {
    // Several of these publishers 403 a default agent — FAO did exactly
    // that to `Python-urllib/3.11` (Q-N2).
    "User-Agent": "xyzo-tile-mirror/1.0 (+https://xyzo.org)",
    Accept: "image/*,*/*;q=0.8",
  };
  if (cached) headers["If-Modified-Since"] = new Date(cached.mtimeMs).toUTCString();

  let res: Response;
  try {
    res = (await safeFetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })).res;
  } catch (err) {
    // The origin is down or slow. Availability beats freshness: the last
    // good picture beats a hole, and the next request tries again.
    if (cached) {
      return new Response(new Uint8Array(cached.body), {
        headers: {
          "Content-Type": typeForExt(cached.ext),
          "Cache-Control": "public, max-age=300",
          "X-Tile-Mirror": "stale; upstream_error",
          "X-Tile-Mirror-Upstream": mirror.label,
        },
      });
    }
    return placeholder(`upstream_error; ${String(err).slice(0, 80)}`);
  }

  if (res.status === 304 && cached) {
    // Unchanged: refresh the clock so we ask again in another TTL, and
    // do not rewrite the bytes we already have.
    const p = tilePath(mapId, z, x, y, cached.ext);
    await fs.utimes(p, new Date(), new Date()).catch(() => {});
    return new Response(new Uint8Array(cached.body), {
      headers: {
        "Content-Type": typeForExt(cached.ext),
        "Cache-Control": `public, max-age=${BROWSER_MAX_AGE_S}`,
        "X-Tile-Mirror": "revalidated; 304",
        "X-Tile-Mirror-Upstream": mirror.label,
      },
    });
  }

  if (res.status === 404) {
    return placeholder("upstream_404");
  }

  if (!res.ok) {
    if (cached) {
      return new Response(new Uint8Array(cached.body), {
        headers: {
          "Content-Type": typeForExt(cached.ext),
          "Cache-Control": "public, max-age=300",
          "X-Tile-Mirror": `stale; upstream_${res.status}`,
          "X-Tile-Mirror-Upstream": mirror.label,
        },
      });
    }
    return placeholder(`upstream_${res.status}`);
  }

  const type = res.headers.get("content-type");
  if (!isImageContentType(type)) {
    // A 200 that is not an image — an error document, a maintenance
    // page. Caching it would paint that over the map for a month.
    if (cached) {
      return new Response(new Uint8Array(cached.body), {
        headers: {
          "Content-Type": typeForExt(cached.ext),
          "Cache-Control": "public, max-age=300",
          "X-Tile-Mirror": "stale; upstream_not_image",
          "X-Tile-Mirror-Upstream": mirror.label,
        },
      });
    }
    return placeholder("upstream_not_image");
  }

  let body: Buffer;
  try {
    body = Buffer.from(await res.arrayBuffer());
  } catch {
    return cached
      ? placeholder("upstream_read_error")
      : placeholder("upstream_read_error");
  }
  if (body.length === 0) return placeholder("upstream_empty");
  if (body.length > MAX_TILE_BYTES) return placeholder("upstream_too_large");

  await writeCached(mapId, z, x, y, body, type ?? "image/png");

  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": type ?? "image/png",
      "Cache-Control": `public, max-age=${BROWSER_MAX_AGE_S}`,
      "X-Tile-Mirror": cached ? "refreshed; 200" : "miss",
      "X-Tile-Mirror-Upstream": mirror.label,
    },
  });
});

function typeForExt(ext: string): string {
  switch (ext) {
    case "jpg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    default:
      return "image/png";
  }
}
