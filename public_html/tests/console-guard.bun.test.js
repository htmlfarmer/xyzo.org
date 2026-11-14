/**
 * console-guard.js — the Firefox deprecation patch, BEHAVIOURALLY.
 *
 * The guard's own note used to say the `MouseEvent.mozPressure` /
 * `mozInputSource` warnings "cannot be suppressed from JavaScript —
 * they are browser-native warnings generated at the C++ level". That
 * was WRONG, and the proof is that the vendored Leaflet contains ZERO
 * occurrences of "pressure": nothing reads the property.
 *
 * Leaflet 1.1.1 copies the DOM event with `for (var j in src)` (its
 * `Util.extend`), and Firefox keeps `mozPressure` / `mozInputSource` as
 * ENUMERABLE getters on `MouseEvent.prototype` — so that loop READS
 * them, and reading a deprecated property is what prints the notice.
 *
 * The fix makes the two getters NON-ENUMABLE: the getter itself is
 * untouched (a direct `e.mozPressure` still works, and still warns),
 * but `for...in` no longer reaches it, so Leaflet never reads it and
 * the notice never fires.
 *
 * This file RUNS the guard against a fake `MouseEvent` and checks the
 * property's enumerability — not the source text.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const guardJs = readFileSync(join(ROOT, "console-guard.js"), "utf8");

// A fake MouseEvent with the two deprecated getters, ENUMERABLE — the
// shape Firefox uses, and the reason `for...in` reached them.
function makeFakeMouseEvent() {
  class FakeMouseEvent {
    constructor() { this.type = "mousedown"; }
  }
  Object.defineProperty(FakeMouseEvent.prototype, "mozPressure", {
    get() { return 0.5; },
    configurable: true,
    enumerable: true,        // ← Firefox's shape
  });
  Object.defineProperty(FakeMouseEvent.prototype, "mozInputSource", {
    get() { return 0; },
    configurable: true,
    enumerable: true,
  });
  return FakeMouseEvent;
}

function runGuard(FakeMouseEvent) {
  const listeners = {};
  const win = {
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
    onerror: null,
    XYZO_DEBUG: false,
  };
  const factory = new Function("window", "MouseEvent", "console", guardJs);
  // The guard replaces console.warn/error/log — hand it a stand-in so
  // the test's own output is not swallowed.
  const quiet = { warn() {}, error() {}, log() {}, info() {}, debug() {} };
  factory(win, FakeMouseEvent, quiet);
  return { win, listeners };
}

describe("console-guard — the Firefox deprecation patch", () => {
  test("the two deprecated getters become NON-ENUMABLE", () => {
    // The whole point: Leaflet's `for (var j in src)` must no longer
    // reach them, so the browser never fires the deprecation notice.
    const Fake = makeFakeMouseEvent();
    expect(Object.getOwnPropertyDescriptor(Fake.prototype, "mozPressure").enumerable)
      .toBe(true);
    runGuard(Fake);
    for (const p of ["mozPressure", "mozInputSource"]) {
      const d = Object.getOwnPropertyDescriptor(Fake.prototype, p);
      expect(d, `${p} vanished`).toBeTruthy();
      expect(d.enumerable, `${p} is still enumerable`).toBe(false);
      expect(typeof d.get, `${p} lost its getter`).toBe("function");
    }
  });

  test("the getter still WORKS — a direct read is not broken", () => {
    // Only the ENUMERABILITY changed: the value is still there, so
    // anything that reads `e.mozPressure` directly still gets it.
    const Fake = makeFakeMouseEvent();
    runGuard(Fake);
    const ev = new Fake();
    expect(ev.mozPressure).toBe(0.5);
    expect(ev.mozInputSource).toBe(0);
  });

  test("a `for...in` over an event no longer touches them", () => {
    // The mechanism, stated as a test: this is exactly what Leaflet's
    // `Util.extend` does to the DOM event.
    const Fake = makeFakeMouseEvent();
    runGuard(Fake);
    const ev = new Fake();
    const seen = [];
    for (const k in ev) seen.push(k);
    expect(seen).not.toContain("mozPressure");
    expect(seen).not.toContain("mozInputSource");
    // …and the ordinary own properties are still there.
    expect(seen).toContain("type");
  });

  test("the guard still defines XLog and still swallows the noise", () => {
    // The patch must not have cost the guard its actual job.
    const Fake = makeFakeMouseEvent();
    const { win } = runGuard(Fake);
    expect(typeof win.XLog.warn).toBe("function");
    expect(typeof win.XLog.error).toBe("function");
    expect(typeof win.XLog.log).toBe("function");
    expect(typeof win.XLog.debug).toBe("function");
  });

  test("it is a no-op where the properties do not exist", () => {
    // Chrome (and any browser without the descriptors) must not break.
    class Bare {}
    const { win } = runGuard(Bare);
    expect(typeof win.XLog.log).toBe("function");
  });
});
