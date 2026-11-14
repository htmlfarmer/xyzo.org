/**
 * weather-archive.js — the TIME MACHINE: see the map as it was.
 *
 * WHAT IT IS. The site publishes three weather fields every GFS analysis
 * cycle (four a day): the 10 m wind, the 2 m temperature and the
 * pressure contours. The workers REPLACE the previous cycle when the
 * next one lands, so the past was not a lookup — it was gone.
 * worker/weather_archive.py keeps a copy of every cycle (a year of them
 * costs ~550 MB at the 1° resolution and the classic 4 hPa chart), and
 * this module is the reader's side of it: pick a date and a time, and the
 * map draws that moment's weather instead of this afternoon's.
 *
 * THE ARCHIVED FIELDS ARE THE 1° ONES — the same grids the 3D globe
 * draws ("the SAME field, subsampled by the SAME worker run"). The flat
 * map's live overlays are 0.25°, and a year of THOSE would be 8.8 GB,
 * so the archive keeps the coarse field and says so: the reader is told
 * the resolution rather than being given a map that quietly looks
 * different from the live one.
 *
 * WHAT IT DOES NOT SWITCH: the basemap, the pins' styling, the other
 * overlays. It switches WHERE THE THREE WEATHER FIELDS COME FROM, and
 * the window the news is drawn from (the day in question).
 *
 * THE STATE IS GLOBAL AND TINY: one ISO moment, or null for "now".
 */
(function () {
  "use strict";

  // The four analysis times of a day (GFS: 00/06/12/18Z).
  const ANALYSIS_HOURS = [0, 6, 12, 18];

  const state = {
    at: null,        // the ISO moment the reader is looking at, or null
    cycle: null,     // the archive cycle actually served for it
    cycles: [],      // what the archive holds
    listening: false,
  };

  const listeners = [];

  function onChange(fn) {
    listeners.push(fn);
  }

  function emit(reason) {
    for (const fn of listeners) {
      try { fn(state.at, reason); } catch (_) { /* a listener must not break the rest */ }
    }
    // THE THREE WEATHER LAYERS HOLD THEIR GRID IN MEMORY, so they must
    // be emptied and re-added — otherwise the reader would be looking at
    // today's wind while the panel says March.
    if (reason === "set" || reason === "clear") {
      for (const L of [window.TempLayer, window.WindLayer, window.IsobarLayer]) {
        try { L && typeof L.resetForArchive === "function" && L.resetForArchive(); } catch (_) {}
      }
      try { if (typeof window.applyLayers === "function") window.applyLayers(); } catch (_) {}
      try { if (typeof window.reloadPins === "function") window.reloadPins(); } catch (_) {}
    }
  }

  /** The moment the reader is looking at, or null for "now". */
  function active() {
    return state.at;
  }

  /** The archive cycle the server will serve for that moment. */
  function cycle() {
    return state.cycle;
  }

  function q(at) {
    return "?at=" + encodeURIComponent(at || state.at || "");
  }

  /** The URL of an archived field's GRID (wind / temp), or null for live. */
  function gridUrl(field) {
    if (!state.at) return null;
    return "/api/weather/archive/" + field + ".bin" + q();
  }

  /** The URL of an archived field's META, or null for live. */
  function metaUrl(field) {
    if (!state.at) return null;
    return "/api/weather/archive/meta.json?field=" + encodeURIComponent(field) + "&at=" + encodeURIComponent(state.at);
  }

  /** The URL of the archived pressure chart, or null for live. */
  function isobarUrl() {
    if (!state.at) return null;
    return "/api/weather/archive/isobars.json" + q();
  }

  /** The start of the day the reader is looking at (for the news window). */
  function dayStart(at) {
    const t = at ? Date.parse(at) : Date.now();
    if (!Number.isFinite(t)) return null;
    return new Date(Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate(), 0, 0, 0)).toISOString();
  }

  /** The end of that day (the news window's other end). */
  function dayEnd(at) {
    const t = at ? Date.parse(at) : Date.now();
    if (!Number.isFinite(t)) return null;
    return new Date(Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate(), 23, 59, 59)).toISOString();
  }

  /** The archive's list of cycles — what the picker offers. */
  async function loadCycles() {
    try {
      const r = await fetch("/api/weather/archive/cycles");
      if (!r.ok) return [];
      const j = await r.json();
      state.cycles = Array.isArray(j.cycles) ? j.cycles : [];
      return state.cycles;
    } catch (_) {
      return [];
    }
  }

  /**
   * Show the map as it was at `iso`.
   *
   * The archive answers with the cycle that was IN EFFECT at that
   * moment, which may be an hour or two earlier (the analyses are six
   * hours apart), so the cycle it served is remembered and shown — the
   * reader asked for a moment and gets the analysis that was standing
   * at the time.
   */
  async function setAt(iso) {
    if (!iso) return clear();
    state.at = iso;
    state.cycle = null;
    // The moment rides in the URL, so a past map can be shared the way a
    // search can (?q=).
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("at", iso);
      history.replaceState(null, "", u.toString());
    } catch (_) {}
    emit("set");
    try {
      const r = await fetch("/api/weather/archive/cycles");
      if (r.ok) {
        const j = await r.json();
        const list = Array.isArray(j.cycles) ? j.cycles : [];
        state.cycles = list;
        const t = Date.parse(iso);
        let best = null;
        for (const c of list) {
          const ct = Date.parse(c.cycle);
          if (Number.isFinite(ct) && ct <= t) best = c;
        }
        state.cycle = best ? best.cycle : (list.length ? list[list.length - 1].cycle : null);
      }
    } catch (_) { /* the layers still ask for the archive URL */ }
    emit("cycle");
    return state.cycle;
  }

  /** Back to now. */
  function clear() {
    state.at = null;
    state.cycle = null;
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete("at");
      history.replaceState(null, "", u.toString());
    } catch (_) {}
    emit("clear");
  }

  /** A human sentence for the status line. */
  function describe() {
    if (!state.at) return "";
    const t = new Date(state.at);
    if (!Number.isFinite(t.getTime())) return "";
    const when = t.toISOString().replace("T", " ").slice(0, 16) + " UTC";
    return state.cycle && state.cycle !== state.at
      ? `the map as of ${when} (analysis ${String(state.cycle).slice(0, 16).replace("T", " ")} UTC)`
      : `the map as of ${when}`;
  }

  // ── the picker in the control menu ────────────────────────────────────
  function mount() {
    const section = document.getElementById("weather-archive-section");
    if (!section) return;
    const dateEl = document.getElementById("archive-date");
    const timeEl = document.getElementById("archive-time");
    const applyBtn = document.getElementById("archive-apply");
    const nowBtn = document.getElementById("archive-now");
    const statusEl = document.getElementById("archive-status");

    // The section only appears when the archive has something in it —
    // a reader should not be offered a date that cannot be served.
    loadCycles().then((cycles) => {
      if (!cycles.length) {
        section.hidden = true;
        return;
      }
      section.hidden = false;
      const oldest = cycles[0].cycle;
      const newest = cycles[cycles.length - 1].cycle;
      if (dateEl) {
        dateEl.min = String(oldest).slice(0, 10);
        dateEl.max = String(newest).slice(0, 10);
        if (!dateEl.value) dateEl.value = String(newest).slice(0, 10);
      }
      if (statusEl && !state.at) {
        statusEl.textContent = `${cycles.length} archived cycles — the oldest is ${String(oldest).slice(0, 10)}.`;
      }
    });

    const chosen = () => {
      if (!dateEl || !dateEl.value) return null;
      const hour = timeEl && timeEl.value !== "" ? Number(timeEl.value) : 12;
      const d = new Date(`${dateEl.value}T00:00:00Z`);
      if (!Number.isFinite(d.getTime())) return null;
      d.setUTCHours(hour, 0, 0, 0);
      return d.toISOString();
    };

    if (applyBtn) {
      applyBtn.addEventListener("click", async () => {
        const iso = chosen();
        if (!iso) return;
        await setAt(iso);
        if (statusEl) statusEl.textContent = describe() + ".";
        if (nowBtn) nowBtn.hidden = false;
        try { applyBtn.textContent = "⏱ Showing that moment"; } catch (_) {}
      });
    }
    if (nowBtn) {
      nowBtn.addEventListener("click", () => {
        clear();
        if (nowBtn) nowBtn.hidden = true;
        if (statusEl) statusEl.textContent = "Back to the live map.";
        if (applyBtn) applyBtn.textContent = "⏱ Show that moment";
      });
    }
  }

  window.WeatherArchive = {
    active,
    cycle,
    gridUrl,
    metaUrl,
    isobarUrl,
    dayStart,
    dayEnd,
    loadCycles,
    setAt,
    clear,
    describe,
    onChange,
    mount,
    ANALYSIS_HOURS,
    _state: () => state,
  };

  // A SHARED LINK CARRIES THE MOMENT (?at=), the way a search does (?q=).
  function bootFromUrl() {
    try {
      const at = new URL(window.location.href).searchParams.get("at");
      if (at && Date.parse(at)) setAt(at);
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { mount(); bootFromUrl(); });
  } else {
    mount();
    bootFromUrl();
  }
})();
