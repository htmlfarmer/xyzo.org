// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  Xyzo — The World's News, On a Map                                ║
// ║  13,000+ lines of vanilla JS. No build step. No mercy.             ║
// ║  If you're reading this, you're either a contributor or a machine. ║
// ║  Either way, we respect you.                                       ║
// ╚═══════════════════════════════════════════════════════════════════════╝
//
// "Why is this one file?"
// Because a single file means: no bundler, no transpiler, no node_modules,
// no webpack config, no "why isn't HMR working", no "oh the build broke".
// Just edit, save, refresh. That's the whole development experience.
// Is it ideal? No. Is it fast? Extremely.
//
// "Why no comments?"
// There are now. You're welcome.

// ── Popup Enrichment Helpers ─────────────────────────────────────────
// These make the map popups actually useful instead of just showing
// a title and a link. Math included at no extra charge.
function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) return null;
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return Math.round(R * c);
}

function formatPopupDistance(lat, lng) {
  const ref = (liveState && liveState.home) ? liveState.home : (typeof map !== 'undefined' ? map.getCenter() : null);
  if (!ref || !Number.isFinite(ref.lat) || !Number.isFinite(ref.lng)) return "";
  const dist = calculateDistanceKm(ref.lat, ref.lng, lat, lng);
  if (dist == null) return "";
  if (dist < 1) return "📍 <1 km from you";
  if (dist < 1000) return `📍 ${dist} km from you`;
  return `📍 ${(dist/1000).toFixed(1)}k km away`;
}

function estimateReadingTimeText(text) {
  const words = (text || "").trim().split(/\s+/).length;
  const mins = Math.max(1, Math.round(words / 150));
  return `📖 ${mins} min read`;
}


// Maps a parent bucket to subcategories that should be shown when that bucket is filtered.
// Think of this as "if someone clicks 'Tech', show them AI, cybersecurity, gaming, etc."
// If you're adding a new category, add it here FIRST or it won't show up in the filter.
const CATEGORY_ROLLUPS = {
  tech: ["technology", "ai", "cybersecurity", "gaming", "telecom"],
  technology: ["ai", "cybersecurity", "gaming", "telecom"],
  politics: ["elections", "courts", "policy", "diplomacy", "protest"],
  business: ["markets", "banking", "crypto", "realestate", "labor"],
  crime: ["shooting", "terrorism", "cybercrime", "missing", "traffic"],
  weather: ["storm", "floods", "wildfire", "drought", "snow", "heatwave"],
  science: ["space", "biology", "physics", "research"],
  sports: ["soccer", "basketball", "olympics", "racing"],
  culture: ["music", "film", "art", "books"],
  environment: ["climate", "wildlife", "pollution", "energy"],
  health: ["outbreak", "medical", "mental_health"],
  conflict: ["war", "military"],
  disaster: ["earthquake", "volcano"],
  humanitarian: ["refugees", "aid"],
};

// ── Global Shutdown Check ─────────────────────────────────────────────
// On page load, check if the site is shut down. If so, show a maintenance
// banner and prevent most interactions. This is the community's emergency
// brake — if enough people complain, the site goes offline until an admin
// resets it. Think of it as a democratic "something is very wrong" signal.
async function checkShutdownStatus() {
  try {
    const res = await fetch("/api/shutdown/status");
    if (!res.ok) return;
    const data = await res.json();
    if (data.is_shutdown) {
      showShutdownBanner(data);
    }
  } catch { /* ignore — if we can't reach the API, just let the site load */ }
}

function showShutdownBanner(stats) {
  // Remove any existing shutdown banner
  const existing = document.getElementById("shutdown-banner");
  if (existing) existing.remove();

  const banner = document.createElement("div");
  banner.id = "shutdown-banner";
  banner.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 100000;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    color: #e0e0e0; padding: 16px 20px; text-align: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    border-bottom: 2px solid #ff6b6b;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  `;
  banner.innerHTML = `
    <div style="max-width: 600px; margin: 0 auto;">
      <div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>
      <div style="font-size: 16px; font-weight: 600; color: #ff6b6b; margin-bottom: 8px;">
        xyzo.org is temporarily offline
      </div>
      <div style="font-size: 13px; color: #aaa; line-height: 1.5; margin-bottom: 12px;">
        We received community feedback about an issue and are working to resolve it.
        The site will be back online once an administrator reviews and resets the system.
      </div>
      <div style="font-size: 11px; color: #666;">
        ${stats.complaints_24h || 0} complaints in the last 24 hours
        ${stats.active_users ? ` · ${stats.active_users} active users` : ""}
      </div>
    </div>
  `;
  document.body.prepend(banner);

  // Also show a modal-style overlay
  const overlay = document.createElement("div");
  overlay.id = "shutdown-overlay";
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.85); z-index: 99999;
    display: flex; align-items: center; justify-content: center;
  `;
  overlay.innerHTML = `
    <div style="background: #1a1a2e; border: 1px solid #333; border-radius: 12px;
                padding: 40px; max-width: 420px; text-align: center;
                box-shadow: 0 20px 60px rgba(0,0,0,0.8);">
      <div style="font-size: 48px; margin-bottom: 16px;">🔧</div>
      <h2 style="color: #ff6b6b; margin: 0 0 12px; font-size: 20px;">
        Maintenance Mode
      </h2>
      <p style="color: #aaa; font-size: 14px; line-height: 1.6; margin: 0 0 20px;">
        xyzo.org has been temporarily shut down due to community feedback.
        Our team is reviewing the issue.
      </p>
      <p style="color: #666; font-size: 12px; margin: 0;">
        If you're an administrator, reset via the API or dashboard.
      </p>
    </div>
  `;
  document.body.prepend(overlay);
}

// Check shutdown on page load (non-blocking)
checkShutdownStatus();

// Global Search State variables (declared early to prevent Temporal Dead Zone ReferenceErrors)
// Yes, we've been bitten by that bug. It's exactly as fun as it sounds.
let searchInput = null;
let searchBtn = null;
let searchClear = null;
let searchStatus = null;
let searchActive = false;

// ── Global System Error Handler & Warning Banner ──────────────────────
// When things go wrong, we show a banner. When things go really wrong,
// we show a banner with an emoji. When things go REALLY really wrong,
// we just quietly log it and hope nobody notices. (Just kidding. We always log it.)
let _lastSystemErrorTime = 0;

function showSystemErrorBanner(message, options = {}) {
  const now = Date.now();
  if (now - _lastSystemErrorTime < 10000 && !options.force) return;
  _lastSystemErrorTime = now;

  let banner = document.getElementById("system-wide-error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "system-wide-error-banner";
    banner.className = "system-wide-error-banner";
    banner.setAttribute("role", "alert");
    document.body.appendChild(banner);
  }

  const userMsg = message || "We detected a temporary issue while loading map data and our team is resolving it.";
  
  banner.innerHTML = `
    <div class="system-error-inner">
      <div class="system-error-left">
        <span class="system-error-icon">⚠️</span>
        <span class="system-error-text">
          <strong>System Notice:</strong> ${escapeHtml(userMsg)}
        </span>
      </div>
      <div class="system-error-right">
        <button type="button" class="system-error-btn help-btn" id="system-banner-help-btn">Help & Support</button>
        <button type="button" class="system-error-btn reload-btn" id="system-banner-reload-btn">Reload Page</button>
        <button type="button" class="system-error-close" id="system-banner-close-btn" aria-label="Dismiss warning">✕</button>
      </div>
    </div>
  `;

  banner.hidden = false;

  const helpBtn = document.getElementById("system-banner-help-btn");
  if (helpBtn) {
    helpBtn.addEventListener("click", () => {
      const helpPanel = document.getElementById("help-panel");
      if (helpPanel) {
        helpPanel.hidden = false;
      } else {
        window.open("/help/", "_blank");
      }
    });
  }

  const reloadBtn = document.getElementById("system-banner-reload-btn");
  if (reloadBtn) {
    reloadBtn.addEventListener("click", () => window.location.reload());
  }

  const closeBtn = document.getElementById("system-banner-close-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      banner.hidden = true;
    });
  }
}

// Global exception listeners
window.addEventListener("error", function (e) {
  if (!e || !e.message) return;
  const msg = e.message;
  if (msg.includes("ResizeObserver") || msg.includes("Script error")) return;
  // Filter third-party script errors (extensions, ads, analytics)
  const src = e.filename || "";
  if (src && !src.includes("xyzo.org") && !src.includes("/app.js") && !src.includes("/public_html/")) return;
  XLog.warn("[System Error Handler]", msg, e.filename, e.lineno);
  showSystemErrorBanner("We encountered a temporary interface issue and our team is resolving it. If pins are missing, try refreshing.");
});

window.addEventListener("unhandledrejection", function (e) {
  const reason = e?.reason?.message || String(e?.reason || "");
  if (reason.includes("AbortError") || reason.includes("cancel")) return;
  // Filter common non-critical rejections
  if (reason.includes("Failed to fetch") || reason.includes("NetworkError")) return;
  XLog.warn("[System Rejection Handler]", reason);
  showSystemErrorBanner("A network or data request encountered a temporary error. Please try refreshing or visit Help.");
});


// ── User Activity Tracking & Recommendation Engine ────────────────────
const USER_ACTIVITY_KEY = "xyzo-user-activity";

const UserTracker = {
  get() {
    try {
      const raw = localStorage.getItem(USER_ACTIVITY_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { categories: {}, searches: [], locations: [], lastUpdated: Date.now() };
  },

  save(data) {
    try {
      data.lastUpdated = Date.now();
      localStorage.setItem(USER_ACTIVITY_KEY, JSON.stringify(data));
    } catch (_) {}
  },

  trackCategory(category) {
    if (!category || category === "other") return;
    const data = this.get();
    const cat = String(category).toLowerCase();
    data.categories[cat] = (data.categories[cat] || 0) + 1;
    this.save(data);
    if (typeof liveState !== "undefined" && liveState.activeTab === "your") renderLivePanel();
  },

  trackSearch(query) {
    if (!query || String(query).trim().length < 2) return;
    const data = this.get();
    const q = String(query).trim().toLowerCase();
    if (!data.searches.includes(q)) {
      data.searches.unshift(q);
      data.searches = data.searches.slice(0, 15);
    }
    this.save(data);
    if (typeof liveState !== "undefined" && liveState.activeTab === "your") renderLivePanel();
  },

  trackLocation(lat, lng, placeName) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const data = this.get();
    data.locations.unshift({ lat, lng, placeName, time: Date.now() });
    data.locations = data.locations.slice(0, 5);
    this.save(data);
  },

  getTopCategories() {
    const data = this.get();
    return Object.entries(data.categories || {})
      .sort((a, b) => b[1] - a[1])
      .map(([cat]) => cat);
  }
};

const KEYWORD_TO_CATEGORY = {
  "electronics": "tech",
  "tech": "tech",
  "technology": "tech",
  "gadgets": "tech",
  "software": "tech",
  "hardware": "tech",
  "ai": "tech",
  "computer": "tech",
  "cyber": "tech",
  "business": "business",
  "finance": "business",
  "economy": "business",
  "market": "business",
  "stock": "business",
  "bank": "business",
  "crypto": "business",
  "disaster": "disaster",
  "earthquake": "disaster",
  "flood": "disaster",
  "storm": "disaster",
  "fire": "disaster",
  "hurricane": "disaster",
  "tsunami": "disaster",
  "wildfire": "disaster",
  "politics": "politics",
  "election": "politics",
  "government": "politics",
  "president": "politics",
  "minister": "politics",
  "parliament": "politics",
  "health": "health",
  "virus": "health",
  "hospital": "health",
  "vaccine": "health",
  "medical": "health",
  "disease": "health",
  "sports": "sports",
  "football": "sports",
  "soccer": "sports",
  "nba": "sports",
  "olympics": "sports",
  "science": "science",
  "space": "science",
  "nasa": "science",
  "climate": "science",
  "physics": "science",
  "culture": "culture",
  "art": "culture",
  "music": "culture",
  "movie": "culture",
  "film": "culture"
};

function autoSelectLegendCategoryForQuery(query) {
  if (!query) return;
  const tokens = String(query).toLowerCase().split(/\s+/);
  for (const token of tokens) {
    const cat = KEYWORD_TO_CATEGORY[token];
    if (cat) {
      UserTracker.trackCategory(cat);
      break;
    }
  }
}

"use strict";

// ── Note: XLog is defined globally in console-guard.js ──────────────────
// Use XLog.warn(), XLog.error(), XLog.log() instead of console.*.
// Output only appears when window.XYZO_DEBUG is truthy.

// ── Lazy chunk loader ───────────────────────────────────────────────────
//
// app.js ships one big bundle, but a few user-initiated features live
// in their own files so we don't have to download their JS on first
// paint:
//
//   flag-quality.js   — Quick Flag dialog + per-pin Report Quality
//   ai-story-chat.js  — "Ask AI about this story" floating chat
//
// Both are loaded on demand the first time the user clicks the trigger.
// The chunks attach their public functions to window (XyzoFlagQuality,
// XyzoAiStoryChat); we call into them via thin wrappers below so the
// rest of app.js doesn't need to know the chunk's symbol names.

const _chunkPromises = Object.create(null);
function loadChunk(src) {
  if (_chunkPromises[src]) return _chunkPromises[src];
  _chunkPromises[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      _chunkPromises[src] = null;  // allow retry on next call
      reject(new Error(`Failed to load ${src}`));
    };
    document.head.appendChild(s);
  });
  return _chunkPromises[src];
}

// ── Lazy chunk wrappers ─────────────────────────────────────────────────
//
// These thin wrappers are the public API used elsewhere in app.js. The
// first invocation triggers a dynamic <script> injection; subsequent
// invocations reuse the cached chunk. The original call sites
// (showQuickFlagDialog, showReportDialog, openPinAiChat) used to be
// defined inline in app.js — they're now defined inside the chunks.

function showQuickFlagDialog(prefill) {
  if (window.XyzoFlagQuality && window.XyzoFlagQuality.showQuickFlagDialog) {
    window.XyzoFlagQuality.showQuickFlagDialog(prefill);
    return;
  }
  loadChunk('flag-quality.js?v=202611142000').then(() => {
    if (window.XyzoFlagQuality && window.XyzoFlagQuality.showQuickFlagDialog) {
      window.XyzoFlagQuality.showQuickFlagDialog(prefill);
    }
  }).catch((e) => XLog.warn('[xyzo] flag-quality.js load failed:', e));
}

function showReportDialog(pin) {
  if (window.XyzoFlagQuality && window.XyzoFlagQuality.showReportDialog) {
    window.XyzoFlagQuality.showReportDialog(pin);
    return;
  }
  loadChunk('flag-quality.js?v=202611142000').then(() => {
    if (window.XyzoFlagQuality && window.XyzoFlagQuality.showReportDialog) {
      window.XyzoFlagQuality.showReportDialog(pin);
    }
  }).catch((e) => XLog.warn('[xyzo] flag-quality.js load failed:', e));
}

function openPinAiChat(pin) {
  if (window.XyzoAiStoryChat && window.XyzoAiStoryChat.open) {
    window.XyzoAiStoryChat.open(pin);
    return;
  }
  loadChunk('ai-story-chat.js?v=202611142000').then(() => {
    if (window.XyzoAiStoryChat && window.XyzoAiStoryChat.open) {
      window.XyzoAiStoryChat.open(pin);
    }
  }).catch((e) => XLog.warn('[xyzo] ai-story-chat.js load failed:', e));
}

function closeReportDialog() {
  if (window.XyzoFlagQuality && window.XyzoFlagQuality.closeReportDialog) {
    window.XyzoFlagQuality.closeReportDialog();
  }
}

// Wire the top-bar Flag button. We attach the click handler here in
// app.js (not as an inline onclick) so the rest of the file stays
// consistent with the other top-bar controls that are wired the same
// way (Help, Share, Legend, Explore).
//
// IMPORTANT: app.js is loaded with `defer`, so by the time this runs
// the DOM is parsed but DOMContentLoaded may have already fired (in
// some browsers/conditions).  An unconditional addEventListener for
// DOMContentLoaded will be queued forever and never fire.  Use the
// readyState check to call the wiring function immediately when the
// DOM is already ready.
(function wireFlagButton() {
  function attach() {
    const btn = document.getElementById("flag-btn");
    if (btn && !btn.dataset.wired) {
      btn.addEventListener("click", () => showQuickFlagDialog());
      btn.dataset.wired = "1";
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach, { once: true });
  } else {
    attach();
  }
})();

// ── Splash Screen Dismissal ─────────────────────────────────────────
// The splash screen is defined in index.html. It shows a branded loading
// animation while the map initializes. We dismiss it after the first
// ── Client-side error logging ────────────────────────────────────────
// Captures JavaScript errors and posts them to the server for debugging.
// Sanitizes stack traces to remove potential PII (file paths, etc.)
const ClientErrorLogger = {
  _queue: [],
  _flushTimer: null,
  _sessionId: null,

  // Strip passwords, tokens, API keys, emails, and other PII from error data
  _sanitize(str) {
    if (!str || typeof str !== 'string') return str;
    return str
      // Remove common password patterns
      .replace(/(password|passwd|pwd)[=:]\s*["']?[^\s"'&]+/gi, '$1=[REDACTED]')
      // Remove API keys and tokens
      .replace(/(api[_-]?key|apikey|token|auth|bearer|secret|client[_-]?secret)[=:]\s*["']?[^\s"'&]+/gi, '$1=[REDACTED]')
      // Remove email addresses
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
      // Remove potential GPS coordinates in URLs (privacy)
      .replace(/[?&](lat|lng|latitude|longitude|loc|location)[=][-0-9.]+/gi, '&$1=[REDACTED]')
      // Remove local file paths
      .replace(/\/home\/[^\/]+/g, '/home/[USER]')
      .replace(/C:\\Users\\[^\/\\]+/gi, 'C:\\Users\\[USER]')
      // Remove localhost with ports (potential internal API info)
      .replace(/localhost:[0-9]{2,}/gi, 'localhost:[PORT]')
      // Remove private IPs
      .replace(/\b(?:192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+)\b/g, '[PRIVATE_IP]')
      // Truncate very long strings (accidental data dumps)
      .slice(0, 2000);
  },

  _sanitizeError(error) {
    return {
      ...error,
      message: this._sanitize(error.message),
      filename: this._sanitize(error.filename),
      stack: this._sanitize(error.stack),
      url: this._sanitize(error.url),
    };
  },

  init() {
    // Get session ID
    try {
      this._sessionId = localStorage.getItem('xyzo.session') || null;
    } catch {}

    // Capture unhandled errors
    window.addEventListener('error', (e) => {
      this.log({
        type: 'error',
        message: e.message?.slice(0, 500) || 'Unknown error',
        filename: e.filename?.slice(0, 500) || '',
        lineno: e.lineno || 0,
        colno: e.colno || 0,
        stack: e.error?.stack?.slice(0, 2000) || '',
        url: window.location.href,
      });
    });

    // Capture unhandled promise rejections
    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason;
      this.log({
        type: 'unhandledrejection',
        message: (reason?.message || String(reason) || 'Unknown rejection').slice(0, 500),
        stack: reason?.stack?.slice(0, 2000) || '',
        url: window.location.href,
      });
    });

    // Capture console.error calls
    const origError = console.error;
    console.error = (...args) => {
      origError.apply(console, args);
      const msg = args.map(a => typeof a === 'string' ? a : (a?.message || String(a))).join(' ');
      if (msg.length > 10 && !msg.includes('mozPressure') && !msg.includes('mozInputSource')) {
        this.log({
          type: 'console.error',
          message: msg.slice(0, 500),
          url: window.location.href,
        });
      }
    };
  },

  log(error) {
    // Sanitize PII before queueing
    const clean = this._sanitizeError(error);
    // Dedupe: don't log the same error message repeatedly
    const key = `${clean.type}:${clean.message?.slice(0, 100)}`;
    if (this._recentErrors?.has(key)) return;
    if (!this._recentErrors) this._recentErrors = new Set();
    this._recentErrors.add(key);
    setTimeout(() => this._recentErrors.delete(key), 30000); // Reset after 30s

    this._queue.push(clean);
    if (this._queue.length >= 5) {
      this.flush();
    } else if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this.flush(), 10000);
    }
  },

  flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._queue.length === 0) return;

    const errors = this._queue.splice(0, 10);
    try {
      fetch('/api/analytics/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this._sessionId,
          errors,
        }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  },
};

// Initialize error logging
ClientErrorLogger.init();

// ── Tile providers ─────────────────────────────────────────────────────
// All tiles below are 100% free, no API key, no registration required.
const TILE_LAYERS = {
  // ── Every base layer is served through OUR OWN tile mirror ───────────
  // /api/tile/mirror/<id>/{z}/{x}/{y} (api/src/routes/tileMirror.ts):
  // the origin is asked once, the copy lives on our disk, and past its
  // TTL the proxy REVALIDATES rather than trusting it — so the reader
  // gets a local tile and the origin still gets asked whether it has
  // changed. The URLs are built server-side from a whitelist (no SSRF
  // surface), and they carry NO file extension because Caddy's
  // `@staticAssets` block stamps `*.png` with a year of `immutable`,
  // which would defeat the freshness the mirror exists for.
  // Attribution is unchanged below: who the picture is FROM has not
  // changed just because the bytes now come from us.
  //
  // OpenStreetMap — the gold standard for open map data
  "🗺️ Street": L.tileLayer("/api/tile/mirror/osm/{z}/{x}/{y}", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }),
  // ESRI World Imagery — high-quality satellite/aerial imagery
  "🛰️ Satellite": L.tileLayer("/api/tile/mirror/esri-imagery/{z}/{x}/{y}", {
    maxZoom: 19,
    attribution: "Source: Esri, Maxar, Earthstar Geographics",
  }),
  // OpenTopoMap — topographic maps with terrain contours
  "🗺️ Topo": L.tileLayer("/api/tile/mirror/opentopo/{z}/{x}/{y}", {
    maxZoom: 17,
    attribution: "Map data: © OpenStreetMap contributors, SRTM | Map style: © OpenTopoMap (CC-BY-SA)",
  }),
  // ESRI Streets — detailed street map
  "🗺️ Streets": L.tileLayer("/api/tile/mirror/esri-street/{z}/{x}/{y}", {
    maxZoom: 19,
    attribution: "Source: Esri, HERE, Garmin, © OpenStreetMap contributors",
  }),
  // ESRI NatGeo — National Geographic style
  "🗺️ NatGeo": L.tileLayer("/api/tile/mirror/esri-natgeo/{z}/{x}/{y}", {
    maxZoom: 12,
    attribution: "Source: Esri, National Geographic",
  }),
  // ESRI Terrain — terrain with elevation
  "🗺️ Terrain": L.tileLayer("/api/tile/mirror/esri-terrain/{z}/{x}/{y}", {
    maxZoom: 13,
    attribution: "Source: Esri, USGS",
  }),
  // ESRI Dark Grey — dark theme for data visualization
  "🗺️ Dark": L.tileLayer("/api/tile/mirror/esri-dark/{z}/{x}/{y}", {
    maxZoom: 16,
    attribution: "Source: Esri, HERE, Garmin",
  }),
  // ESRI Light Grey — light theme for clean design
  "🗺️ Light": L.tileLayer("/api/tile/mirror/esri-light/{z}/{x}/{y}", {
    maxZoom: 16,
    attribution: "Source: Esri, HERE, Garmin",
  }),
};


// ── NASA GIBS weather & satellite overlays ──────────────────────────────
// NASA GIBS (Global Imagery Browse Services) provides 100% free, open-access
// real-time satellite imagery and weather layers via standard WMTS EPSG:3857.
// No API key required; full resolution imagery updated daily.
function nasaDate(daysAgo = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// The NASA overlays come through OUR tile proxy, not straight from
// GIBS.
//
// GIBS publishes a tile only where the product has a value, and it
// answers HTTP 404 for the rest — the open ocean and the poles have
// no rain, so there is no tile. A 404 on a tile is a 404 on an <img>,
// and the BROWSER logs it: the reader's console filled with red lines
// that said nothing useful, and no JavaScript can suppress a message
// the network layer produced.
//
// The proxy applies the same rule the image proxy already uses — a
// missing tile answers HTTP 200 with a 1x1 transparent PNG — and it
// caches, so the second reader of the same view costs nothing.
//
// The URL is built SERVER-side from a whitelist (the dataset, the
// date, the zoom and the tile numbers), so the route has no SSRF
// surface at all.
function nasaTileUrl(dataset, date, matrix) {
  // GIBS's GoogleMapsCompatible matrices are numbered in the standard
  // XYZ order, and the layer's own zoom range is the matrix's — the
  // proxy refuses a level the matrix does not have (GIBS answers 400
  // for it, and a 400 is a console error too).
  return `/api/tile/${dataset}/${date}/{z}/{y}/{x}`;
}

const WEATHER_OVERLAYS = {
  "🛰️ NASA Satellite (True Color)": L.tileLayer(
    nasaTileUrl("satellite", nasaDate(1)),
    { maxZoom: 9, minZoom: 1, opacity: 0.85, attribution: "© NASA GIBS / Suomi NPP VIIRS" }
  ),
  "🌧️ NASA Rain Rate (IMERG)": L.tileLayer(
    nasaTileUrl("rain", nasaDate(2)),
    // Level6 supports zoom 0..6 — asking for 7+ returns HTTP 400 from GIBS.
    { maxZoom: 6, minZoom: 1, opacity: 0.65, attribution: "© NASA GIBS / GPM IMERG" }
  ),
  // Ten million Facebook friendship pairs as a global density wash.
  // NOAA SOS Explorer — the alpha IS the density, so the basemap shows
  // through where there are no connections (ocean, Sahara) and the arcs
  // glow where people are.
  "🤝 Facebook Friendships": L.tileLayer(
    "/data/facebook/tiles/{z}/{x}/{y}.png",
    { maxZoom: 5, minZoom: 0, opacity: 0.6, attribution: "© NOAA SOS Explorer — Facebook Friendships" }
  ),
  "🌌 NASA Earth at Night": L.tileLayer(
    nasaTileUrl("night", "2016-01-01"),
    { maxZoom: 8, minZoom: 1, opacity: 0.8, attribution: "© NASA GIBS / Black Marble" }
  ),
};

// Köppen-Geiger climate classification overlay (public_html/climate-layer.js).
// It lives in the same layers control as the NASA overlays so it is found
// where users expect a thematic layer. The layer instance comes from
// ClimateLayer so the probe/legend share one overlay.
if (window.ClimateLayer && typeof window.ClimateLayer.getTileLayer === "function") {
  const climateLayer = window.ClimateLayer.getTileLayer();
  if (climateLayer) WEATHER_OVERLAYS["🌍 Köppen Climate"] = climateLayer;
}

// Temperature overlay (public_html/temp-layer.js): a filled colour field
// of the GFS 2 m analysis, painted client-side into a Mercator-warped
// canvas. Like the climate overlay it lives in the layers control so it
// gets the checkbox, the opacity slider and the URL hash machinery.
if (window.TempLayer && typeof window.TempLayer.getTileLayer === "function") {
  const tempLayer = window.TempLayer.getTileLayer();
  if (tempLayer) WEATHER_OVERLAYS["🌡️ Temperature (GFS)"] = tempLayer;
}

// Wind overlay (public_html/wind-layer.js): animated streamlines over the
// GFS 10 m field. Registered as a layers-control overlay like the others,
// so it gets the checkbox, the opacity slider and the URL hash machinery;
// the drawing itself happens on one full-map canvas in windPane, because
// a wind field has no tiles worth the GridLayer machinery.
if (window.WindLayer && typeof window.WindLayer.getTileLayer === "function") {
  const windLayer = window.WindLayer.getTileLayer();
  if (windLayer) WEATHER_OVERLAYS[window.WindLayer.LAYER_NAME || "💨 Wind (GFS)"] = windLayer;
}

// The wind SPEED field — the scalar companion to the animation, and the
// ground it is drawn on. It reads the same u/v grid the animation uses
// (the speed is their magnitude), so the two share one download.
if (window.WindSpeedLayer && typeof window.WindSpeedLayer.getTileLayer === "function") {
  const windSpeed = window.WindSpeedLayer.getTileLayer();
  if (windSpeed) {
    WEATHER_OVERLAYS[window.WindSpeedLayer.LAYER_NAME || "🌬️ Wind speed (GFS)"] = windSpeed;
  }
}

// The scalar-field overlays — convective instability (CAPE) and moisture
// transport (IVT) — share one factory (public_html/field-layer.js), so
// they share one registration shape.
for (const name of window.XYZO_GENERIC_LAYERS) {
  const mod = window[name];
  if (!mod || typeof mod.getTileLayer !== "function") continue;
  const layer = mod.getTileLayer();
  if (layer) WEATHER_OVERLAYS[mod.LAYER_NAME || name] = layer;
}

// Lightning density overlay (public_html/lightning-layer.js): the WWLLN
// 5 arc-minute global lightning climatology as a colour wash, with a
// period switcher in the legend (annual mean + the twelve monthly
// means, which is where the interesting seasonality lives). One
// layers-control entry.
if (window.LightningLayer && typeof window.LightningLayer.getTileLayer === "function") {
  const lightningLayer = window.LightningLayer.getTileLayer();
  if (lightningLayer) WEATHER_OVERLAYS[window.LightningLayer.LAYER_NAME || "⚡ Lightning density (WWLLN)"] = lightningLayer;
}

// Phytoplankton overlay (public_html/phytoplankton-layer.js): the MIT
// Darwin Project's global ocean ecosystem model — which phytoplankton
// dominates each patch of ocean, and how much of it. One layers-control
// entry, with a period switcher in the legend.
if (window.PhytoplanktonLayer && typeof window.PhytoplanktonLayer.getTileLayer === "function") {
  const phytoLayer = window.PhytoplanktonLayer.getTileLayer();
  if (phytoLayer) WEATHER_OVERLAYS[window.PhytoplanktonLayer.LAYER_NAME || "🦠 Phytoplankton (Darwin)"] = phytoLayer;
}

// Indigenous-languages overlay (public_html/indigenous-layer.js):
// Native Land Digital's 1,473 language polygons, each carrying the
// source's own colour, with an optional Names toggle in the legend
// (off by default — 1,473 labels at once is a hairball). One
// layers-control entry, so it gets the checkbox, opacity slider and
// URL-hash machinery for free.
// World languages overlay (public_html/languages-layer.js): Glottolog's
// 8,889 language points, as POINTS so co-spoken languages are all
// visible and the probe can list them. Replaced the polygon-based
// Indigenous Languages overlay, which could only ever show one language
// per area.
if (window.LanguagesLayer && typeof window.LanguagesLayer.getTileLayer === "function") {
  const langLayer = window.LanguagesLayer.getTileLayer();
  if (langLayer) WEATHER_OVERLAYS[window.LanguagesLayer.LAYER_NAME || "🌍 Languages"] = langLayer;
}

// Soil overlay (public_html/soil-layer.js): SoilGrids 2.0 topsoil
// properties as a classified wash, with a property switcher in the
// legend. One layers-control entry — eight checkboxes would drown the
// dropdown.
if (window.SoilLayer && typeof window.SoilLayer.getTileLayer === "function") {
  const soilLayer = window.SoilLayer.getTileLayer();
  if (soilLayer) WEATHER_OVERLAYS[window.SoilLayer.LAYER_NAME || "🟫 Soil"] = soilLayer;
}

// Cropland + land-cover overlays (public_html/cropland-layer.js): two
// layers-control entries sharing one module and one probe grid.
if (window.CroplandLayer && typeof window.CroplandLayer.getTileLayer === "function") {
  const cropLayer = window.CroplandLayer.getTileLayer();
  if (cropLayer) WEATHER_OVERLAYS[window.CroplandLayer.LAYER_NAME || "🌾 Cropland (ESA)"] = cropLayer;
}
if (window.CroplandLayer && typeof window.CroplandLayer.getLandCoverLayer === "function") {
  const coverLayer = window.CroplandLayer.getLandCoverLayer();
  if (coverLayer) WEATHER_OVERLAYS[window.CroplandLayer.LANDCOVER_LAYER_NAME || "🗺️ Land Cover (ESA)"] = coverLayer;
}

// Rivers overlay (public_html/river-layer.js): Natural Earth lake
// centerlines as a GeoJSON wash, rank-filtered by zoom.
if (window.RiverLayer && typeof window.RiverLayer.getTileLayer === "function") {
  const riverLayer = window.RiverLayer.getTileLayer();
  if (riverLayer) WEATHER_OVERLAYS[window.RiverLayer.LAYER_NAME || "💧 Rivers"] = riverLayer;
}

// The 2026 FAO / HydroRIVERS network (public_html/fao-rivers-layer.js):
// the real global river network, served by the publisher's own WMS, with
// a detail level and a river-names switch in its legend. A DIFFERENT
// dataset from the Natural Earth rivers above, and a different entry in
// the dropdown — the reader picks which one they want.
if (window.FaoRiversLayer && typeof window.FaoRiversLayer.getTileLayer === "function") {
  const faoRiverLayer = window.FaoRiversLayer.getTileLayer();
  if (faoRiverLayer) WEATHER_OVERLAYS[window.FaoRiversLayer.LAYER_NAME || "🌊 Rivers (FAO 2026)"] = faoRiverLayer;
}

// Magnetic-field overlay (public_html/mag-layer.js): WMM2025 isogonic
// and isoclinic lines, with an optional colour wash and a point probe.
// A static model (changes over years, not hours), so it is registered
// like the other overlays but needs no refresh cycle.
if (window.MagLayer && typeof window.MagLayer.getTileLayer === "function") {
  const magLayer = window.MagLayer.getTileLayer();
  if (magLayer) WEATHER_OVERLAYS[window.MagLayer.LAYER_NAME || "🧭 Magnetic Field (WMM)"] = magLayer;
}

// Human Transportation overlay (public_html/transport-layer.js): NOAA's
// "Anthropocene" composite — night lights + flights (red), shipping
// (blue), roads (green) — drawn from a frozen equirectangular PNG by a
// custom GridLayer so it wraps the antimeridian. Static asset, no cycle.
if (window.TransportLayer && typeof window.TransportLayer.getTileLayer === "function") {
  const transportLayer = window.TransportLayer.getTileLayer();
  if (transportLayer) {
    WEATHER_OVERLAYS[window.TransportLayer.LAYER_NAME || "🛰️ Human Transportation"] = transportLayer;
  }
}

// Sea Surface Salinity overlay (public_html/salinity-layer.js): NOAA
// GFDL CM2.6 surface salinity (PSU) from one frozen NOAA SOS frame,
// drawn by the same wrapping GridLayer pattern as transportation.
if (window.SalinityLayer && typeof window.SalinityLayer.getTileLayer === "function") {
  const salinityLayer = window.SalinityLayer.getTileLayer();
  if (salinityLayer) {
    WEATHER_OVERLAYS[window.SalinityLayer.LAYER_NAME || "🧂 Sea surface salinity"] = salinityLayer;
  }
}

// Ocean Currents + Temperature overlay (public_html/ocean-layer.js):
// NOAA SOS "Perpetual Ocean" — NASA ECCO-2 sea-surface currents coloured
// by water temperature, from one frozen SOS frame with land masked out.
// Same wrapping-GridLayer pattern as transportation/salinity.
if (window.OceanLayer && typeof window.OceanLayer.getTileLayer === "function") {
  const oceanLayer = window.OceanLayer.getTileLayer();
  if (oceanLayer) {
    WEATHER_OVERLAYS[window.OceanLayer.LAYER_NAME || "🌊 Ocean Currents (ECCO)"] = oceanLayer;
  }
}

// Hydrological basins overlay (public_html/basin-layer.js): the FAO
// "major hydrological basins of the world" drainage regions.
if (window.BasinLayer && typeof window.BasinLayer.getTileLayer === "function") {
  const basinLayer = window.BasinLayer.getTileLayer();
  if (basinLayer) WEATHER_OVERLAYS[window.BasinLayer.LAYER_NAME || "🌊 Hydrological Basins"] = basinLayer;
}

// Geology overlays (public_html/geology-layer.js): Macrostrat bedrock
// + USGS/GSC contact lines. Two entries, one module, one pane.
if (window.GeologyLayer && typeof window.GeologyLayer.getTileLayer === "function") {
  const geoLayer = window.GeologyLayer.getTileLayer();
  if (geoLayer) WEATHER_OVERLAYS[window.GeologyLayer.LAYER_NAME || "🪨 Geology (Macrostrat)"] = geoLayer;
}
if (window.GeologyLayer && typeof window.GeologyLayer.getContactLayer === "function") {
  const contactLayer = window.GeologyLayer.getContactLayer();
  if (contactLayer) WEATHER_OVERLAYS[window.GeologyLayer.CONTACTS_LAYER_NAME || "🗺️ Geologic contacts (USGS)"] = contactLayer;
}

// Relief overlay (public_html/etopo-layer.js): ETOPO 2022 bathymetry +
// topography, baked hypsometric tiles + hillshade.
if (window.EtopoLayer && typeof window.EtopoLayer.getTileLayer === "function") {
  const etopoLayer = window.EtopoLayer.getTileLayer();
  if (etopoLayer) WEATHER_OVERLAYS[window.EtopoLayer.LAYER_NAME || "⛰️ Relief (ETOPO)"] = etopoLayer;
}

// Wave height & power overlay (public_html/wave-layer.js): Open-Meteo
// marine grids, painted per tile; power derived client-side.
if (window.WaveLayer && typeof window.WaveLayer.getTileLayer === "function") {
  const waveLayer = window.WaveLayer.getTileLayer();
  if (waveLayer) WEATHER_OVERLAYS[window.WaveLayer.LAYER_NAME || "🌊 Wave height & power"] = waveLayer;
}

// CAPE / IVT (public_html/cape-layer.js, ivt-layer.js) — both built on
// the shared field-layer.js factory. These two were shipped as modules
// with published data and ENABLED systemd timers (xyzo-cape.timer,
// xyzo-ivt.timer rebuild public_html/data/{cape,ivt}/ every cycle) but
// were never registered here, so no one could ever switch them on: the
// worker published into the void. Registration is defensive, exactly
// like its siblings — a missing module must not abort boot.
if (window.CapeLayer && typeof window.CapeLayer.getTileLayer === "function") {
  const capeLayer = window.CapeLayer.getTileLayer();
  if (capeLayer) WEATHER_OVERLAYS[window.CapeLayer.LAYER_NAME || "⛈️ Convective instability (CAPE)"] = capeLayer;
}
if (window.IvtLayer && typeof window.IvtLayer.getTileLayer === "function") {
  const ivtLayer = window.IvtLayer.getTileLayer();
  if (ivtLayer) WEATHER_OVERLAYS[window.IvtLayer.LAYER_NAME || "🌊 Moisture transport (IVT)"] = ivtLayer;
}

// City-name labels (public_html/city-labels.js): population-filtered
// labels drawn on a dedicated canvas, reusing CityEngine's index.
if (window.CityLabels && typeof window.CityLabels.getTileLayer === "function") {
  const cityLabelsLayer = window.CityLabels.getTileLayer();
  if (cityLabelsLayer) WEATHER_OVERLAYS[window.CityLabels.LAYER_NAME || "🏙️ City names"] = cityLabelsLayer;
}

// Live ocean currents (public_html/ocean-current-layer.js): the OSCAR
// surface-current u/v pair, animated. The static ECCO picture stays as
// its own entry; this one shows the FLOW.
if (window.OceanCurrentLayer && typeof window.OceanCurrentLayer.getTileLayer === "function") {
  const ocLayer = window.OceanCurrentLayer.getTileLayer();
  if (ocLayer) WEATHER_OVERLAYS[window.OceanCurrentLayer.LAYER_NAME || "🌊 Ocean currents (OSCAR)"] = ocLayer;
}

// Earthquakes (public_html/earthquake-layer.js): the USGS ComCat
// summary feeds, saved on OUR disk by scripts/earthquake_build.py so
// the browser never polls USGS. Four windows (1 h / 24 h / 7 d / 30 d),
// a circle that grows with the magnitude, a colour that cools with the
// age, and a popup with the details and a link to the USGS event page.
if (window.EarthquakeLayer && typeof window.EarthquakeLayer.getTileLayer === "function") {
  const quakeLayer = window.EarthquakeLayer.getTileLayer();
  if (quakeLayer) WEATHER_OVERLAYS[window.EarthquakeLayer.LAYER_NAME || "🌐 Earthquakes (USGS)"] = quakeLayer;
}

// Tectonic faults (public_html/fault-layer.js): the USGS Quaternary
// Fault and Fold Database's traces plus the global plate boundaries,
// as lines.
if (window.FaultLayer && typeof window.FaultLayer.getTileLayer === "function") {
  const faultLayer = window.FaultLayer.getTileLayer();
  if (faultLayer) WEATHER_OVERLAYS[window.FaultLayer.LAYER_NAME || "🪨 Tectonic faults (USGS)"] = faultLayer;
}

// Language REGIONS (public_html/languages-regions-layer.js): the same
// Glottolog languages as the points layer, but drawn as the countries
// and territories they are spoken in — a region map rather than a dot
// map.
if (window.LanguagesRegionsLayer && typeof window.LanguagesRegionsLayer.getTileLayer === "function") {
  const langRegionsLayer = window.LanguagesRegionsLayer.getTileLayer();
  if (langRegionsLayer) {
    WEATHER_OVERLAYS[window.LanguagesRegionsLayer.LAYER_NAME || "🌍 Language regions"] = langRegionsLayer;
  }
}

// ── Offline / API-down fallback ──────────────────────────────────────
// Checks /api/health on load and periodically. If the API is unreachable,
// shows a persistent banner so users know the map tiles work but live
// data is unavailable. Retries every 15s until the API recovers.
const ApiHealth = {
  _el: null,
  _timer: null,
  _down: false,
  _retryMs: 15000,
  _consecutiveFailures: 0,
  _initialDelayMs: 5000,

  // ── the DISMISS button ─────────────────────────────────────────────
  //
  // Owner ask 2026-11-10: *"can we correct it so we can also close it
  // with an X when this message pops up?"* The banner is a NOTICE, not
  // a blocker: the map and every downloaded overlay still work, and
  // nothing on the page depends on the banner being there.
  //
  // THE DISMISSAL MUST ALSO STOP IT COMING BACK. The health check runs
  // every 15 s, so a dismissed banner that reappeared a moment later
  // would be worse than no button at all. The dismissal is remembered
  // for the SESSION, and it is FORGOTTEN when the situation RESOLVES —
  // the API answers again — so a genuinely NEW outage warns the reader
  // again.
  //
  // Its OWN key, not the tile notice's: closing "live data is
  // unavailable" must not also close "the imagery isn't loading".
  _DISMISS_KEY: "xyzo.apiDownDismissed",

  _isDismissed() {
    try { return sessionStorage.getItem(this._DISMISS_KEY) === "1"; }
    catch (_) { return false; }
  },

  _rememberDismissed(v) {
    try {
      if (v) sessionStorage.setItem(this._DISMISS_KEY, "1");
      else sessionStorage.removeItem(this._DISMISS_KEY);
    } catch (_) {}
  },

  _createBanner() {
    const el = document.createElement("div");
    el.id = "api-down-banner";
    el.setAttribute("role", "alert");
    el.setAttribute("aria-live", "assertive");
    el.style.cssText = `
      position:fixed;top:0;left:0;right:0;z-index:10000;
      background:linear-gradient(90deg, #1e1b4b, #0f172a);
      color:#f8fafc;padding:10px 18px;
      font:13px/1.4 system-ui,-apple-system,sans-serif;
      text-align:center;display:flex;align-items:center;
      justify-content:center;gap:12px;box-shadow:0 4px 12px rgba(0,0,0,.4);
      border-bottom:1px solid rgba(94,234,212,0.3);
    `;
    el.innerHTML = `
      <span>⚡ <strong>Live data is unavailable</strong> — the map and any overlays you have downloaded still work. Pins and search reconnect automatically.</span>
      <button id="api-down-retry" style="
        background:rgba(94,234,212,0.15);color:#5eead4;border:1px solid rgba(94,234,212,0.4);border-radius:4px;
        padding:4px 12px;cursor:pointer;font:12px/1 system-ui,sans-serif;
        font-weight:600;white-space:nowrap;transition:all 0.2s;
      ">Retry connection</button>
      <button type="button" class="xyzo-notice-dismiss" id="api-down-dismiss"
        aria-label="Dismiss this notice" title="Dismiss">✕</button>
    `;
    document.body.prepend(el);
    document.getElementById("api-down-retry")?.addEventListener("click", () => this.check(true));
    document.getElementById("api-down-dismiss")?.addEventListener("click", () => {
      this._down = true;                 // the retry loop must not re-create it
      this._rememberDismissed(true);
      el.remove();
      if (this._el === el) this._el = null;
      // NOTE: the dismissal is NOT cleared here — it is cleared where
      // the situation RESOLVES (the API answers again), so a new
      // outage warns the reader.
    });
    return el;
  },

  async check(force) {
    try {
      const res = await fetch("/api/health", { signal: AbortSignal.timeout(12000) });
      if (res.ok) {
        this._consecutiveFailures = 0;
        if (this._down) {
          this._down = false;
          this._el?.remove();
          this._el = null;
          // THE SITUATION RESOLVED — so the dismissal is forgotten, and
          // a later, genuinely new outage warns the reader again.
          this._rememberDismissed(false);
          if (typeof fetchPinsForViewport === "function") fetchPinsForViewport();
        }
        return;
      }
    } catch (_) {}

    this._consecutiveFailures++;
    if (force || this._consecutiveFailures >= 3) {
      // A reader who closed the notice is not to be nagged by it.
      if (!this._down && !this._isDismissed()) {
        this._down = true;
        this._el = this._createBanner();
      }
    }
  },

  start() {
    this._timer = setInterval(() => this.check(), this._retryMs);
    setTimeout(() => this.check(), this._initialDelayMs);
  },
};
ApiHealth.start();

const SOURCE_COLORS = {
  editorial: "#f59e0b",
  community: "#22d3ee",
  rss: "#38bdf8",
};

// Lucide icons (ISC license, https://lucide.dev) — inlined to avoid extra
// network requests and keep stroke color tinting via currentColor.
const SOURCE_ICONS = {
  editorial: `<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/>`,
  community: `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
  rss:       `<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>`,
};

// Event-type icons (Lucide, ISC). ~36 distinct story-type icons.
// Vocabulary matches CATEGORIES + EVENT_TYPES in api/src/validate.ts.
const EVENT_ICONS = {
  politics:    `<path d="M2 22V8a2 2 0 0 1 2-2h7l-2 5h6l-2-5h7a2 2 0 0 1 2 2v14"/><path d="M2 14h20"/><path d="M6 14v8"/><path d="M10 14v8"/><path d="M14 14v8"/><path d="M18 14v8"/>`,
  business:    `<path d="M3 21h18"/><path d="M5 21V7l8-4 8 4v14"/><path d="M9 9h.01"/><path d="M9 13h.01"/><path d="M9 17h.01"/><path d="M15 9h.01"/><path d="M15 13h.01"/><path d="M15 17h.01"/>`,
  crime:       `<path d="M12 2 4 6v6c0 5 3.5 9.5 8 10 4.5-.5 8-5 8-10V6l-8-4Z"/>`,
  conflict:    `<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/><path d="M8 8 4 4"/>`,
  weather:     `<path d="M17.5 19a4.5 4.5 0 1 0-2.5-8.1A6 6 0 0 0 4 14.5 4.5 4.5 0 0 0 8.5 19h9Z"/><path d="M9 22h6"/><path d="M12 19v3"/>`,
  science:     `<path d="M10 2v7.31"/><path d="M14 9.3V2"/><path d="M8.5 2h7"/><path d="M14 9.3a6.5 6.5 0 1 1-4 0"/>`,
  technology:  `<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 10h8"/><path d="M8 14h8"/><path d="M8 18h4"/>`,
  sports:      `<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10Z"/>`,
  culture:     `<path d="M3 3h18"/><path d="M9 3v18"/><path d="M15 3v18"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M3 21h18"/>`,
  environment: `<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19.2 2.96c.6 7.61-1.7 12.66-7.4 16.04"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/>`,
  disaster:    `<path d="M8.5 14.5 2 22"/><path d="m21.5 8.5-6.5 6.5"/><path d="m22 22-5-5"/><path d="M13 13 2 2"/><path d="M2 13h6v6"/><path d="M22 11V2h-9"/>`,
  humanitarian:`<circle cx="12" cy="12" r="10"/><path d="M12 6v6"/><path d="M12 16h.01"/>`,
  health:      `<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/>`,
  other:       `<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>`,
  // Sub-type icons. Inherit their color from the parent bucket if a key
  // is missing in EVENT_COLORS (see iconFor()).
  elections:   `<rect x="2" y="6" width="20" height="12" rx="2"/><path d="m6 12 4-3"/><path d="m10 12 4 3"/><path d="m14 12 4-3"/>`,
  courts:      `<path d="M12 3v18"/><path d="M5 8h14"/><path d="M5 8a7 7 0 0 0 14 0"/><path d="M3 21h18"/>`,
  policy:      `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/>`,
  diplomacy:   `<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10"/><path d="M12 2a15 15 0 0 0-4 10 15 15 0 0 0 4 10"/>`,
  protest:     `<path d="M3 3l4 4"/><path d="M21 3l-4 4"/><path d="M3 21l4-4"/><path d="M21 21l-4-4"/><path d="M9 9h6v6H9z"/>`,
  // Business sub-types
  markets:     `<path d="M3 3v18h18"/><path d="m7 17 4-4 4 4 6-6"/>`,
  banking:     `<path d="M3 21h18"/><path d="M3 10h18"/><path d="M5 6 2 3"/><path d="M19 6l3-3"/><path d="M5 6h14"/><path d="M5 6v14"/><path d="M19 6v14"/><path d="M9 10v8"/><path d="M15 10v8"/>`,
  crypto:      `<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2v20"/><path d="m4.93 4.93 14.14 14.14"/><path d="m19.07 4.93-14.14 14.14"/>`,
  realestate:  `<path d="M3 9.5 12 3l9 6.5V21H3z"/><path d="M9 21V12h6v9"/>`,
  labor:       `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
  // Crime / safety sub-types
  shooting:    `<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>`,
  terrorism:   `<path d="M12 2v6"/><path d="M8 6l8 4-8 4"/><path d="M4 14h16"/><path d="M5 22h14"/>`,
  cybercrime:  `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>`,
  missing:     `<circle cx="12" cy="10" r="3"/><path d="M12 2a8 8 0 0 0-8 8c0 5 8 12 8 12s8-7 8-12a8 8 0 0 0-8-8z"/><path d="M9 10h6"/>`,
  traffic:     `<circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M5 17H3v-6l2-5h9l4 5h2v6h-2"/><path d="M9 17h6"/><path d="M11 6h2"/>`,
  // Weather sub-types
  storm:       `<path d="M17.5 19a4.5 4.5 0 1 0-2.5-8.1A6 6 0 0 0 4 14.5 4.5 4.5 0 0 0 8.5 19h9Z"/><path d="m2 9 4-4"/><path d="m22 9-4-4"/><path d="M12 2v3"/><path d="m9 5 3 3"/><path d="m15 5-3 3"/>`,
  floods:      `<path d="M12 3c2 5 6 8 6 13a6 6 0 0 1-12 0c0-5 4-8 6-13z"/><path d="M5 14h14"/><path d="M7 18h10"/>`,
  wildfire:    `<path d="M8.5 14.5 2 22"/><path d="m21.5 8.5-6.5 6.5"/><path d="M12 12c2-4 6-4 6-8a3 3 0 0 0-6 0c0 4-6 6-6 10"/><path d="M12 22a4 4 0 0 0 4-4c0-2-2-3-4-6-2 3-4 4-4 6a4 4 0 0 0 4 4z"/>`,
  drought:     `<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/><path d="M5 19l3-2"/><path d="M16 18l3 1"/>`,
  snow:        `<path d="M2 12h20"/><path d="M12 2v20"/><path d="m4.93 4.93 14.14 14.14"/><path d="m19.07 4.93-14.14 14.14"/><circle cx="12" cy="12" r="2"/>`,
  heatwave:    `<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4 4 0 1 0 5 0z"/><path d="M5 12H2"/><path d="M22 12h-3"/><path d="m6.34 7.34-2.12-2.12"/><path d="m19.78 17.66-2.12-2.12"/>`,
  // Science sub-types
  space:       `<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.93 19.07 1.41-1.41"/><path d="m17.66 6.34 1.41-1.41"/>`,
  biology:     `<path d="M12 2v10"/><path d="M12 12c-3 0-5 2-5 5s2 5 5 5 5-2 5-5-2-5-5-5z"/><path d="M9 7c0-2 1.5-3 3-3"/><path d="M15 7c0-2-1.5-3-3-3"/>`,
  physics:     `<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M3 12h18"/><path d="M5.6 5.6 18.4 18.4"/><path d="M18.4 5.6 5.6 18.4"/>`,
  research:    `<path d="M9 2v6L4 18a2 2 0 0 0 1.7 3h12.6A2 2 0 0 0 20 18L15 8V2"/><path d="M9 2h6"/><path d="M7 14h10"/>`,
  // Technology sub-types
  ai:          `<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/>`,
  cybersecurity:`<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><path d="M12 16v-2"/>`,
  gaming:      `<rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4"/><path d="M8 10v4"/><circle cx="15" cy="11" r="1"/><circle cx="18" cy="14" r="1"/>`,
  telecom:     `<path d="M5 12.55a11 11 0 0 1 14 0"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M8.5 16.43a6 6 0 0 1 7 0"/><circle cx="12" cy="20" r="1"/>`,
  // Sports sub-types
  soccer:      `<circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 14.14 14.14"/><path d="M12 2 8 8l4 4 4-4-4-6z"/><path d="M2 12l6-4 4 4-4 4-6-4z"/><path d="M22 12l-6-4-4 4 4 4 6-4z"/><path d="M12 22l4-6-4-4-4 4 4 6z"/>`,
  basketball:  `<circle cx="12" cy="12" r="10"/><path d="M4.93 4.93 19.07 19.07"/><path d="M14 4.93 4.93 19.07"/><path d="M2 12h20"/><path d="M12 2v20"/>`,
  olympics:    `<circle cx="6" cy="6" r="2.5"/><circle cx="12" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="12" cy="12" r="2.5"/><circle cx="18" cy="12" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="12" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/>`,
  racing:      `<path d="M5 17h14"/><path d="M3 17v-5l3-3h12l3 3v5"/><path d="M5 12V8h14v4"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>`,
  // Culture sub-types
  music:       `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`,
  film:        `<rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20"/><path d="M17 2v20"/><path d="M2 12h20"/><path d="M2 7h5"/><path d="M2 17h5"/><path d="M17 7h5"/><path d="M17 17h5"/>`,
  art:         `<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125 0-.94.746-1.687 1.687-1.687h1.875c3.45 0 6.25-2.8 6.25-6.25C22.5 5.5 18 2 12 2z"/>`,
  books:       `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>`,
  // Environment sub-types
  climate:     `<circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 0 0 20 5 5 0 0 0 0-10 5 5 0 0 1 0-10z"/>`,
  wildlife:    `<path d="M12 3c-3 0-6 2-6 5 0 2 1 3 2 4l-1 4 4-2 1 4 1-4 4 2-1-4c1-1 2-2 2-4 0-3-3-5-6-5z"/><circle cx="10" cy="8" r="1"/><circle cx="14" cy="8" r="1"/>`,
  pollution:   `<path d="M3 8h18"/><path d="M5 8v8a4 4 0 0 0 8 0V8"/><path d="M13 8v6"/><path d="M17 8v4"/><path d="M9 16v6"/>`,
  energy:      `<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>`,
  // Health sub-types
  outbreak:    `<path d="M12 2v6"/><path d="M12 16v6"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="M2 12h6"/><path d="M16 12h6"/><path d="m4.93 19.07 4.24-4.24"/><path d="m14.83 9.17 4.24-4.24"/>`,
  medical:     `<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/>`,
  mental_health:`<path d="M9 12h.01"/><path d="M15 12h.01"/><path d="M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5"/><path d="M19 6.3a9 9 0 0 1 1.8 3.9 2 2 0 0 1 0 3.6 9 9 0 0 1-17.6 0 2 2 0 0 1 0-3.6A9 9 0 0 1 12 3c2 0 3.5.5 4.5 1.2"/>`,
  // Conflict / disaster (kept for the news_events event_type path).
  war:         `<path d="M2 22V8a2 2 0 0 1 2-2h7l-2 5h6l-2-5h7a2 2 0 0 1 2 2v14"/><path d="m2 22 20-20"/>`,
  military:    `<path d="M12 2 4 6v6c0 5 3.5 9.5 8 10 4.5-.5 8-5 8-10V6l-8-4Z"/><path d="M12 8v4"/><path d="M12 16h.01"/>`,
  earthquake:  `<path d="M2 12h3l3-9 4 18 3-9h7"/>`,
  volcano:     `<path d="M12 2v6"/><path d="m9 8 3-3 3 3"/><path d="M5 22h14"/><path d="M7 22c0-5 2-9 5-9s5 4 5 9"/>`,
  refugees:    `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
  aid:         `<path d="M12 8v8"/><path d="M8 12h8"/><circle cx="12" cy="12" r="10"/>`,

  // Local & Global Interest sub-types
  education:   `<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c0 2 3 3 6 3s6-1 6-3v-5"/>`,
  food:        `<path d="M18 2v20M18 8h-4V2M14 12v10M3 2v7c0 1.1.9 2 2 2h2c1.1 0 2-.9 2-2V2M7 2v20"/>`,
  transit:     `<rect x="4" y="3" width="16" height="16" rx="2"/><path d="M4 11h16M8 15h.01M16 15h.01M9 19l-2 2M15 19l2 2"/>`,
  festivals:   `<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>`,
  religion:    `<path d="M12 2v6M9 5h6M4 22V10l8-4 8 4v12z"/><path d="M12 14v8"/>`,
  housing:     `<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>`,
  automotive:  `<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.5 3c-.1.3-.1.6-.1.9v3c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>`,
  trade:       `<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z"/>`,
  // Entertainment & Culture sub-types
  entertainment: `<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>`,
  concert: `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`,
  // Human-interest / Love & Fun sub-types
  human: `<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/>`,

  // Food & Agriculture sub-types
  agriculture: `<path d="M12 22c4-4 8-7.5 8-12a8 8 0 0 0-16 0c0 4.5 4 8 8 12z"/><path d="M12 10v4"/><path d="M9 12l3 3 3-3"/>`,
  restaurant:  `<circle cx="12" cy="12" r="10"/><path d="M8 8v8"/><path d="M16 8v8"/><path d="M8 12h8"/>`,
  recipe:      `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/>`,
  wine:        `<path d="M8 2h8l-1 10a4 4 0 0 1-6 0L8 2z"/><path d="M12 12v4"/><path d="M8 20h8"/>`,
  farming:     `<path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 9h.01"/><path d="M9 13h.01"/><path d="M15 9h.01"/><path d="M15 13h.01"/>`,
  
  // Entertainment & Culture sub-types
  theater:     `<path d="M2 12h20"/><path d="M12 2v20"/><path d="M2 2l20 20"/><path d="M22 2L2 22"/>`,
  streaming:   `<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>`,
  podcast:     `<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>`,
  
  // Human-interest / Love & Fun sub-types
  love:        `<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/>`,
  family:      `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
  humor:       `<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>`,
  celebration: `<path d="M5.8 11.3 2 22l10.7-3.79"/><path d="M4 3h.01"/><path d="M22 8h.01"/><path d="M15 2h.01"/><path d="M22 20h.01"/><path d="m22 2-2.3 2.3"/><path d="m11 2-2.3 2.3"/><path d="M3 11l2.3-2.3"/><path d="m11 22 2.3-2.3"/>`,
  adventure:   `<circle cx="12" cy="12" r="10"/><path d="M12 2v10"/><path d="M12 22l4-8-4-8"/>`,
  community:   `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
  pets:        `<path d="M10 5.172C10 3.782 8.423 2.679 6.5 3c-2.823.47-4.113 6.006-4 7 .08.703 1.725 1.722 3.656 1 1.261-.472 1.96-1.45 2.344-2.5"/><path d="M14.267 5.172c0-1.39 1.577-2.493 3.5-2.172 2.823.47 4.113 6.006 4 7-.08.703-1.725 1.722-3.656 1-1.261-.472-1.855-1.45-2.239-2.5"/><path d="M8 14v.5"/><path d="M16 14v.5"/><path d="M11.25 16.25h1.5L12 17l-.75-.75Z"/><path d="M4.42 11.247A13.152 13.152 0 0 0 4 14.556C4 18.728 7.582 21 12 21s8-2.272 8-6.444c0-1.061-.162-2.2-.493-3.309m-9.243-6.042A13.152 13.152 0 0 1 4 14.556c0 4.172 3.582 6.444 8 6.444s8-2.272 8-6.444c0-1.061-.162-2.2-.493-3.309"/>`,
  hobbies:     `<circle cx="12" cy="12" r="10"/><path d="M12 2v10"/><path d="M12 22l4-8-4-8"/>`,
  inspiration: `<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>`,
};


// Color by event_type — same palette as the article source badges for visual continuity.
// Sub-types reuse their parent bucket's color unless overridden here. Keeps
// the palette tight while still letting each sub-type pick a unique icon.
const EVENT_COLORS = {
  adventure: "#ec4899",
  agriculture: "#16a34a",
  ai: "#7c3aed",
  aid: "#1e3a8a",
  art: "#6d28d9",
  athletics: "#a7f3d0",
  automotive: "#ca8a04",
  aviation: "#06b6d4",
  banking: "#ca8a04",
  basketball: "#047857",
  biology: "#831843",
  books: "#7c3aed",
  business: "#16a34a",
  celebration: "#ec4899",
  climate: "#0891b2",
  community: "#22d3ee",
  concert: "#8b5cf6",
  conflict: "#b91c1c",
  corruption: "#f59e0b",
  courts: "#ef4444",
  cricket: "#10b981",
  crime: "#dc2626",
  crypto: "#16a34a",
  culture: "#3730a3",
  cybercrime: "#3b0d7a",
  cybersecurity: "#3b0d7a",
  cyclone: "#3b82f6",
  deforestation: "#065f46",
  demographics: "#fb7185",
  development: "#22d3ee",
  diplomacy: "#f97316",
  disaster: "#4f46e5",
  drought: "#d97706",
  earthquake: "#4338ca",
  economy: "#15803d",
  education: "#8b5cf6",
  elections: "#dc2626",
  employment: "#d97706",
  energy: "#155e75",
  entertainment: "#ec4899",
  environment: "#84cc16",
  epidemic: "#0d9488",
  family: "#ec4899",
  farming: "#16a34a",
  festivals: "#312e81",
  film: "#4f46e5",
  finance: "#a16207",
  floods: "#1d4ed8",
  food: "#f97316",
  gaming: "#6d28d9",
  geopolitics: "#d97706",
  government: "#991b1b",
  health: "#99f6e4",
  healthcare: "#5eead4",
  heatwave: "#f59e0b",
  hobbies: "#ec4899",
  housing: "#ca8a04",
  human: "#ec4899",
  human_rights: "#be123c",
  humanitarian: "#881337",
  humor: "#ec4899",
  immigration: "#ea580c",
  inequality: "#e11d48",
  inspiration: "#ec4899",
  labor: "#d97706",
  literature: "#7c3aed",
  love: "#ec4899",
  manufacturing: "#92400e",
  maritime: "#0891b2",
  markets: "#eab308",
  medical: "#2dd4bf",
  medicine: "#9d174d",
  mental_health: "#14b8a6",
  military: "#b91c1c",
  missing: "#dc2626",
  motorsport: "#065f46",
  music: "#8b5cf6",
  olympics: "#34d399",
  other: "#64748b",
  outbreak: "#0d9488",
  pets: "#047857",
  physics: "#ec4899",
  podcast: "#7c3aed",
  policy: "#b45309",
  politics: "#7f1d1d",
  pollution: "#0e7490",
  poverty: "#9f1239",
  protest: "#fb923c",
  racing: "#22c55e",
  rail: "#0e7490",
  realestate: "#ca8a04",
  recipe: "#f97316",
  refugees: "#f43f5e",
  religion: "#4338ca",
  research: "#db2777",
  restaurant: "#f97316",
  retail: "#713f12",
  sanctions: "#ca8a04",
  science: "#ec4899",
  shipping: "#5c3d0e",
  shooting: "#dc2626",
  snow: "#60a5fa",
  soccer: "#059669",
  social_issues: "#fda4af",
  software: "#4c1d95",
  space: "#be185d",
  sports: "#86efac",
  startups: "#854d0e",
  storm: "#2563eb",
  streaming: "#8b5cf6",
  swimming: "#6ee7b7",
  technology: "#8b5cf6",
  telecom: "#5b21b6",
  tennis: "#4ade80",
  terrorism: "#b91c1c",
  theater: "#5b21b6",
  trade: "#b45309",
  traffic: "#ea580c",
  transit: "#06b6d4",
  vaccines: "#0f766e",
  volcano: "#3730a3",
  war: "#b91c1c",
  water: "#059669",
  weather: "#60a5fa",
  weather_alert: "#f59e0b",
  wildfire: "#1e40af",
  wildlife: "#047857",
  wine: "#7c3aed",
};




const CAT_LABELS = {
  politics: "Politics 🏛️",
  business: "Business 📈",
  technology: "Tech 💻",
  tech: "Tech 💻",
  ai: "AI 🤖",
  disaster: "Disaster 🌪️",
  weather: "Weather ⛈️",
  sports: "Sports ⚽",
  crime: "Crime 🚨",
  conflict: "Conflict ⚔️",
  military: "Military 🎖️",
  health: "Health 🏥",
  science: "Science 🔬",
  culture: "Culture 🎭",
  film: "Film 🎬",
  environment: "Environment 🌿",
  transit: "Transit 🚇",
  education: "Education 🎓",
  food: "Food 🍽️",
  soccer: "Soccer ⚽",
  elections: "Elections 🗳️",
  war: "War ⚔️",
  trade: "Trade 🌐",
  labor: "Labor 💼",
  courts: "Courts ⚖️",
  protest: "Protest 📢",
  medical: "Medical 🏥",
};

// Map a sub-type back to its main bucket so we can inherit a sensible color
// when EVENT_COLORS lacks the exact key. Anything missing here falls through
// to EVENT_COLORS.other.
const SUBTYPE_TO_BUCKET = {
  // Politics
  elections: "politics", courts: "politics", policy: "politics", diplomacy: "politics", protest: "politics",
  corruption: "politics", geopolitics: "politics", sanctions: "politics", immigration: "politics", government: "politics",
  // Business
  markets: "business", banking: "business", crypto: "business", realestate: "business", labor: "business",
  finance: "business", startups: "business", employment: "business", trade: "business",
  manufacturing: "business", retail: "business", shipping: "business", economy: "business",
  // Technology
  ai: "technology", cybersecurity: "technology", gaming: "technology", telecom: "technology", software: "technology",
  // Crime
  shooting: "crime", terrorism: "crime", cybercrime: "crime", missing: "crime", traffic: "crime",
  // Weather
  storm: "weather", floods: "weather", wildfire: "weather", drought: "weather", snow: "weather", heatwave: "weather",
  weather_alert: "weather", cyclone: "weather",
  // Science
  space: "science", biology: "science", physics: "science", research: "science", medicine: "science",
  // Sports
  soccer: "sports", basketball: "sports", olympics: "sports", racing: "sports",
  cricket: "sports", tennis: "sports", swimming: "sports", athletics: "sports", motorsport: "sports",
  // Culture
  music: "culture", film: "culture", art: "culture", books: "culture",
  literature: "culture", theater: "culture", festivals: "culture", religion: "culture", entertainment: "culture",
  // Environment
  climate: "environment", wildlife: "environment", pollution: "environment", energy: "environment",
  agriculture: "environment", water: "environment", deforestation: "environment",
  // Health
  outbreak: "health", medical: "health", mental_health: "health", epidemic: "health", vaccines: "health", healthcare: "health",
  // Conflict
  war: "conflict", military: "conflict",
  // Disaster
  earthquake: "disaster", volcano: "disaster",
  // Humanitarian
  refugees: "humanitarian", aid: "humanitarian", inequality: "humanitarian", human_rights: "humanitarian",
  poverty: "humanitarian", demographics: "humanitarian", social_issues: "humanitarian",
};

// Match a single category/source filter key against a pin object or Leaflet marker
function matchesSingleCategoryKey(p, filterKey) {
  if (!p || !filterKey) return false;
  const fk = String(filterKey).toLowerCase().trim();
  const pinObj = p._pinData || p;

  // Special filters: top_story and cluster_overflow
  if (fk === "top_story") {
    return Boolean(pinObj.is_top_story || pinObj.top || pinObj.isTopStory);
  }
  if (fk === "cluster_overflow") {
    return Boolean(pinObj.isOverflowBadge || pinObj.isCircleCluster);
  }
  
  const rawCat = String(pinObj.category || pinObj.c || pinObj.event_type || p._xyzoCategory || "").toLowerCase().trim();
  const rawSubtype = String(pinObj.subtype || pinObj.event_subtype || pinObj.event_type || "").toLowerCase().trim();
  const sourceType = String(pinObj.source_type || pinObj.sourceType || pinObj.source_kind || p._xyzoHeatType || "").toLowerCase().trim();

  // 1. Source Types
  if (fk === "rss" || fk === "editorial" || fk === "community") {
    return sourceType === fk || sourceType.includes(fk);
  }
  if (fk === "other") {
    return sourceType === "other" || rawCat === "other" || (!sourceType && (!rawCat || rawCat === "other"));
  }

  // 2. Direct string equality match on category or subtype
  if (rawCat === fk || rawSubtype === fk) return true;

  // 3. Bucket mapping from rawCat or rawSubtype
  const pinBucket = (typeof SUBTYPE_TO_BUCKET !== "undefined" && SUBTYPE_TO_BUCKET)
    ? (SUBTYPE_TO_BUCKET[rawCat] || SUBTYPE_TO_BUCKET[rawSubtype] || rawCat)
    : rawCat;

  if (pinBucket === fk) return true;

  // 4. Parent category (e.g., fk = "environment" or "technology")
  const rollup = (typeof CATEGORY_ROLLUPS !== "undefined" && CATEGORY_ROLLUPS) ? CATEGORY_ROLLUPS[fk] : null;
  if (rollup) {
    if (rollup.includes(rawCat) || rollup.includes(rawSubtype) || rollup.includes(pinBucket)) return true;
    if ((fk === "technology" || fk === "tech") && (rawCat === "tech" || rawCat === "technology")) return true;
  }

  // 5. Sub-type filter key (e.g. fk = "climate", "ai", "elections")
  const fkParent = (typeof SUBTYPE_TO_BUCKET !== "undefined" && SUBTYPE_TO_BUCKET) ? SUBTYPE_TO_BUCKET[fk] : null;
  if (fkParent) {
    if (rawCat === fkParent || pinBucket === fkParent) {
      if (rawCat && rawCat !== fkParent && rawCat !== fk && SUBTYPE_TO_BUCKET[rawCat] === fkParent) {
        return false;
      }
      if (rawSubtype && rawSubtype !== fkParent && rawSubtype !== fk && SUBTYPE_TO_BUCKET[rawSubtype] === fkParent) {
        return false;
      }
      return true;
    }
  }

  // 6. Substring fallback match
  if (rawCat && (rawCat.includes(fk) || fk.includes(rawCat))) return true;
  if (rawSubtype && (rawSubtype.includes(fk) || fk.includes(rawSubtype))) return true;

  return false;
}

function matchesActiveCategoryFilters(p) {
  if (!p) return false;
  if (typeof _activeCategoryFilters === "undefined" || !_activeCategoryFilters || _activeCategoryFilters.size === 0) {
    return true;
  }
  for (const filterKey of _activeCategoryFilters) {
    if (matchesSingleCategoryKey(p, filterKey)) return true;
  }
  return false;
}

// Human-readable labels for the legend. The key MUST match a known
// icon key (a top-level EVENT_ICONS key for story categories, or a SOURCE
// key for news sources) so we can render the same icon SVG used on the map.
const LEGEND_LABELS = {
  // Sources.
  rss:       "RSS / aggregated feed",
  editorial: "Editorial / staff-written",
  community: "Community submission",
  other:     "Uncategorised",

  // Story categories (top-level buckets).
  politics:    "Politics",
  business:    "Business",
  crime:       "Crime & safety",
  conflict:    "Conflict",
  weather:     "Weather",
  science:     "Science",
  technology:  "Technology",
  sports:      "Sports",
  culture:     "Culture",
  environment: "Environment",
  disaster:    "Disaster",
  humanitarian:"Humanitarian",
  health:      "Health",

  // Sub-types shown beneath their parent bucket.
  elections:    "Elections",
  courts:       "Courts",
  policy:       "Policy",
  diplomacy:    "Diplomacy",
  protest:      "Protest",
  markets:      "Markets",
  banking:      "Banking",
  crypto:       "Crypto",
  realestate:   "Real estate",
  labor:        "Labor",
  shooting:     "Shooting",
  terrorism:    "Terrorism",
  cybercrime:   "Cybercrime",
  missing:      "Missing person",
  traffic:      "Traffic",
  storm:        "Storm",
  floods:       "Floods",
  wildfire:     "Wildfire",
  drought:      "Drought",
  snow:         "Snow",
  heatwave:     "Heatwave",
  space:        "Space",
  biology:      "Biology",
  physics:      "Physics",
  research:     "Research",
  ai:           "Artificial intelligence",
  cybersecurity:"Cybersecurity",
  gaming:       "Gaming",
  telecom:      "Telecom",
  soccer:       "Soccer",
  basketball:   "Basketball",
  olympics:     "Olympics",
  racing:       "Racing",
  music:        "Music",
  film:         "Film",
  art:          "Art",
  books:        "Books",
  climate:      "Climate",
  wildlife:     "Wildlife",
  pollution:    "Pollution",
  energy:       "Energy",
  outbreak:     "Outbreak",
  medical:      "Medical",
  mental_health:"Mental health",
  war:          "War",
  military:     "Military",
  earthquake:   "Earthquake",
  volcano:      "Volcano",
  refugees:     "Refugees",
  aid:          "Aid",
  entertainment: "Entertainment",
  concert:       "Concert",
  human:         "Human interest",
};

// Buckets the legend groups sub-types under. Top-level keys are rendered as
// their own rows; nested keys render indented under their parent.
const LEGEND_GROUPS = [
  { header: "News sources" },
  { key: "rss",       isSource: true },
  { key: "editorial", isSource: true },
  { key: "community", isSource: true },
  { key: "other",     isFallback: true },

  { header: "Story categories" },
  { key: "politics" },
  { key: "business" },
  { key: "crime" },
  { key: "conflict" },
  { key: "weather" },
  { key: "science" },
  { key: "technology" },
  { key: "sports" },
  { key: "culture" },
  { key: "environment" },
  { key: "disaster" },
  { key: "humanitarian" },
  { key: "health" },

  { header: "Entertainment & Events" },
  { key: "entertainment" },
  { key: "concert" },

  { header: "Human Interest & Fun" },
  { key: "human" },

  { header: "Politics" },
  { key: "elections", parent: "politics" },
  { key: "courts",    parent: "politics" },
  { key: "policy",    parent: "politics" },
  { key: "diplomacy", parent: "politics" },
  { key: "protest",   parent: "politics" },

  { header: "Business" },
  { key: "markets",    parent: "business" },
  { key: "banking",    parent: "business" },
  { key: "crypto",     parent: "business" },
  { key: "realestate", parent: "business" },
  { key: "labor",      parent: "business" },

  { header: "Crime & safety" },
  { key: "shooting",  parent: "crime" },
  { key: "terrorism", parent: "crime" },
  { key: "cybercrime",parent: "crime" },
  { key: "missing",   parent: "crime" },
  { key: "traffic",   parent: "crime" },

  { header: "Weather" },
  { key: "storm",    parent: "weather" },
  { key: "floods",   parent: "weather" },
  { key: "wildfire", parent: "weather" },
  { key: "drought",  parent: "weather" },
  { key: "snow",     parent: "weather" },
  { key: "heatwave", parent: "weather" },

  { header: "Science" },
  { key: "space",    parent: "science" },
  { key: "biology",  parent: "science" },
  { key: "physics",  parent: "science" },
  { key: "research", parent: "science" },

  { header: "Technology" },
  { key: "ai",             parent: "technology" },
  { key: "cybersecurity",  parent: "technology" },
  { key: "gaming",         parent: "technology" },
  { key: "telecom",        parent: "technology" },

  { header: "Sports" },
  { key: "soccer",     parent: "sports" },
  { key: "basketball", parent: "sports" },
  { key: "olympics",   parent: "sports" },
  { key: "racing",     parent: "sports" },

  { header: "Culture" },
  { key: "music", parent: "culture" },
  { key: "film",  parent: "culture" },
  { key: "art",   parent: "culture" },
  { key: "books", parent: "culture" },

  { header: "Environment" },
  { key: "climate",   parent: "environment" },
  { key: "wildlife",  parent: "environment" },
  { key: "pollution", parent: "environment" },
  { key: "energy",    parent: "environment" },

  { header: "Health" },
  { key: "outbreak",      parent: "health" },
  { key: "medical",       parent: "health" },
  { key: "mental_health", parent: "health" },

  { header: "Conflict & disaster" },
  { key: "war",        parent: "conflict" },
  { key: "military",   parent: "conflict" },
  { key: "earthquake", parent: "disaster" },
  { key: "volcano",    parent: "disaster" },
  { key: "refugees",   parent: "humanitarian" },
  { key: "aid",        parent: "humanitarian" },
];

// Build the dataset the legend renderer needs: same SVG path + colour the
// map markers use, so the swatches in the legend match what users actually
// see on the map.
function legendSwatch(key, isSource, isFallback) {
  const path = EVENT_ICONS[key] || (isSource ? SOURCE_ICONS[key] : null);
  if (!path) return null;
  // Color resolution mirrors iconFor() — try direct key, fall back to
  // bucket, fall back to EVENT_COLORS.other, so source-only keys still get
  // a recognisable colour.
  let color;
  if (isSource) {
    color = SOURCE_COLORS[key];
  } else {
    const bucket = SUBTYPE_TO_BUCKET[key] || key;
    color = EVENT_COLORS[key] || EVENT_COLORS[bucket] || EVENT_COLORS.other;
  }
  return {
    label: LEGEND_LABELS[key] || key,
    color: color || EVENT_COLORS.other,
    path,
    isSource: Boolean(isSource),
    isFallback: Boolean(isFallback),
    key,
  };
}

// Pretty-print the body of the legend. Group headers are section dividers;
// rows are indented one level under their parent group when they're a
// sub-type. Sources and "other" ride at the top level.
function buildLegendRows() {
  const rows = [];
  rows.push({ type: "header", label: "Map Highlights" });
  rows.push({
    type: "special",
    key: "top_story",
    label: "Top Global Story",
    sublabel: "Highlighted in Clusters or Links mode",
    iconHtml: `<span style="display:inline-block;width:15px;height:15px;border-radius:50%;border:2.5px solid #ef4444;box-shadow:0 0 8px rgba(239,68,68,0.85);background:#0f172a;margin-right:8px;vertical-align:middle;"></span>`,
  });
  rows.push({
    type: "special",
    key: "cluster_overflow",
    label: "Dense Story Cluster",
    sublabel: "Click +N to explore all stories in this city",
    iconHtml: `<span style="display:inline-block;width:17px;height:17px;border-radius:50%;border:2px solid #0ea5e9;box-shadow:0 0 8px rgba(14,165,233,0.7);background:#0f172a;color:#fff;font-size:9px;font-weight:700;line-height:17px;text-align:center;margin-right:8px;vertical-align:middle;">+N</span>`,
  });
  for (const item of LEGEND_GROUPS) {
    if (item.header) {
      rows.push({ type: "header", label: item.header });
      continue;
    }
    const swatch = legendSwatch(item.key, item.isSource, item.isFallback);
    if (!swatch) continue;
    rows.push({
      type: "row",
      ...swatch,
      parent: item.parent || null,
      indent: Boolean(item.parent),
    });
  }
  return rows;
}

// THE INITIAL VIEW IS THE LINK'S VIEW, NOT THE WORLD'S.
//
// The map used to be created at the world view (z2) and MOVED to the
// hash's view a moment later — which meant the browser asked for the 16
// world tiles, threw them away, and only then asked for the ones the
// reader actually wanted. Those 16 tiles are not free: they compete
// with app.js and the real tiles for a slow connection's bandwidth, and
// the reader waits for the LAST of them.
//
// Measured 2026-11-12 on a throttled 4G link: the map's own tiles
// started at t=3.69 s (the 16 world ones) and the real ones at t=3.99 s
// — and the map was not usable until they had all landed.
//
// So the hash is parsed BEFORE the map exists, and the view goes in as
// the constructor's own view. Leaflet never paints the world view, and
// never asks for a tile the reader will not see.
const _bootHashView = (typeof parseMapHash === "function")
  ? parseMapHash(window.location.hash)
  : null;
// THE BOOT VIEW IS AN OBJECT, NOT AN ARRAY.
//
// It was an array once, and the call site read `.lat`/`.lng`/`.zoom` off
// it — which is `undefined` on an array. So the map was told
// `setView([undefined, undefined], undefined)` and Leaflet answered
// "Invalid LatLng object: (undefined, undefined)". That exception killed
// the rest of app.js on the way past — including the fix that gives
// the container its height on Firefox — and the map was left with no
// view at all.
//
// MEASURE, DO NOT TRUST THE SHAPE: the source looked right and the
// first version of this test passed against the broken code.
const _bootView = (_bootHashView && _bootHashView.lat != null &&
                   _bootHashView.lng != null && _bootHashView.zoom != null)
  ? { lat: _bootHashView.lat, lng: _bootHashView.lng, zoom: _bootHashView.zoom }
  : null;
const map = L.map("map", {
  worldCopyJump: true,
  closePopupOnClick: false,
  // Double-click is the "add a story" gesture (see the click-to-submit
  // gate below) — it must NOT also zoom the map. Zoom stays on the
  // wheel, the pinch and the +/- buttons.
  doubleClickZoom: false,
});
window._xyzoMap = map;
// THE VIEW IS SET IMMEDIATELY, NOT IN A CONSTRUCTOR OPTION.
//
// Leaflet 1.9.4 has NO `setView`/`center`/`zoom` constructor option
// (grep the vendored file: `options.setView` — zero hits), so an
// option of that name is silently IGNORED and the map is left with NO
// VIEW AT ALL. And a map with no view throws from every accessor:
// `_checkIfLoaded` raises "Set map center and zoom first." — so the
// FIRST pin fetch (which asks the map for its bounds) died, and the
// reader got the "Connection hiccup — showing cached data" banner
// instead of the markers. Measured on Firefox, 2026-11-12.
//
// So the view is set on the line AFTER the constructor, with the
// link's view when there is one. That is the same tick, so there is no
// window in which the map has no view — and the world view is never
// painted, so the browser never asks for the 16 world tiles.
map.setView(_bootView ? [_bootView.lat, _bootView.lng] : [20, 0],
           _bootView ? _bootView.zoom : 2);

// Run `fn` once the map is ready — immediately (on the next tick) if
// it already is, otherwise when it loads.
//
// Leaflet has no `isStyleLoaded()`: the method does not exist in the
// bundled version (grep the vendor file — zero hits). The old guard
// `map && map.isStyleLoaded()` therefore THREW a TypeError, and the
// `catch (e) {}` around it swallowed the error, so the search from a
// shared `?q=` link silently never ran.
//
// And `map.once("load", fn)` is not enough on its own: if the load
// event has already fired, the callback never runs. Leaflet's
// `whenReady()` handles both cases.
function whenMapReady(fn) {
  if (map && typeof map.whenReady === "function") {
    map.whenReady(() => setTimeout(fn, 0));
    return true;
  }
  setTimeout(fn, 100);
  return false;
}

// Pane for the Koppen climate overlay: above the base tiles (tilePane
// 200) but below the pin canvas (overlayPane 400), so the wash never
// hides the news pins.
map.createPane("climatePane");
map.getPane("climatePane").style.zIndex = "350";
map.getPane("climatePane").style.pointerEvents = "none";

// The climate module is loaded before this file (so its overlay could be
// registered in the layers control below); hand it the map now that it
// exists.
if (window.ClimateLayer && typeof window.ClimateLayer.init === "function") {
  try { window.ClimateLayer.init(map); } catch (_) {}
}

// Temperature overlay: hands it the map so it can mount its legend in
// the layers control and paint the field into its pane.
if (window.TempLayer && typeof window.TempLayer.init === "function") {
  try { window.TempLayer.init(map); } catch (_) {}
}

// Wind overlay: it owns windPane (z-index 370 — above the isobars,
// below the pin canvas) and runs the particle animation; the map is
// handed over here.
if (window.WindLayer && typeof window.WindLayer.init === "function") {
  try { window.WindLayer.init(map); } catch (_) {}
}

// The scalar-field overlays (CAPE, IVT): hands them the map so they can
// mount their legend in the layers control and paint into their panes.
for (const name of window.XYZO_GENERIC_LAYERS) {
  const mod = window[name];
  if (mod && typeof mod.init === "function") {
    try { mod.init(map); } catch (_) {}
  }
}

// Lightning density overlay (public_html/lightning-layer.js): the
// WWLLN 5 arc-minute global lightning climatology, painted as a wash
// into lightningPane (356). Registered in the layers control so it
// gets the checkbox, the opacity slider and the URL hash machinery.
if (window.LightningLayer && typeof window.LightningLayer.init === "function") {
  try { window.LightningLayer.init(map); } catch (_) {}
}

// Phytoplankton overlay: hands it the map so it can mount its period
// switcher and legend in the layers control and paint into
// phytoplanktonPane (357).
if (window.PhytoplanktonLayer && typeof window.PhytoplanktonLayer.init === "function") {
  try { window.PhytoplanktonLayer.init(map); } catch (_) {}
}

// Indigenous languages: Native Land Digital GeoJSON in indigenousPane
// (357 — above the lightning wash, below the magnetic lines). The map
// is handed over so it can mount its legend (incl. the Names toggle)
// and restore its state from localStorage.
if (window.LanguagesLayer && typeof window.LanguagesLayer.init === "function") {
  try { window.LanguagesLayer.init(map); } catch (_) {}
}

// Isobar (pressure contour) layer. The module owns its own pane
// (isobarPane, z-index 360 — above the climate wash, below the pin
// canvas) and draws the lines; the map is handed over here.
if (window.IsobarLayer && typeof window.IsobarLayer.init === "function") {
  try { window.IsobarLayer.init(map); } catch (_) {}
}

// Soil overlay: hands it the map so it can mount its property switcher
// and legend in the layers control and paint into soilPane (352).
if (window.SoilLayer && typeof window.SoilLayer.init === "function") {
  try { window.SoilLayer.init(map); } catch (_) {}
}

// Cropland / land-cover overlays: one module, two layers-control
// entries, shared probe grid. Owns croplandPane (353).
if (window.CroplandLayer && typeof window.CroplandLayer.init === "function") {
  try { window.CroplandLayer.init(map); } catch (_) {}
}

// Rivers overlay: Natural Earth GeoJSON in riverPane (365 — above the
// isobars and climate washes, below wind and the pin canvas).
if (window.RiverLayer && typeof window.RiverLayer.init === "function") {
  try { window.RiverLayer.init(map); } catch (_) {}
}

// The 2026 FAO river network: a WMS tile layer in faoRiverPane (371),
// with the detail level and the river-names switch in its legend.
if (window.FaoRiversLayer && typeof window.FaoRiversLayer.init === "function") {
  try { window.FaoRiversLayer.init(map); } catch (_) {}
}

// Geology overlays: Macrostrat bedrock (512px tiles in geologyPane 354)
// + USGS/GSC contact lines. Hands the map over so the module can mount
// its probe and wire overlayadd/remove.
if (window.GeologyLayer && typeof window.GeologyLayer.init === "function") {
  try { window.GeologyLayer.init(map); } catch (_) {}
}

// City-name labels: owns cityLabelPane (380), redraws on moveend/zoomend.
if (window.CityLabels && typeof window.CityLabels.init === "function") {
  try { window.CityLabels.init(map); } catch (_) {}
}

// Relief overlay: owns etopoPane (345, above base tiles, below climate).
if (window.EtopoLayer && typeof window.EtopoLayer.init === "function") {
  try { window.EtopoLayer.init(map); } catch (_) {}
}

// Wave overlay: owns wavePane (346), paints from data/wave/*.bin.
if (window.WaveLayer && typeof window.WaveLayer.init === "function") {
  try { window.WaveLayer.init(map); } catch (_) {}
}

// CAPE / IVT: own capePane (348) and ivtPane (347), painted from
// data/cape/*.bin and data/ivt/*.bin by the shared field-layer factory.
if (window.CapeLayer && typeof window.CapeLayer.init === "function") {
  try { window.CapeLayer.init(map); } catch (_) {}
}
if (window.IvtLayer && typeof window.IvtLayer.init === "function") {
  try { window.IvtLayer.init(map); } catch (_) {}
}

// Magnetic-field overlay: WMM2025 lines + optional wash + probe. Owns
// its pane (magPane, 358 — above climate, below isobars).
if (window.MagLayer && typeof window.MagLayer.init === "function") {
  try { window.MagLayer.init(map); } catch (_) {}
}

// Human Transportation: static equirectangular PNG drawn by a wrapping
// GridLayer. Owns its pane (transportPane, 359 — just under the isobars).
if (window.TransportLayer && typeof window.TransportLayer.init === "function") {
  try { window.TransportLayer.init(map); } catch (_) {}
}

// Sea Surface Salinity: same wrapping-GridLayer pattern; pane
// salinityPane (351 — bottom of the wash stack).
if (window.SalinityLayer && typeof window.SalinityLayer.init === "function") {
  try { window.SalinityLayer.init(map); } catch (_) {}
}

// Ocean Currents + Temperature: same wrapping-GridLayer pattern; pane
// oceanPane (361 — just above the isobars).
if (window.OceanLayer && typeof window.OceanLayer.init === "function") {
  try { window.OceanLayer.init(map); } catch (_) {}
}

// Hydrological basins: FAO drainage regions in basinPane (362 — above
// the isobars, below the rivers).
if (window.BasinLayer && typeof window.BasinLayer.init === "function") {
  try { window.BasinLayer.init(map); } catch (_) {}
}

// Earthquakes, tectonic faults and the language regions: the three new
// overlays. Each owns its own pane and its own probe; the click-to-
// submit guard below checks all of them, so an armed probe keeps
// working as a single click.
if (window.OceanCurrentLayer && typeof window.OceanCurrentLayer.init === "function") {
  try { window.OceanCurrentLayer.init(map); } catch (_) {}
}
if (window.EarthquakeLayer && typeof window.EarthquakeLayer.init === "function") {
  try { window.EarthquakeLayer.init(map); } catch (_) {}
}
if (window.FaultLayer && typeof window.FaultLayer.init === "function") {
  try { window.FaultLayer.init(map); } catch (_) {}
}
if (window.LanguagesRegionsLayer && typeof window.LanguagesRegionsLayer.init === "function") {
  try { window.LanguagesRegionsLayer.init(map); } catch (_) {}
}

// The probe stack (probe-stack.js): ONE positioner for every readout on
// the map. Each layer used to place its own probe box at "cursor + 14px",
// so with the wind, the wind speed and the climate all on, three boxes
// landed on the same 14px and covered each other — the reader saw the top
// one and the other two were hidden underneath it.
//
// It is initialised BEFORE the hover HUD, because the HUD's card is part
// of the same column: the stacker lays the card and the layer probes out
// together so the card never covers a reading.
if (window.ProbeStack && typeof window.ProbeStack.init === "function") {
  try { window.ProbeStack.init(map); } catch (_) {}
}

// Hover HUD (hover-info.js): one cursor-following card whose mode
// (off / pins / all) the user picks in the control menu. In "all" mode
// it also suppresses the layers' own hover boxes so nothing stacks.
if (window.HoverInfo && typeof window.HoverInfo.init === "function") {
  try { window.HoverInfo.init(map); } catch (_) {}
}

// On address-bar loads (typing xyzo.org fresh, not via hard refresh),
// the #map container often has zero height at this instant because the
// browser hasn't committed CSS layout yet.  Calling invalidateSize() in
// the next animation frame, after layout, forces Leaflet to re-measure
// the container at its real size.  CanvasPinRenderer's ResizeObserver
// picks up the size change and triggers a redraw with correct geometry
// — but only if Leaflet's internal _size cache was rebuilt first,
// otherwise latLngToContainerPoint returns 0-tall positions and pins
// land at the wrong vertical coordinates.  See CanvasPinRenderer._draw.
requestAnimationFrame(() => {
  try { map.invalidateSize({ animate: false }); } catch (_) { /* map destroyed */ }
});

// Race-condition fix: index.html loads styles.css with the
// `media="print" onload="this.media='all'"` async trick.  When the
// stylesheet has not landed yet, Leaflet's _initLayout reads
// `getComputedStyle().position` as `static` and forces
// `position: relative` INLINE.  The stylesheet's own
// `#map { position: fixed; inset: 0 }` can then never size the
// container — a relatively positioned element with `inset: 0` is only
// offset, not sized — so the map stays 0×0 and the user sees no map at
// all.
//
// This bit Firefox on a COLD first load (the stylesheet arrives after
// the script): the container ended up 0 px tall with
// `style="position: relative"`, and no tiles were ever drawn.  A
// reload worked because the stylesheet was already cached.
//
// The check must therefore run AFTER the stylesheet is applied — the
// previous version only looked at the state at script-execution time
// (where `inset` is still "auto"), so it never fired.
(function fixMapPositionIfLeafletClobbered() {
  const el = document.getElementById("map");
  if (!el) return;

  const restore = () => {
    // Leaflet only forces the inline override when the stylesheet was
    // not applied yet.  If it is there, the stylesheet wins once the
    // inline value is cleared.
    if (el.style.position === "relative") {
      const cs = getComputedStyle(el);
      if (cs.position === "relative" && cs.inset !== "auto" && cs.inset !== "") {
        el.style.position = "";
      }
    }
    if (el.clientHeight > 0) {
      try { map.invalidateSize({ animate: false }); } catch (_) {}
    } else {
      // Last resort: the stylesheet still has not arrived (or was blocked
      // by an extension).  Give the container a viewport height so the
      // map is never invisible.
      el.style.height = "100vh";
      el.style.width = "100vw";
      try { map.invalidateSize({ animate: false }); } catch (_) {}
    }
  };

  // styles.css is async-loaded via the onload trick → re-check when it
  // fires, and also on the next frames in case it is already applied.
  const link = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
    .find((l) => /styles\.css/.test(l.href));
  if (link) {
    if (link.sheet) restore();
    else link.addEventListener("load", restore, { once: true });
  }
  requestAnimationFrame(restore);
  setTimeout(restore, 250);
  setTimeout(restore, 1000);
  window.addEventListener("load", restore, { once: true });
})();

// Wrap map.flyTo so it honours prefers-reduced-motion (WCAG 2.3.3).
// When the user has opted out of motion, fall back to setView with the
// native animation disabled instead of the smooth flyTo curve.
(() => {
  const _origFlyTo = map.flyTo.bind(map);
  map.flyTo = function (latlng, zoom, options) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return map.setView(latlng, zoom, { animate: false });
    }
    return _origFlyTo(latlng, zoom, options);
  };
})();

// A "finger, not a mouse" test. Coarser than a width check: a landscape
// phone or an iPad is under the width of a laptop but still has no hover,
// and every "does this UI need to wait for the user" decision below is
// really "is there a finger on the screen".
const isCoarsePointer = () =>
  typeof window !== "undefined" &&
  (window.matchMedia("(pointer: coarse)").matches ||
   navigator.maxTouchPoints > 0);

// The text-size control (A / A+ / A++) scales `.leaflet-popup-content-
// wrapper` with CSS `zoom: var(--ui-zoom)` (default 1.15).
//
// CSS zoom is INVISIBLE to Leaflet. It measures `offsetWidth` before the
// zoom, takes `maxWidth` from that, and pans the map to fit the number it
// measured — while the popup actually renders `zoom` times wider. On a
// 393 px phone that meant a 341 px popup rendered 392 px, its wrapper
// rendered 424 px, and the ✕ Close — absolutely anchored to the RENDERED
// right edge — landed off the right-hand side of the screen with nothing
// behind it to tap. That is "the close button doesn't work on mobile": it
// worked at the A setting (zoom 1) and failed at the default A+.
//
// So every width Leaflet is given must be the PRE-ZOOM width.
function popupUiZoom() {
  try {
    const z = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--ui-zoom"));
    return isFinite(z) && z > 0 ? z : 1;
  } catch (_) {
    return 1;
  }
}
// Leaflet is told to lay the content out at this width; after the zoom it
// renders at (roughly) `cap` px, which must fit the viewport.
function popupMaxWidthForViewport() {
  const zoom = popupUiZoom();
  const BASE = 340;                 // the long-standing desktop popup width
  // Reserve real clearance either side, not just enough to squeak in: the
  // popup has to sit clear of the screen edge AND still leave map around
  // it, and keepPopupOnScreen() needs somewhere to put it.
  const fit = Math.max(200, window.innerWidth - 96);
  return Math.max(160, Math.floor(Math.min(BASE, fit) / zoom));
}

// Standard Leaflet Popup Configuration for smart centering & persistent panning
const POPUP_OPTIONS = {
  maxWidth: popupMaxWidthForViewport(),
  minWidth: 260,
  // The popup's content box. It was 380 px, and the content is ~914 px
  // long (the hero, the title, the badges, the actions, and the keyword
  // / related-story / location sections), so everything past 380 px is
  // BELOW THE FOLD — and clipped content is not hit-tested, so a button
  // that lands there is invisible AND dead. 440 px keeps the action row
  // (which carries "view", the reactions, the satellite view and the
  // coordinates) inside the visible box. keepPopupOnScreen() still
  // refuses to correct an axis the popup does not fit on, so a tall
  // popup on a short screen is never pushed off it.
  maxHeight: 440,
  // autoPan is OFF because we do our own framing in keepPopupOnScreen().
  // Leaflet's own autoPan is ANIMATED, so a correction that runs right
  // after popupopen races with it: both pan the map and the popup ends up
  // wherever the last one landed (measured 2/6 popups still off-screen).
  // Our version measures the real, zoomed popup box and pans once,
  // immediately — no animation to race with, and the ✕ is on-screen the
  // moment the popup appears.
  autoPan: false,
  autoPanPadding: [60, 80],
  autoPanPaddingTopLeft: [60, 100],
  autoClose: true,       // Close the previous popup when a new marker popup opens
  closeOnClick: false,   // Don't close when dragging or clicking map background
  closeOnMove: false,    // Don't close while map is moving or zooming!
  closeOnEscapeKey: true // Allow Escape key to close
};

// Global Escape Key Listener for easy dismiss
// Because sometimes you just need to hit Escape and walk away.
const XYZO_DEBUG = new URLSearchParams(location.search).has('debug') || localStorage.getItem('xyzo.debug') === '1';

// Popup state machine. Yes, it's a state machine. No, we're not sorry.
// Popups are surprisingly complex when you have:
// - User clicks pin → open popup
// - User clicks map → close popup
// - User pans map → maybe close popup?
// - User hits Escape → close popup
// - Mobile user taps elsewhere → close popup
// - User opens a different popup → close the first one
// - User scrolls the popup content → keep it open!
// - User closes popup explicitly → DON'T auto-reopen it
// Each of these is a boolean flag. We're not proud, but it works.
let _activePopupState = null;
let _isUserExplicitClose = false;
let _popupIsOpen = false;
let _inSyncLayers = false;
// Set briefly by the mobile pan-auto-close path so the popupclose handler
// below does NOT auto-restore the popup the user just walked away from.
let _mobilePanSuppressRestore = false;

window.closeActivePopup = function() {
  if (XYZO_DEBUG) XLog.log("[XYZO POPUP DEBUG] User explicitly closed active popup.");
  _isUserExplicitClose = true;
  _activePopupState = null;
  _popupIsOpen = false;
  if (window._xyzoMap) {
    try { window._xyzoMap.closePopup(); } catch (_) {}
  }
  setTimeout(() => { _isUserExplicitClose = false; }, 300);
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.closeActivePopup();
    // Escape during a search must also exit search mode, not just close the
    // popup (results stayed up otherwise).
    if (typeof searchActive !== "undefined" && searchActive
        && typeof clearSearch === "function") {
      clearSearch();
    }
  }
});

// ── Modal a11y helpers (focus trap + Escape-to-close) ─────────────────
// Shared by explore-panel, help-panel, and any other dialog we add later.
// installModalA11y is idempotent — calling it twice on the same element
// is safe (the second call returns the existing handlers). closeModalA11y
// removes both handlers so a re-open starts fresh.
//
// "What's a focus trap?"
// It's a accessibility feature that keeps your keyboard focus inside the
// modal when you Tab. Without it, keyboard users would Tab right through
// the modal into the map behind it. That's bad. Don't be that person.
function getModalFocusable(modalEl) {
  const sel = 'button:not([disabled]):not([hidden]), [href], input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])';
  return Array.from(modalEl.querySelectorAll(sel)).filter((el) => {
    // Skip elements that are display:none or visibility:hidden ancestors
    if (el.hasAttribute("hidden")) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0 && el !== document.activeElement) return false;
    return true;
  });
}

const _modalEscapeHandlers = new WeakMap();
const _modalFocusTrapHandlers = new WeakMap();

function installModalA11y(modalEl) {
  if (_modalEscapeHandlers.has(modalEl)) return; // already installed
  const onKey = (e) => {
    if (e.key !== "Tab") return;
    const focusable = getModalFocusable(modalEl);
    if (focusable.length === 0) {
      // No focusable children — keep focus inside the modal itself
      e.preventDefault();
      modalEl.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !modalEl.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !modalEl.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  modalEl.addEventListener("keydown", onKey);
  _modalFocusTrapHandlers.set(modalEl, onKey);
  // Make modal itself programmatically focusable so the trap has a target.
  if (!modalEl.hasAttribute("tabindex")) modalEl.setAttribute("tabindex", "-1");
  _modalEscapeHandlers.set(modalEl, true); // marker only
  modalEl._a11yHasEscape = false; // we'll attach escape on open()
}

function attachModalEscape(modalEl, closeFn) {
  if (modalEl._a11yHasEscape) return; // already attached for this open cycle
  const onEsc = (e) => {
    if (e.key === "Escape") {
      // Don't fight the popup close handler (line ~1095) or the submitter
      // overlay (line ~9951). They handle Escape at a higher level.
      closeFn();
    }
  };
  modalEl._a11yEscHandler = onEsc;
  modalEl._a11yHasEscape = true;
  document.addEventListener("keydown", onEsc);
}

function detachModalEscape(modalEl) {
  if (!modalEl._a11yHasEscape) return;
  document.removeEventListener("keydown", modalEl._a11yEscHandler);
  modalEl._a11yHasEscape = false;
  modalEl._a11yEscHandler = null;
}

function removeModalA11y(modalEl) {
  detachModalEscape(modalEl);
  const trap = _modalFocusTrapHandlers.get(modalEl);
  if (trap) {
    modalEl.removeEventListener("keydown", trap);
    _modalFocusTrapHandlers.delete(modalEl);
  }
  _modalEscapeHandlers.delete(modalEl);
}

// Open a modal dialog: unhide, install a11y, focus first focusable.
function openModalA11y(modalEl, opts = {}) {
  const { returnFocusTo = null } = opts;
  modalEl._returnFocusTo = returnFocusTo;
  modalEl.hidden = false;
  installModalA11y(modalEl);
  // Focus first focusable on the next tick so the panel is rendered first.
  setTimeout(() => {
    const focusable = getModalFocusable(modalEl);
    if (focusable[0]) focusable[0].focus();
  }, 0);
}

// Close a modal dialog: hide, remove a11y, restore focus.
function closeModalA11y(modalEl) {
  const returnTo = modalEl._returnFocusTo;
  modalEl.hidden = true;
  removeModalA11y(modalEl);
  modalEl._returnFocusTo = null;
  if (returnTo && typeof returnTo.focus === "function") {
    try { returnTo.focus(); } catch (_) {}
  }
}

// Capture-phase listener for user clicking the Leaflet popup close button (x)
document.addEventListener("click", (e) => {
  if (e.target && e.target.closest && e.target.closest(".leaflet-popup-close-button")) {
    if (XYZO_DEBUG) XLog.log("[XYZO POPUP DEBUG] User clicked Leaflet popup close button.");
    window.closeActivePopup();
  }
}, true);

// Wire the custom close button of a popup.
//
// Leaflet's own X is hidden by CSS (`.leaflet-container a
// .leaflet-popup-close-button { display: none !important }`) because the
// custom button replaced it — so a popup WITHOUT a custom button has no
// way to be closed at all. The map is created with `closePopupOnClick:
// false`, so clicking the map does not dismiss one either.
//
// Called centrally on `popupopen` so every popup gets it, including the
// ones built outside buildPopup()/buildEventPopup(). Idempotent: the
// same element is never wired twice.
//
// THE LISTENER IS DELEGATED FROM THE POPUP ELEMENT, not bound to the
// button. Leaflet's `Popup.update()` calls `_updateContent()`, and the
// popup content here is a FUNCTION (`bindPopup(() => buildPopup(...))`),
// so every zoom, pan or position change REBUILDS the content and
// replaces the button with a brand-new element. A listener bound to the
// button is thrown away with the old node — the ✕ then does nothing at
// all, and because the idempotency flag lived on the popup element the
// replacement button was never re-wired. The popup element survives the
// rebuild, so the listener goes there.
function attachPopupClose(el) {
  if (!el) return false;
  if (el._xyzoCloseWired) return true;
  const closeBtn = el.querySelector(".popup-close-btn, .popup-close-btn-mobile");
  if (!closeBtn) return false;
  el._xyzoCloseWired = true;
  el.addEventListener("click", (ev) => {
    const btn =
      ev.target && ev.target.closest
        ? ev.target.closest(".popup-close-btn, .popup-close-btn-mobile")
        : null;
    if (!btn || !el.contains(btn)) return;
    ev.preventDefault();
    window.closeActivePopup();
  });
  return true;
}

// Pan the map just enough that the open popup (and its ✕ Close) sits
// fully inside the viewport.
//
// WHY THIS IS NEEDED: Leaflet sizes and autoPans the popup from
// `offsetWidth`, which is measured BEFORE the content wrapper's CSS `zoom`
// (`zoom: var(--ui-zoom)`, 1.15 by default). So autoPan pans to fit a box
// ~15 % smaller than the one actually drawn, and on a phone the popup —
// with the ✕ anchored to its right edge — can still land outside the
// screen. Measured on an iPhone 14 Pro: 1 in 4 popups had the ✕ ~2 px
// past the right edge and the popup ~12 px over. Correct the framing by
// panning the MAP (the popup stays anchored to its pin, so this moves the
// camera, not the popup off its story).
//
// The `if` on the smaller axis matters: a popup taller than the screen
// must not be "corrected" vertically, or panning its bottom in just throws
// its top out the other side.
//
// THE PAN IS THE MAP'S, NOT THE POPUP'S — AND THE SIGN MATTERS.
// `map.panBy([dx, dy])` moves the map's CENTRE by (dx, dy), so the popup —
// which is anchored to its pin — moves the OTHER way. The correction
// below is therefore the OPPOSITE sign to the screen-space error.
//
// IT USED TO BE THE SAME SIGN, and every correction pushed the popup
// FURTHER off the screen. Measured on a phone after a search (2026-11-11,
// scripts/search_mobile_audit.py): the popup walked from 34 px past the
// right edge to 970 px ABOVE the top of the screen in four corrections,
// each one DOUBLE the last — because each correction was computed from
// the position the previous (wrong-way) one had produced.
const POPUP_EDGE_MARGIN = 10;
// A framing pass is already running (the pan it started fires moveend
// synchronously, and moveend re-frames). See the guard at the bottom.
let _popupFraming = false;
function keepPopupOnScreen() {
  const popup = map && map._popup;
  if (!popup || !popup.isOpen()) return;
  const el = popup.getElement();
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const size = map.getSize();
  // Fixed chrome the popup has to clear, not just the screen edge: the
  // search pill sits over the top of the map, #bottom-bar over the
  // bottom, and #search-status — the line that says "412 stories in
  // Chicago" — sits just above the bar and only EXISTS after a search
  // (`#search-status:empty { display: none }`). A popup whose ✕ lands
  // behind any of them is exactly as un-closable as one pushed
  // off-screen.
  const rectOf = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    if (getComputedStyle(el).display === "none") return null;
    const cr = el.getBoundingClientRect();
    if (!cr.height && !cr.width) return null;
    return cr;
  };
  const searchBar = rectOf("#search-bar");
  const bottomBar = rectOf("#bottom-bar");
  const searchStatus = rectOf("#search-status");
  // The bottom edge is the MEASURED distance from the viewport bottom to
  // the top of the chrome — NOT the chrome's height. The bar is itself
  // offset 12 px from the bottom edge (plus the home-indicator inset on
  // an iPhone), so its height is ~14 px short of the edge a popup has to
  // clear. --bottom-bar-top is that distance, published by
  // publishChromeEdges().
  const cssBottomTop =
    parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue("--bottom-bar-top")) || 0;
  let bottomReserve = 0;
  if (bottomBar) bottomReserve = Math.max(bottomReserve, window.innerHeight - bottomBar.top);
  if (cssBottomTop) bottomReserve = Math.max(bottomReserve, cssBottomTop);
  if (searchStatus) bottomReserve = Math.max(bottomReserve, window.innerHeight - searchStatus.top);
  const insetTop = POPUP_EDGE_MARGIN + (searchBar ? searchBar.bottom : 0);
  const insetBottom = POPUP_EDGE_MARGIN + bottomReserve;
  // dx/dy are the MAP's pan, in pixels. The popup moves the other way.
  //
  // THEY ARE ROUNDED BEFORE THE ZERO TEST. Leaflet rounds the offset
  // itself, and its `panBy([0, 0])` FIRES moveend WITHOUT moving — so a
  // fractional correction of 0.4 px was panned as [0, 0], the moveend
  // fed the framing pass straight back into itself, and the reader got
  // a "Maximum call stack size exceeded" instead of a popup.
  let dx = 0, dy = 0;
  if (r.width <= size.x - 2 * POPUP_EDGE_MARGIN) {
    if (r.right > size.x - POPUP_EDGE_MARGIN) dx = Math.round(r.right - (size.x - POPUP_EDGE_MARGIN));
    else if (r.left < POPUP_EDGE_MARGIN) dx = Math.round(r.left - POPUP_EDGE_MARGIN);
  }
  if (r.height <= size.y - insetTop - insetBottom) {
    if (r.bottom > size.y - insetBottom) dy = Math.round(r.bottom - (size.y - insetBottom));
    else if (r.top < insetTop) dy = Math.round(r.top - insetTop);
  }
  if (!dx && !dy) return;
  // A pan fires moveend SYNCHRONOUSLY, and moveend re-frames the popup.
  // Without this guard the two feed each other.
  if (_popupFraming) return;
  _popupFraming = true;
  try {
    map.panBy([dx, dy], { animate: false });
  } finally {
    _popupFraming = false;
  }
}

// ── Is the map in motion? ──────────────────────────────────────────────
//
// Leaflet fires `movestart` when a movement BEGINS and `moveend` when it
// ends — for a programmatic flyTo/flyToBounds as well as for a user's
// drag — and it has no public "isAnimating" flag. Every "wait for the
// map to settle" decision below needs to know whether a movement is IN
// FLIGHT, so we track it ourselves.
//
// `_mapMoveByUser` separates the two kinds of movement: a USER drag must
// never be fought (the popup is anchored to its pin, so the reader is
// allowed to walk away from it — on a phone the popup is closed
// outright), while a PROGRAMMATIC move (a search framing, a cluster
// flight) is exactly the thing the popup has to be re-framed after.
let _mapIsMoving = false;
let _mapMoveByUser = false;
map.on("movestart", () => { _mapIsMoving = true; _mapMoveByUser = false; });
map.on("dragstart", () => { _mapMoveByUser = true; });
map.on("moveend", () => {
  _mapIsMoving = false;
  if (_popupIsOpen && !_mapMoveByUser) {
    try { keepPopupOnScreen(); } catch (_) {}
  }
});
map.on("zoomend", () => {
  if (_popupIsOpen && !_mapMoveByUser) {
    try { keepPopupOnScreen(); } catch (_) {}
  }
});

// ── Open a popup ONCE THE MAP HAS SETTLED ─────────────────────────────
//
// A popup is anchored to its pin, so a popup that opens while the map is
// still moving RIDES the map: it slides for the rest of the flight, and
// a tap aimed at the ✕ lands on whatever moved into that spot.
//
// Three paths open a popup on a tap — the DOM marker, the canvas pin and
// the event marker — and each of them used to open it on its own timing:
//
//   * the DOM marker: Leaflet's own `click → _openPopup` handler opened
//     it SYNCHRONOUSLY, so the popup was up 0 ms into the 700 ms
//     `flyToBounds` that maybeZoomToCluster() starts for any pin with ≥3
//     neighbours within 30 km (after a search that is nearly every pin);
//   * the canvas pin: `tmpMarker.openPopup()` — also synchronous;
//   * the event marker: Leaflet opened it synchronously too.
//
// So the wait lives in ONE helper and all three paths call it.
//
// THE FALLBACK IS A BOUND, NOT A DEADLINE. A 700 ms flight is LONGER than
// the 600 ms coarse-pointer fallback, so a fallback that simply fired
// would open the popup 600 ms into the flight — the very bug. It
// re-arms while the map is still moving, up to POPUP_SETTLE_MAX_WAIT_MS.
//
// IT FIRES ONCE. Every request carries a sequence number, so a second tap
// supersedes the first, and the `done` flag makes the moveend listener
// and the fallback mutually exclusive.
const POPUP_SETTLE_MAX_WAIT_MS = 3000;
let _popupSettleTimer = null;
let _popupSettleSeq = 0;

function openPopupWhenSettled(openFn) {
  if (typeof openFn !== "function") return;
  const seq = ++_popupSettleSeq;
  if (_popupSettleTimer) { clearTimeout(_popupSettleTimer); _popupSettleTimer = null; }
  const started = Date.now();
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    if (_popupSettleTimer) { clearTimeout(_popupSettleTimer); _popupSettleTimer = null; }
    map.off("moveend", onMoveEnd);
    if (seq !== _popupSettleSeq) return;   // a newer request took over
    try { openFn(); } catch (e) {
      XLog.warn("[popup-settle] the popup could not be opened:", e);
    }
  };
  const onMoveEnd = () => {
    // A movement can END and another BEGIN in the same tick: a tap starts
    // a pan and then a flyToBounds, and stopping the pan fires a moveend
    // of its own. Only open when the map has REALLY settled.
    if (_mapIsMoving) { arm(); return; }
    fire();
  };
  const arm = () => {
    _popupSettleTimer = setTimeout(() => {
      _popupSettleTimer = null;
      if (_mapIsMoving && Date.now() - started < POPUP_SETTLE_MAX_WAIT_MS) { arm(); return; }
      fire();
    }, isCoarsePointer() ? 600 : 150);
  };
  // The map is not moving: there is nothing to wait for.
  if (!_mapIsMoving) { fire(); return; }
  map.once("moveend", onMoveEnd);
  arm();
}

map.on("popupopen", (e) => {
  _popupIsOpen = true;
  if (e.popup) {
    // Every popup needs a way out — see attachPopupClose().
    try { attachPopupClose(e.popup.getElement()); } catch (_) {}
    // Leaflet's autoPan is off (see POPUP_OPTIONS) — this is the whole
    // framing pass. Run it synchronously so the popup is on-screen the
    // instant it appears, and once more on the next tick in case a popup
    // built from an async content function reflows after open.
    try { keepPopupOnScreen(); } catch (_) {}
    setTimeout(keepPopupOnScreen, 0);
    const latlng = e.popup.getLatLng();
    const content = e.popup.getContent();
    const markerId = e.popup._source?._xyzoId ?? null;
    if (latlng && content) {
      _activePopupState = {
        latlng,
        content,
        markerId,
        // The pin data travels with the state: a popup restored as a
        // STANDALONE popup (the marker it belonged to is gone) has no
        // marker to wire its action buttons from, and without this they
        // were dead — see restoreActivePopup().
        pin: e.popup._source?._pinData || null,
        isEvent: !!e.popup._source?._xyzoEventId
      };
      if (markerId) _activePinId = markerId;
      if (XYZO_DEBUG) XLog.log("[XYZO POPUP DEBUG] Saved active popup state:", _activePopupState);
    }
  }
  // Update URL hash so shared links can open this specific pin
  try { if (typeof updateUrlHash === "function") updateUrlHash(); } catch (_) {}
});

map.on("popupclose", (e) => {
  _popupIsOpen = false;
  if (_isUserExplicitClose) {
    _activePinId = null;
    // Clear pin from URL when user explicitly closes popup
    try { if (typeof updateUrlHash === "function") updateUrlHash(); } catch (_) {}
  }
  if (XYZO_DEBUG) XLog.log("[XYZO POPUP DEBUG] popupclose fired. Explicit close?", _isUserExplicitClose, "In syncLayers?", _inSyncLayers, "Mobile pan?", _mobilePanSuppressRestore);
  if (_isUserExplicitClose || _inSyncLayers || _mobilePanSuppressRestore) {
    if (_isUserExplicitClose) {
      _activePopupState = null;
    }
    // Do NOT schedule auto-restore!
  } else {
    // If popup was closed unexpectedly (not user close and not during syncLayers), check if state exists
    if (!_activePopupState) return;
    setTimeout(restoreActivePopup, 50);
  }
});

// ── Mobile-only: auto-close popup when the user pans/zooms away ───────
// On phones, the popup is anchored to its pin so panning drags the
// popup with the map and the close (×) button often falls off-screen —
// leaving the user stuck with the popup open. Match Google/Apple Maps
// UX: any user-initiated map movement closes the open popup — UNLESS
// the user is touching inside the popup itself (scrolling/reading it).
//
// Programmatic flyTo()/setView() (search results, "Fly to" buttons,
// explore-region jumps) do NOT set `e.originalEvent`, so they pass
// through this guard untouched.
function setupMobilePopupAutoClose() {
  if (typeof window.matchMedia !== "function") return;
  // Standard 768px breakpoint + a slightly wider touch-only fallback
  // for tablets / landscape phones that still feel "mobile".
  const isMobile =
    window.matchMedia("(max-width: 768px)").matches ||
    ("ontouchstart" in window && window.innerWidth <= 900);
  if (!isMobile) return;

  let popupInteracting = false;

  // When a popup opens, attach touchstart/touchend listeners to detect
  // the user actively interacting with the popup content (scrolling,
  // tapping action buttons). Leaflet does not start a map drag when
  // the touch begins inside a popup, so the guard only needs to cover
  // the brief window after touchend in case the user lifts and starts
  // a new map gesture.
  map.on("popupopen", (e) => {
    const el = e.popup && e.popup.getElement && e.popup.getElement();
    if (!el) return;
    el.addEventListener("touchstart", () => { popupInteracting = true; }, { passive: true });
    el.addEventListener("touchend", () => {
      setTimeout(() => { popupInteracting = false; }, 250);
    }, { passive: true });
  });

  // On any user-initiated map movement, close the popup. We only react
  // to genuine user gestures (touchstart, mousedown, wheel) — Leaflet
  // sets originalEvent on these. Programmatic flyTo/setView leave it
  // undefined and we early-return.
  map.on("movestart", (e) => {
    if (popupInteracting) return;
    const original = e && e.originalEvent;
    if (!original) return;
    const t = original.type;
    if (t !== "touchstart" && t !== "mousedown" && t !== "wheel") return;

    // Flip the suppress flag so the popupclose handler below doesn't
    // auto-restore the popup 50ms later (it assumes programmatic
    // closes are usually layer-rebuild races and re-opens automatically).
    _mobilePanSuppressRestore = true;
    try { map.closePopup(); } catch (_) {}
    setTimeout(() => { _mobilePanSuppressRestore = false; }, 300);
  });
}
setupMobilePopupAutoClose();

function restoreActivePopup() {
  if (!_activePopupState || _isUserExplicitClose || _inSyncLayers) return;
  if (_popupIsOpen) return;

  if (XYZO_DEBUG) XLog.log("[XYZO POPUP DEBUG] Restoring active popup at:", _activePopupState.latlng);
  const { latlng, content, markerId, isEvent } = _activePopupState;
  const reg = isEvent ? eventMarkers : pinMarkers;
  const m = markerId !== null ? reg.get(markerId) : null;

  if (m && m._map) {
    try {
      m.setPopupContent(content);
      m.openPopup();
      return;
    } catch (e) {
      if (XYZO_DEBUG) XLog.warn("[XYZO POPUP DEBUG] Marker openPopup failed, falling back to standalone popup:", e);
    }
  }

  try {
    const standalone = L.popup(POPUP_OPTIONS).setLatLng(latlng).setContent(content);
    standalone.openOn(map);
    // A STANDALONE popup has no marker behind it, so the marker's own
    // `popupopen` handler never runs — and that handler is what wires
    // the action buttons (read more, fix, report, love, star,
    // recommend) and the mobile Details toggle. Without this the
    // restored popup was readable and closable but DEAD: every button
    // in it did nothing.
    const el = standalone.getElement && standalone.getElement();
    if (el) {
      attachPopupClose(el);
      const pin = _activePopupState.pin ||
        (markerId != null ? clientPinStore.pinsById.get(Number(markerId)) : null);
      if (isEvent) {
        if (pin) wireEventPopupActions(standalone, pin);
      } else if (pin) {
        wirePopupActions(standalone, pin);
      }
    }
  } catch (err) {
    if (XYZO_DEBUG) XLog.error("[XYZO POPUP DEBUG] Standalone popup restore failed:", err);
  }
}

// The "whole earth" view — used as the first-run default and by the globe button.
// [20, 0] is roughly the Gulf of Guinea — the "null island" of cartography.
// If you ever see a pin at 0,0, it's probably a bug. Or a very confused sailor.
const WORLD_VIEW = { center: [20, 0], zoom: 2 };

// ── URL Hash Sync ──────────────────────────────────────────────────────
// Map position is stored in the URL hash as #lat,lng,zoom
// This allows sharing exact map locations via URL.
// When a pin popup is open, pin=ID is appended so the URL opens that story.
// Map position and layer styles are stored in the URL hash as:
// #lat,lng,zoom/pin=ID/base=BaseLayerName/overlay=Overlay1,Overlay2
//
// "Why a hash and not query params?"
// Because hashes don't trigger page reloads, and we can update them
// without the browser scrolling to the top. Also, `history.replaceState`
// is our friend.
let _activePinId = null;
let _activeBaseLayerName = "Satellite";
const _activeOverlayNames = new Set();

// The isobar layer is not a registered L.tileLayer overlay — it is drawn
// from vector lines by public_html/isobar-layer.js — but it still takes
// part in the layers dropdown and the URL hash under this name.
// Declared before LAYER_SLUGS, which references it.
const ISOBAR_LAYER_NAME = "⛅ Pressure lines (isobars)";

// The wind animation's display name — the layers-dropdown entry. It
// takes part in the URL hash like every other overlay, and the hash
// also carries how it is DRAWN (`wind=flow:colourful`). Taken from the
// module rather than typed out, so a rename cannot leave the hash
// looking for a layer that no longer exists.
const WIND_LAYER_NAME =
  (window.WindLayer && window.WindLayer.LAYER_NAME) || "💨 Wind (GFS)";

const LAYER_SLUGS = {
  "street": "🗺️ Street",
  "satellite": "🛰️ Satellite",
  "topo": "🗺️ Topo",
  "streets": "🗺️ Streets",
  "natgeo": "🗺️ NatGeo",
  "terrain": "🗺️ Terrain",
  "dark": "🗺️ Dark",
  "light": "🗺️ Light",
  "nasa-sat": "🛰️ NASA Satellite (True Color)",
  "nasa-satellite": "🛰️ NASA Satellite (True Color)",
  "nasa-rain": "🌧️ NASA Rain Rate (IMERG)",
  "nasa-night": "🌌 NASA Earth at Night",
  "facebook": "🤝 Facebook Friendships",
  "basins": "🌊 Hydrological Basins",
  "hydrological-basins": "🌊 Hydrological Basins",
  "ocean-current": "🌊 Ocean currents (OSCAR)",
  "ocean-currents-live": "🌊 Ocean currents (OSCAR)",
  "ocean-currents-oscar": "🌊 Ocean currents (OSCAR)",
  "currents-live": "🌊 Ocean currents (OSCAR)",
  "earthquakes": "🌐 Earthquakes (USGS)",
  "usgs-earthquakes": "🌐 Earthquakes (USGS)",
  "quake": "🌐 Earthquakes (USGS)",
  "faults": "🪨 Tectonic faults (USGS)",
  "tectonic-faults": "🪨 Tectonic faults (USGS)",
  "fault-contacts": "🪨 Tectonic faults (USGS)",
  "language-regions": "🌍 Language regions",
  "language-regions-glottolog": "🌍 Language regions",
  "languages-regions": "🌍 Language regions",
  "isobars": ISOBAR_LAYER_NAME,
  "isobars-pressure-lines": ISOBAR_LAYER_NAME,
  "pressure-lines": ISOBAR_LAYER_NAME,
  "koppen": "🌍 Köppen Climate",
  "climate": "🌍 Köppen Climate",
  "wind": "💨 Wind (GFS)",
  "wind-gfs": "💨 Wind (GFS)",
  "wind-speed": "🌬️ Wind speed (GFS)",
  "wind-speed-gfs": "🌬️ Wind speed (GFS)",
  "cape": "⛈️ Convective instability (CAPE)",
  "instability": "⛈️ Convective instability (CAPE)",
  "ivt": "🌊 Moisture transport (IVT)",
  "moisture-transport": "🌊 Moisture transport (IVT)",
  "temperature": "🌡️ Temperature (GFS)",
  "temp": "🌡️ Temperature (GFS)",
  "lightning": "⚡ Lightning density (WWLLN)",
  "lightning-density": "⚡ Lightning density (WWLLN)",
  "lightning-wwlln": "⚡ Lightning density (WWLLN)",
  "phytoplankton": "🦠 Phytoplankton (Darwin)",
  "phytoplankton-darwin": "🦠 Phytoplankton (Darwin)",
  "darwin": "🦠 Phytoplankton (Darwin)",
  "indigenous": "🌍 Languages",
  // Plain "languages" alias — the source's own word — plus the old
  // Indigenous Languages slugs, which now resolve to the Glottolog
  // replacement so shared links do not die with the rename.
  "languages": "🌍 Languages",
  "world-languages": "🌍 Languages",
  "glottolog": "🌍 Languages",
  "indigenous-languages": "🌍 Languages",
  "native-languages": "🌍 Languages",
  "native-land": "🌍 Languages",
  // Explicit slugs for the 2026-10-28 overlays. getLayerSlug() would
  // resolve them anyway; pinning them here makes the URL contract
  // readable and guards against a future change to the slugifier.
  "soil": "🟫 Soil",
  "soil-soilgrids": "🟫 Soil",
  "cropland": "🌾 Cropland (ESA)",
  "cropland-esa": "🌾 Cropland (ESA)",
  "land-cover": "🗺️ Land Cover (ESA)",
  "land-cover-esa": "🗺️ Land Cover (ESA)",
  "rivers": "💧 Rivers",
  // The 2026 FAO / HydroRIVERS network — a DIFFERENT dataset from the
  // Natural Earth one above, not a version of it. The slugs are pinned
  // so the URL contract is readable and a rename cannot break a link.
  "rivers-fao-2026": "🌊 Rivers (FAO 2026)",
  "fao-rivers": "🌊 Rivers (FAO 2026)",
  "hydrorivers": "🌊 Rivers (FAO 2026)",
  "rivers-2026": "🌊 Rivers (FAO 2026)",
  "geology": "🪨 Geology (Macrostrat)",
  "geology-macrostrat": "🪨 Geology (Macrostrat)",
  "contacts": "🗺️ Geologic contacts (USGS)",
  "geologic-contacts": "🗺️ Geologic contacts (USGS)",
  "geologic-contacts-usgs": "🗺️ Geologic contacts (USGS)",
  "city-names": "🏙️ City names",
  "etopo": "⛰️ Relief (ETOPO)",
  "waves": "🌊 Wave height & power",
  "wave": "🌊 Wave height & power",
  "wave-height": "🌊 Wave height & power",
  "wave-power": "🌊 Wave height & power",
  "relief": "⛰️ Relief (ETOPO)",
  "topography": "⛰️ Relief (ETOPO)",
  "bathymetry": "⛰️ Relief (ETOPO)",
  "cities": "🏙️ City names",
  "magnetic": "🧭 Magnetic Field (WMM)",
  "magnetic-field": "🧭 Magnetic Field (WMM)",
  "magnetic-field-wmm": "🧭 Magnetic Field (WMM)",
  "magnetics": "🧭 Magnetic Field (WMM)",
  "declination": "🧭 Magnetic Field (WMM)",
  "compass": "🧭 Magnetic Field (WMM)",
  "transport": "🛰️ Human Transportation",
  "transportation": "🛰️ Human Transportation",
  "human-transportation": "🛰️ Human Transportation",
  "anthropocene": "🛰️ Human Transportation",
  "salinity": "🧂 Sea surface salinity",
  "sea-surface-salinity": "🧂 Sea surface salinity",
  "sss": "🧂 Sea surface salinity",
  "ocean": "🌊 Ocean Currents (ECCO)",
  "ocean-currents": "🌊 Ocean Currents (ECCO)",
  "perpetual-ocean": "🌊 Ocean Currents (ECCO)",
  "ecco": "🌊 Ocean Currents (ECCO)",
  "currents": "🌊 Ocean Currents (ECCO)",
  // Legacy slugs that may be in bookmarks/URLs
  "openstreetmap": "🗺️ Street",
  "osm": "🗺️ Street",
  "esri-satellite": "🛰️ Satellite",
  "esri-streets": "🗺️ Streets",
  "esri-natgeo": "🗺️ NatGeo",
  "esri-terrain": "🗺️ Terrain",
  "esri-dark": "🗺️ Dark",
  "esri-light": "🗺️ Light",
  "cartodb-dark": "🗺️ Dark",
  "carto-dark": "🗺️ Dark",
  "jawg-dark": "🗺️ Dark",
  "openinframap": "🗺️ Street",
  "stamen-toner": "🗺️ Street",
  "stamen-terrain": "🗺️ Topo",
  "stadia-dark": "🗺️ Dark",
};

const REVERSE_LAYER_SLUGS = {
  "Street": "street",
  "Satellite": "satellite",
  "Topo": "topo",
  "🛰️ NASA Satellite (True Color)": "nasa-sat",
  "🌧️ NASA Rain Rate (IMERG)": "nasa-rain",
  "🌌 NASA Earth at Night": "nasa-night",
  "🤝 Facebook Friendships": "facebook",
  "🌊 Hydrological Basins": "basins",
  "🌍 Köppen Climate": "koppen",
  "⛅ Pressure lines (isobars)": "isobars",
  "🌡️ Temperature (GFS)": "temperature",
  "⚡ Lightning density (WWLLN)": "lightning",
  "🦠 Phytoplankton (Darwin)": "phytoplankton",
  "🌍 Languages": "languages",
  "🧭 Magnetic Field (WMM)": "magnetic",
  // The layer was renamed from "🟫 Soil (SoilGrids)" when the USDA
  // orders chip made the old name false — but the SLUG is unchanged on
  // purpose: every shared link, preset and bookmark that says
  // `overlay=soil-soilgrids@40` must keep working, and newly written
  // hashes must keep saying the same thing.
  "🟫 Soil": "soil-soilgrids",
  "🌾 Cropland (ESA)": "cropland-esa",
  "🗺️ Land Cover (ESA)": "land-cover-esa",
  "💧 Rivers": "rivers",
  "🌊 Rivers (FAO 2026)": "rivers-fao-2026",
  "🪨 Geology (Macrostrat)": "geology-macrostrat",
  // The currents' NAME says what the source is; the SLUG stays the
  // published contract ("ocean-currents-live") because the owner's own
  // links use it, and an identifier is not a claim of freshness.
  // Pinning it here stops the slugifier from deriving
  // "ocean-currents-oscar" and breaking those links. (The Earth-portrait
  // preset stopped carrying the currents on 2026-11-08 — they are a 2014
  // field — but its slug is unchanged, so every link that names it still
  // resolves.)
  "🌊 Ocean currents (OSCAR)": "ocean-currents-live",
  "🗺️ Geologic contacts (USGS)": "geologic-contacts-usgs",
  "🏙️ City names": "city-names",
  "⛰️ Relief (ETOPO)": "etopo",
  "🌊 Wave height & power": "waves"
};

function getLayerSlug(fullName) {
  if (!fullName) return "";
  if (REVERSE_LAYER_SLUGS[fullName]) return REVERSE_LAYER_SLUGS[fullName];
  return fullName
    .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// The URL slug of a layer name — the same function the hash writer uses.
// Exposed so scripts/map_speed_audit.py can address a layer by its real
// slug instead of re-implementing the rule (which is how an audit
// measures a layer that is not the one the map draws).
window.__xyzoLayerSlug = (name) => getLayerSlug(name);

function resolveLayerName(name) {
  if (!name) return null;
  let decoded = name;
  try { decoded = decodeURIComponent(name).trim(); } catch (_) {}

  if (typeof TILE_LAYERS !== "undefined" && TILE_LAYERS[decoded]) return decoded;
  if (typeof WEATHER_OVERLAYS !== "undefined" && WEATHER_OVERLAYS[decoded]) return decoded;
  if (decoded === ISOBAR_LAYER_NAME) return ISOBAR_LAYER_NAME;

  const lower = decoded.toLowerCase();
  if (LAYER_SLUGS[lower]) return LAYER_SLUGS[lower];

  if (typeof TILE_LAYERS !== "undefined") {
    for (const key of Object.keys(TILE_LAYERS)) {
      if (key.toLowerCase() === lower || getLayerSlug(key) === lower || key.toLowerCase().includes(lower)) return key;
    }
  }
  if (typeof WEATHER_OVERLAYS !== "undefined") {
    for (const key of Object.keys(WEATHER_OVERLAYS)) {
      if (key.toLowerCase() === lower || getLayerSlug(key) === lower || key.toLowerCase().includes(lower)) return key;
    }
  }
  return null;
}

// Set once the map has restored its view from the URL hash / localStorage.
// Until then the hash must not be rewritten — the position in a shared
// "#lat,lng,zoom" link would be lost. `var` (not `let`) so it is safe to
// read from updateUrlHash() before this line executes.
var _mapViewRestored = false;

// The effective opacity of an overlay, by its display name.
//
// The LIVE layer opacity is what the reader is looking at, and that is
// what a shared link has to reproduce. The stored value is the
// PREFERENCE, and the two disagree exactly when a shared link set an
// opacity: the link's value goes on the layer, and the boot snapshot
// then rolls the stored preference back (a link is a view, not a
// settings change). Reading the store first is what made the URL
// describe the preference instead of the map — the picture said 35 %
// and the link said 85 %.
//
// The registered overlays keep their value on the layer; the isobar
// layer is not a registered overlay and keeps its own.
function overlayOpacityFor(name) {
  try {
    const layer = (typeof WEATHER_OVERLAYS !== "undefined") ? WEATHER_OVERLAYS[name] : null;
    if (layer && layer.options && typeof layer.options.opacity === "number") {
      return layer.options.opacity;
    }
    if (name === ISOBAR_LAYER_NAME && window.IsobarLayer &&
        typeof window.IsobarLayer.getOpacity === "function") {
      const v = Number(window.IsobarLayer.getOpacity());
      if (Number.isFinite(v)) return v;
    }
    if (window.OverlayOpacity && typeof window.OverlayOpacity.get === "function") {
      const v = window.OverlayOpacity.get(
        typeof WEATHER_OVERLAYS !== "undefined" ? WEATHER_OVERLAYS : null, name);
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  } catch (_) {}
  return 1;
}

// Apply an opacity that arrived in a shared link. The layer, the slider
// and the stored value must all end up in agreement.
//
// But a LINK'S opacity is a VIEW, not a preference: the reader must see
// what the sender saw, and their own stored opacity must survive
// opening someone else's map. So the value goes on the layer and on
// the slider, and the store is left alone — the boot snapshot restores
// it anyway, and the slider remount that follows reads it back.
function applyOverlayOpacity(name, value) {
  const v = Math.max(0, Math.min(1, Number(value)));
  if (!Number.isFinite(v)) return;
  try {
    if (name === ISOBAR_LAYER_NAME && window.IsobarLayer &&
        typeof window.IsobarLayer.setOpacity === "function") {
      window.IsobarLayer.setOpacity(v);
    }
    if (window.OverlayOpacity && typeof window.OverlayOpacity.applyView === "function") {
      window.OverlayOpacity.applyView(name, v);
    }
  } catch (_) {}
}

function getMapHash() {
  if (typeof map === "undefined" || !map) return "";
  const c = map.getCenter();
  const pin = _activePinId ? `/pin=${_activePinId}` : '';
  const baseSlug = getLayerSlug(_activeBaseLayerName);
  const base = (baseSlug && baseSlug !== 'satellite') ? `/base=${baseSlug}` : '';
  // The opacity is part of the style, so a shared link must carry it:
  // `/overlay=basins@40,rivers@100`. A bare slug still parses (it means
  // 100%), so links shared before this change keep working.
  const overlaySlugs = Array.from(_activeOverlayNames)
    .map(name => {
      const slug = getLayerSlug(name);
      if (!slug) return "";
      const pct = Math.round(overlayOpacityFor(name) * 100);
      return `${slug}@${pct}`;
    })
    .filter(Boolean);
  const overlays = overlaySlugs.length > 0 ? `/overlay=${overlaySlugs.join(',')}` : '';
  // The isobar DETAIL step is part of the style too: `overlay=isobars@90`
  // says how opaque the lines are, `iso=1` says how detailed they are.
  //
  // It is written WHENEVER the isobars are on — including at the default
  // 4 hPa. Omitting it would leave the reader's OWN stored step to
  // decide, so a sender on the default would hand a receiver on 1 hPa
  // a link that opened at 1 hPa: the same map, different lines. A
  // shared link has to be exact, and the segment is eight characters.
  const isoStep = (window.IsobarLayer && typeof window.IsobarLayer.getStep === "function")
    ? window.IsobarLayer.getStep() : null;
  const isoColour = (window.IsobarLayer && typeof window.IsobarLayer.getColour === "function")
    ? window.IsobarLayer.getColour() : null;
  // WHICH ANALYSIS the lines are drawn from. Three are published side by
  // side and they are different pictures of the same atmosphere, so the
  // choice is part of the style and the link has to carry it:
  // `/isoSrc=ecmwf`.
  //
  // Written ALWAYS when the isobars are on, for the same reason as the
  // step and the colour: omitting it leaves the READER's stored choice
  // to decide, so a sender looking at ECMWF hands a receiver on GFS a
  // link that opens on GFS — the same chart, not the same picture.
  const isoSource = (window.IsobarLayer &&
    typeof window.IsobarLayer.getRequestedSource === "function")
    ? window.IsobarLayer.getRequestedSource() : null;
  const isobarsOn = _activeOverlayNames.has(ISOBAR_LAYER_NAME) ||
    (window.IsobarLayer && typeof window.IsobarLayer.isEnabled === "function" &&
      window.IsobarLayer.isEnabled());
  // `iso=<step>` or `iso=<step>:<colour>`.
  //
  // The colour is written ALWAYS, not only when it differs from the
  // default — the same reason the step is. Omitting it would leave the
  // RECEIVER's stored scheme to decide, so a sender on the published
  // key would hand a receiver on "red" a link that opened in red: the
  // same map, different lines.
  const iso = (isoStep != null && isobarsOn)
    ? (`/iso=${isoStep}` + (isoColour ? `:${isoColour}` : ""))
    : "";
  // `/isoSrc=<analysis>` — which analysis the lines are drawn from.
  const isoSrc = (isoSource && isobarsOn)
    ? `/isoSrc=${encodeURIComponent(isoSource)}`
    : "";
  // The CHANGE MAP's window: `delta=24h`.
  //
  // The change map is a DIFFERENT PICTURE of the same atmosphere from
  // the ordinary chart — the same lines, showing where the pressure ROSE
  // and where it FELL instead of where it IS. So the window travels with
  // a shared link for the same reason the step, the colour and the
  // analysis do: a link that reproduces the layer but not the window
  // hands the reader a different map.
  //
  // Written ONLY when a window is chosen. The ordinary chart is the
  // default and there is exactly one way to spell it, so a segment that
  // says "the default" can only add a way to be wrong.
  const deltaWindow = (window.IsobarLayer &&
    typeof window.IsobarLayer.getDeltaWindow === "function")
    ? window.IsobarLayer.getDeltaWindow() : null;
  const delta = (deltaWindow && isobarsOn)
    ? `/delta=${encodeURIComponent(deltaWindow)}`
    : "";
  // The wind animation's STYLE, COLOUR and DENSITY are part of the
  // style too, so they travel with a link:
  // `wind=flow:colourful:200`.
  //
  // Written ALWAYS when the wind is ON — defaults and all — which is a
  // change from the rule this used to follow ("omitted when both are
  // the default, like every other segment"). It was the same bug
  // `iso=` had: omitting leaves the READER's stored choice to decide,
  // so a sender on the default handed a reader who had once chosen
  // "particles" a map that opened in particles — the same link, a
  // different picture. Density makes it unavoidable rather than merely
  // theoretical, because a stored 300 % is now a stored 300 %.
  //
  // It is only written when the wind is actually ON: there is nothing
  // to reproduce if the layer is off.
  let wind = "";
  try {
    const WL = window.WindLayer;
    const windOn = _activeOverlayNames.has(WIND_LAYER_NAME) ||
      (WL && typeof WL.isEnabled === "function" && WL.isEnabled());
    if (windOn && WL && typeof WL.getStyle === "function") {
      const st = WL.getStyle() || WL.DEFAULT_STYLE;
      const co = (WL.getColorMode && WL.getColorMode()) || WL.DEFAULT_COLOR;
      const dn = (WL.getDensity && WL.getDensity()) || WL.DEFAULT_DENSITY;
      wind = `/wind=${st}:${co}:${Math.round(dn)}`;
    }
  } catch (_) {}
  // The 2026 FAO river network's DETAIL LEVEL: `rivers=full`.
  //
  // The level is part of the picture — "Major" and "Full detail" are
  // different maps — so a shared link has to say which one the sender
  // was looking at, for the same reason the isobar step does. It is
  // written ALWAYS when the layer is on, including at the default:
  // omitting it would leave the READER's stored choice to decide, so a
  // sender on "Full detail" would hand a receiver on "Major" a link
  // that opens at "Major" — the same river, a different network.
  let rivers = "";
  try {
    const FR = window.FaoRiversLayer;
    const faoRiversOn = FR && typeof FR.isEnabled === "function" && FR.isEnabled();
    if (faoRiversOn && FR && typeof FR.getLevel === "function") {
      const lvl = FR.getLevel();
      if (lvl) rivers = `/rivers=${encodeURIComponent(lvl)}`;
    }
  } catch (_) {}
  // Include search query in hash when search is active so links are shareable
  const search = (searchActive && searchInput && searchInput.value.trim())
    ? `/search=${encodeURIComponent(searchInput.value.trim())}` : '';
  // Include time filter so shared links preserve the time window
  const time = (timeFilter && timeFilter !== '24h') ? `/time=${timeFilter}` : '';
  // Include density so shared links preserve the pin density setting
  const density = (pinDensity && pinDensity !== 'medium') ? `/density=${pinDensity}` : '';
  return `#${c.lat.toFixed(4)},${c.lng.toFixed(4)},${map.getZoom()}${time}${density}${search}${pin}${base}${overlays}${iso}${isoSrc}${delta}${wind}${rivers}`;
}

function parseMapHash(hash) {
  if (!hash || hash.length < 2) return null;
  const clean = hash.replace(/^#/, '');
  const parts = clean.split('/');
  const res = {};

  const coordsPart = parts[0];
  if (coordsPart) {
    const coordNums = coordsPart.split(',').map(Number);
    if (coordNums.length >= 3 && coordNums.every(n => Number.isFinite(n))) {
      const [lat, lng, zoom] = coordNums;
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && zoom >= 1 && zoom <= 19) {
        res.lat = lat;
        res.lng = lng;
        res.zoom = zoom;
      }
    }
  }

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const pinMatch = p.match(/^pin=(\d+)/);
    if (pinMatch) res.pinId = Number(pinMatch[1]);

    const searchMatch = p.match(/^search=(.+)$/);
    if (searchMatch) res.search = decodeURIComponent(searchMatch[1]);

    const baseMatch = p.match(/^base=(.+)$/);
    if (baseMatch) res.base = decodeURIComponent(baseMatch[1]);

    const overlayMatch = p.match(/^overlay=(.+)$/);
    if (overlayMatch) {
      // `slug@pct` carries the opacity; a bare slug means 100%.
      res.overlays = decodeURIComponent(overlayMatch[1]).split(',').map((entry) => {
        const at = entry.lastIndexOf("@");
        if (at <= 0) return { name: entry, opacity: null };
        const pct = Number(entry.slice(at + 1));
        return {
          name: entry.slice(0, at),
          opacity: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct / 100 : null,
        };
      });
    }

    const timeMatch = p.match(/^time=(.+)$/);
    if (timeMatch) res.time = decodeURIComponent(timeMatch[1]);

    const densityMatch = p.match(/^density=(.+)$/);
    if (densityMatch) res.density = decodeURIComponent(densityMatch[1]);

    const climateMatch = p.match(/^climate=(.+)$/);
    if (climateMatch) res.climate = decodeURIComponent(climateMatch[1]) === "1";

    // The isobar detail step AND the line colour, in hPa and scheme.
    // `iso=1` means "a line every 1 hPa"; `iso=1:red` adds "in red".
    // Only the values the layer offers are accepted, so a hand-edited
    // link cannot ask for a detail or a scheme that does not exist.
    const isoMatch = p.match(/^iso=(\d+(?:\.\d+)?)(?::([a-z]+))?/);
    if (isoMatch) {
      const n = Number(isoMatch[1]);
      if (Number.isFinite(n) && n > 0) res.isoStep = n;
      if (isoMatch[2]) res.isoColour = isoMatch[2];
    }

    // Which ANALYSIS the isobars are drawn from: `isoSrc=ecmwf`.
    // Only the ids the layer offers are accepted, so a hand-edited link
    // cannot ask for an analysis that does not exist.
    const isoSrcMatch = p.match(/^isoSrc=([a-z]+)/);
    if (isoSrcMatch) res.isoSource = isoSrcMatch[1];

    // The CHANGE MAP's window: `delta=24h`.
    // Only the windows the layer offers are accepted, so a hand-edited
    // link cannot ask the archive for a window that does not exist.
    const deltaMatch = p.match(/^delta=([a-z0-9]+)/);
    if (deltaMatch) res.deltaWindow = deltaMatch[1];

    // The wind animation's STYLE, COLOUR and DENSITY:
    // `wind=flow:colourful:200`. Part of the style, so a shared link
    // reproduces the wind as it was being looked at.
    //
    // THREE fields now, and the regex has to be extended rather than
    // replaced: the old `^wind=([^:/]+)(?::([^:/]+))?$` is anchored at
    // the end, so `wind=particles:speed:200` matched NOTHING and the
    // whole segment — style, colour and all — was silently dropped.
    // That is the trap the iso= colour suffix had, one field further
    // along. The density is parsed as a NUMBER and range-checked by
    // WindLayer itself; a hand-edited `wind=…:banana` simply does not
    // set a density instead of multiplying every count by NaN.
    const windMatch = p.match(/^wind=([^:/]+)(?::([^:/]+))?(?::([^:/]+))?$/);
    if (windMatch) {
      res.wind = {};
      if (windMatch[1]) res.wind.style = decodeURIComponent(windMatch[1]);
      // `wind=particles:200` — colour omitted, density present. A
      // purely numeric second field is read as a DENSITY, not as a
      // colour, because globe-wind.js's reader already does: two
      // readers disagreeing about one link is exactly the divergence
      // the shared-grammar rule exists to prevent, and "200" is not a
      // colour any reader would accept.
      const c2 = windMatch[2] ? decodeURIComponent(windMatch[2]) : null;
      const numericSecond = c2 != null && /^\d+$/.test(c2);
      if (c2 != null && !numericSecond) res.wind.colour = c2;
      const raw = windMatch[3] != null ? windMatch[3] : (numericSecond ? c2 : null);
      if (raw != null) {
        const d = Number(raw);
        if (Number.isFinite(d)) res.wind.density = d;
      }
    }

    // The 2026 FAO river network's DETAIL LEVEL: `rivers=full`.
    // Only the levels the layer actually offers are accepted, so a
    // hand-edited link cannot ask for a detail that does not exist.
    const riversMatch = p.match(/^rivers=([a-z]+)/);
    if (riversMatch) res.riversLevel = riversMatch[1];
  }

  return Object.keys(res).length > 0 ? res : null;
}
// THE OVERLAYS CAN BE STAGED: ADDED AFTER THE MARKERS ARE PAINTED.
//
// Measured 2026-11-12 on a throttled 3G link: the pins arrived at
// t=10.6 s and the MARKERS were painted at t=30.5 s — a twenty-second
// gap. The network was not the cause: the main thread was busy decoding
// and painting the 280 tile images of the eight raster overlays the link
// asked for, and the pin canvas drew after all of them. The reader was
// looking at an empty map for twenty seconds because a URL had fifteen
// overlays on it.
//
// So the boot stages them: the basemap and the MARKERS come first, and
// the overlays are added a frame later — which is what every map does
// anyway (the overlays fill in over the basemap). The total time to
// "everything" is the same; the time to a USABLE MAP is 20 s shorter.
//
// The flag is module-level rather than an argument so that the boot call
// site keeps its exact shape (the tests anchor on it).
let _deferOverlayAdds = false;
const _deferredOverlayAdds = [];

/** Add the overlays that were staged at the boot. */
function flushDeferredOverlays() {
  if (!_deferredOverlayAdds.length) return;
  const pending = _deferredOverlayAdds.splice(0, _deferredOverlayAdds.length);
  for (const item of pending) {
    const layer = WEATHER_OVERLAYS && WEATHER_OVERLAYS[item.name];
    if (!layer) continue;
    try {
      if (!map.hasLayer(layer)) layer.addTo(map);
      if (item.opacity != null) applyOverlayOpacity(item.name, item.opacity);
    } catch (e) {
      XLog.warn("deferred overlay failed:", e);
    }
  }
}

function applyLayersFromParsedHash(parsed) {
  if (!parsed || typeof TILE_LAYERS === "undefined" || typeof map === "undefined") return;

  // Apply Base Layer if specified
  if (parsed.base) {
    const baseName = resolveLayerName(parsed.base);
    if (baseName && TILE_LAYERS[baseName] && baseName !== _activeBaseLayerName) {
      for (const key of Object.keys(TILE_LAYERS)) {
        if (map.hasLayer(TILE_LAYERS[key])) map.removeLayer(TILE_LAYERS[key]);
      }
      TILE_LAYERS[baseName].addTo(map);
      _activeBaseLayerName = baseName;
    } else if (!baseName || !TILE_LAYERS[baseName]) {
      // Fallback to Street if requested layer doesn't exist
      if (_activeBaseLayerName !== "Street") {
        for (const key of Object.keys(TILE_LAYERS)) {
          if (map.hasLayer(TILE_LAYERS[key])) map.removeLayer(TILE_LAYERS[key]);
        }
        TILE_LAYERS["🗺️ Street"].addTo(map);
        _activeBaseLayerName = "Street";
      }
    }
  }

  // Apply Weather Overlays if specified. Each entry is {name, opacity};
  // the opacity comes from the shared link and must be applied to the
  // layer AND to the slider, or the map and the number disagree.
  if (parsed.overlays && Array.isArray(parsed.overlays) && typeof WEATHER_OVERLAYS !== "undefined") {
    for (const ov of parsed.overlays) {
      const entry = typeof ov === "string" ? { name: ov, opacity: null } : ov;
      const ovName = resolveLayerName(entry.name);
      if (ovName && WEATHER_OVERLAYS[ovName]) {
        // Always record the name — even if a module's init already put
        // the layer on the map from localStorage. Skipping this when
        // hasLayer was true meant the next hash rewrite dropped the
        // overlay (the "reload erases magnetic" bug of 2026-10-28).
        _activeOverlayNames.add(ovName);
        if (_deferOverlayAdds) {
          // STAGED: the name is recorded now (so the hash rewrite is
          // unchanged) but the layer is added after the markers are
          // painted. See flushDeferredOverlays() above.
          _deferredOverlayAdds.push({ name: ovName, opacity: entry.opacity });
          continue;
        }
        if (!map.hasLayer(WEATHER_OVERLAYS[ovName])) {
          WEATHER_OVERLAYS[ovName].addTo(map);
        }
        if (entry.opacity != null) {
          applyOverlayOpacity(ovName, entry.opacity);
        }
      }
    }
  }

  // The wind animation's STYLE, COLOUR and DENSITY. Applied before
  // anything else here, because the layer owns all three and the
  // reader's link says what they were looking at.
  //
  // setDensity() persists, so opening a friend's link would normally
  // overwrite the reader's own density — but _restoreMapView()
  // snapshots every xyzo.* preference before calling this and puts any
  // that moved back afterwards ("a LINK IS A VIEW, NOT A SETTINGS
  // CHANGE"), exactly as it already does for the style and colour.
  if (parsed.wind && typeof parsed.wind === "object" && window.WindLayer) {
    try {
      if (parsed.wind.style && typeof window.WindLayer.setStyle === "function") {
        window.WindLayer.setStyle(parsed.wind.style);
      }
      if (parsed.wind.colour && typeof window.WindLayer.setColorMode === "function") {
        window.WindLayer.setColorMode(parsed.wind.colour);
      }
      if (parsed.wind.density != null &&
          typeof window.WindLayer.setDensity === "function") {
        window.WindLayer.setDensity(parsed.wind.density);
      }
    } catch (_) {}
  }

  // The 2026 FAO rivers' DETAIL LEVEL. A link is a VIEW: the level the
  // sender was looking at goes on the map, and the reader's own stored
  // preference is NOT overwritten — the same rule every layer preference
  // follows at boot.
  if (parsed.riversLevel && window.FaoRiversLayer &&
      typeof window.FaoRiversLayer.setLevel === "function") {
    try {
      window.FaoRiversLayer.setLevel(parsed.riversLevel, { persist: false });
    } catch (_) {}
  }

  // The isobar layer is not a registered overlay, so it is handled here.
  if (parsed.overlays && Array.isArray(parsed.overlays)) {
    for (const ov of parsed.overlays) {
      const entry = typeof ov === "string" ? { name: ov, opacity: null } : ov;
      if (resolveLayerName(entry.name) !== ISOBAR_LAYER_NAME) continue;
      if (window.IsobarLayer && typeof window.IsobarLayer.setEnabled === "function") {
        // The DETAIL step and the COLOUR first, then the layer.
        // `setStep()` only refetches when the layer is already on, so
        // applying both first and enabling second costs ONE fetch
        // instead of two — and it is the fetch that carries the right
        // step.
        //
        // `persist: false`: a link is a VIEW, not a settings change.
        // The reader's own stored detail and scheme must survive
        // opening someone else's map, exactly like every other layer
        // preference at boot.
        if (parsed.isoStep != null &&
            typeof window.IsobarLayer.setStep === "function") {
          window.IsobarLayer.setStep(parsed.isoStep, { persist: false });
        }
        if (parsed.isoColour && typeof window.IsobarLayer.setColour === "function") {
          window.IsobarLayer.setColour(parsed.isoColour, { persist: false });
        }
        // The ANALYSIS first, for the same reason: it is the fetch that
        // has to carry it, so it is applied before the layer is enabled.
        if (parsed.isoSource && typeof window.IsobarLayer.setSource === "function") {
          window.IsobarLayer.setSource(parsed.isoSource, { persist: false });
        }
        // And the CHANGE window — the third question about this layer
        // ("over what period?"). It decides WHAT the fetch asks for, so
        // it is applied before the layer is enabled, exactly like the
        // step and the analysis.
        //
        // `persist: false`: a link is a VIEW, not a settings change. The
        // reader's own stored window must survive opening someone
        // else's map.
        if (parsed.deltaWindow &&
            typeof window.IsobarLayer.setDeltaWindow === "function") {
          window.IsobarLayer.setDeltaWindow(parsed.deltaWindow, { persist: false });
        }
        window.IsobarLayer.setEnabled(true);
        _activeOverlayNames.add(ISOBAR_LAYER_NAME);
        if (typeof window.__syncIsobarToggle === "function") window.__syncIsobarToggle();
        if (entry.opacity != null) {
          applyOverlayOpacity(ISOBAR_LAYER_NAME, entry.opacity);
        }
      }
      break;
    }
  }

  // Apply the Koppen climate overlay if requested. "/climate=1" is an
  // alias for "/overlay=koppen" kept for links shared before the overlay
  // moved into the layers control.
  if (parsed.climate) {
    const climateName = resolveLayerName("koppen");
    if (climateName && WEATHER_OVERLAYS[climateName] && !map.hasLayer(WEATHER_OVERLAYS[climateName])) {
      WEATHER_OVERLAYS[climateName].addTo(map);
      _activeOverlayNames.add(climateName);
    }
  }
}

// ── Saved styles ("MY STYLE") ─────────────────────────────────────────
// One click saves the current view — position, zoom, base layer and
// every overlay with its opacity — and one click brings it back.
// Owner spec 2026-10-29: elderly users wanted a "I like this style"
// button instead of re-dialling layers by hand on every visit.
const SAVED_STYLES_KEY = "xyzo.savedStyles";
const SAVED_STYLES_MAX = 8;

function loadSavedStyles() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_STYLES_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}

function saveSavedStyles(list) {
  try {
    localStorage.setItem(SAVED_STYLES_KEY, JSON.stringify(list.slice(0, SAVED_STYLES_MAX)));
  } catch (_) {}
}

function captureStyle() {
  const c = map.getCenter();
  const overlays = [];
  for (const name of _activeOverlayNames) {
    const slug = getLayerSlug(name);
    if (!slug) continue;
    overlays.push({ slug, pct: Math.round(overlayOpacityFor(name) * 100) });
  }
  return {
    id: "st" + Date.now() + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    lat: Number(c.lat.toFixed(4)),
    lng: Number(c.lng.toFixed(4)),
    zoom: map.getZoom(),
    base: getLayerSlug(_activeBaseLayerName) || "satellite",
    overlays,
    // The isobar detail step, so a saved style is the EXACT map and not
    // the same layers at a different density. It is the one setting of
    // the isobar layer that is not an opacity.
    isoStep: (window.IsobarLayer && typeof window.IsobarLayer.getStep === "function")
      ? window.IsobarLayer.getStep() : null,
    isoColour: (window.IsobarLayer && typeof window.IsobarLayer.getColour === "function")
      ? window.IsobarLayer.getColour() : null,
    // And WHICH analysis the lines are drawn from — the same reason: a
    // saved style is the EXACT picture, and ECMWF's lines and GFS's
    // lines are different pictures of the same atmosphere.
    isoSource: (window.IsobarLayer &&
      typeof window.IsobarLayer.getRequestedSource === "function")
      ? window.IsobarLayer.getRequestedSource() : null,
    // And the CHANGE window — the same reason: the ordinary chart and
    // the change map are different pictures of the atmosphere.
    deltaWindow: (window.IsobarLayer &&
      typeof window.IsobarLayer.getDeltaWindow === "function")
      ? window.IsobarLayer.getDeltaWindow() : null,
    // The wind's style and colour, for the same reason.
    wind: (window.WindLayer && typeof window.WindLayer.getStyle === "function")
      ? {
        style: window.WindLayer.getStyle(),
        colour: window.WindLayer.getColorMode ? window.WindLayer.getColorMode() : null,
      }
      : null,
    // And the 2026 FAO rivers' DETAIL LEVEL — for the same reason: the
    // great rivers and the full network are different pictures.
    riversLevel: (window.FaoRiversLayer &&
      typeof window.FaoRiversLayer.getLevel === "function")
      ? window.FaoRiversLayer.getLevel() : null,
  };
}

function applySavedStyle(style) {
  if (!style || typeof map === "undefined") return;
  // 1. The view.
  if (Number.isFinite(style.lat) && Number.isFinite(style.lng) &&
      Number.isFinite(style.zoom)) {
    map.setView([style.lat, style.lng], style.zoom, { animate: false });
  }
  // 2. Remove every active overlay the style does NOT contain — the
  //    hash-apply path below only ADDS, so the two halves together
  //    make the map match the snapshot exactly.
  const keep = new Set();
  for (const ov of (style.overlays || [])) {
    const name = resolveLayerName(ov.slug);
    if (name) keep.add(name);
  }
  for (const name of Array.from(_activeOverlayNames)) {
    if (keep.has(name)) continue;
    if (name === ISOBAR_LAYER_NAME) {
      if (window.IsobarLayer && typeof window.IsobarLayer.setEnabled === "function") {
        window.IsobarLayer.setEnabled(false);
        if (typeof window.__syncIsobarToggle === "function") window.__syncIsobarToggle();
      }
      _activeOverlayNames.delete(name);
      continue;
    }
    const layer = (typeof WEATHER_OVERLAYS !== "undefined") ? WEATHER_OVERLAYS[name] : null;
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    _activeOverlayNames.delete(name);
  }
  // 3. Base layer + adds + opacity — the SAME path a shared link uses,
  //    so a saved style and a pasted URL can never diverge.
  applyLayersFromParsedHash({
    base: style.base || undefined,
    overlays: (style.overlays || []).map((ov) => ({
      name: ov.slug,
      opacity: ov.pct != null ? ov.pct / 100 : null,
    })),
    isoStep: style.isoStep != null ? style.isoStep : undefined,
    isoColour: style.isoColour || undefined,
    isoSource: style.isoSource || undefined,
    deltaWindow: style.deltaWindow || undefined,
    wind: style.wind || undefined,
    riversLevel: style.riversLevel || undefined,
  });
}

// ── Full map state: presets, ⭐ default, last-used ────────────────────
// captureStyle() is the saved-styles snapshot; captureMapState() is the
// same view of the map PLUS pin density — the unit that a preset, the
// user's saved default and the auto-saved last-used state all speak.
// applyMapState() applies one, through the saved-style path for the
// layer half, so every restore route stays one route.
function captureMapState() {
  const s = captureStyle();
  return {
    v: 1,
    ts: Date.now(),
    lat: s.lat,
    lng: s.lng,
    zoom: s.zoom,
    base: s.base,
    overlays: s.overlays,
    density: (typeof pinDensity === "string" && pinDensity) || "medium",
    isoStep: s.isoStep,
    isoColour: s.isoColour,
    isoSource: s.isoSource,
    deltaWindow: s.deltaWindow,
    wind: s.wind,
    riversLevel: s.riversLevel,
  };
}

// opts.keepView — apply the layers/base/density but leave the camera
// alone (the "Clear" button must not fling the user back to the world).
function applyMapState(state, opts) {
  if (!state || typeof map === "undefined" || typeof map.setView !== "function") return false;
  const keepView = !!(opts && opts.keepView);
  if (!keepView && Number.isFinite(state.lat) && Number.isFinite(state.lng) &&
      Number.isFinite(state.zoom)) {
    map.setView([state.lat, state.lng], state.zoom, { animate: false });
  }
  // The removal half comes from applySavedStyle: it drops every active
  // overlay the state does not contain, then re-adds through the
  // shared-link path. Without the removal half a "clear" would not
  // survive a layer module that restores itself from its own key.
  try {
    applySavedStyle({
      base: state.base || undefined,
      overlays: (state.overlays || []).map((ov) => ({
        slug: ov.slug,
        pct: Number.isFinite(ov.pct) ? ov.pct : null,
      })),
      isoStep: state.isoStep != null ? state.isoStep : undefined,
      isoColour: state.isoColour || undefined,
      isoSource: state.isoSource || undefined,
      deltaWindow: state.deltaWindow || undefined,
      wind: state.wind || undefined,
      riversLevel: state.riversLevel || undefined,
    });
  } catch (_) { return false; }
  if (state.density && typeof PIN_DENSITY_MAP !== "undefined" && PIN_DENSITY_MAP[state.density]) {
    pinDensity = state.density;
    try { localStorage.setItem(PIN_DENSITY_STORAGE_KEY, pinDensity); } catch (_) {}
    const label = document.getElementById("density-dropdown-label");
    const labelMap = { low: "Low", medium: "Medium", high: "High", max: "Max" };
    if (label) label.textContent = labelMap[pinDensity] || "Medium";
    for (const b of document.querySelectorAll(".density-picker button[data-density]")) {
      b.classList.toggle("active", b.getAttribute("data-density") === pinDensity);
    }
  }
  try { updateUrlHash(); } catch (_) {}
  return true;
}

function styleLabel(s) {
  const d = new Date(s.ts);
  const date = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const n = (s.overlays || []).length;
  return date + " " + time + " · " + n + " overlay" + (n === 1 ? "" : "s");
}

function renderSavedStyles() {
  const host = document.getElementById("saved-styles-list");
  if (!host) return;
  const list = loadSavedStyles();
  host.innerHTML = "";
  if (!list.length) {
    host.innerHTML = '<div class="saved-styles-empty">No saved styles yet</div>';
    return;
  }
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "saved-style-row";
    const load = document.createElement("button");
    load.type = "button";
    load.className = "saved-style-load";
    load.textContent = styleLabel(s);
    load.title = "Load this style";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "saved-style-del";
    del.textContent = "×";
    del.setAttribute("aria-label", "Delete style");
    del.title = "Delete";
    load.addEventListener("click", () => {
      applySavedStyle(s);
      // Close the control menu so the restored map is visible.
      const menu = document.getElementById("control-menu");
      const btn = document.getElementById("control-menu-btn");
      if (menu) menu.style.display = "none";
      if (btn) btn.setAttribute("aria-expanded", "false");
    });
    del.addEventListener("click", () => {
      saveSavedStyles(loadSavedStyles().filter((x) => x.id !== s.id));
      renderSavedStyles();
    });
    row.appendChild(load);
    row.appendChild(del);
    host.appendChild(row);
  }
}

// Open the popup for a specific pin ID (e.g. from a shared #lat,lng,z/pin=ID URL).
let _openPinTimer = null;
let _pendingPopupPinId = null; // Store pinId if marker not found yet
let _pendingPopupAttempts = 0;
const PENDING_POPUP_MAX_ATTEMPTS = 40;   // 40 × 400 ms ≈ 16 s
const PENDING_POPUP_RETRY_MS = 400;

function findMarkerById(pinId) {
  // Both maps are keyed by the numeric id, but the id can arrive as a
  // string (from a URL hash). Look it up both ways — `eventMarkers.get(
  // String(id))` never matched, so a shared link to an EVENT marker
  // could not open its popup at all.
  const n = Number(pinId);
  return pinMarkers.get(pinId) || pinMarkers.get(n) ||
         eventMarkers.get(pinId) || eventMarkers.get(n) || null;
}

function openPinPopup(pinId) {
  if (!pinId || typeof map === "undefined") return;
  if (_openPinTimer) { clearTimeout(_openPinTimer); _openPinTimer = null; }
  const marker = findMarkerById(pinId);
  if (!marker) {
    // The marker is not loaded yet. A shared link restores the search
    // first, and the search takes a few seconds — one 500 ms retry was
    // not nearly enough, so the popup never opened.
    _pendingPopupPinId = Number(pinId) || pinId;
    if (_pendingPopupAttempts >= PENDING_POPUP_MAX_ATTEMPTS) {
      _pendingPopupPinId = null;
      _pendingPopupAttempts = 0;
      return;
    }
    _pendingPopupAttempts++;
    _openPinTimer = setTimeout(() => {
      _openPinTimer = null;
      if (_pendingPopupPinId) {
        const retryMarker = findMarkerById(_pendingPopupPinId);
        if (retryMarker) {
          const p = _pendingPopupPinId;
          _pendingPopupPinId = null;
          _pendingPopupAttempts = 0;
          openPinPopup(p);
        } else {
          openPinPopup(_pendingPopupPinId);   // keep waiting
        }
      }
    }, PENDING_POPUP_RETRY_MS);
    return;
  }
  _pendingPopupPinId = null;
  _pendingPopupAttempts = 0;
  // Set _activePinId immediately so URL hash includes it
  _activePinId = Number(pinId) || pinId;
  try { if (typeof updateUrlHash === "function") updateUrlHash(); } catch (_) {}
  setSelectedPin(pinId, marker._xyzoEventId || pinId);
  if (marker.isPopupOpen()) { return; }
  if (_popupIsOpen) { return; }
  map.panTo(marker.getLatLng(), { animate: true, duration: 0.4 });
  // Open ONCE THE MAP HAS SETTLED on a touch device.
  //
  // The popup is anchored to the pin, so if it opens while the pan is
  // still running it slides for the rest of the animation (~400 ms of pan
  // plus whatever autoPan adds). A tap aimed at the ✕ then lands on
  // whatever moved into that spot — the pin canvas, behind it. That is
  // the intermittent "the close button doesn't work on mobile": it works
  // on a still popup and fails on a moving one. Waiting for moveend
  // removes the moving target entirely. Desktop keeps the old 150 ms —
  // there is no finger on the screen and an instant popup feels snappier.
  const settleStarted = Date.now();
  const openIt = () => {
    if (_openPinTimer) { clearTimeout(_openPinTimer); _openPinTimer = null; }
    map.off("moveend", openIt);
    // Still moving? A movement can END and another BEGIN in the same
    // tick — a tap starts a pan and then a flyToBounds, and stopping the
    // pan fires a moveend of its own. The fallback is a BOUND, not a
    // deadline: a 700 ms flight is LONGER than the 600 ms coarse-pointer
    // wait, so a fallback that simply fired would open the popup 600 ms
    // INTO the flight. It re-arms while the map is still moving.
    if (_mapIsMoving && Date.now() - settleStarted < POPUP_SETTLE_MAX_WAIT_MS) {
      _openPinTimer = setTimeout(openIt, isCoarsePointer() ? 600 : 150);
      return;
    }
    if (!marker.isPopupOpen() && !_popupIsOpen) {
      marker.openPopup();
    }
  };
  map.once("moveend", openIt);
  _openPinTimer = setTimeout(openIt, isCoarsePointer() ? 600 : 150);
}
function updateUrlHash() {
  // Don't overwrite a shared link's position before the map has restored it.
  if (!_mapViewRestored) return;
  try {
    const hash = getMapHash();
    if (hash && window.location.hash !== hash) {
      history.replaceState(null, '', hash);
    }
  } catch (_) {}
  // Every state change rewrites the hash (move, layers, opacity,
  // density), so this is the one place the "what opens next visit"
  // auto-save can hook. Debounced inside; a no-op before boot.
  try { scheduleMapStateSave(); } catch (_) {}
}

// Auto-save the map the user is actually using, so the next visit can
// open with it (MapPresets.bootPlan() reads it back). Debounced: a pan
// fires moveend, an opacity drag fires per pixel. Flushed on pagehide —
// a tab closed inside the debounce window must not keep yesterday's
// state. Defined here (not next to its listeners) because updateUrlHash
// calls it by name and function declarations hoist over the whole file.
let _mapStateTimer = null;
function scheduleMapStateSave() {
  if (typeof window === "undefined" || !window.MapPresets) return;
  if (!_mapViewRestored) return;
  if (_mapStateTimer) clearTimeout(_mapStateTimer);
  _mapStateTimer = setTimeout(() => {
    _mapStateTimer = null;
    try { window.MapPresets.autoSave(captureMapState()); } catch (_) {}
  }, 1200);
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    try {
      if (window.MapPresets && _mapViewRestored) {
        window.MapPresets.autoSave(captureMapState());
      }
    } catch (_) {}
  });
}

// ── Globe Control ───────────────────────────────────────────────────────
// Appends a "zoom to whole earth" button underneath the +/− buttons so it
// reads as part of the same leaflet-bar and inherits its styling.
(function initGlobeControl() {
  const bar = map.zoomControl && map.zoomControl.getContainer();
  if (!bar) return;

  const btn = L.DomUtil.create("a", "leaflet-control-zoom-world", bar);
  btn.href = "#";
  btn.title = "Zoom out to the whole world";
  btn.setAttribute("role", "button");
  btn.setAttribute("aria-label", "Zoom out to the whole world");
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9"/>' +
    '<path d="M3 12h18"/>' +
    '<path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/>' +
    "</svg>";

  L.DomEvent.on(btn, "click", (e) => {
    L.DomEvent.stop(e);
    map.setView(WORLD_VIEW.center, WORLD_VIEW.zoom, { animate: true });
  });
  L.DomEvent.disableClickPropagation(btn);

  // A link to the 3D globe (globe.html — a MapLibre view with the same
  // overlays and the same pins). The globe is a separate view on purpose:
  // the flat map is Leaflet and stays Leaflet.
  const globe = L.DomUtil.create("a", "leaflet-control-zoom-world", bar);
  globe.href = "/globe";
  globe.target = "_blank";
  globe.rel = "noopener";
  globe.title = "Open the 3D globe";
  globe.setAttribute("role", "button");
  globe.setAttribute("aria-label", "Open the 3D globe");
  // A ringed planet — reads as "3D / space" at a glance and is instantly
  // distinct from the flat-map globe button above it.
  globe.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="6"/>' +
    '<ellipse cx="12" cy="12" rx="10.5" ry="4" transform="rotate(-25 12 12)"/>' +
    "</svg>";
  L.DomEvent.disableClickPropagation(globe);

  // Hand the CURRENT view to the globe — position, every overlay and its
  // opacity — instead of a bare href that dropped all of it (there was no
  // bridge at all before: the globe opened at its boot view with every
  // layer off, and a shared 3D link carried nothing).
  //
  // Built at CLICK time, not here: the overlays a user ticks do not exist
  // yet when this control is created, and getMapHash() reads the LIVE
  // active set. Rebuilding on pointerdown as well means a keyboard or
  // touch activation (which may not fire a separate click before
  // navigation) still gets a current href.
  const syncGlobeHref = () => {
    try {
      globe.href =
        window.XYZO_HANDOFF && typeof window.XYZO_HANDOFF.globeHref === "function"
          ? window.XYZO_HANDOFF.globeHref(getMapHash())
          : "/globe";
    } catch (_) {
      globe.href = "/globe";
    }
  };
  globe.addEventListener("pointerdown", syncGlobeHref);
  globe.addEventListener("click", syncGlobeHref);

  // --panel-top (which anchors the live panel and the reopen button)
  // reserves --zoom-stack px below the zoom corner. That value was a
  // hand-tuned 3-button height; the bar now has four buttons (zoom
  // in/out, world view, 3D globe) and the 3D globe was sliding under
  // the live panel. Measure the real bar so the reserve is always right.
  const syncZoomStack = () => {
    const h = bar.offsetHeight;
    if (h > 0) {
      document.documentElement.style.setProperty("--zoom-stack", `${Math.round(h) + 10}px`);
    }
  };
  syncZoomStack();
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(syncZoomStack).observe(bar);
  window.addEventListener("resize", syncZoomStack);
})();

// ── Control-Stack Metrics ───────────────────────────────────────────────
// Every overlay on the map is anchored below --top-band (see styles.css).
// Measure the real bottom edge of the control stack rather than trusting a
// hard-coded height, so the layout stays correct when labels reflow, fonts
// finish loading, or the viewport changes. The CSS values are the fallback
// when ResizeObserver isn't available.
(function trackControlBand() {
  const stack = document.getElementById("map-controls");
  if (!stack) return;

  const sync = () => {
    const bottom = stack.getBoundingClientRect().bottom;
    if (bottom > 0) {
      document.documentElement.style.setProperty("--top-band", `${Math.round(bottom) + 10}px`);
    }
  };

  // How much of the TOP of the map is covered by chrome the map itself
  // does not know about — the search pill, above the control stack.
  // --top-band only measures the control stack, so an overlay anchored to
  // it (the system-wide error banner) slid under the search pill and over
  // any popup whose ✕ sat in the top ~170 px of the screen. Measured, not
  // guessed: the pill's height depends on the text-size zoom and on
  // whether a suggestion list is open under it.
  const syncTopChrome = () => {
    const bar = document.getElementById("search-bar");
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    if (r.height > 0 && r.top >= 0) {
      document.documentElement.style.setProperty(
        "--map-top-chrome", `${Math.round(r.height)}px`);
    }
  };

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(sync).observe(stack);
    const bar = document.getElementById("search-bar");
    if (bar) new ResizeObserver(syncTopChrome).observe(bar);
  }
  window.addEventListener("resize", sync);
  window.addEventListener("resize", syncTopChrome);
  window.addEventListener("orientationchange", sync);
  window.addEventListener("orientationchange", syncTopChrome);
  sync();
  syncTopChrome();
  // The pill grows once i18n labels land; re-measure once they have.
  setTimeout(syncTopChrome, 1500);
})();

// Save map position/zoom on every moveend to both localStorage and URL.
map.on("moveend", () => {
  try {
    const c = map.getCenter();
    localStorage.setItem("xyzo-map-view", JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
    updateUrlHash();
  } catch (_) {}
});

// ── Journalist Profile ──────────────────────────────────────────────
async function openJournalistProfile(journalistId) {
  try {
    const res = await fetch(`/api/journalists/${journalistId}`);
    if (!res.ok) {
      showStatus(`Journalist not found`);
      return;
    }
    const j = await res.json();
    const topicList = j.topics?.length ? j.topics.join(", ") : "No topics";
    const locationStr = j.location?.city ? `${j.location.city}, ${j.location.country || ""}` : (j.location?.country || "Unknown location");
    const orgStr = j.organization?.name || j.organization || "";
    const articleCount = j.article_count || 0;
    const bio = j.bio || "No biography available.";
    const profileContent = `
      <div class="journalist-profile">
        <div class="journalist-profile-header">
          <div class="journalist-avatar">${escapeHtml(j.name).charAt(0)}</div>
          <div class="journalist-profile-info">
            <h2 class="journalist-profile-name">${escapeHtml(j.name)}</h2>
            <p class="journalist-profile-meta">${escapeHtml(j.journalist_type)} ${j.employment_status ? "· " + escapeHtml(j.employment_status) : ""}</p>
          </div>
          <button class="journalist-profile-close" onclick="closeJournalistProfile()" aria-label="Close">✕</button>
        </div>
        <div class="journalist-profile-body">
          ${orgStr ? `<p class="journalist-profile-org">${escapeHtml(orgStr)}</p>` : ""}
          <p class="journalist-profile-location">📍 ${escapeHtml(locationStr)}</p>
          <p class="journalist-profile-counts">📰 ${articleCount} article${articleCount === 1 ? "" : "s"} tracked</p>
          <p class="journalist-profile-topics">🏷️ ${escapeHtml(topicList)}</p>
          <div class="journalist-profile-bio">${escapeHtml(bio.substring(0, 300))}${bio.length > 300 ? "…" : ""}</div>
          ${j.contact?.profile_url && safeHttpUrl(j.contact.profile_url) ? `<a href="${escapeAttr(safeHttpUrl(j.contact.profile_url))}" target="_blank" rel="noopener noreferrer" class="journalist-profile-link">View author profile →</a>` : ""}
        </div>
      </div>
    `;
    showStatus(profileContent);
  } catch (e) {
    XLog.warn("openJournalistProfile", e);
    showStatus(`Failed to load journalist profile`);
  }
}

function closeJournalistProfile() {
  history.pushState(null, "", window.location.pathname + window.location.search);
  showStatus("");
}

// ── Listen for hash changes (e.g., back/forward navigation)
window.addEventListener('hashchange', () => {
  const hash = window.location.hash;
  // Handle journalist profile route: #journalist/:id
  const journoMatch = hash.match(/^#journalist\/(\d+)/);
  if (journoMatch) {
    openJournalistProfile(journoMatch[1]);
    return;
  }
  const hashView = parseMapHash(hash);
  if (hashView) {
    const current = map.getCenter();
    const currentZoom = map.getZoom();
    // Only update if significantly different to avoid loops
    if (Math.abs(current.lat - hashView.lat) > 0.001 ||
        Math.abs(current.lng - hashView.lng) > 0.001 ||
        Math.abs(currentZoom - hashView.zoom) > 0.1) {
      map.setView([hashView.lat, hashView.lng], hashView.zoom);
    }
    // Open pin popup if hash has pin=ID
    if (hashView.pinId && hashView.pinId !== _activePinId) {
      openPinPopup(hashView.pinId);
    }
    // Apply the Koppen climate overlay if the shared link asks for it
    // (a pasted "#lat,lng,zoom/climate=1" is a same-document navigation,
    // so the boot-time restore never runs).
    if (hashView.climate) {
      const climateName = resolveLayerName("koppen");
      if (climateName && typeof WEATHER_OVERLAYS !== "undefined" && WEATHER_OVERLAYS[climateName] &&
          !map.hasLayer(WEATHER_OVERLAYS[climateName])) {
        WEATHER_OVERLAYS[climateName].addTo(map);
        _activeOverlayNames.add(climateName);
      }
    }
    // Same for the isobar layer ("/overlay=isobars").
    if (hashView.overlays && Array.isArray(hashView.overlays)) {
      for (const ov of hashView.overlays) {
        const entry = typeof ov === "string" ? { name: ov, opacity: null } : ov;
        if (resolveLayerName(entry.name) !== ISOBAR_LAYER_NAME) continue;
        if (window.IsobarLayer && typeof window.IsobarLayer.setEnabled === "function") {
          // The isobar layer's own SETTINGS, applied before it is
          // enabled — the same order the boot path uses, and for the same
          // reason: the fetch has to carry them.
          //
          // A pasted link is a SAME-DOCUMENT navigation, so the boot-time
          // restore never runs and this handler is the only thing that
          // applies them. Without it the address bar would promise a
          // picture the map is not drawing ("/iso=0.25:red/delta=24h"
          // showing the ordinary chart in the default ink).
          //
          // `persist: false` on each: a link is a VIEW, not a settings
          // change.
          if (hashView.isoStep != null &&
              typeof window.IsobarLayer.setStep === "function") {
            window.IsobarLayer.setStep(hashView.isoStep, { persist: false });
          }
          if (hashView.isoColour &&
              typeof window.IsobarLayer.setColour === "function") {
            window.IsobarLayer.setColour(hashView.isoColour, { persist: false });
          }
          if (hashView.isoSource &&
              typeof window.IsobarLayer.setSource === "function") {
            window.IsobarLayer.setSource(hashView.isoSource, { persist: false });
          }
          if (hashView.deltaWindow &&
              typeof window.IsobarLayer.setDeltaWindow === "function") {
            window.IsobarLayer.setDeltaWindow(hashView.deltaWindow, { persist: false });
          }
          window.IsobarLayer.setEnabled(true);
          _activeOverlayNames.add(ISOBAR_LAYER_NAME);
          if (typeof window.__syncIsobarToggle === "function") window.__syncIsobarToggle();
          if (entry.opacity != null) {
            applyOverlayOpacity(ISOBAR_LAYER_NAME, entry.opacity);
          }
        }
        break;
      }
    }
  }
});

// ── Share Button ────────────────────────────────────────────────────────
// Copies the current map URL to clipboard with visual feedback.
(function initShareButton() {
  const shareBtn = document.getElementById('share-btn');
  if (!shareBtn) return;

  shareBtn.addEventListener('click', async () => {
    const url = window.location.href;

    try {
      await navigator.clipboard.writeText(url);
      shareBtn.classList.add('copied');
      shareBtn.textContent = '✓ Copied!';

      setTimeout(() => {
        shareBtn.classList.remove('copied');
        shareBtn.textContent = 'Share';
      }, 2000);
    } catch (e) {
      // Fallback for older browsers
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);

      shareBtn.classList.add('copied');
      shareBtn.textContent = '✓ Copied!';

      setTimeout(() => {
        shareBtn.classList.remove('copied');
        shareBtn.textContent = 'Share';
      }, 2000);
    }
  });
})();

// ── Live Status Footer ───────────────────────────────────────────────
//
// Polls /api/ai-status and /api/sysload periodically and renders one
// consolidated line inside the live-panel footer (always visible when
// the panel is open). Replaces both the previous body-level banner
// and the nav-bar pill with a single, in-context surface.
const AIStatus = {
  _el: null,
  _timer: null,
  _sysload: null,
  _lastLatency: null,

  async check() {
    try {
      const t0 = Date.now();
      const [aiRes, sysRes] = await Promise.all([
        fetch("/api/ai-status"),
        fetch("/api/sysload").catch(() => null),
      ]);
      const latency = Date.now() - t0;
      this._lastLatency = latency;

      if (!aiRes.ok) return;
      const ai = await aiRes.json();
      if (sysRes && sysRes.ok) {
        this._sysload = await sysRes.json();
      }
      this._render(ai, latency);
    } catch (_) { /* silent — don't pester users with network errors */ }
  },

  start() {
    if (this._timer) return;
    this._el = document.getElementById("live-panel-status");
    if (this._el) {
      this._el.textContent = "Loading status…";
      this._el.className = "live-panel-status live-panel-status--ok";
    }
    this.check();
    // Re-check every 30s. Cheap endpoint (no AI call) so this is fine.
    this._timer = setInterval(() => this.check(), 30_000);
  },

  _render(ai, latencyMs) {
    if (!this._el) return;
    const gpu = this._sysload?.gpu;
    const cpu = this._sysload?.cpu;
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

    let state, line, title;

    if (!ai.healthy) {
      const sec = Math.max(1, Math.round((ai.retry_after_ms || 0) / 1000));
      state = "down";
      line = `⚠ AI DOWN — heuristic fallback · retry ~${sec}s`;
      title = `Circuit breaker open · retry in ${sec}s · p50 ${latencyMs}ms · ${timeStr}`;
    } else if (gpu && gpu.busy) {
      state = "gpu-busy";
      line = `⏳ GPU busy (${gpu.util_pct}% util, ${gpu.mem_pct}% mem) — using fast text parsing`;
      title = `GPU busy · ${gpu.util_pct}% util · ${gpu.mem_pct}% mem · ${gpu.temp_c}°C · p50 ${latencyMs}ms · ${timeStr}`;
    } else {
      state = "ok";
      const parts = ["AI OK", `p50 ${latencyMs}ms`];
      if (gpu?.available) parts.push(`GPU ${gpu.util_pct}%`);
      if (cpu) parts.push(`CPU ${Math.round(100 - cpu.idle_pct)}%`);
      line = parts.join(" · ");
      title = `${line} · ${timeStr}`;
    }

    this._el.className = `live-panel-status live-panel-status--${state}`;
    this._el.textContent = line;
    this._el.title = title;
  },
};
AIStatus.start();

// ── Analytics Integration ──────────────────────────────────────────────
// Track map movements for geographic interest analysis
if (typeof XyzoAnalytics !== 'undefined') {
  map.on("moveend", () => XyzoAnalytics.onMapMove());
  XyzoAnalytics.markMapReady();
}

// ── Location View Tracking ──────────────────────────────────────────────
// Tracks which cities/areas users are viewing on the map.
// Uses client-side city detection (no AI) to minimize server load.
// Batches views and sends them periodically to reduce API calls.

const LocationTracker = {
  // City database for client-side lookup (major cities with coordinates)
  // This is a subset - the full database is on the server
  CITIES: new Map(),
  
  // View tracking state
  currentView: null,
  viewStartTime: null,
  viewQueue: [],
  flushTimer: null,
  
  // Configuration
  FLUSH_INTERVAL: 30000,  // Flush every 30 seconds
  MIN_VIEW_DURATION: 2000, // Minimum 2 seconds to count as a view
  DEBOUNCE_MS: 1000,      // Debounce map movements
  
  // Initialize the tracker
  async init() {
    // Load city database (lightweight version for client-side)
    await this.loadCities();
    
    // Set up map event listeners
    this.setupMapListeners();
    
    // Start periodic flush
    this.startFlushTimer();
    
    XLog.log('[location-tracker] Initialized with', this.CITIES.size, 'cities');
  },
  
  // Load city database from server (cached in localStorage).
  // Uses /data/cities.min.json (same file city-engine.js loads) instead
  // of the /api/cities/search endpoint which has strict limit/q constraints.
  async loadCities() {
    const CACHE_KEY = 'xyzo.cities.cache';
    const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < CACHE_TTL) {
          this.CITIES = new Map(data);
          return;
        }
      }
    } catch (e) {}

    // Fetch from the static cities JSON (same source as city-engine.js).
    // Format: [{n, a, cc, s, la, ln, p}, ...] where n=name, a=ascii_name,
    // cc=country_code, s=state, la=lat, ln=lng, p=population.
    try {
      const res = await fetch('/data/cities.min.json');
      if (res.ok) {
        const cities = await res.json();
        const entries = cities
          .filter(c => (c.p || 0) >= 100000)
          .map(c => [
            `${c.la.toFixed(2)},${c.ln.toFixed(2)}`,
            { name: c.n, country: c.cc, lat: c.la, lng: c.ln, population: c.p }
          ]);
        this.CITIES = new Map(entries);

        // Cache for next time
        localStorage.setItem(CACHE_KEY, JSON.stringify({
          data: entries,
          timestamp: Date.now()
        }));
      }
    } catch (e) {
      XLog.warn('[location-tracker] Failed to load cities:', e);
    }
  },
  
  // Find nearest city to given coordinates (client-side, no AI)
  findNearestCity(lat, lng) {
    if (this.CITIES.size === 0) return null;
    
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    
    // Check exact match first
    if (this.CITIES.has(key)) {
      return this.CITIES.get(key);
    }
    
    // Find nearest city within reasonable distance
    let nearest = null;
    let minDist = Infinity;
    
    for (const [cityKey, city] of this.CITIES) {
      const [cityLat, cityLng] = cityKey.split(',').map(Number);
      const dist = this.haversineKm(lat, lng, cityLat, cityLng);
      
      // Only consider cities within 100km
      if (dist < 100 && dist < minDist) {
        minDist = dist;
        nearest = city;
      }
    }
    
    return nearest;
  },
  
  // Haversine distance calculation (client-side)
  haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  },
  
  // Set up map event listeners
  setupMapListeners() {
    let moveTimer = null;
    
    // Track map movements (debounced)
    map.on('moveend', () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(() => this.onMapView(), this.DEBOUNCE_MS);
    });
    
    // Track pin clicks
    map.on('popupopen', (e) => {
      if (e.popup._source?._xyzoLat) {
        this.onPinClick(e.popup._source._xyzoLat, e.popup._source._xyzoLng);
      }
    });
  },
  
  // Handle map view event
  onMapView() {
    const center = map.getCenter();
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    
    // Find nearest city
    const city = this.findNearestCity(center.lat, center.lng);
    
    // Calculate view duration for previous view
    if (this.currentView && this.viewStartTime) {
      const duration = Date.now() - this.viewStartTime;
      if (duration >= this.MIN_VIEW_DURATION) {
        this.currentView.duration_ms = duration;
        this.viewQueue.push(this.currentView);
      }
    }
    
    // Start new view
    this.currentView = {
      view_type: 'map_view',
      center_lat: center.lat,
      center_lng: center.lng,
      zoom_level: Math.round(zoom),
      bbox: [
        bounds.getWest().toFixed(4),
        bounds.getSouth().toFixed(4),
        bounds.getEast().toFixed(4),
        bounds.getNorth().toFixed(4)
      ].join(','),
      city_name: city?.name || null,
      country_code: city?.country || null,
      pin_count: pinMarkers.size,
      created_at: new Date().toISOString()
    };
    this.viewStartTime = Date.now();
  },
  
  // Handle pin click event
  onPinClick(lat, lng) {
    const city = this.findNearestCity(lat, lng);
    
    this.viewQueue.push({
      view_type: 'pin_click',
      center_lat: lat,
      center_lng: lng,
      zoom_level: Math.round(map.getZoom()),
      city_name: city?.name || null,
      country_code: city?.country || null,
      created_at: new Date().toISOString()
    });
  },
  
  // Start periodic flush timer
  startFlushTimer() {
    setInterval(() => this.flush(), this.FLUSH_INTERVAL);
    
    // Also flush on page unload
    window.addEventListener('beforeunload', () => this.flush());
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush();
    });
  },
  
  // Flush queued views to server
  async flush() {
    if (this.viewQueue.length === 0) return;
    
    // Add current view if it exists
    // FIX_NOTES 3.2 (R6): pushing currentView WITHOUT resetting the timer
    // made an idle tab POST the same view every flush with a growing
    // duration — corrupting /api/location-views. Snapshot + restart clock.
    if (this.currentView && this.viewStartTime) {
      const duration = Date.now() - this.viewStartTime;
      if (duration >= this.MIN_VIEW_DURATION) {
        this.viewQueue.push({ ...this.currentView, duration_ms: duration });
        this.viewStartTime = Date.now();
      }
    }
    
    const views = this.viewQueue.splice(0, 100); // Max 100 per flush
    if (views.length === 0) return;
    
    try {
      const sessionId = typeof XyzoAnalytics !== 'undefined' ? XyzoAnalytics.sessionId : null;
      // Tier 1.2: one UUID per flush. The backend appends the view's
      // index to derive per-view keys, so a retry of this exact flush
      // payload → every view collides → zero double-counting.
      const idemKey = (crypto && crypto.randomUUID)
        ? `lview:${crypto.randomUUID()}`
        : null;

      await fetch('/api/location-views', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idemKey ? { 'X-Idempotency-Key': idemKey } : {}),
        },
        body: JSON.stringify({
          session_id: sessionId,
          views: views
        })
      });
      
      XLog.log('[location-tracker] Flushed', views.length, 'views');
    } catch (e) {
      XLog.warn('[location-tracker] Flush failed:', e);
      // Re-queue failed views
      this.viewQueue.unshift(...views);
    }
  },
  
  // Get current view stats (for debugging)
  getStats() {
    return {
      currentView: this.currentView,
      queueSize: this.viewQueue.length,
      citiesLoaded: this.CITIES.size,
      viewDuration: this.viewStartTime ? Date.now() - this.viewStartTime : 0
    };
  }
};

// Initialize location tracker
LocationTracker.init();

TILE_LAYERS["🛰️ Satellite"].addTo(map);
// BOTH VIEWPORTS START CLOSED (owner, 2026-11-06): "it's wiser to not
// start with the two control windows open when someone first visits."
// A first visit now shows the MAP, and the reader opens a panel when
// they want one.
//
// The constructor option is still `isPhoneViewport()`, because the two
// viewports need it for OPPOSITE reasons:
//
//   · ON A PHONE the panel is ~365 x 2400px on a 390x844 screen — it
//     covers the entire viewport, so EVERY tap lands on a layer row and
//     the map becomes untappable. collapsed:true also gives Leaflet its
//     own tap-to-open wiring (mouseenter → _expandSafely) that the
//     touch handler below builds on.
//
//   · ON DESKTOP collapsed:false is what keeps the panel STICKY once
//     it is open. collapsed:true makes Leaflet bind map-click →
//     collapse AND mouseleave → collapse, so the dropdown "suddenly
//     disappears" while you are reaching for a slider. collapsed:false
//     binds neither: once opened, it closes only via the ✕ or the
//     toggle.
//
// So desktop is CONSTRUCTED open (collapsed:false makes _initLayout
// call expand()) and immediately closed again with collapse() below —
// the reader gets a closed panel that still stays open while they use
// it. The toggle's click handler is bound regardless of the option (see
// _initLayout in vendor/leaflet: it sits outside the `collapsed && …`
// guard), so a collapsed:false control re-expands on a click — that
// path already ships today (open → ✕ → click the toggle to reopen).
const isPhoneViewport = () =>
  typeof window !== "undefined" &&
  (window.matchMedia("(max-width: 768px)").matches ||
   ("ontouchstart" in window && window.innerWidth <= 900));
const layersControl = L.control.layers(TILE_LAYERS, WEATHER_OVERLAYS, {
  position: "topright",
  collapsed: isPhoneViewport(),
}).addTo(map);
// Close it now, in the SAME synchronous block that created it — no
// paint can show it open. collapse() only removes the class, which is
// all there is to undo at boot: nothing has set an inline `display` on
// the list yet (that is what setLayersPanelOpen() exists to clear).
layersControl.collapse();

// ── THE SCALE BAR: how far is a screen-width at this zoom? ─────────────
//
// Owner ask: *"can you show a distance measure on the map for all the
// maps i dont see it is it hiding under the 'help me' tab? its nice to
// know distance based on the zoom level"* — and the 3D globe has had one
// (globe.js: `maplibregl.ScaleControl`) since it was written. The flat
// map had NONE, so there was nothing to hide.
//
// WHY THE BOTTOM LEFT. The bottom RIGHT belongs to the "Help me" pill
// (position: fixed, z-index 9998 — it covers whatever is in that corner)
// and to Leaflet's attribution control; the top left is the zoom bar and
// the top right is the layers dropdown. The bottom left is the only
// corner of the flat map with nothing in it.
//
// METRIC ONLY, like the globe's — the site is international, and "both"
// is two numbers and two rules for one bar.
const scaleControl = L.control.scale({
  position: "bottomleft",
  metric: true,
  imperial: false,
  maxWidth: 120,
}).addTo(map);

// ── What readers actually use ────────────────────────────────────────────
//
// The layers dropdown is ~40 rows and the Cool maps presets are
// hand-authored. Both are guesses about what readers want. This records
// what a session's map actually looked like — which overlays were on and
// at what opacity, which preset was opened, which base layer — so the
// dropdown can be ORDERED by real use and a preset can be checked
// against what the people who open it then change.
//
// ONE ROW PER SESSION PER DAY PER SETTING: a session that flips twenty
// overlays still counts once each, and a session that changes its mind
// does not inflate the aggregate. The endpoint replaces the day's rows
// rather than appending, so the write is idempotent.
//
// Nothing identifies a person — the session id is the random
// localStorage key analytics.js has always used, and no IP is stored.
// `scripts/retention_prune.py` prunes it with the other telemetry.
//
// It is a FOOTNOTE on the map, not part of it: every failure here is
// swallowed, and no reader has ever waited on this.
let _lastPresetId = null;
const mapSettings = { timer: null, usage: null, sortRaf: 0 };

function readMapSettings() {
  const s = captureMapState();
  const names = Array.from(_activeOverlayNames);
  return {
    session_id: (window.XyzoAnalytics && window.XyzoAnalytics.sessionId) || null,
    base: s.base || null,
    overlays: names.map((n) => ({
      slug: getLayerSlug(n) || n,
      name: n,
      pct: Math.round((overlayOpacityFor(n) || 0) * 100),
    })),
    preset: _lastPresetId,
    density: s.density || null,
    isoStep: s.isoStep ?? null,
    isoColour: s.isoColour || null,
    isoSource: s.isoSource || null,
    windStyle: (s.wind && s.wind.style) || null,
    windColour: (s.wind && s.wind.colour) || null,
    device: isPhoneViewport() ? "phone" : "desktop",
  };
}

function sendMapSettings(reason) {
  const payload = readMapSettings();
  if (!payload.session_id) return;
  payload.reason = reason || "change";
  try {
    fetch("/api/analytics/map-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,   // survives the tab closing mid-write
    }).catch(() => {});
  } catch (_) { /* telemetry must never reach the reader */ }
}

function scheduleMapSettings(reason) {
  clearTimeout(mapSettings.timer);
  mapSettings.timer = setTimeout(() => {
    mapSettings.timer = null;
    sendMapSettings(reason);
  }, 1200);
}

// ── Order the layers dropdown by how often each row is used ─────────────
//
// Leaflet renders the overlay list in the order of the object it was
// given, and the usage arrives AFTER the control exists — so the rows
// are re-ordered in the DOM rather than the control being built in a
// different order (which would need the fetch to block boot).
//
// The list is rebuilt by Leaflet on every layer change, so a
// MutationObserver re-applies the order. Reordering CHILDREN is not
// hand-rolling the control: the rows stay exactly as Leaflet and
// OverlayOpacity built them, they are only in a different order.
function applyOverlayRowOrder() {
  mapSettings.sortRaf = 0;
  if (!mapSettings.usage || !mapSettings.usage.length) return;
  const list = document.querySelector(".leaflet-control-layers-overlays");
  if (!list) return;

  // The report keys on the SLUG (it survives a rename); the DOM shows
  // the NAME. Resolve the slug against the overlay table once.
  const rank = new Map();
  const nameOf = new Map();
  for (const n of Object.keys(WEATHER_OVERLAYS)) nameOf.set(getLayerSlug(n) || n, n);
  mapSettings.usage.forEach((u, i) => {
    const name = u.name || nameOf.get(u.slug);
    if (name && !rank.has(name)) rank.set(name, i);
  });
  if (!rank.size) return;

  const rows = Array.from(list.children);
  if (rows.length < 2) return;
  const keyed = rows.map((el) => {
    const lab = el.querySelector("label");
    const name = lab ? (lab.textContent || "").trim() : "";
    // Unknown rows keep their relative order and go last — a layer with
    // no data yet is not worse than one with none either.
    return { el, r: rank.has(name) ? rank.get(name) : Number.MAX_SAFE_INTEGER };
  });
  keyed.sort((a, b) => a.r - b.r);   // stable: ties keep DOM order

  // ONLY TOUCH THE DOM WHEN THE ORDER IS ACTUALLY WRONG.
  //
  // `appendChild` on a node that is already in that position is STILL a
  // childList mutation — it removes and re-inserts — so re-appending an
  // unchanged list re-fires the observer, which schedules another sort,
  // which re-appends… Measured: 47 mutations in 2 s over a 32-row list,
  // i.e. the rows were being moved ~23 times a second while nothing
  // changed. Two things fall out of that:
  //
  //   * it burns the frame budget, and autoQuality sheds particles when
  //     the frame rate drops — so the wind animation thinned out for no
  //     reason;
  //   * MOVING A `<select>` CLOSES ITS OPEN POPUP. That is why the
  //     overlay palette dropdown "hid too quickly and wouldn't let me
  //     select it" — the row under the cursor was being relocated
  //     faster than a click could land.
  //
  // Comparing first means a settled list costs one comparison and no
  // DOM writes at all.
  if (keyed.every((k, i) => rows[i] === k.el)) return;

  const frag = document.createDocumentFragment();
  for (const k of keyed) frag.appendChild(k.el);
  list.appendChild(frag);
}

function scheduleRowSort() {
  if (mapSettings.sortRaf) return;
  mapSettings.sortRaf = requestAnimationFrame(applyOverlayRowOrder);
}

function loadOverlayUsage() {
  fetch("/api/analytics/map-settings?days=30", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && Array.isArray(d.overlays) && d.overlays.length) {
        mapSettings.usage = d.overlays;
        scheduleRowSort();
      }
    })
    .catch(() => {});   // no usage yet is not an error — the list just
                        // stays in its authored order
}

// ── the hooks ───────────────────────────────────────────────────────────

// Once the view has settled, and again whenever a layer or a preset
// changes it. Debounced: the endpoint replaces the day's rows, so
// twenty toggles in a row cost one write.
map.on("overlayadd overlayremove", () => scheduleMapSettings("change"));
// `whenReady`, NOT `once("load")`. Leaflet's `load` event had ALREADY
// fired by the time this line runs — the map is created and setView'd
// earlier in this file — and `once()` on an event that has already
// fired simply never runs its callback. `whenReady` calls back
// immediately when the map is already loaded, which is the usual case
// here. Measured: the settle POST never went out with `once("load")`.
map.whenReady(() => setTimeout(() => sendMapSettings("settle"), 2500));

// The list is rebuilt on every layer change, so the order has to be
// re-applied. One observer, rAF-debounced: Leaflet can rebuild it
// several times in one gesture.
const _overlayList = document.querySelector(".leaflet-control-layers-overlays");
if (_overlayList && typeof MutationObserver !== "undefined") {
  new MutationObserver(scheduleRowSort).observe(_overlayList, { childList: true });
}

// A tab being closed is the moment a reader's settings are most
// complete, and `keepalive` is what makes the write survive it.
window.addEventListener("pagehide", () => {
  clearTimeout(mapSettings.timer);
  sendMapSettings("leave");
});

loadOverlayUsage();

// ── Hard refresh ────────────────────────────────────────────────────────
//
// `*.js` is served `Cache-Control: public, max-age=31536000, immutable`
// (see the Caddyfile), so a NORMAL RELOAD CANNOT replace a stale
// app.js: the browser holds `app.js?v=X` and never asks for it again for
// a year. `index.html` is `no-cache`, so the HTML is always fresh — but
// if a deploy edited a file without bumping its token, the fresh HTML
// still points at the same stale URL, and only Ctrl+Shift+R fixes it.
//
// A page CAN do that itself: `fetch(url, { cache: "reload" })` bypasses
// the HTTP cache AND REPLACES the stored entry, so pulling every script
// and stylesheet from the network first leaves fresh bytes behind the
// immutable URL. Then the service worker's shell is dropped so it
// re-precaches, and only then does the page reload.
//
// This is the button support points at when a map looks out of date
// after an update, and its title names the keyboard shortcut, because
// that is what people are told to press.
//
// **THE FUNCTION ITSELF NOW LIVES IN `offline.js`, AS
// `window.hardRefresh`.** It must work when app.js is what is broken:
// an immutable `app.js?v=X` that a deploy left stale, a 500, or a throw
// on the first line — and while it lived here, none of those cases had a
// function to call, so the notice's "Reload fresh" button silently
// degraded to a plain `location.reload()` that could not bypass the
// immutable cache. offline.js loads before this file, so
// `window.hardRefresh` is always set by the time anything here runs.

// Is this tab running an older build than the server has?
//
// `index.html` is `no-cache`, so it always carries the CURRENT tokens.
// Comparing its `app.js?v=` with the one this page was booted from
// tells us a deploy landed while the tab was open — which is exactly
// when a reader is most likely to see something half-updated. The badge
// it lights is the suggestion; the button next to it is the fix.
function checkForNewVersion() {
  let served = null;
  fetch("/index.html", { cache: "reload" })
    .then((r) => (r.ok ? r.text() : null))
    .then((html) => {
      if (!html) return;
      served = (html.match(/app\.js\?v=(\d+)/) || [])[1] || null;
      const tag = document.querySelector('script[src*="app.js?v="]');
      const running = tag ? ((tag.src.match(/app\.js\?v=(\d+)/) || [])[1] || null) : null;
      const badge = document.getElementById("ctrl-refresh-badge");
      if (!badge || !served || !running || served === running) return;
      badge.hidden = false;
      badge.textContent = "· new version";
      badge.title = "A newer version of the map is available — a normal refresh picks it up, and Hard refresh bypasses the browser cache if it does not";
    })
    .catch(() => {});
}

const _refreshBtn = document.getElementById("ctrl-refresh-btn");
if (_refreshBtn) {
  _refreshBtn.title = "Clear the cached map files and reload — or press Ctrl+Shift+R (Cmd+Shift+R on a Mac)";
  _refreshBtn.addEventListener("click", () => {
    // Defined by offline.js, which loads before this file. The guard is
    // for a page that somehow loaded one without the other — a click on
    // the button must never throw, and a plain reload is the best
    // available answer if the primitive really is missing.
    if (typeof window.hardRefresh === "function") window.hardRefresh();
    else location.reload();
  });
}
// The notice banner offers the same thing — "Reload fresh" — and reads
// it from window.hardRefresh directly, for the reason above: that button
// is the one pressed when THIS file is the thing that failed.
setTimeout(checkForNewVersion, 4000);

// ── ONE way to open and close the layers panel ──────────────────────────
//
// Leaflet's Control.Layers.collapse() ONLY removes the CSS class — it does
// not clear an inline `display` that something else set on the list. The
// touch-friendly toggle used to hand-roll the open/close (adding the class
// and writing `list.style.display = "block"`), so on a phone the panel was
// closed with the class gone but the inline `display: block` still there:
// the 2,400 px list stayed on screen and the ✕ looked dead.
//
// Everything now goes through this one helper, which clears the inline
// styles and then calls the control's own expand()/collapse() — the control
// API also caps the list to the viewport height and applies the scrollbar
// class, which the hand-rolled version never did.
//
// THE HEIGHT CAP IS NOT OPTIONAL. `expand()` is the only thing that caps
// the list to the viewport and adds `leaflet-control-layers-scrollbar`
// (`overflow-y: scroll`). A hand-rolled open — just adding the class and
// `display: block` — produces a panel the height of its content. On a
// phone that is ~3,078 px on a 660 px screen, so 26 of the overlays
// (Soil, Cropland, Geology, Magnetic, Rivers, Basins, City names, …)
// plus the whole Köppen key sat BELOW the fold with no way to scroll to
// them. They were simply unreachable on mobile.
function setLayersPanelOpen(open) {
  const c = document.querySelector(".leaflet-control-layers");
  if (!c) return;
  const list = c.querySelector(".leaflet-control-layers-list");
  const link = c.querySelector("a.leaflet-control-layers-toggle");
  // Drop any inline display a previous hand-rolled toggle may have left, so
  // Leaflet's own CSS (.leaflet-control-layers-expanded …) decides again.
  if (list) list.style.display = "";
  if (link) link.style.display = "";
  if (open) {
    layersControl.expand();
    // expand() reserves a flat 50 px below the list. On a phone #bottom-bar
    // floats over the map, so the last rows would still land behind it.
    // Re-cap with the real reservation.
    capLayersListHeight();
  } else {
    layersControl.collapse();
  }
}

// Height the list must keep clear at the bottom. Leaflet hard-codes 50 px
// for its own attribution strip; we measure the floating bottom bar too.
function layersListBottomReserve() {
  let reserve = 50;
  try {
    const bar = document.getElementById("bottom-bar");
    if (bar) {
      const cs = getComputedStyle(bar);
      if (cs.display !== "none" && cs.visibility !== "hidden") {
        const h = bar.getBoundingClientRect().height;
        // Bar height + its 12 px offset + breathing room.
        if (h > 0) reserve = Math.max(reserve, Math.round(h) + 32);
      }
    }
  } catch (_) {}
  return reserve;
}

// Re-apply the cap that expand() applies, with OUR bottom reservation.
// Idempotent: clears the height first so the scrollHeight is the natural
// height of the list, not the previous cap.
function capLayersListHeight() {
  const c = document.querySelector(".leaflet-control-layers");
  if (!c) return;
  const section = c.querySelector(".leaflet-control-layers-list");
  if (!section) return;
  const link = c.querySelector("a.leaflet-control-layers-toggle");
  // The section is display:none while collapsed — measuring it then gives
  // 0, which would leave the panel capped at nothing when it next opens.
  const collapsed = !c.classList.contains("leaflet-control-layers-expanded");
  if (collapsed || (link && getComputedStyle(section).display === "none")) {
    section.style.height = "";
    section.classList.remove("leaflet-control-layers-scrollbar");
    return;
  }
  // DO NOT clear `height` to re-measure: clearing (or rewriting) `height`
  // on a scroll container RESETS scrollTop to 0. That is invisible until
  // the user has scrolled to a row and taps it — Chrome synthesises the
  // click ~6 ms after touchend at the same screen coordinates, by which
  // time the list has jumped to the top and a DIFFERENT control sits
  // under the finger. Measured on an iPhone 14 Pro:
  //   touchend   INPUT.leaflet-control-layers-selector  scroll=1173
  //   mousedown  BUTTON.leaflet-preset-chip             scroll=0
  // so the layer never toggled and the chip got applied instead — which
  // reads as "the checkbox does nothing". scrollHeight is the CONTENT
  // height whether or not the box has a height, so the old clear bought
  // nothing; and the write is skipped when the value is unchanged, so a
  // re-cap that computes the same height cannot move the list at all.
  const avail = map.getSize().y - (c.offsetTop + layersListBottomReserve());
  if (avail > 0 && avail < section.scrollHeight) {
    section.classList.add("leaflet-control-layers-scrollbar");
    if (section.style.height !== avail + "px") section.style.height = avail + "px";
  } else {
    section.classList.remove("leaflet-control-layers-scrollbar");
  }
}

// Leaflet's _expandSafely fires from mouseenter — the same gesture as
// the tap — and both break it: it rewrites the list height with its own
// 50px reserve (rewriting `height` RESETS scrollTop, so the row you
// scrolled to vanished) and it sets _preventClick, which makes
// _onInputClick bail so the layer was never added. Trace in README.
const _expand = layersControl.expand;
layersControl.expand = function () {
  const s = this._section;
  const keep = s ? s.scrollTop : 0;
  const r = _expand.call(this);
  if (s && L && L.DomEvent) {
    L.DomEvent.off(s, "click", L.DomEvent.preventDefault);
    this._preventClick = false;
  }
  capLayersListHeight();
  if (s && keep) s.scrollTop = keep;
  return r;
};

// ── ✕ close button for the layers panel ─────────────────────────────────
// Leaflet gives the panel no explicit close affordance, and with
// collapsed:false it would stay open forever. A visible ✕ in the panel's
// top-right corner collapses it the same way the toggle does.
(function mountLayersCloseButton() {
  const attach = () => {
    const panel = document.querySelector(".leaflet-control-layers");
    if (!panel || panel._xyzoCloseWired) return;
    // The panel only has its expanded layout once shown at least once.
    if (!panel.classList.contains("leaflet-control-layers-expanded")) return;
    panel._xyzoCloseWired = true;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "leaflet-layers-close";
    btn.setAttribute("aria-label", "Close layers panel");
    btn.title = "Close";
    btn.textContent = "\u2715"; // ✕
    // Chrome synthesises the click from a touch ~300 ms later and
    // re-hit-tests at the touch point; if the panel has re-laid-out in
    // that window the click misses the button entirely. Answer the
    // touch directly, then drop the synthesised click so it cannot
    // double-fire.
    let closing = false;
    const close = (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      if (closing) return;
      closing = true;
      setTimeout(() => { closing = false; }, 400);
      setLayersPanelOpen(false);
    };
    btn.addEventListener("touchend", close, { passive: false });
    btn.addEventListener("click", close);
    panel.appendChild(btn);
  };
  attach();
  // Leaflet rebuilds/reshows the panel's DOM on layer changes; re-check.
  map.on("overlayadd", () => setTimeout(attach, 0));
  map.on("overlayremove", () => setTimeout(attach, 0));
  map.on("baselayerchange", () => setTimeout(attach, 0));
  // The panel can be expanded by the toggle, by the touch handler, or by
  // Leaflet itself — and attach() early-returns while it is collapsed, so
  // it must also run on EXPAND, not only on layer changes. Watch the
  // class rather than chasing every expand path.
  // Also re-apply the height cap: this observer fires on every expand, so
  // an open that came from a path other than setLayersPanelOpen() (Leaflet
  // toggling the class itself, a restored shared-link state) still gets a
  // scrollable list instead of a 3,000 px panel.
  // ALSO publish the panel's real height/width so the floating Help Me
  // pill can clear it (see #layers-panel-open in styles.css). The panel is
  // the top-right control and the pill is the bottom-right one; on a
  // desktop the panel is expanded by default and its opacity sliders reach
  // down into the pill's corner, so the pill sat ON the "80%" readout of
  // the NASA Earth at Night row. On a phone the panel is capped to the
  // viewport, which is why the clash never showed there.
  //
  // 0 when collapsed: the panel is then just the toggle, and the pill
  // must go back to the corner.
  const publishPanelBox = () => {
    const c = document.querySelector(".leaflet-control-layers");
    const open = !!c && c.classList.contains("leaflet-control-layers-expanded");
    const pill = document.getElementById("help-me-btn");
    if (!open) {
      document.documentElement.style.setProperty("--layers-panel-h", "0px");
      if (pill) pill.removeAttribute("data-layers-open");
      return;
    }
    const r = c.getBoundingClientRect();
    document.documentElement.style.setProperty("--layers-panel-h", `${Math.round(r.height)}px`);
    // The panel owns the top-right control; the pill is the bottom-right
    // one. Set the flag only when the panel's box actually reaches into
    // the pill's corner — measured, so a tall desktop viewport (where the
    // panel stops well short) leaves the pill alone.
    const reaches = r.right > window.innerWidth - 140 &&
                    r.bottom > window.innerHeight - 120;
    if (pill) {
      if (reaches) pill.setAttribute("data-layers-open", "1");
      else pill.removeAttribute("data-layers-open");
    }
  };
  const watch = new MutationObserver(() => {
    setTimeout(attach, 0);
    setTimeout(() => {
      try { capLayersListHeight(); } catch (_) {}
      try { publishPanelBox(); } catch (_) {}
    }, 0);
  });
  watch.observe(document.querySelector(".leaflet-control-layers") || document.body,
                { attributes: true, attributeFilter: ["class"] });
  // A fresh control is rebuilt after a syncLayers, so re-target.
  map.on("overlayadd", () => setTimeout(() => {
    const c = document.querySelector(".leaflet-control-layers");
    if (c) { try { watch.disconnect(); watch.observe(c, { attributes: true, attributeFilter: ["class"] }); } catch (_) {} }
  }, 0));

  // Measure once at boot (the panel starts expanded on desktop, and the
  // MutationObserver never fires for a class that was already there), and
  // again on every size change — the cap is a pixel value derived from the
  // map's height, so rotating the phone or resizing the window makes it,
  // and the published box, go stale.
  let panelRaf = 0;
  const remeasure = () => {
    if (panelRaf) return;
    panelRaf = requestAnimationFrame(() => {
      panelRaf = 0;
      try { capLayersListHeight(); } catch (_) {}
      try { publishPanelBox(); } catch (_) {}
    });
  };
  setTimeout(remeasure, 0);
  setTimeout(remeasure, 600);   // after the layers list and its sliders settle
  window.addEventListener("resize", remeasure);
  window.addEventListener("orientationchange", remeasure);

  // Tapping OUTSIDE an open panel closes it. Leaflet only does this for
  // a mouse click; on a phone the touch never becomes a click on the map
  // when the panel is in the way, so the panel used to be un-closable.
  const isPanelOpen = () =>
    !!document.querySelector(".leaflet-control-layers.leaflet-control-layers-expanded");
  const collapseIfOutside = (e) => {
    if (!isPanelOpen()) return;
    const panel = document.querySelector(".leaflet-control-layers");
    if (panel && panel.contains(e.target)) return; // inside the panel
    layersControl.collapse();
  };
  map.getContainer().addEventListener("touchend", collapseIfOutside, { passive: true });
})();

// ── The layers toggle must open on a TOUCH ──────────────────────────────
//
// Leaflet HIDES the toggle while the panel is expanded and the panel then
// occupies the toggle's box. Chrome synthesises the click from a touch
// ~300 ms later and re-hit-tests at the touch point — by then the panel is
// there, so the click lands on the panel's first base-layer row and the
// dropdown never opens. Every other map control is fine (the zoom buttons
// answer to a touch), so this is specific to the toggle.
//
// Answer the touch directly and stop the synthesised click from being
// re-targeted at the panel.
(function makeLayersToggleTouchFriendly() {
  const attach = () => {
    const toggle = document.querySelector("a.leaflet-control-layers-toggle");
    if (!toggle || toggle._xyzoTouchWired) return;
    toggle._xyzoTouchWired = true;
    toggle.addEventListener("touchend", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Toggle it ourselves, synchronously, before the synthesised click.
      //
      // THIS MUST GO THROUGH setLayersPanelOpen(). It used to hand-roll
      // the toggle (add the class, set `display: block`) — and the only
      // thing that caps the list height and makes it scrollable is
      // layersControl.expand(), which the hand-rolled path never called.
      // The result was a 3,078 px panel on a 660 px phone that could not
      // be scrolled: the bottom two thirds of the overlay list was
      // unreachable. (The ✕ still "worked" — it closed the panel — but
      // the panel itself was unusable, which reads as "the layers are
      // broken on mobile".)
      const c = document.querySelector(".leaflet-control-layers");
      if (!c) return;
      setLayersPanelOpen(!c.classList.contains("leaflet-control-layers-expanded"));
    }, { passive: false });
  };
  attach();
  // Leaflet rebuilds the control's DOM when the layers change.
  map.on("overlayadd", () => setTimeout(attach, 0));
  map.on("overlayremove", () => setTimeout(attach, 0));
})();

// The cap in capLayersListHeight() is a pixel value derived from the map's
// height. Rotate the phone or resize the window while the panel is open and
// it goes stale — the list either leaves dead space or clips. Re-cap on
// every size change while the panel is open. (Closed, the re-cap is a
// no-op: it clears the height and drops the scrollbar class.)
(function keepLayersListCapped() {
  let raf = 0;
  const recap = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      try { capLayersListHeight(); } catch (_) {}
    });
  };
  window.addEventListener("resize", recap);
  window.addEventListener("orientationchange", recap);
  if (typeof ResizeObserver !== "undefined") {
    try { new ResizeObserver(recap).observe(document.getElementById("map")); } catch (_) {}
  }
})();

// Per-overlay opacity sliders inside the layers dropdown. Applied after
// the control exists so the sliders land next to their checkboxes; the
// stored values are restored immediately (they also apply to a layer that
// is switched on later).
if (window.OverlayOpacity && typeof window.OverlayOpacity.mount === "function") {
  window.OverlayOpacity.restore(WEATHER_OVERLAYS);
  window.OverlayOpacity.mount(WEATHER_OVERLAYS);
}

// The isobar checkbox is injected into the dropdown once the control's
// DOM exists. It lives under the base layers (see mountIsobarRow).
mountIsobarRow();

// The isobar row sits outside the overlays list, so the generic
// OverlayOpacity.mount() above never sees it — give it its own slider.
if (window.OverlayOpacity && typeof window.OverlayOpacity.mountRow === "function") {
  window.OverlayOpacity.mountRow(
    document.querySelector(".xyzo-isobar-row"),
    "⛅ Pressure lines (isobars)",
    window.IsobarLayer && typeof window.IsobarLayer.setOpacity === "function"
      ? (v) => window.IsobarLayer.setOpacity(v)
      : null,
    window.IsobarLayer && typeof window.IsobarLayer.getOpacity === "function"
      ? window.IsobarLayer.getOpacity()
      : 0.85
  );
}

// Listen for base layer and overlay changes from Leaflet layer control
map.on("baselayerchange", (e) => {
  if (e && e.name) {
    _activeBaseLayerName = e.name;
    updateUrlHash();
  }
});

// Leaflet rebuilds the overlays list (empties it and re-adds the labels)
// on every layer change, so the slider rows injected into it are wiped
// the moment any overlay is toggled. Re-mount them after the rebuild —
// without this the sliders vanish on first use, and a shared link that
// restores overlays comes up with no sliders at all.
function remountOverlaySliders() {
  try {
    if (window.OverlayOpacity && typeof window.OverlayOpacity.mount === "function") {
      window.OverlayOpacity.mount(
        typeof WEATHER_OVERLAYS !== "undefined" ? WEATHER_OVERLAYS : null);
    }
  } catch (_) {}
  // The Story-links and Markers rows are siblings of the overlay list,
  // so Leaflet's rebuild wipes them too — re-inject both. (They are
  // `function` declarations, hoisted, so calling them here is safe even
  // though they appear later in the file.)
  try { mountLinksRow(); } catch (_) {}
  try { mountMarkersRow(); } catch (_) {}
  try { mountMapPresetRow(); } catch (_) {}
  try { if (typeof window.__syncLinksToggle === "function") window.__syncLinksToggle(); } catch (_) {}
  try { if (typeof window.__syncMarkersToggle === "function") window.__syncMarkersToggle(); } catch (_) {}
}
map.on("overlayadd", () => setTimeout(remountOverlaySliders, 0));
map.on("overlayremove", () => setTimeout(remountOverlaySliders, 0));

// An opacity slider moved — the hash carries the style, so it has to
// follow. Debounced, because the slider fires on every pixel of drag.
if (typeof window !== "undefined") {
  let _opacityHashTimer = null;
  window.addEventListener("xyzo:overlay-opacity", () => {
    if (_opacityHashTimer) clearTimeout(_opacityHashTimer);
    _opacityHashTimer = setTimeout(() => {
      _opacityHashTimer = null;
      updateUrlHash();
    }, 200);
  });
}
// The isobar DETAIL step changed — same rule, same reason. The layer
// owns the control and knows when the step changed; the app owns the
// URL. One event between them, so neither has to reach into the other.
if (typeof window !== "undefined") {
  window.addEventListener("xyzo:isobar-step", () => {
    try { updateUrlHash(); } catch (_) {}
  });
}
// The isobar COLOUR changed — the same, because `iso=<step>:<colour>`
// is ONE segment and both halves have to stay in step with the map.
if (typeof window !== "undefined") {
  window.addEventListener("xyzo:isobar-colour", () => {
    try { updateUrlHash(); } catch (_) {}
  });
}
// The wind's STYLE, COLOUR or DENSITY changed — one event for all
// three, because they are one segment (`wind=<style>:<colour>:<density>`)
// and a hash that carries two of the three is a hash that lies.
//
// This also closes a gap that predates density: setStyle() and
// setColorMode() never announced themselves, so the address bar only
// caught up on the next map move. The share button copies
// location.href VERBATIM, so changing the style and pressing Share
// without panning first handed over the previous style.
if (typeof window !== "undefined") {
  window.addEventListener("xyzo:wind-style", () => {
    try { updateUrlHash(); } catch (_) {}
  });
}
// The isobar ANALYSIS changed — the same, for the same reason: which
// analysis the lines are drawn from is part of the picture, so a shared
// link has to carry it (`isoSrc=ecmwf`).
if (typeof window !== "undefined") {
  window.addEventListener("xyzo:isobar-source", () => {
    try { updateUrlHash(); } catch (_) {}
  });
}
// The pressure CHANGE map's WINDOW changed — the same, for the same
// reason: "the change over the last day" and "the change over the last
// year" are different pictures, so a shared link has to carry it
// (`delta=24h`).
if (typeof window !== "undefined") {
  window.addEventListener("xyzo:isobar-delta", () => {
    try { updateUrlHash(); } catch (_) {}
  });
}
// Leaflet's overlayadd/overlayremove carry `e.layer`, never `e.name`.
// Reverse-lookup the display name from WEATHER_OVERLAYS so a box the
// user checks by hand is recorded and survives the next hash rewrite.
// (The old `e.name` check was always false — overlays checked in the
// dropdown silently fell out of shared links.)
function _overlayNameFor(layer) {
  if (!layer || typeof WEATHER_OVERLAYS === "undefined") return null;
  for (const key of Object.keys(WEATHER_OVERLAYS)) {
    if (WEATHER_OVERLAYS[key] === layer) return key;
  }
  return null;
}
map.on("overlayadd", (e) => {
  const name = _overlayNameFor(e && e.layer);
  if (name) {
    _activeOverlayNames.add(name);
    updateUrlHash();
  }
});
map.on("overlayremove", (e) => {
  const name = _overlayNameFor(e && e.layer);
  if (name) {
    _activeOverlayNames.delete(name);
    updateUrlHash();
  }
});

// Restore saved map position/zoom and layers from URL hash or localStorage.
//
// The wrapper exists so the URL hash is never rewritten with a stale map
// centre: restoreMapView() runs from a setTimeout(0) that lands AFTER
// DOMContentLoaded, so anything that calls updateUrlHash() during startup
// (e.g. the climate overlay restoring its persisted state) would otherwise
// clobber the position of a shared "#lat,lng,zoom" link before it is read.
function restoreMapView() {
  // THE BOOT STAGES THE OVERLAYS. A shared link can name fifteen of
  // them — and the FIRST VISIT opens the curated "cool map", which
  // names thirteen — and adding them all before the first paint means
  // the browser decodes 280 tile images before the markers are drawn:
  // measured, twenty seconds of main-thread work between the pins
  // arriving and the markers appearing.
  //
  // So the basemap and the MARKERS come first, and the overlays are
  // added a frame later (which is what every map does anyway). Both
  // boot paths are covered: the shared link's hash AND the first
  // visit's preset — they both end in applyLayersFromParsedHash.
  try {
    _deferOverlayAdds = true;
    _restoreMapView();
  } finally {
    _deferOverlayAdds = false;
    _mapViewRestored = true;
    try { updateUrlHash(); } catch (_) {}
  }
}

function _restoreMapView() {
  const hashView = parseMapHash(window.location.hash);
  if (hashView) {
    if (hashView.lat != null && hashView.lng != null && hashView.zoom != null) {
      // The map was ALREADY created at this view (see the constructor
      // above), so moving it again would fire a second moveend and a
      // second pin fetch for the same place. Only move when it differs.
      const cur = map.getCenter();
      const same = Math.abs(cur.lat - hashView.lat) < 1e-6 &&
                   Math.abs(cur.lng - hashView.lng) < 1e-6 &&
                   Math.abs(map.getZoom() - hashView.zoom) < 1e-6;
      if (!same) {
        map.setView([hashView.lat, hashView.lng], hashView.zoom);
      }
    }
    // A LINK IS A VIEW, NOT A SETTINGS CHANGE. Both halves below can
    // write preferences as a side effect: the hash apply adds layers
    // (which persists "1") and the removal below takes them off (which
    // persists "0"). Without this snapshot, opening a friend's link
    // silently overwrote whatever the user had chosen for themselves —
    // their bare revisit then stopped restoring. Snapshot the xyzo.*
    // preferences first and put any that moved back afterwards.
    const _prefSnapshot = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf("xyzo.") === 0) {
        try { _prefSnapshot[k] = localStorage.getItem(k); } catch (_) {}
      }
    }

    applyLayersFromParsedHash(hashView);

    // A URL that ENUMERATES overlays is AUTHORITATIVE: it must show
    // exactly what it lists and nothing else.
    //
    // Every layer module restores its own localStorage preference inside
    // init(), and NONE of them checks the hash — nine do it (city names,
    // mag, temp, lightning, ocean, salinity, phytoplankton, transport and
    // the field-layer family behind CAPE/IVT/wave/relief). The hash-apply
    // path only ADDS, so nothing downstream can turn a restored layer back
    // off: once a user had ticked city names once, EVERY shared link
    // arrived wearing them, including URLs that listed seven other
    // overlays and not that one.
    //
    // This removal runs HERE — once, at boot, after the hash has been
    // applied — rather than inside each layer's restore, so the modules
    // keep their intended bare-revisit behaviour (a hash with no
    // overlay= list still restores preferences) and there is one gate
    // instead of nine copies of it.
    //
    // The set is read off THE MAP, not off _activeOverlayNames: a layer
    // that init() puts on the map programmatically may never have fired
    // `overlayadd` (that event comes from the layers control, which does
    // not exist yet), so the tracking Set can be missing it.
    if (Array.isArray(hashView.overlays) && hashView.overlays.length > 0) {
      const wanted = new Set();
      for (const ov of hashView.overlays) {
        const entry = typeof ov === "string" ? { name: ov } : ov;
        const n = resolveLayerName(entry.name);
        if (n) wanted.add(n);
      }
      if (typeof WEATHER_OVERLAYS !== "undefined") {
        for (const name of Object.keys(WEATHER_OVERLAYS)) {
          if (wanted.has(name)) continue;
          const layer = WEATHER_OVERLAYS[name];
          if (layer && map.hasLayer(layer)) map.removeLayer(layer);
          _activeOverlayNames.delete(name);
        }
      }
      // The isobar layer is deliberately NOT a WEATHER_OVERLAYS entry.
      if (!wanted.has(ISOBAR_LAYER_NAME) && window.IsobarLayer &&
          typeof window.IsobarLayer.isEnabled === "function" &&
          window.IsobarLayer.isEnabled()) {
        if (typeof window.IsobarLayer.setEnabled === "function") window.IsobarLayer.setEnabled(false);
        if (typeof window.__syncIsobarToggle === "function") window.__syncIsobarToggle();
        _activeOverlayNames.delete(ISOBAR_LAYER_NAME);
      }
      // And the writer must not put the removed names straight back.
      for (const name of Array.from(_activeOverlayNames)) {
        if (!wanted.has(name)) _activeOverlayNames.delete(name);
      }
    }

    // Put back anything the hash apply/removal wrote. New keys (the link
    // turned a layer on that had never been on) are removed so the stored
    // state is exactly what it was before the link was opened.
    //
    // The three non-layer preferences are spared: they are not overlays,
    // and a future boot-time write to one of them must not be deleted by
    // a rule whose job is layer state.
    const _NOT_A_LAYER_PREF = { "xyzo.debug": 1, "xyzo.textSize": 1, "xyzo.wikiMarkers": 1 };
    for (const k in _prefSnapshot) {
      try {
        if (localStorage.getItem(k) !== _prefSnapshot[k]) localStorage.setItem(k, _prefSnapshot[k]);
      } catch (_) {}
    }
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || k.indexOf("xyzo.") !== 0 || _NOT_A_LAYER_PREF[k]) continue;
      if (!Object.prototype.hasOwnProperty.call(_prefSnapshot, k)) {
        try { localStorage.removeItem(k); } catch (_) {}
      }
    }

    // Apply time filter from URL hash if present
    if (hashView.time && typeof setTimeFilter === "function") {
      setTimeFilter(hashView.time, { persist: false });
    }
    // Apply density from URL hash if present
    if (hashView.density && PIN_DENSITY_MAP && PIN_DENSITY_MAP[hashView.density]) {
      pinDensity = hashView.density;
      try { localStorage.setItem(PIN_DENSITY_STORAGE_KEY, pinDensity); } catch (_) {}
      const densityLabel = document.getElementById("density-dropdown-label");
      const labelMap = { low: "Low", medium: "Medium", high: "High", max: "Max" };
      if (densityLabel) densityLabel.textContent = labelMap[pinDensity] || "Medium";
    }
    // If hash contains a search term, restore the search
    if (hashView.search && typeof runSearch === "function" && searchInput) {
      searchInput.value = hashView.search;
      const run = () => {
        if (typeof runSearch === "function") runSearch({ zoom: "auto" });
      };
      // Deferred, for the same reason as initSearchFromUrl(): runSearch
      // reads `debouncedTextSearch`, a `const` declared further down the
      // file, and calling it before that binding is initialised throws.
      const schedule = () => setTimeout(run, 0);
      whenMapReady(schedule);
    }
    // If hash contains a pin, open that popup (after search completes)
    if (hashView.pinId) {
      const openPin = () => {
        if (hashView.pinId !== _activePinId) {
          openPinPopup(hashView.pinId);
        }
      };
      // The old `map.isStyleLoaded()` guard threw a TypeError (Leaflet
      // has no such method) and `map.once("load", openPin)` silently
      // did nothing when the load event had already fired — so a
      // shared "#…/pin=123" link opened no popup at all.
      whenMapReady(openPin);
    }
    return;
  }

  // Also check URL search params as fallback (e.g. ?base=...&overlay=...)
  try {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has("base") || urlParams.has("overlay")) {
      applyLayersFromParsedHash({
        base: urlParams.get("base"),
        overlays: urlParams.get("overlay") ? urlParams.get("overlay").split(",") : undefined
      });
    }
  } catch (_) {}

  // Priority 2: the map the user asked us to open with — an explicit
  // ⭐ default, else whatever they used last time, else (first visit
  // ever) the curated "cool map" if this machine can carry it
  // (public_html/map-presets.js). A hash or ?base=&overlay= above
  // always wins: a shared link is an instruction, not a preference.
  try {
    if (window.MapPresets && typeof window.MapPresets.bootPlan === "function") {
      const plan = window.MapPresets.bootPlan(navigator);
      if (plan && plan.state && applyMapState(plan.state)) return;
    }
  } catch (_) {}

  // Priority 3: localStorage
  try {
    const raw = localStorage.getItem("xyzo-map-view");
    if (raw) {
      const { lat, lng, zoom } = JSON.parse(raw);
      if (typeof lat === "number" && typeof lng === "number" && typeof zoom === "number") {
        map.setView([lat, lng], zoom);
        return;
      }
    }
  } catch (_) {}

  // Default: world view
  map.setView(WORLD_VIEW.center, WORLD_VIEW.zoom);
}
setTimeout(restoreMapView, 0); // deferred to avoid TDZ (PIN_DENSITY_MAP, setTimeFilter declared later)
// ── Render layers ────────────────────────────────────────────────────
// Three independent render targets, all backed by the same in-memory marker
// registries (pinMarkers / eventMarkers). Switch modes by attaching/detaching
// layers from the map — no re-fetch, no re-cluster.
const pinCluster = L.markerClusterGroup({
  // No "disable at zoom N" — leaving that set caused markers to suddenly
  // unfurl into individual icons at world-zoom boundaries, which felt like
  // a bug. Let the cluster group decide clustering by zoom on its own.
  maxClusterRadius: 50,
  chunkedLoading: true,
  showCoverageOnHover: false,
  spiderfyOnMaxZoom: true,
});
const eventCluster = L.markerClusterGroup({
  maxClusterRadius: 70,
  chunkedLoading: true,
  showCoverageOnHover: false,
  spiderfyOnMaxZoom: true,
});
const markerLayer = L.layerGroup();   // plain (unclustered) markers
const heatLayer = L.heatLayer([], {
  radius: 26,
  blur: 22,
  maxZoom: 9,
  minOpacity: 0.35,
  gradient: {
    0.0: "#1e3a8a",
    0.3: "#3b82f6",
    0.55: "#22d3ee",
    0.75: "#facc15",
    1.0: "#ef4444",
  },
});

// Connection-lines layer. Holds SVG <path> arcs between same-category
// markers (one great-circle segment per pin, all converging on the
// category's centroid). Orthogonal to the marker/heatmap/cluster mode
// toggle — toggled separately via #links-toggle.
const linkLayer = L.layerGroup();

// Registries keyed by id so we can update or remove individual markers. These
// hold the canonical marker objects regardless of which mode is active — the
// mode controller pulls markers from the right registry into the right layer.
const pinMarkers = new Map();
const eventMarkers = new Map();

// Dirty flag: tracks whether markers actually changed since last syncLayers().
// Only rebuild clusters when this is true to avoid unnecessary work.
let _markersDirty = true;

// Live discovery streaming — pins that arrive while an AI discovery
// run is in progress. Capped at MAX_LIVE_ARTICLE_PINS to keep the map
// renderer light (a 300-article run would otherwise pile 300 markers
// onto the canvas and jank the GPU). Once a run completes we run a
// proper fetchPinsForViewport() which reconciles to the full
// event-clustered marker set, and these rolling-window pins disappear.
const MAX_LIVE_ARTICLE_PINS = 10;
const _liveDiscoveryArticlePins = new Map();  // article.id → L.marker (FIFO order)

// Tracking dedupe Set lives on the same pollDiscoveryStatus run so the
// rolling window is per-run.
let _liveSeenArticleIds = new Set();

function _evictOldestArticlePin() {
  const oldestId = _liveDiscoveryArticlePins.keys().next().value;
  if (oldestId === undefined) return;
  const m = _liveDiscoveryArticlePins.get(oldestId);
  if (m) {
    try { map.removeLayer(m); } catch (_) {}
  }
  _liveDiscoveryArticlePins.delete(oldestId);
  _liveSeenArticleIds.delete(oldestId);
}

function addLiveArticleMarker(article) {
  if (!article || article.id == null) return;
  if (_liveSeenArticleIds.has(article.id)) return; // already on the map

  const lat = article.lat;
  const lng = article.lng;
  if (lat == null || lng == null) return; // not yet geocoded — skip silently

  // Cap at MAX_LIVE_ARTICLE_PINS — drop oldest (FIFO via Map insertion order).
  while (_liveDiscoveryArticlePins.size >= MAX_LIVE_ARTICLE_PINS) {
    _evictOldestArticlePin();
  }

  // Reuse the canonical icon pipeline so live pins share the same look
  // as the regular event pins: category-aware color + SVG icon.
  const icon = iconFor({
    category: article.category,
    source_type: "rss",
  });
  const html = buildMarkerDiv(icon, {
    size: MARKER_ICON_SIZE,
    title: article.title,
  });
  const divIcon = L.divIcon({
    className: "xyzo-pin live-discovery-pin",
    html,
    iconSize: [MARKER_ICON_SIZE, MARKER_ICON_SIZE],
    iconAnchor: [MARKER_ICON_SIZE / 2, MARKER_ICON_SIZE / 2],
  });
  const m = L.marker([lat, lng], {
    icon: divIcon,
    riseOnHover: true,
    // Live pins always sit above the regular marker layer so the user
    // can spot new arrivals even on a busy map.
    zIndexOffset: 1000,
  }).addTo(map);
  m.bindTooltip(`🆕 ${escapeHtml(article.title || article.place || "")}`, {
    direction: "top",
    offset: [0, -MARKER_ICON_SIZE / 2],
  });
  m._xyzoLiveArticleId = article.id;

  // CSS pulse — defined in styles.css as `.new-pin-glow`. The animation
  // plays once and we strip the class so re-flashing works later.
  const el = m.getElement();
  if (el) {
    el.classList.add("new-pin-glow");
    setTimeout(() => el.classList.remove("new-pin-glow"), 1500);
  }

  _liveDiscoveryArticlePins.set(article.id, m);
  _liveSeenArticleIds.add(article.id);
}

function clearLiveDiscoveryPins() {
  for (const m of _liveDiscoveryArticlePins.values()) {
    try { map.removeLayer(m); } catch (_) {}
  }
  _liveDiscoveryArticlePins.clear();
  _liveSeenArticleIds = new Set();
}

function _flashLivePinCounter() {
  // Brief pulse on the existing summary element so the user sees the
  // running totals update in real time.
  const summaryEl = document.getElementById("status-panel-summary");
  if (!summaryEl) return;
  summaryEl.classList.remove("flash");
  // Force reflow so the animation restarts even on consecutive triggers.
  void summaryEl.offsetWidth;
  summaryEl.classList.add("flash");
}

// Heatmap data: [lat, lng, intensity]. Updated by renderPins/renderEvents.
// Weights slightly favour clustered events (high-signal multi-source stories)
// over plain RSS (often noisy / duplicates), and lighter still for editorial
// and community submissions.
const HEAT_WEIGHT = { rss: 1.0, editorial: 0.6, community: 0.6, event: 1.5 };
let _heatPoints = [];

// Push the current heat data into the heat layer — but ONLY when it's on the
// map. Leaflet.heat's setLatLngs() forces a redraw that touches this._map;
// if the layer is detached (we just removed it to switch modes), this throws
// "this._map is null".
function commitHeat() {
  if (!activeModes.has("heatmap")) return;      // fast-path: no need to touch it
  if (!map.hasLayer(heatLayer)) return;         // safety net if order ever changes
  if (!heatLayer._map) return;                  // defensive: layer detached mid-tick
  rebuildHeatPoints();
  try { heatLayer.setLatLngs(_heatPoints); } catch (_) { /* layer got detached mid-tick */ }
}

// ── Client-side density checker ─────────────────────────────────────
// Detects suspicious pin clusters on the map without server help.
// Uses the city database to check if too many pins are stacked in
// one area relative to the city's population.
//
// When a user clicks a pin in a city with many nearby stories, auto-zoom
// to show the full cluster. Checks all currently-loaded pins; if >= 5
// fall within 30km of the clicked pin, fit them all on screen.
// Optionally accepts an article list (e.g. from an overflow badge) to use
// instead of scanning canvasRenderer pins.
function maybeZoomToCluster(clat, clng, articleList) {
  let candidates = [];

  if (articleList?.length > 0) {
    // Overflow badge: use the provided articles directly — they ARE the cluster.
    candidates = articleList;
  } else {
    // ONE SOURCE OF TRUTH FOR "THE PINS ON SCREEN".
    //
    // The canvas list and the DOM marker registry hold the SAME pins — a
    // search renders into both — so counting them both counted every pin
    // TWICE. The "≥3 neighbours within 30 km" test therefore fired on a
    // single pin, and a 700 ms cluster flight started for nothing: the
    // popup then opened INTO that flight and rode it to wherever it
    // ended.
    //
    // Deduplicated by pin id, with the rounded position as the fallback
    // for a pin that carries no id.
    const seen = new Set();
    const add = (id, lat, lng) => {
      if (lat == null || lng == null) return;
      const key = id != null
        ? "id:" + id
        : "ll:" + Number(lat).toFixed(4) + "," + Number(lng).toFixed(4);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ lat, lng });
    };
    if (canvasRenderer && canvasRenderer._pins && canvasRenderer._pins.length > 0) {
      for (const p of canvasRenderer._pins) {
        add(p.id ?? null, p.location?.lat ?? p.lat, p.location?.lng ?? p.lng);
      }
    }
    pinMarkers.forEach((m, id) => {
      const ll = m.getLatLng();
      add(m._xyzoId ?? id ?? null, ll.lat, ll.lng);
    });
  }

  // For article-list mode: all articles are at the cluster center, so bounding
  // box is just the center point ± a small city-radius.  For canvas mode: filter
  // by 30km haversine distance from the clicked pin.
  let bounds;
  if (articleList?.length > 0) {
    // All at same coords — use a ~15km box around the city center so we zoom
    // to roughly city-level (z10–13 depending on spread).
    const cityKm = 15 / 111.32;
    bounds = [
      [clat - cityKm, clng - cityKm],
      [clat + cityKm, clng + cityKm],
    ];
  } else {
    // Canvas/DOM mode: filter to pins within 30km of the clicked pin.
    // Low-zoom views show a *sample* of all pins (the server caps the
    // payload), so even 3+ stories stacked in one place is decisive.
    const nearby = candidates.filter(p => DensityChecker._dist(clat, clng, p.lat, p.lng) <= 30);
    if (nearby.length < 3) return false;

    let minLat = clat, maxLat = clat, minLng = clng, maxLng = clng;
    let rKm = 0;
    for (const p of nearby) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
      rKm = Math.max(rKm, DensityChecker._dist(clat, clng, p.lat, p.lng));
    }
    // Fit the real spread, but guarantee a minimum box so a stacked cluster
    // (city pins share one centroid until pixel-spread kicks in at z7)
    // lands on a city-level view instead of a degenerate point at z14.
    // When already zoomed in, use a small floor so we never fly *outward*.
    const padLat = (maxLat - minLat) * 0.15 || 0.01;
    const padLng = (maxLng - minLng) * 0.15 || 0.01;
    const minHalfKm = map.getZoom() >= 8 ? 4 : 12;
    const half = Math.max(rKm * 1.25, minHalfKm) / 111.32;
    bounds = [
      [Math.min(minLat - padLat, clat - half), Math.min(minLng - padLng, clng - half)],
      [Math.max(maxLat + padLat, clat + half), Math.max(maxLng + padLng, clng + half)],
    ];
  }

  const targetZoom = map.getBoundsZoom(bounds, false);
  const zoom = Math.max(7, Math.min(14, targetZoom));
  map.flyToBounds(bounds, { padding: [40, 40], maxZoom: zoom, duration: 0.7 });
  return true;
}

// THE READER'S OWN ZOOM.
//
// Owner ask: *"rather then autozooming in on a pin thats in a city we
// need to give people the option after the popup opens to zoom in
// someplace in the popup after they click on the news pin."*
//
// So the click no longer flies the map — the POPUP carries a button that
// does it, and the reader decides. The button ALWAYS does something:
// with three or more stories nearby it shows the cluster (the view the
// auto-zoom used to give unasked), and with an isolated pin it shows
// the place itself at city level. A button that does nothing is worse
// than no button.
function zoomToPlace(lat, lng) {
  if (typeof map === "undefined" || !map) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (maybeZoomToCluster(lat, lng)) return true;
  // No cluster — the place itself, at city level, and never ZOOMED OUT
  // from where the reader already is.
  const z = Math.max(map.getZoom(), 11);
  map.flyTo([lat, lng], z, { duration: 0.7 });
  return true;
}

// Count pins within 30km of a location (same logic as maybeZoomToCluster)
function _countNearbyPins(lat, lng) {
  if (!pinMarkers || pinMarkers.size === 0) return 0;
  let count = 0;
  pinMarkers.forEach((m) => {
    const ll = m.getLatLng();
    if (ll.lat != null && ll.lng != null && DensityChecker._dist(lat, lng, ll.lat, ll.lng) <= 30) {
      count++;
    }
  });
  return count;
}

// Runs after each pin render cycle. Flags suspicious clusters with
// a visual indicator and logs them for debugging.
const DensityChecker = {
  // Dynamic thresholds: (min_population, max_pins)
  TIERS: [
    [10_000_000, 50],
    [5_000_000, 35],
    [1_000_000, 25],
    [500_000, 15],
    [250_000, 10],
    [100_000, 7],
    [0, 5],
  ],

  // Haversine distance in km
  _dist(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  },

  // Get max pins allowed for a population
  _maxForPop(pop) {
    for (const [minPop, maxPins] of this.TIERS) {
      if (pop >= minPop) return maxPins;
    }
    return 5;
  },

  // Find clusters in the current viewport
  findClusters() {
    const pins = [];
    pinMarkers.forEach((marker, id) => {
      const ll = marker.getLatLng();
      const data = marker._pinData || {};
      pins.push({ id, lat: ll.lat, lng: ll.lng, data });
    });

    if (pins.length < 3) return [];

    // Grid-based clustering (30km cells)
    const gridSize = 30 / 111;
    const grid = new Map();
    for (const pin of pins) {
      const key = `${Math.round(pin.lat/gridSize)},${Math.round(pin.lng/gridSize)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(pin);
    }

    // Merge adjacent cells
    const clusters = [];
    const processed = new Set();
    for (const [key, cellPins] of grid) {
      if (processed.has(key)) continue;
      const [r, c] = key.split(',').map(Number);
      let merged = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nk = `${r+dr},${c+dc}`;
          if (grid.has(nk)) {
            merged.push(...grid.get(nk));
            processed.add(nk);
          }
        }
      }

      if (merged.length < 3) continue;

      // Calculate centroid
      const avgLat = merged.reduce((s, p) => s + p.lat, 0) / merged.length;
      const avgLng = merged.reduce((s, p) => s + p.lng, 0) / merged.length;

      // Find nearest city using CityEngine
      let cityName = 'unknown';
      let population = 0;
      if (window.CityEngine && window.CityEngine.isLoaded()) {
        const nearest = window.CityEngine.citiesNear(avgLat, avgLng, 100, 1)[0];
        if (nearest) {
          cityName = nearest.n || 'unknown';
          population = nearest.p || 0;
        }
      }

      const maxAllowed = this._maxForPop(population);

      // Check if pins are stacked (all within 1km)
      let maxDist = 0;
      for (let i = 0; i < merged.length; i++) {
        for (let j = i+1; j < merged.length; j++) {
          const d = this._dist(merged[i].lat, merged[i].lng, merged[j].lat, merged[j].lng);
          maxDist = Math.max(maxDist, d);
        }
      }

      // Check source country mismatch
      const sourceCountries = merged.map(p => p.data?.source_country).filter(Boolean);
      const countryCounts = {};
      for (const cc of sourceCountries) countryCounts[cc] = (countryCounts[cc] || 0) + 1;

      const suspicious = merged.length > maxAllowed || maxDist < 1.0;
      const reasons = [];
      if (merged.length > maxAllowed) reasons.push(`${merged.length} pins (max ${maxAllowed} for ${cityName})`);
      if (maxDist < 1.0) reasons.push(`stacked within ${maxDist.toFixed(1)}km`);

      clusters.push({
        lat: avgLat, lng: avgLng,
        city: cityName, population,
        pinCount: merged.length, maxAllowed,
        maxDistKm: Math.round(maxDist * 10) / 10,
        suspicious, reasons,
        pinIds: merged.map(p => p.id),
      });
    }

    return clusters.sort((a, b) => b.pinCount - a.pinCount);
  },

  // Visual: add warning circles around suspicious clusters
  _circles: [],
  visualize() {
    // Clear old circles
    for (const c of this._circles) map.removeLayer(c);
    this._circles = [];

    const clusters = this.findClusters();
    for (const cl of clusters) {
      if (!cl.suspicious) continue;

      // Add a red warning circle
      const circle = L.circle([cl.lat, cl.lng], {
        radius: cl.maxDistKm * 1000 || 2000,
        color: '#ef4444',
        fillColor: '#ef4444',
        fillOpacity: 0.08,
        weight: 1,
        dashArray: '4,4',
      }).addTo(map);

      circle.bindTooltip(
        `⚠️ ${cl.pinCount} pins in ${cl.city} (max ${cl.maxAllowed})\n${cl.reasons.join(', ')}`,
        { permanent: false, direction: 'top' }
      );

      this._circles.push(circle);
    }

    return clusters;
  },

  // Run check and log results
  check() {
    const clusters = this.findClusters();
    const suspicious = clusters.filter(c => c.suspicious);
    if (suspicious.length > 0) {
      XLog.warn(`[density] ${suspicious.length} suspicious clusters found:`);
      for (const cl of suspicious.slice(0, 5)) {
        XLog.warn(`  ${cl.city}: ${cl.pinCount} pins (max ${cl.maxAllowed}), spread ${cl.maxDistKm}km`);
      }
    }
    return { total: clusters.length, suspicious: suspicious.length, clusters };
  },
};

// Run density check after pin rendering (idle path + debug gated)
const _origFetchPins = fetchPinsForViewport;
const _runIdle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));

fetchPinsForViewport = async function() {
  await _origFetchPins();
  if (!XYZO_DEBUG) return;
  _runIdle(() => {
    try {
      DensityChecker.check();
    } catch (e) {
      XLog.debug('[density] check failed:', e);
    }
  });
};

// ── Connection-lines ("links") renderer ────────────────────────────────
// Story-to-story connections. Two stories are "linked" when they share
// an entity, a location, or a source. The backend computes edges in
// /api/feed/links; the frontend renders each edge as a great-circle arc
// between the two story locations. Color encodes why they're connected:
//
//   - source (same RSS feed cited both)   → teal (#5eead4)
//   - location (both report on same place) → amber (#f59e0b)
//   - entity (both mention same person/org) → magenta (#e879f9)
//   - topic (both tagged with same theme)   → blue (#60a5fa)
//
// Edge weight (1, 2, 3+) modulates opacity; the strongest connections
// are most visible. A "connections-only" rendering is also available —
// in that mode the base marker layer is hidden and only the connecting
// arcs are drawn, plus a separate sidebar list of the events involved.
//
// Toggle-only — orthogonal to the markers/heatmap/clusters mode. Off by
// default so the default load of the map isn't busier than it was.
let linksEnabled = false;

// "Story links" — the connection-arc overlay — lives in the Leaflet
// layers dropdown, under the overlay list. It is a sibling of the
// overlays list (not a child): Leaflet rebuilds that list on every layer
// change, so a row inside it would be wiped on the first overlay toggle.
//
// Called here (not next to the control creation) because `linksEnabled`
// is a `let` further down — reading it earlier is a temporal-dead-zone
// error that would abort the rest of app.js.
function mountLinksRow() {
  const list = document.querySelector(".leaflet-control-layers-list");
  const overlays = list && list.querySelector(".leaflet-control-layers-overlays");
  if (!list || !overlays) return;
  if (document.querySelector(".leaflet-links-row")) return;
  const row = document.createElement("div");
  row.className = "leaflet-overlay-row leaflet-links-row";
  row.innerHTML =
    '<label><span>' +
    '<input type="checkbox" class="leaflet-control-layers-selector" id="ctrl-links-toggle">' +
    "<span> \u{1F517} Story links</span></span></label>";
  overlays.insertAdjacentElement("afterend", row);
  const cb = row.querySelector("input");
  if (!cb) return;
  cb.addEventListener("change", () => {
    setLinksEnabled(cb.checked);
    if (typeof refreshLinksToggleTitle === "function") refreshLinksToggleTitle();
  });
  // Keep the checkbox in sync when the state is changed elsewhere.
  window.__syncLinksToggle = () => { cb.checked = !!linksEnabled; };
  cb.checked = !!linksEnabled;
}
mountLinksRow();

// "Markers" — a master on/off for every pin the map draws (individual
// markers, clusters and the canvas pins). It lives in the layers
// dropdown under the overlay list, exactly like the Story links row.
//
// Why a master toggle: the mode buttons (Markers / Heatmap / Clusters)
// only switch BETWEEN render modes — to actually clear the map you had
// to know the double-click-a-second-time trick, which nobody discovers.
// This checkbox turns all of them off (and back on) in one place.
//
// Off = drop the data, not just hide it: fetchPinsForViewport no-ops
// when every marker-ish mode is off, so turning markers off also stops
// the network churn. Turning it back on re-fetches for the viewport.
let markersVisible = true;

function setMarkersVisible(on) {
  const want = !!on;
  if (want === markersVisible) return;
  markersVisible = want;

  // A master "off" clears every pin-consuming mode at once; "on" always
  // restores the default single-marker mode (never clusters/heatmap —
  // those stay the user's explicit choice from the mode dropdown).
  if (!want) {
    activeModes.delete("markers");
    activeModes.delete("clusters");
    activeModes.delete("heatmap");
  } else {
    if (activeModes.size === 0) activeModes.add("markers");
  }
  _markersDirty = true;
  applyLayers();

  // Keep the mode-dropdown buttons + label in sync with the new set.
  for (const b of getModeButtons()) {
    const isActive = activeModes.has(b.dataset.mode);
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
  const markersLabel = document.getElementById("markers-dropdown-label");
  if (markersLabel) {
    markersLabel.textContent = activeModes.has("heatmap") ? "Heatmap"
      : activeModes.has("clusters") ? "Clusters"
      : activeModes.has("markers") ? "Markers"
      : "Off";
  }
  window.__syncMarkersToggle?.();
}

// Injected into the layers dropdown as a sibling of the overlay list —
// Leaflet rebuilds that list on every layer change, so a row inside it
// would be wiped. Same contract as mountLinksRow.
function mountMarkersRow() {
  const list = document.querySelector(".leaflet-control-layers-list");
  const overlays = list && list.querySelector(".leaflet-control-layers-overlays");
  if (!list || !overlays) return;
  if (document.querySelector(".leaflet-markers-row")) return;
  const row = document.createElement("div");
  row.className = "leaflet-overlay-row leaflet-markers-row";
  row.innerHTML =
    '<label><span>' +
    '<input type="checkbox" class="leaflet-control-layers-selector" id="ctrl-markers-toggle">' +
    "<span> \u{1F4CD} Markers</span></span></label>";
  overlays.insertAdjacentElement("afterend", row);
  const cb = row.querySelector("input");
  if (!cb) return;
  cb.addEventListener("change", () => setMarkersVisible(cb.checked));
  // Keep the checkbox in sync when the state changes elsewhere (e.g. the
  // mode dropdown clearing the last mode).
  window.__syncMarkersToggle = () => { cb.checked = markersVisible && activeModes.size > 0; };
  // The initial checked state must NOT touch `activeModes` here: it is a
  // `const` declared ~750 lines below, so reading it at parse time is a
  // temporal-dead-zone error that aborts the rest of app.js. Default to
  // "on" (the real state) and let the first applyLayers() correct it.
  cb.checked = markersVisible;
}
mountMarkersRow();

// ── ✨ Cool maps + ↺ Clear + ⤢ Reset, inside the layers panel ─────────
// Owner spec 2026-10-30: curated "cool" maps one click away, and a way
// to switch EVERYTHING off without ticking 26 boxes by hand.
//
// The row is a SIBLING of the base/overlay lists (same contract as the
// links/markers rows): Leaflet empties those two lists on every layer
// change, so anything inside them dies on the first toggle.
//
// Clear keeps the base layer and the camera — it removes overlays only.
// Reset is the full factory state: world view, Satellite, every overlay
// off, opacities back to each layer's own default, density Medium.
function clearAllOverlays() {
  applyMapState(
    { base: getLayerSlug(_activeBaseLayerName) || "satellite", overlays: [] },
    { keepView: true });
}

function resetMap() {
  try {
    if (window.OverlayOpacity && typeof window.OverlayOpacity.reset === "function") {
      window.OverlayOpacity.reset(
        typeof WEATHER_OVERLAYS !== "undefined" ? WEATHER_OVERLAYS : null);
    }
  } catch (_) {}
  // The isobar row lives outside the overlays list, so reset() above
  // never sees it — put its opacity back to the layer's own default.
  try {
    if (window.IsobarLayer && typeof window.IsobarLayer.setOpacity === "function") {
      window.IsobarLayer.setOpacity(0.85);
      if (window.OverlayOpacity && typeof window.OverlayOpacity.set === "function") {
        window.OverlayOpacity.set(
          typeof WEATHER_OVERLAYS !== "undefined" ? WEATHER_OVERLAYS : null,
          ISOBAR_LAYER_NAME, 0.85);
      }
    }
  } catch (_) {}
  applyMapState({
    lat: WORLD_VIEW.center[0],
    lng: WORLD_VIEW.center[1],
    zoom: WORLD_VIEW.zoom,
    base: "satellite",
    overlays: [],
    density: "medium",
  });
}

// ── 🛰️ THE DEFAULT MAP ─────────────────────────────────────────────────
//
// One click back to the site's own view: the SATELLITE view — the world
// on the satellite basemap, the pin density at its maximum, and **no
// overlays at all**.
//
// IT WAS THE OWNER'S OWN MAP (2026-11-13 — satellite, the wind over it,
// the pressure lines under it) and it was **too slow on some computers**
// (owner, 2026-11-14): the wind animation is a canvas that repaints
// every frame over a field that has to be fetched and contoured first.
// The button went back to what the first ask said it was — *"a default
// satellite only view"* — and the hash is the owner's own link to it.
//
// IT IS NOT A SECOND IMPLEMENTATION OF "WHAT A MAP IS". The default map
// is a HASH (map-presets.js's DEFAULT_MAP), parsed by the same
// `MapPresets.parseHash()` a preset and a shared link use and applied
// through the same `applyMapState()` — the path that REMOVES the
// overlays the map happens to have and adds the ones the default names.
// A button that assembled the view by hand would be a second source of
// truth, and the second source of truth is the one that drifts.
function applyDefaultMap() {
  const MP = window.MapPresets;
  if (!MP || typeof MP.defaultMapState !== "function") return false;
  const state = MP.defaultMapState();
  if (!state) return false;
  return applyMapState(state);
}

// The button in the bottom bar, beside the ⚙, and the row in the ⚙
// menu's MAP section. The BAR button is hidden below 560 px (the bar
// has no room on a phone — measured: the ⚙ itself hangs off the right
// edge at 393 px), so the menu row is what a phone reader uses.
(function wireDefaultMapButton() {
  const apply = () => { applyDefaultMap(); };
  const barBtn = document.getElementById("default-map-btn");
  if (barBtn) barBtn.addEventListener("click", apply);
  const menuBtn = document.getElementById("ctrl-default-map-btn");
  if (menuBtn) {
    menuBtn.addEventListener("click", () => {
      apply();
      // Close the menu so the map it just drew is visible.
      const menu = document.getElementById("control-menu");
      if (menu) menu.hidden = true;
      document.body.removeAttribute("data-dropdown-open");
      const gear = document.getElementById("control-menu-btn");
      if (gear) gear.setAttribute("aria-expanded", "false");
    });
  }
})();

function mountMapPresetRow() {
  const list = document.querySelector(".leaflet-control-layers-list");
  if (!list) return;
  if (document.querySelector(".leaflet-presets-row")) return;
  // Anchor under the isobar row (which itself sits under the base
  // layers); fall back to the base list if it is not there yet.
  const anchor = list.querySelector(".xyzo-isobar-row") ||
                 list.querySelector(".leaflet-control-layers-base");
  if (!anchor) return;
  const MP = window.MapPresets;
  if (!MP || typeof MP.presets !== "function") return;

  const row = document.createElement("div");
  row.className = "leaflet-presets-row";

  const title = document.createElement("div");
  title.className = "leaflet-presets-title";
  title.textContent = "\u2728 Cool maps"; // ✨
  row.appendChild(title);

  const chips = document.createElement("div");
  chips.className = "leaflet-presets-chips";
  for (const p of MP.presets()) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "leaflet-preset-chip";
    chip.setAttribute("data-preset", p.id);
    chip.textContent = p.icon || "\u2728";
    chip.title = p.name + " — " + p.desc;
    chip.setAttribute("aria-label", "Apply preset " + p.name);
    chip.addEventListener("click", () => {
      const preset = MP.presetById(p.id);
      const state = preset && MP.presetState(preset);
      // keepView: swap layers, not the camera
      if (state) applyMapState(state, { keepView: true });
      // Which preset this reader opened, so the usage table can say what
      // a "Storm watch" map actually looks like to the people who open
      // one — and whether they then change it.
      _lastPresetId = p.id;
      sendMapSettings("preset");
    });
    chips.appendChild(chip);
  }
  row.appendChild(chips);

  const actions = document.createElement("div");
  actions.className = "leaflet-presets-actions";
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.id = "xyzo-clear-overlays";
  clearBtn.className = "leaflet-preset-action";
  clearBtn.textContent = "\u21BA Clear"; // ↺
  clearBtn.title = "Switch every overlay off (keeps the base map and the view)";
  clearBtn.addEventListener("click", clearAllOverlays);
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.id = "xyzo-reset-map";
  resetBtn.className = "leaflet-preset-action";
  resetBtn.textContent = "\u2922 Reset"; // ⤢
  resetBtn.title = "Back to the start: world view, Satellite, no overlays, default opacities";
  resetBtn.addEventListener("click", resetMap);
  actions.appendChild(clearBtn);
  actions.appendChild(resetBtn);
  row.appendChild(actions);

  anchor.insertAdjacentElement("afterend", row);
}
mountMapPresetRow();

// Wire the per-pin ✕ dismiss (capture-phase, once — pins are re-created
// constantly, so a delegated handler on the map container is the only
// listener that survives). Safe to call here: `map` is defined above.
wirePinDismiss();

// ── Isobar row in the layers dropdown ─────────────────────────────────
// The pressure-contour layer is listed under the BASE layers, as a
// checkbox.
//
// It cannot be a child of `.leaflet-control-layers-base`: Leaflet's
// Control.Layers._update() empties BOTH `_baseLayersList` and
// `_overlaysList` and rebuilds them from scratch on every layer change
// (that is why the links row is a sibling of the overlays list and not
// a child of it). A checkbox inside the base list would therefore be
// wiped by the first overlay toggle or base-layer switch.
//
// So the row is injected into `.leaflet-control-layers-list` — the
// parent of the base list — immediately AFTER the base list, which puts
// it visually under the base layers and keeps it out of Leaflet's
// rebuild path.
function mountIsobarRow() {
  if (!window.IsobarLayer || typeof window.IsobarLayer.setEnabled !== "function") return;
  const list = document.querySelector(".leaflet-control-layers-list");
  const base = list && list.querySelector(".leaflet-control-layers-base");
  if (!list || !base) return;
  if (document.querySelector(".xyzo-isobar-row")) return;

  const name = window.IsobarLayer.LAYER_NAME || "⛅ Pressure lines (isobars)";
  const row = document.createElement("div");
  row.className = "leaflet-overlay-row xyzo-isobar-row";
  const label = document.createElement("label");
  const span = document.createElement("span");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "leaflet-control-layers-selector";
  input.id = "ctrl-isobars-toggle";
  const text = document.createElement("span");
  text.textContent = " " + name;
  span.appendChild(input);
  span.appendChild(text);
  label.appendChild(span);
  row.appendChild(label);
  base.insertAdjacentElement("afterend", row);

  window.IsobarLayer.mountStepControl?.(row);   // detail: 1/2/4/8/16 hPa

  const cb = row.querySelector("input");
  if (!cb) return;

  const apply = (on) => {
    window.IsobarLayer.setEnabled(on);
    if (on) _activeOverlayNames.add(name);
    else _activeOverlayNames.delete(name);
    if (typeof updateUrlHash === "function") updateUrlHash();
  };

  cb.addEventListener("change", () => apply(cb.checked));

  // Keep the checkbox in sync when the layer is switched on elsewhere
  // (a shared link, the restore path).
  window.__syncIsobarToggle = () => { cb.checked = !!window.IsobarLayer.isEnabled(); };
  cb.checked = !!window.IsobarLayer.isEnabled();
}

const LINKS_MIN_ZOOM = 2;       // skip at world zoom (lines are noisy across continents)
const LINKS_MAX_ARC_KM = 12000; // defensive: skip pairs farther than this

// Cache the last /api/feed/links response so we don't refetch on every
// pan/zoom (renderLinks runs on moveend throttled).
let _linksCache = null;
let _linksCacheAt = 0;
const _LINKS_CACHE_TTL_MS = 60_000;

// ── Legend category filtering ────────────────────────────────────────
// When non-empty, only markers whose category (or parent bucket) is in
// this set are shown. Empty = show all. Persisted to localStorage.
const _activeCategoryFilters = new Set();
const CATEGORY_FILTER_KEY = "xyzo-category-filters";

function loadCategoryFilters() {
  // Category filters are session-only and must NEVER silently persist across
  // page reloads in localStorage. Silently storing filters across reloads
  // traps users (e.g. after a hard-refresh with Ctrl+Shift+R) into seeing
  // only a couple of pins matching an old filter without any indication why.
  try {
    localStorage.removeItem(CATEGORY_FILTER_KEY);
    sessionStorage.removeItem(CATEGORY_FILTER_KEY);
  } catch (_) {}
  _activeCategoryFilters.clear();
}
loadCategoryFilters();

function updateActiveFilterIndicator() {
  const el = document.getElementById("active-filter-indicator");
  if (!el) return;
  const hasCat = typeof _activeCategoryFilters !== "undefined" && _activeCategoryFilters.size > 0;
  const hasTag = typeof _activeTag !== "undefined" && !!_activeTag;

  if (!hasCat && !hasTag) {
    el.hidden = true;
    return;
  }

  const textEl = document.getElementById("active-filter-text");
  const drawn = (typeof canvasRenderer !== "undefined" && typeof canvasRenderer._lastDrawnCount === "number")
    ? canvasRenderer._lastDrawnCount
    : (typeof pinMarkers !== "undefined" ? pinMarkers.size : 0);

  const parts = [];
  if (hasCat) {
    const cats = [..._activeCategoryFilters].join(", ");
    parts.push(`Category: <strong>${escapeHtml(cats)}</strong>`);
  }
  if (hasTag) {
    parts.push(`Topic: <strong>${escapeHtml(_activeTag)}</strong>`);
  }

  if (textEl) {
    textEl.innerHTML = `🏷️ Filter active: ${parts.join(" · ")} <span style="opacity:0.8;font-weight:normal;">(${drawn} in view)</span>`;
  }
  el.hidden = false;
}
window.updateActiveFilterIndicator = updateActiveFilterIndicator;

function clearCategoryFilters() {
  _activeCategoryFilters.clear();
  try {
    localStorage.removeItem(CATEGORY_FILTER_KEY);
    sessionStorage.removeItem(CATEGORY_FILTER_KEY);
  } catch (_) {}
  _markersDirty = true;
  updateActiveFilterIndicator();
  if (typeof renderLegend === "function") renderLegend();
  if (typeof syncLayers === "function") syncLayers();
  if (typeof canvasRenderer !== "undefined" && canvasRenderer && canvasRenderer._enabled) {
    canvasRenderer._draw();
    if (typeof checkEmptyPinState === "function") {
      checkEmptyPinState(canvasRenderer._lastDrawnCount ?? (canvasRenderer._pins ? canvasRenderer._pins.length : 0));
    }
  }
}
window.clearCategoryFilters = clearCategoryFilters;

// ── Connection highlight ─────────────────────────────────────────────
// When an event marker is clicked while links are on, its connections
// are highlighted in bright red. null = no highlight.
let _highlightedEventId = null;

// ── News-list highlight ──────────────────────────────────────────────
// ID of the .new-item currently marked as "this is the story the map
// is centered on." Persists across the 60s renderLivePanel re-render.
// null = no headline is the active view. Distinct from
// _highlightedEventId (which controls connection-arc highlighting).
let _activeHeadlineEventId = null;

// Story-connection loading indicator. Delayed by 400ms so a warm cache
// hit never flashes it, but a cold viewport query (20-30s) always shows
// it — otherwise the map is empty with the toggle on, which reads as a
// broken feature rather than a slow one.
let _linksLoadingTimer = null;
function showLinksLoading() {
  clearTimeout(_linksLoadingTimer);
  _linksLoadingTimer = setTimeout(() => {
    const el = document.getElementById("links-loading");
    if (el) el.hidden = false;
  }, 400);
}
function hideLinksLoading() {
  clearTimeout(_linksLoadingTimer);
  _linksLoadingTimer = null;
  const el = document.getElementById("links-loading");
  if (el) el.hidden = true;
}

function renderLinks() {
  // Always start clean; cheap to call repeatedly.
  linkLayer.clearLayers();
  hideLinksLoading();
  if (!linksEnabled) return;
  if (map.getZoom() < LINKS_MIN_ZOOM) return;

  // Pull from cache if fresh, otherwise fetch /api/feed/links. We keep
  // this fetch out of the moveend hot path by caching for 60s.
  showLinksLoading();
  ensureLinksFeed().then((feed) => {
    hideLinksLoading();
    if (!feed) return;
    if (!linksEnabled) return;          // toggle off mid-fetch → bail
    drawConnections(feed);
  });
}

// Fetch /api/feed/links on demand. Cached for 60s so pan/zoom doesn't
// thrash the backend. Returns null on failure.
let _linksCacheKey = null;
function ensureLinksFeed() {
  const b = map.getBounds();
  const bbox = `${b.getWest().toFixed(3)},${b.getSouth().toFixed(3)},${b.getEast().toFixed(3)},${b.getNorth().toFixed(3)}`;
  const key = `${bbox}_${map.getZoom()}`;
  if (_linksCache && _linksCacheKey === key && Date.now() - _linksCacheAt < 15_000) {
    return Promise.resolve(_linksCache);
  }
  return fetch(`/api/feed/links?limit=250&min_weight=0.25&bbox=${encodeURIComponent(bbox)}`)
    .then((r) => r.ok ? r.json() : null)
    .then((data) => {
      if (!data) return null;
      _linksCache = data;
      _linksCacheKey = key;
      _linksCacheAt = Date.now();
      return data;
    })
    .catch((e) => {
      if (e?.name !== "AbortError") XLog.warn("ensureLinksFeed", e);
      return null;
    });
}

// Edge colors by kind. Mixed-kind edges (e.g. shared source AND location)
// average the colors so the line still hints at the story.
//
// "ai" MUST be here: the NN relationship model writes the overwhelming
// majority of edges (link_type='ai_detected' ≈ 97% of all rows), and the
// backend maps it to kind "ai". Without a colour entry every single arc
// fell through to the gray fallback — the whole layer looked broken.
const EDGE_COLORS = {
  source:   "#5eead4",  // teal (matches accent)
  location: "#f59e0b",  // amber
  entity:   "#e879f9",  // magenta
  topic:    "#60a5fa",  // blue
  semantic: "#c026d3",  // fuchsia
  ai:       "#4ade80",  // green — NN relationship model (same_story, follow_up, …)
};
function edgeColor(kinds) {
  if (!kinds || !kinds.length) return "#94a3b8";   // fallback gray
  let r = 0, g = 0, b = 0;
  for (const k of kinds) {
    const c = EDGE_COLORS[k] || "#94a3b8";
    const m = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!m) continue;
    r += parseInt(m[1], 16); g += parseInt(m[2], 16); b += parseInt(m[3], 16);
  }
  const n = kinds.length;
  return "#" + [r, g, b].map((x) => Math.round(x / n).toString(16).padStart(2, "0")).join("");
}

// Human-readable label for the NN relationship classes.
const EDGE_RELATION_LABELS = {
  same_story:   "same story",
  related:      "related story",
  follow_up:    "follow-up",
  response:     "response",
  background:   "background",
  origin:       "origin of",
  destination:  "destination of",
  mentioned:    "mentions",
};

// Turn the backend's "NN: same_story (cosine=0.85)" into
// "same story · 85% match". Returns null when there is no usable reason.
function parseEdgeReason(reason) {
  if (!reason || typeof reason !== "string") return null;
  const m = reason.match(/^NN:\s*([a-z_]+)\s*(?:\(cosine=([0-9.]+)\))?/i);
  if (!m) return reason.trim() || null;
  const label = EDGE_RELATION_LABELS[m[1].toLowerCase()] || m[1].replace(/_/g, " ");
  if (m[2] == null) return label;
  const pct = Math.round(parseFloat(m[2]) * 100);
  if (!isFinite(pct)) return label;
  return `${label} · ${pct}% match`;
}

// The "why connected" line under the two headlines. Prefers the NN's own
// relationship reason (the dominant link type), then the shared-entity
// counters, and only falls back to the useless word "linked".
function edgeReasonText(e) {
  const parsed = parseEdgeReason(e?.reason);
  if (parsed) return parsed;
  const reasons = [];
  if (e?.shared?.sources)   reasons.push(`${e.shared.sources} shared source${e.shared.sources > 1 ? "s" : ""}`);
  if (e?.shared?.locations) reasons.push(`${e.shared.locations} shared location${e.shared.locations > 1 ? "s" : ""}`);
  if (e?.shared?.entities)  reasons.push(`${e.shared.entities} shared entit${e.shared.entities > 1 ? "ies" : "y"}`);
  if (e?.shared?.topics)    reasons.push(`${e.shared.topics} shared topic${e.shared.topics > 1 ? "s" : ""}`);
  return reasons.length ? reasons.join(" · ") : "linked";
}

// Where the connection sits. ai_detected edges carry no shared city, so
// fall back to the two endpoints' own places — the nodes already ship
// location.place, which is populated for every node.
function edgePlaceText(edge, nodeA, nodeB) {
  if (edge?.shared?.place) return escapeHtml(edge.shared.place);
  const pa = nodeA?.location?.place;
  const pb = nodeB?.location?.place;
  if (pa && pb && pa !== pb) return `${escapeHtml(pa)} ↔ ${escapeHtml(pb)}`;
  return pa ? escapeHtml(pa) : "";
}

function drawConnections(feed) {
  if (!feed?.nodes?.length) return;
  linkLayer.clearLayers();
  const nodeById = new Map();
  for (const n of feed.nodes) nodeById.set(n.id, n);
  const bounds = map.getBounds();

  // Determine which edges/nodes are highlighted.
  const isHighlighting = _highlightedEventId != null;
  const connectedNodeIds = new Set();
  if (isHighlighting) {
    connectedNodeIds.add(_highlightedEventId);
    for (const e of feed.edges) {
      if (e.a === _highlightedEventId) connectedNodeIds.add(e.b);
      if (e.b === _highlightedEventId) connectedNodeIds.add(e.a);
    }
  }

  // Render each edge as a great-circle arc between the two story
  // locations. We filter by visible bounds to keep the SVG affordable.
  for (const e of feed.edges) {
    const a = nodeById.get(e.a), b = nodeById.get(e.b);
    if (!a || !b || !a.location || !b.location) continue;
    const aa = L.latLng(a.location.lat, a.location.lng);
    const bb = L.latLng(b.location.lat, b.location.lng);
    // Skip if neither endpoint is in viewport (saves a lot of SVG).
    if (!bounds.contains(aa) && !bounds.contains(bb)) continue;
    const distKm = aa.distanceTo(bb) / 1000;
    if (distKm < 5 || distKm > LINKS_MAX_ARC_KM) continue;

    const color = edgeColor(e.kinds);
    // Opacity from weight: 1 → 0.35, 2 → 0.55, 3+ → 0.75
    const opacity = Math.min(0.75, 0.25 + e.weight * 0.18);
    const weight = Math.min(3.5, 1 + e.weight * 0.6);
    const latlngs = greatCircleArc(aa, bb, 28);

    // Highlight logic: if highlighting, connected arcs get red, others dimmed.
    const isConnected = isHighlighting &&
      (e.a === _highlightedEventId || e.b === _highlightedEventId);
    const lineClass = isHighlighting
      ? (isConnected ? "xyzo-conn xyzo-conn-highlight" : "xyzo-conn xyzo-conn-dimmed")
      : "xyzo-conn";

    const line = L.polyline(latlngs, {
      color: isConnected ? "#ef4444" : color,
      weight: isConnected ? Math.max(weight, 3) : weight,
      opacity: isHighlighting ? (isConnected ? 1 : 0.12) : opacity,
      interactive: true,
      className: lineClass,
      bubblingMouseEvents: false,
    });
    // Tooltip with the "why connected" reason.
    const reasonText = edgeReasonText(e);
    const placeRaw = edgePlaceText(e, a, b);
    const placeBit = placeRaw ? ` @ <em>${placeRaw}</em>` : "";
    line.bindTooltip(
      `<strong>${escapeHtml(a.headline.slice(0, 60))}${a.headline.length > 60 ? "…" : ""}</strong><br>` +
      `<strong>${escapeHtml(b.headline.slice(0, 60))}${b.headline.length > 60 ? "…" : ""}</strong><br>` +
      `<small style="color:var(--muted)">${reasonText}${placeBit}</small>`,
      { sticky: true, direction: "auto", className: "xyzo-link-tooltip" },
    );
    // Click handler — open connection detail panel.
    line.on("click", (ev) => {
      L.DomEvent.stopPropagation(ev);
      openLinkPanel(a, b, e);
    });
    linkLayer.addLayer(line);
  }

  // Apply highlight/dim classes to markers.
  clearMarkerHighlights();
  if (isHighlighting) {
    for (const [id, m] of eventMarkers) {
      const el = getMarkerPinEl(m);
      if (!el) continue;
      if (String(id) === String(_highlightedEventId)) {
        el.classList.add("marker-selected");
      } else if (connectedNodeIds.has(id) || connectedNodeIds.has(String(id)) || connectedNodeIds.has(Number(id))) {
        el.classList.add("marker-highlight");
      }
    }
    // Also highlight pin markers whose event_id or pin id is connected.
    for (const [id, m] of pinMarkers) {
      const eid = m._xyzoEventId != null ? m._xyzoEventId : (m._xyzoId != null ? m._xyzoId : id);
      if (eid != null) {
        const el = getMarkerPinEl(m);
        if (!el) continue;
        if (String(eid) === String(_highlightedEventId)) {
          el.classList.add("marker-selected");
        } else if (connectedNodeIds.has(eid) || connectedNodeIds.has(String(eid)) || connectedNodeIds.has(Number(eid))) {
          el.classList.add("marker-highlight");
        }
      }
    }
  }
}


// ── Marker highlight helpers ─────────────────────────────────────────
function getMarkerPinEl(m) {
  if (!m) return null;
  const el = typeof m.getElement === "function" ? m.getElement() : null;
  if (!el) return null;
  if (el.classList.contains("xyzo-pin")) return el;
  return el.querySelector(".xyzo-pin") || el;
}

function clearMarkerHighlights() {
  for (const m of eventMarkers.values()) {
    const el = getMarkerPinEl(m);
    if (el) {
      el.classList.remove("marker-highlight", "marker-selected");
    }
  }
  for (const m of pinMarkers.values()) {
    const el = getMarkerPinEl(m);
    if (el) {
      el.classList.remove("marker-highlight", "marker-selected");
    }
  }
}

function toggleHighlightEvent(eventId) {
  if (_highlightedEventId === eventId) {
    _highlightedEventId = null;
  } else {
    _highlightedEventId = eventId;
  }
  // Re-render links to apply highlight.
  renderLinks();
  // If clearing highlight, also clear marker classes.
  if (_highlightedEventId == null) {
    clearMarkerHighlights();
  }
}

// ── Marker Selection & Highlight State ──────────────────────────────
let _selectedPinId = null;
let _selectedEventId = null;

function setSelectedPin(pinId, eventId = null) {
  _selectedPinId = pinId != null ? String(pinId) : null;
  _selectedEventId = eventId != null ? String(eventId) : _selectedPinId;
  XLog.debug("[MarkerHighlight] setSelectedPin:", { _selectedPinId, _selectedEventId });
  updateMarkerSelection();
}

function clearSelectedPin() {
  _selectedPinId = null;
  _selectedEventId = null;
  XLog.debug("[MarkerHighlight] clearSelectedPin");
  updateMarkerSelection();
}

function updateMarkerSelection() {
  if (typeof canvasRenderer !== "undefined" && canvasRenderer && canvasRenderer._enabled) {
    canvasRenderer._scheduleRedraw();
  }

  clearMarkerHighlights();

  if (!_selectedPinId && !_selectedEventId && !_highlightedEventId) {
    return;
  }

  const isSelected = (m, defaultId) => {
    const pId = m._xyzoId != null ? String(m._xyzoId) : (defaultId != null ? String(defaultId) : null);
    const eId = m._xyzoEventId != null ? String(m._xyzoEventId) : pId;
    if (_selectedPinId != null && pId === _selectedPinId) return true;
    if (_selectedEventId != null && eId === _selectedEventId) return true;
    if (_highlightedEventId != null && (eId === String(_highlightedEventId) || pId === String(_highlightedEventId))) return true;
    return false;
  };

  for (const [id, m] of eventMarkers) {
    const el = getMarkerPinEl(m);
    if (!el) continue;
    if (isSelected(m, id)) {
      el.classList.add("marker-selected");
    } else if (typeof connectedNodeIds !== "undefined" && (connectedNodeIds.has(id) || connectedNodeIds.has(String(id)))) {
      el.classList.add("marker-highlight");
    }
  }

  for (const [id, m] of pinMarkers) {
    const el = getMarkerPinEl(m);
    if (!el) continue;
    if (isSelected(m, id)) {
      el.classList.add("marker-selected");
    } else if (typeof connectedNodeIds !== "undefined" && (connectedNodeIds.has(id) || connectedNodeIds.has(String(id)))) {
      el.classList.add("marker-highlight");
    }
  }
}

window.__xyzoMarkerDiagnostics = function() {
  const mode = (typeof canvasRenderer !== "undefined" && canvasRenderer._enabled) ? "canvas" : "dom";
  const state = {
    mode,
    _selectedPinId,
    _selectedEventId,
    _highlightedEventId,
    linksEnabled: typeof linksEnabled !== "undefined" ? linksEnabled : false,
    domPinCount: typeof pinMarkers !== "undefined" ? pinMarkers.size : 0,
    domEventCount: typeof eventMarkers !== "undefined" ? eventMarkers.size : 0,
    canvasPinCount: (typeof canvasRenderer !== "undefined" && canvasRenderer._pins) ? canvasRenderer._pins.length : 0,
    canvasRenderedPinCount: (typeof canvasRenderer !== "undefined" && typeof canvasRenderer._lastDrawnCount === "number") ? canvasRenderer._lastDrawnCount : 0,
    activeCategoryFilters: typeof _activeCategoryFilters !== "undefined" ? [..._activeCategoryFilters] : [],
    activeTag: typeof _activeTag !== "undefined" ? _activeTag : null,
    selectedDomMarkerFound: mode === "dom" ? !!document.querySelector(".marker-selected") : null,
  };
  XLog.log("[XYZO Marker Diagnostics]", state);
  return state;
};

// Clear highlight when clicking on the map (not on a marker or arc).
// Also opens the click-to-submit flow: an empty-map click offers to drop a
// story idea at that point (owner spec 2026-09-28). Guarded so dismissive
// clicks (closing a popup / active fix-mode / open panels) never trigger it.
let _lastPopupCloseAt = 0;
let _lastPopupOpenAt = 0;
map.on("popupclose", () => { _lastPopupCloseAt = Date.now(); });
map.on("popupopen", () => { _lastPopupOpenAt = Date.now(); });

// ── Double-click-to-submit gate (owner spec 2026-10-29) ────────────────
// Elderly users were opening the submitter by ACCIDENT on a single
// tap. A first click on empty map now leaves a small hint; only a
// SECOND click within 500 ms and 40 px opens the form. The map's own
// doubleClickZoom is disabled (L.map options) so the gesture is
// exclusively "add a story"; zoom stays on wheel / pinch / buttons.
// Probe-armed single clicks are unaffected — they return earlier in
// the guard chain.
let _submitTap = null;
let _submitHintEl = null;
let _submitHintTimer = 0;
let _satOfferTimer = 0;
let _satOfferLatLng = null;

function hideSubmitHint() {
  clearTimeout(_submitHintTimer);
  clearTimeout(_satOfferTimer);
  _satOfferTimer = 0;
  _satOfferLatLng = null;
  if (_submitHintEl) {
    _submitHintEl.classList.remove("visible");
    _submitHintEl.classList.remove("is-satellite");
  }
}

function showSubmitHint(containerPoint, latlng) {
  if (!containerPoint) return;
  const host = map.getContainer();
  if (!host) return;
  if (!_submitHintEl || !document.body.contains(_submitHintEl)) {
    _submitHintEl = document.createElement("div");
    _submitHintEl.className = "submit-hint";
    _submitHintEl.setAttribute("role", "status");
    // The chip changes job after the double-click window closes (see
    // the morph timer below): while it is the satellite offer it IS
    // clickable — so its click must never bubble into the map's own
    // click gate as a phantom tap.
    _submitHintEl.addEventListener("click", (ev) => {
      if (!_submitHintEl.classList.contains("is-satellite")) return;
      if (!_satOfferLatLng) return;
      ev.stopPropagation();
      ev.preventDefault();
      const at = _satOfferLatLng;
      hideSubmitHint();
      openSatellitePopup(at);
    });
    host.appendChild(_submitHintEl);
  }
  _submitHintEl.textContent = "Double-click to add a story here";
  _submitHintEl.classList.remove("is-satellite");
  _satOfferLatLng = (latlng && Number.isFinite(latlng.lat) && Number.isFinite(latlng.lng))
    ? L.latLng(latlng.lat, latlng.lng) : null;
  _submitHintEl.style.left = containerPoint.x + "px";
  _submitHintEl.style.top = Math.max(8, containerPoint.y - 36) + "px";
  _submitHintEl.classList.add("visible");
  clearTimeout(_submitHintTimer);
  clearTimeout(_satOfferTimer);
  _submitHintTimer = setTimeout(() => {
    if (_submitHintEl) _submitHintEl.classList.remove("visible");
  }, 2200);
  // The double-click window (500 ms) has closed with no second click —
  // the gesture was a lone click, so the chip changes job: it becomes
  // the satellite offer (pointer-events:auto via .is-satellite). A
  // slower "double-click" was NEVER a submit (the gate already closed),
  // so this steals nothing.
  _satOfferTimer = setTimeout(() => {
    if (!_submitHintEl || !_satOfferLatLng) return;
    if (!document.body.contains(_submitHintEl)) return;
    clearTimeout(_submitHintTimer); // restart the fade for the new job
    _submitHintEl.textContent = "🛰️ View satellite of this spot";
    _submitHintEl.classList.add("is-satellite");
    _submitHintTimer = setTimeout(() => hideSubmitHint(), 3200);
  }, 520);
}

// ── Satellite popup (owner ask 2026-10-29) ─────────────────────────────
// Right-click stays the BROWSER's native menu everywhere (inspector,
// save image, extensions) — a page cannot add items to it. The
// satellite affordance therefore hangs off the lone empty-map click,
// after the double-click-to-submit window has closed (see above).
// The popup shows a live Esri World Imagery mini-map (the same
// licensed service as the Satellite basemap) plus outbound links —
// linking to Google/Bing is free and legal; EMBEDDING their tiles
// would not be.
let _satMiniMap = null;

function googleSatelliteUrl(latlng) {
  const lat = latlng.lat.toFixed(5);
  const lng = ((((latlng.lng + 180) % 360) + 360) % 360 - 180).toFixed(5);
  // The /@lat,lng,z/data=!3m1!1e3 form opens Google Maps straight in
  // satellite layer at that point. Worst case Google changes the deep
  // link and it opens regular Maps at the same spot — still correct
  // coordinates, never a wrong place.
  return `https://www.google.com/maps/@${lat},${lng},16z/data=!3m1!1e3`;
}

function bingAerialUrl(latlng) {
  const lat = latlng.lat.toFixed(5);
  const lng = ((((latlng.lng + 180) % 360) + 360) % 360 - 180).toFixed(5);
  return `https://www.bing.com/maps?cp=${lat}~${lng}&lvl=16&style=a`;
}

function openSatellitePopup(latlng) {
  if (!latlng || typeof L === "undefined") return;
  const lat = latlng.lat.toFixed(5);
  const lng = ((((latlng.lng + 180) % 360) + 360) % 360 - 180).toFixed(5);
  const gUrl = googleSatelliteUrl(latlng);
  const bUrl = bingAerialUrl(latlng);
  // The element the nested map is built on, and the pending build.
  // Both are PER POPUP: two satellite popups can be alive at once
  // (Leaflet keeps a closed popup's container in the DOM for 200 ms,
  // while it fades out), and a shared variable would let one popup's
  // map land in the other popup's box.
  let miniHost = null;
  let miniTimer = 0;

  // ── the nested mini map ────────────────────────────────────────────
  // THREE THINGS THIS FIXES (owner report 2026-11-08: *"Uncaught
  // Error: Map container is already initialized"*, from
  // openSatellitePopup):
  //
  //  1. THE HOST IS FOUND THROUGH THE POPUP, NEVER BY A DOCUMENT-WIDE
  //     ID LOOKUP. `document.getElementById("sat-popup-map")` returns
  //     the FIRST element with that id in the document — and the popup
  //     pane can hold MORE THAN ONE satellite popup at once: the one
  //     that is fading out (Leaflet removes a closed popup's container
  //     200 ms AFTER the close) and any "ghost" the auto-restore
  //     re-opened. Picking the wrong one is not cosmetic: Leaflet
  //     REFUSES to initialise a container that already has a map
  //     ("Map container is already initialized" — an uncaught error in
  //     the reader's console), and when it DOES initialise, it
  //     initialises the wrong element, so the popup the reader is
  //     LOOKING AT shows an empty grey box where the satellite should
  //     be. (Measured: opening a second satellite popup inside the
  //     200 ms fade put the map in the OLD, fading popup — the
  //     visible one had no map at all.)
  //  2. AN ORPHANED MAP STILL OWNS AN ELEMENT. Leaflet re-sets a
  //     popup's content as innerHTML, which destroys the element the
  //     map was built on while the MAP ITSELF KEEPS RUNNING (fetching
  //     tiles for ever, behind the popup). The stale `_leaflet_id` is
  //     then the reason the next `L.map()` on that element throws, so
  //     the element is replaced with a fresh one.
  //  3. A FAILURE IS LOGGED, NOT THROWN. An uncaught error in the
  //     reader's console is a red line they can neither silence nor
  //     act on; `XLog.warn` is the house path.
  function dropMini() {
    try { if (_satMiniMap) { _satMiniMap.remove(); } } catch (_) {}
    _satMiniMap = null;
    miniHost = null;
  }

  function buildMini(host) {
    if (!host) return;
    // A map that belongs to ANOTHER popup goes first.
    if (_satMiniMap) {
      if (miniHost === host) return;   // this one is already ours
      dropMini();
    }
    // An orphaned map may still own this element — start from a fresh
    // one, because Leaflet will not initialise a container twice.
    let target = host;
    if (target._leaflet_id) {
      const fresh = target.cloneNode(false);
      fresh.removeAttribute("id");
      if (target.parentNode) target.parentNode.replaceChild(fresh, target);
      target = fresh;
    }
    const sat = TILE_LAYERS["🛰️ Satellite"];
    const url = (sat && sat._url) ||
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
    const attr = (sat && sat.options && sat.options.attribution) ||
      "Source: Esri, Maxar, Earthstar Geographics";
    try {
      _satMiniMap = L.map(target, {
        center: [latlng.lat, latlng.lng],
        zoom: 12,
        zoomControl: true,
        attributionControl: true,
        scrollWheelZoom: false,   // the page keeps its wheel; buttons zoom
        doubleClickZoom: true,
      });
    } catch (err) {
      _satMiniMap = null;
      XLog.warn("[satellite-popup] mini map failed:", err);
      return;
    }
    miniHost = target;
    L.tileLayer(url, { maxZoom: 19, attribution: attr }).addTo(_satMiniMap);
    // The popup finishes its open animation after "add" — size the
    // mini map once the container is real.
    setTimeout(() => { try { _satMiniMap && _satMiniMap.invalidateSize(); } catch (_) {} }, 250);
  }

  const content =
    '<div class="sat-popup">' +
      '<div class="sat-popup-head">' +
        '<span class="sat-popup-title">🛰️ Satellite · ' + lat + ", " + lng + "</span>" +
        '<button class="popup-close-btn" aria-label="Close popup">✕</button>' +
      "</div>" +
      '<div class="sat-popup-map" id="sat-popup-map"></div>' +
      '<div class="sat-popup-links">' +
        '<a href="' + gUrl + '" target="_blank" rel="noopener noreferrer">Google Satellite ↗</a>' +
        '<a href="' + bUrl + '" target="_blank" rel="noopener noreferrer">Bing Aerial ↗</a>' +
        '<button type="button" class="sat-popup-copy">Copy coords</button>' +
      "</div>" +
    "</div>";
  const popup = L.popup({ maxWidth: 420, minWidth: 300, closeButton: false })
    .setLatLng(latlng)
    .setContent(content);

  popup.on("add", () => {
    try {
      const el = popup.getElement();
      if (!el) return;
      const root = el.querySelector(".sat-popup");
      // Clicks inside the popup (including the mini map's pan/zoom)
      // must never bubble into the outer map's click gate — two of
      // them 500 ms apart would open the SUBMITTER over the satellite
      // view. EXCEPTION: the close button must keep bubbling — the
      // central attachPopupClose delegates from the .leaflet-popup
      // element ABOVE this root, so stopping here left ✕ dead.
      // The browser's right-click menu is never touched, so Inspect
      // works over the popup and the mini map too.
      if (root) {
        root.addEventListener("click", (e) => {
          if (e.target && e.target.closest &&
              e.target.closest(".popup-close-btn, .popup-close-btn-mobile")) return;
          e.stopPropagation();
        });
        root.addEventListener("dblclick", (e) => e.stopPropagation());
      }
      const copyBtn = el.querySelector(".sat-popup-copy");
      if (copyBtn) {
        copyBtn.addEventListener("click", () => {
          const text = lat + ", " + lng;
          const done = () => {
            copyBtn.textContent = "✓ Copied";
            setTimeout(() => { copyBtn.textContent = "Copy coords"; }, 1500);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(() => {});
          }
        });
      }
      // The mini map: Esri World Imagery — PLAIN requests, exactly
      // like the Satellite basemap, at z12.
      //
      // TWO hard-won rules (2026-10-29):
      //   · NEVER set crossOrigin on these tiles. Esri answers
      //     Origin-bearing (CORS) requests with flat placeholder JPEGs
      //     in some regions even where a plain <img> of the same URL
      //     returns real imagery (measured: Suriname z10 plain = real,
      //     CORS = mean 26.6/sd 0.35 flat) — and a tainted canvas
      //     cannot be read anyway, so pixel-classification of plain
      //     tiles is impossible. The popup therefore behaves EXACTLY
      //     like the basemap: same coverage, same limits, no clever
      //     zoom-walking (which fought Esri for 20 minutes and still
      //     lost).
      //   · z12, not z16: Esri has no imagery at z16 for much of the
      //     world (ocean, interior Suriname — HTTP 200 with a flat
      //     #CCCCCC JPEG), while z12 is broadly covered (verified at
      //     the reported failure point: mean 25, sd 11 = real canopy).
      //     The zoom buttons let the user push in; where coverage runs
      //     out they see the same grey the basemap would show, and the
      //     Google/Bing links below are the escape hatch.
      // The host is found THROUGH THE POPUP (see buildMini above) and
      // the build is CANCELLED if the popup closes before it runs —
      // otherwise a closed popup's timer fires later and initialises a
      // map in a container that is on its way out.
      miniTimer = setTimeout(() => {
        miniTimer = 0;
        buildMini(el.querySelector(".sat-popup-map"));
      }, 60);
    } catch (err) {
      XLog.warn("[satellite-popup] init failed:", err);
    }
  });
  // Leaflet re-sets a popup's content as innerHTML — which DESTROYS
  // the element the mini map was built on while the map itself keeps
  // running (fetching tiles for ever, behind the popup). Catch it and
  // move the map to the new element.
  popup.on("contentupdate", () => {
    // Nothing built yet? Then the 60 ms timer will do it — this event
    // fires BEFORE "add" (Leaflet sets the content while adding the
    // popup), and building here would put the map on a container
    // whose size is not settled yet.
    if (!_satMiniMap) return;
    const el = popup.getElement();
    const host = el ? el.querySelector(".sat-popup-map") : null;
    if (!host || host === miniHost) return;
    dropMini();
    buildMini(host);
  });
  popup.on("remove", () => {
    if (miniTimer) { clearTimeout(miniTimer); miniTimer = 0; }
    dropMini();
  });

  map.openPopup(popup);
}

map.on("click", (e) => {
  clearSelectedPin();
  if (_highlightedEventId != null) {
    _highlightedEventId = null;
    clearMarkerHighlights();
    renderLinks();
  }
  // Also clear the news-list highlight when user clicks empty map
  // (marker/arc clicks are handled by their own handlers and don't
  // reach this branch in the destructive sense).
  clearActiveHeadlineHighlight();

  // ── Click-to-submit guards ──
  try {
    if (typeof _wrongLoc !== "undefined" && _wrongLoc) return;          // fix-location mode owns clicks
    // Climate probe mode owns clicks (a tap reads the Koppen class instead
    // of opening the submitter).
    if (window.ClimateLayer && typeof window.ClimateLayer.blocksClick === "function" && window.ClimateLayer.blocksClick()) return;
    // Same guard for the temperature probe: while "Probe" is armed a tap
    // reads the temperature instead of opening the submitter.
    if (window.TempLayer && typeof window.TempLayer.blocksClick === "function" && window.TempLayer.blocksClick()) return;
    // Soil / cropland probe modes own clicks the same way.
    if (window.SoilLayer && typeof window.SoilLayer.blocksClick === "function" && window.SoilLayer.blocksClick()) return;
    if (window.CroplandLayer && typeof window.CroplandLayer.blocksClick === "function" && window.CroplandLayer.blocksClick()) return;
    if (window.GeologyLayer && typeof window.GeologyLayer.blocksClick === "function" && window.GeologyLayer.blocksClick()) return;
    if (window.EtopoLayer && typeof window.EtopoLayer.blocksClick === "function" && window.EtopoLayer.blocksClick()) return;
    if (window.WaveLayer && typeof window.WaveLayer.blocksClick === "function" && window.WaveLayer.blocksClick()) return;
    // Magnetic probe: while armed a tap reads D/I instead of opening
    // the submitter.
    if (window.MagLayer && typeof window.MagLayer.blocksClick === "function" && window.MagLayer.blocksClick()) return;
    // Basin probe: while armed a tap reads the basin under the cursor.
    if (window.BasinLayer && typeof window.BasinLayer.blocksClick === "function" && window.BasinLayer.blocksClick()) return;
    if (window.LanguagesLayer && typeof window.LanguagesLayer.blocksClick === "function" && window.LanguagesLayer.blocksClick()) return;
    // The three new overlays own their own probes too: an armed
    // language-region probe, a fault probe or an earthquake popup must
    // not also open the submitter on the same tap.
    if (window.LanguagesRegionsLayer && typeof window.LanguagesRegionsLayer.blocksClick === "function" && window.LanguagesRegionsLayer.blocksClick()) return;
    if (window.FaultLayer && typeof window.FaultLayer.blocksClick === "function" && window.FaultLayer.blocksClick()) return;
    if (window.EarthquakeLayer && typeof window.EarthquakeLayer.blocksClick === "function" && window.EarthquakeLayer.blocksClick()) return;
    // Lightning probe: while armed a tap reads the stroke density
    // instead of opening the submitter.
    if (window.LightningLayer && typeof window.LightningLayer.blocksClick === "function" && window.LightningLayer.blocksClick()) return;
    // Phytoplankton probe: while armed a tap reads the dominant
    // phytoplankton type instead of opening the submitter.
    if (window.PhytoplanktonLayer && typeof window.PhytoplanktonLayer.blocksClick === "function" && window.PhytoplanktonLayer.blocksClick()) return;
    // Ocean-currents probe: while armed a tap reads the current under
    // the cursor instead of opening the submitter.
    if (window.OceanCurrentLayer && typeof window.OceanCurrentLayer.blocksClick === "function" && window.OceanCurrentLayer.blocksClick()) return;
    if (Date.now() - _lastPopupOpenAt < 400) return;                   // this click opened a pin popup
    if (Date.now() - _lastPopupCloseAt < 400) return;                   // this click just dismissed a popup
    const _ov = document.getElementById("submitter-overlay");
    if (_ov && !_ov.hidden) return;                                     // already submitting
    const _exp = document.getElementById("explore-panel");
    if (_exp && !_exp.hidden) return;
    const _hp = document.getElementById("help-panel");
    if (_hp && !_hp.hidden) return;
    if (document.querySelector(".wrong-loc-banner")) return;            // wrong-location banner open
    if (typeof openSubmitAtPoint === "function" && e && e.latlng) {
      // Double-click gate: first click leaves a hint, only a second
      // click within 500 ms / 40 px opens the form.
      const now = Date.now();
      const cpt = e.containerPoint;
      const dbl = !!_submitTap &&
        (now - _submitTap.t) < 500 &&
        !!cpt &&
        Math.hypot(cpt.x - _submitTap.x, cpt.y - _submitTap.y) < 40;
      _submitTap = dbl ? null : { t: now, x: cpt ? cpt.x : 0, y: cpt ? cpt.y : 0 };
      if (!dbl) {
        showSubmitHint(e.containerPoint, e.latlng);
        return;
      }
      // A real double-click: kill the hint and its satellite morph so
      // the offer never appears over the submitter.
      hideSubmitHint();
      openSubmitAtPoint(e.latlng);
    }
  } catch (err) {
    XLog.warn("[click-to-submit] guard failed:", err);
  }
});


// ── Connection detail panel ──────────────────────────────────────────
// Opens a side panel when user clicks a connection arc, showing both
// stories and actions (remove link, add link to another story/location).
function openLinkPanel(nodeA, nodeB, edge) {
  const panel = document.getElementById("link-panel");
  if (!panel) return;

  const reasonText = edgeReasonText(edge);
  const placeRaw = edgePlaceText(edge, nodeA, nodeB);
  const placeBit = placeRaw ? ` @ ${placeRaw}` : "";

  // Use the shared EDGE_COLORS map — the panel used to keep its own copy
  // that was missing "ai" and "semantic", so the badge for the dominant
  // link type rendered gray.
  const kindsBadges = (edge.kinds || []).map(k => {
    const color = EDGE_COLORS[k] || "#94a3b8";
    const label = k === "ai" ? "AI match" : k;
    return `<span class="link-badge" style="background:${color}">${escapeHtml(label)}</span>`;
  }).join("");

  panel.innerHTML = `
    <div class="link-panel-header">
      <h3>Story Connection</h3>
      <button class="link-panel-close" onclick="closeLinkPanel()" aria-label="Close">×</button>
    </div>
    <div class="link-panel-body">
      <div class="link-panel-reason">
        ${kindsBadges}
        <span class="link-reason-text">${reasonText}${placeBit}</span>
      </div>
      <div class="link-panel-story">
        <div class="link-story-label">Story A</div>
        <div class="link-story-headline">${escapeHtml(nodeA.headline)}</div>
        ${nodeA.location ? `<div class="link-story-place">${escapeHtml(nodeA.location.place || '')}</div>` : ''}
        <button class="link-fly-btn" onclick="map.flyTo([${nodeA.location?.lat || 0},${nodeA.location?.lng || 0}], 6)">Fly to</button>
      </div>
      <div class="link-panel-story">
        <div class="link-story-label">Story B</div>
        <div class="link-story-headline">${escapeHtml(nodeB.headline)}</div>
        ${nodeB.location ? `<div class="link-story-place">${escapeHtml(nodeB.location.place || '')}</div>` : ''}
        <button class="link-fly-btn" onclick="map.flyTo([${nodeB.location?.lat || 0},${nodeB.location?.lng || 0}], 6)">Fly to</button>
      </div>
      <div class="link-panel-actions">
        <button class="link-action-btn link-remove-btn" onclick="reportLink(${nodeA.id}, ${nodeB.id}, 'remove')">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Remove this link
        </button>
        <button class="link-action-btn link-add-btn" onclick="startAddLink(${nodeA.id})">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Link to another story
        </button>
        <button class="link-action-btn link-loc-btn" onclick="startAddLinkToLocation(${nodeA.id})">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          Link to a location
        </button>
      </div>
      <div id="link-panel-feedback" class="link-panel-feedback" hidden></div>
    </div>
  `;
  panel.hidden = false;
}

function closeLinkPanel() {
  const panel = document.getElementById("link-panel");
  if (panel) { panel.hidden = true; panel.innerHTML = ""; }
}

async function reportLink(eventA, eventB, kind) {
  const fb = document.getElementById("link-panel-feedback");
  try {
    const r = await fetch("/api/links/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_a: eventA, event_b: eventB, kind }),
    });
    if (r.ok) {
      if (fb) { fb.hidden = false; fb.textContent = "Thanks! Link flagged for review."; fb.className = "link-panel-feedback success"; }
    } else {
      if (fb) { fb.hidden = false; fb.textContent = "Error submitting feedback."; fb.className = "link-panel-feedback error"; }
    }
  } catch (_) {
    if (fb) { fb.hidden = false; fb.textContent = "Network error."; fb.className = "link-panel-feedback error"; }
  }
}

// ── Add link flow ────────────────────────────────────────────────────
let _addLinkEventA = null;
let _addLinkMode = null; // 'story' | 'location'

function startAddLink(eventA) {
  _addLinkEventA = eventA;
  _addLinkMode = "story";
  closeLinkPanel();
  const banner = document.getElementById("add-link-banner");
  if (banner) {
    banner.hidden = false;
    banner.innerHTML = `
      <div class="add-link-banner-inner">
        <span>Click another story marker to link it</span>
        <button onclick="cancelAddLink()">Cancel</button>
      </div>
    `;
  }
  // Highlight event markers as clickable
  document.getElementById("map")?.classList.add("add-link-cursor");
}

function startAddLinkToLocation(eventA) {
  _addLinkEventA = eventA;
  _addLinkMode = "location";
  closeLinkPanel();
  const banner = document.getElementById("add-link-banner");
  if (banner) {
    banner.hidden = false;
    banner.innerHTML = `
      <div class="add-link-banner-inner">
        <span>Click the map to set a location to link to</span>
        <button onclick="cancelAddLink()">Cancel</button>
      </div>
    `;
  }
  document.getElementById("map")?.classList.add("add-link-cursor");
  map.once("click", handleAddLinkLocationClick);
}

async function handleAddLinkLocationClick(ev) {
  const { lat, lng } = ev.latlng;
  cancelAddLink();
  const fb = document.getElementById("link-panel-feedback");
  try {
    const r = await fetch("/api/links/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_a: _addLinkEventA, location_id: null, reason: `Manual link to ${lat.toFixed(2)}, ${lng.toFixed(2)}` }),
    });
    if (r.ok) {
      showTemporaryNotification("Link created!");
    }
  } catch (_) {}
}

function cancelAddLink() {
  _addLinkEventA = null;
  _addLinkMode = null;
  const banner = document.getElementById("add-link-banner");
  if (banner) { banner.hidden = true; banner.innerHTML = ""; }
  document.getElementById("map")?.classList.remove("add-link-cursor");
  map.off("click", handleAddLinkLocationClick);
}

// Wire click-to-link on event markers when in add-link mode.
function handleMarkerClickForLink(ev) {
  if (_addLinkMode !== "story" || !_addLinkEventA) return;
  const marker = ev.target || ev;
  const evId = marker._xyzoEventId;
  if (!evId || evId === _addLinkEventA) return;
  fetch("/api/links/manual", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_a: _addLinkEventA, event_b: evId }),
  }).then(r => {
    if (r.ok) showTemporaryNotification("Link created!");
    cancelAddLink();
  }).catch(() => cancelAddLink());
}

function showTemporaryNotification(msg) {
  const el = document.createElement("div");
  el.className = "temp-notification";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}


// Cheap great-circle interpolator. Slocum's method: linearly interpolate
// the lat/lng in 3D, then normalise back onto the sphere. Accurate enough
// for visual arcs (sub-pixel at any sane zoom); much faster than trig per
// vertex.
function greatCircleArc(a, b, steps) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const lat1 = toRad(a.lat), lon1 = toRad(a.lng);
  const lat2 = toRad(b.lat), lon2 = toRad(b.lng);
  const x1 = Math.cos(lat1) * Math.cos(lon1);
  const y1 = Math.cos(lat1) * Math.sin(lon1);
  const z1 = Math.sin(lat1);
  const x2 = Math.cos(lat2) * Math.cos(lon2);
  const y2 = Math.cos(lat2) * Math.sin(lon2);
  const z2 = Math.sin(lat2);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    const z = z1 + (z2 - z1) * t;
    const norm = Math.sqrt(x * x + y * y + z * z) || 1;
    const lat = Math.asin(z / norm);
    const lon = Math.atan2(y / norm, x / norm);
    pts.push(L.latLng(toDeg(lat), toDeg(lon)));
  }
  return pts;
}

function getActivePinCountForLinks() {
  const cCount = (typeof canvasRenderer !== "undefined" && canvasRenderer && canvasRenderer._enabled && Array.isArray(canvasRenderer._pins))
    ? canvasRenderer._pins.length
    : 0;
  return Math.max(cCount, pinMarkers.size);
}

function refreshLinksToggleTitle() {
  const btn = document.getElementById("ctrl-links-toggle");
  if (!btn) return;
  const hasData = getActivePinCountForLinks() + eventMarkers.size >= 2;
  btn.title = hasData
    ? (linksEnabled ? "Hide story connections" : "Show story connections")
    : "No markers in view — pan / zoom to fetch some";
  btn.checked = !!linksEnabled;
}

function setLinksEnabled(on) {
  linksEnabled = Boolean(on);
  const btn = document.getElementById("ctrl-links-toggle");
  if (btn) {
    // It is a plain Leaflet checkbox inside the layers dropdown now, so
    // the checked state IS the state — no "On"/"Off" text to rewrite.
    btn.checked = linksEnabled;
    btn.setAttribute("aria-pressed", linksEnabled ? "true" : "false");
    const hasData = getActivePinCountForLinks() + eventMarkers.size >= 2;
    btn.title = hasData
      ? (linksEnabled ? "Hide story connections" : "Show story connections")
      : "No markers in view — pan / zoom to fetch some";
  }
  if (typeof window.__syncLinksToggle === "function") window.__syncLinksToggle();
  const legend = document.getElementById("links-legend");
  if (legend) {
    legend.hidden = !linksEnabled;
    legend.setAttribute("aria-hidden", String(!linksEnabled));
  }
  if (linksEnabled) {
    _linksCache = null;
    _linksCacheKey = null;
    _linksCacheAt = 0;
    if (!map.hasLayer(linkLayer)) map.addLayer(linkLayer);
    renderLinks();
  } else {
    linkLayer.clearLayers();
    if (map.hasLayer(linkLayer)) map.removeLayer(linkLayer);
    const linkPanel = document.getElementById("link-panel");
    if (linkPanel) linkPanel.hidden = true;
  }
  if (typeof canvasRenderer !== "undefined" && canvasRenderer && canvasRenderer._enabled) {
    canvasRenderer._scheduleRedraw();
  } else if (typeof pinMarkers !== "undefined" && pinMarkers.size > 0 && typeof renderPins === "function") {
    const pins = Array.from(pinMarkers.values()).map(m => m._pinData).filter(Boolean);
    if (pins.length > 0) {
      pinMarkers.clear();
      if (typeof markerLayer !== "undefined" && markerLayer) markerLayer.clearLayers();
      if (typeof pinCluster !== "undefined" && pinCluster) pinCluster.clearLayers();
      renderPins(pins);
    }
  }
  refreshLinksToggleTitle();
}

// One in-flight viewport fetch at a time. When the user pans/zooms rapidly
// we cancel the previous fetch and start a new one — otherwise requests
// queue up invisibly and the user keeps seeing the OLD viewport's markers
// until the first one lands.
let inflightCtrl = null;
// Active render modes. Markers/heatmap can coexist; markers/clusters are
// mutually exclusive (can't have clustered and unclustered at once).
// Restored from localStorage as comma-separated list.
const activeModes = new Set(["markers"]);
window.activeModes = activeModes;
const MODE_STORAGE_KEY = "xyzo.mapMode";
// Backward-compat: code that reads renderMode as a single string gets the
// "primary" render mode (heatmap > markers > clusters > none).
Object.defineProperty(window, "renderMode", {
  get() {
    if (activeModes.has("heatmap")) return "heatmap";
    if (activeModes.has("markers")) return "markers";
    if (activeModes.has("clusters")) return "clusters";
    return "none";
  },
});

// ── Content layer visibility: News vs Community ──────────────────────
// Orthogonal to render mode. "News" = rss + editorial pins; "Community" =
// user-submitted pins. Persisted to localStorage. Applied server-side via
// the source_type query param on /api/pins/map (and /api/pins) so the
// backend does the filtering and the canvas renderer stays untouched.
const LAYER_PREFS_KEY = "xyzo.layerPrefs";
const layerPrefs = { news: true, community: true };
try {
  const _savedLayers = JSON.parse(localStorage.getItem(LAYER_PREFS_KEY) || "null");
  if (_savedLayers && typeof _savedLayers === "object") {
    if (typeof _savedLayers.news === "boolean") layerPrefs.news = _savedLayers.news;
    if (typeof _savedLayers.community === "boolean") layerPrefs.community = _savedLayers.community;
  }
} catch (_) {}
window.layerPrefs = layerPrefs;

function saveLayerPrefs() {
  try { localStorage.setItem(LAYER_PREFS_KEY, JSON.stringify(layerPrefs)); } catch (_) {}
}

// Build the source_type query fragment for the current layer prefs.
// Returns "" when both layers are on (backend default = everything) or
// both are off — in the both-off case fetchPinsForViewport() early-returns
// before building any URL, and explicit searches deliberately bypass the
// layer filter (search is an explicit user intent).
function layerSourceTypeParam() {
  if (layerPrefs.news && !layerPrefs.community) return "&source_type=rss,editorial";
  if (!layerPrefs.news && layerPrefs.community) return "&source_type=community";
  return "";
}

// True when at least one content layer is visible.
function anyLayerVisible() {
  return layerPrefs.news || layerPrefs.community;
}

function syncLayerButtons() {
  const newsBtn = document.getElementById("layer-news-btn");
  const commBtn = document.getElementById("layer-community-btn");
  if (newsBtn) {
    newsBtn.setAttribute("aria-pressed", String(layerPrefs.news));
    newsBtn.classList.toggle("layer-off", !layerPrefs.news);
  }
  if (commBtn) {
    commBtn.setAttribute("aria-pressed", String(layerPrefs.community));
    commBtn.classList.toggle("layer-off", !layerPrefs.community);
  }
}

function initLayerToggles() {
  const newsBtn = document.getElementById("layer-news-btn");
  const commBtn = document.getElementById("layer-community-btn");
  syncLayerButtons();
  newsBtn?.addEventListener("click", () => {
    layerPrefs.news = !layerPrefs.news;
    saveLayerPrefs();
    syncLayerButtons();
    fetchPinsForViewport();
  });
  commBtn?.addEventListener("click", () => {
    layerPrefs.community = !layerPrefs.community;
    saveLayerPrefs();
    syncLayerButtons();
    fetchPinsForViewport();
  });
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initLayerToggles);
} else {
  initLayerToggles();
}

// Active time range. Default "24h" (last 24 hours); the toggle offers
// 24h | 7d | 30d | 365d | custom | all. Restored from localStorage along
// with the custom-days count.
let timeFilter = "24h";
let customDays = 7;  // 1-90; only meaningful when timeFilter === "custom"
const TIME_STORAGE_KEY = "xyzo.timeFilter";
const CUSTOM_DAYS_STORAGE_KEY = "xyzo.customDays";

// User-selectable pin density: low(500) / medium(1500) / high(2500) / max(3000)
// Higher = more pins globally but heavier on GPU/network.
const PIN_DENSITY_STORAGE_KEY = "xyzo.pinDensity";
const PIN_DENSITY_MAP = { low: 500, medium: 1500, high: 2500, max: 3000 };
let pinDensity = "medium"; // default, restored from localStorage below
try {
  const stored = localStorage.getItem(PIN_DENSITY_STORAGE_KEY);
  if (stored && PIN_DENSITY_MAP[stored]) pinDensity = stored;
} catch (_) {}

// ── Debounce / throttle ──────────────────────────────────────────────
// debounce: collapse bursts into one trailing call.
// throttle: collapse bursts but always fire at most once every `ms`, and
// immediately on the leading edge (so the map reacts right when you finish
// a pan/zoom).
function debounce(fn, ms) {
  let t = null;
  const debounced = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
  debounced.cancel = () => {
    if (t) {
      clearTimeout(t);
      t = null;
    }
  };
  return debounced;
}
function throttle(fn, ms) {
  let last = 0, t = null, lastArgs = null;
  return (...args) => {
    const now = Date.now();
    lastArgs = args;
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else if (!t) {
      const wait = ms - (now - last);
      t = setTimeout(() => {
        last = Date.now();
        t = null;
        fn(...lastArgs);
      }, wait);
    }
  };
}

// LRUMap — Map with an upper bound. When full, the oldest entry is evicted
// on the next set(). Re-setting an existing key promotes it to the most
// recently used position (delete + set). Used for caches that would
// otherwise grow unboundedly as the user explores different keys (image
// URLs, marker icons, …). Map iteration order is insertion order, so the
// first key is always the least recently inserted/used.
class LRUMap extends Map {
  constructor(maxSize) {
    super();
    this.maxSize = Math.max(1, maxSize | 0);
  }
  set(key, value) {
    if (super.has(key)) super.delete(key);
    super.set(key, value);
    while (super.size > this.maxSize) {
      const firstKey = super.keys().next().value;
      if (firstKey === undefined) break;
      super.delete(firstKey);
    }
    return this;
  }
  // Resize at runtime — useful if a config value changes after init.
  resize(maxSize) {
    this.maxSize = Math.max(1, maxSize | 0);
    while (super.size > this.maxSize) {
      const firstKey = super.keys().next().value;
      if (firstKey === undefined) break;
      super.delete(firstKey);
    }
    return this;
  }
}

// THE TIME MACHINE's window.
//
// When the reader has picked a past moment, the news drawn is the news
// OF THAT DAY — so the window has BOTH ends: `since` the start of that
// day and `until` its end. Without the other end, "the news of 3 March"
// would be every story since 3 March.
function searchWindow() {
  const A = window.WeatherArchive;
  if (A && typeof A.active === "function" && A.active()) {
    return { since: A.dayStart(), until: A.dayEnd() };
  }
  return { since: getSinceDate(timeFilter), until: null };
}

function getSinceDate(filter) {
  // Snap now to 60-second boundary so repeat navigations share the cached response
  const now = Math.floor(Date.now() / 60000) * 60000;
  if (filter === "24h")  return new Date(now - 1 * 24 * 3600 * 1000).toISOString();
  if (filter === "3d")   return new Date(now - 3 * 24 * 3600 * 1000).toISOString();
  if (filter === "7d")   return new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  if (filter === "30d")  return new Date(now - 30 * 24 * 3600 * 1000).toISOString();
  if (filter === "365d") return new Date(now - 365 * 24 * 3600 * 1000).toISOString();
  if (filter === "custom") {
    // Clamp to the [1, 90] day range the UI enforces. If customDays ever
    // lands outside that window we silently snap to the nearest valid value
    // rather than letting the API get a confusing date.
    const days = Math.max(1, Math.min(90, Math.floor(customDays) || 1));
    return new Date(now - days * 24 * 3600 * 1000).toISOString();
  }
  return null;          // "all"
}

// ── Fetch for current viewport ────────────────────────────────────────
// Single request per viewport change. The backend returns up to `limit`
// newest pins inside the bbox with the active time filter, plus a
// `has_more` flag and `next_cursor` for forward pagination.
//
// Cursor pagination: the frontend sends `?before=<cursor>` for page 2+,
// and the API encodes a cursor in `next_cursor` (api/src/routes/pins.ts
// via encodeCursor in api/src/cursors.ts), but the /pins handler does
// NOT yet decode it — progressive pagination effectively fetches the
// same first page over and over. Backend cursor support is tracked as
// task #92. Until then we just enforce an upper bound on render.
const ZOOM_LIMITS = [
  [3,        2500],  // z 0–2  (world: 2500 pins — canvas renders efficiently across the globe)
  [5,        3000],  // z 3–4  (continent view)
  [8,        4000],  // z 5–7  (continent / country)
  [11,       5000],  // z 8–10 (region / city)
  [13,       6000],  // z 11–12 (neighborhood / street)
  [15,       7000],  // z 13–14 (block level)
  [Infinity, 8000],  // z 15+  (detailed view)
];

function pickLimitForZoom(z) {
  for (const [max, lim] of ZOOM_LIMITS) if (z < max) return lim;
  return 1200;
}

function pickCanvasLimitForZoom(z) {
  const hwCap = getClientHardwareCapabilities();
  const baseLimit = pickLimitForZoom(z);
  // Density scales the zoom limit: low=33%, medium=100%, high=167%, max=200%.
  // This way density has a visible effect at every zoom level without
  // creating absurd pin counts at low zoom.
  const densityScale = { low: 0.33, medium: 1.0, high: 1.67, max: 2.0 };
  const densityCap = { low: 2000, medium: 3000, high: 5000, max: 6000 };
  const API_MAX_LIMIT = 2000; // API caps limit at 2000
  const scale = densityScale[pinDensity] ?? 1.0;
  const cap = densityCap[pinDensity] ?? 3000;
  let result;
  if (scale <= 1.0) {
    // For low/medium, cap at hardware limit
    const hwSafe = Math.min(baseLimit, hwCap.canvasMax);
    result = Math.min(Math.round(hwSafe * scale), cap);
  } else {
    // For high/max, allow exceeding canvasMax up to the density-specific cap
    result = Math.min(Math.round(baseLimit * scale), cap);
  }
  return Math.min(result, API_MAX_LIMIT);
}

// ── Client Hardware & Server Guardrail Managers ──────────────────────
function getClientHardwareCapabilities() {
  const logicalCores = navigator.hardwareConcurrency || 4;
  const memoryGb = navigator.deviceMemory || 4;
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  // DOM markers need conservative limits
  let maxSafe = Math.round(logicalCores * 150 + memoryGb * 75);
  if (isMobile) maxSafe = Math.min(maxSafe, 500);
  maxSafe = Math.max(350, Math.min(maxSafe, 1800));

  // Canvas pins can handle much more - 3x DOM limit
  const canvasMax = Math.round(maxSafe * 3);

  return { logicalCores, memoryGb, isMobile, maxSafe, canvasMax };
}

let _hardwareWarningDismissed = false;
let _serverGuardrailDismissed = false;

function ensureGuardrailContainer() {
  let el = document.getElementById("performance-guardrail-container");
  if (!el) {
    el = document.createElement("div");
    el.id = "performance-guardrail-container";
    el.className = "performance-guardrail-container";
    document.body.appendChild(el);
  }
  return el;
}

function checkClientHardwareLimits(renderedCount) {
  const container = ensureGuardrailContainer();
  let warnCard = document.getElementById("guardrail-card-hardware");

  const caps = getClientHardwareCapabilities();
  if (renderedCount > caps.maxSafe && !_hardwareWarningDismissed) {
    if (!warnCard) {
      warnCard = document.createElement("div");
      warnCard.id = "guardrail-card-hardware";
      warnCard.className = "guardrail-card warning-hardware";
      container.appendChild(warnCard);
    }
    warnCard.innerHTML = `
      <div class="guardrail-header">
        <div class="guardrail-title hardware">
          <span>⚠️</span> <strong>Client Hardware Performance Warning</strong>
        </div>
        <button class="guardrail-close" onclick="dismissHardwareWarning()">&times;</button>
      </div>
      <div class="guardrail-body">
        Currently displaying <strong>${renderedCount} active markers</strong> on your system. 
        Based on your system specs (${caps.logicalCores} CPU threads, ${caps.memoryGb} GB RAM), 
        your recommended threshold is <strong>${caps.maxSafe} markers</strong> to prevent browser DOM lag.
      </div>
      <div class="guardrail-metrics">
        <div class="guardrail-metric-item"><span>CPU Cores:</span> ${caps.logicalCores}</div>
        <div class="guardrail-metric-item"><span>System RAM:</span> ${caps.memoryGb} GB</div>
        <div class="guardrail-metric-item"><span>Safe Cap:</span> ${caps.maxSafe}</div>
      </div>
      <div class="guardrail-actions">
        <button class="guardrail-btn" onclick="if(typeof setRenderMode==='function') setRenderMode('clusters'); dismissHardwareWarning();">Enable Clustering</button>
        <button class="guardrail-btn" onclick="if(typeof setRenderMode==='function') setRenderMode('heatmap'); dismissHardwareWarning();">Heatmap Mode</button>
        <button class="guardrail-btn" onclick="if(typeof setTimeFilter==='function') setTimeFilter('24h'); dismissHardwareWarning();">Filter 24h</button>
        <button class="guardrail-btn" onclick="if(typeof map!=='undefined') map.zoomIn(); dismissHardwareWarning();">Zoom In</button>
      </div>
    `;
    warnCard.hidden = false;
  } else if (warnCard) {
    warnCard.hidden = true;
  }
}

function checkServerGuardrails(body) {
  const container = ensureGuardrailContainer();
  let serverCard = document.getElementById("guardrail-card-server");

  const isGlobalAllTime = (timeFilter === "all" || !timeFilter) && typeof map !== "undefined" && map.getZoom() <= 3;
  const isCapped = body && body.guardrail && body.guardrail.applied;

  if ((isCapped || isGlobalAllTime) && !_serverGuardrailDismissed) {
    if (!serverCard) {
      serverCard = document.createElement("div");
      serverCard.id = "guardrail-card-server";
      serverCard.className = "guardrail-card warning-server";
      container.appendChild(serverCard);
    }
    const ramSaved = body?.guardrail?.estimated_server_resource_saved?.ram_mb || 185;
    const cpuSaved = body?.guardrail?.estimated_server_resource_saved?.cpu_time_ms || 1450;
    
    serverCard.innerHTML = `
      <div class="guardrail-header">
        <div class="guardrail-title server">
          <span>🛡️</span> <strong>Server Resource Guardrail Active</strong>
        </div>
        <button class="guardrail-close" onclick="dismissServerGuardrail()">&times;</button>
      </div>
      <div class="guardrail-body">
        Full database scan is capped to protect shared resources. Fetching 50,000+ un-bounded historical items across the full globe requires 
        <strong>~${ramSaved} MB of server RAM</strong> and <strong>~${cpuSaved} ms of CPU execution time</strong> per query on our database. 
        Requests are capped to keep the API server fast and responsive for all users.
      </div>
      <div class="guardrail-metrics">
        <div class="guardrail-metric-item"><span>RAM Saved:</span> ~${ramSaved} MB</div>
        <div class="guardrail-metric-item"><span>CPU Saved:</span> ~${cpuSaved} ms</div>
        <div class="guardrail-metric-item"><span>Cap Limit:</span> 1,200 pins</div>
      </div>
      <div class="guardrail-actions">
        <button class="guardrail-btn" onclick="if(typeof setTimeFilter==='function') setTimeFilter('7d'); dismissServerGuardrail();">View Last 7 Days</button>
        <button class="guardrail-btn" onclick="if(typeof map!=='undefined') map.setZoom(6); dismissServerGuardrail();">Zoom to Region</button>
      </div>
    `;
    serverCard.hidden = false;
  } else if (serverCard) {
    serverCard.hidden = true;
  }
}

function dismissHardwareWarning() {
  _hardwareWarningDismissed = true;
  const el = document.getElementById("guardrail-card-hardware");
  if (el) el.hidden = true;
}

function dismissServerGuardrail() {
  _serverGuardrailDismissed = true;
  const el = document.getElementById("guardrail-card-server");
  if (el) el.hidden = true;
}

// ── Client-Side In-Memory Spatial Cache Store ──────────────────────
class ClientPinStore {
  constructor() {
    this.pinsById = new Map();
    this.spatialTiles = new Map(); // "lat_lng" -> Set(pinId)
  }

  getTileKey(lat, lng) {
    const tileLat = Math.floor(lat / 2) * 2;
    const tileLng = Math.floor(lng / 2) * 2;
    return `${tileLat}_${tileLng}`;
  }

  addPins(pins) {
    if (!Array.isArray(pins)) return;
    for (const p of pins) {
      if (!p || p.id == null) continue;
      this.pinsById.set(p.id, p);
      const lat = p.location?.lat ?? p.lat;
      const lng = p.location?.lng ?? p.lng;
      if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
        const key = this.getTileKey(lat, lng);
        if (!this.spatialTiles.has(key)) this.spatialTiles.set(key, new Set());
        this.spatialTiles.get(key).add(p.id);
      }
    }
  }

  getPinsForBbox(w, s, e, n) {
    const minTileLat = Math.floor(Math.max(-90, s) / 2) * 2;
    const maxTileLat = Math.floor(Math.min(90, n) / 2) * 2;

    const results = [];
    const seen = new Set();

    const collectTiles = (minLng, maxLng) => {
      const minTileLng = Math.floor(minLng / 2) * 2;
      const maxTileLng = Math.floor(maxLng / 2) * 2;
      for (let tLat = minTileLat; tLat <= maxTileLat; tLat += 2) {
        for (let tLng = minTileLng; tLng <= maxTileLng; tLng += 2) {
          const key = `${tLat}_${tLng}`;
          const ids = this.spatialTiles.get(key);
          if (ids) {
            for (const id of ids) {
              if (!seen.has(id)) {
                seen.add(id);
                const p = this.pinsById.get(id);
                if (p) results.push(p);
              }
            }
          }
        }
      }
    };

    if (w <= e) {
      collectTiles(w, e);
    } else {
      collectTiles(w, 180);
      collectTiles(-180, e);
    }
    return results;
  }
}

const clientPinStore = new ClientPinStore();

// ── Canvas Pin Renderer (world view fast path) ────────────────────────
// Renders pins as colored circles on an HTML5 Canvas overlay instead of
// creating individual L.marker DOM elements. At world/continent zoom
// (z ≤ 3) with 500-2000 pins this avoids thousands of DOM nodes and
// cuts initial render from several seconds to a single frame.
const CANVAS_CAT_COLORS = {
  adventure: "#ec4899",
  agriculture: "#16a34a",
  ai: "#7c3aed",
  aid: "#1e3a8a",
  art: "#6d28d9",
  athletics: "#a7f3d0",
  automotive: "#ca8a04",
  aviation: "#06b6d4",
  banking: "#ca8a04",
  basketball: "#047857",
  biology: "#831843",
  books: "#7c3aed",
  business: "#16a34a",
  celebration: "#ec4899",
  climate: "#0891b2",
  community: "#22d3ee",
  concert: "#8b5cf6",
  conflict: "#b91c1c",
  corruption: "#f59e0b",
  courts: "#ef4444",
  cricket: "#10b981",
  crime: "#dc2626",
  crypto: "#16a34a",
  culture: "#3730a3",
  cybercrime: "#3b0d7a",
  cybersecurity: "#3b0d7a",
  cyclone: "#3b82f6",
  deforestation: "#065f46",
  demographics: "#fb7185",
  development: "#22d3ee",
  diplomacy: "#f97316",
  disaster: "#4f46e5",
  drought: "#d97706",
  earthquake: "#4338ca",
  economy: "#15803d",
  education: "#8b5cf6",
  elections: "#dc2626",
  employment: "#d97706",
  energy: "#155e75",
  entertainment: "#ec4899",
  environment: "#84cc16",
  epidemic: "#0d9488",
  family: "#ec4899",
  farming: "#16a34a",
  festivals: "#312e81",
  film: "#4f46e5",
  finance: "#a16207",
  floods: "#1d4ed8",
  food: "#f97316",
  gaming: "#6d28d9",
  geopolitics: "#d97706",
  government: "#991b1b",
  health: "#99f6e4",
  healthcare: "#5eead4",
  heatwave: "#f59e0b",
  hobbies: "#ec4899",
  housing: "#ca8a04",
  human: "#ec4899",
  human_rights: "#be123c",
  humanitarian: "#881337",
  humor: "#ec4899",
  immigration: "#ea580c",
  inequality: "#e11d48",
  inspiration: "#ec4899",
  labor: "#d97706",
  literature: "#7c3aed",
  love: "#ec4899",
  manufacturing: "#92400e",
  maritime: "#0891b2",
  markets: "#eab308",
  medical: "#2dd4bf",
  medicine: "#9d174d",
  mental_health: "#14b8a6",
  military: "#b91c1c",
  missing: "#dc2626",
  motorsport: "#065f46",
  music: "#8b5cf6",
  olympics: "#34d399",
  other: "#64748b",
  outbreak: "#0d9488",
  pets: "#047857",
  physics: "#ec4899",
  podcast: "#7c3aed",
  policy: "#b45309",
  politics: "#7f1d1d",
  pollution: "#0e7490",
  poverty: "#9f1239",
  protest: "#fb923c",
  racing: "#22c55e",
  rail: "#0e7490",
  realestate: "#ca8a04",
  recipe: "#f97316",
  refugees: "#f43f5e",
  religion: "#4338ca",
  research: "#db2777",
  restaurant: "#f97316",
  retail: "#713f12",
  sanctions: "#ca8a04",
  science: "#ec4899",
  shipping: "#5c3d0e",
  shooting: "#dc2626",
  snow: "#60a5fa",
  soccer: "#059669",
  social_issues: "#fda4af",
  software: "#4c1d95",
  space: "#be185d",
  sports: "#86efac",
  startups: "#854d0e",
  storm: "#2563eb",
  streaming: "#8b5cf6",
  swimming: "#6ee7b7",
  technology: "#8b5cf6",
  telecom: "#5b21b6",
  tennis: "#4ade80",
  terrorism: "#b91c1c",
  theater: "#5b21b6",
  trade: "#b45309",
  traffic: "#ea580c",
  transit: "#06b6d4",
  vaccines: "#0f766e",
  volcano: "#3730a3",
  war: "#b91c1c",
  water: "#059669",
  weather: "#60a5fa",
  weather_alert: "#f59e0b",
  wildfire: "#1e40af",
  wildlife: "#047857",
  wine: "#7c3aed",
};




// ── Canvas Pin Renderer ──────────────────────────────────────────────
// This is the fast path for rendering thousands of pins on the map.
// Instead of creating DOM elements for each pin (slow), we draw them
// all on a single HTML5 canvas. It's like painting a mural instead of
// hanging 50,000 individual pictures. Same result, way faster.
//
// "Why canvas and not DOM markers?"
// Because at world zoom, you might have 5,000+ pins visible. Creating
// 5,000 DOM elements would make the browser cry. Canvas handles it
// smoothly. The trade-off? We lose some interactivity (no CSS hover
// effects), but we solve that with a "ghost" div that follows the mouse.
//
// "What's the ghost?"
// When you hover over a canvas pin, we create a temporary DOM element
// that looks like the pin and follows your cursor. It's like a ghost
// of the pin that got away. The canvas pin is still there; the ghost
// is just for visual feedback.
class CanvasPinRenderer {
  constructor(map) {
    this._map = map;
    this._canvas = null;
    this._ghost = null;
    this._pins = [];
    this._rawPins = [];
    this._enabled = false;
    this._rafId = null;
    this._hoverRafId = null;

    // Fixed event listener references to prevent memory/handler leaks on disable/enable
    // (Yes, we learned this the hard way. Memory leaks are sneaky little devils.)
    this._onMoveEnd = this._scheduleRedraw.bind(this);
    this._onMove = this._scheduleRedraw.bind(this);
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseLeave = this._handleMouseLeave.bind(this);
    this._onMapClick = this._handleMapClick.bind(this);
  }

  _radiusForZoom(zoom) {
    return zoom <= 1 ? 5 : zoom <= 2 ? 7 : zoom <= 4 ? 9
         : zoom <= 6 ? 11 : zoom <= 8 ? 13 : zoom <= 10 ? 15
         : zoom <= 12 ? 17 : 19;
  }

  enable() {
    if (this._enabled) return;
    this._enabled = true;
    const overlayPane = this._map.getPane("overlayPane");
    
    // Canvas element
    this._canvas = document.createElement("canvas");
    const showCanvas = activeModes.has("markers") || activeModes.has("clusters");
    this._canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:auto;" + (showCanvas ? "" : "display:none;");
    this._canvas.className = "xyzo-canvas-pins";
    // The pin canvas is not in the DOM tree for assistive tech — without
    // this a screen reader sees an unlabelled, untyped element.
    this._canvas.setAttribute("role", "img");
    this._canvas.setAttribute("aria-label",
      "News story pins drawn on the map. Use the Explore panel or the search box to reach stories without a pointer.");
    overlayPane.appendChild(this._canvas);

    // The hover ring. It is the SHARED element (hover-ring.js), not one
    // of this renderer's own: the earthquakes and any other point
    // overlay draw the same ring, and two elements with the same class
    // would mean two circles could be on screen at once — and that a
    // query for ".xyzo-pin-hover-ghost" could find the wrong one.
    // It is a real DOM node so DevTools Inspector (Ctrl+Shift+C) can
    // target the hovered pin.
    // NEVER create a second element with the ring's class. The pin
    // renderer used to fall back to building its own
    // ".xyzo-pin-hover-ghost" when hover-ring.js was not on the page
    // — and a fallback that makes a DUPLICATE of the shared element
    // is worse than no ring at all: two circles could be on screen at
    // once, and a query for the class could find the wrong one.
    //
    // So there is no fallback. If the shared module is missing there
    // is no ring, and the log says so.
    this._ghost = window.HoverRing && typeof window.HoverRing.el === "function"
      ? window.HoverRing.el(this._map)
      : null;
    if (!this._ghost) {
      XLog.warn("hover-ring.js is not loaded — the pin hover ring is unavailable");
    }

    // Bind map & canvas events using fixed references
    this._map.on("moveend", this._onMoveEnd);
    this._map.on("zoomend", this._onMoveEnd);
    this._map.on("resize", this._onMoveEnd);
    this._map.on("move", this._onMove);

    this._canvas.addEventListener("mousemove", this._onMouseMove);
    this._canvas.addEventListener("mousedown", this._onMouseDown);
    this._canvas.addEventListener("mouseleave", this._onMouseLeave);
    this._map.on("click", this._onMapClick);

    // ── ResizeObserver: re-draw when container gets sized ────────────
    // On first load from a shared link, the map container can start at
    // 0×0 and grow to its final size after CSS layout commits.  Without
    // this, pins are drawn once at 0×0 (off-screen) and never re-drawn.
    const mapContainer = this._map.getContainer();
    if (mapContainer && typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => {
        if (!this._enabled) return;
        // Force Leaflet to recalculate its internal size cache from
        // the container's actual DOM dimensions.  invalidateSize()
        // handles the cache internally — never set _size directly,
        // since getSize() does `return this._size.clone(...)` and a
        // null/non-Point value crashes every subsequent map call.
        this._map.invalidateSize({ animate: false });
        const sz = this._map.getSize();
        if (sz.x > 10 && sz.y > 10) {
          this._drawRetries = 0;
          this._scheduleRedraw();
        }
      });
      this._ro.observe(mapContainer);
    }

    this._scheduleRedraw();
  }

  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    if (this._hoverRafId) { cancelAnimationFrame(this._hoverRafId); this._hoverRafId = null; }
    if (this._ro) { this._ro.disconnect(); this._ro = null; }

    this._map.off("moveend", this._onMoveEnd);
    this._map.off("zoomend", this._onMoveEnd);
    this._map.off("resize", this._onMoveEnd);
    this._map.off("move", this._onMove);
    this._map.off("click", this._onMapClick);

    if (this._canvas) {
      this._canvas.removeEventListener("mousemove", this._onMouseMove);
      this._canvas.removeEventListener("mousedown", this._onMouseDown);
      this._canvas.removeEventListener("mouseleave", this._onMouseLeave);
      this._canvas.remove();
      this._canvas = null;
    }
    if (this._ghost) {
      // HIDE it, do not REMOVE it. The element belongs to hover-ring.js
      // and is shared with the earthquakes, the faults and every other
      // point overlay — removing it here took the ring away from all
      // of them the moment the markers layer was switched off.
      if (window.HoverRing && typeof window.HoverRing.hide === "function") {
        window.HoverRing.hide("pin");
      } else {
        this._ghost.classList.add("hidden");
      }
      this._ghost = null;
    }
    this._pins = [];
  }

  setPins(pins) {
    // The ORIGINAL pins, in their true positions. `this._pins` is a
    // SPREAD copy — the canvas nudges overlapping pins apart so they
    // do not hide each other — and a spread position is a lie about
    // where a story happened, so the exporter must never use it.
    this._rawPins = pins && pins.length ? pins.slice() : [];
    if (pins && pins.length) {
      const zoom = this._map ? this._map.getZoom() : 8;
      if (zoom >= 7 && typeof spreadOverlappingPins === "function") {
        this._pins = spreadOverlappingPins(pins);
      } else {
        this._pins = pins;
      }
    } else {
      this._pins = [];
    }
    if (this._enabled) {
      this._scheduleRedraw();
      // Fallback: if the canvas is still 0-sized after the first draw,
      // schedule a delayed redraw.  This catches the case where the
      // ResizeObserver fires but the container size check races with
      // the browser's layout engine.
      if (!this._hasDrawnOnce) {
        this._hasDrawnOnce = true;
        setTimeout(() => {
          if (this._enabled && this._canvas) {
            const sz = this._map.getSize();
            if (sz.x > 10 && sz.y > 10 && this._canvas.width < 10) {
              this._scheduleRedraw();
            }
          }
        }, 500);
      }
    }
  }

  _scheduleRedraw() {
    if (!this._enabled) return;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => this._draw());
  }

  _draw() {
    this._rafId = null;
    if (!this._canvas || !this._enabled) return;
    let mapSize = this._map.getSize();
    // Guard: if container has 0 dimensions (CSS not yet committed), skip
    // this frame entirely.  Drawing pins on a synthetic canvas at this
    // stage produces pins at wrong positions because Leaflet's internal
    // latLngToContainerPoint uses the (still-0) cached size, so the
    // resulting pin coordinates don't match the canvas we draw onto.
    // Wait for the ResizeObserver to fire a real, layout-committed size.
    // Cap at 60 frames (~1 second) to avoid an infinite loop if the
    // container is genuinely zero-sized (e.g., hidden tab).
    if (mapSize.x < 10 || mapSize.y < 10) {
      if (!this._drawRetries) this._drawRetries = 0;
      if (this._drawRetries < 60) {
        this._drawRetries++;
        // invalidateSize() refreshes Leaflet's internal _size from the
        // DOM; belt-and-braces in case ResizeObserver has already fired
        // but Leaflet's cache hasn't been rebuilt.
        this._map.invalidateSize({ animate: false });
        this._rafId = requestAnimationFrame(() => this._draw());
      }
      return;
    }
    this._drawRetries = 0;
    const dpr = window.devicePixelRatio || 1;
    const buffer = Math.round(Math.max(mapSize.x, mapSize.y) * 0.25);
    const canvasW = mapSize.x + buffer * 2;
    const canvasH = mapSize.y + buffer * 2;
    this._canvas.width = canvasW * dpr;
    this._canvas.height = canvasH * dpr;
    this._canvas.style.width = canvasW + "px";
    this._canvas.style.height = canvasH + "px";

    const topLeft = this._map.containerPointToLayerPoint([-buffer, -buffer]);
    L.DomUtil.setPosition(this._canvas, topLeft);

    const ctx = this._canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasW, canvasH);

    const radius = this._radiusForZoom(this._map.getZoom());
    const cullPad = radius * 3;  // generous pad so zoom-animation frames don't cull edge pins
    let selectedPt = null;
    let drawnCount = 0;

    for (const p of this._pins) {
      if (!matchesActiveCategoryFilters(p)) continue;
      // API returns location nested: { location: { lat, lng } }. Some legacy
      // paths flatten to top-level lat/lng. Accept both (matches the rest of
      // the renderer at lines 2780, 3225, 3511, 3741).
      const lat = p.location?.lat ?? p.lat;
      const lng = p.location?.lng ?? p.lng;
      if (typeof lat !== "number" || typeof lng !== "number") continue;
      const pt = this._map.latLngToContainerPoint([lat, lng]);
      const x = pt.x + buffer;
      const y = pt.y + buffer;
      if (x < -cullPad || x > canvasW + cullPad || y < -cullPad || y > canvasH + cullPad) continue;
      if (p.isOverflowBadge) {
        ctx.save();
        const bRadius = Math.max(12, radius + 2);
        ctx.beginPath();
        ctx.arc(x, y, bRadius, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(15, 23, 42, 0.96)";
        ctx.fill();

        ctx.lineWidth = 2;
        ctx.strokeStyle = "#0ea5e9";
        ctx.shadowColor = "rgba(14, 165, 233, 0.7)";
        ctx.shadowBlur = 6;
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        const fontSize = p.overflowCount >= 100 ? 9 : 10;
        ctx.font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const badgeText = p.overflowCount > 999 ? `+${Math.floor(p.overflowCount / 1000)}k` : `+${p.overflowCount}`;
        ctx.fillText(badgeText, x, y);
        ctx.restore();
        drawnCount++;
      } else {
        const cat = p.category || p.c || "other";
        const iconCanvas = _getIconCanvas(cat, radius);
        ctx.drawImage(iconCanvas, x - radius, y - radius, radius * 2, radius * 2);
        drawnCount++;

        // Top story highlight: glowing red circular ring (only in clusters mode or links mode for clean main markers)
        const highlightTop = typeof shouldHighlightTopStories === "function" && shouldHighlightTopStories();
        if (highlightTop && typeof isTopStoryPin === "function" && isTopStoryPin(p)) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, y, radius + 3.5, 0, Math.PI * 2);
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = "#ef4444";
          ctx.shadowColor = "rgba(239, 68, 68, 0.85)";
          ctx.shadowBlur = 8;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(x, y, radius + 1, 0, Math.PI * 2);
          ctx.lineWidth = 1;
          ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
          ctx.stroke();
          ctx.restore();
        }
      }

      const pIdStr = p.id != null ? String(p.id) : null;
      const pEidStr = p.event_id != null ? String(p.event_id) : pIdStr;
      if (
        (_selectedPinId != null && pIdStr === _selectedPinId) ||
        (_selectedEventId != null && pEidStr === _selectedEventId) ||
        (_highlightedEventId != null && (pEidStr === String(_highlightedEventId) || pIdStr === String(_highlightedEventId)))
      ) {
        selectedPt = { x, y };
      }
    }

    this._lastDrawnCount = drawnCount;
    // FIX_NOTES 3.3: _draw runs every animation frame during drags; the
    // O(n) filter + innerHTML write belongs on a 250 ms throttle.
    if (typeof updateActiveFilterIndicator === "function") {
      const _fitNow = Date.now();
      if (!this._lastFilterIndicatorAt || _fitNow - this._lastFilterIndicatorAt > 250) {
        this._lastFilterIndicatorAt = _fitNow;
        updateActiveFilterIndicator();
      }
    }

    if (selectedPt) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(selectedPt.x, selectedPt.y, radius + 5, 0, Math.PI * 2);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "#ef4444";
      ctx.shadowColor = "rgba(239, 68, 68, 0.9)";
      ctx.shadowBlur = 10;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(selectedPt.x, selectedPt.y, radius + 1, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.restore();
    }
  }

  _hitTest(e) {
    if (!this._canvas) return null;
    const rect = this._canvas.getBoundingClientRect();
    const mapSize = this._map.getSize();
    const buffer = Math.round(Math.max(mapSize.x, mapSize.y) * 0.25);
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const radius = this._radiusForZoom(this._map.getZoom());
    const hitR = radius * 1.4 + 4;
    let best = null, bestDist = hitR * hitR;
    for (const p of this._pins) {
      if (!matchesActiveCategoryFilters(p)) continue;
      const lat = p.location?.lat ?? p.lat;
      const lng = p.location?.lng ?? p.lng;
      if (typeof lat !== "number" || typeof lng !== "number") continue;
      const pt = this._map.latLngToContainerPoint([lat, lng]);
      const px = pt.x + buffer;
      const py = pt.y + buffer;
      const dx = px - mx, dy = py - my;
      const d2 = dx * dx + dy * dy;
      const pinHitR = p.isOverflowBadge ? (radius + 6) : hitR;
      const pinHitR2 = pinHitR * pinHitR;
      if (d2 < pinHitR2 && d2 < bestDist) { bestDist = d2; best = p; }
    }
    return best;
  }

  _handleMouseMove(e) {
    if (this._hoverRafId) return;
    this._hoverRafId = requestAnimationFrame(() => {
      this._hoverRafId = null;
      const hitPin = this._hitTest(e);
      if (hitPin) {
        if (this._canvas) this._canvas.style.cursor = "pointer";
        this._showGhost(hitPin);
      } else {
        if (this._canvas) this._canvas.style.cursor = "";
        this._hideGhost();
      }
      // Feed the hover HUD (hover-info.js). It reuses this hit-test —
      // a second one per mousemove would double the cost for no gain.
      try {
        window.dispatchEvent(new CustomEvent("xyzo:pin-hover", { detail: { pin: hitPin } }));
      } catch (_) {}
    });
  }

  _handleMouseDown(e) {
    const hitPin = this._hitTest(e);
    if (hitPin) {
      if (e.stopPropagation) e.stopPropagation();
      if (e.preventDefault) e.preventDefault();
      if (L.DomEvent) {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);
      }
      // stopPropagation above suppresses Leaflet's synthetic `click`, so
      // _handleMapClick won't run — activate (zoom + popup/modal) here.
      this._activatePin(hitPin);
    }
  }

  // The ring is SHARED (hover-ring.js): the earthquakes, the faults and
  // any other point overlay ask the same element to move, so there is
  // never more than one circle under the cursor. This renderer still
  // owns the element it created — it keeps the dataset attributes the
  // DevTools Inspector reads — but the MOVING and the HIDING go
  // through the shared module.
  _showGhost(pin) {
    if (!this._ghost) return;
    if (pin.isOverflowBadge) {
      this._hideGhost();
      return;
    }
    if (!this._ghost.parentNode || !document.body.contains(this._ghost)) {
      const pane = this._map ? (this._map.getPane("markerPane") || this._map.getPane("overlayPane")) : null;
      if (pane) pane.appendChild(this._ghost);
    }
    const lat = pin.location?.lat ?? pin.lat;
    const lng = pin.location?.lng ?? pin.lng;
    if (typeof lat !== "number" || typeof lng !== "number") return;
    const radius = this._radiusForZoom(this._map.getZoom());

    this._ghost.dataset.pinId = pin.id;
    this._ghost.dataset.lat = lat;
    this._ghost.dataset.lng = lng;
    this._ghost.dataset.category = pin.category || pin.c || "other";

    if (window.HoverRing && typeof window.HoverRing.show === "function") {
      window.HoverRing.show(this._map, { lat: lat, lng: lng }, radius, "pin");
      // HoverRing owns the element, so make sure the element this
      // renderer holds IS that element.
      this._ghost = window.HoverRing.el(this._map);
    }
  }

  _hideGhost() {
    if (window.HoverRing && typeof window.HoverRing.hide === "function") {
      window.HoverRing.hide("pin");
      return;
    }
    if (this._ghost) this._ghost.classList.add("hidden");
  }

  _handleMouseLeave() {
    // The cursor too: leaving the canvas (for the live panel, the
    // layers dropdown, the bottom bar) must not leave a "pointer"
    // behind on a map that no longer has anything under it.
    if (this._canvas) this._canvas.style.cursor = "";
    this._hideGhost();
    // Feed the hover HUD: the cursor left the canvas, so no pin is
    // hovered any more.
    try { window.dispatchEvent(new CustomEvent("xyzo:pin-hover", { detail: { pin: null } })); } catch (_) {}
  }

  _handleMapClick(e) {
    const clickLatLng = e.latlng;
    if (!clickLatLng) return;
    const clickPt = this._map.latLngToContainerPoint(clickLatLng);
    const radius = this._radiusForZoom(this._map.getZoom());
    const hitR = radius * 1.5 + 8;
    let best = null, bestDist = hitR * hitR;
    for (const p of this._pins) {
      if (!matchesActiveCategoryFilters(p)) continue;
      const lat = p.location?.lat ?? p.lat;
      const lng = p.location?.lng ?? p.lng;
      if (typeof lat !== "number" || typeof lng !== "number") continue;
      const pp = this._map.latLngToContainerPoint([lat, lng]);
      const dx = pp.x - clickPt.x, dy = pp.y - clickPt.y;
      const d2 = dx * dx + dy * dy;
      const pinHitR = p.isOverflowBadge ? (radius + 6) : hitR;
      const pinHitR2 = pinHitR * pinHitR;
      if (d2 < pinHitR2 && d2 < bestDist) { bestDist = d2; best = p; }
    }
    if (!best) return;
    if (e.originalEvent) {
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
    }
    this._activatePin(best);
  }

  // Single activation path shared by mousedown and map-click handlers.
  // Leaflet's map `click` never fires when `_handleMouseDown` hits a pin
  // (it stopPropagation()s the native event), so all pin logic — cluster
  // auto-zoom, popup, overflow modal — must live here, not in the click
  // handler alone. The timestamp guard makes double-activation (mousedown
  // then a stray synthetic click) idempotent.
  _activatePin(pin) {
    if (!pin) return;
    const key = String(pin.id ?? "");
    const now = performance.now();
    if (this._lastActivate && this._lastActivate.key === key && now - this._lastActivate.t < 800) return;
    this._lastActivate = { key, t: now };

    if (pin.isOverflowBadge) {
      // Zoom to cluster: fit all the overflow cluster's articles on screen.
      if (pin.allArticles?.length > 0) {
        maybeZoomToCluster(
          pin.location?.lat ?? pin.lat,
          pin.location?.lng ?? pin.lng,
          pin.allArticles
        );
      }
      openLocationExplorerModal(pin.cityName, pin.allArticles || []);
      return;
    }
    // A REGULAR PIN DOES NOT MOVE THE MAP.
    //
    // It used to: the click zoomed into the city cluster, unasked, and
    // the reader's view of the world was taken away from them by a pin
    // they had merely tapped. Owner ask: *"rather then autozooming in
    // on a pin thats in a city we need to give people the option after
    // the popup opens to zoom in someplace in the popup"*.
    //
    // So the popup opens where the reader already is, and the POPUP
    // carries the zoom — a 🔎 button beside the coordinates
    // that flies to that place when they ask for it. See zoomToPlace().
    openPinPopupFromCanvas(pin);
  }
}

// Track the current canvas-driven tmpMarker so a new pin click can close
// the previous one cleanly. Without this, with `autoClose: true` Leaflet
// closes the previous popup (which fires its popupclose handler and
// removes the old tmpMarker), but we still want a guaranteed cleanup path
// in case the close ordering races with `openPopup()`.
let _currentCanvasTmpMarker = null;

function openPinPopupFromCanvas(pin) {
  if (pin && pin.isOverflowBadge) {
    openLocationExplorerModal(pin.cityName, pin.allArticles || []);
    return;
  }
  // Canvas pins may be either live-API format (location.lat/lng) or the
  // compact cached format with flat lat/lng + short keys (st, t, c, pn, img).
  // Resolve both shapes uniformly before touching Leaflet.
  const lat = pin.location?.lat ?? pin.lat;
  const lng = pin.location?.lng ?? pin.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return;

  // Close any previously open canvas popup before opening the new one.
  // `autoClose: true` handles the Leaflet side; this belt-and-suspenders
  // path also removes the old tmpMarker so we never leak layers.
  if (_currentCanvasTmpMarker) {
    try {
      const old = _currentCanvasTmpMarker;
      _currentCanvasTmpMarker = null;
      if (old.getPopup && old.getPopup() && old.getPopup().isOpen()) {
        old.closePopup();
      } else {
        map.removeLayer(old);
      }
    } catch (_) {}
  }

  const tmpMarker = L.marker([lat, lng], {
    icon: L.divIcon({ className: "xyzo-pin-temp", html: "", iconSize: [0, 0] }),
  }).addTo(map);
  _currentCanvasTmpMarker = tmpMarker;

  // Build initial pin data from canvas (minimal)
  const pinData = {
    id: pin.id,
    source_type: (pin.source_type ?? (pin.st === "r" ? "rss" : "editorial")),
    title: pin.title ?? pin.t,
    location: { lat, lng, place_name: pin.place_name ?? pin.pn ?? pin.location?.place_name ?? null },
    category: pin.category ?? pin.c,
    image_url: pin.image_url ?? pin.img,
    canonical_url: pin.canonical_url ?? null,
    source_name: null,
    source_country: null,
    place_name: pin.pn,
    published_at: null,
    created_at: null,
    confidence_score: null,
    location_precision: null,
  };

  // Debug: expose last opened pin data globally (visible in DevTools console)
  window.__xyzoLastPin = pinData;
  if (window.XYZO_DEBUG) {
    XLog.debug("[Popup] Opening pin:", pinData);
  }

  // Set active/selected pin ID
  setSelectedPin(pin.id, pin.event_id || pin.id);

  // Hide ghost circle when opening popup
  if (typeof canvasRenderer !== "undefined" && canvasRenderer) {
    canvasRenderer._hideGhost();
  }

  // Show popup immediately with what we have
  tmpMarker._pinData = pinData;
  tmpMarker.bindPopup(() => buildPopup(pinData), POPUP_OPTIONS);
  tmpMarker.on("popupopen", (e) => {
    wirePopupActions(e.popup, pinData);
    // Shift the popup down if it opened above the top bar.
    //
    // IT READS THIS POPUP'S OWN ELEMENT. `document.querySelector` returns
    // the FIRST popup in the DOCUMENT, which may be a fading one — the
    // canvas path rewrote a stranger's transform while the map flew.
    //
    // AND IT STOPS WHEN THE MAP SETTLES: a popup that is not riding a
    // flight does not move, and rewriting Leaflet's transform while it
    // does is how the two used to fight.
    let fixAttempts = 0;
    const fixPopupShift = () => {
      if (fixAttempts > 60) return;              // give up after ~1 second
      if (!_mapIsMoving) return;                  // the map has settled
      const popupEl = e.popup && e.popup.getElement ? e.popup.getElement() : null;
      if (popupEl) {
        const rect = popupEl.getBoundingClientRect();
        if (rect.y < 60) {  // If popup top is above search bar bottom
          const shift = 60 - rect.y;
          const style = popupEl.style;
          const match = (style.transform || '').match(/translate3d\(([^,]+)px,\s*([^,]+)px/);
          if (match) {
            const x = parseFloat(match[1]);
            const y = parseFloat(match[2]) + shift;
            style.transform = `translate3d(${x}px, ${y}px, 0px)`;
          }
        }
      }
      fixAttempts++;
      requestAnimationFrame(fixPopupShift);
    };
    requestAnimationFrame(fixPopupShift);
  });
  tmpMarker.on("popupclose", () => {
    if (_currentCanvasTmpMarker === tmpMarker) _currentCanvasTmpMarker = null;
    clearSelectedPin();
    if (typeof canvasRenderer !== "undefined" && canvasRenderer) {
      canvasRenderer._hideGhost();
      canvasRenderer._scheduleRedraw();
    }
    map.removeLayer(tmpMarker);
  });
  // Open the popup ONCE THE MAP HAS SETTLED. maybeZoomToCluster() has
  // just started a 700 ms flight, and a popup that opens into it slides
  // for the rest of it — the reader's tap on the ✕ lands on whatever
  // moved into that spot.
  openPopupWhenSettled(() => {
    if (!tmpMarker.isPopupOpen() && !_popupIsOpen) tmpMarker.openPopup();
  });

  // Fetch full pin data in background to get canonical_url
  fetch(`/api/pins/${pin.id}`)
    .then(r => r.ok ? r.json() : null)
    .then(full => {
      if (!full) return;
      // Merge the full data into pinData
      pinData.canonical_url = full.canonical_url || full.detail?.source_url || null;
      pinData.source_name = full.detail?.source_feed || null;
      pinData.published_at = full.published_at || null;
      pinData.confidence_score = full.confidence_score ?? null;
      pinData.location_precision = full.location_precision || null;
      // Also ensure title/image_url are current (from enriched endpoint)
      if (full.title && !pinData.title) pinData.title = full.title;
      if (full.image_url && !pinData.image_url) pinData.image_url = full.image_url;
      if (window.XYZO_DEBUG) {
        XLog.debug("[Popup] Full data merged:", full);
      }
      // Force popup content refresh using Leaflet's setContent
      const popup = tmpMarker.getPopup();
      if (popup && popup.isOpen()) {
        popup.setContent(buildPopup(pinData));
        wirePopupActions(popup, pinData);
      }
    })
    .catch(() => {}); // silent — popup still works without the URL
}

const canvasRenderer = new CanvasPinRenderer(map);
window._canvasPinRenderer = canvasRenderer;

// The pins currently painted, in their TRUE positions.
//
// The canvas renderer keeps a SPREAD copy of the pins — it nudges
// overlapping pins apart so none of them is hidden — and a spread
// position is a lie about where a story happened. An export must carry
// the real coordinates, so it reads the raw list.
//
// This is the exporter's only entry point into the map's pin data.
window.__xyzoExportPins = function () {
  try {
    if (canvasRenderer && Array.isArray(canvasRenderer._rawPins)) {
      return canvasRenderer._rawPins;
    }
  } catch (_) {}
  return [];
};

// ── Pre-rendered icon cache ───────────────────────────────────────────
// Renders the EXACT same SVG icons used in the legend/DOM markers onto
// offscreen canvases, then stamps them via drawImage() per-pin. This
// gives identical visuals to the DOM markers with canvas performance.
const _iconCanvasCache = new Map();
const _iconImageCache = new Map();
const _iconReady = new Set();

function _svgToDataUri(svgPath, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="48" height="48" ` +
    `fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    svgPath + `</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

function _buildIconCache() {
  // Pre-render every category icon at standard sizes
  const sizes = [5, 7, 9, 11, 13, 15, 17, 19];
  const cats = Object.keys(EVENT_ICONS);
  const dpr = window.devicePixelRatio || 1;
  for (const cat of cats) {
    const svgPath = EVENT_ICONS[cat];
    const color = EVENT_COLORS[cat] || EVENT_COLORS.other;
    const uri = _svgToDataUri(svgPath, color);
    const img = new Image();
    img.src = uri;
    _iconImageCache.set(cat, img);
    // Pre-render at each size once loaded
    img.onload = () => {
      for (const size of sizes) {
        const key = cat + "_" + size;
        if (_iconCanvasCache.has(key)) continue;
        const dim = Math.ceil(size * 2 * dpr);
        const oc = document.createElement("canvas");
        oc.width = dim; oc.height = dim;
        const octx = oc.getContext("2d");
        octx.scale(dpr, dpr);
        const cx = size, cy = size;
        // Colored circle background
        octx.beginPath();
        octx.arc(cx, cy, size * 0.92, 0, Math.PI * 2);
        octx.fillStyle = color;
        octx.globalAlpha = 0.92;
        octx.fill();
        octx.globalAlpha = 1;
        octx.strokeStyle = "rgba(0,0,0,0.45)";
        octx.lineWidth = Math.max(0.8, size * 0.07);
        octx.stroke();
        // Stamp the SVG icon (white strokes) centered
        const iconDim = size * 1.1;
        octx.drawImage(img, cx - iconDim / 2, cy - iconDim / 2, iconDim, iconDim);
        _iconCanvasCache.set(key, oc);
      }
      _iconReady.add(cat);
      // Trigger a redraw once all icons are loaded
      if (_iconReady.size >= cats.length && canvasRenderer._enabled) {
        canvasRenderer._scheduleRedraw();
      }
    };
  }
}

function _getIconCanvas(cat, size) {
  let c = (cat || "other").toLowerCase();
  if (c === "news" || c === "none") c = "other";
  const key = c + "_" + size;
  const cached = _iconCanvasCache.get(key);
  if (cached) return cached;

  const bucket = SUBTYPE_TO_BUCKET[c];
  if (bucket) {
    const bucketKey = bucket + "_" + size;
    const bucketCached = _iconCanvasCache.get(bucketKey);
    if (bucketCached) return bucketCached;
  }

  // ── Mobile icon fix: synchronous canvas build when img already loaded ──
  // _buildIconCache() populates _iconImageCache and builds canvas variants
  // inside img.onload. On mobile, the first draw call often fires BEFORE
  // onload resolves — causing _iconCanvasCache to miss and fall through to
  // the plain blue circle. This synchronous path catches the race by
  // detecting img.complete and building the canvas variant immediately.
  const img = _iconImageCache.get(c);
  if (img && img.complete && img.naturalWidth > 0) {
    const dpr = window.devicePixelRatio || 1;
    const dim = Math.ceil(size * 2 * dpr);
    const oc = document.createElement("canvas");
    oc.width = dim; oc.height = dim;
    const octx = oc.getContext("2d");
    octx.scale(dpr, dpr);
    const color = EVENT_COLORS[c] || (bucket && EVENT_COLORS[bucket]) || CANVAS_CAT_COLORS[c] || CANVAS_CAT_COLORS.other;
    octx.beginPath();
    octx.arc(size, size, size * 0.92, 0, Math.PI * 2);
    octx.fillStyle = color;
    octx.globalAlpha = 0.92;
    octx.fill();
    octx.globalAlpha = 1;
    octx.strokeStyle = "rgba(0,0,0,0.45)";
    octx.lineWidth = Math.max(0.8, size * 0.07);
    octx.stroke();
    const iconDim = size * 1.1;
    octx.drawImage(img, size - iconDim / 2, size - iconDim / 2, iconDim, iconDim);
    _iconCanvasCache.set(key, oc);
    _iconReady.add(c);
    if (_iconReady.size >= Object.keys(EVENT_ICONS).length && canvasRenderer._enabled) {
      canvasRenderer._scheduleRedraw();
    }
    return oc;
  }

  // Fallback: simple colored circle if icon not yet loaded
  const dpr = window.devicePixelRatio || 1;
  const dim = Math.ceil(size * 2 * dpr);
  const oc = document.createElement("canvas");
  oc.width = dim; oc.height = dim;
  const octx = oc.getContext("2d");
  octx.scale(dpr, dpr);
  const color = EVENT_COLORS[c] || (bucket && EVENT_COLORS[bucket]) || CANVAS_CAT_COLORS[c] || CANVAS_CAT_COLORS.other;
  octx.beginPath();
  octx.arc(size, size, size * 0.92, 0, Math.PI * 2);
  octx.fillStyle = color;
  octx.fill();
  octx.strokeStyle = "rgba(0,0,0,0.45)";
  octx.lineWidth = 0.8;
  octx.stroke();
  return oc;
}

// Build the icon cache on load
_buildIconCache();
function isWorldViewZoom() {
  return map.getZoom() <= 3;
}


// ── Last-Known-Good Pin Cache (localStorage) ──────────────────────────
// Saves the most recent successful pin load so the map is never blank
// when the API is down or returning empty. Shows a "viewing cached data"
// banner with a link to /help/ so users know the data is stale.
const LAST_PINS_KEY = "xyzo_last_good_pins";
const LAST_PINS_TS_KEY = "xyzo_last_good_ts";
const MAX_CACHED_PINS = 500;

// Bounded LRU cache of image dimensions. Grew per distinct image URL across
// sessions before; cap at 500 to prevent unbounded growth during long
// browsing sessions with many distinct images.
const _imageDimensionsMap = new LRUMap(500);

function recordImageDimensions(url, width, height) {
  if (!url || !width || !height) return;
  _imageDimensionsMap.set(url, { w: width, h: height });
}

function toCompact(p) {
  const lat = p.location?.lat ?? p.lat ?? 0;
  const lng = p.location?.lng ?? p.lng ?? 0;
  const category = (p.category || p.c || "other").toLowerCase();
  const st = p.source_type || (p.st === "r" ? "rss" : (p.st === "e" ? "editorial" : "community"));
  const imgUrl = p.image_url || p.img || null;
  const dims = imgUrl ? (_imageDimensionsMap.get(imgUrl) || null) : null;
  const iw = p.image_width || p.iw || dims?.w || null;
  const ih = p.image_height || p.ih || dims?.h || null;

  return {
    id: p.id,
    st: st === "rss" ? "r" : (st === "editorial" ? "e" : "c"),
    t: p.title || p.t || "",
    lat,
    lng,
    c: category,
    pn: p.place_name || p.location?.place_name || p.pn || null,
    img: imgUrl,
    iw,
    ih,
    sc: p.source_count || p.sc || 1,
    top: p.is_top_story || p.top ? 1 : 0,
    eid: p.event_id || p.eid || null,
    u: p.canonical_url || p.u || null,
    // Overflow badge and cluster spread metadata
    isOverflowBadge: p.isOverflowBadge || false,
    overflowCount: p.overflowCount || 0,
    totalCount: p.totalCount || 0,
    cityName: p.cityName || null,
    _clusterRank: p._clusterRank || 0,
    _clusterSize: p._clusterSize || 0,
  };
}

function fromCompact(cp) {
  if (!cp) return cp;
  if (cp.location && cp.source_type && typeof cp.location === "object") return cp;
  const stMap = { r: "rss", e: "editorial", c: "community" };
  const st = stMap[cp.st] || cp.source_type || "rss";
  const lat = Number(cp.lat ?? cp.location?.lat ?? 0);
  const lng = Number(cp.lng ?? cp.location?.lng ?? 0);

  return {
    id: Number(cp.id),
    source_type: st,
    title: cp.t || cp.title || "",
    location: { lat, lng },
    location_precision: cp.location_precision || "exact",
    confidence_score: cp.confidence_score ?? 1.0,
    status: cp.status || "published",
    category: cp.c || cp.category || "other",
    place_name: cp.pn || cp.place_name || null,
    canonical_url: cp.u || cp.canonical_url || null,
    image_url: cp.img || cp.image_url || null,
    image_width: cp.iw || cp.image_width || null,
    image_height: cp.ih || cp.image_height || null,
    word_freq: cp.word_freq || cp.wf || null,
    source_count: Number(cp.source_count ?? cp.sc ?? 1),
    event_id: cp.event_id || cp.eid || null,
    is_top_story: Boolean(cp.is_top_story || cp.top || (Number(cp.source_count ?? cp.sc ?? 1) >= 20)),
    published_at: cp.published_at || new Date().toISOString(),
    created_at: cp.created_at || new Date().toISOString(),
    updated_at: cp.updated_at || new Date().toISOString(),
    // Overflow badge and cluster spread metadata — restored from compact
    isOverflowBadge: cp.isOverflowBadge || false,
    overflowCount: cp.overflowCount || 0,
    totalCount: cp.totalCount || 0,
    cityName: cp.cityName || null,
    _clusterRank: cp._clusterRank || 0,
    _clusterSize: cp._clusterSize || 0,
  };
}

function savePinsToCache(pins) {
  try {
    if (!Array.isArray(pins)) return;
    const compact = pins.slice(0, MAX_CACHED_PINS).map(toCompact);
    localStorage.setItem(LAST_PINS_KEY, JSON.stringify(compact));
    localStorage.setItem(LAST_PINS_TS_KEY, new Date().toISOString());
  } catch (_) { /* quota exceeded or private mode — silently skip */ }
}

function loadPinsFromCache() {
  try {
    const raw = localStorage.getItem(LAST_PINS_KEY);
    if (!raw) return null;
    const rawPins = JSON.parse(raw);
    if (!Array.isArray(rawPins) || !rawPins.length) return null;
    const pins = rawPins.map(fromCompact);
    const ts = localStorage.getItem(LAST_PINS_TS_KEY) || null;
    return { pins, ts };
  } catch (_) { return null; }
}

let _staleBannerUserDismissed = false;
// Consecutive-fetch-failure counter. Only show the "Cached pins shown"
// banner after ≥3 consecutive failures so a single transient blip (e.g.
// an AbortError from rapid panning, a brief network hiccup) doesn't
// alarm the user. Reset on any successful response.
let _consecutivePinFetchFailures = 0;
// Minimum ms between showing the stale banner. Prevents rapid
// re-showing when user dismisses and a new failure immediately fires.
const _STALE_banner_min_interval_ms = 10_000;
let _lastStaleBannerShownAt = 0;
let _lastWidenedToastBbox = null;

// Active topic-tag filter for the pin feed. Declared up here (rather
// than at its original site near setActiveTag) so _logFetchError —
// which can run during the very first fetchPinsForViewport call during
// module init — can read it without hitting the temporal dead zone.
// The real initializer near setActiveTag still owns assignment; this
// forward declaration only ensures the binding exists early.
let _activeTag = null;

// ── Fetch-error diagnostic capture ────────────────────────────────────
// When the pins fetch fails, capture full context (URL, status, body,
// navigator.onLine, retry state) so we can diagnose why the "Cached
// pins shown" banner appears. Surfaced via:
//   1. console.group warn (structured + collapsible)
//   2. inline "details" toggle on the banner itself
//   3. window.__xyzoFetchDiagnostics() for paste-into-issues / quick
//      inspection from devtools
const _fetchErrorRing = [];
const MAX_FETCH_ERRORS = 5;
let _lastFetchError = null;

async function _captureResponseBody(res) {
  try {
    const text = await res.text();
    if (text.length > 500) return text.slice(0, 500) + `... [truncated ${text.length - 500} chars]`;
    try { return JSON.stringify(JSON.parse(text)); } catch (_) { return text; }
  } catch (_) { return null; }
}

function _logFetchError(kind, ctx) {
  // Defensive reads — _logFetchError is called from the very first fetch
  // attempt during module init, before all module-level `let` bindings
  // have been initialized. Hitting a TDZ here would mask the actual fetch
  // failure with a ReferenceError, so we wrap reads that could TDZ and
  // fall back to null if they're not yet live.
  let activeTagSafe = null;
  try { activeTagSafe = _activeTag || null; } catch (_) { /* TDZ — leave null */ }
  const entry = {
    when: new Date().toISOString(),
    kind, // 'network' | 'http' | 'retry_exhausted' | 'exception'
    url: ctx.url ?? null,
    bbox: ctx.bbox ?? null,
    activeTag: activeTagSafe,
    status: ctx.status ?? null,
    statusText: ctx.statusText ?? null,
    errorName: ctx.errorName ?? null,
    errorMessage: ctx.errorMessage ?? null,
    body: ctx.body ?? null,
    retryAttempted: ctx.retryAttempted ?? false,
    consecutiveFailures: _consecutivePinFetchFailures,
    online: typeof navigator !== "undefined" ? navigator.onLine : null,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
  };
  _fetchErrorRing.push(entry);
  while (_fetchErrorRing.length > MAX_FETCH_ERRORS) _fetchErrorRing.shift();
  _lastFetchError = entry;

  // Console: collapsible group with the full structured entry.
  try {
    // AGENTS.md: app code never touches console.* — the guard swallows
    // it anyway, and XLog keeps the output until XYZO_DEBUG is on.
    const tag = kind === "http" ? `HTTP ${ctx.status}` : kind;
    XLog.warn(`[xyzo] pins ${tag} — ${ctx.url}`);
    XLog.warn("Context:", entry);
    if (ctx.body) XLog.warn("Body:", ctx.body);
    if (ctx.errorMessage) XLog.warn("Error:", ctx.errorName, ctx.errorMessage);
  } catch (_) { /* logger unavailable */ }
}

window.__xyzoFetchDiagnostics = () => ({
  lastError: _lastFetchError,
  ring: _fetchErrorRing.slice(),
  consecutiveFailures: _consecutivePinFetchFailures,
  userDismissed: _staleBannerUserDismissed,
  cacheTimestamp: (() => { try { return localStorage.getItem(LAST_PINS_TS_KEY); } catch (_) { return null; } })(),
  online: typeof navigator !== "undefined" ? navigator.onLine : null,
  boot: {
    mapReady: !!window._xyzoMapReady,
    retries: window._xyzoBootUnready || 0,
    mapSize: typeof map !== "undefined" ? { x: map.getSize().x, y: map.getSize().y } : null,
    canvasEnabled: typeof canvasRenderer !== "undefined" && canvasRenderer?._enabled,
    canvasPins: typeof canvasRenderer !== "undefined" && canvasRenderer?._pins?.length || 0,
    lastDrawnCount: typeof canvasRenderer !== "undefined" && canvasRenderer?._lastDrawnCount || 0,
  },
});

function toggleStaleBannerDetails(e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  const pre = document.getElementById("stale-banner-details");
  if (!pre) return;
  pre.hidden = !pre.hidden;
}

function showStaleDataBanner(savedAt) {
  if (_staleBannerUserDismissed) return;
  // Don't show if API health banner is already visible (prevents double banners)
  const apiBanner = document.getElementById("api-down-banner");
  if (apiBanner && !apiBanner.hidden) return;
  // Throttle: don't re-show within 10s of last show (prevents flicker
  // on rapid transient failures)
  const now = Date.now();
  if (now - _lastStaleBannerShownAt < _STALE_banner_min_interval_ms) return;
  _lastStaleBannerShownAt = now;
  let banner = document.getElementById("stale-data-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "stale-data-banner";
    banner.className = "temp-notification";
    banner.style.cssText = "position:fixed;top:calc(var(--top-band,52px) + 6px);left:50%;transform:translateX(-50%);z-index:10000;max-width:420px;width:calc(100vw - 32px);border-radius:8px;font-size:11px;padding:8px 14px;display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;box-shadow:0 6px 24px rgba(0,0,0,0.5);backdrop-filter:blur(10px);transition:all 0.25s ease;";
    document.body.appendChild(banner);
  }

  const ago = savedAt ? formatRelativeTime(savedAt) : "";
  const agoText = ago || "recently";

  // Parse the error into something human-readable
  let errorType = "Connection issue";
  let errorDetail = "The map server might be restarting or temporarily overloaded.";
  let canRetry = true;

  if (_lastFetchError) {
    const status = _lastFetchError.status || 0;
    const url = _lastFetchError.url || "";

    if (_lastFetchError.kind === "exception") {
      // AN EXCEPTION IS A BUG IN THE PAGE, NOT A NETWORK PROBLEM.
      //
      // The owner's live failure (2026-11-12) showed this banner saying
      // "Connection hiccup — Brief network issue — Will retry
      // automatically" while the real cause was a crash in the boot:
      // "Set map center and zoom first." Telling a reader their CONNECTION
      // hiccupped sends them looking for a problem that is not on their
      // side, and "will retry automatically" is a lie — a retry cannot
      // fix a crash. The details toggle below carries the real message.
      errorType = "Map problem";
      errorDetail =
        "The map hit an error while loading — showing cached data. The details below say what failed.";
    } else if (status === 502) {
      errorType = "Server restarting";
      errorDetail = "Data may be stale. New articles will load when connectivity returns.";
    } else if (status === 503) {
      errorType = "Maintenance";
      errorDetail = "The service is briefly unavailable. Try again in a moment.";
    } else if (status === 429) {
      errorType = "Slow down";
      errorDetail = "Loading maps too fast — please wait a moment.";
    } else if (status === 0 || _lastFetchError.errorName === "TypeError") {
      errorType = "Connection hiccup";
      errorDetail = "Brief network issue — showing cached data. Will retry automatically.";
    } else if (status >= 500) {
      errorType = "Server error";
      errorDetail = `Error ${status}. Will resolve shortly.`;
    }


  }

  banner.style.background = "rgba(17, 24, 39, 0.97)";
  banner.style.border = "1px solid rgba(245, 158, 11, 0.4)";
  banner.style.color = "#e2e8f0";
  banner.innerHTML = `
    <div style="flex-shrink:0;font-size:14px;">📡</div>
    <div style="flex:1;min-width:0;">
      <div style="display:flex;align-items:center;gap:6px;">
        <strong style="color:#fbbf24;font-size:11px;">${escapeHtml(errorType)}</strong>
        <span style="font-size:9px;color:#64748b;">cached ${escapeHtml(agoText)}</span>
      </div>
      <div style="font-size:10px;color:#94a3b8;line-height:1.3;margin:2px 0 4px;">
        ${escapeHtml(errorDetail)}
      </div>
      <div style="display:flex;gap:4px;align-items:center;">
        <button onclick="retryLivePins()" style="background:#f59e0b;color:#0b0f14;border:none;padding:3px 10px;border-radius:4px;font-weight:700;cursor:pointer;font-size:10px;">⟳ Retry</button>
        <button onclick="dismissStaleBanner()" style="background:none;border:1px solid #475569;color:#94a3b8;cursor:pointer;font-size:9px;padding:2px 6px;border-radius:3px;">dismiss</button>
        <button onclick="toggleStaleBannerDetails(event)" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:9px;padding:2px 4px;">details</button>
      </div>
    </div>
    <pre id="stale-banner-details" hidden style="flex-basis:100%;margin:4px 0 0;padding:4px;background:rgba(0,0,0,0.3);border-radius:3px;font-size:8px;max-height:80px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace;color:#64748b;">${escapeHtml(JSON.stringify(_lastFetchError || {}, null, 1))}</pre>
  `;
  banner.hidden = false;
}

function dismissStaleBanner() {
  // User explicitly clicked × — mark as dismissed so the next transient
  // failure doesn't immediately re-show the banner.
  _staleBannerUserDismissed = true;
  hideStaleBanner();
}

function hideStaleBanner() {
  // Just hide the banner without changing the dismissed flag. Used when
  // a successful fetch arrives — next failure should still be able to
  // show the banner if the problem persists.
  const b = document.getElementById("stale-data-banner");
  if (b) b.hidden = true;
}

function retryLivePins() {
  _staleBannerUserDismissed = false;
  const b = document.getElementById("stale-data-banner");
  if (b) b.hidden = true;
  fetchPinsForViewport();
}

function showFetchErrorBanner() {
  if (_staleBannerUserDismissed) return;
  // Reuse the stale data banner with the same improved design
  showStaleDataBanner(null);
}

function restoreCachedPinsOrError() {
  const cached = loadPinsFromCache();
  if (cached && cached.pins.length > 0) {
    // Always use canvas renderer for cached pins — fast, no DOM churn
    canvasRenderer.enable();
    canvasRenderer.setPins(cached.pins);
    showStaleDataBanner(cached.ts);
  } else {
    showFetchErrorBanner();
  }
}

async function fetchPinsForViewport() {
  // All marker-ish modes off (and no active search) → nothing will be
  // rendered, so skip the network round-trip entirely.
  if (!activeModes.has("markers") && !activeModes.has("clusters") &&
      !activeModes.has("heatmap")) {
    const q = (typeof searchInput !== "undefined" && searchInput) ? searchInput.value.trim() : "";
    const searching = q && (typeof searchActive !== "undefined" && searchActive);
    if (!searching) {
      if (inflightCtrl) { try { inflightCtrl.abort(); } catch (_) {} }
      canvasRenderer.setPins([]);
      clearAllMarkers();
      return;
    }
  }
  // Both content layers (News + Community) toggled off → blank map without
  // a network round-trip. Search still works (explicit intent bypasses the
  // layer filter — see layerSourceTypeParam).
  if (!anyLayerVisible()) {
    const q = (typeof searchInput !== "undefined" && searchInput) ? searchInput.value.trim() : "";
    const searching = q && (typeof searchActive !== "undefined" && searchActive);
    if (!searching) {
      if (inflightCtrl) { try { inflightCtrl.abort(); } catch (_) {} }
      canvasRenderer.setPins([]);
      clearAllMarkers();
      return;
    }
  }
  // ── Boot guard: skip if map container isn't sized yet ──────────────
  // On first load from a shared link, setView() fires moveend before
  // the browser has committed the container's final layout.  If we
  // proceed, the canvas renderer draws to a 0×0 canvas and pins are
  // invisible.  Defer up to 3 × 200 ms then give up gracefully.
  if (window._xyzoBootUnready == null) window._xyzoBootUnready = 0;
  if (!window._xyzoMapReady) {
    const sz = map.getSize();
    if (sz.x > 0 && sz.y > 0) {
      window._xyzoMapReady = true;
    } else if (window._xyzoBootUnready < 3) {
      window._xyzoBootUnready++;
      XLog.warn(`[boot] map not sized yet (${sz.x}×${sz.y}), retry ${window._xyzoBootUnready}/3 in 200ms`);
      setTimeout(fetchPinsForViewport, 200);
      return;
    } else {
      // Gave up waiting — proceed anyway (map may be intentionally 0×0)
      window._xyzoMapReady = true;
    }
  }

  // Cancel any previous in-flight fetch
  if (inflightCtrl) {
    try { inflightCtrl.abort(); } catch (_) {}
  }
  // If we aborted a previously-tracked pan, mark it so we don't ship
  // a misleading "render_end" without a fetch_end. The throttle wrapper
  // sets move_end on every new pan, but the abort fires before the
  // previous cycle's render path completes.
  if (window._mapPerf && window._mapPerf.fetch_start && !window._mapPerf.fetch_end) {
    window._mapPerf.aborted = true;
  }
  const ctrl = new AbortController();
  inflightCtrl = ctrl;

  // Auto-abort after 25s so the browser never hits a TCP-level NetworkError.
  const _fetchTimer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 25000);

  // Map perf: mark the network response fully received. setPins below
  // schedules a requestAnimationFrame draw; we capture render_end
  // right after setPins returns (the draw itself is microseconds).
  if (window._mapPerf && window._mapPerf.move_end) {
    window._mapPerf.fetch_start = performance.now();
    window._mapPerf.zoom = map.getZoom();
  }

  // Hoisted so the catch block can report them on exception
  let bbox = null;
  let fetchUrl = null;
  let url = null;
  try {
    if (!map || !map.getBounds) {
      XLog.error("[fetchPinsForViewport] map not ready");
      return;
    }
    const b = map.getBounds();
    const w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
    bbox = [w, s, e, n].map((num) => num.toFixed(4)).join(",");
    const limit = pickLimitForZoom(map.getZoom());
    const canvasLimit = pickCanvasLimitForZoom(map.getZoom());
    const { since, until } = searchWindow();
    const q = (typeof searchInput !== "undefined" && searchInput) ? searchInput.value.trim() : "";
    const searching = q && (typeof searchActive !== "undefined" && searchActive);
    if (window._mapPerf) window._mapPerf.bbox = bbox;

    XLog.debug("[fetchPinsForViewport] q:", q, "searching:", searching, "searchActive:", searchActive);

    // ── Canvas fast path (all zoom levels): lightweight API + canvas renderer ──
    // Canvas draws all pins as GPU-friendly circles — no DOM nodes, no syncLayers
    // churn. Works from world view (z=2) to street level (z=18). Only falls back
    // to DOM markers when the user is actively searching (needs full pin data).
    if (!searching) {
      if (!activeModes.has("clusters") && (markerLayer.getLayers().length > 0 || pinMarkers.size > 0 || eventMarkers.size > 0)) {
        clearAllMarkers();
      }
      canvasRenderer.enable();
      if (!bbox || canvasLimit == null) {
        XLog.error("[fetchPinsForViewport] bbox or canvasLimit is null", { bbox, canvasLimit, zoom: map.getZoom() });
        return;
      }
      fetchUrl = `/api/pins/map?bbox=${bbox}&limit=${canvasLimit}&light=1`;
      if (since) fetchUrl += `&since=${encodeURIComponent(since)}`;
      if (until) fetchUrl += `&until=${encodeURIComponent(until)}`;
      if (_activeTag) fetchUrl += `&tag=${encodeURIComponent(_activeTag)}`;
      fetchUrl += layerSourceTypeParam();

      let res;
      const headers = { Accept: "application/x-ndjson, application/json" };
      try {
        res = await fetch(fetchUrl, { headers, signal: ctrl.signal });
      } catch (netErr) {
        if (netErr?.name === "AbortError") return;
        _logFetchError("network", {
          url: fetchUrl, bbox,
          errorName: netErr?.name,
          errorMessage: netErr?.message || String(netErr),
          retryAttempted: false,
        });
        _consecutivePinFetchFailures++;
        await new Promise((r) => setTimeout(r, 300));
        if (ctrl.signal.aborted) return;
        try {
          res = await fetch(fetchUrl, { headers, signal: ctrl.signal });
        } catch (netErr2) {
          if (netErr2?.name === "AbortError") return;
          _logFetchError("retry_exhausted", {
            url: fetchUrl, bbox,
            errorName: netErr2?.name,
            errorMessage: netErr2?.message || String(netErr2),
            retryAttempted: true,
          });
          XLog.warn("pins/map retry failed", netErr2?.message || netErr2);
          if (_consecutivePinFetchFailures >= 3) {
            // Tier 1.5: only fall back to cache if we're still the
            // current fetch — a newer fetchPinsForViewport has its
            // own canvas state to manage and we shouldn't clobber it.
            if (inflightCtrl !== ctrl) return;
            return restoreCachedPinsOrError();
          }
          return;
        }
      }
      if (!res.ok) {
        const body = await _captureResponseBody(res);
        _logFetchError("http", {
          url: fetchUrl, bbox,
          status: res.status,
          statusText: res.statusText,
          body,
          retryAttempted: false,
        });
        XLog.warn("pins/map fetch failed", res.status, res.statusText);
        _consecutivePinFetchFailures++;

        // A SERVER ERROR IS USUALLY TRANSIENT. The API answers 500
        // when a query trips its statement_timeout under load, and the
        // whole-world view of the new default map asks for a lot at
        // once. Falling straight back to the cache means a FIRST
        // visit — which has no cache — sees **no pins at all** and no
        // explanation: "it doesn't always load correctly".
        //
        // So: a 5xx is retried ONCE after a beat, and only then does
        // the cache fallback happen.
        if (res.status >= 500 && !ctrl.signal.aborted) {
          try {
            await new Promise((r) => setTimeout(r, 1200));
            if (ctrl.signal.aborted) return;
            const again = await fetch(fetchUrl, { headers, signal: ctrl.signal });
            if (again.ok) {
              res = again;
              _consecutivePinFetchFailures = 0;
              XLog.log("pins/map retry succeeded after a 5xx");
            }
          } catch (retryErr) {
            if (retryErr?.name === "AbortError") return;
          }
        }
        if (!res.ok) {
          _logFetchError("http", {
            url: fetchUrl, bbox,
            status: res.status,
            statusText: res.statusText,
            retryAttempted: true,
          });
        }
        if (!res.ok) {
          if (res.status >= 500 || _consecutivePinFetchFailures >= 3) {
            // Tier 1.5: only fall back to cache if we're still the
            // current fetch — a newer fetchPinsForViewport has its own
            // canvas state to manage and we shouldn't clobber it.
            if (inflightCtrl !== ctrl) return;
            return restoreCachedPinsOrError();
          }
          return;
        }
        // The retry worked: carry on and parse the body below.
      }
      _consecutivePinFetchFailures = 0;

      let body;
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/x-ndjson") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let streamPins = [];
        let streamMeta = {};
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed.meta) {
                streamMeta = parsed;
              } else {
                streamPins.push(fromCompact(parsed));
                if (streamPins.length % 50 === 0) {
                  // Tier 1.5: skip the streaming setPins if a newer
                  // fetch has already taken over — the newer fetch's
                  // own streaming run will paint the new viewport's
                  // pins, and our mid-stream setPins would race with
                  // it and could leave the canvas with stale data.
                  if (inflightCtrl === ctrl) canvasRenderer.setPins(streamPins);
                }
              }
            } catch (_) {}
          }
        }
        if (buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer.trim());
            if (parsed.meta) streamMeta = parsed;
            else streamPins.push(fromCompact(parsed));
          } catch (_) {}
        }
        body = {
          pins: streamPins,
          count: streamPins.length,
          widened: streamMeta.widened || false,
          actual_bbox: streamMeta.actual_bbox || null,
        };
      } else {
        const jsonBody = await res.json();
        const rawPins = jsonBody.items || jsonBody.pins || [];
        body = {
          pins: rawPins.map(fromCompact),
          count: jsonBody.count ?? rawPins.length,
          widened: jsonBody.widened || false,
          actual_bbox: jsonBody.actual_bbox || null,
        };
      }

      // Map perf: mark the network response fully received. setPins below
      // schedules a requestAnimationFrame draw; we capture render_end
      // right after setPins returns (the draw itself is microseconds).
      if (window._mapPerf && window._mapPerf.move_end) {
        window._mapPerf.fetch_end = performance.now();
      }

      // Tier 1.5: root-cause fix for second-pan-no-pins bug.
      // Without this stale check, an in-flight fetchPinsForViewport call
      // can finish parsing AFTER a newer call has already replaced
      // `inflightCtrl`. If we proceed to setPins, we'd overwrite the
      // newer call's pins with our now-stale data, leaving the map
      // showing pins from the previous viewport. Returning here is
      // safe: the newer call will set the correct pins itself, and
      // the finally-block will still run to clean up our controller.
      if (inflightCtrl !== ctrl) return;

      const items = body.pins || [];
      let activeItemCount = items.length;

      if (items.length > 0) {
        savePinsToCache(items, true);
        hideStaleBanner();
        canvasRenderer.setPins(items);
        // THE OVERLAYS GO ON NOW — after the markers. Two frames: the
        // first lets the pin canvas draw, the second lets the browser
        // composite it before 280 tile images arrive to be decoded.
        if (_deferredOverlayAdds.length) {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            flushDeferredOverlays();
          }));
        }
        // Force a redraw after a short delay to catch any edge cases where
        // the canvas cull bounds were stale during a concurrent zoom animation.
        setTimeout(() => canvasRenderer._scheduleRedraw(), 100);
        if (body.widened && body.actual_bbox && body.actual_bbox !== _lastWidenedToastBbox) {
          _lastWidenedToastBbox = body.actual_bbox;
          showTemporaryNotification("Showing nearby pins because this area is sparse");
        }
      } else {
        // Live fetch returned 0 pins for this view. This is NOT a stale-data
        // situation — the API is healthy. We must NOT fall back to localStorage
        // cache here because the cached pins belong to a DIFFERENT bbox
        // (the cache is one slot, not key-per-bbox). Painting them would
        // misrepresent what's actually in the current viewport.
        //
        // The catch-block (network error / 5xx) still goes through
        // restoreCachedPinsOrError() — the stale banner is meaningful there
        // because the live API really did fail.
        canvasRenderer.setPins([]);
        hideStaleBanner();

        // Fallback for small-city zoom: keyword search for center city
        if (window.CityEngine && window.CityEngine.isLoaded()) {
          try {
            const center = map.getCenter();
            const nearby = window.CityEngine.citiesNear(center.lat, center.lng, 100, 1);
            if (nearby && nearby.length > 0 && nearby[0].n) {
              const cityName = nearby[0].n;
              let fbUrl = `/api/pins?q=${encodeURIComponent(cityName)}&limit=${Math.min(canvasLimit, 1000)}`;
              if (since) fbUrl += `&since=${encodeURIComponent(since)}`;
              if (until) fbUrl += `&until=${encodeURIComponent(until)}`;
              if (_activeTag) fbUrl += `&tag=${encodeURIComponent(_activeTag)}`;
              const fbRes = await fetch(fbUrl, { signal: ctrl.signal });
              if (fbRes.ok) {
                const fbBody = await fbRes.json();
                let fbItems = fbBody.items || fbBody.pins || [];
                // Proximity check: prevent cross-continent false matches
                // (e.g. Moscow, Russia when user is viewing Moscow, Idaho)
                fbItems = fbItems.filter((item) => {
                  const pLat = item.location ? item.location.lat : item.lat;
                  const pLng = item.location ? item.location.lng : item.lng;
                  if (pLat == null || pLng == null) return false;
                  const dLat = (pLat - center.lat) * Math.PI / 180;
                  const dLng = (pLng - center.lng) * Math.PI / 180;
                  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                            Math.cos(center.lat * Math.PI / 180) * Math.cos(pLat * Math.PI / 180) *
                            Math.sin(dLng / 2) * Math.sin(dLng / 2);
                  const distKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                  return distKm <= 250;
                });
                if (fbItems.length > 0) {
                  // Mobile-pin-bug fix: between the stale check at 4190 and this
                  // point, a newer fetchPinsForViewport() could have taken over
                  // (abort fires after fetch() resolved but before/while json()
                  // is parsing). Without this guard, the city fallback's setPins
                  // would clobber the new viewport's canvas with stale city pins.
                  if (inflightCtrl !== ctrl) return;
                  activeItemCount = fbItems.length;
                  canvasRenderer.setPins(fbItems);
                  showTemporaryNotification(`Showing news matching "${cityName}"`);
                }
              }
            }
          } catch (fbErr) {
            if (fbErr?.name === "AbortError") return;
            XLog.warn("city fallback fetch failed", fbErr);
          }
        }
      }
      // Keep heatmap, clusters, and links in sync with newly fetched pins
      rebuildHeatPoints();
      commitHeat();
      if (activeModes.has("clusters")) {
        renderPins(items);
      }
      if (linksEnabled) {
        renderLinks();
      }
      refreshLinksToggleTitle();

      const effectiveCount = (_activeCategoryFilters.size > 0 && typeof matchesActiveCategoryFilters === "function")
        ? items.filter(matchesActiveCategoryFilters).length
        : activeItemCount;
      checkEmptyPinState(effectiveCount);
      if (typeof updateActiveFilterIndicator === "function") {
        updateActiveFilterIndicator();
      }
      updateTimeFilterBadges();
      checkServerGuardrails(body);

      // Map perf: render_end = just-after setPins queued the redraw.
      // Canvas drawing happens inside requestAnimationFrame so we capture
      // the synchronous "pins are about to be painted" timestamp and ship
      // the metric. _shipMapPerf is a no-op if move_end was 0 (boot run).
      if (window._mapPerf && window._mapPerf.move_end && window._mapPerf.fetch_end) {
        window._mapPerf.render_end = performance.now();
        // Defer one tick so the canvas paint itself isn't on our clock.
        requestAnimationFrame(() => {
          window._mapPerf.render_end = performance.now();
          window._shipMapPerf && window._shipMapPerf();
        });
      }

      const hashPin = parseMapHash(window.location.hash)?.pinId;
      if (hashPin) openPinPopup(hashPin);

      // ════════════════════════════════════════════════════════════════
      // Boot-fetch coordinator hook — DO NOT REMOVE
      //
      // The boot-fetch coordinator (see the big "DO NOT REMOVE" comment
      // near line 8599) decides whether the current fetch's response is
      // the canonical boot fetch or a regular pan/zoom fetch.  Only the
      // canonical boot fetch updates the coordinator's state machine.
      //
      // `count` is read from the canvas renderer's current pin count,
      // which is updated synchronously by setPins(items) above.  The
      // coordinator uses count > 0 vs count === 0 to decide whether to
      // schedule a retry.
      //
      // Errors here are deliberately swallowed (caught and ignored):
      // the coordinator is best-effort diagnostic infrastructure, not a
      // critical path.  Pin rendering has already happened by this point.
      //
      // This hook appears in 3 places where setPins() is called for
      // successfully-fetched pins (live viewport, cached fallback,
      // search mode).  See docs/boot-fetch-race-postmortem.md.
      // ════════════════════════════════════════════════════════════════
      try {
        const current = (typeof canvasRenderer !== "undefined" && canvasRenderer?._pins?.length) || 0;
        window._bootFetchComplete?.(current, ctrl);
      } catch (_) { /* coordinator missing or threw — never fatal */ }
      return;
    }

    // ── Search mode: render all matching search results globally ──
    if (searching) {
      let url;
      XLog.debug("[search-mode] Fetching all search results for:", q, "limit:", limit);
      canvasRenderer.enable();

      const cityHit = detectStateSearch(q) || detectCitySearch(q);
      if (cityHit) {
        const radius = citySearchRadius(cityHit);
        const cityBbox = cityToBbox(cityHit, radius);
        const bboxStr = cityBbox.map(n => n.toFixed(4)).join(",");
        url = `/api/pins/map?bbox=${bboxStr}&limit=${Math.min(limit, 1500)}`;
      } else {
        url = `/api/pins?q=${encodeURIComponent(q)}&limit=${Math.min(limit, 1000)}`;
      }
      if (since) url += `&since=${encodeURIComponent(since)}`;
      if (until) url += `&until=${encodeURIComponent(until)}`;
      if (_activeTag) url += `&tag=${encodeURIComponent(_activeTag)}`;

      let res;
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } catch (netErr) {
        if (netErr?.name === "AbortError") return;
        _logFetchError("network", {
          url, q,
          errorName: netErr?.name,
          errorMessage: netErr?.message || String(netErr),
          retryAttempted: false,
        });
        _consecutivePinFetchFailures++;
        // Retry once after 300ms (matches canvas mode behavior)
        await new Promise((r) => setTimeout(r, 300));
        if (ctrl.signal.aborted) return;
        try {
          res = await fetch(url, { signal: ctrl.signal });
        } catch (netErr2) {
          if (netErr2?.name === "AbortError") return;
          _logFetchError("retry_exhausted", {
            url, q,
            errorName: netErr2?.name,
            errorMessage: netErr2?.message || String(netErr2),
            retryAttempted: true,
          });
          if (_consecutivePinFetchFailures >= 3) {
            return restoreCachedPinsOrError();
          }
          return;
        }
      }
      if (!res.ok) {
        const body = await _captureResponseBody(res);
        _logFetchError("http", {
          url, q,
          status: res.status,
          statusText: res.statusText,
          body,
          retryAttempted: false,
        });
        XLog.warn("pins fetch failed", res.status, res.statusText);
        _consecutivePinFetchFailures++;
        if (res.status >= 500 || _consecutivePinFetchFailures >= 3) {
          return restoreCachedPinsOrError();
        }
        return;
      }
      _consecutivePinFetchFailures = 0;
      const body = await res.json();
      const pins = body.items || body.pins || [];

      XLog.debug("[search-mode] Fetched", pins.length, "pins for query:", q);

      // Mobile-pin-bug fix: the search-mode branch has no surrounding
      // stale check (the one at 4190 guards only the canvas branch above).
      // If a newer fetchPinsForViewport took over during json() parsing,
      // painting these pins would clobber the new viewport's canvas. The
      // guard sits BEFORE any state mutation so we don't pollute
      // clientPinStore / caches / popups with stale data either.
      if (inflightCtrl !== ctrl) return;

      if (pins.length > 0) {
        savePinsToCache(pins, false);
        hideStaleBanner();
      }

      clientPinStore.addPins(pins);

      // Render search results to canvas AND DOM markers/clusters
      canvasRenderer.setPins(pins);

      // Make sure active map layers are attached to the map
      if (activeModes.has("markers") && !map.hasLayer(markerLayer)) map.addLayer(markerLayer);
      if (activeModes.has("clusters") && !map.hasLayer(pinCluster)) map.addLayer(pinCluster);

      let renderedCount = renderPins(pins);

      XLog.debug("[search-mode] Rendered", renderedCount, "pins");

      checkEmptyPinState(renderedCount);
      updateTimeFilterBadges();
      checkClientHardwareLimits(renderedCount);
      checkServerGuardrails(body);

      const hashPin = parseMapHash(window.location.hash)?.pinId;
      if (hashPin) openPinPopup(hashPin);
      return;
    }

    // Non-search mode: use viewport-based fetching
    // Instant Client-Side JS Memory Render (0 ms latency)
    const cachedLocalPins = clientPinStore.getPinsForBbox(w, s, e, n);
    if (cachedLocalPins.length > 0) {
      const filteredLocal = filterToViewport(cachedLocalPins);
      renderPins(filteredLocal);
    }

    let url = `/api/pins?bbox=${bbox}&limit=${Math.min(limit, 1000)}`;
    if (since) url += `&since=${encodeURIComponent(since)}`;
    if (until) url += `&until=${encodeURIComponent(until)}`;
    if (_activeTag) url += `&tag=${encodeURIComponent(_activeTag)}`;

    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } catch (netErr) {
      if (netErr?.name === "AbortError") return;
      _logFetchError("network", {
        url, bbox,
        errorName: netErr?.name,
        errorMessage: netErr?.message || String(netErr),
        retryAttempted: false,
      });
      _consecutivePinFetchFailures++;
      // Retry once after 300ms (matches canvas mode behavior)
      await new Promise((r) => setTimeout(r, 300));
      if (ctrl.signal.aborted) return;
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } catch (netErr2) {
        if (netErr2?.name === "AbortError") return;
        _logFetchError("retry_exhausted", {
          url, bbox,
          errorName: netErr2?.name,
          errorMessage: netErr2?.message || String(netErr2),
          retryAttempted: true,
        });
        if (_consecutivePinFetchFailures >= 3) {
          return restoreCachedPinsOrError();
        }
        return;
      }
    }
    if (!res.ok) {
      const body = await _captureResponseBody(res);
      _logFetchError("http", {
        url, bbox,
        status: res.status,
        statusText: res.statusText,
        body,
        retryAttempted: false,
      });
      XLog.warn("pins fetch failed", res.status, res.statusText);
      _consecutivePinFetchFailures++;
      if (res.status >= 500 || _consecutivePinFetchFailures >= 3) {
        return restoreCachedPinsOrError();
      }
      return;
    }
    _consecutivePinFetchFailures = 0;
    const body = await res.json();
    const pins = body.items || body.pins || [];

    if (pins.length > 0) {
      savePinsToCache(pins, false);
      hideStaleBanner();
    }

    clientPinStore.addPins(pins);

    let allViewportPins = filterToViewport(clientPinStore.getPinsForBbox(w, s, e, n));
    let renderedCount = renderPins(allViewportPins);

    if (renderedCount === 0) {
      // Same fix as the canvas path above: don't paint cached pins from a
      // different bbox with a "live data unavailable" banner. The cache is
      // one slot, not key-per-bbox — painting them would misrepresent the
      // current viewport. checkEmptyPinState handles the user-facing
      // empty-state message.
      ;
    }

    checkEmptyPinState(renderedCount);
    updateTimeFilterBadges();
    checkClientHardwareLimits(renderedCount);
    checkServerGuardrails(body);

    // Progressive pagination — batch chunks, sync layers once at the end
    const hwCap = getClientHardwareCapabilities();
    let currentCursor = body.next_cursor;
    let hasMore = body.has_more;
    let batchDirty = false;

    while (hasMore && currentCursor && !ctrl.signal.aborted && renderedCount < hwCap.maxSafe) {
      await new Promise((r) => setTimeout(r, 150));
      if (ctrl.signal.aborted) break;

      let pageUrl = `/api/pins?bbox=${bbox}&limit=500&before=${encodeURIComponent(currentCursor)}`;
      if (since) pageUrl += `&since=${encodeURIComponent(since)}`;
      if (until) pageUrl += `&until=${encodeURIComponent(until)}`;
      if (searching) pageUrl += `&q=${encodeURIComponent(q)}`;
      if (_activeTag) pageUrl += `&tag=${encodeURIComponent(_activeTag)}`;

      const pageRes = await fetch(pageUrl, { signal: ctrl.signal });
      if (!pageRes.ok) {
        const pageBodyText = await _captureResponseBody(pageRes);
        _logFetchError("http", {
          url: pageUrl,
          bbox,
          status: pageRes.status,
          statusText: pageRes.statusText,
          body: pageBodyText,
          page: true,
        });
        break;
      }
      const pageBody = await pageRes.json();
      const pagePins = pageBody.items || pageBody.pins || [];
      if (!pagePins.length) break;

      clientPinStore.addPins(pagePins);
      batchDirty = true;
      currentCursor = pageBody.next_cursor;
      hasMore = pageBody.has_more;
    }

    // Re-render once after all progressive chunks arrive (not per-chunk)
    if (batchDirty) {
      allViewportPins = filterToViewport(clientPinStore.getPinsForBbox(w, s, e, n));
      renderedCount = renderPins(allViewportPins);
      checkClientHardwareLimits(renderedCount);
    }

    const hashPin = parseMapHash(window.location.hash)?.pinId;
    if (hashPin) openPinPopup(hashPin);

    // ════════════════════════════════════════════════════════════════
    // Boot-fetch coordinator hook — DO NOT REMOVE
    //
    // The boot-fetch coordinator (see the big "DO NOT REMOVE" comment
    // near line 8599) decides whether the current fetch's response is
    // the canonical boot fetch or a regular pan/zoom fetch.  Only the
    // canonical boot fetch updates the coordinator's state machine.
    //
    // `count` is read from the canvas renderer's current pin count,
    // which is updated synchronously by setPins(items) above.  The
    // coordinator uses count > 0 vs count === 0 to decide whether to
    // schedule a retry.
    //
    // Errors here are deliberately swallowed (caught and ignored):
    // the coordinator is best-effort diagnostic infrastructure, not a
    // critical path.  Pin rendering has already happened by this point.
    // ════════════════════════════════════════════════════════════════
    try {
      const current = (typeof canvasRenderer !== "undefined" && canvasRenderer?._pins?.length) || 0;
      window._bootFetchComplete?.(current, ctrl);
    } catch (_) { /* coordinator missing or threw — never fatal */ }
  } catch (e) {
    if (e?.name === "AbortError") return;
    // Tier 1.5: don't paint cached pins / show a banner on a stale
    // fetch — if a newer fetchPinsForViewport has already taken over
    // (inflightCtrl !== ctrl), it's responsible for the canvas state
    // and our exception here shouldn't clobber it. The diagnostic
    // still gets logged so we can find the root cause.
    if (inflightCtrl !== ctrl) return;
    // Catch-all for runtime exceptions in the fetch flow itself — JSON
    // parse failures, code bugs in popup/pagination, broken null guards,
    // etc. Not a network/HTTP error (those are caught earlier), so use
    // kind='exception' so the diagnostic distinguishes it from fetch
    // failures. Without this, the banner would show with no diagnostic
    // and we'd have no way to know what blew up.
    _logFetchError("exception", {
      url: url || fetchUrl, bbox,
      errorName: e?.name,
      errorMessage: e?.message || String(e),
    });
    // Console: also dump the stack so it shows up regardless of whether
    // the banner is dismissed/hidden by the time the user checks devtools.
    try { console.error("[xyzo] fetchPinsForViewport threw:", e); } catch (_) {}
    XLog.error("fetchPinsForViewport", e);
    restoreCachedPinsOrError();
  } finally {
    clearTimeout(_fetchTimer);
    if (inflightCtrl === ctrl) inflightCtrl = null;
  }
}

function filterToViewport(pins) {
  const b = map.getBounds();
  const dLat = (b.getNorth() - b.getSouth()) * 0.5;
  const dLng = (b.getEast() - b.getWest()) * 0.5;
  const bufferLat = Math.max(dLat * 0.5, 1.5);
  const bufferLng = Math.max(dLng * 0.5, 1.5);
  const w = b.getWest() - bufferLng;
  const e = b.getEast() + bufferLng;
  const s = b.getSouth() - bufferLat;
  const n = b.getNorth() + bufferLat;

  return pins.filter((p) => {
    const lat = p.location?.lat ?? p.lat;
    const lng = p.location?.lng ?? p.lng;
    if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) return false;
    if (lat < s || lat > n) return false;
    if (w <= e) return lng >= w && lng <= e;
    return lng >= w || lng <= e;
  });
}

function clearAllMarkers() {
  for (const g of [pinCluster, eventCluster]) {
    g.clearLayers();
    // markercluster's eachLayer() still walks _topClusterLevel's cached
    // child list when the group is detached (clearLayers only empties
    // _needsClustering/_featureGroup) — drop the tree so getLayers()
    // returns 0. It's rebuilt by _generateInitialClusters on the next
    // onAdd (which runs exactly because we delete _gridClusters here).
    g._topClusterLevel = null;
    g._needsClustering = [];
    g._needsRemoving = [];
    delete g._gridClusters;
    delete g._gridUnclustered;
  }
  markerLayer.clearLayers();
  pinMarkers.clear();
  eventMarkers.clear();
  _heatPoints = [];
  commitHeat();
}

function syncLayers() {
  _inSyncLayers = true;
  try {
    // Optimization: only rebuild clusters if markers actually changed
    const needsRebuild = _markersDirty || activeModes.has("heatmap");
    
    if (needsRebuild) {
      pinCluster.clearLayers();
      eventCluster.clearLayers();
      markerLayer.clearLayers();

      for (const m of pinMarkers.values()) {
        if (m._map) map.removeLayer(m);
        else if (m._mapToAdd) m._mapToAdd = null;
        m.__parent = null;
      }
      for (const m of eventMarkers.values()) {
        if (m._map) map.removeLayer(m);
        else if (m._mapToAdd) m._mapToAdd = null;
        m.__parent = null;
      }
    }

    const hasFilters = _activeCategoryFilters.size > 0;
    const matchesFilter = (m) => {
      if (!hasFilters) return true;
      return matchesActiveCategoryFilters(m);
    };
    const pinVisible = (m) => matchesFilter(m);
    const eventVisible = (m) => matchesFilter(m);

    const pinBatch = [];
    const eventBatch = [];
    for (const m of pinMarkers.values()) { if (pinVisible(m)) pinBatch.push(m); }
    for (const m of eventMarkers.values()) { if (eventVisible(m)) eventBatch.push(m); }

    if (needsRebuild) {
      const zoom = (typeof map !== "undefined" && map) ? map.getZoom() : 8;

      if (activeModes.has("clusters")) {
        // At zoom < 10: circle count markers go to markerLayer (unclustered)
        // to avoid Leaflet.markerClusterGroup re-clustering them invisibly.
        // At zoom >= 10: everything goes through pinCluster as normal.
        const zoomedIn = zoom >= 10;
        const circleMarkers = pinBatch.filter(m => m._pinData && m._pinData.isCircleCluster);
        const otherMarkers = pinBatch.filter(m => !(m._pinData && m._pinData.isCircleCluster));

        if (circleMarkers.length > 0) {
          if (zoomedIn) {
            pinCluster.addLayers(circleMarkers);
          } else {
            if (typeof markerLayer.addLayers === "function") markerLayer.addLayers(circleMarkers);
            else for (const m of circleMarkers) markerLayer.addLayer(m);
          }
        }

        if (otherMarkers.length > 0) pinCluster.addLayers(otherMarkers);
        if (eventBatch.length > 0) eventCluster.addLayers(eventBatch);
        try { if (map.hasLayer(pinCluster)) pinCluster.refreshClusters(); } catch (_) {}
      }
      if (activeModes.has("markers")) {
        if (pinBatch.length > 0) {
          if (typeof markerLayer.addLayers === "function") markerLayer.addLayers(pinBatch);
          else for (const m of pinBatch) markerLayer.addLayer(m);
        }
        if (eventBatch.length > 0) {
          if (typeof markerLayer.addLayers === "function") markerLayer.addLayers(eventBatch);
          else for (const m of eventBatch) markerLayer.addLayer(m);
        }
      }
      _markersDirty = false;
    }

    if (typeof canvasRenderer !== "undefined" && canvasRenderer && canvasRenderer._enabled) {
      canvasRenderer._scheduleRedraw();
    }

    // Refresh heatmap any time markers change. Gated — see commitHeat().
    commitHeat();
  } finally {
    _inSyncLayers = false;
  }

  // Restore popup cleanly ONCE if a popup was open prior to sync
  if (_activePopupState && !_popupIsOpen && !_isUserExplicitClose) {
    restoreActivePopup();
  }
}

// Icon resolution: prefer the article's category (event_type) — that's the
// most informative signal. Fall back to the source_type when category is
// missing or "other". Always returns a valid icon (never undefined) so a
// stray category from the API can't break the whole map.
function resolveCategoryFromText(text, wordFreq) {
  let combined = text ? String(text).toLowerCase() : "";
  if (wordFreq && typeof wordFreq === "object") {
    const wfWords = Object.keys(wordFreq).slice(0, 15).join(" ").toLowerCase();
    combined = combined ? (combined + " " + wfWords) : wfWords;
  }
  if (!combined) return "other";
  
  // Politics & Government (high priority — very common)
  if (/election|parliament|president|minister|senate|vote|policy|government|trump|biden|congress|diplomacy|treaty|democrat|republican|legislation|lawmaker|governor|mayor|ballot|campaign|inauguration|impeach|veto|senate|legislature|political/i.test(combined)) return "politics";
  
  // Business & Economy
  if (/market|stock|bank|inflation|economy|revenue|billion|quarter|company|business|earnings|shares|profit|crypto|trade|fed|wall street|nasdaq|dow jones|recession|gdp|unemployment|startup|venture|ipo|merger|acquisition|ceo|cfo|fiscal|monetary|tariff|sanction/i.test(combined)) return "business";
  
  // AI & Machine Learning (high priority — very common in tech news)
  if (/openai|nvidia|gpu|robot|chip|ai |\.ai|algorithm|model|semiconductor|chatgpt|gpt|llm|machine learning|deep learning|neural|transformer|copilot|gemini|claude|anthropic|deepseek|mistral|autonomous|generative ai|artificial intelligence/i.test(combined)) return "ai";
  
  // Technology
  if (/technology|computing|hardware|gadget|telecom|mobile|apple|google|meta|microsoft|tech|cyber|hack|data breach|privacy|encryption|blockchain|quantum|cloud computing|saas|devops|startup|silicon valley|app|software update|ios|android|5g|wifi|broadband/i.test(combined)) return "technology";
  
  // Disaster & Emergency
  if (/earthquake|flood|tsunami|volcano|wildfire|typhoon|hurricane|landslide|disaster|catastrophe|explosion|collapse|accident|rescue|emergency|evacuation|relief|crisis|emergency response/i.test(combined)) return "disaster";
  
  // Crime & Safety
  if (/police|arrest|kill|murder|court|suspect|crime|investigation|shooting|jail|prison|theft|robbery|stabbing|assault|homicide|kidnapping|fraud|scam|corruption|bribery|smuggling|trafficking|cartel|gang|weapon|gun|firearm|shootout|burglary|larceny|arson/i.test(combined)) return "crime";
  
  // Conflict & War
  if (/war|military|strike|missile|army|defense|nato|russia|ukraine|gaza|israel|weapons|troops|combat|conflict|invasion|occupation|ceasefire|cease-fire|cease fire|bombing|airstrike|drone strike|ceasefire|frontline|trench|artillery|battalion|regiment|deployment|mobilization|conscript|insurg|rebel|guerrilla|terror|extremis|radicaliz|jihad|caliphate|bomb|detonat|hostage|siege|blockade|sanction|embargo|peacekeep|peace keep|humanitarian aid|refugee camp|displaced|internally displaced|idp|asylum/i.test(combined)) return "conflict";
  
  // Sports
  if (/soccer|football|nba|nfl|match|league|cup|champion|win|player|sports|tournament|score|fifa|cricket|tennis|golf|boxing|mma|ufc|formula|f1|nascar|olympic|medal|world cup|super bowl|playoff|semifinal|quarterfinal|grand slam|wimbledon|masters|pga|ncaa|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league|copa|world series|stanley cup|grand prix|athletics|marathon|swimming|diving|gymnastics|cycling|rowing|sailing|surfing|skiing|snowboard|ice hockey|baseball|basketball|volleyball|handball|rugby|cricket test|t20|ipl|ashes/i.test(combined)) return "sports";
  
  // Environment & Climate
  if (/climate|environment|carbon|emissions|warming|wildlife|conservation|species|pollution|ecology|deforestation|rainforest|ocean|marine|coral|reef|biodiversity|extinction|endangered|sustainable|renewable|green|solar|wind farm|fossil fuel|oil spill|plastic|recycling|compost|organic farming|permaculture|rewilding|habitat|ecosystem|greenhouse|paris agreement|cop28|cop29|net zero|carbon neutral|carbon footprint/i.test(combined)) return "environment";
  
  // Weather
  if (/weather|storm|tornado|forecast|blizzard|heatwave|snow|rain|wind|temperature|celsius|fahrenheit|humidity|barometric|pressure system|cold front|warm front|thunderstorm|lightning|hail|monsoon|cyclone|typhoon|hurricane|drought|flood warning|weather alert|weather advisory|wind chill|heat index|frost|freeze|ice storm|sleet|fog|mist/i.test(combined)) return "weather";
  
  // Health & Medicine
  if (/health|virus|hospital|cancer|medical|vaccine|disease|doctor|fda|patient|infection|pandemic|epidemic|outbreak|quarantine|lockdown|mental health|depression|anxiety|obesity|diabetes|heart disease|stroke|alzheimer|dementia|covid|sars|flu|influenza|antibiotic|antimicrobial|pharmaceutical|drug|medication|therapy|surgery|transplant|organ|blood|plasma|ambulance|paramedic|nurse|clinic|pharmacy|biotech|clinical trial|fda approval|who|cdc|nih|surgeon general/i.test(combined)) return "health";
  
  // Science & Research
  if (/space|nasa|planet|science|study|research|scientist|physics|telescope|astronomy|galaxy|solar system|mars|moon|jupiter|saturn|venus|mercury|neptune|pluto|asteroid|comet|supernova|black hole|dark matter|dark energy|quantum|particle|atom|molecule|dna|gene|genome|crispr|biotech|laboratory|experiment|hypothesis|peer review|journal|publication|arxiv|pubmed|nobel|breakthrough|discovery|innovation|patent|prototype|testing|validation/i.test(combined)) return "science";
  
  // Culture & Entertainment
  if (/movie|film|music|song|actor|actress|concert|festival|culture|art|museum|theatre|novel|book|author|writer|poet|gallery|exhibition|oscar|grammy|emmy|tony|emmy|golden globe|cannes|venice|berlin film|sundance|netflix|disney|hbo|streaming|podcast|radio|tv show|television|series|anime|manga|comic|graphic novel|fashion|design|architecture|photography|dance|opera|ballet|symphony|orchestra|choir|literature|poetry|sculpture|painting|graffiti|street art|vintage|antique|collectible/i.test(combined)) return "culture";
  
  // Education
  if (/school|university|student|college|teacher|education|academic|professor|lecturer|campus|diploma|degree|bachelor|master|phd|thesis|dissertation|curriculum|syllabus|enrollment|tuition|scholarship|grant|research paper|publish|journal|peer review|accreditation|k-12|kindergarten|elementary|middle school|high school|community college|ivy league|sat|act|gre|gmat|exam|test score|graduation|commencement|valedictorian|salutatorian/i.test(combined)) return "education";
  
  // Food & Agriculture
  if (/food|restaurant|chef|cooking|recipe|cuisine|farm|agriculture|harvest|crop|livestock|dairy|meat|vegetable|fruit|organic|sustainable food|farm to table|food safety|food security|famine|drought|irrigation|fertilizer|pesticide|gmo|genetic modified|food waste|composting|permaculture|aquaculture|fishing|seafood|wine|beer|spirits|coffee|tea|chocolate|sugar|salt|spice|herb|bakery|butcher|brewery|distillery|winery/i.test(combined)) return "food";
  
  // Transit & Transportation
  if (/traffic|bridge|road|crash|accident|transit|highway|train|subway|railway|flight|airline|bus|airport|port|shipping|logistics|supply chain|delivery|uber|lyft|taxi|rideshare|commute|bicycle|bike lane|pedestrian|walkway|tunnel|ferry|cruise|aviation|boeing|airbus|faa|ntsb|railroad|freight/i.test(combined)) return "transit";
  
  // Housing & Real Estate
  if (/housing|real estate|rent|mortgage|property|apartment|condo|homeowner|foreclosure|zoning|landlord|tenant|eviction|affordable housing|homeless|shelter|construction|building|developer|urbancity planning|gentrification|suburb|metropolitan|urban|rural/i.test(combined)) return "housing";
  
  // Energy
  if (/energy|oil|gas|petroleum|nuclear|solar|wind power|hydroelectric|geothermal|biomass|pipeline|refinery|opec|lng|coal|mining|drilling|fracking|hydrogen|battery|electric vehicle|ev charging|power plant|grid|electricity|utility/i.test(combined)) return "energy";
  
  // Automotive
  if (/automotive|car|vehicle|truck|suv|ev |electric car|tesla|ford|gm|toyota|honda|bmw|mercedes|volkswagen|hyundai|kia|nissan|porsche|ferrari|lamborghini|collision|recall|dealership|autonomous driving|self-driving|lidar|road test|car review|motorcycle|scooter/i.test(combined)) return "automotive";
  
  // Finance & Banking
  if (/finance|banking|investment|portfolio|mutual fund|etf|bond|treasury|interest rate|central bank|federal reserve|ecb|boj|inflation|deflation|recession|gdp|economic growth|unemployment|wage|salary|income tax|capital gains|dividend|stock market|forex|currency|exchange rate|bitcoin|ethereum|cryptocurrency|blockchain|defi|nft|web3/i.test(combined)) return "business";
  
  // Legal & Courts
  if (/court|judge|jury|trial|lawsuit|verdict|sentence|appeal|justice|attorney|lawyer|prosecution|defense|indictment|arraignment|bail|plea|constitutional|amendment|bill of rights|supreme court|appellate|district court|federal court|class action|settlement|mediation|arbitration|copyright|patent|trademark|intellectual property/i.test(combined)) return "politics";
  
  // Humanitarian & Refugees
  if (/refugee|asylum|displaced|humanitarian|aid|relief|unhcr|red cross|unicef|who|msf|doctors without borders|food aid|famine|drought|flood|earthquake relief|tsunami relief|hurricane relief|disaster relief|emergency response|evacuation|rescue|salvation|charity|ngo|nonprofit|volunteer|donation/i.test(combined)) return "humanitarian";
  
  // LGBTQ+
  if (/lgbtq|gay|lesbian|bisexual|transgender|queer|pride|same-sex|marriage equality|discrimination|homophobia|transphobia|gender identity|gender expression|drag|rainbow/i.test(combined)) return "culture";
  
  // Immigration & Border
  if (/immigration|immigrant|border|visa|deportation|asylum seeker|undocumented|illegal alien|border patrol|ice |customs|passport|citizenship|naturalization|green card|daca|dreamer|migrant|caravan|wall|fence/i.test(combined)) return "politics";
  
  // Labor & Unions
  if (/labor|union|strike|worker|employee|employer|minimum wage|overtime|workplace|safety|occupational|hiring|firing|layoff|unemployment|job|career|profession|salary|wage|compensation|benefits|pension|401k|health insurance|workers comp/i.test(combined)) return "business";
  
  // Religion & Spirituality
  if (/religion|church|mosque|temple|synagogue|prayer|worship|faith|spiritual|bishop|pastor|priest|imam|rabbi|monk|nun|pope|vatican|catholic|protestant|evangelical|buddhist|hindu|sikh|jain|jewish|muslim|islam|christianity|bible|quran|torah|sermon|congregation|denomination|parish|diocese|monastery|ashram|meditation|yoga|mindfulness/i.test(combined)) return "culture";
  
  // Animals & Pets
  if (/animal|pet|dog|cat|bird|fish|horse|wildlife|zoo|aquarium|conservation|endangered|species|breed|veterinarian|vet |spay|neuter|adoption|rescue|shelter|puppy|kitten|kennel|cattery/i.test(combined)) return "environment";
  
  // Space & Astronomy (more specific)
  if (/nasa|spacex|blue origin|rocket|satellite|orbit|astronaut|space station|iss|lunar|moon landing|mars rover|telescope|james webb|hubble|asteroid|comet|supernova|nebula|galaxy|constellation|eclipse|solar flare|cosmic|interstellar|exoplanet/i.test(combined)) return "science";
  
  // Marine & Ocean
  if (/ocean|sea|marine|whale|dolphin|shark|coral|reef|fishing|fishing boat|deep sea|submarine|navy|coast guard|port|harbor|shipping|tanker|cruise|ferry|tidal|tsunami|wave|surf|beach|coast|island|archipelago/i.test(combined)) return "environment";
  
  // Crypto & Digital Finance
  if (/bitcoin|btc|ethereum|eth|crypto|blockchain|defi|nft|web3|token|coin|mining|wallet|exchange|binance|coinbase|solana|cardano|polkadot|chainlink|uniswap|aave|maker|dao|altcoin|stablecoin|tether|usdt|usdc/i.test(combined)) return "business";
  
  // Social Media & Influencers
  if (/instagram|tiktok|youtube|twitter|x\.com|facebook|meta|snapchat|twitch|influencer|viral|meme|trend|hashtag|follower|subscriber|content creator|streamer|youtuber|tiktok|reel|story|post|tweet|retweet|like|share|comment|engagement|reach|impression/i.test(combined)) return "culture";
  
  // Defense & Aerospace
  if (/defense|defence|pentagon|cia|nsa|fbi|homeland|terrorism|counterterrorism|intelligence|spy|espionage|surveillance|reconnaissance|drone|uav|stealth|fighter jet|bomber|aircraft carrier|submarine|missile|icbm|nuclear weapon|bioweapon|chemical weapon|cyberwar|information warfare|propaganda/i.test(combined)) return "conflict";
  
  // Trade & Economics
  if (/trade war|tariff|import|export|customs|wto|world trade|free trade|trade deal|trade agreement|nafta|usmca|eu trade|supply chain|logistics|shipping|freight|container|port|cargo|warehouse|distribution|retail|wholesale|consumer|spending|savings|debt|credit|loan|interest|inflation|deflation|stagflation/i.test(combined)) return "business";
  
  // Entertainment & Culture (expanded — joyful news, events, fun)
  if (/movie|film|music|song|actor|actress|concert|festival|culture|art|museum|theatre|novel|book|author|writer|poet|gallery|exhibition|oscar|grammy|emmy|tony|golden globe|cannes|venice|berlin film|sundance|netflix|disney|hbo|streaming|podcast|radio|tv show|television|series|anime|manga|comic|graphic novel|fashion|design|architecture|photography|dance|opera|ballet|symphony|orchestra|choir|literature|poetry|sculpture|painting|graffiti|street art|vintage|antique|collectible|gaming|esports|twitch|youtube|tiktok|influencer|viral|meme|comedy|stand-up|humor|late night|talk show|reality tv|talent show|karaoke|trivia|escape room|board game|video game|arcade|haunted house|circus|carnival|fair|parade|fireworks|celebration|party|nightclub|dj|edm|hip hop|rap|rock|pop|jazz|blues|country|folk|classical|reggae|salsa|tango|flamenco|bollywood|kpop|jpop|latin|afrobeats|indie|alternative|underground|local band|open mic|poetry slam|spoken word|drag show|burlesque|improv|comedy club|trivia night|pub quiz|game night|movie night|film screening|gallery opening|art show|book signing|concert series|music festival|film festival|food festival|cultural festival|street fair|farmers market|craft fair|art walk|gallery walk|first friday|museum night|late night museum|theater performance|broadway|off-broadway|community theater|talent competition|eurovision|dance competition|dance recital|ballet performance|opera performance|symphony concert|jazz festival|rock concert|pop concert|indie concert|local music scene|music venue|nightclub|dance club|warehouse party|rave|edm festival|hip hop show|open mic night|comedy night|poetry slam|spoken word night|drag brunch|drag show|improv night|comedy club|trivia night|pub quiz|board game cafe|escape room|arcade|video game tournament|esports|gaming convention|comic convention|fan convention|cosplay|anime convention|comic con|film festival|movie premiere|red carpet|awards ceremony|gala|charity gala|benefit concert|fundraiser|community event|neighborhood event|block party|street festival|carnival|circus|fair|county fair|state fair|rodeo|harvest festival|holiday celebration|christmas market|holiday market|new year celebration|fireworks|light festival|lantern festival|cultural celebration|heritage festival/i.test(combined)) return "entertainment";
  
  // Human-interest / Love & Fun (joy, relationships, community)
  if (/love|wedding|marriage|proposal|anniversary|romance|dating|relationship|family|parenting|child|baby|pregnancy|adoption|pet|dog|cat|animal|rescue|adoption|kindness|charity|volunteer|community|neighbor|friendship|mentorship|inspiration|motivational|success story|overcome|triumph|hero|good deed|random act|pay it forward|feel good|uplifting|heartwarming|tears of joy|happy|joy|fun|play|game|sport|recreation|hobby|craft|diy|maker|artisan|handmade|creative|imagination|dream|wish|hope|faith|believe|gratitude|thankful|blessed|celebrate|festive|holiday|birthday|graduation|retirement|new year|christmas|hanukkah|diwali|eid|easter|passover|lunar new year|thanksgiving|independence day|valentine|mother day|father day/i.test(combined)) return "human";
  
  // Default fallback
  return "other";
}

function iconFor(item) {
  let cat = (item.category || item.event_type || "").toLowerCase().trim();
  if (!cat || cat === "other" || cat === "news" || cat === "none" || cat === "rss") {
    cat = resolveCategoryFromText(item.title || item.headline || "", item.word_freq);
  }
  const source = item.source_type;
  let key;
  if (cat && cat !== "other" && cat !== "news" && EVENT_ICONS[cat]) {
    key = cat;
  } else if (cat && cat !== "other" && cat !== "news" && SUBTYPE_TO_BUCKET[cat] && EVENT_ICONS[SUBTYPE_TO_BUCKET[cat]]) {
    key = SUBTYPE_TO_BUCKET[cat];
  } else if (cat && cat !== "other" && cat !== "news" && EVENT_COLORS[cat]) {
    key = cat;
  } else if (SOURCE_ICONS[source]) {
    key = source;
  } else {
    key = "other";
  }
  const path = EVENT_ICONS[key] || (SUBTYPE_TO_BUCKET[key] && EVENT_ICONS[SUBTYPE_TO_BUCKET[key]]) || EVENT_ICONS.other;
  const colorBucket = SUBTYPE_TO_BUCKET[key] || key;
  const color = EVENT_COLORS[key] || EVENT_COLORS[colorBucket] || SOURCE_COLORS[key] || EVENT_COLORS.other;
  return {
    key,                            // resolved icon key (e.g. "elections")
    path,
    color,
    isSource: (key === source) && source in SOURCE_COLORS,
    sourceLabel: source,
  };
}

function buildMarkerDiv(icon, opts = {}) {
  const size = opts.size ?? 38;
  const title = opts.title ? escapeHtml(opts.title) : "";
  const titleAttr = title ? ` title="${title}" aria-label="${title}"` : "";
  const catClass = `pin cat-${icon.key}`;
  const hotClass = opts.critical ? " pin-critical" : opts.hot ? " pin-hot" : "";
  const rankBadge = (opts.clusterRank === 0 && (opts.sourceCount || 1) > 1)
    ? `<span class="pin-top-badge" title="Top story">★</span>`
    : "";
  const srcBadge = opts.sourceCount > 1
    ? `<span class="src-badge" title="${opts.sourceCount} sources">${opts.sourceCount}</span>`
    : "";
  return `
    <div class="${catClass}${hotClass}" style="--c:${icon.color}" data-category="${icon.key}"${titleAttr}>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true">${icon.path}</svg>
      ${icon.isSource ? `<span class="src-dot">${icon.sourceLabel.slice(0, 3)}</span>` : ""}
      ${srcBadge}
      ${rankBadge}
      <button type="button" class="pin-dismiss" aria-label="Dismiss this marker" title="Dismiss">&#10005;</button>
    </div>`;
}

const MARKER_ICON_SIZE = 38;

// ── Per-marker ✕ dismiss ───────────────────────────────────────────────
// Every DOM pin carries a small ✕ (see buildMarkerDiv). A click on it
// removes JUST that marker from the map and from the registries, without
// opening the popup. The marker is re-created on the next viewport fetch
// (it is not a permanent "hide this story" — that would need server
// state), so this is a temporary "get this out of my way" affordance.
//
// Delegated from the map container: pins are re-created constantly by
// renderPins, so binding per-marker would leak listeners. The handler
// runs in the CAPTURE phase and stops propagation, so the marker's own
// click (which opens the popup) never fires.
function wirePinDismiss() {
  const mapEl = (typeof map !== "undefined" && map && map.getContainer && map.getContainer()) || null;
  if (!mapEl || mapEl._xyzoDismissWired) return;
  mapEl._xyzoDismissWired = true;
  mapEl.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest(".pin-dismiss") : null;
    if (!btn) return;
    // Stop the pin's own click handler from firing (it would open the
    // popup we are trying to escape) and keep the map click-through
    // guard from treating this as a "place a story" tap.
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    const pinEl = btn.closest(".xyzo-pin");
    if (!pinEl) return;
    // Find the Leaflet marker whose icon element is this pin.
    const all = [];
    if (typeof pinMarkers !== "undefined") pinMarkers.forEach((m) => all.push(m));
    if (typeof eventMarkers !== "undefined") eventMarkers.forEach((m) => all.push(m));
    const marker = all.find((m) => m.getElement && m.getElement() === pinEl);
    if (!marker) return;
    const id = marker._xyzoId || (marker._pinData && marker._pinData.id);
    // Drop it from the map and from the registries so syncLayers() and
    // the cluster rebuild don't resurrect it this session.
    try { map.removeLayer(marker); } catch (_) {}
    if (typeof pinMarkers !== "undefined" && id != null) pinMarkers.delete(id);
    if (typeof eventMarkers !== "undefined" && id != null) eventMarkers.delete(id);
    if (typeof pinCluster !== "undefined" && pinCluster.removeLayer) {
      try { pinCluster.removeLayer(marker); } catch (_) {}
    }
    if (typeof eventCluster !== "undefined" && eventCluster.removeLayer) {
      try { eventCluster.removeLayer(marker); } catch (_) {}
    }
    // Note: the CANVAS renderer (the fast path at low zoom) draws pins
    // without DOM nodes, so it has no ✕ to click — the master "Markers"
    // toggle in the layers dropdown is the off-switch there. This ✕
    // only exists on the DOM-marker fallback path, so we just remove the
    // Leaflet marker and its registry entries above. Mutating
    // canvasRenderer._pins here would desync it from setPins()'s
    // spread-overlap bookkeeping.
  }, true); // capture phase
}

// ── Pin Spreading Algorithm ──────────────────────────────────────────────
// When multiple pins share the same coordinates, spread them out in a
// circular pattern so they're all visible and clickable. Uses city size
// data to determine the spread radius.
//
// This runs client-side without AI - pure math calculations.

// City size data (approximate radius in km for spread calculation)
// This can be extended with data from the world_cities table
const CITY_SIZES = {
  // Major cities with approximate radius in km
  'perth': 25, 'sydney': 30, 'melbourne': 25, 'brisbane': 20, 'adelaide': 15,
  'canberra': 10, 'hobart': 8, 'darwin': 10, 'gold coast': 15, 'newcastle': 12,
  'auckland': 20, 'wellington': 10, 'christchurch': 12,
  'london': 30, 'paris': 25, 'berlin': 20, 'rome': 15, 'madrid': 20,
  'amsterdam': 12, 'brussels': 10, 'vienna': 12, 'prague': 10, 'warsaw': 15,
  'moscow': 30, 'istanbul': 25, 'tokyo': 35, 'osaka': 20, 'seoul': 25,
  'beijing': 30, 'shanghai': 30, 'mumbai': 25, 'delhi': 30, 'bangkok': 25,
  'singapore': 15, 'kuala lumpur': 20, 'jakarta': 30, 'manila': 25,
  'dubai': 20, 'riyadh': 25, 'cairo': 25, 'lagos': 25, 'nairobi': 15,
  'johannesburg': 20, 'cape town': 15, 'sydney': 30, 'melbourne': 25,
  'new york': 30, 'los angeles': 35, 'chicago': 25, 'houston': 30,
  'phoenix': 25, 'philadelphia': 20, 'san antonio': 20, 'san diego': 20,
  'dallas': 25, 'san francisco': 20, 'seattle': 20, 'denver': 20,
  'boston': 15, 'cape cod': 15, 'provincetown': 10, 'hyannis': 10, 'falmouth': 10, 'nantucket': 10, 'martha\'s vineyard': 10,
  'atlanta': 20, 'miami': 20, 'toronto': 25, 'montreal': 20,
  'vancouver': 20, 'calgary': 15, 'ottawa': 15, 'mexico city': 30,
  'sao paulo': 35, 'rio de janeiro': 25, 'buenos aires': 25, 'lima': 25,
  'bogota': 25, 'santiago': 20, 'caracas': 15,
};

// Get city radius in km based on city name or zoom level
function getCityRadiusKm(cityName, zoom) {
  let radius = 15;
  if (cityName) {
    const normalizedName = cityName.toLowerCase().trim();
    if (CITY_SIZES[normalizedName]) {
      radius = CITY_SIZES[normalizedName];
    } else {
      for (const [city, r] of Object.entries(CITY_SIZES)) {
        if (normalizedName.includes(city) || city.includes(normalizedName)) {
          radius = r;
          break;
        }
      }
    }
  }

  // Scale spread radius down as zoom increases so markers stay close at street/neighborhood zoom
  if (zoom >= 15) return Math.min(radius, 0.05); // ~50 meters at street level (z=15+)
  if (zoom >= 13) return Math.min(radius, 0.2);  // ~200 meters at block level (z=13-14)
  if (zoom >= 11) return Math.min(radius, 1.0);  // ~1 km at neighborhood level (z=11-12)
  if (zoom >= 9)  return Math.min(radius, 5.0);  // ~5 km at city level (z=9-10)
  return radius;
}

// Convert km to degrees (approximate)
function kmToDegrees(km, latitude) {
  // 1 degree of latitude ≈ 111 km
  // 1 degree of longitude ≈ 111 km * cos(latitude)
  const latRad = latitude * Math.PI / 180;
  const latDeg = km / 111;
  const lngDeg = km / (111 * Math.cos(latRad));
  return { latDeg, lngDeg };
}

// Check if a pin is a Top Global Story based on frequency, AI study, or NN
function isTopStoryPin(p) {
  if (!p) return false;
  if (p.is_top_story || p.top) return true;
  const sc = Number(p.source_count ?? p.sc ?? 1);
  return sc >= 20;
}
window.isTopStoryPin = isTopStoryPin;

// Only highlight top stories when in Clusters mode or Links mode, keeping the main markers view clean.
function shouldHighlightTopStories() {
  const inClusters = typeof activeModes !== "undefined" && activeModes && activeModes.has("clusters");
  const inLinks = typeof linksEnabled !== "undefined" && Boolean(linksEnabled);
  return inClusters || inLinks;
}
window.shouldHighlightTopStories = shouldHighlightTopStories;

function pinScore(p) {
  const srcCount = Number(p.source_count ?? p.sc ?? 1);
  const isTop = isTopStoryPin(p);
  const createdMs = new Date(p.published_at || p.created_at || 0).getTime();
  const ageHours = Math.max(0, (Date.now() - createdMs) / 3600000);
  const recency = Math.max(0, 100 - ageHours);
  const wf = p.word_freq || p.wf;
  let wfBoost = 0;
  if (wf && typeof wf === "object") {
    const vals = Object.values(wf);
    if (vals.length > 0) {
      wfBoost = Math.min(25, vals.length * 2);
    }
  }
  const topBoost = isTop ? 1000 : 0;
  const imageBoost = (p.image_url || p.img) ? 15 : 0;
  return topBoost + (srcCount * 50) + recency + wfBoost + imageBoost;
}

// Spread overlapping pins in a circular pattern around location.
// Displays Top 5 Most Recent/Impactful Stories as clean individual markers with screen-pixel clearance.
// If > 6 stories exist at coordinate, groups the remainder into an interactive +N More Stories Overflow Badge!
function spreadOverlappingPins(pins) {
  if (!pins || pins.length <= 1) return pins;
  
  const zoom = (typeof map !== "undefined" && map) ? map.getZoom() : 11;
  const grouped = new Map();
  
  for (const pin of pins) {
    const lat = pin.location?.lat ?? pin.lat;
    const lng = pin.location?.lng ?? pin.lng;
    if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) continue;

    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(pin);
  }
  
  const spreadPins = [];
  for (const [key, group] of grouped) {
    if (group.length === 1) {
      spreadPins.push(group[0]);
      continue;
    }

    // Sort group so the most hot, critical, frequent, or rich stories appear first
    group.sort((a, b) => pinScore(b) - pinScore(a));

    const baseLat = group[0].location?.lat ?? group[0].lat;
    const baseLng = group[0].location?.lng ?? group[0].lng;
    // .pn = compact NDJSON pin shape (light=1) — without this the
    // "N Stories in <city>" header fell back to "this location".
    const cityName = group[0].pn || group[0].place_name || group[0].location?.place_name || "";

    // Show up to 5 top stories in a clean ring + 1 center overflow badge for the rest
    const hasOverflow = group.length > 6;
    const visibleCount = hasOverflow ? 5 : group.length;
    const overflowCount = group.length - visibleCount;

    // Fixed screen pixel radius (~38px) provides plenty of clearance so 24px pins never overlap
    const pixelRadius = 38;
    const hasMapProj = typeof map !== "undefined" && map && typeof map.latLngToContainerPoint === "function";
    let centerPt = null;
    try {
      if (hasMapProj) centerPt = map.latLngToContainerPoint([baseLat, baseLng]);
    } catch (_) {}

    const radiusKm = getCityRadiusKm(cityName, zoom);
    const { latDeg, lngDeg } = kmToDegrees(radiusKm, baseLat);
    const fallbackRingRadius = Math.min(latDeg, lngDeg) * 0.35;

    const angleStep = (2 * Math.PI) / visibleCount;
    const angleOffset = -Math.PI / 2; // Start from top (12 o'clock)

    for (let i = 0; i < visibleCount; i++) {
      const angle = i * angleStep + angleOffset;
      let spreadLat, spreadLng;

      if (hasMapProj && centerPt) {
        try {
          const offsetPt = L.point(
            centerPt.x + Math.cos(angle) * pixelRadius,
            centerPt.y + Math.sin(angle) * pixelRadius
          );
          const projected = map.containerPointToLatLng(offsetPt);
          spreadLat = projected.lat;
          spreadLng = projected.lng;
        } catch (_) {
          spreadLat = baseLat + Math.sin(angle) * fallbackRingRadius;
          spreadLng = baseLng + Math.cos(angle) * fallbackRingRadius;
        }
      } else {
        spreadLat = baseLat + Math.sin(angle) * fallbackRingRadius;
        spreadLng = baseLng + Math.cos(angle) * fallbackRingRadius;
      }

      spreadPins.push({
        ...group[i],
        _clusterRank: i,
        _clusterSize: group.length,
        location: {
          ...group[i].location,
          lat: spreadLat,
          lng: spreadLng,
          _originalLat: baseLat,
          _originalLng: baseLng,
        }
      });
    }

    // Add interactive Center Overflow Badge Pin if more than 6 stories exist at this location
    if (hasOverflow) {
      spreadPins.push({
        id: `overflow_${group[0].id}_${overflowCount}`,
        isOverflowBadge: true,
        overflowCount: overflowCount,
        totalCount: group.length,
        cityName: cityName || group[0].place_name || "this location",
        title: `${cityName || 'Location'}: +${overflowCount} more stories (${group.length} total)`,
        category: "other",
        location: {
          lat: baseLat,
          lng: baseLng,
          _originalLat: baseLat,
          _originalLng: baseLng,
        },
        allArticles: group,
      });
    }
  }

  return spreadPins;
}

function openLocationExplorerModal(placeName, articles, initialFilter = "") {
  let modal = document.getElementById("location-explorer-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "location-explorer-modal";
    modal.className = "location-explorer-modal";
    document.body.appendChild(modal);
  }

  const renderArticlesList = (filterText = "") => {
    const term = filterText.toLowerCase().trim();
    const filtered = (articles || []).filter(a => {
      if (!term) return true;
      const title = (a.title || "").toLowerCase();
      const cat = (a.category || "").toLowerCase();
      const src = (a.source_name || "").toLowerCase();
      return title.includes(term) || cat.includes(term) || src.includes(term);
    });

    const listHtml = filtered.map(a => {
      const icon = iconFor(a);
      const isTop = typeof isTopStoryPin === "function" && isTopStoryPin(a);
      const timeStr = a.published_at ? formatRelativeTime(a.published_at) : "";
      const imgSrc = _imgProxy(a.image_url);
      const img = imgSrc ? `<img class="loc-item-img" src="${escapeHtml(imgSrc)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-source-id="${a.source_id || ''}" onload="imgOnLoad(this)" onerror="imgOnError(this)">` : "";
      const topBadge = isTop ? `<span class="loc-top-tag" style="font-size: 10px; padding: 2px 6px; background: rgba(239, 68, 68, 0.2); color: #ef4444; border-radius: 10px; margin-left: 6px; font-weight: 600;">🔴 Top Story</span>` : "";
      const countBadge = (a.source_count && a.source_count > 1) ? `<span style="font-size: 10px; padding: 2px 6px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border-radius: 10px; margin-left: 6px;">${a.source_count} sources</span>` : "";
      return `
        <div class="loc-explorer-card" onclick="openPinPopupFromExplorer(${a.id});">
          ${img}
          <div class="loc-card-body">
            <div class="loc-card-header">
              <span class="loc-card-icon" style="color: ${icon.color || 'var(--primary)'}; display: inline-flex; align-items: center;">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon.path}</svg>
              </span>
              <span class="loc-card-source">${escapeHtml(a.source_name || a.source_type || 'News')}</span>
              ${topBadge}
              ${countBadge}
              <span class="loc-card-time">${timeStr}</span>
            </div>
            <h4 class="loc-card-title">${escapeHtml(a.title || 'News Story')}</h4>
            ${a.canonical_url ? `<a href="${escapeHtml(a.canonical_url)}" target="_blank" rel="noopener" class="loc-card-link" onclick="event.stopPropagation();">Read Article ↗</a>` : ''}
          </div>
        </div>
      `;
    }).join("");

    return `
      <div class="loc-explorer-content">
        <header class="loc-explorer-header">
          <div class="loc-explorer-title">
            <span>📚</span> <strong>${(articles || []).length} Stories in ${escapeHtml(placeName || 'this location')}</strong>
          </div>
          <button class="loc-explorer-close" onclick="closeLocationExplorerModal()">&times;</button>
        </header>
        <div class="loc-explorer-search">
          <input type="text" id="loc-explorer-search-input" placeholder="Search stories in ${escapeHtml(placeName)}..." value="${escapeHtml(filterText)}" oninput="updateLocationExplorerSearch(this.value)">
        </div>
        <div class="loc-explorer-list">
          ${listHtml || '<div class="loc-explorer-empty">No stories match your filter.</div>'}
        </div>
      </div>
    `;
  };

  window._currentLocationExplorerArticles = articles;
  window._currentLocationExplorerPlace = placeName;

  modal.innerHTML = renderArticlesList(initialFilter);
  modal.hidden = false;
}

function openPinPopupFromExplorer(articleId) {
  closeLocationExplorerModal();
  const marker = pinMarkers.get(articleId) || pinMarkers.get(Number(articleId)) || eventMarkers.get(String(articleId));
  if (marker) {
    openPinPopup(articleId);
    return;
  }
  const articles = window._currentLocationExplorerArticles || [];
  const article = articles.find(a => a.id === articleId || String(a.id) === String(articleId));
  if (article && typeof openPinPopupFromCanvas === "function") {
    openPinPopupFromCanvas(article);
  }
}

function updateLocationExplorerSearch(val) {
  const articles = window._currentLocationExplorerArticles || [];
  const placeName = window._currentLocationExplorerPlace || "";
  openLocationExplorerModal(placeName, articles, val);
  const inp = document.getElementById("loc-explorer-search-input");
  if (inp) {
    inp.focus();
    inp.selectionStart = inp.selectionEnd = inp.value.length;
  }
}

function closeLocationExplorerModal() {
  const modal = document.getElementById("location-explorer-modal");
  if (modal) modal.hidden = true;
}


// Store original positions for saving back to server
const _originalPinPositions = new Map();



// Group multi-pin locations into circular count markers at low zoom (z < 7)
// Automatically unfurls into individual story markers at z >= 7 or when 'markers' mode is selected.
function groupPinsByCluster(pins) {
  if (!pins || !pins.length) return [];
  const zoom = (typeof map !== "undefined" && map) ? map.getZoom() : 8;

  // Unfurl if explicitly in unclustered 'markers' mode OR zoomed in (z >= 7)
  if ((typeof activeModes !== "undefined" && activeModes.has("markers")) || zoom >= 7) {
    return spreadOverlappingPins(pins);
  }

  const grouped = new Map();

  for (const p of pins) {
    const lat = p.location?.lat ?? p.lat;
    const lng = p.location?.lng ?? p.lng;
    if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) continue;

    const place = p.place_name || p.location?.place_name || "";
    const key = place ? place.toLowerCase().trim() : `${lat.toFixed(2)},${lng.toFixed(2)}`;

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(p);
  }

  const result = [];
  for (const [key, group] of grouped) {
    if (group.length === 1) {
      result.push(group[0]);
    } else {
      const lead = group[0];
      const baseLat = lead.location?.lat ?? lead.lat;
      const baseLng = lead.location?.lng ?? lead.lng;
      const placeName = lead.place_name || lead.location?.place_name || key;

      result.push({
        ...lead,
        id: `circle_cluster_${lead.id}_${group.length}`,
        isCircleCluster: true,
        clusterCount: group.length,
        cityName: placeName,
        location: { lat: baseLat, lng: baseLng, place_name: placeName },
        title: `${placeName}: ${group.length} markers`,
      });
    }
  }

  return result;
}

function getCircleTier(count) {
  if (count >= 200) {
    return { size: 64, className: "cluster-tier-extreme", fontSize: "14px", zIndex: 1200 };
  } else if (count >= 50) {
    return { size: 52, className: "cluster-tier-high", fontSize: "13px", zIndex: 1100 };
  } else if (count >= 10) {
    return { size: 42, className: "cluster-tier-medium", fontSize: "12px", zIndex: 1000 };
  } else {
    return { size: 32, className: "cluster-tier-low", fontSize: "11px", zIndex: 900 };
  }
}

function buildCircularCountMarker(p) {
  const count = p.clusterCount || 2;
  const tier = getCircleTier(count);
  const size = tier.size;
  const radius = Math.round(size / 2);

  const html = `
    <div class="xyzo-circle-count-marker ${tier.className}" style="width:${size}px; height:${size}px; line-height:${size}px; font-size:${tier.fontSize};" title="${escapeHtml(p.cityName || '')} — ${count} stories (click to zoom in)">
      <span class="count-val">${count}</span>
    </div>
  `;

  const divIcon = L.divIcon({
    className: "xyzo-circle-count-wrapper",
    html: html,
    iconSize: [size, size],
    iconAnchor: [radius, radius],
  });

  const lat = p.location?.lat ?? p.lat;
  const lng = p.location?.lng ?? p.lng;
  const marker = L.marker([lat, lng], { icon: divIcon, zIndexOffset: tier.zIndex });
  marker._pinData = p;
  marker._xyzoLat = lat;
  marker._xyzoLng = lng;
  marker._xyzoCategory = SUBTYPE_TO_BUCKET[(p.category || "").toLowerCase()] || p.category || "other";
  marker._xyzoHeatType = p.source_type;

  marker.bindPopup(() => {
    const placeName = p.cityName || p.location?.place_name || "this area";
    return `
      <button class="popup-close-btn" aria-label="Close popup">✕</button>
      <div style="text-align:center;padding:36px 0 4px;">
        <div style="font-size:13px;font-weight:700;margin-bottom:6px;">${escapeHtml(placeName)}</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">${count} stor${count === 1 ? "y" : "ies"} here</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px;">Zoom in to see individual stories, sorted by importance.</div>
        <button onclick="if(typeof map!=='undefined'&&map)map.flyTo([${lat},${lng}],Math.max(map.getZoom()+3,11),{duration:0.7})" style="padding:6px 14px;font-size:12px;border-radius:6px;background:rgba(94,234,212,0.15);border:1px solid rgba(94,234,212,0.4);color:var(--accent,#5eead4);cursor:pointer;font-weight:600;">Zoom In ▸</button>
      </div>
    `;
  }, POPUP_OPTIONS);

  marker.on("mousedown", (e) => {
    if (e && e.originalEvent) e.originalEvent.stopPropagation();
    else L.DomEvent.stopPropagation(e);
  });
  marker.on("click", (e) => {
    if (e && e.originalEvent) e.originalEvent.stopPropagation();
    map.flyTo([lat, lng], Math.max(map.getZoom() + 3, 11), { duration: 0.7 });
  });

  return marker;
}

function renderPins(pins) {
  // Group multi-pin cities into summary badges at medium/low zoom (z < 10)
  // Unfurls into individual story markers at deep zoom (z >= 10)
  const spreadPins = groupPinsByCluster(pins);
  
  // Store original positions for potential save
  for (const p of spreadPins) {
    if (p.location._originalLat !== undefined) {
      _originalPinPositions.set(p.id, {
        originalLat: p.location._originalLat,
        originalLng: p.location._originalLng,
        spreadLat: p.location.lat,
        spreadLng: p.location.lng,
        spreadIndex: p.location._spreadIndex,
        spreadTotal: p.location._spreadTotal,
      });
    }
  }
  
  // Heat data and registries are the canonical store; the actual map layer
  // for pins depends on renderMode and is applied by syncLayers().
  //
  // PERFORMANCE: previously this function did `pinMarkers.clear()` and
  // rebuilt every marker from scratch on every fetchPinsForViewport call
  // (= every pan / zoom). With the city-level cap of 400 pins that's
  // ~400 marker DOM elements torn down and recreated per move, which
  // makes panning feel laggy and jitters the heatmap overlay. We now
  // diff: markers already in pinMarkers are kept in place (Leaflet doesn't
  // need a new object just because the data refreshed), markers no longer
  // in `pins` are removed, and missing markers are created. The icon, the
  // popup, the data fields and the side-channels all stay stable across
  // re-renders.
  const nextIds = new Set();
  let markersChanged = false;
  for (const p of spreadPins) {
    nextIds.add(p.id);
    let m = pinMarkers.get(p.id);
    if (!m) {
      // New pin in this viewport — create it.
      m = p.isCircleCluster
        ? buildCircularCountMarker(p)
        : (p.isOverflowBadge ? buildOverflowClusterMarker(p) : buildPinMarker(p));
      pinMarkers.set(p.id, m);
      markersChanged = true;
    } else {
      // Existing pin: refresh mutable side-channels. The marker object
      // itself and its DOM are reused — Leaflet reads lat/lng via
      // getLatLng() each frame, so the position is automatically current.
      // (category & source_type CAN change between fetches when the AI
      // reclassifies an article, so we always update them rather than
      // trusting the first-seen values.)
      m._pinData = p;
      m._xyzoHeatType = p.source_type;
      m._xyzoEventId = p.event_id || p.id || null;
      m._xyzoCategory = SUBTYPE_TO_BUCKET[(p.category || "").toLowerCase()] || p.category || "other";
      
      // Update position if pin was spread
      if (p.location._originalLat !== undefined) {
        m.setLatLng([p.location.lat, p.location.lng]);
        markersChanged = true;
      }
      m._xyzoLat = p.location.lat;
      m._xyzoLng = p.location.lng;
    }
  }
  // Remove pins that fell out of the viewport (or were filtered by time).
  // We collect first to avoid mutating the Map while iterating.
  const toRemove = [];
  for (const [id, m] of pinMarkers) {
    if (!nextIds.has(id)) toRemove.push([id, m]);
  }
  for (const [id, m] of toRemove) {
    if (m._map) map.removeLayer(m);
    pinMarkers.delete(id);
    markersChanged = true;
  }
  if (markersChanged) _markersDirty = true;
  rebuildHeatPoints();
  commitHeat();
  syncLayers();
  renderLinks();
  refreshLinksToggleTitle();
  return spreadPins.length;
}

// Update a marker's position in the registry without full refresh.
// This is used after a successful location correction.
function updateMarkerPosition(pinId, newLat, newLng, placeName) {
  const m = pinMarkers.get(pinId);
  if (!m) return;

  // Check if popup is currently open
  const wasPopupOpen = m.isPopupOpen();

  // Update the marker's position
  m.setLatLng([newLat, newLng]);

  // Update the popup content if it exists
  if (m._popup) {
    const popup = m.getPopup();
    if (popup) {
      const content = popup.getContent();
      if (typeof content === 'string') {
        // Update the location display in the popup
        const updated = content
          .replace(/Coords:.*?<\/div>/, `Coords: ${newLat.toFixed(4)}, ${newLng.toFixed(4)}</div>`)
          .replace(/Place:.*?<\/div>/, `Place: ${escapeHtml(placeName || "unknown")}</div>`);
        popup.setContent(updated);
      }
    }
  }

  // Update the marker's data attributes
  if (m._popup && m._popup._source) {
    m._popup._source._xyzoLat = newLat;
    m._popup._source._xyzoLng = newLng;
  }

  // If popup was open, re-open it at the new position with offset
  // so the popup shows beside the icon, not under it
  if (wasPopupOpen) {
    // Close the popup first
    m.closePopup();

    // Re-open with a small delay to allow position update
    setTimeout(() => {
      // Set popup offset to show beside the marker
      if (m._popup) {
        m._popup.options.offset = [15, -10]; // Right side, slightly up
      }
      m.openPopup();
    }, 100);
  }
}

// ── Save Spread Positions to Server ──────────────────────────────────────
// Save the adjusted pin positions back to the server so they persist.
// This is useful for permanently spreading out overlapping pins.

async function saveSpreadPositions() {
  if (_originalPinPositions.size === 0) {
    XLog.log('[spread] No positions to save');
    return { saved: 0, errors: 0 };
  }
  
  const positions = [];
  for (const [pinId, pos] of _originalPinPositions) {
    // Only save if the position actually changed
    if (pos.spreadLat !== pos.originalLat || pos.spreadLng !== pos.originalLng) {
      positions.push({
        pin_id: pinId,
        lat: pos.spreadLat,
        lng: pos.spreadLng,
        spread_index: pos.spreadIndex,
        spread_total: pos.spreadTotal,
      });
    }
  }
  
  if (positions.length === 0) {
    XLog.log('[spread] No positions changed');
    return { saved: 0, errors: 0 };
  }
  
  XLog.log(`[spread] Saving ${positions.length} adjusted positions...`);
  
  try {
    const res = await fetch('/api/pins/spread-positions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positions }),
    });
    
    if (!res.ok) {
      XLog.error('[spread] Failed to save:', res.status);
      return { saved: 0, errors: positions.length };
    }
    
    const data = await res.json();
    XLog.log('[spread] Saved successfully:', data);
    return { saved: data.saved || positions.length, errors: 0 };
  } catch (e) {
    XLog.error('[spread] Error saving:', e);
    return { saved: 0, errors: positions.length };
  }
}

// Get spread statistics for the current viewport
function getSpreadStats() {
  const stats = {
    totalPins: pinMarkers.size,
    spreadPins: _originalPinPositions.size,
    clusters: 0,
    maxClusterSize: 0,
  };
  
  const clusterSizes = new Map();
  for (const [pinId, pos] of _originalPinPositions) {
    const key = `${pos.originalLat.toFixed(4)},${pos.originalLng.toFixed(4)}`;
    clusterSizes.set(key, (clusterSizes.get(key) || 0) + 1);
  }
  
  stats.clusters = clusterSizes.size;
  for (const size of clusterSizes.values()) {
    stats.maxClusterSize = Math.max(stats.maxClusterSize, size);
  }
  
  return stats;
}

function buildOverflowClusterMarker(p) {
  const count = p.overflowCount || 1;
  const badgeText = count > 999 ? `+${Math.floor(count / 1000)}k` : `+${count}`;
  const size = 32;
  const radius = Math.round(size / 2);

  const html = `
    <div class="xyzo-overflow-cluster-marker" style="width:${size}px; height:${size}px; line-height:${size}px;" title="${escapeHtml(p.cityName || '')} — ${p.totalCount || count} stories (click to explore all stories)">
      <span class="overflow-val">${badgeText}</span>
    </div>
  `;

  const divIcon = L.divIcon({
    className: "xyzo-overflow-wrapper",
    html: html,
    iconSize: [size, size],
    iconAnchor: [radius, radius],
  });

  const lat = p.location?.lat ?? p.lat;
  const lng = p.location?.lng ?? p.lng;
  const marker = L.marker([lat, lng], { icon: divIcon, zIndexOffset: 1200 });
  marker._pinData = p;
  marker._xyzoLat = lat;
  marker._xyzoLng = lng;
  marker._xyzoCategory = "other";

  marker.on("mousedown", (e) => {
    if (e && e.originalEvent) e.originalEvent.stopPropagation();
    else L.DomEvent.stopPropagation(e);
  });
  marker.on("click", (e) => {
    if (e && e.originalEvent) e.originalEvent.stopPropagation();
    openLocationExplorerModal(p.cityName, p.allArticles || []);
  });

  return marker;
}

// Construct the L.marker for a single pin + wire all the side-channels +
// popup. Pulled out of renderPins so the diff loop and the initial-create
// path share the same factory.
function buildPinMarker(p) {
  const icon = iconFor(p);
  const score = pinScore(p);
  const highlightTop = typeof shouldHighlightTopStories === "function" && shouldHighlightTopStories();
  const isHot = highlightTop && score >= 300;
  const isCritical = highlightTop && score >= 500;
  const isTop = highlightTop && typeof isTopStoryPin === "function" && isTopStoryPin(p);
  const size = isCritical ? 44 : isHot ? 40 : MARKER_ICON_SIZE;
  const html = buildMarkerDiv(icon, {
    size,
    title: p.title,
    hot: isHot,
    critical: isCritical,
    clusterRank: highlightTop ? p._clusterRank : undefined,
    sourceCount: highlightTop ? p.source_count : undefined,
  });
  const divIcon = L.divIcon({
    className: "xyzo-pin" + (isTop ? " xyzo-pin-top-story" : ""),
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    zIndexOffset: isTop ? 1000 : isCritical ? 500 : isHot ? 250 : (p._clusterRank === 0 ? 100 : 0),
  });
  const marker = L.marker([p.location.lat, p.location.lng], { icon: divIcon });
  marker._pinData = p;
  marker.bindPopup(() => buildPopup(marker._pinData || p), POPUP_OPTIONS);
  // LEAFLET'S OWN CLICK HANDLER OPENS THE POPUP SYNCHRONOUSLY. It is
  // registered by bindPopup() and it runs BEFORE the handler below, so
  // the popup used to appear 0 ms into the 700 ms flyToBounds that
  // maybeZoomToCluster() starts for any pin with ≥3 neighbours within
  // 30 km — which, after a search, is nearly every pin. The popup then
  // RIDES the flight and lands wherever the flight ended.
  //
  // It is removed here so the popup opens exactly ONCE, from
  // openPopupWhenSettled(), after the map has settled.
  try { marker.off("click", marker._openPopup); } catch (_) {}
  marker.on("popupopen", (e) => {
    wirePopupActions(e.popup, marker._pinData || p);
    if (typeof XyzoAnalytics !== 'undefined') {
      XyzoAnalytics.trackPinView(marker._pinData || p);
    }
    UserTracker.trackCategory((marker._pinData || p).category || (marker._pinData || p).event_type);
    UserTracker.trackLocation((marker._pinData || p).location?.lat, (marker._pinData || p).location?.lng, (marker._pinData || p).location?.place_name);
    const pinId = marker._xyzoId || p.id;
    if (pinId != null) _popupDwellMap.set(pinId, Date.now());
  });
  marker.on("popupclose", () => {
    const pinId = marker._xyzoId || p.id;
    if (pinId != null) {
      const openTime = _popupDwellMap.get(pinId);
      if (openTime != null) {
        const dwellMs = Date.now() - openTime;
        _popupDwellMap.delete(pinId);
        _fireSearchJourney('popup_dwell', { dwell_ms: dwellMs });
      }
    }
    clearSelectedPin();
  });
  marker._xyzoHeatType = p.source_type;
  marker._xyzoEventId = p.event_id || p.id || null;
  marker.on("mousedown", (e) => {
    if (e && e.originalEvent) e.originalEvent.stopPropagation();
    else L.DomEvent.stopPropagation(e);
  });
  marker.on("click", (e) => {
    if (map._popup && !marker.isPopupOpen()) {
      _isUserExplicitClose = true;
      map.closePopup();
      _isUserExplicitClose = false;
    }
    const alreadyOpen = marker.isPopupOpen();
    if (alreadyOpen) {
      // Leaflet used to TOGGLE the popup here: its own `click →
      // _openPopup` handler is registered first, so it ran before this
      // one and closed the popup. That handler is gone now (see above),
      // so the toggle is done here — otherwise a second tap on the same
      // pin did nothing at all.
      window.closeActivePopup();
      return;
    }
    if (p.location && p.location.lat != null && p.location.lng != null) {
      map.panTo([p.location.lat, p.location.lng], { animate: true, duration: 0.4 });
    }
    const targetEventId = marker._xyzoEventId || p.id;
    setSelectedPin(p.id, targetEventId);
    if (linksEnabled && targetEventId != null) {
      toggleHighlightEvent(targetEventId);
    }
    if (p.id != null) {
      _fireSearchJourney('pin_click', { clicked_pin_id: p.id });
    }
    // NO AUTO-ZOOM — the map stays where the reader put it, and the
    // popup carries the zoom as a button (see zoomToPlace()).
    //
    // The popup still waits for the map to settle before it opens: the
    // small pan to the pin is an animation, and a popup that opens into
    // it slides for the rest of it, and the ✕ Close moves with it.
    if (p.location?.lat != null && p.location?.lng != null) {
      openPopupWhenSettled(() => {
        if (!marker.isPopupOpen() && !_popupIsOpen) marker.openPopup();
      });
    }
  });
  marker._xyzoCategory = SUBTYPE_TO_BUCKET[icon.key] || icon.key;
  marker._xyzoId = p.id;
  marker._xyzoLat = p.location.lat;
  marker._xyzoLng = p.location.lng;
  return marker;
}

async function renderEvents(events) {
  // Same diff-and-reuse pattern as renderPins: events already in the
  // registry keep their L.marker object and DOM; only the underlying
  // data side-channels refresh. Adding/removing from the cluster layer
  // (eventCluster) is handled by syncLayers() at the end of this
  // function, so the diff is invisible to the user.
  const nextIds = new Set();
  let markersChanged = false;
  for (const ev of events) {
    if (!ev.location || ev.location.lat == null || ev.location.lng == null) continue;
    nextIds.add(ev.id);
    let m = eventMarkers.get(ev.id);
    if (!m) {
      m = buildEventMarker(ev);
      eventMarkers.set(ev.id, m);
      markersChanged = true;
    } else {
      m._pinData = ev;
      m._xyzoCategory =
        SUBTYPE_TO_BUCKET[ev.event_type] || ev.event_type || "other";
    }
  }
  const toRemove = [];
  for (const [id, m] of eventMarkers) {
    if (!nextIds.has(id)) toRemove.push([id, m]);
  }
  for (const [id, m] of toRemove) {
    if (m._map) map.removeLayer(m);
    eventMarkers.delete(id);
    markersChanged = true;
  }
  if (markersChanged) _markersDirty = true;
  // Append-only heat: renderPins() set the canonical _heatPoints above; we
  // want both pin and event points in the heatmap. Re-pull from registries.
  rebuildHeatPoints();
  commitHeat();
  syncLayers();
  renderLinks();
  refreshLinksToggleTitle();
  return nextIds.size;
}

// Construct an L.marker for a single event + popup + side-channels.
// Pulled out so the diff loop and the initial-create path share a factory.
function buildEventMarker(ev) {
  const icon = iconFor({ category: ev.event_type, source_type: "rss" });
  const html = buildMarkerDiv(icon, {
    size: MARKER_ICON_SIZE,
    title: ev.headline,
    badge: ev.source_count > 1 ? ev.source_count : null,
  });
  const divIcon = L.divIcon({
    className: "xyzo-pin newsium-event",
    html,
    iconSize: [MARKER_ICON_SIZE, MARKER_ICON_SIZE],
    iconAnchor: [MARKER_ICON_SIZE / 2, MARKER_ICON_SIZE / 2],
  });
  const marker = L.marker([ev.location.lat, ev.location.lng], { icon: divIcon });
  marker._pinData = ev;
  marker.bindPopup(() => buildEventPopup(marker._pinData || ev), POPUP_OPTIONS);
  // LEAFLET'S OWN CLICK HANDLER OPENS THE POPUP SYNCHRONOUSLY — before
  // the handler below, and before the map has settled. Removed so the
  // event popup opens exactly once, from openPopupWhenSettled().
  try { marker.off("click", marker._openPopup); } catch (_) {}
  marker.on("popupopen", (e) => wireEventPopupActions(e.popup, marker._pinData || ev));
  marker.on("popupclose", () => {
    clearSelectedPin();
  });
  marker._xyzoCategory =
    SUBTYPE_TO_BUCKET[ev.event_type] || ev.event_type || "other";
  marker._xyzoEventId = ev.id;
  marker._xyzoId = ev.id;
  marker._xyzoLat = ev.location.lat;
  marker._xyzoLng = ev.location.lng;
  marker.on("mousedown", (e) => {
    if (e && e.originalEvent) e.originalEvent.stopPropagation();
    else L.DomEvent.stopPropagation(e);
  });
  // Click handler: smooth panTo center + link mode / connection highlight
  marker.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    const alreadyOpen = marker.isPopupOpen();
    if (alreadyOpen) {
      // Leaflet used to toggle the popup here (its own click handler ran
      // first). That handler is gone now — see above — so the toggle is
      // done here.
      window.closeActivePopup();
      return;
    }
    if (ev.location && ev.location.lat != null && ev.location.lng != null) {
      map.panTo([ev.location.lat, ev.location.lng], { animate: true, duration: 0.4 });
    }
    setSelectedPin(ev.id, ev.id);
    if (_addLinkMode === "story" && _addLinkEventA) {
      handleMarkerClickForLink(e);
    } else if (linksEnabled) {
      toggleHighlightEvent(ev.id);
    }
    // Open the popup ONCE THE MAP HAS SETTLED — the pan above is a
    // 400 ms animation, and a popup that opens into it slides for the
    // rest of it (see openPopupWhenSettled).
    openPopupWhenSettled(() => {
      if (!marker.isPopupOpen() && !_popupIsOpen) marker.openPopup();
    });
  });
  return marker;
}

// Reconstruct the heatmap point array from the marker registries. We do this
// (instead of pushing incrementally across renderPins/renderEvents) so the
// caller can replace either set without losing the other.
function rebuildHeatPoints() {
  _heatPoints = [];
  if (typeof canvasRenderer !== "undefined" && Array.isArray(canvasRenderer._pins) && canvasRenderer._pins.length > 0) {
    for (const p of canvasRenderer._pins) {
      if (!matchesActiveCategoryFilters(p)) continue;
      if (p.location && Number.isFinite(p.location.lat) && Number.isFinite(p.location.lng)) {
        const t = p.source_type || "rss";
        _heatPoints.push([p.location.lat, p.location.lng, HEAT_WEIGHT[t] ?? 1.0]);
      } else if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
        const t = p.source_type || p.st || "rss";
        _heatPoints.push([p.lat, p.lng, HEAT_WEIGHT[t] ?? 1.0]);
      }
    }
  }
  for (const [, p] of pinMarkers) {
    if (!matchesActiveCategoryFilters(p)) continue;
    const ll = p.getLatLng();
    // Map marker → source type from the registry key isn't possible; instead
    // stash the type in a side-channel at registration time.
    const t = p._xyzoHeatType || "rss";
    _heatPoints.push([ll.lat, ll.lng, HEAT_WEIGHT[t] ?? 1.0]);
  }
  for (const [, m] of eventMarkers) {
    const ll = m.getLatLng();
    _heatPoints.push([ll.lat, ll.lng, HEAT_WEIGHT.event]);
  }
}

// Collect [lat, lng] for every rendered marker (pins ∪ events) so the caller
// can fitBounds() over the whole result set.
//
// REMOVED 2026-11-09: the search frames the region from the RAW result
// data (storyPoints()) rather than from the rendered markers, because a
// renderer's spread position is a lie about where a story happened — the
// exporter keeps _rawPins for the same reason.

function buildEventPopup(ev) {
  const place = ev.location ? ev.location.place_name || "" : "";
  const when = formatRelativeTime(ev.first_reported_at);
  const distLabel = ev.location ? formatPopupDistance(ev.location.lat, ev.location.lng) : "";
  const readTime = estimateReadingTimeText(ev.summary || ev.headline);
  const cat = ev.event_type || "other";
  const displayCat = beautifyCategory(cat, ev.headline);

  const imgHtml = ev.image_url
    ? (() => {
        const src = _imgProxy(ev.image_url);
        if (!src) return "";
        return `<div class="popup-hero-wrap" style="position:relative;width:100%;max-height:160px;border-radius:8px;overflow:hidden;margin-bottom:8px;background:rgba(15,23,42,0.6);box-shadow:0 4px 12px rgba(0,0,0,0.3);">
        <img src="${escapeAttr(src)}" alt="${escapeAttr(ev.headline)}" loading="lazy" referrerpolicy="no-referrer" data-source-id="${ev.source_id || ''}" style="width:100%;height:140px;object-fit:cover;display:block;" onload="imgOnLoad(this)" onerror="imgOnError(this)">
       </div>`;
      })()
    : "";

  const div = ev.diversity;
  const divBadge = div === "local"
    ? '<span class="diversity-badge local">🏙️ local</span>'
    : div === "national"
    ? '<span class="diversity-badge national">🌍 national</span>'
    : div === "international"
    ? '<span class="diversity-badge international">🌎 international</span>'
    : "";
  const paywallBadge = ev.paywall
    ? `<span class="paywall-badge" title="Source may require subscription">🔒 paywall</span>`
    : "";
  const undercoverBadge = ev.undercover_score && ev.undercover_score >= 60
    ? `<span class="undercover-badge" title="Undercovered: low mainstream coverage, high local coverage" style="display:inline-block;padding:1px 6px;margin:1px;font-size:10px;background:rgba(138,43,226,0.2);color:#b87fff;border-radius:3px;border:1px solid rgba(138,43,226,0.4);">🟣 undercovered ${Math.round(ev.undercover_score)}</span>`
    : "";

  // Check if mobile
  const isMobile = window.innerWidth <= 768;
  
  const headlineHtml = ev.url
    ? `<a href="${escapeAttr(ev.url)}" target="_blank" rel="noopener noreferrer" style="color:inherit;">${escapeHtml(ev.headline)}</a>`
    : escapeHtml(ev.headline);

  if (isMobile) {
    // Simplified mobile popup.
    //
    // The close button is MANDATORY: Leaflet's own X is hidden by CSS
    // (`.leaflet-container a.leaflet-popup-close-button { display: none
    // !important }`) because the custom button replaced it — so a popup
    // without a custom button has NO way to be closed at all. That is
    // what the event popup did.
    return `
      ${imgHtml}
      <div style="position:relative;">
        <button class="popup-close-btn-mobile" aria-label="Close popup">✕ Close</button>
        <div style="padding-top:34px;">
          <div style="font-size:11px;font-weight:700;color:var(--accent,#5eea2d);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${escapeHtml(displayCat)}</div>
          <h3 style="font-size:14px;line-height:1.3;margin-bottom:6px;font-weight:700;">${headlineHtml}</h3>
          <div style="font-size:10px;color:var(--muted);margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            <span>⏱️ ${when}</span>
            ${distLabel ? `<span style="color:var(--fg);">${distLabel}</span>` : ""}
            <span>📰 ${ev.source_count} source${ev.source_count === 1 ? "" : "s"}</span>
          </div>
        </div>
        <div class="popup-actions" style="display:flex;gap:4px;flex-wrap:wrap;">
          <button class="event-load" data-id="${ev.id}" style="padding:5px 10px;font-size:11px;border-radius:6px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:var(--fg);cursor:pointer;">📰 Sources</button>
          <button class="event-details-btn" data-id="${ev.id}" style="padding:5px 10px;font-size:11px;border-radius:6px;background:rgba(94,234,212,0.15);border:1px solid rgba(94,234,212,0.4);color:var(--accent,#5eea2d);cursor:pointer;">Details ▸</button>
        </div>
        <div class="event-details-full" style="display:none;">
          <div style="font-size:11px;color:var(--muted);margin-bottom:8px;">${readTime}</div>
          <div class="popup-badges" style="margin-bottom:10px;">${divBadge}${undercoverBadge}${paywallBadge}</div>
          <div class="popup-actions" style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="event-linked" data-id="${ev.id}" style="padding:5px 10px;font-size:11px;border-radius:6px;background:rgba(94,234,212,0.12);border:1px solid rgba(94,234,212,0.3);color:var(--accent,#5eea2d);cursor:pointer;">🔗 Linked Stories</button>
          </div>
          <div id="event-sources-${ev.id}"></div>
          <div id="event-linked-${ev.id}"></div>
        </div>
      </div>
    `;
  }

  return `
    ${imgHtml}
    <button class="popup-close-btn" aria-label="Close popup">✕</button>
    <div style="font-size:11px;font-weight:700;color:var(--accent,#5eea2d);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;padding-right:44px;">${escapeHtml(displayCat)}</div>
    <h3 style="font-size:15px;line-height:1.35;margin-bottom:6px;font-weight:700;padding-right:44px;">${headlineHtml}</h3>
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
      <span>⏱️ ${when}</span>
      <span>${readTime}</span>
      ${distLabel ? `<span style="color:var(--fg);">${distLabel}</span>` : ""}
      <span>📰 ${ev.source_count} source${ev.source_count === 1 ? "" : "s"}</span>
    </div>
    <div class="popup-badges" style="margin-bottom:10px;">${divBadge}${paywallBadge}</div>
    <div class="popup-actions" style="display:flex;gap:6px;flex-wrap:wrap;">
      <button class="event-load" data-id="${ev.id}" style="padding:5px 10px;font-size:11px;border-radius:6px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:var(--fg);cursor:pointer;">📰 Load Sources</button>
      <button class="event-linked" data-id="${ev.id}" style="padding:5px 10px;font-size:11px;border-radius:6px;background:rgba(94,234,212,0.12);border:1px solid rgba(94,234,212,0.3);color:var(--accent,#5eea2d);cursor:pointer;">🔗 Linked Stories</button>
    </div>
    <div id="event-sources-${ev.id}"></div>
    <div id="event-linked-${ev.id}"></div>
  `;
}

function wireEventPopupActions(popup, ev) {
  const el = popup.getElement();

  // ── Close button (works on both mobile and desktop) ───────────────
  // Leaflet's own X is hidden by CSS, so the custom button is the ONLY
  // way out of this popup. Without it the popup cannot be closed.
  attachPopupClose(el);

  // ── Mobile details toggle ─────────────────────────────────────────
  const detailsBtn = el.querySelector(".event-details-btn");
  if (detailsBtn) {
    detailsBtn.addEventListener("click", () => {
      const fullDetails = el.querySelector(".event-details-full");
      if (fullDetails) {
        const isHidden = fullDetails.style.display === "none";
        fullDetails.style.display = isHidden ? "block" : "none";
        detailsBtn.textContent = isHidden ? "Details ▾" : "Details ▸";
      }
    });
  }
  
  // "Load sources" button.
  const btn = el.querySelector(".event-load");
  if (btn) {
    btn.addEventListener("click", async () => {
      btn.textContent = "loading…"; btn.disabled = true;
      try {
        const res = await fetch(`/api/events/${ev.id}`);
        if (!res.ok) { btn.textContent = "failed"; return; }
        const detail = await res.json();
        const container = el.querySelector(`#event-sources-${ev.id}`);
        if (!container) return;
        const list = (detail.sources || []).map((s) => {
          // Show a badge for auto-tagged articles (fast-path or source fallback).
          const method = s.auto_categorize_method;
          const conf = s.auto_categorize_confidence;
          let autoBadge = "";
          if (method === "source_fallback") {
            autoBadge = '<span class="auto-tag source-fallback" title="Location derived from news source (no AI)">📍 source</span>';
          } else if (method === "fast_path" && conf === "high") {
            autoBadge = '<span class="auto-tag fast-path" title="Auto-detected from text (high confidence)">🏷️ auto</span>';
          } else if (method === "fast_path") {
            autoBadge = '<span class="auto-tag fast-path-low" title="Auto-detected from text">🏷️ auto</span>';
          } else if (method === "client_apply") {
            autoBadge = '<span class="auto-tag client" title="Location suggested by user">👤 user</span>';
          }
          return `<div class="event-source">
            <div class="src">${escapeHtml(s.source_name || "")} ${autoBadge}</div>
            <div><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a></div>
          </div>`;
        }).join("");
        const topics = (detail.topics || []).slice(0, 6).map((t) =>
          `<span class="badge ${t.slug === "other" ? "" : t.slug}">${escapeHtml(t.label)}</span>`
        ).join(" ");
        container.innerHTML = `
          <div style="margin-top:6px">${topics}</div>
          <hr>
          ${list || "<small>no sources</small>"}
          <div style="margin-top:6px;font-size:11px;color:var(--muted)">
            confidence ${(detail.avg_confidence || 0).toFixed(2)}
          </div>`;
      } catch (e) {
        btn.textContent = "error";
      }
    });
  }

  // "Linked stories" button.
  const linkedBtn = el.querySelector(".event-linked");
  if (linkedBtn) {
    linkedBtn.addEventListener("click", async () => {
      linkedBtn.textContent = "searching…"; linkedBtn.disabled = true;
      const container = el.querySelector(`#event-linked-${ev.id}`);
      if (!container) return;
      container.innerHTML = `<div class="explore-status"><span class="explore-spinner"></span> Finding related stories…</div>`;
      try {
        const res = await fetch(`/api/events/${ev.id}/related?limit=10`);
        if (!res.ok) { container.innerHTML = `<small style="color:#fca5a5">Failed to load</small>`; return; }
        const data = await res.json();
        const related = data.related || [];
        if (related.length === 0) {
          container.innerHTML = `<div style="font-size:11px;color:var(--muted);margin-top:6px">No related stories found yet.</div>`;
          return;
        }
        // Render related stories list.
        const list = related.map((r) => {
          const place = r.location?.place_name || "";
          const dist = r.distance_km != null ? ` · ${r.distance_km < 1 ? "<1" : Math.round(r.distance_km)} km` : "";
          const matchBadges = (r.match_reasons || []).map(m =>
            `<span class="link-badge" style="background:${matchReasonColor(m)};font-size:8px;padding:1px 4px">${m}</span>`
          ).join(" ");
          return `<div class="event-linked-item" data-lat="${r.location?.lat || ''}" data-lng="${r.location?.lng || ''}">
            <div style="font-size:11px;font-weight:600;color:var(--fg)">${escapeHtml(r.headline.slice(0, 80))}${r.headline.length > 80 ? "…" : ""}</div>
            <div style="font-size:10px;color:var(--muted)">${escapeHtml(place)}${dist} ${matchBadges}</div>
          </div>`;
        }).join("");
        container.innerHTML = `<div style="margin-top:6px;font-size:10px;color:var(--accent);font-weight:600">${related.length} related ${related.length === 1 ? "story" : "stories"}</div>${list}`;
        // Wire click-to-fly on related items.
        container.querySelectorAll(".event-linked-item").forEach((el) => {
          el.addEventListener("click", () => {
            const lat = Number(el.dataset.lat);
            const lng = Number(el.dataset.lng);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
              map.flyTo([lat, lng], Math.max(map.getZoom(), 6), { duration: 0.6 });
            }
          });
        });
        // Draw connection lines to related stories.
        drawRelatedConnections(ev, related);
      } catch (e) {
        container.innerHTML = `<small style="color:#fca5a5">Error</small>`;
      }
    });
  }
}

function matchReasonColor(reason) {
  const colors = { geography: "#f59e0b", category: "#8b5cf6", entity: "#e879f9", topic: "#60a5fa", time: "#14b8a6" };
  for (const [k, c] of Object.entries(colors)) {
    if (reason.includes(k)) return c;
  }
  return "#94a3b8";
}

// Draw connection lines from a source event to its related stories.
const _relatedLayer = L.layerGroup();
function drawRelatedConnections(sourceEv, related) {
  if (map.hasLayer(_relatedLayer)) map.removeLayer(_relatedLayer);
  _relatedLayer.clearLayers();
  if (!sourceEv.location) return;
  const a = L.latLng(sourceEv.location.lat, sourceEv.location.lng);
  for (const r of related) {
    if (!r.location) continue;
    const b = L.latLng(r.location.lat, r.location.lng);
    const color = "#ef4444";
    const latlngs = greatCircleArc(a, b, 20);
    const line = L.polyline(latlngs, {
      color, weight: 2.5, opacity: 0.7,
      className: "xyzo-conn-highlight",
      interactive: false,
    });
    _relatedLayer.addLayer(line);
  }
  map.addLayer(_relatedLayer);
  // Auto-remove after 15 seconds.
  setTimeout(() => { if (map.hasLayer(_relatedLayer)) map.removeLayer(_relatedLayer); }, 15000);
}

function getTranslatedArticleUrl(url) {
  if (!url) return '';
  const lang = typeof XyzoI18n !== 'undefined' ? XyzoI18n.getLang() : 'en';
  if (lang && lang !== 'en') {
    return `https://translate.google.com/translate?sl=auto&tl=${lang}&u=${encodeURIComponent(url)}`;
  }
  return url;
}

// ── THE POINT DETAILS ───────────────────────────────────────────────────
//
// Owner ask: *"when you click on a point.. can you have it show the
// details of that point including the google popup map showing the
// satellite view for example lat/lng and anything else a user might want
// to know about that point... nearest town nearest news... if that takes
// too long dont do it.. just show something so they can see at least the
// lat/lng and a few other things that are fast for us to provide"*
//
// EVERYTHING HERE IS ALREADY IN HAND — NO REQUEST, NO WAIT. The pin
// carries its own coordinates, its place, its source, its time and how
// many outlets carry the story; the NEAREST NEWS is the "Related
// Stories" section the popup already has (the event's other articles);
// and the NEAREST TOWN is the place the story was placed in, which the
// pin already carries.
//
// THE SATELLITE VIEW IS A BUTTON, NOT AN EMBEDDED MAP. The satellite
// popup (openSatellitePopup) is a NESTED Leaflet map: a second map to
// build and four Esri tiles to fetch. Opening that automatically would
// make every pin tap wait for a picture of a field — which is exactly
// the "if that takes too long dont do it" the owner said. The button
// asks for it, and the popup it opens also carries the Google and Bing
// satellite links (a satellite view WITHOUT leaving the site is the
// nice-to-have; the deep link is the one that always works).
function pinLatLng(p) {
  if (!p) return null;
  const lat = Number(p.location?.lat ?? p.lat ?? p.extracted_lat);
  const lng = Number(p.location?.lng ?? p.lng ?? p.extracted_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function formatCoord(value, positive, negative) {
  const v = Math.abs(Number(value));
  const s = v.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  return `${s}° ${value >= 0 ? positive : negative}`;
}

function pinPlaceName(p) {
  if (!p) return "";
  return String(
    p.place_name ||
    p.location?.place_name ||
    p.pn ||
    p.extracted_location ||
    p.location?.city ||
    ""
  ).trim();
}

// The compact line: the coordinates, and nothing else. It is on the
// MOBILE header too, because a phone is where the reader most wants
// the numbers and least wants to expand anything.
function pointCoordsLine(p) {
  const ll = pinLatLng(p);
  if (!ll) return "";
  return `<span class="popup-coords-inline">📍 ${escapeHtml(formatCoord(ll.lat, "N", "S"))} · ${escapeHtml(formatCoord(ll.lng, "E", "W"))}</span>`;
}

// The two ways to SEE THE GROUND: the satellite view (a nested map) and
// a copy of the coordinates.
//
// THEY LIVE IN THE ACTION ROW, NOT IN A BLOCK OF THEIR OWN — because
// the popup's content is SCROLLABLE and only ~380 px of it is visible
// (measured: 914 px of content in a 380 px box), so a block lower down
// the popup is below the fold: invisible AND un-hittable (clipped
// content is not hit-tested). The header carries the NUMBERS and the
// action row carries the BUTTONS.
function pointActionButtons(p) {
  const ll = pinLatLng(p);
  if (!ll) return "";
  return `
    <button type="button" class="popup-action-btn popup-zoom-here-btn" data-lat="${ll.lat}" data-lng="${ll.lng}" title="Zoom the map to this place">🔎</button>
    <button type="button" class="popup-action-btn popup-satellite-btn" data-lat="${ll.lat}" data-lng="${ll.lng}" title="See the satellite view of this exact spot">📡</button>
    <button type="button" class="popup-action-btn popup-copy-coords-btn" data-lat="${ll.lat}" data-lng="${ll.lng}" title="Copy the coordinates">📋</button>
  `;
}

function buildPopup(p) {
  const icon = iconFor(p);
  const rawCat = p.category || p.event_type || icon.key || "other";
  const displayCat = beautifyCategory(rawCat, p.title);
  const catColor = icon.color || EVENT_COLORS[rawCat] || EVENT_COLORS.other;

  const currentLang = typeof XyzoI18n !== 'undefined' ? XyzoI18n.getLang() : 'en';
  const targetUrl = getTranslatedArticleUrl(p.canonical_url);
  const viewText = currentLang !== 'en' ? `🌐 View (${currentLang.toUpperCase()})` : 'view';

  const flag = countryFlagEmoji(p.source_country || p.location?.country || "");
  const countryName = p.source_country || p.location?.country || "";
  const placeText = p.place_name || p.location?.place_name || "";
  const placeBadge = placeText ? `<span class="popup-city-badge">${flag} ${escapeHtml(placeText)}</span>` : (countryName ? `<span class="popup-city-badge">${flag} ${escapeHtml(countryName)}</span>` : "");

  const highlightTop = typeof shouldHighlightTopStories === "function" && shouldHighlightTopStories();
  const isTop = highlightTop && typeof isTopStoryPin === "function" && isTopStoryPin(p);
  const sc = Number(p.source_count ?? p.sc ?? 1);
  const topStoryBadge = isTop
    ? `<span class="popup-top-story-badge" style="background:#ef444425;color:#ef4444;border:1px solid #ef444466;font-weight:700;">🔴 Top Global Story${sc > 1 ? ` · ${sc} sources` : ''}</span>`
    : "";
  const badge = `<span class="badge ${p.source_type}">${p.source_type}</span>`;
  const methodTag = (p.auto_categorize_method === 'nn_word_freq') ? ' · 🧠 NN' : (p.auto_categorize_method === 'ai_study') ? ' · 🤖 AI' : (p.auto_categorize_method === 'client_apply') ? ' · 👤 Human' : '';
  const catBadge = `<button type="button" class="popup-cat-badge popup-cat-btn" data-id="${p.id}" title="Click to fix or change category" style="background:${catColor}25;color:${catColor};border:1px solid ${catColor}55;cursor:pointer;">${escapeHtml(displayCat)}${methodTag} ▾</button>${topStoryBadge}`;
  const time = formatRelativeTime(p.published_at);
  // FIX_NOTES 3.1: href was RAW and onclick escaped only single quotes —
  // a feed URL containing a double-quote injected attributes into every
  // viewer's popup (stored XSS via malicious RSS).
  const link = p.canonical_url
    ? `<a href="${escapeAttr(safeHttpUrl(targetUrl))}" target="_blank" rel="noopener noreferrer" title="Open article translated to ${escapeAttr(String(currentLang).toUpperCase())}" onclick="if(typeof XyzoAnalytics!=='undefined')XyzoAnalytics.trackSourceClick({id:${Number(p.id)||0},source_id:${Number(p.source_id)||'null'}}, ${escapeAttr(JSON.stringify(String(p.canonical_url||''))).replace(/"/g,'&quot;')})" class="popup-action-btn popup-view-btn">${viewText}</a>`
    : "";
  const readMore = (p.source_type === "editorial" || p.source_type === "community")
    ? `<button class="popup-action-btn popup-read-btn" data-id="${p.id}">Read more</button>`
    : "";
  const wrong = `<button class="popup-action-btn popup-fix-btn" data-id="${p.id}" title="Fix category or location">🚩 Fix</button>`;
  const report = `<button class="popup-action-btn popup-report-btn" data-id="${p.id}">⚠️ Report</button>`;
  // Combined report/fix dialog (public_html/feedback-dialog.js). A
  // SECOND way in, not a replacement for Fix/Report: the popup gained
  // category-fixing and Ask AI after that dialog was written, and
  // folding them together would drop working features. The dialog
  // carries the full eight-option report vocabulary that the quick-flag
  // path behind ⚠️ Report does not.
  const feedback = `<button class="popup-action-btn popup-feedback-btn" data-id="${p.id}" title="Report an issue or fix this location">💬 Feedback</button>`;
  const askAi = `<button class="popup-action-btn popup-ai-btn" data-id="${p.id}" title="Ask AI about this story">🤖 Ask AI</button>`;

  // Heart/star reactions — stored in localStorage, POSTed to analytics
  const _favKey = `xyzo_fav_${p.id}`;
  let _favState = null;
  try { _favState = JSON.parse(localStorage.getItem(_favKey)); } catch (_) {}
  const loveActive = _favState?.love;
  const starActive = _favState?.star;
  const loveBtn = `<button class="popup-action-btn popup-react-btn${loveActive ? ' active' : ''}" data-pin="${p.id}" data-react="love" title="Love this source" style="${loveActive ? 'background:rgba(239,68,68,0.2);border-color:rgba(239,68,68,0.5);color:#ef4444;' : ''}">❤️</button>`;
  const starBtn = `<button class="popup-action-btn popup-react-btn${starActive ? ' active' : ''}" data-pin="${p.id}" data-react="star" title="Good info" style="${starActive ? 'background:rgba(250,204,21,0.2);border-color:rgba(250,204,21,0.5);color:#facc15;' : ''}">⭐</button>`;

  // Community recommendation — one vote per IP, POST /api/news/:id/recommend.
  // localStorage mirrors the server-side dedup so the button renders in its
  // "already recommended" state without an extra round-trip.
  const _recKey = `xyzo_rec_${p.id}`;
  let _recDone = false;
  try { _recDone = localStorage.getItem(_recKey) === "1"; } catch (_) {}
  const recommendBtn = `<button class="popup-action-btn popup-recommend-btn${_recDone ? ' active' : ''}" data-id="${p.id}" title="${_recDone ? 'Recommended — thanks!' : 'Recommend this story'}" style="${_recDone ? 'background:rgba(52,211,153,0.2);border-color:rgba(52,211,153,0.5);color:#34d399;' : ''}">👍</button>`;

  const urlDisplay = p.canonical_url ? (() => {
    try {
      const url = new URL(p.canonical_url);
      const domain = url.hostname.replace('www.', '');
      return `<div class="popup-source-url"><a href="${targetUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(domain)}</a></div>`;
    } catch {
      return `<div class="popup-source-url"><a href="${targetUrl}" target="_blank" rel="noopener noreferrer">source ↗</a></div>`;
    }
  })() : '';

  const imgTarget = targetUrl || p.canonical_url || "#";
  const imgW = p.image_width || p.iw;
  const imgH = p.image_height || p.ih;
  const imgWidthAttr = imgW ? ` width="${imgW}"` : '';
  const imgHeightAttr = imgH ? ` height="${imgH}"` : '';
  const imgAspectStyle = (imgW && imgH) ? ` style="aspect-ratio:${imgW}/${imgH};"` : '';
  const imgSrc = _imgProxy(p.image_url);
  const img = imgSrc
    ? `<a href="${escapeAttr(safeHttpUrl(imgTarget))}" target="_blank" rel="noopener noreferrer" class="popup-hero-link" title="View on source site" onclick="if(typeof XyzoAnalytics!=='undefined')XyzoAnalytics.trackSourceClick({id:${Number(p.id)||0},source_id:${Number(p.source_id)||'null'}}, ${escapeAttr(JSON.stringify(String(p.canonical_url||''))).replace(/"/g,'&quot;')})">
        <div class="popup-hero-wrap">
          <img src="${escapeAttr(imgSrc)}" alt="${escapeAttr(p.title)}"${imgWidthAttr}${imgHeightAttr}${imgAspectStyle} loading="lazy" referrerpolicy="no-referrer" data-source-id="${p.source_id || ''}" onload="imgOnLoad(this)" onerror="imgOnError(this)" onload="if(this.naturalWidth&&this.naturalHeight&&typeof recordImageDimensions==='function')recordImageDimensions('${escapeAttr(p.image_url)}',this.naturalWidth,this.naturalHeight)">
          <div class="popup-hero-overlay">source ↗</div>
        </div>
       </a>`
    : '';

  const confidencePct = p.confidence_score != null ? Math.round(p.confidence_score * 100) : null;
  const confidenceHtml = confidencePct !== null
    ? `<div class="popup-confidence" title="Location confidence">
        <div class="popup-confidence-bar"><div class="popup-confidence-fill" style="width:${confidencePct}%"></div></div>
        <span>${confidencePct}% confident</span>
       </div>`
    : '';

  // Check if mobile
  const isMobile = window.innerWidth <= 768;
  
  if (isMobile) {
    // Simplified mobile popup
    return `
      ${img}
      <div class="popup-header">
        <button class="popup-close-btn-mobile" aria-label="Close popup">✕ Close</button>
        <h3 class="popup-title" style="font-size:14px;">${p.canonical_url ? `<a href="${escapeAttr(targetUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.title)}</a>` : escapeHtml(p.title)}</h3>
        <div class="popup-meta-row" style="font-size:10px;">
          ${placeBadge}
          <span class="popup-time">${time}</span>
        </div>
        <div class="popup-meta-row popup-point-row" style="font-size:10px;">${pointCoordsLine(p)}${pointActionButtons(p)}</div>
      </div>
      <div class="popup-actions-row" style="gap:4px;">
        ${link}
        ${loveBtn} ${starBtn} ${recommendBtn}
        <button class="popup-action-btn popup-details-btn" data-id="${p.id}" style="background:rgba(94,234,212,0.15);border:1px solid rgba(94,234,212,0.4);color:var(--accent,#5eea2d);">Details ▸</button>
      </div>
      <div class="popup-details-content" style="display:none;">
        <div class="popup-meta-row">
          ${badge}${catBadge}
        </div>
        ${urlDisplay}
        ${confidenceHtml}
        <div class="popup-actions-row">
          ${readMore} ${askAi} ${wrong} ${report} ${feedback}
        </div>
        <div class="popup-section">
          <div class="popup-section-label">📰 Keywords</div>
          <div class="popup-words-container" data-pin-id="${p.id}"></div>
        </div>
        <div class="popup-section">
          <div class="popup-section-label">🔗 Related Stories</div>
          <div class="popup-links-container" data-pin-id="${p.id}"></div>
        </div>
        <div class="popup-section">
          <div class="popup-section-label">🏙️ Locations</div>
          <div class="popup-cities" data-pin-title="${escapeAttr(p.title || '')}"></div>
        </div>
        <div class="popup-reports-container" data-pin-id="${p.id}"></div>
      </div>
    `;
  }

  return `
    ${img}
    <div class="popup-header">
      <button class="popup-close-btn" aria-label="Close popup">✕</button>
      <h3 class="popup-title">${p.canonical_url ? `<a href="${escapeAttr(targetUrl)}" target="_blank" rel="noopener noreferrer" title="Open article" onclick="if(typeof XyzoAnalytics!=='undefined')XyzoAnalytics.trackSourceClick({id:${p.id},source_id:${p.source_id||'null'}},'${(p.canonical_url||'').replace(/'/g,"\\'")}')">${escapeHtml(p.title)}</a>` : escapeHtml(p.title)}</h3>
      <div class="popup-meta-row">
        ${badge}${catBadge}
      </div>
      <div class="popup-location-row">
        ${placeBadge}
        ${confidenceHtml}
        <span class="popup-time">${time}</span>
      </div>
      <div class="popup-location-row popup-point-row">
        ${pointCoordsLine(p)}
        ${pointActionButtons(p)}
      </div>
    </div>
    <div class="popup-actions-row">
      ${link} ${loveBtn} ${starBtn} ${recommendBtn} ${readMore} ${askAi} ${wrong} ${report} ${feedback}
    </div>
    ${urlDisplay}
    <div class="popup-details-content">
      <div class="popup-section">
        <div class="popup-section-label">📰 Keywords</div>
        <div class="popup-words-container" data-pin-id="${p.id}"></div>
      </div>
      <div class="popup-section">
        <div class="popup-section-label">🔗 Related Stories</div>
        <div class="popup-links-container" data-pin-id="${p.id}"></div>
      </div>
      <div class="popup-section">
        <div class="popup-section-label">🏙️ Locations</div>
        <div class="popup-cities" data-pin-title="${escapeAttr(p.title || '')}"></div>
      </div>
      <div class="popup-reports-container" data-pin-id="${p.id}"></div>
    </div>
  `;
}

// ── Pin popup: render detected cities ───────────────────────────────
//
// Uses CityEngine.cityStats() to detect city mentions in the pin
// title + summary + (loaded) body. Each detected city becomes a
// ── Pin popup: render quality reports ───────────────────────────────
// Fetches quality reports for the pin and shows flags if any exist.
async function renderPinReports(popupEl, pin) {
  const container = popupEl.querySelector(".popup-reports-container");
  if (!container) return;

  try {
    const res = await fetch(`/api/analytics/reports/${pin.id}`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.total_reports === 0) return;

    const reportLabels = {
      paywall: '🔒 Paywall',
      login_required: '🔑 Login required',
      false_info: '⚠️ False info',
      misleading: '⚠️ Misleading',
      spam: '🚫 Spam',
      low_quality: '📉 Low quality',
      offensive: '🚫 Offensive',
      duplicate: '📋 Duplicate',
      other: '❓ Other',
    };

    const reportColors = {
      paywall: '#f59e0b',
      login_required: '#f59e0b',
      false_info: '#ef4444',
      misleading: '#ef4444',
      spam: '#ef4444',
      low_quality: '#94a3b8',
      offensive: '#ef4444',
      duplicate: '#94a3b8',
      other: '#94a3b8',
    };

    // Build report badges
    const badges = [];
    const counts = data.counts || {};
    for (const [type, count] of Object.entries(counts)) {
      if (count > 0 && reportLabels[type]) {
        const color = reportColors[type] || '#94a3b8';
        badges.push(`<span style="display:inline-block;padding:1px 6px;margin:1px;font-size:10px;background:${color}22;color:${color};border-radius:3px;border:1px solid ${color}44;">${reportLabels[type]} (${count})</span>`);
      }
    }

    // Quality score indicator
    let qualityHtml = '';
    if (data.quality_score != null) {
      const score = data.quality_score;
      const scoreColor = score >= 0.7 ? '#22c55e' : score >= 0.4 ? '#f59e0b' : '#ef4444';
      qualityHtml = `<span style="font-size:10px;color:${scoreColor};margin-left:4px;">Quality: ${Math.round(score * 100)}%</span>`;
    }

    // Hidden warning
    let hiddenHtml = '';
    if (data.hidden) {
      hiddenHtml = `<div style="font-size:10px;color:#ef4444;margin-top:4px;">⚠️ ${escapeHtml(data.hidden_reason || 'Hidden due to reports')}</div>`;
    }

    container.innerHTML = `
      <div style="margin-top:4px;padding:4px 6px;background:rgba(239,68,68,0.05);border:1px solid rgba(239,68,68,0.15);border-radius:4px;">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:2px;">
          ${badges.join('')}
          ${qualityHtml}
        </div>
        ${hiddenHtml}
        <div style="font-size:9px;color:var(--muted);margin-top:2px;">${data.total_reports} report${data.total_reports !== 1 ? 's' : ''}</div>
      </div>
    `;
  } catch (e) {
    // Silent fail
  }
}

// ── Pin popup: render top words ─────────────────────────────────────
//
// Fetches word frequency for the pin and renders top words as clickable chips.
// Clicking a keyword searches for other stories with that keyword.
async function renderPinWords(popupEl, pin) {
  const container = popupEl.querySelector(".popup-words-container");
  if (!container) return;

  try {
    const res = await fetch(`/api/pins/${pin.id}/words`);
    if (!res.ok) return;
    const data = await res.json();
    const words = data.words || {};
    const entries = Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 16);

    if (entries.length === 0) {
      container.innerHTML = `<div class="popup-empty">No keywords extracted</div>`;
      return;
    }

    const maxCount = entries[0][1];
    const chips = entries.map(([word, count]) => {
      const intensity = Math.max(0.5, count / maxCount);
      const colors = [
        { bg: 'rgba(94,234,212,', text: '#5eead4' },    // teal
        { bg: 'rgba(168,85,247,', text: '#a855f7' },    // purple
        { bg: 'rgba(59,130,246,', text: '#3b82f6' },    // blue
        { bg: 'rgba(249,115,22,', text: '#f97316' },    // orange
        { bg: 'rgba(236,72,153,', text: '#ec4899' },    // pink
      ];
      const c = colors[Math.floor(Math.random() * colors.length)];
      return `<button class="popup-keyword-chip" data-keyword="${escapeHtml(word)}" style="background:${c.bg}${intensity * 0.2});color:${c.text};border:1px solid ${c.bg}${intensity * 0.4});" title="Find stories with '${escapeHtml(word)}'">${escapeHtml(word)}</button>`;
    }).join("");

    container.innerHTML = `<div class="popup-keywords">${chips}</div>`;

    // Wire click-to-search on keywords. Always zoom out to the world map so
    // the user can see *all* the related keyword matches globally instead of
    // being yanked to whichever single location happens to be the "best".
    container.querySelectorAll('.popup-keyword-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const keyword = chip.dataset.keyword;
        if (keyword) {
          searchInput.value = keyword;
          runTextSearch({ zoom: "world" });
          closeActivePopup();
        }
      });
    });
  } catch (e) {
    container.innerHTML = `<div class="popup-empty">Keywords unavailable</div>`;
  }
}

// clickable chip that filters the map to that city.
//
// ── Pin popup: render story links ───────────────────────────────────
// Fetches links for the pin and renders them as visual cards.
// Links are detected by city, country, entity, topic, and event matching.
// ── Story tree ──────────────────────────────────────────────────────
// Renders the ranked relationship tree for a pin.
//
// The map renders EVENTS (a pin is a cluster of articles), so the tree is
// built at event level: the root's own siblings ("same story, other
// outlets") first, then related stories bucketed most → least related.
//
// The old /api/links/:id endpoint answered "what is linked to THIS
// ARTICLE" — one article of a cluster that can hold 3,000 — so it returned
// nothing for most pins. This endpoint answers for the whole story.
const TREE_BUCKET_META = {
  strong: { icon: "★", label: "Most related", color: "#5eead4" },
  medium: { icon: "◐", label: "Related", color: "#60a5fa" },
  weak: { icon: "○", label: "Long tail", color: "#94a3b8" },
};

function treeKindBadges(kinds) {
  const map = {
    same_event: ["⚡", "#22c55e"],
    semantic_similarity: ["🧠", "#c026d3"],
    same_entity: ["👤", "#e879f9"],
    same_topic: ["📊", "#60a5fa"],
    same_city: ["🏙️", "#f59e0b"],
    same_country: ["🌍", "#fbbf24"],
    ai_detected: ["🤖", "#a78bfa"],
    manual: ["🔗", "#f97316"],
  };
  return (kinds || [])
    .filter((k) => map[k])
    .map((k) => {
      const [icon, color] = map[k];
      return `<span class="popup-tree-badge" style="color:${color}">${icon}</span>`;
    })
    .join("");
}

async function renderPinTree(popupEl, pin) {
  const container = popupEl.querySelector(".popup-links-container");
  if (!container) return;

  container.innerHTML =
    `<div class="popup-tree-loading"><span class="explore-spinner"></span> Mapping connections…</div>`;

  try {
    const res = await fetch(`/api/pins/${pin.id}/tree`);
    if (!res.ok) throw new Error("http " + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const root = data.root || {};
    const meta = data.meta || {};
    const sibs = data.siblings || { count: 0, items: [] };
    const buckets = data.buckets || [];

    const parts = [];

    // ── Siblings: the same story carried by other outlets ────────────
    if (sibs.items && sibs.items.length) {
      const shown = sibs.items.slice(0, 6);
      const rest = sibs.items.slice(6);
      parts.push(`
        <div class="popup-tree-branch">
          <div class="popup-tree-head"><span class="popup-tree-dot" style="background:#22c55e"></span>
            Same story · ${sibs.count} other outlet${sibs.count === 1 ? "" : "s"}</div>
          <div class="popup-tree-sibs">
            ${shown
              .map((s) => {
                const url = safeHttpUrl(s.url || "");
                const title = escapeHtml((s.headline || "").slice(0, 62));
                return `<div class="popup-tree-sib" data-lat="${s.lat ?? ""}" data-lng="${s.lng ?? ""}">
                  <span class="popup-tree-src">${escapeHtml(s.source_name || "source")}</span>
                  ${url
                    ? `<a class="popup-tree-sib-title popup-tree-link" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" title="Open the article at ${escapeAttr(s.source_name || "the source")}">${title}</a>`
                    : `<span class="popup-tree-sib-title">${title}</span>`}
                  <button type="button" class="popup-tree-locate" data-lat="${s.lat ?? ""}" data-lng="${s.lng ?? ""}" title="Show it on the map">◎</button>
                </div>`;
              })
              .join("")}
            ${rest.length ? `<div class="popup-tree-rest">+${rest.length} more outlets</div>` : ""}
          </div>
        </div>`);
    }

    // ── Related buckets: most → least ────────────────────────────────
    for (const b of buckets) {
      const conf = TREE_BUCKET_META[b.key] || TREE_BUCKET_META.weak;
      if (!b.children || !b.children.length) continue;
      // The weak bucket is COLLAPSED, not empty — the items are rendered
      // and the container is hidden, so "Show N weak connections" has
      // something to show.
      const collapsed = b.key === "weak";
      const items = b.children;
      parts.push(`
        <div class="popup-tree-branch">
          <div class="popup-tree-head"><span class="popup-tree-dot" style="background:${conf.color}"></span>
            ${conf.icon} ${escapeHtml(conf.label)} <span class="popup-tree-count">${b.children.length}</span></div>
          <div class="popup-tree-items"${collapsed ? " hidden" : ""}>
            ${items
              .map((c) => {
                const url = safeHttpUrl(c.url || "");
                const title = escapeHtml((c.headline || "").slice(0, 82));
                return `<div class="popup-tree-item" data-lat="${c.lat ?? ""}" data-lng="${c.lng ?? ""}"
                             data-event-id="${c.event_id}">
                  <div class="popup-tree-title">${url
                    ? `<a class="popup-tree-link" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" title="Open the article at the source">${title}</a>`
                    : title}${c.has_children ? `<button type="button" class="popup-tree-expand" data-event-id="${c.event_id}" title="Show what this story connects to">▸</button>` : ""}</div>
                  <button type="button" class="popup-tree-locate" data-lat="${c.lat ?? ""}" data-lng="${c.lng ?? ""}" title="Show it on the map">◎</button>
                  <div class="popup-tree-meta">
                    ${c.place ? `<span>${escapeHtml(c.place)}</span>` : ""}
                    ${c.source_name ? `<span>${escapeHtml(c.source_name)}</span>` : ""}
                    ${treeKindBadges(c.kinds)}
                    ${c.semantic_cos != null ? `<span class="popup-tree-score" title="semantic similarity">cos ${c.semantic_cos.toFixed(2)}</span>` : ""}
                    ${c.n_articles > 1 ? `<span title="articles in this story">×${c.n_articles}</span>` : ""}
                  </div>
                  <div class="popup-tree-children" data-children-of="${c.event_id}" hidden></div>
                </div>`;
              })
              .join("")}
            ${collapsed ? "" : ""}
          </div>
          ${collapsed ? `<button type="button" class="popup-tree-more">Show ${b.children.length} weak connections ▾</button>` : ""}
        </div>`);
    }

    if (!parts.length) {
      parts.push(
        `<div class="popup-links-empty"><span>No connected stories found</span></div>`,
      );
    }

    const foot = [];
    if (meta.elapsed_ms != null) {
      foot.push(`<span class="popup-tree-timing">${meta.elapsed_ms}ms</span>`);
    }
    if (root.is_mega_cluster) {
      foot.push(
        `<span class="popup-tree-warn" title="This cluster holds ${root.members} articles whose locations were re-assigned after clustering — treat its links loosely.">⚠ broad cluster</span>`,
      );
    }
    if (!meta.semantic_available) {
      foot.push(
        `<span class="popup-tree-warn" title="Semantic embeddings are not backfilled for this story yet, so only graph links are shown.">⚠ no semantic index</span>`,
      );
    }
    if (meta.timed_out) {
      foot.push(
        `<span class="popup-tree-warn" title="The connection search hit its 6s budget on a cold cache. Try again in a moment.">⚠ timed out — partial</span>`,
      );
    }

    // The add-link flow posts to /api/links/manual, which resolves
    // event_a → the anchor article — so it needs an EVENT id, not the
    // article id the popup carries.
    const canLink = !!pin.event_id;
    container.innerHTML = parts.join("") +
      (foot.length ? `<div class="popup-tree-foot">${foot.join("")}</div>` : "") +
      (canLink
        ? `<button type="button" class="popup-add-link-btn" data-pin-id="${pin.id}">+ Add link</button>`
        : "");

    // Expand / collapse the weak tail.
    container.querySelectorAll(".popup-tree-more").forEach((btn) => {
      btn.addEventListener("click", () => {
        const branch = btn.closest(".popup-tree-branch");
        const items = branch?.querySelector(".popup-tree-items");
        if (!items) return;
        const hidden = items.hasAttribute("hidden");
        if (hidden) {
          items.removeAttribute("hidden");
          btn.textContent = "Hide weak connections ▴";
        } else {
          items.setAttribute("hidden", "");
          btn.textContent = `Show ${items.children.length} weak connections ▾`;
        }
      });
    });

    // Expand a child story → fetch ITS connections (depth-2 tree).
    // The fetch is cached per event so re-toggling is instant.
    const _treeCache = window.__xyzoTreeCache || (window.__xyzoTreeCache = new Map());
    container.querySelectorAll(".popup-tree-expand").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const eid = btn.dataset.eventId;
        const holder = container.querySelector(`[data-children-of="${eid}"]`);
        if (!holder) return;
        const isOpen = !holder.hidden;
        if (isOpen) { holder.hidden = true; holder.innerHTML = ""; btn.textContent = "▸"; return; }
        btn.textContent = "…";
        const render = (data) => {
          const kids = (data.buckets || []).flatMap((b) => b.children || []);
          if (!kids.length) { holder.innerHTML = `<div class="popup-tree-empty">No further connections</div>`; }
          else {
            holder.innerHTML = kids.slice(0, 8).map((k) =>
              `<div class="popup-tree-sub" data-lat="${k.lat ?? ""}" data-lng="${k.lng ?? ""}">
                 <div class="popup-tree-title">${escapeHtml((k.headline || "").slice(0, 70))}</div>
                 <div class="popup-tree-meta">
                   ${k.place ? `<span>${escapeHtml(k.place)}</span>` : ""}
                   ${k.semantic_cos != null ? `<span class="popup-tree-score">cos ${k.semantic_cos.toFixed(2)}</span>` : ""}
                 </div>
               </div>`).join("") +
            (kids.length > 8 ? `<div class="popup-tree-rest">+${kids.length - 8} more</div>` : "");
          }
          holder.hidden = false;
          btn.textContent = "▾";
          holder.querySelectorAll(".popup-tree-sub").forEach((sub) => {
            sub.addEventListener("click", () => {
              const lat = Number(sub.dataset.lat);
              const lng = Number(sub.dataset.lng);
              if (Number.isFinite(lat) && Number.isFinite(lng)) map.flyTo([lat, lng], Math.max(map.getZoom(), 6), { duration: 0.6 });
            });
          });
        };
        if (_treeCache.has(eid)) { render(_treeCache.get(eid)); return; }
        fetch(`/api/events/${eid}/tree`).then((r) => r.ok ? r.json() : null).then((data) => {
          if (!data || data.error) { holder.innerHTML = `<div class="popup-tree-empty">Unavailable</div>`; holder.hidden = false; btn.textContent = "▾"; return; }
          _treeCache.set(eid, data);
          render(data);
        }).catch(() => {
          holder.innerHTML = `<div class="popup-tree-empty">Unavailable</div>`;
          holder.hidden = false;
          btn.textContent = "▾";
        });
      });
    });

    // CLICK A NODE → GO TO THE ARTICLE. The related stories are the
    // POINT of the tree: a reader who opens one wants the story, not a
    // camera move. The headline is a link to the publisher's own page
    // (the tree API carries the URL), and the ◎ button beside it is the
    // map move — so neither action is lost.
    container.querySelectorAll(".popup-tree-item, .popup-tree-sib").forEach((node) => {
      node.addEventListener("click", (ev) => {
        // Don't fly when the click came from the expand button, from
        // the link (the browser is already going to the article), or
        // from the locate button (which does its own move).
        if (ev.target && ev.target.closest && ev.target.closest(".popup-tree-expand")) return;
        if (ev.target && ev.target.closest && ev.target.closest(".popup-tree-locate")) return;
        if (ev.target && ev.target.closest && ev.target.closest("a")) return;
        const lat = Number(node.dataset.lat);
        const lng = Number(node.dataset.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          map.flyTo([lat, lng], Math.max(map.getZoom(), 6), { duration: 0.6 });
        }
      });
    });

    // The ◎ button: show it on the map.
    container.querySelectorAll(".popup-tree-locate").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const lat = Number(btn.getAttribute("data-lat"));
        const lng = Number(btn.getAttribute("data-lng"));
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          map.flyTo([lat, lng], Math.max(map.getZoom(), 6), { duration: 0.6 });
        }
      });
    });

    container.querySelector(".popup-add-link-btn")?.addEventListener("click", () => {
      if (pin.event_id) startAddLink(pin.event_id);
    });
  } catch (e) {
    XLog.warn("renderPinTree failed", e);
    container.innerHTML = `<div class="popup-empty">Unable to load connections</div>`;
  }
}

// Latency: CityEngine is loaded once on page load (data is small);
// findCitiesInText runs in <1ms for typical article bodies.
async function renderPinCities(popupEl, pin) {
  const container = popupEl.querySelector(".popup-cities");
  if (!container || !window.CityEngine) return;

  // Wait for CityEngine if still loading.
  if (!window.CityEngine.isLoaded()) {
    await window.CityEngine.load();
  }

  let body = "";
  if (pin.source_type === "editorial") {
    try {
      const res = await fetch(`/api/pins/${pin.id}`);
      if (res.ok) {
        const data = await res.json();
        body = (data.detail && data.detail.body_markdown) || "";
        // Strip markdown links etc — keep text only.
        body = body.replace(/[`*_#>]/g, " ");
      }
    } catch { /* ignore */ }
  }

  const text = `${pin.title || ""} ${pin.summary || ""} ${body}`.trim();
  if (!text) return;

  const s = window.CityEngine.cityStats(text, { minPopulation: 150000 });
  if (s.count === 0) return;

  // Render chips. Primary first, others after.
  const seen = new Set();
  const ordered = [];
  if (s.primary) {
    seen.add(s.primary.id);
    ordered.push(s.primary);
  }
  for (const c of s.cities) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      ordered.push(c);
    }
  }

  const flag = (cc) => cc && cc.length === 2
    ? String.fromCodePoint(...[...cc.toUpperCase()].map(ch => 127397 + ch.charCodeAt(0)))
    : "";

  container.innerHTML =
    '<div class="popup-cities-label">Mentioned cities</div>' +
    '<div class="popup-cities-chips">' +
    ordered.slice(0, 8).map(c =>
      `<span class="city-chip" data-lat="${c.la}" data-lng="${c.ln}" `
      + `data-cc="${c.cc}" data-name="${escapeAttr(c.n)}" `
      + `title="${c.n}, ${c.cc} · pop ${formatPop(c.p)}">`
      + `<span class="city-chip-flag">${flag(c.cc)}</span>${escapeHtml(c.n)}`
      + `</span>`
    ).join('') +
    (s.is_national ? '<span class="city-chip nation">national coverage</span>' : '') +
    '</div>';

  // Click → fly map to that city + filter.
  container.querySelectorAll(".city-chip[data-lat]").forEach(chip => {
    chip.addEventListener("click", () => {
      const lat = Number(chip.getAttribute("data-lat"));
      const lng = Number(chip.getAttribute("data-lng"));
      if (Number.isFinite(lat) && Number.isFinite(lng) && typeof map !== "undefined") {
        map.flyTo([lat, lng], 6, { duration: 0.8 });
      }
    });
  });
}

function formatPop(p) {
  if (!p) return "—";
  if (p >= 1_000_000) return (p / 1_000_000).toFixed(1) + "M";
  if (p >= 1_000) return (p / 1_000).toFixed(0) + "k";
  return String(p);
}

function safeHttpUrl(u) {
  // Allowlist http(s) only — kills javascript:, data:, and any surprise
  // scheme that slipped into feed/pin URL fields (FIX_NOTES 3.1/3.6).
  try {
    const url = new URL(u, location.href);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch (_) {}
  return "";
}

function escapeAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;").replace(/</g, "&lt;");
}

// ── Image proxy helper ────────────────────────────────────────────────
// Route remote images through our server-side proxy to avoid CORS/CORP
// errors from external servers. Returns proxied URL for remote images,
// or "" for data-URIs/relative/known-bad hosts (skip the image entirely).
function _imgProxy(url) {
  if (!url) return "";
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;
  try {
    const u = new URL(url, location.href);
    if (u.origin === location.origin) return url;
    // Skip known-bad hosts — don't waste a proxy round-trip on dead images
    const host = u.hostname.replace(/^www\./, "");
    if (_knownBadImageHosts.has(host) || _imgBlockedSources.has(host)) return "";
    return "/api/image-proxy?url=" + encodeURIComponent(u.href);
  } catch { return ""; }
}

// ── Image fallback: on CORP/referrer failure, retry via proxy ─────────
// Called from onerror on <img> tags. First failure swaps src to our
// proxy endpoint (which streams the image without CORP restrictions).
// Second failure hides the element entirely and blocks the source/host.
const _imgBlockedSources = new Set(
  (JSON.parse(sessionStorage.getItem("xyzo_img_blocked") || "[]"))
    .map((h) => String(h).replace(/^www\./, "")) // normalize: strip www from stored hostnames
);

// Pre-populated static blocklist of known image-hostile domains (CORS/CORP
// blocks, auth-token URLs, or servers that consistently fail). These are
// blocked from the FIRST visit — no CORS noise in the console.
const _knownBadImageHosts = new Set([
  "vijesti.me",
  "media.mehrnews.com",
  "bucket.index.hr",
  "infobae.com",
  "media.hamshahrionline.ir",
  "img.zeit.de",
  "vecernji.hr",
  "cdn.isna.ir",
  "files.tecnoblog.net",
  "cdn.punchng.com",
  "adngad.net",
  "cdn.ilna.ir",
  "zamanalwsl.net",
  "www.zamanalwsl.net",
  "images.thewest.com.au",
  "rainews.it",
]);

function _saveImgBlocklist() {
  try {
    sessionStorage.setItem("xyzo_img_blocked", JSON.stringify([..._imgBlockedSources]));
  } catch (_) {}
}

function _blockSourceImg(sourceId, imgEl) {
  // Only block by hostname — never by source_id. Sources remain fully usable
  // on Xyzo; only their images from a given host are affected.
  if (!imgEl) return;
  const src = imgEl.getAttribute("src") || "";
  let host = "";
  try {
    const u = new URL(src, location.href);
    // If this is a proxied URL, extract the ORIGINAL host from the query param
    if (u.pathname === "/api/image-proxy") {
      const target = u.searchParams.get("url");
      if (target) host = new URL(target).hostname.replace(/^www\./, "");
    } else {
      host = u.hostname.replace(/^www\./, "");
    }
    // Never block our own origin
    if (host === location.hostname) return;
    if (host && !_imgBlockedSources.has(host)) {
      _imgBlockedSources.add(host);
      _saveImgBlocklist();
    }
  } catch (_) {}
}

function _isSourceImgBlocked(sourceId) {
  if (!sourceId) return false;
  const sid = Number(sourceId);
  return _imgBlockedSources.has(sid);
}

function _isHostBlocked(src) {
  if (!src) return false;
  try {
    const host = new URL(src, location.href).hostname.replace(/^www\./, "");
    // Check against known-bad (non-www) and session blocklist (also non-www)
    return _knownBadImageHosts.has(host) || _imgBlockedSources.has(host);
  } catch (_) {
    return false;
  }
}

// A PLACEHOLDER image loaded. The image proxy answers a dead picture
// with HTTP 200 and a 1x1 transparent PNG rather than an error status,
// because an <img> that 404s is a console error the reader cannot
// silence and cannot act on (the picture is gone AT THE PUBLISHER).
//
// The placeholder is 1x1, so its natural size gives it away: hide it,
// exactly as the error path did, and the layout is unchanged.
function imgOnLoad(imgEl) {
  try {
    if (imgEl.naturalWidth > 1 || imgEl.naturalHeight > 1) return;
  } catch (_) { return; }
  const wrap = imgEl.closest(".popup-hero-wrap");
  if (wrap) {
    const link = wrap.closest("a.popup-hero-link");
    if (link) link.style.display = "none";
    else wrap.style.display = "none";
  } else {
    imgEl.style.display = "none";
  }
}

function imgOnError(imgEl) {
  const sourceId = imgEl.dataset.sourceId;

  // Image failed to load (the proxy could not reach the publisher, or
  // the URL was malformed).
  //
  // The ORIGIN host (not the proxy host) is blocked, to prevent retries
  // this session. A DEAD PICTURE no longer reaches here at all: the
  // proxy answers it with a placeholder, so the host is NOT blocked for
  // it — a publisher who fixes the picture gets it back.
  _blockSourceImg(sourceId, imgEl);
  const wrap = imgEl.closest(".popup-hero-wrap");
  if (wrap) {
    const link = wrap.closest("a.popup-hero-link");
    if (link) link.style.display = "none";
    else wrap.style.display = "none";
  } else {
    imgEl.style.display = "none";
  }
}


// ── Pin popup: small "auto-tagged" badge ─────────────────────────────
//
// Renders a tiny badge above the city chips showing that the fast-path
// worker has already classified this article. Pure visual — nothing to
// click. Shows city + category + confidence in compact form so users
// trust the pin without having to read the source.
function renderApplyBadge(popupEl, info) {
  let container = popupEl.querySelector(".popup-autobadge");
  if (!container) {
    container = document.createElement("div");
    container.className = "popup-autobadge";
    const citiesEl = popupEl.querySelector(".popup-cities");
    if (citiesEl && citiesEl.parentNode) {
      citiesEl.insertAdjacentElement("beforebegin", container);
    } else {
      popupEl.querySelector(".popup-actions")?.insertAdjacentElement("afterend", container);
    }
  }
  const parts = [];
  if (info.city_label) parts.push(`<span class="popup-autobadge-place">${escapeHtml(info.city_label)}</span>`);
  if (info.event_type) parts.push(`<span class="popup-autobadge-cat">${escapeHtml(info.event_type)}</span>`);
  if (info.confidence) parts.push(`<span class="popup-autobadge-conf">${escapeHtml(info.confidence)}</span>`);
  container.innerHTML = `✨ auto-tagged · ${parts.join(" · ")}`;
}

// ── Pin popup: render client-side apply-suggestion block ────────────
//
// Reads the same CityEngine.categorize() the worker would have run
// and offers one-click Apply buttons when:
//   - A city was detected but the pin's lat/lng don't match it
//   - A category was detected but the pin's event_type is missing or
//     "other"
// User-applied suggestions mark the article auto_categorize_method =
// 'client_apply' so the audit trail is honest about who decided.
async function renderApplySuggestions(popupEl, pin) {
  if (!window.CityEngine || !pin || !pin.id) return;
  if (!window.CityEngine.isLoaded()) await window.CityEngine.load();

  // First ask the server how this article was categorized. The pin
  // object carries the *applied* values but not the audit trail
  // (auto_categorize_method), which we need to render an "auto-tagged"
  // badge so users trust the suggestion buttons below.
  let serverStatus = null;
  try {
    const r = await fetch(`/api/articles/${pin.id}/categorization-status`);
    if (r.ok) serverStatus = await r.json();
  } catch (_) { /* ignore — keep the local check */ }

  // Render the audit badge even when there's nothing to apply, so users
  // can see "this was tagged by the fast path" and trust the pin's
  // location/category as already-validated.
  if (serverStatus?.auto_categorize?.method === "fast_path") {
    renderApplyBadge(popupEl, serverStatus.auto_categorize);
  }

  // Skip the apply buttons if the article already has both a confirmed
  // location and a non-"other" event_type. Server fast-path decisions
  // fall through this check because they already populated the pin.
  const existingCategory = (pin.event_type || pin.category || "").toLowerCase();
  const hasLocation = pin.location && Number.isFinite(pin.location.lat);
  if (hasLocation && existingCategory && existingCategory !== "other") return;

  // Pull the full body for editorial pins. RSS pins only have summary.
  let body = "";
  if (pin.source_type === "editorial") {
    try {
      const res = await fetch(`/api/pins/${pin.id}`);
      if (res.ok) {
        const data = await res.json();
        body = (data.detail && data.detail.body_markdown) || "";
        body = body.replace(/[`*_#>]/g, " ");
      }
    } catch (_) { /* ignore */ }
  }
  const text = `${pin.title || ""}\n${pin.summary || ""}\n${body}`.trim();
  if (!text) return;

  const sug = window.CityEngine.categorize(pin.title || "", text);
  const suggestions = [];
  if (sug.city_label && (!hasLocation ||
      Math.abs((pin.location?.lat ?? 0) - sug.city.la) > 0.5 ||
      Math.abs((pin.location?.lng ?? 0) - sug.city.ln) > 0.5)) {
    suggestions.push({
      kind: "city",
      label: sug.city_label,
      apply: {
        city_label: sug.city_label,
        lat: sug.city.la,
        lng: sug.city.ln,
      },
    });
  }
  if (sug.category && sug.category !== "other" &&
      (!existingCategory || existingCategory === "other")) {
    suggestions.push({
      kind: "category",
      label: sug.category,
      apply: { event_type: sug.category },
    });
  }
  if (suggestions.length === 0) return;

  // Render under the city-chips block.
  let container = popupEl.querySelector(".popup-apply");
  if (!container) {
    container = document.createElement("div");
    container.className = "popup-apply";
    const citiesEl = popupEl.querySelector(".popup-cities");
    if (citiesEl && citiesEl.parentNode) {
      citiesEl.insertAdjacentElement("afterend", container);
    } else {
      popupEl.querySelector(".popup-actions")?.insertAdjacentElement("afterend", container);
    }
  }
  container.innerHTML = `
    <div class="popup-apply-label">Suggestions</div>
    <div class="popup-apply-list">
      ${suggestions.map((s, i) => `
        <button class="popup-apply-btn" data-kind="${s.kind}" data-idx="${i}"
                title="Apply: ${escapeAttr(s.label)}">
          ✨ ${escapeHtml(s.label)}
        </button>`).join("")}
      <button class="popup-apply-all" data-kind="all">Apply all</button>
    </div>
  `;
  // Wire click handlers — POST to the apply endpoint, then refresh the
  // popup in place so the user sees their action take effect.
  const articleId = pin.id;
  container.querySelectorAll(".popup-apply-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const kind = btn.getAttribute("data-kind");
      const idx = Number(btn.getAttribute("data-idx"));
      const s = suggestions[idx];
      btn.disabled = true;
      btn.textContent = "applying…";
      try {
        const r = await fetch(`/api/articles/${articleId}/apply-categorization`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(s.apply),
        });
        if (!r.ok) {
          btn.textContent = "failed";
          btn.disabled = false;
          return;
        }
        // Update the pin object in place so the rest of the UI sees
        // the new values without a refetch.
        if (s.apply.city_label) {
          pin.location = pin.location || {};
          pin.location.lat = s.apply.lat;
          pin.location.lng = s.apply.lng;
          pin.location.place_name = s.apply.city_label;
        }
        if (s.apply.event_type) {
          pin.event_type = s.apply.event_type;
          pin.category = s.apply.event_type;
        }
        btn.textContent = "✓ applied";
        // After the user applies, hide the suggestion block — further
        // re-applies would require a manual refresh.
        if (kind === "all") {
          container.remove();
        } else {
          btn.remove();
          if (!container.querySelector(".popup-apply-btn")) container.remove();
        }
        // Refresh the underlying marker icon so the new category color
        // shows up on the map without waiting for a refetch.
        const marker = pinMarkers.get(pin.id);
        if (marker) {
          const icon = iconFor({ category: pin.event_type, source_type: pin.source_type });
          marker.setIcon(L.divIcon({
            className: "xyzo-pin",
            html: buildMarkerDiv(icon, { size: MARKER_ICON_SIZE, title: pin.title }),
            iconSize: [MARKER_ICON_SIZE, MARKER_ICON_SIZE],
            iconAnchor: [MARKER_ICON_SIZE / 2, MARKER_ICON_SIZE / 2],
          }));
          if (marker.getPopup && marker.getPopup()) marker.getPopup().update();
        }
      } catch (e) {
        btn.textContent = "error";
        btn.disabled = false;
        XLog.warn("[apply-suggestions]", e);
      }
    });
  });
  container.querySelector(".popup-apply-all")?.addEventListener("click", async () => {
    // Compose a single body with all suggestions.
    const body = suggestions.reduce((acc, s) => Object.assign(acc, s.apply), {});
    const btn = container.querySelector(".popup-apply-all");
    btn.disabled = true;
    btn.textContent = "applying…";
    try {
      const r = await fetch(`/api/articles/${articleId}/apply-categorization`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) { btn.textContent = "failed"; btn.disabled = false; return; }
      btn.textContent = "✓ applied";
      container.remove();
      // Same pin refresh as the per-button handler.
      if (body.city_label) {
        pin.location = pin.location || {};
        pin.location.lat = body.lat;
        pin.location.lng = body.lng;
        pin.location.place_name = body.city_label;
      }
      if (body.event_type) {
        pin.event_type = body.event_type;
        pin.category = body.event_type;
      }
      const marker = pinMarkers.get(pin.id);
      if (marker) {
        const icon = iconFor({ category: pin.event_type, source_type: pin.source_type });
        marker.setIcon(L.divIcon({
          className: "xyzo-pin",
          html: buildMarkerDiv(icon, { size: MARKER_ICON_SIZE, title: pin.title }),
          iconSize: [MARKER_ICON_SIZE, MARKER_ICON_SIZE],
          iconAnchor: [MARKER_ICON_SIZE / 2, MARKER_ICON_SIZE / 2],
        }));
        if (marker.getPopup && marker.getPopup()) marker.getPopup().update();
      }
    } catch (e) {
      btn.textContent = "error";
      btn.disabled = false;
    }
  });
}

function wirePopupActions(popup, pin) {
  const el = popup.getElement();

  // ── Close button (works on both mobile and desktop) ───────────────
  attachPopupClose(el);

  // ── Details toggle (show/hide extra sections) ─────────────────────
  // ONE class name for the block, in the markup AND here. The mobile
  // branch used to emit `.popup-details-full` while this looked for
  // `.popup-details-content` — so on a phone the "Details ▸" button was
  // DEAD: the keywords, the related stories, the locations and the
  // reports were unreachable on the one layout that needs them.
  const detailsBtn = el.querySelector(".popup-details-btn");
  const detailsContent = el.querySelector(".popup-details-content");
  if (detailsBtn && detailsContent) {
    detailsBtn.addEventListener("click", () => {
      const isHidden = detailsContent.style.display === "none";
      detailsContent.style.display = isHidden ? "block" : "none";
      detailsBtn.textContent = isHidden ? "Details ▾" : "Details ▸";
      // The popup just changed size — re-frame it.
      setTimeout(keepPopupOnScreen, 0);
    });
  }

  // ── The point's own details: satellite view + copy coordinates ──────
  //
  // DELEGATED FROM THE POPUP ELEMENT, NOT BOUND TO THE BUTTON — the
  // same rule the close button follows (see attachPopupClose). Leaflet
  // rebuilds a popup's content whenever it is updated (`setContent`), and
  // this popup's content is a FUNCTION, so the buttons are replaced by
  // brand-new nodes: a listener bound to the button is thrown away with
  // the old one, and the button goes DEAD. Measured: the satellite
  // button did nothing at all, because the content had been rebuilt
  // after the listener was attached. The popup ELEMENT survives every
  // rebuild, so the listener goes there and the button is resolved with
  // closest() at click time.
  //
  // Both are ON DEMAND: the satellite popup builds a nested map and
  // fetches tiles, so the reader asks for it rather than waiting for it
  // on every tap.
  if (!el._xyzoPointWired) {
    el._xyzoPointWired = true;
    el.addEventListener("click", async (ev) => {
      const btn = ev.target && ev.target.closest
        ? ev.target.closest(".popup-satellite-btn, .popup-copy-coords-btn, .popup-zoom-here-btn")
        : null;
      if (!btn || !el.contains(btn)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const lat = Number(btn.getAttribute("data-lat"));
      const lng = Number(btn.getAttribute("data-lng"));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      if (btn.classList.contains("popup-zoom-here-btn")) {
        // THE READER'S ZOOM, ON THEIR TERMS. The map no longer flies on
        // its own when a pin is clicked — this button is the way in.
        try { zoomToPlace(lat, lng); } catch (e) { XLog.warn("[popup] zoom-to-place failed:", e); }
        return;
      }
      if (btn.classList.contains("popup-satellite-btn")) {
        try { openSatellitePopup({ lat, lng }); } catch (e) { XLog.warn("[popup] satellite failed:", e); }
        return;
      }
      const text = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "✓ Copied";
        setTimeout(() => { btn.textContent = "📋 Copy coords"; }, 1400);
      } catch (e) {
        XLog.warn("[popup] copy failed:", e);
      }
    });
  }

  // Detect and render city mentions from the pin's title/summary/body.
  if (window.CityEngine && pin && (pin.title || pin.summary)) {
    renderPinCities(el, pin);
  }

  // Render quality reports for the pin.
  if (pin && pin.id) {
    renderPinReports(el, pin);
  }

  // Render top words for the pin (fetched from server-side NLP extraction).
  if (pin && pin.id) {
    renderPinWords(el, pin);
  }

  // Render the relationship tree (siblings + related stories, ranked).
  if (pin && pin.id) {
    renderPinTree(el, pin);
  }

  // Surface client-side apply-suggestion buttons (city + category) when
  // the article is missing a confirmed location or event type. Runs in
  // parallel with renderPinCities — both await their own data fetches.
  if (window.CityEngine && pin && pin.id) {
    renderApplySuggestions(el, pin).catch((e) =>
      XLog.warn("[apply-suggestions] failed:", e),
    );
  }

  // ── Read more (editorial body / community story note) ────────────────
  // NOTE: the old `.read-more` selector never matched buildPopup's
  // `popup-read-btn` class — the button was silently dead. Wired properly
  // now, and extended to community pins (renders story_note + submitter).
  const btn = el.querySelector(".popup-read-btn");
  if (btn && pin) {
    btn.addEventListener("click", async () => {
      btn.textContent = "loading…";
      btn.disabled = true;
      try {
        const res = await fetch(`/api/pins/${pin.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const detail = body.detail || {};
        const content = el.querySelector(".leaflet-popup-content");
        if (detail.body_markdown) {
          const html = DOMPurify.sanitize(marked.parse(detail.body_markdown));
          content.insertAdjacentHTML("beforeend",
            `<hr><div class="md-body">${html}</div>`);
        } else if (detail.story_note) {
          const who = detail.submitter_name
            ? ` — ${escapeHtml(detail.submitter_name)}` : "";
          content.insertAdjacentHTML("beforeend",
            `<hr><div class="md-body"><p>${escapeHtml(detail.story_note).replace(/\n/g, "<br>")}</p>` +
            `<p style="opacity:0.7;font-size:11px;">Community submission${who}</p></div>`);
        } else {
          content.insertAdjacentHTML("beforeend",
            `<hr><div class="md-body"><p style="opacity:0.7;">No additional details.</p></div>`);
        }
        btn.remove();
      } catch (e) {
        XLog.warn("[read-more] failed:", e);
        btn.textContent = "failed";
        btn.disabled = false;
      }
    });
  }

  // ── Wrong location (RSS only) ─────────────────────────────────────
  // Click the button → enter "click anywhere on the map to set the right
  // spot" mode. The next click on the map drops a temporary marker, POSTs
  // {lat,lng} to /api/pins/:id/suggest-coords, and shows a translucent
  // halo at the suggested location until the popup is closed.
  const wrongBtn = el.querySelector(".wrong-loc, .popup-fix-btn");
  if (wrongBtn) {
    wrongBtn.addEventListener("click", () => {
      enterWrongLocationMode(pin, wrongBtn, popup);
    });
  }

  const catBtn = el.querySelector(".popup-cat-btn");
  if (catBtn) {
    catBtn.addEventListener("click", () => {
      enterWrongLocationMode(pin, catBtn, popup, true);
    });
  }

  // ── Report story quality ──────────────────────────────────────────
  const reportBtn = el.querySelector(".popup-report-btn");
  if (reportBtn) {
    reportBtn.addEventListener("click", () => {
      showReportDialog(pin);
    });
  }

  // ── Combined feedback dialog ──────────────────────────────────────
  // One dialog with two tabs: Report Issue (eight report types, POSTs
  // /api/pins/:id/report) and Fix Location (place search or map click,
  // POSTs /api/pins/:id/suggest-coords — the same endpoint the 🚩 Fix
  // button drives). Guarded: the module is loaded by index.html, but a
  // missing or failed script must degrade to nothing rather than throw
  // inside the popup's own handler and take the popup down with it.
  const feedbackBtn = el.querySelector(".popup-feedback-btn");
  if (feedbackBtn) {
    feedbackBtn.addEventListener("click", () => {
      if (typeof window.showFeedbackDialog === "function") {
        window.showFeedbackDialog(pin);
      } else {
        XLog.warn("[feedback-dialog] module not loaded — button disabled");
        feedbackBtn.disabled = true;
      }
    });
  }

  // ── Ask AI about this story ──────────────────────────────────────
  // Opens a small floating chat modal seeded with the article context
  // (headline, source, location, summary) so the AI can answer questions
  // like "what's the bias here?" or "is this verified?" without the user
  // having to retype the story.
  const askAiBtn = el.querySelector(".popup-ai-btn");
  if (askAiBtn) {
    askAiBtn.addEventListener("click", () => {
      openPinAiChat(pin);
    });
  }

  // ── Heart / Star reactions ───────────────────────────────────────
  el.querySelectorAll(".popup-react-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pinId = btn.dataset.pin;
      const kind = btn.dataset.react;
      if (!pinId || !kind) return;
      const key = `xyzo_fav_${pinId}`;
      let state = null;
      try { state = JSON.parse(localStorage.getItem(key)); } catch (_) {}
      if (!state) state = {};
      state[kind] = !state[kind];
      try { localStorage.setItem(key, JSON.stringify(state)); } catch (_) {}
      // Toggle visual style
      btn.classList.toggle("active", state[kind]);
      if (kind === "love") {
        btn.style.background = state[kind] ? "rgba(239,68,68,0.2)" : "";
        btn.style.borderColor = state[kind] ? "rgba(239,68,68,0.5)" : "";
        btn.style.color = state[kind] ? "#ef4444" : "";
      } else {
        btn.style.background = state[kind] ? "rgba(250,204,21,0.2)" : "";
        btn.style.borderColor = state[kind] ? "rgba(250,204,21,0.5)" : "";
        btn.style.color = state[kind] ? "#facc15" : "";
      }
      // Fire-and-forget analytics POST
      try {
        fetch("/api/analytics/reaction", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin_id: Number(pinId), reaction: kind, active: state[kind] }),
        }).catch(() => {});
      } catch (_) {}
    });
  });

  // ── Recommend this story (community vote) ──────────────────────────
  // One vote per IP server-side; localStorage prevents repeat POSTs and
  // keeps the button state across popup re-renders. Failures are routed
  // through XLog (never console.*) per AGENTS.md.
  const recBtn = el.querySelector(".popup-recommend-btn");
  if (recBtn) {
    recBtn.addEventListener("click", async () => {
      const recId = recBtn.dataset.id;
      if (!recId || recBtn.disabled) return;
      const recKey = `xyzo_rec_${recId}`;
      let alreadyDone = false;
      try { alreadyDone = localStorage.getItem(recKey) === "1"; } catch (_) {}
      if (alreadyDone) {
        recBtn.title = "You already recommended this story";
        return;
      }
      recBtn.disabled = true;
      try {
        const resp = await fetch(`/api/news/${encodeURIComponent(recId)}/recommend`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: window.XyzoAnalytics?.sessionId }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        try { localStorage.setItem(recKey, "1"); } catch (_) {}
        recBtn.classList.add("active");
        recBtn.style.background = "rgba(52,211,153,0.2)";
        recBtn.style.borderColor = "rgba(52,211,153,0.5)";
        recBtn.style.color = "#34d399";
        const count = Number(data.recommend_count);
        recBtn.textContent = Number.isFinite(count) && count > 0 ? `👍 ${count}` : "👍";
        recBtn.title = data.duplicate ? "Already recommended" : "Recommended — thanks!";
      } catch (e) {
        XLog.warn("[recommend] failed:", e);
        recBtn.title = "Recommend failed — click to retry";
      } finally {
        recBtn.disabled = false;
      }
    });
  }
}

// ── "Wrong about this pin" flow ──────────────────────────────────────────────
// Simplified flow: user types what's wrong (e.g. "should be in Argentina")
// and clicks Submit. Optionally they can also click the map to mark the
// exact location. The AI evaluates immediately and shows results.
let _wrongLoc = null;

async function fetchPinDebugInfo(pin) {
  const debugEl = document.getElementById("wrong-loc-debug");
  if (!debugEl) return;
  try {
    // Try to fetch the pin's article data from the API.
    const res = await fetch(`/api/pins/${pin.id}`);
    if (!res.ok) {
      // For editorial/community pins, show what we have from the pin object.
      const loading = debugEl.querySelector(".wrong-loc-debug-loading");
      if (loading) loading.remove();
      debugEl.insertAdjacentHTML("beforeend", `
        <div class="wrong-loc-debug-row"><span class="wrong-loc-debug-label">Note:</span> <span>This is a ${escapeHtml(pin.source_type)} pin — AI extraction data may not be available.</span></div>
      `);
      return;
    }
    const data = await res.json();
    const detail = data.detail || data;
    const loading = debugEl.querySelector(".wrong-loc-debug-loading");
    if (loading) loading.remove();

    // Show AI extraction data.
    const rows = [];
    if (detail.summary) rows.push(`<div class="wrong-loc-debug-row"><span class="wrong-loc-debug-label">AI summary:</span> <span>${escapeHtml(detail.summary.slice(0, 150))}</span></div>`);
    if (detail.event_type) rows.push(`<div class="wrong-loc-debug-row"><span class="wrong-loc-debug-label">AI event type:</span> <span>${escapeHtml(detail.event_type)}</span></div>`);
    if (detail.location_text) rows.push(`<div class="wrong-loc-debug-row"><span class="wrong-loc-debug-label">AI extracted place:</span> <span>${escapeHtml(detail.location_text)}</span></div>`);
    if (detail.entities?.length) rows.push(`<div class="wrong-loc-debug-row"><span class="wrong-loc-debug-label">Entities:</span> <span>${detail.entities.map(e => escapeHtml(e)).join(", ")}</span></div>`);
    if (detail.topic_tags?.length) rows.push(`<div class="wrong-loc-debug-row"><span class="wrong-loc-debug-label">Topics:</span> <span>${detail.topic_tags.map(t => escapeHtml(t)).join(", ")}</span></div>`);
    if (detail.suggested_place_name) rows.push(`<div class="wrong-loc-debug-row"><span class="wrong-loc-debug-label">Previous suggestion:</span> <span>${escapeHtml(detail.suggested_place_name)}</span></div>`);
    if (detail.re_evaluation_reasoning) rows.push(`<div class="wrong-loc-debug-row"><span class="wrong-loc-debug-label">Last AI reasoning:</span> <span>${escapeHtml(detail.re_evaluation_reasoning.slice(0, 200))}</span></div>`);

    if (rows.length) {
      debugEl.insertAdjacentHTML("beforeend", rows.join(""));
    } else {
      debugEl.insertAdjacentHTML("beforeend", `
        <div class="wrong-loc-debug-row"><span class="wrong-loc-debug-label">Note:</span> <span>No AI extraction data available for this pin.</span></div>
      `);
    }
  } catch (_) {
    const loading = debugEl?.querySelector(".wrong-loc-debug-loading");
    if (loading) loading.textContent = "Could not load debug info.";
  }
}

async function renderQuickPickCities(banner, pin) {
  const wrap = banner.querySelector("#wrong-loc-cities");
  const chipsEl = banner.querySelector("#wrong-loc-cities-chips");
  if (!wrap || !chipsEl || !window.CityEngine) return;

  // Wait for the engine.
  if (!window.CityEngine.isLoaded()) {
    await window.CityEngine.load();
  }

  // Build text from title + location_text + (loaded) body.
  let body = "";
  try {
    const res = await fetch(`/api/pins/${pin.id}`);
    if (res.ok) {
      const data = await res.json();
      body = (data.detail && data.detail.body_markdown) || "";
      body = body.replace(/[`*_#>]/g, " ");
    }
  } catch { /* ignore */ }
  const text = `${pin.title || ""} ${pin.location?.place_name || ""} ${body}`.trim();
  if (!text) return;

  const stats = window.CityEngine.cityStats(text, { minPopulation: 100000 });
  if (stats.count === 0) return;

  wrap.hidden = false;
  const flag = (cc) => cc && cc.length === 2
    ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0)))
    : "";
  // De-dupe by id (already done in stats.cities) but show only top 6.
  const seen = new Set();
  const ordered = [];
  if (stats.primary) { seen.add(stats.primary.id); ordered.push(stats.primary); }
  for (const c of stats.cities) {
    if (!seen.has(c.id)) { seen.add(c.id); ordered.push(c); }
  }
  chipsEl.innerHTML = ordered.slice(0, 6).map(c => (
    '<button type="button" class="city-quickpick" '
    + `data-lat="${c.la}" data-lng="${c.ln}" data-cc="${escapeAttr(c.cc)}" `
    + `data-name="${escapeAttr(c.n)}">`
    + `<span class="city-chip-flag">${flag(c.cc)}</span>${escapeHtml(c.n)}`
    + '</button>'
  )).join('');
  chipsEl.querySelectorAll(".city-quickpick").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const lat = Number(btn.dataset.lat);
      const lng = Number(btn.dataset.lng);
      const cc = btn.dataset.cc;
      const name = btn.dataset.name;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      // Submit a suggest-coords with place_text so AI re-evaluates with the hint.
      btn.disabled = true;
      btn.textContent = '… sending';
      // Capture the map view at submit time so the backend can persist it
      // and we can offer a "🗺 View original" link back to this view.
      const _mapCenter = map && map.getCenter ? map.getCenter() : null;
      const _mapZoom = map && map.getZoom ? Math.round(map.getZoom()) : null;
      try {
        const res = await fetch(`/api/pins/${pin.id}/suggest-coords`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lat, lng,
            place_text: `${name}, ${cc}`,
            radius_km: 25,
            map_center_lat: _mapCenter ? Number(_mapCenter.lat.toFixed(6)) : null,
            map_center_lng: _mapCenter ? Number(_mapCenter.lng.toFixed(6)) : null,
            map_zoom: _mapZoom,
          }),
        });
        if (res.ok) {
          btn.textContent = '✓ sent';
          // Build a "View original" link to the map view at submit time.
          const _viewUrl = (_mapCenter && _mapZoom != null)
            ? `${location.origin}/#${_mapCenter.lat.toFixed(4)},${_mapCenter.lng.toFixed(4)},${_mapZoom}/pin=${pin.id}`
            : null;
          if (_viewUrl) {
            const link = document.createElement('a');
            link.href = _viewUrl;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = '🗺 View original →';
            link.style.cssText = 'color:var(--accent);text-decoration:underline;margin-left:6px;font-size:11px;';
            btn.insertAdjacentElement('afterend', link);
          }
          // Refresh suggestions history so admin sees the request appear.
          fetchPinSuggestions(pin);
        } else {
          btn.textContent = 'failed';
          btn.disabled = false;
        }
      } catch {
        btn.textContent = 'failed';
        btn.disabled = false;
      }
    });
  });
}

async function fetchPinSuggestions(pin) {
  const historyEl = document.getElementById("wrong-loc-history");
  const listEl = document.getElementById("wrong-loc-history-list");
  if (!historyEl || !listEl) return;

  try {
    const res = await fetch(`/api/pins/${pin.id}/suggestions`);
    if (!res.ok) return;

    const data = await res.json();
    const suggestions = data.suggestions || [];
    const reports = data.reports || [];

    if (suggestions.length === 0 && reports.length === 0) {
      return; // No history to show
    }

    historyEl.hidden = false;

    let html = '';

    // Show location suggestions
    for (const s of suggestions) {
      const statusIcon = s.applied ? '✓' : s.status === 'completed' ? '○' : '⏳';
      const statusColor = s.applied ? '#22c55e' : s.status === 'completed' ? '#f59e0b' : '#64748b';
      const timeAgo = s.requested_at ? formatRelativeTime(s.requested_at) : '';

      html += `
        <div class="wrong-loc-history-item" style="border-left: 3px solid ${statusColor}; padding-left: 8px; margin-bottom: 8px;">
          <div style="font-size: 11px; color: var(--fg);">
            ${statusIcon} <strong>${escapeHtml(s.user_place || 'Map click')}</strong>
            ${s.applied ? '<span style="color: #22c55e;"> (applied)</span>' : ''}
          </div>
          ${s.result_place ? `<div style="font-size: 10px; color: var(--muted);">→ ${escapeHtml(s.result_place)}</div>` : ''}
          <div style="font-size: 10px; color: var(--muted);">
            ${timeAgo}
            ${s.community_status ? ` · ${s.community_status}` : ''}
            ${s.confirm_votes > 0 ? ` · ✓${s.confirm_votes}` : ''}
            ${s.reject_votes > 0 ? ` · ✗${s.reject_votes}` : ''}
          </div>
        </div>
      `;
    }

    // Show quality reports
    for (const r of reports) {
      const timeAgo = r.created_at ? formatRelativeTime(r.created_at) : '';
      html += `
        <div class="wrong-loc-history-item" style="border-left: 3px solid #ef4444; padding-left: 8px; margin-bottom: 8px;">
          <div style="font-size: 11px; color: var(--fg);">
            ⚠️ <strong>${escapeHtml(r.type)}</strong>
          </div>
          ${r.reason ? `<div style="font-size: 10px; color: var(--muted);">"${escapeHtml(r.reason)}"</div>` : ''}
          <div style="font-size: 10px; color: var(--muted);">${timeAgo}</div>
        </div>
      `;
    }

    listEl.innerHTML = html;
  } catch (_) {
    // Silently fail - not critical
  }
}

function enterWrongLocationMode(pin, btn, popup, focusCategory = false) {
  if (_wrongLoc) cancelWrongLocation();
  // Don't close the popup - let the user see both the popup and the banner

  let radiusKm = 25;
  const banner = document.createElement("div");
  banner.className = "wrong-loc-banner";
  banner.innerHTML = `
    <button type="button" class="wrong-loc-close" onclick="cancelWrongLocation()" aria-label="Close">×</button>
    <div class="wrong-loc-text">
      <strong>🚩 Fix Story Details</strong>
      <em class="wrong-loc-title">${escapeHtml(pin.title.slice(0, 70))}${pin.title.length > 70 ? "…" : ""}</em>
    </div>
    <div class="wrong-loc-cat-section" style="width:100%;margin:6px 0 10px;text-align:left;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px 10px;">
      <div style="font-size:11px;font-weight:600;color:var(--accent,#5eead4);margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">
        <span>🏷️ Category / Topic (Feeds NN Learning Loop)</span>
        <span class="wrong-loc-current-cat" style="font-size:10px;color:var(--muted);">Current: <strong>${escapeHtml(pin.category || 'unclassified')}</strong></span>
      </div>
      <div class="wrong-loc-cat-chips" style="display:flex;flex-wrap:wrap;gap:5px;max-height:90px;overflow-y:auto;padding:2px 0;"></div>
      <div class="wrong-loc-cat-msg" style="display:none;font-size:11px;margin-top:6px;padding:4px 8px;border-radius:4px;"></div>
    </div>
    <div class="wrong-loc-debug" id="wrong-loc-debug">
      <div class="wrong-loc-debug-row"><span class="wrong-loc-debug-label">Source type:</span> <span>${escapeHtml(pin.source_type || 'unknown')}</span></div>
      ${pin.location ? `<div class="wrong-loc-debug-row"><span class="wrong-loc-debug-label">Current location:</span> <span>${escapeHtml(pin.location.place_name || 'unknown')}, ${escapeHtml(pin.location.country || '')} (${pin.location.lat?.toFixed(3)}, ${pin.location.lng?.toFixed(3)})</span></div>` : ''}
      ${pin.category ? `<div class="wrong-loc-debug-row"><span class="wrong-loc-debug-label">Category:</span> <span>${escapeHtml(pin.category)}</span></div>` : ''}
      <div class="wrong-loc-debug-row wrong-loc-debug-loading"><span class="explore-spinner"></span> Loading AI extraction data…</div>
    </div>
    <div class="wrong-loc-cities" id="wrong-loc-cities" hidden>
      <div class="wrong-loc-cities-label">Quick pick — cities mentioned in this story</div>
      <div class="wrong-loc-cities-chips" id="wrong-loc-cities-chips"></div>
    </div>
    <div class="wrong-loc-history" id="wrong-loc-history" hidden>
      <div class="wrong-loc-history-title">Previous Suggestions</div>
      <div class="wrong-loc-history-list" id="wrong-loc-history-list"></div>
    </div>
    <textarea class="wrong-loc-note" rows="2" maxlength="200"
              placeholder="e.g. 'should be in Argentina' or 'this is about Beirut, Lebanon'"></textarea>
    <div class="wrong-loc-radius" hidden>
      <button type="button" class="wrong-loc-radius-btn" data-delta="-5" aria-label="Shrink radius">−</button>
      <span class="wrong-loc-radius-label">approx <strong>${radiusKm}</strong> km radius</span>
      <button type="button" class="wrong-loc-radius-btn" data-delta="5" aria-label="Grow radius">+</button>
    </div>
    <div class="wrong-loc-actions">
      <button type="button" class="wrong-loc-submit" disabled>Submit</button>
      <button type="button" class="wrong-loc-click-map">📍 Click map to mark location</button>
      <button type="button" class="wrong-loc-link-loc">🔗 Link to location</button>
      <button type="button" class="wrong-loc-cancel">Cancel</button>
    </div>
    <p class="wrong-loc-hint">Describe what's wrong, mark a location, or link this story to another place on the map.</p>
    <div class="wrong-loc-result" hidden></div>
  `;
  document.body.appendChild(banner);

  // Render Category Choice Chips
  const catChipsContainer = banner.querySelector(".wrong-loc-cat-chips");
  const catMsg = banner.querySelector(".wrong-loc-cat-msg");
  const currentCatEl = banner.querySelector(".wrong-loc-current-cat strong");

  const categories = [
    { key: "politics", label: "Politics 🏛️", color: "#f97316" },
    { key: "business", label: "Business 📈", color: "#eab308" },
    { key: "technology", label: "Tech 💻", color: "#06b6d4" },
    { key: "ai", label: "AI 🤖", color: "#0891b2" },
    { key: "crime", label: "Crime 🚨", color: "#ef4444" },
    { key: "conflict", label: "Conflict ⚔️", color: "#dc2626" },
    { key: "sports", label: "Sports ⚽", color: "#22c55e" },
    { key: "science", label: "Science 🔬", color: "#8b5cf6" },
    { key: "culture", label: "Culture 🎭", color: "#ec4899" },
    { key: "environment", label: "Environment 🌿", color: "#10b981" },
    { key: "weather", label: "Weather ⛈️", color: "#3b82f6" },
    { key: "health", label: "Health 🏥", color: "#14b8a6" },
    { key: "transit", label: "Transit 🚇", color: "#2563eb" },
    { key: "education", label: "Education 🎓", color: "#9333ea" },
    { key: "disaster", label: "Disaster 🌪️", color: "#a16207" },
  ];

  const currentPinCat = (pin.category || pin.event_type || "").toLowerCase();
  for (const c of categories) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "wrong-loc-cat-chip" + (currentPinCat === c.key ? " selected" : "");
    chip.textContent = c.label;
    chip.style.borderColor = c.color + "66";
    chip.addEventListener("click", async () => {
      catChipsContainer.querySelectorAll(".wrong-loc-cat-chip").forEach(el => el.classList.remove("selected"));
      chip.classList.add("selected");
      catMsg.style.display = "block";
      catMsg.style.background = "rgba(94,234,212,0.1)";
      catMsg.style.color = "var(--accent)";
      catMsg.textContent = `Applying category "${c.label}"…`;

      try {
        const res = await fetch(`/api/articles/${pin.id}/apply-categorization`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event_type: c.key }),
        });
        if (!res.ok) throw new Error("API returned " + res.status);
        pin.category = c.key;
        pin.event_type = c.key;
        pin.auto_categorize_method = "client_apply";
        if (currentCatEl) currentCatEl.textContent = c.key;

        // Redraw canvas with new category and icon
        if (typeof canvasRenderer !== "undefined" && canvasRenderer && canvasRenderer._enabled) {
          canvasRenderer._scheduleRedraw();
        }

        // If popup is currently open, refresh its content
        if (popup && popup.isOpen && popup.isOpen()) {
          popup.setContent(buildPopup(pin));
        }

        catMsg.style.background = "rgba(34,197,94,0.15)";
        catMsg.style.color = "#22c55e";
        catMsg.textContent = `✓ Story categorized as "${c.label}" and logged for NN retraining!`;
      } catch (err) {
        catMsg.style.background = "rgba(239,68,68,0.15)";
        catMsg.style.color = "#ef4444";
        catMsg.textContent = `Failed to apply category: ${err.message}`;
      }
    });
    catChipsContainer.appendChild(chip);
  }

  // Fetch debug info about this pin (AI extraction data).
  fetchPinDebugInfo(pin);

  // Fetch previous suggestions for this pin.
  fetchPinSuggestions(pin);

  // Render "quick pick" chips for cities detected in the article.
  // Lets admin set the correct location with one click instead of
  // clicking the map or typing.
  renderQuickPickCities(banner, pin);

  const noteEl = banner.querySelector(".wrong-loc-note");
  const submitBtn = banner.querySelector(".wrong-loc-submit");
  const clickMapBtn = banner.querySelector(".wrong-loc-click-map");
  const cancel = banner.querySelector(".wrong-loc-cancel");
  const radiusRow = banner.querySelector(".wrong-loc-radius");
  const radiusLabel = banner.querySelector(".wrong-loc-radius-label strong");
  const resultDiv = banner.querySelector(".wrong-loc-result");

  const updateRadiusLabel = () => { radiusLabel.textContent = String(radiusKm); };
  updateRadiusLabel();

  const state = { clickCenter: null, clickRadius: null, clickMode: false };

  function refreshSubmitEnabled() {
    const hasNote = noteEl.value.trim().length >= 2;
    const hasClick = !!(state.clickCenter);
    submitBtn.disabled = !hasNote && !hasClick;
  }

  noteEl.addEventListener("input", refreshSubmitEnabled);

  // Enter to submit
  noteEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!submitBtn.disabled) onSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelWrongLocation();
    }
  });

  const placeSuggestionCircle = (lat, lng, radius) => {
    if (_wrongLoc && _wrongLoc.circle) map.removeLayer(_wrongLoc.circle);
    const circle = L.circle([lat, lng], {
      radius: radius * 1000,
      color: "#5eead4",
      weight: 2, fillColor: "#5eead4", fillOpacity: 0.18,
      interactive: false, bubblingMouseEvents: false,
    }).addTo(map);
    if (_wrongLoc) {
      _wrongLoc.circle = circle;
      _wrongLoc.center = { lat, lng };
      _wrongLoc.radiusKm = radius;
    }
    state.clickCenter = { lat, lng };
    state.clickRadius = radius;
    refreshSubmitEnabled();
  };

  const onMapClick = (e) => {
    if (!state.clickMode) return;
    placeSuggestionCircle(e.latlng.lat, e.latlng.lng, radiusKm);
    radiusRow.hidden = false;
    clickMapBtn.textContent = "📍 Location marked (click again to change)";
    setBannerHint("Location marked! Add a description or click Submit.");
    refreshSubmitEnabled();
  };

  // Click map button toggles click mode
  clickMapBtn.addEventListener("click", () => {
    if (state.clickMode) {
      state.clickMode = false;
      clickMapBtn.textContent = "📍 Click map to mark location";
      document.getElementById("map").classList.remove("wrong-loc-cursor");
      map.off("click", onMapClick);
      setBannerHint("Describe what's wrong, mark a location, or link this story to another place on the map.");
    } else {
      state.clickMode = true;
      clickMapBtn.textContent = "📍 Click anywhere on the map…";
      document.getElementById("map").classList.add("wrong-loc-cursor");
      map.on("click", onMapClick);
      setBannerHint("Click on the map to mark where this story should be.");
    }
  });

  // "Link to location" button — enters link mode, next click creates a link.
  const linkLocBtn = banner.querySelector(".wrong-loc-link-loc");
  if (linkLocBtn) {
    linkLocBtn.addEventListener("click", () => {
      cancelWrongLocation();
      if (pin.id) startAddLinkToLocation(pin.id);
    });
  }

  // Radius stepper
  for (const stepBtn of banner.querySelectorAll(".wrong-loc-radius-btn")) {
    stepBtn.addEventListener("click", () => {
      const delta = Number(stepBtn.dataset.delta);
      if (!Number.isFinite(delta)) return;
      const next = Math.max(5, Math.min(500, radiusKm + delta));
      if (next === radiusKm) return;
      radiusKm = next;
      updateRadiusLabel();
      if (state.clickCenter) {
        placeSuggestionCircle(state.clickCenter.lat, state.clickCenter.lng, radiusKm);
      }
    });
  }

  noteEl.focus();

  function setBannerHint(msg) {
    const hint = banner.querySelector(".wrong-loc-hint");
    if (hint) hint.textContent = msg;
  }

  function showResult(html) {
    resultDiv.innerHTML = html;
    resultDiv.hidden = false;
  }

  const onSubmit = async () => {
    const note = noteEl.value.trim();
    const hasClick = !!state.clickCenter;

    if (!note && !hasClick) {
      noteEl.focus();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Processing…";
    clickMapBtn.disabled = true;
    cancel.disabled = true;

    const payload = {};
    if (note) payload.place_text = note;
    if (hasClick) {
      payload.lat = state.clickCenter.lat;
      payload.lng = state.clickCenter.lng;
      payload.radius_km = state.clickRadius;
    }
    // Capture the map view at submit time so the backend can persist it
    // and we can offer a "🗺 View original" link back to this view.
    const _mapCenter = map && map.getCenter ? map.getCenter() : null;
    const _mapZoom = map && map.getZoom ? Math.round(map.getZoom()) : null;
    payload.map_center_lat = _mapCenter ? Number(_mapCenter.lat.toFixed(6)) : null;
    payload.map_center_lng = _mapCenter ? Number(_mapCenter.lng.toFixed(6)) : null;
    payload.map_zoom = _mapZoom;
    // Build a "View original" link to render in the result toast.
    const _viewOriginalHtml = (_mapCenter && _mapZoom != null)
      ? `<a href="${location.origin}/#${_mapCenter.lat.toFixed(4)},${_mapCenter.lng.toFixed(4)},${_mapZoom}/pin=${pin.id}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline;margin-left:6px;">🗺 View original →</a>`
      : '';

    showResult(`<div class="explore-status"><span class="explore-spinner"></span> Analyzing suggestion…</div>`);

    // Log fix submission to debug
    XLog.log(`[Fix] Submitting fix for Pin ID: ${pin.id}`, {
      title: pin.title?.slice(0, 60),
      current_lat: pin.location?.lat,
      current_lng: pin.location?.lng,
      current_place: pin.location?.place_name,
      payload: payload,
    });

    try {
      // Use the fast-suggest endpoint for immediate feedback
      const res = await fetch(`/api/pins/${pin.id}/fast-suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.status === 429) {
        showResult(`<strong style="color:#fca5a5">Rate limited — try again later.</strong>`);
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit";
        clickMapBtn.disabled = false;
        cancel.disabled = false;
        return;
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.error === "no_article") {
          showResult(`
            <div style="color:#f59e0b; margin-bottom: 8px;">
              <strong>Thanks for the feedback!</strong>
            </div>
            <div style="font-size: 11px; color: var(--muted); font-family: ui-monospace, monospace; line-height: 1.6;">
              <div>This is a <strong>${escapeHtml(pin.source_type)}</strong> pin, so it can't be auto-relocated.</div>
              ${note ? `<div style="margin-top: 6px;"><strong>Your note:</strong> "${escapeHtml(note)}"</div>` : ""}
              <div style="margin-top: 8px; color: var(--accent);">✓ Feedback saved — thank you.</div>
            </div>
          `);
          setTimeout(closeReportDialog, 3000);
          return;
        }
        showResult(`<strong style="color:#fca5a5">Error: ${escapeHtml(err.message || err.error || "Unknown")}</strong>`);
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit";
        clickMapBtn.disabled = false;
        cancel.disabled = false;
        return;
      }

      const data = await res.json();

      // Log fix result to debug
      XLog.log(`[Fix] Result for Pin ID: ${pin.id}`, {
        applied: data.applied,
        result: data.result,
        total_ms: data.total_ms,
        steps: data.steps?.map(s => `${s.step}: ${s.message}`),
      });

      // Show step-by-step results
      let stepsHtml = '<div style="font-family: ui-monospace, monospace; font-size: 11px;">';
      for (const step of data.steps || []) {
        const icon = step.status === 'ok' ? '✓' : step.status === 'failed' ? '✗' : '○';
        const color = step.status === 'ok' ? '#22c55e' : step.status === 'failed' ? '#ef4444' : '#64748b';
        stepsHtml += `<div style="margin: 4px 0; color: ${color};">${icon} ${escapeHtml(step.message)}</div>`;
      }
      stepsHtml += '</div>';

      if (data.applied) {
        const r = data.result;
        showResult(`
          <div style="color:#22c55e; margin-bottom: 8px;">
            <strong>✓ Location updated!</strong>
          </div>
          ${stepsHtml}
          <div style="margin-top: 8px; padding: 8px; background: rgba(34, 197, 94, 0.1); border-radius: 4px; font-size: 11px;">
            <div><strong>New location:</strong> ${escapeHtml(r.place_name || 'Suggested location')}</div>
            <div><strong>Coordinates:</strong> ${r.lat?.toFixed(4)}, ${r.lng?.toFixed(4)}</div>
            <div><strong>Precision:</strong> ${r.precision}</div>
            <div><strong>Confidence:</strong> ${Math.round(r.confidence * 100)}%</div>
            <div><strong>Processing time:</strong> ${data.total_ms}ms</div>
          </div>
          <div style="margin-top: 8px;">
            <button class="wrong-loc-zoom-btn" style="background: var(--accent); color: #0b0f14; border: none; padding: 6px 12px; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 11px;">
              📍 Zoom to new location
            </button>
            <button class="wrong-loc-dismiss-btn" style="background: transparent; color: var(--muted); border: 1px solid var(--muted); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; margin-left: 8px;">
              Dismiss
            </button>
          </div>
          ${_viewOriginalHtml ? `<div style="margin-top: 8px; font-size: 11px;">${_viewOriginalHtml}</div>` : ''}
        `);

        // Add button handlers
        const zoomBtn = resultDiv.querySelector(".wrong-loc-zoom-btn");
        const dismissBtn = resultDiv.querySelector(".wrong-loc-dismiss-btn");

        if (zoomBtn) {
          zoomBtn.addEventListener("click", () => {
            if (r.lat && r.lng) {
              map.setView([r.lat, r.lng], Math.max(map.getZoom(), 8), { animate: true });
              fetchPinsForViewport();
            }
          });
        }

        if (dismissBtn) {
          dismissBtn.addEventListener("click", () => {
            cancelWrongLocation();
            fetchPinsForViewport();
          });
        }

        // Update marker position
        if (r.lat && r.lng) {
          updateMarkerPosition(pin.id, r.lat, r.lng, r.place_name);
        }
      } else {
        showResult(`
          <div style="color:#f59e0b; margin-bottom: 8px;">
            <strong>Suggestion noted</strong>
          </div>
          ${stepsHtml}
          <div style="margin-top: 8px; font-size: 11px; color: var(--muted);">
            ${data.reasoning || 'The suggestion was recorded but the pin was not moved.'}
          </div>
          <div style="margin-top: 8px;">
            <button class="wrong-loc-dismiss-btn" style="background: transparent; color: var(--muted); border: 1px solid var(--muted); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 11px;">
              Dismiss
            </button>
          </div>
          ${_viewOriginalHtml ? `<div style="margin-top: 8px; font-size: 11px;">${_viewOriginalHtml}</div>` : ''}
        `);

        const dismissBtn = resultDiv.querySelector(".wrong-loc-dismiss-btn");
        if (dismissBtn) {
          dismissBtn.addEventListener("click", () => cancelWrongLocation());
        }
      }
    } catch (_err) {
      showResult(`<strong style="color:#fca5a5">Network error — try again.</strong>`);
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit";
      clickMapBtn.disabled = false;
      cancel.disabled = false;
    }
  };

  submitBtn.addEventListener("click", onSubmit);
  cancel.addEventListener("click", cancelWrongLocation);

  refreshSubmitEnabled();

  const onKey = (e) => { if (e.key === "Escape") cancelWrongLocation(); };
  document.addEventListener("keydown", onKey);

  _wrongLoc = {
    pinId: pin.id, btn, popup, banner,
    handler: onMapClick, keyHandler: onKey,
    circle: null, center: null, click: state, radiusKm,
  };
}

// Two small helpers shared with the wrong-location flow.
function setBannerHint(banner, msg) {
function setBannerError(banner, msg) {
  // Hide the hint and replace it with a red error line in the text
  // block — callers rebuild via innerHTML for full formatting control.
  banner.querySelector(".wrong-loc-hint").innerHTML =
    `<strong style="color:#fca5a5">${escapeHtml(msg)}</strong>`;
}

  const hint = banner.querySelector(".wrong-loc-hint");
  if (hint) hint.textContent = msg;
}
async function pollReEvaluation(requestId, banner, suggestionCircle, pinId, pin, hasClick) {
  const POLL_MS = 1500;
  const MAX_WAIT_S = 60;
  const t0 = Date.now();
  const resultDiv = banner.querySelector(".wrong-loc-result");

  while (Date.now() - t0 < MAX_WAIT_S * 1000) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const res = await fetch(`/api/re-evaluate/${requestId}`);
      if (!res.ok) continue;
      const data = await res.json();

      if (data.status === "completed" || data.status === "skipped") {
        if (suggestionCircle) map.removeLayer(suggestionCircle);

        const suggestion = data.suggestion || {};
        const applied = suggestion.applied;

        // Build detailed result display
        let resultHtml = "";

        if (applied) {
          const newLat = suggestion.lat;
          const newLng = suggestion.lng;
          const precision = suggestion.precision || "unknown";
          const confidence = suggestion.confidence ? Math.round(suggestion.confidence * 100) : "?";
          const placeName = suggestion.place_name || "suggested location";

          // Build a step-by-step summary of what happened
          const steps = [];
          if (hasClick) {
            steps.push("Received your map pin location");
            steps.push(`Set precision to "${precision}" based on ${suggestion.radius_km || 25}km radius`);
          } else {
            steps.push(`Geocoded "${escapeHtml(pin.title?.slice(0, 40) || 'your suggestion')}"`);
            steps.push(`Resolved to ${escapeHtml(placeName)}`);
          }
          steps.push(`Moved pin to ${newLat?.toFixed(4)}, ${newLng?.toFixed(4)}`);
          steps.push(`Confidence: ${confidence}%`);

          resultHtml = `
            <div style="color:#5eead4; margin-bottom: 8px;">
              <strong>✓ Pin moved successfully!</strong>
            </div>
            <div style="font-size: 11px; color: var(--muted); font-family: ui-monospace, monospace; line-height: 1.8;">
              ${steps.map(s => `<div>→ ${s}</div>`).join("")}
              ${suggestion.reasoning ? `<div style="margin-top: 4px; color: var(--fg);"><strong>Note:</strong> ${escapeHtml(suggestion.reasoning)}</div>` : ""}
            </div>
            <div style="margin-top: 8px;">
              <button class="wrong-loc-zoom-btn" style="background: var(--accent); color: #0b0f14; border: none; padding: 6px 12px; border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 11px;">
                📍 Zoom to new location
              </button>
              <button class="wrong-loc-dismiss-btn" style="background: transparent; color: var(--muted); border: 1px solid var(--muted); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; margin-left: 8px;">
                Dismiss
              </button>
            </div>
          `;

          // Show result first, then add event listeners
          showResult(resultHtml);

          // Add event listeners to the buttons
          const zoomBtn = resultDiv.querySelector(".wrong-loc-zoom-btn");
          const dismissBtn = resultDiv.querySelector(".wrong-loc-dismiss-btn");

          if (zoomBtn) {
            zoomBtn.addEventListener("click", () => {
              if (newLat != null && newLng != null) {
                map.setView([newLat, newLng], Math.max(map.getZoom(), 8), { animate: true });
                fetchPinsForViewport();
              }
            });
          }

          if (dismissBtn) {
            dismissBtn.addEventListener("click", () => {
              cancelWrongLocation();
              fetchPinsForViewport();
            });
          }

          // Update the marker position in the registry without full refresh
          if (newLat != null && newLng != null) {
            updateMarkerPosition(pinId, newLat, newLng, placeName);
          }

          return;
        } else {
          // Build a step-by-step summary of what happened
          const steps = [];
          if (hasClick) {
            steps.push("Received your map pin location");
          } else {
            steps.push(`Geocoded "${escapeHtml(pin.title?.slice(0, 40) || 'your suggestion')}"`);
          }
          steps.push("Reviewed against article content");
          steps.push("Decided not to move pin automatically");

          resultHtml = `
            <div style="color: #f59e0b; margin-bottom: 6px;">
              <strong>Thanks — your feedback has been recorded.</strong>
            </div>
            <div style="font-size: 11px; color: var(--muted); font-family: ui-monospace, monospace; line-height: 1.8;">
              ${steps.map(s => `<div>→ ${s}</div>`).join("")}
              ${suggestion.reason ? `<div style="margin-top: 4px; color: var(--fg);"><strong>Reason:</strong> ${escapeHtml(suggestion.reason)}</div>` : ""}
              ${suggestion.reasoning ? `<div style="margin-top: 4px; color: var(--fg);"><strong>Analysis:</strong> ${escapeHtml(suggestion.reasoning)}</div>` : ""}
              ${suggestion.place_name ? `<div style="margin-top: 4px;"><strong>Current location:</strong> ${escapeHtml(suggestion.place_name)}</div>` : ""}
              <div style="margin-top: 6px; color: var(--accent);">Your feedback helps us improve — it may be applied after manual review.</div>
            </div>
            <div style="margin-top: 8px;">
              <button class="wrong-loc-dismiss-btn" style="background: transparent; color: var(--muted); border: 1px solid var(--muted); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 11px;">
                Dismiss
              </button>
            </div>
          `;

          showResult(resultHtml);

          // Add dismiss button listener
          const dismissBtn = resultDiv.querySelector(".wrong-loc-dismiss-btn");
          if (dismissBtn) {
            dismissBtn.addEventListener("click", () => {
              cancelWrongLocation();
            });
          }

          return;
        }

        showResult(resultHtml);
        return;
      }

      if (data.status === "failed") {
        showResult(`
          <strong style="color:#fca5a5">Evaluation failed</strong>
          <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">
            ${escapeHtml(data.error_message || "Unknown error")}
          </div>
        `);
        setTimeout(cancelWrongLocation, 4000);
        return;
      }

      // Still running - show progress with context-aware steps
      const elapsed = Math.round((Date.now() - t0) / 1000);
      let step = "Processing your suggestion…";
      if (hasClick && elapsed < 2) step = "Recording your map location…";
      else if (hasClick && elapsed < 5) step = "Validating coordinates…";
      else if (!hasClick && elapsed < 2) step = "Geocoding your location…";
      else if (!hasClick && elapsed < 5) step = "Looking up place name…";
      else if (elapsed < 8) step = "Moving pin to new location…";
      else step = "Finalizing changes…";
      showResult(`
        <div class="explore-status">
          <span class="explore-spinner"></span>
          ${escapeHtml(step)} <small>(${elapsed}s)</small>
        </div>
      `);
    } catch (_) {}
  }

  showResult(`
    <strong>Evaluation taking longer than expected.</strong>
    <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">
      You can close this — we'll continue processing in the background.
    </div>
  `);
  setTimeout(cancelWrongLocation, 4000);
}

function cancelWrongLocation() {
  if (!_wrongLoc) return;
  const { banner, btn, circle, keyHandler, handler } = _wrongLoc;
  if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
  if (circle) map.removeLayer(circle);
  document.getElementById("map")?.classList.remove("wrong-loc-cursor");
  if (keyHandler) document.removeEventListener("keydown", keyHandler);
  if (handler) map.off("click", handler);
  if (btn) { btn.disabled = false; btn.textContent = "🚩 Fix"; }
  _wrongLoc = null;
}

function formatRelativeTime(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  const delta = Date.now() - t;
  const m = Math.floor(delta / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function escapeHtml(s) {
  return String(s).replace(/<!\[CDATA\[|\]\]>/gi, "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Throttle, don't debounce. AbortController logic inside fetchPinsForViewport
// makes sure the actual rendering always reflects the latest viewport — the
// throttle just keeps us from issuing a new request for every single
// moveend frame during a continuous drag.
// Coalesce move + zoom into ONE fetch. zoomend fires its own event and
// would otherwise trigger a second refetch a few ms after the first
// (moveend from the zoom-induced reflow). Sharing one throttled fn
// makes the network do at most one request per quiet period, and the
// AbortController in fetchPinsForViewport cancels the in-flight call
// anyway so back-to-back pans are free.

// Wrap fetchPinsForViewport with end-to-end timing so we can see how
// fast the map actually feels after a pan/zoom. The perf object is
// stashed on globalThis so fetchPinsForViewport (defined elsewhere)
// can fill in fetch_start / fetch_end / render_end as it works, and
// we can ship a single performance event when the cycle completes.
//
// Timeline we want to capture:
//   move_end  →  fetch_start  →  fetch_end  →  render_end
//   ─────────   ────────────   ──────────   ───────────
//   (idle)     (request fired) (response)   (canvas painted)
const _mapPerf = {
  move_end: 0, fetch_start: 0, fetch_end: 0, render_end: 0,
  bbox: "", zoom: 0, source: "pins/map", aborted: false,
};
window._mapPerf = _mapPerf;

// THE TIME MACHINE calls this when the reader picks a past moment: the
// news drawn becomes the news OF THAT DAY.
window.reloadPins = () => reloadPins();
const reloadPins = throttle(() => {
  // If the boot coordinator is still settling or in flight, defer the
  // fetch to the coordinator (it waits for SETTLE_MS of silence and
  // then fires its own canonical fetch).  Once the coordinator is
  // done-ok or expired, behave exactly as before.
  if (window._bootCoord && (
    _bootCoord.state === "idle" ||
    _bootCoord.state === "settled-pending"
  )) {
    // Tag the moveend so the coordinator treats it as the boot motion.
    _bootCoord.isBootFetch = true;
    return;
  }
  _mapPerf.move_end = performance.now();
  _mapPerf.fetch_start = 0;
  _mapPerf.fetch_end = 0;
  _mapPerf.render_end = 0;
  _mapPerf.aborted = false;
  fetchPinsForViewport();
}, 250);

function _shipMapPerf() {
  const p = _mapPerf;
  if (!p.move_end) return; // nothing to ship — first load or aborted run
  if (p.aborted) return;
  const total = Math.round(p.render_end - p.move_end);
  const fetch = p.fetch_end && p.fetch_start ? Math.round(p.fetch_end - p.fetch_start) : 0;
  const render = p.render_end && p.fetch_end ? Math.round(p.render_end - p.fetch_end) : 0;
  // Cheap client-side telemetry — fire-and-forget so a slow analytics
  // insert never holds up the map. Capped at one event per second per
  // session via the global events/sec limiter in analytics.js.
  try {
    const sid = (typeof XyzoAnalytics !== "undefined" && XyzoAnalytics.sessionId)
      || (window.XyzoSession && window.XyzoSession()) || "anon";
    // Tier 1.2: each pan gets a fresh UUID so retries of the same
    // performance mark (network blip, devtools "replay", etc.) don't
    // double-count the timing in interactions_24h + source rankings.
    const idemKey = (crypto && crypto.randomUUID)
      ? `ievent:${crypto.randomUUID()}`
      : null;
    fetch("/api/analytics/log", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(idemKey ? { "X-Idempotency-Key": idemKey } : {}),
      },
      body: JSON.stringify({
        session_id: sid,
        type: "performance",
        map_lat: map.getCenter().lat,
        map_lng: map.getCenter().lng,
        map_zoom: Math.round(map.getZoom()),
        bbox: p.bbox,
        metadata: {
          kind: "map_pan",
          total_ms: total,
          fetch_ms: fetch,
          render_ms: render,
          source: p.source,
          zoom: p.zoom,
        },
      }),
    }).catch(() => {});
  } catch (_) {}
  p.move_end = 0; // one-shot per pan
}
window._shipMapPerf = _shipMapPerf;

map.on("moveend", reloadPins);
map.on("zoomend", reloadPins);
map.on("moveend", throttle(renderLinks, 200));
map.on("zoomend", throttle(renderLinks, 200));
// Ship the initial load's perf too so the first-paint timing shows up.
map.once("moveend", () => setTimeout(_shipMapPerf, 0));

// ── Boot-fetch coordinator ────────────────────────────────────────────
//
// ╔════════════════════════════════════════════════════════════════╗
// ║  DO NOT REMOVE OR SIMPLIFY THIS BLOCK WITHOUT READING FIRST   ║
// ║                                                                ║
// ║  This state machine defends against a boot-fetch race that     ║
// ║  otherwise produces empty maps on reload / address-bar typing. ║
// ║                                                                ║
// ║  See docs/boot-fetch-race-postmortem.md for the full story,    ║
// ║  state diagram, and the "Prevention" rules at the bottom.      ║
// ║                                                                ║
// ║  Companion fix: fixMapPositionIfLeafletClobbered() above for   ║
// ║  the canvas-vs-CSS race.  See docs/canvas-race-condition-       ║
// ║  postmortem.md for that one.                                   ║
// ║                                                                ║
// ║  Tests: tests/canvas-race-condition.test.js                   ║
// ║         tests/test_boot_fetch_coordinator.py                   ║
// ╚════════════════════════════════════════════════════════════════╝
//
// Race-condition root cause (called out in AGENTS.md and in the inline
// comments scattered through fetchPinsForViewport):
//   1. restoreMapView() at the bottom of this file fires map.setView()
//      which triggers moveend → reloadPins() → fetchPinsForViewport().
//   2. map.whenReady() below fires another fetchPinsForViewport() as
//      a safety net.
//   3. The URL-hash restore, time-filter restore, mode-toggle logic
//      and the pagehide/page-show path all call fetchPinsForViewport()
//      too, almost simultaneously.
//   4. fetchPinsForViewport() aborts any in-flight request on every
//      call. Whichever call wins the race is the one whose response
//      gets applied. If that winner lands on a transitional bbox
//      (mid-animation, mid-resize), the API returns 0 pins and the
//      user sees an empty map with no automatic retry until they
//      manually pan or zoom.
//
// This coordinator:
//   - Lets the map genuinely settle (no move/zoom for SETTLE_MS)
//     before firing the canonical boot fetch — even if a moveend
//     handler has already triggered one, we suppress it and fire our
//     own once the view is stable.
//   - Tracks whether the first fetch delivered any pins. If it
//     returned 0 pins within BOOT_GRACE_MS of page load, fires one
//     automatic retry after RETRY_MS. If the retry also returns 0,
//     gives up cleanly (the user can pan to manually retry).
//   - Does NOT interfere with normal post-boot pan/zoom behaviour.
//     Once the boot fetch completes successfully (or the grace
//     window expires), the coordinator becomes inert.
//
// Exposed on window.__xyzoBootCoordinator for diagnostics — visible
// in the debug packet via __xyzoFetchDiagnostics() if needed.

const SETTLE_MS = 250;       // wait this long without moveend/zoomend
const BOOT_GRACE_MS = 5000;  // window after page load to retry empty results
const BOOT_RETRY_MS = 500;   // delay between first empty result and retry

const _bootCoord = {
  startedAt: performance.now(),
  state: "idle",          // idle | settled-pending | in-flight | done-ok | done-empty | done-retry | expired
  moveTimer: null,
  retryTimer: null,
  expireTimer: null,
  pinCount: 0,
  isBootFetch: false,     // true for the canonical fetch we coordinate
};

window._bootCoord = _bootCoord;

function _bootCoordCancelTimers() {
  if (_bootCoord.moveTimer) { clearTimeout(_bootCoord.moveTimer); _bootCoord.moveTimer = null; }
  if (_bootCoord.retryTimer) { clearTimeout(_bootCoord.retryTimer); _bootCoord.retryTimer = null; }
}

function _bootCoordMarkSettled() {
  // Called from moveend/zoomend handlers via a thin wrapper.  Resets
  // the settle timer; fires the canonical fetch once SETTLE_MS of
  // silence has elapsed.  Goes through reloadPins() (not directly
  // through fetchPinsForViewport) so it's throttled identically to
  // user-driven pans, preventing two simultaneous fetches.
  if (_bootCoord.state !== "idle" && _bootCoord.state !== "settled-pending") return;
  if (_bootCoord.state === "idle") _bootCoord.state = "settled-pending";
  if (_bootCoord.moveTimer) clearTimeout(_bootCoord.moveTimer);
  _bootCoord.moveTimer = setTimeout(() => {
    _bootCoord.moveTimer = null;
    if (_bootCoord.state !== "settled-pending") return;
    _bootCoord.state = "in-flight";
    _bootCoord.isBootFetch = true;
    if (typeof reloadPins === "function") reloadPins();
    else fetchPinsForViewport();
  }, SETTLE_MS);
}

// Expire the boot coordinator after BOOT_GRACE_MS so we stop
// caring about retries regardless of what happened.
setTimeout(() => {
  if (_bootCoord.state !== "done-ok") {
    _bootCoord.state = "expired";
  }
  _bootCoordCancelTimers();
}, BOOT_GRACE_MS);

// Called from fetchPinsForViewport after a successful setPins.
// Lets the coordinator decide whether to retry empty results.
window._bootFetchComplete = function _bootFetchComplete(count, ctrl) {
  if (!_bootCoord.isBootFetch) return;
  _bootCoord.isBootFetch = false;
  _bootCoord.pinCount = count;
  // Late-arriving success: the response came back AFTER the 5s grace
  // period expired.  The user-facing setPins() already ran (pins are
  // drawn), so update state to done-ok anyway so the diagnostic is
  // accurate.  Without this, _bootCoord.state would lie forever.
  if (count > 0) {
    _bootCoord.state = "done-ok";
    return;
  }
  // If grace expired and we got an empty result, the retry is moot —
  // we're past the boot window.  Mark gave-up for diagnostics.
  if (_bootCoord.state === "expired") {
    _bootCoord.state = "done-empty-gave-up";
    return;
  }
  // If a retry has already fired and still returned 0 pins, give up
  // cleanly.  Without this guard we'd schedule an infinite retry
  // chain every 500ms — the user explicitly asked for ONE retry.
  if (_bootCoord.state === "done-retry") {
    _bootCoord.state = "done-empty-gave-up";
    return;
  }
  _bootCoord.state = "done-empty";
  // Schedule a single retry.  If the user pans/zooms in the meantime,
  // the moveend handler will fire a regular fetch and the retry is
  // cancelled by _bootCoordCancelTimers via the moveend path below.
  _bootCoord.retryTimer = setTimeout(() => {
    _bootCoord.retryTimer = null;
    if (_bootCoord.state !== "done-empty") return;
    _bootCoord.state = "done-retry";
    _bootCoord.isBootFetch = true;
    if (typeof reloadPins === "function") reloadPins();
    else fetchPinsForViewport();
  }, BOOT_RETRY_MS);
};

// Hook the coordinator into move/zoom events.  Wrappers cancel any
// pending retry and re-arm the settle timer on each new motion.
// Without this, an empty retry could fire AFTER the user has already
// panned (which would feel like a phantom re-fetch).  Once the boot
// fetch resolves successfully (state === "done-ok" or "expired"),
// these wrappers become no-ops and behaviour is exactly as before.
map.on("movestart", () => {
  if (_bootCoord.state === "done-ok" || _bootCoord.state === "expired") return;
  _bootCoordCancelTimers();
  _bootCoord.state = "idle";
});
map.on("moveend", () => {
  if (_bootCoord.state === "done-ok" || _bootCoord.state === "expired") return;
  _bootCoordMarkSettled();
});
map.on("zoomend", () => {
  if (_bootCoord.state === "done-ok" || _bootCoord.state === "expired") return;
  _bootCoordMarkSettled();
});

// ── Initial pin fetch — safety net for first load ──────────────────────
// The boot guard inside fetchPinsForViewport handles the main case.
// This is a fallback: if the map still isn't ready after 1 second
// (e.g. a very slow layout), try once more.
map.whenReady(() => {
  // If the coordinator already armed the canonical fetch (because
  // moveend fired before whenReady), let it run.  Otherwise arm it
  // ourselves so we don't end up with two parallel fetches.
  setTimeout(() => {
    if (_bootCoord.state === "in-flight" || _bootCoord.state === "done-ok" ||
        _bootCoord.state === "done-empty" || _bootCoord.state === "done-retry" ||
        _bootCoord.state === "expired") return;
    if (window._xyzoMapReady) {
      // Map is ready but no moveend has fired yet — arm the settle
      // timer so we still get a canonical fetch (the world-view default
      // doesn't always emit moveend if it's identical to the initial
      // view).
      _bootCoordMarkSettled();
    }
    // Removed the original "fetchPinsForViewport() safety net" branch
    // — it raced with the coordinator and made the empty-map bug worse.
    // The coordinator now owns the entire boot fetch lifecycle.
  }, 1000);
});

// ── bfcache restore: re-fetch pins when page is restored from cache ───
// When the user types the URL again (or hits back), the browser may
// restore the page from the back-forward cache (bfcache).  The DOM is
// preserved but all JavaScript state is stale — the canvas exists but
// _draw() never re-ran, so pins are invisible.  Detect this via the
// pageshow event's `persisted` flag and force a full re-fetch.
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return; // normal load, not bfcache
  XLog.warn("[bfcache] page restored from cache — re-fetching pins");
  // Reset the ready flag so the boot guard allows a fresh fetch
  window._xyzoMapReady = false;
  window._xyzoBootUnready = 0;
  // Invalidate the canvas state so it gets a clean re-draw
  if (typeof canvasRenderer !== "undefined" && canvasRenderer) {
    canvasRenderer._drawRetries = 0;
  }
  fetchPinsForViewport();
});

// ── pagehide: invalidate canvas before bfcache captures the page ─────
// When the browser caches this page, the canvas's JavaScript-drawn
// content (width/height attributes, pin data) is lost.  Clear the
// state so that if the page is restored from bfcache, the pageshow
// handler above starts fresh rather than trying to work with stale data.
window.addEventListener("pagehide", () => {
  window._xyzoMapReady = false;
});

// ── Auto-discover news for empty areas ──────────────────────────────────
// When a user zooms into an area with few pins, automatically discover
// and add news sources for that region.
let _autoDiscoverTimer = null;
let _lastDiscoverBbox = null;
const AUTO_DISCOVER_THRESHOLD = 5; // Trigger if fewer than 5 pins visible
const AUTO_DISCOVER_ZOOM_MIN = 6;  // Only at city/region level
const AUTO_DISCOVER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minute cooldown per area
// bbox → timestamp of last completion. Bounded by pruneDiscoverCooldowns()
// which runs opportunistically before each check and on a periodic 5-min
// interval. Without pruning, every distinct area the user panned through
// (rounded to 0.01° ≈ 1.1 km) accumulated an entry that was never reaped,
// causing unbounded memory growth on long sessions.
const _discoverCooldowns = new Map();

// Drop cooldown entries older than AUTO_DISCOVER_COOLDOWN_MS — they have no
// effect after the cooldown window anyway, so they're pure memory cost.
function pruneDiscoverCooldowns() {
  const cutoff = Date.now() - AUTO_DISCOVER_COOLDOWN_MS;
  for (const [key, ts] of _discoverCooldowns) {
    if (ts < cutoff) _discoverCooldowns.delete(key);
  }
}

// Periodic background prune every 5 minutes. Cheap (Map scan) and keeps
// long-idle sessions from accumulating entries between explicit checks.
let _discoverCooldownsPruneTimer = null;
function startDiscoverCooldownsPruneTimer() {
  if (_discoverCooldownsPruneTimer) return;
  _discoverCooldownsPruneTimer = setInterval(pruneDiscoverCooldowns, 5 * 60 * 1000);
}

// Population thresholds for auto-discovery
const AUTO_DISCOVER_MIN_POPULATION = 100000; // Need at least 100k city in view
const AUTO_DISCOVER_MIN_CITIES = 1;          // At least 1 city with population

function checkAutoDiscover() {
  if (_autoDiscoverTimer) clearTimeout(_autoDiscoverTimer);

  // Opportunistic prune — runs before every check, so even on a long
  // session with no movement the map size stays bounded.
  pruneDiscoverCooldowns();
  // Start the periodic background prune on the first check. setInterval
  // returns immediately; subsequent checks see the timer and no-op.
  startDiscoverCooldownsPruneTimer();

  _autoDiscoverTimer = setTimeout(async () => {
    const zoom = map.getZoom();
    if (zoom < AUTO_DISCOVER_ZOOM_MIN) return;

    // Don't run if a discovery is currently in progress
    if (_currentDiscoveryRequestId) return;

    // Count visible pins (canvas renderer or DOM markers)
    let visiblePinCount = 0;
    const curBounds = map.getBounds();
    if (typeof canvasRenderer !== "undefined" && canvasRenderer && canvasRenderer._enabled && Array.isArray(canvasRenderer._pins)) {
      for (const p of canvasRenderer._pins) {
        const lat = p.location?.lat ?? p.lat;
        const lng = p.location?.lng ?? p.lng;
        if (typeof lat === "number" && typeof lng === "number" && curBounds.contains([lat, lng])) {
          visiblePinCount++;
        }
      }
    } else {
      visiblePinCount = Array.from(pinMarkers.values()).filter(m => {
        return curBounds.contains(m.getLatLng());
      }).length;
    }

    if (visiblePinCount >= AUTO_DISCOVER_THRESHOLD) return;

    // Check if this is a populated area using CityEngine
    // Don't auto-trigger for rural/unpopulated areas
    if (window.CityEngine && window.CityEngine.isLoaded()) {
      const center = map.getCenter();
      const bounds = map.getBounds();
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();

      // Check if any major cities exist in the viewport
      let hasPopulatedCity = false;
      let maxPop = 0;

      // Sample a few points in the viewport to find cities
      const samplePoints = [
        [center.lat, center.lng],
        [ne.lat, ne.lng],
        [sw.lat, sw.lng],
        [ne.lat, sw.lng],
        [sw.lat, ne.lng],
      ];

      for (const [lat, lng] of samplePoints) {
        const cities = window.CityEngine.citiesNear(lat, lng, 200, 1);
        const city = cities[0];
        if (city && city.p >= AUTO_DISCOVER_MIN_POPULATION) {
          hasPopulatedCity = true;
          maxPop = Math.max(maxPop, city.p);
        }
      }

      // Skip auto-discovery for rural areas
      if (!hasPopulatedCity) {
        XLog.log(`[auto-discover] Skipping rural area (max population nearby: ${maxPop})`);
        return;
      }
    }

    // Build bbox string (rounded to reduce unique keys)
    const b = map.getBounds();
    const bbox = [
      b.getWest().toFixed(2),
      b.getSouth().toFixed(2),
      b.getEast().toFixed(2),
      b.getNorth().toFixed(2),
    ].join(",");

    // Don't re-discover the same area
    if (bbox === _lastDiscoverBbox) return;

    // Check cooldown — don't re-trigger if we just completed for this area
    const lastRun = _discoverCooldowns.get(bbox);
    if (lastRun && (Date.now() - lastRun) < AUTO_DISCOVER_COOLDOWN_MS) return;

    _lastDiscoverBbox = bbox;

    const center = map.getCenter();
    const sessionId = typeof XyzoAnalytics !== 'undefined' ? XyzoAnalytics.sessionId : null;

    XLog.log(`[auto-discover] Low pin count (${visiblePinCount}) at zoom ${zoom}. Discovering news...`);

    try {
      const res = await fetch('/api/auto-discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bbox,
          center_lat: center.lat,
          center_lng: center.lng,
          map_zoom: zoom,
          session_id: sessionId,
        }),
      });

      if (!res.ok) return;

      const data = await res.json();
      XLog.log('[auto-discover] Response:', data);

      if (data.discovery_triggered) {
        // Show a notification to the user
        showAutoDiscoverNotification(data.message, data.request_id, data.job_id);

        // Set cooldown for this area so we don't re-trigger
        _discoverCooldowns.set(_lastDiscoverBbox, Date.now());

        // Refresh pins after a delay to pick up new sources
        setTimeout(() => {
          _lastDiscoverBbox = null; // Allow re-check after cooldown
          fetchPinsForViewport();
        }, 15000); // 15 seconds
      }
    } catch (e) {
      XLog.debug('[auto-discover] Failed:', e);
    }
  }, 3000); // 3 second debounce
}

// ── Live Discovery Status Panel ──────────────────────────────────────────
// Shows real-time updates when AI is discovering news sources for an area.
let _statusPanel = null;
let _statusPolling = null;
let _currentDiscoveryRequestId = null;

function createStatusPanel() {
  if (_statusPanel) {
    // If panel was hidden by closeStatusPanel, DON'T re-show it.
    // The user explicitly closed it — polling continues in background,
    // but the panel stays hidden until they click the reopen button.
    return _statusPanel;
  }

  const panel = document.createElement('div');
  panel.id = 'discovery-status-panel';
  panel.innerHTML = `
    <div class="status-panel-header">
      <div class="status-panel-title">
        <span class="status-panel-icon">🔍</span>
        <span>AI News Discovery</span>
      </div>
      <div style="display:flex;gap:4px;align-items:center;">
        <button class="status-panel-cancel" onclick="cancelDiscovery()" aria-label="Cancel discovery" title="Stop discovery">Cancel</button>
        <button class="status-panel-close" onclick="closeStatusPanel()" aria-label="Close panel" title="Close (keeps running)">×</button>
      </div>
    </div>
    <div class="status-panel-body">
      <div class="status-panel-location" id="status-panel-location"></div>
      <div class="status-panel-steps" id="status-panel-steps"></div>
      <div class="status-panel-progress">
        <div class="status-panel-progress-bar" id="status-panel-progress-bar"></div>
      </div>
      <div class="status-panel-summary" id="status-panel-summary"></div>
    </div>
  `;

  document.body.appendChild(panel);
  _statusPanel = panel;

  // Add styles if not already added
  if (!document.getElementById('status-panel-styles')) {
    const style = document.createElement('style');
    style.id = 'status-panel-styles';
    style.textContent = `
      @keyframes slideInRight {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes slideOutRight {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      #discovery-status-panel {
        position: fixed;
        top: calc(var(--top-band) + 44px);
        right: 12px;
        width: 340px;
        max-height: calc(100vh - var(--top-band) - var(--bottom-band) - 44px);
        background: rgba(11, 15, 20, 0.95);
        border: 1px solid rgba(94, 234, 212, 0.2);
        border-radius: 12px;
        z-index: 9999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(94, 234, 212, 0.1);
        backdrop-filter: blur(20px);
        animation: slideInRight 0.3s ease-out;
        overflow: hidden;
      }

      #discovery-status-panel.closing {
        animation: slideOutRight 0.3s ease-out forwards;
      }

      .status-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        border-bottom: 1px solid rgba(94, 234, 212, 0.15);
        background: rgba(94, 234, 212, 0.05);
      }

      .status-panel-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 14px;
        font-weight: 600;
        color: var(--accent);
      }

      .status-panel-icon {
        font-size: 18px;
        animation: pulse 2s infinite;
      }

      .status-panel-close {
        background: transparent;
        border: none;
        color: var(--muted);
        font-size: 20px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        transition: all 0.15s;
        line-height: 1;
      }

      .status-panel-close:hover {
        color: var(--fg);
        background: rgba(255, 255, 255, 0.1);
      }

      .status-panel-cancel {
        background: transparent;
        border: 1px solid rgba(239, 68, 68, 0.3);
        color: #ef4444;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        padding: 3px 10px;
        border-radius: 4px;
        transition: all 0.15s;
        font-family: ui-monospace, monospace;
      }

      .status-panel-cancel:hover {
        background: rgba(239, 68, 68, 0.15);
        border-color: #ef4444;
      }

      .status-panel-body {
        padding: 16px;
        max-height: 400px;
        overflow-y: auto;
      }

      .status-panel-location {
        font-size: 12px;
        color: var(--muted);
        margin-bottom: 12px;
        padding: 8px;
        background: rgba(0, 0, 0, 0.3);
        border-radius: 6px;
        font-family: ui-monospace, monospace;
      }

      .status-panel-steps {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 12px;
      }

      .status-step {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 8px;
        border-radius: 6px;
        font-size: 12px;
        transition: all 0.2s;
      }

      .status-step.active {
        background: rgba(94, 234, 212, 0.08);
        border: 1px solid rgba(94, 234, 212, 0.2);
      }

      .status-step.completed {
        opacity: 0.7;
      }

      .status-step.pending {
        opacity: 0.4;
      }

      .status-step-icon {
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        font-size: 14px;
      }

      .status-step-icon .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(94, 234, 212, 0.3);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      .status-step-content {
        flex: 1;
      }

      .status-step-title {
        font-weight: 500;
        color: var(--fg);
        margin-bottom: 2px;
      }

      .status-step-detail {
        font-size: 11px;
        color: var(--muted);
        font-family: ui-monospace, monospace;
      }

      .status-panel-progress {
        height: 4px;
        background: rgba(94, 234, 212, 0.1);
        border-radius: 2px;
        margin-bottom: 12px;
        overflow: hidden;
      }

      .status-panel-progress-bar {
        height: 100%;
        background: linear-gradient(90deg, var(--accent), #a78bfa);
        border-radius: 2px;
        transition: width 0.5s ease;
        width: 0%;
      }

      .status-panel-summary {
        font-size: 11px;
        color: var(--muted);
        padding: 8px;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 6px;
        display: none;
      }

      .status-panel-summary.visible {
        display: block;
      }

      .status-panel-summary .success {
        color: #22c55e;
      }

      .status-panel-summary .warning {
        color: #f59e0b;
      }
    `;
    document.head.appendChild(style);
  }

  return panel;
}

function updateStatusPanel(step, detail, progress) {
  const panel = createStatusPanel();
  const stepsEl = panel.querySelector('#status-panel-steps');
  const progressBar = panel.querySelector('#status-panel-progress-bar');
  const locationEl = panel.querySelector('#status-panel-location');

  // Define all steps. The worker writes step ids from the explore_region +
  // run pipeline; this list has to cover all of them so the panel can light
  // up the right row. Anything not in here falls back to "active" on the
  // last matched row.
  const allSteps = [
    { id: 'init',        icon: '🚀', title: 'Starting' },
    { id: 'detect',      icon: '📍', title: 'Detecting area' },
    { id: 'cities',      icon: '🏙️', title: 'Finding cities' },
    { id: 'countries',   icon: '🌍', title: 'Identifying countries' },
    { id: 'search',      icon: '🔎', title: 'Searching existing news' },
    { id: 'discover',    icon: '🤖', title: 'AI discovering sources' },
    { id: 'validate',    icon: '✅', title: 'Validating RSS feeds' },
    { id: 'add',         icon: '➕', title: 'Adding sources' },
    { id: 'fetch',       icon: '📰', title: 'Fetching articles' },
    { id: 'auto_categorize', icon: '⚡', title: 'Fast text parsing' },
    { id: 'extract',     icon: '🧠', title: 'AI extracting articles' },
    { id: 'geocode',     icon: '📌', title: 'Geocoding articles' },
    { id: 'cluster',     icon: '🔗', title: 'Clustering events' },
    { id: 'complete',    icon: '✨', title: 'Complete!' },
  ];

  // Some worker step ids (e.g. discover_complete) aren't a "row" of their
  // own — treat them as the last matching bucket so the panel still
  // highlights something sensible.
  let currentIndex = allSteps.findIndex(s => s.id === step);
  if (currentIndex < 0) {
    if (step === 'discover_complete') currentIndex = allSteps.findIndex(s => s.id === 'discover');
    else if (step === 'failed')        currentIndex = allSteps.findIndex(s => s.id === 'complete');
    if (currentIndex < 0) {
      // Unknown id — leave steps as-is but suppress "active" highlight
      currentIndex = -1;
    }
  }

  // Update steps
  stepsEl.innerHTML = allSteps.map((s, i) => {
    const status = i < currentIndex ? 'completed' : i === currentIndex ? 'active' : 'pending';
    const isComplete = step === 'complete';
    const icon = status === 'completed' ? '✓' :
                 (status === 'active' && !isComplete) ? '<div class="spinner"></div>' :
                 isComplete && status === 'active' ? '✓' : '○';
    return `
      <div class="status-step ${status}">
        <div class="status-step-icon">${status === 'active' && !isComplete ? icon : s.icon}</div>
        <div class="status-step-content">
          <div class="status-step-title">${s.title}</div>
          ${status === 'active' && detail && !isComplete ? `<div class="status-step-detail">${escapeHtml(detail)}</div>` : ''}
          ${status === 'completed' || (status === 'active' && isComplete) ? '<div class="status-step-detail" style="color: #5eead4;">Done</div>' : ''}
        </div>
      </div>
    `;
  }).join('');

  // Update progress bar
  if (progress !== undefined) {
    progressBar.style.width = `${progress}%`;
  } else {
    progressBar.style.width = `${((currentIndex + 1) / allSteps.length) * 100}%`;
  }
}

function updateStatusLocation(text) {
  const locationEl = document.getElementById('status-panel-location');
  if (locationEl) locationEl.textContent = text;
}

function updateStatusSummary(html, type = 'info') {
  const summaryEl = document.getElementById('status-panel-summary');
  if (summaryEl) {
    summaryEl.innerHTML = html;
    summaryEl.classList.add('visible');
  }
}

function closeStatusPanel() {
  if (!_statusPanel) return;

  // Just hide the panel — discovery keeps running in background
  _statusPanel.style.display = 'none';
  _statusPanel.classList.remove('closing');

  // Show a small reopen button so the user can check on progress.
  showStatusReopenButton();
}

// Cancel a running discovery (separate from closing the panel)
function cancelDiscovery() {
  if (!_currentDiscoveryRequestId) return;
  if (!confirm('Cancel the running discovery? This will stop all progress.')) return;

  fetch(`/api/discovery-cancel/${_currentDiscoveryRequestId}`, { method: 'POST' })
    .then(() => {
      _currentDiscoveryRequestId = null;
      if (_statusPolling) {
        clearInterval(_statusPolling);
        _statusPolling = null;
      }
      updateStatusPanel('complete', 'Discovery was cancelled', 100);
      updateStatusSummary('<span style="color: var(--muted);">Discovery cancelled by user.</span>', 'info');
    })
    .catch(() => {});
}

function showStatusReopenButton() {
  if (document.getElementById('status-panel-reopen')) return;
  const btn = document.createElement('button');
  btn.id = 'status-panel-reopen';
  btn.title = 'Show AI Discovery status';
  btn.innerHTML = '🔍';
  const isRunning = !!_currentDiscoveryRequestId;
  btn.style.cssText = `
    position: fixed; top: calc(var(--top-band) + 44px); right: 12px; z-index: 9998;
    width: 36px; height: 36px; border-radius: 50%;
    background: rgba(11, 15, 20, 0.92); color: var(--accent);
    border: 1px solid ${isRunning ? 'rgba(94, 234, 212, 0.6)' : 'rgba(94, 234, 212, 0.3)'};
    font-size: 16px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(8px);
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    transition: all 0.15s;
    ${isRunning ? 'animation: pulse-reopen 2s infinite;' : ''}
  `;
  btn.addEventListener('click', () => {
    if (_statusPanel) {
      _statusPanel.style.display = '';
    }
    btn.remove();
  });
  btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(94,234,212,0.15)'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(11,15,20,0.92)'; });
  document.body.appendChild(btn);
}

function hideStatusReopenButton() {
  const btn = document.getElementById('status-panel-reopen');
  if (btn) btn.remove();
}

function pollDiscoveryStatus(requestId) {
  let pollCount = 0;
  const maxPolls = 90; // 90 polls * 2 seconds = 3 minutes max
  let lastSeenArticleCount = 0;
  let lastSeenSourceCount = 0;

  // Reset rolling-window state for this run — a fresh request gets a
  // fresh marker window. (clearLiveDiscoveryPins also clears the FIFO
  // eviction Maps and the dedupe Sets.)
  clearLiveDiscoveryPins();

  _statusPolling = setInterval(async () => {
    pollCount++;
    if (pollCount > maxPolls) {
      clearInterval(_statusPolling);
      _statusPolling = null;
      updateStatusSummary('Discovery is taking longer than expected. Check back later.', 'warning');
      return;
    }

    try {
      const res = await fetch(`/api/discovery-status/${requestId}`);
      // 404 = the server has no record of this id (e.g., legacy
      // auto-discover with a stale numeric id, or the worker already
      // finished and the queue row was swept). Stop polling rather than
      // hammering the endpoint at 2 s intervals.
      if (res.status === 404) {
        clearInterval(_statusPolling);
        _statusPolling = null;
        _currentDiscoveryRequestId = null;
        return;
      }
      if (!res.ok) return;

      const data = await res.json();

      // Update the panel with real-time status
      if (data.current_step) {
        updateStatusPanel(data.current_step, data.step_detail, data.progress);
      }

      // Update location info with elapsed time and counters
      if (data.center) {
        const counterParts = [];
        if (data.counters) {
          if (data.counters.articles_fetched > 0) counterParts.push(`${data.counters.articles_fetched} fetched`);
          if (data.counters.articles_extracted > 0) counterParts.push(`${data.counters.articles_extracted} extracted`);
          if (data.counters.sources_added > 0) counterParts.push(`${data.counters.sources_added} sources`);
        }
        const counterStr = counterParts.length ? ` • ${counterParts.join(', ')}` : '';
        updateStatusLocation(`📍 ${data.center.lat.toFixed(2)}°, ${data.center.lng.toFixed(2)}° • ${data.elapsed_seconds}s elapsed${counterStr}`);
      }

      // ── Live marker streaming ────────────────────────────────────────
      // Each poll tick the worker has pushed 0..N newly extracted /
      // geocoded articles into the live status file. Diff against our
      // dedupe Sets and drop a marker for any new entry. The map enforces
      // a FIFO cap of MAX_LIVE_ARTICLE_PINS so a 300-article run can't
      // pile 300 DOM nodes onto the canvas.
      if (Array.isArray(data.recent_articles)) {
        let dropped = 0;
        for (const a of data.recent_articles) {
          if (!a || a.id == null) continue;
          if (_liveSeenArticleIds.has(a.id)) continue;
          const before = _liveDiscoveryArticlePins.size;
          addLiveArticleMarker(a);
          if (_liveDiscoveryArticlePins.size > before) dropped++;
        }
        if (dropped > 0) _flashLivePinCounter();
      }

      // Update summary with stats — show running totals AND a count of
      // currently-on-map live pins so the user understands why older
      // articles might be missing (rolling window).
      const livePinsShown = _liveDiscoveryArticlePins.size;
      const summaries = [];
      if (data.sources_added > 0 || lastSeenSourceCount > 0) {
        summaries.push(`<div><strong>${data.sources_added}</strong> sources added</div>`);
      }
      if (data.articles_fetched > 0 || lastSeenArticleCount > 0) {
        summaries.push(`<div><strong>${data.articles_fetched}</strong> articles fetched</div>`);
      }
      if (livePinsShown > 0) {
        summaries.push(`<div><strong>${livePinsShown}</strong> live pins on map</div>`);
      }
      // Show recent sources being validated/added
      if (Array.isArray(data.recent_sources) && data.recent_sources.length > 0) {
        const latest = data.recent_sources[0];
        summaries.push(`<div style="color: var(--muted); font-size: 11px;">Latest: ${escapeHtml(latest.name || 'unknown')} (${latest.country || '?'})</div>`);
      }
      if (summaries.length) {
        updateStatusSummary(`<div style="display: flex; gap: 16px; flex-wrap: wrap;">${summaries.join("")}</div>`);
      }
      lastSeenArticleCount = data.articles_fetched || 0;
      lastSeenSourceCount = data.sources_added || 0;

      if (data.status === 'completed') {
        clearInterval(_statusPolling);
        _statusPolling = null;
        updateStatusPanel('complete', 'Discovery finished!', 100);

        // Fetch detailed results for the summary
        const requestId = _currentDiscoveryRequestId;
        _currentDiscoveryRequestId = null;

        // Build detailed summary
        let detailHtml = `<span class="success">✓ Discovery complete!</span>`;

        // Fetch final status with all details
        try {
          const detailRes = await fetch(`/api/discovery-status/${requestId}`);
          if (detailRes.ok) {
            const detail = await detailRes.json();

            // Sources summary
            detailHtml += `
              <div style="margin-top:8px;padding:8px;background:rgba(94,234,212,0.05);border:1px solid rgba(94,234,212,0.15);border-radius:4px;">
                <div style="font-weight:600;color:var(--accent);margin-bottom:4px;">📊 Discovery Results</div>
                <div style="font-size:11px;line-height:1.6;">
                  <strong>${detail.sources_added || 0}</strong> new sources added<br>
                  <strong>${detail.articles_fetched || 0}</strong> articles fetched<br>
                  <strong>${detail.elapsed_seconds || 0}s</strong> total time
                </div>
              </div>
            `;

            // Recent sources discovered
            if (detail.recent_sources?.length > 0) {
              detailHtml += `
                <div style="margin-top:8px;">
                  <div style="font-size:11px;font-weight:600;color:var(--fg);margin-bottom:4px;">Sources Added:</div>
                  ${detail.recent_sources.slice(0, 8).map(s => `
                    <div style="font-size:10px;color:var(--muted);padding:2px 0;border-bottom:1px solid rgba(31,41,55,0.3);">
                      📰 <strong style="color:var(--fg);">${escapeHtml(s.name || '?')}</strong>
                      <span style="color:var(--muted);">(${escapeHtml(s.country || '?')})</span>
                      ${s.lat ? `<span style="font-size:9px;">📍 ${s.lat?.toFixed(2)}, ${s.lng?.toFixed(2)}</span>` : ''}
                    </div>
                  `).join('')}
                  ${detail.recent_sources.length > 8 ? `<div style="font-size:9px;color:var(--muted);padding:2px 0;">+${detail.recent_sources.length - 8} more sources</div>` : ''}
                </div>
              `;
            }

            // Recent articles fetched
            if (detail.recent_articles?.length > 0) {
              detailHtml += `
                <div style="margin-top:8px;">
                  <div style="font-size:11px;font-weight:600;color:var(--fg);margin-bottom:4px;">Articles Fetched:</div>
                  ${detail.recent_articles.slice(0, 6).map(a => `
                    <div style="font-size:10px;color:var(--muted);padding:2px 0;border-bottom:1px solid rgba(31,41,55,0.3);">
                      📄 ${escapeHtml((a.title || '?').slice(0, 60))}${(a.title?.length || 0) > 60 ? '…' : ''}
                      ${a.category ? `<span style="background:${EVENT_COLORS[a.category] || '#64748b'}22;color:${EVENT_COLORS[a.category] || '#64748b'};padding:0 4px;border-radius:2px;font-size:9px;">${a.category}</span>` : ''}
                      ${a.place ? `<span style="font-size:9px;">📍 ${escapeHtml(a.place)}</span>` : ''}
                    </div>
                  `).join('')}
                  ${detail.recent_articles.length > 6 ? `<div style="font-size:9px;color:var(--muted);padding:2px 0;">+${detail.recent_articles.length - 6} more articles</div>` : ''}
                </div>
              `;
            }

            // Geolocation stats from counters
            if (detail.counters) {
              const c = detail.counters;
              detailHtml += `
                <div style="margin-top:8px;padding:6px;background:rgba(0,0,0,0.2);border-radius:4px;">
                  <div style="font-size:10px;font-weight:600;color:var(--fg);margin-bottom:2px;">Pipeline Stats:</div>
                  <div style="font-size:10px;color:var(--muted);line-height:1.6;">
                    ${c.articles_fetched ? `📥 ${c.articles_fetched} fetched` : ''}
                    ${c.articles_extracted ? ` · 🧠 ${c.articles_extracted} extracted` : ''}
                    ${c.articles_geocoded ? ` · 📍 ${c.articles_geocoded} geocoded` : ''}
                    ${c.sources_added ? ` · 📰 ${c.sources_added} sources added` : ''}
                    ${c.sources_geocoded ? ` · 🌍 ${c.sources_geocoded} sources geocoded` : ''}
                  </div>
                </div>
              `;
            }

            // Location info
            if (detail.center) {
              detailHtml += `
                <div style="margin-top:6px;font-size:10px;color:var(--muted);">
                  📍 Area: ${detail.center.lat?.toFixed(4)}, ${detail.center.lng?.toFixed(4)} · Zoom ${detail.map_zoom || '?'}
                </div>
              `;
            }
          }
        } catch (e) {
          // Fallback to basic summary
          detailHtml += `
            <div style="margin-top:4px;">Found <strong>${data.sources_added || 0}</strong> new sources and <strong>${data.articles_fetched || 0}</strong> articles.</div>
          `;
        }

        // Action buttons
        detailHtml += `
          <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">
            <button id="highlight-new-btn" style="background:rgba(94,234,212,0.1);border:1px solid var(--accent);color:var(--accent);padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer;">Highlight New</button>
            <button onclick="fetchPinsForViewport()" style="background:rgba(94,234,212,0.1);border:1px solid var(--accent);color:var(--accent);padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer;">Refresh Map</button>
          </div>
        `;

        updateStatusSummary(detailHtml, 'success');

        // Drop the rolling-window pins — the proper event-clustered
        // marker set will be fetched and rendered below.
        clearLiveDiscoveryPins();

        // Don't auto-close — let the user dismiss when ready.
        // Show a reopen button if they close it manually.
        hideStatusReopenButton();

        // Refresh pins
        setTimeout(() => {
          // Set cooldown so moving the map doesn't re-trigger discovery
          if (_lastDiscoverBbox) {
            _discoverCooldowns.set(_lastDiscoverBbox, Date.now());
          }
          _lastDiscoverBbox = null;
          fetchPinsForViewport();
        }, 2000);

        // Wire highlight button
        setTimeout(() => {
          const highlightBtn = document.getElementById('highlight-new-btn');
          highlightBtn?.addEventListener('click', () => {
            // Flash all pins that were added recently (within last 5 min)
            let count = 0;
            pinMarkers.forEach(marker => {
              const pin = marker._pinData;
              if (!pin) return;
              const age = Date.now() - new Date(pin.created_at || pin.published_at || 0).getTime();
              if (age < 5 * 60 * 1000) { // Last 5 minutes
                // Pulse animation
                const el = marker.getElement();
                if (el) {
                  el.style.animation = 'pulse-new-pin 1s ease-in-out 3';
                  el.style.zIndex = '10000';
                  count++;
                }
              }
            });
            highlightBtn.textContent = `${count} new pins highlighted`;
            highlightBtn.disabled = true;
            setTimeout(() => {
              pinMarkers.forEach(marker => {
                const el = marker.getElement();
                if (el) {
                  el.style.animation = '';
                  el.style.zIndex = '';
                }
              });
            }, 5000);
          });
        }, 2500);
      } else if (data.status === 'cancelled') {
        clearInterval(_statusPolling);
        _statusPolling = null;
        _currentDiscoveryRequestId = null;
        updateStatusPanel('complete', 'Discovery was cancelled', 100);
        updateStatusSummary(`<span style="color: var(--muted);">Discovery was cancelled by user.</span>`, 'info');
        clearLiveDiscoveryPins();
      } else if (data.status === 'failed') {
        clearInterval(_statusPolling);
        _statusPolling = null;
        _currentDiscoveryRequestId = null;
        updateStatusSummary(`<span class="warning">✗ Discovery failed:</span> ${escapeHtml(data.message || 'Unknown error')}`, 'warning');
        clearLiveDiscoveryPins();
      }
    } catch (e) {
      XLog.debug('[status-poll] Error:', e);
    }
  }, 2000);
}

function showAutoDiscoverNotification(message, requestId, jobId) {
  const panel = createStatusPanel();
  // Use jobId (UUID) for polling if available, otherwise fall back to requestId (numeric)
  _currentDiscoveryRequestId = jobId || requestId;

  // Extract location info from message
  const locationMatch = message.match(/Area has (\d+) articles/);
  const articleCount = locationMatch ? locationMatch[1] : '0';

  // Get current map center for location display
  const center = map.getCenter();
  updateStatusLocation(`📍 ${center.lat.toFixed(2)}°, ${center.lng.toFixed(2)}° • ${articleCount} articles found`);

  // Initial placeholder — the pollDiscoveryStatus loop will overwrite this
  // within 2s with the real step from the worker's status file. We used
  // to fake-progress through 6 fake steps here, which made the panel feel
  // responsive but contradicted what the worker was actually doing; the
  // real-data path is strictly more honest.
  updateStatusPanel('init', 'Worker starting...', 5);

  // Start polling for actual status using the jobId (UUID) or requestId (numeric)
  pollDiscoveryStatus(_currentDiscoveryRequestId);
}

// Hook into zoom changes
map.on("zoomend", checkAutoDiscover);
map.on("moveend", checkAutoDiscover);

// The "Links" toggle is a checkbox in the layers dropdown (mounted by
// mountLinksRow above) — its change handler calls setLinksEnabled().

// ── Good News filter (removed from UI — kept for reference) ───────
// Shows only positive, human-interest, entertainment, and food stories.
// The joyful heart of XYZO — because the world needs more good news.
/*
const GOOD_NEWS_CATEGORIES = new Set([
  "human", "entertainment", "food", "culture", "music", "film",
  "celebration", "festival", "community", "love", "family",
  "adventure", "inspiration", "pets", "sports", "education",
]);

let _goodNewsActive = false;

document.getElementById("good-news-btn")?.addEventListener("click", (e) => {
  _goodNewsActive = !_goodNewsActive;
  e.currentTarget.setAttribute("aria-pressed", String(_goodNewsActive));

  if (_goodNewsActive) {
    // Activate good news filter
    _activeCategoryFilters.clear();
    for (const cat of GOOD_NEWS_CATEGORIES) {
      _activeCategoryFilters.add(cat);
    }
    fetchPinsForViewport();
  } else {
    // Deactivate — clear all category filters
    _activeCategoryFilters.clear();
    fetchPinsForViewport();
  }

  updateActiveFilterIndicator();
});
*/

// ── Measure #bottom-bar so nothing floats on top of it ─────────────────
// #help-me-btn is `position: fixed; right: 12px; bottom: 12px; z-index:
// 9998` and #bottom-bar is `position: fixed; z-index: 500`. On a phone
// the bar spans the full width, so the Help Me pill lands squarely on the
// bar's RIGHT END — which is exactly where the ⚙ "Map controls and tools"
// button and the Markers view-mode button live. Measured on an iPhone 14
// Pro (393×660): the Help Me button and the bar overlapped by 4,580 px²,
// and `document.elementFromPoint()` at the gear returned `#help-me-btn`.
// Both controls were therefore UNREACHABLE on mobile — the entire control
// menu (text size, saved styles, export, digest, legend, wiki, density,
// pin mode) could not be opened at all. On desktop the bar is only 454 px
// wide, so it never reaches the right edge and the bug never showed.
//
// Publish the real bar height as a CSS variable so the floating button can
// sit ABOVE it instead of on it (see the #help-me-btn rules in
// styles.css). Measured, not hand-tuned — the bar's height depends on the
// safe-area inset and the button font size.
// Publish the fixed chrome's real edges so anything anchored between them
// can clamp to them instead of to typed constants. Fixed dropdowns sit in
// the clear band between #top-bar and #bottom-bar, and both bands move:
// #bottom-bar grows by env(safe-area-inset-bottom) on an iPhone, #top-bar
// grows with the text-size zoom and with the i18n labels that land after
// first paint. --top-band measures the MAP control stack, not #top-bar,
// so it is not the edge an overlay anchored at the top has to clear.
(function publishChromeEdges() {
  const bar = document.getElementById("bottom-bar");
  if (!bar) return;
  const sync = () => {
    const r = bar.getBoundingClientRect();
    const h = r.height;
    // Only lift the button when the bar is wide enough to reach it. If the
    // bar is short (a desktop pill) the overlap cannot happen and the
    // bottom-right corner is free.
    const wide = r.width > 0 && (r.right > window.innerWidth - 140);
    document.documentElement.style.setProperty(
      "--bottom-bar-h", `${Math.round(h)}px`);
    // The bar's TOP EDGE, measured from the viewport bottom. Fixed
    // dropdowns are anchored `bottom: Npx` and grow upward, so this is
    // what they have to clear — height alone is not enough, because the
    // bar is itself offset from the bottom edge by 12px (plus
    // env(safe-area-inset-bottom) on an iPhone). The control menu used a
    // hard-coded 58px while the bar's top edge sat at 70px, so the menu
    // overlapped the bar by 12px and its last row, "AI / Help", was
    // half-hidden behind it. On a device with a home indicator the gap
    // is bigger still, which is why this is measured rather than typed.
    const topFromBottom = Math.max(0, window.innerHeight - r.top);
    document.documentElement.style.setProperty(
      "--bottom-bar-top", `${Math.round(topFromBottom)}px`);
    // #top-bar's own bottom edge, measured downwards from the viewport top.
    const topBar = document.getElementById("top-bar");
    if (topBar) {
      const tb = topBar.getBoundingClientRect();
      if (tb.height > 0 && tb.bottom > 0) {
        document.documentElement.style.setProperty(
          "--top-chrome-bottom", `${Math.round(tb.bottom)}px`);
      }
    }
    document.documentElement.style.setProperty(
      "--bottom-bar-overlaps-float", wide ? "1" : "0");
    // Where the floating Help Me pill must sit so it clears the bar.
    // Lifted only when the bar actually reaches under it.
    document.documentElement.style.setProperty(
      "--help-me-bottom",
      wide ? `${Math.round(h) + 20}px` : "12px");
  };
  sync();
  const topBar = document.getElementById("top-bar");
  if (typeof ResizeObserver !== "undefined") {
    try { new ResizeObserver(sync).observe(bar); } catch (_) {}
    // The top bar changes height too (text-size zoom, i18n labels), and
    // the menu's clamp reads its bottom edge.
    if (topBar) { try { new ResizeObserver(sync).observe(topBar); } catch (_) {} }
  }
  window.addEventListener("resize", sync);
  window.addEventListener("orientationchange", sync);
  // The bar grows once i18n labels land, and shrinks when the keyboard
  // opens — re-measure on both.
  if (typeof MutationObserver !== "undefined") {
    try {
      new MutationObserver(sync).observe(bar, { attributes: true, attributeFilter: ["class", "style"] });
    } catch (_) {}
  }
  setTimeout(sync, 1500);
})();

// ── Mobile bottom-bar keyboard handling ────────────────────────────────
// Audit 4 found the fixed #bottom-bar hides content behind the on-screen
// keyboard when a user focuses a search/location input. Hide the bar
// whenever the visual viewport shrinks significantly — a reliable proxy
// for "keyboard is open" on iOS/Android (fires on focus/blur reliably,
// unlike window.resize on iOS which only fires on rotation).
(function setupBottomBarKeyboardHide() {
  const bar = document.getElementById("bottom-bar");
  if (!bar) return;
  const check = () => {
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    // 0.7 threshold matches the standard mobile-keyboard heuristic.
    const isKeyboardOpen = height < window.screen.height * 0.7;
    bar.classList.toggle("keyboard-open", isKeyboardOpen);
  };
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", check);
    window.visualViewport.addEventListener("scroll", check);
  }
  window.addEventListener("resize", check);
  check();
})();

// Tiny test hook — only callable from a same-origin test page. Lets a test
// script populate synthetic markers + force a link render without faking a
// network call. Has no production effect.
window.__xyzoTest = (() => {
  const seeds = [
    { id: 't1', source_type: 'rss', category: 'health',    title: 'T1', location: { lat: 51.5, lng: -0.1 }, published_at: new Date().toISOString(), canonical_url: '#' },
    { id: 't2', source_type: 'rss', category: 'health',    title: 'T2', location: { lat: 35.7, lng: 139.7 }, published_at: new Date().toISOString(), canonical_url: '#' },
    { id: 't3', source_type: 'rss', category: 'health',    title: 'T3', location: { lat: -33.9, lng: 151.2 }, published_at: new Date().toISOString(), canonical_url: '#' },
    { id: 't4', source_type: 'rss', category: 'health',    title: 'T4', location: { lat: 40.7, lng: -74.0 }, published_at: new Date().toISOString(), canonical_url: '#' },
    { id: 't5', source_type: 'rss', category: 'health',    title: 'T5', location: { lat: -23.5, lng: -46.6 }, published_at: new Date().toISOString(), canonical_url: '#' },
    { id: 't6', source_type: 'rss', category: 'politics',  title: 'T6', location: { lat: 48.8, lng: 2.3 }, published_at: new Date().toISOString(), canonical_url: '#' },
    { id: 't7', source_type: 'rss', category: 'politics',  title: 'T7', location: { lat: 55.7, lng: 37.6 }, published_at: new Date().toISOString(), canonical_url: '#' },
    { id: 't8', source_type: 'rss', category: 'politics',  title: 'T8', location: { lat: -34.6, lng: -58.4 }, published_at: new Date().toISOString(), canonical_url: '#' },
    { id: 't9', source_type: 'rss', category: 'weather',   title: 'T9', location: { lat: 25.0, lng: 121.5 }, published_at: new Date().toISOString(), canonical_url: '#' },
    { id: 't10', source_type: 'rss', category: 'weather',  title: 'T10', location: { lat: 13.7, lng: 100.5 }, published_at: new Date().toISOString(), canonical_url: '#' },
  ];
  return function seed() {
    for (const p of seeds) {
      const icon = L.divIcon({
        className: 'xyzo-pin',
        html: '<div class="pin" style="--c:#888"></div>',
        iconSize: [38, 38],
        iconAnchor: [19, 19],
      });
      const m = L.marker([p.location.lat, p.location.lng], { icon });
      m._xyzoCategory = SUBTYPE_TO_BUCKET[p.category] || p.category;
      pinMarkers.set(p.id, m);
    }
    return { registered: pinMarkers.size };
  };
})();

window.__xyzoRenderLinks = renderLinks;
window.__xyzoSetZoom = (z) => { map.setZoom(z); renderLinks(); };
window.__xyzoGetZoom = () => map.getZoom();
// Combined: seed + zoom + render, in one call so test scripts don't need to
// worry about ordering.
window.__xyzoSeedAndRender = (zoom = 6) => {
  window.__xyzoTest();
  map.setZoom(zoom);
  renderLinks();
  return { registered: pinMarkers.size, zoom: map.getZoom(), linksEnabled };
};
window.__xyzoCountPaths = () => {
  if (!map.hasLayer(linkLayer)) return 0;
  const overlay = map.getPanes().overlayPane;
  if (!overlay) return 0;
  // Story-connection arcs are rendered as path.xyzo-conn. This accessor
  // used to look for path.xyzo-link, which belongs to the removed
  // category-arc feature — so it reported 0 arcs even when hundreds were
  // on screen, and any test relying on it silently passed for the wrong
  // reason.
  return overlay.querySelectorAll('path.xyzo-conn, circle.xyzo-conn-centroid').length;
};
// Test-only accessors for the diff/perf verification page. Same-origin
// only (no production effect). Return shapes:
//   __xyzoGetPinIds()    → array<pin_id>
//   __xyzoGetFirstMarker() → L.marker | null
//   __xyzoGetLeafletIds() → array<{ pin_id, leaflet_id }> — used to
//     verify the diff loop doesn't tear down L.marker objects across
//     re-renders (same leaflet_id = same object = no DOM churn).
window.__xyzoGetPinIds = () => Array.from(pinMarkers.keys());
window.__xyzoGetFirstMarker = () => pinMarkers.values().next().value ?? null;
window.__xyzoGetLeafletIds = () => Array.from(pinMarkers.entries()).map(([id, m]) => ({ id, lid: m._leaflet_id }));

// ── Wikipedia search integration ──────────────────────────────────────
const wikiSearchResults = document.getElementById("wiki-search-results");
let _wikiSearchInflight = null;

async function fetchWikiSearch(q) {
  if (!q || q.length < 2) {
    renderWikiSearchResults(null);
    return;
  }
  if (_wikiSearchInflight) _wikiSearchInflight.abort();
  const ctrl = new AbortController();
  _wikiSearchInflight = ctrl;
  try {
    const url = `/api/wiki/search?q=${encodeURIComponent(q)}&limit=8`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`wiki search ${res.status}`);
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!ctrl.signal.aborted) renderWikiSearchResults(data);
  } catch (e) {
      if (e?.name !== "AbortError") XLog.warn("fetchWikiSearch", e);
    if (!ctrl.signal.aborted) renderWikiSearchResults(null);
  } finally {
    if (_wikiSearchInflight === ctrl) _wikiSearchInflight = null;
  }
}

function renderWikiSearchResults(data) {
  if (!wikiSearchResults) return;
  if (!data || !data.results?.length) {
    wikiSearchResults.hidden = true;
    wikiSearchResults.innerHTML = "";
    return;
  }
  const header = `<div class="wiki-search-header"><span class="wiki-logo">W</span> Wikipedia · ${data.count} result${data.count === 1 ? "" : "s"}</div>`;
  const items = data.results.map((a) => {
    const sizeKb = a.article_length > 0 ? `${Math.round(a.article_length / 1024)} KB` : "";
    return `<a class="wiki-search-item" href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">
      <p class="wiki-search-item-title">${escapeHtml(a.title)}</p>
      <p class="wiki-search-item-meta">${sizeKb ? sizeKb + " · " : ""}Open on Wikipedia</p>
    </a>`;
  }).join("");
  wikiSearchResults.innerHTML = header + items;
  wikiSearchResults.hidden = false;
}

function clearWikiSearch() {
  if (_wikiSearchInflight) _wikiSearchInflight.abort();
  _wikiSearchInflight = null;
  renderWikiSearchResults(null);
}

// ── Journalist Search ───────────────────────────────────────────────
let journalistSearchResults = document.getElementById("journalist-search-results");
let _journalistSearchInflight = null;

async function fetchJournalistSearch(q) {
  if (!q || q.length < 2) {
    renderJournalistSearchResults(null);
    return;
  }
  if (_journalistSearchInflight) _journalistSearchInflight.abort();
  const ctrl = new AbortController();
  _journalistSearchInflight = ctrl;
  try {
    const url = `/api/journalists?q=${encodeURIComponent(q)}&limit=5`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`journalist search ${res.status}`);
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!ctrl.signal.aborted) renderJournalistSearchResults(data);
  } catch (e) {
    if (e?.name !== "AbortError") XLog.warn("fetchJournalistSearch", e);
    if (!ctrl.signal.aborted) renderJournalistSearchResults(null);
  } finally {
    if (_journalistSearchInflight === ctrl) _journalistSearchInflight = null;
  }
}

function renderJournalistSearchResults(data) {
  if (!journalistSearchResults) return;
  if (!data || !data.items?.length) {
    journalistSearchResults.hidden = true;
    journalistSearchResults.innerHTML = "";
    return;
  }
  const count = data.count;
  const header = `<div class="journalist-search-header"><span class="journo-logo">J</span> Journalists · ${count} found</div>`;
  const items = data.items.map((j) => {
    const articleCount = j.article_count ? `${j.article_count} article${j.article_count === 1 ? "" : "s"}` : "";
    const topicList = j.topics?.slice(0, 3).join(", ") || "";
    const locationStr = j.city ? `${j.city}, ${j.country || ""}` : (j.country || "");
    const orgStr = j.organization || "";
    const metaParts = [articleCount, topicList, locationStr, orgStr].filter(Boolean);
    const meta = metaParts.join(" · ");
    return `<a class="journalist-search-item" href="#journalist/${escapeHtml(j.id)}">
      <p class="journalist-search-item-name">${escapeHtml(j.name)}</p>
      <p class="journalist-search-item-meta">${escapeHtml(meta)}</p>
    </a>`;
  }).join("");
  journalistSearchResults.innerHTML = header + items;
  journalistSearchResults.hidden = false;
}

function clearJournalistSearch() {
  if (_journalistSearchInflight) _journalistSearchInflight.abort();
  _journalistSearchInflight = null;
  renderJournalistSearchResults(null);
}

// ── Wikipedia map markers ────────────────────────────────────────────
const wikiMarkerLayer = L.layerGroup().addTo(map);
const wikiMarkers = new Map(); // pageid -> L.marker
let wikiMarkersEnabled = false;
let _wikiMarkersInflight = null;
let _wikiMarkersLastCenter = null;
const WIKI_MARKER_MIN_ZOOM = 4;

const wikiToggleBtn = document.getElementById("wiki-markers-toggle");
if (wikiToggleBtn) {
  wikiToggleBtn.addEventListener("click", () => {
    wikiMarkersEnabled = !wikiMarkersEnabled;
    wikiToggleBtn.setAttribute("aria-pressed", String(wikiMarkersEnabled));
    if (wikiMarkersEnabled) {
      _wikiMarkersLastCenter = null; // Force fresh fetch
      fetchWikiMarkersForViewport();
    } else {
      clearWikiMarkers();
    }
  });
}

function clearWikiMarkers() {
  if (_wikiMarkersInflight) _wikiMarkersInflight.abort();
  _wikiMarkersInflight = null;
  wikiMarkerLayer.clearLayers();
  wikiMarkers.clear();
  _wikiMarkersLastCenter = null;
}

function buildWikiMarkerIcon() {
  return L.divIcon({
    className: "wiki-marker",
    html: '<div class="pin">W</div>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function renderWikiMarkers(articles) {
  if (!articles || !articles.length) return;
  const seen = new Set();
  for (const a of articles) {
    if (!a.lat || !a.lng) continue;
    seen.add(a.pageid);
    if (wikiMarkers.has(a.pageid)) continue;
    const icon = buildWikiMarkerIcon();
    const marker = L.marker([a.lat, a.lng], { icon });
    const extract = a.extract ? `<p style="margin:4px 0 0;font-size:12px;color:#9ca3af;line-height:1.4">${escapeHtml(a.extract)}</p>` : "";
    const dist = a.distance_m != null ? `<p style="margin:4px 0 0;font-size:10px;color:#6b7280">${formatDistance(a.distance_m)}</p>` : "";
    marker.bindPopup(
      `<div style="min-width:180px">
        <button class="popup-close-btn" aria-label="Close popup">✕</button>
        <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer" style="font-weight:600;color:#e5e7eb;text-decoration:none;font-size:13px;display:block;padding-right:40px;">${escapeHtml(a.title)}</a>
        ${extract}
        ${dist}
        <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:6px;font-size:11px;color:#60a5fa">Open on Wikipedia</a>
      </div>`,
      { maxWidth: 280 }
    );
    wikiMarkers.set(a.pageid, marker);
    wikiMarkerLayer.addLayer(marker);
  }
  // Remove markers no longer in results
  for (const [id, m] of wikiMarkers) {
    if (!seen.has(id)) {
      wikiMarkerLayer.removeLayer(m);
      wikiMarkers.delete(id);
    }
  }
}

async function fetchWikiMarkersForViewport() {
  if (!wikiMarkersEnabled) return;
  if (map.getZoom() < WIKI_MARKER_MIN_ZOOM) {
    clearWikiMarkers();
    return;
  }

  const bounds = map.getBounds();
  const center = map.getCenter();
  const lat = center.lat;
  const lng = center.lng;
  const zoom = map.getZoom();

  // Skip if center hasn't moved much (but allow refresh on zoom change)
  if (_wikiMarkersLastCenter
      && Math.abs(_wikiMarkersLastCenter.lat - lat) < 0.05
      && Math.abs(_wikiMarkersLastCenter.lng - lng) < 0.05
      && _wikiMarkersLastCenter.zoom === zoom) {
    return;
  }

  if (_wikiMarkersInflight) _wikiMarkersInflight.abort();
  const ctrl = new AbortController();
  _wikiMarkersInflight = ctrl;

  try {
    // Calculate radius to cover the visible viewport
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const latSpan = ne.lat - sw.lat;
    const lngSpan = ne.lng - sw.lng;
    // Radius in meters: half the diagonal of the viewport
    const latKm = latSpan * 111;
    const lngKm = lngSpan * 111 * Math.cos(lat * Math.PI / 180);
    const radiusM = Math.round(Math.sqrt(latKm * latKm + lngKm * lngKm) * 500); // half diagonal

    // Higher limits for city-level zoom
    let limit;
    if (zoom >= 12) limit = 100;      // city blocks
    else if (zoom >= 10) limit = 80;  // city level
    else if (zoom >= 8) limit = 60;   // metro level
    else if (zoom >= 6) limit = 40;   // region level
    else limit = 25;                   // country level

    const url = `/api/wiki/near?lat=${lat}&lng=${lng}&radius_m=${Math.min(radiusM, 50000)}&limit=${limit}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`wiki near ${res.status}`);
    const data = await res.json();
    if (!ctrl.signal.aborted) {
      renderWikiMarkers(data.results || []);
      _wikiMarkersLastCenter = { lat, lng, zoom };
    }
  } catch (e) {
      if (e?.name !== "AbortError") XLog.warn("fetchWikiMarkers", e);
  } finally {
    if (_wikiMarkersInflight === ctrl) _wikiMarkersInflight = null;
  }
}

// Fetch wiki markers on map move (throttled)
const throttledWikiMarkers = throttle(fetchWikiMarkersForViewport, 1000);
map.on("moveend", () => {
  if (wikiMarkersEnabled) throttledWikiMarkers();
});


searchInput = document.getElementById("search-input");
searchBtn = document.getElementById("search-btn");

// THE CITY INDEX IS WARMED WHEN THE READER REACHES FOR THE SEARCH BOX,
// NOT AT BOOT.
//
// /data/cities.10k.json is 1.16 MB, and it used to be fetched at
// "browser idle" with a 2.5-second timeout — a timeout that fires even
// when the browser is BUSY, which during a map boot it always is. So the
// biggest single download on the page started 2.5 s in, while app.js and
// the map's tiles were still arriving, and it stole their bandwidth.
// Measured 2026-11-12: the markers cannot start until app.js has
// arrived (t=3.37 s on a throttled 4G link), and the city index was
// downloading in parallel the whole time.
//
// The index is needed for the CITY search path (and the city-names
// layer). Touching the search box is the moment it starts to matter, and
// that is when it is fetched — the reader has typed a word by the time
// it lands.
if (window.CityEngine && typeof window.CityEngine.ensureLoaded === "function") {
  const warmCityIndex = () => {
    try { window.CityEngine.ensureLoaded(); } catch (_) {}
  };
  // The search box — the index is what makes a CITY search fast.
  if (searchInput) {
    searchInput.addEventListener("focus", warmCityIndex, { passive: true });
    searchInput.addEventListener("pointerdown", warmCityIndex, { passive: true });
    searchInput.addEventListener("input", warmCityIndex, { passive: true });
  }
  // The map itself — the index is what gives a pin popup its nearest
  // town. The FIRST touch is the signal: a reader who has not touched
  // anything has not asked for a town, and the 1.16 MB download is the
  // biggest single file on the page.
  const mapHost = document.getElementById("map");
  if (mapHost) {
    let warmed = false;
    const warmOnce = () => {
      if (warmed) return;
      warmed = true;
      warmCityIndex();
      mapHost.removeEventListener("pointerdown", warmOnce, true);
      mapHost.removeEventListener("keydown", warmOnce, true);
    };
    mapHost.addEventListener("pointerdown", warmOnce, true);
    mapHost.addEventListener("keydown", warmOnce, true);
  }
}
searchClear = document.getElementById("search-clear");
searchStatus = document.getElementById("search-status");
searchActive = false;
let _searchAbortCtrl = null;
let _preSearchView = null;

// Discovery Mode panel state
let _discoveryPanel = null;
let _discoveryPollInterval = null;
let _discoveryPollCount = 0;
const MAX_DISCOVERY_POLLS = 20;   // 20 × 3s = 60s max polling

// Check for search query in URL on load and run search if found
(function initSearchFromUrl() {
  try {
    const sp = new URLSearchParams(window.location.search);
    const q = sp.get("q");
    if (q && q.trim()) {
      if (searchInput) {
        searchInput.value = q.trim();
      }
      const run = () => {
        if (typeof runSearch === "function" && searchInput && searchInput.value.trim()) {
          runSearch({ zoom: "auto" });
        }
      };
      // DEFER, always. runSearch() reaches for `debouncedTextSearch`,
      // which is a `const` declared ~150 lines further down — calling
      // runSearch() from here synchronously meant that binding was still
      // in its temporal dead zone, so the call threw
      // "Cannot access 'debouncedTextSearch' before initialization".
      // The `catch` below swallowed it, and the search from a shared
      // ?q= link silently never ran: no results, and a status that
      // never left its initial state.
      const schedule = () => setTimeout(run, 0);
      whenMapReady(schedule);
    }
  } catch (e) {
    // Never swallow this silently: a search that dies here leaves the
    // user staring at a map with no results and no explanation.
    if (typeof XLog !== "undefined" && XLog && XLog.warn) {
      XLog.warn("initSearchFromUrl", e);
    }
  }
})();

function showStatus(msg) {
  if (!msg) {
    searchStatus.hidden = true;
    searchStatus.textContent = "";
  } else {
    searchStatus.hidden = false;
    if (typeof msg === "string" && msg.includes("<")) {
      searchStatus.innerHTML = msg;
    } else {
      searchStatus.textContent = msg;
    }
  }
}

// ── Where the map looks after a search ───────────────────────────────────────
// ONE implementation, shared by runSearch() and runTextSearch(): the two
// used to carry their own copy of the "is this a place?" gate, and they
// had already drifted — one read `geoMatchesQuery`, the other `geoStrong`,
// and one read `event_count` while the other read `events_count`.
//
// The geocoder's answer is a HYPOTHESIS about where the stories are, and
// it is wrong often enough to matter. Measured 2026-11-09:
//
//   "artificial intelligence" → Nominatim answers with the front door of
//   the "Center for Artificial Intelligence and Robotics" in Würzburg —
//   an ELEVEN METRE bounding box — and news_locations carries a junk row
//   named exactly "Artificial Intelligence" pointing at that same door.
//   The old gate was NAME EQUALITY, so it passed, and the map flew to an
//   empty field at zoom 10 (#49.7961,9.8988,10) while the stories sat in
//   San Mateo, Kyiv, Quito, Perth and Paris.
//
//   "climate" → the Climate Pledge Arena in Seattle — a STADIUM, 150 m
//   across — and news_locations has a "Climate" row on the same spot.
//
//   "nvidia" → the Nvidia headquarters, about 100 m across.
//
// So a place may only frame the map when it is a REGION. A box narrower
// than MIN_REGION_DEG is a point of interest — a building, a campus, a
// stadium — and a reader who searched a topic must never be dropped on
// one. Everything that survives the test is framed exactly as it always
// was: "el salvador" still goes to the country, "tokyo" to the city.
//
// The region itself comes from the RESULTS, because that is what the
// reader came for. A set that spans the world is framed by the WORLD VIEW
// rather than by its bounding box: the box of a worldwide set has its
// centre in an empty ocean — measured, "artificial intelligence" framed
// the South Atlantic at 34.16, -33.40, some 2,300 km from the nearest
// story — and a centre in the ocean is precisely the "zoomed into an area
// with no stories" this replaces.

// Below this a bounding box is a POINT OF INTEREST, not a region.
// 0.05° ≈ 5.5 km: smaller than any town, far bigger than any building.
const MIN_REGION_DEG = 0.05;
// Wider than this and the stories are everywhere — the box's centre would
// be an empty ocean, so show the world instead.
const WORLD_SPAN_DEG = 90;
// How far apart two oracles may be and still be talking about the same
// place. The same 6° the extent test has always used.
const ANCHOR_AGREE_DEG = 6;

// Every story a search returned, as [lat, lng]. The RAW locations, never
// the rendered markers' positions: a spread position is a lie about where
// a story happened (the exporter keeps _rawPins for the same reason).
function storyPoints(...groups) {
  const pts = [];
  for (const g of groups) {
    if (!Array.isArray(g)) continue;
    for (const s of g) {
      const loc = s && s.location;
      if (!loc) continue;
      const lat = Number(loc.lat), lng = Number(loc.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) pts.push([lat, lng]);
    }
  }
  return pts;
}

// The extent the stories occupy, or null when there are none.
function pointsExtent(points) {
  if (!points || !points.length) return null;
  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
  for (const p of points) {
    if (p[0] < south) south = p[0];
    if (p[0] > north) north = p[0];
    if (p[1] < west) west = p[1];
    if (p[1] > east) east = p[1];
  }
  return { south, north, west, east, latSpan: north - south, lngSpan: east - west };
}

// Frame the map for a search, and say what it did.
//
// The place gate is deliberately STRICT. Neither lookup is a safe oracle
// on its own: /api/locations/search?q="climate change" ranks "Climate" (a
// place in Seattle) first, and Nominatim answers the same query with a
// trail sign literally called "Climate Change" in California. So a place
// only wins when it accounts for the WHOLE query — which is what "el
// salvador", "chile" and "japan" look like, and what "climate change"
// does not. A topic that merely mentions a country keeps the world view,
// where its results are shown spread across the globe.
//
// Returns { framed, rejectedAnchor }: `framed` is "place" | "stories" |
// "world" | "geo", and `rejectedAnchor` says the query DID resolve to a
// place but that place was a point of interest and was not used — the
// status line uses that to stop naming a building as the answer.
function frameSearchRegion({ q, geo, bestLoc, points, zoom, isBiggerPlace = () => false }) {
  // The place gate compares NORMALISED names, and the normalisation folds
  // the accents: a reader types "wurzburg" or "sao paulo", not "Würzburg"
  // and "São Paulo", and the row in the table carries the accents.
  const norm = (s) => String(s || "").toLowerCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,]+/g, "");
  const qNorm = norm(q);
  const geoStrong = !!(geo && geo.display_name &&
    geo.display_name.toLowerCase().startsWith(qNorm));
  // A COUNTRY-LEVEL ANSWER IS THE PLACE EVEN WHEN NOMINATIM NAMED IT IN
  // ITS OWN SCRIPT. Measured (2026-11-11): for a country query the
  // geocoder answers in the local language far more often than not —
  // "china" -> 中国, "japan" -> 日本, "korea" -> 대한민국, "brazil" ->
  // Brasil, "turkey" -> Türkiye, "peru" -> Perú — and not one of those
  // display names starts with, equals, or even resembles the query, so
  // the name gate rejected the very COUNTRY the reader asked for and
  // the map fell through to the stories (for "china": the world view,
  // because its 1,000 results span the globe).
  //
  // The clause is narrow on purpose. The query must NAME a bigger
  // place (the gazetteer's country/state list, isBiggerPlace) AND the
  // geocoder must have answered with an ADMINISTRATIVE area — a country
  // or a state. Nominatim answering "turkey" with Turkey, TEXAS is a
  // town, not an admin area, and still loses to the name gate; a query
  // that is not on the list ("ai", "climate") never reaches the clause
  // at all, so the point-of-interest and corroboration rules below are
  // untouched.
  const geoIsThePlace = !!(
    (geoStrong && norm(geo.display_name) === qNorm) ||
    (geo && geo.place_type === "administrative" && isBiggerPlace(q)));
  const locCount = bestLoc ? (bestLoc.events_count ?? bestLoc.event_count ?? 0) : 0;
  const locIsThePlace = !!(bestLoc && locCount > 0 && norm(bestLoc.place_name) === qNorm);

  // A LOCATION ROW MUST BE CORROBORATED BY THE GEOCODER.
  //
  // The two are independent oracles, and a row whose name happens to
  // equal the query is only a place if the geocoder agrees on WHERE it
  // is. Measured (2026-11-09): searching "ai" —
  // /api/locations/search answers with a junk row named "AI" on Long
  // Island, New York (353 events) and /api/geocode answers with
  // ANGUILLA. The two are 2,700 km apart, so the name-match was a
  // coincidence, and the map flew to a place called "AI".
  //
  // No geocode answer means nothing to contradict the row, so the row
  // stands — that is the "Anguilla" case, where the row and the geocoder
  // agree on the place.
  const locCorroborated = !bestLoc || !geo ||
    (Math.abs(geo.lat - bestLoc.lat) < ANCHOR_AGREE_DEG &&
     Math.abs(geo.lng - bestLoc.lng) < ANCHOR_AGREE_DEG);
  // A row that matched the query's NAME and was not corroborated is
  // rejected — and it must not be named in the status line either.
  const rejectedRow = locIsThePlace && !locCorroborated;
  // Whether a place was RESOLVED and then thrown away — for being a
  // point of interest or for not being corroborated. The status line uses
  // it to stop naming a place the map did not go to.
  let rejectedAnchor = rejectedRow;

  const anchor = geoIsThePlace ? geo : (locIsThePlace && locCorroborated ? bestLoc : null);

  if (anchor) {
    // Frame the place's own EXTENT when the geocoder gave us one, so a
    // country or region is centred as a shape rather than a single point
    // zoomed to 6. Nominatim orders the box [south, north, west, east];
    // its centre must agree with the anchor so we never frame a box the
    // geocoder answered for a DIFFERENT place (the "Children" → "Chile"
    // false positive).
    const bb = Array.isArray(geo && geo.boundingbox) ? geo.boundingbox.map(Number) : null;
    const agreesWithAnchor = !!bb && bb.length === 4 && bb.every(Number.isFinite) &&
      Math.abs((bb[0] + bb[1]) / 2 - anchor.lat) < 6 &&
      Math.abs((bb[2] + bb[3]) / 2 - anchor.lng) < 6;
    // Cap the extent so a huge box cannot zoom out past the ask — and
    // THE CAP IS THE LARGEST REAL COUNTRY, NOT A CITY'S. Measured
    // (2026-11-11): the old 25°×40° cap rejected the boxes of most big
    // countries — China 44.9°×61.3°, India 29.1°×29.5°, Brazil
    // 39.1°×45.4°, Canada 41.7°×88.7°, Australia 46.2°×96° — so a
    // country search fell back to a point at zoom 6 and showed a slice
    // of it. 60°×100° fits every country whose box is honest (Canada
    // and Australia are the widest) while still rejecting what must be
    // rejected: the United States' box is 86°×360° because it includes
    // Wake and Guam, Russia's crosses the antimeridian at 360°, and a
    // continent or the world is wider still — fitting THOSE would zoom
    // out to the whole planet, which is the failure this cap exists for.
    // Past the cap the point is always a defensible fallback.
    const sane = agreesWithAnchor && (bb[1] - bb[0]) < 60 && (bb[3] - bb[2]) < 100;
    // A POINT OF INTEREST IS NOT A REGION. A box this small is a
    // building, a campus or a stadium — the reader searched a topic and
    // would be dropped on an empty doorway.
    const isRegion = !(sane && Math.max(bb[1] - bb[0], bb[3] - bb[2]) < MIN_REGION_DEG);
    if (isRegion) {
      if (sane) {
        map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]],
          { padding: [48, 48], maxZoom: 10, animate: true });
      } else {
        map.flyTo([anchor.lat, anchor.lng], 6, { duration: 0.5 });
      }
      return { framed: "place", rejectedAnchor: false };
    }
    // The anchor is a point of interest — fall through and frame the
    // STORIES instead.
    rejectedAnchor = true;
  }

  const ext = pointsExtent(points);
  if (!ext) {
    // Nothing to frame. An explicit submit shows the world; otherwise
    // honour the geocode we were given, at a zoom that shows its
    // surroundings rather than its doorstep.
    if (zoom === "world" || !geo) {
      zoomToWorld();
      return { framed: "world", rejectedAnchor };
    }
    map.flyTo([geo.lat, geo.lng], 6, { duration: 0.5 });
    return { framed: "geo", rejectedAnchor };
  }
  // The stories are everywhere: their bounding box has its centre in an
  // empty ocean, so show the world instead of the middle of the Atlantic.
  if (ext.latSpan >= WORLD_SPAN_DEG || ext.lngSpan >= WORLD_SPAN_DEG) {
    zoomToWorld();
    return { framed: "world", rejectedAnchor };
  }
  // The stories are in a region: frame IT. Capped so one lonely event
  // cannot dive the map into a city block.
  map.fitBounds([[ext.south, ext.west], [ext.north, ext.east]],
    { padding: [40, 40], maxZoom: 12, animate: true });
  return { framed: "stories", rejectedAnchor };
}

// Reset to a global world view (used by explicit user actions: clicking a
// keyword chip in a popup, or pressing the Search button / Enter). The
// debounced keystroke path deliberately keeps the legacy auto-zoom because
// it's jarring to fly the map back to the world on every typed character.
function zoomToWorld() {
  if (typeof map === "undefined" || !map || !map.flyTo) return;
  map.flyTo([20, 0], 2, { duration: 0.6 });
}

// ── City-aware search detection ─────────────────────────────────────────
// When the user types a city name (e.g. "Chicago", "Tokyo", "nyc"), we
// want to show ALL markers in that city's area, not just pins whose
// title/summary mentions the city name. This function checks if the query
// matches a known city via CityEngine (exact name or alias match).
// Returns the city object if it's a city search, null otherwise.
// State abbreviations live in city-engine.js (the gazetteer), not here:
// app.js is under an explicit 850 KB runaway ceiling whose own comment
// says to extract rather than raise, and a table of 51 states x 4
// coordinates is reference data, not behaviour. The shape returned is
// unchanged — name/state/country_code/lat/lng/population plus _bbox,
// which cityToBbox() translates from Nominatim order.

// Place-lookup bodies live in city-engine.js (the gazetteer): app.js is
// under an explicit 850 KB runaway ceiling whose comment says to extract
// rather than raise, and "where is this place?" is gazetteer work. Thin
// aliases keep every call site — and this diff — behaviourally identical.
const detectCitySearch = (q) => window.CityEngine?.detectCity?.(q) ?? null;
const cityToBbox = (city, r) => window.CityEngine?.cityToBbox?.(city, r) ?? null;
const citySearchRadius = (city) => window.CityEngine?.cityRadius?.(city) ?? 30;
// The gazetteer's country/state list (BIG_PLACE_NAMES in city-engine.js).
// frameSearchRegion() takes it as a parameter so the framing function
// stays a pure function of its arguments — the tests run it against a
// stub map with no window at all. Two consumers of the same list:
// detectCitySearch() uses it to REFUSE to answer a country query with
// a city, and the framing uses it to ACCEPT the geocoder's local-script
// country answer ("japan" -> 日本).
const isBiggerPlace = (q) => window.CityEngine?.isBiggerPlace?.(q) ?? false;

function detectStateSearch(query) {
  if (!window.CityEngine || typeof window.CityEngine.findState !== "function") return null;
  return window.CityEngine.findState(query);
}

// ── A SEARCH ENDS THE ONBOARDING TOUR ─────────────────────────────────
//
// The tour is a first-visit card, and its card is the only thing it puts
// on the POINTER PATH: at z-index 9998 it is above the popup pane (1200),
// and on a phone it is a bottom sheet. So it sat ON TOP of the popup a
// search had just opened — the ✕ Close was under the tour card, the
// reader's tap landed on the tour instead of the ✕, and the popup could
// not be closed at all.
//
// Measured with scripts/search_mobile_audit.py (2026-11-11): the search
// for "tokyo" opened a popup at 11,521 → 380,740 and the element at the
// ✕ Close's own coordinates was `xyzo-tour-title`.
//
// A reader who has just typed a query knows how to search — the tour has
// nothing left to teach them about it, and it can be re-opened from
// ⚙ → TOOLS → "How to".
function endTourForSearch() {
  try {
    if (window.XYZO_TOUR) {
      window.XYZO_TOUR.stop();
      // stop() only marks the tour seen when it was OPEN — so the
      // auto-start would still fire LATER, over the popup. markSeen()
      // stops that too.
      window.XYZO_TOUR.markSeen();
    }
  } catch (_) {}
}

// ── The age of a PRE-INDEXED answer ─────────────────────────────────────
//
// The server answers a popular query from a stored answer (the
// pre-index, api/src/lib/preindex.ts) and says WHEN it was built; the
// reader is told, because an answer that does not say its age is
// yesterday's news served as if it were this morning's.
//
// The browser-side saved-searches store says the same thing in its own
// words ("Showing saved results from 11/9/2026 · searching for newer…").
// This is the server-side equivalent: the answer is already current, so
// the note is a time, not a promise of a refresh.
//
// Under two minutes old the note is noise, so it is left off.
function preindexAgeNote(payload) {
  if (!payload || payload.source !== "preindex" || !payload.built_at) return "";
  const built = new Date(payload.built_at);
  if (!Number.isFinite(built.getTime())) return "";
  const ageMin = Math.round((Date.now() - built.getTime()) / 60000);
  if (ageMin < 2) return "";
  let hhmm = "";
  try {
    hhmm = built.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (_) { hhmm = ""; }
  return hhmm ? ` · as of ${hhmm}` : "";
}

// Light debounced text-search: hits the cheap pins + geocode endpoints on
// every keystroke, but only the heavy worker-spawning /api/events/search on
// Enter or button click (it can take ~30–90 s).
const debouncedTextSearch = debounce(() => runTextSearch(), 350);

async function runTextSearch(opts = {}) {
  const { zoom = "auto" } = opts;
  const q = searchInput.value.trim();
  if (!q) {
    clearSearch();
    return;
  }
  endTourForSearch();
  // Clear previous journalist search results when starting a new search
  clearJournalistSearch();
  if (!searchActive && !_preSearchView && typeof map !== "undefined" && map) {
    _preSearchView = { center: map.getCenter(), zoom: map.getZoom() };
  }
  searchActive = true;
  if (searchClear) searchClear.hidden = false;
  autoSelectLegendCategoryForQuery(q);
  UserTracker.trackSearch(q);
  _searchJourney.query = q;
  _searchJourney.startTime = Date.now();

  if (_searchAbortCtrl) {
    try { _searchAbortCtrl.abort(); } catch (_) {}
  }
  const ctrl = new AbortController();
  _searchAbortCtrl = ctrl;

  const { since, until } = searchWindow();
  const cityHit = detectStateSearch(q) || detectCitySearch(q);

  if (cityHit) {
    const radius = citySearchRadius(cityHit);
    const bbox = cityToBbox(cityHit, radius);
    const bboxStr = bbox.map(n => n.toFixed(4)).join(",");
    let pinsUrl = `/api/pins/map?bbox=${bboxStr}&limit=1500`;
    if (since) pinsUrl += `&since=${encodeURIComponent(since)}`;
    if (until) pinsUrl += `&until=${encodeURIComponent(until)}`;
    if (_activeTag) pinsUrl += `&tag=${encodeURIComponent(_activeTag)}`;

    fetchWikiSearch(q);
    fetchJournalistSearch(q);

    let pins;
    try {
      const res = await fetch(pinsUrl, { signal: ctrl.signal });
      pins = res.ok ? await res.json() : { pins: [] };
    } catch (e) {
      if (e?.name === "AbortError" || ctrl.signal.aborted) return;
      if (!searchActive || _searchAbortCtrl !== ctrl) return;
      showStatus(`Search failed: ${e.message}`);
      return;
    }

    if (ctrl.signal.aborted || !searchActive || _searchAbortCtrl !== ctrl) return;

    const items = pins.pins || [];
    const pinCount = renderPins(items);

    const cityZoom = cityHit.population >= 2_000_000 ? 7 : cityHit.population >= 500_000 ? 8 : 9;
    // A state brings its own extent, so FIT it: zooming to a point at
    // cityZoom would show a 70 km circle around the centroid of Texas
    // rather than Texas. Cities keep the point zoom they always had.
    if (Array.isArray(cityHit._bbox) && cityHit._bbox.length === 4) {
      map.fitBounds([[cityHit._bbox[0], cityHit._bbox[2]], [cityHit._bbox[1], cityHit._bbox[3]]],
        { padding: [40, 40], maxZoom: 9, animate: true });
    } else {
      map.flyTo([cityHit.lat, cityHit.lng], cityZoom, { duration: 0.5 });
    }

    const cityLabel = cityHit.state ? `${cityHit.name}, ${cityHit.state}, ${cityHit.country_code}` : `${cityHit.name}, ${cityHit.country_code}`;
    showStatus(pinCount > 0
      ? `All news in ${cityLabel} · ${pinCount} stor${pinCount === 1 ? "y" : "ies"}`
      : `No news found near ${cityLabel}`
    );
    _fireSearchFailure({ pinCount });
    return;
  }

  const pinsUrl = `/api/pins?q=${encodeURIComponent(q)}&limit=1000${since ? `&since=${encodeURIComponent(since)}` : ""}`;
  const geoUrl  = `/api/geocode?q=${encodeURIComponent(q)}`;
  const locUrl  = `/api/locations/search?q=${encodeURIComponent(q)}&limit=5`;

  fetchWikiSearch(q);
  fetchJournalistSearch(q);

  let pins, geo, locResults;
  try {
    [pins, geo, locResults] = await Promise.all([
      fetch(pinsUrl, { signal: ctrl.signal }).then((r) => r.ok ? r.json() : Promise.reject(new Error(`pins ${r.status}`))),
      fetch(geoUrl, { signal: ctrl.signal }).then((r) => r.status === 404 ? null : r.ok ? r.json() : Promise.reject(new Error(`geo ${r.status}`))),
      fetch(locUrl, { signal: ctrl.signal }).then((r) => r.ok ? r.json() : { locations: [] }).catch(() => ({ locations: [] })),
    ]);
  } catch (e) {
    if (e?.name === "AbortError" || ctrl.signal.aborted) return;
    if (!searchActive || _searchAbortCtrl !== ctrl) return;
    showStatus(`Search failed: ${e.message}`);
    return;
  }

  if (ctrl.signal.aborted || !searchActive || _searchAbortCtrl !== ctrl) return;

  const items = pins.pins || [];
  const pinCount = renderPins(items);

  const locs = locResults?.locations || [];
  const bestLoc = locs.length > 0 ? locs[0] : null;

  // A RESOLVED PLACE WINS OVER zoom:"world" — same rule and same strict
  // gate as runSearch(); see frameSearchRegion() for the whole reasoning.
  // In short: the button and Enter both pass { zoom: "world" }, so this
  // branch used to run on every explicit submit and made the flyTos
  // unreachable ("el salvador" ended at the whole world). And a place
  // only counts when it accounts for the WHOLE query, because
  // /api/locations/search?q="climate change" ranks "Climate" in Seattle
  // first and Nominatim answers with a California trail sign of that
  // name — "ukraine war" is a place, "climate change" is not.
  const framing = frameSearchRegion({
    q, geo, bestLoc, points: storyPoints(items), zoom, isBiggerPlace,
  });

  const parts = [];
  if (pinCount) parts.push(`${pinCount} match${pinCount === 1 ? "" : "es"}`);
  // A rejected anchor is a POINT OF INTEREST — a building, a stadium. The
  // reader searched a topic; naming the building in the status line
  // would be naming the thing we just refused to zoom to.
  if (bestLoc && !framing.rejectedAnchor) {
    const n = bestLoc.events_count ?? bestLoc.event_count ?? 0;
    parts.push(`${bestLoc.place_name} · ${n} ${n === 1 ? "story" : "stories"}`);
  } else if (geo && !framing.rejectedAnchor) {
    parts.push(geo.display_name);
  }
  showStatus((parts.join(" · ") || `No matches for "${escapeHtml(q)}"`) + preindexAgeNote(pins));
  _fireSearchFailure({ pinCount });
}

// ── Search Journey Tracking ────────────────────────────────────────────────
const _searchJourney = { query: null, startTime: null };
const _popupDwellMap = new Map();
const _searchMeta = { pinCount: 0, eventCount: 0, discoveryCount: 0, discoveryRelevant: 0 };

function _fireSearchJourney(eventType, extra = {}) {
  const sid = typeof XyzoAnalytics !== 'undefined' ? XyzoAnalytics.sessionId : null;
  if (!sid) return;
  const payload = { session_id: sid, event_type: eventType, query: _searchJourney.query || null, ...extra };
  fetch('/api/search/journey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true }).catch(() => {});
}

function _fireSearchFailure({ pinCount = 0, eventCount = 0, discoveryCount = 0, discoveryRelevant = 0 }) {
  const sid = typeof XyzoAnalytics !== 'undefined' ? XyzoAnalytics.sessionId : null;
  if (!sid) return;
  const q = _searchJourney.query;
  if (!q) return;
  const total = pinCount + eventCount;
  const failureType = total === 0 ? 'zero_results' : total < 3 ? 'low_diversity' : null;
  if (!failureType) return;
  const failurePayload = {
    session_id: sid,
    query: q,
    failure_type: failureType,
    matched_pins: pinCount,
    discovery_count: discoveryCount,
    discovery_relevant: discoveryRelevant,
    pin_views: pinCount,
    pin_clicks: 0,
  };
  const gapPayload = {
    query: q,
    zero_result: total === 0,
    result_count: total,
    recovered: discoveryRelevant > 0,
    recovery_method: discoveryRelevant > 0 ? 'duckduckgo' : undefined,
  };
  const post = (url, body) => {
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
  };
  post('/api/search/failure', failurePayload);
  post('/api/search/gap', gapPayload);
}

async function runSearch(opts = {}) {
  const { zoom = "auto" } = opts;
  const q = searchInput.value.trim();
  _searchJourney.query = q;
  _searchJourney.startTime = Date.now();
  if (!q) {
    clearSearch();
    return;
  }
  // A search ends the onboarding tour — see endTourForSearch().
  endTourForSearch();
  // Search results would be invisible with all marker modes off —
  // re-enable markers so the query actually shows something.
  if (!activeModes.has("markers") && !activeModes.has("clusters") &&
      !activeModes.has("heatmap")) {
    activeModes.add("markers");
    _markersDirty = true;
    try { applyLayers(); } catch (_) {}
  }
  // Update URL with search query for shareable links
  // Use pathname only (no stale hash) so shared links don't carry old map position
  const url = new URL(window.location.pathname + window.location.search, window.location.origin);
  url.searchParams.set("q", q);
  history.replaceState(null, "", url.toString());

  if (!searchActive && !_preSearchView && typeof map !== "undefined" && map) {
    _preSearchView = { center: map.getCenter(), zoom: map.getZoom() };
  }
  if (debouncedTextSearch && typeof debouncedTextSearch.cancel === "function") {
    debouncedTextSearch.cancel();
  }
  if (_searchAbortCtrl) {
    try { _searchAbortCtrl.abort(); } catch (_) {}
  }
  const ctrl = new AbortController();
  _searchAbortCtrl = ctrl;

  searchBtn.disabled = true;
  searchClear.hidden = false;
  // A search IS an active search — set the flag BEFORE the fetches.
  //
  // Both guards below (the city branch and the text branch) bail on
  // `!searchActive`, and they run before the flag was set at the end of
  // the function. A caller that did not come from a keystroke — the
  // `?q=` boot path and the `#search=` hash path both set
  // searchInput.value programmatically, which fires no `input` event —
  // therefore ran with searchActive still false, bailed at the guard,
  // and left the map empty with the status stuck on
  // `Searching "cybersecurity"…` for good.
  searchActive = true;
  showStatus(`Searching "${escapeHtml(q)}"…`);

  fetchWikiSearch(q);
  fetchJournalistSearch(q);

  const { since, until } = searchWindow();
  const cityHit = detectStateSearch(q) || detectCitySearch(q);

  if (cityHit) {
    const radius = citySearchRadius(cityHit);
    const bbox = cityToBbox(cityHit, radius);
    const bboxStr = bbox.map(n => n.toFixed(4)).join(",");
    let pinsUrl = `/api/pins/map?bbox=${bboxStr}&limit=1500`;
    if (since) pinsUrl += `&since=${encodeURIComponent(since)}`;
    if (until) pinsUrl += `&until=${encodeURIComponent(until)}`;
    if (_activeTag) pinsUrl += `&tag=${encodeURIComponent(_activeTag)}`;

    let pins;
    try {
      const res = await fetch(pinsUrl, { signal: ctrl.signal });
      pins = res.ok ? await res.json() : { pins: [] };
    } catch (e) {
      if (e?.name === "AbortError" || ctrl.signal.aborted) return;
      if (!searchActive || _searchAbortCtrl !== ctrl) return;
      showStatus(`Search failed: ${e.message}`);
      searchBtn.disabled = false;
      return;
    }

    if (ctrl.signal.aborted || !searchActive || _searchAbortCtrl !== ctrl) return;

    const items = pins.pins || [];
    const pinCount = renderPins(items);
    _fireSearchJourney('result_render', { result_count: pinCount, latency_ms: _searchJourney.startTime ? Date.now() - _searchJourney.startTime : null });

    const cityZoom = cityHit.population >= 2_000_000 ? 7 : cityHit.population >= 500_000 ? 8 : 9;
    // A state brings its own extent, so FIT it: zooming to a point at
    // cityZoom would show a 70 km circle around the centroid of Texas
    // rather than Texas. Cities keep the point zoom they always had.
    if (Array.isArray(cityHit._bbox) && cityHit._bbox.length === 4) {
      map.fitBounds([[cityHit._bbox[0], cityHit._bbox[2]], [cityHit._bbox[1], cityHit._bbox[3]]],
        { padding: [40, 40], maxZoom: 9, animate: true });
    } else {
      map.flyTo([cityHit.lat, cityHit.lng], cityZoom, { duration: 0.5 });
    }

    const cityLabel = cityHit.state ? `${cityHit.name}, ${cityHit.state}, ${cityHit.country_code}` : `${cityHit.name}, ${cityHit.country_code}`;
    showStatus(pinCount > 0
      ? `All news in ${cityLabel} · ${pinCount} stor${pinCount === 1 ? "y" : "ies"}`
      : `No news found near ${cityLabel}`
    );

    searchActive = true;
    searchBtn.disabled = false;
    searchClear.hidden = false;

    if (typeof XyzoAnalytics !== 'undefined') {
      XyzoAnalytics.trackSearch(q, pinCount);
    }
    _fireSearchFailure({ pinCount });
    return;
  }

  const pinsUrl = `/api/pins?q=${encodeURIComponent(q)}&limit=1000${since ? `&since=${encodeURIComponent(since)}` : ""}`;
  const geoUrl  = `/api/geocode?q=${encodeURIComponent(q)}`;
  const searchUrl = "/api/events/search";
  const locUrl  = `/api/locations/search?q=${encodeURIComponent(q)}&limit=5`;

  // THE FAST HALF FIRST.
  //
  // The pins, the geocode and the location match are what decide WHERE
  // the map looks, and they come back in about a second. The event
  // search spawns a Python worker and can take 30-90 s (measured: 6 s
  // warm, 90 s cold). It used to be awaited together with the rest, so
  // the reader watched the old view for a minute and a half and THEN
  // the map jumped — which is exactly how the bug was reported: "it
  // finds some articles but zooms in to an area that doesn't have any
  // stories".
  //
  // So the event request is STARTED here and AWAITED after the map has
  // been framed: it overlaps the framing instead of delaying it. It
  // never rejects — an abort comes back as { error: "aborted" } and the
  // guard below drops it — so an aborted search cannot leave an
  // unhandled rejection behind.
  const searchRespPromise = fetch(searchUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q, limit: 30 }),
    signal: ctrl.signal,
  })
    .then(async (r) => {
      if (r.status === 429) return { error: "rate_limited", detail: null };
      if (!r.ok) return { error: `http_${r.status}`, detail: null };
      const text = await r.text();
      return text ? JSON.parse(text) : {};
    })
    .catch((e) => {
      if (e?.name === "AbortError" || ctrl.signal.aborted) return { error: "aborted", detail: null };
      return { error: e.message, detail: null };
    });

  // ── THE SAVED ANSWER ────────────────────────────────────────────────
  //
  // A text search is the slowest thing on the site — the pin query
  // measures 3-50 s cold and the event search 30-90 s — so a repeat
  // search must not make the reader wait for an answer they have already
  // seen. The previous answer is kept (public_html/saved-searches.js)
  // and shown at once, with a note that the fresh one is on its way;
  // when it lands it replaces the old one.
  //
  // The lookup is STARTED here, in parallel with the fetches, so it
  // costs nothing but a tick. The framing is NOT saved as a decision:
  // the saved copy is framed by the SAME function that frames a live
  // search (frameSearchRegion), so a saved search can never put the
  // map somewhere a fresh one would not.
  //
  // The key carries the TIME WINDOW, not the timestamp the window was
  // computed from: getSinceDate() snaps to a 60-second boundary, so a
  // timestamp in the key changes every minute and the saved answer would
  // never be found again.
  const windowKey = timeFilter === "custom"
    ? `custom:${customDays}`
    : (timeFilter || "all");
  const savedKey = window.SavedSearches
    ? SavedSearches.keyFor(q, windowKey, _activeTag)
    : null;
  const savedPromise = savedKey ? SavedSearches.get(savedKey) : Promise.resolve(null);

  // The fast fetches run WHILE the saved answer is looked up and shown —
  // that is the whole point: the reader gets the previous answer in a
  // tick instead of waiting 3–50 s for the pin query.
  //
  // The promise is settled into a value rather than allowed to reject:
  // it is awaited LATER (after the saved answer has been painted), and an
  // un-awaited rejection is an unhandled rejection.
  const fastFetches = Promise.all([
    fetch(pinsUrl, { signal: ctrl.signal }).then(async (r) => {
      if (!r.ok) throw new Error(`pins ${r.status}`);
      const text = await r.text();
      return text ? JSON.parse(text) : {};
    }),
    fetch(geoUrl, { signal: ctrl.signal }).then(async (r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`geo ${r.status}`);
      const text = await r.text();
      return text ? JSON.parse(text) : {};
    }),
    fetch(locUrl, { signal: ctrl.signal }).then(async (r) => {
      if (!r.ok) return { locations: [] };
      const text = await r.text();
      return text ? JSON.parse(text) : { locations: [] };
    }).catch(() => ({ locations: [] })),
  ]).then(
    (v) => ({ ok: true, v }),
    (e) => ({ ok: false, e })
  );

  // Show the SAVED answer now — while the fresh one is still being
  // fetched — so the reader has something on the map immediately.
  let shownSaved = false;
  const saved = await savedPromise;
  if (saved && !ctrl.signal.aborted && searchActive && _searchAbortCtrl === ctrl &&
      Array.isArray(saved.pins) && saved.pins.length) {
    shownSaved = true;
    renderPins(saved.pins);
    if (Array.isArray(saved.events) && saved.events.length) {
      try { await renderEvents(saved.events); } catch (_) {}
    }
    try {
      frameSearchRegion({
        q, geo: saved.geo || null, bestLoc: saved.bestLoc || null,
        points: storyPoints(saved.pins), zoom: saved.zoom || "auto",
        isBiggerPlace,
      });
    } catch (_) {}
    const when = saved.at ? new Date(saved.at) : null;
    showStatus(`Showing saved results${when ? ` from ${when.toLocaleDateString()}` : ""} · searching for newer…`);
  }

  const fetched = await fastFetches;
  if (!fetched.ok) {
    const e = fetched.e;
    if (e?.name === "AbortError" || ctrl.signal.aborted) return;
    if (!searchActive || _searchAbortCtrl !== ctrl) return;
    showStatus(`Search failed: ${e.message}`);
    searchBtn.disabled = false;
    return;
  }
  const [pins, geo, locResults] = fetched.v;

  if (ctrl.signal.aborted || !searchActive || _searchAbortCtrl !== ctrl) return;

  const pinCount = renderPins(pins.pins || []);
  _fireSearchJourney('result_render', { result_count: pinCount, latency_ms: _searchJourney.startTime ? Date.now() - _searchJourney.startTime : null });

  const locs = locResults?.locations || [];
  const bestLoc = locs.length > 0 ? locs[0] : null;

  // A RESOLVED PLACE WINS OVER zoom:"world" — but only when the query IS
  // a place, not when it merely CONTAINS a place word.
  //
  // Both the search button and Enter call runSearch({ zoom: "world" }),
  // so that branch ran on EVERY explicit submit and zoomToWorld() won,
  // making the flyTo below unreachable. Measured: searching "el salvador"
  // from Sydney (-33.87,151.21 z10) ended at 20,0 ZOOM 2 — the whole
  // world — while the status line read "… · El Salvador · 82 stories".
  //
  // The gate, the point-of-interest rule and the region calculation all
  // live in frameSearchRegion() — ONE implementation, shared with
  // runTextSearch(). See the comment there for the measured cases.
  //
  // The points are the STORIES: the pins and the events. The events of
  // the resolved location (locEvents) are deliberately NOT among them —
  // they are the stories OF that place, and when the place is rejected
  // as a point of interest they would drag the region back onto it.
  //
  // The pins alone are enough to frame the region, and the events land
  // in the same places — so the map moves NOW, not after the event
  // search. A search with no pins at all has no region to frame, and
  // waits for the events below.
  const pinPoints = storyPoints(pins.pins);
  let framing = null;
  if (pinPoints.length) {
    framing = frameSearchRegion({ q, geo, bestLoc, points: pinPoints, zoom, isBiggerPlace });
  }

  const searchResp = await searchRespPromise;
  if (ctrl.signal.aborted || !searchActive || _searchAbortCtrl !== ctrl) return;

  const events = (!searchResp.error && Array.isArray(searchResp.events)) ? searchResp.events : [];
  const eventCount = await renderEvents(events);

  if (ctrl.signal.aborted || !searchActive || _searchAbortCtrl !== ctrl) return;

  let locEventCount = 0;

  // The events of a REJECTED place are not fetched at all. A rejected
  // place is a point of interest or an uncorroborated name-match, and
  // its stories have nothing to do with the query — fetching them cost
  // a round trip and put unrelated markers on the map.
  if (bestLoc && !framing?.rejectedAnchor && ((bestLoc.events_count ?? bestLoc.event_count ?? 0) > 0)) {
    try {
      // Fetch events mentioning this location name
      const locEvRes = await fetch(`/api/events?q=${encodeURIComponent(bestLoc.place_name)}&limit=50`, { signal: ctrl.signal });
      if (locEvRes.ok && !ctrl.signal.aborted && searchActive) {
        const text = await locEvRes.text();
        const locEvData = text ? JSON.parse(text) : {};
        const locEvents = locEvData.events || [];
        locEventCount = await renderEvents(locEvents);
      }
    } catch (_) {}
  }

  if (ctrl.signal.aborted || !searchActive || _searchAbortCtrl !== ctrl) return;

  // No pins meant there was no region to frame a second ago; the events
  // may know one.
  if (!framing) {
    framing = frameSearchRegion({
      q, geo, bestLoc, points: storyPoints(pins.pins, events), zoom,
      isBiggerPlace,
    });
  }

  // Note: we do NOT call fetchPinsForViewport() here — pins were already
  // fetched via /api/pins?q= above and rendered by renderPins().  Calling
  // fetchPinsForViewport() would fire a redundant /api/pins/map request
  // and re-render, adding latency without benefit.

  // ── SAVE THIS ANSWER ─────────────────────────────────────────────────
  //
  // So the NEXT search for the same thing is instant: the saved answer
  // is shown at once and the fresh one replaces it when it lands.
  //
  // What is saved is the pin list (SLIMMED — no `word_freq`, which is
  // 45 % of the payload and which the popup fetches on demand), the
  // event list, and the two small lookups the framing needs. The
  // framing itself is NOT saved as a decision: it is recomputed by the
  // same function that frames a live search.
  if (savedKey && window.SavedSearches && pins && pins.pins && pins.pins.length) {
    try {
      const slimPins = pins.pins.map((p) => {
        const c = Object.assign({}, p);
        delete c.word_freq;
        return c;
      });
      SavedSearches.put(savedKey, {
        pins: slimPins,
        events: Array.isArray(events) ? events : [],
        geo: geo || null,
        bestLoc: bestLoc || null,
        zoom,
      });
    } catch (_) {}
  }

  // Build a useful status line per outcome.
  //
  // A REJECTED anchor is a point of interest — a building, a stadium. The
  // reader searched a topic, so naming the building in the status line
  // would be naming the very thing we just refused to zoom to.
  const showPlace = !framing.rejectedAnchor;
  // A rejected place has no stories to offer, so it offers no "Show All"
  // button either — the count came from the place we just refused.
  const totalLocEvents = showPlace
    ? (bestLoc ? (bestLoc.events_count ?? bestLoc.event_count ?? 0) : 0) + locEventCount
    : 0;
  const locPart = (bestLoc && showPlace)
    ? `${bestLoc.place_name} · ${totalLocEvents} ${totalLocEvents === 1 ? "story" : "stories"}`
    : "";

  // Quick action button if more location stories exist than current time window matches
  let timeActionBtn = "";
  if (totalLocEvents > pinCount && timeFilter !== "all") {
    if (timeFilter === "24h") {
      timeActionBtn = ` <button class="search-status-action-btn" onclick="setTimeFilter('7d')" title="Show stories from past 7 days">Show 7 Days</button> <button class="search-status-action-btn" onclick="setTimeFilter('all')" title="Show all indexed stories">Show All ${totalLocEvents}</button>`;
    } else if (timeFilter === "7d") {
      timeActionBtn = ` <button class="search-status-action-btn" onclick="setTimeFilter('30d')" title="Show stories from past 30 days">Show 30 Days</button> <button class="search-status-action-btn" onclick="setTimeFilter('all')" title="Show all indexed stories">Show All ${totalLocEvents}</button>`;
    } else {
      timeActionBtn = ` <button class="search-status-action-btn" onclick="setTimeFilter('all')" title="Show all indexed stories">Show All ${totalLocEvents}</button>`;
    }
  }

  // The saved answer has just been replaced by the fresh one — say so.
  const freshNote = shownSaved ? " · updated ✓" : "";
  // A PRE-INDEXED ANSWER SAYS HOW OLD IT IS.
  const preindexNote = preindexAgeNote(pins);
  if (searchResp.error === "rate_limited") {
    showStatus(`${pinCount} match${pinCount === 1 ? "" : "es"}${locPart ? ` · ${locPart}` : ""}${timeActionBtn} · event search rate-limited${freshNote}${preindexNote}`);
  } else if (searchResp.error) {
    showStatus(`${pinCount} match${pinCount === 1 ? "" : "es"}${eventCount ? ` · ${eventCount} new event${eventCount === 1 ? "" : "s"}` : ""}${locPart ? ` · ${locPart}` : ""}${timeActionBtn}${freshNote}${preindexNote}`);
  } else if (pinCount === 0 && eventCount === 0 && !bestLoc) {
    const discoveryHint = searchResp.discovery === "searching"
      ? ' · <span style="color:#5eead4;">🔍 Searching the web for more sources…</span>'
      : "";
    const clearHint = ' · <button class="search-status-action-btn" onclick="clearSearch()" style="background:var(--accent,#5eead4);color:#0b0f14;border:none;padding:2px 8px;border-radius:4px;font-weight:700;cursor:pointer;margin-left:4px;">Clear search & show all pins</button>';
    showStatus(`No matches for "${escapeHtml(q)}"${(geo && showPlace) ? ` · ${escapeHtml(geo.display_name)}` : ""}${discoveryHint}${clearHint}`);
  } else {
    const parts = [];
    if (pinCount) parts.push(`${pinCount} match${pinCount === 1 ? "" : "es"}`);
    if (eventCount) parts.push(`${eventCount} new event${eventCount === 1 ? "" : "s"}`);
    if (locPart) parts.push(locPart);
    else if (geo && showPlace) parts.push(geo.display_name);
    const discoveryHint = searchResp.discovery === "searching"
      ? ' · <span style="color:#5eead4;">🔍 Searching for more…</span>'
      : "";
    showStatus(parts.join(" · ") + discoveryHint + timeActionBtn + freshNote + preindexNote);
  }

  // Fire Discovery Mode polling if the event search found few results
  if (searchResp.discovery === "searching") {
    startDiscoveryPoll(q);
  }

  searchActive = true;
  searchBtn.disabled = false;
  searchClear.hidden = false;

  // Track search for analytics
  if (typeof XyzoAnalytics !== 'undefined') {
    XyzoAnalytics.trackSearch(q, pinCount + eventCount + locEventCount);
  }
  _fireSearchFailure({ pinCount, eventCount });
}

function clearSearch() {
  const clearedQuery = searchInput ? searchInput.value.trim() : null;
  if (clearedQuery) _fireSearchJourney('clear', { query: clearedQuery });

  if (debouncedTextSearch && typeof debouncedTextSearch.cancel === "function") {
    debouncedTextSearch.cancel();
  }
  if (_searchAbortCtrl) {
    try { _searchAbortCtrl.abort(); } catch (_) {}
    _searchAbortCtrl = null;
  }

  // Remove search query from URL
  const url = new URL(window.location.href);
  url.searchParams.delete("q");
  history.replaceState(null, "", url.toString());

  searchActive = false;
  if (searchInput) searchInput.value = "";
  showStatus("");
  hideDiscoveryPanel();
  if (searchClear) searchClear.hidden = true;
  if (searchBtn) searchBtn.disabled = false;
  clearWikiSearch();
  clearJournalistSearch();

  // Reset any open popup and temporary marker
  if (window.closeActivePopup) window.closeActivePopup();
  if (typeof _currentCanvasTmpMarker !== "undefined" && _currentCanvasTmpMarker && _currentCanvasTmpMarker._map) {
    try { map.removeLayer(_currentCanvasTmpMarker); } catch (_) {}
    _currentCanvasTmpMarker = null;
  }

  // Remove ALL markers from Leaflet DOM layers (markerLayer, pinCluster, eventCluster)
  clearAllMarkers();
  _markersDirty = true;

  // Clear search pins on canvas
  if (typeof canvasRenderer !== "undefined" && canvasRenderer) {
    canvasRenderer.setPins([]);
  }

  // Stay at current map position — don't restore pre-search view or world view.
  // If user searched "sydney" and zoomed in, clearing should keep them at sydney.
  _preSearchView = null;

  syncLayers();
  fetchPinsForViewport();

  // Also drop /search=<q>: the ?q= delete above never touches the hash.
  updateUrlHash();
}

function doShowAll() {
  clearSearch();
  if (typeof clearCategoryFilters === "function") clearCategoryFilters();
  if (typeof setActiveTag === "function") setActiveTag(null);
  if (typeof timeFilter !== "undefined" && timeFilter !== "24h") {
    setTimeFilter("24h");
  }
  const btn = document.getElementById("show-all-btn");
  if (btn) btn.hidden = true;
}

searchBtn.addEventListener("click", () => runSearch({ zoom: "world" }));
searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim();
  if (!q) {
    clearSearch();
  } else {
    if (!_preSearchView && typeof map !== "undefined" && map) {
      _preSearchView = { center: map.getCenter(), zoom: map.getZoom() };
    }
    searchActive = true;
    if (searchClear) searchClear.hidden = false;
    debouncedTextSearch();
  }
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runSearch({ zoom: "world" });  // explicit submit: zoom out to world view
  } else if (e.key === "Escape" && searchActive) {
    e.preventDefault();
    clearSearch();
  } else {
    // Any other keystroke: cheap pins+geocode preview, debounced.
    debouncedTextSearch();
  }
});
searchClear.addEventListener("click", clearSearch);

// ── Discovery Mode panel init ────────────────────────────────────────────
_discoveryPanel = document.getElementById("discovery-panel");
const _discoveryCloseBtn = document.getElementById("discovery-close");
const _discoveryResults = document.getElementById("discovery-results");
const _discoveryLoading = document.getElementById("discovery-loading");

_discoveryCloseBtn?.addEventListener("click", () => {
  if (_discoveryPanel) _discoveryPanel.hidden = true;
  if (_discoveryPollInterval) { clearInterval(_discoveryPollInterval); _discoveryPollInterval = null; }
});

function showDiscoveryPanel() {
  if (!_discoveryPanel) return;
  _discoveryPanel.hidden = false;
  _discoveryResults.innerHTML = "";
  _discoveryLoading.hidden = false;
}

function hideDiscoveryPanel() {
  if (!_discoveryPanel) return;
  _discoveryPanel.hidden = true;
  if (_discoveryPollInterval) { clearInterval(_discoveryPollInterval); _discoveryPollInterval = null; }
}

function renderDiscoveryResults(results, query) {
  if (!_discoveryPanel || !_discoveryResults) return;
  _discoveryLoading.hidden = true;

  if (!results || results.length === 0) {
    _discoveryResults.innerHTML = `<div class="discovery-loading"><span>No web results found for "${escapeHtml(query)}"</span></div>`;
    return;
  }

  _discoveryResults.innerHTML = results.map(r => {
    const title = escapeHtml(r.title || "Untitled");
    const source = escapeHtml(r.source || new URL(r.url).hostname);
    const snippet = escapeHtml(r.snippet || "");
    const articleUrl = escapeAttr(r.url);
    return `
      <div class="discovery-item" onclick="window.open(${JSON.stringify(articleUrl)},'_blank','noopener')">
        <div class="discovery-item-icon">🌐</div>
        <div class="discovery-item-body">
          <div class="discovery-item-title" title="${title}">${title}</div>
          <div class="discovery-item-source">${source}</div>
          ${snippet ? `<div class="discovery-item-snippet">${snippet}</div>` : ""}
          <a class="discovery-item-link" href="${articleUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Read article →</a>
        </div>
      </div>
    `;
  }).join("");
}

async function pollDiscoveryResults(query) {
  if (!_discoveryPollInterval) return;
  _discoveryPollCount++;
  if (_discoveryPollCount > MAX_DISCOVERY_POLLS) {
    clearInterval(_discoveryPollInterval);
    _discoveryPollInterval = null;
    return;
  }
  try {
    const res = await fetch(`/api/search/discovery?q=${encodeURIComponent(query)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.status === "ready" && data.results?.length > 0) {
      clearInterval(_discoveryPollInterval);
      _discoveryPollInterval = null;
      renderDiscoveryResults(data.results, query);
    }
  } catch (_) {}
}

function startDiscoveryPoll(query) {
  if (_discoveryPollInterval) clearInterval(_discoveryPollInterval);
  _discoveryPollCount = 0;
  showDiscoveryPanel();
  // Poll every 3s, up to MAX_DISCOVERY_POLLS times
  _discoveryPollInterval = setInterval(() => pollDiscoveryResults(query), 3000);
  // Also try immediately
  pollDiscoveryResults(query);
}

// ── Search Intelligence Gaps Panel ─────────────────────────────────────────
let _gapsPanel = null;
let _gapsPanelOpen = false;
let _gapsFetchController = null;

function showGapsPanel() {
  if (!_gapsPanel) return;
  _gapsPanel.hidden = false;
  _gapsPanelOpen = true;
  if (_gapsFetchController) _gapsFetchController.abort();
  _gapsFetchController = new AbortController();
  loadGapsData();
}

function hideGapsPanel() {
  if (!_gapsPanel) return;
  _gapsPanel.hidden = true;
  _gapsPanelOpen = false;
  if (_gapsFetchController) { _gapsFetchController.abort(); _gapsFetchController = null; }
}

function renderGapsData(gaps) {
  const content = document.getElementById("gaps-content");
  const empty = document.getElementById("gaps-empty");
  const loading = document.getElementById("gaps-loading");
  if (!content || !empty || !loading) return;
  loading.hidden = true;
  if (!gaps || gaps.length === 0) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;

  const items = gaps.map(g => {
    const zeroRate = g.zero_rate_pct ?? 0;
    const dotClass = zeroRate >= 70 ? "danger" : zeroRate >= 40 ? "warning" : "ok";
    const searches = g.search_count ?? 0;
    const domain = g.domain || "general";
    const intent = g.intent || "unknown";
    return `
      <div class="gaps-item">
        <div class="gaps-item-query">${escapeHtml(g.query_cluster || "?")}</div>
        <div class="gaps-item-stats">
          <div class="gaps-stat">
            <span class="gaps-stat-dot ${dotClass}"></span>
            <span class="gaps-stat-value">${zeroRate}%</span> zero-rate
          </div>
          <div class="gaps-stat">
            <span class="gaps-stat-value">${searches}</span> searches
          </div>
          ${g.avg_result_count > 0 ? `<div class="gaps-stat"><span class="gaps-stat-value">${g.avg_result_count.toFixed(1)}</span> avg results</div>` : ""}
        </div>
        <div class="gaps-item-domain">${escapeHtml(domain)} · ${escapeHtml(intent)}</div>
      </div>
    `;
  }).join("");

  content.innerHTML = `<div class="gaps-section-header">Top Opportunity Gaps</div>${items}`;
}

async function loadGapsData() {
  const loading = document.getElementById("gaps-loading");
  const empty = document.getElementById("gaps-empty");
  const content = document.getElementById("gaps-content");
  if (loading) loading.hidden = false;
  if (empty) empty.hidden = true;
  if (content) content.hidden = true;
  try {
    const res = await fetch("/api/search/gaps?limit=15", { signal: _gapsFetchController?.signal });
    if (!res.ok) return;
    const data = await res.json();
    renderGapsData(data.gaps || []);
  } catch (e) {
    if (e?.name === "AbortError") return;
  }
}

// Init gaps panel
window.addEventListener("DOMContentLoaded", () => {
  _gapsPanel = document.getElementById("gaps-panel");
  const toggle = document.getElementById("gaps-panel-toggle");
  const closeBtn = document.getElementById("gaps-close");
  toggle?.addEventListener("click", () => {
    if (_gapsPanelOpen) hideGapsPanel(); else showGapsPanel();
  });
  closeBtn?.addEventListener("click", hideGapsPanel);
  document.addEventListener("keydown", (e) => {
    if (e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey &&
        document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
      if (_gapsPanelOpen) hideGapsPanel(); else showGapsPanel();
    }
    if (e.key === "Escape" && _gapsPanelOpen) hideGapsPanel();
  });
});

// ── Render mode toggle (Markers + Heatmap + Clusters) ────────────────────
// Markers and heatmap can coexist. Markers and clusters are mutually exclusive.
// Each button is an independent toggle; clicking an active button turns it off.
const VALID_MODES = new Set(["heatmap", "markers", "clusters"]);
const MARKER_MIN_ZOOM = 5;
// Mode buttons are now in the markers-dropdown-menu
function getModeButtons() {
  return document.querySelectorAll("#markers-dropdown-menu button[data-mode]");
}
const MODE_BUTTONS = getModeButtons();

function applyLayers() {
  window.closeActivePopup();

  if (map.hasLayer(pinCluster))    map.removeLayer(pinCluster);
  if (map.hasLayer(eventCluster))  map.removeLayer(eventCluster);
  if (map.hasLayer(markerLayer))   map.removeLayer(markerLayer);
  if (map.hasLayer(heatLayer))     map.removeLayer(heatLayer);

  if (activeModes.has("heatmap"))  map.addLayer(heatLayer);
  if (activeModes.has("markers"))  map.addLayer(markerLayer);
  if (activeModes.has("clusters")) {
    map.addLayer(pinCluster);
    map.addLayer(eventCluster);
    // When switching to clusters, populate pinMarkers if needed so MarkerClusterGroup has pins
    const pinsToCluster = (typeof canvasRenderer !== "undefined" && canvasRenderer && Array.isArray(canvasRenderer._pins) && canvasRenderer._pins.length > 0)
      ? canvasRenderer._pins
      : Array.from(pinMarkers.values()).map(m => m._pinData).filter(Boolean);
    if (pinsToCluster.length > 0) {
      pinMarkers.clear();
      pinCluster.clearLayers();
      renderPins(pinsToCluster);
    }
  }

  // Canvas renderer: show canvas ONLY when markers mode is active.
  // In clusters mode or heatmap-only mode, hide the canvas so users see
  // clusters or the heat overlay cleanly without individual canvas pins.
  const showCanvas = activeModes.has("markers");
  if (typeof canvasRenderer !== "undefined" && canvasRenderer._canvas) {
    canvasRenderer._canvas.style.display = showCanvas ? "" : "none";
    if (showCanvas) {
      canvasRenderer._scheduleRedraw();
    }
  } else if (activeModes.has("markers") && pinMarkers.size > 0) {
    const pins = Array.from(pinMarkers.values()).map(m => m._pinData).filter(Boolean);
    if (pins.length > 0) {
      pinMarkers.clear();
      markerLayer.clearLayers();
      renderPins(pins);
    }
  }

  // All marker-ish modes off → drop pin data entirely, not just hide it.
  // Turning anything back on triggers a fresh fetch anyway. (Heatmap
  // builds its points from canvasRenderer._pins, so it must count too.)
  if (!activeModes.has("markers") && !activeModes.has("clusters") &&
      !activeModes.has("heatmap")) {
    if (typeof canvasRenderer !== "undefined" && canvasRenderer._pins.length > 0) {
      canvasRenderer.setPins([]);
    }
    clearAllMarkers();
  }

  rebuildHeatPoints();
  syncLayers();
  if (activeModes.has("heatmap")) commitHeat();
  map.invalidateSize(false);

  // After switching modes, ensure the canvas renderer has pins to display.
  // When switching from clusters to markers, the canvas might be empty.
  // Heat & clusters build on the same pin data, so any pin-consuming mode
  // turning on must trigger the fetch (fetchPinsForViewport no-ops when
  // all modes are off).
  if ((activeModes.has("markers") || activeModes.has("clusters") ||
       activeModes.has("heatmap")) && typeof fetchPinsForViewport === "function") {
    fetchPinsForViewport();
  }

  for (const b of getModeButtons()) {
    const isActive = activeModes.has(b.dataset.mode);
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-pressed", isActive ? "true" : "false");
  }

  // Update the markers dropdown button label to reflect active mode
  const markersLabel = document.getElementById("markers-dropdown-label");
  if (markersLabel) {
    const activeLabel = activeModes.has("heatmap") ? "Heatmap" :
                        activeModes.has("clusters") ? "Clusters" : "Markers";
    markersLabel.textContent = activeLabel;
  }

  try {
    const stored = [...activeModes].join(",");
    localStorage.setItem(MODE_STORAGE_KEY, stored);
  } catch (_) {}
}

// THE TIME MACHINE calls this when the reader picks a past moment: the
// three weather layers have to be re-added so they fetch the ARCHIVED
// grid instead of the live one.
window.applyLayers = applyLayers;


function loadStoredModes() {
  try {
    const raw = localStorage.getItem(MODE_STORAGE_KEY);
    if (raw === null || raw === "") return new Set(["markers"]);
    const modes = new Set(raw.split(",").filter(m => VALID_MODES.has(m)));
    return modes;
  } catch (_) {
    return new Set(["markers"]);
  }
}

// Boot: restore stored modes, apply layers, wire clicks.
const stored = loadStoredModes();
activeModes.clear();
for (const m of stored) activeModes.add(m);
try { applyLayers(); } catch (e) { XLog.warn("applyLayers failed during boot", e); }

window.setRenderMode = window.setMode = function(mode) {
  if (!VALID_MODES.has(mode)) return;
  if (mode === "clusters") {
    activeModes.delete("markers");
    activeModes.add("clusters");
  } else if (mode === "markers") {
    activeModes.delete("clusters");
    activeModes.add("markers");
  } else if (mode === "heatmap") {
    activeModes.add("heatmap");
  }
  _markersDirty = true;
  applyLayers();
};

// Restore time-filter choice before the first fetchPinsForViewport() runs.
function loadStoredTimeFilter() {
  try {
    const f = localStorage.getItem(TIME_STORAGE_KEY);
    const d = localStorage.getItem(CUSTOM_DAYS_STORAGE_KEY);
    if (d != null) {
      const n = Number(d);
      if (Number.isFinite(n) && n >= 1 && n <= 90) customDays = Math.floor(n);
    }
    if (f && ["all", "24h", "3d", "7d", "30d", "365d", "custom"].includes(f)) return f;
  } catch (_) {}
  return "24h";
}
{
  const stored = loadStoredTimeFilter();
  // setTimeFilter will re-fetch pins, but fetchPinsForViewport() is called
  // below anyway — use persist:false the first time so we don't churn
  // localStorage with the same value we just read out of it.
  setTimeFilter(stored, { persist: false });
}

// ── Icon legend ─────────────────────────────────────────────────────────
// Render an expandable dropdown listing every icon category / sub-type /
// news source that can appear on the map. The swatches reuse the same SVG
// the markers use so the legend stays in lockstep with iconFor().
// The legend panel is hidden by default; the toolbar "Legend" button reveals it.
(function initLegendButton() {
  const btn = document.getElementById("legend-btn");
  const panel = document.getElementById("legend");
  const closeBtn = document.getElementById("legend-close");
  if (!btn || !panel) return;
  btn.addEventListener("click", () => {
    const hidden = panel.hidden;
    panel.hidden = !hidden;
    if (hidden) {
      renderLegend();
      panel.open = true;
    } else {
      panel.open = false;
    }
  });
  if (closeBtn) {
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      panel.open = false;
      panel.hidden = true;
    });
  }
})();

// ── Reload pins (manual refresh button) ───────────────────────────────
// User-triggered escape hatch for the mobile pan-pin-bug: if a pan or
// zoom didn't end up with the right pins (stale fetch race, transient
// network failure), the user can tap "Reload" to force fetchPinsForViewport
// to run again with the current viewport. Spins the icon for ~1s for
// visual feedback. Bypasses the 250ms throttle wrapper because the user
// asked for it explicitly.
(function initReloadPinsButton() {
  const btn = document.getElementById("reload-pins-btn");
  if (!btn) return;

  const SPIN_MS = 1000;
  let spinTimer = null;

  const onReload = () => {
    // Cancel any pending spin so back-to-back taps restart cleanly.
    if (spinTimer) { clearTimeout(spinTimer); spinTimer = null; }
    btn.classList.add("spinning");
    try {
      // _staleBannerUserDismissed is reset by retryLivePins(); mirror that
      // behaviour so a retry actually clears the "cached pins" banner.
      _staleBannerUserDismissed = false;
      hideStaleBanner();
      fetchPinsForViewport();
    } catch (e) {
      XLog.warn("reload-pins failed", e);
    } finally {
      spinTimer = setTimeout(() => {
        btn.classList.remove("spinning");
        spinTimer = null;
      }, SPIN_MS);
    }
  };

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    onReload();
  });
  // Enter / Space already fire on <button>, so no extra keydown handler.
})();

function renderLegend() {
  const body = document.getElementById("legend-body");
  // The button was renamed to #ctrl-legend-btn when the control menu was
  // introduced — looking only for the old id meant the "filter active"
  // indicator never appeared.
  const btn = document.getElementById("legend-btn") ||
              document.getElementById("ctrl-legend-btn");
  if (btn) {
    btn.classList.toggle("has-filter", _activeCategoryFilters.size > 0);
    if (_activeCategoryFilters.size > 0) {
      btn.setAttribute("title", `Legend (${_activeCategoryFilters.size} category filters active)`);
    } else {
      btn.setAttribute("title", "Show icon legend");
    }
  }
  if (!body) return;
  const rows = buildLegendRows();
  const clearRow = _activeCategoryFilters.size > 0
    ? `<div class="legend-clear-bar" style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;margin-bottom:8px;background:rgba(94,234,212,0.12);border:1px solid rgba(94,234,212,0.3);border-radius:4px;font-size:12px;">
        <span style="color:var(--accent,#5eead4);">Filtered by ${_activeCategoryFilters.size} ${_activeCategoryFilters.size === 1 ? 'category' : 'categories'}</span>
        <button type="button" onclick="clearCategoryFilters()" style="background:none;border:none;color:var(--accent,#5eead4);text-decoration:underline;cursor:pointer;padding:0;font-size:12px;font-weight:600;">Clear filter</button>
      </div>`
    : "";
  const html = rows.map((row) => {
    if (row.type === "header") {
      return `<div class="legend-header">${escapeHtml(row.label)}</div>`;
    }
    if (row.type === "special") {
      const isActive = _activeCategoryFilters.size === 0 || _activeCategoryFilters.has(row.key);
      return `
        <div class="legend-row legend-special-row ${!isActive ? 'legend-filtered' : ''}"
             data-legend-key="${escapeHtml(row.key)}"
             role="button"
             tabindex="0"
             style="cursor:pointer;opacity:${isActive ? 0.95 : 0.4};padding:5px 8px;">
          ${row.iconHtml}
          <span class="legend-label">
            <span style="font-weight:600;">${escapeHtml(row.label)}</span>
            <span class="legend-key" style="font-size:10px;color:var(--muted);display:block;">${escapeHtml(row.sublabel)}</span>
          </span>
        </div>`;
    }
    const isActive = _activeCategoryFilters.size === 0 || _activeCategoryFilters.has(row.key);
    const cls = [
      "legend-row",
      row.indent ? "indent" : "",
      row.isSource ? "is-source" : "",
      row.isFallback ? "is-fallback" : "",
      !isActive ? "legend-filtered" : "",
    ].filter(Boolean).join(" ");
    // "Find" button is offered on category rows only — source-type rows
    // (rss/editorial/community/other) describe what a pin *is*, not a topic
    // we can search a region for. The user can still filter them by clicking.
    const findBtn = row.isSource || row.isFallback
      ? ""
      : `<button type="button" class="legend-find-btn"
                 data-find-key="${escapeHtml(row.key)}"
                 aria-label="Find more ${escapeHtml(row.label)} stories in this region"
                 title="Find more ${escapeHtml(row.label)} stories in the current map region">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none"
               stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
          </svg>
          <span>Find</span>
        </button>`;
    return `
      <div class="${cls}" data-legend-key="${escapeHtml(row.key)}" role="button" tabindex="0">
        <span class="legend-sw" style="--c:${row.color}" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
               aria-hidden="true">${row.path}</svg>
        </span>
        <span class="legend-label">
          <span>${escapeHtml(row.label)}</span>
          <span class="legend-key">${escapeHtml(row.key)}</span>
        </span>
        ${findBtn}
      </div>`;
  }).join("");
  body.innerHTML = `${clearRow}${html}<div class="legend-footnote">Click a category to filter the map. Click <em>Find</em> to search this region for new stories. Click any pin to read the source article.</div>`;
  // Wire click handlers on legend rows.
  body.querySelectorAll(".legend-row[data-legend-key]").forEach((el) => {
    el.addEventListener("click", () => toggleCategoryFilter(el.dataset.legendKey));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCategoryFilter(el.dataset.legendKey); }
    });
  });
  // Wire "Find" buttons — stop propagation so the row's filter-toggle
  // handler doesn't also fire when the user only wants to search the region.
  body.querySelectorAll(".legend-find-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      findStoriesForCategory(btn.dataset.findKey);
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        findStoriesForCategory(btn.dataset.findKey);
      }
    });
  });
}

// Shared explore-region request helper: handles synchronous replies as well as
// asynchronous 202 replies by polling /api/discovery-status/:id until completion.
async function requestExploreRegion(body) {
  const resp = await fetch("/api/explore-region", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok && resp.status !== 202) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.message || err.error || `HTTP ${resp.status}`);
  }

  let data = await resp.json();

  // If async / 202 or requestId without direct results, poll /api/discovery-status/:id
  if (resp.status === 202 || data?.kind === "async" || (data?.requestId && !data?.cities)) {
    const reqId = data.requestId;
    let pollCount = 0;
    const maxPolls = 60; // 60 * 2s = 120s
    while (pollCount < maxPolls) {
      await new Promise((r) => setTimeout(r, 2000));
      pollCount++;
      try {
        const pollRes = await fetch(`/api/discovery-status/${reqId}`);
        if (!pollRes.ok) continue;
        const pollData = await pollRes.json();
        if (pollData.status === "completed" && pollData.result) {
          return pollData.result;
        } else if (pollData.status === "failed") {
          throw new Error(pollData.error || "Discovery job failed");
        } else if (pollData.current_step || pollData.step_detail) {
          if (typeof showExploreStatus === "function") {
            showExploreStatus(`Exploring: ${pollData.step_detail || pollData.current_step}…`, true);
          }
          if (typeof updateStatusPanel === "function") {
            updateStatusPanel(pollData.current_step, pollData.step_detail, pollData.progress);
          }
        }
      } catch (pollErr) {
        if (pollErr.message && pollErr.message.includes("failed")) throw pollErr;
      }
    }
  }

  return data;
}

// Search the current map region for new stories in a given category.
// Reuses the same explore-region worker as the auto-discovery flow, but
// runs unconditionally on click — the user has explicitly asked for it,
// so we skip the "no pins in viewport" prompt and go straight to work.
//
// After the search completes, a follow-up chat UI is injected into the
// status panel so the user can ask the AI why nothing was found, request
// a different angle, or just probe the results.
async function findStoriesForCategory(categoryKey) {
  if (!categoryKey) return;
  const center = map.getCenter();
  const bounds = map.getBounds();
  const bbox = [
    bounds.getWest().toFixed(4),
    bounds.getSouth().toFixed(4),
    bounds.getEast().toFixed(4),
    bounds.getNorth().toFixed(4)
  ].join(',');

  // Show the status panel up front so the user sees something is happening.
  const panel = createStatusPanel();
  updateStatusPanel('detect', `Finding ${categoryKey} stories in this region...`, 10);
  updateStatusLocation(`📍 ${center.lat.toFixed(2)}°, ${center.lng.toFixed(2)}° • Topic: ${categoryKey}`);

  // Capture context for the post-search follow-up chat.
  const discoveryContext = {
    category: categoryKey,
    bbox,
    center: { lat: center.lat, lng: center.lng },
    timestamp: new Date().toISOString(),
  };

  try {
    updateStatusPanel('cities', 'Looking up nearby cities...', 20);

    const data = await requestExploreRegion({
      bbox,
      auto_add: true,
      category_hint: categoryKey,
    });

    updateStatusPanel('search', 'Searching existing coverage...', 30);
    updateStatusPanel('web_search', 'Searching the web for news sources...', 45);
    updateStatusPanel('discover', 'AI suggesting additional sources...', 60);
    updateStatusPanel('validate', 'Validating RSS feeds...', 75);
    updateStatusPanel('add', 'Adding new sources...', 90);

    const sourcesAdded = data.added_sources?.length || 0;
    const discovered = data.discovered_sources?.length || 0;
    const validated = data.validated_sources?.length || 0;
    const existing = data.existing_news?.total ?? data.existing_news?.count ?? 0;
    const citiesFound = data.cities?.length || 0;
    const webSearch = data.web_search || {};
    const webDomains = webSearch.domains?.length || 0;
    const webValidated = webSearch.validated_count || 0;
    const webQueries = webSearch.queries || [];
    // Server-side flag: the worker hit its 60s timeout but managed to
    // flush a partial result before being killed. Show a softer
    // "search was cut short" line in the summary rather than the usual
    // ✓ complete state.
    const wasPartial = data.partial === true;

    if (wasPartial) {
      updateStatusPanel('complete', 'Search cut short (partial result)', 95);
    } else {
      updateStatusPanel('complete', 'Search complete!', 100);
    }

    // Build a structured summary so the follow-up chat can quote it back.
    const summary = {
      cities: citiesFound,
      countries: data.countries || [],
      cities_list: (data.cities || []).map(c => c.name).slice(0, 8),
      existing_count: existing,
      web_queries: webQueries,
      web_domains: webDomains,
      web_validated: webValidated,
      discovered_count: discovered,
      validated_count: validated,
      added_count: sourcesAdded,
    };
    discoveryContext.result = summary;

    const citiesLine = citiesFound > 0
      ? `<div>Covered <strong>${citiesFound}</strong> ${citiesFound === 1 ? 'city' : 'cities'} ${summary.cities_list.length ? `(${escapeHtml(summary.cities_list.slice(0, 4).join(', '))}${summary.cities_list.length > 4 ? '…' : ''})` : ''}.</div>`
      : '';
    const existingLine = existing > 0
      ? `<div>Found <strong>${existing}</strong> existing ${escapeHtml(categoryKey)} ${existing === 1 ? 'story' : 'stories'} already in the database.</div>`
      : `<div style="color: var(--muted);">No existing ${escapeHtml(categoryKey)} stories in the database for this region.</div>`;
    const webLine = webDomains > 0
      ? `<div>Web search checked <strong>${webDomains}</strong> ${webDomains === 1 ? 'domain' : 'domains'}${webValidated > 0 ? `, validated <strong>${webValidated}</strong> RSS feed${webValidated === 1 ? '' : 's'}` : ''}.</div>`
      : `<div style="color: var(--muted);">Web search returned no candidate domains${webQueries.length ? ` (tried: ${escapeHtml(webQueries.slice(0, 3).join('; '))})` : ''}.</div>`;
    const addLine = sourcesAdded > 0
      ? `<div style="color:#22c55e;">✓ Added <strong>${sourcesAdded}</strong> new source${sourcesAdded === 1 ? '' : 's'} covering ${escapeHtml(categoryKey)} news.</div>`
      : `<div style="color:#f59e0b;">� No new sources added. ${validated > 0 ? `${validated} candidate${validated === 1 ? '' : 's'} failed validation or already existed.` : 'See follow-up below to try a different angle.'}</div>`;
    // If the worker hit its 60s budget mid-flight, swap the green check
    // for an amber "partial" banner so the user understands why fewer
    // results than expected might have come back.
    const headerLine = wasPartial
      ? `<div style="color:#f59e0b; font-weight:600; margin-bottom:4px;">� Search cut short (partial result)</div>
         <div style="font-size:11px;color:var(--muted);margin-bottom:6px;">The worker ran out of time. Results shown above are everything it managed to add before the timeout — try a smaller map area for a fuller search.</div>`
      : `<div style="color: #22c55e; font-weight:600; margin-bottom:4px;">✓ Search complete</div>`;

    updateStatusSummary(`
      ${headerLine}
      ${citiesLine}
      ${existingLine}
      ${webLine}
      ${addLine}
    `, sourcesAdded > 0 ? (wasPartial ? 'warning' : 'success') : 'warning');

    // Inject the follow-up Q&A panel so the user can keep probing the AI.
    renderFollowUpChat(discoveryContext);

    // Refresh pins after a short delay so newly-added sources have a chance
    // to be fetched and geocoded before we re-query the viewport.
    if (sourcesAdded > 0) {
      setTimeout(() => fetchPinsForViewport(), 3000);
    }
  } catch (e) {
    XLog.error('[find-stories] Failed:', e);
    updateStatusPanel('complete', 'Search failed', 100);
    updateStatusSummary(`
      <div style="color: #ef4444;">✗ Search failed</div>
      <div style="margin-top: 4px; font-size: 11px;">${escapeHtml(e.message)}</div>
    `, 'error');
    // Still offer the follow-up chat so the user can ask the AI for help.
    renderFollowUpChat(discoveryContext);
  }
}

// Build the follow-up Q&A UI inside the status panel. The chat accumulates
// a small transcript (Q + A pairs) and re-sends the full transcript to
// /api/ai/chat with discovery context attached so the AI remembers what
// was tried and what was found.
function renderFollowUpChat(ctx) {
  if (!_statusPanel) return;
  // Remove any prior chat instance (e.g. user re-clicks Find).
  const existing = _statusPanel.querySelector('.status-followup');
  if (existing) existing.remove();

  const wrap = document.createElement('div');
  wrap.className = 'status-followup';
  wrap.innerHTML = `
    <div class="status-followup-header">
      <span class="status-followup-icon">💬</span>
      <span>Ask AI about this discovery</span>
    </div>
    <div class="status-followup-log" data-empty="true">
      <div class="status-followup-empty">
        Try: <em>Why didn't it find any ${escapeHtml(ctx.category)} sources?</em>
        or <em>Try searching in Spanish</em>
        or <em>What about ${escapeHtml((ctx.result?.cities_list?.[0]) || 'local')} blogs?</em>
      </div>
    </div>
    <form class="status-followup-form">
      <input type="text" class="status-followup-input"
             placeholder="Ask a follow-up question..."
             maxlength="500" autocomplete="off" />
      <button type="submit" class="status-followup-btn" aria-label="Ask">Ask</button>
    </form>
  `;
  _statusPanel.querySelector('.status-panel-body').appendChild(wrap);

  const log = wrap.querySelector('.status-followup-log');
  const form = wrap.querySelector('.status-followup-form');
  const input = wrap.querySelector('.status-followup-input');
  const btn = wrap.querySelector('.status-followup-btn');
  const transcript = []; // [{role: "user"|"assistant", content: "..."}]

  // Suggested quick-reply chips based on common follow-ups.
  const suggestions = [
    `Why didn't it find any ${ctx.category} sources?`,
    `Try a different language (e.g. Spanish, French, Arabic)`,
    `Look for blogs and independent outlets, not just major news`,
    `Expand the search to nearby cities`,
  ];
  const chips = document.createElement('div');
  chips.className = 'status-followup-chips';
  chips.innerHTML = suggestions
    .map(s => `<button type="button" class="status-followup-chip">${escapeHtml(s)}</button>`)
    .join('');
  wrap.querySelector('.status-followup-empty').appendChild(chips);
  chips.querySelectorAll('.status-followup-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      input.value = chip.textContent;
      input.focus();
    });
  });

  async function sendQuestion(text) {
    const q = (text || "").trim();
    if (!q) return;
    btn.disabled = true;
    input.disabled = true;

    // First user message — clear the empty-state placeholder.
    if (log.dataset.empty === "true") {
      log.dataset.empty = "false";
      log.innerHTML = "";
    }

    appendChatBubble(log, "user", q);
    transcript.push({ role: "user", content: q });

    const pending = appendChatBubble(log, "assistant", "Thinking...", { pending: true });

    try {
      const prompt = buildFollowUpPrompt(ctx, transcript);
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt, stream: false }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ? `${errBody.error}: ${errBody.message || ''}` : `HTTP ${res.status}`);
      }
      const data = await res.json();
      const reply = (data.response || data.message || "I don't have an answer for that.").trim();
      pending.remove();
      appendChatBubble(log, "assistant", reply);
      transcript.push({ role: "assistant", content: reply });
    } catch (e) {
      pending.remove();
      appendChatBubble(log, "assistant", `⚠ ${e.message}`, { error: true });
    } finally {
      btn.disabled = false;
      input.disabled = false;
      input.focus();
      log.scrollTop = log.scrollHeight;
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value;
    input.value = "";
    sendQuestion(v);
  });

  // Auto-focus the input so the user can keep typing.
  setTimeout(() => input.focus(), 50);
}

function appendChatBubble(logEl, role, text, opts = {}) {
  const bubble = document.createElement('div');
  bubble.className = `status-followup-bubble ${role}${opts.pending ? ' pending' : ''}${opts.error ? ' error' : ''}`;
  // Render assistant text as paragraphs on \n\n; preserve basic line breaks.
  const safe = escapeHtml(text || "");
  const formatted = safe
    .replace(/\n\n+/g, "</p><p>")
    .replace(/\n/g, "<br>");
  bubble.innerHTML = role === "assistant"
    ? `<div class="status-followup-role">AI</div><div class="status-followup-text"><p>${formatted}</p></div>`
    : `<div class="status-followup-role">You</div><div class="status-followup-text"><p>${formatted}</p></div>`;
  logEl.appendChild(bubble);
  logEl.scrollTop = logEl.scrollHeight;
  return bubble;
}

function buildFollowUpPrompt(ctx, transcript) {
  const result = ctx.result || {};
  const cityList = (result.cities_list || []).join(', ') || 'none';
  const queries = (result.web_queries || []).join(' | ') || 'none';
  const discoveredMethods = `web-search domains=${result.web_domains || 0}, web-validated=${result.web_validated || 0}, total candidates=${result.discovered_count || 0}, validated=${result.validated_count || 0}, added=${result.added_count || 0}`;

  const historyText = transcript.map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n');

  return `You are an AI news-discovery assistant. The user just clicked "Find ${ctx.category} stories" in a map region and the discovery pipeline returned these results:

## Discovery Context
- Topic requested: ${ctx.category}
- Map center: ${ctx.center?.lat?.toFixed(3)}, ${ctx.center?.lng?.toFixed(3)}
- Bounding box: ${ctx.bbox}
- Cities found in region: ${cityList}
- Countries: ${(result.countries || []).join(', ') || 'unknown'}
- Existing ${ctx.category} stories in DB: ${result.existing_count || 0}
- Web search queries tried: ${queries}
- Discovered sources (by method): ${discoveredMethods}

The user may now ask why nothing was found, ask for a different angle, or want to know how to improve coverage. Be specific to their question, reference the data above, and give actionable next steps (suggest new queries, languages, source types, etc.). If they want you to retry with different parameters, describe what you'd do — you cannot trigger searches yourself; the user can click the "Find" button again after adjusting.

## Conversation So Far
${historyText}

Reply directly to the user's most recent message.`;
}

function toggleCategoryFilter(key) {
  const lowerKey = key.toLowerCase();
  if (_activeCategoryFilters.has(lowerKey)) {
    _activeCategoryFilters.delete(lowerKey);
  } else {
    // If all are currently active (set was empty), start fresh with just this one.
    // Otherwise add to existing selection.
    _activeCategoryFilters.add(lowerKey);

    // Check if there are any pins of this category in the current viewport
    const hasPinsInCategory = checkCategoryInViewport(lowerKey);

    if (!hasPinsInCategory) {
      // No pins of this category - offer to discover news for this topic
      showCategoryDiscoveryPrompt(lowerKey);
    }
  }
  // Filters changed, so markers visibility changed
  _markersDirty = true;
  // Persist cleanup (filters are session-only and never survive browser reload).
  try {
    localStorage.removeItem(CATEGORY_FILTER_KEY);
    sessionStorage.removeItem(CATEGORY_FILTER_KEY);
  } catch (_) {}
  updateActiveFilterIndicator();
  renderLegend();
  syncLayers();
}

// Check if there are any pins of a specific category in the current viewport
function checkCategoryInViewport(categoryKey) {
  if (!map) return true;
  const bounds = map.getBounds();
  let count = 0;
  
  // 1. Check canvasRenderer pins if available
  if (typeof canvasRenderer !== "undefined" && canvasRenderer && Array.isArray(canvasRenderer._pins) && canvasRenderer._pins.length > 0) {
    for (const p of canvasRenderer._pins) {
      const lat = p.location?.lat ?? p.lat;
      const lng = p.location?.lng ?? p.lng;
      if (typeof lat !== "number" || typeof lng !== "number") continue;
      if (!bounds.contains([lat, lng])) continue;
      if (matchesSingleCategoryKey(p, categoryKey)) {
        count++;
      }
    }
    return count > 0;
  }

  // 2. Check DOM pinMarkers
  if (typeof pinMarkers !== "undefined" && pinMarkers && pinMarkers.size > 0) {
    for (const [id, marker] of pinMarkers) {
      const ll = marker.getLatLng();
      if (!bounds.contains(ll)) continue;
      if (matchesSingleCategoryKey(marker, categoryKey)) {
        count++;
      }
    }
    return count > 0;
  }

  // 3. Fallback check on raw pins if available
  if (window._xyzoRawPins && Array.isArray(window._xyzoRawPins) && window._xyzoRawPins.length > 0) {
    for (const p of window._xyzoRawPins) {
      const lat = p.location?.lat ?? p.lat;
      const lng = p.location?.lng ?? p.lng;
      if (typeof lat !== "number" || typeof lng !== "number") continue;
      if (!bounds.contains([lat, lng])) continue;
      if (matchesSingleCategoryKey(p, categoryKey)) {
        count++;
      }
    }
    return count > 0;
  }

  return false;
}

// Show discovery prompt when a category has no pins in viewport
function showCategoryDiscoveryPrompt(categoryKey) {
  const center = map.getCenter();
  const zoom = map.getZoom();
  const bounds = map.getBounds();
  
  // Get city name from LocationTracker if available
  let cityName = 'this area';
  if (window.LocationTracker) {
    const city = LocationTracker.findNearestCity(center.lat, center.lng);
    if (city) cityName = city.name;
  }
  
  // Create discovery banner
  const banner = document.createElement('div');
  banner.className = 'category-discovery-banner';
  banner.id = 'category-discovery-banner';
  banner.innerHTML = `
    <button type="button" class="category-discovery-close" onclick="closeCategoryDiscovery()" aria-label="Close">×</button>
    <div class="category-discovery-content">
      <div class="category-discovery-icon">🔍</div>
      <div class="category-discovery-text">
        <strong>No ${escapeHtml(categoryKey)} news found in ${escapeHtml(cityName)}</strong>
        <div class="category-discovery-subtitle">
          Would you like to discover ${escapeHtml(categoryKey)} news sources for this area?
        </div>
      </div>
      <div class="category-discovery-actions">
        <button type="button" class="category-discovery-btn primary" onclick="discoverCategoryNews('${escapeHtml(categoryKey)}')">
          🔍 Discover Sources
        </button>
        <button type="button" class="category-discovery-btn secondary" onclick="closeCategoryDiscovery()">
          Dismiss
        </button>
      </div>
    </div>
  `;
  
  // Remove existing banner if any
  const existing = document.getElementById('category-discovery-banner');
  if (existing) existing.remove();
  
  document.body.appendChild(banner);
  
  // Auto-dismiss after 15 seconds
  setTimeout(() => {
    if (banner.parentNode) {
      banner.style.opacity = '0';
      banner.style.transition = 'opacity 0.3s';
      setTimeout(() => banner.remove(), 300);
    }
  }, 15000);
}

// Close category discovery banner
function closeCategoryDiscovery() {
  const banner = document.getElementById('category-discovery-banner');
  if (banner) {
    banner.style.opacity = '0';
    banner.style.transition = 'opacity 0.3s';
    setTimeout(() => banner.remove(), 300);
  }
}

// Discover news for a specific category in the current area
async function discoverCategoryNews(categoryKey) {
  const center = map.getCenter();
  const bounds = map.getBounds();
  const bbox = [
    bounds.getWest().toFixed(4),
    bounds.getSouth().toFixed(4),
    bounds.getEast().toFixed(4),
    bounds.getNorth().toFixed(4)
  ].join(',');
  
  // Close the banner
  closeCategoryDiscovery();
  
  // Show the status panel
  const panel = createStatusPanel();
  updateStatusPanel('detect', `Searching for ${categoryKey} news...`, 10);
  updateStatusLocation(`📍 ${center.lat.toFixed(2)}°, ${center.lng.toFixed(2)}° • Category: ${categoryKey}`);
  
  try {
    // Call the explore-region API with category filter
    updateStatusPanel('cities', 'Finding cities in area...', 20);
    
    const res = await fetch('/api/explore-region', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bbox: bbox,
        auto_add: true,
        category_hint: categoryKey
      })
    });
    
    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }
    
    const data = await res.json();
    
    updateStatusPanel('search', 'Searching existing coverage...', 30);
    updateStatusPanel('discover', 'AI discovering sources...', 50);
    updateStatusPanel('validate', 'Validating RSS feeds...', 70);
    updateStatusPanel('add', 'Adding sources...', 85);
    
    // Show results
    const sourcesAdded = data.added_sources?.length || 0;
    const citiesFound = data.cities?.length || 0;
    
    updateStatusPanel('complete', 'Discovery complete!', 100);
    updateStatusSummary(`
      <div style="color: #22c55e;">✓ Discovery complete for ${escapeHtml(categoryKey)}</div>
      <div style="margin-top: 4px;">
        Found <strong>${citiesFound}</strong> cities and added <strong>${sourcesAdded}</strong> new sources.
      </div>
      ${sourcesAdded > 0 ? '<div style="margin-top: 4px; font-size: 11px; color: var(--muted);">New articles will appear shortly as they are fetched.</div>' : ''}
    `, 'success');
    
    // Auto-close after 5 seconds
    setTimeout(closeStatusPanel, 5000);
    
    // Refresh pins after a delay
    setTimeout(() => {
      fetchPinsForViewport();
    }, 3000);
    
  } catch (e) {
    XLog.error('[category-discover] Failed:', e);
    updateStatusSummary(`
      <div style="color: #ef4444;">✗ Discovery failed</div>
      <div style="margin-top: 4px; font-size: 11px;">${escapeHtml(e.message)}</div>
    `, 'error');
    
    setTimeout(closeStatusPanel, 5000);
  }
}

renderLegend();

// ── Trending topics chip bar ────────────────────────────────────────────
// Tag names are DYNAMIC — the AI extractor in worker/extract.py assigns
// 3-6 topic_tags per article. They're stored in news_articles.topic_tags
// (text[]) and ranked via /api/tags/top. As of 2026-09-06 there are 533
// distinct tags across 439 extracted+located articles. The chip bar makes
// those tags filterable without typing anything into search.
//
// Filter state is in the URL (?tag=foo) so users can share filtered
// views, and persists across map pans/zooms. The filter only narrows the
// pins response — it does NOT restrict the map's geographic viewport.
// `_activeTag` is declared earlier (near _logFetchError) so the very
// first fetchPinsForViewport call during module init can read it
// without hitting the temporal dead zone.
function setActiveTag(tag, opts = {}) {
  const next = (typeof tag === "string" && tag.trim()) ? tag.trim().toLowerCase() : null;
  _activeTag = next;

  // Reflect in URL for shareable filtered views.
  const url = new URL(window.location.href);
  if (next) url.searchParams.set("tag", next);
  else url.searchParams.delete("tag");
  history.replaceState(null, "", url.toString());

  // Update chip styling (active state, clear button visibility).
  document.querySelectorAll(".topics-chip").forEach((el) => {
    const name = (el.dataset.tag || "").toLowerCase();
    el.classList.toggle("is-active", !!next && name === next);
    el.setAttribute("aria-pressed", String(!!next && name === next));
  });
  const clearBtn = document.getElementById("topics-chips-clear");
  if (clearBtn) clearBtn.hidden = !next;

  if (typeof updateActiveFilterIndicator === "function") {
    updateActiveFilterIndicator();
  }

  // Announce filter change for screen readers / debug panel.
  const status = document.getElementById("search-status");
  if (status && next) status.textContent = `Filter: ${next}`;

  // Re-fetch pins if not just initializing.
  if (!opts.skipReload && typeof fetchPinsForViewport === "function") {
    fetchPinsForViewport();
  }
}

function _topicsChipsEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function renderTopicsChips() {
  const container = document.getElementById("topics-chips");
  if (!container) return;
  // Read URL tag before first render so the right chip starts highlighted.
  let initialTag = null;
  try {
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get("tag");
    if (t) initialTag = t.trim().toLowerCase();
  } catch (_) {}

  container.innerHTML = '<span class="topics-chips-loading">Loading topics…</span>';
  let tags = [];
  try {
    const { since, until } = searchWindow();
    const tagUrl = since
      ? `/api/tags/top?limit=80&since=${encodeURIComponent(since)}`
      : "/api/tags/top?limit=80";
    const res = await fetch(tagUrl, { cache: "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    tags = Array.isArray(data.tags) ? data.tags : [];
  } catch (e) {
    XLog.warn("topics chip fetch failed", e?.message || e);
    container.innerHTML = '<span class="topics-chips-empty">Couldn’t load topics. The /api/tags/top endpoint in api/src/routes/tags.ts is the source of truth.</span>';
    return;
  }

  if (tags.length === 0) {
    const timeLabel = timeFilter === "all" ? "" : ` in the last ${timeFilter === "custom" ? customDays + "d" : timeFilter}`;
    container.innerHTML = `<span class="topics-chips-empty">No tagged articles${timeLabel}. Try "All" time to see all topics.</span>`;
    return;
  }

  // Build the chip buttons. Use the raw name in data-tag (lowercased so it
  // matches setActiveTag's normalization) but show the original casing on
  // the label for readability.
  const html = tags.map((t) => {
    const raw = String(t.name || "").trim();
    const lc = raw.toLowerCase();
    const count = Number(t.count || 0);
    return `<button type="button" class="topics-chip" data-tag="${_topicsChipsEscape(lc)}" aria-pressed="false" title="${_topicsChipsEscape(count)} stories tagged “${_topicsChipsEscape(raw)}”">${_topicsChipsEscape(raw)}<span class="topics-chip-count">${count}</span></button>`;
  }).join("");
  container.innerHTML = html;

  // Wire click handlers. Clicking the active chip clears the filter.
  container.querySelectorAll(".topics-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = (btn.dataset.tag || "").toLowerCase();
      setActiveTag(_activeTag === name ? null : name);
    });
  });

  // Clear-filter button.
  const clearBtn = document.getElementById("topics-chips-clear");
  // FIX_NOTES 3.4: persistent element re-wired every render → N setActiveTag
  // calls (N refetches) per click. Wire once.
  if (clearBtn && !clearBtn.dataset.wired) {
    clearBtn.dataset.wired = "1";
    clearBtn.addEventListener("click", () => setActiveTag(null));
  }

  // Apply URL-persisted filter without re-fetching (pins load fresh
  // once the map is ready; setActiveTag would otherwise race the first
  // /api/pins/map call).
  if (initialTag && tags.some((t) => String(t.name).toLowerCase() === initialTag)) {
    setActiveTag(initialTag, { skipReload: true });
  }
}
renderTopicsChips();

let _pinStatsData = null;

let _pinStatsLastFetch = 0;
async function updateTimeFilterBadges() {
  // FIX_NOTES 3.3: fired after EVERY viewport fetch; badges move on hour
  // scales — 60 s client throttle + server-side memo make it free.
  const _now = Date.now();
  if (_now - _pinStatsLastFetch < 60_000) return;
  _pinStatsLastFetch = _now;
  try {
    const res = await fetch("/api/pins/stats");
    if (!res.ok) return;
    const data = await res.json();
    _pinStatsData = data;
    const counts = data.counts || {};

    // Update total count in dropdown header
    const headerEl = document.getElementById("time-pin-count-label");
    const total = counts["all"] ?? 0;
    if (headerEl) {
      headerEl.textContent = `${total.toLocaleString()} stories indexed`;
    }

    // Update menu item labels with counts
    const menuLabels = {
      "24h": `24 hours (${(counts["24h"] ?? 0).toLocaleString()})`,
      "3d": `3 days (${(counts["3d"] ?? 0).toLocaleString()})`,
      "7d": `7 days (${(counts["7d"] ?? 0).toLocaleString()})`,
      "30d": `30 days (${(counts["30d"] ?? 0).toLocaleString()})`,
      "all": `All time (${total.toLocaleString()})`,
    };
    const menu = document.getElementById("time-dropdown-menu");
    if (menu) {
      for (const [key, label] of Object.entries(menuLabels)) {
        const btn = menu.querySelector(`button[data-time="${key}"]`);
        if (btn) btn.textContent = label;
      }
    }
  } catch (e) {
    XLog.warn("Failed to update pin stats", e);
  }
}

function checkEmptyPinState(renderedCount) {
  let banner = document.getElementById("timeframe-empty-banner");
  if (renderedCount > 0) {
    if (banner) banner.hidden = true;
    return;
  }

  if (!banner) {
    banner = document.createElement("div");
    banner.id = "timeframe-empty-banner";
    banner.className = "temp-notification";
    banner.style.top = "calc(var(--top-band) + 8px)";
    banner.style.bottom = "auto";
    banner.style.background = "rgba(17, 24, 39, 0.95)";
    banner.style.border = "1px solid #f59e0b";
    banner.style.color = "#f59e0b";
    document.body.appendChild(banner);
  }

  const counts = _pinStatsData?.counts || {};
  let suggestTime = null;
  let suggestLabel = "";

  if (timeFilter === "24h" && counts["7d"] > 0) {
    suggestTime = "7d";
    suggestLabel = `Past Week (${counts["7d"]} pins)`;
  } else if ((timeFilter === "24h" || timeFilter === "7d") && counts["30d"] > 0) {
    suggestTime = "30d";
    suggestLabel = `Past Month (${counts["30d"]} pins)`;
  } else if (counts["365d"] > 0 && timeFilter !== "365d") {
    suggestTime = "365d";
    suggestLabel = `Past Year (${counts["365d"]} pins)`;
  }

  const tfName = {
    "24h": "24 hours",
    "7d": "Past Week",
    "30d": "Past Month",
    "365d": "Past Year",
    "custom": `All ${customDays} days`
  }[timeFilter] || timeFilter;

  // Check if viewport center is near a major city (pop >= 200k)
  const center = map.getCenter();
  let cityName = "";
  if (window.CityEngine && window.CityEngine.isLoaded()) {
    const nearby = CityEngine.citiesNear(center.lat, center.lng, 100, 1);
    if (nearby.length > 0 && nearby[0].p >= 200000) {
      cityName = nearby[0].n;
    }
  }

  const discoverBtn = cityName
    ? `<button onclick="discoverCityForViewport()" style="margin-left:8px; background:#22c55e; color:#0b0f14; border:none; padding:4px 10px; border-radius:4px; font-weight:700; cursor:pointer;">🔍 Discover ${escapeHtml(cityName)} news</button>`
    : `<button onclick="discoverCityForViewport()" style="margin-left:8px; background:#22c55e; color:#0b0f14; border:none; padding:4px 10px; border-radius:4px; font-weight:700; cursor:pointer;">🔍 Discover local news</button>`;

  const catFilterActive = _activeCategoryFilters.size > 0;
  const catFilterDesc = catFilterActive ? `Filtered by category: <strong>${escapeHtml([..._activeCategoryFilters].join(", "))}</strong>.` : "";
  const clearCatBtn = catFilterActive ? `<button onclick="clearCategoryFilters()" style="margin-left:8px; background:var(--accent,#5eead4); color:#0b0f14; border:none; padding:4px 10px; border-radius:4px; font-weight:700; cursor:pointer;">Clear category filter</button>` : "";

  const emptyMsg = catFilterActive
    ? catFilterDesc
    : (_activeTag ? `No pins tagged <strong>${escapeHtml(_activeTag)}</strong> in view for ${tfName}.` : `No pins in view for ${tfName}.`);

  const reloadPageBtn = `<button onclick="location.reload()" style="margin-left:8px; background:rgba(94,234,212,0.15); border:1px solid rgba(94,234,212,0.4); color:var(--accent,#5eead4); padding:4px 10px; border-radius:4px; font-weight:700; cursor:pointer; font-size:11px;" title="If pins should be here, try reloading the page">🔄 Reload page</button>`;

  if (suggestTime) {
    banner.innerHTML = `
      <span>${emptyMsg}</span>
      ${clearCatBtn}
      <button onclick="setTimeFilter('${suggestTime}')" style="margin-left:8px; background:#f59e0b; color:#0b0f14; border:none; padding:4px 10px; border-radius:4px; font-weight:700; cursor:pointer;">Switch to ${suggestLabel}</button>
      ${_activeTag ? `<button onclick="setActiveTag(null)" style="margin-left:8px; background:var(--accent); color:#0b0f14; border:none; padding:4px 10px; border-radius:4px; font-weight:700; cursor:pointer;">Clear topic filter</button>` : ""}
      ${discoverBtn}
      ${reloadPageBtn}
      <button onclick="this.parentElement.hidden=true" style="background:none; border:none; color:#f59e0b; cursor:pointer; font-size:16px; padding:0 4px; margin-left:4px;" title="Dismiss">×</button>
    `;
  } else {
    banner.innerHTML = `
      <span>${emptyMsg}</span>
      ${clearCatBtn}
      ${_activeTag ? `<button onclick="setActiveTag(null)" style="margin-left:8px; background:var(--accent); color:#0b0f14; border:none; padding:4px 10px; border-radius:4px; font-weight:700; cursor:pointer;">Clear topic filter</button>` : ""}
      ${discoverBtn}
      ${reloadPageBtn}
      <button onclick="this.parentElement.hidden=true" style="background:none; border:none; color:#f59e0b; cursor:pointer; font-size:16px; padding:0 4px; margin-left:8px;" title="Dismiss">×</button>
    `;
  }
  banner.hidden = false;
}

// Trigger auto-discover for the current viewport center
async function discoverCityForViewport() {
  const banner = document.getElementById("timeframe-empty-banner");
  if (banner) {
    banner.innerHTML = `<span>🔍 Triggering news discovery...</span>`;
    banner.hidden = false;
  }
  // Call auto-discover API directly
  const b = map.getBounds();
  const bbox = `${b.getWest().toFixed(2)},${b.getSouth().toFixed(2)},${b.getEast().toFixed(2)},${b.getNorth().toFixed(2)}`;
  const center = map.getCenter();
  const zoom = map.getZoom();
  const sessionId = typeof XyzoAnalytics !== 'undefined' ? XyzoAnalytics.sessionId : null;
  try {
    const res = await fetch('/api/auto-discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bbox, center_lat: center.lat, center_lng: center.lng, map_zoom: zoom, session_id: sessionId }),
    });
    const data = await res.json();
    if (data.discovery_triggered) {
      showAutoDiscoverNotification(data.message || 'Discovering news sources...', data.request_id, data.job_id);
      if (banner) banner.hidden = true;
    } else if (data.has_coverage) {
      if (banner) {
        banner.innerHTML = `<span>✅ ${escapeHtml(data.message || 'Area has coverage')}</span><button onclick="this.parentElement.hidden=true" style="background:none;border:none;color:#f59e0b;cursor:pointer;font-size:16px;padding:0 4px;margin-left:8px;">×</button>`;
      }
    } else {
      if (banner) {
        banner.innerHTML = `<span>⚠️ ${data.message || 'Could not trigger discovery'}</span><button onclick="this.parentElement.hidden=true" style="background:none;border:none;color:#f59e0b;cursor:pointer;font-size:16px;padding:0 4px;margin-left:8px;">×</button>`;
      }
    }
  } catch (e) {
    if (banner) {
      banner.innerHTML = `<span>❌ Discovery failed: ${escapeHtml(String(e))}</span><button onclick="this.parentElement.hidden=true" style="background:none;border:none;color:#f59e0b;cursor:pointer;font-size:16px;padding:0 4px;margin-left:8px;">×</button>`;
    }
  }
}

// ── Time range filter ────────────────────────────────────────────────
function setTimeFilter(filter, { persist = true } = {}) {
  let alreadySet = false;
  try { if (timeFilter === filter) alreadySet = true; } catch (_) { /* TDZ: first call, proceed */ }
  if (alreadySet) return;
  if (!["24h", "3d", "7d", "30d", "365d", "custom", "all"].includes(filter)) return;
  let safeCustomDays = 7;
  try { safeCustomDays = customDays; } catch (_) { /* TDZ */ }
  if (filter === "custom" && !(safeCustomDays >= 1 && safeCustomDays <= 90)) return;
  timeFilter = filter;
  // Update dropdown label and menu active state
  refreshTimeCustomBtn();
  // REFRESH THE SIDE PANEL. The panel has its own fetch (/api/feed/live),
  // separate from the map's pin query, so without this changing the time
  // control only moved the MAP: the panel kept serving the previous
  // window until an unrelated trigger refetched it — which is exactly
  // "I changed to 24 hours and the stories did not change".
  // TDZ-safe: setTimeFilter can run before liveState exists, and `typeof`
  // on a let in its temporal dead zone throws rather than returning
  // "undefined", hence the try.
  try {
    if (typeof fetchLiveFeed === "function" && typeof liveState !== "undefined") {
      fetchLiveFeed(true).catch(() => {});
    }
  } catch (_) {}
  if (persist) {
    try { localStorage.setItem(TIME_STORAGE_KEY, filter); } catch (_) {}
    if (filter === "custom") {
      try { localStorage.setItem(CUSTOM_DAYS_STORAGE_KEY, String(customDays)); } catch (_) {}
    }
  }
  if (searchActive) {
    // Drop stale events; they'll come back if the user re-submits.
    eventMarkers.clear();
    rebuildHeatPoints();
    commitHeat();
    syncLayers();
    renderLinks();
  }
  // Always refresh pins for the current viewport without changing the map view
  fetchPinsForViewport();
  // Re-fetch topic chips so counts match the new time window
  renderTopicsChips();
  // Update URL hash to reflect the new time filter
  try { if (typeof updateUrlHash === "function") updateUrlHash(); } catch (_) {}
}

// Update the dropdown label/active state. Called whenever time filter changes.
function refreshTimeCustomBtn() {
  const label = document.getElementById("time-dropdown-label");
  const menu = document.getElementById("time-dropdown-menu");
  if (!label || !menu) return;

  // Update button label
  const labelMap = { "24h": "24h", "3d": "3d", "7d": "7d", "30d": "30d", "all": "All", "custom": `${customDays}d` };
  label.textContent = labelMap[timeFilter] || timeFilter;

  // Update active state in menu
  for (const m of menu.querySelectorAll("button[data-time]")) {
    m.classList.toggle("active", m.dataset.time === timeFilter);
  }
}

// Fixed dropdowns live in the clear band between #top-bar and #bottom-bar
// and span it, so nothing else can sit in that band while one is open: the
// Help Me pill (z 9998, above the dropdown's z 10000) covered ~5 control
// menu rows. Flag the open state on <body> so CSS can park anything that
// would otherwise paint over the menu. Set here and cleared by the
// document click listener below, which is the one place every close path
// goes through.
function setDropdownOpen(open) {
  if (open) document.body.setAttribute("data-dropdown-open", "");
  else document.body.removeAttribute("data-dropdown-open");
}

// Shared dropdown state - close all dropdowns except the one being opened
function closeOtherMenus(exceptMenuId) {
  const menus = [
    { id: "time-dropdown-menu", btnId: "time-dropdown-btn" },
    { id: "markers-dropdown-menu", btnId: "markers-dropdown-btn" },
    { id: "control-menu", btnId: "control-menu-btn" },
  ];
  for (const m of menus) {
    if (m.id === exceptMenuId) continue;
    const menu = document.getElementById(m.id);
    const btn = document.getElementById(m.btnId);
    if (menu && menu.style.display !== "none") {
      menu.style.display = "none";
      menu.setAttribute("hidden", "");
      if (btn) btn.setAttribute("aria-expanded", "false");
    }
  }
  // exceptMenuId is the menu about to open, so exactly one is open once
  // the caller shows it. The second loop cannot be used here: this runs
  // BEFORE the caller's menu is shown, so it can only ever see the menus
  // that were just closed.
  setDropdownOpen(!!exceptMenuId);
}

// Any click that is not inside a dropdown closes it, and that is the only
// moment the flag has to be cleared — each dropdown hides its own menu in
// several places (its toggle's else-branch, an outside-click handler, an
// option click), and patching every one would mean six sites that can
// drift out of sync. A single click listener catches all of them, because
// the click that closes a menu is by definition not inside one. Runs after
// the three dropdown IIFEs below, on the document (which is why it does
// not need to know which menu is open).
document.addEventListener("click", (e) => {
  if (!document.body.hasAttribute("data-dropdown-open")) return;
  const inside = e.target && e.target.closest
    && e.target.closest("#time-dropdown-menu, #markers-dropdown-menu, #control-menu");
  if (!inside) setDropdownOpen(false);
});

// ── Time dropdown button ───────────────────────────────────────────────
// IMPORTANT: app.js is loaded with `defer`, so DOMContentLoaded may
// have already fired by the time this code runs.  An unconditional
// `document.addEventListener("DOMContentLoaded", ...)` will be queued
// forever and never fire — which would silently break the entire
// time-dropdown (the user can see the button but clicking it does
// nothing, the menu options don't open, and the count labels never
// update).  Always check readyState and call the wiring function
// directly when the DOM is already ready.
(function wireTimeDropdown() {
  function attach() {
    const btn = document.getElementById("time-dropdown-btn");
    const menu = document.getElementById("time-dropdown-menu");
    const label = document.getElementById("time-dropdown-label");
    if (!btn || !menu) {
      XLog.warn("time-dropdown: btn or menu not found", { btn: !!btn, menu: !!menu });
      return;
    }
    XLog.log("wireTimeDropdown attach running", {
      wired: btn.dataset.wired,
      btnHidden: btn.hidden,
      menuHidden: menu.hidden,
      ariaExpanded: btn.getAttribute("aria-expanded"),
    });
    if (btn.dataset.wired === "1") {
      XLog.warn("time-dropdown: already wired, skipping", { wired: btn.dataset.wired });
      return;  // idempotent
    }
    btn.dataset.wired = "1";

    // Sync button label and menu active state from current timeFilter
    const shortMap = { "24h": "24h", "3d": "3d", "7d": "7d", "30d": "30d", "all": "All", "custom": "custom" };
    if (label) label.textContent = shortMap[timeFilter] || timeFilter;
    const items = menu.querySelectorAll("button[data-time]");
    for (const item of items) item.classList.toggle("active", item.dataset.time === timeFilter);

    // Toggle menu on click
    let menuOpen = false;
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      menuOpen = !menuOpen;
      if (menuOpen) {
        closeOtherMenus("time-dropdown-menu");
        menu.style.display = "block";
        menu.removeAttribute("hidden");
      } else {
        menu.style.display = "none";
        menu.setAttribute("hidden", "");
      }
      btn.setAttribute("aria-expanded", String(menuOpen));
      XLog.log("time-dropdown btn CLICK", {
        menuOpen,
        display: menu.style.display,
        rect: document.getElementById("time-dropdown-menu").getBoundingClientRect(),
      });
    });

    // Close when clicking outside
    document.addEventListener("click", function(e) {
      if (menuOpen && !menu.contains(e.target) && e.target !== btn) {
        menuOpen = false;
        menu.style.display = "none";
        menu.setAttribute("hidden", "");
        btn.setAttribute("aria-expanded", "false");
      }
    });

    // Handle option clicks
    for (const item of items) {
      item.addEventListener("click", function() {
        const time = item.dataset.time;
        // Highlight selected in menu
        for (const i of items) i.classList.toggle("active", i === item);
        // Update button label
        if (label) label.textContent = shortMap[time] || time;
        // Close menu
        menuOpen = false;
        menu.style.display = "none";
        menu.setAttribute("hidden", "");
        btn.setAttribute("aria-expanded", "false");
        // Apply filter
        setTimeFilter(time);
      });
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach, { once: true });
  } else {
    attach();
  }
})();

// ── Markers dropdown (Markers / Heatmap / Clusters) ────────────────────
(function wireMarkersDropdown() {
  function attach() {
    const btn = document.getElementById("markers-dropdown-btn");
    const menu = document.getElementById("markers-dropdown-menu");
    if (!btn || !menu) return;
    if (btn.dataset.wired === "1") return;
    btn.dataset.wired = "1";

    function refreshActiveStates() {
      for (const item of menu.querySelectorAll("button[data-mode]")) {
        const isActive = activeModes.has(item.dataset.mode);
        item.classList.toggle("active", isActive);
        const dot = item.querySelector(".mode-dot");
        if (dot) dot.textContent = isActive ? "●" : "○";
      }
      // Sync the main button label
      const markersLabel = document.getElementById("markers-dropdown-label");
      if (markersLabel) {
        const activeLabel = activeModes.has("heatmap") ? "Heatmap" :
                            activeModes.has("clusters") ? "Clusters" : "Markers";
        markersLabel.textContent = activeLabel;
      }
    }
    refreshActiveStates();

    let menuOpen = false;
    function open() {
      menuOpen = true;
      menu.style.display = "block";
      btn.setAttribute("aria-expanded", "true");
    }
    function close() {
      menuOpen = false;
      menu.style.display = "none";
      btn.setAttribute("aria-expanded", "false");
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menuOpen) { close(); return; }
      closeOtherMenus("markers-dropdown-menu");
      open();
    });
    for (const item of menu.querySelectorAll("button[data-mode]")) {
      item.addEventListener("click", () => {
        const mode = item.dataset.mode;
        if (activeModes.has(mode)) {
          activeModes.delete(mode);
        } else {
          if (mode === "markers") activeModes.delete("clusters");
          if (mode === "clusters") activeModes.delete("markers");
          activeModes.add(mode);
        }
        _markersDirty = true;
        applyLayers();
        refreshActiveStates();
        close();
      });
    }
    document.addEventListener("click", (e) => {
      if (menuOpen && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close();
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach, { once: true });
  } else {
    attach();
  }
})();

// ── Control menu (hierarchical: Map / Layers / Tools) ──────────────────
(function wireControlMenu() {
  function attach() {
    const btn = document.getElementById("control-menu-btn");
    const menu = document.getElementById("control-menu");
    if (!btn || !menu) return;
    if (btn.dataset.wired === "1") return;
    btn.dataset.wired = "1";

    // Density picker
    const densityBtns = menu.querySelectorAll(".density-picker button[data-density]");
    function refreshDensity() {
      for (const b of densityBtns) {
        b.classList.toggle("active", b.dataset.density === pinDensity);
      }
    }
    refreshDensity();
    for (const b of densityBtns) {
      b.addEventListener("click", () => {
        const d = b.dataset.density;
        if (!PIN_DENSITY_MAP[d]) return;
        pinDensity = d;
        try { localStorage.setItem(PIN_DENSITY_STORAGE_KEY, d); } catch (_) {}
        refreshDensity();
        if (typeof fetchPinsForViewport === "function") fetchPinsForViewport();
        try { if (typeof updateUrlHash === "function") updateUrlHash(); } catch (_) {}
      });
    }

    // Wiki toggle
    const wikiBtn = document.getElementById("ctrl-wiki-toggle");
    if (wikiBtn) {
      function refreshWiki() {
        const isOn = wikiMarkersEnabled;
        wikiBtn.classList.toggle("active", isOn);
        wikiBtn.textContent = isOn ? "On" : "Off";
        wikiBtn.setAttribute("aria-pressed", isOn ? "true" : "false");
      }
      refreshWiki();
      wikiBtn.addEventListener("click", () => {
        wikiMarkersEnabled = !wikiMarkersEnabled;
        if (wikiMarkersEnabled && typeof refreshWikiMarkers === "function") refreshWikiMarkers();
        else if (!wikiMarkersEnabled && typeof clearWikiMarkers === "function") clearWikiMarkers();
        refreshWiki();
        try { localStorage.setItem("xyzo.wikiMarkers", String(wikiMarkersEnabled)); } catch (_) {}
      });
    }

    // Hover HUD mode (hover-info.js): Off / Pins / All. The active
    // button state is owned by HoverInfo.refreshModeButtons().
    const hoverPicker = document.getElementById("hover-mode-picker");
    if (hoverPicker && window.HoverInfo) {
      for (const b of hoverPicker.querySelectorAll("button[data-hover]")) {
        b.addEventListener("click", () => {
          HoverInfo.setMode(b.getAttribute("data-hover"));
        });
      }
    }

    // Text size (owner spec 2026-10-29): A / A+ / A++ scale the UI text
    // via --ui-zoom. Default is A+ (115 %) — "a little larger" for
    // readability; the early <head> script applies the class before
    // first paint, this wiring only keeps the buttons in sync.
    const sizePicker = document.getElementById("text-size-picker");
    if (sizePicker) {
      const applyTextSize = (size) => {
        document.documentElement.classList.toggle("ts-100", size === "100");
        document.documentElement.classList.toggle("ts-130", size === "130");
        try { localStorage.setItem("xyzo.textSize", size); } catch (_) {}
        for (const b of sizePicker.querySelectorAll("button[data-size]")) {
          const on = b.getAttribute("data-size") === size;
          b.classList.toggle("active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        }
      };
      let storedSize = "115";
      try { storedSize = localStorage.getItem("xyzo.textSize") || "115"; } catch (_) {}
      applyTextSize(storedSize);
      for (const b of sizePicker.querySelectorAll("button[data-size]")) {
        b.addEventListener("click", () => applyTextSize(b.getAttribute("data-size")));
      }
    }

    // MY STYLE (owner spec 2026-10-29): one click saves the whole view,
    // one click brings it back. captureStyle/applySavedStyle/renderSavedStyles
    // are defined with the hash helpers near the top of app.js.
    const saveStyleBtn = document.getElementById("ctrl-save-style");
    if (saveStyleBtn) {
      saveStyleBtn.addEventListener("click", () => {
        const list = loadSavedStyles();
        list.unshift(captureStyle());
        saveSavedStyles(list);
        renderSavedStyles();
        saveStyleBtn.textContent = "✓ Saved";
        setTimeout(() => { saveStyleBtn.textContent = "☆ Save this view"; }, 1500);
      });
    }
    renderSavedStyles();

    // ⭐ MY DEFAULT MAP (owner spec 2026-10-30): choose WHAT opens next
    // visit, and save the current map as the one that does.
    //   Last used — whatever was on screen when you left (auto-saved)
    //   My default — the map saved with the ⭐ button
    //   ✨ Cool    — the curated showcase map, every time
    // MapPresets holds the state; captureMapState/applyMapState are the
    // capture/apply half in app.js.
    if (window.MapPresets) {
      const MP = window.MapPresets;
      const saveDefaultBtn = document.getElementById("ctrl-save-default");
      const modePicker = document.getElementById("default-mode-picker");
      const statusEl = document.getElementById("default-style-status");

      const refreshDefaultUI = () => {
        const mode = MP.getMode();
        if (modePicker) {
          for (const b of modePicker.querySelectorAll("button[data-next-map]")) {
            const on = b.getAttribute("data-next-map") === mode;
            b.classList.toggle("active", on);
            b.setAttribute("aria-pressed", on ? "true" : "false");
          }
        }
        if (!statusEl) return;
        const def = MP.getDefault();
        const n = def && Array.isArray(def.overlays) ? def.overlays.length : 0;
        if (mode === "cool") {
          statusEl.textContent = "Opens with the ✨ cool map every time.";
        } else if (mode === "saved" && def) {
          statusEl.textContent = "Opens with your saved default (" +
            n + " overlay" + (n === 1 ? "" : "s") + ").";
        } else if (mode === "saved") {
          statusEl.textContent = "No default saved yet — ⭐ Save as default stores the map on screen.";
        } else {
          statusEl.textContent = "Opens with whatever you used last time.";
        }
      };

      if (saveDefaultBtn) {
        saveDefaultBtn.addEventListener("click", () => {
          if (MP.saveDefault(captureMapState())) {
            MP.setMode("saved");
            refreshDefaultUI();
            saveDefaultBtn.textContent = "\u2B50 Saved"; // ⭐ Saved
            setTimeout(() => { saveDefaultBtn.textContent = "\u2B50 Save as default"; }, 1500);
          }
        });
      }
      if (modePicker) {
        for (const b of modePicker.querySelectorAll("button[data-next-map]")) {
          b.addEventListener("click", () => {
            MP.setMode(b.getAttribute("data-next-map"));
            refreshDefaultUI();
          });
        }
      }
      refreshDefaultUI();
    }

    // News layer toggle
    const newsBtn = document.getElementById("ctrl-news-toggle");
    if (newsBtn) {
      function refreshNews() {
        newsBtn.classList.toggle("active", layerPrefs.news);
        newsBtn.textContent = layerPrefs.news ? "On" : "Off";
        newsBtn.setAttribute("aria-pressed", layerPrefs.news ? "true" : "false");
      }
      refreshNews();
      newsBtn.addEventListener("click", () => {
        layerPrefs.news = !layerPrefs.news;
        saveLayerPrefs();
        refreshNews();
        if (typeof fetchPinsForViewport === "function") fetchPinsForViewport();
      });
    }

    // Community layer toggle
    const commBtn = document.getElementById("ctrl-community-toggle");
    if (commBtn) {
      function refreshComm() {
        commBtn.classList.toggle("active", layerPrefs.community);
        commBtn.textContent = layerPrefs.community ? "On" : "Off";
        commBtn.setAttribute("aria-pressed", layerPrefs.community ? "true" : "false");
      }
      refreshComm();
      commBtn.addEventListener("click", () => {
        layerPrefs.community = !layerPrefs.community;
        saveLayerPrefs();
        refreshComm();
        if (typeof fetchPinsForViewport === "function") fetchPinsForViewport();
      });
    }

    // Legend button
    const legendBtn = document.getElementById("ctrl-legend-btn");
    const legendPanel = document.getElementById("legend");
    if (legendBtn && legendPanel) {
      legendBtn.addEventListener("click", () => {
        const hidden = legendPanel.hidden;
        legendPanel.hidden = !hidden;
        if (!hidden) legendPanel.open = false;
        close();
      });
    }

    // Help button
    const helpBtnEl = document.getElementById("ctrl-help-btn");
    const helpPanel = document.getElementById("help-panel");
    if (helpBtnEl && helpPanel) {
      helpBtnEl.addEventListener("click", () => {
        if (helpPanel.hidden) {
          openModalA11y(helpPanel, { returnFocusTo: helpBtnEl });
          helpBtnEl.classList.add("active");
          attachModalEscape(helpPanel, closeHelpPanel);
        } else {
          closeHelpPanel();
        }
        close();
      });
    }

    let menuOpen = false;
    // Open by clearing the inline style rather than writing "block".
    // .bar-dropdown--wide is a flex column capped to the viewport, and an
    // inline `display:block` outranks that, which broke the cap's scroll:
    // the 918px inner overflowed the 550px shell with overflow-y:auto
    // never engaging, so the menu's top third sat off-screen with no way
    // to scroll there. The stylesheet now owns the layout — the same
    // approach setLayersPanelOpen() already uses for the layers panel.
    function open() {
      menuOpen = true;
      menu.style.display = "";
      menu.removeAttribute("hidden");
      btn.setAttribute("aria-expanded", "true");
    }
    function close() {
      menuOpen = false;
      menu.style.display = "none";
      btn.setAttribute("aria-expanded", "false");
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menuOpen) { close(); return; }
      closeOtherMenus("control-menu");
      open();
    });
    document.addEventListener("click", (e) => {
      if (menuOpen && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close();
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach, { once: true });
  } else {
    attach();
  }
})();

(function wireTimeCustomPopover() {
  const popover = document.getElementById("time-custom-popover");
  const input = document.getElementById("time-custom-input");
  const label = document.getElementById("time-custom-label");
  const cancel = document.getElementById("time-custom-cancel");
  const apply = document.getElementById("time-custom-apply");
  if (!popover || !input || !label || !cancel || !apply) return;

  const MIN_DAYS = 1;
  const MAX_DAYS = 90;

  // Stay in lockstep: a step button or input edit updates the label and
  // the input's `min/max` validation feedback.
  function setDays(n) {
    const clamped = Math.max(MIN_DAYS, Math.min(MAX_DAYS, Math.floor(n) || MIN_DAYS));
    input.value = String(clamped);
    label.textContent = String(clamped);
  }

  // Buttons next to the input: data-delta="-1" / "1".
  for (const stepBtn of popover.querySelectorAll(".time-custom-controls button")) {
    stepBtn.addEventListener("click", () => {
      const delta = Number(stepBtn.dataset.delta);
      if (!Number.isFinite(delta)) return;
      setDays(Number(input.value) + delta);
    });
  }
  // Typing in the field. We update the label live but only flip the active
  // filter on Apply — let users see the number update without committing
  // mid-keystroke.
  input.addEventListener("input", () => {
    const n = Number(input.value);
    if (Number.isFinite(n)) label.textContent = String(Math.max(MIN_DAYS, Math.min(MAX_DAYS, n)));
  });
  // Enter on the input applies the current value.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); apply.click(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel.click(); }
  });

  function open() {
    // Seed the popover with the last used custom value, default 7d.
    setDays(customDays);
    popover.hidden = false;
    // Focus the input on the next tick so the popover is rendered first.
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  function close() {
    popover.hidden = true;
  }

  cancel.addEventListener("click", close);
  apply.addEventListener("click", () => {
    const n = Number(input.value);
    if (!Number.isFinite(n) || n < MIN_DAYS || n > MAX_DAYS) {
      input.focus();
      return;
    }
    customDays = Math.floor(n);
    close();
    setTimeFilter("custom");
  });

  // Click outside the popover closes it.
  document.addEventListener("click", (e) => {
    if (popover.hidden) return;
    if (popover.contains(e.target)) return;
    close();
  }, true);

  // Expose open for the dropdown menu to call
  window.openCustomPopover = open;
})();

// ── Submitter view ─────────────────────────────────────────────────────
const submitBtn = document.getElementById("submit-btn");
const exploreSubmitBtn = document.getElementById("explore-submit-btn");
const overlay = document.getElementById("submitter-overlay");
const cancelBtn = document.getElementById("cancel-btn");
const form = document.getElementById("submit-form");
const latDisplay = document.getElementById("lat-display");
const lngDisplay = document.getElementById("lng-display");

let miniMap = null;
let miniMarker = null;
let pickedLat = null;
let pickedLng = null;
let miniTileLayer = null;
const MINI_TILE_LAYERS = {
  Dark: L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    { subdomains: "abcd", attribution: "© OSM © CARTO", maxZoom: 19 }
  ),
  Street: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap contributors",
  }),
  Satellite: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Source: Esri, Maxar, Earthstar Geographics" }
  ),
};

function setMiniTileLayer(name) {
  if (!miniMap || !MINI_TILE_LAYERS[name]) return;
  if (miniTileLayer) miniMap.removeLayer(miniTileLayer);
  miniTileLayer = MINI_TILE_LAYERS[name].addTo(miniMap);
  miniMap.invalidateSize();
  document.querySelectorAll(".mini-layer-btn").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.layer === name ? "true" : "false");
  });
}

function openSubmitOverlay() {
  overlay.hidden = false;
  if (!miniMap) {
    miniMap = L.map("mini-map").setView([24.86, 67.00], 3);
    setMiniTileLayer("Street");
    miniMap.on("click", (e) => {
      pickedLat = e.latlng.lat;
      pickedLng = e.latlng.lng;
      latDisplay.textContent = pickedLat.toFixed(4);
      lngDisplay.textContent = pickedLng.toFixed(4);
      placeStatus.textContent = "pinned by click";
      if (miniMarker) miniMap.removeLayer(miniMarker);
      miniMarker = L.marker([pickedLat, pickedLng]).addTo(miniMap);
    });
  } else {
    setTimeout(() => miniMap.invalidateSize(), 100);
  }
}

if (submitBtn) submitBtn.addEventListener("click", openSubmitOverlay);
if (exploreSubmitBtn) exploreSubmitBtn.addEventListener("click", openSubmitOverlay);
document.querySelectorAll(".mini-layer-btn").forEach((btn) => {
  btn.addEventListener("click", () => setMiniTileLayer(btn.dataset.layer));
});

// ── Click-to-submit: open the overlay pre-pinned to a main-map click ──
// Called from the map click handler (guarded there). Reuses the existing
// submitter overlay — the mini-map recenters on the picked point so the
// user can nudge it if the click was slightly off.
function openSubmitAtPoint(latlng) {
  openSubmitOverlay();
  const verdict = document.getElementById("submit-verdict");
  if (verdict) verdict.hidden = true;
  if (form) form.hidden = false;
  pickedLat = latlng.lat;
  pickedLng = latlng.lng;
  latDisplay.textContent = pickedLat.toFixed(4);
  lngDisplay.textContent = pickedLng.toFixed(4);
  placeStatus.textContent = "pinned from your map click — drag-free: use the mini-map to nudge";
  if (miniMap) {
    miniMap.setView([pickedLat, pickedLng], Math.max(map.getZoom(), 6));
    if (miniMarker) miniMap.removeLayer(miniMarker);
    miniMarker = L.marker([pickedLat, pickedLng]).addTo(miniMap);
  }
  const titleInput = form?.querySelector('input[name="title"]');
  if (titleInput) setTimeout(() => titleInput.focus(), 120);
}
window.openSubmitAtPoint = openSubmitAtPoint;

function dropMiniMarker(lat, lng) {
  pickedLat = lat;
  pickedLng = lng;
  latDisplay.textContent = lat.toFixed(4);
  lngDisplay.textContent = lng.toFixed(4);
  if (miniMarker) miniMap.removeLayer(miniMarker);
  miniMarker = L.marker([lat, lng]).addTo(miniMap);
  miniMap.setView([lat, lng], Math.max(miniMap.getZoom(), 10));
}

const placeInput = document.getElementById("place-input");
const findBtn = document.getElementById("find-btn");
const placeStatus = document.getElementById("place-status");

async function geocodeAndPin() {
  const q = placeInput.value.trim();
  if (!q) {
    clearSearch();
    return;
  }
  // A search with every marker mode off would return invisible results —
  // switch markers back on so the user actually sees what was found.
  if (!activeModes.has("markers") && !activeModes.has("clusters") &&
      !activeModes.has("heatmap")) {
    activeModes.add("markers");
    _markersDirty = true;
    try { applyLayers(); } catch (_) {}
  }
  findBtn.disabled = true;  findBtn.textContent = "…";
  placeStatus.textContent = "Looking up…";
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (res.status === 429) {
      placeStatus.textContent = "Rate limited — try again shortly.";
      return;
    }
    if (res.status === 404) {
      placeStatus.textContent = "Couldn't resolve that place. Try a different name or click the map.";
      return;
    }
    if (!res.ok) {
      placeStatus.textContent = `Lookup failed (${res.status}).`;
      return;
    }
    const body = await res.json();
    dropMiniMarker(body.lat, body.lng);
    placeStatus.textContent = `${body.display_name} · via ${body.source}`;
  } catch (e) {
    placeStatus.textContent = `Network error: ${e.message}`;
  } finally {
    findBtn.disabled = false;
    findBtn.textContent = "Find";
  }
}

findBtn.addEventListener("click", geocodeAndPin);
placeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); geocodeAndPin(); }
});

// Single close-handler used by the in-card × button, the bottom
// "Cancel" button, and the Escape key. Centralising it makes sure all
// paths leave the same clean state (form reset, mini-marker cleared,
// coordinate displays neutralised).
function closeSubmitter() {
  overlay.hidden = true;
  form.reset();
  form.hidden = false;
  pickedLat = null;
  pickedLng = null;
  latDisplay.textContent = "—";
  lngDisplay.textContent = "—";
  placeStatus.textContent = "";
  const verdict = document.getElementById("submit-verdict");
  if (verdict) verdict.hidden = true;
  const formErr = document.getElementById("submit-form-error");
  if (formErr) { formErr.hidden = true; formErr.textContent = ""; }
  if (miniMarker) miniMap.removeLayer(miniMarker);
}

cancelBtn.addEventListener("click", closeSubmitter);

// Upper-left × close button on the submitter card.
const cardCloseBtn = document.getElementById("card-close-btn");
if (cardCloseBtn) cardCloseBtn.addEventListener("click", closeSubmitter);

// Esc closes the overlay too, when the mini-map hasn't stolen focus.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !overlay.hidden) closeSubmitter();
});

// "Done" on the success verdict panel closes and reveals the fresh pin.
const submitVerdictDone = document.getElementById("submit-verdict-done");
if (submitVerdictDone) submitVerdictDone.addEventListener("click", closeSubmitter);

function showSubmitFormError(msg) {
  const el = document.getElementById("submit-form-error");
  if (!el) { alert(msg); return; }
  el.hidden = false;
  el.textContent = msg; // textContent — msg may embed server reasons
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (pickedLat === null || pickedLng === null) {
    showSubmitFormError("Click the map (or the mini-map) to set a location.");
    return;
  }
  const formErr = document.getElementById("submit-form-error");
  if (formErr) formErr.hidden = true;

  const fd = new FormData(form);
  const body = {
    title: fd.get("title"),
    submitter_name: fd.get("submitter_name") || undefined,
    submitter_email: fd.get("submitter_email") || undefined,
    story_note: fd.get("story_note") || undefined,
    canonical_url: fd.get("canonical_url") || undefined,
    category: fd.get("category") || undefined,
    lat: pickedLat,
    lng: pickedLng,
    hp_company: fd.get("hp_company") || "",
  };

  const confirmBtn = document.getElementById("confirm-btn");
  if (confirmBtn) confirmBtn.disabled = true;
  try {
    const res = await fetch("/api/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 201) {
      // ── Show the submitter what the fast scan understood ──
      const det = data.detected || {};
      const verdict = document.getElementById("submit-verdict");
      const vText = document.getElementById("submit-verdict-text");
      const vMeta = document.getElementById("submit-verdict-meta");
      if (verdict && vText) {
        // escapeHtml — topic_summary embeds matched keywords from user text.
        vText.innerHTML = escapeHtml(det.topic_summary || "Thanks! Your story is on the map.");
        const metaBits = [];
        if (det.category) metaBits.push(`category: ${escapeHtml(det.category)}`);
        if (data.moderation?.deep_check === "queued") metaBits.push("deep check queued");
        vMeta.innerHTML = metaBits.join(" · ");
        form.hidden = true;
        verdict.hidden = false;
      } else {
        overlay.hidden = true;
      }
      form.reset();
      pickedLat = null;
      pickedLng = null;
      latDisplay.textContent = "—";
      lngDisplay.textContent = "—";
      placeStatus.textContent = "";
      if (miniMarker) miniMap.removeLayer(miniMarker);
      await fetchPinsForViewport();
      return;
    }

    if (res.status === 409) {
      showSubmitFormError(data.message || "Somebody already submitted this story recently.");
      return;
    }
    if (res.status === 400 && data.error === "rejected") {
      const reasons = Array.isArray(data.reasons) ? data.reasons.join(", ") : "";
      showSubmitFormError(
        `Our automated check flagged this submission${reasons ? ` (${reasons})` : ""}. ` +
        (data.message || "Please rephrase and try again."),
      );
      return;
    }
    if (res.status === 429) {
      showSubmitFormError("Too many submissions — please try again later.");
      return;
    }
    showSubmitFormError(`Submission failed: ${data.error || data.message || res.status}`);
  } catch (e) {
    XLog.warn("[submit-form] network error:", e);
    showSubmitFormError("Network error — please try again.");
  } finally {
    if (confirmBtn) confirmBtn.disabled = false;
  }
});
// ── Live news side panel ─────────────────────────────────────────────
// Fetches /api/feed/live once, then refreshes on a timer. Two tabs:
// "Hot" (global ranking) and "Near me" (geoip-derived proximity).
// Clicking an item flies the map to the event's primary location.

const livePanel = document.getElementById("live-panel");
const livePanelToggle = document.getElementById("live-panel-toggle");
const livePanelReopen = document.getElementById("live-panel-reopen");
const livePanelBody = document.getElementById("live-panel-body");
const livePanelList = document.getElementById("live-panel-list");
const livePanelMeta = document.getElementById("live-panel-meta");
const livePanelTabs = document.querySelectorAll(".live-panel-tab");

// ── the feed's OPTIONS ───────────────────────────────────────────────
//
// The API has always accepted `radius_km` (how far "Near Me" reaches)
// and `limit` (how many stories come back), and the panel hard-coded
// both to 500 / 30 — so the reader had no way to widen the net or to
// ask for a longer list. They are remembered under one key and applied
// to every fetch of the feed.
const LIVE_OPTIONS_KEY = "xyzo.liveOptions";
const liveOptions = (() => {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(LIVE_OPTIONS_KEY) || "{}") || {};
  } catch (_) { saved = {}; }
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  return {
    radiusKm: clamp(saved.radiusKm, 1, 2000, 500),
    limit: clamp(saved.limit, 5, 100, 30),
  };
})();
function saveLiveOptions() {
  try {
    localStorage.setItem(LIVE_OPTIONS_KEY, JSON.stringify(liveOptions));
  } catch (_) {}
}
function wireLiveOptions() {
  const rSel = document.getElementById("live-opt-radius");
  const lSel = document.getElementById("live-opt-limit");
  const rBtn = document.getElementById("live-opt-refresh");
  if (rSel) {
    rSel.value = String(liveOptions.radiusKm);
    rSel.addEventListener("change", () => {
      liveOptions.radiusKm = Number(rSel.value) || 500;
      saveLiveOptions();
      fetchLiveFeed(true);
    });
  }
  if (lSel) {
    lSel.value = String(liveOptions.limit);
    lSel.addEventListener("change", () => {
      liveOptions.limit = Number(lSel.value) || 30;
      saveLiveOptions();
      fetchLiveFeed(true);
    });
  }
  if (rBtn) {
    rBtn.addEventListener("click", () => fetchLiveFeed(true));
  }
}

const LIVE_TABS = new Set(["hot", "new", "near", "local", "trending", "neural", "your"]);
const LIVE_REFRESH_MS = 30_000;   // refresh every 30s (was 60s) for faster updates
const LIVE_MIN_AGE_FRESH_MS = 30 * 60 * 1000;   // < 30 min → "fresh" tag
const LIVE_STALE_RATIO = 0.8;                  // past 80% of relevance → "stale"

const FEEDBACK_CATEGORIES = [
  "Politics", "Business", "Tech", "Disaster", "Crime",
  "Conflict", "Health", "Sports", "Science", "Entertainment",
  "Weather", "Education", "Environment", "Other"
];

function toggleFeedbackMenu(btn) {
  const menu = btn.closest(".live-item").querySelector(".live-item-feedback-menu");
  if (menu) menu.hidden = !menu.hidden;
}

async function submitCategoryFeedback(btn, articleId, originalCat, correctedCat) {
  const menu = btn.closest(".live-item-feedback-menu");
  if (menu) menu.hidden = true;
  try {
    await fetch("/api/nn/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model_name: "category_classifier",
        entity_type: "article",
        entity_id: Number(articleId),
        correction_type: "category",
        original: { category: originalCat },
        corrected: { category: correctedCat },
      }),
    });
    const catSpan = btn.closest(".live-item").querySelector(".live-item-cat");
    if (catSpan) {
      catSpan.textContent = correctedCat;
      catSpan.style.background = "rgba(94,234,212,0.2)";
      catSpan.style.borderRadius = "4px";
      catSpan.style.padding = "0 4px";
    }
  } catch (_) {}
}

let liveState = {
  activeTab: "hot",
  collapsed: true,        // both control windows start closed (2026-11-06)
  home: null,
  feed: null,           // last /api/feed/live response
  lastFetched: 0,
  refreshTimer: null,
  inflight: null,       // AbortController for in-flight fetch
  wiki: null,            // last /api/wiki/near response (or null)
  sse: null,             // active EventSource for /api/feed/live/stream
  sseConnectedAt: 0,
};

// Wire the feed's options (radius / item count / refresh) as soon as
// the panel exists.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireLiveOptions, { once: true });
} else {
  wireLiveOptions();
}

// ── Toggle ──────────────────────────────────────────────────────────
// ── Feed thumbnails are fetched only when the panel is OPEN ────────────
//
// The panel starts CLOSED on every viewport, and Chrome's `loading="lazy"`
// threshold is a DISTANCE, not a visibility test: the collapsed panel is
// parked at translateX(-320px), well inside the ~1,250 px lazy margin, so
// every page load pulled ~16 remote publisher images through
// /api/image-proxy for a panel sitting at opacity: 0. Measured: they
// started at 6 s, and in one run each took 17 s and held the network
// open until 24 s — competing with the very tiles that make up the map.
// (`display:none` DOES stop it — the Explore panel's images never load
// while it is `hidden`; a 320 px translate does not.)
//
// So a feed <img> carries `data-src` while the panel is closed, and
// becomes a real request the moment the reader opens it. A re-render
// while open emits `src` directly, so no second pass is needed there.
function liveImgAttr() {
  return liveState.collapsed ? "data-src" : "src";
}
function hydrateLiveImages() {
  const imgs = livePanel.querySelectorAll("img[data-src]");
  for (const img of imgs) {
    img.src = img.getAttribute("data-src");
    img.removeAttribute("data-src");
  }
}

function setPanelCollapsed(collapsed) {
  liveState.collapsed = collapsed;
  if (collapsed) {
    livePanel.classList.add("collapsed");
    livePanel.classList.remove("user-expanded");
    livePanelReopen.classList.add("visible");
  } else {
    livePanel.classList.remove("collapsed");
    livePanel.classList.add("user-expanded");
    livePanelReopen.classList.remove("visible");
    // Turn every deferred thumbnail into a real request now — this is
    // the only path that opens the panel, so nothing can be left blank.
    hydrateLiveImages();
  }
}
livePanelToggle.addEventListener("click", () => setPanelCollapsed(true));
livePanelReopen.addEventListener("click", () => setPanelCollapsed(false));

// Collapse by default — EVERY viewport, not just phones (owner,
// 2026-11-06: "don't start with the two control windows open when
// someone first visits"). `setPanelCollapsed(true)` adds .collapsed
// (translateX(-100%) + opacity 0 + pointer-events:none) and reveals
// #live-panel-reopen, so the feed is one tap away instead of covering
// the map. It used to run only under 768px, so a desktop visitor met a
// 320px panel over the left third of the map on every load.
setPanelCollapsed(true);

// ── Tab switching ───────────────────────────────────────────────────
for (const tab of livePanelTabs) {
  tab.addEventListener("click", () => {
    const name = tab.dataset.tab;
    if (!LIVE_TABS.has(name)) return;
    liveState.activeTab = name;
    for (const t of livePanelTabs) {
      const isActive = t.dataset.tab === name;
      t.classList.toggle("active", isActive);
      t.setAttribute("aria-selected", String(isActive));
    }
    // "Your News" gets a fresh feed fetch so recommendations update
    if (name === "your") {
      fetchLiveFeed(true).then(() => renderLivePanel());
    } else {
      renderLivePanel();
    }
    // When switching to "Near me", fly to the user's saved location.
    // If home is not set yet, try to resolve it now (browser geolocation → geoip).
    if (name === "near") {
      if (liveState.home && Number.isFinite(liveState.home.lat) && Number.isFinite(liveState.home.lng)) {
        map.flyTo([liveState.home.lat, liveState.home.lng], 8, { duration: 0.8 });
      } else {
        resolveLiveHome().then((home) => {
          if (home && Number.isFinite(home.lat) && Number.isFinite(home.lng)) {
            map.flyTo([home.lat, home.lng], 8, { duration: 0.8 });
          }
        }).catch(() => {});
      }
    }
  });
}

// ── Fetch /api/feed/live ───────────────────────────────────────────
// When the user hasn't picked/shared a home, "Near Me" still has a
// meaningful anchor: the center of the map they're looking at.
function mapCenterHome() {
  try {
    const c = map.getCenter();
    return c ? { lat: c.lat, lng: c.lng, city: null, country: null, source: "map" } : null;
  } catch (_) {
    return null;
  }
}

async function fetchLiveFeed(force = false) {
  if (!force && liveState.feed && Date.now() - liveState.lastFetched < 10_000) {
    return;   // dedupe — only one fetch per 10s
  }
  if (liveState.inflight) liveState.inflight.abort();
  const ctrl = new AbortController();
  liveState.inflight = ctrl;
  try {
    const url = new URL("/api/feed/live", window.location.origin);
    url.searchParams.set("limit", String(liveOptions.limit));
    url.searchParams.set("radius_km", String(liveOptions.radiusKm));
    // THE TIME CONTROL MUST REACH THE FEED. It never did — neither this
    // request nor the route read a window — so `time=3d` and `24h`
    // returned byte-identical panels and a 28-day-old story sat in "Hot
    // & Latest" under a 3d filter. getSinceDate() is the same mapping
    // the map's own pin query uses, so both views agree by construction;
    // it returns null for "all", which correctly omits the parameter.
    const sinceIso = typeof getSinceDate === "function" ? getSinceDate(timeFilter) : null;
    if (sinceIso) url.searchParams.set("since", sinceIso);
    const home = liveState.home || mapCenterHome();
    if (home) {
      url.searchParams.set("lat", String(home.lat));
      url.searchParams.set("lng", String(home.lng));
    }
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`feed live ${res.status}`);
    const data = await res.json();
    liveState.feed = data;
    liveState.home = data.home || liveState.home;
    liveState.lastFetched = Date.now();
    renderLivePanel();
    renderLiveMeta();
    // Side-channel: load nearby Wikipedia articles if we have a home.
    // Cached server-side for an hour; cheap on the client.
    fetchWikiNear(liveState.home).catch((e) => {
      if (e?.name !== "AbortError") XLog.warn("fetchWikiNear", e);
    });
  } catch (e) {
      if (e?.name !== "AbortError") XLog.warn("fetchLiveFeed", e);
  } finally {
    if (liveState.inflight === ctrl) liveState.inflight = null;
  }
}

// Fetch /api/wiki/near and render the Wikipedia section of the live panel.
// Skips silently if no home is set. Caches the in-flight request so we
// don't fire one per panning frame.
let _wikiInflight = null;
let _wikiLastHome = null;
async function fetchWikiNear(home) {
  if (!home || !Number.isFinite(home.lat) || !Number.isFinite(home.lng)) {
    renderWikiSection(null);
    return;
  }
  // Skip if home hasn't changed since last fetch AND we already have data.
  if (_wikiLastHome
      && Math.abs(_wikiLastHome.lat - home.lat) < 0.001
      && Math.abs(_wikiLastHome.lng - home.lng) < 0.001
      && liveState.wiki) {
    return;
  }
  if (_wikiInflight) _wikiInflight.abort();
  const ctrl = new AbortController();
  _wikiInflight = ctrl;
  try {
    const url = new URL("/api/wiki/near", window.location.origin);
    url.searchParams.set("lat", String(home.lat));
    url.searchParams.set("lng", String(home.lng));
    url.searchParams.set("radius_m", "5000");
    url.searchParams.set("limit", "20");
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`wiki near ${res.status}`);
    const data = await res.json();
    liveState.wiki = data;
    _wikiLastHome = home;
    renderWikiSection(data);
  } catch (e) {
    if (e?.name !== "AbortError") XLog.warn("fetchWikiNear", e);
    renderWikiSection(null);
  } finally {
    if (_wikiInflight === ctrl) _wikiInflight = null;
  }
}

function renderWikiSection(data) {
  const wikiEl = document.getElementById("live-panel-wiki");
  if (!wikiEl) return;
  if (!data || !data.results?.length) {
    wikiEl.hidden = true;
    wikiEl.innerHTML = "";
    return;
  }
  const title = `<div class="live-panel-section-title">Wikipedia · ${data.results.length} nearby</div>`;
  const items = data.results.slice(0, 12).map((a) => {
    const extract = a.extract ? escapeHtml(a.extract) : "(no extract)";
    const distKm = a.distance_m != null ? formatDistance(a.distance_m) : "";
    return `<a class="live-wiki-item" href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">
      <p class="live-wiki-title">${escapeHtml(a.title)}</p>
      <p class="live-wiki-extract">${extract}</p>
      <div class="live-wiki-meta">${distKm ? distKm : ""}</div>
    </a>`;
  }).join("");
  wikiEl.innerHTML = title + items;
  wikiEl.hidden = false;
}

// ── Render meta line ("Hot — 30 stories, last 12s ago") ─────────────
function renderLiveMeta() {
  if (!liveState.feed) { livePanelMeta.textContent = "loading…"; return; }
  const ageSec = Math.max(0, Math.round((Date.now() - liveState.lastFetched) / 1000));
  const count = liveState.activeTab === "hot"
    ? liveState.feed.hot.length
    : liveState.feed.near.length;
  const tab = liveState.activeTab === "hot" ? "Hot" : "Near me";
  const home = liveState.feed.home;
  const where = home
    ? ` · ${home.city || `${home.lat.toFixed(2)},${home.lng.toFixed(2)}`} (${home.source || "?"})`
    : " · location unknown";
  livePanelMeta.textContent = `${tab}${where} · ${count} ${count === 1 ? "story" : "stories"} · updated ${ageSec}s ago`;
}

// ── 🤖 THE AI SUGGESTED TAB ───────────────────────────────────────────
//
// "What the AI is most sure about" — the newest stories the classifier
// placed with a high confidence.
//
// THE UNBOUNDED QUERY WAS THE BUG. The tab used to ask the pins LIST
// endpoint for `min_confidence=0.85` with NO time window: the articles
// leg of that query has no time predicate, so the plan is a sequential
// scan of the 17 GB `news_articles` table behind a window function.
// MEASURED on the live site: the query was STILL RUNNING after thirteen
// minutes (four copies of it, each reading 17 GB), and the tab said
// "Loading AI Suggestions…" for the whole of that time.
//
// SO THE TAB IS WINDOWED, ALWAYS. It follows the panel's own time
// filter, capped at three days — and "all time" (what getSinceDate()
// answers for the "All" filter) is capped too: the suggestions are
// "what the AI picked recently", and an unbounded list of them is a
// query that never comes back.
//
// The source is the MAP endpoint (`/api/pins/map`), not the list one:
// it is the site's hot path — index-backed, the same query the map
// itself asks for — and it carries the PLACE, the country and the
// image, so a card says WHERE the story is. That is the difference
// between a list of headlines and a list of stories.
//
// MEASURED live on this box: the world view with a 24 h window answers
// in 1.7–3.4 s cold (and is cached for 15 s by the API); the old
// unbounded query never answered at all.
const AI_SUGGEST_MAX_DAYS = 3;
const AI_SUGGEST_FETCH = 60;     // rows fetched …
const AI_SUGGEST_SHOW = 30;      // … rows shown
const AI_SUGGEST_MIN_CONF = 0.85;
const AI_SUGGEST_TIMEOUT_MS = 25_000;

let _aiSuggestedCache = null;
let _aiSuggestedCacheAt = 0;

/**
 * The window the AI tab asks for: the panel's own filter, never longer
 * than three days, and ALWAYS bounded.
 *
 * THE ARITHMETIC, because it is easy to get backwards: a window is
 * [since, now], and a SHORTER window has the LATER start. So the
 * answer is the LATER of the reader's `since` and the three-day cap —
 * `max()`, not `min()`. (Taking the earlier one would have made the
 * cap WIDEN the window: the default 24 h filter would have asked for
 * three days, and "all time" for the whole corpus.)
 */
function aiSuggestedSince() {
  let since = null;
  try {
    since = typeof getSinceDate === "function" ? getSinceDate(timeFilter) : null;
  } catch (_) { since = null; }
  const cap = Date.now() - AI_SUGGEST_MAX_DAYS * 86400_000;
  const t = since ? Date.parse(since) : NaN;
  return new Date(Number.isFinite(t) && t > cap ? t : cap).toISOString();
}

async function renderAiSuggestedTab() {
  livePanelList.innerHTML = `<div class="live-empty">Loading AI Suggestions…</div>`;
  const now = Date.now();
  if (!_aiSuggestedCache || now - _aiSuggestedCacheAt > 60_000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AI_SUGGEST_TIMEOUT_MS);
    try {
      const since = aiSuggestedSince();
      const url = `/api/pins/map?bbox=-180,-85,180,85&limit=${AI_SUGGEST_FETCH}` +
                  `&since=${encodeURIComponent(since)}`;
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`ai suggestions ${res.status}`);
      const data = await res.json();
      // The confidence gate the old query did in SQL, done here — the
      // map endpoint has no such parameter.
      _aiSuggestedCache = (data.pins || []).filter(
        (p) => (p.confidence_score ?? 1) >= AI_SUGGEST_MIN_CONF);
      _aiSuggestedCacheAt = now;
    } catch (e) {
      // NO SILENT SUBSTITUTE. The old code fell back to the feed's hot
      // list — a DIFFERENT answer under the same tab name, which is a
      // lie the reader cannot see. A failed list says so.
      _aiSuggestedCache = null;
      _aiSuggestedCacheAt = 0;
      const slow = e && e.name === "AbortError";
      livePanelList.innerHTML =
        `<div class="live-empty">${slow ? "The AI suggestions took too long" : "The AI suggestions could not be loaded"}. ` +
        `<button type="button" class="live-opt-btn" id="live-ai-retry">↻ Try again</button></div>`;
      const retry = document.getElementById("live-ai-retry");
      if (retry) retry.addEventListener("click", () => renderAiSuggestedTab());
      return;
    } finally {
      clearTimeout(timer);
    }
  }

  const items = (_aiSuggestedCache || []).slice(0, AI_SUGGEST_SHOW);
  if (!items.length) {
    livePanelList.innerHTML = `<div class="live-empty">No AI suggestions right now.</div>`;
    return;
  }

  const html = items.map((it) => {
    const headline = escapeHtml(it.title || it.headline || "(untitled)");
    const rawCat = it.category || it.event_type || "other";
    const displayCat = beautifyCategory(rawCat, headline);
    // The map endpoint carries the country at the TOP level
    // (`source_country`); the list endpoint carried it inside
    // `location`. Read all three — a card that cannot say WHERE the
    // story is is a list of headlines, not a list of stories.
    const cc = it.source_country || it.location?.country || it.country || "";
    const flag = countryFlagEmoji(cc);
    const placeName = it.location?.place_name || it.place_name || "";
    // NO INVENTED NUMBER. The old code answered `confidence_score ||
    // 0.9`, so a story the server had said NOTHING about was shown as
    // "🤖 90% Match" — a number the server never sent. The badge is
    // drawn only when there is a confidence to draw.
    const confPct = it.confidence_score != null
      ? Math.round(it.confidence_score * 100) : null;
    const confBadge = confPct != null
      ? `<span class="live-item-multi" style="background:rgba(94,234,212,0.15);color:var(--accent);" title="AI confidence in this story's location">🤖 ${confPct}% Match</span>`
      : "";
    const nImg = it.image_url
      ? (() => {
        const src = _imgProxy(it.image_url);
        if (!src) return "";
        return `<img class="live-item-img" ${liveImgAttr()}="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-source-id="${it.source_id || ''}" onload="imgOnLoad(this)" onerror="imgOnError(this)">`;
      })()
      : "";
    const nLink = it.canonical_url
      ? `<a class="live-item-link" href="${escapeHtml(it.canonical_url)}" target="_blank" rel="noopener noreferrer" title="Open source" onclick="event.stopPropagation()">source ↗</a>`
      : "";

    return `
      <div class="live-item" data-id="${it.id}" data-lat="${it.location?.lat || ''}" data-lng="${it.location?.lng || ''}" data-type="article">
        <div class="live-item-body">
          ${nImg}
          <div class="live-item-text">
            <div class="live-item-headline">${headline}</div>
            <div class="live-item-meta">
          <span class="live-item-cat">${escapeHtml(displayCat)}</span>
          ${placeName ? `<span>${flag} ${escapeHtml(placeName)}</span>` : ""}
          ${nLink}
           ${confBadge}
        </div>
          </div>
        </div>
      </div>`;
  }).join("");

  livePanelList.innerHTML = html;

  for (const node of livePanelList.querySelectorAll(".live-item")) {
    node.addEventListener("click", async (e) => {
      if (e && e.target && e.target.closest('a')) return;
      const lat = Number(node.dataset.lat);
      const lng = Number(node.dataset.lng);
      const id = Number(node.dataset.id);
      const itemType = node.dataset.type || "event";
      openExploreArticle(id, lat, lng);
      // Toggle sources panel — same logic as Hot/Near tabs
      const sourcesEl = document.getElementById(`live-sources-${id}`);
      if (!sourcesEl) return;
      if (!sourcesEl.hidden) {
        sourcesEl.hidden = true;
        sourcesEl.innerHTML = "";
        return;
      }
      sourcesEl.hidden = false;
      sourcesEl.innerHTML = `<div class="live-sources-loading">Loading sources…</div>`;
      if (itemType === "article") {
        const url = node.dataset.url;
        const srcName = node.dataset.sourceName;
        if (url) {
          sourcesEl.innerHTML = `<div class="live-source">
            <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(node.querySelector(".live-item-headline")?.textContent || "source")}</a>
            ${srcName ? `<span class="live-source-name">${escapeHtml(srcName)}</span>` : ""}
          </div>`;
        } else {
          sourcesEl.innerHTML = `<div class="live-sources-empty">No sources</div>`;
        }
        return;
      }
      try {
        const res = await fetch(`/api/events/${id}`);
        if (!res.ok) { sourcesEl.innerHTML = `<div class="live-sources-error">Failed to load</div>`; return; }
        const detail = await res.json();
        const list = (detail.sources || []).map((s) => {
          const method = s.auto_categorize_method;
          let autoBadge = "";
          if (method === "source_fallback") {
            autoBadge = ' <span class="auto-tag source-fallback" title="Source-based location">📍</span>';
          } else if (method === "fast_path") {
            autoBadge = ' <span class="auto-tag fast-path" title="Auto-detected">🏷️</span>';
          }
          return `
          <div class="live-source">
            <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title || s.source_name || "source")}</a>
            <span class="live-source-name">${escapeHtml(s.source_name || "")}${autoBadge}</span>
          </div>`;
        }).join("");
        sourcesEl.innerHTML = list || `<div class="live-sources-empty">No sources</div>`;
      } catch (e) {
        sourcesEl.innerHTML = `<div class="live-sources-error">Error loading</div>`;
      }
    });
  }
}

function renderLivePanel() {
  if (!liveState.feed) return;
  if (liveState.activeTab === "your") {
    renderYourNewsTab();
    return;
  }
  if (liveState.activeTab === "neural") {
    renderAiSuggestedTab();
    return;
  }
  if (liveState.activeTab === "trending") {
    renderTrendingTab();
    return;
  }
  if (liveState.activeTab === "local") {
    renderLocalTab();
    return;
  }
  if (liveState.activeTab === "new") {
    renderNewTab();
    return;
  }
  const items = liveState.activeTab === "hot"
    ? liveState.feed.hot || []
    : liveState.feed.near || [];
  if (!items.length) {
    livePanelList.innerHTML = `<div class="live-empty">No stories right now.</div>`;
    return;
  }
  const now = Date.now();
  const html = items.map((it) => renderLiveItem(it, now)).join("");
  livePanelList.innerHTML = html;
  // Wire click-to-fly-to-pin and source loading.
  for (const node of livePanelList.querySelectorAll(".live-item")) {
    node.addEventListener("click", async (e) => {
      if (e && e.target && e.target.closest('a')) return;
      // The SOURCES BADGE opens the source list and does NOT move the
      // map — the reader asked for the articles, not for a fly-to.
      if (e && e.target && e.target.closest(".live-item-sources-btn")) {
        toggleLiveSources(node);
        return;
      }
      const lat = Number(node.dataset.lat);
      const lng = Number(node.dataset.lng);
      const id = Number(node.dataset.id);
      const itemType = node.dataset.type || "event";
      // Track what the user is reading so Help Me chat can be personal
      try {
        const headline = node.querySelector(".live-item-headline")?.textContent || "";
        const cityName = node.dataset.cityName || "";
        if (window.XyzoHelpMe?.track) {
          window.XyzoHelpMe.track("article", headline);
          if (cityName) window.XyzoHelpMe.track("topic", cityName);
        }
      } catch {}
      openExploreEvent(id, lat, lng);
      // Toggle sources panel.
      toggleLiveSources(node);
    });
  }
}

// Open (or close) the source list for a live-feed item.
//
// THE LIST IS THE POINT. The "🔥 N sources" badge used to be a plain
// span, so clicking it bubbled to the item's handler: the map flew to
// the pin and opened its popup, and a reader who wanted to READ THE
// SOURCES got a fly-to instead. The badge is now a button that opens
// this list and never moves the map — and every entry in the list is a
// link straight to the publisher's article.
function toggleLiveSources(node) {
  const id = Number(node.dataset.id);
  const sourcesEl = document.getElementById(`live-sources-${id}`);
  if (!sourcesEl) return;
  if (!sourcesEl.hidden) {
    sourcesEl.hidden = true;
    sourcesEl.innerHTML = "";
    return;
  }
  sourcesEl.hidden = false;
  sourcesEl.innerHTML = `<div class="live-sources-loading">Loading sources…</div>`;
  const itemType = node.dataset.type || "event";
  if (itemType === "article") {
    const url = node.dataset.url;
    const srcName = node.dataset.sourceName;
    if (url) {
      sourcesEl.innerHTML = `<div class="live-source">
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="live-source-title">${escapeHtml(node.querySelector(".live-item-headline")?.textContent || "source")}</a>
        ${srcName ? `<span class="live-source-name">${escapeHtml(srcName)}</span>` : ""}
        <a class="live-source-open" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
      </div>`;
    } else {
      sourcesEl.innerHTML = `<div class="live-sources-empty">No sources</div>`;
    }
    return;
  }
  // Fetch and render sources.
  loadLiveSources(id, sourcesEl);
}

async function loadLiveSources(id, sourcesEl) {
  try {
    const res = await fetch(`/api/events/${id}`);
    if (!res.ok) { sourcesEl.innerHTML = `<div class="live-sources-error">Failed to load</div>`; return; }
    const detail = await res.json();
    const list = (detail.sources || []).map((s) => {
      const method = s.auto_categorize_method;
      let autoBadge = "";
      if (method === "source_fallback") {
        autoBadge = ' <span class="auto-tag source-fallback" title="Source-based location">📍</span>';
      } else if (method === "fast_path") {
        autoBadge = ' <span class="auto-tag fast-path" title="Auto-detected">🏷️</span>';
      }
      const href = escapeHtml(s.url || "");
      return `
      <div class="live-source">
        <a href="${href}" target="_blank" rel="noopener noreferrer" class="live-source-title">${escapeHtml(s.title || s.source_name || "source")}</a>
        <span class="live-source-name">${escapeHtml(s.source_name || "")}${autoBadge}</span>
        <a class="live-source-open" href="${href}" target="_blank" rel="noopener noreferrer">Open ↗</a>
      </div>`;
    }).join("");
    sourcesEl.innerHTML = list
      ? list + `<div class="live-sources-foot">${(detail.sources || []).length} source(s) — each opens the publisher's own page</div>`
      : `<div class="live-sources-empty">No sources</div>`;
  } catch (e) {
    sourcesEl.innerHTML = `<div class="live-sources-error">Error loading</div>`;
  }
}

// ── Trending tab: cities with accelerated event volume ────────────
//
// Cached for 5 minutes so a heavy click session doesn't hammer the
// server. Items are clickable to fly the map to that city.
let _trendingCache = null;
let _trendingCacheAt = 0;
async function renderTrendingTab() {
  livePanelList.innerHTML = `<div class="live-empty">Loading…</div>`;
  const now = Date.now();
  if (!_trendingCache || now - _trendingCacheAt > 5 * 60_000) {
    try {
      const res = await fetch("/api/cities/trending?hours=6&limit=20");
      if (!res.ok) throw new Error(`trending ${res.status}`);
      const data = await res.json();
      _trendingCache = data;
      _trendingCacheAt = now;
    } catch (e) {
      livePanelList.innerHTML = `<div class="live-empty">Couldn't load trending cities.</div>`;
      return;
    }
  }
  if (!_trendingCache.cities.length) {
    livePanelList.innerHTML = `<div class="live-empty">No acceleration in the last 6h.</div>`;
    return;
  }
  const flag = (cc) => cc && cc.length === 2
    ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0)))
    : "";
  livePanelList.innerHTML = _trendingCache.cities.map((c) => {
    const accelClass = c.acceleration >= 5 ? "high"
                     : c.acceleration >= 2 ? "med"
                     : "low";
    return `
      <div class="trending-item" data-lat="${c.lat}" data-lng="${c.lng}"
           data-name="${escapeAttr(c.place_name)}" data-cc="${escapeAttr(c.country || "")}">
        <div class="trending-row1">
          <span class="trending-flag">${flag(c.country || '')}</span>
          <span class="trending-name">${escapeHtml(c.place_name)}</span>
          <span class="trending-accel accel-${accelClass}">${c.acceleration >= 999 ? 'NEW' : c.acceleration + '×'}</span>
        </div>
        <div class="trending-row2">
          <span class="trending-meta">${escapeHtml(c.country || '')} · ${c.recent_count} in last 6h</span>
        </div>
      </div>`;
  }).join("");
  // Click → fly to city + load any events there.
  livePanelList.querySelectorAll(".trending-item").forEach((node) => {
    node.addEventListener("click", () => {
      const lat = Number(node.dataset.lat);
      const lng = Number(node.dataset.lng);
      const cc = node.dataset.cc;
      const name = node.dataset.name;
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        map.flyTo([lat, lng], 6, { duration: 0.8 });
        // Apply a soft filter via URL hash so the map shows events in this area.
        if (cc) {
          // No fancy state — just highlight by panning there.
          XLog.debug("trending →", name, cc);
        }
      }
    });
  });
}

// ── Local tab: sources near the current map center ─────────────────
//
// Shows news sources that are geographically close to where the user
// is looking. Each source shows its name, country, distance, and
// recent article count. Clicking a source flies to its location and
// loads its recent articles.
let _localCache = null;
let _localCacheAt = 0;
let _localCacheLat = null;
let _localCacheLng = null;
async function renderLocalTab() {
  livePanelList.innerHTML = `<div class="live-empty">Loading local news sources…</div>`;
  const now = Date.now();

  // Get current map center.
  const center = map.getCenter();
  const lat = center.lat;
  const lng = center.lng;

  // Check if center moved significantly (> 5km / 0.05deg) or cache expired (60s)
  const centerMoved = _localCacheLat == null || _localCacheLng == null || Math.hypot(lat - _localCacheLat, lng - _localCacheLng) > 0.05;
  if (!_localCache || now - _localCacheAt > 60_000 || centerMoved) {
    try {
      const res = await fetch(`/api/sources/local?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}&limit=20`);
      if (!res.ok) throw new Error(`local ${res.status}`);
      const data = await res.json();
      _localCache = data;
      _localCacheAt = now;
      _localCacheLat = lat;
      _localCacheLng = lng;
    } catch (e) {
      livePanelList.innerHTML = `<div class="live-empty">Couldn't load local sources.</div>`;
      return;
    }
  }

  if (!_localCache.sources.length) {
    livePanelList.innerHTML = `<div class="live-empty">No sources found near this area.</div>`;
    return;
  }

  const flag = (cc) => cc && cc.length === 2
    ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0)))
    : "";

  livePanelList.innerHTML = _localCache.sources.map((s) => {
    const distLabel = s.distance_km < 100 ? `${s.distance_km} km`
                    : s.distance_km < 1000 ? `${s.distance_km} km`
                    : `${(s.distance_km / 1000).toFixed(1)}k km`;
    const activeClass = s.articles_24h > 0 ? "active" : "inactive";
    return `
      <div class="local-source" data-id="${s.id}" data-lat="${s.lat}" data-lng="${s.lng}"
           data-name="${escapeAttr(s.name)}" data-country="${escapeAttr(s.country || '')}">
        <div class="local-source-row1">
          <span class="local-flag">${flag(s.country || '')}</span>
          <span class="local-name">${escapeHtml(s.name)}</span>
          <span class="local-dist">${distLabel}</span>
        </div>
        <div class="local-source-row2">
          <span class="local-meta">${escapeHtml(s.region || '')} · ${s.language}</span>
          <span class="local-articles ${activeClass}">${s.articles_24h} articles</span>
        </div>
        <div id="local-articles-${s.id}" class="local-articles-list" hidden></div>
      </div>`;
  }).join("");

  // Click → fly to source + load its recent articles.
  livePanelList.querySelectorAll(".local-source").forEach((node) => {
    node.addEventListener("click", async (e) => {
      if (e && e.target && e.target.closest('a')) return;
      const lat = Number(node.dataset.lat);
      const lng = Number(node.dataset.lng);
      const sourceId = Number(node.dataset.id);

      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        map.flyTo([lat, lng], 6, { duration: 0.8 });
      }

      // Load and show recent articles from this source.
      const articlesEl = document.getElementById(`local-articles-${sourceId}`);
      if (articlesEl) {
        if (!articlesEl.hidden) {
          articlesEl.hidden = true;
          articlesEl.innerHTML = "";
          return;
        }
        articlesEl.hidden = false;
        articlesEl.innerHTML = `<div class="live-sources-loading">Loading articles…</div>`;
        try {
          const res = await fetch(`/api/sources/${sourceId}/articles?limit=10`);
          if (!res.ok) throw new Error("failed");
          const data = await res.json();
          if (!data.articles || data.articles.length === 0) {
            articlesEl.innerHTML = `<div class="live-sources-empty">No articles found.</div>`;
          } else {
            articlesEl.innerHTML = data.articles.map((art) => {
              const headline = escapeHtml(art.title || "Untitled article");
              const url = escapeHtml(art.url);
              const place = art.location?.place_name ? `📍 ${escapeHtml(art.location.place_name)}` : "";
              const when = formatRelativeTime(art.published_at);
              return `<div class="local-article-card" style="padding:8px;margin:4px 0;background:rgba(255,255,255,0.04);border-radius:6px;border:1px solid rgba(255,255,255,0.08);">
                <a href="${url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="color:var(--accent,#5eea2d);font-weight:600;text-decoration:none;display:block;margin-bottom:4px;font-size:12px;line-height:1.3;">${headline} ↗</a>
                <div style="font-size:10px;color:var(--muted);display:flex;justify-content:space-between;align-items:center;">
                  <span>${when}</span>
                  ${art.location ? `<span style="cursor:pointer;color:var(--fg);background:rgba(255,255,255,0.08);padding:1px 6px;border-radius:4px;" onclick="event.stopPropagation();map.flyTo([${art.location.lat}, ${art.location.lng}], 7, {duration:0.8});">${place}</span>` : ""}
                </div>
              </div>`;
            }).join("");
          }
        } catch (e) {
          articlesEl.innerHTML = `<div class="live-sources-error">Failed to load articles</div>`;
        }
      }
    });
  });
}

// ── New tab: recently added events (last 24h) ─────────────────────
//
// Shows events that were just created/clustered, sorted by
// first_reported_at descending. Auto-refreshes every 30 seconds
// so new stories appear in real-time as the extraction pipeline
// processes them.
let _newCache = null;
let _newCacheAt = 0;

// Clear the active news-list highlight: state + DOM class. No-op when
// already null (safe to call from empty-map handler unconditionally).
function clearActiveHeadlineHighlight() {
  if (_activeHeadlineEventId == null) return;
  _activeHeadlineEventId = null;
  document
    .querySelectorAll(".new-item.new-item-active")
    .forEach((n) => n.classList.remove("new-item-active"));
}

async function renderNewTab() {
  livePanelList.innerHTML = `<div class="live-empty">Loading…</div>`;
  const now = Date.now();

  // Cache for 30 seconds — short so new stories appear quickly.
  if (!_newCache || now - _newCacheAt > 30_000) {
    try {
      // Get events from the last 24 hours, sorted by most recent first.
      const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      const res = await fetch(`/api/events?since=${encodeURIComponent(since)}&limit=50`);
      if (!res.ok) throw new Error(`new ${res.status}`);
      const data = await res.json();
      _newCache = data;
      _newCacheAt = now;
    } catch (e) {
      livePanelList.innerHTML = `<div class="live-empty">Couldn't load new stories.</div>`;
      return;
    }
  }

  if (!_newCache.events || !_newCache.events.length) {
    livePanelList.innerHTML = `<div class="live-empty">No new stories yet. Extraction is running…</div>`;
    return;
  }

  const nowMs = Date.now();
  const html = _newCache.events.map((ev) => {
    const headline = escapeHtml(ev.headline || "(untitled)");
    const cat = ev.event_type || "other";
    const ageMs = nowMs - new Date(ev.first_reported_at).getTime();
    const ageMin = Math.floor(ageMs / 60000);
    const ageLabel = ageMin < 1 ? "just now"
                   : ageMin < 60 ? `${ageMin}m ago`
                   : `${Math.floor(ageMin / 60)}h ago`;
    const place = ev.location?.place_name || "";
    const cc = ev.location?.country || "";
    const flag = cc && cc.length === 2
      ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0)))
      : "";
    const divBadge = ev.diversity === "local" ? "🏙️"
                   : ev.diversity === "national" ? "🌍"
                   : ev.diversity === "international" ? "🌎" : "";
    const srcBadge = ev.source_count > 1 ? `<span class="new-sources">${ev.source_count} sources</span>` : "";
    const img = ev.image_url
      ? (() => {
        const src = _imgProxy(ev.image_url);
        if (!src) return "";
        return `<img class="live-item-img" ${liveImgAttr()}="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-source-id="${ev.source_id || ''}" onload="imgOnLoad(this)" onerror="imgOnError(this)">`;
      })()
      : "";
    const link = ev.url || ev.event_url
      ? `<a class="live-item-link" href="${escapeHtml(ev.url || ev.event_url)}" target="_blank" rel="noopener noreferrer" title="Open source" onclick="event.stopPropagation()">source ↗</a>`
      : "";

    return `
      <div class="new-item" data-lat="${ev.location?.lat || ''}" data-lng="${ev.location?.lng || ''}" data-id="${ev.id}" data-type="event" data-event-type="${escapeHtml(cat)}">
        <div class="new-item-row1">
          <span class="new-cat cat-${cat}">${cat}</span>
          <span class="new-age">${ageLabel}</span>
          ${divBadge ? `<span class="new-div">${divBadge}</span>` : ""}
          ${link}
        </div>
        <div class="new-item-body">
          ${img}
          <div class="new-item-headline">${headline}</div>
        </div>
        <div class="new-item-row2">
          ${place ? `<span class="new-place">${flag} ${escapeHtml(place)}</span>` : ""}
          ${srcBadge}
          <button class="live-item-feedback-btn" onclick="event.stopPropagation();toggleFeedbackMenu(this)" title="Wrong category?">✏️</button>
        </div>
        <div class="live-item-feedback-menu" hidden>
          <div class="feedback-menu-label">Correct category:</div>
          ${FEEDBACK_CATEGORIES.map(c => `<button class="feedback-cat-btn" onclick="event.stopPropagation();submitCategoryFeedback(this,'${escapeHtml(ev.id)}','${escapeHtml(cat)}','${escapeHtml(c)}')">${escapeHtml(c)}</button>`).join("")}
        </div>
      </div>`;
  }).join("");

  livePanelList.innerHTML = html;

  // Re-apply the active highlight if the same event_id is still in
  // the refreshed list. The list re-renders from scratch every 60s
  // via fetchLiveFeed(true), so DOM persistence is impossible.
  if (_activeHeadlineEventId != null) {
    const active = livePanelList.querySelector(
      `.new-item[data-id="${_activeHeadlineEventId}"]`
    );
    if (active) active.classList.add("new-item-active");
  }

  // Click → fly to event + show popup.
  livePanelList.querySelectorAll(".new-item").forEach((node) => {
    node.addEventListener("click", () => {
      const id = Number(node.dataset.id);
      const lat = Number(node.dataset.lat);
      const lng = Number(node.dataset.lng);

      // Clear any prior highlight before applying the new one. (Same
      // tick, so the user never sees a no-highlight frame.)
      livePanelList
        .querySelectorAll(".new-item.new-item-active")
        .forEach((n) => n.classList.remove("new-item-active"));

      if (Number.isFinite(lat) && Number.isFinite(lng)) {
      openExploreEvent(id, lat, lng);
        node.classList.add("new-item-active");
        _activeHeadlineEventId = id;
      }
    });
  });
}

function beautifyCategory(cat, title = "") {
  if (cat && cat !== "other" && CAT_LABELS[cat.toLowerCase()]) {
    return CAT_LABELS[cat.toLowerCase()];
  }
  const text = (title || "").toLowerCase();
  if (/election|parliament|president|minister|senate|vote|policy|government|trump|biden/i.test(text)) return "Politics 🏛️";
  if (/market|stock|bank|inflation|economy|revenue|billion|quarter|company/i.test(text)) return "Business 📈";
  if (/ai|openai|nvidia|gpu|robot|chip|tech|software|app|cyber/i.test(text)) return "Tech 💻";
  if (/earthquake|flood|storm|hurricane|tsunami|volcano|wildfire|typhoon/i.test(text)) return "Disaster 🌪️";
  if (/police|arrest|kill|murder|court|suspect|crime|investigation|shooting/i.test(text)) return "Crime 🚨";
  if (/war|military|strike|missile|army|defense|nato|russia|ukraine|gaza/i.test(text)) return "Conflict ⚔️";
  if (/health|virus|hospital|cancer|medical|vaccine|disease/i.test(text)) return "Health 🏥";
  if (/soccer|football|nba|nfl|match|league|cup|champion|win|player/i.test(text)) return "Sports ⚽";
  if (/space|nasa|planet|science|study|research|scientist|discovery/i.test(text)) return "Science 🔬";
  return cat && cat !== "other" ? cat : "News 📰";
}

function countryFlagEmoji(cc) {
  if (!cc || cc.length !== 2) return "";
  return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0)));
}

function renderLiveItem(it, nowMs) {
  const headline = escapeHtml(it.headline || "(untitled)");
  const rawCat = it.event_type || it.category || "other";
  const displayCat = beautifyCategory(rawCat, it.headline);
  const ageMs = nowMs - new Date(it.first_reported_at || Date.now()).getTime();
  const ageText = formatShortAge(ageMs);
  const isFresh = ageMs < LIVE_MIN_AGE_FRESH_MS;
  const isStale = it.relevance_days
    ? ageMs > it.relevance_days * 24 * 3600 * 1000 * LIVE_STALE_RATIO
    : false;

  const cc = it.location?.country || it.country || "";
  const flag = countryFlagEmoji(cc);
  const placeName = it.location?.place_name || it.place_name || "";
  const placeBadge = placeName ? ` <span class="live-place">${flag} ${escapeHtml(placeName)}</span>` : "";

  // THE SOURCES BADGE IS A BUTTON, NOT A LABEL.
  //
  // It used to be a plain <span>, so clicking it bubbled to the item's
  // click handler: the map flew to the pin and opened its popup, and
  // the reader who wanted to READ THE SOURCES got a fly-to instead.
  // The badge now opens the source list itself — and never moves the
  // map — so "🔥 337 sources" is a door to the publishers.
  const sourcesBadge = it.source_count > 1
    ? ` <button type="button" class="live-item-multi live-item-sources-btn" data-live-sources="${it.id}" ` +
      `title="Open the ${it.source_count} sources for this story" ` +
      `aria-label="Open ${it.source_count} sources">🔥 ${it.source_count} sources</button>`
    : "";
  const distBadge = it.distance_km != null
    ? ` <span class="live-item-dist" title="distance">${formatDistance(it.distance_km)}</span>`
    : "";

  const lat = it.location?.lat ?? "";
  const lng = it.location?.lng ?? "";
  const itemType = it.type || "event";
  const itemClass = `live-item ${isFresh ? "live-item-fresh" : ""} ${isStale ? "live-item-stale" : ""}`.trim();
  const extraAttrs = itemType === "article"
    ? ` data-url="${escapeHtml(it.url || "")}" data-source-name="${escapeHtml(it.source_name || "")}"`
    : "";
  const img = it.image_url
    ? (() => {
      const src = _imgProxy(it.image_url);
      if (!src) return "";
      return `<img class="live-item-img" ${liveImgAttr()}="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-source-id="${it.source_id || ''}" onload="imgOnLoad(this)" onerror="imgOnError(this)">`;
    })()
    : "";
  const link = it.url
    ? `<a class="live-item-link" href="${escapeHtml(it.url)}" target="_blank" rel="noopener noreferrer" title="Open source" onclick="event.stopPropagation();if(typeof XyzoAnalytics!=='undefined')XyzoAnalytics.trackSourceClick({id:${Number(it.id)||0}},'${escapeHtml(it.url)}')">source ↗</a>`
    : "";
  const srcName = it.source_name
    ? ` <span class="live-item-source-name">${escapeHtml(it.source_name)}</span>`
    : "";
  return `<div class="${itemClass}" data-id="${it.id}" data-lat="${lat}" data-lng="${lng}" data-type="${itemType}" data-event-type="${escapeHtml(rawCat)}"${extraAttrs}>
    <div class="live-item-body">
      ${img}
      <div class="live-item-text">
        <p class="live-item-headline">${headline}</p>
        <div class="live-item-meta">
          <span class="live-item-cat">${escapeHtml(displayCat)}</span>
          <span>${ageText}</span>
          ${placeBadge}
          ${sourcesBadge}
          ${distBadge}
          ${link}
          ${srcName}
          <button class="live-item-feedback-btn" onclick="event.stopPropagation();toggleFeedbackMenu(this)" title="Wrong category?">✏️</button>
        </div>
      </div>
    </div>
    <div class="live-item-feedback-menu" hidden>
      <div class="feedback-menu-label">Correct category:</div>
      ${FEEDBACK_CATEGORIES.map(c => `<button class="feedback-cat-btn" onclick="event.stopPropagation();submitCategoryFeedback(this,'${escapeHtml(it.id)}','${escapeHtml(rawCat)}','${escapeHtml(c)}')">${escapeHtml(c)}</button>`).join("")}
    </div>
    <div class="live-item-sources" id="live-sources-${it.id}" hidden></div>
  </div>`;
}

function formatShortAge(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.floor(mon / 12)}y ago`;
}

function formatDistance(km) {
  if (km == null) return "";
  if (km < 1) return `${Math.round(km * 1000)}m`;
  if (km < 100) return `${Math.round(km)}km`;
  return `${Math.round(km / 100) * 100}km`;
}

// ── Tick / refresh loop ─────────────────────────────────────────────
function tickLive() {
  // Re-render the "Xs ago" labels even if no fetch happened.
  if (liveState.feed) {
    renderLivePanel();
    renderLiveMeta();
  }
}
setInterval(tickLive, 15_000);              // tick labels every 15s

// ── SSE subscription ────────────────────────────────────────────────
//
// /api/feed/live is now an SSE stream (see api/src/routes/feed.ts).
// Server pushes a `snapshot` event on connect and an `article` event
// for every new article the worker inserts. We replace the legacy
// 30-second JSON poll with this single long-lived connection. The
// server also sends a `snapshot` resync every 60s as a safety net so
// a missed `article` event doesn't leave us stale.
//
// Auto-reconnect: EventSource handles transient disconnects itself.
// We track the connection state on `liveState.sse` so callers (home
// change, manual refresh) can close+reopen with new query params.
let _sseBackoff = 0;
function subscribeLiveFeed() {
  const url = new URL("/api/feed/live/stream", window.location.origin);
  url.searchParams.set("limit", "30");
  url.searchParams.set("radius_km", "500");
  const home = liveState.home || mapCenterHome();
  if (home) {
    url.searchParams.set("lat", String(home.lat));
    url.searchParams.set("lng", String(home.lng));
  }
  const targetUrl = url.toString();

  // If already connected or connecting to the exact same stream URL, keep existing connection
  if (liveState.sse && liveState.sseUrl === targetUrl && liveState.sse.readyState !== EventSource.CLOSED) {
    return;
  }

  // Close any prior connection. EventSource auto-reconnects, but
  // when the user changes home we need a fresh stream with new
  // lat/lng/radius_km params — the server can't change those on an
  // open stream.
  if (liveState.sse) {
    try { liveState.sse.close(); } catch (_) {}
    liveState.sse = null;
  }
  liveState.sseUrl = targetUrl;

  let es;
  try {
    es = new EventSource(targetUrl);
  } catch (e) {
    XLog.warn("EventSource ctor failed", e);
    // Fall back to JSON polling so the panel never goes dark.
    return fetchLiveFeed(true);
  }
  liveState.sse = es;
  liveState.sseConnectedAt = Date.now();

  es.addEventListener("snapshot", (e) => {
    _sseBackoff = 0;
    let data;
    try { data = JSON.parse(e.data); } catch (_) { return; }
    // Snapshot failed server-side (or arrived empty) — don't leave the
    // panel dark; fall back to the JSON endpoint once.
    if (data.error || (!(data.hot || []).length && !(data.near || []).length) && !liveState.feed) {
      fetchLiveFeed(true).catch(() => {});
      return;
    }
    if (data.error) return;
    // Treat the snapshot exactly like a JSON /feed/live response —
    // renderLivePanel / renderLiveMeta already key off liveState.feed.
    liveState.feed = data;
    liveState.home = data.home || liveState.home;
    liveState.lastFetched = Date.now();
    renderLivePanel();
    renderLiveMeta();
  });

  es.addEventListener("article", (e) => {
    _sseBackoff = 0;
    let article;
    try { article = JSON.parse(e.data); } catch (_) { return; }
    if (!liveState.feed) liveState.feed = { home: liveState.home, hot: [], near: [] };
    // Map the SSE article shape onto the same one the JSON endpoint
    // returns, so renderLivePanel doesn't need a special case.
    const mapped = {
      id: article.id,
      event_type: article.event_type || article.status || "other",
      headline: article.title,
      summary: article.summary || null,
      first_reported_at: article.published_at || new Date().toISOString(),
      source_count: 1,
      avg_confidence: 0.9,
      relevance_days: 7,
      expires_at: null,
      url: article.url || null,
      image_url: article.image_url || null,
      location: (article.lat != null && article.lng != null)
        ? { lat: Number(article.lat), lng: Number(article.lng), place_name: null, country: null, precision: null }
        : null,
      distance_km: null,
    };
    // Prepend (newest first). Dedup by id so a redundant article +
    // snapshot resync doesn't double-render.
    const hot = liveState.feed.hot || [];
    liveState.feed.hot = [mapped, ...hot.filter((x) => x && x.id !== mapped.id)].slice(0, 100);
    liveState.lastFetched = Date.now();
    renderLivePanel();
    renderLiveMeta();
  });

  // Heartbeat: server sends one every 30s. We just use it as a
  // liveness signal — a stalled heartbeat means the connection is
  // dead and EventSource will reconnect on its own.
  es.addEventListener("heartbeat", () => {
    liveState.lastFetched = Date.now();
  });

  es.addEventListener("error", () => {
    // EventSource auto-reconnects, but we cap the reconnects with an
    // exponential backoff in case the server is down. We back off the
    // *UI* reconnection here (visible feedback); EventSource itself
    // keeps trying at its native rate.
    if (es.readyState === EventSource.CLOSED) {
      _sseBackoff = Math.min(_sseBackoff + 1, 5);
      XLog.warn(`SSE closed, falling back to JSON poll (backoff=${_sseBackoff})`);
      // JSON fallback so the panel keeps refreshing until SSE recovers.
      fetchLiveFeed(true);
      // Schedule a reopen attempt.
      const delay = Math.min(60_000, 1000 * Math.pow(2, _sseBackoff));
      setTimeout(() => subscribeLiveFeed(), delay);
    }
  });
}

window.addEventListener("beforeunload", () => {
  if (liveState.sse) {
    try { liveState.sse.close(); } catch (_) {}
    liveState.sse = null;
  }
});

// First connect: same delay as the old JSON fetch — give the map a
// second to boot before we open any network connection.
setTimeout(() => {
  resolveLiveHome()
    .catch((e) => XLog.warn("resolveLiveHome", e))
    .finally(() => subscribeLiveFeed());
}, 1000);

// Wire the location buttons.
const setLocBtn = document.getElementById("live-panel-set-loc");
if (setLocBtn) {
  setLocBtn.addEventListener("click", () => {
    setLocBtn.disabled = true;
    setLocBtn.textContent = "…";
    requestBrowserLocation()
      .then(() => { setLocBtn.textContent = "📍 Update location"; })
      .catch((err) => {
        setLocBtn.textContent = "📍 Location denied";
        XLog.warn("geolocation", err);
      })
      .finally(() => { setLocBtn.disabled = false; });
  });
}
const clearLocBtn = document.getElementById("live-panel-clear-loc");
if (clearLocBtn) {
  clearLocBtn.addEventListener("click", () => {
    try { localStorage.removeItem("newsium.home"); } catch (_) {}
    liveState.home = null;
    locInput.value = "";
    locResults.hidden = true;
    locResults.innerHTML = "";
    liveState.wiki = null;
    _wikiLastHome = null;
    subscribeLiveFeed();
  });
}

// Manual address / city / country input. Calls the existing
// /api/geocode endpoint (Nominatim under the hood) and shows a small
// dropdown of matches. Picking one sets home and refreshes.
const locInput = document.getElementById("live-panel-loc-input");
const locResults = document.getElementById("live-panel-loc-results");
const locDebounced = debounce(async (q) => {
  if (!q || q.length < 3) { locResults.hidden = true; locResults.innerHTML = ""; return; }
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (!res.ok) { locResults.hidden = true; return; }
    const data = await res.json();
    // GeocodeRoute returns either { error: "not_found" } or the place itself.
    if (!data || data.error) {
      locResults.hidden = true;
      locResults.innerHTML = `<div class="live-panel-loc-result"><span class="live-panel-loc-result-sub">No matches</span></div>`;
      locResults.hidden = false;
      return;
    }
    const display = data.display_name || data.place_name || "(unnamed)";
    locResults.innerHTML = `
      <div class="live-panel-loc-result" data-lat="${data.lat}" data-lng="${data.lng}" data-city="${escapeHtml(display)}">
        <div class="live-panel-loc-result-main">📍 ${escapeHtml(display.split(",")[0])}</div>
        <div class="live-panel-loc-result-sub">${escapeHtml(display)}</div>
      </div>`;
    locResults.hidden = false;
  } catch (_) {
    locResults.hidden = true;
  }
}, 350);

if (locInput) {
  locInput.addEventListener("input", (e) => locDebounced(e.target.value.trim()));
  locInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      locDebounced(e.target.value.trim());
    } else if (e.key === "Escape") {
      locInput.value = "";
      locResults.hidden = true;
      locResults.innerHTML = "";
    }
  });
}

if (locResults) {
  locResults.addEventListener("click", (e) => {
    const row = e.target.closest(".live-panel-loc-result");
    if (!row || !row.dataset.lat) return;
    const lat = Number(row.dataset.lat);
    const lng = Number(row.dataset.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const home = {
      lat, lng,
      city: row.dataset.city || row.dataset.name || undefined,
      source: "manual",
    };
    liveState.home = home;
    try { localStorage.setItem("newsium.home", JSON.stringify(home)); } catch (_) {}
    locInput.value = "";
    locResults.hidden = true;
    locResults.innerHTML = "";
    subscribeLiveFeed();
    // Pan the map to the chosen location so the user sees where it is.
    map.flyTo([lat, lng], 8, { duration: 0.8 });
  });
}

// Resolves a home location for the "Near me" tab. Order:
//   1. localStorage cache (from a previous session)
//   2. explicit query string ?lat=&lng=
//   3. browser geolocation (with explicit user gesture via the
//      "Set my location" button — auto-prompt would be intrusive)
//   4. geoip (via /api/geoip, server-side IP → city)
// Returns the {lat, lng, ...} object (or null if nothing resolved).
async function resolveLiveHome() {
  // 1. Cached location from a previous session (trusted — from browser geolocation).
  // Return immediately; no network, no prompt needed.
  try {
    const cached = localStorage.getItem("newsium.home");
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Number.isFinite(parsed?.lat) && Number.isFinite(parsed?.lng)) {
        liveState.home = parsed;
        return parsed;
      }
    }
  } catch (_) {}

  // 2. Explicit query string (e.g. ?lat=...&lng=...).
  const params = new URLSearchParams(window.location.search);
  const qlat = params.get("lat"), qlng = params.get("lng");
  if (qlat && qlng) {
    const lat = Number(qlat), lng = Number(qlng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const home = { lat, lng, source: "url" };
      liveState.home = home;
      try { localStorage.setItem("newsium.home", JSON.stringify(home)); } catch (_) {}
      return home;
    }
  }

  // 3. Browser geolocation — only if we have NO cached location yet.
  // Runs asynchronously; the feed will already be live with geoip data.
  if (navigator.geolocation) {
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 4000,
          maximumAge: 10 * 60 * 1000,
        });
      });
      const home = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        source: "browser",
      };
      liveState.home = home;
      try { localStorage.setItem("newsium.home", JSON.stringify(home)); } catch (_) {}
      subscribeLiveFeed();
      return home;
    } catch (_) {
      // denied or unavailable — fall through to geoip
    }
  }

  // 4. GeoIP fallback (server-side IP geolocation) — last resort.
  try {
    const res = await fetch("/api/geoip");
    if (res.ok) {
      const data = await res.json();
      if (data?.location?.lat != null && data?.location?.lng != null) {
        const home = {
          lat: data.location.lat,
          lng: data.location.lng,
          city: data.location.city,
          country: data.location.country,
          source: data.location.source,
        };
        liveState.home = home;
        try { localStorage.setItem("newsium.home", JSON.stringify(home)); } catch (_) {}
        return home;
      }
    }
  } catch (_) {}
  return null;
}

function requestBrowserLocation() {
  if (!navigator.geolocation) {
    return Promise.reject(new Error("Browser geolocation not available"));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const home = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          source: "browser",
        };
        liveState.home = home;
        try { localStorage.setItem("newsium.home", JSON.stringify(home)); } catch (_) {}
        subscribeLiveFeed();
        resolve(home);
      },
      (err) => reject(err),
      { enableHighAccuracy: false, timeout: 4000, maximumAge: 10 * 60 * 1000 },
    );
  });
}

// ── Explore Region ──────────────────────────────────────────────────────
// Discover news sources and existing coverage for the current map viewport.

const exploreBtn = document.getElementById("explore-region-btn");
const explorePanel = document.getElementById("explore-panel");
const exploreClose = document.getElementById("explore-close");
const exploreStart = document.getElementById("explore-start");
const exploreAutoAdd = document.getElementById("explore-auto-add");
const exploreResults = document.getElementById("explore-results");
const exploreStatus = document.getElementById("explore-status");
const explorePanelBody = document.getElementById("explore-panel-body");

const exploreCitySearchInput = document.getElementById("explore-city-search-input");
const exploreCityResults = document.getElementById("explore-city-results");
const exploreCityActions = document.getElementById("explore-city-actions");
const exploreCitySelectedName = document.getElementById("explore-city-selected-name");
const exploreFlyBtn = document.getElementById("explore-fly-btn");
const exploreDiscoverBtn = document.getElementById("explore-discover-btn");

let exploreSelectedCity = null;
let exploreActive = false;

function toggleExplorePanel() {
  if (explorePanel.hidden) {
    openModalA11y(explorePanel, { returnFocusTo: exploreBtn });
    exploreBtn.classList.add("active");
    exploreActive = true;
    attachModalEscape(explorePanel, closeExplorePanel);
  } else {
    closeExplorePanel();
  }
}

function closeExplorePanel() {
  closeModalA11y(explorePanel);
  exploreBtn.classList.remove("active");
  exploreActive = false;
  exploreSelectedCity = null;
  exploreCityActions.hidden = true;
  if (exploreCitySearchInput) exploreCitySearchInput.value = "";
  if (exploreCityResults) exploreCityResults.innerHTML = "";
}

exploreBtn.addEventListener("click", toggleExplorePanel);
exploreClose.addEventListener("click", closeExplorePanel);

// City search in explore panel
exploreCitySearchInput?.addEventListener("input", debounce(async () => {
  const q = exploreCitySearchInput.value.trim();
  if (!q) {
    exploreCityResults.innerHTML = "";
    exploreCityActions.hidden = true;
    return;
  }
  exploreCityResults.innerHTML = '<div class="explore-city-empty">Searching...</div>';
  try {
    const res = await fetch(`/api/locations/search?q=${encodeURIComponent(q)}&limit=10`);
    if (!res.ok) throw new Error("Search failed");
    const data = await res.json();
    const cities = data.locations || [];
    if (cities.length === 0) {
      exploreCityResults.innerHTML = '<div class="explore-city-empty">No cities found. Try a different name.</div>';
      exploreCityActions.hidden = true;
      return;
    }
    exploreCityResults.innerHTML = cities.map(c => `
      <div class="explore-city-item" data-lat="${c.lat}" data-lng="${c.lng}" data-name="${escapeHtml(c.place_name)}">
        <strong>${escapeHtml(c.place_name)}</strong>
        <span class="explore-city-meta">${c.event_count ? `· ${c.event_count} sources` : ''}</span>
      </div>
    `).join("");
    exploreCityResults.querySelectorAll(".explore-city-item").forEach(item => {
      item.addEventListener("click", () => {
        exploreSelectedCity = {
          lat: parseFloat(item.dataset.lat),
          lng: parseFloat(item.dataset.lng),
          name: item.dataset.name,
        };
        exploreCitySelectedName.textContent = exploreSelectedCity.name;
        exploreCityActions.hidden = false;
      });
    });
  } catch (e) {
    exploreCityResults.innerHTML = '<div class="explore-city-empty">Error searching. Try again.</div>';
  }
}, 300));

exploreFlyBtn?.addEventListener("click", () => {
  if (exploreSelectedCity) {
    map.flyTo([exploreSelectedCity.lat, exploreSelectedCity.lng], 10, { duration: 1 });
  }
});

// Discover News Here — fly to the city the user picked from the search
// bar, then call /api/explore-region against the post-flyTo viewport so
// the results reflect where the map actually settled, not the previous
// view. Mirrors the exploreStart ("Explore This Region") pattern for
// payload + render, but is anchored on `exploreSelectedCity` so the
// viewport definitely contains the city the user typed.
//
// The flyTo's `moveend` event fires once the animation completes (or
// synchronously under the prefers-reduced-motion path, which the flyTo
// wrapper at line ~897 short-circuits to setView+animate:false).
// `map.once` auto-removes the listener after the first fire so a
// subsequent manual pan doesn't re-trigger this fetch.
exploreDiscoverBtn?.addEventListener("click", async () => {
  if (!exploreSelectedCity || !map) return;
  const { lat, lng } = exploreSelectedCity;

  // Loading state — disable + swap text for a spinner so the click is
  // visibly acknowledged during the 5-75s the worker can take. The
  // explore-status banner ("Exploring region…") gives a richer message
  // once the fetch actually starts.
  const origText = exploreDiscoverBtn.textContent;
  exploreDiscoverBtn.disabled = true;
  exploreDiscoverBtn.innerHTML = '<span class="explore-spinner"></span> Discovering…';

  const runFetch = async () => {
    const bounds = map.getBounds();
    const bbox = [
      bounds.getWest().toFixed(4),
      bounds.getSouth().toFixed(4),
      bounds.getEast().toFixed(4),
      bounds.getNorth().toFixed(4),
    ].join(",");

    showExploreStatus(
      "Exploring region… finding cities, searching news, discovering sources…",
      true,
    );

    try {
      const data = await requestExploreRegion({ bbox, auto_add: false });

      // Empty branch — render a single-line nudge instead of a mostly-
      // blank panel. Otherwise hand off to the shared renderer.
      const cities = data?.cities || [];
      const articleCount = data?.existing_news?.article_count || 0;
      const eventCount = data?.existing_news?.event_count || 0;
      if (cities.length === 0 && articleCount === 0 && eventCount === 0) {
        showExploreStatus(
          "No news yet for this area — try zooming out or panning to a city",
        );
      } else {
        hideExploreStatus();
        renderExploreResults(data);
      }
      // Refresh viewport pins so any newly-added sources appear, even
      // if the explore panel isn't being stared at.
      fetchPinsForViewport();
    } catch (e) {
      showExploreStatus(`Error: ${e.message}`);
    } finally {
      exploreDiscoverBtn.disabled = false;
      exploreDiscoverBtn.textContent = origText;
    }
  };

  map.once("moveend", runFetch);
  map.flyTo([lat, lng], 10, { duration: 1 });
});



// ── Explore Region prefetch ────────────────────────────────────────────
//
// Fire `/api/explore-region` in the background the moment the user opens
// the explore panel, so the first click of "Explore this Region" can
// render instantly from cache instead of waiting 5-75 s on Nominatim +
// AI. The cache key is the current map bbox rounded to 0.1° (~11 km)
// so nearby pans reuse the same result; significant pans trigger a fresh
// fetch.
//
// Prefetch is a deliberate intent signal — we only fire when the user
// opens the panel, not on every map move. Otherwise an idle browser
// tab would burn through the 10/hr IP rate limit + AI quota without
// the user ever clicking Explore.
let _prefetchedExplore = null; // { bboxKey, result, fetchedAt }
let _prefetchController = null;
const PREFETCH_BBOX_PRECISION = 1; // 0.1° rounding (~11 km)
const PREFETCH_TTL_MS = 5 * 60 * 1000; // 5 min

function getExploreBboxKey(bounds) {
  return [
    bounds.getWest().toFixed(PREFETCH_BBOX_PRECISION),
    bounds.getSouth().toFixed(PREFETCH_BBOX_PRECISION),
    bounds.getEast().toFixed(PREFETCH_BBOX_PRECISION),
    bounds.getNorth().toFixed(PREFETCH_BBOX_PRECISION),
  ].join(",");
}

function prefetchExplore() {
  if (!map) return;
  // Only prefetch at city/region zoom — same gate as the explore button
  // showing up in the suggestions. Below this the worker spends its
  // time on empty oceans.
  const zoom = map.getZoom();
  if (zoom < 5) return;
  // Don't pile on top of an in-flight auto-discover.
  if (_currentDiscoveryRequestId) return;

  const bboxKey = getExploreBboxKey(map.getBounds());
  // Cache hit in memory (within TTL) — nothing to do.
  if (_prefetchedExplore &&
      _prefetchedExplore.bboxKey === bboxKey &&
      Date.now() - _prefetchedExplore.fetchedAt < PREFETCH_TTL_MS) {
    return;
  }

  // Check localStorage cache hit
  try {
    const raw = localStorage.getItem("xyzo-explore-cache");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.bboxKey === bboxKey && Date.now() - parsed.fetchedAt < PREFETCH_TTL_MS) {
        _prefetchedExplore = parsed;
        return;
      }
    }
  } catch (_) {}

  // FIX_NOTES 3.2 (R7): opening the Explore PANEL used to fire discovery with
  // auto_add:true — a silent server-side WRITE driven by a read action,
  // ignoring the explicit "Auto-add validated sources" checkbox.
  const autoAddEl = document.getElementById("explore-auto-add");
  fetch("/api/explore-region", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bbox: bboxKey, auto_add: !!(autoAddEl && autoAddEl.checked) }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data) {
        _prefetchedExplore = { bboxKey, result: data, fetchedAt: Date.now() };
        try {
          localStorage.setItem("xyzo-explore-cache", JSON.stringify(_prefetchedExplore));
        } catch (_) {}
        // Refresh viewport pins to show any newly auto-added content
        if (typeof fetchPinsForViewport === "function") fetchPinsForViewport();
      }
    })
    .catch((e) => {
          XLog.debug("[explore-prefetch] background discovery completed with notice:", e);
    });
}

exploreBtn.addEventListener("click", () => {
  // When the panel opens, kick off a background prefetch for the
  // current viewport. The actual Explore button click reads from this
  // cache and renders instantly if the response arrived in time.
  // Prefetch on every toggle-click; the function itself de-dupes by
  // bbox key + TTL so a reopen with the same view is a no-op.
  prefetchExplore();
});

// Show status message with optional spinner
function showExploreStatus(msg, spinning = false) {
  exploreStatus.hidden = false;
  exploreStatus.innerHTML = spinning
    ? `<span class="explore-spinner"></span> ${msg}`
    : msg;
}

// Hide status
function hideExploreStatus() {
  exploreStatus.hidden = true;
  exploreStatus.innerHTML = "";
}

// Format numbers with commas
// Render explore results
function formatNumber(n) {
  return n.toLocaleString();
}

function renderExploreResults(data) {
  const { cities, countries, existing_news, discovered_sources, validated_sources, added_sources, summary } = data;

  let html = "";

  // Safe URL helper — only allow http(s) for href targets.
  const safeHref = (u) => (typeof u === "string" && /^https?:\/\//i.test(u)) ? u : null;

  // RSS-to-homepage rewrites. The data we have is the *feed* URL, not
  // the publisher's homepage, so a naive href sends users to raw XML.
  // These heuristics lift the hostname and strip the rss/feeds/feed path
  // so the link goes to the publisher's main site:
  //
  //   http://rss.cnn.com/rss/edition.rss              → https://cnn.com/
  //   https://feeds.elpais.com/...portada              → https://elpais.com/
  //   https://www.euronews.com/rss?format=xml          → https://www.euronews.com/
  //   https://notesfrompoland.com/feed/                → https://notesfrompoland.com/
  //   https://www.prnewswire.com/rss/news-releases.rss → https://www.prnewswire.com/
  //
  // The rewrites are conservative: we only strip rss./feeds. subdomain
  // prefixes and drop the entire path. If the hostname doesn't match a
  // known feed-host pattern, we still drop the path because every feed
  // URL we've seen has a path that's RSS-only. Returns null on parse
  // failure so the caller can fall back to plain text.
  const feedUrlToHomepage = (feedUrl) => {
    if (typeof feedUrl !== "string") return null;
    try {
      const u = new URL(feedUrl);
      let host = u.hostname.toLowerCase();
      // Strip rss./feeds. subdomain prefix (CNN, El Pais, etc.).
      host = host.replace(/^(rss|feeds)\./, "");
      return `${u.protocol}//${host}/`;
    } catch {
      return null;
    }
  };

  // Stats section
  html += `<div class="explore-section">
    <div class="explore-section-title">Region Overview</div>
    <div class="explore-stats">
      <div class="explore-stat" data-explore-action="toggle-cities" role="button" tabindex="0" title="Show cities">
        <div class="explore-stat-value">${cities.length}</div>
        <div class="explore-stat-label">Cities</div>
      </div>
      <div class="explore-stat" data-explore-action="toggle-articles" role="button" tabindex="0" title="Show articles">
        <div class="explore-stat-value">${existing_news.article_count || 0}</div>
        <div class="explore-stat-label">Articles</div>
      </div>
      <div class="explore-stat" data-explore-action="toggle-events" role="button" tabindex="0" title="Show events">
        <div class="explore-stat-value">${existing_news.event_count || 0}</div>
        <div class="explore-stat-label">Events</div>
      </div>
    </div>
  </div>`;

  // Cities section
  if (cities.length > 0) {
    html += `<div class="explore-section" id="explore-cities-section">
      <div class="explore-section-title">Major Cities</div>
      <div class="explore-cities">
        ${cities.slice(0, 12).map(c => `
          <button type="button" class="explore-city-tag"
                  data-explore-action="fly-to-city"
                  data-lat="${c.lat}"
                  data-lng="${c.lng}"
                  title="Pan map to ${escapeAttr(c.name)}">
            ${escapeHtml(c.name)}
            ${c.country ? `<span class="country-code">${escapeHtml(c.country)}</span>` : ""}
          </button>
        `).join("")}
      </div>
    </div>`;
  }

  // Articles list (collapsed by default — toggled by Articles stat)
  const articles = existing_news.articles || [];
  if (articles.length > 0) {
    html += `<div class="explore-section" id="explore-articles-section" hidden>
      <div class="explore-section-title">Articles in this region (${articles.length})</div>
      <div class="explore-articles-list">
        ${articles.map(a => `
          <div class="explore-article-item"
               data-explore-action="open-article"
               data-id="${a.id}"
               data-lat="${a.lat}"
               data-lng="${a.lng}"
               title="${escapeAttr(a.place_name || "")}">
            <div class="explore-item-title">${escapeHtml(a.title || "(untitled)")}</div>
            <div class="explore-item-meta">${escapeHtml(a.place_name || "?")}${a.country ? " · " + escapeHtml(a.country) : ""}${a.published_at ? " · " + new Date(a.published_at).toLocaleDateString() : ""}</div>
          </div>
        `).join("")}
      </div>
    </div>`;
  }

  // Events list (collapsed by default — toggled by Events stat)
  const events = existing_news.events || [];
  if (events.length > 0) {
    html += `<div class="explore-section" id="explore-events-section" hidden>
      <div class="explore-section-title">Events in this region (${events.length})</div>
      <div class="explore-events-list">
        ${events.map(e => `
          <div class="explore-event-item"
               data-explore-action="open-event"
               data-id="${e.id}"
               data-lat="${e.lat}"
               data-lng="${e.lng}"
               title="${escapeAttr(e.place_name || "")}">
            <div class="explore-item-title">${escapeHtml(e.headline || "(untitled)")}</div>
            <div class="explore-item-meta">${escapeHtml(e.place_name || "?")}${e.country ? " · " + escapeHtml(e.country) : ""}${e.source_count ? " · " + e.source_count + " sources" : ""}</div>
          </div>
        `).join("")}
      </div>
    </div>`;
  }

  // Existing sources section
  if (existing_news.sources && existing_news.sources.length > 0) {
    html += `<div class="explore-section" id="explore-existing-sources-section">
      <div class="explore-section-title">Existing Sources (${existing_news.sources.length})</div>
      ${existing_news.sources.map(s => {
        // Prefer the canonical homepage_url stored at RSS validation time
        // (extracted from the channel-level <link>). Fall back to the
        // feedUrlToHomepage heuristic for legacy rows where
        // homepage_url is NULL, then to the raw feed_url.
        // FIX_NOTES 3.1: source names are attacker-influenceable (web
        // discovery ingests arbitrary site <title>s) — escape.
        const href = safeHref(s.homepage_url) || feedUrlToHomepage(s.feed_url) || safeHref(s.feed_url);
        const nameHtml = href
          ? `<a class="explore-source-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" title="Open homepage: ${escapeAttr(href)}">${escapeHtml(s.name)}</a>`
          : escapeHtml(s.name);
        return `
        <div class="explore-source">
          <div class="explore-source-info">
            <div class="explore-source-name">${nameHtml}</div>
            <div class="explore-source-meta">${s.country || "?"} · ${s.region || "global"}</div>
          </div>
          <span class="explore-source-status ${s.active ? "valid" : "invalid"}">${s.active ? "active" : "inactive"}</span>
        </div>
      `;
      }).join("")}
    </div>`;
  }

  // Discovered sources section
  if (discovered_sources.length > 0) {
    html += `<div class="explore-section" id="explore-discovered-sources-section">
      <div class="explore-section-title">Discovered Sources (${discovered_sources.length})</div>
      ${discovered_sources.map(s => {
        const validation = s.validation || {};
        const addResult = s.add_result;
        let statusClass = validation.valid ? "valid" : "invalid";
        let statusText = validation.valid ? "valid" : "invalid";
        if (addResult && addResult.added) {
          statusClass = "added";
          statusText = "added";
        } else if (addResult && addResult.reason && addResult.reason.includes("already_exists")) {
          statusClass = "existing";
          statusText = "exists";
        }
        // FIX_NOTES 3.1: source names are attacker-influenceable (web
        // discovery ingests arbitrary site <title>s) — escape.
        const href = safeHref(s.homepage_url) || feedUrlToHomepage(s.feed_url) || safeHref(s.feed_url);
        const nameHtml = href
          ? `<a class="explore-source-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" title="Open homepage: ${escapeAttr(href)}">${escapeHtml(s.name)}</a>`
          : escapeHtml(s.name);
        return `
          <div class="explore-source">
            <div class="explore-source-info">
              <div class="explore-source-name">${nameHtml}</div>
              <div class="explore-source-meta">${s.country || "?"} · ${s.language || "en"} · ${s.region || "?"}</div>
              ${validation.error ? `<div class="explore-source-meta" style="color:#fca5a5">${escapeHtml(String(validation.error))}</div>` : ""}
            </div>
            <span class="explore-source-status ${statusClass}">${statusText}</span>
          </div>
        `;
      }).join("")}
    </div>`;
  }

  // Summary
  if (summary) {
    html += `<div class="explore-summary">${summary}</div>`;
  }

  // Auto-add validated sources button — only render when the explore
  // pipeline actually validated something the user can ingest. The click
  // handler lives in the delegated listener further down; we just emit
  // the markup + a feedback slot that the handler fills on success/error.
  if (validated_sources && validated_sources.length > 0) {
    html += `<div class="explore-section" id="explore-auto-add-section">
      <div class="explore-section-title">Validated Sources</div>
      <button type="button" class="explore-auto-add-btn"
              data-explore-action="auto-add-sources"
              data-count="${validated_sources.length}">
        Auto-Add ${validated_sources.length} Validated Source${validated_sources.length === 1 ? "" : "s"}
      </button>
      <div class="explore-auto-add-feedback" id="explore-auto-add-feedback" hidden></div>
    </div>`;
  }

  exploreResults.innerHTML = html;
  exploreResults.hidden = false;

  // Cache the validated sources so the Auto-Add button's click handler
  // can ship them to /api/explore-region/add-sources without round-
  // tripping back to the explore endpoint.
  exploreResults._lastValidatedSources = validated_sources || [];
}

// Open an existing article marker by id; if marker isn't in the current
// viewport, fly the map to the article's lat/lng so it becomes visible.
function openExploreArticle(articleId, lat, lng) {
  if (!map) return;
  const latlng = [Number(lat), Number(lng)];
  const marker = pinMarkers.get(articleId);
  if (marker) {
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 8), { duration: 0.6 });
    marker.openPopup();
  } else {
    map.flyTo(latlng, 8, { duration: 0.6 });
  }
}

// Open an existing event marker by id; same fallback pattern as articles.
function openExploreEvent(eventId, lat, lng) {
  if (!map) return;
  const latlng = [Number(lat), Number(lng)];
  const marker = eventMarkers.get(eventId);
  if (marker) {
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 8), { duration: 0.6 });
    marker.openPopup();
  } else {
    map.flyTo(latlng, 8, { duration: 0.6 });
  }
}

// Event delegation for clickable Explore Region results.
// One listener handles city pan, stat-card toggles, and item fly-to.
exploreResults.addEventListener("click", (ev) => {
  const target = ev.target.closest("[data-explore-action]");
  if (!target) return;
  const action = target.getAttribute("data-explore-action");

  if (action === "fly-to-city") {
    const lat = Number(target.getAttribute("data-lat"));
    const lng = Number(target.getAttribute("data-lng"));
    if (Number.isFinite(lat) && Number.isFinite(lng) && map) {
      map.flyTo([lat, lng], 10, { duration: 0.7 });
    }
    return;
  }

  if (action === "toggle-cities" || action === "toggle-articles" || action === "toggle-events") {
    const sectionId =
      action === "toggle-cities"   ? "explore-cities-section" :
      action === "toggle-articles" ? "explore-articles-section" :
                                     "explore-events-section";
    const section = document.getElementById(sectionId);
    if (section) section.hidden = !section.hidden;
    // Briefly flash the clicked stat so the user sees feedback.
    target.classList.add("explore-stat-active");
    setTimeout(() => target.classList.remove("explore-stat-active"), 250);
    return;
  }

  if (action === "open-article") {
    openExploreArticle(
      target.getAttribute("data-id"),
      target.getAttribute("data-lat"),
      target.getAttribute("data-lng"),
    );
    return;
  }

  if (action === "open-event") {
    openExploreEvent(
      target.getAttribute("data-id"),
      target.getAttribute("data-lat"),
      target.getAttribute("data-lng"),
    );
    return;
  }

  if (action === "auto-add-sources") {
    handleAutoAddSources(target);
    return;
  }
});

// Auto-add the already-validated sources from renderExploreResults to the
// `news_sources` table. We pull the live `validated_sources` array off the
// data the page most recently received — no need to re-run the explore
// pipeline. On success we lock the button + show how many were inserted
// vs already in the DB; on error we surface the message inline.
async function handleAutoAddSources(button) {
  if (!exploreResults || !exploreResults._lastValidatedSources) {
    showExploreStatus("Error: no validated sources in the current Explore session");
    return;
  }
  const sources = exploreResults._lastValidatedSources;

  const feedback = document.getElementById("explore-auto-add-feedback");
  button.disabled = true;
  button.classList.add("explore-auto-add-btn-loading");
  if (feedback) {
    feedback.hidden = false;
    feedback.className = "explore-auto-add-feedback explore-auto-add-pending";
    feedback.textContent = `Adding ${sources.length} source${sources.length === 1 ? "" : "s"}…`;
  }

  try {
    const resp = await fetch("/api/explore-region/add-sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: sources.map((s) => ({
          name: s.name,
          feed_url: s.feed_url,
          country: s.country,
          language: s.language,
          region: s.region,
          description: s.description,
        })),
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${resp.status}`);
    }

    const result = await resp.json();
    const errCount = (result.errors || []).length;
    const parts = [
      `Added ${result.added}`,
      `Skipped ${result.skipped} (duplicate${result.skipped === 1 ? "" : "s"})`,
    ];
    if (errCount > 0) parts.push(`${errCount} error${errCount === 1 ? "" : "s"}`);

    if (feedback) {
      const isError = errCount > 0;
      feedback.className = isError
        ? "explore-auto-add-feedback explore-auto-add-error"
        : "explore-auto-add-feedback explore-auto-add-success";
      feedback.textContent = parts.join(" · ");
    }
    button.textContent = result.added > 0 ? "Added ✓" : "Already in DB";
    button.classList.remove("explore-auto-add-btn-loading");
    button.classList.add("explore-auto-add-btn-done");

    // Refresh the map after newly-added sources have had a chance to
    // be fetched.  The backend triggers a fetch cycle immediately
    // (1s delay), but RSS parsing + geocoding takes time.  Poll a
    // few times so markers appear as soon as articles land.
    if (result.added > 0) {
      let attempts = 0;
      const refreshMap = () => {
        attempts++;
        fetchPinsForViewport();
        if (attempts < 6) setTimeout(refreshMap, 5000);
      };
      setTimeout(refreshMap, 5000);
    }
  } catch (e) {
    if (feedback) {
      feedback.className = "explore-auto-add-feedback explore-auto-add-error";
      feedback.textContent = `Error: ${e.message}`;
    }
    // Re-enable so the user can retry
    button.disabled = false;
    button.classList.remove("explore-auto-add-btn-loading");
  }
}

// Keyboard activation for stat cards (Enter / Space).
exploreResults.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  const target = ev.target.closest('[data-explore-action^="toggle-"]');
  if (!target) return;
  ev.preventDefault();
  target.click();
});

// Main explore action
exploreStart.addEventListener("click", async () => {
  if (!map) return;

  const bounds = map.getBounds();
  const bbox = [
    bounds.getWest().toFixed(4),
    bounds.getSouth().toFixed(4),
    bounds.getEast().toFixed(4),
    bounds.getNorth().toFixed(4),
  ].join(",");

  const autoAdd = exploreAutoAdd.checked;

  exploreStart.disabled = true;
  // Clear the previous results synchronously so a stale render can't
  // linger if the new fetch hangs, errors out, or returns a cached
  // response for the same bbox. InnerHTML = "" also drops the cached
  // _lastValidatedSources reference (we re-set it after the new render).
  exploreResults.innerHTML = "";
  exploreResults._lastValidatedSources = null;
  exploreResults.hidden = true;

  // ── Cache hit: prefetch may have completed while the user was
  // deciding where to click. Render from cache for an instant reply,
  // then refetch in the background so the data is fresh if they
  // click again on the same area.
  const currentBboxKey = getExploreBboxKey(map.getBounds());
  if (_prefetchedExplore &&
      _prefetchedExplore.bboxKey === currentBboxKey &&
      Date.now() - _prefetchedExplore.fetchedAt < PREFETCH_TTL_MS) {
    renderExploreResults(_prefetchedExplore.result);
    fetchPinsForViewport();
    // Refresh in the background — covers the case where the user
    // lingers on the result; a fresh explore picks up new articles
    // discovered by the worker since the prefetch fired.
    setTimeout(prefetchExplore, 0);
    exploreStart.disabled = false;
    return;
  }

  showExploreStatus("Exploring region… finding cities, searching news, discovering sources…", true);

  try {
    const data = await requestExploreRegion({ bbox, auto_add: autoAdd });
    hideExploreStatus();
    renderExploreResults(data);

    // Refresh viewport pins to show any new content
    fetchPinsForViewport();

  } catch (e) {
    showExploreStatus(`Error: ${e.message}`);
  } finally {
    exploreStart.disabled = false;
  }
});

// ── Request News (inside Explore panel) ─────────────────────────────────
// Submit a request for more news coverage in the current viewport.

const exploreRequestMessage = document.getElementById("explore-request-message");
const exploreRequestSubmit = document.getElementById("explore-request-submit");
const exploreRequestStatus = document.getElementById("explore-request-status");

exploreRequestSubmit.addEventListener("click", async () => {
  if (!map) return;

  const bounds = map.getBounds();
  const center = map.getCenter();
  const zoom = map.getZoom();

  const bbox = [
    bounds.getWest().toFixed(4),
    bounds.getSouth().toFixed(4),
    bounds.getEast().toFixed(4),
    bounds.getNorth().toFixed(4),
  ].join(",");

  exploreRequestSubmit.disabled = true;
  exploreRequestStatus.hidden = true;

  try {
    const resp = await fetch("/api/recommend-news", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bbox,
        center_lat: center.lat,
        center_lng: center.lng,
        map_zoom: Math.round(zoom),
        session_id: window.XyzoAnalytics?.sessionId,
        message: exploreRequestMessage.value.trim() || undefined,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${resp.status}`);
    }

    const data = await resp.json();

    exploreRequestStatus.hidden = false;
    exploreRequestStatus.className = "explore-request-status success";
    const baseMsg = data.duplicate
      ? "Already requested for this area recently."
      : "Request submitted! We'll prioritize this area.";
    const _origLink = `https://${location.host}/#${center.lat.toFixed(4)},${center.lng.toFixed(4)},${Math.round(zoom)}`;
    exploreRequestStatus.innerHTML =
      escapeHtml(baseMsg) +
      ' <a href="' + _origLink + '" target="_blank" rel="noopener" ' +
      'style="color:var(--accent);text-decoration:underline;margin-left:6px;">' +
      '🗺 View original →</a>' +
      ' <a href="/help/#tab-requests" target="_blank" rel="noopener" ' +
      'style="color:var(--accent);text-decoration:underline;margin-left:6px;">' +
      'View all coverage requests →</a>';

    exploreRequestMessage.value = "";

    // Auto-hide after 4 seconds
    setTimeout(() => { exploreRequestStatus.hidden = true; }, 4000);

  } catch (e) {
    exploreRequestStatus.hidden = false;
    exploreRequestStatus.className = "explore-request-status error";
    exploreRequestStatus.textContent = `Error: ${e.message}`;
  } finally {
    exploreRequestSubmit.disabled = false;
  }
});

// ── Submit News URL (Explore panel → review queue) ─────────────────────
// Pastes a news article/feed URL into user_news_submissions (pending).
// The server SSRF-validates and queues it; nothing is fetched client-side.

const submitNewsUrl = document.getElementById("submit-news-url");
const submitNewsTitle = document.getElementById("submit-news-title");
const submitNewsNote = document.getElementById("submit-news-note");
const submitNewsSend = document.getElementById("submit-news-send");
const submitNewsStatus = document.getElementById("submit-news-status");

function showSubmitNewsStatus(msg, kind) {
  if (!submitNewsStatus) return;
  submitNewsStatus.hidden = false;
  submitNewsStatus.className = `explore-request-status ${kind || ""}`.trim();
  // msg is always built from escapeHtml()'d fragments — never raw user input.
  submitNewsStatus.innerHTML = msg;
}

submitNewsSend?.addEventListener("click", async () => {
  const rawUrl = (submitNewsUrl?.value || "").trim();
  if (!rawUrl) {
    showSubmitNewsStatus(escapeHtml("Please paste a news URL first."), "error");
    return;
  }
  let normalized;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
    normalized = u.toString();
  } catch {
    showSubmitNewsStatus(escapeHtml("That doesn't look like a valid http(s) URL."), "error");
    return;
  }

  submitNewsSend.disabled = true;
  showSubmitNewsStatus(escapeHtml("Submitting…"), "");

  try {
    const resp = await fetch("/api/news/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: normalized,
        title: (submitNewsTitle?.value || "").trim() || undefined,
        note: (submitNewsNote?.value || "").trim() || undefined,
        session_id: window.XyzoAnalytics?.sessionId,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const reason = data.reason || data.error || `HTTP ${resp.status}`;
      throw new Error(String(reason));
    }
    const base = data.duplicate
      ? "Already in the review queue — thanks!"
      : "Submitted! It will appear on the map after review.";
    showSubmitNewsStatus(
      escapeHtml(`✓ ${base}`) +
      ` <span style="opacity:0.7;">#${escapeHtml(String(data.id ?? ""))}</span>`,
      "success",
    );
    if (submitNewsUrl) submitNewsUrl.value = "";
    if (submitNewsTitle) submitNewsTitle.value = "";
    if (submitNewsNote) submitNewsNote.value = "";
    setTimeout(() => { if (submitNewsStatus) submitNewsStatus.hidden = true; }, 5000);
  } catch (e) {
    XLog.warn("[submit-news] failed:", e);
    showSubmitNewsStatus(escapeHtml(`Error: ${e.message}`), "error");
  } finally {
    submitNewsSend.disabled = false;
  }
});

// ── Help Panel: Map Analysis ─────────────────────────────────────────
// Studies the current map view for density issues, mislocated pins,
// and coverage gaps. Uses non-AI analysis first, then can ask AI.

const helpBtn = document.getElementById("help-btn");
const helpPanel = document.getElementById("help-panel");
const helpClose = document.getElementById("help-close");
const helpStudyBtn = document.getElementById("help-study-btn");
const helpStudyResults = document.getElementById("help-study-results");
const helpStudyStatus = document.getElementById("help-study-status");
const helpAiBtn = document.getElementById("help-ai-btn");
const helpAiQuestion = document.getElementById("help-ai-question");
const helpAiStatus = document.getElementById("help-ai-status");
const helpAiResponse = document.getElementById("help-ai-response");

// Toggle help panel
helpBtn?.addEventListener("click", () => {
  if (helpPanel.hidden) {
    openModalA11y(helpPanel, { returnFocusTo: helpBtn });
    helpBtn.classList.add("active");
    attachModalEscape(helpPanel, closeHelpPanel);
  } else {
    closeHelpPanel();
  }
});

function closeHelpPanel() {
  closeModalA11y(helpPanel);
  helpBtn?.classList.remove("active");
}

helpClose?.addEventListener("click", closeHelpPanel);

// Study the current map view
helpStudyBtn?.addEventListener("click", async () => {
  if (!map) return;

  const bounds = map.getBounds();
  const center = map.getCenter();
  const zoom = map.getZoom();
  const bbox = [
    bounds.getWest().toFixed(4),
    bounds.getSouth().toFixed(4),
    bounds.getEast().toFixed(4),
    bounds.getNorth().toFixed(4),
  ].join(",");

  helpStudyBtn.disabled = true;
  helpStudyResults.hidden = true;
  helpStudyStatus.hidden = false;
  helpStudyStatus.textContent = "Studying map... analyzing density, sources, and coverage.";

  try {
    // Fetch viewport-specific data
    const [pinsRes, densityRes, sourcesRes] = await Promise.all([
      fetch(`/api/pins?bbox=${bbox}&limit=500`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/density/analyze?hours=168`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/sources/search?limit=100`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    const issues = [];
    const suggestions = [];
    const stats = [];

    // ── Viewport pin analysis ──
    const pins = pinsRes?.pins || [];
    stats.push(`<strong>${pins.length} pins</strong> in viewport (zoom ${zoom})`);

    // Count by source type
    const byType = {};
    const byCountry = {};
    const byCategory = {};
    const byMethod = {};
    for (const p of pins) {
      byType[p.source_type] = (byType[p.source_type] || 0) + 1;
      if (p.category) byCategory[p.category] = (byCategory[p.category] || 0) + 1;
    }

    // Count visible markers by source country
    const visibleSources = new Set();
    const visibleCountries = new Set();
    pinMarkers.forEach(m => {
      if (bounds.contains(m.getLatLng())) {
        if (m._pinData?.source_name) visibleSources.add(m._pinData.source_name);
        if (m._pinData?.source_country) visibleCountries.add(m._pinData.source_country);
      }
    });

    stats.push(`<strong>${visibleSources.size} sources</strong> contributing: ${[...visibleSources].slice(0, 8).join(', ')}${visibleSources.size > 8 ? '...' : ''}`);
    stats.push(`<strong>${visibleCountries.size} countries</strong>: ${[...visibleCountries].join(', ')}`);

    // Category breakdown
    const catEntries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    if (catEntries.length > 0) {
      stats.push(`<strong>Categories</strong>: ${catEntries.map(([k, v]) => `${k} (${v})`).join(', ')}`);
    }

    // ── Density analysis (viewport only) ──
    if (densityRes?.clusters) {
      const viewportClusters = densityRes.clusters.filter(cl => {
        return cl.lat >= bounds.getSouth() && cl.lat <= bounds.getNorth() &&
               cl.lng >= bounds.getWest() && cl.lng <= bounds.getEast();
      });
      const suspicious = viewportClusters.filter(c => c.suspicious);

      if (suspicious.length > 0) {
        issues.push(`<strong>${suspicious.length} density clusters</strong> in viewport:`);
        for (const cl of suspicious.slice(0, 5)) {
          issues.push(`&nbsp;&nbsp;• <strong>${cl.city}</strong>: ${cl.pin_count} pins (max ${cl.max_allowed}) — ${cl.reasons.join(', ')}`);
        }
        suggestions.push('Click <strong>Auto-Correct</strong> to spread stacked pins');
        suggestions.push('Click <strong>Relocate</strong> to move mislocated articles to correct cities');
      } else if (viewportClusters.length > 0) {
        stats.push(`<strong>${viewportClusters.length} pin clusters</strong> — all within density limits`);
      }
    }

    // ── Source analysis for this region ──
    if (sourcesRes?.sources) {
      // Find sources that cover countries in the viewport
      const viewportSourceCountries = [...visibleCountries];
      const relevantSources = sourcesRes.sources.filter(s =>
        viewportSourceCountries.includes(s.country) || s.region?.toLowerCase().includes('global')
      );

      if (relevantSources.length > 0) {
        const active = relevantSources.filter(s => s.active);
        const erroring = relevantSources.filter(s => s.error_count > 5);
        const inactive = relevantSources.filter(s => !s.active);

        stats.push(`<strong>${relevantSources.length} registered sources</strong> for this region (${active.length} active, ${erroring.length} erroring, ${inactive.length} inactive)`);

        if (erroring.length > 0) {
          issues.push(`<strong>${erroring.length} sources with errors</strong>: ${erroring.slice(0, 3).map(s => s.name).join(', ')}`);
          suggestions.push('Go to <strong>Help → Manage Sources</strong> to reset errors or disable broken sources');
        }

        if (inactive.length > 0) {
          suggestions.push(`${inactive.length} inactive sources could be re-enabled in Manage Sources`);
        }
      }

      // Check for countries in viewport with no sources
      for (const cc of visibleCountries) {
        const hasSource = sourcesRes.sources.some(s => s.country === cc && s.active);
        if (!hasSource) {
          issues.push(`No active sources for <strong>${cc}</strong> — consider adding regional sources`);
          suggestions.push(`Use <strong>Discover</strong> to find news sources for ${cc}`);
        }
      }
    }

    // ── Coverage analysis ──
    if (pins.length === 0 && zoom >= 6) {
      issues.push(`<strong>No pins</strong> in this area at zoom ${zoom}`);
      suggestions.push('Click <strong>Explore</strong> to discover news sources for this region');
      suggestions.push('Check if sources for this region are active in Manage Sources');
    } else if (pins.length < 5 && zoom >= 8) {
      issues.push(`<strong>Low coverage</strong>: only ${pins.length} pins at city-level zoom`);
      suggestions.push('This area may need more news sources — click Explore to discover');
    }

    // ── Stacking detection (client-side) ──
    const coordCounts = {};
    pinMarkers.forEach(m => {
      if (!bounds.contains(m.getLatLng())) return;
      const ll = m.getLatLng();
      const key = `${ll.lat.toFixed(3)},${ll.lng.toFixed(3)}`;
      coordCounts[key] = (coordCounts[key] || 0) + 1;
    });
    const stacked = Object.entries(coordCounts).filter(([_, count]) => count >= 5);
    if (stacked.length > 0) {
      issues.push(`<strong>${stacked.length} stacked pin groups</strong> (5+ pins at same coordinates)`);
      suggestions.push('Run density correction to spread these pins');
    }

    // ── Render results ──
    helpStudyResults.hidden = false;

    // Show Explore button if no pins and zoomed in enough
    const showExplore = pins.length === 0 && zoom >= 6;

    helpStudyResults.innerHTML = `
      <div style="font-size:12px;">
        <div style="margin-bottom:8px;color:var(--accent);font-weight:600;">Map Study: ${center.lat.toFixed(2)}°, ${center.lng.toFixed(2)}° (zoom ${zoom})</div>
        
        <div style="margin-bottom:12px;">
          <div style="color:var(--fg);font-weight:600;margin-bottom:4px;">Statistics:</div>
          ${stats.map(s => `• ${s}`).join('<br>')}
        </div>

        ${issues.length > 0 ? `
          <div style="margin-bottom:12px;">
            <div style="color:var(--warning);font-weight:600;margin-bottom:4px;">Issues Found:</div>
            ${issues.map(i => `• ${i}`).join('<br>')}
          </div>
        ` : '<div style="margin-bottom:12px;color:var(--success);">No issues detected in this area.</div>'}

        ${suggestions.length > 0 ? `
          <div style="margin-bottom:12px;">
            <div style="color:var(--accent);font-weight:600;margin-bottom:4px;">Suggestions:</div>
            ${suggestions.map(s => `• ${s}`).join('<br>')}
          </div>
        ` : ''}

        ${showExplore ? `
          <div style="margin-bottom:12px;padding:12px;background:rgba(94,234,212,0.08);border:1px solid rgba(94,234,212,0.2);border-radius:6px;">
            <div style="font-weight:600;color:var(--accent);margin-bottom:6px;">No news coverage in this area</div>
            <p style="font-size:11px;color:var(--muted);margin:0 0 8px;">This area has no news pins. Would you like to search the internet for news sources and start AI discovery?</p>
            <button id="help-explore-btn" style="background:var(--accent);color:#0b0f14;border:none;padding:6px 14px;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;">
              🔍 Explore This Area
            </button>
            <span id="help-explore-status" style="font-size:11px;color:var(--muted);margin-left:8px;"></span>
          </div>
        ` : ''}

        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
          <button id="density-correct-btn" style="background:rgba(94,234,212,0.1);border:1px solid var(--accent);color:var(--accent);padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer;">Auto-Correct Density</button>
          <button id="density-relocate-btn" style="background:rgba(94,234,212,0.1);border:1px solid var(--accent);color:var(--accent);padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer;">Relocate Mislocated</button>
          <span id="density-job-status" style="font-size:11px;color:var(--muted);"></span>
        </div>
      </div>
    `;

    // Wire up Explore button
    if (showExplore) {
      const exploreBtn = document.getElementById('help-explore-btn');
      const exploreStatus = document.getElementById('help-explore-status');
      exploreBtn?.addEventListener('click', async () => {
        exploreBtn.disabled = true;
        exploreBtn.textContent = 'Starting discovery...';
        exploreStatus.textContent = '';

        const bbox = [
          bounds.getWest().toFixed(4),
          bounds.getSouth().toFixed(4),
          bounds.getEast().toFixed(4),
          bounds.getNorth().toFixed(4),
        ].join(',');

        try {
          const res = await fetch('/api/auto-discover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              bbox,
              center_lat: center.lat,
              center_lng: center.lng,
              map_zoom: zoom,
              session_id: typeof XyzoAnalytics !== 'undefined' ? XyzoAnalytics.sessionId : null,
            }),
          });
          const data = await res.json();

          if (data.discovery_triggered) {
            exploreBtn.textContent = 'Discovery Started!';
            exploreBtn.style.background = 'var(--success)';
            exploreStatus.textContent = `Finding news sources... (~${data.estimated_time_seconds || 30}s)`;

            // Show the discovery status panel
            if (data.request_id) {
              showAutoDiscoverNotification(data.message, data.request_id, data.job_id);
            }
          } else if (data.has_coverage) {
            exploreBtn.textContent = 'Already Covered';
            exploreStatus.textContent = data.message;
          } else {
            exploreBtn.textContent = 'Discovery Queued';
            exploreStatus.textContent = data.message || 'Request submitted';
          }
        } catch (e) {
          exploreBtn.textContent = 'Error';
          exploreBtn.style.background = 'var(--error)';
          exploreStatus.textContent = e.message;
        }
      });
    }

    // Wire up density correction buttons
    const correctBtn = document.getElementById('density-correct-btn');
    const relocateBtn = document.getElementById('density-relocate-btn');
    const jobStatus = document.getElementById('density-job-status');

    async function runDensityJob(endpoint, label) {
      if (!jobStatus) return;
      jobStatus.textContent = `Starting ${label}...`;
      jobStatus.style.color = 'var(--accent)';

      // Get current viewport bbox
      const bounds = map.getBounds();
      const bbox = [
        bounds.getWest().toFixed(4),
        bounds.getSouth().toFixed(4),
        bounds.getEast().toFixed(4),
        bounds.getNorth().toFixed(4),
      ].map(Number);

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bbox }),
        });
        const data = await res.json();
        if (data.job_id) {
          jobStatus.textContent = `${label} running...`;
          // Poll for completion with detailed progress
          const poll = setInterval(async () => {
            try {
              const statusRes = await fetch(`/api/density/status/${data.job_id}`);
              const status = await statusRes.json();

              if (status.status === 'done') {
                clearInterval(poll);
                const r = status.result || {};
                jobStatus.innerHTML = `<span style="color:var(--success);">Done!</span> ${r.relocated || 0} relocated, ${r.spread || 0} spread, ${r.flagged_for_ai || 0} flagged.`;
                setTimeout(() => fetchPinsForViewport(), 1000);
              } else if (status.status === 'error') {
                clearInterval(poll);
                jobStatus.innerHTML = `<span style="color:var(--error);">Error:</span> ${status.error || 'unknown'}`;
              } else if (status.progress) {
                // Show detailed progress
                const p = status.progress;
                let detail = p.detail || `${label} running...`;
                if (p.article_title) {
                  detail = `<strong>${escapeHtml(p.article_title.slice(0, 60))}</strong><br><span style="font-size:10px;color:var(--muted);">${escapeHtml(detail)}</span>`;
                }
                if (p.current > 0 && p.total > 0) {
                  detail += ` <span style="color:var(--muted);">(${p.current}/${p.total})</span>`;
                }
                jobStatus.innerHTML = `${detail} <span style="color:var(--muted);">${Math.round(status.elapsed_ms / 1000)}s</span>`;
              } else {
                jobStatus.textContent = `${label} running... ${Math.round(status.elapsed_ms / 1000)}s`;
              }
            } catch (e) {
              clearInterval(poll);
              jobStatus.textContent = `Poll error: ${e.message}`;
              jobStatus.style.color = 'var(--error)';
            }
          }, 2000);
        } else {
          jobStatus.textContent = data.message || 'Started';
        }
      } catch (e) {
        jobStatus.textContent = `Error: ${e.message}`;
        jobStatus.style.color = 'var(--error)';
      }
    }

    correctBtn?.addEventListener('click', () => runDensityJob('/api/density/auto-correct', 'Density correction'));
    relocateBtn?.addEventListener('click', () => runDensityJob('/api/density/relocate', 'Relocation'));

    helpStudyStatus.hidden = true;

  } catch (e) {
    helpStudyStatus.textContent = `Error: ${e.message}`;
    helpStudyStatus.className = "explore-status error";
  } finally {
    helpStudyBtn.disabled = false;
  }
});

// Ask AI about the map — gathers rich context before asking
helpAiBtn?.addEventListener("click", async () => {
  if (!map) return;

  const center = map.getCenter();
  const bounds = map.getBounds();
  const zoom = map.getZoom();
  const bbox = [
    bounds.getWest().toFixed(4),
    bounds.getSouth().toFixed(4),
    bounds.getEast().toFixed(4),
    bounds.getNorth().toFixed(4),
  ].join(",");

  const question = helpAiQuestion.value.trim() || "Analyze this area for news coverage issues, mislocated pins, and suggest improvements.";

  helpAiBtn.disabled = true;
  helpAiResponse.hidden = true;
  helpAiStatus.hidden = false;
  helpAiStatus.textContent = "Gathering map context...";

  try {
    // Gather context in parallel
    const [pinsRes, wikiRes, densityRes] = await Promise.all([
      fetch(`/api/pins?bbox=${bbox}&limit=50`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/wiki/near?lat=${center.lat}&lng=${center.lng}&radius_m=${Math.min(zoom * 2000, 50000)}&limit=10`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/density/analyze?hours=168`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    helpAiStatus.textContent = "Asking AI... this may take 10-20 seconds.";

    // Build rich context
    const contextParts = [];

    // Map info
    contextParts.push(`## Map Viewport`);
    contextParts.push(`- Coordinates: ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`);
    contextParts.push(`- Zoom level: ${zoom}`);
    contextParts.push(`- Bounding box: ${bbox}`);

    // Pin statistics
    const pins = pinsRes?.pins || [];
    contextParts.push(`\n## News Pins in Viewport`);
    contextParts.push(`- Total pins: ${pins.length}`);

    if (pins.length > 0) {
      // Count by category
      const categories = {};
      const sources = {};
      pins.forEach(p => {
        if (p.category) categories[p.category] = (categories[p.category] || 0) + 1;
        if (p.source_name) sources[p.source_name] = (sources[p.source_name] || 0) + 1;
      });

      const topCats = Object.entries(categories).sort((a,b) => b[1]-a[1]).slice(0, 5);
      if (topCats.length) {
        contextParts.push(`- Categories: ${topCats.map(([k,v]) => `${k}(${v})`).join(', ')}`);
      }

      const topSources = Object.entries(sources).sort((a,b) => b[1]-a[1]).slice(0, 5);
      if (topSources.length) {
        contextParts.push(`- Top sources: ${topSources.map(([k,v]) => `${k}(${v})`).join(', ')}`);
      }

      // Sample article titles
      const sampleTitles = pins.slice(0, 8).map(p => `  - "${p.title}"`).join('\n');
      contextParts.push(`\n### Sample Article Titles:\n${sampleTitles}`);
    }

    // Density issues
    if (densityRes?.clusters) {
      const viewportClusters = densityRes.clusters.filter(cl =>
        cl.lat >= bounds.getSouth() && cl.lat <= bounds.getNorth() &&
        cl.lng >= bounds.getWest() && cl.lng <= bounds.getEast()
      );
      const suspicious = viewportClusters.filter(c => c.suspicious);
      if (suspicious.length > 0) {
        contextParts.push(`\n## Density Issues`);
        suspicious.slice(0, 5).forEach(cl => {
          contextParts.push(`- ${cl.city}: ${cl.pin_count} pins (max ${cl.max_allowed}) — ${cl.reasons.join(', ')}`);
        });
      }
    }

    // Wikipedia context
    const wikiArticles = wikiRes?.results || [];
    if (wikiArticles.length > 0) {
      contextParts.push(`\n## Wikipedia Articles in Area`);
      wikiArticles.slice(0, 8).forEach(a => {
        contextParts.push(`- ${a.title}: ${(a.extract || '').slice(0, 150)}`);
      });
    }

    // Visible markers count
    let visibleCount = 0;
    const visibleCountries = new Set();
    pinMarkers.forEach(m => {
      if (bounds.contains(m.getLatLng())) {
        visibleCount++;
        if (m._pinData?.source_country) visibleCountries.add(m._pinData.source_country);
      }
    });
    if (visibleCountries.size > 0) {
      contextParts.push(`\n## Geographic Coverage`);
      contextParts.push(`- Countries represented: ${[...visibleCountries].join(', ')}`);
    }

    const fullContext = contextParts.join('\n');
    const fullMessage = `You are a news map analyst. Analyze this area and answer the user's question.

${fullContext}

## User Question:
${question}

Provide specific, actionable advice. Reference the data above.`;

    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: fullMessage, stream: false }),
    });

    if (!res.ok) throw new Error(`AI returned ${res.status}`);

    const data = await res.json();
    helpAiResponse.hidden = false;
    helpAiResponse.innerHTML = `
      <div style="font-size:12px;line-height:1.6;">
        <div style="color:var(--accent);font-weight:600;margin-bottom:4px;">AI Analysis:</div>
        <div style="white-space:pre-wrap;">${escapeHtml(data.response || data.message || 'No response')}</div>
      </div>
    `;
    helpAiStatus.hidden = true;

  } catch (e) {
    helpAiStatus.textContent = `Error: ${e.message}`;
    helpAiStatus.className = "explore-request-status error";
  } finally {
    helpAiBtn.disabled = false;
  }
});

// Wire up Bug Report submission from Help Panel
function getDiagnosticsData() {
  const mapCenter = (typeof map !== "undefined" && map) ? map.getCenter() : null;
  const mapBounds = (typeof map !== "undefined" && map) ? map.getBounds() : null;
  const mapZoom   = (typeof map !== "undefined" && map) ? map.getZoom() : null;
  const searchQ   = (typeof searchInput !== "undefined" && searchInput) ? searchInput.value.trim() : "";
  const pinsCount = (typeof pinMarkers !== "undefined" && pinMarkers) ? pinMarkers.size : 0;
  const eventsCount = (typeof eventMarkers !== "undefined" && eventMarkers) ? eventMarkers.size : 0;

  let webglSupported = false;
  try {
    const canvas = document.createElement("canvas");
    webglSupported = !!(window.WebGLRenderingContext && (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")));
  } catch (_) {}

  return {
    browser: {
      userAgent: navigator.userAgent,
      platform: navigator.platform || "Unknown",
      language: navigator.language || "en",
      online: navigator.onLine,
      screenResolution: `${window.screen.width}x${window.screen.height}`,
      viewportSize: `${window.innerWidth}x${window.innerHeight}`,
      devicePixelRatio: window.devicePixelRatio || 1,
      cpuCores: navigator.hardwareConcurrency || "N/A",
      deviceMemoryGB: navigator.deviceMemory || "N/A",
      webglSupported,
      cookiesEnabled: navigator.cookieEnabled,
    },
    mapState: {
      center: mapCenter ? { lat: Number(mapCenter.lat.toFixed(4)), lng: Number(mapCenter.lng.toFixed(4)) } : null,
      zoom: mapZoom,
      bounds: mapBounds ? {
        sw: { lat: Number(mapBounds.getSouthWest().lat.toFixed(4)), lng: Number(mapBounds.getSouthWest().lng.toFixed(4)) },
        ne: { lat: Number(mapBounds.getNorthEast().lat.toFixed(4)), lng: Number(mapBounds.getNorthEast().lng.toFixed(4)) }
      } : null,
      hash: window.location.hash || "(none)",
      renderMode: typeof renderMode !== "undefined" ? renderMode : "clusters",
      timeFilter: typeof timeFilter !== "undefined" ? timeFilter : "all",
      activeCategoryFilters: typeof _activeCategoryFilters !== "undefined" ? [..._activeCategoryFilters] : [],
      searchActive: typeof searchActive !== "undefined" ? searchActive : false,
      searchQuery: searchQ || "(none)",
      pinsInMemory: pinsCount,
      eventsInMemory: eventsCount,
      activePopupPinId: typeof _activePopupState !== "undefined" && _activePopupState ? _activePopupState.pinId : null,
      timestamp: new Date().toISOString(),
    }
  };
}

function renderHelpDiagnostics() {
  const contentEl = document.getElementById("help-diag-content");
  if (!contentEl) return;
  const diag = getDiagnosticsData();
  const b = diag.browser;
  const m = diag.mapState;

  contentEl.innerHTML = `
    <div style="color:var(--accent);font-weight:700;margin-bottom:6px;">📊 BROWSER & SYSTEM</div>
    <div>• User Agent: <span style="color:#e2e8f0;">${escapeHtml(b.userAgent)}</span></div>
    <div>• Platform: <span style="color:#e2e8f0;">${escapeHtml(b.platform)}</span> | Lang: <span style="color:#e2e8f0;">${escapeHtml(b.language)}</span></div>
    <div>• Screen: <span style="color:#e2e8f0;">${b.screenResolution}</span> | Viewport: <span style="color:#e2e8f0;">${b.viewportSize}</span> (DPR ${b.devicePixelRatio})</div>
    <div>• Hardware: <span style="color:#e2e8f0;">${b.cpuCores} Cores</span> | Mem: <span style="color:#e2e8f0;">${b.deviceMemoryGB} GB</span> | WebGL: <span style="color:${b.webglSupported ? '#22c55e' : '#ef4444'};">${b.webglSupported ? 'Supported ✅' : 'Disabled ❌'}</span></div>
    <div style="color:var(--accent);font-weight:700;margin:8px 0 4px;">🗺️ MAP & APP STATE</div>
    <div>• Center: <span style="color:#e2e8f0;">${m.center ? `${m.center.lat}, ${m.center.lng}` : 'N/A'}</span> (Zoom ${m.zoom})</div>
    <div>• Bounds SW: <span style="color:#e2e8f0;">${m.bounds ? `${m.bounds.sw.lat}, ${m.bounds.sw.lng}` : 'N/A'}</span> NE: <span style="color:#e2e8f0;">${m.bounds ? `${m.bounds.ne.lat}, ${m.bounds.ne.lng}` : 'N/A'}</span></div>
    <div>• URL Hash: <span style="color:#e2e8f0;">${escapeHtml(m.hash)}</span></div>
    <div>• Active Filters: Category [<span style="color:#e2e8f0;">${m.activeCategoryFilters.length ? m.activeCategoryFilters.join(', ') : 'All'}</span>] | Time [<span style="color:#e2e8f0;">${m.timeFilter}</span>]</div>
    <div>• Search: <span style="color:#e2e8f0;">"${escapeHtml(m.searchQuery)}"</span> (Active: ${m.searchActive})</div>
    <div>• Loaded Markers: <span style="color:#e2e8f0;">${m.pinsInMemory} pins</span>, <span style="color:#e2e8f0;">${m.eventsInMemory} events</span> | Mode: <span style="color:#e2e8f0;">${m.renderMode}</span></div>
  `;
}

const helpToggleDiagBtn = document.getElementById("help-toggle-diag-btn");
const helpDiagContainer = document.getElementById("help-diag-container");
const helpDiagArrow = document.getElementById("help-diag-arrow");
const helpCopyDiagBtn = document.getElementById("help-copy-diag-btn");

helpToggleDiagBtn?.addEventListener("click", () => {
  if (!helpDiagContainer) return;
  const isHidden = helpDiagContainer.hidden;
  helpDiagContainer.hidden = !isHidden;
  if (helpDiagArrow) helpDiagArrow.textContent = isHidden ? "▲" : "▼";
  if (isHidden) renderHelpDiagnostics();
});

helpCopyDiagBtn?.addEventListener("click", () => {
  const diag = getDiagnosticsData();
  const jsonStr = JSON.stringify(diag, null, 2);
  navigator.clipboard.writeText(jsonStr).then(() => {
    if (helpCopyDiagBtn) {
      const origText = helpCopyDiagBtn.textContent;
      helpCopyDiagBtn.textContent = "Copied! ✓";
      helpCopyDiagBtn.style.color = "#22c55e";
      setTimeout(() => {
        helpCopyDiagBtn.textContent = origText;
        helpCopyDiagBtn.style.color = "var(--accent)";
      }, 2000);
    }
  }).catch(() => {
    alert("Copied diagnostics:\n\n" + jsonStr);
  });
});

const helpBugSubmitBtn = document.getElementById("help-bug-submit-btn");
const helpBugType = document.getElementById("help-bug-type");
const helpBugText = document.getElementById("help-bug-text");
const helpBugStatus = document.getElementById("help-bug-status");

helpBugSubmitBtn?.addEventListener("click", async () => {
  const bugType = helpBugType?.value || "other_bug";
  const text = helpBugText?.value?.trim() || "";

  if (!text) {
    if (helpBugStatus) {
      helpBugStatus.hidden = false;
      helpBugStatus.textContent = "Please describe the issue in detail before submitting.";
      helpBugStatus.className = "explore-request-status error";
    }
    return;
  }

  helpBugSubmitBtn.disabled = true;
  if (helpBugStatus) {
    helpBugStatus.hidden = false;
    helpBugStatus.textContent = "Submitting bug report & system diagnostics...";
    helpBugStatus.className = "explore-request-status";
  }

  const diagnostics = getDiagnosticsData();

  try {
    const res = await fetch("/api/feedback/bug-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bug_type: bugType,
        description: text,
        map_context: diagnostics,
        session_id: typeof XyzoAnalytics !== 'undefined' ? XyzoAnalytics.sessionId : null,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (helpBugStatus) {
      helpBugStatus.innerHTML = `<span style="color:var(--success);">✓ Thank you! Your bug report and full diagnostics have been submitted.</span>`;
    }
    helpBugText.value = "";
    setTimeout(() => {
      if (helpBugStatus) helpBugStatus.hidden = true;
    }, 4000);
  } catch (e) {
    if (helpBugStatus) {
      helpBugStatus.textContent = `Submission error: ${e.message}`;
      helpBugStatus.className = "explore-request-status error";
    }
  } finally {
    helpBugSubmitBtn.disabled = false;
  }
});

// ── Source Suggestion Handler ──────────────────────────────────────
const helpSourceSubmitBtn = document.getElementById("help-source-submit-btn");
const helpSourceUrl = document.getElementById("help-source-url");
const helpSourceName = document.getElementById("help-source-name");
const helpSourceCountry = document.getElementById("help-source-country");
const helpSourceDesc = document.getElementById("help-source-desc");
const helpSourceStatus = document.getElementById("help-source-status");

helpSourceSubmitBtn?.addEventListener("click", async () => {
  const sourceUrl = helpSourceUrl?.value?.trim() || "";
  const sourceName = helpSourceName?.value?.trim() || "";
  const countryCode = helpSourceCountry?.value?.trim()?.toUpperCase() || "";
  const description = helpSourceDesc?.value?.trim() || "";

  if (!sourceUrl) {
    if (helpSourceStatus) {
      helpSourceStatus.hidden = false;
      helpSourceStatus.textContent = "Please enter a source URL.";
      helpSourceStatus.className = "explore-request-status error";
    }
    return;
  }

  try {
    new URL(sourceUrl);
  } catch {
    if (helpSourceStatus) {
      helpSourceStatus.hidden = false;
      helpSourceStatus.textContent = "Please enter a valid URL.";
      helpSourceStatus.className = "explore-request-status error";
    }
    return;
  }

  helpSourceSubmitBtn.disabled = true;
  if (helpSourceStatus) {
    helpSourceStatus.hidden = false;
    helpSourceStatus.textContent = "Submitting...";
    helpSourceStatus.className = "explore-request-status";
  }

  try {
    const res = await fetch("/api/feedback/source-suggestion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_url: sourceUrl,
        source_name: sourceName || undefined,
        country_code: countryCode || undefined,
        description: description || undefined,
        session_id: typeof XyzoAnalytics !== 'undefined' ? XyzoAnalytics.sessionId : null,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (helpSourceStatus) {
      helpSourceStatus.innerHTML = `<span style="color:var(--success);">✓ Thank you! We'll review this source.</span>`;
    }
    helpSourceUrl.value = "";
    helpSourceName.value = "";
    helpSourceCountry.value = "";
    helpSourceDesc.value = "";
    setTimeout(() => {
      if (helpSourceStatus) helpSourceStatus.hidden = true;
    }, 4000);
  } catch (e) {
    if (helpSourceStatus) {
      helpSourceStatus.textContent = `Submission error: ${e.message}`;
      helpSourceStatus.className = "explore-request-status error";
    }
  } finally {
    helpSourceSubmitBtn.disabled = false;
  }
});

// ── General Feedback Handler ───────────────────────────────────────
const helpFeedbackSubmitBtn = document.getElementById("help-feedback-submit-btn");
const helpFeedbackText = document.getElementById("help-feedback-text");
const helpFeedbackStatus = document.getElementById("help-feedback-status");

helpFeedbackSubmitBtn?.addEventListener("click", async () => {
  const feedback = helpFeedbackText?.value?.trim() || "";

  if (!feedback) {
    if (helpFeedbackStatus) {
      helpFeedbackStatus.hidden = false;
      helpFeedbackStatus.textContent = "Please enter your feedback before submitting.";
      helpFeedbackStatus.className = "explore-request-status error";
    }
    return;
  }

  helpFeedbackSubmitBtn.disabled = true;
  if (helpFeedbackStatus) {
    helpFeedbackStatus.hidden = false;
    helpFeedbackStatus.textContent = "Submitting...";
    helpFeedbackStatus.className = "explore-request-status";
  }

  try {
    const res = await fetch("/api/feedback/general-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feedback,
        session_id: typeof XyzoAnalytics !== 'undefined' ? XyzoAnalytics.sessionId : null,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (helpFeedbackStatus) {
      helpFeedbackStatus.innerHTML = `<span style="color:var(--success);">✓ Thank you for your feedback!</span>`;
    }
    helpFeedbackText.value = "";
    setTimeout(() => {
      if (helpFeedbackStatus) helpFeedbackStatus.hidden = true;
    }, 4000);
  } catch (e) {
    if (helpFeedbackStatus) {
      helpFeedbackStatus.textContent = `Submission error: ${e.message}`;
      helpFeedbackStatus.className = "explore-request-status error";
    }
  } finally {
    helpFeedbackSubmitBtn.disabled = false;
  }
});

// ── Complaint Handler ─────────────────────────────────────────────────
// When someone clicks "File Complaint" in the help panel, we log it
// and check if we've hit the 10% threshold. If so, the site shuts down.
// This is the community's emergency brake.
const complaintSubmitBtn = document.getElementById("help-complaint-submit-btn");
const complaintText = document.getElementById("help-complaint-text");
const complaintStatus = document.getElementById("help-complaint-status");

complaintSubmitBtn?.addEventListener("click", async () => {
  const complaint = complaintText?.value?.trim() || "";

  if (!complaint || complaint.length < 5) {
    if (complaintStatus) {
      complaintStatus.hidden = false;
      complaintStatus.textContent = "Please describe the issue in at least 5 characters.";
      complaintStatus.className = "explore-request-status error";
    }
    return;
  }

  // Confirm before filing — this is a serious action
  if (!confirm("File a serious complaint? If complaints exceed 10% of active users, the site will temporarily go offline for review.")) {
    return;
  }

  complaintSubmitBtn.disabled = true;
  if (complaintStatus) {
    complaintStatus.hidden = false;
    complaintStatus.textContent = "Submitting complaint...";
    complaintStatus.className = "explore-request-status";
  }

  try {
    const res = await fetch("/api/shutdown/complaint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        complaint,
        session_id: typeof XyzoAnalytics !== 'undefined' ? XyzoAnalytics.sessionId : null,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.shutdown) {
      // Site just shut down!
      if (complaintStatus) {
        complaintStatus.innerHTML = `<span style="color:#ff6b6b;">⚠️ The site has been temporarily shut down due to community feedback. An admin will review soon.</span>`;
      }
      // Show shutdown banner
      showShutdownBanner(data.stats || {});
    } else {
      if (complaintStatus) {
        const stats = data.stats || {};
        complaintStatus.innerHTML = `<span style="color:var(--success);">✓ Complaint filed. Thank you for reporting.</span>
          <br><span style="font-size:11px;color:#888;">
          ${stats.complaints_24h || 0} complaints in 24h
          ${stats.active_users ? ` · ${stats.active_users} active users` : ""}
          ${stats.threshold_pct ? ` · ${stats.threshold_pct}% threshold` : ""}
          </span>`;
      }
      complaintText.value = "";
    }

    setTimeout(() => {
      if (complaintStatus) complaintStatus.hidden = true;
    }, 8000);
  } catch (e) {
    if (complaintStatus) {
      complaintStatus.textContent = `Submission error: ${e.message}`;
      complaintStatus.className = "explore-request-status error";
    }
  } finally {
    complaintSubmitBtn.disabled = false;
  }
});


function renderYourNewsTab() {
  if (!liveState.feed) return;
  const prefs = UserTracker.get();
  const topCats = UserTracker.getTopCategories();
  const searches = prefs.searches || [];
  const items = [...(liveState.feed.hot || []), ...(liveState.feed.near || [])];

  // Get current viewport for location-based scoring
  let viewCenter = null;
  try { viewCenter = map.getCenter(); } catch (_) {}
  const viewLat = viewCenter?.lat || 0;
  const viewLng = viewCenter?.lng || 0;

  const scored = [];
  const seen = new Set();
  const catCounts = {}; // Track category diversity

  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);

    let score = 0;
    const cat = (it.event_type || it.category || "").toLowerCase();
    const headline = (it.headline || it.title || "").toLowerCase();
    const summary = (it.summary || "").toLowerCase();

    // 1. Category match (strongest signal)
    if (topCats.length > 0) {
      const idx = topCats.indexOf(cat);
      if (idx !== -1) {
        score += (topCats.length - idx) * 8;
      }
    }

    // 2. Search term match (very strong)
    for (const s of searches) {
      if (headline.includes(s) || summary.includes(s)) {
        score += 12;
      }
    }

    // 3. Recency boost (newer = better)
    const ageMs = Date.now() - new Date(it.first_reported_at || Date.now()).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours < 1) score += 15;       // Less than 1 hour old
    else if (ageHours < 6) score += 10;  // Less than 6 hours
    else if (ageHours < 24) score += 5;  // Less than 1 day
    // Older stories get no recency bonus

    // 4. Proximity boost (stories near your viewport)
    if (it.location?.lat && it.location?.lng && viewCenter) {
      const dLat = (it.location.lat - viewLat) * Math.PI / 180;
      const dLng = (it.location.lng - viewLng) * Math.PI / 180;
      const dist = 6371 * 2 * Math.asin(Math.sqrt(
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(viewLat * Math.PI / 180) * Math.cos(it.location.lat * Math.PI / 180) *
        Math.sin(dLng/2) * Math.sin(dLng/2)
      ));
      if (dist < 100) score += 8;       // Within 100km
      else if (dist < 500) score += 4;  // Within 500km
      else if (dist < 2000) score += 2; // Within 2000km
    }

    // 5. Source diversity (multi-source stories are more reliable)
    score += Math.min((it.source_count || 1) * 2, 10);

    // 6. Diversity penalty (don't flood with one category)
    catCounts[cat] = (catCounts[cat] || 0) + 1;
    if (catCounts[cat] > 3) {
      score -= (catCounts[cat] - 3) * 2; // Penalize after 3 of same category
    }

    scored.push({ item: it, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const finalItems = scored.slice(0, 25).map(s => s.item);

  if (!finalItems.length) {
    const emptyMessages = [
      "No personalized recommendations yet. Search for topics or click map pins to build your interests!",
      "Nothing matches your interests yet. Try searching for something you care about!",
      "Your news feed is empty. Explore the map and click some pins to get started!",
    ];
    livePanelList.innerHTML = `<div class="live-empty">${emptyMessages[Math.floor(Math.random() * emptyMessages.length)]}</div>`;
    return;
  }

  // Dynamic header based on what we found
  const topCatsNames = topCats.slice(0, 2).map(c => beautifyCategory(c, "")).join(" & ");
  const recentCount = finalItems.filter(it => {
    const age = Date.now() - new Date(it.first_reported_at || Date.now()).getTime();
    return age < 6 * 60 * 60 * 1000; // Less than 6 hours
  }).length;

  let badgeText;
  if (topCats.length > 0) {
    badgeText = `⭐ ${topCatsNames} — ${recentCount} fresh stories`;
  } else if (searches.length > 0) {
    badgeText = `🔍 Matching "${searches[0]}" — ${finalItems.length} results`;
  } else {
    badgeText = `🌍 Based on your activity — ${finalItems.length} stories`;
  }

  const now = Date.now();
  const headerHtml = `
    <div style="padding: 8px 12px; background: rgba(94, 234, 212, 0.12); border-radius: 6px; margin: 6px 8px 10px 8px; font-size: 11px; color: var(--accent); border: 1px solid rgba(94, 234, 212, 0.25); font-weight: 500; display: flex; justify-content: space-between; align-items: center;">
      <span>${escapeHtml(badgeText)}</span>
      <button onclick="fetchLiveFeed(true).then(() => renderYourNewsTab())" style="background:none;border:1px solid rgba(94,234,212,0.3);color:var(--accent);padding:2px 8px;border-radius:4px;font-size:10px;cursor:pointer;font-family:inherit;">↻ Refresh</button>
    </div>`;
  const itemsHtml = finalItems.map(it => renderLiveItem(it, now)).join("");
  livePanelList.innerHTML = headerHtml + itemsHtml;

  for (const node of livePanelList.querySelectorAll(".live-item")) {
    node.addEventListener("click", async (e) => {
      if (e && e.target && e.target.closest('a')) return;
      const lat = Number(node.dataset.lat);
      const lng = Number(node.dataset.lng);
      const id = Number(node.dataset.id);
      const itemType = node.dataset.type || "event";
      openExploreEvent(id, lat, lng);
      // Toggle sources panel — same logic as Hot/Near tabs
      const sourcesEl = document.getElementById(`live-sources-${id}`);
      if (!sourcesEl) return;
      if (!sourcesEl.hidden) {
        sourcesEl.hidden = true;
        sourcesEl.innerHTML = "";
        return;
      }
      sourcesEl.hidden = false;
      sourcesEl.innerHTML = `<div class="live-sources-loading">Loading sources…</div>`;
      if (itemType === "article") {
        const url = node.dataset.url;
        const srcName = node.dataset.sourceName;
        if (url) {
          sourcesEl.innerHTML = `<div class="live-source">
            <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(node.querySelector(".live-item-headline")?.textContent || "source")}</a>
            ${srcName ? `<span class="live-source-name">${escapeHtml(srcName)}</span>` : ""}
          </div>`;
        } else {
          sourcesEl.innerHTML = `<div class="live-sources-empty">No sources</div>`;
        }
        return;
      }
      try {
        const res = await fetch(`/api/events/${id}`);
        if (!res.ok) { sourcesEl.innerHTML = `<div class="live-sources-error">Failed to load</div>`; return; }
        const detail = await res.json();
        const list = (detail.sources || []).map((s) => {
          const method = s.auto_categorize_method;
          let autoBadge = "";
          if (method === "source_fallback") {
            autoBadge = ' <span class="auto-tag source-fallback" title="Source-based location">📍</span>';
          } else if (method === "fast_path") {
            autoBadge = ' <span class="auto-tag fast-path" title="Auto-detected">🏷️</span>';
          }
          return `
          <div class="live-source">
            <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title || s.source_name || "source")}</a>
            <span class="live-source-name">${escapeHtml(s.source_name || "")}${autoBadge}</span>
          </div>`;
        }).join("");
        sourcesEl.innerHTML = list || `<div class="live-sources-empty">No sources</div>`;
      } catch (e) {
        sourcesEl.innerHTML = `<div class="live-sources-error">Error loading</div>`;
      }
    });
  }
}

// FIX_NOTES 3.4: duplicate renderLinks moveend handler removed — the
// throttled moveend+zoomend pair (~:9241) already covers it.

map.on("moveend", throttle(() => {
  if (liveState.activeTab === "local") {
    renderLocalTab();
  }
}, 500));

// ── Cache Debugger Init ──────────────────────────────────────────
if (typeof CacheDebugger !== 'undefined') {
  CacheDebugger.init();
  if (window.XYZO_DEBUG) CacheDebugger.createPanel();
  XLog.log("🧹 CacheDebugger ready (Ctrl+Shift+D to toggle)");
}
