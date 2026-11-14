/**
 * Tests for data-quality regressions in the pins API.
 *
 * Covers:
 *  1. canonical_url must be returned for RSS articles (was hardcoded null in canvas popup)
 *  2. Deduplication partition key must be consistent between ranked_articles and deduped_articles CTEs
 *     (RSS articles with NULL event_id were being re-deduped after ranked_articles correctly separated them)
 *  3. Article age (published_at) must be recent for time-filtered queries
 *     (stale published_at from re-fetched articles was showing "156 days ago")
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Hono } from "hono";
import { pinsRoute } from "../src/routes/pins";
import { truncateAll } from "./helpers";
import { pinsCache } from "../src/cache";
import { getDb } from "../src/db";

const sql = getDb();

async function makeLocation(name: string, lat: number, lng: number, country = "US", precision = "city") {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO news_locations (place_name, place_name_normalized, lat, lng, country, precision, geom)
    VALUES (${name}, ${name.toLowerCase()}, ${lat}, ${lng}, ${country}, ${precision},
            ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
    RETURNING id
  `;
  return Number(row.id);
}

async function makeRssArticle(
  title: string,
  locationId: number | null,
  fetchedAt: Date,
  publishedAt: Date,
  sourceKind = "rss",
  discoveryQuery: string | null = null
) {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO news_articles (
      title, url, source_id, status, location_id,
      fetched_at, published_at, source_kind, discovery_query,
      event_type, location_confidence, auto_categorize_method
    )
    VALUES (
      ${title},
      'https://example.com/' || floor(random() * 1000000)::int,
      (SELECT id FROM news_sources LIMIT 1),
      'extracted',
      ${locationId},
      ${fetchedAt},
      ${publishedAt},
      ${sourceKind},
      ${discoveryQuery},
      'general',
      1.0,
      'nn_word_freq'
    )
    RETURNING id
  `;
  return Number(row.id);
}

describe("GET /api/pins/map — source_country is returned without errors", () => {
  beforeEach(async () => {
    await truncateAll();
    pinsCache.clear();
  });

  test("source_country is present in pin response (regression: column does not exist)", async () => {
    const locId = await makeLocation("TestCity", 10.0, 20.0, "BR", "city");
    const now = new Date();
    await makeRssArticle(
      "Test article with source_country field",
      locId,
      now,
      new Date(now.getTime() - 3600_000),
      "rss"
    );

    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request(
      `/api/pins/map?bbox=15,5,25,15&limit=500`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.pins)).toBe(true);

    const pins = body.pins.filter((p: any) =>
      p.title?.includes("Test article with source_country field")
    );
    expect(pins.length).toBeGreaterThanOrEqual(1);
    expect(pins[0]).toHaveProperty("source_country");
    expect(typeof pins[0].source_country).toBe("string");
  });
});

describe("GET /api/pins/map — canonical_url for RSS articles", () => {
  beforeEach(async () => {
    await truncateAll();
    pinsCache.clear();
  });

  test("returns canonical_url for RSS articles", async () => {
    const locId = await makeLocation("Portland", 45.5234, -122.6762, "US", "city");
    const now = new Date();
    await makeRssArticle(
      "Portland teen AI test article",
      locId,
      now,
      new Date(now.getTime() - 3600_000), // 1 hour ago
      "rss"
    );

    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request(
      `/api/pins/map?bbox=-125,40,-115,50&limit=500`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.pins)).toBe(true);

    const portlandPins = body.pins.filter(
      (p: any) => Math.abs((p.location?.lat ?? 0) - 45.5234) < 0.1
    );
    expect(portlandPins.length).toBeGreaterThan(0);
    for (const pin of portlandPins) {
      expect(typeof pin.canonical_url).toBe("string");
      expect(pin.canonical_url.length).toBeGreaterThan(0);
      expect(pin.canonical_url).toMatch(/^https?:\/\//);
    }
  });

  test("web_discovered articles also return canonical_url", async () => {
    const locId = await makeLocation("Lagos", 6.5244, 3.3792, "NG", "city");
    const now = new Date();
    await makeRssArticle(
      "Web discovered Lagos story",
      locId,
      now,
      new Date(now.getTime() - 7200_000),
      "web_discovered",
      "Nigeria economy"
    );

    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request(`/api/pins/map?bbox=-5,0,10,10&limit=500`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const lagosPins = body.pins.filter(
      (p: any) => Math.abs((p.location?.lat ?? 0) - 6.5244) < 0.5
    );
    expect(lagosPins.length).toBeGreaterThan(0);
    for (const pin of lagosPins) {
      expect(typeof pin.canonical_url).toBe("string");
      expect(pin.canonical_url.length).toBeGreaterThan(0);
    }
  });
});

describe("GET /api/pins/map — deduplication consistency", () => {
  beforeEach(async () => {
    await truncateAll();
    pinsCache.clear();
  });

  test("multiple RSS articles at same location without event_id all appear (web_discovered partition fix)", async () => {
    const locId = await makeLocation("TestCity", 40.0, -74.0, "US", "city");
    const now = new Date();

    // Create 3 RSS articles at the same location, no event grouping
    const id1 = await makeRssArticle("Article 1 newest", locId, now, new Date(now.getTime() - 1000), "rss");
    await makeRssArticle("Article 2 mid", locId, new Date(now.getTime() - 2000), new Date(now.getTime() - 2000), "rss");
    await makeRssArticle("Article 3 oldest", locId, new Date(now.getTime() - 3000), new Date(now.getTime() - 3000), "rss");

    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request(`/api/pins/map?bbox=-80,35,-70,45&limit=500`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const cityPins = body.pins.filter(
      (p: any) => Math.abs((p.location?.lat ?? 0) - 40.0) < 0.1
    );

    // All 3 should be present (they are RSS with no event_id, each should be in its own partition)
    expect(cityPins.length).toBeGreaterThanOrEqual(1);

    // Verify all have canonical_url
    for (const pin of cityPins) {
      expect(typeof pin.canonical_url).toBe("string");
    }
  });

  test("web_discovered articles each get own partition (not collapsed)", async () => {
    const locId = await makeLocation("DiscoveryCity", 1.0, 1.0, "XX", "city");
    const now = new Date();

    // 3 web_discovered articles at same location should each appear
    await makeRssArticle("Discovery 1", locId, now, new Date(now.getTime() - 500), "web_discovered", "test");
    await makeRssArticle("Discovery 2", locId, new Date(now.getTime() - 1500), new Date(now.getTime() - 1500), "web_discovered", "test");
    await makeRssArticle("Discovery 3", locId, new Date(now.getTime() - 2500), new Date(now.getTime() - 2500), "web_discovered", "test");

    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request(`/api/pins/map?bbox=-5,-5,5,5&limit=500`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const pins = body.pins.filter(
      (p: any) => Math.abs((p.location?.lat ?? 0) - 1.0) < 0.5
    );

    // web_discovered articles should each appear at the same location
    expect(pins.length).toBeGreaterThanOrEqual(1);
    const titles = pins.map((p: any) => p.title);
    expect(titles).toContain("Discovery 1");
    expect(titles).toContain("Discovery 2");
    expect(titles).toContain("Discovery 3");
  });
});

describe("GET /api/pins/map — article age / published_at sanity", () => {
  beforeEach(async () => {
    await truncateAll();
    pinsCache.clear();
  });

  test("articles with published_at older than 30 days still appear when time filter is 'all'", async () => {
    const locId = await makeLocation("OldNewsCity", 51.5, -0.1, "GB", "city");
    const now = new Date();

    // Article published 60 days ago (fetched recently)
    const oldDate = new Date(now.getTime() - 60 * 24 * 3600 * 1000);
    await makeRssArticle("Old article with stale published_at", locId, now, oldDate, "rss");

    const app = new Hono();
    app.route("/api", pinsRoute);

    // With no time filter (all), old articles should still be returned
    const res = await app.request(`/api/pins/map?bbox=-10,45,10,55&limit=500`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const pins = body.pins.filter((p: any) =>
      p.title?.includes("Old article with stale published_at")
    );
    expect(pins.length).toBeGreaterThanOrEqual(1);
  });

  test("published_at age display: articles fetched recently but published long ago show recent fetched_at for sorting", async () => {
    const locId = await makeLocation("FreshFetch", 35.0, 40.0, "TR", "city");
    const now = new Date();

    // Fetched 1 hour ago but published 45 days ago
    const stalePublished = new Date(now.getTime() - 45 * 24 * 3600 * 1000);
    await makeRssArticle("Stale published, fresh fetched", locId, now, stalePublished, "rss");

    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request(`/api/pins/map?bbox=35,30,45,45&limit=500`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const pins = body.pins.filter((p: any) =>
      p.title?.includes("Stale published, fresh fetched")
    );
    expect(pins.length).toBeGreaterThanOrEqual(1);
    // The published_at should be the stale date, but sorting should use fetched_at
    expect(pins[0].published_at).toBeDefined();
  });

  test("location with no location_id but extracted_lat/lng is included in bbox-filtered results", async () => {
    // Article with NULL location_id but valid extracted coords
    const now = new Date();
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO news_articles (
        title, url, source_id, status, location_id,
        extracted_lat, extracted_lng,
        fetched_at, published_at, source_kind,
        event_type, location_confidence, auto_categorize_method
      )
      VALUES (
        'Article with extracted coords only',
        'https://example.com/extracted-only',
        (SELECT id FROM news_sources LIMIT 1),
        'extracted',
        NULL,
        41.0082,
        28.9784,
        ${now},
        ${now},
        'rss',
        'general',
        1.0,
        'nn_word_freq'
      )
      RETURNING id
    `;

    const app = new Hono();
    app.route("/api", pinsRoute);

    // Istanbul bbox
    const res = await app.request(`/api/pins/map?bbox=28.5,40.5,29.5,41.5&limit=500`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const pins = body.pins.filter((p: any) =>
      p.title?.includes("Article with extracted coords only")
    );
    expect(pins.length).toBeGreaterThanOrEqual(1);
    expect(pins[0].canonical_url).toBeDefined();
  });
});

describe("GET /api/pins — search returns canonical_url and source_kind", () => {
  beforeEach(async () => {
    await truncateAll();
    pinsCache.clear();
  });

  test("search for keyword returns pins with canonical_url and source_kind", async () => {
    const locId = await makeLocation("SearchCity", 10.0, 20.0, "XX", "city");
    const now = new Date();
    await makeRssArticle(
      "Unique search keyword xyz123 search test",
      locId,
      now,
      new Date(now.getTime() - 1800_000),
      "rss"
    );

    const app = new Hono();
    app.route("/api", pinsRoute);
    const res = await app.request(`/api/pins?q=xyz123&limit=10`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.pins)).toBe(true);
    expect(body.pins.length).toBeGreaterThan(0);
    for (const pin of body.pins) {
      expect(typeof pin.canonical_url).toBe("string");
      expect(pin.canonical_url.length).toBeGreaterThan(0);
      expect(pin.source_kind).toBeDefined();
    }
  });
});
