/**
 * Earthquakes overlay — USGS summary feeds.
 *
 * The invariants that matter:
 *  - the module exposes the API the layers dropdown and the hash need
 *  - the four windows are exactly hour / day / week / month
 *  - the colour is the AGE of the event and the radius is the MAGNITUDE
 *  - the popup links to the USGS event page and escapes every string
 *  - the layer NEVER talks to earthquake.usgs.gov — the data is served
 *    from our own files, so a reader's browser never polls USGS
 *  - the build script's verify() is a GATE: it refuses to publish, and
 *    the control in this file proves it can actually fail
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..");
const REPO = join(ROOT, "..");
const layerJs = readFileSync(join(ROOT, "earthquake-layer.js"), "utf8");
const builder = readFileSync(join(REPO, "scripts", "earthquake_build.py"), "utf8");
const DATA = join(ROOT, "data", "earthquakes");

function loadLayer() {
  const win = {};
  // The module only touches window at load time; document/L are used
  // inside functions, so a bare window is enough.
  const fn = new Function("window", layerJs);
  fn(win);
  return win.EarthquakeLayer;
}

describe("earthquakes overlay — the module surface", () => {
  test("exposes the API the layers dropdown and the hash machinery need", () => {
    const layer = loadLayer();
    expect(layer).toBeTruthy();
    for (const fn of [
      "init", "getTileLayer", "setEnabled", "isEnabled", "onLayerToggled",
      "setOpacity", "getOpacity", "blocksClick", "setWindow", "getWindow",
      "sampleAt", "mountLegend",
    ]) {
      expect(typeof layer[fn], `${fn} missing`).toBe("function");
    }
    expect(layer.LAYER_NAME).toBe("🌐 Earthquakes (USGS)");
  });

  test("the four windows are exactly hour / day / week / month", () => {
    const layer = loadLayer();
    expect(layer.WINDOWS.map((w) => w.id)).toEqual(["hour", "day", "week", "month"]);
  });

  test("blocksClick() is false — the popup is the interaction", () => {
    const layer = loadLayer();
    expect(layer.blocksClick()).toBe(false);
    expect(layerJs).toMatch(/function blocksClick\(\)\s*\{[^}]*return false/s);
  });

  test("no console.* anywhere (the house rule is XLog)", () => {
    expect(layerJs).not.toMatch(/console\.(log|warn|error|debug|info)/);
    expect(layerJs).toMatch(/XLog\.warn/);
  });

  test("the data comes from OUR files — the browser never polls USGS", () => {
    // The layer's ONLY network calls are for its own published files.
    // Every fetch() argument is checked, so a future "just fetch the feed
    // directly" shortcut fails here.
    const fetches = [...layerJs.matchAll(/fetch\(\s*([A-Za-z_$][\w$.]*)/g)].map((m) => m[1]);
    expect(fetches.length).toBeGreaterThan(0);
    for (const f of fetches) {
      expect(["metaUrl", "windowUrl"], `fetch(${f}) reads something else`).toContain(f);
    }
    expect(layerJs).toMatch(/const BASE = "\/data\/earthquakes"/);
    expect(layerJs).toMatch(/function metaUrl\(\)\s*\{\s*return BASE \+ "\/meta\.json"/);
    expect(layerJs).toMatch(/function windowUrl\(id\)\s*\{\s*return BASE \+ "\/" \+ id \+ "\.geojson"/);
  });

  test("the pane is its own, and it is under the pin canvas", () => {
    expect(layerJs).toMatch(/const PANE = "earthquakePane"/);
    expect(layerJs).toMatch(/PANE_Z = 368/);
    // The pin canvas lives in Leaflet's overlayPane at 400.
    expect(368).toBeLessThan(400);
  });

  test("the click is hit-tested on preclick, not left to a marker click", () => {
    // MEASURED: the site's pin canvas covers the whole map with
    // pointer-events:auto, so a vector layer in a lower pane never gets
    // the click — the pin opens instead. `preclick` fires before the
    // map's own click and never fires for a drag.
    expect(layerJs).toMatch(/map\.on\("preclick", onPreClick\)/);
    expect(layerJs).toMatch(/function onPreClick\(/);
    expect(layerJs).toMatch(/function hitTest\(/);
  });
});

describe("earthquakes overlay — the two scales", () => {
  test("the colour is the age: red < 1 h, orange < 24 h, yellow < 7 d", () => {
    const layer = loadLayer();
    const H = 3600e3;
    expect(layer._colorForAge(0)).toBe("#ff2d2d");        // just now
    expect(layer._colorForAge(30 * 60e3)).toBe("#ff2d2d"); // 30 minutes
    expect(layer._colorForAge(2 * H)).toBe("#ff7a1a");    // two hours
    expect(layer._colorForAge(23 * H)).toBe("#ff7a1a");   // under a day
    expect(layer._colorForAge(25 * H)).toBe("#ffd21f");   // under a week
    expect(layer._colorForAge(6 * 24 * H)).toBe("#ffd21f");
    expect(layer._colorForAge(8 * 24 * H)).toBe("#4aa3ff");  // under a month
    expect(layer._colorForAge(40 * 24 * H)).toBe("#8b9bb4"); // older
  });

  test("the age scale is published in meta.json as well", () => {
    expect(builder).toMatch(/"#ff2d2d"/);
    expect(builder).toMatch(/"#ff7a1a"/);
    expect(builder).toMatch(/"#ffd21f"/);
    expect(builder).toMatch(/"#4aa3ff"/);
    expect(builder).toMatch(/"#8b9bb4"/);
  });

  test("the radius grows with the magnitude, and is clamped", () => {
    const layer = loadLayer();
    const r1 = layer._radiusForMag(1);
    const r3 = layer._radiusForMag(3);
    const r6 = layer._radiusForMag(6);
    expect(r3).toBeGreaterThan(r1);
    expect(r6).toBeGreaterThan(r3);
    // 3 + 2.2 * (mag - 1), clamped to 4..26
    expect(layer._radiusForMag(1)).toBeCloseTo(4, 5);
    expect(layer._radiusForMag(2)).toBeCloseTo(5.2, 5);
    expect(layer._radiusForMag(4)).toBeCloseTo(9.6, 5);
    expect(layer._radiusForMag(0)).toBe(4);       // the floor
    expect(layer._radiusForMag(12)).toBe(26);      // the ceiling
    expect(layer._radiusForMag(20)).toBe(26);
    expect(layer._radiusForMag(-3)).toBe(4);
  });

  test("the radius scale is published in meta.json", () => {
    expect(builder).toMatch(/RADIUS_SCALE/);
    expect(builder).toMatch(/"min_px": 4/);
    expect(builder).toMatch(/"max_px": 26/);
  });
});

describe("earthquakes overlay — the popup", () => {
  const props = {
    id: "us6000u4r9",
    mag: 5.4,
    place: "30 km N of Pāhala, Hawaii",
    time: 1793740999468,
    depth: 12.3,
    felt: 42,
    tsunami: true,
    type: "earthquake",
    status: "reviewed",
    alert: "green",
  };

  test("links to the USGS event page and names the event id", () => {
    const layer = loadLayer();
    const html = layer._popupHtml(props);
    expect(html).toContain("earthquake.usgs.gov/earthquakes/eventpage/");
    expect(html).toContain("us6000u4r9");
    expect(html).toContain("/executive");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("USGS event page");
  });

  test("shows the magnitude, the place, the depth, felt reports and the tsunami flag", () => {
    const layer = loadLayer();
    const html = layer._popupHtml(props);
    expect(html).toContain("5.4");
    expect(html).toContain("Pāhala");
    expect(html).toContain("12.3 km");
    expect(html).toContain("42");          // felt reports
    expect(html).toContain("Tsunami");
    expect(html).toContain("UTC");
    expect(html).toContain("Local");
  });

  test("renders a close button — Leaflet's own × is hidden by the stylesheet", () => {
    const layer = loadLayer();
    const html = layer._popupHtml(props);
    expect(html).toMatch(/popup-close-btn(-mobile)?"/);
  });

  test("escapes every piece of text (the house rule)", () => {
    const layer = loadLayer();
    const html = layer._popupHtml({
      ...props,
      place: '<img src=x onerror="alert(1)">',
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(layerJs).toMatch(/function escapeHtml\(/);
  });
});

describe("earthquakes overlay — the build", () => {
  test("the source is USGS and it is public domain", () => {
    expect(builder).toMatch(/earthquake\.usgs\.gov/);
    expect(builder).toMatch(/Public domain/);
    expect(builder).toMatch(/Earthquake Hazards Program/);
  });

  test("verify() is a GATE — it refuses to publish", () => {
    expect(builder).toMatch(/def verify\(/);
    expect(builder).toMatch(/refusing to publish/);
    expect(builder).toMatch(/raise SystemExit/);
  });

  test("verify() checks the things a swapped axis would break", () => {
    // A GeoJSON that decodes with the axes swapped still looks like a
    // plausible map, so only KNOWN PLACES catch it.
    expect(builder).toMatch(/PLACE_PROBES/);
    expect(builder).toMatch(/Japan/);
    expect(builder).toMatch(/Chile/);
    expect(builder).toMatch(/Alaska/);
    // …and the windows have to be nested and fresh.
    expect(builder).toMatch(/not nested/);
    expect(builder).toMatch(/newest event is/);
  });

  test("the CLI is the house one: --refresh, --verify-only, --out", () => {
    expect(builder).toMatch(/--refresh/);
    expect(builder).toMatch(/--verify-only/);
    expect(builder).toMatch(/--out/);
    // The ten-minute freshness window the systemd timer relies on.
    expect(builder).toMatch(/FRESH_SECONDS\s*=\s*600/);
  });
});

describe("earthquakes overlay — the published files", () => {
  test("exactly four geojson files and a meta.json are published", () => {
    expect(existsSync(DATA)).toBe(true);
    const files = readdirSync(DATA).filter((f) => f.endsWith(".geojson")).sort();
    expect(files).toEqual(["day.geojson", "hour.geojson", "month.geojson", "week.geojson"]);
    expect(existsSync(join(DATA, "meta.json"))).toBe(true);
  });

  test("meta.json carries the licence, the attribution and the counts", () => {
    const m = JSON.parse(readFileSync(join(DATA, "meta.json"), "utf8"));
    expect(typeof m.license).toBe("string");
    expect(m.license.length).toBeGreaterThan(4);
    expect(m.license).toMatch(/Public domain/);
    expect(typeof m.attribution).toBe("string");
    expect(m.attribution.length).toBeGreaterThan(4);
    expect(m.attribution).toMatch(/Geological Survey/);
    for (const w of ["hour", "day", "week", "month"]) {
      expect(typeof m.counts[w], `counts.${w}`).toBe("number");
      expect(m.counts[w]).toBeGreaterThan(0);
    }
    expect(m.windows.map((w) => w.id)).toEqual(["hour", "day", "week", "month"]);
    expect(m.age_classes.length).toBeGreaterThanOrEqual(4);
    expect(m.radius_scale).toBeTruthy();
    expect(m.event_page).toMatch(/earthquake\.usgs\.gov/);
  });

  test("every published feature is a Point with the fields the popup shows", () => {
    for (const w of ["hour", "day", "week", "month"]) {
      const fc = JSON.parse(readFileSync(join(DATA, `${w}.geojson`), "utf8"));
      expect(fc.type).toBe("FeatureCollection");
      expect(fc.features.length).toBeGreaterThan(0);
      expect(fc.features.length).toBe(m_count(w));
      for (const f of fc.features.slice(0, 200)) {
        expect(f.geometry.type).toBe("Point");
        const [lng, lat] = f.geometry.coordinates;
        expect(Math.abs(lat)).toBeLessThanOrEqual(90);
        expect(Math.abs(lng)).toBeLessThanOrEqual(180);
        expect(typeof f.properties.mag).toBe("number");
        expect(typeof f.properties.time).toBe("number");
        expect(typeof f.properties.id).toBe("string");
        expect(f.properties.id.length).toBeGreaterThan(0);
        expect(typeof f.properties.tsunami).toBe("boolean");
        expect(["hour", "day", "week", "month", "older"]).toContain(f.properties.ageClass);
      }
    }
  });

  test("the month window holds more events than the week window, and so on", () => {
    const n = (w) => JSON.parse(readFileSync(join(DATA, `${w}.geojson`), "utf8")).features.length;
    expect(n("month")).toBeGreaterThan(n("week"));
    expect(n("week")).toBeGreaterThan(n("day"));
    expect(n("day")).toBeGreaterThanOrEqual(n("hour"));
  });
});

function m_count(w) {
  const m = JSON.parse(readFileSync(join(DATA, "meta.json"), "utf8"));
  return m.counts[w];
}

// ── the control: the gate has to be ABLE to fail ────────────────────────
//
// A gate that cannot fail is worse than no gate. So the real verify() is
// driven here with a synthetic catalogue: a good one must be accepted,
// and the SAME catalogue with its axes swapped must be refused.

const NOW = 1793740999468;
const HOUR = 3600e3;

function ev(id, lat, lng, mag, ageH, place) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: {
      id,
      mag,
      place,
      time: Math.round(NOW - ageH * HOUR),
      depth: 10,
      url: "",
      felt: null,
      sig: null,
      tsunami: false,
      type: "earthquake",
      status: "reviewed",
      alert: "",
      title: "",
      ageClass: "day",
    },
  };
}

// One event per place probe, in that place's box — the catalogue a
// correct build produces.
const PROBE_EVENTS = [
  ev("al1", 57.05, -135.3, 3.4, 30, "29 km W of Sitka, Alaska"),
  ev("hi1", 19.5, -155.5, 2.8, 30, "10 km N of Pahala, Hawaii"),
  ev("jp1", 35.5, 138.5, 4.1, 0.2, "50 km E of Tokyo, Japan"),
  ev("id1", -3.2, 118.0, 4.6, 30, "20 km S of Palu, Indonesia"),
  ev("vu1", -17.5, 168.3, 5.2, 60, "60 km W of Port-Olry, Vanuatu"),
  ev("cl1", -30.5, -71.2, 4.9, 30, "40 km N of Coquimbo, Chile"),
  ev("mx1", 19.4, -99.1, 3.9, 40, "30 km SW of Mexico City, Mexico"),
  ev("pe1", -12.1, -77.0, 3.6, 30, "20 km N of Lima, Peru"),
  ev("ph1", 14.5, 121.0, 4.4, 30, "10 km S of Manila, Philippines"),
  ev("pa1", 8.6, -80.1, 3.3, 30, "30 km W of Rio Grande, Panama"),
  ev("pg1", -6.2, 147.5, 4.8, 30, "40 km NW of Kokopo, Papua New Guinea"),
  ev("big1", -18.2, 166.5, 6.5, 5, "150 km NW of Port-Olry, Vanuatu"),
];

function goodWindows() {
  return {
    hour: [PROBE_EVENTS[2]],
    day: [PROBE_EVENTS[0], PROBE_EVENTS[1], PROBE_EVENTS[2]],
    week: [PROBE_EVENTS[0], PROBE_EVENTS[1], PROBE_EVENTS[2], PROBE_EVENTS[6], PROBE_EVENTS[4]],
    month: PROBE_EVENTS,
  };
}

function runVerify(windows) {
  const dir = mkdtempSync(join(tmpdir(), "eq-verify-"));
  const dataPath = join(dir, "windows.json");
  writeFileSync(dataPath, JSON.stringify({ windows, now_ms: NOW }));
  const script = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('eqbuild', sys.argv[1])",
    "m = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(m)",
    "data = json.load(open(sys.argv[2]))",
    "try:",
    "    m.verify(data['windows'], data['now_ms'])",
    "except SystemExit as exc:",
    "    print('REFUSED: ' + str(exc)); sys.exit(3)",
    "print('ACCEPTED'); sys.exit(0)",
  ].join("\n");
  const proc = Bun.spawnSync({
    cmd: ["python3", "-c", script, join(REPO, "scripts", "earthquake_build.py"), dataPath],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

describe("earthquakes build — the gate can fail", () => {
  test("a correct catalogue is accepted", () => {
    const r = runVerify(goodWindows());
    expect(r.out).toContain("ACCEPTED");
    expect(r.code).toBe(0);
  });

  test("a catalogue with SWAPPED AXES is refused", () => {
    const w = goodWindows();
    for (const f of w.month) {
      const c = f.geometry.coordinates;
      f.geometry.coordinates = [c[1], c[0]];
    }
    const r = runVerify(w);
    expect(r.out).toContain("REFUSED");
    expect(r.out).toContain("refusing to publish");
    expect(r.code).toBe(3);
  });

  test("a stale hour window is refused", () => {
    const w = goodWindows();
    w.hour = [ev("old1", 35.5, 138.5, 4.1, 6, "50 km E of Tokyo, Japan")];
    const r = runVerify(w);
    expect(r.out).toContain("REFUSED");
  });

  test("a quiet catalogue with no strong event is refused", () => {
    const w = goodWindows();
    w.month = w.month.map((f) => ({ ...f, properties: { ...f.properties, mag: 1.2 } }));
    w.week = w.week.map((f) => ({ ...f, properties: { ...f.properties, mag: 1.2 } }));
    w.day = w.day.map((f) => ({ ...f, properties: { ...f.properties, mag: 1.2 } }));
    const r = runVerify(w);
    expect(r.out).toContain("REFUSED");
  });
});
