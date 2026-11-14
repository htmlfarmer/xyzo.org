// Route-level tests for the click-to-submit community flow (2026-09-28):
//   POST /api/pins — fast-scan gate, anonymous allowed, dedupe, verdict shape
//
// Hermetic-ish: uses unique X-Forwarded-For IPs (module-level rate limiters
// are process-shared across bun test files) and cleans up only its own rows.

import { describe, expect, test, afterAll } from "bun:test";
import { Hono } from "hono";
import { pinsRoute } from "../src/routes/pins";
import { getDb } from "../src/db";

const app = new Hono();
app.route("/api", pinsRoute);

const MARK = "xyzo-submit-flow-test";
const createdPinIds: number[] = [];

function post(body: unknown, ip: string) {
  return app.request("/api/pins", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

afterAll(async () => {
  const sql = getDb();
  const rows = await sql<any[]>`
    SELECT id FROM pins WHERE title LIKE ${MARK + "%"}
  `;
  const ids = rows.map((r) => Number(r.id));
  if (ids.length > 0) {
    await sql`DELETE FROM community_details WHERE pin_id = ANY(${ids})`;
    await sql`DELETE FROM pins WHERE id = ANY(${ids})`;
  }
});

describe("POST /api/pins — click-to-submit flow", () => {
  test("anonymous submission publishes and returns the fast-scan verdict", async () => {
    const res = await post({
      title: `${MARK} Flood warning issued for the river district`,
      story_note: "Water levels rising fast, families moving to higher ground.",
      lat: 31.52, lng: 74.36,
      hp_company: "",
    }, "203.0.113.60");
    expect(res.status).toBe(201);
    const body = await res.json();
    createdPinIds.push(body.id);
    expect(body.status).toBe("published");
    expect(body.detected).toBeDefined();
    expect(typeof body.detected.topic_summary).toBe("string");
    expect(body.detected.topic_summary.length).toBeGreaterThan(10);
    expect(["weather", "floods", "environment", "other"]).toContain(body.detected.category);
    expect(["queued", "skipped"]).toContain(body.moderation.deep_check);

    // Persisted moderation metadata
    const sql = getDb();
    const [cd] = await sql<any[]>`
      SELECT story_note, mod_status, mod_fast FROM community_details WHERE pin_id = ${body.id}
    `;
    expect(cd.story_note).toContain("Water levels");
    expect(cd.mod_status).toBe("fast_published");
    expect(cd.mod_fast).toBeDefined();
  });

  test("optional name defaults to Anonymous", async () => {
    const res = await post({
      title: `${MARK} Night market fire drills praised by vendors`,
      lat: 13.75, lng: 100.5,
      hp_company: "",
    }, "203.0.113.61");
    expect(res.status).toBe(201);
    const body = await res.json();
    const sql = getDb();
    const [cd] = await sql<any[]>`
      SELECT submitter_name, submitter_email FROM community_details WHERE pin_id = ${body.id}
    `;
    expect(cd.submitter_name).toBe("Anonymous");
    expect(cd.submitter_email).toBeNull();
  });

  test("spam submission is rejected and never stored", async () => {
    const res = await post({
      title: `${MARK} earn money fast free bitcoin casino bonus`,
      lat: 40.7, lng: -74.0,
      hp_company: "",
    }, "203.0.113.62");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("rejected");
    expect(body.reasons.length).toBeGreaterThan(0);
    const sql = getDb();
    const rows = await sql`SELECT id FROM pins WHERE title LIKE ${MARK + " earn money%"}`;
    expect(rows.length).toBe(0);
  });

  test("exact duplicate title within 7 days returns 409", async () => {
    const title = `${MARK} Duplicate check unique title ${Date.now()}`;
    const r1 = await post({ title, lat: -6.2, lng: 106.8, hp_company: "" }, "203.0.113.63");
    expect(r1.status).toBe(201);
    const d1 = await r1.json();
    const r2 = await post({ title, lat: -6.2, lng: 106.8, hp_company: "" }, "203.0.113.64");
    expect(r2.status).toBe(409);
    const d2 = await r2.json();
    expect(d2.error).toBe("duplicate");
    expect(d2.existing_pin_id).toBe(d1.id);
  });

  test("null island (0,0) click is rejected", async () => {
    const res = await post({
      title: `${MARK} Story pinned at null island`,
      lat: 0, lng: 0, hp_company: "",
    }, "203.0.113.65");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_coordinates");
  });

  test("honeypot still rejects before any scan", async () => {
    const res = await post({
      title: `${MARK} innocent looking title`,
      lat: 51.5, lng: -0.12, hp_company: "definitely a bot",
    }, "203.0.113.66");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("spam_detected");
  });

  test("burst limiter caps rapid-fire submissions", async () => {
    const ip = "203.0.113.67";
    let limited = false;
    for (let i = 0; i < 6; i++) {
      const res = await post({
        title: `${MARK} burst submission number ${i} ${Date.now()}`,
        lat: 52.5 + i * 0.01, lng: 13.4, hp_company: "",
      }, ip);
      if (res.status === 429) { limited = true; break; }
      if (res.status === 201) {
        const b = await res.json();
        createdPinIds.push(b.id);
      }
    }
    expect(limited).toBe(true);
  });
});
