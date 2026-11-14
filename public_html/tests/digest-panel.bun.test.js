// digest-panel.bun.test.js — static contract checks for the daily digest
// panel (public_html/digest-panel.js + the API route that feeds it).

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const panelJs = readFileSync(join(ROOT, "digest-panel.js"), "utf8");
const indexHtml = readFileSync(join(ROOT, "index.html"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");

const REPO = join(ROOT, "..");
const digestRoute = readFileSync(join(REPO, "api", "src", "routes", "digest.ts"), "utf8");
const serverTs = readFileSync(join(REPO, "api", "src", "server.ts"), "utf8");

describe("digest panel — wiring", () => {
  test("digest-panel.js is loaded by index.html", () => {
    expect(indexHtml).toMatch(/<script[^>]+src="digest-panel\.js[^"]*"\s+defer><\/script>/);
  });

  test("the panel and its control-menu button exist", () => {
    expect(indexHtml).toMatch(/id="digest-panel"/);
    expect(indexHtml).toMatch(/id="digest-close"/);
    expect(indexHtml).toMatch(/id="ctrl-digest-btn"/);
  });

  test("the panel is hidden until it is opened", () => {
    expect(indexHtml).toMatch(/id="digest-panel"[^>]*hidden/);
  });

  test("panel styles exist", () => {
    expect(stylesCss).toMatch(/\.digest-panel\s*\{/);
    expect(stylesCss).toMatch(/\.digest-story\s*\{/);
    expect(stylesCss).toMatch(/\.digest-cat--/);
  });

  test("the panel escapes the content it renders", () => {
    // Headlines come from the model and from third-party sources.
    expect(panelJs).toMatch(/function esc\(/);
    expect(panelJs).not.toMatch(/innerHTML\s*=\s*`\s*\$\{[^}]*headline/);
  });

  test("the panel reads the digest API", () => {
    expect(panelJs).toMatch(/"\/api\/digest\/today"/);
  });
});

describe("digest API — route", () => {
  test("the route is registered", () => {
    expect(serverTs).toMatch(/import \{ digestRoute \} from "\.\/routes\/digest"/);
    expect(serverTs).toMatch(/app\.route\("\/api", digestRoute\)/);
  });

  test("the route serves the digest and a status", () => {
    expect(digestRoute).toMatch(/digestRoute\.get\("\/digest\/today"/);
    expect(digestRoute).toMatch(/digestRoute\.get\("\/digest\/status"/);
  });

  test("the list endpoints follow the { items, count } contract", () => {
    // /api/digest/today returns { stories, count } — the repo's list shape.
    expect(digestRoute).toMatch(/stories:[\s\S]{0,80}count:/);
  });

  test("the route never throws when the digest is missing", () => {
    expect(digestRoute).toMatch(/available: false/);
  });
});

describe("digest pipeline — worker modules", () => {
  test("the digest engine and the renderer exist", () => {
    expect(existsSync(join(REPO, "worker", "daily_digest.py"))).toBe(true);
    expect(existsSync(join(REPO, "worker", "digest_render.py"))).toBe(true);
    expect(existsSync(join(REPO, "worker", "digest_upload.py"))).toBe(true);
    expect(existsSync(join(ROOT, "digest-render.html"))).toBe(true);
  });

  test("the render page can toggle its title card and lower third", () => {
    const page = readFileSync(join(ROOT, "digest-render.html"), "utf8");
    expect(page).toMatch(/window\.renderTitle/);
    expect(page).toMatch(/window\.renderStory/);
    // `hidden` must beat the id-level `display:flex`, or the title card
    // covers every frame.
    expect(page).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  test("the uploader refuses to upload without credentials", () => {
    const up = readFileSync(join(REPO, "worker", "digest_upload.py"), "utf8");
    expect(up).toMatch(/YOUTUBE_REFRESH_TOKEN/);
    expect(up).toMatch(/refusing to upload/);
  });
});
