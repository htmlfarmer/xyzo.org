import { Hono } from "hono";
import { getDb } from "../db.js";

export const sitemapRoute = new Hono();

// Dynamic sitemap.xml — auto-updates with current content
// Updates: homepage, help, explore, about, and trending tag pages
sitemapRoute.get("/sitemap.xml", async (c) => {
  const sql = getDb();
  const now = new Date().toISOString().split("T")[0];

  // Get trending tags for tag pages
  let tagUrls = "";
  try {
    const tags = await sql<any[]>`
      SELECT tag, count(*) as cnt
      FROM news_article_tags
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY tag
      ORDER BY cnt DESC
      LIMIT 20
    `;
    tagUrls = tags.map((t) => `
  <url>
    <loc>https://xyzo.org/?tag=${encodeURIComponent(t.tag)}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.6</priority>
  </url>`).join("");
  } catch (_) {}

  // Get top cities for city pages
  let cityUrls = "";
  try {
    const cities = await sql<any[]>`
      SELECT place_name, count(*) as cnt
      FROM news_locations nl
      JOIN news_articles na ON na.location_id = nl.id
      WHERE na.created_at >= NOW() - INTERVAL '7 days'
        AND nl.place_name IS NOT NULL
      GROUP BY place_name
      ORDER BY cnt DESC
      LIMIT 30
    `;
    cityUrls = cities.map((city) => `
  <url>
    <loc>https://xyzo.org/?q=${encodeURIComponent(city.place_name)}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.5</priority>
  </url>`).join("");
  } catch (_) {}

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://xyzo.org/</loc>
    <lastmod>${now}</lastmod>
    <changefreq>always</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://xyzo.org/about.html</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://xyzo.org/help/</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>${tagUrls}${cityUrls}
</urlset>`;

  c.header("Content-Type", "application/xml; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  return c.body(xml);
});
