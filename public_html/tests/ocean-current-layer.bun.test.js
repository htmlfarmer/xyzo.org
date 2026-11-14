// ocean-current-layer.bun.test.js — the LIVE ocean-current overlay.
//
// The layer is the second ocean-current overlay on the site: the first
// one (ocean-layer.js) is a FROZEN NOAA SOS frame, and a picture
// cannot show flow. This one carries the OSCAR u/v pair and animates
// particles along it, so the physics — not a frame — is the contract.
//
// What this pins:
//   · the published grid exists and is a u/v PAIR (planar), not a
//     picture;
//   · the layer animates particles in GEOGRAPHIC space and projects
//     them per frame (the same rules the wind layer follows);
//   · longitude WRAPS, it does not reject, and the column past the
//     last one WRAPS too;
//   · a degree of longitude shrinks by cos(lat);
//   · the trail is trimmed by LENGTH, never by a frame count;
//   · `schedule()` runs from `finally`, so one bad particle can never
//     freeze the animation;
//   · the frame chain SURVIVES A HIDDEN TAB and restarts when the tab
//     comes back (the Firefox bug);
//   · the pane never swallows a map click;
//   · the build script refuses to publish a field with no ocean in it.
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const layerJs = readFileSync(join(ROOT, "ocean-current-layer.js"), "utf8");
const buildPy = readFileSync(join(ROOT, "..", "scripts", "ocean_currents_build.py"), "utf8");
const meta = JSON.parse(readFileSync(join(ROOT, "data", "ocean", "meta.json"), "utf8"));

describe("the published ocean-current grid", () => {
  test("grid.bin and meta.json are published", () => {
    expect(existsSync(join(ROOT, "data", "ocean", "grid.bin"))).toBe(true);
    expect(existsSync(join(ROOT, "data", "ocean", "meta.json"))).toBe(true);
  });

  test("it is a u/v PAIR, planar, not a picture", () => {
    expect(meta.grid.layout).toBe("planar_uv");
    expect(meta.grid.cols).toBeGreaterThan(100);
    expect(meta.grid.rows).toBeGreaterThan(50);
    const expected = meta.grid.rows * meta.grid.cols * 4;   // two Int16 planes
    const size = readFileSync(join(ROOT, "data", "ocean", "grid.bin")).length;
    expect(size).toBe(expected);
  });

  test("it carries a licence and an attribution", () => {
    expect(typeof meta.license).toBe("string");
    expect(meta.license.length).toBeGreaterThan(10);
    expect(typeof meta.attribution).toBe("string");
    expect(meta.attribution.length).toBeGreaterThan(10);
  });

  test("the speed range is plausible for an ocean surface current", () => {
    // A maximum above 3 m/s or a median below 0.02 m/s means the
    // decode is wrong, not that the ocean changed.
    expect(meta.range_ms[1]).toBeGreaterThan(0.2);
    expect(meta.range_ms[1]).toBeLessThan(4.0);
    expect(meta.mean_ms).toBeGreaterThan(0.02);
    expect(meta.mean_ms).toBeLessThan(1.0);
  });
});

describe("the ocean-current layer's contract", () => {
  test("it exposes the house API", () => {
    expect(layerJs).toMatch(/window\.OceanCurrentLayer\s*=/);
    for (const fn of ["init", "getTileLayer", "setEnabled", "setOpacity",
                      "getOpacity", "blocksClick", "mountLegend", "sampleAt"]) {
      expect(layerJs).toContain(fn + ":");
    }
    expect(layerJs).toMatch(/LAYER_NAME:\s*LAYER_NAME/);
  });

  test("the physics are the wind layer's physics", () => {
    // Longitude WRAPS.
    expect(layerJs).toMatch(/\(\(\(lng - g\.lon_min\) % 360\) \+ 360\) % 360/);
    // The column past the last one WRAPS; the latitude axis clamps.
    expect(layerJs).toMatch(/const x1 = \(x0 \+ 1\) % g\.cols, y1 = Math\.min\(y0 \+ 1, g\.rows - 1\)/);
    // A degree of longitude shrinks by cos(lat).
    expect(layerJs).toMatch(/const cosLat = Math\.max\(Math\.cos\(\(p\.lat \* Math\.PI\) \/ 180\), 0\.05\)/);
    expect(layerJs).toMatch(/const dLng = \(\(u \/ sp\) \* stepDeg\) \/ cosLat;/);
  });

  test("the trail is trimmed by LENGTH, never by a frame count", () => {
    expect(layerJs).toMatch(/TRAIL_PX/);
    expect(layerJs).toMatch(/if \(acc >= TRAIL_PX\)/);
    // A frame-count trim would look like `hist.length > N` alone.
    expect(layerJs).not.toMatch(/hist\.length > \d+/);
  });

  test("schedule() runs from finally, so a bad frame cannot freeze it", () => {
    const fn = layerJs.slice(layerJs.indexOf("function step(now)"));
    expect(fn).toMatch(/finally\s*\{\s*schedule\(\);/);
    expect(fn).toMatch(/catch \(err\)/);
  });

  test("the canvas is re-anchored on every pan", () => {
    // The pane's translate persists after a drag, so the canvas has to
    // be re-anchored or the whole field rides away from its geography.
    expect(layerJs).toMatch(/function anchorCanvas\(map\)/);
    expect(layerJs).toMatch(/containerPointToLayerPoint\(\[0, 0\]\)/);
    expect(layerJs).toMatch(/moveend zoomend resize/);
  });

  test("it never swallows a map click", () => {
    // …unless the PROBE is armed: an armed probe owns the click, so a
    // tap reads the current instead of opening the submitter. The
    // layer's own test pins the armed case; the unarmed case (the
    // default) must still let the click through.
    expect(layerJs).toMatch(/function blocksClick\(\)\s*\{\s*return !!\(state\.enabled && state\.probeMode\);/);
  });

  test("the PROBE is wired — it was a button that did NOTHING", () => {
    // The legend has shipped a "Probe" button since the layer landed,
    // but showProbe() was never CALLED: arming it did nothing at all.
    // The probe must hang off Leaflet's own mouse event, so it reads
    // the point under the cursor.
    expect(layerJs).toMatch(/map\.on\("mousemove"/);
    expect(layerJs).toMatch(/showProbe\(e\.latlng, e\.containerPoint\)/);
    expect(layerJs).toMatch(/function showProbe\(latlng, containerPoint\)/);
    // The armed state is remembered, and the legend says so.
    expect(layerJs).toMatch(/state\.probeMode = storageGet\(PROBE_STORE_KEY, "0"\) === "1"/);
    expect(layerJs).toMatch(/aria-pressed.*state\.probeMode/s);
  });

  test("the ARROWS style is a REAL renderer", () => {
    // The legend offered an "Arrows" chip and nothing ever read
    // state.style, so clicking it changed the button and not the map.
    expect(layerJs).toMatch(/function renderArrows\(ctx, map\)/);
    expect(layerJs).toMatch(/state\.style === "arrows"/);
    // The ocean's median current is 0.11 m/s, so the wind layer's
    // 0.2 m/s cut-off would leave the whole ocean blank.
    expect(layerJs).toMatch(/const ARROW_MIN_MS = 0\.02;/);
  });

  test("the probe reads Leaflet's latlng, not the offsets", () => {
    // The pin canvas is 300 px wider than the map and offset by -300,
    // so e.offsetX/offsetY read 300 px too big. The COMMENTS mention
    // them (that is why they are forbidden), so the CODE is checked
    // with the comments stripped.
    const code = layerJs
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/offsetX/);
    expect(code).not.toMatch(/offsetY/);
  });

  test("it never uses console.*", () => {
    expect(layerJs).not.toMatch(/console\.(log|warn|error|debug)/);
  });

  test("its pane has its own z-index", () => {
    const m = layerJs.match(/const PANE_Z = (\d+);/);
    expect(m).not.toBeNull();
    // 369 is free in the overlay stack (365 rivers, 366 wind speed,
    // 367 faults, 368 earthquakes, 370 the wind animation).
    expect(Number(m[1])).toBe(369);
  });
});

describe("the build script refuses to publish a broken field", () => {
  test("verify() is a gate", () => {
    expect(buildPy).toMatch(/def verify\(blob: bytes, meta: dict\)/);
    expect(buildPy).toMatch(/raise SystemExit\("verify\(\) failed — refusing to publish"\)/);
  });

  test("it checks the real ocean, not just a count", () => {
    expect(buildPy).toMatch(/South Equatorial Current flows west/);
    expect(buildPy).toMatch(/Gulf Stream/);
    expect(buildPy).toMatch(/Antarctic Circumpolar Current/);
    expect(buildPy).toMatch(/the Sahara is land/);
    expect(buildPy).toMatch(/the axes are not swapped/);
  });

  test("it writes the grid and the meta", () => {
    expect(buildPy).toMatch(/grid\.bin/);
    expect(buildPy).toMatch(/meta\.json/);
    expect(buildPy).toMatch(/"layout":\s*"planar_uv"/);
  });
});

// ── the frame chain and a HIDDEN TAB ──────────────────────────────────
//
// THE FIREFOX BUG (found 2026-11-04).
//
// The layer's frame chain used to be:
//
//     function step(now) {
//       state.raf = 0;
//       if (!state.enabled) return;
//       if (document.hidden) { state.lastT = 0; return; }   // <-- no schedule()
//       ...
//       try { ... } finally { schedule(); }
//     }
//
// That `document.hidden` branch returns BEFORE the `finally`, so the
// chain is never re-scheduled — and nothing else ever re-scheduled it.
//
// Firefox KEEPS FIRING requestAnimationFrame in a background tab,
// throttled to about 1 Hz. Chrome SUSPENDS it. So in Firefox the first
// background frame ran, hit the branch, and the chain was dead for
// good: the reader switched tabs, came back, and the currents were
// frozen permanently. Chrome never saw it, because its suspended rAF
// means `step()` never runs at all while the tab is hidden.
//
// These tests RUN the module — not a regex over it — so the contract
// is behavioural: a hidden tab must not hold a frame, and the tab
// coming back must restart the chain.
describe("the ocean-current layer — the frame chain", () => {
  const gridBuf = readFileSync(join(ROOT, "data", "ocean", "grid.bin"));

  function boot() {
    const rafs = new Map();
    let nextId = 1;
    const docHandlers = {};
    const win = { XLog: { warn() {}, log() {}, debug() {}, error() {} } };

    const canvas = {
      className: "", style: {}, width: 0, height: 0,
      getContext: () => ({
        setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {},
        lineTo() {}, stroke() {},
      }),
    };
    const document = {
      hidden: false,
      body: { appendChild() {} },
      createElement: () => canvas,
      // The layers control may not exist yet — mountLegend() has to
      // survive that (it retries).
      querySelector: () => null,
      getElementById: () => null,
      addEventListener(type, fn) { (docHandlers[type] = docHandlers[type] || []).push(fn); },
      dispatch(type) { (docHandlers[type] || []).forEach((fn) => fn()); },
    };
    const store = new Map();
    const localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    };
    const pane = { style: {}, appendChild() {} };
    const map = {
      on() {},
      getPane: () => pane,
      createPane: () => pane,
      getSize: () => ({ x: 800, y: 600 }),
      latLngToContainerPoint: () => ({ x: 10, y: 10 }),
      containerPointToLayerPoint: () => ({ x: 0, y: 0 }),
      containerPointToLatLng: () => ({ lat: 0, lng: 0 }),
      hasLayer: () => false,
      addLayer() {},
    };
    const fetchStub = (url) => {
      if (String(url).endsWith("meta.json")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(meta) });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(
          new Uint8Array(gridBuf).buffer
        ),
      });
    };

    // eslint-disable-next-line no-new-func
    const factory = new Function(
      "window", "document", "localStorage", "requestAnimationFrame",
      "cancelAnimationFrame", "fetch", "L",
      layerJs
    );
    factory(
      win, document, localStorage,
      (fn) => { const id = nextId++; rafs.set(id, fn); return id; },
      (id) => rafs.delete(id),
      fetchStub,
      { Layer: { extend: (o) => function () { Object.assign(this, o); } } }
    );
    return { win, document, map, rafs };
  }

  test("a hidden tab must NOT hold a frame", async () => {
    const { win, document, map, rafs } = boot();
    win.OceanCurrentLayer.init(map);
    win.OceanCurrentLayer.setEnabled(true);
    await new Promise((r) => setTimeout(r, 60));

    const st = win.OceanCurrentLayer._state;
    expect(st.enabled).toBe(true);
    expect(st.raf).not.toBe(0);
    const pending = Array.from(rafs.values());
    expect(pending.length).toBe(1);

    // The tab goes to the background.
    document.hidden = true;
    document.dispatch("visibilitychange");
    expect(st.raf).toBe(0);

    // A frame that arrives while the tab is hidden must NOT schedule
    // the next one — that is what killed the chain. This is the exact
    // shape of the Firefox failure: the background frame arrives and
    // the chain has to end there, not carry on by itself.
    const before = rafs.size;
    pending[0](performance.now());
    expect(rafs.size).toBe(before);
    expect(st.raf).toBe(0);

    // And the guard has to live in schedule() itself, not only in the
    // handler — a guard that lives only in the handler still lets a
    // background frame through.
    expect(layerJs).toMatch(
      /function schedule\(\)[\s\S]{0,3000}?if \(document\.hidden\) return;/
    );
  });

  test("the tab coming back MUST restart the chain", async () => {
    const { win, document, map, rafs } = boot();
    win.OceanCurrentLayer.init(map);
    win.OceanCurrentLayer.setEnabled(true);
    await new Promise((r) => setTimeout(r, 60));

    const st = win.OceanCurrentLayer._state;
    expect(st.raf).not.toBe(0);

    document.hidden = true;
    document.dispatch("visibilitychange");
    expect(st.raf).toBe(0);

    document.hidden = false;
    document.dispatch("visibilitychange");
    // A NEW frame was asked for: the chain is alive again.
    expect(st.raf).not.toBe(0);
    expect(rafs.size).toBeGreaterThan(0);
  });
});

// ── the PROVENANCE: the field's date, and the coastal mask ──────────
//
// TWO FINDINGS (2026-11-04), both measured against the raw source:
////
//  1. THE COMPOSITE IS FROM 26 SEPTEMBER 2014. The ERDDAP that
//     serves OSCAR was loaded in February 2015 and carries nothing
//     newer, so a DAILY timer had been re-publishing the same twelve-
//     year-old field since the overlay shipped. Every PHYSICS gate
//     passed it, because no gate ever looked at the DATE. So the
//     build now has a FRESHNESS gate, and the legend shows the date.
//
//  2. THE CURRENTS STOP SHORT OF THE COAST because the SOURCE is an
//     altimetry inversion: satellite altimetry has no valid solution
//     in shallow, river-influenced water. It is not this layer — the
//     published grid was checked CELL-FOR-CELL against the raw
//     NetCDF (0 value mismatches), and the daily NOAA CoastWatch
//     geostrophic product has the SAME hole in the same cells.
describe("the ocean-current field's provenance", () => {
  test("the published meta carries the composite's own DATE", () => {
    expect(typeof meta.source_date).toBe("string");
    expect(meta.source_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The old value was a Python bytes literal ("b'Sep.26,2014'").
    expect(meta.source_period).not.toMatch(/^b['"]/);
  });

  test("the measured coastal coverage is published, not assumed", () => {
    expect(typeof meta.coastal_coverage).toBe("number");
    expect(meta.coastal_coverage).toBeGreaterThan(0.3);
    expect(meta.coastal_coverage).toBeLessThan(0.7);
    expect(meta.coastal_coverage_note).toMatch(/altimetry/i);
  });

  test("the build has a FRESHNESS gate — a stale composite is refused", () => {
    // The gate that was missing while a 2014 field passed every
    // other check.
    expect(buildPy).toMatch(/MAX_AGE_DAYS\s*=\s*\d+/);
    expect(buildPy).toMatch(/STALE_PROBLEM/);
    expect(buildPy).toMatch(/REFUSING to publish a composite that is/);
    // The date comes from the NUMERIC time axis, not the bytes
    // literal in the PERIOD attribute.
    expect(buildPy).toMatch(/OSCAR_EPOCH/);
    expect(buildPy).toMatch(/source_date/);
  });

  test("the freshness limit is the SAME in the build and the client", () => {
    const b = buildPy.match(/MAX_AGE_DAYS\s*=\s*(\d+)/);
    const c = layerJs.match(/MAX_AGE_DAYS\s*=\s*(\d+)/);
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    expect(Number(c[1])).toBe(Number(b[1]));
  });

  test("the legend shows the field's date and how old it is", () => {
    expect(layerJs).toMatch(/function provenanceHtml\(\)/);
    expect(layerJs).toMatch(/meta\.source_date|state\.meta/);
    expect(layerJs).toMatch(/oc-legend-date/);
    // The age is COMPUTED, not read from the meta, so a meta
    // published days ago still tells the truth today.
    expect(layerJs).toMatch(/function ageInDays\(iso\)/);
  });

  test("the legend explains the coastal gap instead of hiding it", () => {
    expect(layerJs).toMatch(/COASTAL_NOTE/);
    expect(layerJs).toMatch(/oc-legend-note/);
    expect(layerJs).toMatch(/altimetry/i);
  });

  test("the layer's NAME does not claim to be live", () => {
    // It is an OSCAR composite, and the name says so.
    expect(layerJs).toMatch(/LAYER_NAME = "🌊 Ocean currents \(OSCAR\)"/);
    expect(layerJs).not.toMatch(/LAYER_NAME = "🌊 Ocean currents \(live\)"/);
  });

  test("the URL slug is STILL ocean-currents-live — the contract", () => {
    // The owner's own links and the Earth-portrait preset use it, and
    // an identifier is not a claim of freshness.
    const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
    expect(appJs).toMatch(/"ocean-currents-live":\s*"🌊 Ocean currents \(OSCAR\)"/);
    expect(appJs).toMatch(/"🌊 Ocean currents \(OSCAR\)":\s*"ocean-currents-live"/);
  });

  test("the globe's label matches the flat map's", () => {
    const globeJs = readFileSync(join(ROOT, "globe.js"), "utf8");
    expect(globeJs).toMatch(/label: "🌊 Ocean currents \(OSCAR\)"/);
  });
});
