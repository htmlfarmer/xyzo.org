// a11y.bun.test.js — Static-analysis a11y checks via Bun (no browser).
// Reads the source HTML/JS/CSS directly and asserts:
//   - Every <button> in index.html has either visible text or aria-label
//   - Modal panels declare role="dialog" + aria-modal
//   - Global :focus-visible outline rule exists in styles.css
//   - Modal helpers + Escape handlers exist in app.js
//
// The browser-side companion at a11y.test.js runs the same checks at
// runtime for a fuller audit (form labels, dynamic content). This file
// gates CI on the most impactful invariants.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

describe("a11y — static checks", () => {
  test("index.html has a global :focus-visible outline rule", () => {
    // The global rule was added during the a11y pass — without it,
    // dynamically created controls (Leaflet zoom buttons, popup
    // close buttons) would have no visible focus indicator.
    expect(stylesCss).toMatch(/:focus-visible\s*\{[^}]*outline\s*:\s*2px/);
  });

  test("icon-only <button>s in index.html have aria-label", () => {
    // Match each <button ...>...</button> block. We allow text content,
    // aria-label, aria-labelledby, or aria-hidden. We allow <svg>
    // children as long as the button has SOME name.
    const buttonRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    const offenders = [];
    let m;
    while ((m = buttonRe.exec(indexHtml)) !== null) {
      const attrs = m[1];
      const body = m[2].trim();
      // Strip child tags — what remains is text content.
      const textOnly = body.replace(/<[^>]+>/g, "").trim();
      const hasAriaLabel = /\baria-label=/.test(attrs);
      const hasAriaLabelledBy = /\baria-labelledby=/.test(attrs);
      if (textOnly === "" && !hasAriaLabel && !hasAriaLabelledBy) {
        // Allow aria-hidden="true" buttons (purely decorative, though
        // we shouldn't see them in interactive HTML).
        offenders.push(m[0].slice(0, 120));
      }
    }
    if (offenders.length) {
      console.warn("[a11y] Buttons without accessible name:");
      offenders.forEach((o) => console.warn("  -", o));
    }
    expect(offenders.length).toBe(0);
  });

  test("explore-panel + help-panel + submitter-overlay declare role=dialog", () => {
    for (const id of ["explore-panel", "help-panel", "submitter-overlay"]) {
      const re = new RegExp(`<div[^>]*id=["']${id}["'][^>]*>`);
      const match = indexHtml.match(re);
      expect(match).not.toBeNull();
      expect(match[0]).toMatch(/\brole=["']dialog["']/);
      expect(match[0]).toMatch(/\baria-modal=["']true["']/);
    }
  });

  test("app.js defines modal a11y helpers", () => {
    expect(appJs).toContain("function installModalA11y");
    expect(appJs).toContain("function attachModalEscape");
    expect(appJs).toContain("function detachModalEscape");
    expect(appJs).toContain("function removeModalA11y");
    expect(appJs).toContain("function openModalA11y");
    expect(appJs).toContain("function closeModalA11y");
  });

  test("explore-panel + help-panel wire Escape and focus trap", () => {
    // Both panels should call attachModalEscape when opening, and
    // closeModalA11y (which removes the trap + Escape) on close.
    expect(appJs).toMatch(/toggleExplorePanel[\s\S]*attachModalEscape\(explorePanel/);
    expect(appJs).toMatch(/closeExplorePanel[\s\S]*closeModalA11y\(explorePanel/);
    expect(appJs).toMatch(/helpBtn\?\.addEventListener[\s\S]*attachModalEscape\(helpPanel/);
    expect(appJs).toMatch(/function closeHelpPanel[\s\S]*closeModalA11y\(helpPanel/);
  });

  test("focus trap cyles Tab inside the modal", () => {
    // Smoke-check: installModalA11y should add a Tab keydown listener
    // that wraps focus from first↔last. We don't run it here — this
    // just asserts the code path is present.
    const installFn = appJs.match(/function installModalA11y\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    expect(installFn).not.toBeNull();
    expect(installFn[1]).toMatch(/(?:key\s*===\s*["']Tab["']|key\s*!==\s*["']Tab["'])/);
    expect(installFn[1]).toMatch(/shiftKey/);
    expect(installFn[1]).toMatch(/last\.focus\(\)/);
    expect(installFn[1]).toMatch(/first\.focus\(\)/);
  });
});