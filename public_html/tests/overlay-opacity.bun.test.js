// overlay-opacity.bun.test.js — static contract checks for the per-layer
// opacity sliders in the Leaflet layers dropdown.
//
// The sliders let the user dial the transparency of any overlay they have
// switched on (NASA imagery, the Köppen climate wash). They are injected
// by public_html/overlay-opacity.js after app.js creates the layers
// control.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const opacityJs = readFileSync(join(ROOT, "overlay-opacity.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");

describe("overlay opacity — script + wiring", () => {
  test("overlay-opacity.js is loaded before app.js", () => {
    expect(indexHtml).toMatch(/<script[^>]+src="overlay-opacity\.js[^"]*"\s+defer><\/script>/);
    const at = indexHtml.indexOf('src="overlay-opacity.js');
    const appAt = indexHtml.indexOf('src="app.js');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
  });

  test("app.js mounts the sliders right after the layers control", () => {
    expect(appJs).toMatch(/L\.control\.layers\(TILE_LAYERS, WEATHER_OVERLAYS/);
    expect(appJs).toMatch(/OverlayOpacity\.restore\(WEATHER_OVERLAYS\)/);
    expect(appJs).toMatch(/OverlayOpacity\.mount\(WEATHER_OVERLAYS\)/);
    // The mount call must come after the control is added to the map.
    const controlAt = appJs.indexOf("L.control.layers(TILE_LAYERS, WEATHER_OVERLAYS");
    const mountAt = appJs.indexOf("OverlayOpacity.mount(WEATHER_OVERLAYS)");
    expect(controlAt).toBeGreaterThan(-1);
    expect(mountAt).toBeGreaterThan(controlAt);
  });

  test("one slider is created per overlay, from the overlay list", () => {
    expect(opacityJs).toMatch(/\.leaflet-control-layers-overlays/);
    expect(opacityJs).toMatch(/Object\.keys\(overlays\)/);
    expect(opacityJs).toMatch(/input\.type = "range"/);
    expect(opacityJs).toMatch(/layer\.setOpacity\(/);
  });

  test("the slider sits OUTSIDE the label so it cannot toggle the layer", () => {
    // The label wraps the checkbox — a slider inside it would toggle the
    // overlay every time it is dragged.
    expect(opacityJs).toMatch(/row\.appendChild\(label\)/);
    expect(opacityJs).toMatch(/row\.appendChild\(wrap\)/);
    expect(opacityJs).not.toMatch(/label\.appendChild\(/);
    expect(opacityJs).toMatch(/stopPropagation\(\)/);
  });

  test("a dotted leader spans name → slider on every row", () => {
    // With 20+ overlay rows the slider no longer read as belonging to
    // the name above it (2026-10-29). The leader is a decorative span
    // inserted BETWEEN the label and the slider wrap by both mount()
    // (the overlays list) and mountRow() (the isobar row, which lives
    // outside that list).
    expect(opacityJs).toMatch(/function makeLeader\(\)/);
    expect(opacityJs).toMatch(/aria-hidden/);
    const insertions = opacityJs.match(/row\.appendChild\(leader\)/g) || [];
    expect(insertions.length).toBeGreaterThanOrEqual(2); // mount + mountRow
    // And the two append calls must keep their order: label, then
    // leader, then the slider wrap — or the dots land after the slider.
    const labelAt = opacityJs.indexOf("row.appendChild(label)");
    const leaderAt = opacityJs.indexOf("row.appendChild(leader)");
    const wrapAt = opacityJs.indexOf("row.appendChild(wrap)");
    expect(labelAt).toBeGreaterThan(-1);
    expect(leaderAt).toBeGreaterThan(labelAt);
    expect(wrapAt).toBeGreaterThan(leaderAt);
  });

  test("values are stored per layer and restored on the next visit", () => {
    expect(opacityJs).toMatch(/xyzo\.overlayOpacity/);
    expect(opacityJs).toMatch(/localStorage\.setItem/);
    expect(opacityJs).toMatch(/localStorage\.getItem/);
    expect(opacityJs).toMatch(/function restore\(/);
  });

  test("the slider has an accessible name", () => {
    expect(opacityJs).toMatch(/setAttribute\("aria-label", "Opacity of "/);
    expect(opacityJs).toMatch(/input\.title = "Opacity of "/);
  });
});

describe("overlay opacity — styles", () => {
  test("the slider row and its parts are styled", () => {
    expect(stylesCss).toMatch(/\.leaflet-overlay-row\s*\{/);
    expect(stylesCss).toMatch(/\.leaflet-overlay-opacity\s*\{/);
    expect(stylesCss).toMatch(/\.leaflet-overlay-opacity-val\s*\{/);
    expect(stylesCss).toMatch(/input\[type="range"\]/);
  });

  test("the leader dots fill the gap and can never eat a click", () => {
    // Match the RULE BODY, not a character window — both rules carry
    // long explanatory comments before the declarations.
    const rule = (sel) => {
      const m = stylesCss.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
      return m ? m[1] : "";
    };
    const leader = rule(".leaflet-overlay-leader");
    expect(leader).not.toBe("");
    // flex:1 grows it into whatever space is left; the label must hug
    // its text (flex:0 1 auto) or there is no gap to draw in.
    expect(leader).toMatch(/flex:\s*1 1 auto/);
    expect(leader).toMatch(/pointer-events:\s*none/);
    const label = rule(".leaflet-overlay-row > label");
    expect(label).toMatch(/flex:\s*0 1 auto/);
  });
});

// ── the opacity travels in the shared link ───────────────────────────────
//
// A shared link has to carry the EXACT style, and the opacity is part of
// the style. The hash format is `/overlay=basins@40,rivers@100`; a bare
// slug still parses and means 100%, so links shared before this change
// keep working.
describe("overlay opacity — in the shared link", () => {
  test("the hash serialises the opacity next to each overlay slug", () => {
    expect(appJs).toMatch(/getMapHash/);
    expect(appJs).toMatch(/overlayOpacityFor\(name\)/);
    expect(appJs).toMatch(/`\$\{slug\}@\$\{pct\}`/);
  });

  test("the parser reads `slug@pct` and still accepts a bare slug", () => {
    expect(appJs).toMatch(/lastIndexOf\("@"\)/);
    expect(appJs).toMatch(/opacity:\s*null/);
    expect(appJs).toMatch(/pct \/ 100/);
  });

  test("a restored opacity is applied to the layer AND to the slider", () => {
    expect(appJs).toMatch(/function applyOverlayOpacity\(/);
    // A LINK's opacity is a VIEW, not a preference: the reader must see
    // what the sender saw, and their own stored opacity must survive
    // opening someone else's map. So the link's value goes on the layer
    // and the slider (applyView) and NOT into the store (set).
    expect(appJs).toMatch(/OverlayOpacity\.applyView\(/);
    expect(opacityJs).toMatch(/function applyView\(name, value\)/);
    expect(opacityJs).toMatch(/Opacity of " \+ name/);
  });

  test("a link's opacity survives the slider remount", () => {
    // The boot snapshot restores the stored opacities and the remount
    // that follows re-applies them — which used to put the reader's
    // opacity back and silently DISCARD the link's, a few milliseconds
    // after it was applied. The view override is what stops that.
    expect(opacityJs).toMatch(/const VIEW_OVERRIDES = Object\.create\(null\)/);
    expect(opacityJs).toMatch(/VIEW_OVERRIDES\[key\] != null/);
    // And the reader's own slider move ends the override: a choice wins.
    expect(opacityJs).toMatch(/delete VIEW_OVERRIDES\[key\]/);
  });

  test("the hash reports the LIVE opacity, not the stored preference", () => {
    // The two disagree exactly when a link set an opacity — the link's
    // value is on the layer, the preference is in the store, and the
    // boot snapshot rolls the store back. Reading the store first made
    // the URL describe the preference instead of the map: the picture
    // said 35 % and the link said 85 %.
    const body = appJs.slice(appJs.indexOf("function overlayOpacityFor("));
    const fn = body.slice(0, body.indexOf("\n}"));
    const layerRead = fn.indexOf("layer.options.opacity");
    const storeRead = fn.indexOf("OverlayOpacity.get(");
    expect(layerRead).toBeGreaterThan(-1);
    expect(storeRead).toBeGreaterThan(-1);
    expect(layerRead).toBeLessThan(storeRead);
    // And the isobar layer, which is not a registered overlay, is read
    // from its own getter.
    expect(fn).toMatch(/IsobarLayer\.getOpacity\(\)/);
  });

  test("the module exposes a getter so the hash can read the current value", () => {
    expect(opacityJs).toMatch(/function get\(overlays, key\)/);
    // `reset` joined the export list on 2026-10-30 (the layers panel's
    // ⤢ Reset button puts every slider back to its layer's own default).
    // `applyView` joined it on 2026-11-03 (a shared link's opacity is a
    // view, not a preference).
    expect(opacityJs).toMatch(/window\.OverlayOpacity = \{ mount, restore, mountRow, get, set, applyView, reset \}/);
  });

  test("moving a slider refreshes the hash", () => {
    expect(opacityJs).toMatch(/xyzo:overlay-opacity/);
    expect(appJs).toMatch(/xyzo:overlay-opacity/);
    expect(appJs).toMatch(/updateUrlHash\(\)/);
  });

  test("the sliders are re-mounted after a layer change", () => {
    // Leaflet rebuilds the overlays list on every layer change, which
    // wipes the injected slider rows. Without the re-mount the sliders
    // disappear on first use, and a shared link that restores overlays
    // comes up with no sliders at all.
    expect(appJs).toMatch(/function remountOverlaySliders\(/);
    expect(appJs).toMatch(/overlayadd[\s\S]{0,120}remountOverlaySliders/);
    expect(appJs).toMatch(/overlayremove[\s\S]{0,120}remountOverlaySliders/);
  });
});

// ── runtime: a layer without setOpacity must not break mount() ──────────
//
// 2026-10-28: RiverLayer returned a bare L.geoJSON (no setOpacity),
// mount() threw, app.js aborted before `const pinMarkers`, and the map
// died with a TDZ error. These tests load the REAL module with stubbed
// DOM/localStorage and call mount()/restore() with a hostile overlay
// list — the exact shape that crashed production.

describe("overlay opacity — runtime resilience", () => {
  function makeStorage(seed = {}) {
    const m = new Map(Object.entries(seed));
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _dump: () => Object.fromEntries(m),
    };
  }

  function makeDom(overlayNames) {
    // Minimal layers-dropdown skeleton matching Leaflet's markup.
    const overlays = {
      children: [],
      className: "",
      // mount() reads the labels off the OVERLAYS container (that is
      // where Leaflet puts them), so the mock has to answer the query.
      querySelectorAll: (sel) => (sel === "label" ? labelNodes.map((n) => n.label) : []),
    };
    const labelNodes = [];
    for (const name of overlayNames) {
      const cb = { type: "checkbox", checked: false };
      const label = {
        textContent: name,
        children: [cb],
        parentNode: null,
        classList: { contains: () => false },
      };
      // row wrapper mirrors .leaflet-overlay-row insertion
      const row = {
        className: "leaflet-overlay-row",
        parentNode: null,
        children: [],
        // mount() checks this to decide whether the label is already
        // wrapped; before mounting it is not.
        classList: { contains: () => false },
        insertBefore(node) { this.children.push(node); node.parentNode = this; },
        appendChild(node) { this.children.push(node); node.parentNode = this; },
        querySelector: (sel) => row._q(sel),
        querySelectorAll: (sel) => row._qa(sel),
        _q() { return null; },
        _qa() { return []; },
      };
      label.parentNode = row;
      row.children.push(label);
      labelNodes.push({ label, row, cb });
      overlays.children.push(row);
    }
    const list = {
      className: "leaflet-control-layers-list",
      children: [overlays],
      // mount() reads the labels off the list; the mock has to answer
      // the same query the real Leaflet DOM does.
      querySelectorAll: (sel) => (sel === "label" ? labelNodes.map((n) => n.label) : []),
      querySelector: (sel) =>
        sel.includes("overlays") || sel.includes("leaflet-control-layers-list")
          ? (sel.includes("overlays") ? overlays : list)
          : null,
      appendChild() {},
    };
    overlays.parentNode = list;
    return { list, overlays, labelNodes };
  }

  function loadModule(storage) {
    const src = readFileSync(join(ROOT, "overlay-opacity.js"), "utf8");
    // The IIFE reads bare `localStorage`; pass it as a parameter so the
    // free variable resolves inside the function scope.
    const fn = new Function("localStorage", src);
    fn(storage);
    // The module attaches to `this`/window — in bun, the global object.
    return globalThis.OverlayOpacity;
  }

  test("mount() survives an overlay with no setOpacity", () => {
    const storage = makeStorage();
    const dom = makeDom(["💧 Rivers", "🛰️ NASA Satellite"]);
    // document.querySelector must return our list for the overlay selector
    const realDoc = globalThis.document;
    globalThis.document = {
      querySelector: (sel) =>
        sel.includes("overlays") ? dom.overlays :
        sel.includes("layers-list") ? dom.list : null,
      createElement: () => {
        const el = {
          style: {}, className: "", children: [],
          setAttribute() {}, appendChild(c) { this.children.push(c); },
          addEventListener() {},
          _pn: null,
          get parentNode() { return this._pn; },
          // Leaflet's DOM sets parentNode on insert; a getter-only
          // property makes the mock throw.
          set parentNode(v) { this._pn = v; },
        };
        return el;
      },
    };
    try {
      const mod = loadModule(storage);
      expect(typeof mod?.mount).toBe("function");
      const applied = [];
      const overlays = {
        "💧 Rivers": {},                                        // hostile
        "🛰️ NASA Satellite": { setOpacity: (v) => applied.push(v) },
      };
      expect(() => mod.mount(overlays)).not.toThrow();
      // The well-behaved layer still received a numeric opacity.
      expect(applied.length).toBeGreaterThan(0);
      expect(typeof applied[0]).toBe("number");
      expect(applied[0]).toBeGreaterThanOrEqual(0);
      expect(applied[0]).toBeLessThanOrEqual(1);
    } finally {
      if (realDoc === undefined) delete globalThis.document;
      else globalThis.document = realDoc;
      delete globalThis.OverlayOpacity;
    }
  });

  test("restore() ignores a layer without setOpacity instead of throwing", () => {
    // The STORED value is keyed to the well-behaved layer; the hostile
    // one has no stored value AND no setOpacity, so restore() must
    // skip it without throwing.
    const storage = makeStorage({
      "xyzo.overlayOpacity": JSON.stringify({ "🛰️ NASA Satellite": 0.4 }),
    });
    const mod = loadModule(storage);
    try {
      expect(() => mod.restore({ "💧 Rivers": {} })).not.toThrow();
      // and still applies to a well-behaved neighbour
      const applied = [];
      expect(() =>
        mod.restore({ "💧 Rivers": {}, "🛰️ NASA Satellite": { setOpacity: (v) => applied.push(v) } })
      ).not.toThrow();
      expect(applied[0]).toBeCloseTo(0.4, 5);
    } finally {
      delete globalThis.OverlayOpacity;
    }
  });

  test("set() applies to the layer AND persists; get() reads it back", () => {
    const storage = makeStorage();
    const mod = loadModule(storage);
    try {
      const applied = [];
      const overlays = { "🌍 Köppen Climate": { setOpacity: (v) => applied.push(v) } };
      mod.set(overlays, "🌍 Köppen Climate", 0.35);
      expect(applied[applied.length - 1]).toBeCloseTo(0.35, 5);
      expect(mod.get(overlays, "🌍 Köppen Climate")).toBeCloseTo(0.35, 5);
      const raw = JSON.parse(storage.getItem("xyzo.overlayOpacity"));
      expect(raw["🌍 Köppen Climate"]).toBeCloseTo(0.35, 5);
    } finally {
      delete globalThis.OverlayOpacity;
    }
  });

  test("get() reports a shared link's opacity, not the stored preference", () => {
    // The reader's own preference is 100 %; a link asked for 37 %, and
    // the map is SHOWING 37 %. get() has exactly one caller —
    // getMapHash() — so reading the store first meant the URL said 100
    // and re-sharing the link silently reset the opacity. Measured on
    // the live map for basins, rivers, magnetic, ocean currents,
    // language regions, earthquakes and faults: every one drew 37 %
    // while its URL said 100 %, in BOTH views (the globe reads the same
    // `slug@pct`).
    const storage = makeStorage({
      "xyzo.overlayOpacity": JSON.stringify({ "💧 Rivers": 1 }),
    });
    const mod = loadModule(storage);
    try {
      const overlays = { "💧 Rivers": { setOpacity: () => {} } };
      mod.applyView("💧 Rivers", 0.37);
      expect(mod.get(overlays, "💧 Rivers")).toBeCloseTo(0.37, 5);
      // and a link's opacity must NOT become the reader's preference
      const raw = JSON.parse(storage.getItem("xyzo.overlayOpacity"));
      expect(raw["💧 Rivers"]).toBeCloseTo(1, 5);
      // The reader moving the slider ends the override: their choice
      // wins from then on, and it is what the URL reports.
      mod.set(overlays, "💧 Rivers", 0.6);
      expect(mod.get(overlays, "💧 Rivers")).toBeCloseTo(0.6, 5);
    } finally {
      delete globalThis.OverlayOpacity;
    }
  });
});
