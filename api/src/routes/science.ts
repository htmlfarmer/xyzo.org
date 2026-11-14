import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { RateLimiter, getClientIp } from "../ratelimit";
import { getDb } from "../db";

export const scienceRoute = new Hono();

const scienceLimiter = new RateLimiter({ max: 60, windowMs: 60 * 1000 });

const ScienceQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
  tier: z.coerce.number().min(0).max(4).optional(),
  focus: z.string().max(50).optional(),
  robots_status: z.enum(["pending", "allowed", "blocked", "temp_blocked", "all"]).optional()
    .transform(v => v === "all" ? undefined : v),
});

scienceRoute.get("/science-sources", zValidator("query", ScienceQuerySchema), async (c) => {
  const ip = getClientIp(c.req.raw);
  const rl = scienceLimiter.check(ip);
  if (!rl.allowed) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const q = c.req.valid("query");
  const sql = getDb();

  const tierFilter = q.tier !== undefined ? sql`AND s.science_tier = ${q.tier}` : sql``;
  const focusFilter = q.focus ? sql`AND s.focus = ${q.focus}` : sql``;
  const robotsFilter = q.robots_status ? sql`AND s.robots_status = ${q.robots_status}` : sql``;

  const [rows, countResult] = await Promise.all([
    sql`
      SELECT
        s.id, s.name, s.domain, s.url, s.focus, s.subfocus,
        s.science_tier, s.country, s.language, s.source_type,
        s.robots_status, s.robots_http_status, s.robots_sitemaps,
        s.robots_crawl_delay_s, s.seed_source, s.discovered_at,
        s.has_rss, s.has_atom, s.has_sitemap, s.article_depth_score,
        s.duplicate_rate, s.active
      FROM news_science_sources s
      WHERE s.active = TRUE
        ${tierFilter}
        ${focusFilter}
        ${robotsFilter}
      ORDER BY s.science_tier ASC, s.name ASC
      LIMIT ${q.limit} OFFSET ${q.offset}
    `,
    sql`
      SELECT COUNT(*)::int AS count
      FROM news_science_sources s
      WHERE s.active = TRUE
        ${tierFilter}
        ${focusFilter}
        ${robotsFilter}
    `,
  ]);

  const stats = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE s.robots_status = 'allowed')::int AS allowed,
      COUNT(*) FILTER (WHERE s.robots_status = 'blocked')::int AS blocked,
      COUNT(*) FILTER (WHERE s.robots_status = 'pending')::int AS pending,
      COUNT(DISTINCT s.focus)::int AS focus_count,
      COUNT(DISTINCT s.country)::int AS country_count
    FROM news_science_sources s
    WHERE s.active = TRUE
  `;

  const byTier: any[] = await sql`
    SELECT
      s.science_tier,
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE s.robots_status = 'allowed')::int AS allowed,
      COUNT(*) FILTER (WHERE s.robots_status = 'blocked')::int AS blocked
    FROM news_science_sources s
    WHERE s.active = TRUE
    GROUP BY s.science_tier
    ORDER BY s.science_tier ASC
  `;

  const byFocus: any[] = await sql`
    SELECT
      s.focus,
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE s.robots_status = 'allowed')::int AS allowed,
      AVG(s.science_tier)::float AS avg_tier
    FROM news_science_sources s
    WHERE s.active = TRUE
    GROUP BY s.focus
    ORDER BY count DESC
    LIMIT 20
  `;

  return c.json({
    items: rows.map(r => ({
      id: Number(r.id),
      name: r.name,
      domain: r.domain,
      url: r.url,
      focus: r.focus,
      subfocus: r.subfocus || [],
      science_tier: Number(r.science_tier),
      country: r.country,
      language: r.language,
      source_type: r.source_type,
      robots_status: r.robots_status,
      robots_http_status: r.robots_http_status != null ? Number(r.robots_http_status) : null,
      robots_sitemaps: r.robots_sitemaps || [],
      robots_crawl_delay_s: r.robots_crawl_delay_s != null ? Number(r.robots_crawl_delay_s) : null,
      has_rss: r.has_rss || false,
      has_atom: r.has_atom || false,
      has_sitemap: r.has_sitemap || false,
      article_depth_score: r.article_depth_score != null ? Number(r.article_depth_score) : null,
      duplicate_rate: r.duplicate_rate != null ? Number(r.duplicate_rate) : null,
    })),
    count: Number(countResult[0]?.count ?? 0),
    stats: {
      total: Number(stats[0]?.total ?? 0),
      allowed: Number(stats[0]?.allowed ?? 0),
      blocked: Number(stats[0]?.blocked ?? 0),
      pending: Number(stats[0]?.pending ?? 0),
      focus_count: Number(stats[0]?.focus_count ?? 0),
      country_count: Number(stats[0]?.country_count ?? 0),
    },
    by_tier: byTier.map(r => ({
      tier: Number(r.science_tier),
      count: Number(r.count),
      allowed: Number(r.allowed),
      blocked: Number(r.blocked),
    })),
    by_focus: byFocus.map(r => ({
      focus: r.focus,
      count: Number(r.count),
      allowed: Number(r.allowed),
      avg_tier: Math.round(Number(r.avg_tier) * 100) / 100,
    })),
  });
});

scienceRoute.get("/science-sources/tier-summary", async (c) => {
  const sql = getDb();
  const rows: any[] = await sql`
    SELECT
      s.science_tier,
      CASE s.science_tier
        WHEN 0 THEN 'Institution'
        WHEN 1 THEN 'Expert Journalism'
        WHEN 2 THEN 'Explainers'
        WHEN 3 THEN 'Secondary'
        ELSE 'Community'
      END AS tier_label,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE s.robots_status = 'allowed')::int AS allowed,
      COUNT(*) FILTER (WHERE s.robots_status = 'blocked')::int AS blocked,
      COUNT(*) FILTER (WHERE s.robots_status = 'pending')::int AS pending,
      COUNT(DISTINCT s.focus)::int AS focus_count
    FROM news_science_sources s
    WHERE s.active = TRUE
    GROUP BY s.science_tier
    ORDER BY s.science_tier ASC
  `;
  return c.json({ items: rows.map(r => ({
    tier: Number(r.science_tier),
    tier_label: r.tier_label,
    total: Number(r.total),
    allowed: Number(r.allowed),
    blocked: Number(r.blocked),
    pending: Number(r.pending),
    focus_count: Number(r.focus_count),
  })) });
});
