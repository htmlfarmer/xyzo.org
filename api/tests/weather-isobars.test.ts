import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { weatherRoute, IsobarsQuerySchema } from "../src/routes/weather";
import { getDb } from "../src/db";

// The isobar route reads from PostGIS. The table is populated by
// worker/isobars.py, which runs on a 6-hourly timer, so a test that
// needs rows has to tolerate an empty table (the route must still
// answer with a well-formed empty response).
function makeApp() {
  const app = new Hono();
  app.route("/api", weatherRoute);
  return app;
}

// ── the fixture ─────────────────────────────────────────────────────────
//
// The thinning tests need ROWS, and the test database's
// `weather_isobars` table is empty — the worker only writes the
// production one. So these tests seed their own.
//
// This matters more than it looks. A test that returns early when the
// table is empty PASSES, always, and checks nothing: the superset
// property (the 4 hPa chart is the multiples of 4 in the 1 hPa set)
// would have been an assertion that could never fail — worse than no
// assertion, because it reads as a guarantee.
//
// The fixture is deliberately mixed: four levels that are multiples of
// 4 (1000, 1004, 1008, 1012) and one that is not (1001). A thinning
// that dropped the odd level, or kept it at step 4, would fail.
const FIXTURE_LEVELS = [1000, 1001, 1004, 1008, 1012];
// Plus two FRACTIONAL levels — the ones the 0.10 chip exists for.
// `level_hpa` is REAL (migration 2026-11-05-weather-isobars-half-hpa)
// and 1000.1 is not dyadic, so it is the value that a loose
// implementation loses twice over: once on the way IN (stored as
// float4) and once on the way back OUT (the IN list arrives as a
// decimal string and is parsed against that float4).
//
// The two are chosen to discriminate: 1000.1 is on the 0.1 chip's
// lattice but NOT on 0.25's (1000.1 / 0.25 = 4000.4), and 1000.25 is
// on 0.25's but NOT on 0.1's (1000.25 / 0.1 = 10002.5). Each chip must
// return its own and reject the other's.
const FRACTIONAL_LEVELS = [1000.1, 1000.25];
const ALL_LEVELS = [...FIXTURE_LEVELS, ...FRACTIONAL_LEVELS];
const FIXTURE_SOURCE = "gfs";
// Two lines per level, both inside the test viewport (-10,45,10,60), so
// the bbox filter keeps them and the "several lines at one level" case
// is exercised.
const FIXTURE_LINES: Record<number, number[][][]> = {
  1000: [[[-5, 50], [0, 55]], [[2, 48], [6, 52]]],
  1001: [[[-5, 50.5], [0, 55.5]], [[2, 48.5], [6, 52.5]]],
  1004: [[[-4, 50], [1, 56]], [[3, 47], [7, 53]]],
  1008: [[[-6, 49], [0, 54]], [[1, 46], [8, 51]]],
  1012: [[[-3, 51], [2, 57]], [[4, 45], [9, 50]]],
  1000.1: [[[-5, 49.5], [0, 54.5]], [[2, 47.5], [6, 51.5]]],
  1000.25: [[[-4.5, 50.5], [0.5, 55.5]], [[2.5, 48.5], [6.5, 52.5]]],
};
// A marker so the cleanup can only ever delete OUR rows.
const FIXTURE_RUN_TIME = "2001-01-01T00:00:00Z";

async function seedFixture() {
  const sql = getDb();
  await sql`
    DELETE FROM weather_isobars
    WHERE source = ${FIXTURE_SOURCE} AND run_time = ${FIXTURE_RUN_TIME}
  `;
  for (const level of ALL_LEVELS) {
    for (const coords of FIXTURE_LINES[level]) {
      const wkt =
        "LINESTRING(" +
        coords.map(([lng, lat]) => `${lng} ${lat}`).join(", ") +
        ")";
      await sql`
        INSERT INTO weather_isobars (level_hpa, geom, run_time, source)
        VALUES (
          ${level},
          ST_GeomFromText(${wkt}, 4326),
          ${FIXTURE_RUN_TIME},
          ${FIXTURE_SOURCE}
        )
      `;
    }
  }
}

async function clearFixture() {
  const sql = getDb();
  await sql`
    DELETE FROM weather_isobars
    WHERE source = ${FIXTURE_SOURCE} AND run_time = ${FIXTURE_RUN_TIME}
  `;
}

beforeAll(seedFixture);
afterAll(clearFixture);

// The API's query has no ORDER BY, so the ROW order inside a level is
// whatever the planner returns — different for two different queries.
// Comparing positionally would report differences that are pure
// ordering, so the lines of one level are sorted into a canonical order
// first.
function byLevel(items: any[]): Map<number, any[][]> {
  const out = new Map<number, any[][]>();
  for (const item of items) {
    const level = Number(item.level_hpa);
    if (!out.has(level)) out.set(level, []);
    out.get(level)!.push(item.coordinates);
  }
  for (const [level, lines] of out) {
    out.set(
      level,
      lines.sort((a, b) =>
        (a[0][0] - b[0][0]) || (a[0][1] - b[0][1]) || (a.length - b.length),
      ),
    );
  }
  return out;
}

describe("GET /api/weather/isobars/meta", () => {
  test("answers with the run metadata", async () => {
    const app = makeApp();
    const res = await app.request("/api/weather/isobars/meta");
    expect(res.status).toBe(200);
    const body = await res.json();
    // The metadata is PER SOURCE since the `source` column split the
    // table: GFS 0.25° and ECMWF IFS 0.1° are stored side by side and
    // `primary` names the newest GLOBAL one (HRRR covers North America
    // only, so it can never be the world's default). The flat top-level
    // total_lines/level_count/source this used to assert predated that
    // split — HEAD has returned `{sources, primary}` for a while, so the
    // assertion was failing against the committed code, not against the
    // 2 hPa step work.
    expect(body).toHaveProperty("sources");
    expect(body).toHaveProperty("primary");
    expect(typeof body.sources).toBe("object");
    for (const meta of Object.values(body.sources as Record<string, any>)) {
      expect(typeof meta.total_lines).toBe("number");
      expect(typeof meta.level_count).toBe("number");
      expect(typeof meta.run_time === "string" || meta.run_time === null).toBe(true);
      expect(typeof meta.label).toBe("string");
    }
  });
});

describe("GET /api/weather/isobars", () => {
  test("answers with the list shape the repo uses", async () => {
    const app = makeApp();
    const res = await app.request("/api/weather/isobars?bbox=-10,45,10,60");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.count).toBe("number");
    expect(body.count).toBe(body.items.length);
  });

  test("every line carries a level and a coordinate list", async () => {
    const app = makeApp();
    const res = await app.request("/api/weather/isobars?bbox=-10,45,10,60");
    const body = await res.json();
    for (const item of body.items) {
      expect(typeof item.level_hpa).toBe("number");
      expect(Array.isArray(item.coordinates)).toBe(true);
      for (const pair of item.coordinates) {
        expect(Array.isArray(pair)).toBe(true);
        expect(pair.length).toBe(2);
        const [lng, lat] = pair;
        expect(lng).toBeGreaterThanOrEqual(-180);
        expect(lng).toBeLessThanOrEqual(180);
        expect(lat).toBeGreaterThanOrEqual(-90);
        expect(lat).toBeLessThanOrEqual(90);
      }
    }
  });

  test("a malformed bbox is rejected", async () => {
    const app = makeApp();
    const res = await app.request("/api/weather/isobars?bbox=not-a-bbox");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("a viewport wider than the globe is answered, not rejected", async () => {
    // Leaflet reports the whole world as west=-263, east=263 at low
    // zoom. That has to be served as one world-wide envelope.
    const app = makeApp();
    const res = await app.request("/api/weather/isobars?bbox=-263.68,-81.15,263.68,85.65");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });

  test("a viewport that wraps the antimeridian is answered", async () => {
    const app = makeApp();
    const res = await app.request("/api/weather/isobars?bbox=170,-10,-170,10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });

  test("the levels filter narrows the result", async () => {
    const app = makeApp();
    const all = await (await app.request("/api/weather/isobars?bbox=-10,45,10,60")).json();
    if (all.items.length === 0) return; // table empty — nothing to filter
    const filtered = await (
      await app.request("/api/weather/isobars?bbox=-10,45,10,60&levels=1012")
    ).json();
    for (const item of filtered.items) {
      expect(item.level_hpa).toBe(1012);
    }
  });

  test("every offered step is accepted", async () => {
    // The control offers 0.1 / 0.25 / 0.5 / 1 / 2 / 4 / 8 / 16 hPa. A
    // step the schema does not know is a 400, and the layer would then
    // be silently broken for that choice only.
    const app = makeApp();
    for (const step of ["0.1", "0.25", "0.5", "1", "2", "4", "8", "16"]) {
      const res = await app.request(
        `/api/weather/isobars?bbox=-10,45,10,60&source=gfs&step=${step}`,
      );
      expect(res.status, `step=${step} was rejected`).toBe(200);
    }
  });

  test("0.10 and 0.25 each return their own lattice, not each other's", async () => {
    // The 0.10 chip end to end, through the REAL column. 1000.1 is on
    // the 0.1 lattice only and 1000.25 on the 0.25 lattice only, so the
    // pair proves the step filter is selecting on the VALUE and not
    // merely returning whatever exists.
    //
    // It also pins two ways this breaks silently:
    //   * truncation (the old `int(level_hpa)` in the verifier's shape)
    //     would turn 1000.1 into 1000, so `has(1000.1)` fails;
    //   * a loose decimal would come back as 1000.099976 — Postgres'
    //     shortest float4 round-trip is what makes the map print
    //     "1000.1 hPa" rather than a 16-digit tail, and Number() of it
    //     is not 1000.1, so this fails too.
    const app = makeApp();
    const levelsAt = async (step: string) => {
      const res = await app.request(
        `/api/weather/isobars?bbox=-10,45,10,60&source=gfs&step=${step}`,
      );
      expect(res.status, `step=${step}`).toBe(200);
      const body = await res.json();
      return new Set<number>(body.items.map((i: { level_hpa: number }) => i.level_hpa));
    };

    const at010 = await levelsAt("0.1");
    const at025 = await levelsAt("0.25");

    expect(at010.has(1000.1), "the 0.10 chip must return 1000.1").toBe(true);
    expect(at010.has(1000.25), "1000.25 is not on the 0.1 lattice").toBe(false);
    expect(at025.has(1000.25), "the 0.25 chip must return 1000.25").toBe(true);
    expect(at025.has(1000.1), "1000.1 is not on the 0.25 lattice").toBe(false);

    // Neither chip may return a level outside its own spacing — that is
    // the chip lying about what it drew.
    for (const l of at010) {
      expect(Math.abs(l / 0.1 - Math.round(l / 0.1)), `0.10 returned ${l}`).toBeLessThan(1e-6);
    }
    for (const l of at025) {
      expect(Math.abs(l / 0.25 - Math.round(l / 0.25)), `0.25 returned ${l}`).toBeLessThan(1e-6);
    }
  });

  test("a step selects the multiples of that step", async () => {
    // The API thins ONE dataset by the level filter, so step=4 must
    // return exactly the levels that are multiples of 4 — and step=1
    // must return the odd ones as well. The fixture carries 1001 on
    // purpose: a thinning that dropped it, or kept it at step 4, fails.
    const app = makeApp();
    const one = await (
      await app.request("/api/weather/isobars?bbox=-10,45,10,60&source=gfs&step=1")
    ).json();
    const four = await (
      await app.request("/api/weather/isobars?bbox=-10,45,10,60&source=gfs&step=4")
    ).json();

    const oneLevels = [...byLevel(one.items).keys()].sort((a, b) => a - b);
    expect(oneLevels).toEqual([...FIXTURE_LEVELS].sort((a, b) => a - b));
    expect(oneLevels).toContain(1001);

    const fourLevels = [...byLevel(four.items).keys()].sort((a, b) => a - b);
    expect(fourLevels).toEqual([1000, 1004, 1008, 1012]);
    expect(fourLevels).not.toContain(1001);
  });

  test("the finer step is a SUPERSET of the coarser one", async () => {
    // The whole design rests on this: the contour of a level does not
    // depend on the interval used to enumerate the levels, so the 4 hPa
    // chart is a thinning of the 1 hPa set rather than a second copy.
    // If this ever fails, the two datasets have drifted apart.
    const app = makeApp();
    const fine = await (
      await app.request("/api/weather/isobars?bbox=-10,45,10,60&source=gfs&step=1")
    ).json();
    const coarse = await (
      await app.request("/api/weather/isobars?bbox=-10,45,10,60&source=gfs&step=4")
    ).json();

    const fineByLevel = byLevel(fine.items);
    const coarseByLevel = byLevel(coarse.items);
    expect(fineByLevel.size).toBeGreaterThan(0);
    expect(coarseByLevel.size).toBeGreaterThan(0);

    for (const [level, coarseLines] of coarseByLevel) {
      const fineLines = fineByLevel.get(level);
      expect(fineLines, `level ${level} is missing from the fine set`).toBeDefined();
      // Not just "the level exists" — the GEOMETRY has to be the same
      // line. The contour of a level is the contour of a level.
      expect(fineLines!.length).toBe(coarseLines.length);
      for (let i = 0; i < coarseLines.length; i++) {
        expect(fineLines![i]).toEqual(coarseLines[i]);
      }
    }

    // And the fine set really is finer: it carries levels the coarse
    // one does not.
    let onlyFine = 0;
    for (const level of fineByLevel.keys()) {
      if (!coarseByLevel.has(level)) onlyFine++;
    }
    expect(onlyFine).toBeGreaterThan(0);
  });
});

// ── the LIMIT ───────────────────────────────────────────────────────────
//
// THE RESPONSE IS TRUNCATED SILENTLY. `LIMIT ${q.limit}` drops whatever
// does not fit, with a well-formed body and no warning anywhere, so a
// ceiling under the world's line count shows up as HOLES in the chart —
// an isobar that simply stops half way across the map.
//
// MEASURED on the 2026-11-06 GFS 18Z analysis: the whole world at the
// finest offered step (0.1 hPa) is **11,152 lines** — the worker drops
// |lat| > 85, which is why it is not the 11,266 the contouring counts.
// The default was 12,000: 6 % of headroom, so one more line anywhere in
// a deeper analysis would have started truncating. ECMWF's 0.1° field
// carries more lines for the same pressure range, and a deep low widens
// it further, so the default and the ceiling are both 30,000 — 2.7x.
//
// Re-measure the world count when the lattice or the field's range
// changes; this assertion is deliberately tied to a measured number so
// it FAILS when the measurement moves instead of drifting.
const WORLD_LINES_AT_FINEST_STEP = 11152;

describe("the limit", () => {
  test("the default clears the finest step's whole-world line count", () => {
    const q = IsobarsQuerySchema.parse({});
    expect(q.limit).toBeGreaterThanOrEqual(WORLD_LINES_AT_FINEST_STEP * 2);
    // And the ceiling is the default: an explicit ask for the maximum
    // must not be rejected (it is the same number the default uses).
    expect(IsobarsQuerySchema.parse({ limit: "30000" }).limit).toBe(30000);
  });

  test("a limit above the ceiling is a 400, not a silent clamp", async () => {
    const app = makeApp();
    const res = await app.request(
      "/api/weather/isobars?bbox=-10,45,10,60&limit=99999"
    );
    expect(res.status).toBe(400);
  });
});

// ── the validator ──────────────────────────────────────────────────────
//
// Owner ask (2026-11-10): *"do a deep study on what we can do to speed
// up isometric pressure bar loading"*.
//
// The study found the route doing ~474 MB of I/O for METADATA on every
// request — two full-table scans (a Seq Scan of 288 ms and a Bitmap
// Heap Scan of 186 ms, 1,577 ms + 606 ms) — and, worse, forming the
// ETag AFTER the query, so a conditional request paid for the whole
// thing to be told "you already have it": measured on the owner's own
// URL, a 304 with an empty body took x-response-time 28,543 ms.
//
// These tests pin the fix. The first one is the whole point: a repeat
// must answer WITHOUT reading the lines, which is why it asserts on
// `x-phases` rather than only on the status — the old code also
// returned 304, just after the scan.
describe("the validator — a repeat must not re-read the table", () => {
  const URL_ = "/api/weather/isobars?bbox=-10,45,10,60&step=1&source=gfs";

  beforeAll(async () => {
    // A build row is what lets the route answer a conditional request
    // without touching `weather_isobars`: worker/isobars.py writes the
    // rows and this record in the SAME transaction, so the record can
    // vouch for the row set. The test database has no such row (the
    // migration seeds only from rows that exist, and this table is
    // empty until seedFixture runs), so without this the early path
    // would never be taken and the assertion below could not fire.
    const sql = getDb();
    await sql`
      INSERT INTO weather_isobars_build (source, run_time, interval_hpa, built)
      VALUES (${FIXTURE_SOURCE}, ${FIXTURE_RUN_TIME}, 1, now())
      ON CONFLICT (source) DO UPDATE SET
        run_time = EXCLUDED.run_time,
        interval_hpa = EXCLUDED.interval_hpa,
        built = EXCLUDED.built
    `;
  });

  afterAll(async () => {
    // Take it away again: with no build row the route must fall back to
    // computing the identity from the query it just ran, which is the
    // behaviour every other test in this file (and the next run) sees.
    const sql = getDb();
    await sql`DELETE FROM weather_isobars_build WHERE source = ${FIXTURE_SOURCE}`;
  });

  test("a repeat is answered 304 without reading the lines", async () => {
    const app = makeApp();
    const first = await app.request(URL_);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag, "the route must publish a validator").toBeTruthy();

    const again = await app.request(URL_, {
      headers: { "if-none-match": etag! },
    });
    expect(again.status).toBe(304);
    // THE POINT. `main=skipped` says the bbox query never ran — the
    // old route could not have produced it, because the ETag it
    // compared against was built from `items.length`.
    expect(again.headers.get("x-phases") ?? "").toContain("main=skipped");
    expect(again.headers.get("cache-control")).toBe("no-cache");
    // A 304 carries no body.
    expect((await again.text()).length).toBe(0);
  });

  test("a different viewport is still a 200", async () => {
    const app = makeApp();
    const etag = (await app.request(URL_)).headers.get("etag");
    const other = await app.request(
      "/api/weather/isobars?bbox=-74,40,-73,41&step=1&source=gfs",
      { headers: { "if-none-match": etag! } },
    );
    expect(other.status).toBe(200);
    // …and it really did read them.
    expect(other.headers.get("x-phases") ?? "").not.toContain("main=skipped");
    expect(other.headers.get("etag")).not.toBe(etag);
  });

  test("a re-publish invalidates the validator", async () => {
    // `built` is set to now() on every publish, and it is the only
    // thing that moves when the SAME cycle is cut differently — the
    // case that motivated the build table in the first place (moving
    // 1 hPa -> 0.5 hPa left the cycle and the product unchanged, so
    // the worker's no-op guard declared "already published" and the
    // finer set never shipped). Left out of the identity, a reader
    // would be told "you already have it" about lines that changed.
    const app = makeApp();
    const sql = getDb();
    const etag1 = (await app.request(URL_)).headers.get("etag");
    expect(etag1).toBeTruthy();

    await sql`
      UPDATE weather_isobars_build
      SET built = built + interval '1 second'
      WHERE source = ${FIXTURE_SOURCE}
    `;

    const res = await app.request(URL_, {
      headers: { "if-none-match": etag1! },
    });
    expect(res.status, "a re-published build must not answer 304").toBe(200);
    expect(res.headers.get("etag")).not.toBe(etag1);
    // …and this time it had to read them again, because the identity
    // moved out from under the browser's copy.
    expect(res.headers.get("x-phases") ?? "").not.toContain("main=skipped");
  });
});

// ── when NOTHING vouches for the row set ───────────────────────────────
//
// The three tests above all seed a build row, because that is what
// lets the route answer a conditional request without reading the
// table. The OTHER half of the rule is the safety half, and it had no
// test at all:
//
//   with a build record  -> the row set is a pure function of the
//                           query and that record, so `items.length`
//                           is redundant and the ETag forms early;
//   with NO build record -> nothing vouches for the row set, so the
//                           ETag must form AFTER the query and carry
//                           the count, and the early return must not
//                           be taken.
//
// Without this, deleting the `builds.length > 0` guard would leave the
// route telling a browser "you already have it" about lines that had
// changed — and every other test in this file would still pass, because
// none of them mutates the rows.
describe("the validator when nothing vouches for the row set", () => {
  const URL_ = "/api/weather/isobars?bbox=-10,45,10,60&step=1&source=gfs";

  beforeAll(async () => {
    const sql = getDb();
    await sql`DELETE FROM weather_isobars_build WHERE source = ${FIXTURE_SOURCE}`;
  });

  test("the early path is NOT taken", async () => {
    const app = makeApp();
    const res = await app.request(URL_);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag"), "a validator must still be published").toBeTruthy();
    // The whole point: no build record, so the query ran.
    expect(res.headers.get("x-phases") ?? "").not.toContain("main=skipped");
  });

  test("a changed row set cannot be answered 304 — and the counts move with it", async () => {
    const sql = getDb();
    const app = makeApp();

    const first = await app.request(URL_);
    expect(first.status).toBe(200);
    const body1 = await first.json();
    const tag1 = first.headers.get("etag");
    expect(tag1).toBeTruthy();
    expect(body1.count).toBeGreaterThan(2);

    // The fixture puts exactly two lines at level 1012.
    const gone = await sql`
      DELETE FROM weather_isobars
      WHERE source = ${FIXTURE_SOURCE} AND run_time = ${FIXTURE_RUN_TIME}
        AND level_hpa = 1012
      RETURNING level_hpa`;
    expect(gone.length, "the fixture must hold two lines at 1012").toBe(2);

    try {
      const second = await app.request(URL_, {
        headers: { "if-none-match": tag1! },
      });
      expect(second.status,
        "a changed row set was answered 304 — the count is missing from the tag")
        .toBe(200);
      const body2 = await second.json();
      expect(second.headers.get("etag")).not.toBe(tag1);
      expect(body2.count).toBe(body1.count - 2);

      // `total_lines` is read from the SAME place as the tag's inputs.
      // If it did NOT move, the counts are being served from a cache
      // keyed on something that did not change — which is exactly what
      // "no build row, no cache" exists to prevent, and it would poison
      // every later response in this process.
      expect(body2.total_lines).toBe(body1.total_lines - 2);
      expect(body2.level_count).toBeLessThanOrEqual(body1.level_count);
    } finally {
      for (const coords of FIXTURE_LINES[1012]) {
        const wkt =
          "LINESTRING(" + coords.map(([lng, lat]) => `${lng} ${lat}`).join(", ") + ")";
        await sql`
          INSERT INTO weather_isobars (level_hpa, geom, run_time, source)
          VALUES (1012, ST_GeomFromText(${wkt}, 4326), ${FIXTURE_RUN_TIME}, ${FIXTURE_SOURCE})
        `;
      }
    }

    // Putting the lines back puts the tag back: the identity is a
    // function of the rows, not of when we happened to ask.
    const third = await app.request(URL_);
    const body3 = await third.json();
    expect(third.headers.get("etag")).toBe(tag1);
    expect(body3.count).toBe(body1.count);
    expect(body3.total_lines).toBe(body1.total_lines);
  });
});

// ── which analysis is SERVED ───────────────────────────────────────────
//
// The client's half has ten tests (isobar-source.bun.test.js: the
// chips, the disabled chip, `isoSrc=`, the globe). The server's half —
// the reason `source` defaults to "auto" and the reason a stale source
// name in a shared link must not blank the layer — had none: every
// request in this file named `gfs` explicitly.
describe("which analysis is served", () => {
  test("source=auto answers with one that is actually published", async () => {
    const app = makeApp();
    const res = await app.request(
      "/api/weather/isobars?bbox=-10,45,10,60&step=1&source=auto",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(["gfs", "ecmwf", "hrrr"]).toContain(body.source);
    expect(body.items.length, "auto must draw something").toBeGreaterThan(0);
    expect(body.source_label).toBeTruthy();
  });

  test("an analysis that is NOT published falls back rather than blanking", async () => {
    // The test database publishes only `gfs` (the fixture). A shared
    // link naming anything else used to be a silent empty layer — the
    // map loaded, the checkbox was on, and there were no lines.
    const app = makeApp();
    const res = await app.request(
      "/api/weather/isobars?bbox=-10,45,10,60&step=1&source=ecmwf",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source,
      "an unpublished analysis must fall back, not be echoed back")
      .not.toBe("ecmwf");
    expect(body.items.length, "the fallback must still draw the map").toBeGreaterThan(0);
    expect(body.source_label).toBeTruthy();
    // …and it must say WHICH analysis it fell back to, or the corner
    // credit and the source picker would disagree with the lines.
    expect(["gfs", "hrrr"]).toContain(body.source);
  });
});
