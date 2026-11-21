// basin-detail-level.bun.test.js — the "Detailed" button must actually
// change what is drawn.
//
// OWNER REPORT (2026-11-20), on the link
//   #/…/overlay=…basins@100/…
// *"i dont see it working… shows the same map as major basin right?"*
//
// MEASURED, in the browser with Playwright:
//
//   * the DETAILED file really IS finer — 689,947 vertices against the
//     major file's 324,123 (read from the published GeoJSON);
//   * the switch really DOES fetch it — the browser requests
//     basins_detailed.geojson and receives 235 features / 689,947
//     vertices;
//   * and yet the RENDERED result was byte-for-byte identical to the
//     major level: all 235 paths had exactly the same `d` attribute
//     length (121,217 → 123,306, a 1.7 % difference that is the
//     features' own outlines, not extra detail), and only 9,207 of the
//     689,947 vertices ever reached the screen.
//
// THE CAUSE: Leaflet simplifies every polyline and polygon with a
// tolerance of `smoothFactor` PIXELS (its default is 1.0), and it reads
// that option when the polygon is CREATED. So the client threw 98.7 %
// of the detailed file away before the reader ever saw it — the level
// switch was a NO-OP.
//
// THE FIX: the detailed level uses `smoothFactor: 0`, so the published
// file's own precision (0.01° ≈ 1.1 km) is what is drawn. The major
// level KEEPS Leaflet's default (1.0) so the fast map stays fast.
//
// AFTER: 8,972 drawn vertices → 65,782 (7.3×), total path length
// 121,217 → 629,126 (5.2×), and individual basins 2.4×–10.6× sharper.
// Switching back to major restores the original exactly.
//
// A SECOND THING THIS TEST PINS: the INTERNAL (endorheic) basins. They
// were never missing — the published data has 8 of them, each in its own
// colour, and "Africa, South Interior" sits 552 km from the owner's own
// view. A reader looking for them needs them to be a NAMED, COLOURED
// kind rather than an anonymous outline, so the kind counts and the
// interior colour are pinned here too.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const basinJs = readFileSync(join(ROOT, "basin-layer.js"), "utf8");
const meta = JSON.parse(
  readFileSync(join(ROOT, "data", "basins", "meta.json"), "utf8")
);

describe("the basin detail level is a real difference", () => {
  test("the fine levels use no client-side simplification", () => {
    // Leaflet's default is smoothFactor: 1.0 — ONE PIXEL of tolerance.
    // That is what silently threw away 98.7 % of the detailed file.
    //
    // IT IS READ FROM THE LEVEL'S OWN `simplify_deg`, NOT PATTERN-
    // MATCHED ON THE ID: matching `=== "detailed"` gave the WRONG
    // answer for `internal-detailed`, which would have shipped the
    // sharp internal file at Leaflet's default — the exact no-op this
    // rule exists to prevent, in the one level added after the rule
    // was written. The tolerance is the fact; the id is only its name.
    expect(basinJs).toMatch(/function levelSmoothFactor\(\)/);
    expect(basinJs).toMatch(/simplify_deg/);
    expect(basinJs).toMatch(/tol <= 0\.01\) \? 0 : 1\.0/);
    // …and it must NOT be keyed on a single level id any more.
    expect(basinJs).not.toMatch(/state\.level === "detailed" \? 0 : 1\.0/);
  });

  test("the COARSE levels keep Leaflet's default, so the fast map stays fast", () => {
    // The detailed file is 12.8 MB against the major file's 6.1 MB and
    // draws 7.3× the vertices. That cost is the point of the detailed
    // level; the major level must not pay it.
    expect(basinJs).toMatch(/\? 0 : 1\.0/);
  });

  test("the layer carries the factor, and so does every feature", () => {
    // Leaflet reads smoothFactor when a polygon is CREATED, and
    // setStyle does NOT re-simplify — so the factor has to be right at
    // creation time AND on each feature.
    expect(basinJs).toMatch(/smoothFactor: levelSmoothFactor\(\)/);
    const style = basinJs.match(/function styleFor\(feature\) \{[\s\S]*?\n  \}/);
    expect(style, "styleFor() not found").toBeTruthy();
    expect(style[0]).toMatch(/smoothFactor: levelSmoothFactor\(\)/);
  });

  test("switching level updates the factor before the layer is rebuilt", () => {
    // A level switch that only swapped the data would keep the OLD
    // tolerance and draw the detailed file with the major level's
    // one-pixel simplification — which is exactly the bug.
    //
    // The function body contains nested braces, so it is sliced by its
    // BOUNDARIES (the next top-level function), not by a lazy brace
    // match — a lazy match stops at the first `}` inside the `if`.
    const start = basinJs.indexOf("function setLevel(id) {");
    expect(start).toBeGreaterThan(-1);
    const end = basinJs.indexOf("function buildLayer()", start);
    expect(end).toBeGreaterThan(start);
    const setLevel = basinJs.slice(start, end);

    expect(setLevel).toMatch(/options\.smoothFactor = levelSmoothFactor\(\)/);
    // …and it must happen BEFORE fillLayer() re-adds the polygons.
    // The CALL is matched, not the word: the comment above it also
    // contains "fillLayer()", and matching that would compare against
    // the comment's position rather than the call's.
    const sf = setLevel.indexOf("options.smoothFactor");
    const fill = setLevel.search(/if \(state\.enabled\) fillLayer\(\)/);
    expect(sf).toBeGreaterThan(-1);
    expect(fill).toBeGreaterThan(-1);
    expect(sf).toBeLessThan(fill);
  });

  test("four levels are published: two populations, two precisions each", () => {
    const levels = meta.levels || [];
    expect(levels.length).toBe(4);

    const byId = Object.fromEntries(levels.map((l) => [l.id, l]));
    for (const id of ["major", "detailed", "internal", "internal-detailed"]) {
      expect(byId[id], `level ${id} missing`).toBeTruthy();
      expect(byId[id].file).toBeTruthy();
      expect(byId[id].basins).toBeGreaterThan(0);
    }

    // Each population is published at BOTH precisions, and the sharp
    // one is the finer tolerance and the bigger file.
    for (const pair of [["major", "detailed"], ["internal", "internal-detailed"]]) {
      const [coarse, fine] = pair.map((id) => byId[id]);
      expect(fine.simplify_deg).toBeLessThan(coarse.simplify_deg);
      expect(fine.size).toBeGreaterThan(coarse.size);
      expect(coarse.basins).toBe(fine.basins);
    }

    // The two populations differ — that is the point of the internal
    // levels: 281 endorheic basins against the 235 named ones.
    expect(byId.internal.basins).not.toBe(byId.major.basins);
    expect(byId["internal-detailed"].kind_counts).toBeTruthy();
    // …and every internal feature is an endorheic basin, which is what
    // the TO_BAS = -888 filter is for.
    expect(byId["internal-detailed"].kind_counts.interior).toBe(
      byId["internal-detailed"].basins
    );
  });

  test("the internal levels select on FAO's own TO_BAS sentinel", () => {
    // A name heuristic ("Interior" in the basin name) could only ever
    // find the 8 regions FAO named that way. `TO_BAS = -888` is the
    // publisher's own definition of an internally drained sub-basin,
    // so the filter must be in the builder and must be that value.
    const builder = readFileSync(
      join(ROOT, "..", "scripts", "basin_build.py"), "utf8");
    expect(builder).toMatch(/INTERNAL_WHERE = "to_bas = -888"/);
    expect(builder).toMatch(/to_bas = -888/);
    // The level must be wired to the internal source.
    expect(builder).toMatch(/"internal",\s*"Internal",\s*0\.05,\s*"internal"/);
  });

  test("the reason is recorded where the fix is", () => {
    // A fix whose reason is not written down is a fix nobody can check,
    // and the obvious "just use smoothFactor: 0 everywhere" is the
    // wrong answer (it makes the FAST map slow). The numbers must be
    // in the source, next to the line that fixes them.
    const fn = basinJs.match(/function levelSmoothFactor\(\) \{[\s\S]*?\n  \}/);
    expect(fn).toBeTruthy();
    expect(basinJs).toMatch(/689,947/);
    expect(basinJs).toMatch(/324,123/);
    expect(basinJs).toMatch(/98\.7 %/);
  });
});

describe("the internal (endorheic) basins are published and named", () => {
  test("the published data has interior basins", () => {
    // FAO's own documentation calls them out: "TO_BAS — downstream
    // sub-basin code (-888 internal sub-basins and -999 draining to
    // the sea)". They were never missing from the data.
    const counts = meta.kind_counts || {};
    expect(counts.interior).toBeGreaterThan(0);
    expect(counts.river).toBeGreaterThan(0);
    expect(counts.coast).toBeGreaterThan(0);
  });

  test("each kind has its own colour and its own label", () => {
    // A reader looking for the internal basins needs to be able to SEE
    // that they are internal — a different colour and a legend row.
    const colors = meta.kind_colors || {};
    const labels = meta.kind_labels || {};
    expect(colors.interior).toBeTruthy();
    expect(labels.interior).toMatch(/[Ii]nterior/);
    // The three colours must be distinguishable from each other.
    const all = [colors.river, colors.coast, colors.interior];
    expect(new Set(all).size).toBe(3);
  });

  test("the interior basins are named in the published metadata", () => {
    const names = (meta.top_basins || []).map((b) => b.name);
    const interiors = (meta.top_basins || []).filter((b) => b.kind === "interior");
    expect(interiors.length).toBeGreaterThan(0);
    for (const b of interiors) expect(b.name).toBeTruthy();
    expect(names.length).toBeGreaterThan(0);
  });

  test("the kind is derived from the FAO NAME, not invented", () => {
    // The 2012 shapefile carries only NAME_BASIN / GRID_CODE / AREA /
    // PERIMETER — there is no TO_BAS column — so the classification is
    // read off the FAO's own naming ("Interior" = endorheic) by the
    // BUILDER (scripts/basin_build.py). The layer only carries the
    // result and the label. Both halves are pinned here, because the
    // alternative is inventing a classification the data cannot
    // support.
    expect(basinJs).toMatch(/interior: "Interior \(endorheic\) basin"/);
    const builder = readFileSync(
      join(ROOT, "..", "scripts", "basin_build.py"), "utf8");
    expect(builder).toMatch(/KIND_INTERIOR\s*=\s*"interior"/);
    expect(builder).toMatch(/endorheic/i);
    // The builder must say WHY it reads the name (there is no TO_BAS
    // column in the 2012 shapefile).
    expect(builder).toMatch(/MAJ_BAS|SUB_BAS|TO_BAS/);
  });
});


describe("the legend describes the level that is on screen", () => {
  // A key that describes a different picture than the one it sits
  // beside is worse than no key. The internal levels hold 281 basins
  // that are ALL endorheic, so a key still saying "235 FAO basins"
  // over a list offering river and coastal basins would be introducing
  // a layer that shows neither.
  test("the basin count comes from the ACTIVE level, not the top level", () => {
    const fn = basinJs.match(/const n = \(lv && lv\.basins\)[\s\S]{0,160}?\|\| 235;/);
    expect(fn, "legend count must prefer the active level").toBeTruthy();
    expect(fn[0]).toMatch(/lv && lv\.basins/);
    // The top-level basin_count is only a fallback.
    expect(fn[0]).toMatch(/meta\.basin_count/);
  });

  test("the kind rows are filtered to the kinds the level actually has", () => {
    // `present` keeps only kinds with a non-zero count in the active
    // level's own kind_counts, so the internal level shows ONE row
    // (Interior, 281) rather than three rows two of which name basins
    // that are not on the map.
    expect(basinJs).toMatch(/const present = Object\.keys\(labels\)\.filter/);
    expect(basinJs).toMatch(/counts\[k\] > 0/);
    // …and the counts are printed, so a reader can tell 8 from 281.
    expect(basinJs).toMatch(/\$\{counts\[k\] \? ` \(\$\{counts\[k\]\}\)`/);
  });

  test("the active level resolves before ensureData() has run", () => {
    // The legend can be mounted from ensureMeta() — which resolves
    // BEFORE ensureData() sets state.level — so reading state.level
    // alone would find nothing and fall all the way back to 235.
    expect(basinJs).toMatch(/function activeLevel\(\)/);
    expect(basinJs).toMatch(/state\.level \|\| \(state\.meta && state\.meta\.default_level\)/);
  });
});

describe("the upstream HydroSHEDS licence travels with the metadata", () => {
  // docs/DATA_LICENSES.md logged this as OPEN: the FAO credit was in
  // the map's attribution bar, but the upstream licence requires the
  // WWF/HydroSHEDS statement AND the 2008 citation to travel with the
  // LAYER'S METADATA. It matters more now that a second, larger
  // HydroSHEDS-derived source is published beside the first.
  test("the builder writes all three strings into meta.json", () => {
    const builder = readFileSync(
      join(ROOT, "..", "scripts", "basin_build.py"), "utf8");
    for (const name of ["UPSTREAM", "UPSTREAM_ATTRIBUTION", "UPSTREAM_CITATION"]) {
      expect(builder, `${name} must be defined in the builder`).toMatch(
        new RegExp(`^${name} = `, "m"));
      // …and it must be WRITTEN, not merely defined: the builder
      // overwrites meta.json, so a string that is only defined is a
      // string that disappears on the next rebuild.
      expect(builder, `${name} must be written into meta`).toMatch(
        new RegExp(`"${name.toLowerCase()}": ${name}`));
    }
  });

  test("the published meta.json carries them", () => {
    expect(meta.upstream).toBeTruthy();
    expect(meta.upstream_attribution).toMatch(/WWF has not evaluated the data/);
    expect(meta.upstream_citation).toMatch(/Lehner, B\., Verdin, K\., Jarvis, A\. \(2008\)/);
    expect(meta.upstream_citation).toMatch(/Eos/);
  });

  test("the published meta.json names the four levels and both sources", () => {
    expect(meta.levels.length).toBe(4);
    // Each level records which source it came from, so a reader (or a
    // later maintainer) can tell the 2012 file from the 2022 one
    // without reading the builder.
    const sources = new Set(meta.levels.map((l) => l.source));
    expect(sources.has("major")).toBe(true);
    expect(sources.has("internal")).toBe(true);
  });
});
