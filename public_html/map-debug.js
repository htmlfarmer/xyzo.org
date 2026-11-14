// map-debug.js — floating debug overlay for diagnosing the
// "second pan doesn't fill the map with new pins" bug (task #33).
//
// What it shows, at a glance:
//   • Map state: center, zoom, current bounds (W,S,E,N)
//   • Last 8 moveend / fetch / abort events with timestamps + bboxes
//   • Last 8 fetched bboxes vs the current viewport (overlap %)
//   • Pin state: canvas pin count, pins in current viewport
//   • Built-in diagnostics: __xyzoFetchDiagnostics, __xyzoMarkerDiagnostics
//
// What you can do:
//   • Copy report — text dump for paste-into-chat / issue tracker
//   • Force refetch — calls fetchPinsForViewport() directly (bypasses throttle)
//   • Clear canvas — clears all rendered canvas pins (test the clear path)
//   • Pan to test city — programmatic jump + wait to see if pins load
//   • Reload — full page reload (the existing escape hatch)
//
// Include via <script src="/map-debug.js" defer></script>. Self-contained,
// no deps, no-op on pages without window._xyzoMap.

(function () {
  "use strict";

  if (typeof window === "undefined") return;

  // Wait for the map. The script may load before app.js has finished init.
  function whenMap(cb, attempts) {
    if (window._xyzoMap) { cb(); return; }
    if (attempts <= 0) return; // not a map page — no-op
    setTimeout(function () { whenMap(cb, attempts - 1); }, 250);
  }

  // The floating panel is a DIAGNOSTIC, not a product feature — but it
  // was built unconditionally, so every visitor got a "🐛 debug" button
  // fixed at bottom: 12px / left: 12px. On a 393 px phone that lands on
  // top of #bottom-bar's language selector, and on a 660 px-tall screen
  // it eats the one strip of map the bar leaves free. Gate it on the same
  // opt-in the rest of the codebase uses (?debug in the URL, which also
  // remembers itself for the session, or localStorage xyzo.debug = "1").
  function debugEnabled() {
    try {
      if (new URLSearchParams(location.search).has("debug")) {
        localStorage.setItem("xyzo.debug", "1");
        return true;
      }
      return localStorage.getItem("xyzo.debug") === "1";
    } catch (_) { return false; }
  }

  if (debugEnabled()) whenMap(init, 60);

  function init() {
    var map = window._xyzoMap;
    if (!map) return;

    var state = {
      pans: [],          // {t, center, zoom, bounds}
      fetches: [],       // {t, url, bbox, status, count, duration, aborted}
      aborts: [],        // {t, reason}
      throttle: { fires: 0, drops: 0, lastFire: 0, lastDrop: 0 },
      installed: false,
    };

    // ── Hook the perf lifecycle so every pan + fetch gets recorded ──
    var origPerf = window._mapPerf || {};
    // Wrap _shipMapPerf — it fires after the canvas paint, which is the
    // closest "user saw new pins" moment we have to record.
    var origShip = window._shipMapPerf;
    window._shipMapPerf = function () {
      try { if (typeof origShip === "function") origShip(); } catch (_) {}
      recordFetch("ship");
    };
    // Wrap the existing moveend hook too. Leaflet allows multiple .on()
    // listeners so we can add ours without disturbing app.js.
    map.on("moveend", function () {
      var b = map.getBounds();
      state.pans.push({
        t: Date.now(),
        center: [map.getCenter().lat, map.getCenter().lng],
        zoom: map.getZoom(),
        bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
      });
      if (state.pans.length > 12) state.pans.shift();
      render();
    });
    map.on("movestart", function () {
      // If there's a perf record with fetch_start but no fetch_end/render_end,
      // the next pan aborted it.
      var p = window._mapPerf;
      if (p && p.fetch_start && !p.fetch_end) {
        state.aborts.push({ t: Date.now(), reason: "next pan before render" });
        if (state.aborts.length > 12) state.aborts.shift();
      }
    });
    // Patch fetch to log every /api/pins call. We can't catch AbortError
    // cancellations through fetch() easily, so we also wrap the perf flow.
    var origFetch = window.fetch;
    if (!state.installed) {
      var pinsUrlRe = /\/api\/pins(\/map)?\?/;
      window.fetch = function (url, opts) {
        var u = typeof url === "string" ? url : (url && url.url) || "";
        if (pinsUrlRe.test(u) && opts && opts.signal) {
          var t0 = performance.now();
          var record = { t: Date.now(), url: u, status: "pending", duration: 0, aborted: false, bbox: extractBbox(u) };
          state.fetches.push(record);
          if (state.fetches.length > 12) state.fetches.shift();
          opts.signal.addEventListener("abort", function () {
            record.aborted = true;
            record.status = "aborted";
          });
          return origFetch(url, opts).then(function (res) {
            record.status = res.status;
            record.duration = Math.round(performance.now() - t0);
            return res;
          }, function (err) {
            record.status = "err: " + (err && err.name ? err.name : "?");
            record.duration = Math.round(performance.now() - t0);
            throw err;
          });
        }
        return origFetch.apply(this, arguments);
      };
      state.installed = true;
    }

    function extractBbox(url) {
      var m = String(url).match(/[?&]bbox=([^&]+)/);
      return m ? m[1] : null;
    }

    function recordFetch(kind) {
      var p = window._mapPerf;
      if (!p || !p.bbox) return;
      // Find the most recent pending fetch and update it.
      for (var i = state.fetches.length - 1; i >= 0; i--) {
        if (state.fetches[i].status === "pending") {
          state.fetches[i].bbox = p.bbox;
          state.fetches[i].duration = Math.round((p.render_end || performance.now()) - (p.fetch_start || performance.now()));
          state.fetches[i].aborted = !!p.aborted;
          state.fetches[i].status = p.aborted ? "aborted" : "ok";
          break;
        }
      }
      render();
    }

    // ── Build the floating UI ───────────────────────────────────────
    var btn = document.createElement("button");
    btn.id = "xyzo-debug-btn";
    btn.type = "button";
    btn.innerHTML = "🐛 debug";
    btn.setAttribute("aria-label", "Toggle map debug overlay");
    btn.style.cssText = [
      "position:fixed", "left:12px", "bottom:12px", "z-index:2147483500",
      "background:rgba(11,15,20,0.85)", "color:#5eead4",
      "border:1px solid rgba(94,234,212,0.45)", "border-radius:6px",
      "padding:6px 10px", "font:11px ui-monospace,monospace",
      "cursor:pointer", "box-shadow:0 4px 12px rgba(0,0,0,0.4)",
    ].join(";");
    document.body.appendChild(btn);

    var panel = document.createElement("div");
    panel.id = "xyzo-debug-panel";
    panel.style.cssText = [
      "position:fixed", "left:12px", "bottom:50px", "z-index:2147483500",
      "width:min(540px,calc(100vw - 24px))", "max-height:60vh",
      "background:rgba(11,15,20,0.97)", "color:#e6f1ff",
      "border:1px solid rgba(94,234,212,0.45)", "border-radius:8px",
      "padding:12px", "font:11px ui-monospace,monospace",
      "box-shadow:0 12px 32px rgba(0,0,0,0.5)", "display:none",
      "overflow:auto", "line-height:1.5",
    ].join(";");
    document.body.appendChild(panel);

    btn.addEventListener("click", function () {
      panel.style.display = panel.style.display === "none" ? "block" : "none";
      render();
    });

    // ── Action helpers ──────────────────────────────────────────────
    var TEST_CITIES = [
      { name: "Tokyo",       lat: 35.6762, lng: 139.6503, zoom: 6 },
      { name: "New York",    lat: 40.7128, lng: -74.0060, zoom: 6 },
      { name: "London",      lat: 51.5074, lng: -0.1278,  zoom: 6 },
      { name: "Sydney",      lat: -33.8688, lng: 151.2093, zoom: 6 },
      { name: "São Paulo",   lat: -23.5505, lng: -46.6333, zoom: 6 },
      { name: "Mumbai",      lat: 19.0760, lng: 72.8777,  zoom: 6 },
      { name: "Cairo",       lat: 30.0444, lng: 31.2357,  zoom: 6 },
    ];

    function forceRefetch() {
      // Bypass the throttle by calling the underlying function directly. The
      // function lives in app.js's module scope; we try the most likely
      // names so this works whether or not it was hoisted to a global.
      var fn = window.fetchPinsForViewport;
      if (typeof fn === "function") {
        try { fn(); return "fetchPinsForViewport() called"; } catch (e) { return "threw: " + e.message; }
      }
      return "fetchPinsForViewport not exposed globally — pan to trigger a fetch";
    }

    function clearCanvas() {
      var c = document.querySelector("canvas");
      if (c && c.getContext) {
        try { c.getContext("2d").clearRect(0, 0, c.width, c.height); return "canvas cleared"; }
        catch (e) { return "clear failed: " + e.message; }
      }
      return "no canvas found";
    }

    function reloadPage() { window.location.reload(); }

    function buildReport() {
      var b = map.getBounds();
      var now = new Date().toISOString();
      var lines = [];
      lines.push("# xyzo map debug report — " + now);
      lines.push("URL: " + window.location.href);
      lines.push("Viewport: center=(" + map.getCenter().lat.toFixed(4) + "," + map.getCenter().lng.toFixed(4) + ") zoom=" + map.getZoom());
      lines.push("Bounds: W=" + b.getWest().toFixed(4) + " S=" + b.getSouth().toFixed(4) + " E=" + b.getEast().toFixed(4) + " N=" + b.getNorth().toFixed(4));
      lines.push("");
      try {
        var md = window.__xyzoMarkerDiagnostics && window.__xyzoMarkerDiagnostics();
        lines.push("## Marker diagnostics");
        lines.push(JSON.stringify(md, null, 2));
        lines.push("");
      } catch (e) { lines.push("## Marker diagnostics: " + e.message); }
      try {
        var fd = window.__xyzoFetchDiagnostics && window.__xyzoFetchDiagnostics();
        lines.push("## Fetch diagnostics");
        lines.push(JSON.stringify(fd, null, 2));
        lines.push("");
      } catch (e) { lines.push("## Fetch diagnostics: " + e.message); }
      lines.push("## Recent moveend events (newest first)");
      state.pans.slice().reverse().forEach(function (p) {
        lines.push("  +" + ((Date.now() - p.t) / 1000).toFixed(1) + "s z=" + p.zoom + " center=(" + p.center[0].toFixed(3) + "," + p.center[1].toFixed(3) + ") bbox=" + p.bbox.map(function (n) { return n.toFixed(3); }).join(","));
      });
      lines.push("");
      lines.push("## Recent fetches (newest first)");
      state.fetches.slice().reverse().forEach(function (f) {
        lines.push("  +" + ((Date.now() - f.t) / 1000).toFixed(1) + "s " + f.status + " " + f.duration + "ms" + (f.aborted ? " [ABORTED]" : "") + " bbox=" + (f.bbox || "?"));
        lines.push("    url: " + f.url.slice(0, 200));
      });
      lines.push("");
      lines.push("## Aborts");
      if (state.aborts.length === 0) lines.push("  (none)");
      state.aborts.slice().reverse().forEach(function (a) {
        lines.push("  +" + ((Date.now() - a.t) / 1000).toFixed(1) + "s " + a.reason);
      });
      lines.push("");
      lines.push("## Throttle");
      lines.push("  fires=" + state.throttle.fires + " drops=" + state.throttle.drops);
      var navInfo = [];
      navInfo.push("navigator.onLine=" + navigator.onLine);
      navInfo.push("ua=" + (navigator.userAgent || "").slice(0, 80));
      lines.push(navInfo.join(" "));
      return lines.join("\n");
    }

    async function copyReport() {
      var text = buildReport();
      try {
        await navigator.clipboard.writeText(text);
        flashBtn(panel.querySelector("[data-act=copy]"), "✓ copied");
      } catch (e) {
        // Fallback: select-and-execCommand on a temp textarea
        var ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); flashBtn(panel.querySelector("[data-act=copy]"), "✓ copied"); }
        catch (_) { flashBtn(panel.querySelector("[data-act=copy]"), "✗ copy failed"); }
        document.body.removeChild(ta);
      }
    }

    function flashBtn(b, label) {
      if (!b) return;
      var orig = b.textContent;
      b.textContent = label;
      setTimeout(function () { b.textContent = orig; }, 900);
    }

    // ── Render the panel ────────────────────────────────────────────
    function fmt(secs) { return secs < 10 ? secs.toFixed(1) + "s" : Math.round(secs) + "s"; }

    function render() {
      if (panel.style.display === "none") return;
      var b = map.getBounds();
      var now = Date.now();
      var recentFetches = state.fetches.slice(-6).reverse();
      var recentPans = state.pans.slice(-6).reverse();
      var pinsInView = countPinsInBounds(b);

      var html = "";
      html += "<div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;\">";
      html += "<strong style=\"color:#5eead4;\">🐛 xyzo map debug</strong>";
      html += "<span style=\"color:#9bb0c9;\">" + (window._mapPerf ? "perf tracked ✓" : "no _mapPerf") + "</span>";
      html += "</div>";

      html += "<div style=\"margin-bottom:6px;\"><b>Map</b> z=" + map.getZoom() + " center=(" + map.getCenter().lat.toFixed(3) + "," + map.getCenter().lng.toFixed(3) + ")</div>";
      html += "<div style=\"margin-bottom:6px;color:#9bb0c9;\">bbox: W=" + b.getWest().toFixed(3) + " S=" + b.getSouth().toFixed(3) + " E=" + b.getEast().toFixed(3) + " N=" + b.getNorth().toFixed(3) + "</div>";

      // Action row
      html += "<div style=\"display:flex;flex-wrap:wrap;gap:4px;margin:8px 0;\">";
      html += btnHtml("copy", "📋 Copy report");
      html += btnHtml("refetch", "🔄 Force refetch");
      html += btnHtml("clear", "🧹 Clear canvas");
      html += btnHtml("reload", "↻ Reload page");
      html += "</div>";

      // Test cities row
      html += "<div style=\"margin:6px 0;color:#9bb0c9;\">Pan to:</div>";
      html += "<div style=\"display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 8px;\">";
      TEST_CITIES.forEach(function (c) {
        html += "<button data-act=\"pan\" data-lat=\"" + c.lat + "\" data-lng=\"" + c.lng + "\" data-z=\"" + c.zoom + "\" style=\"font:inherit;background:rgba(94,234,212,0.08);border:1px solid rgba(94,234,212,0.35);color:#5eead4;border-radius:4px;padding:3px 8px;cursor:pointer;\">" + c.name + "</button>";
      });
      html += "</div>";

      // Markers
      try {
        var md = window.__xyzoMarkerDiagnostics ? window.__xyzoMarkerDiagnostics() : null;
        if (md) {
          html += "<div style=\"margin:8px 0 4px;\"><b>Pins</b> mode=" + md.mode + " canvas=" + md.canvasPinCount + " dom=" + md.domPinCount + " in-view=" + pinsInView + "</div>";
        }
      } catch (_) {}

      // Fetch errors
      try {
        var fd = window.__xyzoFetchDiagnostics ? window.__xyzoFetchDiagnostics() : null;
        if (fd) {
          var cf = fd.consecutiveFailures || 0;
          var cfColor = cf > 0 ? "#f87171" : "#5eead4";
          html += "<div style=\"margin:4px 0;\"><b>Fetch</b> consecutive-failures=<span style=\"color:" + cfColor + "\">" + cf + "</span> online=" + fd.online + "</div>";
          if (fd.lastError) {
            html += "<div style=\"color:#f87171;margin:2px 0;\">last err: " + escapeHtml(JSON.stringify(fd.lastError).slice(0, 200)) + "</div>";
          }
        }
      } catch (_) {}

      // Recent pans
      html += "<div style=\"margin:8px 0 4px;\"><b>Recent pans (" + state.pans.length + ")</b></div>";
      if (recentPans.length === 0) html += "<div style=\"color:#9bb0c9;\">none yet</div>";
      recentPans.forEach(function (p) {
        var overlap = p.bbox ? (1 - overlapVsCurrent(p.bbox, b)) * 100 : "?";
        html += "<div style=\"border-left:2px solid #5eead4;padding-left:6px;margin:2px 0;\">";
        html += "+" + fmt((now - p.t) / 1000) + " z=" + p.zoom + " overlap=" + (typeof overlap === "number" ? overlap.toFixed(0) + "%" : overlap);
        html += "<br><span style=\"color:#9bb0c9;\">bbox=" + p.bbox.map(function (n) { return n.toFixed(2); }).join(",") + "</span>";
        html += "</div>";
      });

      // Recent fetches
      html += "<div style=\"margin:8px 0 4px;\"><b>Recent fetches (" + state.fetches.length + ")</b></div>";
      if (recentFetches.length === 0) html += "<div style=\"color:#9bb0c9;\">none yet</div>";
      recentFetches.forEach(function (f) {
        var color = f.aborted ? "#f59e0b" : (f.status === "ok" ? "#5eead4" : "#f87171");
        var ovl = f.bbox ? (1 - overlapVsCurrent(f.bbox.split(",").map(Number), b)) * 100 : null;
        html += "<div style=\"border-left:2px solid " + color + ";padding-left:6px;margin:2px 0;\">";
        html += "+" + fmt((now - f.t) / 1000) + " " + escapeHtml(String(f.status)) + " " + f.duration + "ms" + (f.aborted ? " ⚠️ABORTED" : "");
        if (ovl !== null) html += " overlap=" + ovl.toFixed(0) + "%";
        html += "<br><span style=\"color:#9bb0c9;\">" + escapeHtml(f.url.slice(0, 180)) + "</span>";
        html += "</div>";
      });

      // Aborts
      if (state.aborts.length) {
        html += "<div style=\"margin:8px 0 4px;\"><b>Aborts</b> (" + state.aborts.length + ")</div>";
        state.aborts.slice(-4).reverse().forEach(function (a) {
          html += "<div style=\"color:#f59e0b;\">+" + fmt((now - a.t) / 1000) + " " + escapeHtml(a.reason) + "</div>";
        });
      }

      panel.innerHTML = html;
      attachHandlers();
    }

    function btnHtml(act, label) {
      return "<button data-act=\"" + act + "\" style=\"font:inherit;background:rgba(94,234,212,0.12);border:1px solid rgba(94,234,212,0.4);color:#5eead4;border-radius:4px;padding:4px 8px;cursor:pointer;\">" + label + "</button>";
    }

    function attachHandlers() {
      panel.querySelectorAll("button[data-act]").forEach(function (b) {
        b.onclick = function () {
          var act = b.getAttribute("data-act");
          if (act === "copy") return copyReport();
          if (act === "refetch") flashBtn(b, forceRefetch());
          if (act === "clear") flashBtn(b, clearCanvas());
          if (act === "reload") reloadPage();
          if (act === "pan") {
            var lat = Number(b.getAttribute("data-lat"));
            var lng = Number(b.getAttribute("data-lng"));
            var z = Number(b.getAttribute("data-z"));
            map.setView([lat, lng], z);
            // setView fires moveend; we want to log it ourselves too
            state.pans.push({
              t: Date.now(),
              center: [lat, lng],
              zoom: z,
              bbox: (function () { var bb = map.getBounds(); return [bb.getWest(), bb.getSouth(), bb.getEast(), bb.getNorth()]; })(),
            });
            if (state.pans.length > 12) state.pans.shift();
            flashBtn(b, "→ " + b.textContent.split(" ")[0]);
            setTimeout(render, 300);
          }
        };
      });
    }

    // ── Helpers ────────────────────────────────────────────────────
    function countPinsInBounds(b) {
      // We can introspect canvas pin array if exposed; fall back to 0.
      try {
        var md = window.__xyzoMarkerDiagnostics && window.__xyzoMarkerDiagnostics();
        return md ? (md.canvasPinCount || 0) : 0;
      } catch (_) { return 0; }
    }

    function overlapVsCurrent(bbox, currentBounds) {
      if (!bbox || bbox.length !== 4 || !bbox.every(Number.isFinite)) return 0;
      var w = Math.max(bbox[0], currentBounds.getWest());
      var e = Math.min(bbox[2], currentBounds.getEast());
      var s = Math.max(bbox[1], currentBounds.getSouth());
      var n = Math.min(bbox[3], currentBounds.getNorth());
      if (e <= w || n <= s) return 0;
      var w0 = Math.max(0.000001, (bbox[2] - bbox[0]) * (1 / Math.max(0.05, Math.cos(((s + n) / 2 * Math.PI) / 180))));
      var h0 = Math.max(0.000001, bbox[3] - bbox[1]);
      return (e - w) * (1 / Math.max(0.05, Math.cos(((s + n) / 2 * Math.PI) / 180))) * (n - s) / (w0 * h0);
    }

    function escapeHtml(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    // Periodically re-render so timestamps and counts stay live
    setInterval(render, 1500);
    render();
  }
})();
