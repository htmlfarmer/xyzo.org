// popup-related-stories.bun.test.js — the related stories are LINKS.
//
// Owner report: *"when someone checked for 'related stories' we need to
// be able to click on them and immediately go to the website that is
// linked or related."*
//
// A reader who opens the tree wants the STORY. The tree API already
// carries each article's `url` (the publisher's own page) — it was in
// the payload all along, and the popup rendered the headline as plain
// text with a click that FLEW THE MAP instead. So the link was there
// and was not used.
//
// THE TWO ACTIONS ARE BOTH KEPT: the headline goes to the publisher
// (target=_blank, so the map stays), and the ◎ button beside it is the
// move on the map — so clicking a row that has no coordinates still
// does something sensible rather than nothing.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");

describe("the related stories go to the article", () => {
  test("the sibling and the related item both carry the URL", () => {
    // `url` is the article's own page — the tree API returns it
    // (story-tree.ts: `url: pin.canonical_url || null`).
    expect(appJs).toMatch(/safeHttpUrl\(s\.url \|\| ""\)/);
    expect(appJs).toMatch(/safeHttpUrl\(c\.url \|\| ""\)/);
  });

  test("the headline is a link that opens in a new tab", () => {
    expect(appJs).toMatch(/class="popup-tree-sib-title popup-tree-link"/);
    expect(appJs).toMatch(/class="popup-tree-link"/);
    expect(appJs).toMatch(/target="_blank" rel="noopener noreferrer"/);
  });

  test("the URL is escaped, not pasted raw", () => {
    // A feed URL carrying a double quote injected attributes into every
    // viewer's popup once before (the popup's own history says so).
    expect(appJs).toMatch(/href="\$\{escapeAttr\(url\)\}"/);
  });

  test("the map move is kept, on a button of its own", () => {
    expect(appJs).toMatch(/popup-tree-locate/);
    expect(appJs).toMatch(/Show it on the map/);
    // And a click on the LINK is not also a camera move.
    expect(appJs).toMatch(/closest\("a"\)\) return;/);
  });

  test("the links look like links", () => {
    expect(stylesCss).toMatch(/\.popup-tree-link\s*\{[^}]*cursor:\s*pointer/);
    expect(stylesCss).toMatch(/\.popup-tree-link:hover/);
  });
});
