// Tests for /api/community/requests — re-eval map view round-trip and the
// AI-on-confirm enqueue idempotency.
//
// Mirrors the structure of community.area-requests.test.ts: Hono in-process
// + direct DB seeding, no worker pool. The vote endpoint enqueues a
// `community_triage` discovery job with
// `enqueued_by = 'api/community/vote/ai-validate'`; the job sits in
// 'queued' status because we never start a worker here. Assertions check
// for existence/count of those rows — never need the worker to actually
// run.
//
// Cleanup uses a dedicated `enqueued_by` LIKE prefix so partial failures
// don't leave rows behind.

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { communityRoute } from "../src/routes/community";
import { getDb } from "../src/db";

const TEST_VIEW = {
  map_center_lat: 41.9028,
  map_center_lng: 12.4964,
  map_zoom: 9,
};

// Build a re-eval request row. The `map_center_lat/lng/zoom` overrides
// accept `null` to simulate legacy rows that pre-date the map-view
// columns (the migration is additive + idempotent). Pass
// `seedAiValidation: true` to pre-populate the row's `result` JSONB
// with a stub ai_validation block — used by Test 4 to simulate the
// "worker has already run" state so the idempotency gate fires.
async function seedReevalRequest(overrides: Record<string, unknown> = {}): Promise<number> {
  const sql = getDb();
  const lat = overrides.map_center_lat === undefined
    ? TEST_VIEW.map_center_lat
    : overrides.map_center_lat;
  const lng = overrides.map_center_lng === undefined
    ? TEST_VIEW.map_center_lng
    : overrides.map_center_lng;
  const zoom = overrides.map_zoom === undefined
    ? TEST_VIEW.map_zoom
    : overrides.map_zoom;
  const seedAiValidation = overrides.seedAiValidation === true;

  if (seedAiValidation) {
    const rows = await sql<any[]>`
      INSERT INTO news_re_evaluate_requests (
        pin_id, article_id, kind, user_place, requester_ip,
        public_visible, community_status,
        map_center_lat, map_center_lng, map_zoom,
        result
      ) VALUES (
        ${1}, ${null}, ${"suggest_location"}, ${"Rome, Italy"},
        ${"127.0.0.1"}::inet,
        ${true}, ${"open"},
        ${lat}, ${lng}, ${zoom},
        ${sql.json({ ai_validation: { valid: true, method: "stub" } })}
      )
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  const rows = await sql<any[]>`
    INSERT INTO news_re_evaluate_requests (
      pin_id, article_id, kind, user_place, requester_ip,
      public_visible, community_status,
      map_center_lat, map_center_lng, map_zoom
    ) VALUES (
      ${1}, ${null}, ${"suggest_location"}, ${"Rome, Italy"},
      ${"127.0.0.1"}::inet,
      ${true}, ${"open"},
      ${lat}, ${lng}, ${zoom}
    )
    RETURNING id
  `;
  return Number(rows[0].id);
}

// Reset only the tables this test touches. Avoids TRUNCATE-ing unrelated
// tables the app user lacks permission for (cascade on `news_articles`/
// `news_locations` reaches `news_story_links` etc., which the app role
// can't truncate). `news_request_votes` has ON DELETE CASCADE so a
// parent DELETE would clean it up, but explicit DELETEs here make the
// cleanup order obvious and isolated to this test.
async function fullCleanup(): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM news_request_votes`;
  await sql`DELETE FROM discovery_jobs WHERE enqueued_by LIKE 'api/community/%'`;
  await sql`DELETE FROM news_re_evaluate_requests`;
}

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api", communityRoute);
  return app;
}

beforeEach(fullCleanup);
afterAll(async () => {
  await fullCleanup();
  // NOTE: do NOT call sql.end() — bun test runs files in parallel
  // and shares the postgres-js connection pool across files.
  // Closing it here would kill every sibling file's queries.
  // closeDb() in src/db.ts is intentionally a no-op for the same reason.
});

describe("GET /api/community/requests — map view round-trip", () => {
  test("returns map_center_lat/lng/zoom on a re-eval request", async () => {
    const id = await seedReevalRequest({});
    const app = makeApp();
    const res = await app.request("/api/community/requests");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requests).toHaveLength(1);
    const row = body.requests[0];
    expect(row.id).toBe(id);
    expect(row.map_center_lat).toBe(TEST_VIEW.map_center_lat);
    expect(row.map_center_lng).toBe(TEST_VIEW.map_center_lng);
    expect(row.map_zoom).toBe(TEST_VIEW.map_zoom);
  });

  test("legacy row with NULL map fields returns nulls (no crash)", async () => {
    const id = await seedReevalRequest({
      map_center_lat: null,
      map_center_lng: null,
      map_zoom: null,
    });
    const app = makeApp();
    const res = await app.request("/api/community/requests");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requests).toHaveLength(1);
    const row = body.requests[0];
    expect(row.id).toBe(id);
    expect(row.map_center_lat).toBeNull();
    expect(row.map_center_lng).toBeNull();
    expect(row.map_zoom).toBeNull();
  });
});

describe("POST /api/community/requests/:id/vote — AI enqueue", () => {
  test("first confirm vote enqueues a community_triage job (no reason required)", async () => {
    const id = await seedReevalRequest({});
    const app = makeApp();
    const res = await app.request(`/api/community/requests/${id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.0.0.1" },
      body: JSON.stringify({ vote: "confirm" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.vote).toBe("confirm");

    const sql = getDb();
    const jobs = await sql<any[]>`
      SELECT id, kind, enqueued_by, payload, status
      FROM discovery_jobs
      WHERE enqueued_by = 'api/community/vote/ai-validate'
        AND kind = 'community_triage'
    `;
    expect(jobs.length).toBe(1);
    expect(jobs[0].status).toBe("queued"); // no worker pool in test
    expect(jobs[0].payload).toEqual({ op: "ai_validate", request_id: id });
  });

  test("second confirm vote does NOT re-enqueue when result.ai_validation is already set", async () => {
    // The idempotency check in community.ts:353-358 gates the enqueue on
    // `result->>'ai_validation' IS NOT NULL` — a value the worker
    // persists to news_re_evaluate_requests AFTER running. In this
    // hermetic test the worker never runs, so a second vote fired
    // BEFORE the worker would slip past the gate and create a
    // duplicate job. That's a known race window worth documenting
    // but not fixable from the route alone without an advisory lock.
    //
    // To prove the gate DOES block re-enqueue once the worker has
    // persisted its result, we pre-seed the row with a stub
    // ai_validation block and POST a confirm vote. The hasAi check
    // should match, and no job should land.
    const id = await seedReevalRequest({ seedAiValidation: true });
    const app = makeApp();
    const res = await app.request(`/api/community/requests/${id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.0.0.2" },
      body: JSON.stringify({ vote: "confirm" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.vote).toBe("confirm");

    const sql = getDb();
    const jobs = await sql<any[]>`
      SELECT id FROM discovery_jobs
      WHERE enqueued_by = 'api/community/vote/ai-validate'
        AND kind = 'community_triage'
        AND payload->>'request_id' = ${String(id)}
    `;
    expect(jobs.length).toBe(0);
  });
});
