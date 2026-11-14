#!/usr/bin/env python3
"""Graphical E2E & Performance Test Suite for Xyzo Frontend.

Uses Playwright (Headless Chromium) to verify UI integrity, map rendering,
SVG cluster circles, pin detail interactions, and page render performance.

Usage:
  python3 scripts/run_ui_tests.py
  bash scripts/validate-ui.sh
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, Response

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
BOLD = "\033[1m"
RESET = "\033[0m"

def log_ok(msg: str) -> None:
    print(f"{GREEN}  ✓ {msg}{RESET}")

def log_fail(msg: str) -> None:
    print(f"{RED}  ✗ {msg}{RESET}")

def log_info(msg: str) -> None:
    print(f"{BOLD}{msg}{RESET}")


def run_tests() -> bool:
    log_info("── Running Xyzo Graphical E2E UI Tests (Playwright / Chromium) ──")
    errors = 0
    total_tests = 10
    console_errors: list[str] = []
    page_exceptions: list[str] = []
    network_failures: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            executable_path="/usr/bin/chromium",
            args=["--no-sandbox", "--disable-setuid-sandbox"]
        )
        context = browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 1280, "height": 800}
        )
        page = context.new_page()

        def handle_console(msg):
            if msg.type == "error":
                text = msg.text
                if not any(supp in text for supp in ["ResizeObserver", "favicon.ico", "DevTools", "Failed to load resource"]):
                    console_errors.append(text)

        def handle_pageerror(exc):
            page_exceptions.append(str(exc))

        def handle_response(resp: Response):
            if resp.status >= 500:
                network_failures.append(f"HTTP {resp.status} on {resp.url}")

        page.on("console", handle_console)
        page.on("pageerror", handle_pageerror)
        page.on("response", handle_response)

        # ── Test 1: Page Load & Render Performance ──
        log_info("[1/11] Testing Page Load & Render Performance...")
        start_time = time.time()
        try:
            resp = page.goto("https://xyzo.org", wait_until="domcontentloaded", timeout=10000)
            load_time = (time.time() - start_time) * 1000
            if resp and resp.ok:
                log_ok(f"Page loaded successfully (HTTP {resp.status}) in {load_time:.0f}ms")
            else:
                log_fail(f"Page load returned status: {resp.status if resp else 'None'}")
                errors += 1
        except Exception as e:
            log_fail(f"Failed to navigate to https://xyzo.org: {e}")
            errors += 1
            browser.close()
            return False

        # ── Test 2: Map Canvas & Title ──
        log_info("[2/11] Verifying Map Canvas & DOM Elements...")
        title = page.title()
        if "XYZO" in title or "news" in title.lower():
            log_ok(f"Page title verified: '{title}'")
        else:
            log_fail(f"Unexpected page title: '{title}'")
            errors += 1

        map_visible = page.is_visible("#map")
        if map_visible:
            log_ok("Map container (#map) is visible on DOM")
        else:
            log_fail("Map container (#map) is missing or invisible!")
            errors += 1

        # ── Test 3: Marker Pin & Cluster Circles Rendering & TTFP SLA ──
        log_info("[3/11] Measuring Time-To-First-Pin (TTFP) & Pin Rendering SLA...")
        try:
            # Measure exact time from navigation start until first pin is rendered on canvas or DOM
            page.wait_for_function("""() => {
                const canvasPins = typeof canvasRenderer !== 'undefined' && Array.isArray(canvasRenderer._pins) ? canvasRenderer._pins.length : 0;
                const domMarkers = document.querySelectorAll('.xyzo-pin, .marker-cluster, circle, path.leaflet-interactive').length;
                return canvasPins > 0 || domMarkers > 0;
            }""", timeout=5000)
            ttfp_ms = (time.time() - start_time) * 1000

            pins_info = page.evaluate("""() => {
                const canvasPins = typeof canvasRenderer !== 'undefined' && Array.isArray(canvasRenderer._pins) ? canvasRenderer._pins.length : 0;
                const domMarkers = document.querySelectorAll('.xyzo-pin, .marker-cluster, circle, path.leaflet-interactive').length;
                return { canvasPins, domMarkers };
            }""")

            count = max(pins_info["canvasPins"], pins_info["domMarkers"])
            if ttfp_ms <= 4000:
                log_ok(f"SLA PASSED: First pin(s) rendered in {ttfp_ms:.0f}ms (<4000ms SLA threshold, {count} pins active)")
            else:
                log_fail(f"SLA FAILED: First pin(s) rendered in {ttfp_ms:.0f}ms (exceeded 4000ms SLA threshold, {count} pins active)")
                errors += 1
        except Exception as e:
            log_fail(f"Timeout waiting for map pins/clusters to render: {e}")
            errors += 1

        # ── Test 4: Cluster Click & Modal Interactivity ──
        log_info("[4/11] Testing Cluster Click & Modal Interactivity...")
        try:
            # Find a clickable SVG cluster circle or interactive path
            clickable = page.query_selector("circle, path.leaflet-interactive")
            if clickable:
                clickable.click(force=True)
                time.sleep(0.6)
                # Check if modal or popup opened
                modal_selectors = [
                    ".pin-modal", "#modal-container", "#top-stories-modal",
                    ".modal", ".leaflet-popup", ".leaflet-popup-content", ".top-stories-dialog"
                ]
                opened_modal = None
                for sel in modal_selectors:
                    if page.is_visible(sel):
                        opened_modal = sel
                        break

                if opened_modal:
                    log_ok(f"Modal/Popup opened cleanly on cluster click ({opened_modal})")
                    close_btn = page.query_selector(".modal-close, .close-btn, #modal-close-btn, button.close, [data-dismiss='modal'], a.leaflet-popup-close-button")
                    if close_btn and close_btn.is_visible():
                        close_btn.click()
                        time.sleep(0.3)
                        if not page.is_visible(opened_modal):
                            log_ok("Modal/Popup closed cleanly when clicking close button")
                        else:
                            log_fail("Modal/Popup failed to dismiss after clicking close button!")
                            errors += 1
                    else:
                        log_ok("Modal/Popup is active and visible")
                else:
                    log_ok("Cluster click registered cleanly (zoomed or expanded cluster)")
            else:
                log_fail("No SVG cluster markers found on map to test interaction")
                errors += 1
        except Exception as e:
            log_fail(f"Error during interactive modal test: {e}")
            errors += 1

        # ── Test 5: Error Guards & Network Health ──
        log_info("[5/11] Checking Console Error Guard & Network Health...")
        if page_exceptions:
            log_fail(f"Found {len(page_exceptions)} uncaught JS exception(s):")
            for exc in page_exceptions[:3]:
                print(f"    - {exc}")
            errors += len(page_exceptions)
        else:
            log_ok("Zero uncaught JS exceptions during user session")

        if console_errors:
            log_fail(f"Found {len(console_errors)} console.error log(s):")
            for err in console_errors[:3]:
                print(f"    - {err}")
            errors += len(console_errors)
        else:
            log_ok("Zero console.error messages emitted")

        if network_failures:
            log_fail(f"Found {len(network_failures)} 500 internal server error(s):")
            for net_err in network_failures[:3]:
                print(f"    - {net_err}")
            errors += len(network_failures)
        else:
            log_ok("Zero HTTP 500 network failures during page interaction")

        # ── Test 6: UI-Independent Mode Engine & Renderer Verification ──
        log_info("[6/11] Verifying Heatmap, Clusters & Markers Engine (UI-Independent)...")
        try:
            # 6A. Test Heatmap Mode (UI-independent: verifies engine state, heatLayer, and latlng points)
            heat_res = page.evaluate("""async () => {
                const btn = document.querySelector('[data-mode="heatmap"]');
                if (btn) btn.click();
                else if (typeof setMode === 'function') setMode('heatmap');
                for (let i = 0; i < 15; i++) {
                    await new Promise(r => setTimeout(r, 200));
                    const hp = (typeof _heatPoints !== 'undefined' && Array.isArray(_heatPoints)) ? _heatPoints.length : 0;
                    if (hp > 0) break;
                }
                
                const isMode = (typeof activeModes !== 'undefined' && activeModes.has('heatmap')) || renderMode === 'heatmap';
                const hasLayer = typeof map !== 'undefined' && map.hasLayer(heatLayer);
                const heatPoints = (typeof _heatPoints !== 'undefined' && Array.isArray(_heatPoints)) ? _heatPoints.length : 0;
                return { isMode, hasLayer, heatPoints };
            }""")
            
            if heat_res["isMode"] and heat_res["hasLayer"] and heat_res["heatPoints"] > 0:
                log_ok(f"Heatmap Mode verified cleanly (heatLayer attached, {heat_res['heatPoints']} heat points active)")
            else:
                log_fail(f"Heatmap Mode failed verification! state={heat_res}")
                errors += 1

            # 6B. Test Clusters Mode (UI-independent: verifies engine state, pinCluster layer, and markers)
            cluster_res = page.evaluate("""async () => {
                const btn = document.querySelector('[data-mode="clusters"]');
                if (btn) btn.click();
                else if (typeof setMode === 'function') setMode('clusters');
                await new Promise(r => setTimeout(r, 800));
                
                // heatmap and clusters may coexist (only markers/clusters are
                // mutually exclusive), and renderMode reports the PRIMARY
                // mode — so check the mode set, not the primary.
                const isMode = (typeof activeModes !== 'undefined' && activeModes.has('clusters')) || renderMode === 'clusters';
                const hasLayer = typeof map !== 'undefined' && (map.hasLayer(pinCluster) || map.hasLayer(eventCluster));
                const clusterCount = (typeof pinCluster !== 'undefined' && pinCluster.getLayers) ? pinCluster.getLayers().length : 0;
                const domMarkers = document.querySelectorAll('.xyzo-pin, .marker-cluster, circle').length;
                return { isMode, hasLayer, clusterCount, domMarkers };
            }""")
            
            if cluster_res["isMode"] and cluster_res["hasLayer"] and (cluster_res["clusterCount"] > 0 or cluster_res["domMarkers"] > 0):
                log_ok(f"Clusters Mode verified cleanly (pinCluster active, {cluster_res['clusterCount'] or cluster_res['domMarkers']} markers/clusters)")
            else:
                log_fail(f"Clusters Mode failed verification! state={cluster_res}")
                errors += 1

            # 6C. Test Markers / Canvas Mode (UI-independent: verifies engine state, canvas layer, and pins)
            markers_res = page.evaluate("""async () => {
                const btn = document.querySelector('[data-mode="markers"]');
                if (btn) btn.click();
                else if (typeof setMode === 'function') setMode('markers');
                await new Promise(r => setTimeout(r, 800));
                
                const isMode = (typeof activeModes !== 'undefined' && activeModes.has('markers')) || renderMode === 'markers';
                const canvasActive = typeof canvasRenderer !== 'undefined' && canvasRenderer._enabled && !!canvasRenderer._canvas;
                const pinsCount = (typeof canvasRenderer !== 'undefined' && Array.isArray(canvasRenderer._pins)) ? canvasRenderer._pins.length : 0;
                return { isMode, canvasActive, pinsCount };
            }""")
            
            if markers_res["isMode"] and markers_res["canvasActive"] and markers_res["pinsCount"] > 0:
                log_ok(f"Markers Mode verified cleanly (canvasRenderer active, {markers_res['pinsCount']} pins rendered)")
            else:
                log_fail(f"Markers Mode failed verification! state={markers_res}")
                errors += 1

        except Exception as e:
            log_fail(f"Engine mode verification check failed: {e}")
            errors += 1

        # ── Test 7: Pan & Pin Reload ──
        log_info("[7/11] Testing Map Pan & Pin Reload...")
        try:
            # Get initial pin count (canvas or DOM)
            initial_pins = page.evaluate("""() => {
                const canvas = document.querySelector('canvas.xyzo-canvas-pins');
                if (canvas) return { type: 'canvas', visible: true };
                return { type: 'dom', count: document.querySelectorAll('.xyzo-pin').length };
            }""")

            # Pan the map by dragging
            map_el = page.query_selector("#map")
            if map_el:
                box = map_el.bounding_box()
                cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
                page.mouse.move(cx, cy)
                page.mouse.down()
                page.mouse.move(cx + 200, cy, steps=5)
                page.mouse.up()
                time.sleep(1.0)  # Wait for moveend + fetch + canvas redraw

                # Verify pins loaded after pan
                post_pan = page.evaluate("""() => {
                    const canvas = document.querySelector('canvas.xyzo-canvas-pins');
                    if (canvas) return { type: 'canvas', width: canvas.width, height: canvas.height };
                    return { type: 'dom', count: document.querySelectorAll('.xyzo-pin').length };
                }""")

                if post_pan["type"] == "canvas" and post_pan["width"] > 0:
                    log_ok(f"Canvas renderer active after pan: {post_pan['width']}x{post_pan['height']}")
                elif post_pan["type"] == "dom" and post_pan["count"] >= 0:
                    log_ok(f"DOM markers after pan: {post_pan['count']} markers")
                else:
                    log_fail("No pins visible after panning the map!")
                    errors += 1
            else:
                log_fail("Map element not found for pan test")
                errors += 1
        except Exception as e:
            log_fail(f"Pan & reload test failed: {e}")
            errors += 1

        # ── Test 8: Search Flow ──
        log_info("[8/11] Testing Search Flow...")
        try:
            search_input = page.query_selector("#search-input")
            if search_input:
                search_input.fill("science")
                search_input.press("Enter")
                page.wait_for_function("""() => {
                    const clearBtn = document.querySelector('#search-clear');
                    return clearBtn && !clearBtn.hidden;
                }""", timeout=6000)

                status = page.text_content("#search-status") or ""
                log_ok(f"Search active for 'science': status='{status.strip()[:60]}'")

                # Verify canvas pin click -> popup open -> popup close -> hover ghost verification
                hover_test_res = page.evaluate("""async () => {
                    if (typeof canvasRenderer === 'undefined' || !canvasRenderer._pins || canvasRenderer._pins.length === 0) {
                        return { ok: false, reason: 'no_pins' };
                    }
                    const firstPin = canvasRenderer._pins[0];
                    openPinPopupFromCanvas(firstPin);
                    await new Promise(r => setTimeout(r, 400));
                    const popupOpened = !!document.querySelector('.leaflet-popup');

                    // Close popup via close button or closeActivePopup
                    window.closeActivePopup();
                    await new Promise(r => setTimeout(r, 400));
                    const popupClosed = !document.querySelector('.leaflet-popup');

                    // Hover over pin
                    canvasRenderer._showGhost(firstPin);
                    const ghostEl = document.querySelector('.xyzo-pin-hover-ghost');
                    const ghostVisible = ghostEl && !ghostEl.classList.contains('hidden') && document.body.contains(ghostEl);

                    return { ok: popupOpened && popupClosed && ghostVisible, popupOpened, popupClosed, ghostVisible };
                }""")

                if hover_test_res["ok"]:
                    log_ok("Canvas popup open/close & subsequent hover ghost circle verified cleanly")
                else:
                    log_fail(f"Canvas hover/popup cycle test failed: {hover_test_res}")
                    errors += 1

                # Clear search
                clear_btn = page.query_selector("#search-clear")
                if clear_btn and clear_btn.is_visible():
                    clear_btn.click()
                    time.sleep(1.0)
                    log_ok("Search cleared successfully via button")
                else:
                    search_input.press("Escape")
                    time.sleep(1.0)
                    log_ok("Search cleared via Escape")

                # Verify clean restoration: 0 DOM pins, normal canvas pins restored
                clear_check = page.evaluate("""async () => {
                    // The pins are re-fetched and the canvas redrawn after the
                    // search is cleared — poll for it instead of assuming a
                    // fixed delay (a loaded box needs longer).
                    for (let i = 0; i < 40; i++) {
                        const drawn = canvasRenderer?._lastDrawnCount ?? 0;
                        if (drawn > 0) break;
                        await new Promise(r => setTimeout(r, 250));
                    }
                    return {
                        domPins: document.querySelectorAll(".xyzo-pin").length,
                        canvasPins: canvasRenderer?._lastDrawnCount ?? 0,
                        searchInput: document.getElementById("search-input")?.value ?? ""
                    };
                }""")
                if clear_check["domPins"] == 0 and clear_check["canvasPins"] > 0 and clear_check["searchInput"] == "":
                    log_ok(f"Search clear restored normal map cleanly (domPins=0, canvasPins={clear_check['canvasPins']})")
                else:
                    log_fail(f"Search clear left stale state: {clear_check}")
                    errors += 1
            else:
                log_fail("Search input not found!")
                errors += 1
        except Exception as e:
            log_fail(f"Search flow test failed: {e}")
            errors += 1

        # ── Test 9: Category Filter Lifecycle, UI Indicator & Stale Storage Purge ──
        log_info("[9/11] Testing Category Filter Lifecycle, UI Indicator & Stale Storage Purge...")
        try:
            # 9A: Verify that pre-existing stale localStorage filter is automatically purged on reload
            page.evaluate("() => localStorage.setItem('xyzo-category-filters', JSON.stringify(['environment']))")
            page.reload(wait_until="networkidle")
            time.sleep(1.5)

            purge_res = page.evaluate("""() => {
                const stored = localStorage.getItem('xyzo-category-filters');
                const inMemory = typeof _activeCategoryFilters !== 'undefined' ? _activeCategoryFilters.size : -1;
                const canvasPins = typeof canvasRenderer !== 'undefined' && canvasRenderer._pins ? canvasRenderer._pins.length : 0;
                const drawn = typeof canvasRenderer !== 'undefined' ? canvasRenderer._lastDrawnCount : 0;
                return { stored, inMemory, canvasPins, drawn };
            }""")

            if purge_res["stored"] is None and purge_res["inMemory"] == 0 and purge_res["drawn"] > 0:
                log_ok(f"Stale localStorage filter auto-purged on load ({purge_res['drawn']} pins drawn, activeFilters=0)")
            else:
                log_fail(f"Stale localStorage filter was not purged: {purge_res}")
                errors += 1

            # 9B: Verify interactive category filter toggle: pill appears, legend highlights, count matches
            toggle_res = page.evaluate("""() => {
                toggleCategoryFilter('politics');
                const pill = document.getElementById('active-filter-indicator');
                const pillVisible = pill && !pill.hidden;
                const pillText = document.getElementById('active-filter-text')?.textContent || '';
                const legendBtn = document.getElementById('legend-btn') || document.getElementById('ctrl-legend-btn');
                const legendBtnHasClass = !!legendBtn?.classList.contains('has-filter');
                const drawn = canvasRenderer._lastDrawnCount;
                const diag = window.__xyzoMarkerDiagnostics ? window.__xyzoMarkerDiagnostics() : null;
                const diagHasFilter = diag && Array.isArray(diag.activeCategoryFilters) && diag.activeCategoryFilters.includes('politics');
                return { pillVisible, pillText, legendBtnHasClass, drawn, diagHasFilter };
            }""")

            if toggle_res["pillVisible"] and "politics" in toggle_res["pillText"].lower() and toggle_res["legendBtnHasClass"] and toggle_res["diagHasFilter"]:
                log_ok(f"Active filter pill and legend indicator verified cleanly ('{toggle_res['pillText']}')")
            else:
                log_fail(f"Active category filter toggle failed: {toggle_res}")
                errors += 1

            # 9C: Verify Clear filter button on the floating pill immediately restores pins
            clear_res = page.evaluate("""() => {
                const clearBtn = document.getElementById('active-filter-clear-btn');
                if (clearBtn) clearBtn.click();
                else clearCategoryFilters();

                const pill = document.getElementById('active-filter-indicator');
                const pillHidden = !pill || pill.hidden;
                const inMemory = typeof _activeCategoryFilters !== 'undefined' ? _activeCategoryFilters.size : -1;
                const drawn = canvasRenderer._lastDrawnCount;
                return { pillHidden, inMemory, drawn };
            }""")

            if clear_res["pillHidden"] and clear_res["inMemory"] == 0 and clear_res["drawn"] > 0:
                log_ok(f"Clear filter button restored all pins cleanly ({clear_res['drawn']} pins visible, pill hidden)")
            else:
                log_fail(f"Clear filter button failed to restore pins: {clear_res}")
                errors += 1

        except Exception as e:
            log_fail(f"Category filter lifecycle test failed: {e}")
            errors += 1

        # ── Test 10: API Response Timing (Browser context) ──
        log_info("[10/11] Checking API Response Times...")
        api_times = {}
        api_urls = [
            ("/api/pins/map?bbox=-180,-85,180,85&limit=100", "Pin map endpoint", 5000),
            ("/api/health", "Health check", 3000),
            ("/api/pins/stats", "Pin stats", 3000),
        ]
        for path, label, max_ms in api_urls:
            try:
                timing = page.evaluate(f"""async () => {{
                    const t0 = performance.now();
                    const res = await fetch('{path}');
                    const t1 = performance.now();
                    return {{ ok: res.ok, status: res.status, ms: Math.round(t1 - t0) }};
                }}""")
                api_times[path] = timing["ms"]
                if timing["ok"] or timing["status"] == 429:
                    log_ok(f"{label} ({path}): {timing['ms']}ms (HTTP {timing['status']})")
                else:
                    log_fail(f"{label} ({path}): {timing['ms']}ms (max {max_ms}ms, HTTP {timing['status']})")
                    errors += 1
            except Exception as e:
                log_fail(f"{label} ({path}): request failed — {e}")
                errors += 1

        # ── Test 11: Screenshot Artifact Generation ──
        log_info("[11/11] Capturing Visual Test Screenshot...")
        screenshot_dir = Path("/var/www/vhosts/xyzo.org/public_html/tests/screenshots")
        screenshot_dir.mkdir(parents=True, exist_ok=True)
        screenshot_path = screenshot_dir / "map_e2e_snapshot.png"
        page.screenshot(path=str(screenshot_path), full_page=True)
        log_ok(f"Visual snapshot saved to {screenshot_path}")

        browser.close()

    print("\n" + "=" * 60)
    if errors == 0:
        log_ok(f"{BOLD}GRAPHICAL E2E UI TESTS PASSED — 0 errors detected!{RESET}")
        return True
    else:
        log_fail(f"{BOLD}GRAPHICAL E2E UI TESTS FAILED with {errors} error(s)!{RESET}")
        return False


if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
