// a11y.test.js — Static checks for WCAG-related issues in the
// frontend. Runs in the browser test harness (loaded from
// public_html/tests/index.html). The Bun-side runner in
// a11y.bun.test.js exercises the same checks from Node so the build
// can gate on them without a browser.
//
// Each test logs the issue count but does not throw, since not all
// violations are equal: decorative icons, hidden inputs, and the test
// runner's own buttons are intentionally excluded. The summary line
// is what gets read by humans, not pass/fail counts.

(function () {
  "use strict";

  // ── Helpers ─────────────────────────────────────────────────────
  function findButtons(el) {
    return Array.from(el.querySelectorAll("button"));
  }

  function visibleText(el) {
    // Concatenate text nodes; ignore aria-hidden descendants.
    let out = "";
    el.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) out += node.textContent;
      else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.getAttribute("aria-hidden") === "true") return;
        out += visibleText(node);
      }
    });
    return out.trim();
  }

  function isDecorative(el) {
    // Pure-icon span/divs with role="img" + aria-label are valid; with
    // aria-hidden="true" they're decorative and skipped.
    if (el.getAttribute("aria-hidden") === "true") return true;
    return false;
  }

  function isExcluded(el) {
    // Skip buttons that belong to the test runner or are hidden.
    if (el.id === "run-btn") return true;
    if (el.closest('[hidden]')) return true;
    return false;
  }

  // ── Test suites ─────────────────────────────────────────────────
  const suites = [];

  suites.push({
    name: "Icon-only buttons have accessible names",
    run() {
      const buttons = findButtons(document);
      const offenders = [];
      buttons.forEach((btn) => {
        if (isExcluded(btn)) return;
        const text = visibleText(btn);
        const aria = btn.getAttribute("aria-label");
        const labelledby = btn.getAttribute("aria-labelledby");
        if (text === "" && !aria && !labelledby) {
          offenders.push(btn.id || btn.outerHTML.slice(0, 80));
        }
      });
      return {
        passed: offenders.length === 0,
        summary: offenders.length === 0
          ? `All ${button ? buttons.length : 0} interactive buttons have a name.`
          : `Found ${offenders.length} icon-only button(s) without an accessible name: ${offenders.slice(0, 5).join(", ")}`,
      };
    },
  });

  suites.push({
    name: "Modal/dialog elements use role=dialog + aria-modal",
    run() {
      const expected = ["explore-panel", "help-panel", "submitter-overlay"];
      const issues = [];
      expected.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return; // not on this page (some tests load a subset)
        if (el.getAttribute("role") !== "dialog") issues.push(`${id}: missing role="dialog"`);
        if (el.getAttribute("aria-modal") !== "true") issues.push(`${id}: missing aria-modal="true"`);
      });
      return {
        passed: issues.length === 0,
        summary: issues.length === 0
          ? "All expected modal panels declare role=dialog + aria-modal."
          : `Found ${issues.length} modal(s) missing dialog role: ${issues.join("; ")}`,
      };
    },
  });

  suites.push({
    name: "Close-only icon buttons declare aria-label",
    run() {
      // Buttons whose entire visible payload is the close glyph ×
      const reText = /^[\s×✕✖✗✘✕×]+$/;
      const offenders = [];
      document.querySelectorAll('button[aria-label=""], button:not([aria-label])').forEach((btn) => {
        if (isExcluded(btn)) return;
        const text = visibleText(btn);
        if (reText.test(text)) {
          offenders.push(btn.id || btn.outerHTML.slice(0, 80));
        }
      });
      return {
        passed: offenders.length === 0,
        summary: offenders.length === 0
          ? "All × close buttons have aria-label."
          : `Found ${offenders.length} close-button(s) without aria-label: ${offenders.join(", ")}`,
      };
    },
  });

  suites.push({
    name: "Form <input>s have an associated <label> or aria-label",
    run() {
      const issues = [];
      document.querySelectorAll("input, select, textarea").forEach((el) => {
        if (isExcluded(el)) return;
        if (el.type === "hidden") return;
        if (el.getAttribute("aria-hidden") === "true") return;
        if (el.closest('[hidden]')) return;
        const id = el.id;
        const hasLabel = id && document.querySelector(`label[for="${CSS.escape(id)}"]`);
        const wrapped = el.closest("label") !== null;
        const aria = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
        const placeholder = el.getAttribute("placeholder");
        // Placeholder alone is NOT sufficient — screen readers won't
        // announce it when the field has content — but it's a usable
        // fallback when no label exists. Flag as a soft issue, not hard.
        if (!hasLabel && !wrapped && !aria) {
          issues.push(`${el.tagName.toLowerCase()}${id ? "#" + id : ""} (placeholder=${placeholder ? '"' + placeholder + '"' : "none"})`);
        }
      });
      return {
        passed: issues.length === 0,
        summary: issues.length === 0
          ? "Every form control has an accessible name."
          : `Found ${issues.length} form control(s) without a label: ${issues.slice(0, 5).join("; ")}`,
      };
    },
  });

  // Run + render.
  window.A11yTests = {
    runTests() {
      const results = [];
      suites.forEach((s) => {
        const r = s.run();
        results.push({ name: s.name, ...r });
      });
      let passed = 0, failed = 0;
      results.forEach((r) => (r.passed ? passed++ : failed++));
      console.log("[a11y] " + passed + " passed, " + failed + " flagged");
      results.forEach((r) => console.log(`[a11y] ${r.passed ? "✓" : "✗"} ${r.name}: ${r.summary}`));
      return { passed, failed, results };
    },
  };
})();