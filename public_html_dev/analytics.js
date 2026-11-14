/**
 * Xyzo Analytics & Performance Module
 *
 * This module handles:
 * 1. Session management and user identification
 * 2. Interaction tracking (pin clicks, map moves, searches)
 * 3. IP-based geolocation detection
 * 4. Home location management
 * 5. Performance monitoring
 *
 * Loaded separately from app.js for better caching.
 */

(function() {
  'use strict';

  // ── Session Management ────────────────────────────────────────────────
  const SESSION_KEY = 'xyzo.session';
  const HOME_KEY = 'xyzo.home';

  function getSessionId() {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      // Quick wins: crypto.randomUUID is collision-free; Math.random isn't.
      id = 'sess_' + crypto.randomUUID();
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  }

  const sessionId = getSessionId();

  // ── Event Queue ───────────────────────────────────────────────────────
  // Batch events to reduce API calls
  const eventQueue = [];
  let flushTimer = null;
  const FLUSH_INTERVAL = 5000; // 5 seconds
  const MAX_QUEUE_SIZE = 20;

  function queueEvent(type, data = {}) {
    eventQueue.push({
      type,
      ...data,
      timestamp: Date.now()
    });

    // Flush if queue is full
    if (eventQueue.length >= MAX_QUEUE_SIZE) {
      flushEvents();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flushEvents, FLUSH_INTERVAL);
    }
  }

  async function flushEvents(keepalive) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (eventQueue.length === 0) return;

    // Drain in chunks of ≤50 (server cap) so a long offline stretch or a
    // burst of clicks can't strand events past the first splice.
    while (eventQueue.length > 0) {
      const events = eventQueue.splice(0, 50);
      try {
        // Tier 1.2: one UUID per batch chunk. The backend appends each
        // event's index to derive per-event keys, so a retry of this
        // exact chunk (network blip on unload, keepalive replay) maps
        // every event to its previous key → all collide → zero double-
        // counting in interactions_24h + source rankings.
        const idemKey = (crypto && crypto.randomUUID)
          ? `abatch:${crypto.randomUUID()}`
          : null;
        await fetch('/api/analytics/batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(idemKey ? { 'X-Idempotency-Key': idemKey } : {}),
          },
          keepalive: !!keepalive, // survive the tab actually closing
          body: JSON.stringify({
            session_id: sessionId,
            events: events.map(e => ({
              type: e.type,
              pin_id: e.pin_id || undefined,
              article_id: e.article_id || undefined,
              source_id: e.source_id || undefined,
              event_id: e.event_id || undefined,
              map_lat: e.map_lat || undefined,
              map_lng: e.map_lng || undefined,
              map_zoom: e.map_zoom || undefined,
              bbox: e.bbox || undefined,
              metadata: e.metadata || undefined,
              timestamp: e.timestamp || undefined,
            })),
            // The timestamp each event actually happened, not flush time.
            sent_at: Date.now(),
          })
        });
      } catch (err) {
        // Silently fail - don't break the user experience
        XLog.debug('[analytics] batch failed:', err);
        break;
      }
    }
  }

  // Flush on page unload — keepalive lets the POST outlive the tab.
  window.addEventListener('beforeunload', () => flushEvents(true));
  window.addEventListener('pagehide', () => flushEvents(true));
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushEvents(true);
  });

  // ── Map State Tracking ────────────────────────────────────────────────
  let lastMapLat = null;
  let lastMapLng = null;
  let lastMapZoom = null;
  let lastBbox = null;

  function getMapState() {
    if (typeof map === 'undefined' || !map) return null;
    const center = map.getCenter();
    const bounds = map.getBounds();
    return {
      lat: center.lat,
      lng: center.lng,
      zoom: Math.round(map.getZoom()),
      bbox: [
        bounds.getWest().toFixed(4),
        bounds.getSouth().toFixed(4),
        bounds.getEast().toFixed(4),
        bounds.getNorth().toFixed(4)
      ].join(',')
    };
  }

  // Track map movements (throttled)
  let mapMoveTimer = null;
  let lastViewStart = Date.now(); // timestamp of when user started viewing current area
  function onMapMove() {
    if (mapMoveTimer) return;
    mapMoveTimer = setTimeout(() => {
      mapMoveTimer = null;
      const state = getMapState();
      if (!state) return;

      // Only log if significantly different from last position
      const latDiff = Math.abs(state.lat - (lastMapLat || 0));
      const lngDiff = Math.abs(state.lng - (lastMapLng || 0));
      const zoomDiff = Math.abs(state.zoom - (lastMapZoom || 0));

      if (latDiff > 0.5 || lngDiff > 0.5 || zoomDiff > 1) {
        const prevLat = lastMapLat;
        const prevLng = lastMapLng;
        const prevZoom = lastMapZoom;
        lastMapLat = state.lat;
        lastMapLng = state.lng;
        lastMapZoom = state.zoom;
        lastBbox = state.bbox;

        queueEvent('map_move', {
          map_lat: state.lat,
          map_lng: state.lng,
          map_zoom: state.zoom,
          bbox: state.bbox
        });

        // Flush previous view's duration before switching
        if (prevLat !== null) {
          flushLocationView(prevLat, prevLng, prevZoom, lastBbox, Date.now() - lastViewStart);
        }
        lastViewStart = Date.now();
      }
    }, 2000); // Throttle to 2 seconds
  }

  // Flush a single location view to /api/location-views
  // This captures zoom depth — zoom >= 10 means "show me news about THIS city"
  function flushLocationView(lat, lng, zoom, bbox, durationMs) {
    if (lat === null || lng === null || zoom === null) return;
    const key = `lv:${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    if (navigator.sendBeacon) {
      // Use sendBeacon for reliability (survives page unload)
      const payload = JSON.stringify({
        views: [{
          view_type: 'map_view',
          center_lat: lat,
          center_lng: lng,
          zoom_level: zoom,
          bbox: bbox,
          duration_ms: Math.max(0, durationMs || 0),
        }]
      });
      // sendBeacon is fire-and-forget but we can upgrade to fetch keepalive
      fetch('/api/location-views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': key },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    } else {
      fetch('/api/location-views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': key },
        body: JSON.stringify({
          views: [{
            view_type: 'map_view',
            center_lat: lat,
            center_lng: lng,
            zoom_level: zoom,
            bbox: bbox,
            duration_ms: Math.max(0, durationMs || 0),
          }]
        }),
      }).catch(() => {});
    }
  }

  // Flush on page unload — record final view duration
  window.addEventListener('beforeunload', () => {
    if (lastMapLat !== null) {
      flushLocationView(lastMapLat, lastMapLng, lastMapZoom, lastBbox, Date.now() - lastViewStart);
    }
  });
  window.addEventListener('pagehide', () => {
    if (lastMapLat !== null) {
      flushLocationView(lastMapLat, lastMapLng, lastMapZoom, lastBbox, Date.now() - lastViewStart);
    }
  });

  // ── Pin Interaction Tracking ──────────────────────────────────────────
  function trackPinClick(pin) {
    const state = getMapState();
    queueEvent('pin_click', {
      pin_id: pin.id,
      article_id: pin.article_id,
      source_id: pin.source_id,
      map_lat: state?.lat,
      map_lng: state?.lng,
      map_zoom: state?.zoom,
      metadata: {
        title: pin.title?.substring(0, 100),
        category: pin.category,
        source_type: pin.source_type
      }
    });
  }

  function trackPinView(pin) {
    const state = getMapState();
    queueEvent('pin_view', {
      pin_id: pin.id,
      article_id: pin.article_id,
      source_id: pin.source_id,
      map_lat: state?.lat,
      map_lng: state?.lng,
      map_zoom: state?.zoom,
      metadata: {
        title: pin.title?.substring(0, 100),
        category: pin.category,
        source_type: pin.source_type
      }
    });
  }

  function trackSourceClick(pin, url) {
    queueEvent('source_click', {
      pin_id: pin.id,
      source_id: pin.source_id,
      metadata: { url }
    });
  }

  // ── Search Tracking ───────────────────────────────────────────────────
  function trackSearch(query, resultCount) {
    const state = getMapState();
    queueEvent('search', {
      map_lat: state?.lat,
      map_lng: state?.lng,
      map_zoom: state?.zoom,
      metadata: { query, result_count: resultCount }
    });

    // Also write to news_search_log so the learn loop's gap/coverage
    // detection can use this signal. Best-effort, fire-and-forget.
    if (typeof fetch !== 'undefined') {
      fetch('/api/search/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          query,
          result_count: resultCount,
        }),
        keepalive: true,
      }).catch(() => { /* ignore */ });
    }
  }

  // ── IP Geolocation ────────────────────────────────────────────────────
  let detectedLocation = null;

  async function detectLocation() {
    // First check if we have a stored detected location
    const stored = localStorage.getItem('xyzo.detected');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        // Use if less than 24 hours old
        if (Date.now() - parsed.timestamp < 86400000) {
          detectedLocation = parsed;
          return parsed;
        }
      } catch (e) {}
    }

    try {
      // Use the API's GeoIP endpoint. Response shape is
      // { location: { city, country, lat, lng, source }, ip } — an
      // earlier version read top-level data.lat and never matched, so
      // detection silently never fired.
      const resp = await fetch('/api/geoip');
      if (resp.ok) {
        const data = await resp.json();
        const loc = data && data.location;
        if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
          detectedLocation = {
            lat: loc.lat,
            lng: loc.lng,
            city: loc.city,
            country: loc.country,
            source: loc.source,
            timestamp: Date.now()
          };
          localStorage.setItem('xyzo.detected', JSON.stringify(detectedLocation));

          // Update server-side record — detected mode only touches
          // detected_* columns, never a home the user explicitly set.
          try {
            // Tier 1.2: one UUID per detected-update. Retries (network
            // blip on geoip + keepalive) won't double-log the set_home
            // interaction in interactions_24h.
            const idemKey = (crypto && crypto.randomUUID)
              ? `ish:${crypto.randomUUID()}`
              : null;
            await fetch('/api/analytics/set-home', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(idemKey ? { 'X-Idempotency-Key': idemKey } : {}),
              },
              body: JSON.stringify({
                session_id: sessionId,
                lat: loc.lat,
                lng: loc.lng,
                city: loc.city,
                country: loc.country,
                source: 'detected',
              }),
              keepalive: true,
            });
          } catch (e) { /* best-effort */ }
          // ... and mirror it into the interaction stream
          queueEvent('set_home', {
            map_lat: loc.lat,
            map_lng: loc.lng,
            metadata: { source: 'ip:' + (loc.source || 'geoip'), city: loc.city, country: loc.country }
          });

          return detectedLocation;
        }
      }
    } catch (err) {
        XLog.debug('[analytics] geoip failed:', err);
    }

    return null;
  }

  // ── Home Location ─────────────────────────────────────────────────────
  function getHomeLocation() {
    const stored = localStorage.getItem(HOME_KEY);
    if (stored) {
      try { return JSON.parse(stored); } catch (e) {}
    }
    return null;
  }

  async function setHomeLocation(lat, lng, city, country, mode) {
    // mode: 'home' (explicit user choice — default) or 'detected'
    // (passive IP guess; server keeps it out of home_* columns).
    const home = { lat, lng, city, country, timestamp: Date.now() };
    localStorage.setItem(HOME_KEY, JSON.stringify(home));

    // Update server
    try {
      // Tier 1.2: one UUID per explicit home-set. Prevents retries
      // (e.g. rapid clicks on the home button) from logging the
      // set_home interaction multiple times.
      const idemKey = (crypto && crypto.randomUUID)
        ? `ish:${crypto.randomUUID()}`
        : null;
      await fetch('/api/analytics/set-home', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idemKey ? { 'X-Idempotency-Key': idemKey } : {}),
        },
        body: JSON.stringify({
          session_id: sessionId,
          lat, lng, city, country,
          source: mode === 'detected' ? 'detected' : undefined
        })
      });
    } catch (err) {
        XLog.debug('[analytics] set-home failed:', err);
    }

    return home;
  }

  async function updateUserLocation(location, source) {
    // Store in user_locations table via interaction log
    queueEvent('set_home', {
      map_lat: location.lat,
      map_lng: location.lng,
      metadata: { source, city: location.city, country: location.country }
    });
  }

  // ── Generic UI Click Tracking ────────────────────────────────────────
  // One delegated listener puts a `ui_click` event behind essentially
  // every button/link/tab/checkbox on the site — no per-control wiring
  // needed, and anything added later is captured automatically. The
  // Overview dashboard's "all the details" stream is built on this.
  //
  // Everything inside the Leaflet map is deliberately EXCLUDED: marker
  // taps, popup links, and background drag-clicks are already covered
  // by the dedicated pin_click / pin_view / source_click / map_move
  // events with far richer payloads. Tracking them generically too
  // would double-count every interaction.
  //
  // Labels must be STABLE for aggregation: canonical `data-time` /
  // `data-mode` / `data-tab` identifiers win over visible text, because
  // live labels mutate ("7364 pins total in 24h" → "7365 pins total…").
  function classifyClick(el) {
    if (el.dataset && el.dataset.track) return el.dataset.track;
    if (el.dataset && el.dataset.time) return 'time:' + el.dataset.time;
    if (el.dataset && el.dataset.mode) return 'mode:' + el.dataset.mode;
    if (el.dataset && el.dataset.tab) return 'tab:' + el.dataset.tab;
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (txt && txt.length <= 40) return txt;
    let label = el.getAttribute('aria-label') || el.getAttribute('title') || el.id;
    if (!label && el.getAttribute('href')) label = 'link:' + el.getAttribute('href').slice(0, 60);
    return (label || txt || '').slice(0, 80);
  }

  function trackUiClick(label, section, extra) {
    queueEvent('ui_click', {
      metadata: Object.assign({ label: label, section: section || undefined }, extra || {}),
    });
  }

  document.addEventListener('click', function (e) {
    try {
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest('.leaflet-container')) return;   // map = dedicated events
      const el = t.closest('button, a, select, summary, [role="tab"], [role="button"], input[type="checkbox"], input[type="radio"]');
      if (!el) return;
      // Find the nearest meaningful container id for context (mode-toggle,
      // time-filter, live-panel, tabs, …). Skip auto-generated junk ids.
      let section = '';
      const host = el.closest('[id]');
      if (host && /^[a-zA-Z][\w-]{0,40}$/.test(host.id)) {
        section = host.id;
      }
      const meta = {
        label: classifyClick(el),
        section: section || undefined,
        kind: el.tagName.toLowerCase(),
      };
      const pressed = el.getAttribute && el.getAttribute('aria-pressed');
      if (pressed !== null && pressed !== undefined) meta.pressed = pressed;
      const expanded = el.getAttribute && el.getAttribute('aria-expanded');
      if (expanded !== null && expanded !== undefined) meta.expanded = expanded;
      if (el.type === 'checkbox' || el.type === 'radio') meta.checked = !!el.checked;
      if (el.tagName === 'A' && el.href) {
        try { meta.href = new URL(el.href).pathname; } catch (_) {}
        if (el.target === '_blank') meta.external = true;
      }
      // Search commits carry a query; mirror it into metadata so the
      // Overview activity rows are self-describing.
      if (el.dataset && el.dataset.time) meta.time = el.dataset.time;
      queueEvent('ui_click', { metadata: meta });
    } catch (_) {
      // Click tracking must never break the click itself.
    }
  }, true);

  // ── Performance Monitoring ────────────────────────────────────────────
  const perfMetrics = {
    loadStart: Date.now(),
    domReady: null,
    mapReady: null,
    firstPin: null,
  };

  function markDomReady() {
    perfMetrics.domReady = Date.now();
  }

  function markMapReady() {
    perfMetrics.mapReady = Date.now();
    reportPerformance();
  }

  function markFirstPin() {
    if (!perfMetrics.firstPin) {
      perfMetrics.firstPin = Date.now();
      reportPerformance();
    }
  }

  let perfReported = false;
  function reportPerformance() {
    if (perfReported) return;
    if (!(perfMetrics.mapReady && perfMetrics.firstPin)) return;
    perfReported = true;
    const metrics = {
      dom_ready_ms: perfMetrics.domReady ? perfMetrics.domReady - perfMetrics.loadStart : null,
      map_ready_ms: perfMetrics.mapReady - perfMetrics.loadStart,
      first_pin_ms: perfMetrics.firstPin - perfMetrics.loadStart,
      path: window.location.pathname,
    };

    XLog.debug('[perf]', metrics);
    queueEvent('performance', { metadata: metrics });
  }

  // Navigation-timing fallback so pages without a map (help, requests,
  // quality…) still emit a performance row — 1.5 s after window load,
  // unless the map path already reported first.
  window.addEventListener('load', () => setTimeout(() => {
    if (perfReported) return;
    perfReported = true;
    let nav = null;
    try { nav = performance.getEntriesByType('navigation')[0] || null; } catch (_) {}
    queueEvent('performance', { metadata: {
      path: window.location.pathname,
      dom_ready_ms: perfMetrics.domReady ? perfMetrics.domReady - perfMetrics.loadStart : null,
      dcl_ms: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      load_ms: nav ? Math.round(nav.loadEventEnd) : null,
      ttfb_ms: nav ? Math.round(nav.responseStart - nav.requestStart) : null,
    } });
  }, 1500));

  // ── Public API ────────────────────────────────────────────────────────
  window.XyzoAnalytics = {
    sessionId,
    queueEvent,
    flushEvents,
    trackPinClick,
    trackPinView,
    trackSourceClick,
    trackSearch,
    trackUiClick,
    detectLocation,
    getHomeLocation,
    setHomeLocation,
    getMapState,
    onMapMove,
    flushLocationView,
    markDomReady,
    markMapReady,
    markFirstPin,
    getDetectedLocation: () => detectedLocation,
    // Test hook: how many events are sitting in the queue unwritten.
    pendingCount: () => eventQueue.length,
  };

  // Auto-detect location on load
  detectLocation();

  // Track page view
  queueEvent('page_view', {
    metadata: {
      path: window.location.pathname,
      referrer: document.referrer,
      viewport: `${window.innerWidth}x${window.innerHeight}`
    }
  });

  XLog.debug('[analytics] initialized, session:', sessionId);

})();
