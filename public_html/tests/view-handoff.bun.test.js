// view-handoff.bun.test.js — switching 2D <-> 3D must carry the view.
//
// Before this module existed there was NO bridge: the globe button was a
// bare href="/globe", "Back to the map" was a bare href="/", and neither
// page read the other's storage. Switching views threw away the position,
// every overlay and every opacity, and a shared link carried nothing.
//
// The subtle part is NAMING. The flat map's getLayerSlug() emits
// `temperature`, `magnetic`, `soil-soilgrids`, `cropland-esa`,
// `land-cover-esa`, `geology-macrostrat`, while globe.js keys its
// overlays `temp`, `mag`, `soil`, `cropland`, `landcover`, `geology`.
// Six of fifteen would drop straight through the globe's
// `if (!st) continue` — a silent partial transfer that no screenshot
// would show. These tests read BOTH files and assert full coverage.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const handoffJs = readFileSync(join(ROOT, "view-handoff.js"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const globeJs = readFileSync(join(ROOT, "globe.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const globeHtml = readFileSync(join(ROOT, "globe.html"), "utf8");
const bump = readFileSync(join(ROOT, "..", "scripts", "bump_frontend.sh"), "utf8");

// Run the real module (it is a plain browser IIFE on window).
const w = {};
new Function("window", handoffJs)(w);
const H = w.XYZO_HANDOFF;
expect(H).toBeTruthy();

// ── vocabularies, read from the source of truth ────────────────────────
const globeKeys = [...new Set([...globeJs.matchAll(/\bkey: "([a-z0-9-]+)"/g)].map((m) => m[1]))];
function table(name) {
  const m = appJs.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`));
  return m ? m[1] : "";
}
const layerSlugKeys = [...table("LAYER_SLUGS").matchAll(/"([^"]+)":/g)].map((m) => m[1]);
const reverseSlugs = [...table("REVERSE_LAYER_SLUGS").matchAll(/"([^"]+)":\s*"([^"]*)"/g)].map(
  (m) => m[2]
);
// Slugs the flat map will emit for its overlays: the explicit reverse
// table plus what getLayerSlug() derives for a name it does not know.
// Used to prove the OUTBOUND direction covers every globe key.
const flatSlugs = new Set([...layerSlugKeys, ...reverseSlugs, ...Object.values(H.ALIASES)]);

// The flat map's OWN slugifier, extracted from app.js and run here —
// not copied, because a copy is a second source of truth and the second
// source of truth is the one that drifts.
function realGetLayerSlug() {
  const rev = appJs.match(/const REVERSE_LAYER_SLUGS = \{[\s\S]*?\n\};/);
  const fn = appJs.match(/function getLayerSlug\(fullName\) \{[\s\S]*?\n\}/);
  if (!rev || !fn) throw new Error("could not extract getLayerSlug() from app.js");
  return new Function(`${rev[0]}\n${fn[0]}\nreturn getLayerSlug;`)();
}

// key -> label out of the globe's OVERLAYS block, so a check can ask
// what the FLAT map would call that layer (panel-parity asserts the two
// labels are identical).
function globeLabelOf(key) {
  const start = globeJs.indexOf("const OVERLAYS");
  const end = globeJs.indexOf("\n  ];", start);
  const block = globeJs.slice(start, end);
  for (const entry of block.split(/\n    \},/)) {
    const k = entry.match(/key: "([^"]+)"/);
    const l = entry.match(/label: "([^"]+)"/);
    if (k && k[1] === key && l) return l[1];
  }
  return null;
}

describe("view-handoff module contract", () => {
  test("exposes both directions plus the two href builders", () => {
    for (const fn of ["toGlobeHash", "toFlatHash", "globeHref", "flatHref"]) {
      expect(typeof H[fn]).toBe("function");
    }
    expect(H.ALIASES).toBeTruthy();
  });

  test("both pages load it, exactly once, before their app script", () => {
    expect(indexHtml.match(/<script src="view-handoff\.js/g).length).toBe(1);
    expect(globeHtml.match(/<script src="\/view-handoff\.js/g).length).toBe(1);
    // flat: before app.js
    expect(indexHtml.indexOf("view-handoff.js")).toBeLessThan(indexHtml.indexOf("app.js?"));
    // globe: before globe.js
    expect(globeHtml.indexOf("view-handoff.js")).toBeLessThan(globeHtml.indexOf("globe.js?"));
    expect(bump).toMatch(/view-handoff\.js/);
  });
});

describe("every globe overlay key survives the trip back to the flat map", () => {
  test("the globe has overlays to transfer", () => {
    expect(globeKeys.length).toBeGreaterThanOrEqual(12);
    expect(globeKeys).toContain("temp");
    expect(globeKeys).toContain("mag");
  });

  test("each globe key resolves to a slug the flat map understands", () => {
    // After toFlatHash, the slug must be readable by resolveLayerName().
    // It has three real ways in: an exact hit in LAYER_SLUGS, an exact
    // hit in REVERSE_LAYER_SLUGS, or getLayerSlug() run over the name
    // the layer was registered under — which is how `earthquakes-usgs`
    // reads back at all, since it is DERIVED from "🌐 Earthquakes
    // (USGS)" and appears in no table. All three count; the substring
    // fallback is deliberately NOT counted, because that is what let
    // `landcover` through the net: the layer is "🗺️ Land Cover (ESA)",
    // whose slug is land-cover-esa, and "land cover" carries a space
    // the fallback cannot strip.
    const slugify = realGetLayerSlug();
    const resolvable = new Set([...layerSlugKeys, ...reverseSlugs]);
    for (const key of globeKeys) {
      const label = globeLabelOf(key);
      if (label) resolvable.add(slugify(label));
    }
    const missing = [];
    for (const key of globeKeys) {
      const flat = H.GLOBE_TO_FLAT[key] || key;
      if (!resolvable.has(flat)) missing.push(`${key} -> ${flat}`);
    }
    expect(missing, `unresolvable on the flat map: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("every flat overlay the globe can show survives the trip there", () => {
  test("flat slugs translate to a key the globe actually has", () => {
    const globeKeySet = new Set(globeKeys);
    // Only the slugs the globe CAN display are its concern; the flat map
    // has more overlays (transport, salinity, ocean, city-names ...) and
    // the globe deliberately ignores those rather than erroring.
    const dropped = [];
    for (const key of globeKeys) {
      const flat = H.GLOBE_TO_FLAT[key] || key;
      const back = H.FLAT_TO_GLOBE[flat] || flat;
      if (!globeKeySet.has(back)) dropped.push(`${key} -> ${flat} -> ${back}`);
    }
    expect(dropped, `lost on the way to the globe: ${dropped.join(", ")}`).toEqual([]);
  });

  test("no alias is applied twice (a chain would desynchronise)", () => {
    // A -> b and b -> c would make the round trip a -> c, never a -> a.
    const aliasTargets = Object.values(H.ALIASES);
    for (const t of aliasTargets) {
      expect(H.ALIASES[t], `alias target ${t} is itself a globe key`).toBeUndefined();
    }
  });
});

describe("round trips", () => {
  test("a shared slug passes through untouched", () => {
    const h = "#12.3456,76.5432,9/overlay=basins@70,rivers@85";
    expect(H.toGlobeHash(h)).toBe(h);
    expect(H.toFlatHash(h)).toBe(h);
  });

  test("temp/magnetic are translated in BOTH directions", () => {
    const flat = "#10.0,20.0,7/overlay=temperature@55,magnetic@80,basins@70";
    const globe = H.toGlobeHash(flat);
    // overlay= is ONE prefix with comma-separated entries, so the
    // translated keys appear as `temp@55,mag@80` — asserting
    // "overlay=mag@80" would fail on a perfectly correct hash.
    expect(globe).toContain("overlay=");
    expect(globe).toContain("temp@55");
    expect(globe).toContain("mag@80");
    expect(globe).toContain("basins@70");
    expect(globe).not.toContain("temperature@55");
    expect(globe).not.toContain("magnetic@80");
    // and back home again, byte for byte
    expect(H.toFlatHash(globe)).toBe(flat);
  });

  test("every alias inverts exactly", () => {
    for (const [globeKey, flat] of Object.entries(H.ALIASES)) {
      const fwd = H.toGlobeHash(`#1,2,3/overlay=${flat}@60`);
      expect(fwd).toBe(`#1,2,3/overlay=${globeKey}@60`);
      const back = H.toFlatHash(fwd);
      expect(back).toBe(`#1,2,3/overlay=${flat}@60`);
    }
  });

  test("the five aliases added in 2026-11 are all here", () => {
    // Each one dropped a PORTED layer from a real shared link: the flat
    // map writes wind-gfs / wind-speed-gfs / ocean-currents-live /
    // earthquakes-usgs / tectonic-faults-usgs, the globe keys them
    // wind / wind-speed / ocean-current / earthquakes / faults.
    for (const [globeKey, flat] of [
      ["wind", "wind-gfs"],
      ["wind-speed", "wind-speed-gfs"],
      ["ocean-current", "ocean-currents-live"],
      ["earthquakes", "earthquakes-usgs"],
      ["faults", "tectonic-faults-usgs"],
    ]) {
      expect(H.ALIASES[globeKey], `${globeKey} -> ${flat}`).toBe(flat);
      expect(H.toGlobeHash(`#1,2,3/overlay=${flat}@100`)).toContain(`overlay=${globeKey}@100`);
    }
  });

  test("opacity rides along verbatim, including bare keys", () => {
    expect(H.toGlobeHash("#0,0,3/overlay=temperature@55")).toContain("@55");
    // a bare slug (links predating opacity-in-hash) still parses
    expect(H.toGlobeHash("#0,0,3/overlay=temperature")).toContain("overlay=temp");
    expect(H.toFlatHash("#0,0,3/overlay=temp")).toContain("overlay=temperature");
  });

  test("flat-only parts pass through and are simply ignored by the globe", () => {
    const h = "#1,2,3/time=24h/search=quake/pin=99/base=satellite/overlay=temperature@55";
    const g = H.toGlobeHash(h);
    expect(g).toContain("/time=24h");
    expect(g).toContain("/search=quake");
    expect(g).toContain("/pin=99");
    expect(g).toContain("overlay=temp@55");
    // and they survive the trip back
    expect(H.toFlatHash(g)).toBe(h);
  });
});

describe("the two links", () => {
  test("globeHref keeps the position and marks the projection", () => {
    const href = H.globeHref("#12.3456,76.5432,9/overlay=temperature@55");
    expect(href.startsWith("/globe#")).toBe(true);
    expect(href).toContain("12.3456,76.5432,9");
    expect(href).toContain("overlay=temp@55");
    // Without proj=globe a shared 3D link opens FLAT and loses the
    // projection the sender chose.
    expect(href).toContain("proj=globe");
  });

  test("globeHref does not add a second proj token", () => {
    const href = H.globeHref("#1,2,3/proj=mercator");
    expect(href.match(/proj=/g).length).toBe(1);
    expect(href).toContain("proj=mercator");
  });

  test("globeHref with no state is just /globe", () => {
    expect(H.globeHref("")).toBe("/globe");
    expect(H.globeHref("#")).toBe("/globe");
  });

  test("flatHref drops proj and returns to the flat map", () => {
    const href = H.flatHref("#1,2,3/overlay=temp@55/proj=globe");
    expect(href.startsWith("/#")).toBe(true);
    expect(href).not.toContain("proj=");
    expect(href).toContain("overlay=temperature@55");
  });

  test("flatHref with no state is just /", () => {
    expect(H.flatHref("")).toBe("/");
    expect(H.flatHref("#")).toBe("/");
  });
});

describe("what the globe cannot draw rides home in the back link", () => {
  // The globe declares what it can render. Anything else in the
  // incoming link has no checkbox here, so it cannot have been switched
  // off — it must survive the trip or one visit to 3D amputates it.
  const GLOBE_KEYS = ["koppen", "soil", "wind", "basins", "isobars", "rivers", "nasa-rain"];
  H.registerGlobeKeys(GLOBE_KEYS);

  test("unrenderable overlays are put back into the back link", () => {
    const incoming = "#1,2,3/overlay=koppen@30,population-density-worldpop-1-km@45,wind-gfs@100";
    // what the globe actually drew: koppen and wind, no population layer
    const globeHash = "#1,2,3/overlay=koppen@30,wind@100";
    const href = H.flatHref(globeHash, incoming);
    expect(href).toContain("koppen@30");
    // rendered on the globe, so it comes back through the translation
    expect(href).toContain("wind-gfs@100");
    // never renderable there, so it comes back through the carry
    expect(href).toContain("population-density-worldpop-1-km@45");
  });

  test("an overlay the globe CAN draw but was switched off is not resurrected", () => {
    // The carry exists for layers with no checkbox, not for layers the
    // reader deliberately turned off — otherwise the globe could never
    // remove anything from a shared link.
    const incoming = "#1,2,3/overlay=koppen@30,basins@55";
    const globeHash = "#1,2,3/overlay=koppen@30";
    const href = H.flatHref(globeHash, incoming);
    expect(href).toContain("koppen@30");
    expect(href).not.toContain("basins");
  });

  test("the carry never duplicates an overlay the globe did draw", () => {
    const incoming = "#1,2,3/overlay=population@45,koppen@30";
    const globeHash = "#1,2,3/overlay=koppen@30";
    const href = H.flatHref(globeHash, incoming);
    expect((href.match(/koppen@30/g) || []).length).toBe(1);
    expect((href.match(/population@45/g) || []).length).toBe(1);
  });

  test("with no registered keys nothing is carried (the globe decides)", () => {
    // A caller that never registered — or registered nothing — must get
    // today's behaviour, not a guess about what the globe can draw.
    H.registerGlobeKeys(null);
    try {
      const href = H.flatHref("#1,2,3/overlay=koppen@30",
                              "#1,2,3/overlay=koppen@30,population@45");
      expect(href).not.toContain("population");
    } finally {
      H.registerGlobeKeys(GLOBE_KEYS);
    }
  });

  test("globe.js registers its keys and hands the incoming link back", () => {
    // Without the registration the carry above is dead code, and without
    // the second argument the incoming link never reaches it.
    expect(globeJs).toMatch(/XYZO_HANDOFF\.registerGlobeKeys\(/);
    expect(globeJs).toMatch(/registerGlobeKeys\(OVERLAYS\.map\(/);
    expect(globeJs).toMatch(/XYZO_HANDOFF\.flatHref\(location\.hash, INCOMING_HASH\)/);
  });

  test("the globe carries the flat map's settings through its own rewrite", () => {
    // applyGlobeHash() rebuilds location.hash from the layers it drew —
    // and the back link is built from that. Without the carry,
    // `density=`, `wind=` and `rivers=` were gone after ONE visit to 3D.
    expect(globeJs).toMatch(/h \+= flatOnlyParts\(INCOMING_HASH\)/);
    expect(globeJs).toMatch(/const GLOBE_OWNED_PREFIXES = \["overlay=", "proj=", "iso=", "isoSrc="\]/);
    // and the carried parts must be the ones the globe does NOT write,
    // or a live value could be shadowed by a stale one.
    expect(globeJs).toMatch(/function flatOnlyParts\(raw\)/);
  });
});

describe("the two views use one alias table", () => {
  test("app.js and globe.js both delegate to XYZO_HANDOFF", () => {
    // Nothing may hand-roll the translation: a second table in either
    // file is exactly the second-source-of-truth trap.
    expect(appJs).toMatch(/XYZO_HANDOFF\.globeHref\(/);
    expect(globeJs).toMatch(/XYZO_HANDOFF\.flatHref\(/);
    // and neither defines its own alias map for this
    expect(appJs).not.toMatch(/FLAT_TO_GLOBE\s*=/);
    expect(globeJs).not.toMatch(/GLOBE_TO_FLAT\s*=/);
  });

  test("the flat link is rebuilt at click time, not captured at boot", () => {
    // Overlays a user ticks do not exist when the control is created, so
    // a href read once at init hands the globe the boot view instead.
    expect(appJs).toMatch(/globe\.addEventListener\("pointerdown", syncGlobeHref\)/);
    expect(appJs).toMatch(/globe\.addEventListener\("click", syncGlobeHref\)/);
    // The assignment spans lines (a ternary guard), so match whitespace.
    expect(appJs).toMatch(/globe\.href\s*=\s*window\.XYZO_HANDOFF[\s\S]{0,240}globeHref\(getMapHash\(\)\)/);
  });

  test("the globe flushes its hash before building the back link", () => {
    // writeGlobeHash() is debounced 250 ms — toggling a layer and
    // hitting back immediately would otherwise take the OLD view home.
    expect(globeJs).toMatch(/function syncFlatHref\(\)[\s\S]{0,400}applyGlobeHash\(\);/);
    expect(globeJs).toMatch(/if \(cb \|\| sl \|\| pr\) syncFlatHref\(\);/);
    expect(globeJs).toMatch(/syncFlatHref\(\);/);
  });
});
