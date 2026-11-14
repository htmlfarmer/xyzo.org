/**
 * Serialization & route-collision guard — docs/API_BIGINT_ROUTE_CONFLICT_2026-09-23.md.
 *
 * Two production failures pinned here:
 *  1. `JSON.stringify cannot serialize BigInt` — postgres.js returns COUNT/MAX/MIN
 *     as JS BigInt; `0n ?? 0` does NOT coerce (nullish passes bigint zero through);
 *     TS type annotations don't coerce either. Any endpoint whose aggregate query
 *     results hit JSON unchanged 500s — especially at count = 0 (empty filters).
 *  2. Route shadowing — coolnessRoute defined `/stats` under the same "/api"
 *     mount as statsRoute; first registration won, so /api/stats was served by
 *     the wrong handler (404/wrong shape) until renamed /coolness-stats.
 *
 * Runtime tests run against the EMPTY xyzo test DB (bun --env-file=.env.test)
 * — empty tables are precisely the count=0 BigInt minefield. Read-only queries.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

import { statsRoute } from "../src/routes/stats";
import { pinsRoute } from "../src/routes/pins";
import { tagsRoute } from "../src/routes/tags";
import { eventsRoute } from "../src/routes/events";
import { citiesRoute } from "../src/routes/cities";
import { feedRoute } from "../src/routes/feed";
import { agentRoute } from "../src/routes/agent";

const app = new Hono();
app.route("/api", statsRoute);
app.route("/api", pinsRoute);
app.route("/api", tagsRoute);
app.route("/api", eventsRoute);
app.route("/api", citiesRoute);
app.route("/api", feedRoute);
app.route("/api", agentRoute);

const SEA_BBOX = "140.0,-10.0,140.1,-9.9"; // empty even in a populated world

/** Requests that should return a well-formed JSON 200 on an empty dataset. */
const ZERO_COUNT_ENDPOINTS: Array<[string, string]> = [
  ["stats", "/api/stats"],
  ["pins", `/api/pins?bbox=${SEA_BBOX}&limit=5`],
  ["pins-map", `/api/pins/map?bbox=${SEA_BBOX}&limit=5`],
  ["pins-stats", "/api/pins/stats"],
  ["tags", "/api/tags/top?limit=5"],
  ["events", `/api/events?bbox=${SEA_BBOX}&limit=5`],
  ["cities-trending", "/api/cities/trending?limit=5"],
  ["feed-live", "/api/feed/live?limit=5"],
];

describe("BigInt-safe serialization at count=0", () => {
  test.each(ZERO_COUNT_ENDPOINTS)("%s: JSON-safe 200", async (_name, path) => {
    const res = await app.request(path);
    const text = await res.text();
    expect(
      res.status,
      `${path} → HTTP ${res.status}: ${text.slice(0, 300)} (BigInt serialization bug class)`,
    ).toBe(200);
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      // feed/live may answer with NDJSON or SSE depending on Accept — accept only
      // first-token JSON lines
      body = null;
    }
    if (body && typeof body === "object") {
      // The list contract from AGENTS.md: { items, count } — count must be a Number.
      if ("count" in body) {
        expect(
          typeof body.count,
          `${path} returned count of type ${typeof body.count} — BigInt leaked (0n ?? 0 trap)`,
        ).toBe("number");
        expect(Number.isSafeInteger(Number(body.count))).toBe(true);
      }
      // Full-stringify safety net: nothing bigint anywhere.
      expect(() => JSON.stringify(body)).not.toThrow();
    }
  });
});

describe("route-table collision guard", () => {
  const ROOT = join(import.meta.dir, "..");
  const server = readFileSync(join(ROOT, "src/server.ts"), "utf8");

  const mounts = [...server.matchAll(/app\.route\("([^"]+)",\s*(\w+)(?:Route)?\)/g)]
    .map((m) => ({ prefix: m[1], varName: m[2] }));
  const imports = new Map<string, string>();
  for (const m of server.matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\/routes\/([\w.-]+)"/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.split(/\s+as\s+/).pop()?.trim();
      if (name) imports.set(name, m[2]);
    }
  }

  function registeredPaths(): Map<string, string[]> {
    const table = new Map<string, string[]>();
    for (const { prefix, varName } of mounts) {
      const f = imports.get(varName);
      if (!f) continue;
      const abs = join(ROOT, "src/routes", `${f}.ts`);
      if (!existsSync(abs)) continue;
      const src = readFileSync(abs, "utf8");
      for (const r of src.matchAll(/\b\w+\.(get|post|put|delete|patch)\(\s*(['"`])(\/[^'"`]*)\2/g)) {
        const full = `${prefix}/${r[3].replace(/^\//, "")}`.replace(/\/$/, "") || prefix;
        const key = `${r[1].toUpperCase()} ${full}`;
        table.set(key, [...(table.get(key) ?? []), f]);
      }
    }
    return table;
  }

  test("no two route files register the same method+path", () => {
    const clashes: string[] = [];
    for (const [key, files] of registeredPaths()) {
      if (files.length > 1) clashes.push(`${key} ← ${files.join(", ")}`);
    }
    // /api/coolness-stats was the renamed half of the original /stats clash
    // (API_BIGINT_ROUTE_CONFLICT doc). Any NEW cross-file duplicate = shadowing.
    expect(clashes.sort(), `route shadowing detected:\n${clashes.join("\n")}`).toEqual([]);
  });

  test("GET /api/stats resolves to statsRoute, not a shadow handler", async () => {
    const res = await app.request("/api/stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // statsRoute shape after the BIGINT fix: { sources, countries, stories_today, timestamp }
    // — every number coerced via ::float + safeNum() + Math.round().
    // The old shadow handler (coolness /stats) never had these keys.
    for (const k of ["sources", "countries", "stories_today"]) {
      expect(typeof body[k], `stats.${k} not a plain number`).toBe("number");
      expect(Number.isSafeInteger(body[k] as number)).toBe(true);
    }
    expect(() => JSON.stringify(body)).not.toThrow();
  });
});
