import { Hono } from "hono";
import { getDb } from "../db";
import { escapeHtml } from "../escape";

export const searchResultsRoute = new Hono();

const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  politics: { bg: "rgba(239,68,68,0.15)", text: "#f87171" },
  business: { bg: "rgba(245,158,11,0.15)", text: "#fbbf24" },
  technology: { bg: "rgba(59,130,246,0.15)", text: "#60a5fa" },
  science: { bg: "rgba(168,85,247,0.15)", text: "#c084fc" },
  sports: { bg: "rgba(34,197,94,0.15)", text: "#4ade80" },
  culture: { bg: "rgba(236,72,153,0.15)", text: "#f472b6" },
  climate: { bg: "rgba(16,185,129,0.15)", text: "#34d399" },
  health: { bg: "rgba(244,63,94,0.15)", text: "#fb7185" },
  other: { bg: "rgba(148,163,184,0.15)", text: "#94a3b8" },
};

function categoryStyle(cat: string): string {
  const c = CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.other;
  return `background:${c.bg};color:${c.text};padding:2px 8px;border-radius:3px;margin-right:8px;font-size:11px`;
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// GET /search/results?q=...&limit=20
searchResultsRoute.get("/results", async (c) => {
  const q = (c.req.query("q") || "").trim().slice(0, 500);
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const sql = getDb();

  if (!q) {
    return c.html(renderPage("", [], 0, limit));
  }

  const like = `%${q}%`;
  const t0 = Date.now();

  const rows = await sql<any[]>`
    SELECT a.id, a.title, a.summary, a.published_at, a.url AS canonical_url,
           a.image_url, a.event_type AS category, a.location_confidence,
           l.lat, l.lng, l.place_name, l.country, l.precision AS location_precision,
           COALESCE(ev.source_count, 1) AS source_count,
           a.word_freq
    FROM news_articles a
    LEFT JOIN news_locations l ON l.id = a.location_id
    LEFT JOIN news_event_sources nes ON nes.article_id = a.id
    LEFT JOIN news_events ev ON ev.id = nes.event_id
    WHERE a.status = 'extracted'
      AND a.location_id IS NOT NULL
      AND (a.title ILIKE ${like} ESCAPE '\\'
           OR a.summary ILIKE ${like} ESCAPE '\\')
    ORDER BY a.published_at DESC NULLS LAST, a.id DESC
    LIMIT ${limit}
  `;

  const durationMs = Date.now() - t0;
  console.log(`[search-results] "${q}" (limit ${limit}) → ${rows.length} results in ${durationMs}ms`);

  return c.html(renderPage(q, rows, durationMs, limit));
});

function renderPage(query: string, results: any[], durationMs: number, limit: number) {
  const queryEsc = escapeHtml(query);
  const resultItems = results.length > 0
    ? results.map((r) => {
        const title = escapeHtml(r.title || "");
        const summary = r.summary ? escapeHtml(r.summary.slice(0, 200)) : "";
        const url = escapeHtml(r.canonical_url || "#");
        const cat = r.category || "other";
        const loc = [r.place_name, r.country].filter(Boolean).join(", ") || "Unknown location";
        const time = timeAgo(r.published_at);
        const sources = r.source_count > 1 ? `${r.source_count} sources` : "1 source";
        const img = r.image_url ? `<img src="${escapeHtml(r.image_url)}" alt="" loading="lazy" style="float:right;width:80px;height:60px;object-fit:cover;border-radius:4px;margin-left:12px">` : "";

        return `<div style="background:#1a1a2e;border:1px solid #1f2937;border-radius:8px;padding:16px;margin-bottom:12px;overflow:hidden">
  ${img}
  <h3 style="margin:0 0 6px"><a href="${url}" style="color:#5eead4;text-decoration:none;font-size:15px">${title}</a></h3>
  <div style="font-size:12px;color:#64748b;margin-bottom:8px">
    <span style="${categoryStyle(cat)}">${escapeHtml(cat)}</span>
    <span style="margin-right:8px">${escapeHtml(loc)}</span>
    ${time ? `<span style="margin-right:8px">${time}</span>` : ""}
    <span>${escapeHtml(sources)}</span>
  </div>
  ${summary ? `<p style="font-size:13px;color:#94a3b8;margin:0;line-height:1.5">${summary}${summary.length >= 200 ? "…" : ""}</p>` : ""}
</div>`;
      }).join("\n")
    : `<div style="background:#1a1a2e;border:1px solid #1f2937;border-radius:8px;padding:32px;text-align:center;color:#64748b">
  <div style="font-size:48px;margin-bottom:12px">🔍</div>
  <div style="font-size:16px;color:#e6edf3;margin-bottom:8px">No results found</div>
  <div style="font-size:13px">Try different keywords, or <a href="/" style="color:#5eead4">browse the map</a>.</div>
</div>`;

  const hasMore = results.length >= limit;
  const durationStr = durationMs > 0 ? ` in ${durationMs}ms` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${queryEsc ? `${queryEsc} — Search XYZO` : "Search XYZO"}</title>
  <meta name="description" content="Search results for ${queryEsc} on XYZO — the world's largest AI-powered news map.">
  <meta name="robots" content="index, follow">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    *{box-sizing:border-box}
    body{background:#0b0f14;color:#e6edf3;font-family:system-ui,-apple-system,sans-serif;margin:0;padding:0;line-height:1.6}
    .container{max-width:800px;margin:0 auto;padding:20px}
    header{padding:24px 0;border-bottom:1px solid #1f2937;margin-bottom:24px}
    h1{color:#5eead4;font-size:28px;margin:0 0 8px}
    .back{margin-right:20px;color:#5eead4;text-decoration:none;font-size:14px}
    .back:hover{text-decoration:underline}
    .search-hero{background:#16213e;border:1px solid #1f2937;border-radius:12px;padding:24px;margin:20px 0}
    .search-form{display:flex;gap:8px;flex-wrap:wrap}
    .search-form input{flex:1;min-width:200px;background:#0b0f14;color:#e6edf3;border:1px solid #1f2937;padding:14px 18px;border-radius:6px;font-size:16px}
    .search-form button{background:#5eead4;color:#0b0f14;border:none;padding:14px 28px;border-radius:6px;font-weight:700;font-size:15px;cursor:pointer}
    .results-info{color:#64748b;font-size:13px;margin-bottom:16px}
    .results-info strong{color:#5eead4}
    .results{margin:20px 0}
    footer{margin-top:48px;padding-top:20px;border-top:1px solid #1f2937;color:#64748b;font-size:13px}
    footer a{color:#5eead4}
  </style>
</head>
<body>
<div class="container">

  <header>
    <nav>
      <a href="/" class="back">← Back to Map</a>
      <a href="/search/" class="back">New Search</a>
      <a href="/help/" class="back">Help</a>
    </nav>
  </header>

  <div class="search-hero">
    <h1>🔍 Search Results${queryEsc ? `: ${queryEsc}` : ""}</h1>
    <form class="search-form" action="/search/results" method="GET">
      <input type="text" name="q" value="${queryEsc}" placeholder="Search the news..." maxlength="500" required>
      <button type="submit">Search</button>
    </form>
  </div>

  ${queryEsc ? `<div class="results-info">
    <strong>${results.length}</strong> result${results.length !== 1 ? "s" : ""} for "${queryEsc}"${durationStr}.
    ${hasMore ? " Showing most recent. Try narrowing your search." : ""}
  </div>` : ""}

  <div class="results">
    ${resultItems}
  </div>

  <footer>
    <a href="/">Interactive Map</a> ·
    <a href="/help/">API Help</a> ·
    <a href="/search/">New Search</a>
  </footer>

</div>
</body>
</html>`;
}
