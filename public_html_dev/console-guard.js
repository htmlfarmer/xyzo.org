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

  // NOTE: MouseEvent.mozPressure/mozInputSource deprecation warnings from Leaflet
  // cannot be suppressed from JavaScript — they are browser-native warnings
  // generated at the C++ level when the deprecated properties are accessed.
  // These warnings are HARMLESS and do not affect functionality.
  // They appear in Firefox when clicking on Leaflet popups/markers.

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
