// client-perf.test.ts — the performance telemetry the owner asked for
// (2026-11-14): *"we need someone on the server side to help us
// understand how slow or how fast various situations are running on
// various peoples browsers so we can log them and try and study them on
// what we can do to speed it up for all users."*
//
// Hermetic: mounts analyticsRoute on a bare Hono app against xyzo_test.
// Every row this file creates is deleted by session-id prefix, so a
// failing run leaves nothing behind.
//
// The four things that make a telemetry table lie:
//   1. DOUBLE COUNTING — a reader who refreshes must stay ONE session.
//      The (day, session_id, phase) upsert is what makes that true.
//   2. TWO PHASES COLLIDING — `settled` and `wind` are different
//      questions and must be different rows.
//   3. A GROUP BY BUILT FROM THE QUERY STRING — the group is chosen
//      from a fixed switch; the test sends an unknown group and gets a
//      400 from zod, never a SQL fragment.
//   4. NUMERIC/INT SERIALIZATION — postgres.js answers `numeric` with a
//      STRING and BIGINT with a bigint; a report that says "fps_p50:
//      \"12.3\"" (or dies on JSON.stringify) is a report nobody can
//      chart. Every figure is asserted to be a JS number.
import { describe, expect, test, afterAll } from "bun:test";
import { Hono } from "hono";
import { analyticsRoute } from "../src/routes/analytics";
import { getDb } from "../src/db";

const app = new Hono();
app.route("/api", analyticsRoute);

const SID = `perf-test-${Math.random().toString(36).slice(2, 10)}`;
const SID2 = `perf-test-${Math.random().toString(36).slice(2, 10)}`;

function post(path: string, body: unknown, ip = "203.0.113.10") {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

function baseReport(over: Record<string, unknown> = {}) {
  return {
    session_id: SID,
    phase: "settled",
    browser: "Firefox/153",
    os: "Linux",
    device: "desktop",
    hw_concurrency: 8,
    dpr: 1,
    viewport_w: 1440,
    viewport_h: 900,
    overlay_count: 15,
    panes: 36,
    canvas_px: 24_000_000,
    gpu: "llvmpipe (LLVM 15.0.7, 256 bits)",
    probe_ms: 7.25,
    fps: 6.9,
    frame_p50_ms: 150.1,
    frame_p95_ms: 200.4,
    frame_worst_ms: 333.3,
    long_tasks: 0,
    long_busy_pct: 0,
    wind: { on: true, style: "particles", density: 100, particles: 1234, fps: 7, quality: 0.4 },
    dot_px_per_s: 44.5,
    dcl_ms: 900,
    load_ms: 2500,
    view: "#2.1089,16.8750,3/overlay=wind-gfs@100",
    ...over,
  };
}

afterAll(async () => {
  const sql = getDb();
  await sql`DELETE FROM client_perf WHERE session_id LIKE ${"perf-test-%"}`;
});

describe("POST /api/analytics/perf", () => {
  test("a report is stored with every field the study needs", async () => {
    const res = await post("/api/analytics/perf", baseReport());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const sql = getDb();
    const rows = await sql<any[]>`
      SELECT * FROM client_perf WHERE session_id = ${SID} AND phase = 'settled'`;
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.browser).toBe("Firefox/153");
    expect(r.os).toBe("Linux");
    expect(r.device).toBe("desktop");
    expect(r.overlay_count).toBe(15);
    // The renderer string is the column that separates a CPU-rendered
    // farm from a laptop with a GPU — it must survive the round trip.
    expect(r.gpu).toContain("llvmpipe");
    expect(Number(r.fps)).toBe(6.9);
    expect(Number(r.dot_px_per_s)).toBe(44.5);
    expect(r.view).toContain("wind-gfs@100");
    // The wind blob is JSONB, not text.
    expect(typeof r.wind).toBe("object");
    expect(r.wind.style).toBe("particles");
  });

  test("the SAME session reported twice is still ONE row (upsert)", async () => {
    // The client reports once per phase per day; a retry, a second tab
    // or a reload lands here too. Counting readers is the whole point
    // of the table, so a duplicate would make every percentage in the
    // report wrong.
    const first = await post("/api/analytics/perf", baseReport({ fps: 6.9 }));
    expect(first.status).toBe(200);
    const second = await post(
      "/api/analytics/perf",
      baseReport({ fps: 20.2, dot_px_per_s: 38.0 })
    );
    expect(second.status).toBe(200);

    const sql = getDb();
    const rows = await sql<any[]>`
      SELECT count(*)::int AS n, max(fps) AS fps FROM client_perf
      WHERE session_id = ${SID} AND phase = 'settled'`;
    expect(rows[0].n).toBe(1);
    // …and the retry's numbers win rather than being dropped.
    expect(Number(rows[0].fps)).toBe(20.2);
  });

  test("`wind` is a SECOND row, not an overwrite of `settled`", async () => {
    const res = await post("/api/analytics/perf", baseReport({ phase: "wind" }));
    expect(res.status).toBe(200);

    const sql = getDb();
    const rows = await sql<any[]>`
      SELECT phase FROM client_perf WHERE session_id = ${SID} ORDER BY phase`;
    expect(rows.map((r) => r.phase)).toEqual(["settled", "wind"]);
  });

  test("an unknown phase or device is rejected, not stored", async () => {
    const bad1 = await post("/api/analytics/perf", baseReport({ phase: "during-load" }));
    expect(bad1.status).toBe(400);
    const bad2 = await post("/api/analytics/perf", baseReport({ device: "toaster" }));
    expect(bad2.status).toBe(400);
    // A field outside its bound: 81 overlays is not a map.
    const bad3 = await post("/api/analytics/perf", baseReport({ overlay_count: 81 }));
    expect(bad3.status).toBe(400);
  });

  test("an out-of-range figure is rejected rather than stored as a lie", async () => {
    // fps of 5000 or a frame time of an hour are sensor bugs or a
    // broken sampler; letting them through would poison every
    // percentile the report computes.
    const bad = await post("/api/analytics/perf", baseReport({ fps: 5000 }));
    expect(bad.status).toBe(400);
  });

  test("the endpoint is rate limited per IP", async () => {
    const ip = "203.0.113.77";
    let saw429 = false;
    for (let i = 0; i < 25; i++) {
      const res = await post(
        "/api/analytics/perf",
        baseReport({ session_id: `${SID}-rl-${i}` }),
        ip
      );
      if (res.status === 429) { saw429 = true; break; }
    }
    expect(saw429).toBe(true);
    const sql = getDb();
    await sql`DELETE FROM client_perf WHERE session_id LIKE ${SID + "-rl-%"}`;
  });
});

describe("GET /api/analytics/perf", () => {
  test("the report is shaped { items, count, totals } with NUMBER figures", async () => {
    // Seed one more reader on a second browser so the grouping has
    // something to split, then read the aggregate back.
    await post("/api/analytics/perf", baseReport({
      session_id: SID2, browser: "Chrome/140", os: "Windows",
      device: "phone", overlay_count: 3, wind: { on: false },
      fps: 55, dot_px_per_s: null,
    }), "203.0.113.11");

    const res = await app.request("/api/analytics/perf?days=30&phase=settled&group=browser",
      { headers: { "x-forwarded-for": "203.0.113.12" } });
    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(Array.isArray(body.items)).toBe(true);
    expect(body.count).toBe(body.items.length);
    expect(body.totals).toBeTruthy();
    expect(body.group).toBe("browser");
    expect(body.phase).toBe("settled");

    const mine = body.items.find((i: any) => i.group === "Firefox/153");
    expect(mine, "our Firefox report is missing from the browser grouping").toBeTruthy();
    expect(mine.sessions).toBeGreaterThanOrEqual(1);
    expect(mine.overlay_count ?? mine.overlays_p50).toBeTruthy();

    // EVERY figure must be a JSON number. postgres.js returns `numeric`
    // as a string, so an unwrapped percentile would arrive as "20.2".
    for (const item of body.items) {
      expect(typeof item.sessions).toBe("number");
      if (item.fps_p50 !== null) expect(typeof item.fps_p50).toBe("number");
      if (item.dot_px_per_s_p50 !== null) expect(typeof item.dot_px_per_s_p50).toBe("number");
      if (item.pct_below_30fps !== null) expect(typeof item.pct_below_30fps).toBe("number");
    }
    expect(typeof body.totals.sessions).toBe("number");
    if (body.totals.fps_p50 !== null) expect(typeof body.totals.fps_p50).toBe("number");
  });

  test("group=overlays buckets the map's weight, and group=wind splits on the animation", async () => {
    const byOverlays: any = await (await app.request(
      "/api/analytics/perf?days=30&group=overlays",
      { headers: { "x-forwarded-for": "203.0.113.13" } })).json();
    const buckets = byOverlays.items.map((i: any) => i.group);
    // Our two seeded readers are at 15 and 3 overlays → opposite ends
    // of the ladder. This is the column that answers "how much does a
    // heavy shared link cost".
    expect(buckets).toContain("15+");
    expect(buckets).toContain("3-5");

    const byWind: any = await (await app.request(
      "/api/analytics/perf?days=30&phase=settled&group=wind",
      { headers: { "x-forwarded-for": "203.0.113.14" } })).json();
    expect(byWind.items.map((i: any) => i.group).sort()).toEqual(["off", "on"]);
    const on = byWind.items.find((i: any) => i.group === "on");
    expect(on.wind_on_pct).toBe(100);
  });

  test("an unknown group is a 400 — a GROUP BY is never built from the query string", async () => {
    const res = await app.request("/api/analytics/perf?group=session_id",
      { headers: { "x-forwarded-for": "203.0.113.15" } });
    expect(res.status).toBe(400);
  });

  test("a phase with no rows answers with an empty report, not a 500", async () => {
    const res = await app.request("/api/analytics/perf?days=7&phase=wind&group=gpu",
      { headers: { "x-forwarded-for": "203.0.113.16" } });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.totals).toBeTruthy();
  });

  test("group=gpu keeps the renderer string whole enough to read", async () => {
    const body: any = await (await app.request(
      "/api/analytics/perf?days=30&group=gpu",
      { headers: { "x-forwarded-for": "203.0.113.17" } })).json();
    const llvmpipe = body.items.find((i: any) => String(i.group).includes("llvmpipe"));
    expect(llvmpipe, "the software-renderer report is missing").toBeTruthy();
    // …capped at 60 chars so one exotic driver string cannot own the
    // whole response.
    expect(String(llvmpipe.group).length).toBeLessThanOrEqual(60);
  });
});
