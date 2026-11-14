/**
 * /api/pins — a SHORT query must match a WHOLE WORD.
 *
 * Reported 2026-11-09: searching "ai" found the articles and then showed
 * a map of articles about nothing in particular, because the query
 * matched the LETTERS "ai" wherever they appeared. The reader's words:
 * *"the stories dont seem to be related mostly becuase the ltters ai
 * show up not ARTIFICIAL INTELLIGENCE"*.
 *
 * The pin search matched a bare substring (ILIKE '%ai%'), so it answered
 * with every title containing those two letters anywhere. Measured on the
 * corpus (2.99 M articles): **558,168** titles contain the letters "ai"
 * somewhere; **59,100** contain the WORD; the other **499,582** are the
 * noise — "said", "rain", "air", "detail", "campaign", "again".
 *
 * The rule (api/src/lib/wordmatch.ts): a term of ≤ 3 characters matches
 * a whole word (\m…\M, the same rule the EVENT search has always used);
 * a longer term keeps the substring match, because "coronavirus" must
 * still find "coronaviruses".
 *
 * This test seeds three articles and asks the real route.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Hono } from "hono";
import { pinsRoute } from "../src/routes/pins";
import { truncateAll } from "./helpers";
import { searchCache, pinsCache } from "../src/cache";
import { getDb } from "../src/db";
import { wordBoundaryPattern, isShortTerm } from "../src/lib/wordmatch";

const sql = getDb();
const app = new Hono();
app.route("/api", pinsRoute);

async function seed() {
  const [src] = await sql<{ id: number }[]>`
    INSERT INTO news_sources (name, feed_url, source_type, country, active)
    VALUES ('ZZ Word Match Test', 'https://wordmatch.test.invalid/feed', 'rss', 'US', TRUE)
    RETURNING id
  `;
  const sid = Number(src.id);
  const mk = async (title: string) => {
    await sql`
      INSERT INTO news_articles (title, url, source_id, status, hidden_at,
                                 extracted_lat, extracted_lng, fetched_at, published_at, event_type)
      VALUES (${title}, ${"https://wordmatch.test.invalid/" + title.replace(/\s+/g, "-")},
              ${sid}, 'extracted', NULL, 37.35, -121.95, now(), now(), 'technology')
    `;
  };
  // The word.
  await mk("Nvidia unveils a new AI chip for data centres");
  // The letters, inside other words.
  await mk("Minister said the heavy rain would ease by morning");
  await mk("Campaigners claim the campaign trail was badly designed");
  // No "ai" at all.
  await mk("Local council approves a new park");
  searchCache.clear();
  pinsCache.clear();
  return sid;
}

async function cleanupSource(sid: number) {
  await sql`DELETE FROM news_articles WHERE source_id = ${sid}`;
  await sql`DELETE FROM news_sources WHERE id = ${sid}`;
  searchCache.clear();
  pinsCache.clear();
}

describe("the word-boundary matcher", () => {
  test("a short term needs the boundary, a longer one does not", () => {
    expect(isShortTerm("ai")).toBe(true);
    expect(isShortTerm("eu")).toBe(true);
    expect(isShortTerm("ram")).toBe(true);
    expect(isShortTerm("bank")).toBe(false);
    expect(isShortTerm("climate")).toBe(false);
    expect(isShortTerm("artificial intelligence")).toBe(false);
  });

  test("the pattern is a PostgreSQL word boundary", () => {
    expect(wordBoundaryPattern("ai")).toBe("\\mai\\M");
    // A term with regex metacharacters must be escaped, not executed.
    expect(wordBoundaryPattern("a.b")).toBe("\\ma\\.b\\M");
  });
});

describe("GET /api/pins?q=ai — the whole word, not the letters", () => {
  beforeEach(async () => {
    await truncateAll();
    searchCache.clear();
    pinsCache.clear();
  }, 30_000);

  test("the AI story is found and the 'said the rain' story is not", async () => {
    const sid = await seed();
    try {
      const res = await app.request("/api/pins?q=ai&limit=50");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const titles = (body.pins || []).map((p: any) => p.title);

      expect(titles.join(" | ")).toContain("Nvidia unveils a new AI chip");
      expect(
        titles,
        "a title matched on the LETTERS 'ai' inside 'said'/'rain'/'campaign'",
      ).not.toContain("Minister said the heavy rain would ease by morning");
      expect(titles).not.toContain("Campaigners claim the campaign trail was badly designed");
      expect(titles).not.toContain("Local council approves a new park");
    } finally {
      await cleanupSource(sid);
    }
  }, 60_000);
});
