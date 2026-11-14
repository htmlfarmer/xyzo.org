import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDb } from "../db";
import { RateLimiter, getClientIp } from "../ratelimit";
import { enqueueOrSpawn } from "../queue/enqueueOrSpawn";
import { adminAuth } from "../auth";

export const linksRoute = new Hono();

const linkLimiter = new RateLimiter({ max: 50, windowMs: 60 * 60 * 1000 });

// ── GET /api/links/stats ────────────────────────────────────────────
// Get link statistics. MUST be before /links/:articleId to avoid conflict.
linksRoute.get("/links/stats", async (c) => {
  const sql = getDb();

  const byType = await sql<any[]>`
    SELECT link_type, COUNT(*) as count, AVG(link_strength) as avg_strength
    FROM news_story_links
    GROUP BY link_type
    ORDER BY count DESC
  `;

  const total = await sql<any[]>`SELECT COUNT(*) as total FROM news_story_links`;

  const topCities = await sql<any[]>`
    SELECT city_name, COUNT(*) as count
    FROM news_story_links
    WHERE city_name IS NOT NULL
    GROUP BY city_name
    ORDER BY count DESC
    LIMIT 20
  `;

  return c.json({
    total_links: Number(total[0]?.total || 0),
    by_type: byType.map((r) => ({
      type: r.link_type,
      count: Number(r.count),
      avg_strength: Math.round(Number(r.avg_strength) * 100) / 100,
    })),
    top_cities: topCities.map((r) => ({
      city: r.city_name,
      count: Number(r.count),
    })),
  });
});

// ── POST /api/links/detect ──────────────────────────────────────────
// Run link detection for recent articles.
linksRoute.post("/links/detect", async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = linkLimiter.check(ip);
  if (!rl.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
  }

  // Quick wins: use crypto.randomUUID instead of Math.random for collision-free IDs.
  const jobId = `lnk_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  // Fire through the unified queue entry point with waitMs: 0 (fire-
  // and-forget). The pre-migration route spawned an inline `python3 -c
  // "<code>"` that called `detect_links_batch(500)` and returned
  // immediately — it never polled for completion and never read the
  // worker result off stdout. The queue path preserves that fire-and-
  // forget shape: the worker runs in the background and we report the
  // queue's UUID under `job_id` so the operator can poll
  // `/api/discovery-status/<id>` for progress.
  const result = await enqueueOrSpawn<unknown>(
    "links_generate",
    { limit: 500 },
    { waitMs: 0, enqueuedBy: "api/links/detect" },
  );
  const responseJobId =
    result.kind === "async" ? result.requestId : jobId;
  return c.json({
    ok: true,
    job_id: responseJobId,
    message: "Link detection started",
  });
});

// ── POST /api/links ─────────────────────────────────────────────────
// Add a manual link between two articles.
const AddLinkSchema = z.object({
  source_article_id: z.number().int().positive(),
  target_article_id: z.number().int().positive(),
  reason: z.string().max(500).optional().default(""),
});

linksRoute.post("/links", zValidator("json", AddLinkSchema), async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = linkLimiter.check(ip);
  if (!rl.allowed) {
    return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
  }

  const { source_article_id, target_article_id, reason } = c.req.valid("json");
  if (source_article_id === target_article_id) {
    return c.json({ error: "cannot_link_to_self" }, 400);
  }

  const sql = getDb();
  const rows = await sql<any[]>`
    INSERT INTO news_story_links (
      source_article_id, target_article_id, link_type,
      link_strength, link_reason, created_by
    ) VALUES (${source_article_id}, ${target_article_id}, 'manual', 1.0, ${reason}, 'user')
    ON CONFLICT (source_article_id, target_article_id, link_type) DO UPDATE
      SET link_reason = ${reason}, updated_at = now()
    RETURNING id
  `;

  return c.json({ ok: true, link_id: Number(rows[0].id) });
});

// ── DELETE /api/links/:linkId ───────────────────────────────────────
// Delete a link.
linksRoute.delete("/links/:linkId", async (c) => {
  // Tier 1.6: gate — deletes any story link by id. Story links glue
  // articles together (geo + keyword + embedding). Unauthenticated
  // callers could break the story graph.
  const gate = await adminAuth(c, ["super"]);
  if (!gate.ok) return gate.response;

  const linkId = Number(c.req.param("linkId"));
  if (!Number.isInteger(linkId) || linkId < 1) {
    return c.json({ error: "bad_id" }, 400);
  }

  const sql = getDb();
  await sql`DELETE FROM news_story_links WHERE id = ${linkId}`;

  return c.json({ ok: true });
});

// ── GET /api/links/city/:cityName ───────────────────────────────────
// Get all articles linked to a city.
linksRoute.get("/links/city/:cityName", async (c) => {
  const cityName = c.req.param("cityName");
  const limit = Math.min(Number(c.req.query("limit") || 50), 200);

  const sql = getDb();
  const rows = await sql<any[]>`
    SELECT DISTINCT a.id, a.title, a.extracted_lat, a.extracted_lng,
           a.auto_categorize_city_label, a.event_type,
           s.name as source_name, s.country as source_country
    FROM news_story_links l
    JOIN news_articles a ON a.id = CASE 
      WHEN l.source_article_id IN (SELECT source_article_id FROM news_story_links WHERE city_name = ${cityName}) 
      THEN l.target_article_id ELSE l.source_article_id END
    JOIN news_sources s ON s.id = a.source_id
    WHERE l.city_name = ${cityName}
      -- Tier 1.4: filter retired sources (see note in /links/article/:id).
      AND s.deleted_at IS NULL
    ORDER BY a.fetched_at DESC
    LIMIT ${limit}
  `;

  return c.json({
    city: cityName,
    count: rows.length,
    articles: rows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      location: r.extracted_lat != null ? {
        lat: Number(r.extracted_lat),
        lng: Number(r.extracted_lng),
        city: r.auto_categorize_city_label,
      } : null,
      event_type: r.event_type,
      source_name: r.source_name,
      source_country: r.source_country,
    })),
  });
});

// ── POST /api/links/feedback ────────────────────────────────────────
// User feedback on a link (thumbs up/down, "remove this link", etc.).
// Backed by news_link_feedback table (added in commit 2c1d5fa — T-13).
// Callers: app.js:2458 (reportLink via the link-panel thumbs buttons).
const LinkFeedbackSchema = z.object({
  event_a: z.number().int().positive(),
  event_b: z.number().int().positive().optional(),
  kind: z.enum(["add", "remove"]),
  reason: z.string().max(500).optional(),
});

// Dedup to one feedback per (event_a, event_b, kind) — the table allows
// multiple rows but most user feedback is "clicked once" and we don't
// want to spam the operator queue.
linksRoute.post(
  "/links/feedback",
  zValidator("json", LinkFeedbackSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = linkLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }
    const { event_a, event_b, kind, reason } = c.req.valid("json");
    const link_type = event_b != null ? "story" : "location";
    // getClientIp returns the literal "unknown" when no proxy headers are
    // set; that won't cast to inet, so bind NULL in that case.
    const ipOrNull = ip === "unknown" ? null : ip;

    const sql = getDb();
    const rows = await sql<{ id: string }[]>`
      INSERT INTO news_link_feedback (event_a, event_b, kind, link_type, reason, requester_ip)
      VALUES (${event_a}, ${event_b ?? null}, ${kind}, ${link_type}, ${reason ?? null}, (${ipOrNull})::inet)
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (rows.length === 0) {
      // Already on file — treat as success so the UI doesn't nag.
      return c.json({ ok: true, duplicate: true });
    }
    return c.json({ ok: true, id: Number(rows[0].id) });
  },
);

// ── POST /api/links/manual ──────────────────────────────────────────
// Create a manual link between two events (story↔story) or an event and
// a map location (story↔location). Resolves event IDs to article IDs via
// news_event_sources; the user picks the "anchor" article for each event
// (oldest by created_at) so the link table stays stable when the cluster
// picks up new sources.
//
// Callers:
//   app.js:2518 handleAddLinkLocationClick — event + map click
//   app.js:2544 handleMarkerClickForLink   — event + event
const ManualLinkSchema = z.object({
  event_a: z.number().int().positive(),
  event_b: z.number().int().positive().optional(),
  location_id: z.number().int().positive().optional(),
  reason: z.string().max(500).optional(),
});

linksRoute.post(
  "/links/manual",
  zValidator("json", ManualLinkSchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = linkLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited", retry_after_ms: rl.retryAfterMs }, 429);
    }
    const { event_a, event_b, location_id, reason } = c.req.valid("json");

    const sql = getDb();

    // Anchor article = oldest source in the event cluster. Defensive: if
    // the event has no articles yet (race condition during clustering),
    // surface a clear error so the UI can re-prompt the user.
    const anchorFor = async (eventId: number): Promise<number | null> => {
      const r = await sql<{ article_id: string }[]>`
        SELECT article_id FROM news_event_sources
        WHERE event_id = ${eventId}
        ORDER BY created_at ASC
        LIMIT 1
      `;
      return r[0] ? Number(r[0].article_id) : null;
    };
    const sourceArticleId = await anchorFor(event_a);
    if (!sourceArticleId) {
      return c.json({ error: "event_a_has_no_articles", event_id: event_a }, 422);
    }

    if (event_b != null) {
      const targetArticleId = await anchorFor(event_b);
      if (!targetArticleId) {
        return c.json({ error: "event_b_has_no_articles", event_id: event_b }, 422);
      }
      if (sourceArticleId === targetArticleId) {
        return c.json({ error: "cannot_link_to_self" }, 400);
      }
      const rows = await sql<{ id: string }[]>`
        INSERT INTO news_story_links (
          source_article_id, target_article_id, link_type,
          link_strength, link_reason, created_by
        ) VALUES (
          ${sourceArticleId}, ${targetArticleId}, 'manual',
          1.0, ${reason ?? null}, 'user'
        )
        ON CONFLICT (source_article_id, target_article_id, link_type)
        DO UPDATE SET link_reason = EXCLUDED.link_reason, updated_at = now()
        RETURNING id
      `;
      return c.json({ ok: true, link_id: Number(rows[0].id) });
    }

    if (location_id != null) {
      // Story ↔ location: there's no event_b, so the "target article" is
      // any article whose location_id matches. Pick the most recent one
      // so the link stays close to the user's mental model.
      const targetRows = await sql<{ article_id: string }[]>`
        SELECT id AS article_id FROM news_articles
        WHERE location_id = ${location_id}
          AND status NOT IN ('hidden', 'broken')
        ORDER BY published_at DESC NULLS LAST
        LIMIT 1
      `;
      const targetArticleId = targetRows[0] ? Number(targetRows[0].article_id) : null;
      if (!targetArticleId) {
        return c.json({ error: "location_has_no_articles", location_id }, 422);
      }
      if (sourceArticleId === targetArticleId) {
        return c.json({ error: "cannot_link_to_self" }, 400);
      }
      const rows = await sql<{ id: string }[]>`
        INSERT INTO news_story_links (
          source_article_id, target_article_id, link_type,
          link_strength, link_reason, city_name, country_code, created_by
        ) VALUES (
          ${sourceArticleId}, ${targetArticleId}, 'manual',
          1.0, ${reason ?? null},
          (SELECT place_name FROM news_locations WHERE id = ${location_id}),
          (SELECT country FROM news_locations WHERE id = ${location_id}),
          'user'
        )
        ON CONFLICT (source_article_id, target_article_id, link_type)
        DO UPDATE SET link_reason = EXCLUDED.link_reason, updated_at = now()
        RETURNING id
      `;
      return c.json({ ok: true, link_id: Number(rows[0].id) });
    }

    return c.json({ error: "need_event_b_or_location_id" }, 400);
  },
);

// ── GET /api/links/:articleId ───────────────────────────────────────
// Get all links for an article. MUST be last (catches all /links/* paths).
linksRoute.get("/links/:articleId", async (c) => {
  const articleId = Number(c.req.param("articleId"));
  if (!Number.isInteger(articleId) || articleId < 1) {
    return c.json({ error: "bad_id" }, 400);
  }

  const sql = getDb();
  const rows = await sql<any[]>`
    SELECT l.id, l.link_type, l.link_strength, l.link_reason,
           l.city_name, l.country_code, l.entity_name, l.topic,
           l.created_by, l.created_at,
           CASE WHEN l.source_article_id = ${articleId} THEN l.target_article_id ELSE l.source_article_id END as target_id,
           a.title as target_title,
           a.extracted_lat, a.extracted_lng, a.auto_categorize_city_label,
           s.name as source_name, s.country as source_country
    FROM news_story_links l
    JOIN news_articles a ON a.id = CASE WHEN l.source_article_id = ${articleId} THEN l.target_article_id ELSE l.source_article_id END
    JOIN news_sources s ON s.id = a.source_id
    WHERE (l.source_article_id = ${articleId} OR l.target_article_id = ${articleId})
      -- Tier 1.4: filter retired sources so the public /api/links/article/:id
      -- response doesn't leak a soft-deleted source's byline into the
      -- related-stories drawer.
      AND s.deleted_at IS NULL
    ORDER BY l.link_strength DESC
  `;

  return c.json({
    article_id: articleId,
    count: rows.length,
    links: rows.map((r) => ({
      link_id: Number(r.id),
      target_id: Number(r.target_id),
      target_title: r.target_title,
      link_type: r.link_type,
      link_strength: Number(r.link_strength),
      link_reason: r.link_reason,
      city_name: r.city_name,
      country_code: r.country_code,
      entity_name: r.entity_name,
      topic: r.topic,
      created_by: r.created_by,
      created_at: r.created_at,
      target_location: r.extracted_lat != null ? {
        lat: Number(r.extracted_lat),
        lng: Number(r.extracted_lng),
        city: r.auto_categorize_city_label,
      } : null,
      source_name: r.source_name,
      source_country: r.source_country,
    })),
  });
});
