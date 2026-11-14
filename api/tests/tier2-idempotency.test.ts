import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "crypto";
import { Hono } from "hono";
import { analyticsRoute } from "../src/routes/analytics";
import { locationViewsRoute } from "../src/routes/location-views";
import { getDb, closeDb } from "../src/db";

// Tier 1.2 of the consolidated audit fix-order. Verifies that:
//   1. POST /api/analytics/log with X-Idempotency-Key returns 200.
//   2. A retry with the SAME key returns 200 + { duplicate: true }
//      instead of inserting a second row.
//   3. POST /api/analytics/batch dedups every event in the batch via
//      per-event keys derived from the batch header (Tier 3 quick win
//      bundled in this PR: single multi-row INSERT replaces N+1).
//   4. POST /api/location-views dedups each view via a per-index key
//      derived from the batch header.
//   5. POST /api/analytics/set-home dedups the secondary interaction
//      insert.
//   6. Legacy callers without the header still succeed (NULL values
//      don't participate in the partial unique index).
//
// Schema: 2026-09-08-idempotency-keys.sql adds idempotency_key TEXT
// + a partial UNIQUE index WHERE idempotency_key IS NOT NULL on
// news_interactions and news_location_views. NULL values are excluded
// from unique indexes by default in Postgres, so legacy callers keep
// working unchanged.

const SQL = () => getDb();

async function cleanupTestRows(): Promise<void> {
  // Test rows use the well-known prefix `test-idem-` and `test-lv-`
  // so we never touch existing data.
  const sql = SQL();
  await sql`DELETE FROM news_interactions WHERE idempotency_key LIKE 'test-%'`;
  await sql`DELETE FROM news_location_views WHERE idempotency_key LIKE 'test-%'`;
}

beforeAll(async () => {
  await cleanupTestRows();
});

afterAll(async () => {
  await cleanupTestRows();
  await closeDb();
});

describe("Tier 1.2: idempotency on /api/analytics/log", () => {
  test("first POST with X-Idempotency-Key returns 200 with no duplicate flag", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const key = `test-idem-log-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const res = await app.request("/api/analytics/log", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": key,
      },
      body: JSON.stringify({
        session_id: "tier2-test",
        type: "page_view",
        metadata: { source: "tier2-test" },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBeUndefined();
  });

  test("retry with same X-Idempotency-Key returns 200 + { duplicate: true }", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const key = `test-idem-log-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sessionId = "tier2-test";
    // Tier 1.2 hardening: server prefixes stored key with session_id
    // (Finding #5). The query below must match the composite key.
    const storedKey = `${sessionId}:${key}`;
    const body = JSON.stringify({
      session_id: sessionId,
      type: "page_view",
      metadata: { source: "tier2-test-retry" },
    });
    const headers = {
      "Content-Type": "application/json",
      "X-Idempotency-Key": key,
    };
    // First POST: insert
    const r1 = await app.request("/api/analytics/log", {
      method: "POST",
      headers,
      body,
    });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.duplicate).toBeUndefined();
    // Retry: ON CONFLICT DO NOTHING → duplicate=true
    const r2 = await app.request("/api/analytics/log", {
      method: "POST",
      headers,
      body,
    });
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2.ok).toBe(true);
    expect(b2.duplicate).toBe(true);
    // DB sanity check: only ONE row exists with this key.
    const sql = SQL();
    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM news_interactions
      WHERE idempotency_key = ${storedKey}
    `;
    expect(Number(rows[0].count)).toBe(1);
  });

  test("legacy POST with no X-Idempotency-Key still works (NULL index path)", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    // No X-Idempotency-Key header. NULL values are excluded by the
    // partial UNIQUE index, so two such inserts in a row would
    // BOTH succeed (legacy behavior preserved).
    const res = await app.request("/api/analytics/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "tier2-test-legacy",
        type: "page_view",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBeUndefined();
  });
});

describe("Tier 1.2: idempotency on /api/analytics/batch", () => {
  test("batch dedups every event via per-index keys", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const key = `test-idem-batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sessionId = "tier2-test-batch";
    // Tier 1.2 hardening: per-event keys are prefixed with session_id
    // at the server (Finding #5).
    const keyPrefix = `${sessionId}:${key}`;
    // Tier 1.4 review fix (Fix B): the new FK on news_interactions.pin_id
    // (ON DELETE SET NULL) rejects inserts whose pin_id doesn't exist
    // in `pins`. The live DB may have an empty `pins` table, so we seed
    // a temporary pin (unique title via randomUUID) for this test and
    // clean it up at the end. The test's intent — verifying batch
    // dedup via per-index keys — is preserved; we still exercise the
    // pin_click path with a real FK-satisfying pin_id.
    const sql = SQL();
    const pinUnique = `test-tier2-pin-${randomUUID()}`;
    const [pinRow] = await sql<Array<{ id: string | number }>>`
      INSERT INTO pins (source_type, title, location)
      VALUES ('community', ${pinUnique}, ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography)
      RETURNING id
    `;
    const pinId = Number(pinRow.id);
    try {
      const events = [
        { type: "map_move" },
        { type: "pin_click", pin_id: pinId },
        { type: "search" },
      ];
      const body = JSON.stringify({
        session_id: sessionId,
        events,
      });
      const headers = {
        "Content-Type": "application/json",
        "X-Idempotency-Key": key,
      };
      // First POST: 3 inserts
      const r1 = await app.request("/api/analytics/batch", {
        method: "POST",
        headers,
        body,
      });
      expect(r1.status).toBe(200);
      const b1 = await r1.json();
      expect(b1.count).toBe(3);
      expect(b1.inserted).toBe(3);
      expect(b1.duplicates).toBe(0);
      // Retry: every per-event key collides → 0 inserted, 3 duplicates
      const r2 = await app.request("/api/analytics/batch", {
        method: "POST",
        headers,
        body,
      });
      expect(r2.status).toBe(200);
      const b2 = await r2.json();
      expect(b2.count).toBe(3);
      expect(b2.inserted).toBe(0);
      expect(b2.duplicates).toBe(3);
      // DB sanity check: only 3 rows exist for this batch
      const rows = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM news_interactions
        WHERE idempotency_key LIKE ${`${keyPrefix}:%`}
      `;
      expect(Number(rows[0].count)).toBe(3);
    } finally {
      // Cleanup: drop the temp pin (the SET NULL FK on news_interactions
      // will NULL out the pin_id automatically), then drop the test rows.
      await sql`DELETE FROM pins WHERE id = ${pinId}`;
      await sql`DELETE FROM news_interactions WHERE idempotency_key LIKE ${`${keyPrefix}:%`}`;
    }
  });

  test("batch with no header still works (legacy path)", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const res = await app.request("/api/analytics/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "tier2-test-batch-legacy",
        events: [{ type: "map_move" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    // Legacy: no header → no dedup accounting (inserted/count = 1,
    // duplicates = 0 because we never ask for them when no key).
    expect(body.inserted).toBe(1);
  });
});

describe("Tier 1.2: idempotency on /api/location-views", () => {
  test("retry of same flush payload dedups every view via per-index keys", async () => {
    const app = new Hono();
    app.route("/api", locationViewsRoute);
    const key = `test-lv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sessionId = "tier2-test-lv";
    // Tier 1.2 hardening: per-view keys are prefixed with session_id.
    const keyPrefix = `${sessionId}:${key}`;
    const views = [
      { view_type: "map_view", center_lat: 1, center_lng: 2, zoom_level: 3 },
      { view_type: "map_view", center_lat: 4, center_lng: 5, zoom_level: 6 },
    ];
    const body = JSON.stringify({ session_id: sessionId, views });
    const headers = {
      "Content-Type": "application/json",
      "X-Idempotency-Key": key,
    };
    const r1 = await app.request("/api/location-views", {
      method: "POST",
      headers,
      body,
    });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.inserted).toBe(2);
    expect(b1.duplicates).toBe(0);
    // Retry → all collide → 0 inserted, 2 duplicates
    const r2 = await app.request("/api/location-views", {
      method: "POST",
      headers,
      body,
    });
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2.inserted).toBe(0);
    expect(b2.duplicates).toBe(2);
    // DB sanity check: only 2 rows for this batch
    const sql = SQL();
    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM news_location_views
      WHERE idempotency_key LIKE ${`${keyPrefix}:%`}
    `;
    expect(Number(rows[0].count)).toBe(2);
  });
});

describe("Tier 1.2: idempotency on /api/analytics/set-home", () => {
  test("retry of same set-home dedups the secondary interaction insert", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const key = `test-idem-sh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sessionId = `tier2-test-sh-${Date.now()}`;
    const body = JSON.stringify({
      session_id: sessionId,
      lat: 10,
      lng: 20,
      city: "Test City",
      country: "US",
    });
    const headers = {
      "Content-Type": "application/json",
      "X-Idempotency-Key": key,
    };
    const r1 = await app.request("/api/analytics/set-home", {
      method: "POST",
      headers,
      body,
    });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.duplicate).toBeUndefined();
    const r2 = await app.request("/api/analytics/set-home", {
      method: "POST",
      headers,
      body,
    });
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2.ok).toBe(true);
    expect(b2.duplicate).toBe(true);
    // DB sanity: exactly one set_home row for this session
    const sql = SQL();
    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM news_interactions
      WHERE session_id = ${sessionId} AND interaction_type = 'set_home'
    `;
    expect(Number(rows[0].count)).toBe(1);
  });
});

// Tier 1.2 review: expanded coverage for legacy no-header paths, body
// divergence on same key, and the multi-row INSERT regression for
// /location-views.
describe("Tier 1.2: review hardening", () => {
  test("dedup ignores body divergence on same key", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const key = `test-same-key-diverge-${randomUUID()}`;
    const session = `test-session-${randomUUID()}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Idempotency-Key": key,
    };

    // First insert
    const r1 = await app.request("/api/analytics/log", {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: session,
        type: "page_view",
        metadata: { v: 1 },
      }),
    });
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1.duplicate).toBeUndefined();

    // Same key, DIFFERENT body — should still dedup
    const r2 = await app.request("/api/analytics/log", {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: session,
        type: "pin_click",
        metadata: { v: 2 },
      }),
    });
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.duplicate).toBe(true);

    // DB should have only 1 row with the FIRST body
    const sql = SQL();
    const rows = await sql<{ interaction_type: string; metadata: any }[]>`
      SELECT interaction_type, metadata FROM news_interactions
      WHERE session_id = ${session}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].interaction_type).toBe("page_view");

    // cleanup
    await sql`DELETE FROM news_interactions WHERE session_id = ${session}`;
  });

  test("/location-views inserts when no X-Idempotency-Key header", async () => {
    const app = new Hono();
    app.route("/api", locationViewsRoute);
    const session = `test-session-${randomUUID()}`;
    const res = await app.request("/api/location-views", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: session,
        views: [{
          view_type: "map_view",
          center_lat: 0, center_lng: 0, zoom_level: 1,
        }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inserted).toBe(1);
    expect(body.duplicates).toBe(0);

    // Cleanup
    const sql = SQL();
    await sql`DELETE FROM news_location_views WHERE session_id = ${session}`;
  });

  test("/set-home inserts when no X-Idempotency-Key header", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const session = `test-session-${randomUUID()}`;
    const res = await app.request("/api/analytics/set-home", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: session, lat: 0, lng: 0 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicate).toBeUndefined();

    // Cleanup
    const sql = SQL();
    await sql`DELETE FROM news_interactions WHERE session_id = ${session}`;
    await sql`DELETE FROM news_user_locations WHERE session_id = ${session}`;
  });

  test("/location-views batch insert is single round-trip", async () => {
    const app = new Hono();
    app.route("/api", locationViewsRoute);
    const session = `test-session-${randomUUID()}`;
    const key = `test-lview-multi-${randomUUID()}`;
    const views = Array.from({ length: 5 }, (_, i) => ({
      view_type: "map_view",
      center_lat: i, center_lng: 0, zoom_level: 1,
    }));
    const headers = {
      "Content-Type": "application/json",
      "X-Idempotency-Key": key,
    };

    const r1 = await app.request("/api/location-views", {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: session, views }),
    });
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1.inserted).toBe(5);
    expect(j1.duplicates).toBe(0);

    // Retry
    const r2 = await app.request("/api/location-views", {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: session, views }),
    });
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.inserted).toBe(0);
    expect(j2.duplicates).toBe(5);

    // Cleanup
    const sql = SQL();
    await sql`DELETE FROM news_location_views WHERE session_id = ${session}`;
  });

  test("session-scoped keys: same UUID across two sessions does NOT collide", async () => {
    // Finding #5 regression: after server-side session-scoping, two
    // different sessions sending the SAME X-Idempotency-Key value must
    // both insert successfully (their composite keys differ).
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const sharedKey = `test-shared-key-${randomUUID()}`;
    const sessionA = `test-sessionA-${randomUUID()}`;
    const sessionB = `test-sessionB-${randomUUID()}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Idempotency-Key": sharedKey,
    };

    const ra = await app.request("/api/analytics/log", {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: sessionA,
        type: "page_view",
        metadata: { who: "A" },
      }),
    });
    expect(ra.status).toBe(200);
    const ja = await ra.json();
    expect(ja.duplicate).toBeUndefined();

    const rb = await app.request("/api/analytics/log", {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: sessionB,
        type: "page_view",
        metadata: { who: "B" },
      }),
    });
    expect(rb.status).toBe(200);
    const jb = await rb.json();
    expect(jb.duplicate).toBeUndefined();

    // DB sanity: BOTH sessions got a row, neither deduplicated.
    const sql = SQL();
    const rows = await sql<{ session_id: string }[]>`
      SELECT session_id FROM news_interactions
      WHERE session_id IN ${sql([sessionA, sessionB])}
        AND idempotency_key IN ${sql([`${sessionA}:${sharedKey}`, `${sessionB}:${sharedKey}`])}
    `;
    expect(rows.length).toBe(2);

    // Cleanup
    await sql`DELETE FROM news_interactions WHERE session_id IN ${sql([sessionA, sessionB])}`;
  });
});