import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { RateLimiter, getClientIp } from "../ratelimit";
import { createHash } from "node:crypto";
import { getDb } from "../db";

export const weatherRoute = new Hono();

// The map refetches the isobars for the viewport whenever the user pans
// into a region it has not loaded yet, so the allowance is generous — but
// it is still bounded.
const isobarLimiter = new RateLimiter({ max: 240, windowMs: 60 * 1000 });

// Exported so the limit's DEFAULT can be asserted against the measured
// whole-world line count — see the test. A limit that silently truncates
// is a chart with holes in it and no error anywhere.
export const IsobarsQuerySchema = z.object({
  // Length check only weeds out obvious junk — "0,0,1,1" is a perfectly
  // valid tightly-zoomed viewport, and the parts are validated below.
  bbox: z.string().min(5).max(120).optional(),
  levels: z.string().max(200).optional(),
  // Contour detail — show every Nth hPa. The worker publishes at
  // 0.05 hPa, the finest of these, so every step is a SUBSET of one
  // dataset rather than a second copy of it: the contour of a specific
  // level does not depend on the interval used to enumerate the levels,
  // so "1000" at step 4 is byte-identical to "1000" at step 1, and
  // thinning reproduces the classic 4 hPa synoptic chart exactly.
  // 4 is that classic chart and stays the default.
  //
  // Every offered step must be a whole multiple of the worker's
  // interval (0.05) or the chip silently thins to whatever DOES exist:
  // 0.1 is offered because 0.1 = 2 x 0.05, 0.25 = 5 x 0.05. Asking
  // for step=0.1 against a table cut at 0.25 returns only every 0.5 hPa
  // line while claiming 0.10 — that is the failure this guards.
  //
  // The finer set is the SAME chart with more lines in it — measured on
  // the 2026-11-06 18Z GFS analysis, the share of lines shorter than 20
  // degrees is 39.9 % at 0.25, 39.7 % at 0.1 and 39.7 % at 0.05. The
  // noise lives in the field, not in the level.
  step: z.enum(["0.1", "0.25", "0.5", "1", "2", "4", "8", "16"]).optional(),
  // A cap against a runaway, not a target: a response is only as large
  // as the rows that exist. It has to clear the FINEST step's whole-world
  // count or the LIMIT drops arbitrary rows and the chart shows holes —
  // measured 11,266 lines for the world at step=0.1 (113 hPa of field),
  // and a deeper analysis is wider than that. Was 12,000, which the
  // 0.10 chip clears by 6 %.
  limit: z.coerce.number().min(1).max(30000).default(30000),
  // Which analysis to draw. "auto" picks the newest one that covers the
  // viewport — see pickSource().
  source: z.enum(["auto", "ecmwf", "gfs", "hrrr"]).default("auto"),
});

// Levels for a requested detail step: every multiple of `step` across a
// generous pressure range. The dataset holds every multiple of the
// worker's interval (0.05 hPa) across the field's own range, so any step
// here selects a real subset — asking for a slightly wider range is
// harmless because an `IN` list simply does not match levels that do not
// exist, and it keeps this correct if the worker's range ever shifts.
const STEP_MIN_HPA = 940;
const STEP_MAX_HPA = 1060;
function stepLevels(step: number): number[] {
  // `step` can be fractional (0.1 / 0.25 / 0.5 hPa) and NOT every step
  // we offer is dyadic — 0.1 is not, so `k * step` carries
  // representation error (10001 * 0.1 is 1000.1000000000001). What makes
  // the list exact is the snap to TWO DECIMALS: enough for every step we
  // can offer, because 0.05 is the finest lattice we cut and nothing on
  // it needs more places than 0.05 has. So 1000.25 reaches Postgres as
  // 1000.25 and not as 1000.2499999999999, which would never match the
  // stored REAL — and 1000.1 is 1000.1, not 1000.1000000000001. The
  // worker snaps its own levels to the same two decimals (see
  // contour_isobars), so both ends of the IN list are the same decimal.
  //
  // (`STEP_MIN_HPA / step` is exact for every step on the ladder —
  // checked: 9400, 3760, 1880, 940, 470, 235, 117.5, 58.75 — so `ceil`
  // lands on the first real level; no fudge factor is needed here.)
  const first = Math.ceil(STEP_MIN_HPA / step);
  const out: number[] = [];
  for (let k = first; k * step <= STEP_MAX_HPA + step * 1e-9; k++) {
    out.push(Math.round(k * step * 100) / 100);
  }
  return out;
}

// The isobar sources, in the order they are described to the user.
//
//   ecmwf  ECMWF IFS open data, MSL pressure, 0.1° global. CC BY 4.0 —
//          commercial use permitted, no key, no login. The finer grid,
//          but it lands ~8.5 h after the run.
//   gfs    NOAA NCEP GFS PRMSL analysis, 0.25° global. US Government
//          work — public domain. The fresher analysis (~3.5 h).
//   hrrr   NOAA HRRR 3 km CONUS analysis. US Government work — public
//          domain. Hourly. Only covers North America, so it is only
//          used when the viewport sits inside its domain.
const ISOBAR_SOURCES = ["ecmwf", "gfs", "hrrr"] as const;
type IsobarSource = (typeof ISOBAR_SOURCES)[number];

const SOURCE_LABELS: Record<IsobarSource, string> = {
  ecmwf: "ECMWF IFS 0.1°",
  gfs: "NOAA GFS 0.25°",
  hrrr: "NOAA HRRR 3 km",
};

// The HRRR CONUS domain, as its four Lambert corners in lat/lon (from
// the GRIB header's projection block). It is a TRAPEZOID, not a box: the
// south edge is narrower than the north edge. A viewport is only served
// by HRRR when all of its corners sit inside this quad — otherwise the
// layer would show a patch of 3 km lines with a hard edge where the
// global analysis takes over.
const HRRR_DOMAIN_QUAD: Array<[number, number]> = [
  [-134.12, 47.85], // NW
  [-60.89, 47.85], // NE
  [-72.27, 21.12], // SE
  [-122.73, 21.12], // SW
];

function pointInQuad(lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = HRRR_DOMAIN_QUAD.length - 1; i < HRRR_DOMAIN_QUAD.length; j = i++) {
    const [xi, yi] = HRRR_DOMAIN_QUAD[i];
    const [xj, yj] = HRRR_DOMAIN_QUAD[j];
    const intersects =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function viewportInsideHrrr(
  envelopes: Array<[number, number, number, number]>,
): boolean {
  if (envelopes.length === 0) return false;
  for (const [minLng, minLat, maxLng, maxLat] of envelopes) {
    // Sample the four corners and the four edge midpoints: a viewport
    // can be inside the quad's bounding box and still poke out of the
    // trapezoid's slanted edges.
    const pts: Array<[number, number]> = [
      [minLng, minLat],
      [maxLng, minLat],
      [maxLng, maxLat],
      [minLng, maxLat],
      [(minLng + maxLng) / 2, minLat],
      [(minLng + maxLng) / 2, maxLat],
      [minLng, (minLat + maxLat) / 2],
      [maxLng, (minLat + maxLat) / 2],
    ];
    for (const [lng, lat] of pts) {
      if (!pointInQuad(lng, lat)) return false;
    }
  }
  return true;
}

// ── What was published, without scanning for it ──────────────────────
//
// BOTH isobar handlers used to ask the 389 MB `weather_isobars` table
// what was published, on EVERY request:
//
//   SELECT source, MAX(run_time), COUNT(*) ... GROUP BY source        (a)
//   SELECT MAX(run_time), COUNT(*), COUNT(DISTINCT level_hpa) ...     (b)
//                FROM weather_isobars WHERE source = $1
//
// MEASURED 2026-11-10 with EXPLAIN ANALYZE:
//
//   (a) Seq Scan          36,938 buffers read = 288 MB   1,577 ms
//   (b) Bitmap Heap Scan  23,871 buffers read = 186 MB     606 ms
//
// ~474 MB of I/O for METADATA on every request. That is why the
// endpoint's latency was at the mercy of whatever else the box was
// doing: the identical SQL run standalone took 580 ms END TO END while
// the live route answered the same request in 4,147 ms, then 28,093 ms,
// then 30,250 ms — three runs of the same URL.
//
// `weather_isobars_build` is the publish record: one row per source,
// written by worker/isobars.py in the SAME TRANSACTION as the DELETE
// and the INSERTs, so a build row exists if and only if that source's
// rows do. It is 2 ROWS and costs ~1 ms to read. It carries `built`,
// set to now() on every publish — so it also says WHEN the rows last
// changed, which is the cache key below and the identity of the ETag.
//
// WHAT STILL NEEDS THE BIG TABLE: the counts (n, level_count,
// min_level, max_level). They are computed ONCE per publish and cached
// against the build rows, so a pan re-uses them and only a genuine
// re-publish pays for the scan.
//
// NO BUILD ROWS => NO CACHE. The test database seeds `weather_isobars`
// directly and never writes a build row; a cache keyed on an empty key
// would hand one test's counts to the next. Those callers always
// recompute, which is the old behaviour.
type SourceStats = {
  source: string;
  runTime: string | null;
  n: number;
  levelCount: number;
  minLevel: number | null;
  maxLevel: number | null;
};

type BuildRow = {
  source: string;
  runTime: string | null;
  interval: number;
  built: string;
};

let statsCache: { key: string; stats: SourceStats[] } | null = null;

async function readPublished(sql: ReturnType<typeof getDb>): Promise<{
  builds: BuildRow[];
  stats: SourceStats[];
}> {
  const buildRowsRaw = await sql<any[]>`
    SELECT source, run_time, interval_hpa, built
    FROM weather_isobars_build
    ORDER BY source
  `;
  const builds: BuildRow[] = buildRowsRaw.map((b) => ({
    source: String(b.source),
    runTime: b.run_time ? new Date(b.run_time).toISOString() : null,
    interval: Number(b.interval_hpa),
    built: b.built ? new Date(b.built).toISOString() : "",
  }));

  // The key carries run_time AND interval AND built: a rebuild at the
  // same analysis but a finer INTERVAL changes nothing else in this
  // table's identity, and that is exactly the case that table exists to
  // record (moving 1 hPa -> 0.5 hPa left the cycle unchanged, so the
  // worker's no-op guard declared "already published" and the finer set
  // never shipped).
  const key = builds.map((b) => `${b.source}|${b.runTime}|${b.interval}|${b.built}`).join(",");

  if (builds.length > 0 && statsCache && statsCache.key === key) {
    return { builds, stats: statsCache.stats };
  }

  const rows = await sql<any[]>`
    SELECT source,
           MAX(run_time) AS run_time,
           COUNT(*)::int AS n,
           COUNT(DISTINCT level_hpa)::int AS level_count,
           MIN(level_hpa)::int AS min_level,
           MAX(level_hpa)::int AS max_level
    FROM weather_isobars
    GROUP BY source
  `;

  const bySource = new Map<string, SourceStats>();
  for (const r of rows) {
    bySource.set(String(r.source), {
      source: String(r.source),
      runTime: r.run_time ? new Date(r.run_time).toISOString() : null,
      n: Number(r.n ?? 0),
      levelCount: Number(r.level_count ?? 0),
      minLevel: r.min_level != null ? Number(r.min_level) : null,
      maxLevel: r.max_level != null ? Number(r.max_level) : null,
    });
  }

  // The publish record is the FRESHER authority for run_time, and a
  // source with a build row but no rows is reported with n = 0 so the
  // caller falls back exactly as it did when n came from the count.
  for (const b of builds) {
    const cur = bySource.get(b.source);
    if (cur) cur.runTime = b.runTime;
    else
      bySource.set(b.source, {
        source: b.source,
        runTime: b.runTime,
        n: 0,
        levelCount: 0,
        minLevel: null,
        maxLevel: null,
      });
  }

  const stats = [...bySource.values()].sort((a, b) => a.source.localeCompare(b.source));
  if (builds.length > 0) statsCache = { key, stats };
  return { builds, stats };
}

// ── GET /api/weather/isobars/meta ────────────────────────────────────
// Which analyses are currently loaded — no geometry.
// Declared before /weather/isobars so the meta path can never be shadowed.
weatherRoute.get("/weather/isobars/meta", async (c) => {
  const sql = getDb();
  const { stats } = await readPublished(sql);

  const sources: Record<string, any> = {};
  for (const s of stats) {
    sources[s.source] = {
      run_time: s.runTime,
      total_lines: s.n,
      level_count: s.levelCount,
      min_level: s.minLevel,
      max_level: s.maxLevel,
      label: SOURCE_LABELS[s.source as IsobarSource] ?? s.source,
      global: s.source !== "hrrr",
    };
  }

  // The "primary" source is the newest GLOBAL analysis — HRRR only
  // covers North America, so it can never be the default for the world.
  const globals = stats.filter((s) => s.source !== "hrrr" && s.n > 0);
  globals.sort(
    (a, b) => new Date(b.runTime ?? 0).getTime() - new Date(a.runTime ?? 0).getTime(),
  );
  const primary = globals[0] ? globals[0].source : null;

  return c.json({ sources, primary });
});

// ── GET /api/weather/isobars ─────────────────────────────────────────
// Isobar lines (lines of equal mean sea-level pressure) for a viewport.
//
// The lines are contoured from the NOAA NCEP GFS analysis by
// worker/isobars.py and stored in weather_isobars.
//
// bbox is "minLng,minLat,maxLng,maxLat" (GeoJSON order). Longitudes
// outside [-180, 180] are clamped, and a bbox that wraps the
// antimeridian (minLng > maxLng) is served as two envelopes.
weatherRoute.get(
  "/weather/isobars",
  zValidator("query", IsobarsQuerySchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = isobarLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }

    const q = c.req.valid("query");
    const sql = getDb();
    // PHASE TIMING (study): which part of this handler is the slow one?
    // The whole-handler X-Response-Time said 18,361 ms for step=0.1
    // while the same SQL run through psql took 183 ms, so the gap is
    // inside this function and needs attributing before anything can be
    // optimised. Reported in `x-phases` so a live request can be read.
    const t0 = performance.now();
    let tStats = 0, tMain = 0;

    // Parse the bbox into one or more envelopes.
    //
    // A viewport can reach outside the world in three ways:
    //   - it is wider than the globe (zoom 1 on a wide screen) — the whole
    //     world is visible, so one envelope covers everything;
    //   - it hangs off one edge (panned past the antimeridian) — the
    //     overflow wraps around to the other side, so it becomes two
    //     envelopes;
    //   - it straddles the antimeridian (west > east) — also two.
    const envelopes: Array<[number, number, number, number]> = [];
    // NO BBOX MEANS THE WHOLE WORLD. Without this the envelope list
    // stayed EMPTY, the query loop below ran zero times, and the
    // response said "0 lines" while advertising 1,026 in
    // `total_lines` — a caller that asked for everything got nothing.
    // The 3D globe asks for the whole world in one call.
    if (!q.bbox) {
      envelopes.push([-180, -90, 180, 90]);
    }
    if (q.bbox) {
      const parts = q.bbox.split(",").map(Number);
      if (parts.length !== 4 || !parts.every((n) => Number.isFinite(n))) {
        return c.json({ error: "bad_bbox" }, 400);
      }
      let [minLng, minLat, maxLng, maxLat] = parts;
      minLat = Math.max(-90, Math.min(90, minLat));
      maxLat = Math.max(-90, Math.min(90, maxLat));
      if (minLat > maxLat) [minLat, maxLat] = [maxLat, minLat];

      if (minLng < -180 && maxLng > 180) {
        // Wider than the globe — everything is visible.
        envelopes.push([-180, minLat, 180, maxLat]);
      } else if (minLng < -180) {
        // Hangs off the western edge; the overflow wraps to the east.
        envelopes.push([minLng + 360, minLat, 180, maxLat]);
        envelopes.push([-180, minLat, maxLng, maxLat]);
      } else if (maxLng > 180) {
        // Hangs off the eastern edge; the overflow wraps to the west.
        envelopes.push([minLng, minLat, 180, maxLat]);
        envelopes.push([-180, minLat, maxLng - 360, maxLat]);
      } else if (minLng > maxLng) {
        // Straddles the antimeridian.
        envelopes.push([minLng, minLat, 180, maxLat]);
        envelopes.push([-180, minLat, maxLng, maxLat]);
      } else {
        envelopes.push([minLng, minLat, maxLng, maxLat]);
      }
    }

    // Optional level filter, e.g. "1000,1004,1008".
    const levelList = q.levels
      ? q.levels
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n))
      : q.step
        ? stepLevels(Number(q.step))
        : null;

    // ── Which analysis to draw ──────────────────────────────────────
    //
    // Three sources are stored side by side. "auto" picks the one that
    // is actually the best for THIS viewport:
    //
    //   * HRRR (3 km, hourly) when the viewport sits inside the CONUS
    //     domain — it is the only source with metro-scale detail;
    //   * otherwise the newest of ECMWF IFS 0.1° and NOAA GFS 0.25°.
    //
    // The comparison is by ANALYSIS TIME, not by publication time. ECMWF
    // publishes ~8.5 h after its run and GFS ~3.5 h, so at some hours
    // of the day GFS is the newer analysis and at others ECMWF is — and
    // the map should show whichever is genuinely more recent.
    // What was published — 2 rows from `weather_isobars_build`, plus
    // the counts (cached against those rows). This used to be a Seq
    // Scan over the whole 389 MB table: 288 MB of I/O and 1,577 ms on
    // every single request. See readPublished() above.
    const { builds, stats } = await readPublished(sql);
    tStats = performance.now();
    const available = new Map<string, { runTime: string | null; n: number }>();
    for (const s of stats) {
      available.set(s.source, { runTime: s.runTime, n: s.n });
    }

    // The newest GLOBAL analysis — the fallback whenever the requested
    // source cannot serve the viewport.
    const newestGlobal = (): IsobarSource => {
      const globals = (["ecmwf", "gfs"] as IsobarSource[])
        .map((s) => ({ s, ...(available.get(s) ?? { runTime: null, n: 0 }) }))
        .filter((g) => g.n > 0)
        .sort(
          (a, b) =>
            new Date(b.runTime ?? 0).getTime() - new Date(a.runTime ?? 0).getTime(),
        );
      return globals.length > 0 ? globals[0].s : "gfs";
    };

    let source: IsobarSource;
    if (q.source === "auto") {
      const hrrr = available.get("hrrr");
      source =
        hrrr && hrrr.n > 0 && viewportInsideHrrr(envelopes)
          ? "hrrr"
          : newestGlobal();
    } else if (!available.has(q.source) || (available.get(q.source)?.n ?? 0) === 0) {
      // The requested source is not loaded. Fall back to the automatic
      // choice rather than returning nothing — a stale source name in a
      // shared link must not blank the layer.
      source = newestGlobal();
    } else {
      source = q.source;
    }

    const sourceFilter = sql`AND source = ${source}`;

    const levelFilter =
      levelList && levelList.length > 0
        ? sql`AND level_hpa IN ${sql(levelList)}`
        : sql``;

    // Simplify to the resolution the viewport can actually show. The
    // lines are stored at full detail (0.25° analysis grid, corners
    // already rounded); a world view does not need every vertex.
    //
    // The tolerance is scaled to the viewport: a 527°-wide view is
    // about 0.35° per screen pixel, so 0.2° is half a pixel and
    // invisible. It has to stay well under one grid cell — at 0.35° it
    // was more than a whole 0.25° cell, and the straight chords it
    // substituted turned smooth isobars into visible zigzags.
    //
    // ST_Simplify, NOT ST_SimplifyPreserveTopology: the isobars are
    // independent lines that never touch, so preserving topology buys
    // nothing and costs 10x (74 ms against 7 ms for the whole query).
    const span = envelopes.length
      ? Math.max(
          ...envelopes.map(([a, , b]) => Math.abs(b - a)),
        )
      : 360;
    const tolerance = Math.max(0.015, Math.min(0.2, span / 2500));

    // Phase marks for `x-phases`.
    const phases = (stats: number, main: number, rest: number) =>
      `stats=${Math.round(stats)} main=${
        main < 0 ? "skipped" : Math.round(main)
      } rest=${Math.round(rest)}`;

    // ── the validator, BEFORE the query ──────────────────────────────
    //
    // The identity of this response is the query plus the analysis it
    // was cut from. Everything in it is known right here: the viewport,
    // the step, the levels, the chosen source, the simplification
    // tolerance — and the publish record, which says which cycle this
    // came from and when it was built.
    //
    // It used to be computed AFTER the query, because it included
    // `items.length`. That made every conditional request pay for the
    // whole thing: measured on the owner's own URL, a **304** with an
    // empty body took `x-response-time` **28,543 ms** and then 2,526 ms
    // — for a reply that says "you already have it". The comment beside
    // it promised "a ~10 ms round trip"; that was true of the transfer
    // only, not of the handler.
    //
    // `items.length` is DROPPED when a build row exists, because with
    // one the row set is a pure function of the query and that record:
    // worker/isobars.py writes the rows and the build row in the SAME
    // TRANSACTION, so they cannot disagree, and `built` moves on every
    // publish. With NO build row there is nothing vouching for the row
    // set, so the ETag is formed after the query instead (see below)
    // and the early return is not taken.
    const buildRow = builds.find((b) => b.source === source) ?? null;
    const runStamp =
      buildRow?.runTime ??
      stats.find((s) => s.source === source)?.runTime ??
      "";
    const etagBase = [
      // The viewport, rounded the same way the query uses it.
      envelopes.map((e) => e.map((v) => Math.round(v * 100) / 100)),
      q.step ?? "default",
      q.levels ?? "",
      source,
      runStamp,
      tolerance,
    ];
    const makeEtag = (extra: unknown) =>
      '"' +
      createHash("sha1")
        .update(JSON.stringify([...etagBase, extra]))
        .digest("base64url") +
      '"';
    const earlyEtag = buildRow
      ? makeEtag({ interval: buildRow.interval, built: buildRow.built })
      : null;

    const inm = c.req.header("if-none-match");
    // Compare with the WEAK PREFIX STRIPPED from both sides. The value
    // that reaches the browser arrives as `W/"…"` (Caddy's proxy adds
    // it), so a strict compare against our own `"…"` never matches and
    // every conditional request fell through to a full 200 — which is
    // exactly the 895 KB download this exists to avoid.
    const bare = (t: string) => t.trim().replace(/^W\//, "");
    const matches = (tag: string | null) =>
      !!tag && !!inm && inm.split(",").some((t) => bare(t) === bare(tag));

    if (matches(earlyEtag)) {
      // The browser already holds these exact lines — and we can say so
      // without reading the table.
      c.header("etag", earlyEtag!);
      c.header("cache-control", "no-cache");
      c.header("x-phases", phases(tStats - t0, -1, performance.now() - tStats));
      return c.body(null, 304);
    }

    const rows: any[] = [];
    for (const [minLng, minLat, maxLng, maxLat] of envelopes) {
      const part = await sql<any[]>`
        SELECT level_hpa, ST_AsGeoJSON(ST_Simplify(geom, ${tolerance})) AS gj
        FROM weather_isobars
        WHERE geom::geometry && ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)
          ${sourceFilter}
          ${levelFilter}
        LIMIT ${q.limit}
      `;
      rows.push(...part);
    }
    tMain = performance.now();

    const items = rows.map((r) => {
      const gj = typeof r.gj === "string" ? JSON.parse(r.gj) : r.gj;
      return {
        level_hpa: Number(r.level_hpa),
        coordinates: gj?.coordinates ?? [],
      };
    });

    // The counts and the analysis time — from the stats read at the top
    // (a 2-row build table plus a count cached against it), NOT from a
    // second scan of the 389 MB table. That scan was a Bitmap Heap Scan
    // reading 23,871 buffers = 186 MB and 606 ms on EVERY request.
    const meta = stats.find((s) => s.source === source) ?? null;

    const levels = Array.from(
      new Set(items.map((i) => i.level_hpa)),
    ).sort((a, b) => a - b);

    // ── a validator, so a repeat request is a 304 ────────────────────
    //
    // The 0.25 hPa world response is 2.3 MB raw / 895 KB on the wire,
    // and switching the detail chip re-fetched it EVERY time: measured
    // 1,151 ms for the first switch to 0.25 and 932 ms for the second,
    // because the response carried no `Cache-Control` and no `ETag`, so
    // the browser had nothing to revalidate against and downloaded the
    // whole body again.
    //
    // The identity of this response is the query plus the analysis it
    // was cut from: same bbox, step, source, levels, run_time and row
    // count means the same lines. The worker's no-op guard refuses to
    // re-publish an unchanged cycle, so the geometry cannot move under
    // a fixed identity. `no-cache` means "store it, but revalidate
    // before using it" — which, with an ETag, is a ~10 ms round trip
    // instead of a 895 KB download.
    // No build row meant there was nothing to vouch for the row set, so
    // no early ETag was formed — make one now, with the count the query
    // just established. (With a build row this line re-uses `earlyEtag`
    // and the comparison below can never match: it already did not.)
    const etag = earlyEtag ?? makeEtag({ rows: items.length });
    const mainPhase = phases(tStats - t0, tMain - tStats, performance.now() - tMain);
    c.header("etag", etag);
    c.header("cache-control", "no-cache");
    if (matches(etag)) {
      // The browser already holds these exact lines.
      c.header("x-phases", mainPhase);
      return c.body(null, 304);
    }

    c.header("x-phases", mainPhase);
    return c.json({
      items,
      count: items.length,
      run_time: meta?.runTime ?? null,
      levels,
      // The simplification this response was built with, so the client
      // can tell whether it needs finer data once it zooms in.
      tolerance: Number(tolerance.toFixed(4)),
      total_lines: Number(meta?.n ?? 0),
      level_count: Number(meta?.levelCount ?? 0),
      // Which analysis these lines came from, and what it is called.
      source,
      source_label: SOURCE_LABELS[source as IsobarSource] ?? source,
      // The area the source covers. HRRR is CONUS-only, so the client
      // needs to know when a pan has carried the viewport out of its
      // domain — otherwise it would keep drawing 3 km lines over the
      // Atlantic, where HRRR has no data at all. A global source covers
      // the whole world and returns null.
      source_domain:
        source === "hrrr"
          ? HRRR_DOMAIN_QUAD.map(([lng, lat]) => [lng, lat])
          : null,
    });
  },
);
