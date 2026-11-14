import { Hono } from "hono";
import { getDb } from "../db";

export const cityValueRoute = new Hono();

// ── GET /api/city-value/top ─────────────────────────────────────────────
// Returns top cities by value score
cityValueRoute.get("/top", async (c) => {
  const sql = getDb();
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);

  const rows = await sql<Array<{
    city_id: number;
    name: string;
    country_code: string;
    value_score: number;
    value_rank: number;
    tier: string;
    articles_7d: number;
    unique_sources: number;
    is_surging: boolean;
    freshness_score: number;
    views_24h: number;
    user_trend_score: number;
  }>>`
    SELECT
      cc.city_id::float AS city_id,
      cc.country_code,
      cc.value_score::float AS value_score,
      cc.value_rank::float AS value_rank,
      cc.tier,
      cc.articles_7d::float AS articles_7d,
      cc.unique_sources::float AS unique_sources,
      cc.is_surging,
      cc.freshness_score::float AS freshness_score,
      cc.views_24h::float AS views_24h,
      cc.user_trend_score::float AS user_trend_score,
      wc.name
    FROM city_value cc
    LEFT JOIN world_cities wc ON wc.id = cc.city_id
    WHERE cc.value_rank IS NOT NULL
    ORDER BY cc.value_rank ASC
    LIMIT ${limit}
  `;

  return c.json({ items: rows, count: rows.length });
});

// ── GET /api/city-value/city/:id ────────────────────────────────────────
// Returns value data for a specific city
cityValueRoute.get("/city/:id", async (c) => {
  const sql = getDb();
  const cityId = parseInt(c.req.param("id"));

  const rows = await sql<Array<{
    city_id: number;
    name: string;
    country_code: string;
    region: string;
    value_score: number;
    value_rank: number;
    tier: string;
    articles_1d: number;
    articles_7d: number;
    articles_30d: number;
    unique_sources: number;
    unique_countries: number;
    freshness_score: number;
    week_change_pct: number;
    is_surging: boolean;
    volume_score: number;
    diversity_score: number;
    trend_score: number;
    editorial_score: number;
    population: number;
    is_capital: boolean;
    computed_at: string;
    primary_mention_ratio: number;
    avg_confidence: number;
    high_confidence_ratio: number;
    user_trend_score: number;
    discovery_priority: number;
    views_24h: number;
    views_7d: number;
  }>>`
    SELECT
      cc.city_id::float AS city_id,
      cc.value_score::float AS value_score,
      cc.value_rank::float AS value_rank,
      cc.tier,
      cc.articles_1d::float AS articles_1d,
      cc.articles_7d::float AS articles_7d,
      cc.articles_30d::float AS articles_30d,
      cc.unique_sources::float AS unique_sources,
      cc.unique_countries::float AS unique_countries,
      cc.freshness_score::float AS freshness_score,
      cc.week_change_pct::float AS week_change_pct,
      cc.is_surging,
      cc.volume_score::float AS volume_score,
      cc.diversity_score::float AS diversity_score,
      cc.trend_score::float AS trend_score,
      cc.editorial_score::float AS editorial_score,
      cc.population::float AS population,
      cc.is_capital,
      cc.region,
      cc.country_code,
      cc.computed_at,
      cc.primary_mention_ratio::float AS primary_mention_ratio,
      cc.avg_confidence::float AS avg_confidence,
      cc.high_confidence_ratio::float AS high_confidence_ratio,
      cc.user_trend_score::float AS user_trend_score,
      cc.discovery_priority::float AS discovery_priority,
      cc.views_24h::float AS views_24h,
      cc.views_7d::float AS views_7d,
      wc.name
    FROM city_value cc
    LEFT JOIN world_cities wc ON wc.id = cc.city_id
    WHERE cc.city_id = ${cityId}
  `;

  if (rows.length === 0) {
    return c.json({ error: "City not found" }, 404);
  }

  return c.json(rows[0]);
});

// ── GET /api/city-value/surging ────────────────────────────────────────
// Returns cities that are currently surging in coverage
cityValueRoute.get("/surging", async (c) => {
  const sql = getDb();
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);

  const rows = await sql<Array<{
    city_id: number;
    name: string;
    country_code: string;
    value_score: number;
    value_rank: number;
    week_change_pct: number;
    articles_7d: number;
  }>>`
    SELECT
      cc.city_id::float AS city_id,
      cc.country_code,
      cc.value_score::float AS value_score,
      cc.value_rank::float AS value_rank,
      cc.week_change_pct::float AS week_change_pct,
      cc.articles_7d::float AS articles_7d,
      wc.name
    FROM city_value cc
    LEFT JOIN world_cities wc ON wc.id = cc.city_id
    WHERE cc.is_surging = true
    ORDER BY cc.week_change_pct DESC
    LIMIT ${limit}
  `;

  return c.json({ items: rows, count: rows.length });
});

// ── GET /api/city-value/by-region ──────────────────────────────────────
// Returns top cities grouped by region
cityValueRoute.get("/by-region", async (c) => {
  const sql = getDb();
  const limitPerRegion = Math.min(parseInt(c.req.query("limit") || "5"), 20);

  const rows = await sql<Array<{
    region: string;
    city_id: number;
    name: string;
    country_code: string;
    value_score: number;
    value_rank: number;
    tier: string;
  }>>`
    WITH ranked AS (
      SELECT
        cc.region,
        cc.city_id::float AS city_id,
        cc.country_code,
        cc.value_score::float AS value_score,
        cc.value_rank::float AS value_rank,
        cc.tier,
        wc.name,
        ROW_NUMBER() OVER (PARTITION BY cc.region ORDER BY cc.value_rank ASC) AS rn
      FROM city_value cc
      LEFT JOIN world_cities wc ON wc.id = cc.city_id
      WHERE cc.region IS NOT NULL AND cc.value_rank IS NOT NULL
    )
    SELECT region, city_id, name, country_code, value_score, value_rank, tier
    FROM ranked
    WHERE rn <= ${limitPerRegion}
    ORDER BY region, value_rank
  `;

  // Group by region
  const byRegion: Record<string, typeof rows> = {};
  for (const row of rows) {
    if (!byRegion[row.region]) {
      byRegion[row.region] = [];
    }
    byRegion[row.region].push(row);
  }

  return c.json({ by_region: byRegion, count: rows.length });
});

// ── GET /api/city-value/stats ──────────────────────────────────────────────
// Returns city value system statistics
cityValueRoute.get("/stats", async (c) => {
  const sql = getDb();

  const [tierStats, globalStats, surgingStats] = await Promise.all([
    sql<Array<{ tier: string; count: number; avg_score: number }>>`
      SELECT tier, COUNT(*)::float AS count, AVG(value_score)::float AS avg_score
      FROM city_value
      GROUP BY tier
    `,
    sql<Array<{ total_cities: number; avg_score: number; max_score: number }>>`
      SELECT
        COUNT(*)::float AS total_cities,
        AVG(value_score)::float AS avg_score,
        MAX(value_score)::float AS max_score
      FROM city_value
      WHERE value_score > 0
    `,
    sql<Array<{ surging_count: number }>>`
      SELECT COUNT(*)::float AS surging_count FROM city_value WHERE is_surging = true
    `,
  ]);

  return c.json({
    tiers: tierStats,
    global: globalStats[0],
    surging_count: Math.round(surgingStats[0]?.surging_count ?? 0),
  });
});
