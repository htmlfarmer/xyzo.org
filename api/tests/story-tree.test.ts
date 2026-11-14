import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { storyTreeRoute } from "../src/routes/story-tree";
import { getDb, closeDb } from "../src/db";

/**
 * Per-story relationship tree.
 *
 * The invariants that matter:
 *  - a pin resolves to its EVENT, not to one arbitrary article of it
 *  - siblings (same story, other outlets) come back
 *  - related stories are bucketed most → least, and sorted by score
 *  - the whole thing answers well inside the 10s per-click ceiling
 */

const app = new Hono();
app.route("/api", storyTreeRoute);

// The shared `truncateAll` helper takes ~33s (truncating news_articles
// cascades into a dozen tables), and truncating the graph tables cascades
// into nn_event_relationships. This suite instead APPENDS fixtures with
// globally unique ids and removes them afterwards — every query in the
// route is scoped to one event, so leftover rows cannot affect a result.
async function maxId(table: "news_articles" | "news_events" | "news_locations" | "news_sources" | "pins"): Promise<number> {
  const sql = getDb();
  const [row] = await sql<{ id: string }[]>`
    SELECT coalesce(max(id), 0) AS id FROM ${sql(table)}
  `;
  return Number(row.id);
}
let START_ARTICLE_ID = 0;
let START_EVENT_ID = 0;
let START_LOCATION_ID = 0;
let START_SOURCE_ID = 0;
let START_PIN_ID = 0;

let boundsReady = false;

/** Capture the id watermark ONCE, before this suite appends anything. */
async function initBounds() {
  if (boundsReady) return;
  START_ARTICLE_ID = await maxId("news_articles");
  START_EVENT_ID = await maxId("news_events");
  START_LOCATION_ID = await maxId("news_locations");
  START_SOURCE_ID = await maxId("news_sources");
  START_PIN_ID = await maxId("pins");
  boundsReady = true;
}

async function cleanup() {
  const sql = getDb();
  await sql`
    DELETE FROM nn_article_sentence_embeddings WHERE article_id > ${START_ARTICLE_ID}
  `;
  await sql`
    DELETE FROM news_event_sources
    WHERE event_id > ${START_EVENT_ID} OR article_id > ${START_ARTICLE_ID}
  `;
  await sql`DELETE FROM news_story_links
             WHERE source_article_id > ${START_ARTICLE_ID}
                OR target_article_id > ${START_ARTICLE_ID}`;
  await sql`DELETE FROM news_events WHERE id > ${START_EVENT_ID}`;
  await sql`DELETE FROM news_articles WHERE id > ${START_ARTICLE_ID}`;
  await sql`DELETE FROM news_locations WHERE id > ${START_LOCATION_ID}`;
  await sql`DELETE FROM news_sources WHERE id > ${START_SOURCE_ID}`;
  await sql`DELETE FROM pins WHERE id > ${START_PIN_ID}`;
}

async function makeSource(name: string): Promise<number> {
  const sql = getDb();
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO news_sources (name, feed_url, country)
    VALUES (${name}, ${"https://" + name + "-" + Math.random().toString(36).slice(2, 8) + ".example.com/rss"}, 'GB')
    RETURNING id
  `;
  return Number(row.id);
}

let _locSeq = 0;
let _runTag = Math.random().toString(36).slice(2, 8);
async function makeLocation(place: string, country: string, lat: number, lng: number) {
  const sql = getDb();
  // news_locations is append-only in this suite (it has a dedup unique
  // index), so every location gets a unique label.
  const n = ++_locSeq;
  const label = `${place}-${_runTag}-${n}`;
  // The dedup index is (place_name_normalized, round(lat,3), round(lng,3)),
  // so nudge the coordinates as well.
  const lat2 = lat + n * 0.0001;
  const lng2 = lng + n * 0.0001;
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO news_locations (place_name, place_name_normalized, country, lat, lng, precision, geom)
    VALUES (${label}, ${label.toLowerCase()}, ${country}, ${lat2}, ${lng2}, 'city',
            ST_SetSRID(ST_MakePoint(${lng2}, ${lat2}), 4326))
    RETURNING id
  `;
  return Number(row.id);
}

async function makeArticle(
  sourceId: number,
  locationId: number | null,
  title: string,
  opts: { wordFreq?: Record<string, number>; publishedAt?: string } = {},
): Promise<number> {
  const sql = getDb();
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO news_articles (url, title, status, source_id, location_id, published_at, fetched_at, word_freq)
    VALUES (
      ${`https://example.com/${title.replace(/\W+/g, "-").toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`},
      ${title},
      'extracted',
      ${sourceId},
      ${locationId},
      ${opts.publishedAt ?? new Date().toISOString()},
      now(),
      ${(opts.wordFreq ?? null) as any}
    )
    RETURNING id
  `;
  return Number(row.id);
}

async function makeEvent(headline: string, locationId: number | null): Promise<number> {
  const sql = getDb();
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO news_events (primary_location_id, event_type, headline, summary,
                             occurred_at, first_reported_at, source_count, status, relevance_days, expires_at)
    VALUES (${locationId}, 'politics', ${headline}, ${headline + " summary"},
            now(), now(), 1, 'active', 7, now() + interval '7 days')
    RETURNING id
  `;
  return Number(row.id);
}

async function attach(eventId: number, articleId: number) {
  const sql = getDb();
  await sql`
    INSERT INTO news_event_sources (event_id, article_id) VALUES (${eventId}, ${articleId})
    ON CONFLICT DO NOTHING
  `;
}

async function link(a: number, b: number, type: string, strength: number) {
  const sql = getDb();
  await sql`
    INSERT INTO news_story_links (source_article_id, target_article_id, link_type, link_strength, created_by)
    VALUES (${a}, ${b}, ${type}, ${strength}, 'test')
    ON CONFLICT (source_article_id, target_article_id, link_type) DO NOTHING
  `;
}

/** A 384-dim unit vector, so the HNSW path is exercised. */
function unitVector(seed: number): string {
  const v = new Array(384).fill(0);
  v[seed % 384] = 1;
  return `[${v.join(",")}]`;
}

async function embed(articleId: number, seed: number) {
  const sql = getDb();
  await sql`
    INSERT INTO nn_article_sentence_embeddings (article_id, vector, model_name, input_hash)
    VALUES (${articleId}, ${unitVector(seed)}::vector, 'all-MiniLM-L6-v2', ${"h" + articleId + seed})
    ON CONFLICT (article_id, model_name) DO NOTHING
  `;
}

describe("GET /api/pins/:id/tree", () => {
  beforeEach(async () => {
    await initBounds();
    await cleanup();
  });

  test("resolves a pin to its event and returns its siblings", async () => {
    const src = await makeSource("outlet-a");
    const loc = await makeLocation("London", "GB", 51.5, -0.12);

    const rootArticle = await makeArticle(src, loc, "Story about a badgers reunion", {
      wordFreq: { badger: 3, reunion: 2 },
    });
    const sibling = await makeArticle(src, loc, "Badgers reunion continues", {
      wordFreq: { badger: 4, reunion: 1 },
    });

    const eventId = await makeEvent("Story about a badgers reunion", loc);
    await attach(eventId, rootArticle);
    await attach(eventId, sibling);

    const res = await app.request(`/api/pins/${rootArticle}/tree`);
    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(body.root.event_id).toBe(eventId);
    expect(body.root.article_id).toBe(rootArticle);
    expect(body.root.members).toBe(2);
    expect(body.root.is_mega_cluster).toBe(false);
    expect(body.siblings.count).toBe(1);
    expect(body.siblings.items[0].article_id).toBe(sibling);
  });

  test("buckets related stories most → least and sorts each bucket by score", async () => {
    const src = await makeSource("outlet-b");
    const loc = await makeLocation("Bristol", "GB", 51.45, -2.58);

    const rootArticle = await makeArticle(src, loc, "Council debates the harbour plan", {
      wordFreq: { council: 3, harbour: 2, plan: 2 },
    });
    const strongArticle = await makeArticle(src, loc, "Council approves harbour plan", {
      wordFreq: { council: 4, harbour: 3, plan: 3 },
    });
    const weakArticle = await makeArticle(src, loc, "Ferry timetable changes again", {
      wordFreq: { ferry: 2, timetable: 1 },
    });

    const rootEvent = await makeEvent("Council debates the harbour plan", loc);
    const strongEvent = await makeEvent("Council approves harbour plan", loc);
    const weakEvent = await makeEvent("Ferry timetable changes again", loc);
    await attach(rootEvent, rootArticle);
    await attach(strongEvent, strongArticle);
    await attach(weakEvent, weakArticle);

    await link(rootArticle, strongArticle, "ai_detected", 0.95);
    await link(rootArticle, weakArticle, "ai_detected", 0.2);

    const res = await app.request(`/api/pins/${rootArticle}/tree`);
    expect(res.status).toBe(200);
    const body: any = await res.json();

    const all = body.buckets.flatMap((b: any) => b.children);
    expect(all.length).toBe(2);

    // The buckets are ordered strongest → weakest.
    const keys = body.buckets.map((b: any) => b.key);
    expect(keys).toEqual(["strong", "medium", "weak"]);

    // Stronger story scores higher than the weak one.
    const strong = all.find((c: any) => c.article_id === strongArticle);
    const weak = all.find((c: any) => c.article_id === weakArticle);
    expect(strong.score).toBeGreaterThan(weak.score);

    // Score components are reported so the UI can explain itself.
    expect(strong.link_strength).toBeCloseTo(0.95, 3);
    expect(typeof strong.keyword_ratio).toBe("number");
  });

  test("semantic neighbours are preferred over raw link strength", async () => {
    const src = await makeSource("outlet-c");
    const loc = await makeLocation("Leeds", "GB", 53.8, -1.55);

    const rootArticle = await makeArticle(src, loc, "Rail strike halts services", {
      wordFreq: { rail: 3, strike: 3 },
    });
    const semNeighbour = await makeArticle(src, loc, "Strikes stop trains running", {
      wordFreq: { rail: 2, strike: 2 },
    });
    const linkNeighbour = await makeArticle(src, loc, "Station cafe reopens", {
      wordFreq: { station: 1, cafe: 1 },
    });

    const rootEvent = await makeEvent("Rail strike halts services", loc);
    const semEvent = await makeEvent("Strikes stop trains running", loc);
    const linkEvent = await makeEvent("Station cafe reopens", loc);
    await attach(rootEvent, rootArticle);
    await attach(semEvent, semNeighbour);
    await attach(linkEvent, linkNeighbour);

    // The semantic neighbour has a WEAKER stored link, but the same
    // embedding as the root — this is the case the NN score alone misses.
    await link(rootArticle, semNeighbour, "ai_detected", 0.6);
    await link(rootArticle, linkNeighbour, "ai_detected", 0.99);
    await embed(rootArticle, 7);
    await embed(semNeighbour, 7);
    await embed(linkNeighbour, 200);

    const res = await app.request(`/api/pins/${rootArticle}/tree`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.meta.semantic_available).toBe(true);

    const all = body.buckets.flatMap((b: any) => b.children);
    const sem = all.find((c: any) => c.article_id === semNeighbour);
    const lnk = all.find((c: any) => c.article_id === linkNeighbour);
    expect(sem).toBeTruthy();
    expect(lnk).toBeTruthy();
    expect(sem.score).toBeGreaterThan(lnk.score);
    // Identical embeddings → cosine ~1; the orthogonal one → ~0.
    expect(sem.semantic_cos).toBeGreaterThan(0.9);
    expect(lnk.semantic_cos).toBeLessThan(0.2);
  });

  test("resolves a community pin through the pins id space", async () => {
    const sql = getDb();
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO pins (source_type, title, location, published_at, created_at)
      VALUES ('community', 'Community report about the flood',
              ST_SetSRID(ST_MakePoint(1.5, 52.3), 4326)::geography,
              now(), now())
      RETURNING id
    `;
    const res = await app.request(`/api/pins/${Number(row.id)}/tree`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.root.headline).toContain("flood");
    expect(body.root.event_id).toBeNull();
  });

  test("an article with no event cluster still gets a scored tree", async () => {
    const src = await makeSource("outlet-f");
    const loc = await makeLocation("Norwich", "GB", 52.63, 1.3);

    // Deliberately NOT attached to any event.
    const rootArticle = await makeArticle(src, loc, "Dehumidifier buying guide for damp homes", {
      wordFreq: { dehumidifier: 4, damp: 2 },
    });
    const neighbour = await makeArticle(src, loc, "Best dehumidifiers for small rooms", {
      wordFreq: { dehumidifier: 5, damp: 1 },
    });
    await embed(rootArticle, 11);
    await embed(neighbour, 11);
    await link(rootArticle, neighbour, "ai_detected", 0.3);

    const res = await app.request(`/api/pins/${rootArticle}/tree`);
    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(body.root.event_id).toBeNull();
    expect(body.meta.semantic_available).toBe(true);

    const all = body.buckets.flatMap((b: any) => b.children);
    const hit = all.find((c: any) => c.article_id === neighbour);
    expect(hit).toBeTruthy();
    // The score is the composite, NOT the raw link strength. A 0.3 link
    // must not be presented as a 0.3 "most related" score.
    expect(hit.score).toBeGreaterThan(0.3);
    expect(hit.semantic_cos).toBeGreaterThan(0.9);
  });

  test("rejects a bad id and 404s an unknown one", async () => {
    expect((await app.request("/api/pins/abc/tree")).status).toBe(400);
    expect((await app.request("/api/pins/0/tree")).status).toBe(400);
    expect((await app.request("/api/pins/999999999/tree")).status).toBe(404);
  });

  test("answers inside the 10s per-click budget", async () => {
    const src = await makeSource("outlet-d");
    const loc = await makeLocation("Cardiff", "GB", 51.48, -3.18);

    const rootArticle = await makeArticle(src, loc, "Budget announcement expected");
    const rootEvent = await makeEvent("Budget announcement expected", loc);
    await attach(rootEvent, rootArticle);

    // 40 members — the shape of a well-covered story.
    for (let i = 0; i < 40; i++) {
      const a = await makeArticle(src, loc, `Budget coverage ${i}`);
      await attach(rootEvent, a);
      await link(rootArticle, a, "ai_detected", 0.9);
    }

    const started = Date.now();
    const res = await app.request(`/api/pins/${rootArticle}/tree`);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(10_000);
    const body: any = await res.json();
    expect(body.meta.elapsed_ms).toBeLessThan(10_000);
    expect(body.siblings.count).toBe(40);
  });
});

describe("GET /api/events/:id/tree", () => {
  beforeEach(async () => {
    await initBounds();
    await cleanup();
  });

  test("returns one level of children for an event", async () => {
    const src = await makeSource("outlet-e");
    const loc = await makeLocation("Glasgow", "GB", 55.86, -4.25);

    const rootArticle = await makeArticle(src, loc, "Bridge closes for repairs");
    const childArticle = await makeArticle(src, loc, "Repairs on the bridge begin");
    const rootEvent = await makeEvent("Bridge closes for repairs", loc);
    const childEvent = await makeEvent("Repairs on the bridge begin", loc);
    await attach(rootEvent, rootArticle);
    await attach(childEvent, childArticle);
    await link(rootArticle, childArticle, "same_event", 0.9);

    const res = await app.request(`/api/events/${rootEvent}/tree`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.root.event_id).toBe(rootEvent);
    const all = body.buckets.flatMap((b: any) => b.children);
    expect(all.some((c: any) => c.event_id === childEvent)).toBe(true);
  });

  test("404s an unknown event and 400s a bad id", async () => {
    expect((await app.request("/api/events/abc/tree")).status).toBe(400);
    expect((await app.request("/api/events/999999999/tree")).status).toBe(404);
  });
});

afterAll(async () => {
  await closeDb();
});
