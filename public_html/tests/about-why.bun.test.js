// about-why.bun.test.js — the WHY page, and how it is allowed to speak.
//
// The site answers a question it is asked constantly — *why does this
// exist?* — and the answer that came back was personal: the founder
// read a map of the world in the mineral rings of Grand Prismatic
// Spring, and came home with two rules. A map that changes, and be
// careful where you bring electronics.
//
// The EDITORIAL RULE THIS PINS: **the account is ATTRIBUTED, never
// asserted as fact.** The site says plainly that nobody has the map of
// the universe ("anyone who says they do is selling something"), and
// the founder's own words are carried as HIS words. The private parts
// of the story are not published: a public page is not the place for
// someone's worst night, and the map is the part that belongs to
// everyone.
//
// Pinned because the temptation, on a page that ends with a person
// saying "trust me", is to let the cosmology harden into a claim the
// site cannot support — and the whole commitment of this project is
// that what it shows is checkable.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const aboutHtml = readFileSync(join(ROOT, "about.html"), "utf8");

describe("the about page carries the why", () => {
  test("the story of one of the three maps is on the page", () => {
    expect(aboutHtml).toMatch(/Why — the story of one of the three maps/);
    expect(aboutHtml).toMatch(/Grand Prismatic Spring/);
    expect(aboutHtml).toMatch(/A map that can change/);
    expect(aboutHtml).toMatch(/Be careful where you bring electronics/);
  });

  test("the account is ATTRIBUTED, not asserted", () => {
    // It is the founder's account, in his words — not the site's claim
    // about the universe.
    expect(aboutHtml).toMatch(/The founder's account, in his own words/);
    expect(aboutHtml).toMatch(/<em>"I always respect math and science"<\/em>/);
  });

  test("the honest answer to 'do we now have THE MAP?' is on the page", () => {
    expect(aboutHtml).toMatch(/Not the map of the universe/);
    expect(aboutHtml).toMatch(/selling something/);
    // And the map that DOES exist is named concretely.
    expect(aboutHtml).toMatch(/the map of <em>today<\/em>/);
  });

  test("the account can be CHECKED, not just believed", () => {
    // The coordinates of the spring and the reference for the geyser
    // basins are on the page: the story is grounded in something anyone
    // can look up, which is the same commitment the rest of the site
    // makes.
    expect(aboutHtml).toMatch(/geohack\.toolforge\.org/);
    expect(aboutHtml).toMatch(/44\.5250489/);
    expect(aboutHtml).toMatch(/Geothermal_areas_of_Yellowstone/);
  });

  test("the three maps are grounded in what the site actually has", () => {
    expect(aboutHtml).toMatch(/The ground/);
    expect(aboutHtml).toMatch(/The globe/);
    expect(aboutHtml).toMatch(/The web/);
    // The globe is a real control on the map, not a metaphor.
    expect(aboutHtml).toMatch(/press the 🌐 button on the zoom bar/);
  });

  test("the private parts of the story are not published", () => {
    // A public page is not the place for someone's worst night. The map
    // is the part that belongs to everyone.
    expect(aboutHtml).not.toMatch(/homeless/i);
    expect(aboutHtml).not.toMatch(/being homeless/i);
  });

  test("the crawler ethics are tied to the founder's own rule", () => {
    // "We really need to learn to be more wise about where we bring
    // electronics and what we take photos of" — and the same courtesy
    // towards publishers is the site's own crawling rule.
    expect(aboutHtml).toMatch(/robots\.txt/);
    expect(aboutHtml).toMatch(/do not take more than you need/);
  });
});
