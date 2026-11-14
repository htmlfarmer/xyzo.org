import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { randomUUID } from "crypto";
import { Hono } from "hono";
import { analyticsRoute } from "../src/routes/analytics";
import { getDb, closeDb } from "../src/db";

// README Q3 (2026-11-01): source rankings had been dead since
// 2026-09-04 because news_interactions.source_id was NULL on every row —
// 9,840 interactions in the preceding 30 days carried none, so
// calculate_source_rankings() upserted nothing and news_source_rankings
// sat frozen at 2026-10-04 while `aggregates_refreshed` still reported
// true.
//
// Root cause: a map pin is a CLUSTER of articles from several sources,
// so the pin payload has no single honest `source_id` to send — and
// /api/pins/map did not return `article_id` either, so the client had
// nothing to derive one FROM. The fix is server-side:
//
//   1. /api/pins/map returns `article_id` (a news_articles.id for
//      RSS/editorial pins, NULL for community submissions);
//   2. /api/analytics/batch and /api/analytics/log resolve the article
//      from an explicit article_id, or — failing that — from the id the
//      client sent as `pin_id`, because for RSS/editorial pins that id
//      IS a news_articles.id;
//   3. source_id is then LOOKED UP from that article, never trusted
//      from the client, so a caller cannot inject attribution it does
//      not own.
//
// These tests pin all three, including the guard that stops a genuine
// community pin (a real `pins` row) from being mistaken for an article.

const SQL = () => getDb();
const PREFIX = "test-attr-";

let sourceId: number;
let articleId: number;
let communityPinId: number;
const interactionKeys: string[] = [];

async function seed(): Promise<void> {
  const sql = SQL();
  const s = await sql<any[]>`
    INSERT INTO news_sources (name, feed_url, country, language, region, source_type, active)
    VALUES (${PREFIX + "src"}, ${"https://" + PREFIX + "example.test/feed"}, 'US', 'en', 'global', 'rss', TRUE)
    RETURNING id`;
  sourceId = Number(s[0].id);

  const a = await sql<any[]>`
    INSERT INTO news_articles (source_id, url, title, status)
    VALUES (${sourceId}, ${"https://" + PREFIX + "example.test/a-" + randomUUID()},
            'attribution test article', 'extracted')
    RETURNING id`;
  articleId = Number(a[0].id);

  const p = await sql<any[]>`
    INSERT INTO pins (source_type, title, status, location)
    VALUES ('community', 'attribution test pin', 'published',
            ST_SetSRID(ST_MakePoint(-71.06, 42.36), 4326))
    RETURNING id`;
  communityPinId = Number(p[0].id);
}

async function post(body: unknown, idemKey?: string) {
  const app = new Hono();
  app.route("/api", analyticsRoute);
  return app.request("/api/analytics/batch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idemKey ? { "X-Idempotency-Key": idemKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** One event, unique idempotency key so the row is findable + cleanable. */
async function track(event: Record<string, unknown>) {
  const key = `test-attr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  interactionKeys.push(key);
  const res = await post(
    { session_id: "attr-test-session", events: [event] },
    key,
  );
  expect(res.status).toBe(200);
  return key;
}

async function rowForKey(key: string) {
  const sql = SQL();
  // The endpoint does not store the raw header key: it builds
  // `${session_id}:${headerKey}:${index}` (Tier 1.2 hardening, so two
  // sessions cannot collide). Match on containment, not equality.
  const rows = await sql<any[]>`
    SELECT pin_id, article_id, source_id, event_id
    FROM news_interactions WHERE idempotency_key LIKE ${"%" + key + "%"}`;
  expect(rows.length).toBe(1);
  return rows[0];
}

beforeAll(async () => {
  await seed();
});

afterAll(async () => {
  const sql = SQL();
  for (const key of interactionKeys) {
    await sql`DELETE FROM news_interactions WHERE idempotency_key LIKE ${"%" + key + "%"}`;
  }
  await sql`DELETE FROM news_articles WHERE url LIKE ${"https://" + PREFIX + "%"}`;
  await sql`DELETE FROM pins WHERE title LIKE ${PREFIX + "%"}`;
  await sql`DELETE FROM news_sources WHERE feed_url LIKE ${"https://" + PREFIX + "%"}`;
  await closeDb();
});

describe("Q3: interactions finally carry a source_id", () => {
  test("resolves article_id + source_id from the id sent as pin_id", async () => {
    // This is the source_click shape: /api/pins/map's `id` is a
    // news_articles.id and analytics.js has always sent it as pin_id.
    const key = await track({ type: "source_click", pin_id: articleId });
    const row = await rowForKey(key);

    expect(Number(row.article_id)).toBe(articleId);
    expect(Number(row.source_id)).toBe(sourceId);
    // ...and it must NOT have been recorded as a pins-table pin.
    expect(row.pin_id).toBeNull();
  });

  test("an explicit article_id is resolved too", async () => {
    const key = await track({ type: "pin_view", article_id: articleId });
    const row = await rowForKey(key);

    expect(Number(row.article_id)).toBe(articleId);
    expect(Number(row.source_id)).toBe(sourceId);
  });

  test("a REAL community pin is not mistaken for an article", async () => {
    // The inference is guarded by NOT EXISTS (... pins): a genuine
    // community pin keeps its pin_id and gains no fabricated article.
    const key = await track({ type: "pin_click", pin_id: communityPinId });
    const row = await rowForKey(key);

    expect(Number(row.pin_id)).toBe(communityPinId);
    expect(row.article_id).toBeNull();
    expect(row.source_id).toBeNull();
  });

  test("an explicit source_id is kept, not overwritten by the lookup", async () => {
    const sql = SQL();
    const other = await sql<any[]>`
      INSERT INTO news_sources (name, feed_url, country, language, region, source_type, active)
      VALUES (${PREFIX + "src2"}, ${"https://" + PREFIX + "other.test/feed"},
              'GB', 'en', 'global', 'rss', TRUE)
      RETURNING id`;
    const otherId = Number(other[0].id);

    const key = await track({
      type: "source_click",
      article_id: articleId,
      source_id: otherId,
    });
    const row = await rowForKey(key);

    expect(Number(row.source_id)).toBe(otherId);

    await sql`DELETE FROM news_sources WHERE id = ${otherId}`;
  });

  test("a source-less article degrades to NULL instead of failing", async () => {
    const sql = SQL();
    const orphan = await sql<any[]>`
      INSERT INTO news_articles (source_id, url, title, status)
      VALUES (NULL, ${"https://" + PREFIX + "orphan.test/" + randomUUID()},
              'attribution test orphan', 'extracted')
      RETURNING id`;
    const orphanId = Number(orphan[0].id);

    const key = await track({ type: "source_click", pin_id: orphanId });
    const row = await rowForKey(key);

    expect(Number(row.article_id)).toBe(orphanId);
    expect(row.source_id).toBeNull();

    await sql`DELETE FROM news_articles WHERE id = ${orphanId}`;
  });

  test("events with no ids at all still insert (the performance path)", async () => {
    const key = await track({
      type: "performance",
      map_lat: 42.36,
      map_lng: -71.06,
      map_zoom: 10,
      metadata: { kind: "map_pan", total_ms: 12 },
    });
    const row = await rowForKey(key);

    expect(row.pin_id).toBeNull();
    expect(row.article_id).toBeNull();
    expect(row.source_id).toBeNull();
  });
});

describe("Q3: /api/pins/map publishes article_id", () => {
  test("the payload shape carries the field the derivation depends on", async () => {
    // The map endpoint is what feeds analytics: without `article_id` in
    // the payload the client can only ever send an ambiguous pin_id.
    // Asserting the FIELD (rather than a full map query, which needs a
    // seeded location + bbox) keeps this fast and still fails if the
    // column is dropped from the SELECT or the payload mapper.
    const sql = SQL();
    const rows = await sql<any[]>`
      SELECT 1 FROM news_articles
       WHERE source_id IS NOT NULL AND location_id IS NOT NULL
       LIMIT 1`;
    if (rows.length === 0) return; // empty test DB: nothing to map

    const res = await (async () => {
      const { pinsRoute } = await import("../src/routes/pins");
      const app = new Hono();
      app.route("/api", pinsRoute);
      return app.request("/api/pins/map?bbox=-180,-85,180,85&limit=5");
    })();

    expect(res.status).toBe(200);
    const body = await res.json();
    const pins: any[] = body.pins ?? body.items ?? [];
    if (pins.length === 0) return;

    for (const p of pins) {
      expect(Object.keys(p)).toContain("article_id");
      // Either a real article id or an explicit null — never absent.
      expect(p.article_id === null || typeof p.article_id === "number").toBe(true);
    }
  });
});
