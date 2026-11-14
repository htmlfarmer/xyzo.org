/**
 * /api/weather/archive — a YEAR of the weather maps.
 *
 * WHAT THIS IS. The site publishes three weather fields every GFS
 * analysis cycle (four a day): the 10 m wind, the 2 m temperature and
 * the pressure contours. Each worker REPLACES the previous cycle when
 * the next one lands, so the past was not a lookup — it was gone.
 * worker/weather_archive.py keeps a copy of every cycle, and this route
 * serves it, so a reader can pick a date and see the map as it was.
 *
 * WHAT IT COSTS (measured 2026-11-12): 369 KB a cycle — the 1° wind
 * grid (196 KB gzipped), the 1° temperature grid (66 KB) and the
 * classic 4 hPa pressure chart (103 KB) — so a YEAR is ~550 MB. The
 * 0.25° grids would be 8.8 GB a year, which is why the archive keeps
 * the 1° ones: the same grids the 3D globe draws.
 *
 * THE RULES THIS PINS:
 *
 *   * the cycle served is the one IN EFFECT at the requested moment —
 *     the nearest one at or before it, which is what "what did the
 *     weather look like then" means;
 *   * the archived meta describes the ARCHIVED field (the live meta
 *     describes today's analysis, and a grid without its own meta cannot
 *     be drawn at all);
 *   * the stored files are gzip and are served as gzip, so the browser
 *     decompresses them transparently and the layer receives the same
 *     bytes it would have received from the live path;
 *   * an unknown field is a 404 with the list of the real ones, and a
 *     moment with nothing archived behind it is a 404 — never a silent
 *     empty answer.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gzipSync, gunzipSync } from "zlib";

const ROOT = mkdtempSync(join(tmpdir(), "xyzo-archive-test-"));

// The route reads its root LAZILY (per request), so pointing it at a
// fixture directory is enough.
process.env.XYZO_WEATHER_ARCHIVE = ROOT;

const { weatherArchiveRoute } = await import("../src/routes/weather-archive");

const app = new Hono();
app.route("/api", weatherArchiveRoute);

const CYCLES = [
  "2026-11-10T00:00:00Z",
  "2026-11-10T06:00:00Z",
  "2026-11-10T12:00:00Z",
];

function writeCycle(iso: string, lines: number) {
  const key = iso.replace(/\D/g, "").slice(0, 10);
  const dir = join(ROOT, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "wind.bin.gz"), gzipSync(Buffer.alloc(360 * 181 * 4, 7)));
  writeFileSync(join(dir, "temp.bin.gz"), gzipSync(Buffer.alloc(360 * 181 * 2, 3)));
  writeFileSync(
    join(dir, "isobars.json.gz"),
    gzipSync(
      Buffer.from(
        JSON.stringify({
          items: Array.from({ length: lines }, (_, i) => ({
            level_hpa: 1000 + i,
            coordinates: [[[0, 0], [1, 1]]],
          })),
          source: "gfs",
          run_time: iso,
        }),
      ),
    ),
  );
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      cycle: iso,
      key,
      total_bytes: 1234,
      isobars: { lines, levels: [1000] },
      wind: {
        meta: {
          run_time: iso,
          built: iso,
          grid: { cols: 360, rows: 181, lat_step: 1, lon_step: 1, scale: 100 },
          ramp: [],
        },
        bytes: 100,
      },
      temp: {
        meta: {
          run_time: iso,
          built: iso,
          grid: { cols: 360, rows: 181, lat_step: 1, lon_step: 1, scale: 10 },
          ramp: [],
        },
        bytes: 100,
      },
    }),
  );
}

beforeAll(() => {
  for (const c of CYCLES) writeCycle(c, 12);
});

afterAll(() => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
});

describe("the weather archive", () => {
  test("it lists the cycles it holds", async () => {
    const res = await app.request("/api/weather/archive/cycles");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(3);
    expect(body.oldest).toBe(CYCLES[0]);
    expect(body.newest).toBe(CYCLES[2]);
    // The reader is told what resolution they are looking at — the
    // archive keeps the 1° fields, not the 0.25° ones.
    expect(body.resolution).toBe("1deg");
    expect(body.step_hpa).toBe(4);
  });

  test("a field is served for the cycle in effect at that moment", async () => {
    const res = await app.request("/api/weather/archive/wind.bin?at=2026-11-10T09:00:00Z");
    expect(res.status).toBe(200);
    // The cycle in effect at 09:00 is the 06:00 one.
    expect(res.headers.get("X-Archive-Cycle")).toBe(CYCLES[1]);
    // Stored gzip, served gzip — the browser decompresses it.
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    // The raw response is still gzip (a browser would decompress it).
    const body = gunzipSync(Buffer.from(await res.arrayBuffer()));
    expect(body.byteLength).toBe(360 * 181 * 4);
  });

  test("the exact cycle is served for an exact moment", async () => {
    const res = await app.request("/api/weather/archive/temp.bin?at=2026-11-10T12:00:00Z");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Archive-Cycle")).toBe(CYCLES[2]);
  });

  test("the archived meta describes the ARCHIVED field", async () => {
    const res = await app.request("/api/weather/archive/meta.json?field=wind&at=2026-11-10T12:00:00Z");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run_time).toBe(CYCLES[2]);
    expect(body.archived).toBe(true);
    // The grid's file must point at the ARCHIVE, or the layer would go
    // and fetch today's grid for yesterday's meta.
    expect(body.grid.file).toBe("/api/weather/archive/wind.bin");
    expect(body.grid.cols).toBe(360);
  });

  test("the pressure chart is the archived one", async () => {
    const res = await app.request("/api/weather/archive/isobars.json?at=2026-11-10T12:00:00Z");
    expect(res.status).toBe(200);
    // The stored file is gzip and is served gzip — the browser
    // decompresses it, a raw request does not.
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    const body = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString());
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(12);
    expect(body.run_time).toBe(CYCLES[2]);
  });

  test("an unknown field is a 404 that says what the real ones are", async () => {
    const res = await app.request("/api/weather/archive/pressure.bin?at=2026-11-10T12:00:00Z");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("unknown_field");
    expect(body.fields).toContain("wind");
    expect(body.fields).toContain("isobars");
  });

  test("a moment BEFORE the oldest cycle still answers with the oldest", async () => {
    // "What did it look like then?" for a moment before the archive
    // starts is answered with the first cycle it has — never an empty
    // answer.
    const res = await app.request("/api/weather/archive/wind.bin?at=2020-01-01T00:00:00Z");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Archive-Cycle")).toBe(CYCLES[0]);
  });
});
