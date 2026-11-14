// update-check.js — gentle "the code just changed, please reload" toast.
//
// Also exposes window.XyzoNudge so other scripts (e.g. viewport-nudge.js
// for the known "second pan doesn't refresh pins" map bug) can surface
// the same warm toast UI with their own copy. See XyzoNudge.show(opts)
// at the bottom of the file for the public surface.
//
// Polls /api/version on a slow cadence. When the SHA stored in localStorage
// no longer matches the live one, surfaces a warm little toast with the
// latest commit message and two buttons (Reload Now / Maybe Later).
//
// Include via <script src="/update-check.js" defer></script> on any page
// you want notified. The script is self-contained — no globals, no deps.
//
// Why not a service worker: the toast is the user's friend, not a forced
// update. They stay in control.

(function () {
  "use strict";

  var POLL_MS = 60_000;
  var LS_KEY = "xyzo:lastSeenSha";
  var LS_DISMISS_KEY = "xyzo:updateToastDismissed";

  // Friendly rotating openers. Pick at random so repeat reloads feel human.
  var OPENERS = [
    "✨ Heads up — fresh code just landed!",
    "🛠️ Quick nudge — the site just got an update.",
    "🎁 New code dropped while you were here!",
    "🌿 Hey — small refresh needed to see what's new.",
    "🪄 Tap to wake up the new bits!",
  ];

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function ensureHost() {
    var host = document.getElementById("xyzo-update-toast");
    if (host) return host;
    host = document.createElement("div");
    host.id = "xyzo-update-toast";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    host.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483600",
      "max-width:380px",
      "background:linear-gradient(135deg,rgba(11,15,20,0.96),rgba(15,23,42,0.96))",
      "border:1px solid rgba(94,234,212,0.45)",
      "border-radius:10px",
      "padding:14px 16px",
      "box-shadow:0 12px 32px rgba(0,0,0,0.45)",
      "color:var(--fg,#e6f1ff)",
      "font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
      "display:none",
      "animation:xyzo-toast-in 0.35s ease",
    ].join(";");
    // Animations + button styling need a style tag.
    if (!document.getElementById("xyzo-update-toast-styles")) {
      var s = document.createElement("style");
      s.id = "xyzo-update-toast-styles";
      s.textContent =
        "@keyframes xyzo-toast-in{from{opacity:0;transform:translateY(8px)}" +
        "to{opacity:1;transform:translateY(0)}}" +
        "#xyzo-update-toast button{font:inherit;border-radius:6px;" +
        "padding:6px 12px;cursor:pointer;transition:background 0.15s;}" +
        "#xyzo-update-toast .xyzo-reload{background:rgba(94,234,212,0.18);" +
        "border:1px solid rgba(94,234,212,0.55);color:#5eead4;}" +
        "#xyzo-update-toast .xyzo-reload:hover{background:rgba(94,234,212,0.3);}" +
        "#xyzo-update-toast .xyzo-later{background:transparent;" +
        "border:1px solid rgba(230,241,255,0.18);color:var(--muted,#9bb0c9);margin-left:6px;}" +
        "#xyzo-update-toast .xyzo-later:hover{border-color:rgba(230,241,255,0.35);}" +
        "#xyzo-update-toast .xyzo-dismiss{background:transparent;border:none;color:var(--muted,#9bb0c9);" +
        "font-size:18px;padding:4px 8px;cursor:pointer;margin-left:auto;line-height:1;}" +
        "#xyzo-update-toast .xyzo-dismiss:hover{color:var(--fg,#e6f1ff);}" +
        "@media(max-width:480px){#xyzo-update-toast{right:8px;bottom:8px;left:8px;max-width:none;}}";
      document.head.appendChild(s);
    }
    document.body.appendChild(host);
    return host;
  }

  function hide() {
    var host = document.getElementById("xyzo-update-toast");
    if (host) host.style.display = "none";
  }

  // ── Public surface: XyzoNudge ────────────────────────────────────────
  //
  // Used internally by the version-checker and externally by other scripts
  // (e.g. viewport-nudge.js). Two flavours:
  //
  //   XyzoNudge.showReload({ title, body, ctaLabel, onReload, onSnooze })
  //     The full two-button nudge. onReload defaults to window.location.reload().
  //
  //   XyzoNudge.showMessage({ title, body, ctaLabel, onCta, dismissible })
  //     Single-button notice; useful for "we're working on it" style hints.
  //
  //   XyzoNudge.hide()
  //     Dismiss whatever is currently showing.
  var XyzoNudge = {
    showReload: function (opts) {
      opts = opts || {};
      var host = ensureHost();
      var title = opts.title || pick(OPENERS);
      var body = opts.body || "";
      var cta = opts.ctaLabel || "Reload now";
      var onReload = opts.onReload || function () { window.location.reload(); };
      var onSnooze = opts.onSnooze || function () {};
      var onDismiss = opts.onDismiss || function () {};
      var dismissible = opts.dismissible !== false;
      host.innerHTML =
        "<div style=\"font-weight:600;color:#5eead4;margin-bottom:4px;\">" +
          escapeHtml(title) +
        "</div>" +
        (body ? "<div style=\"color:var(--fg,#e6f1ff);margin-bottom:10px;line-height:1.4;\">" + escapeHtml(body) + "</div>" : "") +
        "<div style=\"display:flex;align-items:center;\">" +
          "<button class=\"xyzo-reload\" type=\"button\">" + escapeHtml(cta) + "</button>" +
          "<button class=\"xyzo-later\" type=\"button\">Maybe later</button>" +
          (dismissible ? "<button class=\"xyzo-dismiss\" type=\"button\" title=\"Don't show again\">×</button>" : "") +
        "</div>";
      host.style.display = "block";
      host.querySelector(".xyzo-reload").onclick = function () { try { onReload(); } catch (_) {} };
      host.querySelector(".xyzo-later").onclick = function () {
        try { onSnooze(); } catch (_) {}
        hide();
      };
      var dismissBtn = host.querySelector(".xyzo-dismiss");
      if (dismissBtn) dismissBtn.onclick = function () {
        try { onDismiss(); } catch (_) {}
        hide();
      };
    },
    showMessage: function (opts) {
      opts = opts || {};
      var host = ensureHost();
      var title = opts.title || "";
      var body = opts.body || "";
      var cta = opts.ctaLabel || "OK";
      var onCta = opts.onCta || function () { hide(); };
      host.innerHTML =
        (title ? "<div style=\"font-weight:600;color:#5eead4;margin-bottom:4px;\">" + escapeHtml(title) + "</div>" : "") +
        (body ? "<div style=\"color:var(--fg,#e6f1ff);margin-bottom:10px;line-height:1.4;\">" + escapeHtml(body) + "</div>" : "") +
        "<div style=\"display:flex;align-items:center;\">" +
          "<button class=\"xyzo-reload\" type=\"button\">" + escapeHtml(cta) + "</button>" +
          (opts.dismissible === false
            ? ""
            : "<button class=\"xyzo-later\" type=\"button\">Dismiss</button>") +
        "</div>";
      host.style.display = "block";
      host.querySelector(".xyzo-reload").onclick = function () { try { onCta(); } catch (_) {} };
      var later = host.querySelector(".xyzo-later");
      if (later) later.onclick = hide;
    },
    hide: hide,
  };
  // Expose for any script that loads after us.
  window.XyzoNudge = XyzoNudge;

  // ── Version check (uses XyzoNudge.showReload) ───────────────────────
  function showVersionUpdate(shortSha, message, branch) {
    var title = pick(OPENERS);
    var body =
      "Reload to see what's new (" + (shortSha || "?") + ")" +
      (branch && branch !== "HEAD" ? " on " + branch : "") +
      (message ? " — " + message : "");
    XyzoNudge.showReload({
      title: title,
      body: body,
      ctaLabel: "Reload now",
      dismissible: true,
      onReload: function () {
        // Mark the new SHA as seen so the toast doesn't reappear after reload.
        try { localStorage.setItem(LS_KEY, shortSha || ""); } catch (_) {}
        window.location.reload();
      },
      onSnooze: function () {
        // Remember the new SHA so we don't nag for THIS update. The next
        // deploy still triggers a fresh toast.
        try { localStorage.setItem(LS_KEY, shortSha || ""); } catch (_) {}
      },
      onDismiss: function () {
        // Permanently dismiss update toasts for this session.
        try { localStorage.setItem(LS_DISMISS_KEY, "1"); } catch (_) {}
      },
    });
  }

  async function checkOnce() {
    try {
      // Check if user has permanently dismissed update toasts
      var dismissed = null;
      try { dismissed = localStorage.getItem(LS_DISMISS_KEY); } catch (_) {}
      if (dismissed) return;

      var res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return;
      var v = await res.json();
      if (!v || !v.sha) return; // git unavailable, stay quiet

      var seen = null;
      try { seen = localStorage.getItem(LS_KEY); } catch (_) {}
      // First visit on this device: just remember the SHA, no toast.
      if (!seen) {
        try { localStorage.setItem(LS_KEY, v.sha); } catch (_) {}
        return;
      }
      if (seen === v.sha) return; // up to date, nothing to do

      // Only nudge for main/master deploys — feature branches are noisy
      var branch = v.branch || "";
      if (branch !== "main" && branch !== "master" && branch !== "HEAD") return;

      // SHA changed since last load — surface the toast. We deliberately
      // don't auto-reload: the user might be mid-typing, mid-pan, etc.
      showVersionUpdate(v.short_sha, v.message, v.branch);
    } catch (_) {
      // Network blip — try again next tick.
    }
  }

  function start() {
    checkOnce();
    setInterval(checkOnce, POLL_MS);
    // Also re-check when the tab regains focus — catches updates that
    // landed while the user was on another tab without waiting 60s.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") checkOnce();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
