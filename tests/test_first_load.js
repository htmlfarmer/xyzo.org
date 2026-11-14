// test_first_load.js — Regression test: pins must appear on first load
// Verifies the canvas renderer draws pins within 5 seconds on both
// Chrome and Firefox.  Catches the two bugs fixed 2026-09-21:
//   1. leaflet-heat.js DOMException on 0-size canvas (crashed render cycle)
//   2. canvasRenderer.enable() missing in viewport fetch path
//
// Run:  bun tests/test_first_load.js
// CI:   node tests/test_first_load.js          (exits 0 = pass, 1 = fail)

const { chromium, firefox } = require("playwright");

const BROWSERS = [
  { name: "Chrome", launch: () => chromium.launch({ headless: true }) },
  { name: "Firefox", launch: () => firefox.launch({ headless: true }) },
];

const URL = "https://xyzo.org/";
const TIMEOUT_MS = 10_000;   // max wait for pins
const MIN_PINS = 100;        // must draw at least this many

let passed = 0;
let failed = 0;

async function runSuite(browserName, launchFn) {
  console.log(`\n━━━ ${browserName} ━━━`);

  const browser = await launchFn();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Wait for pins to appear (or timeout)
  let result = null;
  for (let t = 0; t < TIMEOUT_MS; t += 250) {
    await page.waitForTimeout(250);
    result = await page.evaluate(() => {
      const r = window._canvasPinRenderer;
      if (!r || !r._canvas) return null;
      const ctx = r._canvas.getContext("2d");
      if (!ctx) return null;
      // Scan the full canvas for non-zero alpha pixels
      try {
        const d = ctx.getImageData(0, 0, r._canvas.width, r._canvas.height).data;
        let drawn = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) drawn++;
        return {
          enabled: r._enabled,
          pinsStored: r._pins?.length || 0,
          pixelsDrawn: drawn,
          canvasW: r._canvas.width,
          canvasH: r._canvas.height,
        };
      } catch (e) {
        return { error: e.message };
      }
    });
    if (result && result.pixelsDrawn > 0) break;
  }

  // ── Assertions ────────────────────────────────────────────────────
  const checks = [];

  // 1. No uncaught page errors (DOMException from leaflet-heat.js)
  const heatErrors = errors.filter((e) => e.includes("Index or size") || e.includes("DOMException"));
  checks.push({
    name: "No canvas DOMException errors",
    ok: heatErrors.length === 0,
    detail: heatErrors.length ? heatErrors.join("; ") : "clean",
  });

  // 2. Canvas renderer is enabled
  checks.push({
    name: "Canvas renderer enabled",
    ok: result?.enabled === true,
    detail: `enabled=${result?.enabled}`,
  });

  // 3. Pins stored in renderer
  checks.push({
    name: `Pins stored (≥${MIN_PINS})`,
    ok: (result?.pinsStored || 0) >= MIN_PINS,
    detail: `stored=${result?.pinsStored}`,
  });

  // 4. Pixels actually drawn on canvas
  checks.push({
    name: "Canvas has drawn pixels",
    ok: (result?.pixelsDrawn || 0) > 0,
    detail: `pixels=${result?.pixelsDrawn}`,
  });

  // 5. All page errors are zero
  checks.push({
    name: "Zero uncaught page errors",
    ok: errors.length === 0,
    detail: errors.length ? errors.join("; ") : "clean",
  });

  // ── Report ────────────────────────────────────────────────────────
  for (const c of checks) {
    const icon = c.ok ? "✅" : "❌";
    console.log(`  ${icon} ${c.name} — ${c.detail}`);
    if (c.ok) passed++; else failed++;
  }

  // Screenshot for manual review
  const shotPath = `data/visual_baselines/first-load-${browserName.toLowerCase()}.png`;
  await page.screenshot({ path: shotPath, fullPage: false });
  console.log(`  📸 ${shotPath}`);

  await browser.close();
}

(async () => {
  for (const b of BROWSERS) {
    await runSuite(b.name, b.launch);
  }

  console.log(`\n━━━ Results: ${passed} passed, ${failed} failed ━━━`);
  process.exit(failed > 0 ? 1 : 0);
})();
