import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Structural smoke test for WCAG 2.1 AA landmarks (A-01..A-03).
// We don't load the page in a browser — we just assert the invariants
// that a future refactor could silently break.
const REPO_ROOT = join(import.meta.dir, "..");
const HTML_PATH = join(REPO_ROOT, "public_html", "index.html");

const html = readFileSync(HTML_PATH, "utf8");

function extractBody(src: string): string {
  const m = src.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!m) throw new Error("<body> not found in index.html");
  return m[1] ?? "";
}

function findFirstTag(src: string, tag: string): { open: number; close: number } | null {
  const openRe = new RegExp(`<${tag}\\b`, "i");
  const open = src.search(openRe);
  if (open === -1) return null;
  return { open, close: open + tag.length + 1 };
}

describe("a11y landmarks (A-01..A-03)", () => {
  const body = extractBody(html);

  test("A-02: skip link is the first <a> element in <body>", () => {
    const firstA = findFirstTag(body, "a");
    expect(firstA).not.toBeNull();
    if (!firstA) return;
    const slice = body.slice(firstA.open, body.indexOf("</a>", firstA.open) + 4);
    expect(slice).toMatch(/class=["']skip-link["']/);
    expect(slice).toMatch(/href=["']#main-content["']/);
    expect(slice).toMatch(/Skip to main content/i);
  });

  test("A-02: skip link appears before any other focusable element", () => {
    // The first focusable candidate in <body> must be the skip link.
    // Anything earlier would steal focus on Tab and defeat WCAG 2.4.1.
    const skipIdx = body.search(/<a\b[^>]*class=["']skip-link["']/i);
    expect(skipIdx).toBeGreaterThanOrEqual(0);
    // Look for any earlier focusable element: <a, <button, <input, <select, <textarea.
    const earlierFocusable = body
      .slice(0, skipIdx)
      .match(/<(a|button|input|select|textarea|summary)\b/i);
    expect(earlierFocusable).toBeNull();
  });

  test("A-01: exactly one <main> element exists", () => {
    const mainOpens = html.match(/<main\b/gi) ?? [];
    const mainCloses = html.match(/<\/main>/gi) ?? [];
    expect(mainOpens.length).toBe(1);
    expect(mainCloses.length).toBe(1);
  });

  test("A-01: <main> carries id=\"main-content\" and role=\"main\"", () => {
    const mainMatch = html.match(/<main\b[^>]*>/i);
    expect(mainMatch).not.toBeNull();
    if (!mainMatch) return;
    const tag = mainMatch[0];
    expect(tag).toMatch(/id=["']main-content["']/);
    expect(tag).toMatch(/role=["']main["']/);
  });

  test("A-03: map element has role=\"application\" and an aria-label", () => {
    // Leaflet binds to #map; that node must declare application role.
    const mapMatch = html.match(/<div\b[^>]*\bid=["']map["'][^>]*>/i);
    expect(mapMatch).not.toBeNull();
    if (!mapMatch) return;
    const tag = mapMatch[0];
    expect(tag).toMatch(/role=["']application["']/);
    const labelMatch = tag.match(/aria-label=["']([^"']+)["']/i);
    expect(labelMatch).not.toBeNull();
    if (!labelMatch) return;
    const label = labelMatch[1] ?? "";
    // Must describe the actual keyboard controls so AT users know how to operate it.
    expect(label).toMatch(/arrow/i);
    expect(label).toMatch(/plus|minus|zoom/i);
  });

  test("skip-link CSS rule exists in styles.css", () => {
    const cssPath = join(REPO_ROOT, "public_html", "styles.css");
    const css = readFileSync(cssPath, "utf8");
    expect(css).toMatch(/\.skip-link\b/);
    expect(css).toMatch(/\.skip-link:focus\b/);
  });
});
