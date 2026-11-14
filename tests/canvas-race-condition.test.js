/**
 * Canvas Renderer & Boot-Fetch Race Condition Tests
 *
 * Tests two distinct race conditions that share symptoms (empty map after
 * reload / address-bar typing):
 *
 * 1. Canvas-vs-CSS race (fixed 2026-09-11 morning)
 *    - On first load, Leaflet map container starts at 0×0
 *    - canvasRenderer._draw() ran before CSS layout committed
 *    - Pins were drawn to a 0×0 canvas (off-screen)
 *    - On reload, everything was cached → worked fine
 *    - Bug only manifested on first visits from email links
 *
 * 2. Boot-fetch race (fixed 2026-09-11 afternoon)
 *    - Multiple fetchPinsForViewport() callers race during boot
 *    - Whichever lands on a transitional bbox wins → 0 pins, no retry
 *    - Now handled by the boot-fetch coordinator (window._bootCoord)
 *
 * Canvas fix details: docs/canvas-race-condition-postmortem.md
 * Boot-fetch fix details: docs/boot-fetch-race-postmortem.md
 *
 * Three-layer defense for the canvas race:
 * 1. _draw() retry loop (60 frames) when mapSize < 10
 * 2. ResizeObserver + invalidateSize() catches late layout
 * 3. setPins 500ms fallback for canvas still 0-sized
 * 4. Boot guard in fetchPinsForViewport defers if container 0×0
 * 5. fixMapPositionIfLeafletClobbered() clears inline position override
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = 'http://localhost:3000';

test.describe('Canvas Renderer Race Condition', () => {

  test('pins render on first load from shared link', async ({ page }) => {
    // Navigate with a hash URL (simulates clicking a shared link)
    await page.goto(`${BASE_URL}/#42.0,-70.5,9`);

    // Wait for the map to be fully loaded
    await page.waitForSelector('.leaflet-tile-loaded', { timeout: 15000 });

    // Wait for canvas to have dimensions (our fix ensures this)
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.xyzo-canvas-pins');
      return canvas && canvas.width > 0 && canvas.height > 0;
    }, { timeout: 10000 });

    // Verify canvas has proper dimensions
    const canvasDims = await page.evaluate(() => {
      const canvas = document.querySelector('.xyzo-canvas-pins');
      return { width: canvas?.width || 0, height: canvas?.height || 0 };
    });
    expect(canvasDims.width).toBeGreaterThan(100);
    expect(canvasDims.height).toBeGreaterThan(100);

    // Verify pins were actually drawn (canvas has pixel data)
    const hasPixels = await page.evaluate(() => {
      const canvas = document.querySelector('.xyzo-canvas-pins');
      if (!canvas || canvas.width === 0) return false;
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      // Check if any non-transparent pixels exist
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) return true;
      }
      return false;
    });
    expect(hasPixels).toBe(true);
  });

  test('pins render after bfcache restore', async ({ page }) => {
    // First load
    await page.goto(`${BASE_URL}/#42.0,-70.5,9`);
    await page.waitForSelector('.leaflet-tile-loaded', { timeout: 15000 });
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.xyzo-canvas-pins');
      return canvas && canvas.width > 0;
    }, { timeout: 10000 });

    // Navigate away
    await page.goto(`${BASE_URL}/about.html`);

    // Navigate back (triggers bfcache)
    await page.goBack();

    // Wait for pageshow handler to re-fetch pins
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.xyzo-canvas-pins');
      return canvas && canvas.width > 0;
    }, { timeout: 10000 });

    // Verify pins rendered after bfcache restore
    const hasPixels = await page.evaluate(() => {
      const canvas = document.querySelector('.xyzo-canvas-pins');
      if (!canvas || canvas.width === 0) return false;
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) return true;
      }
      return false;
    });
    expect(hasPixels).toBe(true);
  });

  test('ResizeObserver triggers redraw when container sizes', async ({ page }) => {
    // Start with a narrow viewport
    await page.setViewportSize({ width: 400, height: 300 });
    await page.goto(`${BASE_URL}/#42.0,-70.5,9`);
    await page.waitForSelector('.leaflet-tile-loaded', { timeout: 15000 });

    // Wait for initial render
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.xyzo-canvas-pins');
      return canvas && canvas.width > 0;
    }, { timeout: 10000 });

    const smallDims = await page.evaluate(() => {
      const canvas = document.querySelector('.xyzo-canvas-pins');
      return { width: canvas?.width || 0, height: canvas?.height || 0 };
    });

    // Resize viewport (triggers ResizeObserver)
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Wait for canvas to resize
    await page.waitForFunction((prevWidth) => {
      const canvas = document.querySelector('.xyzo-canvas-pins');
      return canvas && canvas.width > prevWidth;
    }, smallDims.width, { timeout: 5000 });

    const largeDims = await page.evaluate(() => {
      const canvas = document.querySelector('.xyzo-canvas-pins');
      return { width: canvas?.width || 0, height: canvas?.height || 0 };
    });

    expect(largeDims.width).toBeGreaterThan(smallDims.width);
    expect(largeDims.height).toBeGreaterThan(smallDims.height);
  });

  test('diagnostics include boot state', async ({ page }) => {
    await page.goto(`${BASE_URL}/#42.0,-70.5,9`);
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.xyzo-canvas-pins');
      return canvas && canvas.width > 0;
    }, { timeout: 10000 });

    const diag = await page.evaluate(() => {
      return window.__xyzoFetchDiagnostics?.();
    });

    expect(diag).toBeDefined();
    expect(diag.boot).toBeDefined();
    expect(diag.boot.mapReady).toBe(true);
    expect(diag.boot.mapSize).toBeDefined();
    expect(diag.boot.canvasEnabled).toBe(true);
    expect(diag.boot.canvasPins).toBeGreaterThan(0);
  });
});

test.describe('Boot-Fetch Race Coordinator', () => {

  test('coordinator state reaches done-ok within boot grace window', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    // Wait up to 7s for the coordinator to settle (5s grace + 2s buffer)
    await page.waitForFunction(() => {
      const coord = window._bootCoord;
      return coord && (coord.state === 'done-ok' || coord.state === 'expired');
    }, { timeout: 7000 });

    const coord = await page.evaluate(() => ({
      state: window._bootCoord?.state,
      pinCount: window._bootCoord?.pinCount,
      isBootFetch: window._bootCoord?.isBootFetch,
    }));

    // After a successful boot, state is done-ok and pinCount > 0
    expect(coord.state).toBe('done-ok');
    expect(coord.pinCount).toBeGreaterThan(0);
    expect(coord.isBootFetch).toBe(false);
  });

  test('coordinator becomes inert after done-ok (normal pans work)', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    // Wait for boot to complete
    await page.waitForFunction(() => {
      const coord = window._bootCoord;
      return coord && coord.state === 'done-ok';
    }, { timeout: 7000 });

    // Trigger a user pan.  The coordinator should NOT participate —
    // normal reloadPins() should fire directly.
    const beforePins = await page.evaluate(() =>
      window._canvasPinRenderer?._pins?.length || 0
    );

    await page.evaluate(() => {
      window._xyzoMap.setView([40, -74], 6, { animate: false });
    });

    // Wait for the new fetch to complete
    await page.waitForTimeout(2500);

    const after = await page.evaluate(() => ({
      coordState: window._bootCoord?.state,
      coordIsBootFetch: window._bootCoord?.isBootFetch,
      pins: window._canvasPinRenderer?._pins?.length || 0,
    }));

    // Coordinator is inert — still done-ok, isBootFetch is false
    expect(after.coordState).toBe('done-ok');
    expect(after.coordIsBootFetch).toBe(false);
    // Pins reloaded for new viewport
    expect(after.pins).toBeGreaterThan(0);
    expect(after.pins).not.toBe(beforePins);  // different pins for different viewport
  });

  test('empty first fetch triggers a single retry, not an infinite loop', async ({ page, context }) => {
    // Intercept /api/pins/map and return empty for the first 2 calls.
    // After 2 calls (initial + retry), the coordinator should stop retrying
    // and the user should be able to recover by manually panning.
    let callCount = 0;
    await context.route('**/api/pins/map*', async (route) => {
      callCount++;
      if (callCount <= 2) {
        // First 2 calls: return empty (simulates API returning 0 pins due
        // to transitional bbox)
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: [], count: 0 }),
        });
      } else {
        // 3rd+ calls: pass through to real API
        await route.continue();
      }
    });

    await page.goto(`${BASE_URL}/`);
    // Wait long enough for initial + retry (250ms settle + 500ms retry + buffer)
    await page.waitForTimeout(4000);

    const result = await page.evaluate(() => ({
      coordState: window._bootCoord?.state,
      pinCount: window._bootCoord?.pinCount,
      callsMade: window.__xyzoPinApiCallCount,
    }));

    // Exactly 2 API calls — no infinite loop
    expect(callCount).toBe(2);
    // Coordinator reached done-empty-gave-up or expired (not infinite)
    expect(['done-empty-gave-up', 'expired']).toContain(result.coordState);
    // pinCount is 0 (returned empty twice)
    expect(result.pinCount).toBe(0);

    // User can recover by manually panning
    await page.evaluate(() => {
      window._xyzoMap.setView([40, -74], 6, { animate: false });
    });
    await page.waitForTimeout(2000);

    const afterPan = await page.evaluate(() => ({
      pins: window._canvasPinRenderer?._pins?.length || 0,
      drawn: window._canvasPinRenderer?._lastDrawnCount || 0,
    }));
    expect(afterPan.pins).toBeGreaterThan(100);
    expect(afterPan.drawn).toBeGreaterThan(100);
  });

  test('user pan during boot window cancels pending retry', async ({ page, context }) => {
    // Make the first call return empty so the coordinator schedules a retry.
    let callCount = 0;
    await context.route('**/api/pins/map*', async (route) => {
      callCount++;
      if (callCount === 1) {
        // First call: empty (triggers retry)
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: [], count: 0 }),
        });
      } else {
        // All other calls: pass through
        await route.continue();
      }
    });

    await page.goto(`${BASE_URL}/`);
    // Wait for the empty first fetch to register and retry to be scheduled
    await page.waitForTimeout(800);

    // User pans before the retry fires (scheduled at +500ms after empty response)
    await page.evaluate(() => {
      window._xyzoMap.setView([40, -74], 6, { animate: false });
    });

    // Wait long enough for the (cancelled) retry and the user's pan fetch
    await page.waitForTimeout(3000);

    const result = await page.evaluate(() => ({
      coordState: window._bootCoord?.state,
      pins: window._canvasPinRenderer?._pins?.length || 0,
    }));

    // Should have pins from the user's pan (3rd call to API), not 0
    expect(result.pins).toBeGreaterThan(100);
    // Coordinator absorbed the pan into the boot state machine
    expect(['done-ok', 'done-empty', 'done-retry', 'in-flight', 'expired'])
      .toContain(result.coordState);
  });

  test('coordinator exposes state on window for diagnostics', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    // Probe at multiple time points to verify state is observable
    const samples = [];
    for (const ms of [50, 300, 800, 2000]) {
      await page.wait_for_timeout
        ? await page.wait_for_timeout(ms)
        : await page.waitForTimeout(ms);
      const state = await page.evaluate(() => window._bootCoord?.state || 'missing');
      samples.push({ ms, state });
    }

    // State progresses through the lifecycle
    expect(samples.some(s => s.state === 'idle' || s.state === 'settled-pending')).toBe(true);
    // Eventually settles to a terminal state
    const final = samples[samples.length - 1];
    expect(['done-ok', 'done-empty', 'done-retry', 'done-empty-gave-up', 'expired', 'in-flight'])
      .toContain(final.state);
  });

  test('multiple reloads in a row each produce pins (no progressive degradation)', async ({ page }) => {
    const results = [];
    for (let i = 0; i < 3; i++) {
      await page.goto(`${BASE_URL}/`);
      await page.waitForTimeout(4000);
      const r = await page.evaluate(() => ({
        coordState: window._bootCoord?.state,
        pins: window._canvasPinRenderer?._pins?.length || 0,
        drawn: window._canvasPinRenderer?._lastDrawnCount || 0,
      }));
      results.push(r);
    }
    for (const [i, r] of results.entries()) {
      // Each reload should produce pins
      expect(r.pins).toBeGreaterThan(100);
      expect(r.drawn).toBeGreaterThan(100);
    }
  });

  test('time dropdown wired up even if DOMContentLoaded fired before app.js', async ({ page }) => {
    // Force DOMContentLoaded to fire before app.js's defer script runs.
    // This is the timing condition that broke the original code.
    await page.addInitScript(() => {
      document.dispatchEvent(new Event('DOMContentLoaded'));
    });

    await page.goto(`${BASE_URL}/`);
    await page.waitForTimeout(3000);

    // The time dropdown button must be marked as wired
    const wired = await page.evaluate(() =>
      document.getElementById('time-dropdown-btn')?.dataset.wired
    );
    expect(wired).toBe('1');

    // And clicking it must open the menu
    await page.click('#time-dropdown-btn', { force: true });
    await page.waitForTimeout(300);
    const menuHidden = await page.evaluate(() =>
      document.getElementById('time-dropdown-menu')?.hidden
    );
    expect(menuHidden).toBe(false);
  });
});
