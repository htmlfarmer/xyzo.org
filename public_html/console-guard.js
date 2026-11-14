// ── Console Guard ──────────────────────────────────────────────────────
// Loads FIRST (before Leaflet, analytics, app.js) to silence known noise.
// Keeps the console clean for real developer signals.
//
// Rules:
//   1. Third-party deprecation warnings (Leaflet mozPressure, etc.) → dropped
//   2. XYZO app code should NEVER use console.warn/error/log directly.
//      Use the global `XLog` object (defined below) which is silent unless
//      window.XYZO_DEBUG is set.
//   3. To enable debug logging: window.XYZO_DEBUG = true (in DevTools console)
//
// If you need to add a new suppression pattern, add it to SUPPRESS_PATTERNS.
// ────────────────────────────────────────────────────────────────────────

(function consoleGuard() {
  "use strict";

  // ── Firefox's "MouseEvent.mozPressure is deprecated" ────────────────
  //
  // IT LOOKS SUPPRESSIBLE AND ISN'T — the pattern list below catches
  // the message when it comes through `console.warn`, but Firefox's
  // deprecation notice is emitted BY THE BROWSER, straight to the
  // console, and never passes through a console method. So the pattern
  // never fires for it.
  //
  // WHERE IT COMES FROM: Leaflet 1.1.1 copies the DOM event with
  // `for (var j in src)` (its `Util.extend`). Firefox keeps
  // `mozPressure` / `mozInputSource` as ENUMERABLE getters on
  // `MouseEvent.prototype`, so that loop READS them — and reading a
  // deprecated property is what prints the warning. (Leaflet's own
  // source contains neither name — the vendored file has zero
  // occurrences of "pressure" — which is why this looked impossible
  // to fix from the page.)
  //
  // THE FIX: make the two getters NON-ENUMABLE. The getter itself is
  // untouched — a direct `e.mozPressure` still works (and still warns,
  // as it should) — but `for...in` no longer reaches it, so Leaflet
  // never reads it and the notice never fires.
  //
  // MEASURED in Firefox on the live map: BEFORE the patch, both
  // warnings on every click; AFTER, **silent** — and the map, the
  // satellite popup and its mini map are all unaffected (4 Esri tiles
  // still loaded).
  //
  // In Chrome (and any browser without the descriptors) this is a
  // no-op: the property is simply not there.
  try {
    for (const prop of ["mozPressure", "mozInputSource"]) {
      const proto = (typeof MouseEvent !== "undefined") ? MouseEvent.prototype : null;
      if (!proto) continue;
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.get || d.configurable === false) continue;
      Object.defineProperty(proto, prop, {
        get: d.get,
        set: d.set,
        configurable: true,
        enumerable: false,
      });
    }
  } catch (_) {
    // A browser that refuses the change keeps the warnings. They are
    // harmless, and the pattern list still catches the copies that
    // come through console.warn.
  }

  const SUPPRESS_PATTERNS = [
    // Leaflet 1.9.x Firefox deprecation spam
    /MouseEvent\.mozPressure is deprecated/i,
    /MouseEvent\.mozInputSource is deprecated/i,
    /Use PointerEvent\.pressure instead/i,
    /Use PointerEvent\.pointerType instead/i,
    // Generic catches
    /mozPressure/i,
    /mozInputSource/i,
    /PointerEvent\.pressure/i,
    /PointerEvent\.pointerType/i,
    // ResizeObserver loop warnings (benign, caused by Leaflet map resize)
    /ResizeObserver loop/i,
    /ResizeObserver loop completed with undelivered notifications/i,
    // Third-party analytics / ad tech noise
    /Failed to load resource.*google-analytics/i,
    /Failed to load resource.*googlesyndication/i,
    /Failed to load resource.*doubleclick/i,
    // Chrome extension noise
    /message port closed before a response was received/i,
    // Service worker noise
    /service-worker/i,
    // PayPal / third-party cookie warnings (browser-native, not suppressible via JS)
    /Cookie.*will soon be rejected/i,
    /does not have the "Partitioned" attribute/i,
    /Foreign and does not have/i,
    // OpaqueResponseBlocking (CORS preflight, benign)
    /OpaqueResponseBlocking/i,
    /blocked by OpaqueResponseBlocking/i,
    // PayPal SDK loading failures (undefined client-id)
    /paypal\.com\/sdk\/js/i,
    /Loading failed for the.*script.*paypal/i,
    // Google APIs / location
    /Network location provider.*googleapis/i,
    /Returned error code 400.*googleapis/i,
    /Loading failed for the.*script.*maps\.googleapis/i,
    // Internal API / SSE noise
    /Failed to load resource.*discovery-status/i,
    /api\/discovery-status.*502/i,
    /ERR_HTTP2_PROTOCOL_ERROR/i,
    /net::ERR_HTTP2_PROTOCOL_ERROR/i,
    // 502 / 504 gateway errors (internal endpoints, non-critical)
    /api\/.*502/i,
    /api\/.*504/i,
    /Loading failed.*502/i,
    /Loading failed.*504/i,
    // CORS image loading errors (remote images blocked by CORS policy)
    /Access to image at .* from origin .* has been blocked by CORS/i,
    /No 'Access-Control-Allow-Origin' header is present/i,
    // image-proxy failures (400/404/502 from our own proxy endpoint)
    /image-proxy.*400/i,
    /image-proxy.*404/i,
    /image-proxy.*502/i,
    /GET.*image-proxy.*(?:400|404|502)/i,
    // DNS resolution failures for broken image URLs
    /net::ERR_NAME_NOT_RESOLVED/i,
    /net::ERR_FAILED/i,
    // Generic image load failures
    /Failed to load resource.*(?:jpg|jpeg|png|gif|webp|svg)/i,
  ];

  function shouldSuppress(args) {
    const text = args
      .map((a) => (typeof a === "string" ? a : a?.message || String(a)))
      .join(" ");
    return SUPPRESS_PATTERNS.some((re) => re.test(text));
  }

  // Intercept ALL console methods to catch any warnings Leaflet might emit
  for (const level of ["warn", "error", "log", "info", "debug"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      if (shouldSuppress(args)) return;
      original(...args);
    };
  }

  // Intercept window.onerror for any synchronous errors
  const originalOnError = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    if (shouldSuppress([String(message)])) return true;
    if (originalOnError) return originalOnError(message, source, lineno, colno, error);
    return false;
  };

  // Catch unhandled promise rejections
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason?.message || String(event.reason || "");
    if (shouldSuppress([reason])) {
      event.preventDefault();
    }
  });

  // ── Silent logger for app code ──────────────────────────────────────
  // All XYZO code uses XLog instead of console.warn/error/log.
  // Output only appears when window.XYZO_DEBUG is truthy.
  window.XLog = {
    warn: (...a) => { if (window.XYZO_DEBUG) console["warn"](...a); },
    error: (...a) => { if (window.XYZO_DEBUG) console["error"](...a); },
    log: (...a) => { if (window.XYZO_DEBUG) console["log"](...a); },
    debug: (...a) => { if (window.XYZO_DEBUG) console["debug"](...a); },
  };
})();
