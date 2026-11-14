/* ═══════════════════════════════════════════════════════════════════════
   The HOW TO tour — a guided first visit.

   WHAT IT IS
   ----------
   A first-time reader lands on a map with thirty-odd overlays, a live
   feed, a globe, an export dialog and a control menu. Nobody reads a
   manual, and the map is too big to explain with a paragraph.

   So the tour walks them through it: six steps, each one pointing at
   the real control it talks about, so the reader is looking AT the
   thing while it is named.

   WHERE IT LIVES
   --------------
   It is a BUTTON, and it is where a reader goes when they want to be
   shown:
     · ⚙ (the control menu) → TOOLS → "How to"
     · the Help panel → "Show me how this works"

   IT NO LONGER SHOWS ITSELF (owner, 2026-11-13: *"dont show the 'how
   to' on the first load thats kinda annoying.. just put that with
   something else"*). It used to appear on its own, once, on a first
   visit — and on a phone the card covers most of the screen before the
   reader has even seen the map. It is now OPT-IN: the two buttons
   above, and nothing else. A tour that interrupts is a tour that is
   dismissed without being read, and a dismissed tour teaches nothing.

   THE RULES
   ---------
   · THE SPOTLIGHT NEVER SWALLOWS A CLICK. The cut-out is
     `pointer-events: none`, so the reader can press the very control
     the step is describing while the step is on screen. A tour that
     blocks the map is a tour that teaches "you cannot touch this".
   · THE CARD IS ESCAPABLE. Escape closes it, and so does "Skip" and
     the ✕. A tour that cannot be dismissed is a hostage.
   · IT NEVER MOVES THE MAP. The steps describe what is already on
     screen; the tour does not fly the reader to somewhere else, which
     would be a second thing happening at once.
   · IT IS A SHEET ON A PHONE. Below 640 px the card docks to the
     bottom of the viewport with the safe-area inset, because a
     floating card on a 390 px screen covers the control it is
     describing.
   · IT RE-POSITIONS ITSELF on resize and on scroll, because the
     controls it points at are laid out with CSS.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  const SEEN_KEY = "xyzo.tourSeen";
  const STEP_KEY = "xyzo.tourStep";

  // (The hash AS IT ARRIVED used to be read here, to decide whether a
  // first visit should be shown the tour. There is no auto-start any
  // more, so nothing needs it — the tour is opened by a button, and a
  // button is the same button whatever the URL says.)

  /**
   * The steps.
   *
   * `target` is a CSS selector — the thing the step points at. When it
   * is missing (or nothing matches) the step has no spotlight and the
   * card sits in the middle of the screen.
   *
   * `before` runs when the step is shown — used to open a panel the
   * step is talking about, so the reader sees it open.
   */
  const STEPS = [
    {
      id: "welcome",
      title: "This is the world's news, on a map",
      body:
        "Every pin is a real story from a real publisher — a wire service, " +
        "a national paper, a local outlet. Click a pin for the headline, the " +
        "summary and a link to the original article. " +
        "Around it sit dozens of live overlays: the wind, the ocean " +
        "currents, the earthquakes, the climate, the soil under your feet.",
      target: null,
    },
    {
      id: "layers",
      title: "The layers button",
      body:
        "This stack icon opens every overlay the site has — the wind " +
        "animation, the live ocean currents, the earthquakes and the " +
        "tectonic faults, the Köppen climate zones, the soil, the " +
        "cropland, the rivers, the basins, the geology and more. " +
        "Each one has its own opacity slider, so you can dial it back " +
        "until it reads through what is underneath.",
      // BOTH viewports start collapsed now (2026-11-06), so the toggle
      // is a real 44/36 px box on a first visit. Once the reader opens
      // the panel the toggle is display:none (0 × 0), so the step falls
      // through to the panel itself. Hence the list.
      target: [".leaflet-control-layers-toggle", ".leaflet-control-layers"],
    },
    {
      id: "search",
      title: "Search, or ask",
      body:
        "Type a place to fly to it, a topic to find the stories about it, " +
        "or a question to ask the AI about what is happening. " +
        "A result you share keeps the exact view — the position, the " +
        "overlays, their opacity and the settings — so the other person " +
        "sees your map, not their own.",
      target: "#search-bar",
    },
    {
      id: "live",
      title: "The live feed",
      body:
        "The panel down the side is the news as it happens: hot stories, " +
        "stories near you, and a filter for your own interests. " +
        "It starts tucked away — the «Live status ›» button brings it " +
        "back. Every entry lists the outlets that reported it — tap a " +
        "source to read it where it was published.",
      // Starts CLOSED on every viewport now (2026-11-06), so the thing
      // to point at is the button that opens it. When the panel IS
      // open, that button is display:none (0 × 0) and the step falls
      // through to the panel itself.
      target: ["#live-panel-reopen", "#live-panel"],
    },
    {
      id: "globe",
      title: "The same map, as a globe",
      body:
        "This button opens the 3D view — the same overlays and the same " +
        "pins on a sphere. It is a separate page, and a link from it " +
        "brings you back here with everything you had switched on.",
      target: ".leaflet-control-zoom-world[href='/globe']",
    },
    {
      id: "controls",
      title: "Everything else lives under ⚙",
      body:
        "The gear menu holds the rest: save this view and make it your " +
        "default, export the map as an image or the data as GeoTIFF / " +
        "GeoJSON / CSV, the text size, the hover readout, and this " +
        "tour again. " +
        "And the layers dropdown holds the whole overlay set — the " +
        "geology, the currents and the earthquakes included.",
      target: "#control-menu-btn",
    },
  ];

  const state = {
    open: false,
    index: 0,
    card: null,
    spot: null,
    onKey: null,
    onResize: null,
  };

  function log(msg, a) {
    if (window.XLog && typeof window.XLog.warn === "function") window.XLog.warn("tour: " + msg, a);
  }

  // ── storage ──────────────────────────────────────────────────────────
  function seen() {
    try { return localStorage.getItem(SEEN_KEY) === "1"; } catch (_) { return false; }
  }
  function markSeen() {
    try { localStorage.setItem(SEEN_KEY, "1"); } catch (_) {}
  }
  function rememberStep(i) {
    try { localStorage.setItem(STEP_KEY, String(i)); } catch (_) {}
  }

  // ── the DOM ──────────────────────────────────────────────────────────
  function build() {
    if (state.card) return state.card;

    const spot = document.createElement("div");
    spot.className = "xyzo-tour-spot";
    spot.setAttribute("aria-hidden", "true");

    const card = document.createElement("div");
    card.className = "xyzo-tour-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "false");
    card.setAttribute("aria-label", "How to use this map");

    const head = document.createElement("div");
    head.className = "xyzo-tour-head";

    const count = document.createElement("span");
    count.className = "xyzo-tour-count";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "xyzo-tour-close";
    close.setAttribute("aria-label", "Close the tour");
    close.textContent = "×";

    head.appendChild(count);
    head.appendChild(close);

    const title = document.createElement("h2");
    title.className = "xyzo-tour-title";

    const body = document.createElement("p");
    body.className = "xyzo-tour-body";

    const dots = document.createElement("div");
    dots.className = "xyzo-tour-dots";

    const foot = document.createElement("div");
    foot.className = "xyzo-tour-foot";

    const skip = document.createElement("button");
    skip.type = "button";
    skip.id = "xyzo-tour-skip";
    skip.className = "xyzo-tour-btn xyzo-tour-btn--ghost";
    skip.textContent = "Skip";

    const back = document.createElement("button");
    back.type = "button";
    back.id = "xyzo-tour-back";
    back.className = "xyzo-tour-btn";
    back.textContent = "Back";

    const next = document.createElement("button");
    next.type = "button";
    next.id = "xyzo-tour-next";
    next.className = "xyzo-tour-btn xyzo-tour-btn--primary";
    next.textContent = "Next";

    foot.appendChild(skip);
    foot.appendChild(back);
    foot.appendChild(next);

    card.appendChild(head);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(dots);
    card.appendChild(foot);

    document.body.appendChild(spot);
    document.body.appendChild(card);

    state.card = card;
    state.spot = spot;
    state.els = { count, title, body, dots, back, next, skip, close };
    return card;
  }

  // ── placement ────────────────────────────────────────────────────────
  /**
   * Where the card goes.
   *
   * The rule is "beside the target, in the room that has space" — and
   * on a narrow screen there is no room beside anything, so the card
   * becomes a sheet at the bottom.
   */
  function place(step) {
    const card = state.card;
    const spot = state.spot;
    if (!card) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const narrow = vw < 640;

    card.classList.toggle("xyzo-tour-card--sheet", narrow);

    let rect = null;
    const selectors = step.target
      ? (Array.isArray(step.target) ? step.target : [step.target])
      : [];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      // A zero-sized element is not a target (a hidden panel, a
      // control that has not been laid out yet) — treat it as "no
      // spotlight" rather than pointing at a dot.
      if (r.width > 4 && r.height > 4) { rect = r; break; }
    }

    if (!rect) {
      // No spotlight: dim the whole screen and centre the card.
      spot.style.left = "0px";
      spot.style.top = "0px";
      spot.style.width = "0px";
      spot.style.height = "0px";
      spot.style.borderRadius = "0px";
      spot.style.boxShadow = "0 0 0 9999px rgba(3,7,18,.72)";
      card.style.left = "";
      card.style.top = "";
      card.style.right = "";
      card.style.bottom = "";
      card.style.transform = "translate(-50%, -50%)";
      card.style.left = (vw / 2) + "px";
      card.style.top = (vh / 2) + "px";
      card.style.maxWidth = Math.min(420, vw - 32) + "px";
      return;
    }

    // The cut-out: a hole in the dim, exactly over the control.
    const pad = 8;
    spot.style.left = (rect.left - pad) + "px";
    spot.style.top = (rect.top - pad) + "px";
    spot.style.width = (rect.width + pad * 2) + "px";
    spot.style.height = (rect.height + pad * 2) + "px";
    spot.style.borderRadius = "10px";
    spot.style.boxShadow = "0 0 0 9999px rgba(3,7,18,.72), 0 0 0 2px var(--accent)";

    if (narrow) {
      card.style.left = "8px";
      card.style.right = "8px";
      card.style.top = "";
      card.style.bottom = "";
      card.style.transform = "";
      card.style.maxWidth = "";
      return;
    }

    // Beside it. The card is 340 px wide; the space above/below the
    // target decides whether it goes to the side or under it.
    const cardW = Math.min(340, vw - 32);
    const cardH = card.offsetHeight || 240;
    const gap = 16;

    const spaceRight = vw - rect.right - gap - 16;
    const spaceLeft = rect.left - gap - 16;
    const spaceBelow = vh - rect.bottom - gap - 16;
    const spaceAbove = rect.top - gap - 16;

    let left, top;
    if (spaceRight >= cardW) {
      left = rect.right + gap;
      top = rect.top;
    } else if (spaceLeft >= cardW) {
      left = rect.left - gap - cardW;
      top = rect.top;
    } else if (spaceBelow >= cardH) {
      left = Math.max(16, Math.min(rect.left, vw - cardW - 16));
      top = rect.bottom + gap;
    } else if (spaceAbove >= cardH) {
      left = Math.max(16, Math.min(rect.left, vw - cardW - 16));
      top = rect.top - gap - cardH;
    } else {
      // Nowhere has room — centre it and let the dim do the work.
      left = Math.max(16, (vw - cardW) / 2);
      top = Math.max(16, (vh - cardH) / 2);
    }

    card.style.left = Math.round(left) + "px";
    card.style.top = Math.round(top) + "px";
    card.style.right = "";
    card.style.bottom = "";
    card.style.transform = "";
    card.style.maxWidth = cardW + "px";
  }

  function render() {
    const step = STEPS[state.index];
    if (!step) return;
    const els = state.els;
    els.count.textContent = "Step " + (state.index + 1) + " of " + STEPS.length;
    els.title.textContent = step.title;
    els.body.textContent = step.body;
    els.back.disabled = state.index === 0;
    els.next.textContent = state.index === STEPS.length - 1 ? "Got it" : "Next";

    // The dots.
    els.dots.textContent = "";
    for (let i = 0; i < STEPS.length; i++) {
      const d = document.createElement("button");
      d.type = "button";
      d.className = "xyzo-tour-dot" + (i === state.index ? " is-current" : "");
      d.setAttribute("aria-label", "Step " + (i + 1));
      d.addEventListener("click", () => go(i));
      els.dots.appendChild(d);
    }

    place(step);
    rememberStep(state.index);
    // The target of a step may not be on the page yet — the layers
    // toggle is created by Leaflet. A step that points at nothing is
    // worse than a step that points a beat later, so the placement is
    // retried a few times before it is given up on. (Both control
    // windows start closed now, so the live step points at the button
    // that opens them — see the target lists above.)
    retryPlacement(step, 0);
  }

  function retryPlacement(step, attempt) {
    if (!state.open || attempt >= 5) return;
    if (!step.target) return;
    const selectors = Array.isArray(step.target) ? step.target : [step.target];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) { place(step); return; }
    }
    setTimeout(() => retryPlacement(step, attempt + 1), 350);
  }

  function go(i) {
    state.index = Math.max(0, Math.min(STEPS.length - 1, i));
    render();
  }

  // ── open / close ─────────────────────────────────────────────────────
  function start(opts) {
    opts = opts || {};
    if (state.open) return;
    build();

    state.open = true;
    document.body.setAttribute("data-tour-open", "1");
    if (state.card) state.card.classList.add("is-open");

    const startAt = Number.isFinite(opts.step) ? opts.step : 0;
    state.index = Math.max(0, Math.min(STEPS.length - 1, startAt));

    // The first step may point at a control that has not been laid out
    // yet (the layers toggle is created by Leaflet). So the first
    // render waits a beat for the page to settle.
    if (opts.immediate) {
      render();
    } else {
      setTimeout(render, 120);
    }

    // Escape closes it.
    state.onKey = (e) => {
      if (e.key === "Escape") { stop(); e.preventDefault(); }
    };
    document.addEventListener("keydown", state.onKey);

    // The controls MOVE (the layers panel opens, the window resizes),
    // so the spotlight has to follow.
    state.onResize = () => { if (state.open) place(STEPS[state.index]); };
    window.addEventListener("resize", state.onResize);
    window.addEventListener("scroll", state.onResize, true);

    state.els.close.addEventListener("click", stop);
    state.els.skip.addEventListener("click", stop);
    state.els.next.addEventListener("click", () => {
      if (state.index >= STEPS.length - 1) { stop(); return; }
      go(state.index + 1);
    });
    state.els.back.addEventListener("click", () => go(state.index - 1));
  }

  function stop() {
    if (!state.open) return;
    state.open = false;
    markSeen();
    document.body.removeAttribute("data-tour-open");
    if (state.card) state.card.classList.remove("is-open");
    if (state.spot) state.spot.style.boxShadow = "none";
    if (state.onKey) { document.removeEventListener("keydown", state.onKey); state.onKey = null; }
    if (state.onResize) {
      window.removeEventListener("resize", state.onResize);
      window.removeEventListener("scroll", state.onResize, true);
      state.onResize = null;
    }
  }

  // ── the entry points ─────────────────────────────────────────────────
  //
  // THE TOUR IS OPT-IN (owner, 2026-11-13). It used to start itself on
  // a first visit, 1.8 s after the boot — and on a phone the card is a
  // sheet that covers most of the screen, so the reader's first sight
  // of the site was a modal card about a map they had not looked at
  // yet. A tour nobody asked for is a tour that is closed unread.
  //
  // So there is no auto-start any more. The two buttons below are the
  // whole way in, and `XYZO_TOUR.start()` is there for anything that
  // wants to open it programmatically.
  function wire() {
    // ⚙ → TOOLS → "How to"
    const btn = document.getElementById("ctrl-tour-btn");
    if (btn && !btn._xyzoTourWired) {
      btn._xyzoTourWired = true;
      btn.addEventListener("click", () => {
        // Close the menu first, or the card is drawn UNDER it.
        const menu = document.getElementById("control-menu");
        if (menu) menu.hidden = true;
        document.body.removeAttribute("data-dropdown-open");
        start({ step: 0, immediate: true });
      });
    }

    // The help panel → "Show me how this works"
    const helpBtn = document.getElementById("help-tour-btn");
    if (helpBtn && !helpBtn._xyzoTourWired) {
      helpBtn._xyzoTourWired = true;
      helpBtn.addEventListener("click", () => {
        const panel = document.getElementById("help-panel");
        if (panel) panel.hidden = true;
        start({ step: 0, immediate: true });
      });
    }
  }

  function init() {
    build();
    wire();
    // NO AUTO-START. See the note above `wire()`.
  }

  window.XYZO_TOUR = {
    start,
    stop,
    seen,
    markSeen,
    reset() { try { localStorage.removeItem(SEEN_KEY); } catch (_) {} },
    steps: () => STEPS.map((s) => ({ id: s.id, title: s.title })),
    _state: state,
    _init: init,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
