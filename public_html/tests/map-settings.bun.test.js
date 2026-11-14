/**
 * Map settings telemetry — what readers actually use.
 *
 * Two questions this exists to answer, both of which were guesses:
 *
 *   1. WHICH OVERLAYS are worth putting where in the ~40-row layers
 *      dropdown. The dropdown is ordered by how often each row is
 *      actually switched on.
 *
 *   2. WHAT A "STORM WATCH" MAP LOOKS LIKE to the people who open one.
 *      `GET /api/analytics/map-settings?preset=storm` returns the
 *      overlays those sessions had on, with `pct_of_openers` — so a
 *      curated preset that everybody immediately turns the lightning
 *      off in is a preset with a wrong layer in it.
 *
 * The invariants that matter:
 *  - the payload carries the SLUG (stable across renames) and the NAME
 *    (what the row in the dropdown actually says), because the report
 *    keys on one and the DOM shows the other;
 *  - the write is idempotent: it replaces the session's rows for the
 *    DAY, so twenty toggles cost one row each, not twenty;
 *  - `whenReady`, never `once("load")` — Leaflet's `load` event has
 *    already fired by the time this code runs, and `once()` on an event
 *    that has already fired never runs its callback (measured: the
 *    settle POST never went out);
 *  - the ordering is re-applied whenever Leaflet rebuilds the list,
 *    because it rebuilds it on every layer change;
 *  - telemetry never reaches the reader — every failure is swallowed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const appJs = readFileSync(join(root, "app.js"), "utf8");
const analyticsTs = readFileSync(join(root, "..", "api", "src", "routes", "analytics.ts"), "utf8");
const migration = readFileSync(
  join(root, "..", "api", "migrations", "2026-11-05-map-settings-usage.sql"),
  "utf8",
);
const retention = readFileSync(join(root, "..", "scripts", "retention_prune.py"), "utf8");

describe("the settings payload", () => {
  test("carries the session, the base, the preset and the device", () => {
    expect(appJs).toMatch(/session_id: \(window\.XyzoAnalytics && window\.XyzoAnalytics\.sessionId\) \|\| null/);
    expect(appJs).toMatch(/base: s\.base \|\| null/);
    expect(appJs).toMatch(/preset: _lastPresetId/);
    expect(appJs).toMatch(/device: isPhoneViewport\(\) \? "phone" : "desktop"/);
  });

  test("carries BOTH the slug and the name for every overlay", () => {
    // The report keys on the SLUG — it survives a rename — and the DOM
    // shows the NAME, so the client needs both to match a row in the
    // dropdown. Recording only one of them breaks the ordering the
    // moment a layer is renamed.
    expect(appJs).toMatch(/slug: getLayerSlug\(n\) \|\| n/);
    expect(appJs).toMatch(/name: n,/);
    expect(appJs).toMatch(/pct: Math\.round\(\(overlayOpacityFor\(n\) \|\| 0\) \* 100\)/);
  });

  test("records the settings that are not layers at all", () => {
    // The isobar step and the wind rendering are choices a reader makes
    // and never sees in the overlay list — without them the table would
    // say nothing about how people actually draw the map.
    for (const k of ["isoStep", "isoColour", "isoSource", "windStyle", "windColour", "density"]) {
      expect(appJs).toMatch(new RegExp(`${k}:`));
    }
  });

  test("the write survives the tab closing", () => {
    // `keepalive` is what makes a fetch outlive page unload, and
    // `pagehide` is the moment a reader's settings are most complete.
    expect(appJs).toMatch(/keepalive: true/);
    expect(appJs).toMatch(/window\.addEventListener\("pagehide"/);
    expect(appJs).toMatch(/sendMapSettings\("leave"\)/);
  });

  test("is debounced, and the endpoint replaces the day's rows", () => {
    // Twenty toggles in a row must cost one write, not twenty.
    expect(appJs).toMatch(/function scheduleMapSettings\(reason\)/);
    expect(appJs).toMatch(/setTimeout\(\(\) => \{\s*\n\s*mapSettings\.timer = null;\s*\n\s*sendMapSettings\(reason\);/, );
    expect(analyticsTs).toMatch(/DELETE FROM map_settings_usage/);
    expect(analyticsTs).toMatch(/session_id = \$\{data\.session_id\} AND day = current_date/);
  });

  test("is sent once the map is ready — with whenReady, not once(load)", () => {
    // MEASURED: Leaflet's `load` event had already fired by the time
    // this line runs, so `map.once("load", …)` never ran its callback
    // and the settle POST never went out. `whenReady` calls back
    // immediately when the map is already loaded, which is the usual
    // case.
    expect(appJs).toMatch(/map\.whenReady\(\(\) => setTimeout\(\(\) => sendMapSettings\("settle"\)/);
    expect(appJs).not.toMatch(/map\.once\("load", \(\) => setTimeout\(\(\) => sendMapSettings/);
  });
});

describe("the dropdown is ordered by real use", () => {
  test("reads the usage report once, after boot", () => {
    expect(appJs).toMatch(/function loadOverlayUsage\(\)/);
    expect(appJs).toMatch(/api\/analytics\/map-settings\?days=30/);
    expect(appJs).toMatch(/mapSettings\.usage = d\.overlays/);
  });

  test("re-orders the ROWS, not the control", () => {
    // Leaflet renders the overlay list in the order of the object it
    // was given, and the usage arrives AFTER the control exists — so
    // the rows are re-ordered in the DOM. Rebuilding the control would
    // need the fetch to block boot.
    expect(appJs).toMatch(/function applyOverlayRowOrder\(\)/);
    expect(appJs).toMatch(/document\.querySelector\("\.leaflet-control-layers-overlays"\)/);
    expect(appJs).toMatch(/keyed\.sort\(\(a, b\) => a\.r - b\.r\)/);
  });

  test("resolves the slug against the overlay table, because the DOM shows the name", () => {
    expect(appJs).toMatch(/for \(const n of Object\.keys\(WEATHER_OVERLAYS\)\) nameOf\.set\(getLayerSlug\(n\) \|\| n, n\)/);
    const name = appJs.slice(appJs.indexOf("const name = u.name || nameOf.get(u.slug);"));
    expect(name).toMatch(/u\.name \|\| nameOf\.get\(u\.slug\)/);
  });

  test("an unknown row keeps its place instead of jumping to the front", () => {
    // A layer with no data yet is not worse than one with none either:
    // it keeps its relative order and goes last.
    expect(appJs).toMatch(/rank\.has\(name\) \? rank\.get\(name\) : Number\.MAX_SAFE_INTEGER/);
  });

  test("re-applies the order when Leaflet rebuilds the list", () => {
    // Leaflet rebuilds `.leaflet-control-layers-overlays` on every
    // layer change, so a one-shot sort would be undone by the first
    // checkbox the reader ticks.
    expect(appJs).toMatch(/new MutationObserver\(scheduleRowSort\)/);
    expect(appJs).toMatch(/observe\(_overlayList, \{ childList: true \}\)/);
    expect(appJs).toMatch(/function scheduleRowSort\(\)/);
  });
});

describe("the report endpoint", () => {
  test("orders overlays by distinct sessions", () => {
    expect(analyticsTs).toMatch(/count\(DISTINCT session_id\)::int AS sessions/);
    expect(analyticsTs).toMatch(/GROUP BY key\s*\n\s*ORDER BY sessions DESC/);
  });

  test("returns the display name alongside the slug", () => {
    // The report reads "💨 Wind (GFS)" rather than "wind-gfs", and the
    // client can match a row without rebuilding the slug table.
    expect(analyticsTs).toMatch(/min\(name\) AS name/);
  });

  test("answers what a given preset's openers actually had on", () => {
    // The number a preset is tuned against: `pct_of_openers` says how
    // many of the sessions that opened "storm" had each layer on.
    expect(analyticsTs).toMatch(/pct_of_openers/);
    expect(analyticsTs).toMatch(/JOIN map_settings_usage o\s*\n\s*ON o\.session_id = p\.session_id AND o\.day = p\.day AND o\.kind = 'overlay'/);
  });

  test("is capped and windowed like every other list here", () => {
    expect(analyticsTs).toMatch(/days: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(365\)\.default\(30\)/);
    expect(analyticsTs).toMatch(/LIMIT 60/);
  });

  test("is rate limited and validates the payload", () => {
    expect(analyticsTs).toMatch(/mapSettingsLimiter/);
    expect(analyticsTs).toMatch(/zValidator\("json", MapSettingsSchema\)/);
    // The overlay list is ~40 rows; 60 is headroom, not an invitation.
    expect(analyticsTs).toMatch(/z\.array\(MapSettingsOverlaySchema\)\.max\(60\)/);
  });
});

describe("the schema", () => {
  test("has a natural key so the write is idempotent", () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS map_settings_usage_natural_key/);
    expect(migration).toMatch(/\(day, session_id, kind, key\)/);
  });

  test("has a surrogate id, because the retention pruner deletes by id", () => {
    // `scripts/retention_prune.py` deletes `WHERE id IN (…)`; a table
    // with only a natural key fails with "column id does not exist" —
    // which is what happened before this was added.
    expect(migration).toMatch(/id\s+BIGSERIAL\s+PRIMARY KEY/);
  });

  test("constrains kind and pct so free text cannot land in them", () => {
    expect(migration).toMatch(/CHECK \(kind IN \('overlay', 'preset', 'base', 'setting'\)\)/);
    expect(migration).toMatch(/CHECK \(pct IS NULL OR \(pct >= 0 AND pct <= 100\)\)/);
  });

  test("is pruned with the other telemetry", () => {
    expect(retention).toMatch(/\("map_settings_usage", "day", "90 days"\)/);
  });

  test("stores no IP and no personal data", () => {
    // The session id is the random localStorage key analytics.js has
    // always used. Nothing here identifies a person — and the SCHEMA is
    // what the payload is validated against, so that is what has to be
    // clean. (The handler below it does read the client IP, for the
    // rate limiter, the way every endpoint here does; it is never
    // stored.)
    expect(migration).not.toMatch(/ip_address|user_agent|email/);
    const schema = analyticsTs.slice(
      analyticsTs.indexOf("const MapSettingsSchema = z.object({"),
      analyticsTs.indexOf("const mapSettingsLimiter"),
    );
    expect(schema).not.toMatch(/ip_address|user_agent|email|latitude|longitude/);
    // And the TABLE has no column that could hold one. The check runs
    // over the CREATE TABLE block only: a word-boundary regex over the
    // whole file matches "city" inside "opacity".
    // The closing `);` is at the START of a line: the first `);` after
    // CREATE TABLE is inside a comment ("it survives a rename);"), and
    // slicing there truncated the block before the columns — which made
    // this assertion pass for the wrong reason.
    const tblStart = migration.indexOf("CREATE TABLE IF NOT EXISTS map_settings_usage");
    const table = migration.slice(tblStart, migration.indexOf("\n);", tblStart) + 3);
    expect(table).not.toMatch(/\bip\b|country|city|email|user_agent/);
    // What it DOES hold: the session's settings and nothing else.
    expect(table).toMatch(/session_id/);
    expect(table).toMatch(/kind/);
    expect(table).toMatch(/pct/);
  });
});
