// mobile-bottom-bar.bun.test.js — Static-analysis checks for the mobile
// bottom-bar accessibility redesign (Audit 4 — UX/a11y).
//
// Gates CI on the most impactful invariants so regressions can't sneak in:
//   - WCAG 2.5.5: every button inside #bottom-bar declares a 44×44 floor
//     in the @media (max-width: 720px) block of styles.css
//   - Accessible names: every <button> in #bottom-bar has either text
//     content, aria-label, or aria-labelledby
//   - Keyboard-hide: styles.css has a #bottom-bar.keyboard-open rule and
//     app.js wires a visualViewport/resize listener that toggles the class
//   - iOS safe-area: bottom-bar respects env(safe-area-inset-bottom)
//   - #share-btn has an aria-label (was previously title-only)
//
// Pairs with a11y.bun.test.js — which audits global focus/button-name
// rules — and the browser-side runtime checks in a11y.test.js.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");

// Slice out ALL @media (max-width: 720px) { ... } blocks from styles.css.
// The bottom-bar redesign lives in a second block that comes AFTER the
// existing .explore-btn/.help-btn/.share-btn rules — so we concat every
// matching block rather than just the first.
function sliceAllMediaBlocks(css, query) {
  const escaped = query.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
  const startRe = new RegExp(`@media\\s*\\(${escaped}\\)\\s*\\{`, "g");
  const blocks = [];
  let m;
  while ((m = startRe.exec(css)) !== null) {
    let depth = 0;
    let i = css.indexOf("{", m.index);
    for (; i < css.length; i++) {
      const c = css[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          blocks.push(css.slice(m.index, i + 1));
          break;
        }
      }
    }
  }
  return blocks.join("\n");
}

const mobileBlock = sliceAllMediaBlocks(stylesCss, "max-width: 720px");

describe("mobile bottom-bar — WCAG 2.5.5 touch targets", () => {
  test("@media (max-width: 720px) exists in styles.css", () => {
    expect(mobileBlock.length).toBeGreaterThan(0);
  });

  test("#bottom-bar button min-height is at least 44px on mobile", () => {
    // The min-height: 44px rule must apply to buttons inside #bottom-bar.
    // The bottom-bar redesign switched the selector from `button` to the
    // `.bar-btn` class (every bar button carries it), so accept either.
    expect(mobileBlock).toMatch(/#bottom-bar[\s\S]*?(?:button|\.bar-btn)[\s\S]*?min-height\s*:\s*44px/);
  });

  test("#bottom-bar button min-width is at least 44px on mobile", () => {
    expect(mobileBlock).toMatch(/#bottom-bar[\s\S]*?(?:button|\.bar-btn)[\s\S]*?min-width\s*:\s*44px/);
  });

  test("bottom-bar padding includes safe-area-inset-bottom", () => {
    // iOS home indicator / Android gesture bar clearance.
    expect(stylesCss).toMatch(/#bottom-bar[\s\S]{0,200}env\(safe-area-inset-bottom\)/);
  });
});

describe("mobile bottom-bar — keyboard hide", () => {
  test("#bottom-bar.keyboard-open rule exists in styles.css", () => {
    // The class is toggled by app.js when the visual viewport shrinks.
    expect(stylesCss).toMatch(/#bottom-bar\.keyboard-open\s*\{[\s\S]*?(translate\s*:|transform\s*:\s*translate)\(/);
  });

  test("app.js wires a visualViewport OR resize listener for the bottom-bar", () => {
    // The handler should reference both #bottom-bar and visualViewport
    // (preferred) or fall back to window.resize on older browsers.
    const setupMatch = appJs.match(
      /setupBottomBarKeyboardHide[\s\S]*?\}\s*\)\s*;/
    );
    expect(setupMatch).not.toBeNull();
    const body = setupMatch ? setupMatch[0] : "";
    expect(body).toMatch(/visualViewport|window\.addEventListener\(\s*["']resize["']/);
    expect(body).toMatch(/keyboard-open/);
  });
});

describe("mobile bottom-bar — accessible names", () => {
  test("every button inside #bottom-bar has text, aria-label, or aria-labelledby", () => {
    // Slice just the bottom-bar block out of index.html.
    const start = indexHtml.indexOf('<div id="bottom-bar">');
    const end = indexHtml.indexOf("</div><!-- /bottom-bar -->");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = indexHtml.slice(start, end);

    const buttonRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    const offenders = [];
    let m;
    while ((m = buttonRe.exec(block)) !== null) {
      const attrs = m[1];
      const body = m[2].trim();
      // Strip child tags — what remains is text content.
      const textOnly = body.replace(/<[^>]+>/g, "").trim();
      const hasAriaLabel = /\baria-label=/.test(attrs);
      const hasAriaLabelledBy = /\baria-labelledby=/.test(attrs);
      if (textOnly === "" && !hasAriaLabel && !hasAriaLabelledBy) {
        offenders.push(m[0].slice(0, 120));
      }
    }
    if (offenders.length) {
      console.warn("[mobile-bottom-bar] Buttons without accessible name:");
      offenders.forEach((o) => console.warn("  -", o));
    }
    expect(offenders.length).toBe(0);
  });

  // The #share-btn was removed from the bottom bar in commit 0060b0d
  // ("chore: remove Reload and Share buttons from bottom bar") — the
  // URL hash already encodes the whole view, so the address bar IS the
  // share link. The generic every-button-has-a-name test above still
  // covers whatever buttons remain.
});