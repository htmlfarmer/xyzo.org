// test_mobile_pins.js — Regression test: the map must work on a phone.
//
// Pins are drawn on a CANVAS that is deliberately larger than the map and
// offset by a buffer (25% of the map's largest dimension), so the pin's
// screen position is NOT its map position. The canvas hit-test converts
// the click with the CANVAS's own rect:
//
//     mx = clientX - canvasRect.left
//     pin at containerPoint + buffer
//
// If any of that drifts — a different buffer on mobile, a stale rect
// after a scroll, a touch event that reports the wrong coordinates — a
// tap opens the WRONG story, or opens nothing. That is invisible on
// desktop and obvious on a phone.
//
// This checks, on a real iPhone profile:
//   1. pins load and draw within the budget
//   2. a tap on a pin's own canvas pixel opens THAT pin's story
//   3. the mobile popup renders the story tree
//   4. the mobile ✕ closes the popup
//   5. nothing overflows the viewport horizontally
//   6. the layers dropdown opens and its toggles work
//   7. mobile is not starved of pins relative to desktop
//
// Run:  bun tests/test_mobile_pins.js
// CI:   node tests/test_mobile_pins.js          (exits 0 = pass, 1 = fail)

const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The bundled Playwright may expect a newer browser build than the one
// installed on this host. Resolve whatever chromium is actually present
// rather than failing with "Executable doesn't exist".
function findChromium() {
  const root = path.join(os.homedir(), ".cache", "ms-playwright");
  if (!fs.existsSync(root)) return null;
  const dirs = fs
    .readdirSync(root)
    .filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
    .sort()
    .reverse();
  for (const d of dirs) {
    for (const rel of [
      "chrome-linux64/chrome",
      "chrome-headless-shell-linux64/chrome-headless-shell",
    ]) {
      const p = path.join(root, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function launchArgs() {
  const exe = findChromium();
  return exe ? { headless: true, executablePath: exe } : { headless: true };
}

const URL = "https://xyzo.org/#51.51,-0.12,12";
const PIN_TIMEOUT_MS = 12_000;
const MOBILE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  // A real UA matters: getClientHardwareCapabilities() detects mobile by
  // the user agent and caps the pin request at 1500 (vs 5400 on desktop).
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
};
const DESKTOP = { viewport: { width: 1440, height: 900 } };

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

// The pin the renderer will hit-test, with the exact client coordinates
// of its own canvas pixel.
function PICK_PIN() {
  const m = map;
  for (const p of canvasRenderer._pins) {
    const lat = p.location?.lat ?? p.lat, lng = p.location?.lng ?? p.lng;
    if (typeof lat !== "number" || p.isOverflowBadge) continue;
    const pt = m.latLngToContainerPoint([lat, lng]);
    if (pt.x < 16 || pt.y < 16 || pt.x > m.getSize().x - 16 || pt.y > m.getSize().y - 16) continue;
    const buffer = Math.round(Math.max(m.getSize().x, m.getSize().y) * 0.25);
    const canvasRect = canvasRenderer._canvas.getBoundingClientRect();
    const mapRect = m.getContainer().getBoundingClientRect();
    return {
      id: String(p.id),
      title: (p.title || "").slice(0, 50),
      // Where the renderer thinks the pin is, in client coordinates.
      tapX: canvasRect.left + pt.x + buffer,
      tapY: canvasRect.top + pt.y + buffer,
      buffer,
      canvasLeft: canvasRect.left,
      mapLeft: mapRect.left,
    };
  }
  return null;
}

async function openPage(browser, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // `map` also matches the DOM element <div id="map"> via the browser's
  // named-element lookup, so gate on canvasRenderer (a top-level const
  // in app.js that only exists once the script has actually run).
  await page.waitForFunction(
    () => typeof canvasRenderer !== "undefined" && !!canvasRenderer,
    { timeout: 60_000 },
  );
  await page.waitForFunction(
    () =>
      typeof canvasRenderer !== "undefined" &&
      canvasRenderer._pins &&
      canvasRenderer._pins.length > 0,
    { timeout: PIN_TIMEOUT_MS },
  );
  await page.waitForTimeout(4000);
  return { context, page, errors };
}

async function runSuite() {
  const browser = await chromium.launch(launchArgs());

  console.log(`\n━━━ Mobile (iPhone 13) ━━━`);
  const { context, page, errors } = await openPage(browser, MOBILE);

  const pinCount = await page.evaluate(
    () => canvasRenderer._pins.length,
  );
  const drawn = await page.evaluate(
    () => canvasRenderer._lastDrawnCount ?? -1,
  );
  check("pins load on mobile", pinCount > 0, `${pinCount} pins`);
  check("pins are drawn on the canvas", drawn > 0, `${drawn} drawn`);

  const caps = await page.evaluate(() => {
    const c = getClientHardwareCapabilities();
    return { isMobile: c.isMobile, canvasMax: c.canvasMax, maxSafe: c.maxSafe };
  });
  check(
    "the mobile hardware cap is applied",
    caps.isMobile === true && caps.canvasMax <= 1500,
    JSON.stringify(caps),
  );

  // ── the tap must land on the pin it was aimed at ──
  const pick = await page.evaluate(PICK_PIN);
  check("a pin is tappable", !!pick, pick ? "" : "no pin in the viewport");
  if (pick) {
    console.log(
      `     pin #${pick.id} "${pick.title}" buffer=${pick.buffer} ` +
        `map@${pick.mapLeft} canvas@${pick.canvasLeft}`,
    );
    let opened = false;
    for (let attempt = 0; attempt < 2 && !opened; attempt++) {
      await page.touchscreen.tap(pick.tapX, pick.tapY);
      try {
        await page.waitForSelector(".leaflet-popup", { timeout: 8000 });
        opened = true;
      } catch (_) {
        /* retry below */
      }
    }
    check("tapping a pin opens a popup", opened);
    if (opened) {
      const shown = await page.evaluate(() => {
        const h = document.querySelector(
          ".leaflet-popup h3, .leaflet-popup .popup-title",
        );
        return h ? String(h.textContent || "").trim() : "";
      });
      const shownStr = String(shown || "");
      check(
        "the tap opened the RIGHT story",
        shownStr.length > 0 &&
          pick.title.slice(0, 18).toLowerCase().includes(shownStr.slice(0, 18).toLowerCase()),
        `expected ~${pick.title.slice(0, 30)}, got ${shownStr}`,
      );

      // The story tree must render in the MOBILE popup variant.
      let tree = { branches: 0, items: 0 };
      try {
        await page.waitForFunction(
          () => {
            const c = document.querySelector(".popup-links-container");
            return (
              c && !c.querySelector(".popup-tree-loading") && c.innerHTML.trim().length > 0
            );
          },
          { timeout: 25_000 },
        );
        tree = await page.evaluate(() => ({
          branches: document.querySelectorAll(".popup-tree-head").length,
          items: document.querySelectorAll(".popup-tree-item").length,
          mobileBtn: !!document.querySelector(".popup-close-btn-mobile"),
        }));
      } catch (_) {
        /* reported below */
      }
      // An empty tree ("No connected stories found") is a valid state —
      // what matters is that the section rendered at all, not that this
      // particular pin happens to have connections.
      const treeRendered = tree.branches > 0 || tree.items > 0 ||
        await page.evaluate(() => {
          const c = document.querySelector(".popup-links-container");
          return !!(c && (c.querySelector(".popup-tree-branch") ||
                          c.querySelector(".popup-links-empty")));
        });
      check("the mobile popup renders the story tree", treeRendered, JSON.stringify(tree));
      check(
        "the mobile popup has its own close button",
        tree.mobileBtn === true,
      );

      // The ✕ must close it.
      await page.evaluate(() => {
        const b =
          document.querySelector(".popup-close-btn-mobile") ||
          document.querySelector(".popup-close-btn");
        if (b) b.click();
      });
      await page.waitForTimeout(900);
      const closed = await page.evaluate(
        () => document.querySelectorAll(".leaflet-popup").length === 0,
      );
      check("the ✕ closes the popup", closed);
    }
  }

  // ── layout ──
  const layout = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    bar: (() => {
      const b = document.getElementById("bottom-bar");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { left: r.left, right: r.right };
    })(),
    zoom: (() => {
      const z = document.querySelector(".leaflet-control-zoom");
      if (!z) return null;
      const r = z.getBoundingClientRect();
      return { right: r.right };
    })(),
  }));
  check(
    "nothing overflows horizontally",
    layout.scrollW <= layout.innerW + 1,
    `${layout.scrollW} vs ${layout.innerW}`,
  );
  check(
    "the bottom bar fits the viewport",
    !layout.bar || (layout.bar.left >= -1 && layout.bar.right <= layout.innerW + 1),
    JSON.stringify(layout.bar),
  );
  check(
    "the zoom control fits the viewport",
    !layout.zoom || layout.zoom.right <= layout.innerW + 1,
    JSON.stringify(layout.zoom),
  );

  // ── the layers dropdown on touch ──
  // Leaflet toggles the panel with a class; the list keeps its size in
  // the DOM either way, so measure the class, not the rect.
  const expanded = async () =>
    page.evaluate(() => {
      const c = document.querySelector(".leaflet-control-layers");
      return !!(c && c.classList.contains("leaflet-control-layers-expanded"));
    });
  if (!(await expanded())) {
    const r = await page.evaluate(() => {
      const a = document.querySelector("a.leaflet-control-layers-toggle");
      if (!a) return null;
      const b = a.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    if (r) await page.touchscreen.tap(r.x, r.y);
    await page.waitForTimeout(1200);
  }
  const dd = await page.evaluate(() => {
    const l = document.querySelector(".leaflet-control-layers-list");
    const c = document.querySelector(".leaflet-control-layers");
    return {
      expanded: !!(c && c.classList.contains("leaflet-control-layers-expanded")),
      visible: !!(l && l.getBoundingClientRect().height > 0),
      right: l ? l.getBoundingClientRect().right : 0,
      sliders: document.querySelectorAll(
        ".leaflet-control-layers-list .leaflet-overlay-opacity",
      ).length,
    };
  });
  check(
    "the layers dropdown opens on touch",
    !!dd && (dd.expanded || dd.visible),
    JSON.stringify(dd),
  );
  check(
    "the dropdown fits the viewport",
    !!dd && dd.right <= layout.innerW + 1,
    dd ? `right=${dd.right}` : "no dropdown",
  );
  check(
    "every overlay has an opacity slider",
    !!dd && dd.sliders >= 10,
    dd ? `${dd.sliders} sliders` : "no dropdown",
  );

  // The panel must be CLOSABLE on touch. Leaflet hides the toggle while
  // the panel is expanded, and the ✕ only had a click listener — Chrome
  // synthesises the click from a touch ~300 ms later and re-hit-tests at
  // the touch point, so on a phone the click missed the button and the
  // panel could not be dismissed.
  //
  // The panel starts COLLAPSED on phones (an always-open panel covers
  // the whole viewport and makes every tap hit a layer row), and the ✕
  // is created when it opens — so open it first.
  if (!(await page.evaluate(() =>
    document.querySelector(".leaflet-control-layers").classList.contains("leaflet-control-layers-expanded")))) {
    await page.evaluate(() => document.querySelector(".leaflet-control-layers-toggle").click());
    await page.waitForTimeout(900);
  }
  const closeBtn = await page.evaluate(() => {
    const b = document.querySelector(".leaflet-layers-close");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible: r.width > 0 };
  });
  check("the layers panel has a visible close button on mobile", !!closeBtn && closeBtn.visible, JSON.stringify(closeBtn));
  if (closeBtn) {
    await page.touchscreen.tap(closeBtn.x, closeBtn.y);
    await page.waitForTimeout(1200);
    const stillOpen = await page.evaluate(() =>
      document.querySelector(".leaflet-control-layers")
        .classList.contains("leaflet-control-layers-expanded"));
    check("tapping ✕ closes the layers panel", !stillOpen, `still open: ${stillOpen}`);
  }

  // Toggling an overlay by tap must work.
  const toggled = await page.evaluate(async () => {
    const labels = [
      ...document.querySelectorAll(".leaflet-control-layers-list label"),
    ];
    const t = labels.find((l) => l.textContent.includes("Hydrological Basins"));
    if (!t) return { found: false };
    t.querySelector("input").click();
    await new Promise((r) => setTimeout(r, 3000));
    return {
      found: true,
      enabled: window.BasinLayer ? window.BasinLayer.isEnabled() : null,
      features: window.BasinLayer && window.BasinLayer._state.features
        ? window.BasinLayer._state.features.features.length
        : 0,
    };
  });
  check(
    "an overlay can be switched on by tap",
    toggled.found && toggled.enabled === true && toggled.features > 0,
    JSON.stringify(toggled),
  );

  check("no page errors on mobile", errors.length === 0, errors.slice(0, 2).join(" | "));
  await context.close();

  // ── desktop must not be starved by the mobile caps ──
  console.log(`\n━━━ Desktop (comparison) ━━━`);
  const d = await openPage(browser, DESKTOP);
  const dPins = await d.page.evaluate(() => canvasRenderer._pins.length);
  const dDrawn = await d.page.evaluate(() => canvasRenderer._lastDrawnCount ?? -1);
  console.log(`     desktop: ${dPins} pins, ${dDrawn} drawn`);
  check("desktop renders pins too", dDrawn > 0, `${dDrawn} drawn`);
  // Compare pins per viewport AREA, not raw counts: a 390x844 portrait
  // phone simply shows less of the world than a 1440x900 desktop.
  const mArea = 390 * 844;
  const dArea = 1440 * 900;
  const mRate = drawn / mArea;
  const dRate = dDrawn / dArea;
  check(
    "mobile is not starved relative to desktop",
    dDrawn > 0 && mRate >= dRate * 0.3,
    `mobile ${drawn} (${mRate.toExponential(1)}/px²) vs desktop ${dDrawn} (${dRate.toExponential(1)}/px²)`,
  );
  await d.context.close();

  await browser.close();
}

runSuite()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("suite crashed:", e);
    process.exit(1);
  });
