/**
 * weather-archive.ts — serve the ARCHIVED weather maps.
 *
 * WHAT THIS IS. The site publishes three weather fields every GFS
 * analysis cycle (four a day): the 10 m wind, the 2 m temperature and
 * the pressure contours. The workers REPLACE the previous cycle when the
 * next one lands, so "what did the weather look like on 3 March last
 * year?" had no answer. worker/weather_archive.py keeps a copy of each
 * cycle, and this route serves it — so a reader can pick a date and see
 * the map as it was.
 *
 * WHAT IS SERVED IS THE ARCHIVE'S OWN COPY of a published file: the
 * 1° wind grid, the 1° temperature grid, and the classic 4 hPa pressure
 * chart, in the same formats the live layers already consume (a binary
 * grid, a binary grid, a GeoJSON of lines). The reader is told the
 * resolution (1°) and the cycle.
 *
 * THE CYCLE IS THE NEAREST ONE AT OR BEFORE THE REQUESTED MOMENT — the
 * analysis that was in effect then. Asking for a moment between two
 * analyses gives the one before it, which is what a reader means.
 *
 * THE ARCHIVE LIVES OUTSIDE THE WEB ROOT (data/weather_archive/) and is
 * served through this route rather than as static files: it is a runtime
 * artefact (like data/nn_models/), it is far too big for the repository,
 * and the route can say what it is serving.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { RateLimiter } from "../ratelimit";
import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { join, resolve } from "path";

export const weatherArchiveRoute = new Hono();

const archiveLimiter = new RateLimiter({ max: 120, windowMs: 60 * 1000 });

// The archive root. Outside the web root; the default follows the
// service's working directory (api/), which is why it is "../data/...".
//
// READ LAZILY, not at import: a test points it at a fixture directory,
// and an environment that is set after the module was imported would
// otherwise be ignored.
function archiveRoot(): string {
  return resolve(
    process.env.XYZO_WEATHER_ARCHIVE ||
      join(process.cwd(), "..", "data", "weather_archive"),
  );
}

const FIELDS = {
  wind: { file: "wind.bin.gz", type: "application/octet-stream" },
  temp: { file: "temp.bin.gz", type: "application/octet-stream" },
  isobars: { file: "isobars.json.gz", type: "application/json" },
} as const;

type FieldName = keyof typeof FIELDS;

function listCycles(): { cycle: string; key: string; total_bytes: number; lines: number }[] {
  const out: { cycle: string; key: string; total_bytes: number; lines: number }[] = [];
  const root = archiveRoot();
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const metaPath = join(root, name, "meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      const m = JSON.parse(readFileSync(metaPath, "utf8"));
      if (!m?.cycle) continue;
      out.push({
        cycle: String(m.cycle),
        key: String(m.key || name),
        total_bytes: Number(m.total_bytes || 0),
        lines: Number(m.isobars?.lines || 0),
      });
    } catch {
      // A half-written entry is skipped, not fatal.
    }
  }
  out.sort((a, b) => (a.cycle < b.cycle ? -1 : a.cycle > b.cycle ? 1 : 0));
  return out;
}

/** The nearest cycle at or before the requested moment. */
function nearestCycle(
  cycles: { cycle: string; key: string }[],
  at: string | undefined,
): { cycle: string; key: string } | null {
  if (cycles.length === 0) return null;
  if (!at) return cycles[cycles.length - 1];
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return cycles[cycles.length - 1];
  let best: { cycle: string; key: string } | null = null;
  for (const c of cycles) {
    const ct = Date.parse(c.cycle);
    if (Number.isFinite(ct) && ct <= t) best = c;
  }
  return best ?? cycles[0];
}

// ── GET /api/weather/archive/cycles ────────────────────────────────────
weatherArchiveRoute.get("/weather/archive/cycles", async (c) => {
  const ip = (c.req.raw.headers.get("cf-connecting-ip") || c.req.header("x-forwarded-for") || "local");
  const limit = archiveLimiter.check(ip);
  if (!limit.allowed) return c.json({ error: "rate_limited" }, 429);

  const cycles = listCycles();
  c.header("Cache-Control", "public, max-age=300");
  return c.json({
    count: cycles.length,
    oldest: cycles[0]?.cycle ?? null,
    newest: cycles[cycles.length - 1]?.cycle ?? null,
    resolution: "1deg",
    step_hpa: 4,
    cycles,
  });
});

// ── GET /api/weather/archive/:field?at=<iso> ──────────────────────────
const ArchiveQuery = z.object({
  at: z.string().optional(),
});

weatherArchiveRoute.get(
  "/weather/archive/:field",
  zValidator("query", ArchiveQuery),
  async (c) => {
    const ip = (c.req.raw.headers.get("cf-connecting-ip") || c.req.header("x-forwarded-for") || "local");
    const limit = archiveLimiter.check(ip);
    if (!limit.allowed) return c.json({ error: "rate_limited" }, 429);

    // The field may be named "wind" or "wind.bin" — the archive answers
    // the SAME paths the live layers use, so a layer can switch its URL
    // by changing the prefix and nothing else.
    const raw = String(c.req.param("field") || "");
    // "meta" is a pseudo-field: it serves the archived cycle's own meta
    // for one of the real fields (named by ?field=).
    const field = raw.replace(/\.(bin|json)$/, "") as FieldName | "meta";
    if (field !== "meta" && !Object.prototype.hasOwnProperty.call(FIELDS, field)) {
      return c.json({ error: "unknown_field", fields: Object.keys(FIELDS) }, 404);
    }
    const cycles = listCycles();
    const chosen = nearestCycle(cycles, c.req.valid("query").at);
    if (!chosen) return c.json({ error: "no_archived_cycles" }, 404);

    const dir = join(archiveRoot(), chosen.key);

    // The META of the archived field. A layer needs its grid's meta
    // (the layout, the ranges, the ramp) to draw the grid at all, and the
    // live meta describes TODAY's analysis — so the archived meta comes
    // out of the cycle's own meta.json, with the archived grid's file
    // name pointed at the archive path.
    if (field === "meta") {
      const metaPath = join(dir, "meta.json");
      if (!existsSync(metaPath)) {
        return c.json({ error: "not_archived", cycle: chosen.cycle, field }, 404);
      }
      const m = JSON.parse(readFileSync(metaPath, "utf8"));
      const which = String(c.req.query("field") || "wind");
      const base = (m[which] && m[which].meta) || null;
      if (!base) return c.json({ error: "no_meta", cycle: chosen.cycle }, 404);
      const out = { ...base, run_time: m.cycle, archived_cycle: m.cycle, archived: true };
      out.grid = { ...(base.grid || {}) };
      out.grid.file = `/api/weather/archive/${which}.bin`;
      out.grid.archived = true;
      c.header("Cache-Control", "public, max-age=86400, immutable");
      c.header("X-Archive-Cycle", chosen.cycle);
      return c.json(out);
    }

    const spec = FIELDS[field as FieldName];
    const path = join(dir, spec.file);
    if (!existsSync(path)) {
      return c.json({ error: "not_archived", cycle: chosen.cycle, field }, 404);
    }
    const body = readFileSync(path);
    // The archive stores gzip-compressed files and says so, so the
    // browser decompresses them transparently — the layer receives the
    // same bytes it would have received from the live path.
    c.header("Content-Encoding", "gzip");
    c.header("Content-Type", spec.type);
    c.header("X-Archive-Cycle", chosen.cycle);
    c.header("X-Archive-Field", field);
    c.header("Cache-Control", "public, max-age=86400, immutable");
    return c.body(body);
  },
);
