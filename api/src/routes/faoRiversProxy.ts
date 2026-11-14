// /api/tile/fao-rivers — a caching proxy for the FAO's 2026 river network.
//
// WHY THIS EXISTS
// ---------------
// "🌊 Rivers (FAO 2026)" draws the real global river network — every
// reach on Earth with a catchment of 10 km² or an average flow of
// 0.1 m³/s, more than a million reaches. The LINES are the publisher's
// own WMS (`data.apps.fao.org`), because the network is far too large to
// ship as data: a 10° box of it is 28 MB of GeoJSON and the world is
// roughly 700 MB.
//
// That WMS is SLOW, and the cost is not the picture:
//
//   zoom 1   48.4 s      zoom 5    2.0 s
//   zoom 2   24.7 s      zoom 8    2.0 s
//   zoom 3    2.6 s      zoom 12   2.0 s
//
// A tile costs ~2 s whatever the zoom (the query and the set-up, not
// the rasterising) and a whole-world tile costs 25-48 s. Measured on a
// reader's own URL: 36 tiles for one screen, still streaming at 64 s.
//
// THE THREE THINGS THIS ROUTE DOES
// --------------------------------
// 1. **THE URL IS BUILT HERE, NEVER TAKEN FROM THE CALLER.** The level
//    is a whitelist key and the SLD comes from the PUBLISHED metadata, so
//    the upstream URL is assembled from values we control — there is no
//    `?url=` parameter and therefore no SSRF surface at all.
//
// 2. **THE SLD DOES NOT RIDE IN THE CLIENT'S URL.** It is 4.3 KB, and it
//    was in every tile request the browser made (a 4.6 KB request line
//    per tile). Here it is read once from the published meta.json and
//    attached server-side.
//
// 3. **THE TILE IS CACHED ON DISK.** The in-memory cache the NASA tile
//    proxy uses dies with the process and is per-instance. This one is
//    on disk, so the SECOND reader of a view is a local file and not a
//    two-second round trip to a busy public server — which is the whole
//    point: the first reader pays once, everybody after is instant.
//
// The cache is written under the repo's own data/ directory (gitignored,
// and outside the web root), so it survives a restart of the API.
//
// ─────────────────────────────────────────────────────────────────────
// THE PLACEHOLDER
//
// A tile the publisher cannot produce answers HTTP 200 with a 1×1
// transparent PNG. A missing tile is not an error, and it must not make
// a noise in the reader's console.

import { Hono } from "hono";
import { promises as fs } from "node:fs";
import path from "node:path";

export const faoRiversProxyRoute = new Hono();

// ── the publisher ──────────────────────────────────────────────────────
const WMS_URL = "https://data.apps.fao.org/map/gsrv/gsrv1/aquamaps/wms";
const WMS_LAYER = "river_network";
const WMS_VERSION = "1.1.1";     // 1.3.0 + EPSG:4326 renders ANTARCTICA
const TILE_PX = 512;              // 512 px tiles: half the requests, same picture
const MAX_TILE_BYTES = 8 * 1024 * 1024;

// The published metadata — ONE source of truth for the class table, the
// SLD and the level filters. The map, the legend and the export read it
// too, so the proxy cannot draw a different cartography from the one the
// reader sees.
const REPO = path.resolve(import.meta.dir, "../../..");
const META_PATH = path.join(REPO, "public_html", "data", "rivers", "fao", "meta.json");
// The cache directory can be pointed elsewhere (a test uses a temporary
// one) — it is a build artefact, not part of the service.
const CACHE_DIR = process.env.XYZO_RIVERS_TILE_CACHE
  || path.join(REPO, "data", "fao_rivers_tiles");

interface Level { id: string; filter: string | null; min_cms: number; label: string }
interface Meta { levels: Level[]; sld: { body: string }; published?: string; edition?: string }

let metaCache: Meta | null = null;
let metaAt = 0;
const META_TTL_MS = 60 * 60 * 1000;

async function loadMeta(): Promise<Meta | null> {
  if (metaCache && Date.now() - metaAt < META_TTL_MS) return metaCache;
  try {
    const raw = await fs.readFile(META_PATH, "utf8");
    const meta = JSON.parse(raw) as Meta;
    if (!meta?.levels?.length || !meta?.sld?.body) return null;
    metaCache = meta;
    metaAt = Date.now();
    return meta;
  } catch {
    return null;
  }
}

// The EDITION of the network. The 2026 edition is a published edition, so
// a tile for it never changes — and the cache key carries the edition, so
// a new edition is a new picture and not a stale one.
function editionOf(meta: Meta | null): string {
  return meta?.edition || meta?.published || "unknown";
}

// ── the placeholder ────────────────────────────────────────────────────
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function placeholder(reason: string) {
  return new Response(PLACEHOLDER_PNG, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
      "X-Proxy-Placeholder": "1",
      "X-Proxy-Reason": reason,
    },
  });
}

// ── the disk cache ─────────────────────────────────────────────────────
//
// A tile for a given (level, z, y, x) never changes — the 2026 edition
// is a published edition — so it is written once and read forever. The
// key includes the level because the detail level is a different picture.
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cachePath(level: string, edition: string, z: number, y: number, x: number) {
  return path.join(CACHE_DIR, edition, level, String(z), String(y), `${x}.png`);
}

async function readCache(file: string): Promise<Buffer | null> {
  try {
    const st = await fs.stat(file);
    if (Date.now() - st.mtimeMs > CACHE_MAX_AGE_MS) return null;
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

async function writeCache(file: string, body: Buffer) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write to a temporary name and rename, so a reader never sees a
    // half-written file.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, file);
  } catch {
    /* a cache that cannot be written is a slow cache, not a broken one */
  }
}

// ── the expiry sweeper ────────────────────────────────────────────────
//
// A tile for a given (level, z, y, x) never changes, so the cache is
// written once and read forever — but "forever" has to mean something on
// a disk. **Nothing deleted the expired entries**: `readCache()` simply
// ignored them, so the directory grew without bound (a z5 screen is ~35
// tiles, ~5 MB, and every new area a reader visits added to it). On a
// site with real traffic that is a slow disk-full.
//
// So the expired files are actually REMOVED, and removed only once they
// are past their age — the same age `readCache()` honours, so the
// sweeper can never take a tile that would still have been served.
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

async function sweepExpired(): Promise<void> {
  if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = Date.now();
  const now = Date.now();
  let removed = 0;
  async function walk(dir: string) {
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
        continue;
      }
      if (!e.name.endsWith(".png")) continue;
      try {
        const st = await fs.stat(p);
        if (now - st.mtimeMs > CACHE_MAX_AGE_MS) {
          await fs.unlink(p);
          removed++;
        }
      } catch {
        /* somebody else got there first */
      }
    }
  }
  await walk(CACHE_DIR);
  if (removed) {
    console.log(`[fao-rivers] swept ${removed} expired tiles from the disk cache`);
  }
}

// ── the upstream URL ───────────────────────────────────────────────────
//
// Assembled HERE, from the level's own filter and the published SLD.
//
// **THE BBOX MUST BE IN WEB MERCATOR (EPSG:3857), NOT IN LAT/LON.**
// The slippy tile grid is a Mercator grid, and Leaflet places a tile by
// its Mercator square. Asking GeoServer for the same lon/lat extent with
// `SRS=EPSG:4326` gets back a PLATE CARRÉE image — the same rivers,
// drawn on a latitude-linear axis — and Leaflet then stretches that over
// a Mercator square. **Measured at z2, the two are visibly different:
// North America squashed to the top of the tile, Africa pushed down.**
// At z4 over the equator the error is under a percent and looks fine,
// which is exactly why it survived the first audit; at z2 and at high
// latitudes it is metres of misregistration. The fix is one line — send
// the bbox in the same CRS the grid is in.
const R = 20037508.34;   // the Web Mercator half-circumference

function upstreamUrl(meta: Meta, level: Level, z: number, y: number, x: number): string {
  const n = 2 ** z;
  // The tile's Mercator square: x from the west, y from the north.
  const bx = (x / n) * 2 * R - R;
  const bx1 = ((x + 1) / n) * 2 * R - R;
  const by = R - ((y + 1) / n) * 2 * R;
  const by1 = R - (y / n) * 2 * R;
  const bbox = `${bx},${by},${bx1},${by1}`;
  const p = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: WMS_VERSION,
    REQUEST: "GetMap",
    LAYERS: WMS_LAYER,
    STYLES: "",
    BBOX: bbox,
    WIDTH: String(TILE_PX),
    HEIGHT: String(TILE_PX),
    SRS: "EPSG:3857",
    FORMAT: "image/png",
    TRANSPARENT: "true",
    sld_body: meta.sld.body,
  });
  if (level.filter) p.set("CQL_FILTER", level.filter);
  return `${WMS_URL}?${p.toString()}`;
}

// ── rate limiting ──────────────────────────────────────────────────────
//
// The proxy is an open relay for somebody else's bandwidth if it is not
// bounded. The limit is generous — a pan asks for a burst of tiles — but
// it is a limit.
const buckets = new Map<string, number[]>();
const RATE_LIMIT = 400;
const RATE_WINDOW_MS = 60 * 1000;

function rateOk(ip: string): boolean {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket) { bucket = []; buckets.set(ip, bucket); }
  const cutoff = now - RATE_WINDOW_MS;
  while (bucket.length > 0 && bucket[0] < cutoff) bucket.shift();
  if (bucket.length >= RATE_LIMIT) return false;
  bucket.push(now);
  return true;
}

// ── validation ─────────────────────────────────────────────────────────
function intOrNull(v: string | undefined): number | null {
  if (v == null || !/^\d{1,6}$/.test(v)) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

// ── the route ──────────────────────────────────────────────────────────
faoRiversProxyRoute.get("/tile/fao-rivers/:level/:z/:y/:x", async (c) => {
  const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
  if (!rateOk(ip)) return placeholder("rate_limited");

  const levelId = c.req.param("level");
  const z = intOrNull(c.req.param("z"));
  const y = intOrNull(c.req.param("y"));
  const x = intOrNull(c.req.param("x"));

  const meta = await loadMeta();
  if (!meta) return placeholder("no_metadata");
  const level = meta.levels.find((l) => l.id === levelId);
  if (!level) return c.json({ error: "unknown_level" }, 400);
  if (z === null || y === null || x === null) return c.json({ error: "bad_tile" }, 400);
  if (z < 0 || z > 15) return c.json({ error: "bad_zoom" }, 400);
  const span = 1 << z;
  if (x < 0 || y < 0 || x >= span || y >= span) return c.json({ error: "bad_tile" }, 400);

  // ── the disk cache first ────────────────────────────────────────────
  // The sweeper runs at most once an hour and only removes tiles that
  // are past the same age `readCache()` honours.
  void sweepExpired();
  const file = cachePath(level.id, editionOf(meta), z, y, x);
  const cached = await readCache(file);
  if (cached && cached.byteLength > 0) {
    return new Response(cached, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=604800",
        "Access-Control-Allow-Origin": "*",
        "X-Proxy-Cache": "HIT",
      },
    });
  }

  // ── the publisher ───────────────────────────────────────────────────
  try {
    const res = await fetch(upstreamUrl(meta, level, z, y, x), {
      headers: { "User-Agent": "xyzo-rivers-proxy/1.0 (+https://xyzo.org)" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return placeholder(`upstream_${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) return placeholder("empty");
    if (buf.byteLength > MAX_TILE_BYTES) return placeholder("too_big");
    // A tile is a PNG; anything else is an upstream error page and must
    // not be cached as a picture.
    if (buf[0] !== 0x89 || buf[1] !== 0x50) return placeholder("not_a_png");
    await writeCache(file, buf);
    return new Response(buf, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=604800",
        "Access-Control-Allow-Origin": "*",
        "X-Proxy-Cache": "MISS",
      },
    });
  } catch {
    // The publisher is unreachable or slow. The map still draws — with a
    // blank tile where the river was — and the console stays clean.
    return placeholder("unreachable");
  }
});
