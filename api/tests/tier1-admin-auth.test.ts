import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { analyticsRoute } from "../src/routes/analytics";
import { sourcesRoute } from "../src/routes/sources";
import { performanceRoute } from "../src/routes/performance";
import { exploreRoute } from "../src/routes/explore";
import { aiFlagRoute } from "../src/routes/ai-flag";
import { locationViewsRoute } from "../src/routes/location-views";
import { linksRoute } from "../src/routes/links";
import { communityRoute } from "../src/routes/community";

// Tier 1.1 of the consolidated audit fix-order. These tests verify:
//   1. The new admin gates reject requests without X-Admin-Key.
//   2. The new /api/performance/public-* aliases return 200 without
//      auth (closes Audit 3: help page was hitting /performance/summary
//      without a key, getting 401 → "Failed to load performance data").
//
// We intentionally do NOT seed any admin key here — these tests verify
// the negative path (401) and the public path (200). The positive path
// for admin-gated routes is covered by the existing admin.test.ts /
// debug-auth.test.ts suites.

describe("Tier 1.1: admin-auth gates on analytics + sources", () => {
  test("GET /api/analytics/rankings/sources is gated", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const res = await app.request("/api/analytics/rankings/sources");
    expect(res.status).toBe(401);
  });

  test("GET /api/analytics/quality-stats is gated", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const res = await app.request("/api/analytics/quality-stats");
    expect(res.status).toBe(401);
  });

  test("GET /api/analytics/visitors/recent is gated", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const res = await app.request("/api/analytics/visitors/recent");
    expect(res.status).toBe(401);
  });

  test("GET /api/analytics/visitors/countries is gated", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const res = await app.request("/api/analytics/visitors/countries");
    expect(res.status).toBe(401);
  });

  test("GET /api/analytics/visitors/cities is gated", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const res = await app.request("/api/analytics/visitors/cities");
    expect(res.status).toBe(401);
  });

  test("GET /api/analytics/client-errors is gated", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const res = await app.request("/api/analytics/client-errors");
    expect(res.status).toBe(401);
  });

  test("POST /api/analytics/report-quality is gated", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    // Send a valid schema body so zValidator passes — then the gate
    // will be reached. Order of middleware: zValidator (schema) →
    // adminAuth (auth). With no X-Admin-Key, the gate returns 401.
    const res = await app.request("/api/analytics/report-quality", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        article_id: 1,
        session_id: "test-session",
        report_type: "spam",
      }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /api/sources/discover is gated", async () => {
    const app = new Hono();
    app.route("/api", sourcesRoute);
    const res = await app.request("/api/sources/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "news" }),
    });
    expect(res.status).toBe(401);
  });

  test("GET /api/sources/discover/metrics is gated", async () => {
    const app = new Hono();
    app.route("/api", sourcesRoute);
    const res = await app.request("/api/sources/discover/metrics");
    expect(res.status).toBe(401);
  });
});

describe("Tier 1.1: /api/performance/public-* aliases", () => {
  test("GET /api/performance/public-summary returns 200 without auth", async () => {
    const app = new Hono();
    app.route("/api", performanceRoute);
    const res = await app.request("/api/performance/public-summary");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Shape: { totals: {...}, by_operation: [...], by_endpoint: [...] }.
    // Verify the PII-stripped fields are present and the stripped ones
    // are absent (no session_id, ip, etc.).
    expect(body).toHaveProperty("totals");
    expect(body).toHaveProperty("by_operation");
    expect(body).toHaveProperty("by_endpoint");
    expect(body).not.toHaveProperty("session_id");
    expect(body).not.toHaveProperty("ip");
  });

  test("GET /api/performance/public-slow returns 200 without auth", async () => {
    const app = new Hono();
    app.route("/api", performanceRoute);
    const res = await app.request("/api/performance/public-slow");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("operations");
    expect(Array.isArray(body.operations)).toBe(true);
  });

  test("GET /api/performance/public-summary honors ?hours= param", async () => {
    const app = new Hono();
    app.route("/api", performanceRoute);
    const res = await app.request("/api/performance/public-summary?hours=1");
    expect(res.status).toBe(200);
  });
});

describe("Tier 1.1: /api/performance/* gated routes still require auth", () => {
  test("GET /api/performance/summary rejects without X-Admin-Key", async () => {
    const app = new Hono();
    app.route("/api", performanceRoute);
    const res = await app.request("/api/performance/summary");
    expect(res.status).toBe(401);
  });

  test("GET /api/performance/slow rejects without X-Admin-Key", async () => {
    const app = new Hono();
    app.route("/api", performanceRoute);
    const res = await app.request("/api/performance/slow");
    expect(res.status).toBe(401);
  });
});

// ── Tier 1.1 review: shape assertions for /api/performance/public-slow ──
//
// These pin down Finding #1 (stripPii was rebuilding Date objects as `{}`,
// causing `new Date({}).getTime()` = NaN on the help page renderer) and
// Finding #3 (loose PII regex was over-stripping legitimate keys).
describe("Tier 1.1 review: /api/performance/public-slow shape", () => {
  test("public-slow preserves created_at as a parseable Date (Finding #1)", async () => {
    const app = new Hono();
    app.route("/api", performanceRoute);
    const res = await app.request("/api/performance/public-slow");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.operations)).toBe(true);
    if (body.operations.length > 0) {
      const first = body.operations[0];
      // postgres.js may serialize timestamps as ISO strings or as Date
      // objects depending on column type; either is fine, but it MUST
      // NOT be the empty `{}` that the old stripPii produced.
      expect(typeof first.created_at === "string" || first.created_at instanceof Date).toBe(true);
      if (typeof first.created_at === "string") {
        expect(Number.isNaN(Date.parse(first.created_at))).toBe(false);
      } else if (first.created_at instanceof Date) {
        expect(Number.isNaN(first.created_at.getTime())).toBe(false);
      }
    }
  });

  test("public-slow preserves operation/endpoint/duration_ms", async () => {
    const app = new Hono();
    app.route("/api", performanceRoute);
    const res = await app.request("/api/performance/public-slow");
    expect(res.status).toBe(200);
    const body = await res.json();
    if (body.operations.length > 0) {
      const first = body.operations[0];
      expect(typeof first.operation).toBe("string");
      expect(typeof first.duration_ms).toBe("number");
    }
  });

  test("public-slow does NOT leak PII keys (Finding #3)", async () => {
    const app = new Hono();
    app.route("/api", performanceRoute);
    const res = await app.request("/api/performance/public-slow");
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const op of body.operations) {
      // These must never appear on the public alias.
      expect(op.session_id).toBeUndefined();
      expect(op.ip_address).toBeUndefined();
      expect(op.email).toBeUndefined();
      expect(op.password).toBeUndefined();
      expect(op.token).toBeUndefined();
      expect(op.user_id).toBeUndefined();
      expect(op.secret).toBeUndefined();
    }
  });
});

// ── Tier 1.1 review: rate limiter kicks in on the public alias ────────
//
// Flooding the public alias with 70 requests should trip the 60-req/min
// limiter (Finding #2). We accept either 429 or 503 because some reverse
// proxies may translate 429 → 503 on the way out, but the canonical
// response in the API itself is 429.
describe("Tier 1.1 review: public-summary rate limit (Finding #2)", () => {
  test("public-summary rate limits after 60/min threshold", async () => {
    const app = new Hono();
    app.route("/api", performanceRoute);
    const results = await Promise.all(
      Array.from({ length: 70 }, () =>
        app.request("/api/performance/public-summary?hours=1")
      ),
    );
    const statuses = results.map((r) => r.status);
    // At least one request in the flood must hit the limiter.
    expect(statuses.some((s) => s === 429 || s === 503)).toBe(true);
  }, { timeout: 30_000 });
});

// ── Tier 1.1 review: adminAuth role enforcement (Finding #4) ──────────
//
// Verifies the adminAuth helper rejects editorial-only keys when a
// super-only endpoint is hit. Skipped by default because it requires
// a seeded editorial-only key via:
//   bun src/seed-admin-key.ts --name test-editorial --role editorial
// and the XYZO_TEST_EDITORIAL_KEY env var to be set. CI should set
// that var via the secrets manager.
describe("Tier 1.1 review: adminAuth role escalation (Finding #4)", () => {
  test.skip("403 when editorial key hits /api/analytics/visitors/recent (super-only)", async () => {
    const key = process.env.XYZO_TEST_EDITORIAL_KEY;
    if (!key) {
      console.warn(
        "XYZO_TEST_EDITORIAL_KEY not set — skipping role-escalation test. " +
          "Seed with: bun src/seed-admin-key.ts --name test-editorial --role editorial"
      );
      return;
    }
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const res = await app.request("/api/analytics/visitors/recent", {
      headers: { "X-Admin-Key": key },
    });
    expect(res.status).toBe(403);
  });
});

// ── Tier 1.6: admin-auth gates on the audit's CRITICAL findings ────────
//
// Tier 1.1 gated a handful of /api/analytics + /api/sources endpoints.
// Tier 1.6 closes the remaining CRITICAL holes the full-site audit
// surfaced — every test here verifies the negative path (401 without an
// X-Admin-Key) for one newly-gated endpoint.

describe("Tier 1.6: admin-auth gates (RCE + 13 admin endpoints)", () => {
  test("POST /api/add-source returns 401 without admin key (CRITICAL RCE fix)", async () => {
    const app = new Hono();
    app.route("/api", exploreRoute);
    const res = await app.request("/api/add-source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Even with a payload that *would* have been the shell-injection
      // vector, no admin key → 401. The payload never reaches the
      // Python interpreter.
      body: JSON.stringify({
        name: "x'; import os; os.system(\"id\"); x='",
        feed_url: "http://x.example/rss",
      }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /api/analytics/calculate returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const res = await app.request("/api/analytics/calculate", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("POST /api/analytics/hide-article returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const res = await app.request("/api/analytics/hide-article", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ article_id: 1, reason: "test" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /api/analytics/unhide-article returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const res = await app.request("/api/analytics/unhide-article", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ article_id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /api/location-views/calculate returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", locationViewsRoute);
    const res = await app.request("/api/location-views/calculate", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("GET /api/ai/quick-flag returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", aiFlagRoute);
    const res = await app.request("/api/ai/quick-flag");
    expect(res.status).toBe(401);
  });

  test("GET /api/analytics/reported-articles returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const res = await app.request("/api/analytics/reported-articles");
    expect(res.status).toBe(401);
  });

  test("GET /api/analytics/interactions returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const res = await app.request("/api/analytics/interactions");
    expect(res.status).toBe(401);
  });

  test("GET /api/analytics/problems returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", analyticsRoute);
    const res = await app.request("/api/analytics/problems");
    expect(res.status).toBe(401);
  });

  test("GET /api/recommend-news/recent returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", exploreRoute);
    const res = await app.request("/api/recommend-news/recent");
    expect(res.status).toBe(401);
  });

  test("POST /api/discovery-cancel/:id returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", exploreRoute);
    // Use any id — the gate fires before any business logic, so the
    // request can't even reach the discovery_jobs lookup.
    const res = await app.request("/api/discovery-cancel/abc", { method: "POST" });
    expect(res.status).toBe(401);
  });

  // ── Tier 1.6: additional mutating public endpoints ────────────────

  test("POST /api/sources/:id/toggle returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", sourcesRoute);
    const res = await app.request("/api/sources/1/toggle", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("POST /api/sources/:id/reset-errors returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", sourcesRoute);
    const res = await app.request("/api/sources/1/reset-errors", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("DELETE /api/links/:linkId returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", linksRoute);
    const res = await app.request("/api/links/1", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  test("GET /api/density/analyze returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", sourcesRoute);
    const res = await app.request("/api/density/analyze");
    expect(res.status).toBe(401);
  });

  test("POST /api/density/auto-correct returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", sourcesRoute);
    const res = await app.request("/api/density/auto-correct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  test("POST /api/density/relocate returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", sourcesRoute);
    const res = await app.request("/api/density/relocate", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("GET /api/system/logs returns 401 without admin key", async () => {
    const app = new Hono();
    app.route("/api", communityRoute);
    const res = await app.request("/api/system/logs");
    expect(res.status).toBe(401);
  });
});