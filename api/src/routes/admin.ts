import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";
import { adminAuth } from "../auth";
import { EditorialPinSchema, RssIngestSchema, PatchPinSchema } from "../validate";
import { normalizeUrl } from "../normalize";
import { aiBreaker } from "../ai-breaker";

export const adminRoute = new Hono();

adminRoute.post("/pins", zValidator("json", EditorialPinSchema), async (c) => {
  const gate = await adminAuth(c, ["editorial"]);
  if (!gate.ok) return gate.response;

  const data = c.req.valid("json");
  const sql = getDb();
  const [pinRow] = await sql<{ id: number | bigint }[]>`
    INSERT INTO pins (
      source_type, title, location, category, published_at,
      location_precision, confidence_score
    )
    VALUES (
      'editorial', ${data.title},
      ST_SetSRID(ST_MakePoint(${data.lng}, ${data.lat}), 4326)::geography,
      ${data.category ?? "other"},
      ${data.published_at ? new Date(data.published_at) : sql`now()`},
      ${data.location_precision ?? "exact"},
      ${data.confidence_score ?? 1.0}
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO editorial_details (pin_id, body_markdown, image_url, author_name, canonical_url)
    VALUES (
      ${Number(pinRow.id)}, ${data.body_markdown}, ${data.image_url ?? null},
      ${data.author_name}, ${data.canonical_url ?? null}
    )
  `;
  return c.json({ id: Number(pinRow.id), status: "published" }, 201);
});

adminRoute.post("/rss", zValidator("json", RssIngestSchema), async (c) => {
  const gate = await adminAuth(c, ["rss_ingest"]);
  if (!gate.ok) return gate.response;

  const data = c.req.valid("json");
  const sql = getDb();
  const normalized = normalizeUrl(data.source_url);

  const existing = await sql<any[]>`
    SELECT p.id FROM pins p
    JOIN rss_details r ON r.pin_id = p.id
    WHERE r.source_url = ${normalized}
    LIMIT 1
  `;
  if (existing.length > 0) {
    return c.json({ id: Number(existing[0].id), dedup: true }, 200);
  }

  const [pinRow] = await sql<{ id: number | bigint }[]>`
    INSERT INTO pins (
      source_type, title, location, category, published_at,
      location_precision, confidence_score
    )
    VALUES (
      'rss', ${data.title},
      ST_SetSRID(ST_MakePoint(${data.lng}, ${data.lat}), 4326)::geography,
      ${data.category ?? "other"},
      ${data.original_published_at ? new Date(data.original_published_at) : sql`now()`},
      ${data.location_precision ?? "exact"},
      ${data.confidence_score ?? 1.0}
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO rss_details (pin_id, source_feed, source_url, original_published_at, summary)
    VALUES (
      ${Number(pinRow.id)}, ${data.source_feed}, ${normalized},
      ${data.original_published_at ? new Date(data.original_published_at) : null},
      ${data.summary ?? null}
    )
  `;
  return c.json({ id: Number(pinRow.id), status: "published" }, 201);
});

adminRoute.patch("/pins/:id", zValidator("json", PatchPinSchema), async (c) => {
  const gate = await adminAuth(c, ["editorial", "rss_ingest"]);
  if (!gate.ok) return gate.response;

  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "bad_id" }, 400);
  const data = c.req.valid("json");
  const sql = getDb();

  if (data.lat !== undefined && data.lng !== undefined) {
    await sql`
      UPDATE pins SET
        location = ST_SetSRID(ST_MakePoint(${data.lng}, ${data.lat}), 4326)::geography,
        title = COALESCE(${data.title ?? null}, title),
        category = COALESCE(${data.category ?? null}, category),
        location_precision = COALESCE(${data.location_precision ?? null}, location_precision),
        confidence_score = COALESCE(${data.confidence_score ?? null}, confidence_score),
        status = COALESCE(${data.status ?? null}, status)
      WHERE id = ${id}
    `;
  } else {
    await sql`
      UPDATE pins SET
        title = COALESCE(${data.title ?? null}, title),
        category = COALESCE(${data.category ?? null}, category),
        location_precision = COALESCE(${data.location_precision ?? null}, location_precision),
        confidence_score = COALESCE(${data.confidence_score ?? null}, confidence_score),
        status = COALESCE(${data.status ?? null}, status)
      WHERE id = ${id}
    `;
  }

  const rows = await sql<any[]>`SELECT id FROM pins WHERE id = ${id}`;
  if (rows.length === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ id, status: data.status ?? "unchanged" }, 200);
});

// ── GET /api/admin/nn/labels ────────────────────────────────────────
// Stub for the NN training-label queue admin view. The underlying
// feature (T-43) was descoped from the quality-engine plan, but
// nn.html fetches /api/admin/nn/labels so the panel can render an empty
// list rather than failing silently. Returns the documented empty shape
// so callers can wire UI without a backend dependency.
//
// T-13 closes the silent 404 in nn.html:345 / nn.html:366.
const NNLabelsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

adminRoute.get(
  "/nn/labels",
  zValidator("query", NNLabelsQuerySchema),
  async (c) => {
    const auth = await adminAuth(c);
    if (!auth.ok) return auth.response;
    const { limit } = c.req.valid("query");
    // Read whatever the worker has written to nn_training_labels if the
    // table exists; otherwise return an empty page. The training data
    // lives in nn_training_features (1.3M rows) which has no labels UI
    // today — see T-30.
    let rows: Array<{ label: string; count: string }> = [];
    try {
      const sql = getDb();
      const r = await sql<{ label: string; count: string }[]>`
        SELECT label, COUNT(*)::text AS count
        FROM nn_training_labels
        GROUP BY label
        ORDER BY count DESC
        LIMIT ${limit}
      `;
      rows = r;
    } catch {
      // Table doesn't exist — feature descoped (T-43). Return empty.
    }
    return c.json({
      labels: rows.map((r) => ({ label: r.label, count: Number(r.count) })),
      count: rows.length,
      note: "Feature descoped from quality-engine plan (T-43). UI renders empty list.",
    });
  },
);

// ── POST /api/admin/ai-status/reset ──────────────────────────────────
// Force-close the AI circuit breaker so subsequent calls try the
// endpoint immediately instead of short-circuiting for the cooldown
// window. Operator safety net when the AI host comes back up after an
// outage. Caller: ai-status.html:546.
adminRoute.post("/ai-status/reset", async (c) => {
  const auth = await adminAuth(c);
  if (!auth.ok) return auth.response;

  const before = aiBreaker.snapshot();
  aiBreaker.forceClose();
  const after = aiBreaker.snapshot();
  return c.json({
    ok: true,
    reset_at: new Date().toISOString(),
    before: { open: before.open, recent_failures: before.recent_failures },
    after,
  });
});
