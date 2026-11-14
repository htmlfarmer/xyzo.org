import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";
import { parseAdminKey, verifyAdminKey, requireRole } from "../auth";
import { enqueueOrSpawn } from "../queue/enqueueOrSpawn";
import { RateLimiter, getClientIp } from "../ratelimit";

const applyLimiter = new RateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });

// Auto-categorization routes — bridges the fast-path worker
// (worker/auto_categorize.py) and the client-side mirror
// (public_html/city-engine.js). Three jobs:
//   * Surface articles the fast path couldn't resolve so the AI can
//     study them later (`/api/articles/needs-ai`).
//   * Apply client-detected categorizations to a specific article
//     without a full server re-extraction
//     (`/api/articles/:id/apply-categorization`).
//   * Trigger the fast-path worker on demand
//     (`/api/admin/auto-categorize/run`).
export const autoCategorizeRoute = new Hono();

// ── GET /api/articles/needs-ai ───────────────────────────────────────
//
// Returns articles where the fast path either didn't find a city
// (no_match) or only had a low-confidence city hit. These are the
// rows that justify the AI extraction cost. Default ordering is
// fetched_at DESC so the freshest article backlog is at the top.
const NeedsAiQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(["no_match", "low", "all"]).default("all"),
});

autoCategorizeRoute.get(
  "/articles/needs-ai",
  zValidator("query", NeedsAiQuery),
  async (c) => {
    const { limit, status } = c.req.valid("query");
    const sql = getDb();
    const statusFilter =
      status === "all"
        ? sql`auto_categorize_status IN ('no_match', 'low')`
        : sql`auto_categorize_status = ${status}`;
    const rows = await sql<any[]>`
      SELECT a.id, a.title, a.url, a.source_id, a.fetched_at,
             a.auto_categorize_status, a.auto_categorize_confidence,
             a.auto_categorize_city_label, a.auto_categorize_event_type,
             s.name AS source_name, s.country AS source_country
      FROM news_articles a
      LEFT JOIN news_sources s ON s.id = a.source_id
      WHERE a.status = 'pending'
        AND ${statusFilter}
        -- Tier 1.4: filter retired sources so they don't leak into public listings.
        AND s.deleted_at IS NULL
      ORDER BY a.fetched_at DESC
      LIMIT ${limit}
    `;
    return c.json({
      count: rows.length,
      limit,
      status,
      articles: rows.map((r) => ({
        id: Number(r.id),
        title: r.title,
        url: r.url,
        source_id: Number(r.source_id),
        source_name: r.source_name,
        source_country: r.source_country,
        fetched_at: r.fetched_at,
        auto_categorize_status: r.auto_categorize_status,
        auto_categorize_confidence: r.auto_categorize_confidence,
        auto_categorize_city_label: r.auto_categorize_city_label,
        auto_categorize_event_type: r.auto_categorize_event_type,
      })),
    });
  },
);

// ── GET /api/articles/:id/categorization-status ──────────────────────
//
// Returns the current categorization state for one article. Used by
// the detail panel to decide whether to render the "Apply suggestion"
// buttons or show the existing categorization.
autoCategorizeRoute.get("/articles/:id/categorization-status", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ error: "bad_id" }, 400);
  }
  const sql = getDb();
  const rows = await sql<any[]>`
    SELECT id, status, location_text, extracted_lat, extracted_lng,
           event_type, summary,
           auto_categorized_at, auto_categorize_status, auto_categorize_confidence,
           auto_categorize_city_id, auto_categorize_city_label,
           auto_categorize_event_type, auto_categorize_method
    FROM news_articles WHERE id = ${id} LIMIT 1
  `;
  if (rows.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }
  const r = rows[0];
  return c.json({
    id: Number(r.id),
    status: r.status,
    location_text: r.location_text,
    lat: r.extracted_lat == null ? null : Number(r.extracted_lat),
    lng: r.extracted_lng == null ? null : Number(r.extracted_lng),
    event_type: r.event_type,
    summary: r.summary,
    auto_categorize: {
      at: r.auto_categorized_at,
      status: r.auto_categorize_status,
      confidence: r.auto_categorize_confidence,
      city_id: r.auto_categorize_city_id == null ? null : Number(r.auto_categorize_city_id),
      city_label: r.auto_categorize_city_label,
      event_type: r.auto_categorize_event_type,
      method: r.auto_categorize_method,
    },
  });
});

// ── POST /api/articles/:id/apply-categorization ─────────────────────
//
// Apply a client-detected suggestion (or a user override) to an article.
// Marks auto_categorize_method='client_apply' so audit logs can tell
// the difference between a fast-path decision and a human-applied one.
const ApplySchema = z.object({
  city_label: z.string().min(2).max(120).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  country_code: z.string().min(2).max(2).optional(),
  event_type: z.string().min(2).max(40).optional(),
  summary: z.string().max(500).optional(),
}).refine(
  (d) => d.city_label || d.event_type || d.summary,
  { message: "Provide at least one of city_label, event_type, or summary" },
);

autoCategorizeRoute.post(
  "/articles/:id/apply-categorization",
  zValidator("json", ApplySchema),
  async (c) => {
    // FIX_NOTES 2.3: unauthenticated content mutation — anyone could
    // rewrite any article's coordinates/category (map poisoning). Until
    // the ownership model lands (correction must reference a stored
    // suggestion), at minimum throttle per IP so scripted poisoning is
    // economically pointless.
    const ip = getClientIp(c.req.raw);
    const rl = applyLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) {
      return c.json({ error: "bad_id" }, 400);
    }
    const body = c.req.valid("json");
    const sql = getDb();

    // Build a minimal UPDATE that only touches the columns supplied.
    // Postgres SET clause has to be hand-built because we want to allow
    // partial updates (e.g. only the category without changing the city).
    const sets: string[] = [];
    const args: any[] = [];
    if (body.city_label) {
      sets.push("location_text = $" + (args.length + 1));
      args.push(body.city_label);
      sets.push("extracted_location = $" + (args.length + 1));
      args.push(body.city_label);
    }
    if (typeof body.lat === "number") {
      sets.push("extracted_lat = $" + (args.length + 1));
      args.push(body.lat);
    }
    if (typeof body.lng === "number") {
      sets.push("extracted_lng = $" + (args.length + 1));
      args.push(body.lng);
    }
    if (body.event_type) {
      sets.push("event_type = $" + (args.length + 1));
      args.push(body.event_type);
    }
    if (body.summary) {
      sets.push("summary = $" + (args.length + 1));
      args.push(body.summary);
    }
    sets.push("auto_categorized_at = now()");
    sets.push("auto_categorize_method = 'client_apply'");
    if (body.city_label && typeof body.lat === "number" && typeof body.lng === "number") {
      sets.push("auto_categorize_status = 'medium'");
      sets.push("auto_categorize_confidence = 'high'");
      sets.push("auto_categorize_city_label = $" + (args.length + 1));
      args.push(body.city_label);
    } else {
      sets.push("auto_categorize_status = 'low'");
    }
    if (body.event_type) {
      sets.push("auto_categorize_event_type = $" + (args.length + 1));
      args.push(body.event_type);
    }
    // If we have a city with coords, the article is now ready for the
    // map without any more work — flip to status='extracted' so
    // geocode.py picks it up on its next pass.
    if (body.city_label && typeof body.lat === "number" && typeof body.lng === "number") {
      sets.push("status = 'extracted'");
      sets.push("extracted_at = now()");
    }
    args.push(id);
    const result = await getDb().unsafe(
      `UPDATE news_articles SET ${sets.join(", ")} WHERE id = $${args.length}`,
      args,
    );
    if ((result as any).affectedRows === 0) {
      return c.json({ error: "not_found" }, 404);
    }

    // Feed human / client correction into NN learning loop
    if (body.event_type) {
      try {
        await sql.unsafe(`
          INSERT INTO nn_user_corrections (
            model_name, article_id, entity_type, entity_id,
            correction_type, metadata, created_at, used_in_training
          ) VALUES (
            'category_classifier', $1, 'article', $1,
            'category', $2::jsonb, now(), false
          )
        `, id, JSON.stringify({ new_category: body.event_type }));
      } catch (err: any) {
        console.warn("[apply-categorization] note: user correction audit log skipped:", err?.message || err);
      }
    }

    return c.json({ ok: true, id, applied: Object.keys(body) });
  },
);

// ── GET /api/categorization/stats ───────────────────────────────────
//
// Summary metrics for the category classification system & learning loop.
autoCategorizeRoute.get("/categorization/stats", async (c) => {
  const sql = getDb();
  try {
    const [totals, methods, topCategories, pendingCorrections] = await Promise.all([
      sql<any[]>`
        SELECT 
          COUNT(*)::int AS total_articles,
          COUNT(CASE WHEN location_id IS NOT NULL THEN 1 END)::int AS located_articles,
          COUNT(CASE WHEN location_id IS NOT NULL AND event_type IS NOT NULL AND event_type NOT IN ('news', 'other', 'none', '') THEN 1 END)::int AS located_classified,
          COUNT(CASE WHEN location_id IS NOT NULL AND (event_type IS NULL OR event_type IN ('news', 'other', 'none', '')) THEN 1 END)::int AS located_unclassified
        FROM news_articles
      `,
      sql<any[]>`
        SELECT COALESCE(auto_categorize_method, 'unspecified') AS method, COUNT(*)::int AS count
        FROM news_articles
        WHERE location_id IS NOT NULL
        GROUP BY auto_categorize_method
        ORDER BY count DESC
      `,
      sql<any[]>`
        SELECT event_type AS category, COUNT(*)::int AS count
        FROM news_articles
        WHERE location_id IS NOT NULL AND event_type IS NOT NULL AND event_type NOT IN ('news', 'other', 'none', '')
        GROUP BY event_type
        ORDER BY count DESC
        LIMIT 15
      `,
      sql<any[]>`
        SELECT COUNT(*)::int AS count
        FROM nn_user_corrections
        WHERE correction_type = 'category' AND (used_in_training = FALSE OR used_in_training IS NULL)
      `,
    ]);

    return c.json({
      ok: true,
      summary: totals[0] || {},
      methods,
      top_categories: topCategories,
      pending_feedback_for_retraining: pendingCorrections[0]?.count ?? 0,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return c.json({ error: "db_error", message: err?.message || String(err) }, 500);
  }
});

// ── POST /api/admin/auto-categorize/run ─────────────────────────────
//
// Operator trigger for the fast-path worker. Admin-only.
autoCategorizeRoute.post("/admin/auto-categorize/run", async (c) => {
  const header = c.req.header("X-Admin-Key");
  const parsed = parseAdminKey(header ?? null);
  if (!parsed) return c.json({ error: "admin_required" }, 401);
  const auth = await verifyAdminKey(parsed);
  if (!requireRole(auth, ["super"])) {
    return c.json({ error: "admin_required" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const limit = Math.min(Number(body.limit ?? 2000), 10_000);
  try {
    // Fire through the unified queue entry point. Sync-waits up to 5s
    // for the worker to finish so the admin dashboard keeps seeing the
    // existing {ok, limit, summary} response shape. If the worker takes
    // longer, the route surfaces a 202 with the requestId + statusUrl
    // so the frontend can poll /api/discovery-status/:id — same
    // envelope as the explore-region cutover.
    const result = await enqueueOrSpawn<Record<string, unknown>>(
      "auto_categorize",
      { limit },
      { waitMs: 5000, enqueuedBy: "api/auto-categorize/run" },
    );
    if (result.kind === "async") {
      // Worker didn't finish within the 5s budget. Hand the requestId
      // back to the operator UI so it can poll /api/discovery-status/:id.
      return c.json(result, 202);
    }
    return c.json({ ok: true, limit, summary: result.result });
  } catch (e: any) {
    // Legacy spawn errored (non-zero exit, parse failure) OR the queue
    // job failed / timed out. Surface a 500 with a short message so the
    // operator UI can render an error toast without crashing the session.
    console.error("[auto-categorize] worker failed:", e?.message ?? e);
    return c.json({
      error: "worker_failed",
      message: typeof e?.message === "string" ? e.message.slice(-500) : "unknown",
    }, 500);
  }
});
