/* ═══════════════════════════════════════════════════════════════════════
   "Today" panel — the daily digest on the map.

   The digest is the editorial layer behind the daily news video: a curated
   set of the day's most INTERESTING stories (not simply the loudest ones),
   built by worker/daily_digest.py and served by GET /api/digest/today.

   The same artifact the video is rendered from, so what a reader sees and
   what the video says can never drift apart.

   Clicking a story flies the map to where it happened.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const API = "/api/digest/today";
  const state = {
    open: false,
    loaded: false,
    loading: false,
    digest: null,
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function panel() {
    return document.getElementById("digest-panel");
  }

  function setOpen(open) {
    state.open = open;
    const el = panel();
    if (!el) return;
    el.hidden = !open;
    const btn = document.getElementById("ctrl-digest-btn");
    if (btn) {
      btn.classList.toggle("active", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (open) load();
  }

  function render() {
    const body = document.getElementById("digest-body");
    const meta = document.getElementById("digest-meta");
    if (!body) return;
    const d = state.digest;
    if (!d) {
      body.innerHTML = '<div class="digest-loading">Loading…</div>';
      return;
    }
    if (!d.available || !d.stories || !d.stories.length) {
      meta.textContent = "";
      body.innerHTML =
        '<div class="digest-empty">No digest yet.<br>' +
        '<span class="digest-hint">worker/daily_digest.py has not run yet — ' +
        "it picks the day's most interesting stories and writes them here.</span></div>";
      return;
    }

    const when = new Date(d.generated_at);
    const ago = when.getTime()
      ? Math.max(0, Math.round((Date.now() - when.getTime()) / 60000))
      : null;
    meta.innerHTML =
      esc(d.stories.length) + " stories · window " + esc(String(d.window_hours)) + "h" +
      (ago != null ? " · updated " + esc(ago < 60 ? ago + " min" : Math.round(ago / 60) + " h") + " ago" : "");

    body.innerHTML = d.stories
      .map((s) => {
        const head = s.headline_en || s.headline || "";
        const place = [s.place, s.country].filter(Boolean).join(", ");
        const where = s.lat != null && s.lng != null
          ? " data-lat=\"" + Number(s.lat) + "\" data-lng=\"" + Number(s.lng) + "\""
          : "";
        return (
          '<article class="digest-story" data-rank="' + esc(String(s.rank)) + '"' + where +
          ' tabindex="0" role="button" aria-label="Show this story on the map">' +
          '<div class="digest-story-head">' +
          '<span class="digest-rank">' + esc(String(s.rank)) + "</span>" +
          '<span class="digest-cat digest-cat--' + esc(String(s.category || "other")) + '">' +
          esc(String(s.category || "other")) + "</span>" +
          (place ? '<span class="digest-place">' + esc(place) + "</span>" : "") +
          "</div>" +
          '<h4 class="digest-headline">' + esc(head) + "</h4>" +
          (s.why ? '<p class="digest-why">' + esc(s.why) + "</p>" : "") +
          '<div class="digest-meta">' +
          esc(String(s.outlets || 0)) + " outlets · " +
          esc(String(s.countries || 0)) + " countries" +
          (s.hours_old != null ? " · " + esc(String(Math.round(s.hours_old))) + "h old" : "") +
          "</div>" +
          "</article>"
        );
      })
      .join("");

    body.querySelectorAll(".digest-story").forEach((el) => {
      const go = () => {
        const lat = parseFloat(el.dataset.lat);
        const lng = parseFloat(el.dataset.lng);
        if (isFinite(lat) && isFinite(lng) && window._xyzoMap) {
          try {
            window._xyzoMap.flyTo([lat, lng], Math.max(window._xyzoMap.getZoom(), 7), { duration: 1.2 });
          } catch (e) {
            window._xyzoMap.setView([lat, lng], 8);
          }
        }
      };
      el.addEventListener("click", go);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
    });
  }

  async function load() {
    if (state.loading) return;
    if (state.loaded && state.digest) {
      render();
      return;
    }
    state.loading = true;
    render();
    try {
      const resp = await fetch(API, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const json = await resp.json();
      state.digest = json;
      state.loaded = true;
    } catch (e) {
      state.digest = { available: false, stories: [] };
      if (window.XLog) window.XLog.warn("[digest] load failed:", e);
    } finally {
      state.loading = false;
      render();
    }
  }

  function wire() {
    const btn = document.getElementById("ctrl-digest-btn");
    if (btn) {
      btn.addEventListener("click", () => setOpen(!state.open));
      btn.setAttribute("aria-expanded", "false");
    }
    const close = document.getElementById("digest-close");
    if (close) {
      close.addEventListener("click", () => setOpen(false));
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.open) setOpen(false);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire, { once: true });
  } else {
    wire();
  }

  // Warm the digest in the background so opening the panel is instant.
  const warm = () => load();
  if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 5000 });
  else setTimeout(warm, 2500);

  window.XyzoDigest = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!state.open),
    isOpen: () => state.open,
    reload: () => {
      state.loaded = false;
      state.digest = null;
      return load();
    },
    getDigest: () => state.digest,
  };
})();
