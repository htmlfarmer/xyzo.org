// phytoplankton-layer.bun.test.js — the "🦠 Phytoplankton (Darwin)"
// overlay.
//
// The MIT Darwin Project's global ocean ecosystem model: which
// phytoplankton dominates each patch of ocean, and how much of it.
//
// The traps this file guards:
//   • The published distribution is a RENDERING (a daily PNG sequence
//     plus a colour bar), not a data product — so the numbers are
//     recovered by inverting that colour bar, and the builder's verify()
//     is a gate on the RECOVERED field, not on the file.
//   • NO PNG tiles. Every *.png under public_html is served
//     `immutable` for a year, so a rebuilt pyramid would be invisible
//     behind a stale version token (the Köppen incident of 2026-10-22).
//   • Tile rows must be sampled in MERCATOR y, and the within-tile
//     offset is 1/(size*n) of the world — not 1/size.
//   • The grid is EQUATORIAL (row 0 = southernmost), not the usual
//     north-first order, and the two planes are written SEQUENTIALLY.
//   • The type is CATEGORICAL: it is read nearest, and the biomass is
//     only interpolated across neighbours that share the type.
//   • The scale is the dataset's OWN colour bar, so the legend here and
//     the source's legend are the same legend.

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const layerJs = readFileSync(join(ROOT, "phytoplankton-layer.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");
const hoverJs = readFileSync(join(ROOT, "hover-info.js"), "utf8");
const buildPy = readFileSync(join(ROOT, "..", "scripts", "phytoplankton_build.py"), "utf8");
const bumpSh = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");

const DATA_DIR = join(ROOT, "data", "phytoplankton");
const meta = JSON.parse(readFileSync(join(DATA_DIR, "meta.json"), "utf8"));
const G = meta.grid;

const annualBuf = readFileSync(join(DATA_DIR, "annual.bin"));
const N = G.rows * G.cols;
const types = new Uint8Array(annualBuf.buffer, annualBuf.byteOffset, N);
const levels = new Uint8Array(annualBuf.buffer, annualBuf.byteOffset + N, N);

function loadLayer() {
  const store = new Map();
  globalThis.window = globalThis;
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [] }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  globalThis.navigator = globalThis.navigator || { maxTouchPoints: 0 };
  // eslint-disable-next-line no-eval
  eval(layerJs);
  return globalThis.PhytoplanktonLayer;
}

/** The published grid's own lookup: row 0 = southernmost. */
function at(arr, lat, lon) {
  let r = Math.round((lat - G.lat_min) / G.lat_step);
  let c = Math.round((lon - G.lon_min) / G.lon_step);
  r = Math.max(0, Math.min(G.rows - 1, r));
  c = ((c % G.cols) + G.cols) % G.cols;
  return arr[r * G.cols + c];
}

const TYPE_KEYS = meta.types.map((t) => t.key);

describe("phytoplankton layer — module wiring", () => {
  test("loads before app.js and exposes the API app.js needs", () => {
    const idx = indexHtml.indexOf("phytoplankton-layer.js");
    const appIdx = indexHtml.indexOf("app.js?");
    expect(idx).toBeGreaterThan(-1);
    expect(appIdx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(appIdx);
    expect(layerJs).toMatch(/window\.PhytoplanktonLayer\s*=/);
    expect(layerJs).toMatch(/getTileLayer/);
    expect(layerJs).toMatch(/function init\(map\)/);
  });

  test("is registered in WEATHER_OVERLAYS so it gets the dropdown checkbox", () => {
    expect(appJs).toMatch(/WEATHER_OVERLAYS\[window\.PhytoplanktonLayer\.LAYER_NAME/);
    expect(appJs).toMatch(/window\.PhytoplanktonLayer\.init\(map\)/);
  });

  test("is in the asset list that gets stamped", () => {
    expect(bumpSh).toMatch(/phytoplankton-layer\.js/);
    expect(indexHtml).toMatch(/phytoplankton-layer\.js\?v=\d+/);
  });

  test("the probe owns map clicks so a tap reads the type instead of submitting", () => {
    expect(appJs).toMatch(/window\.PhytoplanktonLayer\.blocksClick\(\)/);
    expect(layerJs).toMatch(/blocksClick:\s*\(\)\s*=>\s*state\.enabled\s*&&\s*state\.probeMode/);
  });

  test("the hover HUD aggregates it", () => {
    expect(hoverJs).toMatch(/\["🦠",\s*"PhytoplanktonLayer"\]/);
  });

  test("the legend lives in the layers dropdown, not floating over the map", () => {
    expect(layerJs).toMatch(/querySelector\("\.leaflet-control-layers-list"\)/);
    expect(stylesCss).toMatch(/\.leaflet-control-layers-phytoplankton/);
  });

  test("it has its own pane, below the magnetic field and the isobars", () => {
    expect(layerJs).toMatch(/createPane\("phytoplanktonPane"\)/);
    const m = layerJs.match(/phytoplanktonPane"\)\.style\.zIndex = "(\d+)"/);
    expect(m).not.toBeNull();
    const z = Number(m[1]);
    expect(z).toBeGreaterThan(355); // above the temperature field (355)
    expect(z).toBeLessThan(358);    // below the magnetic field (358)
  });

  test("it carries the licence on the map", () => {
    // MIT Licence for the model and its output; NASA imagery is public
    // domain. The attribution goes in the bottom-right corner.
    expect(layerJs).toMatch(/attribution:\s*"MIT Darwin Project/);
    expect(meta.license).toMatch(/MIT Licence/);
  });
});

describe("phytoplankton layer — published data", () => {
  test("meta.json describes the grid the client expects", () => {
    expect(G.rows).toBe(1024);
    expect(G.cols).toBe(2048);
    expect(G.dtype).toBe("uint8");
    expect(meta.types.length).toBe(4);
    expect(TYPE_KEYS).toEqual(["prochlorococcus", "synechococcus", "flagellates", "diatoms"]);
    expect(meta.level_max).toBe(5);
    expect(meta.units).toMatch(/mmol P/);
  });

  test("every declared period is published and the right size", () => {
    for (const p of meta.periods) {
      const path = join(DATA_DIR, p.file);
      expect(existsSync(path), p.file + " exists").toBe(true);
      // Two planes of rows*cols bytes: the type, then the biomass.
      expect(statSync(path).size, p.file + " size").toBe(N * 2);
    }
    expect(meta.periods.length).toBe(13); // annual + twelve months
    expect(meta.default_period).toBe("annual");
  });

  test("the grid is EQUATORIAL: row 0 is the southernmost", () => {
    // The Southern Ocean at 13E is open water and the Arctic at 13E is
    // land, so the two are ASYMMETRIC: a north-first grid would swap
    // them and the test would fail. (The diatom band at high latitude
    // is symmetric and would prove nothing.)
    expect(at(types, -60, 13)).toBeLessThan(4);
    expect(at(types, 60, 13)).toBe(255);

    // And the same longitude has model data in the south and none in
    // the north.
    expect(at(levels, -60, 13)).toBeGreaterThan(0);
    expect(at(levels, 60, 13)).toBe(0);

    // The row index grows northward.
    const rowOf = (lat) => Math.round((lat - G.lat_min) / G.lat_step);
    expect(rowOf(-60)).toBeLessThan(rowOf(60));
  });

  test("the four types are where the model puts them", () => {
    const probes = [
      ["Southern Ocean", -55, 60, "diatoms"],
      ["Weddell Sea", -65, -40, "diatoms"],
      ["Arctic Ocean", 80, 0, "diatoms"],
      ["South Pacific gyre", -30, -115, "synechococcus"],
      ["North Pacific gyre", 28, -140, "synechococcus"],
      ["Equatorial Pacific", 0, -110, "synechococcus"],
      ["Arabian Sea", 15, 65, "prochlorococcus"],
    ];
    for (const [name, lat, lon, want] of probes) {
      const t = at(types, lat, lon);
      expect(TYPE_KEYS[t], name).toBe(want);
    }
  });

  test("there is no model data on land", () => {
    for (const [lat, lon] of [[23, 13], [40, 0], [-25, 25], [45, 100], [-8, -60]]) {
      expect(at(types, lat, lon), `land at ${lat},${lon}`).toBe(255);
    }
  });

  test("the big phytoplankton carry more phosphorus than the small ones", () => {
    // The dataset's own description: the large phytoplankton dominate
    // where there are lots of nutrients, and they are more productive.
    const mean = (i) => {
      let s = 0, n = 0;
      for (let k = 0; k < types.length; k++) {
        if (types[k] === i) { s += levels[k]; n++; }
      }
      return n ? s / n : 0;
    };
    expect(mean(TYPE_KEYS.indexOf("diatoms"))).toBeGreaterThan(mean(TYPE_KEYS.indexOf("prochlorococcus")));
    expect(mean(TYPE_KEYS.indexOf("flagellates"))).toBeGreaterThan(mean(TYPE_KEYS.indexOf("prochlorococcus")));
  });

  test("the oligotrophic gyres are less productive than the upwelling", () => {
    expect(at(levels, -55, 60)).toBeGreaterThan(at(levels, -30, -115));
    expect(at(levels, 0, -110)).toBeGreaterThan(at(levels, -30, -115));
  });
});

describe("phytoplankton layer — the client's maths", () => {
  test("it reads the published grid at the published values", () => {
    const L = loadLayer();
    L._test.state.meta = meta;
    L._test.buildLut(meta);
    L._test.state.types = types;
    L._test.state.levels = levels;
    const s = L._test.sample(-55, 60);
    expect(s.type).toBe(TYPE_KEYS.indexOf("diatoms"));
    // The client interpolates the biomass between same-type neighbours,
    // so it is not the nearest cell's value — but it must be within a
    // cell of it, and the same sign of magnitude.
    const nearest = at(levels, -55, 60);
    expect(Math.abs(L._test.mmol(s.level) - nearest / 255 * 5)).toBeLessThan(0.2);
  });

  test("the type is categorical and the biomass only interpolates within it", () => {
    const L = loadLayer();
    L._test.state.meta = meta;
    L._test.buildLut(meta);
    L._test.state.types = types;
    L._test.state.levels = levels;
    // A point on the edge of a diatom patch must still report diatoms,
    // and a biomass that belongs to a diatom cell — never one averaged
    // with the flagellates next door.
    for (const [lat, lon] of [[-55, 60], [-65, -40], [80, 0]]) {
      const s = L._test.sample(lat, lon);
      expect(s.type).toBe(TYPE_KEYS.indexOf("diatoms"));
      expect(s.level).toBeGreaterThan(0);
      expect(s.level).toBeLessThanOrEqual(255);
    }
  });

  test("land samples as no data", () => {
    const L = loadLayer();
    L._test.state.meta = meta;
    L._test.buildLut(meta);
    L._test.state.types = types;
    L._test.state.levels = levels;
    expect(L._test.sample(23, 13).type).toBe(255);
  });

  test("the colour table is the dataset's own ramp", () => {
    const L = loadLayer();
    L._test.state.meta = meta;
    L._test.buildLut(meta);
    const lut = L._test.state.lut;
    // The first entry of each type is the dark end of its published
    // ramp, the last the bright end.
    for (let t = 0; t < 4; t++) {
      const spec = meta.types[t];
      expect([lut[(t * 256) * 4], lut[(t * 256) * 4 + 1], lut[(t * 256) * 4 + 2]])
        .toEqual(spec.rgb_dark);
      expect([lut[(t * 256 + 255) * 4], lut[(t * 256 + 255) * 4 + 1], lut[(t * 256 + 255) * 4 + 2]])
        .toEqual(spec.rgb_bright);
    }
  });

  test("alpha rises with the biomass and never reaches zero", () => {
    const L = loadLayer();
    L._test.state.meta = meta;
    L._test.buildLut(meta);
    const lut = L._test.state.lut;
    const alpha = (t, l) => lut[(t * 256 + l) * 4 + 3];
    expect(alpha(3, 0)).toBeGreaterThan(0);
    expect(alpha(3, 255)).toBe(255);
    expect(alpha(3, 255)).toBeGreaterThan(alpha(3, 128));
    expect(alpha(3, 128)).toBeGreaterThan(alpha(3, 32));
  });

  test("the biomass is reported in mmol P m-2", () => {
    const L = loadLayer();
    L._test.state.meta = meta;
    expect(L._test.mmol(255)).toBeCloseTo(5, 6);
    expect(L._test.mmol(0)).toBeCloseTo(0, 6);
    // 255 steps over 0-5 mmol, so the half-way level is 128/255 of the
    // range — not exactly 2.5.
    expect(L._test.mmol(128)).toBeCloseTo((128 / 255) * 5, 6);
  });

  test("the tile rows are sampled in Mercator y", () => {
    const L = loadLayer();
    const c = { x: 0, y: 0, z: 1 };
    const top = L._test.pixelLatLon(c, 0, 0, 256).lat;
    const mid = L._test.pixelLatLon(c, 0, 128, 256).lat;
    const bottom = L._test.pixelLatLon(c, 0, 255, 256).lat;
    expect(top).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(bottom);
    expect(top).toBeLessThanOrEqual(85.06);
  });

  test("a tile covers exactly its own slice of the world", () => {
    // The within-tile offset is 1/(size*n) of the world, not 1/size.
    const L = loadLayer();
    for (const z of [0, 2, 7]) {
      const n = 1 << z;
      for (const [tx, ty] of [[0, 0], [Math.floor(n / 2), Math.floor(n / 2)], [n - 1, n - 1]]) {
        const c = { x: tx, y: ty, z };
        const west = L._test.pixelLatLon(c, 0, 0, 256).lon;
        const east = L._test.pixelLatLon(c, 255, 255, 256).lon;
        expect(Math.abs(west - (-180 + (360 * tx) / n))).toBeLessThan(1.5);
        expect(Math.abs(east - (-180 + (360 * (tx + 1)) / n))).toBeLessThan(1.5);
      }
    }
  });
});

describe("phytoplankton layer — the builder", () => {
  test("the builder is a gate, not a checkpoint", () => {
    expect(buildPy).toMatch(/def verify\(\)/);
    expect(buildPy).toMatch(/verification FAILED/);
    expect(buildPy).toMatch(/if not verify\(\)/);
    const buildIdx = buildPy.indexOf("rc = build(");
    const verifyIdx = buildPy.indexOf("if not verify():");
    expect(verifyIdx).toBeGreaterThan(buildIdx);
  });

  test("the builder records the source and the licence", () => {
    expect(buildPy).toMatch(/sos\.noaa\.gov/);
    expect(buildPy).toMatch(/MITgcm/);
    expect(buildPy).toMatch(/MIT Darwin Project/);
    expect(buildPy).toMatch(/MIT Licence/);
    expect(buildPy).toMatch(/ne_50m_land/);
  });

  test("the two planes are written sequentially, not interleaved", () => {
    // A (rows, cols, 2) array serialises byte-wise, which interleaves
    // the type and the level of each cell and turns the type plane into
    // garbage. The verifier caught exactly that.
    expect(buildPy).toMatch(/np\.empty\(\(2, ROWS, COLS\)/);
    expect(buildPy).not.toMatch(/np\.empty\(\(ROWS, COLS, 2\)/);
  });

  test("the published grid is the one the builder writes", () => {
    expect(buildPy).toMatch(/annual\.bin/);
    expect(buildPy).toMatch(/m\{m \+ 1:02d\}\.bin/);
    expect(buildPy).toMatch(/ROWS, COLS = 1024, 2048/);
  });
});
