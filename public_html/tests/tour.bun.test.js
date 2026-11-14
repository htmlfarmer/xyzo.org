// tour.bun.test.js — the contract for the HOW TO tour.
//
// The owner asked for *"a 'how to' or a 'demo' of how all our features
// work when people first visit or ask for help"*. So the tour has to
// exist, to show itself on a first visit, to be replayable from the
// control menu and from the help panel, and — above all — to be
// DISMISSIBLE.
//
// The RUNTIME behaviour is measured by scripts/tour_audit.py (a real
// browser: it shows itself, every step has text, the spotlight lands on
// its target, the card never covers the control, Next/Back/Skip/Escape
// work, it does not come back, a shared link does not trigger it, and
// it survives a resize). This file pins the things that must not drift.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const readUp = (f) => readFileSync(join(ROOT, "..", f), "utf8");

const tourJs = read("tour.js");
const indexHtml = read("index.html");
const stylesCss = read("styles.css");
const appJs = read("app.js");

describe("the tour module", () => {
  test("it is loaded, and it is loaded BEFORE app.js", () => {
    expect(indexHtml).toContain("tour.js");
    // The tour captures the hash AS IT ARRIVED — before the map writes
    // its own (the default map is a preset, and the preset becomes the
    // URL). So its tag has to come first.
    expect(indexHtml.indexOf('src="tour.js')).toBeLessThan(indexHtml.indexOf('src="app.js'));
  });

  test("and bump_frontend.sh stamps it", () => {
    // A frontend file that is not stamped keeps a stale ?v=, and a
    // cached browser never loads it.
    expect(readUp("scripts/bump_frontend.sh")).toContain("tour.js");
  });

  test("it exposes a small API and remembers that it has been seen", () => {
    expect(tourJs).toMatch(/window\.XYZO_TOUR\s*=/);
    const exported = tourJs.slice(tourJs.indexOf("window.XYZO_TOUR = {"));
    for (const fn of ["start", "stop", "seen", "markSeen", "reset", "steps"]) {
      expect(exported, fn + " must be exposed").toMatch(
        new RegExp("(\\b" + fn + "\\b\\s*[:,]|\\b" + fn + "\\s*\\()"),
      );
    }
    expect(tourJs).toContain('localStorage.getItem(SEEN_KEY)');
    expect(tourJs).toContain('localStorage.setItem(SEEN_KEY, "1")');
  });
});

describe("the tour's steps", () => {
  // Pull the STEPS array out of the source and read it — the steps are
  // the content, and a content change must be visible here.
  function steps() {
    const start = tourJs.indexOf("const STEPS = [");
    expect(start, "tour.js must have a STEPS array").toBeGreaterThan(-1);
    const end = tourJs.indexOf("\n  ];", start);
    const body = tourJs.slice(start, end);
    const ids = [...body.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
    const titles = [...body.matchAll(/title:\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);
    const texts = [...body.matchAll(/body:\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);
    return { ids, titles, texts, body };
  }

  test("there are several steps, each with an id", () => {
    const s = steps();
    expect(s.ids.length).toBeGreaterThanOrEqual(5);
    expect(new Set(s.ids).size).toBe(s.ids.length);
  });

  test("every step has a title AND a body — a step with no text teaches nothing", () => {
    const s = steps();
    expect(s.titles.length).toBe(s.ids.length);
    expect(s.texts.length).toBe(s.ids.length);
    for (const t of s.titles) expect(t.length).toBeGreaterThan(4);
    for (const b of s.texts) expect(b.length).toBeGreaterThan(40);
  });

  test("the steps name the controls a reader needs", () => {
    const s = steps();
    const all = s.body;
    for (const needle of ["layers", "search", "globe", "control-menu-btn"]) {
      expect(all, "the tour must mention " + needle).toContain(needle);
    }
  });

  test("a step's target may be a LIST — a hidden control is not a target", () => {
    // The layers toggle is 0 x 0 while the panel is OPEN (Leaflet hides
    // it), and the live panel's own box sits off-screen at
    // translateX(-100%) while it is CLOSED — so both steps take a list
    // and use whichever element has a real size right now.
    // A step that points at a zero-sized element has no spotlight.
    expect(tourJs).toMatch(/Array\.isArray\(step\.target\)/);
    expect(tourJs).toContain(".leaflet-control-layers-toggle");
    // The live step points at the button that OPENS the panel, because
    // both control windows start closed (2026-11-06).
    const live = tourJs.slice(tourJs.indexOf('id: "live"'), tourJs.indexOf('id: "globe"'));
    expect(live).toContain("#live-panel-reopen");
    expect(live).toContain("#live-panel");
  });
});

describe("the tour is a good guest", () => {
  test("the SPOTLIGHT never swallows a click", () => {
    // The cut-out is a pointer-events:none layer, so the reader can
    // press the very control the step describes while the step is on
    // screen. A tour that blocks the map teaches "you cannot touch
    // this".
    expect(stylesCss).toMatch(/\.xyzo-tour-spot\s*\{[^}]*pointer-events:\s*none/s);
  });

  test("the CARD is the only thing the tour puts on the pointer path", () => {
    expect(stylesCss).toMatch(/\.xyzo-tour-card\s*\{[^}]*pointer-events:\s*auto/s);
  });

  test("it can always be dismissed — Escape, the X, and Skip", () => {
    expect(tourJs).toMatch(/e\.key === "Escape"/);
    expect(tourJs).toContain('xyzo-tour-skip');
    expect(tourJs).toContain('xyzo-tour-close');
    expect(stylesCss).toContain(".xyzo-tour-close");
  });

  test("it sits ABOVE the chrome and BELOW the system banners", () => {
    // A shutdown notice must never be hidden under the tour, and the
    // tour must never be hidden under the chrome it is describing.
    expect(stylesCss).toMatch(/\.xyzo-tour-card\s*\{[^}]*z-index:\s*var\(--z-dropdown\)/s);
    expect(stylesCss).toMatch(/\.xyzo-tour-spot\s*\{[^}]*z-index:\s*calc\(var\(--z-dropdown\) - 1\)/s);
  });

  test("on a phone it is a SHEET, not a floating card", () => {
    // A floating card on a 390 px screen covers the control it is
    // describing — so below 640 px it docks to the bottom.
    expect(stylesCss).toMatch(/@media \(max-width: 639px\)/);
    expect(stylesCss).toMatch(/xyzo-tour-card--sheet/);
  });

  test("the sheet CLEARS THE BOTTOM BAR, not a typed constant", () => {
    // The bottom bar holds the ⚙ button — and step 6 POINTS AT the ⚙
    // button. A sheet that covered the bar would cover the very
    // control the last step describes, and the rule "the card never
    // covers the control it describes" would break on exactly the
    // screen where it matters most. --bottom-bar-top is published by
    // publishChromeEdges(), so the sheet follows the REAL bar.
    expect(stylesCss).toMatch(/xyzo-tour-card--sheet[\s\S]{0,600}--bottom-bar-top/);
  });

  test("the Help Me pill does not float over the tour", () => {
    // #help-me-btn is `position: fixed` on <body> at z-index 9998 —
    // ABOVE the tour card — and it covered a third of the card's text.
    // It is an emergency affordance, not a control; hiding it while
    // the tour is open costs nothing.
    expect(stylesCss).toMatch(/body\[data-tour-open\] #help-me-btn/);
  });

  test("it never moves the map", () => {
    // The steps describe what is already on screen. The tour does not
    // fly the reader somewhere else — that would be a second thing
    // happening at once.
    expect(tourJs).not.toMatch(/setView\(|flyTo\(|panTo\(/);
  });
});

describe("the entry points", () => {
  test("the control menu has a 'How to' button", () => {
    expect(indexHtml).toContain('id="ctrl-tour-btn"');
    expect(indexHtml).toMatch(/id="ctrl-tour-btn"[\s\S]{0,400}How to/);
    expect(tourJs).toContain('document.getElementById("ctrl-tour-btn")');
  });

  test("the help panel has one too — 'ask for help' should be able to SHOW", () => {
    expect(indexHtml).toContain('id="help-tour-btn"');
    expect(tourJs).toContain('document.getElementById("help-tour-btn")');
  });

  test("it does NOT show itself any more — the tour is OPT-IN (owner, 2026-11-13)", () => {
    // *"dont show the 'how to' on the first load thats kinda annoying..
    // just put that with something else"* — and on a phone the card is a
    // sheet that covers most of the screen, so the reader's first sight
    // of the site was a modal card about a map they had not looked at
    // yet.
    //
    // THE CONTRACT: there is no auto-start anywhere in the module. A
    // reader who wants the tour presses ⚙ → TOOLS → "How to" (or the
    // help panel's "Show me how this works").
    expect(tourJs).not.toMatch(/maybeAutoStart/);
    expect(tourJs).not.toMatch(/setTimeout\(.*start\(\{ step: 0 \}\)/);
    // …and nothing opens it on a timer either.
    expect(tourJs).not.toMatch(/setTimeout\([^)]*start\(/);
    // The two buttons ARE the way in.
    expect(tourJs).toContain('document.getElementById("ctrl-tour-btn")');
    expect(tourJs).toContain('document.getElementById("help-tour-btn")');
  });

  test("the tour does not fight the layers dropdown, the bottom bar or the search pill", () => {
    // The card is placed BESIDE the control it describes, and it never
    // overlaps it — measured by scripts/tour_audit.py. The placement
    // code is the contract.
    expect(tourJs).toMatch(/function place\(step\)/);
    expect(tourJs).toContain("spaceRight");
    expect(tourJs).toContain("spaceLeft");
    expect(tourJs).toContain("spaceBelow");
    expect(tourJs).toContain("spaceAbove");
  });

  test("the placement is retried — a control that is not laid out yet is not a target", () => {
    // The layers toggle is created by Leaflet, and on a phone the live
    // panel is collapsed. A step that points at nothing is worse than a
    // step that points a beat later.
    expect(tourJs).toMatch(/function retryPlacement\(/);
    expect(tourJs).toContain("r.width > 4 && r.height > 4");
  });
});
