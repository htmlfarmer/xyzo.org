/**
 * /api/pins — the FUZZY BRANCH is word similarity, not whole-string
 * similarity.
 *
 * Measured 2026-11-11 on the live corpus (3,796,777 articles): the old
 * branch was
 *
 *   (a.title % t AND similarity(a.title, t) > 0.3) OR (a.summary % …)
 *
 * and it cost **25,463 ms** for the WHERE alone — the trigram index
 * returned 1,149,700 index tuples and 584,762 heap rechecks to produce
 * 1,584 rows, and the whole statement read 397,043 buffers (3.1 GB of
 * I/O). The reason: `similarity()` compares the WHOLE title with the
 * query, so a five-letter word can only reach 0.3 against a SHORT
 * title, and the index scan for it starts from the query's three
 * trigrams — which match a sixth of the corpus.
 *
 * Word similarity (`a.title %> t`) compares the query with a WORD in
 * the title: **102 ms**, and it is the better rule as well — it finds
 * "Chinese companies bag contracts…" for "china" and "Japanese
 * President" for "japan", which the substring rule misses entirely
 * ("chinese" does not contain "china").
 *
 * Measured over the real query mix the switch loses 0–3 rows per query
 * and gains up to 10,961 (every one of them about China). The rows it
 * loses are junk — for "tokyo" they were two articles titled "Tok tok
 * tok".
 *
 * This test pins the rule AND the threshold: the operator reads
 * `pg_trgm.word_similarity_threshold` from a per-CONNECTION GUC, so the
 * value has to be set explicitly on the connection that runs the query,
 * or a server whose default had been changed would silently change every
 * search.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { Hono } from "hono";
import { pinsRoute } from "../src/routes/pins";
import { searchCache, pinsCache } from "../src/cache";
import { getDb } from "../src/db";

const sql = getDb();
const app = new Hono();
app.route("/api", pinsRoute);

const pinsSrc = readFileSync(join(import.meta.dir, "..", "src", "routes", "pins.ts"), "utf8");

async function seed() {
  const feed = `https://wordsim.test.invalid/${Math.random().toString(36).slice(2)}`;
  const [src] = await sql<{ id: number }[]>`
    INSERT INTO news_sources (name, feed_url, source_type, country, active)
    VALUES ('ZZ Word Similarity Test', ${feed}, 'rss', 'US', TRUE)
    RETURNING id
  `;
  const sid = Number(src.id);
  const mk = async (title: string) => {
    await sql`
      INSERT INTO news_articles (title, url, source_id, status, hidden_at,
                                 extracted_lat, extracted_lng, fetched_at, published_at, event_type)
      VALUES (${title}, ${"https://wordsim.test.invalid/" + title.replace(/\s+/g, "-")},
              ${sid}, 'extracted', NULL, 39.9, 116.4, now(), now(), 'politics')
    `;
  };
  // The word itself.
  await mk("China and the United States agree to reopen the trade talks");
  // The nationality — "chinese" does NOT contain "china", so the old
  // substring rule missed it entirely.
  await mk("Chinese electric vehicle makers expand into Europe");
  // A near-word (one letter off) — the old rule caught this in a SHORT
  // title, the new one does not (see the test below: it is the
  // deliberate trade).
  await mk("Officials in Beijng were not available for comment");
  // Nothing to do with the query.
  await mk("Local council approves a new park in the north of the city");
  // The search keeps ONE article per event, and an article that belongs
  // to no event is kept one per LOCATION (the partition is
  // COALESCE(event_id, location_id)) — so two seeded articles that land
  // on the same location would collapse into one and the test would be
  // testing the partition, not the matcher. Each article therefore gets
  // its own location row.
  const locs: number[] = [];
  for (const name of ["Testville One", "Testville Two", "Testville Three", "Testville Four"]) {
    const [l] = await sql<{ id: number }[]>`
      INSERT INTO news_locations (place_name, place_name_normalized, country, lat, lng, precision,
                                  geom)
      VALUES (${name}, ${name.toLowerCase()}, 'US', 39.9, 116.4, 'city',
              ST_SetSRID(ST_MakePoint(116.4, 39.9), 4326)::geography)
      RETURNING id
    `;
    locs.push(Number(l.id));
  }
  const titles = [
    "China and the United States agree to reopen the trade talks",
    "Chinese electric vehicle makers expand into Europe",
    "Officials in Beijng were not available for comment",
    "Local council approves a new park in the north of the city",
  ];
  for (let i = 0; i < titles.length; i++) {
    await sql`UPDATE news_articles SET location_id = ${locs[i]} WHERE title = ${titles[i]}`;
  }
  searchCache.clear();
  pinsCache.clear();
  return sid;
}

describe("the fuzzy branch of the text search", () => {
  beforeEach(async () => {
    // A TARGETED cleanup, not truncateAll(). The full TRUNCATE cascades
    // to ~80 tables and measured 15 s on a loaded box — more than the
    // 5 s hook budget, and the failure looks like a broken test rather
    // than a busy machine. This test owns its rows, so it deletes
    // exactly those.
    await sql`DELETE FROM news_articles WHERE url LIKE 'https://wordsim.test.invalid/%'`;
    await sql`DELETE FROM news_locations WHERE place_name_normalized LIKE 'testville %'`;
    await sql`DELETE FROM news_sources WHERE feed_url LIKE 'https://wordsim.test.invalid/%'`;
    await seed();
  });

  test("the branch is WORD similarity, not whole-string similarity", () => {
    // A source pin: the shape of the predicate is what made the search
    // 250× slower, and a regression here would be invisible in a
    // functional test.
    expect(pinsSrc).toMatch(/a\.title %> \$\{t\} OR a\.summary %> \$\{t\}/);
    expect(pinsSrc).not.toMatch(/similarity\(a\.title/);
    expect(pinsSrc).not.toMatch(/similarity\(a\.summary/);
  });

  test("the threshold is set EXPLICITLY on the connection that runs the query", () => {
    // The operator reads a per-CONNECTION GUC. A plain SET on the pool
    // could land on a different connection than the query.
    expect(pinsSrc).toMatch(/set_config\('pg_trgm\.word_similarity_threshold'/);
    expect(pinsSrc).toMatch(/set_config\('plan_cache_mode', 'force_custom_plan'/);
  });

  test("'china' finds the CHINESE articles — the word the substring rule missed", async () => {
    const res = await app.request("/api/pins?q=china&limit=50");
    expect(res.status).toBe(200);
    const body = await res.json();
    const titles = body.pins.map((p: any) => p.title);
    expect(titles.some((t: string) => t.includes("China and the United States"))).toBe(true);
    expect(
      titles.some((t: string) => t.includes("Chinese electric vehicle")),
      "the nationality is the same story and the old rule missed it",
    ).toBe(true);
    expect(titles.some((t: string) => t.includes("new park"))).toBe(false);
  });

  test("the trade: a CHARACTER TYPO in a short title is no longer matched", async () => {
    // The old rule was a WHOLE-STRING similarity, so "Beijng" reached
    // 0.57 against "beijing" and was matched — in a short title only,
    // because a long title cannot reach 0.3 against a nine-letter word.
    // Word similarity compares the query with a WORD in the title, so a
    // typo inside the word is not caught.
    //
    // This is the deliberate side of the change, and it is small: over
    // the real query mix the switch loses 0-3 rows per query, and the
    // rows it loses are exactly these. What it GAINS is the word
    // variants ("Chinese" for "china") — thousands of rows per query.
    const res = await app.request("/api/pins?q=beijing&limit=50");
    expect(res.status).toBe(200);
    const body = await res.json();
    const titles = body.pins.map((p: any) => p.title);
    expect(titles.some((t: string) => t.includes("Beijng"))).toBe(false);
  });
});
