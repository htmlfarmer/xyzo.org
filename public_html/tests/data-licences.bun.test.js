// data-licences.bun.test.js — attribution and licence enforcement.
//
// Every dataset this site renders has terms. Most are CC BY (attribution
// required) or public domain. The Köppen layer was CC BY-NC-SA until
// 2026-10-29, when its source was swapped for Beck et al. 2018
// (CC BY 4.0, 1 km) — see docs/DATA_LICENSES.md §4.
//
// The point of this file: attribution is a thing the tests KNOW ABOUT,
// so it cannot quietly disappear in a refactor. Leaflet prints a
// layer's `options.attribution` in the bottom-right corner via
// L.Layer.getAttribution(), so a missing one is both a licence breach
// and an invisible one.
//
// Pinned by docs/DATA_LICENSES.md.

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const dataDir = join(ROOT, "data");

function readLayer(name) {
  const p = join(ROOT, name);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function readMeta(rel) {
  const p = join(dataDir, rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (_) {
    return null;
  }
}

// The overlays that publish their own meta.json.
const META_OVERLAYS = [
  { name: "rivers", meta: "rivers/meta.json", layer: "river-layer.js" },
  { name: "fao-rivers", meta: "rivers/fao/meta.json", layer: "fao-rivers-layer.js" },
  { name: "basins", meta: "basins/meta.json", layer: "basin-layer.js" },
  { name: "mag", meta: "mag/meta.json", layer: "mag-layer.js" },
  { name: "lightning", meta: "lightning/meta.json", layer: "lightning-layer.js" },
  { name: "phytoplankton", meta: "phytoplankton/meta.json", layer: "phytoplankton-layer.js" },
];

// The overlays whose layer module carries the attribution itself.
const LAYER_ATTRIBUTIONS = [
  { layer: "climate-layer.js", must: /Köppen-Geiger/ },
  { layer: "isobar-layer.js", must: /NOAA NCEP GFS/ },
  // The isobar layer can draw THREE analyses, and the reader can pick
  // one (the legend's analysis picker). ECMWF IFS is **CC BY 4.0** —
  // attribution REQUIRED — and the credit has to name it whenever
  // ECMWF's lines are the ones on screen. The other two are US
  // Government work (public domain) and are named too.
  { layer: "isobar-layer.js", must: /ECMWF/ },
  { layer: "isobar-layer.js", must: /CC BY 4\.0/ },
  { layer: "isobar-layer.js", must: /NOAA HRRR/ },
  { layer: "temp-layer.js", must: /NOAA NCEP GFS/ },
  { layer: "wind-layer.js", must: /NOAA NCEP GFS/ },
  { layer: "soil-layer.js", must: /SoilGrids 2\.0/ },
  // The soil layer carries TWO publishers since the USDA-orders chip:
  // the credit must be able to name OpenGeoHub too, or the corner
  // would credit ISRIC for OpenGeoHub tiles.
  { layer: "soil-layer.js", must: /OpenLandMap/ },
  { layer: "cropland-layer.js", must: /ESA WorldCover/ },
  { layer: "river-layer.js", must: /Natural Earth/ },
  { layer: "fao-rivers-layer.js", must: /FAO AQUASTAT/ },
  { layer: "fao-rivers-layer.js", must: /CC BY 4\.0/ },
  { layer: "basin-layer.js", must: /FAO/ },
  { layer: "geology-layer.js", must: /Macrostrat/ },
  { layer: "mag-layer.js", must: /attribution/ },
  { layer: "lightning-layer.js", must: /WWLLN/ },
  { layer: "phytoplankton-layer.js", must: /MIT Darwin Project/ },
  { layer: "transport-layer.js", must: /NOAA NESDIS/ },
  { layer: "salinity-layer.js", must: /NOAA GFDL/ },
  { layer: "ocean-layer.js", must: /NOAA NESDIS/ },
  // CC BY 4.0 — attribution only, and the WMTS tiles are FAO's rendering
  // of WorldPop's data, so the credit names WorldPop (the origin) not
  // just the tile server.
  { layer: "population-layer.js", must: /WorldPop/ },
  // The FAO/IIASA Harmonized World Soil Database v2.2: CC BY 4.0, and
  // the credit names both publishers (the tiles are FAO's rendering of
  // a dataset FAO and IIASA produced together).
  { layer: "hwsd-layer.js", must: /FAO & IIASA/ },
  { layer: "hwsd-layer.js", must: /CC BY 4\.0/ },
];

describe("data licences — every overlay carries its attribution", () => {
  test("each overlay layer sets an attribution Leaflet can print", () => {
    for (const spec of LAYER_ATTRIBUTIONS) {
      const src = readLayer(spec.layer);
      expect(src, spec.layer + " exists").not.toBeNull();
      // Leaflet reads options.attribution off any layer.
      expect(src, spec.layer + " sets attribution").toMatch(/attribution\s*:/);
      expect(src, spec.layer + " names its source").toMatch(spec.must);
    }
  });

  test("the CC BY-SA basins layer carries its licence on the map", () => {
    // CC BY-SA 4.0 REQUIRES attribution. It was missing until
    // 2026-10-28 — a licence obligation that no test would have caught.
    const src = readLayer("basin-layer.js");
    expect(src).toMatch(/CC BY-SA 4\.0/);
  });

  test("the CC BY geology layer carries its licence on the map", () => {
    const src = readLayer("geology-layer.js");
    expect(src).toMatch(/CC BY 4\.0/);
  });

  test("the 2026 rivers carry the UPSTREAM licence's attribution too", () => {
    // The FAO labels its layer CC BY 4.0, but the product it is derived
    // from — HydroRIVERS, from the HydroSHEDS version 1 core layers —
    // carries its OWN licence (Appendix A of the HydroSHEDS Technical
    // Documentation v1.4). That licence requires the Exhibit B
    // attribution to travel with the product's METADATA, and it is NOT
    // satisfied by the FAO credit alone. The full statement is
    // published in the layer's meta.json and the short form names WWF
    // on the map.
    const meta = readMeta("rivers/fao/meta.json");
    expect(meta).not.toBeNull();
    expect(typeof meta.upstream_attribution).toBe("string");
    expect(meta.upstream_attribution.length).toBeGreaterThan(200);
    expect(meta.upstream_attribution).toMatch(/HydroSHEDS version 1 database/);
    expect(meta.upstream_attribution).toMatch(/World Wildlife Fund/);
    // The scientific citation the licence asks for.
    expect(meta.upstream_citation).toMatch(/Lehner/);
    // And the map names the upstream publisher.
    const src = readLayer("fao-rivers-layer.js");
    expect(src).toMatch(/WWF/);
    expect(src).toMatch(/HydroSHEDS/);
  });

  test("the CC BY lightning layer carries its licence on the map", () => {
    const src = readLayer("lightning-layer.js");
    expect(src).toMatch(/CC BY 4\.0/);
  });
});

describe("data licences — published metadata records the licence", () => {
  test("each overlay's meta.json states its licence and attribution", () => {
    for (const spec of META_OVERLAYS) {
      const meta = readMeta(spec.meta);
      expect(meta, spec.meta + " exists").not.toBeNull();
      expect(typeof meta.license, spec.meta + ".license").toBe("string");
      expect(meta.license.length, spec.meta + ".license is not empty").toBeGreaterThan(4);
      expect(typeof meta.attribution, spec.meta + ".attribution").toBe("string");
      expect(meta.attribution.length).toBeGreaterThan(4);
    }
  });

  test("every published meta.json in the tree states its licence and attribution", () => {
    // The META_OVERLAYS list above is hand-maintained, so it is not
    // enough on its own: three overlays (etopo missing `license`, wind
    // and temp missing `attribution`) shipped with the gaps in 2026-10
    // precisely because nobody remembered to add them to a list. This
    // scans every meta.json actually published under data/ and holds
    // each one to the licence gate, so a new overlay is caught whether
    // or not it was registered above. Leaflet prints options.attribution
    // in the corner of the map — a missing one is a licence breach, not
    // a cosmetic gap.
    const found = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (existsSync(p) && name === "meta.json") found.push(p);
        if (name === "meta.json") continue;
        if (name === "tiles") continue; // thousands of PNGs, no metadata
        // readdirSync on a file throws; only descend into directories.
        try { if (existsSync(p) && readdirSync(p)) walk(p); } catch (_) {}
      }
    };
    walk(dataDir);

    // Every overlay that publishes metadata must be covered.
    expect(found.length).toBeGreaterThan(10);
    for (const p of found) {
      const meta = readMeta(p.slice(dataDir.length + 1).replace(/\\/g, "/"));
      expect(meta, `${p} is readable JSON`).not.toBeNull();
      const rel = p.replace(dataDir + "/", "");
      expect(typeof meta.license, `${rel}.license`).toBe("string");
      expect(meta.license.length, `${rel}.license is not empty`).toBeGreaterThan(4);
      expect(typeof meta.attribution, `${rel}.attribution`).toBe("string");
      expect(meta.attribution.length, `${rel}.attribution is not empty`).toBeGreaterThan(4);
    }
  });

  test("the Köppen layer carries an unrestricted licence", () => {
    // This used to be the site's ONE licence exposure: the source was
    // Peel et al. 2007 (CC BY-NC-SA 2.5 — NonCommercial and
    // ShareAlike), reached through Gerrit Hendriksen's KML. Beck et al.
    // 2018 remaps the same classification under CC BY 4.0 at 1 km.
    const meta = readMeta("koppen/classes.json");
    expect(meta).not.toBeNull();
    expect(meta.license).toBe("CC BY 4.0");
    expect(meta.license).not.toMatch(/NC|NonCommercial|ShareAlike/);
    expect(meta.source).toMatch(/Beck/);
    expect(meta.license_url).toMatch(/figshare/);
    // The layer module prints the licence on the map.
    const src = readLayer("climate-layer.js");
    expect(src).toMatch(/CC BY 4\.0/);
  });

  test("the lightning metadata carries its DOI and licence", () => {
    const meta = readMeta("lightning/meta.json");
    expect(meta.license).toMatch(/CC BY 4\.0/);
    expect(meta.doi).toMatch(/zenodo/);
    expect(meta.url).toMatch(/zenodo/);
  });
});

describe("data licences — the basemaps attribute themselves", () => {
  test("every tile layer in app.js carries an attribution", () => {
    // OpenStreetMap is ODbL and Esri's services require attribution.
    // A basemap without it is a licence breach, not a cosmetic gap.
    const blocks = appJs.split(/L\.tileLayer\(/).slice(1);
    expect(blocks.length).toBeGreaterThan(4);
    for (const b of blocks) {
      const head = b.slice(0, 400);
      if (!/attribution/.test(head)) {
        // The L.tileLayer( URL form puts the options in the next
        // argument; look a little further for the options object.
        expect(head, "tile layer has an attribution").toMatch(/attribution/);
      }
    }
  });

  test("the OSM and OpenTopoMap credits are present", () => {
    expect(appJs).toMatch(/OpenStreetMap contributors/);
    expect(appJs).toMatch(/OpenTopoMap/);
    expect(appJs).toMatch(/Esri/);
  });
});

describe("data licences — the EXPORT surfaces", () => {
  // An export is a DERIVATIVE. It leaves the site, and the licence
  // travels with it: CC BY 4.0 requires the attribution, and CC BY-SA
  // 4.0 (the FAO basins, Glottolog) makes the derivative share-alike.
  // So every export surface must carry BOTH, and the export writers
  // must be able to put them in the file.
  const EXPORT_SURFACES = [
    { layer: "temp-layer.js", id: "temperature" },
    { layer: "wind-layer.js", id: "wind" },
    { layer: "lightning-layer.js", id: "lightning" },
    { layer: "phytoplankton-layer.js", id: "phytoplankton" },
    { layer: "mag-layer.js", id: "magnetic" },
    { layer: "mag-layer.js", id: "magnetic-lines" },
    { layer: "wave-layer.js", id: "waves" },
    { layer: "soil-layer.js", id: "soil" },
    { layer: "cropland-layer.js", id: "cropland" },
    { layer: "cropland-layer.js", id: "landcover" },
    { layer: "etopo-layer.js", id: "relief" },
    { layer: "climate-layer.js", id: "climate" },
    { layer: "river-layer.js", id: "rivers" },
    { layer: "basin-layer.js", id: "basins" },
    { layer: "languages-layer.js", id: "languages" },
    { layer: "isobar-layer.js", id: "isobars" },
  ];

  test("every export surface names its attribution and its licence", () => {
    for (const spec of EXPORT_SURFACES) {
      const src = readLayer(spec.layer);
      expect(src, spec.layer + " exists").not.toBeNull();
      // Find the registration block for this surface id.
      const at = src.indexOf('id: "' + spec.id + '"');
      expect(at, spec.id + " is registered").toBeGreaterThan(-1);
      const block = src.slice(at, at + 900);
      // The attribution may be a literal OR a getter: the export
      // contract PRESERVES accessors, and a surface carrying two
      // publishers (soil: ISRIC for nine properties, OpenGeoHub for
      // the USDA orders) must name whichever was on screen at export
      // time. Either way a real quoted source string has to be there —
      // a bare `get attribution() { return x; }` with no name would
      // fail both branches.
      const attr = block.match(/attribution:\s*"([^"]{4,})"/)
        || block.match(/get attribution\(\)\s*\{[\s\S]*?"([^"]{4,})"/);
      expect(attr, spec.id + " has an attribution").toBeTruthy();
      expect(block, spec.id + " has a licence").toMatch(/licence:\s*"[^"]{4,}/);
    }
  });

  test("the ShareAlike datasets say so on their export surface", () => {
    // FAO basins and Glottolog are CC BY-SA 4.0: an export that
    // contains them is share-alike and must say so.
    const basins = readLayer("basin-layer.js");
    expect(basins).toMatch(/licence:\s*"CC BY-SA 4\.0"/);
    const languages = readLayer("languages-layer.js");
    expect(languages).toMatch(/licence:\s*"CC BY-SA 4\.0"/);
  });

  test("no export surface carries a NonCommercial or ShareAlike clause it cannot honour", () => {
    // The Köppen source was Peel et al. 2007 (CC BY-NC-SA) until
    // 2026-10-29. Nothing may put an NC clause back on the map — or on
    // a file that leaves the site.
    for (const spec of EXPORT_SURFACES) {
      const src = readLayer(spec.layer);
      const at = src.indexOf('id: "' + spec.id + '"');
      const block = src.slice(at, at + 900);
      expect(block, spec.id + " has no NonCommercial clause")
        .not.toMatch(/licence:\s*"[^"]*(NonCommercial|-NC)/);
    }
  });

  test("the writers put the attribution and the licence into the file", () => {
    const writers = readFileSync(join(ROOT, "export-writers.js"), "utf8");
    // A GeoTIFF carries them in its GDAL_METADATA.
    expect(writers).toMatch(/name="ATTRIBUTION"/);
    expect(writers).toMatch(/name="LICENSE"/);
    // A GeoJSON carries them as foreign members (RFC 7946 §6.1).
    expect(writers).toMatch(/fc\.attribution/);
    expect(writers).toMatch(/fc\.licence/);
    // And the ZIP always contains a licence file.
    expect(writers).toMatch(/writeAttributionText/);
  });

  test("the bundle always writes a LICENSE.txt", () => {
    const engine = readFileSync(join(ROOT, "export-engine.js"), "utf8");
    expect(engine).toMatch(/name: "LICENSE\.txt"/);
    // …and it is written from the attribution block, not a stub.
    expect(engine).toMatch(/writeAttributionText\(\{/);
  });
});

describe("data licences — the audit document", () => {
  test("docs/DATA_LICENSES.md exists and lists every overlay", () => {
    const p = join(ROOT, "..", "docs", "DATA_LICENSES.md");
    expect(existsSync(p)).toBe(true);
    const doc = readFileSync(p, "utf8");
    for (const needle of [
      "WWLLN", "CC BY 4.0", "CC BY-SA 4.0", "ODbL", "public domain",
      "GLD360", "Vaisala", "NonCommercial", "Peel", "Beck",
    ]) {
      expect(doc, "audit mentions " + needle).toContain(needle);
    }
  });

  test("the rejected dataset is recorded with its reasons", () => {
    const doc = readFileSync(join(ROOT, "..", "docs", "DATA_LICENSES.md"), "utf8");
    // If someone re-proposes GLD360 later, the reasons are on record.
    expect(doc).toMatch(/do not add/i);
    expect(doc).toMatch(/no data/i);
  });
});
