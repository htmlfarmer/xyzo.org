// Tests for the user-interactivity endpoints (2026-09-28):
//   POST /api/news/submit          — queued user submissions (SSRF-guarded)
//   POST /api/news/:id/recommend   — one vote per IP + integer counter
//   GET  /api/news/:id/recommend   — counter read
//
// Hermetic: mounts newsRoute on a bare Hono app against the xyzo_test DB.
// Submit tests use IP-literal URLs with public addresses so assertSafeUrl
// never needs DNS. Cleanup deletes only rows this file created.

import { describe, expect, test, afterAll } from "bun:test";
import { Hono } from "hono";
import { newsRoute } from "../src/routes/news";
import { getDb } from "../src/db";

const app = new Hono();
app.route("/api", newsRoute);

const TEST_URL_PREFIX = "http://93.184.216.34/xyzo-news-route-test/";
const seededArticleIds: number[] = [];

async function seedArticle(title: string): Promise<number> {
  const sql = getDb();
  const rows = await sql<any[]>`
    INSERT INTO news_articles (title, url, status)
    VALUES (${title}, ${`https://example.test/rec/${Math.random()}`}, 'extracted')
    RETURNING id
  `;
  const id = Number(rows[0].id);
  seededArticleIds.push(id);
  return id;
}

function post(path: string, body: unknown, ip: string) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

afterAll(async () => {
  const sql = getDb();
  await sql`DELETE FROM user_news_submissions WHERE url LIKE ${TEST_URL_PREFIX + "%"}`;
  if (seededArticleIds.length > 0) {
    await sql`DELETE FROM news_article_recommendations WHERE article_id = ANY(${seededArticleIds})`;
    await sql`DELETE FROM news_articles WHERE id = ANY(${seededArticleIds})`;
  }
});

describe("POST /api/news/submit", () => {
  test("queues a valid public URL as pending", async () => {
    const url = TEST_URL_PREFIX + "queued";
    const res = await post("/api/news/submit", { url, title: "T", note: "N" }, "203.0.113.10");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.status).toBe("pending");
    expect(data.duplicate).toBe(false);
    expect(typeof data.id).toBe("number");

    const sql = getDb();
    const [row] = await sql<any[]>`
      SELECT status FROM user_news_submissions WHERE id = ${data.id}
    `;
    expect(row.status).toBe("pending");
  });

  test("dedupes an identical pending URL", async () => {
    const url = TEST_URL_PREFIX + "dupe";
    const r1 = await post("/api/news/submit", { url }, "203.0.113.11");
    const r2 = await post("/api/news/submit", { url }, "203.0.113.12");
    const d1 = await r1.json();
    const d2 = await r2.json();
    expect(d1.duplicate).toBe(false);
    expect(d2.duplicate).toBe(true);
    expect(d2.id).toBe(d1.id);
  });

  test("blocks private/loopback targets (SSRF)", async () => {
    const res = await post("/api/news/submit", { url: "http://127.0.0.1:5432/admin" }, "203.0.113.13");
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("blocked_url");
  });

  test("blocks non-http schemes", async () => {
    const res = await post("/api/news/submit", { url: "file:///etc/passwd" }, "203.0.113.14");
    expect(res.status).toBe(400);
  });

  test("rejects malformed payloads via Zod", async () => {
    const res = await post("/api/news/submit", { url: "x" }, "203.0.113.15");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/news/:id/recommend", () => {
  test("counts one vote per IP and returns a Number count", async () => {
    const id = await seedArticle("recommend target");
    const r1 = await post(`/api/news/${id}/recommend`, {}, "198.51.100.20");
    expect(r1.status).toBe(200);
    const d1 = await r1.json();
    expect(d1.ok).toBe(true);
    expect(d1.counted).toBe(true);
    expect(typeof d1.recommend_count).toBe("number"); // BigInt regression guard
    expect(d1.recommend_count).toBe(1);

    // Same IP again → deduped, counter unchanged.
    const r2 = await post(`/api/news/${id}/recommend`, {}, "198.51.100.20");
    const d2 = await r2.json();
    expect(d2.duplicate).toBe(true);
    expect(d2.recommend_count).toBe(1);

    // Different IP → increments.
    const r3 = await post(`/api/news/${id}/recommend`, {}, "198.51.100.21");
    const d3 = await r3.json();
    expect(d3.counted).toBe(true);
    expect(d3.recommend_count).toBe(2);
  });

  test("GET returns the serialized counter", async () => {
    const id = await seedArticle("recommend read target");
    await post(`/api/news/${id}/recommend`, {}, "198.51.100.30");
    const res = await app.request(`/api/news/${id}/recommend`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.recommend_count).toBe(1);
    expect(typeof data.recommend_count).toBe("number");
  });

  test("404 for unknown article", async () => {
    const res = await post("/api/news/999999999/recommend", {}, "198.51.100.40");
    expect(res.status).toBe(404);
  });

  test("400 for non-integer id", async () => {
    const res = await post("/api/news/abc/recommend", {}, "198.51.100.41");
    expect(res.status).toBe(400);
  });
});
