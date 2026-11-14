// /api/tile — a TILE proxy for NASA's GIBS weather overlays.
//
// WHY THIS EXISTS
// ---------------
// The NASA overlays (the rain rate, the true-colour satellite, the
// night lights) are WMTS tile layers served straight from
// gibs.earthdata.nasa.gov. GIBS publishes a tile only where the
// product has a value — the IMERG rain product has no tile over the
// open ocean and none over the poles — and it answers **HTTP 404**
// for the rest.
//
// A 404 on a tile is a 404 on an <img>, and the browser logs it: the
// reader's console fills with red lines that say nothing useful. The
// tile is not "broken"; the product simply has nothing to draw there.
// There is no way to suppress a browser-generated network message from
// JavaScript.
//
// So the tiles come through HERE. The proxy keeps the same rule the
// image proxy already uses: **a missing tile answers HTTP 200 with a
// 1x1 transparent PNG.** The browser loads it happily, the tile paints
// nothing, and the console stays clean.
//
// It is also CACHED: a tile for a given date never changes, so the
// second reader of the same view costs nothing.
//
// ─────────────────────────────────────────────────────────────────────
// THE DATE IS RESOLVED HERE, NOT ASSUMED
//
// "Yesterday" is NOT the same thing as "the most recent published
// product". GIBS publishes the true-colour satellite a day or two
// behind the date, so the client asking for "yesterday" got a whole
// layer of 404s — the overlay silently drew NOTHING while the layer
// control said it was on.
//
// So the proxy PROBES: it asks GIBS for a canary tile (a fixed tile
// over central Africa, which every one of these products covers) and
// walks the date back until one answers 200. The date it finds is
// remembered for an hour, and every tile of that dataset then comes
// from it — so the layer is one consistent picture, not a seam of
// three different days.
//
// A date that is OLD (the night lights are pinned to 2016-01-01) is
// served as asked: the walk-back is only for the recent products.
//
// ─────────────────────────────────────────────────────────────────────
// THE URL IS BUILT HERE, NEVER TAKEN FROM THE CALLER
//
// There is no `?url=` parameter. The dataset, the date, the zoom and
// the tile coordinates are path segments, and the upstream URL is
// assembled from a WHITELIST — so this route has no SSRF surface at
// all, and there is nothing for a caller to point at an internal host.

import { Hono } from "hono";
import { safeFetch } from "../lib/ssrf";

export const tileProxyRoute = new Hono();

// ── The datasets ──────────────────────────────────────────────────────
//
// Each one is a GIBS layer, a tile-matrix set, the zoom range the
// matrix exists at and the file extension GIBS serves it with — the
// extension is NOT a detail: the true-colour satellite is JPEG and the
// night lights are PNG, and asking for the wrong one is a 404.
//
// The zoom range is not a suggestion either: GIBS answers HTTP 400
// for a level that does not exist in that matrix ("Level6 supports
// zoom 0..6 — asking for 7+ returns HTTP 400"), and a 400 is a
// console error too.
interface Dataset {
  layer: string;
  matrix: string;
  ext: string;
  minZoom: number;
  maxZoom: number;
  contentType: string;
  /** Walk the date back to find a published one? False for a pinned
   *  historical date, where "the most recent" is meaningless. */
  recent: boolean;
}

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";

const DATASETS: Record<string, Dataset> = {
  rain: {
    layer: "IMERG_Precipitation_Rate",
    matrix: "GoogleMapsCompatible_Level6",
    ext: "png",
    minZoom: 1,
    maxZoom: 6,
    contentType: "image/png",
    recent: true,
  },
  satellite: {
    layer: "VIIRS_SNPP_CorrectedReflectance_TrueColor",
    matrix: "GoogleMapsCompatible_Level9",
    ext: "jpeg",
    minZoom: 1,
    maxZoom: 9,
    contentType: "image/jpeg",
    recent: true,
  },
  night: {
    layer: "VIIRS_Black_Marble",
    matrix: "GoogleMapsCompatible_Level8",
    ext: "png",
    minZoom: 1,
    maxZoom: 8,
    contentType: "image/png",
    recent: false,
  },
};

/** The canary: a fixed tile over central Africa that every one of
 *  these products covers. It is what tells the proxy whether a DATE
 *  is published. */
const CANARY = { z: 4, x: 8, y: 6 };

// ── the PLACEHOLDER ───────────────────────────────────────────────────
//
// The same 1x1 transparent PNG the image proxy uses. A tile that does
// not exist must not make a NOISE.
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function placeholder() {
  return new Response(PLACEHOLDER_PNG, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
      "X-Proxy-Placeholder": "1",
    },
  });
}

// ── the cache ─────────────────────────────────────────────────────────
//
// A tile for a given (dataset, date, z, x, y) never changes, so it is
// cached for an hour. The cap keeps the map's memory bounded: a
// screenful is ~20 tiles, and a busy minute is a few hundred.
const cache = new Map<string, { body: ArrayBuffer; contentType: string; at: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE = 600;

function getCached(key: string): { body: ArrayBuffer; contentType: string } | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return e;
}

function setCached(key: string, body: ArrayBuffer, contentType: string) {
  if (cache.size >= MAX_CACHE) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of cache) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { body, contentType, at: Date.now() });
}

// ── the RESOLVED DATE, per dataset ───────────────────────────────────
//
// Remembered for an hour, so the canary is asked once per dataset per
// hour rather than once per tile.
const resolved = new Map<string, { date: string; at: number }>();
const RESOLVED_TTL_MS = 60 * 60 * 1000;

function shiftDate(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() + "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0");
}

function tileUrl(ds: Dataset, date: string, z: number, y: number, x: number): string {
  return `${GIBS}/${ds.layer}/default/${date}/${ds.matrix}/${z}/${y}/${x}.${ds.ext}`;
}

/**
 * GIBS IS FLAKY.
 *
 * The same tile URL answers 404 on one request and 200 on the next:
 * measured on 2026-11-04, four identical requests for the same IMERG
 * tile gave 404, 200, 200, 404. GIBS sits behind a CDN with more than
 * one origin, and some of them have not caught up with a republished
 * product.
 *
 * So a 404 is retried before it is believed — otherwise a tile that
 * DOES exist is served blank, and the date probe walks back a day for
 * no reason (which would put the whole layer a day out of date).
 */
async function fetchTile(
  ds: Dataset, date: string, z: number, y: number, x: number, attempts = 4,
) {
  let res: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = await safeFetch(tileUrl(ds, date, z, y, x), {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; xyzo.org tile proxy)",
          "Accept": "image/png,image/jpeg,image/*;q=0.8",
        },
        signal: AbortSignal.timeout(8_000),
      });
      res = out.res;
    } catch {
      res = null;
    }
    // A 200 is the answer. A 404 may be the flaky CDN, so it is
    // retried; a 400 is a request we got wrong and will not fix
    // itself.
    if (res && (res.ok || res.status === 400)) return res;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  return res;
}

/**
 * The most recent PUBLISHED date for a dataset.
 *
 * Asked for once an hour per dataset. The requested date is tried
 * first (so a client that knows better is believed), then the days
 * before it, up to a fortnight.
 *
 * The probe is SHARED: a screenful of tiles arrives together, and
 * without this every one of them would ask GIBS the same question
 * twenty times over.
 */
const inflight = new Map<string, Promise<string>>();

function resolveDate(dataset: string, ds: Dataset, requested: string): Promise<string> {
  const hit = resolved.get(dataset);
  if (hit && Date.now() - hit.at < RESOLVED_TTL_MS && hit.date >= requested) {
    return Promise.resolve(hit.date);
  }

  // A pinned historical date is served as asked.
  if (!ds.recent) return Promise.resolve(requested);

  // The walk-back only makes sense for a RECENT request — a date more
  // than a fortnight old is a deliberate choice, not a lag.
  if (daysBetween(requested, today()) > 14) return Promise.resolve(requested);

  const pending = inflight.get(dataset);
  if (pending) return pending;

  const p = (async () => {
    for (let i = 0; i <= 14; i++) {
      const candidate = i === 0 ? requested : shiftDate(requested, -i);
      try {
        const res = await fetchTile(ds, candidate, CANARY.z, CANARY.y, CANARY.x, 3);
        if (res && res.ok) {
          resolved.set(dataset, { date: candidate, at: Date.now() });
          return candidate;
        }
      } catch {
        // GIBS is having a moment — stop the walk and use what we have.
        break;
      }
    }
    resolved.set(dataset, { date: requested, at: Date.now() });
    return requested;
  })().finally(() => {
    inflight.delete(dataset);
  });

  inflight.set(dataset, p);
  return p;
}

function today(): string {
  const now = new Date();
  return now.getUTCFullYear() + "-" +
    String(now.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(now.getUTCDate()).padStart(2, "0");
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86_400_000,
  );
}

// ── rate limiting ─────────────────────────────────────────────────────
//
// Tiles are fetched in bursts — a pan can ask for forty at once — so
// the limit is generous, but it is a limit: an unbounded tile proxy is
// an open relay for somebody else's bandwidth.
const buckets = new Map<string, number[]>();
const RATE_LIMIT = 400;
const RATE_WINDOW_MS = 60 * 1000;

function rateOk(ip: string): boolean {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = [];
    buckets.set(ip, bucket);
  }
  const cutoff = now - RATE_WINDOW_MS;
  while (bucket.length > 0 && bucket[0] < cutoff) bucket.shift();
  if (bucket.length >= RATE_LIMIT) return false;
  bucket.push(now);
  return true;
}

// ── validation ────────────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function intOrNull(v: string | undefined): number | null {
  if (v == null) return null;
  if (!/^\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

// ── the route ─────────────────────────────────────────────────────────
tileProxyRoute.get("/tile/:dataset/:date/:z/:y/:x", async (c) => {
  const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
  if (!rateOk(ip)) {
    return new Response(PLACEHOLDER_PNG, {
      status: 200,
      headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Proxy-Placeholder": "1" },
    });
  }

  const dataset = c.req.param("dataset");
  const ds = DATASETS[dataset];
  const date = c.req.param("date");
  const z = intOrNull(c.req.param("z"));
  const y = intOrNull(c.req.param("y"));
  const x = intOrNull(c.req.param("x"));

  // A malformed request is a 400 — that is about the REQUEST, and the
  // reader can act on it. Only a MISSING TILE becomes a placeholder.
  if (!ds) return c.json({ error: "unknown_dataset" }, 400);
  if (!date || !DATE_RE.test(date)) return c.json({ error: "bad_date" }, 400);
  if (z === null || y === null || x === null) return c.json({ error: "bad_tile" }, 400);
  if (z < ds.minZoom || z > ds.maxZoom) return c.json({ error: "bad_zoom" }, 400);
  const span = 1 << z;
  if (x < 0 || y < 0 || x >= span || y >= span) return c.json({ error: "bad_tile" }, 400);

  let useDate = date;
  try {
    useDate = await resolveDate(dataset, ds, date);
  } catch {
    useDate = date;
  }

  const key = `${dataset}/${useDate}/${z}/${y}/${x}`;
  const cached = getCached(key);
  if (cached) {
    return new Response(cached.body, {
      headers: {
        "Content-Type": cached.contentType,
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
        "X-Proxy-Cache": "HIT",
        "X-Tile-Date": useDate,
      },
    });
  }

  try {
    const res = await fetchTile(ds, useDate, z, y, x, 3);
    if (!res || !res.ok) {
      // The product has no tile HERE — the open ocean, or the pole.
      // That is NOT an error, and it must not make a noise.
      return placeholder();
    }
    const body = await res.arrayBuffer();
    if (body.byteLength === 0) return placeholder();
    if (body.byteLength > 4 * 1024 * 1024) {
      // A tile is never this big; something upstream went wrong.
      return placeholder();
    }
    const contentType = res.headers.get("content-type") || ds.contentType;
    setCached(key, body, contentType);
    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
        "X-Tile-Date": useDate,
      },
    });
  } catch {
    // GIBS is unreachable. The map still draws — with a blank tile
    // where the rain would be — and the console stays clean.
    return placeholder();
  }
});
