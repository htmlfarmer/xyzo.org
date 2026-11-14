/**
 * /api/tags/top — a structural ARTEFACT is not a topic.
 *
 * The extractor's system prompt used to show the model this shape:
 *
 *     "topic_tags": ["3-6", "short", "topic", "tags"]
 *
 * and a great many models copied it VERBATIM: those four words are
 * literal tags on thousands of articles ("3-6" 2,741 · "short" 1,482 ·
 * "tags" 1,395 · "topic" 1,265). The chip bar offered a chip labelled
 * "topic", and a reader who clicked it got a map of articles about
 * nothing in particular — which is exactly what it looks like.
 *
 * The prompt no longer shows a copyable example (worker/extract.py) and
 * the extractor strips the words before writing them, but the rows
 * already in the table stay, so the ROUTE filters them: the chip bar is
 * the reader's door into the vocabulary and it must not offer a word
 * that names nothing.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Hono } from "hono";
import { tagsRoute } from "../src/routes/tags";
import { truncateAll } from "./helpers";
import { getDb } from "../src/db";

const sql = getDb();
const app = new Hono();
app.route("/api", tagsRoute);

async function seed() {
  const [src] = await sql<{ id: number }[]>`
    INSERT INTO news_sources (name, feed_url, source_type, country, active)
    VALUES ('ZZ Tags Test', 'https://tagstest.test.invalid/feed', 'rss', 'US', TRUE)
    RETURNING id
  `;
  const sid = Number(src.id);
  const [loc] = await sql<{ id: number }[]>`
    INSERT INTO news_locations (place_name, place_name_normalized, country, lat, lng,
                                precision, confidence, geom)
    VALUES ('Testville', 'testville', 'US', 37.35, -121.95, 'city', 1,
            ST_SetSRID(ST_MakePoint(-121.95, 37.35), 4326))
    RETURNING id
  `;
  const lid = Number(loc.id);
  await sql`
    INSERT INTO news_articles (title, url, source_id, status, hidden_at,
                               extracted_lat, extracted_lng, fetched_at, published_at,
                               event_type, topic_tags, location_id)
    VALUES ('A story with real and structural tags',
            'https://tagstest.test.invalid/story', ${sid}, 'extracted', NULL,
            37.35, -121.95, now(), now(), 'technology',
            ARRAY['politics', 'topic', 'tags', 'short', '3-6'], ${lid})
  `;
  return sid;
}

async function cleanupSource(sid: number) {
  await sql`DELETE FROM news_articles WHERE source_id = ${sid}`;
  await sql`DELETE FROM news_sources WHERE id = ${sid}`;
}

describe("GET /api/tags/top — the structural artefacts are filtered", () => {
  beforeEach(async () => {
    await truncateAll();
  }, 30_000);

  test("a real topic is offered and the artefacts are not", async () => {
    const sid = await seed();
    try {
      const res = await app.request("/api/tags/top?limit=50");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const names = (body.tags || []).map((t: any) => String(t.name).toLowerCase());

      expect(names).toContain("politics");
      for (const junk of ["topic", "tags", "short", "3-6"]) {
        expect(
          names,
          `the chip bar offered "${junk}", which names no topic at all`,
        ).not.toContain(junk);
      }
    } finally {
      await cleanupSource(sid);
    }
  }, 60_000);
});
