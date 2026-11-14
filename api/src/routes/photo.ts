import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { RateLimiter, getClientIp } from "../ratelimit";
import { getDb } from "../db";

export const photoRoute = new Hono();

const photoLimiter = new RateLimiter({ max: 60, windowMs: 60 * 1000 });

const PhotoQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
  category: z.string().max(50).optional(),
  source_type: z.string().max(50).optional(),
  country: z.string().max(10).optional(),
  robots_status: z
    .enum(["pending", "allowed", "blocked", "partial", "error", "all"])
    .optional()
    .transform((v) => (v === "all" ? undefined : v)),
});

// ── GET /api/photo-sources ──────────────────────────────────────────────
photoRoute.get(
  "/photo-sources",
  zValidator("query", PhotoQuerySchema),
  async (c) => {
    const ip = getClientIp(c.req.raw);
    const rl = photoLimiter.check(ip);
    if (!rl.allowed) {
      return c.json({ error: "rate_limited" }, 429);
    }

    const q = c.req.valid("query");
    const sql = getDb();

    try {
      const catFilter = q.category ? sql`AND s.category = ${q.category}` : sql``;
      const typeFilter = q.source_type ? sql`AND s.source_type = ${q.source_type}` : sql``;
      const countryFilter = q.country ? sql`AND s.country = ${q.country}` : sql``;
      const robotsFilter = q.robots_status
        ? sql`AND s.robots_status = ${q.robots_status}`
        : sql``;

      const [rows, countResult] = await Promise.all([
        sql`
          SELECT
            s.id, s.name, s.domain, s.url, s.source_type, s.category,
            s.country, s.language, s.region,
            s.robots_status, s.robots_http_status, s.robots_sitemaps,
            s.robots_crawl_delay_s,
            s.has_rss, s.has_atom, s.has_sitemap, s.has_json_feed, s.rss_url,
            s.has_photo_page, s.has_embed_policy, s.image_license_known,
            s.visual_score, s.uniqueness_score, s.locality_score,
            s.active, s.seed_source, s.added_at, s.last_check_at
          FROM photo_sources s
          WHERE s.active = TRUE
            ${catFilter}
            ${typeFilter}
            ${countryFilter}
            ${robotsFilter}
          ORDER BY s.category ASC, s.name ASC
          LIMIT ${q.limit} OFFSET ${q.offset}
        `,
        sql`
          SELECT COUNT(*)::int AS count
          FROM photo_sources s
          WHERE s.active = TRUE
            ${catFilter}
            ${typeFilter}
            ${countryFilter}
            ${robotsFilter}
        `,
      ]);

      return c.json({
        items: rows.map((r) => ({
          id: Number(r.id),
          name: r.name,
          domain: r.domain,
          url: r.url,
          source_type: r.source_type,
          category: r.category,
          country: r.country,
          language: r.language,
          region: r.region,
          robots_status: r.robots_status,
          robots_http_status:
            r.robots_http_status != null ? Number(r.robots_http_status) : null,
          robots_sitemaps: r.robots_sitemaps || [],
          robots_crawl_delay_s:
            r.robots_crawl_delay_s != null
              ? Number(r.robots_crawl_delay_s)
              : null,
          has_rss: r.has_rss || false,
          has_atom: r.has_atom || false,
          has_sitemap: r.has_sitemap || false,
          has_json_feed: r.has_json_feed || false,
          rss_url: r.rss_url || null,
          has_photo_page: r.has_photo_page || false,
          has_embed_policy: r.has_embed_policy,
          image_license_known: r.image_license_known || false,
          visual_score:
            r.visual_score != null ? Number(r.visual_score) : null,
          uniqueness_score:
            r.uniqueness_score != null ? Number(r.uniqueness_score) : null,
          locality_score:
            r.locality_score != null ? Number(r.locality_score) : null,
          seed_source: r.seed_source,
          added_at: r.added_at,
          last_check_at: r.last_check_at,
        })),
        count: Number(countResult[0]?.count ?? 0),
      });
    } catch (err) {
      console.error("[photo] list error:", err);
      return c.json({ error: "database_error" }, 500);
    }
  }
);

// ── GET /api/photo-sources/stats ────────────────────────────────────────
photoRoute.get("/photo-sources/stats", async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = photoLimiter.check(ip);
  if (!rl.allowed) {
    return c.json({ error: "rate_limited" }, 429);
  }

  try {
    const sql = getDb();

    const stats = await sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE robots_status = 'allowed')::int AS allowed,
        COUNT(*) FILTER (WHERE robots_status = 'blocked')::int AS blocked,
        COUNT(*) FILTER (WHERE robots_status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE has_rss = TRUE)::int AS with_rss,
        COUNT(*) FILTER (WHERE has_sitemap = TRUE)::int AS with_sitemap,
        COUNT(DISTINCT category)::int AS category_count,
        COUNT(DISTINCT country)::int AS country_count,
        COUNT(DISTINCT source_type)::int AS type_count
      FROM photo_sources
      WHERE active = TRUE
    `;

    const byCategory = await sql`
      SELECT
        category,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE robots_status = 'allowed')::int AS allowed,
        COUNT(*) FILTER (WHERE robots_status = 'blocked')::int AS blocked,
        COUNT(*) FILTER (WHERE has_rss = TRUE)::int AS with_rss
      FROM photo_sources
      WHERE active = TRUE
      GROUP BY category
      ORDER BY count DESC
    `;

    const byType = await sql`
      SELECT
        source_type,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE robots_status = 'allowed')::int AS allowed
      FROM photo_sources
      WHERE active = TRUE
      GROUP BY source_type
      ORDER BY count DESC
    `;

    return c.json({
      stats: {
        total: Number(stats[0]?.total ?? 0),
        allowed: Number(stats[0]?.allowed ?? 0),
        blocked: Number(stats[0]?.blocked ?? 0),
        pending: Number(stats[0]?.pending ?? 0),
        with_rss: Number(stats[0]?.with_rss ?? 0),
        with_sitemap: Number(stats[0]?.with_sitemap ?? 0),
        category_count: Number(stats[0]?.category_count ?? 0),
        country_count: Number(stats[0]?.country_count ?? 0),
        type_count: Number(stats[0]?.type_count ?? 0),
      },
      by_category: byCategory.map((r) => ({
        category: r.category,
        count: Number(r.count),
        allowed: Number(r.allowed),
        blocked: Number(r.blocked),
        with_rss: Number(r.with_rss),
      })),
      by_type: byType.map((r) => ({
        source_type: r.source_type,
        count: Number(r.count),
        allowed: Number(r.allowed),
      })),
    });
  } catch (err) {
    console.error("[photo] stats error:", err);
    return c.json({ error: "database_error" }, 500);
  }
});

// ── GET /api/photo-sources/:id ──────────────────────────────────────────
photoRoute.get("/photo-sources/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "invalid_id" }, 400);

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT * FROM photo_sources WHERE id = ${id}
    `;
    if (!rows.length) return c.json({ error: "not_found" }, 404);

    const r = rows[0];
    return c.json({
      id: Number(r.id),
      name: r.name,
      domain: r.domain,
      url: r.url,
      source_type: r.source_type,
      category: r.category,
      country: r.country,
      language: r.language,
      region: r.region,
      robots_status: r.robots_status,
      robots_checked_at: r.robots_checked_at,
      robots_http_status: r.robots_http_status,
      robots_sitemaps: r.robots_sitemaps || [],
      robots_crawl_delay_s: r.robots_crawl_delay_s,
      has_rss: r.has_rss,
      has_atom: r.has_atom,
      has_sitemap: r.has_sitemap,
      has_json_feed: r.has_json_feed,
      rss_url: r.rss_url,
      has_photo_page: r.has_photo_page,
      has_embed_policy: r.has_embed_policy,
      image_license_known: r.image_license_known,
      visual_score: r.visual_score,
      uniqueness_score: r.uniqueness_score,
      locality_score: r.locality_score,
      active: r.active,
      seed_source: r.seed_source,
      discovered_at: r.discovered_at,
      added_at: r.added_at,
      last_check_at: r.last_check_at,
      last_error: r.last_error,
    });
  } catch (err) {
    console.error("[photo] detail error:", err);
    return c.json({ error: "database_error" }, 500);
  }
});
