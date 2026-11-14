// Every `X && ST_MakeEnvelope(...)` in the API must cast X to geometry.
//
// WHY THIS IS WORTH A TEST. `news_locations.geom` (and `news_sources`,
// `gazetteer`) are `geography(Point,4326)`. Writing
//
//     l.geom && ST_MakeEnvelope(-180, -85, 180, 85, 4326)
//
// makes PostGIS evaluate the ENVELOPE as a geodesic box, and a geodesic
// box that wide is degenerate — it does not ERROR, it quietly stops
// overlapping anything. Measured against production (2026-11-01):
//
//     envelope width   rows matched (no cast)   rows matched (cast)
//     180°                    31,721                  31,721
//     200°                     9,753                   ~15k
//     270°                     3,260                   ~30k
//     358°                         6                  41,797
//
// So the failure is INVISIBLE at city and country zoom — where every
// manual test happens — and only bites at world view, where it emptied
// "Hot & Latest" entirely (feed.ts, 7 sites) and the insights region
// queries (2 sites). `pins/map` had always cast (`location::geometry`),
// which is why the pins looked fine while the live feed showed nothing:
// two codepaths, two conventions, one of them wrong.
//
// `weather_isobars.geom` is already `geometry(LineString)`, so its cast
// is an identity cast — harmless, and it means this rule needs NO
// exception list. A uniform rule with no "…except weather.ts" clause is
// one nobody has to remember.
//
// The check counts occurrences rather than parsing operands, so it still
// fires if someone puts the operand on the previous line.
import { describe, expect, test } from "bun:test";
import postgres from "postgres";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";

const SRC = join(dirname(new URL(import.meta.url).pathname), "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("bbox overlap predicates", () => {
  test("every && ST_MakeEnvelope casts its left operand to geometry", () => {
    const uncast: string[] = [];
    let total = 0;

    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      const all = text.match(/&&\s*ST_MakeEnvelope/g) || [];
      const cast = text.match(/::geometry\s*&&\s*ST_MakeEnvelope/g) || [];
      total += all.length;
      if (all.length !== cast.length) {
        // Name the offending line so the failure is actionable.
        text.split("\n").forEach((line, i) => {
          if (/&&\s*ST_MakeEnvelope/.test(line) && !/::geometry\s*&&/.test(line)) {
            uncast.push(`${file.replace(SRC + "/", "")}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }

    // The scan must actually be looking at something — a refactor that
    // renamed the predicate would otherwise make this test pass by
    // finding nothing at all.
    expect(total).toBeGreaterThan(0);
    expect(uncast).toEqual([]);
  });

  test("the premise holds: news_locations.geom is geography", async () => {
    // If that column were ever converted to geometry, every cast above
    // stays correct — but the comment at the top of this file would
    // become a lie, and the next person to delete a cast would be
    // misled. Pin the premise to the live schema.
    const dsn = process.env.XYZO_DB_URL;
    if (!dsn) return; // no DB in this run; the cast check above still binds
    const sql = postgres(dsn, { max: 1, idle_timeout: 1 });
    try {
      const rows = await sql`
        SELECT format_type(a.atttypid, a.atttypmod) AS ty
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'public' AND c.relname = 'news_locations'
          AND a.attname = 'geom'`;
      expect(rows.length).toBe(1);
      expect(String(rows[0].ty)).toContain("geography");
    } finally {
      await sql.end();
    }
  });
});
