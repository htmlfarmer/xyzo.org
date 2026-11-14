// overlay-restore-gate.bun.test.js — a shared link must be a VIEW, not a
// settings change.
//
// Every layer module restores its own localStorage preference inside
// init(), and NINE of them did so unconditionally: city names, mag,
// temp, lightning, ocean, salinity, phytoplankton, transport and the
// field-layer family behind CAPE/IVT/wave/relief. None checked whether
// the URL already enumerated overlays, and the hash-apply path only
// ADDS — so nothing downstream could turn a restored layer back off.
//
// Reported symptom: city names "just showing up". Measured: with
// xyzo.cityLabels = "1" and a link listing seven OTHER overlays, the
// layer came on anyway (fresh browser context per case, preference
// written with add_init_script so it was in place before any app code
// ran — a reused context leaks state between cases and lies about this).
//
// The fix is ONE gate at the boot-time hash apply, not nine copies of a
// guard inside nine modules.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const clJs = readFileSync(join(ROOT, "city-labels.js"), "utf8");

// The nine modules that restore a preference in init().
const RESTORERS = [
  "city-labels.js", "mag-layer.js", "temp-layer.js", "lightning-layer.js",
  "ocean-layer.js", "salinity-layer.js", "phytoplankton-layer.js",
  "transport-layer.js", "field-layer.js",
];
const restorerSrc = RESTORERS
  .map((f) => ({ f, src: readFileSync(join(ROOT, f), "utf8") }));

describe("a URL that enumerates overlays is authoritative", () => {
  test("app.js removes any layer on the map that the hash does not name", () => {
    // The gate lives at the BOOT hash apply, after applyLayersFromParsedHash.
    expect(appJs).toMatch(/Array\.isArray\(hashView\.overlays\) && hashView\.overlays\.length > 0/);
    expect(appJs).toMatch(/if \(layer && map\.hasLayer\(layer\)\) map\.removeLayer\(layer\)/);
    // It must run AFTER the hash has been applied, or it would remove
    // the very layers the link asked for.
    const apply = appJs.indexOf("applyLayersFromParsedHash(hashView)");
    const gate = appJs.indexOf("hashView.overlays.length > 0");
    expect(apply).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(apply);
  });

  test("the removal reads the MAP, not the tracking Set", () => {
    // A layer init() puts on programmatically may never fire
    // `overlayadd` (that event comes from the layers control, which does
    // not exist yet), so _activeOverlayNames can be missing it and a
    // Set-driven removal would silently keep the layer.
    expect(appJs).toMatch(/for \(const name of Object\.keys\(WEATHER_OVERLAYS\)\)/);
    expect(appJs).toMatch(/map\.hasLayer\(layer\)/);
  });

  test("the isobar layer is gated too — it is not a WEATHER_OVERLAYS entry", () => {
    expect(appJs).toMatch(/!wanted\.has\(ISOBAR_LAYER_NAME\)/);
    expect(appJs).toMatch(/window\.IsobarLayer\.setEnabled\(false\)/);
    expect(appJs).toMatch(/__syncIsobarToggle/);
  });

  test("the writer cannot put the removed names straight back", () => {
    expect(appJs).toMatch(/if \(!wanted\.has\(name\)\) _activeOverlayNames\.delete\(name\)/);
  });
});

describe("opening a link must not overwrite the user's own preferences", () => {
  test("the xyzo.* preferences are snapshotted before the hash is applied", () => {
    const before = appJs.indexOf("_prefSnapshot");
    const apply = appJs.indexOf("applyLayersFromParsedHash(hashView)");
    expect(before).toBeGreaterThan(-1);
    // snapshot FIRST — it is the anchor for everything after it.
    expect(before).toBeLessThan(apply);
  });

  test("and restored after the gate", () => {
    const restore = appJs.indexOf("localStorage.setItem(k, _prefSnapshot[k])");
    const gate = appJs.indexOf("hashView.overlays.length > 0");
    expect(restore).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(gate);
  });

  test("non-layer preferences are never swept away", () => {
    // These three are not overlays; the sweep exists for layer state.
    for (const k of ["xyzo.debug", "xyzo.textSize", "xyzo.wikiMarkers"]) {
      expect(appJs).toContain(`"${k}"`);
    }
    expect(appJs).toMatch(/_NOT_A_LAYER_PREF/);
    // and the removal loop consults it
    const loop = appJs.slice(appJs.indexOf("_NOT_A_LAYER_PREF[k]"));
    expect(loop.slice(0, 400)).toMatch(/removeItem\(k\)/);
  });
});

describe("the nine modules keep their bare-revisit restore", () => {
  // The gate is in app.js on purpose: fixing it inside each module would
  // mean nine copies of the same guard to keep in step (the second
  // source of truth AGENTS.md warns about), and it would have to
  // distinguish a bare revisit from a link in nine places.
  test("each still restores its own preference unconditionally", () => {
    for (const { f, src } of restorerSrc) {
      const hit = /storageGet\(STORE_KEY, "0"\) === "1"/.test(src) ||
                  /storageGet\(KEY, "0"\) === "1"/.test(src);
      expect(hit, `${f} lost its restore entirely`).toBe(true);
    }
  });

  test("and none of them grew its own hash guard", () => {
    // If one starts checking location.hash on its own, the invariant
    // that app.js owns the gate is gone.
    for (const { f, src } of restorerSrc) {
      const guards = (src.match(/overlay=/g) || []).length;
      expect(guards, `${f} grew a private overlay= guard`).toBe(0);
    }
  });

  test("city-labels documents the bare-revisit contract", () => {
    expect(clJs).toMatch(/bare revisit/);
  });
});
