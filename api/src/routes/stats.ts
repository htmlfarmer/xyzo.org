import { Hono } from "hono";
import { getDb } from "../db";

export const statsRoute = new Hono();

let _cache: {
  sources: number;
  countries: number;
  stories_today: number;
  timestamp: number;
} | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function safeNum(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  return 0;
}

statsRoute.get("/stats", async (c) => {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) {
    return c.json(_cache);
  }

  const sql = getDb();

  const [sourceRow] = await sql<Array<{ total: number }>>`
    SELECT COUNT(*)::float AS total FROM news_sources WHERE deleted_at IS NULL
  `;

  const [geoRow] = await sql<Array<{ n: number }>>`
    SELECT COUNT(DISTINCT country_code)::float AS n FROM world_cities WHERE country_code IS NOT NULL
  `;

  const [storyRow] = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::float AS n FROM news_articles WHERE published_at >= CURRENT_DATE
  `;

  _cache = {
    sources: Math.round(safeNum(sourceRow?.total)),
    countries: Math.round(safeNum(geoRow?.n)),
    stories_today: Math.round(safeNum(storyRow?.n)),
    timestamp: now,
  };
  _cacheAt = now;

  return c.json(_cache);
});
