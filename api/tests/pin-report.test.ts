// Route-level tests for POST /api/pins/:id/report (2026-10-29).
//
// Why this exists: public_html/feedback-dialog.js's "Report Issue" tab
// POSTed to /api/pins/:id/report, an endpoint that had never been
// written. It returned 404, which is why the dialog was never wired into
// the pin popup and ended up sitting in a git stash. The endpoint is the
// piece that makes the dialog loadable.
//
// A report is a moderation SIGNAL, never a verdict: this suite asserts
// that no report path edits or hides a pin.
//
// Hermetic-ish: unique X-Forwarded-For IPs (the rate limiters are
// process-shared across bun test files) and only its own rows are
// cleaned up.

import { describe, expect, test, afterAll } from "bun:test";
import { Hono } from "hono";
import { feedbackRoute } from "../src/routes/feedback";
import { getDb } from "../src/db";

const app = new Hono();
app.route("/api", feedbackRoute);

function post(id: number | string, body: unknown, ip = "203.0.113.90") {
  return app.request(`/api/pins/${id}/report`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

// The route resolves a pin id to news_articles; we need a real article.
let articleId = 0;

afterAll(async () => {
  const sql = getDb();
  // Only the rows this file created. The synthetic pin ids are the
  // reliable marker — articleId is NaN when the test DB has no
  // news_articles, and binding NaN to a bigint column is a Postgres
  // error, so the article-scoped delete is conditional on it being set.
  await sql`
    DELETE FROM news_quality_reports
    WHERE metadata->>'pin_id' IN ('987654321', '123456789')
       OR session_id = 'test-session'`;
  if (Number.isInteger(articleId) && articleId > 0) {
    await sql`
      DELETE FROM news_quality_reports
      WHERE article_id = ${articleId} AND session_id = 'test-session'`;
  }
});

describe("POST /api/pins/:id/report", () => {
  test("rejects a non-integer pin id", async () => {
    expect((await post("abc", { report_type: "spam" })).status).toBe(400);
    expect((await post(0, { report_type: "spam" })).status).toBe(400);
    expect((await post(-5, { report_type: "spam" })).status).toBe(400);
  });

  test("rejects a report_type the dialog does not offer", async () => {
    // The dialog's radio buttons are the vocabulary; an unknown value
    // means a client that has drifted from the schema.
    const res = await post(1, { report_type: "not_a_real_type" });
    expect(res.status).toBe(400);
  });

  test("rejects an over-long reason", async () => {
    const res = await post(1, { report_type: "other", reason: "x".repeat(501) });
    expect(res.status).toBe(400);
  });

  test("records a report against the pin's article and returns 201", async () => {
    const sql = getDb();
    const rows = await sql<any[]>`
      SELECT id FROM news_articles WHERE id IS NOT NULL ORDER BY id LIMIT 1`;
    articleId = Number(rows[0]?.id);
    if (!articleId) return; // empty test DB: nothing to resolve a pin to

    const res = await post(articleId, {
      report_type: "paywall",
      reason: "subscription wall",
      session_id: "test-session",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Number(body.article_id)).toBe(articleId);

    const stored = await sql<any[]>`
      SELECT report_type, reason, session_id, article_id
      FROM news_quality_reports
      WHERE article_id = ${articleId} AND report_type = 'paywall'
      ORDER BY id DESC LIMIT 1`;
    expect(stored.length).toBe(1);
    expect(stored[0].reason).toBe("subscription wall");
    expect(stored[0].session_id).toBe("test-session");
  });

  test("does NOT touch the pin — a report is a signal, not a verdict", async () => {
    const sql = getDb();
    const rows = await sql<any[]>`
      SELECT id FROM news_articles WHERE id IS NOT NULL ORDER BY id LIMIT 1`;
    const id = Number(rows[0]?.id);
    if (!id) return; // empty test DB
    const before = await sql<any[]>`
      SELECT status FROM news_articles WHERE id = ${id}`;
    const res = await post(id, { report_type: "misleading" });
    expect(res.status).toBe(201);
    const after = await sql<any[]>`
      SELECT status FROM news_articles WHERE id = ${id}`;
    expect(after[0]?.status).toBe(before[0]?.status);
  });

  test("accepts a report for a pin with no article, leaving article_id NULL", async () => {
    // Community pins have no news_articles row. The signal is still
    // worth keeping, so the route records it with a NULL article_id
    // rather than rejecting the report outright.
    const sql = getDb();
    const res = await post(987654321, { report_type: "other", reason: "no article here" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.article_id).toBeNull();

    const stored = await sql<any[]>`
      SELECT id FROM news_quality_reports
      WHERE metadata->>'pin_id' = '987654321'`;
    expect(stored.length).toBeGreaterThan(0);
  });

  test("an unknown article id still records the report", async () => {
    // The id is neither a pins row nor a news_articles row. The report
    // is kept as a NULL-article signal instead of being lost.
    const res = await post(123456789, { report_type: "duplicate" });
    expect(res.status).toBe(201);
    expect((await res.json()).ok).toBe(true);
  });
});
