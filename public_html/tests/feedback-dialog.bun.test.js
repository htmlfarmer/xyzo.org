// feedback-dialog.bun.test.js — the combined Report/Fix dialog.
//
// Why this file exists: public_html/feedback-dialog.js was COMPLETE —
// 240 lines, fully styled by 9 rules already in styles.css — and 0 %
// reachable. It was never <script>-loaded, app.js never called it, and
// the POST /api/pins/:id/report its Report tab depends on did not exist.
// It sat in a git stash through the 2026-10-29 crash. These assertions
// bind the three halves (script tag, popup button, endpoint) together so
// the pieces cannot drift apart again.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const REPO = join(ROOT, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const dialogJs = readFileSync(join(ROOT, "feedback-dialog.js"), "utf8");
const bump = readFileSync(join(REPO, "scripts", "bump_frontend.sh"), "utf8");
const feedbackTs = readFileSync(join(REPO, "api", "src", "routes", "feedback.ts"), "utf8");
const validateTs = readFileSync(join(REPO, "api", "src", "validate.ts"), "utf8");

describe("feedback dialog — it is actually reachable", () => {
  test("index.html loads it BEFORE app.js and stamps it", () => {
    const at = indexHtml.indexOf("feedback-dialog.js");
    const appAt = indexHtml.indexOf("app.js?");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(appAt);
    // Exactly one <script> tag: a second one re-runs the file and can
    // swap state underneath app.js. (Count tags, not bare mentions — the
    // explanatory comment above the tag says the filename too.)
    expect(indexHtml.match(/<script src="feedback-dialog\.js/g).length).toBe(1);
    expect(bump).toMatch(/feedback-dialog\.js/);
  });

  test("the popup renders the button and wires it to the dialog", () => {
    expect(appJs).toMatch(/class="popup-action-btn popup-feedback-btn"/);
    expect(appJs).toMatch(/querySelector\("\.popup-feedback-btn"\)/);
    expect(appJs).toMatch(/window\.showFeedbackDialog\(pin\)/);
    // Guarded: a missing module must degrade, not throw inside the
    // popup handler and take the popup down with it.
    expect(appJs).toMatch(/typeof window\.showFeedbackDialog === "function"/);
  });
});

describe("feedback dialog — it never breaks the popup", () => {
  test("closes the popup through closeActivePopup, not map.closePopup", () => {
    // map.closePopup() skips _isUserExplicitClose, so app.js's
    // popupclose handler auto-restores the popup 50 ms later — it would
    // come back ON TOP of the dialog. (AGENTS.md, "Popup Close Buttons".)
    const body = dialogJs.slice(dialogJs.indexOf("function showFeedbackDialog"));
    expect(body).toMatch(/window\.closeActivePopup\(\)/);
    expect(body).toMatch(/typeof window\.closeActivePopup === "function"/);
  });

  test("escapes the pin title before it goes into the dialog", () => {
    expect(dialogJs).toMatch(/escapeHtml\(pin\.title/);
  });

  test("both dialog actions have an escape hatch", () => {
    // A 4xx/5xx must surface as text, not leave the dialog silent.
    expect(dialogJs).toMatch(/Something went wrong/);
    expect(dialogJs).toMatch(/closeFeedbackDialog/);
  });
});

describe("feedback dialog — both of its endpoints exist", () => {
  test("POST /api/pins/:id/report is defined", () => {
    expect(feedbackTs).toMatch(/feedbackRoute\.post\("\/pins\/:id\/report"/);
  });

  test("POST /api/pins/:id/suggest-coords is defined (the Fix tab)", () => {
    expect(feedbackTs).toMatch(/feedbackRoute\.post\("\/pins\/:id\/suggest-coords"/);
  });

  test("the report tab's radio values match PinReportSchema exactly", () => {
    // A radio the schema rejects is a 400 the user sees as "Something
    // went wrong" — the Report tab would be dead with no clue why.
    const radios = [...dialogJs.matchAll(/name="feedback-type" value="([^"]+)"/g)]
      .map((m) => m[1])
      .sort();
    const schemaBlock = validateTs.slice(validateTs.indexOf("PinReportSchema"));
    const enumBlock = schemaBlock.slice(0, schemaBlock.indexOf("});"));
    const allowed = [...enumBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();

    expect(radios.length).toBeGreaterThan(5);
    expect(radios).toEqual(allowed);
  });

  test("the report lands in news_quality_reports, and never edits a pin", () => {
    // A report is a moderation SIGNAL, not a verdict.
    expect(feedbackTs).toMatch(/INSERT INTO news_quality_reports/);
    const handler = feedbackTs.slice(feedbackTs.indexOf('/pins/:id/report"'));
    const untilNextRoute = handler.slice(0, handler.indexOf("feedbackRoute.", 1));
    expect(untilNextRoute).not.toMatch(/UPDATE news_articles/);
    expect(untilNextRoute).not.toMatch(/UPDATE pins/);
  });
});
