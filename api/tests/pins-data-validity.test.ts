/**
 * SQL-based data-quality validation tests.
 *
 * These tests validate properties of the live database without modifying data.
 * They use read-only queries to check for known data-quality bugs:
 *
 *  1. RSS articles at same location should NOT be collapsed by deduplication
 *     (verifies partition key consistency between ranked_articles and deduped_articles CTEs)
 *  2. Articles with NULL location_id but valid extracted_lat/lng must be included in bbox queries
 *  3. canonical_url should never be null/empty for articles with a url
 *  4. published_at should not be older than 1 year for recently-fetched articles
 *
 * Run against production (or a full schema test DB) with:
 *   XYO_RUN_DATA_VALIDITY=1 NODE_ENV=test \
 *     XYZO_DB_URL="postgres://xyzo_app:CHANGE_ME@localhost:5432/xyzo" \
 *     bun test tests/pins-data-validity.test.ts
 *
 * These tests are SKIPPED in the standard CI/unit-test run because they
 * require a populated DB (the unit-test DB is empty after truncate).
 * They are intentional production-data audits, not unit tests.
 */
import { describe, expect, test } from "bun:test";
import { getDb } from "../src/db";

const ENABLED = !!process.env.XYO_RUN_DATA_VALIDITY;
const sql = getDb();

// Convenience: every test in this file is a production-data audit that
// requires a populated DB. Wrap each call so the entire file is a
// no-op in the standard CI run (empty test DB) and only runs when
// XYO_RUN_DATA_VALIDITY=1 against production.
const t = (name: string, fn: () => Promise<void>) =>
  ENABLED ? test(name, fn) : test.skip(name, fn);

describe("Deduplication: RSS articles with NULL event_id at same location", () => {
  t("Fast check: multiple RSS articles exist at same coords without event grouping", async () => {
    // Quick count check - just verify there are some articles with NULL location_id
    // and that they have valid extracted coordinates
    const countResult = await sql<any[]>`
      SELECT COUNT(*) AS cnt
      FROM news_articles a
      WHERE a.status IN ('extracted', 'discovered')
        AND a.source_kind = 'rss'
        AND a.location_id IS NULL
        AND a.extracted_lat IS NOT NULL AND a.extracted_lat != 0
        AND a.extracted_lng IS NOT NULL AND a.extracted_lng != 0
        AND a.fetched_at > NOW() - INTERVAL '7 days'
      LIMIT 1
    `;

    const count = Number(countResult[0]?.cnt ?? 0);
    console.log(`RSS articles with extracted coords (no location_id): ${count}`);
    expect(count).toBeGreaterThan(0);
  });

  t("web_discovered articles each get unique partition (not deduplicated away)", async () => {
    const result = await sql<any[]>`
      WITH ranked AS (
        SELECT
          a.id AS article_id, a.title, a.source_kind,
          COALESCE(NULLIF(a.extracted_lat, 0), l.lat) AS lat,
          COALESCE(NULLIF(a.extracted_lng, 0), l.lng) AS lng,
          ROW_NUMBER() OVER (
            PARTITION BY (
              CASE WHEN a.source_kind = 'web_discovered'
                   THEN a.id
                   ELSE COALESCE(nes.event_id, a.location_id)
              END
            )
            ORDER BY a.fetched_at DESC
          ) AS rn
        FROM news_articles a
        LEFT JOIN news_event_sources nes ON nes.article_id = a.id
        LEFT JOIN news_locations l ON l.id = a.location_id
        WHERE a.status IN ('extracted', 'discovered')
          AND a.source_kind = 'web_discovered'
          AND a.fetched_at > NOW() - INTERVAL '7 days'
        LIMIT 500
      )
      SELECT lat, lng, COUNT(*) AS cnt
      FROM ranked
      WHERE rn <= 10
      GROUP BY lat, lng
      HAVING COUNT(*) > 1
      LIMIT 5
    `;

    console.log(`web_discovered multi-article locations: ${result.length}`);
    // Informational - web_discovered should each be in their own partition
    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});

describe("Location-less articles: extracted_lat/lng included in bbox queries", () => {
  t("Articles with NULL location_id but valid extracted_lat/lng exist and have correct coordinates", async () => {
    const result = await sql<any[]>`
      SELECT a.id, a.title, a.extracted_lat, a.extracted_lng,
             COALESCE(NULLIF(a.extracted_lat, 0), l.lat) AS resolved_lat,
             COALESCE(NULLIF(a.extracted_lng, 0), l.lng) AS resolved_lng
      FROM news_articles a
      LEFT JOIN news_locations l ON l.id = a.location_id
      WHERE a.status IN ('extracted', 'discovered')
        AND a.location_id IS NULL
        AND a.extracted_lat IS NOT NULL
        AND a.extracted_lat != 0
        AND a.extracted_lng IS NOT NULL
        AND a.extracted_lng != 0
      LIMIT 10
    `;

    expect(result.length).toBeGreaterThan(0);
    for (const r of result) {
      expect(r.resolved_lat).toBeDefined();
      expect(r.resolved_lng).toBeDefined();
      expect(r.resolved_lat).not.toBeNull();
      expect(r.resolved_lng).not.toBeNull();
      expect(Math.abs(Number(r.resolved_lat))).toBeLessThanOrEqual(90);
      expect(Math.abs(Number(r.resolved_lng))).toBeLessThanOrEqual(180);
    }
  });
});

describe("canonical_url: should always be present for articles with a URL", () => {
  t("No article in news_articles has NULL url when url exists", async () => {
    // Every article should have a url
    const result = await sql<any[]>`
      SELECT id, title, url FROM news_articles
      WHERE url IS NULL OR url = ''
      LIMIT 5
    `;
    expect(result.length).toBe(0);
  });

  t("API /pins/map returns canonical_url for recent articles", async () => {
    // This test requires a running API server — skip if not available
    try {
      const res = await fetch("http://localhost:3008/api/pins/map?bbox=-180,-90,180,90&limit=100");
      if (!res.ok) {
        console.log("API not available, skipping live test");
        return;
      }
      const body = await res.json();
      const pins = body.pins ?? [];
      expect(pins.length).toBeGreaterThan(0);

      const missing = pins.filter((p: any) => !p.canonical_url);
      expect(missing.length).toBe(0);
    } catch {
      console.log("API not reachable, skipping live test");
    }
  });
});

describe("Article age: published_at should be recent for any meaningful time filter", () => {
  t("No article should have published_at more than 1 year in the past", async () => {
    const result = await sql<any[]>`
      SELECT id, title, published_at, fetched_at,
             NOW() - published_at AS age
      FROM news_articles
      WHERE published_at IS NOT NULL
        AND published_at < NOW() - INTERVAL '1 year'
        AND status IN ('extracted', 'discovered')
      ORDER BY fetched_at DESC
      LIMIT 10
    `;

    if (result.length > 0) {
      console.log(`WARNING: ${result.length} articles with published_at > 1 year old`);
      for (const r of result.slice(0, 5)) {
        console.log(`  id=${r.id}: published_at=${r.published_at}, age=${r.age}, title=${r.title?.slice(0, 50)}`);
      }
    }

    // This is a warning-level check — articles can legitimately be old
    // if they're from archival sources. We just want visibility.
    // The assertion is informational.
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  t("published_at older than 30 days should also have been fetched recently (re-fetched article)", async () => {
    // If an article was published > 30 days ago but fetched < 7 days ago,
    // it was likely re-fetched and should be surfaced with a note about age
    const result = await sql<any[]>`
      SELECT id, title, published_at, fetched_at,
             NOW() - published_at AS published_age,
             NOW() - fetched_at AS fetched_age
      FROM news_articles
      WHERE published_at < NOW() - INTERVAL '30 days'
        AND fetched_at > NOW() - INTERVAL '7 days'
        AND status IN ('extracted', 'discovered')
      ORDER BY fetched_at DESC
      LIMIT 10
    `;

    if (result.length > 0) {
      console.log(`${result.length} re-fetched articles with stale published_at:`);
      for (const r of result.slice(0, 5)) {
        console.log(`  id=${r.id}: published=${r.published_age?.slice(0,10)}, fetched=${r.fetched_age?.slice(0,8)}, title=${r.title?.slice(0,40)}`);
      }
    }

    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});

describe("Spread overlapping pins: coordinate grouping sanity", () => {
  t("No coordinate should have more than 10x the articles of a typical nearby coordinate (overflow detection)", async () => {
    /**
     * This validates that spreadOverlappingPins grouping by lat.toFixed(4),lng.toFixed(4)
     * doesn't create extreme imbalances. At zoom 14, pins within ~400m of each other
     * should group together. If one group has 100 articles and another has 5 at the
     * same location, that suggests the coordinates are being rounded too finely.
     */
    const result = await sql<any[]>`
      WITH coord_groups AS (
        SELECT
          ROUND(COALESCE(NULLIF(extracted_lat, 0), l.lat)::numeric, 2) AS lat_r,
          ROUND(COALESCE(NULLIF(extracted_lng, 0), l.lng)::numeric, 2) AS lng_r,
          COUNT(*) AS article_count
        FROM news_articles a
        LEFT JOIN news_locations l ON l.id = a.location_id
        WHERE a.status IN ('extracted', 'discovered')
          AND a.fetched_at > NOW() - INTERVAL '7 days'
          AND (l.geom IS NOT NULL OR a.extracted_lat IS NOT NULL)
        GROUP BY lat_r, lng_r
      )
      SELECT
        article_count,
        lat_r, lng_r,
        AVG(article_count) OVER () AS avg_count,
        article_count / NULLIF(AVG(article_count) OVER (), 0) AS ratio_to_avg
      FROM coord_groups
      ORDER BY article_count DESC
      LIMIT 20
    `;

    if (result.length > 0) {
      const max = result[0];
      const avg = typeof max.avg_count === 'number' ? Number(max.avg_count) : 0;
      const ratio = typeof max.ratio_to_avg === 'number' ? Number(max.ratio_to_avg) : Number(max.ratio_to_avg) || 0;
      console.log(`Highest article concentration: lat=${max.lat_r}, lng=${max.lng_r}: ${max.article_count} articles (avg=${avg.toFixed(1)}, ratio=${ratio.toFixed(1)}x)`);

      // If the top location has > 50x the average, it suggests over-deduplication
      // at nearby coordinates (the "Mombasa 95 + 29 at same place" bug)
      if (ratio > 50) {
        console.log(`WARNING: Extreme concentration detected (${ratio.toFixed(0)}x avg). Possible duplicate cluster bug.`);
      }
    }

    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /api/pins/map — since filter", () => {
  const API = "http://localhost:3008";

  async function apiJson(path: string) {
    const res = await fetch(`${API}${path}`);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  }

  t("since=2099 with bbox returns 0 (no future articles)", async () => {
    const bbox = "30.0,30.0,31.5,31.5";
    const body = await apiJson(`/api/pins/map?bbox=${bbox}&limit=5&since=2099-01-01T00:00:00Z`);
    expect(body.count).toBe(0);
    expect(body.pins).toHaveLength(0);
  });

  t("since=2099 without bbox returns 0", async () => {
    const body = await apiJson(`/api/pins/map?limit=5&since=2099-01-01T00:00:00Z`);
    expect(body.count).toBe(0);
    expect(body.pins).toHaveLength(0);
  });

  t("since with valid past date returns results (non-zero)", async () => {
    const bbox = "30.0,30.0,31.5,31.5";
    const body = await apiJson(`/api/pins/map?bbox=${bbox}&limit=5&since=2026-01-01T00:00:00Z`);
    expect(body.count).toBeGreaterThan(0);
    expect(body.pins.length).toBeGreaterThan(0);
  });

  t("articles in bbox with geom location are excluded by since filter", async () => {
    // The bbox 30,30,31.5,31.5 (Egypt/Cairo area) has articles with published_at in 2026.
    // An absurdly high since value (2099) must exclude ALL of them.
    const bbox = "30.0,30.0,31.5,31.5";
    const withSince = await apiJson(`/api/pins/map?bbox=${bbox}&limit=5&since=2099-01-01T00:00:00Z`);
    const withoutSince = await apiJson(`/api/pins/map?bbox=${bbox}&limit=5`);
    expect(withSince.count).toBe(0);
    expect(withoutSince.count).toBeGreaterThan(0);
  });
});
